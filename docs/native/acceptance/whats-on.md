# Acceptance review: `whats-on` (plan 8.3)

## Re-review, 2026-11-08

**Verdict: FAIL, on latency only.** `local` and `facts` now pass. In 9 of 9 turns the answer
was right ("There are no meetings today."), answered locally, at $0. `speed` and three of the
four hops still fail, all on time. Medians of 9 runs, against their targets:

- whisper: 565 ms against 250, so **315 ms over**.
- fast-lane: 669 ms to the first piece against 200, so **469 ms over**.
- voice (the `speed` criterion): 1807 ms from end of speech to the first audio byte against
  700, so **1107 ms over**. The best run took 1264 ms (564 ms over).

The talk-page hop passes: 108 ms against 150.

| | |
|---|---|
| Date | 2026-11-08, 21:51-22:10Z (Sunday 16:51-17:10 local) |
| Stack | work (this Windows laptop), PA on :7300 |
| Commit served | `bd7b7686dddb7138e33355e2938d56a0f545fe27` (GET /api/version). It includes 8.4.1-8.4.7 (1679fbd, 4b7b73e, c422e41) and the SQLite stall fixes (118352f, 0baaaf2) |
| Since the first review | pa-voice (Kokoro and smart-turn) restarted, TTS on cuda. Ollama runs with OLLAMA_NUM_PARALLEL=2, with llama3.2:3b loaded |
| Load | other work on the laptop: CPU at 1-90% during the runs (77% at 21:52Z, 11% at 22:02Z, 1/51/78% before runs 7/8/9, 90% at the probe) |
| Reviewer | a fresh session that did not implement the workflow or its fixes (D10) |
| Criteria | `architecture.json` → `examples[whats-on].acceptance` |

### How it was run

1. `node bin\pa.js e2e whats-on --dry-run` from the live checkout: OK. The map has the block,
   the effective ceiling is $0, TTS is on cuda, and the fast lane is on.
2. Nine real runs of `node bin\pa.js e2e whats-on`, 50-60 s apart, from 21:51Z to 22:09Z. The
   e2e now replays the talk page in real time (c422e41). Kokoro speaks "What's on today?". Then
   it calls /api/talk/warm, waits out the question's length and then the 96 ms VAD wait, sends
   /api/talk/endpoint and /api/talk/transcribe together, sends /api/talk/turn, and sends
   /api/talk/tts at the first piece while the turn still streams. The clock starts at the end
   of speech.
3. Two more runs with `--question "What's on tomorrow?"` (22:02Z, 22:03Z). Nothing is left
   today, so the default question cannot test 8.4.2 (every meeting named, titles as titles).
   Both were handed off, so those two questions went to the main (subscription) session. They
   are not part of the scored runs.
4. Facts: I printed the fast lane's own snapshot (`createSnapshotCache().get()` at the served
   commit) and `pa brief`, and read the raw `occurred_at` of the calendar rows behind both
   (`sources.calendarToday()`). I also ran `pa eval answerer` (local, $0).
5. Cost: the e2e spend delta, `pa spend`, and the `llm_spend` rows since 21:51Z.
6. A direct probe, run back to back (an inline script, nothing written to disk). It sent 10
   transcriptions of the same WAV after one /api/talk/warm, then 10 TTS calls of the five-word
   first piece, timing the first byte. It shows what whisper and Kokoro cost outside the page's
   order.
7. The serving generation's log (`supervisor.log`), checked for event-loop blocks during the turns.

The e2e now measures all four hops. It leaves out two small pieces: Silero's 32 ms frame before
the silence wait, and the browser starting playback after the first byte. Both add time, so the
voice numbers are lower bounds.

### Rubric

| Criterion | First review | Now | Evidence now |
|---|---|---|---|
| `local` | **pass** | **pass** | 9 of 9 turns took route `answer` (p(answer_here) 0.993-1.0, threshold 0.85) on `local/llama3.2:3b`. `llm_spend` since 21:51Z has 9 `fast-lane` rows, all local and $0, and no Claude rows. The other rows are background passes: 13 local `eval` rows (my eval run) and three Azure embed and extract rows, about $0.000001 in all. The e2e spend delta was $0 in every run, against a $0 ceiling. |
| `speed`: first audio < 700 ms | **fail**: 1792 ms (1330-2619), without the talk-page hop, TTS after the whole turn | **fail**: **1807 ms** (1264-3608), the whole path, TTS at the first piece | Per run: 1807, 2110, 3608, 1718, 3555, 2652, 1360, 1264, 1285. Runs 3, 5 and 6 are the slow ones: whisper at 1350-1912 ms in two of them, an event-loop stall in the other (defect 8.4.38). |
| `facts` | **fail**: tomorrow's meetings spoken as today's, titles given as attendees, one meeting left out | **pass** | Below. |

The facts check:

- **Calendar.** At 16:51-17:10 on Sunday nothing is left today. All four rows in the 24 h window
  are Monday 9 Nov (`occurred_at` 04:00 (cancelled), 10:00, 11:00 and 11:30 EST).
- **Snapshot.** It reads: "Now: Sunday 8 November at 16:53. Meetings today (Sunday 8 November):
  none left today. Meetings tomorrow (Monday 9 November) until 16:53, 3: 10:00 "<meeting>";
  11:00 "<meeting>"; 11:30 "<meeting>". Cancelled: 04:00 "<meeting>"." This matches the
  calendar. `pa brief` prints the same four rows under TOMORROW, with no TODAY section.
- **Answer.** 9 of 9 turns said "There are no meetings today." That is right. It invents no
  name, does not read tomorrow's meetings as today's, and leaves nothing out of today.
- **Naming meetings (8.4.2).** I could not exercise this by voice today (see 8.4.39).
  `pa eval answerer` at the served commit passed 12 of 12 answers on 6 placeholder day snapshots.

### Other acceptance items

| Item | First review | Now |
|---|---|---|
| Outcome: answered aloud from the cached snapshot, locally, nothing sent to Claude | fail (wrong answer) | **pass** (spoken via /api/talk/tts in all 9 runs) |
| Cost ≤ $0 | pass | **pass** |
| Views: ask | not evidenced | **not evidenced**: `screenshots/ask.png` still shows the idle Talk page ("Tap once to enable Jarvis"), not the turn (the rest of 8.4.7) |
| Approvals: none required | pass | pass |

### Hops

The "now" columns are medians of the 9 e2e runs, with the range in brackets.

| Hop | Target | First review | Now | Over by | Result |
|---|---|---|---|---|---|
| talk-page: end of speech to transcription request | 150 ms | ≥ 317 ms (not measured by the e2e; probe lower bound) | **108 ms** (102-120). 96 ms of it is the VAD wait, plus Silero's 32 ms frame: ~140 ms | none | **pass** |
| whisper: transcribe | 250 ms | 259 ms (190-526), 13 calls, mostly the warm probe; e2e 457 (259-526) | **565 ms** (471-1912) per request, 499 ms (427-1839) in whisper. Probe, back to back: 267 ms (212-284) per request, 255 ms in whisper, but 772 ms for the first call after the warm | **+315 ms** | **fail** |
| fast-lane: route and stream the first sentence | 200 ms | first sentence 728 ms (626-843), probe; e2e first delta 246 | **669 ms** (418-2363) to the first piece, "There are no meetings today." (5 words). First token 544 (325-2250); router 150 (76-333); whole turn 551 (407-2341) | **+469 ms** | **fail** |
| voice: end of speech to first audio | 700 ms | 1792 ms (1330-2619) e2e, no talk-page hop; ~1.6 s from the probe sums | **1807 ms** (1264-3608) whole path. TTS first byte after the piece: 487 ms (244-763) in the turn, 121 ms (115-223) back to back | **+1107 ms** | **fail** |

Per run (ms; whisper is request/in-whisper; a dash means nothing unusual):

| Run (Z) | talk-page | smart-turn (model) | whisper | first token | first piece | TTS 1st byte | voice | Note |
|---|---|---|---|---|---|---|---|---|
| 21:51:23 | 111 | 240 (181) | 473/427 | 544 | 669 | 554 | 1807 | - |
| 21:53:19 | 108 | 238 (197) | 673/619 | 697 | 826 | 503 | 2110 | - |
| 21:54:55 | 116 | 203 (154) | 1912/1839 | 651 | 817 | 763 | 3608 | - |
| 21:56:33 | 108 | 144 (101) | 687/654 | 455 | 565 | 358 | 1718 | - |
| 21:58:08 | 109 | 194 (154) | 536/499 | 2250 | 2363 | 547 | 3555 | 1840 ms event-loop block during the turn; decision 1937 ms, router 239 |
| 21:59:58 | 108 | 161 (117) | 1350/1077 | 584 | 707 | 487 | 2652 | - |
| 22:05:47 | 102 | 319 (56) | 565/447 | 363 | 449 | 244 | 1360 | CPU 1% |
| 22:07:10 | 120 | 242 (60) | 471/452 | 325 | 418 | 255 | 1264 | CPU 51% |
| 22:08:33 | 107 | 236 (49) | 499/478 | 343 | 429 | 250 | 1285 | CPU 78% |

Where the time goes, on the best runs (7-9, about 1.3 s):

- the 96 ms VAD wait;
- whisper, ~470-565 ms (it now decides when the turn starts: smart-turn's 144-319 ms runs
  alongside it and finishes first in every run);
- the first piece, ~420-450 ms (router ~80-110 ms, then the answerer's first token at
  ~325-363 ms);
- Kokoro's first byte, ~250 ms.

Back to back, whisper is about twice as fast and Kokoro about four times as fast as in the
page's order. The gap is
where they sit on the path, not the models: whisper runs just after the warm pings and next to
smart-turn, and Kokoro runs while Ollama is still generating on the same GPU. The answerer
alone starts in 57 ms (eval p50), so most of the fast lane's first token is the router and the
prompt-cache swap. OLLAMA_NUM_PARALLEL=2 did not bring it down: the router took 150 ms here
against 75 ms in the first review.

### Defects

Fixes from the first review, as seen live at bd7b768:

- **8.4.1** (tomorrow read as today): **verified live.** The snapshot has a line per day, the
  brief prints TOMORROW, and 9 of 9 answers say there are no meetings today.
- **8.4.2** (titles as attendees, a meeting left out): **verified by eval only** (12 of 12).
  No live answer named a meeting, so none named attendees. A live check needs a day with
  meetings left, or 8.4.39 fixed.
- **8.4.3** (fast lane's first sentence): **still open.** 669 ms (418-2363) against 200.
- **8.4.4** (whisper): **still open.** 565 ms against 250 in the page's order, 255-267 ms back
  to back.
- **8.4.5** (smart-turn over the talk-page budget): **verified live.** The talk-page hop takes
  108 ms (102-120). Smart-turn's model now takes 49-197 ms after the pa-voice restart, but the
  endpoint still takes 144-319 ms. It is off the critical path now, because whisper is slower.
- **8.4.6** (first audio): **still open.** 1807 ms against 700.
- **8.4.7** (the e2e understates hops): **verified live, except the screenshot.** The e2e
  times all four hops in the page's order. The Ask screenshot still shows the idle page.

New, filed under 8.4 in PLAN.md:

- **8.4.38** The serving generation's event loop still blocks for 1-3 s about once a minute,
  after 118352f and 0baaaf2. There were 15 blocks of 1054-3163 ms from 21:51Z to 22:10Z, with
  github, remote-sessions, meeting-gate, capture-watchdog and distill running. Two of the 11
  turns stalled behind one before routing. The 21:58:08Z run's decision took 1937 ms (router
  239 ms) during a 1840 ms block. The 22:03:55Z run's decision took 1388 ms (router 259 ms)
  during a 3163 ms block.
- **8.4.39** "What's on tomorrow?" is handed off to the main session (2 of 2, p(answer_here)
  0.775-0.78 against the 0.85 threshold), although the snapshot lists tomorrow's meetings. It
  says "One moment." and leaves the answer to Claude. So the fix in 8.4.2 is never used by
  voice for tomorrow.

### Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\` (local; these hold real calendar text and are not
in the repo):

- `20261108T215112Z-whats-on-dry/`: the dry run.
- `20261108T215123Z`, `215319Z`, `215455Z`, `215633Z`, `215808Z`, `215958Z`, `220547Z`,
  `220710Z`, `220833Z` (`-whats-on`): the 9 default runs. Each has `summary.json`,
  `transcripts/turn.txt`, `transcripts/turn.ndjson` and `screenshots/ask.png`.
- `20261108T220238Z`, `220355Z` (`-whats-on`): the two "What's on tomorrow?" runs.

---

## First review, 2026-11-08

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

### How it was run

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

### Rubric

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

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: answered aloud from the cached snapshot, locally, nothing sent to Claude | **fail** | It is local and is spoken, but the answer is wrong (facts above). |
| Cost ≤ $0 | **pass** | $0 in all runs (spend delta and `llm_spend`). |
| Views: ask | **not evidenced** | `screenshots/ask.png` shows the idle Talk page. The e2e drives the API, not the page, so no screenshot shows the turn in the Ask view. |
| Approvals: none required | pass | No prompt or approval in any turn. |

### Hops

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

### Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\`:

- `20261108T195146Z-whats-on-dry/summary.json`: the dry run.
- `20261108T195150Z-whats-on/`, `20261108T195200Z-whats-on/`, `20261108T195210Z-whats-on/`: each
  has `summary.json`, `transcripts/turn.txt`, `transcripts/turn.ndjson` and `screenshots/ask.png`.

Probe output (local, untracked): `C:\Temp\whatson-probe-out.json`.

### Defects (filed under 8.4 in PLAN.md)

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
