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
function call({ req, sql, params = [], ms = 2, site = 'Svc.Method', line = 10, at, isAsync, afterResponse }) {
  const id = `q${++seq}`
  const c = {
    id,
    seq,
    ts: at ?? 1000 + seq,
    durationMs: ms,
    rowsAffected: -1,
    rowsRead: -1,
    app: 'Shop.OrdersApi',
    reqId: req,
    handler: req,
    isAsync: isAsync ?? null,
    afterResponse: afterResponse ?? false,
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

// ---------------------------------------------------------------------------
// Two ways an execution can carry no parameter values, which mean opposite things.
const alone = (calls, label) =>
  analyzeAction({ id: label, label, kind: 'click', startedAt: 1000, endedAt: 2000, calls, requests: [{ id: 'r1' }], saveChanges: [] })

// 1. The keys were folded into the SQL as literals. Four different rows, read
//    once each - normalising the shape must not make them look like one row.
{
  const inlined = alone(
    [1, 2, 3, 4].map((i) =>
      call({ req: 'r1', sql: `SELECT [l].[Id], [l].[Qty] FROM [OrderLines] AS [l] WHERE [l].[Id] = ${i}`, site: 'Svc.Loop' }),
    ),
    'inlined',
  )
  const g = inlined.groups[0]
  check(g?.distinctParams === 4, 'inlined literals count as four distinct executions', `got ${g?.distinctParams}`)
  check(
    !g?.findings.some((f) => f.code === 'identical-repeat'),
    'four different rows are not reported as the same query repeated',
  )
  // The count is the same either way; what changes is which fix it points at.
  // "Reuse the result you already have" is wrong advice here - there is no
  // earlier result to reuse, there are four separate rows to load in one query.
  check(g?.findings.some((f) => f.code === 'n-plus-one'), 'it is recognised as the N+1 it actually is')
  check(
    g?.findings.find((f) => f.code === 'n-plus-one')?.avoidable === 3,
    'three of the four lookups are removable by loading the set at once',
    `got ${g?.findings.find((f) => f.code === 'n-plus-one')?.avoidable}`,
  )
  check(inlined.avoidableInRequest === 3, 'and that is the whole in-request saving', `got ${inlined.avoidableInRequest}`)
}

// 2. A query with no parameters and no literals really is the same every time.
{
  const same = alone(
    [1, 2, 3].map(() => call({ req: 'r1', sql: 'SELECT COUNT(*) FROM [OrderLines]', site: 'Svc.Count' })),
    'repeat',
  )
  check(same.avoidableInRequest === 2, 'a genuinely identical query is still counted as a repeat', `got ${same.avoidableInRequest}`)
}

// 3. The statement names parameters but none of their values were captured, so
//    nothing may be concluded either way.
{
  const uncaptured = alone(
    [1, 2, 3].map(() =>
      call({ req: 'r1', sql: 'SELECT [l].[Id] FROM [OrderLines] AS [l] WHERE [l].[Id] = @p0', params: [], site: 'Svc.Loop' }),
    ),
    'uncaptured',
  )
  check(
    uncaptured.avoidableInRequest === 0,
    'executions with no captured values are not assumed to be repeats',
    `got ${uncaptured.avoidableInRequest}`,
  )
  check(uncaptured.groups[0]?.unknownSigs === 3, 'they are reported as uncomparable instead', `got ${uncaptured.groups[0]?.unknownSigs}`)
}

// ---------------------------------------------------------------------------
// Awaited vs not: the response of request r1 goes out at 1000 + 50 = 1050 ms.
// A call is only claimed as "not waited for" when the timestamps prove it.
{
  const quotes = 'SELECT [q].[Id] FROM [Quotes] AS [q] WHERE [q].[Id] = @p0'
  const orders = 'SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[Id] = @p0'
  const settings = 'SELECT [s].[Id] FROM [TenantSettings] AS [s] WHERE [s].[CrmId] = @p0'
  const lines = 'SELECT [l].[Id] FROM [OrderLines] AS [l] WHERE [l].[Id] = @p0'
  const write = 'UPDATE [Lookups] SET [Val] = @p0 WHERE [Id] = @p1'
  const audit = 'INSERT INTO [Shipments] ([Id]) VALUES (@p0)'

  const t = analyzeAction({
    id: 'timing',
    label: 'Timing',
    kind: 'click',
    startedAt: 1000,
    endedAt: 2000,
    requests: [{ id: 'r1', startedAt: 1000, durationMs: 50 }],
    saveChanges: [],
    calls: [
      // Inside the window, done well before the response: waited.
      call({ req: 'r1', at: 1010, ms: 20, sql: quotes, params: [{ n: '@p0', v: 'q-1' }] }),
      // Still running 30 ms after the response went out: not waited for.
      call({ req: 'r1', at: 1040, ms: 40, sql: orders, params: [{ n: '@p0', v: 'o-1' }] }),
      // Ends 5 ms past the response - inside the rounding tolerance, so waited.
      call({ req: 'r1', at: 1030, ms: 25, sql: settings, params: [{ n: '@p0', v: 'crm-1' }] }),
      // Sync API inside the window.
      call({ req: 'r1', at: 1015, ms: 3, sql: lines, params: [{ n: '@p0', v: 'l-1' }], isAsync: false, site: 'Svc.Sync' }),
      // The probe's own flag beats the timestamps: the scope had already ended.
      call({ req: 'r1', at: 1020, ms: 2, sql: lines, params: [{ n: '@p0', v: 'l-2' }], afterResponse: true, site: 'Svc.Flag' }),
      // A write that started after the response: fire-and-forget.
      call({ req: 'r1', at: 1100, ms: 5, sql: write, params: [{ n: '@p0', v: '1' }, { n: '@p1', v: 'k-1' }] }),
      // No request at all: background, and deliberately NOT flagged as fire-and-forget.
      call({ req: null, at: 1200, ms: 7, sql: audit, params: [{ n: '@p0', v: 's-1' }] }),
    ],
  })

  const groupOf = (table, op = 'SELECT') => t.groups.find((g) => g.table === table && g.op === op)

  check(t.offMs === 40 + 2 + 5 + 7, 'offMs sums the durations the user never waited for', `got ${t.offMs}`)
  check(t.waitedMs === t.totalMs - t.offMs, 'waitedMs + offMs = totalMs', `got ${t.waitedMs} of ${t.totalMs}`)
  check(t.offCalls === 4, 'four statements were not waited for', `got ${t.offCalls}`)

  check(groupOf('Quotes')?.timing.waited === 1, 'a call inside the window is waited')
  check(groupOf('Orders')?.timing.afterResponse === 1, 'a call still running past the response is not waited for')
  check(groupOf('TenantSettings')?.timing.waited === 1, 'a call ending a hair past the response stays waited (tolerance)')
  check(
    t.groups.find((g) => g.callsite?.method === 'Svc.Flag')?.timing.afterResponse === 1,
    "the probe's afterResponse flag wins even when the timestamps look fine",
  )
  check(groupOf('Shipments', 'INSERT')?.timing.background === 1, 'a call with no request is background')

  const ff = groupOf('Lookups', 'UPDATE')?.findings.find((f) => f.code === 'fire-and-forget-write')
  check(Boolean(ff), 'a write after the response gets the fire-and-forget finding')
  check(ff?.level === 'med', 'fire-and-forget is a review, not red waste', `got ${ff?.level}`)
  check(
    !groupOf('Shipments', 'INSERT')?.findings.some((f) => f.code === 'fire-and-forget-write'),
    'a background write is not called fire-and-forget — it belongs to no response',
  )

  check(
    t.groups.find((g) => g.callsite?.method === 'Svc.Sync')?.findings.some((f) => f.code === 'sync-db-call'),
    'a call issued through the blocking API is noted',
  )
  check(
    !groupOf('Quotes')?.findings.some((f) => f.code === 'sync-db-call'),
    'a call with no async flag claims nothing about the API used',
  )

  // Executions carry the timing so the drill-down can mark the rows.
  check(
    groupOf('Lookups', 'UPDATE')?.executions[0]?.timing === 'afterResponse',
    'each execution reports its own timing',
  )
}

// Requests recorded before the request window existed carry no durations: every
// call must count as waited, exactly as before.
{
  const old = analyzeAction({
    id: 'old',
    label: 'Old flow',
    kind: 'click',
    startedAt: 1000,
    endedAt: 2000,
    requests: [{ id: 'r1' }],
    saveChanges: [],
    calls: [call({ req: 'r1', at: 999999, ms: 4, sql: 'SELECT [q].[Id] FROM [Quotes] AS [q] WHERE [q].[Id] = @p0', params: [{ n: '@p0', v: 'q' }] })],
  })
  check(old.offMs === 0, 'a request without an end time claims nothing', `got ${old.offMs}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
