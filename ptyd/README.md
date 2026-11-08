# ptyd

termhub's terminal host in Rust (native rebuild plan item 5.1, `docs/native/PLAN.md`). It owns
PTYs (ConPTY on Windows, a Unix PTY on Linux, through `portable-pty`) and speaks the session half
of termhub sessiond's protocol on loopback, so anything that talks to sessiond about terminals can
talk to ptyd instead.

**Status: landing, opt-in.** Nothing runs it by default. termhub uses it only with
`TERMHUB_PTYD=1` (see *Using it from termhub*); switching termhub over and retiring node-pty is the
rest of plan 5.1 / Exit 5.

## Build and run

```powershell
# once: rustup (https://rustup.rs) and, on Windows, the MSVC build tools
cd ptyd
cargo build --release          # target/release/ptyd(.exe)
cargo test                     # unit tests (pure parts: env spec, links, guard, utf-8)
./target/release/ptyd --port 7020
```

`--port N` (default `$TERMHUB_PTYD_PORT`, else 7020; `0` picks a free one). It binds `127.0.0.1`
only and prints `[ptyd] <machine> listening on http://127.0.0.1:<port> (pid N)`; a port already
in use is a refusal with exit 3, like sessiond.

## Protocol

The same as sessiond (`termhub/AGENT.md`, *HTTP API*), for these routes:

| route | notes |
|---|---|
| `GET /api/ping` | `entry: "ptyd"`, `pid`, `port`, `machine`, `commit` (build-time), `startedAt`, `version` |
| `GET /api/info` | `platform`, `home`, `features` (`session-env`, `session-norc`, `session-links`, `ptyd`) |
| `GET /api/sessions` | `{machine, sessions, restorable: []}`; ptyd keeps no archive |
| `POST /api/sessions` | `{cwd, command, title, cols, rows, env, unsetEnv, noRc, links}` -> 201 info (+`envApplied`, `rcSkipped`) |
| `PATCH /api/sessions/:id` | `{title, links, paused}` |
| `DELETE /api/sessions/:id` | kills the whole process tree, answers when it is gone; idempotent |
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
cd ptyd; cargo build --release
$env:TERMHUB_PTYD = '1'        # then (re)start sessiond as usual
```

sessiond (`termhub/lib/ptydClient.js`) then creates every PTY in the ptyd on
`TERMHUB_PTYD_PORT` (7020), starting one detached (`TERMHUB_PTYD_BIN`, default
`ptyd/target/release/ptyd`, then `debug`) if none answers; its output goes to
`<dataDir>/logs/ptyd.out.log`. On start, sessiond adopts the sessions ptyd still has.
`/api/ping` on sessiond reports `ptyHost: "ptyd"` or `"node-pty"`.

## Cutover (Exit 5): switching a stack, and rolling back

Production starts (`node sessiond.js` on Windows, `node server.js` in the Linux unit) pick the
PTY host from a persistent setting, `ptyHost` in `<dataDir>/settings.json`
(`termhub/lib/ptyHost.js`). An explicit `TERMHUB_PTYD=1|0` wins: from the environment, else
`termhub/.env` or the repo's `.env` (the one-line switch the update scripts read). A value a
running sessiond exported into its terminals is not a choice and is skipped, so a script run
from a termhub terminal still reads the file.

| `ptyHost` | next sessiond start uses |
|---|---|
| `node-pty` (default) | node-pty, always: today's behaviour, and the rollback |
| `ptyd` | ptyd, always: the cutover |
| `auto` (opt-in) | ptyd **if a release binary is on the machine** (`TERMHUB_PTYD_BIN`, `dist/<os>-<arch>/`, `ptyd/target/release/`), else node-pty |

The cutover is always an explicit `ptyd` setting. `auto` is deliberately not the default: with
it, merely building a release ptyd in a deployed checkout (a deploy, a test run) would switch
the host on the next sessiond restart and end every live terminal. `node lib/ptyHost.js` (in
`termhub/`) prints the setting, what the next start resolves to, and what the running sessiond
uses (`ptyHost` in its `/api/ping`); `update.ps1` and `restart-sessiond.ps1` print the same.

**Switch a stack:** the runbook is in [JARVISD.md](../docs/native/JARVISD.md) (*Runbook:
switching a stack's termhub to jarvisd front and ptyd*): `TERMHUB_PTYD=1` in `termhub/.env`, the
normal update script, then one sessiond restart (the last one that ends terminals). ptyd runs
as its own long-lived process: the `termhub-ptyd` logon task on Windows (`windows/ptyd.ps1`),
`termhub-ptyd.service` on Linux (`linux/ptyd-unit.sh`). Both update scripts keep it in place
(`-Ensure`/`--ensure`: build when the sources are newer, install, register, start if down) and
never restart a running one.

**Updating ptyd itself:** the running ptyd uses an installed copy,
`<dataDir>/bin/ptyd-<hash>` (named by `<dataDir>/bin/ptyd-current`; `node lib/ptyHost.js
install`), so a build never writes over it (Windows locks a running binary, Linux refuses with
ETXTBSY). A new build is installed beside it and used from ptyd's next start:
`.\windows\ptyd.ps1 -Restart` or `bash linux/ptyd-unit.sh --restart`, which end its terminals,
so only on purpose.
