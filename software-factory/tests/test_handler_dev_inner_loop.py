"""In-tick dev convergence loop (``dev_convergence`` in factory_settings.yaml).

The loop lives in ``handle_dev`` (wrapper) around ``_handle_dev_once``: a red
attempt retries immediately in the same invocation instead of waiting for the
next tick. These tests monkeypatch ``sandbox_run`` with scripted outcomes and
assert attempt counts, retry bookkeeping, and stop reasons.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.event_log import read_story_events
from factory.chain.handlers import handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories" / "1-x.md").write_text("# story\n", encoding="utf-8")
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


def _enable_convergence(temp_root: Path, **overrides: Any) -> None:
    cfg = {
        "enabled": True,
        "max_inner_attempts": 3,
        "per_story_wall_clock_s": 2700,
        "per_story_budget_usd": 8.0,
        "dev_sandbox_timeout_s": 1800,
    }
    # The dev-retry cap is operator-configurable (2026-08-09). A test whose
    # arithmetic depends on it must PIN it rather than inherit whatever the
    # default happens to be; it lives under a different settings section.
    max_dev_retries = overrides.pop("max_dev_retries", None)
    cfg.update(overrides)
    body = "dev_convergence:\n" + "".join(f"  {k}: {v}\n" for k, v in cfg.items())
    if max_dev_retries is not None:
        body += f"direction_defaults:\n  max_dev_retries: {max_dev_retries}\n"
    (temp_root / "factory_settings.yaml").write_text(body, encoding="utf-8")


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


def _red(marker: str = "expected 1 got 2") -> RunResult:
    """A red run. ``marker`` varies the failure tail, and therefore the
    normalized failure SIGNATURE.

    Tests about the inner convergence loop must pass DISTINCT markers: two
    consecutive identical signatures trip ``_MAX_DEV_SAME_SIGNATURE`` (2) and
    escalate the story, which would pre-empt the behaviour under test.
    """
    return RunResult(
        success=False,
        files_changed=["src/x.py"],
        test_run_passed=False,
        error="tests not green after run",
        summary=f"AssertionError: {marker}",
        cost_usd=0.01,
        tokens_out=100,
    )


def _green() -> RunResult:
    return RunResult(
        success=True,
        files_changed=["src/x.py"],
        test_run_passed=True,
        summary="all green",
        cost_usd=0.01,
        tokens_out=100,
    )


def _infra() -> RunResult:
    # Pre-model infra shape: no test run, zero cost/tokens.
    return RunResult(success=False, error="sandbox boot crash", summary="boot crash")


def _script_sandbox(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[RunResult]
) -> list[int]:
    """Patch sandbox_run to pop scripted outcomes; returns a call counter."""
    calls = [0]

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        calls[0] += 1
        return outcomes[min(calls[0] - 1, len(outcomes) - 1)]

    monkeypatch.setattr(runner_module, "sandbox_run", _fake, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")
    return calls


def test_red_then_green_converges_in_one_invocation(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The inner loop retries a red attempt and reaches green without waiting
    for the next tick.

    Was red->red->green. At _MAX_DEV_RETRIES=3 (lowered from 6 on 2026-08-01)
    the retry-headroom guard stops the inner loop once ``dev_retries + 1 >=``
    the cap, so the loop now gets at most TWO sandbox attempts per invocation
    and a third could never run. That is a real reduction in inner-loop power,
    not a test artefact.
    """
    _enable_convergence(temp_root)
    story = _story(temp_root)
    calls = _script_sandbox(monkeypatch, [_red("first"), _green()])

    result = handle_dev(story, app_config, temp_root, dry_run=False,
                        db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 2
    assert story.dev_retries == 1
    assert StoryState(story.state) is StoryState.TESTS_GREEN
    assert result.payload["test_run_passed"] is True
    # Attempt memory carried forward across inner attempts.
    attempts = json.loads(story.dev_attempts_json)
    assert [a["test_run_passed"] for a in attempts] == [False, True]


def test_disabled_config_means_single_attempt(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root, enabled=False)
    story = _story(temp_root)
    calls = _script_sandbox(monkeypatch, [_red(), _green()])

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    assert story.dev_retries == 1
    assert StoryState(story.state) is StoryState.DEV_RETRY


def test_attempts_cap_stops_loop_with_event(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root, max_inner_attempts=2)
    story = _story(temp_root)
    # Distinct signatures: this test is about the inner ATTEMPTS cap, not the
    # same-signature stall, which at _MAX_DEV_SAME_SIGNATURE=2 would otherwise
    # fire first and block the story.
    calls = _script_sandbox(monkeypatch, [_red("one"), _red("two")])

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 2
    assert story.dev_retries == 2
    assert StoryState(story.state) is StoryState.DEV_RETRY
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    stopped = [e for e in events if e.get("event") == "dev_inner_loop_stopped"]
    assert stopped and stopped[-1]["reason"] == "attempts_cap"


def test_retry_headroom_leaves_last_attempt_to_tick_path(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    # PINS the dev-retry cap locally instead of inheriting the global default.
    # The behaviour under test is the headroom mechanism — "stop the inner loop
    # while one chain retry remains, so exhaustion bookkeeping never runs inside a
    # loop iteration" — not the default's value. When the cap became
    # operator-configurable and its default moved 3 -> 4 (2026-08-09), raising the
    # starting `dev_retries` to compensate collided with
    # `_MAX_DEV_SANDBOX_INFRA_RETRIES` (also 3) and the story exhausted down the
    # sandbox-infra path instead. Pinning keeps this test's arithmetic about ONE
    # constant.
    _enable_convergence(temp_root, max_dev_retries=3)
    # dev_retries=1, cap 3: one attempt -> retries 2; 2+1 >= 3 stops the loop.
    story = _story(temp_root, dev_retries=1)
    calls = _script_sandbox(monkeypatch, [_red()])

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    assert story.dev_retries == 2
    assert StoryState(story.state) is StoryState.DEV_RETRY
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    stopped = [e for e in events if e.get("event") == "dev_inner_loop_stopped"]
    assert stopped and stopped[-1]["reason"] == "retry_headroom"


def test_wall_clock_guard_stops_loop(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root, per_story_wall_clock_s=0)
    story = _story(temp_root)
    calls = _script_sandbox(monkeypatch, [_red()])

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    stopped = [e for e in events if e.get("event") == "dev_inner_loop_stopped"]
    assert stopped and stopped[-1]["reason"] == "wall_clock"


def test_story_budget_guard_stops_loop(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root)
    story = _story(temp_root)
    calls = _script_sandbox(monkeypatch, [_red()])
    monkeypatch.setattr(handlers_module, "_story_spend_since", lambda *a, **kw: 99.0)

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    stopped = [e for e in events if e.get("event") == "dev_inner_loop_stopped"]
    assert stopped and stopped[-1]["reason"] == "budget"


def test_hourly_cap_recheck_stops_loop(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.settings.spend as spend_module

    _enable_convergence(temp_root)
    story = _story(temp_root)
    calls = _script_sandbox(monkeypatch, [_red()])
    monkeypatch.setattr(spend_module, "hour_spend_usd", lambda *a, **kw: 999.0)

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    stopped = [e for e in events if e.get("event") == "dev_inner_loop_stopped"]
    assert stopped and stopped[-1]["reason"] == "hourly_cap"


def test_infra_failure_exits_loop_without_consuming_retries(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root)
    story = _story(temp_root)
    calls = _script_sandbox(monkeypatch, [_infra()])

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    assert story.dev_retries == 0  # infra never burns the retry budget
    assert StoryState(story.state) is StoryState.DEV_RETRY
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    stopped = [e for e in events if e.get("event") == "dev_inner_loop_stopped"]
    assert stopped and stopped[-1]["reason"] == "infra_failure"


def test_exhaustion_is_terminal_no_extra_attempts(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root)
    story = _story(temp_root, dev_retries=5)
    calls = _script_sandbox(monkeypatch, [_red()])

    handle_dev(story, app_config, temp_root, dry_run=False,
               db_path=temp_root / "state" / "factory.db")

    assert calls[0] == 1
    assert story.dev_retries == 6
    assert StoryState(story.state) is StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "dev_inner_loop_stopped"]


def test_dry_run_bypasses_loop(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_convergence(temp_root)
    story = _story(temp_root)

    handle_dev(story, app_config, temp_root, dry_run=True, force_red=True,
               db_path=temp_root / "state" / "factory.db")

    assert story.dev_retries == 1
    assert StoryState(story.state) is StoryState.DEV_RETRY
