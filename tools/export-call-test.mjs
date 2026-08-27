// Renders the single-call export against a real exported report and checks the
// result is complete. Usage: node tools/export-call-test.mjs <export.json> [n]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/export-call-test.mjs <db-calls-*.json> [group index]')
  process.exit(2)
}

// Reuse the UI's own formatter so the test cannot drift from what the button does.
const appJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'app.js'), 'utf8')
const start = appJs.indexOf('/** One call as Markdown')
const end = appJs.indexOf('async function copyCall')
if (start < 0 || end < 0) {
  console.error('FAIL  could not find callAsText in ui/app.js — did it get renamed?')
  process.exit(1)
}

const clock = (t) => new Date(t).toLocaleTimeString('nl-BE', { hour12: false })
const callAsText = new Function('clock', `${appJs.slice(start, end)}; return callAsText`)(clock)

const report = JSON.parse(fs.readFileSync(file, 'utf8'))
const action = report.actions[0]
const group = action.groups[Number(process.argv[3] ?? 0)]

const text = callAsText(action, group)
console.log(text)
console.log('\n' + '='.repeat(70))

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

check(text.includes(group.op), 'names the operation')
check(!group.table || text.includes(group.table), 'names the table')
check(text.includes('```sql'), 'includes the SQL')
check(text.includes(group.sampleSql.slice(0, 40)), 'the SQL is the real statement')
check(!group.callsite || text.includes(group.callsite.method), 'names the call site')
check(group.findings.every((f) => text.includes(f.title)), 'lists every finding')
check(text.includes('| # | at | took |'), 'includes the executions table')
check(!/undefined|\[object Object\]|NaN/.test(text), 'no undefined / NaN leaked into the output')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
