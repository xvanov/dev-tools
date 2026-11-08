# personal-assistant — Context Layer for AI-Assisted Work

## What it does

A personal agentic layer between the operator and coding agents. Ingests work
from Outlook, Teams, GitHub, Jira, and audio conversations; distils them into
typed commitments; recalls context across sources; dispatches approved work to
Claude Code sessions in isolated worktrees; and drafts replies when the work
lands. Never sends anything without human confirmation.

## Language / Runtime

TypeScript / JavaScript on Node.js 24+, the version the root `install.ps1`
requires (CI tests on Node 22; `package.json` says `>=20`); also runs on Bun via jarvisd. Key
dependencies: various (see `package.json`) — Microsoft Graph, Anthropic API,
Claude Code CLI, GitLab API, termhub API, Postgres/SQLite.

## Platforms

Windows (Postgres via WSL, native scheduled tasks) and Linux (native Postgres,
systemd user units).

## Test command

```
cd personal-assistant && npm test
```

Uses `../scripts/run-tests.js` (custom runner). Tests include repository
contract tests (throwaway Postgres + SQLite databases), dispatch start tests,
supervisor tests, termhub client tests, architecture conformance tests, and
install tests.

## Install / Deploy

- **Windows:** `.\windows\install.ps1` — provisions WSL Postgres 16 + pgvector,
  registers logon tasks (worker, capture)
- **Linux:** `linux/install.sh` — brings up store (Docker or native), writes
  systemd user units
- **Environment:** `.env` file with M365 credentials, Anthropic key, GitLab
  token; `.env.example` documents every key
- **Deployment:** part of the root `install.ps1` whole-stack install; runs on
  jarvisd by default