"""019 AC6 — idle becomes a ping (Flow C).

``factory/chain/idle.py`` (deleted 2026-08-07, 019 AC5) fired 957 times and
reached a human zero times. This is the replacement: an app with zero
dispatchable stories and zero live human-filed directions gets exactly ONE
deduplicated ``operator_ping`` per idle episode, files no machine-authored
direction, and re-emits ``app_idle`` so ``stalled_stories``' healthy_drain
suppression works again.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import create_engine
from typer.testing import CliRunner

from factory.chain import orchestrator as O
from factory.chain.handlers import persist_story
from factory.chain.idle_ping import (
    _load_ping_state,
    _ping_state_path,
    active_pings,
    run_idle_ping_tick,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager.detectors.stalled_stories import _last_idle_ts


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
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n"
        "auto_merge:\n  enabled: false\n"
        "ci_health:\n  enabled: false\n",
        encoding="utf-8",
    )
    return tmp_path


def _directions_listing(root: Path, app: str = "sacrifice") -> list[str]:
    d = root / "apps" / app / "directions"
    if not d.exists():
        return []
    return sorted(p.name for p in d.iterdir())


def _seed_direction(
    root: Path,
    *,
    id_: str,
    status: str = "created",
    source: str = "operator",
    app: str = "sacrifice",
) -> Path:
    ddir = root / "apps" / app / "directions" / f"{id_}-human-request"
    ddir.mkdir(parents=True)
    (ddir / "direction.md").write_text(
        "---\ntitle: a human ask\n---\n\n# a human ask\n", encoding="utf-8"
    )
    (ddir / "state.yaml").write_text(
        json.dumps({"status": status, "source": source}), encoding="utf-8"
    )
    return ddir


def _events_path(root: Path) -> Path:
    return root / "state" / "events" / "idle.ndjson"


def _seed_in_flight_story(db: Path, *, state: str = StoryState.DEV_IN_PROGRESS.value) -> int:
    """Seed a story in a state ``_DISPATCH`` has no handler for (so the
    orchestrator's dispatch loop never actually calls out to an LLM) but
    which still counts as "in flight" for ``stories_in_flight``."""
    rec = persist_story(
        StoryRecord(
            direction_id="900",
            app="sacrifice",
            title="in flight",
            slug="s900-in-flight",
            scope="backend",
            state=state,
        ),
        db,
    )
    assert rec.id is not None
    return rec.id


# --------------------------------------------------------------------------- #
# Core AC: zero dispatchable + zero live human direction -> exactly one ping
# --------------------------------------------------------------------------- #


def test_idle_tick_pings_once_and_reemits_app_idle(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    before = _directions_listing(factory_root)

    summary = O.tick(factory_root, "sacrifice", db_path=db)

    assert summary.errors == []
    assert summary.idle_ping is not None
    assert summary.idle_ping["idle_since"]
    # No stories yet -> "last delivered unit" is None (nothing happened).
    assert summary.idle_ping["last_delivered_unit"] is None

    # The marker exists on disk.
    marker = _ping_state_path(factory_root, "sacrifice")
    assert marker.exists()

    # app_idle is re-emitted on the SAME stream/key stalled_stories reads —
    # assert via the actual reader, not a re-implementation.
    assert _last_idle_ts(factory_root) is not None

    # Zero machine-authored directions filed.
    assert _directions_listing(factory_root) == before


def test_three_ticks_with_nothing_changing_still_exactly_one_ping(factory_root: Path) -> None:
    """The core AC assertion: this is the 957-fires-zero-humans class.

    The OPERATOR ping stays deduplicated to exactly one per episode. The
    ``app_idle`` EVENT is a different signal (S9, 019 fail-silent audit): a
    liveness heartbeat ``stalled_stories.idle_recently`` reads with a
    30-minute freshness window, so it fires on EVERY idle tick — a heartbeat
    that only fired once per (potentially multi-hour) episode went stale
    long before the episode ended. Three idle ticks -> one ping, three
    ``app_idle`` events.
    """
    db = factory_root / "state" / "factory.db"

    first = O.tick(factory_root, "sacrifice", db_path=db)
    assert first.idle_ping is not None

    second = O.tick(factory_root, "sacrifice", db_path=db)
    assert second.idle_ping is None
    assert second.errors == []

    third = O.tick(factory_root, "sacrifice", db_path=db)
    assert third.idle_ping is None
    assert third.errors == []

    # Exactly one ping fired (asserted above via idle_ping is not None/None),
    # but app_idle fired on every one of the three idle ticks.
    lines = [
        ln
        for ln in _events_path(factory_root).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    app_idle_lines = [ln for ln in lines if json.loads(ln).get("event") == "app_idle"]
    assert len(app_idle_lines) == 3
    # Every emission carries the SAME idle_since (the episode's start), not a
    # per-tick timestamp — the episode never ended between these ticks.
    idle_sinces = {json.loads(ln)["idle_since"] for ln in app_idle_lines}
    assert len(idle_sinces) == 1

    assert _directions_listing(factory_root) == []


def test_work_then_idle_again_yields_a_second_ping(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"

    first = O.tick(factory_root, "sacrifice", db_path=db)
    assert first.idle_ping is not None
    first_idle_since = first.idle_ping["idle_since"]

    # Work happens: a story becomes dispatchable ("dispatched/advanced").
    story_id = _seed_in_flight_story(db)
    mid = O.tick(factory_root, "sacrifice", db_path=db)
    assert mid.idle_ping is None
    assert mid.errors == []
    # The episode marker was cleared — this is a NEW episode next time.
    assert not _ping_state_path(factory_root, "sacrifice").exists()

    # The story is delivered (reaches a terminal state) -> idle again.
    from sqlmodel import Session

    from factory.chain.handlers import _engine

    eng = _engine(db)
    with Session(eng) as session:
        rec = session.get(StoryRecord, story_id)
        assert rec is not None
        rec.state = StoryState.DEPLOYED.value
        session.add(rec)
        session.commit()

    second = O.tick(factory_root, "sacrifice", db_path=db)
    assert second.idle_ping is not None
    assert second.idle_ping["idle_since"] != first_idle_since
    assert second.idle_ping["last_delivered_unit"] == "s900-in-flight (deployed)"

    lines = [
        ln
        for ln in _events_path(factory_root).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    app_idle_lines = [ln for ln in lines if json.loads(ln).get("event") == "app_idle"]
    assert len(app_idle_lines) == 2


def test_live_human_filed_direction_suppresses_the_ping(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    _seed_direction(factory_root, id_="050", status="created", source="operator")

    summary = O.tick(factory_root, "sacrifice", db_path=db)

    assert summary.idle_ping is None
    assert summary.errors == []
    assert not _ping_state_path(factory_root, "sacrifice").exists()
    assert _last_idle_ts(factory_root) is None


def test_stories_in_flight_suppresses_the_ping(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    _seed_in_flight_story(db)

    summary = O.tick(factory_root, "sacrifice", db_path=db)

    assert summary.idle_ping is None
    assert summary.errors == []
    assert not _ping_state_path(factory_root, "sacrifice").exists()


def test_story_parked_in_blocked_ci_unresolved_does_not_suppress_the_ping(
    factory_root: Path,
) -> None:
    """S8: a story permanently parked in a terminal sink must not silence
    every future ping.

    ``blocked_ci_unresolved`` is absent from ``handlers.stories_in_flight``'s
    own (narrower) terminal set, so without subtracting the permanent-park
    sinks first, one such story made the app read as "in flight" forever —
    a single dead story silencing every future idle ping.
    """
    db = factory_root / "state" / "factory.db"
    _seed_in_flight_story(db, state=StoryState.BLOCKED_CI_UNRESOLVED.value)

    summary = O.tick(factory_root, "sacrifice", db_path=db)

    assert summary.idle_ping is not None
    assert summary.errors == []
    assert _ping_state_path(factory_root, "sacrifice").exists()
    assert _last_idle_ts(factory_root) is not None


def test_dry_run_tick_writes_no_ping_no_state_no_event(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    create_engine(f"sqlite:///{db}", echo=False)  # ensure the file exists

    summary = O.tick(factory_root, "sacrifice", db_path=db, dry_run=True)

    assert summary.idle_ping is None
    assert not _ping_state_path(factory_root, "sacrifice").exists()
    assert not _events_path(factory_root).exists()


# --------------------------------------------------------------------------- #
# Fail-safe: corrupt/unreadable marker suppresses rather than spams
# --------------------------------------------------------------------------- #


def test_corrupt_ping_state_is_suppressed_and_records_an_error(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    marker = _ping_state_path(factory_root, "sacrifice")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("{not valid json", encoding="utf-8")

    summary = O.tick(factory_root, "sacrifice", db_path=db)

    assert summary.idle_ping is None
    assert any(tag == "idle-ping" for tag, _ in summary.errors), summary.errors
    # No fresh app_idle emitted while the marker is unreadable.
    assert not _events_path(factory_root).exists()


def test_run_idle_ping_tick_unit_corrupt_state(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    create_engine(f"sqlite:///{db}", echo=False)
    marker = _ping_state_path(factory_root, "sacrifice")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text('{"idle_since": 123}', encoding="utf-8")  # wrong type -> malformed

    result = run_idle_ping_tick(factory_root, "sacrifice", db)

    assert result.fired is False
    assert result.error is not None


def test_corrupt_marker_self_heals_instead_of_suppressing_forever(factory_root: Path) -> None:
    """S8: a corrupt marker must be REPAIRED, not just suppressed-and-reread.

    Before the fix, the corrupt-marker branch returned early WITHOUT ever
    rewriting the file, so the identical error recurred on every subsequent
    tick forever — and (via ``orchestrator.tick`` -> ``summary.errors`` ->
    ``factory tick``'s ``typer.Exit(1)``) that meant a PERMANENT
    ``factory-tick@.service`` crash-loop. After the fix, the FIRST tick
    still records the error once (never silently swallowed), but the SECOND
    tick reads a now-valid marker and behaves like any other idle tick — no
    repeated error, and the deduplicated ping still fires exactly once for
    this (freshly-started) episode.
    """
    db = factory_root / "state" / "factory.db"
    marker = _ping_state_path(factory_root, "sacrifice")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("{not valid json", encoding="utf-8")

    first = O.tick(factory_root, "sacrifice", db_path=db)
    assert first.idle_ping is None
    assert any(tag == "idle-ping" for tag, _ in first.errors), first.errors

    # The marker is now valid JSON.
    state, error = _load_ping_state(factory_root, "sacrifice")
    assert error is None
    assert state is not None

    second = O.tick(factory_root, "sacrifice", db_path=db)
    assert second.errors == []
    # The repaired marker was written SUPPRESSED (not a guessed fresh ping),
    # so this tick sees "already pinged" for the repaired episode — no NEW
    # ping, but also no error.
    assert second.idle_ping is None


def test_app_idle_event_emitted_before_marker_write(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S8: the event must land even if the marker write blows up after it.

    Before the fix, the marker was written FIRST and the event SECOND — a
    crash between the two lost the episode's ``app_idle`` silently (the
    marker already reads "already pinged", so no retry ever re-emits it).
    Force the marker write to raise and assert the event was still emitted.
    """
    import factory.chain.idle_ping as idle_ping_mod

    db = factory_root / "state" / "factory.db"

    def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("simulated marker-write crash")

    monkeypatch.setattr(idle_ping_mod, "_write_ping_state", _boom)

    with pytest.raises(RuntimeError, match="simulated marker-write crash"):
        idle_ping_mod.run_idle_ping_tick(factory_root, "sacrifice", db)

    # The event landed even though the subsequent marker write raised.
    assert _last_idle_ts(factory_root) is not None


# --------------------------------------------------------------------------- #
# factory inbox renders the ping
# --------------------------------------------------------------------------- #


def _get_cli(root: Path):  # type: ignore[no-untyped-def]
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_inbox_renders_the_operator_ping_section(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    summary = O.tick(factory_root, "sacrifice", db_path=db)
    assert summary.idle_ping is not None

    runner, cli_mod = _get_cli(factory_root)
    result = runner.invoke(cli_mod.app, ["inbox", "--app", "sacrifice"])

    assert result.exit_code == 0, result.stdout
    assert "sacrifice" in result.stdout
    assert "operator_ping" in result.stdout or "idle apps" in result.stdout


def test_inbox_shows_no_pings_when_none_active(factory_root: Path) -> None:
    runner, cli_mod = _get_cli(factory_root)
    result = runner.invoke(cli_mod.app, ["inbox", "--app", "sacrifice"])
    assert result.exit_code == 0, result.stdout
    assert "No idle-app pings" in result.stdout


def test_active_pings_helper_survives_a_corrupt_marker_for_one_app(factory_root: Path) -> None:
    marker = _ping_state_path(factory_root, "sacrifice")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("not json at all", encoding="utf-8")
    assert active_pings(factory_root, ["sacrifice"]) == []


# --------------------------------------------------------------------------- #
# Seeded orchestrator tick integration — tick behavior otherwise unchanged
# --------------------------------------------------------------------------- #


def _no_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    from factory.chain import handlers as H

    def _loud_sm(story, *_a, **_k):  # type: ignore[no-untyped-def]
        raise AssertionError("dependency/idle-ping tests must never dispatch a handler")

    monkeypatch.setattr(H, "handle_sm", _loud_sm)


def test_non_idle_tick_leaves_idle_ping_none_and_other_fields_unaffected(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = factory_root / "state" / "factory.db"
    _no_dispatch(monkeypatch)
    # DEV_IN_PROGRESS has no ``_DISPATCH`` entry (webhook-gated), so the tick's
    # dispatch loop never calls a handler for it — it only needs to still
    # count as "in flight" for ``stories_in_flight``.
    story_id = persist_story(
        StoryRecord(
            direction_id="901",
            app="sacrifice",
            title="t",
            slug="s901-created",
            scope="backend",
            state=StoryState.DEV_IN_PROGRESS.value,
        ),
        db,
    ).id
    assert story_id is not None

    summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    assert summary.idle_ping is None
    assert summary.errors == []
    assert not _ping_state_path(factory_root, "sacrifice").exists()


def test_idle_tick_summary_dict_carries_idle_ping(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    summary = O.tick(factory_root, "sacrifice", db_path=db)
    as_dict = O.tick_summary_as_dict(summary)
    assert as_dict["idle_ping"] == summary.idle_ping
    assert as_dict["idle_ping"]["idle_since"]
