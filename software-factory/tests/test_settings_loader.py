"""Tests for ``factory.settings.loader``."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.settings.loader import (
    FactorySettings,
    is_valid_mode,
    load_settings,
    reload_settings,
)


def test_missing_file_returns_defaults(tmp_path: Path) -> None:
    settings = load_settings(tmp_path)
    assert isinstance(settings, FactorySettings)
    assert settings.caps.daily_spend_usd == 10.0
    assert "normal" in settings.modes.available
    assert settings.modes.default == "normal"


def test_explicit_file_overrides_defaults(tmp_path: Path) -> None:
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  daily_spend_usd: 0.5\n  hourly_spend_usd: 0.1\n",
        encoding="utf-8",
    )
    settings = reload_settings(tmp_path)
    assert settings.caps.daily_spend_usd == 0.5
    assert settings.caps.hourly_spend_usd == 0.1


def test_invalid_default_mode_raises(tmp_path: Path) -> None:
    (tmp_path / "factory_settings.yaml").write_text(
        "modes:\n  default: bogus\n  available: [normal, paused]\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="modes.default"):
        reload_settings(tmp_path)


def test_top_level_not_mapping_raises(tmp_path: Path) -> None:
    (tmp_path / "factory_settings.yaml").write_text("- foo\n- bar\n", encoding="utf-8")
    with pytest.raises(ValueError, match="top-level must be a YAML mapping"):
        reload_settings(tmp_path)


def test_is_valid_mode() -> None:
    s = FactorySettings()
    assert is_valid_mode("normal", s)
    assert is_valid_mode("paused", s)
    assert not is_valid_mode("not-a-mode", s)


def test_auto_merge_defaults_when_section_missing(tmp_path: Path) -> None:
    """When ``factory_settings.yaml`` omits ``auto_merge:``, the loader
    yields the documented defaults: off, squash, wait-for-ci, delete-
    branch-after-merge."""
    settings = load_settings(tmp_path)
    assert settings.auto_merge.enabled is False
    assert settings.auto_merge.trigger == "end_of_tick"
    assert settings.auto_merge.merge_method == "squash"
    assert settings.auto_merge.delete_branch_after_merge is True
    assert settings.auto_merge.wait_for_ci is True


def test_auto_merge_overrides_parse(tmp_path: Path) -> None:
    """Custom ``auto_merge:`` values round-trip through the loader."""
    (tmp_path / "factory_settings.yaml").write_text(
        "auto_merge:\n"
        "  enabled: true\n"
        "  trigger: end_of_tick\n"
        "  merge_method: rebase\n"
        "  delete_branch_after_merge: false\n"
        "  wait_for_ci: false\n",
        encoding="utf-8",
    )
    settings = reload_settings(tmp_path)
    assert settings.auto_merge.enabled is True
    assert settings.auto_merge.merge_method == "rebase"
    assert settings.auto_merge.delete_branch_after_merge is False
    assert settings.auto_merge.wait_for_ci is False


def test_reload_busts_the_cache(tmp_path: Path) -> None:
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  daily_spend_usd: 1.0\n", encoding="utf-8"
    )
    a = load_settings(tmp_path)
    assert a.caps.daily_spend_usd == 1.0
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  daily_spend_usd: 99.0\n", encoding="utf-8"
    )
    # load_settings without reload returns the cached value.
    a2 = load_settings(tmp_path)
    assert a2.caps.daily_spend_usd == 1.0
    b = reload_settings(tmp_path)
    assert b.caps.daily_spend_usd == 99.0
