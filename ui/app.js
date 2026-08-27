const list = document.getElementById('list')
const empty = document.getElementById('empty')

const open = new Set() // action ids the user unfolded
const openGroups = new Set() // "actionId::groupKey" the user unfolded
const details = new Map() // actionId -> analysed detail
const signatures = new Map() // actionId -> "total:avoidable:ms", to know when to refetch

let state = null
let repoRoot = null
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

// ------------------------------------------------------------------- header

function paintTotals(s) {
  document.getElementById('tCalls').textContent = s.total
  document.getElementById('tInReq').textContent = s.avoidableInRequest ?? 0
  document.getElementById('tWrites').textContent = s.avoidableWrites ?? 0
  document.getElementById('tAcross').textContent = s.avoidableAcrossRequests ?? 0
  document.getElementById('tProjected').textContent = s.projected
  document.getElementById('tMs').textContent = ms(s.totalMs)
  document.getElementById('tRed').textContent = s.red
  document.getElementById('tAmber').textContent = s.amber
  document.getElementById('tGreen').textContent = s.green

  const apps = s.apps.map((a) => a.app.replace(/^WebApi\./, '')).join(', ')
  document.getElementById('apps').textContent =
    (apps ? `${apps}` : 'waiting for a probe…') +
    (s.manual ? ` · marker: ${s.manual}` : '') +
    (s.dropped ? ` · ${s.dropped} events dropped` : '')

  document.getElementById('recDot').classList.toggle('paused', !s.recording)
  document.getElementById('recBtn').textContent = s.recording ? 'Pause' : 'Resume'
}

// -------------------------------------------------------------- action rows

function actionRow(a) {
  const pctOf = (n) => (a.total > 0 ? Math.round(((n ?? 0) / a.total) * 100) : 0)
  const wastePct = pctOf(a.avoidable)
  const acrossPct = pctOf(a.avoidableAcrossRequests)
  const findings = a.topFindings.map((f) => f.title).join(' · ')
  const sub = findings || a.endpoints.join(', ') || '—'

  const breakdown =
    `${a.total} calls\n` +
    `${a.avoidableInRequest ?? 0} repeated inside one request\n` +
    `${a.avoidableWrites ?? 0} rows written more than once\n` +
    `${a.avoidableAcrossRequests ?? 0} repeated across requests (architectural — not counted)\n` +
    `= ${a.projected} could be`

  const noteTitle = a.note ? `Description:\n${a.note}` : 'Describe what this flow covers'

  return `
    <div class="action ${a.colour} ${open.has(a.id) ? 'open' : ''}" data-id="${esc(a.id)}">
      <div class="arow" role="button" tabindex="0" aria-expanded="${open.has(a.id)}">
        <span class="chev">&#9656;</span>
        <span class="tag ${a.colour}">${TAG[a.colour]}</span>
        <span class="label" title="${esc(a.label)}">${esc(a.label)}</span>
        <span class="sub" title="${esc(sub)}">${esc(sub)}</span>
        <span class="bar" title="${esc(breakdown)}">
          <i style="width:${wastePct}%"></i><i class="soft" style="width:${acrossPct}%"></i>
        </span>
        <span class="nums" title="${esc(breakdown)}">
          <b>${a.total}</b> call${a.total === 1 ? '' : 's'}
          ${a.avoidable ? `<span class="to">&rarr;</span> <b class="save">${a.projected}</b>` : ''}
        </span>
        <span class="ms">${ms(a.totalMs)}</span>
        <span class="rowtools">
          <button class="note ${a.note ? 'has-note' : ''}" data-act="note" title="${esc(noteTitle)}">
            ${a.note ? '&#128221;' : '&#9998;'}
          </button>
          <button data-act="export-flow" title="Export this whole flow — every call in it — as JSON">&#11015;</button>
          <button class="del" data-act="delete" title="Delete this flow">&#128465;</button>
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

  const rows = state.items.map(actionRow).join('')
  if (rows === lastRows) return
  lastRows = rows

  const scroll = list.scrollTop
  list.innerHTML = rows
  list.scrollTop = scroll

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
          ${esc(g.table ?? '(no table parsed)')}
        </span>
        <span class="count ${g.avoidable ? 'bad' : g.avoidableAcrossRequests ? 'soft' : ''}">&times;${g.count}</span>
        <span class="sub">${uniqueText}</span>
        <span class="site" title="${esc(siteTooltip(g))}">${site}</span>
        <span class="ms">${ms(g.totalMs)}</span>
        <span class="rowtools">
          <button data-act="copy-call" title="Copy this call as text — finding, fix, call paths, SQL and executions">&#128203;</button>
          <button data-act="save-call" title="Download this call as JSON">&#11015;</button>
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

  const seen = new Map()
  let previousCall = null

  const rows = g.executions
    .map((e, i) => {
      const sig = (e.params ?? []).map((p) => p.v).join('|')
      const first = seen.get(sig)
      if (first === undefined) seen.set(sig, i)
      const dupe = first !== undefined

      // Several statements can share one round-trip; only the first carries its cost.
      const sameTrip = e.id === previousCall
      previousCall = e.id
      const took = sameTrip
        ? '<span class="sub" title="same round-trip as the row above">&#8627;</span>'
        : e.durationMs
          ? Math.round(e.durationMs) + ' ms'
          : '—'
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

function paintDetail(id, d) {
  const host = list.querySelector(`.action[data-id="${CSS.escape(id)}"] .detail`)
  if (!host) return

  const header = `
    <div class="sub" style="margin:6px 0 2px">
      ${d.roundTrips} round-trip${d.roundTrips === 1 ? '' : 's'} ·
      ${d.requests} request${d.requests === 1 ? '' : 's'} ·
      ${esc(d.apps.join(', '))}
      ${d.roundTripSavings ? ` · ${d.roundTripSavings} round-trips removable by batching` : ''}
      ${d.url ? ` · ${esc(d.url)}` : ''}
    </div>`

  host.innerHTML =
    header +
    (d.findings.length ? `<div class="findings">${d.findings.map(findingHtml).join('')}</div>` : '') +
    d.groups.map((g) => groupRow(id, g)).join('')
  host.hidden = false
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
      case 'save-call':
        downloadCall(actionId, groupId)
        break
      case 'export-flow':
        exportFlow(actionId)
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

function findGroup(actionId, groupId) {
  const detail = details.get(actionId)
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
    `- **Executions:** ${g.count} statement${g.count === 1 ? '' : 's'} in ${g.roundTrips} round-trip${g.roundTrips === 1 ? '' : 's'}` +
      (g.op === 'SELECT' ? `, ${g.distinctParams} distinct parameter set${g.distinctParams === 1 ? '' : 's'}` : `, ${g.distinctRows} distinct row${g.distinctRows === 1 ? '' : 's'}`),
  ]

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

  out.push('', `_Recorded by DB Call Overlay on ${new Date(detail.startedAt).toLocaleString()}._`)
  return out.join('\n')
}

async function copyCall(actionId, groupId, button) {
  const found = findGroup(actionId, groupId)
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

/** Shared by both export buttons so a file always lands the same way. */
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
  let detail = details.get(actionId)
  if (!detail) {
    const res = await fetch(`/api/action/${encodeURIComponent(actionId)}`)
    if (!res.ok) return
    detail = await res.json()
    details.set(actionId, detail)
  }

  downloadJson(`flow-${detail.label}-${Date.now()}.json`, {
    exportedAt: new Date().toISOString(),
    exportedBy: 'DB Call Overlay',
    flow: detail,
  })
}

function downloadCall(actionId, groupId) {
  const found = findGroup(actionId, groupId)
  if (!found) return
  const { detail, group } = found

  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'DB Call Overlay',
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

document.getElementById('settingsBtn').addEventListener('click', async () => {
  const config = await (await fetch('/api/config')).json()
  document.getElementById('apiPorts').value = (config.apiPorts ?? []).join(', ')
  document.getElementById('collectorPorts').textContent =
    `The app itself uses port ${config.uiPort} for this window and ${config.ingestPort} for the probes.`
  settingsDialog.showModal()
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

  await post('/api/config', { apiPorts })
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
  if (!event.ctrlKey || event.altKey) return

  const handled = {
    t: () => send('toggle-pin'),
    r: () => send('reload'),
    l: () => document.getElementById('clearBtn').click(),
    m: () => markLabel.focus(),
    p: () => document.getElementById('recBtn').click(),
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
    state = JSON.parse(event.data)
    repoRoot = state.repoRoot

    // Only drop cached detail for actions that actually gained calls.
    for (const item of state.items) {
      const sig = `${item.total}:${item.avoidable}:${item.totalMs}`
      if (signatures.get(item.id) !== sig) {
        signatures.set(item.id, sig)
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
