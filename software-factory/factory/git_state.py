"""Pure read-only git-state inspection for the factory repo.

Returns short commit SHA, branch name, and dirty flag by shelling out to
``git``. No writes, no network — only local metadata reads.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class GitState:
    """Immutable snapshot of local git state for a repo.

    *dirty* is a convenience boolean — True when any of *staged*,
    *unstaged*, or *untracked* is non-zero.
    """

    sha: str
    branch: str
    dirty: bool
    staged: int = 0
    unstaged: int = 0
    untracked: int = 0


def get_git_state(repo_root: str | Path) -> GitState:
    """Return the current git SHA, branch, and dirty flag for *repo_root*.

    All git invocations are read-only and local-only — no fetches, pushes,
    or network access.
    """
    root = Path(repo_root)

    sha = _git(root, "rev-parse", "--short", "HEAD").strip()
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").strip()
    porcelain = _git(root, "status", "--porcelain")

    staged = 0
    unstaged = 0
    untracked = 0
    for line in porcelain.splitlines():
        if not line:
            continue
        xy = line[:2]
        # Index status (staged): X column; working-tree status (unstaged): Y column
        x = xy[0]
        y = xy[1]

        if x == "?":
            untracked += 1
        elif x != " " and y == " ":
            staged += 1
        elif x != " " or y != " ":
            # Either both staged+unstaged, or unstaged only
            if x != " ":
                staged += 1
            if y != " ":
                unstaged += 1

    dirty = (staged + unstaged + untracked) > 0

    return GitState(
        sha=sha,
        branch=branch,
        dirty=dirty,
        staged=staged,
        unstaged=unstaged,
        untracked=untracked,
    )


def _git(repo_root: Path, *args: str) -> str:
    """Run a read-only git command in *repo_root* and return stdout decoded."""
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=10,
    )
    result.check_returncode()
    return result.stdout
