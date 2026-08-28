# termhub — install & troubleshooting (detailed)

Companion to [README.md](./README.md). termhub runs **two processes per machine**: a persistent
**`sessiond`** that owns that machine's terminals (PTYs), and a swappable **`front`** that serves
the web UI and proxies to `sessiond`. This split is what lets updates swap the front without
killing terminals. There is no cross-machine hub — you reach each machine directly at its own URL.

Repo-wide working agreement (commit-and-push every unit of work, commit style): [../CLAUDE.md](../CLAUDE.md).
It matters more here than elsewhere: `windows/update.ps1` deploys by `git pull --ff-only` and
**fails on a dirty tree**, so uncommitted work blocks the next update on every machine.

## Mental model

```
                         Tailscale Serve  (https://<host>:7000, tailnet IP only)
                                    │
                                    ▼
browser tab ──http+ws──►  front  (UI + proxy, 127.0.0.1:7000)   ◄── http://127.0.0.1:7000
                              │   proxies /api/*, /ws/term/* and /ws/voice to ↓
                              ▼
                          sessiond  (127.0.0.1:7010)  ──► node-pty PTYs
```

- Run termhub on every machine you want terminals on.
- Open one browser tab per machine (bookmark each Tailscale URL on your phone). **The tab is
  named after the machine, not after the app** — `setPageTitle()` in `web/app.js` sets
  `document.title` from `/api/sessions`'s `machine` (and the `apple-mobile-web-app-title` meta
  with it, so two machines added to an iOS home screen don't both land as "termhub"). With one
  tab per machine, the app name is the one part that can't tell them apart. `index.html` still
  ships `termhub` as the static title for the moment before the first poll answers.
- A session = one PTY living in **`sessiond`**, with an in-memory scrollback buffer. Browser
  (re)connections attach to it via the `front` proxy and get a replay of the buffer, then live
  output.
- **One port means one thing.** Serve binds only the *tailnet* IP, so the front can hold
  `127.0.0.1:7000` at the same time — `https://<host>:7000/` and `http://127.0.0.1:7000/` are then
  the same server. That's *single-port* mode, the default. See *Port modes* below for the
  blue/green alternative and what it buys.
- **Updates** (`windows/update.ps1`): swap the `front` for the newly pulled one and verify it before
  keeping it. `sessiond` is never touched, so terminals survive. See *Two-tier layout & safe
  updates* below.
- For **local dev**, `node server.js` runs both tiers in one process on `:7000`. It **refuses to
  start** when a real deployment is already up, because it would shadow it — see *One process per
  port* below.

## Ports & binding

- Listens on `TERMHUB_PORT` (default 7000), bound to `TERMHUB_BIND` if set, else auto:
  `tailscale ip -4` → any `100.64.0.0/10` interface → `127.0.0.1`. The loopback fallback
  means it never silently exposes itself on a public interface.
- The Windows scripts always pass `TERMHUB_BIND=127.0.0.1` and publish via Serve; the front's own
  port comes from `TERMHUB_FRONT_PORT`, which is the publish port in single-port mode (see
  *Port modes*). `start-http.ps1` is the exception — it binds the tailnet IP directly, no Serve.
- Local dev without Tailscale: `TERMHUB_BIND=127.0.0.1 node server.js`, then open
  `http://127.0.0.1:7000`.

## Manual run / smoke test

Single-process dev (both tiers in one process on :7000):

```bash
npm install
node server.js
# browser → http://<tailscale-ip>:7000
```

On a machine that already runs the real two-tier deployment this exits 3 rather than shadowing it.
Give the dev instance its own ports instead:

```bash
TERMHUB_PORT=7100 TERMHUB_SESSIOND_PORT=7110 node server.js
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
`GET /api/ping` (sessiond liveness **and identity**: `{ok, sessions, entry, pid, port, machine,
commit, startedAt}` — see *One process per port*). Attachments take a **raw binary body** with the filename in
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
`POST /api/clipboard-probe` → `{platform, target, staged, verified, error}` stages a 1x1 PNG
and reads it back, which is how you answer *"will a pasted image reach the agent on that
box?"* without sitting at it. It replaces whatever is on that machine's clipboard, hence POST.
`staged` and `verified` fail independently and the difference is the whole diagnosis (see
*Attachments*).
The `front` answers `GET /api/health` itself (front up +
sessiond reachable) for the updater's probe, `GET /api/update/check` (`?force=1` to skip the
60s cache), and `GET /api/secure-url` → `{secureUrl}`, the HTTPS address Tailscale Serve publishes
this front on (`null` when it publishes none — see *Secure context* below) — all three are handled
by the front and never proxied. `/api/health` returns
`{ok, front, self:{entry,pid,port,commit,sessiondPort}, sessiond}`, with `self` present on the 503
path too; the updater checks `self.pid`/`self.commit` to confirm green is the process it started
running the commit it just pulled. Terminal stream: WebSocket `/ws/term/:id` with JSON
`{type:'input'|'resize'}` up and `{type:'replay'|'output'|'exit'}` down.

## Two-tier layout & safe updates

`sessiond` (the PTY supervisor) and `front` (the UI + proxy) coordinate through a few files in
the data dir (`%LOCALAPPDATA%\termhub` on Windows, `~/.local/termhub` on Linux):

- `state.json` — `{ sessiondPort, activeFrontPort, publishPort }`: which loopback port Tailscale
  Serve currently targets. Written by `start.ps1` / `update.ps1`, read by both.
- `sessiond.pid`, `front-<port>.pid` — two-line (`PID`\n`PORT`) files each process writes **after
  winning its port bind** and removes on a clean exit; the scripts read them to find/stop the right
  process. They are *bookkeeping*, never authority — see "One process per port" below.
- `sessions.json` — the session archive (`lib/archive.js`). Mirrors each session's metadata
  (cwd, command, `kind`, and — for shell sessions — the command lines typed in it) so it
  survives a reboot. Written by `sessiond` on create / rename / exit / input.
- `logs\<tier>.out.log` / `.err.log` — each tier's stdout and stderr, one `.prev.log`
  generation kept (`Get-TermhubLogDir`, `Start-TermhubNode`). Rotated on launch rather than
  appended, because the file a relaunch is about to truncate holds the last words of the
  process that just died. **This did not exist until 2026-07-31**, and its absence is why the
  outage that produced the watchdog has no root cause on record: both tiers were launched
  `-WindowStyle Hidden` with no redirection, node exits *normally* on an uncaught exception
  so there is no WER dump, and nothing reaches the event log. The front's death was
  unknowable, not merely unknown. **A live tier's log reports 0 bytes** — NTFS doesn't
  flush the size into the directory entry while the writer holds the file open — so
  measure these with `Get-Content`, never `Get-ChildItem`/`.Length`. Only the closed
  `.prev.log` has an honest size.

### One process per port (and why a pid file is never the proof)

The port bind is the only authority on "is this tier already running". A pid file goes stale, and
pids get reused, so `lib/state.js` treats it as a record to be kept honest rather than a lock:

- **Claim after listen.** `startSessiond`/`startFront` write the pid file inside the `listen`
  callback, and only when passed `claimPid: true`. A process that loses the bind never records
  itself.
- **Only the named process may delete it** (`removeOwnPidFile`, and `Remove-OwnedPidFile` on the
  PowerShell side). Both halves matter, because the scripts kill by *port* and the pid file for a
  tier is not guaranteed to describe whoever holds that port.
- **`EADDRINUSE` is a clean, loud refusal** (exit 3), not a stack trace. `sessiond.js` pre-flights
  the port first purely to name who's there.
- **`server.js` refuses to start** when a two-tier sessiond or front is already live. It's the dev
  single-process entrypoint and it binds the publish port *and* a sessiond, so left running it
  becomes the machine's de-facto supervisor.

This is all one bug's worth of scar tissue. The old order was claim-then-bind, and a duplicate
sessiond launch (a leftover `node server.js` already owned 7010) went: write the pid file → fail
the bind → exit → **delete the file it had just overwritten**. The healthy supervisor was left with
no pid file, so the next update read "no sessiond running", launched another duplicate, and the
cycle repeated. Meanwhile `Wait-SessiondUp` was satisfied by *anything* answering `/api/ping`, so
the update declared sessiond healthy and deployed a fresh front on top of a supervisor running
days-old code — a fully updated UI over stale `sessiond` behaviour, which is the hardest possible
symptom to read. Covered by `test/state.test.js`.

So `/api/ping` and `/api/health` now carry **identity**, not just liveness: `entry`
(`sessiond` | `server` | `front`), `pid`, `port`, `commit` (the commit the *process* runs, from
`lib/build.js`), and `startedAt`. `Confirm-Sessiond` uses it to tell a real supervisor from the
monolith, and to verify the pid answering is the pid it just spawned; `update.ps1` uses it to
confirm green is the process it started, running the commit it just pulled.

### Port modes

`state.json` encodes the mode implicitly: **`activeFrontPort == publishPort` is single-port**,
anything else is blue/green. `start.ps1 -SinglePort` / `-BlueGreen` switches (and stops the other
mode's fronts, which would otherwise keep serving stale code on a port nothing points at).

**Equal ports are ambiguous, though**, and anything that re-binds a front has to know it:
`start-http.ps1` *also* writes `activeFrontPort == publishPort`, because it binds the front to the
tailnet IP itself and turns Serve **off** for that port. Single-port and plain-HTTP are therefore
recorded identically, and only Serve's own config tells them apart — `Test-ServePublished` in
`common.ps1` (`tailscale serve status --json`), which answers `$null` rather than `$false` when it
can't consult Serve at all, because guessing "not published" is the dangerous direction.
`restart-front.ps1` used to read equal ports as plain-HTTP and so, on the *default* layout, tried to
bind `<tailnet-ip>:7000` — a port `tailscaled` already holds for Serve. It failed the health check
and left no front at all; since `restart-sessiond.ps1` calls it, a deliberate sessiond restart took
the UI down with it, after the terminals had already been ended. Fix: `.\windows\start.ps1`.

`update.ps1` had the mirror-image bug: it read equal ports as single-port *unconditionally*, with no
plain-HTTP branch at all. On a plain-HTTP machine the ⟳ Update button would swap in a new front bound
to `127.0.0.1` (not the tailnet IP) and then force-enable Serve on the publish port — so the front
became reachable only from the box itself while Serve's HTTPS listener took over the tailnet address
the front used to own. A plain `http://` request to that address then hit a TLS endpoint and failed
with "Client sent an HTTP request to an HTTPS server." Both scripts now resolve the same three modes
via `Test-ServePublished`.

| | single-port (default) | blue/green |
|---|---|---|
| front binds | `127.0.0.1:7000` | `127.0.0.1:7001` or `7002` |
| Serve | `:7000 → 127.0.0.1:7000` | `:7000 → 127.0.0.1:700{1,2}` |
| `http://127.0.0.1:7000` | works, same server | **nothing there** |
| update cutover | front swapped in place, ~1–2s of refused connections | atomic Serve re-point, no gap |
| rollback | must *restart* the old version | old front never stopped |

The thing that makes single-port work: **Serve listens on the tailnet IP only**
(`100.x.y.z:7000`, `fd7a:…:7000`), never on loopback. So `:7000 → 127.0.0.1:7000` is two different
sockets, not a loop, and one port number answers everywhere. Verify with
`Get-NetTCPConnection -State Listen -LocalPort 7000` — expect the tailnet addresses owned by
`tailscaled` and `127.0.0.1` owned by `node`.

Either way, a loopback listener on the publish port that **isn't a front** is a squatter.
`Clear-PublishPort` (run first by `start.ps1` and `update.ps1`) decides on identity, not on mode: it
leaves anything reporting `entry: 'front'` alone in both modes, and removes a `node server.js`
monolith in both. Only `node` processes are ever killed.

Identity is settled by **the ports a pid holds, before anything it says about itself**: one process
listening on the publish port *and* the sessiond port is the monolith, whatever it reports. It has
to be, because the monolith passes both of the softer tests — it genuinely runs a front on the
publish port, so `/api/health` answers `entry: 'front'` truthfully, and an earlier update that
believed that answer wrote a `front-<port>.pid` vouching for it. Reading either one first left the
monolith standing while `Confirm-Sessiond` identified the *same pid* as a supervisor-shadowing
squatter and stopped it — one script, two verdicts, on one process.

That kill is also the one that must never happen blind. `update.ps1` is *designed* to run from a
termhub terminal, so its shell is a descendant of sessiond; when sessiond and the publish-port
squatter are the same process, stopping it kills the updater mid-run — nothing pulled, nothing
restarted, no rollback, termhub down until the next logon. So `Clear-PortSquatter` walks the parent
chain (`Get-AncestorPids`, with a `CreationDate` check so a recycled pid isn't mistaken for an
ancestor) and **refuses to stop an ancestor of the running script**, printing the "re-run from a
normal PowerShell window" instruction instead. Compare `restart-sessiond.ps1`, which refuses on
`TERMHUB_SESSION_ID` — a blunter rule that update deliberately can't use, since running from a
termhub terminal is the normal case.

The squatter has a cause worth checking before treating the symptom: on machines installed before
the split, the **`Termhub` scheduled task still runs `node server.js`** and recreates it at every
logon. `install.ps1` registers `start.ps1` correctly — but **only when elevated**, since registering
a scheduled task is an admin operation; run non-elevated it installs the Startup-folder launcher and
leaves the stale task alone, so the squatter survives an install that looked successful.
`Test-TermhubTask` warns on every start/update until someone fixes it from an admin shell (re-run
`install.ps1`, or `Unregister-ScheduledTask -TaskName Termhub -Confirm:$false` and let the Startup
launcher do it). Inspect with `(Get-ScheduledTask Termhub).Actions | Format-List Execute,Arguments`.

### Restarting sessiond on purpose

`windows/restart-sessiond.ps1` is the deliberate counterpart to the safe update: it **ends every
live terminal** (PTYs are sessiond's memory and can't be migrated) and they come back as
*Restorable* from `sessions.json`. It refuses to run from inside a termhub terminal —
`TERMHUB_SESSION_ID` is set in every spawned PTY (`lib/session.js`) — because that terminal is one
of the ones it kills. Use it for sessiond-side changes; `update.ps1` prints a reminder when a pull
touched `sessiond.js` or `lib/` while the running supervisor is still on the old commit.

### Session persistence (surviving reboots)

PTYs live only in `sessiond`'s memory, so a machine reboot kills every terminal and the sidebar
comes up empty. `sessiond` mirrors session *metadata* to `sessions.json`; on the next start those
entries (no longer matched by a live PTY) are returned as `restorable` and the sidebar shows a
**Restorable (after restart)** section. The processes themselves can't be resurrected, so
"restore" re-spawns: a `claude` session re-opens as `claude --resume <uuid>
--dangerously-skip-permissions` in its old cwd, resuming *that exact conversation* — the uuid
termhub pinned with `--session-id` at launch (bare `--resume`, i.e. Claude's cwd-scoped picker, is
only the fallback for a session whose id was never tracked); any other session re-opens as a plain
shell in its old cwd with its recorded command history printed in as a dim, commented block to
re-run by hand.

The restore command is built in `lib/restore.js`, and its one job is that the command carry
**exactly one** conversation-identity flag. It didn't, for a while, and the bug is worth
remembering because of how it presented: termhub archives the command it actually launched, which
already contains `--session-id <uuid>`, and restore *appended* `--resume <uuid>` to it. Current
Claude CLIs reject that pair outright (`--session-id can only be used with --continue or --resume
if --fork-session is also specified`), so the restored terminal printed one line of usage error and
sat at a bare shell — looking like "restore does nothing", and only on machines whose CLI was new
enough to enforce the rule. `restoreClaudeCommand` now strips every identity flag
(`--session-id`, `--resume`/`-r`, `--continue`/`-c`, `--fork-session`) before adding its own, which
also repairs the already-mangled entries sitting in `sessions.json`. `--fork-session` is
deliberately *not* the fix: forking starts a new conversation id, which detaches the session from
the transcript the model badge and voice layer read. Stripping is confined to the `claude` segment
of the line (up to the first `&&`/`||`/`;`/`|`) so a `-c` belonging to some other command survives.
Covered by `test/restore.test.js`. Killing a live session (✕) or forgetting a restorable one
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

`windows/update.ps1`: reclaim the publish port → ensure `sessiond` → `git pull --ff-only` (rollback
ref saved) → `npm install` only if `package*.json` changed → deploy the new `front` → verify →
update the Claude CLI. The deploy step resolves the same three modes as `restart-front.ps1` — via
`Test-ServePublished`, not from `state.json` alone (see *Port modes*):

- **single-port** — stop the front on `<publishPort>`, start the new one on the same port (bound to
  `127.0.0.1`). On failure, `git reset --hard` to the rollback ref and restart the *previous*
  version there, so the machine is left serving something; if even that fails the script says the
  UI is down and names `start.ps1`.
- **plain-HTTP** — the same in-place swap, but bound to the tailnet IP and with Serve never touched.
  Recorded identically to single-port in `state.json`, so this script used to always take the
  single-port branch here: it started the new front on loopback and force-enabled Serve on the
  publish port, which left the front reachable only from the box itself while Serve's HTTPS
  listener took over the tailnet address the front used to own — a plain `http://` request to that
  address then hit a TLS endpoint and failed with "Client sent an HTTP request to an HTTPS server."
  Fixed by giving this branch its own path, mirroring `restart-front.ps1`.
- **blue/green** — start the new front on the alternate of `{7001, 7002}`, then re-point
  `tailscale serve --https=<publishPort>` to it and stop the old one. On failure the new front is
  stopped and the tree reset; the old front never stopped serving.

Verification is the same for both and lives in `Start-VerifiedFront`: `/api/health` reports
`ok`, the proxied `/api/sessions` and static `/` both return 200, **and** `self.pid` matches the
process just spawned while `self.commit` matches the commit just pulled. Health alone would pass a
stale process that happened to own the port. `sessiond` is never restarted, so PTYs (and the terminal
running the updater) survive either path.

`node-pty` lives only in `sessiond`, so routine front updates need **no native rebuild**. A
`node-pty` version bump only takes effect on a deliberate `sessiond` restart (which does clear
sessions — do it intentionally).

### The install step throws the lockfile rewrite away

Every `npm install` here is followed by `git checkout -- package-lock.json`, in **all four** scripts
that install deps (`linux/update.sh`'s `discard_lock_churn`, `windows/update.ps1`, and both
installers). This is not cosmetic tidiness — it is what keeps the deploy loop able to run twice.

npm rewrites the lockfile into whatever shape the *local* npm version prefers even when nothing
about the installed tree changed: npm 11.6.2 records `"peer": true` on `@xterm/xterm`, 11.12.1 does
not. Machines on different npm versions therefore dirty that file back and forth forever, and each
side sees a one-line diff that looks worth committing. Committing it is the trap: the commit is a
`package-lock.json` change, so it makes `deps_changed` true on the *other* machine, which runs
`npm install`, which rewrites the file back — and a dirty tree is exactly what the next
`git pull --ff-only` refuses. The update that installed the deps is the one that blocks the update
after it, on a machine you are not looking at.

The lockfile is authoritative and `node_modules` is derived from it, so the rewrite carries no
information worth keeping. Discarding it makes the churn unobservable and the ping-pong impossible,
whatever npm each machine happens to run. If you ever see that diff again, don't commit it.

### A refused `--ff-only` pull heals itself when it safely can

Both updaters treat a refused `git pull --ff-only` as a question rather than a verdict:
`heal_diverged_history` in `linux/update.sh`, and `Repair-DivergedHistory` in `windows/common.ps1`
(in the shared helpers, not in `update.ps1`, so it can be dot-sourced and tested without running an
update). `test/updateHeal.test.js` pins them to the same question.

The failure worth healing is **upstream history rewritten and force-pushed from another machine** —
a rebase, an amend, a corrected author email. Every commit this machine already pulled now has a
patch-identical twin upstream under a different sha, so git reports a divergence and `--ff-only`
refuses, on a checkout that has contributed nothing of its own. That refusal is permanent, and it
is *silent*: a wedged machine also stops being a machine anyone force-pushes from, so nothing
draws attention to it until someone opens a terminal there. It happened here — five commits deep,
rewritten only by author email — and the machine could not have updated itself again.

The question that separates it from the case that must never be healed is
`git log --cherry-pick --right-only <upstream>...HEAD`: local commits whose **patch** appears
nowhere upstream. It compares patch-ids, so it sees straight through the rewritten shas, dates and
author lines that made the two histories look unrelated. Empty means the local lineage is a
duplicate and `git reset --hard <upstream>` loses nothing. Non-empty means real unpushed work, and
the update stops and prints the commits it refused to destroy.

Three other guards, each of which alone stops the reset: a **dirty tree** (checked first, needs no
network), a **failed fetch** (an offline machine must be diagnosed as offline, not compared against
a stale upstream ref), and **not actually diverged** — behind-only or ahead-only means the pull
failed for a reason the heal cannot see, and a `git reset --hard` triggered by a flaky connection
is precisely the disaster this must not become. The pre-reset lineage is kept on branch
`termhub-pre-reset`, which is a human's record *and* what keeps the rollback ref a referenced
object for the restart phase that may still need it.

`bash linux/update.sh --heal` runs the check alone, without updating anything — the hand tool for a
wedged machine, and how the tests reach the logic.

**Both halves are tested by execution, not by reading.** The whole question is what git actually
reports for a rewritten upstream, which no assertion about a script's text can answer, so
`test/updateHeal.test.js` (Linux) and `test/repairHistory.test.ps1` (Windows) each build real
repositories: a genuinely rewritten upstream, unpushed work, a dirty tree, behind-only. Each fixture
first asserts that it *is* diverged — an amend landing in the same second as the original produces
an identical sha, and the resulting fixture tests nothing at all.

The PowerShell test runs natively on Windows, and on a Linux box through a container:

```bash
docker build -t termhub-pstest - <<'EOF'
FROM mcr.microsoft.com/powershell:latest
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
EOF
docker run --rm -v "$PWD:/repo:ro" termhub-pstest pwsh -NoProfile -File /repo/test/repairHistory.test.ps1
```

Two PowerShell hazards are worth knowing, because both were hit while writing this. A function
returns **everything that reached the pipeline**, so one un-suppressed `git` line inside
`Repair-DivergedHistory` would turn a refusal into a truthy "success" — which is why `update.ps1`
re-asks git whether HEAD equals `@{u}` instead of trusting the return value, and why the test
asserts the return is a bare `[bool]`. And functions **shadow native commands** (name resolution
prefers them, case-insensitively), so a test helper called `Git` calling `& git` calls *itself*,
forever; the fixtures resolve the executable through `Get-Command git -CommandType Application`.

### The Claude Code CLI is a pinned dependency

termhub uses Claude Code through surfaces that are not a public API: it pins a conversation with
`--session-id`, resumes it with `--resume` (above), and reads the transcript at
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` for the model badge, spoken announcements, and turn
summaries. A CLI change to any of those breaks termhub silently — the restore bug above worked fine
on a machine with an older CLI and failed on an up-to-date one, which is the worst possible way to
learn that the coupling exists. So the version is treated as a dependency:

- **The pin** lives in `package.json` under `termhub.claudeCli` (`minVersion`, `verifiedVersion`) so
  a bump is a reviewable one-line diff. `lib/claudeCli.js` finds the CLI, reads `claude --version`,
  and compares numerically (a string compare would rank `2.1.220` *below* `2.1.3` and nag about a
  perfectly current CLI). Lookup order: `TERMHUB_CLAUDE_BIN`, `claude` on `PATH`, then the
  installers' known locations — the front can run from a systemd `--user` service whose `PATH`
  lacks `~/.local/bin`, where the native installer puts the launcher.
- **Reporting**: `GET /api/update/check` carries a `claudeCli` block on every path (including its
  error paths). The ⟳ Update button shows its dot for an unmet pin as well as a behind-checkout, and
  the update panel gets a Claude CLI line plus an **Update Claude** button that runs `claude update`
  in a visible terminal. A CLI that can't be *found* is reported as an error, never as "too old" —
  a `PATH` quirk must not train the user to ignore the warning.
- **Updating**: both platform updaters now update the CLI too, so a machine can't drift by updating
  only termhub — the last step of `update.ps1`, step 3 of `linux/update.sh`. Non-fatal in both
  (`|| true` / a yellow warning): an offline or rate-limited `claude update` must not roll back a
  good termhub update. Running `claude` sessions keep the build they started with; the new one
  applies to sessions started after.

**To bump the pin**: exercise the new CLI first — launch a claude session, restart `sessiond`,
restore it, and confirm the conversation comes back *and* the model badge and 🔊 announcements still
resolve. Then set both `minVersion` and `verifiedVersion` in the same commit.

## opencode talks over HTTP, not over its transcript

termhub launches every opencode session with `--port <n> --hostname 127.0.0.1` spliced in right
after the executable token (`injectAfterOpencodeExe`), because **opencode's TUI serves the same API
`opencode serve` does — for that running instance**. `lib/opencodeApi.js` is the client. That one
flag is what buys parity with Claude Code, and on three of four counts it is a better deal than the
Claude side gets:

| | Claude Code | opencode |
|---|---|---|
| which conversation is this? | pin `--session-id` at launch and hope it isn't forked away | every event carries `sessionID` |
| which model? | parse the newest transcript JSONL | `session.model`, live |
| is a turn finished? | infer from `stop_reason` | `session.idle` |
| **is it asking me something?** | **unknowable** — see the voice layer below | `question.asked`, *with the question text and its options* |

The last row is the one that matters. The voice layer's ugliest compromise is that a Claude session
parked on a question writes nothing to its transcript until you answer, so termhub has to guess from
12 s of PTY silence and can never say *what* is being asked. opencode publishes the question, its
header and its options the moment it asks, so `_pollOpencode` has no heuristic in it at all.

**Ports.** `freePort()` binds one, reads it, and lets go. There is an unavoidable race between that
and opencode's own bind — opencode has no "bind any port and tell me which" mode we can read back —
but the window is milliseconds and the failure is loud and recoverable: the TUI exits, the PTY shows
why, and the session degrades to the old subprocess path. A user who supplies their own `--port` is
honoured, not overridden. A **restore strips the old pair** (`stripOpencodeServerFlags`): that port
belonged to a process that is gone, and re-binding it would either fail or, worse, adopt whatever
took it over. Covered by `test/restore.test.js`.

**Identity, in three escalating steps**, because each is wrong on its own:

1. `--session <id>` in the command line, read at construction. This is what restore builds and what
   a user resuming by hand types, and reading it is free and exact — not reading it left a restored
   opencode with no model badge until the user happened to type something.
2. Otherwise a *seed* from `GET /session`, filtered to this cwd and to sessions created since we
   launched. The date guard is what stops us adopting an **older** conversation that happens to live
   in the same directory. Note `GET /api/session/active` reads like the obvious answer and is a
   trap — measured against 1.18.15 it returns `{"data":{}}` even with a conversation open and even
   when the TUI was launched with `--session <id>`. It's asked first anyway, cheaply, in case a
   later version starts populating it; nothing depends on it.
3. Then the event stream **names** the session, and that supersedes both. Seeding stops the moment
   an event has spoken: once we've been told, guessing from a directory listing can only make it
   worse.

**The model badge no longer shells out.** `_opencodeModel()` returns straight from a cache the event
stream keeps current, so a model switch shows up immediately instead of within 10 s, and the 1.4 s
`opencode export` subprocess is gone from the hot path. `lib/opencodeModel.js` stays as the fallback
for a session with no port — one launched by an older build, or one whose TUI never opened its API.

**The event stream is the lifecycle.** `subscribe()` reconnects with the same backoff shape the
browser's sockets use and for the same reason: the TUI can be restarted under us, and a feed that
gave up once would leave that session permanently silent with no sign of why. It is closed on PTY
exit *and* on `kill()` — otherwise it would retry a dead port every few seconds for the life of
`sessiond`.

**Verified against opencode 1.18.15.** This is a coupling to surfaces that are not a stable public
API — `--port` on the TUI, `GET /session`, `GET /event`'s type strings, `question.asked`'s shape —
exactly like the Claude CLI pin above. When it breaks it will break silently and degrade to the
subprocess path, so if the model badge on an opencode session starts lagging by 10 s again, that is
the symptom: the API attach failed and nothing said so.

### Arming 🔊 is no longer "is it claude"

`Session.canSpeak()` is the single answer — `claude`, or an `opencode` termhub gave a port to — and
it is reported in `GET /api/sessions` as `canSpeak`. `VoiceHub.canArm` delegates to it, and the
browser reads the field rather than re-deriving the rule from `kind`, where it would drift. An
opencode session started by an older build genuinely cannot be armed, and the 🔊 tooltip says so
rather than leaving an inert toggle to be discovered.

`_pollOpencode` is the counterpart to `_readTranscript`, and is markedly duller: no mtime poll, no
`stop_reason` interpretation, no PTY-silence heuristic. It waits for `session._opencodeIdleAt` (set
by `session.idle`, cleared by `session.status`), reads the turn once, and dedupes on the message id.
An armed-but-idle opencode session costs nothing — the HTTP read happens once per turn, not once per
tick. A question is announced **verbatim**, never summarised: paraphrasing away the options is
exactly the wrong thing to do to a question.

One thing that had to be asked for explicitly: **attaching to a session that is already idle**. The
Claude path gets this free (its mtime cache starts at `-1`, so the first poll after arming always
reads), but nothing fires an event at a TUI that is simply sitting there. So once the API is ready
we check for a finished turn and seed `_opencodeIdleAt` from it — otherwise arming 🔊 on a restored
session stayed silent until the user prompted again.

## Staying up (`watchdog/`)

Nothing used to restart a tier that died. The `Termhub` scheduled task fires **at logon and never
again**, so on 2026-07-31 a `front` that exited some hours after being started left termhub down
until it was noticed by hand — `sessiond` was untouched the whole time, holding four live PTYs
behind a port with nothing listening on it. `watchdog/` is the supervisor that was missing.
Full docs: [watchdog/README.md](./watchdog/README.md), remedy contract:
[watchdog/remedies/README.md](./watchdog/remedies/README.md).

The cycle: probe → stand down if a deploy is running → confirm 3× over ~15s → run
`remedies\<signature>.ps1` if one exists → otherwise escalate to `claude -p`, which fixes the
outage **and writes that remedy**, then commits it.

`Invoke-Remedy` passes the six topology arguments to a remedy through `Start-Process
-ArgumentList`, and that cmdlet **rejects the entire list if any element is an empty string** on
PowerShell 5.1. `$TailnetIp` is empty exactly when tailscaled can't be asked — the whole premise of
`tailnet-ip-unavailable` — so a remedy for that signature could never be spawned at all: the
watchdog logged a *spawn* error and escalated, which reads like "the remedy failed" rather than
"the remedy never ran". It now sends a literal `""` token, which the child's `-File` parser binds
back to an empty string. Any argument that can legitimately be empty needs the same treatment.

### Two implementations, because there are two deployments

`watchdog.ps1` and `watchdog.sh` share the *design* — signature → remedy → escalation, the
budget, the kill switch — and almost no code, because what they watch is not the same thing.
Windows has two tiers and can replace the broken one; **Linux is a single `server.js` under a
systemd `--user` unit**, so its PTYs are in the same process as its HTTP server.

That has one consequence worth stating loudly, because it inverts a Windows assumption: on Linux
**restarting termhub destroys every live terminal**. So the Linux watchdog only restarts when
nothing is being served anyway (`service-inactive`, `service-failed`) and *escalates* a service
that is up but unhealthy or unbound, where the Windows watchdog would happily swap the front.
Killing the user's running work to clear a health blip is not a repair. Linux also already has
`Restart=on-failure`, so the watchdog's remit there is what systemd can't fix: a unit stopped,
disabled, or given up on after `StartLimitBurst`; a port held by a stranger; a process alive but
not listening.

The Linux probe checks **every address termhub could be on** — `TERMHUB_BIND`, loopback, the
tailnet IP, and anything `ss` reports listening — and that is not defensive padding. With no
`TERMHUB_BIND`, `server.js` binds the **tailnet IP** and only falls back to loopback if there
isn't one, so a loopback-only probe reports `not-listening` on a perfectly healthy default
install and escalates it. The same bug in `linux/update.sh` would have been worse: its
post-restart health check would have failed and **rolled back a good update**. Any new code that
asks "is termhub up?" on Linux must check the set, not a guess.

### The ⟳ Update button installs the watchdog (and why that was hard)

`lib/update.js:updateCommand()` is composed by the **running** front, so it always encodes the
*old* build's idea of how to update. An inline command therefore can never carry a change to the
update procedure itself. Windows always delegated to `windows/update.ps1`; Linux was an inline
`git pull && claude update && systemctl --user restart termhub`, which is exactly why no new step
could ever reach a Linux machine. Both now delegate to a script in the repo, so the pull brings
the procedure with it. `test/update.test.js` guards this, including the absence of the old inline
tells — if `git pull` reappears in that string, self-application is broken again.

`linux/update.sh` is shaped by one constraint: the updater runs **inside a termhub PTY**, and on
Linux the restart kills that PTY mid-script. Anything sequenced after the restart never happens.
So the watchdog step comes *before* it (also asserted by the test), and the restart is handed to a
**detached `--finish` re-exec** which is the only thing left alive to verify the new build and
`git reset --hard` back if it never becomes healthy. The old inline command had the same ordering
constraint and no way to verify anything at all.

**"Detached" has to mean out of the cgroup, and `setsid` does not do that.** termhub is a systemd
`--user` service with the default `KillMode=control-group`, so `systemctl --user restart termhub`
SIGTERMs *every process in the unit's cgroup* — and the updater's PTY is a child of `server.js`,
inside it. A forked child inherits the cgroup; `setsid` gives it a new session and process group and
moves it nowhere. So the original `setsid`/`nohup` hand-off put the verify-and-rollback phase into
the exact cgroup it was about to ask systemd to kill, and it died on its own `systemctl restart`
line. systemd still completed the restart — it is the manager doing the work, not the killed
client — so **an update that worked looked perfect, and an update that broke the build silently lost
its rollback, its health check and its log output.** The safety net failed only when it was needed,
which is the worst shape a bug can have.

**And a transient unit does not inherit the caller's environment.** `systemd-run --user` starts the
unit from the *user manager's* environment, so every `TERMHUB_*` override set in the shell running
the update arrives unset on the other side — measured with a variable exported immediately before
the call. The finish phase is the half that restarts the service and decides whether to roll back,
so this was not cosmetic: `TERMHUB_SERVICE` lost means restarting the **default** service rather
than the one being updated, `TERMHUB_PORT`/`TERMHUB_BIND` lost means health-checking the wrong
address and rolling back a perfectly good build, and `TERMHUB_DATA_DIR` lost means logging somewhere
other than the path the script just printed — an update that appears to vanish without a trace. The
hand-off now forwards each of those with `--setenv`, and only when set, so an unset variable keeps
its default instead of being pinned to an empty string. The array is expanded as
`${FINISH_ENV[@]+"${FINISH_ENV[@]}"}`: under `set -u`, bash before 4.4 aborts on a plain
`"${arr[@]}"` when the array is empty, which is the *common* case.

The phase now goes to `systemd-run --user --unit=termhub-update-<stamp> --collect`, a transient unit
of its own that is out of termhub's cgroup and so out of reach of the kill; `setsid` remains as the
fallback for a termhub that isn't under such a unit at all (a hand-started `server.js`, a
container), where it is genuinely sufficient. Measured both ways with an isolated transient unit:
the `setsid` child kept `/user.slice/…/<unit>.service` and died with it, while the `systemd-run`
phase outlived the stop it had itself triggered. `test/update.test.js` pins the hand-off to
`systemd-run` rather than to `setsid`, because anchoring on `setsid` is exactly what would let this
regress unnoticed.

The first click on a machine still running the old inline command can't know about any of this —
but it ends in `systemctl --user restart termhub`, which starts the **new** code. So
`lib/watchdogSetup.js` installs the watchdog from termhub's own startup: Linux only, 5 s after
listen, non-fatal, silent unless it changed something, skipped for a dev instance on a non-7000
port, and opt-out via `TERMHUB_NO_WATCHDOG_SETUP=1`. It is deliberately **not** enabled on Windows:
`update.ps1` restarts the front itself, so the new front would race the updater over one
`Register-ScheduledTask`, and a non-elevated front could only mint an Interactive task where an
elevated install would have given S4U.

### Installing and keeping the task honest (Windows)

The task definition lives in `watchdog\lib\task.ps1`, not in the installer, because **three**
callers register it: `install-watchdog.ps1` (explicit), `windows\install.ps1` (a new machine is
supervised from the start) and `windows\update.ps1` (a machine that *updates into* a build with a
watchdog shouldn't need a second install step). A second copy of that logic would be a second
thing to drift.

**The watchdog needs no restart to pick up its own updates.** The task's action is
`powershell -File watchdog.ps1` — a fresh process per cycle, read off disk each time — so a pull
is live on the next tick with nothing resident holding the old code. This is the opposite of the
`front`, and the reason there is no `restart-watchdog.ps1` to write. What *can* go stale is the
task **definition**, which is what `Confirm-WatchdogTask` repairs: absent, disabled, or pointing
at a checkout that has moved.

Two judgement calls in there, both about not being hostile on a routine update:

- **It never reconciles the interval.** Somebody who ran `-IntervalMinutes 5` meant it, and having
  every update quietly reset that is worse than a machine polling at a cadence you chose.
- **It never downgrades the principal.** An elevated install registers **S4U** (runs with nobody
  logged on); `update.ps1` normally runs non-elevated from a termhub terminal and can only offer
  **Interactive**. So when a re-point is needed but the existing task is S4U and the shell isn't
  elevated, it leaves the task alone and names `install-watchdog.ps1` instead. Silently trading
  "watched while logged off" for "watched while logged on" during an unrelated update is exactly
  the kind of regression nobody would notice until a reboot.

`Confirm-WatchdogTask` never throws, and `update.ps1` calls it *after* the front is already
serving: failing to register a scheduled task must never roll back a good deploy.

**The remedy library is the point, and the signature is the mechanism.** Every failure is
reduced to one of a small set of coarse slugs naming the *shape* of the failure — which tier is
missing, who holds the port — and that slug is its remedy's filename. Coarse is deliberate: a
signature carrying a pid, a port or an error string would mint a fresh one every outage and the
library would never accumulate. So each kind of failure costs one escalation and is mechanical
after that. Measured on the fault it was built for: 54 s from `Stop-Process` on the front to a
verified-healthy front, with no model in the loop.

Load-bearing constraints, each of which is a way this could go wrong rather than a preference:

- **Never restart `sessiond` to fix a `front` problem.** It holds every terminal as an
  in-memory PTY, so restarting it destroys the user's running work to repair a process that
  isn't the one that failed. Only `both-down` and `sessiond-down-front-up` may start one, and
  the escalation prompt states the rule *with the reason* — "restart the service" is the obvious
  wrong move for a model that has just been told a service is down.
- **`/api/health` returning 503 is not the same as nothing listening.** `Get-JsonEndpoint`
  folds both to `$null`; the watchdog's own `Get-HttpProbe` keeps them apart, because a front
  that is alive and cannot reach `sessiond` is the one case where replacing the front is exactly
  wrong.
- **Stand down during a deploy.** `update.ps1` and `restart-front.ps1` leave the port empty for
  ~1–2 s in single-port and plain-HTTP mode. A watchdog racing the updater for that socket is
  worse than the gap it was fixing, so a deploy script running is a reason to do nothing, and
  every outage is confirmed three times first.
- **`publish-port-squatted` has no remedy on purpose.** Killing an unidentified process to free
  a port is a worse bug than the outage — the same judgement `Clear-PortSquatter` already makes.
- **Escalations are budgeted** (≥10 min apart, ≤3/h, ≤8/day) and logged to `escalations.json`
  before and after. Past the budget it says termhub is down and needs a human, which is honest;
  a failure a model can't fix must not become a model running every two minutes forever.
- **The task uses `MultipleInstances IgnoreNew`.** An escalation can hold it for minutes, and a
  2-minute trigger would otherwise stack watchdogs all repairing the same outage at once.

Three Windows/PowerShell traps this cost, all of which fail *silently*:

- **`$L` and `$l` are the same variable.** PowerShell identifiers are case-insensitive, so a
  `List[string]` called `$L` is replaced by the first `foreach ($l in …)`, and the next `.Add()`
  hits `Hashtable.Add` and complains about argument counts.
- **`Start-Process -PassThru` yields a `$null` `ExitCode`** unless `.Handle` is touched while
  the process is still alive. `Start-TermhubNode` now does, which also un-blanks
  `Start-VerifiedFront`'s "the front exited with code …" — a diagnostic that printed no code on
  precisely the failure it exists to explain.
- **`"$env:USERDOMAIN\$env:USERNAME"` is not a valid principal** off a domain: `USERDOMAIN` is
  the literal `WORKGROUP`, which maps to no SID, and `Register-ScheduledTask` fails with "No
  mapping between account names and security IDs was done" — *without* tripping
  `-ErrorAction Stop`, so the installer's first version printed "registered" over a failed
  registration. Use `[Security.Principal.WindowsIdentity]::GetCurrent().Name`, and **verify the
  task exists afterwards** rather than trusting that no error surfaced. A machine that believes
  it is watched and isn't is the worst way for a watchdog to be wrong.

## Spoken announcements (the voice layer)

Opt in per session with the sidebar's 🔊 toggle; when an armed Claude session stops and is
waiting on you, the browser speaks a short summary of what it said. Everything runs locally.

**Where the signal comes from.** Not the terminal — reading a TUI's repainted screen is
hopeless. `lib/voiceHub.js` tails Claude Code's own conversation transcript
(`~/.claude/projects/<encoded cwd>/<session-uuid>.jsonl`), the same file the model badge reads,
located by the shared `resolveTranscript()` in `lib/claudeModel.js`. Sessions termhub launched
have `--session-id <uuid>` spliced in, so their transcript path is known exactly; a
hand-launched `claude` falls back to the newest transcript in that cwd.

**A pinned id is not permanent.** Claude Code creates the transcript for the `--session-id` we
passed and may then move the conversation to a fresh uuid (a `/clear`, or an internal resume),
leaving our file as a stub holding user/attachment entries and no assistant turn. Existence alone
therefore can't settle it: a session in that state showed no model badge and got no spoken
announcements, because voiceHub was tailing a file that would never change again. So a pinned
transcript wins while it holds a real assistant turn; if it holds none *and* a newer transcript
exists in that cwd, the conversation has moved and the newer file wins. A turnless pinned file that
is still the newest is just young — a session that launched seconds ago looks identical — and is
kept, since adopting an older conversation's transcript is the worse error.

**`<synthetic>` is not a model.** Claude Code files its own notices — spend-limit warnings,
`[Request interrupted by user]` — as `assistant` entries whose model is the literal `<synthetic>`.
They're the newest assistant entry right after any interrupt, so `readLastModel()` skips
angle-bracket placeholders and keeps walking back to the last real turn; otherwise the badge reads
`<synthetic>` until the next real response.

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
voice *input* is disabled with the HTTPS address to switch to shown, and 🎤 falls back to the same
text box a browser without speech recognition gets. This is the same constraint
`navigator.clipboard` has (see `execCopyFallback`) — which is why "paste doesn't work on my phone"
and "the mic stopped working" are usually one bug reported twice.

**That address must come from the server, and used not to.** It was built in the browser as
`` `https://${location.hostname}:7443` ``, which is wrong in both halves on the *only* origin that
ever displays it. On plain HTTP `location.hostname` is the raw tailnet IP, and Serve's certificate
covers the MagicDNS name and nothing else, so the URL could not connect — the phone got a dead
address and termhub looked broken rather than unconfigured. The port was equally a guess: it is
whatever `tailscale serve --https=<port>` was given, and it is routinely *not* the front's own port
(this checkout's Linux box publishes `:7443` in front of a front on `:7000`, while the Windows
single-port layout publishes `:7000` in front of `:7000`).

`lib/serveUrl.js` reads both halves off Serve's own config instead. `tailscale serve status --json`
keys its `Web` map by exactly the `"<magicdns-host>:<port>"` string needed, so the answer is read
off the key rather than reassembled; the match is made on the handler's proxy **port**, host
deliberately ignored, because Serve targets `127.0.0.1` in the Windows layout and the tailnet IP
where the front binds it directly and both are the same front. It answers `null` — never a
constructed guess — when Serve doesn't publish this front or can't be consulted, and the UI then
says the machine has no HTTPS address instead of naming one. The spawn is cached 60 s; the *status*
is cached rather than the resolved URL, so asking about a second port can't be handed the first
port's address. `test/serveUrl.test.js` pins this against real captured output from all three
layouts.

### Voice API

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/voice/status` | — | `{tts:{available,engine,voice,voices:[{id,label}]}, wakeWord, summarizer:{available}, sessions:[{id,armed}]}` — `engine` is `'kokoro'`/`'piper'`/`null`; `wakeWord` is `null` unless `TERMHUB_WAKE_WORD` overrides the client default |
| `POST` | `/api/sessions/:id/voice` | `{armed}` | `{ok:true, armed}`; 404 unknown session, 400 arming one whose `canSpeak` is false |
| `GET` | `/api/sessions/:id/voice/summary[?full=1]` | — | `{summary, turnUuid, waiting}` — on demand ("read that again"); empty when `canSpeak` is false, or when the agent hasn't spoken yet. Reads a Claude transcript or opencode's API depending on the session's kind, so the two can never disagree about which message "the last one" is. `?full=1` adds `{text, truncated}`, the assistant's verbatim last turn capped at 3200 chars ("read the last message in full"). Opt-in because the reconnect catch-up hits this route per armed session and doesn't want kilobytes of transcript |
| `POST` | `/api/tts` | `{text, voice?}` | `audio/wav`, `Cache-Control: no-store`; 400 empty/over 4000 chars, 503 if no engine is available or too busy. `voice` must be an id from `voices()` for the active engine — anything with a path separator (piper) or outside `[a-z]{2}_[a-z]+` (kokoro) is refused |

`GET /api/sessions` gains `voiceArmed` and `canSpeak` per session — `canSpeak` is the single answer to "could this session ever announce?" (`Session.canSpeak()`: a `claude`, or an `opencode` termhub gave an API port to), so the browser never re-derives it from `kind`.

`WS /ws/voice` is a page-wide feed (not per session). Server → client:
`{type:'hello', tts:{available,engine,voice,voices}, wakeWord, sessions:[{id,title,armed}]}` on connect, then
`{type:'waiting', sessionId, title, turnUuid, summary}`, `{type:'busy', sessionId}` and
`{type:'armed', sessionId, armed}`. Client → server: `{type:'ping'}` → `{type:'pong'}`.
Arming goes over REST, not the socket, so it survives a dropped connection.

**When it stays silent.** No speech engine at all, no `claude` CLI, no transcript, a session whose
`canSpeak` is false (a shell, or an opencode with no API port), or a mid-tool-call turn — all of
these degrade to silence, never to an error. A turn whose text flattens to nothing (a reply that is
only a code block) is announced as such rather than as an empty summary, which the browser couldn't
play. The summariser is shared: an opencode turn goes through the same `claude -p --model haiku`
path a Claude turn does, so **`claude` is still the summariser even for an opencode session** — its
absence costs both of them the summary and falls back to the local markdown reduction.

Claude writes no transcript at all when it thinks it's a child of another Claude session, and
warns about that in its own banner. `lib/session.js` strips the inherited `CLAUDE_CODE_*`
identity from every PTY termhub spawns, so this can't be caused by how termhub itself was
started; it only shows up for a `claude` launched some other way.

## Idle tracking (`lib/idleHub.js`)

Measures the one number the layer exists for: **how long an agent session sat waiting on the
human**. Runs in `sessiond`, once a second, over every `claude`/`opencode` session — armed or not,
attached or not, browser open or not. A tracker in the front would stop counting the moment the tab
closed, which is exactly the case worth catching.

```
lib/idleState.js  (pure)      classify one session -> working | waiting | limited
lib/idleHub.js    (sessiond)  episode bookkeeping + escalating push
lib/idleStore.js               <data dir>/idle/YYYY-MM-DD.jsonl, append-only
lib/notify.js                  ntfy POST, best-effort
```

**The signals are the voice layer's, reused rather than re-derived.** `isWaitingForInput()` for a
finished Claude turn, the same 12 s PTY-silence rule for a session parked on a question (the
transcript is empty until you answer — see the voice layer above for the measurement), and
opencode's `session.idle` / `question.asked`, which need no heuristic at all. The one thing added
here is `isLimitNotice()` in `lib/claudeTranscript.js`.

**`limited` exists because a spend limit passes every "the turn finished" test there is.** Claude
Code files its own notices as ordinary `assistant` entries with `model: "<synthetic>"` and
`stop_reason: "stop_sequence"` (`You've hit your org's monthly spend limit · run /usage-credits…`),
so structurally they are indistinguishable from an answer waiting on a reply. Counting them would
charge the user idle minutes for the one pause they cannot fix, so the limit check runs **first**,
gets its own state, and stops the clock. The narrow text test matters: the other common synthetic
entry is `[Request interrupted by user]`, which is a real wait.

**Shells are not tracked.** A shell at its prompt is a tool waiting for you by design; counting it
would make every day look terrible and tell you nothing actionable.

Load-bearing details:

- **Episodes are checkpointed every 5 min.** An open episode lives in memory, so an unexpected
  `sessiond` death would otherwise lose the whole stretch. Continuations carry `cont: true`, and
  `rollup()` excludes them from the **handoff** count — without that, one terminal forgotten for
  half an hour reports six handoffs and flatters the exact number it exists to expose.
- **Episodes are filed by their START day** and `readDay()` also scans the previous day and clips.
  Filing by start keeps the writer a pure append; a writer that split at midnight would need a
  timezone-aware clock it has no other use for.
- **Today's rollup folds in the open in-memory episodes** (`idle.openEpisodes()`). Without that the
  header freezes whenever nothing changes state, which on an idle day is the whole day.
- **Looking at a session suppresses the push, not the clock.** The browser beats
  `POST /api/idle/focus` every 15 s while visible; idle is idle whether or not you're staring at
  it, but a phone that buzzes about the window already on screen trains you to ignore the channel.
- **The notification slot is claimed before the async send**, so a failed post doesn't retry every
  tick and a slow one can't fire twice.
- **The deep link is read off Serve's config**, never constructed — `secureUrlForPort()` against
  `state.json`'s `publishPort`, cached 5 min because it spawns `tailscale`. No address published =
  no `Click` header, and the push still goes.
- **The badge's clock is not in `uiSignature()`.** `idleState` is, `idleMs` isn't:
  `tickIdleBadges()` writes elapsed text in place, because rebuilding the sidebar once a second is
  precisely the churn that signature exists to prevent.
- **An exit push fires only when the PTY itself ends**, and the discriminator is
  `session.lastInputAt` — *your keystrokes*, not PTY output. Typing `/exit` makes the terminal
  chatter exactly like a crash and returns 0 exactly like a clean finish, so neither the output nor
  the exit code can separate "I closed this" from "this died on me". Anything that ended within
  10 s of you typing is treated as yours and stays silent; pressing ✕ (which removes the session
  from the map before it dies) never announces at all.
- **The commoner failure is that the AGENT dies and the shell lives**, and this does not fire for
  it: termhub launches the agent through a shell, so a crashed `claude` drops you back to a prompt
  with the PTY — and the session — still alive. Measured here: killing `claude.exe` left
  `alive: true`; killing the shell produced the exit push. Detecting the first case would mean
  walking the PTY's process tree on every tick (a CIM query per session on Windows) or scraping the
  screen, and neither is worth it, because **the idle push already covers it**: a session whose
  agent is gone stops producing output, is classified `waiting`, and buzzes you at two minutes.
  You then look and see a shell prompt. Don't "fix" this by adding a process walk.
- **`notify.json` is read with the BOM stripped.** PowerShell 5.1's `Out-File -Encoding utf8`
  writes one, `JSON.parse` throws on it, and the failure mode is silent — notifications simply
  never arrive on a machine that looks configured.

**This is a `sessiond`-tier change**: it takes a `restart-sessiond.ps1` (which ends every live
terminal) to activate on a machine already running. The UI half rides the ordinary front swap.

### Several machines (`lib/peers.js`) — read across, never merge

The fleet is symmetric: every machine measures its own PTYs (only it can), keeps its own log, and
answers for itself. The dashboard reads the others and shows them **side by side**. There is no
hub, no central store, and deliberately **no combined number** — which box the idle happened on is
the information, and a blended figure would be the one statistic that hides it.

- **The peer list is explicit, and that is measured.** The obvious design — enumerate the tailnet
  and probe everything — was run against the real tailnet here: 14 peers, 4 running termhub, the
  rest colleagues' laptops and an iPhone. On every dashboard load that is ten 2.5 s timeouts to
  re-learn something that changes once a year. So `scan()` is an explicit action that writes
  `peers.json`, and page load only probes what's in it.
- **Probe https:7000, https:7443 AND http:7000.** The first scan of this fleet found *one* machine
  because it tried https only; two more were answering plain HTTP on 7000 (`start-http.ps1` binds
  the tailnet IP itself and turns Serve off) and surfaced as `ECONNRESET` and `EPROTO` — a TLS
  handshake against a server that speaks none. All three forms are live deployments here.
- **Peer data is proxied by the front, not fetched by the browser.** Same origin (no CORS to
  configure on four machines) and it works from a phone that can reach this box. **Only configured
  peers are reachable through it** — the target URL comes from `peers.json`, never from the
  request. A `?url=` parameter there would turn the front into a general-purpose tailnet fetcher,
  which is a much bigger thing than a dashboard.
- **TLS verification stays on.** `ts.net` certificates are publicly trusted; a peer that fails
  verification is one we should not be reading numbers from.
- **Three peer states, and the middle one needed saying**: offline; online but running a build with
  no idle tracking (*"no idle data — update termhub on that machine"*); online with data. Showing
  the middle case as `0m` would read as "you were never idle there", which is the opposite of true.
- Viewing a peer, the session rows link to *that machine's* termhub rather than offering
  **reopen** — the session belongs to its supervisor, and reopening from here would either do
  nothing or spawn it on the wrong box.

### The dashboard (`web/dashboard.*`, served at `/dashboard`)

A second page, not a panel in the hub: it is a reading surface, and the terminal UI is a working
one. `front.js` maps the extensionless `/dashboard` to `dashboard.html` (`PAGES`), so the URL is
worth typing and worth putting in a notification.

It reads `GET /api/idle/history` (every recorded day, rolled up) and
`GET /api/idle/history?day=…&episodes=1` — the raw episodes are **opt-in** because the calendar
and the tiles only want the rollup, and a busy day is a few hundred rows.

- **Idle share, not idle minutes**, is the headline. `waiting / (waiting + working)`. Ten hours of
  work with forty minutes of waiting is a better day than two hours with thirty, and only the
  ratio says so — a raw-minutes score would reward working less, which is a scoreboard pointing
  the wrong way. The calendar's heat is bucketed on the same ratio for the same reason.
- **The streak skips days with no sessions.** A weekend is not a regression.
- **Episodes store the readable session name**, resolved by `label()` at write time — an untitled
  agent session's `title` is its whole command line including the spliced-in `--session-id
  <uuid>`, which identifies nothing to a human reading back a Tuesday (and blew the width of a
  phone notification before it was fixed there too).
- **"Go back to that session" is `POST /api/idle/reopen`, and deliberately not
  `/api/sessions/:id/restore`.** That route reads `sessions.json`, which drops an entry the moment
  the session is killed or restored on top of — so it can only reach back as far as the current
  archive, days rather than weeks, and a calendar you can't act on is decoration. The idle log
  keeps `cwd`, `command` and `agentSessionId` per episode, so `idleStore.findSession()` can answer
  for any session still in the log (bounded to 120 day-files; the answer is nearly always in the
  day you clicked). The archive still wins when it has the entry — it's richer (shell history) and
  going through it keeps the archive consistent. A session with no recorded conversation id
  reopens in the right directory as a *fresh* conversation, and both the response (`resumed:
  false`) and the button's tooltip say so rather than implying the history came back.
- **Reopening mints a new session id**, so the page hands off to `/#session=<new id>`, not the old
  one.
- **The trend and the calendar are drawn from idle SHARE, never minutes.** A quiet day must not
  render as an improvement; that is the one way a scoreboard like this can teach the wrong lesson.

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
systemctl --user restart termhub         # ENDS every terminal: one process on Linux
journalctl --user -u termhub -f          # live logs

# the watchdog (see "Staying up" above)
systemctl --user list-timers termhub-watchdog.timer
systemctl --user start termhub-watchdog.service    # run one cycle now
journalctl --user -u termhub-watchdog -n 50
bash watchdog/watchdog.sh --probe                 # full diagnosis, changes nothing
bash watchdog/watchdog.sh --test-claude           # is escalation armed?
bash watchdog/install-watchdog.sh --ensure        # repair the timer install

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
`start.ps1` reuses a live `sessiond`/`front` instead of restarting it. On a **plain-HTTP** machine
the task runs `start-http.ps1 -Port <port>` instead, which is equally correct — `Test-TermhubTask`
accepts either, and used to warn about the second one on every start and update while pointing at
"fixes" that would have moved the machine to single-port mode.

**Verify that's what the task actually does** — a machine installed before the two-tier split has a
task that still runs `node server.js`, which squats the publish port and shadows `sessiond` at every
logon (see "The publish port belongs to Tailscale Serve"). `Test-TermhubTask` warns about it on
every start/update; `install.ps1` fixes it.

```powershell
Get-ScheduledTask Termhub | Get-ScheduledTaskInfo
(Get-ScheduledTask Termhub).Actions | Format-List Execute,Arguments  # start.ps1 or start-http.ps1
Start-ScheduledTask Termhub              # = run start.ps1 (boots both tiers, idempotent)
Stop-ScheduledTask  Termhub
.\windows\update.ps1                     # safe blue-green update (run from any terminal)
.\windows\start.ps1                      # bring tiers up / re-publish by hand
.\windows\restart-front.ps1              # reload front.js / web assets; terminals survive
.\windows\restart-sessiond.ps1           # ENDS all terminals; for sessiond-side changes
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

### Measuring it instead of guessing (`test/mobile/`)

Every mobile bug here arrived as prose — "scrolling is weird", "the input bar disappears" — and a
guess costs a round-trip to a real phone to disprove. `test/mobile/probe.js` drives the *real* UI in
a phone-shaped browser and prints geometry, scroll state, renderer and reachability; full docs and
the honest list of what it cannot see are in [test/mobile/README.md](./test/mobile/README.md).
Playwright is deliberately **not** a dependency (termhub ships to phones and Windows boxes);
`TERMHUB_PLAYWRIGHT=<path>` points at one installed anywhere.

It settled two things no amount of reading would have:

- **With the WebGL renderer there is no text in the DOM.** `.xterm-screen` holds two `<canvas>`
  elements and nothing else, `.xterm-viewport` scrolls an empty `.xterm-scroll-area` spacer, and
  `user-select` is `none` on both. So native long-press selection cannot ever work in place, on any
  browser — "I can't copy from the terminal on my phone" is structural, not a CSS oversight.
- **Claude Code looks like a full-screen TUI and is not one.** Measured against a live session, it
  stays on the **normal buffer** and **explicitly disables** mouse tracking (`?1000l ?1002l ?1003l
  ?1006l`); opencode does the opposite (`?1049h`, `?1003h`, `?1006h`). So the wheel-forwarding path
  termhub built for full-screen apps was never active in a Claude session, which is how "scrolling
  is broken in Claude" and "scrolling is fine in vim" were both true.

| | alternate screen | mouse tracking | a drag must |
|---|---|---|---|
| **Claude Code** | no — normal buffer | none | scroll xterm's own scrollback |
| **opencode** | yes (`?1049h`) | `?1003h` + `?1006h` | be forwarded as SGR wheel |
| plain shell | no | none | scroll xterm's own scrollback |

`window.__termhub` at the end of `web/app.js` is the handle it drives the page through — the same
instinct as `?voicedebug=1`, which exists because a phone has no console.

- The on-screen key bar sends real escape sequences: `Esc` (`\x1b`), `Tab` (`\t`), arrows
  (`\x1b[A/B/C/D`), `^C` (`\x03`). The sticky **Ctrl** key arms a modifier applied to the next
  letter you type (e.g. `Ctrl` then `d` → `\x04`).
- Inputs use a 16px font so iOS Safari doesn't zoom on focus.
- The terminal refits on focus, `orientationchange`, and `visualViewport` resize (soft
  keyboard show/hide).
- The voice strip sits directly above the key bar so the undo window's **Cancel** button lands
  under your thumb — the only reason to look at that strip in a hurry is to stop a send.
- Add the tab to your home screen for an app-like, full-screen experience. The icon is an inline
  SVG data URI (`rel=icon` plus `apple-touch-icon`) rather than a file: it costs no extra
  request, can't 404 behind the front's static handler, and needs nothing added to the deploy.
  Without one the browser draws its generic globe.

### The key bar: keys scroll, tools don't

`#keybar-keys` (Esc, Ctrl, Tab, arrows, ^C) scrolls sideways, with a faded right edge so it reads
as a row that continues rather than a row that ends. `#keybar-tools` (**⌨ Copy Paste 🎤 📎**) is
pinned and never scrolls, because each of those is the *only* way to do its job on iOS and a
control you have to go looking for is no fix for the thing it does.

**⌨ used to be the last child of the scrolling group**, i.e. off the right-hand edge of every
phone — the one control whose whole purpose is "give me the keyboard back". That is what "the text
input bar isn't there and I can't scroll to it" was. `probe.js` checks reachability by clipping
against every scrollable ancestor, not just the window, so this specific mistake can't come back
quietly; it currently reports the arrows and `^C` as unreachable, which is true and intended.

The tools are deliberately compact (34px, 12px text): five of them at full key width leaves the
scroller too narrow to show even `Esc`, and the arrows are what you cycle a Claude Code prompt with.

### Copy: a sheet, because there is nothing to select

**With the WebGL renderer the terminal has no text in the DOM at all** — `.xterm-screen` holds two
`<canvas>` elements, `.xterm-viewport` scrolls an empty `.xterm-scroll-area` spacer, and
`user-select` is `none` on both. A long-press has nothing to grab and never will, and xterm's own
selection is driven by *mouse* events a phone doesn't produce. So "I can't copy anything out of the
terminal on my phone" was structural, not a missing gesture.

The **Copy** key renders the buffer into a `<pre>` — real text, `user-select: text`,
`-webkit-touch-callout: default` — and hands the phone back its own native selection, handles and
Copy menu. Works identically on every browser and either renderer. Screen / All-scrollback toggle,
plus **Copy all** and **Copy selection** for when you don't want to drag handles at all. Wrapped
rows are re-joined into one logical line (`line.isWrapped`), because a copied line carrying the
terminal's wrap points pastes as ragged nonsense anywhere else. It opens scrolled to the newest
output — and note the ordering in `openCopySheet()`: unhide *before* filling, since a `display:none`
element has `scrollHeight` 0 and the scroll-to-newest silently does nothing.

### Paste is not typing

`pasteInto()` does two things `sendInput()` did not, and both are required:

- **Newlines become `\r`.** A terminal's Enter is CR; the `\n` off the clipboard reaches some
  programs as nothing at all.
- **Bracketed paste when the app asked for it** (mode 2004 — Claude Code and opencode both enable
  it). Without the `ESC [200~ … ESC [201~` wrapper every newline in a pasted block reads as a
  *separate Enter*, so pasting a five-line stack trace into Claude Code submitted five prompts, the
  first of them one line long. That is the whole of "I can't paste into the chat from my phone": it
  pasted, and then immediately sent, in pieces.

We need our own copy of what xterm does for a native paste because the Paste key bypasses xterm
entirely — Safari won't surface its long-press Paste menu over xterm's hidden textarea, which is why
the key exists at all.

### Scrolling: one gesture, three meanings

See the table under *Measuring it instead of guessing* above. `scrollMode()` re-reads the regime per
gesture (never cached — a session changes regime the moment you open or quit an editor) and the
touch handler owns the drag in **all three**, including the normal buffer where xterm's own touch
scrolling used to be left alone.

That last part is the fix for "only the bottom half scrolls, the top half stays static". xterm
scrolls by letting the browser scroll `.xterm-viewport` (an empty spacer) and repainting the canvas
from a `scroll` handler. On iOS the spacer is scrolled by the **compositor** while the canvas
repaints on the **main thread**, so during a flick the two run apart and you get a screen that is
part new and part stale. Driving `term.scrollLines()` straight from the `touchmove` puts the scroll
position and the repaint in the same frame, where they cannot disagree. `touch-action: none` on
`.term-pane` is what stops the browser also scrolling underneath us; pinch-zoom is already off via
the viewport meta, so nothing else is lost.

**↓ Latest** appears whenever `viewportY < baseY` on the normal buffer. "I can't get to the very
bottom of the session" is its own bug, and on a phone the answer cannot be "flick repeatedly and
hope".

A tap on the terminal now calls `focusTerminal()` explicitly. It has to: we `stopPropagation()` the
touchstart and `preventDefault()` any move, which between them stop iOS ever synthesising the click
that would have focused xterm's hidden textarea — so the keyboard came up on the browser's own tap
handling and was taken away again the moment our handlers ran, which is exactly the reported "it
appears for a second and then disappears". It focuses on the next frame (so our own relayout can't
undo it) and pins the view to the bottom, so what you're about to type into is on screen.

## Attachments (📎, paste, drag-drop)

All three routes end in the same place: `sendAttachment()` in `web/app.js`, which uploads with
`XMLHttpRequest` (the only browser API that reports upload progress — a phone pushing a photo
over cellular needs to see *something*) and reports through a DOM toast rather than by writing
into the terminal, which a full-screen TUI would repaint over within a frame.

**Images** go to `POST /api/sessions/:id/clipboard-image`, and `sessiond` decides what actually
happens to them:

- Host has a clipboard **and the image is provably on it** → reply `{kind:'clipboard'}`, and the
  client fires the agent's clipboard-image hotkey (`Alt+V` on native Windows Claude Code,
  `Ctrl+V` otherwise).
- Anything else → saved under `<data dir>/attachments/`, reply `{kind:'file', path}`, and the
  client types the path in. Both agents read an image given a path, so this route always works;
  it is the honest answer, not a degraded one.

**"Provably" is the whole of it.** This path worked on the machine the browser was sitting at and
failed on every other one, for a reason that hid it completely: locally the user had *just copied
the image to that machine's clipboard themselves* in order to paste it into the browser, so the
agent found an image whether or not termhub staged one. Only on a remote host is the staging the
sole source of the image — and there, four separate ways of exiting 0 with nothing usable on the
clipboard were live at once:

| What exited 0 | What the agent saw |
| --- | --- |
| `xsel` (was the third-choice Linux tool) — it cannot type a selection at all | `xclip -t image/png -o` reads back nothing. Removed; a display with only `xsel` now counts as *no clipboard* |
| a JPEG staged as `image/jpeg` on Linux, or coerced `«class PNGf»` on macOS | the agent asks for `image/png` **by name**, with no fallback, and saves the zero bytes it gets. `clipboardTarget(mime)` now refuses any non-PNG off Windows (Windows decodes the file itself, so it keeps taking anything) |
| `Clipboard::SetImage` from PowerShell — measured here, **1 write in 6** left the clipboard empty | `ContainsImage()` false → *"No image found in clipboard"*. Now `SetDataObject($img, $true, 10, 100)` (OLE retry loop + a flush that outlives the process), in a loop that confirms `ContainsImage()` before exiting |
| `pwsh` staging where Claude Code reads with `powershell` | a different clipboard client; not dependably visible. `lib/clipboard.js` prefers Windows PowerShell 5.1 — the reverse of `lib/shell.js`, on purpose, because matching the reader is the point |

So `stageClipboardImage()` writes, then **reads the clipboard back with the agent's own
predicate** (`ContainsImage()` on Windows, the `TARGETS` list on Linux, `clipboard info` on
macOS), and retries the pair up to three times. Even after the Windows fix ~1 staging in 30 still
read back empty from another process — the clipboard is a contended global and anything watching
it (clipboard history, a clipboard manager, an RDP clipboard channel) can take it between our
write and the agent's read. One-in-thirty is invisible in testing and infuriating in use.

`clipboardTarget()` still refuses up front where it can: Linux needs `DISPLAY`/`WAYLAND_DISPLAY`
*and* `wl-copy`/`xclip`. Checking for the tool alone is not enough — a headless Linux box very
often has `xclip` installed, where it can only ever exit 1 with *Can't open display*.

`POST /api/clipboard-probe` is the same round trip on a 1x1 PNG, deliberately **unretried**, so a
box that is merely flaky is distinguishable from one that can never work:

```bash
curl -sk -X POST https://<host>:7000/api/clipboard-probe
# {"platform":"win32","target":{"available":true,"tool":"powershell"},
#  "staged":true,"verified":true,"error":null}
```

`staged:false` is a missing tool, a missing display, or a write that threw. `staged:true` with
`verified:false` is the dangerous one this whole design exists to catch: a clipboard the agent
cannot see.

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
| The whole UI is gone, terminals were fine an hour ago | The `front` died and nothing restarted it — the `Termhub` task runs at logon only | What `watchdog/` exists to fix; install it (`.\watchdog\install-watchdog.ps1`). By hand: `.\watchdog\watchdog.ps1 -Probe` to see the signature, then `.\windows\start-http.ps1` (plain-HTTP) or `.\windows\restart-front.ps1`. `sessiond` keeps the PTYs the whole time, so nothing is lost |
| A tier died and there is no reason recorded anywhere | Its output went nowhere | Fixed: both tiers write `%LOCALAPPDATA%\termhub\logs\<tier>.{out,err}.log`, with the previous generation in `.prev.log` — the crash you're chasing is usually in `.prev`. Nothing from before 2026-07-31 was captured |
| Bound to `127.0.0.1`, unreachable from other devices | No Tailscale IP detected | `tailscale status` — a **running** `tailscaled` is not the same as a logged-in node, and it keeps its old tailnet sockets open after a logout, so "Logged out." is easy to miss. Fix the login first, then set `TERMHUB_BIND` to the tailnet IP (or re-run `.\windows\start-http.ps1`, which does it) |
| The watchdog reports `tailnet-ip-unavailable` but termhub works on `http://127.0.0.1:7000` | Plain-HTTP mode has no address to bind the front to — and that check runs *before* anything is probed | Not necessarily an outage at all: it means `tailscale ip -4` answered nothing. `tailscale status` names the cause. **Logged out** needs a human (`tailscale login`) and nothing else will clear it; `Stopped` is fixed by `tailscale up`; a **PATH** without `C:\Program Files\Tailscale` invents the whole thing, because the watchdog's task PATH is not the interactive one. `remedies\tailnet-ip-unavailable.ps1` handles all but the first, and keeps a loopback front up meanwhile |
| Can't reach `:7000` from phone (loads forever) | Windows firewall drops raw ports on the Tailscale interface | Use Tailscale Serve (Windows installer does this): bind loopback + `tailscale serve --bg --https=7000 http://127.0.0.1:7000`, then open `https://<host>.<tailnet>.ts.net:7000/` |
| Can't reach `:7000` from phone | Tailnet ACL or firewall | Confirm both devices are on the tailnet and ACLs allow the port |
| Terminal opens but no output | WebSocket blocked | Ensure nothing between browser and server strips WebSocket upgrades |
| Input ignored after sleep/wake | WebSocket dropped; reconnecting | Output replays on reconnect (incl. across a front update). "Session no longer available" means `sessiond` itself restarted (reboot, or a deliberate sessiond restart) — restore it from the sidebar's **Restorable** section, or open a new terminal |
| Sidebar empty after a reboot | `sessiond` (and its PTYs) died with the machine | Sessions created while the persistence build was running reappear under **Restorable (after restart)** — restore re-opens Claude with `--resume` or a shell with its command history. Sessions from before the build was deployed weren't recorded |
| Restoring a Claude session opens a bare shell, no conversation | The restore command carried two conversation-identity flags — Claude printed a usage error and exited | Fixed in `lib/restore.js` (strips `--session-id`/`--continue`/`--fork-session` before adding `--resume`); the fix also repairs entries already mangled in `sessions.json`. Scroll the restored terminal up to see the actual CLI error. Machines on an older CLI never hit this, which is why it looked platform-specific |
| Restore works on one machine, not another | The two machines run different Claude CLI versions | Open ⟳ **Update** — the panel reports the installed CLI against termhub's pin (`termhub.claudeCli` in `package.json`) and offers **Update Claude**. Verify from a terminal with `claude --version` |
| Wrong size / wrapping | Pane resized while backgrounded | Switch sessions or rotate to force a refit |
| Pasted image lands as a file path instead of in the agent's prompt | The host has no usable clipboard, or the staging didn't read back | `curl -X POST /api/clipboard-probe` says which. Expected on a headless Linux box, and for a JPEG anywhere but Windows. The path works — both Claude Code and opencode read an image given one. To get the clipboard route instead, run a session with a real display and paste a PNG |
| Attaching an image to a session on a **remote** machine does nothing: Claude Code says *"No image found in clipboard"* (Windows) or nothing at all (Linux), while termhub's toast said `image pasted` | termhub trusted a clipboard write that exited 0 without the image landing — see *Attachments*. It could only ever be seen on a remote host, because locally the user's own clipboard already held the image | Fixed: staging is read back before the paste hotkey is fired, and falls back to a file path when it isn't there. **The fix is in `sessiond`, which `update.ps1` deliberately never restarts** — after updating, restart sessiond (the update prints a sessiond-drift warning when this matters), then confirm with `curl -X POST /api/clipboard-probe` |
| 📎 upload does nothing on a phone | File over the cap (100 MB, or 15 MB for an image on a host with a real clipboard — `curl /api/info` shows the effective `limits`) | The red notice above the key bar says so; tap it to dismiss, shrink the file. A silent failure instead means the connection dropped — the notice says that too |
| Pasted an image and got text instead | The paste carried `text/plain` too (rich text with an inline image), and text wins | Deliberate — taking the image would swallow the text. Use 📎 for the image |
| Model badge blank, and 🔊 never speaks, on one tab | The pinned `--session-id` transcript is a stub the conversation forked away from | Both symptoms share a cause: `resolveTranscript()` had settled on a file Claude Code stopped writing. Compare `curl localhost:7010/api/sessions` (the session's `command` names the pinned uuid) against `ls -t ~/.claude/projects/<encoded cwd>/` — a *different* uuid holding the recent bytes confirms it. Now self-corrects once the newer transcript exists |
| Model badge reads `<synthetic>` | Last assistant entry is a Claude Code notice, not a turn | A spend-limit or interrupt notice is written as an assistant entry with model `<synthetic>`. `grep -c '"model":"<synthetic>"' <transcript>` — and read the notice text, since a spend limit also means that session is not running |
| 🔊 armed but never speaks | Nothing to read turns out of | Only a session whose `canSpeak` is true can be armed (the endpoint 400s otherwise) — a `claude`, or an `opencode` termhub launched with its `--port`. If Claude's banner says transcript saving is off, it was launched as a child of another Claude session — termhub's own PTYs are scrubbed of that, so it came from elsewhere |
| 🔊 is greyed out on an opencode session | It has no API port | Only sessions termhub launched with `--port` can announce, and one opened by an older build has none. Close and reopen it; `curl localhost:7010/api/sessions` shows the `command` it actually ran. The tooltip says this too |
| An opencode model badge lags ~10s behind a model switch | The API attach failed and it fell back to the subprocess path | Expected only for a portless session. Otherwise the badge is driven by the event stream and is immediate — a lagging badge means `lib/opencodeApi.js` couldn't reach the TUI, which also means no 🔊. Check the port in the session's `command` answers `/global/health` |
| Told "asking you something" but nothing is | PTY-idle heuristic misfired | A claude terminal silent for 12 s with no finished turn recorded is assumed to be on a prompt. A session wedged some other way looks the same; the announcement is generic by design because the question is never written to the transcript |
| 🔊 reports speech unavailable | Neither engine usable | `curl localhost:7010/api/voice/status` — `tts.engine` names the winner. kokoro needs `TERMHUB_KOKORO_PYTHON` to import `kokoro_onnx` + `soundfile` and the two model files under `TERMHUB_KOKORO_DIR`; piper needs the binary on `PATH` and `<voice>.onnx` + `.onnx.json` in `TERMHUB_TTS_VOICE_DIR` (files under 4 KB are treated as broken stubs and skipped) |
| Announcements sound robotic | Fell back to piper | `tts.engine` says `piper`. A kokoro worker that fails at import demotes the engine for 5 minutes; run `TERMHUB_KOKORO_PYTHON -c 'import kokoro_onnx'` by hand to see why |
| A voice command did nothing | Wake word missed, or wasn't at the start | Commands fire on finals only and only utterance-initial. A parsed-but-unknown command says "didn't catch that" and is dropped. `npm test` covers the matcher; add real mishearings to `KNOWN_VARIANTS` in `web/voiceCommands.js` |
| A dictated sentence vanished | A false wake-word fire would do this | It shouldn't — `npm test` asserts against a near-miss list. If you find one, add it to `NEAR_MISSES` and tighten the variants; do not add fuzzy matching |
| Armed, but the strip stays amber and nothing plays | Browsers won't play audio before a user gesture | Tap **Enable voice**. Once per page load; the toggles turn from amber to blue |
| 🎤 does nothing but open a text box | No `SpeechRecognition`, or an insecure origin | Speech recognition needs a secure context — use the machine's MagicDNS HTTPS address, not `http://<tailnet-ip>:7000`. The strip names it, read from Serve (`curl -s http://<host>:7000/api/secure-url`); if that says `null`, Serve isn't publishing this front. Desktop Firefox has no Web Speech at all; the text box is the fallback |
| 🎤 names an HTTPS address that won't connect | Pre-fix client, or a cert/name mismatch | Old builds fabricated `https://<location.hostname>:7443/`, which can't work from the tailnet IP — Serve's cert covers only the MagicDNS name. Update the front. If a *current* build's address fails, the phone can't resolve MagicDNS: enable it in the Tailscale app |
| Can't select or copy anything out of the terminal on a phone | There is no text in the DOM to select | Structural, not a missing gesture: the WebGL renderer draws into a `<canvas>` and `user-select` is `none`. Use the **Copy** key in the pinned tool group — it renders the buffer as real selectable text (Screen / All scrollback, plus Copy all) |
| Pasting several lines into Claude Code sent several prompts | Raw newlines, no bracketed paste | Fixed in `pasteInto()`: newlines become `\r` and the block is wrapped in `ESC [200~ … ESC [201~` when the app enables mode 2004. Without the wrapper each newline is a separate Enter |
| Scrolling a Claude session on a phone tears — part of the screen updates, part doesn't | iOS scrolls xterm's spacer on the compositor while the canvas repaints on the main thread | Fixed: the touch handler drives `term.scrollLines()` itself so scroll and repaint share a frame, and `touch-action: none` stops the browser scrolling underneath. Claude Code is on the **normal** buffer with mouse tracking **off**, which is why the full-screen-app wheel path never applied to it |
| Can't get to the very bottom of a session | No gesture reliably lands there | Tap **↓ Latest** (appears whenever there's newer output below the fold) |
| The keyboard flashes up and vanishes when tapping the terminal | The tap never reached xterm's hidden textarea | Fixed: the touch handler calls `focusTerminal()` explicitly on a tap. It had been suppressing the synthetic click that would have focused it, so the keyboard came up on the browser's own handling and went away again as soon as our handlers ran |
| Paste does nothing on iPhone | Insecure origin, or the per-read prompt was declined | `navigator.clipboard.readText` needs HTTPS, and iOS asks to confirm every read. Both fall back to a manual paste box — if that box never appears, the Paste key wasn't the thing tapped; it's pinned to the right of the key bar next to 🎤 and 📎, outside the scrolling group |
| Mic keeps closing on its own | Working as intended | It closes after 45 s of silence rather than listening to an empty room, and while an announcement is playing (opening it then would flip a Bluetooth headset's audio route mid-sentence). Tap 🎤 to reopen |
| Voice reply went to the wrong session | 🎤 targets whatever terminal is in front of you | An announcement's reply goes to the session that announced; a 🎤 tap goes to the active terminal |
| Announcements sound like a rewrite, not the answer | Turn was long enough to go through `claude -p --model haiku` | Expected; turns under ~240 chars are spoken verbatim. `claude -p` failing just falls back to a local trim |
| The watchdog keeps escalating for the same failure | The remedy it wrote doesn't actually fix that failure | The prompt tells it to *improve the existing remedy in place* on a repeat, so check `git log watchdog/remedies/`. `escalations.json` shows the outcome per attempt; the budget (≤3/h) stops the bleeding either way |
| The watchdog logged nothing at all | Not registered, killed by the switch, or the task never ran | `Get-ScheduledTaskInfo TermhubWatchdog` (`LastRunTime`/`LastTaskResult`); check for `%LOCALAPPDATA%\termhub\watchdog\DISABLED`. Registration can fail *while reporting success* on older copies of the installer — see the `WORKGROUP` trap above |
| (Linux) clicked ⟳ Update and the terminal died mid-output | Expected: one process, so the restart ends every PTY including the updater's | The restart is handed to a detached phase that logs to `~/.local/termhub/logs/update.log` — read that for the result, including a rollback if the new build never became healthy |
| (Linux) `update.log` stops at the "restart phase" header and says nothing more | The verify phase was killed by the restart it triggered | Fixed: the phase now runs under `systemd-run --user --unit=termhub-update-… --collect`, out of termhub's cgroup. On a build before that fix it was launched with `setsid`, which does not leave the cgroup, so `KillMode=control-group` took it down — the update still applied, but with no health check and **no rollback**. `systemctl --user list-units 'termhub-update-*'` shows the phase while it runs |
| (Linux) the watchdog reports `not-listening` but termhub works fine | An address-guessing bug this used to have | Fixed: the probe tries `TERMHUB_BIND`, loopback, the tailnet IP and whatever `ss` shows. A default install binds the **tailnet IP**, so a loopback-only check invents an outage. `bash watchdog/watchdog.sh --probe` prints every candidate and its result |
| (Linux) watchdog timer vanished after logout | `--user` units stop with the session unless lingering is on | `sudo loginctl enable-linger $USER`. termhub itself has the same problem, which is why the installer warns |
| (Linux) `start request repeated too quickly` | systemd hit `StartLimitBurst` and gave up on the unit | What `service-inactive.sh` exists for: `systemctl --user reset-failed termhub` first, *then* start. A bare `start` on a rate-limited unit fails instantly and looks like the remedy did nothing |
| The watchdog fixed it but never wrote a remedy | The escalation ran out of context, or ignored step 2 | The log says so explicitly (`service is back but NO remedy was written`). Write it by hand from `escalation-<stamp>.out.txt`; that transcript records what actually repaired it |
| `npm install` errors on `node-pty` | Missing build toolchain | See prerequisites above |

## Security notes

- There is **no authentication** — anyone who can reach the port on your tailnet can open
  terminals on that machine. Keep your tailnet ACLs tight.
- termhub binds only the Tailscale interface by default. Do **not** set `TERMHUB_BIND=0.0.0.0`
  on a machine with a public interface unless you add your own access control in front.
