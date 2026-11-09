"""Per-story git worktrees — the contention fix for parallel chain runs.

Background
==========

The orchestrator was previously serialised to ``per_repo_concurrent_agents=1``
because every sandbox handler ran against a single shared
``app_repo_path`` working tree. Two stories alive at the same time would
race on ``ensure_feature_branch`` — one's mid-sandbox dirty tree blocking
the other's checkout. We stashed the dirty tree as a stopgap; this module
removes the need to share a tree at all.

Mental model
============

For every in-flight story we keep a private working tree under::

    <software_factory_root>/state/worktrees/<app>-<story_id>-<slug>/

backed by the same ``.git`` directory as the operator's main checkout
(``app_repo_path``). Linked worktrees are a built-in ``git worktree``
feature: they share refs, the index is per-worktree, and the working
tree on disk is isolated. Adding/removing is cheap (no clone) and
``git fetch``/``git push`` work normally because they operate on refs.

Lifecycle
=========

* ``ensure_worktree_for_story`` — idempotent: if the worktree path
  already exists and points at the right branch, returns the path
  unchanged. Otherwise creates it off ``origin/<base_branch>`` (or
  local ``<base_branch>`` if no remote) and checks out the per-story
  feature branch. Stashes any dirty operator state in the source repo
  the same way the stopgap did, because ``git worktree add`` on top of
  an in-use branch needs an unobstructed source.

* ``remove_worktree_for_story`` — called by the orchestrator when a
  story reaches a terminal state (DEPLOYED, BLOCKED_*). Tolerant of a
  missing path; the goal is to leave nothing behind.

* ``prune_stale_worktrees`` — invoked at tick start. Removes worktree
  directories whose ``StoryRecord`` is terminal-and-old OR whose
  branch no longer exists. Keeps disk usage bounded across long runs.

Concurrency
===========

Each worktree has its own HEAD and index, so N stories can each have
their own sandbox running against their own tree without contention.
``git worktree add`` itself takes a brief lock on the source repo's
``.git/index.lock``; that's serialised at the git level. Same for
``remove``. The chain handlers can otherwise operate in parallel.

Safety notes
============

* We never delete the source ``app_repo_path`` — that's the operator's
  workspace.
* ``git worktree remove --force`` discards uncommitted changes inside
  the linked worktree, which is exactly what we want for terminal
  cleanup (the work is either merged via PR or stranded; the chain
  separately commits + pushes terminal stories before cleanup).
* The worktree directory name embeds story id + slug so post-hoc
  inspection (``ls state/worktrees/``) is human-readable.
"""

from __future__ import annotations

import logging
import re
import shutil
import time
from pathlib import Path

from factory.chain.branch import (
    _has_remote,
    _run_git,
    feature_branch_name,
)
from factory.state_dir import state_dir

_logger = logging.getLogger(__name__)

#: ``git worktree add/remove/prune`` check out or delete a whole tree. The
#: default 30 s git timeout killed a dev-tools checkout mid-way on Windows (real-
#: time AV scanning, loaded machine) and failed the tick; a killed checkout also
#: leaves a half-made worktree for the next tick to clear.
WORKTREE_GIT_TIMEOUT_S = 600.0

#: dev-tools' deepest tracked file is 118 characters; under
#: %LOCALAPPDATA%\software-factory\state\worktrees\ a 60-character slug put
#: it past 260 and `git worktree add` failed with "Filename too long".
WORKTREE_SLUG_MAX = 24


def worktree_path(
    software_factory_root: Path,
    app: str,
    story_id: int | None,
    slug: str,
) -> Path:
    """Compute the deterministic worktree path for a story.

    Encoded as ``<state>/worktrees/<app>-<story_id>-<slug>/`` so
    ``ls state/worktrees/`` is operator-readable. Slug is sanitized to
    the same character set as the feature branch and cut to
    ``WORKTREE_SLUG_MAX``: app and story id already make the name unique,
    and every character of it is taken from the MAX_PATH budget of the
    checkout's deepest file on Windows.
    """
    sid = int(story_id) if story_id is not None else 0
    safe_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", slug)[:WORKTREE_SLUG_MAX].strip("-.") or "story"
    return state_dir(Path(software_factory_root)) / "worktrees" / f"{app}-{sid}-{safe_slug}"


def _sweep_acceptance_oracles(worktree: Path, *, story_id: int | None) -> None:
    """Remove any independent acceptance oracle left inside a REUSED worktree.

    The ``acceptance-verified`` gate copies the story's hidden oracle into this
    same tree to run it, and removes it again. If that process was killed in
    between, the copy is still there when the dev is dispatched into the reused
    worktree on a later tick — and the dev is supposed to be blind to it (it is
    also a file the chain's ``git add -A`` commit would publish into the PR).
    Sweeping on every ensure closes that window at the one choke point BOTH the
    dev handler and the merge gate go through. Best-effort; never raises.
    """
    try:
        from factory.chain.acceptance import sweep_leaked_oracles

        removed = sweep_leaked_oracles(worktree)
    except Exception:  # noqa: BLE001 - hygiene must never fail worktree creation
        return
    if removed:
        _logger.warning(
            "removed leaked acceptance oracle(s) from reused worktree %s (story=%s): %s",
            worktree,
            story_id,
            removed,
        )


def _worktree_slots(wt: Path) -> list[Path]:
    """The canonical path, then any ``<name>-alt-N`` siblings, then free names.

    A sibling exists when the canonical directory was held by a process and
    the checkout was created beside it. The next call must find that checkout
    instead of making another one.
    """
    existing = []
    if wt.parent.exists():
        existing = sorted(p for p in wt.parent.glob(wt.name + "-alt-*") if p.is_dir())
    slots = [wt, *existing]
    seen = set(slots)
    for n in range(2, 10):
        alt = wt.with_name(f"{wt.name}-alt-{n}")
        if alt not in seen:
            slots.append(alt)
    return slots


def _reuse_worktree(path: Path, branch: str, *, story_id: int | None) -> Path | None:
    """Return ``path`` when it is a readable checkout, switched to ``branch``."""
    if not (path.exists() and (path / ".git").exists()):
        return None
    head_proc = _run_git(path, "rev-parse", "--abbrev-ref", "HEAD", check=False)
    if head_proc.returncode != 0:
        # A ``.git`` that git cannot read: the worktree's admin entry was
        # pruned under it. The caller re-creates the checkout.
        return None
    _sweep_acceptance_oracles(path, story_id=story_id)
    if head_proc.stdout.strip() != branch:
        # ``git worktree repair`` is for path-link mismatches; ``checkout``
        # handles the branch flip inside the worktree.
        _run_git(path, "checkout", branch, check=False)
    return path


def _claim_worktree_dir(repo: Path, wt: Path) -> Path:
    """A directory ``git worktree add`` can create into.

    Tries the canonical path, then siblings. Raises only when every slot is
    held, which is the old failure (one held path, retried forever).
    """
    held: list[str] = []
    for cand in _worktree_slots(wt):
        if not cand.exists():
            return cand
        try:
            _clear_worktree_dir(repo, cand)
        except RuntimeError as exc:
            held.append(str(exc))
            _logger.warning("worktree path %s is held; trying a sibling", cand)
            continue
        return cand
    raise RuntimeError(
        f"every worktree path for {wt.name} is held by a live process: " + "; ".join(held)
    )


def ensure_worktree_for_story(
    source_repo: Path,
    *,
    software_factory_root: Path,
    app: str,
    story_id: int | None,
    slug: str,
    base_branch: str = "main",
    stack_on: str | None = None,
    branch: str | None = None,
) -> Path:
    """Idempotently produce a private worktree for ``story_id`` on its branch.

    ``branch`` (JOBS-API v1.3 pickup, ``factory/chain/pickup.py``): an EXISTING
    remote branch a human owns, used instead of the factory's own
    ``factory/story-<id>-<slug>``. When no local branch of that name exists it
    is created from ``origin/<branch>`` (fetched first), so the work continues
    on top of the human's commits; it is never cut from the base. A branch
    that exists neither locally nor on origin is an error (never invented).

    ``stack_on`` (delivery levels below ``auto_merge``, review 2026-11-02
    SHOULD 5): the branch of an earlier sibling story that was DELIVERED but
    never merged. A NEW story branch is cut from it instead of from the base,
    so the dependent builds on its sibling's work. Tried as a local branch
    first (level ``none`` never pushes), then ``origin/<stack_on>``; if neither
    resolves the base is used, as before. Has no effect on an existing branch.

    Returns the worktree path. The worktree is checked out on the
    per-story feature branch; that branch is created from
    ``origin/<base_branch>`` (or local ``base_branch`` if no remote) if
    it doesn't already exist locally.

    Handlers should call this in place of ``ensure_feature_branch`` when
    they want isolation from concurrent stories. They can still operate
    on the source repo directly if they need to (e.g. operator-facing
    tooling like ``factory inbox``).
    """
    repo = Path(source_repo)
    if not (repo / ".git").exists():
        raise RuntimeError(f"{repo} is not a git repository (no .git/ found)")

    wt = worktree_path(software_factory_root, app, story_id, slug)
    wt.parent.mkdir(parents=True, exist_ok=True)
    pickup = branch is not None
    branch = branch or feature_branch_name(story_id, slug)

    # Reuse a checkout that is already on this branch: the canonical path, or a
    # sibling made when that path was held (see _claim_worktree_dir).
    for cand in _worktree_slots(wt):
        reused = _reuse_worktree(cand, branch, story_id=story_id)
        if reused is not None:
            return reused

    # Anything else at the path (a killed attempt's half-deleted tree, a manual
    # cleanup's leftovers) must go, or ``git worktree add`` fails with
    # "already exists" on every tick. A directory a live terminal still has as
    # its working directory cannot be renamed on Windows; claim a sibling
    # instead of failing the story on every tick.
    wt = _claim_worktree_dir(repo, wt)

    # Ensure the source's tree isn't dirty in a way that blocks
    # ``git worktree add`` — same idea as ``ensure_feature_branch`` does
    # for switching branches, except we never need to leave the source on
    # the per-story branch. ``git worktree add`` works even when the
    # source is on ``main``, so the safer move is to NOT mutate the
    # source's checked-out branch at all.

    # Pick the base ref: prefer ``origin/<base_branch>`` so PRs diff
    # against the same shared tip; fall back to local ``<base_branch>``
    # if no remote.
    if _has_remote(repo):
        _run_git(repo, "fetch", "origin", base_branch, check=False)
        remote_ref = f"origin/{base_branch}"
        ref_check = _run_git(repo, "rev-parse", "--verify", "--quiet", remote_ref, check=False)
        base_ref = remote_ref if ref_check.returncode == 0 else base_branch
    else:
        base_ref = base_branch

    if pickup:
        # A picked-up branch continues from the human's own tip, never the base.
        _run_git(
            repo,
            "fetch",
            "origin",
            f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
            check=False,
        )
        remote_ok = _run_git(
            repo, "rev-parse", "--verify", "--quiet", f"origin/{branch}", check=False
        )
        if remote_ok.returncode == 0:
            base_ref = f"origin/{branch}"
        elif (
            _run_git(
                repo, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False
            ).returncode
            != 0
        ):
            raise RuntimeError(
                f"picked-up branch {branch!r} exists neither on origin nor locally in {repo}"
            )
    elif stack_on:
        local_ok = _run_git(
            repo, "show-ref", "--verify", "--quiet", f"refs/heads/{stack_on}", check=False
        )
        if local_ok.returncode == 0:
            base_ref = stack_on
        elif _has_remote(repo):
            _run_git(repo, "fetch", "origin", stack_on, check=False)
            remote_ok = _run_git(
                repo, "rev-parse", "--verify", "--quiet", f"origin/{stack_on}", check=False
            )
            if remote_ok.returncode == 0:
                base_ref = f"origin/{stack_on}"

    # If the branch already exists locally (e.g. a previous story's
    # worktree was removed but the branch wasn't), check it out;
    # otherwise create from ``base_ref``.
    branch_check = _run_git(
        repo, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False
    )
    # Drop registrations of worktrees whose directory is gone: git refuses to
    # check a branch out a second time while a stale entry still claims it.
    _run_git(repo, "worktree", "prune", check=False, timeout=WORKTREE_GIT_TIMEOUT_S)
    _wt_error: str | None = None
    try:
        if branch_check.returncode == 0:
            _run_git(repo, "worktree", "add", str(wt), branch, timeout=WORKTREE_GIT_TIMEOUT_S)
        else:
            try:
                _run_git(
                    repo, "worktree", "add", "-b", branch, str(wt), base_ref,
                    timeout=WORKTREE_GIT_TIMEOUT_S,
                )
            except RuntimeError as exc:
                # The probe said "no branch" but git says it exists (a probe
                # that failed for another reason): check the branch out instead.
                if "a branch named" not in str(exc):
                    raise
                _run_git(repo, "worktree", "add", str(wt), branch, timeout=WORKTREE_GIT_TIMEOUT_S)
    except Exception as _wt_exc:
        _wt_error = repr(_wt_exc)
        raise

    _replicate_uncommitted_runtime_files(repo, wt)

    # Emit git signal — best-effort, never raises.
    try:
        from factory.manager.signals import write_git_event

        write_git_event(
            kind="worktree_create",
            story_id=story_id,
            worktree_path=str(wt),
            result="ok" if _wt_error is None else "error",
            error=_wt_error,
            software_factory_root=software_factory_root,
        )
    except Exception:  # noqa: BLE001
        pass

    return wt


def _clear_worktree_dir(repo: Path, wt: Path) -> None:
    """Remove whatever is at ``wt`` so ``git worktree add`` can recreate it.

    On Windows a file still held open (a process the killed tick left behind,
    an editor, AV) makes both ``git worktree remove`` and ``rmtree`` stop part
    way, leaving a tree without its ``.git``. If it cannot be deleted it is
    renamed aside; if even that fails, the error says so instead of git's
    bare "already exists".
    """
    _run_git(repo, "worktree", "remove", "--force", str(wt), check=False, timeout=WORKTREE_GIT_TIMEOUT_S)
    if wt.exists():
        shutil.rmtree(wt, ignore_errors=True)
    _run_git(repo, "worktree", "prune", check=False, timeout=WORKTREE_GIT_TIMEOUT_S)
    if not wt.exists():
        return
    aside = wt.with_name(f"{wt.name}.stale-{time.time_ns()}")
    try:
        wt.rename(aside)
    except OSError as exc:
        raise RuntimeError(
            f"leftover worktree directory {wt} cannot be removed or renamed: "
            f"a process still holds files in it ({exc})"
        ) from exc
    _logger.warning("renamed undeletable leftover worktree %s to %s", wt, aside)


# Untracked-but-runtime-required files at the source repo root that the
# chain replicates into each per-story worktree so the dev/test gate
# matches the operator's local setup. Most apps gitignore ``.env`` (and
# variants) and rely on pydantic-settings or python-dotenv to pick them
# up — without these copied into the worktree, every ``pytest`` in the
# worktree fails at conftest import (e.g. ``create_async_engine`` with
# a missing ``DATABASE_URL``).
_RUNTIME_FILES_TO_REPLICATE = (
    ".env",
    ".env.local",
    ".env.test",
    ".env.local.test",
)


def _replicate_uncommitted_runtime_files(source_repo: Path, worktree: Path) -> None:
    """Copy gitignored runtime config files from ``source_repo`` into ``worktree``.

    These files are intentionally untracked (they hold secrets / per-host
    settings) so ``git worktree add`` doesn't carry them automatically.
    The chain treats them as part of the runtime environment dev needs
    to see, otherwise pytest can fail at conftest import and burn the
    entire dev retry budget on a config problem.

    Symlinks are preferred (cheap, kept in sync if the operator edits
    the source) but we fall back to copy on platforms / filesystems
    where symlink fails.
    """
    import shutil

    for name in _RUNTIME_FILES_TO_REPLICATE:
        src = source_repo / name
        if not src.exists():
            continue
        dst = worktree / name
        if dst.exists() or dst.is_symlink():
            continue  # respect anything the worktree-creator put there
        try:
            dst.symlink_to(src.resolve())
        except OSError:
            try:
                shutil.copy2(src, dst)
            except OSError:
                # Last-resort — don't fail worktree creation over a config
                # file. Tests that need this will surface the issue.
                pass


def remove_worktree_for_story(
    source_repo: Path,
    *,
    software_factory_root: Path,
    app: str,
    story_id: int | None,
    slug: str,
) -> bool:
    """Remove the per-story worktree if present. Returns True if removed."""
    wt = worktree_path(software_factory_root, app, story_id, slug)
    slots = [p for p in _worktree_slots(wt) if p.exists()]
    if not slots:
        return False
    repo = Path(source_repo)
    for slot in slots:
        if (repo / ".git").exists():
            _run_git(repo, "worktree", "remove", "--force", str(slot), check=False, timeout=WORKTREE_GIT_TIMEOUT_S)
        # Some git versions / older Linux filesystems leave the dir behind
        # after ``worktree remove``; rm what's left so a re-create succeeds.
        if slot.exists():
            shutil.rmtree(slot, ignore_errors=True)
    # ``git worktree prune`` cleans the parent's internal worktree registry
    # so future ``add``s don't see the removed entry.
    if (repo / ".git").exists():
        _run_git(repo, "worktree", "prune", check=False, timeout=WORKTREE_GIT_TIMEOUT_S)

    # Emit git signal — best-effort, never raises.
    try:
        from factory.manager.signals import write_git_event

        write_git_event(
            kind="worktree_destroy",
            story_id=story_id,
            worktree_path=str(wt),
            result="ok",
            software_factory_root=software_factory_root,
        )
    except Exception:  # noqa: BLE001
        pass

    return True


def prune_stale_worktrees(
    source_repo: Path,
    *,
    software_factory_root: Path,
    app: str,
    active_story_ids: set[int],
) -> list[Path]:
    """Remove worktree dirs whose StoryRecord is no longer active.

    ``active_story_ids`` holds the ids the worktrees are NAMED by (the
    ``story_id`` given to :func:`ensure_worktree_for_story`: the GitHub issue
    number, 0 without one), not ``StoryRecord.id``. Anything not in that set
    with a worktree under ``state/worktrees/`` is fair game. Returns the list
    of paths that were removed.

    Resilient: filesystem errors are swallowed so a tick can't be
    taken down by a stuck worktree.
    """
    base = state_dir(Path(software_factory_root)) / "worktrees"
    if not base.exists():
        return []
    removed: list[Path] = []
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        # Format: <app>-<story_id>-<slug>; if the parse fails we leave it
        # alone (operator might have a manually-created dir there).
        name = entry.name
        if not name.startswith(f"{app}-"):
            continue
        try:
            sid_part = name[len(app) + 1 :].split("-", 1)[0]
            sid = int(sid_part)
        except (ValueError, IndexError):
            continue
        if sid in active_story_ids:
            continue
        repo = Path(source_repo)
        if (repo / ".git").exists():
            _run_git(repo, "worktree", "remove", "--force", str(entry), check=False, timeout=WORKTREE_GIT_TIMEOUT_S)
        try:
            if entry.exists():
                shutil.rmtree(entry, ignore_errors=True)
            removed.append(entry)
        except OSError:
            pass
    repo = Path(source_repo)
    if (repo / ".git").exists():
        _run_git(repo, "worktree", "prune", check=False, timeout=WORKTREE_GIT_TIMEOUT_S)
    return removed


__all__ = [
    "ensure_worktree_for_story",
    "prune_stale_worktrees",
    "remove_worktree_for_story",
    "worktree_path",
]
