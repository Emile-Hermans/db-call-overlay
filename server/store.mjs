import { shred } from './sql.mjs'
import { analyzeAction, summarise, DEFAULTS } from './analyze.mjs'
import * as projects from './projects.mjs'

const AUTO_IDLE_MS = 1500
const MAX_ACTIONS = 400
const MAX_CALLS = 60000
/** How long a flow must be quiet before it is written to the project. */
const SAVE_DEBOUNCE_MS = 1200

export class Store {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options }
    this.repoRoots = options.repoRoots ?? []
    // Folder names that commonly START a repository-relative path. Deliberately
    // distinctive: generic words like "app" or "server" also appear as UNC hosts
    // and mid-path folders, and would cut in the wrong place.
    this.sourceRoots = options.sourceRoots ?? [
      'src', 'source', 'lib', 'libs', 'packages', 'projects', 'modules',
      'Core', 'Domain', 'Infrastructure', 'Application', 'Persistence',
      'Endpoints', 'Frontend', 'Backend', 'WebApi', 'Tests',
    ]
    this.project = null
    this._saveTimers = new Map()
    this.reset()
  }

  reset() {
    this.cancelPendingSaves()
    this.startedAt = Date.now()
    this.recording = true
    this.actions = new Map()
    this.order = []
    this.requests = new Map()
    this.callsByCommandId = new Map()
    this.apps = new Map()
    this.dropped = 0
    this.seq = 0
    this.auto = null
    this.manual = null
    this._analysis = new Map()
    this.version = 0
  }

  // ---------------------------------------------------------------- projects

  /** Opens a project: its saved flows become the list, new recordings are added to it. */
  openProject(folder) {
    const known = projects.listProjects().find((p) => p.folder === folder)
    if (!known) throw new Error('Unknown project.')

    this.flushPendingSaves()
    this.reset()
    this.project = { folder: known.folder, name: known.name }

    for (const flow of projects.loadFlows(folder)) {
      this.rehydrate(flow)
    }

    this.version++
    return this.project
  }

  closeProject() {
    this.flushPendingSaves()
    this.project = null
    this.reset()
    this.version++
  }

  /** Rebuilds an in-memory action from a saved flow, re-parsing the SQL as it goes. */
  rehydrate(flow) {
    const action = this.ensureAction(flow.id, {
      label: flow.label,
      kind: flow.kind,
      url: flow.url,
      dom: flow.dom,
      startedAt: flow.startedAt,
    })

    action.explicit = true
    action.saved = true
    action.note = flow.note ?? ''
    action.endedAt = flow.endedAt ?? flow.startedAt
    action.requests = flow.requests ?? []
    action.saveChanges = flow.saveChanges ?? []
    action.calls = (flow.calls ?? []).map((call) => ({
      ...call,
      seq: ++this.seq,
      statements: shred(call.sql, call.params).statements,
    }))

    this._analysis.delete(action.id)
    return action
  }

  scheduleSave(action) {
    if (!this.project || !action || action.calls.length === 0) return

    clearTimeout(this._saveTimers.get(action.id))
    this._saveTimers.set(
      action.id,
      setTimeout(() => {
        this._saveTimers.delete(action.id)
        this.saveNow(action.id)
      }, SAVE_DEBOUNCE_MS),
    )
  }

  saveNow(actionId) {
    if (!this.project) return
    const action = this.actions.get(actionId)
    if (!action || action.calls.length === 0) return

    try {
      projects.saveFlow(this.project.folder, action)
      action.saved = true
      this.version++
    } catch (err) {
      process.stderr.write(`[projects] could not save flow: ${err.message}\n`)
    }
  }

  flushPendingSaves() {
    for (const [id, timer] of this._saveTimers) {
      clearTimeout(timer)
      this.saveNow(id)
    }
    this._saveTimers.clear()
  }

  cancelPendingSaves() {
    for (const timer of this._saveTimers?.values() ?? []) clearTimeout(timer)
    this._saveTimers?.clear()
  }

  setNote(actionId, note) {
    const action = this.actions.get(actionId)
    if (!action) return false

    action.note = String(note ?? '').slice(0, 8000)
    this._analysis.delete(actionId)
    if (this.project && action.calls.length) {
      projects.saveFlow(this.project.folder, action)
      action.saved = true
    }
    this.version++
    return true
  }

  removeFlow(actionId) {
    const action = this.actions.get(actionId)
    clearTimeout(this._saveTimers.get(actionId))
    this._saveTimers.delete(actionId)

    this.actions.delete(actionId)
    this._analysis.delete(actionId)
    this.order = this.order.filter((id) => id !== actionId)

    if (this.project && action) projects.deleteFlow(this.project.folder, actionId)
    this.version++
    return Boolean(action)
  }

  // -------------------------------------------------------------- ingestion

  ingest(event) {
    switch (event.kind) {
      case 'hello':
        this.apps.set(`${event.app}#${event.pid}`, { app: event.app, pid: event.pid, since: Date.now() })
        this.version++ // so the UI can switch out of the "no probe attached" state
        break
      case 'req':
        this.onRequest(event)
        break
      case 'reqend':
        this.onRequestEnd(event)
        break
      case 'sql':
        this.onSql(event)
        break
      case 'sqlrows':
        this.onSqlRows(event)
        break
      case 'savechanges':
        this.onSaveChanges(event)
        break
      case 'dropped':
        this.dropped += event.count ?? 0
        this.version++
        break
    }
  }

  onRequest(event) {
    if (!this.recording) return
    const action = this.actionFor(event)
    const req = {
      id: event.id,
      actionId: action.id,
      app: event.app,
      method: event.method,
      path: event.path,
      startedAt: event.ts,
    }
    this.requests.set(event.id, req)
    action.requests.push(req)
    this.touch(action, event.ts)
  }

  onRequestEnd(event) {
    const req = this.requests.get(event.id)
    if (!req) return
    req.durationMs = event.durationMs
    req.status = event.status
    req.handler = event.handler
    this.invalidate(req.actionId)
  }

  onSql(event) {
    if (!this.recording) return

    const action = this.actionFor(event)
    const { statements, scaffolding } = shred(event.sql, event.params)

    const call = {
      id: event.id,
      actionId: action.id,
      seq: ++this.seq,
      ts: event.ts,
      durationMs: event.durationMs ?? 0,
      rowsAffected: event.rowsAffected ?? -1,
      rowsRead: -1,
      app: event.app,
      db: event.db,
      source: event.source,
      exec: event.exec,
      error: event.error ?? null,
      reqId: event.reqId ?? null,
      handler: event.handler ?? this.requests.get(event.reqId)?.handler ?? null,
      path: event.path ?? null,
      httpMethod: event.httpMethod ?? null,
      sql: event.sql,
      params: event.params ?? [],
      stack: (event.stack ?? []).map((f) => ({ ...f, f: this.shortenPath(f.f), a: f.f })),
      statements,
      scaffolding,
    }

    action.calls.push(call)
    if (event.commandId) this.callsByCommandId.set(event.commandId, call)
    this.touch(action, event.ts)
    this.trim()
  }

  onSqlRows(event) {
    const call = this.callsByCommandId.get(event.commandId)
    if (!call) return

    if (event.rowsRead !== undefined) call.rowsRead = event.rowsRead
    if (call.rowsAffected <= 0 && event.recordsAffected > 0) {
      call.rowsAffected = event.recordsAffected
    }

    // How many rows a tracked EF save actually wrote.
    //
    // SaveChanges does not use ExecuteNonQuery, so CommandExecuted carries a
    // DbDataReader instead of a count, and RecordsAffected is -1/0 because EF sets
    // NOCOUNT ON. What EF does do is append OUTPUT 1 (SQL Server) / RETURNING 1
    // (SQLite) to every statement for its concurrency check, so the rows handed
    // back by the reader ARE the rows written. That is what ReadCount counts.
    const writesOnly =
      call.statements?.length > 0 && call.statements.every((s) => s.op !== 'SELECT')

    if (writesOnly && call.rowsAffected <= 0 && call.rowsRead > 0) {
      call.rowsAffected = call.rowsRead
      call.rowsAffectedDerived = true
    }

    this.invalidate(call.actionId)
  }

  onSaveChanges(event) {
    if (!this.recording) return
    const action = this.actionFor(event)
    action.saveChanges.push({
      ts: event.ts,
      entities: event.entities ?? 0,
      stack: (event.stack ?? []).map((f) => ({ ...f, f: this.shortenPath(f.f), a: f.f })),
    })
    this.touch(action, event.ts)
  }

  // ------------------------------------------------------------ action mgmt

  /** Called by the browser extension the instant a control is clicked. */
  registerAction({ id, label, kind, url, dom, ts }) {
    const action = this.ensureAction(id, {
      label: label || 'Interaction',
      kind: kind || 'click',
      url,
      dom,
      startedAt: ts || Date.now(),
    })
    action.label = label || action.label
    action.kind = kind || action.kind
    action.url = url ?? action.url
    action.dom = dom ?? action.dom
    action.explicit = true
    this.invalidate(action.id)
    return action
  }

  /** Overlay "Start marker" button: name a burst by hand, no extension needed. */
  setManual(label) {
    const now = Date.now()
    this.manual = { id: `manual-${now}`, label: label || 'Manual marker', startedAt: now }
    this.auto = null
    this.version++
    return this.manual
  }

  clearManual() {
    this.manual = null
    this.auto = null
    this.version++
  }

  ensureAction(id, seed) {
    let action = this.actions.get(id)
    if (action) return action

    action = {
      id,
      label: seed.label,
      kind: seed.kind,
      url: seed.url ?? null,
      dom: seed.dom ?? null,
      note: '',
      saved: false,
      explicit: false,
      startedAt: seed.startedAt ?? Date.now(),
      endedAt: seed.startedAt ?? Date.now(),
      calls: [],
      requests: [],
      saveChanges: [],
    }
    this.actions.set(id, action)
    this.order.push(id)
    this.version++
    return action
  }

  actionFor(event) {
    if (event.actionId) {
      const action = this.ensureAction(event.actionId, {
        label: event.actionLabel || 'Interaction',
        kind: event.actionKind || 'click',
        startedAt: event.ts,
      })
      if (event.actionLabel && !action.explicit) action.label = event.actionLabel
      this.auto = null
      return action
    }
    return this.autoAction(event)
  }

  /**
   * No label from the browser: fall back to bursts. Everything that happens
   * within AUTO_IDLE_MS of the previous database work belongs to one action.
   */
  autoAction(event) {
    const now = event.ts ?? Date.now()

    // A manual marker beats burst detection: everything until "stop" is one action.
    if (this.manual) {
      const action = this.ensureAction(this.manual.id, {
        label: this.manual.label,
        kind: 'manual',
        startedAt: this.manual.startedAt,
      })
      action.explicit = true
      return action
    }

    if (this.auto && now - this.auto.lastTs <= AUTO_IDLE_MS) {
      this.auto.lastTs = now
      const action = this.actions.get(this.auto.id)
      if (action) {
        this.nameAuto(action, event)
        return action
      }
    }

    const id = `auto-${this.order.length + 1}-${now}`
    this.auto = { id, lastTs: now }
    const action = this.ensureAction(id, {
      label: 'Unlabelled burst',
      kind: 'auto',
      startedAt: now,
    })
    this.nameAuto(action, event)
    return action
  }

  /**
   * Turns an endpoint into something readable.
   *   OrdersController.Recalculate            -> Orders / Recalculate
   *   /api/Orders/Recalculate/<guid>/<guid>/  -> Orders / Recalculate
   * Route values (ids, guids, flags) are dropped: they identify the row that was
   * clicked, not the thing that was done, and they make every label unreadable.
   */
  prettyEndpoint(handler, path) {
    if (handler) {
      return handler
        .split('.')
        .map((part) => part.replace(/Controller$/, ''))
        .filter(Boolean)
        .join(' / ')
    }

    if (!path) return null

    const isRouteValue = (segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || // guid
      /^\d+$/.test(segment) || // numeric id
      /^(true|false)$/i.test(segment) || // flag
      /^[0-9a-f]{16,}$/i.test(segment) // opaque hex id

    const parts = path
      .split('/')
      .filter(Boolean)
      .filter((segment, index) => !(index === 0 && /^api$/i.test(segment)))
      .filter((segment) => !isRouteValue(segment))

    return parts.length ? parts.join(' / ') : path
  }

  nameAuto(action, event) {
    if (action.explicit) return
    const name = this.prettyEndpoint(event.handler, event.path)
    if (!name) return
    if (action.label === 'Unlabelled burst') {
      action.label = name
      action._names = new Set([name])
    } else if (action._names && !action._names.has(name)) {
      action._names.add(name)
      const [first] = action._names
      action.label = action._names.size > 1 ? `${first} +${action._names.size - 1}` : first
    }
  }

  touch(action, ts) {
    action.endedAt = Math.max(action.endedAt ?? 0, ts ?? Date.now())
    this.invalidate(action.id)
    this.scheduleSave(action)
  }

  invalidate(actionId) {
    if (actionId) this._analysis.delete(actionId)
    this.version++
  }

  trim() {
    // These two only exist to correlate late-arriving events; bound them so a
    // long smoke-test session cannot grow them without limit.
    for (const map of [this.callsByCommandId, this.requests]) {
      if (map.size <= 30000) continue
      let drop = map.size - 20000
      for (const key of map.keys()) {
        map.delete(key)
        if (--drop <= 0) break
      }
    }

    let calls = 0
    for (const action of this.actions.values()) calls += action.calls.length

    // Saved flows are the whole point of a project - only unsaved ones age out.
    let index = 0
    while ((this.order.length > MAX_ACTIONS || calls > MAX_CALLS) && index < this.order.length - 1) {
      const id = this.order[index]
      const candidate = this.actions.get(id)
      if (candidate?.saved) {
        index++
        continue
      }
      this.order.splice(index, 1)
      calls -= candidate?.calls.length ?? 0
      this.actions.delete(id)
      this._analysis.delete(id)
    }
  }

  /**
   * Trims the machine-specific prefix so a frame reads as a repo path. Works
   * without configuration by cutting at the first recognised top-level folder of
   * the solution, which keeps it correct on any checkout, worktree or machine.
   */
  shortenPath(file) {
    if (!file) return file

    for (const root of this.repoRoots) {
      const at = file.toLowerCase().indexOf(root.toLowerCase())
      if (at >= 0) return file.slice(at + root.length).replace(/^[\\/]+/, '')
    }

    // A UNC host and share are not folders in the repository.
    const local = file.replace(/^\\\\[^\\]+\\[^\\]+/, '')

    // Cut at the first folder that looks like a repository root folder. Configure
    // `sourceRoots` for a layout this does not recognise.
    const roots = this.sourceRoots.join('|')
    const match = local.match(new RegExp(`[\\\\/]((?:${roots})[\\\\/].*)$`, 'i'))
    return match ? match[1] : file
  }

  // -------------------------------------------------------------- read side

  analysed(id) {
    if (!this._analysis.has(id)) {
      const action = this.actions.get(id)
      if (!action) return null
      this._analysis.set(id, analyzeAction(action, this.cfg))
    }
    return this._analysis.get(id)
  }

  list() {
    return this.order
      .map((id) => this.analysed(id))
      .filter(Boolean)
      .filter((a) => a.total > 0 || a.requests > 0)
      .reverse()
  }

  summary() {
    const actions = this.list()
    return {
      recording: this.recording,
      startedAt: this.startedAt,
      dropped: this.dropped,
      project: this.project,
      projects: projects.listProjects(),
      manual: this.manual?.label ?? null,
      repoRoot: this.repoRoots[0] ?? null,
      apps: [...this.apps.values()],
      version: this.version,
      ...summarise(actions),
      items: actions.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        note: this.actions.get(a.id)?.note ?? '',
        saved: this.actions.get(a.id)?.saved ?? false,
        startedAt: a.startedAt,
        durationMs: a.durationMs,
        endpoints: a.endpoints.slice(0, 4),
        apps: a.apps,
        requests: a.requests,
        total: a.total,
        roundTrips: a.roundTrips,
        unique: a.unique,
        avoidable: a.avoidable,
        avoidableInRequest: a.avoidableInRequest,
        avoidableAcrossRequests: a.avoidableAcrossRequests,
        avoidableWrites: a.avoidableWrites,
        projected: a.projected,
        reducible: a.reducible,
        totalMs: a.totalMs,
        colour: a.colour,
        topFindings: (() => {
          const all = [...a.findings, ...a.groups.flatMap((g) => g.findings)]
          const high = all.filter((f) => f.level === 'high')
          const shown = high.length ? high : all.filter((f) => f.level === 'med')
          return shown.slice(0, 3).map((f) => ({ code: f.code, level: f.level, title: f.title }))
        })(),
      })),
    }
  }

  detail(id) {
    return this.analysed(id)
  }

  exportAll() {
    return {
      generatedAt: new Date().toISOString(),
      summary: summarise(this.list()),
      actions: this.list(),
    }
  }
}
