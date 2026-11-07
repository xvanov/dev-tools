"""Tests for the deploy orchestrator (Phase 5).

Dry-run with fixture step outputs. Verifies:

  * happy path → status='deployed', smoke_passed=True
  * deploy_command failure → rollback runs → status='rolled_back'
  * deploy AND rollback both fail → status='errored'
  * mode=deploy-frozen → status='skipped', no commands attempted
  * deploy_disabled_in_config → status='skipped'
  * dry-run does NOT mutate factory mode on failure
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from sqlmodel import Session, create_engine, select

from factory.deploy.models import DeployActionRecord
from factory.deploy.orchestrator import (
    _status_from_action,
    deploy_post_merge,
    deploy_tick,
)
from factory.settings.modes import get_mode, set_mode


def _write_root(tmp_path: Path, deploy: dict[str, Any] | None) -> Path:
    """Build a factory root with an enabled deploy block (or override)."""
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    cfg: dict[str, Any] = {
        "name": "sacrifice",
        "repo": "o/r",
        "default_branch": "main",
        "deploy": deploy
        if deploy is not None
        else {
            "enabled": True,
            "deploy_command": "echo deploy",
            "health_check_command": "echo healthy",
            "smoke_test_command": "echo smoke",
            "rollback_command": "echo rollback",
            "pre_deploy_commands": ["echo prep"],
        },
    }
    (apps / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    (tmp_path / "factory_settings.yaml").write_text(
        "modes:\n  default: normal\n  available: [normal, fix-only, paused, deploy-frozen]\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)
    return tmp_path


def test_happy_path_dry_run_records_deployed(tmp_path: Path) -> None:
    root = _write_root(tmp_path, None)
    action = deploy_post_merge(
        "sacrifice",
        42,
        "deadbeef" * 5,
        root,
        dry_run=True,
        # All steps return exit_code=0.
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert action.success is True
    assert action.smoke_passed is True
    assert action.rolled_back is False
    assert action.error is None
    assert _status_from_action(action) == "deployed"
    # Persisted row matches.
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].status == "deployed"
    assert rows[0].smoke_passed is True


def test_deploy_command_failure_triggers_rollback(tmp_path: Path) -> None:
    root = _write_root(tmp_path, None)
    # Phase-keyed fixtures: pre_deploy ok, deploy fails, rollback ok.
    action = deploy_post_merge(
        "sacrifice",
        43,
        "feedface" * 5,
        root,
        dry_run=True,
        fixture_step_outputs_by_phase={
            "pre_deploy": [(0, "", "")],
            "deploy": [(2, "", "boom")],
            "rollback": [(0, "", "")],
        },
    )
    assert action.success is False
    assert action.rolled_back is True
    assert _status_from_action(action) == "rolled_back"
    assert action.error and "deploy_failed" in action.error
    # In dry-run, mode_after is the would-be mode but NOT persisted.
    assert action.mode_after == "fix-only"
    assert get_mode(root) == "normal"


def test_deploy_AND_rollback_failures_errored(tmp_path: Path) -> None:
    root = _write_root(tmp_path, None)
    action = deploy_post_merge(
        "sacrifice",
        44,
        "cafebabe" * 5,
        root,
        dry_run=True,
        fixture_step_outputs_by_phase={
            "pre_deploy": [(0, "", "")],
            "deploy": [(1, "", "boom")],
            "rollback": [(2, "", "rollback also failed")],
        },
    )
    # P6.0 cleanup-4: rolled_back reflects ONLY whether the rollback
    # step itself succeeded. A failed rollback leaves the system in an
    # undefined state → rolled_back=False AND status="errored". The
    # persisted row mirrors action.rolled_back via rollback_triggered.
    assert action.rolled_back is False
    assert _status_from_action(action) == "errored"
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rec = session.exec(select(DeployActionRecord)).all()[0]
    assert rec.status == "errored"
    assert rec.rollback_triggered is False
    assert rec.rollback_passed is False


def test_mode_deploy_frozen_skips(tmp_path: Path) -> None:
    root = _write_root(tmp_path, None)
    set_mode("deploy-frozen", root)
    action = deploy_post_merge(
        "sacrifice",
        45,
        "deadbeef" * 5,
        root,
        dry_run=True,
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert action.success is False
    assert action.error == "mode_blocks_deploy"
    assert _status_from_action(action) == "skipped"
    # No steps were executed.
    assert action.steps == []
    # Factory mode stays as set (no flip from skipped path).
    assert get_mode(root) == "deploy-frozen"


def test_deploy_disabled_in_config_skips(tmp_path: Path) -> None:
    root = _write_root(
        tmp_path,
        {
            "enabled": False,
            "deploy_command": "echo deploy",
            "health_check_command": "echo h",
            "smoke_test_command": "echo s",
            "rollback_command": "echo r",
        },
    )
    action = deploy_post_merge(
        "sacrifice",
        46,
        "abc" * 14,
        root,
        dry_run=True,
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert action.success is False
    assert action.error == "deploy_disabled_in_config"
    assert _status_from_action(action) == "skipped"


def test_deploy_disabled_by_runtime_override_skips(tmp_path: Path) -> None:
    """config.yaml says enabled=true, but a machine runtime override disables
    it. The effective value wins (skip), and the reason is observable as a
    distinct error so config-authored vs machine-flipped is distinguishable."""
    from factory import runtime_state

    root = _write_root(tmp_path, None)  # config default: enabled=True
    runtime_state.set_deploy_enabled_override(root, "sacrifice", False)

    action = deploy_post_merge(
        "sacrifice",
        47,
        "abc" * 14,
        root,
        dry_run=True,
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert action.success is False
    assert action.error == "deploy_disabled_by_runtime_override"
    assert _status_from_action(action) == "skipped"

    # Clearing the override restores the config default (enabled=true), so the
    # deploy proceeds — proof the config default was never mutated.
    assert runtime_state.clear_deploy_enabled_override(root, "sacrifice") is True
    action2 = deploy_post_merge(
        "sacrifice",
        48,
        "abc" * 14,
        root,
        dry_run=True,
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert action2.error != "deploy_disabled_by_runtime_override"


def test_deploy_tick_with_explicit_sha_returns_one_action(tmp_path: Path) -> None:
    """``deploy_tick(sha=...)`` is the spec-facing wrapper; deploys exactly that SHA."""
    root = _write_root(tmp_path, None)
    actions = deploy_tick(
        root,
        "sacrifice",
        dry_run=True,
        sha="z" * 40,
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert len(actions) == 1
    assert actions[0].merged_sha == "z" * 40
    assert actions[0].success is True


def test_deploy_tick_with_no_candidates_returns_empty(tmp_path: Path) -> None:
    """No explicit sha + no merged_actions → empty list, no DB row."""
    root = _write_root(tmp_path, None)
    actions = deploy_tick(root, "sacrifice", dry_run=True)
    assert actions == []
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployActionRecord)).all()
    assert rows == []


def test_real_run_step_delegates_to_runner_run_command(tmp_path: Path, monkeypatch: Any) -> None:
    """P6.0 #2: real-run delegates to runner.run_command with cwd/timeout/env.

    Stub ``factory.deploy.orchestrator.run_command`` and inspect the kwargs;
    we don't need a real subprocess to assert the delegation contract.
    """
    root = _write_root(
        tmp_path,
        {
            "enabled": True,
            "working_directory": "subdir",
            "pre_deploy_commands": ["echo hi"],
            "deploy_command": "echo deploy",
            "health_check_command": "echo health",
            "smoke_test_command": "echo smoke",
            "env_var_passthrough": ["MY_VAR"],
            "timeout_seconds": 42,
        },
    )

    seen: list[dict[str, Any]] = []

    def fake_run_command(cmd: str, **kwargs: Any) -> Any:
        seen.append({"command": cmd, **kwargs})
        from factory.deploy.runner import CommandResult

        return CommandResult(
            command=cmd,
            exit_code=0,
            stdout="",
            stderr="",
            duration_seconds=0.0,
            phase=kwargs.get("phase"),
        )

    monkeypatch.setattr("factory.deploy.orchestrator.run_command", fake_run_command)

    action = deploy_post_merge("sacrifice", 7, "f" * 40, root, dry_run=False)
    assert action.success is True
    # At least pre_deploy + deploy + health + smoke = 4 calls.
    assert len(seen) >= 4
    for call in seen:
        assert call["timeout"] == 42
        assert call["env_var_passthrough"] == ["MY_VAR"]
        assert call["cwd"] == (root / "subdir").resolve()


def test_real_run_step_refuses_destructive_command(tmp_path: Path) -> None:
    """P6.0 #2: destructive commands short-circuit via runner.run_command.

    The runner refuses before subprocess; the orchestrator must surface
    that as a failed step (nonzero exit) so the rollback path engages.
    """
    root = _write_root(
        tmp_path,
        {
            "enabled": True,
            "deploy_command": "rm -rf /",  # destructive
            "health_check_command": "echo health",
            "smoke_test_command": "echo smoke",
            "rollback_command": "echo rollback",  # rolls back fine
        },
    )
    action = deploy_post_merge("sacrifice", 8, "g" * 40, root, dry_run=False)
    assert action.success is False
    assert action.error and "deploy_failed" in action.error
    deploy_step = next(s for s in action.steps if s.phase == "deploy")
    # runner.run_command returns exit_code=-1 with "refused" stderr when
    # is_destructive trips before subprocess.
    assert deploy_step.exit_code == -1
    assert "refused" in deploy_step.stderr_excerpt


def test_real_run_env_var_passthrough_filters_env(tmp_path: Path) -> None:
    """P6.0 #2: env_var_passthrough is forwarded to runner.run_command.

    The runner's _build_env only forwards whitelisted vars; this test
    confirms the orchestrator hands the whitelist down.
    """
    root = _write_root(
        tmp_path,
        {
            "enabled": True,
            "deploy_command": "echo $MY_PASS_VAR",
            "health_check_command": "true",
            "smoke_test_command": "true",
            "env_var_passthrough": ["MY_PASS_VAR"],
        },
    )

    import os

    os.environ["MY_PASS_VAR"] = "expected-value"
    os.environ["MY_SECRET"] = "should-not-leak"
    try:
        action = deploy_post_merge("sacrifice", 9, "h" * 40, root, dry_run=False)
        assert action.success is True
        deploy_step = next(s for s in action.steps if s.phase == "deploy")
        assert "expected-value" in deploy_step.stdout_excerpt
        # MY_SECRET must NOT appear in the stdout (the command only echoed
        # MY_PASS_VAR, but if env passthrough were broken we might see
        # other surprises; this is a smoke check).
        assert "should-not-leak" not in deploy_step.stdout_excerpt
    finally:
        os.environ.pop("MY_PASS_VAR", None)
        os.environ.pop("MY_SECRET", None)


def test_sacrifice_deploy_config_fields_consumed_by_runner(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """P6.0 #2 (cleanup-2): working_directory/env_var_passthrough/timeout_seconds
    from apps/sacrifice/config.yaml flow into runner.run_command.
    """
    import shutil

    # Stage a copy of the real sacrifice config in tmp_path.
    src = Path(__file__).resolve().parent.parent / "apps" / "sacrifice" / "config.yaml"
    dst_dir = tmp_path / "apps" / "sacrifice"
    dst_dir.mkdir(parents=True)
    shutil.copy(src, dst_dir / "config.yaml")
    # Flip enabled to true for this isolated test.
    import yaml as _yaml

    raw = _yaml.safe_load((dst_dir / "config.yaml").read_text(encoding="utf-8"))
    raw["deploy"]["enabled"] = True
    (dst_dir / "config.yaml").write_text(_yaml.safe_dump(raw), encoding="utf-8")
    (tmp_path / "factory_settings.yaml").write_text(
        "modes:\n  default: normal\n  available: [normal, fix-only, paused, deploy-frozen]\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)

    seen: list[dict[str, Any]] = []

    def fake_run_command(cmd: str, **kwargs: Any) -> Any:
        seen.append({"command": cmd, **kwargs})
        from factory.deploy.runner import CommandResult

        return CommandResult(
            command=cmd,
            exit_code=0,
            stdout="",
            stderr="",
            duration_seconds=0.0,
            phase=kwargs.get("phase"),
        )

    monkeypatch.setattr("factory.deploy.orchestrator.run_command", fake_run_command)

    action = deploy_post_merge("sacrifice", 10, "i" * 40, tmp_path, dry_run=False)
    assert action.success is True
    # Every call should carry the sacrifice config's timeout=600, env
    # passthrough including STRIPE_API_KEY+DATABASE_URL, and the
    # working_directory "." resolved against the factory root.
    assert all(c["timeout"] == 600 for c in seen)
    assert all(set(c["env_var_passthrough"]) == {"STRIPE_API_KEY", "DATABASE_URL"} for c in seen)
    assert all(c["cwd"] == (tmp_path / ".").resolve() for c in seen)
