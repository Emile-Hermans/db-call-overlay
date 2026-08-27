# DB Call Overlay

> ⚠️ **This project is fully vibecoded** — every line was written by an AI from conversational
> prompts. See [the disclaimer](#disclaimer--this-is-fully-vibecoded) before you rely on it.

**See which database calls every click in your app causes — and which of them are waste.**

A Windows desktop app that sits on top of your browser while you click through a .NET web
application, groups every SQL statement under the button that caused it, and tells you which
calls are redundant, why, and **which method to open** to fix them.

It is aimed at whoever is clicking through the app — a tester, a developer doing a smoke test —
not at whoever is reading a profiler.

```
223 calls   66 in-request   7 dup. writes   16 cross-request   150 could be   1.9 s db time

▸ 🟢 OK      Open shipments tab     ShipmentsController.List          1 call     11 ms
▾ 🔴 WASTE   Recalculate order      Every row written 2×  ·  N+1     152 → 52   372 ms
      ┌ -50  50 OrderLines rows are written more than once
      │      The writes come from OrderService.ResetTotals (50×)
      │      and OrderService.PersistTotals (50×).
      │      fix  Recalculate first, then persist once.
      ▾ UPDATE  OrderLines  ×100  50 rows  OrderLineRepository.SaveAll · OrderLineRepository.cs:402
      ▸ SELECT  Quotes      ×50   N+1      QuoteRepository.GetByOrderLine · QuoteRepository.cs:133
      ▸ SELECT  Orders      ×2    identical parameters
```

Three levels, each unfoldable: **action** → **query group** → **every execution**, with
timestamps, parameters, durations and the call stack that produced them.

---

## Disclaimer — this is fully vibecoded

Every line of this repository was written by an AI (Claude) from conversational prompts. I
described what I wanted, tested it, pushed back when it was wrong, and shipped it. I did not
hand-write the code, and I have not reviewed every line of it.

Being straight about what that does and does not mean:

**What it has going for it**

- It was built by *running* it, not by guessing. The recorder was verified against a real
  ASP.NET Core + EF Core process; the rule engine, the source-path shortening, the browser
  extension and the projects UI all have tests in `tools/` that you can run yourself.
- Several real bugs were found and fixed exactly this way — a race in the extension's config,
  a probe that never reconnected, a restart button that killed a debug session, write counts
  that were silently always zero. They are documented in the commit history and the code
  comments say *why*, not just *what*.
- It is **read-only towards your database**. The recorder observes diagnostic events; it never
  issues SQL, and the app never opens a database connection.
- There is **no AI at runtime** — no network, no API key, no account. See
  [How it works](#how-it-works).

**What it does not have**

- No line-by-line human audit, no external review, no test suite in CI.
- No production hardening. It is a local development tool: it binds to `127.0.0.1`, and it is
  meant to run on a developer's machine against a local app.
- Switching recording on sets `DOTNET_STARTUP_HOOKS` for your user account, which means every
  .NET process you start loads a small library. That is how the tool works, it is reversible
  from the tray or with `Uninstall.cmd`, and the app repairs the setting if this folder moves —
  but you should know it before you turn it on.

Read it before running it somewhere that matters. It is MIT licensed and comes with no warranty
of any kind — that is not boilerplate here, it is the point.

---

## Requirements

| | |
|---|---|
| Windows | 10 or 11 |
| [.NET SDK](https://dotnet.microsoft.com/download) | 8.0 or newer |
| [Node.js](https://nodejs.org) | 18 or newer |
| WebView2 | ships with Windows 11 and with Edge; the app offers the download if missing |
| Your app | .NET, using **Entity Framework Core** (or any ADO.NET provider, see *Raw SQL*) |

---

## Install

```
git clone https://github.com/Emile-Hermans/db-call-overlay.git
```

Then **double-click `Install.cmd`**.

It checks the prerequisites, builds everything, and puts *DB Call Overlay* on your Desktop and
in the Start menu. `Uninstall.cmd` reverses it.

---

## Use it

1. **Open DB Call Overlay.**
2. **Press "Switch recording on".** One click, once per machine. It changes nothing in your own
   code — it sets an environment variable so the recorder can attach to .NET apps as they start.
3. **Start your API and click around.** Calls appear as you go.

The app tells you which state you are in and what to do next:

| What it shows | What to do |
|---|---|
| *Recording is not switched on yet* | Press the green button. |
| *Close Visual Studio and open it again* | VS passes its own environment to what it debugs and captured it at launch, so it has to be restarted once. |
| *Recording is switched on* + a list of APIs | Those started before you switched it on — restart them. |
| *Ready — start your APIs* | Nothing. Start them and it begins by itself. |

> **Why must an app restart once?** The recorder attaches while a process is *starting* — the
> only moment .NET allows it, and what makes the call-stack detail possible. A process that is
> already running cannot be joined.

### Group calls by the button you clicked

Optional, but it turns *"some calls happened"* into *"the Recalculate button caused these"*.

`chrome://extensions` → **Developer mode** → **Load unpacked** → pick the `extension` folder.

It runs only on `localhost`, adds two headers to calls going to your API ports, and talks to
nothing but the app on `127.0.0.1`. Without it, calls are grouped into bursts instead, and you
can name a burst yourself with the **Mark** button.

---

## What the numbers mean

One number cannot describe three different problems, so the header keeps them apart:

| Tile | Definition | What fixing it costs |
|---|---|---|
| **calls** | Every SQL statement. A batched command counts once per statement inside it. | — |
| **in-request** | Same query + same parameters repeated **inside one request**, plus N+1 loops collapsed to one query. | A change in one method. **The real target.** |
| **dup. writes** | Rows written more than once in one action, including when the two writes are different statements. | A change in one flow. |
| **cross-request** | The same query in **different requests** of one action. Each request has its own `DbContext`, so loading a row once per request is normal, not waste. | Merging endpoints or a shared cache — a design decision. |
| **could be** | `calls − in-request − dup. writes`. **Cross-request repeats are excluded.** | — |
| **db time** | Sum of each command's duration. | — |

Every number is derivable from the rows below it:

```
avoidable  = in-request + dup. writes           (and equals the sum over all groups)
could be   = calls − avoidable
reducible  = avoidable / calls, as a percentage
floor      = could be − cross-request           ("if endpoints were merged too")
roundTripSavings = extra round-trips a write loop could batch away. It counts
                   round-trips, not statements, so it is never part of avoidable —
                   a batched loop still performs the same number of writes.
```

### Colour

| | | |
|---|---|---|
| 🟢 | `OK` | Nothing to remove |
| 🟡 | `REVIEW` | Slow, unfiltered, over-fetching, or repeated across requests |
| 🔴 | `WASTE` | Genuinely redundant: repeats, N+1, rows saved twice |

Colour is never the only signal — every row also carries the text tag.

---

## What it detects

| Code | Level | Fires when |
|---|---|---|
| `duplicate-row-write` | high | The same row is written more than once in one action, even when the two passes write different columns. Names both methods. |
| `duplicate-write` | high | One statement shape writes fewer distinct rows than it has executions |
| `n-plus-one` | high | The same query shape runs once per item within a request |
| `identical-repeat` | high | The same query with the same parameters runs twice in one request |
| `slow` | high / med | A single execution over 600 ms / 200 ms |
| `write-loop` | med | ≥ 5 separate round-trips writing one table — batching would collapse them |
| `read-after-write` | med | A table is read again after being saved in the same action |
| `cross-request` | med | The same rows loaded by two requests of one action |
| `multi-savechanges` | med | `SaveChanges` ran more than once in one action |
| `unfiltered-read` | med | `SELECT` with no `WHERE` and no paging |
| `wide-select` | low | ≥ 30 columns projected — the whole entity materialised |

**Finding the code:** every query group shows the method and `file:line`, linked as a
`vscode://` URL. The method shown is the first one *above* your data-access layer — the code
you would actually change — and the helper that issued the command is on the tooltip. Where one
statement is reached by several paths, each is listed and named by the first method where they
*diverge*.

The data-access layer is worked out from the recording itself, not from a list of names: a
method used for many different queries that is almost always one of the innermost frames is
infrastructure. Nothing to configure, whatever your codebase looks like.

### Handing one finding to someone else

Nothing here needs a row opened first.

On a **flow** row:

| | |
|---|---|
| ✏️ / 📝 | Write what the flow covers |
| ⬇ | **Export this flow** — every call in it — as JSON |
| 🗑️ | Delete the flow |

On a **query-group** row:

| | |
|---|---|
| 📋 | **Copy this call** as Markdown — the finding, the fix, the call paths with `file:line`, the SQL and the executions table. Paste straight into a ticket or a pull request. |
| ⬇ | Download **that one call** as JSON |

**Export** in the toolbar still gives you the whole session — three scopes in all: one call, one
flow, everything.

---

## Projects — keeping what you find

A **project** is a named folder of recorded flows, so what you learn while testing does not
disappear when you close the app.

Click the 📁 chip to create or open one. While a project is open **every flow is saved
automatically**. On each row: ✏️ to write what the flow covers, 🗑️ to delete a bad recording.
With no project open the chip reads **Scratch** — everything works, nothing is written.

```
data/
  settings.json
  CheckoutFlow/
    project.json
    flows/ui-1748…-recalculate.json
```

Flows store the **raw SQL and parameters**, not the analysis, and are re-analysed every time a
project is opened — so old recordings benefit from rules added later.

> Saved flows contain the **parameter values** of every query, which is real data from whatever
> database you tested against. Think before sharing a `data/` folder; `data/` is in
> `.gitignore` for that reason. To record without values, start the app with
> `DBPROBE_PARAMS=off`.

---

## Settings

⚙ holds the **API ports to record** — change these if your app runs on different ports. The
extension picks the new list up within a minute.

The app's own ports (8478 window, 8477 recorder) live in
`%LOCALAPPDATA%\DbCallOverlay\settings.json`. Changing the window port also means changing
`COLLECTOR_ORIGIN` at the top of `extension/bridge.js`.

### Updating

Settings also shows which version you are on and a **Check for updates** button. If there is a
newer version it lists what changed; **Update now** pulls it, rebuilds, and restarts the app.

It is deliberately cautious:

- **Fast-forward only.** No merges, no rebases, no conflicts to resolve.
- **It refuses if you have local changes**, and says so instead of overwriting them. Commit or
  discard first.
- **Your recordings are untouched** — `data/` is not tracked by git.
- The rebuild happens after the app exits, because a running app cannot replace its own
  executable. If the rebuild fails you get a message telling you to run `Install.cmd`.
- If the folder was not cloned with git, or git is not installed, it says so rather than
  pretending it can update.

---

## How it works

| Path | What it is |
|---|---|
| `desktop/` | The app: .NET WinForms shell hosting the UI in WebView2. Owns the window, tray and settings, and supervises the collector through a job object so it can never leave an orphaned `node.exe`. |
| `probe/` | The recorder: a .NET startup-hook assembly. Subscribes to the EF Core and ASP.NET `DiagnosticListener`s, capturing SQL, duration, rows and the application call stack, streamed as NDJSON over TCP. Dependency-free, never throws into the host. |
| `server/` | Zero-dependency Node collector. `sql.mjs` shreds commands into statements, `analyze.mjs` is the rule engine, `store.mjs` groups per action, `index.mjs` serves the UI. |
| `ui/` | The overlay page. |
| `extension/` | Chrome MV3 extension. `inject.js` runs in the page world; `bridge.js` runs in the extension world and is the only side allowed to reach `127.0.0.1`. |
| `data/` | Your projects and flows. |

**There is no AI in the running tool, and no network access.** The findings come from counting
and regexes; each "fix" line is a fixed sentence belonging to its rule, with the method and
table names filled in. Nothing about your database, SQL or data ever leaves the machine — it
goes recorder → `127.0.0.1:8477` → the app window → `data/`. No account, no API key, no
subscription. The flip side: it only finds the patterns in the table above.

### Recorder settings

Read from the environment of the recorded process. All optional.

| Variable | Default | Purpose |
|---|---|---|
| `DBPROBE_APPS` | *(all)* | Only attach to processes whose name contains this. Build servers and CLI tools are always skipped. |
| `DBPROBE_NS` | *(auto)* | Namespaces counted as application code. By default anything that is not framework code. |
| `DBPROBE_STACK` | `full` | `full` (with file:line), `nofile` (faster), `off` |
| `DBPROBE_PARAMS` | `on` | `off` to stop capturing parameter values |
| `DBPROBE_RAWSQL` | `off` | `on` to also capture raw ADO.NET commands that bypass EF Core |
| `DBPROBE_OFF` | — | `1` disables the recorder without unsetting anything |

Stack capture with file info is the expensive part; use `DBPROBE_STACK=nofile` if a flow feels
slower while you measure.

---

## Nothing is showing up

**A setup panel instead of data**
: Follow what it says — it knows whether recording is on and which apps still need restarting.
  Restarting only the frontend does not help; the API process has to restart.

**"Connected — waiting for a click" but nothing appears**
: That click did not touch the database, or it went to an app that is not recorded. Check the
  list of recorded apps in the header.

**Calls appear but grouped as "Unlabelled burst"**
: The extension is not loaded, or the page was open before you loaded it. Load it and refresh.

**Chrome asks permission when the tab opens**
: An old version of the extension. Press **Reload** on it in `chrome://extensions`.

**Check by hand:** `http://127.0.0.1:8478/api/health` lists every recorder currently connected.

---

## Security

This is a local development tool, and it holds sensitive material: recorded SQL includes the
**parameter values** of every query, which is real data from whatever database you pointed it at.

**What it does**

- Both servers bind to `127.0.0.1` only — the UI on 8478, the recorder feed on 8477. Nothing is
  reachable from the network.
- **Recordings cannot be read cross-origin.** `/api/state`, `/api/stream`, `/api/action/*` and
  `/api/export` send no `Access-Control-Allow-Origin`, so a web page you happen to have open
  cannot fetch your recording.
- **Anything that changes state requires same-origin.** Clearing a session, deleting a project
  or a flow, and writing settings are rejected with 403 when the request comes from another
  origin, which closes the obvious CSRF.
- Exactly two endpoints are open cross-origin, because the browser extension needs them:
  `GET /api/config` (the port list) and `POST /api/action` (the label of a clicked control).
  Neither can read a recording.
- The static file server refuses to serve anything outside `ui/`, and deleting a project refuses
  any path outside `data/`. Both are covered by `tools/security-test.mjs`.
- The recorder is **read-only towards your database**: it observes diagnostic events and never
  issues SQL. The app never opens a database connection.
- No network access, no telemetry, no account, no API key.

**What you are trusting**

- While recording is switched on, `DOTNET_STARTUP_HOOKS` points every .NET process you start at
  `DbProbe.dll`. Anyone who can write to that file gets code execution in those processes — but
  anyone who can write there has already won. `Uninstall.cmd` removes the setting.
- The recorder feed on 8477 accepts anything a local process sends it, so another program on
  your machine could inject fake entries. It cannot read anything back.
- **`data/` holds real query parameters.** It is in `.gitignore`; think before sharing it.
  `DBPROBE_PARAMS=off` records without values.
- The update button runs `git merge --ff-only` against whatever `origin` your clone points at.

Run `node tools/security-test.mjs` against a running collector to check all of this yourself.

---

## Known limits

- **Row counts for reads** are `DbDataReader.Read()` calls — one more than the row count when a
  result set is fully enumerated.
- **Rows written are inferred for tracked EF saves.** `SaveChanges` does not use
  `ExecuteNonQuery`, so there is no count to read: EF returns a `DbDataReader` and sets
  `NOCOUNT ON`, making `RecordsAffected` −1. EF does append `OUTPUT 1` / `RETURNING 1` for its
  concurrency check, so the rows the reader returns are the rows written — shown with `≈`.
  `ExecuteUpdate` and `ExecuteDelete` are exact.
- **Call stacks stop at an await boundary.** You always get the synchronous chain that issued
  the query; ancestors above a resumed continuation can be missing. The HTTP handler is always
  known.
- **EF Core is captured by default.** Set `DBPROBE_RAWSQL=on` for raw `SqlCommand` use.
- **Burst grouping is a heuristic** without the extension: calls within 1.5 s are one action.
- **SignalR traffic is not tagged** — WebSocket frames cannot carry the action header.
- **An app already running cannot be joined.** Attaching live is possible through EventPipe, but
  it cannot see parameter values or call stacks — the two things the main findings rest on — so
  that route was deliberately not taken.
- **The first click after the window regains focus** can be swallowed, as with any hosted web
  view. Click again.

---

## Development

```powershell
node tools\selftest.mjs      # replay a synthetic action into a running collector
node tools\analyze-test.mjs  # the rule engine and the summary arithmetic
node tools\path-test.mjs     # source-path shortening
```

`tools/extension-test.mjs` (header tagging) and `tools/ui-test.mjs` (projects and notes) need
Playwright: `npx --package playwright node tools\ui-test.mjs`.

`tools/probetest` is a small ASP.NET Core + EF Core app that reproduces a double save and an
N+1, used to verify the recorder end to end.

To work on the UI without rebuilding, run `node server\index.mjs` and open
`http://127.0.0.1:8478`. The app serves its own copy of `ui/`, refreshed on each build.

---

## Licence

MIT — see [LICENSE](LICENSE).
