"""trip() is a read-modify-write of runtime_limits.json: concurrent trips of
different runtimes must not lose each other's entry."""

from __future__ import annotations

import threading
import time
from pathlib import Path

from factory import provider_limits as PL


def test_concurrent_trips_do_not_lose_entries(tmp_path: Path, monkeypatch) -> None:
    real_write = PL._write
    first = threading.Event()

    def slow_write(root: Path, data: dict) -> None:
        if not first.is_set():
            first.set()
            time.sleep(0.3)  # widen the read-modify-write window
        real_write(root, data)

    monkeypatch.setattr(PL, "_write", slow_write)
    hits = [PL.LimitHit(rt, None, "limit", "x") for rt in PL.RUNTIMES]
    threads = [threading.Thread(target=PL.trip, args=(tmp_path, h)) for h in hits]
    threads[0].start()
    first.wait(2)
    threads[1].start()
    for t in threads:
        t.join()
    assert set(PL.load(tmp_path)) == set(PL.RUNTIMES)
