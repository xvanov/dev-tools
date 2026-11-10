"""pm-sync budget ignores premodel failures; litellm import is serialised."""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from factory import runner
from factory.chain.pm_sync import _pm_runs_last_hour


def test_premodel_failures_do_not_burn_the_pm_budget(tmp_path: Path) -> None:
    db = tmp_path / "f.db"
    c = sqlite3.connect(db)
    c.execute("create table runs (id integer primary key, ts text, persona text, success int, premodel_infra int)")
    ts = datetime.now(UTC).isoformat()
    c.executemany(
        "insert into runs (ts, persona, success, premodel_infra) values (?,?,?,?)",
        [(ts, "pm", 1, 0), (ts, "pm", 0, 1), (ts, "pm", 0, 1), (ts, "pm", 0, 0)],
    )
    c.commit()
    c.close()
    assert _pm_runs_last_hour(db) == 2  # the success and the real model failure


def test_litellm_import_is_serialised(monkeypatch) -> None:
    import importlib

    inside = 0
    overlap = []

    def slow(name: str):
        nonlocal inside
        inside += 1
        overlap.append(inside)
        time.sleep(0.05)
        inside -= 1
        return object()

    monkeypatch.setattr(importlib, "import_module", slow)
    ts = [threading.Thread(target=runner.import_litellm) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert max(overlap) == 1
