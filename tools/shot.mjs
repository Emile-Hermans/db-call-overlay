// Dev helper: render the overlay and screenshot it (needs playwright on PATH).
//   npx playwright ... ; node tools/shot.mjs out.png
import { chromium } from 'playwright'

const out = process.argv[2] ?? 'overlay.png'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
page.on('console', (m) => console.log('[page]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto('http://127.0.0.1:8478/', { waitUntil: 'networkidle' })
await page.waitForSelector('.action', { timeout: 8000 })

await page.locator('.action.red .arow').first().click()
await page.waitForSelector('.action.red .group', { timeout: 5000 })
await page.locator('.action.red .group .grow').first().click()
await page.waitForTimeout(600)

await page.screenshot({ path: out, fullPage: true })
console.log('actions:', await page.locator('.action').count(), 'groups:', await page.locator('.group').count())
await browser.close()
