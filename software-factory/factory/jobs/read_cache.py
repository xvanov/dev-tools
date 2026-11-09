"""Background GitHub and tick-coverage snapshot for ``factory serve`` reads.

``factory job status`` / ``job list`` on the CLI still ask GitHub live: a
human's answer has to be current. The serve read API (``POST /api/cli``)
does not. It reads this snapshot, which a daemon thread refreshes about
every 10 s, off the request. One failed refresh keeps the previous good
snapshot; ``github_as_of`` is that snapshot's time, so a caller can see
the age. Before the first successful refresh a read is the local view
and says GitHub is unavailable — the same fail-safe as ``gh`` being down.

Tick coverage (``ticked``) is refreshed here too. A request never calls
``systemctl``; until the first refresh it trusts only ``serve.json``.
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.jobs.github import GitHubView, PRInfo

INTERVAL_S = 10.0

_BRANCH_STATE = "delivered_branch"
_MERGED_STATES = frozenset({"deploy_pending", "deployed"})


@dataclass
class RepoSnap:
    """One repo's GitHub facts, copied into a view at read time."""

    repo: str
    as_of: str | None
    index_ok: bool
    prs: dict[int, PRInfo]
    errors: list[str]
    rollups: dict[int, list[Any] | None]
    branches: dict[str, bool | None]
    contains: dict[str, bool | None]
    api: dict[str, Any]


@dataclass
class _Need:
    base: str = "main"
    prs: set[int] = field(default_factory=set)
    branches: set[str] = field(default_factory=set)
    contains: set[tuple[str, str]] = field(default_factory=set)


class SnapshotView(GitHubView):
    """A :class:`GitHubView` that never calls ``gh``.

    Missing facts are unknown (``None``), not a subprocess. A snapshot that
    was never taken, or whose index failed and nothing older is kept, records
    one error so status says ``GitHub unavailable, local view``.
    """

    def __init__(self, snap: RepoSnap | None, repo: str) -> None:
        super().__init__(repo)
        if snap is None or not snap.index_ok:
            self._index_failed = True
            self.as_of = None
            if snap is None:
                self._note("no cached GitHub view")
            else:
                self.errors = list(snap.errors)
                if not self.errors:
                    self._note("cached GitHub view failed")
            return
        self._index = dict(snap.prs)
        self._branches = dict(snap.branches)
        self._contains = dict(snap.contains)
        self._rollups = dict(snap.rollups)
        self._api = dict(snap.api)
        self.errors = list(snap.errors)
        self.as_of = snap.as_of

    def _call(self, args: list[str]) -> None:  # type: ignore[override]
        # Unknown fact: same as ``gh`` returning nothing, without a process
        # and without marking the whole view unavailable (a CI miss must not).
        del args
        return None


class CacheGitHub:
    """The serve stand-in for :class:`factory.jobs.github.GitHubCache`."""

    def __init__(self) -> None:
        self.enabled = True

    def view(self, repo: str) -> SnapshotView | None:
        if not self.enabled or not repo:
            return None
        with _lock:
            snap = _snaps.get(repo)
        return SnapshotView(snap, repo)


_lock = threading.Lock()
_snaps: dict[str, RepoSnap] = {}
_coverage: Any = None
_thread: threading.Thread | None = None
_stop = threading.Event()
_root: Path | None = None
_CACHE = CacheGitHub()


def cache_github() -> CacheGitHub:
    return _CACHE


def cached_coverage(root: Path) -> Any:
    """Last coverage snapshot, or serve.json alone when none has been taken.

    Never calls ``systemctl``. Linux timer-only apps read ``ticked`` once the
    background refresh has stored a scan.
    """
    with _lock:
        hit = _coverage
    if hit is not None:
        return hit
    from factory.scheduler.coverage import read_coverage

    return read_coverage(Path(root), timers=lambda: [])


def seed_repo(snap: RepoSnap) -> None:
    """Install ``snap`` (tests, and a refresh that succeeded)."""
    with _lock:
        _snaps[snap.repo] = snap


def seed_coverage(coverage: Any) -> None:
    with _lock:
        global _coverage
        _coverage = coverage


def clear() -> None:
    """Drop snapshots. Tests use this so a later test does not see them."""
    global _coverage
    with _lock:
        _snaps.clear()
        _coverage = None


def _offer(snap: RepoSnap) -> None:
    with _lock:
        prev = _snaps.get(snap.repo)
        if snap.index_ok or prev is None or not prev.index_ok:
            _snaps[snap.repo] = snap


def _ro(db: Path) -> sqlite3.Connection | None:
    if not db.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def _repo_needs(root: Path) -> dict[str, _Need]:
    from factory.app_config import load_app_config
    from factory.jobs.common import registered_apps, state_db_path

    app_repo: dict[str, str] = {}
    needs: dict[str, _Need] = {}
    for app in registered_apps(root):
        try:
            cfg = load_app_config(app, root)
        except Exception:  # noqa: BLE001 - one broken app must not stop the refresh
            continue
        if not cfg.repo:
            continue
        app_repo[app] = cfg.repo
        need = needs.get(cfg.repo)
        if need is None:
            needs[cfg.repo] = _Need(base=cfg.default_branch or "main")
    conn = _ro(state_db_path(root))
    if conn is None:
        return needs
    try:
        try:
            rows = conn.execute(
                "SELECT app, id, state, github_pr_number, github_branch FROM stories"
            ).fetchall()
        except sqlite3.Error:
            rows = []
        for row in rows:
            repo = app_repo.get(str(row["app"]))
            if repo is None:
                continue
            need = needs[repo]
            pr = row["github_pr_number"]
            try:
                pr_n = int(pr) if pr else 0
            except (TypeError, ValueError):
                pr_n = 0
            if pr_n > 0:
                need.prs.add(pr_n)
            state = str(row["state"] or "")
            branch = row["github_branch"]
            if state == _BRANCH_STATE and branch:
                need.branches.add(str(branch))
            if state in _MERGED_STATES and pr_n <= 0 and row["id"] is not None:
                sha = _merged_sha(conn, str(row["app"]), int(row["id"]))
                if sha:
                    need.contains.add((need.base, sha))
    finally:
        conn.close()
    return needs


def _merged_sha(conn: sqlite3.Connection, app: str, story_id: int) -> str | None:
    try:
        row = conn.execute(
            "SELECT head_sha FROM merge_actions WHERE app = ? AND pr_number = ? AND merged = 1 "
            "ORDER BY id DESC LIMIT 1",
            (app, -int(story_id)),
        ).fetchone()
    except sqlite3.Error:
        return None
    if row is None or not row["head_sha"]:
        return None
    return str(row["head_sha"])


def _fetch(repo: str, need: _Need) -> RepoSnap:
    view = GitHubView(repo)
    view._load_index()
    for number in sorted(need.prs):
        view.pr(number)
    for branch in sorted(need.branches):
        view.branch_exists(branch)
    for branch, sha in sorted(need.contains):
        view.branch_contains(branch, sha)
    index = view._index or {}
    rollups: dict[int, list[Any] | None] = {}
    for number, info in index.items():
        if info.state == "open":
            rollups[number] = view.rollup_rows(number)
    base = need.base or "main"
    api = {
        path: view.api_json(path)
        for path in (
            f"repos/{repo}/branches/{base}",
            f"repos/{repo}/rules/branches/{base}",
        )
    }
    return RepoSnap(
        repo=repo,
        as_of=view.as_of,
        index_ok=view._index is not None,
        prs=dict(index),
        errors=list(view.errors),
        rollups=rollups,
        branches=dict(view._branches),
        contains=dict(view._contains),
        api=api,
    )


def refresh(root: Path) -> None:
    """Refresh coverage and every registered repo. Never raises.

    GitHub work happens here, on the background thread, not on a request.
    """
    root = Path(root)
    from factory.scheduler.coverage import read_coverage

    try:
        coverage = read_coverage(root)
    except Exception:  # noqa: BLE001 - a coverage miss leaves the previous one
        coverage = None
    if coverage is not None:
        seed_coverage(coverage)
    try:
        needs = _repo_needs(root)
    except Exception:  # noqa: BLE001
        return
    for repo, need in needs.items():
        try:
            _offer(_fetch(repo, need))
        except Exception:  # noqa: BLE001 - one repo must not stop the others
            continue


def ensure_started(
    root: Path,
    *,
    log: Any = lambda _msg: None,
    interval_s: float = INTERVAL_S,
) -> None:
    """Start the refresh thread if it is not already running (one per process)."""
    global _thread, _root
    with _lock:
        _root = Path(root)
        if _thread is not None and _thread.is_alive():
            return
        _stop.clear()

        def loop() -> None:
            while not _stop.is_set():
                current = _root
                if current is not None:
                    try:
                        refresh(current)
                    except Exception as exc:  # noqa: BLE001 - the next pass retries
                        log(f"read-cache refresh failed: {exc!r}")
                _stop.wait(interval_s)

        _thread = threading.Thread(target=loop, name="factory-read-cache", daemon=True)
        _thread.start()


def stop(timeout: float = 2.0) -> None:
    """Stop the refresh thread (tests)."""
    global _thread
    _stop.set()
    thread = _thread
    if thread is not None:
        thread.join(timeout)
    with _lock:
        if _thread is thread:
            _thread = None


__all__ = [
    "INTERVAL_S",
    "CacheGitHub",
    "RepoSnap",
    "SnapshotView",
    "cache_github",
    "cached_coverage",
    "clear",
    "ensure_started",
    "refresh",
    "seed_coverage",
    "seed_repo",
    "stop",
]
