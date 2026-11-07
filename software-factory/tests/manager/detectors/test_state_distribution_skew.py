"""Tests for state_distribution_skew detector."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from factory.manager.detectors.state_distribution_skew import state_distribution_skew


def _write_snapshot(
    path: Path,
    *,
    ts: str,
    app: str,
    counts_by_state: dict,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "queue_snapshot",
        "app": app,
        "counts_by_state": counts_by_state,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=2)


def test_file_missing_returns_empty(tmp_path: Path) -> None:
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    assert result == {"app_snapshots": {}}


def test_empty_file_returns_empty(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text("", encoding="utf-8")
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    assert result == {"app_snapshots": {}}


def test_single_snapshot_picked_up(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    ts = (NOW - timedelta(hours=1)).isoformat()
    _write_snapshot(stream, ts=ts, app="sacrifice", counts_by_state={"story_created": 10, "done": 5})
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    snaps = result["app_snapshots"]
    assert "sacrifice" in snaps
    assert snaps["sacrifice"]["total"] == 15
    assert snaps["sacrifice"]["max_state"] == "story_created"
    assert snaps["sacrifice"]["max_fraction"] == pytest.approx(10 / 15)


def test_exceeds_threshold_when_majority_in_one_state(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_snapshot(stream, ts=ts, app="factory", counts_by_state={"story_created": 9, "done": 1})
    result = state_distribution_skew(root=tmp_path, since=SINCE, threshold_fraction=0.5)
    snap = result["app_snapshots"]["factory"]
    assert snap["exceeds_threshold"] is True
    assert snap["exceeds_state"] == "story_created"


def test_does_not_exceed_threshold(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_snapshot(stream, ts=ts, app="factory", counts_by_state={"a": 5, "b": 5})
    result = state_distribution_skew(root=tmp_path, since=SINCE, threshold_fraction=0.5)
    snap = result["app_snapshots"]["factory"]
    assert snap["exceeds_threshold"] is False
    assert snap["exceeds_state"] is None


def test_old_snapshot_excluded(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    old_ts = (NOW - timedelta(hours=5)).isoformat()
    _write_snapshot(stream, ts=old_ts, app="factory", counts_by_state={"story_created": 10})
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    assert result == {"app_snapshots": {}}


def test_most_recent_snapshot_wins(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    ts1 = (NOW - timedelta(hours=1, minutes=30)).isoformat()
    ts2 = (NOW - timedelta(minutes=20)).isoformat()
    _write_snapshot(stream, ts=ts1, app="sacrifice", counts_by_state={"story_created": 10})
    _write_snapshot(stream, ts=ts2, app="sacrifice", counts_by_state={"done": 8, "dev_in_progress": 2})
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    snap = result["app_snapshots"]["sacrifice"]
    assert snap["ts"] == ts2
    assert "done" in snap["counts_by_state"]


def test_multiple_apps_each_tracked(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    ts = (NOW - timedelta(minutes=45)).isoformat()
    _write_snapshot(stream, ts=ts, app="sacrifice", counts_by_state={"story_created": 5})
    _write_snapshot(stream, ts=ts, app="factory", counts_by_state={"done": 3})
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    assert "sacrifice" in result["app_snapshots"]
    assert "factory" in result["app_snapshots"]


def test_zero_total_does_not_divide_by_zero(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "queue.ndjson"
    ts = (NOW - timedelta(minutes=15)).isoformat()
    _write_snapshot(stream, ts=ts, app="factory", counts_by_state={})
    result = state_distribution_skew(root=tmp_path, since=SINCE)
    snap = result["app_snapshots"]["factory"]
    assert snap["total"] == 0
    assert snap["max_fraction"] == 0.0
    assert snap["exceeds_threshold"] is False
