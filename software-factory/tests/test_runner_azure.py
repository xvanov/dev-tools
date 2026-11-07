"""Azure provider plumbing.

Covers BOTH Azure surfaces:

* ``azure_ai/...`` — Foundry path. Env vars: AZURE_FOUNDRY_* / AZURE_AI_API_*.
* ``azure/...``    — Azure OpenAI / Cognitive Services. Env vars:
                     AZURE_ENDPOINT / AZURE_API_BASE / AZURE_API_KEY /
                     AZURE_API_VERSION.

No network is touched — Stage C smoke tests cover the live endpoint manually.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from factory import model_router, providers
from factory.providers import azure_foundry
from factory.runner import LLMConfig, _provider_env_key, _resolve_api_key


@pytest.fixture(autouse=True)
def _reset_azure_bootstrap() -> None:
    """Allow ``ensure_bootstrapped`` to run again between tests."""
    azure_foundry.reset_for_tests()
    yield
    azure_foundry.reset_for_tests()


# --------------------------------------------------------------------------- #
# Foundry surface (azure_ai/...)
# --------------------------------------------------------------------------- #


def test_resolve_api_key_for_azure_ai_reads_dedicated_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``azure_ai/<model>`` → reads ``AZURE_AI_API_KEY``."""
    monkeypatch.delenv("AZURE_FOUNDRY_API_KEY", raising=False)
    monkeypatch.setenv("AZURE_AI_API_KEY", "azure-key-A")
    cfg = LLMConfig(model="azure_ai/gpt-4.1")
    assert _resolve_api_key(cfg) == "azure-key-A"


def test_resolve_api_key_for_azure_ai_falls_back_to_foundry_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only ``AZURE_FOUNDRY_API_KEY`` set → resolver still finds the key
    (the bootstrap remap copies it into ``AZURE_AI_API_KEY``)."""
    monkeypatch.delenv("AZURE_AI_API_KEY", raising=False)
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "foundry-key-B")
    cfg = LLMConfig(model="azure_ai/gpt-4.1")
    assert _resolve_api_key(cfg) == "foundry-key-B"


def test_ensure_bootstrapped_remaps_foundry_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """The remap copies all three AZURE_FOUNDRY_* names into AZURE_AI_API_*."""
    monkeypatch.delenv("AZURE_AI_API_BASE", raising=False)
    monkeypatch.delenv("AZURE_AI_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_AI_API_VERSION", raising=False)
    monkeypatch.setenv("AZURE_FOUNDRY_ENDPOINT", "https://example.test/models")
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "k123")
    monkeypatch.setenv("AZURE_FOUNDRY_API_VERSION", "2024-05-01-preview")

    azure_foundry.ensure_bootstrapped()

    import os

    assert os.environ["AZURE_AI_API_BASE"] == "https://example.test/models"
    assert os.environ["AZURE_AI_API_KEY"] == "k123"
    assert os.environ["AZURE_AI_API_VERSION"] == "2024-05-01-preview"


def test_ensure_bootstrapped_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling ``ensure_bootstrapped`` twice does not raise nor re-mutate env
    that the user explicitly set between calls."""
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "first")
    monkeypatch.setenv("AZURE_AI_API_KEY", "kept-by-user")
    azure_foundry.ensure_bootstrapped()
    azure_foundry.ensure_bootstrapped()
    import os

    # The user's explicit AZURE_AI_API_KEY value must be preserved.
    assert os.environ["AZURE_AI_API_KEY"] == "kept-by-user"


def test_ensure_bootstrapped_patches_litellm_azure_ai_detection() -> None:
    """The monkey-patch forces ``_is_azure_openai_model`` to return False
    so LiteLLM's OpenAI-compatible azure_ai path is used for every model
    (including ``gpt-4.1``, which would otherwise downgrade to the
    Azure-OpenAI deployment URL that does not exist on a Foundry endpoint).
    """
    azure_foundry.ensure_bootstrapped()
    from litellm.llms.azure_ai.chat.transformation import AzureAIStudioConfig

    cfg = AzureAIStudioConfig()
    assert cfg._is_azure_openai_model("gpt-4.1", None) is False
    assert cfg._is_azure_openai_model("gpt-4o-mini", None) is False


# --------------------------------------------------------------------------- #
# Azure-OpenAI / Cognitive Services surface (azure/...)
# --------------------------------------------------------------------------- #


def test_provider_env_key_distinguishes_two_azure_prefixes() -> None:
    """``azure_ai/`` and ``azure/`` resolve to DIFFERENT env-var names.

    The two surfaces share neither URL shape nor key scope; conflating their
    keys silently sends Foundry traffic to an Azure-OpenAI key (and vice
    versa) — the test guards that boundary explicitly.
    """
    assert _provider_env_key("azure_ai/gpt-4.1") == "AZURE_AI_API_KEY"
    assert _provider_env_key("azure/gpt-5.4") == "AZURE_API_KEY"


def test_resolve_api_key_for_azure_reads_dedicated_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``azure/<deployment>`` → reads ``AZURE_API_KEY`` (LiteLLM-standard name)."""
    monkeypatch.delenv("AZURE_FOUNDRY_API_KEY", raising=False)
    monkeypatch.setenv("AZURE_API_KEY", "openai-azure-key-C")
    cfg = LLMConfig(model="azure/gpt-5.4")
    assert _resolve_api_key(cfg) == "openai-azure-key-C"


def test_resolve_api_key_for_azure_falls_back_to_foundry_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Operator who only set AZURE_FOUNDRY_API_KEY can still call ``azure/`` ids.

    Useful for the shared-tenant case where one Azure subscription serves both
    surfaces and the operator has a single key in their .env.
    """
    monkeypatch.delenv("AZURE_API_KEY", raising=False)
    monkeypatch.setenv("AZURE_FOUNDRY_API_KEY", "shared-key-D")
    cfg = LLMConfig(model="azure/gpt-5.4")
    assert _resolve_api_key(cfg) == "shared-key-D"


def test_ensure_bootstrapped_remaps_azure_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``AZURE_ENDPOINT`` (operator-friendly name) → ``AZURE_API_BASE``
    (LiteLLM-standard name) at bootstrap.

    ``AZURE_API_KEY`` / ``AZURE_API_VERSION`` already match LiteLLM's expected
    names so they need no remap.
    """
    monkeypatch.delenv("AZURE_API_BASE", raising=False)
    monkeypatch.setenv("AZURE_ENDPOINT", "https://example.cognitiveservices.azure.com/")

    azure_foundry.ensure_bootstrapped()

    import os

    assert os.environ["AZURE_API_BASE"] == "https://example.cognitiveservices.azure.com/"


def test_ensure_bootstrapped_does_not_overwrite_explicit_api_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the operator explicitly sets ``AZURE_API_BASE``, we leave it alone
    even when ``AZURE_ENDPOINT`` is also set."""
    monkeypatch.setenv("AZURE_ENDPOINT", "https://endpoint.example/")
    monkeypatch.setenv("AZURE_API_BASE", "https://operator-explicit.example/")

    azure_foundry.ensure_bootstrapped()

    import os

    assert os.environ["AZURE_API_BASE"] == "https://operator-explicit.example/"


def test_ensure_bootstrapped_enables_litellm_drop_params() -> None:
    """gpt-5.x reasoning models reject ``max_tokens`` and want
    ``max_completion_tokens``. We set ``litellm.drop_params = True`` so the
    legacy parameter is auto-translated by LiteLLM rather than 400-ing."""
    azure_foundry.ensure_bootstrapped()
    import litellm

    assert litellm.drop_params is True


def test_ensure_bootstrapped_registers_deepseek_v4_pro_pricing() -> None:
    """LiteLLM ships without a price for ``azure/deepseek-v4-pro``. We
    register the Azure retail rate at bootstrap so sandbox dev /
    test_implementer runs land non-zero cost in ``runs.cost_usd`` — otherwise
    the chain's spend caps are useless against the heaviest model.

    Test asserts:
      * The model id is registered.
      * Both per-token rates are present and > 0.
      * The metadata carries the ``factory_cost_note`` provenance marker.
    """
    azure_foundry.ensure_bootstrapped()
    import litellm

    entry = litellm.model_cost.get("azure/deepseek-v4-pro")
    assert entry is not None, "azure/deepseek-v4-pro is unregistered after bootstrap"
    assert entry["input_cost_per_token"] > 0
    assert entry["output_cost_per_token"] > 0
    assert "azure retail" in entry.get("factory_cost_note", "").lower(), (
        "provenance marker missing — operators must know where the price came from"
    )


def test_deepseek_v4_pro_pricing_estimates_completion_cost() -> None:
    """LiteLLM's ``cost_per_token`` helper applies the registered rates.

    Rates are the verified Azure retail price ($1.93 / $3.83 per 1M tokens,
    eastus2, 2026-07-18); we feed a known token count and assert the cost is
    exactly what those rates predict. Anchors the registration end-to-end.
    """
    azure_foundry.ensure_bootstrapped()
    import litellm

    # 1M prompt + 1M completion → $1.93 input + $3.83 output = $5.76 total.
    prompt_cost, completion_cost = litellm.cost_per_token(
        model="azure/deepseek-v4-pro",
        prompt_tokens=1_000_000,
        completion_tokens=1_000_000,
    )
    assert prompt_cost == pytest.approx(1.93, rel=1e-6)
    assert completion_cost == pytest.approx(3.83, rel=1e-6)


def test_deepseek_v4_pro_registers_cache_read_discount() -> None:
    """D003 audit fix: the registration MUST carry ``cache_read_input_token_cost``.

    Before the fix, this key was absent — and LiteLLM's cost calculator
    defaults a missing cache-read rate to $0.0, not to the full input rate,
    so cached tokens were priced at ZERO (cost UNDERSTATED, not overstated).
    Runs on this route show ~93% cache-hit, so this bug mattered a lot.
    """
    azure_foundry.ensure_bootstrapped()
    import litellm

    entry = litellm.model_cost.get("azure/deepseek-v4-pro")
    assert entry is not None
    assert entry.get("cache_read_input_token_cost", 0.0) > 0.0
    # Cache rate must be cheaper than the full input rate — otherwise it
    # isn't a discount at all.
    assert entry["cache_read_input_token_cost"] < entry["input_cost_per_token"]


def test_deepseek_v4_pro_cache_hit_cost_is_pinned() -> None:
    """Pin the exact cache-aware cost math for a known cache-hit split.

    1000 prompt tokens where 900 are cache hits + 100 are fresh, plus 100
    completion tokens. Before the fix this returned $0.000193 (only the 100
    fresh tokens billed — the 900 cached tokens were free). After the fix,
    the cached tokens are billed at the discounted cache-read rate instead
    of $0.0 or the full input rate.
    """
    azure_foundry.ensure_bootstrapped()
    import litellm

    prompt_cost, completion_cost = litellm.cost_per_token(
        model="azure/deepseek-v4-pro",
        prompt_tokens=1000,
        completion_tokens=100,
        cache_read_input_tokens=900,
    )
    entry = litellm.model_cost["azure/deepseek-v4-pro"]
    cache_rate = entry["cache_read_input_token_cost"]
    input_rate = entry["input_cost_per_token"]
    output_rate = entry["output_cost_per_token"]

    expected_prompt_cost = 100 * input_rate + 900 * cache_rate
    assert prompt_cost == pytest.approx(expected_prompt_cost, rel=1e-9)
    assert completion_cost == pytest.approx(100 * output_rate, rel=1e-9)
    # Sanity: pinned to the concrete rate documented in azure_foundry.py so a
    # silent rate change (e.g. re-estimating the ratio) shows up as a diff.
    assert cache_rate == pytest.approx(1.61e-7, rel=1e-6)


# --------------------------------------------------------------------------- #
# azure/DeepSeek-V4-Flash + azure/Kimi-K2.7-Code — 2026-08-08 spend-blindness fix
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("model_id", "input_per_1m", "output_per_1m", "cache_per_1m"),
    [
        ("azure/DeepSeek-V4-Flash", 0.21, 0.56, 0.031),
        ("azure/Kimi-K2.7-Code", 1.05, 4.40, 0.21),
    ],
)
def test_ensure_bootstrapped_registers_new_model_pricing(
    model_id: str, input_per_1m: float, output_per_1m: float, cache_per_1m: float
) -> None:
    """Two Azure deployments created 2026-08-07/08 were reachable but priced
    at $0.0 in ``runs.cost_usd`` — no LiteLLM entry existed, so the daily/
    hourly spend caps were blind to any volume run on them (same class of bug
    as ``azure/deepseek-v4-pro``). Verifies the registration end to end:
    id present, both required rates > 0, provenance note attached.
    """
    azure_foundry.ensure_bootstrapped()
    import litellm

    entry = litellm.model_cost.get(model_id)
    assert entry is not None, f"{model_id} is unregistered after bootstrap"
    assert entry["input_cost_per_token"] > 0
    assert entry["output_cost_per_token"] > 0
    assert "azure retail" in entry.get("factory_cost_note", "").lower()

    prompt_cost, completion_cost = litellm.cost_per_token(
        model=model_id,
        prompt_tokens=1_000_000,
        completion_tokens=1_000_000,
    )
    assert prompt_cost == pytest.approx(input_per_1m, rel=1e-6)
    assert completion_cost == pytest.approx(output_per_1m, rel=1e-6)

    # Cache-read rate is a PUBLISHED Azure meter for both new models (unlike
    # deepseek-v4-pro's estimated one) — assert it's registered and cheaper
    # than the full input rate.
    assert entry.get("cache_read_input_token_cost", 0.0) > 0.0
    assert entry["cache_read_input_token_cost"] < entry["input_cost_per_token"]
    cache_cost, _ = litellm.cost_per_token(
        model=model_id,
        prompt_tokens=0,
        completion_tokens=0,
        cache_read_input_tokens=1_000_000,
    )
    assert cache_cost == pytest.approx(cache_per_1m, rel=1e-6)


def test_new_model_pricing_is_not_flagged_estimated() -> None:
    """Unlike ``deepseek-v4-pro``'s cache-read rate, all rates for the two
    new models come from a published Azure meter — the ``factory_cost_note``
    must NOT carry the ``estimated`` marker ``settings.audit._model_cost_is_estimated``
    keys off, or an operator would distrust a rate that is actually exact.
    """
    azure_foundry.ensure_bootstrapped()
    import litellm

    for model_id in ("azure/DeepSeek-V4-Flash", "azure/Kimi-K2.7-Code"):
        entry = litellm.model_cost.get(model_id)
        assert entry is not None
        assert "estimated" not in entry.get("factory_cost_note", "").lower()


# --------------------------------------------------------------------------- #
# routes.yaml + model_router integration
# --------------------------------------------------------------------------- #


def test_routes_yaml_default_provider_is_azure() -> None:
    """The shipped ``routes.yaml`` must declare azure as default."""
    import os

    # Clear any test-only override (e.g. ``test_model_router.py``'s fixture).
    os.environ.pop("FACTORY_PROVIDER", None)
    assert model_router.active_provider() == "azure"


def test_route_returns_azure_model_under_default_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With ``default_provider: azure`` every persona resolves to an
    ``azure/...`` model id, and (since 2026-08-08) to an OPEN-WEIGHT one."""
    monkeypatch.delenv("FACTORY_PROVIDER", raising=False)
    for persona in (
        "pm",
        "analyst",
        "sm",
        "tech_writer",
        "onboarder",
    ):
        model_id = model_router.route(persona)
        assert model_id.startswith("azure/"), f"{persona} routed to {model_id!r}"
    assert model_router.route("security") == "azure/Kimi-K2.7-Code"
    assert model_router.route("reviewer") == "azure/Kimi-K2.7-Code"
    # The reviewer must differ from BOTH dev tiers — enforced fatally by
    # model_router.check_review_independence at load.
    assert model_router.route("reviewer") != model_router.route("dev", "hard")
    assert model_router.route("reviewer") != model_router.route("dev", "standard")


def test_route_dev_uses_deepseek_v4_pro(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both dev tiers route to deepseek-v4-pro.

    It is the most capable open-weight model on the resource AND the only one
    with throughput headroom: measured over n=706 real dev runs, dev averages
    239,515 TPM and peaks at 546,860, while Kimi-K2.7-Code is capped at
    100 TPM (quota maxed 100/100) and DeepSeek-V4-Flash at 250.

    KNOWN REGRESSION pinned deliberately (2026-08-08): the hard tier is no
    longer a different family, so escalation is a no-op. Under the open-weight
    constraint there is no third capable family to escalate INTO. If this
    assertion ever needs to change, the mitigation is in routes.yaml.
    """
    monkeypatch.delenv("FACTORY_PROVIDER", raising=False)
    assert model_router.route("dev", "standard") == "azure/deepseek-v4-pro"
    assert model_router.route("dev", "hard") == "azure/deepseek-v4-pro"
    # test_implementer is dormant but MUST stay off dev.standard so the
    # shared-model advisory stays clear.
    assert model_router.route("test_implementer") == "azure/DeepSeek-V4-Flash"


def test_route_text_personas_are_open_weight(monkeypatch: pytest.MonkeyPatch) -> None:
    """No persona resolves to a closed-weight model (operator decision 2026-08-08).

    This is the invariant that actually encodes the decision: the exact
    per-persona assignment is a tuning choice, but "nothing closed-weight" is
    the guarantee. ``test_designer`` has no route (Loop-4 persona removal) and
    exercises ``azure_fallback``, which must also be open-weight.
    """
    monkeypatch.delenv("FACTORY_PROVIDER", raising=False)
    open_weight = {
        "azure/deepseek-v4-pro",
        "azure/Kimi-K2.7-Code",
        "azure/DeepSeek-V4-Flash",
    }
    personas = (
        "pm",
        "analyst",
        "sm",
        "tech_writer",
        "onboarder",
        "reviewer",
        "security",
        "acceptance_author",
        "ux_auditor",
        "factory_self_context",
        "test_implementer",
        "test_designer",  # unrouted -> azure_fallback
    )
    for persona in personas:
        model_id = model_router.route(persona)
        assert model_id in open_weight, f"{persona} routed to non-open {model_id!r}"
    for difficulty in ("standard", "hard"):
        model_id = model_router.route("dev", difficulty)
        assert model_id in open_weight, f"dev.{difficulty} routed to {model_id!r}"


def test_factory_provider_env_override_takes_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``FACTORY_PROVIDER=direct`` overrides the YAML's ``default_provider``."""
    monkeypatch.setenv("FACTORY_PROVIDER", "direct")
    assert model_router.route("pm") == "deepseek/deepseek-chat"
    monkeypatch.setenv("FACTORY_PROVIDER", "azure")
    assert model_router.route("pm") == "azure/deepseek-v4-pro"


def test_route_uses_azure_fallback_when_persona_missing(tmp_path: Path) -> None:
    """A persona absent from ``azure_routes`` falls back to ``azure_fallback``."""
    custom = tmp_path / "r.yaml"
    custom.write_text(
        "default_provider: azure\n"
        "azure_routes:\n"
        "  pm: azure/gpt-5.4\n"
        "defaults:\n"
        "  fallback: deepseek/deepseek-chat\n"
        "  azure_fallback: azure/gpt-5.4\n",
        encoding="utf-8",
    )
    assert model_router.route("nonexistent", routes_path=custom) == "azure/gpt-5.4"


# Silence the providers-import-only lint by reaching the module symbol.
_ = providers
