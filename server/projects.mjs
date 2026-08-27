// Project + flow storage. Everything lives under <tool folder>/data so the whole
// folder can be copied to another machine or shared with a colleague as-is.
// No absolute paths are ever written into the files.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Walks up to the tool folder (the one holding build.ps1) and puts data next to it. */
function locateDataRoot() {
  if (process.env.DBPROBE_DATA) return path.resolve(process.env.DBPROBE_DATA)

  let dir = path.resolve(HERE, '..')
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'build.ps1'))) return path.join(dir, 'data')
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(HERE, '..', 'data')
}

export const DATA_ROOT = locateDataRoot()
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json')

export const DEFAULT_SETTINGS = {
  // Ports your API listens on. The browser extension tags calls going to these,
  // and they are what changes when someone runs the app on a different port.
  apiPorts: [1337, 2337, 3337, 4337, 11337, 12337, 13337],
}

// --------------------------------------------------------------------- utils

/** Safe, portable folder/file name derived from a user-typed name. */
function slug(name) {
  const cleaned = String(name ?? '')
    .normalize('NFKD')
    .replace(/[^\w .-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 60)
  return cleaned || 'project'
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write then rename so a crash mid-write cannot leave a half-written flow.
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporary, file)
}

// ------------------------------------------------------------------ settings

let _settings = null

export function loadSettings() {
  _settings ??= { ...DEFAULT_SETTINGS, ...(readJson(SETTINGS_FILE) ?? {}) }
  return _settings
}

export function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch }
  merged.apiPorts = [...new Set((merged.apiPorts ?? []).map(Number).filter((p) => p > 0 && p < 65536))]
  if (!merged.apiPorts.length) merged.apiPorts = [...DEFAULT_SETTINGS.apiPorts]
  writeJson(SETTINGS_FILE, merged)
  _settings = merged
  return merged
}

// ------------------------------------------------------------------ projects

function projectDir(folder) {
  return path.join(DATA_ROOT, folder)
}

function flowsDir(folder) {
  return path.join(projectDir(folder), 'flows')
}

// The project list is read on every UI refresh; a short cache keeps that off the disk.
let _cache = null
let _cachedAt = 0
const CACHE_MS = 1500

export function invalidateProjectCache() {
  _cache = null
}

export function listProjects() {
  if (_cache && Date.now() - _cachedAt < CACHE_MS) return _cache
  _cache = readProjects()
  _cachedAt = Date.now()
  return _cache
}

function readProjects() {
  try {
    return fs
      .readdirSync(DATA_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const meta = readJson(path.join(projectDir(entry.name), 'project.json'))
        if (!meta) return null
        let flows = 0
        try {
          flows = fs.readdirSync(flowsDir(entry.name)).filter((f) => f.endsWith('.json')).length
        } catch {
          flows = 0
        }
        return { folder: entry.name, name: meta.name ?? entry.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, flows }
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  } catch {
    return []
  }
}

export function createProject(name) {
  const display = String(name ?? '').trim()
  if (!display) throw new Error('A project needs a name.')

  let folder = slug(display)
  if (fs.existsSync(projectDir(folder))) {
    let n = 2
    while (fs.existsSync(projectDir(`${folder}-${n}`))) n++
    folder = `${folder}-${n}`
  }

  const now = Date.now()
  fs.mkdirSync(flowsDir(folder), { recursive: true })
  invalidateProjectCache()
  writeJson(path.join(projectDir(folder), 'project.json'), { name: display, createdAt: now, updatedAt: now })
  return { folder, name: display, createdAt: now, updatedAt: now, flows: 0 }
}

export function renameProject(folder, name) {
  const display = String(name ?? '').trim()
  if (!display) throw new Error('A project needs a name.')

  const file = path.join(projectDir(folder), 'project.json')
  const meta = readJson(file)
  if (!meta) throw new Error('Unknown project.')

  // Only the display name changes; the folder keeps its identity so nothing breaks.
  writeJson(file, { ...meta, name: display, updatedAt: Date.now() })
  invalidateProjectCache()
  return { folder, name: display }
}

export function deleteProject(folder) {
  const dir = projectDir(folder)
  if (!dir.startsWith(DATA_ROOT) || dir === DATA_ROOT) throw new Error('Refusing to delete that path.')
  fs.rmSync(dir, { recursive: true, force: true })
  invalidateProjectCache()
}

function touchProject(folder) {
  const file = path.join(projectDir(folder), 'project.json')
  const meta = readJson(file)
  if (meta) writeJson(file, { ...meta, updatedAt: Date.now() })
  invalidateProjectCache()
}

// --------------------------------------------------------------------- flows

function flowFile(folder, id) {
  return path.join(flowsDir(folder), `${slug(id)}.json`)
}

/**
 * Saved flows keep the raw commands, not the parsed statements: re-parsing on
 * load means a recording made today gets the benefit of tomorrow's rules.
 */
function toStored(action) {
  return {
    id: action.id,
    label: action.label,
    kind: action.kind,
    note: action.note ?? '',
    url: action.url ?? null,
    dom: action.dom ?? null,
    startedAt: action.startedAt,
    endedAt: action.endedAt,
    savedAt: Date.now(),
    requests: action.requests ?? [],
    saveChanges: action.saveChanges ?? [],
    calls: (action.calls ?? []).map((call) => {
      const { statements, ...rest } = call
      return rest
    }),
  }
}

export function saveFlow(folder, action) {
  if (!folder) return null
  const stored = toStored(action)
  writeJson(flowFile(folder, stored.id), stored)
  touchProject(folder)
  return stored
}

export function loadFlows(folder) {
  try {
    return fs
      .readdirSync(flowsDir(folder))
      .filter((file) => file.endsWith('.json'))
      .map((file) => readJson(path.join(flowsDir(folder), file)))
      .filter((flow) => flow && flow.id)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  } catch {
    return []
  }
}

export function deleteFlow(folder, id) {
  try {
    fs.rmSync(flowFile(folder, id), { force: true })
    touchProject(folder)
    return true
  } catch {
    return false
  }
}
