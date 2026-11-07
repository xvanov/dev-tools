"""Persona-aware LiteLLM model routing.

The router reads ``factory/routes.yaml`` (or any path passed in) and returns a
LiteLLM model id for a given persona + difficulty. Routes are intentionally a
plain YAML file so an agent in a later phase can edit them — this is the
self-improvement seam.

Phase 8 — Azure provider support
--------------------------------
``routes.yaml`` may now declare ``default_provider: azure | direct`` and a
separate ``azure_routes:`` block. At runtime the router picks the active
routes block via this precedence:

  1. ``FACTORY_PROVIDER`` env var (``azure`` or ``direct``) — runtime override.
  2. ``default_provider`` from ``routes.yaml``.
  3. ``"direct"`` if neither is set (back-compat).

Tests can inject ``FACTORY_PROVIDER`` to flip providers without touching the
YAML; humans flip the YAML and commit it.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, cast

import yaml

_DEFAULT_ROUTES_PATH = Path(__file__).parent / "routes.yaml"

_log = logging.getLogger(__name__)

# Model-id prefix → env var holding that provider's API key. Single source of
# truth — ``factory.runner._provider_env_key`` delegates here.
#
# ``openai_compat/<model>`` is the generic OpenAI-compatible endpoint (vLLM,
# LM Studio, Together, a self-hosted gateway, …): key in
# ``OPENAI_COMPAT_API_KEY``, endpoint in ``OPENAI_COMPAT_API_BASE`` (REQUIRED —
# see ``provider_base_url``). It is sent to LiteLLM as ``openai/<model>`` with
# that base URL; the ``openai_compat/`` id is what runs/costs record.
_PROVIDER_ENV_KEYS: tuple[tuple[str, str], ...] = (
    ("openai_compat/", "OPENAI_COMPAT_API_KEY"),
    ("openrouter/", "OPENROUTER_API_KEY"),
    ("deepseek/", "DEEPSEEK_API_KEY"),
    ("anthropic/", "ANTHROPIC_API_KEY"),
    ("openai/", "OPENAI_API_KEY"),
    ("azure_ai/", "AZURE_AI_API_KEY"),
    ("azure/", "AZURE_API_KEY"),
)


def provider_env_key(model: str) -> str | None:
    """Return the env-var name that holds the API key for ``model``."""
    for prefix, env_name in _PROVIDER_ENV_KEYS:
        if model.startswith(prefix):
            return env_name
    if model.startswith("claude"):
        return "ANTHROPIC_API_KEY"
    if model.startswith("gpt"):
        return "OPENAI_API_KEY"
    return None


# Optional base-URL env var per prefix (LiteLLM's own default endpoint is used
# when unset), EXCEPT ``openai_compat/`` where it is mandatory: with no base URL
# LiteLLM would send that key to api.openai.com, which is a credential leak, not
# a degradation. Azure prefixes are absent on purpose — the runner owns their
# two-surface base-URL/api-version resolution.
_PROVIDER_BASE_ENV: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("openai_compat/", ("OPENAI_COMPAT_API_BASE",)),
    ("openrouter/", ("OPENROUTER_API_BASE",)),
    ("anthropic/", ("ANTHROPIC_API_BASE", "ANTHROPIC_BASE_URL")),
    ("openai/", ("OPENAI_API_BASE", "OPENAI_BASE_URL")),
)
_REQUIRED_BASE_PREFIXES = ("openai_compat/",)


def provider_base_url(model: str) -> str | None:
    """Return the configured base URL for ``model``'s provider, or ``None``.

    ``None`` means "use LiteLLM's default endpoint for this provider". Azure ids
    always return ``None`` here; ``factory.runner`` resolves those itself.
    """
    for prefix, env_names in _PROVIDER_BASE_ENV:
        if model.startswith(prefix):
            for env_name in env_names:
                value = os.environ.get(env_name, "").strip()
                if value:
                    return value
            return None
    return None


def wire_model_id(model: str) -> str:
    """The model id actually handed to LiteLLM / the OpenHands ``LLM``.

    Identity for every prefix except ``openai_compat/x`` → ``openai/x`` (LiteLLM
    speaks the OpenAI wire protocol to any base URL under ``openai/``). Run
    records keep the LOGICAL id so cost/audit attribution names the endpoint
    that was really used, not api.openai.com.
    """
    if model.startswith("openai_compat/"):
        return "openai/" + model[len("openai_compat/") :]
    return model


def provider_ready(model: str) -> bool:
    """Public: is everything ``model``'s provider needs present in the env?"""
    return _provider_key_available(model)


def _provider_key_available(model: str) -> bool:
    """True when the provider key for ``model`` is present and non-empty.

    Unknown prefixes return True — the runner owns final key resolution and
    error reporting; the router only degrades *known-missing* providers. A
    provider whose base URL is mandatory (``openai_compat/``) also counts as
    unavailable without it.
    """
    if model.startswith(_REQUIRED_BASE_PREFIXES) and provider_base_url(model) is None:
        return False
    env_name = provider_env_key(model)
    if env_name is None:
        return True
    if os.environ.get(env_name):
        return True
    # The runner accepts AZURE_FOUNDRY_API_KEY as a fallback for both Azure
    # surfaces (see factory/runner.py::_resolve_api_key) — mirror that here.
    if env_name in ("AZURE_AI_API_KEY", "AZURE_API_KEY") and os.environ.get(
        "AZURE_FOUNDRY_API_KEY"
    ):
        return True
    return False


# Warn once per (persona, model) so a 60s-cadence caller (L1 watcher) doesn't
# spam the log with an identical degradation notice every tick.
_KEY_FALLBACK_WARNED: set[tuple[str, str]] = set()


class ReviewIndependenceError(ValueError):
    """Raised when ``routes.yaml`` lets the reviewer grade its own model.

    Cross-family review is the only structural defence this factory has
    against a model approving its own reasoning. A config where the reviewer
    and dev resolve to the same deployment does not fail loudly at runtime —
    it silently produces agreeable reviews, which is far worse than a crash.
    """


# Warn-once, keyed by (routes_path, message) so the 60 s-cadence L1 watcher
# does not reprint an identical advisory every tick.
_INDEPENDENCE_WARNED: set[tuple[str, str]] = set()

# Escape hatch. A hard error at route-load time would otherwise leave an
# operator unable to run the very commands that fix a bad routes.yaml. Set
# ``FACTORY_ALLOW_REVIEW_COLLISION=1`` to downgrade the error to a warning.
_ALLOW_COLLISION_ENV = "FACTORY_ALLOW_REVIEW_COLLISION"


def _dev_tier_models(routes_section: dict[str, Any]) -> dict[str, str]:
    """Return ``{tier: model_id}`` for the ``dev`` persona.

    ``dev`` may be a bare string (all tiers identical) or a per-tier mapping.
    """
    entry = routes_section.get("dev")
    if isinstance(entry, str):
        return {"standard": entry, "hard": entry}
    if isinstance(entry, dict):
        return {k: v for k, v in entry.items() if isinstance(v, str)}
    return {}


def check_review_independence(
    data: dict[str, Any], *, provider: str, source: str = "routes.yaml"
) -> list[str]:
    """Validate reviewer/dev model independence for ``provider``'s route block.

    Raises :class:`ReviewIndependenceError` when the reviewer shares a model
    with ANY dev tier. Returns a list of non-fatal advisory messages (today:
    ``test_implementer`` sharing a model with a dev tier, which weakens the
    independent-acceptance-oracle claim in ``routes.yaml`` but does not
    compromise the merge decision).

    Both dev tiers are checked, not just ``standard``. The hard tier is the one
    a story escalates INTO when it is difficult — precisely when independent
    review matters most — so a collision there is the more dangerous of the two.
    """
    routes_section, _ = _routes_section_for(provider, data)
    reviewer = routes_section.get("reviewer")
    if not isinstance(reviewer, str):
        return []

    dev_tiers = _dev_tier_models(routes_section)
    collisions = sorted(tier for tier, model in dev_tiers.items() if model == reviewer)
    if collisions:
        tiers = ", ".join(f"dev.{t}" for t in collisions)
        message = (
            f"{source}: reviewer and {tiers} both resolve to {reviewer!r} under "
            f"provider {provider!r}. Cross-family review is the only structural "
            f"defence against a model approving its own reasoning; a shared model "
            f"makes the review decorative. Give the reviewer or the colliding dev "
            f"tier(s) a distinct deployment. To override deliberately, set "
            f"{_ALLOW_COLLISION_ENV}=1."
        )
        if os.environ.get(_ALLOW_COLLISION_ENV, "").strip() not in ("", "0", "false"):
            _warn_once(source, message)
        else:
            raise ReviewIndependenceError(message)

    advisories: list[str] = []
    test_impl = routes_section.get("test_implementer")
    if isinstance(test_impl, str):
        shared = sorted(tier for tier, model in dev_tiers.items() if model == test_impl)
        if shared:
            advisories.append(
                f"{source}: test_implementer and "
                f"{', '.join(f'dev.{t}' for t in shared)} both resolve to "
                f"{test_impl!r} under provider {provider!r}. routes.yaml claims "
                f"'the test author and the implementer never share a model'. This "
                f"is advisory, not fatal — the acceptance oracle is weakened, but "
                f"the merge decision is not."
            )
    for msg in advisories:
        _warn_once(source, msg)
    return advisories


def _warn_once(source: str, message: str) -> None:
    key = (source, message)
    if key in _INDEPENDENCE_WARNED:
        return
    _INDEPENDENCE_WARNED.add(key)
    _log.warning("%s", message)


def _load_routes(path: Path | None = None) -> dict[str, Any]:
    routes_path = path or _DEFAULT_ROUTES_PATH
    with routes_path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{routes_path} must be a YAML mapping at top level")
    data = cast(dict[str, Any], data)
    # Validate at LOAD, so no model id can ever be resolved out of a config
    # that has already lost reviewer independence. Only the ACTIVE provider
    # block is enforced — an unused block may legitimately be mid-edit.
    check_review_independence(
        data, provider=_active_provider(data), source=str(routes_path)
    )
    return data


def _active_provider(data: dict[str, Any]) -> str:
    env_override = os.environ.get("FACTORY_PROVIDER")
    if env_override:
        return env_override.strip().lower()
    yaml_default = data.get("default_provider")
    if isinstance(yaml_default, str) and yaml_default.strip():
        return yaml_default.strip().lower()
    return "direct"


def _routes_section_for(provider: str, data: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """Return the (routes_mapping, fallback) pair for ``provider``."""
    defaults = data.get("defaults", {}) or {}
    if provider == "azure":
        return (
            data.get("azure_routes", {}) or {},
            defaults.get("azure_fallback") or defaults.get("fallback"),
        )
    return (data.get("routes", {}) or {}, defaults.get("fallback"))


def route(persona: str, difficulty: str = "standard", *, routes_path: Path | None = None) -> str:
    """Return the LiteLLM model id for a persona+difficulty.

    Resolution order (after provider selection — see module docstring):
      1. ``<active_routes>.<persona>`` is a mapping → use
         ``<active_routes>.<persona>[difficulty]``; if missing, try
         ``<active_routes>.<persona>["standard"]``; else fallback.
      2. ``<active_routes>.<persona>`` is a string → return it (difficulty ignored).
      3. Otherwise → ``defaults.fallback`` (or ``defaults.azure_fallback`` for azure).

    Key-aware degradation: if the resolved model's provider API key is absent
    from the environment but the fallback model's key IS available, the
    fallback is returned instead (warned once per persona+model). This keeps a
    freshly-rerouted routes.yaml safe to ship before every provider key is
    provisioned — the intended route activates automatically once its key
    lands in ``.env``.

    Raises ``KeyError`` if no route AND no fallback is configured.
    """
    data = _load_routes(routes_path)
    provider = _active_provider(data)
    routes_section, fallback = _routes_section_for(provider, data)

    resolved: str | None = None
    entry = routes_section.get(persona)
    if isinstance(entry, str):
        resolved = entry
    elif isinstance(entry, dict):
        diff_val = entry.get(difficulty)
        if isinstance(diff_val, str):
            resolved = diff_val
        else:
            std_val = entry.get("standard")
            if isinstance(std_val, str):
                resolved = std_val
            # mapping exists but neither difficulty nor standard present — fall through

    if resolved is not None:
        return _degrade_if_key_missing(persona, resolved, fallback)
    if isinstance(fallback, str):
        return fallback
    raise KeyError(
        f"No route configured for persona={persona!r} difficulty={difficulty!r} "
        f"under provider={provider!r} and no fallback set"
    )


def _degrade_if_key_missing(persona: str, resolved: str, fallback: str | None) -> str:
    """Key-aware degradation shared by ``route`` and per-app/per-job overrides.

    If ``resolved``'s provider is not provisioned but ``fallback``'s is, return
    the fallback (warn once per persona+model); otherwise return ``resolved``.
    """
    if (
        isinstance(fallback, str)
        and fallback != resolved
        and not _provider_key_available(resolved)
        and _provider_key_available(fallback)
    ):
        if (persona, resolved) not in _KEY_FALLBACK_WARNED:
            _KEY_FALLBACK_WARNED.add((persona, resolved))
            _log.warning(
                "route(%s): provider key %s for %r is not set — "
                "degrading to fallback %r until the key is provisioned",
                persona,
                provider_env_key(resolved),
                resolved,
                fallback,
            )
        return fallback
    return resolved


def route_with_overrides(
    persona: str,
    difficulty: str = "standard",
    overrides: dict[str, str] | None = None,
    *,
    routes_path: Path | None = None,
) -> str:
    """``route()``, but a per-app/per-job override map wins when it names ``persona``.

    ``overrides`` keys are ``<persona>`` or ``<persona>.<difficulty>`` (the
    latter wins). Overrides go through the same key-aware degradation as
    routes.yaml entries: a missing provider key degrades to the active block's
    fallback with a warning, never a crash. Independence of the override map is
    validated at submit/spawn by ``factory.job_routing``, not here — by the
    time a handler asks for a model the map was already accepted.
    """
    if overrides:
        chosen = overrides.get(f"{persona}.{difficulty}") or overrides.get(persona)
        if isinstance(chosen, str) and chosen.strip():
            data = _load_routes(routes_path)
            _, fallback = _routes_section_for(_active_provider(data), data)
            return _degrade_if_key_missing(persona, chosen.strip(), fallback)
    return route(persona, difficulty, routes_path=routes_path)


def configured_route_map(*, routes_path: Path | None = None) -> dict[str, Any]:
    """The ACTIVE provider's raw routes block (persona → id or tier mapping)."""
    data = _load_routes(routes_path)
    section, _ = _routes_section_for(_active_provider(data), data)
    return dict(section)


def all_known_personas(*, routes_path: Path | None = None) -> list[str]:
    """Return all persona keys defined in the active routes block.

    Useful for CLI listings — falls back to merging both blocks if the active
    one is empty (defensive: a half-configured YAML shouldn't render the CLI
    empty-handed).
    """
    data = _load_routes(routes_path)
    provider = _active_provider(data)
    routes_section, _ = _routes_section_for(provider, data)
    if not routes_section:
        merged: dict[str, Any] = {}
        merged.update(data.get("routes", {}) or {})
        merged.update(data.get("azure_routes", {}) or {})
        routes_section = merged
    return sorted(routes_section.keys())


def active_provider(*, routes_path: Path | None = None) -> str:
    """Public accessor — returns the provider the router is currently using."""
    return _active_provider(_load_routes(routes_path))


# Params that may flow from routes.yaml's ``llm_params`` block into the
# OpenHands SDK ``LLM(...)`` constructor. Anything else in the YAML is
# silently dropped — a config typo must not be able to crash LLM construction.
_ALLOWED_LLM_PARAMS = frozenset(
    {
        "reasoning_effort",
        "caching_prompt",
        "max_output_tokens",
        "temperature",
        "litellm_extra_body",
    }
)

_KNOWN_DIFFICULTIES = ("standard", "hard")


def llm_params_for(
    persona: str,
    model_id: str,
    *,
    difficulty: str = "standard",
    routes_path: Path | None = None,
) -> dict[str, Any]:
    """Per-persona LLM constructor overrides from routes.yaml's ``llm_params``.

    Merge order (later wins):
      1. ``{"max_output_tokens": max_output_tokens_for(model_id)}``
      2. ``llm_params.defaults``
      3. ``llm_params.personas.<persona>`` — either a flat param mapping or a
         difficulty-keyed mapping of param mappings (same shape convention as
         ``routes.<persona>``).

    Output is allowlisted to ``_ALLOWED_LLM_PARAMS``; unknown keys are dropped.
    """
    data = _load_routes(routes_path)
    merged: dict[str, Any] = {
        "max_output_tokens": max_output_tokens_for(model_id, routes_path=routes_path)
    }

    block = data.get("llm_params", {}) or {}
    defaults = block.get("defaults", {}) or {}
    if isinstance(defaults, dict):
        merged.update(defaults)

    personas = block.get("personas", {}) or {}
    entry = personas.get(persona) if isinstance(personas, dict) else None
    if isinstance(entry, dict):
        # Difficulty-keyed iff its keys are difficulty names mapping to dicts
        # (param names like ``reasoning_effort`` can never collide with those).
        if any(k in entry for k in _KNOWN_DIFFICULTIES):
            diff_entry = entry.get(difficulty) or entry.get("standard") or {}
            if isinstance(diff_entry, dict):
                merged.update(diff_entry)
        else:
            merged.update(entry)

    return {k: v for k, v in merged.items() if k in _ALLOWED_LLM_PARAMS}


def preset_for(persona: str, *, routes_path: Path | None = None) -> str | None:
    """Agent-preset override for ``persona`` from routes.yaml's ``presets``
    block (e.g. ``dev: planning``). ``None`` means the default agent preset."""
    data = _load_routes(routes_path)
    presets = data.get("presets", {}) or {}
    value = presets.get(persona) if isinstance(presets, dict) else None
    return value if isinstance(value, str) and value.strip() else None


# Built-in fallback if neither ``model_limits`` nor
# ``defaults_extra.max_output_tokens_default`` are defined in routes.yaml.
# Picked to cover the smallest current-fleet cap (DeepSeek-V4 native 8k).
_HARD_FALLBACK_MAX_OUTPUT_TOKENS = 8192


def max_output_tokens_for(model_id: str, *, routes_path: Path | None = None) -> int:
    """Return the per-call ``max_tokens`` (= max completion / output) cap
    for ``model_id``.

    Looked up by the LiteLLM model id returned by ``route()``. The value
    is the model's stated output ceiling — distinct from its context
    window (which governs input size).

    Resolution order:
      1. ``model_limits.<model_id>.max_output_tokens`` in routes.yaml.
      2. ``defaults_extra.max_output_tokens_default`` in routes.yaml.
      3. Hard-coded fallback (8192) — covers the smallest current-fleet cap.

    Providers bill by actual tokens used, not by the cap, so generous
    values cost nothing on outputs that fit comfortably. Too-low caps
    cause truncation mid-JSON and downstream JSONDecodeError.
    """
    data = _load_routes(routes_path)
    limits = data.get("model_limits", {}) or {}
    entry = limits.get(model_id)
    if isinstance(entry, dict):
        val = entry.get("max_output_tokens")
        if isinstance(val, int) and val > 0:
            return val
    defaults_extra = data.get("defaults_extra", {}) or {}
    default_val = defaults_extra.get("max_output_tokens_default")
    if isinstance(default_val, int) and default_val > 0:
        return default_val
    return _HARD_FALLBACK_MAX_OUTPUT_TOKENS
