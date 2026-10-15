// Static analysis meets the recording.
//
// A recording proves that a query ran 50 times; it cannot see the loop that made
// it do so. A static analyser sees every loop whose body reaches the database,
// but cannot tell which of them actually run, or how often. Put together, a
// repeated query in the recording that lands on a call site the analyser flagged
// is a loop pinned to its exact line - the most actionable finding there is.
//
// Two report shapes are read, so the overlay is not tied to one analyser:
//
//   1. A findings list:
//        { "findings": [ { "file": "src/Shop.Orders/Services/OrderService.cs",
//                          "line": 120, "method": "OrderService.Recalculate(Guid)",
//                          "loops": [ { "kind": "foreach", "header": "foreach (var line in lines)", "line": 118 } ],
//                          "call": "_quotes.GetByOrderLine(line.Id)",
//                          "chain": "QuoteRepository.GetByOrderLine(Guid) -> ...",
//                          "accessKind": "Read", "suppressed": false } ] }
//      A bare array of those objects is accepted too.
//
//   2. SARIF 2.1 (what Roslyn analysers write with /errorlog): each result's
//      first physical location is the call site, its message the explanation.
//
// The report is read from wherever the user keeps it; nothing is copied.
import fs from 'node:fs'

/** How far a flagged line may sit from the recorded one and still be the same call. */
export const DRIFT_LINES = 5

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^file:\/+/i, '').toLowerCase()

/** The method name without its parameter list or generic arity, for comparing with a stack frame. */
const bareMethod = (m) =>
  String(m ?? '')
    .replace(/\(.*$/, '')
    .replace(/<[^>]*>/g, '')
    .replace(/`\d+/g, '')
    .split('.')
    .slice(-2)
    .join('.')
    .toLowerCase()

function fromFindings(list) {
  return list
    .filter((f) => f && f.file && Number.isFinite(Number(f.line)) && !f.suppressed)
    .map((f) => ({
      file: String(f.file),
      line: Number(f.line),
      method: f.method ?? null,
      loops: Array.isArray(f.loops) ? f.loops.map((l) => ({ kind: l.kind ?? 'loop', header: l.header ?? '', line: l.line ?? null })) : [],
      call: f.call ?? null,
      chain: f.chain ?? null,
      access: f.accessKind ?? f.access ?? null,
    }))
}

function fromSarif(doc) {
  const out = []
  for (const run of doc.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]
      const phys = loc?.physicalLocation
      const file = phys?.artifactLocation?.uri
      const line = phys?.region?.startLine
      if (!file || !Number.isFinite(line)) continue
      out.push({
        file: decodeURIComponent(String(file)),
        line,
        method: loc?.logicalLocations?.[0]?.fullyQualifiedName ?? null,
        loops: [],
        call: phys?.region?.snippet?.text?.trim() ?? null,
        chain: r.message?.text ?? r.ruleId ?? null,
        access: null,
      })
    }
  }
  return out
}

/** Parses either report shape. Throws with a readable message on anything else. */
export function parseLoopReport(text) {
  let doc
  try {
    doc = JSON.parse(String(text).replace(/^﻿/, ''))
  } catch {
    throw new Error('The file is not JSON.')
  }
  if (Array.isArray(doc)) return fromFindings(doc)
  if (Array.isArray(doc?.runs)) return fromSarif(doc)
  if (Array.isArray(doc?.findings)) return fromFindings(doc.findings)
  throw new Error('Not a loop report: expected a "findings" list or a SARIF file.')
}

/**
 * An index over one report, for matching recorded stack frames against it.
 * Matching is on the file's tail, so a report written with repository-relative
 * paths matches a recording made with absolute ones, on any machine.
 */
export class LoopIndex {
  constructor(findings, meta = {}) {
    this.meta = { count: findings.length, ...meta }
    this.byLine = new Map() // "basename:line" -> findings
    this.byMethod = new Map() // "class.method" -> findings
    for (const f of findings) {
      const base = norm(f.file).split('/').pop()
      const k = `${base}:${f.line}`
      if (!this.byLine.has(k)) this.byLine.set(k, [])
      this.byLine.get(k).push(f)
      const m = bareMethod(f.method)
      if (m) {
        if (!this.byMethod.has(m)) this.byMethod.set(m, [])
        this.byMethod.get(m).push(f)
      }
    }
  }

  /** Does this finding's file name the same file as the frame? Tail match in either direction. */
  static sameFile(finding, frame) {
    const a = norm(finding.file)
    const b = norm(frame.a ?? frame.f)
    if (!a || !b) return false
    return a.endsWith(b) || b.endsWith(a)
  }

  /**
   * The best match for a list of stack frames, innermost frame first.
   *
   *   exact  - the frame's file and line are the flagged call itself.
   *   method - the frame's method has a flagged call a few lines away: the
   *            report was probably made from a slightly different version of
   *            the code. Worth showing, worded as a lead rather than a fact.
   *
   * Further than DRIFT_LINES away is a different call in the same method, not
   * drift. Measured on real recordings, a method-only match is otherwise wrong
   * far more often than right: big methods hold several database loops.
   */
  match(frames) {
    let lead = null
    for (const frame of frames ?? []) {
      if (!frame?.l || !(frame.f || frame.a)) continue
      const base = norm(frame.a ?? frame.f).split('/').pop()
      const exact = (this.byLine.get(`${base}:${frame.l}`) ?? []).find((f) => LoopIndex.sameFile(f, frame))
      if (exact) return describe(exact, frame, 'exact')
      if (!lead) {
        const near = (this.byMethod.get(bareMethod(frame.m)) ?? [])
          .filter((f) => LoopIndex.sameFile(f, frame) && Math.abs(f.line - frame.l) <= DRIFT_LINES)
          .sort((x, y) => Math.abs(x.line - frame.l) - Math.abs(y.line - frame.l))[0]
        if (near) lead = describe(near, frame, 'method')
      }
    }
    return lead
  }
}

function describe(f, frame, confidence) {
  const shortFile = f.file.replace(/\\/g, '/').split('/').pop()
  return {
    confidence,
    file: f.file,
    shortFile,
    line: f.line,
    method: f.method ?? frame.m ?? null,
    loops: f.loops,
    call: f.call,
    chain: f.chain,
    access: f.access,
    frameLine: frame.l,
  }
}

/**
 * Loads a report from disk, keeping the parsed index until the file changes.
 * Returns { index, status } where status is what the settings screen shows.
 */
export function createLoopSource() {
  let cached = { path: null, mtimeMs: 0, index: null, error: null }

  return function load(file) {
    if (!file) return { index: null, status: { configured: false } }
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return { index: null, status: { configured: true, error: 'The file does not exist (any more).' } }
    }
    if (cached.path !== file || cached.mtimeMs !== stat.mtimeMs) {
      try {
        const findings = parseLoopReport(fs.readFileSync(file, 'utf8'))
        cached = { path: file, mtimeMs: stat.mtimeMs, index: new LoopIndex(findings, { loadedAt: Date.now() }), error: null }
      } catch (e) {
        cached = { path: file, mtimeMs: stat.mtimeMs, index: null, error: e.message }
      }
    }
    return {
      index: cached.index,
      status: {
        configured: true,
        error: cached.error,
        findings: cached.index?.meta.count ?? 0,
        modifiedAt: stat.mtimeMs,
      },
    }
  }
}
