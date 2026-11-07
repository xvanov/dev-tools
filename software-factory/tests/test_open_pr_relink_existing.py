"""_open_pr_for_story must RELINK an existing PR when `gh pr create` reports
"already exists" (e.g. a story re-reached PR_OPEN after a CI-fix/review
re-dispatch). Otherwise github_pr_number stays None and the auto-merge / CI-fix
machinery can never act on the orphaned PR — the story sits forever.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from factory.app_config import AppConfig
from factory.chain import handlers
from factory.chain.state_machine import StoryRecord


def _story() -> StoryRecord:
    return StoryRecord(
        id=1, direction_id="089", app="sacrifice", title="t",
        slug="add-ci", scope="infra", state="pr_open",
        github_issue_number=250, chain_kind="tdd",
        github_branch="factory/story-250-add-ci",
    )


def test_open_pr_relinks_existing_pr(monkeypatch, tmp_path: Path) -> None:
    cfg = AppConfig(name="sacrifice", repo="xvanov/sacrifice", default_branch="main")
    # Avoid real worktree/git: point the writing worktree at a tmp dir.
    monkeypatch.setattr(handlers, "_writing_worktree", lambda *a, **k: tmp_path)

    def fake_run(cmd, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if "pr" in cmd and "create" in cmd:
            # gh pr create fails because a PR already exists for the branch.
            raise subprocess.CalledProcessError(
                1, cmd,
                stderr='a pull request for branch "factory/story-250-add-ci" into '
                'branch "main" already exists:\nhttps://github.com/xvanov/sacrifice/pull/253',
            )
        if "pr" in cmd and "view" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="253\n", stderr="")
        # git fetch/merge/push and anything else: succeed silently.
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = handlers._open_pr_for_story(_story(), cfg, tmp_path)
    assert result == 253, f"expected relink to existing PR 253, got {result!r}"


def test_open_pr_returns_none_on_other_create_failure(monkeypatch, tmp_path: Path) -> None:
    """A create failure that is NOT 'already exists' still returns None (no
    spurious relink lookup masking a real failure)."""
    cfg = AppConfig(name="sacrifice", repo="xvanov/sacrifice", default_branch="main")
    monkeypatch.setattr(handlers, "_writing_worktree", lambda *a, **k: tmp_path)

    def fake_run(cmd, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if "pr" in cmd and "create" in cmd:
            raise subprocess.CalledProcessError(1, cmd, stderr="fatal: some other error")
        if "pr" in cmd and "view" in cmd:
            raise AssertionError("must not look up an existing PR on a non-'already exists' failure")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert handlers._open_pr_for_story(_story(), cfg, tmp_path) is None
