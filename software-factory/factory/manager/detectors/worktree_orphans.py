"""Detector: worktree_orphans — surface worktrees with no active story.

This module exposes ``worktree_orphans``, which scans the
``state/worktrees/`` directory and cross-references each worktree
against the ``stories`` table in ``state/factory.db``.  The calling
agent decides whether a given DB state indicates the worktree is truly
orphaned (e.g., story is ``done`` or ``cancelled`` but directory still
exists).
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

# Expected pattern: <app>-<story_id>-<slug>
_WORKTREE_PATTERN = re.compile(r"^(?P<app>.+?)-(?P<story_id>\d+)-(?P<slug>.+)$")


def worktree_orphans(*, root: Path) -> list[dict]:
    """Return worktree directories cross-referenced against the stories DB.

    Scans ``state/worktrees/`` for directories whose names match the
    factory naming convention ``<app>-<story_id>-<slug>``.  For each
    directory, queries ``state/factory.db`` to retrieve the story's
    current ``state``.

    Parameters
    ----------
    root:
        Factory root directory.

    Returns
    -------
    list[dict]
        One dict per matching directory:

        * ``path`` — absolute path to the worktree directory (str)
        * ``app`` — app name extracted from the directory name
        * ``story_id`` — integer story ID extracted from the directory
          name
        * ``slug`` — slug portion of the directory name
        * ``db_state`` — current ``state`` column value from the
          ``stories`` table, or ``"missing"`` if no matching row
          exists in the DB

        The calling agent decides whether a particular ``db_state``
        value (e.g., ``"done"``, ``"cancelled"``, or ``"missing"``)
        means the worktree is truly orphaned.

        Returns an empty list when ``state/worktrees/`` does not exist
        or contains no directories matching the naming pattern.
    """
    worktrees_dir = root / "state" / "worktrees"
    if not worktrees_dir.exists():
        return []

    db_path = root / "state" / "factory.db"
    conn: sqlite3.Connection | None = None
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
        except sqlite3.Error:
            conn = None

    results: list[dict] = []
    for entry in sorted(worktrees_dir.iterdir()):
        if not entry.is_dir():
            continue
        m = _WORKTREE_PATTERN.match(entry.name)
        if not m:
            continue
        app = m.group("app")
        story_id = int(m.group("story_id"))
        slug = m.group("slug")

        db_state = "missing"
        if conn is not None:
            try:
                row = conn.execute(
                    "SELECT state FROM stories WHERE id = ?", (story_id,)
                ).fetchone()
                if row is not None:
                    db_state = row[0]
            except sqlite3.Error:
                db_state = "missing"

        results.append(
            {
                "path": str(entry),
                "app": app,
                "story_id": story_id,
                "slug": slug,
                "db_state": db_state,
            }
        )

    if conn is not None:
        conn.close()

    return results
