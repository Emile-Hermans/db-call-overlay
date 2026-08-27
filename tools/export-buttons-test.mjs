// Checks the export buttons on both row types: the flow row next to the pencil,
// and the query-group row. Needs the collector running.
import { chromium } from 'playwright'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = 'http://127.0.0.1:8478'

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
execSync('node tools/selftest.mjs', { cwd: ROOT, stdio: 'ignore' })
await page.waitForFunction(() => document.querySelectorAll('.action').length >= 3, null, { timeout: 15000 })

const flow = page.locator('.action.red').first()

// --- the flow row, next to the pencil --------------------------------------
const tools = flow.locator('.rowtools button')
check((await tools.count()) === 3, 'flow row has three buttons', `${await tools.count()}`)

const order = await flow.locator('.rowtools button').evaluateAll((els) => els.map((e) => e.dataset.act))
check(order.join(',') === 'note,export-flow,delete', 'export sits between the pencil and the bin', order.join(','))
check(await flow.locator('button[data-act="export-flow"]').isVisible(), 'export button is visible without hovering')

const opacity = await flow.locator('button[data-act="export-flow"]').evaluate((el) => getComputedStyle(el).opacity)
check(Number(opacity) >= 0.7, 'export button is not washed out', `opacity ${opacity}`)

// exporting must not open the flow
const wasOpen = await flow.evaluate((el) => el.classList.contains('open'))
const flowDownload = page.waitForEvent('download', { timeout: 10000 })
await flow.locator('button[data-act="export-flow"]').click()
const file1 = await flowDownload
check(await flow.evaluate((el) => el.classList.contains('open')) === wasOpen, 'exporting does not toggle the row')
check(/^flow-.*\.json$/.test(file1.suggestedFilename()), 'flow file is named after the flow', file1.suggestedFilename())

const flowJson = JSON.parse(fs.readFileSync(await file1.path(), 'utf8'))
check(Array.isArray(flowJson.flow?.groups) && flowJson.flow.groups.length > 0, 'flow export contains every call group')
check(typeof flowJson.flow?.total === 'number', 'flow export carries the totals')

// --- the query-group row ----------------------------------------------------
await flow.locator('.arow').click()
await page.waitForSelector('.action.red .group')
const group = page.locator('.action.red .group').first()

const groupDownload = page.waitForEvent('download', { timeout: 10000 })
await group.locator('button[data-act="save-call"]').click()
const file2 = await groupDownload
const callJson = JSON.parse(fs.readFileSync(await file2.path(), 'utf8'))
check(Boolean(callJson.call?.sampleSql), 'single call export contains the SQL')
check(Boolean(callJson.action?.label), 'single call export names the flow it came from')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
