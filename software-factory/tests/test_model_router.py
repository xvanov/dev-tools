"""Model router resolution."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.model_router import active_provider, all_known_personas, route


@pytest.fixture(autouse=True)
def _force_direct_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """The historical model_router tests assert the direct-provider routes.

    The factory default flipped to ``azure`` in Phase 8; pin these tests to
    ``direct`` so the assertions about DeepSeek/OpenRouter model ids stay
    meaningful. Azure-specific behavior lives in ``test_runner_azure.py``.

    Provider keys are pinned as PRESENT so the router's key-aware degradation
    (see ``test_key_aware_degradation``) doesn't rewrite the assertions based
    on the developer's shell environment.
    """
    monkeypatch.setenv("FACTORY_PROVIDER", "direct")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("AZURE_API_KEY", "test-key")


def test_static_persona_returns_string() -> None:
    assert route("pm") == "deepseek/deepseek-chat"
    assert route("reviewer") == "azure/gpt-5.4"


def test_dev_difficulty_branches() -> None:
    assert route("dev", "standard") == "deepseek/deepseek-coder"
    assert route("dev", "hard") == "azure/gpt-5.3-codex"


def test_unknown_persona_falls_back() -> None:
    # Falls back to defaults.fallback per routes.yaml
    assert route("nonexistent_persona") == "deepseek/deepseek-chat"


def test_dev_default_difficulty_is_standard() -> None:
    assert route("dev") == "deepseek/deepseek-coder"


def test_all_known_personas_lists_expected() -> None:
    personas = all_known_personas()
    assert "dev" in personas
    assert "pm" in personas
    assert "reviewer" in personas


def test_fallback_used_when_difficulty_missing(tmp_path: Path) -> None:
    custom = tmp_path / "r.yaml"
    custom.write_text(
        "routes:\n"
        "  dev:\n"
        "    standard: deepseek/deepseek-coder\n"
        "defaults:\n"
        "  fallback: deepseek/deepseek-chat\n",
        encoding="utf-8",
    )
    # hard not defined → falls back to standard
    assert route("dev", "hard", routes_path=custom) == "deepseek/deepseek-coder"


def test_keyerror_when_no_fallback(tmp_path: Path) -> None:
    custom = tmp_path / "r.yaml"
    custom.write_text("routes:\n  pm: x/y\n", encoding="utf-8")
    with pytest.raises(KeyError):
        route("nonexistent", routes_path=custom)


def test_active_provider_reflects_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_PROVIDER", "azure")
    assert active_provider() == "azure"
    monkeypatch.setenv("FACTORY_PROVIDER", "direct")
    assert active_provider() == "direct"


_DEGRADATION_ROUTES = (
    "default_provider: azure\n"
    "azure_routes:\n"
    "  reviewer: openrouter/some-vendor/some-model\n"
    "  dev:\n"
    "    standard: azure/deepseek-v4-pro\n"
    # Distinct from reviewer above: same key-less provider, so degradation
    # behaves identically, but reviewer independence is preserved.
    "    hard: openrouter/some-vendor/dev-model\n"
    "routes:\n"
    "  reviewer: openrouter/some-vendor/some-model\n"
    "defaults:\n"
    "  fallback: deepseek/deepseek-chat\n"
    "  azure_fallback: azure/gpt-5.4\n"
)


class TestKeyAwareDegradation:
    """Missing provider keys degrade a route to the block fallback (and only
    when the fallback's own key IS available) — see route() docstring.

    Uses a self-contained routes fixture so the tests don't depend on which
    providers the PRODUCTION routes.yaml happens to reference."""

    @pytest.fixture
    def routes(self, tmp_path: Path) -> Path:
        p = tmp_path / "routes.yaml"
        p.write_text(_DEGRADATION_ROUTES, encoding="utf-8")
        return p

    def test_degrades_to_fallback_when_route_key_missing(
        self, monkeypatch: pytest.MonkeyPatch, routes: Path
    ) -> None:
        monkeypatch.setenv("FACTORY_PROVIDER", "azure")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.setenv("AZURE_API_KEY", "test-key")
        assert route("reviewer", routes_path=routes) == "azure/gpt-5.4"
        assert route("dev", "hard", routes_path=routes) == "azure/gpt-5.4"

    def test_intended_route_activates_once_key_lands(
        self, monkeypatch: pytest.MonkeyPatch, routes: Path
    ) -> None:
        monkeypatch.setenv("FACTORY_PROVIDER", "azure")
        monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
        monkeypatch.setenv("AZURE_API_KEY", "test-key")
        assert route("reviewer", routes_path=routes) == "openrouter/some-vendor/some-model"
        assert route("dev", "hard", routes_path=routes) == "openrouter/some-vendor/dev-model"

    def test_keeps_route_when_fallback_key_also_missing(
        self, monkeypatch: pytest.MonkeyPatch, routes: Path
    ) -> None:
        # direct block: fallback is deepseek/deepseek-chat — with BOTH keys
        # missing the original route is returned (the runner reports the
        # missing-key error with the intended model, not a masked fallback).
        monkeypatch.setenv("FACTORY_PROVIDER", "direct")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        assert route("reviewer", routes_path=routes) == "openrouter/some-vendor/some-model"

    def test_azure_foundry_key_counts_for_azure_models(
        self, monkeypatch: pytest.MonkeyPatch, routes: Path
    ) -> None:
        monkeypatch.setenv("FACTORY_PROVIDER", "azure")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("AZURE_API_KEY", raising=False)
        monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "test-key")
        assert route("reviewer", routes_path=routes) == "azure/gpt-5.4"

    def test_production_routes_are_all_azure_credentialed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Guard: with only AZURE_API_KEY set (the real .env state), every
        # production azure-block route resolves WITHOUT degradation — i.e.
        # the ladder never silently collapses under the shipped config.
        #
        # Was manager_watcher/manager_diagnostician (deleted 2026-08-07 with
        # the FMS LLM tiers). Since 2026-08-08 all three routed models are
        # open-weight and all resolve from the single AZURE_API_KEY, so the
        # open-weight switch did not add a credential the ladder can lose.
        monkeypatch.setenv("FACTORY_PROVIDER", "azure")
        monkeypatch.setenv("AZURE_API_KEY", "test-key")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
        assert route("test_implementer") == "azure/DeepSeek-V4-Flash"
        assert route("factory_self_context") == "azure/DeepSeek-V4-Flash"
        assert route("reviewer") == "azure/Kimi-K2.7-Code"
        assert route("security") == "azure/Kimi-K2.7-Code"
        assert route("dev", "hard") == "azure/deepseek-v4-pro"
        assert route("dev", "standard") == "azure/deepseek-v4-pro"
