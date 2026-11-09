"""A wake tick dispatches the next step before the GitHub maintenance passes.

The interval tick still reconciles, freshens and auto-merges. A tick started
because a step finished (``FACTORY_TICK_REASON=wake``, ``maintenance=False``)
must not do that work first: it is what held the app between pm and sm (8.4.15).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from factory.chain import orchestrator
from factory.settings.loader import reload_settings


def _tree(tmp_path: Path) -> Path:
    factory_root = tmp_path / "software-factory"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice").mkdir(parents=True)
    (tmp_path / "sacrifice").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: x/y\ndefault_branch: main\n"
        f"app_repo_path: {tmp_path / 'sacrifice'}\n",
        encoding="utf-8",
    )
    (factory_root / "factory_settings.yaml").write_text(
        "caps:\n  daily_spend_usd: 100\n"
        "recovery:\n  enabled: false\n"
        "auto_merge:\n  enabled: true\n"
        "ci_health:\n  enabled: true\n",
        encoding="utf-8",
    )
    reload_settings(factory_root)
    return factory_root


def test_wake_tick_skips_github_maintenance(tmp_path: Path, monkeypatch: Any) -> None:
    root = _tree(tmp_path)
    calls: list[str] = []

    def _mark(name: str):
        def _fn(*_a: Any, **_k: Any) -> list[Any]:
            calls.append(name)
            return []

        return _fn

    monkeypatch.setattr(orchestrator, "reconcile_from_github", _mark("reconcile"))
    monkeypatch.setattr(orchestrator, "reconcile_closed_trackers", _mark("closed"))
    monkeypatch.setattr(orchestrator, "reconcile_dual_draft_winners", _mark("dual"))
    monkeypatch.setattr(orchestrator, "freshen_behind_prs", _mark("freshen"))
    monkeypatch.setattr(orchestrator, "auto_merge_tick", _mark("merge"))
    monkeypatch.setattr(
        orchestrator, "main_ci_health_tick", lambda *_a, **_k: calls.append("ci") or None
    )

    db = root / "state" / "factory.db"
    orchestrator.tick(root, "sacrifice", db_path=db, maintenance=False)
    assert calls == []

    orchestrator.tick(root, "sacrifice", db_path=db, maintenance=True)
    assert "reconcile" in calls
    assert "merge" in calls
