"""Shared helper: a real git checkout for the acceptance-oracle tests.

The ``acceptance-verified`` gate grades the merge candidate in a throwaway git
worktree whose collection channels come from the MERGE BASE, and it credits a
green at HEAD only when the same oracle was RED at that base (PLAN A.6). None of
that is expressible against a bare directory, so every gate test needs a repo
with a base commit and a story branch. This builds one.

Not named ``test_*`` and not a conftest, so pytest neither collects nor
auto-imports it; the acceptance test modules import it explicitly.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(  # noqa: S603,S607 - fixed argv, no shell
        ["git", *args], cwd=str(repo), capture_output=True, text=True, check=True
    )
    return proc.stdout.strip()


def init_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "t@t")
    git(repo, "config", "user.name", "t")


def commit_all(repo: Path, message: str) -> str:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def two_commit_repo(
    repo: Path,
    *,
    base: dict[str, str],
    head: dict[str, str],
) -> tuple[str, str]:
    """``main`` at ``base``, a story branch checked out at ``base`` + ``head``.

    Returns ``(base_sha, head_sha)``. Paths are repo-relative; parents are created.
    """
    init_repo(repo)
    _write(repo, base)
    base_sha = commit_all(repo, "base")
    git(repo, "checkout", "-q", "-b", "feat/story")
    _write(repo, head)
    return base_sha, commit_all(repo, "story work")


def _write(repo: Path, files: dict[str, str]) -> None:
    for rel, body in files.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
