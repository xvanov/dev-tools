"""Tests for ``factory.webhook.github._handle_pull_request_review``.

Covers:

  * ``approved`` review on a story at TESTS_GREEN -> story advances
    through REVIEWER_IN_PROGRESS -> REVIEWER_DONE.
  * ``changes_requested`` review on a story at REVIEWER_IN_PROGRESS ->
    story transitions to REVIEWER_REQUESTED_CHANGES.
  * Review on an unmatched PR number returns acted=False.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from sqlmodel import Session, create_engine, select

from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState


def _reload_webhook(temp_root: Path) -> object:
    """Re-import ``factory.webhook.github`` with ``_FACTORY_ROOT`` pinned to
    ``temp_root`` so the webhook handler reads/writes the throwaway DB."""
    import factory.webhook.github as gh

    importlib.reload(gh)
    gh._FACTORY_ROOT = temp_root  # type: ignore[attr-defined]
    return gh


@pytest.fixture
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FACTORY_WEBHOOK_LAZY", "1")  # don't boot FastAPI on import
    return tmp_path


def _make_story(temp_root: Path, *, pr_number: int, state: StoryState) -> StoryRecord:
    db = temp_root / "state" / "factory.db"
    return persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="t",
            scope="backend",
            state=state.value,
            github_pr_number=pr_number,
        ),
        db,
    )


def _payload(pr_number: int, review_state: str) -> dict:
    return {
        "action": "submitted",
        "review": {"state": review_state, "user": {"login": "alice"}},
        "pull_request": {"number": pr_number},
    }


def test_approved_advances_story_through_reviewer_done(temp_root: Path) -> None:
    _make_story(temp_root, pr_number=42, state=StoryState.TESTS_GREEN)
    gh = _reload_webhook(temp_root)
    result = gh._handle_pull_request_review(_payload(42, "approved"))  # type: ignore[attr-defined]

    assert result["acted"] is True
    assert result["transitioned_to"] == StoryState.REVIEWER_DONE.value

    db = temp_root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as s:
        story = s.exec(select(StoryRecord).where(StoryRecord.github_pr_number == 42)).first()
    assert story is not None
    assert story.state == StoryState.REVIEWER_DONE.value


def test_changes_requested_transitions_to_reviewer_requested_changes(temp_root: Path) -> None:
    _make_story(temp_root, pr_number=43, state=StoryState.REVIEWER_IN_PROGRESS)
    gh = _reload_webhook(temp_root)
    result = gh._handle_pull_request_review(_payload(43, "changes_requested"))  # type: ignore[attr-defined]

    assert result["acted"] is True
    assert result["transitioned_to"] == StoryState.REVIEWER_REQUESTED_CHANGES.value

    db = temp_root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as s:
        story = s.exec(select(StoryRecord).where(StoryRecord.github_pr_number == 43)).first()
    assert story is not None
    assert story.state == StoryState.REVIEWER_REQUESTED_CHANGES.value


def test_unknown_pr_returns_acted_false(temp_root: Path) -> None:
    gh = _reload_webhook(temp_root)
    result = gh._handle_pull_request_review(_payload(9999, "approved"))  # type: ignore[attr-defined]
    assert result["acted"] is False
    assert "no story matched PR" in result["reason"]


def test_non_submitted_action_is_ignored(temp_root: Path) -> None:
    gh = _reload_webhook(temp_root)
    result = gh._handle_pull_request_review(  # type: ignore[attr-defined]
        {"action": "dismissed", "review": {"state": "approved"}, "pull_request": {"number": 42}}
    )
    assert result["acted"] is False


def test_dispatch_event_routes_pr_review(temp_root: Path) -> None:
    """The pure dispatcher should route ``pull_request_review`` to the handler."""
    _make_story(temp_root, pr_number=88, state=StoryState.TESTS_GREEN)
    gh = _reload_webhook(temp_root)
    result = gh.dispatch_event("pull_request_review", _payload(88, "approved"))
    assert result["acted"] is True
    assert result["transitioned_to"] == StoryState.REVIEWER_DONE.value
