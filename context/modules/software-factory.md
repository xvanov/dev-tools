# Module: software-factory (orchestrator)

**Path:** `software-factory/factory/`

## Purpose

The core orchestrator package — CLI entry point, persona runners, model routing, GitHub auth, app configuration, and job dispatching. This is the top-level package that wires all subsystems together.

## Key files

| File | Role |
|------|------|
| `__init__.py` | Version, phase, GitHub auth shim installation. |
| `cli.py` | Typer-based CLI with all `factory` commands (450+ lines). |
| `cli_apps.py` | `factory app` subcommands (add, set, list, etc.). |
| `cli_jobs.py` | `factory job` subcommands (submit, status, report, etc.). |
| `runner.py` | Persona runners — `sandbox_run` (OpenHands SDK) and `text_run` (liteLLM completion). |
| `model_router.py` | Resolves persona + difficulty to a model string via routes.yaml. |
| `app_config.py` | Loads per-app configuration from `apps/<app>/config.yaml`. |
| `gh_auth.py` | GitHub token selection by repo owner, `bin/gh` shim. |
| `artifacts/` | Artifact storage and retrieval. |
| `backpressure/` | Backpressure mechanisms for rate limiting. |
| `deploy/` | Deployment logic. |
| `directions/` | Direction file management. |
| `events/` | Event definitions and handling. |
| `providers/` | Provider integrations (GitHub, LLM). |
| `scheduler/` | Task scheduling. |
| `settings/` | Configuration loading. |
| `testing/` | Testing utilities. |
| `tui/` | Terminal UI dashboard. |
| `webhook/` | Webhook handling. |

## Dependencies

- All other `factory/` subpackages (chain, manager, personas, observability, etc.)
- OpenHands SDK, LiteLLM, PyGithub, Typer, Rich, FastAPI, Uvicorn
- `factory/routes.yaml` — model routing configuration
- `factory_settings.yaml` — factory-wide settings
- `apps/` — per-app configuration and directions