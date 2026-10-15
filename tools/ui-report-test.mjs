// Drives the click report: verdict, time split, fix-first list, waterfall, the
// static loop badge and the theme switch. Needs a collector running.
//   node tools/ui-report-test.mjs [screenshot path] [ui port] [repo root]
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2] ?? 'report.png'
const PORT = Number(process.argv[3] ?? 8478)
const ROOT = process.argv[4] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = `http://127.0.0.1:${PORT}`

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

// A loop report for the synthetic shop: the quote lookup inside OrderService.ClearQuotes.
const report = path.join(os.tmpdir(), `clicktrace-loops-${process.pid}.json`)
fs.writeFileSync(
  report,
  JSON.stringify({
    findings: [
      {
        file: 'src/Shop.Orders/Services/OrderService.cs',
        line: 118,
        method: 'OrderService.ClearQuotes(Guid)',
        loops: [{ kind: 'foreach', header: 'foreach (var line in order.Lines)', line: 115 }],
        call: '_quotes.GetByOrderLine(line.Id)',
        chain: 'QuoteRepository.GetByOrderLine(Guid)',
        accessKind: 'Read',
      },
    ],
  }),
)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('dialog', (d) => d.accept())

try {
  await page.goto(UI, { waitUntil: 'networkidle' })
  const saved = await page.evaluate(async (file) => {
    const config = await (await fetch('/api/config')).json()
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiPorts: config.apiPorts, thresholds: config.thresholds, loopReport: file }),
    })
    return (await res.json()).loops
  }, report)
  check(saved?.findings === 1 && !saved.error, 'the loop report is loaded from settings', JSON.stringify(saved))

  await page.evaluate(() => fetch('/api/clear', { method: 'POST' }))
  execSync(`node tools/selftest.mjs ${PORT - 1}`, { cwd: ROOT, stdio: 'ignore' })
  await page.waitForFunction(() => document.querySelectorAll('.action').length >= 3, null, { timeout: 15000 })

  // --- the row answers "is it the database?" before it is opened ---------------
  const flow = page.locator('.action', { hasText: 'Recalculate order' })
  const rowTime = await flow.locator('.rowtime .wall').textContent()
  check(/ms|s/.test(rowTime) && /% db/.test(rowTime), 'the row shows wall time and the database share', rowTime)
  check((await flow.locator('.timebar i.db').count()) === 1, 'the row carries a database / application bar')

  // --- the report -------------------------------------------------------------
  await flow.locator('.arow').click()
  await page.waitForSelector('.action.open .verdict')
  const verdict = await flow.locator('.verdict .vt').textContent()
  check(/bound|Fast|between/i.test(verdict), 'the report opens with a verdict', verdict)
  check((await flow.locator('.splitbar i.db').count()) === 1, 'the time is split into database and application')

  const fixes = flow.locator('.fix')
  check((await fixes.count()) >= 2, 'fix-first lists the changes worth making', String(await fixes.count()))
  const gains = await fixes.locator('.fix-gain b').allTextContents()
  const asMs = gains.map((g) => (g.includes(' s') ? parseFloat(g.replace(/[^\d.]/g, '')) * 1000 : parseFloat(g.replace(/[^\d.]/g, ''))))
  check(asMs.every((v, i) => i === 0 || v <= asMs[i - 1]), 'and ranks them by time saved', gains.join(' '))

  const loopFix = fixes.filter({ hasText: 'Quotes' })
  check((await loopFix.locator('.pill.loop').count()) === 1, 'the N+1 carries the loop from the static report')
  check(/OrderService\.cs:118/.test(await loopFix.locator('.pill.loop').textContent()), 'naming the file and line')

  // Clicking a fix opens its query group.
  await loopFix.click()
  await page.waitForTimeout(400)
  const quotes = flow.locator('.group.open', { hasText: 'Quotes' })
  check((await quotes.count()) === 1, 'clicking a fix opens its query group')
  check((await quotes.locator('.pill.loop').count()) === 1, 'the group itself carries the in-loop badge')
  check(/static analysis/i.test(await quotes.locator('.gdetail').textContent()), 'and a finding that names the loop')

  // --- the waterfall ----------------------------------------------------------
  const spans = flow.locator('.wf-span')
  check((await spans.count()) > 10, 'the waterfall draws every query', String(await spans.count()))
  check((await flow.locator('.wf-req').count()) >= 1, 'inside its request')
  check((await flow.locator('.wf-span.high').count()) > 0, 'removable queries stand out')

  // --- the copy carries the loop ----------------------------------------------
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await quotes.locator('button[data-act="copy-call"]').click()
  await page.waitForTimeout(300)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  check(/\*\*In a loop:\*\* .*OrderService\.cs:118/.test(copied), 'copying the call includes the loop', copied.slice(0, 200))

  // --- theme ------------------------------------------------------------------
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.click('#themeBtn') // auto -> light
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check(before !== after, 'the theme button switches to light', `${before} -> ${after}`)
  await page.reload({ waitUntil: 'networkidle' })
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'and is remembered')
  await page.click('#themeBtn') // light -> dark
  await page.click('#themeBtn') // dark -> auto

  await page.locator('.action', { hasText: 'Recalculate order' }).locator('.arow').click()
  await page.waitForSelector('.action.open .verdict')
  await page.screenshot({ path: out, fullPage: false })
  console.log(`screenshot -> ${out}`)
} finally {
  // Leave the settings as they were found.
  await page
    .evaluate(async () => {
      const config = await (await fetch('/api/config')).json()
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiPorts: config.apiPorts, thresholds: config.thresholds, loopReport: '' }),
      })
    })
    .catch(() => {})
  fs.rmSync(report, { force: true })
  await browser.close()
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
