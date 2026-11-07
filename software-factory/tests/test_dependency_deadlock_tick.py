"""A story dependency-deferred behind a TERMINALLY-abandoned lower-id sibling
must be parked to ``BLOCKED_DEPENDENCY_UNMET``, not deferred forever.

Observed 2026-07-23: 6 dual-draft ``alt-b`` siblings sat in ``story_created``
indefinitely because their lower-id ``alt-a`` pair was parked in the terminal
``blocked_ci_unresolved`` sink (never-to-deploy) — the dependency-ordering gate
kept deferring them every tick, so the direction never completed and its tracker
issue never closed. The tick must recognise the deadlock and terminalise the
dependent (recoverable + surfaced) so the direction can complete.
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
        "caps:\n  global_concurrent_agents: 4\n  per_repo_concurrent_agents: 4\n"
        "  daily_spend_usd: 10\n  hourly_spend_usd: 2\n",
        encoding="utf-8",
    )
    return tmp_path


def test_deadlocked_dependent_is_parked_not_deferred_forever(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = factory_root / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    # alt-a: lower-id, terminally abandoned (never-to-deploy).
    alt_a = StoryRecord(
        direction_id="093", app="sacrifice", title="narrow", slug="d093-narrow",
        scope="backend", state=StoryState.BLOCKED_CI_UNRESOLVED.value, chain_kind="tdd",
    )
    # alt-b: higher-id, waiting behind alt-a in story_created.
    alt_b = StoryRecord(
        direction_id="093", app="sacrifice", title="broad", slug="d093-broad",
        scope="backend", state=StoryState.STORY_CREATED.value, chain_kind="tdd",
    )
    with Session(eng) as session:
        session.add(alt_a)
        session.add(alt_b)
        session.commit()
        session.refresh(alt_b)
        alt_b_id = alt_b.id

    # If the gate fails to catch the deadlock, the SM handler would run — make
    # that a loud failure so the test proves the gate terminalised alt-b first.
    def _loud_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        raise AssertionError("deadlocked dependent must be parked, not dispatched")

    monkeypatch.setattr(H, "handle_sm", _loud_sm)

    summary = O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)
    assert summary.errors == []

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, alt_b_id)
        assert refreshed is not None
        assert refreshed.state == StoryState.BLOCKED_DEPENDENCY_UNMET.value

    events = O_events(factory_root, alt_b_id, "d093-broad")
    assert any(e.get("event") == "dependency_deadlocked" for e in events)


def test_live_dependency_still_defers_not_parks(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the blocking sibling is still LIVE (not terminal), the dependent is
    deferred (stays in story_created), NOT terminalised."""
    db = factory_root / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    alt_a = StoryRecord(
        direction_id="094", app="sacrifice", title="a", slug="d094-a",
        scope="backend", state=StoryState.SM_DONE.value, chain_kind="tdd",  # live
    )
    alt_b = StoryRecord(
        direction_id="094", app="sacrifice", title="b", slug="d094-b",
        scope="backend", state=StoryState.STORY_CREATED.value, chain_kind="tdd",
    )
    with Session(eng) as session:
        session.add(alt_a)
        session.add(alt_b)
        session.commit()
        session.refresh(alt_b)
        alt_b_id = alt_b.id

    # alt-a is live; let its SM be a no-op so the tick doesn't do real work.
    def _noop_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        story.state = StoryState.SM_IN_PROGRESS.value
        H.persist_story(story, db_path=db)
        return H.HandlerResult(next_state=StoryState.SM_IN_PROGRESS)

    monkeypatch.setattr(H, "handle_sm", _noop_sm)

    O.tick(factory_root, "sacrifice", db_path=db, max_advances_per_story=1)

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, alt_b_id)
        assert refreshed is not None
        # deferred, NOT parked to the deadlock sink.
        assert refreshed.state == StoryState.STORY_CREATED.value


def O_events(root: Path, story_id: int, slug: str):
    from factory.chain.event_log import read_story_events

    return read_story_events(story_id, software_factory_root=root, slug_hint=slug)
