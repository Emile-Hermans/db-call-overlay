// Regression tests for three ways the analyzer used to be wrong. Each case is
// modelled on a real recording.
//   node tools/attribution-test.mjs
import { analyzeAction } from '../server/analyze.mjs'
import { shred } from '../server/sql.mjs'

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

let seq = 0
const call = ({ sql, params = [], stack = [], ms = 5, req = 'r1' }) => {
  const id = `q${++seq}`
  const c = { id, seq, ts: 1000 + seq, durationMs: ms, rowsAffected: -1, rowsRead: -1, app: 'Shop.OrdersApi', reqId: req, handler: req, stack }
  c.sql = sql
  c.params = params
  c.statements = shred(sql, params).statements
  return c
}
const frame = (m, l) => ({ m, f: 'src\\Shop.Data\\X.cs', l })

const run = (calls, saveChanges = []) =>
  analyzeAction({ id: 'a', label: 'Flow', kind: 'click', startedAt: 1000, endedAt: 2000, calls, requests: [{ id: 'r1' }], saveChanges })

// ---------------------------------------------------------------------------
console.log('\n1. A batch whose later statements lost their parameters\n')
{
  // Only the first statement's parameters fit inside the capture limit.
  const statements = Array.from({ length: 20 }, (_, i) => `UPDATE [OrderLines] SET [Qty] = @p${i} WHERE [Id] = @k${i};SELECT @@ROWCOUNT;`).join('')
  const a = run([
    call({
      sql: `SET NOCOUNT ON;${statements}`,
      params: [{ n: '@p0', v: '1' }, { n: '@k0', v: 'row-1' }],
      stack: [frame('Repo.SaveAll', 10), frame('OrderService.Persist', 20)],
    }),
  ])

  check(a.avoidableWrites === 0, 'statements with no captured parameters are not counted as duplicate writes', `got ${a.avoidableWrites}`)
  const dup = a.groups.flatMap((g) => g.findings).find((f) => f.code === 'duplicate-write')
  check(!dup, 'no duplicate-write finding is invented', dup?.title ?? '')
}

// ---------------------------------------------------------------------------
console.log('\n2. A stack that is really an async continuation remnant\n')
{
  // Reads that establish Repo.Get as data-access plumbing.
  const reads = ['Customers', 'Orders', 'Shipments'].map((t) =>
    call({ sql: `SELECT [x].[Id] FROM [${t}] AS [x] WHERE [x].[Id] = @p0`, params: [{ n: '@p0', v: '1' }], stack: [frame('Repo.Get', 5), frame('Svc.Load', 9)] }),
  )

  // The write's stack is the mirror image: data access at the TAIL, not the head.
  const write = call({
    sql: 'UPDATE [OrderLines] SET [Qty] = @p0 WHERE [Id] = @p1',
    params: [{ n: '@p0', v: '2' }, { n: '@p1', v: 'row-9' }],
    stack: [frame('BeforeSave.Hook', 87), frame('Globals.UserId', 183), frame('Repo.Get', 6)],
  })

  const a = run([...reads, write])
  const g = a.groups.find((x) => x.op === 'UPDATE')
  check(g.callsite === null, 'a continuation remnant yields no call site rather than a wrong one', `got ${g.callsite?.method}`)

  // And a genuine stack, data access at the head, still resolves. Repo.Save has
  // to carry several different writes before it looks like plumbing, exactly as
  // it would in a real recording.
  const saves = ['Customers', 'Orders', 'Shipments'].map((t, i) =>
    call({
      sql: `UPDATE [${t}] SET [Note] = @p0 WHERE [Id] = @p1`,
      params: [{ n: '@p0', v: 'x' }, { n: '@p1', v: `k${i}` }],
      stack: [frame('Repo.Save', 40), frame('Svc.Touch', 30)],
    }),
  )
  const b = run([...reads, ...saves, call({
    sql: 'UPDATE [OrderLines] SET [Qty] = @p0 WHERE [Id] = @p1',
    params: [{ n: '@p0', v: '2' }, { n: '@p1', v: 'row-9' }],
    stack: [frame('Repo.Save', 40), frame('OrderService.Recalculate', 120)],
  })])
  const bg = b.groups.find((x) => x.table === 'OrderLines')
  check(bg.callsite?.method === 'OrderService.Recalculate', 'a real stack still names the caller', `got ${bg.callsite?.method}`)
  check(bg.callsite?.innermost === 'Repo.Save', 'and still records the frame that issued it', `got ${bg.callsite?.innermost}`)
}

// ---------------------------------------------------------------------------
console.log('\n3. The same row written by several passes, each setting different columns\n')
{
  const row = [{ n: '@p0', v: '9' }, { n: '@k', v: 'row-7' }]
  const a = run(
    [
      call({ sql: 'UPDATE [Shipments] SET [TotalOffers] = @p0 WHERE [Id] = @k', params: row, stack: [frame('Repo.Save', 40), frame('Lots.CalculateOffers', 4696)] }),
      call({ sql: 'UPDATE [Shipments] SET [AwardExclVat] = @p0 WHERE [Id] = @k', params: row, stack: [frame('Repo.Save', 40), frame('Calc.Award', 818)] }),
      call({ sql: 'UPDATE [Shipments] SET [TotalExpected] = @p0 WHERE [Id] = @k', params: row, stack: [frame('Repo.Save', 40), frame('Calc.Exec', 1612)] }),
    ],
    [{ ts: 1, entities: 1 }, { ts: 2, entities: 1 }, { ts: 3, entities: 1 }],
  )

  const dup = a.findings.find((f) => f.code === 'duplicate-row-write')
  const unbatched = a.findings.find((f) => f.code === 'unbatched-save')

  check(!dup, 'writes that set different columns are NOT called redundant', dup?.title ?? '')
  check(Boolean(unbatched), 'they are reported as an un-batched save instead')
  check(a.avoidableWrites === 0, 'and cost no statements', `got ${a.avoidableWrites}`)
  check(a.roundTripSavings >= 2, 'the saving is counted in round-trips', `got ${a.roundTripSavings}`)

  // The genuine case must still fire: same row, same columns.
  const b = run([
    call({ sql: 'UPDATE [Shipments] SET [Total] = @p0 WHERE [Id] = @k', params: row, stack: [frame('Repo.Save', 40), frame('A.One', 1)] }),
    call({ sql: 'UPDATE [Shipments] SET [Total] = @p0 WHERE [Id] = @k', params: row, stack: [frame('Repo.Save', 40), frame('B.Two', 2)] }),
  ])
  check(b.avoidableWrites === 1, 'the same columns written twice is still redundant', `got ${b.avoidableWrites}`)
}

// ---------------------------------------------------------------------------
console.log('\n4. Group times must not exceed the flow time\n')
{
  const a = run([
    call({
      sql: 'UPDATE [A] SET [X] = @p0 WHERE [Id] = @k0;UPDATE [B] SET [Y] = @p1 WHERE [Id] = @k1;',
      params: [{ n: '@p0', v: '1' }, { n: '@k0', v: 'a' }, { n: '@p1', v: '2' }, { n: '@k1', v: 'b' }],
      ms: 100,
      stack: [frame('Repo.Save', 1)],
    }),
  ])
  const sum = a.groups.reduce((s, g) => s + g.totalMs, 0)
  check(Math.round(sum) <= a.totalMs, 'group durations sum to no more than the flow duration', `groups ${Math.round(sum)} vs flow ${a.totalMs}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
