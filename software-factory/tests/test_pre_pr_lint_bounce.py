"""Two halves of sacrifice story 183 (2026-08-09), which killed two of three
fresh stories in one night. See handlers._residual_changed_py_lint,
handlers._push_fix_to_existing_pr, and handle_docs_enforcer.

THE REAL DEFECT WAS THE MISSING PUSH — not a dev that could not act on
findings. Story 183's evidence is explicit that the dev DID act:
``response_bodies.ndjson`` at 21:45:07 shows it fixing the F401s and the E712 it
was handed, and ``_commit_green_dev_work`` committed that fix locally. But
``git.ndjson`` records exactly ONE push for the entire story — the original PR
push. The only push site for a story's work is ``_open_pr_for_story``, which
``handle_docs_enforcer`` calls under ``github_pr_number is None``; the only
other push in the codebase is dev-exhausted WIP preservation. So once a PR
existed, no fix cycle could ever reach GitHub: the PR head never moved, CI never
re-ran, the identical-signature guard adjudicated a STALE sha, and the story was
terminally parked at ``blocked_ci_unresolved`` with the PR closed. That silently
swallowed every post-PR fix, lint or otherwise.

  1. ``_push_fix_to_existing_pr`` — a post-PR fix cycle pushes its new commits,
     so the PR head moves and CI re-runs on the actual fix. Only when the branch
     is genuinely ahead: a cycle that produced nothing must not be handed a
     fresh sha it did not earn, or the identical-signature guard (correct for a
     truly-no-fix cycle) is defeated.
  2. The pre-PR lint bounce — the cheaper half. ``ruff check`` AND
     ``ruff format --check`` over the branch's own changed ``.py`` files before
     the PR exists, sending the story back through the dev loop once with the
     exact findings. No chain gate runs lint otherwise: an app's
     ``lint_command`` / ``format_check_command`` are config the chain records
     but never executes. Capped at one bounce.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from factory.app_config import AppConfig
from factory.chain.handlers import (
    _residual_changed_py_lint,
    handle_docs_enforcer,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState

# --------------------------------------------------------------------------- #
# Real-git / real-ruff tests for the helper itself.
# --------------------------------------------------------------------------- #


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=True, timeout=60
    )


def _init_repo_with_origin(app_dir: Path) -> Path:
    """Working repo pushed to a bare 'origin', so ``origin/main`` resolves —
    the same topology the chain uses against a real remote."""
    origin = app_dir.parent / f"{app_dir.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=app_dir.parent)
    app_dir.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=app_dir)
    _run(["git", "config", "user.email", "t@e.x"], cwd=app_dir)
    _run(["git", "config", "user.name", "T E"], cwd=app_dir)
    (app_dir / "pyproject.toml").write_text(
        '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
    )
    # A PRE-EXISTING module whose import block is already there. The branch will
    # modify it — which is the shape the autoformat refuses to clean up.
    (app_dir / "legacy.py").write_text(
        '"""Legacy module."""\n\nimport os\n\nHOME = os.getcwd()\n', encoding="utf-8"
    )
    _run(["git", "add", "."], cwd=app_dir)
    _run(["git", "commit", "-q", "-m", "init"], cwd=app_dir)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=app_dir)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=app_dir)
    return app_dir


def _commit_branch(repo: Path, name: str, rel: str, content: str) -> None:
    _run(["git", "checkout", "-q", "-b", name], cwd=repo)
    (repo / rel).write_text(content, encoding="utf-8")
    _run(["git", "add", rel], cwd=repo)
    _run(["git", "commit", "-q", "-m", f"edit {rel}"], cwd=repo)


def test_residual_lint_reports_the_violation_autoformat_will_not_fix(tmp_path: Path) -> None:
    """Story 183's exact shape. The branch edits ONE line of a pre-existing file
    and, in doing so, orphans a PRE-EXISTING import. ``_autoformat_changed_py_
    before_pr`` refuses to touch it by design — it only deletes imports on lines
    the BRANCH ITSELF added — so nothing in the chain caught this and CI did.

    Both halves are asserted: the autoformat leaves the import alone (the
    premise), and the residual check reports it (the fix).
    """
    from factory.chain.handlers import _autoformat_changed_py_before_pr

    repo = _init_repo_with_origin(tmp_path / "app")
    # Only the LAST line changes; ``import os`` stays exactly where main has it,
    # and is now unused.
    _commit_branch(
        repo,
        "story/183-x",
        "legacy.py",
        '"""Legacy module."""\n\nimport os\n\nHOME = "/tmp"\n',
    )

    _autoformat_changed_py_before_pr(repo, "main")

    # Premise: the conservative autoformat did NOT (and must not) remove it.
    assert "import os" in (repo / "legacy.py").read_text(encoding="utf-8")

    residual = _residual_changed_py_lint(repo, "main")
    assert residual is not None, "an unused pre-existing import must not reach the PR silently"
    assert "F401" in residual
    assert "legacy.py" in residual


def test_residual_lint_also_reports_format_only_reds(tmp_path: Path) -> None:
    """An app's CI runs TWO ruff commands — ``gates.lint_command`` and
    ``gates.format_check_command``. A branch that passes ``ruff check`` but
    fails ``ruff format --check`` ships an equally doomed PR, so both are
    reproduced here."""
    repo = _init_repo_with_origin(tmp_path / "app")
    # Lint-clean (no unused imports, no long lines) but badly formatted.
    _commit_branch(
        repo,
        "story/1-fmt",
        "feat.py",
        '"""Feature."""\n\n\n\n\nX   =    1\n',
    )
    residual = _residual_changed_py_lint(repo, "main")
    assert residual is not None
    assert "ruff format --check" in residual
    assert "feat.py" in residual


def test_residual_lint_is_none_when_the_branch_is_clean(tmp_path: Path) -> None:
    repo = _init_repo_with_origin(tmp_path / "app")
    _commit_branch(
        repo,
        "story/1-clean",
        "feat.py",
        '"""Feature."""\n\nimport os\n\nHOME = os.getcwd()\n',
    )
    assert _residual_changed_py_lint(repo, "main") is None


def test_residual_lint_fails_open_when_ruff_cannot_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-OPEN is the correct direction here, and it is a deliberate exception
    to the usual fail-safe rule: GitHub CI is the authoritative lint backstop,
    so this check is only an optimisation that saves a doomed PR round-trip.
    Blocking PR creation because the LOCAL ruff is missing or wedged would trade
    a bounded, already-handled failure for a brand-new unbounded one.
    """
    repo = _init_repo_with_origin(tmp_path / "app")
    _commit_branch(
        repo, "story/1-x", "feat.py", '"""F."""\n\nimport os\nimport sys\n\nH = os.getcwd()\n'
    )
    # Sanity: it IS red before we break the runner, so the None below is caused
    # by the failure and not by a clean branch.
    assert _residual_changed_py_lint(repo, "main") is not None

    real_run = subprocess.run

    def _boom(args, *a, **k):  # type: ignore[no-untyped-def]
        # Only ``uv run ruff`` disappears; git still works, so the helper gets
        # all the way to the ruff invocation before it fails.
        if list(args)[:2] == ["uv", "run"]:
            raise FileNotFoundError("uv")
        return real_run(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", _boom)
    assert _residual_changed_py_lint(repo, "main") is None


# --------------------------------------------------------------------------- #
# Handler-level: the bounce, the cap, and the clean path.
# --------------------------------------------------------------------------- #


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def app_config() -> AppConfig:
    return AppConfig(name="sacrifice", repo="x/y")


def _story_ready_for_pr(root: Path) -> StoryRecord:
    db = root / "state" / "factory.db"
    s = persist_story(
        StoryRecord(
            direction_id="183",
            app="sacrifice",
            title="t",
            slug="story-183",
            scope="backend",
            state=StoryState.TECH_WRITER_DONE.value,
        ),
        db,
    )
    s.github_branch = "factory/story-183-x"
    # An already-approved story arrives here with review cycles on the clock.
    s.reviewer_cycles = 3
    s.dev_retries = 2
    persist_story(s, db)
    return s


_RUFF_OUT = "legacy.py:3:8: F401 [*] `os` imported but unused\nFound 1 error."


def test_residual_lint_bounces_the_story_back_to_dev_with_the_violations(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import handlers as H

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["legacy.py"])
    monkeypatch.setattr(H, "_residual_lint_for_story", lambda *a, **k: _RUFF_OUT)

    def _should_not_open(*a, **k):  # pragma: no cover - asserts non-invocation
        raise AssertionError("a lint-red branch must not reach _open_pr_for_story")

    monkeypatch.setattr(H, "_open_pr_for_story", _should_not_open)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    assert s.github_pr_number is None
    assert result.payload["lint_bounce"] is True
    assert result.payload["residual_lint"] == _RUFF_OUT

    # The dev cycle reads findings out of reviewer_result_json (see
    # _handle_dev_once's reviewer_findings plumbing) — the violations must be
    # THERE, in the shape every consumer indexes with ``.get(...)``.
    payload = json.loads(s.reviewer_result_json or "{}")
    findings = payload["findings"]
    assert isinstance(findings, list) and isinstance(findings[0], dict)
    assert _RUFF_OUT in findings[0]["what"]
    assert findings[0]["severity"] == "high"
    assert payload["source"] == "pre_pr_lint"

    # Counters reset, same as the CI-fix re-dispatch: an approved story can sit
    # at the review cap, and the follow-up pass must not read as non-convergence.
    assert s.reviewer_cycles == 0
    assert s.dev_retries == 0


def test_second_red_opens_the_pr_anyway_the_bounce_is_capped(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exactly one bounce per story. The second red ships the PR and lets the
    (unchanged) CI path adjudicate — a repeating bounce would be a new uncapped
    loop, which the guardrails forbid."""
    from factory.chain import handlers as H

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["legacy.py"])
    monkeypatch.setattr(H, "_residual_lint_for_story", lambda *a, **k: _RUFF_OUT)
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: None)

    first = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)
    assert first.next_state == StoryState.REVIEWER_REQUESTED_CHANGES

    # The story goes round the dev → review → tech_writer loop and arrives back
    # at the enforcer. Ruff is STILL red (the dev didn't fix it).
    s.state = StoryState.TECH_WRITER_DONE.value
    persist_story(s, db)
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 1830)

    second = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert second.next_state == StoryState.PR_OPEN
    assert s.github_pr_number == 1830
    # Loud, not silent: the trace says we knowingly shipped a lint-red branch.
    assert second.payload["lint_bounce_capped"] is True
    assert second.payload["residual_lint"] == _RUFF_OUT

    # Exactly ONE bounce was ever recorded across both cycles — the cap is real,
    # not merely a constant that happens to read 1.
    from factory.chain.event_log import read_story_events

    assert s.id is not None
    events = read_story_events(s.id, software_factory_root=temp_root, slug_hint=s.slug)
    assert [e["event"] for e in events].count("lint_bounce") == 1
    # And it stays strictly below the repo-wide hard loop cap of 3.
    assert H._MAX_LINT_BOUNCES < 3


def test_bounce_count_survives_a_fresh_story_object(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap is derived from the story's on-disk event stream, not from an
    in-memory field — so it survives a process restart (the whole reason the
    ``_gate_block_history`` precedent was chosen over a counter column, every
    candidate column being reset somewhere on this very loop)."""
    from factory.chain import handlers as H
    from factory.chain.resume import load_story

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["legacy.py"])
    monkeypatch.setattr(H, "_residual_lint_for_story", lambda *a, **k: _RUFF_OUT)
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: None)
    handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    # Re-read the row exactly as a later tick in a new process would.
    assert s.id is not None
    fresh = load_story(db, s.id)
    assert fresh is not None
    assert H._lint_bounces_so_far(fresh, temp_root) == 1


def test_unreadable_bounce_history_reports_the_cap_as_reached(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FAIL DIRECTION. The event-stream count is the ONLY thing bounding the
    bounce loop, so a read that fails must report "cap reached" (→ PR opens),
    never 0 (→ bounce forever). Fail-safe here means "do not bounce": the
    un-bounced branch still meets GitHub CI; an unbounded loop has no backstop.
    """
    from factory.chain import handlers as H

    s = _story_ready_for_pr(temp_root)

    def _boom(*a, **k):  # type: ignore[no-untyped-def]
        raise OSError("log unreadable")

    monkeypatch.setattr("factory.chain.event_log.read_story_events", _boom)
    assert H._lint_bounces_so_far(s, temp_root) == H._MAX_LINT_BOUNCES

    # A story with no id can never be counted either — same verdict.
    orphan = StoryRecord(direction_id="d", app="a", title="t", slug="s", scope="backend")
    assert orphan.id is None
    assert H._lint_bounces_so_far(orphan, temp_root) == H._MAX_LINT_BOUNCES


def test_bounce_is_skipped_when_the_story_cannot_afford_the_loop(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bounce costs a dev + review + tech_writer + enforcer dispatch. Near the
    per-story attempt cap that loop cannot finish, and the story would die at
    BLOCKED_BUDGET_EXCEEDED with its branch unpushed and NO PR — strictly worse
    than the lint-red PR the bounce was avoiding. So open the PR instead."""
    from factory.chain import handlers as H

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"
    # Two attempts left; a bounce needs _LINT_BOUNCE_ATTEMPT_HEADROOM (4).
    from factory.settings.loader import load_settings

    cap = int(load_settings(temp_root).caps.per_story_attempts)
    s.total_attempts = cap - 2
    persist_story(s, db)
    assert H._lint_bounce_budget_headroom(s, temp_root)[0] is False

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["legacy.py"])
    monkeypatch.setattr(H, "_residual_lint_for_story", lambda *a, **k: _RUFF_OUT)
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 9001)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.PR_OPEN
    assert s.github_pr_number == 9001
    assert result.payload["lint_bounce_skipped_budget"] is True
    assert "lint_bounce" not in result.payload
    # No bounce was spent, so the cap is still available if the budget recovers.
    assert H._lint_bounces_so_far(s, temp_root) == 0


def test_clean_branch_opens_the_pr_as_before(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import handlers as H

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["legacy.py"])
    monkeypatch.setattr(H, "_residual_lint_for_story", lambda *a, **k: None)
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 4242)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.PR_OPEN
    assert s.github_pr_number == 4242
    assert "lint_bounce" not in result.payload
    assert "lint_bounce_capped" not in result.payload
    # An untouched story keeps its counters — the reset belongs to the bounce.
    assert s.reviewer_cycles == 3


def test_lint_check_failure_does_not_block_pr_creation(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Helper unavailable (ruff missing / timeout / no worktree) → ``None`` →
    the PR opens exactly as it did before this feature existed. Fail-open is
    justified because GitHub CI is the authoritative backstop; see
    ``_residual_changed_py_lint``'s docstring."""
    from factory.chain import handlers as H

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"
    # Point at a repo path that definitively does not exist, so the REAL
    # ``_residual_lint_for_story`` runs and takes its production fail-open path
    # (no worktree) — a stub of the helper would prove nothing here.
    app_config = AppConfig(
        name="sacrifice", repo="x/y", app_repo_path=str(temp_root / "no-such-repo")
    )

    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["legacy.py"])
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 77)

    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.PR_OPEN
    assert s.github_pr_number == 77
    assert "lint_bounce" not in result.payload


# --------------------------------------------------------------------------- #
# THE PUSH FIX — a post-PR fix cycle must move the PR head.
#
# Story 183: the dev fixed what CI reported and _commit_green_dev_work committed
# it; git.ndjson then shows exactly ONE push for the whole story (the original).
# handle_docs_enforcer's PR block is gated on `github_pr_number is None`, and the
# only other push site is dev-exhausted WIP preservation — so the fix never
# reached GitHub, CI never re-ran, and the identical-signature guard parked the
# story on a STALE head sha. Every post-PR fix was swallowed, not just lint ones.
# --------------------------------------------------------------------------- #


def _worktree_with_pushed_branch(root: Path, branch: str) -> Path:
    """An app worktree whose ``branch`` already exists on its origin — the state
    a story is in once its PR has been opened."""
    repo = _init_repo_with_origin(root / "app")
    _run(["git", "checkout", "-q", "-b", branch], cwd=repo)
    (repo / "feat.py").write_text('"""F."""\n\nX = 1\n', encoding="utf-8")
    _run(["git", "add", "feat.py"], cwd=repo)
    _run(["git", "commit", "-q", "-m", "original PR commit"], cwd=repo)
    _run(["git", "push", "-q", "-u", "origin", branch], cwd=repo)
    return repo


def _remote_head(repo: Path, branch: str) -> str:
    return _run(["git", "rev-parse", f"origin/{branch}"], cwd=repo).stdout.strip()


def _local_head(repo: Path) -> str:
    return _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()


def test_post_pr_fix_cycle_pushes_the_new_commit(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The regression that mattered: a story re-arriving at the enforcer WITH a
    PR number and a new local commit must push, so the PR head moves and GitHub
    re-runs CI on the actual fix."""
    from factory.chain import handlers as H

    branch = "factory/story-183-x"
    repo = _worktree_with_pushed_branch(temp_root, branch)

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"
    s.github_pr_number = 183  # the PR already exists
    s.github_branch = branch
    persist_story(s, db)

    # dev's fix, committed locally by _commit_green_dev_work and — before this
    # change — never pushed by anything.
    (repo / "feat.py").write_text('"""F."""\n\nX = 2\n', encoding="utf-8")
    _run(["git", "add", "feat.py"], cwd=repo)
    _run(["git", "commit", "-q", "-m", "fix the CI failure"], cwd=repo)
    assert _local_head(repo) != _remote_head(repo, branch), "premise: remote is behind"

    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: repo)
    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["feat.py"])

    def _should_not_open(*a, **k):  # pragma: no cover - asserts non-invocation
        raise AssertionError("a story that already has a PR must not re-create one")

    monkeypatch.setattr(H, "_open_pr_for_story", _should_not_open)

    app_config = AppConfig(name="sacrifice", repo="x/y", app_repo_path=str(repo))
    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.PR_OPEN
    assert result.payload["fix_pushed"] is True
    assert "fix_push_error" not in result.payload
    # THE assertion: the remote head now equals the fix commit.
    assert _remote_head(repo, branch) == _local_head(repo)


def test_post_pr_cycle_with_no_new_commit_does_not_push(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cycle that produced nothing must NOT be handed a fresh head sha it did
    not earn. The identical-signature park is the correct outcome for a dev that
    genuinely changed nothing, and manufacturing a new sha would defeat the one
    guard that stops that loop."""
    from factory.chain import handlers as H

    branch = "factory/story-184-x"
    repo = _worktree_with_pushed_branch(temp_root, branch)

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"
    s.github_pr_number = 184
    s.github_branch = branch
    persist_story(s, db)

    head_before = _remote_head(repo, branch)
    assert _local_head(repo) == head_before, "premise: nothing new locally"

    pushes: list[list[str]] = []
    real_run = subprocess.run

    def _spy(args, *a, **k):  # type: ignore[no-untyped-def]
        argv = list(args)
        if argv[:2] == ["git", "push"]:
            pushes.append(argv)
        return real_run(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", _spy)
    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: repo)
    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["feat.py"])
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 184)

    app_config = AppConfig(name="sacrifice", repo="x/y", app_repo_path=str(repo))
    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.PR_OPEN
    assert result.payload["fix_pushed"] is False
    assert "fix_push_error" not in result.payload
    assert pushes == [], "no new commits → no push"
    assert _remote_head(repo, branch) == head_before

    # Recorded, not silent: the trace says why the head is unchanged.
    from factory.chain.event_log import read_story_events

    assert s.id is not None
    events = [
        e["event"]
        for e in read_story_events(s.id, software_factory_root=temp_root, slug_hint=s.slug)
    ]
    assert "fix_push_skipped_no_commits" in events


def test_push_uses_force_with_lease_and_the_story_branch(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same flags and rationale as ``_open_pr_for_story``'s push: story branches
    are factory-owned and single-writer, origin may hold stale commits from
    abandoned attempts, and the lease still aborts if origin moved."""
    from factory.chain import handlers as H

    branch = "factory/story-185-x"
    repo = _worktree_with_pushed_branch(temp_root, branch)
    (repo / "feat.py").write_text('"""F."""\n\nX = 3\n', encoding="utf-8")
    _run(["git", "add", "feat.py"], cwd=repo)
    _run(["git", "commit", "-q", "-m", "fix"], cwd=repo)

    s = _story_ready_for_pr(temp_root)
    s.github_pr_number = 185
    s.github_branch = branch
    persist_story(s, temp_root / "state" / "factory.db")

    pushes: list[list[str]] = []
    real_run = subprocess.run

    def _spy(args, *a, **k):  # type: ignore[no-untyped-def]
        argv = list(args)
        if argv[:2] == ["git", "push"]:
            pushes.append(argv)
        return real_run(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", _spy)
    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: repo)

    app_config = AppConfig(name="sacrifice", repo="x/y", app_repo_path=str(repo))
    pushed, err = H._push_fix_to_existing_pr(s, app_config, temp_root)

    assert pushed is True and err is None
    assert pushes == [["git", "push", "--force-with-lease", "origin", branch]]


def test_push_failure_surfaces_in_story_error_and_still_advances(
    temp_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed push swallowed in silence is the very failure class being fixed.
    The story still advances to PR_OPEN (refusing would strand it where
    auto-merge cannot see it), but ``story.error`` names the push failure so the
    park that follows cannot pretend the stale CI verdict describes the work."""
    from factory.chain import handlers as H

    branch = "factory/story-186-x"
    repo = _worktree_with_pushed_branch(temp_root, branch)
    (repo / "feat.py").write_text('"""F."""\n\nX = 4\n', encoding="utf-8")
    _run(["git", "add", "feat.py"], cwd=repo)
    _run(["git", "commit", "-q", "-m", "fix"], cwd=repo)

    s = _story_ready_for_pr(temp_root)
    db = temp_root / "state" / "factory.db"
    s.github_pr_number = 186
    s.github_branch = branch
    persist_story(s, db)

    real_run = subprocess.run

    def _break_push(args, *a, **k):  # type: ignore[no-untyped-def]
        argv = list(args)
        if argv[:2] == ["git", "push"]:
            return subprocess.CompletedProcess(argv, 1, "", "! [remote rejected] stale info")
        return real_run(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", _break_push)
    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: repo)
    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["feat.py"])
    monkeypatch.setattr(H, "_open_pr_for_story", lambda *a, **k: 186)

    app_config = AppConfig(name="sacrifice", repo="x/y", app_repo_path=str(repo))
    result = handle_docs_enforcer(s, app_config, temp_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.PR_OPEN
    assert result.payload["fix_pushed"] is False
    assert "stale info" in result.payload["fix_push_error"]
    assert s.error is not None
    assert "NOT pushed" in s.error and "186" in s.error

    from factory.chain.event_log import read_story_events

    assert s.id is not None
    events = [
        e["event"]
        for e in read_story_events(s.id, software_factory_root=temp_root, slug_hint=s.slug)
    ]
    assert "fix_push_failed" in events
