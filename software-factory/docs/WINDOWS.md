# The factory on native Windows

The factory runs on Windows without WSL (plan item 2.3, decision D13). Linux is
unchanged: systemd timers, bash round scripts, `flock`.

## Install

```powershell
cd <dev-tools checkout>\software-factory
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-serve.ps1 -Start
```

The script is idempotent. It runs `uv sync --all-extras` and registers one logon
task, `factory-serve`, as the current user, that runs:

```
<checkout>\software-factory\.venv\Scripts\python.exe -m factory serve --interval 300 --log-file state\logs\serve.log
```

Options: `-Apps a,b` (default: every registered app), `-IntervalSeconds`,
`-SkipSync`, `-Uninstall`. Updating is `git pull --ff-only` (the next tick runs
the new chain code; restart the task after a change to `factory serve` itself:
`Stop-ScheduledTask factory-serve; Start-ScheduledTask factory-serve`).

Check it: `uv run factory serve --status` (lease holder, apps, running ticks),
`state\logs\serve.log`, and one log per app in `state\logs\serve\tick-<app>.log`.

## What differs from Linux

| Linux | Windows | Where |
|---|---|---|
| `factory-tick@<app>.timer` (systemd user units) | `factory serve` (task `factory-serve`) | `factory/scheduler/serve.py` |
| `fcntl.flock` | `LockFileEx` on a byte far past the data | `factory/oscompat.py` |
| `os.killpg` (SIGTERM, then SIGKILL) | `taskkill /T`, then `/T /F` | `factory/oscompat.py` |
| `os.kill(pid, 0)` liveness | `OpenProcess` + `GetExitCodeProcess` | `factory/oscompat.py` |
| `start_new_session=True` | `CREATE_NEW_PROCESS_GROUP` | `factory/oscompat.py` |
| `round-<n>.sh`: `claude … \| tee … \| pretty` in bash | `round-<n>.json` run by `python -I -m factory.claude_session.round` | `factory/claude_session/round.py` |
| termhub command `bash round-<n>.sh` | `& '<venv python>' -I -m factory.claude_session.round '<spec>'` (PowerShell) | `launcher.round_command` |

Why not a shell on Windows: `bash.exe` on PATH is often the WSL shim, and
Windows PowerShell 5.1 re-encodes native output and writes UTF-16 through
`Tee-Object`, which corrupts `stream-<n>.jsonl`. The round runner does the
pipeline byte for byte in Python.

`os.kill(pid, 0)` must never be called directly: on Windows it terminates the
process. Use `factory.oscompat.pid_alive`.

## factory serve

- Ticks each app as a fresh subprocess (`python -m factory tick --app <app>`),
  every `--interval` seconds (default 300), never two ticks of one app at once.
- Wakes within a second when `factory job submit` or `factory job resume` drops a
  file in `state\scheduler\wake.d\`: it dispatches queued research/report jobs at
  once (no LLM) and ticks the job's app.
- Runs the research/report dispatch itself every interval too, so those jobs run
  on a machine with no LLM provider key (`factory tick` exits 2 without one,
  before its own dispatch).
- Lease: one serve per factory root (`state\locks\serve.lock`, released by the OS
  if serve dies). Each tick it starts holds `state\locks\tick-<app>.lock`.
- On Linux it refuses while `factory-tick@*.timer` units are active
  (`--allow-with-systemd` overrides).
- Also holds a SQLite lease (`state/scheduler/leases.db`, 30 s TTL, renewed every
  10 s; taken over at once from a dead pid on the same host). `--status` shows it.
- **HTTP API (plan 2.1)** on `127.0.0.1:7330` (`--port`, `$FACTORY_SERVE_PORT`; `0`
  = off): `POST /api/cli {"argv": ["job", "status", "<id>", "--json"]}` runs that
  CLI command in-process and answers `{code, stdout, stderr, ms}`, byte-identical
  to the spawned CLI; `GET /api/health`. Every request needs `X-Factory: 1`. Only
  `job` verbs (not `follow`) and `app` verbs. Warm calls take 40–200 ms instead of
  5–10 s for `uv run factory …`; the personal assistant uses it first
  (`PA_FACTORY_SERVE_URL`) and spawns the CLI only when nothing ran.
- **Restart on update**: every 30 s serve compares the checkout's git HEAD with the
  one it started on and exits 75 when it moved (the `factory-serve` task restarts
  it within a minute; running ticks are left alone). `--no-restart-on-update`.
- **Push (E3)**: every 5 s (and right after an API submit/cancel/resume) serve
  POSTs job state changes to the personal assistant's
  `/api/factory/events` (`--pa-events-url`, `$FACTORY_PA_EVENTS_URL`, `off`).

## Linux

Serve runs there too: `scripts/systemd/factory-serve.service` (a user unit;
`Restart=always` covers the exit-75 restart). It replaces the
`factory-tick@<app>.timer` units, so stop and disable those first; serve refuses
to start while any is active.

## Config on Windows

- termhub: `FACTORY_TERMHUB_URL` defaults to `http://127.0.0.1:7010` (sessiond on
  Windows too). termhub's shell is PowerShell; set `FACTORY_TERMHUB_SHELL=cmd` if
  it runs `cmd`.
- Gate, smoke and boot commands in `apps/<app>/config.yaml` run through `cmd.exe`
  on Windows (`shell=True`). Write them for `cmd` (or call `powershell -Command`).
- Booted apps get the Windows essentials (`SYSTEMROOT`, `TEMP`, `COMSPEC`, ...) on
  top of their `env_passthrough`.

## Tests

`uv run pytest -n auto` runs on Windows. Tests that need POSIX (bash scripts,
`fork`, POSIX signals, symlinks, file modes) are skipped there with the reason;
the list is in `docs/native/PLAN.md`, item 2.3.
