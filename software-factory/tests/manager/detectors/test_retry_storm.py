"""Tests for retry_storm detector."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.manager.detectors.retry_storm import retry_storm


def _write_run(
    path: Path,
    *,
    ts: str,
    success: bool,
    persona: str = "sm",
    story_id: int = 1,
    error: str | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "run",
        "success": success,
        "persona": persona,
        "story_id": story_id,
        "error": error,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=2)


def test_file_missing_returns_empty(tmp_path: Path) -> None:
    result = retry_storm(root=tmp_path, since=SINCE)
    assert result == []


def test_empty_file_returns_empty(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text("", encoding="utf-8")
    result = retry_storm(root=tmp_path, since=SINCE)
    assert result == []


def test_all_successes_returns_empty(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    for i in range(3):
        ts = (NOW - timedelta(minutes=10 * (i + 1))).isoformat()
        _write_run(stream, ts=ts, success=True)
    result = retry_storm(root=tmp_path, since=SINCE)
    assert result == []


def test_single_failure_row(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts = (NOW - timedelta(hours=1)).isoformat()
    _write_run(stream, ts=ts, success=False, persona="sm", story_id=5, error="boom")
    result = retry_storm(root=tmp_path, since=SINCE)
    assert len(result) == 1
    row = result[0]
    assert row["story_id"] == 5
    assert row["persona"] == "sm"
    assert row["failure_count"] == 1
    assert "boom" in row["error_excerpts"][0]


def test_multi_failure_same_group(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    for i in range(3):
        ts = (NOW - timedelta(minutes=20 * (i + 1))).isoformat()
        _write_run(stream, ts=ts, success=False, persona="sm", story_id=7, error=f"err{i}")
    result = retry_storm(root=tmp_path, since=SINCE)
    assert len(result) == 1
    assert result[0]["failure_count"] == 3
    assert len(result[0]["error_excerpts"]) == 3


def test_multiple_groups_sorted_by_count(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    # Group A: 1 failure
    ts_a = (NOW - timedelta(minutes=90)).isoformat()
    _write_run(stream, ts=ts_a, success=False, persona="dev", story_id=1)
    # Group B: 3 failures
    for i in range(3):
        ts_b = (NOW - timedelta(minutes=10 * (i + 1))).isoformat()
        _write_run(stream, ts=ts_b, success=False, persona="sm", story_id=2)
    result = retry_storm(root=tmp_path, since=SINCE)
    assert len(result) == 2
    assert result[0]["failure_count"] == 3
    assert result[1]["failure_count"] == 1


def test_filter_by_persona(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts1 = (NOW - timedelta(minutes=30)).isoformat()
    ts2 = (NOW - timedelta(minutes=60)).isoformat()
    _write_run(stream, ts=ts1, success=False, persona="sm", story_id=1)
    _write_run(stream, ts=ts2, success=False, persona="dev", story_id=2)
    result = retry_storm(root=tmp_path, persona="sm", since=SINCE)
    assert len(result) == 1
    assert result[0]["persona"] == "sm"


def test_filter_by_story_id(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts1 = (NOW - timedelta(minutes=20)).isoformat()
    ts2 = (NOW - timedelta(minutes=40)).isoformat()
    _write_run(stream, ts=ts1, success=False, persona="sm", story_id=10)
    _write_run(stream, ts=ts2, success=False, persona="dev", story_id=20)
    result = retry_storm(root=tmp_path, story_id=10, since=SINCE)
    assert len(result) == 1
    assert result[0]["story_id"] == 10


def test_old_failures_excluded(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    old_ts = (NOW - timedelta(hours=5)).isoformat()
    recent_ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_run(stream, ts=old_ts, success=False, persona="sm", story_id=1)
    _write_run(stream, ts=recent_ts, success=False, persona="sm", story_id=1)
    result = retry_storm(root=tmp_path, since=SINCE)
    assert result[0]["failure_count"] == 1


def test_error_excerpts_capped_at_5(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    for i in range(8):
        ts = (NOW - timedelta(minutes=5 * (i + 1))).isoformat()
        _write_run(stream, ts=ts, success=False, persona="sm", story_id=1, error=f"error_{i}")
    result = retry_storm(root=tmp_path, since=SINCE)
    assert len(result[0]["error_excerpts"]) == 5


def test_error_excerpts_truncated_at_200_chars(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_run(stream, ts=ts, success=False, persona="sm", story_id=1, error="x" * 500)
    result = retry_storm(root=tmp_path, since=SINCE)
    assert len(result[0]["error_excerpts"][0]) == 200


def test_first_ts_last_ts_ordering(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts1 = (NOW - timedelta(minutes=90)).isoformat()
    ts2 = (NOW - timedelta(minutes=30)).isoformat()
    _write_run(stream, ts=ts1, success=False, persona="sm", story_id=1)
    _write_run(stream, ts=ts2, success=False, persona="sm", story_id=1)
    result = retry_storm(root=tmp_path, since=SINCE)
    row = result[0]
    assert row["first_ts"] < row["last_ts"]
    assert row["first_ts"] == ts1
    assert row["last_ts"] == ts2
