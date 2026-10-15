# Clicktrace

[![Download for Windows](https://img.shields.io/github/v/release/Emile-Hermans/db-call-overlay?label=Download%20for%20Windows&style=for-the-badge&color=5b46f0)](https://github.com/Emile-Hermans/db-call-overlay/releases/latest)

**[⬇ Download the latest ClicktraceSetup.exe](https://github.com/Emile-Hermans/db-call-overlay/releases/latest)**
— one file, no git, .NET or Node.js needed. Windows SmartScreen warns because it is not
code-signed: click *More info → Run anyway*. [More about the setup](#without-git--the-setup-exe).

> ⚠️ **This project is fully vibecoded** — every line was written by an AI from conversational
> prompts. See [the disclaimer](#disclaimer--this-is-fully-vibecoded) before you rely on it.

**Know exactly what a click does — every request, every query — and why it is slow.**

*Formerly DB Call Overlay.* A Windows desktop app that sits on top of your browser while you
click through a .NET web application. It files every request and SQL statement under the button
that caused it, says whether the click was slow because of the **database** or because of the
**application**, and lists the changes that buy back the most time — with **the method and line
to open**.

It is aimed at whoever is clicking through the app — a tester, a developer doing a smoke test —
not at whoever is reading a profiler.

```
Clicks 5   Queries 171 → 58   Removable 113   DB time 799 ms   At 10× data 306–1386

▸ OK      Open shipments tab    ShipmentsController.List          40 ms  28% db    1 query
▾ WASTE   Recalculate order     Every row written 2× · N+1       480 ms  51% db  152 → 52
    DB  Database-bound — 51% of the server time is SQL
        243 ms of 480 ms was spent waiting on 54 database round-trips.

    WHERE THE TIME WENT   ████████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   database 243 ms · application 237 ms

    FIX FIRST
      1  Every row of OrderLines is written 2×   OrderLineRepository.SaveAll :402   ~130 ms  −50
      2  N+1: 50 single-key lookups of Quotes    QuoteRepository.GetByOrderLine     ~98 ms  −49
         in loop OrderService.cs:118
      3  Same query run 2× in one request        OrderRepository.GetById            ~6 ms   −1

    WATERFALL   200 OrdersController.Recalculate  |▮▮▮▮▮▮▮▮▮▮████████▬▬▬▬▬▬▬▬▬▬▬|
    QUERIES     ▸ UPDATE OrderLines ×100 · ▸ SELECT Quotes ×50 · ▸ SELECT Orders ×2
```

Three levels, each unfoldable: **click** → **query group** → **every execution**, with
timestamps, parameters, durations and the call stack that produced them. Dark and light
themes; it follows Windows unless you pick one.

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
| Browser extension | Optional. Chrome or Edge, and only to label flows by the button you clicked |

---

## Install

### Without git — the setup exe

Download **`ClicktraceSetup-<version>.exe`** and run it. That is all: it installs for your
Windows account only (no administrator rights), with its own .NET runtime and Node.js, so
nothing else has to be installed first. It adds Clicktrace to the Start menu and, if you
want, the Desktop.

- **It is not code-signed**, so Windows SmartScreen says *"Windows protected your PC"*. Click
  **More info → Run anyway**.
- Installs to `%LOCALAPPDATA%\Programs\Clicktrace`. Recordings and settings live in
  `%LOCALAPPDATA%\DbCallOverlay` and survive updates and uninstalling.
- **Update:** ⚙ Settings → **Check for updates** looks for a newer release on GitHub;
  **Update now** downloads it, checks it against the SHA-256 published with the release,
  and installs it over this copy — the app closes and reopens by itself. A download that
  fails the check is deleted, never run. Or simply run a newer setup over it. **Remove:** Settings → Apps → Installed apps →
  Clicktrace. Removing it also switches recording off if it pointed at this copy — a
  recorder that no longer exists would otherwise stop every `dotnet` command.
- The browser extension is in the `extension` folder next to the app.
- Unattended: `ClicktraceSetup.exe /silent [/dir=<folder>] [/noshortcuts] [/run]`. A log is
  written to `%TEMP%\ClicktraceSetup.log`.

### From the repository


```
git clone https://github.com/Emile-Hermans/db-call-overlay.git
```

Then **double-click `Install.cmd`**.

It checks the prerequisites, builds everything, and puts *Clicktrace* on your Desktop and
in the Start menu. `Uninstall.cmd` reverses it.

---

## Use it

1. **Open Clicktrace.**
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

### Optional: name the flows after the button you clicked

**It works without this.** The browser extension only improves the *labels*.

The recorder sees SQL and it sees HTTP requests. It cannot see which button you pressed —
that only exists in the browser. So:

| | Flows are labelled |
|---|---|
| **Without the extension** | by endpoint, or as a burst: `Orders / Recalculate`, `Unlabelled burst` |
| **With the extension** | by what you actually clicked: `Recalculate order` |

Everything else — the calls, the findings, the call sites, projects, exports — is identical
either way.

**Install it in the browser you click your app in:**

| Browser | Where |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

→ turn on **Developer mode** → **Load unpacked** → pick the `extension` folder → refresh your
app's tab.

Both are tested; the extension uses nothing browser-specific.

#### How a label is chosen

First match wins, on the element you clicked:

| | Source | Example |
|---|---|---|
| 1 | Visible text, up to 45 characters | `Recalculate order` |
| 2 | `aria-label` or `title` | `Delete this row` |
| 3 | `data-cy`, tidied up | `btn-save-lines` → `Save lines` |
| 4 | Longer text, truncated | `Some very long caption…` |
| 5 | An `mdi-*` icon class | `mdi-content-save` → `Content save` |

Icon-only buttons are the weak spot — with no text they fall to a `data-cy` or an icon name.
To get better labels, give those buttons an `aria-label` (which helps screen readers too) or a
`data-cy` that reads like a phrase rather than an id.

#### When there is nothing to click

A flow started by a keyboard shortcut, a timer or a SignalR push produces no click, so no label.
Use **Mark** in the toolbar: type a name, press it, do the thing, press **Stop**. Everything in
between is filed under that name — which also works with no extension installed at all.

#### What it does, and does not do

- Adds three headers (`X-DbProbe-Action`, `-Label`, `-Kind`) to calls going to **your configured
  API ports only** — see ⚙ Settings.
- Sends the app one object per click: the label, the `data-cy`, and the page path.
- Runs **only on `localhost` / `127.0.0.1`**; it cannot load on a real website.
- Reads no response body, no cookies, no storage, no form values. The one response it reads is
  the port list, from your own app.
- Contacts nothing but `127.0.0.1`.

---

## Why is this click slow?

Open a click and read it top to bottom. Each part answers the question the one above it raises.

**1. The verdict.** One sentence on where the time went, chosen from what was measured:

| Verdict | Means | So |
|---|---|---|
| **Database-bound** | Half or more of the server time was SQL. | Fixing queries makes this click faster. Start with *Fix first*. |
| **Application-bound** | Most of the server time was outside the database: code, serialisation, other services, waiting on a lock. | Removing queries will not fix it. Profile the endpoint. |
| **Mostly between requests** | The server was idle most of the time — the browser was rendering, or requests waited on each other. | Look at the front end, or at requests that could run together. |
| **Fast** | Under 150 ms from first request to last response. | Nothing to do. |

**2. Where the time went.** The wait — from the first request to the last response — split into
database, application code and the gaps between requests. *Database* is the union of the query
intervals inside the request windows, so queries running in parallel are not counted twice.
Work done after the response is shown next to it, not in it: nobody waited for it.

**3. Fix first.** The query groups worth changing, ranked by the time a fix would buy back:
removable executions × their average duration. That is an **estimate** and labelled as one;
everything else on the screen is measured. Each entry names the method and line, and clicking it
opens that query group.

**4. Waterfall.** Every request of the click on one time axis, with each query as a tick inside
it — the picture [Sentry's trace view](https://docs.sentry.io/concepts/key-terms/tracing/) and
the browser's network panel use. A wall of ticks is a loop. A long bar with no ticks is the
application working on its own. Click a tick to open its query group.

**5. Queries.** Every query group, worst first, each unfoldable to its findings, call paths,
SQL and every execution — see [What it detects](#what-it-detects).

Each row in the list already carries the answer to the first question: the click's wall time and
a bar splitting it into database (violet) and application (teal), before you open anything.

## Loops from static analysis

A recording proves that a query ran fifty times; it cannot see the loop that made it do so. A
static analyser sees every loop whose body reaches the database, but not which of them run, or
how often. Together they pin a repeated query to **the loop that runs it**.

Point ⚙ Settings → *Loop report* at a report file. Queries whose call site it flags get an
**in loop** badge naming the file, line and loop header, the same in the *Fix first* list, and a
finding that says so. Counts never change: the recording decides what is removable, the report
only says where to make the change.

Two report shapes are read, so it is not tied to one analyser:

```jsonc
// 1. A findings list (or a bare array of these objects)
{ "findings": [ {
    "file": "src/Shop.Orders/Services/OrderService.cs", "line": 118,
    "method": "OrderService.ClearQuotes(Guid)",
    "loops": [ { "kind": "foreach", "header": "foreach (var line in order.Lines)", "line": 115 } ],
    "call": "_quotes.GetByOrderLine(line.Id)", "chain": "QuoteRepository.GetByOrderLine(Guid)",
    "accessKind": "Read", "suppressed": false } ] }
```

2. **SARIF 2.1** — what Roslyn analysers write with `/errorlog`. Each result's first location is
   taken as the call site and its message as the explanation.

Matching is on the file's tail and the line, so a report written with repository-relative paths
matches a recording made with absolute ones. When the report was made from a slightly different
version of the code, a flagged call **at most 5 lines** from the recorded one in the same method
is shown as a dashed **loop?** lead rather than a fact — and only on a query that actually
repeated. Further away is a different call: on real recordings, a "same method" match without
that limit was wrong far more often than right, because big methods hold several loops.

The report is read where it is and re-read when the file changes, so re-running the analyser is
enough. It is never copied into `data/`, and its path is not shared with web pages (the
browser extension's port list is the only setting a page can read).

## What the numbers mean

One number cannot describe three different problems, so the header keeps them apart. The
tiles are *Clicks*, *Queries → after fixes*, *Removable* (split into repeats, duplicate writes
and — when there are any — cross-request repeats), *DB time* (with *not waited*) and *At 10× data*:

| Term | Definition | What fixing it costs |
|---|---|---|
| **queries** (calls) | Every SQL statement. A batched command counts once per statement inside it. | — |
| **repeats** (in-request) | Same query + same parameters repeated **inside one request**, plus N+1 loops collapsed to one query. | A change in one method. **The real target.** |
| **dup. writes** | The same row written more than once **with the same columns** — the second write overwrites the first. Writes that set different columns are an un-batched save instead, counted in round-trips. | A change in one flow. |
| **cross-request** | The same query in **different requests** of one action. Each request has its own `DbContext`, so loading a row once per request is normal, not waste. | Merging endpoints or a shared cache — a design decision. |
| **after fixes** (could be) | `calls − in-request − dup. writes`. **Cross-request repeats are excluded.** | — |
| **at 10× data** | What the same clicks would cost against ten times the data — see [Growth](#growth-will-this-survive-more-data). Shown as a range when a loop sits inside another loop. | Restructuring a query, not deleting one. |
| **db time** | Sum of each command's duration. Not wall-clock time for the flow. | — |
| **not waited** | The part of *db time* from calls that ran **after the response was already sent**, or that belong to no request at all (background work). Real database load, but it never slowed the screen. | Nothing, for speed. A **write** here is a correctness risk — see below. |

Every number is derivable from the rows below it:

```
avoidable  = in-request + dup. writes           (and equals the sum over all groups)
could be   = calls − avoidable
reducible  = avoidable / calls, as a percentage
floor      = could be − cross-request           ("if endpoints were merged too")
roundTripSavings = extra round-trips a write loop could batch away. It counts
                   round-trips, not statements, so it is never part of avoidable —
                   a batched loop still performs the same number of writes.
at 10× data      = a projection, not a measurement. Growth findings never change
                   `avoidable`: a query that scales badly is a design risk, not a
                   call you can delete today.
```

> **Everything listed is a real round-trip.** EF Core has no query result cache — a
> tracked query executes its SQL every time, even when every row it returns is already
> tracked. The change tracker gives you the *same object*, not a free query. The one
> exception is `Find`/`FindAsync`, which checks the tracker by key first: when it hits,
> no command is issued, so nothing appears here. Nothing in this list is work that did
> not happen.

### Colour

| | | |
|---|---|---|
| 🟢 | `OK` | Nothing to remove |
| 🟡 | `REVIEW` | Slow, unfiltered, over-fetching, or repeated across requests |
| 🔴 | `WASTE` | Genuinely redundant: repeats, N+1, rows saved twice |

Colour is never the only signal — every row also carries the text tag.

---

## Growth — will this survive more data?

A count on its own cannot tell you whether a query is safe. Twelve executions are fine if
there will always be twelve, and a problem if twelve is *three parents × four children* —
because then the number is a function of the data, and your recording only shows the data
you happened to test with.

So every query group is classified by **what drives its execution count**:

| Badge | Meaning | Reading |
|---|---|---|
| *(none)* | Runs a set number of times whatever the data holds. | Safe. |
| `per Orders` | Runs once per row of an earlier query. | **Linear.** Fine while that row count stays small; fatal when it does not. |
| `per Orders × Shipments` | A loop inside a loop — a call per child, per parent. | **Multiplicative.** This is the one that runs away. |
| `grows?` | It loops, but what drives it could not be established. | Unknown. Left out of the projection rather than guessed at. |

The flow header then shows where its call count comes from:

```
cost: 1 fixed + 12 per Orders × Shipments + 3 per Orders
      — about 151 at 10× the data, up to 1231 if every level grows
```

Two numbers, because one recording genuinely cannot tell them apart, and the difference is
the whole question. **151** is ten times the parent collection with today's number of
children each. **1231** is every level growing tenfold. Which one you get depends on your
data, not on your code — the tool will not pretend to know.

### How it decides

Arithmetic, not a guess. A query that produced *n* rows, followed **in the same request**
by a query that ran *n* times, is a loop over those rows; chain those and you have the
nesting. Row counts come from the recorder's own `Read()` count, and both readings of the
off-by-one are accepted, so a driver only has to match somewhere inside the range.

**When no earlier query produced the right number of rows, nothing is claimed.** The group
is marked `grows?` and held out of the projection, which is why an old recording — or a
result the caller abandoned early, leaving no row count — reports honestly instead of
inventing a growth curve. Unclassified calls are counted at today's size, so the
projection is a floor.

`⚙ project at (× data)` changes the factor. Saved flows keep their raw commands, so
changing it re-judges everything you already recorded.

---

## What kind of call is it?

Not every round-trip is your query, and the difference decides which advice applies. The
recorder reads this from the data-access layer's own report of each command rather than
guessing from the SQL:

| Badge | What it is | Why it matters |
|---|---|---|
| *(none)* | An ordinary query. | The common case gets no badge — a word on every row says nothing. |
| `save` | A change-tracker flush. | No direct row count exists for one, so the number comes from what the statement returned and is shown with `≈`. Each flush is its own transaction. |
| `bulk` | A set-based write (`ExecuteUpdate` / `ExecuteDelete`) that never touches the change tracker. | Its row count is exact — and it is **never** told to "become set-based", because it already is. |
| `raw sql` | Hand-written SQL. | The generated-query advice does not apply. |

### Did the user wait for it?

Every call is also placed against the response the user was waiting on, using the request's
own recorded end time:

| Badge | What it proves | Why it matters |
|---|---|---|
| *(none)* | Ran inside its request's window. | The user (probably) waited for it — this is the time that made the screen slow. |
| `after response` | Started after the response was sent, or was still running when it went out. | Never slowed the screen, but it is still database load — and a **write** here cannot report failure to a user who was already told "success". That earns the `fire-and-forget-write` finding. |
| `background` | Belongs to no HTTP request at all. | A timer, a queue, a startup task. Judged on cost only, never called fire-and-forget. |
| `sync` | Issued through the blocking (non-async) API, per the data-access layer's own event. | Adds no database time, but the thread waits idle instead of serving other requests. |

The header's **not waited** tile sums the `after response` and `background` time, so *db
time* can be read as "what the user felt" versus "what the database did". The one honest
limit: a fire-and-forget call that happens to **finish before** the response is
indistinguishable from an awaited one — no runtime event says whether a task was awaited —
so it counts as waited. The labels only claim what the timestamps prove.

Because flows store raw commands, every recording you already have gets this
classification the next time its project is opened.

Two consequences worth knowing:

- **Schema work and key-generation fetches are excluded from every count** — real database
  traffic, but not something a flow can be blamed for, and they otherwise wreck the numbers
  for the first flow recorded after a process starts. They are reported on the flow that
  produced them and in the legend, never silently dropped.
- **Fix text follows the actual mechanism.** "Update the entity you already have" is only
  offered when there *was* a tracked entity; after a set-based write there is none, and
  re-reading may be the only option.

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
| `unbatched-save` | med | One row written by several separate flushes, each setting different columns — nothing is overwritten, the cost is round-trips |
| `scales-multiplicative` | high | A loop inside a loop — the count is a product of two or more dimensions |
| `scales-with-data` | high / med | One call per row of an earlier query. High once the loop is already wide |
| `fire-and-forget-write` | med | A write ran after its request's response was already sent. It never slowed the screen — but if it fails, the user was already told the request succeeded. |
| `sync-db-call` | low | Every execution of a request-bound call used the blocking (non-async) API |
| `unfiltered-read` | med | `SELECT` with no `WHERE` and no paging |
| `wide-select` | low | ≥ 30 columns projected — the whole entity materialised |
| `infrastructure-excluded` | low | Schema or key-generation round-trips were left out of the counts |

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
| 📊 | **Export this flow** as a spreadsheet — one row per query |
| ⬇ | **Export this flow** — every call in it — as JSON |
| 🗑️ | Delete the flow |

On a **query-group** row:

| | |
|---|---|
| 📋 | **Copy this call** as Markdown — the finding, the fix, the call paths with `file:line`, the SQL and the executions table. Paste straight into a ticket or a pull request. |
| 📊 | Export **that one call** as a spreadsheet — one row per execution |
| ⬇ | Download **that one call** as JSON |

**Export** in the toolbar gives you the whole session as a spreadsheet, with **JSON** beside it
for anything that has to be read by a machine. Three scopes in all — one call, one flow,
everything — each available in both formats.

The JSON session export drops the absolute source path from every stack frame: it names a
checkout folder and usually a user account, and nothing downstream of the running app needs it.

### Spreadsheet export

📊 gives you a `.csv` that opens straight into Excel — **one row per query**, which is the shape
worth having in a spreadsheet:

| | |
|---|---|
| Sort by **Removable** | the waste, biggest first |
| Filter **Growth levels ≥ 2** | every query whose cost is a product of two dimensions rather than a constant |
| Filter **Verdict = WASTE** | just the red rows |
| Pivot on **Table** | which table the flow leans on |

Flow-level figures repeat on every row of that flow, which is what makes a pivot table work.
On a query group, 📊 exports **one row per execution** instead — the drill-down, with each
execution's timing, row counts and parameters.

Four things are done for Excel specifically, and each of them is the difference between a
spreadsheet and one unusable column:

- **The file declares its own delimiter.** Excel otherwise uses the list separator of the
  machine's locale — a semicolon across most of continental Europe, a comma in en-US — and no
  single file can satisfy both. A leading `sep=;` line overrides the locale, so the file opens
  identically everywhere. (Other tools show that line as a stray first row; this export is for
  Excel.)
- **A UTF-8 BOM**, without which Excel reads the bytes as the local ANSI codepage and mangles
  every `×`, `≈` and accented character in the report.
- **Every number is a whole number**, with its unit in the header (`DB time (ms)`). A decimal
  point is a thousands separator in a comma-decimal locale, so `1.5` can silently become `15`.
- **Values that Excel would execute are neutralised.** A cell starting with `=`, `+` or `@` is
  run as a formula on open, and these values come out of somebody's database. A leading
  apostrophe is added — except to negative numbers, which stay numbers.

### Finding one flow among hundreds

The filter bar takes free text matched against the flow label, its description, its
endpoints, **and the tables and methods inside it** — so you can find a flow by something
that is only visible once it is opened. Words match in any order. The chips beside it switch
whole colours off, and `grows` narrows to flows whose call count was proven to follow the
data.

`?` beside the header tiles explains every number, how growth is decided, and the keyboard
shortcuts.

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

It also holds **when to flag something**. These are judgements about a codebase rather than
facts about it, so they belong to whoever is reading the report:

| Setting | Default | Rule it controls |
|---|---|---|
| slow / very slow | 200 / 600 ms | `slow` |
| wide select | 30 columns | `wide-select` |
| write loop | 5 round-trips | `write-loop` |
| N+1 from | 3 lookups | `n-plus-one` |
| N+1 max parameters | 4 | `n-plus-one` — above this a query is not a single-key lookup |
| project at | 10× data | the growth projection |
| loop report | *(none)* | the **in loop** badges — see [Loops from static analysis](#loops-from-static-analysis) |

Saved flows keep their raw commands and are re-judged on the spot, so changing any of these
re-scores everything you already recorded. Nothing has to be recorded again.

**Parameter values** are the one recording control that is *not* a setting: the recorder
reads `DBPROBE_PARAMS` as a process starts, so it can only be changed for apps that have
not been started yet. ⚙ reports which way it is set rather than offering a switch that
would not take effect. With it off, row identity is unavailable, so duplicate writes and
repeated reads cannot be counted at all.

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
| `desktop/` | The app: .NET WinForms shell hosting the UI in WebView2. Owns the window, tray and settings, and supervises the collector through a job object so it can never leave an orphaned `node.exe`. Closing the window ends everything it started — including a collector it merely attached to. Use **Show / hide** in the tray menu to stash it without quitting. |
| `probe/` | The recorder: a .NET startup-hook assembly. Subscribes to the EF Core and ASP.NET `DiagnosticListener`s, capturing SQL, duration, rows and the application call stack, streamed as NDJSON over TCP. Dependency-free, never throws into the host. |
| `server/` | Zero-dependency Node collector. `sql.mjs` shreds commands into statements, `analyze.mjs` is the rule engine, `timeline.mjs` works out where a click's time went and what to fix first, `loops.mjs` reads a static loop report, `store.mjs` groups per action, `index.mjs` serves the UI. |
| `ui/` | The app's page: one HTML file, one stylesheet built on colour tokens (dark and light), one script. No framework, no build step. |
| `extension/` | MV3 extension for Chrome or Edge, entirely optional. `inject.js` runs in the page world; `bridge.js` runs in the extension world and is the only side allowed to reach `127.0.0.1`. |
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
| `DBPROBE_PARAM_MAX` | `2000` | Parameters captured per command. It must cover a whole batch: a statement whose row cannot be identified is excluded from write analysis. |
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
: That is only the label - the calls are still recorded correctly. Load the extension and refresh the tab, or name the flow yourself with **Mark**.

**Chrome asks permission when the tab opens**
: An old version of the extension. Press **Reload** on it in `chrome://extensions` or `edge://extensions`.

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
- **Some call sites are withheld.** The stack is captured live, so a command issued after an
  await can sit on a stack that still holds the resumed frames of the *previous* query — a
  mirror image with the data access at the tail instead of the head. Those are detected and the
  call site is left empty rather than naming a method that did not run the query.
- **Row identity depends on captured parameters.** Statements whose parameters were not captured
  are excluded from the duplicate-write *and* duplicate-read counts rather than treated as
  repeats of each other. Raise `DBPROBE_PARAM_MAX` if a very large batch is being truncated.
- **A query whose keys are inlined is identified by its text.** Constants folded into the SQL
  normalise to the same shape as their siblings and leave no parameters behind, so the
  statement text is what distinguishes one execution from the next. Without that, N reads of
  N different rows would be reported as one row read N times.
- **"Waited for" is proven by timestamps, not by the code.** A call that ran past its
  request's response, or outside any request, is provably not waited for. The reverse does
  not hold: a fire-and-forget call that finishes *before* the response is indistinguishable
  from an awaited one — .NET produces no event saying whether a task was awaited — so it
  counts as waited. A request whose end was never recorded claims nothing either way.
- **Tracked and untracked reads cannot be told apart, and are not guessed at.** `AsNoTracking`
  changes no SQL and appears in no diagnostic event, so no read carries a tracking badge. It
  makes no difference to any count either — tracking affects object identity, not whether a
  query runs. Where it *is* observable is on writes, and that is what the `save` / `bulk`
  badges say.
- **Growth is a projection, not a measurement.** It is derived from one recording of one
  dataset. A group whose driver cannot be established is marked `grows?` and left out of the
  projection, so the number is a floor rather than an estimate. To *measure* growth instead,
  record the same flow twice against datasets of different sizes and compare the two flows.
- **A group's time is its share of each command**, since one batched command can feed several
  groups. Group times therefore add up to the flow time rather than exceeding it.
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

> **Run a development collector on its own ports.** A probe connects to the ingest port the
> moment its application starts, so a collector on the default port will quietly pick up
> whatever real application happens to be running — and a test that then writes a report to
> disk has just written that application's recording to disk. Every test takes a port for
> this reason.
>
> ```powershell
> $env:DBPROBE_PORT=18477; $env:DBPROBE_UI_PORT=18478; $env:DBPROBE_DATA="$PWD\.testdata"
> node server\index.mjs
> ```
>
> Nothing dials 18477, so such a collector only ever sees what a test sends it.

```powershell
node tools\selftest.mjs 18477   # replay a synthetic action into a running collector
node tools\analyze-test.mjs     # the rule engine and the summary arithmetic
node tools\timeline-test.mjs    # the time split, verdicts, fix-first ranking, loop report matching
node tools\scaling-test.mjs     # growth: driver detection, nesting, and what it refuses to claim
node tools\csv-test.mjs         # the spreadsheet export: delimiter, BOM, quoting, formula guard
node tools\path-test.mjs        # source-path shortening
```

`tools/extension-test.mjs` (header tagging), `tools/ui-test.mjs` (projects and notes) and
`tools/ui-growth-test.mjs` (growth badges, spreadsheet export, filter bar, help panel,
thresholds) need Playwright, and each takes the UI port as its last argument:

```powershell
npx --package playwright node tools\ui-test.mjs ui.png . 18478
npx --package playwright node tools\ui-growth-test.mjs growth.png 18478 .
npx --package playwright node tools\ui-report-test.mjs report.png 18478 .   # verdict, fix first, waterfall, loop badge, theme
```

The growth test also asserts that no flow row or query-group row has **wrapped**. Both are
CSS grids with a fixed column list, so adding a cell without adding a column silently pushes
the row tools onto a second line — easy to introduce and easy to miss.

`tools/probetest` is a small ASP.NET Core + EF Core app that reproduces a double save and an
N+1, used to verify the recorder end to end.

### Building the setup exe

```powershell
.\build-installer.ps1            # -> dist\ClicktraceSetup-<version>.exe
```

It builds the recorder into its own folder (the one in `probe\bin` is locked while recording
is on), publishes the app self-contained, downloads the official Node.js for Windows x64 —
the same version as the `node` on your machine, or `-NodeVersion` — and **checks it against
nodejs.org's SHA-256 list**, then wraps it all in `installer\`, a small .NET Framework 4.8
setup that every Windows 10 and 11 can run as is. The version comes from
`desktop\DbCallOverlay.csproj`. Node.js is cached in `dist\cache`; `dist\` is not tracked.

### Publishing a release

```powershell
.\publish-release.ps1 -Notes "- What changed`n- Another change"
```

Raise `<Version>` in `desktop\DbCallOverlay.csproj` first. It refuses to publish uncommitted
or unpushed code, builds the setup, and attaches it with its `.sha256` to a release tagged
`v<version>`. Installed copies find it under *Check for updates*; the `- ` lines of the notes
are what they show as the list of changes. `dotnet run --project tools\updatetest` checks the
updater against a local stand-in for GitHub — no release needed.

To test it without touching your own install, use a scratch folder and skip the shortcuts
and the Installed apps entry: `ClicktraceSetup.exe /silent /dir=C:\temp\ct /noshortcuts /noregister`.
`uninstall.ps1 -Quiet` in that folder removes it again.

To work on the UI without rebuilding, run `node server\index.mjs` and open
`http://127.0.0.1:8478`. The app serves its own copy of `ui/`, refreshed on each build.

---

## Compared with

| Tool | What it shares with Clicktrace | Where Clicktrace differs |
|---|---|---|
| [MiniProfiler](https://miniprofiler.com/dotnet/) | Per-request timings, SQL, duplicate and N+1 detection. | No code change in your app: it attaches as a startup hook. Groups by the *click*, not the request, and projects growth. |
| [Sentry tracing](https://docs.sentry.io/product/issues/performance-issues/n-one-queries/) | A waterfall per user action, N+1 detection. | Local and offline, with every parameter value; nothing leaves the machine. |
| Entity Framework Profiler | Named alerts: select N+1, unbounded result sets, too many calls. | Free, sits on top of the app you are clicking, and ranks fixes by time saved. |
| Browser DevTools network panel | The request waterfall. | Sees inside each request: which queries, from which method, and which of them are waste. |

## Licence

MIT — see [LICENSE](LICENSE).
