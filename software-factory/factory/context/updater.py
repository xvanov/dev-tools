"""Apply persona-emitted context updates to an app repo.

Phase-0 scope is intentionally minimal: a typed list of updates is applied
directly to the filesystem after validating every target path against the
canonical-paths whitelist + the forbidden-paths blacklist. Phase 2 will wire
this to actual persona output parsing.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from factory.context.canonical_paths import is_canonical_doc_path, is_forbidden_doc_path

Action = Literal["create", "rewrite"]


class ForbiddenContextPathError(ValueError):
    """Raised when a context update targets a non-canonical or forbidden path."""

    def __init__(self, path: str, reason: str) -> None:
        super().__init__(f"{path}: {reason}")
        self.path = path
        self.reason = reason


@dataclass(frozen=True)
class ContextUpdate:
    """A single context-file change.

    Attributes:
      path: repo-relative path, e.g. ``context/modules/auth.md``.
      action: ``"create"`` (file must not exist) or ``"rewrite"`` (file may exist).
      content: full file content. Updater always writes the file whole — no
        line-level patching. Context is current-state-only; rewriting the whole
        file is the intended semantics.
    """

    path: str
    action: Action
    content: str


def apply_context_updates(updates: list[ContextUpdate], app_repo_path: Path) -> None:
    """Apply ``updates`` under ``app_repo_path``.

    For every update, FIRST validate the path; raise
    ``ForbiddenContextPathError`` and apply NOTHING if any update fails
    validation (transactional in spirit — we want partial-write failures to be
    a separate, later-phase concern).

    For ``action="create"``, the existing-file check is best-effort: a path that
    already exists raises ``FileExistsError``.
    """
    repo = Path(app_repo_path)

    # Validate all paths first; bail before writing if any fail.
    for upd in updates:
        if is_forbidden_doc_path(upd.path):
            raise ForbiddenContextPathError(
                upd.path,
                "path matches FORBIDDEN_DOC_PATTERNS (no ADRs, no changelogs, no history files)",
            )
        if not is_canonical_doc_path(upd.path):
            raise ForbiddenContextPathError(
                upd.path,
                "path is not in CANONICAL_CONTEXT_PATHS (docs must live in the canonical layout)",
            )

    # Apply.
    for upd in updates:
        target = repo / upd.path
        target.parent.mkdir(parents=True, exist_ok=True)
        if upd.action == "create" and target.exists():
            raise FileExistsError(f"create requested but path exists: {upd.path}")
        target.write_text(upd.content, encoding="utf-8")
