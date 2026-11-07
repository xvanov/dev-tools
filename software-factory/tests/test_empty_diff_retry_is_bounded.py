"""The empty-diff dev-retry route must TERMINATE. It did not.

`handle_review` sends an empty diff back to dev instead of blocking terminally
when the retry budget remains (added so `conan-io__conan-19750` would stop losing
four unused retries). Its own comment claimed "the review-cycle cap and the
stability guard still bound it".

**Neither did.** `story.dev_retries` is incremented only on the RED dev path, and
a story only reaches `handle_review` via `EVENT_DEV_TESTS_GREEN` — so a dev run
that goes green while changing nothing leaves `dev_retries` at 0, and
`0 + 1 < 4` is true forever. An adversarial review reproduced **12 unbounded
cycles**:

    reviewer_in_progress --request_changes--> reviewer_requested_changes
      --dev--> dev_in_progress --tests_green--> reviewer_in_progress --> ...

one dev sandbox run per cycle (live median 644 s, ~$0.35), until
`per_story_spend_usd: 12.0` trips into `BLOCKED_BUDGET_EXCEEDED` — a sink
`factory resume` REFUSES, and which emits no `factory_needs_redesign` event at
all. Strictly worse than the single terminal block it replaced.

The trigger was already in the tree: direction 126 asks for a password reset that
`sacrifice/backend/app/routes/auth.py` already implements.

**Why the existing suite missed it:** `test_empty_diff_with_retry_headroom_goes_
back_to_dev` calls `handle_review` exactly ONCE. A loop is invisible to a
single-shot test, so every test here drives the cycle REPEATEDLY.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain.branch import feature_branch_name
from factory.chain.handlers import (
    _MAX_REVIEW_CYCLES,
    _dev_produced_empty_diff,
    _max_dev_retries,
    handle_review,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState
from tests.test_empty_diff_short_circuit import (  # reuse the real git topology
    _ONE_GREEN_ATTEMPT,
    _init_repo_with_origin,
    _story_file,
)


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    # Same layout the sibling suite builds: `_story_file` writes into
    # apps/sacrifice/stories/, so the directory has to exist first.
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _mk(root: Path, *, dev_retries: int = 0) -> StoryRecord:
    story = StoryRecord(
        direction_id="126",
        app="sacrifice",
        title="Add email verification and password reset",
        slug="empty-loop-story",
        scope="backend",
        state=StoryState.TESTS_GREEN.value,
        github_issue_number=1,
        story_file_path=_story_file(root, "empty-loop-story"),
        github_branch=feature_branch_name(1, "empty-loop-story"),
        # THE CONDITION THAT MADE IT UNBOUNDED: a green dev run never bumps this.
        dev_retries=dev_retries,
        dev_attempts_json=json.dumps(_ONE_GREEN_ATTEMPT),
    )
    return persist_story(story, root / "state" / "factory.db")


def _no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    def _must_not_be_called(**_kw: Any) -> Any:
        raise AssertionError("the reviewer LLM must never run on an empty diff")

    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", _must_not_be_called)


def test_the_cycle_terminates_and_does_not_run_forever(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE REGRESSION, driven the way the chain drives it.

    Each iteration is one real round trip: the reviewer sends it back, the dev
    goes green again without changing anything (`dev_retries` stays 0), and the
    reviewer runs again. Under the first cut this never left
    `reviewer_requested_changes`.
    """
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    cfg = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main"
    )
    story = _mk(temp_root)
    db = temp_root / "state" / "factory.db"
    _no_llm(monkeypatch)
    assert _dev_produced_empty_diff(story, cfg, temp_root) is True

    states: list[str] = []
    for _ in range(12):  # the reproduced loop ran at least this long
        result = handle_review(story, cfg, temp_root, dry_run=False, db_path=db)
        states.append(result.next_state.value)
        if result.next_state is StoryState.BLOCKED_REVIEW_NONCONVERGENT:
            break
        # The dev round trip: green again, nothing changed. dev_retries UNCHANGED —
        # that is precisely why the old guard never tripped.
        assert story.dev_retries == 0, "a green dev run must not bump dev_retries"
        story.state = StoryState.TESTS_GREEN.value
        persist_story(story, db)

    assert StoryState.BLOCKED_REVIEW_NONCONVERGENT.value in states, (
        f"the cycle never terminated in 12 iterations: {states}"
    )
    assert len(states) <= _MAX_REVIEW_CYCLES + 1, (
        f"terminated, but only after {len(states)} cycles; the cap is "
        f"{_MAX_REVIEW_CYCLES}: {states}"
    )


def test_each_round_trip_counts_a_review_cycle(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The counter is what bounds it, so it must actually move. It stayed 0."""
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    cfg = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main"
    )
    story = _mk(temp_root)
    db = temp_root / "state" / "factory.db"
    _no_llm(monkeypatch)

    handle_review(story, cfg, temp_root, dry_run=False, db_path=db)
    assert story.reviewer_cycles == 1, "an empty-diff round trip is a review cycle"


def test_the_terminal_block_still_carries_its_actionable_event(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What the unbounded loop cost: `BLOCKED_BUDGET_EXCEEDED` emits no
    `factory_needs_redesign` and `factory resume` refuses it. Reaching the
    nonconvergence sink instead keeps the operator's path back."""
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    cfg = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main"
    )
    # Budget already spent: the terminal branch, unchanged by this fix.
    story = _mk(temp_root, dev_retries=_max_dev_retries(temp_root))
    db = temp_root / "state" / "factory.db"
    _no_llm(monkeypatch)

    events: list[str] = []
    import factory.chain.handlers as h

    real = h.log_story_event
    monkeypatch.setattr(
        h,
        "log_story_event",
        lambda sid, ev, payload, **kw: (events.append(ev), real(sid, ev, payload, **kw))[1],
    )
    result = handle_review(story, cfg, temp_root, dry_run=False, db_path=db)
    assert result.next_state is StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert "factory_needs_redesign" in events


def test_the_reviewer_llm_is_never_called_on_any_cycle(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The original point of the short-circuit. `_no_llm` raises if it is, so
    reaching the end of the loop is the assertion."""
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    cfg = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main"
    )
    story = _mk(temp_root)
    db = temp_root / "state" / "factory.db"
    _no_llm(monkeypatch)
    for _ in range(_MAX_REVIEW_CYCLES + 1):
        r = handle_review(story, cfg, temp_root, dry_run=False, db_path=db)
        if r.next_state is StoryState.BLOCKED_REVIEW_NONCONVERGENT:
            break
        story.state = StoryState.TESTS_GREEN.value
        persist_story(story, db)


def test_the_guard_names_both_budgets() -> None:
    """Pin the shape: gating on `dev_retries` ALONE is the bug, because a green
    dev run never increments it."""
    import inspect

    src = inspect.getsource(handle_review)
    i = src.index("empty_diff is True")
    window = src[i : i + 400]
    assert "story.reviewer_cycles + 1 < _MAX_REVIEW_CYCLES" in window
    assert "_max_dev_retries(" in window
