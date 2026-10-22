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

```powershell
cd C:\repos\dev-tools\personal-assistant
.\windows\install.ps1
```

That provisions Postgres 16 + pgvector inside your WSL distro, registers the logon tasks
(keep-alive, worker, and the two capture streams), applies the schema, and writes a `.env` for
you to fill in.

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

`pa doctor` is the answer to "why isn't it doing anything". It reports every credential, every
source cursor, the distillation backlog, and whether termhub is reachable.

### What you need to set

| Value | Needed for | Notes |
|---|---|---|
| Microsoft 365 (claude.ai connector) | mail, calendar, Teams chats and channels | No app registration and no token: a headless `claude -p` calls the connector. Connect it once with `/mcp` → *claude.ai Microsoft 365*. `PA_TEAMS_CHANNELS` = `mentions` (default) / `all` / `off`. `PA_M365=0` turns it off. |
| `ANTHROPIC_API_KEY` | distillation and drafts | Optional. Without it, model calls run through `claude -p` on your own Claude Code login. |
| GitHub (`gh auth login`) | notifications, PRs, assigned issues, Projects v2 board items | No token in `.env`: ingest runs through the signed-in `gh` CLI. Boards also need `gh auth refresh -s read:project`; `PA_GITHUB_BOARDS=innergy-dev/7:Pod=Xi` follows a pod's cards whoever they are assigned to. `PA_GITHUB=0` turns it off. |
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

## Using it

**The dashboard** is at <http://127.0.0.1:7300/> whenever the worker runs (or `pa dashboard`
on its own): what's on you, what you're waiting on, agent runs, drafts, open PRs and board
items, each with **Do** (dispatch), **Reply**, **Done** and **Dismiss**. Loopback only — it can
start agents. Every button shows that it is working and then what happened.

**Closed recently** lists what left your list in the last three days and why — by you, or by the
assistant: after each GitHub pass it closes commitments whose PR merged or closed, reviews you
already gave, and review requests GitHub addressed only to a team you are in (those never become
commitments in the first place now). Each has **Reopen**.

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
pa dashboard                    serve the web page without the worker

pa do 42 --mode mr              dispatch to a Claude Code session in its own worktree
pa runs                         what's in flight
pa say 7 "use the existing helper"
pa attach 7                     open the session in termhub
pa review 7 [--diff]            what it changed
pa land 7                       push, and open a draft PR (gh) if the mode allows
pa drop 7                       kill the session, remove the worktree

pa draft 7                      a report on a run, from the ask and the actual diff
pa reply 42                     a reply to the ask behind commitment 42
pa drafts                       what is waiting to be sent
pa send 12                      opens it, written, in Teams/Outlook; you press Send

pa mic status | pause 30 | on    always-on capture control
pa doctor                        what is configured, stale, or broken
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
numbered brief of what is worth saying in it — a Windows toast with the first lines, the whole
brief in the dashboard's **Next meeting** card, with **Open brief** and **Join** buttons on the
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
you, 1 updated, 1 decision"*, with a numbered list, and the same in the dashboard's **Meeting
debriefs** section. `src/meetings/debrief.js`, run in the worker's audio pass:

1. **When.** A meeting or call episode with both streams (a mic-only recording puts everyone in
   the room on the `Me:` line, so it is not debriefed) is debriefed once it is over: its calendar
   slot has ended, the audio past the end is transcribed, and nobody spoke in the last ~100 s of
   it — or ten quiet minutes, for a call or a meeting that ended early — or 45 minutes have
   passed. When a meeting ends the worker touches `audio.roll` (`PA_AUDIO_ROLL_FILE`) and capture
   finishes its files within a second, so a meeting is typically debriefed 2–7 minutes after it
   ends instead of at the next quarter-hour.
2. **One model call per meeting** (`PA_DEBRIEF_MODEL`, default Sonnet; `PA_DEBRIEF_EFFORT`
   medium) reads the transcript beside the calendar title and attendees, who you are, and your
   open commitments (C-ids), open PRs and assigned tickets (T-ids). It returns only what is
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

### Secrets and sign-ins

When the assistant — or an agent through MCP — needs a credential, it asks; you never hand-edit
`.env`. A request appears at the top of the dashboard under **Needs you** (with a badge on the
Today tab and a Windows toast): what is needed, why, where to get it, and where the value will be
stored. Paste it into the password box and press **Save**.

The value goes from your browser over loopback straight into **Windows Credential Manager**
(DPAPI, your Windows account only; listed under *Web Credentials* → `personal-assistant`), or —
for non-secret config, or if you pick it — into the gitignored `personal-assistant/.env`, which
is refused if git does not ignore it. The reply says where it went, never what it was: no
endpoint, log line, MCP result or model ever sees a value, and there is no "show" button.

```
pa secret list                  names, where each is stored, when it was set — never values
pa secret set PA_JIRA_API_TOKEN hidden prompt (or piped stdin); replaces an existing one
pa secret request NAME --purpose "why" [--hint "…"] [--url https://…]
pa secret delete NAME
```

Code reads a secret with `secret(name)` from `src/config.js`: real environment → Credential
Manager → `.env`. Code that finds one missing calls `requestSecret({name, purpose, hint})`
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

`pa mic pause 30` releases the device handle outright — it stops capture, not merely
transcription. Your own Claude Code sessions are captured from their transcripts on disk rather
than from audio, because the exact text is already there.

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
worker dumps it (`pg_dump`, custom format) once a day to `%LOCALAPPDATA%personal-assistantackups`
and keeps the newest 14 (`PA_BACKUP_DIR`, `PA_BACKUP_KEEP`). The dumps hold everything, so keep
them somewhere only you can read. `pa doctor` shows the age of the newest one.

```
pa backup                 dump now
pa backup list            what is there
pa restore [file]         replace the store with a dump (newest by default); asks first
pa reingest --days 180    no dump? rewind the sources and fetch history again
```

**Rebuilding on a new or wiped machine:** run `windows/install.ps1` (or just
`windows/setup-wsl-postgres.sh` in WSL) to get an empty database with its extensions, copy the
backups folder back, stop the worker, `pa restore`, start the worker. Restore needs the
extensions to exist and refuses otherwise; it leaves them out of the dump on purpose.

**With no dump**, `pa reingest --days N` rewinds the Microsoft 365, GitHub and Jira cursors so the
next passes re-fetch that window — how far back you actually get is each source's limit. Claude
sessions and audio transcripts on disk are re-scanned on their own. Re-ingest is an upsert:
running it over data that is still there costs fetches, not duplicates. Distillation, embeddings
and memory then rebuild from the items by themselves.

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

Work you hand it runs as an ordinary dispatch: its own termhub session and worktree. When that
session has been sitting at its prompt for a minute — finished, or stopped to ask something — you
get a notification that opens it; when it ends, another. The dashboard is also reachable through
termhub at `/pa/` (the **PA** button), so all of this works away from the desk.

## Wiring it into your agents

- [`integrations/claude-code/`](./integrations/claude-code/) — register the read-only MCP recall
  server so every Claude Code session on this machine reads the same brain.
- [`integrations/openclaw/SKILL.md`](./integrations/openclaw/SKILL.md) — the skill that lets
  OpenClaw drive these same commands from a chat surface.

## Layout

```
bin/pa.js            the CLI entry point
src/config.js        every knob, resolved once
src/ingest/          Microsoft 365 mail/calendar/Teams (connector), GitHub, Jira, Claude sessions, audio episodes
src/distill/         the extraction prompt, identity resolution, the pass itself
src/projects/        the project ↔ repo table and the scorer that guesses
src/search/          hybrid retrieval: full text + vector + people named, fused, Cohere-reranked
src/eval/            retrieval eval: metrics, retriever registry, case seeding, runs
src/memory/          claims with evidence, consolidation, people/project pages, nightly dream
src/recall/          multi-hop recall over items, claims and pages, one rerank
src/brief/           what `pa brief` prints
src/meetings/        pre-meeting briefs: classify, gather evidence, learn from transcripts, notify;
                     post-meeting debriefs (debrief.js, pure half in debriefCore.js)
src/dashboard/       the loopback web page: today, next meeting, replies, runs, secret requests, and the Memory and Routines tabs
src/secrets/         secret and login requests; Windows Credential Manager via PowerShell (stdin only)
src/routines/        cron parser, the typed action registry (repo_sync, prompt_report), runs, suggestions
src/llm.js           model calls: API key, or `claude -p` without one
src/backup.js        nightly pg_dump, restore, re-ingest
src/dispatch/        worktrees, briefs, termhub sessions, modes, landing
src/draft/           reply drafting, auto-drafts, and delivery links (never sends)
src/mcp/server.js    the recall server: read-only, plus remember and request_secret, which only ask
src/worker.js        the periodic passes
audio/               capture and trim/transcribe (Python)
sql/                 numbered migrations
windows/             install, and the WSL Postgres provisioner
```

## Related

- [`termhub`](../termhub/) — the session substrate. Dispatch creates termhub sessions because
  it is the only one you can attach to from a phone.
- [`voice-dictation`](../voice-dictation/) — owns the faster-whisper server the audio pass uses.
- [`disk-janitor`](../disk-janitor/) — point it at the audio spool; aged rebuildable data is
  exactly what it is for.
