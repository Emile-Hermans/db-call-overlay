/**
 * Runs in the extension's isolated world. Its only job is to talk to the app:
 * a page cannot reach 127.0.0.1 itself (Chrome blocks requests into the loopback
 * address space), but an extension with host permissions can. inject.js does the
 * DOM and fetch work in the page world and exchanges messages with this file.
 *
 * The last known port list is cached, so a page that is clicked immediately after
 * it loads is already tagging against the right ports instead of the defaults.
 */
;(() => {
  const COLLECTOR_ORIGIN = 'http://127.0.0.1:8478'
  const CACHE_KEY = 'dbprobe.config'
  const REFRESH_MS = 60000

  const post = (message) => window.postMessage({ ...message, __dbprobe: true }, '*')

  const mark = (value) => {
    try {
      document.documentElement.dataset.dbprobeBridge = value
    } catch {
      // document_start on a document that has no element yet
    }
  }

  async function pushCached() {
    try {
      const cached = await chrome.storage.local.get(CACHE_KEY)
      if (cached?.[CACHE_KEY]) post({ type: 'config', config: cached[CACHE_KEY] })
    } catch {}
  }

  async function pushConfig() {
    try {
      const response = await fetch(`${COLLECTOR_ORIGIN}/api/config`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const config = await response.json()
      post({ type: 'config', config })
      mark('ok')
      try {
        await chrome.storage.local.set({ [CACHE_KEY]: config })
      } catch {}
    } catch (err) {
      mark(`failed: ${err.message}`)
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data?.__dbprobe || data.type !== 'action') return

    fetch(`${COLLECTOR_ORIGIN}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data.action),
      keepalive: true,
    }).catch(() => {})
  })

  pushCached()
  pushConfig()
  setInterval(pushConfig, REFRESH_MS)
})()
