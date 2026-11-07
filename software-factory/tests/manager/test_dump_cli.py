"""Verify `factory manager signals dump` shows events from the fixture streams."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from factory.cli import app


@pytest.fixture
def events_root(tmp_path: Path) -> Path:
    """Write fixture events into tmp_path/state/events/."""
    events_dir = tmp_path / "state" / "events"
    events_dir.mkdir(parents=True)

    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)

    # Two ticks events (recent).
    ticks_lines = [
        json.dumps(
            {
                "ts": (now - timedelta(minutes=5)).isoformat(),
                "schema_version": 1,
                "event": "tick_start",
                "tick_id": "abc",
                "app": "testapp",
                "dry_run": True,
            }
        ),
        json.dumps(
            {
                "ts": (now - timedelta(minutes=4)).isoformat(),
                "schema_version": 1,
                "event": "tick_end",
                "tick_id": "abc",
                "app": "testapp",
                "dry_run": True,
                "duration_s": 0.5,
            }
        ),
    ]
    (events_dir / "ticks.ndjson").write_text("\n".join(ticks_lines) + "\n", encoding="utf-8")

    # One runs event (recent).
    runs_line = json.dumps(
        {
            "ts": (now - timedelta(minutes=3)).isoformat(),
            "schema_version": 1,
            "event": "run",
            "persona": "sm",
            "story_id": 7,
            "success": True,
            "duration_s": 1.2,
        }
    )
    (events_dir / "runs.ndjson").write_text(runs_line + "\n", encoding="utf-8")

    # One event that's too old (should be filtered out).
    old_line = json.dumps(
        {
            "ts": (now - timedelta(hours=3)).isoformat(),
            "schema_version": 1,
            "event": "tick_start",
            "tick_id": "old",
            "app": "testapp",
            "dry_run": True,
        }
    )
    # Append to ticks so we can check it's filtered.
    with (events_dir / "ticks.ndjson").open("a", encoding="utf-8") as fh:
        fh.write(old_line + "\n")

    return tmp_path


def test_dump_shows_recent_events(events_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("factory.cli._FACTORY_ROOT", events_root)

    runner = CliRunner()
    result = runner.invoke(app, ["manager", "signals", "dump", "--since", "1h"])
    assert result.exit_code == 0, f"exit={result.exit_code}\n{result.output}"
    output = result.output

    # Should contain both tick events and the runs event.
    assert "tick_start" in output, f"tick_start missing from:\n{output}"
    assert "tick_end" in output, f"tick_end missing from:\n{output}"
    assert "run" in output, f"run event missing from:\n{output}"

    # Old event (3h ago) should NOT appear with --since 1h.
    assert output.count("tick_id='old'") == 0, "old event should be filtered"


def test_dump_stream_filter(events_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("factory.cli._FACTORY_ROOT", events_root)

    runner = CliRunner()
    result = runner.invoke(app, ["manager", "signals", "dump", "--since", "1h", "--stream", "runs"])
    assert result.exit_code == 0
    output = result.output
    assert "run" in output
    # tick events shouldn't appear when filtering to runs stream.
    assert "tick_start" not in output
    assert "tick_end" not in output


def test_dump_json_format(events_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("factory.cli._FACTORY_ROOT", events_root)

    runner = CliRunner()
    result = runner.invoke(app, ["manager", "signals", "dump", "--since", "1h", "--format", "json"])
    assert result.exit_code == 0
    lines = [ln for ln in result.output.splitlines() if ln.strip()]
    # All lines should be valid JSON.
    for ln in lines:
        rec = json.loads(ln)
        assert "event" in rec
