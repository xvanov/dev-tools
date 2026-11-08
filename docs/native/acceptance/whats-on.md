# Acceptance review: `whats-on` (plan 8.3)

**Verdict: FAIL.** The question is answered locally and costs $0. But the answer is wrong (it
speaks tomorrow's meetings as today's), and every latency hop misses its target. First audio
takes 1.3-2.6 s against a target of 0.7 s.

| | |
|---|---|
| Date | 2026-11-08, 19:51-19:58Z (Sunday afternoon, local time) |
| Stack | work (this Windows laptop), PA on :7300 |
| Commit served | `c0c2a3eca717ee61ad8ba766f1e038a7ee6c0dad` (GET /api/version) |
| Reviewer | a fresh session that did not implement the workflow (D10) |
| Criteria | `architecture.json` → `examples[whats-on].acceptance` |

## How it was run

1. `node bin\pa.js e2e whats-on --dry-run` from the live checkout: OK. The map has the block,
   /api/workflow-limits gives an effective ceiling of $0, TTS is up, and the fast lane is on.
2. `node bin\pa.js e2e whats-on`, three times, 10 s apart. Each run: Kokoro speaks "What's on
   today?", the WAV goes to POST /api/talk/transcribe, then /api/talk/turn (NDJSON), then
   /api/talk/tts on the first sentence. The PA spend is read before and after.
3. A direct probe repeated each hop 10 times back to back (an untracked script, not in the repo).
   It sent a 16 kHz mono WAV of "What's on today?" (written by System.Speech) to
   /api/talk/transcribe, the same audio as L16 PCM to /api/talk/endpoint (smart-turn), and the
   text to /api/talk/turn (timing the first delta and the first full sentence), then sent the first
   sentence to /api/talk/tts (timing the first byte). All requests went to 127.0.0.1 with `X-PA: 1`.
4. Facts: I rebuilt the fast lane's own snapshot (`fastLane.snapshotCache().get()` at the served
   commit), read `pa brief`, and read the raw `occurred_at` of the calendar rows behind both
   (`sources.calendarToday()`).
5. Cost: `pa spend`, and the `llm_spend` breakdown since 19:51Z.

## Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `local`: answered by the fast lane, no Claude call, no metered spend | **pass** | 13 of 13 turns (3 e2e + 10 probe) took route `answer` (router p(answer_here) 0.999, threshold 0.85) on `local/llama3.2:3b`. None handed off. `llm_spend` since 19:51Z has 13 `fast-lane` rows, all on the local model, all $0, and no Claude-model rows. e2e cost: $0 of a $0 ceiling in all three runs. |
| `speed`: first audio under 0.7 s from end of speech | **fail** | e2e: **1792 ms** median (1330, 1792, 2619), and that excludes the talk-page hop. Summing the probe medians gives ~1.6 s: talk-page ≥317 + transcribe 256 + first sentence 728 + TTS first byte 302. |
| `facts`: every event, time and name matches the snapshot, nothing invented | **fail** | All 13 turns gave the same answer: "You have a meeting at 10:00 with <meeting title>, and you also have a standup at 11:00 with <team>." The facts are wrong in three ways, listed below. |

The three ways the answer is wrong:

- **Wrong day.** The snapshot says "Now: Sunday 8 November at 14:53", then "Meetings (next 24h):
  04:00 <cancelled meeting>, 10:00 <meeting A>, 11:00 <team> Standup, 11:30 <meeting C>". Every
  row is **Monday 9 Nov** (`occurred_at` 04:00, 10:00, 11:00, 11:30 EST). Nothing is left on
  Sunday. The model can't tell, because the snapshot gives no day per meeting. `pa brief` prints the
  same four rows under "TODAY".
- **Invented attendees.** "with <meeting title>" and "with <team>" present meeting titles as
  attendees. The snapshot has no attendees.
- **A meeting left out.** The 11:30 meeting (18 attendees in the brief) is not mentioned.

## Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: answered aloud from the cached snapshot, locally, nothing sent to Claude | **fail** | It is local and is spoken, but the answer is wrong (facts above). |
| Cost ≤ $0 | **pass** | $0 in all runs (spend delta and `llm_spend`). |
| Views: ask | **not evidenced** | `screenshots/ask.png` shows the idle Talk page. The e2e drives the API, not the page, so no screenshot shows the turn in the Ask view. |
| Approvals: none required | pass | No prompt or approval in any turn. |

## Hops

The probe numbers are warm and back to back. "e2e" is the three `pa e2e` runs.

| Hop | Target | e2e (3 runs) | Probe (10) | Combined median | Result |
|---|---|---|---|---|---|
| talk-page: end of speech to transcription request | 150 ms | not measured (the browser does VAD and smart-turn) | smart-turn /api/talk/endpoint 221 ms (96-459), plus the VAD wait of 96 ms (certain) or 200 ms | **≥ 317 ms** (lower bound) | **fail** |
| whisper: transcribe | 250 ms | 457, 259, 526 (server `ms`) | 246 (190-405); request 256 (201-471) | **259 ms** of 13 (190-526) | **fail** |
| fast-lane: route and stream the first sentence | 200 ms | first delta 822, 234, 248 | first delta 227 (192-328); **first sentence 728 (626-843)**; router 75 (64-176); whole turn 750 (643-866) | first delta 246 of 13; first sentence 728 of 10 | **fail** |
| voice: end of speech to first audio | 700 ms | 2619, 1330, 1792 (TTS first byte 734, 381, 545) | TTS first byte 302 (247-373) | **1792 ms** e2e; ~1.6 s from the probe | **fail** |

What the e2e can't measure, or measures low:

- **talk-page:** the browser's VAD and smart-turn hop is not measured. I measured its server half
  (/api/talk/endpoint). The VAD wait comes from `TURN_DEFAULTS` in `talk.core.js` (sureCheckMs 96,
  checkMs 200).
- **fast-lane:** the e2e times the first token, not the first sentence the hop names. The probe
  timed both.
- **voice:** the e2e starts its clock at the transcription request, so it leaves out the
  talk-page hop. That makes 1792 ms a lower bound for the real path.

## Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\`:

- `20261108T195146Z-whats-on-dry/summary.json`: the dry run.
- `20261108T195150Z-whats-on/`, `20261108T195200Z-whats-on/`, `20261108T195210Z-whats-on/`: each
  has `summary.json`, `transcripts/turn.txt`, `transcripts/turn.ndjson` and `screenshots/ask.png`.

Probe output (local, untracked): `C:\Temp\whatson-probe-out.json`.

## Defects (filed under 8.4 in PLAN.md)

1. **8.4.1** Tomorrow's meetings are spoken as "today". The snapshot (and `pa brief`) labels a
   rolling 24 h window with bare times. Fix: put the local day on each meeting, or split them into
   Today and Tomorrow.
2. **8.4.2** The answer presents meeting titles as attendees and leaves out a meeting. Fix: tighten
   the answerer prompt and add eval cases.
3. **8.4.3** The fast lane takes 728 ms to the first sentence (target 200). Fix: lead with a short
   clause, start TTS at a clause boundary, and get the first token under 200 ms.
4. **8.4.4** Whisper takes 259 ms (190-526) against a target of 250, with 400-530 ms after an idle
   gap. Fix: keep the model warm and tune it.
5. **8.4.5** Smart-turn alone takes 221 ms, so the talk-page hop is at least 317 ms (target 150).
   Fix: make the endpoint faster, or transcribe while smart-turn decides.
6. **8.4.6** First audio takes 1.6-1.8 s (target 700). Kokoro's first byte alone is ~300 ms, and
   the hop targets leave it only ~100 ms.
7. **8.4.7** The e2e understates or misses hops (first token rather than first sentence, TTS only
   after the whole turn, no talk-page hop) and the Ask screenshot doesn't show the turn.
