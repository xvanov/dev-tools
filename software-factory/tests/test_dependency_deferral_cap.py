"""A dependent must never defer FOREVER behind a blocked foundation.

Observed 2026-07-28: direction 018 spawned stories 167..171. Story 167 landed in
``blocked_deploy_failed``; 168-171 sat in ``story_created`` emitting
``dependency_deferred waiting_on_story_ids=[167]`` once per tick, forever.
``blocked_deploy_failed`` is (correctly) NOT in ``_DEAD_END_DEP_STATES`` — the FMS
``retry-mergeable-blocked-story`` playbook really does revive it — so the
deadlock guard never fired, nothing escalated, and because the tick dispatched
nothing it printed "No in-flight stories", telling the operator the queue was
empty. Uncapped wait + detect-without-remediate, silent for 2+ hours.

The mechanism under test:
  * a STALLED deferral (every blocker human-blocked) is counted and capped at
    ``_MAX_DEPENDENCY_DEFERRALS``, then parked in ``BLOCKED_DEPENDENCY_UNMET``
    with a marker reason that shows up in ``factory inbox``;
  * a LIVE blocker still defers indefinitely and resets the counter (a story
    waiting out its foundation's real work is never capped);
  * the TickSummary reports deferrals, so a defer-only tick can never read as an
    empty queue;
  * a capped dependent revives itself once its blockers leave the human-blocked
    set.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, SQLModel, create_engine
from typer.testing import CliRunner

from factory.chain import handlers as H
from factory.chain import orchestrator as O
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: ssh://placeholder\nrepo_path: /tmp/sacrifice\n",
        encoding="utf-8",
    )
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 4\n  per_repo_concurrent_agents: 4\n"
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n",
        encoding="utf-8",
    )
    return tmp_path


def _seed_pair(
    db: Path,
    *,
    direction: str,
    blocker_state: str,
    dependent_state: str = StoryState.STORY_CREATED.value,
    blocker_age_seconds: int = 3 * 60 * 60,
) -> tuple[int, int]:
    """Seed a (lower-id blocker, higher-id dependent) pair in one direction.

    ``blocker_age_seconds`` backdates the blocker's ``updated_at``: the cap needs
    BOTH a tick count and a stall age (``_MIN_DEP_STALL_SECONDS``), so the default
    puts the blocker well past the age gate. Pass a small value to exercise the
    "blocked only moments ago" case.
    """
    stale = (datetime.now(UTC) - timedelta(seconds=blocker_age_seconds)).isoformat()
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    blocker = StoryRecord(
        direction_id=direction,
        app="sacrifice",
        title="foundation",
        slug=f"d{direction}-foundation",
        scope="backend",
        state=blocker_state,
        chain_kind="tdd",
        created_at=stale,
        updated_at=stale,
    )
    dependent = StoryRecord(
        direction_id=direction,
        app="sacrifice",
        title="dependent",
        slug=f"d{direction}-dependent",
        scope="backend",
        state=dependent_state,
        chain_kind="tdd",
    )
    with Session(eng) as session:
        session.add(blocker)
        session.add(dependent)
        session.commit()
        session.refresh(blocker)
        session.refresh(dependent)
        assert blocker.id is not None and dependent.id is not None
        assert blocker.id < dependent.id
        return blocker.id, dependent.id


def _get(db: Path, story_id: int) -> StoryRecord:
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        row = session.get(StoryRecord, story_id)
    assert row is not None
    return row


def _set_state(db: Path, story_id: int, state: str) -> None:
    story = _get(db, story_id)
    story.state = state
    H.persist_story(story, db)


def _events(root: Path, story_id: int, slug: str) -> list[dict[str, Any]]:
    from factory.chain.event_log import read_story_events

    return read_story_events(story_id, software_factory_root=root, slug_hint=slug)


def _no_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any handler dispatch means the dependency gate let the story through."""

    def _loud_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        raise AssertionError("a deferred/parked dependent must never be dispatched")

    monkeypatch.setattr(H, "handle_sm", _loud_sm)


def test_blocked_deploy_failed_blocker_does_not_defer_forever(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact D018 shape: a dependent behind ``blocked_deploy_failed`` is
    capped and parked, not deferred every tick forever."""
    db = factory_root / "factory.db"
    blocker_id, dep_id = _seed_pair(
        db, direction="018", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    _no_dispatch(monkeypatch)

    # Bounded, not instant: the first ticks still defer (a human may revive the
    # blocker), so the dependent stays exactly where it was.
    for tick_n in range(1, O._MAX_DEPENDENCY_DEFERRALS):
        summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
        assert summary.errors == []
        dep = _get(db, dep_id)
        assert dep.state == StoryState.STORY_CREATED.value
        assert dep.dependency_defer_count == tick_n

    # The cap tick parks it in the existing sink with the marker reason.
    summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert summary.errors == []
    dep = _get(db, dep_id)
    assert dep.state == StoryState.BLOCKED_DEPENDENCY_UNMET.value
    assert (dep.last_rejection_reason or "").startswith(O.DEP_DEFER_CAP_REASON_PREFIX)
    assert str(blocker_id) in (dep.last_rejection_reason or "")

    events = _events(factory_root, dep_id, "d018-dependent")
    capped = [e for e in events if e.get("event") == "dependency_deferral_capped"]
    assert len(capped) == 1, events
    assert capped[0]["cap"] == O._MAX_DEPENDENCY_DEFERRALS
    assert capped[0]["waiting_on_story_ids"] == [blocker_id]

    # And it is reported in the summary, not silently swallowed.
    assert any(slug == "d018-dependent" for slug, _ in summary.deferred), summary.deferred

    # Idempotent: further ticks neither re-park nor re-emit (the row has left
    # story_created, so the gate no longer sees it).
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    events = _events(factory_root, dep_id, "d018-dependent")
    assert len([e for e in events if e.get("event") == "dependency_deferral_capped"]) == 1


def test_live_blocker_defers_without_ever_capping(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dependent waiting on a LIVE foundation must keep deferring forever —
    real foundation work takes many ticks and must never be cap-parked."""
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db,
        direction="019",
        blocker_state=StoryState.DEV_IN_PROGRESS.value,
        # Freshly updated: a backdated ``*_in_progress`` row is (correctly) treated
        # as stranded by ``_prune_stale_in_progress``, which is a different test.
        blocker_age_seconds=0,
    )
    _no_dispatch(monkeypatch)

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS + 3):
        summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
        assert summary.errors == []

    dep = _get(db, dep_id)
    assert dep.state == StoryState.STORY_CREATED.value
    assert dep.dependency_defer_count == 0
    assert dep.last_rejection_reason is None
    # Still visible to the operator every tick, though.
    assert summary.deferred and summary.deferred[0][0] == "d019-dependent"


def test_counter_resets_when_blocker_becomes_live_again(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap counts CONSECUTIVE stalled deferrals: blocker progress resets it,
    so a flapping-but-progressing foundation cannot accumulate a park."""
    db = factory_root / "factory.db"
    blocker_id, dep_id = _seed_pair(
        db, direction="020", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    _no_dispatch(monkeypatch)

    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert _get(db, dep_id).dependency_defer_count == 2

    # Blocker revived (e.g. FMS retry-mergeable playbook) -> counter resets.
    _set_state(db, blocker_id, StoryState.DEV_RETRY.value)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    dep = _get(db, dep_id)
    assert dep.dependency_defer_count == 0
    assert dep.state == StoryState.STORY_CREATED.value

    # Stalls again -> fresh bounded window, still not parked after 2.
    _set_state(db, blocker_id, StoryState.BLOCKED_DEPLOY_FAILED.value)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    dep = _get(db, dep_id)
    assert dep.dependency_defer_count == 2
    assert dep.state == StoryState.STORY_CREATED.value


def test_capped_dependent_revives_when_blocker_leaves_the_blocked_set(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once the foundation is un-blocked, the cap-parked dependent re-enters the
    chain by itself — otherwise fixing the blocker leaves its dependents rotting."""
    db = factory_root / "factory.db"
    blocker_id, dep_id = _seed_pair(
        db, direction="021", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    _no_dispatch(monkeypatch)

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS):
        O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert _get(db, dep_id).state == StoryState.BLOCKED_DEPENDENCY_UNMET.value

    # Still parked while the blocker remains human-blocked (no park/revive churn).
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert _get(db, dep_id).state == StoryState.BLOCKED_DEPENDENCY_UNMET.value

    _set_state(db, blocker_id, StoryState.DEPLOY_PENDING.value)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    dep = _get(db, dep_id)
    assert dep.state == StoryState.STORY_CREATED.value
    assert dep.dependency_defer_count == 0
    assert dep.last_rejection_reason is None
    assert any(
        e.get("event") == "dependency_defer_revived"
        for e in _events(factory_root, dep_id, "d021-dependent")
    )


def test_deadlock_parked_dependent_is_not_revived_by_the_cap_pass(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Revival is keyed on the CAP marker only: a deadlock-parked dependent
    (blocker definitively dead) keeps its operator-driven revival posture."""
    db = factory_root / "factory.db"
    blocker_id, dep_id = _seed_pair(
        db, direction="022", blocker_state=StoryState.BLOCKED_CI_UNRESOLVED.value
    )
    _no_dispatch(monkeypatch)

    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    dep = _get(db, dep_id)
    assert dep.state == StoryState.BLOCKED_DEPENDENCY_UNMET.value
    assert dep.last_rejection_reason is None  # deadlock park, no cap marker

    # Blocker no longer dead, but the deadlock park is NOT auto-revived here.
    _set_state(db, blocker_id, StoryState.DEV_RETRY.value)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert _get(db, dep_id).state == StoryState.BLOCKED_DEPENDENCY_UNMET.value


def test_merged_dependent_is_never_cap_parked(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dependent already at DEPLOY_PENDING has MERGED code: parking it would
    strand merged work undeployed (and its sink counts as resolved, so the
    tracker would close over it). It keeps deferring — visibly."""
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db,
        direction="025",
        blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value,
        dependent_state=StoryState.DEPLOY_PENDING.value,
    )

    def _loud_deploy(*_a: object, **_k: object) -> H.HandlerResult:
        raise AssertionError("deferred story must not be dispatched to deploy")

    monkeypatch.setattr(H, "handle_deploy", _loud_deploy)

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS + 2):
        summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
        assert summary.errors == []

    dep = _get(db, dep_id)
    assert dep.state == StoryState.DEPLOY_PENDING.value
    assert (dep.last_rejection_reason or "") == ""
    assert summary.deferred, "the deferral must still be visible to the operator"


def test_freshly_blocked_foundation_is_not_parked_on_a_tick_count_alone(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap needs an AGE as well as a count. Tick cadence is 30 s in
    ``drive_chain.sh``, so a pure count would abandon dependents ~90 s after the
    foundation blocked — long before the FMS revival playbook (30 min cooldown)
    even runs."""
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db,
        direction="026",
        blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value,
        blocker_age_seconds=60,  # blocked one minute ago
    )
    _no_dispatch(monkeypatch)

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS + 2):
        O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    dep = _get(db, dep_id)
    assert dep.state == StoryState.STORY_CREATED.value
    # Counter is clamped at the cap; it is the age gate holding the park back.
    assert dep.dependency_defer_count == O._MAX_DEPENDENCY_DEFERRALS


def test_paused_mode_never_abandons_dependents(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An operator pauses the factory precisely to investigate a blocker like
    this; pausing must not be what abandons its dependents."""
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db, direction="027", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    _no_dispatch(monkeypatch)
    monkeypatch.setattr("factory.chain.orchestrator.get_mode", lambda *_a, **_k: "paused")

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS + 2):
        O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    assert _get(db, dep_id).state == StoryState.STORY_CREATED.value


def test_deferral_does_not_refresh_updated_at(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The counter bump must NOT stamp ``updated_at``.

    ``manager/detectors/stalled_stories.py`` alarms on ``now - updated_at`` and
    computes a factory-wide ``draining`` flag from the MINIMUM over all rows — a
    per-tick heartbeat on a deferred row would hide this very stall AND silence the
    aged-backlog alarm for every other story.
    """
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db,
        direction="028",
        blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value,
        blocker_age_seconds=60,  # stay deferred (age gate) so we keep counting
    )
    _no_dispatch(monkeypatch)
    before = _get(db, dep_id).updated_at

    for _ in range(3):
        O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    dep = _get(db, dep_id)
    assert dep.dependency_defer_count >= 1, "the deferral must still be counted"
    assert dep.updated_at == before, "a deferral is a stall, not activity"


def test_revival_resumes_at_the_parked_from_state(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dependent capped out of ``reviewer_done`` must not be rewound to
    ``story_created`` — that re-runs SM+dev+review and discards the verdict."""
    db = factory_root / "factory.db"
    blocker_id, dep_id = _seed_pair(
        db,
        direction="029",
        blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value,
        dependent_state=StoryState.REVIEWER_DONE.value,
    )

    def _loud(*_a: object, **_k: object) -> H.HandlerResult:
        raise AssertionError("must not dispatch while deferred")

    monkeypatch.setattr(H, "handle_tech_writer", _loud)

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS):
        O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert _get(db, dep_id).state == StoryState.BLOCKED_DEPENDENCY_UNMET.value

    _set_state(db, blocker_id, StoryState.DEPLOY_PENDING.value)
    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert _get(db, dep_id).state == StoryState.REVIEWER_DONE.value


def test_dry_run_never_parks(factory_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A dry run previews; it must not assert a state transition."""
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db, direction="030", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    _no_dispatch(monkeypatch)

    for _ in range(O._MAX_DEPENDENCY_DEFERRALS + 2):
        summary = O.tick(
            factory_root, "sacrifice", db_path=db, max_advances_per_story=1, dry_run=True
        )

    assert _get(db, dep_id).state == StoryState.STORY_CREATED.value
    assert summary.deferred, "the deferral is still previewed"
    assert not any(
        e.get("event") == "dependency_deferral_capped"
        for e in _events(factory_root, dep_id, "d030-dependent")
    )


def test_cap_bookkeeping_failure_leaves_the_story_deferred(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """This path used to be read-only. A failed write must not abort the tick —
    that would leave the rest of the queue undispatched and exit non-zero."""
    db = factory_root / "factory.db"
    _blocker_id, dep_id = _seed_pair(
        db, direction="031", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    _no_dispatch(monkeypatch)

    def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("database is locked")

    monkeypatch.setattr(O, "_bump_dependency_defer_count", _boom)

    summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    assert summary.errors == []
    assert _get(db, dep_id).state == StoryState.STORY_CREATED.value
    assert any(
        e.get("event") == "dependency_deferral_cap_error"
        for e in _events(factory_root, dep_id, "d031-dependent")
    )


def test_quarantined_blocker_is_treated_as_stalled(factory_root: Path) -> None:
    """A poisoned/quarantined foundation moves only when an operator repairs it,
    so a dependent behind one must be capped, not deferred forever."""
    db = factory_root / "factory.db"
    blocker_id, _dep_id = _seed_pair(
        db, direction="032", blocker_state=StoryState.QUARANTINED_INVALID_STATE.value
    )
    assert O._deps_all_stalled(db, [blocker_id]) is True
    # ...but not a DEAD end: repairing it must be able to revive the dependent.
    assert StoryState.QUARANTINED_INVALID_STATE.value not in O._DEAD_END_DEP_STATES


def test_deps_all_stalled_fails_safe_on_missing_row(factory_root: Path) -> None:
    """Ambiguous evidence must never cap a dependent."""
    db = factory_root / "factory.db"
    blocker_id, _dep_id = _seed_pair(
        db, direction="023", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )
    assert O._deps_all_stalled(db, [blocker_id]) is True
    assert O._deps_all_stalled(db, [blocker_id, 9999]) is False  # missing row
    assert O._deps_all_stalled(db, []) is False


def test_blocked_deploy_failed_is_not_a_dead_end_dependency() -> None:
    """Requirement-1 guard: ``blocked_deploy_failed`` stays OUT of the dead-end
    set (the FMS revives it), so the CAP — not abandonment — is the fix."""
    assert StoryState.BLOCKED_DEPLOY_FAILED.value not in O._DEAD_END_DEP_STATES
    # ...but it IS a state no tick can move, which is what the cap keys off.
    assert StoryState.BLOCKED_DEPLOY_FAILED.value in O._STALLED_DEP_STATES
    assert O._DEAD_END_DEP_STATES <= O._STALLED_DEP_STATES


def test_tick_summary_dict_carries_deferrals(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The webhook/manager view of a tick must see deferrals too."""
    db = factory_root / "factory.db"
    _seed_pair(db, direction="024", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value)
    _no_dispatch(monkeypatch)

    summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    d = O.tick_summary_as_dict(summary)
    assert d["deferred"] == summary.deferred
    assert d["deferred"], "a deferral must be visible in the serialized summary"


# --------------------------------------------------------------------------- #
# Operator-visible surfaces: `factory tick` output and `factory inbox`.
# --------------------------------------------------------------------------- #


def _cli_root(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    (root / "apps" / "sacrifice").mkdir(parents=True)
    (root / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: https://github.com/test/sacrifice\ndefault_branch: main\n",
        encoding="utf-8",
    )
    (root / "state").mkdir(parents=True, exist_ok=True)
    return root


def _get_cli(root: Path) -> tuple[CliRunner, Any]:
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_tick_output_reports_deferrals_instead_of_no_in_flight_stories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tick that only deferred must NOT print "No in-flight stories" — that
    message is what convinced the operator the queue was empty for 2+ hours."""
    root = _cli_root(tmp_path)
    monkeypatch.setenv("COLUMNS", "240")
    monkeypatch.setattr(
        "factory.chain.orchestrator.tick",
        lambda *a, **kw: O.TickSummary(
            app="sacrifice",
            dry_run=False,
            deferred=[("d018-dependent", "waiting_on=[167] (human-blocked, deferrals 1/3)")],
        ),
    )

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["tick", "--app", "sacrifice", "--dry-run"])

    assert result.exit_code == 0, result.stdout
    assert "No in-flight stories" not in result.stdout
    assert "d018-dependent" in result.stdout
    assert "167" in result.stdout
    assert "deferred=1" in result.stdout


def test_cap_park_keeps_its_github_issue_and_tracker_open(factory_root: Path) -> None:
    """A cap-parked story is NOT abandoned: its issue must not be auto-closed as
    "terminally abandoned", and its direction's tracker must stay open.

    Otherwise the row is in ``factory inbox`` as "awaiting a human" while GitHub
    says the work was abandoned — the exact disagreement the shared resolved-states
    allowlist exists to prevent.
    """
    from factory.chain.state_machine import DEP_DEFER_CAP_REASON_PREFIX
    from factory.directions.tracker_issue import _direction_is_complete, _story_is_resolved

    cap_parked = StoryRecord(
        direction_id="018",
        app="sacrifice",
        title="t",
        slug="capped",
        scope="backend",
        state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
        last_rejection_reason=f"{DEP_DEFER_CAP_REASON_PREFIX}: deferred 3x behind [167]",
    )
    deadlocked = StoryRecord(
        direction_id="018",
        app="sacrifice",
        title="t",
        slug="deadlocked",
        scope="backend",
        state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
    )
    shipped = StoryRecord(
        direction_id="018",
        app="sacrifice",
        title="t",
        slug="shipped",
        scope="backend",
        state=StoryState.DEPLOYED.value,
    )

    assert _story_is_resolved(cap_parked) is False
    assert _story_is_resolved(deadlocked) is True  # unchanged
    assert _story_is_resolved(shipped) is True
    # A direction with a cap-parked child is NOT complete...
    assert _direction_is_complete([shipped, cap_parked]) is False
    # ...while the deadlock-abandoned shape still closes exactly as before.
    assert _direction_is_complete([shipped, deadlocked]) is True


def test_operator_can_settle_a_cap_park_by_closing_its_issue(factory_root: Path) -> None:
    """The cap park is routed into the inbox as "awaiting a human", so it needs the
    same exit the other awaiting-a-human states have: closing the tracker issue on
    GitHub settles it. Without this the inbox entry can only be cleared by hand."""
    from factory.app_config import load_app_config
    from factory.chain.state_machine import DEP_DEFER_CAP_REASON_PREFIX

    db = factory_root / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        row = StoryRecord(
            direction_id="018",
            app="sacrifice",
            title="t",
            slug="capped",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            github_issue_number=4242,
            last_rejection_reason=f"{DEP_DEFER_CAP_REASON_PREFIX}: deferred 3x behind [167]",
        )
        deadlock_row = StoryRecord(
            direction_id="018",
            app="sacrifice",
            title="t",
            slug="deadlocked",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            github_issue_number=4243,
        )
        session.add(row)
        session.add(deadlock_row)
        session.commit()
        session.refresh(row)
        session.refresh(deadlock_row)
        capped_id, deadlock_id = row.id, deadlock_row.id

    settled = O.reconcile_closed_trackers(
        db,
        "sacrifice",
        cfg=load_app_config("sacrifice", factory_root),
        root=factory_root,
        query_issue_state=lambda **_k: "CLOSED",
    )

    assert [s[0] for s in settled] == ["capped"]
    assert _get(db, capped_id).state == StoryState.CLOSED_BY_OPERATOR.value
    # A deadlock park is abandoned-for-good, not awaiting anyone — untouched.
    assert _get(db, deadlock_id).state == StoryState.BLOCKED_DEPENDENCY_UNMET.value


def test_why_projects_the_deferral_instead_of_would_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``factory why`` must not claim a deferred story "would dispatch" — the
    dependency gate runs before the enforcer it was projecting."""
    monkeypatch.setenv("FACTORY_WEBHOOK_LAZY", "1")
    monkeypatch.setenv("COLUMNS", "240")
    root = _cli_root(tmp_path)
    db = root / "state" / "factory.db"
    blocker_id, dep_id = _seed_pair(
        db, direction="018", blocker_state=StoryState.BLOCKED_DEPLOY_FAILED.value
    )

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["why", str(dep_id)])

    assert result.exit_code == 0, result.stdout
    assert "would DEFER" in result.stdout
    assert str(blocker_id) in result.stdout
    assert "would dispatch" not in result.stdout


def test_cap_parked_story_appears_in_inbox(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap park must reach the operator's inbox; a deadlock park must not
    (it is genuinely resolved-abandoned, and that behaviour is unchanged)."""
    monkeypatch.setenv("FACTORY_WEBHOOK_LAZY", "1")
    monkeypatch.setenv("COLUMNS", "240")
    monkeypatch.setenv("TERM", "xterm-256color")
    root = _cli_root(tmp_path)
    db = root / "state" / "factory.db"
    H.persist_story(
        StoryRecord(
            direction_id="018",
            app="sacrifice",
            title="dependent",
            slug="cap-parked-dependent",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            last_rejection_reason=(
                f"{O.DEP_DEFER_CAP_REASON_PREFIX}: deferred 3x behind human-blocked "
                "story_ids=[167] in direction 018"
            ),
        ),
        db,
    )
    H.persist_story(
        StoryRecord(
            direction_id="018",
            app="sacrifice",
            title="deadlocked",
            slug="deadlock-parked-dependent",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
        ),
        db,
    )

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["inbox", "--app", "sacrifice"])

    assert result.exit_code == 0, result.stdout
    assert "cap-parked-dependent" in result.stdout
    assert O.DEP_DEFER_CAP_REASON_PREFIX in result.stdout
    assert "deadlock-parked-dependent" not in result.stdout
