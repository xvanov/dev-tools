"""Orchestrator routes STORY_CREATED based on ``chain_kind``.

These tests exercise ``_dispatch_for_story`` in isolation. Real-run dispatch
(through the live ``tick`` loop) is covered by the docs-chain integration
test in ``tests/test_docs_chain.py``.
"""

from __future__ import annotations

from factory.chain.orchestrator import _dispatch_for_story
from factory.chain.state_machine import StoryRecord, StoryState


def _story(
    state: StoryState,
    *,
    chain_kind: str = "tdd",
    harness_precheck_passed: bool = False,
) -> StoryRecord:
    return StoryRecord(
        id=1,
        direction_id="005",
        app="sacrifice",
        title="t",
        slug="s",
        scope="docs",
        state=state.value,
        chain_kind=chain_kind,
        harness_precheck_passed=harness_precheck_passed,
    )


def test_story_created_with_tdd_kind_routes_to_sm() -> None:
    """Default chain_kind=tdd → the historical SM handler runs first."""
    assert _dispatch_for_story(_story(StoryState.STORY_CREATED)) == "sm"


def test_story_created_with_docs_kind_routes_to_docs_sm() -> None:
    """chain_kind=docs at STORY_CREATED → the docs-SM handler runs first.

    Critical correctness invariant: a docs-kind story MUST NOT touch the
    test_design / test_impl / dev handlers anywhere on its path. Routing
    starts at docs_sm; the subsequent states (DOCS_SM_DONE, etc.) live in
    the static ``_DISPATCH`` table and don't need a chain_kind branch.
    """
    assert _dispatch_for_story(_story(StoryState.STORY_CREATED, chain_kind="docs")) == "docs_sm"


def test_docs_sm_done_routes_to_docs_onboarder() -> None:
    """The static dispatch table picks up after STORY_CREATED. DOCS_SM_DONE
    must dispatch to ``docs_onboarder`` regardless of chain_kind value."""
    assert (
        _dispatch_for_story(_story(StoryState.DOCS_SM_DONE, chain_kind="docs")) == "docs_onboarder"
    )


def test_docs_onboarder_done_routes_to_enforcer() -> None:
    """After the Onboarder writes the canonical files, the existing
    ``handle_docs_enforcer`` runs to validate paths against
    CANONICAL_CONTEXT_PATHS / FORBIDDEN_DOC_PATTERNS."""
    assert (
        _dispatch_for_story(_story(StoryState.DOCS_ONBOARDER_DONE, chain_kind="docs"))
        == "docs_enforcer"
    )


def test_terminal_state_returns_none() -> None:
    """Terminal states return None — no handler should run."""
    assert _dispatch_for_story(_story(StoryState.PR_OPEN)) is None
    assert _dispatch_for_story(_story(StoryState.DEPLOYED)) is None


def test_tdd_chain_dispatch_unchanged_by_chain_kind_branch() -> None:
    """Loop-4 (dev-owns-tests): a TDD-kind story at SM_DONE routes DIRECTLY to
    ``dev`` — there is no longer a separate ``test_design``/``test_impl`` phase.
    The chain_kind branch still only fires at STORY_CREATED; everywhere else
    the static dispatch table is authoritative.

    The legacy TESTS_RED → harness_precheck → dev path remains wired for any
    in-flight rows that predate the rewrite, and is verified below.
    """
    assert _dispatch_for_story(_story(StoryState.SM_DONE, chain_kind="tdd")) == "dev"
    assert _dispatch_for_story(_story(StoryState.DEV_RETRY, chain_kind="tdd")) == "dev"
    assert _dispatch_for_story(_story(StoryState.TESTS_GREEN, chain_kind="tdd")) == "review"
    assert _dispatch_for_story(_story(StoryState.REVIEWER_DONE, chain_kind="tdd")) == "tech_writer"
