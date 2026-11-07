"""Azure provider bootstrap (covers BOTH Foundry and Azure-OpenAI shapes).

Two distinct Azure surfaces are supported. They live in this module together
because they share env-remap mechanics and a single idempotent bootstrap
entry point; the wire shapes diverge entirely.

1. **Azure AI Foundry** (``services.ai.azure.com/models``-style endpoints)
   — addressed in LiteLLM via the ``azure_ai/`` prefix. Foundry exposes an
   OpenAI-compatible chat-completions endpoint at
   ``<base>/chat/completions?api-version=<version>``. LiteLLM auto-downgrades
   to the Azure-OpenAI deployment URL whenever the model name (e.g.
   ``gpt-4.1``) appears in ``litellm.open_ai_chat_completion_models``; we
   monkey-patch that detection off so every ``azure_ai/...`` id uses the
   simpler OpenAI-compatible path.

2. **Azure OpenAI / Cognitive Services** (``cognitiveservices.azure.com``
   endpoints with named deployments) — addressed in LiteLLM via the plain
   ``azure/`` prefix. Each deployment is reached at
   ``<base>/openai/deployments/<deployment>/chat/completions?api-version=X``.
   LiteLLM reads ``AZURE_API_BASE`` / ``AZURE_API_KEY`` / ``AZURE_API_VERSION``
   from the environment automatically — we only need to remap the friendlier
   ``AZURE_ENDPOINT`` name into ``AZURE_API_BASE``.

``ensure_bootstrapped()`` is idempotent and is called at the start of every
Azure-bound runner code path. It:

  1. Remaps ``AZURE_FOUNDRY_*`` env vars → LiteLLM's ``AZURE_AI_API_*`` names
     (Foundry path).
  2. Remaps ``AZURE_ENDPOINT`` → ``AZURE_API_BASE`` (Azure-OpenAI path).
     ``AZURE_API_KEY`` / ``AZURE_API_VERSION`` already match LiteLLM's
     expected names and are left as-is.
  3. Sets ``litellm.drop_params = True`` so newer reasoning-class models
     (``gpt-5.4`` etc.) that reject the legacy ``max_tokens`` get it
     translated to ``max_completion_tokens`` instead of 400-ing.
  4. Monkey-patches LiteLLM's Foundry detection. This is a no-op for the
     plain ``azure/`` path; it only affects ``azure_ai/`` calls.

We never overwrite a value the operator set explicitly.
"""

from __future__ import annotations

import os

# Track whether bootstrap ran in this process so test code can re-invoke it.
_bootstrapped: bool = False


def _remap_env() -> None:
    """Copy operator-friendly env-var names into LiteLLM-expected ones.

    Two independent remaps:

    * ``AZURE_FOUNDRY_*`` → ``AZURE_AI_API_*`` (Foundry / ``azure_ai/`` path).
    * ``AZURE_ENDPOINT`` → ``AZURE_API_BASE`` (Azure-OpenAI / ``azure/`` path).

    ``AZURE_API_KEY`` / ``AZURE_API_VERSION`` are already LiteLLM-standard
    names and are left untouched.

    We never overwrite a destination that is already set explicitly.
    """
    pairs = [
        # Foundry (azure_ai/...) path
        ("AZURE_FOUNDRY_ENDPOINT", "AZURE_AI_API_BASE"),
        ("AZURE_FOUNDRY_API_KEY", "AZURE_AI_API_KEY"),
        ("AZURE_FOUNDRY_API_VERSION", "AZURE_AI_API_VERSION"),
        # Azure-OpenAI (azure/...) path — operator-friendly alias for AZURE_API_BASE
        ("AZURE_ENDPOINT", "AZURE_API_BASE"),
    ]
    for src, dst in pairs:
        src_val = os.environ.get(src)
        if src_val and not os.environ.get(dst):
            os.environ[dst] = src_val


def _patch_litellm_azure_ai() -> None:
    """Force LiteLLM's ``azure_ai/`` provider to use the OpenAI-compatible path.

    Without this patch, ``azure_ai/gpt-4.1`` is detected as Azure OpenAI and
    routed to ``<base>/openai/deployments/<name>/chat/completions``, which
    does not exist on a Foundry endpoint. The override forces the simpler
    ``<base>/chat/completions?api-version=X`` path.

    Affects ONLY ``azure_ai/...`` calls. The plain ``azure/...`` path is
    untouched and continues to use the deployment-name URL it expects.
    """
    try:
        from litellm.llms.azure_ai.chat.transformation import AzureAIStudioConfig
    except Exception:  # pragma: no cover — LiteLLM should always be importable
        return

    AzureAIStudioConfig._is_azure_openai_model = (  # type: ignore[method-assign]
        lambda self, model, api_base: False
    )


def _enable_litellm_drop_params() -> None:
    """Make LiteLLM silently drop / translate provider-unsupported params.

    ``gpt-5.4`` (and other 2026 reasoning-class models) reject the legacy
    ``max_tokens`` parameter and want ``max_completion_tokens`` instead. With
    ``drop_params=True``, LiteLLM auto-translates rather than 400-ing, so
    callers can keep passing ``max_tokens`` uniformly.
    """
    try:
        import litellm

        litellm.drop_params = True
    except Exception:  # pragma: no cover
        return


# Estimated per-token costs for ``azure/deepseek-v4-pro``. LiteLLM ships
# without a pricing entry for this Azure deployment, so every sandbox dev /
# test_implementer run lands a ``cost=0.0`` row in ``state/factory.db.runs``
# even though the model burns 700K+ tokens per call. Without a price, the
# chain's spend caps are useless against the heaviest model.
#
# Verified 2026-07-18 against the Azure retail price API (eastus2, the
# ``FW DeepSeek-V4-Pro`` meters — the only published tier; our deployment is
# GlobalStandard, whose rate matches or slightly undercuts Data Zone):
#   input   $0.00193 / 1K = $1.93 / 1M
#   output  $0.00383 / 1K = $3.83 / 1M
# The prior estimate ($0.50 / $1.50 per 1M) UNDER-counted dev spend ~3.8x on
# input and ~2.5x on output — dev/test_implementer bulk runs on this model,
# so historical ``runs.cost_usd`` for those rows reads low by roughly that
# much. (Cost Management actuals would be the final word but this account
# lacks the RBAC role for the billing API; retail list price is the
# authoritative published rate.)
_DEEPSEEK_V4_PRO_INPUT_PER_TOKEN = 0.00000193  # $1.93 per 1M (Azure retail, eastus2)
_DEEPSEEK_V4_PRO_OUTPUT_PER_TOKEN = 0.00000383  # $3.83 per 1M (Azure retail, eastus2)

# D003 audit finding (2026-07-19): this registration had NO
# ``cache_read_input_token_cost``. LiteLLM's ``generic_cost_per_token`` prices
# cache-hit prompt tokens at whatever that key resolves to — and its
# ``_get_cost_per_unit`` helper DEFAULTS A MISSING KEY TO 0.0, not to the full
# input rate. Concretely: ``cost_per_token(model="azure/deepseek-v4-pro",
# prompt_tokens=1000, completion_tokens=100, cache_read_input_tokens=900)``
# returned a prompt_cost of $0.000193 (only the 100 uncached tokens billed) —
# the other 900 tokens cost nothing. Runs show ~93% cache-hit on this route
# (dev standard / test_implementer / manager_watcher — the heaviest-volume
# model), so historical ``runs.cost_usd`` for those rows UNDERSTATES real
# spend by roughly that fraction, not overstates it.
#
# No Azure retail meter publishes a separate cached-token rate for this
# deployment, so the rate below is an ESTIMATE: LiteLLM's own built-in entry
# for the same model on a different host (``fireworks_ai/deepseek-v4-pro``)
# publishes cache_read_input_token_cost=$0.145/1M against an input rate of
# $1.74/1M — a ~8.33% cache/input ratio. Applying that ratio to our verified
# Azure input rate ($1.93/1M) gives the estimate below. Flagged as ESTIMATED
# in the registration metadata like the other two rates.
_DEEPSEEK_V4_PRO_CACHE_READ_PER_TOKEN = 1.61e-7  # ~$0.161 per 1M (estimated, see above)

# Two Azure deployments created 2026-08-07/08 and reachable via live smoke
# calls: ``azure/DeepSeek-V4-Flash`` and ``azure/Kimi-K2.7-Code``. Same defect
# as ``azure/deepseek-v4-pro`` above — LiteLLM ships without a price entry
# for either, so every call landed ``cost_usd = 0.0`` in ``runs``, making
# ``caps.daily_spend_usd`` / the hourly cap / the per-story budget breaker
# blind to any volume run on them. Registered here before either model is
# routed to a persona (this fix does not touch ``routes.yaml``).
#
# Verified 2026-08-08 against the Azure retail price API
# (prices.azure.com/api/retail/prices), Data Zone (DZ) tier, eastus2 — same
# caveat as deepseek-v4-pro: our deployments are GlobalStandard, whose rate
# matches or slightly undercuts Data Zone.
#
#   product "Azure Deepseek Models", meter "V4 Flash * DZ Tokens":
#     input        $0.00021 / 1K = $0.21 / 1M
#     output       $0.00056 / 1K = $0.56 / 1M
#     cached input $0.000031/ 1K = $0.031/ 1M
#   product "Azure Fireworks Models", meter "FW Kimi K2.7 Code * DZ Tokens":
#     input        $0.00105 / 1K = $1.05 / 1M
#     output       $0.0044  / 1K = $4.40 / 1M
#     cached input $0.00021 / 1K = $0.21 / 1M
#
# Both cached-input rates are PUBLISHED Azure meters (unlike deepseek-v4-pro's
# estimated cache rate above) — no scaling/estimation needed for either model.
_DEEPSEEK_V4_FLASH_INPUT_PER_TOKEN = 0.00000021  # $0.21 / 1M (Azure retail DZ, eastus2)
_DEEPSEEK_V4_FLASH_OUTPUT_PER_TOKEN = 0.00000056  # $0.56 / 1M (Azure retail DZ, eastus2)
_DEEPSEEK_V4_FLASH_CACHE_READ_PER_TOKEN = 3.1e-8  # $0.031 / 1M (Azure retail DZ, eastus2)

_KIMI_K2_7_CODE_INPUT_PER_TOKEN = 0.00000105  # $1.05 / 1M (Azure retail DZ, eastus2)
_KIMI_K2_7_CODE_OUTPUT_PER_TOKEN = 0.0000044  # $4.40 / 1M (Azure retail DZ, eastus2)
_KIMI_K2_7_CODE_CACHE_READ_PER_TOKEN = 2.1e-7  # $0.21 / 1M (Azure retail DZ, eastus2)


def _register_litellm_pricing() -> None:
    """Register cost-per-token entries for Azure deployments LiteLLM doesn't know.

    Registers ``azure/deepseek-v4-pro``, ``azure/DeepSeek-V4-Flash`` and
    ``azure/Kimi-K2.7-Code``; the other deployments on the resource
    (``azure/gpt-5.4``, ``azure/gpt-5.3-codex``) get prices from LiteLLM's
    built-in table. Re-registering an already-known model is a no-op for the
    price fields; LiteLLM simply overwrites them.

    The pricing values are flagged as ESTIMATED in the metadata only where
    that's true (currently just ``deepseek-v4-pro``'s cache-read rate) — the
    source of truth is the constants above this function.
    """
    try:
        import litellm

        litellm.register_model(
            {
                "azure/deepseek-v4-pro": {
                    "input_cost_per_token": _DEEPSEEK_V4_PRO_INPUT_PER_TOKEN,
                    "output_cost_per_token": _DEEPSEEK_V4_PRO_OUTPUT_PER_TOKEN,
                    "cache_read_input_token_cost": _DEEPSEEK_V4_PRO_CACHE_READ_PER_TOKEN,
                    "litellm_provider": "azure",
                    "mode": "chat",
                    # Marker so anyone inspecting the cost map sees the caveat.
                    "factory_cost_note": (
                        "Azure retail eastus2 2026-07-18 ($1.93/$3.83 per 1M); "
                        "cache_read rate estimated 2026-07-19 by scaling the "
                        "fireworks_ai/deepseek-v4-pro cache/input ratio onto "
                        "this deployment's input rate — no published Azure "
                        "meter for cached tokens on this deployment."
                    ),
                },
                "azure/DeepSeek-V4-Flash": {
                    "input_cost_per_token": _DEEPSEEK_V4_FLASH_INPUT_PER_TOKEN,
                    "output_cost_per_token": _DEEPSEEK_V4_FLASH_OUTPUT_PER_TOKEN,
                    "cache_read_input_token_cost": _DEEPSEEK_V4_FLASH_CACHE_READ_PER_TOKEN,
                    "litellm_provider": "azure",
                    "mode": "chat",
                    "factory_cost_note": (
                        "Azure retail DZ tier, eastus2, verified 2026-08-08 "
                        "($0.21/$0.56 per 1M, cache_read $0.031/1M) — all "
                        "three rates are EXACT published Azure meters."
                    ),
                },
                "azure/Kimi-K2.7-Code": {
                    "input_cost_per_token": _KIMI_K2_7_CODE_INPUT_PER_TOKEN,
                    "output_cost_per_token": _KIMI_K2_7_CODE_OUTPUT_PER_TOKEN,
                    "cache_read_input_token_cost": _KIMI_K2_7_CODE_CACHE_READ_PER_TOKEN,
                    "litellm_provider": "azure",
                    "mode": "chat",
                    "factory_cost_note": (
                        "Azure retail DZ tier, eastus2, verified 2026-08-08 "
                        "($1.05/$4.40 per 1M, cache_read $0.21/1M) — all "
                        "three rates are EXACT published Azure meters."
                    ),
                },
            }
        )
    except Exception:  # pragma: no cover — LiteLLM should always be importable
        return


def ensure_bootstrapped() -> None:
    """Idempotent bootstrap. Call before any Azure-bound LLM completion."""
    global _bootstrapped
    if _bootstrapped:
        return
    _remap_env()
    _patch_litellm_azure_ai()
    _enable_litellm_drop_params()
    _register_litellm_pricing()
    _bootstrapped = True


def reset_for_tests() -> None:
    """Test-only: re-allow bootstrap to run again (env may have changed)."""
    global _bootstrapped
    _bootstrapped = False
