"""Empty-diff short-circuit — see factory/chain/handlers.py::handle_review.

When the dev produces no changes at all (branch diff-empty vs base), the
LLM reviewer would correctly detect it and request changes, dev gets
re-dispatched, produces nothing again, and the loop burns the FULL
``_MAX_REVIEW_CYCLES`` (6) before the story finally blocks — observed live
on D092 (deploy-verify) and D094 (password-reset), each churning ~6
empty-diff cycles. ``handle_review`` now detects a CONFIRMED empty diff
(real ``git diff`` check, only after a real dev attempt has run) and
escalates straight to ``BLOCKED_REVIEW_NONCONVERGENT`` on the FIRST
occurrence instead, without ever calling the reviewer LLM.

These tests use real git repos in tmp (a bare "origin" + a working clone)
so the ``git diff --quiet origin/<base>...HEAD`` check in
``_dev_produced_empty_diff`` exercises real git, not a mock.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain.branch import feature_branch_name
from factory.chain.handlers import (
    _dev_produced_empty_diff,
    _has_real_dev_attempt,
    _max_dev_retries,
    handle_review,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=True, timeout=30
    )


def _init_repo_with_origin(app_dir: Path) -> Path:
    """Create ``app_dir`` as a working repo pushed to a bare 'origin' remote.

    Returns the working repo path. This makes ``origin/main`` a real,
    resolvable ref inside worktrees created from ``app_dir`` — the same
    topology the chain uses against a real GitHub remote.
    """
    origin = app_dir.parent / f"{app_dir.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=app_dir.parent)

    app_dir.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=app_dir)
    _run(["git", "config", "user.email", "t@e.x"], cwd=app_dir)
    _run(["git", "config", "user.name", "T E"], cwd=app_dir)
    (app_dir / "README.md").write_text("# init\n", encoding="utf-8")
    _run(["git", "add", "."], cwd=app_dir)
    _run(["git", "commit", "-q", "-m", "init"], cwd=app_dir)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=app_dir)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=app_dir)
    return app_dir


def _init_repo_without_remote(app_dir: Path) -> Path:
    """Plain local repo, no ``origin`` remote at all (git-error path fixture)."""
    app_dir.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=app_dir)
    _run(["git", "config", "user.email", "t@e.x"], cwd=app_dir)
    _run(["git", "config", "user.name", "T E"], cwd=app_dir)
    (app_dir / "README.md").write_text("# init\n", encoding="utf-8")
    _run(["git", "add", "."], cwd=app_dir)
    _run(["git", "commit", "-q", "-m", "init"], cwd=app_dir)
    return app_dir


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _story_file(root: Path, slug: str) -> str:
    rel = f"stories/1-{slug}.md"
    (root / "apps" / "sacrifice" / rel).write_text(
        f"# Story: {slug}\n\nSome acceptance criteria.\n", encoding="utf-8"
    )
    return rel


def _mk_story(
    root: Path,
    *,
    slug: str,
    dev_attempts: list[dict[str, Any]] | None,
    dev_retries: int | None = None,
) -> StoryRecord:
    """``dev_retries`` defaults to the historical 1-if-attempts shape.

    Pass it explicitly to choose which side of the retry budget the story is on:
    the empty-diff short-circuit is TERMINAL only when the budget is spent, and a
    red attempt (back to dev) while it remains. Before 2026-08-11 it went terminal
    on the first empty diff regardless, which cost `conan-io__conan-19750` four
    unused retries in bench sweep 2.
    """
    db = root / "state" / "factory.db"
    story = StoryRecord(
        direction_id="099",
        app="sacrifice",
        title="t",
        slug=slug,
        scope="backend",
        state=StoryState.TESTS_GREEN.value,
        github_issue_number=1,
        story_file_path=_story_file(root, slug),
        github_branch=feature_branch_name(1, slug),
        dev_retries=(dev_retries if dev_retries is not None else (1 if dev_attempts else 0)),
        dev_attempts_json=json.dumps(dev_attempts) if dev_attempts is not None else None,
    )
    return persist_story(story, db)


_ONE_GREEN_ATTEMPT = [
    {
        "attempt": 1,
        "ts": "2026-01-01T00:00:00+00:00",
        "test_run_passed": True,
        "files_touched": [],
        "test_output_tail": "1 passed",
        "summary": "tests green",
    }
]


# --------------------------------------------------------------------------- #
# unit tests for the two new helpers
# --------------------------------------------------------------------------- #


def test_has_real_dev_attempt_false_when_unset() -> None:
    story = StoryRecord(
        direction_id="099", app="a", title="t", slug="s", scope="backend",
        state=StoryState.TESTS_GREEN.value,
    )
    assert _has_real_dev_attempt(story) is False


def test_has_real_dev_attempt_false_on_malformed_json() -> None:
    story = StoryRecord(
        direction_id="099", app="a", title="t", slug="s", scope="backend",
        state=StoryState.TESTS_GREEN.value, dev_attempts_json="{not valid",
    )
    assert _has_real_dev_attempt(story) is False


def test_has_real_dev_attempt_true_after_real_run() -> None:
    story = StoryRecord(
        direction_id="099", app="a", title="t", slug="s", scope="backend",
        state=StoryState.TESTS_GREEN.value,
        dev_attempts_json=json.dumps(_ONE_GREEN_ATTEMPT),
    )
    assert _has_real_dev_attempt(story) is True


# --------------------------------------------------------------------------- #
# handle_review integration
# --------------------------------------------------------------------------- #


def test_empty_diff_short_circuits_to_blocked_without_review_churn(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dev ran for real, produced nothing, AND THE RETRY BUDGET IS SPENT ->
    immediate BLOCKED_REVIEW_NONCONVERGENT + factory_needs_redesign, without
    burning review cycles.

    The budget condition was added 2026-08-11. Going terminal on the first empty
    diff regardless cost `conan-io__conan-19750` FOUR unused retries in bench
    sweep 2 after 429s truncated its analysis-only first turn. With headroom the
    story now goes back to dev instead — see
    ``test_empty_diff_with_retry_headroom_goes_back_to_dev`` below. Everything
    this test asserts about the terminal case is unchanged.
    """
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main",
    )
    story = _mk_story(
        temp_root,
        slug="empty-diff-story",
        dev_attempts=_ONE_GREEN_ATTEMPT,
        dev_retries=_max_dev_retries(temp_root),
    )
    db = temp_root / "state" / "factory.db"

    # If the short-circuit fails to fire, this would be reached — fail loudly
    # instead of silently falling through to a real (mocked) LLM call.
    def _must_not_be_called(**_kw: Any) -> Any:
        raise AssertionError("text_run must NOT be called on a confirmed empty diff")

    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", _must_not_be_called)

    events: list[dict[str, Any]] = []
    import factory.chain.handlers as handlers_mod

    real_log = handlers_mod.log_story_event

    def _capture(story_id: int, event: str, payload: dict[str, Any], **kw: Any) -> None:
        events.append({"event": event, "payload": payload})
        real_log(story_id, event, payload, **kw)

    monkeypatch.setattr(handlers_mod, "log_story_event", _capture)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.state == StoryState.BLOCKED_REVIEW_NONCONVERGENT.value
    # First occurrence — must NOT have gone through the normal review-cycle
    # bookkeeping (that's the whole point of the short-circuit).
    assert story.reviewer_cycles == 0
    assert story.error is not None and "empty diff" in story.error

    redesign_events = [e for e in events if e["event"] == "factory_needs_redesign"]
    assert redesign_events, "expected a factory_needs_redesign event"
    assert redesign_events[0]["payload"]["kind"] == "empty_diff_short_circuit"


def test_real_diff_flows_through_review_normally(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard: a story with a REAL diff must be completely
    unaffected by the short-circuit — normal dev->review flow, LLM called."""
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main",
    )
    story = _mk_story(temp_root, slug="real-diff-story", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"

    # Simulate the dev having produced a real change: create the story's
    # worktree/branch up front and commit a file on it.
    from factory.chain.handlers import _writing_worktree

    worktree = _writing_worktree(app_config, temp_root, story)
    (worktree / "feature.py").write_text("x = 1\n", encoding="utf-8")
    _run(["git", "add", "."], cwd=worktree)
    _run(["git", "-c", "user.email=t@e.x", "-c", "user.name=T E",
          "commit", "-q", "-m", "add feature"], cwd=worktree)

    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "find_direction_for_story", lambda *a, **k: None)
    monkeypatch.setattr(handlers_mod, "_read_story_file_content", lambda *a, **k: "story")
    monkeypatch.setattr(handlers_mod, "_fetch_latest_test_output", lambda *a, **k: "1 passed")
    monkeypatch.setattr(handlers_mod, "route", lambda *a, **k: "azure/gpt-5.4")
    monkeypatch.setattr(handlers_mod, "_slop_findings_for_story", lambda *a, **k: [])
    monkeypatch.setattr(
        "factory.context.loader.compose_context_prelude", lambda *a, **k: "ctx"
    )

    calls: list[dict[str, Any]] = []
    import factory.runner as runner_mod

    def _fake_text_run(**kwargs: Any) -> str:
        calls.append(kwargs)
        return json.dumps(
            {
                "verdict": "approve",
                "findings": [],
                "test_quality_score": 0.95,
                "test_quality_findings": [],
                "comments_to_post": [],
                "summary": "lgtm",
            }
        )

    monkeypatch.setattr(runner_mod, "text_run", _fake_text_run)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert calls, "the reviewer LLM must have been called (short-circuit did not fire)"
    assert result.next_state == StoryState.REVIEWER_DONE


def test_uncommitted_real_work_routes_back_to_dev_without_model_call(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dev produced REAL, test-passing changes but never ran the final
    ``git commit`` (e.g. it hit a turn/timeout limit near the end of the
    run) — a common real-world case since the dev agent is only
    INSTRUCTED to commit, not forced to. The short-circuit must NOT fire
    (this is genuine work, not a permanently-blockable empty diff), but
    since the fail-closed diff precondition (2026-08-01) the model must
    NOT be called either: the fetched COMMITTED diff is empty, a reviewer
    cannot approve zero commits, and the old behaviour let a mocked LLM
    approve exactly that. Instead the handler emits a deterministic
    request_changes telling dev to commit, burning one (bounded) cycle
    and zero model spend."""
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main",
    )
    story = _mk_story(temp_root, slug="uncommitted-real-work", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"

    # Create the story's worktree and leave a REAL, uncommitted, untracked
    # change sitting in it — exactly what an agent that skipped its final
    # commit would leave behind.
    from factory.chain.handlers import _writing_worktree

    worktree = _writing_worktree(app_config, temp_root, story)
    (worktree / "feature.py").write_text("x = 1\n", encoding="utf-8")
    # Deliberately NOT committed.

    # Sanity: the helper itself must report "not empty" (False) for this
    # topology — uncommitted work must never read as a CONFIRMED empty diff
    # (that would terminally block the story on its first pass).
    assert _dev_produced_empty_diff(story, app_config, temp_root) is False

    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "_slop_findings_for_story", lambda *a, **k: [])

    calls: list[dict[str, Any]] = []
    import factory.runner as runner_mod

    def _fake_text_run(**kwargs: Any) -> str:
        calls.append(kwargs)
        return json.dumps(
            {
                "verdict": "approve",
                "findings": [],
                "test_quality_score": 0.95,
                "test_quality_findings": [],
                "comments_to_post": [],
                "summary": "lgtm",
            }
        )

    monkeypatch.setattr(runner_mod, "text_run", _fake_text_run)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert not calls, "a zero-commit diff must never reach the reviewer LLM"
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert story.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    # One normal (bounded) review cycle was burned — this is a verdict, not
    # an infra failure.
    assert story.reviewer_cycles == 1
    payload = json.loads(story.reviewer_result_json)
    assert payload.get("empty_diff_precondition") is True
    assert any("commit" in (f.get("what") or "") for f in payload["findings"])


def test_empty_diff_with_retry_headroom_goes_back_to_dev(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other side of the budget check.

    `conan-io__conan-19750` in bench sweep 2: Azure 429s truncated an
    analysis-only first turn, the diff was empty, and the story went TERMINAL with
    four retries unused — the dev had already located the gold site. With headroom
    an empty diff is now a red attempt routed back to dev.

    The original point of the short-circuit is preserved exactly: the reviewer LLM
    is still never called on an empty diff.
    """
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main",
    )
    story = _mk_story(
        temp_root, slug="empty-headroom-story", dev_attempts=_ONE_GREEN_ATTEMPT, dev_retries=1
    )
    db = temp_root / "state" / "factory.db"
    assert story.dev_retries + 1 < _max_dev_retries(temp_root), "budget must remain"

    def _must_not_be_called(**_kw: Any) -> Any:
        raise AssertionError("text_run must NOT be called on a confirmed empty diff")

    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", _must_not_be_called)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert story.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert result.payload.get("empty_diff_dev_retry") is True
    # Not a terminal sink, and the story keeps its remaining retries.
    assert story.state != StoryState.BLOCKED_REVIEW_NONCONVERGENT.value
    payload = json.loads(story.reviewer_result_json)
    assert payload["empty_diff_dev_retry"] is True
    assert any("empty" in (f.get("what") or "").lower() for f in payload["findings"])


def test_no_remote_confirmed_empty_diff_short_circuits_via_local_base(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No 'origin' remote at all -> the git-diff check now falls back to the
    LOCAL ``<base>`` ref (2026-08-01 fail-closed fix; before that it returned
    None/unknown and the handler reviewed a fail-open error string). With the
    fallback the empty diff is CONFIRMED, so the short-circuit fires: blocked
    on the first occurrence, no model call, no review cycle burned."""
    app_dir = temp_root / "sacrifice"
    _init_repo_without_remote(app_dir)
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main",
    )
    # Budget SPENT: this is the case where a terminal block is correct.
    story = _mk_story(
        temp_root,
        slug="git-error-story",
        dev_attempts=_ONE_GREEN_ATTEMPT,
        dev_retries=_max_dev_retries(temp_root),
    )
    db = temp_root / "state" / "factory.db"

    # Sanity: the helper now CONFIRMS the empty diff via the local-base
    # fallback instead of degrading to None/unknown.
    assert _dev_produced_empty_diff(story, app_config, temp_root) is True

    def _must_not_be_called(**_kw: Any) -> Any:
        raise AssertionError("text_run must NOT be called on a confirmed empty diff")

    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", _must_not_be_called)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.state == StoryState.BLOCKED_REVIEW_NONCONVERGENT.value
    assert story.reviewer_cycles == 0


def test_no_dev_attempt_empty_diff_requests_changes_without_model_call(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even with an empty branch diff, no TERMINAL short-circuit before dev
    has run for real at least once (``dev_attempts_json`` empty) — the story
    must keep its path back to dev. But since the fail-closed diff
    precondition (2026-08-01) the model is not called either: an empty diff
    cannot be approved, so the handler emits the deterministic
    request_changes (one bounded cycle, zero model spend) and the next dev
    dispatch gets its real chance."""
    app_dir = temp_root / "sacrifice"
    _init_repo_with_origin(app_dir)
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main",
    )
    # No dev_attempts recorded at all.
    story = _mk_story(temp_root, slug="no-attempt-story", dev_attempts=None)
    db = temp_root / "state" / "factory.db"

    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "_slop_findings_for_story", lambda *a, **k: [])

    calls: list[dict[str, Any]] = []
    import factory.runner as runner_mod

    def _fake_text_run(**kwargs: Any) -> str:
        calls.append(kwargs)
        return json.dumps(
            {
                "verdict": "approve",
                "findings": [],
                "test_quality_score": 0.95,
                "test_quality_findings": [],
                "comments_to_post": [],
                "summary": "lgtm",
            }
        )

    monkeypatch.setattr(runner_mod, "text_run", _fake_text_run)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert not calls, "an empty diff must never reach the reviewer LLM"
    # NOT the terminal block — the story keeps a path back to dev.
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert story.reviewer_cycles == 1
