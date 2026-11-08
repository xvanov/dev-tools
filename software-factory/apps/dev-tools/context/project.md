# dev-tools — Project Overview

## Identity

A monorepo of independent personal tooling for AI-assisted workflows: push-to-talk
voice dictation, batch transcription/summarization, a mobile-friendly web terminal,
Claude Code utilities, a personal agentic layer that sits between the operator and
coding agents, and an autonomous software factory. Each tool lives in its own
directory with its own README, test runner, and install scripts.

## Stack

- **Primary language:** TypeScript / JavaScript (Node.js, Bun, Tauri 2), Python,
  Rust, PowerShell
- **Runtimes:** Node.js 22+, Bun, Python 3.10–3.13, Rust (MSVC on Windows)
- **Key dependencies per tool:** See `modules/<tool>.md`
- **CI:** GitHub Actions (`.github/workflows/ci.yml`), path-filtered per tool,
  runs on Linux + Windows in parallel
- **Test runner:** Custom Node.js runner (`scripts/run-tests.js`) for JS/TS;
  pytest via uv for Python software-factory; `cargo test` / `pytest` for other
  Python tools; unified build script (`scripts/build.js`) for compiled targets

## Top-level layout

```
dev-tools/
├── bootstrap/                # One-shot Linux machine provisioning (Raspberry Pi / Ubuntu)
├── voice-dictation/          # Push-to-talk voice transcription (faster-whisper)
├── summarize-recording/      # Transcribe + Azure summarization CLI
├── claude-ctx-statusline/    # Claude Code statusLine helper
├── keep-awake/               # Windows session-awake helper (F15 tap)
├── termhub/                  # Web terminal over Tailscale (xterm.js)
├── desktop/                  # Jarvis desktop shell (Tauri 2)
├── ptyd/                     # Rust terminal host for termhub
├── disk-janitor/             # Scheduled, whitelist-only disk reclamation
├── personal-assistant/       # Context layer: ingest -> distil -> recall -> dispatch -> draft
├── ios-messages/             # iPhone backup -> text export -> classify -> anonymize
├── software-factory/         # Autonomous software factory (Python/uv)
├── jarvisd/                  # Jarvis core: TypeScript on Bun
├── scripts/                  # Repo-wide build / test tooling
├── docs/                     # Cross-cutting documentation
└── .github/workflows/        # CI definitions
```

## Active constraints

- Public repository: no secrets, tokens, keys, hostnames, IP addresses,
  tailnet names, names or email addresses may be committed. Machine references
  are generic ("the Windows work laptop", "the Linux machine").
- All tools deploy via `git pull --ff-only` from `main`. Uncommitted work in
  the working tree can block updates (termhub's updater stashes it and stops
  if it won't go back).
- Conventional Commits, scoped by tool: `feat(termhub):`, `fix(voice-dictation):`.
- Each tool is independently installable; the root `install.ps1` installs the
  whole Windows stack in one command.