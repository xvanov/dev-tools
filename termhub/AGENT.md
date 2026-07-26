# termhub — install & troubleshooting (detailed)

Companion to [README.md](./README.md). termhub runs **two processes per machine**: a persistent
**`sessiond`** that owns that machine's terminals (PTYs), and a swappable **`front`** that serves
the web UI and proxies to `sessiond`. This split is what lets updates swap the front without
killing terminals. There is no cross-machine hub — you reach each machine directly at its own URL.

## Mental model

```
                         Tailscale Serve (stable public :7000)
                                    │   (re-pointed atomically on update)
                                    ▼
browser tab ──http+ws──►  front  (UI + proxy, 127.0.0.1:7001 or 7002)
                              │   proxies /api/*, /ws/term/* and /ws/voice to ↓
                              ▼
                          sessiond  (127.0.0.1:7010)  ──► node-pty PTYs
```

- Run termhub on every machine you want terminals on.
- Open one browser tab per machine (bookmark each Tailscale URL on your phone).
- A session = one PTY living in **`sessiond`**, with an in-memory scrollback buffer. Browser
  (re)connections attach to it via the `front` proxy and get a replay of the buffer, then live
  output.
- **Updates** (`windows/update.ps1`): start a new `front` on the alternate loopback port,
  health-check it, re-point Tailscale Serve to it, stop the old one. `sessiond` is never touched,
  so terminals survive. See *Two-tier layout & safe updates* below.
- For **local dev**, `node server.js` runs both tiers in one process on `:7000`.

## Ports & binding

- Listens on `TERMHUB_PORT` (default 7000), bound to `TERMHUB_BIND` if set, else auto:
  `tailscale ip -4` → any `100.64.0.0/10` interface → `127.0.0.1`. The loopback fallback
  means it never silently exposes itself on a public interface.
- Local dev without Tailscale: `TERMHUB_BIND=127.0.0.1 node server.js`, then open
  `http://127.0.0.1:7000`.

## Manual run / smoke test

Single-process dev (both tiers in one process on :7000):

```bash
npm install
node server.js
# browser → http://<tailscale-ip>:7000
```

Or the two tiers separately (the production layout):

```bash
node sessiond.js            # 127.0.0.1:7010 — owns the PTYs
TERMHUB_FRONT_PORT=7001 node front.js   # 127.0.0.1:7001 — proxies to sessiond
```

API quick checks (against the front, which proxies to sessiond):

```bash
curl -s http://<host>:7000/api/health | jq   # front up + sessiond reachable
curl -s http://<host>:7000/api/info | jq
curl -s http://<host>:7000/api/sessions | jq
curl -s -X POST http://<host>:7000/api/sessions \
  -H 'content-type: application/json' -d '{"cwd":"'"$HOME"'"}' | jq
```

HTTP API (served by `sessiond`, proxied by `front`): `GET /api/info`, `GET /api/sessions`
(returns `{sessions, restorable}` — live PTYs plus archived sessions from a previous run),
`POST /api/sessions` (`{cwd?, command?, title?, cols, rows}`), `POST /api/sessions/:id/restore`
(re-open an archived session), `DELETE /api/sessions/:id` (kill a live session and/or forget an
archived one), `PATCH /api/sessions/:id` (`{title}`), `GET /api/recents`, `GET /api/dirs?path=`,
`GET /api/ping` (sessiond liveness). Attachments take a **raw binary body** with the filename in
an URI-encoded `X-File-Name` header: `POST /api/sessions/:id/clipboard-image` →
`{ok, kind:'clipboard'|'file', path?, name?}` (see *Attachments* below) and
`POST /api/sessions/:id/upload-file` → `{ok, kind:'file', path, name}`. Both answer `413` with a
readable `{error}`: from `Content-Length` before reading anything when the client sends one, and
otherwise — a chunked body has no length to check — from a streaming guard that stops buffering at
the cap. Neither destroys the request before replying; doing that used to take the response down
with it and surface through the front's proxy as a misleading
`502 sessiond unreachable: write ECONNRESET`.
`GET /api/info` reports `clipboardImage` (can this host stage a clipboard image?) and
`limits: {imageBytes, fileBytes}` so the UI can refuse an over-cap file before uploading it.
`imageBytes` is the cap that actually applies **on this host**, not a constant — see below.
The `front` answers `GET /api/health` itself (front up +
sessiond reachable) for the updater's probe, and `GET /api/update/check` (`?force=1` to skip the
60s cache) — both are handled by the front and never proxied. Terminal stream: WebSocket `/ws/term/:id` with JSON
`{type:'input'|'resize'}` up and `{type:'replay'|'output'|'exit'}` down.

## Two-tier layout & safe updates

`sessiond` (the PTY supervisor) and `front` (the UI + proxy) coordinate through a few files in
the data dir (`%LOCALAPPDATA%\termhub` on Windows, `~/.local/termhub` on Linux):

- `state.json` — `{ sessiondPort, activeFrontPort, publishPort }`: which loopback port Tailscale
  Serve currently targets. Written by `start.ps1` / `update.ps1`, read by both.
- `sessiond.pid`, `front-<port>.pid` — two-line (`PID`\n`PORT`) files each process writes on
  startup and removes on a clean exit; the scripts read them to find/stop the right process.
- `sessions.json` — the session archive (`lib/archive.js`). Mirrors each session's metadata
  (cwd, command, `kind`, and — for shell sessions — the command lines typed in it) so it
  survives a reboot. Written by `sessiond` on create / rename / exit / input.

### Session persistence (surviving reboots)

PTYs live only in `sessiond`'s memory, so a machine reboot kills every terminal and the sidebar
comes up empty. `sessiond` mirrors session *metadata* to `sessions.json`; on the next start those
entries (no longer matched by a live PTY) are returned as `restorable` and the sidebar shows a
**Restorable (after restart)** section. The processes themselves can't be resurrected, so
"restore" re-spawns: a `claude` session re-opens as `claude --dangerously-skip-permissions
--resume` in its old cwd (Claude's resume picker, scoped to that directory); any other session
re-opens as a plain shell in its old cwd with its recorded command history printed in as a
dim, commented block to re-run by hand. Killing a live session (✕) or forgetting a restorable one
both `DELETE` it, removing it from the archive. **This is a `sessiond`-tier change**: restart
`sessiond` once to activate it (which clears the *current* live sessions — but from then on every
session is persisted). Sessions lost to a reboot that happened *before* this was running are gone;
nothing was recorded for them.

Caveat on shell history: it's reassembled from the raw keystroke stream (printable bytes accumulate,
Backspace/Ctrl-C edit, escape sequences are skipped, Enter flushes a line). A command recalled with
the Up-arrow comes back as terminal *output*, not input, so a re-run won't be re-captured — it's a
memory-jogger, not an exact transcript. Only shell-kind sessions record history; Claude/TUI
sessions don't (they restore via `--resume`, and their keystrokes would be noise).

The **⟳ Update** button in the UI is a front-end over this: the front answers
`GET /api/update/check` (it `git fetch`es and reports how far HEAD is behind `@{u}`, plus a
`toolChanged` flag set when a changed file lives under the `termhub/` prefix), and **Update
now** just opens a normal session whose command is `update.ps1` — so the updater runs inside a
`sessiond`-owned PTY and survives the front swap it triggers, exactly like running it by hand.

`windows/update.ps1` does a blue-green swap: `git pull --ff-only` (rollback ref saved) → start a
green `front` on the alternate of `{7001, 7002}` → health-check (`/api/health`, then the proxied
`/api/sessions` and static `/`) → on success re-point `tailscale serve --https=<publishPort>` to
green and stop blue; on failure kill green, `git reset --hard` to the rollback ref, leave blue
serving. `sessiond` is never restarted, so PTYs (and the terminal running the updater) survive.

`node-pty` lives only in `sessiond`, so routine front updates need **no native rebuild**. A
`node-pty` version bump only takes effect on a deliberate `sessiond` restart (which does clear
sessions — do it intentionally).

## Spoken announcements (the voice layer)

Opt in per session with the sidebar's 🔊 toggle; when an armed Claude session stops and is
waiting on you, the browser speaks a short summary of what it said. Everything runs locally.

**Where the signal comes from.** Not the terminal — reading a TUI's repainted screen is
hopeless. `lib/voiceHub.js` tails Claude Code's own conversation transcript
(`~/.claude/projects/<encoded cwd>/<session-uuid>.jsonl`), the same file the model badge reads,
located by the shared `resolveTranscript()` in `lib/claudeModel.js`. Sessions termhub launched
have `--session-id <uuid>` spliced in, so their transcript path is known exactly; a
hand-launched `claude` falls back to the newest transcript in that cwd.

**What counts as "waiting"** (`lib/claudeTranscript.js`): the last real turn is an *assistant*
turn whose `stop_reason` is `end_turn`, `stop_sequence` or `null`, and which has something
speakable. A `tool_use` stop is mid-work and is **not** announced. `thinking` blocks never make
it into the spoken text.

One assistant response is written as **several** transcript entries — thinking, then text, then
each `tool_use` — all sharing one `requestId` and one `stop_reason`. `readLastTurn` therefore
reassembles the whole response by walking back over same-`requestId` entries instead of reading
the last line, because the last line on its own is regularly empty.

Subagent turns are skipped via `isSidechain`, but note what actually protects us: that flag is
set on **0 of 73,701** entries here. Subagent conversations are filed under
`<session-uuid>/subagents/`, and they stay out because `findActiveTranscript` lists one
directory *non-recursively*. Those files are full of `stop_reason: null` entries that would all
read as "waiting", so **do not make that readdir recursive**; the flag check is only the belt.

**Questions are invisible to the transcript.** When Claude stops on an `AskUserQuestion`, an
`ExitPlanMode` or a permission prompt, it writes **nothing** until you answer: measured here,
all 98 asking-tool entries in 680 transcripts were flushed together with their answer, a median
194 s (max 16 h) after the question was created, and a live session sitting on the picker
produced zero new transcript lines. So the moment you most need to be told is the moment there
is nothing on disk to read, and by the time there is, you've already answered. The transcript
path cannot fix this at any level of cleverness.

What can: the PTY. Claude's TUI animates a spinner continuously while it works, so a terminal
silent for `BLOCKED_MS` (12 s) is not working — and if the conversation's last recorded turn
isn't a finished assistant turn either, Claude is parked on something interactive. The hub then
sends a `waiting` whose summary says the session is asking something, with a `turnUuid` of
`<uuid>:blocked` so it can't collide with a real turn announcement. It cannot say *what* is
being asked; that text exists only on screen. This is a heuristic and the one part of the voice
layer that isn't derived from a recorded fact — measured behaviour: fires 15.4 s after the
question appears, and zero false positives over a 60 s idle following a normal turn.

**Not being chatty.** The hub polls every second, but only looks at armed, alive,
`kind: claude` sessions; skips any whose transcript mtime hasn't moved; and skips any whose PTY
produced output in the last 1.5 s (still streaming — the transcript's tail can be a partial
entry that looks finished). A turn is announced **once**, keyed on the transcript entry's uuid,
and that bookkeeping lives in `sessiond`, so browser reloads and front swaps can't re-trigger
it. If the user replies while a summary is still being generated, the announcement is dropped.
`busy` is driven off the PTY rather than the transcript, so it fires the moment you start
typing — seconds before a new turn is recorded — which is what lets the browser cancel a
queued announcement.

**Summarising** (`lib/summarize.js`). Turns under ~240 characters are spoken as-is after
markdown flattening: they need no summary, and handed something that short `claude -p` tends
to answer it rather than condense it. Longer turns go to `claude -p --model haiku` on stdin
(~4 s, free on the subscription, no API key), run detached with piped stdio in
`$TMPDIR/termhub-summarize` — its own directory, so the summarizer's conversations can't be
mistaken for "the active transcript in /tmp" by the cwd fallback above. Claude Code's inherited
`CLAUDE*`/`AI_AGENT` env vars are stripped first. Any failure or a 25 s timeout falls back to a
local markdown-stripping reduction; it never throws. Each run leaves transcripts of its own
behind, so all but the newest 10 are deleted after every call.

**Speech** (`lib/tts.js`) — two engines behind one door, chosen by `TERMHUB_TTS_ENGINE` and
defaulting to whichever is installed, kokoro first. Neither being present is not an error:
`available()` goes false, `/api/tts` 503s, and the UI already handles that. An engine named
explicitly but not installed silently yields to the other one, because a robotic announcement
beats no announcement.

*kokoro* is the good one and the default. It runs through a **resident python worker**
(`lib/kokoro_helper.py`): spawning a fresh interpreter per announcement pays the model load
every time, and that load is most of the cost. Measured on this box, same 11.9 s clip:

| | latency |
|---|---|
| fresh python per request | 2944–3273 ms (median 3153) |
| warm worker | 2015–2101 ms (median 2032) |
| piper, same text | 1025–1091 ms |
| LRU cache hit | 6 ms |

Model load alone is 0.73 s; the worker turns that from per-clip into once. The wire format is
deliberately dumb — one JSON request per line on stdin, and a JSON header line plus exactly
`bytes` raw bytes of WAV back on stdout — so the node side needs a framing loop and no parser.
The worker holds **~745 MB** resident, so it is evicted after `TERMHUB_TTS_IDLE_MS` (10 min)
of nothing to say, killed on process exit, and respawned lazily. Deliberately *not* `unref`'d:
unref'ing the pipes lets node exit with a synthesis in flight, and a promise that never settles
is worse than a resident worker. A worker that dies mid-request is retried once; one that fails
at *import* time (`fatal`) demotes kokoro for five minutes and the in-flight request finishes
on piper. Both the death-before-`ready` case and a worker that never reports `ready` settle the
startup promise — an early version hung forever when `TERMHUB_KOKORO_PYTHON` pointed at
`/bin/false`.

Voices: kokoro's are enumerated from the worker's own `ready` frame once it has run, and from a
static English list before that — `/api/voice/status` is polled, and loading a 325 MB graph to
list names is not an option. Only the `a*`/`b*` (American/British) voices are offered; the model
has Japanese and Chinese ones too, but everything termhub speaks is English.

*piper* is unchanged: `piper -m <voice>.onnx -f -` — the `-f -` matters, with no `-f` piper 1.6
writes a timestamped file into the cwd instead of streaming to stdout. Voice models come from
`TERMHUB_TTS_VOICE_DIR` (default `~/.claude/piper-voices`); files under 4 KB are skipped because
partially-downloaded stubs crash piper. onnxruntime GPU warnings on stderr are drained and
ignored (both engines emit them).

Shared by both: a 30 s timeout with the child killed — for kokoro that means killing the *worker*,
since an ONNX run in progress can't be cancelled — and an LRU keyed on sha1(engine + voice + text)
so re-reads are free. `TERMHUB_TTS_VOICE` selects within the *active* engine and is ignored when
it names something that engine doesn't have; this is what stops `~/.claude/tts-voice.txt`
(a piper model name) from being handed to kokoro as a voice id.

**Bounded child processes** (`lib/limit.js`). Both subprocess paths are reachable by any
tailnet peer through the front's generic `/api/*` proxy, in the process that owns the PTYs, so
concurrency is capped rather than merely typical: **2** concurrent `piper` (queue 8) and **2**
concurrent `claude -p` (queue 6). Past the queue depth callers get a 503 with `Retry-After` —
a late announcement is worthless anyway. `/voice/summary` additionally *coalesces*: concurrent
requests for the same turn await one summarize instead of forking one each, and the result is
cached per turn uuid. Without these, 10 concurrent `/api/tts` spawned 10 pipers and 6
concurrent `/voice/summary` spawned 6 haiku processes.

Measured on the dev box: kokoro ~2.0 s through the warm worker (piper ~1.0 s) for a 12 s clip,
`claude -p --model haiku` ~3.8 s. End to
end, from the finished turn appearing in the transcript to `waiting` reaching a browser:
**~1.7–2.2 s** for a short turn (poll tick + quiet window) and **~7 s** for one that goes
through haiku. Every child is spawned asynchronously, and with the caps in place 10 concurrent
`/api/tts` plus 6 concurrent `/voice/summary` left `/api/ping` round-trips at a worst case of
**9 ms** (median 1 ms) — versus 148 ms before the caps existed. That figure is a property of
the caps, not of the load: without them the fan-out is unbounded and so is the latency.

### In the browser (`web/app.js`)

One `/ws/voice` socket per page, not per session — the speaker and the microphone belong to
the browser, not to a terminal. It reconnects with the same backoff shape as the terminal
socket, minus the ten-attempt cap: a terminal socket gives up because its session can genuinely
be gone, whereas the voice feed should still be retrying when the laptop wakes up.

**The unlock tap.** Safari will not play audio, and iOS will not warm the speech engine, outside
a user gesture — so the first armed session raises an amber **Enable voice** strip. That one tap
does three things synchronously: resumes an `AudioContext` and plays a silent buffer through it,
plays 60 ms of generated silence through the single `<audio>` element every announcement will
reuse, and fires one throwaway `SpeechRecognition`. That last one matters: on the user's iPhone
the *first* `start()` of a page load cost **3.05 s** and every one after it ~10 ms, so the cost
is spent in the tap rather than mid-conversation. Until it happens, announcements arrive as text
and the 🔊 toggles glow amber.

**The loop.** `waiting` → chime → `/api/tts` → play → open mic → transcribe → read back
"sending: …" → 3 s undo window → `text + '\r'` down that session's existing terminal socket.
Announcements are queued, never overlapped, and `busy` (or disarming) drops a session's unspoken
one. A `waiting` for a session already in the queue replaces it rather than queueing twice.
Arming several idle sessions at once makes the server announce each one's last turn immediately,
so past two queued announcements the rest collapse into "3 more sessions are waiting: …".

**Things that are easy to get wrong here**, all learned from a real-device probe:

- `onerror: 'aborted'` and `'no-speech'` are the *normal* rhythm of the loop — they fire whenever
  a recogniser is stopped or hears nothing. They must re-arm, not tear down. Only `not-allowed`
  / `service-not-allowed` is terminal; anything else backs off and retries five times.
- `continuous` is ignored on iOS. Each recognition is exactly one utterance, so the loop re-arms
  on every `onend` (250 ms later, to let iOS hand the mic back).
- The undo window is matched against **interim** results. The final transcript lands ~1.9 s after
  the last word, which is most of a 3 s window, so waiting for it would make "stop" useless.
- **Never open the mic while audio is playing.** The user is on Bluetooth headphones, where the
  mic flips iOS to the mono HFP route. `speak()` closes the recogniser before it starts, and the
  undo countdown only begins once the read-back clip has finished — which is also why tapping
  Cancel works during the read-back but saying "stop" doesn't quite yet.
- The chime is load-bearing, not decoration. Announcing takes ~7.5 s whenever the summariser
  model runs, and seven seconds of dead air reads as broken. It's an oscillator on the unlocked
  context, fired synchronously the instant the event lands — ahead of the `/api/tts` round-trip
  and independent of the queue.
- The mic closes after 45 s of silence, enforced both on `onend` and by a watchdog timer (a
  recogniser that never ends would otherwise sit on the microphone forever). A toast says so.
- `hello` reports who is *armed*, not who is *waiting*, and the server never re-announces a turn.
  So on every connect the page asks `/api/sessions/:id/voice/summary` for each armed session —
  without it, reloading (or iOS discarding the tab) while Claude waits means permanent silence.
- A summary can come back empty (a reply that was only a code block flattens to `""`, and
  `/api/tts` rejects that with a 400). It falls back to "<title> is waiting on you."

### Voice commands (`web/voiceCommands.js` + the command section of `web/app.js`)

An utterance that **begins** with the wake word drives termhub and never reaches the agent;
everything else is dictation, unchanged. Parsing is a separate, pure file precisely so it can be
tested off the browser — `npm test` (`test/voiceCommands.test.js`, no framework, no deps).

**The wake word is `Sputnik`, and that choice is the design.** The first attempt was `termhub`,
which is the worst possible wake word: the recogniser has never heard it, so it guesses, and
differently every time — `term hub`, `turn hub`, `thermo`, `term up`. Catching that needs fuzzy
matching, and fuzzy matching on a seven-letter target is what starts eating ordinary speech.
`Sputnik` is a proper noun already in iOS's vocabulary and in nobody's engineering dictation, so
it is matched **exactly**, against a short curated list of plausible mishearings (`sputnick`,
`spudnik`, `sput nik`, `spot nick`). There is no edit-distance fallback on the wake word on
purpose; with a word this distinctive it buys nothing and costs false positives. Add observed
mishearings to `KNOWN_VARIANTS`; don't reach for fuzziness instead. Change the word itself with
`TERMHUB_WAKE_WORD` — it arrives on the `hello` frame and drives `VoiceCommands.configure()`;
the default and its variants live in exactly one place.

Of the two failure modes only one is expensive, and the whole matcher is biased accordingly:

| | cost |
|---|---|
| **miss** | the user says it again — annoying, visible, recoverable |
| **false fire** | an instruction meant for Claude is swallowed and silently never sent |

Three rules enforce that bias:
1. **Prefix-anchored.** "we launched Sputnik in 1957" is text.
2. **Two tiers.** Clean variants are *strong* and wake termhub even when what follows is
   gibberish (which is then acknowledged and dropped — a half-heard command must never be typed
   at the agent). Variants that could be real speech (`spot nick`) are *weak* and wake it only
   when a recognised command follows.
3. **A leading function word disqualifies the match.** Nobody says "the Sputnik".

**Commands fire on FINAL transcripts only; the send timer is frozen on the INTERIM.** This
asymmetry is the one non-obvious decision here. The send window is 4 s and iOS returns a final
~1.9 s after the last word, so saying "Sputnik, send it" a beat after finishing a sentence can
let the timer expire mid-command — the draft goes, and the command then applies to nothing. So
an interim that opens with the wake word clears the pending timer and sets `voice.commandHold`;
the final either runs a command or falls through to dictation, which re-arms the timer from now.
Acting early on a bad guess is unrecoverable; *pausing* early on a bad guess costs one utterance
of delay. `commandHold` also has a recovery path in `onend`: an utterance that freezes the timer
and then dies without ever producing a final would otherwise strand the draft forever. An
explicit "Sputnik wait" deliberately does *not* set the flag, so that same `onend` can't undo it.

**Destructive commands ask.** `close` (kills the session) and `stop` (sends Escape twice —
Claude Code's cancel — leaving the session alive) name the target out loud and wait for a spoken
yes. `isAffirmative()` is deliberately ungenerous: the cost of a missed yes is saying it again,
the cost of a generous one is a dead Claude session. While a confirmation is open the next final
is consumed as the answer regardless of wake word, `pumpQueue()` refuses to talk over the
question, and `onBusy` won't close the mic under it. It times out after 15 s.

`stop` being an interrupt rather than a kill is a judgement call worth knowing about: if the
user meant "close it" they can say so next, whereas the reverse mistake can't be undone.

**Everything is acknowledged** — a couple of spoken words, or `sendBlip()` for the trivial ones
(*wait*, *scratch that*, *mute*) where speaking would cost more time than the command saved. A
command that silently succeeded is indistinguishable from one that was never heard. `speak()`
takes `{force}` so an acknowledgement, "read that again" and a confirmation question still speak
while announcements are muted. `ackCommand()` must re-open the mic afterwards, because `speak()`
closes it (the echo guard) — and must drain a `waiting` that landed *during* the acknowledgement,
or `pumpQueue()`'s "already playing" guard silently loses it. Both were bugs found by driving the
UI, not by reading it.

Session and directory names are matched loosely (`matchSession()`, which *is* edit-distance based
— unlike the wake word, a title genuinely is mangled), and two close candidates produce a spoken
question rather than a guess. Spoken acknowledgements run titles through `speakableTitle()`: an
untitled claude session takes its name from its whole command line including the spliced-in
`--session-id <uuid>`, and reading forty characters of hex at somebody is not an acknowledgement.

**Typing into an agent prompt and actually submitting it.** `sendInput(t, text + '\r')` does
**not** work, and fails silently in a way short test strings won't show you. Claude Code's TUI
treats a large input burst as a *paste*, so a `\r` inside the same burst lands as a newline in
the prompt box and the text just sits there. Measured against a live `claude` session on this
machine:

| what was sent | result |
|---|---|
| 35 chars + `\r`, one write | submits — which is why this is easy to dismiss |
| 96 chars + `\r`, one write | **not submitted**, still in the box 10 s later |
| 111 chars, then `\r` as a second write in the same tick | **not submitted** — the two writes coalesce into one PTY read |
| 111 chars, then `\r` after **20 ms** | submits |
| …after 50 / 100 / 200 / 400 ms | submits |

So the fix is not a delay so much as making the `\r` arrive in its own PTY read; 20 ms was
already enough to break the coalescing. `typeAndSubmit()` in `web/app.js` uses **200 ms**, 10×
the measured floor. Note which way the risk runs: the hazard is the two writes being *coalesced*,
which network latency (phone → Tailscale → front → sessiond) makes less likely rather than more,
and the 200 ms is applied in the browser so it is a floor on the separation before the second
write is even sent. Ordering is guaranteed regardless — both go down the same WebSocket.

**Secure context.** `SpeechRecognition` is only exposed to a secure origin, so on the plain
`http://<tailnet-ip>:7000` URL there is no microphone. Playback works there and is left enabled;
voice *input* is disabled with the derived `https://<host>:7443/` address shown, and 🎤 falls
back to the same text box a browser without speech recognition gets. This is the same constraint
`navigator.clipboard` has (see `execCopyFallback`).

### Voice API

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/voice/status` | — | `{tts:{available,engine,voice,voices:[{id,label}]}, wakeWord, summarizer:{available}, sessions:[{id,armed}]}` — `engine` is `'kokoro'`/`'piper'`/`null`; `wakeWord` is `null` unless `TERMHUB_WAKE_WORD` overrides the client default |
| `POST` | `/api/sessions/:id/voice` | `{armed}` | `{ok:true, armed}`; 404 unknown session, 400 arming a non-`claude` one |
| `GET` | `/api/sessions/:id/voice/summary[?full=1]` | — | `{summary, turnUuid, waiting}` — on demand ("read that again"); empty for a non-`claude` session or when Claude hasn't spoken yet. `?full=1` adds `{text, truncated}`, the assistant's verbatim last turn capped at 3200 chars ("read the last message in full"). Opt-in because the reconnect catch-up hits this route per armed session and doesn't want kilobytes of transcript |
| `POST` | `/api/tts` | `{text, voice?}` | `audio/wav`, `Cache-Control: no-store`; 400 empty/over 4000 chars, 503 if no engine is available or too busy. `voice` must be an id from `voices()` for the active engine — anything with a path separator (piper) or outside `[a-z]{2}_[a-z]+` (kokoro) is refused |

`GET /api/sessions` gains `voiceArmed` per session.

`WS /ws/voice` is a page-wide feed (not per session). Server → client:
`{type:'hello', tts:{available,engine,voice,voices}, wakeWord, sessions:[{id,title,armed}]}` on connect, then
`{type:'waiting', sessionId, title, turnUuid, summary}`, `{type:'busy', sessionId}` and
`{type:'armed', sessionId, armed}`. Client → server: `{type:'ping'}` → `{type:'pong'}`.
Arming goes over REST, not the socket, so it survives a dropped connection.

**When it stays silent.** No speech engine at all, no `claude` CLI, no transcript, a
session that isn't `kind: claude`, or a mid-tool-call turn — all of these degrade to silence,
never to an error. A turn whose text flattens to nothing (a reply that is only a code block)
is announced as such rather than as an empty summary, which the browser couldn't play.

Claude writes no transcript at all when it thinks it's a child of another Claude session, and
warns about that in its own banner. `lib/session.js` strips the inherited `CLAUDE_CODE_*`
identity from every PTY termhub spawns, so this can't be caused by how termhub itself was
started; it only shows up for a `claude` launched some other way.

## Versioning & tagging

The version shown under the **⟳ Update** button (and in the update panel) is `git describe
--tags --always --dirty`, computed by `lib/update.js` and returned in `/api/update/check` as
`version`. So a release is just an annotated tag:

```bash
# bump package.json "version" to match, commit, then tag that commit:
git tag -a v0.3.0 -m "termhub v0.3.0"
git push --follow-tags        # or: git push && git push --tags
```

On a tagged commit the UI shows `v0.3.0`; commits past the tag show `v0.3.0-<n>-g<sha>`, and an
uncommitted tree shows a `-dirty` suffix — so the displayed string always tells you exactly what
that machine is running. Use `vMAJOR.MINOR.PATCH` (semver): patch for fixes, minor for additive
features, major for breaking changes. Keep `package.json`'s `version` in step with the latest tag.

## Linux service management

```bash
systemctl --user status termhub
systemctl --user restart termhub
journalctl --user -u termhub -f          # live logs

# edit env (port / bind / machine name):
systemctl --user edit termhub            # add: [Service]\nEnvironment=TERMHUB_BIND=100.x.y.z
systemctl --user daemon-reload && systemctl --user restart termhub
```

Keep it running after logout (servers/headless): `sudo loginctl enable-linger "$USER"`.

The installer also auto-removes units from the older two-process layout
(`termhub-agent.service` / `termhub-hub.service`) if they exist.

## Windows task management

The `Termhub` scheduled task runs `windows\start.ps1` at logon, which ensures `sessiond` is up,
starts the active `front`, and (re-)publishes it via Tailscale Serve. It's idempotent — re-running
`start.ps1` reuses a live `sessiond`/`front` instead of restarting it.

```powershell
Get-ScheduledTask Termhub | Get-ScheduledTaskInfo
Start-ScheduledTask Termhub              # = run start.ps1 (boots both tiers, idempotent)
Stop-ScheduledTask  Termhub
.\windows\update.ps1                     # safe blue-green update (run from any terminal)
.\windows\start.ps1                      # bring tiers up / re-publish by hand
```

Stopping the task does **not** stop the running `node` processes (they're detached); kill them by
pid (see `sessiond.pid` / `front-<port>.pid` in the data dir) or by command line. To see errors,
run `node sessiond.js` / `node front.js` in a console manually (the task has no log redirection by
default). The installer removes old `TermhubAgent` / `TermhubHub` tasks if present.

The Windows installer binds termhub to loopback (`TERMHUB_BIND=127.0.0.1`, set via `setx`) and
publishes it with Tailscale Serve. Manage the published endpoint with:

```powershell
tailscale serve status
tailscale serve --https=7000 off        # stop publishing
```

Non-admin installs use a hidden Startup-folder launcher instead of a task; the installer writes
it with the absolute project path baked in (a path resolved relative to the .vbs breaks once the
file is copied into the Startup folder).

## node-pty build prerequisites

`node-pty` is a native addon and compiles on install:

- **Linux:** `sudo apt-get install -y build-essential python3` (or distro equivalent).
- **Windows:** **Visual Studio Build Tools** with the *Desktop development with C++* workload,
  plus a matching Python. After installing, delete `node_modules` and re-run `npm install`.

`windows\install.ps1` builds the native addon itself (npm runs with `--ignore-scripts`, then
the installer drives `node-gyp configure` + MSBuild) so it can work around two stock-Windows
build failures automatically:

- **`'GetCommitHash.bat' is not recognized`** — caused by the environment variable
  `NoDefaultCurrentDirectoryInExePath=1`, which stops `cmd` from running winpty's batch file
  from the current directory. The installer clears it for the build.
- **`MSB8040: Spectre-mitigated libraries are required`** — newer VS toolsets (e.g. 2022/2026)
  demand Spectre libs that aren't installed by default. The installer passes
  `/p:SpectreMitigation=false` to MSBuild. To keep the mitigation instead, install
  *MSVC … Spectre-mitigated libs* from the VS Installer (Individual components) and drop that flag.

If building by hand, reproduce both: clear `NoDefaultCurrentDirectoryInExePath`, then
`npx node-gyp configure` and `MSBuild build\binding.sln /p:Configuration=Release /p:Platform=x64 /p:SpectreMitigation=false`.

## Mobile notes

- The on-screen key bar sends real escape sequences: `Esc` (`\x1b`), `Tab` (`\t`), arrows
  (`\x1b[A/B/C/D`), `^C` (`\x03`). The sticky **Ctrl** key arms a modifier applied to the next
  letter you type (e.g. `Ctrl` then `d` → `\x04`).
- Inputs use a 16px font so iOS Safari doesn't zoom on focus.
- The terminal refits on focus, `orientationchange`, and `visualViewport` resize (soft
  keyboard show/hide).
- The keys scroll sideways when they don't fit (they don't, on a phone: eleven keys want
  ~550px). **🎤** and **📎** live outside that scroller, pinned to the right edge, so neither
  the one way to attach a file from a phone nor the one way to start talking is ever off-screen.
- The voice strip sits directly above the key bar so the undo window's **Cancel** button lands
  under your thumb — the only reason to look at that strip in a hurry is to stop a send.
- Add the tab to your home screen for an app-like, full-screen experience.

## Attachments (📎, paste, drag-drop)

All three routes end in the same place: `sendAttachment()` in `web/app.js`, which uploads with
`XMLHttpRequest` (the only browser API that reports upload progress — a phone pushing a photo
over cellular needs to see *something*) and reports through a DOM toast rather than by writing
into the terminal, which a full-screen TUI would repaint over within a frame.

**Images** go to `POST /api/sessions/:id/clipboard-image`, and `sessiond` decides what actually
happens to them:

- Host has a clipboard → staged on it, reply `{kind:'clipboard'}`, and the client fires the
  agent's clipboard-image hotkey (`Alt+V` on native Windows Claude Code, `Ctrl+V` otherwise).
- Host has none, **or** the clipboard write fails anyway → saved under `<data dir>/attachments/`,
  reply `{kind:'file', path}`, and the client types the path in. `clipboardTarget()` in
  `lib/clipboard.js` is what decides: Windows and macOS always qualify, Linux only with
  `DISPLAY`/`WAYLAND_DISPLAY` *and* a tool (`wl-copy`/`xclip`/`xsel`). Checking for the tool
  alone is not enough — a headless Linux box very often has `xclip` installed, where it can only
  ever exit 1 with *Can't open display*, which is what this used to surface to the user as a
  yellow warning they could do nothing about.

Attachments live in the data dir, not the session cwd, because the cwd is usually a git checkout;
anything there older than a week is pruned, at most hourly and never synchronously (this process
owns every live PTY — a `readdirSync` + `statSync` sweep of a few thousand entries stalls all
terminal I/O for milliseconds). **Everything else** goes to
`POST /api/sessions/:id/upload-file`, which saves into the session's cwd — that *is* the point
for a file the agent is meant to work on.

Three rules hold on both paths, and each exists because breaking it was tried:

- `sanitizeFileName` — a filename never escapes its directory, and never becomes an NTFS
  alternate data stream.
- `writeUnique` — the name is claimed by an **exclusive-create write** (`flag: 'wx'`) that
  retries on `EEXIST`. A look-then-write (`existsSync`, then an awaited `writeFile`) yields the
  event loop in between, so concurrent uploads of the same name both win the check and the second
  overwrites the first while both clients are told `{ok:true}` with the same path. Measured on the
  old code: 12 simultaneous uploads named `race.png` lost 3 payloads. It is the *common* case, not
  an exotic one — a multi-file pick uploads everything at once, and iOS hands back the same
  `image.jpg` for every photo in a selection.
- `safeForNotice` — anything client-supplied is stripped of C0/C1 controls and length-capped
  before it reaches `session.notice()`. Notices go to the live terminal *and* the replay buffer,
  so an `X-File-Name` carrying `ESC [2J` cleared the user's screen on every reconnect for the
  life of the session.

The image cap is **`MAX_CLIPBOARD_IMAGE_BYTES` only where there is a clipboard**. That 15 MB
number exists because the bytes get inflated onto an OS clipboard; where the image is instead
written to disk it is just a file and takes the 100 MB file cap. Recent iPhones shoot 15-25 MB
photos, so the old flat 15 MB refused a whiteboard photo on the one kind of host where the
constraint doesn't apply. `/api/info` publishes the *effective* number so the client's pre-flight
check can't drift from the server's.

A clipboard image has no name of its own, so the client stamps it
`pasted-image-<local timestamp>.<ext>`; `sessiond` does the same if the header is missing. That
stamp is only second-resolution, which is exactly why `writeUnique` has to be correct.

A paste that carries **both** a file and non-empty `text/plain` is left to xterm: rich text with
an inline image is the common shape, and taking the image would silently swallow the text the
user actually meant to paste.

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Bound to `127.0.0.1`, unreachable from other devices | No Tailscale IP detected | Set `TERMHUB_BIND` to the tailnet IP; ensure `tailscaled` is up |
| Can't reach `:7000` from phone (loads forever) | Windows firewall drops raw ports on the Tailscale interface | Use Tailscale Serve (Windows installer does this): bind loopback + `tailscale serve --bg --https=7000 http://127.0.0.1:7000`, then open `https://<host>.<tailnet>.ts.net:7000/` |
| Can't reach `:7000` from phone | Tailnet ACL or firewall | Confirm both devices are on the tailnet and ACLs allow the port |
| Terminal opens but no output | WebSocket blocked | Ensure nothing between browser and server strips WebSocket upgrades |
| Input ignored after sleep/wake | WebSocket dropped; reconnecting | Output replays on reconnect (incl. across a front update). "Session no longer available" means `sessiond` itself restarted (reboot, or a deliberate sessiond restart) — restore it from the sidebar's **Restorable** section, or open a new terminal |
| Sidebar empty after a reboot | `sessiond` (and its PTYs) died with the machine | Sessions created while the persistence build was running reappear under **Restorable (after restart)** — restore re-opens Claude with `--resume` or a shell with its command history. Sessions from before the build was deployed weren't recorded |
| Wrong size / wrapping | Pane resized while backgrounded | Switch sessions or rotate to force a refit |
| Pasted image lands as a file path instead of in the agent's prompt | The host has no usable clipboard (`curl /api/info` → `"clipboardImage": false`) | Expected on a headless Linux box. The path works — both Claude Code and opencode read an image given one. To get the clipboard route instead, run a session with a real display |
| 📎 upload does nothing on a phone | File over the cap (100 MB, or 15 MB for an image on a host with a real clipboard — `curl /api/info` shows the effective `limits`) | The red notice above the key bar says so; tap it to dismiss, shrink the file. A silent failure instead means the connection dropped — the notice says that too |
| Pasted an image and got text instead | The paste carried `text/plain` too (rich text with an inline image), and text wins | Deliberate — taking the image would swallow the text. Use 📎 for the image |
| 🔊 armed but never speaks | No transcript to read | Only `kind: claude` sessions can be armed at all (the endpoint 400s otherwise). If Claude's banner says transcript saving is off, it was launched as a child of another Claude session — termhub's own PTYs are scrubbed of that, so it came from elsewhere |
| Told "asking you something" but nothing is | PTY-idle heuristic misfired | A claude terminal silent for 12 s with no finished turn recorded is assumed to be on a prompt. A session wedged some other way looks the same; the announcement is generic by design because the question is never written to the transcript |
| 🔊 reports speech unavailable | Neither engine usable | `curl localhost:7010/api/voice/status` — `tts.engine` names the winner. kokoro needs `TERMHUB_KOKORO_PYTHON` to import `kokoro_onnx` + `soundfile` and the two model files under `TERMHUB_KOKORO_DIR`; piper needs the binary on `PATH` and `<voice>.onnx` + `.onnx.json` in `TERMHUB_TTS_VOICE_DIR` (files under 4 KB are treated as broken stubs and skipped) |
| Announcements sound robotic | Fell back to piper | `tts.engine` says `piper`. A kokoro worker that fails at import demotes the engine for 5 minutes; run `TERMHUB_KOKORO_PYTHON -c 'import kokoro_onnx'` by hand to see why |
| A voice command did nothing | Wake word missed, or wasn't at the start | Commands fire on finals only and only utterance-initial. A parsed-but-unknown command says "didn't catch that" and is dropped. `npm test` covers the matcher; add real mishearings to `KNOWN_VARIANTS` in `web/voiceCommands.js` |
| A dictated sentence vanished | A false wake-word fire would do this | It shouldn't — `npm test` asserts against a near-miss list. If you find one, add it to `NEAR_MISSES` and tighten the variants; do not add fuzzy matching |
| Armed, but the strip stays amber and nothing plays | Browsers won't play audio before a user gesture | Tap **Enable voice**. Once per page load; the toggles turn from amber to blue |
| 🎤 does nothing but open a text box | No `SpeechRecognition`, or an insecure origin | Speech recognition needs a secure context — use `https://<host>:7443/`, not `http://<tailnet-ip>:7000`. The strip names the address. Desktop Firefox has no Web Speech at all; the text box is the fallback |
| Mic keeps closing on its own | Working as intended | It closes after 45 s of silence rather than listening to an empty room, and while an announcement is playing (opening it then would flip a Bluetooth headset's audio route mid-sentence). Tap 🎤 to reopen |
| Voice reply went to the wrong session | 🎤 targets whatever terminal is in front of you | An announcement's reply goes to the session that announced; a 🎤 tap goes to the active terminal |
| Announcements sound like a rewrite, not the answer | Turn was long enough to go through `claude -p --model haiku` | Expected; turns under ~240 chars are spoken verbatim. `claude -p` failing just falls back to a local trim |
| `npm install` errors on `node-pty` | Missing build toolchain | See prerequisites above |

## Security notes

- There is **no authentication** — anyone who can reach the port on your tailnet can open
  terminals on that machine. Keep your tailnet ACLs tight.
- termhub binds only the Tailscale interface by default. Do **not** set `TERMHUB_BIND=0.0.0.0`
  on a machine with a public interface unless you add your own access control in front.
