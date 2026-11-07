"""A story row with a state outside the StoryState enum must not abort the tick.

On 2026-07-07 a single row in state ``abandoned`` (not a StoryState value)
made ``_dispatch_for_story``'s ``StoryState(story.state)`` raise ValueError
and halt the entire factory for days. The tick must quarantine the poisoned
row (record it in ``summary.skipped`` — NON-FATAL, not ``summary.errors`` — and
emit an event) and keep driving the healthy stories. Counting the skip as an
error crash-looped the self-tick every cycle (2026-07-21): errors>0 -> exit 1
-> systemd FAILED. Quarantine is data hygiene, not a tick failure.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine

from factory.chain import handlers as H
from factory.chain import orchestrator as O
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: ssh://placeholder\nrepo_path: /tmp/sacrifice\n",
        encoding="utf-8",
    )
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 2\n  per_repo_concurrent_agents: 2\n"
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n",
        encoding="utf-8",
    )
    return tmp_path


def test_poisoned_state_row_is_skipped_not_fatal(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = factory_root / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    # Distinct direction: the dependency-ordering gate would otherwise defer
    # the healthy story behind its lower-id (poisoned) sibling.
    poisoned = StoryRecord(
        direction_id="006",
        app="sacrifice",
        title="poisoned",
        slug="poisoned",
        scope="backend",
        state="abandoned",  # not a StoryState value
        chain_kind="tdd",
    )
    healthy = StoryRecord(
        direction_id="007",
        app="sacrifice",
        title="healthy",
        slug="healthy",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        chain_kind="tdd",
    )
    with Session(eng) as session:
        session.add(poisoned)
        session.add(healthy)
        session.commit()
        session.refresh(poisoned)
        session.refresh(healthy)
        poisoned_id, healthy_id = poisoned.id, healthy.id

    dispatched: list[int | None] = []

    def _fake_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        dispatched.append(story.id)
        story.state = StoryState.SM_IN_PROGRESS.value
        H.persist_story(story, db_path=db)
        return H.HandlerResult(next_state=StoryState.SM_IN_PROGRESS)

    monkeypatch.setattr(H, "handle_sm", _fake_sm)

    # Must not raise despite the poisoned row.
    summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    # Poisoned row surfaced as a NON-FATAL skip (not an error), healthy story
    # still driven. The skip must NOT leak into summary.errors, because errors
    # drive the tick's non-zero exit code and would crash-loop the self-tick.
    assert any("invalid state" in msg for _, msg in summary.skipped)
    assert not any("invalid state" in msg for _, msg in summary.errors)
    assert summary.errors == []
    assert dispatched == [healthy_id]

    # Poisoned row still PRESENT — never deleted. Its state, however, is now
    # actively quarantined rather than left as-is: the recovery playbook
    # ``quarantine-invalid-enum-story`` runs again as of the 2026-08-08 rewire
    # (PR #247 had deleted its only caller along with the FMS watcher, leaving
    # all six playbooks dead). Quarantining is the playbook's whole purpose —
    # an un-quarantined invalid-enum row is the class that failed every tick
    # until an operator noticed. The load-bearing properties are unchanged and
    # asserted above: the skip is NON-FATAL, it never reaches summary.errors,
    # and the healthy story is still dispatched.
    with Session(eng) as session:
        refreshed = session.get(StoryRecord, poisoned_id)
        assert refreshed is not None, "a poisoned row must be quarantined, never deleted"
        assert refreshed.state == "quarantined_invalid_state"

    # A second tick must NOT re-emit the invalid_state_skipped event for the
    # same (story, state) — re-emitting every tick would grow the per-story log
    # unbounded. Since the 2026-08-08 recovery rewire the row is also no longer
    # RE-SURFACED as an invalid-state skip on tick 2: the quarantine playbook
    # already moved it out of the invalid-enum set on tick 1, which is exactly
    # the point of quarantining (before the rewire nothing ran the playbook, so
    # the row was rescanned forever). Non-fatality is still asserted.
    summary2 = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert not any("invalid state" in msg for _, msg in summary2.skipped), (
        "a quarantined row must not be rescanned as invalid on later ticks"
    )
    assert summary2.errors == []  # still non-fatal

    from factory.chain.event_log import read_story_events

    events = read_story_events(
        poisoned_id, software_factory_root=factory_root, slug_hint="poisoned"
    )
    emitted = [e for e in events if e.get("event") == "invalid_state_skipped"]
    assert len(emitted) == 1, f"expected exactly one emit across two ticks, got {len(emitted)}"


def test_tick_end_carries_skipped_count(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#96 Part 1: the quarantined-row count flows into the tick_end signal so
    the FMS can escalate a persistent poisoned row instead of it being silent."""
    import json

    db = factory_root / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        session.add(
            StoryRecord(
                direction_id="006",
                app="sacrifice",
                title="poisoned",
                slug="poisoned",
                scope="backend",
                state="abandoned",  # not a StoryState value
                chain_kind="tdd",
            )
        )
        session.commit()

    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    ticks = factory_root / "state" / "events" / "ticks.ndjson"
    lines = [ln for ln in ticks.read_text(encoding="utf-8").splitlines() if ln.strip()]
    tick_end = next(
        json.loads(ln) for ln in lines if json.loads(ln)["event"] == "tick_end"
    )
    assert tick_end["skipped"] == 1, "tick_end must carry the poisoned-row skip count"
