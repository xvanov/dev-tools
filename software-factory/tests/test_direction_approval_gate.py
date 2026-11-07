"""Operator-approval gate for machine-filed directions.

Regression for the 2026-07-30 treadmill (second occurrence; the first was
2026-07-24). The ``ux_auditor`` scheduled persona auto-filed directions 015,
016 and 017 — every one of them asking for BETTER INPUTS FOR THE AUDITOR
ITSELF — and ``auto_pm_sync`` triaged them into stories with no operator
review, producing four PRs (#165/#166/#167/#169) that had to be closed by hand.

The rule these tests pin down (see ``factory.directions.approval``):

* a direction whose ``source`` names a scheduled persona is NOT auto-triaged;
* a direction whose source cannot be determined is NOT auto-triaged (fail-safe);
* operator/human-filed directions are triaged exactly as before;
* an explicitly approved machine-filed direction proceeds;
* whatever is parked is VISIBLE (``factory inbox`` / ``factory approve-direction``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from sqlmodel import SQLModel, create_engine
from typer.testing import CliRunner

from factory.chain.pm_sync import maybe_auto_pm_sync, pm_sync
from factory.directions.approval import (
    APPROVAL_KEY,
    approve_direction,
    awaiting_operator_approval,
    is_auto_buildable,
    requires_operator_approval,
)
from factory.directions.creator import create_direction
from factory.directions.parser import parse_direction_dir
from factory.settings.loader import reload_settings

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


def _seed_app(tmp_path: Path) -> Path:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True, exist_ok=True)
    (apps_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\ndefault_branch: main\n"
        "context_dir: context\ndeploy:\n  enabled: false\nmodels: {}\n",
        encoding="utf-8",
    )
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _write_settings(tmp_path: Path, *, enabled: bool = True) -> None:
    (tmp_path / "factory_settings.yaml").write_text(
        f"auto_pm_sync:\n  enabled: {str(enabled).lower()}\n"
        "rate_limits:\n  pm_invocations_per_hour: 4\n",
        encoding="utf-8",
    )
    reload_settings(tmp_path)


def _file_direction(tmp_path: Path, *, source: str, title: str = "Add healthz endpoint"):
    """A direction with sufficient backpressure, so only the gate can stop it."""
    return create_direction(
        app="sacrifice",
        title=title,
        type_tag="feature",
        why="Smoke test wants a stable endpoint.",
        has_ui=False,
        flow_steps=None,
        has_api=True,
        api_spec_lines=['- `POST /healthz` -> 200 {"status":"ok"}'],
        acceptance=["Returns 200", "JSON body has status"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
        source=source,
    )


def _reparse(tmp_path: Path, dir_path: Path):
    return parse_direction_dir("sacrifice", dir_path, software_factory_root=tmp_path)


# --------------------------------------------------------------------------- #
# The predicate
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "source",
    [
        "scheduled-ux_auditor",
        "scheduled-ralph",
        "scheduled-bug_hunter",
        "scheduled-security",
        "some-future-robot",
    ],
)
def test_machine_sources_require_approval(tmp_path: Path, source: str) -> None:
    _seed_app(tmp_path)
    created = _file_direction(tmp_path, source=source)
    assert requires_operator_approval(created.direction) is True
    assert is_auto_buildable(created.direction) is False
    assert awaiting_operator_approval(created.direction) is True


@pytest.mark.parametrize(
    "source",
    ["operator", "operator-loop3", "cli", "cli-tell", "user", "github_issue", "ci-health"],
)
def test_human_and_deterministic_sources_never_need_approval(tmp_path: Path, source: str) -> None:
    _seed_app(tmp_path)
    created = _file_direction(tmp_path, source=source)
    assert requires_operator_approval(created.direction) is False
    assert is_auto_buildable(created.direction) is True
    assert awaiting_operator_approval(created.direction) is False


def test_unknown_source_fails_safe(tmp_path: Path) -> None:
    """No recorded source (deleted / corrupt state.yaml) → needs approval."""
    _seed_app(tmp_path)
    created = _file_direction(tmp_path, source="operator")
    (created.dir_path / "state.yaml").write_text("status: created\n", encoding="utf-8")
    direction = _reparse(tmp_path, created.dir_path)
    assert requires_operator_approval(direction) is True
    assert is_auto_buildable(direction) is False


def test_unsigned_approval_is_not_an_approval(tmp_path: Path) -> None:
    """A hand-written ``approved: true`` with no signer must not open the gate."""
    _seed_app(tmp_path)
    created = _file_direction(tmp_path, source="scheduled-ux_auditor")
    state_path = created.dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    state[APPROVAL_KEY] = {"approved": True}
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    assert is_auto_buildable(_reparse(tmp_path, created.dir_path)) is False

    # And a truthy-but-not-True value is not an approval either.
    state[APPROVAL_KEY] = {"approved": "yes", "approved_by": "somebody"}
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    assert is_auto_buildable(_reparse(tmp_path, created.dir_path)) is False


def test_approve_direction_records_signer_and_audit(tmp_path: Path) -> None:
    _seed_app(tmp_path)
    created = _file_direction(tmp_path, source="scheduled-ux_auditor")
    approve_direction(created.direction, by="kalin", note="worth doing")

    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state[APPROVAL_KEY]["approved"] is True
    assert state[APPROVAL_KEY]["approved_by"] == "kalin"
    assert state[APPROVAL_KEY]["note"] == "worth doing"
    assert state["audit"][-1]["event"] == "operator_approved"
    # The source is untouched — approving does not launder provenance.
    assert state["source"] == "scheduled-ux_auditor"
    assert is_auto_buildable(_reparse(tmp_path, created.dir_path)) is True


def test_approve_direction_rejects_empty_signer(tmp_path: Path) -> None:
    _seed_app(tmp_path)
    created = _file_direction(tmp_path, source="scheduled-ralph")
    with pytest.raises(ValueError):
        approve_direction(created.direction, by="   ")


# --------------------------------------------------------------------------- #
# The gate inside pm_sync — the door the 2026-07-30 incident walked through
# --------------------------------------------------------------------------- #


def test_auto_pm_sync_does_not_triage_a_scheduled_direction(tmp_path: Path) -> None:
    """THE regression: ux_auditor files its own work order; the tick must park it."""
    db = _seed_app(tmp_path)
    _write_settings(tmp_path)
    created = _file_direction(
        tmp_path,
        source="scheduled-ux_auditor",
        title="Provide executable fixtures for operator CLI UX audits",
    )

    summary, reason = maybe_auto_pm_sync("sacrifice", tmp_path, dry_run=True, state_db_path=db)
    assert summary is None
    assert reason == "awaiting_approval"

    # Nothing was written, nothing was validated, no story can exist.
    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "created"
    assert "pm_result" not in state


def test_auto_pm_sync_still_triages_an_operator_direction(tmp_path: Path) -> None:
    """The human path must not be slowed down at all."""
    db = _seed_app(tmp_path)
    _write_settings(tmp_path)
    _file_direction(tmp_path, source="operator")

    summary, reason = maybe_auto_pm_sync("sacrifice", tmp_path, dry_run=True, state_db_path=db)
    assert reason == "synced"
    assert summary is not None
    assert summary.processed == 1 and summary.validated == 1
    assert summary.awaiting_approval == []


def test_auto_pm_sync_mixed_queue_builds_only_the_approved_work(tmp_path: Path) -> None:
    db = _seed_app(tmp_path)
    _write_settings(tmp_path)
    _file_direction(tmp_path, source="operator", title="Operator wants healthz")
    machine = _file_direction(
        tmp_path, source="scheduled-ux_auditor", title="Auditor wants better fixtures"
    )

    summary, reason = maybe_auto_pm_sync("sacrifice", tmp_path, dry_run=True, state_db_path=db)
    assert reason == "synced"
    assert summary is not None
    assert summary.processed == 1, "the machine-filed direction must not be processed"
    assert summary.validated == 1
    assert [did for did, _ in summary.awaiting_approval] == [machine.direction.id]


def test_manual_pm_sync_also_honours_the_gate(tmp_path: Path) -> None:
    """A habitual ``factory pm-sync`` must not be a way around the gate."""
    db = _seed_app(tmp_path)
    machine = _file_direction(tmp_path, source="scheduled-bug_hunter")

    summary = pm_sync(
        app="sacrifice", software_factory_root=tmp_path, dry_run=True, state_db_path=db
    )
    assert summary.processed == 0 and summary.validated == 0
    assert [did for did, _ in summary.awaiting_approval] == [machine.direction.id]
    reason = summary.awaiting_approval[0][1]
    assert "bug_hunter" in reason


def test_approved_scheduled_direction_is_triaged(tmp_path: Path) -> None:
    """The gate is a gate, not a wall: approval lets the work through."""
    db = _seed_app(tmp_path)
    _write_settings(tmp_path)
    created = _file_direction(tmp_path, source="scheduled-security")

    approve_direction(created.direction, by="kalin")

    summary, reason = maybe_auto_pm_sync("sacrifice", tmp_path, dry_run=True, state_db_path=db)
    assert reason == "synced"
    assert summary is not None
    assert summary.processed == 1 and summary.validated == 1
    assert summary.awaiting_approval == []


def test_gate_does_not_break_the_stale_direction_gc(tmp_path: Path) -> None:
    """GC still reaps parked scheduler noise (it runs before the created-gate)."""
    from datetime import UTC, datetime, timedelta

    from factory.directions.gc import GC_BY, MAX_AGE_DAYS

    db = _seed_app(tmp_path)
    _write_settings(tmp_path)
    created = _file_direction(tmp_path, source="scheduled-security")
    state_path = created.dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    state["created_at"] = (datetime.now(UTC) - timedelta(days=MAX_AGE_DAYS + 1)).isoformat()
    state["status"] = "needs-direction"
    state["audit"] = [{"event": "status -> needs-direction"}]
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    maybe_auto_pm_sync("sacrifice", tmp_path, dry_run=False, state_db_path=db)
    final = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert final["status"] == "closed"
    assert final["audit"][-1]["by"] == GC_BY


# --------------------------------------------------------------------------- #
# Visibility + the operator's escape hatch
# --------------------------------------------------------------------------- #


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


@pytest.fixture
def cli_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FACTORY_WEBHOOK_LAZY", "1")
    monkeypatch.setenv("COLUMNS", "240")
    monkeypatch.setenv("TERM", "xterm-256color")
    _seed_app(tmp_path)
    _write_settings(tmp_path)
    return tmp_path


def test_inbox_lists_directions_awaiting_approval(cli_root: Path) -> None:
    created = _file_direction(
        cli_root,
        source="scheduled-ux_auditor",
        title="Provide executable fixtures for operator CLI UX audits",
    )
    runner, cli_mod = _runner_with_root(cli_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    assert "awaiting operator approval" in result.stdout
    assert created.dir_path.name in result.stdout
    assert "ux_auditor" in result.stdout
    assert "approve-direction" in result.stdout


def test_approve_direction_cli_lists_then_approves(cli_root: Path) -> None:
    created = _file_direction(cli_root, source="scheduled-ux_auditor")
    runner, cli_mod = _runner_with_root(cli_root)

    listing = runner.invoke(cli_mod.app, ["approve-direction"])
    assert listing.exit_code == 0
    assert created.dir_path.name in listing.stdout

    approved = runner.invoke(
        cli_mod.app,
        ["approve-direction", created.direction.id, "--app", "sacrifice", "--by", "kalin"],
    )
    assert approved.exit_code == 0, approved.stdout
    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state[APPROVAL_KEY]["approved"] is True
    assert state[APPROVAL_KEY]["approved_by"] == "kalin"

    # Now it is gone from the pending list.
    listing2 = runner.invoke(cli_mod.app, ["approve-direction"])
    assert "No directions awaiting operator approval" in listing2.stdout


def test_approve_direction_cli_can_reject(cli_root: Path) -> None:
    created = _file_direction(cli_root, source="scheduled-ux_auditor")
    runner, cli_mod = _runner_with_root(cli_root)
    result = runner.invoke(
        cli_mod.app,
        ["approve-direction", created.direction.id, "--app", "sacrifice", "--reject"],
    )
    assert result.exit_code == 0, result.stdout
    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "closed"
    assert APPROVAL_KEY not in state


def test_approve_direction_cli_is_in_help(cli_root: Path) -> None:
    """Discoverability is part of the fix: it must show in ``factory --help``."""
    runner, cli_mod = _runner_with_root(cli_root)
    result = runner.invoke(cli_mod.app, ["--help"])
    assert result.exit_code == 0
    assert "approve-direction" in result.stdout


def test_approve_direction_cli_rejects_unknown_direction(cli_root: Path) -> None:
    runner, cli_mod = _runner_with_root(cli_root)
    result = runner.invoke(
        cli_mod.app, ["approve-direction", "999", "--app", "sacrifice"]
    )
    assert result.exit_code == 2
