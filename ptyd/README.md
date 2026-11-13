# ptyd

termhub's terminal host in Rust (native rebuild plan item 5.1, `docs/native/PLAN.md`). It owns
PTYs (ConPTY on Windows, a Unix PTY on Linux, through `portable-pty`) and speaks the session half
of termhub sessiond's protocol on loopback, so anything that talks to sessiond about terminals can
talk to ptyd instead.

**Status: the only PTY host.** sessiond keeps every terminal here. Unset and
`TERMHUB_PTYD=1` both select it; `TERMHUB_PTYD=0` is an error (node-pty was retired,
Exit 5). The lead still deploys that commit on both stacks before Exit 5 is ticked.

## Build and run

```powershell
# once: rustup (https://rustup.rs) and, on Windows, the MSVC build tools
cd ptyd
cargo build --release          # target/release/ptyd(.exe)
cargo test                     # unit tests (pure parts: env spec, links, guard, utf-8, CPU cap, job nesting)
./target/release/ptyd --port 7020
```

`--port N` (default `$TERMHUB_PTYD_PORT`, else 7020; `0` picks a free one). It binds `127.0.0.1`
only and prints `[ptyd] <machine> listening on http://127.0.0.1:<port> (pid N)`; a port already
in use is a refusal with exit 3, like sessiond.

`--cpu-cap PCT|off` (Windows; default `$PTYD_CPU_CAP_PCT`, else 75): see *CPU cap* below.

## Protocol

The same as sessiond (`termhub/AGENT.md`, *HTTP API*), for these routes:

| route | notes |
|---|---|
| `GET /api/ping` | `entry: "ptyd"`, `pid`, `port`, `machine`, `commit` (build-time), `startedAt`, `version` |
| `GET /api/info` | `platform`, `home`, `features` (`session-env`, `session-norc`, `session-links`, `ptyd`) |
| `GET /api/sessions` | `{machine, sessions, restorable: []}`; ptyd keeps no archive |
| `POST /api/sessions` | `{cwd, command, title, cols, rows, env, unsetEnv, noRc, links}` -> 201 info (+`envApplied`, `rcSkipped`) |
| `PATCH /api/sessions/:id` | `{title, links, paused}` |
| `DELETE /api/sessions/:id` | kills the whole process tree, answers when it is gone (*Closing a terminal*); idempotent |
| `POST /api/sessions/:id/input` | `{data, submit?}` -> `{ok, bytes}` |
| `WS /ws/term/:id` | up: `input`, `resize` (a size claim); down: `replay` first, then `output`, `size`, `exit` |

The request guard is sessiond's: `X-Termhub: 1` and no form-style Content-Type on anything that
changes state, `Host` must name this machine, a present `Origin` must be this host (WebSockets
included).

Extensions sessiond does not have (additive, so a sessiond client never sees a difference):
`id` and `shell` on create (sessiond in ptyd mode keeps one id on both tiers and picks the shell),
`POST /api/sessions/:id/notice {text}` (print into the terminal and its replay, not into the
shell), and `pid`, `lastActivity`, `lastInputAt`, `noRc` in each session's info (what a restarted
sessiond needs to adopt a terminal).

Differences, on purpose: `replay` is the raw byte stream (`screen: "raw"`, up to
`TERMHUB_SCROLLBACK_BYTES`, 2 MB) rather than sessiond's headless-xterm screen. In ptyd mode
sessiond keeps its own screen mirror on top, so the browser still gets a clean screen. ptyd does
no agent work (no `--session-id` splicing, model badge, voice or idle episodes): that stays in
sessiond. On Windows ptyd answers ConPTY's opening cursor-position query itself, because
`portable-pty` opens the pseudoconsole with `PSEUDOCONSOLE_INHERIT_CURSOR` and it draws nothing
until someone answers, and a session nobody is watching yet would otherwise sit blank.

## Closing a terminal

On Windows every shell goes into its own Job Object right after spawn (`src/job.rs`), and its
descendants inherit it (node's own nested job included). `DELETE` calls `TerminateJobObject`,
waits until the job counts no live process (bounded at 3 s, typically a few ms), marks the
session ended and closes the pseudoconsole, then answers: about 10-20 ms, where the old
`taskkill /T /F` process plus a 300 ms reader wait took 700-800 ms. "When it is gone" means
the kernel reports every process in the job exited, not merely signalled. The job also has
`KILL_ON_JOB_CLOSE`: a tree never outlives ptyd (a `-Restart` ends it too), and deleting a
session whose shell already exited ends what that shell left running once ptyd drops the
session. That includes GUI programs started from the terminal
(`code .`, `Start-Process`), which a parent-pid walk used to miss once their launcher exited.
Not covered: a process started in the instant between `CreateProcessW` and the assignment, and
one created with `CREATE_BREAKAWAY_FROM_JOB` (the job allows breakaway, so such a call leaves
rather than fails). If assignment fails (ptyd runs in a job that forbids nesting), ptyd logs it
and that session falls back to `taskkill /T /F`, bounded at 3 s, and waits for the exit.

## CPU cap (Windows)

An agent running `dotnet build` starts one MSBuild node per logical CPU and, uncapped, freezes the
desktop. At start ptyd creates one **agents job** (`init_agents` in `src/job.rs`; ptyd itself is
not in it) with a hard CPU-rate cap (`JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`, enable and hard-cap flags)
of N percent of the whole machine, default 75, and `JOB_OBJECT_LIMIT_PRIORITY_CLASS` =
BelowNormal. Set it with `PTYD_CPU_CAP_PCT` or `--cpu-cap` (the flag wins): `0` or `off` disables
the cap (the priority class stays), anything else is clamped to 5..100, an unreadable value logs
and uses 75. Every session's own job is nested inside it: right after spawn the shell joins the
agents job, then its session job (Windows 8+ nesting; the order matters, a process can only move
down the hierarchy), so the cap is shared by all terminals together, not per terminal, and
`TerminateJobObject` on a session job still ends only that terminal. The session job also carries
the BelowNormal class, so a terminal stays BelowNormal even if the agents job is missing. If the
agents job cannot be created or joined (old Windows, access denied) ptyd logs once and carries on
uncapped; session creation never fails over it. `GET /api/ping` reports `cpuCapPct` (null when
uncapped or not Windows). The `termhub-ptyd` task runs ptyd at Normal priority
(`windows/ptyd.ps1` sets task priority 5; the scheduler default 7 is BelowNormal, which every
terminal would inherit); only the terminals' trees are held down. A process created with
`CREATE_BREAKAWAY_FROM_JOB` leaves both jobs and so the cap. Changing the cap needs a ptyd
restart; an already-registered task keeps priority 7 until `ptyd.ps1` re-registers it.

On Unix it is unchanged: `SIGHUP` to the shell's process group, then wait for the exit.

## Conformance

`termhub/test/ptydConformance.test.js` is one black-box suite (HTTP + WebSocket only) run against
three targets: sessiond, ptyd, and sessiond on ptyd (`TERMHUB_PTYD=1`). Passing on all three is
what makes the cutover provable. Without a built binary the ptyd legs SKIP; `PTYD_REQUIRED=1`
(CI's ptyd job) makes that a failure. `CONFORMANCE_TARGETS=ptyd` runs one leg,
`CONFORMANCE_TRACE=1` prints how long each wait took.

`termhub/test/ptydBackend.test.js` proves the point of it: in ptyd mode, sessiond is killed while
a session prints, a new one starts and adopts the session (same id, archive metadata), and no
output is lost.

## Using it from termhub

```powershell
node scripts/build.js --only ptyd   # from the repo root; cargo build --release also works
# then (re)start sessiond. Unset already means ptyd.
```

sessiond (`termhub/lib/ptydClient.js`) creates every PTY in the ptyd on
`TERMHUB_PTYD_PORT` (7020). Production sets `TERMHUB_PTYD=1` (`lib/ptyHost.js`). If nothing
answers, sessiond starts one (`TERMHUB_PTYD_BIN`, else the installed copy, `dist/<os>-<arch>/`,
then `ptyd/target/{release,local,debug}`) and exits if it never answers. Its output goes to
`<dataDir>/logs/ptyd.out.log`. On start, sessiond adopts the sessions ptyd still has.
`/api/ping` on sessiond reports `ptyHost: "ptyd"`.

## Exit 5: the only host, and rolling back

Production starts (`node sessiond.js` on Windows, `node server.js` in the Linux unit) use ptyd.
The setting `ptyHost` in `<dataDir>/settings.json` (`termhub/lib/ptyHost.js`) is `ptyd` when
unset. An explicit `TERMHUB_PTYD=1` is the same choice, from the environment else `termhub/.env`
or the repo's `.env`. A value a running sessiond exported into its terminals is not a choice and
is skipped, so a script run from a termhub terminal still reads the file. `TERMHUB_PTYD=0` and
`ptyHost=node-pty` error. A stored `auto` means ptyd; it no longer falls back.

`node lib/ptyHost.js` (in `termhub/`) prints the setting, what the next start resolves to, and
what the running sessiond uses (`ptyHost` in its `/api/ping`). The runbook is in
[JARVISD.md](../docs/native/JARVISD.md) (*Runbook: jarvisd front, and ptyd*). ptyd runs as its
own long-lived process: the `termhub-ptyd` logon task on Windows (`windows/ptyd.ps1`),
`termhub-ptyd.service` on Linux (`linux/ptyd-unit.sh`). Both update scripts keep it in place
(`-Ensure`/`--ensure`: build when the sources are newer, install, register, start if down) and
never restart a running one.

Rollback is the previous commit (the one that still has node-pty). `TERMHUB_PTYD=0` is not a
rollback on this commit: sessiond refuses to start.

**Updating ptyd itself:** the running ptyd uses an installed copy,
`<dataDir>/bin/ptyd-<hash>` (named by `<dataDir>/bin/ptyd-current`; `node lib/ptyHost.js
install`), so a build never writes over it (Windows locks a running binary, Linux refuses with
ETXTBSY). A new build is installed beside it and used from ptyd's next start:
`.\windows\ptyd.ps1 -Restart` or `bash linux/ptyd-unit.sh --restart`, which end its terminals
(on Windows with everything started from them, see *Closing a terminal*), so only on purpose.
