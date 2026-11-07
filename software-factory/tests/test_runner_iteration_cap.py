"""Per-persona max-iteration caps for ``sandbox_run``.

Personas with bounded workflows (Onboarder's 4-phase scan,
Test-Implementer's plan execution) get tighter sandbox iteration caps so a
runaway agent burns through its turn budget instead of spending unbounded
real money. The dev persona keeps the default 200 because it legitimately
needs many turns for red → green → refactor.

These tests exercise ``PERSONA_ITERATION_CAPS`` and the cap-application
logic without spinning up the real OpenHands SDK; we monkeypatch the SDK
imports + the ``Conversation`` constructor and assert on the
``max_iteration_per_run`` kwarg.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from factory.runner import PERSONA_ITERATION_CAPS, LLMConfig, sandbox_run


def _capture_max_iteration(monkeypatch: pytest.MonkeyPatch, repo: Path) -> dict[str, Any]:
    """Monkeypatch the SDK so ``sandbox_run`` records (not invokes) the
    ``max_iteration_per_run`` kwarg passed to ``Conversation``.

    Returns a dict the caller can inspect after running ``sandbox_run``.
    """
    captured: dict[str, Any] = {}

    class _FakeConversation:
        def __init__(self, **kwargs: Any) -> None:
            captured["max_iteration_per_run"] = kwargs.get("max_iteration_per_run")

        def send_message(self, *_: Any, **__: Any) -> None:  # pragma: no cover
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
                            "U", (), {"prompt_tokens": 0, "completion_tokens": 0}
                        )()
                        accumulated_cost = 0.0

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

    # The SDK imports happen lazily inside sandbox_run. We intercept by
    # injecting a fake module hierarchy into sys.modules via monkeypatch.
    import sys
    import types

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
    # pydantic is a real installed module; only override SecretStr in a way
    # the runner can find via ``from pydantic import SecretStr``. Since
    # ``monkeypatch.setitem`` replaces the module entirely, we add anything
    # else the runner reaches for to avoid a downstream import error.
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)

    return captured


@pytest.fixture
def story_and_repo(tmp_path: Path) -> Iterator[tuple[Path, Path]]:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("# test\n", encoding="utf-8")
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")
    yield story, repo


def test_persona_caps_map_includes_onboarder() -> None:
    """Onboarder cap was bumped from 60 to 180: real-run showed 60 was
    too tight when the agent had to read a substantial codebase before
    writing context docs."""
    assert PERSONA_ITERATION_CAPS.get("onboarder") == 180


def test_persona_caps_map_includes_test_implementer() -> None:
    """Test-Implementer cap was bumped from 100 to 300: D007 showed
    that the persona benefits from extra room to rewrite brittle first
    cuts of the test suite."""
    assert PERSONA_ITERATION_CAPS.get("test_implementer") == 300


def test_persona_caps_map_omits_dev() -> None:
    """Dev keeps the function default (now 600) because the red → green
    retry loop legitimately needs many turns. Explicit absence from the
    map IS the contract — guard against accidental future additions.
    """
    assert "dev" not in PERSONA_ITERATION_CAPS


def test_onboarder_sandbox_run_uses_persona_cap(
    story_and_repo: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """When ``sandbox_run`` is called with the default ``max_iterations``
    and persona=onboarder, the effective cap drops to the value in
    PERSONA_ITERATION_CAPS (currently 180)."""
    story, repo = story_and_repo
    captured = _capture_max_iteration(monkeypatch, repo)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")  # so _resolve_api_key returns

    asyncio.run(
        sandbox_run(
            persona="onboarder",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/gpt-5.4", api_key="x"),
            dry_run=False,
        )
    )

    assert captured["max_iteration_per_run"] == PERSONA_ITERATION_CAPS["onboarder"]


def test_test_implementer_sandbox_run_uses_persona_cap(
    story_and_repo: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same default-detection logic for test_implementer."""
    story, repo = story_and_repo
    captured = _capture_max_iteration(monkeypatch, repo)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    asyncio.run(
        sandbox_run(
            persona="test_implementer",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/gpt-5.4", api_key="x"),
            dry_run=False,
        )
    )

    assert captured["max_iteration_per_run"] == PERSONA_ITERATION_CAPS["test_implementer"]


def test_dev_sandbox_run_uses_function_default(
    story_and_repo: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dev is NOT in PERSONA_ITERATION_CAPS — the function default (600
    after bumping from 200) survives unchanged. We import the live
    signature default so this test tracks future bumps automatically."""
    import inspect

    from factory.runner import sandbox_run as _sandbox_run_fn

    sig = inspect.signature(_sandbox_run_fn)
    expected_default = sig.parameters["max_iterations"].default

    story, repo = story_and_repo
    captured = _capture_max_iteration(monkeypatch, repo)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/gpt-5.4", api_key="x"),
            dry_run=False,
        )
    )

    assert captured["max_iteration_per_run"] == expected_default


def test_explicit_max_iterations_overrides_persona_cap(
    story_and_repo: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit ``max_iterations`` from the caller wins over the persona
    cap. This is how a power-user can opt back into a longer onboarder run
    when they specifically want exhaustive scanning.

    Detection logic: the runner only applies the persona cap when the caller
    used the signature default (200). Any other value passes through.
    """
    story, repo = story_and_repo
    captured = _capture_max_iteration(monkeypatch, repo)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")

    asyncio.run(
        sandbox_run(
            persona="onboarder",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/gpt-5.4", api_key="x"),
            dry_run=False,
            max_iterations=150,  # explicit override
        )
    )

    assert captured["max_iteration_per_run"] == 150


def test_dry_run_does_not_consult_persona_cap(
    story_and_repo: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dry-run skips the SDK entirely; the cap logic is irrelevant.

    Guards against a future refactor that accidentally consults the cap
    on the dry-run path (e.g. recording it in the DB) and surfaces a
    persona-typo bug as a test failure.
    """
    story, repo = story_and_repo

    result = asyncio.run(
        sandbox_run(
            persona="onboarder",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/gpt-5.4", api_key="x"),
            dry_run=True,
        )
    )

    # Dry-run returns a RunResult with success=False and a summary string.
    assert result.success is False
    assert "[DRY-RUN]" in result.summary
