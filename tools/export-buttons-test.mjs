// Checks the export dropdown on both row types: the flow row next to the pencil,
// and the query-group row. Each row has one export button that opens a menu with
// the two formats. Needs the collector running.
import { chromium } from 'playwright'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Port is a parameter so a test run cannot sit on the port real probes dial.
// A probe connects to the ingest port the moment its application starts; if that
// is the port a test is using, the test ingests somebody's live recording.
const UI_PORT = Number(process.argv[3] ?? 8478)
const UI = `http://127.0.0.1:${UI_PORT}`

const browser = await chromium.launch()
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

await page.goto(UI, { waitUntil: 'networkidle' })
await page.evaluate(() => fetch('/api/clear', { method: 'POST' }))
execSync(`node tools/selftest.mjs ${UI_PORT - 1}`, { cwd: ROOT, stdio: 'ignore' })
await page.waitForFunction(() => document.querySelectorAll('.action').length >= 3, null, { timeout: 15000 })

const flow = page.locator('.action.red').first()
const menu = page.locator('#exportMenu')

// --- the flow row, next to the pencil --------------------------------------
const tools = flow.locator('.rowtools button')
check((await tools.count()) === 3, 'flow row has three buttons', `${await tools.count()}`)

const order = await flow.locator('.rowtools button').evaluateAll((els) => els.map((e) => e.dataset.act))
// One export button between the pencil and the bin; the bin stays last so it is
// never next to a button somebody is aiming at.
check(
  order.join(',') === 'note,export-menu,delete',
  'the export button sits between the pencil and the bin',
  order.join(','),
)
check(await flow.locator('button[data-act="export-menu"]').isVisible(), 'export button is visible without hovering')

const opacity = await flow.locator('button[data-act="export-menu"]').evaluate((el) => getComputedStyle(el).opacity)
check(Number(opacity) >= 0.7, 'export button is not washed out', `opacity ${opacity}`)

// opening the menu must not open the flow
const wasOpen = await flow.evaluate((el) => el.classList.contains('open'))
await flow.locator('button[data-act="export-menu"]').click()
check(await menu.isVisible(), 'clicking the export button opens the menu')
check(await flow.evaluate((el) => el.classList.contains('open')) === wasOpen, 'opening the menu does not toggle the row')
check(
  (await menu.locator('#exportMenuTitle').textContent()) === 'Export this flow',
  'the menu says it exports the flow',
)

const formats = await menu.locator('button[data-format]').evaluateAll((els) => els.map((e) => e.dataset.format))
check(formats.join(',') === 'csv,json', 'both formats are offered, spreadsheet first', formats.join(','))

// Escape closes it without exporting anything
await page.keyboard.press('Escape')
check(await menu.isHidden(), 'Escape closes the menu')

// --- flow export, both formats ----------------------------------------------
await flow.locator('button[data-act="export-menu"]').click()
const flowCsvDownload = page.waitForEvent('download', { timeout: 10000 })
await menu.locator('button[data-format="csv"]').click()
const csvFile = await flowCsvDownload
check(await menu.isHidden(), 'choosing a format closes the menu')
check(/\.csv$/.test(csvFile.suggestedFilename()), 'flow CSV lands as a .csv file', csvFile.suggestedFilename())

await flow.locator('button[data-act="export-menu"]').click()
const flowJsonDownload = page.waitForEvent('download', { timeout: 10000 })
await menu.locator('button[data-format="json"]').click()
const file1 = await flowJsonDownload
check(/^flow-.*\.json$/.test(file1.suggestedFilename()), 'flow file is named after the flow', file1.suggestedFilename())

const flowJson = JSON.parse(fs.readFileSync(await file1.path(), 'utf8'))
check(Array.isArray(flowJson.flow?.groups) && flowJson.flow.groups.length > 0, 'flow export contains every call group')
check(typeof flowJson.flow?.total === 'number', 'flow export carries the totals')

// --- the query-group row ----------------------------------------------------
await flow.locator('.arow').click()
await page.waitForSelector('.action.red .group')
const group = page.locator('.action.red .group').first()

const groupActs = await group.locator('.rowtools button').evaluateAll((els) => els.map((e) => e.dataset.act))
check(groupActs.join(',') === 'copy-call,export-menu', 'group row keeps copy and one export button', groupActs.join(','))

await group.locator('button[data-act="export-menu"]').click()
check(
  (await menu.locator('#exportMenuTitle').textContent()) === 'Export this call',
  'the menu says it exports one call',
)

const groupJsonDownload = page.waitForEvent('download', { timeout: 10000 })
await menu.locator('button[data-format="json"]').click()
const file2 = await groupJsonDownload
const callJson = JSON.parse(fs.readFileSync(await file2.path(), 'utf8'))
check(Boolean(callJson.call?.sampleSql), 'single call export contains the SQL')
check(Boolean(callJson.action?.label), 'single call export names the flow it came from')

await group.locator('button[data-act="export-menu"]').click()
const groupCsvDownload = page.waitForEvent('download', { timeout: 10000 })
await menu.locator('button[data-format="csv"]').click()
const csvFile2 = await groupCsvDownload
check(/\.csv$/.test(csvFile2.suggestedFilename()), 'single call CSV lands as a .csv file', csvFile2.suggestedFilename())

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
