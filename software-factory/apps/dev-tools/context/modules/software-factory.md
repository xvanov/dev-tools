# software-factory — Autonomous Software Factory

## What it does

An LLM persona pipeline that turns high-level product directions into reviewed,
tested, merged pull requests unattended. Personas (PM, SM, Dev, Reviewer, ...)
are prompt-defined roles with per-persona model routing. Jobs can be `code`
(direction -> PR chain), `research`, or `report` (single agent writes a report).
Supports two runtimes: `api` (OpenHands + LiteLLM) and `claude_session` (Claude
Code on the operator's subscription, in a termhub session).

## Language / Runtime

Python 3.12–3.13 on uv. Its default model routes are Azure (gpt-5.x, Kimi) and
DeepSeek (`factory/routes.yaml`); other providers, Anthropic included, only through
an explicit per-persona override. Key dependencies: `openhands-sdk`, `litellm`, `pygithub`,
`typer`, `fastapi`, `sqlmodel`, `pyyaml`, `httpx`, `textual` (TUI).

## Platforms

Windows (native via `factory serve` as logon task) and Linux (systemd user
units). The Windows suite runs informational-only in CI.

## Test command

```
cd software-factory && uv run pytest -q -n auto --dist loadfile
```

About 4,255 tests (the Windows count recorded in `docs/native/PLAN.md`, item
2.3). Ruff linting and mypy type checking also run in CI. Changed-files mode:
`python scripts/changed-pytest.py` (the pre-commit hook runs it).

## Install / Deploy

- Setup: `uv sync --all-extras` in `software-factory/`
- Day-to-day: `uv run factory <command>` (tick, status, inbox, budget, ...)
- Linux: the `factory-serve.service` systemd user unit, which replaces the
  older `factory-tick@<app>.timer` units (serve refuses to start while one is
  active)
- Windows: `scripts/windows/install-serve.ps1` registers `factory-serve` logon
  task
- Deployment: `git pull --ff-only` in the dev-tools checkout
- Configuration: `factory/routes.yaml` (model routing), `.env` (API keys),
  `factory_settings.yaml` (spend caps, features)