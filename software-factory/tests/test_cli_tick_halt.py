"""Tests for tick_cmd halt-check (Phase 8).

Verifies that when the factory is halted, ``factory tick`` exits cleanly
without dispatching any work.

The factory_improver sentinel this file used to monkeypatch
(``factory.chain.factory_improver.should_fire_improver`` /
``run_factory_improver``) was deleted 2026-08-07 along with
``factory/chain/factory_improver.py`` — see STATUS.md and the Exteroception
v1 direction, P0. The halted-tick-dispatches-nothing behavior survives (it's
enforced in ``factory.cli.tick_cmd`` before the scheduled-personas block), so
these tests sentinel on TWO surviving dispatch points instead:

  * ``factory.chain.scheduled_tasks.run_scheduled_persona`` — the
    cron-scheduled-persona loop, right after the halt check.
  * ``factory.chain.orchestrator.tick`` — the story-chain dispatch, last.

(A third sentinel, ``factory.chain.idle.maybe_generate_idle_work``, was
dropped 2026-08-07 — 019 AC5 deleted ``factory/chain/idle.py`` and the idle
block in ``tick_cmd`` that called it. The halt-position property below is
unaffected: it now needs only the remaining two points pinned.)

A regression that moves the halt check below ``run_scheduled_persona`` would
stay green if only ``orchestrator.tick`` were pinned (2026-08-07 review
round: the previous version of this file pinned only ``tick``, missing that
gap). ``factory.scheduler.cron.due_schedules`` is also patched to return one
concretely-due schedule — otherwise, with no ``schedules:`` block in the
test's minimal ``factory_settings.yaml``-less root, the default schedule list
resolves against a DB that doesn't exist, and a regressed halt check might
crash before ever reaching ``run_scheduled_persona`` rather than tripping the
sentinel. A crash is still a red test, but not a *precise* one, so the fixture
below makes the loop body definitely reachable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner


def _make_root(tmp_path: Path) -> Path:
    """Create a minimal factory root with sacrifice app config."""
    root = tmp_path / "root"
    root.mkdir()
    app_dir = root / "apps" / "sacrifice"
    app_dir.mkdir(parents=True)
    (app_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: https://github.com/test/sacrifice\ndefault_branch: main\n",
        encoding="utf-8",
    )
    (root / "state").mkdir(parents=True, exist_ok=True)
    return root


def _set_halt(root: Path) -> None:
    """Write a halt state file."""
    import json
    from datetime import UTC, datetime

    state = {
        "schema_version": 1,
        "mode": "halted",
        "set_at": datetime.now(UTC).isoformat(),
        "set_by": "manager_diagnostician",
        "concern_title": "test-halt",
        "proposal_path": None,
        "reason": "test halt for tick_cmd test",
    }
    halt_path = root / "state" / "factory_mode.json"
    halt_path.parent.mkdir(parents=True, exist_ok=True)
    halt_path.write_text(json.dumps(state), encoding="utf-8")


def _get_cli(root: Path):  # type: ignore[return]
    """Return a CliRunner + cli module with _FACTORY_ROOT patched to root."""
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def _one_due_schedule():  # type: ignore[no-untyped-def]
    """A single concretely-due schedule, so the scheduled-persona loop body
    (and therefore ``run_scheduled_persona``) is definitely reachable if the
    halt check ever regresses below it."""
    from factory.scheduler.cron import DueSchedule, Schedule

    return [
        DueSchedule(
            schedule=Schedule(
                name="ralph", cron_expr="0 * * * *", persona="ralph", rate_limit_key=None
            ),
            reason="test",
            rate_limit_hit=False,
        )
    ]


def _install_dispatch_sentinels(monkeypatch: pytest.MonkeyPatch) -> dict[str, bool]:
    """Loud sentinels on every dispatch point between the halt check and the
    end of tick_cmd. Returns a dict of call flags the test can assert on."""
    called = {"scheduled_persona": False, "tick": False}

    def _loud(name: str):  # type: ignore[no-untyped-def]
        def _fn(*args: Any, **kwargs: Any) -> Any:
            called[name] = True
            raise AssertionError(f"{name} must NOT be called when halted")

        return _fn

    monkeypatch.setattr(
        "factory.scheduler.cron.due_schedules", lambda *a, **kw: _one_due_schedule()
    )
    monkeypatch.setattr(
        "factory.chain.scheduled_tasks.run_scheduled_persona", _loud("scheduled_persona")
    )
    monkeypatch.setattr("factory.chain.orchestrator.tick", _loud("tick"))
    return called


def test_tick_cmd_skips_improver_when_halted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When halted, tick_cmd prints halt state and exits 0 without dispatching
    to EITHER of the two surviving dispatch points (scheduled personas or the
    story chain)."""
    root = _make_root(tmp_path)
    _set_halt(root)

    called = _install_dispatch_sentinels(monkeypatch)

    runner, cli_mod = _get_cli(root)
    # The tick_cmd checks halt BEFORE calling anything, so it should exit 0.
    result = runner.invoke(cli_mod.app, ["tick", "--app", "sacrifice", "--dry-run"])

    # Should exit cleanly.
    assert result.exit_code == 0, (
        f"tick should exit 0 when halted, got {result.exit_code}. "
        f"Output:\n{result.stdout}"
    )
    # No dispatch point must have been invoked.
    assert not any(called.values()), (
        f"no dispatch point may be called when factory is halted, got {called}"
    )
    # Halt notice should appear in output.
    assert "HALTED" in result.stdout or "halted" in result.stdout.lower(), (
        f"Expected halt notice in output. Got:\n{result.stdout}"
    )


def test_tick_cmd_skips_all_dispatch_when_halted_real_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same guarantee as above, but WITHOUT ``--dry-run``. A real (non-dry)
    invocation needs an LLM provider key to get past tick_cmd's own
    precondition check; the halt check fires before any of that key is
    actually used, so no LLM call happens and no state file is written."""
    root = _make_root(tmp_path)
    _set_halt(root)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key-not-used")

    called = _install_dispatch_sentinels(monkeypatch)

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["tick", "--app", "sacrifice"])

    assert result.exit_code == 0, (
        f"tick should exit 0 when halted (real run), got {result.exit_code}. "
        f"Output:\n{result.stdout}"
    )
    assert not any(called.values()), (
        f"no dispatch point may be called when factory is halted, got {called}"
    )
    assert "HALTED" in result.stdout or "halted" in result.stdout.lower(), (
        f"Expected halt notice in output. Got:\n{result.stdout}"
    )
    # Halt fires before any event-writing code runs — no events directory,
    # no idle/context_refresh/etc streams, should exist under this root.
    events_dir = root / "state" / "events"
    written = list(events_dir.glob("*.ndjson")) if events_dir.exists() else []
    assert written == [], f"halt must write no event stream, found: {written}"


def test_tick_cmd_proceeds_when_not_halted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When not halted, tick_cmd proceeds normally (no early exit)."""
    root = _make_root(tmp_path)
    # No halt file.

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["tick", "--app", "sacrifice", "--dry-run"])

    # Should reach the tick logic (exit 0 since no stories in flight).
    assert result.exit_code == 0, (
        f"tick should succeed when not halted. Output:\n{result.stdout}"
    )
    # Should NOT contain a halt message.
    assert "HALTED" not in result.stdout, (
        f"Unexpected halt message in output:\n{result.stdout}"
    )


def _summary_with(root: Path, *, skipped=(), errors=()):  # type: ignore[no-untyped-def]
    from factory.chain.orchestrator import TickSummary

    return TickSummary(
        app="sacrifice",
        dry_run=False,
        skipped=list(skipped),
        errors=list(errors),
    )


def test_tick_cmd_exit_zero_when_only_skipped_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A quarantined (invalid-state) row is NON-FATAL: tick must exit 0.

    Regression guard for the 2026-07-21 crash-loop: a poisoned row counted as
    an error made ``factory tick`` exit 1 -> systemd FAILED every cycle.
    """
    root = _make_root(tmp_path)
    monkeypatch.setattr(
        "factory.chain.orchestrator.tick",
        lambda *a, **kw: _summary_with(
            root, skipped=[("poisoned", "invalid state 'abandoned'; story skipped (non-fatal)")]
        ),
    )

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["tick", "--app", "sacrifice", "--dry-run"])

    assert result.exit_code == 0, (
        f"a skipped/quarantined row must NOT fail the tick exit code, "
        f"got {result.exit_code}. Output:\n{result.stdout}"
    )
    # The skip must still be surfaced (not silently swallowed).
    assert "invalid state" in result.stdout
    assert "skipped=1" in result.stdout


def test_tick_cmd_exit_one_when_real_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real error still fails the tick (exit 1) — the skip fix must not over-broaden."""
    root = _make_root(tmp_path)
    monkeypatch.setattr(
        "factory.chain.orchestrator.tick",
        lambda *a, **kw: _summary_with(
            root, errors=[("some-story", "RuntimeError('handler blew up')")]
        ),
    )

    runner, cli_mod = _get_cli(root)
    result = runner.invoke(cli_mod.app, ["tick", "--app", "sacrifice", "--dry-run"])

    assert result.exit_code == 1, (
        f"a real error must still fail the tick, got {result.exit_code}. "
        f"Output:\n{result.stdout}"
    )
