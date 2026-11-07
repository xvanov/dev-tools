"""Tests for the detector -> direction trigger (019 AC7 / Flow D).

No LLM, no network: every detector reads plain files/sqlite under a
``tmp_path``-rooted factory root, so these tests seed exactly the on-disk
shape a detector expects and exercise the real adapter + dedupe + filing
path end to end.

Review round 2 additions are grouped by finding id (S1, S2, ...) so they can
be cross-referenced against the review that required them.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import yaml
from sqlmodel import Session, SQLModel, create_engine

from factory.backpressure.vacuity import classify_criterion
from factory.backpressure.validator import validate_direction
from factory.chain import detector_watch as dw
from factory.chain.state_machine import StoryRecord
from factory.directions.approval import (
    awaiting_operator_approval,
    is_auto_buildable,
    requires_operator_approval,
)
from factory.directions.parser import parse_direction_dir
from factory.manager.detectors import DETECTORS


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    apps_dir = tmp_path / "apps" / "sacrifice" / "directions"
    apps_dir.mkdir(parents=True)
    (tmp_path / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\n", encoding="utf-8"
    )
    (tmp_path / "state" / "events").mkdir(parents=True)
    return tmp_path


def _direction_dirs(root: Path, app: str = "sacrifice") -> list[Path]:
    d = root / "apps" / app / "directions"
    return sorted(p for p in d.iterdir() if p.is_dir())


def _seed_story(db_path: Path, *, app: str, state: str = "tests_green") -> int:
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    story = StoryRecord(
        direction_id="001",
        app=app,
        title="seeded story",
        slug="d001-seeded-story",
        scope="backend",
        state=state,
        chain_kind="tdd",
    )
    with Session(eng) as session:
        session.add(story)
        session.commit()
        session.refresh(story)
        assert story.id is not None
        return story.id


def _set_story_state(db_path: Path, story_id: int, state: str) -> None:
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    with Session(eng) as session:
        story = session.get(StoryRecord, story_id)
        assert story is not None
        story.state = state
        session.add(story)
        session.commit()


def _append_ndjson(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def _seed_review_churn(root: Path, story_id: int, *, cycles: int = 4) -> None:
    """Write enough RECENT successful reviewer/dev runs to trip
    ``review_churn`` (default floor: ``reviewer_cycles >= 3``) AND its
    liveness check (S1: ``active_in_window`` against ``liveness_since``)."""
    now = datetime.now(UTC)
    records = []
    for i in range(cycles):
        ts = (now - timedelta(minutes=(cycles - i) * 5)).isoformat()
        records.append(
            {"ts": ts, "success": True, "persona": "reviewer", "story_id": story_id, "cost_usd": 0.10}
        )
        records.append(
            {"ts": ts, "success": True, "persona": "dev", "story_id": story_id, "cost_usd": 0.20}
        )
    _append_ndjson(root / "state" / "events" / "runs.ndjson", records)


# --------------------------------------------------------------------------- #
# The AC's own verification: a seeded fault firing twice yields ONE direction.
# --------------------------------------------------------------------------- #


def test_seeded_fault_fires_twice_yields_one_direction(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    first = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(first.filed) == 1
    assert first.filed[0].detector == "review_churn"
    assert first.filed[0].subject == f"story-{story_id}"
    assert first.deduped == []

    dirs = _direction_dirs(factory_root)
    assert len(dirs) == 1
    md_text = (dirs[0] / "direction.md").read_text(encoding="utf-8")
    assert "detector-signature: review_churn" in md_text
    state_text = (dirs[0] / "state.yaml").read_text(encoding="utf-8")
    assert "detector-review_churn" in state_text

    second = dw.detector_watch_tick(factory_root, "sacrifice")
    assert second.filed == []
    assert len(second.deduped) == 1
    assert second.deduped[0] == ("review_churn", f"story-{story_id}")
    assert len(_direction_dirs(factory_root)) == 1


def test_recurring_windowed_fault_dedupes_across_ticks(factory_root: Path) -> None:
    """Same as the AC test above, but for a genuinely WINDOWED detector
    (``retry_storm``) rather than the only cumulative one — closes the
    test-quality gap where the AC test could pass vacuously for windowed
    detectors. The fault recurs (a NEW failure of the same (story, persona)
    pair in the SECOND tick's window) rather than the marker simply
    advancing past stale evidence."""
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    runs = factory_root / "state" / "events" / "runs.ndjson"
    _append_ndjson(
        runs,
        [
            {
                "ts": datetime.now(UTC).isoformat(),
                "success": False,
                "persona": "dev",
                "story_id": story_id,
                "error": "boom-1",
            }
        ],
    )

    first = dw.detector_watch_tick(factory_root, "sacrifice")
    retry_filed = [f for f in first.filed if f.detector == "retry_storm"]
    assert len(retry_filed) == 1

    # A NEW failure of the SAME (story, persona) pair, recorded AFTER tick 1
    # (so it falls inside tick 2's incremental window) — same subject, same
    # signature, must dedupe rather than re-file.
    _append_ndjson(
        runs,
        [
            {
                "ts": datetime.now(UTC).isoformat(),
                "success": False,
                "persona": "dev",
                "story_id": story_id,
                "error": "boom-2",
            }
        ],
    )
    second = dw.detector_watch_tick(factory_root, "sacrifice")
    retry_deduped = [d for d in second.deduped if d[0] == "retry_storm"]
    assert len(retry_deduped) == 1
    assert [f for f in second.filed if f.detector == "retry_storm"] == []


# --------------------------------------------------------------------------- #
# Adapter coverage must never silently drift from the registry.
# --------------------------------------------------------------------------- #


def test_adapter_coverage_matches_registry() -> None:
    assert set(dw._ADAPTERS) == set(DETECTORS)


# --------------------------------------------------------------------------- #
# S6: a crashing OR wrong-shaped detector must never break the whole pass.
# --------------------------------------------------------------------------- #


def test_crashing_detector_does_not_break_the_pass(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    def _boom(ctx: object) -> list[dw.Firing]:
        raise RuntimeError("boom")

    monkeypatch.setitem(dw._ADAPTERS, "cost_spike", _boom)

    result = dw.detector_watch_tick(factory_root, "sacrifice")

    assert ("cost_spike", "RuntimeError('boom')") in result.errors
    assert "cost_spike" not in result.ran
    # The other 10 detectors still ran, and review_churn's real firing still
    # made it all the way to filing.
    assert "review_churn" in result.ran
    assert len(result.filed) == 1


@pytest.mark.parametrize(
    "bad_return",
    [None, "a string", [1, 2, 3], [{"subject": "x", "evidence": {}}]],
    ids=["none", "str", "list-of-int", "list-of-dict"],
)
def test_wrong_shaped_adapter_return_is_recorded_not_raised(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch, bad_return: object
) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    def _wrong(ctx: object) -> object:
        return bad_return

    monkeypatch.setitem(dw._ADAPTERS, "cost_spike", _wrong)

    result = dw.detector_watch_tick(factory_root, "sacrifice")

    assert "cost_spike" not in result.ran
    assert any(name == "cost_spike" for name, _ in result.errors)
    # Every other detector, including the one with the real seeded firing,
    # still ran and filed.
    assert "review_churn" in result.ran
    assert len(result.filed) == 1


# --------------------------------------------------------------------------- #
# S4: signature normalization must be whitespace-safe (marker round-trip).
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw_subject",
    [
        "story 142 with spaces",
        "path/with/-->comment/escape",
        "weird >< characters",
        "ünïcödé/wörktree/páth",
        "x" * 300,
    ],
    ids=["spaces", "comment-escape", "angle-brackets", "unicode", "300-chars"],
)
def test_signature_marker_round_trips_adversarial_subjects(raw_subject: str) -> None:
    sig = dw.signature_for("review_churn", raw_subject)
    marker = dw._signature_marker(sig)
    found = dw._SIGNATURE_MARKER_RE.findall(marker)
    assert found == [sig]
    assert " " not in sig


# --------------------------------------------------------------------------- #
# S1: liveness + recency scoping — a stale/terminal-state fault must not fire.
# --------------------------------------------------------------------------- #


def test_review_churn_does_not_fire_on_a_deployed_story(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice", state="deployed")
    # Ancient churn: last reviewer run weeks ago, well outside the liveness
    # lookback, on a story that has since shipped.
    old_ts = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    _append_ndjson(
        factory_root / "state" / "events" / "runs.ndjson",
        [
            {"ts": old_ts, "success": True, "persona": "reviewer", "story_id": story_id, "cost_usd": 0.1}
            for _ in range(4)
        ],
    )

    result = dw.detector_watch_tick(factory_root, "sacrifice")
    assert result.filed == []
    assert not any(d == "review_churn" for d, _ in result.deduped)
    assert not any(d == "review_churn" for d, _ in result.capped)


def test_review_churn_does_not_fire_on_a_terminal_state_even_if_recent(
    factory_root: Path,
) -> None:
    """Recent activity, but the story is already in a terminal state
    (converged) — still must not fire."""
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice", state="closed_by_operator")
    _seed_review_churn(factory_root, story_id)

    result = dw.detector_watch_tick(factory_root, "sacrifice")
    assert not any(f.detector == "review_churn" for f in result.filed)


def test_state_distribution_skew_ignores_terminal_states(factory_root: Path) -> None:
    """A backlog dominated by ``deployed`` (fully shipped) must not read as
    skewed just because terminal states are counted in the denominator: a
    BALANCED non-terminal set (not exceeding the threshold on its own) must
    not fire, even though ``deployed`` alone would dwarf every other bucket
    if it were included."""
    now = datetime.now(UTC).isoformat()
    _append_ndjson(
        factory_root / "state" / "events" / "queue.ndjson",
        [
            {
                "event": "queue_snapshot",
                "ts": now,
                "app": "sacrifice",
                "counts_by_state": {
                    "deployed": 100,
                    "dev_in_progress": 5,
                    "reviewer_requested_changes": 5,
                },
            }
        ],
    )
    ctx = dw._AdapterCtx(
        root=factory_root,
        app="sacrifice",
        since=datetime.now(UTC) - timedelta(hours=1),
        liveness_since=datetime.now(UTC) - dw._LIVENESS_LOOKBACK,
    )
    firings = dw._adapter_state_distribution_skew(ctx)
    assert firings == []  # 5/10 non-terminal = 0.5, not > 0.5 threshold


def test_state_distribution_skew_fires_on_real_non_terminal_skew(factory_root: Path) -> None:
    now = datetime.now(UTC).isoformat()
    _append_ndjson(
        factory_root / "state" / "events" / "queue.ndjson",
        [
            {
                "event": "queue_snapshot",
                "ts": now,
                "app": "sacrifice",
                "counts_by_state": {
                    "deployed": 50,
                    "dev_in_progress": 8,
                    "reviewer_requested_changes": 1,
                },
            }
        ],
    )
    ctx = dw._AdapterCtx(
        root=factory_root,
        app="sacrifice",
        since=datetime.now(UTC) - timedelta(hours=1),
        liveness_since=datetime.now(UTC) - dw._LIVENESS_LOOKBACK,
    )
    firings = dw._adapter_state_distribution_skew(ctx)
    assert len(firings) == 1
    assert firings[0].subject == "state-skew:dev_in_progress"
    assert firings[0].evidence["total_non_terminal"] == 9


def test_state_distribution_skew_requires_a_minimum_sample(factory_root: Path) -> None:
    """Review round 3: 2 non-terminal stories both in the SAME state is a
    100% fraction by pure arithmetic, not a skew — this must not fire."""
    now = datetime.now(UTC).isoformat()
    _append_ndjson(
        factory_root / "state" / "events" / "queue.ndjson",
        [
            {
                "event": "queue_snapshot",
                "ts": now,
                "app": "sacrifice",
                "counts_by_state": {"deployed": 50, "deploy_pending": 2},
            }
        ],
    )
    ctx = dw._AdapterCtx(
        root=factory_root,
        app="sacrifice",
        since=datetime.now(UTC) - timedelta(hours=1),
        liveness_since=datetime.now(UTC) - dw._LIVENESS_LOOKBACK,
    )
    firings = dw._adapter_state_distribution_skew(ctx)
    assert firings == []


# --------------------------------------------------------------------------- #
# S8: runs_failed_since is deliberately inert.
# --------------------------------------------------------------------------- #


def test_runs_failed_since_is_inert(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _append_ndjson(
        factory_root / "state" / "events" / "runs.ndjson",
        [
            {
                "ts": datetime.now(UTC).isoformat(),
                "success": False,
                "persona": "dev",
                "story_id": story_id,
                "error": "transient 429",
            }
        ],
    )
    ctx = dw._AdapterCtx(
        root=factory_root,
        app="sacrifice",
        since=datetime.now(UTC) - timedelta(hours=1),
        liveness_since=datetime.now(UTC) - dw._LIVENESS_LOOKBACK,
    )
    assert dw._adapter_runs_failed_since(ctx) == []


# --------------------------------------------------------------------------- #
# S7: priority-ordered cap prevents cross-detector starvation.
# --------------------------------------------------------------------------- #


def test_priority_ordered_cap_prevents_cross_detector_starvation(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _many(prefix: str) -> dw.AdapterFn:
        def _adapter(ctx: dw._AdapterCtx) -> list[dw.Firing]:
            return [dw.Firing(subject=f"{prefix}-{i}", evidence={}) for i in range(5)]

        return _adapter

    fake_adapters = {
        "low_priority_det": _many("low"),
        "high_priority_det": _many("high"),
    }
    monkeypatch.setattr(dw, "_ADAPTERS", fake_adapters)
    monkeypatch.setitem(dw._DETECTOR_PRIORITY, "high_priority_det", 0)
    # low_priority_det is unlisted -> falls to _DEFAULT_DETECTOR_PRIORITY (5).

    result = dw.detector_watch_tick(factory_root, "sacrifice")

    assert len(result.filed) == dw._MAX_FILINGS_PER_TICK == 3
    filed_detectors = {f.detector for f in result.filed}
    # Round-robin: with cap=3 and two detectors, BOTH must be represented —
    # naive insertion-order-first-come-first-served would have let one
    # detector eat the entire cap.
    assert filed_detectors == {"low_priority_det", "high_priority_det"}


def test_priority_ordered_firings_orders_by_tier_then_round_robins() -> None:
    firings = [
        ("runs_failed_since", dw.Firing(subject="a", evidence={})),
        ("stalled_stories", dw.Firing(subject="b", evidence={})),
        ("runs_failed_since", dw.Firing(subject="c", evidence={})),
        ("stalled_stories", dw.Firing(subject="d", evidence={})),
    ]
    ordered = dw._priority_ordered_firings(firings)
    # stalled_stories (priority 0) must come before runs_failed_since
    # (priority 9) in the round-robin, despite enumerating second.
    assert [name for name, _ in ordered] == [
        "stalled_stories",
        "runs_failed_since",
        "stalled_stories",
        "runs_failed_since",
    ]


# --------------------------------------------------------------------------- #
# S3: a partial/orphan direction dir blocks filing rather than being ignored;
# create_direction cleans up its own partial write on failure.
# --------------------------------------------------------------------------- #


def test_orphan_direction_dir_blocks_filing(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    orphan_dir = factory_root / "apps" / "sacrifice" / "directions" / "999-orphan"
    orphan_dir.mkdir()
    # No direction.md inside — simulates a partial/interrupted write.

    result = dw.detector_watch_tick(factory_root, "sacrifice")

    assert result.dedupe_scan_failed is True
    assert result.filed == []
    assert any(name == "dedupe_scan" for name, _ in result.errors)


def test_create_direction_cleans_up_partial_dir_on_write_failure(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.directions.creator import create_direction

    orig_write_text = Path.write_text

    def _boom_write_text(self: Path, *args: object, **kwargs: object) -> int:
        if self.name == "direction.md":
            raise OSError("ENOSPC (simulated)")
        return orig_write_text(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "write_text", _boom_write_text)

    with pytest.raises(OSError):
        create_direction(
            "sacrifice",
            title="boom",
            type_tag="infra",
            why="test",
            has_ui=False,
            flow_steps=None,
            has_api=False,
            api_spec_lines=None,
            acceptance=["x is observed at the boundary"],
            explore=True,
            attach_files=None,
            software_factory_root=factory_root,
            source="detector-test",
        )

    assert _direction_dirs(factory_root) == []


# --------------------------------------------------------------------------- #
# S9: "closed" is terminal for the dedupe scan — a re-filed fault after an
# operator closes the direction is allowed (never silenced forever).
# --------------------------------------------------------------------------- #


def test_closed_direction_signature_is_re_fileable(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    first = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(first.filed) == 1
    dirs = _direction_dirs(factory_root)
    assert len(dirs) == 1

    state_path = dirs[0] / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    state["status"] = "closed"
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    second = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(second.filed) == 1
    assert len(_direction_dirs(factory_root)) == 2


# --------------------------------------------------------------------------- #
# S10: sqlite lookup failure must be distinguished from "not found" and
# recorded, never swallowed as "healthy"; conformance_breach's app=None
# (coverage_breach) routes to the global bucket instead of being dropped.
# --------------------------------------------------------------------------- #


def test_story_lookup_failure_is_recorded_not_swallowed(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    def _broken_lookup(root: Path, story_id: int | None) -> tuple[str, str] | None:
        raise dw._StoryLookupError("database is locked (simulated)")

    monkeypatch.setattr(dw, "_story_row", _broken_lookup)

    result = dw.detector_watch_tick(factory_root, "sacrifice")

    assert "review_churn" not in result.ran
    assert any(name == "review_churn" for name, _ in result.errors)
    assert result.filed == []


def test_conformance_breach_unattributable_app_routes_to_global_bucket(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime.now(UTC)
    ctx_global = dw._AdapterCtx(
        root=factory_root, app="factory", since=now - timedelta(hours=1), liveness_since=now
    )
    ctx_other = dw._AdapterCtx(
        root=factory_root, app="sacrifice", since=now - timedelta(hours=1), liveness_since=now
    )

    def _fake_conformance_breach(*, root: Path, since: datetime) -> list[dict]:
        return [
            {
                "verdict": "coverage_breach",
                "story_id": 7,
                "app": None,
                "from_state": "a",
                "to_state": "b",
                "writer": "unknown",
                "ts": now.isoformat(),
            }
        ]

    import factory.manager.detectors as real_detectors

    monkeypatch.setattr(real_detectors, "conformance_breach", _fake_conformance_breach)

    global_firings = dw._adapter_conformance_breach(ctx_global)
    other_firings = dw._adapter_conformance_breach(ctx_other)

    assert len(global_firings) == 1
    assert other_firings == []


# --------------------------------------------------------------------------- #
# S5: the built-in criterion must not be auto-satisfied merely by the marker
# advancing, and must classify positive-observable against the real gate.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "detector,subject",
    [
        ("review_churn", "story-142"),
        ("retry_storm", "55:dev"),
        ("conformance_breach", "142:dev_in_progress->tests_green:factory.chain.handlers.handle_dev"),
        ("worktree_orphans", "/state/worktrees/sacrifice-142-foo"),
        ("cost_spike", "factory-wide-spend"),
        ("fms_yield", "fms-yield-zero"),
        ("placeholder_prompts", "reviewer:12"),
        ("tick_duration_outliers", "tick-outlier:abc"),
        ("stalled_stories", "story-99"),
        ("state_distribution_skew", "state-skew:dev_in_progress"),
    ],
)
def test_generated_criteria_are_not_vacuous(detector: str, subject: str) -> None:
    fired_at = datetime.now(UTC)
    for criterion in dw.acceptance_for_firing(detector, subject, fired_at=fired_at):
        result = classify_criterion(criterion)
        assert result.label == "positive-observable", (criterion, result.reasons)


def test_liveness_signal_is_stable_across_repeated_calls_without_fix(
    factory_root: Path,
) -> None:
    """The core S5 regression: calling the pass twice against UNFIXED,
    still-live state must not spuriously clear the finding merely because
    time/marker bookkeeping moved — the detector must still fire (and the
    second call must dedupe it, not silently drop it)."""
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    now = datetime.now(UTC)
    ctx = dw._AdapterCtx(
        root=factory_root,
        app="sacrifice",
        since=now - timedelta(hours=1),
        liveness_since=now - dw._LIVENESS_LOOKBACK,
    )
    first = dw._adapter_review_churn(ctx)
    second = dw._adapter_review_churn(ctx)  # identical ctx, no time passed, nothing fixed
    assert len(first) == 1
    assert [f.subject for f in first] == [f.subject for f in second]


def test_liveness_criterion_is_satisfiable_by_actually_fixing_the_story(
    factory_root: Path,
) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    first = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(first.filed) == 1

    # The story actually converges/ships.
    _set_story_state(db_path, story_id, "deployed")

    second = dw.detector_watch_tick(factory_root, "sacrifice")
    # The detector genuinely stops firing for this subject now that the
    # story is terminal — not deduped (it never fires at all).
    assert not any(d == "review_churn" for d, _ in second.deduped)
    assert not any(f.detector == "review_churn" for f in second.filed)


# --------------------------------------------------------------------------- #
# Approval flow: every detector-filed direction is parked for the operator.
# --------------------------------------------------------------------------- #


def test_filed_direction_requires_operator_approval(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    result = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(result.filed) == 1

    dirs = _direction_dirs(factory_root)
    assert len(dirs) == 1
    direction = parse_direction_dir("sacrifice", dirs[0])

    assert requires_operator_approval(direction) is True
    assert is_auto_buildable(direction) is False
    assert awaiting_operator_approval(direction) is True


# --------------------------------------------------------------------------- #
# S2: a real filed direction must pass validate_direction (explore=True).
# This is the test that would have caught S2 in round 1.
# --------------------------------------------------------------------------- #


def test_filed_direction_passes_validate_direction(factory_root: Path) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    result = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(result.filed) == 1

    dirs = _direction_dirs(factory_root)
    direction = parse_direction_dir("sacrifice", dirs[0])

    validation = validate_direction(direction)
    assert validation.is_valid is True
    assert validation.severity != "blocking"
    assert "user_flow" not in validation.missing
    assert "api_spec" not in validation.missing
    assert "explore_tag_or_artifacts" not in validation.missing


# --------------------------------------------------------------------------- #
# Cap: at most 3 filings/tick across all detectors combined; the remainder
# files on a LATER tick, once the cap has headroom (never dropped).
# --------------------------------------------------------------------------- #


def _seed_four_distinct_review_churn_stories(factory_root: Path) -> list[int]:
    db_path = factory_root / "state" / "factory.db"
    story_ids = []
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        for i in range(4):
            story = StoryRecord(
                direction_id="001",
                app="sacrifice",
                title=f"seeded story {i}",
                slug=f"d001-seeded-story-{i}",
                scope="backend",
                state="tests_green",
                chain_kind="tdd",
            )
            session.add(story)
            session.commit()
            session.refresh(story)
            assert story.id is not None
            story_ids.append(story.id)
    for sid in story_ids:
        _seed_review_churn(factory_root, sid)
    return story_ids


def test_cap_limits_filings_and_remainder_files_next_tick(factory_root: Path) -> None:
    story_ids = _seed_four_distinct_review_churn_stories(factory_root)
    assert len(story_ids) == 4

    first = dw.detector_watch_tick(factory_root, "sacrifice")
    assert len(first.filed) == dw._MAX_FILINGS_PER_TICK == 3
    assert len(first.capped) == 1
    assert len(_direction_dirs(factory_root)) == 3

    filed_subjects = {f.subject for f in first.filed}
    capped_subjects = {s for _, s in first.capped}
    assert filed_subjects | capped_subjects == {f"story-{sid}" for sid in story_ids}

    second = dw.detector_watch_tick(factory_root, "sacrifice")
    # The 3 already-filed subjects are now open directions -> deduped.
    assert len(second.deduped) == 3
    # The one that was capped last tick has headroom now -> filed.
    assert len(second.filed) == 1
    assert second.filed[0].subject in capped_subjects
    assert len(_direction_dirs(factory_root)) == 4


# --------------------------------------------------------------------------- #
# Dedupe-scan failure -> fail SAFE: refuse to file, never file blind.
# --------------------------------------------------------------------------- #


def test_dedupe_scan_failure_blocks_filing(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    def _broken_scan(app: str, root: Path) -> set[str]:
        raise RuntimeError("scan broke")

    monkeypatch.setattr(dw, "_open_detector_signatures", _broken_scan)

    result = dw.detector_watch_tick(factory_root, "sacrifice")

    assert result.dedupe_scan_failed is True
    assert result.filed == []
    assert result.deduped == []
    assert result.capped == []
    assert any(name == "dedupe_scan" for name, _ in result.errors)
    assert _direction_dirs(factory_root) == []


# --------------------------------------------------------------------------- #
# Orchestrator integration.
# --------------------------------------------------------------------------- #


def test_orchestrator_tick_populates_detector_watch(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import orchestrator as O

    (factory_root / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 4\n  per_repo_concurrent_agents: 4\n"
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n"
        "auto_merge:\n  enabled: false\n"
        "ci_health:\n  enabled: false\n"
        "detector_watch:\n  enabled: true\n",
        encoding="utf-8",
    )
    db_path = factory_root / "state" / "factory.db"
    # "pr_open": non-terminal (review_churn's liveness check must see it as
    # live) but NOT in _DISPATCH — a real orchestrator tick must not try to
    # dispatch a handler for it (no review/dev persona call), which would
    # otherwise change its state out from under this test before the
    # detector pass runs at the end of the same tick.
    story_id = _seed_story(db_path, app="sacrifice", state="pr_open")
    _seed_review_churn(factory_root, story_id)

    summary = O.tick(factory_root, "sacrifice", db_path=db_path, max_advances_per_story=1)

    assert summary.detector_watch is not None
    filed_detectors = {f.detector for f in summary.detector_watch.filed}
    assert "review_churn" in filed_detectors
    assert len(_direction_dirs(factory_root)) == len(summary.detector_watch.filed)
    # Tick exit behavior unchanged: a detector filing must never surface as a
    # tick-level error.
    assert summary.errors == []


def test_orchestrator_respects_disabled_by_default(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The flag ships disabled by default — a factory_settings.yaml with NO
    ``detector_watch:`` key at all must skip the pass entirely."""
    from factory.chain import orchestrator as O

    (factory_root / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 4\n  per_repo_concurrent_agents: 4\n"
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n"
        "auto_merge:\n  enabled: false\n"
        "ci_health:\n  enabled: false\n",
        encoding="utf-8",
    )
    db_path = factory_root / "state" / "factory.db"
    # "pr_open": non-terminal (review_churn's liveness check must see it as
    # live) but NOT in _DISPATCH — a real orchestrator tick must not try to
    # dispatch a handler for it (no review/dev persona call), which would
    # otherwise change its state out from under this test before the
    # detector pass runs at the end of the same tick.
    story_id = _seed_story(db_path, app="sacrifice", state="pr_open")
    _seed_review_churn(factory_root, story_id)

    summary = O.tick(factory_root, "sacrifice", db_path=db_path, max_advances_per_story=1)

    assert summary.detector_watch is None
    assert _direction_dirs(factory_root) == []


def test_orchestrator_dry_run_skips_detector_pass_entirely(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import orchestrator as O

    (factory_root / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 4\n  per_repo_concurrent_agents: 4\n"
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n"
        "auto_merge:\n  enabled: false\n"
        "ci_health:\n  enabled: false\n"
        "detector_watch:\n  enabled: true\n",
        encoding="utf-8",
    )
    db_path = factory_root / "state" / "factory.db"
    story_id = _seed_story(db_path, app="sacrifice")
    _seed_review_churn(factory_root, story_id)

    summary = O.tick(
        factory_root, "sacrifice", db_path=db_path, max_advances_per_story=1, dry_run=True
    )

    assert summary.detector_watch is None
    assert _direction_dirs(factory_root) == []
