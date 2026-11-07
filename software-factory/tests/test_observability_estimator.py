"""Tests for the EBS estimator: baselines + Monte Carlo ETAs."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlmodel import Session

from factory.chain.state_machine import StoryRecord, StoryState
from factory.observability.estimator import (
    N_VELOCITY_MIN,
    baseline_seconds,
    completed_handlers_for_story,
    estimate_story_seconds,
    monte_carlo_eta,
    recompute_baselines,
    remaining_handlers_for_story,
    total_handlers_for_chain,
    velocity_samples,
)
from factory.runner import Run, _engine

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _seed_story(db: Path, **kwargs) -> StoryRecord:
    """Insert a StoryRecord and return it with id populated."""
    eng = _engine(db)
    defaults = dict(
        direction_id="007-foo",
        app="sacrifice",
        title="seed story",
        slug="seed-story",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        chain_kind="tdd",
        story_file_path="stories/0-seed.md",
    )
    defaults.update(kwargs)
    story = StoryRecord(**defaults)
    with Session(eng) as session:
        session.add(story)
        session.commit()
        session.refresh(story)
    return story


def _seed_run(
    db: Path,
    *,
    persona: str,
    model: str,
    duration_s: float,
    story_id: int,
    success: bool = True,
    ts: str | None = None,
) -> None:
    eng = _engine(db)
    with Session(eng) as session:
        session.add(
            Run(
                ts=ts or datetime.now(UTC).isoformat(),
                persona=persona,
                model=model,
                mode="text",
                tokens_in=10,
                tokens_out=10,
                cost_usd=0.01,
                success=success,
                duration_s=duration_s,
                story_id=story_id,
            )
        )
        session.commit()


# --------------------------------------------------------------------------- #
# Remaining-handlers map sanity
# --------------------------------------------------------------------------- #


def test_remaining_handlers_for_fresh_tdd_story() -> None:
    """A STORY_CREATED tdd story has the full chain remaining."""
    rem = remaining_handlers_for_story("story_created", "tdd")
    assert "sm" in rem and "dev" in rem and "tech_writer" in rem
    assert total_handlers_for_chain("tdd") == len(rem)


def test_completed_handlers_increases_with_state() -> None:
    """Each state advance reduces remaining and increases completed."""
    a = completed_handlers_for_story("story_created", "tdd")
    b = completed_handlers_for_story("sm_done", "tdd")
    c = completed_handlers_for_story("dev_in_progress", "tdd")
    assert a == 0
    assert b > a
    assert c > b


def test_docs_chain_has_different_remaining() -> None:
    rem = remaining_handlers_for_story("story_created", "docs")
    assert "onboarder" in rem
    assert "dev" not in rem


# --------------------------------------------------------------------------- #
# Baselines
# --------------------------------------------------------------------------- #


def test_recompute_baselines_writes_medians(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    s = _seed_story(db, points=3)
    # 5 dev runs at 100, 200, 300, 400, 500 seconds — median is 300.
    for d in (100.0, 200.0, 300.0, 400.0, 500.0):
        _seed_run(db, persona="dev", model="claude-opus-4-7", duration_s=d, story_id=s.id)

    n = recompute_baselines(db)
    assert n >= 1

    median, sample_count = baseline_seconds(db, persona="dev", points=3)
    assert median == pytest.approx(300.0)
    assert sample_count == 5


def test_baseline_seconds_returns_none_when_empty(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    median, n = baseline_seconds(db, persona="dev", points=5)
    assert median is None
    assert n == 0


def test_estimate_story_seconds_uses_cold_start_when_no_history(tmp_path: Path) -> None:
    """Fresh DB: estimator falls back to cold-start tables, not None."""
    db = tmp_path / "factory.db"
    est = estimate_story_seconds(db_path=db, points=3, chain_kind="tdd")
    assert est is not None and est > 0


def test_estimate_story_seconds_uses_baselines_when_available(tmp_path: Path) -> None:
    """A populated baseline overrides the cold-start fallback."""
    db = tmp_path / "factory.db"
    s = _seed_story(db, points=3)
    # Seed sm baseline of 999s — wildly different from cold start.
    for _ in range(N_VELOCITY_MIN):
        _seed_run(db, persona="sm", model="claude-sonnet-4-6", duration_s=999.0, story_id=s.id)
    recompute_baselines(db)

    est_cold = estimate_story_seconds(db_path=db, points=3, chain_kind="tdd")
    assert est_cold is not None
    # Should include the 999s sm baseline (>> the 60s cold-start sm baseline).
    assert est_cold > 900


# --------------------------------------------------------------------------- #
# Monte Carlo
# --------------------------------------------------------------------------- #


def test_monte_carlo_returns_insufficient_data_for_fresh_direction(
    tmp_path: Path,
) -> None:
    """With zero history, the simulator refuses to invent an ETA."""
    db = tmp_path / "factory.db"
    _seed_story(db, points=3, direction_id="099-fresh")
    result = monte_carlo_eta(db, direction_id="099-fresh", app="sacrifice")
    assert result.insufficient_data is True
    assert result.p50_seconds == 0.0


def test_monte_carlo_returns_eta_with_enough_samples(tmp_path: Path) -> None:
    """Given sufficient samples for every remaining persona, ETA is produced."""
    db = tmp_path / "factory.db"

    # Two stories on the same direction; both completed early so they
    # contribute history without dragging the simulator's "remaining work"
    # bucket.
    s_done_1 = _seed_story(
        db, points=3, slug="s1", direction_id="100-rich", state="deployed"
    )
    s_done_2 = _seed_story(
        db, points=3, slug="s2", direction_id="100-rich", state="deployed"
    )
    # One in-flight story whose ETA we'll project.
    _seed_story(
        db,
        points=3,
        slug="s3",
        direction_id="100-rich",
        state=StoryState.STORY_CREATED.value,
    )

    # Seed 5+ samples per persona across the two completed stories.
    for persona in (
        "sm",
        "test_designer",
        "test_implementer",
        "dev",
        "reviewer",
        "tech_writer",
    ):
        for k, target_story in enumerate(
            [s_done_1.id, s_done_1.id, s_done_2.id, s_done_2.id, s_done_2.id]
        ):
            _seed_run(
                db,
                persona=persona,
                model="claude-sonnet-4-6",
                duration_s=60.0 + k,
                story_id=target_story,
            )

    recompute_baselines(db)

    result = monte_carlo_eta(
        db, direction_id="100-rich", app="sacrifice", iterations=200, seed=1
    )
    assert result.insufficient_data is False, result.reason
    assert result.p50_seconds > 0
    assert result.p75_seconds >= result.p50_seconds
    assert result.p95_seconds >= result.p75_seconds
    assert result.iterations == 200
    # Sanity: a single fresh story's ETA shouldn't be wildly large with
    # 60-second per-handler samples.
    assert result.p95_seconds < 60 * 60 * 10  # < 10 hours


def test_velocity_samples_returns_clamped_floats(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    s = _seed_story(db, points=3)
    for _ in range(N_VELOCITY_MIN):
        _seed_run(
            db, persona="dev", model="claude-opus-4-7", duration_s=60.0, story_id=s.id
        )
    recompute_baselines(db)

    samples = velocity_samples(db, persona="dev", lookback_days=30)
    assert len(samples) == N_VELOCITY_MIN
    for v in samples:
        # estimate / actual; with all durations equal and median == 60.0,
        # velocities should cluster at 1.0.
        assert v == pytest.approx(1.0, abs=0.0001)
