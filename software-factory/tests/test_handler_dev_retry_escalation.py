"""Tests for ``factory.chain.handlers.handle_dev`` retry + escalation logic."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.app_config import AppConfig
from factory.chain.handlers import handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def app_config() -> AppConfig:
    return AppConfig(name="sacrifice", repo="x/y")


def _story_at_tests_red(root: Path) -> StoryRecord:
    db = root / "state" / "factory.db"
    return persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="t",
            scope="backend",
            state=StoryState.SM_DONE.value,
        ),
        db,
    )


def test_dry_run_happy_path_first_try_green(temp_root: Path, app_config: AppConfig) -> None:
    s = _story_at_tests_red(temp_root)
    db = temp_root / "state" / "factory.db"
    result = handle_dev(s, app_config, temp_root, dry_run=True, db_path=db)
    assert result.next_state == StoryState.TESTS_GREEN
    assert s.dev_retries == 0
    assert s.current_model_tier == "standard"


def test_first_failure_increments_retry_and_escalates_tier(
    temp_root: Path, app_config: AppConfig
) -> None:
    s = _story_at_tests_red(temp_root)
    db = temp_root / "state" / "factory.db"
    result = handle_dev(s, app_config, temp_root, dry_run=True, db_path=db, force_red=True)

    assert result.next_state == StoryState.DEV_RETRY
    assert s.dev_retries == 1
    # First failure must escalate standard -> hard.
    assert s.current_model_tier == "hard"


def test_retries_exhaust_to_blocked(temp_root: Path, app_config: AppConfig) -> None:
    """After ``_MAX_DEV_RETRIES`` failures, the chain BLOCKs the story for
    human review. Imports the live constant so test tracks bumps to the
    retry budget automatically (was 3, now 10)."""
    from factory.chain.handlers import _MAX_DEV_RETRIES

    s = _story_at_tests_red(temp_root)
    db = temp_root / "state" / "factory.db"

    # Drive the retry loop to one short of the cap; every iteration must
    # return DEV_RETRY because we still have budget left.
    for i in range(1, _MAX_DEV_RETRIES):
        result = handle_dev(s, app_config, temp_root, dry_run=True, db_path=db, force_red=True)
        assert result.next_state == StoryState.DEV_RETRY, f"iteration {i} should still retry"
        assert s.dev_retries == i

    # The exhausting failure: at retries==_MAX_DEV_RETRIES the handler
    # emits EVENT_DEV_EXHAUSTED -> BLOCKED_TESTS_NEED_CLARIFICATION.
    result_final = handle_dev(s, app_config, temp_root, dry_run=True, db_path=db, force_red=True)
    assert result_final.next_state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
    assert s.dev_retries == _MAX_DEV_RETRIES
    assert s.error and "exhausted" in s.error
    assert result_final.error and "exhausted" in result_final.error
