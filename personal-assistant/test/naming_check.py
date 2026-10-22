"""Capture file naming (audio/naming.py). Run by test/naming.test.js.

The property protected: a capture file is never opened for writing twice,
and process.py reads the same start time from a name that capture wrote.
"""
import datetime as dt
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "audio"))
import naming  # noqa: E402

slot = dt.datetime(2026, 9, 1, 10, 15)

# On the boundary: the slot's own name, as before.
assert naming.stem_for(slot, slot + dt.timedelta(seconds=1)) == "20260901T1015"
# Mid-slot (an early roll, a device change, an unpause): the real start.
assert naming.stem_for(slot, slot + dt.timedelta(minutes=7, seconds=3)) == "20260901T102203"

# Both forms, and a suffixed one, parse back to when the audio started.
assert naming.started_at("20260901T1015") == slot
assert naming.started_at("20260901T102203") == dt.datetime(2026, 9, 1, 10, 22, 3)
assert naming.started_at("20260901T102203-2") == dt.datetime(2026, 9, 1, 10, 22, 3)
assert naming.started_at("20260901T1015-loopback.speech") is None
assert naming.started_at("notes") is None

with tempfile.TemporaryDirectory() as d:
    first = naming.unused_path(d, "20260901T1015")
    assert os.path.basename(first) == "20260901T1015.wav"
    open(first, "wb").close()
    # A reopen in the same slot must not truncate the finished file.
    second = naming.unused_path(d, "20260901T1015")
    assert os.path.basename(second) == "20260901T1015-2.wav", second
    # A raw file already processed and deleted leaves its .processed marker;
    # a new file under that name would be skipped forever.
    open(os.path.join(d, "20260901T1030.processed"), "w").close()
    assert os.path.basename(naming.unused_path(d, "20260901T1030")) == "20260901T1030-2.wav"

    # The roll file: requested only when touched after the file was opened,
    # and a missing file is never a request.
    flag = os.path.join(d, "audio.roll")
    assert naming.roll_requested(flag, time.time()) is False
    opened = time.time() - 5
    with open(flag, "w") as fh:
        fh.write("x")
    assert naming.roll_requested(flag, opened) is True
    assert naming.roll_requested(flag, time.time() + 5) is False

print("naming ok")
