import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.mjs'
import * as projects from './projects.mjs'
import { sessionCsv, flowCsv, callCsv, csvFileName } from './csv.mjs'
import { createLoopSource } from './loops.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(HERE, '..', 'ui')

const INGEST_PORT = Number(process.env.DBPROBE_PORT ?? 8477)
const HTTP_PORT = Number(process.env.DBPROBE_UI_PORT ?? 8478)

/** Where the probe DLL is, so the UI can show a command that can be pasted as-is. */
function locateProbe() {
  const candidates = [
    process.env.DBPROBE_DLL,
    path.join(HERE, '..', 'probe', 'bin', 'Release', 'net8.0', 'DbProbe.dll'),
    path.join(HERE, '..', 'probe', 'DbProbe.dll'),
  ]
  return candidates.find((file) => file && fs.existsSync(file)) ?? null
}

const PROBE_PATH = locateProbe()
const TOOL_ROOT = path.resolve(HERE, '..')

const store = new Store({
  // Optional override; by default file paths are shortened by recognising the
  // solution's own top-level folders, which works on any checkout or machine.
  repoRoots: (process.env.DBPROBE_REPO_ROOTS ?? '').split(';').filter(Boolean),
  ...projects.loadSettings().thresholds,
  // An explicit environment variable still wins, so an existing setup keeps working.
  ...(process.env.DBPROBE_SLOW_MS ? { slowMs: Number(process.env.DBPROBE_SLOW_MS) } : {}),
})

// A static loop report, if one is configured. Re-read when the file changes, so
// re-running the analyser is enough to refresh what the overlay shows.
const loadLoops = createLoopSource()
let loopStatus = { configured: false }

function refreshLoops() {
  const { index, status } = loadLoops(projects.loadSettings().loopReport)
  loopStatus = status
  if ((store.cfg.loops ?? null) !== index) store.setThresholds({ loops: index })
}
refreshLoops()
setInterval(refreshLoops, 5000).unref()

/** Everything the UI needs, including how to attach a probe when none is connected. */
function snapshot() {
  return {
    ...store.summary(),
    probePath: PROBE_PATH,
    toolRoot: TOOL_ROOT,
    dataRoot: projects.DATA_ROOT,
    apiPorts: projects.loadSettings().apiPorts,
    thresholds: projects.loadSettings().thresholds,
    loops: loopStatus,
    // The one recording control that is not a setting: it is read by the probe as
    // a process starts, so the UI can only report what the running probes used.
    paramsCaptured: process.env.DBPROBE_PARAMS !== 'off',
  }
}

// A flow still being recorded when the app closes would otherwise be lost.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    store.flushPendingSaves()
    process.exit(0)
  })
}

// ------------------------------------------------------------------ ingest

const ingest = net.createServer((socket) => {
  socket.setNoDelay(true)
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        store.ingest(JSON.parse(line))
      } catch (err) {
        process.stderr.write(`[ingest] bad line: ${err.message}\n`)
      }
    }
    if (buffer.length > 8 * 1024 * 1024) buffer = ''
  })

  socket.on('error', () => {})
})

ingest.listen(INGEST_PORT, '127.0.0.1', () => {
  process.stdout.write(`[dbprobe] ingest listening on 127.0.0.1:${INGEST_PORT}\n`)
})

// -------------------------------------------------------------------- SSE

const clients = new Set()
let lastVersion = -1

setInterval(() => {
  if (store.version === lastVersion || clients.size === 0) return
  lastVersion = store.version
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}, 400)

// ------------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Recorded SQL contains parameter values - real data from whatever database was
 * being used. It must not be readable by any web page that happens to be open,
 * so cross-origin access is granted per endpoint rather than globally.
 *
 * Only two endpoints need it: the browser extension asks for the port list and
 * posts the label of the control that was clicked. Neither reveals a recording.
 */
const PUBLIC_ENDPOINTS = new Set(['/api/config', '/api/action'])

const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${HTTP_PORT}`,
  `http://localhost:${HTTP_PORT}`,
])

/** True when the request came from the overlay itself, or from no page at all. */
function isSameOrigin(req) {
  const origin = req.headers.origin
  return !origin || SELF_ORIGINS.has(origin)
}

function send(res, status, body, type = 'application/json; charset=utf-8', cors = false) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // A page must not be able to guess at these being HTML and framing them.
    'X-Content-Type-Options': 'nosniff',
  }

  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*'
    headers['Access-Control-Allow-Headers'] = 'Content-Type'
    headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
  }

  res.writeHead(status, headers)
  res.end(body)
}

function json(res, status, value, cors = false) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', cors)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.join(UI_DIR, rel)
  if (!file.startsWith(UI_DIR)) return send(res, 403, 'forbidden', 'text/plain')

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain')
    send(res, 200, data, MIME[path.extname(file)] ?? 'application/octet-stream')
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = url.pathname

  // Preflight is only meaningful for the two endpoints the extension uses.
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', 'text/plain', PUBLIC_ENDPOINTS.has(route))
  }

  // Everything that changes state must come from the overlay itself. Without
  // this, any open web page could clear a recording or delete a project.
  if (req.method === 'POST' && !PUBLIC_ENDPOINTS.has(route) && !isSameOrigin(req)) {
    return json(res, 403, { error: 'Cross-origin requests are not allowed for this endpoint.' })
  }

  if (route === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (route === '/api/state') return json(res, 200, snapshot())

  if (route.startsWith('/api/action/')) {
    const detail = store.detail(decodeURIComponent(route.slice('/api/action/'.length)))
    return detail ? json(res, 200, detail) : json(res, 404, { error: 'unknown action' })
  }

  // The browser extension posts the label of the control that was clicked. It
  // adds context to a recording; it cannot read one.
  if (route === '/api/action' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.id) return json(res, 400, { error: 'id required' }, true)
    store.registerAction(body)
    return json(res, 200, { ok: true }, true)
  }

  if (route === '/api/mark' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, body.stop ? (store.clearManual(), { ok: true }) : store.setManual(body.label))
  }

  if (route === '/api/clear' && req.method === 'POST') {
    store.reset()
    lastVersion = -1
    return json(res, 200, { ok: true })
  }

  if (route === '/api/record' && req.method === 'POST') {
    const body = await readBody(req)
    store.recording = body.on !== false
    store.version++
    return json(res, 200, { recording: store.recording })
  }

  if (route === '/api/export') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="db-calls-${Date.now()}.json"`,
      'Cache-Control': 'no-store',
    })
    return res.end(JSON.stringify(store.exportAll(), null, 2))
  }

  /**
   * The same report as a spreadsheet. All three scopes are served from here
   * rather than built in the browser, so the Excel-specific details (delimiter,
   * BOM, formula neutralisation) exist in exactly one place.
   *
   *   /api/export.csv                        every query group of every flow
   *   /api/export.csv?flow=<id>              every query group of one flow
   *   /api/export.csv?flow=<id>&group=<id>   every execution of one query group
   */
  if (route === '/api/export.csv') {
    const flowId = url.searchParams.get('flow')
    const groupId = url.searchParams.get('group')
    const factor = projects.loadSettings().thresholds.projectionFactor
    const day = new Date().toISOString().slice(0, 10)

    let csv
    let name

    if (flowId) {
      const action = store.detail(flowId)
      if (!action) return json(res, 404, { error: 'unknown flow' })

      if (groupId) {
        const group = action.groups.find((g) => g.id === groupId)
        if (!group) return json(res, 404, { error: 'unknown call' })
        csv = callCsv(action, group)
        name = csvFileName([day, group.op, group.table ?? 'call', action.label])
      } else {
        csv = flowCsv(action, factor)
        name = csvFileName([day, action.label])
      }
    } else {
      csv = sessionCsv(store.list(), factor)
      name = csvFileName([day, 'db-calls'])
    }

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    return res.end(csv)
  }

  // ---------------------------------------------------------- projects

  if (route === '/api/projects') return json(res, 200, projects.listProjects())

  if (route === '/api/projects/create' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const created = projects.createProject(body.name)
      store.openProject(created.folder)
      return json(res, 200, created)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  if (route === '/api/projects/open' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      if (!body.folder) {
        store.closeProject()
        return json(res, 200, { project: null })
      }
      return json(res, 200, { project: store.openProject(body.folder) })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  if (route === '/api/projects/rename' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const renamed = projects.renameProject(body.folder, body.name)
      if (store.project?.folder === renamed.folder) store.project.name = renamed.name
      store.version++
      return json(res, 200, renamed)
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  if (route === '/api/projects/delete' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      if (store.project?.folder === body.folder) store.closeProject()
      projects.deleteProject(body.folder)
      store.version++
      return json(res, 200, { ok: true })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }

  // -------------------------------------------------------------- flows

  if (route === '/api/flow/note' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, { ok: store.setNote(body.id, body.note) })
  }

  if (route === '/api/flow/delete' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, { ok: store.removeFlow(body.id) })
  }

  // ------------------------------------------------------------ config

  if (route === '/api/config') {
    if (req.method === 'POST') {
      // Writing settings is the overlay's own business.
      if (!isSameOrigin(req)) {
        return json(res, 403, { error: 'Cross-origin requests are not allowed for this endpoint.' })
      }
      const body = await readBody(req)
      const saved = projects.saveSettings({
        apiPorts: body.apiPorts,
        thresholds: body.thresholds,
        ...(typeof body.loopReport === 'string' ? { loopReport: body.loopReport.trim().replace(/^"(.*)"$/, '$1') } : {}),
      })
      // Changed thresholds mean every recording has to be judged again.
      store.setThresholds(saved.thresholds)
      refreshLoops()
      return json(res, 200, { ...saved, loops: loopStatus, uiPort: HTTP_PORT, ingestPort: INGEST_PORT })
    }

    // The overlay itself also gets the local report path; any other page only
    // the port list the browser extension needs - a file path is nobody else's business.
    const { loopReport, ...shared } = projects.loadSettings()
    if (isSameOrigin(req)) return json(res, 200, { ...shared, loopReport, loops: loopStatus, uiPort: HTTP_PORT, ingestPort: INGEST_PORT })
    return json(res, 200, { ...shared, uiPort: HTTP_PORT, ingestPort: INGEST_PORT }, true)
  }

  if (route === '/api/health') {
    // pid lets the desktop app stop a collector it did not start itself, so
    // closing the window never leaves one running.
    return json(res, 200, { ok: true, pid: process.pid, apps: [...store.apps.values()], version: store.version })
  }

  return serveStatic(res, route)
})

server.listen(HTTP_PORT, '127.0.0.1', () => {
  process.stdout.write(`[dbprobe] overlay UI on http://127.0.0.1:${HTTP_PORT}\n`)
})
