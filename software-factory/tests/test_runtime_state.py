"""Tests for factory.runtime_state — the config/runtime-state split.

Covers the single-source-of-truth guarantee for ``deploy.enabled``:
  * effective value = runtime override if present, else the config default;
  * no runtime file → legacy behavior (config value used, byte-identical);
  * a machine override does NOT touch config.yaml, and an operator config
    edit does NOT touch the override — the two never collide;
  * set / get / clear round-trips; corrupt / non-bool files degrade to "no
    override"; observability via ``describe_deploy_enabled``.
"""

from __future__ import annotations

from pathlib import Path

from factory import runtime_state
from factory.app_config import AppConfig, DeployConfig, load_app_config


def _write_config(root: Path, app: str, *, enabled: bool) -> Path:
    app_dir = root / "apps" / app
    app_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = app_dir / "config.yaml"
    cfg_path.write_text(
        f"name: {app}\n"
        "repo: o/r\n"
        'app_repo_path: "app_repo"\n'
        "deploy:\n"
        f"  enabled: {'true' if enabled else 'false'}\n",
        encoding="utf-8",
    )
    return cfg_path


def _cfg(app: str = "sacrifice", *, enabled: bool) -> AppConfig:
    return AppConfig(name=app, repo="o/r", deploy=DeployConfig(enabled=enabled))


# --------------------------------------------------------------------------- #
# No runtime file → legacy behavior
# --------------------------------------------------------------------------- #


def test_no_runtime_file_uses_config_default(tmp_path: Path) -> None:
    assert runtime_state.read_runtime_state(tmp_path, "sacrifice") == {}
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is None
    assert runtime_state.effective_deploy_enabled(_cfg(enabled=True), tmp_path) is True
    assert runtime_state.effective_deploy_enabled(_cfg(enabled=False), tmp_path) is False
    # No file is created merely by reading.
    assert not runtime_state.runtime_state_path(tmp_path, "sacrifice").exists()


# --------------------------------------------------------------------------- #
# Override wins over config default (both directions)
# --------------------------------------------------------------------------- #


def test_override_false_beats_config_true(tmp_path: Path) -> None:
    runtime_state.set_deploy_enabled_override(tmp_path, "sacrifice", False)
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is False
    assert runtime_state.effective_deploy_enabled(_cfg(enabled=True), tmp_path) is False


def test_override_true_beats_config_false(tmp_path: Path) -> None:
    runtime_state.set_deploy_enabled_override(tmp_path, "sacrifice", True)
    assert runtime_state.effective_deploy_enabled(_cfg(enabled=False), tmp_path) is True


def test_override_is_per_app(tmp_path: Path) -> None:
    runtime_state.set_deploy_enabled_override(tmp_path, "sacrifice", False)
    # A different app is unaffected — no cross-talk.
    assert runtime_state.get_deploy_enabled_override(tmp_path, "factory") is None
    assert runtime_state.effective_deploy_enabled(
        _cfg("factory", enabled=True), tmp_path
    ) is True


# --------------------------------------------------------------------------- #
# Clear restores the config default
# --------------------------------------------------------------------------- #


def test_clear_removes_override_and_file(tmp_path: Path) -> None:
    runtime_state.set_deploy_enabled_override(tmp_path, "sacrifice", False)
    path = runtime_state.runtime_state_path(tmp_path, "sacrifice")
    assert path.exists()

    assert runtime_state.clear_deploy_enabled_override(tmp_path, "sacrifice") is True
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is None
    # File removed entirely when empty → byte-for-byte back to legacy.
    assert not path.exists()
    assert runtime_state.effective_deploy_enabled(_cfg(enabled=True), tmp_path) is True


def test_clear_when_nothing_to_clear_is_false(tmp_path: Path) -> None:
    assert runtime_state.clear_deploy_enabled_override(tmp_path, "sacrifice") is False


def test_clear_preserves_other_keys(tmp_path: Path) -> None:
    # Simulate an unrelated future key living alongside deploy_enabled.
    runtime_state._write_runtime_state(
        tmp_path, "sacrifice", {"deploy_enabled": False, "other": 1}
    )
    assert runtime_state.clear_deploy_enabled_override(tmp_path, "sacrifice") is True
    # File survives (other key remains); only deploy_enabled is gone.
    data = runtime_state.read_runtime_state(tmp_path, "sacrifice")
    assert data == {"other": 1}


# --------------------------------------------------------------------------- #
# config.yaml operator edit and machine override do not collide
# --------------------------------------------------------------------------- #


def test_config_edit_and_override_are_independent(tmp_path: Path) -> None:
    cfg_path = _write_config(tmp_path, "sacrifice", enabled=True)
    original_config = cfg_path.read_bytes()

    # Machine sets an override — config.yaml is untouched.
    runtime_state.set_deploy_enabled_override(tmp_path, "sacrifice", False)
    assert cfg_path.read_bytes() == original_config

    cfg = load_app_config("sacrifice", tmp_path)
    assert cfg.deploy.enabled is True  # operator default intact
    assert runtime_state.effective_deploy_enabled(cfg, tmp_path) is False

    # Operator "settings deploy" rewrites config.yaml (still enabled=true) —
    # the machine override survives (a config deploy can't clobber it).
    cfg_path.write_text(original_config.decode(), encoding="utf-8")
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is False

    # Operator later flips config default to false; override still wins until
    # cleared (single source of truth per fact — the runtime override).
    _write_config(tmp_path, "sacrifice", enabled=False)
    cfg2 = load_app_config("sacrifice", tmp_path)
    assert runtime_state.effective_deploy_enabled(cfg2, tmp_path) is False


# --------------------------------------------------------------------------- #
# Corrupt / non-bool files degrade to "no override"
# --------------------------------------------------------------------------- #


def test_corrupt_json_is_no_override(tmp_path: Path) -> None:
    path = runtime_state.runtime_state_path(tmp_path, "sacrifice")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not valid json", encoding="utf-8")
    assert runtime_state.read_runtime_state(tmp_path, "sacrifice") == {}
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is None


def test_non_mapping_json_is_no_override(tmp_path: Path) -> None:
    path = runtime_state.runtime_state_path(tmp_path, "sacrifice")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[1, 2, 3]", encoding="utf-8")
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is None


def test_non_bool_override_value_is_ignored(tmp_path: Path) -> None:
    runtime_state._write_runtime_state(tmp_path, "sacrifice", {"deploy_enabled": "false"})
    # A string "false" is NOT a bool → treated as no override.
    assert runtime_state.get_deploy_enabled_override(tmp_path, "sacrifice") is None
    assert runtime_state.effective_deploy_enabled(_cfg(enabled=True), tmp_path) is True


# --------------------------------------------------------------------------- #
# Observability
# --------------------------------------------------------------------------- #


def test_describe_reports_config_default_when_no_override(tmp_path: Path) -> None:
    desc = runtime_state.describe_deploy_enabled(_cfg(enabled=True), tmp_path)
    assert desc == {
        "app": "sacrifice",
        "config_default": True,
        "override": None,
        "effective": True,
        "source": "config_default",
    }


def test_describe_reports_runtime_override_when_set(tmp_path: Path) -> None:
    runtime_state.set_deploy_enabled_override(tmp_path, "sacrifice", False)
    desc = runtime_state.describe_deploy_enabled(_cfg(enabled=True), tmp_path)
    assert desc == {
        "app": "sacrifice",
        "config_default": True,
        "override": False,
        "effective": False,
        "source": "runtime_override",
    }
