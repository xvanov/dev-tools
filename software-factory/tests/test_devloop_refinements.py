"""Dev-loop robustness refinements (R1/R2/R3), surfaced by a live soak.

R1 — a genuinely red dev run (tests ran and failed, incl. collection errors, or
     the model did real work then the sandbox raised) increments ``dev_retries``
     and is bounded by ``_MAX_DEV_RETRIES``; only a sandbox that failed BEFORE
     any model work takes the free infra path.
R2 — consecutive dev runs with the IDENTICAL normalized failure signature
     escalate after ``_MAX_DEV_SAME_SIGNATURE`` instead of burning the full
     retry + per-story budget; a CHANGING signature keeps retrying.
R3 — the WS1.1 per-story budget breaker decays ``total_attempts`` when a story
     makes genuine forward progress (a NEW happy-path milestone, not a
     dev<->review oscillation); a non-advancing/oscillating story still trips.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
import types
from pathlib import Path
from typing import Any

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain import orchestrator as O
from factory.chain.event_log import read_story_events
from factory.chain.handlers import (
    _MAX_DEV_RETRIES,
    _MAX_DEV_SAME_SIGNATURE,
    _consecutive_same_dev_signature,
    _is_premodel_infra_failure,
    handle_dev,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import LLMConfig, RunResult, sandbox_run


# --------------------------------------------------------------------------- #
# Fixtures — a real git app repo so ``_writing_worktree`` works in non-dry-run.
# --------------------------------------------------------------------------- #
@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories" / "1-x.md").write_text(
        "# story\n", encoding="utf-8"
    )
    src = tmp_path / "myapp"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=str(src), check=True)
    (src / "README.md").write_text("# init\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(src), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src), check=True)
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    return AppConfig(
        name="myapp",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(temp_root / "myapp"),
    )


def _story(temp_root: Path, *, dev_retries: int = 0) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="099",
            app="myapp",
            title="t",
            slug="z",
            scope="backend",
            state=StoryState.SM_DONE.value,
            github_issue_number=1,
            story_file_path="stories/1-x.md",
            dev_retries=dev_retries,
        ),
        temp_root / "state" / "factory.db",
    )


def _patch_sandbox(monkeypatch: pytest.MonkeyPatch, outcomes: list[RunResult]) -> list[int]:
    """Patch ``sandbox_run`` to pop scripted outcomes; returns a call counter."""
    calls = [0]

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        calls[0] += 1
        return outcomes[min(calls[0] - 1, len(outcomes) - 1)]

    monkeypatch.setattr(runner_module, "sandbox_run", _fake, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")
    return calls


def _db(temp_root: Path) -> Path:
    return temp_root / "state" / "factory.db"


# --------------------------------------------------------------------------- #
# R1 — classification: a genuine red dev run increments dev_retries
# --------------------------------------------------------------------------- #
def test_r1_premodel_infra_classification_unit() -> None:
    # Tests ran and FAILED (incl. collection errors -> pytest exits non-zero,
    # test_run_passed=False) -> a real dev attempt, never infra.
    assert not _is_premodel_infra_failure(
        RunResult(success=False, test_run_passed=False, cost_usd=0.02, tokens_out=200)
    )
    # Model did REAL work then the sandbox raised: the runner reports
    # test_run_passed=False + real usage + premodel_infra=False -> real attempt.
    assert not _is_premodel_infra_failure(
        RunResult(
            success=False,
            test_run_passed=False,
            cost_usd=0.05,
            tokens_out=500,
            premodel_infra=False,
            error="sandbox run raised: RuntimeError(...)",
        )
    )
    # Genuine pre-model breakage: explicit flag.
    assert _is_premodel_infra_failure(
        RunResult(success=False, error="boot crash", premodel_infra=True)
    )
    # Legacy zero-cost/None shape (no explicit flag) still classifies as infra.
    assert _is_premodel_infra_failure(
        RunResult(success=False, error="boot crash")
    )
    # A green run is never infra.
    assert not _is_premodel_infra_failure(
        RunResult(success=True, test_run_passed=True, cost_usd=0.01, tokens_out=50)
    )


def test_r1_collection_error_red_run_increments_dev_retries(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A red run whose failure is a pytest COLLECTION ERROR in the story's own
    code (tests ran -> test_run_passed=False) counts as a dev retry — it must
    NOT be diverted to the free infra path."""
    story = _story(temp_root)
    collection_red = RunResult(
        success=False,
        files_changed=["src/x.py"],
        test_run_passed=False,
        cost_usd=0.04,
        tokens_out=800,
        error="tests not green after run",
        summary="ERRORS\nERROR tests/test_x.py - ImportError: cannot import name 'foo'\n"
        "170 failed, 13 errors in 42.0s",
    )
    _patch_sandbox(monkeypatch, [collection_red])

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=_db(temp_root))

    assert result.next_state is StoryState.DEV_RETRY
    assert story.dev_retries == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "dev_sandbox_infra_error"]


def test_r1_model_worked_then_raised_counts_as_dev_retry(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runner's post-exception shape when the model already spent tokens
    (test_run_passed=False, real usage, premodel_infra=False) is a genuine
    failed attempt — it increments dev_retries, not the infra path (the
    story-88 bug: dev_retries stuck at 1 while re-dispatched for free)."""
    story = _story(temp_root)
    worked_then_raised = RunResult(
        success=False,
        files_changed=["src/x.py"],
        test_run_passed=False,
        cost_usd=0.06,
        tokens_out=900,
        premodel_infra=False,
        error="sandbox run raised: RuntimeError('metrics extraction failed')",
        summary="sandbox run raised: RuntimeError('metrics extraction failed')",
    )
    _patch_sandbox(monkeypatch, [worked_then_raised])

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=_db(temp_root))

    assert result.next_state is StoryState.DEV_RETRY
    assert story.dev_retries == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "dev_sandbox_infra_error"]


def test_r1_genuine_premodel_infra_does_not_increment(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A sandbox that died BEFORE any model work (explicit premodel_infra flag)
    bounces back to dev without consuming the retry budget."""
    story = _story(temp_root)
    infra = RunResult(success=False, error="OpenHands SDK import failed", premodel_infra=True)
    _patch_sandbox(monkeypatch, [infra])

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=_db(temp_root))

    assert result.next_state is StoryState.DEV_RETRY
    assert story.dev_retries == 0  # infra never burns the retry budget
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert [e for e in events if e.get("event") == "dev_sandbox_infra_error"]


# --------------------------------------------------------------------------- #
# R2 — same-failure-signature fast escalation
# --------------------------------------------------------------------------- #
def _red_with_summary(summary: str) -> RunResult:
    return RunResult(
        success=False,
        files_changed=["src/x.py"],
        test_run_passed=False,
        cost_usd=0.03,
        tokens_out=400,
        error="tests not green after run",
        summary=summary,
    )


def test_r2_consecutive_same_signature_helper() -> None:
    attempts = [
        {"test_run_passed": False, "failure_signature": "A"},
        {"test_run_passed": False, "failure_signature": "A"},
        {"test_run_passed": False, "failure_signature": "A"},
    ]
    assert _consecutive_same_dev_signature(attempts, "A") == 3
    # A green run in between resets the streak.
    attempts2 = [
        {"test_run_passed": False, "failure_signature": "A"},
        {"test_run_passed": True},
        {"test_run_passed": False, "failure_signature": "A"},
    ]
    assert _consecutive_same_dev_signature(attempts2, "A") == 1
    # A different trailing signature resets.
    attempts3 = [
        {"test_run_passed": False, "failure_signature": "A"},
        {"test_run_passed": False, "failure_signature": "B"},
    ]
    assert _consecutive_same_dev_signature(attempts3, "B") == 1
    # Empty signature is never comparable.
    assert _consecutive_same_dev_signature(attempts, "") == 0


def test_r2_identical_signature_escalates_before_full_budget(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Three across-tick dev runs with the IDENTICAL failure escalate at
    _MAX_DEV_SAME_SIGNATURE instead of marching to _MAX_DEV_RETRIES."""
    story = _story(temp_root)
    same = _red_with_summary("AssertionError: expected 1 got 2 in test_widget")
    _patch_sandbox(monkeypatch, [same])

    db = _db(temp_root)
    # Ticks below the same-signature cap: still retrying, still has budget.
    for expected in range(1, _MAX_DEV_SAME_SIGNATURE):
        result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
        assert result.next_state is StoryState.DEV_RETRY
        assert story.dev_retries == expected

    # The _MAX_DEV_SAME_SIGNATURE'th identical failure -> same-signature stall
    # -> BLOCKED, still under the full retry budget.
    final = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
    assert final.next_state is StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
    assert story.dev_retries == _MAX_DEV_SAME_SIGNATURE
    assert story.dev_retries < _MAX_DEV_RETRIES
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    exhausted = [e for e in events if e.get("event") == "dev_exhausted"]
    assert exhausted and exhausted[-1]["reason"] == "same_failure_signature"


def test_r2_changing_signature_keeps_retrying(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A CHANGING failure signature means genuine progress — the dev loop keeps
    its full retry budget and does NOT early-escalate on same-signature."""
    story = _story(temp_root)
    calls = [0]

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        calls[0] += 1
        # A different failure tail every attempt.
        return _red_with_summary(f"AssertionError: iteration {calls[0]} distinct failure")

    monkeypatch.setattr(runner_module, "sandbox_run", _fake, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    db = _db(temp_root)
    # Past the same-signature cap: still retrying because each failure differs.
    # Bounded by the retry budget itself — the last retry blocks for exhaustion,
    # which is a different reason and not what this test is about.
    for expected in range(1, _MAX_DEV_RETRIES):
        result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
        assert result.next_state is StoryState.DEV_RETRY, f"attempt {expected}"
        assert story.dev_retries == expected
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert not [
        e
        for e in events
        if e.get("event") == "dev_exhausted"
        and e.get("reason") == "same_failure_signature"
    ]


# --------------------------------------------------------------------------- #
# R3 — budget-breaker advance-decay
# --------------------------------------------------------------------------- #
class _Caps:
    per_story_attempts = 20
    per_story_spend_usd = 5.0


def test_r3_advance_to_new_milestone_decays_attempts() -> None:
    """A story advancing to a NEW happy-path milestone resets total_attempts
    (spend untouched) and never trips the attempt breaker."""
    story = StoryRecord(
        direction_id="1",
        app="myapp",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.TESTS_GREEN.value,
        total_attempts=18,
        total_spend_usd=2.5,
        max_progress_ordinal=O._progress_ordinal(StoryState.SM_DONE.value),
    )
    assert O._apply_advance_decay(story) is True
    assert story.total_attempts == 0
    assert story.max_progress_ordinal == O._progress_ordinal(StoryState.TESTS_GREEN.value)
    assert story.total_spend_usd == 2.5  # spend is the hard ceiling — untouched
    assert O._story_budget_breaker_reason(story, _Caps) is None


def test_r3_oscillation_does_not_decay() -> None:
    """A dev<->review ping-pong re-treads states at/below the high-water mark, so
    it never decays — the breaker must stay able to trip on it."""
    reviewer_ord = O._progress_ordinal(StoryState.REVIEWER_IN_PROGRESS.value)
    # Already reached the reviewer tier; now bounced back toward dev.
    for st in (
        StoryState.REVIEWER_REQUESTED_CHANGES,
        StoryState.DEV_RETRY,
        StoryState.TESTS_GREEN,
        StoryState.REVIEWER_IN_PROGRESS,
    ):
        story = StoryRecord(
            direction_id="1",
            app="myapp",
            title="t",
            slug="s",
            scope="backend",
            state=st.value,
            total_attempts=17,
            max_progress_ordinal=reviewer_ord,
        )
        assert O._apply_advance_decay(story) is False, st
        assert story.total_attempts == 17, st  # unchanged — no free relief
        assert story.max_progress_ordinal == reviewer_ord, st


def test_r3_non_advancing_story_still_trips() -> None:
    """A story that keeps oscillating (never exceeds its high-water mark)
    accumulates attempts and eventually trips the breaker."""
    story = StoryRecord(
        direction_id="1",
        app="myapp",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.REVIEWER_REQUESTED_CHANGES.value,
        total_attempts=0,
        max_progress_ordinal=O._progress_ordinal(StoryState.REVIEWER_IN_PROGRESS.value),
    )
    # Simulate repeated non-advancing dispatches: bump then attempt decay.
    for _ in range(_Caps.per_story_attempts):
        story.total_attempts += 1
        assert O._apply_advance_decay(story) is False
    assert O._story_budget_breaker_reason(story, _Caps) is not None


def test_r3_progress_ordinal_error_states_are_zero() -> None:
    for st in (
        StoryState.BLOCKED_BUDGET_EXCEEDED,
        StoryState.BLOCKED_TESTS_NEED_CLARIFICATION,
        StoryState.BLOCKED_REVIEW_NONCONVERGENT,
        StoryState.BLOCKED_DEPLOY_FAILED,
    ):
        assert O._progress_ordinal(st.value) == 0
    assert O._progress_ordinal("not_a_real_state") == 0


# --------------------------------------------------------------------------- #
# R1 (runner level) — an exception/timeout AFTER model work is a real attempt,
# but a genuine pre-model / stalled-LLM failure stays infra.
# --------------------------------------------------------------------------- #
def _install_fake_sdk(
    monkeypatch: pytest.MonkeyPatch,
    *,
    run_sleep_s: float = 0.0,
    close_raises: bool = False,
    report_usage: bool = True,
) -> None:
    """Install a fake OpenHands SDK whose ``run()`` reports 1000/100 tokens and
    $0.50. ``run_sleep_s`` sleeps INSIDE run() (before any usage is captured, to
    model a stalled LLM); ``close_raises`` raises during teardown AFTER usage is
    captured (to model a post-model crash).

    ``report_usage=False`` makes ``conversation_stats`` report ZERO accumulated
    usage. Needed since the runner learned to read usage off a conversation that
    has not returned: this fake's stats are static, so a ``run_sleep_s`` stall
    used to *say* 1000/100/$0.50 while modelling "the LLM hung and did nothing".
    A genuinely stalled request has made no completed call, so its accumulated
    cost really is 0 — ``report_usage=False`` is what that looks like, and
    keeping the old static usage here would assert the very confusion the
    runner fix removes."""

    class _FakeConversation:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def send_message(self, *_: Any, **__: Any) -> None:
            pass

        def run(self) -> None:
            if run_sleep_s:
                time.sleep(run_sleep_s)

        def close(self) -> None:
            if close_raises:
                raise RuntimeError("conversation teardown blew up")

        @property
        def conversation_stats(self) -> Any:
            class _S:
                def get_combined_metrics(self) -> Any:
                    class _M:
                        accumulated_token_usage = type(
                            "U",
                            (),
                            {
                                "prompt_tokens": 1000 if report_usage else 0,
                                "completion_tokens": 100 if report_usage else 0,
                                "cache_read_tokens": 0,
                            },
                        )()
                        accumulated_cost = 0.5 if report_usage else 0.0

                    return _M()

            return _S()

    class _FakeLLM:
        def __init__(self, **kwargs: Any) -> None:
            pass

    class _FakeWorkspace:
        def __init__(self, **kwargs: Any) -> None:
            pass

    fake_sdk = types.ModuleType("openhands.sdk")
    fake_sdk.LLM = _FakeLLM  # type: ignore[attr-defined]
    fake_sdk.Conversation = _FakeConversation  # type: ignore[attr-defined]
    fake_sdk.LocalWorkspace = _FakeWorkspace  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.sdk", fake_sdk)

    fake_tools = types.ModuleType("openhands.tools.preset.default")
    fake_tools.get_default_agent = lambda **_: object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.tools.preset.default", fake_tools)

    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.SecretStr = lambda s: s  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)


def _run_sandbox(tmp_path: Path, **kwargs: Any) -> RunResult:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    (repo / "README.md").write_text("# t\n", encoding="utf-8")
    story = tmp_path / "story.md"
    story.write_text("# s\n", encoding="utf-8")
    return asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/deepseek-v4-pro", api_key="x"),
            dry_run=False,
            db_path=tmp_path / "state" / "factory.db",
            **kwargs,
        )
    )


def test_r1_exception_after_model_work_is_real_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run() completes (usage captured) but teardown raises → a genuine failed
    dev attempt: real usage recorded, test_run_passed=False, NOT infra."""
    _install_fake_sdk(monkeypatch, close_raises=True)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    res = _run_sandbox(tmp_path)

    assert res.premodel_infra is False
    assert res.test_run_passed is False
    assert res.tokens_out == 100
    assert res.cost_usd == 0.5
    assert not _is_premodel_infra_failure(res)


def test_r1_timeout_after_model_work_is_real_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The model run completed (usage captured) but post-model teardown hit the
    wall clock → counts as a real attempt with its spend, not a free infra
    bounce."""
    _install_fake_sdk(monkeypatch)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    # Stall in post-model memory extraction (runs AFTER _partial_usage is set),
    # then set a tiny wall-clock so asyncio.wait_for raises TimeoutError.
    monkeypatch.setattr(
        runner_module,
        "_extract_conversation_memory",
        lambda *_a, **_k: time.sleep(2.0) or ("", [], ""),
    )

    res = _run_sandbox(tmp_path, wall_clock_timeout_s=0.2)

    assert res.premodel_infra is False
    assert res.test_run_passed is False
    assert res.tokens_out == 100
    assert res.cost_usd == 0.5
    assert not _is_premodel_infra_failure(res)


def test_r1_stalled_llm_timeout_stays_infra(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A genuinely stalled LLM (run() itself never returns before the wall
    clock, and NO usage accumulated) stays retryable infra.

    ``report_usage=False`` is what "the request hung and nothing completed"
    actually looks like to the SDK. This used to rely on the runner being unable
    to read the live conversation at all, which conflated it with the case
    below.
    """
    _install_fake_sdk(monkeypatch, run_sleep_s=2.0, report_usage=False)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    res = _run_sandbox(tmp_path, wall_clock_timeout_s=0.2)

    assert res.premodel_infra is True
    assert res.test_run_passed is None
    assert res.tokens_out == 0
    assert res.cost_usd == 0.0
    assert _is_premodel_infra_failure(res)


def test_r1_timeout_midrun_with_accumulated_spend_is_a_real_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sibling case the test above used to swallow.

    ``run()`` has not returned, but the conversation HAS completed calls and
    accumulated spend — the live shape of sacrifice story 173 (1800 s, $1.92,
    4.73M tokens). It must book that spend and burn a dev retry, or the money is
    invisible to ``per_story_spend_usd`` and the story re-dispatches for free.
    """
    _install_fake_sdk(monkeypatch, run_sleep_s=2.0, report_usage=True)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    res = _run_sandbox(tmp_path, wall_clock_timeout_s=0.2)

    assert res.premodel_infra is False
    assert res.tokens_out == 100
    assert res.cost_usd == 0.5
    assert not _is_premodel_infra_failure(res)
