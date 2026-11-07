"""Tests for cost_spike detector."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

from factory.manager.detectors.cost_spike import cost_spike


def _write_run_cost(path: Path, *, ts: str, cost_usd: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "run",
        "success": True,
        "cost_usd": cost_usd,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


def _write_spend(path: Path, *, ts: str, cost_usd: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts,
        "schema_version": 1,
        "event": "spend_snapshot",
        "cost_usd": cost_usd,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)


def test_no_streams_both_zero_ratio_one(tmp_path: Path) -> None:
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path)
    assert result["recent_usd"] == 0.0
    assert result["baseline_avg_usd"] == 0.0
    assert result["ratio"] == 1.0


def test_empty_streams_both_zero_ratio_one(tmp_path: Path) -> None:
    runs = tmp_path / "state" / "events" / "runs.ndjson"
    runs.parent.mkdir(parents=True, exist_ok=True)
    runs.write_text("", encoding="utf-8")
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path)
    assert result["ratio"] == 1.0


def test_zero_baseline_nonzero_recent_returns_inf(tmp_path: Path) -> None:
    runs = tmp_path / "state" / "events" / "runs.ndjson"
    # Put a cost only in the recent window (last 1h)
    recent_ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_run_cost(runs, ts=recent_ts, cost_usd=5.0)
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path, window=timedelta(hours=1), baseline_window=timedelta(hours=6))
    assert math.isinf(result["ratio"])
    assert result["recent_usd"] == pytest.approx(5.0)
    assert result["baseline_avg_usd"] == pytest.approx(0.0)


def test_equal_spend_ratio_one(tmp_path: Path) -> None:
    runs = tmp_path / "state" / "events" / "runs.ndjson"
    # 1h baseline window with equal spend to recent window
    # recent window: NOW-1h to NOW => 1.0 USD
    # baseline window: NOW-2h to NOW-1h => 1.0 USD (same normalized)
    recent_ts = (NOW - timedelta(minutes=30)).isoformat()
    baseline_ts = (NOW - timedelta(hours=1, minutes=30)).isoformat()
    _write_run_cost(runs, ts=recent_ts, cost_usd=1.0)
    _write_run_cost(runs, ts=baseline_ts, cost_usd=1.0)
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path, window=timedelta(hours=1), baseline_window=timedelta(hours=1))
    assert result["ratio"] == pytest.approx(1.0)


def test_higher_recent_spend_ratio_above_one(tmp_path: Path) -> None:
    runs = tmp_path / "state" / "events" / "runs.ndjson"
    # recent: 10 USD, baseline: 1 USD (same window size) => ratio 10
    recent_ts = (NOW - timedelta(minutes=30)).isoformat()
    baseline_ts = (NOW - timedelta(hours=1, minutes=30)).isoformat()
    _write_run_cost(runs, ts=recent_ts, cost_usd=10.0)
    _write_run_cost(runs, ts=baseline_ts, cost_usd=1.0)
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path, window=timedelta(hours=1), baseline_window=timedelta(hours=1))
    assert result["ratio"] == pytest.approx(10.0)


def test_spend_stream_preferred_over_runs(tmp_path: Path) -> None:
    # Put conflicting data: spend says 5.0, runs says 100.0
    spend = tmp_path / "state" / "events" / "spend.ndjson"
    runs = tmp_path / "state" / "events" / "runs.ndjson"
    recent_ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_spend(spend, ts=recent_ts, cost_usd=5.0)
    _write_run_cost(runs, ts=recent_ts, cost_usd=100.0)
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path, window=timedelta(hours=1), baseline_window=timedelta(hours=6))
    assert result["recent_usd"] == pytest.approx(5.0)


def test_window_hours_returned(tmp_path: Path) -> None:
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(
            root=tmp_path,
            window=timedelta(hours=2),
            baseline_window=timedelta(hours=12),
        )
    assert result["recent_window_hours"] == pytest.approx(2.0)
    assert result["baseline_window_hours"] == pytest.approx(12.0)


def test_events_outside_windows_excluded(tmp_path: Path) -> None:
    runs = tmp_path / "state" / "events" / "runs.ndjson"
    # Very old event — should be excluded from both windows
    old_ts = (NOW - timedelta(hours=20)).isoformat()
    recent_ts = (NOW - timedelta(minutes=30)).isoformat()
    _write_run_cost(runs, ts=old_ts, cost_usd=1000.0)
    _write_run_cost(runs, ts=recent_ts, cost_usd=1.0)
    with patch("factory.manager.detectors.cost_spike._now_utc", return_value=NOW):
        result = cost_spike(root=tmp_path, window=timedelta(hours=1), baseline_window=timedelta(hours=6))
    assert result["recent_usd"] == pytest.approx(1.0)
    assert math.isinf(result["ratio"])
