"""Context updater rejects forbidden / non-canonical paths."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.context.updater import (
    ContextUpdate,
    ForbiddenContextPathError,
    apply_context_updates,
)


def test_canonical_paths_succeed(tmp_path: Path) -> None:
    updates = [
        ContextUpdate(path="context/project.md", action="create", content="# Project\n"),
        ContextUpdate(path="context/modules/auth.md", action="create", content="# Auth\n"),
        ContextUpdate(path="stories/1-init.md", action="create", content="# Story 1\n"),
    ]
    apply_context_updates(updates, tmp_path)

    assert (tmp_path / "context" / "project.md").read_text() == "# Project\n"
    assert (tmp_path / "context" / "modules" / "auth.md").read_text() == "# Auth\n"
    assert (tmp_path / "stories" / "1-init.md").read_text() == "# Story 1\n"


def test_forbidden_decisions_path_rejected(tmp_path: Path) -> None:
    updates = [
        ContextUpdate(path="context/decisions/0001-stack.md", action="create", content="# ADR\n")
    ]
    with pytest.raises(ForbiddenContextPathError) as exc_info:
        apply_context_updates(updates, tmp_path)
    assert "FORBIDDEN_DOC_PATTERNS" in str(exc_info.value.reason)
    assert not (tmp_path / "context").exists() or not (tmp_path / "context" / "decisions").exists()


def test_forbidden_changelog_rejected(tmp_path: Path) -> None:
    updates = [ContextUpdate(path="context/changelog.md", action="create", content="# x\n")]
    with pytest.raises(ForbiddenContextPathError):
        apply_context_updates(updates, tmp_path)


def test_non_canonical_random_path_rejected(tmp_path: Path) -> None:
    updates = [ContextUpdate(path="context/random-thing.md", action="create", content="# x\n")]
    with pytest.raises(ForbiddenContextPathError) as exc_info:
        apply_context_updates(updates, tmp_path)
    assert "CANONICAL_CONTEXT_PATHS" in str(exc_info.value.reason)


def test_rewrite_replaces_existing(tmp_path: Path) -> None:
    apply_context_updates(
        [ContextUpdate(path="context/project.md", action="create", content="# v1\n")],
        tmp_path,
    )
    apply_context_updates(
        [ContextUpdate(path="context/project.md", action="rewrite", content="# v2\n")],
        tmp_path,
    )
    assert (tmp_path / "context" / "project.md").read_text() == "# v2\n"


def test_transactional_validation_no_partial_writes(tmp_path: Path) -> None:
    """If ANY update is invalid, NO writes happen."""
    updates = [
        ContextUpdate(path="context/project.md", action="create", content="# OK\n"),
        ContextUpdate(path="context/decisions/0001.md", action="create", content="# bad\n"),
    ]
    with pytest.raises(ForbiddenContextPathError):
        apply_context_updates(updates, tmp_path)
    # The first (canonical) update must not have been applied.
    assert not (tmp_path / "context" / "project.md").exists()
