"""Pre-model sandbox infrastructure-error guard in ``handle_dev``.

Regression coverage for a silent-plumbing bug (loop-3): a dev sandbox that
dies BEFORE any model work — a transient ``.venv`` relink from a concurrent
``uv run``/``uv sync`` re-materialising site-packages mid-render
(``TemplateNotFound('self_documentation.j2')``), an SDK import failure, or a
boot crash — used to be conflated with a genuine "dev ran but tests are red"
outcome. That burned a dev retry per blip and produced a $0/0.2s retry storm
that marched the story straight into a terminal blocked state with no model
work ever done.

The guard distinguishes the two by the run's shape (``success=False`` with
``test_run_passed is None`` and zero tokens/cost) and:
  * does NOT consume the dev retry budget on an infra blip,
  * bounces the story straight back to dev (transients clear by next tick),
  * caps *consecutive* infra errors and escalates loudly at the cap,
  * leaves a genuine red-tests failure path completely unchanged.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.event_log import read_story_events
from factory.chain.handlers import _MAX_DEV_SANDBOX_INFRA_RETRIES, handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


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


def _story_at(state: StoryState, root: Path) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="099",
            app="myapp",
            title="t",
            slug="z",
            scope="backend",
            state=state.value,
            github_issue_number=1,
            story_file_path="stories/1-x.md",
        ),
        root / "state" / "factory.db",
    )


def _infra_failure_sandbox() -> object:
    """Fake sandbox_run mimicking a pre-model boot failure (no model work)."""

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=[],
            test_run_passed=None,  # tests never ran
            tokens_in=0,
            tokens_out=0,
            cost_usd=0.0,
            error="sandbox run raised: TemplateNotFound('self_documentation.j2')",
            summary="sandbox run raised: TemplateNotFound('self_documentation.j2')",
        )

    return _fake


def _timeout_sandbox():
    """Fake sandbox_run mimicking the wall-clock-timeout return shape."""

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=[],
            test_run_passed=None,
            tokens_in=0,
            tokens_out=0,
            cost_usd=0.0,
            error="sandbox run timed out after 1800s (likely a stalled LLM call)",
            summary="sandbox run timed out after 1800s (likely a stalled LLM call)",
        )

    return _fake


def test_sandbox_timeout_routes_as_infra_retry(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A wall-clock timeout returns the pre-model infra shape, so the dev
    circuit breaker re-dispatches without burning the retry budget."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"
    monkeypatch.setattr(runner_module, "sandbox_run", _timeout_sandbox(), raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state is StoryState.DEV_RETRY
    assert story.dev_retries == 0
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    infra = [e for e in events if e.get("event") == "dev_sandbox_infra_error"]
    assert len(infra) == 1 and "timed out" in infra[0]["error"]


def test_infra_failure_does_not_burn_retry_and_bounces_back(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pre-model infra failure re-dispatches dev WITHOUT consuming budget."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    monkeypatch.setattr(runner_module, "sandbox_run", _infra_failure_sandbox(), raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    # Bounced back to a dev-dispatchable state, NOT terminally blocked.
    assert result.next_state is StoryState.DEV_RETRY
    # The dev retry budget is untouched — this was not a code failure.
    assert story.dev_retries == 0
    # The model tier was NOT escalated (infra blip, not a hard problem).
    assert story.current_model_tier != "hard"
    # A distinct infra-error event was logged for the FMS to see.
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    infra_events = [e for e in events if e.get("event") == "dev_sandbox_infra_error"]
    assert len(infra_events) == 1
    assert infra_events[0]["attempt"] == 1
    assert "TemplateNotFound" in infra_events[0]["error"]
    # No dev_retry event was emitted (which would have counted against budget).
    assert not [e for e in events if e.get("event") == "dev_retry"]


def test_persistent_infra_failure_blocks_loudly_at_cap(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After the consecutive-infra cap, escalate to a loud terminal block."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    monkeypatch.setattr(runner_module, "sandbox_run", _infra_failure_sandbox(), raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    # First _MAX_DEV_SANDBOX_INFRA_RETRIES calls bounce back...
    for _ in range(_MAX_DEV_SANDBOX_INFRA_RETRIES):
        result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
        assert result.next_state is StoryState.DEV_RETRY

    # ...the next call hits the cap and blocks loudly.
    final = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)
    assert final.next_state is StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
    assert story.dev_retries == 0  # never charged the dev budget
    assert story.error is not None and "infrastructure failure" in story.error

    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    redesign = [
        e
        for e in events
        if e.get("event") == "factory_needs_redesign"
        and e.get("kind") == "sandbox_infra_persistent"
    ]
    assert len(redesign) == 1


def test_genuine_red_tests_still_counts_as_a_retry(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real 'dev ran, tests red' result is unaffected by the infra guard."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=["src/x.py"],
            test_run_passed=False,  # tests DID run and failed
            tokens_in=1200,
            tokens_out=800,
            cost_usd=0.04,
            error="tests not green after run",
            summary="AssertionError: expected 1 got 2",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    # The normal retry path ran: budget charged, no infra event.
    assert story.dev_retries == 1
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "dev_sandbox_infra_error"]


def _content_filter_sandbox():
    """Fake sandbox_run mimicking a provider content-filter block."""

    async def _fake(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=[],
            test_run_passed=None,
            tokens_in=0,
            tokens_out=0,
            cost_usd=0.0,
            error=(
                "sandbox run raised: ConversationRunError(\"litellm.BadRequestError: "
                "AzureException - 400 - finish_reason: content_filter - "
                "ResponsibleAI result indicated block action.\")"
            ),
            summary="content filter block",
        )

    return _fake


def test_content_filter_escalates_model_tier_instead_of_blocking(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider content-filter block deterministically re-trips on the same
    model, so retrying is futile — escalate to the hard-tier model (different
    family, different filter profile) without burning infra or dev budget."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"
    monkeypatch.setattr(runner_module, "sandbox_run", _content_filter_sandbox(), raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/deepseek-v4-pro")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state is StoryState.DEV_RETRY
    assert story.current_model_tier == "hard"
    assert story.dev_retries == 0
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert [e for e in events if e.get("event") == "dev_content_filter_tier_escalation"]
    assert not [e for e in events if e.get("event") == "dev_sandbox_infra_error"]


def test_content_filter_on_hard_tier_falls_through_to_infra_path(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the hard tier ALSO trips the filter, the bounded infra path takes
    over so the story can't ping-pong between tiers forever."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    story.current_model_tier = "hard"
    db = temp_root / "state" / "factory.db"
    persist_story(story, db)
    monkeypatch.setattr(runner_module, "sandbox_run", _content_filter_sandbox(), raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    result = handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state is StoryState.DEV_RETRY
    assert story.current_model_tier == "hard"
    events = read_story_events(story.id, software_factory_root=temp_root, slug_hint=story.slug)
    assert [e for e in events if e.get("event") == "dev_sandbox_infra_error"]
