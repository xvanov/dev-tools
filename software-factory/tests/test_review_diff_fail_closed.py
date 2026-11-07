"""Fail-closed reviewer diff precondition + non-improving-score early exit.

Root cause (2026-07-31 SWE-bench batch): ``_fetch_pr_diff_for_review`` was
FAIL-OPEN — a ``git diff origin/<base>...HEAD`` that exited rc=128 (the bench
worktree had no ``origin/<base>`` ref) returned the ERROR TEXT as the diff.
The reviewer reviewed blind in every review of every batch, produced "I cannot
see the diff" blocking findings, and each $0.008 reviewer decision triggered
~$0.34 of dev rework (45x). The same fail-open path fires in production on any
``gh pr diff`` failure (auth expiry, rate limit, GC'd worktree).

The fix, covered here:

* ``_fetch_pr_diff_for_review`` raises ``ReviewDiffUnavailableError`` on ANY
  fetch failure (never returns error text as a diff), and returns ``""`` for
  a genuinely empty diff.
* The no-PR path falls back ``origin/<base>`` -> local ``<base>`` before
  failing closed (``_resolve_diff_base``); ``_changed_files_for_story`` and
  ``_dev_produced_empty_diff`` use the same fallback so the reviewer and the
  docs-enforcer keep agreeing on what changed.
* ``handle_review`` / ``handle_tech_writer`` treat an unavailable diff as a
  hard precondition failure: no model call, no reviewer-cycle burn, route to
  ``BLOCKED_REVIEW_NONCONVERGENT`` (human-visible, bounded auto-recovery).
* Review cycles whose score does not IMPROVE between consecutive rejecting
  cycles block early (strictly below the _MAX_REVIEW_CYCLES=3 hard cap) —
  never route to approved.

Unlike every pre-existing review test, the failure-path tests here do NOT
monkeypatch the diff fetch: they build real git repos/worktrees in tmp and
drive the real subprocess calls.
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
    _BROKEN_PROMPT_MARKERS,
    ReviewDiffUnavailableError,
    _changed_files_for_story,
    _fetch_pr_diff_for_review,
    _resolve_diff_base,
    _writing_worktree,
    handle_review,
    handle_tech_writer,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState

# --------------------------------------------------------------------------- #
# git topology helpers (mirrors tests/test_empty_diff_short_circuit.py)
# --------------------------------------------------------------------------- #


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=True, timeout=30
    )


def _init_repo_without_remote(app_dir: Path) -> Path:
    """Plain local repo, no ``origin`` remote — the bench-harness topology."""
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


_ONE_GREEN_ATTEMPT = [
    {
        "attempt": 1,
        "ts": "2026-01-01T00:00:00+00:00",
        "test_run_passed": True,
        "files_touched": ["feature.py"],
        "test_output_tail": "1 passed",
        "summary": "tests green",
    }
]


def _mk_story(
    root: Path,
    *,
    slug: str,
    state: StoryState = StoryState.TESTS_GREEN,
    dev_attempts: list[dict[str, Any]] | None = None,
) -> StoryRecord:
    db = root / "state" / "factory.db"
    story = StoryRecord(
        direction_id="099",
        app="sacrifice",
        title="t",
        slug=slug,
        scope="backend",
        state=state.value,
        github_issue_number=1,
        story_file_path=_story_file(root, slug),
        github_branch=feature_branch_name(1, slug),
        dev_retries=1 if dev_attempts else 0,
        dev_attempts_json=json.dumps(dev_attempts) if dev_attempts is not None else None,
    )
    return persist_story(story, db)


def _app_config(app_dir: Path) -> AppConfig:
    return AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(app_dir), default_branch="main"
    )


def _commit_feature_in_worktree(worktree: Path, content: str = "x = 1\n") -> None:
    (worktree / "feature.py").write_text(content, encoding="utf-8")
    _run(["git", "add", "."], cwd=worktree)
    _run(
        ["git", "-c", "user.email=t@e.x", "-c", "user.name=T E",
         "commit", "-q", "-m", "add feature"],
        cwd=worktree,
    )


def _delete_all_base_refs(app_dir: Path) -> None:
    """Remove BOTH ``origin/main`` (never existed here) and local ``main``.

    ``main`` is checked out in ``app_dir``, so park the checkout on a
    throwaway branch first. After this, no diff base resolves anywhere.
    """
    _run(["git", "checkout", "-q", "-b", "parked-for-test"], cwd=app_dir)
    _run(["git", "branch", "-q", "-D", "main"], cwd=app_dir)


def _forbid_text_run(monkeypatch: pytest.MonkeyPatch) -> None:
    def _must_not_be_called(**_kw: Any) -> Any:
        raise AssertionError("text_run must NOT be called when the diff precondition fails")

    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", _must_not_be_called)


# --------------------------------------------------------------------------- #
# _resolve_diff_base / _fetch_pr_diff_for_review units (real git)
# --------------------------------------------------------------------------- #


def test_resolve_diff_base_falls_back_to_local_base(tmp_path: Path) -> None:
    repo = _init_repo_without_remote(tmp_path / "repo")
    assert _resolve_diff_base(repo, "main") == "main"


def test_resolve_diff_base_none_when_no_ref_resolves(tmp_path: Path) -> None:
    repo = _init_repo_without_remote(tmp_path / "repo")
    assert _resolve_diff_base(repo, "no-such-branch") is None


def test_fetch_raises_when_no_base_ref(temp_root: Path) -> None:
    """The exact bench failure: no ``origin/<base>`` (rc=128 territory) and —
    after ref deletion — no local ``<base>`` either. The fetch must RAISE,
    never return error text as a diff."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="no-base-ref", dev_attempts=_ONE_GREEN_ATTEMPT)
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree)
    _delete_all_base_refs(app_dir)

    with pytest.raises(ReviewDiffUnavailableError) as excinfo:
        _fetch_pr_diff_for_review(story, app_config, temp_root)
    assert "no diff base ref" in str(excinfo.value)


def test_fetch_falls_back_to_local_base_and_returns_real_diff(temp_root: Path) -> None:
    """Bench topology (no remote, local ``main`` present): the fetch must
    return the REAL diff via the local-base fallback — this is what makes the
    SWE-bench worktrees reviewable at all."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="local-base-fallback", dev_attempts=_ONE_GREEN_ATTEMPT)
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree, "MAGIC_DIFF_CONTENT = 7\n")

    diff = _fetch_pr_diff_for_review(story, app_config, temp_root)
    assert "MAGIC_DIFF_CONTENT" in diff
    assert "feature.py" in diff


def test_fetch_raises_on_gh_pr_diff_failure(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The production case: a PR exists but ``gh pr diff`` fails (auth expiry,
    rate limit). Must raise, not hand the reviewer the stderr."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="gh-fails", dev_attempts=_ONE_GREEN_ATTEMPT)
    story.github_pr_number = 42

    def fake_run(cmd: list[str], *a: Any, **kw: Any) -> subprocess.CompletedProcess[str]:
        assert cmd[:3] == ["gh", "pr", "diff"]
        return subprocess.CompletedProcess(
            args=cmd, returncode=4, stdout="", stderr="HTTP 401: Bad credentials"
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(ReviewDiffUnavailableError) as excinfo:
        _fetch_pr_diff_for_review(story, app_config, temp_root)
    assert "rc=4" in str(excinfo.value)


def test_changed_files_uses_local_base_fallback(temp_root: Path) -> None:
    """Docs-enforcer input path: same fallback, same answer as the reviewer."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="changed-files-fallback", dev_attempts=_ONE_GREEN_ATTEMPT)
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree)

    assert _changed_files_for_story(story, app_config, temp_root) == ["feature.py"]


# --------------------------------------------------------------------------- #
# handle_review: the REAL failure path, end to end (no fetch monkeypatch)
# --------------------------------------------------------------------------- #


def test_unfetchable_diff_blocks_without_model_call_or_cycle_burn(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Drive the ACTUAL failure: a real temp worktree where neither
    ``origin/<base>`` nor local ``<base>`` resolves, real subprocess calls.
    The story must route to the blocked state, the model must NOT be called,
    and reviewer_cycles must NOT increment."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="unfetchable-diff", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"
    # Real committed work exists — this is NOT the empty-diff case; only the
    # base ref is gone (the bench harness / GC'd-substrate class).
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree)
    _delete_all_base_refs(app_dir)

    _forbid_text_run(monkeypatch)

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
    # Hard precondition failure — not a review verdict: no cycle burned.
    assert story.reviewer_cycles == 0
    assert story.error is not None and "diff precondition failed" in story.error
    # Lands in `factory inbox` (keys off last_rejection_reason).
    assert story.last_rejection_reason is not None
    diff_events = [e for e in events if e["event"] == "review_diff_unavailable"]
    assert diff_events, "expected a review_diff_unavailable event"
    assert diff_events[0]["payload"]["persona"] == "reviewer"
    # The fail-open error text must never be stored as if it were a diff.
    payload = json.loads(story.reviewer_result_json)
    assert payload.get("review_diff_unavailable") is True


def test_consecutive_empty_diff_cycles_block_at_two(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-safety of the deterministic empty-diff request_changes: if dev
    never commits, the SECOND empty-diff cycle must terminate in the blocked
    sink (identical findings signature + frozen 0.0 score), never churn to
    the hard cap — and never approve."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="double-empty", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"
    # Dirty worktree (uncommitted work) so the terminal short-circuit does
    # NOT fire and the deterministic request_changes path is exercised.
    worktree = _writing_worktree(app_config, temp_root, story)
    (worktree / "feature.py").write_text("x = 1\n", encoding="utf-8")

    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "_slop_findings_for_story", lambda *a, **k: [])
    _forbid_text_run(monkeypatch)

    r1 = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)
    assert r1.next_state == StoryState.REVIEWER_REQUESTED_CHANGES

    # Dev "ran" again but still committed nothing; chain re-reaches review.
    story.state = StoryState.TESTS_GREEN.value
    persist_story(story, db)
    r2 = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)
    assert r2.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.reviewer_cycles == 2, "must terminate strictly below the hard cap"


def test_fallback_diff_flows_to_model_with_real_content(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same no-remote topology but with local ``main`` intact: the review must
    proceed normally and the PROMPT must contain the real diff (the blind
    spot that invalidated the benchmark)."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="fallback-real-diff", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree, "MAGIC_DIFF_CONTENT = 7\n")

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

    assert calls, "the reviewer LLM must be called when the fallback yields a diff"
    prompt = calls[-1]["prompt"]
    assert "MAGIC_DIFF_CONTENT" in prompt, "the reviewer must SEE the real diff"
    assert result.next_state == StoryState.REVIEWER_DONE


# --------------------------------------------------------------------------- #
# handle_tech_writer: same precondition, different persona
# --------------------------------------------------------------------------- #


def _patch_tech_writer_prep(monkeypatch: pytest.MonkeyPatch) -> None:
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "find_direction_for_story", lambda *a, **k: None)
    monkeypatch.setattr(handlers_mod, "_read_story_file_content", lambda *a, **k: "story")
    monkeypatch.setattr(handlers_mod, "_read_persona_prompt", lambda _p: "persona")
    monkeypatch.setattr(
        "factory.context.loader.compose_context_prelude", lambda *a, **k: "ctx"
    )


def test_tech_writer_unfetchable_diff_blocks_without_model_call(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(
        temp_root, slug="tw-unfetchable",
        state=StoryState.REVIEWER_DONE, dev_attempts=_ONE_GREEN_ATTEMPT,
    )
    db = temp_root / "state" / "factory.db"
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree)
    _delete_all_base_refs(app_dir)

    _patch_tech_writer_prep(monkeypatch)
    _forbid_text_run(monkeypatch)

    result = handle_tech_writer(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.error is not None and "tech_writer diff precondition failed" in story.error
    # tech_writer must NOT clobber the reviewer's real (approve) record.
    assert story.reviewer_result_json is None


def test_tech_writer_empty_diff_blocks_without_model_call(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reviewer approved a NON-empty diff, so an empty diff at
    tech_writer time means the worktree substrate changed under the chain —
    block, don't document nothing."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(
        temp_root, slug="tw-empty",
        state=StoryState.REVIEWER_DONE, dev_attempts=_ONE_GREEN_ATTEMPT,
    )
    db = temp_root / "state" / "factory.db"
    # Worktree exists but has NO commits beyond base (local main resolves).
    _writing_worktree(app_config, temp_root, story)

    _patch_tech_writer_prep(monkeypatch)
    _forbid_text_run(monkeypatch)

    result = handle_tech_writer(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.error is not None and "empty" in story.error


# --------------------------------------------------------------------------- #
# non-improving-score early exit (strictly below the hard cap)
# --------------------------------------------------------------------------- #


def _cycle(
    story: StoryRecord,
    app_config: AppConfig,
    temp_root: Path,
    db: Path,
    *,
    score: float,
    what: str,
) -> Any:
    """One fixture-driven rejecting review cycle with DISTINCT findings (so
    the stability guard never fires and the score guard is isolated)."""
    story.state = StoryState.TESTS_GREEN.value
    persist_story(story, db)
    fixture = {
        "verdict": "request_changes",
        "findings": [
            {"severity": "high", "location": f"src/{what}.py:1", "what": what,
             "criterion": "correctness"}
        ],
        "test_quality_score": score,
        "test_quality_findings": [],
        "comments_to_post": [],
        "summary": "changes",
    }
    return handle_review(
        story, app_config, temp_root, dry_run=True, db_path=db, fixture=fixture
    )


def test_flat_score_blocks_at_cycle_two_never_approves(temp_root: Path) -> None:
    """Yesterday's trajectories were flat (0.45 -> 0.35 -> 0.40); more cycles
    bought expensive wrong answers. A non-improving score between consecutive
    cycles must block at cycle 2 — STRICTLY below the hard cap of 3 — and
    must route to the blocked sink, never approved."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="flat-score", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"

    r1 = _cycle(story, app_config, temp_root, db, score=0.45, what="first-issue")
    assert r1.next_state == StoryState.REVIEWER_REQUESTED_CHANGES

    r2 = _cycle(story, app_config, temp_root, db, score=0.35, what="second-issue")
    assert r2.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.reviewer_cycles == 2, "guard must fire strictly below the hard cap of 3"
    assert story.error is not None and "did not improve" in story.error


def test_equal_score_counts_as_non_improving(temp_root: Path) -> None:
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="equal-score", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"

    _cycle(story, app_config, temp_root, db, score=0.45, what="first-issue")
    r2 = _cycle(story, app_config, temp_root, db, score=0.45, what="second-issue")
    assert r2.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT


def test_improving_score_keeps_cycling_until_hard_cap(temp_root: Path) -> None:
    """A genuinely improving trajectory is progress: cycle 2 must NOT block
    on the score guard; the absolute backstop still blocks at cycle 3."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="improving-score", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"

    r1 = _cycle(story, app_config, temp_root, db, score=0.40, what="first-issue")
    assert r1.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    r2 = _cycle(story, app_config, temp_root, db, score=0.55, what="second-issue")
    assert r2.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    r3 = _cycle(story, app_config, temp_root, db, score=0.65, what="third-issue")
    assert r3.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert story.error is not None and "hard cap" in story.error


# --------------------------------------------------------------------------- #
# marker backstop
# --------------------------------------------------------------------------- #


def test_diff_failure_markers_registered_in_both_marker_lists() -> None:
    """The fail-open error strings are now regression BACKSTOPS: they must be
    in the handlers marker list AND the runner's duplicated copy (the two are
    kept in sync by convention — this test enforces it).

    Expected markers are composed by concatenation here for the same reason
    they are in the source: the contiguous literals must never appear in the
    repo's own files (see test_marker_literals_absent_from_source below).
    """
    from factory.runner import _BROKEN_PROMPT_MARKERS as runner_markers

    expected = (
        "(gh pr diff " + "#",
        "...HEAD " + "returned rc=",
        "(gh pr diff " + "failed",
        "(git diff worktree " + "failed",
    )
    for marker in expected:
        assert marker in _BROKEN_PROMPT_MARKERS
        assert marker in runner_markers
    assert set(runner_markers) == set(_BROKEN_PROMPT_MARKERS)
    # The bare prose fragment must NOT be a marker: legitimate code and test
    # output legitimately contain it (e.g. ``msg = f"command returned
    # rc={rc}"`` — a real committed line that crashed a real review).
    assert ("returned" + " rc=") not in _BROKEN_PROMPT_MARKERS
    assert ("returned" + " rc=") not in runner_markers


def test_marker_literals_absent_from_source() -> None:
    """No contiguous marker literal may appear in handlers.py / runner.py
    source. If one did, any loop-2 self-edit whose DIFF CONTEXT includes the
    marker tuple would embed the literal in the review prompt's diff section
    and trip the guard — a permanently unreviewable, crash-looping story.
    The source builds each diff-failure marker by concatenation; this test
    pins that."""
    import factory.chain.handlers as handlers_mod
    import factory.runner as runner_mod

    for mod in (handlers_mod, runner_mod):
        src = Path(mod.__file__).read_text(encoding="utf-8")
        for marker in (
            "(gh pr diff " + "#",
            "...HEAD " + "returned rc=",
            "(gh pr diff " + "failed",
            "(git diff worktree " + "failed",
            "(could not resolve " + "writing worktree",
        ):
            assert marker not in src, (
                f"{mod.__name__} contains the contiguous marker literal "
                f"{marker!r}; build it by concatenation instead"
            )


def test_diff_containing_returned_rc_prose_reviews_cleanly(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A committed change whose CODE contains the prose ``returned rc=`` (the
    adversarial reviewer's exact attack: ``msg = f"command returned
    rc={rc}"``) must flow through a real review — model called, prompt
    contains the line, no broken-marker crash."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="rc-prose", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(
        worktree, 'msg = f"command returned rc={rc}"\nprint(msg)\n'
    )

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

    assert calls, "legitimate 'returned rc=' prose in a diff must reach the model"
    assert "command returned rc=" in calls[-1]["prompt"]
    assert result.next_state == StoryState.REVIEWER_DONE


def test_non_utf8_commit_reviews_cleanly(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real latin-1 commit (``b"# caf\\xe9"``) must not escape the
    fail-closed taxonomy as an uncaught UnicodeDecodeError: the fetch decodes
    with errors="replace" and the (real, slightly-mangled) diff is reviewed —
    SWE-bench repos contain non-UTF-8 source, so this is a live bench path."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="latin1-diff", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"
    worktree = _writing_worktree(app_config, temp_root, story)
    (worktree / "legacy.py").write_bytes(b"# caf\xe9 legacy encoding\nVALUE = 1\n")
    _run(["git", "add", "."], cwd=worktree)
    _run(
        ["git", "-c", "user.email=t@e.x", "-c", "user.name=T E",
         "commit", "-q", "-m", "add latin-1 file"],
        cwd=worktree,
    )

    # Unit level: the fetch itself must return a diff, not raise.
    diff = _fetch_pr_diff_for_review(story, app_config, temp_root)
    assert "legacy.py" in diff and "VALUE = 1" in diff

    # Handler level: the review flows to the model.
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

    assert calls, "a non-UTF-8 diff must be reviewed, not crash the handler"
    assert result.next_state == StoryState.REVIEWER_DONE


def test_diff_unavailable_block_does_not_pollute_score_history(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The infra block must NOT append a synthetic 0.0-score entry to
    reviewer_history_json — otherwise the next REAL rejection after
    auto-recovery trivially counts as 'improving' in the non-improving-score
    guard and buys a wasted extra cycle."""
    app_dir = _init_repo_without_remote(temp_root / "sacrifice")
    app_config = _app_config(app_dir)
    story = _mk_story(temp_root, slug="no-history-pollution", dev_attempts=_ONE_GREEN_ATTEMPT)
    db = temp_root / "state" / "factory.db"
    worktree = _writing_worktree(app_config, temp_root, story)
    _commit_feature_in_worktree(worktree)
    _delete_all_base_refs(app_dir)

    _forbid_text_run(monkeypatch)

    result = handle_review(story, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert json.loads(story.reviewer_history_json or "[]") == []
