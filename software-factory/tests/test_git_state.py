"""Tests for ``factory.git_state.get_git_state()`` helper.

Uses temporary git repos to validate SHA, branch, and dirty-state
reporting against controlled git states. No CLI involved.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def _init_temp_repo(tmp_path: Path) -> Path:
    """Create a temp git repo with an initial commit, return the repo root."""
    repo = tmp_path / "test_repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@factory.local")
    _git(repo, "config", "user.name", "Test Factory")
    (repo / "README.md").write_text("# Test Repo\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "initial commit")
    return repo


def _git(repo: Path, *args: str) -> str:
    """Run a git command in *repo* and return stdout."""
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=10,
    )
    result.check_returncode()
    return result.stdout


# ---------------------------------------------------------------------------
# Core git-state validation (AC4.1–4.3)
# ---------------------------------------------------------------------------


class TestGetGitState:
    """AC4.1–4.3: validate helper against controlled git states."""

    def test_sha_matches_repo_state(self, tmp_path: Path) -> None:
        """AC4.1: reported SHA matches the actual HEAD commit."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        expected_sha = _git(repo, "rev-parse", "--short", "HEAD").strip()

        state = get_git_state(repo)
        assert state.sha == expected_sha

    def test_branch_matches_repo_state(self, tmp_path: Path) -> None:
        """AC4.2: reported branch matches the actual HEAD branch."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        expected_branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip()

        state = get_git_state(repo)
        assert state.branch == expected_branch

    def test_clean_repo_not_dirty(self, tmp_path: Path) -> None:
        """AC4.3: dirty is False and all counts are zero on clean repo."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        state = get_git_state(repo)

        assert state.dirty is False
        assert state.staged == 0
        assert state.unstaged == 0
        assert state.untracked == 0

    def test_dirty_true_after_uncommitted_change(self, tmp_path: Path) -> None:
        """AC4.3: dirty=True and unstaged=1 after modifying a tracked file."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        (repo / "README.md").write_text("# Modified\n", encoding="utf-8")

        state = get_git_state(repo)
        assert state.dirty is True
        assert state.unstaged == 1
        assert state.staged == 0
        assert state.untracked == 0

    def test_dirty_true_after_staged_change(self, tmp_path: Path) -> None:
        """AC4.3: dirty=True and staged=1 after staging a new file."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
        _git(repo, "add", "staged.txt")

        state = get_git_state(repo)
        assert state.dirty is True
        assert state.staged == 1
        assert state.unstaged == 0
        assert state.untracked == 0

    def test_dirty_true_after_untracked_file(self, tmp_path: Path) -> None:
        """AC4.3: dirty=True and untracked=1 after creating an untracked file."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        (repo / "untracked.txt").write_text("hello\n", encoding="utf-8")

        state = get_git_state(repo)
        assert state.dirty is True
        assert state.untracked == 1
        assert state.staged == 0
        assert state.unstaged == 0

    def test_mixed_dirty_state_counts(self, tmp_path: Path) -> None:
        """Dirty counts are correct with mixed staged/unstaged/untracked changes."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)

        # unstaged modification to tracked file
        (repo / "README.md").write_text("# Modified\n", encoding="utf-8")
        # staged new file
        (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
        _git(repo, "add", "staged.txt")
        # untracked file
        (repo / "untracked.txt").write_text("hello\n", encoding="utf-8")

        state = get_git_state(repo)
        assert state.dirty is True
        assert state.unstaged == 1
        assert state.staged == 1
        assert state.untracked == 1


# ---------------------------------------------------------------------------
# Read-only guarantee (AC3.1)
# ---------------------------------------------------------------------------


class TestReadOnly:
    """AC3.1: helper performs no writes or mutations."""

    def test_read_only_no_mutations(self, tmp_path: Path) -> None:
        """Repeated calls do not mutate the repo."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        sha_before = _git(repo, "rev-parse", "HEAD").strip()
        porcelain_before = _git(repo, "status", "--porcelain")

        get_git_state(repo)
        get_git_state(repo)

        sha_after = _git(repo, "rev-parse", "HEAD").strip()
        porcelain_after = _git(repo, "status", "--porcelain")

        assert sha_before == sha_after
        assert porcelain_before == porcelain_after
