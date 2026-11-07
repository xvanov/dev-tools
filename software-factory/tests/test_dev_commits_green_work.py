"""The chain must COMMIT the dev's green work before review.

Regression for story 106 (2026-07-21): the dev persona is *asked* to commit
its own work, but that is non-deterministic. When the agent forgot, the story
branch had NO committed diff, so the reviewer diffed ``origin/base...HEAD``,
saw an EMPTY diff ("nothing implemented"), correctly requested changes, and the
dev<->reviewer loop churned full cycles on already-correct, test-green code.

``handle_dev`` now deterministically ``git add -A && commit`` any uncommitted
worktree changes on the GREEN path (mirroring the dev-exhausted path), so the
reviewer always sees the real diff. These tests use a real git repo + worktree
and a fake ``sandbox_run`` that writes files WITHOUT committing them.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import _writing_worktree, handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories" / "1-x.md").write_text("# story\n", encoding="utf-8")
    src = tmp_path / "myapp"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=str(src), check=True)
    (src / "README.md").write_text("# init\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(src), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src), check=True)
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    return AppConfig(
        name="myapp", repo="x/y", default_branch="main",
        app_repo_path=str(temp_root / "myapp"),
    )


def _enable_convergence(temp_root: Path) -> None:
    (temp_root / "factory_settings.yaml").write_text(
        "dev_convergence:\n  enabled: true\n  max_inner_attempts: 3\n"
        "  per_story_wall_clock_s: 2700\n  per_story_budget_usd: 8.0\n"
        "  dev_sandbox_timeout_s: 1800\n",
        encoding="utf-8",
    )


def _story(temp_root: Path) -> StoryRecord:
    return persist_story(
        StoryRecord(id=None, direction_id="099", app="myapp", title="t", slug="x",
                    scope="backend", state=StoryState.SM_DONE.value, chain_kind="tdd"),
        temp_root / "state" / "factory.db",
    )


def _git_out(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True
    ).stdout.strip()


def test_green_dev_work_is_committed_before_review(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root)
    story = _story(temp_root)

    async def _green_writes_uncommitted(*args: object, **kwargs: object) -> RunResult:
        # A dev agent that wrote code but forgot to `git commit`.
        repo = _writing_worktree(app_config, temp_root, story)
        (repo / "newmod.py").write_text("VALUE = 1\n", encoding="utf-8")
        return RunResult(
            success=True, files_changed=["newmod.py"], test_run_passed=True,
            summary="all green", cost_usd=0.01, tokens_out=100,
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _green_writes_uncommitted, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert StoryState(story.state) is StoryState.TESTS_GREEN
    wt = _writing_worktree(app_config, temp_root, story)
    # The uncommitted dev work is now COMMITTED on the story branch → the diff
    # the reviewer will see against base is NON-EMPTY.
    assert _git_out(["log", "--oneline", "main..HEAD"], wt), "green dev work was not committed"
    assert "VALUE = 1" in _git_out(["show", "HEAD:newmod.py"], wt)
    # No uncommitted residue left behind.
    assert _git_out(["status", "--porcelain"], wt) == ""


def test_resume_from_checkpoint_also_commits_uncommitted_green_work(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If a prior tick crashed AFTER the dev ran green but BEFORE the commit,
    resume-from-checkpoint re-advances to TESTS_GREEN — and must also commit the
    green work still sitting uncommitted in the reused worktree, or the empty-diff
    churn returns. The resume path must NOT call the dev LLM again."""
    import json

    _enable_convergence(temp_root)
    story = _story(temp_root)
    # Simulate the interrupted state: worktree has green (uncommitted) work +
    # a green checkpoint, story parked in dev_in_progress.
    wt = _writing_worktree(app_config, temp_root, story)
    (wt / "resumed_mod.py").write_text("VALUE = 9\n", encoding="utf-8")
    # Story re-enters handle_dev at its dispatch state (SM_DONE) carrying a green
    # checkpoint from the interrupted run; resume advances it to TESTS_GREEN
    # without re-running the LLM.
    story.dev_step_checkpoint = json.dumps({"outcome": "green", "attempt": 0, "ts": "t"})
    persist_story(story, temp_root / "state" / "factory.db")

    called = [0]

    async def _must_not_run(*a: object, **k: object) -> RunResult:
        called[0] += 1
        raise AssertionError("dev LLM must not run on a green resume")

    monkeypatch.setattr(runner_module, "sandbox_run", _must_not_run, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert called[0] == 0, "resume must skip the dev LLM"
    assert StoryState(story.state) is StoryState.TESTS_GREEN
    assert _git_out(["log", "--oneline", "main..HEAD"], wt), "resumed green work not committed"
    assert "VALUE = 9" in _git_out(["show", "HEAD:resumed_mod.py"], wt)


def test_green_commit_is_idempotent_when_agent_already_committed(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the agent DID commit its own work, the chain's add/commit is a no-op
    (a clean tree) — it must not create an empty commit or fail."""
    _enable_convergence(temp_root)
    story = _story(temp_root)

    async def _green_self_commits(*args: object, **kwargs: object) -> RunResult:
        repo = _writing_worktree(app_config, temp_root, story)
        (repo / "newmod.py").write_text("VALUE = 2\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=str(repo), check=True)
        subprocess.run(["git", "commit", "-q", "-m", "dev self-commit"], cwd=str(repo), check=True)
        return RunResult(
            success=True, files_changed=["newmod.py"], test_run_passed=True,
            summary="all green", cost_usd=0.01, tokens_out=100,
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _green_self_commits, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert StoryState(story.state) is StoryState.TESTS_GREEN
    wt = _writing_worktree(app_config, temp_root, story)
    # Exactly ONE commit ahead of base (the agent's) — the chain did not add a
    # second empty commit.
    assert _git_out(["rev-list", "--count", "main..HEAD"], wt) == "1"
    assert "VALUE = 2" in _git_out(["show", "HEAD:newmod.py"], wt)
