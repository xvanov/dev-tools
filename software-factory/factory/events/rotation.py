"""factory.events.rotation — size-based NDJSON rotation + efficient tail reads.

The FMS event streams (``state/events/*.ndjson``) are append-only and were
never rotated, so a hot stream (e.g. ``watcher_notes.ndjson``) grew to tens
of megabytes and every summarizer/watcher cycle linearly scanned the whole
file. This module provides two independent primitives:

* :func:`rotate_if_needed` — called on the APPEND path. When a stream exceeds
  ``max_bytes`` it rolls ``path -> path.1 -> path.2 ...`` keeping at most
  ``keep`` historical segments and dropping the oldest. Rotation applies
  going forward only; it never deletes the live file's data (that becomes
  ``path.1``).
* :func:`read_tail_lines` / :func:`read_tail_bytes` — read only the END of a
  possibly-huge file, so the hot read paths bound their work regardless of
  total file size.

All functions are defensive: I/O failures degrade to a no-op / empty result
rather than raising, because these sit on the factory's telemetry path and
must never take down a tick or a manager cycle.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Default rotation threshold: 25 MB. A stream past this is well beyond any
# lookback window the summarizer/watcher actually reads.
_DEFAULT_MAX_BYTES = 25_000_000

# Default number of historical segments to retain (path.1 .. path.N).
_DEFAULT_KEEP = 3

# Chunk size for backward tail reads.
_TAIL_CHUNK = 64 * 1024


def rotate_if_needed(
    path: str | Path,
    max_bytes: int = _DEFAULT_MAX_BYTES,
    keep: int = _DEFAULT_KEEP,
) -> bool:
    """Roll ``path`` if it exceeds ``max_bytes``; keep at most ``keep`` segments.

    The live file becomes ``path.1``; an existing ``path.1`` shifts to
    ``path.2`` and so on. Any segment index above ``keep`` is dropped (the
    oldest data is lost, which is the intended bound). The live ``path`` is
    left absent after rotation; the next append (opened in ``"a"`` mode)
    recreates it, avoiding a cross-process truncate race.

    Returns ``True`` when a rotation happened, ``False`` otherwise (file
    missing, under threshold, or an I/O error — all treated as "no rotation").
    Never raises.
    """
    p = Path(path)
    try:
        if not p.exists():
            return False
        if p.stat().st_size <= max_bytes:
            return False
    except OSError:
        return False

    if keep < 1:
        # No history retained: just truncate the live file.
        try:
            p.write_text("", encoding="utf-8")
            return True
        except OSError as exc:  # pragma: no cover - defensive
            print(f"[rotation] truncate failed for {p}: {exc}", file=sys.stderr)
            return False

    try:
        # Drop the oldest segment if it would be pushed past ``keep``.
        oldest = p.with_name(f"{p.name}.{keep}")
        if oldest.exists():
            oldest.unlink()

        # Shift path.(k-1) -> path.k for k = keep .. 2.
        for idx in range(keep - 1, 0, -1):
            src = p.with_name(f"{p.name}.{idx}")
            if src.exists():
                dst = p.with_name(f"{p.name}.{idx + 1}")
                os.replace(src, dst)

        # Live file becomes path.1. We deliberately do NOT recreate an empty
        # live file here: append-path writers open the stream in "a" mode,
        # which recreates a missing file on the next write. Recreating it via
        # write_text("") opens a cross-process TOCTOU window — the tick and the
        # manager daemon both append to shared streams, and a concurrent append
        # landing between os.replace and the recreate would be truncated away.
        # Leaving the file absent lets the next append recreate it losslessly.
        os.replace(p, p.with_name(f"{p.name}.1"))
        return True
    except OSError as exc:
        print(f"[rotation] rotate failed for {p}: {exc}", file=sys.stderr)
        return False


def read_tail_bytes(path: str | Path, max_bytes: int) -> str:
    """Return the last ``max_bytes`` bytes of ``path`` decoded as UTF-8.

    Reads only the tail (seeks from the end), so cost is bounded by
    ``max_bytes`` regardless of total file size. If the file is smaller than
    ``max_bytes`` the whole file is returned. A partial leading line (from
    cutting mid-line) is dropped so the caller always sees whole lines, EXCEPT
    when the read started at offset 0 (the true beginning of the file).
    Returns ``""`` on any error or missing file. Never raises.
    """
    p = Path(path)
    if max_bytes <= 0:
        return ""
    try:
        size = p.stat().st_size
    except OSError:
        return ""
    start = max(0, size - max_bytes)
    try:
        with p.open("rb") as fh:
            fh.seek(start)
            data = fh.read()
    except OSError:
        return ""
    text = data.decode("utf-8", "replace")
    if start > 0:
        # Drop the (likely partial) first line — we seeked into the middle.
        nl = text.find("\n")
        text = text[nl + 1 :] if nl != -1 else ""
    return text


def read_tail_lines(path: str | Path, max_lines: int) -> list[str]:
    """Return the last ``max_lines`` non-empty lines of ``path``, in order.

    Reads the file backward in chunks so only the tail is touched — a 57 MB
    stream costs a few 64 KB reads, not a full scan. Lines are returned
    oldest-first (chronological, matching file order) with trailing newlines
    stripped. Blank lines are skipped. Returns ``[]`` on any error or missing
    file. Never raises.
    """
    p = Path(path)
    if max_lines <= 0:
        return []
    try:
        size = p.stat().st_size
    except OSError:
        return []
    if size == 0:
        return []

    try:
        with p.open("rb") as fh:
            buf = b""
            pos = size
            # +1 so we can detect whether we've consumed the whole file and
            # therefore whether the first fragment is a complete line.
            while pos > 0 and buf.count(b"\n") <= max_lines:
                read_size = min(_TAIL_CHUNK, pos)
                pos -= read_size
                fh.seek(pos)
                buf = fh.read(read_size) + buf
    except OSError:
        return []

    text = buf.decode("utf-8", "replace")
    lines = [ln for ln in text.split("\n") if ln.strip()]
    return lines[-max_lines:]
