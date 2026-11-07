"""Dev retry memory + TESTS_NEED_CLARIFICATION escape hatch.

Each chain-level dev retry now (a) appends a per-attempt diagnostic
(test output tail + files touched + summary) into ``story.dev_attempts_json``
and (b) the NEXT dev sandbox invocation gets that history embedded in its
initial message so the LLM sees what it tried and what's still red.

If dev's stdout includes ``TESTS_NEED_CLARIFICATION:``, the chain routes
back to ``TEST_DESIGN_DONE`` so test_implementer re-writes the tests
WITHOUT consuming dev's retry budget.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult, _build_initial_message


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    import subprocess

    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories" / "1-x.md").write_text(
        "# story\n", encoding="utf-8"
    )
    # Real git repo so the worktree machinery can run.
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


def _story_at(state: StoryState, root: Path) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="099",
            app="sacrifice",
            title="t",
            slug="z",
            scope="backend",
            state=state.value,
            github_issue_number=1,
            story_file_path="stories/1-x.md",
        ),
        root / "state" / "factory.db",
    )


def test_build_initial_message_includes_prior_attempts() -> None:
    """Prior-attempts get embedded into the dev sandbox's initial message
    so the LLM doesn't re-discover dead ends each retry."""
    msg = _build_initial_message(
        persona="dev",
        story_text="# story body",
        context_prelude="# ctx",
        persona_prompt="# persona",
        prior_attempts=[
            {
                "attempt": 1,
                "files_touched": ["src/a.py", "src/b.py"],
                "summary": "tests not green",
                "test_output_tail": "AssertionError: expected 1 got 2",
            }
        ],
    )
    assert "Previous attempts on THIS story" in msg
    assert "Attempt 1" in msg
    assert "src/a.py" in msg
    assert "AssertionError: expected 1 got 2" in msg


def test_build_initial_message_no_prior_attempts_skips_block() -> None:
    msg = _build_initial_message(
        persona="dev",
        story_text="# s",
        context_prelude="# c",
        persona_prompt="# p",
        prior_attempts=None,
    )
    assert "Previous attempts" not in msg


def test_build_initial_message_includes_reviewer_findings() -> None:
    """On the reviewer_requested_changes -> dev path, the reviewer's findings
    must reach the dev prompt so it can address them (root cause of the
    non-converging review loop was that dev never saw them)."""
    msg = _build_initial_message(
        persona="dev",
        story_text="# story body",
        context_prelude="# ctx",
        persona_prompt="# persona",
        reviewer_findings={
            "verdict": "request_changes",
            "summary": "cleanup + coverage gaps",
            "findings": [
                {
                    "severity": "high",
                    "location": "src/upload.py:42",
                    "what": "file written before metadata persists; orphaned on failure",
                    "fix_suggestion": "delete the file if persist_metadata raises",
                }
            ],
            "test_quality_findings": [
                {
                    "test_name": "test_save_upload",
                    "issue": "does not cover the persistence-failure cleanup seam",
                    "fix_suggestion": "add a test forcing persist_metadata to raise",
                }
            ],
        },
    )
    assert "Reviewer change requests" in msg
    assert "cleanup + coverage gaps" in msg
    assert "src/upload.py:42" in msg
    assert "orphaned on failure" in msg
    assert "delete the file if persist_metadata raises" in msg
    assert "test_save_upload" in msg
    # Loop-4: dev OWNS the tests, so test-quality findings are framed as
    # dev's to FIX directly — never as frozen / route-to-another-agent.
    assert "fix these tests directly" in msg.lower()
    assert "add a test forcing persist_metadata to raise" in msg  # fix_suggestion surfaced
    assert "TESTS_NEED_CLARIFICATION" not in msg
    assert "FROZEN" not in msg


def test_build_initial_message_reviewer_findings_test_persona() -> None:
    """For test_implementer the reviewer section must tell it to REWRITE the
    tests (its job), not freeze them as for dev."""
    rf = {
        "verdict": "request_changes",
        "summary": "tests in wrong file, weak assertions",
        "findings": [],
        "test_quality_findings": [
            {
                "test_name": "test_401",
                "issue": "asserts substring instead of status",
                "fix_suggestion": "assert the preserved status code",
            }
        ],
    }
    msg = _build_initial_message(
        persona="test_implementer",
        story_text="# s",
        context_prelude="# c",
        persona_prompt="# p",
        reviewer_findings=rf,
    )
    assert "rewrite" in msg.lower()
    assert "test_401" in msg
    # Must NOT carry the dev-only frozen-tests prohibition.
    assert "FROZEN" not in msg
    assert "TESTS_NEED_CLARIFICATION" not in msg


def test_build_initial_message_no_reviewer_findings_skips_block() -> None:
    """First dev pass (TESTS_RED -> dev) has no reviewer verdict yet."""
    msg = _build_initial_message(
        persona="dev",
        story_text="# s",
        context_prelude="# c",
        persona_prompt="# p",
        reviewer_findings=None,
    )
    assert "Reviewer change requests" not in msg


def test_build_initial_message_empty_findings_skips_block() -> None:
    """An approve verdict with no findings should not render the section."""
    msg = _build_initial_message(
        persona="dev",
        story_text="# s",
        context_prelude="# c",
        persona_prompt="# p",
        reviewer_findings={"verdict": "approve", "findings": [], "summary": ""},
    )
    assert "Reviewer change requests" not in msg


def test_each_dev_retry_emits_factory_needs_redesign_event(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each (non-exhausted) dev retry emits a ``factory_needs_redesign``
    event with ``kind: dev_retry_observed`` — an early operator-visible
    warning signal instead of waiting for full retry exhaustion."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=["src/x.py"],
            test_run_passed=False,
            error="tests not green after run",
            summary="FAILED test_x: expected 1 got 2",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    # Re-fetch the story-level event log via the factory's reader so
    # we exercise the same path operators use.
    from factory.chain.event_log import read_story_events

    events = read_story_events(
        story.id,
        software_factory_root=temp_root,
        slug_hint=story.slug,
    )
    redesign_events = [
        e for e in events if e.get("event") == "factory_needs_redesign"
    ]
    assert redesign_events, "every dev retry should emit a factory_needs_redesign event"
    last = redesign_events[-1]
    assert last["kind"] == "dev_retry_observed"
    assert last["retries"] == 1
    assert result.next_state == StoryState.DEV_RETRY


def test_dev_records_attempt_into_story_dev_attempts_json(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed dev run appends an entry to ``story.dev_attempts_json``
    capturing the tail + files touched + summary."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    captured_kwargs: dict[str, Any] = {}

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        captured_kwargs.update(kwargs)
        return RunResult(
            success=False,
            files_changed=["src/x.py", "src/y.py"],
            test_run_passed=False,
            tokens_in=10,
            tokens_out=5,
            cost_usd=0.0,
            error="tests not green after run",
            summary="FAILED test_x assertion: expected True got False",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.DEV_RETRY
    assert story.dev_retries == 1
    assert story.dev_attempts_json is not None
    attempts = json.loads(story.dev_attempts_json)
    assert len(attempts) == 1
    a = attempts[0]
    assert a["attempt"] == 1
    assert "src/x.py" in a["files_touched"]
    assert "expected True got False" in a["test_output_tail"]
    assert a["summary"]


def test_dev_passes_prior_attempts_into_next_sandbox(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On a retry, the NEXT sandbox_run gets the prior attempts as a kwarg
    so the LLM sees what was tried."""
    story = _story_at(StoryState.DEV_RETRY, temp_root)
    story.dev_retries = 1
    story.dev_attempts_json = json.dumps(
        [
            {
                "attempt": 1,
                "files_touched": ["src/x.py"],
                "summary": "prev",
                "test_output_tail": "AssertionError: prev",
            }
        ]
    )
    persist_story(story, temp_root / "state" / "factory.db")
    db = temp_root / "state" / "factory.db"

    captured: dict[str, Any] = {}

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        captured["prior_attempts"] = kwargs.get("prior_attempts")
        return RunResult(
            success=False,
            files_changed=[],
            test_run_passed=False,
            error="still red",
            summary="still red after attempt 2",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    prior = captured["prior_attempts"]
    assert prior is not None
    assert len(prior) == 1
    assert prior[0]["attempt"] == 1


def test_red_run_is_a_normal_retry_no_clarification_route(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Loop-4: there is no longer a TESTS_NEED_CLARIFICATION escape token or a
    route back to a separate test author — the dev owns the tests. A red run
    is just a normal retry that increments dev_retries."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=["src/widget.py"],
            test_run_passed=False,
            error=None,
            summary="Adjusted widget; one assertion still red.",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.DEV_RETRY
    assert story.dev_retries == 1
