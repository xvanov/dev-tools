"""A sandbox run that times out MID-RUN must still book what it spent.

Measured on the live factory 2026-08-08, sacrifice story 173: a dev sandbox ran
the full ``dev_sandbox_timeout_s`` (1800 s), and its own SDK telemetry line had
reached **$1.9243 / 4.73M input / 38.4k output** when the wall clock fired. The
``runs`` row written for it said ``tokens_in=0, tokens_out=0, cost_usd=0.0,
premodel_infra=1``.

Two independent consequences, both bad:

1. **The money vanished from the ledger.** ``caps.per_story_spend_usd`` (12.0)
   is enforced as a TERMINAL breaker and ``caps.daily_spend_usd`` bounds the
   day — both read recorded cost. Spend that records as $0 can never trip
   either, so a story that times out repeatedly burns real money against a
   counter that never moves.
2. **It did not consume a dev retry.** ``premodel_infra=True`` routes through
   ``handlers._is_premodel_infra_failure``'s free-bounce path. That is exactly
   the story-88 class its own docstring documents ("re-dispatched 12 times with
   ``dev_retries`` stuck at 1"), which the explicit ``premodel_infra`` flag was
   introduced to close — the timeout path was never covered by that fix.

Root cause: ``_partial_usage`` is written on the line AFTER
``conversation.run()`` returns. A timeout fired while the model is still working
— the COMMON timeout, not the rare one — therefore arrives with it empty, and
``model_did_work = _t_out > 0 or _cost > 0.0`` is False. The fix reads usage off
the live conversation before deciding.

The control test below is the one that matters for fail-safety: a sandbox that
stalls before any model work must KEEP its free retry.
"""

from __future__ import annotations

import asyncio
import sys
import time
import types
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, select

from factory.chain.handlers import _is_premodel_infra_failure
from factory.runner import LLMConfig, Run, _engine, sandbox_run


def _only_row(db_path: Path) -> Run:
    with Session(_engine(db_path)) as session:
        rows = list(session.exec(select(Run)).all())
    assert len(rows) == 1, rows
    return rows[0]


def _install_stalling_sdk(
    monkeypatch: pytest.MonkeyPatch,
    *,
    prompt_tokens: int,
    completion_tokens: int,
    cost: float,
) -> None:
    """An SDK whose ``run()`` never returns within the wall clock.

    ``conversation_stats`` reports usage the whole time — which is what the real
    OpenHands SDK does (it is the same source the sandbox's own live ``$`` line
    prints from), and is precisely the state the old code threw away.
    """

    class _StallingConversation:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def send_message(self, *_: Any, **__: Any) -> None:
            pass

        def run(self) -> None:
            # Outlives the wall clock in the test. The orphaned worker thread is
            # reaped when the process exits, exactly as in production.
            time.sleep(30)

        def close(self) -> None:
            pass

        @property
        def conversation_stats(self) -> Any:
            class _S:
                def get_combined_metrics(self) -> Any:
                    return type(
                        "_M",
                        (),
                        {
                            "accumulated_token_usage": type(
                                "U",
                                (),
                                {
                                    "prompt_tokens": prompt_tokens,
                                    "completion_tokens": completion_tokens,
                                    "cache_read_tokens": 0,
                                },
                            )(),
                            "accumulated_cost": cost,
                        },
                    )()

            return _S()

    fake_sdk = types.ModuleType("openhands.sdk")
    fake_sdk.LLM = type("_FakeLLM", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    fake_sdk.Conversation = _StallingConversation  # type: ignore[attr-defined]
    fake_sdk.LocalWorkspace = type(  # type: ignore[attr-defined]
        "_FakeWorkspace", (), {"__init__": lambda self, **kw: None}
    )
    monkeypatch.setitem(sys.modules, "openhands.sdk", fake_sdk)

    fake_tools = types.ModuleType("openhands.tools.preset.default")
    fake_tools.get_default_agent = lambda **_: object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.tools.preset.default", fake_tools)

    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.SecretStr = lambda s: s  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)


def _run_until_timeout(tmp_path: Path, db: Path) -> Any:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    (repo / "README.md").write_text("# test\n", encoding="utf-8")
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")
    return asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/deepseek-v4-pro", api_key="x"),
            dry_run=False,
            db_path=db,
            wall_clock_timeout_s=0.25,
        )
    )


def test_timeout_midrun_books_the_spend_it_actually_incurred(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The live story-173 shape: 4.73M in / 38.4k out / $1.9243, then the wall clock."""
    _install_stalling_sdk(
        monkeypatch, prompt_tokens=4_730_000, completion_tokens=38_400, cost=1.9243
    )
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    db = tmp_path / "state" / "factory.db"

    result = _run_until_timeout(tmp_path, db)

    row = _only_row(db)
    assert row.cost_usd == pytest.approx(1.9243), (
        "a timed-out run must book what it spent; $0 makes per_story_spend_usd "
        "and daily_spend_usd unable to ever trip on timeout-heavy stories"
    )
    assert row.tokens_in == 4_730_000
    assert row.tokens_out == 38_400
    assert result.cost_usd == pytest.approx(1.9243)


def test_timeout_midrun_is_a_real_dev_attempt_not_a_free_infra_bounce(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``premodel_infra`` must be False so the dev retry budget is consumed.

    This is the story-88 regression: a free bounce re-dispatches the story with
    ``dev_retries`` unchanged, so the loop is bounded only by the consecutive
    infra cap while each pass burns real money.
    """
    _install_stalling_sdk(
        monkeypatch, prompt_tokens=4_730_000, completion_tokens=38_400, cost=1.9243
    )
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    db = tmp_path / "state" / "factory.db"

    result = _run_until_timeout(tmp_path, db)

    assert result.premodel_infra is False
    assert _only_row(db).premodel_infra is False

    assert _is_premodel_infra_failure(result) is False, (
        "the dev handler must treat this as a genuine attempt"
    )


def test_stall_before_any_model_work_keeps_its_free_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CONTROL — the fail-safe direction.

    A sandbox that hangs before a single model call has genuinely spent nothing.
    It must stay ``premodel_infra=True`` and keep the free bounce, or a transient
    boot hang starts eating the dev retry budget for a fault dev cannot fix.
    """
    _install_stalling_sdk(monkeypatch, prompt_tokens=0, completion_tokens=0, cost=0.0)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    db = tmp_path / "state" / "factory.db"

    result = _run_until_timeout(tmp_path, db)

    assert result.premodel_infra is True
    assert result.cost_usd == 0.0
    assert _only_row(db).premodel_infra is True

    assert _is_premodel_infra_failure(result) is True


def test_unreadable_telemetry_falls_back_to_the_safe_old_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A telemetry read that raises must not convert a timeout into a crash.

    The recovery is best-effort by construction: if the SDK's stats object
    changes shape, we degrade to the previous behaviour (zero usage, infra) —
    the old bug, never a new failure mode.
    """

    class _ExplodingConversation:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def send_message(self, *_: Any, **__: Any) -> None:
            pass

        def run(self) -> None:
            time.sleep(30)

        def close(self) -> None:
            pass

        @property
        def conversation_stats(self) -> Any:
            raise RuntimeError("SDK shape changed")

    _install_stalling_sdk(monkeypatch, prompt_tokens=1, completion_tokens=1, cost=1.0)
    sys.modules["openhands.sdk"].Conversation = _ExplodingConversation  # type: ignore[attr-defined]
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    db = tmp_path / "state" / "factory.db"

    result = _run_until_timeout(tmp_path, db)

    assert result.success is False
    assert result.cost_usd == 0.0
    assert result.premodel_infra is True


# --------------------------------------------------------------------------- #
# Cross-retry MEMORY, not just usage
# --------------------------------------------------------------------------- #


class _Msg:
    """An assistant message event in the SDK's observed shape."""

    kind = "MessageEvent"
    role = "assistant"

    def __init__(self, text: str) -> None:
        self.llm_message = type("_M", (), {"content": [{"type": "text", "text": text}]})()


class _Action:
    kind = "ActionEvent"

    def __init__(self, tool: str, args: str) -> None:
        self.tool_name = tool
        self.tool_call_id = f"call-{tool}"
        self.action = type("_A", (), {"command": args})()


def _install_stalling_sdk_with_events(
    monkeypatch: pytest.MonkeyPatch, events: list[Any]
) -> None:
    """A stalled conversation that HAS accumulated events and spend."""

    class _Conv:
        def __init__(self, **kwargs: Any) -> None:
            self.state = type("_S", (), {"events": events})()

        def send_message(self, *_: Any, **__: Any) -> None:
            pass

        def run(self) -> None:
            time.sleep(30)

        def close(self) -> None:
            pass

        @property
        def conversation_stats(self) -> Any:
            class _S:
                def get_combined_metrics(self) -> Any:
                    return type(
                        "_M",
                        (),
                        {
                            "accumulated_token_usage": type(
                                "U", (), {
                                    "prompt_tokens": 4_730_000,
                                    "completion_tokens": 38_400,
                                    "cache_read_tokens": 0,
                                },
                            )(),
                            "accumulated_cost": 1.9243,
                        },
                    )()

            return _S()

    _install_stalling_sdk(monkeypatch, prompt_tokens=1, completion_tokens=1, cost=1.0)
    sys.modules["openhands.sdk"].Conversation = _Conv  # type: ignore[attr-defined]


def test_timeout_carries_forward_what_the_attempt_actually_did(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The three cross-retry memory fields must survive a mid-run timeout.

    ``handle_dev`` stores them in ``dev_attempts_json`` and
    ``_build_initial_message`` renders them into the NEXT attempt's prompt. Empty
    means every retry after a timeout restarts COLD — the live shape of sacrifice
    story 173, which burned two ~30-minute attempts with no cumulative progress.
    """
    _install_stalling_sdk_with_events(
        monkeypatch,
        [
            _Action("execute_bash", "pytest backend/tests -x"),
            _Msg("I added require_verified_email and wired it to /api/goals."),
        ],
    )
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    result = _run_until_timeout(tmp_path, tmp_path / "state" / "factory.db")

    assert "require_verified_email" in result.last_assistant_message
    assert result.recent_tool_calls, "the tool trail must survive the timeout"
    assert result.recent_tool_calls[0]["tool"] == "execute_bash"


def test_timeout_with_no_events_yields_empty_memory_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CONTROL — a stall before any turn has nothing to carry, and must not raise."""
    _install_stalling_sdk_with_events(monkeypatch, [])
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    result = _run_until_timeout(tmp_path, tmp_path / "state" / "factory.db")

    assert result.last_assistant_message == ""
    assert result.recent_tool_calls == []
    assert result.success is False


def test_unreadable_event_state_degrades_instead_of_raising(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A memory read must never convert a timeout into a crash."""

    class _Boom:
        @property
        def events(self) -> Any:
            raise RuntimeError("SDK shape changed")

    _install_stalling_sdk_with_events(monkeypatch, [])
    conv_cls = sys.modules["openhands.sdk"].Conversation  # type: ignore[attr-defined]
    original_init = conv_cls.__init__

    def _init(self: Any, **kwargs: Any) -> None:
        original_init(self, **kwargs)
        self.state = _Boom()

    conv_cls.__init__ = _init  # type: ignore[method-assign]
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    result = _run_until_timeout(tmp_path, tmp_path / "state" / "factory.db")

    assert result.success is False
    assert result.last_assistant_message == ""
    # The usage recovery is independent of the memory recovery and must still work.
    assert result.cost_usd == pytest.approx(1.9243)
