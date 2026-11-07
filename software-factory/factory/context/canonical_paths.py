"""Canonical context paths — single source of truth for what doc files exist.

These constants are referenced VERBATIM from persona prompts. If you rename or
restructure anything in this file, update the persona prompts in
``factory/personas/*.md`` to match exactly.

Rules (enforced by chain handlers in Phase 2+):
  * Every documentation file a persona writes MUST match a pattern in
    ``CANONICAL_CONTEXT_PATHS``.
  * Every documentation file a persona writes MUST NOT match a pattern in
    ``FORBIDDEN_DOC_PATTERNS``.
  * Context is CURRENT-STATE-ONLY: no ADRs, no changelogs, no historical
    archives. The lineage of change lives in directions/, stories/, and git
    history, not in context/.

Paths are evaluated relative to the app repo root — wherever the app's
``app_repo_path`` from ``apps/<name>/config.yaml`` resolves on disk.
"""

from __future__ import annotations

import re

#: Allowed documentation paths inside an app repo. Glob form (``fnmatch`` semantics).
CANONICAL_CONTEXT_PATHS: list[str] = [
    # Top-level app docs
    "prd.md",
    # Canonical context directory
    "context/project.md",
    "context/current-state.md",
    "context/architecture-diagrams.md",
    "context/navigation.md",
    "context/glossary.md",
    "context/sprint-status.yaml",
    "context/modules/*.md",
    # Story records (accumulate per work unit; the only append-only doc location)
    "stories/*.md",
]

#: Documentation paths personas MUST NOT create. The chain handler rejects PRs
#: that introduce any of these. The intent is to keep ``context/`` current-state-
#: only — historical material lives in directions/, stories/, and git.
FORBIDDEN_DOC_PATTERNS: list[str] = [
    "context/decisions/*",
    "context/decisions/**/*",
    "context/changelog.md",
    "context/history.md",
    "context/old-*.md",
    "context/old-*/**",
    "context/archive/*",
    "context/archive/**/*",
    # numbered-ADR conventions, in case someone tries them at the top level
    "docs/decisions/*",
    "docs/adr/*",
]


def _norm(path: str) -> str:
    # Canonicalize: strip leading ./ and any leading slashes; normalize separators.
    p = path.replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    return p


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a gitignore-flavored glob pattern to a regex.

    Semantics:
      * ``*`` matches anything except ``/``.
      * ``**`` matches anything including ``/``.
      * ``?`` matches a single non-``/`` character.
    """
    out: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if i + 1 < n and pattern[i + 1] == "*":
                # ** matches anything, including slashes
                out.append(".*")
                i += 2
            else:
                # * matches anything except /
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


_CANONICAL_REGEXES = [_glob_to_regex(p) for p in CANONICAL_CONTEXT_PATHS]
_FORBIDDEN_REGEXES = [_glob_to_regex(p) for p in FORBIDDEN_DOC_PATTERNS]


def is_canonical_doc_path(path: str) -> bool:
    """Return True if ``path`` matches one of the canonical patterns.

    ``path`` is interpreted relative to the app repo root. Leading ``./`` and
    leading ``/`` are stripped. Glob semantics: ``*`` does NOT cross ``/``;
    ``**`` does.
    """
    p = _norm(path)
    return any(rx.match(p) for rx in _CANONICAL_REGEXES)


def is_forbidden_doc_path(path: str) -> bool:
    """Return True if ``path`` matches one of the explicitly forbidden patterns.

    A path can be BOTH non-canonical AND non-forbidden (e.g. ``README.md``);
    callers should check both. The Phase-2 enforcer rejects a doc write when
    it is non-canonical OR forbidden.
    """
    p = _norm(path)
    return any(rx.match(p) for rx in _FORBIDDEN_REGEXES)
