# Module: personal-assistant

**Path:** `personal-assistant/`

## Purpose

Context layer over Outlook/Teams/GitLab/meetings that distills asks into typed commitments, dispatches them to Claude Code sessions you can attach to, and drafts the reply when the work lands.

## Key files

| File | Role |
|------|------|
| `package.json` | NPM dependencies and scripts. |
| `bin/pa.js` | CLI entry point (`pa` command). |
| `src/` | Source code — dashboard, architecture, integrations. |
| `integrations/` | Third-party integrations (Outlook, Teams, GitLab). |
| `voice/` | Voice input support. |
| `audio/` | Audio processing. |
| `sql/` | SQLite schema and queries. |
| `teams/` | Microsoft Teams integration. |
| `windows/` | Windows installer (`install.ps1`). |
| `linux/` | Linux installer. |
| `test/` | Test files. |
| `docker-compose.yml` | Docker Compose for local development. |
| `vendor/` | Vendored dependencies. |

## Tech

- Node.js
- SQLite for persistence
- Integrates with Outlook/Teams APIs, GitLab API, Anthropic Claude API