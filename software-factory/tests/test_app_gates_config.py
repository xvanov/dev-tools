"""Tests for ``AppGatesConfig`` schema + ``apps/sacrifice/config.yaml`` parse."""

from __future__ import annotations

from pathlib import Path

import yaml

from factory.app_config import AppConfig, AppGatesConfig, load_app_config

_REPO_ROOT = Path(__file__).resolve().parents[1]


def test_sacrifice_config_yaml_has_gates_section() -> None:
    """The shipped sacrifice config has a gates block with the expected fields."""
    cfg = load_app_config("sacrifice", _REPO_ROOT)
    assert isinstance(cfg.gates, AppGatesConfig)
    assert cfg.gates.lint_command and "ruff check" in cfg.gates.lint_command
    assert cfg.gates.format_check_command == "ruff format --check ."
    assert cfg.gates.type_check_command == "mypy backend"
    # Run from backend/ — sacrifice's pytest config lives there, not at
    # the repo root. Restricted to tests/ so e2e_test.py (which needs a
    # live stack) doesn't false-fail the dev gate.
    # The test_command runs the unit-test tree via uv run; broken-baseline
    # files (test_auth, test_dashboard, etc.) are excluded with --ignore.
    # Assert on the load-bearing parts rather than pinning the exact string.
    assert cfg.gates.test_command is not None
    assert "cd backend" in cfg.gates.test_command
    assert "uv run --extra dev pytest" in cfg.gates.test_command
    assert "tests/" in cfg.gates.test_command
    assert cfg.gates.coverage_command and "--cov-fail-under=70" in cfg.gates.coverage_command
    assert cfg.gates.e2e_command == "npx playwright test"
    assert cfg.gates.mutation_testing is False


def test_missing_gates_block_defaults_to_empty(tmp_path: Path) -> None:
    """Apps without a gates: block load with every command None and mutation off."""
    apps = tmp_path / "apps" / "tiny"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        "name: tiny\nrepo: o/r\ndefault_branch: main\n", encoding="utf-8"
    )
    cfg = load_app_config("tiny", tmp_path)
    assert cfg.gates.lint_command is None
    assert cfg.gates.format_check_command is None
    assert cfg.gates.type_check_command is None
    assert cfg.gates.coverage_command is None
    assert cfg.gates.mutation_testing is False


def test_partial_gates_block_keeps_missing_as_none(tmp_path: Path) -> None:
    """If an app declares only a subset of gates, the rest stay None."""
    apps = tmp_path / "apps" / "tiny"
    apps.mkdir(parents=True)
    yaml_text = yaml.safe_dump(
        {
            "name": "tiny",
            "repo": "o/r",
            "gates": {"lint_command": "eslint .", "mutation_testing": True},
        }
    )
    (apps / "config.yaml").write_text(yaml_text, encoding="utf-8")
    cfg = load_app_config("tiny", tmp_path)
    assert cfg.gates.lint_command == "eslint ."
    assert cfg.gates.mutation_testing is True
    assert cfg.gates.type_check_command is None
    assert cfg.gates.test_command is None


def test_app_config_round_trip_includes_gates() -> None:
    """``model_dump`` preserves the gates block."""
    cfg = AppConfig(name="x", repo="o/r", gates=AppGatesConfig(lint_command="ruff check ."))
    dumped = cfg.model_dump()
    assert dumped["gates"]["lint_command"] == "ruff check ."
