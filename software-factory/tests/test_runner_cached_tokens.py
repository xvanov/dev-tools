"""D003 follow-up — store the cached/fresh prompt-token SPLIT, not just the
blended ``cost_usd``.

Before this, ``cost_usd`` mixed exact-rate fresh tokens with guessed-rate
cached tokens and discarded the split, so the guess could never be
recomputed once a real cache-read rate is known and historical rows would
be permanently unfixable. These tests pin: (1) the low-level extraction
helper handles both the dict and object usage shapes LiteLLM produces, (2)
``text_run`` threads the split from a (mocked) LiteLLM response into the
persisted ``Run`` row, and (3) ``sandbox_run`` threads the split from the
(mocked) OpenHands SDK's ``TokenUsage.cache_read_tokens`` into the row.
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, select

from factory.runner import LLMConfig, Run, _engine, _extract_cached_tokens, sandbox_run, text_run


def _only_row(db_path: Path) -> Run:
    eng = _engine(db_path)
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    assert len(rows) == 1, rows
    return rows[0]


# --------------------------------------------------------------------------- #
# _extract_cached_tokens — low-level shape handling
# --------------------------------------------------------------------------- #


def test_extract_cached_tokens_from_dict_usage() -> None:
    """DeepSeek-shaped usage surfaces as a plain dict with a nested dict."""
    usage = {
        "prompt_tokens": 1000,
        "completion_tokens": 100,
        "prompt_tokens_details": {"cached_tokens": 900},
    }
    assert _extract_cached_tokens(usage) == 900


def test_extract_cached_tokens_from_object_usage() -> None:
    """A litellm ``Usage``-like object exposes ``.get()`` and attribute access."""
    from litellm.types.utils import Usage

    usage = Usage(
        prompt_tokens=1000,
        completion_tokens=100,
        prompt_cache_hit_tokens=900,
        prompt_cache_miss_tokens=100,
    )
    assert _extract_cached_tokens(usage) == 900


def test_extract_cached_tokens_missing_details_returns_zero() -> None:
    assert _extract_cached_tokens({"prompt_tokens": 10, "completion_tokens": 5}) == 0
    assert _extract_cached_tokens({}) == 0


def test_extract_cached_tokens_never_raises_on_malformed_input() -> None:
    assert _extract_cached_tokens(None) == 0
    assert _extract_cached_tokens("not a usage object") == 0
    assert _extract_cached_tokens({"prompt_tokens_details": "not a dict"}) == 0


# --------------------------------------------------------------------------- #
# text_run — threads the split from a (mocked) LiteLLM response
# --------------------------------------------------------------------------- #


def test_text_run_persists_cached_input_tokens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # model_id is "azure/..." -> _provider_env_key resolves to AZURE_API_KEY,
    # NOT DEEPSEEK_API_KEY (that mismatch is exactly what let this test pass
    # locally against a real .env key while failing in a credential-less CI
    # env). Fake, obviously-not-real placeholder, matching
    # tests/test_runner_iteration_cap.py's pattern for the same gate.
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    def fake_completion(**kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "prompt_tokens_details": {"cached_tokens": 900},
            },
        }

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(fake_completion)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    db = tmp_path / "state" / "factory.db"
    text_run(
        persona="sm",
        prompt="hi",
        model_id="azure/deepseek-v4-pro",
        db_path=db,
    )

    row = _only_row(db)
    assert row.tokens_in == 1000
    assert row.tokens_out == 100
    assert row.cached_input_tokens == 900


def test_text_run_zero_cache_hit_records_zero_not_null(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real call with NO cache hit records ``0`` (known value), which is
    distinct from ``None`` (pre-model failure / not applicable)."""
    # See comment in test_text_run_persists_cached_input_tokens: azure/*
    # model ids resolve through AZURE_API_KEY, not DEEPSEEK_API_KEY.
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    def fake_completion(**kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 500, "completion_tokens": 50},
        }

    fake_module = type("FakeLitellm", (), {"completion": staticmethod(fake_completion)})
    monkeypatch.setitem(sys.modules, "litellm", fake_module)

    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="azure/deepseek-v4-pro", db_path=db)

    row = _only_row(db)
    assert row.cached_input_tokens == 0


def test_text_run_dry_run_leaves_cached_input_tokens_null(tmp_path: Path) -> None:
    """No LLM call happened — cached_input_tokens is NULL (unknown), not 0."""
    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="stub/model", dry_run=True, db_path=db)
    row = _only_row(db)
    assert row.cached_input_tokens is None


# --------------------------------------------------------------------------- #
# sandbox_run — threads the split from the (mocked) OpenHands SDK
# --------------------------------------------------------------------------- #


def _install_fake_sdk(monkeypatch: pytest.MonkeyPatch, *, cache_read_tokens: int) -> None:
    class _FakeConversation:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def send_message(self, *_: Any, **__: Any) -> None:
            pass

        def run(self) -> None:
            pass

        def close(self) -> None:
            pass

        @property
        def conversation_stats(self) -> Any:
            class _S:
                def get_combined_metrics(self) -> Any:
                    class _M:
                        accumulated_token_usage = type(
                            "U",
                            (),
                            {
                                "prompt_tokens": 1000,
                                "completion_tokens": 100,
                                "cache_read_tokens": cache_read_tokens,
                            },
                        )()
                        accumulated_cost = 0.5

                    return _M()

            return _S()

    class _FakeLLM:
        def __init__(self, **kwargs: Any) -> None:
            pass

    class _FakeAgent:
        pass

    class _FakeWorkspace:
        def __init__(self, **kwargs: Any) -> None:
            pass

    fake_sdk = types.ModuleType("openhands.sdk")
    fake_sdk.LLM = _FakeLLM  # type: ignore[attr-defined]
    fake_sdk.Conversation = _FakeConversation  # type: ignore[attr-defined]
    fake_sdk.LocalWorkspace = _FakeWorkspace  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.sdk", fake_sdk)

    fake_tools = types.ModuleType("openhands.tools.preset.default")
    fake_tools.get_default_agent = lambda **_: _FakeAgent()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.tools.preset.default", fake_tools)

    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.SecretStr = lambda s: s  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)


def test_sandbox_run_persists_cached_input_tokens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("# test\n", encoding="utf-8")
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")

    _install_fake_sdk(monkeypatch, cache_read_tokens=750)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    db = tmp_path / "state" / "factory.db"
    asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/deepseek-v4-pro", api_key="x"),
            dry_run=False,
            db_path=db,
        )
    )

    row = _only_row(db)
    assert row.tokens_in == 1000
    assert row.tokens_out == 100
    assert row.cached_input_tokens == 750
