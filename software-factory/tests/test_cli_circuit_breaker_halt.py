"""``factory manager circuit-breaker check`` halts the factory on a trip.

019 safety-mechanism rewire: the circuit breaker tripping (a chain-authored
self-edit commit that regressed ``main``) is the one narrow, clearly-warranted
condition wired to the halt writer added in this PR (``factory halt``'s
underlying ``request_halt``) — not a new detection surface, just a reaction
to a trip this command already computes and reports.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner


@pytest.fixture
def root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    import importlib

    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    reload_settings(root)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_check_halts_the_factory_when_the_breaker_trips(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.manager.halt import is_halted

    runner, cli_mod = _runner_with_root(root)
    assert is_halted(root=root) is False

    def _fake_trip(*, root: Path, test_command: str) -> dict:
        return {
            "regression_commit": "deadbeefcafe",
            "revert_branch": "factory-manager-revert/20260101T000000",
            "revert_pr_number": 999,
            "halt_until": "2099-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr("factory.manager.circuit_breaker.check_and_trip", _fake_trip)

    result = runner.invoke(cli_mod.app, ["manager", "circuit-breaker", "check"])

    assert result.exit_code == 1
    assert "TRIPPED" in result.stdout
    assert is_halted(root=root) is True


def test_check_does_not_halt_when_the_breaker_stays_clean(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.manager.halt import is_halted

    runner, cli_mod = _runner_with_root(root)

    monkeypatch.setattr(
        "factory.manager.circuit_breaker.check_and_trip", lambda *, root, test_command: None
    )

    result = runner.invoke(cli_mod.app, ["manager", "circuit-breaker", "check"])

    assert result.exit_code == 0
    assert is_halted(root=root) is False


def test_check_does_not_re_halt_an_already_halted_factory(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A trip on an already-halted factory must not crash or double-write —
    it should report the trip (exit 1) without re-invoking request_halt."""
    from factory.manager.halt import is_halted, request_halt

    runner, cli_mod = _runner_with_root(root)
    request_halt(root=root, concern_title="prior", proposal_path=None, reason="already halted")
    assert is_halted(root=root) is True

    halt_calls = []
    monkeypatch.setattr(
        "factory.manager.halt.request_halt",
        lambda **kwargs: halt_calls.append(kwargs),
    )
    monkeypatch.setattr(
        "factory.manager.circuit_breaker.check_and_trip",
        lambda *, root, test_command: {
            "regression_commit": "abc123",
            "revert_branch": "b",
            "revert_pr_number": None,
            "halt_until": "2099-01-01T00:00:00+00:00",
        },
    )

    result = runner.invoke(cli_mod.app, ["manager", "circuit-breaker", "check"])

    assert result.exit_code == 1
    assert halt_calls == []
