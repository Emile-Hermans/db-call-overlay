const list = document.getElementById('list')
const empty = document.getElementById('empty')

const open = new Set() // action ids the user unfolded
const openGroups = new Set() // "actionId::groupKey" the user unfolded
const details = new Map() // actionId -> analysed detail
const signatures = new Map() // actionId -> "total:avoidable:ms", to know when to refetch

let state = null
let setup = null // recording setup status, pushed by the desktop shell

// The desktop shell, when the page is hosted by it rather than a browser tab.
// Declared here because module-level code further down reads it.
const shell = window.chrome?.webview ?? null
const send = (type) => shell?.postMessage({ type })

// ------------------------------------------------------------------ helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`)

const clock = (t) => new Date(t).toLocaleTimeString('nl-BE', { hour12: false })

const TAG = { red: 'WASTE', amber: 'REVIEW', green: 'OK' }

const PRODUCT = 'Clicktrace'

/** Line icons, inline so the app works offline. 16×16, filled with currentColor. */
const ICON = {
  note: '<svg viewBox="0 0 16 16"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L6 13l-3.6.9.9-3.6zm-7 9.2-.4 1.5 1.5-.4 6.6-6.6-1.1-1.1z"/></svg>',
  noted: '<svg viewBox="0 0 16 16"><path d="M3 1.5h7l3 3v10H3zm1.5 1.5v10h7V5.2L9.3 3zM6 7h4v1.2H6zm0 2.5h4v1.2H6z"/></svg>',
  download: '<svg viewBox="0 0 16 16"><path d="M7.3 1.5h1.4v7.3l2.5-2.5 1 1L8 11.5 3.8 7.3l1-1 2.5 2.5zM2.5 12.5h11V14h-11z"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M6 1.5h4l.5 1H14V4H2V2.5h3.5zM3.3 5h9.4l-.7 9.5H4zm2.2 1.5.3 6.5h1.1l-.2-6.5zm3.8 0-.2 6.5h1.1l.3-6.5z"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><path d="M5 1.5h8.5V11H12V3H5zM2.5 4.5H10v10H2.5zM4 6v7h4.5V6z"/></svg>',
}

/** Time of day for a row: the click happened "at 14:02:31". */
const when = (t) => (t ? clock(t) : '')

/** Joins parts of a composite key; never appears in SQL or a parameter value. */
const SEP = String.fromCharCode(1)

function editorLink(frame) {
  // `a` is the path as the probe saw it; `f` is the shortened one we display.
  const full = frame?.a ?? (/^[a-zA-Z]:[\\/]/.test(frame?.f ?? '') ? frame.f : null)
  if (!full) return null
  return `vscode://file/${full.replace(/\\/g, '/')}:${frame.l ?? 1}`
}

function frameHtml(frame) {
  const where = frame.f ? `${frame.f}${frame.l ? ':' + frame.l : ''}` : ''
  const href = editorLink(frame)
  const location = where ? (href ? ` <a href="${esc(href)}">${esc(where)}</a>` : ` ${esc(where)}`) : ''
  return `<b>${esc(frame.m)}</b>${location}`
}

// ------------------------------------------------------------------- filter

// A long session runs to hundreds of flows. Without this the only way to find
// the one you just clicked is to scroll.
const filter = { text: '', colours: new Set(['red', 'amber', 'green']), grows: false }

function matchesFilter(a) {
  if (filter.grows && !(a.scaling?.maxDepth > 0)) return false
  if (!filter.colours.has(a.colour)) return false
  if (!filter.text) return true

  // Everything a flow can be recognised by, including what is only visible once
  // it is opened - the point is to find a flow without having to open all of them.
  const haystack = [
    a.label,
    a.note,
    ...(a.endpoints ?? []),
    ...(a.tables ?? []),
    ...(a.methods ?? []),
    ...(a.topFindings ?? []).map((f) => f.title),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  // Every word has to appear somewhere, in any order.
  return filter.text.split(/\s+/).every((word) => haystack.includes(word))
}

function paintFilter(s, visible) {
  const active = filter.text || filter.grows || filter.colours.size < 3
  const count = document.getElementById('filterCount')

  count.textContent = active ? `${visible.length} of ${s.items.length}` : ''
  document.getElementById('filterClear').hidden = !active
  document.getElementById('filterbar').hidden = s.items.length === 0
  document.getElementById('noMatches').hidden = !(active && s.items.length > 0 && visible.length === 0)

  const loopNote = document.getElementById('loopNote')
  const withLoops = s.items.filter((i) => i.staticLoops > 0).length
  loopNote.hidden = !s.loops?.configured
  if (s.loops?.configured) {
    loopNote.className = 'note loops'
    loopNote.textContent = s.loops.error
      ? 'loop report: unreadable'
      : `loop report: ${withLoops} click${withLoops === 1 ? '' : 's'} with a flagged loop`
    loopNote.title = s.loops.error
      ? `The static analysis report could not be read: ${s.loops.error}`
      : `${s.loops.findings} database calls in loops in the static analysis report. Queries whose call site it flags carry an "in loop" badge.`
  }

  const excluded = document.getElementById('excludedNote')
  excluded.hidden = !s.excludedStatements
  if (s.excludedStatements) {
    excluded.textContent = `${s.excludedStatements} schema / key-generation statements excluded`
    excluded.title =
      'Schema work and key-block fetches are real database traffic, but not something a flow can be ' +
      'blamed for. They are left out of every count and listed on the flow that produced them.'
  }
}

const filterText = document.getElementById('filterText')

filterText.addEventListener('input', () => {
  filter.text = filterText.value.trim().toLowerCase()
  lastRows = ''
  render()
})

document.querySelector('#filterbar .chips').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (!chip) return

  if (chip.dataset.colour === 'grows') {
    filter.grows = !filter.grows
  } else if (filter.colours.has(chip.dataset.colour)) {
    filter.colours.delete(chip.dataset.colour)
  } else {
    filter.colours.add(chip.dataset.colour)
  }

  chip.classList.toggle('on')
  lastRows = ''
  render()
})

document.getElementById('filterClear').addEventListener('click', () => {
  filter.text = ''
  filter.grows = false
  filter.colours = new Set(['red', 'amber', 'green'])
  filterText.value = ''
  for (const chip of document.querySelectorAll('#filterbar .chip')) {
    chip.classList.toggle('on', chip.dataset.colour !== 'grows')
  }
  lastRows = ''
  render()
})

// ------------------------------------------------------------------- header

/**
 * The scaling tile. Two readings, because one recording genuinely cannot tell
 * them apart: the count if only the outer collection grows, and the count if
 * every level of a nested loop grows with it. Showing one number would be
 * claiming to know which, and the difference is the entire question.
 */
function paintScaleTile(s) {
  const scaling = s.scaling ?? {}
  const tile = document.getElementById('scaleTile')
  const value = document.getElementById('tScale')
  const label = document.getElementById('tScaleLabel')
  const factor = scaling.factor ?? 10

  label.textContent = `At ${factor}× data`
  tile.classList.toggle('warn', scaling.maxDepth === 1)
  tile.classList.toggle('bad', scaling.maxDepth >= 2)

  if (!s.total) {
    value.textContent = '0'
    tile.title = 'What the same clicks would cost against more data.'
    return
  }

  const nested = scaling.maxDepth >= 2 && scaling.worstCase > scaling.atFactor
  value.textContent = nested ? `${scaling.atFactor}–${scaling.worstCase}` : String(scaling.atFactor ?? s.total)

  tile.title =
    `${s.total} calls today.\n` +
    `About ${scaling.atFactor} at ${factor}× the data.\n` +
    (nested
      ? `Up to ${scaling.worstCase} if every level of the nested loops grows by ${factor}× as well.\n`
      : '') +
    (scaling.maxDepth >= 2
      ? '\nA loop sits inside another loop, so part of this count is a product of two dimensions rather than a constant.'
      : scaling.maxDepth === 1
        ? '\nSome queries run once per row. That is linear: fine while the row count stays small.'
        : '\nNothing was proven to grow with the data.') +
    (scaling.unclassified
      ? `\n\n${scaling.unclassified} loop${scaling.unclassified === 1 ? '' : 's'} could not be classified and ` +
        `${scaling.unclassified === 1 ? 'is' : 'are'} left out of both numbers.`
      : '')
}

function paintTotals(s) {
  document.getElementById('tFlows').textContent = s.items.length
  document.getElementById('tAvoid').textContent = s.avoidable ?? 0
  document.getElementById('tCalls').textContent = s.total
  document.getElementById('tInReq').textContent = s.avoidableInRequest ?? 0
  document.getElementById('tWrites').textContent = s.avoidableWrites ?? 0
  document.getElementById('tAcross').textContent = s.avoidableAcrossRequests ?? 0
  // Usually zero, and a design question rather than a fix when it is not.
  document.getElementById('tAcrossWrap').hidden = !s.avoidableAcrossRequests
  document.getElementById('tProjected').textContent = s.projected
  document.getElementById('tMs').textContent = ms(s.totalMs)
  document.getElementById('tOffMs').textContent = ms(s.offMs ?? 0)
  document.getElementById('tRed').textContent = s.red
  document.getElementById('tAmber').textContent = s.amber
  document.getElementById('tGreen').textContent = s.green
  paintScaleTile(s)

  const apps = s.apps.map((a) => a.app).join(', ')
  document.getElementById('apps').textContent =
    (s.recording ? (apps ? `Recording ${apps}` : 'Waiting for an API…') : 'Paused') +
    (s.manual ? ` · marker: ${s.manual}` : '') +
    (s.dropped ? ` · ${s.dropped} events dropped` : '')

  document.getElementById('recDot').classList.toggle('paused', !s.recording)
  document.getElementById('recBtn').textContent = s.recording ? 'Pause' : 'Resume'
}

// -------------------------------------------------------------- action rows

/** The flow's growth, if any was proven, as one chip next to its call count. */
function flowGrowth(a) {
  const s = a.scaling
  if (!s || !s.maxDepth) return '<span class="growth"></span>'

  const nested = s.maxDepth >= 2 && s.worstCase > s.projected
  const text = nested ? `${s.factor}× &rarr; ${s.projected}–${s.worstCase}` : `${s.factor}× &rarr; ${s.projected}`
  const why = nested
    ? `${a.total} calls today. About ${s.projected} at ${s.factor}× the data, and up to ${s.worstCase} if every level of the nested loops grows too.\n\nGrows with: ${s.dimensions.join(', ')}`
    : `${a.total} calls today, about ${s.projected} at ${s.factor}× the data — one call per row, so it grows in step with the data.\n\nGrows with: ${s.dimensions.join(', ')}`

  return `<span class="growth ${nested ? 'bad' : 'warn'}" title="${esc(why)}">${text}</span>`
}

/**
 * The time cell: how long the user waited for this click, and a bar splitting
 * that wait into SQL and everything else. The question a slow row raises is
 * "is it the database?", so the row answers it before it is opened.
 */
function rowTime(a) {
  const wall = a.wallMs ?? a.durationMs ?? 0
  if (a.serverMs == null || a.dbShare == null) {
    return `<span class="rowtime" title="Database time ${esc(ms(a.totalMs))}. The requests never reported their end, so the wait cannot be split.">
      <span class="wall">${ms(a.totalMs)}<small>db</small></span>
      <span class="timebar"><i class="db" style="width:100%"></i></span>
    </span>`
  }
  const db = a.dbShare
  const why =
    `The user waited ${ms(wall)} from the first request to the last response.
` +
    `${db}% of the server time was SQL, ${100 - db}% application code.` +
    (a.offMs ? `
${ms(a.offMs)} more database time ran after the response or in the background.` : '')
  return `<span class="rowtime" title="${esc(why)}">
      <span class="wall">${ms(wall)}<small>${db}% db</small></span>
      <span class="timebar"><i class="db" style="width:${db}%"></i><i class="app" style="width:${100 - db}%"></i></span>
    </span>`
}

function actionRow(a) {
  const findings = a.topFindings.map((f) => f.title).join(' · ')
  const sub = findings || a.endpoints.join(', ') || '—'

  const breakdown =
    `${a.total} calls
` +
    `${a.avoidableInRequest ?? 0} repeated inside one request
` +
    `${a.avoidableWrites ?? 0} rows written more than once
` +
    `${a.avoidableAcrossRequests ?? 0} repeated across requests (architectural — not counted)
` +
    `= ${a.projected} could be`

  const noteTitle = a.note ? `Description:
${a.note}` : 'Describe what this click covers'

  return `
    <div class="action ${a.colour} ${open.has(a.id) ? 'open' : ''}" data-id="${esc(a.id)}">
      <div class="arow" role="button" tabindex="0" aria-expanded="${open.has(a.id)}">
        <span class="chev">&#9656;</span>
        <span class="tag ${a.colour}">${TAG[a.colour]}</span>
        <span class="rowmain">
          <span class="label" title="${esc(a.label)}">${esc(a.label)}<span class="when">${when(a.startedAt)}</span></span>
          <span class="sub" title="${esc(sub)}">${esc(sub)}</span>
        </span>
        ${rowTime(a)}
        <span class="nums" title="${esc(breakdown)}">
          <b>${a.total}</b> quer${a.total === 1 ? 'y' : 'ies'}
          ${a.avoidable ? `<span class="to">&rarr;</span><b class="save">${a.projected}</b>` : ''}
        </span>
        ${flowGrowth(a)}
        <span class="rowtools">
          <button class="note ${a.note ? 'has-note' : ''}" data-act="note" title="${esc(noteTitle)}" aria-label="Describe">
            ${a.note ? ICON.noted : ICON.note}
          </button>
          <button data-act="export-menu" title="Export this whole click — as a spreadsheet (CSV) or as JSON" aria-label="Export">${ICON.download}</button>
          <button class="del" data-act="delete" title="Delete this click" aria-label="Delete">${ICON.trash}</button>
        </span>
      </div>
      <div class="detail" ${open.has(a.id) ? '' : 'hidden'}></div>
    </div>`
}

/**
 * An empty list has two very different causes. Say which one it is, because
 * "nothing happened" and "nothing is connected" need different actions.
 */
function paintEmptyState(s) {
  const hasCalls = s.items.length > 0
  const hasProbe = s.apps.length > 0

  empty.hidden = hasCalls
  list.hidden = !hasCalls // otherwise the empty list still eats the flex space
  document.getElementById('noCalls').hidden = hasCalls || !hasProbe

  if (hasProbe) {
    document.getElementById('connectedApps').textContent = s.apps.map((a) => a.app).join(', ')
  }

  paintSetup(hasCalls || hasProbe)
}

/**
 * Three states, one visible at a time: needs switching on, needs the running APIs
 * restarted once, or ready and waiting. Driven by what the shell reports.
 */
function paintSetup(satisfied) {
  const show = (id, on) => (document.getElementById(id).hidden = !on)

  show('setupBrowser', !satisfied && !shell)

  if (satisfied || !setup) {
    show('setupNeeded', false)
    show('setupRestart', false)
    show('setupReady', false)
    return
  }

  // APIs that are running but have not reported in are the ones to restart.
  const reporting = new Set((state?.apps ?? []).map((a) => a.pid))
  const stale = (setup.apis ?? []).filter((api) => !reporting.has(api.pid))

  // Visual Studio being older than the switch beats everything else: until it is
  // restarted, nothing it launches can be recorded, so say that and nothing else.
  const vsFirst = setup.installed && setup.visualStudioNeedsRestart

  show('setupNeeded', !setup.installed)
  show('setupVs', vsFirst)
  show('setupRestart', setup.installed && !vsFirst && stale.length > 0)
  show('setupReady', setup.installed && !vsFirst && stale.length === 0)

  if (setup.installed && !vsFirst && stale.length > 0) {
    document.getElementById('apiList').innerHTML = stale
      .map((api) => `<li>${esc(api.name)}${api.fromVisualStudio ? ' <span class="sub">— running under Visual Studio</span>' : ''}</li>`)
      .join('')

    // Never offer to stop something Visual Studio is debugging.
    const anyFromVs = stale.some((api) => api.fromVisualStudio)
    show('restartCta', !anyFromVs)
    show('vsOwned', anyFromVs)
  }
}

let lastRows = ''

function render() {
  if (!state) return
  paintTotals(state)
  paintProject(state)
  paintEmptyState(state)

  const visible = state.items.filter(matchesFilter)
  paintFilter(state, visible)

  const rows = visible.map(actionRow).join('')
  if (rows !== lastRows) {
    lastRows = rows
    const scroll = list.scrollTop
    list.innerHTML = rows
    list.scrollTop = scroll
    // The button the menu was opened from no longer exists after a repaint.
    closeExportMenu()
  }

  // Outside the row diff on purpose. Row counts and durations arrive after the
  // statement they belong to, and they change what an open row shows without
  // changing the row itself - so an early return here would strand them.
  for (const id of open) {
    const detail = details.get(id)
    if (detail) paintDetail(id, detail)
    else loadDetail(id)
  }
}

// -------------------------------------------------------------- action body

function findingHtml(f) {
  // "-N" means N calls come off the headline. Cross-request savings are shown as
  // "~N" because they are counted separately and need a design change, not a fix.
  const badge = f.avoidable
    ? (f.bucket === 'across' ? '~' : '-') + f.avoidable
    : f.level === 'high'
      ? 'HIGH'
      : f.level === 'med'
        ? 'CHECK'
        : 'NOTE'

  const hint = f.bucket === 'across' ? ' title="Counted separately from the headline — see the cross-request tile"' : ''

  return `
    <div class="finding ${f.level}">
      <span class="tag ${f.level === 'high' ? 'red' : f.level === 'med' ? 'amber' : 'green'}"${hint}>
        ${badge}
      </span>
      <div>
        <div class="ft">${esc(f.title)}</div>
        <div class="fd">${esc(f.detail)}</div>
        ${f.fix ? `<div class="fx">${esc(f.fix)}</div>` : ''}
      </div>
    </div>`
}

/**
 * The call site shown is the first method above the data-access layer — the code
 * you would change. Name the frame that literally ran the command too, so the
 * shortcut is never mistaken for the whole truth.
 */
function siteTooltip(g) {
  if (!g.callsite) return ''
  const lines = [`${g.callsite.method}${g.callsite.file ? ` — ${g.callsite.file}${g.callsite.line ? ':' + g.callsite.line : ''}` : ''}`]
  if (g.callsite.innermost && g.callsite.innermost !== g.callsite.method) {
    lines.push(`issued through ${g.callsite.innermost} (shared data-access helper)`)
  }
  return lines.join('\n')
}

/**
 * What kind of database work this was, from the data-access layer's own report
 * rather than guessed from the SQL.
 *
 * An ordinary query gets no badge, and neither does a command whose source was
 * not reported. Labelling the common case would put a word on nearly every row
 * that says nothing, and crowd out the one that does.
 */
const KIND_TEXT = {
  save: [
    'save',
    'A change-tracker flush. There is no direct row count for one, so the number is taken from what the statement returned and shown with ≈',
  ],
  bulk: ['bulk', 'A set-based write that never goes through the change tracker. Its row count is exact'],
  rawsql: ['raw sql', 'Hand-written SQL rather than a generated query'],
  mixed: ['mixed', 'This group holds more than one kind of command'],
}

function kindPill(g) {
  const found = KIND_TEXT[g.kind]
  if (!found) return ''
  const [text, why] = found
  return `<span class="pill kind k-${esc(g.kind)}" title="${esc(why)}">${esc(text)}</span>`
}

/**
 * Did the user actually wait for these calls? A call that ran after the response
 * was sent, or outside any request, is still database load — but it never slowed
 * the screen, and a failure in it is invisible to whoever clicked.
 */
const TIMING_TEXT = {
  afterResponse: [
    'after response',
    'Ran after the HTTP response was already sent. The user never waited for it — it did not slow ' +
      'the screen, but it is still database load, and if it fails the user was already told the ' +
      'request succeeded.',
  ],
  background: [
    'background',
    'Belongs to no HTTP request — background work such as a timer, a queue or a startup task.',
  ],
}

function timingPill(g) {
  const t = g.timing
  const out = []
  for (const [key, [text, why]] of Object.entries(TIMING_TEXT)) {
    const n = t?.[key] ?? 0
    if (!n) continue
    // A partial count means the group mixes waited and unwaited executions.
    const suffix = n < g.count ? ` ×${n}` : ''
    out.push(`<span class="pill timing t-${esc(key)}" title="${esc(why)}">${esc(text)}${suffix}</span>`)
  }
  if (g.sync && (g.timing?.waited ?? 0) > 0) {
    out.push(
      `<span class="pill timing t-sync" title="Executed with the blocking (non-async) API — the thread waits idle for the database instead of returning to the pool.">sync</span>`,
    )
  }
  return out.join('')
}

/**
 * Whether this group's execution count is a constant or a function of the data.
 * The whole point of the badge is that "×12" alone cannot tell you which.
 */
function growthPill(g) {
  const s = g.scaling
  if (!s) return ''

  if (s.depth === null) {
    return `<span class="pill scale unknown" title="This runs ${s.executions}× from a loop, but no query in the same request produced ${s.executions} rows, so what drives it could not be established. Usually means the driving result was not read to the end, leaving no row count.">grows?</span>`
  }
  if (s.depth === 0) return ''

  const chain = s.chain.join(' × ')
  const why =
    s.depth === 1
      ? `One call per ${chain} row. Today that is ${s.executions}; twice the ${chain} rows is twice the calls.`
      : `A loop inside a loop: ${chain}. Today that is ${s.executions} calls, and it is a product of ${s.depth} levels — if both grow, it grows by the square.`

  return `<span class="pill scale d${s.depth}" title="${esc(why)}">per ${esc(chain)}</span>`
}

/** The static analysis report's say on this group, when it has one. */
function loopPill(g) {
  const l = g.staticLoop
  if (!l) return ''
  return `<span class="pill loop${l.confidence === 'exact' ? '' : ' lead'}" title="${esc(loopTitle(l))}">${l.confidence === 'exact' ? 'in loop' : 'loop?'}</span>`
}

/** Tables brought into the row source of this one statement - joins, applies, derived tables. */
function joinedSources(g) {
  return (g.sources ?? []).filter((x) => x.how !== 'subquery')
}

function sourceLine(x) {
  const cols = x.columns == null ? '' : x.star ? ', all columns (*)' : `, ${x.columns} column${x.columns === 1 ? '' : 's'}`
  return `${x.table} (${x.how}${cols}${x.wide ? ', whole row' : ''})`
}

function joinPill(g) {
  const joined = joinedSources(g)
  if (joined.length < 2) return ''
  const n = joined.length - 1
  const tip = `One query, one round-trip — reads ${joined.length} tables:\n${joined.map(sourceLine).join('\n')}`
  return `<span class="pill join" title="${esc(tip)}">+${n} joined</span>`
}

/** What one query reads, table by table. Only shown when there is more than one table to tell apart. */
function sourcesHtml(g) {
  const all = g.sources ?? []
  const joined = joinedSources(g)
  if (all.length < 2 && !(joined.length === 1 && joined[0].wide)) return ''
  const rows = all
    .map((x) => {
      const cols = x.columns == null ? '—' : x.star ? 'all (*)' : x.columns
      const badge =
        x.how === 'subquery'
          ? '<span class="pill" title="Only checked inside a condition (EXISTS / IN / a scalar subquery) — no columns come back from it.">lookup</span>'
          : x.wide
            ? `<span class="pill wide" title="${x.star ? 'Selected with *' : 'At or above the wide-read threshold in Settings — most likely the whole entity is loaded'}">whole row</span>`
            : ''
      return `<tr><td class="t">${esc(x.table)}</td><td>${esc(x.how)}</td><td>${cols}</td><td>${badge}</td></tr>`
    })
    .join('')
  const total = joined.reduce((s, x) => s + (x.columns ?? 0), 0)
  return `
    <div class="section-title">
      Tables in this query
      <span class="sub">one round-trip per execution · ${joined.length} table${joined.length === 1 ? '' : 's'}${g.op === 'SELECT' ? ` · ${total} column${total === 1 ? '' : 's'}` : ''}</span>
    </div>
    <table class="exec sources">
      <thead><tr><th>table</th><th>how</th><th>columns</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
}

function groupRow(actionId, g) {
  const key = `${actionId}::${g.id}`
  const isOpen = openGroups.has(key)
  const paths = g.callPaths ?? []
  const site = g.callsite
    ? `<b>${esc(g.callsite.method)}</b>${g.callsite.file ? ' · ' + esc(g.callsite.file.split(/[\\/]/).pop()) + (g.callsite.line ? ':' + g.callsite.line : '') : ''}` +
      (paths.length > 1 ? `<span class="pill dupe">${paths.length} paths</span>` : '')
    : `<span>${esc(g.endpoints[0] ?? 'unknown call site')}</span>`

  const uniqueText =
    g.op === 'SELECT'
      ? `${g.distinctParams} distinct`
      : `${g.distinctRows} row${g.distinctRows === 1 ? '' : 's'}`

  return `
    <div class="group ${g.level === 'high' ? 'red' : g.level === 'med' ? 'amber' : 'ok'} ${isOpen ? 'open' : ''}" data-key="${esc(g.id)}">
      <div class="grow" role="button" tabindex="0" aria-expanded="${isOpen}">
        <span class="chev">&#9656;</span>
        <span class="op op-${esc(g.op)}">${esc(g.op)}</span>
        <span class="tbl" title="${esc(g.table ?? 'No table name could be read from this statement — see the SQL below')}">
          <span class="tname">${esc(g.table ?? '(no table parsed)')}</span>${joinPill(g)}
        </span>
        <span class="count ${g.avoidable ? 'bad' : g.avoidableAcrossRequests ? 'soft' : ''}">&times;${g.count}</span>
        <span class="sub">${uniqueText}</span>
        <span class="badges">${loopPill(g)}${kindPill(g)}${growthPill(g)}${timingPill(g)}</span>
        <span class="site" title="${esc(siteTooltip(g))}">${site}</span>
        <span class="ms">${ms(g.totalMs)}</span>
        <span class="rowtools">
          <button data-act="copy-call" title="Copy this call as text — finding, fix, call paths, SQL and executions" aria-label="Copy">${ICON.copy}</button>
          <button data-act="export-menu" title="Export this call — as a spreadsheet (CSV) or as JSON" aria-label="Export">${ICON.download}</button>
        </span>
      </div>
      <div class="gdetail" ${isOpen ? '' : 'hidden'}>${isOpen ? groupBody(g) : ''}</div>
    </div>`
}

function groupBody(g) {
  const paths = g.callPaths ?? []
  const pathsHtml = paths.length
    ? `<div class="section-title">
         Triggered by ${paths.length === 1 ? 'this code path' : `${paths.length} different code paths`}
       </div>` +
      paths
        .map(
          (p) => `
        <div class="callpath">
          <div class="cphead">
            <span class="count ${paths.length > 1 ? 'bad' : ''}">&times;${p.count}</span>
            <b>${esc(p.origin ?? 'unknown entry point')}</b>
            <span class="sub">${p.roundTrips} round-trip${p.roundTrips === 1 ? '' : 's'}</span>
          </div>
          <ol class="path" reversed>${[...p.frames].reverse().map((f) => `<li>${frameHtml(f)}</li>`).join('')}</ol>
        </div>`,
        )
        .join('')
    : ''

  // Duplicates are tracked per request, because that is the line the analysis
  // draws: a repeat inside one request is waste, the same query in the next
  // request is a separate unit of work. Marking both the same way would have the
  // table contradicting the finding printed directly above it.
  const seen = new Map()
  let previousCall = null

  const rows = g.executions
    .map((e, i) => {
      const req = e.reqId ?? '(no request)'
      const sig = req + SEP + (e.params ?? []).map((p) => p.v).join('|')
      const first = seen.get(sig)
      if (first === undefined) seen.set(sig, i)
      // Nothing can be said about an execution whose values were not captured.
      const comparable = (e.params ?? []).length > 0 || !/@[A-Za-z_]/.test(e.sql ?? '')
      const dupe = first !== undefined && comparable

      // Several statements can share one round-trip; only the first carries its cost.
      const sameTrip = e.id === previousCall
      previousCall = e.id
      const offMark =
        e.timing === 'afterResponse'
          ? ' <span class="offmark" title="Ran after the response was already sent — the user did not wait for this call.">after</span>'
          : e.timing === 'background'
            ? ' <span class="offmark" title="Belongs to no HTTP request — background work.">bg</span>'
            : ''
      const took =
        (sameTrip
          ? '<span class="sub" title="same round-trip as the row above">&#8627;</span>'
          : e.durationMs
            ? Math.round(e.durationMs) + ' ms'
            : '—') + offMark
      // Reads report rows read; writes report rows written. For a tracked EF save
      // that number is inferred from the rows its OUTPUT/RETURNING clause gives back.
      const isWrite = g.op !== 'SELECT'
      const value = isWrite ? e.rowsAffected : e.rowsRead
      const derived = isWrite && e.rowsAffectedDerived
      const rows = sameTrip
        ? ''
        : value > 0
          ? `<span${derived ? ' title="Counted from the rows the statement returned for EF\'s concurrency check — EF runs saves through a reader, so no direct row count exists."' : ''}>${derived ? '≈' : ''}${value}</span>`
          : '—'

      return `
        <tr class="${dupe ? 'dupe' : ''}">
          <td>${i + 1}</td>
          <td>${clock(e.ts)}</td>
          <td>${took}</td>
          <td>${rows}</td>
          <td>${esc(e.origin ?? e.handler ?? e.path ?? '')}</td>
          <td class="p" title="${esc((e.params ?? []).map((p) => `${p.n}=${p.v}`).join(', '))}">
            ${esc((e.params ?? []).map((p) => p.v).join(', ') || '—')}
            ${dupe ? `<span class="pill dupe">same as #${first + 1}</span>` : ''}
          </td>
        </tr>`
    })
    .join('')

  return `
    ${g.findings.map(findingHtml).join('')}
    ${pathsHtml}
    ${sourcesHtml(g)}
    <div class="section-title">SQL</div>
    <pre class="sql">${esc(g.sampleSql)}</pre>
    <div class="section-title">
      Executions${g.executionsTruncated ? ` (first 200 of ${g.count})` : ''}
    </div>
    <table class="exec">
      <thead>
        <tr>
          <th>#</th><th>at</th><th>took</th>
          <th title="${g.op === 'SELECT' ? 'Reader.Read() calls — one more than the row count when the result set is fully enumerated' : 'Rows written. ≈ means it was counted from the rows returned by the statement&apos;s OUTPUT/RETURNING clause, because EF runs tracked saves through a reader'}">
            ${g.op === 'SELECT' ? 'reads' : 'rows written'}
          </th>
          <th>from</th><th>parameters</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

// ------------------------------------------------------------- click report

const VERDICT_ICON = { db: 'DB', app: '{ }', gaps: '⋯', fast: '✓', unknown: '?' }

function verdictHtml(t) {
  const v = t?.verdict
  if (!v) return ''
  return `
    <div class="verdict k-${esc(v.kind)}">
      <span class="vicon" aria-hidden="true">${VERDICT_ICON[v.kind] ?? '•'}</span>
      <div><div class="vt">${esc(v.title)}</div><div class="vd">${esc(v.detail)}</div></div>
    </div>`
}

/** The wait, split three ways. Every number here is measured, so it is shown plainly. */
function splitHtml(t, d) {
  if (!t || t.serverMs == null || !t.wallMs) return ''
  const part = (n) => Math.max((n / t.wallMs) * 100, 0)
  const seg = (cls, n, label) =>
    n > 0 ? `<i class="${cls}" style="width:${part(n)}%" title="${esc(label)}: ${ms(n)}"></i>` : ''
  return `
    <div class="split">
      <div class="section-title">Where the time went <span class="sub">${ms(t.wallMs)} from first request to last response</span></div>
      <div class="splitbar">
        ${seg('db', t.dbMs, 'Database')}${seg('app', t.appMs, 'Application code')}${seg('idle', t.idleMs, 'Between requests')}
      </div>
      <div class="splitlegend">
        <span><i class="sw db"></i>Database <b>${ms(t.dbMs)}</b></span>
        <span><i class="sw app"></i>Application code <b>${ms(t.appMs)}</b></span>
        ${t.idleMs > 0 ? `<span title="Time with no request running: the browser rendering, or waiting before the next request"><i class="sw idle"></i>Between requests <b>${ms(t.idleMs)}</b></span>` : ''}
        ${d.offMs ? `<span class="sub" title="Database work after the response or in the background — not part of the wait">+ ${ms(d.offMs)} not waited for</span>` : ''}
      </div>
    </div>`
}

function loopTitle(l) {
  const loop = l.loops?.[l.loops.length - 1]
  return (
    (l.confidence === 'exact'
      ? 'Static analysis flags this call site as a database call inside a loop'
      : 'Static analysis flags a database call in a loop a few lines from this one — the report was probably made from a slightly different version of the code') +
    `\n${l.file}:${l.line}` +
    (loop?.header ? `\n${loop.header}` : '') +
    (l.chain ? `\nvia ${l.chain}` : '')
  )
}

/** What to change first, ranked by the time it would buy back. */
function fixFirstHtml(t) {
  const fixes = t?.fixFirst ?? []
  if (!fixes.length) return ''
  const items = fixes
    .map((f, i) => {
      const where = f.method
        ? `<code>${esc(f.method)}</code>${f.file ? ` · ${esc(f.file.split(/[\\/]/).pop())}${f.line ? ':' + f.line : ''}` : ''}`
        : ''
      const loop = f.inLoop
        ? ` <span class="pill loop${f.inLoop.confidence === 'exact' ? '' : ' lead'}" title="${esc(loopTitle(f.inLoop))}">in loop ${esc(f.inLoop.shortFile)}:${f.inLoop.line}</span>`
        : ''
      const gain = f.savedMs
        ? `<b>~${ms(f.savedMs)}</b><span class="sub">${f.avoidable ? `−${f.avoidable} quer${f.avoidable === 1 ? 'y' : 'ies'}` : 'fewer round-trips'}</span>`
        : `<span class="sub">${ms(f.totalMs)}<br>${f.share}% of db time</span>`
      return `
        <button class="fix ${esc(f.level)}" data-act="goto-group" data-group="${esc(f.group)}" title="${esc(f.fix || 'Open this query group')}">
          <span class="fix-n">${i + 1}</span>
          <span style="min-width:0">
            <span class="fix-title" style="display:block">${esc(f.title)}</span>
            <span class="fix-where" style="display:block">${esc(f.op)} ${esc(f.table ?? '')} ×${f.count}${where ? ' · ' + where : ''}${loop}</span>
          </span>
          <span class="fix-gain">${gain}</span>
        </button>`
    })
    .join('')
  return `
    <div class="section">
      <div class="section-title">Fix first <span class="sub">ranked by estimated time saved — removable executions × their average duration</span></div>
      <div class="fixes">${items}</div>
    </div>`
}

/** Rounds an axis step to 1-2-5 so the ticks read as round numbers. */
function niceStep(range, ticks = 4) {
  const raw = range / ticks
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
}

/**
 * Every request on one time axis, with every query as a tick inside it. A run
 * of ticks is a loop; a long tick is a slow query; a long bar with no ticks is
 * time the application spent on its own.
 */
function waterfallHtml(t) {
  if (!t || !t.requests?.length) return ''
  const spanEnd = Math.max(0, ...t.spans.map((s) => s.offsetMs + s.durationMs))
  const reqEnd = Math.max(0, ...t.requests.map((r) => r.offsetMs + (r.durationMs ?? 0)))
  const range = Math.max(t.wallMs, spanEnd, reqEnd, 1)
  const pct = (n) => `${Math.min(Math.max((n / range) * 100, 0), 100)}%`

  const step = niceStep(range)
  const ticks = []
  for (let v = 0; v <= range + 0.001; v += step) ticks.push(v)
  const axis = ticks.map((v) => `<span style="left:${pct(v)}">${ms(v)}</span>`).join('')

  const byReq = new Map()
  for (const sp of t.spans) {
    const k = sp.reqId ?? ''
    if (!byReq.has(k)) byReq.set(k, [])
    byReq.get(k).push(sp)
  }

  const spanHtml = (sp) =>
    `<button class="wf-span ${sp.level === 'high' ? 'high' : sp.level === 'med' ? 'med' : ''} ${sp.timing !== 'waited' ? 'off' : ''}" ` +
    `style="left:${pct(sp.offsetMs)};width:${pct(sp.durationMs)}" data-act="goto-group" data-group="${esc(sp.group ?? '')}" ` +
    `title="${esc(`${sp.durationMs} ms at +${ms(sp.offsetMs)}${sp.timing !== 'waited' ? ' — not waited for' : ''}`)}" aria-label="query"></button>`

  const rows = t.requests
    .map((r) => {
      const label = r.handler || `${r.method ?? ''} ${r.path ?? ''}`.trim() || 'request'
      const status = r.status ? `<span class="st ${r.status >= 400 ? 'bad' : ''}">${r.status}</span>` : ''
      const dur = r.durationMs != null ? `${ms(r.durationMs)}, db ${ms(r.dbMs)}` : 'no end seen'
      const title = `${r.method ?? ''} ${r.path ?? ''}\n${r.app ?? ''}\n${r.calls} quer${r.calls === 1 ? 'y' : 'ies'} · ${dur}`
      return `
        <div class="wf-row">
          <span class="wf-label" title="${esc(title)}">${status}<b>${esc(label)}</b> <span class="sub">${r.calls}q · ${esc(dur)}</span></span>
          <span class="wf-track">
            <span class="wf-req ${r.durationMs == null ? 'open-ended' : ''}" style="left:${pct(r.offsetMs)};width:${pct(r.durationMs ?? range - r.offsetMs)}"></span>
            ${(byReq.get(r.id) ?? []).map(spanHtml).join('')}
          </span>
        </div>`
    })
    .join('')

  // Calls whose request was never seen, or that belong to no request at all.
  const known = new Set(t.requests.map((r) => r.id))
  const orphans = t.spans.filter((sp) => !known.has(sp.reqId))
  const orphanRow = orphans.length
    ? `<div class="wf-row"><span class="wf-label"><b>outside a request</b> <span class="sub">${orphans.length}q</span></span>
         <span class="wf-track">${orphans.map(spanHtml).join('')}</span></div>`
    : ''

  return `
    <div class="section">
      <div class="section-title">Waterfall <span class="sub">${t.requests.length} request${t.requests.length === 1 ? '' : 's'}${
        t.sequential ? ` · ${t.sequential + 1} ran one after another` : ''
      }${t.spansTruncated ? ` · first ${t.spans.length} queries drawn` : ''} — click a query to open its group</span></div>
      <div class="wf">
        <div class="wf-axis"><span></span><span class="wf-ticks">${axis}</span></div>
        ${rows}${orphanRow}
        <div class="wf-legend">
          <span><i class="sw req"></i>request</span>
          <span><i class="sw db"></i>query</span>
          <span><i class="sw amber"></i>worth a look</span>
          <span><i class="sw red"></i>removable</span>
        </div>
      </div>
    </div>`
}

function paintDetail(id, d) {
  const host = list.querySelector(`.action[data-id="${CSS.escape(id)}"] .detail`)
  if (!host) return

  const scaling = d.scaling ?? {}
  const cost = scaling.formula
    ? `<div class="sub costline" title="Where the call count comes from. A term with no dimension is a constant; the rest are a call per row of the named table, multiplied for each level of nesting.">
         cost: ${esc(scaling.formula)}${
           scaling.maxDepth
             ? ` — about <b>${scaling.projected}</b> at ${scaling.factor}× the data${
                 scaling.worstCase > scaling.projected ? `, up to <b>${scaling.worstCase}</b> if every level grows` : ''
               }`
             : ''
         }${
           scaling.unclassified
             ? ` <span class="unknown" title="A loop whose driver could not be established is left out of the projection rather than guessed at.">(${scaling.unclassified} loop${scaling.unclassified === 1 ? '' : 's'} unclassified)</span>`
             : ''
         }
       </div>`
    : ''

  const meta = `
    <div class="sub meta">
      ${d.roundTrips} round-trip${d.roundTrips === 1 ? '' : 's'} ·
      ${d.requests} request${d.requests === 1 ? '' : 's'} ·
      ${esc(d.apps.join(', '))}
      ${d.roundTripSavings ? ` · ${d.roundTripSavings} round-trips removable by batching` : ''}
      ${d.url ? ` · ${esc(d.url)}` : ''}
    </div>`

  host.innerHTML =
    verdictHtml(d.time) +
    splitHtml(d.time, d) +
    fixFirstHtml(d.time) +
    waterfallHtml(d.time) +
    meta +
    cost +
    (d.findings.length
      ? `<div class="section-title">About the whole click</div><div class="findings">${d.findings.map(findingHtml).join('')}</div>`
      : '') +
    `<div class="section-title">Queries <span class="sub">${d.groups.length} group${d.groups.length === 1 ? '' : 's'}, most removable first</span></div>` +
    d.groups.map((g) => groupRow(id, g)).join('')
  host.hidden = false
}

/** Opens a query group from the fix list or the waterfall, and brings it into view. */
function gotoGroup(actionId, groupId) {
  if (!groupId) return
  const actionEl = list.querySelector(`.action[data-id="${CSS.escape(actionId)}"]`)
  const groupEl = actionEl?.querySelector(`.group[data-key="${CSS.escape(groupId)}"]`)
  if (!groupEl) return
  if (!openGroups.has(`${actionId}::${groupId}`)) groupEl.querySelector('.grow').click()
  groupEl.scrollIntoView({ block: 'start', behavior: 'smooth' })
  groupEl.classList.remove('flash')
  void groupEl.offsetWidth // restart the animation
  groupEl.classList.add('flash')
}

async function loadDetail(id) {
  const res = await fetch(`/api/action/${encodeURIComponent(id)}`)
  if (!res.ok) return
  const detail = await res.json()
  details.set(id, detail)
  paintDetail(id, detail)
}

// ---------------------------------------------------------------- behaviour

list.addEventListener('click', (event) => {
  // Row tools must never also toggle the row open.
  const tool = event.target.closest('[data-act]')
  if (tool) {
    event.stopPropagation()
    const actionId = tool.closest('.action').dataset.id
    const groupId = tool.closest('.group')?.dataset.key

    switch (tool.dataset.act) {
      case 'note':
        openNote(actionId)
        break
      case 'delete':
        deleteFlow(actionId)
        break
      case 'copy-call':
        copyCall(actionId, groupId, tool)
        break
      case 'export-menu':
        openExportMenu(tool, actionId, groupId)
        break
      case 'goto-group':
        gotoGroup(actionId, tool.dataset.group)
        break
    }
    return
  }

  const groupBtn = event.target.closest('.grow')
  if (groupBtn) {
    const groupEl = groupBtn.parentElement
    const actionEl = groupEl.closest('.action')
    const key = `${actionEl.dataset.id}::${groupEl.dataset.key}`
    const body = groupEl.querySelector('.gdetail')

    if (openGroups.has(key)) {
      openGroups.delete(key)
      groupEl.classList.remove('open')
      body.hidden = true
      body.innerHTML = ''
    } else {
      openGroups.add(key)
      groupEl.classList.add('open')
      const detail = details.get(actionEl.dataset.id)
      const group = detail?.groups.find((g) => g.id === groupEl.dataset.key)
      if (group) body.innerHTML = groupBody(group)
      body.hidden = false
    }
    return
  }

  const actionBtn = event.target.closest('.arow')
  if (!actionBtn) return

  const actionEl = actionBtn.parentElement
  const id = actionEl.dataset.id
  const body = actionEl.querySelector('.detail')

  if (open.has(id)) {
    open.delete(id)
    actionEl.classList.remove('open')
    body.hidden = true
    body.innerHTML = ''
  } else {
    open.add(id)
    actionEl.classList.add('open')
    const detail = details.get(id)
    if (detail) paintDetail(id, detail)
    else loadDetail(id)
  }
})

// Action and group rows carry buttons, so they are divs rather than buttons and
// need their own keyboard handling.
list.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const row = event.target.closest('.arow, .grow')
  if (!row) return
  event.preventDefault()
  row.click()
})

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

// ------------------------------------------------------------ flow actions

const noteDialog = document.getElementById('noteDialog')
const noteText = document.getElementById('noteText')
let noteTarget = null

function openNote(id) {
  const item = state?.items.find((i) => i.id === id)
  noteTarget = id
  noteText.value = item?.note ?? ''
  document.getElementById('noteFlowLabel').textContent = item?.label ?? ''
  noteDialog.showModal()
  noteText.focus()
}

noteDialog.addEventListener('close', async () => {
  if (noteDialog.returnValue !== 'save' || !noteTarget) return
  const id = noteTarget
  noteTarget = null
  await post('/api/flow/note', { id, note: noteText.value })
  lastRows = '' // the row's note marker changes
})

// Ctrl+Enter saves without reaching for the mouse.
noteText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    document.getElementById('noteSave').click()
  }
})

// ------------------------------------------------------- exporting one call

/**
 * The detail of a flow, fetched if the cache does not have it. The cache is
 * dropped whenever new data arrives for a flow, so a button pressed in that
 * moment must not find nothing and silently do nothing.
 */
async function detailOf(actionId) {
  let detail = details.get(actionId)
  if (!detail) {
    const res = await fetch(`/api/action/${encodeURIComponent(actionId)}`)
    if (!res.ok) return null
    detail = await res.json()
    details.set(actionId, detail)
  }
  return detail
}

async function findGroup(actionId, groupId) {
  const detail = await detailOf(actionId)
  const group = detail?.groups.find((g) => g.id === groupId)
  return group ? { detail, group } : null
}

/** One call as Markdown — the shape you would paste into a ticket or a PR. */
function callAsText(detail, g) {
  const site = g.callsite
    ? `\`${g.callsite.method}\`${g.callsite.file ? ` — ${g.callsite.file}${g.callsite.line ? ':' + g.callsite.line : ''}` : ''}`
    : '(no application frames captured)'

  const out = [
    `### ${g.op} ${g.table ?? '(no table parsed)'} — ${g.count}× in ${Math.round(g.totalMs)} ms`,
    '',
    `- **Action:** ${detail.label}`,
    `- **Where:** ${site}`,
    `- **Endpoint:** ${g.endpoints.join(', ') || '—'}`,
    `- **App:** ${g.apps.join(', ') || '—'}`,
    ...((g.sources ?? []).length > 1 ? [`- **Tables (one query):** ${g.sources.map(sourceLine).join(', ')}`] : []),
    `- **Executions:** ${g.count} statement${g.count === 1 ? '' : 's'} in ${g.roundTrips} round-trip${g.roundTrips === 1 ? '' : 's'}` +
      (g.op === 'SELECT' ? `, ${g.distinctParams} distinct parameter set${g.distinctParams === 1 ? '' : 's'}` : `, ${g.distinctRows} distinct row${g.distinctRows === 1 ? '' : 's'}`),
  ]

  if (KIND_TEXT[g.kind]) out.push(`- **Kind:** ${KIND_TEXT[g.kind][0]}`)
  if (g.staticLoop) {
    const l = g.staticLoop
    const loop = l.loops?.[l.loops.length - 1]
    out.push(
      `- **In a loop:** ${l.file}:${l.line}${loop?.header ? ` — \`${loop.header}\`` : ''}` +
        (l.confidence === 'exact' ? ' (static analysis)' : ' (static analysis, nearby line)'),
    )
  }

  const off = (g.timing?.afterResponse ?? 0) + (g.timing?.background ?? 0)
  if (off) {
    const parts = []
    if (g.timing.afterResponse) parts.push(`${g.timing.afterResponse} after the response was already sent`)
    if (g.timing.background) parts.push(`${g.timing.background} outside any request (background)`)
    out.push(`- **Not waited for:** ${parts.join(', ')} — database load the user never waited on`)
  }
  if (g.sync && g.timing?.waited) {
    out.push('- **API:** blocking (non-async) — the thread waits idle for the database')
  }

  if (g.scaling) {
    const s = g.scaling
    out.push(
      `- **Growth:** ` +
        (s.depth === null
          ? `runs ${s.executions}× in a loop, but what drives it could not be established`
          : s.depth === 0
            ? 'fixed — the count does not follow the data'
            : `one call per ${s.chain.join(' × ')} row — ${s.executions} today, ${s.depth} level${s.depth === 1 ? '' : 's'} deep`),
    )
  }

  if (g.findings.length) {
    out.push('', '#### Findings')
    for (const f of g.findings) {
      const saving = f.avoidable ? ` (${f.bucket === 'across' ? '~' : '-'}${f.avoidable} calls)` : ''
      out.push('', `**${f.title}**${saving}`, f.detail)
      if (f.fix) out.push(`*Fix:* ${f.fix}`)
    }
  }

  if (g.callPaths?.length) {
    out.push('', `#### Called from ${g.callPaths.length === 1 ? '' : `(${g.callPaths.length} different paths)`}`.trim())
    for (const p of g.callPaths) {
      out.push('', `${p.count}× via **${p.origin ?? 'unknown'}**`)
      ;[...p.frames].reverse().forEach((f, i) => {
        out.push(`${i + 1}. \`${f.m}\`${f.f ? ` — ${f.f}${f.l ? ':' + f.l : ''}` : ''}`)
      })
    }
  }

  out.push('', '#### SQL', '```sql', g.sampleSql ?? '', '```')

  const shown = g.executions.slice(0, 25)
  out.push('', `#### Executions${g.count > shown.length ? ` (first ${shown.length} of ${g.count})` : ''}`, '')
  out.push('| # | at | took | rows | from | parameters |', '|---|---|---|---|---|---|')
  shown.forEach((e, i) => {
    const rows = g.op === 'SELECT' ? e.rowsRead : e.rowsAffected
    out.push(
      `| ${i + 1} | ${clock(e.ts)} | ${e.durationMs ? Math.round(e.durationMs) + ' ms' : '—'} ` +
        `| ${rows > 0 ? (g.op !== 'SELECT' && e.rowsAffectedDerived ? '≈' : '') + rows : '—'} ` +
        `| ${e.origin ?? e.handler ?? ''} | ${(e.params ?? []).map((p) => `${p.n}=${p.v}`).join(', ') || '—'} |`,
    )
  })

  out.push('', `_Recorded by ${PRODUCT} on ${new Date(detail.startedAt).toLocaleString()}._`)
  return out.join('\n')
}

async function copyCall(actionId, groupId, button) {
  const found = await findGroup(actionId, groupId)
  if (!found) return

  const label = button.innerHTML
  try {
    await navigator.clipboard.writeText(callAsText(found.detail, found.group))
    button.innerHTML = '&#10003; Copied'
  } catch {
    button.innerHTML = 'Could not copy'
  }
  setTimeout(() => (button.innerHTML = label), 1800)
}

/**
 * The spreadsheet exports are built by the collector, so the browser only has to
 * follow a link. That keeps the Excel-specific handling in one place instead of
 * having a second copy of it here, and lets the server name the file.
 */
function downloadCsv(params) {
  const query = new URLSearchParams(params).toString()
  const link = Object.assign(document.createElement('a'), { href: `/api/export.csv?${query}` })
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Shared by both JSON exports so a file always lands the same way. */
function downloadJson(name, payload) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name.replace(/[^\w.-]+/g, '-') })
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** The whole flow — every call in it — from the row, without opening it. */
async function exportFlow(actionId) {
  const detail = await detailOf(actionId)
  if (!detail) return

  downloadJson(`flow-${detail.label}-${Date.now()}.json`, {
    exportedAt: new Date().toISOString(),
    exportedBy: PRODUCT,
    flow: detail,
  })
}

async function downloadCall(actionId, groupId) {
  const found = await findGroup(actionId, groupId)
  if (!found) return
  const { detail, group } = found

  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: PRODUCT,
    action: {
      id: detail.id,
      label: detail.label,
      startedAt: detail.startedAt,
      apps: detail.apps,
      endpoints: detail.endpoints,
    },
    call: group,
  }

  downloadJson(`${group.op}-${group.table ?? 'call'}-${Date.now()}.json`, payload)
}

// -------------------------------------------------------------- export menu

// One shared dropdown for every export button: which button opened it decides
// whether it exports a whole flow or a single call, and in which format.
const exportMenu = document.getElementById('exportMenu')
let exportTarget = null

function openExportMenu(button, actionId, groupId) {
  // A second click on the button that opened it closes it again.
  if (!exportMenu.hidden && exportTarget?.button === button) return closeExportMenu()

  exportTarget = { button, actionId, groupId }
  document.getElementById('exportMenuTitle').textContent = groupId ? 'Export this call' : 'Export this flow'

  // Paint it before measuring, or the first open reads a zero-size box.
  exportMenu.hidden = false
  placeExportMenu(button)
  exportMenu.querySelector('button').focus()
}

function placeExportMenu(button) {
  const anchor = button.getBoundingClientRect()
  const size = exportMenu.getBoundingClientRect()
  const left = Math.max(8, Math.min(anchor.right - size.width, window.innerWidth - size.width - 8))
  const fitsBelow = anchor.bottom + 4 + size.height <= window.innerHeight - 8
  exportMenu.style.left = `${left}px`
  exportMenu.style.top = `${fitsBelow ? anchor.bottom + 4 : anchor.top - size.height - 4}px`
}

/**
 * The button the menu belongs to, as it is now. An open row is repainted when
 * new data arrives, which replaces the button the menu was opened from.
 */
function exportAnchor() {
  if (!exportTarget) return null
  if (exportTarget.button.isConnected) return exportTarget.button
  const row = list.querySelector(`.action[data-id="${CSS.escape(exportTarget.actionId)}"]`)
  const scope = exportTarget.groupId ? row?.querySelector(`.group[data-key="${CSS.escape(exportTarget.groupId)}"] .grow`) : row?.querySelector('.arow')
  const found = scope?.querySelector('button[data-act="export-menu"]') ?? null
  if (found) exportTarget.button = found
  return found
}

function closeExportMenu() {
  exportMenu.hidden = true
  exportTarget = null
}

exportMenu.addEventListener('click', (event) => {
  const item = event.target.closest('button[data-format]')
  if (!item || !exportTarget) return
  const { actionId, groupId } = exportTarget
  closeExportMenu()

  if (item.dataset.format === 'csv') {
    downloadCsv(groupId ? { flow: actionId, group: groupId } : { flow: actionId })
  } else if (groupId) {
    downloadCall(actionId, groupId)
  } else {
    exportFlow(actionId)
  }
})

document.addEventListener('click', (event) => {
  if (!exportMenu.hidden && !exportMenu.contains(event.target)) closeExportMenu()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !exportMenu.hidden) closeExportMenu()
})

// The menu is fixed-position, so it follows its row while the list scrolls -
// including the small scrolls a repaint causes - and closes only once that row
// has left the list's view.
list.addEventListener(
  'scroll',
  () => {
    if (exportMenu.hidden) return
    const button = exportAnchor()
    const box = button?.getBoundingClientRect()
    const view = list.getBoundingClientRect()
    if (!box || box.bottom < view.top || box.top > view.bottom) return closeExportMenu()
    placeExportMenu(button)
  },
  { passive: true },
)

async function deleteFlow(id) {
  const item = state?.items.find((i) => i.id === id)
  const saved = item?.saved && state?.project
  const message = saved
    ? `Delete the flow "${item.label}" from project ${state.project.name}?\n\nThis removes its file from disk.`
    : `Remove "${item?.label ?? 'this flow'}" from the list?`

  if (!confirm(message)) return
  await post('/api/flow/delete', { id })
  open.delete(id)
  details.delete(id)
  lastRows = ''
}

document.getElementById('clearBtn').addEventListener('click', async () => {
  // Deleting one flow asks; throwing away a whole session should not be the one
  // thing that does not, least of all from a keyboard shortcut.
  const flows = state?.items.length ?? 0
  if (flows > 0) {
    const unsaved = state?.items.filter((i) => !i.saved).length ?? 0
    const warning = state?.project
      ? `Clear the list?\n\n${flows} flow${flows === 1 ? '' : 's'} disappear from the window. ` +
        `Saved flows stay in project ${state.project.name} and come back when you reopen it` +
        (unsaved ? `, but ${unsaved} not yet saved would be lost.` : '.')
      : `Throw away everything collected so far?\n\n${flows} flow${flows === 1 ? '' : 's'}, ` +
        `not saved anywhere — no project is open, so this cannot be undone.`
    if (!confirm(warning)) return
  }

  await post('/api/clear')
  open.clear()
  openGroups.clear()
  details.clear()
  signatures.clear()
  lastRows = ''
})

document.getElementById('recBtn').addEventListener('click', async () => {
  await post('/api/record', { on: !state?.recording })
})

const markBtn = document.getElementById('markBtn')
const markLabel = document.getElementById('markLabel')

markBtn.addEventListener('click', async () => {
  if (state?.manual) {
    await post('/api/mark', { stop: true })
    markBtn.textContent = 'Mark'
    markBtn.classList.remove('on')
  } else {
    await post('/api/mark', { label: markLabel.value.trim() || 'Manual marker' })
    markBtn.textContent = 'Stop'
    markBtn.classList.add('on')
  }
})

markLabel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') markBtn.click()
})

// ----------------------------------------------------------------- projects

const projectBtn = document.getElementById('projectBtn')
const projectMenu = document.getElementById('projectMenu')
const projectList = document.getElementById('projectList')

function paintProject(s) {
  const inProject = Boolean(s.project)
  document.getElementById('projectName').textContent = s.project ? s.project.name : 'Scratch'
  projectBtn.classList.toggle('open', inProject)
  projectBtn.title = inProject
    ? `Recording into project "${s.project.name}" — every flow is saved automatically`
    : 'Not recording into a project — nothing is saved to disk. Click to open or create one.'

  document.getElementById('renameProject').disabled = !inProject
  document.getElementById('deleteProject').disabled = !inProject
  document.getElementById('closeProject').disabled = !inProject
  document.getElementById('dataRoot').textContent = s.dataRoot ?? ''

  projectList.innerHTML = s.projects.length
    ? s.projects
        .map(
          (p) => `
      <button data-folder="${esc(p.folder)}" class="${s.project?.folder === p.folder ? 'current' : ''}">
        <span>${esc(p.name)}</span>
        <span class="count">${p.flows} flow${p.flows === 1 ? '' : 's'}</span>
      </button>`,
        )
        .join('')
    : '<div class="none">No projects yet — create one below.</div>'
}

projectBtn.addEventListener('click', (event) => {
  event.stopPropagation()
  projectMenu.hidden = !projectMenu.hidden
  if (!projectMenu.hidden) document.getElementById('newProjectName').focus()
})

document.addEventListener('click', (event) => {
  if (!projectMenu.hidden && !projectMenu.contains(event.target)) projectMenu.hidden = true
})

projectList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-folder]')
  if (!button) return
  projectMenu.hidden = true
  await switchProject(button.dataset.folder)
})

document.getElementById('newProjectForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = document.getElementById('newProjectName')
  const name = input.value.trim()
  if (!name) return

  const res = await post('/api/projects/create', { name })
  if (!res.ok) {
    alert((await res.json()).error ?? 'Could not create the project.')
    return
  }
  input.value = ''
  projectMenu.hidden = true
  resetView()
})

document.getElementById('closeProject').addEventListener('click', async () => {
  projectMenu.hidden = true
  await switchProject(null)
})

document.getElementById('renameProject').addEventListener('click', async () => {
  if (!state?.project) return
  const name = prompt('New name for this project:', state.project.name)
  if (!name?.trim()) return
  projectMenu.hidden = true
  await post('/api/projects/rename', { folder: state.project.folder, name: name.trim() })
})

document.getElementById('deleteProject').addEventListener('click', async () => {
  if (!state?.project) return
  const { name, folder } = state.project
  if (!confirm(`Delete project "${name}" and every flow in it?\n\nThe folder data/${folder} is removed from disk.`)) return
  projectMenu.hidden = true
  await post('/api/projects/delete', { folder })
  resetView()
})

async function switchProject(folder) {
  const res = await post('/api/projects/open', { folder })
  if (!res.ok) {
    alert((await res.json()).error ?? 'Could not open the project.')
    return
  }
  resetView()
}

/** Opening/closing a project replaces the whole list, so drop every cached view. */
function resetView() {
  open.clear()
  openGroups.clear()
  details.clear()
  signatures.clear()
  lastRows = ''
}

// ----------------------------------------------------------------- settings

const settingsDialog = document.getElementById('settingsDialog')

/** Threshold input id <-> settings key, used in both directions. */
const THRESHOLD_FIELDS = {
  thSlowMs: 'slowMs',
  thVerySlowMs: 'verySlowMs',
  thWideCols: 'wideCols',
  thLoopRoundTrips: 'loopRoundTrips',
  thNPlusOneMin: 'nPlusOneMin',
  thNPlusOneMaxParams: 'nPlusOneMaxParams',
  thProjectionFactor: 'projectionFactor',
}

document.getElementById('settingsBtn').addEventListener('click', async () => {
  const config = await (await fetch('/api/config')).json()
  document.getElementById('apiPorts').value = (config.apiPorts ?? []).join(', ')
  document.getElementById('loopReport').value = config.loopReport ?? ''
  paintLoopStatus(config.loops)
  document.getElementById('collectorPorts').textContent =
    `The app itself uses port ${config.uiPort} for this window and ${config.ingestPort} for the probes.`

  for (const [id, key] of Object.entries(THRESHOLD_FIELDS)) {
    document.getElementById(id).value = config.thresholds?.[key] ?? ''
  }

  // Not a setting: the probe reads it as a process starts, so it can only be
  // changed for apps that have not been started yet.
  document.getElementById('paramsNote').textContent = state?.paramsCaptured
    ? 'Recorded queries include their parameter values — real data from whatever database you tested ' +
      'against. To record without them, start the app with DBPROBE_PARAMS=off; APIs already running ' +
      'keep the setting they started with.'
    : 'DBPROBE_PARAMS=off is set, so parameter values are not recorded. Row identity and duplicate ' +
      'detection need those values, so duplicate writes and repeated reads cannot be counted.'

  settingsDialog.showModal()
})

function paintLoopStatus(loops) {
  const el = document.getElementById('loopStatus')
  el.className = 'sub'
  if (!loops?.configured) {
    el.textContent = 'No report set.'
  } else if (loops.error) {
    el.className = 'sub bad'
    el.textContent = loops.error
  } else {
    el.className = 'sub good'
    el.textContent = `${loops.findings} database calls in loops loaded, from a file changed ${new Date(loops.modifiedAt).toLocaleString()}.`
  }
}

const helpDialog = document.getElementById('helpDialog')
document.getElementById('helpBtn').addEventListener('click', () => helpDialog.showModal())

// -------------------------------------------------------------------- theme

// Follows Windows unless told otherwise. Remembered per machine; a page that
// cannot use storage simply follows Windows every time.
const THEMES = ['auto', 'light', 'dark']
const THEME_TITLE = { auto: 'Theme: follow Windows', light: 'Theme: light', dark: 'Theme: dark' }
const themeBtn = document.getElementById('themeBtn')

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  themeBtn.title = THEME_TITLE[theme]
  themeBtn.classList.toggle('on', theme !== 'auto')
}

let theme = 'auto'
try {
  theme = localStorage.getItem('clicktrace.theme') ?? 'auto'
} catch {}
applyTheme(THEMES.includes(theme) ? theme : 'auto')

themeBtn.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
  applyTheme(theme)
  try {
    localStorage.setItem('clicktrace.theme', theme)
  } catch {}
})

// ------------------------------------------------------------------ updates

// Only the desktop shell can run git and rebuild, so this is hidden in a browser.
const updateBox = document.getElementById('updateBox')
const updateMessage = document.getElementById('updateMessage')
const updateChanges = document.getElementById('updateChanges')
const updateApply = document.getElementById('updateApply')

function paintUpdate(data) {
  updateMessage.textContent = data.message ?? ''
  updateMessage.className = 'sub' + (data.state === 'problem' ? ' bad' : data.state === 'available' ? ' good' : '')

  if (data.current) {
    document.getElementById('updateVersion').textContent =
      `${data.current}${data.currentDate ? ` · ${data.currentDate}` : ''}${data.dirty ? ' · local changes' : ''}`
  }

  updateApply.hidden = !data.canApply
  document.getElementById('updateCheck').disabled = data.state === 'busy'

  const changes = data.changes ?? []
  updateChanges.hidden = changes.length === 0
  updateChanges.innerHTML = changes.map((c) => `<li>${esc(c)}</li>`).join('')
}

if (shell) {
  updateBox.hidden = false
  document.getElementById('updateCheck').addEventListener('click', () => send('update-check'))
  updateApply.addEventListener('click', () => {
    if (confirm('Update to the latest version?\n\nThe app will rebuild and restart. Your projects and recordings are not touched.')) {
      send('update-apply')
    }
  })
}

settingsDialog.addEventListener('close', async () => {
  if (settingsDialog.returnValue !== 'save') return
  const apiPorts = document
    .getElementById('apiPorts')
    .value.split(/[\s,;]+/)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)

  const thresholds = {}
  for (const [id, key] of Object.entries(THRESHOLD_FIELDS)) {
    const value = Number(document.getElementById(id).value)
    if (Number.isFinite(value) && value > 0) thresholds[key] = value
  }

  await post('/api/config', { apiPorts, thresholds, loopReport: document.getElementById('loopReport').value })
  // Everything was judged under the old thresholds.
  details.clear()
  signatures.clear()
  lastRows = ''
})

// -------------------------------------------------------------- native shell

// Only present when the page is hosted by the desktop app, not in a browser.

if (shell) {
  // The window's own buttons handle minimise/close; only the pin is ours.
  document.getElementById('shellTools').hidden = false
  document.getElementById('pinBtn').addEventListener('click', () => send('toggle-pin'))

  shell.addEventListener('message', (event) => {
    const data = event.data
    if (data?.type === 'update') return paintUpdate(data)
    if (data?.type !== 'shell') return

    document.getElementById('pinBtn').classList.toggle('on', Boolean(data.pinned))
    setup = data.setup ?? null
    if (state) render()
  })

  document.getElementById('setupInstall').addEventListener('click', () => send('setup-install'))
  document.getElementById('setupRestartBtn').addEventListener('click', () => send('setup-restart'))

  // Keep the list of running APIs current while the setup panel is on screen.
  setInterval(() => {
    if (!empty.hidden) send('setup-refresh')
  }, 3000)
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'F12') return send('devtools')
  if (event.key === 'F1') {
    event.preventDefault()
    return helpDialog.showModal()
  }
  if (!event.ctrlKey || event.altKey) return

  const handled = {
    t: () => send('toggle-pin'),
    r: () => send('reload'),
    l: () => document.getElementById('clearBtn').click(),
    m: () => markLabel.focus(),
    p: () => document.getElementById('recBtn').click(),
    f: () => filterText.focus(),
  }[event.key.toLowerCase()]

  if (handled) {
    event.preventDefault()
    handled()
  }
})

// ------------------------------------------------------------------- stream

function connect() {
  const source = new EventSource('/api/stream')

  source.onmessage = (event) => {
    const previous = state?.version
    state = JSON.parse(event.data)

    // Drop cached detail for the flows that actually moved. `rev` is what makes
    // this correct: the recorder sends a statement first and its row count
    // afterwards, and the second half changes what an open row shows without
    // changing any of the totals the row itself displays.
    for (const item of state.items) {
      if (signatures.get(item.id) !== item.rev) {
        signatures.set(item.id, item.rev)
        details.delete(item.id)
      }
    }

    render()
    markBtn.textContent = state.manual ? 'Stop' : 'Mark'
    markBtn.classList.toggle('on', Boolean(state.manual))
  }

  source.onerror = () => {
    source.close()
    setTimeout(connect, 1500)
  }
}

connect()
