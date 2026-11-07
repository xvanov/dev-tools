"""Verify write_event appends one valid JSONL line per call."""

from __future__ import annotations

import json
from pathlib import Path

from factory.manager.signals import write_event


def test_writes_three_events_three_lines(tmp_path: Path) -> None:
    for i in range(3):
        write_event("runs", {"event": "run", "x": i}, software_factory_root=tmp_path)

    out_path = tmp_path / "state" / "events" / "runs.ndjson"
    assert out_path.exists(), f"expected {out_path}"
    lines = [ln for ln in out_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 3, f"expected 3 lines, got {len(lines)}: {lines}"
    for ln in lines:
        rec = json.loads(ln)
        assert "ts" in rec, "ts field must be present"
        assert rec["schema_version"] == 1, "schema_version must be 1"
        assert rec["event"] == "run"


def test_ts_is_populated_when_absent(tmp_path: Path) -> None:
    write_event("ticks", {"event": "tick_start"}, software_factory_root=tmp_path)
    out = (tmp_path / "state" / "events" / "ticks.ndjson").read_text(encoding="utf-8")
    rec = json.loads(out.strip())
    assert rec["ts"]  # not empty
    assert "T" in rec["ts"] or rec["ts"].count("-") >= 2  # ISO-8601 shape


def test_ts_passthrough_when_provided(tmp_path: Path) -> None:
    write_event(
        "ticks",
        {"event": "tick_end", "ts": "2026-01-01T00:00:00+00:00"},
        software_factory_root=tmp_path,
    )
    out = (tmp_path / "state" / "events" / "ticks.ndjson").read_text(encoding="utf-8")
    rec = json.loads(out.strip())
    assert rec["ts"] == "2026-01-01T00:00:00+00:00"
