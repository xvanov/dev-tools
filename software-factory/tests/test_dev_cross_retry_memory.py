"""Cross-retry memory beyond ``prior_attempts.test_output_tail``.

Previously each dev retry only got a 1500-char tail of pytest output as
context. The user's exact words: "retries should run a new convo, but
keep the context and learnings from the previous sessions — there must
be a mechanism for this."

New signal captured per attempt:
  * ``last_assistant_message`` — verbatim final assistant message
    (capped at 2000 chars).
  * ``recent_tool_calls`` — trailing window of (tool, args, observation)
    so the next retry sees what dev was *doing* when it gave up.
  * ``self_summary`` — dev's own 3-5 sentence "what I tried / what
    failed / what I'd try next", parsed from the ``SELF_SUMMARY:``
    marker the dev persona prompt now requires.

Tests verify the extraction logic, the persistence into
``story.dev_attempts_json``, and the rendering of the new "Your prior
thinking" section in ``_build_initial_message``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import (
    RECENT_TOOL_CALL_WINDOW,
    RunResult,
    _build_initial_message,
    _extract_conversation_memory,
    _extract_self_summary,
)

# ---------------------------------------------------------------------------
# _extract_self_summary
# ---------------------------------------------------------------------------


def test_extract_self_summary_finds_marker() -> None:
    msg = (
        "Some prefix text the dev wrote.\n\n"
        "SELF_SUMMARY: I attempted to add a Pydantic validator on the User "
        "model but pytest still fails at fixture setup; the test imports a "
        "fixture from conftest that does not exist. Next attempt: read "
        "conftest first and align fixture names.\n\n"
        "Trailing tool log here..."
    )
    out = _extract_self_summary(msg)
    assert out.startswith("I attempted to add a Pydantic validator")
    assert "Next attempt" in out
    # Trailing tool log NOT included (blank-line boundary).
    assert "Trailing tool log" not in out


def test_extract_self_summary_falls_back_to_tail() -> None:
    msg = "I tried but couldn't fix it." * 30
    out = _extract_self_summary(msg)
    assert out  # non-empty fallback
    assert len(out) <= 500


def test_extract_self_summary_empty_input() -> None:
    assert _extract_self_summary("") == ""


def test_extract_self_summary_from_finish_message_when_last_message_lacks_marker() -> None:
    """SELF_SUMMARY delivered via the ``finish`` tool must be captured.

    Two of the four 2026-08-02 SWE-bench autopsies hit exactly this: the dev
    called ``finish(message="... SELF_SUMMARY: ...")`` instead of ending with
    a plain assistant message, and ``self_summary`` persisted empty.
    """
    finish = (
        "Wrapping up.\n\n"
        "SELF_SUMMARY: I followed the sibling parser precedent at "
        "fake_pkg/sibling.py:12 for the field spelling; no precedent found "
        "for the retry count, my choice is a guess.\n\n"
        "trailing noise"
    )
    out = _extract_self_summary("All done, see the diff.", finish)
    assert out.startswith("I followed the sibling parser precedent")
    assert "trailing noise" not in out


def test_extract_self_summary_prefers_last_message_marker_over_finish() -> None:
    out = _extract_self_summary(
        "SELF_SUMMARY: from the plain message.",
        "SELF_SUMMARY: from the finish tool.",
    )
    assert out == "from the plain message."


def test_extract_self_summary_falls_back_to_finish_tail_when_no_marker_anywhere() -> None:
    out = _extract_self_summary("", "just a short goodbye with no marker")
    assert out == "just a short goodbye with no marker"


# ---------------------------------------------------------------------------
# _extract_conversation_memory
# ---------------------------------------------------------------------------


class _FakeMsgContent:
    """Mimic the SDK's content list element with a ``.text`` attribute."""

    def __init__(self, text: str) -> None:
        self.text = text


class _FakeLLMMessage:
    def __init__(self, content: list[Any]) -> None:
        self.content = content


class _FakeEvent:
    """Minimal stand-in for an OpenHands SDK event.

    The extraction code dispatches on the lowered ``kind`` attribute,
    falling back to the class name. We use ``kind`` directly so tests
    don't depend on which SDK class name the live SDK happens to use.
    """

    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


class _FakeState:
    def __init__(self, events: list[_FakeEvent]) -> None:
        self.events = events


class _FakeConversation:
    def __init__(self, events: list[_FakeEvent]) -> None:
        self.state = _FakeState(events)


def test_extract_conversation_memory_returns_last_assistant_and_tool_window() -> None:
    events = [
        _FakeEvent(
            kind="MessageEvent",
            role="user",
            llm_message=_FakeLLMMessage([_FakeMsgContent("user q")]),
        ),
        _FakeEvent(
            kind="ActionEvent",
            tool_name="execute_bash",
            arguments={"cmd": "pytest -q"},
            tool_call_id="call-1",
        ),
        _FakeEvent(
            kind="ObservationEvent",
            tool_call_id="call-1",
            output="FAILED tests/test_x.py::test_foo",
        ),
        _FakeEvent(
            kind="ActionEvent",
            tool_name="str_replace_editor",
            arguments={"path": "src/foo.py", "command": "create"},
            tool_call_id="call-2",
        ),
        _FakeEvent(
            kind="ObservationEvent",
            tool_call_id="call-2",
            output="File created.",
        ),
        _FakeEvent(
            kind="MessageEvent",
            role="assistant",
            llm_message=_FakeLLMMessage(
                [_FakeMsgContent("All done.\n\nSELF_SUMMARY: I edited foo.py.")]
            ),
        ),
    ]
    conv = _FakeConversation(events)
    last_msg, pairs, _finish = _extract_conversation_memory(conv)
    assert "All done" in last_msg
    assert "SELF_SUMMARY" in last_msg
    assert len(pairs) == 2
    assert pairs[0]["tool"] == "execute_bash"
    assert "FAILED tests/test_x" in pairs[0]["observation"]
    assert pairs[1]["tool"] == "str_replace_editor"
    assert "File created" in pairs[1]["observation"]


def test_extract_conversation_memory_caps_tool_window() -> None:
    events: list[_FakeEvent] = []
    for i in range(RECENT_TOOL_CALL_WINDOW * 2):
        events.append(
            _FakeEvent(
                kind="ActionEvent",
                tool_name=f"t{i}",
                arguments={"i": i},
                tool_call_id=f"c{i}",
            )
        )
        events.append(
            _FakeEvent(
                kind="ObservationEvent",
                tool_call_id=f"c{i}",
                output=f"out{i}",
            )
        )
    pairs = _extract_conversation_memory(_FakeConversation(events))[1]
    assert len(pairs) == RECENT_TOOL_CALL_WINDOW
    # Window is the TRAILING calls.
    assert pairs[-1]["tool"] == f"t{RECENT_TOOL_CALL_WINDOW * 2 - 1}"


def test_extract_conversation_memory_handles_missing_state() -> None:
    class _Empty:
        state = None

    last_msg, pairs, finish_msg = _extract_conversation_memory(_Empty())
    assert last_msg == ""
    assert pairs == []
    assert finish_msg == ""


def test_extract_conversation_memory_captures_finish_tool_message() -> None:
    """The finish action's message field must come back as ``finish_message``.

    A fake finish-message payload mirroring the persisted trajectory shape:
    an ActionEvent whose tool is ``finish`` and whose args carry ``message``.
    """
    summary = (
        "SELF_SUMMARY: matched the fake sibling precedent at "
        "fake_pkg/example_sibling.py:34."
    )
    events = [
        _FakeEvent(
            kind="MessageEvent",
            role="assistant",
            llm_message=_FakeLLMMessage([_FakeMsgContent("Working on it.")]),
        ),
        _FakeEvent(
            kind="ActionEvent",
            tool_name="finish",
            arguments={"message": f"Task complete.\n\n{summary}"},
            tool_call_id="call-finish",
        ),
    ]
    last_msg, _pairs, finish_msg = _extract_conversation_memory(_FakeConversation(events))
    assert "Working on it." in last_msg
    assert summary in finish_msg
    # End-to-end: the self-summary chain picks the marker out of the finish
    # message when the plain message has none.
    assert _extract_self_summary(last_msg, finish_msg).startswith(
        "matched the fake sibling precedent"
    )


def test_extract_conversation_memory_finish_message_via_action_attribute() -> None:
    """SDK shape where the message lives on ``ev.action.message``."""

    class _FakeFinishAction:
        message = "Done. SELF_SUMMARY: no precedent found for X; my choice is a guess."

    events = [
        _FakeEvent(kind="ActionEvent", tool_name="finish", action=_FakeFinishAction())
    ]
    _last, _pairs, finish_msg = _extract_conversation_memory(_FakeConversation(events))
    assert finish_msg == _FakeFinishAction.message


# ---------------------------------------------------------------------------
# _build_initial_message — "Your prior thinking" section
# ---------------------------------------------------------------------------


def test_initial_message_includes_prior_thinking_when_self_summary_present() -> None:
    msg = _build_initial_message(
        persona="dev",
        story_text="# story",
        context_prelude="# ctx",
        persona_prompt="# persona",
        prior_attempts=[
            {
                "attempt": 1,
                "files_touched": ["src/x.py"],
                "summary": "tests not green",
                "test_output_tail": "AssertionError",
                "self_summary": (
                    "I tried wiring a Pydantic validator but the test "
                    "expects a different error type. Next: switch from "
                    "ValueError to TypeError in the validator."
                ),
                "last_assistant_message": (
                    "Some assistant text.\n\nSELF_SUMMARY: I tried wiring..."
                ),
                "recent_tool_calls": [
                    {"tool": "execute_bash", "args": "pytest", "observation": "FAILED"},
                ],
            }
        ],
    )
    assert "Your prior thinking" in msg
    assert "Self-summary" in msg
    assert "Pydantic validator" in msg
    assert "Recent tool calls" in msg
    assert "execute_bash" in msg


def test_initial_message_skips_prior_thinking_when_no_signal() -> None:
    """Old-shape attempts (no self_summary / last_msg / tool_calls) skip
    the new section. The legacy "Previous attempts" block still renders."""
    msg = _build_initial_message(
        persona="dev",
        story_text="# story",
        context_prelude="# ctx",
        persona_prompt="# persona",
        prior_attempts=[
            {
                "attempt": 1,
                "files_touched": ["src/x.py"],
                "summary": "tests not green",
                "test_output_tail": "AssertionError",
            }
        ],
    )
    assert "Previous attempts" in msg
    assert "Your prior thinking" not in msg


# ---------------------------------------------------------------------------
# handle_dev persists rich attempt records
# ---------------------------------------------------------------------------


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    import subprocess

    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories" / "1-x.md").write_text(
        "# story\n", encoding="utf-8"
    )
    src = tmp_path / "myapp"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=str(src), check=True)
    (src / "README.md").write_text("# init\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(src), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src), check=True)
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    return AppConfig(
        name="myapp",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(temp_root / "myapp"),
    )


def _story_at(state: StoryState, root: Path) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="099",
            app="myapp",
            title="t",
            slug="z",
            scope="backend",
            state=state.value,
            github_issue_number=1,
            story_file_path="stories/1-x.md",
        ),
        root / "state" / "factory.db",
    )


def test_dev_attempt_persists_self_summary_and_tool_calls(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed dev run captures the new signals into ``dev_attempts_json``."""
    story = _story_at(StoryState.SM_DONE, temp_root)
    db = temp_root / "state" / "factory.db"

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        return RunResult(
            success=False,
            files_changed=["src/x.py"],
            test_run_passed=False,
            error="tests not green after run",
            summary="AssertionError: expected 1 got 2",
            last_assistant_message=(
                "I rewrote the handler.\n\n"
                "SELF_SUMMARY: I refactored the handler to use async, but "
                "the test patches sync. Next: align test mock with async."
            ),
            recent_tool_calls=[
                {"tool": "execute_bash", "args": "pytest -q", "observation": "FAILED 1 test"},
                {"tool": "str_replace_editor", "args": '{"path":"src/x.py"}', "observation": "edited"},
            ],
            self_summary=(
                "I refactored the handler to use async, but the test patches sync. "
                "Next: align test mock with async."
            ),
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    attempts = json.loads(story.dev_attempts_json)
    assert len(attempts) == 1
    a = attempts[0]
    assert a["self_summary"].startswith("I refactored the handler")
    assert "SELF_SUMMARY" in a["last_assistant_message"]
    assert len(a["recent_tool_calls"]) == 2
    assert a["recent_tool_calls"][0]["tool"] == "execute_bash"


def test_dev_retry_passes_self_summary_into_next_prompt(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The next retry's _build_initial_message renders the prior self_summary
    in the new "Your prior thinking" section.

    We assert by intercepting the kwarg the handler hands to sandbox_run:
    ``prior_attempts`` must include the new fields. The render itself is
    covered by the unit test above.
    """
    story = _story_at(StoryState.DEV_RETRY, temp_root)
    story.dev_retries = 1
    story.dev_attempts_json = json.dumps(
        [
            {
                "attempt": 1,
                "files_touched": ["src/x.py"],
                "summary": "prev",
                "test_output_tail": "AssertionError: prev",
                "self_summary": "I tried X. It failed. Next: try Y.",
                "last_assistant_message": "...SELF_SUMMARY: I tried X.",
                "recent_tool_calls": [{"tool": "bash", "args": "pytest", "observation": "fail"}],
            }
        ]
    )
    persist_story(story, temp_root / "state" / "factory.db")
    db = temp_root / "state" / "factory.db"

    captured: dict[str, Any] = {}

    async def _fake_sandbox(*args: object, **kwargs: object) -> RunResult:
        captured["prior_attempts"] = kwargs.get("prior_attempts")
        return RunResult(
            success=False,
            files_changed=[],
            test_run_passed=False,
            error="still red",
            summary="still red",
            last_assistant_message="SELF_SUMMARY: still trying Y.",
            self_summary="still trying Y.",
            recent_tool_calls=[],
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/gpt-5.4")

    handle_dev(story, app_config, temp_root, dry_run=False, db_path=db)

    prior = captured["prior_attempts"]
    assert prior and len(prior) == 1
    assert prior[0]["self_summary"].startswith("I tried X")
    assert prior[0]["recent_tool_calls"][0]["tool"] == "bash"
