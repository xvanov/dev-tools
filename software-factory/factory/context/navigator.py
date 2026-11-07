"""Parser for ``context/navigation.md``.

Navigation files are written by personas (template in
``factory/artifacts/navigation_template.md``). They have sections of the form::

    ## When working on auth
    - context/modules/auth.md
    - context/current-state.md

    ## For task: payments
    - context/modules/payments.md

This module parses such files into a list of ``(scope_label, [file_paths])``
tuples. Callers (loader.py, future enforcer) match a query against each
``scope_label`` to find the relevant references.
"""

from __future__ import annotations

import re

_HEADING_RE = re.compile(
    r"^\s*##\s+(?:When working on|For task:|For module:|When touching)\s+(.+?)\s*$",
    re.IGNORECASE,
)
# Single-line shorthand: "## When working on auth → read: context/modules/auth.md, context/current-state.md"
_INLINE_REFS_RE = re.compile(r"(?:→|->)\s*read:\s*(.+)$", re.IGNORECASE)
# Bullet list entries: "- context/modules/auth.md" or "* context/modules/auth.md"
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$")


def parse_navigation(text: str) -> list[tuple[str, list[str]]]:
    """Parse navigation.md text into ``[(scope_label, [paths])]``.

    Robust to:
      * inline shorthand "## ... → read: path1, path2"
      * bulleted lists under a heading
      * headings without any references (returned with empty list)

    Lines outside any matched heading are ignored. ``scope_label`` is the
    text captured after the heading prefix, trimmed.
    """
    sections: list[tuple[str, list[str]]] = []
    current_label: str | None = None
    current_paths: list[str] = []

    def flush() -> None:
        nonlocal current_label, current_paths
        if current_label is not None:
            sections.append((current_label, current_paths))
        current_label = None
        current_paths = []

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        heading = _HEADING_RE.match(line)
        if heading:
            flush()
            label = heading.group(1).strip()
            # Strip any trailing inline-arrow part out of the label
            inline = _INLINE_REFS_RE.search(label)
            paths_inline: list[str] = []
            if inline:
                # Re-extract the actual scope (text before the arrow)
                label = re.sub(r"\s*(?:→|->).*$", "", label).strip()
                paths_inline = [p.strip() for p in inline.group(1).split(",") if p.strip()]
            current_label = label
            current_paths = list(paths_inline)
            continue

        # Inline-arrow style where the arrow appears within the heading line we just
        # processed: already handled above. We still want to support
        # multi-line bullet style under the heading.
        if current_label is None:
            continue

        bullet = _BULLET_RE.match(line)
        if bullet:
            # Strip any inline comment/arrow text after a path
            entry = bullet.group(1).strip()
            # If a bullet has "path - description", keep only first whitespace-delimited word? No —
            # paths can be arbitrary; only split on common separators if obviously a list.
            for piece in re.split(r"[,;]", entry):
                piece = piece.strip()
                if piece:
                    current_paths.append(piece)

    flush()
    return sections
