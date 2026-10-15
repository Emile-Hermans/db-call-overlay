// Where the time of one click went, and what to fix first.
//
// The rest of the analysis answers "which calls are redundant". This answers the
// question a slow screen actually raises: of the time the user waited, how much
// was the database, how much was the application itself, and which change buys
// back the most of it.
//
// Every number here is measured from timestamps, except the estimated savings in
// the fix list, which are labelled as estimates everywhere they are shown.

/** Below this, a click is fast enough that no verdict is worth giving. */
export const FAST_MS = 150

/** At or above this share of server time, the database is the bottleneck. */
const DB_BOUND_SHARE = 0.5

/** The waterfall is a picture, not a table: past this many spans it stops being readable. */
const MAX_SPANS = 1500

const LEVEL_RANK = { ok: 0, low: 1, med: 2, high: 3 }

/** Total length of a set of [start, end] intervals, overlaps counted once. */
export function unionMs(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  let total = 0
  let curStart = null
  let curEnd = null
  for (const [s, e] of sorted) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart
      curStart = s
      curEnd = e
    } else if (e > curEnd) {
      curEnd = e
    }
  }
  if (curEnd !== null) total += curEnd - curStart
  return total
}

/** Clips [s, e] to [lo, hi]; null when nothing is left. */
function clip([s, e], lo, hi) {
  const a = Math.max(s, lo)
  const b = Math.min(e, hi)
  return b > a ? [a, b] : null
}

const callInterval = (c) => [c.ts, c.ts + Math.max(c.durationMs ?? 0, 0)]

/**
 * @param action  the raw recorded action (requests + calls)
 * @param groups  the analysed groups, each with `id`, `level`, `op`, `table`,
 *                `findings`, `avoidable`, `count`, `totalMs`, `callsite`
 * @param callGroup  Map call id -> group id
 * @param timing  Map call id -> 'waited' | 'afterResponse' | 'background'
 */
export function analyzeTime(action, groups, callGroup, timing) {
  const calls = action.calls ?? []
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const ended = (action.requests ?? []).filter(
    (r) => typeof r.startedAt === 'number' && typeof r.durationMs === 'number',
  )

  // ------------------------------------------------------------ the frame
  // The click's window: from the first thing the server saw to the last thing
  // the user waited for. Calls that ran after the response do not stretch it.
  const waitedCalls = calls.filter((c) => (timing.get(c.id) ?? 'waited') === 'waited')
  const starts = [...ended.map((r) => r.startedAt), ...calls.map((c) => c.ts)]
  const t0 = starts.length ? Math.min(...starts) : action.startedAt
  const ends = [...ended.map((r) => r.startedAt + r.durationMs), ...waitedCalls.map((c) => callInterval(c)[1])]
  const t1 = ends.length ? Math.max(...ends) : t0
  const wallMs = Math.max(t1 - t0, 0)

  // ------------------------------------------------------------ the split
  // Server time is the union of request windows, so two requests that ran in
  // parallel are not counted twice. Database time is the union of the waited
  // calls clipped to those windows - the part of the wait spent on SQL.
  const reqIntervals = ended.map((r) => [r.startedAt, r.startedAt + r.durationMs])
  const serverMs = reqIntervals.length ? unionMs(reqIntervals) : null

  const dbIntervals = reqIntervals.length
    ? waitedCalls.flatMap((c) => reqIntervals.map((w) => clip(callInterval(c), w[0], w[1])).filter(Boolean))
    : waitedCalls.map(callInterval)
  const dbMs = unionMs(dbIntervals)
  const appMs = serverMs === null ? null : Math.max(serverMs - dbMs, 0)
  const idleMs = serverMs === null ? null : Math.max(wallMs - serverMs, 0)

  // ------------------------------------------------------------ requests
  const byReq = new Map()
  for (const c of calls) {
    if (!c.reqId) continue
    if (!byReq.has(c.reqId)) byReq.set(c.reqId, [])
    byReq.get(c.reqId).push(c)
  }

  const requests = (action.requests ?? [])
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => {
      const own = byReq.get(r.id) ?? []
      const hasEnd = typeof r.durationMs === 'number'
      const window = hasEnd ? [r.startedAt, r.startedAt + r.durationMs] : null
      const db = unionMs(
        own
          .filter((c) => (timing.get(c.id) ?? 'waited') === 'waited')
          .map((c) => (window ? clip(callInterval(c), window[0], window[1]) : callInterval(c)))
          .filter(Boolean),
      )
      // Which group cost this request the most database time.
      const perGroup = new Map()
      for (const c of own) {
        const gid = callGroup.get(c.id)
        if (gid) perGroup.set(gid, (perGroup.get(gid) ?? 0) + (c.durationMs ?? 0))
      }
      const top = [...perGroup.entries()].sort((a, b) => b[1] - a[1])[0]
      return {
        id: r.id,
        app: r.app,
        method: r.method,
        path: r.path,
        handler: r.handler ?? null,
        status: r.status ?? null,
        offsetMs: Math.round(r.startedAt - t0),
        durationMs: hasEnd ? Math.round(r.durationMs) : null,
        dbMs: Math.round(db),
        appMs: hasEnd ? Math.max(Math.round(r.durationMs - db), 0) : null,
        calls: own.length,
        topGroup: top ? top[0] : null,
      }
    })

  // Requests that started only after the previous one had finished. A chain of
  // these is what the browser waited on one at a time.
  let sequential = 0
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1]
    if (prev.durationMs !== null && requests[i].offsetMs >= prev.offsetMs + prev.durationMs) sequential++
  }

  // ------------------------------------------------------------ spans
  const spans = calls
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .slice(0, MAX_SPANS)
    .map((c) => {
      const gid = callGroup.get(c.id) ?? null
      const g = gid ? groupById.get(gid) : null
      return {
        reqId: c.reqId ?? null,
        offsetMs: Math.round((c.ts - t0) * 10) / 10,
        durationMs: Math.round((c.durationMs ?? 0) * 10) / 10,
        group: gid,
        level: g?.level ?? 'ok',
        timing: timing.get(c.id) ?? 'waited',
      }
    })

  const fixFirst = rankFixes(groups, dbMs)
  const verdict = judge({ wallMs, serverMs, dbMs, appMs, idleMs, requests, sequential, fixFirst, calls: calls.length })

  return {
    wallMs: Math.round(wallMs),
    serverMs: serverMs === null ? null : Math.round(serverMs),
    dbMs: Math.round(dbMs),
    appMs: appMs === null ? null : Math.round(appMs),
    idleMs: idleMs === null ? null : Math.round(idleMs),
    dbShare: serverMs ? Math.round((dbMs / serverMs) * 100) : null,
    sequential,
    requests,
    spans,
    spansTruncated: Math.max(calls.length - MAX_SPANS, 0),
    verdict,
    fixFirst,
  }
}

/**
 * The groups worth changing, most time bought back first.
 *
 * The saving is an estimate: the removable executions times the group's average
 * duration. A slow group with nothing removable still makes the list, ranked by
 * the time it costs, because "this one query is the click" is also an answer.
 */
export function rankFixes(groups, dbMs) {
  const out = []
  for (const g of groups) {
    const worthIt = g.avoidable > 0 || g.roundTripSavings > 0 || LEVEL_RANK[g.level] >= LEVEL_RANK.med
    if (!worthIt) continue
    const avg = g.count ? g.totalMs / g.count : 0
    // A batched write loop keeps its statements but loses round-trips.
    const removable = g.avoidable > 0 ? g.avoidable : (g.roundTripSavings ?? 0)
    const savedMs = removable * avg
    const lead =
      g.findings.find((f) => f.avoidable > 0 && f.bucket !== 'across') ??
      g.findings.slice().sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])[0]
    if (!lead) continue
    out.push({
      group: g.id,
      level: g.level,
      op: g.op,
      table: g.table,
      method: g.callsite?.method ?? null,
      file: g.callsite?.file ?? null,
      line: g.callsite?.line ?? null,
      count: g.count,
      avoidable: g.avoidable,
      totalMs: Math.round(g.totalMs),
      savedMs: Math.round(savedMs),
      share: dbMs > 0 ? Math.min(Math.round((g.totalMs / dbMs) * 100), 100) : 0,
      title: lead.title,
      fix: lead.fix ?? '',
      inLoop: g.staticLoop ?? null,
    })
  }
  return out
    .sort(
      (a, b) =>
        b.savedMs - a.savedMs ||
        LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
        b.totalMs - a.totalMs ||
        b.avoidable - a.avoidable,
    )
    .slice(0, 8)
}

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`)

/**
 * One sentence on why this click took as long as it did, chosen from what was
 * measured. It names the bottleneck; the fix list names the change.
 */
function judge({ wallMs, serverMs, dbMs, appMs, idleMs, requests, sequential, fixFirst, calls }) {
  const top = fixFirst[0]

  if (wallMs < FAST_MS) {
    return {
      kind: 'fast',
      title: `Fast — ${fmt(wallMs)} from first request to last response`,
      detail: calls
        ? `${calls} database round-trip${calls === 1 ? '' : 's'}; nothing here slows the screen down.`
        : 'No database work.',
    }
  }

  if (serverMs === null) {
    return {
      kind: 'unknown',
      title: `${fmt(dbMs)} of database time`,
      detail:
        'The requests in this flow never reported their end, so the time the user waited cannot be split ' +
        'into database and application time.',
    }
  }

  const share = serverMs > 0 ? dbMs / serverMs : 0

  if (share >= DB_BOUND_SHARE) {
    return {
      kind: 'db',
      title: `Database-bound — ${Math.round(share * 100)}% of the server time is SQL`,
      detail:
        `${fmt(dbMs)} of ${fmt(serverMs)} was spent waiting on ${calls} database round-trip${calls === 1 ? '' : 's'}.` +
        (top
          ? ` The biggest lever: ${top.title.charAt(0).toLowerCase() + top.title.slice(1)}` +
            (top.savedMs ? ` (about ${fmt(top.savedMs)} back).` : '.')
          : ''),
    }
  }

  if (idleMs > serverMs && requests.length > 1) {
    return {
      kind: 'gaps',
      title: `Mostly between requests — the server was busy for ${fmt(serverMs)} of ${fmt(wallMs)}`,
      detail:
        'The rest is time between one response and the next request: the browser rendering, or waiting ' +
        'on something outside these APIs.' +
        (sequential ? ` ${sequential + 1} requests ran one after another.` : ''),
    }
  }

  return {
    kind: 'app',
    title: `Application-bound — only ${Math.round(share * 100)}% of the server time is SQL`,
    detail:
      `${fmt(appMs)} of ${fmt(serverMs)} was spent outside the database: application code, ` +
      'serialisation, calls to other services, or waiting on a lock. Removing queries will not make this fast — ' +
      'profile the endpoint instead.',
  }
}
