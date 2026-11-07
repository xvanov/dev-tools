"""Handler exceptions roll the StoryRecord back to its pre-handler state.

Without rollback, a handler that advanced the story to ``*_in_progress``
and then raised (e.g. LLM truncation -> JSONDecodeError in SM) leaves
the row stranded: ``_dispatch_for_story`` returns ``None`` for
``*_in_progress`` states, so the next tick can't pick the story up
again without manual DB surgery.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine

from factory.chain import handlers as H
from factory.chain import orchestrator as O
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def seeded_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, int]:
    db = tmp_path / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    story = StoryRecord(
        direction_id="007",
        app="sacrifice",
        title="t",
        slug="boom",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        chain_kind="tdd",
    )
    with Session(eng) as session:
        session.add(story)
        session.commit()
        session.refresh(story)
        assert story.id is not None
        sid = story.id
    return db, sid


def test_handler_exception_rolls_state_back(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    seeded_db: tuple[Path, int],
) -> None:
    db, sid = seeded_db

    # Minimal app config so load_app_config in tick() can succeed.
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

    def _boom_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        # Mirror the real SM handler: advance to in-progress, persist, then crash.
        story.state = StoryState.SM_IN_PROGRESS.value
        H.persist_story(story, db_path=db)
        raise RuntimeError("simulated LLM JSON parse failure")

    monkeypatch.setattr(H, "handle_sm", _boom_sm)

    summary = O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=1)

    assert summary.errors, "exception should have been recorded in summary"
    assert "simulated LLM JSON parse failure" in summary.errors[0][1]

    # Story should have been rolled back to STORY_CREATED so the next tick
    # can re-dispatch the SM handler.
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
        assert refreshed is not None
        assert refreshed.state == StoryState.STORY_CREATED.value
        assert refreshed.error is not None
        assert "simulated LLM JSON parse failure" in refreshed.error
