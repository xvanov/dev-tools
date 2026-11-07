"""Per-story feature-branch helper (``factory.chain.branch``).

Every test instantiates a real git repo in ``tmp_path`` so the
``subprocess.run(['git', ...])`` calls execute against actual git, not
mocks. Mocked subprocess hides bugs in how we shell-quote / fail-fast.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from factory.chain.branch import (
    ensure_feature_branch,
    feature_branch_name,
    find_test_files_in_diff,
    is_test_file,
)

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _init_repo(path: Path) -> None:
    """Create a fresh git repo at ``path`` with one commit on ``main``."""
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.name", "T E"], cwd=str(path), check=True)
    (path / "README.md").write_text("# test\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(path), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(path), check=True)


def _current_branch(path: Path) -> str:
    proc = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=str(path),
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip()


# --------------------------------------------------------------------------- #
# feature_branch_name
# --------------------------------------------------------------------------- #


def test_feature_branch_name_uses_factory_prefix() -> None:
    """Branch name must start with ``factory/story-`` so origin-side hooks
    and the operator can pattern-match on it."""
    assert feature_branch_name(42, "fix-login").startswith("factory/story-42-")


def test_feature_branch_name_sanitizes_slug() -> None:
    """Spaces, slashes, and weird chars become ``-`` so the result is a
    valid git ref."""
    name = feature_branch_name(7, "Bootstrap Sacrifice: ctx/files!!!")
    assert name == "factory/story-7-Bootstrap-Sacrifice-ctx-files"
    # Must not contain any of the now-forbidden characters.
    for bad in (" ", "/", "!", ":"):
        assert bad not in name.split("factory/story-7-")[1]


def test_feature_branch_name_handles_missing_story_id() -> None:
    """A None story id (dry-run path) becomes 0 — deterministic."""
    assert feature_branch_name(None, "x") == "factory/story-0-x"


# --------------------------------------------------------------------------- #
# ensure_feature_branch — happy path + idempotency
# --------------------------------------------------------------------------- #


def test_ensure_creates_branch_from_main(tmp_path: Path) -> None:
    """Calling on a fresh main checks out a new branch sharing the same tip."""
    repo = tmp_path / "r"
    _init_repo(repo)
    assert _current_branch(repo) == "main"

    branch = ensure_feature_branch(repo, story_id=11, slug="hello")
    assert branch == "factory/story-11-hello"
    assert _current_branch(repo) == branch


def test_ensure_is_idempotent_when_already_on_branch(tmp_path: Path) -> None:
    """A second call after the first does NOT re-run ``git checkout`` (would
    be a no-op anyway, but we guard the dirty-tree precondition)."""
    repo = tmp_path / "r"
    _init_repo(repo)
    ensure_feature_branch(repo, story_id=1, slug="a")

    # Dirty the tree — second call should still succeed BECAUSE we're already
    # on the right branch (the dirty-tree guard only triggers when a switch
    # would be needed).
    (repo / "scratch.txt").write_text("dirty", encoding="utf-8")
    branch = ensure_feature_branch(repo, story_id=1, slug="a")
    assert branch == "factory/story-1-a"


def test_ensure_checks_out_existing_branch(tmp_path: Path) -> None:
    """If the branch already exists locally, we ``checkout`` it instead of
    re-creating (which would error)."""
    repo = tmp_path / "r"
    _init_repo(repo)

    # First story creates the branch + advances it.
    ensure_feature_branch(repo, story_id=2, slug="b")
    (repo / "feat.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "feat"], cwd=str(repo), check=True)

    # Switch to main, then ask the helper to put us back on story-2-b.
    subprocess.run(["git", "checkout", "-q", "main"], cwd=str(repo), check=True)
    assert _current_branch(repo) == "main"

    branch = ensure_feature_branch(repo, story_id=2, slug="b")
    assert branch == "factory/story-2-b"
    assert _current_branch(repo) == branch
    # Branch tip must include the feat commit — i.e. we checked out the
    # existing branch, did not recreate it from main.
    proc = subprocess.run(
        ["git", "log", "--oneline"], cwd=str(repo), check=True, capture_output=True, text=True
    )
    assert "feat" in proc.stdout


# --------------------------------------------------------------------------- #
# ensure_feature_branch — guard rails
# --------------------------------------------------------------------------- #


def test_ensure_refuses_dirty_tree(tmp_path: Path) -> None:
    """Untracked + modified files block the switch — silent stashing would
    eat the operator's edits."""
    repo = tmp_path / "r"
    _init_repo(repo)
    (repo / "dirty.txt").write_text("u", encoding="utf-8")

    with pytest.raises(RuntimeError, match="dirty"):
        ensure_feature_branch(repo, story_id=3, slug="c")


def test_ensure_stashes_dirty_tree_when_opted_in(tmp_path: Path) -> None:
    """``stash_dirty=True`` lets the chain hand the tree over between stories
    after a sandbox left uncommitted noise. The stash entry must be labeled
    so the operator can recover it."""
    repo = tmp_path / "r"
    _init_repo(repo)
    (repo / "leftover.txt").write_text("from previous sandbox", encoding="utf-8")
    subprocess.run(["git", "add", "leftover.txt"], cwd=str(repo), check=True)
    (repo / "untracked.txt").write_text("from previous sandbox", encoding="utf-8")

    branch = ensure_feature_branch(repo, story_id=7, slug="next", stash_dirty=True)
    assert branch == "factory/story-7-next"
    assert _current_branch(repo) == branch

    # Working tree is now clean.
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert status == ""

    # Stash entry exists with the expected label.
    stash_list = subprocess.run(
        ["git", "stash", "list"],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert "factory: leftover for story-7-next" in stash_list


def test_ensure_rejects_non_git_directory(tmp_path: Path) -> None:
    """A bare directory (no .git) is a clear configuration error."""
    repo = tmp_path / "not-a-repo"
    repo.mkdir()
    with pytest.raises(RuntimeError, match="not a git repository"):
        ensure_feature_branch(repo, story_id=1, slug="x")


def test_ensure_uses_app_default_branch_as_base(tmp_path: Path) -> None:
    """If the app config declares ``default_branch: develop``, we create from
    that ref, not from ``main``."""
    repo = tmp_path / "r"
    _init_repo(repo)
    # Rename main → develop to simulate an alt-default-branch project.
    subprocess.run(["git", "branch", "-m", "main", "develop"], cwd=str(repo), check=True)

    branch = ensure_feature_branch(repo, story_id=9, slug="zzz", base_branch="develop")
    assert branch == "factory/story-9-zzz"
    # Parent of the new branch is the develop tip.
    proc = subprocess.run(
        ["git", "rev-list", "--max-count=1", "develop"],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    )
    develop_tip = proc.stdout.strip()
    proc = subprocess.run(
        ["git", "rev-list", "--max-count=1", branch],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    )
    assert proc.stdout.strip() == develop_tip


# --------------------------------------------------------------------------- #
# is_test_file / test_files_in_diff — for Fix 2 enforcement
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_x.py",
        "backend/tests/test_canonical_context.py",
        "src/foo/test_helpers.py",  # bare test_*.py counts
        "lib/auth_test.py",
        "frontend/components/Button.test.tsx",
        "frontend/components/Button.spec.ts",
        "frontend/components/Button.test.ts",
        "frontend/components/Button.spec.tsx",
    ],
)
def test_is_test_file_matches_known_patterns(path: str) -> None:
    assert is_test_file(path) is True, path


@pytest.mark.parametrize(
    "path",
    [
        "src/app.py",
        "frontend/components/Button.tsx",
        "context/project.md",
        "README.md",
        "src/testing_helpers.py",  # no `test_` prefix on basename
    ],
)
def test_is_test_file_rejects_non_test_paths(path: str) -> None:
    assert is_test_file(path) is False, path


def test_find_test_files_in_diff_returns_only_test_paths(tmp_path: Path) -> None:
    """``git diff base..head`` filtered through ``is_test_file``."""
    repo = tmp_path / "r"
    _init_repo(repo)
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    # Add: one test file + one code file. Only the test path should surface.
    (repo / "src").mkdir()
    (repo / "src" / "app.py").write_text("# code\n", encoding="utf-8")
    (repo / "tests").mkdir()
    (repo / "tests" / "test_app.py").write_text("# tests\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "add"], cwd=str(repo), check=True)

    touched = find_test_files_in_diff(repo, base_ref=base_sha)
    assert touched == ["tests/test_app.py"]


def test_find_test_files_in_diff_empty_when_only_code_touched(tmp_path: Path) -> None:
    """No test paths → empty list — the Dev happy path."""
    repo = tmp_path / "r"
    _init_repo(repo)
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    (repo / "code.py").write_text("# only code\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "code"], cwd=str(repo), check=True)

    assert find_test_files_in_diff(repo, base_ref=base_sha) == []
