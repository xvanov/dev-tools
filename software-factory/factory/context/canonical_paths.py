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

The context root is per app: ``AppConfig.context_dir`` (default ``context``),
relative to the app repo root. Every consumer builds its paths here
(``context_path`` / ``canonical_context_paths`` / ``forbidden_doc_patterns`` /
``context_files``) instead of spelling ``context/`` itself; a test pins that.
The module-level constants below are the DEFAULT-root forms.

Paths are evaluated relative to the app repo root — wherever the app's
``app_repo_path`` from ``apps/<name>/config.yaml`` resolves on disk.
"""

from __future__ import annotations

import re
from functools import lru_cache

#: The default context root (``AppConfig.context_dir`` default).
DEFAULT_CONTEXT_DIR = "context"

#: Context files the onboarder / docs chain produces, relative to the context root.
CONTEXT_CORE_FILES: tuple[str, ...] = (
    "project.md",
    "current-state.md",
    "navigation.md",
    "glossary.md",
    "architecture-diagrams.md",
    "sprint-status.yaml",
)

#: Canonical patterns inside the context root (glob form).
_CANONICAL_IN_CONTEXT: tuple[str, ...] = (
    "project.md",
    "current-state.md",
    "architecture-diagrams.md",
    "navigation.md",
    "glossary.md",
    "sprint-status.yaml",
    "modules/*.md",
)

#: Forbidden patterns inside the context root (glob form).
_FORBIDDEN_IN_CONTEXT: tuple[str, ...] = (
    "decisions/*",
    "decisions/**/*",
    "changelog.md",
    "history.md",
    "old-*.md",
    "old-*/**",
    "archive/*",
    "archive/**/*",
)

#: Forbidden outside the context root (numbered-ADR conventions at the top level).
_FORBIDDEN_TOPLEVEL: tuple[str, ...] = ("docs/decisions/*", "docs/adr/*")


def normalize_context_dir(context_dir: str | None) -> str:
    """Canonical form of a context root: forward slashes, no ``./``, no edge slashes.

    Empty / ``None`` means the default. ``..`` segments are rejected: the root must
    stay inside the app repo.
    """
    s = (context_dir or "").strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    s = s.strip("/")
    if not s or s == ".":
        return DEFAULT_CONTEXT_DIR
    if any(seg == ".." for seg in s.split("/")):
        raise ValueError(f"context_dir must stay inside the app repo: {context_dir!r}")
    return s


def context_path(context_dir: str | None, rel: str = "") -> str:
    """``<context_dir>/<rel>`` as a repo-relative posix path (``rel`` may be empty)."""
    root = normalize_context_dir(context_dir)
    rel = rel.replace("\\", "/").lstrip("/")
    return f"{root}/{rel}" if rel else root


def context_files(context_dir: str | None = None) -> list[str]:
    """The core context files (project, current-state, navigation, ...) under the root."""
    return [context_path(context_dir, f) for f in CONTEXT_CORE_FILES]


def canonical_context_paths(context_dir: str | None = None) -> list[str]:
    """Allowed documentation globs for an app whose context root is ``context_dir``."""
    return [
        "prd.md",
        *(context_path(context_dir, p) for p in _CANONICAL_IN_CONTEXT),
        "stories/*.md",
    ]


def forbidden_doc_patterns(context_dir: str | None = None) -> list[str]:
    """Forbidden documentation globs for an app whose context root is ``context_dir``."""
    return [*(context_path(context_dir, p) for p in _FORBIDDEN_IN_CONTEXT), *_FORBIDDEN_TOPLEVEL]


#: Allowed documentation paths inside an app repo (default root). Glob form.
CANONICAL_CONTEXT_PATHS: list[str] = canonical_context_paths()

#: Documentation paths personas MUST NOT create. The chain handler rejects PRs
#: that introduce any of these. The intent is to keep ``context/`` current-state-
#: only — historical material lives in directions/, stories/, and git.
FORBIDDEN_DOC_PATTERNS: list[str] = forbidden_doc_patterns()


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


@lru_cache(maxsize=64)
def _regexes_for(context_dir: str) -> tuple[list[re.Pattern[str]], list[re.Pattern[str]]]:
    return (
        [_glob_to_regex(p) for p in canonical_context_paths(context_dir)],
        [_glob_to_regex(p) for p in forbidden_doc_patterns(context_dir)],
    )


def is_canonical_doc_path(path: str, context_dir: str | None = None) -> bool:
    """Return True if ``path`` matches one of the canonical patterns.

    ``path`` is interpreted relative to the app repo root. Leading ``./`` and
    leading ``/`` are stripped. Glob semantics: ``*`` does NOT cross ``/``;
    ``**`` does.
    """
    p = _norm(path)
    return any(rx.match(p) for rx in _regexes_for(normalize_context_dir(context_dir))[0])


def is_forbidden_doc_path(path: str, context_dir: str | None = None) -> bool:
    """Return True if ``path`` matches one of the explicitly forbidden patterns.

    A path can be BOTH non-canonical AND non-forbidden (e.g. ``README.md``);
    callers should check both. The Phase-2 enforcer rejects a doc write when
    it is non-canonical OR forbidden.
    """
    p = _norm(path)
    return any(rx.match(p) for rx in _regexes_for(normalize_context_dir(context_dir))[1])
