"""Cross-retry memory must carry the agent's REASONING, not just its commands.

Measured on a real 1800 s dev trajectory — sacrifice story 177,
``state/events/trajectories/177-1.ndjson``, 291 events:

    ActionEvent        142     (129 with a non-empty ``thought``)
    ObservationEvent   142
    Condensation         5
    SystemPromptEvent    1
    MessageEvent         1     <- source "user", the initial prompt

**There is no assistant MessageEvent at all.** OpenHands carries the agent's
reasoning on ``ActionEvent.thought``; an assistant message only appears when the
agent FINISHES. So for any timed-out or crashed run ``last_assistant_message``
is structurally always empty — and with it ``self_summary``, which is derived
from it.

PR #270 made a timeout preserve ``recent_tool_calls`` (confirmed live: 8
survived). But those records held only ``tool`` / ``args`` / ``observation``, so
the next attempt inherited WHAT dev ran and never WHY. On the runs that most
need cross-retry memory, the richest signal was being discarded.
"""

from __future__ import annotations

from typing import Any

from factory.runner import (
    RECENT_TOOL_CALL_WINDOW,
    _build_initial_message,
    _extract_conversation_memory,
    _stringify_thought,
)


class _ActionEvent:
    """An ActionEvent in the shape the real trajectory uses."""

    kind = "ActionEvent"

    def __init__(self, tool: str, command: str, thought: Any) -> None:
        self.tool_name = tool
        self.tool_call_id = f"call-{tool}-{command[:6]}"
        self.thought = thought
        self.action = type("_A", (), {"command": command})()


class _Conversation:
    def __init__(self, events: list[Any]) -> None:
        self.state = type("_S", (), {"events": events})()


def test_thought_is_captured_from_the_action_event() -> None:
    """The real shape: reasoning on the ActionEvent, no assistant message."""
    conv = _Conversation(
        [
            _ActionEvent(
                "execute_bash",
                "pytest backend/tests/test_email_verify.py -x",
                "The verify-request route is missing, so the oracle 403s. Add it first.",
            )
        ]
    )
    last_msg, calls, finish = _extract_conversation_memory(conv)

    assert last_msg == "", "no assistant MessageEvent exists mid-run — this is the point"
    assert len(calls) == 1
    assert "verify-request route is missing" in calls[0]["thought"]
    assert calls[0]["tool"] == "execute_bash"


def test_thought_survives_as_content_blocks() -> None:
    """Some SDK builds deliver ``thought`` as content blocks, not a bare string."""
    conv = _Conversation(
        [_ActionEvent("str_replace_editor", "edit auth.py", [{"type": "text", "text": "Gate /api/goals."}])]
    )
    _, calls, _ = _extract_conversation_memory(conv)
    assert calls[0]["thought"] == "Gate /api/goals."


def test_missing_or_unreadable_thought_degrades_to_empty() -> None:
    """CONTROL — an absent or hostile ``thought`` must never raise."""

    class _NoThought:
        kind = "ActionEvent"
        tool_name = "execute_bash"
        tool_call_id = "x"
        action = type("_A", (), {"command": "ls"})()

    class _Exploding:
        def __str__(self) -> str:
            raise RuntimeError("nope")

    assert _stringify_thought(_NoThought()) == ""

    ev = _ActionEvent("execute_bash", "ls", _Exploding())
    assert _stringify_thought(ev) == ""

    _, calls, _ = _extract_conversation_memory(_Conversation([_NoThought()]))
    assert calls[0]["thought"] == ""


def test_the_retry_prompt_actually_shows_the_reasoning() -> None:
    """Capturing is useless if the next attempt never reads it.

    This is the end of the chain: trajectory -> record -> dev_attempts_json ->
    the retry's initial message.
    """
    prior = [
        {
            "attempt": 1,
            "summary": "sandbox run timed out after 1800s",
            "test_output_tail": "",
            "self_summary": "",
            "last_assistant_message": "",
            "recent_tool_calls": [
                {
                    "tool": "execute_bash",
                    "args": "alembic upgrade head",
                    "observation": "Multiple heads detected",
                    "thought": "Two alembic heads exist; my migration must depend on the other.",
                }
            ],
        }
    ]
    msg = _build_initial_message(
        persona="dev",
        story_text="# story",
        context_prelude="",
        persona_prompt="",
        prior_attempts=prior,
    )
    assert "Two alembic heads exist" in msg, "the reasoning must reach the next attempt"
    assert "alembic upgrade head" in msg


def test_reasoning_is_bounded_so_it_cannot_bloat_the_prompt() -> None:
    """A 200k-character thought must not be pasted whole into the next prompt."""
    prior = [
        {
            "attempt": 1,
            "summary": "timed out",
            "test_output_tail": "",
            "self_summary": "",
            "last_assistant_message": "",
            "recent_tool_calls": [
                {"tool": "t", "args": "a", "observation": "o", "thought": "Z" * 200_000}
            ],
        }
    ]
    msg = _build_initial_message(
        persona="dev",
        story_text="# s",
        context_prelude="",
        persona_prompt="",
        prior_attempts=prior,
    )
    assert "Z" * 400 not in msg, "thought must be truncated in the rendered prompt"
    assert len(msg) < 100_000


def test_window_still_bounds_the_number_of_calls() -> None:
    """The trailing-window cap is unchanged by adding a field to each record."""
    conv = _Conversation(
        [_ActionEvent("execute_bash", f"cmd{i}", f"thinking {i}") for i in range(50)]
    )
    _, calls, _ = _extract_conversation_memory(conv)
    assert len(calls) == RECENT_TOOL_CALL_WINDOW
