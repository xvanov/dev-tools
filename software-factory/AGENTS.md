# AGENTS.md

Entry point for AGENTS.md-aware tools (OpenCode, Codex, Cursor, …) working in
this repo.

**Read `CLAUDE.md` first — it is the full brief and it is short.** It covers:
what this factory is, the three loops and which one you are in, the 60-second
health check, the environment (`uv sync --all-extras`, then prefix everything
with `uv run`), where truth lives, the operator command surface, the
diagnose→fix→deploy playbook, the hard guardrails, and pointers to deeper docs.

Do not start editing before you have read it.

## The five rules you cannot violate

1. `uv sync --all-extras`, then `uv run <cmd>`. A bare `uv sync` has no pytest.
2. The live tree must equal `origin/main` — `git fetch origin && git status -sb`.
   It has silently run dozens of commits behind before.
3. Never `git add -A` in this tree (`state/**` is live runtime churn). Deploy
   with `scripts/deploy-factory-from-main.sh`.
4. `factory/manager/**` and `bench/**` are forbidden to self-edit (operator PR
   only). Every self-edit merge surface stays staging-gated.
5. Gate on the real artifact, never a proxy (a recorded flag, an `--auto`
   *enable*, a dry-run's intent, a green test run with no commit). Fail safe.

## Working in an app repo instead?

Each app has its own agent docs — `../sacrifice/CLAUDE.md`,
`../rental-management/AGENTS.md`, `../template/CLAUDE.md`. This file is only
about the orchestrator.

## Testing gotcha (story D012 follow-up)

- Slop detector rule `direct_db_bootstrap` flags tests that call `create_engine(...)`/`SQLModel.metadata.create_all(...)` directly. For DB assertions in tests, bootstrap through `factory.observability.schema.migrate(db_path)` and query with `sqlite3` instead of creating engines inside the test body.
- Full-suite runs rely on extras being installed (`uv sync --all-extras`). Without it, acceptance-oracle subprocesses (`python -m pytest`) and runtime deps like `litellm`/`textual` can fail with `ModuleNotFoundError`, even if targeted tests pass.
- D012 deleted-`state.yaml` regression coverage lives in `tests/test_pm_sync_dry_run.py::test_deleted_state_yaml_survives_pm_sync_without_retriage`; it intentionally seeds status through `mark_direction_status` + `sqlite3` assertions (not direct test-time `create_engine`/`create_all`).
- D014 schema-test cleanup: `direct_db_bootstrap` is evaluated only inside `test_*` functions; helper-level engine setup can avoid false positives, but preferred cleanup is routing setup through `migrate(...)`. Use `# noqa: slop` only on the specific test definition when raw-engine behavior is the actual subject.

