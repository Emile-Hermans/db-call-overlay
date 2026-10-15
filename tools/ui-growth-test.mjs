// Drives the parts of the UI added for growth and command kinds: the scaling
// tile, the per-group badges, the filter bar, the help panel and the guard on
// Clear. Needs a collector running.
//   node tools/ui-growth-test.mjs [screenshot path] [ui port] [repo root]
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2] ?? 'growth.png'
const PORT = process.argv[3] ?? '8478'
const ROOT = process.argv[4] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = `http://127.0.0.1:${PORT}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1240, height: 940 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()))

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

await page.goto(UI, { waitUntil: 'networkidle' })
await page.evaluate(() => fetch('/api/clear', { method: 'POST' }))

const { execSync } = await import('node:child_process')
execSync(`node tools/selftest.mjs ${Number(PORT) - 1}`, { cwd: ROOT, stdio: 'ignore' })

// Wait for the list to stop changing, not just to reach a size. Events arrive
// over several stream ticks, and a count captured mid-arrival makes every later
// "restores every flow" comparison fail for no reason.
await page.waitForFunction(
  () => {
    const now = document.querySelectorAll('#list .action').length
    const settled = window.__settled ?? { count: -1, ticks: 0 }
    window.__settled = now === settled.count ? { count: now, ticks: settled.ticks + 1 } : { count: now, ticks: 0 }
    return now >= 5 && window.__settled.ticks >= 4
  },
  { timeout: 15000, polling: 250 },
)

// --- the scaling tile -------------------------------------------------------
const tile = await page.evaluate(() => ({
  value: document.getElementById('tScale').textContent.trim(),
  label: document.getElementById('tScaleLabel').textContent.trim(),
  bad: document.getElementById('scaleTile').classList.contains('bad'),
  title: document.getElementById('scaleTile').title,
}))
check(tile.label === 'At 10× data', 'the tile is labelled with the projection factor', tile.label)
check(/^\d+–\d+$/.test(tile.value), 'a nested loop shows a range, not one number', tile.value)
check(tile.bad, 'a loop inside a loop turns the tile red')
check(/every level/.test(tile.title), 'the tooltip explains what the upper bound means')

// --- the flow row chip ------------------------------------------------------
const tree = page.locator('#list .action', { hasText: 'Open order tree' })
check((await tree.locator('.growth.bad').count()) === 1, 'the nested flow carries a red growth chip')
check(
  (await page.locator('#list .action', { hasText: 'Open shipments tab' }).locator('.growth.bad, .growth.warn').count()) === 0,
  'a flow with nothing proven to grow carries no chip',
)

// --- per-group badges -------------------------------------------------------
await tree.locator('.arow').click()
await page.waitForSelector('#list .action.open .group')

const badges = await tree.evaluate((el) =>
  [...el.querySelectorAll('.group')].map((g) => ({
    table: g.querySelector('.tbl')?.textContent.trim(),
    grow: g.querySelector('.pill.scale')?.textContent.trim() ?? null,
    depth: [...(g.querySelector('.pill.scale')?.classList ?? [])].find((c) => /^d\d$/.test(c)) ?? null,
    kind: g.querySelector('.pill.kind')?.textContent.trim() ?? null,
  })),
)
const lines = badges.find((b) => b.table === 'OrderLines')
const shipments = badges.find((b) => b.table === 'Shipments')
const orders = badges.find((b) => b.table === 'Orders')

check(lines?.grow === 'per Orders × Shipments', 'the nested group names both dimensions', String(lines?.grow))
check(lines?.depth === 'd2', 'and is styled as two levels deep', String(lines?.depth))
check(shipments?.grow === 'per Orders', 'the single-level group names its one dimension', String(shipments?.grow))
check(orders?.grow === null, 'the driving query itself gets no growth badge', String(orders?.grow))
check(lines?.kind === null, 'an ordinary query is not labelled — only the notable kinds are', String(lines?.kind))

// --- the cost line ----------------------------------------------------------
const cost = await tree.locator('.costline').first().textContent()
check(/per Orders × Shipments/.test(cost), 'the flow shows where its call count comes from', cost.trim())
check(/at 10× the data/.test(cost), 'and what that costs against more data')

// --- a tracked save is labelled as one --------------------------------------
const recalc = page.locator('#list .action', { hasText: 'Recalculate order' })
await recalc.locator('.arow').click()
await page.waitForTimeout(300)
const kinds = await recalc.evaluate((el) =>
  [...el.querySelectorAll('.group')].map((g) => [
    g.querySelector('.tbl')?.textContent.trim(),
    g.querySelector('.pill.kind')?.textContent.trim() ?? null,
  ]),
)
check(
  kinds.some(([t, k]) => t === 'OrderLines' && k === 'save'),
  'the change-tracker flush is labelled a save',
  JSON.stringify(kinds),
)
await recalc.locator('.arow').click()

// --- the filter -------------------------------------------------------------
const rows = () => page.locator('#list .action').count()
const before = await rows()

await page.fill('#filterText', 'shipments')
await page.waitForTimeout(200)
check((await rows()) < before, 'text filter narrows the list', `${await rows()} of ${before}`)
check(
  (await page.locator('#list .action', { hasText: 'Open shipments tab' }).count()) === 1,
  'and keeps the flow whose label matches',
)

// A table name is only visible once a flow is opened - the filter must still
// find it, or it is no use for finding anything.
await page.fill('#filterText', 'quotes')
await page.waitForTimeout(200)
check(
  (await page.locator('#list .action', { hasText: 'Recalculate order' }).count()) === 1,
  'filtering finds a table that is only visible inside a flow',
)

await page.fill('#filterText', 'zzzznothing')
await page.waitForTimeout(200)
check(await page.locator('#noMatches').isVisible(), 'an empty result says so instead of showing nothing')

await page.click('#filterClear')
await page.waitForTimeout(300)
check((await rows()) >= before, 'clearing the filter restores every flow', `${await rows()} vs ${before}`)

// --- the grows chip ---------------------------------------------------------
await page.click('.chip[data-colour="grows"]')
await page.waitForTimeout(200)
check((await rows()) === 1, 'the grows filter keeps only flows proven to grow', String(await rows()))
await page.click('#filterClear')
await page.waitForTimeout(200)

// --- colour chips -----------------------------------------------------------
await page.click('.chip[data-colour="green"]')
await page.click('.chip[data-colour="amber"]')
await page.waitForTimeout(200)
const redOnly = await page.locator('#list .action.green, #list .action.amber').count()
check(redOnly === 0, 'switching off a colour hides those flows', String(redOnly))
await page.click('#filterClear')

// --- the help panel ---------------------------------------------------------
await page.click('#helpBtn')
await page.waitForTimeout(200)
const help = await page.evaluate(() => ({
  open: document.getElementById('helpDialog').open,
  text: document.getElementById('helpDialog').textContent,
}))
check(help.open, 'the help panel opens')
check(/real database round-trip/.test(help.text), 'it states that every row is a real round-trip')
check(/Repeats/.test(help.text) && /Cross-request/.test(help.text), 'it defines the header tiles')
check(/Ctrl\+L/.test(help.text), 'and lists the shortcuts that were only in the readme')
await page.keyboard.press('Escape')

// --- thresholds in settings -------------------------------------------------
await page.click('#settingsBtn')
await page.waitForTimeout(300)
const fields = await page.evaluate(() =>
  ['thSlowMs', 'thVerySlowMs', 'thWideCols', 'thLoopRoundTrips', 'thNPlusOneMin', 'thNPlusOneMaxParams', 'thProjectionFactor'].map(
    (id) => document.getElementById(id)?.value ?? null,
  ),
)
check(
  fields.every((v) => v !== null && v !== ''),
  'every threshold is populated from the saved settings',
  JSON.stringify(fields),
)
check(
  /DBPROBE_PARAMS/.test(await page.locator('#paramsNote').textContent()),
  'the one control that is not a setting is explained rather than faked',
)

// Change the projection factor and confirm the tile follows it.
await page.fill('#thProjectionFactor', '4')
await page.click('#settingsSave')
await page.waitForFunction(() => document.getElementById('tScaleLabel').textContent.trim() === 'At 4× data', { timeout: 5000 })
check(true, 'changing a threshold re-judges what is already recorded')

await page.fill('#thProjectionFactor', '10').catch(() => {})
await page.click('#settingsBtn')
await page.waitForTimeout(300)
await page.fill('#thProjectionFactor', '10')
await page.click('#settingsSave')
await page.waitForTimeout(600)

// --- Clear asks first -------------------------------------------------------
// Compared against what is on screen right now rather than a count captured
// earlier: the recording is still streaming, so an earlier number is not a
// statement about what Clear did.
const beforeClear = await rows()
let asked = null
page.once('dialog', (d) => {
  asked = d.message()
  d.dismiss()
})
await page.click('#clearBtn')
await page.waitForTimeout(600)
check(Boolean(asked), 'Clear asks before throwing a session away')
check(/cannot be undone|Saved flows/.test(asked ?? ''), 'and says what would be lost', asked ?? '')
check((await rows()) >= beforeClear, 'dismissing the question keeps everything', `${await rows()} vs ${beforeClear}`)

// --- the spreadsheet exports ------------------------------------------------
// All three scopes are plain links, so what matters is that each one reaches the
// right route and comes back as a file rather than a page.
{
  const csv = async (path) => {
    const res = await page.request.get(`${UI}${path}`)
    return { status: res.status(), type: res.headers()['content-type'] ?? '', name: res.headers()['content-disposition'] ?? '', body: await res.text() }
  }

  const session = await csv('/api/export.csv')
  check(session.status === 200, 'the session spreadsheet is served', String(session.status))
  check(/text\/csv/.test(session.type), 'as text/csv', session.type)
  check(/attachment; filename=".*\.csv"/.test(session.name), 'and downloads with a .csv name', session.name)
  check(session.body.charCodeAt(0) === 0xfeff, 'starting with the BOM Excel needs')
  check(session.body.slice(1).startsWith('sep=;'), 'and its declared delimiter')

  const headerLine = session.body.split('\r\n')[1]
  check(headerLine.startsWith('Flow;Verdict;Operation;Table'), 'one row per query, flow first', headerLine.slice(0, 60))
  check(headerLine.includes('Growth levels'), 'with growth as a sortable number')
  check(session.body.split('\r\n').filter(Boolean).length > 5, 'and a row for every group in the session')

  const flow = await csv('/api/export.csv?flow=ui-order-tree')
  check(flow.status === 200 && flow.body.includes('per Orders'), 'one flow can be exported on its own')
  check(/Open-order-tree/.test(flow.name), 'named after the flow', flow.name)

  const groupId = await tree.evaluate((el) => el.querySelector('.group')?.dataset.key)
  const call = await csv(`/api/export.csv?flow=ui-order-tree&group=${groupId}`)
  check(call.status === 200, 'and so can a single call')
  check(call.body.split('\r\n')[1].startsWith('Flow;Operation;Table;#;At'), 'as one row per execution', call.body.split('\r\n')[1].slice(0, 40))

  const missing = await csv('/api/export.csv?flow=does-not-exist')
  check(missing.status === 404, 'an unknown flow is a 404, not an empty spreadsheet', String(missing.status))

  // The buttons that reach those routes: one export menu per row, flow and group.
  check((await tree.locator('.arow button[data-act="export-menu"]').count()) === 1, 'the flow row has an export button')
  check((await tree.locator('.grow button[data-act="export-menu"]').count()) >= 3, 'and so does every query group')

  const toolbar = await page.locator('#exportCsvBtn').getAttribute('href')
  check(toolbar === '/api/export.csv', 'the toolbar Export button points at the spreadsheet', String(toolbar))
  check((await page.locator('#exportBtn').getAttribute('href')) === '/api/export', 'with JSON still available beside it')
}

// --- the row must not wrap --------------------------------------------------
// Every cell of a flow row lives in one grid column. A new cell without a column
// silently pushes the row tools onto a second line, which is easy to miss.
const heights = await page.evaluate(() =>
  [...document.querySelectorAll('#list .arow')].map((r) => Math.round(r.getBoundingClientRect().height)),
)
check(Math.max(...heights) - Math.min(...heights) <= 2, 'every flow row is the same height (no wrapped cells)', heights.join(','))
// The columns must line up from row to row. Each row is its own grid, so a
// column sized to its content (the growth chip only some rows have) shifts the
// time and query columns of exactly those rows.
const columns = await page.evaluate(() =>
  ['.rowtime', '.nums', '.rowtools'].map((sel) => [
    ...new Set([...document.querySelectorAll(`#list .arow ${sel}`)].map((el) => Math.round(el.getBoundingClientRect().left))),
  ]),
)
check(columns.every((lefts) => lefts.length === 1), 'time, query and tool columns line up on every row', JSON.stringify(columns))

// Rows are two lines by design (name over finding); a wrapped cell would add a third.
check(Math.max(...heights) < 64, 'and none of them wrapped onto a third line', `tallest ${Math.max(...heights)}px`)

const groupHeights = await page.evaluate(() =>
  [...document.querySelectorAll('#list .grow')].map((r) => Math.round(r.getBoundingClientRect().height)),
)
check(
  groupHeights.length > 0 && Math.max(...groupHeights) - Math.min(...groupHeights) <= 2,
  'every query-group row is the same height too',
  groupHeights.join(','),
)
check(Math.max(...groupHeights) < 42, 'the kind and growth badges do not wrap a group row', `tallest ${Math.max(...groupHeights)}px`)

// --- screenshot -------------------------------------------------------------
// The nested flow was opened earlier and never closed, so it is already showing.
const shot = page.locator('#list .action', { hasText: 'Open order tree' })
check((await shot.locator('.group').count()) >= 3, 'the opened flow still shows its groups after filtering')
await page.waitForTimeout(300)
await page.screenshot({ path: out, fullPage: false })
console.log(`\nscreenshot -> ${out}`)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
