# personal-assistant — build plan

Written 2026-09-01. Supersedes nothing; this is the first plan. Revise it in place as
decisions change, and note *why* the decision changed — a plan that only records the current
answer is worth about half as much as one that records the abandoned ones too.

---

## 1. Decisions already taken

| Decision | Choice | Why |
|---|---|---|
| Host | Everything on the Windows box | Repos, toolchain and termhub already live there. Accepted cost: the assistant sleeps when the machine does. |
| Primary surface | OpenClaw TUI in the terminal | Where the work already happens. No tenant approval needed, unlike a Teams bot. |
| Session substrate | **termhub sessions**, not tmux and not ACP | Only substrate where you can *attach to a running agent* from a browser on your phone. ACP can be steered but never attached to; native OpenClaw subagents can't even be steered. |
| Store | One Postgres + pgvector | Rows, jsonb, embeddings and full-text in one engine with one backup. |
| Autonomy | Per-task mode chosen at dispatch | Not a global setting. See §6. |
| Onyx | **Deferred** to phase 8 | ~16 GB of Docker (Postgres + Vespa + Redis + model server) to get connectors we're writing thin versions of anyway. Revisit when SharePoint/Confluence/HubSpot breadth actually matters. |
| Memory frameworks (Mem0, Letta, Graphiti, Cognee) | Deferred | They solve "agent remembers the user". Our problem is ingesting other people's messages. Add Graphiti only when a real question is answered wrong by flat retrieval. |
| Audio capture | Always-on, mic **and** system loopback as separate streams, trimmed hourly | Two streams give speaker attribution with no diarization: mic is you, loopback is everyone else. See §7. |
| Agent-session capture | From Claude Code / OpenClaw transcripts, not from audio | The exact text is already on disk. Audio would be a lossy copy of a perfect record. |
| Project → repo | Seeded table + guessing distiller that learns from corrections | You never author the mapping; you correct a guess once and it becomes an alias. See §8. |
| Outbound | Draft only, never auto-send, for as long as it takes to trust | One wrongly-sent Teams message ends the project. |

### The Windows split, concretely

OpenClaw requires WSL2 on Windows. Everything else wants to be native, next to `C:\repos`.

```
Windows host
├─ WSL2
│   ├─ openclaw gateway            (TUI, sessions, skills, MCP client)
│   └─ docker: postgres + pgvector (:5432, forwarded to Windows localhost)
└─ native Windows (Node, same as termhub)
    ├─ pa-ingest workers           (Graph delta polling, GitLab, meetings)
    ├─ pa-dispatch                 (:7300 — worktrees, termhub sessions, runs)
    ├─ pa-mcp                      (stdio for Claude Code; HTTP for OpenClaw)
    └─ termhub                     (:7000 — already running)
```

WSL2 reaches the Windows side at the host IP from `ip route show default`; Windows reaches
WSL2 services on `localhost` thanks to WSL's port forwarding. Pin the dispatcher's bind to the
loopback + WSL interface only — it must never be reachable from the tailnet, because it
executes code by design.

---

## 2. The permissions reality (settle before phase 1)

Per the Graph permissions reference, these **delegated** scopes are marked *admin consent
required: No* — `Mail.Read`, `Calendars.Read`, `Chat.Read`, `Chat.ReadBasic`.

That is not the whole story. The gate is a tenant switch in Entra (*User consent for
applications*). Where it is set to "Do not allow", even `Mail.Read` triggers "Need admin
approval". So:

1. Register the app in Entra (single-tenant, public client, redirect `http://localhost`).
2. Request `Mail.Read`, `Calendars.Read`, `Chat.Read`, `offline_access`.
3. Run the device-code flow **once**. If it completes, you have everything phase 1 needs.
4. If it says "Need admin approval", raise one request naming exactly those four scopes and
   the reason. Until it clears, phase 1 runs on GitLab + meetings only, which is still useful.

Known to be out of reach without admin, and therefore **not in v1**:

- `ChannelMessage.Read.All` — messages in team channels. Admin consent: **Yes**.
- Teams meeting transcripts/recordings via Graph — application permissions, admin consent, an
  Application Access Policy assigned in PowerShell, *and* a tenant-level transcript-API toggle.
  Three approvals. We capture meetings locally instead and skip all of it.

**Sending** (phase 5 drafts) needs `Mail.Send` and `ChatMessage.Send`. Verify their consent
status at the time; do not assume they match the read scopes.

### Data handling

Company mail, chats and meeting audio distilled onto one personal machine is a policy question
independent of what the API permits. Non-negotiables: BitLocker on the volume, the Postgres
port bound to loopback, no cloud index, no third-party service in the ingest path, and a
documented retention window (proposal: raw items 180 days, distilled rows indefinitely).

---

## 3. Architecture

Five layers, deliberately separable — each fails for a different reason and each should be
replaceable without touching the others.

**Capture** → append-only. Every source item is stored with its raw payload as `jsonb` before
anything interprets it. This is what makes distillation drift survivable: when the extraction
prompt improves, re-run it over history instead of re-reading a year of email.

**Store** → one Postgres. Jobs live in it too (`graphile-worker`); no Redis, no broker.

**Distill** → the layer that earns its keep. An LLM pass per item emits typed rows. Everything
downstream reads rows, never prose. This is the difference between "find me passages about
billing" (which every RAG tool does) and "what did I promise seven people this week" (which
none of them do, because it needs a table with a `due` column).

**Recall** → an MCP server. Every Claude Code session on the machine reads the same brain
through the same tools, so a dispatched session and an ad-hoc one never disagree about context.

**Dispatch** → a commitment becomes a run: worktree, generated brief, termhub session, tracked
lifecycle, diff queued for review.

---

## 4. Schema (first cut)

```sql
-- capture ------------------------------------------------------------------
source_item(id, source, external_id, thread_external_id, occurred_at,
            author_identity, subject, body_text, raw jsonb, content_hash,
            fetched_at)                       -- unique (source, external_id)
sync_cursor(source, delta_token, last_run_at, last_error)

-- identity -----------------------------------------------------------------
person(id, display_name, primary_email, is_me)
person_identity(person_id, kind, value)       -- aad_oid | smtp | teams_id |
                                              -- git_author | gitlab_username
                                              -- unique (kind, value)

-- projects ----------------------------------------------------------------
project(id, name, gitlab_path, repo_path, active, last_touched_at)
project_alias(id, project_id, alias, origin, weight, learned_from)
           -- origin: seeded | corrected | observed
           -- unique (lower(alias))

-- audio -------------------------------------------------------------------
audio_episode(id, started_at, ended_at, stream, speech_seconds,
              kind, calendar_event_id, audio_path, transcript_path, state)
           -- stream: mic | loopback
           -- kind: meeting | call | dictation | ambient | unknown
           -- state: raw | trimmed | transcribed | distilled | purged

-- distilled ----------------------------------------------------------------
commitment(id, source_item_id, direction, summary, detail,
           counterparty_person_id, due_at, status, project_id, repo_path,
           project_confidence, confidence, extracted_by, extracted_at,
           superseded_by)
           -- direction: owed_by_me | owed_to_me
           -- status: open | dispatched | done | dropped
fact(id, source_item_id, kind, payload jsonb, occurred_at)
           -- kind: decision | blocker | preference | reference

-- retrieval ----------------------------------------------------------------
chunk(id, source_item_id, ord, content, embedding vector(1536), tsv tsvector)

-- execution ----------------------------------------------------------------
run(id, commitment_id, mode, repo, worktree_path, branch,
    termhub_session_id, brief_path, status, started_at, ended_at,
    diff_stat jsonb, mr_url, exit_note)
draft(id, run_id, channel, to_identity, subject, body, status, sent_at)
           -- channel: teams | email ; status: pending | edited | sent | discarded
```

Two things worth defending early:

- **`person_identity` from day one.** The same colleague is a display name in Teams, an SMTP
  address in Outlook, and a git author in GitLab. Retrofitting identity resolution after ten
  thousand rows reference three different spellings is genuinely miserable work.
- **`superseded_by` on commitments.** Asks get revised in the next message. A commitment is
  not immutable and is not deleted; it is superseded, so the history stays readable.

---

## 5. `pa` — the CLI surface

One binary, because the terminal is the primary surface. OpenClaw calls the same commands
through a skill, so there is exactly one implementation of every behaviour.

```
pa brief                      # what's on me today: commitments, meetings, MRs waiting
pa inbox [--source teams]     # newly distilled items, newest first
pa show <id>                  # one commitment: the ask, the thread, the people, the repo
pa search <query>             # hybrid search over everything captured
pa who <name>                 # a person: identities, recent threads, open commitments

pa do <id> --mode <mode> [--repo <path>]   # dispatch (see §6)
pa runs                       # live and recent runs, with termhub session links
pa attach <run>               # print the termhub URL (and open it)
pa say <run> "<text>"         # steer a running session without leaving the CLI
pa review <run>               # diff + summary of what the session did
pa land <run>                 # execute the run's mode: push / open MR
pa drop <run>                 # kill session, remove worktree

pa draft <run> [--channel teams|email]   # reply drafted from the ask + the diff
pa send <run>                            # explicit, interactive, never implicit

pa projects                   # the project ↔ repo table, with alias counts
pa projects sync              # re-seed from C:\repos and GitLab membership
pa show <id> --project <name> # correct a guess; also learns the alias that was used
pa mic status | pause 30m | on
pa sync [--source ...]        # force an ingest pass
pa doctor                     # scopes, cursors, queue depth, termhub reachability
```

`pa say` writes into the session's PTY. termhub's HTTP API covers create/list/kill but input
goes over the `/ws/term/*` websocket, so `pa say` opens a short-lived websocket client — or,
better, **termhub grows a `POST /api/sessions/:id/input` route**. That is a small unit of work
in `termhub/`, and it belongs there rather than here: a plain HTTP way to type into a session
is useful to termhub's own UI and to anything else that ever drives an agent.

---

## 6. Dispatch modes

Autonomy is per task, decided when you dispatch, never a global setting.

| Mode | Session may | Stops before |
|---|---|---|
| `plan` | Read, search, write a plan and a diff sketch | Writing any code |
| `local` | Work in a worktree, commit locally | Anything touching the remote |
| `branch` | Push the branch | Opening an MR |
| `mr` | Push and open a **draft** MR | Marking ready, notifying anyone |
| `full` | All of the above, plus draft the reply | **Sending.** Always. |

Mechanics that hold for every mode:

- Every run gets its own **git worktree** (`../.pa-worktrees/<run-id>`), never the main tree.
  The repo agreement in the root `CLAUDE.md` is explicit that a dirty tree blocks termhub's own
  updater — dispatched work must not be able to cause that.
- The session starts with a generated **`BRIEF.md`** in the worktree: the ask in the requester's
  own words, the thread, the distilled commitment, the target repo's conventions, the relevant
  Raven knowledge (via the existing `innergy-knowledge` skill, not a second copy of it), and the
  mode's stop condition stated plainly.
- The mode's boundary is enforced by the dispatcher, not by asking the agent nicely. `local`
  runs get no push credential in their environment.
- A run that finishes announces through termhub's existing voice/ntfy path. A run that stalls
  waiting on input is exactly what termhub's idle tracking already measures.

---

## 7. Always-on capture

Decision: **always-on, both audio streams, batch post-processed hourly.** Manual and
calendar-triggered capture both fail the same way — the useful ten minutes is usually the
corridor conversation nobody scheduled.

### Two streams, not one

Capture the **microphone** and the **system loopback** (WASAPI loopback: everything the
speakers play) as *separate* files. This is the single highest-value decision in the capture
design, because it gives speaker attribution for free: the mic stream is you, the loopback
stream is everyone else. No diarization model, no misattributed quotes, and a distiller that
can tell "I promised" from "they promised" without guessing.

It also means a Teams call is captured whether or not the tenant allows transcripts, and
without a bot joining the meeting.

### The hourly cycle

Writing raw and trimming after the fact is more robust than trying to be clever in real time —
a VAD bug then costs you a bloated file, not a lost conversation.

```
continuous  →  16 kHz mono PCM per stream, rolled hourly
                ~115 MB/hour/stream, ~2.3 GB for a 10-hour day
     │
     ▼  on the hour (a graphile-worker job)
trim        →  Silero VAD; drop silence, keep 1.5 s of pre-roll before each speech run
     │         a normal day is ~10-20% speech, so ~250 MB/day survives
     ▼
episodes    →  group speech runs; a gap over 90 s ends an episode
     │         classify: calendar event running → meeting; Teams process in a call → call;
     │         voice-dictation active → dictation; otherwise ambient
     ▼
transcribe  →  faster-whisper via voice-dictation's existing transcribe_server (TCP, GPU)
     │         no second model, no second install
     ▼
store       →  Opus 16 kbps kept (~7 MB per speech-hour), transcript as a source_item,
               raw PCM deleted at the end of the cycle
```

`disk-janitor` already exists in this repo for exactly this class of aged, rebuildable data —
point it at the audio spool rather than writing new cleanup logic.

### Recording your own agent sessions — do it from the transcripts, not the audio

You asked for the Claude and OpenClaw sessions to be recorded too. Audio is the wrong source
for those, because the exact text already exists on disk:

- **Claude Code** writes a JSONL transcript per session. termhub already reads these to
  summarise turns for its spoken announcements — read `termhub/lib` before writing a parser.
- **OpenClaw** keeps its own session records in the gateway.
- **voice-dictation** already saves today's dictations locally, which *is* the prompt text you
  spoke, cleaned up.

So agent sessions are a normal ingest source (`source: claude_session`, `openclaw_session`)
with perfect fidelity and zero transcription error. The mic keeps capturing you thinking out
loud around them, which is the part no transcript has.

### Controls

Always-on is only tolerable with a hard off switch that does not depend on the assistant
working. Non-negotiable:

- `pa mic pause 30m` / `pa mic on` / `pa mic status`, plus a global hotkey that pauses both
  streams. Pausing stops *capture*, not just transcription.
- A visible indicator whenever capture is live. Not a config flag you have to remember.
- Calendar categories or keywords (`1:1`, `personal`, `HR`) that auto-pause capture.
- Raw PCM never leaves the machine and never reaches an API. Transcription is the local
  faster-whisper server. If a cloud model is ever used for distillation of audio-derived text,
  that is a separate, explicit decision.

### Why "uncomfortable" — the honest answer

Nothing technical. Two things:

1. **Other people are on the loopback stream.** You already record with a hardware recorder, so
   you have made this call for yourself; recording colleagues is a different call. US state law
   splits on one-party versus all-party consent, and INNERGY's own policy may say more than the
   law does. Practical mitigation that costs nothing: say you record meetings, once, out loud.
2. **Ambient capture catches the room**, including conversations that have nothing to do with
   work and people who did not opt into anything. That is what the pause hotkey and the
   auto-pause categories are for, and why the indicator has to be visible.

Neither is a reason not to build it. Both are reasons the controls ship in the same phase as
the capture, not a phase later.

---

## 8. Project → repo mapping

Both answers you gave are right, and they compose: **a table you almost never edit, kept
correct by a distiller that guesses and learns from your corrections.**

### The table maintains itself

You do not sit down and author a mapping. It is seeded, then corrected by exception.

**Seeded automatically** (`pa projects sync`):

- Every git remote under `C:\repos\*` → `project.repo_path` + `gitlab_path`.
- Every GitLab project you are a member of → name, path, description.
- Initial aliases from what already exists: repo directory name, GitLab project name, GitLab
  path slug, and the human-readable name from its README's first heading.

**Corrected by exception.** The distiller writes `project_id` with a `project_confidence`. Any
commitment below the threshold shows a `?` in `pa inbox`. Fixing it is one command:

```
pa show 42 --project estimating-api
```

That does two things: sets the commitment's project, and writes a `project_alias` row with
`origin: corrected` for whatever phrase the ask actually used ("the estimating rewrite").
The next message that says the same thing resolves without asking. So the table is maintained
by *using* it, and the only manual editing you would ever do is `pa projects` to rename or
retire something.

### What the distiller gets to reason with

Guessing well is worth investing in, as you said. Give it real signal rather than a name-match:

| Signal | Why it helps |
|---|---|
| Alias list, weighted by `origin` | Your own corrections outrank a seeded guess |
| Repos you touched in the last 14 days | Asks cluster around current work |
| Thread participants vs frequent authors of each repo | The person asking usually asks about their own area |
| Branch names, file paths, error strings in the message | Near-conclusive when present |
| Open MRs assigned to you | An ask during a review is almost always about that MR |
| The prior commitment in the same thread | Threads rarely change project mid-conversation |

Two rules keep it honest: it may answer **"unknown"** rather than guess (an unknown that asks
you once beats a wrong repo that a session then works in), and every guess stores its reasoning
so a wrong pattern is visible instead of mysterious.

---

## 9. Phases

Each phase is independently useful and independently abandonable. Estimates are working days
for one person who is also doing their actual job.

### Phase 0 — Prove the permissions (½ day)

Register the Entra app. Wire `Softeria/ms-365-mcp-server` into Claude Code read-only. Write a
`/brief` skill that reads today's mail and calendar and prints a summary. No database.

*Done when:* the device-code flow completes and Claude summarises your real inbox. If it fails
on consent, you have learned the most important thing about this project on day one.

### Phase 1 — Message capture and store (2–3 days)

Postgres in WSL2 Docker with pgvector. Migrations. `graphile-worker`. Delta-polling ingest for
mail, calendar and `Chat.Read` chats; GitLab ingest for issues, MRs and pipeline state. Raw
jsonb retained. `pa sync`, `pa doctor`.

*Done when:* `select count(*) from source_item` grows on its own and the cursors survive a
restart without re-fetching history.

### Phase 2 — Distill (1–2 days)

The extraction prompt and the typed writes. Identity resolution. `pa inbox`, `pa show`,
`pa who`, `pa brief`.

*Done when:* `pa brief` tells you something true that you had forgotten. That is the actual
acceptance test and it is not a soft one.

### Phase 3 — Always-on capture (2 days)

Dual-stream WASAPI capture, hourly VAD trim, episode grouping and classification,
transcription through voice-dictation's existing `transcribe_server`. The controls ship in this
phase, not later: pause hotkey, `pa mic`, visible indicator, auto-pause categories. Agent
sessions ingested from the Claude Code and OpenClaw transcripts, not from audio.

*Done when:* a corridor conversation you did not schedule shows up in `pa brief` as a
commitment, and the pause hotkey provably stops the writes.

### Phase 4 — Recall (½–1 day)

`pa-mcp` over stdio for Claude Code and HTTP for OpenClaw: `brief_me`, `search_context`,
`get_thread`, `open_commitments`, `who_is`, `repo_state`. Hybrid tsvector + pgvector, reranked.

*Done when:* an ordinary Claude Code session in an unrelated repo can answer "what did
[a colleague] ask me about this last week".

### Phase 5 — Dispatch (2–3 days)

The dispatcher: worktree, `BRIEF.md`, termhub session, run lifecycle, mode enforcement.
`pa do`, `pa runs`, `pa attach`, `pa say`, `pa review`, `pa land`, `pa drop`. Add the input
route to termhub.

*Done when:* a Teams ask becomes a reviewed diff without you typing the context twice.

### Phase 6 — Drafts (1 day)

`pa draft` composes the reply from the ask plus the run's diff and MR link. `pa send` is
interactive and explicit. `Mail.Send` / `ChatMessage.Send` scopes verified separately.

*Done when:* you send an assistant-drafted reply and change fewer than half its words.

### Phase 7 — OpenClaw front door (1–2 days)

Gateway in WSL2. A `pa` skill so the TUI drives the same CLI. Cron for the morning brief.
Optionally bind Telegram for phone access. Keep ACP available for throwaway one-shots — it is
the right tool when you will not need to attach.

*Done when:* you run a normal day from the OpenClaw TUI and only drop to `pa` for the unusual.

### Phase 8 — Only if earned

Onyx for connector breadth. Graphiti when you can name a question flat retrieval got wrong. A
Teams channel bot if the tenant ever allows it, so asks and answers share one thread.

---

## 10. Risks, in the order they will actually bite

1. **Distillation drift.** The first extraction prompt will be wrong, and every row it wrote
   will be wrong with it. Mitigation is structural: raw payloads retained, `extracted_by`
   stamped on every row, re-run over history when the prompt changes.
2. **Trust collapse.** One confidently wrong outbound message and the whole thing goes unused.
   Hence draft-only, for far longer than feels necessary.
3. **Consent.** May cap v1 at GitLab plus meetings. The architecture does not change; the
   inputs do. Find out in phase 0.
4. **Distillation cost.** An LLM pass over every inbound item adds up. Route it to a small fast
   model, batch it, skip anything under a length threshold, and never re-distill an unchanged
   `content_hash`.
5. **Windows-only fragility.** node-pty, worktrees, path separators, and WSL/Windows networking
   are each a small tax, paid repeatedly. termhub already solved most of these — read how it did
   it before solving them differently.
6. **The dependency that stalls.** Half the landscape surveyed on 2026-09-01 had stopped
   shipping. Keep OpenClaw behind the `pa` CLI, so it can be cut without touching the store.

---

## 11. Open questions

*Resolved 2026-09-01:* repo mapping (§8 — seeded table, distiller guesses, corrections become
aliases) and capture trigger (§7 — always-on, dual-stream, hourly batch).

- **Audio retention.** Trimmed Opus is small enough to keep indefinitely; raw PCM is deleted
  each cycle. Is there a case for deleting trimmed audio once transcribed? The transcript is
  what gets used; the audio is only there for when the transcript is wrong.
- **Loopback and headphones.** WASAPI loopback captures the render endpoint, so it follows the
  default output device. Switching to headphones mid-call must not silently stop capture —
  needs a device-change watcher, and `pa doctor` should assert both streams are live.
- **Multi-machine.** Everything is on one box by decision. If a second machine ever runs
  dispatched work, the run table needs a `machine` column and termhub is already per-machine —
  design the column in now, use it later.
- **Retention.** 180 days for raw items is a proposal, not a decision.
