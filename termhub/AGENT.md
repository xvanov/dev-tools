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
`GET /api/ping` (sessiond liveness). The `front` answers `GET /api/health` itself (front up +
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
turn whose `stop_reason` is `end_turn`, `stop_sequence` or `null`, and which actually has text.
A `tool_use` stop is mid-work and is **not** announced — except `AskUserQuestion` and
`ExitPlanMode`, whose whole purpose is to ask. Subagent turns (`isSidechain`) are skipped
wholesale: one request can spawn a dozen and each one "finishes". `thinking` blocks never make
it into the spoken text.

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
local markdown-stripping reduction; it never throws.

**Speech** (`lib/tts.js`). `piper -m <voice>.onnx -f -` — the `-f -` matters, with no `-f`
piper 1.6 writes a timestamped file into the cwd instead of streaming to stdout. Voice models
come from `TERMHUB_TTS_VOICE_DIR` (default `~/.claude/piper-voices`); files under 4 KB are
skipped because partially-downloaded stubs crash piper. piper's onnxruntime GPU warnings on
stderr are drained and ignored. 30 s timeout with the child killed, and a small LRU keyed on
sha1(voice + text) so re-reads are free.

Measured on the dev box: piper ~0.9 s for a 5 s clip, `claude -p --model haiku` ~3.8 s. End to
end, from the finished turn appearing in the transcript to `waiting` reaching a browser: **~1.7–2.2 s**
for a short turn (poll tick + quiet window) and **~7 s** for one that goes through haiku. Four
concurrent `/api/tts` requests left `/api/ping` round-trips at a worst case of 11 ms — every
child is spawned asynchronously and nothing blocks `sessiond`'s event loop.

### Voice API

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/voice/status` | — | `{tts:{available,voice,voices:[{id,label}]}, summarizer:{available}, sessions:[{id,armed}]}` |
| `POST` | `/api/sessions/:id/voice` | `{armed}` | `{ok:true, armed}`; 404 if no such session |
| `GET` | `/api/sessions/:id/voice/summary` | — | `{summary, turnUuid, waiting}` — recompute on demand ("read that again") |
| `POST` | `/api/tts` | `{text, voice?}` | `audio/wav`, `Cache-Control: no-store`; 400 empty/over 4000 chars, 503 if piper is unavailable |

`GET /api/sessions` gains `voiceArmed` per session.

`WS /ws/voice` is a page-wide feed (not per session). Server → client:
`{type:'hello', tts:{available,voice}, sessions:[{id,title,armed}]}` on connect, then
`{type:'waiting', sessionId, title, turnUuid, summary}`, `{type:'busy', sessionId}` and
`{type:'armed', sessionId, armed}`. Client → server: `{type:'ping'}` → `{type:'pong'}`.
Arming goes over REST, not the socket, so it survives a dropped connection.

**When it stays silent.** No `piper`, no voice models, no `claude` CLI, no transcript, a
session that isn't `kind: claude`, or a mid-tool-call turn — all of these degrade to silence,
never to an error. If a session banner shows `⚠ Transcript saving is off`, Claude was started
with an inherited `CLAUDE_CODE_CHILD_SESSION` (i.e. termhub itself was launched from inside
another Claude Code session) and writes no transcript at all; start `sessiond` from a clean
environment. Production's systemd unit already is one.

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
- Add the tab to your home screen for an app-like, full-screen experience.

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
| 🔊 armed but never speaks | No transcript to read | Session must be `kind: claude`; `⚠ Transcript saving is off` in the banner means an inherited `CLAUDE_CODE_CHILD_SESSION` — restart `sessiond` from a clean environment |
| 🔊 reports speech unavailable | No `piper` or no usable voice model | `curl localhost:7010/api/voice/status`; install piper and put `<voice>.onnx` + `.onnx.json` in `TERMHUB_TTS_VOICE_DIR` (files under 4 KB are treated as broken stubs and skipped) |
| Announcements sound like a rewrite, not the answer | Turn was long enough to go through `claude -p --model haiku` | Expected; turns under ~240 chars are spoken verbatim. `claude -p` failing just falls back to a local trim |
| `npm install` errors on `node-pty` | Missing build toolchain | See prerequisites above |

## Security notes

- There is **no authentication** — anyone who can reach the port on your tailnet can open
  terminals on that machine. Keep your tailnet ACLs tight.
- termhub binds only the Tailscale interface by default. Do **not** set `TERMHUB_BIND=0.0.0.0`
  on a machine with a public interface unless you add your own access control in front.
