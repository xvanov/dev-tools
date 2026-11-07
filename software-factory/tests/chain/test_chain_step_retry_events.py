"""Dev retries and reviewer cycles must reach the ``chain_step`` stream.

The orchestrator's two ``emit_chain_step`` sites fire once per handler
DISPATCH. Dev retries and reviewer cycles both turn inside a single handler
invocation, so neither was ever recorded: ``state/events/chain_steps.ndjson``
held 400 ``advanced`` + 10 ``error`` rows and **zero** ``retried`` rows, while
41 stories carried ``dev_retries > 0`` (71 retries all-time) and 119 reviewer
cycles had happened.

The contract these tests pin is reconciliation: the count of emitted retry
rows for a story must equal that story's persisted counter. A telemetry stream
that merely "has some rows" is not measurement.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import (
    _MAX_DEV_RETRIES,
    _MAX_REVIEW_CYCLES,
    get_story,
    handle_dev,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.chain.step_events import CHAIN_STEP_STREAM
from factory.runner import RunResult

# --------------------------------------------------------------------------- #
# Fixtures (mirroring tests/chain/test_replay_resume.py)
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


def _steps(root: Path, outcome: str | None = None) -> list[dict]:
    stream = root / "state" / "events" / f"{CHAIN_STEP_STREAM}.ndjson"
    if not stream.exists():
        return []
    rows = [json.loads(x) for x in stream.read_text(encoding="utf-8").splitlines() if x.strip()]
    return [r for r in rows if outcome is None or r.get("outcome") == outcome]


# --------------------------------------------------------------------------- #
# Dev retries
# --------------------------------------------------------------------------- #


def test_red_dev_run_emits_a_retried_step(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = temp_root / "state" / "factory.db"
    story = _story_at(StoryState.SM_DONE, temp_root)

    async def _red(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True,
            files_changed=["src/x.py"],
            test_run_passed=False,
            summary="1 failed, 3 passed",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _red, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    retried = _steps(temp_root, "retried")
    assert len(retried) == 1
    rec = retried[0]
    assert rec["handler"] == "dev"
    assert rec["story_id"] == story.id
    assert rec["retry_attempt"] == 1
    assert rec["retry_cap"] == _MAX_DEV_RETRIES
    # A retry is not a transition.
    assert rec["from_state"] == rec["to_state"]


def test_retried_rows_reconcile_with_the_dev_retries_column(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The acceptance criterion: emitted count == persisted counter."""
    db = temp_root / "state" / "factory.db"
    story = _story_at(StoryState.SM_DONE, temp_root)

    async def _red(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True,
            files_changed=["src/x.py"],
            test_run_passed=False,
            # Vary the tail so the same-signature fast-escalation does not
            # short-circuit the loop before the cap.
            summary=f"failure variant {len(_steps(temp_root, 'retried'))}",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _red, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    for _ in range(3):
        current = get_story(story.id, db)
        assert current is not None
        if current.state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value:
            break
        handle_dev(current, app_config, temp_root, dry_run=False, db_path=db)

    final = get_story(story.id, db)
    assert final is not None
    emitted = [r for r in _steps(temp_root, "retried") if r["story_id"] == story.id]
    assert len(emitted) == final.dev_retries
    assert final.dev_retries > 0
    # Attempt numbers are the contiguous sequence 1..N, not a repeated constant.
    assert [r["retry_attempt"] for r in emitted] == list(range(1, final.dev_retries + 1))


def test_green_dev_run_emits_no_retried_step(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-safe on the happy path: a green run must not manufacture a retry."""
    db = temp_root / "state" / "factory.db"
    story = _story_at(StoryState.SM_DONE, temp_root)

    async def _green(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True,
            files_changed=["src/x.py"],
            test_run_passed=True,
            summary="all green",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _green, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.TESTS_GREEN
    assert _steps(temp_root, "retried") == []


def test_telemetry_failure_does_not_break_the_retry_path(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A telemetry hiccup must never crash a tick — the retry still lands.

    The failure is injected at the ``write_event`` layer, NOT by replacing
    ``emit_chain_step`` itself: the guarantee lives in that function's own
    try/except, so monkeypatching it away would test a function this codebase
    never calls. The call sites deliberately have no second guard, matching
    the orchestrator's two existing emit sites.
    """
    import factory.manager.signals as signals_module

    db = temp_root / "state" / "factory.db"
    story = _story_at(StoryState.SM_DONE, temp_root)

    async def _red(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=True, files_changed=[], test_run_passed=False, summary="red"
        )

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("event stream is on fire")

    monkeypatch.setattr(runner_module, "sandbox_run", _red, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")
    monkeypatch.setattr(signals_module, "write_event", _boom, raising=True)

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    reloaded = get_story(story.id, db)
    assert reloaded is not None
    assert reloaded.dev_retries == 1


# --------------------------------------------------------------------------- #
# Reviewer cycles
# --------------------------------------------------------------------------- #


def test_review_cycle_step_carries_the_stability_signal(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A changes-requested review emits one ``review_cycle`` row whose count
    reconciles with ``reviewer_cycles`` and which carries the convergence
    facts (``consecutive_same``/``stuck``) that explain the cycle."""
    from factory.chain.handlers import handle_review

    db = temp_root / "state" / "factory.db"
    story = _story_at(
        StoryState.TESTS_GREEN,
        temp_root,
        github_pr_number=7,
        github_branch="story/z",
    )

    findings = {
        "verdict": "request_changes",
        "score": 0.3,
        "findings": [
            {"location": "src/x.py:1", "what": "missing null check", "severity": "blocking"}
        ],
    }
    monkeypatch.setattr(
        handlers_module, "route", lambda *a, **kw: "azure/gpt-5.3-codex"
    )
    monkeypatch.setattr(
        runner_module, "text_run", lambda *a, **kw: dict(findings), raising=True
    )
    monkeypatch.setattr(
        handlers_module, "text_run", lambda *a, **kw: dict(findings), raising=False
    )
    # The story has a PR number, so the (now fail-closed) diff precondition
    # would shell out to a real `gh pr diff` and block the story before any
    # review cycle happens. This test pins the review_cycle step emission,
    # not the diff plumbing — give it an inert real-looking diff.
    monkeypatch.setattr(
        handlers_module,
        "_fetch_pr_diff_for_review",
        lambda *a, **kw: "diff --git a/src/x.py b/src/x.py\n+x = 1\n",
    )

    handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    reloaded = get_story(story.id, db)
    assert reloaded is not None
    cycles = [r for r in _steps(temp_root, "review_cycle") if r["story_id"] == story.id]
    assert len(cycles) == reloaded.reviewer_cycles == 1
    rec = cycles[0]
    assert rec["handler"] == "review"
    assert rec["retry_cap"] == _MAX_REVIEW_CYCLES
    assert rec["consecutive_same"] >= 1
    assert rec["stuck"] is False
    assert rec["from_state"] == rec["to_state"]
