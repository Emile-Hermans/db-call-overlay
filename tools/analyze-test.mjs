// Checks that the three kinds of waste stay separated, and that the summary
// numbers are derivable from the group data.
//   node tools/analyze-test.mjs
import { analyzeAction } from '../server/analyze.mjs'
import { shred } from '../server/sql.mjs'

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

let seq = 0
function call({ req, sql, params = [], ms = 2, site = 'Svc.Method', line = 10 }) {
  const id = `q${++seq}`
  const c = {
    id,
    seq,
    ts: 1000 + seq,
    durationMs: ms,
    rowsAffected: -1,
    rowsRead: -1,
    app: 'Shop.OrdersApi',
    reqId: req,
    handler: req,
    stack: [{ m: site, f: 'Core\\X.cs', l: line }],
  }
  c.sql = sql
  c.params = params
  c.statements = shred(sql, params).statements
  return c
}

// ---------------------------------------------------------------------------
// One user action, two HTTP requests, each with its own DbContext scope.
//   - org settings + contract loaded once per request  -> across requests
//   - a lot re-read twice inside request 1             -> in request
//   - an N+1 over 5 posts inside request 2             -> in request
//   - the same post row updated twice                  -> writes
const A = 'ui-award'
const settings = 'SELECT [s].[Id], [s].[Val] FROM [TenantSettings] AS [s] WHERE [s].[CrmId] = @p0'
const contract = 'SELECT [c].[Id] FROM [Orders] AS [c] WHERE [c].[Id] = @p0'
const lot = 'SELECT [l].[Id] FROM [Shipments] AS [l] WHERE [l].[Id] = @p0'
const post = 'SELECT [p].[Id] FROM [OrderLines] AS [p] WHERE [p].[Id] = @p0'
const update = 'UPDATE [OrderLines] SET [Qty] = @p0 WHERE [Id] = @p1'

const calls = [
  // request 1
  call({ req: 'r1', sql: settings, params: [{ n: '@p0', v: 'crm-1' }] }),
  call({ req: 'r1', sql: contract, params: [{ n: '@p0', v: 'c-1' }] }),
  call({ req: 'r1', sql: lot, params: [{ n: '@p0', v: 'l-1' }] }),
  call({ req: 'r1', sql: lot, params: [{ n: '@p0', v: 'l-1' }] }), // <- in-request repeat
  // request 2
  call({ req: 'r2', sql: settings, params: [{ n: '@p0', v: 'crm-1' }] }), // <- across
  call({ req: 'r2', sql: contract, params: [{ n: '@p0', v: 'c-1' }] }), // <- across
  ...[1, 2, 3, 4, 5].map((i) =>
    call({ req: 'r2', sql: post, params: [{ n: '@p0', v: `p-${i}` }], site: 'Svc.Loop' }),
  ), // <- N+1, 4 avoidable
  call({ req: 'r2', sql: update, params: [{ n: '@p0', v: '1' }, { n: '@p1', v: 'p-1' }], site: 'Svc.SaveA' }),
  call({ req: 'r2', sql: update, params: [{ n: '@p0', v: '2' }, { n: '@p1', v: 'p-1' }], site: 'Svc.SaveB' }), // <- same row twice
]

const a = analyzeAction({
  id: A,
  label: 'Award',
  kind: 'click',
  startedAt: 1000,
  endedAt: 2000,
  calls,
  requests: [{ id: 'r1' }, { id: 'r2' }],
  saveChanges: [],
})

console.log(
  `\ntotal ${a.total} | inRequest ${a.avoidableInRequest} | across ${a.avoidableAcrossRequests} ` +
    `| writes ${a.avoidableWrites} | avoidable ${a.avoidable} | projected ${a.projected} | floor ${a.floor}\n`,
)

check(a.total === 13, 'counts every statement (4 in request 1, 9 in request 2)', `got ${a.total}`)
check(a.avoidableInRequest === 5, 'in-request waste = 1 repeat + 4 from the N+1', `got ${a.avoidableInRequest}`)
check(a.avoidableAcrossRequests === 2, 'settings + contract once per request are across-request', `got ${a.avoidableAcrossRequests}`)
check(a.avoidableWrites === 1, 'the row written twice is a write saving', `got ${a.avoidableWrites}`)

// The headline must exclude the architectural ones.
check(a.avoidable === a.avoidableInRequest + a.avoidableWrites, 'avoidable = inRequest + writes', `got ${a.avoidable}`)
check(a.avoidable === 6, 'headline avoidable does not include across-request', `got ${a.avoidable}`)
check(a.projected === a.total - a.avoidable, 'projected = total - avoidable', `got ${a.projected}`)
check(a.floor === a.total - a.avoidable - a.avoidableAcrossRequests, 'floor = projected - across', `got ${a.floor}`)
check(a.reducible === Math.round((a.avoidable / a.total) * 100), 'reducible = avoidable / total', `got ${a.reducible}`)

// Every group's savings must add back up to the action totals.
const sum = (f) => a.groups.reduce((s, g) => s + g[f], 0)
check(sum('avoidableInRequest') === a.avoidableInRequest, 'group in-request savings sum to the action total')
check(sum('avoidableAcrossRequests') === a.avoidableAcrossRequests, 'group across savings sum to the action total')

// Cross-request repetition alone must not be reported as high severity.
const settingsGroup = a.groups.find((g) => g.table === 'TenantSettings')
check(settingsGroup?.level === 'med', 'once-per-request load is amber, not red', `got ${settingsGroup?.level}`)
check(
  settingsGroup?.findings.every((f) => f.bucket !== 'inRequest'),
  'once-per-request load is not counted as in-request waste',
)

// ---------------------------------------------------------------------------
// The SQL shapes that previously produced a group with no table name.
const shapes = [
  ["EXEC sp_executesql N'SELECT [c].[Id] FROM [Orders] AS [c] WHERE [c].[Id] = @p', N'@p uniqueidentifier', @p='x'", 'Orders'],
  ['SELECT [t].[Id] FROM (SELECT [x].[Id] FROM [OrderLines] AS [x]) AS [t]', 'OrderLines'],
  ['WITH [cte] AS (SELECT [l].[Id] FROM [Shipments] AS [l]) SELECT * FROM [cte]', 'Shipments'],
]

for (const [sql, expected] of shapes) {
  const { statements } = shred(sql, [])
  const table = statements[0]?.table
  check(table === expected, `table parsed from ${sql.slice(0, 42)}…`, `got ${table}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
