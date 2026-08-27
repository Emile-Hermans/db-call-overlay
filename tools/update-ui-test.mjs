// Drives the Settings update section with a stubbed desktop shell, so the UI can
// be tested without WebView2. Needs the collector running.
import { chromium } from 'playwright'

const UI = 'http://127.0.0.1:8478'
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

let failures = 0
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

// Stand in for window.chrome.webview: record what the page sends, and let the
// test push replies back exactly as the shell would.
await page.addInitScript(() => {
  const listeners = []
  window.__sent = []
  window.chrome = {
    webview: {
      postMessage: (m) => window.__sent.push(m),
      addEventListener: (_type, fn) => listeners.push(fn),
    },
  }
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }))
})

await page.goto(UI, { waitUntil: 'networkidle' })
await page.click('#settingsBtn')
await page.waitForSelector('#settingsDialog[open]')

check(!(await page.locator('#updateBox').isHidden()), 'update section is shown inside the desktop app')

// --- checking ---------------------------------------------------------------
await page.click('#updateCheck')
const sent = await page.evaluate(() => window.__sent.map((m) => m.type))
check(sent.includes('update-check'), 'Check for updates asks the shell', sent.join(','))

// --- an update is available -------------------------------------------------
await page.evaluate(() =>
  window.__reply({
    type: 'update',
    state: 'available',
    message: '2 updates available.',
    current: 'abc1234',
    currentDate: '2026-08-27',
    changes: ['Copy a single call', 'Readable labels'],
    dirty: false,
    canApply: true,
  }),
)
check((await page.locator('#updateMessage').innerText()).includes('2 updates'), 'reports how many updates')
check(await page.locator('#updateApply').isVisible(), '"Update now" appears when one is available')
check((await page.locator('#updateChanges').innerText()).includes('Copy a single call'), 'lists what changed')
check((await page.locator('#updateVersion').innerText()).includes('abc1234'), 'shows the current version')

// --- local changes block the update ----------------------------------------
await page.evaluate(() =>
  window.__reply({
    type: 'update',
    state: 'problem',
    message: 'There are local changes in this folder.',
    current: 'abc1234',
    currentDate: '2026-08-27',
    changes: [],
    dirty: true,
    canApply: false,
  }),
)
check(await page.locator('#updateApply').isHidden(), 'refuses to offer an update over local changes')
check((await page.locator('#updateVersion').innerText()).includes('local changes'), 'says the tree is dirty')
check(await page.locator('#updateMessage').evaluate((el) => el.classList.contains('bad')), 'problems are shown in red')

// --- already current --------------------------------------------------------
await page.evaluate(() =>
  window.__reply({
    type: 'update',
    state: 'current',
    message: 'You have the latest version.',
    current: 'abc1234',
    currentDate: '2026-08-27',
    changes: [],
    dirty: false,
    canApply: false,
  }),
)
check(await page.locator('#updateApply').isHidden(), 'no button when already up to date')
check(await page.locator('#updateChanges').isHidden(), 'no change list when there is nothing to change')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
