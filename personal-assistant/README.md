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
*Teams in seconds*), applies the schema, and writes a `.env` for you to fill in.

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

`pa doctor` is the answer to "why isn't it doing anything". It reports every credential, every
source cursor, the distillation backlog, and whether termhub is reachable.

`pa projects sync` (also run by the worker every six hours) builds the project ↔ repo table from
the clones under `PA_REPOS_ROOT`. When several folders share one remote, the one named like the
repo wins and worktrees and copies become its aliases. A project whose folder has gone is
*retired* — kept, so commitments still point at it, but never offered to the distiller or accepted
as a correction — and comes back if the folder does. A GitHub item's own repository decides its
project outright; if that repo is not cloned, the project is left empty rather than guessed.

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
write-ahead log *from where the last pass stopped* — a few KB, about 20 ms — plus any table a
compaction wrote since. The reader stays resident and takes requests on a pipe, so a pass is a
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
  wait for a pass already in flight.

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

## Using it

**The dashboard** is at <http://127.0.0.1:7300/> whenever the worker runs (or `pa dashboard`
on its own): what's on you, what you're waiting on, agent runs, drafts, open PRs and board
items, each with **Do** (dispatch), **Reply**, **Done** and **Dismiss**. Loopback only — it can
start agents. Every button shows that it is working and then what happened. Its **Chat** tab is
a box onto the PA chat, the same conversation as in termhub ([below](#the-chat-tab-and-the-chat-api)).

**Every card says where it came from and why it is there.** Cards on **On you**, **Waiting on
others**, **Needs you** and **Looks done?** carry a row of links built from what ingest stored, with
no model in the loop (`src/dashboard/links.js`, `cards.js`): the Teams message, mail, PR, Jira issue
or board item it was read from; a Teams chat with the person and their GitHub; the repo; GitHub
PRs, issues, branches, repos and Jira issues named in the message or the next few messages of its
thread; a run's PR; and, on **Looks done?**, the item that suggests it is settled. A card read from
a Claude session says which machine and folder it ran in and when, shows `claude --resume <id>`,
links its transcript, and has **Open in termhub**, which opens the running session on that machine
or starts one resuming it. Above the links is a short paragraph — who asked what, what led to it,
what has happened since, and what is expected now and from whom — written by the worker a few
cards at a time (`src/commitments/context.js`, every two minutes, `PA_CARD_CONTEXT=0` turns it off)
and rewritten when the thread has news; it is discretionary spend (`card-context`). A chase's
"when should I follow up?" card shows the same paragraph for the ask it is about.

**From your own work** holds what the distiller read from your own Claude sessions and your own
PRs — agent handoffs like "verify the banner in a browser before merge" — apart from **On you**,
which is only what people asked of you or you promised them. They are grouped one per PR or
session, close when their PR merges or closes, and expire after a week nobody touched them
(`src/commitments/selfNotes.js`; reopening or correcting one counts as touching it). Asks from
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
(`src/commitments/replyClose.js`, every five minutes, `PA_REPLY_CLOSE=0` turns it off). An open
owed_by_me commitment with a later message from you in the same chat or mail thread (within two
weeks) is shown to a model beside that ask; only a reply that delivers what was owed — the answer,
even a "no", or "fixed it" — closes it, never a promise ("I'll look tomorrow") or half an answer.
The verdict must quote your message verbatim (checked as for memory claims) and the quote becomes
the reason: `answered in chat: "…"`. Each judgement is a `reply_close` row keyed by the newest
reply it saw, with what the close replaced, so the same reply is never judged twice — **Reopen**
(or `pa done <id> --reopen`) sticks until you write in that thread again. `pa doctor` shows the
count.

**The reconciler keeps the rest true** (`src/ledger/reconcile.js`, every minute and right after a
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
before — or shown under **Looks done?** with **Close it** / **Not yet** between 50% and 80%. A
promise is never a delivery. Every status change, yours or the assistant's, goes through
`src/ledger` and is listed by `pa ledger <id>`; the closed card says who closed it, and **Reopen**
takes it back.

**Work that waits is a durable task** (`src/durable`, on [Absurd](https://github.com/earendil-works/absurd)
in the same Postgres; `PA_DURABLE=0` turns it off). Two so far. **Chase**: for something a person
owes you in chat or mail, a **Needs you** card asks when to follow up — in 4 hours, tomorrow, in 2
days, in a week, or don't chase — with the answer you last gave for that person marked *usual*.
Unanswered, it goes with the default: your usual for them, else a working morning two days after
the promise (or just after it was due). Unless the ask closes first, a follow-up is then drafted in
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
gets no card. **Needs you** is also where the assistant asks what
only you know (which repo?). `pa proposals` / `pa answer <id> yes|no|<option>`
do the same from the terminal, and `pa doctor` counts tasks by state.

**Model spend is recorded and capped per day** (`src/budget.js`). Every model call — `claude -p`
or the API — leaves an `llm_spend` row: when, which pass (`purpose`: distill, reconcile,
reply-close, draft, memory-*, meeting-brief, debrief, connector, ...), model, backend, cost,
tokens, duration and whether it worked; never any prompt or reply text. The CLI reports its own
cost; for the API it is estimated from token usage at list prices, or left null for a model it
does not know. Another provider's call is priced only from `PA_MODEL_PRICES` (or, on OpenRouter,
the cost it reports); otherwise its cost is null, never guessed — and its `backend` is the
provider's name (`azure`, `openrouter`, …). `PA_DAILY_BUDGET_USD` (default 15) caps a local day: once reached, *discretionary*
purposes (`PA_BUDGET_DISCRETIONARY`, default eager, research, digest, planner, card, propose — speculative work
done ahead of you) are refused until midnight and the worker logs it once; *essential* ones
(`PA_BUDGET_ESSENTIAL`, default distill, reconcile, connector, reply-close) keep the board true
and are never refused. Speculative work asks `budget.allow(purpose)` before it spends. `pa spend
[--days N]` prints per-day, per-pass totals, `pa doctor` shows today against the cap with the top
three passes, and the dashboard shows a spend chip beside the source chips.

**The planner works ahead of you** (`src/agent/planner.js`, every five minutes, `PA_PLANNER=0`
turns it off). Each new ask on you from the last week is given a kind (reply, review, coding,
investigate, meeting, decision, admin) once. An *investigate* ask with a known repo gets a
read-only research run started on its own — `plan` mode, so it can neither commit nor push — at
most `PA_EAGER_RUNS_PER_DAY` (2) a day and only within the daily budget; you get a toast with the
session. A *coding* ask with a known repo becomes a **Needs you** card, "start a coding session?" —
or, when the routing rule picks the software factory (below), "send to the factory?". Everything
the card shows is decided before you see it and frozen into the proposal (`src/dispatch/offer.js`):
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
pa do 959 --via factory --delivery auto_merge --pipeline solo   end state + pipeline, chosen by you
pa propose 959 --via factory    the same on a card: brief, end state and criteria shown before the yes
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
   commitment restates an older open one to the same person.
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
and the transcript; defaults to today's meetings). `src/meetings/debrief.js`, run in the worker's audio pass:

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

```
pa meeting debrief [episode-id|last] [--dry-run] [--notify]
pa meeting debriefs [--days 7]
pa meeting undo <debrief-id> <n>
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

Some work belongs on a particular machine — the VM that runs the service, holds the OneDrive
sync, has the credentials. `pa do 959 --machine mv-automated-vm` (or the machine picker beside
**Do** on the dashboard) starts the run in *that* machine's termhub, which is already one of
your hub's peers, so you attach to it the same way. Machines are listed in `PA_MACHINES`
(`name=termhubUrl|reposRoot[|os]`); the repo must be cloned there under the same folder name.
Windows, Linux and macOS machines all take runs. The OS (`windows`, `linux`, `macos`) is optional:
without it, it is what that termhub reports (`/api/info`), else the shape of `reposRoot`
(`C:\…` or `/…`). A configured OS that its termhub contradicts, or a `reposRoot` written for the
other OS, is refused rather than guessed around. `pa doctor` shows each machine's reachability,
OS and whether its termhub can run commands. A factory job on any of them
can be followed (next section).

A run's worktree is trusted ahead of time (the worktrees root is marked trusted in `~/.claude.json`, `src/dispatch/trust.js`), so Claude never stops at its folder-trust question; if the question shows anyway, the cursor is moved to *Yes* first, since newer Claude Code puts it on *No, exit*.

The dispatcher cannot touch that disk, so it has that machine's termhub run the setup —
`POST /api/exec`, one command at a time, argv arrays with no shell, each exit code checked
(`src/dispatch/exec.js`) — and checks the result through termhub's API before starting Claude:
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
→ `{code, stdout, stderr}` in `src/dispatch/exec.js` (`null` is this machine). A timeout is code
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

A second dispatch target next to Claude sessions: the software factory (PM → SM → dev → reviewer →
merge gates, its own repo). `pa do 959 --via factory` sends the ask there as a job instead of
starting a session; `--via auto` lets the routing rule choose and prints why; `--via claude` (the
default, `PA_DISPATCH_VIA`) is everything before. The dashboard grows a route picker beside **Do**
once the factory is configured. The PA never imports factory code: it runs `uv run factory job …`
in the factory checkout (`PA_FACTORY_PATH`) on the factory's machine (`PA_FACTORY_MACHINE`, a
`PA_MACHINES` name, or empty for this one) and reads the one JSON object each command prints — the
contract is the factory's `docs/JOBS-API.md`.

- **The end state is yours** (operator decision 2026-11-02, no ceiling). Every job carries an
  explicit `--delivery`: `none` (committed in the factory's worktree), `branch`, `draft_pr`, `pr`,
  `auto_merge` (merged when its gates and CI pass), `push_to_main` (fast-forwarded onto main when
  its gates pass). Where it comes from, first match wins (`src/dispatch/deliveryCore.js`):
  `--delivery` or the card's pick; an explicit `--mode` (local → none, branch → branch, mr/full →
  draft_pr); your own words in `--task` ("just open a draft", "merge it", "push straight to main",
  "don't push") — never a third party's message; the repo's default (`pa delivery set owner/name
  <level>`, `pa delivery list`, sql/025); `PA_DELIVERY_DEFAULT` (draft_pr). The same vocabulary
  drives a Claude session: its worktree runs in the mode that level maps to (push_to_main runs as
  `local` — no push credentials in its environment and its push blocked, which stops an accident; an
  agent running as your OS user can still restore them from disk, so the real boundary is a separate
  OS user, not set up yet — `pa doctor` says so) and run review does the rest. `plan` is never
  a factory job.
- **The ask is a composed brief** (`src/dispatch/compose.js`, rules in `composeCore.js`): a model
  (`PA_COMPOSE_MODEL`, any text-capable provider) writes the goal, done-criteria, constraints,
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
  `--pipeline chain|solo|auto` (`PA_FACTORY_PIPELINE`) and `--model persona=provider/model`
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
- **Every job carries a flow**: the factory's direction validator needs a `flow.md` (or an API spec)
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
- **Status comes back** every `PA_FACTORY_POLL_SECONDS` (120): one `factory job list --source pa
  --active`, plus `job status` for jobs that ended since. A blocked job makes the run `waiting` and
  tells you why; a finished one is `landed` with its PR on the card and closes the commitment *done*
  through the ledger (actor `factory`); a failed or cancelled one reopens it. `none` delivery
  closes nothing — the work is in the factory, and the ask stays dispatched until you close it.
  GitHub reconcile only closes `open` asks, so a merged factory PR is never closed twice.
- `pa review <run>` shows the job, its stories and PRs; `pa drop <run>` cancels the job (the factory
  keeps its evidence) and reopens the ask; `pa land`, `pa diff` and `pa say` refuse — the factory
  delivers and is steered on its own side.

**Telling the PA chat**: it picks the end state from what you said, the route (`--via claude`, or
`--via factory --pipeline chain|solo`) and models, and either starts it (`pa do`, behind a permission
prompt) or puts it on a card (`pa propose`, which starts nothing). Accepting a card from the chat
(`pa answer <id> yes [--delivery level]`), `pa delivery set` and `pa factory add` ask first.

**The routing rule** (`src/dispatch/routeCore.js`, pure and tested) sends work to the factory only
when all hold: the factory is configured, the mode changes code, the planner judged the ask
*coding*, its repo is registered with the factory (`factory app list`), and it has done-criteria.
Anything else — investigate, ambiguous, `plan`, an unknown or unregistered repo, nothing to check
the result against — is a Claude session. `PA_ROUTE_CHOOSER` picks a different chooser registered
in `src/dispatch/route.js` (the seam for an LLM or evidence-based one); whatever it says is held to
the hard limits (configured, not `plan`, registered repo).

**Which route works** is measured: every run records its route, the reason, the ask's kind, and its
outcome (`delivered`, `merged`, `failed`, `dropped`); factory runs add pipeline, delivery, models,
job id and the factory's reported cost (sql/024). `pa runs stats [--days 90]` prints success rate
and cost per route × kind. `pa doctor` checks the factory answers and lists its apps.

### Secrets and sign-ins

When the assistant — or an agent through MCP — needs a credential, it asks; you never hand-edit
`.env`. A request appears at the top of the dashboard under **Needs you** (with a badge on the
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
the worker's **meeting gate** (`src/audio/gate.js`) keeps the recorders paused, holding no
device, except while a calendar meeting with other people in it is on (from two minutes before
its start to five after its end) or another app holds the microphone. The second is the
unplanned call: a Teams ring, a Zoom link in chat, a Meet tab. Windows records which app holds
the mic, and the gate reads that every 20 s; our own recorder and voice-dictation (Python) do
not count. After a call lets go it waits two minutes before pausing, so a dropped call that
rejoins stays one recording. `PA_AUDIO_MEETING_GATE=0` goes back to always-on.

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
`src/eval/retrievers.js`. `--retriever search-fused` runs search with the reranker off, to
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
before the nightly dump finds out. The dumps hold everything, so keep
them somewhere only you can read. `pa doctor` shows the age of the newest one.

```
pa backup                 dump now
pa backup list            what is there
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
`PA_DRAFT_MODEL` and `PA_EVAL_MODEL` (default: the distill model), `PA_ROUTINE_MODEL`.

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
CLI: read-only commands run freely; starting a run (`pa do`), landing, steering, closing,
remembering and adding routines each ask you first. Put your own standing instructions in
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

<http://127.0.0.1:7300/talk> is the same chat with no keyboard: you talk, it talks back, and the
work happens in the background. A small ASCII face shows what it is doing (listening, thinking,
talking, pleased when it finishes, worried when something is down), with the latest tool step in
small print under it. Tap the face (or press Space) once to start: browsers allow the microphone
and speech only after a gesture. From there, **dashboard** drills down to the cards and the chat in
text, and **session** opens the PA chat's termhub session.

- **Listening** is hands-free: an energy-based voice detector in the page (`talk.core.js`) notices
  you start, waits for a pause of about a second, and sends that utterance. Hold Space (or the
  button) to push-to-talk instead; turn hands-free off in **settings** if the room is noisy.
- **Transcription** reuses voice-dictation's warm faster-whisper server (`PA_TRANSCRIBE_HOST` /
  `PA_TRANSCRIBE_PORT`, as capture does): the page sends a 16 kHz WAV to `POST /api/talk/transcribe`,
  which writes it to a temp file, hands the path to the server, and deletes the file. Whisper's
  stock filler for silence ("Thank you.", "you") is dropped. The text then goes to `/api/chat` with
  `source: "voice"`. While the chat is parked on a permission prompt or question, the chat refuses
  the send (409); the page says once that it is waiting on an answer in termhub, and does not retry.
- **Speaking** reads each answer sentence by sentence as it arrives, in the browser's best natural
  voice (Edge's "Online (Natural)" voices are good; pick another in **settings**). Code blocks,
  tables and URLs are not read out: it says "the link" or "I put the details on the dashboard"
  instead. The speech engine is one entry in a table in `talk.page.js`, so a local neural TTS can be
  added beside it.
- **Barge-in and echo.** Start talking and it stops. While it speaks, the mic needs three times
  the usual level for over a third of a second before it counts as you, so its own voice from the
  speakers is not transcribed. With speakers loud and no headset, tick "stop listening" in
  **settings** to turn barge-in off.

The microphone needs a secure page: `http://127.0.0.1` or `localhost` on this machine is fine, but
the plain-HTTP tailnet address through termhub's `/pa/` proxy is not, so the page can still speak
there but cannot hear. To talk from a phone, put termhub behind HTTPS (for example
`tailscale serve`, which gives it a certificate on its `*.ts.net` name) and open `/pa/talk` there.

### The Chat tab and the chat API

The dashboard's **Chat** tab (and the voice page) talk to **the same live session**, not to a
new `claude -p` per message, so typing there, speaking, and typing in termhub are one
conversation. Enter sends, Shift+Enter is a new line; the tab's dot shows when the assistant is
working, the line under the messages shows what it is doing ("searching your history…"), and
**open in termhub** jumps to the session itself (`src/chat/feed.js`):

- **In:** the text is typed into the session through termhub (`POST /api/sessions/:id/input`,
  then Return as its own keystroke). No session running? `ensureSession()` starts one and the
  message is typed once Claude is at its prompt, answering the folder-trust question on the way.
- **Out:** the session's own Claude Code transcript, tailed by byte offset:
  `~/.claude/projects/<pa-home with every non-alphanumeric as ->/<uuid>.jsonl`. Only the PA chat
  runs in `pa-home`, so the newest file there is its conversation (a `/clear` starts a new file;
  the newest still wins). Claude Code writes each text block once it is complete, so replies
  arrive whole, a block at a time, not token by token.
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
| `GET /api/chat/history?limit=50` | `limit` 1–500 | `{ "messages": [event…] }`, oldest first, `user` and `assistant` only |
| `GET /api/chat/session` | — | `{ sessionId, status, waitingOn, url }` — `url` opens the session in termhub |

An event is `{ "id", "type", "text", "at" (ISO), "source"? }`:

- `user` — a message to the assistant. One sent through `POST /api/chat` carries that call's `id`
  and its `source`; its echo in the transcript is dropped, so it is seen once. One typed in
  termhub (or the inbox doorbell line) has no `source`.
- `assistant` — a complete block of the reply. A turn can be several (text, a tool, more text),
  each with its own id. No `partial` events: the transcript has none to give.
- `activity` — a short line about a tool call ("reading INBOX.md…", "running pa search …"),
  never the tool's whole input.
- `status` — `thinking`, `idle` (the turn is over: speak now) or `offline` (no session; sending
  starts one). It stays `thinking` from a send until the message is taken, even when a session
  that is still starting reads as idle.

Ids are stable across history and the stream (transcript entry uuids), so a client can load
history and then dedupe the stream against it.

## Wiring it into your agents

- [`integrations/claude-code/`](./integrations/claude-code/) — register the read-only MCP recall
  server so every Claude Code session on this machine reads the same brain.
- [`integrations/openclaw/SKILL.md`](./integrations/openclaw/SKILL.md) — the skill that lets
  OpenClaw drive these same commands from a chat surface.

## Layout

```
bin/pa.js            the CLI entry point
src/config.js        every knob, resolved once
src/ingest/          Microsoft 365 mail/calendar/Teams (connector), the Teams local cache, GitHub, Jira, Claude sessions (this machine and, through termhub, the others), audio episodes
src/distill/         the extraction prompt, identity resolution, the pass itself
src/projects/        the project ↔ repo table and the scorer that guesses
src/search/          hybrid retrieval: full text + vector + people named, fused, Cohere-reranked
src/eval/            retrieval eval: metrics, retriever registry, case seeding, runs
src/memory/          claims with evidence, consolidation, people/project pages, nightly dream
src/recall/          multi-hop recall over items, claims and pages, one rerank
src/brief/           what `pa brief` prints
src/meetings/        pre-meeting briefs: classify, gather evidence, learn from transcripts, notify;
                     post-meeting debriefs (debrief.js, pure half in debriefCore.js)
src/commitments/     closing chat and mail asks you answered yourself (replyClose.js, pure half in replyCloseCore.js);
                     the cause-and-effect paragraph on cards (context.js, pure half in contextCore.js)
src/dashboard/       the loopback web page: today, next meeting, replies, runs, secret requests, and the Memory, Chat and Routines tabs;
                     each card's links to its source, person, repo and session (links.js pure, cards.js);
                     /talk, the voice page (talk.html + talk.page.js; talk.core.js pure; talk.js serves it and proxies to whisper)
src/secrets/         secret and login requests; the OS keyring facade (vault.js; stdin only)
src/platform/        every OS decision: windows.js, linux.js, darwin.js behind one contract (index.js)
src/routines/        cron parser, the typed action registry (repo_sync, prompt_report), runs, suggestions
src/chat/            the PA chat session's home (index.js, agent.js) and its stream for the Chat tab and voice (feed.js; transcript.js pure)
src/notify/          notifications: toasts, the interrupt budget, digests, feedback weights, the PA chat inbox
src/llm.js           model calls: Anthropic API, `claude -p`, or an OpenAI-compatible provider
src/models.js        model strings, which backend each pass uses, and what it can do (pa doctor)
src/agentCli.js      claude | opencode command lines for the chat (src/chat/agent.js) and runs (src/dispatch/agent.js)
src/budget.js        model spend: one llm_spend row per call, the daily cap on discretionary work
src/backup.js        nightly pg_dump, restore, re-ingest
src/dispatch/        worktrees, briefs, termhub sessions, modes, landing; the factory route
                     (factory.js, pure half factoryCore.js), the routing rule (route.js, routeCore.js),
                     `pa runs stats` (stats.js)
src/draft/           reply drafting, auto-drafts, and delivery links (never sends)
src/mcp/server.js    the recall server: read-only, plus remember and request_secret, which only ask
src/worker.js        the periodic passes
audio/               capture and trim/transcribe (Python); devices_linux.py asks PipeWire/PulseAudio
teams/               the Teams local-cache reader (Python, its own venv)
sql/                 numbered migrations
windows/             install, and the WSL Postgres provisioner
linux/               install.sh, the native Postgres provisioner, systemd user units
```

## Related

- [`termhub`](../termhub/) — the session substrate. Dispatch creates termhub sessions because
  it is the only one you can attach to from a phone.
- [`voice-dictation`](../voice-dictation/) — owns the faster-whisper server the audio pass uses.
- [`disk-janitor`](../disk-janitor/) — point it at the audio spool; aged rebuildable data is
  exactly what it is for.
