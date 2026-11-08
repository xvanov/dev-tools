"""Where a factory root keeps its runtime state (``state/``).

Historically ``<factory root>/state``. For the installed factory that is
inside the target repo's own checkout when the factory lives in it (the
dev-tools monorepo), so every story worktree, agent run dir and job
workspace sat under the live checkout the stacks run from: an agent could
climb from its cwd into live PA / termhub / factory code (2026-11-08). The
state now lives outside the repo.

Resolution for a root (cached per process):

1. The pointer file ``<root>/.state-dir`` (one absolute path), written by
   ``factory state migrate``. Every process that knows the root (serve, the
   CLI the personal assistant runs, scripts) finds the same place without
   any environment.
2. ``<root>/state`` — a root that was never migrated (tests, bench, fresh
   clones before ``factory state migrate``).

There is deliberately no environment override: an inherited variable would
follow serve's children into a story worktree or staging clone of the
factory's own repo (whose package root is that copy) and point it at the
live state. The pointer is per checkout, so a copy never has one.

The default migration target is :func:`default_external_dir`:
``%LOCALAPPDATA%\\software-factory\\state`` on Windows,
``${XDG_DATA_HOME:-~/.local/share}/software-factory/state`` elsewhere.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

POINTER_NAME = ".state-dir"

#: The software-factory directory this package was imported from.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]

_cache: dict[str, Path] = {}


def default_external_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "software-factory" / "state"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "software-factory" / "state"


def pointer_path(root: Path | str) -> Path:
    return Path(root) / POINTER_NAME


def read_pointer(root: Path | str) -> Path | None:
    try:
        text = pointer_path(root).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not text:
        return None
    p = Path(text).expanduser()
    return p if p.is_absolute() else None


def state_dir(root: Path | str) -> Path:
    """The runtime-state directory of factory root ``root``."""
    r = Path(root)
    key = os.path.abspath(r)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    resolved = read_pointer(r) or (r / "state")
    _cache[key] = resolved
    return resolved


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def root_for_db(db_path: Path | str) -> Path:
    """The factory root whose state holds ``db_path`` (``<state>/factory.db``).

    ``db_path.parent.parent`` stops being the root once the state is outside the
    repo, so the installed root's state dir is recognised first. Otherwise the
    directory above a ``state`` dir, else the database's own directory.
    """
    state = Path(db_path).parent
    if _same(state, state_dir(PACKAGE_ROOT)):
        return PACKAGE_ROOT
    return state.parent if state.name == "state" else state


def is_external(root: Path | str) -> bool:
    """Is ``root``'s state outside ``<root>/state``?"""
    return state_dir(root) != Path(root) / "state"


def clear_cache() -> None:
    _cache.clear()
