"""Tests for uniform SAFE fail-direction of the control plane (WS2.3).

The factory's control-plane state must fail in the SAFE direction and must
never swallow its own read/write failures:

  * halt.is_halted        — corrupt/unreadable halt file → fail SAFE (halted)
                            with a bounded retry and a CRITICAL alert.
  * halt.clear_halt       — must still clear a corrupt halt file so an operator
                            `factory resume` is never wedged.
  * circuit_breaker.is_tripped — corrupt/unreadable state → fail CLOSED
                            (stay tripped) with a CRITICAL alert.
  * signals.write_event   — an append failure is best-effort (never raises) but
                            OBSERVABLE (bumps a counter, logs loudly).
  * signals.write_alert_event — writes a visible alert record + stderr line.

Valid states must be preserved: a valid halt still halts, a valid non-halt
still runs, a genuinely-tripped breaker still trips, resume still clears.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from factory.manager import signals
from factory.manager.circuit_breaker import is_tripped
from factory.manager.halt import (
    _HALT_READ_RETRIES,
    clear_halt,
    is_halted,
    request_halt,
)
from factory.manager.signals import (
    get_write_failure_count,
    write_alert_event,
    write_event,
)


def _alerts(root: Path) -> list[dict]:
    """Return all alert records written under *root*."""
    p = root / "state" / "events" / "alerts.ndjson"
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


# --------------------------------------------------------------------------- #
# halt: fail SAFE on corrupt file
# --------------------------------------------------------------------------- #


class TestHaltFailsSafe:
    def test_corrupt_halt_file_fails_safe_and_alerts(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text("}}} not json", encoding="utf-8")

        assert is_halted(root=tmp_path) is True  # fail SAFE, not fail-open

        alerts = _alerts(tmp_path)
        assert any(a["kind"] == "halt_unreadable" for a in alerts)
        assert any(a["severity"] == "critical" for a in alerts)

    def test_corrupt_halt_file_attempts_bounded_retry(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text("not json", encoding="utf-8")

        # Bounded retry: sleep is called between attempts (retries - 1 times),
        # proving we retry a few times rather than looping forever.
        with patch("factory.manager.halt.time.sleep") as sleep_mock:
            assert is_halted(root=tmp_path) is True
        assert sleep_mock.call_count == _HALT_READ_RETRIES - 1

    def test_valid_halt_still_halts(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title="c",
            proposal_path=None,
            reason="r",
        )
        assert is_halted(root=tmp_path) is True

    def test_valid_non_halt_still_runs(self, tmp_path: Path) -> None:
        # No file at all → not halted (normal running state).
        assert is_halted(root=tmp_path) is False
        # Valid file, non-halted mode → not halted.
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"mode": "normal"}), encoding="utf-8")
        assert is_halted(root=tmp_path) is False


class TestClearHaltTolerant:
    def test_resume_clears_a_corrupt_halt(self, tmp_path: Path) -> None:
        # A corrupt halt file fail-safes to halted; the operator MUST still be
        # able to clear it, or the factory is wedged forever.
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text("corrupt {{{", encoding="utf-8")
        assert is_halted(root=tmp_path) is True

        clear_halt(root=tmp_path, cleared_by="operator", reason="fix corrupt halt")

        assert not p.exists()
        assert is_halted(root=tmp_path) is False

    def test_resume_still_clears_a_valid_halt(self, tmp_path: Path) -> None:
        request_halt(root=tmp_path, concern_title="c", proposal_path=None, reason="r")
        clear_halt(root=tmp_path, cleared_by="operator")
        assert is_halted(root=tmp_path) is False


# --------------------------------------------------------------------------- #
# circuit_breaker: fail CLOSED on corrupt file
# --------------------------------------------------------------------------- #


class TestCircuitBreakerFailsClosed:
    def test_corrupt_state_stays_tripped_and_alerts(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "circuit_breaker.json"
        p.parent.mkdir(parents=True)
        p.write_text("not json {{{", encoding="utf-8")

        assert is_tripped(root=tmp_path) is True  # fail CLOSED

        alerts = _alerts(tmp_path)
        assert any(a["kind"] == "circuit_breaker_state_corrupt" for a in alerts)
        assert any(a["severity"] == "critical" for a in alerts)

    def test_missing_state_is_not_tripped(self, tmp_path: Path) -> None:
        assert is_tripped(root=tmp_path) is False

    def test_valid_future_halt_until_is_tripped(self, tmp_path: Path) -> None:
        now = datetime(2026, 1, 1, tzinfo=UTC)
        p = tmp_path / "state" / "circuit_breaker.json"
        p.parent.mkdir(parents=True)
        p.write_text(
            json.dumps({"halt_until": (now + timedelta(hours=1)).isoformat()}),
            encoding="utf-8",
        )
        assert is_tripped(root=tmp_path, now=now) is True

    def test_valid_past_halt_until_is_not_tripped(self, tmp_path: Path) -> None:
        now = datetime(2026, 1, 1, tzinfo=UTC)
        p = tmp_path / "state" / "circuit_breaker.json"
        p.parent.mkdir(parents=True)
        p.write_text(
            json.dumps({"halt_until": (now - timedelta(hours=1)).isoformat()}),
            encoding="utf-8",
        )
        assert is_tripped(root=tmp_path, now=now) is False

    def test_unparseable_halt_until_stays_tripped(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "circuit_breaker.json"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"halt_until": "not-a-timestamp"}), encoding="utf-8")
        assert is_tripped(root=tmp_path) is True


# --------------------------------------------------------------------------- #
# signals: control-plane write failures are observable, not swallowed
# --------------------------------------------------------------------------- #


class TestControlPlaneWriteObservable:
    def test_write_event_failure_is_counted_and_loud(self, tmp_path, capsys) -> None:
        before = get_write_failure_count()

        def _boom(*_a: object, **_k: object) -> None:
            raise OSError("disk full")

        # Path.open is what write_event uses to append; force it to fail.
        with patch("pathlib.Path.open", side_effect=_boom):
            # Must NOT raise (best-effort telemetry).
            write_event("runs", {"event": "run"}, software_factory_root=tmp_path)

        # But the failure IS observable: counter bumped + loud stderr line.
        assert get_write_failure_count() == before + 1
        err = capsys.readouterr().err
        assert "ANOMALY" in err

    def test_write_alert_event_records_and_prints(self, tmp_path, capsys) -> None:
        write_alert_event(
            "unit_test_alert",
            "something went wrong",
            severity="critical",
            software_factory_root=tmp_path,
            extra_field="x",
        )
        # stderr is loud.
        assert "[ALERT:CRITICAL]" in capsys.readouterr().err
        # And a structured record lands on the alerts stream.
        alerts = _alerts(tmp_path)
        assert len(alerts) == 1
        rec = alerts[0]
        assert rec["event"] == "alert"
        assert rec["kind"] == "unit_test_alert"
        assert rec["severity"] == "critical"
        assert rec["extra_field"] == "x"

    def test_alert_stream_name_is_alerts(self) -> None:
        assert signals.ALERT_STREAM == "alerts"
