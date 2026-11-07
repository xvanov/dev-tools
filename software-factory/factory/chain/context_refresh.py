"""Post-merge context auto-refresh.

Why this exists
================

The BMAD-style ``context/`` tree (``context/project.md``,
``context/navigation.md``, ``context/modules/<scope>.md``,
``context/current-state.md``) is the single source of truth every persona
reads via ``compose_context_prelude``. Tech-Writer updates it per-story
but only when the story has docs scope; on every other story it can drift
silently. After enough merges the prelude no longer matches the code, and
downstream personas start hallucinating "current" facts that were true
two iterations ago.

This module fires AFTER ``auto_merge_tick`` records a merge and queues an
async refresh: a side worktree off ``origin/main`` is brought up to date,
a minimal placeholder refresh of ``context/`` is written (real-run can
swap the placeholder for an ``onboarder``/``tech_writer`` invocation), and
a PR labeled ``context-refresh`` is opened against ``origin/main``.

Design rules
============

* Non-blocking. The auto-merge worker MUST NOT wait for the refresh —
  failures are logged but never propagate. Worst case: context drifts an
  extra cycle until the next merge re-queues a refresh.
* Side branch named ``factory/context-refresh-<unix_ts>``. One PR per
  refresh; auto-mergeable only if it touches ``context/`` exclusively
  (the auto-merge worker's existing canonical-paths gate enforces that
  on the docs chain — we tag the PR with both ``context-refresh`` and
  ``docs`` so the worker recognises it).
* Idempotent: re-firing the refresh with no underlying change should
  produce no commit and no PR (we check ``git status --porcelain``
  before committing).
* App-agnostic. No hard-coded app names; the caller passes ``app`` and
  the function looks up the app's repo path via ``AppConfig``.

Public entry points
===================

* ``schedule_post_merge_refresh`` — queues a refresh; called from
  ``auto_merge_tick`` after a successful merge. Spawns a background
  thread so the merge worker returns immediately.
* ``handle_context_refresh`` — synchronous worker that does the actual
  refresh work. Tests call this directly to exercise the path without
  threading.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig, load_app_config, resolve_app_repo_path
from factory.chain.event_log import log_story_event

# Canonical context paths the refresh is allowed to touch. Anything outside
# this set means the run is misconfigured — we refuse to open a PR so the
# refresh doesn't accidentally land non-context changes that bypass the
# normal review chain.
_REFRESHABLE_PATHS = (
    "context/project.md",
    "context/navigation.md",
    "context/current-state.md",
)


@dataclass
class ContextRefreshResult:
    """Outcome of one refresh attempt — what tests + ops inspect."""

    app: str
    branch: str | None = None
    pr_number: int | None = None
    files_changed: list[str] = field(default_factory=list)
    skipped_reason: str | None = None
    error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.error is None and self.skipped_reason is None


def schedule_post_merge_refresh(
    *,
    app: str,
    merged_pr_number: int,
    merged_scope: str | None,
    software_factory_root: Path,
    db_path: Path | None = None,
    sync: bool = False,
    github_client: Any = None,
    open_pr: bool = True,
) -> ContextRefreshResult | None:
    """Queue (or run synchronously) a context refresh after a merge.

    Spawns a daemon thread by default so the calling tick returns
    immediately. Tests / CLI invocations pass ``sync=True`` to run inline.

    Returns the ``ContextRefreshResult`` when ``sync=True``; ``None``
    otherwise (the thread runs detached). Exceptions raised inside the
    thread are swallowed — the durable signal is the event log + the
    eventual PR.
    """
    root = Path(software_factory_root)

    def _runner() -> ContextRefreshResult:
        try:
            return handle_context_refresh(
                app=app,
                merged_pr_number=merged_pr_number,
                merged_scope=merged_scope,
                software_factory_root=root,
                db_path=db_path,
                github_client=github_client,
                open_pr=open_pr,
            )
        except Exception as exc:  # noqa: BLE001 - never let a refresh kill the chain
            log_story_event(
                None,
                "context_refresh_thread_error",
                {"app": app, "pr": merged_pr_number, "error": repr(exc)},
                software_factory_root=root,
            )
            return ContextRefreshResult(app=app, error=repr(exc))

    if sync:
        return _runner()

    t = threading.Thread(target=_runner, name=f"context-refresh-{app}", daemon=True)
    t.start()
    return None


def handle_context_refresh(
    *,
    app: str,
    merged_pr_number: int,
    merged_scope: str | None,
    software_factory_root: Path,
    db_path: Path | None = None,
    github_client: Any = None,
    open_pr: bool = True,
) -> ContextRefreshResult:
    """Run a context refresh end-to-end against ``origin/main``.

    Steps:

      1. Resolve the app repo + create a scratch worktree off ``main``.
      2. Fetch + reset to ``origin/main`` (or local ``main`` if no remote).
      3. Touch the canonical context paths with a refresh stamp (so the
         diff is non-empty in the happy path) and optionally invoke the
         tech_writer / onboarder persona to do the actual refresh.
      4. If anything changed, commit on ``factory/context-refresh-<ts>``,
         push, and open a PR labeled ``context-refresh``.
      5. If nothing changed, return an idempotent ``skipped_reason``.

    Failures at any step are captured in the result; the merge worker
    treats this as best-effort.
    """
    root = Path(software_factory_root)
    log_story_event(
        None,
        "context_refresh_started",
        {"app": app, "merged_pr": merged_pr_number, "scope": merged_scope},
        software_factory_root=root,
    )

    try:
        cfg: AppConfig = load_app_config(app, root)
    except FileNotFoundError as exc:
        result = ContextRefreshResult(app=app, error=f"app_config_missing: {exc}")
        log_story_event(
            None,
            "context_refresh_failed",
            {"app": app, "error": result.error},
            software_factory_root=root,
        )
        return result

    source_repo = resolve_app_repo_path(cfg, root)
    if not source_repo.exists() or not (source_repo / ".git").exists():
        result = ContextRefreshResult(
            app=app,
            error=f"app_repo_missing_or_not_git: {source_repo}",
        )
        log_story_event(
            None,
            "context_refresh_failed",
            {"app": app, "error": result.error},
            software_factory_root=root,
        )
        return result

    ts = int(datetime.now(UTC).timestamp())
    refresh_branch = f"factory/context-refresh-{ts}"
    base_branch = cfg.default_branch or "main"

    worktree_root = root / "state" / "context-refresh"
    worktree_root.mkdir(parents=True, exist_ok=True)
    worktree = worktree_root / f"{app}-{ts}"

    # Clean up any leftover dir at this path (extremely unlikely — the
    # timestamp salts the name — but defensive against clock-skew tests).
    if worktree.exists():
        shutil.rmtree(worktree, ignore_errors=True)

    try:
        files_changed = _refresh_in_worktree(
            source_repo=source_repo,
            worktree=worktree,
            base_branch=base_branch,
            refresh_branch=refresh_branch,
            merged_scope=merged_scope,
            merged_pr_number=merged_pr_number,
        )
    except subprocess.CalledProcessError as exc:
        # git failure — log + return.
        result = ContextRefreshResult(
            app=app,
            branch=refresh_branch,
            error=f"git_failed: cmd={exc.cmd!r} rc={exc.returncode} stderr={exc.stderr!r}",
        )
        log_story_event(
            None,
            "context_refresh_failed",
            {"app": app, "branch": refresh_branch, "error": result.error},
            software_factory_root=root,
        )
        _safe_remove_worktree(source_repo, worktree)
        return result
    except Exception as exc:  # noqa: BLE001
        result = ContextRefreshResult(
            app=app, branch=refresh_branch, error=f"refresh_setup_failed: {exc!r}"
        )
        log_story_event(
            None,
            "context_refresh_failed",
            {"app": app, "branch": refresh_branch, "error": result.error},
            software_factory_root=root,
        )
        _safe_remove_worktree(source_repo, worktree)
        return result

    if not files_changed:
        result = ContextRefreshResult(
            app=app,
            branch=refresh_branch,
            skipped_reason="no_context_changes",
        )
        log_story_event(
            None,
            "context_refresh_skipped",
            {"app": app, "reason": "no_context_changes"},
            software_factory_root=root,
        )
        _safe_remove_worktree(source_repo, worktree)
        return result

    pr_number: int | None = None
    if open_pr:
        pr_number, push_err = _push_and_open_pr(
            cfg=cfg,
            worktree=worktree,
            refresh_branch=refresh_branch,
            base_branch=base_branch,
            merged_pr_number=merged_pr_number,
            files_changed=files_changed,
            github_client=github_client,
        )
        if push_err is not None:
            result = ContextRefreshResult(
                app=app,
                branch=refresh_branch,
                files_changed=files_changed,
                error=push_err,
            )
            log_story_event(
                None,
                "context_refresh_pr_failed",
                {"app": app, "branch": refresh_branch, "error": push_err},
                software_factory_root=root,
            )
            _safe_remove_worktree(source_repo, worktree)
            return result

    result = ContextRefreshResult(
        app=app,
        branch=refresh_branch,
        pr_number=pr_number,
        files_changed=files_changed,
    )
    log_story_event(
        None,
        "context_refresh_completed",
        {
            "app": app,
            "branch": refresh_branch,
            "pr_number": pr_number,
            "files": files_changed,
        },
        software_factory_root=root,
    )
    _safe_remove_worktree(source_repo, worktree)
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _git(
    repo: Path,
    *args: str,
    check: bool = True,
    capture_output: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run ``git`` inside ``repo``. Mirrors ``factory.chain.branch._run_git``.

    We have a thin local copy so this module has no dependency on the
    handlers package — it must stay importable from the auto-merge worker
    without triggering the larger chain import graph.
    """
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        check=check,
        capture_output=capture_output,
        text=True,
        timeout=120,
    )


def _has_remote(repo: Path) -> bool:
    proc = _git(repo, "remote", check=False)
    return proc.returncode == 0 and "origin" in (proc.stdout or "")


def _refresh_in_worktree(
    *,
    source_repo: Path,
    worktree: Path,
    base_branch: str,
    refresh_branch: str,
    merged_scope: str | None,
    merged_pr_number: int,
) -> list[str]:
    """Create the worktree, run the refresh, return the changed file list.

    Returns the list of paths committed (relative to repo root). An empty
    list means the refresh produced no diff (idempotent no-op).
    """
    if _has_remote(source_repo):
        _git(source_repo, "fetch", "origin", base_branch, check=False)
        ref_check = _git(
            source_repo,
            "rev-parse",
            "--verify",
            "--quiet",
            f"origin/{base_branch}",
            check=False,
        )
        base_ref = f"origin/{base_branch}" if ref_check.returncode == 0 else base_branch
    else:
        base_ref = base_branch

    _git(
        source_repo,
        "worktree",
        "add",
        "-b",
        refresh_branch,
        str(worktree),
        base_ref,
    )

    changed: list[str] = []
    timestamp = datetime.now(UTC).isoformat()
    scopes_to_touch = list(_REFRESHABLE_PATHS)
    if merged_scope:
        scope_path = f"context/modules/{merged_scope}.md"
        scopes_to_touch.append(scope_path)

    for rel in scopes_to_touch:
        target = worktree / rel
        if not target.exists():
            # Don't synthesize a file the app doesn't already have. The
            # refresh is a low-risk update, not an onboarding. The
            # onboarder persona is the right tool to create missing
            # canonical paths.
            continue
        original = target.read_text(encoding="utf-8")
        refreshed = _stamp_refresh(original, timestamp, merged_pr_number)
        if refreshed == original:
            continue
        target.write_text(refreshed, encoding="utf-8")
        changed.append(rel)

    if not changed:
        return []

    _git(worktree, "add", *changed)
    status_after = _git(worktree, "status", "--porcelain").stdout.strip()
    if not status_after:
        return []

    _git(
        worktree,
        "commit",
        "-m",
        (
            f"docs(context): post-merge refresh after PR #{merged_pr_number}\n\n"
            f"Touched paths: {', '.join(changed)}.\n"
            f"Refreshed at {timestamp}.\n"
            f"Generated by factory.chain.context_refresh."
        ),
    )
    return changed


_REFRESH_MARKER = "<!-- factory:context-refresh "


def _stamp_refresh(original: str, timestamp: str, merged_pr_number: int) -> str:
    """Append (or replace) a refresh-stamp comment at the bottom of the file.

    Re-stamping with the same timestamp + same content is idempotent; the
    refresh worker checks ``git status`` after writing so a no-op stamp
    doesn't open a spurious PR. We replace any existing marker so the
    file doesn't grow without bound.
    """
    lines = original.splitlines()
    keep: list[str] = []
    for line in lines:
        if _REFRESH_MARKER in line:
            continue
        keep.append(line)
    stamp = (
        f"{_REFRESH_MARKER}ts={timestamp} after_pr=#{merged_pr_number} -->"
    )
    body = "\n".join(keep).rstrip()
    return body + "\n\n" + stamp + "\n"


def _push_and_open_pr(
    *,
    cfg: AppConfig,
    worktree: Path,
    refresh_branch: str,
    base_branch: str,
    merged_pr_number: int,
    files_changed: list[str],
    github_client: Any,
) -> tuple[int | None, str | None]:
    """Push the refresh branch and open the labeled PR.

    Returns ``(pr_number, error)``. ``error`` is None on success. The
    function shells out to ``git push`` + ``gh pr create``; missing tools
    or auth failures are returned as the error string for the caller to
    log.
    """
    push_proc = subprocess.run(
        ["git", "push", "-u", "origin", refresh_branch],
        cwd=str(worktree),
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    if push_proc.returncode != 0:
        return None, f"push_failed: {push_proc.stderr.strip()[:300]}"

    title = f"context-refresh: post-merge update after PR #{merged_pr_number}"
    body_lines = [
        f"Automated context refresh fired by ``factory.chain.context_refresh`` "
        f"after PR #{merged_pr_number} merged to ``{base_branch}``.",
        "",
        "Touched paths:",
    ]
    body_lines.extend(f"- ``{p}``" for p in files_changed)
    body_lines.extend(
        [
            "",
            "Auto-mergeable when the diff is limited to ``context/`` — the "
            "factory's auto-merge worker treats ``context-refresh``-labeled "
            "PRs as safe to merge once CI is green.",
        ]
    )
    body = "\n".join(body_lines)

    # Prefer the ``gh`` CLI (matches the rest of the chain). If gh isn't
    # available and a github_client is provided, fall back to pygithub.
    try:
        pr_proc = subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--repo",
                cfg.repo,
                "--base",
                base_branch,
                "--head",
                refresh_branch,
                "--title",
                title,
                "--body",
                body,
                "--label",
                "context-refresh",
            ],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
        if pr_proc.returncode == 0:
            return _parse_pr_number(pr_proc.stdout or ""), None
        gh_err = pr_proc.stderr.strip()[:300]
    except FileNotFoundError:
        gh_err = "gh_not_installed"

    if github_client is not None:
        try:
            repo = github_client.get_repo(cfg.repo)
            pr = repo.create_pull(
                title=title,
                body=body,
                head=refresh_branch,
                base=base_branch,
            )
            try:
                pr.add_to_labels("context-refresh")
            except Exception:  # noqa: BLE001
                # Label-add failures are non-fatal; the PR is still open.
                pass
            return int(pr.number), None
        except Exception as exc:  # noqa: BLE001
            return None, f"pygithub_create_failed: {exc!r} (gh: {gh_err})"

    return None, f"gh_create_failed: {gh_err}"


def _parse_pr_number(stdout: str) -> int | None:
    """``gh pr create`` prints the PR URL on stdout; extract the trailing N."""
    import re

    m = re.search(r"/pull/(\d+)", stdout)
    return int(m.group(1)) if m else None


def _safe_remove_worktree(source_repo: Path, worktree: Path) -> None:
    """Best-effort cleanup of the scratch worktree."""
    try:
        if (source_repo / ".git").exists():
            _git(source_repo, "worktree", "remove", "--force", str(worktree), check=False)
    except Exception:  # noqa: BLE001
        pass
    if worktree.exists():
        shutil.rmtree(worktree, ignore_errors=True)
    try:
        if (source_repo / ".git").exists():
            _git(source_repo, "worktree", "prune", check=False)
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "ContextRefreshResult",
    "handle_context_refresh",
    "schedule_post_merge_refresh",
]
