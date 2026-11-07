"""Runner-side llm_params / preset plumbing (best-effort degradation)."""

from __future__ import annotations

import pytest

from factory.runner import _build_agent_for_persona, _persona_llm_overrides


def test_overrides_resolve_from_routes() -> None:
    params = _persona_llm_overrides("dev", "azure/deepseek-v4-pro", "standard")
    assert params["reasoning_effort"] == "none"
    assert params["max_output_tokens"] == 8192


def test_overrides_swallow_lookup_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    import factory.model_router as mr

    def boom(*a: object, **k: object) -> dict[str, object]:
        raise RuntimeError("corrupt yaml")

    monkeypatch.setattr(mr, "llm_params_for", boom)
    assert _persona_llm_overrides("dev", "azure/deepseek-v4-pro", "standard") == {}


class _SentinelAgent:
    def __init__(self, llm: object, cli_mode: bool = False) -> None:
        self.llm = llm
        self.cli_mode = cli_mode


def _default_agent_factory(llm: object, cli_mode: bool = False) -> _SentinelAgent:
    return _SentinelAgent(llm, cli_mode)


def test_default_agent_when_no_preset() -> None:
    agent = _build_agent_for_persona("dev", llm="LLM", get_default_agent=_default_agent_factory)
    assert isinstance(agent, _SentinelAgent)
    assert agent.cli_mode is True


def test_unknown_preset_degrades_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    import factory.model_router as mr

    monkeypatch.setattr(mr, "preset_for", lambda persona, **k: "no-such-preset")
    agent = _build_agent_for_persona("dev", llm="LLM", get_default_agent=_default_agent_factory)
    assert isinstance(agent, _SentinelAgent)
