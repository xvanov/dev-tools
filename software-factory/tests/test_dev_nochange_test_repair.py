"""Dev-made-no-progress is a normal retry (Loop-4, dev-owns-tests).

Pre-Loop-4 a zero-change red run was routed to a separate test-repair loop on
the theory that only the test author could fix a contradictory test. With the
dev now owning BOTH code and tests, that separate author is gone: a zero-change
red run is simply a failed attempt that consumes a dev retry like any other.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.event_log import read_story_events
from factory.chain.handlers import handle_dev, persist_story
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


def _story(root: Path) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None, direction_id="099", app="myapp", title="t", slug="z",
            scope="backend", state=StoryState.SM_DONE.value,
            github_issue_number=1, story_file_path="stories/1-x.md",
        ),
        root / "state" / "factory.db",
    )


def _nochange_sandbox(diagnosis: str = "The 404 and 501 tests assert different results for the SAME nonexistent id — mutually exclusive."):
    async def _fake(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True,                # the run itself worked...
            files_changed=[],            # ...but dev changed nothing
            test_run_passed=False,       # ...and tests stayed red
            tokens_in=1500, tokens_out=600, cost_usd=0.05,
            error="tests not green after run",
            summary="1 failed, 90 passed",
            self_summary=diagnosis,
        )
    return _fake


def test_nochange_red_is_a_normal_retry(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Loop-4 (dev-owns-tests): a red run where dev changed nothing is no longer
    routed to a separate test-repair loop — there is no separate test author.
    It is simply a failed attempt and consumes a dev retry, exactly like a red
    run that DID change code. The dev owns the tests and fixes them next time.
    """
    story = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    monkeypatch.setattr(runner_module, "sandbox_run", _nochange_sandbox(), raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state is StoryState.DEV_RETRY
    assert story.dev_retries == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    # The obsolete test-repair routing must not fire.
    assert not [e for e in events if e.get("event") == "dev_nochange_test_repair"]


def test_dev_with_real_changes_still_uses_normal_retry(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A red run where dev DID change code is a normal retry, not test-repair."""
    story = _story(temp_root)
    db = temp_root / "state" / "factory.db"

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True, files_changed=["src/x.py"], test_run_passed=False,
            tokens_in=1500, tokens_out=600, cost_usd=0.05,
            error="tests not green after run", summary="AssertionError",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state is StoryState.DEV_RETRY
    assert story.dev_retries == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "dev_nochange_test_repair"]
