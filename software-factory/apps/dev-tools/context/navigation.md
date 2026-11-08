# Navigation — task-to-files index

## When working on termhub

- `termhub/README.md` — product overview, architecture, features
- `termhub/AGENT.md` — detailed install, troubleshooting, HTTP API, port modes
- `termhub/package.json` — dependencies, scripts
- `termhub/lib/` — core modules (sessiond, front, PTY management)
- `termhub/web/` — xterm.js UI
- `termhub/test/` — test files
- `termhub/windows/` — Windows installers and updaters
- `termhub/linux/` — Linux installers and systemd units
- `scripts/README.md` — test runner configuration

## When working on ptyd

- `ptyd/README.md` — build, protocol, conformance, cutover plan
- `ptyd/Cargo.toml` — Rust dependencies
- `ptyd/src/` — Rust source
- `termhub/test/ptydConformance.test.js` — black-box conformance suite
- `termhub/test/ptydBackend.test.js` — sessiond-adoption test
- `termhub/lib/ptydClient.js` — termhub's client for ptyd

## When working on desktop (Tauri shell)

- `desktop/README.md` — architecture, configuration, build
- `desktop/package.json` — Node dependencies
- `desktop/src-tauri/` — Tauri 2 Rust backend (cargo)
- `desktop/ui/` — settings window
- `scripts/README.md` — build script docs (`scripts/build.js`)

## When working on jarvisd

- `jarvisd/package.json` — scripts, Bun dependency
- `jarvisd/src/main.ts` — entry point
- `jarvisd/src/` — TypeScript source
- `jarvisd/tsconfig.json` — TypeScript config
- `personal-assistant/test/` — parity tests (jarvisd runs PA test files)

## When working on personal-assistant

- `personal-assistant/README.md` — product overview, install, shape
- `personal-assistant/AGENT.md` — working agreement and invariants
- `personal-assistant/PLAN.md` — phased build plan
- `personal-assistant/package.json` — dependencies
- `personal-assistant/src/` — main source (ingest, distill, dispatch, draft, ...)
- `personal-assistant/bin/pa.js` — CLI entry point
- `personal-assistant/test/` — test files
- `personal-assistant/sql/` — Postgres migrations
- `personal-assistant/sql-sqlite/` — SQLite schema twin
- `personal-assistant/windows/` — Windows installers
- `personal-assistant/linux/` — Linux installers

## When working on software-factory

- `software-factory/README.md` — product overview, benchmark results, design
- `software-factory/CLAUDE.md` — full brief for agents (three loops, playbook, guardrails)
- `software-factory/AGENTS.md` — entry point for AGENTS.md-aware tools
- `software-factory/pyproject.toml` — Python dependencies, build config
- `software-factory/factory/` — orchestrator source
- `software-factory/factory/chain/` — state machine, handlers, gates
- `software-factory/factory/personas/` — prompt-defined roles
- `software-factory/factory/routes.yaml` — per-persona model routing
- `software-factory/tests/` — pytest suite
- `software-factory/STATUS.md` — current status, known open issues

## When working on voice-dictation

- `voice-dictation/README.md` — product overview, features, configuration
- `voice-dictation/AGENT.md` — detailed install guide for agents
- `voice-dictation/recorder.py` — main orchestrator
- `voice-dictation/transcribe_server.py` — always-warm Whisper server
- `voice-dictation/linux/` — Linux installer and systemd unit
- `voice-dictation/windows/` — Windows installer and AutoHotkey

## When working on summarize-recording

- `summarize-recording/README.md` — usage, configuration, output formats
- `summarize-recording/summarize-recording.py` — CLI entry point
- `summarize-recording/summarize_recording/` — package source
- `summarize-recording/requirements.txt` — Python dependencies

## When working on claude-ctx-statusline

- `claude-ctx-statusline/README.md` — install, what it does
- `claude-ctx-statusline/ctx-statusline.js` — the status line script
- `claude-ctx-statusline/install.ps1` — Windows installer
- `claude-ctx-statusline/linux/` — Linux installer

## When working on disk-janitor

- `disk-janitor/README.md` — safety model, default targets, install
- `disk-janitor/disk_janitor.py` — main script (stdlib-only Python)
- `disk-janitor/windows/` — Windows scheduled task installer
- `disk-janitor/linux/` — Linux systemd timer installer

## When working on keep-awake

- `keep-awake/README.md` — what it does, install, uninstall
- `keep-awake/KeepAwake.ps1` — PowerShell script
- `keep-awake/install.ps1` — Windows scheduled task installer

## When working on bootstrap

- `bootstrap/README.md` — what it provisions, usage
- `bootstrap/pi-setup.sh` — main provisioning script (Linux)
- `install.ps1` — Windows bootstrap (root of repo)

## When working on ios-messages

- `ios-messages/README.md` — pipeline overview, classify rules, anonymize, tests
- `ios-messages/ios-messages.py` — CLI entry point
- `ios-messages/ios_messages/` — package source
- `ios-messages/tests/` — pytest suite
- `ios-messages/requirements.txt` — Python dependencies

## When working on CI / build system

- `.github/workflows/ci.yml` — CI workflow definition
- `scripts/README.md` — build, test runner, changed-files mode, pre-commit hook
- `scripts/build.js` — unified build script
- `scripts/run-tests.js` — custom test runner
- `scripts/install-hooks.js` — pre-commit hook installer

## When working on the repo's conventions

- `CLAUDE.md` — root working agreement (commit style, architecture map, docs policy)
- `scripts/README.md` — test runner, build, pre-commit hook, conventions
- `scripts/hooks/pre-commit` — the hook: ios-messages guard, then changed-files tests
- `personal-assistant/src/dashboard/architecture.json` — the living system map,
  updated in the same commit as any component change
- `docs/native/PLAN.md` — the native rebuild plan; its decision log is binding