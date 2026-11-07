"""Tests for the ``factory audit`` CLI command (D003)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlmodel import Session
from typer.testing import CliRunner

from factory.runner import Run, _engine


@pytest.fixture
def seeded_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    db = tmp_path / "state" / "factory.db"
    eng = _engine(db)
    now = datetime.now(UTC).isoformat()
    with Session(eng) as session:
        session.add(
            Run(
                ts=now,
                persona="dev",
                model="azure/deepseek-v4-pro",
                mode="sandbox",
                tokens_in=1000,
                tokens_out=200,
                cost_usd=0.15,
                duration_s=42.0,
                success=True,
                story_id=9,
                direction_id="d-9",
                app="sacrifice",
            )
        )
        session.add(
            Run(
                ts=now,
                persona="dev",
                model="azure/deepseek-v4-pro",
                mode="sandbox",
                tokens_in=500,
                tokens_out=100,
                cost_usd=0.05,
                duration_s=10.0,
                success=False,
                story_id=None,
                direction_id=None,
                app=None,
            )
        )
        session.commit()
    return tmp_path


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_audit_shows_rollups_and_unattributed(seeded_root: Path) -> None:
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["audit"])
    assert result.exit_code == 0, result.stdout
    assert "total_cost_usd=$0.2000" in result.stdout
    assert "by story" in result.stdout
    assert "by direction" in result.stdout
    assert "by app" in result.stdout
    assert "9" in result.stdout  # story_id row
    assert "d-9" in result.stdout  # direction_id row
    assert "sacrifice" in result.stdout
    # The unattributed dev run (NULL story_id) is surfaced.
    assert "unattributed" in result.stdout
    assert "runs=1" in result.stdout
    assert "cost_usd=$0.0500" in result.stdout
    assert "dev=1" in result.stdout


def test_audit_reconcile_flag_prints_note(seeded_root: Path) -> None:
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["audit", "--reconcile"])
    assert result.exit_code == 0, result.stdout
    assert "reconciliation" in result.stdout
    assert "Azure Cost" in result.stdout
    assert "DeepSeek dashboard" in result.stdout


def test_audit_days_option_narrows_window(seeded_root: Path) -> None:
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["audit", "--days", "1"])
    assert result.exit_code == 0, result.stdout
    assert "window=1d" in result.stdout


def test_audit_flags_estimated_cache_rate_spend(seeded_root: Path) -> None:
    """Both seeded rows use azure/deepseek-v4-pro, whose cache-read rate is
    an ESTIMATE (no published Azure meter) — the operator must see that,
    not just a blended cost_usd that reads as exact."""
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["audit"])
    assert result.exit_code == 0, result.stdout
    assert "~estimated=100.0%" in result.stdout
    assert "cost-accuracy caveat" in result.stdout
    assert "azure/deepseek-v4-pro" in result.stdout
    # The attributed story-9 row is marked with the ``~`` prefix.
    assert "~9" in result.stdout


def test_audit_no_estimate_marker_for_published_rate_models(tmp_path: Path) -> None:
    """A window whose spend is entirely on a published-rate model (no
    ``factory_cost_note``) must NOT show the estimate marker/footnote —
    the flag should only fire when it's actually true."""
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    db = tmp_path / "state" / "factory.db"
    eng = _engine(db)
    now = datetime.now(UTC).isoformat()
    with Session(eng) as session:
        session.add(
            Run(
                ts=now,
                persona="dev",
                model="azure/gpt-5.4",
                mode="sandbox",
                tokens_in=100,
                tokens_out=20,
                cost_usd=0.02,
                duration_s=5.0,
                success=True,
                story_id=1,
                direction_id="d-1",
                app="sacrifice",
            )
        )
        session.commit()

    runner, cli_mod = _runner_with_root(tmp_path)
    result = runner.invoke(cli_mod.app, ["audit"])
    assert result.exit_code == 0, result.stdout
    assert "~estimated" not in result.stdout
    assert "cost-accuracy caveat" not in result.stdout
    assert "~1" not in result.stdout
