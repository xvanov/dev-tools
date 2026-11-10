# Acceptance review: `teams-ask` (plan 8.3)

**Verdict: PASS (live run 2026-11-10, see the last section).** Earlier verdict: FAIL. The outcome was not shown: no test ask reached the board, because nothing
could put one into the self chat. `pa e2e teams-ask` has no real-run driver. With
`--test-chat` it still exits "not automated yet", and neither the e2e nor the PA can send a
Teams message (the PA only opens a draft in the Teams client for you to press Send). Typing
into the Teams window by automation could land in whichever chat has focus, so the review sent
nothing, as the owner's rules require.

The hops it could measure on the live stack fail as well:

- The one self-chat message stored today took 9.1 s from cache change to source_item (target
  5 s).
- A new card takes about 1.1 s to reach the board (target 200 ms).
- The toast hop does not exist: no code notifies when a commitment is distilled.

The store also shows two ingest defects that break the `link` and `person` criteria on real
asks:

- Teams' pending local copy of a message (id `-1`) is stored as its own item.
- Teams' system threads (drafts, mentions, notifications) are stored and distilled as group
  chats.

## Re-run, 2026-11-10: still FAIL (outcome not shown live)

All eight 2026-11-08 defects (8.4.30-37) are fixed and ticked. This re-run could not send
anything (the PA has no Teams send path; D-log: M365 is read-only), so the real run, which waits
for the owner to type its phrase, was not driven.

- `pa e2e teams-ask --test-chat 48:notes --dry-run`: map 2/2, run 6/6 (served commit `3b28b1d`).
- Real recent ask, card #6803 (Teams chat, 4 h old, distilled by the served model): links to a
  real message id (`link` pass; no `-1`), no system thread. `person` was the bare address
  `a.colleague@example.test`: the Teams cache gives an author's address and no name, so the new
  person row took the address as its name. **Fixed** in `distill/identity.ts` (`nameFor`: a
  first.last address becomes "First Last"; a person filed under an address is renamed when a name
  is known), test `identityName.test.js` (b822931). Cards already stored keep the address until
  their person is next resolved. `due`: the message states no deadline, so none is right
  (not scored).
- Ingest: today's teams-cache passes take 25-330 ms (was 8.7 s). Notify: `new_ask` rows exist
  live (kind, budget and quiet-hours digest all working: "quiet hours", "budget 4 spent").
- Later hops, read against Build (one Claude Code agent per task, D30) rather than the old
  factory: unchanged by this flow; no reply-send hop (a Teams reply is copy and open Teams).
- Not measured live: board hop (~50 ms bus + state build 43 ms, 8.4.33) and the end-to-end
  timing from a typed message.

To pass: the owner runs `pa e2e teams-ask --test-chat 48:notes` and types the printed phrase.

| | |
|---|---|
| Date | 2026-11-08, 21:50-22:05Z |
| Stack | work (the Windows laptop): PA on :7300 (jarvisd generation 4), Teams cache reader resident |
| Commit served | `bd7b7686dddb7138e33355e2938d56a0f545fe27` (GET /api/version) |
| Input | none sent. The test chat is the owner's self chat (Teams' notes thread). Only the owner has ever written there: the store holds 2 items, both his, from 19:28Z today, and no other author. |
| Reviewer | a fresh session that did not implement the workflow (D10) |
| Criteria | `architecture.json` → `examples[teams-ask].acceptance` |

## How it was run

1. `node bin\pa.js e2e teams-ask --test-chat <the self chat> --dry-run` passed **4 of 4** checks:
   the Map block, the $0.05 ceiling (`/api/workflow-limits`), 2 Teams sources ingesting, and
   `/api/state` answering. It does not read `--test-chat`, so it does not check that the chat
   exists or that you are its only member.
2. `node bin\pa.js e2e teams-ask --test-chat <the self chat>` exits 1 in under 2 s: "a real
   teams-ask run is not automated yet … 8.3's reviewer drives it by hand". `RUNNERS` has no
   `teams-ask`, and `parse()` reads `testChat` but nothing uses it.
3. Driving it by hand needs a message in the self chat. The PA has no Teams send path (`pa send`
   opens the draft, written, in Teams; you press Send). So I stopped there and sent nothing.
4. Instead, I measured each hop on what the live stack already had, without writing to the
   store:
   - **Store reads:** queried read-only (`source_item`, `distillation`, `commitment`,
     `event_outbox`, `notification`, `llm_spend`). Only aggregate numbers are given here.
   - **Ingest:** the teams-cache pass that stored the owner's self-chat message (19:28Z), from
     the worker log.
   - **Board:** one local probe card (`pa task add`, which messages no one), timed through
     `/api/events?topics=board` and `GET /api/state` (8 fetches). Dismissed afterwards with
     `pa done 6775 --dismiss`.
   - **Card fields:** what a Teams card carries in `GET /api/commitments/<id>` (`who`,
     `due_at`, `web_url`), checked on recent real cards.
5. Cleanup: the probe card is dropped, and nothing was left in the self chat. The e2e created
   nothing, so there was nothing else to remove.

## Rubric

No test ask exists, so each criterion is scored on whether the workflow showed it (it did not),
with the live data alongside. Live data: the 70 Teams-sourced `owed_by_me` commitments distilled
since 1 November.

| Criterion | Result | Evidence |
|---|---|---|
| `person`: the card names who asked | **fail** (not shown) | Live: 50 of 70 name a person. 9 of the 70 come from Teams' system threads, and a draft's card names its author, the owner (below). For a self-chat ask, the code names the item's author (the owner) when the model gives no counterparty (`distill.resolveReferences`). |
| `due`: the absolute date the message implies | **fail** (not shown) | Live: 2 of 70 have a due date. I read the 16 undated ones whose message has a day word ("today", "Friday", "next week"…): 12 state no deadline for the owner, and 4 (from two messages) are borderline ("early next week", "after Tuesday's release"). So no extraction defect is filed from this data. |
| `link`: the card links to the source message | **fail** | Live: all 70 carry a Teams deep link (`web_url`), but 6 point at message id `-1`, which opens no message. Across all Teams items, 39 rows have id `-1`, and 16 of them were distilled into 37 commitments (6 still open), all with that broken link (8.4.34). |

## Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: a Teams ask becomes a card with the right person, due date and link | **fail** | Not shown (above). |
| Cost ≤ $0.05 (one distill call) | **fail** (live data; no call this run) | `llm_spend`, purpose `distill`, all sources. On the served model (`claude-sonnet-5-5`, since 6 Nov): 206 calls, **49 over $0.05** (24%), max $0.082. Today: 17 calls, mean $0.020, max $0.038. The code default `PA_DISTILL_MODEL=claude-opus-5` costs $0.058-0.074 per call on average (1022 calls, 5-6 Nov; 730 over). |
| Approvals: none | **pass** | The acceptance block lists none, and nothing in the path asks. |
| View: run | not shown | No screenshots: there is no runner. |
| View: ask | not shown | No screenshots: there is no runner. |

## Hops

| Hop | Target | Measured | Detail | Result |
|---|---|---|---|---|
| ingest: cache change to a stored source_item | 5000 ms | **9055 ms** (the pending copy: 9250 ms) | The owner's self-chat message arrived at 19:28:30.045Z and was stored at 19:28:39.100Z. That pass read 6.5 MB of LevelDB tables in **8725 ms**, 49 s after "watcher missed a change — re-arming". It logged `lagSeconds: [0.5, 0.3, 0.3]`, because lag is counted from the pass's start, not from the write. It was the only pass in today's log that stored new messages. For 5-8 Nov, `fetched_at` puts 3 of 87 cache-read rows within 5 s (median 488 s). That is an upper bound: `fetched_at` also moves when the connector later upgrades a row (8.4.32). | **fail** |
| commitments: distill to an `owed_by_me` commitment | unbounded | not reached | The two self-chat messages are 11 characters, and distill reads only items of 40 or more (`MIN_BODY_CHARS`). So does the Map's own example ask, at 38 characters (8.4.36). The owner's own messages are also never "fresh" (`teamsLocal.isFresh`), so a self-chat ask waits for the next distill tick. Live Teams asks, stored to distilled: median 82 s, p90 473 s (n=52). | — |
| dashboard: commitment to the card on the board | 200 ms | **~1.1 s** | Probe card #6775: the row and its `event_outbox` entry were written together (22:01:34.886Z). The server's bus emitted the board event at 22:01:35.297Z (**411 ms**, a write from another process), and the page's feed got it 4 ms later. The board then refetches `GET /api/state`: **median 716 ms** over 8 fetches (430-1249). A distilled insert in the worker's own process would skip most of the 411 ms; the refetch alone is still 3.5× the target. | **fail** |
| notify: card to toast | 5000 ms | **never** | Nothing calls `notify()` when distill inserts a commitment (`distill/index.ts`, `worker.ts`), and the budget has no kind for a new ask. No notification kind in the table is for a new commitment (`chase:` rows chase asks owed to you), and the probe card made none. INBOX.md is built from notifications only, so the chat is not told either (8.4.31). | **fail** |

## Evidence

On the laptop:

- `%LOCALAPPDATA%\personal-assistant\e2e\20261108T215149Z-teams-ask-dry\summary.json`: the dry
  run (4/4).
- `%LOCALAPPDATA%\personal-assistant\e2e\20261108T215643Z-teams-ask\summary.json`: the real
  run's "not automated yet".
- `%LOCALAPPDATA%\personal-assistant\logs\supervisor.log`, 19:27:50-19:28:51Z: the re-arm, then
  the 8725 ms teams-cache pass that stored the self-chat message.
- The store (`pa.sqlite`), read-only: the queries above. They were run by throwaway scripts
  outside the repo (removed), and only aggregates are reported.

## Defects (filed under 8.4 in PLAN.md)

1. **8.4.30** `pa e2e teams-ask` has no real-run driver and ignores `--test-chat`. The dry run does
   not check the chat (exists, you are its only member). Nothing can put the input in, so the
   runner should wait for the owner's own message in the named self chat (with a marker) and
   time from its arrival.
2. **8.4.31** No toast for a new ask. The Map's notify step and hop have no code behind them.
3. **8.4.32** The ingest hop is 9.1 s on today's only sample, and the log hides it.
4. **8.4.33** The board hop is ~1.1 s: the `/api/state` refetch takes 716 ms, plus 411 ms
   from the outbox to the bus for a write from another process.
5. **8.4.34** The cache's pending copy (message id `-1`) is stored as its own item. It gives cards
   a link that opens nothing, and duplicate cards.
6. **8.4.35** Teams' system threads (drafts, mentions, notifications, threads, call logs) are
   stored as group chats and distilled. A draft's card names the owner and links to the drafts
   thread.
7. **8.4.36** Distill skips messages under 40 characters, and the Map's own example ask is 38.
8. **8.4.37** The distill cost breaks the $0.05 ceiling: 24% of calls on the served model, and
   most calls on the code default.

## Live run, 2026-11-10 23:21Z: PASS (outcome shown)

M365 connector reconnected; the owner typed the printed phrase into the self chat (48:notes);
`pa e2e teams-ask --test-chat 48:notes` followed it on serving commit `0b9ca36`, sending nothing.

- ingest: 751 ms, cache change to source_item #761133 (target 5 s) - ok.
- commitments: 5.2 s to an owed_by_me commitment - ok (no target).
- card #6821 on the board; card checks 4/4: the person is you, due Friday 13 November 2026,
  the link opens the source message. Card dropped by the run's cleanup.
- dashboard hop 289 ms against 200 ms: measured seconds after a cold restart of the whole PA
  (supervisor and generation 1 new); the earlier warm figure was about 1.1 s, so this is still
  the slowest hop and the one to watch.
- notify: held by design. The run was at 18:23 local, inside quiet hours / the interrupt budget,
  so the toast went to the delivery digest. Re-run inside working hours to time the toast hop.
- cost $0.074 against $0.05: the PA spend delta over the run window, which here includes the
  catch-up passes of a freshly restarted PA (the summary notes this); the distill call itself is
  in the $0.005-0.03 range.

The outcome (an ask in Teams becomes a card with the right person, due date and link) is shown
live, so the verdict is pass. Open: the 200 ms dashboard hop and a working-hours toast timing.
