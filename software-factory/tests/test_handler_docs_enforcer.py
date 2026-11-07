"""Tests for ``factory.chain.handlers.handle_docs_enforcer`` — clean vs violating PR files."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.app_config import AppConfig
from factory.chain.handlers import handle_docs_enforcer, persist_story
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def app_config() -> AppConfig:
    return AppConfig(name="sacrifice", repo="x/y")


def _story_at_tech_writer_done(root: Path) -> StoryRecord:
    db = root / "state" / "factory.db"
    return persist_story(
        StoryRecord(
            direction_id="005",
            app="sacrifice",
            title="t",
            slug="t",
            scope="backend",
            state=StoryState.TECH_WRITER_DONE.value,
        ),
        db,
    )


def test_clean_pr_files_advance_to_pr_open(temp_root: Path, app_config: AppConfig) -> None:
    s = _story_at_tech_writer_done(temp_root)
    db = temp_root / "state" / "factory.db"
    pr_files = [
        "src/app.py",
        "tests/test_app.py",
        "context/modules/api.md",  # canonical
        "stories/42-add-healthz.md",  # canonical
    ]
    result = handle_docs_enforcer(
        s, app_config, temp_root, dry_run=True, db_path=db, pr_files=pr_files
    )
    assert result.next_state == StoryState.PR_OPEN


def test_forbidden_path_blocks_with_violation(temp_root: Path, app_config: AppConfig) -> None:
    s = _story_at_tech_writer_done(temp_root)
    db = temp_root / "state" / "factory.db"
    pr_files = [
        "src/app.py",
        "context/decisions/0001-stack.md",  # forbidden
    ]
    result = handle_docs_enforcer(
        s, app_config, temp_root, dry_run=True, db_path=db, pr_files=pr_files
    )
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    # Payload reports the violation.
    violations = result.payload["violations"]
    assert len(violations) == 1
    assert violations[0]["path"] == "context/decisions/0001-stack.md"
    assert violations[0]["reason"] == "forbidden_path"


def test_non_canonical_path_blocks(temp_root: Path, app_config: AppConfig) -> None:
    s = _story_at_tech_writer_done(temp_root)
    db = temp_root / "state" / "factory.db"
    pr_files = ["context/random_note.md"]
    result = handle_docs_enforcer(
        s, app_config, temp_root, dry_run=True, db_path=db, pr_files=pr_files
    )
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert result.payload["violations"][0]["reason"] == "not_canonical"


def test_default_pr_files_derived_from_tech_writer_json(
    temp_root: Path, app_config: AppConfig
) -> None:
    """If pr_files is None, the handler reads tech_writer_result_json paths."""
    s = _story_at_tech_writer_done(temp_root)
    db = temp_root / "state" / "factory.db"
    s.tech_writer_result_json = (
        '{"context_updates": [{"path": "context/modules/auth.md", "action": "rewrite", '
        '"content": "..."}], "rationale": ""}'
    )
    persist_story(s, db)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=True, db_path=db)
    assert result.next_state == StoryState.PR_OPEN
    # The derived files list should include the tech-writer-claimed path.
    assert "context/modules/auth.md" in result.payload["files"]


def test_story_file_only_diff_is_vacuous(temp_root: Path, app_config: AppConfig) -> None:
    """A diff containing ONLY story files delivered nothing — the story file
    is the work order, not the work (benchmark t7, 2026-07-17: a story-file-
    only diff scanned clean because stories/*.md is canonical)."""
    s = _story_at_tech_writer_done(temp_root)
    db = temp_root / "state" / "factory.db"
    result = handle_docs_enforcer(
        s, app_config, temp_root, dry_run=True, db_path=db,
        pr_files=["stories/84-rewrite-docs.md"],
    )
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert result.payload["vacuous_diff"] is True
    assert "vacuous" in (result.error or "")


def test_story_file_plus_context_change_is_not_vacuous(
    temp_root: Path, app_config: AppConfig
) -> None:
    s = _story_at_tech_writer_done(temp_root)
    db = temp_root / "state" / "factory.db"
    result = handle_docs_enforcer(
        s, app_config, temp_root, dry_run=True, db_path=db,
        pr_files=["stories/84-rewrite-docs.md", "context/modules/pipeline.md"],
    )
    assert result.next_state == StoryState.PR_OPEN
    assert "vacuous_diff" not in result.payload


def test_realrun_uses_git_diff_not_tech_writer_declared(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression (story 130 / D109, 2026-07-23): on a REAL run with no
    ``pr_files``, the enforcer must key the vacuous-diff guard off the branch's
    ACTUAL diff, not the tech_writer's self-declared ``context_updates``.

    The tech_writer here declared only a story-file "update"; the real branch
    diff contains the code fix (auth.py). Before the fix the guard saw only the
    declared story file and bounced to REVIEWER_REQUESTED_CHANGES every cycle
    until the story's budget died. It must now reach PR_OPEN.
    """
    from factory.chain import handlers as H

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    # The persona declared ONLY the story file — the exact misbehaviour that
    # tripped the guard live.
    s.tech_writer_result_json = (
        '{"context_updates": [{"path": "stories/310-x.md", "action": "rewrite", '
        '"content": "..."}]}'
    )
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    real_diff = ["backend/app/routes/auth.py", "stories/310-x.md"]
    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: real_diff)
    # Don't touch git/gh — PR opening is exercised elsewhere. Returns a real
    # number (not None — S4 made a None return refuse the PR_OPEN
    # transition, which this test isn't about) so this test stays focused on
    # the file-list-source assertion below.
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 4242)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.PR_OPEN
    assert "vacuous_diff" not in result.payload
    # The file list came from the real diff, not the declared story-only list.
    assert "backend/app/routes/auth.py" in result.payload["files"]


def test_realrun_git_diff_only_story_files_still_vacuous(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard's real purpose is preserved: when the branch's ACTUAL diff is
    only story files, the deliverable is genuinely vacuous."""
    from factory.chain import handlers as H

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["stories/310-x.md"])
    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert result.payload["vacuous_diff"] is True
    assert result.payload.get("empty_diff") is False


def test_realrun_empty_git_diff_is_blocked_not_pr_limbo(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A genuinely-empty real diff (``[]`` — e.g. an in-handler base re-merge
    absorbed a sibling's identical fix) must be BLOCKED back to the dev loop,
    not proceed to open an empty PR (which fails ``gh pr create`` and strands
    the story at PR_OPEN with pr_number=None, invisible to auto-merge).

    Regression for the guard-semantics gap: the old ``if files and not
    substantive`` skipped on ``[]``; the real-diff source makes ``[]`` reachable.
    """
    from factory.chain import handlers as H

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: [])
    # If the guard wrongly passed, this is what would run — fail loudly if so.
    def _should_not_open(*a, **k):  # pragma: no cover - asserts non-invocation
        raise AssertionError("empty-diff story must not reach _open_pr_for_story")

    monkeypatch.setattr(H, "_open_pr_for_story", _should_not_open)
    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert result.payload["vacuous_diff"] is True
    assert result.payload["empty_diff"] is True


def test_realrun_falls_back_to_tech_writer_when_git_diff_unavailable(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the real diff can't be computed (worktree GC'd → helper returns
    ``None``), the enforcer falls back to the tech_writer-declared paths so it
    still has something to scan rather than crashing."""
    from factory.chain import handlers as H

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    s.tech_writer_result_json = (
        '{"context_updates": [{"path": "context/modules/auth.md", "action": "rewrite", '
        '"content": "..."}]}'
    )
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: None)
    # Returns a real number (not None — see S4 tests below for the failure
    # path) so this test stays focused on the fallback-file-list assertion.
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 4243)
    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)
    assert result.next_state == StoryState.PR_OPEN
    assert "context/modules/auth.md" in result.payload["files"]


# --------------------------------------------------------------------------- #
# S4 (019 fail-silent audit): a failed ``gh pr create`` must NOT silently
# advance to PR_OPEN with ``github_pr_number`` left ``None`` — that state has
# no ``orchestrator._DISPATCH`` entry, so nothing ever drove the story again.
# --------------------------------------------------------------------------- #


def test_failed_pr_create_stays_dispatchable_and_visible_in_inbox(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import handlers as H
    from factory.chain import orchestrator as O

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["backend/app.py"])
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: None)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    # Must NOT reach PR_OPEN with a placeholder github_pr_number.
    assert result.next_state != StoryState.PR_OPEN
    assert s.state != StoryState.PR_OPEN.value
    assert s.github_pr_number is None
    assert s.pr_create_retries == 1
    # Visible to a human: error + last_rejection_reason set.
    assert result.error is not None and "gh pr create failed" in result.error
    assert s.error is not None
    assert s.last_rejection_reason is not None
    # Dispatchable: DOCS_ENFORCER_CHECK has an entry in the dispatch table,
    # so the next tick retries PR creation instead of stranding the story.
    assert O._DISPATCH.get(StoryState(s.state)) == "docs_enforcer"


def test_pr_create_retry_succeeds_on_a_later_attempt(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transient failure (bad network, gh auth blip) followed by a
    successful retry must reach PR_OPEN with a real PR number, and the
    retry counter/error state must be cleared on success."""
    from factory.chain import handlers as H

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["backend/app.py"])
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: None)
    first = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)
    assert first.next_state != StoryState.PR_OPEN
    assert s.pr_create_retries == 1

    # Next tick's dispatch re-enters via the SAME state — simulate the
    # retry succeeding.
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 555)
    second = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert second.next_state == StoryState.PR_OPEN
    assert s.github_pr_number == 555
    assert s.pr_create_retries == 0
    assert s.error is None
    assert s.last_rejection_reason is None


def test_pr_create_exhausted_retries_parks_at_blocked_deploy_failed(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A persistently broken ``gh``/push must not retry forever — bounded by
    ``_MAX_PR_CREATE_RETRIES`` (strictly below the hard cap of 3), then
    parked for human action."""
    from factory.chain import handlers as H

    s = _story_at_tech_writer_done(temp_root)
    s.github_branch = "factory/story-1-x"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["backend/app.py"])
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: None)

    # Each call re-enters via the SAME state the orchestrator's ``_DISPATCH``
    # entry for DOCS_ENFORCER_CHECK would re-dispatch on a later tick — no
    # manual state reset needed; the handler's own top-of-function advance
    # (self-loop) carries it forward.
    result = None
    for _ in range(H._MAX_PR_CREATE_RETRIES):
        result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert H._MAX_PR_CREATE_RETRIES < 3, "hard cap is 3; the inner guard must stay below it"
    assert s.pr_create_retries == H._MAX_PR_CREATE_RETRIES
    assert result.next_state == StoryState.BLOCKED_DEPLOY_FAILED
    assert s.state == StoryState.BLOCKED_DEPLOY_FAILED.value
    assert "exhausted" in (s.error or "")
    assert s.last_rejection_reason is not None
