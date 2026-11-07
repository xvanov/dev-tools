"""Tests for runs_failed_since detector."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.manager.detectors.runs_failed_since import runs_failed_since


def _write_run(path: Path, *, ts: str, success: bool, persona: str = "sm", story_id: int = 1, error: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "run",
        "success": success,
        "persona": persona,
        "story_id": story_id,
        "cost_usd": 0.01,
        "error": error,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=2)


def test_file_missing_returns_empty(tmp_path: Path) -> None:
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert result == []


def test_empty_file_returns_empty(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text("", encoding="utf-8")
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert result == []


def test_single_failure_picked_up(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts = (NOW - timedelta(hours=1)).isoformat()
    _write_run(stream, ts=ts, success=False, error="boom")
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert len(result) == 1
    assert result[0]["success"] is False
    assert result[0]["error"] == "boom"


def test_success_rows_excluded(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_run(stream, ts=ts, success=True)
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert result == []


def test_old_failures_excluded(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    old_ts = (NOW - timedelta(hours=5)).isoformat()
    recent_ts = (NOW - timedelta(minutes=20)).isoformat()
    _write_run(stream, ts=old_ts, success=False)
    _write_run(stream, ts=recent_ts, success=False)
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert len(result) == 1
    assert result[0]["ts"] == recent_ts


def test_multiple_failures_all_returned(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    for i in range(4):
        ts = (NOW - timedelta(minutes=10 * (i + 1))).isoformat()
        _write_run(stream, ts=ts, success=False, story_id=i + 1)
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert len(result) == 4


def test_mixed_success_and_failure(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts1 = (NOW - timedelta(minutes=60)).isoformat()
    ts2 = (NOW - timedelta(minutes=30)).isoformat()
    _write_run(stream, ts=ts1, success=True)
    _write_run(stream, ts=ts2, success=False)
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert len(result) == 1


def test_original_fields_preserved(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "runs.ndjson"
    ts = (NOW - timedelta(hours=1)).isoformat()
    _write_run(stream, ts=ts, success=False, persona="dev", story_id=99, error="timeout")
    result = runs_failed_since(root=tmp_path, since=SINCE)
    assert result[0]["persona"] == "dev"
    assert result[0]["story_id"] == 99
    assert result[0]["cost_usd"] == 0.01
