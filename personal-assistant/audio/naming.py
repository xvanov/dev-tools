"""Capture file names: the one place that says what a name means.

Standard library only, so capture.py, process.py and the tests can all import
it without the audio stack.

A capture file is named by the local time its first sample was written:

    20261022T1015.wav          a file opened on its 15-minute slot boundary
    20261022T101207.wav        a file opened mid-slot (an early roll before a
                               meeting debrief, a device change, an unpause)
    20261022T101207-2.wav      the same second taken already

Mid-slot files used to reuse the slot's name. That put every timestamp in
the file up to fifteen minutes early, and a reopen after a headphone switch
truncated the first part of the slot — opening the same path for writing
again. A name now always says when its audio starts, and is never reused.
"""
from __future__ import annotations

import datetime as dt
import os
import re

# Within this many seconds of the slot boundary, a file is "on the boundary".
ON_BOUNDARY_S = 2.0

_STEM = re.compile(r"^(\d{8}T\d{4})(\d{2})?(?:-\d+)?$")


def stem_for(slot: dt.datetime, now: dt.datetime) -> str:
    """The name (without extension) for a file opened at `now` in `slot`."""
    if 0 <= (now - slot).total_seconds() < ON_BOUNDARY_S:
        return slot.strftime("%Y%m%dT%H%M")
    return now.strftime("%Y%m%dT%H%M%S")


def unused_path(directory: str, stem: str, ext: str = ".wav") -> str:
    """`directory/stem.ext`, or `stem-2.ext`, `stem-3.ext`… if that exists.

    An existing file is never opened for writing again: it may be a finished
    slot waiting for process.py, and mode "w" would empty it.
    """
    def taken(s: str) -> bool:
        # The raw file goes after six hours; its .processed marker stays, and
        # a new file under that name would be skipped as already done.
        p = os.path.join(directory, s)
        return any(os.path.exists(p + suffix) for suffix in (ext, ext + ".done", ".processed"))

    candidate, n = stem, 2
    while taken(candidate):
        candidate = f"{stem}-{n}"
        n += 1
    return os.path.join(directory, candidate + ext)


def started_at(stem: str) -> dt.datetime | None:
    """Local start time a capture file's stem names, or None if it names none."""
    m = _STEM.match(stem)
    if not m:
        return None
    fmt = "%Y%m%dT%H%M%S" if m.group(2) else "%Y%m%dT%H%M"
    try:
        return dt.datetime.strptime(m.group(1) + (m.group(2) or ""), fmt)
    except ValueError:
        return None


def roll_requested(roll_file: str, opened_at: float) -> bool:
    """True when the roll file was touched after the current file was opened.

    Compared by mtime and never deleted here: the mic and loopback captures
    both read it, and the first one to delete it would hide it from the other.
    """
    try:
        return os.path.getmtime(roll_file) > opened_at
    except OSError:
        return False
