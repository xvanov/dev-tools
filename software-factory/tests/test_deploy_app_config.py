"""Tests for ``DeployConfig`` schema + ``apps/sacrifice/config.yaml`` parse.

The factory itself is stack-agnostic — these tests assert that the
deploy block parses with every expected field and that defaults behave
when fields are omitted.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from factory.app_config import AppConfig, DeployConfig, load_app_config

_REPO_ROOT = Path(__file__).resolve().parents[1]


def test_sacrifice_config_yaml_has_deploy_block() -> None:
    """The shipped Sacrifice config defines all Phase 5 deploy fields."""
    cfg = load_app_config("sacrifice", _REPO_ROOT)
    d = cfg.deploy
    assert isinstance(d, DeployConfig)
    assert d.enabled is False
    assert d.working_directory == "."
    assert d.pre_deploy_commands == [
        "docker compose -f docker-compose.prod.yml build",
    ]
    assert d.deploy_command == "docker compose -f docker-compose.prod.yml up -d"
    assert d.health_check_command == "curl -fsS http://localhost:8000/healthz"
    assert d.smoke_test_command == "make smoke"
    assert d.rollback_command == "docker compose -f docker-compose.prod.yml.previous up -d"
    assert d.timeout_seconds == 600
    assert d.env_var_passthrough == ["STRIPE_API_KEY", "DATABASE_URL"]


def test_missing_deploy_block_defaults_to_disabled(tmp_path: Path) -> None:
    """Apps without a deploy: block load with enabled=False and empty commands."""
    apps = tmp_path / "apps" / "tiny"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        "name: tiny\nrepo: o/r\ndefault_branch: main\n", encoding="utf-8"
    )
    cfg = load_app_config("tiny", tmp_path)
    assert cfg.deploy.enabled is False
    assert cfg.deploy.deploy_command is None
    assert cfg.deploy.rollback_command is None
    assert cfg.deploy.pre_deploy_commands == []
    assert cfg.deploy.env_var_passthrough == []
    assert cfg.deploy.timeout_seconds == 600


def test_partial_deploy_block_keeps_missing_fields_as_none(tmp_path: Path) -> None:
    """Partial deploy blocks compose with defaults for the rest."""
    apps = tmp_path / "apps" / "tiny"
    apps.mkdir(parents=True)
    yaml_text = yaml.safe_dump(
        {
            "name": "tiny",
            "repo": "o/r",
            "deploy": {
                "enabled": True,
                "deploy_command": "echo deploy",
                "timeout_seconds": 30,
            },
        }
    )
    (apps / "config.yaml").write_text(yaml_text, encoding="utf-8")
    cfg = load_app_config("tiny", tmp_path)
    assert cfg.deploy.enabled is True
    assert cfg.deploy.deploy_command == "echo deploy"
    assert cfg.deploy.timeout_seconds == 30
    assert cfg.deploy.smoke_test_command is None
    assert cfg.deploy.rollback_command is None


def test_app_config_round_trip_includes_deploy() -> None:
    """``model_dump`` preserves the deploy block."""
    cfg = AppConfig(
        name="x",
        repo="o/r",
        deploy=DeployConfig(enabled=True, deploy_command="d", timeout_seconds=5),
    )
    dumped = cfg.model_dump()
    assert dumped["deploy"]["enabled"] is True
    assert dumped["deploy"]["deploy_command"] == "d"
    assert dumped["deploy"]["timeout_seconds"] == 5
