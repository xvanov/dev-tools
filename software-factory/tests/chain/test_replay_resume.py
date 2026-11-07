"""Tier 4 WS4.2 — replayable typed step-event stream + resume-from-checkpoint.

Three contracts:

* :mod:`factory.chain.step_events` emits a typed ``chain_step`` record per
  handler dispatch and reconstructs a story's chain history deterministically.
* The dev handler RESUMES from a persisted green checkpoint instead of
  re-running the (expensive) dev LLM when a tick died between "sandbox finished
  green" and "state advanced".
* Normal end-to-end progression is unchanged (the checkpoint is written then
  cleared within a single ``handle_dev`` call).
"""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain import orchestrator as O
from factory.chain.handlers import get_story, handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.chain.step_events import (
    CHAIN_STEP_STREAM,
    emit_chain_step,
    replay_chain_history,
)
from factory.runner import RunResult
from factory.settings.loader import load_settings

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories" / "1-x.md").write_text(
        "# story\n", encoding="utf-8"
    )
    src = tmp_path / "sacrifice"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.name", "T E"], cwd=str(src), check=True)
    (src / "README.md").write_text("# init\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(src), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src), check=True)
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(temp_root / "sacrifice"),
    )


def _story_at(state: StoryState, root: Path, **kw: object) -> StoryRecord:
    fields: dict[str, object] = {
        "id": None,
        "direction_id": "099",
        "app": "sacrifice",
        "title": "t",
        "slug": "z",
        "scope": "backend",
        "state": state.value,
        "github_issue_number": 1,
        "story_file_path": "stories/1-x.md",
    }
    fields.update(kw)
    return persist_story(StoryRecord(**fields), root / "state" / "factory.db")  # type: ignore[arg-type]


def _green_checkpoint(attempt: int = 0) -> str:
    return json.dumps(
        {"outcome": "green", "attempt": attempt, "ts": datetime.now(UTC).isoformat()}
    )


# --------------------------------------------------------------------------- #
# Typed step-event stream
# --------------------------------------------------------------------------- #


def test_emit_chain_step_writes_typed_record(temp_root: Path) -> None:
    story = _story_at(
        StoryState.SM_DONE, temp_root, sm_result_json=json.dumps({"stories": []})
    )
    emit_chain_step(
        story,
        handler="sm",
        from_state="sm_in_progress",
        to_state="sm_done",
        outcome="advanced",
        software_factory_root=temp_root,
    )
    path = temp_root / "state" / "events" / f"{CHAIN_STEP_STREAM}.ndjson"
    assert path.exists()
    rec = json.loads(path.read_text(encoding="utf-8").strip())
    assert rec["event"] == "chain_step"
    assert rec["story_id"] == story.id
    assert rec["app"] == "sacrifice"
    assert rec["handler"] == "sm"
    assert rec["from_state"] == "sm_in_progress"
    assert rec["to_state"] == "sm_done"
    assert rec["outcome"] == "advanced"
    # Content ref + hash of the step's persisted artifact.
    assert rec["artifact_ref"] == "sm_result_json"
    assert isinstance(rec["artifact_hash"], str) and rec["artifact_hash"]
    # write_event injects ts + schema_version.
    assert "ts" in rec and "schema_version" in rec


def test_emit_chain_step_null_artifact_when_column_empty(temp_root: Path) -> None:
    story = _story_at(StoryState.STORY_CREATED, temp_root)  # sm_result_json is None
    emit_chain_step(
        story,
        handler="sm",
        from_state="story_created",
        to_state="sm_in_progress",
        outcome="advanced",
        software_factory_root=temp_root,
    )
    rec = replay_chain_history(story.id, software_factory_root=temp_root)[0]
    assert rec["artifact_ref"] == "sm_result_json"
    assert rec["artifact_hash"] is None


def test_replay_reconstructs_history_in_order(temp_root: Path) -> None:
    story = _story_at(StoryState.STORY_CREATED, temp_root)
    other = _story_at(StoryState.STORY_CREATED, temp_root, slug="other")

    steps = [
        ("sm", "story_created", "sm_in_progress"),
        ("sm", "sm_in_progress", "sm_done"),
        ("dev", "sm_done", "dev_in_progress"),
        ("dev", "dev_in_progress", "tests_green"),
        ("review", "tests_green", "reviewer_in_progress"),
    ]
    for handler, frm, to in steps:
        emit_chain_step(
            story,
            handler=handler,
            from_state=frm,
            to_state=to,
            outcome="advanced",
            software_factory_root=temp_root,
        )
        # An interleaved step for a DIFFERENT story must be filtered out.
        emit_chain_step(
            other,
            handler=handler,
            from_state=frm,
            to_state=to,
            outcome="advanced",
            software_factory_root=temp_root,
        )

    history = replay_chain_history(story.id, software_factory_root=temp_root)
    assert [(h["handler"], h["from_state"], h["to_state"]) for h in history] == steps
    assert all(h["story_id"] == story.id for h in history)


def test_replay_reads_rotated_segments_oldest_first(temp_root: Path) -> None:
    story = _story_at(StoryState.STORY_CREATED, temp_root)
    events_dir = temp_root / "state" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)

    def _line(seq: int) -> str:
        return json.dumps(
            {
                "event": "chain_step",
                "story_id": story.id,
                "handler": "dev",
                "from_state": f"s{seq}",
                "to_state": f"s{seq + 1}",
                "seq": seq,
            }
        )

    # .2 is oldest, then .1, then the live file — replay must return that order.
    (events_dir / f"{CHAIN_STEP_STREAM}.ndjson.2").write_text(_line(0) + "\n", "utf-8")
    (events_dir / f"{CHAIN_STEP_STREAM}.ndjson.1").write_text(_line(1) + "\n", "utf-8")
    (events_dir / f"{CHAIN_STEP_STREAM}.ndjson").write_text(_line(2) + "\n", "utf-8")

    history = replay_chain_history(story.id, software_factory_root=temp_root)
    assert [h["seq"] for h in history] == [0, 1, 2]


def test_replay_empty_when_no_stream(temp_root: Path) -> None:
    assert replay_chain_history(4242, software_factory_root=temp_root) == []


# --------------------------------------------------------------------------- #
# Resume-from-checkpoint
# --------------------------------------------------------------------------- #


def test_dev_resume_from_green_checkpoint_skips_llm(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dev dispatch that finds a green checkpoint resumes to TESTS_GREEN
    WITHOUT invoking the dev sandbox (the expensive LLM run)."""
    db = temp_root / "state" / "factory.db"
    story = _story_at(
        StoryState.DEV_RETRY, temp_root, dev_step_checkpoint=_green_checkpoint(1)
    )

    async def _boom(*args: object, **kwargs: object) -> RunResult:
        raise AssertionError("sandbox_run must NOT be called on a checkpoint resume")

    monkeypatch.setattr(runner_module, "sandbox_run", _boom, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.TESTS_GREEN
    assert result.payload.get("resumed_from_checkpoint") is True
    # Checkpoint consumed + persisted as cleared.
    reloaded = get_story(story.id, db)
    assert reloaded is not None
    assert reloaded.state == StoryState.TESTS_GREEN.value
    assert reloaded.dev_step_checkpoint is None
    # A resume event was logged for post-mortem.
    from factory.chain.event_log import read_story_events

    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert any(e.get("event") == "dev_resume_from_checkpoint" for e in events)


def test_dev_resume_disabled_by_flag_runs_llm(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With ``resume_from_checkpoint`` disabled, a green checkpoint is ignored
    and the dev sandbox runs (historical behaviour)."""
    db = temp_root / "state" / "factory.db"
    (temp_root / "factory_settings.yaml").write_text(
        "dev_convergence:\n  resume_from_checkpoint: false\n", encoding="utf-8"
    )
    story = _story_at(
        StoryState.DEV_RETRY, temp_root, dev_step_checkpoint=_green_checkpoint(1)
    )

    called = {"n": 0}

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        called["n"] += 1
        return RunResult(
            success=True,
            files_changed=["src/x.py"],
            test_run_passed=True,
            summary="ok",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
    assert called["n"] == 1


def test_normal_green_run_leaves_no_checkpoint(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The happy path is unchanged: a green dev run reaches TESTS_GREEN and the
    checkpoint is written-then-cleared (None) — it survives only interruptions."""
    db = temp_root / "state" / "factory.db"
    story = _story_at(StoryState.SM_DONE, temp_root)

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True,
            files_changed=["src/x.py"],
            test_run_passed=True,
            summary="all green",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.TESTS_GREEN
    reloaded = get_story(story.id, db)
    assert reloaded is not None
    assert reloaded.dev_step_checkpoint is None
    # A real green attempt was still recorded.
    attempts = json.loads(reloaded.dev_attempts_json or "[]")
    assert attempts and attempts[-1]["test_run_passed"] is True


def test_interrupted_dev_recovers_then_resumes_without_llm(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end interruption: a story left in DEV_IN_PROGRESS with a green
    checkpoint is rolled to DEV_RETRY by stale recovery, then RESUMES to
    TESTS_GREEN on the next dev dispatch without re-running the LLM."""
    db = temp_root / "state" / "factory.db"
    story = _story_at(
        StoryState.DEV_IN_PROGRESS,
        temp_root,
        dev_step_checkpoint=_green_checkpoint(1),
    )

    # Stale recovery: age the row past the threshold via the ``now`` seam.
    future = datetime.now(UTC) + timedelta(hours=1)
    recovered = O._prune_stale_in_progress(
        db,
        "sacrifice",
        settings=load_settings(temp_root),
        root=temp_root,
        now=future,
    )
    assert (story.slug, "dev_in_progress", "dev_retry") in recovered
    mid = get_story(story.id, db)
    assert mid is not None
    assert mid.state == StoryState.DEV_RETRY.value
    # The checkpoint must survive the rollback so the resume can read it.
    assert mid.dev_step_checkpoint is not None

    async def _boom(*args: object, **kwargs: object) -> RunResult:
        raise AssertionError("sandbox_run must NOT run after a checkpoint resume")

    monkeypatch.setattr(runner_module, "sandbox_run", _boom, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(mid, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.TESTS_GREEN
    assert get_story(story.id, db).dev_step_checkpoint is None  # type: ignore[union-attr]
