"""Tests for ``factory apps`` command and its underlying ``list_apps`` function."""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from typer.testing import CliRunner


def _write_app_config(
    apps_root: Path, name: str, repo: str, self_tick: bool, deploy_enabled: bool
) -> Path:
    """Write a minimal ``apps/<name>/config.yaml`` and return the app dir."""
    app_dir = apps_root / name
    app_dir.mkdir(parents=True)
    cfg = {
        "name": name,
        "repo": repo,
        "self_tick_enabled": self_tick,
        "deploy": {"enabled": deploy_enabled},
    }
    (app_dir / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    return app_dir


def _setup_cli_runner(tmp_path: Path):
    """Set up a CliRunner pointed at a temp factory root with settings/state."""
    import importlib

    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    (tmp_path / "factory_settings.yaml").write_text(
        yaml.safe_dump({"caps": {}, "modes": {"default": "normal", "available": ["normal"]}}),
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()

    reload_settings(tmp_path)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = tmp_path  # type: ignore[attr-defined]

    return CliRunner(), cli_mod


def test_list_apps_returns_every_app_with_config(tmp_path: Path) -> None:
    """AC1.1 + AC4.1: list_apps discovers both apps, one row each."""
    from factory.app_config import list_apps

    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)
    _write_app_config(apps_root, "beta", "owner/beta", self_tick=False, deploy_enabled=False)

    rows = list_apps(tmp_path)
    assert len(rows) == 2
    names = {r["name"] for r in rows}
    assert names == {"alpha", "beta"}


def test_list_apps_includes_required_fields(tmp_path: Path) -> None:
    """AC2.1 + AC2.2: each row carries name, repo, self_tick_enabled, deploy_enabled."""
    from factory.app_config import list_apps

    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)
    _write_app_config(apps_root, "beta", "owner/beta", self_tick=False, deploy_enabled=False)

    rows = {r["name"]: r for r in list_apps(tmp_path)}

    alpha = rows["alpha"]
    assert alpha["name"] == "alpha"
    assert alpha["repo"] == "owner/alpha"
    assert alpha["self_tick_enabled"] is True
    assert alpha["deploy_enabled"] is True

    beta = rows["beta"]
    assert beta["name"] == "beta"
    assert beta["repo"] == "owner/beta"
    assert beta["self_tick_enabled"] is False
    assert beta["deploy_enabled"] is False


def test_list_apps_read_only(tmp_path: Path) -> None:
    """AC3.1: list_apps does not mutate the config or filesystem."""
    from factory.app_config import list_apps

    apps_root = tmp_path / "apps"
    cfg_path = apps_root / "alpha" / "config.yaml"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)

    original_yaml = cfg_path.read_text(encoding="utf-8")

    list_apps(tmp_path)
    list_apps(tmp_path)  # Call twice to ensure idempotency

    assert cfg_path.read_text(encoding="utf-8") == original_yaml
    # No state files or side effects created.
    children = list(tmp_path.iterdir())
    assert {p.name for p in children} == {"apps"}


def test_list_apps_no_configs_returns_empty(tmp_path: Path) -> None:
    """When no apps/*/config.yaml exist, list_apps returns an empty list."""
    from factory.app_config import list_apps

    (tmp_path / "apps").mkdir()
    rows = list_apps(tmp_path)
    assert rows == []


def test_cli_apps_output_contains_required_fields(tmp_path: Path) -> None:
    """AC4.2 + AC4.3: CLI output shows both apps with self_tick_enabled and deploy.enabled."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)
    _write_app_config(apps_root, "beta", "owner/beta", self_tick=False, deploy_enabled=False)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps"])

    assert result.exit_code == 0, result.output
    assert "alpha" in result.output
    assert "beta" in result.output
    assert "owner/alpha" in result.output
    assert "owner/beta" in result.output
    assert "self_tick_enabled" in result.output
    assert "deploy.enabled" in result.output
    # True / False values appear in the rendered table.
    assert "True" in result.output
    assert "False" in result.output


def test_cli_apps_exit_zero_when_apps_found(tmp_path: Path) -> None:
    """AC3.2: exits 0 when at least one app is found."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=False, deploy_enabled=False)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps"])
    assert result.exit_code == 0


# ---------------------------------------------------------------------------
# --json mode tests (Story 72)
# ---------------------------------------------------------------------------


def test_cli_apps_json_emits_parseable_json_array(tmp_path: Path) -> None:
    """AC1.1 + AC3.1: --json prints a JSON array parseable by json.loads."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)
    _write_app_config(apps_root, "beta", "owner/beta", self_tick=False, deploy_enabled=False)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps", "--json"])
    assert result.exit_code == 0, result.output

    parsed = json.loads(result.output.strip())
    assert isinstance(parsed, list)
    assert len(parsed) == 2


def test_cli_apps_json_contains_required_keys(tmp_path: Path) -> None:
    """AC1.2 + AC1.3: each JSON object has name, repo, self_tick_enabled, deploy_enabled."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)
    _write_app_config(apps_root, "beta", "owner/beta", self_tick=False, deploy_enabled=False)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps", "--json"])
    assert result.exit_code == 0, result.output

    parsed = json.loads(result.output.strip())
    for obj in parsed:
        assert "name" in obj
        assert "repo" in obj
        assert "self_tick_enabled" in obj
        assert "deploy_enabled" in obj


def test_cli_apps_json_boolean_field_values(tmp_path: Path) -> None:
    """AC4.1 + AC4.2: --json emits correct self_tick_enabled / deploy_enabled values."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)
    _write_app_config(apps_root, "beta", "owner/beta", self_tick=False, deploy_enabled=False)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps", "--json"])
    assert result.exit_code == 0, result.output

    parsed = json.loads(result.output.strip())
    by_name = {obj["name"]: obj for obj in parsed}

    alpha = by_name["alpha"]
    assert alpha["self_tick_enabled"] is True
    assert alpha["deploy_enabled"] is True

    beta = by_name["beta"]
    assert beta["self_tick_enabled"] is False
    assert beta["deploy_enabled"] is False


def test_cli_apps_json_no_table_output(tmp_path: Path) -> None:
    """AC3.2 + AC3.3: --json writes only JSON to stdout, no table markup."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps", "--json"])
    assert result.exit_code == 0, result.output

    output = result.output.strip()
    # Must be valid JSON.
    json.loads(output)
    # Must not contain Rich table markup or column headers.
    assert "Configured Apps" not in output
    assert "│" not in output  # Rich table box-drawing characters


def test_cli_apps_json_empty_apps_emits_empty_array(tmp_path: Path) -> None:
    """--json with no configured apps still emits a valid empty JSON array."""
    (tmp_path / "apps").mkdir()

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps", "--json"])
    assert result.exit_code == 0, result.output

    parsed = json.loads(result.output.strip())
    assert parsed == []


def test_cli_apps_default_no_json_still_renders_table(tmp_path: Path) -> None:
    """AC2.1 + AC2.2 + AC4.3: default (no --json) still renders the table."""
    apps_root = tmp_path / "apps"
    _write_app_config(apps_root, "alpha", "owner/alpha", self_tick=True, deploy_enabled=True)

    runner, cli_mod = _setup_cli_runner(tmp_path)

    result = runner.invoke(cli_mod.app, ["apps"])
    assert result.exit_code == 0, result.output

    # Table rendering markers.
    assert "Configured Apps" in result.output
    assert "self_tick_enabled" in result.output
    assert "deploy.enabled" in result.output
    # Not valid JSON.
    with __import__("pytest").raises(json.JSONDecodeError):
        json.loads(result.output.strip())
