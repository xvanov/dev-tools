"""``text_run`` retries JSON-mode truncation by doubling ``max_tokens``.

When ``finish_reason="length"`` OR ``json.loads`` fails, the runner
doubles the cap and re-issues the completion. Without this, a single
too-tight ``max_tokens`` (or an unexpectedly verbose model) wedges the
chain with ``Unterminated string starting at line N`` errors.
"""

from __future__ import annotations

from typing import Any

import pytest

from factory import runner


def _fake_response(
    content: str, finish_reason: str = "stop", completion_tokens: int = 20
) -> dict[str, Any]:
    """Shape a minimal LiteLLM-like response dict.

    ``completion_tokens`` matters for the fake-truncation guard: a REAL
    ``finish_reason="length"`` truncation reports completion_tokens close to
    the cap, whereas a malfunctioning provider reports a tiny count.
    """
    return {
        "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": completion_tokens},
    }


def test_text_run_retries_on_truncated_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test")

    calls: list[dict[str, Any]] = []

    truncated = '{"key": "valu'  # unterminated string -> json.JSONDecodeError
    full = '{"key": "value"}'

    def fake_completion(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        # First call returns truncated (REAL truncation: tokens at the cap),
        # second returns valid.
        if len(calls) == 1:
            return _fake_response(
                truncated, finish_reason="length",
                completion_tokens=kwargs["max_tokens"],
            )
        return _fake_response(full, finish_reason="stop")

    import sys

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(fake_completion)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    result = runner.text_run(
        persona="sm",
        prompt="hi",
        model_id="deepseek/deepseek-chat",
        schema={"type": "object"},
        max_tokens=2048,
    )

    assert isinstance(result, dict)
    assert result["key"] == "value"
    assert len(calls) == 2
    # First call used the seed cap; second doubled it.
    assert calls[0]["max_tokens"] == 2048
    assert calls[1]["max_tokens"] == 4096


def test_text_run_doubles_to_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test")

    calls: list[dict[str, Any]] = []

    def always_truncated(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        # REAL truncation: completion_tokens at the cap each attempt.
        return _fake_response(
            '{"key": "tru', finish_reason="length",
            completion_tokens=kwargs["max_tokens"],
        )

    import sys

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(always_truncated)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    with pytest.raises(RuntimeError, match="JSON-mode response was not valid JSON"):
        runner.text_run(
            persona="sm",
            prompt="hi",
            model_id="deepseek/deepseek-chat",
            schema={"type": "object"},
            max_tokens=8192,
        )

    # Caps doubled until hitting the ceiling, then stopped retrying.
    used_caps = [c["max_tokens"] for c in calls]
    assert used_caps[0] == 8192
    assert max(used_caps) == runner._MAX_OUTPUT_RETRY_CEILING
    # Final attempt count is bounded by _MAX_OUTPUT_RETRIES.
    assert len(calls) <= runner._MAX_OUTPUT_RETRIES


def test_text_run_gives_up_on_fake_length_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A provider that flags finish_reason='length' while emitting only a tiny
    body (observed: deepseek-chat in JSON mode) is malfunctioning, not
    truncated — doubling the cap cannot help. The runner must give up after a
    single call instead of burning the full doubling ladder."""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test")

    calls: list[dict[str, Any]] = []

    def fake_length_tiny(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        # Claims length but only 20 tokens out against an 8192 cap.
        return _fake_response('{"k": "', finish_reason="length", completion_tokens=20)

    import sys

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(fake_length_tiny)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    with pytest.raises(RuntimeError, match="JSON-mode response was not valid JSON"):
        runner.text_run(
            persona="sm",
            prompt="hi",
            model_id="deepseek/deepseek-chat",
            schema={"type": "object"},
            max_tokens=8192,
        )
    # No futile doubling ladder — one call and done.
    assert len(calls) == 1


def test_text_run_no_retry_when_first_attempt_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test")

    calls: list[dict[str, Any]] = []

    def ok(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return _fake_response('{"ok": true}', finish_reason="stop")

    import sys

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(ok)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    result = runner.text_run(
        persona="sm",
        prompt="hi",
        model_id="deepseek/deepseek-chat",
        schema={"type": "object"},
        max_tokens=4096,
    )
    assert isinstance(result, dict)
    assert result["ok"] is True
    assert len(calls) == 1


def test_text_run_text_mode_no_retry_unless_length(monkeypatch: pytest.MonkeyPatch) -> None:
    """In plain-text mode (schema is None) the only retry trigger is the
    provider's ``finish_reason="length"`` flag. JSON parse errors don't
    apply — the output IS prose."""
    monkeypatch.setenv("AZURE_API_KEY", "test")
    monkeypatch.setenv("AZURE_API_BASE", "http://fake")

    calls: list[dict[str, Any]] = []

    def stop(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return _fake_response("some prose response", finish_reason="stop")

    import sys

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(stop)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    out = runner.text_run(
        persona="reviewer",
        prompt="hi",
        model_id="azure/gpt-5.4",
        schema=None,
        max_tokens=512,
    )
    assert out == "some prose response"
    assert len(calls) == 1
