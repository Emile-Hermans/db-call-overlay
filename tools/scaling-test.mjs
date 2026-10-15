// Checks the growth model: what makes a call count a constant, what makes it a
// function of the data, and that nothing is claimed when the evidence is missing.
//   node tools/scaling-test.mjs
import { analyzeAction, DEFAULTS, commandKind } from '../server/analyze.mjs'
import { shred } from '../server/sql.mjs'

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

let seq = 0
function call({ req, sql, params = [], ms = 2, site = 'Svc.Method', line = 10, rows, source = 'LinqQuery' }) {
  const id = `q${++seq}`
  const c = {
    id,
    seq,
    ts: 1000 + seq,
    durationMs: ms,
    rowsAffected: -1,
    // The recorder counts Reader.Read() calls, so a fully enumerated set of n
    // rows reports n+1. The fixtures use the number the recorder would send.
    rowsRead: rows === undefined ? -1 : rows + 1,
    app: 'Shop.OrdersApi',
    reqId: req,
    handler: req,
    source,
    exec: source === 'BulkUpdate' ? 'ExecuteNonQuery' : 'ExecuteReader',
    stack: [{ m: site, f: 'Core\\X.cs', l: line }],
  }
  c.sql = sql
  c.params = params
  c.statements = shred(sql, params).statements
  return c
}

const analyse = (calls, label = 'flow') =>
  analyzeAction(
    { id: label, label, kind: 'click', startedAt: 1000, endedAt: 2000, calls, requests: [{ id: 'r1' }], saveChanges: [] },
    DEFAULTS,
  )

const groupFor = (a, table, op = 'SELECT') => a.groups.find((g) => g.table === table && g.op === op)

// ---------------------------------------------------------------------------
// 1. A loop inside a loop. Three orders, four lines each: the line query runs
//    12 times, and that 12 is 3 x 4 rather than a constant.
{
  const orders = 'SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[CrmId] = @p0'
  const shipments = 'SELECT [s].[Id] FROM [Shipments] AS [s] WHERE [s].[OrderId] = @p0'
  const lines = 'SELECT [l].[Id], [l].[Qty] FROM [OrderLines] AS [l] WHERE [l].[ShipmentId] = @p0'

  const calls = [call({ req: 'r1', sql: orders, params: [{ n: '@p0', v: 'crm-1' }], rows: 3, site: 'Svc.LoadOrders' })]

  // one shipment query per order, each returning 4 shipments
  for (let o = 1; o <= 3; o++) {
    calls.push(call({ req: 'r1', sql: shipments, params: [{ n: '@p0', v: `o-${o}` }], rows: 4, site: 'Svc.LoadShipments' }))
  }
  // one line query per shipment: 3 x 4 = 12
  for (let s = 1; s <= 12; s++) {
    calls.push(call({ req: 'r1', sql: lines, params: [{ n: '@p0', v: `s-${s}` }], rows: 2, site: 'Svc.LoadLines' }))
  }

  const a = analyse(calls, 'nested')
  const shipmentGroup = groupFor(a, 'Shipments')
  const lineGroup = groupFor(a, 'OrderLines')
  const orderGroup = groupFor(a, 'Orders')

  console.log(`\n[nested]  formula: ${a.scaling.formula}`)
  console.log(
    `          today ${a.total} calls | at ${a.scaling.factor}x ${a.scaling.projected} | worst case ${a.scaling.worstCase}\n`,
  )

  check(orderGroup?.scaling?.depth === 0, 'the driving query itself does not grow', `got ${orderGroup?.scaling?.depth}`)
  check(shipmentGroup?.scaling?.depth === 1, 'one call per order row is one level deep', `got ${shipmentGroup?.scaling?.depth}`)
  check(
    JSON.stringify(shipmentGroup?.scaling?.chain) === JSON.stringify(['Orders']),
    'the shipment loop is driven by Orders',
    `got ${JSON.stringify(shipmentGroup?.scaling?.chain)}`,
  )
  check(lineGroup?.scaling?.depth === 2, 'one call per shipment inside a loop over orders is two levels deep', `got ${lineGroup?.scaling?.depth}`)
  check(
    JSON.stringify(lineGroup?.scaling?.chain) === JSON.stringify(['Orders', 'Shipments']),
    'the line loop names both levels of its chain',
    `got ${JSON.stringify(lineGroup?.scaling?.chain)}`,
  )
  check(lineGroup?.level === 'high', 'a loop inside a loop is red', `got ${lineGroup?.level}`)
  check(
    lineGroup?.findings.some((f) => f.code === 'scales-multiplicative'),
    'the multiplicative growth is reported as its own finding',
  )
  check(a.scaling.maxDepth === 2, 'the flow reports its deepest nesting', `got ${a.scaling.maxDepth}`)

  // Only the outermost collection growing is linear; every level growing is not.
  check(a.scaling.worstCase > a.scaling.projected, 'the worst case exceeds the linear reading')
  check(
    a.scaling.projected === a.scaling.fixed + (3 + 12) * 10,
    'the linear projection scales every growing group once',
    `got ${a.scaling.projected}, fixed ${a.scaling.fixed}`,
  )
  check(
    a.scaling.worstCase === a.scaling.fixed + 3 * 10 + 12 * 100,
    'the worst case squares the two-level loop',
    `got ${a.scaling.worstCase}`,
  )

  // Growth is a risk, not a removable call: it must not move the headline.
  check(a.avoidable === a.avoidableInRequest + a.avoidableWrites, 'growth findings leave the headline arithmetic intact')
}

// ---------------------------------------------------------------------------
// 2. Without row counts nothing may be concluded. An old recording, or a read
//    the caller abandoned early, must produce "unknown" rather than a guess.
{
  const lines = 'SELECT [l].[Id] FROM [OrderLines] AS [l] WHERE [l].[Id] = @p0'
  const calls = [1, 2, 3, 4, 5].map((i) =>
    call({ req: 'r1', sql: lines, params: [{ n: '@p0', v: `l-${i}` }], site: 'Svc.Loop' }),
  )

  const a = analyse(calls, 'no-rows')
  const g = groupFor(a, 'OrderLines')

  check(g?.scaling?.depth === null, 'a loop with no row counts is unknown, not assumed to grow', `got ${g?.scaling?.depth}`)
  check(!g?.findings.some((f) => f.code.startsWith('scales')), 'no growth finding is invented without evidence')
  check(a.scaling.unclassified === 1, 'the unclassified group is reported rather than hidden', `got ${a.scaling.unclassified}`)
  check(a.scaling.maxDepth === 0, 'an unknown group does not count as nesting', `got ${a.scaling.maxDepth}`)
  // The N+1 rule still fires - that one does not need row counts.
  check(g?.findings.some((f) => f.code === 'n-plus-one'), 'the N+1 rule is unaffected by missing row counts')
}

// ---------------------------------------------------------------------------
// 3. A fixed number of lookups must not be reported as growth.
{
  const lookup = 'SELECT [k].[Id], [k].[Val] FROM [Lookups] AS [k] WHERE [k].[Kind] = @p0'
  const calls = ['a', 'b', 'c'].map((k) =>
    call({ req: 'r1', sql: lookup, params: [{ n: '@p0', v: k }], rows: 12, site: 'Svc.Warmup' }),
  )

  const a = analyse(calls, 'fixed-lookups')
  const g = groupFor(a, 'Lookups')
  check(g?.scaling?.depth === null, 'three lookups with no driver stay unknown', `got ${g?.scaling?.depth}`)
  check(a.scaling.projected === a.total, 'nothing proven to grow leaves the projection equal to today')
}

// ---------------------------------------------------------------------------
// 4. Command kinds: schema work is excluded, set-based writes are not advised to
//    become set-based, and a tracked save still is.
{
  const migration = "SELECT [m].[MigrationId] FROM [__EFMigrationsHistory] AS [m] WHERE [m].[MigrationId] = @p0"
  const keys = 'SELECT NEXT VALUE FOR [OrderSequence]'
  const read = 'SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[Id] = @p0'

  const calls = [
    call({ req: 'r1', sql: migration, params: [{ n: '@p0', v: 'm1' }], rows: 1, source: 'Migrations' }),
    call({ req: 'r1', sql: keys, rows: 1, source: 'ValueGenerator' }),
    call({ req: 'r1', sql: read, params: [{ n: '@p0', v: 'o-1' }], rows: 1 }),
  ]

  const a = analyse(calls, 'infra')
  check(a.total === 1, 'schema and key-generation statements are left out of the call count', `got ${a.total}`)
  check(a.excluded.statements === 2, 'the excluded statements are reported', `got ${a.excluded.statements}`)
  check(
    a.findings.some((f) => f.code === 'infrastructure-excluded'),
    'the exclusion is visible as a finding rather than silent',
  )
  check(!a.groups.some((g) => g.table === '__EFMigrationsHistory'), 'no group is built for schema work')
}

// ---------------------------------------------------------------------------
// 5. A loop of set-based writes keeps the round-trip finding but not the advice
//    to make it set-based.
{
  const bulk = 'UPDATE [l] SET [l].[Qty] = @p0 FROM [OrderLines] AS [l] WHERE [l].[ShipmentId] = @p1'
  const calls = [1, 2, 3, 4, 5, 6].map((i) =>
    call({
      req: 'r1',
      sql: bulk,
      params: [{ n: '@p0', v: '1' }, { n: '@p1', v: `s-${i}` }],
      site: 'Svc.BulkLoop',
      source: 'BulkUpdate',
    }),
  )

  const a = analyse(calls, 'bulk-loop')
  const g = groupFor(a, 'OrderLines', 'UPDATE')
  const loop = g?.findings.find((f) => f.code === 'write-loop')

  check(g?.setBased === true, 'the group is recognised as set-based', `kinds ${JSON.stringify(g?.kinds)}`)
  check(Boolean(loop), 'the round-trip cost of the loop is still reported')
  check(
    loop && !/ExecuteUpdate/i.test(loop.fix),
    'code that is already set-based is not told to become set-based',
    `fix: ${loop?.fix}`,
  )
  check(
    a.findings.every((f) => f.code !== 'multi-savechanges'),
    'set-based writes are not counted as change-tracker flushes',
  )
}

// ---------------------------------------------------------------------------
// 6. commandKind must not guess when the source is absent.
{
  check(commandKind({ source: 'LinqQuery' }) === 'query', 'LinqQuery is a query')
  check(commandKind({ source: 'SaveChanges' }) === 'save', 'SaveChanges is a tracked save')
  check(commandKind({ source: 'BulkUpdate' }) === 'bulk', 'BulkUpdate is a set-based write')
  check(commandKind({ source: 'AdoNet' }) === 'rawsql', 'a hand-written command is raw sql')
  check(commandKind({}) === 'unknown', 'no source reported means unknown, not a guess')
  check(commandKind({ source: 'SomethingNew' }) === 'unknown', 'an unrecognised source is unknown, not misfiled')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
