// Probes the collector the way a hostile local process or web page would.
// Run with the collector up: node tools/security-test.mjs
const BASE = 'http://127.0.0.1:8478'

let issues = 0
const report = (bad, what, detail = '') => {
  console.log(`${bad ? 'ISSUE' : ' ok  '}  ${what}${detail ? `  — ${detail}` : ''}`)
  if (bad) issues++
}

const get = (p, init) => fetch(BASE + p, init)

// 1. Can any web origin READ the recording? -----------------------------------
{
  const res = await get('/api/state', { headers: { Origin: 'https://evil.example' } })
  const acao = res.headers.get('access-control-allow-origin')
  report(acao === '*', 'recorded data readable by any web origin', `Access-Control-Allow-Origin: ${acao}`)
}

// 2. Can any web origin DESTROY data? ----------------------------------------
{
  const res = await get('/api/clear', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  })
  const acao = res.headers.get('access-control-allow-origin')
  report(res.ok && acao === '*', 'destructive endpoints accept cross-origin calls', `/api/clear -> ${res.status}, ACAO ${acao}`)
}

// 3. Does the export leak to any origin? -------------------------------------
{
  const res = await get('/api/export', { headers: { Origin: 'https://evil.example' } })
  report(res.headers.get('access-control-allow-origin') === '*', 'full export readable cross-origin')
}

// 4. Path traversal out of the ui folder -------------------------------------
for (const attempt of [
  '/../server/index.mjs',
  '/..%2fserver%2findex.mjs',
  '/%2e%2e/%2e%2e/server/store.mjs',
  '/....//server/index.mjs',
]) {
  const res = await get(attempt)
  const body = res.ok ? await res.text() : ''
  report(body.includes('import') && body.includes('node:'), `serves files outside ui/ via ${attempt}`, `status ${res.status}`)
}

// 5. Does deleting a project accept a path outside the data folder? -----------
{
  const res = await get('/api/projects/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: '../../..' }),
  })
  const text = await res.text()
  report(res.ok && !text.includes('error'), 'project delete accepts a path outside data/', text.slice(0, 80))
}

// 6. Is the collector reachable from off-machine? ----------------------------
{
  const { default: net } = await import('node:net')
  const local = await new Promise((resolve) => {
    const probe = net.createConnection({ host: '127.0.0.1', port: 8478 }, () => { probe.end(); resolve(true) })
    probe.on('error', () => resolve(false))
  })
  report(!local, 'collector not listening on loopback', 'expected it to be')
}

// 7. The two endpoints the extension needs must still work cross-origin -------
{
  const res = await get('/api/config', { headers: { Origin: 'http://localhost:3000' } })
  const body = await res.json()
  report(
    res.headers.get('access-control-allow-origin') !== '*' || !Array.isArray(body.apiPorts),
    'extension can still read the port list',
    `ACAO ${res.headers.get('access-control-allow-origin')}`,
  )
}
{
  const res = await get('/api/action', {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'sec-test', label: 'Security probe', ts: Date.now() }),
  })
  report(
    res.status !== 200 || res.headers.get('access-control-allow-origin') !== '*',
    'extension can still label an action',
    `status ${res.status}`,
  )
}

// 8. The overlay itself must not be broken by the lockdown -------------------
{
  const res = await get('/api/clear', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:8478', 'Content-Type': 'application/json' },
    body: '{}',
  })
  report(!res.ok, 'the overlay can still clear its own recording', `status ${res.status}`)
}

console.log(issues === 0 ? '\nNo issues found.' : `\n${issues} issue(s) found.`)
process.exit(issues === 0 ? 0 : 1)
