"""Tests for the D003 per-unit audit rollup (``factory.settings.audit``)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import Session

from factory.runner import Run, _engine
from factory.settings.audit import (
    CHAIN_PERSONAS,
    _model_cost_is_estimated,
    build_audit_report,
    count_unattributed_chain_runs,
)


def _seed(db_path: Path, rows: list[dict]) -> None:
    eng = _engine(db_path)
    now = datetime.now(UTC).isoformat()
    with Session(eng) as session:
        for r in rows:
            session.add(
                Run(
                    ts=r.get("ts", now),
                    persona=r["persona"],
                    model=r.get("model", "deepseek/x"),
                    mode=r.get("mode", "sandbox"),
                    tokens_in=r.get("tokens_in", 100),
                    tokens_out=r.get("tokens_out", 50),
                    cost_usd=r.get("cost_usd", 0.01),
                    duration_s=r.get("duration_s", 5.0),
                    success=r.get("success", True),
                    story_id=r.get("story_id"),
                    direction_id=r.get("direction_id"),
                    app=r.get("app"),
                )
            )
        session.commit()


def test_chain_personas_is_the_d003_acceptance_set() -> None:
    """docs_enforcer is deliberately excluded — it's a deterministic scan
    with no LLM call and therefore never produces a runs row."""
    assert CHAIN_PERSONAS == {
        "sm",
        "dev",
        "reviewer",
        "tech_writer",
        "onboarder",
        "test_implementer",
    }
    assert "docs_enforcer" not in CHAIN_PERSONAS


def test_rollup_by_story_direction_and_app(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    _seed(
        db,
        [
            {
                "persona": "dev",
                "story_id": 1,
                "direction_id": "d-1",
                "app": "sacrifice",
                "cost_usd": 0.10,
                "tokens_in": 1000,
                "tokens_out": 200,
                "duration_s": 30.0,
            },
            {
                "persona": "reviewer",
                "story_id": 1,
                "direction_id": "d-1",
                "app": "sacrifice",
                "cost_usd": 0.05,
                "tokens_in": 500,
                "tokens_out": 100,
                "duration_s": 10.0,
            },
            {
                "persona": "dev",
                "story_id": 2,
                "direction_id": "d-2",
                "app": "sacrifice",
                "cost_usd": 0.20,
                "tokens_in": 2000,
                "tokens_out": 400,
                "duration_s": 60.0,
            },
        ],
    )

    report = build_audit_report(tmp_path, days=7)

    assert report.total_run_count == 3
    assert report.total_cost_usd == 0.35

    by_story = {row.key: row for row in report.by_story}
    assert by_story["1"].run_count == 2
    assert by_story["1"].cost_usd == 0.15
    assert by_story["1"].tokens_in == 1500
    assert by_story["2"].cost_usd == 0.20

    by_direction = {row.key: row for row in report.by_direction}
    assert by_direction["d-1"].cost_usd == 0.15
    assert by_direction["d-2"].cost_usd == 0.20

    by_app = {row.key: row for row in report.by_app}
    assert by_app["sacrifice"].run_count == 3
    assert by_app["sacrifice"].cost_usd == 0.35


def test_unattributed_counts_chain_persona_runs_with_null_story_id(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    _seed(
        db,
        [
            # Attributed dev run — NOT unattributed.
            {"persona": "dev", "story_id": 5, "app": "sacrifice", "cost_usd": 0.10},
            # Unattributed chain-persona runs (NULL story_id).
            {"persona": "dev", "story_id": None, "cost_usd": 0.20},
            {"persona": "sm", "story_id": None, "cost_usd": 0.05},
            # App-level scheduled persona with a legitimately-NULL story_id —
            # NOT a chain persona, so it must NOT count as unattributed.
            {"persona": "security", "story_id": None, "app": "sacrifice", "cost_usd": 0.30},
            # docs_enforcer is excluded from CHAIN_PERSONAS even if a stray
            # row existed with that persona name.
            {"persona": "docs_enforcer", "story_id": None, "cost_usd": 0.40},
        ],
    )

    report = build_audit_report(tmp_path, days=7)
    assert report.unattributed.run_count == 2
    assert report.unattributed.cost_usd == 0.25
    assert report.unattributed.by_persona == {"dev": 1, "sm": 1}

    assert count_unattributed_chain_runs(tmp_path, days=7) == 2


def test_rollup_respects_window(tmp_path: Path) -> None:
    """Runs older than the window are excluded from every rollup."""
    db = tmp_path / "state" / "factory.db"
    old_ts = datetime(2020, 1, 1, tzinfo=UTC).isoformat()
    _seed(
        db,
        [
            {"persona": "dev", "story_id": 1, "app": "sacrifice", "cost_usd": 0.10, "ts": old_ts},
            {"persona": "dev", "story_id": 2, "app": "sacrifice", "cost_usd": 0.20},
        ],
    )
    report = build_audit_report(tmp_path, days=7)
    assert report.total_run_count == 1
    assert report.total_cost_usd == 0.20


# --------------------------------------------------------------------------- #
# Cost-accuracy caveat: flag spend priced with an ESTIMATED cache-read rate.
# --------------------------------------------------------------------------- #


def test_model_cost_is_estimated_flags_deepseek_v4_pro() -> None:
    """azure/deepseek-v4-pro's cache-read rate has no published Azure meter
    and is registered with an ``factory_cost_note`` flagging it as an
    estimate — this must be detected via live introspection of LiteLLM's
    price table, not a hardcoded model list."""
    assert _model_cost_is_estimated("azure/deepseek-v4-pro") is True


def test_model_cost_is_estimated_false_for_published_rates() -> None:
    """azure/gpt-5.4 uses LiteLLM's built-in published rate — no estimate
    caveat applies."""
    assert _model_cost_is_estimated("azure/gpt-5.4") is False
    assert _model_cost_is_estimated("totally-unknown-model-xyz") is False


def test_audit_report_surfaces_estimated_cost_share(tmp_path: Path) -> None:
    """Spend on a model with an estimated cache-read rate is called out as
    a percentage + dollar amount + the affected model list — not silently
    blended into total_cost_usd with no indication it's a guess."""
    db = tmp_path / "state" / "factory.db"
    _seed(
        db,
        [
            {
                "persona": "dev",
                "story_id": 1,
                "app": "sacrifice",
                "model": "azure/deepseek-v4-pro",
                "cost_usd": 0.30,
            },
            {
                "persona": "reviewer",
                "story_id": 1,
                "app": "sacrifice",
                "model": "azure/gpt-5.4",
                "cost_usd": 0.70,
            },
        ],
    )

    report = build_audit_report(tmp_path, days=7)
    assert report.total_cost_usd == 1.00
    assert report.estimated_cost_usd == 0.30
    assert report.estimated_cost_pct == 30.0
    assert report.estimated_models == ("azure/deepseek-v4-pro",)

    by_story = {row.key: row for row in report.by_story}
    # The story mixes an estimated-rate run with a published-rate run — the
    # bucket must be flagged since SOME of its cost is a guess.
    assert by_story["1"].has_estimated_cost is True


def test_audit_report_no_estimate_flag_when_no_estimated_model_present(
    tmp_path: Path,
) -> None:
    db = tmp_path / "state" / "factory.db"
    _seed(
        db,
        [
            {
                "persona": "dev",
                "story_id": 1,
                "app": "sacrifice",
                "model": "azure/gpt-5.4",
                "cost_usd": 0.10,
            },
        ],
    )
    report = build_audit_report(tmp_path, days=7)
    assert report.estimated_cost_usd == 0.0
    assert report.estimated_cost_pct == 0.0
    assert report.estimated_models == ()
    assert report.by_story[0].has_estimated_cost is False
