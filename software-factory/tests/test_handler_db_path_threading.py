"""Run-ledger isolation: handlers must thread db_path into text_run/sandbox_run.

Regression test for the 2026-07-17 bench leak: handle_dev/handle_sm/
handle_review passed db_path to persist_story but NOT to the runner, so LLM
cost rows fell back to the production ``state/factory.db``
(runner._DEFAULT_DB_PATH) even when the caller supplied an isolated db.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import handle_dev, handle_review, persist_story
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
        name="myapp",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(temp_root / "myapp"),
    )


def _story(temp_root: Path, state: StoryState) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="099",
            app="myapp",
            title="t",
            slug="z",
            scope="backend",
            state=state.value,
            github_issue_number=1,
            story_file_path="stories/1-x.md",
        ),
        temp_root / "state" / "factory.db",
    )


def test_handle_dev_threads_db_path_to_sandbox_run(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    story = _story(temp_root, StoryState.SM_DONE)
    custom_db = temp_root / "state" / "factory.db"
    seen: dict[str, Any] = {}

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        seen.update(kwargs)
        return RunResult(success=True, test_run_passed=True, summary="green",
                         cost_usd=0.01, tokens_out=10)

    monkeypatch.setattr(runner_module, "sandbox_run", _fake, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=custom_db)

    assert seen.get("db_path") == custom_db


def test_handle_review_threads_db_path_to_text_run(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    story = _story(temp_root, StoryState.TESTS_GREEN)
    custom_db = temp_root / "state" / "factory.db"
    seen: dict[str, Any] = {}

    def _fake_text_run(*args: object, **kwargs: object) -> str:
        seen.update(kwargs)
        return json.dumps({"verdict": "approve", "test_quality_score": 0.9,
                           "findings": [], "test_quality_findings": [],
                           "comments_to_post": [], "summary": "ok"})

    monkeypatch.setattr(runner_module, "text_run", _fake_text_run, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")
    monkeypatch.setattr(
        handlers_module, "_fetch_pr_diff_for_review", lambda *a, **kw: "diff --git a b"
    )
    monkeypatch.setattr(
        handlers_module, "_fetch_latest_test_output", lambda *a, **kw: "1 passed"
    )
    monkeypatch.setattr(handlers_module, "_slop_findings_for_story", lambda *a, **kw: [])

    handle_review(story, app_config, temp_root, dry_run=False, db_path=custom_db)

    assert seen.get("db_path") == custom_db
