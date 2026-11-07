"""Tests for the read-side query helpers the TUI consumes."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import Session

from factory.chain.state_machine import StoryRecord, StoryState
from factory.observability.queries import (
    app_summary,
    collect_snapshot,
    directions_in_flight,
    in_flight_stories,
    spend_window,
)
from factory.runner import Run, _engine


def _seed_root(tmp_path: Path, *, app: str = "sacrifice") -> Path:
    (tmp_path / "apps" / app).mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / app / "config.yaml").write_text(
        f"name: {app}\nrepo: x/y\n", encoding="utf-8"
    )
    (tmp_path / "apps" / app / "directions").mkdir(parents=True, exist_ok=True)
    return tmp_path


def test_in_flight_stories_excludes_landed(tmp_path: Path) -> None:
    """Stories in pr_open / deployed are not in-flight."""
    root = _seed_root(tmp_path)
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    eng = _engine(db)
    with Session(eng) as session:
        session.add_all(
            [
                StoryRecord(
                    direction_id="007-foo",
                    app="sacrifice",
                    title="active",
                    slug="active",
                    scope="backend",
                    state=StoryState.DEV_IN_PROGRESS.value,
                    chain_kind="tdd",
                    story_file_path="x",
                ),
                StoryRecord(
                    direction_id="007-foo",
                    app="sacrifice",
                    title="landed",
                    slug="landed",
                    scope="backend",
                    state=StoryState.DEPLOYED.value,
                    chain_kind="tdd",
                    story_file_path="x",
                ),
            ]
        )
        session.commit()

    rows = in_flight_stories(db)
    slugs = {r.slug for r in rows}
    assert "active" in slugs
    assert "landed" not in slugs


def test_directions_in_flight_groups_by_app_and_direction(tmp_path: Path) -> None:
    root = _seed_root(tmp_path)
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    eng = _engine(db)
    with Session(eng) as session:
        session.add_all(
            [
                StoryRecord(
                    direction_id="007-foo",
                    app="sacrifice",
                    title="s1",
                    slug="s1",
                    scope="backend",
                    state=StoryState.SM_DONE.value,
                    chain_kind="tdd",
                    story_file_path="x",
                    points=3,
                ),
                StoryRecord(
                    direction_id="007-foo",
                    app="sacrifice",
                    title="s2",
                    slug="s2",
                    scope="frontend",
                    state=StoryState.DEPLOYED.value,
                    chain_kind="tdd",
                    story_file_path="x",
                    points=2,
                ),
                StoryRecord(
                    direction_id="008-bar",
                    app="sacrifice",
                    title="s3",
                    slug="s3",
                    scope="backend",
                    state=StoryState.STORY_CREATED.value,
                    chain_kind="tdd",
                    story_file_path="x",
                    points=5,
                ),
            ]
        )
        session.commit()

    dirs = directions_in_flight(db, root, compute_eta=False)
    by_id = {d.direction_id: d for d in dirs}

    # Both directions appear because each has at least one in-flight story.
    assert {"007-foo", "008-bar"} <= set(by_id.keys())

    # 007-foo has 2 total stories, 1 in-flight, 1 deployed
    seven = by_id["007-foo"]
    assert seven.total_stories == 2
    assert seven.completed_stories == 1
    assert seven.total_points == 5  # 3 + 2
    assert seven.completed_points == 2  # only the deployed one

    # 008-bar is freshly spawned: 1 story, 0 completed
    eight = by_id["008-bar"]
    assert eight.total_stories == 1
    assert eight.completed_stories == 0


def test_spend_window_filters_by_age(tmp_path: Path) -> None:
    root = _seed_root(tmp_path)
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    eng = _engine(db)
    from datetime import timedelta

    now = datetime.now(UTC)
    recent = now - timedelta(hours=1)
    old = now - timedelta(hours=72)
    with Session(eng) as session:
        session.add_all(
            [
                Run(
                    ts=recent.isoformat(),
                    persona="pm",
                    model="x",
                    mode="text",
                    cost_usd=1.00,
                    success=True,
                ),
                Run(
                    ts=old.isoformat(),
                    persona="pm",
                    model="x",
                    mode="text",
                    cost_usd=10.00,
                    success=True,
                ),
            ]
        )
        session.commit()

    assert spend_window(db, hours=24) == 1.0
    assert spend_window(db, hours=24 * 7) == 11.0


def test_app_summary_returns_expected_shape(tmp_path: Path) -> None:
    root = _seed_root(tmp_path)
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    _engine(db)

    a = app_summary(db, app="sacrifice")
    assert a.name == "sacrifice"
    assert a.in_flight_stories == 0
    assert a.active is False
    assert a.spend_24h_usd == 0.0


def test_collect_snapshot_runs_end_to_end(tmp_path: Path) -> None:
    """Smoke: collect_snapshot on an empty DB returns a populated dataclass."""
    root = _seed_root(tmp_path)
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    _engine(db)

    snap = collect_snapshot(db, root)
    assert snap.mode in {"normal", "paused"}
    assert snap.active is False
    assert snap.apps and snap.apps[0].name == "sacrifice"
    assert snap.live_handlers == []
    assert snap.directions == []
    assert isinstance(snap.spend_sparkline_hourly, list)
    assert len(snap.spend_sparkline_hourly) == 24
