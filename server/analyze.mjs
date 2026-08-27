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
    if (distinct.size <= 1) continue

    // The same method can appear at this depth in several paths (recursion, or a
    // helper called from more than one place). Naming them all identically would
    // be useless, so add the line to tell those apart.
    const chosen = labels.map((l, k) => ({ name: l[i] ?? l[l.length - 1] ?? null, frame: frameLists[k][i] }))
    const counts = new Map()
    for (const c of chosen) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)

    return chosen.map(({ name, frame }) =>
      name && counts.get(name) > 1 && frame?.l ? `${name}:${frame.l}` : name,
    )
  }

  return fallback()
}

function callPathsOf(units, plumbing = new Set()) {
  const paths = new Map()

  for (const u of units) {
    // Same trimming as the call site, so the displayed path cannot contradict it.
    const { frames } = usableFrames(u.call.stack ?? [], plumbing)
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

/**
 * Finds the data-access plumbing in this recording, without knowing anything
 * about the codebase.
 *
 * A method that sits innermost for many *different* queries is a helper the whole
 * application funnels through - a repository, a table wrapper, a DbContext
 * facade. Naming it as the call site is useless: every row would read the same.
 * Whoever is reading the report wants the first method above it, which is the
 * code they would actually change.
 */
// Measured on real recordings, the two populations separate cleanly:
//   data-access helpers   ~50% of their appearances are at depth 0 or 1
//   application methods   0-6%
// (It is not ~100% for helpers because an await boundary produces a composite
// stack with a second copy of the data-access frames at the tail.)
function plumbingMethods(units, minShapes = 3, nearLeafShare = 0.3) {
  const stats = new Map()

  for (const u of units) {
    ;(u.call.stack ?? []).forEach((frame, depth) => {
      let entry = stats.get(frame.m)
      if (!entry) {
        entry = { shapes: new Set(), seen: 0, nearLeaf: 0 }
        stats.set(frame.m, entry)
      }
      entry.shapes.add(u.shape)
      entry.seen++
      if (depth <= 1) entry.nearLeaf++
    })
  }

  // Infrastructure sits directly against the database: it is used for many
  // different queries AND is almost always one of the innermost frames.
  //
  // The depth test is what keeps ordinary application code out. A busy service
  // method also turns up in a lot of stacks, but at all sorts of depths - so it
  // is a caller, not a helper, and it is exactly the name worth showing.
  const plumbing = new Set()
  for (const [method, { shapes, seen, nearLeaf }] of stats) {
    if (shapes.size >= minShapes && nearLeaf / seen >= nearLeafShare) plumbing.add(method)
  }
  return plumbing
}

/**
 * Separates a real call path from an async continuation remnant.
 *
 * The stack is captured live, so when a command is issued after an await the
 * physical stack can still hold the resumed frames of the operation that was
 * awaited. Those frames belong to a *different*, already-finished query, and
 * they read as a mirror image: the data-access frames sit at the tail instead of
 * the head, with line numbers on the closing braces.
 *
 * A genuine path starts at the data access and ends at an entry point. So:
 *  - data access at the head  -> real path (a remnant may still hang off the end)
 *  - data access only further down -> what we can see is somebody else's tail
 */
function usableFrames(frames, plumbing) {
  if (!frames?.length) return { frames: [], reliable: false }

  const hasPlumbing = frames.some((f) => plumbing.has(f.m))

  // No data-access layer in this codebase at all: take the stack at face value.
  if (!hasPlumbing) return { frames, reliable: true }

  if (!plumbing.has(frames[0].m)) {
    return { frames: [], reliable: false }
  }

  // Nothing calls a controller from a repository, so trailing data-access frames
  // are the start of a remnant. Drop them.
  let end = frames.length
  while (end > 1 && plumbing.has(frames[end - 1].m)) end--

  return { frames: frames.slice(0, end), reliable: true }
}

function callsiteOf(call, plumbing = new Set()) {
  const { frames, reliable } = usableFrames(call.stack ?? [], plumbing)

  // Better to say nothing than to name a method that did not run this query.
  if (!reliable || frames.length === 0) return null

  // Step out of the plumbing, but not indefinitely: past a few layers we would
  // drift up to the controller, which says nothing about this query.
  const MAX_SKIP = 5
  const frame = frames.slice(0, MAX_SKIP + 1).find((f) => !plumbing.has(f.m)) ?? frames[0]

  return {
    method: frame.m,
    file: frame.f ?? null,
    line: frame.l ?? null,
    // Kept so nothing is hidden: the frame that literally issued the command.
    innermost: frames[0].m,
  }
}

function groupKey(unit, call, plumbing) {
  const site = callsiteOf(call, plumbing)
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
  const paths = callPathsOf(g.units, cfg.plumbing ?? new Set())

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
    // Only statements whose row could actually be identified. A statement whose
    // parameters were not captured tells us nothing, and counting it as another
    // write to the same row invents redundancy that is not there.
    const identified = g.units.filter((u) => u.rowKey !== null && u.rowKey !== undefined)
    const knownRows = new Set(identified.map((u) => u.rowKey)).size
    const unidentified = g.count - identified.length

    const dupes = identified.length - knownRows
    if (dupes > 0 && knownRows > 0) {
      const factor = (identified.length / knownRows).toFixed(1)
      writes += dupes
      findings.push({
        code: 'duplicate-write',
        level: 'high',
        bucket: 'writes',
        title: `Every row of ${g.table ?? 'this table'} is written ${factor}× `.trim(),
        detail:
          `${identified.length} ${g.op} statements touch only ${knownRows} distinct row${knownRows === 1 ? '' : 's'}. ` +
          (paths.length > 1
            ? `The writes come from ${paths.length} different code paths: ${originsText}. `
            : `${dupes} of them write values that were just written. `) +
          (unidentified > 0
            ? `${unidentified} further statement${unidentified === 1 ? '' : 's'} could not be checked — their parameters were not captured, so they are excluded from this count.`
            : ''),
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
  let roundTrips = 0

  for (const u of units) {
    if (!WRITE_OPS.includes(u.op) || !u.table) continue
    // null means the row could not be identified, not that it is the same row.
    if (u.rowKey === null || u.rowKey === undefined || u.rowKey === '' || u.rowKey === '(all rows)') continue

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
    // Same row, different columns: nothing is overwritten, each write persists
    // something newly computed. The cost is the extra round-trip, not the write.
    let unbatchedRows = 0
    let unbatchedRoundTrips = 0
    const stacks = new Map() // stack signature -> { frames, count }

    for (const writes of rows.values()) {
      if (writes.length < 2) continue

      const columnSets = new Set(writes.map((w) => (w.setColumns ?? []).join(',')))
      if (columnSets.size === writes.length && columnSets.size > 1) {
        // Every write sets a different group of columns - not redundancy.
        unbatchedRows++
        unbatchedRoundTrips += new Set(writes.map((w) => w.call.id)).size - 1
        continue
      }

      // Only the repeats that write the same columns are genuinely redundant.
      extra += writes.length - columnSets.size
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

    if (unbatchedRows > 0 && unbatchedRoundTrips > 0) {
      roundTrips += unbatchedRoundTrips
      findings.push({
        code: 'unbatched-save',
        level: 'med',
        bucket: null,
        title: `${unbatchedRows} ${table} row${unbatchedRows === 1 ? '' : 's'} saved in several separate round-trips`,
        detail:
          'Each write sets different columns, so nothing is overwritten — these are separate ' +
          'SaveChanges flushes persisting freshly calculated values one at a time.',
        fix:
          `Let the change tracker collect them and save once at the end of the flow. EF would ` +
          `then issue a single UPDATE per row, saving about ${unbatchedRoundTrips} round-trip${unbatchedRoundTrips === 1 ? '' : 's'}.`,
        avoidable: 0,
      })
    }

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

  return { findings, avoidable, roundTrips }
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
  const plumbing = plumbingMethods(units)

  const groups = new Map()
  for (const u of units) {
    const key = groupKey(u, u.call, plumbing)
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
        callsite: callsiteOf(u.call, plumbing),
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

    // One batched command can feed several groups. Charging its full duration to
    // each would make the group times sum to more than the flow actually took, so
    // each group gets the share of the command its statements account for.
    g.totalMs += (u.call.durationMs ?? 0) / (u.call.statements?.length || 1)

    if (!g._calls.has(u.call.id)) {
      g._calls.add(u.call.id)
      g.roundTrips++
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
    .map((g) => analyzeGroup({ ...g, apps: [...g.apps], _calls: undefined }, { ...cfg, plumbing }))
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
  const roundTripSavings =
    analyzed.reduce((s, g) => s + g.roundTripSavings, 0) + crossGroupWrites.roundTrips
  const totalMs = calls.reduce((s, c) => s + (c.durationMs ?? 0), 0)

  const actionFindings = [...crossGroupWrites.findings, ...readAfterWrite(units)]
  if ((action.saveChanges?.length ?? 0) >= 2) {
    const entities = action.saveChanges.reduce((s, e) => s + (e.entities ?? 0), 0)

    // A SaveChanges over an unchanged tracker issues nothing. Only the flushes
    // that produced a command cost a transaction, so count those.
    const flushes = new Set(
      units.filter((u) => u.op !== 'SELECT').map((u) => u.call.id),
    ).size

    if (flushes >= 2) {
      actionFindings.push({
        code: 'multi-savechanges',
        level: 'med',
        bucket: null,
        title: `SaveChanges ran ${action.saveChanges.length}× (${entities} entities), ${flushes} of them reached the database`,
        detail:
          `${action.saveChanges.length - flushes} produced no SQL — the change tracker had nothing to write. ` +
          `The other ${flushes} are each their own transaction and round-trip set.`,
        fix: 'Collect the changes and persist them in a single SaveChanges at the end of the flow where the flow allows it.',
        avoidable: 0,
      })
    }
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
