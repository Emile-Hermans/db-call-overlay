// Checks that a call group can be copied straight from its row, without opening
// it, and that doing so does not toggle the row. Needs the collector running.
import { chromium } from 'playwright'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Repo root: normally the parent of tools/, but overridable so the test can be
// run from a folder where Playwright happens to be installed.
const ROOT = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = 'http://127.0.0.1:8478'

const browser = await chromium.launch()
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

await page.goto(UI, { waitUntil: 'networkidle' })
await page.evaluate(() => fetch('/api/clear', { method: 'POST' }))
execSync('node tools/selftest.mjs', { cwd: ROOT, stdio: 'ignore' })
await page.waitForFunction(() => document.querySelectorAll('.action').length >= 3, null, { timeout: 15000 })

// Open one action so its group rows exist, but leave the GROUPS collapsed.
await page.locator('.action.red .arow').first().click()
await page.waitForSelector('.action.red .group')

const group = page.locator('.action.red .group').first()
check(!(await group.evaluate((el) => el.classList.contains('open'))), 'group starts collapsed')

// --- copy straight from the collapsed row ----------------------------------
await group.locator('button[data-act="copy-call"]').click()
await page.waitForTimeout(400)

check(
  !(await group.evaluate((el) => el.classList.contains('open'))),
  'copying does NOT expand the row',
)

const text = await page.evaluate(() => navigator.clipboard.readText())
check(text.length > 100, 'something substantial was copied', `${text.length} chars`)
check(/^### (SELECT|UPDATE|INSERT|DELETE|MERGE|EXEC)/.test(text), 'starts with the operation heading')
check(text.includes('```sql'), 'contains the SQL')
check(text.includes('| # | at | took |'), 'contains the executions table')
check(text.includes('**Action:**'), 'names the action it came from')
check(!/undefined|\[object Object\]|NaN/.test(text), 'no undefined / NaN in the output')

// --- the row still toggles normally ----------------------------------------
await group.locator('.grow').click()
await page.waitForTimeout(300)
check(await group.evaluate((el) => el.classList.contains('open')), 'clicking the row still opens it')

console.log('\n--- first lines of what was copied ---')
console.log(text.split('\n').slice(0, 8).join('\n'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
