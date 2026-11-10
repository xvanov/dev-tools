"""Fence: the dev agent must not edit the files that judge it.

A dev that can rewrite ``apps/<app>/config.yaml`` (gate commands), the CI
workflow or a gate script can turn its own gates green without fixing
anything (proxy != real). Before the dev's work is committed, every fenced
path that differs from the base branch is put back to the base version (or
deleted when the base has none) and the story log gets a ``dev_fence_reverted``
event, so the reviewer and the merge gates only ever see the real change.

Not applied to the ``factory`` app itself: its self-edits are already
staging-gated (``factory/manager/forbidden_paths.py``) and it legitimately
edits these files. A change to a fenced file is an operator PR.
"""

from __future__ import annotations

import fnmatch
import subprocess
from pathlib import Path

#: Repo-relative globs (``/`` separators) the dev may not change.
FENCED_GLOBS: tuple[str, ...] = (
    "apps/*/config.yaml",
    "factory_settings.yaml",
    ".github/workflows/*",
    ".github/workflows/**/*",
    ".gitlab-ci.yml",
    ".circleci/*",
    ".factory/*",
    ".factory/**/*",
    "factory.yaml",
)
EXEMPT_APPS: frozenset[str] = frozenset({"factory"})


def is_fenced(path: str) -> bool:
    p = path.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return any(fnmatch.fnmatchcase(p, g) for g in FENCED_GLOBS)


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )


def changed_fenced_paths(repo: Path, base_ref: str) -> list[str]:
    """Fenced paths whose worktree content differs from ``base_ref`` (incl. untracked).

    ``-z`` keeps non-ASCII names unquoted; ``--no-renames`` lists the OLD path of a
    renamed fenced file (rename detection would show only the new, unfenced one)."""
    names: set[str] = set()
    diff = _git(repo, "diff", "--name-only", "--no-renames", "-z", base_ref, "--")
    if diff.returncode == 0:
        names.update(x for x in diff.stdout.split("\0") if x.strip())
    other = _git(repo, "ls-files", "-z", "--others", "--exclude-standard")
    if other.returncode == 0:
        names.update(x for x in other.stdout.split("\0") if x.strip())
    return sorted(n for n in names if is_fenced(n))


def revert_fenced(repo: Path, base_ref: str, paths: list[str]) -> list[str]:
    """Restore ``paths`` to ``base_ref``; return the ones actually reverted."""
    done: list[str] = []
    for path in paths:
        in_base = _git(repo, "cat-file", "-e", f"{base_ref}:{path}").returncode == 0
        if in_base:
            ok = _git(repo, "checkout", base_ref, "--", path).returncode == 0
        else:
            _git(repo, "rm", "-f", "--quiet", "--ignore-unmatch", "--", path)
            target = repo / path
            if target.exists():
                try:
                    target.unlink()
                except OSError:
                    continue
            ok = True
        if ok:
            done.append(path)
    return done


def enforce(repo: Path, base_ref: str, *, app: str, labels: list[str] | None = None) -> list[str]:
    """Revert fenced edits in ``repo``. Returns the reverted paths (empty = clean)."""
    if app in EXEMPT_APPS or "fence-ok" in (labels or []):
        return []
    return revert_fenced(repo, base_ref, changed_fenced_paths(repo, base_ref))
