# Project: dev-tools

## Identity

A monorepo of independent personal tooling for AI-assisted workflows. Each tool lives in its own directory with its own README, dependencies, and install scripts. The tools share no runtime — they are separate utilities used by the owner across Windows and Linux machines.

## Stack

- **Primary languages:** Python 3.12+, TypeScript/JavaScript (Node.js), PowerShell, Bash
- **Python tools** use `pip` / `requirements.txt` patterns (except `software-factory` which uses `uv`)
- **JS/TS tools** use `npm` / `package.json` patterns
- **CI:** GitHub Actions (`.github/workflows/ci.yml`), path-filtered per tool, Linux + Windows parallel
- **Linting:** Ruff (Python), ESLint/prettier (JS)
- **No Docker** in the main tools; one `docker-compose.yml` under `personal-assistant/`

## Top-level layout

```
dev-tools/
├── bootstrap/                # One-shot Linux machine provisioning (Pi/Ubuntu)
├── claude-ctx-statusline/    # Claude Code context-window status bar helper
├── disk-janitor/             # Safe, scheduled disk-space reclamation
├── docs/                     # Cross-cutting documentation (native rebuild plan)
├── ios-messages/             # iPhone backup → text export → anonymize
├── keep-awake/               # Windows session keep-awake utility
├── personal-assistant/       # Context layer over Outlook/Teams/GitLab
├── scripts/                  # Shared CI/utility scripts
├── software-factory/         # Autonomous software factory orchestrator
├── summarize-recording/      # Audio transcription + summarization
├── termhub/                  # Mobile-friendly web terminal over Tailscale
└── voice-dictation/          # Push-to-talk voice transcription
```

## Active constraints

- **Windows + Linux dual-target** for most tools; platform-specific installers under `<tool>/windows/` and `<tool>/linux/`
- **`software-factory`** is a Python/uv project with its own toolchain and is the most complex subsystem
- All tools are **single-owner** — no multi-contributor workflow; `main` is the primary branch
- CI is **path-filtered** — only changed tools are tested per push