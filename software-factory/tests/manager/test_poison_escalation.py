"""Tests for factory.manager.poison_escalation — surface poisoned rows (#96).

A persistent invalid-enum ("poisoned") story row is silently re-skipped every
tick. This module escalates it to a GitHub issue ONCE per cooldown window,
deduped on a stable signature (mirroring the L2 concern dedup) and reusing the
shared escalation-to-GitHub-issue channel. gh is mocked; no network is touched.

Coverage:
  * a recent tick_end with skipped>0 + a poisoned DB row opens ONE gh issue
  * a second cycle within cooldown is SUPPRESSED (no second gh issue) — dedup
  * no recent skip signal → no escalation (no gh call)
  * no poisoned rows (already reconciled) → no escalation
  * recent_skipped_total reads the tick_end skipped count
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlmodel import Session, SQLModel, create_engine

from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager import poison_escalation as pe


@dataclass
class _Completed:
    returncode: int
    stdout: str = ""
    stderr: str = ""


def _make_gh_runner() -> tuple[Callable[..., Any], list[list[str]]]:
    """gh mock: no pre-existing issues, ``issue create`` returns #777."""
    calls: list[list[str]] = []

    def _runner(args: list[str], **kwargs: Any) -> Any:
        calls.append(list(args))
        if args[:3] == ["gh", "issue", "list"]:
            return _Completed(returncode=0, stdout="[]")
        if args[:3] == ["gh", "label", "create"]:
            return _Completed(returncode=0)
        if args[:3] == ["gh", "issue", "create"]:
            return _Completed(
                returncode=0,
                stdout="https://github.com/owner/repo/issues/777\n",
            )
        return _Completed(returncode=0)

    return _runner, calls


def _db_path(root: Path) -> Path:
    return root / "state" / "factory.db"


def _add_story(root: Path, **kwargs: Any) -> int:
    (root / "state").mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{_db_path(root)}", echo=False)
    SQLModel.metadata.create_all(eng)
    defaults: dict[str, Any] = dict(
        direction_id="001",
        app="sacrifice",
        title="t",
        slug="poisoned",
        scope="backend",
        state="abandoned",  # not a StoryState value
    )
    defaults.update(kwargs)
    with Session(eng) as session:
        story = StoryRecord(**defaults)
        session.add(story)
        session.commit()
        session.refresh(story)
        return story.id


def _write_tick_end(root: Path, *, skipped: int, ts: datetime) -> None:
    """Append a tick_end event carrying the skipped count (Part 1 shape)."""
    events = root / "state" / "events"
    events.mkdir(parents=True, exist_ok=True)
    rec = {
        "ts": ts.isoformat(),
        "schema_version": 1,
        "event": "tick_end",
        "tick_id": "t1",
        "app": "sacrifice",
        "dry_run": False,
        "skipped": skipped,
    }
    with (events / "ticks.ndjson").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")


def _create_calls(calls: list[list[str]]) -> list[list[str]]:
    return [c for c in calls if c[:3] == ["gh", "issue", "create"]]


# --------------------------------------------------------------------------- #
# recent_skipped_total
# --------------------------------------------------------------------------- #


def test_recent_skipped_total_reads_tick_end(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    _write_tick_end(tmp_path, skipped=0, ts=now - timedelta(minutes=5))
    _write_tick_end(tmp_path, skipped=2, ts=now - timedelta(minutes=3))
    assert pe.recent_skipped_total(tmp_path, now=now) == 2


def test_recent_skipped_total_ignores_stale_events(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    _write_tick_end(tmp_path, skipped=5, ts=now - timedelta(hours=6))  # outside lookback
    assert pe.recent_skipped_total(tmp_path, now=now) == 0


def test_signature_stable_and_order_independent() -> None:
    a = [
        {"app": "x", "story_id": 1, "invalid_state": "s"},
        {"app": "y", "story_id": 2, "invalid_state": "t"},
    ]
    b = list(reversed(a))
    assert pe.poison_signature(a) == pe.poison_signature(b)
    c = [{"app": "x", "story_id": 1, "invalid_state": "DIFFERENT"}]
    assert pe.poison_signature(a) != pe.poison_signature(c)


# --------------------------------------------------------------------------- #
# escalate_poisoned_rows
# --------------------------------------------------------------------------- #


def test_escalates_once_then_deduped_within_cooldown(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    story_id = _add_story(tmp_path, state="abandoned")
    _write_tick_end(tmp_path, skipped=1, ts=now - timedelta(minutes=1))
    runner, calls = _make_gh_runner()

    # First cycle: escalates and opens exactly one issue.
    first = pe.escalate_poisoned_rows(tmp_path, repo="owner/repo", runner=runner, now=now)
    assert first["status"] == "escalated"
    assert first["issue_number"] == 777
    assert any(p["story_id"] == story_id for p in first["poisoned"])
    assert len(_create_calls(calls)) == 1

    # Second cycle a minute later, SAME poisoned row, still within cooldown:
    # suppressed by our stable-signature cooldown — notify_escalation is not
    # even invoked, so NO second gh issue is created.
    second = pe.escalate_poisoned_rows(
        tmp_path, repo="owner/repo", runner=runner, now=now + timedelta(minutes=1)
    )
    assert second["status"] == "suppressed_cooldown"
    assert second["signature"] == first["signature"]
    assert len(_create_calls(calls)) == 1  # unchanged — no re-spam


def test_escalates_again_after_cooldown_expires(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    _add_story(tmp_path, state="abandoned")
    _write_tick_end(tmp_path, skipped=1, ts=now - timedelta(minutes=1))
    runner, calls = _make_gh_runner()

    pe.escalate_poisoned_rows(tmp_path, repo="owner/repo", runner=runner, now=now)
    # Well past the cooldown window and a fresh skip signal.
    later = now + pe.DEFAULT_ESCALATION_COOLDOWN + timedelta(minutes=5)
    _write_tick_end(tmp_path, skipped=1, ts=later - timedelta(minutes=1))
    out = pe.escalate_poisoned_rows(tmp_path, repo="owner/repo", runner=runner, now=later)
    assert out["status"] == "escalated"
    assert len(_create_calls(calls)) == 2


def test_no_skip_signal_does_not_escalate(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    _add_story(tmp_path, state="abandoned")  # poisoned row exists...
    _write_tick_end(tmp_path, skipped=0, ts=now - timedelta(minutes=1))  # ...but no skip
    runner, calls = _make_gh_runner()

    out = pe.escalate_poisoned_rows(tmp_path, repo="owner/repo", runner=runner, now=now)
    assert out["status"] == "no_skip_signal"
    assert _create_calls(calls) == []


def test_skip_signal_but_no_poisoned_rows_does_not_escalate(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    # A healthy row only; the skip signal is present but nothing is poisoned
    # (e.g. the reconciler already quarantined the row).
    _add_story(tmp_path, state=StoryState.STORY_CREATED.value, slug="healthy")
    _write_tick_end(tmp_path, skipped=1, ts=now - timedelta(minutes=1))
    runner, calls = _make_gh_runner()

    out = pe.escalate_poisoned_rows(tmp_path, repo="owner/repo", runner=runner, now=now)
    assert out["status"] == "no_poisoned_rows"
    assert _create_calls(calls) == []
