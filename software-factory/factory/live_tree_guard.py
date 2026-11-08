"""Catch an agent that writes into the live checkout instead of its worktree.

A story's agent works in a linked git worktree of the app repo. Nothing in
the API runtime stops its file editor from writing anywhere (it runs in the
factory's process), and the worktree's ``.git`` file names the live checkout
it hangs off. On 2026-11-08 an onboarder walked from its worktree up to the
live dev-tools checkout and wrote the whole context set there: the worktree
stayed empty ("onboarder produced no files") and the live tree, which the
stacks run from, gained ten untracked files.

:class:`LiveTreeGuard` snapshots the live checkout's ``git status`` before a
run and compares after it. Files that became untracked during the run (and
were written after it started) are MOVED into the worktree at the same
repo-relative path, where the chain's own commit picks them up; tracked files
the run modified are reported, never reverted (a human may be editing). Only
non-ignored paths are seen: ignored runtime dirs are not checked. Best
effort: a git failure disables the guard for the run, never fails it.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

EVENT_WROTE_OUTSIDE_WORKTREE = "wrote_outside_worktree"


def _git(cwd: Path, *args: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 else None


def live_checkout(worktree: Path) -> Path | None:
    """The main checkout a linked worktree belongs to; ``None`` if not linked."""
    common = _git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
    own = _git(worktree, "rev-parse", "--path-format=absolute", "--git-dir")
    if not common or not own:
        return None
    common_p, own_p = Path(common.strip()), Path(own.strip())
    if common_p.resolve() == own_p.resolve():
        return None  # the main checkout itself, not a linked worktree
    if common_p.name != ".git":
        return None  # a bare repo: no live working tree to protect
    return common_p.parent


def _status(repo: Path) -> tuple[set[str], set[str]] | None:
    """``(untracked, modified)`` repo-relative posix paths, or ``None``."""
    out = _git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if out is None:
        return None
    untracked: set[str] = set()
    modified: set[str] = set()
    entries = out.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        if code[0] in "RC":
            i += 1  # the rename source follows
        if code == "??":
            untracked.add(path)
        else:
            modified.add(path)
    return untracked, modified


@dataclass
class GuardReport:
    live: str
    moved: list[str] = field(default_factory=list)
    left: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)

    @property
    def escaped(self) -> bool:
        return bool(self.moved or self.left or self.modified)

    def note(self) -> str:
        parts = []
        if self.moved:
            parts.append(f"moved into the worktree: {', '.join(self.moved[:10])}")
        if self.left:
            parts.append(f"left in place (already in the worktree): {', '.join(self.left[:10])}")
        if self.modified:
            parts.append(f"tracked files changed, not reverted: {', '.join(self.modified[:10])}")
        return f"the agent wrote into the live checkout {self.live} — " + "; ".join(parts)


class LiveTreeGuard:
    def __init__(self, worktree: Path) -> None:
        self.worktree = Path(worktree)
        self.live: Path | None = None
        self._before: tuple[set[str], set[str]] | None = None
        self._t0 = 0.0
        try:
            self.live = live_checkout(self.worktree)
            if self.live is not None:
                self._before = _status(self.live)
        except Exception:  # noqa: BLE001 - best effort
            self.live = None
        self._t0 = time.time() - 2.0  # mtime granularity / clock slack

    def check(self) -> GuardReport | None:
        """Compare with the snapshot; move new untracked files. ``None`` = clean/off."""
        if self.live is None or self._before is None:
            return None
        after = _status(self.live)
        if after is None:
            return None
        report = GuardReport(live=str(self.live))
        for rel in sorted(after[0] - self._before[0]):
            src = self.live / rel
            try:
                if not src.is_file() or src.stat().st_mtime < self._t0:
                    continue
                dst = self.worktree / rel
                if dst.exists():
                    report.left.append(rel)
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                report.moved.append(rel)
                _prune_empty_dirs(src.parent, self.live)
            except OSError:
                report.left.append(rel)
        for rel in sorted(after[1] - self._before[1]):
            src = self.live / rel
            try:
                if src.exists() and src.stat().st_mtime < self._t0:
                    continue
            except OSError:
                pass
            report.modified.append(rel)
        return report if report.escaped else None


def _prune_empty_dirs(d: Path, stop: Path) -> None:
    try:
        stop_r = stop.resolve()
        while d.resolve() != stop_r and d.is_dir() and not any(d.iterdir()):
            d.rmdir()
            d = d.parent
    except OSError:
        pass
