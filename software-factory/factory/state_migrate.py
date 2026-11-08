"""``factory state migrate``: move a root's ``state/`` out of the repo.

Moves every entry of ``<root>/state`` (except the tracked ``.gitignore``)
into the target directory, writes the ``<root>/.state-dir`` pointer
(:mod:`factory.state_dir`) and re-links the moved git worktrees
(``git worktree repair``) so their main repos find them at the new path.

Refuses, changing nothing, when:

* the root is already migrated (pointer present),
* the target is inside the root's own git repo (the point is to leave it),
* the target exists and is not empty,
* the target is on another filesystem than ``state/`` (entries are renamed,
  never copied: a copy of the worktrees is slow, and a copy that fails half
  way cannot be undone),
* a factory process holds a lock under ``state/locks`` (``factory serve``,
  a tick): stop them first,
* the live SQLite database cannot be opened exclusively.

A rename that fails part-way (on Windows: a process with a file open or its
working directory inside an entry) is rolled back (the renamed entries renamed
back) before the pointer is written, so a root is either fully migrated or
untouched. Nothing runs this by itself: it is an operator command.
Historic absolute paths recorded inside state (termhub session links to old
``api_runs`` streams, job workspaces in finished jobs' records) keep their
old values; nothing live depends on them once the processes restart.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from factory import oscompat
from factory.state_dir import (
    POINTER_NAME,
    clear_cache,
    default_external_dir,
    read_pointer,
)

KEEP = frozenset({".gitignore"})


class MigrateError(RuntimeError):
    """The migration was refused; nothing was changed."""


@dataclass
class MigrateReport:
    root: str
    source: str
    target: str
    entries: list[str] = field(default_factory=list)
    repaired: list[str] = field(default_factory=list)
    repair_failed: list[str] = field(default_factory=list)
    dry_run: bool = False


def _repo_toplevel(path: Path) -> Path | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(path),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    return Path(proc.stdout.strip()).resolve()


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _busy_locks(src: Path) -> list[str]:
    busy: list[str] = []
    locks = src / "locks"
    if not locks.is_dir():
        return busy
    for lock in sorted(locks.glob("*.lock")):
        try:
            with open(lock, "a+b") as fh:
                try:
                    oscompat.lock_file(fh, blocking=False)
                except (BlockingIOError, PermissionError):
                    busy.append(lock.name)
                    continue
                oscompat.unlock_file(fh)
        except OSError:
            busy.append(lock.name)
    return busy


def _db_busy(src: Path) -> str | None:
    db = src / "factory.db"
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(str(db), timeout=1)
        try:
            con.execute("BEGIN EXCLUSIVE")
            con.execute("ROLLBACK")
            # fold the WAL back so factory.db alone carries the data
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            con.close()
    except sqlite3.Error as exc:
        return f"factory.db is in use ({exc})"
    return None


def _worktree_links(target: Path, max_depth: int = 3) -> list[Path]:
    """Moved linked worktrees: dirs whose ``.git`` is a file (``state/worktrees/<name>``
    today), at most ``max_depth`` levels down, not descending into a git tree."""
    out: list[Path] = []

    def walk(d: Path, depth: int) -> None:
        try:
            children = sorted(c for c in d.iterdir() if c.is_dir() and not c.is_symlink())
        except OSError:
            return
        for c in children:
            git = c / ".git"
            if git.is_file():
                out.append(c)
            elif not git.exists() and depth < max_depth:
                walk(c, depth + 1)

    walk(target, 1)
    return out


def _repair(wt: Path, old: Path) -> bool:
    """Point the main repo at the worktree's new path (``git worktree repair``).

    ``old`` is where the worktree was: a relative ``gitdir:`` (git's
    ``worktree.useRelativePaths``) is resolved from there and rewritten
    absolute first, since it no longer resolves from the new place.
    """
    dotgit = wt / ".git"
    try:
        text = dotgit.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not text.startswith("gitdir:"):
        return False
    admin = Path(text.split(":", 1)[1].strip())  # <main>/.git/worktrees/<name>
    if not admin.is_absolute():
        admin = Path(os.path.normpath(old / admin))
        try:
            # r+, not w: Windows refuses to recreate a hidden file, and git hides .git
            with open(dotgit, "r+", encoding="utf-8") as fh:
                fh.write(f"gitdir: {admin.as_posix()}\n")
                fh.truncate()
        except OSError:
            return False
    main_git = admin.parent.parent
    main = main_git.parent if main_git.name == ".git" else main_git
    try:
        proc = subprocess.run(
            ["git", "worktree", "repair", str(wt)],
            cwd=str(main),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def migrate(
    root: Path | str,
    target: Path | str | None = None,
    *,
    dry_run: bool = False,
) -> MigrateReport:
    """Move ``<root>/state`` to ``target`` (default:
    :func:`factory.state_dir.default_external_dir`). Raises :class:`MigrateError`."""
    root_p = Path(root).resolve()
    src = root_p / "state"
    existing = read_pointer(root_p)
    if existing is not None:
        raise MigrateError(f"{root_p} is already migrated: its state is at {existing}")
    raw = target or default_external_dir()
    dst = Path(raw).expanduser().resolve()
    top = _repo_toplevel(root_p)
    if _inside(dst, root_p) or (top is not None and _inside(dst, top)):
        raise MigrateError(f"target {dst} is inside the repo; pick a directory outside it")
    if dst.exists() and (not dst.is_dir() or any(dst.iterdir())):
        raise MigrateError(f"target {dst} exists and is not empty")
    entries = sorted(c.name for c in src.iterdir() if c.name not in KEEP) if src.is_dir() else []
    report = MigrateReport(
        root=str(root_p), source=str(src), target=str(dst), entries=entries, dry_run=dry_run
    )
    busy = _busy_locks(src)
    if busy:
        raise MigrateError(
            f"factory processes hold {', '.join(busy)}: stop factory serve (and any tick) first"
        )
    if entries and not _same_filesystem(src, dst):
        raise MigrateError(
            f"target {dst} is on another filesystem than {src}; state is renamed, never "
            "copied: pick a target on the same disk"
        )
    if dry_run:
        return report
    why = _db_busy(src)
    if why:
        raise MigrateError(why)

    created = not dst.exists()
    dst.mkdir(parents=True, exist_ok=True)
    moved: list[str] = []
    for name in entries:
        try:
            os.rename(src / name, dst / name)
        except OSError as exc:
            stuck = [n for n in reversed(moved) if not _rename_back(dst / n, src / n)]
            if created and not stuck:
                try:
                    dst.rmdir()
                except OSError:
                    pass
            if stuck:
                raise MigrateError(
                    f"moving {name} failed ({exc}) and {', '.join(stuck)} could not be moved "
                    f"back from {dst}: move them to {src} by hand; no pointer was written"
                ) from exc
            raise MigrateError(
                f"moving {name} failed ({exc}): close what holds it open (a termhub session "
                "or editor in a worktree, the personal assistant worker) and retry; "
                "the entries moved so far were put back, nothing changed"
            ) from exc
        moved.append(name)

    tmp = root_p / (POINTER_NAME + ".tmp")
    tmp.write_text(str(dst) + "\n", encoding="utf-8")
    os.replace(tmp, root_p / POINTER_NAME)
    clear_cache()

    for wt in _worktree_links(dst):
        old = src / wt.relative_to(dst)
        (report.repaired if _repair(wt, old) else report.repair_failed).append(str(wt))
    return report


def _rename_back(moved: Path, original: Path) -> bool:
    try:
        os.rename(moved, original)
        return True
    except OSError:
        return False


def _same_filesystem(src: Path, dst: Path) -> bool:
    """Is ``dst`` (or its nearest existing ancestor) on ``src``'s filesystem?"""
    probe = dst
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return os.stat(src).st_dev == os.stat(probe).st_dev
    except OSError:
        return False
