// CSV export, written for Excel specifically rather than for a parser.
//
// Four things decide whether a CSV opens cleanly or as one useless column:
//
//   Delimiter   Excel uses the list separator of the machine's locale, which is a
//               semicolon across most of continental Europe and a comma in en-US.
//               A file cannot satisfy both - but a leading `sep=` line overrides
//               the locale, and Excel is the only thing that reads it. So the file
//               declares its own delimiter and opens the same way everywhere.
//   BOM         Without it Excel reads the bytes as the local ANSI codepage and
//               every non-ASCII character in the report is mangled.
//   Numbers     A decimal point is a thousands separator in a comma-decimal
//               locale, so "1.5" can silently become 15. Every number here is
//               therefore written as an integer, and its unit lives in the header.
//   Formulas    A field starting with = + @ is executed on open. Values come out
//               of somebody's database, so they are neutralised.

const BOM = '﻿'
const DELIMITER = ';'
const EOL = '\r\n'

/** Leading characters Excel treats as the start of a formula rather than text. */
const FORMULA_START = /^[=+@\t\r]/
/** A field that is simply a number is safe and must stay a number. */
const PLAIN_NUMBER = /^-?\d+$/

function cell(value) {
  if (value === null || value === undefined) return ''

  let text = String(value)
  if (text === '') return ''

  // Collapse newlines: a quoted field may legally contain them, but a report is
  // far easier to read when one row occupies one row.
  text = text.replace(/\r\n|\r|\n/g, ' ').replace(/\t/g, ' ')

  // Neutralise anything Excel would execute. A negative number is excluded first,
  // because "-1" is a number and turning it into text would be the bug.
  if (FORMULA_START.test(text) || (text.startsWith('-') && !PLAIN_NUMBER.test(text))) {
    text = `'${text}`
  }

  if (text.includes(DELIMITER) || text.includes('"') || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** Rows of objects plus an ordered column list -> one Excel-ready CSV string. */
export function toCsv(columns, rows) {
  const header = columns.map((c) => cell(c.header)).join(DELIMITER)
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(DELIMITER))
  return BOM + `sep=${DELIMITER}` + EOL + [header, ...body].join(EOL) + EOL
}

/** Whole numbers only - see the note on locales above. */
const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : '')

/** A count that is only meaningful when it was actually measured. */
const counted = (n) => (typeof n === 'number' && n > 0 ? Math.round(n) : '')

/** Sortable and unambiguous in every locale Excel parses. */
function stamp(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

const VERDICT = { red: 'WASTE', amber: 'REVIEW', green: 'OK' }

const KIND = {
  query: 'query',
  save: 'save',
  bulk: 'bulk write',
  rawsql: 'raw sql',
  migration: 'migration',
  valuegen: 'key generator',
  mixed: 'mixed',
  unknown: '',
}

/**
 * How this group's call count follows the data, in words and as a number.
 * The number is what makes the sheet useful: filter on it to see every query
 * whose cost is a product of two dimensions rather than a constant.
 */
function growth(group) {
  const s = group.scaling
  if (!s) return { label: '', levels: '' }
  if (s.depth === null) return { label: 'unknown', levels: '' }
  if (s.depth === 0) return { label: 'fixed', levels: 0 }
  return { label: `per ${s.chain.join(' × ')}`, levels: s.depth }
}

/**
 * One row per query group. This is the shape worth having in a spreadsheet: sort
 * by Removable to find the waste, filter Growth levels >= 2 to find what will not
 * survive more data, pivot on Table to see which one the flow leans on.
 *
 * Flow-level figures repeat on every row of that flow, which is what lets a pivot
 * table work at all.
 */
export function groupColumns(factor = 10) {
  return [
    { header: 'Flow', value: (r) => r.action.label },
    { header: 'Verdict', value: (r) => VERDICT[r.action.colour] ?? r.action.colour },
    { header: 'Operation', value: (r) => r.group.op },
    { header: 'Table', value: (r) => r.group.table ?? '' },
    { header: 'Kind', value: (r) => KIND[r.group.kind] ?? '' },

    { header: 'Calls', value: (r) => r.group.count },
    { header: 'Removable', value: (r) => r.group.avoidable },
    { header: 'DB time (ms)', value: (r) => round(r.group.totalMs) },
    { header: 'Slowest (ms)', value: (r) => round(r.group.maxMs) },
    { header: 'Round trips', value: (r) => r.group.roundTrips },

    { header: 'Growth', value: (r) => growth(r.group).label },
    { header: 'Growth levels', value: (r) => growth(r.group).levels },
    {
      header: `Calls at ${factor}x data`,
      value: (r) => {
        const s = r.group.scaling
        return s && s.depth > 0 ? r.group.count * factor : r.group.count
      },
    },

    { header: 'Distinct values', value: (r) => (r.group.op === 'SELECT' ? r.group.distinctParams : r.group.distinctRows) },
    { header: 'Rows read', value: (r) => counted(r.group.rowsRead) },
    { header: 'Rows written', value: (r) => counted(r.group.rowsAffected) },
    { header: 'Cross-request repeats', value: (r) => r.group.avoidableAcrossRequests },
    {
      // Executions the user never waited for: after the response, or background.
      header: 'Not waited',
      value: (r) => counted((r.group.timing?.afterResponse ?? 0) + (r.group.timing?.background ?? 0)),
    },

    { header: 'Call site', value: (r) => r.group.callsite?.method ?? '' },
    { header: 'Source file', value: (r) => r.group.callsite?.file ?? '' },
    { header: 'Line', value: (r) => r.group.callsite?.line ?? '' },
    { header: 'Endpoint', value: (r) => (r.group.endpoints ?? []).join(' | ') },

    // Joined with a pipe rather than the delimiter, so the cell stays readable
    // even when someone splits the column later.
    { header: 'Findings', value: (r) => r.group.findings.map((f) => f.title).join(' | ') },
    { header: 'Suggested fix', value: (r) => r.group.findings.map((f) => f.fix).filter(Boolean).join(' | ') },

    { header: 'Recorded', value: (r) => stamp(r.action.startedAt) },
    { header: 'App', value: (r) => (r.group.apps ?? []).join(' | ') },
    { header: 'Flow calls', value: (r) => r.action.total },
    { header: 'Flow removable', value: (r) => r.action.avoidable },
    { header: 'SQL', value: (r) => r.group.sampleSql ?? '' },
  ]
}

/** One row per execution: the drill-down for a single call. */
export function executionColumns() {
  return [
    { header: 'Flow', value: (r) => r.action.label },
    { header: 'Operation', value: (r) => r.group.op },
    { header: 'Table', value: (r) => r.group.table ?? '' },
    { header: '#', value: (r) => r.index + 1 },
    { header: 'At', value: (r) => stamp(r.execution.ts) },
    { header: 'Duration (ms)', value: (r) => round(r.execution.durationMs) },
    { header: 'Rows read', value: (r) => counted(r.execution.rowsRead) },
    { header: 'Rows written', value: (r) => counted(r.execution.rowsAffected) },
    { header: 'Row count inferred', value: (r) => (r.execution.rowsAffectedDerived ? 'yes' : '') },
    { header: 'Kind', value: (r) => KIND[r.execution.kind] ?? '' },
    { header: 'Request', value: (r) => r.execution.reqId ?? '' },
    {
      header: 'Timing',
      value: (r) =>
        r.execution.timing === 'afterResponse'
          ? 'after response'
          : r.execution.timing === 'background'
            ? 'background'
            : '',
    },
    { header: 'From', value: (r) => r.execution.origin ?? r.execution.handler ?? r.execution.path ?? '' },
    { header: 'Parameters', value: (r) => (r.execution.params ?? []).map((p) => `${p.n}=${p.v}`).join(' | ') },
    { header: 'Error', value: (r) => r.execution.error ?? '' },
    { header: 'SQL', value: (r) => r.execution.sql ?? '' },
  ]
}

/** Every query group of every flow, newest flow first. */
export function sessionCsv(actions, factor = 10) {
  const rows = []
  for (const action of actions) {
    for (const group of action.groups) rows.push({ action, group })
  }
  return toCsv(groupColumns(factor), rows)
}

/** Every query group of one flow. */
export function flowCsv(action, factor = 10) {
  return toCsv(
    groupColumns(factor),
    action.groups.map((group) => ({ action, group })),
  )
}

/** Every execution of one query group. */
export function callCsv(action, group) {
  return toCsv(
    executionColumns(),
    (group.executions ?? []).map((execution, index) => ({ action, group, execution, index })),
  )
}

/** Readable and chronologically sortable, unlike a millisecond timestamp. */
export function csvFileName(parts) {
  const safe = parts
    .filter(Boolean)
    .join('-')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90)
  return `${safe || 'db-calls'}.csv`
}
