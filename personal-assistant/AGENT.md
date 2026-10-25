# personal-assistant — working agreement

Read [`PLAN.md`](./PLAN.md) first. This file is the set of things that must stay true no matter
which phase you are in or who is editing.

## Invariants

**Capture is append-only, and raw payloads are kept.** Never let a distillation pass be the
only record of what a message said. Every derived row carries `extracted_by` (prompt/model
version) so history can be re-derived when the prompt improves. Deleting a `source_item` is a
retention action, never a cleanup.

**Nothing is sent without a human.** This tool has no code path that puts a message on the
wire. Drafts — including the ones the worker writes on its own — are delivered by opening them,
already written, in Teams or Outlook (`src/draft/deliver.js`), and the human presses Send there.
`pa send` and the dashboard's Send button both do exactly that and nothing more. If the
connector is ever granted `Mail.Send`/`ChatMessage.Send`, using them is a conversation, not a
patch — and no worker, cron job, skill or agent may ever trigger a send.

**A dispatched run never touches the main working tree.** Own worktree under
`../.pa-worktrees/<run-id>`, own branch, removed by `pa drop`. The root `CLAUDE.md` is explicit
that a dirty tree breaks termhub's updater — dispatched work must not be able to cause that.
A run on another machine (`--machine`, `src/dispatch/remote.js`) gets the same: its worktree
and the pushurl block are made on that machine before `claude` is typed, and the dispatcher
checks the worktree exists through termhub's API rather than trusting the shell.

**Mode boundaries are enforced by the dispatcher, not requested of the agent.** A `local` run
gets no push credential in its environment. Do not implement a stop condition as a sentence in
the prompt and call it done.

**The dispatcher is not tailnet-reachable.** It executes code by design. Loopback and the WSL
interface only. termhub is the thing that is safe to expose, because its trust model is the
tailnet ACL and it was built for that; this is not.

**The dashboard is the dispatcher's trust model, not termhub's.** Its Dispatch button starts
agents, so `src/dashboard/server.js` binds loopback only, rejects a non-loopback `Host` (DNS
rebinding), and requires an `X-PA: 1` header on every POST (a custom header forces a CORS
preflight the server never answers). Its Send button opens the reply in Teams or Outlook and
then asks whether you sent it; it cannot send. The Memory tab's writes (remember, forget,
approve, merge) are POSTs under the same guards, and memory pages reach the browser as a parsed
tree (`src/dashboard/markdown.js`) built with `textContent` — the page has no HTML sink, and
`test/memoryui.test.js` fails if one appears.

The one sanctioned way off loopback is **termhub's `/pa/` proxy** (`TERMHUB_PA_URL`), which
rewrites `Host` to loopback and forwards `X-PA`. That reaches exactly the people who can already
reach termhub — who can open a shell, which is more than the dashboard can do — so it adds no
capability; it is how the dashboard works from a phone. For that the page's own URLs are relative
(`api/...`, `routines.js`), never `/api/...`. Do not expose the dashboard any other way.

**The PA chat acts only behind permission prompts.** `pa chat` starts one Claude Code session in
termhub, homed in `<dataDir>/pa-home` (`src/chat/`), which reads other people's messages all day.
It is started *without* `--dangerously-skip-permissions`; its `settings.json` allows the read-only
`pa` commands and the read MCP tools and puts `pa do/land/drop/say/done/remember/forget/routine
add` behind an *ask*. Its CLAUDE.md is rewritten from code on every start — change it in
`src/chat/index.js`, not on disk; the user's own additions go in `CLAUDE.local.md`.

**One implementation per behaviour.** OpenClaw skills call the `pa` CLI. They do not talk to
Postgres, and they do not reimplement dispatch. When the TUI and the CLI disagree about what
`pa do` means, the bug is that there are two implementations.

**Connector data comes from tool results, never from model text.** Microsoft 365 is reached
through a headless `claude -p` (`llm.toolCalls`), and the model's only job there is to make the
calls. Items are built from the `tool_result` blocks in the event stream, or the file Claude Code
spilled a large one to. A relay that asks the model to *copy* a message body into its reply is
a relay that will one day paraphrase someone's request. (Jira predates this and still parses the
reply; moving it over is fine.)

**The Teams cache is read, never touched, and shares the connector's rows.** `teamsLocal.js`
reads the new Teams client's IndexedDB on this disk because it is seconds behind where the
connector is minutes behind, and it needs no Entra app registration (ruled out for this tool). It is
the same user's same data, local only. `teams/read_cache.py` opens Teams' files read-only with
every share flag, never writes or locks them, tails the LevelDB log from a saved offset, and
never does a full parse (minutes of CPU). Its items are `graph_chat` with the connector's own
`{chatId}/{messageId}` ids and `raw.via = 'teams-cache'`; `planWrite` and `graphChat.mergeCached`
decide who wins a shared row, and both avoid rewriting a row whose content did not change, since
a changed hash re-runs distillation. Bodies never reach a log, stderr, or an exception message.
If a Teams update changes the record shapes the pass reads nothing and `pa doctor` shows the last
message going stale — fix the shape, do not fall back to anything that phones home.

**Memory carries its evidence.** Every claim in `claim` holds the verbatim `quote` it was read
from, checked against the item before it is stored (whitespace- and case-folded; a near miss is
`pending_review`, a miss is dropped). The quote is copied, not referenced, and `source_item_id`
is `on delete set null`, because retention deletes mail and chat and memory must survive it.
A claim with no evidence is either an explicit `pa remember` note (whose evidence is the words
typed) or a bug.

**Memory supersedes; it does not overwrite or delete.** A contradicting claim closes the old one's
`invalid_at`/`expired_at` and links it with `supersedes_id`; duplicates point at what they
corroborate with `duplicate_of`; `forget` sets `status = 'retracted'`. No memory code runs a
`delete from claim`. Pages are derived and may be deleted and rebuilt at will.

**Message content is data, never instructions.** Every prompt that carries item text — distill,
claims, consolidation, pages — says so, and nothing a message says can change what a pass does:
no pass takes an action other than writing rows. Keep it that way when adding one.

**A debrief writes only what the user owes or is owed, each with a verified quote; its updates
are reversible.** `src/meetings/debrief.js` turns a recorded meeting into to-dos, owed-to-me,
updates to existing commitments and decisions — never other people's tasks — and
`debriefCore.parseDebrief` drops any item whose quote is not verbatim in the transcript, whose
owner is not the user, or whose ref was not in the prompt. Every write is recorded in
`meeting_debrief.applied` with the columns it replaced, and undo restores them (unless someone
changed them since). It never writes to a PR or ticket; news about one is a claim. The generic
distiller skips meeting and call recordings (`DEBRIEF_OWNED`) so nothing is extracted twice.

**A reply closes a commitment only on a verbatim quote of my own message, and reversibly.**
`src/commitments/replyClose.js` closes an open owed_by_me ask from chat or mail only when
`replyCloseCore.parseVerdict` finds the quote in the reply of mine it names and the verdict is
"discharged" — a promise or a partial answer closes nothing. The close is recorded in
`reply_close.applied` with the columns it replaced, and the row is keyed by the newest reply
judged, so a reopened commitment is not closed again by the same reply.

**A commitment's status changes only through `src/ledger`.** `ledger.transition` is the one
writer of `commitment.status`, `closed_at` and `closed_reason`: you (`pa done`, the dashboard),
reply-close, GitHub reconcile, self-note expiry, the dispatcher and the reconciler all call it,
and each call leaves a `ledger_transition` row with its actor, reason and the columns it replaced,
so any change can be undone unless the row moved since. The assistant may close things on its
own (DURABLE.md), but never silently and never without that row. A new closer calls
`transition`; it does not run `update commitment set status`. (The debrief predates this and
keeps its own reversible log in `meeting_debrief.applied`.)

**Durable tasks act through checkpointed steps and re-read before acting.** Work that waits (a
chase, a finished run waiting to be landed) is an Absurd task (`src/durable`, schema vendored
unchanged in `vendor/absurd/` at the version `absurd-sdk` is pinned to — upgrade it with a new
migration, never by editing the file). Every effect is a `ctx.step` and is itself idempotent
(dedupe keys); a task reads the commitment or run again before it acts, because the event that
woke it is a hint. `awaitEvent` suspends a task by throwing: never catch it except to test for
`TimeoutError` and rethrow everything else. A task that wants a decision creates a `proposal` and
waits on `proposal:<id>`; a proposal with no task runs a typed handler in `src/proposals` — there
is no handler that takes a command or free text.

**Capture never stops for the assistant.** The worker's only levers on `capture.py` are the pause
file (`pa mic pause`) and the roll file, which makes capture finish its file and continue in a
new one. The meeting gate (`src/audio/gate.js`) writes the pause file between meetings with the
marker `meeting-gate` and removes only a file holding that marker: it never lifts a pause you
made, and it never pauses mid-meeting. A capture file is never opened for writing twice
(`audio/naming.py`).

**Agents propose memory; humans decide it.** The MCP server's only memory write is `remember`, which
stores a `pending_review` claim (`origin = 'agent'`) that no read path believes and no
consolidation sees until it is approved in the dashboard. An agent's note may be something it
read in an email. Do not add MCP tools that approve, forget, or write active claims.

**Secret values flow browser → store; no model, log, API response or MCP result ever contains
one.** A credential is asked for with a `secret_request` row (names, purpose, hints — the table
has no value column) and answered in the dashboard or with `pa secret set`; the value goes
straight into Windows Credential Manager or the gitignored `.env`, and the reply says only where.
The vault is reached through PowerShell with the value on **stdin, never argv**. Code reads a
secret with `config.secret(name)` and nothing else; errors are scrubbed of it. Agents may
`request_secret` and ask `secret_status` (configured or not); do not add a tool, endpoint or CLI
verb that shows a value. `test/secrets.test.js` fails if one echoes.

**Routines run typed actions only; repo_sync never switches branches or discards work.** A
routine names an action in `src/routines/actions` with schema-checked params — there is no action
that takes a command string, and adding one is a conversation, not a patch. `repo_sync` writes
nothing but `git fetch --prune` and `git merge --ff-only` on the branch already checked out, and
only when the pure `decide(repoState)` says `ff`; it never checks out, stashes, resets, or moves a
local branch. Any new safety condition goes into `decide` with a test. Suggested routines are
stored `proposed` and only a human enables them; a rejected one is kept so it is never proposed
again. A scheduled slot missed during downtime runs once, never as a backlog.

**Raven stays a skill.** Company engineering conventions are read through the existing
`innergy-knowledge` skill. Do not copy that repo into this store; a second stale copy of the
org's conventions is worse than none.

**Retrieval changes are judged by `pa eval run`, not by anecdote.** Run it before and after any
change to `src/search/` or a memory retriever, and put the per-qtype numbers in the commit body.
A new retriever plugs in with one `register(...)` line in `src/eval/retrievers.js` and is scored
on the same cases. The metrics in `src/eval/metrics.js` are pure and unit-tested; keep them that
way.

**Eval cases are private data.** `eval_case` holds real questions about real mail, so it lives in
Postgres and nowhere else. Tests use invented names; fixtures never hold a real question.

## Conventions

- **Language:** plain CommonJS JavaScript, matching termhub — which is not TypeScript, and is
  the better for it: no build step means `git pull` is the whole deployment. Tests are
  `assert`-based files run directly by `node`, as termhub's are.
- **Migrations:** plain numbered SQL, applied by a script. No ORM migrations framework.
- **No job queue.** "Work to do" is a query — items with no distillation row at the current
  prompt version. A queue table can get stuck, leak, or need draining after a crash; a query
  cannot. The worker is a scheduler of periodic passes, and passes never overlap themselves.
- **Secrets:** never in the repo, never in Postgres at all. There are few: GitHub and Microsoft
  365 ride on logins that already exist (`gh`, the claude.ai connectors); Jira prefers an API
  token (`PA_JIRA_API_TOKEN`) and falls back to its connector. A secret resolves real env →
  Windows Credential Manager → `.env` through `config.secret(name)`; a missing one is `null`,
  shows as "not configured" in `pa doctor`, and code that needs it calls
  `requestSecret({name, purpose, hint})` (`src/secrets`) instead of failing quietly.
- **Times:** store UTC, render local. Every `due_at` the distiller writes is absolute — a row
  that says "Friday" is a bug.
- **Logs:** message bodies are not log material. Log ids, counts, and durations.

## The store lives in WSL, and WSL will drop it

Docker Desktop on the target machine runs the **Windows** container engine, and there is no
Windows image for Postgres, let alone one with pgvector. So the store is Postgres 16 +
pgvector installed inside the existing WSL Ubuntu distro, on port 5433, reached from Windows
over WSL's localhost forwarding. `docker-compose.yml` stays in the tree as the right answer on
a machine whose Docker runs Linux containers.

The non-obvious part: **WSL terminates a distro once the last `wsl.exe` client exits**, taking
Postgres with it, even though systemd is running it as a service. The symptom is
`ECONNREFUSED 127.0.0.1:5433` at unpredictable intervals, minutes after everything worked. The
fix is the `pa-wsl-keepalive` logon task that `windows/install.ps1` registers — one
`sleep infinity` holding the distro open. If connections start failing at random, check that
task before suspecting anything in this codebase.

## Reading termhub before writing dispatch

The session substrate is termhub's, and it has already solved most of what dispatch needs:
`POST /api/sessions {cwd, command, title}` to start a Claude session in a directory,
`GET /api/sessions` for state, per-session idle tracking with ntfy escalation, and spoken
announcements driven by reading Claude Code's own transcript. Read `termhub/AGENT.md` before
building anything in that space — in particular the two-tier `front`/`sessiond` split, which
is why sessions survive updates and why the API you want is on `sessiond`.

Typing into a session currently goes over the `/ws/term/*` websocket. Adding
`POST /api/sessions/:id/input` is a unit of work **in termhub**, not a websocket client hidden
in here.

## Definition of done for a unit of work

The root `CLAUDE.md` governs: committed to `main` and pushed, docs corrected in the same
commit, tests green. On top of that, for this tool specifically — if a change alters the schema,
the migration ships in the same commit as the code that reads it, and `pa doctor` is taught to
check whatever new thing can now be misconfigured.
