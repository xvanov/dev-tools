"""Per-story feature-branch management for the target app repo.

Before any sandbox-touching handler (test_implementer / dev / onboarder)
runs, the chain switches the target app repo to a per-story feature branch
so dev/test commits never land on ``main`` directly. This module owns the
``factory/story-<id>-<slug>`` branch name convention and the idempotent
create-or-checkout logic.

Why this exists at all
----------------------
Phase-8 sandbox runs use ``OpenHands SDK`` to drive the dev/test_implementer
personas inside a real git working tree. The agent's tool calls invoke
``git add``/``git commit`` against whatever branch is currently checked out
— and before this module, that was ``main``. The first bootstrap-context
run produced one local commit on the dogfood app's ``main`` (kept local
only; never pushed) — visible evidence of the bug.

Idempotency contract
--------------------
``ensure_feature_branch`` may be called multiple times across a story's
lifetime (test_implementer, then dev, then dev-retry, then reviewer). Each
call MUST be a no-op when the right branch is already checked out and at
the right tip; otherwise it switches to it. A non-clean working tree is a
fatal error — we never silently stash or discard the operator's edits.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

_BRANCH_PREFIX = "factory/story"


def feature_branch_name(story_id: int | None, slug: str) -> str:
    """Compose the per-story branch name from ``(story_id, slug)``.

    ``story_id`` is the GitHub issue number when the chain runs in real
    mode; in dry-run it can be 0 / None — we accept None and substitute 0
    so dry-run tests get a deterministic name.
    """
    sid = int(story_id) if story_id is not None else 0
    # Replace runs of non-safe chars with a single ``-``, then trim leading
    # / trailing hyphens so multi-char trailing punctuation (e.g. ``!!!``)
    # doesn't leave a dangling ``-`` on the branch name.
    safe_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", slug).strip("-")[:80] or "story"
    return f"{_BRANCH_PREFIX}-{sid}-{safe_slug}"


def _run_git(repo_path: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run ``git <args>`` in ``repo_path``. Surface stderr on failure."""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo_path),
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed in {repo_path}: "
            f"rc={proc.returncode} stderr={proc.stderr.strip()[:300]}"
        )
    return proc


def _is_clean_working_tree(repo_path: Path) -> bool:
    """True iff ``git status --porcelain`` is empty.

    A dirty tree is a fatal signal — the operator has uncommitted edits we
    must not clobber. The chain surfaces this as an error rather than
    silently stashing.
    """
    proc = _run_git(repo_path, "status", "--porcelain")
    return proc.stdout.strip() == ""


def _current_branch(repo_path: Path) -> str:
    """Return the currently-checked-out branch name (``HEAD`` if detached)."""
    proc = _run_git(repo_path, "rev-parse", "--abbrev-ref", "HEAD")
    return proc.stdout.strip()


def _branch_exists(repo_path: Path, branch: str) -> bool:
    """True iff ``branch`` exists locally."""
    proc = _run_git(
        repo_path, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False
    )
    return proc.returncode == 0


def _has_remote(repo_path: Path, remote: str = "origin") -> bool:
    """True iff ``remote`` is configured for ``repo_path``."""
    proc = _run_git(repo_path, "remote", check=False)
    return remote in proc.stdout.split()


def ensure_feature_branch(
    repo_path: Path,
    *,
    story_id: int | None,
    slug: str,
    base_branch: str = "main",
    stash_dirty: bool = False,
) -> str:
    """Idempotently put ``repo_path`` on the per-story feature branch.

    Behavior:
      * Returns the branch name immediately if ``repo_path`` is already on it.
      * Otherwise refuses to act if the working tree is dirty — the operator
        must commit / discard their edits first. Silently stashing here would
        eat work; raising is the kinder failure mode.
      * Pass ``stash_dirty=True`` to override that default: dirty changes get
        stashed under a labeled entry (``factory: leftover for story-<id>-<slug>``)
        before the checkout. The chain uses this when handing the working
        tree off between stories — sandbox crashes / dev-exhausted runs can
        leave uncommitted noise behind, and stashing keeps the work
        recoverable while unblocking the next handler.
      * Checks out the branch if it already exists locally; creates from
        the remote ``origin/<base_branch>`` when ``origin`` is configured
        (so a divergent local ``base_branch`` doesn't leak unrelated WIP
        commits into the PR); falls back to local ``base_branch`` otherwise.

    ``story_id`` is the GitHub issue number when in real-run; 0 / None for
    dry-run. ``base_branch`` is the app's default branch from ``config.yaml``;
    defaults to ``main`` for hosts that follow GitHub's convention.

    Raises ``RuntimeError`` on any git command failure or a dirty tree
    (when ``stash_dirty`` is False).
    """
    repo = Path(repo_path)
    if not (repo / ".git").exists():
        raise RuntimeError(f"{repo} is not a git repository (no .git/ found)")

    branch = feature_branch_name(story_id, slug)

    if _current_branch(repo) == branch:
        # Already on the right branch — nothing to do.
        return branch

    if not _is_clean_working_tree(repo):
        if stash_dirty:
            stash_label = f"factory: leftover for story-{story_id or 0}-{slug}"
            _run_git(repo, "stash", "push", "--include-untracked", "-m", stash_label)
        else:
            raise RuntimeError(
                f"Refusing to switch branches in {repo}: working tree is dirty. "
                f"Commit or discard the changes first."
            )

    if _branch_exists(repo, branch):
        _run_git(repo, "checkout", branch)
    else:
        # Prefer ``origin/<base_branch>`` as the source of truth: that's what
        # the GitHub PR will be diffed against. A divergent local
        # ``base_branch`` (e.g. operator WIP not yet pushed) would otherwise
        # bleed unrelated commits into every feature branch we create.
        if _has_remote(repo):
            # Best-effort fetch; if it fails (offline, auth), fall through
            # to the local base. Short timeout so chains don't hang.
            _run_git(repo, "fetch", "origin", base_branch, check=False)
            remote_ref = f"origin/{base_branch}"
            ref_check = _run_git(repo, "rev-parse", "--verify", "--quiet", remote_ref, check=False)
            base_ref = remote_ref if ref_check.returncode == 0 else base_branch
        else:
            base_ref = base_branch
        # ``git checkout -b X <base_ref>`` creates the new branch at
        # ``<base_ref>``'s tip and switches to it atomically.
        _run_git(repo, "checkout", "-b", branch, base_ref)

    return branch


# --------------------------------------------------------------------------- #
# Diff inspection — for the "dev must not modify tests" enforcement.
# --------------------------------------------------------------------------- #

# Glob-style patterns for files that the Dev persona is forbidden from
# touching. Test-Implementer writes these; once they're committed they are
# frozen for the dev run. If dev believes a test is wrong, the persona
# prompt requires writing a ``TESTS_NEED_CLARIFICATION:`` summary instead
# of weakening / deleting / editing the test.
_TEST_FILE_PATTERNS = (
    re.compile(r"(^|/)tests/"),
    re.compile(r"(^|/)test_[^/]+\.py$"),
    re.compile(r"(^|/)[^/]+_test\.py$"),
    re.compile(r"(^|/)[^/]+\.test\.tsx?$"),
    re.compile(r"(^|/)[^/]+\.spec\.tsx?$"),
)


def is_test_file(path: str) -> bool:
    """True iff ``path`` looks like a test file under the documented patterns.

    Patterns covered:
      * Anything under a ``tests/`` directory at any depth.
      * Python: ``test_*.py`` and ``*_test.py``.
      * TypeScript: ``*.test.ts``, ``*.test.tsx``, ``*.spec.ts``, ``*.spec.tsx``.

    The matcher uses re patterns rooted at path-separator boundaries so a
    file named ``foo/bar/test_x.py`` matches but ``foo/test_helpers/x.py``
    (a helper module that happens to start with ``test_``) inside a
    non-tests directory still matches (we err on the side of guarding).
    """
    norm = path.replace("\\", "/")
    return any(p.search(norm) for p in _TEST_FILE_PATTERNS)


def find_test_files_in_diff(repo_path: Path, *, base_ref: str, head_ref: str = "HEAD") -> list[str]:
    """Return paths of test files touched between ``base_ref`` and ``head_ref``.

    Empty result means "no test files were modified" — the desired outcome
    for a Dev run. A non-empty result is the signal the chain uses to abort
    a Dev pass with ``BLOCKED_TESTS_NEED_CLARIFICATION``.

    Implementation: ``git diff --name-only base..head`` then filter via
    ``is_test_file``. Each path is normalized to forward slashes.

    Note: NOT named ``test_files_in_diff`` because pytest auto-discovery
    would pick up the ``test_`` prefix and try to execute the helper as a
    test (failing on the ``repo_path`` fixture lookup).
    """
    proc = _run_git(repo_path, "diff", "--name-only", f"{base_ref}..{head_ref}")
    paths = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    return [p for p in paths if is_test_file(p)]
