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

function sql({
  action,
  label,
  req,
  handler,
  path,
  sqlText,
  params = [],
  ms = 4,
  rows,
  affected,
  app = API,
  stack: frames = [],
  // What the data-access layer reports the command was. These are the values a
  // real recording carries, and they decide how the statement is judged.
  source = 'LinqQuery',
}) {
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
    exec: source === 'BulkUpdate' ? 'ExecuteNonQuery' : 'ExecuteReader',
    source,
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

// The order comes back with its tenant's settings in the same query: one round-trip, two tables.
const readOrder =
  'SELECT [o].[Id], [o].[Reference], [o].[TenantId], [t].[Id], [t].[Currency], [t].[RoundingMode] ' +
  'FROM [Orders] AS [o] LEFT JOIN [TenantSettings] AS [t] ON [t].[TenantId] = [o].[TenantId] WHERE [o].[Id] = @__id_0'

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
    source: 'SaveChanges',
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

// -------------------------------------------------------------------- action 4
// A loop inside a loop. Three orders, four shipments each, one query per
// shipment: twelve calls today, and twelve is 3 x 4 rather than a constant. This
// is what the growth badges are for - the count follows the data, so the
// recording only shows what today's data costs.

const A4 = 'ui-order-tree'
const L4 = 'Open order tree'

push({ kind: 'req', id: 'r4', app: API, pid: 1234, ts: tick(500), method: 'GET', path: '/api/Orders/Tree', actionId: A4, actionLabel: L4 })

const tree = (sqlText, params, frames, rows) =>
  sql({ action: A4, label: L4, req: 'r4', handler: 'OrdersController.Tree', sqlText, params, ms: 3, rows, stack: frames })

tree(
  'SELECT [o].[Id], [o].[Reference] FROM [Orders] AS [o] WHERE [o].[TenantId] = @__tenant_0',
  [{ n: '@__tenant_0', v: 'TENANT-1' }],
  stack(
    ['OrderRepository.GetForTenant', `${REPO}\\OrderRepository.cs`, 51],
    ['OrderTreeService.Build', `${SERVICES}\\OrderTreeService.cs`, 24],
  ),
  4, // three rows, plus the read that finds the end of the set
)

for (let o = 0; o < 3; o++) {
  tree(
    'SELECT [s].[Id], [s].[Carrier] FROM [Shipments] AS [s] WHERE [s].[OrderId] = @__orderId_0',
    [{ n: '@__orderId_0', v: `ORDER-${o}` }],
    stack(
      ['ShipmentRepository.GetByOrder', `${REPO}\\ShipmentRepository.cs`, 64],
      ['OrderTreeService.AddShipments', `${SERVICES}\\OrderTreeService.cs`, 39],
    ),
    5, // four shipments each
  )
}

for (let s = 0; s < 12; s++) {
  tree(
    'SELECT [l].[Id], [l].[Quantity] FROM [OrderLines] AS [l] WHERE [l].[ShipmentId] = @__shipmentId_0',
    [{ n: '@__shipmentId_0', v: `SHIPMENT-${s}` }],
    stack(
      ['OrderLineRepository.GetByShipment', `${REPO}\\OrderLineRepository.cs`, 77],
      ['OrderTreeService.AddLines', `${SERVICES}\\OrderTreeService.cs`, 58],
    ),
    3,
  )
}

push({ kind: 'reqend', id: 'r4', ts: tick(), durationMs: 95, status: 200, handler: 'OrdersController.Tree' })

// -------------------------------------------------------------------- action 5
// Schema work, which is real database traffic but not something a flow can be
// blamed for. It has to be visible and out of the counts, not silently dropped.

const A5 = 'ui-first-click'
const L5 = 'First click after start-up'

push({ kind: 'req', id: 'r5', app: API, pid: 1234, ts: tick(500), method: 'GET', path: '/api/Orders/Count', actionId: A5, actionLabel: L5 })
sql({
  action: A5,
  label: L5,
  req: 'r5',
  handler: 'OrdersController.Count',
  sqlText: 'SELECT [m].[MigrationId], [m].[ProductVersion] FROM [__SchemaHistory] AS [m] ORDER BY [m].[MigrationId]',
  ms: 22,
  rows: 9,
  source: 'Migrations',
  stack: stack(['SchemaMigrator.Apply', `${REPO}\\SchemaMigrator.cs`, 18]),
})
sql({
  action: A5,
  label: L5,
  req: 'r5',
  handler: 'OrdersController.Count',
  sqlText: 'SELECT COUNT(*) FROM [Orders] AS [o] WHERE [o].[TenantId] = @__tenant_0',
  params: [{ n: '@__tenant_0', v: 'TENANT-1' }],
  ms: 6,
  rows: 1,
  stack: stack(['OrderRepository.CountFor', `${REPO}\\OrderRepository.cs`, 96]),
})
push({ kind: 'reqend', id: 'r5', ts: tick(), durationMs: 40, status: 200, handler: 'OrdersController.Count' })

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
