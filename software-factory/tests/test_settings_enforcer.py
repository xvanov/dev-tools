"""Tests for ``factory.settings.enforcer.can_dispatch``.

Each cap should produce a distinct ``rejected_reason``. Order matters:
mode wins over caps, global cap over per-repo, daily over hourly,
hourly over PR-count, etc.
"""

from __future__ import annotations

from factory.settings.enforcer import can_dispatch
from factory.settings.loader import FactorySettings


def _state(**kw: object) -> dict[str, object]:
    base: dict[str, object] = {
        "mode": "normal",
        "global_in_flight": 0,
        "app_in_flight": 0,
        "today_spend_usd": 0.0,
        "hour_spend_usd": 0.0,
        "open_prs_for_app": None,
        "failing_ci_count": None,
        "pm_invocations_last_hour": 0,
    }
    base.update(kw)
    return base


def test_normal_mode_allows_dispatch() -> None:
    d = can_dispatch("dev", "sacrifice", _state(), FactorySettings())
    assert d.allowed
    assert d.rejected_reason is None


def test_paused_mode_blocks_everything() -> None:
    s = FactorySettings()
    for kind in ("sm", "test_design", "dev", "review", "tech_writer", "deploy"):
        d = can_dispatch(kind, "sacrifice", _state(mode="paused"), s)
        assert not d.allowed
        assert d.rejected_reason and "paused" in d.rejected_reason


def test_fix_only_blocks_non_bug_dev_but_allows_dev_bug() -> None:
    s = FactorySettings()
    d_block = can_dispatch("dev", "sacrifice", _state(mode="fix-only"), s)
    assert not d_block.allowed
    d_allow = can_dispatch("dev-bug", "sacrifice", _state(mode="fix-only"), s)
    assert d_allow.allowed


def test_drain_reviews_blocks_new_dev() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(mode="drain-reviews"), s)
    assert not d.allowed
    # Review work is still allowed under drain-reviews.
    d_rev = can_dispatch("review", "sacrifice", _state(mode="drain-reviews"), s)
    assert d_rev.allowed


def test_deploy_frozen_blocks_deploy_only() -> None:
    s = FactorySettings()
    d = can_dispatch("deploy", "sacrifice", _state(mode="deploy-frozen"), s)
    assert not d.allowed
    d_dev = can_dispatch("dev", "sacrifice", _state(mode="deploy-frozen"), s)
    assert d_dev.allowed


def test_global_concurrent_cap() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(global_in_flight=2), s)
    assert not d.allowed
    assert d.rejected_reason == "global_concurrent_agents_cap_exceeded"


def test_per_repo_concurrent_cap() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(app_in_flight=2), s)
    assert not d.allowed
    assert d.rejected_reason == "per_repo_concurrent_agents_cap_exceeded"


def test_daily_spend_cap() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(today_spend_usd=10.0), s)
    assert not d.allowed
    assert d.rejected_reason == "daily_spend_cap_exceeded"


def test_hourly_spend_cap() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(hour_spend_usd=2.0), s)
    assert not d.allowed
    assert d.rejected_reason == "hourly_spend_cap_exceeded"


def test_human_review_max_open_prs() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(open_prs_for_app=5), s)
    assert not d.allowed
    assert d.rejected_reason == "human_review_max_open_prs_exceeded"
    # Review jobs are exempt so we can drain.
    d_rev = can_dispatch("review", "sacrifice", _state(open_prs_for_app=5), s)
    assert d_rev.allowed


def test_failing_ci_pause_threshold() -> None:
    s = FactorySettings()
    d = can_dispatch("dev", "sacrifice", _state(failing_ci_count=3), s)
    assert not d.allowed
    assert d.rejected_reason == "failing_ci_pause_threshold_exceeded"


def test_pm_rate_limit() -> None:
    s = FactorySettings()
    d = can_dispatch("pm", "sacrifice", _state(pm_invocations_last_hour=4), s)
    assert not d.allowed
    assert d.rejected_reason == "pm_invocations_per_hour_exceeded"
    # Dev work isn't bound by the PM rate limit.
    d_dev = can_dispatch("dev", "sacrifice", _state(pm_invocations_last_hour=99), s)
    assert d_dev.allowed


def test_order_mode_before_caps() -> None:
    """When the mode says paused, no cap reason should be returned."""
    s = FactorySettings()
    d = can_dispatch(
        "dev",
        "sacrifice",
        _state(mode="paused", today_spend_usd=999.0, global_in_flight=99),
        s,
    )
    assert not d.allowed
    assert d.rejected_reason and "paused" in d.rejected_reason


def test_unknown_keys_are_ignored() -> None:
    """Future-proofing: extra state keys do not break the enforcer."""
    s = FactorySettings()
    state = _state()
    state["extra"] = "ignored"
    d = can_dispatch("dev", "sacrifice", state, s)
    assert d.allowed


# -------------------- Phase 6 per-persona daily rate limits -------------------- #


def test_security_daily_rate_limit_trips() -> None:
    s = FactorySettings()
    d = can_dispatch("security", "sacrifice", _state(security_runs_today=1), s)
    assert not d.allowed
    assert d.rejected_reason == "security_rate_limit_exceeded"


def test_ux_auditor_daily_rate_limit_trips() -> None:
    s = FactorySettings()
    d = can_dispatch("ux_auditor", "sacrifice", _state(ux_auditor_runs_today=2), s)
    assert not d.allowed
    assert d.rejected_reason == "ux_auditor_rate_limit_exceeded"


def test_phase6_personas_unbound_by_pm_rate_limit() -> None:
    """The pm_invocations_per_hour cap is PM-only; scheduled personas ignore it."""
    s = FactorySettings()
    for persona in ("security", "ux_auditor"):
        d = can_dispatch(persona, "sacrifice", _state(pm_invocations_last_hour=99), s)
        assert d.allowed, persona
