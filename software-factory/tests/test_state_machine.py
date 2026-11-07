"""Tests for ``factory.chain.state_machine``.

The state machine is the spine of the TDD chain. Wrong transitions = work
gets stuck or skips a step. These tests assert the happy path AND every
slop/retry/error edge.
"""

from __future__ import annotations

import pytest

from factory.chain.state_machine import (
    EVENT_DEV_EXHAUSTED,
    EVENT_DEV_STARTED,
    EVENT_DEV_TESTS_GREEN,
    EVENT_DEV_TESTS_RED,
    EVENT_DOCS_ENFORCER_CHECK,
    EVENT_DOCS_ENFORCER_FAIL,
    EVENT_DOCS_ENFORCER_PASS,
    EVENT_REVIEWER_APPROVE,
    EVENT_REVIEWER_REQUEST_CHANGES,
    EVENT_REVIEWER_STARTED,
    EVENT_SM_DONE,
    EVENT_SM_STARTED,
    EVENT_TECH_WRITER_DONE,
    EVENT_TECH_WRITER_STARTED,
    IllegalTransitionError,
    StoryRecord,
    StoryState,
    advance,
    list_transitions_from,
)


def _story(state: StoryState = StoryState.STORY_CREATED) -> StoryRecord:
    """Build a minimal StoryRecord for state-machine testing."""
    return StoryRecord(
        direction_id="002",
        app="sacrifice",
        title="t",
        slug="t",
        scope="backend",
        state=state.value,
    )


def test_happy_path_advances_through_every_state() -> None:
    """Loop-4 happy path: created -> sm -> dev -> review -> tech_writer ->
    docs_enforcer -> pr_open. No separate test_design/test_impl phase."""
    s = _story()
    s.state = advance(s, EVENT_SM_STARTED).value
    assert s.state == StoryState.SM_IN_PROGRESS.value
    s.state = advance(s, EVENT_SM_DONE).value
    assert s.state == StoryState.SM_DONE.value
    # SM_DONE dispatches dev DIRECTLY — dev writes code + tests.
    s.state = advance(s, EVENT_DEV_STARTED).value
    assert s.state == StoryState.DEV_IN_PROGRESS.value
    s.state = advance(s, EVENT_DEV_TESTS_GREEN).value
    assert s.state == StoryState.TESTS_GREEN.value
    s.state = advance(s, EVENT_REVIEWER_STARTED).value
    assert s.state == StoryState.REVIEWER_IN_PROGRESS.value
    s.state = advance(s, EVENT_REVIEWER_APPROVE).value
    assert s.state == StoryState.REVIEWER_DONE.value
    s.state = advance(s, EVENT_TECH_WRITER_STARTED).value
    assert s.state == StoryState.TECH_WRITER_IN_PROGRESS.value
    s.state = advance(s, EVENT_TECH_WRITER_DONE).value
    assert s.state == StoryState.TECH_WRITER_DONE.value
    s.state = advance(s, EVENT_DOCS_ENFORCER_CHECK).value
    assert s.state == StoryState.DOCS_ENFORCER_CHECK.value
    s.state = advance(s, EVENT_DOCS_ENFORCER_PASS).value
    assert s.state == StoryState.PR_OPEN.value


def test_pr_unmergeable_sinks_to_blocked_deploy_failed() -> None:
    """Auto-merge giving up on a terminally un-mergeable PR routes the story
    from any mergeable state to BLOCKED_DEPLOY_FAILED so it stops being
    retried every tick."""
    from factory.chain.state_machine import EVENT_PR_UNMERGEABLE

    for src in (StoryState.PR_OPEN, StoryState.CI_GREEN, StoryState.READY_FOR_MERGE):
        s = _story(src)
        assert advance(s, EVENT_PR_UNMERGEABLE) == StoryState.BLOCKED_DEPLOY_FAILED


def test_dev_retry_loops_then_exhausts() -> None:
    """Dev failure path: DEV_IN_PROGRESS -> DEV_RETRY -> DEV_IN_PROGRESS until exhausted."""
    s = _story(StoryState.DEV_IN_PROGRESS)
    # Tests still red after a dev run.
    s.state = advance(s, EVENT_DEV_TESTS_RED).value
    assert s.state == StoryState.DEV_RETRY.value
    # Try again.
    s.state = advance(s, EVENT_DEV_STARTED).value
    assert s.state == StoryState.DEV_IN_PROGRESS.value
    # And again red.
    s.state = advance(s, EVENT_DEV_TESTS_RED).value
    assert s.state == StoryState.DEV_RETRY.value
    # After max retries, the handler emits EVENT_DEV_EXHAUSTED.
    s.state = advance(s, EVENT_DEV_EXHAUSTED).value
    assert s.state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value


def test_reviewer_request_changes_loops_back_to_dev() -> None:
    s = _story(StoryState.REVIEWER_IN_PROGRESS)
    s.state = advance(s, EVENT_REVIEWER_REQUEST_CHANGES).value
    assert s.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    s.state = advance(s, EVENT_DEV_STARTED).value
    assert s.state == StoryState.DEV_IN_PROGRESS.value


def test_docs_enforcer_fail_loops_back_for_fix() -> None:
    s = _story(StoryState.DOCS_ENFORCER_CHECK)
    s.state = advance(s, EVENT_DOCS_ENFORCER_FAIL).value
    assert s.state == StoryState.REVIEWER_REQUESTED_CHANGES.value


def test_illegal_transition_raises() -> None:
    """An event not in the transition table for the current state raises."""
    s = _story(StoryState.STORY_CREATED)
    with pytest.raises(IllegalTransitionError):
        advance(s, EVENT_DEV_TESTS_GREEN)


def test_list_transitions_from_story_created() -> None:
    """STORY_CREATED has THREE outgoing edges: the TDD start (SM_STARTED),
    the docs-chain start (DOCS_SM_STARTED) — which one of those fires is
    decided by the orchestrator based on ``story.chain_kind`` — and the
    WS1.1 per-story budget breaker (BUDGET_EXCEEDED) which the orchestrator
    fires pre-dispatch when the story's aggregate attempts/spend cross the
    per-story cap."""
    edges = set(list_transitions_from(StoryState.STORY_CREATED))
    assert (EVENT_SM_STARTED, StoryState.SM_IN_PROGRESS) in edges
    # Imported here to keep the existing import list focused on TDD events.
    from factory.chain.state_machine import EVENT_BUDGET_EXCEEDED, EVENT_DOCS_SM_STARTED

    assert (EVENT_DOCS_SM_STARTED, StoryState.DOCS_SM_IN_PROGRESS) in edges
    assert (EVENT_BUDGET_EXCEEDED, StoryState.BLOCKED_BUDGET_EXCEEDED) in edges
    assert len(edges) == 3


def test_sm_in_progress_transitions_to_sm_done() -> None:
    s = _story(StoryState.SM_IN_PROGRESS)
    assert advance(s, EVENT_SM_DONE) == StoryState.SM_DONE


def test_sm_done_transitions_to_dev_in_progress() -> None:
    """Loop-4: SM_DONE dispatches dev directly (no test_design phase)."""
    s = _story(StoryState.SM_DONE)
    assert advance(s, EVENT_DEV_STARTED) == StoryState.DEV_IN_PROGRESS


def test_blocked_state_has_no_outgoing_transitions() -> None:
    """BLOCKED is terminal for the chain — only human intervention unsticks it."""
    edges = list_transitions_from(StoryState.BLOCKED_TESTS_NEED_CLARIFICATION)
    assert edges == []


def test_advance_does_not_mutate_story() -> None:
    """``advance`` is pure — the caller is responsible for persisting the new state."""
    s = _story(StoryState.STORY_CREATED)
    next_state = advance(s, EVENT_SM_STARTED)
    assert s.state == StoryState.STORY_CREATED.value  # unchanged
    assert next_state == StoryState.SM_IN_PROGRESS


# --------------------------------------------------------------------------- #
# Docs chain transitions
# --------------------------------------------------------------------------- #


def test_docs_chain_full_path_to_pr_open() -> None:
    """Walk the docs chain from STORY_CREATED to PR_OPEN.

    The docs path is intentionally shorter than the TDD pipeline: docs_sm →
    onboarder → enforcer → PR. We replay each transition explicitly to
    guard against accidentally re-routing a docs story through test_design.
    """
    from factory.chain.state_machine import (
        EVENT_DOCS_ENFORCER_CHECK,
        EVENT_DOCS_ENFORCER_PASS,
        EVENT_DOCS_ONBOARDER_DONE,
        EVENT_DOCS_ONBOARDER_STARTED,
        EVENT_DOCS_SM_DONE,
        EVENT_DOCS_SM_STARTED,
    )

    s = _story(StoryState.STORY_CREATED)

    s.state = advance(s, EVENT_DOCS_SM_STARTED).value
    assert s.state == StoryState.DOCS_SM_IN_PROGRESS.value

    s.state = advance(s, EVENT_DOCS_SM_DONE).value
    assert s.state == StoryState.DOCS_SM_DONE.value

    s.state = advance(s, EVENT_DOCS_ONBOARDER_STARTED).value
    assert s.state == StoryState.DOCS_ONBOARDER_IN_PROGRESS.value

    s.state = advance(s, EVENT_DOCS_ONBOARDER_DONE).value
    assert s.state == StoryState.DOCS_ONBOARDER_DONE.value

    s.state = advance(s, EVENT_DOCS_ENFORCER_CHECK).value
    assert s.state == StoryState.DOCS_ENFORCER_CHECK.value

    s.state = advance(s, EVENT_DOCS_ENFORCER_PASS).value
    assert s.state == StoryState.PR_OPEN.value


def test_docs_chain_cannot_cross_into_tdd_states() -> None:
    """Once in DOCS_SM_DONE, the code-chain events must be rejected.

    The docs chain skips the code+test loop entirely; sending a docs story the
    ``EVENT_DEV_STARTED`` event would be a chain bug. ``advance`` must raise
    ``IllegalTransitionError`` instead of silently transitioning.
    """
    s = _story(StoryState.DOCS_SM_DONE)
    with pytest.raises(IllegalTransitionError):
        advance(s, EVENT_DEV_STARTED)


def test_docs_onboarder_failure_routes_to_blocked() -> None:
    """If the Onboarder produces no files (or crashes), the docs chain must
    go to the existing BLOCKED_TESTS_NEED_CLARIFICATION terminal — the same
    place TDD lands when dev exhausts retries. Operators have one place to
    look for stuck stories regardless of chain variant."""
    from factory.chain.state_machine import EVENT_DOCS_ONBOARDER_FAILED

    s = _story(StoryState.DOCS_ONBOARDER_IN_PROGRESS)
    assert advance(s, EVENT_DOCS_ONBOARDER_FAILED) == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
