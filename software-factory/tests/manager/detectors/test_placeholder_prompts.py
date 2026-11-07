"""Tests for the ``placeholder_prompts`` detector."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.manager.detectors.placeholder_prompts import placeholder_prompts


def _write_events(path: Path, lines: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line) + "\n")


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=1)


def test_returns_empty_when_stream_missing(tmp_path: Path) -> None:
    assert placeholder_prompts(root=tmp_path, since=SINCE) == []


def test_returns_only_records_with_markers(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "prompts.ndjson"
    _write_events(
        stream,
        [
            {
                "ts": NOW.isoformat(),
                "event": "prompt",
                "persona": "reviewer",
                "placeholder_markers_found": [],
            },
            {
                "ts": NOW.isoformat(),
                "event": "prompt",
                "persona": "tech_writer",
                "placeholder_markers_found": ["(fetched from GitHub by the chain"],
            },
        ],
    )
    out = placeholder_prompts(root=tmp_path, since=SINCE)
    assert len(out) == 1
    assert out[0]["persona"] == "tech_writer"
    assert out[0]["severity"] == "high"


def test_respects_since_window(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "prompts.ndjson"
    too_old = (NOW - timedelta(hours=3)).isoformat()
    in_window = NOW.isoformat()
    _write_events(
        stream,
        [
            {
                "ts": too_old,
                "event": "prompt",
                "persona": "reviewer",
                "placeholder_markers_found": ["placeholder for real-run"],
            },
            {
                "ts": in_window,
                "event": "prompt",
                "persona": "reviewer",
                "placeholder_markers_found": ["placeholder for real-run"],
            },
        ],
    )
    out = placeholder_prompts(root=tmp_path, since=SINCE)
    assert len(out) == 1
    assert out[0]["ts"] == in_window


def test_skips_manager_personas_to_break_amplification_loop(tmp_path: Path) -> None:
    """Manager prompts echo this detector's own rows back, so scanning them
    self-triggers. The detector must ignore ``manager_*`` personas even when
    their records carry markers, while still surfacing real chain leaks."""
    stream = tmp_path / "state" / "events" / "prompts.ndjson"
    _write_events(
        stream,
        [
            {
                "ts": NOW.isoformat(),
                "event": "prompt",
                "persona": "manager_watcher",
                "placeholder_markers_found": [
                    "(fetched from GitHub by the chain",
                    "placeholder for real-run",
                    "(see {",
                ],
            },
            {
                "ts": NOW.isoformat(),
                "event": "prompt",
                "persona": "reviewer",
                "placeholder_markers_found": ["(see {"],
            },
        ],
    )
    out = placeholder_prompts(root=tmp_path, since=SINCE)
    assert len(out) == 1
    assert out[0]["persona"] == "reviewer"


def test_skips_malformed_lines(tmp_path: Path) -> None:
    stream = tmp_path / "state" / "events" / "prompts.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text(
        "not-json\n"
        + json.dumps(
            {
                "ts": NOW.isoformat(),
                "event": "prompt",
                "persona": "reviewer",
                "placeholder_markers_found": ["(see {"],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    out = placeholder_prompts(root=tmp_path, since=SINCE)
    assert len(out) == 1
