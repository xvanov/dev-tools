"""JOBS-API v1.9: review on both runtimes, review off|on|auto, job caps,
provider limits (parse, breaker, auto-resume at reset, failover).

Nothing here runs ``claude`` or a model: conversations go through the fake
launcher of ``test_claude_session.py`` and the ledger is seeded directly.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from factory import job_caps, job_policy
from factory import provider_limits as PL
from factory.chain import orchestrator as O
from factory.chain import solo
from factory.chain.state_machine import StoryRecord, StoryState

NOW = datetime(2026, 11, 9, 10, 0, tzinfo=UTC)


# --------------------------------------------------------------------------- #
# Provider limits: parsing
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "text",
    [
        "Claude Code error: You've hit your limit · resets 3pm (UTC)",
        "5-hour limit reached ∙ resets 3pm (UTC)",
        "Claude usage limit reached. Your limit will reset at 3pm (UTC).",
        "You've hit your limit · resets 3:00pm (UTC)",
    ],
)
def test_claude_limit_messages_parse_the_reset(text: str) -> None:
    hit = PL.parse_limit("claude_session", text, now=NOW)
    assert hit is not None and hit.runtime == "claude_session"
    assert hit.until == datetime(2026, 11, 9, 15, 0, tzinfo=UTC)
    assert hit.reason == "Claude usage limit"


def test_claude_limit_reset_already_past_today_is_tomorrow() -> None:
    hit = PL.parse_limit("claude_session", "You've hit your limit · resets 9am (UTC)", now=NOW)
    assert hit is not None and hit.until == datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


def test_claude_weekly_limit_with_a_date() -> None:
    hit = PL.parse_limit(
        "claude_session", "You've hit your weekly limit · resets Nov 12, 9am (UTC)", now=NOW
    )
    assert hit is not None and hit.until == datetime(2026, 11, 12, 9, 0, tzinfo=UTC)


def test_claude_legacy_epoch_message() -> None:
    hit = PL.parse_limit("claude_session", "Claude AI usage limit reached|1762707600", now=NOW)
    assert hit is not None and hit.until == datetime.fromtimestamp(1762707600, tz=UTC)


def test_claude_limit_without_a_zone_is_local_time() -> None:
    hit = PL.parse_limit("claude_session", "5-hour limit reached ∙ resets 11pm", now=NOW)
    assert hit is not None and hit.until is not None
    local = hit.until.astimezone(NOW.astimezone().tzinfo)
    assert (local.hour, local.minute) == (23, 0) and hit.until > NOW


def test_claude_limit_without_a_reset_time_is_still_a_limit() -> None:
    hit = PL.parse_limit("claude_session", "Claude Code error: usage limit reached", now=NOW)
    assert hit is not None and hit.until is None


def test_only_the_providers_own_error_counts_as_a_limit() -> None:
    """A red suite about rate limiting, or a gate reason, never pauses a job."""
    red = SimpleNamespace(error="FAILED tests/test_rate_limit.py::test_429_retry", provider_error=None)
    assert PL.provider_error_text("api", red) is None
    assert PL.provider_error_text("claude_session", red) is None
    api = SimpleNamespace(error="litellm.RateLimitError: AzureException 429", provider_error=None)
    assert PL.provider_error_text("api", api) == api.error
    # Claude's limit survives a grade that replaced ``error`` with the gate's reason.
    graded = SimpleNamespace(
        error="the test command is not green on your working tree",
        provider_error="Claude Code error: You've hit your limit · resets 3pm (UTC)",
    )
    assert PL.provider_error_text("claude_session", graded) == graded.provider_error


def test_an_ordinary_error_is_not_a_limit() -> None:
    assert PL.parse_limit("claude_session", "Claude Code error: tool crashed", now=NOW) is None
    assert PL.parse_limit("api", "ValueError: bad json", now=NOW) is None


@pytest.mark.parametrize(
    ("headers", "wait_s"),
    [
        ({"Retry-After": "120"}, 120),
        ({"retry-after-ms": "1500"}, 1.5),
        ({"Retry-After": "Mon, 09 Nov 2026 10:05:00 GMT"}, 300),
        ({"x-ratelimit-reset-tokens": "1m30s", "x-ratelimit-reset-requests": "6ms"}, 90),
        ({"anthropic-ratelimit-tokens-reset": "2026-11-09T10:00:40Z"}, 40),
    ],
)
def test_api_429_headers(headers: dict[str, str], wait_s: float) -> None:
    hit = PL.parse_limit("api", "litellm.RateLimitError: 429 Too Many Requests", headers=headers, now=NOW)
    assert hit is not None and hit.until == NOW + timedelta(seconds=wait_s)


def test_api_429_retry_hint_in_the_message() -> None:
    hit = PL.parse_limit(
        "api",
        "AzureException RateLimitError - exceeded rate limit. Please try again in 20s.",
        now=NOW,
    )
    assert hit is not None and hit.until == NOW + timedelta(seconds=20)


def test_api_429_without_any_hint_backs_off() -> None:
    hit = PL.parse_limit("api", "LLMRateLimitError: rate limit", now=NOW)
    assert hit is not None and hit.until is None


# --------------------------------------------------------------------------- #
# Provider limits: breaker
# --------------------------------------------------------------------------- #


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    r = tmp_path / "factory"
    (r / "state").mkdir(parents=True)
    from factory import state_dir as sd

    monkeypatch.setattr(sd, "state_dir", lambda _root: Path(_root) / "state")
    monkeypatch.setattr(PL, "_path", lambda _root: Path(_root) / "state" / "runtime_limits.json")
    monkeypatch.delenv("FACTORY_RUNTIME_FAILOVER", raising=False)
    monkeypatch.delenv("FACTORY_FAILOVER_MIN_WAIT_MIN", raising=False)
    return r


def test_breaker_opens_until_the_reset_and_closes_after(root: Path) -> None:
    hit = PL.LimitHit("claude_session", NOW + timedelta(hours=2), "Claude usage limit", "x")
    PL.trip(root, hit, now=NOW)
    entry = PL.open_entry(root, "claude_session", now=NOW + timedelta(hours=1))
    assert entry is not None and entry["reset_known"] is True
    assert PL.open_entry(root, "api", now=NOW) is None
    # Auto-resume: past the reset the breaker is closed; nothing has to clear it.
    assert PL.open_entry(root, "claude_session", now=NOW + timedelta(hours=2, seconds=1)) is None


def test_breaker_backoff_doubles_and_is_capped(root: Path) -> None:
    hit = PL.LimitHit("api", None, "API rate limit (429)", "x")
    e1 = PL.trip(root, hit, now=NOW)
    assert e1["trips"] == 1 and PL._parse_iso(e1["until"]) == NOW + timedelta(seconds=60)
    e2 = PL.trip(root, hit, now=NOW + timedelta(seconds=61))
    assert e2["trips"] == 2
    assert PL._parse_iso(e2["until"]) == NOW + timedelta(seconds=61 + 120)
    assert PL.backoff_s("api", 30) == 30 * 60
    assert PL.backoff_s("claude_session", 1) == 15 * 60


def test_breaker_does_not_escalate_while_still_open(root: Path) -> None:
    """Parallel workers hitting one wall must not compound the backoff."""
    hit = PL.LimitHit("api", None, "API rate limit (429)", "x")
    for _ in range(4):
        e = PL.trip(root, hit, now=NOW)
    assert e["trips"] == 1
    assert PL._parse_iso(e["until"]) == NOW + timedelta(seconds=60)


def test_breaker_keeps_a_later_reset(root: Path) -> None:
    PL.trip(root, PL.LimitHit("claude_session", NOW + timedelta(days=2), "weekly", "x"), now=NOW)
    e = PL.trip(root, PL.LimitHit("claude_session", NOW + timedelta(hours=1), "5h", "x"), now=NOW)
    assert PL._parse_iso(e["until"]) == NOW + timedelta(days=2)


def test_describe_says_when_it_resumes() -> None:
    until = datetime(2026, 11, 9, 15, 0, tzinfo=UTC)
    text = PL.describe("claude_session", until, now=until - timedelta(minutes=5))
    assert text == f"paused: Claude limit, resumes {until.astimezone().strftime('%H:%M')}"


def test_note_run_error_trips_only_on_a_limit(root: Path) -> None:
    assert PL.note_run_error(root, "claude_session", "boom") is None
    assert PL.load(root) == {}
    hit = PL.note_run_error(root, "claude_session", "You've hit your limit · resets 3pm (UTC)")
    assert hit is not None and PL.load(root)["claude_session"]["reset_known"] is True


# --------------------------------------------------------------------------- #
# Failover policy
# --------------------------------------------------------------------------- #


def _entry(minutes: float) -> dict[str, Any]:
    return {"until": (NOW + timedelta(minutes=minutes)).isoformat(), "reason": "Claude usage limit"}


def test_failover_is_off_by_default(root: Path) -> None:
    go, target, why = PL.decide_failover(root, "claude_session", _entry(300), None, now=NOW)
    assert (go, target, why) == (False, "api", "failover is off")


def test_failover_per_job_and_threshold(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    yes = lambda rt: True  # noqa: E731
    go, target, why = PL.decide_failover(
        root, "claude_session", _entry(300), "on", now=NOW, available=yes
    )
    assert go and target == "api" and why.startswith("failed over from claude_session to api")
    go, _, why = PL.decide_failover(root, "claude_session", _entry(10), "on", now=NOW, available=yes)
    assert not go and "threshold" in why
    monkeypatch.setenv("FACTORY_RUNTIME_FAILOVER", "on")
    assert PL.decide_failover(root, "claude_session", _entry(300), None, now=NOW, available=yes)[0]
    assert not PL.decide_failover(root, "claude_session", _entry(300), "off", now=NOW, available=yes)[0]
    monkeypatch.setenv("FACTORY_FAILOVER_MIN_WAIT_MIN", "600")
    assert not PL.decide_failover(root, "claude_session", _entry(300), "on", now=NOW, available=yes)[0]


def test_no_failover_onto_a_limited_or_missing_runtime(root: Path) -> None:
    PL.trip(root, PL.LimitHit("api", NOW + timedelta(hours=1), "429", "x"), now=NOW)
    go, _, why = PL.decide_failover(
        root, "claude_session", _entry(300), "on", now=NOW, available=lambda rt: True
    )
    assert not go and "limited too" in why
    go, _, why = PL.decide_failover(
        root, "api", _entry(300), "on", now=NOW + timedelta(hours=2), available=lambda rt: False
    )
    assert not go and "not available" in why


# --------------------------------------------------------------------------- #
# Review setting: resolution and the auto decision
# --------------------------------------------------------------------------- #


def _cfg(**kw: Any) -> Any:
    from factory.app_config import AppConfig

    return AppConfig.model_validate({"name": "demo", "repo": "o/demo", **kw})


def test_policy_resolution_job_over_app_over_default() -> None:
    p = job_policy.resolve_policy(_cfg(), {})
    assert p["review"] == {"mode": "auto", "source": "default", "min_diff_lines": 0}
    assert p["caps"]["budget_usd"] == 30.0 and p["caps"]["wall_clock_h"] == 4.0
    assert p["caps"]["max_rounds"] == 20 and p["failover"] is None
    cfg = _cfg(review={"default": "on", "auto_min_diff_lines": 200}, caps={"budget_usd": 10})
    p = job_policy.resolve_policy(cfg, {})
    assert p["review"]["mode"] == "on" and p["review"]["source"] == "app"
    assert p["caps"]["budget_usd"] == 10.0 and p["caps"]["source"]["budget_usd"] == "app"
    assert p["caps"]["source"]["wall_clock_h"] == "default"
    p = job_policy.resolve_policy(
        cfg, {"review": "off", "caps": {"wall_clock_h": "90m"}, "failover": "on"}
    )
    assert p["review"]["mode"] == "off" and p["review"]["source"] == "job"
    assert p["caps"]["wall_clock_h"] == 1.5 and p["caps"]["budget_usd"] == 10.0
    assert p["failover"] == "on"


def test_parse_caps_aliases_and_refusals() -> None:
    assert job_policy.parse_caps(["budget=$50", "wall=6h", "rounds=8"]) == {
        "budget_usd": 50.0, "wall_clock_h": 6.0, "max_rounds": 8.0,
    }
    for bad in (["budget_usd=-1"], ["nope=1"], ["max_rounds=1.5"], ["budget_usd"]):
        with pytest.raises(ValueError):
            job_policy.parse_caps(bad)
    with pytest.raises(ValueError):
        job_policy.parse_review("sometimes")


def _solo_story(**kw: Any) -> StoryRecord:
    fields: dict[str, Any] = {
        "direction_id": "001", "app": "demo", "title": "t", "slug": "s", "scope": "backend",
        "state": StoryState.TESTS_GREEN.value, "pipeline": "solo",
    }
    fields.update(kw)
    return StoryRecord(**fields)


def _stamped(mode: str, level: str, runtime: str = "claude_session", lines: int = 0) -> StoryRecord:
    pol = job_policy.resolve_policy(
        _cfg(review={"default": mode, "auto_min_diff_lines": lines}), {}
    )
    return _solo_story(runtime=runtime, delivery_level=level, policy_json=json.dumps(pol))


@pytest.mark.parametrize(
    ("mode", "level", "want"),
    [
        ("auto", "auto_merge", True),
        ("auto", "push_to_main", True),
        ("auto", "draft_pr", False),
        ("auto", "pr", False),
        ("on", "draft_pr", True),
        ("off", "auto_merge", False),
    ],
)
def test_review_auto_decision(mode: str, level: str, want: bool) -> None:
    for runtime in ("api", "claude_session"):
        story = _stamped(mode, level, runtime)
        assert solo.solo_reviews(story) is want
        assert O._dispatch_for_story(story) == ("review" if want else "tech_writer")


def test_review_auto_turns_on_for_a_big_diff_and_records_it_once() -> None:
    story = _stamped("auto", "draft_pr", lines=100)
    dec = job_policy.decide_review(story, 250)
    assert dec["review"] is True and "250 lines" in dec["reason"]
    assert solo.solo_reviews(story) is True
    # Decided once: a later green does not re-decide.
    assert job_policy.decide_review(story, 3)["review"] is True
    small = _stamped("auto", "draft_pr", lines=100)
    assert job_policy.decide_review(small, 99)["review"] is False


def test_legacy_stories_keep_the_old_review_rule() -> None:
    assert solo.solo_reviews(_solo_story(runtime="api")) is True
    assert solo.solo_reviews(_solo_story(runtime="claude_session")) is False


def test_review_runs_on_the_story_runtime_for_solo_only() -> None:
    assert solo.review_runtime(_solo_story(runtime="claude_session")) == "claude_session"
    assert solo.review_runtime(_solo_story(runtime="api")) == "api"
    chain = _solo_story(runtime="claude_session", pipeline="chain")
    assert solo.review_runtime(chain) == "api"
    assert O.step_runtime(chain, "dev") == "claude_session"
    # The job's runtime applies to every model step; only the chain reviewer
    # (model independence) and the sandbox onboarder stay on api.
    for h in ("sm", "docs_sm", "tech_writer"):
        assert O.step_runtime(chain, h) == "claude_session"
        assert O.step_runtime(_solo_story(runtime="api"), h) == "api"
    assert O.step_runtime(chain, "docs_onboarder") == "api"
    assert O.step_runtime(chain, "docs_enforcer") is None


# --------------------------------------------------------------------------- #
# Review on claude_session: read-only run, fix round resumes the dev session
# --------------------------------------------------------------------------- #


def test_claude_review_run_is_read_only_and_returns_the_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.claude_session.run as run_mod
    from factory.claude_session.conversation import ConversationResult
    from factory.claude_session.stream import ClaudeResult

    seen: dict[str, Any] = {}

    def fake_run_claude(**kw: Any) -> Any:
        seen.update(kw)
        conv = ConversationResult(
            rounds=[ClaudeResult(found=True, result_text='{"verdict": "approve"}')],
            stop_reason="done",
        )
        return run_mod.ClaudeRunOutcome(conv, 1, None)

    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    monkeypatch.setattr(run_mod, "state_dir", lambda r: tmp_path)
    text, conv = run_mod.claude_review_run(
        prompt="REVIEWER PROMPT", worktree=tmp_path, software_factory_root=tmp_path,
        db_path=tmp_path / "db", model=None, story_id=7, app="demo", direction_id="001",
    )
    assert seen["permission_mode"] == "plan" and seen["persona"] == "reviewer"
    assert seen["prompt"].startswith("REVIEWER PROMPT") and "READ-ONLY" in seen["prompt"]
    assert json.loads(text) == {"verdict": "approve"}


def test_text_steps_run_on_claude_for_a_claude_session_story(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.chain.handlers as H
    import factory.claude_session.run as run_mod
    import factory.runner as runner
    from factory.claude_session.conversation import ConversationResult
    from factory.claude_session.stream import ClaudeResult

    def fake_run_claude(**kw: Any) -> Any:
        conv = ConversationResult(
            rounds=[ClaudeResult(found=True, result_text='{"stories": []}')], stop_reason="done"
        )
        seen.append(kw["persona"])
        return run_mod.ClaudeRunOutcome(conv, 1, None)

    def api_called(**kw: Any) -> Any:
        raise AssertionError("api text_run used for a claude_session story")

    seen: list[str] = []
    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    monkeypatch.setattr(run_mod, "state_dir", lambda r: tmp_path)
    monkeypatch.setattr(runner, "text_run", api_called)
    monkeypatch.setattr("factory.app_config.resolve_app_repo_path", lambda a, r: tmp_path)
    story = _solo_story(runtime="claude_session")
    out = H._story_text_run(
        story, object(), tmp_path, persona="sm", prompt="P", model_id="m",
        schema={"type": "object"}, max_tokens=10, db=tmp_path / "db",
    )
    assert out == {"stories": []} and seen == ["sm"]


def test_fix_round_resumes_the_dev_session(tmp_path: Path) -> None:
    from tests.test_claude_session import FakeLauncher, _conv

    out = _conv(tmp_path, FakeLauncher(), resume_session="sess-prev")
    script = "\n".join(
        p.read_text(encoding="utf-8") for p in (tmp_path / "run").iterdir() if p.is_file()
    )
    assert "--resume" in script and "sess-prev" in script and "--session-id" not in script
    assert out.stop_reason == "done"


def test_fix_round_message_carries_the_findings() -> None:
    from factory.claude_session.run import fix_round_message

    msg = fix_round_message(
        {"findings": [{"severity": "high", "location": "a.py:3", "what": "git runs with no cwd"}]}
    )
    assert "git runs with no cwd" in msg and "ONE fix round" in msg


def test_conversation_stops_between_rounds_at_the_job_budget(tmp_path: Path) -> None:
    from factory.runner import GateVerdict
    from tests.test_claude_session import FakeLauncher, _conv

    out = _conv(
        tmp_path,
        FakeLauncher([{"write": "a.txt", "cost": 2.0}, {"write": "b.txt"}]),
        gate_check=lambda: GateVerdict(passed=False, reason="red", output=""),
        max_gate_rounds=3,
        budget_left_usd=lambda: 1.0,
    )
    assert out.stop_reason == "job_cap" and len(out.rounds) == 1


# --------------------------------------------------------------------------- #
# Job caps
# --------------------------------------------------------------------------- #


def _ledger(db: Path, rows: list[dict[str, Any]]) -> None:
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, persona TEXT, app TEXT, "
        "direction_id TEXT, story_id INTEGER, cost_usd REAL, subscription_equiv_usd REAL, "
        "started_at TEXT, ts TEXT)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY, app TEXT, direction_id TEXT)"
    )
    for r in rows:
        con.execute(
            "INSERT INTO runs (persona, app, direction_id, story_id, cost_usd, "
            "subscription_equiv_usd, started_at, ts) VALUES (?,?,?,?,?,?,?,?)",
            (r.get("persona", "dev"), "demo", "001", None, r.get("cost", 0.0), r.get("equiv", 0.0),
             r["at"].isoformat(), r["at"].isoformat()),
        )
    con.commit()
    con.close()


def test_job_usage_counts_both_runtimes_rounds_and_wall(tmp_path: Path) -> None:
    db = tmp_path / "f.db"
    _ledger(db, [
        {"persona": "dev", "cost": 4.0, "at": NOW},
        {"persona": "reviewer", "equiv": 6.5, "at": NOW + timedelta(minutes=30)},
        {"persona": "tech_writer", "cost": 0.5, "at": NOW + timedelta(minutes=40)},
    ])
    u = job_caps.job_usage(db, "demo", "001", now=NOW + timedelta(hours=1))
    assert u == {"spend_usd": 11.0, "rounds": 2, "wall_s": 3600.0, "since": None}
    later = job_caps.job_usage(
        db, "demo", "001", since=(NOW + timedelta(minutes=10)).isoformat(),
        now=NOW + timedelta(hours=1),
    )
    assert later is not None and later["spend_usd"] == 7.0 and later["rounds"] == 1


def test_breach_and_remaining() -> None:
    caps = {"budget_usd": 30.0, "wall_clock_h": 4.0, "max_rounds": 20}
    ok = {"spend_usd": 10.0, "rounds": 3, "wall_s": 3600.0}
    assert job_caps.breach(caps, ok) is None
    assert job_caps.remaining(caps, ok) == {"budget_usd": 20.0, "wall_s": 3 * 3600.0}
    assert "budget" in str(job_caps.breach(caps, {**ok, "spend_usd": 30.01}))
    assert "wall clock" in str(job_caps.breach(caps, {**ok, "wall_s": 4 * 3600.0}))
    assert "rounds" in str(job_caps.breach(caps, {**ok, "rounds": 20}))
    assert job_caps.breach({"budget_usd": 0, "wall_clock_h": 0, "max_rounds": 0},
                           {"spend_usd": 1e6, "rounds": 999, "wall_s": 1e9}) is None


def _orch_story(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kw: Any) -> tuple[StoryRecord, Path]:
    from factory.chain import handlers as H

    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    story = _solo_story(**{"state": StoryState.DEV_RETRY.value, **kw})
    story.id = 7
    persisted: list[str] = []
    monkeypatch.setattr(H, "persist_story", lambda s, d: persisted.append(s.state))
    events: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(O, "log_story_event", lambda sid, ev, payload, **k: events.append((ev, payload)))
    story._events = events  # type: ignore[attr-defined]
    return story, db


def test_a_job_at_its_cap_is_parked_for_a_human_with_work_saved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pol = job_policy.resolve_policy(_cfg(caps={"budget_usd": 5}), {})
    story, db = _orch_story(tmp_path, monkeypatch, policy_json=json.dumps(pol))
    monkeypatch.setattr(
        job_caps, "usage_for_story",
        lambda root, db, s: {"spend_usd": 6.0, "rounds": 2, "wall_s": 60.0, "since": None},
    )
    saved: list[int] = []
    monkeypatch.setattr(job_caps, "preserve_work", lambda s, cfg, root: saved.append(s.id) or {"committed": True})
    assert O._park_at_job_cap(story, "dev", app_config=_cfg(), db=db, root=tmp_path)
    assert story.state == StoryState.BLOCKED_BUDGET_EXCEEDED.value
    assert story.last_rejection_reason.startswith("job_cap: spend $6.00")
    assert saved == [7]
    assert story._events[-1][0] == "job_cap_exceeded"  # type: ignore[attr-defined]
    # needs_human, never failed:
    from factory.jobs.status import HUMAN_STATES

    assert StoryState.BLOCKED_BUDGET_EXCEEDED.value in HUMAN_STATES


def test_an_uncapped_or_legacy_story_is_not_parked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    story, db = _orch_story(tmp_path, monkeypatch)  # no policy_json
    assert not O._park_at_job_cap(story, "dev", app_config=_cfg(), db=db, root=tmp_path)
    assert story.state == StoryState.DEV_RETRY.value


def test_preserve_work_commits_and_pushes_only_the_factory_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    from factory.chain import worktree as wt_mod

    wt = tmp_path / "wt"
    wt.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=wt, check=True)
    subprocess.run(["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q",
                    "--allow-empty", "-m", "base"], cwd=wt, check=True)
    (wt / "work.py").write_text("x = 1\n", encoding="utf-8")
    monkeypatch.setattr(wt_mod, "worktree_path", lambda *a, **k: wt)
    monkeypatch.setenv("GIT_AUTHOR_NAME", "f")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "f@x")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "f")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "f@x")
    pushes: list[tuple[str, ...]] = []
    story = _solo_story(delivery_level="draft_pr", github_issue_number=3, slug="s")
    story.id = 7
    out = job_caps.preserve_work(story, _cfg(), tmp_path, push=lambda cwd, *a: pushes.append(a) or (0, ""))
    assert out["committed"] and out["pushed"]
    assert pushes and pushes[0][:2] == ("push", "origin")
    log = subprocess.run(["git", "log", "-1", "--format=%s"], cwd=wt, capture_output=True, text=True)
    assert "paused at a job cap" in log.stdout
    # A picked-up (human's) branch is never pushed; a `none` job never pushes.
    pushes.clear()
    picked = _solo_story(delivery_level="pr", pickup_branch="feat/x")
    picked.id = 8
    assert not job_caps.preserve_work(picked, _cfg(), tmp_path, push=lambda *a: pushes.append(a) or (0, ""))["pushed"]
    local = _solo_story(delivery_level="none")
    local.id = 9
    assert not job_caps.preserve_work(local, _cfg(), tmp_path, push=lambda *a: pushes.append(a) or (0, ""))["pushed"]
    assert pushes == []


def test_resume_opens_a_new_cap_window(tmp_path: Path) -> None:
    d = tmp_path / "001-x"
    d.mkdir()
    (d / "state.yaml").write_text("audit: []\n", encoding="utf-8")
    at = job_caps.open_window(d, NOW.isoformat())
    assert job_caps.window_start(d) == at == NOW.isoformat()


# --------------------------------------------------------------------------- #
# Orchestrator: paused at a limit, resumed at the reset, failover
# --------------------------------------------------------------------------- #


def test_a_limited_runtime_defers_the_step_until_the_reset(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    story, db = _orch_story(root, monkeypatch, runtime="claude_session")
    PL.trip(root, PL.LimitHit("claude_session", datetime.now(UTC) + timedelta(hours=2), "Claude usage limit", "x"))
    why = O._provider_pause(story, "dev", db=db, root=root)
    assert why is not None and why.startswith("paused: Claude limit, resumes ")
    assert story.state == StoryState.DEV_RETRY.value and story.dev_retries == 0
    # One event per pause, not one per tick.
    O._provider_pause(story, "dev", db=db, root=root)
    assert [e for e, _ in story._events].count("provider_limit_deferred") >= 1  # type: ignore[attr-defined]
    # api-only steps of the same story are not blocked by the Claude breaker.
    assert O._provider_pause(story, "docs_onboarder", db=db, root=root) is None
    # At the reset the breaker is closed: the next tick dispatches (auto-resume).
    data = PL.load(root)
    data["claude_session"]["until"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    PL._write(root, data)
    assert O._provider_pause(story, "dev", db=db, root=root) is None


def test_failover_restamps_the_story_runtime_and_records_it(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pol = job_policy.resolve_policy(_cfg(), {"failover": "on"})
    story, db = _orch_story(
        root, monkeypatch, runtime="claude_session", runtime_model="claude-x",
        policy_json=json.dumps(pol),
    )
    PL.trip(root, PL.LimitHit("claude_session", datetime.now(UTC) + timedelta(hours=3), "Claude usage limit", "x"))
    assert O._provider_pause(story, "dev", db=db, root=root) is None
    assert story.runtime == "api" and story.runtime_model is None
    fo = json.loads(story.policy_json)["failed_over"]
    assert fo["from"] == "claude_session" and fo["to"] == "api"
    assert story._events[-1][0] == "runtime_failover"  # type: ignore[attr-defined]


def test_claude_dev_run_keeps_the_limit_message_past_the_grade(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run cut by the limit after some work is graded (error = the gate's
    reason); ``provider_error`` still carries Claude's message, so the dev step
    pauses (breaker) instead of spending a retry."""
    import factory.claude_session.run as run_mod
    from factory.claude_session.conversation import ConversationResult
    from factory.claude_session.stream import ClaudeResult
    from factory.runner import GateVerdict

    limit = "Claude Code error: You've hit your limit · resets 3pm (UTC)"

    def fake_run_claude(**kw: Any) -> Any:
        conv = ConversationResult(
            rounds=[ClaudeResult(found=True, is_error=True, result_text=limit, tokens_out=50)],
            stop_reason="claude_error",
            error=limit,
            final_verdict=GateVerdict(passed=False, reason="tests red", output=""),
            gate_rounds=[{"round": 1, "passed": False}],
        )
        return run_mod.ClaudeRunOutcome(conv, 1, None)

    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    monkeypatch.setattr(run_mod, "state_dir", lambda r: root / "state")
    story_file = root / "story.md"
    story_file.write_text("# story\n", encoding="utf-8")
    res = run_mod.claude_dev_run(
        story_path=story_file, repo_path=root, software_factory_root=root,
        db_path=root / "state" / "f.db", model=None, test_command="true",
        gate_check=lambda: GateVerdict(passed=False, reason="tests red", output=""),
        max_gate_rounds=3,
    )
    assert res.error == "tests red" and res.provider_error == limit
    assert PL.provider_error_text("claude_session", res) == limit
    hit = PL.note_run_error(root, "claude_session", PL.provider_error_text("claude_session", res))
    assert hit is not None and PL.open_entry(root, "claude_session") is not None


# --------------------------------------------------------------------------- #
# Settings round trip: app set → config → app list; submit flags → frontmatter
# --------------------------------------------------------------------------- #


def test_app_set_review_and_caps_round_trip(tmp_path: Path) -> None:
    from factory.app_config import load_app_config
    from factory.cli_apps import set_app

    app_dir = tmp_path / "apps" / "demo"
    app_dir.mkdir(parents=True)
    (app_dir / "config.yaml").write_text(
        "name: demo\nrepo: o/demo\n# keep me\ndelivery:\n  default: draft_pr\n", encoding="utf-8"
    )
    res = set_app(
        root=tmp_path, app="demo", review_default="on", review_min_diff_lines=300,
        caps={"budget_usd": "45", "wall_clock_h": "90m"},
    )
    assert res["review"] == {"default": "on", "auto_min_diff_lines": 300}
    assert res["caps"]["budget_usd"] == 45.0 and res["caps"]["wall_clock_h"] == 1.5
    assert res["caps"]["max_rounds"] == 20
    assert set(res["changed"]) == {"review", "caps"} and res["comments_preserved"]
    cfg = load_app_config("demo", tmp_path)
    p = job_policy.resolve_policy(cfg, {})
    assert p["review"]["mode"] == "on" and p["caps"]["budget_usd"] == 45.0
    from factory.cli_apps import AppAddError

    with pytest.raises(AppAddError) as e:
        set_app(root=tmp_path, app="demo", review_default="maybe")
    assert e.value.code == "invalid_review"


def test_policy_view_shape() -> None:
    v = job_policy.policy_view(job_policy.resolve_policy(_cfg(), {"review": "on"}))
    assert v is not None
    assert v["review"] == {"mode": "on", "source": "job", "decision": None}
    assert set(v["caps"]) == {"budget_usd", "wall_clock_h", "max_rounds", "source"}


def test_status_pause_view_from_a_row(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from factory.jobs import status as st

    PL.trip(root, PL.LimitHit("claude_session", datetime.now(UTC) + timedelta(hours=1), "Claude usage limit", "x"))
    row = {
        "id": 1, "state": StoryState.DEV_RETRY.value, "chain_kind": "tdd", "pipeline": "solo",
        "runtime": "claude_session", "policy_json": None, "delivery_level": "draft_pr",
    }
    ctx = SimpleNamespace(root=root)
    paused = st._code_pause(ctx, [SimpleNamespace(row=row)])  # type: ignore[arg-type]
    assert paused is not None and paused["runtime"] == "claude_session"
    assert paused["why"].startswith("paused: Claude limit")
