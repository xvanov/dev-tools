"""Chain-side wiring for the deterministic recovery cycle + poison-escalation
(019 safety-mechanism rewire, post PR #247).

``factory.manager.recovery.run_recovery_cycle`` and
``factory.manager.poison_escalation.escalate_poisoned_rows`` had ZERO
production callers after PR #247 deleted ``factory/manager/apply.py`` — the
module that used to be their only caller. ``orchestrator.tick`` now calls
both as end-of-tick hooks, following the exact discipline the pre-existing
ci-health/detector-watch/idle-ping hooks use: gated by settings (recovery
only), skipped on ``dry_run``, skipped in ``paused``/``drain-reviews``, and
wrapped so a failure lands in ``summary.errors`` without ever aborting the
tick.

Also pins the ``get_mode``-outside-try fix: every one of these hooks (and the
tick's own early mode read) now calls ``get_mode`` INSIDE its guarding try, so
a broken mode read (e.g. ``database is locked``) degrades to a recorded error
instead of killing the whole tick and discarding the summary.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from factory.chain import orchestrator
from factory.settings.loader import reload_settings


@pytest.fixture
def factory_tree(tmp_path: Path) -> Path:
    """Minimal factory layout — app config, state dir, no in-flight stories."""
    factory_root = tmp_path / "software-factory"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice").mkdir(parents=True)
    (tmp_path / "sacrifice").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "config.yaml").write_text(
        f"name: sacrifice\nrepo: x/y\ndefault_branch: main\n"
        f"app_repo_path: {tmp_path / 'sacrifice'}\n"
        "gates:\n"
        "  lint_command: 'ruff check .'\n"
        "  format_check_command: 'ruff format --check .'\n"
        "  type_check_command: 'mypy .'\n"
        "  coverage_command: 'pytest --cov-fail-under=70'\n",
        encoding="utf-8",
    )
    return factory_root


def _write_settings(
    factory_root: Path,
    *,
    recovery_enabled: bool = True,
    auto_merge_enabled: bool = False,
) -> None:
    (factory_root / "factory_settings.yaml").write_text(
        "caps:\n  daily_spend_usd: 100\n"
        f"recovery:\n  enabled: {'true' if recovery_enabled else 'false'}\n"
        "auto_merge:\n"
        f"  enabled: {'true' if auto_merge_enabled else 'false'}\n"
        "  trigger: end_of_tick\n"
        "  merge_method: squash\n"
        "  wait_for_ci: true\n"
        "  delete_branch_after_merge: true\n",
        encoding="utf-8",
    )
    reload_settings(factory_root)


def _db_path(factory_root: Path) -> Path:
    return factory_root / "state" / "factory.db"


# --------------------------------------------------------------------------- #
# run_recovery_cycle wiring
# --------------------------------------------------------------------------- #


def test_tick_calls_recovery_when_enabled(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_settings(factory_tree, recovery_enabled=True)
    calls: list[dict[str, Any]] = []

    def _fake_recovery(root: Path, **kwargs: Any) -> dict[str, Any]:
        calls.append({"root": root, **kwargs})
        return {
            "recovered": ["one"],
            "escalated": [],
            "skipped_cooldown": [],
            "skipped_cap": [],
            "errors": [],
        }

    monkeypatch.setattr("factory.manager.recovery.run_recovery_cycle", _fake_recovery)

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    assert len(calls) == 1
    assert calls[0]["apps"] == ["sacrifice"]
    assert summary.recovery is not None
    assert summary.recovery["recovered"] == ["one"]


def test_tick_skips_recovery_on_dry_run(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_settings(factory_tree, recovery_enabled=True)
    calls: list[int] = []
    monkeypatch.setattr(
        "factory.manager.recovery.run_recovery_cycle",
        lambda *a, **k: calls.append(1),
    )

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=True, db_path=_db_path(factory_tree)
    )

    assert calls == []
    assert summary.recovery is None


def test_tick_skips_recovery_when_disabled(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_settings(factory_tree, recovery_enabled=False)
    calls: list[int] = []
    monkeypatch.setattr(
        "factory.manager.recovery.run_recovery_cycle",
        lambda *a, **k: calls.append(1),
    )

    orchestrator.tick(factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree))

    assert calls == []


def test_tick_skips_recovery_in_paused_mode(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_settings(factory_tree, recovery_enabled=True)
    from factory.settings.modes import set_mode

    set_mode("paused", factory_tree, db_path=_db_path(factory_tree))

    calls: list[int] = []
    monkeypatch.setattr(
        "factory.manager.recovery.run_recovery_cycle",
        lambda *a, **k: calls.append(1),
    )

    orchestrator.tick(factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree))

    assert calls == []


def test_tick_skips_recovery_in_drain_reviews_mode(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_settings(factory_tree, recovery_enabled=True)
    from factory.settings.modes import set_mode

    set_mode("drain-reviews", factory_tree, db_path=_db_path(factory_tree))

    calls: list[int] = []
    monkeypatch.setattr(
        "factory.manager.recovery.run_recovery_cycle",
        lambda *a, **k: calls.append(1),
    )

    orchestrator.tick(factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree))

    assert calls == []


def test_recovery_raising_records_error_without_aborting_tick(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_settings(factory_tree, recovery_enabled=True)

    def _boom(*a: Any, **k: Any) -> Any:
        raise RuntimeError("recovery blew up")

    monkeypatch.setattr("factory.manager.recovery.run_recovery_cycle", _boom)

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    assert any(k == "recovery" for k, _ in summary.errors)
    assert summary.recovery is None


# --------------------------------------------------------------------------- #
# escalate_poisoned_rows wiring
# --------------------------------------------------------------------------- #


def test_tick_calls_poison_escalation_and_surfaces_a_real_escalation(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []

    def _fake_escalate(root: Path, **kwargs: Any) -> dict[str, Any]:
        calls.append({"root": root, **kwargs})
        return {"status": "escalated", "signature": "abc", "poisoned": [{"story_id": 1}]}

    monkeypatch.setattr("factory.manager.poison_escalation.escalate_poisoned_rows", _fake_escalate)

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    assert len(calls) == 1
    assert calls[0]["apps"] == ["sacrifice"]
    assert summary.poison_escalation is not None
    assert summary.poison_escalation["status"] == "escalated"


def test_tick_does_not_surface_a_quiet_poison_cycle(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cycle that found nothing to escalate stays ``None`` — a healthy
    soak's tick output must not get noisy every 5 minutes."""
    monkeypatch.setattr(
        "factory.manager.poison_escalation.escalate_poisoned_rows",
        lambda *a, **k: {"status": "no_skip_signal", "signature": None, "poisoned": []},
    )

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    assert summary.poison_escalation is None


def test_tick_skips_poison_escalation_on_dry_run(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(
        "factory.manager.poison_escalation.escalate_poisoned_rows",
        lambda *a, **k: calls.append(1),
    )

    orchestrator.tick(factory_tree, "sacrifice", dry_run=True, db_path=_db_path(factory_tree))

    assert calls == []


def test_tick_skips_poison_escalation_in_paused_mode(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.settings.modes import set_mode

    set_mode("paused", factory_tree, db_path=_db_path(factory_tree))
    calls: list[int] = []
    monkeypatch.setattr(
        "factory.manager.poison_escalation.escalate_poisoned_rows",
        lambda *a, **k: calls.append(1),
    )

    orchestrator.tick(factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree))

    assert calls == []


def test_poison_escalation_raising_records_error_without_aborting_tick(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*a: Any, **k: Any) -> Any:
        raise RuntimeError("poison escalation blew up")

    monkeypatch.setattr("factory.manager.poison_escalation.escalate_poisoned_rows", _boom)

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    assert any(k == "poison-escalation" for k, _ in summary.errors)
    assert summary.poison_escalation is None


# --------------------------------------------------------------------------- #
# get_mode-outside-try hazard: a broken mode read must never kill the tick
# --------------------------------------------------------------------------- #


def test_get_mode_raising_does_not_kill_the_tick(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Simulates a locked-DB ``get_mode`` failure (the reviewer-flagged
    hazard). Before the fix, several of these reads sat OUTSIDE their
    hook's try block (or, for the tick's own early mode read, outside
    EVERY try block), so the exception propagated straight out of
    ``tick()`` and the caller never got a summary at all. Every read is
    now inside a try, so the tick completes and records what broke."""
    _write_settings(factory_tree, recovery_enabled=True, auto_merge_enabled=True)

    def _raise_get_mode(*a: Any, **k: Any) -> str:
        raise RuntimeError("database is locked")

    monkeypatch.setattr("factory.chain.orchestrator.get_mode", _raise_get_mode)

    # Must not raise.
    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    error_keys = {k for k, _ in summary.errors}
    # The tick's own pre-try mode read (used by the dependency-deferral cap).
    assert "mode-read" in error_keys
    # Every end-of-tick hook whose get_mode call is now inside its try.
    assert "recovery" in error_keys
    assert "poison-escalation" in error_keys
    assert "ci-health" in error_keys
    assert "idle-ping" in error_keys
    # auto_merge is enabled for this test — both its mode reads degrade
    # visibly rather than crash.
    assert "auto-merge" in error_keys or "auto-merge-pre-mode-read" in error_keys


def test_get_mode_raising_still_returns_a_usable_summary(
    factory_tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Beyond "doesn't raise": the returned summary must be a normal,
    inspectable TickSummary — not a bare success flag — so an operator (or
    the caller) can see what happened."""

    def _raise_get_mode(*a: Any, **k: Any) -> str:
        raise RuntimeError("database is locked")

    monkeypatch.setattr("factory.chain.orchestrator.get_mode", _raise_get_mode)

    summary = orchestrator.tick(
        factory_tree, "sacrifice", dry_run=False, db_path=_db_path(factory_tree)
    )

    assert summary.app == "sacrifice"
    assert summary.dry_run is False
    assert summary.halted is False
    d = orchestrator.tick_summary_as_dict(summary)
    assert "errors" in d and d["errors"]
