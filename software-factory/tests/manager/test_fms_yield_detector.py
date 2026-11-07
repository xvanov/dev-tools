"""Tests for the fms_yield detector — the FMS's self-observation channel.

Regression cover for the 2026-07-24 audit finding: the FMS ran 59 days at a
measured yield of zero and nothing in the system could notice, because every
detector watched the production chain and none watched the manager.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.manager.detectors.fms_yield import _parse_ts, fms_yield

NOW = datetime(2026, 7, 24, 12, 0, 0, tzinfo=UTC)


def _write_history(root: Path, entries: list[dict]) -> None:
    (root / "state").mkdir(parents=True, exist_ok=True)
    (root / "state" / ".manager_apply_history.json").write_text(
        json.dumps(entries), encoding="utf-8"
    )


def _write_runs(root: Path, rows: list[dict]) -> None:
    d = root / "state" / "events"
    d.mkdir(parents=True, exist_ok=True)
    (d / "runs.ndjson").write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
    )


def test_empty_root_reports_zeroes(tmp_path: Path) -> None:
    r = fms_yield(root=tmp_path, now=NOW)
    assert r["attempts"] == 0
    assert r["shipped"] == 0
    assert r["spend_per_shipped_usd"] is None


def test_compact_timestamps_are_parsed_not_string_compared(tmp_path: Path) -> None:
    """The bug this guards: L4 writes ``20260527T135919`` while the streams write
    ISO-8601. A lexicographic compare between the two is always true (``'0' >
    '-'``), which silently turns the window filter into a no-op."""
    _write_history(
        tmp_path,
        [
            {"ts": "20260527T135919", "status": "abandoned"},  # ~2 months old
            {"ts": "20260723T174823", "status": "abandoned"},  # yesterday
        ],
    )
    week = fms_yield(root=tmp_path, window=timedelta(days=7), now=NOW)
    assert week["attempts"] == 1, "old compact-ts entry leaked into a 7-day window"
    assert week["attempts_all_time"] == 2


def test_parse_ts_handles_both_formats_and_junk() -> None:
    assert _parse_ts("20260527T135919") == datetime(2026, 5, 27, 13, 59, 19, tzinfo=UTC)
    assert _parse_ts("2026-05-27T13:59:19+00:00") == datetime(
        2026, 5, 27, 13, 59, 19, tzinfo=UTC
    )
    # Naive ISO is assumed UTC rather than rejected.
    assert _parse_ts("2026-05-27T13:59:19") == datetime(2026, 5, 27, 13, 59, 19, tzinfo=UTC)
    assert _parse_ts("nonsense") is None
    assert _parse_ts(None) is None
    assert _parse_ts(12345) is None


def test_zero_yield_with_spend_is_visible(tmp_path: Path) -> None:
    """The exact production condition: many attempts, none shipped, real spend."""
    _write_history(
        tmp_path,
        [{"ts": "20260723T120000", "status": "abandoned", "error": "dirty_working_tree"}] * 5,
    )
    _write_runs(
        tmp_path,
        [
            {"ts": "2026-07-23T12:00:00+00:00", "persona": "manager_watcher", "cost_usd": 3.0},
            {"ts": "2026-07-23T12:00:00+00:00", "persona": "dev", "cost_usd": 99.0},
        ],
    )
    r = fms_yield(root=tmp_path, now=NOW)
    assert r["attempts"] == 5
    assert r["shipped"] == 0
    assert r["spend_per_shipped_usd"] is None, "zero-yield must not divide"
    assert r["manager_spend_usd"] == 3.0, "must count manager personas only, not dev"
    # A single dominant error is the signature of a systematic wiring bug.
    assert r["top_errors"][0]["error"] == "dirty_working_tree"
    assert r["top_errors"][0]["count"] == 5


def test_shipped_statuses_counted_and_ratio_computed(tmp_path: Path) -> None:
    _write_history(
        tmp_path,
        [
            {"ts": "20260723T120000", "status": "opened_pr"},
            {"ts": "20260723T120001", "status": "applied"},
            {"ts": "20260723T120002", "status": "queued_for_review"},
            {"ts": "20260723T120003", "status": "abandoned"},
        ],
    )
    _write_runs(
        tmp_path,
        [{"ts": "2026-07-23T12:00:00+00:00", "persona": "manager_diagnostician", "cost_usd": 6.0}],
    )
    r = fms_yield(root=tmp_path, now=NOW)
    assert r["shipped"] == 3
    assert r["shipped_all_time"] == 3
    assert r["spend_per_shipped_usd"] == 2.0


def test_corrupt_history_does_not_raise(tmp_path: Path) -> None:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "state" / ".manager_apply_history.json").write_text("{not json", encoding="utf-8")
    r = fms_yield(root=tmp_path, now=NOW)
    assert r["attempts"] == 0
