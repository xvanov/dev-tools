"""Canonical-paths enforcer — the gatekeeper for PR doc files.

Scans the list of paths touched by a PR. For each path, decides whether it
is a doc path under chain control (``context/`` / top-level ``prd.md`` /
``stories/``). Returns violations:

* ``forbidden_path`` — the path matches a ``FORBIDDEN_DOC_PATTERNS`` entry
  (e.g. ``context/decisions/0001-foo.md``).
* ``not_canonical`` — the path is under a doc-rooted prefix but isn't in
  ``CANONICAL_CONTEXT_PATHS`` (e.g. ``context/random_note.md`` or
  ``context/modules/auth/sub.md`` — extra nesting).

Code-only files (everything not under those doc-rooted prefixes) are NOT
checked here. That's not the enforcer's job; the lint/test gates handle
code.
"""

from __future__ import annotations

from typing import NamedTuple

from factory.context.canonical_paths import (
    is_canonical_doc_path,
    is_forbidden_doc_path,
)

# Paths that fall into the "documentation under chain control" universe.
# A path under any of these prefixes (or matching the top-level docs file)
# must match CANONICAL_CONTEXT_PATHS and must not match
# FORBIDDEN_DOC_PATTERNS. Anything else is a code change — out of scope.
_DOC_PREFIXES: tuple[str, ...] = ("context/", "stories/")
_DOC_TOPLEVEL_FILES: tuple[str, ...] = ("prd.md",)


class CanonicalPathViolation(NamedTuple):
    """A single PR-file violation discovered by the enforcer."""

    path: str
    reason: str  # "forbidden_path" | "not_canonical"


def _norm(p: str) -> str:
    s = p.replace("\\", "/")
    if s.startswith("./"):
        s = s[2:]
    return s.lstrip("/")


def _is_doc_path(path: str) -> bool:
    """Is ``path`` under chain doc control? (context/, stories/, prd.md)."""
    p = _norm(path)
    if p in _DOC_TOPLEVEL_FILES:
        return True
    return any(p.startswith(prefix) for prefix in _DOC_PREFIXES)


def scan_pr_diff(diff_files: list[str]) -> list[CanonicalPathViolation]:
    """Return a list of violations for the given PR-touched paths.

    Empty list = clean PR. Code files (anything not under ``context/``,
    ``stories/``, or top-level ``prd.md``) are ignored.
    """
    violations: list[CanonicalPathViolation] = []
    for raw in diff_files:
        p = _norm(raw)
        if not _is_doc_path(p):
            continue  # not our concern
        if is_forbidden_doc_path(p):
            violations.append(CanonicalPathViolation(path=p, reason="forbidden_path"))
            continue
        if not is_canonical_doc_path(p):
            violations.append(CanonicalPathViolation(path=p, reason="not_canonical"))
    return violations


def format_violation_comment(violations: list[CanonicalPathViolation]) -> str:
    """Build the PR comment body for a non-empty violation list.

    The comment names every offending path and links to the relevant section
    of the implementation plan so a human reviewer can act on it without a
    factory CLI handy.
    """
    if not violations:
        return ""
    lines: list[str] = []
    lines.append("**Canonical-paths violation.** This PR writes documentation outside")
    lines.append("the canonical context layout. The factory blocks merging until the")
    lines.append("offending paths are moved or removed.")
    lines.append("")
    lines.append("| path | reason |")
    lines.append("| --- | --- |")
    for v in violations:
        reason_label = {
            "forbidden_path": "forbidden (no ADRs / changelogs / archives)",
            "not_canonical": "not in `CANONICAL_CONTEXT_PATHS`",
        }.get(v.reason, v.reason)
        lines.append(f"| `{v.path}` | {reason_label} |")
    lines.append("")
    lines.append("Canonical doc paths are documented in")
    lines.append("`factory/context/canonical_paths.py` and in the plan section")
    lines.append("**Canonical context locations**. Move new docs into the canonical")
    lines.append("layout (current-state-only — no historical files), or drop them.")
    return "\n".join(lines)
