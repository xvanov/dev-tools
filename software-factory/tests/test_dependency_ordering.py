"""Tests for direction-internal dependency ordering (_direction_deps_pending)."""

from __future__ import annotations

from pathlib import Path

from sqlmodel import SQLModel, create_engine

from factory.chain.handlers import persist_story
from factory.chain.orchestrator import _direction_deps_pending
from factory.chain.state_machine import StoryRecord, StoryState


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}"))
    return db


def _story(
    db: Path,
    *,
    sid: int,
    direction: str,
    state: str,
    app: str = "sacrifice",
    slug: str | None = None,
) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=sid,
            direction_id=direction,
            app=app,
            title="t",
            slug=slug or f"s{sid}",
            scope="backend",
            state=state,
        ),
        db,
    )


def test_foundational_story_has_no_pending_deps(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s14 = _story(db, sid=14, direction="008", state=StoryState.SM_DONE.value)
    assert _direction_deps_pending(db, s14) == []


def test_dependent_waits_for_undeployed_lower_siblings(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state=StoryState.SM_DONE.value)  # not deployed
    _story(db, sid=16, direction="008", state=StoryState.DEPLOYED.value)  # deployed
    s18 = _story(db, sid=18, direction="008", state=StoryState.SM_DONE.value)
    # 14 (not deployed) blocks; 16 (deployed) does not.
    assert _direction_deps_pending(db, s18) == [14]


def test_ready_when_all_lower_siblings_deployed(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state=StoryState.DEPLOYED.value)
    _story(db, sid=16, direction="008", state=StoryState.DEPLOYED.value)
    s18 = _story(db, sid=18, direction="008", state=StoryState.SM_DONE.value)
    assert _direction_deps_pending(db, s18) == []


def test_cross_direction_does_not_block(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, sid=5, direction="007", state=StoryState.SM_DONE.value)  # other direction
    s14 = _story(db, sid=14, direction="008", state=StoryState.SM_DONE.value)
    assert _direction_deps_pending(db, s14) == []


# --------------------------------------------------------------------------- #
# Dual-draft sibling exemption (issue #100) — alt-a / alt-b race independently
# --------------------------------------------------------------------------- #


def test_altb_not_blocked_by_dead_alta_sibling(tmp_path: Path) -> None:
    """alt-a parked in an alt-a-specific dead-end sink must NOT appear in alt-b's
    pending deps — the two are competing interpretations, not a serial chain."""
    db = _seed(tmp_path)
    # alt-a (lower id) is dead; alt-b (higher id) is untried.
    _story(
        db,
        sid=14,
        direction="008",
        state=StoryState.BLOCKED_CI_UNRESOLVED.value,
        slug="feature-x-alt-a",
    )
    s15 = _story(
        db, sid=15, direction="008", state=StoryState.SM_DONE.value, slug="feature-x-alt-b"
    )
    assert _direction_deps_pending(db, s15) == []


def test_altb_not_deadlock_terminalized_by_dead_alta(tmp_path: Path) -> None:
    """Because the dead alt-a sibling is filtered out of alt-b's deps, alt-b has
    no pending deps at all — so the deadlock-terminalizer can never fire on it."""
    from factory.chain.orchestrator import _deps_permanently_dead

    db = _seed(tmp_path)
    _story(
        db,
        sid=14,
        direction="008",
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
        slug="feature-x-alt-a",
    )
    s15 = _story(
        db, sid=15, direction="008", state=StoryState.SM_DONE.value, slug="feature-x-alt-b"
    )
    deps = _direction_deps_pending(db, s15)
    assert deps == []
    assert _deps_permanently_dead(db, deps) is False


def test_altb_does_not_wait_on_alta_reaching_deployed(tmp_path: Path) -> None:
    """alt-b must not defer waiting for a live (not-yet-deployed) alt-a — an
    independently-shippable interpretation races without gating on its sibling."""
    db = _seed(tmp_path)
    _story(
        db, sid=14, direction="008", state=StoryState.PR_OPEN.value, slug="feature-x-alt-a"
    )  # live, undeployed
    s15 = _story(
        db, sid=15, direction="008", state=StoryState.SM_DONE.value, slug="feature-x-alt-b"
    )
    assert _direction_deps_pending(db, s15) == []


def test_non_dual_draft_lower_dep_still_blocks_an_alt(tmp_path: Path) -> None:
    """A real (non-alt) lower-id foundation still blocks a dual-draft story — only
    the alt<->alt edge is exempt, foundations-first is otherwise preserved."""
    db = _seed(tmp_path)
    _story(
        db, sid=13, direction="008", state=StoryState.SM_DONE.value, slug="foundation-model"
    )  # real foundation
    _story(
        db,
        sid=14,
        direction="008",
        state=StoryState.BLOCKED_CI_UNRESOLVED.value,
        slug="feature-x-alt-a",
    )
    s15 = _story(
        db, sid=15, direction="008", state=StoryState.SM_DONE.value, slug="feature-x-alt-b"
    )
    # 13 (non-alt foundation) still blocks; 14 (alt sibling) is exempt.
    assert _direction_deps_pending(db, s15) == [13]


def test_non_dual_draft_story_dep_ordering_unchanged(tmp_path: Path) -> None:
    """A non-alt higher-id dependent still waits on a non-alt lower-id sibling —
    the exemption is inert unless BOTH stories carry an alt-suffix."""
    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state=StoryState.SM_DONE.value)  # plain slug
    s16 = _story(db, sid=16, direction="008", state=StoryState.SM_DONE.value)
    assert _direction_deps_pending(db, s16) == [14]


# --------------------------------------------------------------------------- #
# _deps_permanently_dead — dependency-deadlock detection
# --------------------------------------------------------------------------- #


def test_deps_dead_true_when_all_pending_are_dead_end_sinks(tmp_path: Path) -> None:
    from factory.chain.orchestrator import _deps_permanently_dead

    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state=StoryState.BLOCKED_CI_UNRESOLVED.value)
    _story(db, sid=15, direction="008", state=StoryState.SUPERSEDED_BY_SIBLING.value)
    # both blocking deps are terminal, never-to-deploy -> deadlock
    assert _deps_permanently_dead(db, [14, 15]) is True


def test_deps_dead_false_when_any_pending_is_live(tmp_path: Path) -> None:
    from factory.chain.orchestrator import _deps_permanently_dead

    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state=StoryState.BLOCKED_CI_UNRESOLVED.value)
    _story(db, sid=15, direction="008", state=StoryState.SM_DONE.value)  # still live
    assert _deps_permanently_dead(db, [14, 15]) is False


def test_deps_dead_false_on_empty_or_missing(tmp_path: Path) -> None:
    from factory.chain.orchestrator import _deps_permanently_dead

    db = _seed(tmp_path)
    assert _deps_permanently_dead(db, []) is False
    assert _deps_permanently_dead(db, [999]) is False  # missing row -> not-dead (fail-safe)


def test_deps_dead_false_on_invalid_enum_dep_state(tmp_path: Path) -> None:
    from factory.chain.orchestrator import _deps_permanently_dead

    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state="abandoned")  # invalid enum -> ambiguous
    assert _deps_permanently_dead(db, [14]) is False


def test_deps_dead_false_for_active_ci_pending_sibling(tmp_path: Path) -> None:
    """REGRESSION: ci_pending is is_terminal-True (terminal-by-omission, driven by
    direct assignment), but it is an ACTIVELY-progressing state about to deploy.
    A dependent behind it must NOT be deadlock-terminalized — the dead-end check
    is an explicit allowlist, not is_terminal, precisely to avoid this."""
    from factory.chain.orchestrator import _deps_permanently_dead

    db = _seed(tmp_path)
    _story(db, sid=14, direction="008", state=StoryState.CI_PENDING.value)
    assert _deps_permanently_dead(db, [14]) is False
    # same for other active "terminal-by-omission"-adjacent states
    _story(db, sid=15, direction="009", state=StoryState.READY_FOR_MERGE.value)
    _story(db, sid=16, direction="009", state=StoryState.DEPLOY_PENDING.value)
    assert _deps_permanently_dead(db, [15, 16]) is False
