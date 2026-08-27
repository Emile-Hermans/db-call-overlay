/**
 * Runs in the page's own world so it can wrap the fetch/XHR the app actually uses.
 * Its whole job: know which control the user just touched, and stamp that onto
 * every backend call the app makes because of it.
 */
;(() => {
  const IDLE_MS = 4000 // an action owns the calls that follow it for this long
  const HDR_ACTION = 'X-DbProbe-Action'
  const HDR_LABEL = 'X-DbProbe-Label'
  const HDR_KIND = 'X-DbProbe-Kind'

  // Which ports count as "one of my APIs". Fetched from the app so a different
  // port only has to be changed in one place, in Settings.
  const FALLBACK_PORTS = [1337, 2337, 3337, 4337, 11337, 12337, 13337]
  let apiPorts = new Set(FALLBACK_PORTS)
  let uiPort = 8478

  // bridge.js pushes the port list in; it can reach the app, this world cannot.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data?.__dbprobe || data.type !== 'config') return

    const config = data.config ?? {}
    if (Array.isArray(config.apiPorts) && config.apiPorts.length) {
      apiPorts = new Set(config.apiPorts.map(Number))
    }
    if (config.uiPort) uiPort = Number(config.uiPort)
    try {
      document.documentElement.dataset.dbprobePorts = [...apiPorts].join(',')
    } catch {}
  })

  // Never tag from the overlay's own page, or from a page served by an API itself.
  const herePort = Number(location.port)
  if (herePort === uiPort || apiPorts.has(herePort)) {
    return
  }

  const isBackend = (url) => {
    try {
      const u = new URL(url, location.href)
      return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) && apiPorts.has(Number(u.port))
    } catch {
      return false
    }
  }

  let current = null
  let counter = 0

  const b64 = (text) => {
    try {
      return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    } catch {
      return ''
    }
  }

  function active() {
    if (!current) return null
    const since = current.lastCallAt ?? current.startedAt
    if (Date.now() - since > IDLE_MS) {
      current = null
      return null
    }
    return current
  }

  function stamp(action) {
    action.lastCallAt = Date.now()
    return action
  }

  // ------------------------------------------------------------- labelling

  const CLICKABLE = 'button, a[href], [role="button"], [role="tab"], [role="option"], input[type="submit"], .v-btn, .v-list-item, .v-tab, [data-cy]'

  function prettify(raw) {
    return String(raw)
      .replace(/^(btn|button|icon|link|action|cy)[-_]?/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .trim()
      .replace(/^./, (c) => c.toUpperCase())
  }

  function labelOf(el) {
    if (!el) return null

    const text = (el.innerText ?? '').trim().replace(/\s+/g, ' ')
    if (text && text.length <= 45) return text

    const aria = el.getAttribute?.('aria-label') || el.getAttribute?.('title')
    if (aria) return aria.trim()

    const cy = el.getAttribute?.('data-cy')
    if (cy) return prettify(cy)

    if (text) return text.slice(0, 45) + '…'

    const icon = el.querySelector?.('.v-icon')
    if (icon?.className) {
      const m = String(icon.className).match(/mdi-([\w-]+)/)
      if (m) return prettify(m[1])
    }
    return null
  }

  function describe(el) {
    const cy = el.closest?.('[data-cy]')?.getAttribute('data-cy')
    const tag = el.tagName?.toLowerCase()
    return [cy ? `data-cy=${cy}` : null, tag].filter(Boolean).join(' · ')
  }

  function begin(label, kind, el) {
    if (!label) return
    current = {
      id: `ui-${Date.now()}-${++counter}`,
      label,
      kind,
      startedAt: Date.now(),
      lastCallAt: null,
      dom: el ? describe(el) : null,
      url: location.pathname,
    }
    announce(current)
  }

  /** Handed to bridge.js, which is the side that can reach the app. */
  function announce(action) {
    try {
      window.postMessage(
        {
          __dbprobe: true,
          type: 'action',
          action: {
            id: action.id,
            label: action.label,
            kind: action.kind,
            dom: action.dom,
            url: action.url,
            ts: action.startedAt,
          },
        },
        '*',
      )
    } catch {}
  }

  // --------------------------------------------------------------- capture

  document.addEventListener(
    'pointerdown',
    (event) => {
      try {
        const el = event.target?.closest?.(CLICKABLE)
        const label = labelOf(el)
        if (label) begin(label, 'click', el)
      } catch {}
    },
    true,
  )

  document.addEventListener(
    'change',
    (event) => {
      try {
        const el = event.target
        if (!el?.tagName) return
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
          const field =
            el.getAttribute('data-cy') ||
            el.getAttribute('name') ||
            el.closest('.v-input')?.querySelector('label')?.innerText ||
            el.getAttribute('aria-label')
          if (field) begin(`Change ${prettify(field)}`, 'change', el)
        }
      } catch {}
    },
    true,
  )

  const announceNavigation = () => begin(`Open ${location.pathname}`, 'navigate', null)
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    history[method] = function (...args) {
      const result = original.apply(this, args)
      setTimeout(announceNavigation, 0)
      return result
    }
  }
  window.addEventListener('popstate', announceNavigation)
  window.addEventListener('DOMContentLoaded', announceNavigation)

  // ----------------------------------------------------------- fetch / XHR

  const originalFetch = window.fetch.bind(window)

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url
      const action = isBackend(url) ? active() : null

      if (action) {
        stamp(action)
        const request = new Request(input, init)
        request.headers.set(HDR_ACTION, action.id)
        request.headers.set(HDR_LABEL, b64(action.label))
        request.headers.set(HDR_KIND, action.kind)
        return originalFetch(request)
      }
    } catch {}
    return originalFetch(input, init)
  }

  const open = XMLHttpRequest.prototype.open
  const send = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dbprobeUrl = url
    return open.call(this, method, url, ...rest)
  }

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const action = isBackend(this.__dbprobeUrl) ? active() : null
      if (action) {
        stamp(action)
        this.setRequestHeader(HDR_ACTION, action.id)
        this.setRequestHeader(HDR_LABEL, b64(action.label))
        this.setRequestHeader(HDR_KIND, action.kind)
      }
    } catch {}
    return send.apply(this, args)
  }

  console.info('[db-call-overlay] action tagger active')
})()
