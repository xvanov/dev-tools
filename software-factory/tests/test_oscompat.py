"""factory.oscompat: portable locks and process helpers (POSIX and Windows)."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest

from factory import oscompat

_HOLD_LOCK = """
import sys, time
sys.path.insert(0, {root!r})
from factory.oscompat import lock_file
f = open({path!r}, "a+")
lock_file(f)
print("held", flush=True)
time.sleep(30)
"""


def _root() -> str:
    return str(Path(__file__).resolve().parents[1])


def test_lock_is_exclusive_across_processes_and_released_on_death(tmp_path: Path) -> None:
    path = tmp_path / "x.lock"
    holder = subprocess.Popen(
        [sys.executable, "-c", _HOLD_LOCK.format(root=_root(), path=str(path))],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "held"
        with path.open("a+") as fh, pytest.raises(BlockingIOError):
            oscompat.lock_file(fh, blocking=False)
    finally:
        holder.kill()
        holder.wait(timeout=10)
    # The holder died without unlocking: no stale lock.
    deadline = time.monotonic() + 5
    with path.open("a+") as fh:
        while True:
            try:
                oscompat.lock_file(fh, blocking=False)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)
        oscompat.unlock_file(fh)


def test_lock_does_not_block_reading_and_writing_the_file(tmp_path: Path) -> None:
    path = tmp_path / "heads.json"
    with path.open("a+", encoding="utf-8") as fh:
        oscompat.lock_file(fh)
        fh.seek(0)
        fh.truncate()
        fh.write('{"a": 1}')
        fh.flush()
        # A second reader (another handle) can still read the data.
        assert path.read_text(encoding="utf-8") == '{"a": 1}'
        oscompat.unlock_file(fh)


def test_unlock_without_lock_never_raises(tmp_path: Path) -> None:
    with (tmp_path / "y").open("a+") as fh:
        oscompat.unlock_file(fh)


def test_pid_alive_does_not_kill_the_process() -> None:
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert oscompat.pid_alive(proc.pid) is True
        # The probe must not have stopped it (on Windows os.kill(pid, 0) would).
        time.sleep(0.2)
        assert proc.poll() is None
    finally:
        proc.kill()
        proc.wait(timeout=10)
    assert oscompat.pid_alive(proc.pid) is False


@pytest.mark.parametrize("bad", [0, -1, "x", None])
def test_pid_alive_rejects_bad_pids(bad: object) -> None:
    assert oscompat.pid_alive(bad) is False  # type: ignore[arg-type]


def test_kill_tree_stops_a_detached_child_and_its_grandchild() -> None:
    script = (
        "import subprocess, sys, time\n"
        "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "print(c.pid, flush=True)\n"
        "time.sleep(60)\n"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.PIPE, text=True,
        **oscompat.detached_popen_kwargs(),
    )
    assert proc.stdout is not None
    grandchild = int(proc.stdout.readline().strip())
    pgid = oscompat.process_group_of(proc.pid)
    assert oscompat.group_alive(pgid)
    assert oscompat.kill_tree(pgid, force=True)
    proc.wait(timeout=10)
    deadline = time.monotonic() + 10
    while oscompat.pid_alive(grandchild) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not oscompat.pid_alive(grandchild)


def test_kill_tree_of_nothing_is_false() -> None:
    assert oscompat.kill_tree(0) is False
    assert oscompat.kill_tree("nope") is False  # type: ignore[arg-type]


def test_essential_env_is_empty_on_posix_and_has_systemroot_on_windows() -> None:
    env = oscompat.essential_env()
    if oscompat.IS_WINDOWS:
        assert "SYSTEMROOT" in env
    else:
        assert env == {}
