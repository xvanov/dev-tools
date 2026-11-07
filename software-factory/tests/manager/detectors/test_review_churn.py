"""Tests for review_churn detector."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.manager.detectors.review_churn import review_churn

NOW = datetime(2026, 5, 28, 23, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(minutes=1)  # the watcher's tight ~60s window


def _write_run(
    path: Path,
    *,
    ts: str,
    persona: str,
    story_id: int,
    success: bool = True,
    cost_usd: float = 0.01,
    attempt_n: int | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "run",
        "success": success,
        "persona": persona,
        "story_id": story_id,
        "cost_usd": cost_usd,
    }
    if attempt_n is not None:
        rec["attempt_n"] = attempt_n
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


def _ping_pong(path: Path, *, story_id: int, cycles: int, base_min: int) -> None:
    """Write `cycles` successful dev+reviewer pairs for a story."""
    for i in range(cycles):
        # dev then reviewer, all successful, marching backward in time
        ts = (NOW - timedelta(minutes=base_min + i)).isoformat()
        _write_run(
            path, ts=ts, persona="dev", story_id=story_id,
            cost_usd=0.10, attempt_n=i + 1,
        )
        _write_run(
            path, ts=ts, persona="reviewer", story_id=story_id,
            cost_usd=0.02, attempt_n=i + 1,
        )


def test_file_missing_returns_empty(tmp_path: Path) -> None:
    assert review_churn(root=tmp_path, since=SINCE) == []


def test_empty_file_returns_empty(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text("", encoding="utf-8")
    assert review_churn(root=tmp_path, since=SINCE) == []


def test_below_min_cycles_not_returned(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    _ping_pong(stream, story_id=1, cycles=2, base_min=0)
    assert review_churn(root=tmp_path, since=SINCE, min_cycles=3) == []


def test_churning_story_surfaced_despite_all_success(tmp_path: Path) -> None:
    """The core blind-spot case: every run succeeded, yet churn is surfaced."""
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    _ping_pong(stream, story_id=5, cycles=6, base_min=0)
    result = review_churn(root=tmp_path, since=SINCE)
    assert len(result) == 1
    row = result[0]
    assert row["story_id"] == 5
    assert row["reviewer_cycles"] == 6
    assert row["dev_cycles"] == 6
    # 6 dev @ 0.10 + 6 reviewer @ 0.02 = 0.72
    assert row["total_cost_usd"] == 0.72


def test_cumulative_count_ignores_window(tmp_path: Path) -> None:
    """Churn from before `since` still counts — that's the whole point."""
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    # All cycles are >1 min old, i.e. entirely OUTSIDE the watcher window.
    _ping_pong(stream, story_id=7, cycles=5, base_min=10)
    result = review_churn(root=tmp_path, since=SINCE)
    assert len(result) == 1
    assert result[0]["story_id"] == 7
    assert result[0]["reviewer_cycles"] == 5


def test_active_in_window_flag(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    # Active story: most recent reviewer run is within the window.
    _write_run(
        stream, ts=NOW.isoformat(), persona="reviewer", story_id=1,
    )
    for i in range(1, 6):
        ts = (NOW - timedelta(minutes=5 + i)).isoformat()
        _write_run(stream, ts=ts, persona="reviewer", story_id=1)
    # Parked story: all reviewer runs are old.
    for i in range(6):
        ts = (NOW - timedelta(minutes=30 + i)).isoformat()
        _write_run(stream, ts=ts, persona="reviewer", story_id=2)

    result = {r["story_id"]: r for r in review_churn(root=tmp_path, since=SINCE)}
    assert result[1]["active_in_window"] is True
    assert result[2]["active_in_window"] is False


def test_failed_runs_excluded(tmp_path: Path) -> None:
    """Failures are retry_storm's job; review_churn ignores them."""
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    for i in range(5):
        ts = (NOW - timedelta(minutes=i)).isoformat()
        _write_run(
            stream, ts=ts, persona="reviewer", story_id=9, success=False,
        )
    assert review_churn(root=tmp_path, since=SINCE) == []


def test_sorted_by_reviewer_cycles_desc(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    _ping_pong(stream, story_id=1, cycles=4, base_min=0)
    _ping_pong(stream, story_id=2, cycles=9, base_min=20)
    _ping_pong(stream, story_id=3, cycles=6, base_min=40)
    result = review_churn(root=tmp_path, since=SINCE)
    assert [r["story_id"] for r in result] == [2, 3, 1]
