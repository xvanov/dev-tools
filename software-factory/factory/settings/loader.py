"""Load and validate ``factory_settings.yaml``.

The settings file is the **global** dial: caps (concurrency, spend),
mode set, rate limits, and direction defaults. The runtime *mode* is
mutable state and lives in ``state/factory.db.factory_state``, not in
this YAML — the YAML only declares which mode names are allowed.

A missing file resolves to the documented defaults so a fresh checkout
boots without yelling.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class CapsConfig(BaseModel):
    global_concurrent_agents: int = 2
    per_repo_concurrent_agents: int = 2
    daily_spend_usd: float = 10.0
    hourly_spend_usd: float = 2.0
    # WS1.1 GLOBAL per-story circuit breaker. The daily/hourly caps above are
    # factory-wide; these bound a SINGLE story's aggregate cost across every
    # composed loop it passes through (dev retries, reviewer cycles, tech_writer,
    # docs, auto-recovery re-dispatch, CI-fix). Crossing either advances the
    # story to the terminal BLOCKED_BUDGET_EXCEEDED sink so one pathological
    # story can't burn the product of all the per-loop counters. Configurable
    # from the same ``caps:`` block in ``factory_settings.yaml``.
    per_story_spend_usd: float = 5.0
    per_story_attempts: int = 20


class QueuesConfig(BaseModel):
    human_review_max_open_prs: int = 5
    failing_ci_pause_threshold: int = 3


class RateLimitsConfig(BaseModel):
    pm_invocations_per_hour: int = 4
    security_runs_per_day: int = 1
    ux_auditor_runs_per_day: int = 2


class ModesConfig(BaseModel):
    default: str = "normal"
    available: list[str] = Field(
        default_factory=lambda: [
            "normal",
            "fix-only",
            "drain-reviews",
            "paused",
            "exploratory",
            "deploy-frozen",
            "ux-audit-only",
        ]
    )


class DirectionDefaults(BaseModel):
    require_user_flow_for_ui: bool = True
    require_api_spec_for_backend: bool = True
    allow_explore_tag: bool = True
    max_dev_retries: int = 4
    escalate_model_on_retry: bool = True
    require_context_update_per_pr: bool = True
    enforce_canonical_doc_paths: bool = True


class AutoMergeConfig(BaseModel):
    """Controls the end-of-tick auto-merge worker.

    When ``enabled`` is true, ``orchestrator.tick`` calls
    ``auto_merge_tick`` after every story handler runs. ``trigger`` is
    reserved for future hooks (webhook-driven, scheduled) — currently
    only ``end_of_tick`` is honored.

    ``merge_method`` is passed through to ``gh pr merge`` (``squash`` |
    ``merge`` | ``rebase``). ``wait_for_ci`` adds ``--auto`` so GitHub
    holds the merge until required checks pass; for repos without
    required checks the merge happens immediately.
    """

    enabled: bool = False
    trigger: str = "end_of_tick"
    merge_method: str = "squash"
    delete_branch_after_merge: bool = True
    wait_for_ci: bool = True
    # Post-merge BMAD context-tree refresh. DISABLED by default (2026-07-18):
    # the current implementation is a PLACEHOLDER that only appends a
    # ``<!-- factory:context-refresh ts=... -->`` marker to the same handful
    # of context/ files every merge — zero real content, and because every
    # refresh touches the same append point they pile up as mutually
    # CONFLICTING orphan PRs with no merge path (they carry no StoryRecord,
    # so the auto-merge worker never evaluates them). Re-enable only once the
    # placeholder is swapped for a real onboarder/tech_writer invocation AND
    # the opener supersedes its own prior open PR.
    context_refresh_enabled: bool = False


class DevConvergenceConfig(BaseModel):
    """In-tick run-until-green convergence loop for the dev persona.

    When ``enabled``, a red dev run retries IMMEDIATELY inside the same
    ``handle_dev`` invocation (fresh sandbox, prior-attempts memory carried
    forward) instead of waiting for the next 5-minute tick — compressing
    N tick-gaps out of a story's convergence time. The loop never grants
    extra attempts: ``_MAX_DEV_RETRIES`` remains the single authoritative
    retry cap; this only changes WHEN the same retries happen.

    Guards (any failing guard stops the loop and falls back to the normal
    across-ticks path): ``max_inner_attempts`` per invocation, one retry of
    headroom under the chain cap, ``per_story_wall_clock_s`` elapsed,
    ``per_story_budget_usd`` spent by this story since the loop started,
    and a live re-check of the global hourly/daily spend caps (the settings
    enforcer only gates dispatch, so a tight loop must re-check mid-flight).
    """

    enabled: bool = False
    max_inner_attempts: int = 3
    per_story_wall_clock_s: int = 2700
    per_story_budget_usd: float = 8.0
    # Per-sandbox wall-clock passed to ``sandbox_run`` for dev; the module
    # default (1800s) stays in force when this matches it.
    dev_sandbox_timeout_s: int = 1800
    # WS4.2 resume-from-checkpoint. When True (default), a dev dispatch that
    # finds a persisted GREEN checkpoint (a prior sandbox completed green but
    # the tick died before the DB advanced out of ``dev_in_progress``) resumes
    # to ``tests_green`` from the persisted result INSTEAD of re-running the
    # (already-complete, already-in-the-worktree) dev LLM. Default-on is safe:
    # the skip fires ONLY when an unambiguous green checkpoint is present, which
    # is written and then cleared within a single normal ``handle_dev`` call, so
    # it survives only a genuine interruption. Set False to force the historical
    # always-re-run behaviour.
    resume_from_checkpoint: bool = True


class AutoPMSyncConfig(BaseModel):
    """Controls automatic PM triage of pending directions on every tick.

    When ``enabled``, ``factory tick`` runs the pm-sync pipeline whenever
    directions with status ``created``/``needs-direction`` exist, so work
    filed by the scheduled personas (security, ux_auditor, …) or
    by ``factory tell`` flows into stories without an operator remembering
    to run ``factory pm-sync``. Bounded by
    ``rate_limits.pm_invocations_per_hour`` (counted from real ``pm`` rows
    in the runs table) so an erroring direction can't burn spend by being
    retriaged every tick.
    """

    enabled: bool = True


class CiHealthConfig(BaseModel):
    """Controls the post-merge main-branch CI-health monitor (D004).

    When ``enabled``, ``orchestrator.tick`` calls ``main_ci_health_tick``
    once per app per tick (cheap: 1-2 ``gh`` calls). It polls the app's
    ``main`` branch for a REQUIRED status check gone red post-merge and
    auto-files a ``ci-health`` direction so the failure is fixed through
    the normal dev -> review -> CI -> merge chain. This is the POST-merge
    safety net; the pre-merge required-check gate (branch protection,
    ``auto_merge._query_ci_state``) remains the primary defense and is
    unaffected by this flag.

    Advisory (non-required) reds never file a direction regardless of this
    setting — see ``factory.chain.ci_health.query_main_ci_status``.
    """

    enabled: bool = True


class DetectorWatchConfig(BaseModel):
    """Controls the detector -> direction trigger (019 AC7 / Flow D).

    When ``enabled``, ``orchestrator.tick`` calls
    ``factory.chain.detector_watch.detector_watch_tick`` once per app per
    real (non-dry-run) tick. It runs every registered detector in
    ``factory.manager.detectors.DETECTORS`` — the deleted FMS L1 Watcher used
    to be their only caller — and files at most a few machine directions per
    tick, deduped on a stable signature so the same fault is never re-filed
    while a direction for it is still open. Every filed direction is parked
    at the operator-approval gate (``source=detector-<name>`` is not in the
    deterministic-source allowlist) — this flag controls detection, not
    whether the resulting work auto-builds.

    Defaults to ``False`` (review round 2, 2026-08-07): AC7's own
    verification is the seeded unit test, not production traffic. A
    read-only re-measurement against the live factory found the pass would
    have filed 48 machine directions in its first ~16 ticks before the
    liveness/recency fixes landed — every default-on flag in this file
    controls a REAL write, and this one fans out across 11 detectors at
    once. Flip on per-app after a soak, not globally on merge.
    """

    enabled: bool = False


class AutoIntakeConfig(BaseModel):
    """Controls automatic intake of USER-FILED GitHub issues every tick.

    When ``enabled``, ``factory tick`` finds open issues carrying ``label``
    (default ``user-report``) that haven't been ingested yet (no
    ``accepted_label``), converts each into a direction via
    ``ingest_github_direction_issue``, and marks the issue accepted with a
    back-link comment. The next auto_pm_sync pass triages the new direction
    into stories, so a user filing an issue flows all the way to a PR with no
    operator step. ``max_per_tick`` bounds a flood; the ``label`` convention
    keeps the factory's OWN direction-tracker/story issues out of intake.
    """

    enabled: bool = True
    label: str = "user-report"
    accepted_label: str = "intake-accepted"
    max_per_tick: int = 3


class RecoveryConfig(BaseModel):
    """Controls the deterministic operational-recovery cycle.

    When ``enabled``, ``orchestrator.tick`` calls
    ``factory.manager.recovery.run_recovery_cycle`` once per app per real
    (non-dry-run) tick, alongside the ci-health/detector-watch/idle-ping
    hooks. PR #247 deleted ``factory/manager/apply.py`` — the module's ONLY
    production caller — orphaning all six of its playbooks, including
    ``recover-stuck-fixonly-mode`` and ``quarantine-invalid-enum-story``,
    each of which fixes a RECORDED live wedge in this repo's history (a
    stuck non-normal mode blocked all dispatch; invalid-enum rows failed
    every tick forever). ``CLAUDE.md`` documents ``recovery`` as a surviving
    deterministic safety mechanism, so this reconnects it rather than
    leaving it silently dead.

    Defaults to ``True``: every playbook here fixes a known wedge class, and
    the module is itself internally fail-safe — it forces dry-run while the
    factory is halted (``factory.manager.halt.is_halted``) and bounds itself
    with a per-cycle action cap and a per-target cooldown, so leaving it ON
    cannot runaway. The risk of OFF (silent rot resuming) is worse than the
    risk of ON. Flip off per-app only if a playbook proves counterproductive
    in the field — flippable exactly like every other hook in this file.
    """

    enabled: bool = True


class FactorySettings(BaseModel):
    caps: CapsConfig = Field(default_factory=CapsConfig)
    queues: QueuesConfig = Field(default_factory=QueuesConfig)
    rate_limits: RateLimitsConfig = Field(default_factory=RateLimitsConfig)
    modes: ModesConfig = Field(default_factory=ModesConfig)
    direction_defaults: DirectionDefaults = Field(default_factory=DirectionDefaults)
    auto_merge: AutoMergeConfig = Field(default_factory=AutoMergeConfig)
    auto_pm_sync: AutoPMSyncConfig = Field(default_factory=AutoPMSyncConfig)
    auto_intake: AutoIntakeConfig = Field(default_factory=AutoIntakeConfig)
    dev_convergence: DevConvergenceConfig = Field(default_factory=DevConvergenceConfig)
    ci_health: CiHealthConfig = Field(default_factory=CiHealthConfig)
    detector_watch: DetectorWatchConfig = Field(default_factory=DetectorWatchConfig)
    recovery: RecoveryConfig = Field(default_factory=RecoveryConfig)


_CACHED: dict[Path, FactorySettings] = {}


def load_settings(software_factory_root: Path) -> FactorySettings:
    """Read ``factory_settings.yaml`` at the root; missing file -> defaults.

    Parsed objects are memoized per-root for the life of the process; call
    ``reload_settings(...)`` after mutating the YAML in a test.
    """
    root = Path(software_factory_root).resolve()
    if root in _CACHED:
        return _CACHED[root]
    path = root / "factory_settings.yaml"
    settings: FactorySettings
    if not path.exists():
        settings = FactorySettings()
    else:
        raw: Any = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise ValueError(f"{path}: top-level must be a YAML mapping")
        settings = FactorySettings.model_validate(raw)
        if settings.modes.default not in settings.modes.available:
            raise ValueError(
                f"{path}: modes.default={settings.modes.default!r} is not in "
                f"modes.available={settings.modes.available!r}"
            )
    _CACHED[root] = settings
    return settings


def reload_settings(software_factory_root: Path) -> FactorySettings:
    """Bust the cache for ``software_factory_root`` and re-read the YAML."""
    root = Path(software_factory_root).resolve()
    _CACHED.pop(root, None)
    return load_settings(root)


def is_valid_mode(mode_name: str, settings: FactorySettings) -> bool:
    """True iff ``mode_name`` is in ``settings.modes.available``."""
    return mode_name in settings.modes.available
