# personal-assistant

A personal agentic layer that sits between you and the coding agents. It watches where work
arrives — Outlook mail and calendar, Teams chats, GitHub, Jira, and conversations it records in the
room — turns what it finds into **typed commitments** (who asked, for what, by when, in which
repo), and dispatches the ones you approve to Claude Code sessions you can walk into at any
time.

It does not replace Claude Code, and it does not replace termhub. It is the layer that knows
*what should be worked on and why*, so the coding agents stop starting from zero.

> Built through phase 5 of [`PLAN.md`](./PLAN.md): capture, distillation, recall, dispatch and
> drafts all run. [`AGENT.md`](./AGENT.md) is the working agreement for changing any of it.

## Why this exists

Claude Code is excellent at the work and blind to the context. Every session begins with you
re-explaining who asked, which thread it came from, what was decided in the meeting, and which
repo convention applies. That re-explanation is the actual bottleneck, and a persistent store of
your own working context removes it.

The second thing it removes: work finishes and then sits there, because writing "here's what I
did" back to the person who asked is a separate act of will. `pa draft` writes that message from
the run's own diff and the original ask, and fresh asks from mail and Teams get a reply drafted
before you have opened them. You read it, edit it, and send it.

## The shape of it

```
 Teams ask  ──┐
 email       ─┤                                                    ┌─► pa brief   (what's on me)
 meeting     ─┼──►  ingest ──► distill ──►  commitments  ──────────┼─► pa do 42   (dispatch)
 GitHub/Jira ─┘                              (Postgres)            └─► pa draft 7 (reply back)
 your own                                         │
 Claude                                           ▼
 sessions                           dispatcher ──► git worktree
                                                 + BRIEF.md
                                                 + termhub session running `claude`
                                                       │
                              steer with `pa say` ─────┤
                              or attach in termhub ────┘
```

Four decisions carry most of the design:

- **Capture is append-only and keeps raw payloads.** The first extraction prompt will be wrong
  in ways only a fortnight of real mail reveals; keeping the originals means the fix is a
  re-run, not re-reading a year of email.
- **Distilled rows, not chunks.** Retrieval answers "find me passages about billing". "What did
  I promise seven people this week" needs a table with a `due` column.
- **Modes are enforced, not requested.** A `local` run's worktree has its push URL pointed at a
  dead host. The agent cannot push, whatever its brief says.
- **Nothing is sent without you.** There is no send code at all: an approved draft opens,
  already written, in Teams or Outlook, and you press Send there.

## Install (Windows)

Windows and Linux are both first-class (operator decision, 2026-11-02): each runs the native way
for its OS — every OS decision lives in `src/platform/`. Linux is [below](#install-linux).

```powershell
cd C:\repos\dev-tools\personal-assistant
.\windows\install.ps1
```

That provisions Postgres 16 + pgvector inside your WSL distro, registers the logon tasks
(keep-alive, worker, and the two capture streams), creates the Teams cache reader's venv (see
*Teams in seconds*), applies the schema, and writes a `.env` for you to fill in. With
`PA_DB=sqlite` already set it skips WSL and the keep-alive task (no Postgres to hold open). The
repo's root `install.ps1` runs it as part of the whole stack's install, on SQLite.

Then:

```powershell
copy .env.example .env      # if install.ps1 did not
notepad .env                # see below for what each value is
node bin\pa.js login        # checks the Microsoft 365 connector, records who you are
node bin\pa.js projects sync
node bin\pa.js doctor       # confirms what is wired and what is missing
Start-ScheduledTask pa-worker
Start-ScheduledTask pa-capture-mic
Start-ScheduledTask pa-capture-loopback
```

The local voice (Kokoro, the wake word, smart-turn; for `/talk`) is a separate, optional install:
`.\windows\install-voice.ps1` (see "Setting up the local voice").

## Install (Linux)

```bash
cd ~/repos/dev-tools/personal-assistant
linux/install.sh            # --docker | --native | --skip-db, --no-worker, --no-audio, --start
```

That runs `npm ci`; brings up the store — the `docker-compose.yml` container when a Docker daemon
answers (`--docker`), else a dedicated native `pa` cluster on 5433 through
`linux/setup-postgres.sh` (`--native`, sudo, Debian/Ubuntu), which leaves any existing Postgres
alone; records which in `.env` as `PA_PG_TOOLS` so backups reach the right `pg_dump`; applies the
schema; creates the capture venv; and writes and enables three systemd **user** units —
`pa-worker`, `pa-capture@mic`, `pa-capture@loopback` — rendered from the same config the worker
reads, so capture writes where the worker looks. Like the Windows tasks they are not started
until you say so (`--start`, or):

```bash
node bin/pa.js login && node bin/pa.js projects sync && node bin/pa.js doctor
systemctl --user start pa-worker
systemctl --user start pa-capture@mic pa-capture@loopback     # recording — your call
journalctl --user -u pa-worker -f                             # its log
```

What each OS-specific piece becomes on Linux, and what `pa doctor` says when it cannot:

| Piece | Linux | When it can't |
|---|---|---|
| store | native cluster or compose container, 127.0.0.1:5433 | — |
| secrets | Secret Service via `secret-tool` (`libsecret-tools`), value on stdin | `DEGRADED`: env and `.env` only |
| pushes | `notify-send`; ntfy with `PA_NTFY_TOPIC` | `DEGRADED`: the dashboard feed only |
| `pa send` | `xdg-open`; Teams *web* links unless an `msteams:` handler exists; `wl-copy`/`xclip`/`xsel` | headless: the link and text are printed |
| capture | PipeWire/PulseAudio: the mic and the default sink's monitor | no `pactl`: calendar-only gate, `DEGRADED` |
| Teams in seconds | no new Teams desktop client on Linux | `UNSUPPORTED`: the connector, every 3 min |
| services | systemd user units; `loginctl enable-linger` for a headless box | — |

**Into a Postgres the box already runs.** When 5433 is taken, or the machine already has a
Postgres 16 cluster you would rather share, give the PA a role and database of its own there and
skip the store step:

```bash
sudo apt install postgresql-16-pgvector
sudo -u postgres psql -c "create role pa login password '<random>'"
sudo -u postgres createdb -O pa -E UTF8 --locale=C -T template0 pa_personal
sudo -u postgres psql -d pa_personal -c 'create extension vector' -c 'create extension pg_trgm'
# .env: PA_DATABASE_URL=postgres://pa:<random>@127.0.0.1:5432/pa_personal and PA_PG_TOOLS=native
node src/db/migrate.js && linux/install.sh --skip-db --no-audio --start
```

The extensions are created as the superuser because the `pa` role cannot; the first migration's
`create extension if not exists` is then a no-op.

**A stack that ingests nothing** (the personal stack on the Linux box: a dashboard, the board, the
factory, no mail): `PA_M365=0 PA_GITHUB=0 PA_JIRA=0 PA_TEAMS_CACHE=0 PA_AUDIO_ENABLED=0
PA_SESSIONS=0 PA_REPOS_RAVEN=0`. `PA_SESSIONS=0` stops reading Claude Code transcripts (this
machine's and every `PA_MACHINES` machine's), which also keeps out the sessions of whatever account
the box's own `claude` is signed in to; `PA_REPOS_RAVEN=0` stops the repo registry asking a `gh`
that cannot see raven. The repo-root `.env` is read too (see `src/config.js`): a key there that this
stack must not use is overridden by the same key left empty in `personal-assistant/.env`
(`AZURE_OPENAI_API_KEY=`). `PA_CLAUDE_CONFIG_DIR` pointed at an empty folder keeps every
`claude -p` pass off the box's default login until you sign that folder in
(`CLAUDE_CONFIG_DIR=<folder> claude`, then `/login`); the worker and dashboard run without a model,
and each model pass logs its failure and tries again next tick. The chat and dispatched runs start
`claude` in a termhub session on the box's default login, so switch that login first.

`pa doctor` is the answer to "why isn't it doing anything". It reports every credential, every
source cursor, the distillation backlog, and whether termhub is reachable.

`pa projects sync` builds the project ↔ repo table from the clones under `PA_REPOS_ROOT`; the
worker runs it hourly as the first step of `pa repos sync` (the repo registry, below). When
several folders share one remote, the one named like the
repo wins and worktrees and copies become its aliases. A project whose folder has gone is
*retired* — kept, so commitments still point at it, but never offered to the distiller or accepted
as a correction — and comes back if the folder does. A GitHub item's own repository decides its
project outright — any repo in the registry, cloned here or not (one with no clone links with no
folder, and `pa do` asks for one); a repo the registry does not know is left empty rather than
guessed.
Otherwise an ask gets a project only when its text names it — a path, a PR link, the repo's name
or an alias — or its Claude session ran in that repo. Recent work, the thread's earlier asks and
the person asking only break ties between projects the text already names; on their own they used
to spread one wrong guess across a whole thread. The distiller's own pick is kept only when the
text backs it the same way (or shares two distinctive words with one of the repo's names). No
project beats a wrong one. `pa projects rescore` lists open asks whose repo their text does not
back; `--apply --project <name>` (or `--ids`) clears those links and logs undo SQL under
`<PA_DATA_DIR>/fixes/`.

### What you need to set

| Value | Needed for | Notes |
|---|---|---|
| Microsoft 365 (claude.ai connector) | mail, calendar, Teams chats and channels | No app registration and no token: a headless `claude -p` calls the connector. Connect it once with `/mcp` → *claude.ai Microsoft 365*. `PA_TEAMS_CHANNELS` = `mentions` (default) / `all` / `off`. `PA_M365=0` turns it off. |
| `ANTHROPIC_API_KEY` | distillation and drafts | Optional. Without it, model calls run through `claude -p` on your own Claude Code login — or on a login of pa's own with `PA_CLAUDE_CONFIG_DIR` (see SETUP §2). Any pass can also run on Azure OpenAI, OpenAI, OpenRouter, DeepSeek or a local server — see [Models and providers](#models-and-providers). |
| GitHub (`gh auth login`) | notifications, PRs, assigned issues, Projects v2 board items | No token in `.env`: ingest runs through the signed-in `gh` CLI. Boards also need `gh auth refresh -s read:project`; `PA_GITHUB_BOARDS=innergy-dev/7:Pod=Xi` follows a pod's cards whoever they are assigned to (as context: only a card assigned to you or by you puts anything on you). `PA_GITHUB=0` turns it off. |
| Jira (API token, or the Atlassian connector) | issues you're assigned, reported, or watching | Preferred: the `PA_JIRA_API_TOKEN` secret (see [Secrets](#secrets-and-sign-ins)) — REST with Basic auth, no model in the loop. `PA_JIRA_EMAIL` defaults to your Microsoft 365 address, `PA_JIRA_SITE` to the site the connector discovered. Without a token, a headless `claude -p` runs the JQL through the claude.ai Atlassian connector (`/mcp` → *claude.ai Atlassian MCP*); when that fails too, the dashboard asks you for a token. `PA_JIRA=0` turns it off. |
| `AZURE_OPENAI_*` | semantic search | Optional. Without it search is full-text only — good on names and ids, weaker on paraphrase. |

Everything else has a working default. [`SETUP.md`](./SETUP.md) walks through where each of
these actually comes from, click by click — which portal, which menu, which button — and
[`.env.example`](./.env.example) is the annotated template.

### What the connector can and cannot reach

The claude.ai Microsoft 365 connector holds a delegated sign-in that IT grants on its enterprise
app — `pa doctor` prints the grant. On this tenant that covers mail, calendar, Teams chats *and*
Teams channel posts (`ChannelMessage.Read.All`). Two things it does not give:

- **Meeting transcripts.** The scope is granted, but the tenant switches Graph transcript access
  off, so meetings are recorded locally instead (see *Always-on capture*).
- **Sending.** The grant is read-only — no `Mail.Send`, no `ChatMessage.Send`.

Each pass is a headless session: one search since the cursor, then one batch of `read_resource`
calls for the bodies the search only previewed. The bodies are taken from the tool results in the
event stream (and from the files Claude Code spills large results to), never retyped by the model.
Automated mail — GitHub and Jira notifications, no-reply senders — is skipped: those sources are
ingested directly, with structure.

### Teams in seconds

The connector is minutes behind by construction: a headless session every three minutes, over a
Microsoft Search index that itself lags new messages by minutes more (half an hour to an hour
was typical before this). Change notifications would need an app registration, which this tool
does not have. So the worker also reads Teams where Teams itself keeps it: the new Teams client
is a WebView2 app that writes every chat and channel message it shows into Chromium IndexedDB on
your disk, a second or two after it arrives.

Nothing polls for it. `src/ingest/teamsLocal.js` asks Windows to report changes to that
directory (`fs.watch`, i.e. ReadDirectoryChangesW: no file is opened or stat'ed to find out),
waits until a write burst has been quiet for 300 ms (never more than 1.5 s after it began;
`src/ingest/teamsTrigger.js`), and then asks `teams/read_cache.py` to read the LevelDB
write-ahead log *from where the last pass stopped* — a few KB, about 20 ms. LevelDB's new tables
are read only once the log the last pass read is gone (it rotated): until then they are
compactions of what was read already, and a burst of them (2 MB each) used to cost 3–9 s a pass.
After a rotation the pass reads the logs and stores what they hold first, and the next pass,
straight after, reads the tables. `lagSeconds` in the `read` log line runs from the message's
own time to the write, and a row the reader stored first keeps that moment in `raw.storedAt`
(`fetched_at` moves whenever the row is rewritten). The reader stays resident and takes requests on a pipe, so a pass is a
line of JSON rather than a Python start (350–500 ms and a process creation each, which is what
an on-access scanner such as ESET woke up for). A message is in the store about half a second
after Teams writes it; a quiet Teams costs nothing at all. A full parse of the ~100 MB store
takes five to ten minutes in pure Python and is never done.

A notification can be lost — the watcher errors, or Teams replaces the directory on an update.
So a fallback check compares the directory's newest mtime every minute
(`PA_TEAMS_CACHE_FALLBACK_SECONDS`), and re-opens a watcher that saw nothing while the directory
changed. While no watcher is armed the old five-second check runs (`PA_TEAMS_CACHE_POLL_SECONDS`;
`PA_TEAMS_CACHE_WATCH=0` makes it the only trigger), so a broken watcher costs seconds, never
messages. A reader that crashes or hangs (60 s) is replaced on the next pass;
`PA_TEAMS_CACHE_RESIDENT=0` goes back to a process per pass.

Items are `graph_chat` rows with the connector's own ids (`{chatId}/{messageId}` is the same
pair in both), so the two sources share one row:

- a message the connector already has is left alone, unless it was edited since;
- a message read from the cache first keeps its full body; the connector later only *upgrades*
  it — the sender's address where the cache knew an AAD id, the chat's topic — and learns the
  id-to-address pair for next time. When nothing needs upgrading the row is not rewritten, so
  it is not distilled twice;
- channel posts follow `PA_TEAMS_CHANNELS`; bots, cards, call and membership events, and
  deleted messages are skipped; your own messages are kept (they are how "already answered" is
  detected) but not rushed;
- a new DM, group-chat message or mention is distilled at once — and drafted for — instead of
  at the next 90-second tick, through the worker's no-overlap guard. If a scheduled distill is
  already running, the fresh one runs the moment it ends rather than waiting a tick (that pass
  chose its items before the message existed). What remains is the model call itself, and that
  wait for a pass already in flight;
- the distiller reads nothing under 40 characters, except a DM, a self-chat note or a mention,
  which it reads from 6 if it arrived in the last week ("can you check?", "review pls"). One that
  is only a courtesy ("thanks!", "sounds good", your name and a `^`) is marked done without a model
  call (`src/distill/short.ts`; eval set `src/eval/short-asks-cases.json`).

**Windows only.** There is no new Teams desktop client on Linux (Microsoft retired the old one
in 2022), so on Linux the reader is off by default and no watcher or poll is started; Teams
arrives through the connector, minutes behind rather than seconds, and nothing is lost.
`pa doctor` shows `teams cache UNSUPPORTED on Linux`. The Teams *web* app keeps the same IndexedDB
in a Chromium profile; if doctor finds one it prints its path, and `PA_TEAMS_CACHE_DIR=<that path>`
turns the reader on against it. That is experimental — the record shapes are unverified there —
and the doctor line says so.

Privacy: it is the same data the connector reads and you see in Teams, read on the machine it
is already on, for the user signed in to it. Nothing is sent anywhere new. The reader never
writes to Teams' files or holds one open between passes (it opens them read-only with every
share flag and copies tables before parsing; the resident process holds no handle while idle),
and logs carry counts and timings, never a body. Off with
`PA_TEAMS_CACHE=0`; `pa doctor` shows `teams cache: last message Ns ago`, or why not.

The reader lives in its own venv (`%LOCALAPPDATA%\personal-assistant\teams-venv`, created by
`install.ps1`) with [`ccl_chromium_reader`](https://github.com/cclgroupltd/ccl_chromium_reader),
which is not on PyPI and is installed from pinned GitHub archives. Without the venv, or without
the new Teams, the pass is a no-op.

## Zero-downtime restarts (the supervisor)

The `pa-worker` task / unit runs `node src/supervisor` (`docs/native/PLAN.md`, Z1/Z4): it holds
`127.0.0.1:PA_DISPATCH_PORT` for its whole life and proxies it (HTTP, SSE, WebSocket) to a worker
it starts with `PA_SUPERVISED=1` on a port the OS picks, so new code is picked up without a gap.

**Deploying** is `windows/redeploy.ps1` / `linux/redeploy.sh` (termhub's ⟳ Update runs them after
its pull; by hand add `-Pull` / `--pull`, and `-DryRun` / `--dry-run` to see the plan). They run
`node src/supervisor/deploy.js`: `npm install` if the package files changed, `npm run build` once
there is one, a roll, then 60 s of watching `/healthz` and `/api/version` — three failed probes in
a row, or not serving the new commit at the end, rolls back to the previous generation. The
service restarts (with the old gap) only to bootstrap: when no supervisor answers (an install
whose task or unit still ran `src/worker.js`, which the scripts rewrite), or when the supervisor's
own code changed. By hand:

```
node src/supervisor roll       # start a new worker beside the old, switch once its /healthz is ready, drain the old
node src/supervisor rollback   # back to the previous generation (kept, drained, for 150 s after a roll)
node src/supervisor status     # which generation serves, the standby, what is in flight
```

A roll waits up to 180 s for the new worker to be ready and up to 30 s for the old one's
requests to finish; open event streams and WebSockets are closed and reconnect to the new one.
A new worker that crashes or never gets ready is killed and the old one keeps serving (the roll
exits non-zero); a serving one that dies while a standby is kept is replaced by the standby.
Background passes move with a lease (Z2, `src/util/lease.js`): the old generation hands them
over on drain, the new one takes them within a second. The supervisor loads no worker code, so
a deploy restarts it only when `src/supervisor/index.ts` itself changed.

## Using it

**The dashboard** is at <http://127.0.0.1:7300/> whenever the worker runs (or `pa dashboard`
on its own). Loopback only — it can start agents. Its Today board has two main columns, each with
a count, and every commitment appears on it once (`src/dashboard/board.js`, tested in
`test/board.test.js`):

- **On me** — everything you must act on or confirm: what you owe people, with **Do** (dispatch),
  **Reply**, **Done** and **Dismiss**; a prepared session (a *ready to start* flag, **Start it** /
  **Don't start** — declining runs nothing and leaves the ask on the list); a question for you
  (**Skip** leaves it unanswered). It takes the page's full width: **To do** on the left, and beside
  it (below it on a phone) **Blocked or waiting**, then **Looks done — confirm?**, the asks the
  reconciler thinks are settled but was not sure enough to close, in either direction, each with
  the quote, **Confirm done** and **Keep open**. A prepared action, a question and a looks-done
  proposal are drawn on the card of the ask they are about, not as cards of their own; two
  commitments from the same message with the same words are one card ("also #…").
- **Waiting on others** — what people owe you. A card whose chase asks when to follow up carries
  that question (below).

Every section on the page is the same component: a header row with a disclosure arrow, the title
and a count, and a body that folds away; the page remembers each one open or closed (this browser
only, `pa.fold.<section>`). What needs you starts open (credentials, **Replies to send**, **On
me**, **Agent runs**), the rest closed: **Others' work, not blocking you**, **Closed recently**
and **From the assistant**. The open GitHub and Jira items that used to be **Code & boards** are
at the top of the **Repos** view (*Review requests & board items*, from `GET /api/repos`).
**Replies to send** and **Agent runs** appear only when they have something; **Agent runs** lists
the runs that are not factory jobs, and a factory run only while it is blocked: the rest are jobs
on Build, with their state, PR and cost, and the section links there. Colour is kept for meaning:
amber marks what waits on you or on someone (a section's edge, *blocked on*, *question for you*,
overdue), everything else is ink and grey. Each section's explanation is its title's tooltip.
Every button shows that it is working and then what happened. Typing to the PA chat is on Ask, in
its **Text** mode ([below](#asks-text-mode-and-the-chat-api)); an old `#chat` link goes there.

**Every card says where it came from and why it is there.** Cards on **On me** and **Waiting on
others** carry a row of links built from what ingest stored, with
no model in the loop (`src/dashboard/links.js`, `cards.js`): the Teams message, mail, PR, Jira issue
or board item it was read from; a Teams chat with the person and their GitHub; the repo; GitHub
PRs, issues, branches, repos and Jira issues named in the message or the next few messages of its
thread; a run's PR; and, on a card that looks done, the item that suggests it is settled. A card read from
a Claude session says which machine and folder it ran in and when, shows `claude --resume <id>`,
links its transcript, and has **Open in termhub**, which opens the running session on that machine
or starts one resuming it. Above the links is a short paragraph — who asked what, what led to it,
what has happened since, and what is expected now and from whom — written by the worker a few
cards at a time (`src/commitments/context.ts`, every two minutes, `PA_CARD_CONTEXT=0` turns it off)
and rewritten when the thread has news; it is discretionary spend (`card-context`). A chase's
"when should I follow up?" question sits on the card of the ask it is about, under that paragraph.

**One ask, one card, wherever it was said.** The same work turns up in a chat, the draft of the
reply, the PR, a meeting chat — and a message with a numbered list used to become one card per
point plus one for the whole list. Three things keep that to one card:

- *Distillation*: a message that asks for or promises a set of things gives one commitment whose
  summary names the set and whose detail lists the items (a prompt rule; `src/distill/lists.js`
  collapses an umbrella-plus-items or item-per-list-line answer if the model still splits). New
  items only — the prompt version was not bumped, so history is not re-distilled.
- *The duplicate pass* (`src/commitments/dedupe.ts`, pure half `semantic.js`, every three minutes,
  `PA_DEDUPE=0` turns it off): each new open commitment is embedded (summary + detail, stored in
  `commitment_vector`) and paired with open commitments of the last 60 days from **any** thread,
  source or person — cosine ≥ 0.60, or ≥ 0.38 in the same conversation (a Teams draft counts as
  the chat it is for), or ≥ 0.30 when both name the same anchor (`repo#123`, a GitHub PR/issue URL,
  another URL, a Jira key). Either direction is compared when one side has no counterparty. A cheap
  model (`PA_DEDUPE_MODEL`, default `azure/pa`) answers each pair in batches of 20 with a typed
  verdict — `same`, `subset` or `different`, plus "does A include B / B include A", which must agree
  with it. `same` folds into the judge's keeper; `subset` folds only for the same anchor or into an
  *umbrella* in the same conversation that clearly names two or more parts (`umbrellaFolds`), with
  the word overlap deciding which is the whole. A commitment something acted on (run, draft, ledger
  status change, a reply that closed it, your hand) is never hidden behind one nothing acted on.
  Fold = `superseded_by`, as for the review pass, so Done closes the group. Discretionary spend
  (`dedupe`). The 0.60 was calibrated on the live board: unrelated open pairs have a median cosine
  of 0.27 and a 99th percentile of 0.55; rewordings of one ask in different threads scored
  0.58–0.92, and an umbrella against its own items only 0.40–0.57, hence the per-thread floor.
- *The card*: a card with folded duplicates shows **also mentioned in:** with a link to every other
  place they were said (`links.alsoLinks`), so folding loses no thread.

**Only people put tasks on the board** (`src/commitments/sourcePolicy.ts`). A card comes from what
people say to you — Teams chats and channels, mail, meeting recordings and invites — from a person on
GitHub or Jira asking you for something (a review requested of you by name, an @mention, a reviewer's
comment on your PR, an issue or board card assigned to you), or from you asking for one (below). Your
Claude and Cursor sessions — including the PA chat's own — never create cards: the assistant's own
work and its handoff steps are not tasks. They are still ingested: the reconciler closes cards with
them, and memory and search read them. Within an allowed source only a person counts: mail and chat
from automated senders (`m365.isAutomated`), GitHub bots (`[bot]` logins, CodeRabbit, Snyk, dependabot,
CI), Jira automation, team review queues, CI and state changes, and your own GitHub activity create
nothing. The check runs before the model: excluded items are never sent to the distiller (in the week
before the rule, ~86% of distilled items — almost all GitHub team-review notifications and Claude
sessions — and most of the distill spend). `PA_COMMITMENT_SOURCES` sets the sources, as groups (`teams`,
`mail`, `meetings`, `github`, `jira`, `requests`, `sessions`) or source names, `-name` to take one out
(`default,-github`); `pa policy` prints what it resolves to, and `pa doctor` shows it. The duplicate pass
pairs only commitments from allowed sources. `pa policy close` lists the open cards the policy would not
have created, grouped by source; `--apply` drops them through the ledger (actor `reconciler`, reason
"not from a person — source policy: …", so they are under **Closed recently** with **Reopen**), keeps
and lists any you acted on (a run, a draft, your edit or status change), moves allowed-source asks that
were folded under one (up to its survivor, or the oldest unfolds and the rest fold under it), and writes
undo SQL to `<dataDir>/fixes/`. Teams rows from the client's own views (the `48:` drafts, mentions,
notifications, threads and call-log threads; `48:notes`, your self chat, is a chat) and its local copy of
a message being sent (message id `-1`, a draft's `-4.…`) are nobody's message: the cache reader no longer
stores them (`src/ingest/teamsThreads.ts`), and `pa policy close --teams [--apply]` drops the open cards
the earlier ones made, folded copies included, and nothing else.

**A task because you said so.** `pa task add "<what>" [--due friday|tomorrow 3pm|2d|2026-11-20]
[--for <person>] [--owed-to-me] [--project <name>]` puts it on the board at once (`src/commitments/request.ts`;
source `pa_request`, never distilled). `--for` names who it is for — or, with `--owed-to-me`, who owes it
to you; a name that matches exactly one person links them, anything else is kept as text. Telling the PA
chat "create a task to…" does the same through its `task_add` tool, which needs no permission prompt
(it is reversible: **Dismiss**) and which the chat is told to use only when you explicitly ask — never for
its own work or for something a message asked. The board has the same as a **+ task** box on **On me**.

Notes from your own Claude sessions and PRs read before the rule above (agent handoffs like
"verify the banner in a browser before merge") are not listed on the page any more: one shows on
**On me** only while it carries a question or a looks-done proposal. No new ones are created; the
rest close when their PR merges or closes, or expire after a week nobody touched them
(`src/commitments/selfNotes.ts`, the worker's `self-notes` pass; reopening or correcting one counts
as touching it), and `pa brief` still lists them. Asks from
people never expire. A GitHub issue someone else filed through your account is still their ask.
Auto-drafted replies are never written for an ask that was your own message, and one already
written for one is retired.

**Closed recently** lists what left your list in the last three days and why — by you, or by the
assistant: after each GitHub pass it closes commitments whose PR merged or closed, reviews you
already gave, and review requests GitHub addressed only to a team you are in (those never become
commitments in the first place now). Each has **Reopen**.

A GitHub item puts something on you only when GitHub names you on it: you wrote it, are assigned,
were asked to review by name (not through a team or CODEOWNERS), were @mentioned by login, or
commented in it. Anything else — a team review request, a watched repo, an unassigned card on a
pod board you follow — is context: its facts are kept, its commitments are not. On a PR you did
not write, the work it plans ("frontend in a follow-up PR") is its author's, owed to you at most,
and if you are only a reviewer what you owe is the review. That is checked in code after the model
answers (`src/distill/githubGate.js`), not asked of it.

Asks from Teams and mail close the same way once you have answered them yourself
(`src/commitments/replyClose.ts`, every five minutes, `PA_REPLY_CLOSE=0` turns it off). An open
owed_by_me commitment with a later message from you in the same chat or mail thread (within two
weeks) is shown to a model beside that ask; only a reply that delivers what was owed — the answer,
even a "no", or "fixed it" — closes it, never a promise ("I'll look tomorrow") or half an answer.
The verdict must quote your message verbatim (checked as for memory claims) and the quote becomes
the reason: `answered in chat: "…"`. Each judgement is a `reply_close` row keyed by the newest
reply it saw, with what the close replaced, so the same reply is never judged twice — **Reopen**
(or `pa done <id> --reopen`) sticks until you write in that thread again. `pa doctor` shows the
count.

**The reconciler keeps the rest true** (`src/ledger/reconcile.ts`, every minute and right after a
fresh Teams message; `PA_RECONCILE=0` turns it off, `PA_RECONCILE_AUTO=0` makes every close a
proposal). It is level-triggered: each open commitment, in either direction, is judged against
everything *related* that arrived since it was last judged — the same thread first, what the other
person wrote in chat or mail or in the ask's own repo (so their answer to an owed-to-me ask closes
it), and your own PRs, notifications and
Claude sessions in the commitment's repo (a session once it has been quiet for 10 minutes, or a
live one would re-judge its whole repo every minute). Fresh evidence is judged first, then the asks
that have waited longest, so a backlog never starves. Commitments that share new items are judged in one call;
with nothing new there is no model call at all. A close needs a quote checked verbatim against the
item, and is applied on its own at 80% confidence or more — unless you reopened that commitment
before — or shown under **Looks done — confirm?** on **On me** with **Confirm done** / **Keep open** between 50% and 80%. A
promise is never a delivery. Every status change, yours or the assistant's, goes through
`src/ledger` and is listed by `pa ledger <id>`; the closed card says who closed it, and **Reopen**
takes it back.

**Work that waits is a durable task** (`src/durable`, on [Absurd](https://github.com/earendil-works/absurd)
in the same Postgres; `PA_DURABLE=0` turns it off). Two so far. **Chase**: for something a person
owes you in chat or mail, its card under **Waiting on others** asks when to follow up: chips (5 min,
1 h, tomorrow 9:00, 2 days, next week), a box that reads `5m`, `90 min`, `2h`, `2d`, `1w`,
`tomorrow 3pm`, `today 17:00`, `3pm`, `mon`, `next fri 2pm`, `next week` or
`2026-11-10 14:00` (and a date-time picker), previewed before you set it (`GET /api/when`), or
**Keep, but don't remind me** — it stays open and is never chased. **Not needed — close it** on that
card closes the ask instead (it moves to Closed recently). The parser is `src/util/when.js` (pure,
`test/when.test.js`); a typed time is taken literally and stored in canonical form (`5m`,
`at:<ISO>`), the fixed 4h/1d/2d/1w answers still keep to working hours, and one it cannot read is
refused, never guessed. The span you last gave for that person (an hour or more; not "don't remind
me" or a fixed time) is marked *usual*. Unanswered, it goes with the default: your usual for them,
else a working morning two days after the promise (or just after it was due). Unless the ask closes first, a follow-up is then drafted in
that thread for you to send, and if nothing comes you get one reminder half as long again later;
at most three follow-ups a day. The card goes away by itself when their answer closes the ask.
**Run review**: when a dispatched run's session ends with commits, the assistant carries out the
run's **end state** — the delivery level you chose (below) — and tells you: `none` pushes nothing,
`branch` pushes the branch, `draft_pr` opens a draft PR, `pr` marks it ready for review,
`auto_merge` marks it ready and squash-merges it, `push_to_main` pushes the branch and then
fast-forwards the default branch to it (no `--force`; a main that moved on refuses). Neither happens
before CI passed on that exact commit: the assistant polls its checks once a minute for at most 30
minutes; with no checks at all it proceeds only when the repo provably requires none (and notes it
on the run). Red CI, a timeout, or a main that moved on leaves the branch / PR as it is, marks the
run `blocked` with the reason and tells you. A research (`plan`) run just tells you its findings are ready. A run
from before end states keeps the old rule: a draft PR, merged only in your own repos
(`PA_MERGE_REPOS`). A chase judges its ask before asking you anything, so an ask already answered
gets no card. **On me** is also where the assistant asks what
only you know (which repo?). `pa proposals` / `pa answer <id> yes|no|<option>|<when>`
(`pa answer 109 tomorrow 3pm`) do the same from the terminal, and `pa doctor` counts tasks by state.

**Model spend is recorded and capped per day** (`src/budget.js`). Every model call — `claude -p`
or the API — leaves an `llm_spend` row: when, which pass (`purpose`: distill, reconcile,
reply-close, draft, memory-*, meeting-brief, debrief, connector, ...), model, backend, cost,
tokens, duration and whether it worked; never any prompt or reply text. The CLI reports its own
cost; for the API it is estimated from token usage at list prices, or left null for a model it
does not know. Another provider's call is priced only from `PA_MODEL_PRICES` (or, on OpenRouter,
the cost it reports); otherwise its cost is null, never guessed — and its `backend` is the
provider's name (`azure`, `openrouter`, …). `PA_DAILY_BUDGET_USD` (default 15) caps a local day: once reached, *discretionary*
purposes (`PA_BUDGET_DISCRETIONARY`, default eager, research, digest, planner, card, propose, dedupe — speculative work
done ahead of you) are refused until midnight and the worker logs it once; *essential* ones
(`PA_BUDGET_ESSENTIAL`, default distill, reconcile, connector, reply-close) keep the board true
and are never refused. Speculative work asks `budget.allow(purpose)` before it spends. `pa spend
[--days N]` prints per-day, per-pass totals, `pa doctor` shows today against the cap with the top
three passes, and the dashboard shows a spend chip beside the source chips.

**Meter: telemetry and the Claude credit pool** (plan 7.5). Since 15 Jun 2026 headless Claude Code (the PA's `claude -p`
and the factory's `claude_session` runs) draws from a credit pool apart from the interactive allowance.
`PA_CLAUDE_POOL_USD` is that pool per month in API-equivalent dollars (unset: not tracked); it resets on
`PA_CLAUDE_POOL_RESET_DAY` (default 1). Usage is the `total_cost_usd` each run's stream-json result reports: the PA's own
calls are `llm_spend` rows with backend `cli`, and the factory posts its runs to `POST /api/telemetry` (backend
`claude_session`; set `PA_TELEMETRY_URL=http://127.0.0.1:7300` in the factory's environment, unset = off). `pa spend` and the
Meter page (termhub `/meter`, from `GET /api/meter`) show what is left. **API fallback** is
`PA_CLAUDE_POOL_FALLBACK_API=1`, off by default: once the pool is spent, `claude_session` jobs are dispatched on the `api`
runtime (metered, `PA_FACTORY_MODELS` routing) instead; off, they keep running and the page says the pool is spent. If the
ledger cannot be read the requested runtime stands. The same page shows latency per hop, p50 and p95: OpenTelemetry spans
(`@opentelemetry/api`) for a voice turn, an MCP tool call, a factory CLI call and a deploy are written by a local exporter
to `trace_span` (kept `PA_TELEMETRY_RETENTION_DAYS`, default 30; `PA_TELEMETRY=0` turns the instruments off), with no
collector or cloud service; the factory's own hops arrive through the same endpoint. Spans carry ids, names and counts,
never prompt or argument text.

**The planner works ahead of you** (`src/agent/planner.ts`, every five minutes, `PA_PLANNER=0`
turns it off). Each new ask on you from the last week is given a kind (reply, review, coding,
investigate, meeting, decision, admin) once. An *investigate* ask with a known repo gets a
read-only research run started on its own — `plan` mode, so it can neither commit nor push — at
most `PA_EAGER_RUNS_PER_DAY` (2) a day and only within the daily budget; you get a toast with the
session. A *coding* ask with a known repo gets a *ready to start* offer on its **On me** card, "start a coding session?" —
or, when the routing rule picks the software factory (below), "send to the factory?". Everything
the card shows is decided before you see it and frozen into the proposal (`src/dispatch/offer.ts`):
the route and its reason, the **end state** in plain words (loud when nothing human follows your
yes), the app, pipeline and models, the done-criteria, and — one click away — the exact brief that
will be sent. Accepting runs exactly that; the only thing you can change on the card is the end
state (a picker), and the brief is re-rendered for it. The planner's offers take the repo's default
end state: it never reads one from the ask's text, which someone else wrote. A factory job changes
code, so it is only ever offered. A code ask with no repo asks **which repo?** with buttons; your pick sets the
project and teaches the alias, and the ask is planned again. Asks the reconciler thinks are done,
or that already have a run, are left alone.

**Replies to send** sits at the top: drafts the worker wrote for fresh asks from mail and Teams
(`PA_AUTODRAFT=0` turns that off; `PA_AUTODRAFT_MIN_CONFIDENCE`, default 0.6, sets how sure the
distiller must be that the ask is on you), plus any you asked for with **Reply**. Each shows the
original message and an editable box. **Send in Teams / Send in Outlook** opens the reply where
it goes — a 1:1 Teams chat or a new Outlook message with the text already typed in; a group
chat or channel thread opens with the text on the clipboard to paste — and asks *Did it go?*.
The connector's grant is read-only, so this page cannot send; you press Send in Teams or Outlook.
A draft is only written for an ask you have not answered, and one you answer yourself afterwards —
a newer message from you in the same chat or mail thread — is retired on the next pass with the
reason recorded (`draft.closed_reason`).

**Memory** (the second tab, `#memory`) is the memory layer below, made browsable:

- **People & projects** (and topics), filterable, each with the one-line summary from its page.
  Opening one shows the page and, under it, every claim about that subject: kind, valid dates,
  status, the verbatim quote, and a link to the item it came from. **Show history** adds
  superseded and retracted claims. Every `[#id]` in a page opens that item. **Me** and **Index**
  are there too.
- **Review queue**, with a count on the tab: `pending_review` claims — quotes that only nearly
  matched, and notes an agent suggested. **Approve** makes one a belief (confidence 1) and
  consolidates it; **Reject** retracts it.
- **Remember** a note (optionally about someone or something, and of a given kind); the result
  says whether it was added, superseded an older claim, or was already known.
- **Search** claims, and **Forget** one, after a confirm that says what it does: the claim is
  marked retracted (not deleted), pages are rewritten, and a claim it had superseded is believed
  again.
- **Possible duplicate people** — the same colleague seen by GitHub handle and by email — with a
  **Merge** that moves identities, commitments and claims to the person kept, deletes the other's
  page and rewrites the survivor's. There is no unmerge, so it asks first.

Pages are written by a model from other people's mail and chat, so the page never renders them
as HTML: the server parses the markdown into a tree (`src/dashboard/markdown.js`) and the browser
builds it with `textContent`, like everything else on the page.

```
pa brief                        what's on you today
pa inbox                        newly distilled commitments
pa show 42                      one commitment, with the ask in the requester's words
pa show 42 --project x          correct a wrong repo — and teach it the phrase
pa search <words>               hybrid search over everything captured
pa who Sam                      identities, threads, open commitments

pa done 42 [--dismiss|--reopen] close a commitment yourself
pa task add "Send the deck" --due friday --for Sam   a task because you asked for it
pa policy [close [--apply]]     which sources create tasks; close cards the policy would not have made
pa ledger 42                    every status change of #42, who made it and why
pa ledger reconcile --dry-run   what the reconciler would close now (--id 1,2 to aim it)
pa ledger looks-done            closes waiting for you; answer with <id> --yes|--no
pa ledger undo 7                take back one status change
pa proposals                    prepared actions and questions waiting on you
pa answer 3 yes                 answer one (yes, no, or one of its options)
pa dashboard                    serve the web page without the worker

pa do 42 --mode mr              dispatch to a Claude Code session in its own worktree
pa runs                         what's in flight
pa say 7 "use the existing helper"
pa attach 7                     open the session in termhub
pa review 7 [--diff]            what it changed
pa land 7                       push, and open a draft PR (gh) if the mode allows
pa do 959 --delivery auto_merge --pipeline solo   end state + pipeline, chosen by you
pa propose 959                  the same on a card: brief, end state and criteria shown before the yes
pa delivery set acme/widget pr  a repo's default end state when you say nothing
pa drop 7                       kill the session, remove the worktree

pa draft 7                      a report on a run, from the ask and the actual diff
pa reply 42                     a reply to the ask behind commitment 42
pa drafts                       what is waiting to be sent
pa send 12                      opens it, written, in Teams/Outlook; you press Send

pa mic status | pause 30 | on    always-on capture control
pa doctor                        what is configured, stale, or broken
pa spend [--days 7]              model spend per day and per pass, against the daily cap
```

### Repos: the registry of what you work in

`project` is the single source of truth for every repo you work in — built from evidence, never
from what a conversation happened to mention. `pa repos sync` (the worker runs it hourly,
`PA_REPOS_SYNC_SECONDS`; `PA_REPOS=0` falls back to the six-hourly disk-only `pa projects sync`)
reads:

- **Clones** under `PA_REPOS_ROOT`: remote, default branch, the recent branches (yours marked by
  your git email), the date of your last commit (within a year).
- **GitHub**, through `gh`: every PR you authored (GraphQL search; the first sync reads all of
  them, later ones only what changed since) with title, state, branch and a one-line summary taken
  from the body — no model call — and your commits (commit search). A repo you have a PR or commit
  in is in the registry whether or not it is cloned here. A repo that moved from GitLab to GitHub
  takes over its retired GitLab row, so its commitments come with it.
- **Claude sessions** already ingested, on this machine and every `PA_MACHINES` one: the folder
  each ran in (the first folder under that machine's repos root) is matched to a repo by name,
  alias or known folder and recorded as that repo's path on that machine, with the branch. A
  folder you worked in on two or more sessions and nothing else knows (a repo on the Linux box)
  becomes a repo of its own.
- **raven** (`innergy-dev/raven`, live from GitHub `main`, else the local clone):
  `knowledge/systems/repositories.md` is the authoritative description of INNERGY repos, and a
  `knowledge/systems/<repo>/` folder is linked as the repo's deep doc.

What a repo *is* — a description, kind, stack, owner, related repos — comes from raven where it
covers the repo, else from a profile the cheap pass model writes from the README, manifests and
top-level files (`PA_REPO_PROFILE_MODEL`, default the reconcile model; purpose `repo-profile` in
`llm_spend`). It is written again only when that material changes, so a quiet hour makes no model
call; `PA_REPO_PROFILE=0` stops it.

```
pa repos                          repos you work in, newest activity first, with your latest PRs
pa repos list --all               every active repo, hidden ones too
pa repos show erp                 description, folders per machine, branches, aliases, every PR, linked asks
pa repos sync [--full]            refresh now (--full re-reads every PR); --no-profile skips the model
pa repos add innergy-dev/lidia    a repo the sources do not show yet (pinned to the tab)
pa repos alias erp "aspen"        a name you call it — the resolver matches it from then on
pa repos set erp --owner "Pod Xi" --description "…" --stack "C#,React"
pa repos hide OpenHands           off the Repos tab (unhide puts it back)
```

Your edits live in their own columns (`project.manual`, `hidden`, `corrected` aliases) and every
reader lays them over the synced values: **manual always wins**, and sync never writes them.

The resolver (`src/projects/resolve.js`) resolves against the registry: besides a repo's name,
forge path, clone and aliases, the folders it is known by on every machine (a session on
`mv-automated-vm` in `C:\source\mv-assistant` is evidence for `mv-assistant`) and its older forge
paths (a GitLab original). The evidence rule is unchanged: a repo is linked only when the item's
text, its repository or its session's folder names it.

The dashboard's **Repos** tab (`#repos`) shows one card per repo you worked in, newest activity
first: name, forge link and folders per machine, kind and stack, the description, your activity
(PRs, sessions, last commit), your latest PRs (state, date, one-line summary) and recent branches.
A card opens the repo's detail view (`#repos/<name>`) with every PR, every branch, the asks linked
to it and a Hide button; **Sync now** starts a sync.

### Memory

Alongside commitments, the worker keeps a memory of the people and projects around you: who owns
what, who knows what, how someone likes to work, what was decided, where a project stands, and
how you yourself work. It is built in four passes, all queries over marker tables like
distillation:

1. **Claims** — a separate pass (`src/memory/extract.js`, a cheaper model than distillation,
   several items per call) reads each item and writes *claims*: one sentence about a subject, with
   the **verbatim quote** it came from. A quote that is not in the item is dropped; one that is
   only nearly there is kept as `pending_review` and not believed. Automated noise and
   notifications for PRs that are ingested themselves are skipped. Transcripts give at most three
   claims, and only from attributable speech.
2. **Consolidation** — each new claim is compared with the five most similar active claims about
   the same subject and judged ADD, SUPERSEDE, DUPLICATE or NOOP. Superseding closes the old
   claim's clocks (`invalid_at`, `expired_at`) and keeps it: memory is bitemporal, so what was
   believed when is still answerable. The same pass sets `commitment.superseded_by` when a newer
   commitment restates an older open one in the same direction from the same item, thread or
   person — compared with the most alike of those, not just the most recent. A near-verbatim
   repeat (same words, same numbers and refs) is folded without a model call; the rest go to the
   judge. The newer one survives, unless only the older one has been acted on (a run, a draft, a
   ledger entry, your hand) — then the newer one is the one folded. Restatements from other
   threads and people are the duplicate pass's (see "One ask, one card" above).
3. **Pages** (hourly) — a markdown page per person you actually work with and per project with
   something known, rebuilt only when its claims or commitments changed, every line citing
   `[#item]`.
4. **Dream** (nightly) — dedupes whole subjects, retires status claims that described a moment,
   and rebuilds `me` (your profile, ≤1500 tokens) and `index` (who's who, small enough to load
   into every call).

Claims keep their own quote, and their link to the item is `on delete set null`, so memory
outlives the 180-day retention on mail and chat.

```
pa memory                        the index: who's who, what's active
pa memory me                     your profile
pa memory Brannoc                a person's page (or: pa memory project quill)
pa memory claims Brannoc         what is believed, with quotes and status (--all, --as-of)
pa memory explain 812            one claim: its evidence, source, and what it replaced
pa remember "Quill prefers PRs under 400 lines" [--about Quill]
pa forget 812 | item:4411        retract; the pages are rebuilt without it
pa memory run [extract|consolidate|pages|dream]   force a pass
```

**Reading it back: recall.** `src/recall/` is the question-answering path, exposed as the MCP
`recall` tool and used for reply drafts and dispatch briefs. One hop searches items, claims and
pages in parallel; a second searches again for what the strongest claims and pages name (and,
with `deep`, sub-queries a model plans from the index); then one Cohere rerank orders items,
claims and pages together against the question. A claim lends its score to the item it came
from. When the best score is under 0.6, recall says nothing relevant was found instead of
offering the least-bad hit. On the eval it lifts multi-session R@5 from 0.22 to 0.37 and
knowledge-update R@5 from 0.90 to 1.00 over plain search, at ~2s a question.

Drafts get the requester's page, your own profile and recalled facts; briefs get the requester's
and project's pages and recalled facts — each labelled as evidence, not instruction. Agents can
propose a fact with MCP `remember`; it lands as `pending_review` and changes nothing until you
approve it.

### Pre-meeting briefs

About an hour before a meeting (`PA_BRIEF_LEAD_MINUTES`, default 60) the worker sends a short
numbered brief of what is worth saying in it — a desktop notification (a Windows toast, or
notify-send on Linux) with the first lines, the whole
brief in the dashboard's **Meetings** tab (under **Upcoming · what to say**), with **Open brief** and **Join** buttons on the
toast. `src/meetings/`, a 5-minute pass:

1. **Which meetings.** Calendar occurrences starting within the lead time, once per event id +
   start (a moved meeting is briefed again). Skipped: cancelled, all-day, marked free/OOF, solo
   blocks (`PA_BRIEF_FOCUS=1` briefs them), and broadcasts with more than `PA_BRIEF_MAX_ATTENDEES`
   (40) invitees unless you organised them.
2. **What kind.** Title keywords first (stand-up/daily, 1:1, planning/refinement, review/demo,
   retro, interview, customer), then the series' shape (two people → 1:1; ≤20 minutes on three
   or more days with a team → stand-up; mostly outside your domain → external), then one cheap
   model call, cached per series. `pa meeting kind "<title>" <kind>` corrects it for good.
3. **Evidence per kind.** *Stand-up*: since the previous occurrence (or the previous working day —
   Monday covers Friday): PRs merged and reviewed (a live `gh` search), activity on your PRs,
   Jira tickets, commitments closed, Claude Code sessions; then what is due, new asks, open PRs
   and reviews asked of you; blocker claims. *1:1*: open commitments both ways, their memory
   page, recent threads. *Anything else*: `recall` over the title and description, attendees'
   pages, and for review/retro/planning your last week's work.
4. **Learning.** After a meeting ends, transcripts recorded during it (audio items linked to the
   event or overlapping its slot) are read once: how the meeting runs, what you get asked, and
   what you reported or promised — each kept only with a verbatim quote that checks out against
   the transcript (your promises against your own `Me:` lines). That becomes the series profile
   and claims about `topic:<series>`; the next brief checks last time's promises against the
   evidence ("Said last time: finish the retry — merged ✅").
5. **Writing.** One model call over labelled evidence (E1…En), written as **your script**:
   per section, a few first-person bullets you can say out loud ("I shipped the What's new panel —
   it lists every improvement a user can use"), saying what each PR or session changed (from its
   description or opening prompt), your own work first and reviews of others' PRs last. Every
   bullet cites its labels; an unknown label is dropped. The toast shows one line per section
   (its first bullet and "+N"), capped at 120 words; the dashboard and `pa meeting brief` show the
   whole script with each bullet's sources. Asks the assistant closed because someone else's PR
   merged are not reported as your work.

```
pa meeting next                     the next meeting that would be briefed, and its kind
pa meeting list [--hours 24]        upcoming: kind, briefed, or why skipped
pa meeting brief next|<event-id>    write it now and print it (--force to rewrite, --notify to deliver, --evidence for the raw input)
pa meeting kind "<title>" standup   correct a series' kind
pa meeting learn                    learn from meetings that just ended now
```

`PA_BRIEFS=0` turns it off; `PA_BRIEF_MODEL` / `PA_BRIEF_EFFORT` pick the writer.

### Post-meeting debriefs

Minutes after a recorded meeting or call ends, a toast: *"Debrief: Ledger sync — 2 to-dos for
you, 1 updated, 1 decision"*, with a numbered list, and the full meeting card in the dashboard's
**Meetings** tab (short summary of what happened, what was decided, your action items and updates,
and the transcript; defaults to today's meetings). `src/meetings/debrief.ts`, run in the worker's audio pass:

1. **When.** A meeting or call episode is debriefed once it is over: its calendar
   slot has ended, the audio past the end is transcribed, and nobody spoke in the last ~100 s of
   it — or ten quiet minutes (or capture has paused after an ad-hoc call), for a call or a meeting
   that ended early — or 45 minutes have passed. When a meeting ends the worker touches `audio.roll` (`PA_AUDIO_ROLL_FILE`) and capture
   finishes its files within a second, so a meeting is typically debriefed 2–7 minutes after it
   ends instead of at the next quarter-hour.
2. **One model call per meeting** (`PA_DEBRIEF_MODEL`, default Sonnet; `PA_DEBRIEF_EFFORT`
   medium) reads the transcript beside the calendar title and attendees (plus recent 1:1/group Teams
   messages around an ad-hoc call), who you are, and your
   open commitments (C-ids), open PRs and assigned tickets (T-ids). It writes a 2–3 sentence
   summary of what happened and returns only what is
   yours: to-dos you took or were asked to take, what others owe you, updates to a listed item
   (done, moved, blocked, new information) and decisions that change your work. Others' tasks,
   status of work you do not own, and small talk are left out — an empty debrief is a fine one.
   The speaker stream can be your own AI assistant reading its reply aloud: what it says it will
   do is never owed to you (an item whose owner is the assistant is dropped), and a setup step it
   reports (a repo not registered with the factory) is yours only when you must do it.
3. **Verify, then apply.** Every item carries a verbatim quote, checked against the transcript
   (case- and whitespace-folded; a near miss is dropped). To-dos and owed-to-me become
   commitments (`extracted_by = debrief-v1`) unless one on your list already says the same;
   *done* closes the commitment ("said done in <meeting>: “…”"); *moved* sets its date; *blocked*
   and *new info* append to its detail; news about a PR or ticket and every decision become
   memory claims with their quote. Everything applied is recorded in `meeting_debrief` with what
   it replaced, and **Undo** (dashboard) or `pa meeting undo` takes any one item back.
4. **Once.** The generic distiller skips meeting and call recordings (the debrief owns them). A
   meeting that keeps going after its debrief is debriefed again once it has grown by a page of
   speech; the second pass sees the first one's to-dos as open commitments.
5. **Nobody else in it: discarded.** The model also says whether anyone but you takes part
   (`others_present`). When nobody does — dictation, talking with the assistant, a video playing —
   nothing is applied and the recording is discarded: its transcript item, audio and any earlier
   debrief go, and the episode stays only as a `solo` marker the audio pass will not store again.

```
pa meeting debrief [episode-id|last] [--dry-run] [--notify]
pa meeting debriefs [--days 7]
pa meeting undo <debrief-id> <n>
pa meeting solo [--days 30]          debriefs whose title says you were alone (read-only)
pa meeting solo --apply              remove those: undo what they applied, delete debrief, transcript, audio
pa meeting discard <debrief-id>...   the same for debriefs you name
```

`PA_DEBRIEF=0` turns it off.

### Dispatch modes

| Mode | May | Stops before |
|---|---|---|
| `plan` | read, write a plan | changing any file |
| `local` *(default)* | commit in its own worktree | anything touching the remote |
| `branch` | push the branch | opening a PR |
| `mr` | push, open a **draft** PR | marking it ready, notifying anyone |
| `full` | all of that, plus draft a reply into `REPLY.md` | sending |

### Runs on another machine

**Gone since D28** (every dispatch is a factory job on the factory's machine, `PA_FACTORY_MACHINE`;
`--machine` is refused). What follows describes the runs started that way before, which `pa drop`,
`pa attach` and the reconcile pass still manage.

Some work belongs on a particular machine — the VM that runs the service, holds the OneDrive
sync, has the credentials. `pa do 959 --machine mv-automated-vm` (or, then, the machine picker
beside **Do**) started the run in *that* machine's termhub, which is already one of
your hub's peers, so you attach to it the same way. Machines are listed in `PA_MACHINES`
(`name=termhubUrl|reposRoot[|os]`); the repo must be cloned there under the same folder name.
Windows, Linux and macOS machines all take runs. The OS (`windows`, `linux`, `macos`) is optional:
without it, it is what that termhub reports (`/api/info`), else the shape of `reposRoot`
(`C:\…` or `/…`). A configured OS that its termhub contradicts, or a `reposRoot` written for the
other OS, is refused rather than guessed around. `pa doctor` shows each machine's reachability,
OS and whether its termhub can run commands. A factory job on any of them
can be followed (next section).

A run's worktree is trusted ahead of time (the worktrees root is marked trusted in `~/.claude.json`, `src/dispatch/trust.ts`), so Claude never stops at its folder-trust question; if the question shows anyway, the cursor is moved to *Yes* first, since newer Claude Code puts it on *No, exit*.

The dispatcher cannot touch that disk, so it has that machine's termhub run the setup —
`POST /api/exec`, one command at a time, argv arrays with no shell, each exit code checked
(`src/dispatch/exec.ts`) — and checks the result through termhub's API before starting Claude:
`git fetch`, a worktree under `<reposRoot>/.pa-worktrees/run-<id>` (backslashes on Windows) on
branch `pa/<id>-…`, and `BRIEF.md` written from stdin and its size read back. For a mode that may
not push, every remote's pushurl is set to the dead address **in the worktree's own config**
(`extensions.worktreeConfig`, so the main checkout and other runs still push), then read back: the
run's worktree must report the dead address and the main checkout must not, or the run fails. The
session is opened in the worktree only once `/api/dirs` shows it there.

A machine whose termhub predates `/api/exec` gets the old way — the same steps typed into a fresh
shell (PowerShell on Windows, POSIX `sh` elsewhere), the session left open to show why if the
worktree never appears — but only for `branch`, `mr` and `full`. A typed push block can't be read
back, so a `plan` or `local` run there is refused until termhub on that machine is updated.

The same primitive is available to other code: `runCommand(machine | null, argv, {cwd, timeoutMs})`
→ `{code, stdout, stderr}` in `src/dispatch/exec.ts` (`null` is this machine). A timeout is code
124, a missing program 127; it rejects only when the command could not be put to the machine at
all (unknown name, termhub down or too old). `pa say`, `pa attach`, `pa runs` and
`pa drop` work as for a local run; `pa review`, `pa diff` and `pa land` run git on this disk, so
for a remote run they point you at the session instead, and `pa drop` leaves the worktree on that
machine for you to remove. **Context** on the dashboard shows the ask, its thread and its runs
before you dispatch.

**Sessions on those machines are ingested too.** Every five minutes the worker reads each
`PA_MACHINES` machine's Claude Code transcripts through its termhub (`GET /api/claude/transcripts`,
read-only; `src/ingest/remoteSessions.js`) and stores them as `claude_session` items exactly as
local ones, with `raw.machine` set, the id and thread prefixed `<machine>:` and the subject ending
`(on <machine>)` — so a remote run's work is evidence like any other. Only new or changed
transcripts touched in the last week are fetched (a first pass once turned a machine's history back to August into 79 stale to-dos); each machine has its own cursor, `claude_session@<machine>`, and a machine
that is off or unreachable is an `ERROR` line on that cursor in `pa doctor`, not a failed pass.
"termhub on X is too old" means that machine's termhub predates the route: run
`termhub/windows/update.ps1` there. `pa sync --source claude_session_remote` runs it by hand.

### Runs in the software factory

The software factory (PM → SM → dev → reviewer → merge gates, its own repo) dispatches and tracks
all work: code, research, reports and read-only plans. Every agent session the PA dispatches is a
factory job (decision D28), so it shows on Build and is metered; there is no route to pick
(`PA_DISPATCH_VIA`, `PA_ROUTE_CHOOSER`, `--via claude` and `--machine` are gone), and without
`PA_FACTORY_PATH` nothing dispatches. `pa do 959` sends the ask as a job. What a start does not
choose comes from the card's dispatch settings (`GET`/`POST /api/commitments/<id>/dispatch-settings`,
`src/dispatch/settings.ts`): runtime `PA_FACTORY_RUNTIME` (claude_session), mode `PA_DISPATCH_MODE`
(full), the job kind decided from the ask, the end state from the factory app's `delivery.default`.
Plan mode is a read-only `plan` job: Claude Code runs in its plan permission mode and the factory
keeps the plan as the job's report (JOBS-API v1.8). The PA never imports factory code: it
runs `uv run factory job …` (`PA_FACTORY_UV` for the full path of `uv`, since termhub's exec has no
login shell) in the factory checkout (`PA_FACTORY_PATH`) on the factory's machine
(`PA_FACTORY_MACHINE`, a `PA_MACHINES` name, or empty for this one) and reads the one JSON object
each command prints — the contract is the factory's `docs/JOBS-API.md`.

- **Kind and runtime per job** (JOBS-API v1.2). `--kind code|research|report|plan` (unset: decided
  from the ask, `factoryCore.inferKind`): a research job answers a question, a report job writes a
  document and a plan job writes a read-only implementation plan; all deliver a markdown
  report the factory keeps (`pa factory report <job>`), need no repo (`--repo owner/name` makes the
  factory read it when registered, else the ask names it), deliver `none`, and send your own words
  as the ask — no composed brief. `--runtime api|claude_session` (default `PA_FACTORY_RUNTIME`,
  claude_session; set it to `api` to put every job not given a runtime on the API models, a plan
  job excepted): the factory's metered model routing, or Claude Code on the factory machine on your
  subscription (each such run is a live termhub session there). Both are recorded on the run
  (sql/031). A factory still on v1 refuses the new flags: a code job on `api` is resent without
  them; anything else fails saying the factory needs updating.

- **The end state is yours** (operator decision 2026-11-02, no ceiling). Every job carries an
  explicit `--delivery`: `none` (committed in the factory's worktree), `branch`, `draft_pr`, `pr`,
  `auto_merge` (merged when its gates and CI pass), `push_to_main` (fast-forwarded onto main when
  its gates pass). Where it comes from, first match wins (`src/dispatch/deliveryCore.ts`):
  `--delivery` or the card's pick; an explicit `--mode` (local → none, branch → branch, mr/full →
  draft_pr); your own words in `--task` ("just open a draft", "merge it", "push straight to main",
  "don't push") — never a third party's message; the repo's default (`pa delivery set owner/name
  <level>`, `pa delivery list`, sql/025); `PA_DELIVERY_DEFAULT` (draft_pr). Since D28 the order is
  (`src/dispatch/settings.ts`): `--delivery` or the start's pick; the card's stored pick; your own
  words in `--task`; the factory app's `delivery.default`; the repo's default; `PA_DELIVERY_DEFAULT`.
  A mode (default `full`) no longer picks the level. Before D28 the same vocabulary drove a Claude
  session: its worktree runs in the mode that level maps to (push_to_main runs as
  `local` — no push credentials in its environment and its push blocked, which stops an accident; an
  agent running as your OS user can still restore them from disk, so the real boundary is a separate
  OS user, not set up yet — `pa doctor` says so) and run review does the rest.
- **The ask is a composed brief** (`src/dispatch/compose.ts`, rules in `composeCore.js`): a model
  (`PA_COMPOSE_MODEL`, any text-capable provider; a bare Claude model with no `ANTHROPIC_API_KEY`
  would cost ~4 s of `claude -p` startup, so set `PA_COMPOSE_FALLBACK_MODEL=azure/<deployment>` — used
  instead whenever its key is present; the log line `compose model call` shows the path and latency) writes the goal, done-criteria, constraints,
  decisions and facts the task needs, and points at **existing files to reuse or extend** — found by
  searching the repo's local checkout (`git ls-files`, `git grep -F`) for the ask's keywords. Every
  brief says: "Search the repo for existing implementations before writing new code; extend rather
  than duplicate; follow existing conventions; add/extend tests." Private material (memory pages,
  message bodies) reaches the model to pick from, never the brief wholesale: a run of 12 words
  copied from it is dropped, a credential is redacted before the model sees it and again after,
  reuse paths must be real files. No model, a model error or no JSON → a deterministic brief with
  your words, the criteria and the code pointers and nothing private. `pa do … --preview` prints the
  brief without sending; the card shows it. Done-criteria: `--done "…"` (repeatable) wins;
  otherwise the commitment's "what done looks like", else the model's.
  `--pipeline chain|solo|auto` (`PA_FACTORY_PIPELINE`, default solo: on the factory's own
  benchmark one agent beat the role chain) and `--model persona=provider/model`
  (repeatable; `PA_FACTORY_MODELS` sets defaults) pass straight through; `--app` names the factory
  app when the repo cannot be read from the commitment; `--register` (or `pa factory add
  owner/name [--delivery-default level]`) registers a repo the factory does not know yet.
- **Submission is idempotent and never leaves a run stuck.** The run id is the job's external id
  (`--source pa --external-id <run>`), so a resubmit returns the same job. A contract error fails
  the run. Anything else after a submit went out — a lost answer after one retry, a crash before
  the job was recorded — is reconciled with the factory (`job status` by id, else `job list --source
  pa` matched by external id): the job is adopted, or the run waits as `submit_unknown` and the
  worker asks again each pass, failing it only once the factory has answered "no such job" for ten
  minutes. A run left `starting` for two minutes is swept the same way.
- **Every code job carries a flow**: the factory's direction validator needs a `flow.md` (or an API spec)
  and parks a job without one as `needs_human`. `factoryCore.flowMarkdown` writes it
  deterministically from the composed goal: numbered steps that restate the ask and turn each
  done-criterion into a "Check:" step. Ask and flow are files on the factory's machine: written
  directly when it is this one, otherwise through `runCommand` by a fixed Python writer that reads
  the contents on stdin and puts them in a fresh private temp dir on that machine (removed once the
  factory has the job). Any `warnings` the
  factory returns are kept on the run (`factory_warnings`), printed by `pa do` / `pa review`, and
  shown on the dashboard.
- **Walking in**: a termhub session on the factory's machine runs `uv run factory job follow <job>`
  in the checkout, titled with the ask; the card's session link and `pa attach` open it.
- **Status comes back** every `PA_FACTORY_ACTIVE_POLL_SECONDS` (5) while a job is queued,
  triaging or in progress, at once when a factory on this machine writes its `state/factory.db`
  (watched, never read; `src/dispatch/factoryPace.ts`), and every `PA_FACTORY_POLL_SECONDS` (120)
  otherwise: one `factory job list --source pa --active`, plus `job status` for jobs that ended
  since. A factory can also push a job's new state (`POST /api/factory/events`, below), which
  Build shows at once; the next pass overwrites it with the full list. A pushed end (done, failed,
  cancelled) also settles its run there and then, through the same per-run step as the pass (the
  stored job under the pushed state): the run closes, the card moves and "Factory run #N" is raised
  within about 20 ms of the push, and the next pass finds nothing left to do. A blocked job makes the run `waiting` and
  tells you why; a finished one is `landed` with its PR on the card and closes the commitment *done*
  through the ledger (actor `factory`); a failed or cancelled one reopens it. `none` delivery
  closes nothing — the work is in the factory, and the ask stays dispatched until you close it.
  GitHub reconcile only closes `open` asks, so a merged factory PR is never closed twice.
  The same pass then stores the factory's whole `job list` (sql/031 `factory_board`) for the
  **Factory** page and `pa factory jobs`, and notifies you when any job — yours from the PA or
  not — is done, needs you, failed, or has a PR whose CI turned red (a job a PA run submitted
  has its end and waits announced by the run, and only its CI here).
- **One id chain** (plan E1): every poll also stores each PR the job opened (number, state, CI;
  sql/033 `run_pr`) and each agent step with its live session (`run_step`: the factory's step id,
  story, termhub session id and URL), and every session the PA or the factory starts in termhub
  carries `links` (card, run, job, step). So a card shows run → job → steps → PRs as links (Plan),
  a job links back to its card and to each step's session (Build, `factory#job=<id>`), a terminal
  links to its card and job (Run, `#card-<id>`), and the `card`, `factory_job` and `sessions` chat
  tools return the same ids, none of it read off a title.
- `pa review <run>` shows the job, its stories and PRs; `pa drop <run>` cancels the job (the factory
  keeps its evidence) and reopens the ask; `pa land`, `pa diff` and `pa say` refuse — the factory
  delivers and is steered on its own side.

**Telling the PA chat**: it picks the end state from what you said, the kind, pipeline and
models, and either starts it (`pa do`, behind a permission
prompt; or the `factory_start` / `session_start` tools below) or puts it on a card (`pa propose`,
which starts nothing). Accepting a card from the chat
(`pa answer <id> yes [--delivery level]`), `pa delivery set` and `pa factory add` ask first.

**Jarvis as coordinator**: the chat works every layer through structured MCP tools
(`src/mcp/chatTools.js`, listed only for the chat), one call each and compact JSON back. Reads run
without a prompt: `board` (today's to-dos grouped todo / blocked / unblocked / looks done, with ids,
who, due, repo, blockers, live run), `card <id>` (one card's full context: source excerpt, links,
blockers, runs, offers), `factory_jobs` / `factory_job <job>` (state, PRs, CI, cost,
subscription-equivalent, report excerpt, follow link) and `sessions` (termhub). Actions ask on every
call: `factory_start` (from a card and/or your words; the brief is composed server-side from the
card's context; runtime `claude_session` unless you ask for the API or name an API model; the end state
from your words), `factory_continue` (a new job on an existing `--branch` / `--pr`), `factory_resume`,
`factory_cancel`, `factory_approve` and `session_start` (Claude Code briefed with your prompt: a
`claude_session` factory job like any other, `mode: plan` a read-only plan job). They
are `pa do` / `pa factory …` in-process — an end state that merges or pushes to main still becomes a
card. "What are my tasks today?" → `board`; "start on that one, PR ready to merge, CI green" →
`factory_start {card, delivery: pr, done: [...]}` → one prompt in termhub.

The same reads are `pa` tool verbs (`pa factory jobs`, `pa factory status <job>`, `pa factory report
<job>`), and the shell forms still work behind a prompt: `pa factory
submit --title … --ask … --kind code|research|report --runtime api|claude_session [--repo
owner/name] [--delivery level] [--done …]` puts a **code** job on a card you accept — it never
starts one — and starts a **research or report** job at once only when you asked the chat for it
(else `--card`); `pa factory cancel <job>` (a PA run's job is dropped through `pa drop`) and `pa
factory approve <job>` (only the `factory approve-direction` the job's own warning names).

**No routing rule any more** (D28): every dispatch is a factory job. The job kind is decided from
the ask (`factoryCore.inferKind`, deterministic: plan mode is `plan`; the planner's *coding* is
`code` and *investigate* is `research`; then the words — write a document → `report`, change
something → `code`, a question → `research`; else `code`), and a code job's repo the factory does
not know yet is registered with it first (`factory app add`).

**Which route works** is measured: every run records its route, the reason, the ask's kind, and its
outcome (`delivered`, `merged`, `failed`, `dropped`); factory runs add pipeline, delivery, models,
job id and the factory's reported cost (sql/024). `pa runs stats [--days 90]` prints success rate
and cost per route × kind. `pa doctor` checks the factory answers and lists its apps.

### Secrets and sign-ins

When the assistant — or an agent through MCP — needs a credential, it asks; you never hand-edit
`.env`. A request appears at the top of the dashboard under **Needs a credential or sign-in** (with a badge on the
Today tab and a desktop notification): what is needed, why, where to get it, and where the value
will be stored. Paste it into the password box and press **Save**.

The value goes from your browser over loopback straight into the OS keyring — **Windows Credential
Manager** on Windows (DPAPI, your Windows account only; listed under *Web Credentials* →
`personal-assistant`), the **Secret Service** on Linux (GNOME Keyring or KWallet through
`secret-tool`, unlocked with your login; Seahorse lists the entries as `personal-assistant: NAME`) —
or —
for non-secret config, or if you pick it — into the gitignored `personal-assistant/.env`, which
is refused if git does not ignore it. The reply says where it went, never what it was: no
endpoint, log line, MCP result or model ever sees a value, and there is no "show" button.

```
pa secret list                  names, where each is stored, when it was set — never values
pa secret set PA_JIRA_API_TOKEN hidden prompt (or piped stdin); replaces an existing one
pa secret request NAME --purpose "why" [--hint "…"] [--url https://…]
pa secret delete NAME
```

Either way the value reaches the keyring process on stdin, never on its command line. A Linux box
with no Secret Service (no `libsecret-tools`, or no session bus — a bare server) has no keyring:
`pa doctor` shows `secret store … DEGRADED`, the dashboard offers only `.env`, and secrets are read
from the environment and `.env`. A keyring that hangs (locked, nobody to unlock it) is skipped for
ten minutes after one timeout rather than stalling every lookup.

Code reads a secret with `secret(name)` from `src/config.js`: real environment → the OS keyring →
`.env`. Code that finds one missing calls `requestSecret({name, purpose, hint})`
(`src/secrets`); agents call the MCP tool `request_secret`, and `secret_status` tells them whether
it is configured — never what it is. Sign-ins the tool cannot do for you (re-authenticating a
connector in `/mcp`, `gh auth refresh -s read:project`) are the same kind of request with a
command to copy and a **Done** button; `pa doctor` opens them for failing checks and closes them
when the check passes.

### Routines

Recurring actions you describe in plain words. Unlike memory, which only stores beliefs, a routine
**changes things on this machine** on a schedule — so it can only run a *typed* action from a
fixed registry (`src/routines/actions`), never a shell string.

```
pa routine add "every weekday at 8 pull main on all repos"
  Weekdays 08:00 — Pull main on every repo under C:\repos that is clean, on its default branch, …
  next: Fri 08:00 · Mon 08:00 · Tue 08:00
  Save this routine? [y/N]
pa routine list | run <id> [--dry-run] | pause | resume | delete | history | suggest | actions
```

A model reads your words into `{schedule, action, params}`, choosing only from the registry; you
see the plain-words version and the next three runs, and nothing is saved until you confirm. The
dashboard's **Routines** tab does the same, plus Run now / Dry run, Pause, and the run history.

| Action | Does | Changes the machine |
|---|---|---|
| `repo_sync` | `git fetch --prune` every repo under `PA_REPOS_ROOT` (and one level into non-repo folders); fast-forwards the default branch where it is safe | yes — fetch, and `git merge --ff-only` |
| `prompt_report` | answers a standing question from the profile, the brief and a search; result as a notification | no — the model gets no tools |

`repo_sync` fast-forwards only a repo that is **on** its default branch (`origin/HEAD`, else
main/master), has no uncommitted change, no merge/rebase/cherry-pick in progress, no untracked file
where the update writes, nothing touched in the last 60 minutes, no termhub session or live `pa`
run in it, and is strictly behind. Everything else is fetched and reported — "on feature/x, 3
behind main — left alone". It never switches branches, stashes, resets, or touches a local branch.
The rules are one pure function, `decide(repoState)`, tested case by case. `--dry-run` still
fetches (remote-tracking refs only) unless `--no-fetch`.

The worker checks every minute and runs due routines one at a time. A slot missed while the machine
was off runs once on return, never a backlog. Each run is a `routine_run` row and a notification;
a run with nothing changed is in the feed without a toast.

**Suggestions.** Nightly (after `PA_ROUTINE_SUGGEST_HOUR`, default 03:00) and on
`pa routine suggest`, the assistant reads memory claims about you of kind workflow/preference and
asks you repeated across days in your Claude sessions, and proposes at most three routines, each
with a one-line why citing the evidence ids. They arrive as `proposed` — never enabled until you
accept — and a rejected one is never proposed again.

### Attention: pushes, digests and your thumbs

Everything the assistant says lands in **From the assistant** on the Today tab. Whether it also
*interrupts* you is decided by the interrupt budget (`src/notify/budget.js`, pure and tested):

| Priority | Pushed (toast + PA chat) when | Otherwise |
|---|---|---|
| `urgent` — a meeting starting within 30 min, a credential something is blocked on | always, except in quiet hours | the next digest |
| `normal` — everything else | fewer than `PA_PUSH_BUDGET` (4) pushes so far today, and its kind's weight ≥ 0.5 | the next digest |
| `digest` | never | the next digest |

Quiet hours are `PA_QUIET_HOURS` (default `19-08`, local; `off` for none). Every push counts
against the budget, urgent ones included. A notification with the same dedupe key as an earlier one
is never sent again, so nothing is announced twice without something new behind it.

**A new ask** (kind `new_ask`, `src/notify/newAsk.ts`): when the distiller writes something you owe
(confidence 0.5 or more) from someone else's message under three hours old, or from a note you wrote
in your Teams self chat, you hear of it once per message. A Teams DM, the self chat or a message that
names you is `normal`; anything else (a group chat, mail, GitHub, Jira) is `digest`, so a day of
review requests does not spend the budget.

**Digests** come at `PA_DIGEST_TIMES` (default `09:00,14:00`): one toast and one feed row with what
the assistant closed for you since the last one (`pa ledger undo` takes any of them back), the
"Looks done?" proposals waiting, people you are waiting on who are overdue or have had it more than
three days, and whatever the budget held back. The text is built from queries, so it costs no
model call. A slot missed while the worker was down runs once when it comes back, never as a
backlog. `pa notify digest` shows what the next one would say.

**Thumbs.** Each feed row has 👍/👎 (or `pa notify feedback <id> up|down|clear`). A thumb moves the
weight of that kind of notification by ×1.25 or ÷1.25, bounded to 0.2–2: four downs and a kind waits
for the digest instead of pushing, six and it stays in the feed alone; ups bring it back. Weights
are per kind, and `info` notifications are split by what they are about (`info:run-wait`,
`info:low-disk`, …) so muting one does not mute the others. `pa notify weights` lists them.

**Where a push shows.** On Windows, a toast (WinRT through PowerShell). On Linux, `notify-send`:
clicking it opens the link where libnotify supports actions (0.7.10+), otherwise it is shown
unclickable — `pa doctor` says which. On a box with no desktop (a headless server), set the
`PA_NTFY_TOPIC` secret and pushes go to [ntfy](https://ntfy.sh) instead (`PA_NTFY=fallback`, the
default; `always` sends both; `off`). The topic *is* the password on ntfy.sh, so it is a secret
(`pa secret set PA_NTFY_TOPIC`), and only titles are sent unless `PA_NTFY_BODY=1` — a brief's body
quotes your mail. `PA_NTFY_SERVER` points at your own server.

## Always-on capture

Two streams, captured separately and never mixed: the **microphone** is you, the **system
loopback** is everyone else. That is what gives speaker attribution with no diarization model
and no misattributed quotes — and it works whether or not your tenant ever allows Teams
transcripts, because nothing joins the meeting.

Raw audio is written continuously (flushed every second) in 15-minute files and trimmed after
each one, rather than gated live by a VAD: a VAD bug then costs a bloated file instead of the
first three seconds of every sentence. A file is the unit of loss, so it is kept small, and the
pass is built not to lose one: a file whose capture died mid-slot (crash, reboot, power cut) is
recovered and its header repaired from the PCM on disk; a file whose transcription fails (the
transcriber is down) is left unprocessed, retried every five minutes, and its raw audio kept
until it succeeds. `pa doctor` shows a backlog of untranscribed files. Speech groups
are transcribed through voice-dictation's already-warm faster-whisper server, so there is no
second model and no GPU contention with the dictation hotkey.

A file is named by when its audio starts: `YYYYMMDDTHHMM.wav` on a slot boundary, with seconds
(`…THHMMSS.wav`) when it opens mid-slot — an early roll, a device change, an unpause — and never
reuses a name, so a reopen can no longer empty a finished file (`audio/naming.py`). Episodes grow
in place as later files arrive, and a conversation that runs straight from one calendar meeting
into the next is cut at the second one's start, so each meeting gets its own episode and link.

Capture records during meetings, not all day. Recording every second fed the transcriber
music, videos and an empty room — a CPU core and a slice of the GPU from login to shutdown — so
the worker's **meeting gate** (`src/audio/gate.ts`) keeps the recorders paused, holding no
device, except while a calendar meeting with other people in it is on (from two minutes before
its start to five after its end) or another app holds the microphone. The second is the
unplanned call: a Teams ring, a Zoom link in chat, a Meet tab. Windows records which app holds
the mic, and the gate reads that every 20 s; our own recorder and voice-dictation (Python) do
not count, nor do dictation apps (`PA_AUDIO_GATE_IGNORE_APPS`, default Wispr Flow and
voice-dictation's folder), nor the browser the voice page (`/talk`) is listening in while it
says so (`POST /api/talk/mic` every 20 s). After a call lets go it waits two minutes before
pausing, so a dropped call that rejoins stays one recording. `PA_AUDIO_MEETING_GATE=0` goes back
to always-on.

**Only conversations with someone else in them are kept.** Your push-to-talk dictation while
coding, a conversation with Jarvis and Jarvis's replies on the speakers are already in your
sessions; they are not meetings. Three logs say when they happened (`src/audio/selfSpeech.ts`):
voice-dictation's transcribe server writes one line per request (`speech-activity.jsonl` in its
data dir, `PA_DICTATION_LOG`; times and lengths, no text) — every dictation path goes through it —
the voice page logs its turns and spoken replies (`talk-activity.jsonl`), and the gate logs the
apps it counted as a call while they held the mic (`mic-calls.jsonl`). A speech group that is
mostly inside your dictation or the voice page is dropped before episodes are made. An episode
heard only through the mic is a call only when a call app held the mic during it (the far end
on the speakers), or a meeting when it overlaps a calendar meeting with other people in it;
otherwise it is you alone (`solo`) and is not stored — no transcript item, no debrief — and its
sidecars and speech audio are deleted once `PA_AUDIO_SOLO_SETTLE_MINUTES` (30) have passed and
transcription has moved past it. Recordings filed as meetings before this, `pa meeting solo`
lists (read-only) and `pa meeting solo --apply` removes.

The mic stream records **the mic the call is using**, not Windows' default recording device:
Teams talks through the headset while the default stays the laptop array, and that once
recorded a whole stand-up of your own words as silence. Capture asks Windows which capture
device another app (Teams, Zoom, a browser — anything but Python) is actively recording from
and records that one; with no call, it takes a mic whose name matches `PA_AUDIO_MIC` (default
`headset|hands-free`), else the default device. A Bluetooth headset's mic only appears while a
call holds it open, so capture re-checks every five seconds and switches.

`pa mic pause 30` releases the device handle outright — it stops capture, not merely
transcription — and the gate never lifts it, meeting or not. `pa mic on` between meetings
records until the next meeting ends. Your own Claude Code sessions are captured from their transcripts on disk rather
than from audio, because the exact text is already there.

**On Linux** capture records through PipeWire or PulseAudio (the same `soundcard` library; PipeWire
serves it through pipewire-pulse). The loopback stream is the default sink's **monitor source** —
what the speakers play — and follows the default output device the same way. "Which mic is the
call using" and the gate's "another app holds the mic" both come from `pactl list source-outputs`:
a recording stream that is not Python, not a level meter, and not reading a monitor. A muted call
still counts, as it does on Windows. Without `pactl` the gate falls back to calendar meetings only
and the mic to `PA_AUDIO_MIC` / the default — `pa doctor` says `sound server … DEGRADED`. The two
streams run as systemd user units, `pa-capture@mic` and `pa-capture@loopback`
(`linux/install.sh`); the watchdog restarts them with `systemctl --user restart`, and never
restarts a unit that was not installed.

A recorder can be running and recording nothing — when the disk filled, the call-audio recorder
sat on an empty file for twelve minutes while its task said "Running". So the worker checks every
minute that each stream's spool is still *growing*; one that has been silent for two minutes (and
is not paused) is killed and restarted, and you get a notification. It also warns once an hour
while the spool's drive has less than `PA_LOW_DISK_GB` (default 5) free.

## Eval

Every change to retrieval or memory is judged by `pa eval`, not by how a few searches feel. Public
memory benchmarks are self-reported and don't transfer to your own mail, so the cases are built
from it. The question types follow LongMemEval: single-session lookup, multi-session aggregation,
temporal, knowledge update, and abstention.

```
pa eval seed --n 60          # the model writes realistic questions about sampled items; the item is the gold
pa eval list -v              # read them; `pa eval drop <id>` the bad ones
pa eval add "where did we land on the export retries?" --gold 4812   # log a real miss
pa eval run [--retriever search] [--k 10] [--judge] [--misses]
```

`run` prints R@5, R@10, MRR and nDCG per question type. It stores the run in `eval_run` and shows
the change from the previous run of the same retriever. Abstention cases have no gold. They pass
when the retriever's top score stays under its threshold, and the raw top score is kept so the
threshold can be calibrated. `--judge` also answers each question from the top-k items with the
model and grades the answer. It's slow, so it's occasional. The worker runs the cheap
deterministic eval once a day.

The cases are real questions about real mail, so **they live in the database only**: never in
fixtures, tests or commits. A new retriever is one `register(...)` line in
`src/eval/retrievers.ts`. `--retriever search-fused` runs search with the reranker off, to
measure what the reranker adds.

## Backup and recovery

The database is the only copy of what the assistant knows — transcripts whose audio is long
deleted, and mail and Teams history the connectors will not hand back past their own limits. The
worker dumps it (`pg_dump`, custom format) once a day to `backups` under the data folder
(`%LOCALAPPDATA%\personal-assistant\backups` on Windows, `~/.local/share/personal-assistant/backups`
on Linux) and keeps the newest 14 (`PA_BACKUP_DIR`, `PA_BACKUP_KEEP`). Where `pg_dump` runs follows
where the store runs (`PA_PG_TOOLS`): `wsl:<distro>` on Windows, `native` for a native Linux
cluster, `docker:pa-postgres` for the compose container — whose own `pg_dump` always matches the
server, its output streamed to the file. `pa doctor` flags a native `pg_dump` older than the server
before the nightly dump finds out. `pa doctor` shows the age of the newest one.

**Backups are encrypted.** Each one is a single `pa-<stamp>.pabak`: the `pg_dump`, the factory's
`state/` directory (when the factory runs on this machine; logs and locks left out) and a manifest
of table row counts, in one tar sealed with AES-256-GCM. The key is the `PA_BACKUP_KEY` secret in
the OS keychain (labelled by stack); the first backup generates it. **Copy it off the machine** with
`pa backup key export --to <new file>` (mode 600, never printed) and keep that somewhere safe:
without it a backup is unreadable, and the keychain goes with the machine. A machine with no
keychain still writes a plain `.dump` and logs a warning; `pa restore` reads both.

**Restore drill.** An untested backup is a hope. `pa backup restore --to pa_drill` decrypts the
newest backup, restores it into a throwaway database `pa_drill`, compares every table's row count
with the manifest (2% or 10 rows of slack: the store keeps writing while it dumps), checks the
factory state came back, and drops the database. It never touches the live store. It needs a role
that may `CREATE DATABASE` and either the `vector`/`pg_trgm` extensions creatable by it
(`--admin-url postgres://<superuser>@host:port/postgres`) or a `--template <database>` that already
has them. Run it once per stack after setting up, and after any change to the backup path. Exit
code 1 on a mismatch.

```
pa backup                 dump now (encrypted; --plain to skip)
pa backup list            what is there
pa backup restore --to <scratch>   the drill: restore into a throwaway database and verify
pa backup key init | export --to <file>   the backup key
pa restore [file]         replace the store with a dump (newest by default); asks first
pa reingest --days 180    no dump? rewind the sources and fetch history again
```

**Rebuilding on a new or wiped machine:** run `windows/install.ps1` (or just
`windows/setup-wsl-postgres.sh` in WSL), or `linux/install.sh` on Linux, to get an empty database
with its extensions, copy the
backups folder back, stop the worker, `pa restore`, start the worker. Restore needs the
extensions to exist and refuses otherwise; it leaves them out of the dump on purpose.

**With no dump**, `pa reingest --days N` rewinds the Microsoft 365, GitHub and Jira cursors so the
next passes re-fetch that window — how far back you actually get is each source's limit. Claude
sessions and audio transcripts on disk are re-scanned on their own. Re-ingest is an upsert:
running it over data that is still there costs fetches, not duplicates. Distillation, embeddings
and memory then rebuild from the items by themselves.

## Models and providers

Every pass that calls a model picks it with its own variable, and the value is a **model string**
(`src/models.js`):

| String | Goes to |
|---|---|
| `claude-sonnet-5-5` (bare) | the Anthropic API when `ANTHROPIC_API_KEY` is set, else `claude -p` — the original meaning |
| `anthropic/claude-sonnet-5-5` | the Anthropic API, always |
| `cli/claude-opus-5` | a headless `claude -p`, always |
| `azure/<deployment>` | Azure OpenAI chat completions on `AZURE_OPENAI_ENDPOINT` (or `PA_AZURE_CHAT_ENDPOINT`), key `AZURE_OPENAI_API_KEY` |
| `openai/<model>` | OpenAI (`OPENAI_API_KEY`, `OPENAI_BASE_URL`) |
| `openrouter/<vendor>/<model>` | OpenRouter (`OPENROUTER_API_KEY`) |
| `deepseek/<model>` | DeepSeek (`DEEPSEEK_API_KEY`) |
| `local/<model>` | any OpenAI-compatible server at `PA_LOCAL_LLM_URL` |

Only the first segment is the provider; an unknown one is an error, not a bare name. `PA_MODEL`
sets one default for every pass that has no variable of its own. Per pass: `PA_DISTILL_MODEL`,
`PA_MEMORY_EXTRACT_MODEL`, `PA_MEMORY_DECIDE_MODEL` (also recall planning), `PA_MEMORY_PAGE_MODEL`,
`PA_BRIEF_MODEL`, `PA_BRIEF_CLASSIFY_MODEL`, `PA_DEBRIEF_MODEL`, `PA_REPLY_CLOSE_MODEL`,
`PA_RECONCILE_MODEL`, `PA_CARD_CONTEXT_MODEL` (default: the reconcile model), `PA_PLANNER_MODEL`,
`PA_DEDUPE_MODEL` (the cross-thread duplicate judge, default `azure/pa`),
`PA_DRAFT_MODEL` and `PA_EVAL_MODEL` (default: the distill model), `PA_ROUTINE_MODEL`, and
`PA_FAST_MODEL` (the voice fast lane, default `local/llama3.2:3b` in Ollama) with
`PA_FAST_FALLBACK_MODEL` (default `azure/pa`) when the local model is down; see "Talking to it by voice".

The fast lane streams its reply (`llm.stream()`): token by token on the Anthropic API and the
OpenAI-compatible providers, and through `claude -p --output-format stream-json
--include-partial-messages` on the CLI backend, which works but pays a process start per call.
A `local/` call that asks for a JSON schema (`format`) or a `keepAlive` goes to Ollama's own
`/api/chat` instead of its OpenAI-compatible endpoint, which can carry neither.

**The connector relay is Claude Code only.** Microsoft 365 and the Jira connector fallback are
reached by tool calls to the claude.ai connectors, and only Claude Code holds those logins, so
`PA_CONNECTOR_MODEL` must be a bare Claude name or `cli/…`, and it ignores `PA_MODEL`. Anything else
is refused at the call (with the variable named), logged as an error when the worker starts, and
shown as **NOT capable** in `pa doctor`, which prints one line per pass: model, backend, the
capability it needs (text, json, toolCalls), whether its key is configured.

The PA chat and dispatched runs choose an agent CLI as well as a model — see the next section.

## Talking to it: the PA chat

`pa chat` (or termhub's **PA chat** button) opens one Claude Code session in termhub that *is*
the assistant: ask it anything, tell it what to work on, from any termhub tab or your phone.
It is homed in `%LOCALAPPDATA%\personal-assistant\pa-home`, whose `CLAUDE.md` makes it the PA and
whose SessionStart hook loads `pa context` — your profile, today's brief, what is waiting on you —
at every start, resume and compaction, so a long-running chat stays current without carrying
history. It answers through the MCP tools (`recall`, `memory_page`, …) and acts through the `pa`
CLI, and reaches the board, the factory and termhub through structured tools (`board`, `card`,
`factory_jobs`, `factory_start`, `session_start`, … — see "Jarvis as coordinator"): reads run freely;
starting a run or job, landing, steering, closing,
remembering and adding routines each ask you first. One write needs no prompt: when you tell it
"create a task…" it adds one with its `task_add` tool (the same code as `pa task add`; Dismiss undoes
it) — and only then, never for its own work. Put your own standing instructions in
`pa-home\CLAUDE.local.md`.

**Claude Code or opencode.** `PA_CHAT_AGENT=opencode` runs the chat in
[opencode](https://opencode.ai) instead, on any provider opencode is set up for, with
`PA_CHAT_MODEL` in opencode's `provider/model` form (`PA_CHAT_MODEL` on claude takes a Claude
model). The same rules apply: pa writes `pa-home\opencode.json` and `AGENTS.md` from the same
command lists as Claude's `settings.json`, starting from "ask for everything" (opencode's own
defaults allow nearly everything), denying subagents, and asking for any command with a redirect.
Before it starts an opencode chat, pa asks the installed opencode for the rules it actually
resolved (`opencode debug agent`) for every agent you can switch to, and refuses to start if any
action that must ask would not. Neither CLI may be started with permissions skipped
(`--dangerously-skip-permissions`, `--auto`): `pa chat` and `pa doctor` refuse. opencode has no
SessionStart hook, so its `AGENTS.md` tells it to run `pa context` first, and **the doorbell below
never rings for it** — its screen is not Claude's, so the chat reads `INBOX.md` on your next turn.

Dispatched runs choose too: `PA_DISPATCH_AGENT` / `PA_DISPATCH_MODEL`, or `pa do … --agent
opencode --model azure/gpt-5.4` for one run. An opencode run starts as `opencode --auto` with the
opening prompt on its command line (nothing is typed at it); the run's mode limits are enforced by
the dispatcher either way. Runs on another machine start that machine's `claude`.

Work you hand it runs as an ordinary dispatch: its own termhub session and worktree. When that
session has been sitting at its prompt for a minute — finished, or stopped to ask something — you
get a notification that opens it; when it ends, another. The dashboard is also reachable through
termhub at `/pa/` (the **PA** button), so all of this works away from the desk.

**The assistant speaks first here too.** Every push is also written to `pa-home\INBOX.md` (the
unread pushes of the last two days), and the chat's `CLAUDE.md` tells it to read that file at the
start of every turn, tell you what is new, and offer the `pa` command that answers it — so you
answer in place: "yes, close it" becomes `pa ledger looks-done 33 --yes`. When the session is
provably idle, the worker also rings the bell by typing one fixed line,
`PA inbox: notification 123 is waiting. Read INBOX.md.`, and pressing Enter. Two rules make that
safe (`src/notify/chat.js`):

- **The typed line carries no content.** Typed text is a prompt with *your* authority, and
  notification titles quote other people; in `INBOX.md` the same words are data the chat is told
  never to obey.
- **It is typed only when nothing can go wrong with Enter**: termhub says the session is Claude Code and finished its
  turn (not working, not parked on a permission prompt or question), it has been quiet for
  `PA_CHAT_NUDGE_IDLE_MINUTES` (2), and the screen's input box is empty with nothing unexplained
  after it. Any doubt and the nudge is skipped — the toast still goes and the chat reads the inbox
  on your next turn. A skipped nudge costs minutes; Enter on a half-typed line, or on a permission
  prompt, would cost far more. `PA_CHAT_NUDGE=0` turns the nudge off.

`pa notify ack <id>` takes one off the inbox (the chat may run it freely); `pa notify feedback`
asks first, because it changes how often you are interrupted.

### Talking to it by voice

<http://127.0.0.1:7300/talk> is the same chat with no keyboard: you say "hey Jarvis", ask, it
answers out loud, and the work happens in the background. A small ASCII face shows what it is doing
(asleep, awake, listening, thinking, talking, pleased when it finishes, worried when something is
down), with the latest tool step in small print under it. The navigation in the » panel (below)
drills down to the cards and the chat in text, then termhub, then the PA chat's session on its own.

Everything runs on this machine. What runs where:

| Piece | Where | What |
|---|---|---|
| Wake word, VAD | the page (onnxruntime-web, WASM) | openWakeWord "hey jarvis"; Silero VAD v5 |
| End of turn | voice service, 127.0.0.1:47830 | smart-turn v3.2 (CPU ONNX) |
| Transcription | voice-dictation, 127.0.0.1:47821 | faster-whisper `small` fp16 (unchanged) |
| System 1 | Ollama, 127.0.0.1:11434 | Llama 3.2 3B, forced JSON |
| System 2 | termhub session | the PA chat (Claude Code) |
| Voice | voice service, 127.0.0.1:47830 | Kokoro-82M on the GPU (PyTorch CUDA), 24 kHz |

The page reaches every server piece through the PA (`/api/talk/…`, X-PA guarded), so it works the
same through termhub's `/pa/` proxy from a phone.

- **Wake word.** With **Wake word** on (the default at a desk; off on phones) the page listens for
  "hey Jarvis" and nothing else: no transcription, nothing leaves the browser. Heard: a short chime,
  the face wakes, and the next thing you say is the request. After the answer it stays in the
  conversation for 8 s, so a follow-up needs no wake word; then it goes back to sleep. "Stop",
  "thanks Jarvis", "that's all" end it at once. Space (hold) or the button talks without the wake
  word, always. The model is openWakeWord's pre-trained `hey_jarvis` (Apache-2.0): three small ONNX
  models per 80 ms of audio, measured at 7.6 ms median (p90 11.6 ms) per 80 ms frame in Edge on this
  laptop, about 10% of one core, and only while asleep. With the wake word off the page is
  hands-free as before (every utterance is a request), or push-to-talk.
- **End of turn.** Silero VAD (0.9 ms per 32 ms frame in the page) says where speech is. At the first
  200 ms pause (96 ms when every frame of it is confidently silent, Silero under 0.1) the page asks smart-turn (`POST /api/talk/endpoint`, the last 8 s of the utterance)
  whether you sound finished, and sends the utterance so far to `POST /api/talk/transcribe` at the
  same moment: yes ends the turn there, ~450 ms after you stopped, with that transcription (whisper's
  time overlaps smart-turn's); no keeps waiting up to **Pause before sending** (650 ms default,
  400–1500 in **settings**) and transcribes again. Untick **Smart end of
  turn** to use the timer alone. Without the models (not installed) the energy VAD does the job, as
  before. *Why smart-turn is in the service and the wake word and VAD in the page:* termhub's `/pa/`
  proxy passes only plain HTTP, no WebSocket upgrades, so a phone cannot stream audio to the service
  continuously; the wake word must run all the time and must not ship the room's audio anywhere, so
  it runs where the mic is. Smart-turn runs once per pause on a few seconds of audio: one HTTP POST
  (~100–250 ms round trip here) costs less than running it in WASM, and keeps the Whisper feature
  extraction byte-for-byte the model's own.
- **Transcription** reuses voice-dictation's warm faster-whisper server (`PA_TRANSCRIBE_HOST` /
  `PA_TRANSCRIBE_PORT`, as capture does): the page sends a 16 kHz WAV to `POST /api/talk/transcribe`,
  which writes it to a temp file, hands the path to the server, and deletes the file. Whisper's
  stock filler for silence ("Thank you.", "you") is dropped, and so is a leading "Jarvis". The
  server unloads its model after half an hour idle and takes ~6 s to load it, so the PA hands it a
  quarter second of silence when `/talk` opens. When you start speaking (`POST /api/talk/warm`,
  which also clocks up the GPU voice) it hands it that silence every 400 ms until the end-of-turn
  check or the transcription arrives (10 s at most): the laptop GPU clocks down within seconds, and a
  transcription after a pause took 530–800 ms against ~250–480 ms with the pings. The text then goes to the fast lane (next bullet), which hands
  it to `/api/chat` with `source: "voice"` when the PA chat is needed. While the chat is parked on a
  permission prompt or question, the chat refuses the send (409); the page says once that it is
  waiting on an answer in termhub — naming the action from the last tool call ("waiting for your yes in
  termhub: starting a factory job: card 412 (claude_session, pr)") — and does not retry. When the prompt is
  for one of the chat's own actions (`factory_start`, `session_start`, …), Jarvis asks out loud —
  "Start a factory job for card 412 on your subscription, opening a PR for review. Shall I?" — and
  your next words answer it: "yes", "do it", "go ahead" approve; "no", "cancel", "stop" deny; anything
  else is asked once more, then left on the dashboard. Only while it is awake (after "hey Jarvis", or
  push-to-talk), only from words you began after the question, within a minute. The server then reads
  the session's screen, checks it really is Claude Code's permission prompt for that call, and presses
  Enter on "Yes" (once — never "don't ask again") or Esc. Talk has no buttons; the dashboard shows the
  same prompt as a "Waiting for your yes" card with Approve and Deny. Any other prompt (a shell command,
  an edit) is answered in termhub. "Jarvis, sleep", "stop listening" or "go to sleep" puts it back to
  waiting for the wake word.
- **The fast lane ("System 1", `src/chat/fastLane.js`).** The PA chat takes 3–5 s before it says
  anything; a person answers within a second. So each spoken turn first goes to a quick model
  (`PA_FAST_MODEL`, default `local/llama3.2:3b` in Ollama) that sees a compact snapshot of your day
  (the clock, open asks with the most pressing few, the next day's meetings, live runs, waiting
  drafts — about a kilobyte, rebuilt every `PA_FAST_CONTEXT_SECONDS` (60) in the background) and the
  last six turns. It decides **answer** (small talk, thanks, "what's on today", "how many are
  overdue": it says the whole answer, and nothing goes to the chat), **handoff** (it says a short "on
  it, checking your mail" and your words go to the PA chat, whose answer is spoken when it arrives),
  or **both** (it says what it knows and hands off the rest). Its words stream and are spoken
  sentence by sentence. It **never acts**: it has no tools, and an "answer" to something that reads
  like an action ("send…", "close…", "remind me…") is turned into a handoff before a word is spoken,
  so actions always go through the PA chat's permission prompts. What is handed off is your own
  words, verbatim; the model's reading of the task rides along as a labelled hint, because the
  snapshot quotes other people's mail and must not be able to put words in your mouth. Turns it
  answered itself are not in the PA chat's history (it keeps the last few for its own context).
  - **Local by default.** With `PA_FAST_ROUTER=same`, a `local/` model gets one streamed call to Ollama's own `/api/chat` with
    the decision forced to JSON by a schema (`format`): `{label, route, say}`. The route is known a
    few tokens in, and `say` is spoken while it is still being written. Two guards on top: a request
    the model labels `action` or `deep_task` is never "answered" (it is handed off, its words
    unspoken), and a hand-off's acknowledgement is checked before it is said — "I couldn't find
    anything" or "I've sent it" become "One moment." / "On it.". The model is kept loaded for
    `PA_FAST_KEEP_ALIVE` (24h; 2.6 GB of GPU memory) and loaded when `/talk` opens. When Ollama is
    down, or has not decided within `PA_FAST_LOCAL_TIMEOUT_MS` (2500, a model still loading), the
    turn goes to `PA_FAST_FALLBACK_MODEL` (`azure/pa`, reasoning effort `PA_FAST_EFFORT`, low).
    `PA_FAST_JSON=0` sends a local model the text format instead. Pull the model once:
    `ollama pull llama3.2:3b`.
  - Measured (Nov 2026, this laptop, 24 utterances): llama3.2:3b routes 23 of 24 (the miss is a safe
    hand-off), decides in 276 ms median and says its first word at 361 ms. `azure/pa` decides in
    0.4–1.4 s; `cli/claude-haiku-5-5` takes 1.8–3.7 s (a `claude -p` process per turn).
  - **Decide, then speak** (the default, `PA_FAST_ROUTER=logprob`, `src/chat/fastRouter.js`). The
    router writes no words: one call to the local model, one generated token, answering a fixed
    question, "A (answer here), B (hand off, needs a lookup) or C (an action)?". The token's top
    log-probabilities are calibrated (temperature plus a per-class bias) into `p(answer_here)`,
    `p(hand_off)` and `p(action)`. Only when `p(answer_here)` is at least
    `PA_FAST_ANSWER_THRESHOLD` (0.64) does the fast model speak the answer, in a second call.
    Otherwise your words go to the PA chat verbatim with "One moment." ("On it." when an action is
    likelier). Two guards still have the last word: an action-like request is never answered here,
    and neither is a question about a day the snapshot does not hold (the week, the weekend,
    yesterday, a weekday other than today or tomorrow). `pa eval router [--fit] [--misses]` scores
    the router on `src/eval/router-cases.json`: 97 turns, anonymized from the PA chat log and
    including "check my mail from <name>", which the one-call JSON route used to answer itself, and
    "What's on tomorrow?" against "what's on this week?". It reports accuracy, the turns that would
    wrongly be answered here, and latency warm. `--fit` re-fits the calibration and the threshold
    (turns the day guard hands off do not raise it). Nov 2026, this laptop: 91% 3-way accuracy, no
    action or lookup answered here, router p50 58 ms / p95 73 ms warm. `pa eval answerer` checks
    what the answerer then says against `src/eval/answerer-cases.json` (day snapshots built by the
    real formatter, placeholders only): the right day, every meeting, titles said as titles, never
    as who a meeting is "with". The snapshot's calendar runs to the end of tomorrow and names each
    day: "Meetings today (...): none left today.", then tomorrow's, then "Meetings after
    tomorrow: not in this snapshot."
  - `PA_FAST_ROUTER` picks who decides: `logprob` (default with a `local/` model, above), `same`
    (the fast model, in the same streamed call; the default for a hosted model),
    `rules` (a built-in keyword router, no model call), another model string (a JSON-only router
    call, then the fast model writes the words), or an `http(s)://` URL (POSTed `{ text, context,
    history }`, answers the decision JSON). `PA_FAST_LANE=0` turns the fast lane off and the page
    sends straight to `/api/chat` as before. Spend is recorded as `fast-lane`.
- **Speaking** is Kokoro-82M (`voice/server.py`) on the GPU by default, in the British voice
  `bf_isabella` (`PA_VOICE`, or **Voice** in **settings**: 27 English voices, British and American).
  Each sentence is fetched from `POST /api/talk/tts` as it is complete and played through Web Audio
  as the audio streams in, and the next sentence is synthesised while this one plays, so sentences
  follow each other without a gap. First audio 200–400 ms after a sentence is handed over, so the
  fast lane's first piece may end at a clause (a comma, semicolon, colon or dash after four words and 18 characters: "There is one overdue item," then the rest). When the
  service is not running (or fails mid-answer) the page speaks with the browser's best natural
  voice instead (**Speech engine** in **settings**: automatic, Kokoro, or the browser). Code blocks,
  tables and URLs are not read out: it says "the link" or "I put the details on the dashboard"
  instead.
- **The face follows the sound, not the queue.** An engine reports what its audio does: Kokoro its
  loudness every 40 ms (an AnalyserNode), the browser's voices their word boundaries; the mouth
  moves from the audio's start, follows the loudness or opens on each word, and closes between
  words and sentences (`createSpeechSync` in `talk.core.js`). While a sentence is on its way the
  face looks up with its mouth shut ("about to speak").
- **What it says while it works.** A turn is often "let me check" → a tool → the answer. **Speak
  while working** in **settings**: *only on slow turns* (default) holds a step and says it only if
  the turn is still running after 4 s, so quick answers come without chatter and long ones still
  tell you something is happening; *every step*; or *only the answer*. Each block is spoken as
  soon as it arrives.
- **Latency readout.** `/talk?debug=1` shows, per turn, where the time went: the wait for the end of
  turn (and whether smart-turn, the timer or a released button ended it), transcription, the fast
  lane's decision and first token, the voice starting (and Kokoro's time to audio). A hand-off adds
  a line when the PA chat's answer arrives. Measured on this laptop (Nov 2026; headless Edge, a
  synthesized voice through a fake mic, "hey Jarvis" before each of five short questions answered by
  the fast lane; three runs, 14 warm turns): **1.6–2.6 s from the end of speech to the first spoken
  word, median 1.9 s** (one 3.3 s outlier) — end of turn 430–550 ms (smart-turn ended every one),
  transcription 400–760 ms, the local model's first words 300–450 ms, Kokoro 200–400 ms to audio
  (up to 800 ms while the GPU is shared). Hands-free with the wake word off: 2.1–2.5 s. The first
  turn after the transcriber has been idle half an hour paid 6.8 s to load it, which the warm-up now
  starts while you speak. A hand-off said its acknowledgement at 1.8 s and the PA chat's answer
  arrived 6.5 s after the transcript.
- **Barge-in and echo.** Start talking and it stops (a fast reply still streaming is dropped too;
  a hand-off already made stands). While it speaks, a start needs a near-certain voice (Silero 0.85,
  or three times the usual level for the energy VAD) for over a third of a second, so its own voice
  from the speakers is not transcribed; the mic has echo cancellation on. With speakers loud and no
  headset, tick "stop listening" in **settings** to turn barge-in off.

#### Setting up the local voice (once)

```powershell
.\windows\install-voice.ps1      # venv, models, self-test, the pa-voice logon task (started)
ollama pull llama3.2:3b          # the fast lane's model (Ollama must be installed and running)
node bin\pa.js doctor            # "voice Kokoro on cuda, bf_isabella · smart-turn · page models ok"
```

`install-voice.ps1` is idempotent: it creates `%LOCALAPPDATA%\personal-assistant\voice-venv` (uv,
Python 3.12) with PyTorch CUDA 12.8, Kokoro, onnxruntime and transformers; downloads smart-turn
v3.2, Silero VAD, the openWakeWord models and onnxruntime-web into `voice-models` (served to the page
at `/talk/models/`, so no CDN); runs `voice/selftest.py`; and registers `pa-voice`, which runs
`voice/server.py` on 127.0.0.1:47830 at logon. The service opts itself out of Windows' power
throttling (EcoQoS) — background processes otherwise run 5–10× slower on this laptop — and keeps
Kokoro loaded (~0.9 GB of GPU memory). `PA_VOICE_URL=off` turns it off for the PA (browser voices,
silence-only end of turn); `PA_VOICE_MODELS` moves the model folder.

On Linux:

```bash
linux/install-voice.sh           # --cuda for a CUDA 12.8 torch; --no-unit, --no-start
```

The same steps with the CPU build of PyTorch by default (a fifth of the download, and Kokoro on a
16-core CPU still has the first sentence out in about half a second), under
`~/.local/share/personal-assistant/voice-venv` and `voice-models`, then a `pa-voice` systemd user
unit (`linux/pa-voice.service`, rendered by `linux/units.js --voice`), enabled and started.
`voice/selftest.py --device cpu` is its self-test. `server.py` falls back to the CPU on its own
when the venv has CUDA but the driver does not answer.

**No clicks, once.** Browsers start the mic and sound only after a gesture unless the site is
allowed them. To have `/talk` listen as soon as it opens: in Edge open `http://127.0.0.1:7300/talk`,
then **⋯ → Apps → Install this site as an app** (a window of its own, which you can pin and set to
start at logon from `edge://apps`); in that window, the padlock → **Permissions for this site** →
**Microphone: Allow** and **Sound: Allow** (or `edge://settings/content/microphone` and
`…/content/sound`, adding `http://127.0.0.1:7300`). Without those the page shows one **Tap once to
enable Jarvis** button and starts on that tap.

**Phones.** The microphone needs a secure page: `http://127.0.0.1` or `localhost` on this machine is
fine, but the plain-HTTP tailnet address through termhub's `/pa/` proxy is not, so the page can
still speak there but cannot hear. Put termhub behind HTTPS (for example `tailscale serve`, which
gives it a certificate on its `*.ts.net` name) and open `/pa/talk` there. On a touch screen it is
hold-to-talk by default (a large button; the wake word is off), the first tap unlocks audio inside
the gesture before asking for the mic (iOS), the screen stays on while it listens, and coming back
from the background asks for one **Tap to resume**. It shares termhub's one-mic rule (the
BroadcastChannel `voice-mic`, termhub's `voiceCapture.js`, copied as `src/dashboard/voiceCapture.js`):
opening the mic in one takes it from the other, which says so.

### Ask's Text mode and the chat API

Ask (`/talk`) has two modes, switched at the top of its » panel and remembered per browser
(`jarvis.talk.mode`): **Voice** (the face, the default, no buttons) and **Text**, the same
conversation as a transcript with a box to type in (`chat.client.js`). In Text mode a pending
action prompt shows its **Approve** / **Deny** card (`permission.client.js`, the same card as on
Plan). Both modes talk to **the same live session**, not to a new `claude -p` per message, so
typing, speaking, and typing in termhub are one conversation. Enter sends, Shift+Enter is a new
line; the line under the messages shows what it is doing ("searching your history…"), and **open
the session** jumps to it in termhub (`src/chat/feed.js`):

- **In:** the text is typed into the session through termhub (`POST /api/sessions/:id/input`,
  then Return as its own keystroke). No session running? `ensureSession()` starts one and the
  message is typed once Claude is at its prompt, answering the folder-trust question on the way.
- **Out:** the session's own Claude Code transcript, tailed by byte offset:
  `~/.claude/projects/<pa-home with every non-alphanumeric as ->/<uuid>.jsonl`. Only the PA chat
  runs in `pa-home`, so the newest file there is its conversation (a `/clear` starts a new file;
  the newest still wins). Claude Code writes each text block once it is complete, so replies
  arrive whole, a block at a time, not token by token.
- **Timing:** the transcript is read every 200 ms while a turn is running and every second
  otherwise, so a finished block reaches the page within a fifth of a second.
- **State:** termhub's own `idleState` for the session, polled every 2 s while a page is
  listening. The transcript cannot be the authority: a permission prompt or a question writes
  nothing to it until answered. While the session is parked on one, `POST /api/chat` is
  **refused (409)** — typed keys would answer the picker, and Enter picks its highlighted
  option — and an `activity` says to answer it in termhub.

The contract (the voice page depends on it):

| Route | Body / query | Answer |
|---|---|---|
| `POST /api/chat` | `{ "text": string, "source": "typed" \| "voice" }`, header `X-PA: 1` | `{ "id": string }` once the text is typed (or queued, for a session still starting). 400 bad input, 403 no `X-PA`, 409 waiting on an answer in termhub |
| `GET /api/chat/stream` | — | Server-Sent Events; each `data:` is one event (below). No replay: the first event is the current `status`, then live events only. A `: ping` comment every 20 s |
| `GET /api/events?topics=board,run` | `topics` optional (all if absent): `board`, `run`, `factory`, `routine`; `resync` always. `Last-Event-ID` header or `?lastEventId=` | Server-Sent Events of row changes (plan 0.4): each frame has `id:` and a `data:` `{ id, topic, at, payload }`, payload ids and states only (`{ table, op, id, status, … }`, from the triggers in `sql/034_events_notify.sql`). The first frame is `hello` with the newest id; with a Last-Event-ID still in the 1000-event ring the missed events are replayed, otherwise one `resync` frame says refetch. A `: ping` comment every 20 s. Plan, Build and Routines refetch on it (`/events.js`) |
| `POST /api/factory/events` | `{ job_id, state, why?, updated_at? }` or `{ jobs: [...] }` (50 at most), header `X-PA: 1` | A factory pushing job status: merged into the stored job list at once and put on the feed; a done, failed or cancelled job then settles the PA run that holds it (after the answer). `{ ok, received, patched }` |
| `GET /api/chat/history?limit=50` | `limit` 1–500 | `{ "messages": [event…] }`, oldest first, `user` and `assistant` only |
| `GET /api/chat/session` | — | `{ sessionId, status, waitingOn, url }` — `url` opens the session in termhub |
| `POST /api/talk/turn` | `{ "text": string }`, header `X-PA: 1` | The voice fast lane. NDJSON, one event per line: `{ type: "decision", route: "answer" \| "handoff" \| "both", say?, task?, reason, router, ms, p?, routerMs?, overridden? }` (`p`: the `logprob` router's `{ answer_here, hand_off, action }`), then `{ type: "delta", text }`… (words to speak), `{ type: "handoff", id, ms }` or `{ type: "handoff", error, status }` (409: waiting in termhub), and `{ type: "done", route, say, decisionMs, firstTokenMs, ms, model, router }`. 400 bad input, 403 no `X-PA`, 404 `{ disabled: true }` with `PA_FAST_LANE=0` |
| `GET /api/talk/voice` | — | What the local voice offers: `{ tts: { ok, ready, device, error }, turn, voices: [{ id, label, lang }], defaultVoice, models: { vad, wake, ort } }` |
| `POST /api/talk/tts` | `{ "text", "voice"? , "speed"? }`, header `X-PA: 1` | Kokoro speech, streamed: raw 16-bit little-endian PCM, 24 kHz mono (`audio/L16`), `X-First-Ms`. 503 when the voice service is down |
| `POST /api/talk/endpoint` | 16 kHz mono 16-bit PCM (`audio/L16`) or a WAV, header `X-PA: 1` | smart-turn: `{ complete, probability, ms }` |
| `POST /api/talk/warm` | header `X-PA: 1` | 202 at once; clocks the GPU voice up and keeps the transcriber busy until the end-of-turn check (loads it when idle) |
| `POST /api/talk/latency` | `{ total, silence, transcribe, … }` (ms), header `X-PA: 1` | 202; logs one `voice turn latency` line per spoken turn: end of speech to first audio and its slices, no words |
| `GET /talk/models/<name>` | — | The page's models (Silero, openWakeWord, onnxruntime-web) from `PA_VOICE_MODELS`, by fixed name only |

An event is `{ "id", "type", "text", "at" (ISO), "source"? }`:

- `user` — a message to the assistant. One sent through `POST /api/chat` carries that call's `id`
  and its `source`; its echo in the transcript is dropped, so it is seen once. One typed in
  termhub (or the inbox doorbell line) has no `source`.
- `assistant` — a complete block of the reply. A turn can be several (text, a tool, more text),
  each with its own id. On the terminal engine there are no `partial` events: the transcript has
  none to give. On the SDK engine (`PA_CHAT_ENGINE=sdk`) a block streams first as `partial: true`
  events carrying the text so far under the id its complete event will have; partials are not kept
  in history. `final` is `false` on text written before a tool call (the turn goes on) and `true`
  on the answer; absent when the transcript line has no `stop_reason`.
- `activity` — a short line about a tool call ("reading INBOX.md…", "running pa search …"),
  never the tool's whole input.
- `status` — `thinking`, `idle` (the turn is over: speak now) or `offline` (no session; sending
  starts one). It stays `thinking` from a send until termhub has seen the session working or the
  answer has arrived: a session still starting, or still running a prompt hook, reads as idle
  before its turn has begun.

Ids are stable across history and the stream (transcript entry uuids), so a client can load
history and then dedupe the stream against it.

## Wiring it into your agents

- [`integrations/claude-code/`](./integrations/claude-code/) — register the read-only MCP recall
  server so every Claude Code session on this machine reads the same brain.
- [`integrations/openclaw/SKILL.md`](./integrations/openclaw/SKILL.md) — the skill that lets
  OpenClaw drive these same commands from a chat surface.

### One look, four layers

Talk, the dashboard, the factory and termhub are four depths of the same assistant: Jarvis
coordinates, the software factory dispatches and tracks the work, termhub drills into one live
session. They share one design system and one navigation.

The destinations are named for what you do there: **Ask** (Talk, the voice page), **Plan** (the
dashboard), **Build** (the factory), **Run** (termhub's sessions), **Meter** (termhub's agent time)
and **Map** (the architecture page). The older names stay in code, URLs and storage keys; the PA
also answers `/ask`, `/plan`, `/build` and `/map`, and termhub `/run` and `/meter`.

There is no header bar. Each page shows only its one thing, full width (Ask the face, Plan the
board, Build the jobs, Run the terminal), plus a small **»** in the top-left corner.
It opens a panel on the left: first the navigation, **1 Ask · 2 Plan · 3 Build · 4 Run · 5 Meter ·
6 Map** (**Alt+1..6** from anywhere, the terminal included) with
the theme toggle (system → light → dark, remembered per browser), then that page's own controls:
Ask's mode (Voice or Text) and voice settings, Plan's views (Today, Meetings, Memory, Routines, Repos) and
its sources, the Factory's status, spend and New job form, termhub's session list. Closed by
default; on a wide screen the choice is remembered per destination (`jarvis.settings.<id>` in
localStorage), and on a phone the panel slides over the page and always starts closed. The toggle
shows an amber dot when one of the Dashboard's views counts something waiting on you. The names
live in one array at the top of `nav.js` (`DESTS`): renaming a destination is a one-line change.

Switching is instant. The page you loaded is a shell, and every other destination opens in an
iframe laid over it, created on first use (all but Talk are prefetched once the page is idle;
Talk, which may start the microphone, loads when you point at it or go to it) and kept alive. Going
back and forth is a show/hide, and a page you leave keeps running: Talk keeps listening. The URL
is the shell's own plus `?jx=<id>` while another destination shows, so a reload or a shared link
opens the same view and Back/Forward step through the switches. A frame forwards its panel clicks,
its Alt+N and its links to destinations to the top window by `postMessage`, which acts only on
messages from its own frames. Pages are framed only by
their own origin (`Content-Security-Policy: frame-ancestors 'self'` on every PA page; termhub
also allows the PA's origin, whose shell hosts Run and Meter cross-origin on loopback).
Implemented once in `theme.css` (`.jside`, `.jpanel-nav`, `.jx-frames`) and `nav.js`.

- **Ask** is `/talk`, **Plan** is `/`, **Build** is `/factory`, **Map** is `/architecture` (all
  relative, so they work on `http://127.0.0.1:7300` and under termhub's `/pa/` on the tailnet alike).
- **Run** is termhub's hub, **Meter** its `/dashboard`. Under `/pa/` it is the same origin (`/`); on loopback it is the
  origin of the chat session's termhub URL (`GET /api/chat/session`), else `PA_TERMHUB_URL`, else
  `http://127.0.0.1:7000`. termhub's focus view, `/?focus=<id>` (one terminal full-window, no
  termhub chrome), stays as a link target into it — a card's session, a factory run's live session —
  and there the switcher shrinks to a small tab in the corner that opens on hover or a tap.

**The Factory page** (`/factory`, `src/dashboard/factory.ts`, `factory.html`,
`factory.client.js`) shows every factory job — the PA's and anyone else's — grouped **Needs you**
(needs_human, blocked, a live job whose PR's CI is red, or a live job whose app nothing ticks —
JOBS-API v1.6 `ticked: false`, shown as **waiting: app not ticked** in place of its state) /
**Running** / **Delivered** / **Failed or cancelled**: title, kind, runtime, app, state, the PR a
continuation adds commits to (**continues PR #n**, from the job's `base`), and the factory's `why`, each story with its PR
link and CI state, cost metered and subscription-equivalent, a research/report job's excerpt with
**Read report** (`factory job report`, rendered from a parsed tree, never HTML), and its runs with
links to their live termhub sessions. The data is the worker's stored `job list` (sql/031): a page
load never calls the factory; only a click does. Actions: **Cancel** (a PA run's job through `pa
drop`), **Open in termhub** (a session on the factory machine running `uv run factory job follow
<job>`), **Approve** (only on a needs_human job whose own warning names `factory approve-direction`,
and only that one), and **New job** (title, ask, kind, runtime, optional repo, end state; a code job
that would merge or push to main is confirmed on the page, as on a card). In the settings panel: today's PA
model spend (`llm_spend`), the factory's metered spend and the subscription-equivalent of its Claude
Code runs. On the board, a card that can be started shows one quiet line of what **Do** will send
(`Claude · full · draft PR · code (auto)`) and a **☰** beside Do: its menu holds the card's dispatch
settings — runtime, mode, end state, job kind (default: decided from the ask, with the reason) and
repo/app — each marked default, inferred or set on this card, with a reset. A change is saved on
the card at once (`POST /api/commitments/<id>/dispatch-settings`); Do sends nothing of its own.

The colours, type and shapes are tokens in `src/dashboard/theme.css` (served at `/theme.css`);
the switcher is `src/dashboard/nav.js` (`/nav.js`). These are the canonical copies: termhub
carries byte copies in `termhub/web/` so it keeps its look without the PA, and its
`test/theme.test.js` fails until `npm run sync-theme` (in termhub) copies an edit across. The
palette is one block of `--p-*` values that pages never use directly, so a brand palette drops in
by overriding that block alone. Light and dark are one `light-dark()` per token; the terminal stays
dark in both.

## Layout

```
bin/pa.js            the CLI entry point
src/config.js        every knob, resolved once
src/ingest/          Microsoft 365 mail/calendar/Teams (connector), the Teams local cache, GitHub, Jira, Claude sessions (this machine and, through termhub, the others), audio episodes
src/distill/         the extraction prompt, identity resolution, the pass itself
src/projects/        the project ↔ repo table and the scorer that guesses
src/repos/           the repo registry: sources (clones, GitHub, sessions, raven), merge rules (merge.js, pure), profiles
src/search/          hybrid retrieval: full text + vector + people named, fused, Cohere-reranked
src/eval/            retrieval eval: metrics, retriever registry, case seeding, runs
src/memory/          claims with evidence, consolidation, people/project pages, nightly dream
src/recall/          multi-hop recall over items, claims and pages, one rerank
src/brief/           what `pa brief` prints
src/meetings/        pre-meeting briefs: classify, gather evidence, learn from transcripts, notify;
                     post-meeting debriefs (debrief.js, pure half in debriefCore.js)
src/commitments/     closing chat and mail asks you answered yourself (replyClose.js, pure half in replyCloseCore.js);
                     the cause-and-effect paragraph on cards (context.js, pure half in contextCore.js);
                     the cross-thread duplicate pass (dedupe.js, pure half in semantic.js)
                     which sources may create tasks (sourcePolicy.js) and closing what it would not have made (policyClose.js);
                     tasks you ask for (request.js: pa task add, the chat's task_add, the board's + task)
src/dashboard/       the loopback web page: today, next meeting, replies, runs, secret requests, and the Memory, Routines and Repos views; Ask's voice and text page;
                     each card's links to its source, person, repo and session (links.js pure, cards.js);
                     /talk, the voice page (talk.html + talk.page.js; talk.core.js pure; talk.voice.js its onnxruntime-web models and Kokoro playback;
                     voiceCapture.js + micWorklet.js copied from termhub; talk.js serves it and proxies to whisper and the voice service);
                     theme.css + nav.js, the design system and layer switcher every layer shares (canonical; termhub copies them)
src/secrets/         secret and login requests; the OS keyring facade (vault.js; stdin only)
src/platform/        every OS decision: windows.js, linux.js, darwin.js behind one contract (index.js)
src/routines/        cron parser, the typed action registry (repo_sync, prompt_report), runs, suggestions
src/chat/            the PA chat session's home (index.js, agent.js) and its stream for Ask's voice and text modes (feed.js; transcript.js pure); the voice fast lane (fastLane.js)
src/notify/          notifications: toasts, the interrupt budget, digests, feedback weights, the PA chat inbox
src/llm.js           model calls: Anthropic API, `claude -p`, or an OpenAI-compatible provider
src/models.js        model strings, which backend each pass uses, and what it can do (pa doctor)
src/agentCli.js      claude | opencode command lines for the chat (src/chat/agent.js) and runs (src/dispatch/agent.ts)
src/budget.js        model spend: one llm_spend row per call, the daily cap on discretionary work
src/backup.js        nightly pg_dump, restore, re-ingest
src/dispatch/        worktrees, briefs, termhub sessions, modes, landing; the factory route
                     (factory.ts, pure half factoryCore.ts), the routing rule (route.ts, routeCore.ts),
                     `pa runs stats` (stats.ts)
src/draft/           reply drafting, auto-drafts, and delivery links (never sends)
src/mcp/server.js    the recall server: read-only, plus remember and request_secret, which only ask
src/worker.js        the periodic passes
audio/               capture and trim/transcribe (Python); devices_linux.py asks PipeWire/PulseAudio
voice/               the local voice service: Kokoro TTS and smart-turn on 127.0.0.1:47830 (server.py), selftest.py
teams/               the Teams local-cache reader (Python, its own venv)
sql/                 numbered migrations
windows/             install, install-voice (the local voice stack), and the WSL Postgres provisioner
linux/               install.sh, install-voice.sh, the native Postgres provisioner, systemd user units
```

## Related

- [`termhub`](../termhub/) — the session substrate. Dispatch creates termhub sessions because
  it is the only one you can attach to from a phone.
- [`voice-dictation`](../voice-dictation/) — owns the faster-whisper server the audio pass uses.
- [`disk-janitor`](../disk-janitor/) — point it at the audio spool; aged rebuildable data is
  exactly what it is for.
