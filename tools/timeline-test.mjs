// Checks the "where did the time go" breakdown, the verdict, the fix-first list
// and the static loop report matching.
//   node tools/timeline-test.mjs
import { analyzeAction } from '../server/analyze.mjs'
import { unionMs } from '../server/timeline.mjs'
import { parseLoopReport, LoopIndex } from '../server/loops.mjs'
import { shred } from '../server/sql.mjs'

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

let seq = 0
function call({ req, sql, params = [], ms = 2, at, site = 'OrderService.Recalculate', file = 'src\\Shop.Orders\\Services\\OrderService.cs', line = 40, afterResponse = false }) {
  const id = `q${++seq}`
  return {
    id,
    seq,
    ts: at,
    durationMs: ms,
    rowsAffected: -1,
    rowsRead: -1,
    app: 'Shop.OrdersApi',
    reqId: req,
    handler: 'OrdersController.Recalculate',
    afterResponse,
    stack: [
      { m: site, f: file, l: line, a: `C:\\work\\shop\\${file}` },
      { m: 'OrdersController.Recalculate', f: 'src\\Shop.OrdersApi\\Controllers\\OrdersController.cs', l: 22 },
    ],
    sql,
    params,
    statements: shred(sql, params).statements,
  }
}

// ---------------------------------------------------------------- unionMs
check(unionMs([[0, 10], [5, 15], [20, 30]]) === 25, 'overlapping intervals are counted once')
check(unionMs([]) === 0, 'no intervals is zero')

// ---------------------------------------------------------------- a DB-bound click
// One request of 500 ms, of which 400 ms is an N+1 over quotes: 40 lookups of 10 ms.
const quote = 'SELECT [q].[Id], [q].[Price] FROM [Quotes] AS [q] WHERE [q].[OrderLineId] = @p0'
const order = 'SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[Id] = @p0'

const dbBound = {
  id: 'ui-recalc',
  label: 'Recalculate order',
  startedAt: 1000,
  endedAt: 1500,
  requests: [{ id: 'r1', app: 'Shop.OrdersApi', method: 'POST', path: '/api/Orders/Recalculate', startedAt: 1000, durationMs: 500, status: 200, handler: 'OrdersController.Recalculate' }],
  calls: [
    call({ req: 'r1', sql: order, params: [{ n: '@p0', v: 'o-1' }], at: 1010, ms: 5, site: 'OrderRepository.GetById', file: 'src\\Shop.Data\\Repositories\\OrderRepository.cs', line: 12 }),
    ...Array.from({ length: 40 }, (_, i) =>
      call({ req: 'r1', sql: quote, params: [{ n: '@p0', v: `l-${i}` }], at: 1050 + i * 10, ms: 10, line: 61 }),
    ),
  ],
}

const a = analyzeAction(dbBound)
const t = a.time

check(t.wallMs === 500, 'wall time spans the request', `got ${t.wallMs}`)
check(t.serverMs === 500, 'server time is the request window', `got ${t.serverMs}`)
check(t.dbMs === 405, 'database time is the union of the queries', `got ${t.dbMs}`)
check(t.appMs === 95, 'app time is server time minus database time', `got ${t.appMs}`)
check(t.verdict.kind === 'db', 'a click spending 81% in SQL is database-bound', `got ${t.verdict.kind}`)
check(t.requests.length === 1 && t.requests[0].calls === 41, 'the request carries its own call count')
check(t.spans.length === 41, 'every round-trip is a span on the waterfall')
check(t.spans.every((s) => s.offsetMs >= 0 && s.offsetMs <= t.wallMs), 'spans sit inside the click window')

const top = t.fixFirst[0]
check(Boolean(top) && top.table === 'Quotes', 'the N+1 is the first thing to fix', JSON.stringify(top))
check(top?.savedMs === 390, 'its estimated saving is the removable lookups times their average', `got ${top?.savedMs}`)
check(a.staticLoops === 0, 'no loop report, no static matches')

// ---------------------------------------------------------------- an app-bound click
// 900 ms request, one 20 ms query: removing queries will not help.
const appBound = {
  id: 'ui-export',
  label: 'Export orders',
  startedAt: 5000,
  endedAt: 5900,
  requests: [{ id: 'r9', app: 'Shop.OrdersApi', method: 'GET', path: '/api/Orders/Export', startedAt: 5000, durationMs: 900, status: 200 }],
  calls: [call({ req: 'r9', sql: order, params: [{ n: '@p0', v: 'o-2' }], at: 5100, ms: 20 })],
}
const b = analyzeAction(appBound).time
check(b.verdict.kind === 'app', 'a click spending 2% in SQL is application-bound', `got ${b.verdict.kind}`)
check(b.appMs === 880, 'app time is what is left', `got ${b.appMs}`)

// ---------------------------------------------------------------- after the response
// A write after the response does not stretch the click or count as waited.
const late = {
  id: 'ui-late',
  label: 'Save order',
  startedAt: 9000,
  requests: [{ id: 'r5', startedAt: 9000, durationMs: 200, status: 200 }],
  calls: [
    call({ req: 'r5', sql: order, params: [{ n: '@p0', v: 'o-3' }], at: 9050, ms: 100 }),
    call({ req: 'r5', sql: 'UPDATE [Orders] SET [Total] = @p0 WHERE [Id] = @p1', params: [{ n: '@p0', v: '1' }, { n: '@p1', v: 'o-3' }], at: 9300, ms: 400, afterResponse: true }),
  ],
}
const c = analyzeAction(late).time
check(c.wallMs === 200, 'work after the response does not lengthen the click', `got ${c.wallMs}`)
check(c.dbMs === 100, 'and is not counted as database time the user waited for', `got ${c.dbMs}`)

// ---------------------------------------------------------------- sequential requests
const chained = {
  id: 'ui-chain',
  label: 'Open order',
  startedAt: 0,
  requests: [
    { id: 'a', startedAt: 0, durationMs: 100, status: 200 },
    { id: 'b', startedAt: 150, durationMs: 100, status: 200 },
    { id: 'c', startedAt: 260, durationMs: 100, status: 200 },
  ],
  calls: [],
}
const d = analyzeAction(chained).time
check(d.sequential === 2, 'requests that wait for each other are counted', `got ${d.sequential}`)
check(d.serverMs === 300 && d.wallMs === 360, 'gaps between requests are not server time', `${d.serverMs}/${d.wallMs}`)

// ---------------------------------------------------------------- unknown end
const open = { id: 'x', label: 'x', startedAt: 0, requests: [{ id: 'r', startedAt: 0 }], calls: [call({ req: 'r', sql: order, at: 10, ms: 300 })] }
check(analyzeAction(open).time.verdict.kind === 'unknown', 'a request without an end gives no split')

// ---------------------------------------------------------------- loop report: findings list
const report = {
  findings: [
    {
      file: 'src/Shop.Orders/Services/OrderService.cs',
      line: 61,
      method: 'OrderService.Recalculate(Guid)',
      loops: [{ kind: 'foreach', header: 'foreach (var line in order.Lines)', line: 58 }],
      call: '_quotes.GetByOrderLine(line.Id)',
      chain: 'QuoteRepository.GetByOrderLine(Guid)',
      accessKind: 'Read',
      suppressed: false,
    },
    { file: 'src/Shop.Orders/Services/OrderService.cs', line: 90, method: 'OrderService.Ignored()', loops: [], suppressed: true },
  ],
}
const parsed = parseLoopReport(JSON.stringify(report))
check(parsed.length === 1, 'suppressed findings are dropped')

const index = new LoopIndex(parsed)
const withLoops = analyzeAction(dbBound, { ...(await import('../server/analyze.mjs')).DEFAULTS, loops: index })
const quotes = withLoops.groups.find((g) => g.table === 'Quotes')
check(quotes.staticLoop?.confidence === 'exact', 'the N+1 lands on the flagged call site', JSON.stringify(quotes.staticLoop))
check(quotes.findings.some((f) => f.code === 'static-loop' && f.title.includes('OrderService.cs:61')), 'and says which line')
check(withLoops.staticLoops === 1, 'the flow counts its statically confirmed loops')
check(withLoops.avoidable === a.avoidable, 'a static match never changes the removable count')
check(withLoops.time.fixFirst[0].inLoop?.line === 61, 'the fix list carries the loop location')

// A report made from another commit: same method, different line.
const drifted = new LoopIndex(parseLoopReport(JSON.stringify({ findings: [{ ...report.findings[0], line: 64 }] })))
const lead = analyzeAction(dbBound, { ...(await import('../server/analyze.mjs')).DEFAULTS, loops: drifted }).groups.find((g) => g.table === 'Quotes')
check(lead.staticLoop?.confidence === 'method', 'a line drift degrades to a method-level lead', JSON.stringify(lead.staticLoop))

// ---------------------------------------------------------------- loop report: SARIF
const sarif = {
  version: '2.1.0',
  runs: [
    {
      results: [
        {
          ruleId: 'DBLOOP001',
          message: { text: 'Database call inside a loop' },
          locations: [
            {
              physicalLocation: { artifactLocation: { uri: 'file:///C:/work/shop/src/Shop.Orders/Services/OrderService.cs' }, region: { startLine: 61 } },
              logicalLocations: [{ fullyQualifiedName: 'Shop.Orders.Services.OrderService.Recalculate' }],
            },
          ],
        },
      ],
    },
  ],
}
const fromSarif = parseLoopReport(JSON.stringify(sarif))
check(fromSarif.length === 1 && fromSarif[0].line === 61, 'SARIF results are read')
const sarifHit = new LoopIndex(fromSarif).match(dbBound.calls[1].stack)
check(sarifHit?.confidence === 'exact', 'and match a recorded frame by file tail and line')

let threw = false
try {
  parseLoopReport('{"hello": 1}')
} catch {
  threw = true
}
check(threw, 'an unrelated JSON file is refused with an error')

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
