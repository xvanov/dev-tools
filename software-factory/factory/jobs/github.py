"""Cheap, cached, fail-soft GitHub reads for ``factory job status``.

Merge reality lives on GitHub, never in a local flag (CLAUDE.md "proxy ≠
real"), so PR state and branch existence come from ``gh``. To stay cheap a
repo's PRs are fetched with ONE ``gh pr list --state all`` call per process
and indexed by number; only a PR older than that window costs its own
``gh pr view``. Every failure degrades to "unknown" (``None``) plus a recorded
error, which the caller turns into a ``why`` note and the local view.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from typing import Any

_PR_FIELDS = "number,state,url,headRefName,isDraft"
_LIST_LIMIT = 200
_TIMEOUT_S = 20


def _run_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
    """The single subprocess seam (tests monkeypatch this)."""
    return subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
        check=False,
    )


@dataclass
class PRInfo:
    number: int
    state: str  # open | merged | closed
    url: str
    branch: str | None
    draft: bool = False


def _to_info(raw: dict[str, Any]) -> PRInfo | None:
    try:
        number = int(raw["number"])
    except (KeyError, TypeError, ValueError):
        return None
    return PRInfo(
        number=number,
        state=str(raw.get("state") or "").lower() or "open",
        url=str(raw.get("url") or ""),
        branch=raw.get("headRefName"),
        draft=bool(raw.get("isDraft")),
    )


@dataclass
class GitHubView:
    """Per-repo, per-process cache of PR and branch facts."""

    repo: str
    errors: list[str] = field(default_factory=list)
    _index: dict[int, PRInfo] | None = None
    _index_failed: bool = False
    _branches: dict[str, bool | None] = field(default_factory=dict)
    _contains: dict[str, bool | None] = field(default_factory=dict)
    _ci: dict[int, dict[str, Any] | None] = field(default_factory=dict)

    def _call(self, args: list[str]) -> subprocess.CompletedProcess[str] | None:
        try:
            return _run_gh(args)
        except (OSError, subprocess.SubprocessError) as exc:
            self._note(f"gh unavailable: {exc}")
            return None

    def _note(self, msg: str) -> None:
        if msg not in self.errors:
            self.errors.append(msg)

    def _load_index(self) -> dict[int, PRInfo] | None:
        if self._index is not None or self._index_failed:
            return self._index
        proc = self._call(
            [
                "pr",
                "list",
                "--repo",
                self.repo,
                "--state",
                "all",
                "--limit",
                str(_LIST_LIMIT),
                "--json",
                _PR_FIELDS,
            ]
        )
        if proc is None or proc.returncode != 0:
            if proc is not None:
                self._note(f"gh pr list failed: {(proc.stderr or '').strip()[:200]}")
            self._index_failed = True
            return None
        try:
            rows = json.loads(proc.stdout or "[]")
        except json.JSONDecodeError:
            self._note("gh pr list returned non-JSON")
            self._index_failed = True
            return None
        index: dict[int, PRInfo] = {}
        for raw in rows if isinstance(rows, list) else []:
            info = _to_info(raw) if isinstance(raw, dict) else None
            if info is not None:
                index[info.number] = info
        self._index = index
        return index

    def pr(self, number: int) -> PRInfo | None:
        """PR facts, or ``None`` when GitHub could not be asked."""
        index = self._load_index()
        if index is None:
            return None
        if number in index:
            return index[number]
        proc = self._call(["pr", "view", str(number), "--repo", self.repo, "--json", _PR_FIELDS])
        if proc is None or proc.returncode != 0:
            if proc is not None:
                self._note(f"gh pr view #{number} failed: {(proc.stderr or '').strip()[:200]}")
            return None
        try:
            info = _to_info(json.loads(proc.stdout or "{}"))
        except json.JSONDecodeError:
            info = None
        if info is not None:
            index[number] = info
        return info

    def ci(self, number: int) -> dict[str, Any] | None:
        """The PR's CI rollup: ``{"state", "failing", "pending"}``, or ``None``.

        ``state`` is ``passing`` (every check finished green), ``failing`` (any
        check failed), ``pending`` (none failed, some still running) or
        ``none`` (no checks reported). One ``gh pr view`` per PR, cached.
        """
        if number in self._ci:
            return self._ci[number]
        proc = self._call(
            ["pr", "view", str(number), "--repo", self.repo, "--json", "statusCheckRollup"]
        )
        result: dict[str, Any] | None = None
        # A failed CI read leaves ``ci`` unknown (``None``); it is NOT recorded
        # as "GitHub unavailable" — the PR facts themselves were read fine.
        if proc is not None and proc.returncode == 0:
            try:
                rows = (json.loads(proc.stdout or "{}") or {}).get("statusCheckRollup") or []
            except (json.JSONDecodeError, AttributeError):
                rows = None
            if isinstance(rows, list):
                result = summarize_checks(rows)
        self._ci[number] = result
        return result

    def branch_exists(self, branch: str) -> bool | None:
        """True/False from GitHub, ``None`` when unknown."""
        if branch in self._branches:
            return self._branches[branch]
        proc = self._call(["api", f"repos/{self.repo}/branches/{branch}", "--silent"])
        result: bool | None
        if proc is None:
            result = None
        elif proc.returncode == 0:
            result = True
        elif "404" in (proc.stderr or "") or "Not Found" in (proc.stderr or ""):
            result = False
        else:
            self._note(f"gh api branch lookup failed: {(proc.stderr or '').strip()[:200]}")
            result = None
        self._branches[branch] = result
        return result

    def branch_contains(self, branch: str, sha: str) -> bool | None:
        """Does ``branch`` on GitHub contain commit ``sha``? ``None`` = unknown.

        ``push_to_main`` has no PR, so "merged" can only be proven by the
        default branch itself (finding 5, 2026-11-02): GitHub's compare API
        reports ``branch...sha`` as ``identical`` or ``behind`` exactly when
        the commit is already reachable from the branch head.
        """
        key = f"{branch}@{sha}"
        if key in self._contains:
            return self._contains[key]
        proc = self._call(["api", f"repos/{self.repo}/compare/{branch}...{sha}", "--jq", ".status"])
        result: bool | None
        if proc is None:
            result = None
        elif proc.returncode == 0:
            status = (proc.stdout or "").strip().strip('"')
            if status in ("identical", "behind"):
                result = True
            elif status in ("ahead", "diverged"):
                result = False
            else:
                self._note(f"gh compare returned unexpected status {status!r}")
                result = None
        elif "404" in (proc.stderr or "") or "Not Found" in (proc.stderr or ""):
            # Unknown commit on GitHub: definitely not on the branch.
            result = False
        else:
            self._note(f"gh compare failed: {(proc.stderr or '').strip()[:200]}")
            result = None
        self._contains[key] = result
        return result


_GREEN = {"SUCCESS", "NEUTRAL", "SKIPPED"}
_RED = {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}


def summarize_checks(rows: list[Any]) -> dict[str, Any]:
    """Collapse ``statusCheckRollup`` entries (CheckRun + StatusContext)."""
    failing: list[str] = []
    pending: list[str] = []
    seen = 0
    # One verdict per check name: the most recent run wins (a re-run's pass
    # supersedes an old failure). STALE = superseded by GitHub: ignored.
    latest: dict[str, dict[str, Any]] = {}
    for c in rows:
        if not isinstance(c, dict):
            continue
        if str(c.get("conclusion") or "").upper() == "STALE":
            continue
        key = f"{c.get('__typename')}:{c.get('name') or c.get('context') or '?'}"
        ts = str(c.get("completedAt") or c.get("startedAt") or c.get("createdAt") or "")
        prev = latest.get(key)
        prev_ts = (
            ""
            if prev is None
            else str(
                prev.get("completedAt") or prev.get("startedAt") or prev.get("createdAt") or ""
            )
        )
        if prev is None or ts >= prev_ts:
            latest[key] = c
    for c in latest.values():
        seen += 1
        name = str(c.get("name") or c.get("context") or "?")
        if c.get("__typename") == "StatusContext" or ("state" in c and "status" not in c):
            verdict = str(c.get("state") or "").upper()
            if verdict in ("PENDING", "EXPECTED", ""):
                pending.append(name)
            elif verdict not in _GREEN:
                failing.append(name)
            continue
        if str(c.get("status") or "").upper() != "COMPLETED":
            pending.append(name)
            continue
        conclusion = str(c.get("conclusion") or "").upper()
        if conclusion in _RED or conclusion not in _GREEN:
            failing.append(name)
    if failing:
        state = "failing"
    elif pending:
        state = "pending"
    elif seen:
        state = "passing"
    else:
        state = "none"
    return {"state": state, "failing": sorted(set(failing)), "pending": sorted(set(pending))}


class GitHubCache:
    """One :class:`GitHubView` per repo, shared across every job in a call."""

    def __init__(self, *, enabled: bool = True) -> None:
        self.enabled = enabled
        self._views: dict[str, GitHubView] = {}

    def view(self, repo: str) -> GitHubView | None:
        if not self.enabled or not repo:
            return None
        if repo not in self._views:
            self._views[repo] = GitHubView(repo)
        return self._views[repo]
