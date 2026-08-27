// Drives the overlay UI: create a project, record, describe a flow, delete one.
// Needs the collector running. `node tools/ui-test.mjs out.png`
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const out = process.argv[2] ?? 'ui.png'
const UI = 'http://127.0.0.1:8478'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('dialog', (d) => d.accept())

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

await page.goto(UI, { waitUntil: 'networkidle' })

// --- create a project through the menu -------------------------------------
await page.click('#projectBtn')
await page.fill('#newProjectName', 'CheckoutFlow')
await page.click('#newProjectForm button[type=submit]')
await page.waitForFunction(() => document.getElementById('projectName').textContent === 'CheckoutFlow')
check(true, 'project created and opened from the menu')

// --- record some flows ------------------------------------------------------
await page.evaluate(async () => {
  await fetch('/api/clear', { method: 'POST' })
})
const { execSync } = await import('node:child_process')
execSync('node tools/selftest.mjs', { cwd: ROOT, stdio: 'ignore' })

await page.waitForFunction(() => document.querySelectorAll('.action').length >= 3, null, { timeout: 15000 })
check(true, 'flows recorded into the project')

// --- describe a flow --------------------------------------------------------
const target = page.locator('.action', { hasText: 'Recalculate order' }).first()
await target.locator('button[data-act="note"]').click()
await page.waitForSelector('#noteDialog[open]')
check(await page.locator('#noteFlowLabel').innerText() === 'Recalculate order', 'note dialog names the flow')

const NOTE = 'Recalculating a 50-line order.\nCovers the double save on the lines table.'
await page.fill('#noteText', NOTE)
await page.click('#noteSave')
await page.waitForSelector('#noteDialog[open]', { state: 'detached' }).catch(() => {})
await page.waitForFunction(
  () => document.querySelector('.action button.note.has-note') !== null,
  null,
  { timeout: 10000 },
)
check(true, 'note saved and the row shows it')

// --- reopen the note and confirm the text came back ------------------------
await page.locator('.action button.note.has-note').first().click()
await page.waitForSelector('#noteDialog[open]')
check((await page.inputValue('#noteText')) === NOTE, 'reopening the note shows the saved text')
await page.click('#noteCancel')

// --- delete a flow ----------------------------------------------------------
const before = await page.locator('.action').count()
await page.locator('.action', { hasText: 'Open shipments tab' }).first().locator('button[data-act="delete"]').click()
await page.waitForFunction((n) => document.querySelectorAll('.action').length === n - 1, before, { timeout: 10000 })
check(true, 'flow deleted from the list')

// --- the note must survive a reopen of the project -------------------------
await page.evaluate(() => fetch('/api/projects/open', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: null }),
}))
await page.waitForFunction(() => document.getElementById('projectName').textContent === 'Scratch')
await page.evaluate(() => fetch('/api/projects/open', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folder: 'CheckoutFlow' }),
}))
await page.waitForFunction(() => document.querySelector('.action button.note.has-note') !== null, null, { timeout: 10000 })
check(true, 'note survived closing and reopening the project')

await page.locator('.action', { hasText: 'Recalculate order' }).first().locator('.arow').click()
await page.waitForTimeout(700)
await page.screenshot({ path: out, fullPage: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
