"""Tests for ``factory.context.enforcer.scan_pr_diff``.

Exhaustive coverage — these are the rules the chain ENFORCES on every PR,
so a single false-positive or false-negative blocks legitimate work or
admits forbidden doc files.
"""

from __future__ import annotations

from factory.context.enforcer import (
    CanonicalPathViolation,
    format_violation_comment,
    scan_pr_diff,
)


def test_code_files_are_not_doc_violations() -> None:
    """Pure code paths must be ignored entirely by the enforcer."""
    files = [
        "src/app.py",
        "app/models/pledge.py",
        "tests/test_pledge.py",
        "e2e/pledge.spec.ts",
        "Dockerfile",
        ".github/workflows/ci.yml",
        "Makefile",
    ]
    assert scan_pr_diff(files) == []


def test_canonical_doc_paths_pass() -> None:
    files = [
        "prd.md",
        "context/project.md",
        "context/current-state.md",
        "context/architecture-diagrams.md",
        "context/navigation.md",
        "context/glossary.md",
        "context/sprint-status.yaml",
        "context/modules/auth.md",
        "context/modules/payments.md",
        "stories/42-pledge-transfer.md",
    ]
    assert scan_pr_diff(files) == []


def test_forbidden_decisions_dir_is_violation() -> None:
    violations = scan_pr_diff(["context/decisions/0001-stack.md"])
    # Forbidden takes precedence over not_canonical.
    assert violations == [
        CanonicalPathViolation(path="context/decisions/0001-stack.md", reason="forbidden_path")
    ]


def test_forbidden_decisions_subdir_is_violation() -> None:
    violations = scan_pr_diff(["context/decisions/2026/0042-pivot.md"])
    assert len(violations) == 1
    assert violations[0].reason == "forbidden_path"


def test_changelog_is_forbidden() -> None:
    violations = scan_pr_diff(["context/changelog.md"])
    assert violations == [
        CanonicalPathViolation(path="context/changelog.md", reason="forbidden_path")
    ]


def test_history_is_forbidden() -> None:
    violations = scan_pr_diff(["context/history.md"])
    assert violations == [
        CanonicalPathViolation(path="context/history.md", reason="forbidden_path")
    ]


def test_old_prefix_is_forbidden() -> None:
    violations = scan_pr_diff(["context/old-auth.md"])
    assert violations[0].reason == "forbidden_path"


def test_archive_is_forbidden() -> None:
    violations = scan_pr_diff(["context/archive/whatever.md"])
    assert violations[0].reason == "forbidden_path"


def test_random_note_under_context_is_not_canonical() -> None:
    """A non-forbidden doc file under context/ that isn't in the canonical
    list is flagged with reason=not_canonical."""
    violations = scan_pr_diff(["context/random_note.md"])
    assert violations == [
        CanonicalPathViolation(path="context/random_note.md", reason="not_canonical")
    ]


def test_extra_nesting_in_modules_is_not_canonical() -> None:
    """``context/modules/auth/sub.md`` violates because the canonical glob
    is ``context/modules/*.md`` — single-level only, no sub-directories."""
    violations = scan_pr_diff(["context/modules/auth/sub.md"])
    assert violations == [
        CanonicalPathViolation(path="context/modules/auth/sub.md", reason="not_canonical")
    ]


def test_stories_subdir_extra_nesting_is_not_canonical() -> None:
    violations = scan_pr_diff(["stories/42/notes.md"])
    assert violations == [
        CanonicalPathViolation(path="stories/42/notes.md", reason="not_canonical")
    ]


def test_mixed_pr_only_doc_files_flagged() -> None:
    """A PR with code + canonical docs + one bad doc should only report the bad doc."""
    files = [
        "src/app.py",
        "tests/test_app.py",
        "context/current-state.md",  # canonical — OK
        "context/decisions/0001-foo.md",  # forbidden
        "context/notes.md",  # not canonical
    ]
    violations = scan_pr_diff(files)
    paths = {v.path for v in violations}
    assert paths == {"context/decisions/0001-foo.md", "context/notes.md"}
    by_path = {v.path: v.reason for v in violations}
    assert by_path["context/decisions/0001-foo.md"] == "forbidden_path"
    assert by_path["context/notes.md"] == "not_canonical"


def test_leading_slash_and_dot_slash_normalized() -> None:
    """Common diff representations: ``./context/x.md`` and ``/context/x.md``."""
    v1 = scan_pr_diff(["./context/decisions/x.md"])
    v2 = scan_pr_diff(["/context/decisions/x.md"])
    assert v1[0].reason == "forbidden_path"
    assert v2[0].reason == "forbidden_path"


def test_format_violation_comment_lists_each_violation() -> None:
    violations = [
        CanonicalPathViolation(path="context/decisions/x.md", reason="forbidden_path"),
        CanonicalPathViolation(path="context/random.md", reason="not_canonical"),
    ]
    body = format_violation_comment(violations)
    # Verify the comment is real markdown that names every offending path
    # and the reason in human-readable form.
    assert "context/decisions/x.md" in body
    assert "context/random.md" in body
    assert "forbidden" in body.lower()
    assert "not in" in body or "not_canonical" in body or "CANONICAL_CONTEXT_PATHS" in body
    # Comment should reference the canonical-paths module so a human reviewer
    # can find the rules without the factory CLI handy.
    assert "canonical_paths" in body or "Canonical context" in body


def test_format_violation_comment_empty_on_no_violations() -> None:
    assert format_violation_comment([]) == ""
