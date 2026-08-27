// Loads the real unpacked extension and checks that a click is labelled and that
// only the configured API ports get tagged.
//
// Needs the app (or `node server/index.mjs`) running, because the extension asks
// it which ports to tag.
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION = process.argv[2] ?? path.resolve(HERE, '..', 'extension')
const COLLECTOR = 'http://127.0.0.1:8478'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dbprobe-ext-'))
const context = await chromium.launchPersistentContext(profile, {
  // Chrome only loads unpacked extensions in a headed browser, so this test
  // briefly opens a window. That is expected.
  headless: false,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
})

const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

// Ports the app is configured with for this run.
const configured = await (await fetch(`${COLLECTOR}/api/config`)).json()
const tagged = new Set(configured.apiPorts.map(Number))
console.log('configured API ports:', [...tagged].join(', '))

const captured = []
await page.route('**://*/api/**', async (route) => {
  const url = route.request().url()
  if (url.startsWith(COLLECTOR)) return route.continue() // the extension's own traffic

  captured.push({ url, headers: route.request().headers() })
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: '{}',
  })
})

// Stand-in for the app's frontend: a normal localhost page, not the overlay, not an API.
await page.route('http://localhost:3000/', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'text/html',
    body:
      '<!doctype html><meta charset="utf-8"><body>' +
      '<button id="t" data-cy="btn-recalculate-order">Recalculate order</button>' +
      '<button id="t2" data-cy="btn-save-lines"><span class="v-icon mdi-content-save"></span></button>' +
      '</body>',
  }),
)

await page.goto('http://localhost:3000/')

// Wait for the bridge to actually deliver the port list rather than guessing a delay.
await page
  .waitForFunction(() => document.documentElement.dataset.dbprobePorts, null, { timeout: 15000 })
  .catch(() => console.log('WARN  the port list never reached the page — falling back to defaults'))

console.log('bridge  :', await page.evaluate(() => document.documentElement.dataset.dbprobeBridge ?? '(did not run)'))
console.log('in page :', await page.evaluate(() => document.documentElement.dataset.dbprobePorts ?? '(config never arrived)'))

// The interesting cases are the ones the built-in defaults would get wrong:
// a configured port that is NOT a default, and a default that was removed.
const DEFAULTS = [1337, 2337, 3337, 4337, 11337, 12337, 13337]
const configuredNonDefault = [...tagged].find((p) => !DEFAULTS.includes(p)) ?? [...tagged][0]
const removedDefault = DEFAULTS.find((p) => !tagged.has(p)) ?? 9991

console.log(`configured but not a default: ${configuredNonDefault} (must be tagged)`)
console.log(`default but not configured  : ${removedDefault} (must NOT be tagged)`)

async function run(selector, url) {
  await page.click(selector)
  await page.evaluate((u) => fetch(u, { method: 'POST' }).catch(() => {}), url)
  await page.waitForTimeout(300)
}

await run('#t', `http://localhost:${configuredNonDefault}/api/Orders/Recalculate`)
await run('#t2', `http://localhost:${removedDefault}/api/Orders/Save`)

let failures = 0
const decode = (v) => (v ? Buffer.from(v, 'base64').toString('utf8') : null)

for (const { url, headers } of captured) {
  const id = headers['x-dbprobe-action']
  const label = decode(headers['x-dbprobe-label'])
  const port = Number(new URL(url).port)
  const shouldTag = tagged.has(port)
  const ok = shouldTag ? Boolean(id) : !id
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  :${port}  tagged=${Boolean(id)} expected=${shouldTag}  label=${label ?? '-'}`)
}

const label = captured.map((c) => decode(c.headers['x-dbprobe-label'])).find(Boolean)
if (label !== 'Recalculate order') {
  console.log(`FAIL  expected the click label "Rebuild totals", got "${label}"`)
  failures++
}

// The bridge must have reached the app with the action's context.
const state = await (await fetch(`${COLLECTOR}/api/health`)).json()
if (!state.ok) {
  console.log('FAIL  collector not reachable')
  failures++
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
await context.close()
fs.rmSync(profile, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
