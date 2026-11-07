"""Per-story event log — append-only JSONL audit trail.

The log is the source-of-truth for ``factory why`` and ``factory trace``.
It must:
  * write one JSONL record per call
  * never raise (best-effort: errors stderr-log, never propagate)
  * handle non-serializable payloads gracefully (repr fallback)
  * survive parallel-ish writes without corruption
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory.chain.event_log import _story_log_path, log_story_event, read_story_events


def test_log_writes_one_jsonl_record(tmp_path: Path) -> None:
    log_story_event(
        42,
        "handler_start",
        {"handler": "sm", "from_state": "story_created"},
        software_factory_root=tmp_path,
        slug_hint="d007-backend",
    )
    path = _story_log_path(42, tmp_path, "d007-backend")
    assert path is not None and path.exists()
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["story_id"] == 42
    assert rec["event"] == "handler_start"
    assert rec["handler"] == "sm"
    assert "ts" in rec


def test_log_appends_subsequent_events(tmp_path: Path) -> None:
    for i in range(5):
        log_story_event(7, f"step_{i}", {"i": i}, software_factory_root=tmp_path, slug_hint="x")
    events = read_story_events(7, software_factory_root=tmp_path, slug_hint="x")
    assert [e["event"] for e in events] == [f"step_{i}" for i in range(5)]


def test_log_handles_non_serializable_payload(tmp_path: Path) -> None:
    class Weird:
        def __repr__(self) -> str:
            return "<weird>"

    log_story_event(
        1,
        "x",
        {"good": "ok", "bad": Weird()},
        software_factory_root=tmp_path,
        slug_hint="z",
    )
    events = read_story_events(1, software_factory_root=tmp_path, slug_hint="z")
    assert events[0]["good"] == "ok"
    assert events[0]["bad"] == "<weird>"


def test_log_swallows_io_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # Point the root at a file (not a dir) so ``mkdir(parents=True)`` blows up
    # in a way the helper must catch.
    blocker = tmp_path / "block"
    blocker.write_text("x", encoding="utf-8")
    log_story_event(
        99,
        "x",
        {"a": 1},
        software_factory_root=blocker,  # not a directory — will trip mkdir
        slug_hint="z",
    )
    # No exception propagated — the helper logged to stderr instead.
    err = capsys.readouterr().err
    assert "event_log" in err or err == ""  # tolerant either way


def test_read_returns_empty_for_missing(tmp_path: Path) -> None:
    assert read_story_events(404, software_factory_root=tmp_path, slug_hint="ghost") == []


def test_read_limit_takes_tail(tmp_path: Path) -> None:
    for i in range(10):
        log_story_event(3, f"e{i}", software_factory_root=tmp_path, slug_hint="s")
    tail = read_story_events(3, software_factory_root=tmp_path, slug_hint="s", limit=3)
    assert [e["event"] for e in tail] == ["e7", "e8", "e9"]


def test_read_tolerates_malformed_lines(tmp_path: Path) -> None:
    path = _story_log_path(8, tmp_path, "broken")
    assert path is not None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        '{"event":"a","ts":"x","story_id":8}\n'
        "this-is-not-json\n"
        '{"event":"b","ts":"y","story_id":8}\n',
        encoding="utf-8",
    )
    events = read_story_events(8, software_factory_root=tmp_path, slug_hint="broken")
    assert [e["event"] for e in events] == ["a", "malformed_log_line", "b"]
