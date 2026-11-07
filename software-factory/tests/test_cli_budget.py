"""Tests for ``factory budget`` CLI command."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlmodel import Session
from typer.testing import CliRunner

from factory.runner import Run, _engine


@pytest.fixture
def seeded_root(tmp_path: Path) -> Path:
    """Seed the runs table with a few rows so ``budget`` has numbers."""
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    db = tmp_path / "state" / "factory.db"
    eng = _engine(db)
    now = datetime.now(UTC).isoformat()
    with Session(eng) as session:
        for cost in (0.01, 0.02, 0.03):
            session.add(
                Run(
                    ts=now,
                    persona="pm",
                    model="deepseek/x",
                    mode="text",
                    tokens_in=10,
                    tokens_out=20,
                    cost_usd=cost,
                    success=True,
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


def test_budget_shows_totals_and_recent_runs(seeded_root: Path) -> None:
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["budget"])
    assert result.exit_code == 0, result.stdout
    # 0.01 + 0.02 + 0.03 = $0.0600 today.
    assert "$0.0600" in result.stdout, result.stdout
    # Daily cap from defaults is $10.
    assert "daily_cap_usd" in result.stdout
    # last 5 runs section is present.
    assert "last 5 runs" in result.stdout
    assert "pm" in result.stdout
    # No unpriced-model runs seeded — the blindness panel must not appear.
    assert "unpriced-model blindness" not in result.stdout


def test_budget_surfaces_unpriced_model_blindness(seeded_root: Path) -> None:
    """2026-08-08 fix: a run that burned tokens but recorded cost_usd=0.0
    with usage_reliable=False (the live ``azure/DeepSeek-V4-Flash`` /
    ``azure/Kimi-K2.7-Code`` incident before they were priced) must be
    surfaced by name in ``factory budget`` — today_spend_usd is blind to it,
    so the operator needs a separate signal."""
    db = seeded_root / "state" / "factory.db"
    eng = _engine(db)
    now = datetime.now(UTC).isoformat()
    with Session(eng) as session:
        session.add(
            Run(
                ts=now,
                persona="dev",
                model="azure/some-unpriced-model",
                mode="sandbox",
                tokens_in=50_000,
                tokens_out=8_000,
                cost_usd=0.0,
                success=True,
                usage_reliable=False,
            )
        )
        session.commit()

    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["budget"])
    assert result.exit_code == 0, result.stdout
    assert "unpriced-model blindness" in result.stdout
    assert "azure/some-unpriced-model" in result.stdout
