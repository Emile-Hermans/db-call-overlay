// How a flow's call count grows when the data grows.
//
// A count on its own does not say whether a query is safe. Twelve executions are
// fine if there will always be twelve, and a problem if twelve is three parents
// times four children - because then the number is a function of the data, and
// the recording only shows today's data.
//
// So each group is classified by what drives its execution count:
//
//   fixed        runs a set number of times whatever the data holds
//   per row      runs once per row of an earlier query          (linear)
//   per row x2+  runs once per row of a query that is itself     (multiplicative)
//                driven per row - a loop inside a loop
//
// The evidence is arithmetic, not a guess: a query that produced n rows, followed
// in the same request by a query that ran n times, is a loop over those rows. If
// no earlier query produced the right number of rows, nothing is claimed.

export const SCALING_DEFAULTS = {
  /** "What if there were this much more data" - the projection the header shows. */
  projectionFactor: 10,
  /** Below this many executions in one request there is no loop to talk about. */
  minExecutions: 2,
  /** How far the row arithmetic may be out before a driver is rejected. */
  driverTolerance: 0.15,
  /** One level of per-row growth this wide is already worth a red row on its own. */
  wideLoop: 25,
}

/**
 * How many rows a set of executions produced, as a range.
 *
 * rowsRead counts Reader.Read() calls, which is one more than the row count when
 * the caller enumerates to the end and one exactly when it stops early. Which of
 * those happened is not observable, so both bounds are carried and a driver only
 * has to match somewhere inside them.
 */
function rowRange(units) {
  let lo = 0
  let hi = 0
  for (const u of units) {
    const read = u.call.rowsRead ?? -1
    if (read <= 0) continue
    lo += Math.max(read - 1, 0)
    hi += read
  }
  return { lo, hi }
}

/** Does `count` executions look like one per row of a query that produced `range`? */
function explains(count, range, tolerance) {
  // A query that produced at most one row cannot be what makes another one loop.
  if (range.hi <= 1) return false
  const slack = Math.max(1, range.hi * tolerance)
  return count >= range.lo - slack && count <= range.hi + slack
}

function firstTs(units) {
  return units.reduce((min, u) => Math.min(min, u.call.ts ?? Infinity), Infinity)
}

/** Executions whose identity is known - the rest prove nothing when compared. */
function identified(units) {
  return units.filter((u) => u.paramSig !== null && u.paramSig !== undefined)
}

/**
 * One request at a time: a loop only exists inside a single request, and row
 * counts from a different request describe a different DbContext and a different
 * unit of work.
 */
function classifyRequest(groups, reqId, cfg) {
  const present = new Map()
  for (const g of groups) {
    const units = g.units.filter((u) => (u.call.reqId ?? null) === reqId)
    if (units.length) {
      present.set(g.id, { group: g, units, count: units.length, ts: firstTs(units), rows: rowRange(units) })
    }
  }

  // Which query's rows explain each loop. Only a read can drive a loop, and only
  // one that had already run by the time the loop started.
  const driver = new Map()
  for (const [id, entry] of present) {
    if (entry.count < cfg.minExecutions) continue
    // Executions that are all the same call with the same values are a repeated
    // fetch, not a loop over rows - `identical-repeat` is the finding for that.
    if (new Set(identified(entry.units).map((u) => u.paramSig)).size < 2) continue

    let best = null
    for (const [otherId, other] of present) {
      if (otherId === id || other.group.op !== 'SELECT') continue
      if (other.ts > entry.ts) continue
      if (!explains(entry.count, other.rows, cfg.driverTolerance)) continue

      // The nearest driver is the innermost loop this one sits in, so prefer the
      // query that ran last, and among those the closest row count.
      const midpoint = (other.rows.lo + other.rows.hi) / 2
      const score = [other.ts, -Math.abs(entry.count - midpoint)]
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
        best = { id: otherId, score }
      }
    }

    if (best) driver.set(id, best.id)
  }

  // Walk each chain out to its root. A tie in timestamps could in principle point
  // two groups at each other, so the walk is bounded by what it has already seen.
  const chains = new Map()
  for (const id of present.keys()) {
    const chain = []
    const seen = new Set([id])
    let at = id
    while (driver.has(at)) {
      const next = driver.get(at)
      if (seen.has(next)) break
      seen.add(next)
      chain.unshift(next)
      at = next
    }
    chains.set(id, chain)
  }

  const out = new Map()
  for (const [id, entry] of present) {
    const chain = chains.get(id) ?? []
    const isLoop =
      entry.count >= cfg.minExecutions &&
      new Set(identified(entry.units).map((u) => u.paramSig)).size >= 2

    out.set(id, {
      reqId,
      executions: entry.count,
      // null means "this loops, but what drives it could not be established" -
      // deliberately different from 0, which means "this does not grow".
      depth: chain.length > 0 ? chain.length : isLoop ? null : 0,
      chain: chain.map((driverId) => present.get(driverId)?.group.table ?? '?'),
      driverRows: chain.length ? present.get(chain[chain.length - 1]).rows : null,
    })
  }
  return out
}

/**
 * Worst case across the requests of one action. A query can sit in a loop in one
 * request and be a single lookup in another; the deeper reading is the one that
 * matters, because that is the one that grows.
 */
export function analyzeScaling(groups, cfg = SCALING_DEFAULTS) {
  const reqIds = new Set()
  for (const g of groups) for (const u of g.units) reqIds.add(u.call.reqId ?? null)

  const perGroup = new Map()
  for (const reqId of reqIds) {
    for (const [id, found] of classifyRequest(groups, reqId, cfg)) {
      const held = perGroup.get(id)
      if (!held) {
        perGroup.set(id, found)
        continue
      }
      const rank = (s) => (s.depth === null ? 0.5 : s.depth)
      if (rank(found) > rank(held) || (rank(found) === rank(held) && found.executions > held.executions)) {
        perGroup.set(id, found)
      }
    }
  }

  // Level and wording per group.
  for (const [id, s] of perGroup) {
    s.level = s.depth === null || s.depth === 0 ? null : s.depth >= 2 ? 'high' : s.executions >= cfg.wideLoop ? 'high' : 'med'
    s.label =
      s.depth === null
        ? 'grows? unknown'
        : s.depth === 0
          ? 'fixed'
          : `per ${s.chain.join(' × ')}`
    perGroup.set(id, s)
  }

  return { groups: perGroup, action: summariseScaling(groups, perGroup, cfg) }
}

/**
 * The flow-level projection.
 *
 * Two readings, because one recording cannot tell them apart and the difference
 * is the whole question:
 *   projected  only the outermost collection grows - every level below keeps the
 *              size it has now. A nested loop is then still only linear.
 *   worstCase  every level grows by the same factor, so a loop nested n deep
 *              multiplies by the factor n times.
 */
function summariseScaling(groups, perGroup, cfg) {
  const factor = cfg.projectionFactor
  let fixed = 0
  let projected = 0
  let worstCase = 0
  let maxDepth = 0
  let unclassified = 0
  let unclassifiedCalls = 0
  const dimensions = new Set()
  const buckets = new Map()

  for (const g of groups) {
    const s = perGroup.get(g.id)
    const calls = g.count

    if (!s || s.depth === 0) {
      fixed += calls
      projected += calls
      worstCase += calls
      continue
    }

    if (s.depth === null) {
      // Not proven to grow and not proven not to. Counted at today's size so the
      // projection stays a floor rather than a guess, but kept out of `fixed` -
      // calling it fixed would assert the one thing that is not known.
      unclassified++
      unclassifiedCalls += calls
      projected += calls
      worstCase += calls
      continue
    }

    maxDepth = Math.max(maxDepth, s.depth)
    for (const table of s.chain) dimensions.add(table)
    projected += calls * factor
    worstCase += calls * Math.pow(factor, s.depth)

    const key = s.chain.join(' × ')
    buckets.set(key, (buckets.get(key) ?? 0) + calls)
  }

  const terms = [
    ...(fixed > 0 ? [{ kind: 'fixed', calls: fixed, chain: [] }] : []),
    ...[...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, calls]) => ({ kind: 'per', calls, chain: key.split(' × ') })),
    ...(unclassifiedCalls > 0 ? [{ kind: 'unknown', calls: unclassifiedCalls, chain: [] }] : []),
  ]

  return {
    factor,
    maxDepth,
    fixed,
    projected,
    worstCase,
    dimensions: [...dimensions],
    unclassified,
    unclassifiedCalls,
    terms,
    formula: terms
      .map((t) =>
        t.kind === 'fixed'
          ? `${t.calls} fixed`
          : t.kind === 'unknown'
            ? `${t.calls} unclassified`
            : `${t.calls} per ${t.chain.join(' × ')}`,
      )
      .join(' + '),
    // Green while the count cannot run away, amber for linear growth, red once a
    // loop sits inside another loop.
    level: maxDepth >= 2 ? 'high' : maxDepth === 1 ? 'med' : null,
  }
}

/** The per-group finding, if this group grows with the data. */
export function scalingFinding(group, s, cfg = SCALING_DEFAULTS) {
  if (!s || s.depth === null || s.depth === 0) return null

  const table = group.table ?? 'this table'
  const inner = s.chain[s.chain.length - 1] ?? 'a parent row'
  const factor = cfg.projectionFactor

  if (s.depth === 1) {
    return {
      code: 'scales-with-data',
      level: s.level,
      bucket: null,
      title: `Runs once per ${inner} row — ${s.executions} executions today`,
      detail:
        `${inner} produced ${s.executions} row${s.executions === 1 ? '' : 's'} and this ran ${s.executions}×, ` +
        `so the count is not a constant: it follows the size of ${inner}. ` +
        `At ${factor}× the data that is about ${s.executions * factor} calls.`,
      fix:
        `Fetch the set in one query — WHERE ${table}.Id IN (...) over the ids you already have, ` +
        `or Include/Select ${table} together with the ${inner} query.`,
      avoidable: 0,
    }
  }

  const chain = s.chain.join(' × ')
  return {
    code: 'scales-multiplicative',
    level: 'high',
    bucket: null,
    title: `Runs once per ${inner} row, inside a loop over ${s.chain[0]} — ${s.executions} executions today`,
    detail:
      `The chain is ${chain} → ${table}, so this count is a product of ${s.depth} levels, not a constant. ` +
      `At ${factor}× the ${s.chain[0]} rows that is about ${s.executions * factor} calls; if the ` +
      `${inner} rows per ${s.chain[0]} grow as well it is about ${s.executions * Math.pow(factor, s.depth)}.`,
    fix:
      `Collapse both levels into one query — load every ${table} for the whole ${s.chain[0]} set at once ` +
      `(one WHERE ... IN (...) keyed on the parents you already have) instead of querying inside the inner loop.`,
    avoidable: 0,
  }
}
