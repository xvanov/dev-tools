"""Tests for factory.manager.halt — Phase 7 halt authority.

Test inventory
--------------
test_request_halt_writes_state_file
    Call request_halt, verify file exists with expected fields.

test_is_halted_true_after_request
    Round-trip: request_halt → is_halted → True.

test_is_halted_false_when_no_file
    Clean root → is_halted returns False.

test_get_halt_state_returns_dict
    Full dict roundtrip.

test_clear_halt_archives_to_history
    Request halt, then clear; verify .halt_history.json has the record
    and state/factory_mode.json is gone.

test_request_halt_idempotent_archives_previous
    Request halt twice; second call archives the first state.

test_tick_skips_dispatch_when_halted
    Request halt, run tick, verify no text_run calls.

test_resume_clears_halt
    Request halt, call clear_halt, verify is_halted is False.

The L3-Diagnostician-integration tests that used to live here (mocking the
L3 LLM to request a halt) were removed 2026-08-07 along with
``factory/manager/diagnostician.py`` — see STATUS.md and the Exteroception
v1 direction, P0. This file now covers ``factory.manager.halt`` directly.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from factory.manager.halt import (
    _halt_path,
    _history_path,
    clear_halt,
    get_halt_state,
    is_halted,
    request_halt,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
_CONCERN_TITLE = "sm-token-overflow-runaway"
_PROPOSAL_PATH = "state/manager_proposals/20260526T120000-sm-token-overflow.json"
_REASON = "Three consecutive SM failures across 3 stories, cost spiralling, no self-healing."


# ---------------------------------------------------------------------------
# Basic halt module tests
# ---------------------------------------------------------------------------


class TestRequestHalt:
    def test_writes_state_file(self, tmp_path: Path) -> None:
        p = request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=_PROPOSAL_PATH,
            reason=_REASON,
        )
        assert p.exists()
        state = json.loads(p.read_text())
        assert state["mode"] == "halted"
        assert state["schema_version"] == 1
        assert state["set_by"] == "manager_diagnostician"
        assert state["concern_title"] == _CONCERN_TITLE
        assert state["proposal_path"] == _PROPOSAL_PATH
        assert state["reason"] == _REASON
        assert "set_at" in state

    def test_path_is_state_factory_mode_json(self, tmp_path: Path) -> None:
        p = request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=None,
            reason=_REASON,
        )
        assert p == tmp_path / "state" / "factory_mode.json"

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        root = tmp_path / "deep" / "nested"
        p = request_halt(
            root=root,
            concern_title=_CONCERN_TITLE,
            proposal_path=None,
            reason=_REASON,
        )
        assert p.exists()

    def test_idempotent_archives_previous(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title="first-concern",
            proposal_path=None,
            reason="first reason",
        )
        # Second request overwrites, old state goes to history.
        request_halt(
            root=tmp_path,
            concern_title="second-concern",
            proposal_path=None,
            reason="second reason",
        )
        state = json.loads(_halt_path(tmp_path).read_text())
        assert state["concern_title"] == "second-concern"

        history_path = _history_path(tmp_path)
        assert history_path.exists()
        history = json.loads(history_path.read_text())
        assert isinstance(history, list)
        assert len(history) == 1
        assert history[0]["concern_title"] == "first-concern"


class TestIsHalted:
    def test_true_after_request(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=None,
            reason=_REASON,
        )
        assert is_halted(root=tmp_path) is True

    def test_false_when_no_file(self, tmp_path: Path) -> None:
        assert is_halted(root=tmp_path) is False

    def test_false_when_file_wrong_mode(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"mode": "normal"}), encoding="utf-8")
        assert is_halted(root=tmp_path) is False

    def test_fail_safe_halted_when_file_is_corrupt(self, tmp_path: Path) -> None:
        # Fail-SAFE: a present-but-corrupt halt file must NOT read as "not
        # halted" (that silently ignores the halt meant to stop the factory).
        # It now reads as halted. (Previously this returned False — fail-open.)
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text("this is not json {{{", encoding="utf-8")
        assert is_halted(root=tmp_path) is True


class TestGetHaltState:
    def test_returns_dict_after_request(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=_PROPOSAL_PATH,
            reason=_REASON,
        )
        state = get_halt_state(root=tmp_path)
        assert isinstance(state, dict)
        assert state["mode"] == "halted"
        assert state["concern_title"] == _CONCERN_TITLE
        assert state["reason"] == _REASON

    def test_returns_none_when_no_file(self, tmp_path: Path) -> None:
        assert get_halt_state(root=tmp_path) is None

    def test_returns_none_when_not_halted(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"mode": "paused"}), encoding="utf-8")
        assert get_halt_state(root=tmp_path) is None


class TestClearHalt:
    def test_archives_to_history(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=_PROPOSAL_PATH,
            reason=_REASON,
        )
        archived = clear_halt(root=tmp_path, cleared_by="operator", reason="manual override")

        # Halt file should be gone.
        assert not _halt_path(tmp_path).exists()
        assert is_halted(root=tmp_path) is False

        # History should have the archived entry.
        history_path = _history_path(tmp_path)
        assert history_path.exists()
        history = json.loads(history_path.read_text())
        assert isinstance(history, list)
        assert len(history) == 1
        entry = history[0]
        assert entry["mode"] == "halted"
        assert entry["concern_title"] == _CONCERN_TITLE
        assert entry["cleared_by"] == "operator"
        assert entry["clear_reason"] == "manual override"
        assert "cleared_at" in entry

        # Return value.
        assert archived["cleared_by"] == "operator"
        assert archived["clear_reason"] == "manual override"

    def test_clear_without_reason(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=None,
            reason=_REASON,
        )
        archived = clear_halt(root=tmp_path)
        assert "clear_reason" not in archived or archived.get("clear_reason") is None
        assert not is_halted(root=tmp_path)

    def test_raises_if_no_halt_file(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            clear_halt(root=tmp_path)

    def test_raises_if_mode_not_halted(self, tmp_path: Path) -> None:
        p = tmp_path / "state" / "factory_mode.json"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"mode": "paused"}), encoding="utf-8")
        with pytest.raises(ValueError):
            clear_halt(root=tmp_path)


class TestResumeClears:
    def test_resume_clears_halt(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=None,
            reason=_REASON,
        )
        assert is_halted(root=tmp_path) is True
        clear_halt(root=tmp_path, cleared_by="operator", reason="test clear")
        assert is_halted(root=tmp_path) is False


class TestResumeGrace:
    """An operator resume suppresses manager re-halts for a grace window.

    Stall-class concerns ("no ticks for N minutes") can only clear AFTER a
    resume lets the orchestrator run; an immediate re-halt deadlocks the
    factory against its own manager (observed live 2026-06-11: re-halt 94s
    after resume, before the first post-resume tick).
    """

    def test_request_halt_suppressed_within_grace(self, tmp_path: Path) -> None:
        request_halt(
            root=tmp_path, concern_title=_CONCERN_TITLE, proposal_path=None, reason=_REASON
        )
        clear_halt(root=tmp_path, cleared_by="operator", reason="resume")

        out = request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE + "-continued",
            proposal_path=None,
            reason=_REASON,
        )
        assert out is None
        assert is_halted(root=tmp_path) is False

    def test_request_halt_allowed_after_grace_expires(self, tmp_path: Path) -> None:
        from datetime import timedelta

        from factory.manager.halt import _RESUME_GRACE_MINUTES

        old = (
            datetime.now(UTC) - timedelta(minutes=_RESUME_GRACE_MINUTES + 1)
        ).isoformat()
        history = tmp_path / "state" / ".halt_history.json"
        history.parent.mkdir(parents=True, exist_ok=True)
        history.write_text(
            json.dumps([{"mode": "halted", "cleared_at": old, "cleared_by": "operator"}]),
            encoding="utf-8",
        )

        out = request_halt(
            root=tmp_path, concern_title=_CONCERN_TITLE, proposal_path=None, reason=_REASON
        )
        assert out is not None
        assert is_halted(root=tmp_path) is True

    def test_grace_uses_latest_clear_even_after_later_archives(self, tmp_path: Path) -> None:
        """Archive entries written by request_halt overwrites (no cleared_at)
        after an operator clear must not mask the clear's recency."""
        request_halt(
            root=tmp_path, concern_title="first", proposal_path=None, reason=_REASON
        )
        clear_halt(root=tmp_path, cleared_by="operator")
        # Manually append a non-clear archive entry AFTER the operator clear.
        history = json.loads(_history_path(tmp_path).read_text())
        history.append({"mode": "halted", "concern_title": "noise"})
        _history_path(tmp_path).write_text(json.dumps(history), encoding="utf-8")

        out = request_halt(
            root=tmp_path, concern_title="second", proposal_path=None, reason=_REASON
        )
        assert out is None  # still inside the grace window


# ---------------------------------------------------------------------------
# Tick halt check test
# ---------------------------------------------------------------------------


class TestTickSkipsDispatchWhenHalted:
    def test_tick_halted_returns_summary_with_halted_true(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """request_halt → tick returns TickSummary(halted=True) without dispatching."""
        from factory.chain.orchestrator import tick

        # Write halt state.
        request_halt(
            root=tmp_path,
            concern_title=_CONCERN_TITLE,
            proposal_path=None,
            reason=_REASON,
        )

        # Track text_run calls.
        text_run_calls: list = []

        def _mock_text_run(*args: Any, **kwargs: Any) -> Any:
            text_run_calls.append((args, kwargs))
            return {}

        # We need a minimal app config so tick doesn't fail at config load.
        app_dir = tmp_path / "apps" / "sacrifice"
        app_dir.mkdir(parents=True)
        config_content = (
            "name: sacrifice\n"
            "repo: https://github.com/test/sacrifice\n"
            "default_branch: main\n"
        )
        (app_dir / "config.yaml").write_text(config_content, encoding="utf-8")

        # Also create a minimal factory.db (so tick doesn't error on db open)
        db_path = tmp_path / "state" / "factory.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)

        summary = tick(
            tmp_path,
            "sacrifice",
            dry_run=True,
            db_path=db_path,
        )

        assert summary.halted is True
        assert summary.halt_reason == _REASON
        assert summary.stories_advanced == 0
        # No LLM calls should have been made (no handler invocations).
        assert len(text_run_calls) == 0

    def test_tick_not_halted_proceeds_normally(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without halt, tick proceeds to story dispatch (stories_advanced may be 0 if no stories)."""
        from factory.chain.orchestrator import tick

        # No halt file.
        app_dir = tmp_path / "apps" / "sacrifice"
        app_dir.mkdir(parents=True)
        (app_dir / "config.yaml").write_text(
            "name: sacrifice\nrepo: https://github.com/test/sacrifice\ndefault_branch: main\n",
            encoding="utf-8",
        )

        db_path = tmp_path / "state" / "factory.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)

        summary = tick(
            tmp_path,
            "sacrifice",
            dry_run=True,
            db_path=db_path,
        )

        assert summary.halted is False
