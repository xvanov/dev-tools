"""Per-app and per-job model + pipeline routing (operator decision 2026-11-02).

Two things a job (a direction submitted via ``factory job submit``) may choose,
on top of its app's config and ``factory/routes.yaml``:

* **Models** — direction frontmatter ``models: {persona: model_id}`` (written by
  ``--model persona=id``). Keys are ``<persona>`` or ``<persona>.<difficulty>``
  (``dev.hard``); the tiered key wins over the bare one.

  Precedence, per key: **job > app (``AppConfig.models``) > routes.yaml**.
  Job and app maps are merged key-by-key (``{**app, **job}``); anything neither
  names falls through to ``routes.yaml`` via ``model_router.route``.

* **Pipeline** — frontmatter ``pipeline: chain|solo|auto``. ``auto`` (or
  absent) = the app's ``AppConfig.pipeline_default``; a ``pipeline_default``
  of ``auto`` (or none) means ``chain``.

The frontmatter keys are exactly the ones ``factory job submit`` writes:
``pipeline:`` and ``models:``. (``delivery:`` is the third; it is resolved by
``factory/delivery.py``, not here.)

Both are resolved ONCE, at story spawn (``handle_stories_spawned``), and stamped
on the ``StoryRecord`` (``model_overrides_json``, ``pipeline``) — the same
"stamped at spawn, never read live at dispatch" rule B.1 set for chain mode, so
editing a direction or an app config mid-flight cannot change an in-flight
story's models. Every run row already records the model it actually used, so
cost/audit attribution follows the override with no extra bookkeeping.

Everything here REFUSES rather than repairs: an unknown persona key, a model id
with no provider prefix, a reviewer that would share a model with a dev tier,
or a pipeline the app cannot run all raise :class:`JobRoutingError` with a
stable ``code`` the job CLI prints as ``{"error": code, ...}``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from factory.app_config import PIPELINE_NAMES
from factory.model_router import (
    _dev_tier_models,
    configured_route_map,
    provider_ready,
    route_with_overrides,
)

if TYPE_CHECKING:
    from factory.app_config import AppConfig

#: The one pipeline vocabulary (``AppConfig.pipeline_default`` uses the same).
PIPELINES: tuple[str, ...] = PIPELINE_NAMES
_DIFFICULTIES = ("standard", "hard")
_PERSONAS_DIR = Path(__file__).parent / "personas"
# ``<provider>/<model>`` — a bare id would make provider-key resolution (and
# therefore the missing-key degradation) silently guess.
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]+/\S+$")

#: Whether the production chain can execute a ``solo`` story. True since the
#: production solo engine landed (``factory/chain/solo.py``): the
#: ``TESTS_GREEN → tech_writer`` edge, solo dispatch in the orchestrator, one
#: long dev conversation with in-conversation gate feedback, and the blocking
#: oracle-leak precondition. Kept as a kill switch: set False to refuse every
#: new solo request with ``pipeline_unavailable`` (stories already stamped solo
#: still finish under solo — the mode is read from the row, never from here).
SOLO_PIPELINE_IMPLEMENTED = True


class JobRoutingError(ValueError):
    """A job's model/pipeline request cannot be honoured. Never auto-repaired."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class JobRouting:
    """The resolved, validated routing a story is stamped with at spawn."""

    pipeline: str  # "chain" | "solo" (never "auto" — resolved)
    pipeline_requested: str  # what the job asked for ("auto" when absent)
    model_overrides: dict[str, str] = field(default_factory=dict)  # merged app+job
    model_sources: dict[str, str] = field(default_factory=dict)  # key -> "job"|"app"
    warnings: tuple[str, ...] = ()

    def overrides_json(self) -> str | None:
        return json.dumps(self.model_overrides, sort_keys=True) if self.model_overrides else None


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


def parse_model_flags(flags: list[str] | tuple[str, ...]) -> dict[str, str]:
    """``["dev=anthropic/claude-x", "reviewer=azure/gpt-5.4"]`` → mapping.

    For ``factory job submit --model persona=id`` (repeatable). A repeated
    persona is an error, not last-wins — the requester typed two answers.
    """
    out: dict[str, str] = {}
    for raw in flags:
        persona, sep, model = (raw or "").partition("=")
        persona, model = persona.strip(), model.strip()
        if not sep or not persona or not model:
            raise JobRoutingError(
                "bad_model_flag", f"--model expects persona=model_id, got {raw!r}"
            )
        if persona in out:
            raise JobRoutingError("bad_model_flag", f"--model given twice for {persona!r}")
        out[persona] = model
    return out


def _known_personas() -> set[str]:
    names = {p.stem for p in _PERSONAS_DIR.glob("*.md")}
    try:
        names |= set(configured_route_map().keys())
    except Exception:  # noqa: BLE001 - a broken routes.yaml fails elsewhere, loudly
        pass
    return names


def validate_model_map(models: Any, *, source: str) -> dict[str, str]:
    """Shape-check a ``models`` mapping from a direction or app config."""
    if models in (None, {}):
        return {}
    if not isinstance(models, dict):
        raise JobRoutingError(
            "bad_models", f"{source}: `models` must be a mapping persona -> model_id"
        )
    known = _known_personas()
    out: dict[str, str] = {}
    for key, value in models.items():
        key_s = str(key).strip()
        persona, _, tier = key_s.partition(".")
        if persona not in known:
            raise JobRoutingError(
                "unknown_persona",
                f"{source}: model override for unknown persona {key_s!r} "
                f"(known: {', '.join(sorted(known))})",
            )
        if tier and tier not in _DIFFICULTIES:
            raise JobRoutingError(
                "unknown_persona",
                f"{source}: {key_s!r} — tier must be one of {', '.join(_DIFFICULTIES)}",
            )
        if not isinstance(value, str) or not _MODEL_ID_RE.match(value.strip()):
            raise JobRoutingError(
                "bad_model_id",
                f"{source}: {key_s!r} -> {value!r} is not a '<provider>/<model>' id "
                "(e.g. anthropic/claude-sonnet-4-5, openrouter/…, openai_compat/…)",
            )
        out[key_s] = value.strip()
    return out


# --------------------------------------------------------------------------- #
# Reviewer independence over the EFFECTIVE map
# --------------------------------------------------------------------------- #


def effective_independence_view(
    overrides: dict[str, str], *, routes_path: Path | None = None
) -> tuple[str | None, dict[str, str]]:
    """``(reviewer_model, {dev_tier: model})`` after applying ``overrides``.

    Uses CONFIGURED ids (pre key-degradation), same as the router-load check:
    independence is a property of what the operator/requester asked for.
    """
    section = configured_route_map(routes_path=routes_path)
    base_reviewer = section.get("reviewer")
    reviewer = (
        overrides.get("reviewer.standard")
        or overrides.get("reviewer")
        or (base_reviewer if isinstance(base_reviewer, str) else None)
    )
    dev = _dev_tier_models(section)
    tiers = set(dev) | set(_DIFFICULTIES)
    eff_dev: dict[str, str] = {}
    for tier in sorted(tiers):
        model = overrides.get(f"dev.{tier}") or overrides.get("dev") or dev.get(tier)
        if model is None:
            # A tier routes.yaml does not name resolves like route() does.
            model = dev.get("standard")
        if model:
            eff_dev[tier] = model
    return reviewer, eff_dev


def check_override_independence(
    overrides: dict[str, str],
    sources: dict[str, str] | None = None,
    *,
    routes_path: Path | None = None,
) -> None:
    """Refuse an override map under which the reviewer shares a dev tier's model.

    Unlike the routes.yaml check, ``FACTORY_ALLOW_REVIEW_COLLISION`` is NOT
    honoured here: that hatch exists so an operator can run the commands that
    repair a bad routes.yaml. A job has no such need — it can simply name a
    different reviewer — and a silently-agreeable review is the failure the
    rule exists to prevent.
    """
    if not overrides:
        return
    reviewer, dev = effective_independence_view(overrides, routes_path=routes_path)
    if reviewer is None:
        return
    collisions = sorted(t for t, m in dev.items() if m == reviewer)
    if collisions:
        srcs = sources or {}
        blamed = sorted(
            f"{k} ({srcs.get(k, 'override')})"
            for k in overrides
            if k.split(".")[0] in ("reviewer", "dev")
        )
        raise JobRoutingError(
            "review_independence",
            f"reviewer and {', '.join(f'dev.{t}' for t in collisions)} would both run "
            f"{reviewer!r} after overrides [{', '.join(blamed)}]. The reviewer must not "
            "share a model with any dev tier; name a different reviewer or dev model.",
        )


def check_runtime_independence(
    overrides: dict[str, str],
    sources: dict[str, str] | None = None,
    *,
    routes_path: Path | None = None,
) -> None:
    """The same rule on the models that will ACTUALLY run in this environment.

    Every reviewer and dev-tier model is resolved the way a handler resolves it
    (``route_with_overrides``: override, else routes.yaml, each through the
    missing-key degradation). This catches BOTH directions of a degraded
    collision: an override whose key is absent falling back onto the dev model,
    and a routes.yaml dev tier whose key is absent falling back onto a
    reviewer the job named. Only runs when the overrides touch reviewer or dev:
    a job that leaves both alone runs exactly what the router-load check
    already accepted for every other story.
    """
    if not any(k.split(".")[0] in ("reviewer", "dev") for k in overrides):
        return
    section = configured_route_map(routes_path=routes_path)
    reviewer = route_with_overrides("reviewer", "standard", overrides, routes_path=routes_path)
    tiers = sorted(set(_dev_tier_models(section)) | set(_DIFFICULTIES))
    dev = {t: route_with_overrides("dev", t, overrides, routes_path=routes_path) for t in tiers}
    collisions = sorted(t for t, m in dev.items() if m == reviewer)
    if collisions:
        srcs = sources or {}
        blamed = sorted(
            f"{k} ({srcs.get(k, 'override')})"
            for k in overrides
            if k.split(".")[0] in ("reviewer", "dev")
        )
        raise JobRoutingError(
            "review_independence",
            "after missing-key degradation to the routes.yaml fallback: reviewer and "
            f"{', '.join(f'dev.{t}' for t in collisions)} would both run {reviewer!r} "
            f"[{', '.join(blamed)}]. Set the missing provider key/base URL, or name a "
            "reviewer/dev model whose provider is configured here.",
        )


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #


def solo_refusal_reason(app_config: AppConfig) -> str | None:
    """Why ``app_config``'s app cannot run a solo story, or ``None`` if it can.

    The B.1 design required ``gates.acceptance_oracle: true`` for solo. The
    operator dropped that coupling on 2026-11-02: the oracle is off fleet-wide
    and vacuous on non-web repos (``oracle_vacuity_is_webapp_shaped``), and solo
    must be usable on any repo. A solo story's independent checks are the app's
    test command, its required merge gates and CI; when the app DOES enable the
    oracle it is a required merge gate and its leak check blocks every solo dev
    dispatch (``factory/chain/solo.py``). What ran is logged per story
    (``solo_checks``). Refusals left: the engine kill switch, and the factory's
    own app without an explicit ``solo_allowed: true`` opt-in.
    """
    if not SOLO_PIPELINE_IMPLEMENTED:
        return (
            "solo pipeline is disabled (job_routing.SOLO_PIPELINE_IMPLEMENTED is "
            "False); running this job as solo would silently run the full chain. "
            "Submit with --pipeline chain or auto."
        )
    from factory.app_config import targets_factory_repo

    if (
        targets_factory_repo(getattr(app_config, "repo", None))
        or getattr(app_config, "name", "") == "factory"
    ) and not bool(getattr(app_config, "solo_allowed", False)):
        return (
            f"app {app_config.name!r} is the factory itself: solo removes the reviewer "
            "from a self-edit, which needs an explicit operator opt-in "
            "(`solo_allowed: true` in apps/factory/config.yaml)."
        )
    return None


def resolve_pipeline(requested: str | None, app_config: AppConfig) -> tuple[str, str]:
    """``(effective, requested)``; raises when the request cannot be honoured."""
    req = (requested or "auto").strip().lower()
    if req not in PIPELINES:
        raise JobRoutingError(
            "bad_pipeline", f"pipeline must be one of {', '.join(PIPELINES)}, got {requested!r}"
        )
    if req == "auto":
        effective = getattr(app_config, "pipeline_default", None) or "chain"
        if effective == "auto":
            # v1: "the factory decides" at the app level = chain.
            effective = "chain"
        # An ``auto`` job inherits the app default; if that default is solo but
        # solo is unavailable, refuse rather than quietly fall back to chain —
        # the app config claims a mode the factory cannot deliver.
    else:
        effective = req
    if effective == "solo":
        reason = solo_refusal_reason(app_config)
        if reason is not None:
            raise JobRoutingError("pipeline_unavailable", reason)
    return effective, req


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #


def resolve_job_routing(
    app_config: AppConfig,
    *,
    job_models: Any = None,
    pipeline: str | None = None,
    source: str = "direction",
    routes_path: Path | None = None,
) -> JobRouting:
    """Validate and merge a job's routing request against its app.

    Call at SUBMIT (``factory job submit``, before writing the direction) and
    again at SPAWN (``handle_stories_spawned``) — the app config or routes.yaml
    may have changed in between, and spawn is what binds.
    """
    app_models = validate_model_map(app_config.models, source=f"apps/{app_config.name}/config.yaml")
    jm = validate_model_map(job_models, source=source)
    merged: dict[str, str] = {**app_models, **jm}
    sources = {k: ("job" if k in jm else "app") for k in merged}
    check_override_independence(merged, sources, routes_path=routes_path)
    # Same check on what will ACTUALLY run in this environment: an override
    # whose provider is not provisioned degrades to the routes.yaml fallback,
    # and today's azure_fallback IS the dev model — so ``reviewer=anthropic/…``
    # with no ANTHROPIC_API_KEY would otherwise review with the dev's model.
    # (Also covers a routes.yaml dev tier degrading onto a job-named reviewer.)
    check_runtime_independence(merged, sources, routes_path=routes_path)
    effective, requested = resolve_pipeline(pipeline, app_config)
    warnings = tuple(
        f"{k}={v}: provider not configured in this environment — will degrade to the "
        "routes.yaml fallback until its key/base URL is set"
        for k, v in sorted(merged.items())
        if not provider_ready(v)
    )
    return JobRouting(
        pipeline=effective,
        pipeline_requested=requested,
        model_overrides=merged,
        model_sources=sources,
        warnings=warnings,
    )


def resolve_for_direction(direction: Any, app_config: AppConfig) -> JobRouting:
    """``resolve_job_routing`` from a parsed ``Direction``'s frontmatter."""
    fm = getattr(direction, "raw_frontmatter", None) or {}
    did = getattr(direction, "id_slug", None) or getattr(direction, "slug", "?")
    return resolve_job_routing(
        app_config,
        job_models=fm.get("models"),
        pipeline=fm.get("pipeline"),
        source=f"direction {did} frontmatter",
    )


def story_overrides(story: Any) -> dict[str, str]:
    """The override map stamped on a story at spawn (``{}`` when none/corrupt)."""
    raw = getattr(story, "model_overrides_json", None)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def override_for_story(story: Any, persona: str, difficulty: str = "standard") -> str | None:
    """The stamped override for ``persona`` on ``story`` (key-degraded), or ``None``.

    ``None`` means "no override — ask routes.yaml", so callers can keep calling
    their own (monkeypatchable) ``route``.
    """
    overrides = story_overrides(story)
    if not overrides:
        return None
    if not (overrides.get(f"{persona}.{difficulty}") or overrides.get(persona)):
        return None
    return route_with_overrides(persona, difficulty, overrides)


def route_for_story(story: Any, persona: str, difficulty: str = "standard") -> str:
    """The model a handler must use for ``persona`` on ``story``.

    Reads ONLY the spawn-time stamp, never the live direction/app config.
    """
    return route_with_overrides(persona, difficulty, story_overrides(story))
