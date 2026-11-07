"""A ``runtime: claude_session`` story's dev step runs as Claude Code (JOBS-API v1.2).

The dev handler hands the SAME inputs it gives ``runner.sandbox_run`` (story,
prior attempts, findings, solo gate loop, wall clock) to
``factory.claude_session.run.claude_dev_run`` instead; every later step is
unchanged. Both runtimes are faked here.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

import factory.chain.handlers as handlers_module
import factory.claude_session.run as claude_run_module
import factory.runner as runner_module
from factory.app_config import AppConfig, AppGatesConfig
from factory.chain import orchestrator as orch
from factory.chain import solo
from factory.chain.handlers import get_story, handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True)


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    stories = tmp_path / "apps" / "sacrifice" / "stories"
    stories.mkdir(parents=True, exist_ok=True)
    (stories / "1-x.md").write_text("# story\n", encoding="utf-8")
    repo = tmp_path / "sacrifice"
    repo.mkdir()
    _git(repo, "init", "-q", "--initial-branch=main")
    _git(repo, "config", "user.email", "t@e.x")
    _git(repo, "config", "user.name", "T E")
    (repo / "README.md").write_text("# init\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "init")
    return tmp_path


def _app(root: Path) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(root / "sacrifice"),
        gates=AppGatesConfig(),
    )


def _story(root: Path, **kw: Any) -> StoryRecord:
    fields: dict[str, Any] = {
        "direction_id": "099",
        "app": "sacrifice",
        "title": "t",
        "slug": "z",
        "scope": "backend",
        "state": StoryState.SM_DONE.value,
        "github_issue_number": 1,
        "story_file_path": "stories/1-x.md",
        "pipeline": "solo",
        "runtime": "claude_session",
        "runtime_model": "claude-opus-x",
    }
    fields.update(kw)
    return persist_story(StoryRecord(**fields), root / "state" / "factory.db")


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {"claude": None, "sandbox": None}

    def _claude(**kwargs: Any) -> RunResult:
        seen["claude"] = kwargs
        return RunResult(
            success=True,
            files_changed=["src/x.py"],
            test_run_passed=True,
            summary="green",
            gate_rounds=[{"round": 1, "passed": True, "reason": "green"}],
            gate_stop_reason="green",
        )

    async def _sandbox(*args: Any, **kwargs: Any) -> RunResult:
        seen["sandbox"] = kwargs
        return RunResult(success=True, files_changed=["a"], test_run_passed=True, summary="ok")

    monkeypatch.setattr(claude_run_module, "claude_dev_run", _claude)
    monkeypatch.setattr(runner_module, "sandbox_run", _sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")
    return seen


def test_solo_claude_story_runs_claude_code_with_the_solo_loop(
    temp_root: Path, fakes: dict[str, Any]
) -> None:
    db = temp_root / "state" / "factory.db"
    story = _story(temp_root)
    handle_dev(story, _app(temp_root), temp_root, dry_run=False, db_path=db)

    assert fakes["sandbox"] is None
    kw = fakes["claude"]
    assert kw["model"] == "claude-opus-x"
    assert kw["wall_clock_timeout_s"] == solo.SOLO_DEV_WALL_CLOCK_S == 5400
    assert kw["max_gate_rounds"] == solo.SOLO_MAX_GATE_ROUNDS
    assert callable(kw["gate_check"]) and "reuse existing code" in kw["brief_addendum"]
    after = get_story(story.id or 0, db)
    assert after is not None and after.state == StoryState.TESTS_GREEN.value
    assert orch._dispatch_for_story(after) == "tech_writer"


def test_chain_claude_story_only_swaps_the_dev(temp_root: Path, fakes: dict[str, Any]) -> None:
    db = temp_root / "state" / "factory.db"
    story = _story(temp_root, pipeline="chain")
    handle_dev(story, _app(temp_root), temp_root, dry_run=False, db_path=db)
    kw = fakes["claude"]
    assert fakes["sandbox"] is None
    assert "gate_check" not in kw and kw["wall_clock_timeout_s"] == 1800
    after = get_story(story.id or 0, db)
    assert after is not None and orch._dispatch_for_story(after) == "review"


def test_api_story_still_uses_openhands(temp_root: Path, fakes: dict[str, Any]) -> None:
    db = temp_root / "state" / "factory.db"
    story = _story(temp_root, runtime="api", runtime_model=None)
    handle_dev(story, _app(temp_root), temp_root, dry_run=False, db_path=db)
    assert fakes["claude"] is None and fakes["sandbox"] is not None
