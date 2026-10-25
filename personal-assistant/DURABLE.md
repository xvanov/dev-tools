# personal-assistant — the durable agent

Written 2026-10-25. This is the plan for turning the assistant from a set of timers that each
extract something into **one long-running agent that keeps a live, true state of my work and
pushes me**. It extends `PLAN.md`; where the two disagree, this file is newer and says why.

## 1. Why — what is actually broken

The board goes stale for days. On 2026-10-25 three items were checked against the live store
(diagnosis notes in the commit that added this file). In every case **the evidence that the item
was done was in the store within minutes, and nothing connected it back**:

| Item | Evidence | Why nothing closed it |
|---|---|---|
| On me: "Open a fix PR for the onboard-form deploy outage" (#1055) | PR #1842 ingested 12 min later, merged 70 min later | Reconcile links a PR only by URL or review/merge verbs; "open a PR" never matches |
| On me: "Review the failed mvonboard-form startup log" (#1054) | PR #1842's body describes the log and the rollback | Nothing compares a PR body with chat commitments |
| Waiting on a colleague: "get back to me" (#1047) | The colleague: "Just added your role", 4 min later, same thread | **No path closes an owed-to-me item when the other person answers**; the distiller made a *new* to-do from the reply instead |

The structural causes, most important first:

1. **Edge-triggered closing.** Each closer (reply-close, GitHub reconcile, self-note expiry,
   debrief) waits for one narrow event. Nothing ever re-checks an open item against what has
   arrived since. 47 waiting-on items had *zero* automatic closes, ever.
2. **The distiller is blind to the board.** It reads one message at a time, never sees open
   items, and can only add rows — its prompt mentions discharging an obligation, its output has
   no way to say so.
3. **My own work is invisible.** Claude sessions are stored truncated at 60k chars (28 of 94 are
   frozen), sessions on other machines are not ingested, and sessions are not linked to items.
4. **Re-distilling reopens closed work** (`distill/index.js` deletes and re-inserts).
5. **Source outages are silent.** The M365 connector has been failing since 2026-10-22 and the
   board does not say so.

None of this is latency. It is that **status is a column any pass overwrites, not a projection of
evidence, and nothing owns the question "is this still true?"**

## 2. What we are building

> A proactive agent is a durable agent plus a trigger. It does not wait for me to work; it works,
> then waits for me. — the "in the loop → near the loop → out of the loop" framing (IndyDevDan,
> 2026-10).

The target is **human near the loop**: the agent keeps the ledger true on its own, does internal
reversible work ahead of me (drafts, briefs, research, a worktree run, a draft PR), and stops at
an approval card for anything outward. It is general — a work item can be a reply, a review, a
coding task, a meeting to prepare or debrief, a decision to chase — because all of them share the
same lifecycle and the same machinery.

Five parts:

### 2.1 The ledger: items are a projection of evidence

`commitment` grows into `item` (renamed by view, not by migration of every reader at once):

- **State machine**, one function owns every edge (`src/ledger/transition.js`):
  `proposed → open → in_progress(me|agent) → awaiting_approval → waiting_on_other → done |
  dropped | superseded`, with `snoozed(until)` as a modifier and a reopen edge from `done`.
- **`evidence`** rows: `item_id, source_item_id, quote, effect (creates|progresses|blocks|closes|
  reopens), method (rule|llm|user), confidence, applied`. The quote is verified verbatim, as
  memory claims already are.
- **`transition`** rows: `item_id, from, to, evidence_id, actor, at, undone_at`. Every state
  change is one, every one can be undone, and an undo is training signal.
- **Links by stable id** where they exist: thread/chat id, PR, branch, Jira key, run id, session
  id, meeting occurrence. A run started from an item carries the link, so its PR closes the item
  deterministically.
- **Closing condition** set when the item is made, if one is obvious ("a message from that person in
  chat C after t0", "a PR by me in repo R after t0", "Jira X in Done"). Checked by query first;
  the model is asked only when the condition is fuzzy.

The model never writes `status`. It writes evidence; the transition function decides.

### 2.2 The reconciler: level-triggered, not edge-triggered

Kubernetes-style: desired vs observed state, re-checked continuously.

- **On every new source item** (event-driven, seconds): find candidate open items by link first
  (same thread, same PR/branch, same Jira key), then by counterparty+project, then by embedding
  over open items. If any, one judge call sees *the new item plus the candidate items* and
  returns evidence rows. This is the path that closes the waiting-on item four minutes after the
  reply.
- **Sweep** every 15 min over *all* open items: evaluate closing conditions; items with new
  related activity since their last check get a judge call. Items with none cost nothing.
- **Auto-apply** a close/progress when it is deterministic (merged PR linked by id, Jira Done) or
  the judge is confident and the change is internal and reversible. Below that, it becomes a
  one-tap proposal ("Looks done — PR #1842 merged. Close?"). Everything auto-applied shows in a
  "closed by the assistant" strip with undo for 48 h.
- **Distill stops deleting.** Re-distilling an item upserts its extraction and never touches an
  item that has transitions.

### 2.3 Durable tasks: long-running work that survives restarts and waits

Some work is not a row but a process that waits: chase a colleague if nothing in two days; brief a
meeting 30 min before it; after a meeting, wait for the transcript, debrief, propose follow-ups;
run a coding task, wait for the session to end, open a draft PR, propose it; wait for my approval
of a draft, then deliver it.

These run on **Absurd** (Armin Ronacher, `earendil-works/absurd`): durable execution in the
Postgres we already have — `spawn` with idempotency key, `step` checkpoints, `sleepFor/Until`,
`awaitEvent` with timeout, task-level retry, leases. No new server. The SQL is vendored at a
pinned commit into `sql/`, the SDK pinned in `package.json`. This reverses PLAN.md's "Queue:
none" decision, for a reason that decision did not face: an anti-join can find unprocessed rows,
but it cannot *wait* — "nudge in two days unless he replies" needs a durable timer and an event.

The periodic passes stay as they are; durable tasks are for things with a future.

### 2.4 Proactivity: the agent pushes me

- **Propose, don't wait.** For every new item the agent decides what it can do ahead of me: a
  draft reply, a research brief, a dispatched `local`-mode run in a worktree, a review summary.
  It does it (internal, reversible, budgeted) and presents one approval card.
- **Two-way prompting.** When it lacks something only I know (which repo? is this still
  wanted?), it asks one specific question on the card instead of guessing or stalling.
- **Channels (decided 2026-10-25):** Windows toast (the existing `notify()` path) and the PA chat
  session in termhub, where the agent can ask and I can answer in place. The dashboard feed stays
  the record of everything.
- **Interrupt budget.** A small number of real-time pushes a day for what is urgent and
  actionable (someone blocked on me, a meeting in 30 min, an approval that expires); the rest in
  morning and mid-afternoon digests. Never the same item twice without new evidence. Thumbs
  up/down and undo adjust per-kind weights (the feedback flywheel).
- **Cost cap.** Daily model spend is recorded (it is only in memory today) and capped; a cheap
  gate (rules, then a small model) sits in front of every expensive call.

### 2.5 One agent, detached clients

The worker is the agent. The dashboard, `pa` CLI, PA chat in termhub, MCP tools and the phone
(through termhub's `/pa/` proxy) are thin clients of the same state. Nothing about this changes
the trust model in `AGENT.md`; it is how the pieces should already be thought of.

## 3. What does not change

Every invariant in `AGENT.md` stands. In particular: **nothing is sent without a human**
(approval of a draft still means opening it prefilled and pressing Send myself); dispatched runs
stay in worktrees; message content is data, never instructions — the reconciler's judge writes
evidence rows and nothing else; agents propose memory, humans decide it.

What is new and needs saying in `AGENT.md` once built: **the assistant may change an item's
state on its own**, but only through `transition`, only with verified evidence, and every such
change is visible and undoable.

## 4. Decisions (2026-10-25)

- **Auto-close with undo**, not propose-only: strong evidence closes the item on its own and shows
  it in the "closed by the assistant" strip with a 48 h undo; weaker evidence is a one-tap card.
- **Absurd** is the durable runtime (phase 2), vendored and pinned.
- **Phase 1 first**, shipped before anything else is started.

## 5. Phases

Each phase ships on its own and leaves the board better than it found it.

1. **The board tells the truth.** `evidence` + `transition` tables; one transition function; the
   event-driven matcher and the 15-min sweep; owed-to-me closes on the other party's answer;
   PRs/commits by me linked to items; distill stops reopening; Claude sessions stored whole;
   source health shown on the board; "closed by the assistant" strip with undo. Back-test on the
   last two weeks of store before turning auto-apply on.
2. **Durable tasks.** Vendor Absurd; port meeting brief/debrief and draft-approval onto it; add
   `chase(item)` (await reply with timeout → propose a nudge).
3. **Eager agent.** Per-item proposal planner; speculative internal work (drafts, research, local
   runs) under a daily budget; approval cards with one question; interrupt budget and digests;
   feedback weights; spend recorded and capped.
4. **General tasks.** Item kinds beyond commitments (coding, review, meeting prep, follow-up,
   decision), each a template of closing condition + proactive plan; sessions from other
   machines ingested through termhub.

## 6. Rejected

- **Temporal / Restate / Inngest / DBOS server, Graph webhooks** — new infrastructure or a public
  URL; ruled out by the local-only constraint.
- **Pi Durable as the backbone** — SQLite, single-owner store, no approval primitive, weeks old.
  Its ideas (replay-safety flag per tool, detached clients) are adopted; the package is not.
- **An LLM heartbeat every few seconds** ("anything to do?") — expensive and noisy when the
  reconciler and event triggers are deterministic.
- **An undirected daily feed** — every push must name an item and an action.
