# Current State

## Active architectural decisions

- **Two-tier termhub architecture**: `sessiond` (persistent PTY supervisor) and
  `front` (swappable web UI/proxy) run as separate processes so updates replace
  the front without killing terminals. `sessiond` owns node-pty PTYs and
  scrollback; `front` serves xterm.js UI and reverse-proxies to `sessiond`.
- **ptyd is landing, opt-in**: Rust terminal host (`TERMHUB_PTYD=1`) can
  replace node-pty as the PTY backend. Sessiond keeps its screen mirror and
  agent work (voice, idle tracking) — ptyd only owns the PTYs.
- **personal-assistant uses Postgres 16 + pgvector** (on Windows via WSL, on
  Linux natively or Docker). An SQLite backend (`PA_DB=sqlite`) exists as a
  twin for portable deployments — same repo methods, SQLite-optimised SQL.
- **No code path sends messages without a human.** Drafts open in Teams/Outlook
  for the operator to press Send. This is an invariant.
- **Dispatch enforces mode boundaries, doesn't request them.** A `local` run's
  termhub session strips push credentials, resets git credential helpers, and
  logs out `gh`. The boundary for work that must never exceed its level (a
  separate OS user) is not set up yet.
- **software-factory personas** are prompt-defined roles with per-persona model
  routing via a single YAML file (`factory/routes.yaml`). The chain is
  direction -> PM (triage/split) -> SM (story files) -> Dev (code + tests) ->
  Reviewer (FIND/REPLACE edits) -> merge gates -> PR auto-merge -> deploy ->
  tech-writer refreshes context docs.
- **Four-tier FMS manager daemon was deleted 2026-08-07** (L1 Watcher, L2
  Summarizer, L3 Diagnostician, L4 Apply). It cost 52% of all-time LLM spend
  and shipped 0 fixes. Replaced by deterministic detectors that file directions
  into the normal chain.
- **software-factory Loop 2 (self-edit) is paused** since 2026-11-06. The
  factory lives in the dev-tools monorepo and updates via `git pull --ff-only`.
- **No secrets in the repo.** GitHub tokens are per-owner via `factory/gh_auth.py`;
  API keys live in `.env` files and the OS credential store (Windows Credential
  Manager / Linux Secret Service).
- **All tests use local fixtures only.** CI uses no secrets. The personal-assistant's
  repository contract test creates throwaway databases.

## Module map

| Module | Language | Runtime | Platform | Has tests? | CI job |
|--------|----------|---------|----------|------------|--------|
| termhub | TypeScript / JS | Node.js 18+ | Windows, Linux | npm test (custom runner) | termhub |
| ptyd | Rust | Rust (MSVC) | Windows, Linux | cargo test | ptyd (conformance via termhub) |
| desktop | TypeScript / Rust | Tauri 2 (Node + Rust) | Windows, Linux | cargo test (unit) | build |
| jarvisd | TypeScript | Bun | Windows, Linux | tsc + parity + --check | jarvisd |
| personal-assistant | TypeScript / JS | Node.js 22+ | Windows, Linux | npm test (custom runner) | personal-assistant |
| software-factory | Python | uv (Python 3.12) | Windows, Linux | pytest via uv | software-factory |
| voice-dictation | Python | Python 3.10+ | Windows, Linux | None (manual smoke) | None |
| summarize-recording | Python | Python 3.10+ | Windows, Linux | None | None |
| claude-ctx-statusline | JavaScript | Node.js | Windows, Linux, macOS | None | None |
| disk-janitor | Python | Python 3.9+ (stdlib only) | Windows, Linux | None (stdlib only, tested via CI) | None (part of build) |
| keep-awake | PowerShell | PowerShell 5.1+ | Windows only | None | None |
| bootstrap | Bash / PowerShell | Bash, PowerShell | Linux, Windows | None | None |
| ios-messages | Python | Python 3.12+ | Windows, Linux | pytest | ios-messages |

## Current constraints

- software-factory's Windows suite runs informational only (60-min timeout,
  never fails the run). The Windows gate is a focused subset (2.x tests).
- termhub on Linux runs as a single process (no two-tier split), so updates
  there still end terminals.
- No macOS support (plan D14).
- The ptyd binary is not distributed by default; switching to ptyd requires
  building it first.
- personal-assistant on Windows requires WSL for Postgres (unless using SQLite).
  WSL can drop the Postgres server when its last client exits; a keepalive task
  prevents this.