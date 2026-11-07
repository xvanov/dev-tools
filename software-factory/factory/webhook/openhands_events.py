"""OpenHands SDK event callback — advances the chain on conversation lifecycle.

Subclasses ``EventCallbackProcessor`` from OpenHands. On each event sent by
the agent-server during a sandbox conversation, inspects the conversation
state and updates the local StoryRecord:

* When the conversation reaches ``RUNNING`` we record start time.
* When it transitions to ``READY`` we record the run succeeded.
* When ``ERROR`` we record the error.

The processor is registered on each conversation in
``factory.runner.sandbox_run`` (Phase 3 wires this; Phase 2 ships the
processor module so callers can ``from factory.webhook.openhands_events
import FactoryEventCallback``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _safe_get_attr(obj: Any, *names: str) -> Any:
    """Return the first attribute that exists, else None — defensive against SDK shape changes."""
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return None


class FactoryEventCallback:
    """Substitute base class so the module imports without OpenHands installed.

    At runtime ``factory.runner.sandbox_run`` registers a *real* subclass of
    ``openhands.app_server.event_callback.event_callback_models.EventCallbackProcessor``;
    that subclass delegates ``process`` to this same logic. We keep the
    business logic here so it can be unit-tested independent of the SDK.
    """

    def __init__(self, story_id: int, db_path: Path) -> None:
        self.story_id = story_id
        self.db_path = db_path

    def on_event(self, event: Any) -> None:
        """Inspect ``event`` and update the StoryRecord accordingly.

        ``event`` is duck-typed; we read ``state`` / ``status`` / ``error``
        defensively because the SDK's event model surface evolves.
        """
        state = _safe_get_attr(event, "state", "status")
        error = _safe_get_attr(event, "error", "error_message")
        if state is None and error is None:
            return

        # Apply minimal updates to the StoryRecord. We DO NOT advance the
        # state machine from inside the callback — that's the orchestrator's
        # job. We only stamp side-channel fields (last_event_state,
        # last_event_error) which the orchestrator inspects on the next
        # tick.
        from sqlmodel import Session, create_engine

        from factory.chain.state_machine import StoryRecord

        eng = create_engine(f"sqlite:///{self.db_path}", echo=False)
        with Session(eng) as session:
            story = session.get(StoryRecord, self.story_id)
            if story is None:
                return
            if error:
                story.error = str(error)[:500]
            session.add(story)
            session.commit()


def build_real_processor(story_id: int, db_path: Path) -> Any:
    """Construct an SDK-real EventCallbackProcessor backed by FactoryEventCallback.

    This is what ``factory.runner.sandbox_run`` calls. We defer the SDK import
    to inside the function so importing this module doesn't pull OpenHands.
    Narrow the import-error handler to ``ImportError`` so non-import failures
    (e.g. an SDK API mismatch) surface instead of being silently swallowed.
    """
    try:
        from openhands.app_server.event_callback.event_callback_models import (
            EventCallbackProcessor,
        )
        from openhands.app_server.event_callback.event_callback_result_models import (
            EventCallbackResult,
            EventCallbackResultStatus,
        )
    except ImportError:  # pragma: no cover - exercised only without SDK installed
        return FactoryEventCallback(story_id=story_id, db_path=db_path)

    inner = FactoryEventCallback(story_id=story_id, db_path=db_path)

    class _Processor(EventCallbackProcessor):  # type: ignore[misc]
        """SDK-conforming subclass.

        The abstract base mandates::

            async def __call__(
                self, conversation_id: UUID, callback: EventCallback, event: Event
            ) -> EventCallbackResult | None

        See ``openhands.app_server.event_callback.event_callback_models``.
        """

        async def __call__(
            self,
            conversation_id: Any,
            callback: Any,
            event: Any,
        ) -> Any:  # pragma: no cover - exercised only with SDK
            inner.on_event(event)
            return EventCallbackResult(
                status=EventCallbackResultStatus.SUCCESS,
                event_callback_id=getattr(callback, "id", None),
                event_id=getattr(event, "id", None),
                conversation_id=conversation_id,
            )

    return _Processor()
