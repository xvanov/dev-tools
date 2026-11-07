"""Tests for ``factory.webhook.openhands_events``.

Goals:

  * ``FactoryEventCallback.on_event`` defensively reads event fields and
    writes errors back to the StoryRecord without touching the state
    machine.
  * ``build_real_processor`` returns an SDK-real subclass of
    ``EventCallbackProcessor`` whose ``__call__`` signature matches the
    abstract base (3 positional args: conversation_id, callback, event)
    and returns a real ``EventCallbackResult``. When the SDK is missing
    (only the ImportError branch), the function falls back to the
    in-process callback.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlmodel import Session, create_engine

from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.webhook.openhands_events import (
    FactoryEventCallback,
    build_real_processor,
)


@pytest.fixture
def db_with_story(tmp_path: Path) -> tuple[Path, int]:
    db = tmp_path / "factory.db"
    s = persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="t",
            scope="backend",
            state=StoryState.STORY_CREATED.value,
        ),
        db,
    )
    assert s.id is not None
    return db, s.id


def test_factory_event_callback_records_error_to_story(db_with_story: tuple[Path, int]) -> None:
    db, story_id = db_with_story
    cb = FactoryEventCallback(story_id=story_id, db_path=db)
    cb.on_event(SimpleNamespace(state=None, error="boom"))

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as s:
        row = s.get(StoryRecord, story_id)
    assert row is not None
    assert row.error == "boom"


def test_factory_event_callback_noop_for_missing_state_and_error(
    db_with_story: tuple[Path, int],
) -> None:
    db, story_id = db_with_story
    cb = FactoryEventCallback(story_id=story_id, db_path=db)
    # No state, no error -> the callback returns immediately without touching DB.
    cb.on_event(SimpleNamespace())
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as s:
        row = s.get(StoryRecord, story_id)
    assert row is not None
    assert row.error is None


def test_real_processor_is_subclass_of_sdk_abc(db_with_story: tuple[Path, int]) -> None:
    """The processor we build MUST inherit ``EventCallbackProcessor``."""
    pytest.importorskip("openhands.app_server.event_callback.event_callback_models")
    from openhands.app_server.event_callback.event_callback_models import EventCallbackProcessor

    db, story_id = db_with_story
    proc = build_real_processor(story_id=story_id, db_path=db)
    assert isinstance(proc, EventCallbackProcessor)


def test_real_processor_call_signature_matches_abc(db_with_story: tuple[Path, int]) -> None:
    """``__call__`` must accept exactly (conversation_id, callback, event)."""
    pytest.importorskip("openhands.app_server.event_callback.event_callback_models")
    db, story_id = db_with_story
    proc = build_real_processor(story_id=story_id, db_path=db)
    sig = inspect.signature(proc.__call__)
    param_names = list(sig.parameters.keys())
    # The bound method drops ``self``; expect three params.
    assert param_names == ["conversation_id", "callback", "event"], (
        f"unexpected __call__ signature: {param_names}"
    )


@pytest.mark.asyncio
async def test_real_processor_returns_eventcallbackresult(db_with_story: tuple[Path, int]) -> None:
    """Calling the processor returns an EventCallbackResult with SUCCESS status."""
    pytest.importorskip("openhands.app_server.event_callback.event_callback_models")
    from openhands.app_server.event_callback.event_callback_result_models import (
        EventCallbackResult,
        EventCallbackResultStatus,
    )

    db, story_id = db_with_story
    proc = build_real_processor(story_id=story_id, db_path=db)
    fake_callback = SimpleNamespace(id=uuid4())
    fake_event = SimpleNamespace(id=uuid4(), state=None, error="kaboom")
    result = await proc(uuid4(), fake_callback, fake_event)
    assert isinstance(result, EventCallbackResult)
    assert result.status == EventCallbackResultStatus.SUCCESS
    # And the side-effect on the StoryRecord happened.
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as s:
        row = s.get(StoryRecord, story_id)
    assert row is not None
    assert row.error == "kaboom"
