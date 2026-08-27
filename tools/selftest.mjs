// Replays a synthetic user action into the collector so the rules and the UI can
// be checked without a real application. The data is made up.
//   node tools/selftest.mjs [ingest port]

import net from 'node:net'

const PORT = Number(process.argv[2] ?? 8477)
const socket = net.connect(PORT, '127.0.0.1')

const API = 'Shop.OrdersApi'
const DB = 'ShopDb'
const REPO = 'src\\Shop.Data\\Repositories'
const SERVICES = 'src\\Shop.Orders\\Services'
const CONTROLLERS = 'src\\Shop.OrdersApi\\Controllers'

let seq = 0
const lines = []
const push = (event) => lines.push(JSON.stringify(event))
const stack = (...frames) => frames.map(([m, f, l]) => ({ m, f, l }))

let clock = Date.now()
const tick = (n = 3) => (clock += n)

function sql({ action, label, req, handler, path, sqlText, params = [], ms = 4, rows, affected, app = API, stack: frames = [] }) {
  const id = `q-${++seq}`
  push({
    kind: 'sql',
    id,
    app,
    pid: 1234,
    ts: tick(),
    durationMs: ms,
    rowsAffected: affected ?? -1,
    sql: sqlText,
    params,
    stack: frames,
    db: DB,
    exec: 'ExecuteReader',
    source: 'Linq',
    reqId: req,
    actionId: action,
    actionLabel: label,
    handler,
    path,
    httpMethod: 'POST',
    commandId: id,
  })
  if (rows !== undefined) push({ kind: 'sqlrows', commandId: id, rowsRead: rows })
}

const orderId = 'C4F1B2A0-0000-0000-0000-000000000001'

// -------------------------------------------------------------------- action 1
// "Recalculate order": every line saved twice, an N+1 over quotes, and the order
// row read a second time for no reason.

const A1 = 'ui-recalculate'
const L1 = 'Recalculate order'

push({ kind: 'hello', app: API, pid: 1234, ts: clock })
push({
  kind: 'req',
  id: 'r1',
  app: API,
  pid: 1234,
  ts: tick(),
  method: 'POST',
  path: '/api/Orders/Recalculate',
  actionId: A1,
  actionLabel: L1,
})

const readOrder = 'SELECT [o].[Id], [o].[Reference], [o].[TenantId] FROM [Orders] AS [o] WHERE [o].[Id] = @__id_0'

sql({
  action: A1,
  label: L1,
  req: 'r1',
  handler: 'OrdersController.Recalculate',
  path: '/api/Orders/Recalculate',
  sqlText: readOrder,
  params: [{ n: '@__id_0', v: orderId }],
  ms: 9,
  rows: 1,
  stack: stack(
    ['OrderRepository.GetById', `${REPO}\\OrderRepository.cs`, 88],
    ['OrderService.Recalculate', `${SERVICES}\\OrderService.cs`, 61],
    ['OrdersController.Recalculate', `${CONTROLLERS}\\OrdersController.cs`, 142],
  ),
})

// the same order row, read again later in the same request
sql({
  action: A1,
  label: L1,
  req: 'r1',
  handler: 'OrdersController.Recalculate',
  sqlText: readOrder,
  params: [{ n: '@__id_0', v: orderId }],
  ms: 3,
  rows: 1,
  stack: stack(
    ['OrderRepository.GetById', `${REPO}\\OrderRepository.cs`, 88],
    ['OrderService.UpdateTotals', `${SERVICES}\\OrderService.cs`, 210],
  ),
})

// N+1: one quote lookup per order line
for (let i = 0; i < 50; i++) {
  sql({
    action: A1,
    label: L1,
    req: 'r1',
    handler: 'OrdersController.Recalculate',
    sqlText: 'SELECT TOP(1) [q].[Id], [q].[OrderLineId], [q].[Price] FROM [Quotes] AS [q] WHERE [q].[OrderLineId] = @__lineId_0',
    params: [{ n: '@__lineId_0', v: `LINE-${i}` }],
    ms: 2,
    rows: 1,
    stack: stack(
      ['QuoteRepository.GetByOrderLine', `${REPO}\\QuoteRepository.cs`, 133],
      ['OrderService.ClearQuotes', `${SERVICES}\\OrderService.cs`, 118],
    ),
  })
}

// every line written twice, in two batched round-trips from two different methods
for (const pass of [1, 2]) {
  const statements = []
  const params = []
  for (let i = 0; i < 50; i++) {
    statements.push(
      `UPDATE [OrderLines] SET [IsConfirmed] = @p${i * 2}, [Quantity] = @p${i * 2 + 1} WHERE [Id] = @p${i * 2 + 100};\nSELECT @@ROWCOUNT;`,
    )
    params.push({ n: `@p${i * 2}`, v: '0' }, { n: `@p${i * 2 + 1}`, v: '0' })
  }
  for (let i = 0; i < 50; i++) params.push({ n: `@p${i * 2 + 100}`, v: `LINE-${i}` })

  sql({
    action: A1,
    label: L1,
    req: 'r1',
    handler: 'OrdersController.Recalculate',
    sqlText: `SET NOCOUNT ON;\n${statements.join('\n')}`,
    params,
    ms: 130,
    affected: 50,
    stack: stack(
      ['OrderLineRepository.SaveAll', `${REPO}\\OrderLineRepository.cs`, 402],
      [`OrderService.${pass === 1 ? 'ResetTotals' : 'PersistTotals'}`, `${SERVICES}\\OrderService.cs`, pass === 1 ? 152 : 231],
    ),
  })
  push({ kind: 'savechanges', app: API, ts: tick(), entities: 50, actionId: A1, actionLabel: L1, stack: [] })
}

push({ kind: 'reqend', id: 'r1', ts: tick(), durationMs: 480, status: 200, handler: 'OrdersController.Recalculate' })

// -------------------------------------------------------------------- action 2
// A clean action: one query, nothing to improve.

const A2 = 'ui-shipments'
const L2 = 'Open shipments tab'

push({ kind: 'req', id: 'r2', app: API, pid: 1234, ts: tick(500), method: 'GET', path: '/api/Shipments/List', actionId: A2, actionLabel: L2 })
sql({
  action: A2,
  label: L2,
  req: 'r2',
  handler: 'ShipmentsController.List',
  sqlText: 'SELECT [s].[Id], [s].[Carrier], [s].[Position] FROM [Shipments] AS [s] WHERE [s].[OrderId] = @__id_0 ORDER BY [s].[Position]',
  params: [{ n: '@__id_0', v: orderId }],
  ms: 11,
  rows: 12,
  stack: stack(['ShipmentRepository.GetByOrder', `${REPO}\\ShipmentRepository.cs`, 64]),
})
push({ kind: 'reqend', id: 'r2', ts: tick(), durationMs: 40, status: 200, handler: 'ShipmentsController.List' })

// -------------------------------------------------------------------- action 3
// Slow and unfiltered - amber, not red.

const A3 = 'ui-order-form'
const L3 = 'Open order form'

push({ kind: 'req', id: 'r3', app: 'Shop.CatalogApi', pid: 1235, ts: tick(500), method: 'GET', path: '/api/Lookups/All', actionId: A3, actionLabel: L3 })
sql({
  action: A3,
  label: L3,
  req: 'r3',
  app: 'Shop.CatalogApi',
  handler: 'LookupsController.All',
  sqlText: 'SELECT ' + Array.from({ length: 34 }, (_, i) => `[l].[Col${i}]`).join(', ') + ' FROM [Lookups] AS [l]',
  ms: 340,
  rows: 4200,
  stack: stack(['LookupRepository.GetAll', `${REPO}\\LookupRepository.cs`, 41]),
})
push({ kind: 'reqend', id: 'r3', ts: tick(), durationMs: 360, status: 200, handler: 'LookupsController.All' })

socket.on('connect', () => {
  socket.write(lines.join('\n') + '\n')
  setTimeout(() => {
    socket.end()
    console.log(`sent ${lines.length} events to 127.0.0.1:${PORT}`)
  }, 300)
})

socket.on('error', (err) => {
  console.error(`could not reach the collector on ${PORT}: ${err.message}`)
  process.exit(1)
})
