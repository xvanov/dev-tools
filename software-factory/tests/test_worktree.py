"""Per-story git worktrees — the contention-free isolation primitive.

Each test instantiates a real git repo so the ``git worktree add/remove``
plumbing executes against actual git, not mocks. Mocked subprocess hides
bugs in how we shell out and how we recover from races.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from factory.chain.worktree import (
    ensure_worktree_for_story,
    prune_stale_worktrees,
    remove_worktree_for_story,
    worktree_path,
)


def _init_repo(path: Path) -> None:
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


def test_worktree_path_is_deterministic(tmp_path: Path) -> None:
    p = worktree_path(tmp_path, "sacrifice", 42, "d010-build-thing")
    assert p == tmp_path / "state" / "worktrees" / "sacrifice-42-d010-build-thing"


def test_worktree_path_sanitizes_slug(tmp_path: Path) -> None:
    p = worktree_path(tmp_path, "myapp", 7, "Has Spaces & punct!")
    assert "/" not in p.name
    assert " " not in p.name
    assert "&" not in p.name


def test_ensure_creates_worktree_and_checks_out_branch(tmp_path: Path) -> None:
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=42,
        slug="d010-tiny-slice",
    )

    assert wt.exists()
    assert (wt / "README.md").exists()
    assert _current_branch(wt) == "factory/story-42-d010-tiny-slice"
    # Source repo's checked-out branch is unaffected.
    assert _current_branch(src) == "main"


def test_ensure_is_idempotent_when_worktree_already_correct(tmp_path: Path) -> None:
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    wt1 = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=7,
        slug="x",
    )
    # Make a dirty change inside the worktree to confirm reuse doesn't reset it.
    (wt1 / "wip.txt").write_text("hi", encoding="utf-8")

    wt2 = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=7,
        slug="x",
    )
    assert wt2 == wt1
    assert (wt2 / "wip.txt").exists()


def test_two_stories_get_isolated_worktrees(tmp_path: Path) -> None:
    """The contention fix: stories A and B can run side-by-side without
    racing on a shared working tree."""
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    wt_a = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=10,
        slug="story-a",
    )
    wt_b = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=11,
        slug="story-b",
    )

    assert wt_a != wt_b
    # Each worktree has its own branch checked out.
    assert _current_branch(wt_a) == "factory/story-10-story-a"
    assert _current_branch(wt_b) == "factory/story-11-story-b"

    # Dirtying A's tree doesn't affect B's.
    (wt_a / "a-only.txt").write_text("hi", encoding="utf-8")
    assert not (wt_b / "a-only.txt").exists()
    # Source repo never gets dirtied by either side.
    src_status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(src),
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert src_status == ""


def test_remove_worktree(tmp_path: Path) -> None:
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=9,
        slug="kill-me",
    )
    assert wt.exists()
    # Add untracked + uncommitted state inside it; remove --force should not stall.
    (wt / "wip.txt").write_text("wip", encoding="utf-8")

    removed = remove_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=9,
        slug="kill-me",
    )
    assert removed is True
    assert not wt.exists()


def test_remove_is_idempotent_for_missing_worktree(tmp_path: Path) -> None:
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    removed = remove_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=404,
        slug="never-existed",
    )
    assert removed is False


def test_prune_removes_only_inactive_worktrees(tmp_path: Path) -> None:
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    for sid, slug in [(1, "alpha"), (2, "beta"), (3, "gamma")]:
        ensure_worktree_for_story(
            src,
            software_factory_root=factory_root,
            app="sacrifice",
            story_id=sid,
            slug=slug,
        )

    removed = prune_stale_worktrees(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        active_story_ids={2},  # only #2 still active
    )
    assert len(removed) == 2
    assert not worktree_path(factory_root, "sacrifice", 1, "alpha").exists()
    assert worktree_path(factory_root, "sacrifice", 2, "beta").exists()
    assert not worktree_path(factory_root, "sacrifice", 3, "gamma").exists()


def test_prune_skips_other_apps(tmp_path: Path) -> None:
    """Multi-app safety: prune for app=foo must not delete app=bar's worktrees."""
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    # Create worktrees for two apps with distinct branches (real-world: every
    # story gets its own sid+slug so branches never collide across apps).
    ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="foo",
        story_id=1,
        slug="alpha",
    )
    bar_wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="bar",
        story_id=2,
        slug="beta",
    )

    prune_stale_worktrees(
        src,
        software_factory_root=factory_root,
        app="foo",
        active_story_ids=set(),  # remove all foo worktrees
    )
    # bar's worktree must remain untouched.
    assert bar_wt.exists()


def test_ensure_replicates_dotenv_into_worktree(tmp_path: Path) -> None:
    """Untracked runtime files (``.env``, ``.env.local``, etc.) must be
    present in the worktree or pytest in the worktree fails at conftest
    import — pydantic-settings looks up ``.env`` relative to the working
    directory and the worktree doesn't get it from git."""
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)
    # Operator's .env lives at the source-repo root and is gitignored.
    (src / ".env").write_text("DATABASE_URL=postgres://x\n", encoding="utf-8")
    (src / ".gitignore").write_text(".env\n", encoding="utf-8")  # not committed

    wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=42,
        slug="dotenv-required",
    )

    wt_env = wt / ".env"
    assert wt_env.exists()
    # Either symlink or copy — content must match the source.
    assert "DATABASE_URL=postgres://x" in wt_env.read_text(encoding="utf-8")


def test_ensure_skips_replication_when_source_has_no_env(tmp_path: Path) -> None:
    """Apps that don't use ``.env`` shouldn't gain mysterious empty files."""
    src = tmp_path / "src"
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    _init_repo(src)

    wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="sacrifice",
        story_id=1,
        slug="no-env",
    )
    assert not (wt / ".env").exists()


def test_ensure_rejects_non_git_directory(tmp_path: Path) -> None:
    not_a_repo = tmp_path / "not-a-repo"
    not_a_repo.mkdir()
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    with pytest.raises(RuntimeError, match="not a git repository"):
        ensure_worktree_for_story(
            not_a_repo,
            software_factory_root=factory_root,
            app="sacrifice",
            story_id=1,
            slug="x",
        )
