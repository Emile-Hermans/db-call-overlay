// Rule engine: turns the raw calls of one UI action into grouped, colour-coded
// rows with a concrete "this is how many calls you could remove" number.

export const DEFAULTS = {
  slowMs: 200,
  verySlowMs: 600,
  wideCols: 30,
  loopRoundTrips: 5,
  nPlusOneMin: 3,
  nPlusOneMaxParams: 4,
}

const LEVEL_RANK = { ok: 0, low: 1, med: 2, high: 3 }

function worst(a, b) {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a
}

/**
 * The distinct code paths that produced the executions in one group. Two passes
 * over the same collection share a call site but differ higher up the stack -
 * this is what tells you *which* method to go and fix.
 */
/**
 * Names each path by the first frame where the paths actually diverge - the
 * method a developer has to open. Shared plumbing (a data-access helper both
 * passes go through) is skipped, because naming it would not tell them apart.
 */
function pickOrigins(frameLists) {
  const labels = frameLists.map((frames) => frames.map((f) => f.m))
  const fallback = () => labels.map((l) => l[0] ?? null)

  if (labels.length <= 1) return fallback()

  const deepest = Math.max(...labels.map((l) => l.length))
  for (let i = 0; i < deepest; i++) {
    const distinct = new Set(labels.map((l) => l[i] ?? ''))
    if (distinct.size > 1) {
      return labels.map((l) => l[i] ?? l[l.length - 1] ?? null)
    }
  }
  return fallback()
}

function callPathsOf(units) {
  const paths = new Map()

  for (const u of units) {
    const frames = u.call.stack ?? []
    const key = frames.map((f) => `${f.m}:${f.l ?? ''}`).join(' < ') || '(no application frames)'
    let entry = paths.get(key)
    if (!entry) {
      entry = { count: 0, roundTrips: new Set(), frames }
      paths.set(key, entry)
    }
    entry.count++
    entry.roundTrips.add(u.call.id)
  }

  const list = [...paths.values()]
    .map((p) => ({ ...p, roundTrips: p.roundTrips.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  const origins = pickOrigins(list.map((p) => p.frames))
  return list.map((p, i) => ({ ...p, origin: origins[i] }))
}

function callsiteOf(call) {
  const frame = call.stack?.[0]
  if (!frame) return null
  return {
    method: frame.m,
    file: frame.f ?? null,
    line: frame.l ?? null,
  }
}

function groupKey(unit, call) {
  const site = callsiteOf(call)
  return [unit.op, unit.table ?? '?', unit.shape, site ? `${site.method}:${site.line ?? ''}` : '-'].join(' ~ ')
}

/** Short, DOM-safe, stable handle so the UI can address a group. */
function groupId(key) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return 'g' + h.toString(36)
}

/** Flattens calls into per-statement units, keeping the parent call reachable. */
function toUnits(calls) {
  const units = []
  for (const call of calls) {
    for (const stmt of call.statements ?? []) {
      units.push({ ...stmt, call })
    }
  }
  return units
}

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** Splits a group's executions by the HTTP request they belong to. */
function byRequest(units) {
  const groups = new Map()
  for (const u of units) {
    const key = u.call.reqId ?? '(no request)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(u)
  }
  return [...groups.values()]
}

function analyzeGroup(g, cfg) {
  const findings = []

  // Three separate kinds of problem, deliberately never added together:
  //   inRequest - the same data fetched twice inside one request, and N+1 loops.
  //               Fixable in one method, no design change.
  //   across    - the same query in different requests of one user action. Each
  //               request has its own DbContext, so loading the contract once per
  //               request is normal; removing it means merging endpoints or adding
  //               a cross-request cache.
  //   writes    - rows written more than once.
  let inRequest = 0
  let across = 0
  let writes = 0
  let roundTripSavings = 0

  const requests = byRequest(g.units)
  const paramSigs = g.units.map((u) => u.paramSig)
  const distinctParams = new Set(paramSigs).size
  const rowKeys = g.units.map((u) => u.rowKey)
  const distinctRows = new Set(rowKeys).size
  const reqIds = new Set(g.units.map((u) => u.call.reqId).filter(Boolean))
  const avgParams = g.units.reduce((s, u) => s + u.params.length, 0) / g.count
  const isWrite = g.op === 'UPDATE' || g.op === 'INSERT' || g.op === 'DELETE' || g.op === 'MERGE'
  const paths = callPathsOf(g.units)

  /** e.g. "OrderService.Recalculate (50×) and OrderService.Persist (50×)" */
  const originsText = paths
    .filter((p) => p.origin)
    .map((p) => `${p.origin} (${p.count}×)`)
    .join(' and ')

  if (g.op === 'SELECT') {
    // Repeats inside one request are waste; the remainder is repetition across
    // requests, which is a different (architectural) conversation.
    const withinDupes = requests.reduce(
      (sum, units) => sum + (units.length - new Set(units.map((u) => u.paramSig)).size),
      0,
    )
    const totalDupes = g.count - distinctParams
    const acrossDupes = Math.max(totalDupes - withinDupes, 0)

    if (withinDupes > 0) {
      inRequest += withinDupes
      findings.push({
        code: 'identical-repeat',
        level: 'high',
        bucket: 'inRequest',
        title: `Same query run ${withinDupes + 1}× with identical parameters in one request`,
        detail: `Within a single request this returns data the process already had.`,
        fix: 'Reuse the first result instead of re-querying — filter the list you already loaded in memory.',
        avoidable: withinDupes,
      })
    }

    if (acrossDupes > 0) {
      across += acrossDupes
      findings.push({
        code: 'cross-request',
        level: 'med',
        bucket: 'across',
        title: `Loaded once per request by ${requests.length} requests of this action`,
        detail:
          'Each request has its own DbContext, so this is normal rather than waste. ' +
          'Counted separately because removing it is a design change, not a fix.',
        fix: 'Only worth acting on if these endpoints can be merged, or the data cached across requests.',
        avoidable: acrossDupes,
      })
    }

    // An N+1 is a loop inside one request, so measure it per request.
    const nPlusOne = requests.reduce((sum, units) => {
      const distinct = new Set(units.map((u) => u.paramSig)).size
      const perCall = units.reduce((s, u) => s + u.params.length, 0) / units.length
      const isLoop = distinct >= cfg.nPlusOneMin && perCall > 0 && perCall <= cfg.nPlusOneMaxParams
      return sum + (isLoop ? distinct - 1 : 0)
    }, 0)

    if (nPlusOne > 0) {
      inRequest += nPlusOne
      findings.push({
        code: 'n-plus-one',
        level: 'high',
        bucket: 'inRequest',
        title: `N+1: ${nPlusOne + 1} single-key lookups of ${g.table ?? 'the same table'}`,
        detail: `The same query shape runs once per item. This is a loop doing one round-trip per row.`,
        fix: `Load them in one query — WHERE ${g.table ? g.table + '.' : ''}Id IN (...) — or Include/Select the navigation together with the parent query.`,
        avoidable: nPlusOne,
      })
    }

    if (!g.sample.hasWhere && !g.sample.hasTop) {
      findings.push({
        code: 'unfiltered-read',
        level: 'med',
        bucket: null,
        title: `Unfiltered read of ${g.table ?? 'a table'}`,
        detail: 'No WHERE and no TOP/paging — the whole table is read.',
        fix: 'Add the tenant/parent filter (CRM id, contract id) and page the result.',
        avoidable: 0,
      })
    }

    if (g.sample.width >= cfg.wideCols) {
      findings.push({
        code: 'wide-select',
        level: 'low',
        bucket: null,
        title: `Reads ${g.sample.width} columns`,
        detail: 'The whole entity is materialised even if only a few fields are used.',
        fix: 'Project into a DTO with .Select(...) and fetch only the columns you actually read.',
        avoidable: 0,
      })
    }
  }

  if (isWrite) {
    const dupes = g.count - distinctRows
    if (dupes > 0 && distinctRows > 0) {
      const factor = (g.count / distinctRows).toFixed(1)
      writes += dupes
      findings.push({
        code: 'duplicate-write',
        level: 'high',
        bucket: 'writes',
        title: `Every row of ${g.table ?? 'this table'} is written ${factor}× `.trim(),
        detail:
          `${g.count} ${g.op} statements touch only ${distinctRows} distinct row${distinctRows === 1 ? '' : 's'}. ` +
          (paths.length > 1
            ? `The writes come from ${paths.length} different code paths: ${originsText}.`
            : `${dupes} of them write values that were just written.`),
        fix:
          paths.length > 1
            ? `Two passes save the same rows. Recalculate everything first, then persist once — merge the save in ${paths[1].origin ?? 'the second path'} into the one in ${paths[0].origin ?? 'the first'}.`
            : 'Save each entity once — look for a second save pass over the same collection (recalculate first, then persist once at the end of the flow).',
        avoidable: dupes,
      })
    }

    if (g.roundTrips >= cfg.loopRoundTrips && g.count / g.roundTrips < 2) {
      roundTripSavings = g.roundTrips - 1
      findings.push({
        code: 'write-loop',
        level: 'med',
        bucket: null,
        title: `${g.roundTrips} separate round-trips writing ${g.table ?? 'this table'}`,
        detail: 'Each iteration goes to the database on its own instead of being batched into one command.',
        fix: 'Move SaveChangesAsync outside the loop so EF batches the statements, or replace the loop with a set-based ExecuteUpdateAsync.',
        avoidable: 0,
      })
    }
  }

  if (g.maxMs >= cfg.verySlowMs) {
    findings.push({
      code: 'slow',
      bucket: null,
      level: 'high',
      title: `Slowest execution took ${Math.round(g.maxMs)} ms`,
      detail: `${g.count} execution${g.count === 1 ? '' : 's'}, ${Math.round(g.totalMs)} ms total.`,
      fix: 'Check the filter columns are indexed and that the query is not scanning a large table.',
      avoidable: 0,
    })
  } else if (g.maxMs >= cfg.slowMs) {
    findings.push({
      code: 'slow',
      bucket: null,
      level: 'med',
      title: `Slowest execution took ${Math.round(g.maxMs)} ms`,
      detail: `${g.count} execution${g.count === 1 ? '' : 's'}, ${Math.round(g.totalMs)} ms total.`,
      fix: 'Worth a look if this runs on a hot path.',
      avoidable: 0,
    })
  }

  if (g.errors > 0) {
    findings.push({
      code: 'error',
      bucket: null,
      level: 'high',
      title: `${g.errors} execution${g.errors === 1 ? '' : 's'} failed`,
      detail: g.lastError ?? '',
      fix: '',
      avoidable: 0,
    })
  }

  let level = 'ok'
  for (const f of findings) level = worst(level, f.level)

  return {
    ...g,
    units: undefined,
    sample: undefined,
    width: g.sample.width,
    hasWhere: g.sample.hasWhere,
    callPaths: paths,
    executionsTruncated: Math.max(g.units.length - 200, 0),
    executions: g.units.slice(0, 200).map((u) => ({
      id: u.call.id,
      ts: u.call.ts,
      durationMs: u.call.durationMs,
      rowsRead: u.call.rowsRead,
      rowsAffected: u.call.rowsAffected,
      rowsAffectedDerived: u.call.rowsAffectedDerived ?? false,
      app: u.call.app,
      reqId: u.call.reqId,
      handler: u.call.handler,
      path: u.call.path,
      httpMethod: u.call.httpMethod,
      error: u.call.error,
      params: u.params,
      sql: u.text,
      origin: (u.call.stack ?? []).at(-1)?.m ?? null,
      stack: u.call.stack ?? [],
    })),
    findings,
    level,
    // Never claim more savings than there are executions to remove.
    avoidableInRequest: Math.min(inRequest, Math.max(g.count - 1, 0)),
    avoidableAcrossRequests: Math.min(across, Math.max(g.count - 1, 0)),
    avoidableWrites: Math.min(writes, Math.max(g.count - 1, 0)),
    avoidable: Math.min(inRequest + writes, Math.max(g.count - 1, 0)),
    roundTripSavings,
    distinctParams,
    distinctRows,
    endpoints: [...new Set(g.units.map((u) => u.call.handler || u.call.path).filter(Boolean))],
    requests: reqIds.size,
  }
}

const WRITE_OPS = ['UPDATE', 'INSERT', 'DELETE', 'MERGE']

/**
 * The honest "is every post saved twice?" check. Works on row identity rather
 * than SQL shape, so it still fires when the two passes update different
 * columns and therefore produce two different statements.
 */
function duplicateRowWrites(units, groups) {
  const perTable = new Map()

  for (const u of units) {
    if (!WRITE_OPS.includes(u.op) || !u.table) continue
    if (!u.rowKey || u.rowKey === '(all rows)') continue

    if (!perTable.has(u.table)) perTable.set(u.table, new Map())
    const rows = perTable.get(u.table)
    if (!rows.has(u.rowKey)) rows.set(u.rowKey, [])
    rows.get(u.rowKey).push(u)
  }

  // Duplicates already reported inside a single group must not be counted twice.
  const alreadyReported = new Map()
  for (const g of groups) {
    const finding = g.findings.find((f) => f.code === 'duplicate-write')
    if (finding && g.table) {
      alreadyReported.set(g.table, (alreadyReported.get(g.table) ?? 0) + finding.avoidable)
    }
  }

  const findings = []
  let avoidable = 0

  for (const [table, rows] of perTable) {
    let extra = 0
    let repeated = 0
    const stacks = new Map() // stack signature -> { frames, count }

    for (const writes of rows.values()) {
      if (writes.length < 2) continue
      extra += writes.length - 1
      repeated++
      for (const w of writes) {
        const frames = w.call.stack ?? []
        const key = frames.map((f) => `${f.m}:${f.l ?? ''}`).join(' < ') || (w.call.handler ?? 'unknown')
        const entry = stacks.get(key) ?? { frames, count: 0 }
        entry.count++
        stacks.set(key, entry)
      }
    }

    const entries = [...stacks.values()]
    const labels = pickOrigins(entries.map((e) => e.frames))
    const origins = new Map()
    entries.forEach((e, i) => {
      const name = labels[i] ?? 'unknown'
      origins.set(name, (origins.get(name) ?? 0) + e.count)
    })

    const cross = Math.max(extra - (alreadyReported.get(table) ?? 0), 0)
    if (cross <= 0) continue

    avoidable += cross
    const named = [...origins.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${m} (${n}×)`)
      .join(' and ')

    findings.push({
      code: 'duplicate-row-write',
      level: 'high',
      bucket: 'writes',
      title: `${repeated} ${table} row${repeated === 1 ? ' is' : 's are'} written more than once`,
      detail: `Different statements save the same rows inside one action: ${named}. ${cross} of these writes are redundant.`,
      fix: `Do the whole calculation first and persist each ${table} row once — the second pass can update the in-memory entity instead of issuing its own save.`,
      avoidable: cross,
    })
  }

  return { findings, avoidable }
}

function readAfterWrite(units) {
  const findings = []
  const byTable = new Map()

  for (const u of units) {
    if (!u.table) continue
    if (!byTable.has(u.table)) byTable.set(u.table, [])
    byTable.get(u.table).push(u)
  }

  for (const [table, list] of byTable) {
    list.sort((a, b) => a.call.ts - b.call.ts || a.call.seq - b.call.seq)
    const firstWrite = list.findIndex((u) => u.op !== 'SELECT')
    if (firstWrite < 0) continue

    const readsBefore = new Set(list.slice(0, firstWrite).filter((u) => u.op === 'SELECT').map((u) => u.shape))
    const after = list.slice(firstWrite).filter((u) => u.op === 'SELECT' && readsBefore.has(u.shape))

    if (after.length > 0) {
      findings.push({
        code: 'read-after-write',
        level: 'med',
        bucket: null,
        title: `${table} is read again after it was saved`,
        detail: `${after.length} read${after.length === 1 ? '' : 's'} repeat a query that already ran before the write in this same action.`,
        fix: 'Update the in-memory objects you just saved instead of reloading them, or recalculate from the persisted aggregate columns.',
        avoidable: 0,
      })
    }
  }

  return findings
}

export function analyzeAction(action, cfg = DEFAULTS) {
  const calls = action.calls ?? []
  const units = toUnits(calls)

  const groups = new Map()
  for (const u of units) {
    const key = groupKey(u, u.call)
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        id: groupId(key),
        op: u.op,
        table: u.table,
        shape: u.shape,
        sample: u,
        sampleSql: u.text,
        callsite: callsiteOf(u.call),
        callPath: u.call.stack ?? [],
        apps: new Set(),
        units: [],
        count: 0,
        roundTrips: 0,
        _calls: new Set(),
        totalMs: 0,
        maxMs: 0,
        rowsRead: 0,
        rowsAffected: 0,
        errors: 0,
        lastError: null,
        firstTs: u.call.ts,
      }
      groups.set(key, g)
    }

    g.units.push(u)
    g.count++
    g.apps.add(u.call.app)
    if (!g._calls.has(u.call.id)) {
      g._calls.add(u.call.id)
      g.roundTrips++
      g.totalMs += u.call.durationMs ?? 0
      g.maxMs = Math.max(g.maxMs, u.call.durationMs ?? 0)
      if (u.call.rowsRead > 0) g.rowsRead += u.call.rowsRead
      if (u.call.rowsAffected > 0) g.rowsAffected += u.call.rowsAffected
      if (u.call.error) {
        g.errors++
        g.lastError = u.call.error
      }
    }
    g.firstTs = Math.min(g.firstTs, u.call.ts)
  }

  const analyzed = [...groups.values()]
    .map((g) => analyzeGroup({ ...g, apps: [...g.apps], _calls: undefined }, cfg))
    .sort((a, b) => b.avoidable - a.avoidable || b.count - a.count || a.firstTs - b.firstTs)

  const total = units.length
  const roundTrips = calls.length
  const crossGroupWrites = duplicateRowWrites(units, analyzed)

  const inRequest = analyzed.reduce((s, g) => s + g.avoidableInRequest, 0)
  const acrossRequests = analyzed.reduce((s, g) => s + g.avoidableAcrossRequests, 0)
  const writes = analyzed.reduce((s, g) => s + g.avoidableWrites, 0) + crossGroupWrites.avoidable

  // The headline counts only what can be fixed inside a request. Repetition across
  // requests is reported next to it, never folded in - it needs merged endpoints or
  // a shared cache, which is a different decision.
  const avoidable = inRequest + writes
  const roundTripSavings = analyzed.reduce((s, g) => s + g.roundTripSavings, 0)
  const totalMs = calls.reduce((s, c) => s + (c.durationMs ?? 0), 0)

  const actionFindings = [...crossGroupWrites.findings, ...readAfterWrite(units)]
  if ((action.saveChanges?.length ?? 0) >= 2) {
    const entities = action.saveChanges.reduce((s, e) => s + (e.entities ?? 0), 0)
    actionFindings.push({
      code: 'multi-savechanges',
      level: 'med',
      bucket: null,
      title: `SaveChanges ran ${action.saveChanges.length}× (${entities} entities)`,
      detail: 'Each SaveChanges is its own transaction and round-trip set.',
      fix: 'Collect the changes and persist them in a single SaveChanges at the end of the flow where the flow allows it.',
      avoidable: 0,
    })
  }

  let level = 'ok'
  for (const g of analyzed) level = worst(level, g.level)
  for (const f of actionFindings) level = worst(level, f.level)

  const reducible = pct(avoidable, total)
  let colour = 'green'
  if (level === 'high' || reducible >= 34) colour = 'red'
  else if (level === 'med' || avoidable > 0) colour = 'amber'

  return {
    id: action.id,
    label: action.label,
    kind: action.kind,
    url: action.url,
    dom: action.dom,
    startedAt: action.startedAt,
    endedAt: action.endedAt,
    durationMs: (action.endedAt ?? action.startedAt) - action.startedAt,
    apps: [...new Set(calls.map((c) => c.app).filter(Boolean))],
    endpoints: [...new Set(calls.map((c) => c.handler || c.path).filter(Boolean))],
    requests: action.requests?.length ?? 0,
    total,
    roundTrips,
    unique: new Set(units.map((u) => u.shape + '' + u.paramSig)).size,

    // How the summary numbers are derived, so they can be checked against the groups:
    //   avoidable = avoidableInRequest + avoidableWrites   (sum over groups)
    //   projected = total - avoidable
    //   reducible = round(avoidable / total * 100)
    //   avoidableAcrossRequests is reported but NOT part of avoidable/projected
    //   roundTripSavings = extra database round-trips a write loop could batch away;
    //     it counts round-trips, not calls, so it is not part of avoidable either
    avoidable,
    avoidableInRequest: inRequest,
    avoidableAcrossRequests: acrossRequests,
    avoidableWrites: writes,
    projected: Math.max(total - avoidable, 0),
    floor: Math.max(total - avoidable - acrossRequests, 0),
    roundTripSavings,
    reducible,
    totalMs: Math.round(totalMs),
    colour,
    level,
    findings: actionFindings,
    groups: analyzed,
  }
}

export function summarise(actions) {
  const sum = (field) => actions.reduce((s, a) => s + a[field], 0)
  const total = sum('total')
  const avoidable = sum('avoidable')
  return {
    avoidableInRequest: sum('avoidableInRequest'),
    avoidableAcrossRequests: sum('avoidableAcrossRequests'),
    avoidableWrites: sum('avoidableWrites'),
    actions: actions.length,
    total,
    avoidable,
    projected: Math.max(total - avoidable, 0),
    reducible: pct(avoidable, total),
    totalMs: actions.reduce((s, a) => s + a.totalMs, 0),
    red: actions.filter((a) => a.colour === 'red').length,
    amber: actions.filter((a) => a.colour === 'amber').length,
    green: actions.filter((a) => a.colour === 'green').length,
  }
}
