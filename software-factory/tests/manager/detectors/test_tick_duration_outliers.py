"""Tests for tick_duration_outliers detector."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

from factory.manager.detectors.tick_duration_outliers import tick_duration_outliers


def _write_tick_start(path: Path, *, tick_id: str, ts: str, app: str = "factory") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "tick_start",
        "tick_id": tick_id,
        "app": app,
        "dry_run": False,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


def _write_tick_end(path: Path, *, tick_id: str, ts: str, app: str = "factory") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "tick_end",
        "tick_id": tick_id,
        "app": app,
        "dry_run": False,
        "success": True,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=6)


def test_file_missing_returns_empty_structure(tmp_path: Path) -> None:
    result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert result["completed_ticks"] == []
    assert result["p95_duration_s"] == 0.0
    assert result["outliers"] == []
    assert result["still_running"] == []
    assert result["still_running_max_age_s"] == 0.0


def test_empty_file_returns_empty_structure(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text("", encoding="utf-8")
    result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert result["completed_ticks"] == []


def test_single_completed_tick(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    start_ts = (NOW - timedelta(hours=1)).isoformat()
    end_ts = (NOW - timedelta(minutes=50)).isoformat()
    _write_tick_start(stream, tick_id="t1", ts=start_ts)
    _write_tick_end(stream, tick_id="t1", ts=end_ts)
    result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert len(result["completed_ticks"]) == 1
    assert result["completed_ticks"][0]["tick_id"] == "t1"
    assert result["completed_ticks"][0]["duration_s"] == pytest.approx(600.0)


def test_still_running_tick_detected(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    start_ts = (NOW - timedelta(hours=3)).isoformat()
    _write_tick_start(stream, tick_id="t2", ts=start_ts)
    # No corresponding tick_end
    with patch("factory.manager.detectors.tick_duration_outliers.datetime") as mock_dt:
        mock_dt.now.return_value = NOW
        mock_dt.fromisoformat = datetime.fromisoformat
        result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert len(result["still_running"]) == 1
    assert result["still_running"][0]["tick_id"] == "t2"
    assert result["still_running_max_age_s"] == pytest.approx(3 * 3600, abs=1.0)


def test_outlier_detection_with_multiple_ticks(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    # Create 50 normal ticks of 60s (enough that p95 stays near 60s)
    # then 1 outlier of 7200s (2h) which is >> 2 * 60s
    for i in range(50):
        start_ts = (NOW - timedelta(hours=5) + timedelta(minutes=5 * i)).isoformat()
        end_ts = (NOW - timedelta(hours=5) + timedelta(minutes=5 * i, seconds=60)).isoformat()
        _write_tick_start(stream, tick_id=f"t{i}", ts=start_ts)
        _write_tick_end(stream, tick_id=f"t{i}", ts=end_ts)
    # Outlier: 2h duration
    out_start = (NOW - timedelta(hours=3)).isoformat()
    out_end = (NOW - timedelta(hours=1)).isoformat()
    _write_tick_start(stream, tick_id="outlier", ts=out_start)
    _write_tick_end(stream, tick_id="outlier", ts=out_end)
    result = tick_duration_outliers(root=tmp_path, since=SINCE, multiplier=2.0)
    assert len(result["completed_ticks"]) == 51
    # p95 over 50×60s + 1×7200s stays near 60s so the 7200s tick is an outlier
    assert len(result["outliers"]) >= 1
    outlier_ids = [r["tick_id"] for r in result["outliers"]]
    assert "outlier" in outlier_ids


def test_old_ticks_before_since_excluded(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    old_start = (NOW - timedelta(hours=10)).isoformat()
    old_end = (NOW - timedelta(hours=9, minutes=58)).isoformat()
    _write_tick_start(stream, tick_id="old", ts=old_start)
    _write_tick_end(stream, tick_id="old", ts=old_end)
    result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert len(result["completed_ticks"]) == 0


def test_p95_with_single_tick(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    start_ts = (NOW - timedelta(hours=1)).isoformat()
    end_ts = (NOW - timedelta(minutes=55)).isoformat()
    _write_tick_start(stream, tick_id="t1", ts=start_ts)
    _write_tick_end(stream, tick_id="t1", ts=end_ts)
    result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert result["p95_duration_s"] == pytest.approx(300.0)
    # Single tick = p95, not an outlier (not strictly > multiplier * p95)
    assert result["outliers"] == []


def test_still_running_max_age_multiple(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    # Two unmatched ticks, 1h and 2h old
    ts1 = (NOW - timedelta(hours=1)).isoformat()
    ts2 = (NOW - timedelta(hours=2)).isoformat()
    _write_tick_start(stream, tick_id="t1", ts=ts1)
    _write_tick_start(stream, tick_id="t2", ts=ts2)
    with patch("factory.manager.detectors.tick_duration_outliers.datetime") as mock_dt:
        mock_dt.now.return_value = NOW
        mock_dt.fromisoformat = datetime.fromisoformat
        result = tick_duration_outliers(root=tmp_path, since=SINCE)
    assert result["still_running_max_age_s"] == pytest.approx(2 * 3600, abs=1.0)
