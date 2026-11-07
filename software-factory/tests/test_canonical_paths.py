"""Canonical / forbidden context-path matching."""

from __future__ import annotations

import pytest

from factory.context.canonical_paths import (
    CANONICAL_CONTEXT_PATHS,
    FORBIDDEN_DOC_PATTERNS,
    is_canonical_doc_path,
    is_forbidden_doc_path,
)


@pytest.mark.parametrize(
    "path",
    [
        "prd.md",
        "context/project.md",
        "context/current-state.md",
        "context/architecture-diagrams.md",
        "context/navigation.md",
        "context/glossary.md",
        "context/sprint-status.yaml",
        "context/modules/auth.md",
        "context/modules/payments.md",
        "context/modules/api.md",
        "stories/1-add-healthz.md",
        "stories/42-some-slug.md",
        # leading ./ and / should normalize
        "./context/project.md",
        "/context/project.md",
    ],
)
def test_canonical_paths_accept(path: str) -> None:
    assert is_canonical_doc_path(path), f"expected canonical: {path}"


@pytest.mark.parametrize(
    "path",
    [
        "context/decisions/0001-stack-choice.md",
        "context/decisions/nested/foo.md",
        "context/changelog.md",
        "context/history.md",
        "context/old-arch.md",
        "context/archive/2024.md",
        "docs/decisions/0001-foo.md",
        "docs/adr/0001-foo.md",
    ],
)
def test_forbidden_paths_match(path: str) -> None:
    assert is_forbidden_doc_path(path), f"expected forbidden: {path}"


@pytest.mark.parametrize(
    "path",
    [
        "context/decisions/0001-stack-choice.md",  # also forbidden, but importantly NOT canonical
        "context/changelog.md",
        "context/modules/auth/extra.md",  # nested under modules — not a flat *.md
        "context/some-random.md",
        "context/modules/",  # directory, not a *.md
        "src/main.py",  # code is not a doc path; canonical check returns False
    ],
)
def test_non_canonical_paths_reject(path: str) -> None:
    assert not is_canonical_doc_path(path), f"expected NOT canonical: {path}"


def test_constants_nonempty() -> None:
    assert CANONICAL_CONTEXT_PATHS, "CANONICAL_CONTEXT_PATHS must list at least one pattern"
    assert FORBIDDEN_DOC_PATTERNS, "FORBIDDEN_DOC_PATTERNS must list at least one pattern"
