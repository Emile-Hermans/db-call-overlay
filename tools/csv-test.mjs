// Checks the things that decide whether a CSV opens as a spreadsheet or as one
// unusable column, and that nothing in a recording can execute on open.
//   node tools/csv-test.mjs
import { toCsv, sessionCsv, flowCsv, callCsv, csvFileName, groupColumns } from '../server/csv.mjs'
import { analyzeAction, DEFAULTS } from '../server/analyze.mjs'
import { shred } from '../server/sql.mjs'

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const BOM = '﻿'
const one = (value) => toCsv([{ header: 'H', value: (r) => r.v }], [{ v: value }])
/** The data line of a single-cell sheet, past the BOM, sep= line and header. */
const cellOf = (value) => one(value).split('\r\n')[2]

/**
 * Reads a CSV line the way a spreadsheet does. Splitting on the delimiter would
 * be wrong for exactly the fields worth checking - SQL and findings can contain
 * one, which is why they are quoted in the first place.
 */
function fields(line) {
  const out = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ';') {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

// ---------------------------------------------------------------------------
// 1. The four things Excel needs.
{
  const csv = one('x')
  check(csv.startsWith(BOM), 'starts with a UTF-8 BOM, or Excel mangles every accented character')
  check(csv.slice(1).startsWith('sep=;\r\n'), 'declares its delimiter, so a comma-locale Excel opens it the same way')
  check(csv.includes('\r\n'), 'uses CRLF line endings')
  check(csv.endsWith('\r\n'), 'ends with a newline')

  const two = toCsv(
    [
      { header: 'A', value: (r) => r.a },
      { header: 'B', value: (r) => r.b },
    ],
    [{ a: 1, b: 2 }],
  )
  check(two.split('\r\n')[1] === 'A;B', 'separates columns with the declared delimiter', two.split('\r\n')[1])
}

// ---------------------------------------------------------------------------
// 2. Quoting.
{
  check(cellOf('a;b') === '"a;b"', 'a value containing the delimiter is quoted', cellOf('a;b'))
  check(cellOf('say "hi"') === '"say ""hi"""', 'embedded quotes are doubled', cellOf('say "hi"'))
  check(cellOf('plain') === 'plain', 'an ordinary value is not quoted needlessly', cellOf('plain'))
  check(cellOf(' padded ') === '" padded "', 'leading and trailing spaces are preserved by quoting', cellOf(' padded '))
  check(cellOf(null) === '' && cellOf(undefined) === '', 'nothing becomes an empty cell, not the word null')

  // A quoted field may legally hold a newline, but one row per row is far easier
  // to read - and a stray newline is what breaks a hand-written parser.
  const multi = one('line one\nline two')
  check(multi.split('\r\n').length === 4, 'a newline inside a value does not become a second row', String(multi.split('\r\n').length))
  check(cellOf('line one\nline two') === 'line one line two', 'it becomes a space instead')
}

// ---------------------------------------------------------------------------
// 3. Formula injection. Parameter values come out of a real database.
{
  check(cellOf('=1+1') === "'=1+1", 'a value starting with = cannot execute on open', cellOf('=1+1'))
  check(cellOf('+1') === "'+1", 'nor one starting with +', cellOf('+1'))
  check(cellOf('@SUM(A1)') === "'@SUM(A1)", 'nor one starting with @', cellOf('@SUM(A1)'))
  // This one also contains quotes, so it is quoted as well - the guard has to be
  // inside the quoting, not instead of it.
  const hyperlink = fields(cellOf('=HYPERLINK("http://evil.example","click")'))[0]
  check(hyperlink === '\'=HYPERLINK("http://evil.example","click")', 'the classic exfiltration formula is neutralised', hyperlink)

  // But a negative number is a number, and turning it into text would be the bug.
  check(cellOf('-1') === '-1', 'a negative number stays a number', cellOf('-1'))
  check(cellOf(-42) === '-42', 'including when it arrives as a number', cellOf(-42))
  check(cellOf('-cmd') === "'-cmd", 'while a leading dash on non-numeric text is still neutralised', cellOf('-cmd'))
}

// ---------------------------------------------------------------------------
// 4. Numbers are integers, so no locale can misread a decimal separator.
{
  const fixture = analyzeAction(
    {
      id: 'f',
      label: 'Flow',
      kind: 'click',
      startedAt: 1735000000000,
      endedAt: 1735000001000,
      calls: [
        {
          id: 'q1',
          seq: 1,
          ts: 1735000000000,
          durationMs: 12.3456,
          rowsAffected: -1,
          rowsRead: 4,
          app: 'Shop.OrdersApi',
          reqId: 'r1',
          handler: 'OrdersController.List',
          source: 'LinqQuery',
          stack: [{ m: 'OrderRepository.GetAll', f: 'src\\Shop.Data\\OrderRepository.cs', l: 20 }],
          sql: 'SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[Id] = @p0',
          params: [{ n: '@p0', v: 'o-1' }],
          statements: shred('SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[Id] = @p0', [{ n: '@p0', v: 'o-1' }]).statements,
        },
      ],
      requests: [{ id: 'r1' }],
      saveChanges: [],
    },
    DEFAULTS,
  )

  const csv = flowCsv(fixture, 10)
  const lines = csv.split('\r\n')
  const header = fields(lines[1])
  const row = fields(lines[2])
  const at = (name) => row[header.indexOf(name)]

  check(at('DB time (ms)') === '12', 'a duration is rounded to a whole number', at('DB time (ms)'))
  check(
    row.every((c) => !/^-?\d+[.,]\d+$/.test(c)),
    'no cell is a decimal number, so no locale can misread the separator',
    row.join(' | '),
  )
  check(header.includes('DB time (ms)'), 'the unit lives in the header, so the cell stays a number')
  check(at('Table') === 'Orders', 'the table is filled in', at('Table'))
  check(at('Recorded') === '2024-12-24 02:06:40' || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at('Recorded')), 'the timestamp is sortable and locale-proof', at('Recorded'))
  check(at('Verdict') === 'OK', 'the colour is spelled out as a verdict', at('Verdict'))

  // Every column must produce a cell, or the sheet is misaligned.
  check(row.length === header.length, 'the row has exactly as many cells as the header', `${row.length} vs ${header.length}`)
}

// ---------------------------------------------------------------------------
// 5. Growth reaches the sheet as a sortable number.
{
  let seq = 0
  const call = ({ sql, params = [], site, rows }) => {
    const id = `q${++seq}`
    return {
      id,
      seq,
      ts: 1735000000000 + seq,
      durationMs: 2,
      rowsAffected: -1,
      rowsRead: rows === undefined ? -1 : rows + 1,
      app: 'Shop.OrdersApi',
      reqId: 'r1',
      handler: 'OrdersController.Tree',
      source: 'LinqQuery',
      stack: [{ m: site, f: 'src\\Shop.Data\\X.cs', l: 10 }],
      sql,
      params,
      statements: shred(sql, params).statements,
    }
  }

  const calls = [call({ sql: 'SELECT [o].[Id] FROM [Orders] AS [o] WHERE [o].[T] = @p0', params: [{ n: '@p0', v: 't' }], site: 'Svc.Orders', rows: 3 })]
  for (let o = 1; o <= 3; o++) {
    calls.push(call({ sql: 'SELECT [s].[Id] FROM [Shipments] AS [s] WHERE [s].[O] = @p0', params: [{ n: '@p0', v: `o${o}` }], site: 'Svc.Ships', rows: 4 }))
  }
  for (let s = 1; s <= 12; s++) {
    calls.push(call({ sql: 'SELECT [l].[Id] FROM [OrderLines] AS [l] WHERE [l].[S] = @p0', params: [{ n: '@p0', v: `s${s}` }], site: 'Svc.Lines', rows: 2 }))
  }

  const nested = analyzeAction(
    { id: 'n', label: 'Tree', kind: 'click', startedAt: 1735000000000, endedAt: 1735000001000, calls, requests: [{ id: 'r1' }], saveChanges: [] },
    DEFAULTS,
  )

  const lines = flowCsv(nested, 10).split('\r\n')
  const header = fields(lines[1])
  const rows = lines.slice(2).filter(Boolean).map(fields)
  const col = (r, name) => r[header.indexOf(name)]
  const byTable = (t) => rows.find((r) => col(r, 'Table') === t)

  check(header.includes('Calls at 10x data'), 'the projection column is named with the factor', header.join(','))
  check(col(byTable('OrderLines'), 'Growth levels') === '2', 'a loop inside a loop reports two levels', col(byTable('OrderLines'), 'Growth levels'))
  check(col(byTable('Shipments'), 'Growth levels') === '1', 'a per-row query reports one level')
  check(col(byTable('Orders'), 'Growth levels') === '0', 'the driving query reports none')
  check(
    col(byTable('OrderLines'), 'Growth') === 'per Orders × Shipments',
    'the dimensions are named in the Growth column',
    col(byTable('OrderLines'), 'Growth'),
  )
  check(col(byTable('OrderLines'), 'Calls at 10x data') === '120', 'and the projection is the count times the factor', col(byTable('OrderLines'), 'Calls at 10x data'))

  // One sheet, many flows: the flow columns repeat so a pivot table works.
  const session = sessionCsv([nested, nested], 10).split('\r\n').filter(Boolean)
  check(session.length === 2 + rows.length * 2, 'a session sheet holds every group of every flow', String(session.length))

  // The drill-down.
  const group = nested.groups.find((g) => g.table === 'OrderLines')
  const execLines = callCsv(nested, group).split('\r\n').filter(Boolean)
  check(execLines.length === 2 + group.executions.length, 'the single-call sheet is one row per execution', String(execLines.length))
  check(fields(execLines[1]).slice(0, 5).join(',') === 'Flow,Operation,Table,#,At', 'with its own header', execLines[1])
}

// ---------------------------------------------------------------------------
// 6. File names.
{
  check(csvFileName(['2026-08-28', 'Open order tree']) === '2026-08-28-Open-order-tree.csv', 'spaces become dashes', csvFileName(['2026-08-28', 'Open order tree']))
  check(!csvFileName(['a/b\\c:d']).includes('/'), 'path separators cannot leak into a file name')
  check(csvFileName([]) === 'db-calls.csv', 'an unnamed export still gets a name')
  check(csvFileName(['x'.repeat(200)]).length <= 94, 'a very long flow label is truncated')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
