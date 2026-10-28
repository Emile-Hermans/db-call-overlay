// A joined read is one query: the row says how many tables it joins, and the
// open group lists each table with the columns it brings back.
// Needs a collector on a test port.  node tools/ui-sources-test.mjs [png] [ui port] [repo root]
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2] ?? 'sources.png'
const PORT = Number(process.argv[3] ?? 9478)
const ROOT = process.argv[4] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = `http://127.0.0.1:${PORT}`

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message)
  failures++
})

try {
  await page.goto(UI, { waitUntil: 'networkidle' })
  await page.evaluate(() => fetch('/api/clear', { method: 'POST' }))
  execSync(`node tools/selftest.mjs ${PORT - 1}`, { cwd: ROOT, stdio: 'ignore' })
  await page.waitForFunction(() => document.querySelectorAll('.action').length >= 3, null, { timeout: 15000 })

  const flow = page.locator('.action', { hasText: 'Recalculate order' })
  await flow.locator('.arow').click()
  await page.waitForSelector('.action.open .group')

  const orders = flow.locator('.group', { has: page.locator('.tname', { hasText: /^Orders$/ }) }).first()
  const pill = orders.locator('.pill.join')
  check((await pill.textContent())?.trim() === '+1 joined', 'the row says the read joins one more table', await pill.textContent())
  check(/TenantSettings \(left join, 3 columns\)/.test((await pill.getAttribute('title')) ?? ''), 'its tooltip names the table and its columns')

  await orders.locator('.grow').click()
  const table = orders.locator('table.sources')
  await table.waitFor()
  const rows = await table
    .locator('tbody tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join(' ').trim()))
  check(rows.length === 2 && /^Orders from 3/.test(rows[0]) && /^TenantSettings left join 3/.test(rows[1]), 'the open group lists both tables', rows.join(' | '))
  check(/one round-trip per execution · 2 tables · 6 columns/.test(await orders.locator('.section-title', { hasText: 'Tables in this query' }).textContent()), 'with the totals for the one query')

  // A single-table read gets no pill and no table list.
  const shipments = flow.locator('.group', { has: page.locator('.tname', { hasText: /^Shipments$/ }) }).first()
  check((await shipments.locator('.pill.join').count()) === 0, 'a single-table read has no join pill')

  await orders.screenshot({ path: out })
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
