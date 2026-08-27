import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.mjs'
import * as projects from './projects.mjs'

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
  slowMs: Number(process.env.DBPROBE_SLOW_MS ?? 200),
})

/** Everything the UI needs, including how to attach a probe when none is connected. */
function snapshot() {
  return {
    ...store.summary(),
    probePath: PROBE_PATH,
    toolRoot: TOOL_ROOT,
    dataRoot: projects.DATA_ROOT,
    apiPorts: projects.loadSettings().apiPorts,
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

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value))
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

  if (req.method === 'OPTIONS') return send(res, 204, '')

  if (route === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
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

  if (route === '/api/action' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.id) return json(res, 400, { error: 'id required' })
    store.registerAction(body)
    return json(res, 200, { ok: true })
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
      'Access-Control-Allow-Origin': '*',
    })
    return res.end(JSON.stringify(store.exportAll(), null, 2))
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
      const body = await readBody(req)
      const saved = projects.saveSettings({ apiPorts: body.apiPorts })
      store.version++
      return json(res, 200, { ...saved, uiPort: HTTP_PORT, ingestPort: INGEST_PORT })
    }
    return json(res, 200, { ...projects.loadSettings(), uiPort: HTTP_PORT, ingestPort: INGEST_PORT })
  }

  if (route === '/api/health') {
    return json(res, 200, { ok: true, apps: [...store.apps.values()], version: store.version })
  }

  return serveStatic(res, route)
})

server.listen(HTTP_PORT, '127.0.0.1', () => {
  process.stdout.write(`[dbprobe] overlay UI on http://127.0.0.1:${HTTP_PORT}\n`)
})
