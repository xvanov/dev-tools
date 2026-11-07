"""Tests for response-BODY capture and OpenHands trajectory copy-out.

The other half of ``test_runner_prompt_bodies.py``: the factory captured every
prompt verbatim but NOTHING of what the model said back. Two artifacts close
that gap:

1. ``response_bodies.ndjson`` — the model's textual response per persona call,
   hash-chained, joinable to its prompt row via the full prompt sha256.
2. ``state/events/trajectories/<story>-<attempt>.ndjson`` — the full OpenHands
   event stream (agent messages, tool calls, observations) copied out of the
   SDK's persistence dir after every sandbox (dev) run.
"""

from __future__ import annotations

import hashlib
import json
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from factory.runner import (
    _capture_trajectory,
    _gc_trajectories,
    _log_prompt_body,
    _log_response_body,
    _reap_stale_traj_persist_dirs,
    text_run,
)


def _read_stream(root: Path, name: str) -> list[dict]:
    stream = root / "state" / "events" / f"{name}.ndjson"
    if not stream.exists():
        return []
    return [
        json.loads(line)
        for line in stream.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


# --------------------------------------------------------------------------- #
# _log_response_body
# --------------------------------------------------------------------------- #


def test_response_stream_records_full_text_and_joins_the_prompt(tmp_path: Path) -> None:
    prompt = "## Story\nreview this diff\n"
    response = "APPROVED — two nits, neither blocking."
    _log_prompt_body(
        persona="reviewer",
        prompt=prompt,
        model_id="stub/model",
        story_id=9,
        software_factory_root=tmp_path,
    )
    _log_response_body(
        persona="reviewer",
        response=response,
        prompt=prompt,
        model_id="stub/model",
        story_id=9,
        software_factory_root=tmp_path,
    )
    rec = _read_stream(tmp_path, "response_bodies")[0]
    assert rec["event"] == "response_body"
    assert rec["persona"] == "reviewer"
    assert rec["story_id"] == 9
    assert rec["response"] == response
    assert rec["response_length_total"] == len(response)
    assert rec["response_hash"] == hashlib.sha256(response.encode()).hexdigest()
    # The join: the response row carries the FULL sha256 of the same prompt
    # bytes the prompt-body row hashed.
    body = _read_stream(tmp_path, "prompt_bodies")[0]
    assert rec["prompt_hash"] == body["prompt_hash"]


def test_response_bodies_are_hash_chained(tmp_path: Path) -> None:
    for i in range(3):
        _log_response_body(
            persona="pm",
            response=f"verdict {i}",
            prompt=f"prompt {i}",
            model_id="stub/model",
            story_id=i,
            software_factory_root=tmp_path,
        )
    records = _read_stream(tmp_path, "response_bodies")
    assert len(records) == 3
    assert all("entry_hash" in r and "prev_hash" in r for r in records), records
    for earlier, later in zip(records[:-1], records[1:], strict=True):
        assert later["prev_hash"] == earlier["entry_hash"]


def test_response_capture_respects_the_prompt_body_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One config surface: FACTORY_PROMPT_BODIES governs BOTH body streams."""
    monkeypatch.setenv("FACTORY_PROMPT_BODIES", "off")
    _log_response_body(
        persona="reviewer",
        response="x",
        prompt="p",
        model_id="stub/model",
        story_id=1,
        software_factory_root=tmp_path,
    )
    assert _read_stream(tmp_path, "response_bodies") == []

    monkeypatch.delenv("FACTORY_PROMPT_BODIES", raising=False)
    _log_response_body(
        persona="manager_watcher",
        response="firehose",
        prompt="p",
        model_id="stub/model",
        story_id=None,
        software_factory_root=tmp_path,
    )
    assert _read_stream(tmp_path, "response_bodies") == []


def test_sandbox_mode_row_carries_the_trajectory_path(tmp_path: Path) -> None:
    _log_response_body(
        persona="dev",
        response="SELF_SUMMARY: did the thing.",
        prompt="p",
        model_id="stub/model",
        story_id=3,
        software_factory_root=tmp_path,
        mode="sandbox",
        trajectory_path="/state/events/trajectories/3-1.ndjson",
    )
    rec = _read_stream(tmp_path, "response_bodies")[0]
    assert rec["mode"] == "sandbox"
    assert rec["trajectory_path"] == "/state/events/trajectories/3-1.ndjson"


def test_none_response_is_recorded_not_raised(tmp_path: Path) -> None:
    """Providers can return content=None alongside tool calls; the writer must
    record that shape, not silently swallow a TypeError."""
    _log_response_body(
        persona="pm",
        response=None,  # type: ignore[arg-type]
        prompt="p",
        model_id="stub/model",
        story_id=1,
        software_factory_root=tmp_path,
    )
    rec = _read_stream(tmp_path, "response_bodies")[0]
    assert rec["response"] == ""


def test_log_response_body_never_raises_on_bad_root(tmp_path: Path) -> None:
    bogus_parent = tmp_path / "not-a-dir"
    bogus_parent.write_text("file-not-dir\n", encoding="utf-8")
    _log_response_body(
        persona="dev",
        response="x",
        prompt="p",
        model_id="stub/model",
        story_id=None,
        software_factory_root=bogus_parent,
    )


# --------------------------------------------------------------------------- #
# text_run wiring — a chain persona call with a fake model client
# --------------------------------------------------------------------------- #


class _FakeResponse(dict):
    """Duck-types the litellm ModelResponse surface text_run touches."""

    def __init__(self, content: str) -> None:
        super().__init__(
            choices=[{"message": {"content": content}, "finish_reason": "stop"}],
            usage={"prompt_tokens": 12, "completion_tokens": 5},
        )
        self._hidden_params = {"response_cost": 0.0001}


def _fake_litellm(content: str) -> types.ModuleType:
    mod = types.ModuleType("litellm")

    def completion(**kwargs: Any) -> _FakeResponse:
        return _FakeResponse(content)

    mod.completion = completion  # type: ignore[attr-defined]
    return mod


def test_text_run_writes_the_response_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runner-layer contract: one chain persona call → one prompt-body row
    AND one response-body row, joinable by prompt_hash."""
    prompt = "## Story\nfoo\n## PR diff\nbar\n"
    verdict = '{"approved": true, "findings": []}'
    monkeypatch.setitem(sys.modules, "litellm", _fake_litellm(verdict))
    out = text_run(
        persona="reviewer",
        prompt=prompt,
        model_id="stub/model",
        api_key="test-key",
        story_id=7,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    assert out == verdict
    bodies = _read_stream(tmp_path, "prompt_bodies")
    responses = _read_stream(tmp_path, "response_bodies")
    assert len(bodies) == 1
    assert len(responses) == 1
    rec = responses[0]
    assert rec["persona"] == "reviewer"
    assert rec["story_id"] == 7
    assert rec["model_id"] == "stub/model"
    assert rec["response"] == verdict
    assert rec["prompt_hash"] == bodies[0]["prompt_hash"]


def test_text_run_json_parse_failure_still_captures_the_raw_response(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The response is MOST valuable when the call fails: an unparseable
    JSON-mode reply must land in the stream before the raise."""
    monkeypatch.setitem(sys.modules, "litellm", _fake_litellm("not json at all"))
    with pytest.raises(RuntimeError, match="not valid JSON"):
        text_run(
            persona="pm",
            prompt="triage this",
            model_id="stub/model",
            schema={"type": "object"},
            api_key="test-key",
            story_id=None,
            software_factory_root=tmp_path,
            db_path=tmp_path / "state" / "factory.db",
        )
    responses = _read_stream(tmp_path, "response_bodies")
    assert len(responses) == 1
    assert responses[0]["response"] == "not json at all"


# --------------------------------------------------------------------------- #
# _capture_trajectory — the sandbox boundary, mocked on disk
# --------------------------------------------------------------------------- #


def _fake_openhands_events(src: Path, n: int = 3) -> list[dict[str, Any]]:
    """Lay out event files exactly where the pinned SDK (1.22.1) leaves them:
    ``<persistence_dir>/<conv_id.hex>/events/event-NNNNN-<uuid>.json``."""
    src.mkdir(parents=True, exist_ok=True)
    events = []
    for i in range(n):
        ev = {
            "id": f"0000000{i}-aaaa-bbbb-cccc-ddddeeee000{i}",
            "source": "agent",
            "llm_message": {"content": [{"type": "text", "text": f"thinking step {i}"}]},
        }
        (src / f"event-{i:05d}-{ev['id']}.json").write_text(
            json.dumps(ev), encoding="utf-8"
        )
        events.append(ev)
    return events


def test_trajectory_lands_in_per_story_state(tmp_path: Path) -> None:
    src = tmp_path / "persist" / "abc123" / "events"
    events = _fake_openhands_events(src, n=3)
    written = _capture_trajectory(
        events_src=src,
        story_id=42,
        attempt=2,
        software_factory_root=tmp_path,
    )
    dest = tmp_path / "state" / "events" / "trajectories" / "42-2.ndjson"
    assert written == str(dest)
    assert dest.exists()
    lines = [json.loads(x) for x in dest.read_text(encoding="utf-8").splitlines()]
    assert lines == events  # captured whole, in order, no filtering


def test_trajectory_is_size_capped_with_a_truncation_marker(tmp_path: Path) -> None:
    src = tmp_path / "persist" / "abc123" / "events"
    _fake_openhands_events(src, n=5)
    one_line_bytes = len(json.dumps(json.loads((src / sorted(p.name for p in src.iterdir())[0]).read_text()), separators=(",", ":"))) + 1
    written = _capture_trajectory(
        events_src=src,
        story_id=1,
        attempt=1,
        software_factory_root=tmp_path,
        max_bytes=one_line_bytes * 2 + 10,  # room for 2 events, not 5
    )
    assert written is not None
    lines = [json.loads(x) for x in Path(written).read_text(encoding="utf-8").splitlines()]
    marker = lines[-1]
    assert marker["event"] == "trajectory_truncated"
    assert marker["events_written"] == 2
    assert marker["events_omitted"] == 3


def test_trajectory_does_not_overwrite_an_existing_attempt_file(tmp_path: Path) -> None:
    src = tmp_path / "persist" / "abc123" / "events"
    _fake_openhands_events(src, n=1)
    first = _capture_trajectory(
        events_src=src, story_id=5, attempt=1, software_factory_root=tmp_path
    )
    second = _capture_trajectory(
        events_src=src, story_id=5, attempt=1, software_factory_root=tmp_path
    )
    assert first is not None and second is not None
    assert first != second
    assert Path(first).exists() and Path(second).exists()


def test_trajectory_capture_returns_none_when_nothing_persisted(tmp_path: Path) -> None:
    assert (
        _capture_trajectory(
            events_src=tmp_path / "nowhere" / "events",
            story_id=1,
            attempt=1,
            software_factory_root=tmp_path,
        )
        is None
    )


def test_trajectory_dir_is_gc_ed_to_a_byte_budget_oldest_first(tmp_path: Path) -> None:
    """One multi-MB file lands per dev call and nothing else deletes them —
    without a sweep the directory grows without bound in production."""
    import os

    traj_dir = tmp_path / "trajectories"
    traj_dir.mkdir()
    for i in range(4):
        p = traj_dir / f"{i}-1.ndjson"
        p.write_text("x" * 100, encoding="utf-8")
        os.utime(p, (1000 + i, 1000 + i))  # 0-1 oldest ... 3-1 newest
    newest = traj_dir / "3-1.ndjson"
    _gc_trajectories(traj_dir, max_total_bytes=250, keep=newest)
    survivors = sorted(p.name for p in traj_dir.glob("*.ndjson"))
    # 400 bytes -> 250 budget: the two OLDEST are evicted, newest two remain.
    assert survivors == ["2-1.ndjson", "3-1.ndjson"]


def test_trajectory_gc_never_deletes_the_file_just_written(tmp_path: Path) -> None:
    import os

    traj_dir = tmp_path / "trajectories"
    traj_dir.mkdir()
    kept = traj_dir / "1-1.ndjson"
    kept.write_text("x" * 100, encoding="utf-8")
    os.utime(kept, (1000, 1000))  # oldest by mtime AND alone over budget
    _gc_trajectories(traj_dir, max_total_bytes=10, keep=kept)
    assert kept.exists()


def test_trajectory_gc_runs_as_part_of_capture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sweep is wired into the copy-out itself, not a separate cron: a
    single _capture_trajectory call must both write the new file AND evict
    the oldest one beyond the budget."""
    import os

    from factory import runner

    src = tmp_path / "persist" / "abc123" / "events"
    _fake_openhands_events(src, n=1)
    traj_dir = tmp_path / "state" / "events" / "trajectories"
    traj_dir.mkdir(parents=True)
    old = traj_dir / "6-1.ndjson"
    old.write_text("x" * 5000, encoding="utf-8")
    os.utime(old, (1000, 1000))
    monkeypatch.setattr(runner, "_TRAJECTORIES_TOTAL_MAX_BYTES", 1000)

    written = _capture_trajectory(
        events_src=src, story_id=7, attempt=1, software_factory_root=tmp_path
    )

    assert written is not None
    assert Path(written).exists()
    assert not old.exists()


def test_stale_persist_dirs_are_reaped_fresh_ones_are_not(tmp_path: Path) -> None:
    """The timeout path deliberately leaks its factory-oh-traj-* dir (an
    orphaned writer thread may still be using it); the age-based sweep at the
    NEXT sandbox setup is what reaps it."""
    import os
    import time

    old_dir = tmp_path / "factory-oh-traj-old"
    old_dir.mkdir()
    (old_dir / "leftover.json").write_text("{}", encoding="utf-8")
    stale = time.time() - 25 * 3600
    os.utime(old_dir, (stale, stale))
    fresh_dir = tmp_path / "factory-oh-traj-fresh"
    fresh_dir.mkdir()
    unrelated = tmp_path / "some-other-dir"
    unrelated.mkdir()

    _reap_stale_traj_persist_dirs(tmp_path)

    assert not old_dir.exists()
    assert fresh_dir.exists()
    assert unrelated.exists()


def test_reap_never_raises_on_missing_tmp_root(tmp_path: Path) -> None:
    _reap_stale_traj_persist_dirs(tmp_path / "does-not-exist")


def test_trajectory_capture_never_raises_on_bad_root(tmp_path: Path) -> None:
    src = tmp_path / "persist" / "abc123" / "events"
    _fake_openhands_events(src, n=1)
    bogus_parent = tmp_path / "not-a-dir"
    bogus_parent.write_text("file-not-dir\n", encoding="utf-8")
    assert (
        _capture_trajectory(
            events_src=src, story_id=1, attempt=1, software_factory_root=bogus_parent
        )
        is None
    )


# --------------------------------------------------------------------------- #
# text_run(messages=…) — a real multi-turn role list on the wire
# --------------------------------------------------------------------------- #


def _recording_litellm(
    monkeypatch: pytest.MonkeyPatch, content: str
) -> dict[str, Any]:
    """Install a fake litellm that records the kwargs it was called with."""
    seen: dict[str, Any] = {}
    mod = types.ModuleType("litellm")

    def completion(**kwargs: Any) -> _FakeResponse:
        seen.update(kwargs)
        return _FakeResponse(content)

    mod.completion = completion  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "litellm", mod)
    return seen


def test_text_run_sends_a_caller_supplied_role_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Multi-turn callers need real roles, and the reason is not cosmetic: the
    SWE-bench bare arm collapsed its whole conversation into ONE flat user
    string, so the model could not tell its own previous text from the
    environment's replies — and 76 of 231 measured replies then contained a
    fabricated ``Exit 0 / Output: / Result:`` block that it read back as a real
    tool result. ``prompt`` stays the telemetry view, so one call is still one
    auditable row."""
    seen = _recording_litellm(monkeypatch, "ok")
    convo = [
        {"role": "system", "content": "you are a shell"},
        {"role": "user", "content": "fix the bug"},
        {"role": "assistant", "content": "BASH\nls"},
        {"role": "user", "content": "Exit 0. Output:\nwidget.py"},
    ]
    text_run(
        persona="dev",
        prompt="TELEMETRY VIEW",
        messages=convo,
        model_id="stub/model",
        api_key="test-key",
        story_id=None,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    assert seen["messages"] == convo
    assert _read_stream(tmp_path, "prompt_bodies")[0]["prompt"] == "TELEMETRY VIEW"


def test_text_run_without_messages_is_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _recording_litellm(monkeypatch, "ok")
    text_run(
        persona="sm",
        prompt="just one turn",
        model_id="stub/model",
        api_key="test-key",
        story_id=None,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    assert seen["messages"] == [{"role": "user", "content": "just one turn"}]


def test_json_mode_owns_the_message_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caller passing BOTH ``schema`` and ``messages`` must not lose the schema
    instruction — JSON mode wins, predictably."""
    seen = _recording_litellm(monkeypatch, '{"ok": true}')
    text_run(
        persona="pm",
        prompt="triage",
        messages=[{"role": "assistant", "content": "ignored"}],
        schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
        model_id="stub/model",
        api_key="test-key",
        story_id=None,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    assert len(seen["messages"]) == 1
    assert seen["messages"][0]["role"] == "user"
    assert "Return ONLY a JSON object" in seen["messages"][0]["content"]
