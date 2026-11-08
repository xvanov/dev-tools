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
<checkout>\software-factory\.venv\Scripts\python.exe -m factory serve --interval 300 --log-file logs\serve.log
```

Options: `-Apps a,b` (default: the apps whose config sets `serve_tick: true`), `-IntervalSeconds`,
`-SkipSync`, `-Uninstall`. Updating is `git pull --ff-only` (the next tick runs
the new chain code; restart the task after a change to `factory serve` itself:
`Stop-ScheduledTask factory-serve; Start-ScheduledTask factory-serve`).

Check it: `uv run factory serve --status` (lease holder, apps, running ticks),
`<state>\logs\serve.log`, and one log per app in `<state>\logs\serve\tick-<app>.log`.

### State lives outside the repo

`<state>` is the runtime state: the database, story worktrees, agent run dirs,
job workspaces, logs, locks. It used to be `software-factory\state`, inside the
repo the factory runs from. For dev-tools that put every story worktree, and
every agent's working directory, inside the live checkout that the personal
assistant, termhub and the factory run from: an agent climbed from its worktree
and wrote into the live tree (2026-11-08).

`factory state migrate` moves everything in `state\` except its tracked `.gitignore` to
`%LOCALAPPDATA%\software-factory\state` (Linux: `~/.local/share/software-factory/state`;
`--to DIR` to choose), writes the gitignored pointer
`software-factory\.state-dir`, and re-links the moved git worktrees (`git worktree
repair`). It is an operator command: nothing runs it by itself, and install-serve.ps1
only warns while the state is still in the repo. It refuses, changing nothing, while a
factory lock is held or the database is open, when the target is inside the repo, not
empty, or on another disk (entries are renamed, never copied), or when the root is
already migrated. A rename that fails part-way (a termhub session, editor or the
personal assistant worker with a file open or its working directory in a worktree) is
undone. `--dry-run` lists what would move. `factory state where` prints the directory
in use and warns if anything was written into `software-factory\state` since.

On this machine, with nothing else of the factory running:

```powershell
cd <dev-tools checkout>\software-factory
uv run factory off                      # stops the factory-serve task; stop the PA worker too
uv run factory state migrate --dry-run
uv run factory state migrate
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-serve.ps1 -SkipSync -Start
uv run factory state where
```

Re-running the install script matters: a task registered before this change passes
the absolute `--log-file <checkout>\software-factory\state\logs\serve.log`; the
current one passes `logs\serve.log`, which serve puts under `<state>`.

Every process finds the state through the pointer (`factory/state_dir.py`; the
personal assistant's `resolveStateDir` reads the same file). There is no
environment override on purpose: serve's children inherit its environment, and in a
story worktree or staging clone of dev-tools (whose `software-factory` is a copy
with no pointer) a variable would point that copy at the live state. Serve refuses to start when the pointer names a directory that does
not exist (it would start on an empty database). Restart serve and the personal
assistant worker after migrating. Records written before the move keep their old
absolute paths (termhub links to old `api_runs` streams, finished jobs'
workspaces); stored acceptance-test refs (`state/acceptance/...`) resolve into
`<state>`.

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

- Ticks only the apps that opt in: `serve_tick: true` in `apps/<app>/config.yaml`
  (tracked: dev-tools, factory, template-probe), unless `--app` or
  `$FACTORY_SERVE_APPS` names them. Never "every registered app": a stale local
  config must not start ticking (and spending) because serve came up, just as an
  app without an enabled timer never ticked under systemd.
- Ticks each app as a fresh subprocess (`python -m factory tick --app <app>`),
  every `--interval` seconds (default 300), never two ticks of one app at once.
  A tick that moved a story re-wakes its app at once (capped at 30 in a row).
- Kills a tick after `--tick-timeout` seconds (default 10800, the old systemd
  `TimeoutStartSec=3h`) and passes the same number to the tick as
  `FACTORY_TICK_BUDGET_S`, so the tick never starts an agent step that cannot
  finish in time (a solo dev step needs 6900 s). At 3600 s serve killed a live
  dev step (2026-11-08). After a kill, serve closes the provisional `runs` rows
  whose owning process died (`runs.owner_pid`), so the step no longer shows as
  `running`; the next tick does the same for ticks killed any other way. The
  stale-story pass skips a story whose handler still has a live
  `live_handlers` row.
- `factory on` / `off` / `power` manage serve: the `factory-serve` task on
  Windows, `factory-serve.service` on Linux (where `factory on` then never
  enables the old `factory-tick@` timers).
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

## git exits 0xC0000142

At 16:36Z on 2026-11-08 a dev-tools tick's `git worktree add` exited 3221225794
(0xC0000142, `STATUS_DLL_INIT_FAILED`) with empty stderr: git died in the Windows
loader before running. At 16:34Z a `show-ref` probe most likely failed the same
way, since the chain took its "no such branch" path for a branch that existed.
The same commands worked at 16:41Z.

- **Not the creation flags.** Serve starts each tick with
  `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`, which gives the tick one hidden
  console. git (a plain `subprocess.run`) inherits it and opens no console of its
  own. `CREATE_NO_WINDOW` on every git call would start a console host per call:
  more desktop heap, not less. The `factory-serve` task is an Interactive logon
  (the user's desktop, 20 MB desktop heap), not the 768 KB non-interactive one.
- **The machine was starved.** From 16:29Z to 16:40Z every app's tick took
  170–370 s instead of 6–15 s. The System log has no hard-error popup (event 26)
  and no resource-exhaustion warning (event 2004) for that window, and at 17:2xZ
  there was no console-host leak (46 conhosts, mostly services). Which resource
  ran out (desktop heap, commit, something else) is unknown.
- **What the factory does.** `branch._run_git` retries a git that exited
  `STATUS_DLL_INIT_FAILED` (it never ran, so a retry is safe), up to 3 attempts
  in all, and names the status in the error.

## Story worktree leftovers

A file still held open (a process the killed tick left behind, an editor, AV)
stops `git worktree remove` and `rmtree` part way on Windows, leaving a tree
without its `.git`. `ensure_worktree_for_story` clears such a tree (remove,
rmtree, prune), renames it to `<name>.stale-<ns>` if it still cannot be
deleted, and re-creates the worktree from the story branch.

## Linux

Serve runs there too: `scripts/systemd/factory-serve.service` (a user unit;
`Restart=always` covers the exit-75 restart). It replaces the
`factory-tick@<app>.timer` units, so stop and disable those first; serve refuses
to start while any is active. Migrate the state the same way, with everything
stopped (`factory off` stops the tick timers or the serve unit):

```bash
cd ~/dev-tools/software-factory
uv run factory off && uv run factory power      # nothing active
uv run factory state migrate --dry-run
uv run factory state migrate
cp scripts/systemd/factory-serve.service ~/.config/systemd/user/ && systemctl --user daemon-reload  # if serve is installed
uv run factory on && uv run factory state where
```

The unit from before this change passed an absolute `--log-file` under the repo's
`state/`; the current one passes `logs/serve.log` (under `<state>`). Restart the
personal assistant worker afterwards.

## Config on Windows

- termhub: `FACTORY_TERMHUB_URL` defaults to `http://127.0.0.1:7010` (sessiond on
  Windows too). termhub's shell is PowerShell; set `FACTORY_TERMHUB_SHELL=cmd` if
  it runs `cmd`.
- Gate, smoke and boot commands in `apps/<app>/config.yaml` run through `cmd.exe`
  on Windows (`shell=True`). Write them for `cmd` (or call `powershell -Command`).
- Booted apps get the Windows essentials (`SYSTEMROOT`, `TEMP`, `COMSPEC`, ...) on
  top of their `env_passthrough`.
- Meter (native plan 7.5): set `PA_TELEMETRY_URL=http://127.0.0.1:7300` (the PA's
  dashboard) in the factory's environment and the factory posts its hop spans and each
  `claude_session` run's `total_cost_usd` and token usage to `POST /api/telemetry`.
  Unset (the default) means nothing is posted. The PA counts those runs against
  `PA_CLAUDE_POOL_USD`; see `personal-assistant/README.md`.

## Agent sandbox (FACTORY_SANDBOX, default off)

`FACTORY_SANDBOX=on` starts a claude_session run's `claude` under a restricted,
Low-integrity token in a job object (`factory/sandbox/exec.py`): it cannot read
`%USERPROFILE%` (SSH keys, gh's login), cannot reach the Credential Vault, and
writes only its worktree and its own home. What it cannot do on Windows yet:

- Egress is routed through the allowlist proxy (`HTTPS_PROXY`) but not enforced;
  a raw socket gets out. Enforcing it needs a firewall rule or a separate
  account (admin steps, not taken).
- Folders every local user can read stay readable: `C:\repos` inherits
  `Users: RX` from `C:\`. An operator step closes that:
  `uv run python -m factory.sandbox.exec setup --deny-read C:\repos`
  (adds one inherited deny for the sandbox SID; a run's own worktree keeps its
  protected ACL).
- The interpreter, the venv and `claude.exe` are granted read once per path to
  the sandbox SID (`sandbox-granted.json` remembers which).
- The API runtime's terminal is not sandboxed on Windows: the run is refused
  while the flag is on, rather than half-applied.
- Claude Code needs its model credential inside: `CLAUDE_CODE_OAUTH_TOKEN`
  (`claude setup-token`) is passed by default (`FACTORY_SANDBOX_PASS_ENV`).

## Tests

`uv run pytest -n auto` runs on Windows. Tests that need POSIX (bash scripts,
`fork`, POSIX signals, symlinks, file modes) are skipped there with the reason;
the list is in `docs/native/PLAN.md`, item 2.3.
