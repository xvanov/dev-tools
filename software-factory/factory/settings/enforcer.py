"""Dispatch enforcer: ``can_dispatch(job_kind, app, current_state, settings)``.

Consulted before every conversation spawn. Returns a ``DispatchDecision``
carrying ``allowed`` and a structured ``rejected_reason``. Checks in order:

  1. mode (paused / fix-only / drain-reviews / deploy-frozen / ux-audit-only)
  2. global concurrent agents cap
  3. per-repo concurrent agents cap
  4. daily spend cap
  5. hourly spend cap
  6. human-review max open PRs (skipped without a github_client)
  7. failing CI pause threshold (read from a simple counter in current_state)
  8. per-persona rate limits (PM invocations per hour)

State the enforcer needs (counts, mode) is read from ``current_state``
(a dict the orchestrator builds). The enforcer is **pure** given its
inputs; the orchestrator is responsible for assembling the dict.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from factory.settings.loader import FactorySettings


@dataclass
class DispatchDecision:
    allowed: bool
    rejected_reason: str | None = None
    retry_after_seconds: int | None = None


# Mode -> set of job_kinds that are blocked entirely.
_MODE_BLOCKS: dict[str, set[str] | str] = {
    "paused": "ALL",
    "fix-only": {
        "sm",
        "dev",
        "review",
        "tech_writer",
        "docs_enforcer",
        # ^ Only "bug"-typed work continues. Bug stories opt-in via the
        # job_kind="dev-bug" tag — anything not flagged as a bug fix is
        # rejected. The orchestrator chooses which tag to pass.
    },
    "drain-reviews": {"sm", "dev", "tech_writer", "docs_enforcer"},
    "deploy-frozen": {"deploy", "release"},
    "ux-audit-only": {"sm", "dev", "review", "tech_writer"},
    # exploratory and normal place no extra mode-based restrictions.
}

# Persona-specific job_kinds that ARE bug-fix variants (allowed under fix-only).
_BUG_FIX_JOB_KINDS = {"dev-bug", "review-bug", "test_design-bug", "test_impl-bug"}


def _mode_blocks(mode: str, job_kind: str) -> bool:
    block = _MODE_BLOCKS.get(mode)
    if block is None:
        return False
    if block == "ALL":
        return True
    assert isinstance(block, set)
    if mode == "fix-only" and job_kind in _BUG_FIX_JOB_KINDS:
        return False
    return job_kind in block


def can_dispatch(
    job_kind: str,
    app: str,
    current_state: dict[str, Any],
    settings: FactorySettings,
) -> DispatchDecision:
    """Return whether the chain may dispatch a ``job_kind`` for ``app``.

    ``current_state`` keys read:

      * ``mode`` (str) - the factory mode, REQUIRED.
      * ``global_in_flight`` (int) - count of in-flight stories across all apps.
      * ``app_in_flight`` (int) - count of in-flight stories for ``app``.
      * ``today_spend_usd`` (float) - sum of today's run costs.
      * ``hour_spend_usd`` (float) - sum of the last hour's run costs.
      * ``open_prs_for_app`` (int | None) - GH PR count; None means "unknown",
        which we treat as allowed (the GH client is absent / dry-run).
      * ``failing_ci_count`` (int | None) - red CI counts; None means unknown.
      * ``pm_invocations_last_hour`` (int) - for rate-limit check.

    Order is important: we return the FIRST rejection so the operator
    sees the most-restrictive reason.
    """
    mode = current_state.get("mode") or "normal"
    if _mode_blocks(mode, job_kind):
        return DispatchDecision(
            allowed=False,
            rejected_reason=f"mode_{mode.replace('-', '_')}_blocks_{job_kind}",
        )

    global_in_flight = int(current_state.get("global_in_flight") or 0)
    if global_in_flight >= settings.caps.global_concurrent_agents:
        return DispatchDecision(
            allowed=False,
            rejected_reason="global_concurrent_agents_cap_exceeded",
            retry_after_seconds=60,
        )

    app_in_flight = int(current_state.get("app_in_flight") or 0)
    if app_in_flight >= settings.caps.per_repo_concurrent_agents:
        return DispatchDecision(
            allowed=False,
            rejected_reason="per_repo_concurrent_agents_cap_exceeded",
            retry_after_seconds=60,
        )

    today_spend = float(current_state.get("today_spend_usd") or 0.0)
    if today_spend >= settings.caps.daily_spend_usd:
        return DispatchDecision(
            allowed=False,
            rejected_reason="daily_spend_cap_exceeded",
            retry_after_seconds=3600,
        )

    hour_spend = float(current_state.get("hour_spend_usd") or 0.0)
    if hour_spend >= settings.caps.hourly_spend_usd:
        return DispatchDecision(
            allowed=False,
            rejected_reason="hourly_spend_cap_exceeded",
            retry_after_seconds=300,
        )

    open_prs = current_state.get("open_prs_for_app")
    if (
        open_prs is not None
        and int(open_prs) >= settings.queues.human_review_max_open_prs
        and job_kind not in {"review", "docs_enforcer"}
    ):
        return DispatchDecision(
            allowed=False,
            rejected_reason="human_review_max_open_prs_exceeded",
            retry_after_seconds=600,
        )

    failing_ci = current_state.get("failing_ci_count")
    if (
        failing_ci is not None
        and int(failing_ci) >= settings.queues.failing_ci_pause_threshold
        and job_kind in {"sm", "dev"}
    ):
        return DispatchDecision(
            allowed=False,
            rejected_reason="failing_ci_pause_threshold_exceeded",
            retry_after_seconds=900,
        )

    if job_kind == "pm":
        pm_last_hour = int(current_state.get("pm_invocations_last_hour") or 0)
        if pm_last_hour >= settings.rate_limits.pm_invocations_per_hour:
            return DispatchDecision(
                allowed=False,
                rejected_reason="pm_invocations_per_hour_exceeded",
                retry_after_seconds=600,
            )

    # Per-persona daily-run caps (Phase 6 autonomous-work generators).
    # Each tick path consults this BEFORE invoking the persona; the
    # caller supplies ``<persona>_runs_today`` based on a DB count.
    _DAILY_CAPS: dict[str, tuple[int, str]] = {
        "security": (
            settings.rate_limits.security_runs_per_day,
            "security_rate_limit_exceeded",
        ),
        "ux_auditor": (
            settings.rate_limits.ux_auditor_runs_per_day,
            "ux_auditor_rate_limit_exceeded",
        ),
    }
    if job_kind in _DAILY_CAPS:
        cap, reason = _DAILY_CAPS[job_kind]
        runs_today = int(current_state.get(f"{job_kind}_runs_today") or 0)
        if runs_today >= cap:
            return DispatchDecision(
                allowed=False,
                rejected_reason=reason,
                retry_after_seconds=3600,
            )

    return DispatchDecision(allowed=True)
