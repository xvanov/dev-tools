"""``draft_pr`` / ``pr``: the PR's CI is watched — and a red run fed back to the
dev — BEFORE the story is settled to ``DELIVERED_PR``.

Live evidence 2026-11-02: job template-probe:006 (solo, ``draft_pr``) opened
PR #18 with a red ``docker build`` and was marked delivered the moment the PR
opened, so the failure never reached the dev. ``auto_merge`` stories already
had the CI-fix loop (``_handle_ci_failure``, ``_MAX_CI_FIX_CYCLES``); these
tests pin that ``draft_pr`` / ``pr`` now get the same loop, minus the merge and
minus the close-and-park:

* green → ``DELIVERED_PR`` with no CI-fix;
* red → ``ci_fix_redispatch`` with the CI log as the dev's finding, the fix is
  PUSHED to the same PR by ``handle_docs_enforcer``, then green → delivered;
* red after the cap (or the identical failure again) → still ``DELIVERED_PR``,
  PR never closed, with a ``ci_note`` that ``factory job status`` reports;
* a job cancel landing mid-wait wins;
* a draft stays a draft (never merged, never ``gh pr ready``);
* no verdict in time / no checks at all → delivered with a note, never wedged;
* the solo pipeline routes through the same watch.

No network: gh is faked through the watch's seams; git is never run.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory.chain import auto_merge as am
from factory.chain import delivery_gate
from factory.chain import handlers as H
from factory.chain.event_log import read_story_events
from factory.chain.orchestrator import (
    _dispatch_for_story,
    freshen_behind_prs,
    reconcile_from_github,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.delivery import DeliveryLevel as L
from tests.test_delivery_enforcement import (
    _cfg,
    _git,
    _reload,
    _repo_with_origin,
    _root,
    _story,
    _write_cfg,
)

GREEN = {"state": "passing", "failing": [], "pending": []}
RED = {"state": "failing", "failing": ["docker build"], "pending": []}
PENDING = {"state": "pending", "failing": [], "pending": ["docker build"]}
NONE = {"state": "none", "failing": [], "pending": []}


def _merge_must_not_run(**_kw: Any) -> str | None:
    raise AssertionError("gh pr merge must never run for a draft_pr / pr story")


@pytest.fixture
def am_root(tmp_path: Path) -> Path:
    root = _root(tmp_path)
    (root / "apps" / "sacrifice").mkdir(parents=True)
    _write_cfg(root, L.AUTO_MERGE)
    return root


@pytest.fixture(autouse=True)
def no_gh(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Any real subprocess (gh) call is recorded and answered with failure;
    ``gh pr ready`` / ``gh pr merge`` / ``gh pr close`` are forbidden."""
    seen: list[list[str]] = []
    real_run = subprocess.run

    def _run(cmd: Any, *a: Any, **k: Any) -> subprocess.CompletedProcess[str]:
        argv = [str(c) for c in cmd] if isinstance(cmd, list | tuple) else [str(cmd)]
        if argv[:1] == ["git"]:
            # Local git against tmp_path repos only (the push-safety tests).
            return real_run(cmd, *a, **k)
        seen.append(argv)
        if argv[:3] in (["gh", "pr", "ready"], ["gh", "pr", "merge"], ["gh", "pr", "close"]):
            raise AssertionError(f"forbidden gh call: {argv}")
        return subprocess.CompletedProcess(argv, 1, stdout="", stderr="no gh in tests")

    monkeypatch.setattr(subprocess, "run", _run)
    return seen


@pytest.fixture
def disarms(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    seen: list[int] = []

    def _disarm(_cfg: Any, pr_number: int | None, **_k: Any) -> str | None:
        seen.append(int(pr_number or 0))
        return None

    monkeypatch.setattr(delivery_gate, "disable_auto_merge", _disarm)
    return seen


@pytest.fixture
def red_acts_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Act on a red verdict on the first read (the stale-head guard is pinned
    by its own test)."""
    monkeypatch.setattr(am, "DELIVERY_CI_RED_MIN_AGE_S", 0)


def _events(root: Path, s: StoryRecord) -> list[dict[str, Any]]:
    assert s.id is not None
    return read_story_events(s.id, software_factory_root=root, slug_hint=s.slug)


def _names(root: Path, s: StoryRecord) -> list[str]:
    return [str(e.get("event")) for e in _events(root, s)]


def _tick(
    root: Path, s: StoryRecord, ci: dict[str, Any] | None, *, log: str = "", draft: bool = False
) -> list[am.MergeAction]:
    db = root / "state" / "factory.db"
    fx = am.FixturePR(
        pr_number=int(s.github_pr_number or 0),
        head_sha="ab" * 20,
        base_branch="main",
        story=_reload(db, s.id),
        is_draft=draft,
    )
    return am.auto_merge_tick(
        root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fx],
        db_path=db,
        merge_fn=_merge_must_not_run,
        pr_merged_query=lambda **k: False,
        pr_checks_query=lambda **_k: ci,
        ci_log_fetch=lambda **_k: log,
    )


def _back_from_dev(root: Path, s: StoryRecord) -> None:
    """The dev fixed it and the story came back round to PR_OPEN (the push is
    pinned separately in ``test_ci_fix_is_pushed_to_the_same_pr``)."""
    db = root / "state" / "factory.db"
    row = _reload(db, s.id)
    row.state = StoryState.PR_OPEN.value
    H.persist_story(row, db)


# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("level", [L.DRAFT_PR, L.PR])
def test_green_ci_delivers_without_a_fix(am_root: Path, disarms: list[int], level: L) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, level, github_pr_number=18)

    acts = _tick(am_root, s, GREEN, draft=level is L.DRAFT_PR)

    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert not acts[0].merged
    names = _names(am_root, s)
    assert "ci_fix_redispatch" not in names
    assert am.EVENT_CI_WATCH_STARTED in names and "delivered" in names
    delivered = [e for e in _events(am_root, s) if e.get("event") == "delivered"][-1]
    assert "ci_note" not in delivered
    assert disarms == [18]


def test_pending_ci_waits_and_writes_nothing(am_root: Path, disarms: list[int]) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=18)
    for _ in range(3):
        acts = _tick(am_root, s, PENDING, draft=True)
        assert "waiting for CI" in acts[0].reason
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    # One watch-start event for the whole wait, never one per tick.
    assert _names(am_root, s).count(am.EVENT_CI_WATCH_STARTED) == 1
    assert disarms == []


def test_red_ci_redispatches_with_the_log_then_green_delivers(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=18)
    log = "Error: env() called at module load: AUTH_SECRET is not set\nnext build failed"

    acts = _tick(am_root, s, RED, log=log, draft=True)

    row = _reload(db, s.id)
    assert row.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert "re-dispatched to dev" in acts[0].reason
    finding = json.loads(row.reviewer_result_json or "{}")
    assert finding["source"] == "ci_failure"
    assert "AUTH_SECRET is not set" in finding["findings"][0]["what"]
    redispatch = [e for e in _events(am_root, s) if e.get("event") == "ci_fix_redispatch"]
    assert len(redispatch) == 1 and redispatch[0]["attempt"] == 1
    assert redispatch[0]["level"] == "draft_pr" and redispatch[0]["failing"] == ["docker build"]
    # The REVIEWER_REQUESTED_CHANGES re-entry dispatches to dev.
    assert _dispatch_for_story(row) == "dev"

    _back_from_dev(am_root, s)
    # A fresh wait (fresh clock) for the fixed head.
    _tick(am_root, s, GREEN, draft=True)
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert _names(am_root, s).count(am.EVENT_CI_WATCH_STARTED) == 2
    assert row.error is None


def test_red_three_times_delivers_with_a_red_ci_note_and_never_closes_the_pr(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=21)
    for attempt in range(1, am._MAX_CI_FIX_CYCLES + 1):
        # A DIFFERENT failure each time, so only the cap can stop it.
        _tick(am_root, s, RED, log=f"failure number {attempt} in build step {attempt * 7}")
        assert _reload(db, s.id).state == StoryState.REVIEWER_REQUESTED_CHANGES.value
        _back_from_dev(am_root, s)

    acts = _tick(am_root, s, RED, log="failure number 4, still red")

    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value  # never BLOCKED_CI_UNRESOLVED
    names = _names(am_root, s)
    assert names.count("ci_fix_redispatch") == am._MAX_CI_FIX_CYCLES  # nothing loops > 3
    assert "ci_unresolved_parked" not in names
    delivered = [e for e in _events(am_root, s) if e.get("event") == "delivered"][-1]
    assert "CI is RED on PR #21" in delivered["ci_note"]
    assert "docker build" in delivered["ci_note"]
    assert "CI is RED" in (row.error or "")
    assert not row.last_rejection_reason  # not an inbox item: the PR is the deliverable
    assert "delivered" in acts[0].reason or "never merged" in acts[0].reason


def test_identical_failure_after_a_fix_delivers_with_a_note(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=22)
    _tick(am_root, s, RED, log="same failure")
    _back_from_dev(am_root, s)
    _tick(am_root, s, RED, log="same failure")
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert _names(am_root, s).count("ci_fix_redispatch") == 1
    assert "identical failure" in (row.error or "")


def test_stale_red_right_after_the_watch_starts_is_not_acted_on(
    am_root: Path, disarms: list[int]
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=23)
    acts = _tick(am_root, s, RED, log="old head's failure")
    assert "watch just started" in acts[0].reason
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    assert "ci_fix_redispatch" not in _names(am_root, s)


def test_job_cancel_mid_wait_stops_the_watch(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=24)
    _tick(am_root, s, PENDING, draft=True)  # the wait has started
    delivery_gate.mark_job_cancelled(db, "sacrifice", "900", by="test")

    for ci in (RED, GREEN):
        acts = _tick(am_root, s, ci, log="boom", draft=True)
        assert "cancelled" in acts[0].reason
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    assert "ci_fix_redispatch" not in _names(am_root, s)
    assert "delivered" not in _names(am_root, s)


def test_job_cancel_landing_between_the_ci_read_and_the_write_wins(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    """The cancel lands while gh is being read: the write re-checks the
    durable marker under the story lock and does nothing."""
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=25)

    def _ci_then_cancel(**_k: Any) -> dict[str, Any]:
        delivery_gate.mark_job_cancelled(db, "sacrifice", "900", by="test")
        return RED

    fx = am.FixturePR(pr_number=25, head_sha="ab" * 20, base_branch="main", story=s)
    acts = am.auto_merge_tick(
        am_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fx],
        db_path=db,
        merge_fn=_merge_must_not_run,
        pr_checks_query=_ci_then_cancel,
        ci_log_fetch=lambda **_k: "boom",
    )
    assert "cancelled" in acts[0].reason
    row = _reload(db, s.id)
    assert row.state == StoryState.PR_OPEN.value and not row.reviewer_result_json


def test_draft_stays_draft(
    am_root: Path, disarms: list[int], no_gh: list[list[str]], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=26)
    _tick(am_root, s, RED, log="red once", draft=True)
    _back_from_dev(am_root, s)
    acts = _tick(am_root, s, GREEN, draft=True)
    assert not acts[0].merged
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    # No gh call marked it ready, merged or closed (the fixture raises on
    # those); the only gh the watch ran is through its own seams.
    assert not any(c[:3] == ["gh", "pr", "ready"] for c in no_gh)
    assert not any(c[:3] == ["gh", "pr", "merge"] and "--disable-auto" not in c for c in no_gh)


def test_no_verdict_within_the_window_delivers_with_a_note(
    am_root: Path, disarms: list[int]
) -> None:
    db = am_root / "state" / "factory.db"
    cfg = _cfg(L.PR)
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=27)
    fx = am.FixturePR(pr_number=27, head_sha="ab" * 20, base_branch="main", story=s)
    t0 = 1_000_000.0

    def watch(ci: dict[str, Any] | None, now: float) -> am.MergeAction:
        return am._watch_ci_then_deliver(
            story=_reload(db, s.id),
            fixture=fx,
            level=L.PR,
            cfg=cfg,
            app="sacrifice",
            root=am_root,
            db=db,
            checks_query=lambda **_k: ci,
            now_fn=lambda: now,
        )

    # First read starts the clock (the event's ts is real "now"; the watch
    # clock reads now_fn, so pin the start by reading it back).
    watch(PENDING, t0)
    start = am._ci_watch_window(_events(am_root, s))[1]
    assert start is not None
    watch(None, start + am.DELIVERY_CI_WAIT_S - 1)  # unreadable: still waiting
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    watch(PENDING, start + am.DELIVERY_CI_WAIT_S + 1)
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "did not finish" in (row.error or "") and "docker build" in (row.error or "")


def test_no_checks_at_all_delivers_after_the_grace(am_root: Path, disarms: list[int]) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=28)
    fx = am.FixturePR(pr_number=28, head_sha="ab" * 20, base_branch="main", story=s)

    def watch(now_offset: float) -> None:
        events = _events(am_root, s)
        start = am._ci_watch_window(events)[1]
        base = start if start is not None else 0.0
        am._watch_ci_then_deliver(
            story=_reload(db, s.id),
            fixture=fx,
            level=L.PR,
            cfg=_cfg(L.PR),
            app="sacrifice",
            root=am_root,
            db=db,
            checks_query=lambda **_k: NONE,
            now_fn=(lambda: base + now_offset) if start is not None else None,
        )

    watch(0)
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    watch(am.DELIVERY_NO_CHECKS_GRACE_S + 1)
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "no checks reported" in (row.error or "")


def test_auto_merge_and_lower_levels_are_not_watched(am_root: Path, disarms: list[int]) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.BRANCH, github_pr_number=29)
    _tick(am_root, s, RED, log="x")
    # Unchanged settle (a branch-level row that somehow has a PR ends at
    # DELIVERED_PR, as before) — and no CI watch, no CI-fix.
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    assert "ci_fix_redispatch" not in _names(am_root, s)
    assert am.EVENT_CI_WATCH_STARTED not in _names(am_root, s)
    assert not am.watches_ci_before_delivery(L.AUTO_MERGE)
    assert not am.watches_ci_before_delivery(L.PUSH_TO_MAIN)
    assert not am.watches_ci_before_delivery(None)


def test_ci_fix_is_pushed_to_the_same_pr(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """After a CI-fix the story comes back through ``handle_docs_enforcer``:
    with a PR already open it PUSHES the fix to that PR (the 2026-08-09
    never-pushed bug) and returns to PR_OPEN for the watch — it never opens a
    second PR and never settles to DELIVERED_PR there."""
    root = _root(tmp_path)
    db = root / "state" / "factory.db"
    pushed: list[int | None] = []
    monkeypatch.setattr(H, "_changed_files_for_story", lambda *a, **k: ["src/a.py"])
    monkeypatch.setattr(H, "_residual_lint_for_story", lambda *a, **k: None)
    monkeypatch.setattr(
        H, "_open_pr_for_story", lambda *a, **k: pytest.fail("must not open a second PR")
    )

    def _push(story: StoryRecord, *_a: Any) -> tuple[bool, str | None]:
        pushed.append(story.github_pr_number)
        return True, None

    monkeypatch.setattr(H, "_push_fix_to_existing_pr", _push)
    s = _story(db, StoryState.TECH_WRITER_DONE, L.DRAFT_PR, github_pr_number=18)
    res = H.handle_docs_enforcer(s, _cfg(L.DRAFT_PR), root, dry_run=False, db_path=db)
    assert pushed == [18]
    assert res.next_state == StoryState.PR_OPEN
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value


def test_solo_story_goes_through_the_same_watch(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=30, pipeline="solo")
    _tick(am_root, s, RED, log="docker build: env() at module load", draft=True)
    row = _reload(db, s.id)
    assert row.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert _dispatch_for_story(row) == "dev"  # the solo dev gets reviewer_findings
    assert "env() at module load" in (row.reviewer_result_json or "")
    # Solo dev green → TESTS_GREEN → tech_writer (not review) → docs_enforcer.
    row.state = StoryState.TESTS_GREEN.value
    assert _dispatch_for_story(row) == "tech_writer"


def test_job_status_reports_the_red_ci_note(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    from factory.jobs.status import _ctx, _delivery_note

    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=31)
    for attempt in range(am._MAX_CI_FIX_CYCLES):
        _tick(am_root, s, RED, log=f"distinct failure {attempt}")
        _back_from_dev(am_root, s)
    _tick(am_root, s, RED, log="still red")
    ctx = _ctx(am_root, github=False)
    note = _delivery_note(ctx, {"id": s.id, "slug": s.slug})
    assert note is not None and "CI is RED on PR #31" in note


def test_reconcile_closed_pr_during_the_watch_is_closed_by_operator(tmp_path: Path) -> None:
    root = _root(tmp_path)
    db = root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=32)
    reconcile_from_github(
        db, "sacrifice", cfg=_cfg(L.DRAFT_PR), root=root, query_pr_state=lambda **_k: "CLOSED"
    )
    row = _reload(db, s.id)
    assert row.state == StoryState.CLOSED_BY_OPERATOR.value
    assert "closed on GitHub without merging" in (row.last_rejection_reason or "")


def test_reconcile_closed_auto_merge_pr_still_goes_to_attention(tmp_path: Path) -> None:
    root = _root(tmp_path)
    db = root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.AUTO_MERGE, github_pr_number=33)
    reconcile_from_github(
        db, "sacrifice", cfg=_cfg(L.AUTO_MERGE), root=root, query_pr_state=lambda **_k: "CLOSED"
    )
    assert _reload(db, s.id).state == StoryState.BLOCKED_DEPLOY_FAILED.value


def test_freshen_never_writes_into_a_watched_pr(tmp_path: Path) -> None:
    root = _root(tmp_path)
    db = root / "state" / "factory.db"
    _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=34)
    _story(db, StoryState.PR_OPEN, L.AUTO_MERGE, github_pr_number=35, github_branch="story/2-u")
    updated: list[int] = []
    freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_cfg(L.AUTO_MERGE),
        root=root,
        query_merge_state=lambda **_k: "BEHIND",
        update_branch=lambda *, app_config, pr_number: updated.append(pr_number) or True,
    )
    assert updated == [35]


def test_db_synthesized_pass_watches_without_touching_the_worktree(
    am_root: Path, disarms: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real tick path (no fixtures): a draft_pr story is watched through
    ``_query_pr_checks`` alone — no ``_story_worktree`` (which would merge the
    base into the story tree and get pushed onto the human's PR by the next
    CI fix) and no required-checks / head / files gh queries."""
    import factory.chain.worktree as wt_mod

    def _no(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("must not be called for a watched draft_pr / pr story")

    monkeypatch.setattr(wt_mod, "ensure_worktree_for_story", _no)
    for name in ("_query_ci_state", "_query_pr_head_sha", "_query_pr_files_changed"):
        monkeypatch.setattr(am, name, _no)
    monkeypatch.setattr(am, "_query_pr_checks", lambda **_k: GREEN)
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=36)
    acts = am.auto_merge_tick(
        am_root, "sacrifice", dry_run=False, db_path=db, merge_fn=_merge_must_not_run
    )
    assert len(acts) == 1 and not acts[0].merged
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value


def test_red_main_green_alone_is_a_wait_not_a_dev_fix(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=37)
    acts = _tick(am_root, s, {"state": "failing", "failing": ["main-green"], "pending": []})
    assert "main is red" in acts[0].reason
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    assert "ci_fix_redispatch" not in _names(am_root, s)


# --------------------------------------------------------------------------- #
# Review of PR #335 — must-fix / should-fix
# --------------------------------------------------------------------------- #


def test_must1_watch_only_runs_the_watch_and_touches_nothing_else(
    am_root: Path, disarms: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``auto_merge.enabled=false`` → the orchestrator calls with
    ``watch_only=True``: the draft_pr story is watched and delivered, the
    auto_merge story is not evaluated, gated or merged."""
    monkeypatch.setattr(am, "_query_pr_checks", lambda **_k: GREEN)
    monkeypatch.setattr(
        am, "_evaluate_one_pr", lambda **_k: pytest.fail("watch_only must not evaluate gates")
    )
    db = am_root / "state" / "factory.db"
    watched = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=40)
    merging = _story(
        db, StoryState.PR_OPEN, L.AUTO_MERGE, github_pr_number=41, github_branch="story/2-u"
    )
    acts = am.auto_merge_tick(
        am_root,
        "sacrifice",
        dry_run=False,
        db_path=db,
        merge_fn=_merge_must_not_run,
        watch_only=True,
    )
    assert [a.pr_number for a in acts] == [40]
    assert _reload(db, watched.id).state == StoryState.DELIVERED_PR.value
    assert _reload(db, merging.id).state == StoryState.PR_OPEN.value


def test_must1_orchestrator_runs_the_watch_when_auto_merge_is_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import orchestrator
    from tests.test_orchestrator_auto_merge_integration import _write_settings

    root = tmp_path / "software-factory"
    (root / "state").mkdir(parents=True)
    (root / "apps" / "sacrifice").mkdir(parents=True)
    (tmp_path / "sacrifice").mkdir()
    (root / "apps" / "sacrifice" / "config.yaml").write_text(
        f"name: sacrifice\nrepo: x/y\ndefault_branch: main\napp_repo_path: {tmp_path / 'sacrifice'}\n",
        encoding="utf-8",
    )
    calls: list[dict[str, Any]] = []

    def _rec(*_a: Any, **k: Any) -> list[Any]:
        calls.append(k)
        return []

    monkeypatch.setattr(orchestrator, "auto_merge_tick", _rec)
    for enabled in (False, True):
        calls.clear()
        _write_settings(root, auto_merge_enabled=enabled)
        orchestrator.tick(root, "sacrifice", dry_run=True, db_path=root / "state" / "factory.db")
        assert calls, f"auto_merge_tick not called with enabled={enabled}"
        assert all(c.get("watch_only") is (not enabled) for c in calls)


def _seed_fix_cycle(am_root: Path, s: StoryRecord) -> None:
    """One red → re-dispatch, then the story back at PR_OPEN."""
    _tick(am_root, s, RED, log="first failure")
    assert _reload(am_root / "state" / "factory.db", s.id).state == (
        StoryState.REVIEWER_REQUESTED_CHANGES.value
    )
    _back_from_dev(am_root, s)


@pytest.mark.parametrize(
    "event",
    ["fix_push_refused_foreign_commits", "fix_push_failed", "fix_push_skipped_no_commits"],
)
def test_must2_should5_unpushed_fix_delivers_with_the_real_reason(
    am_root: Path, disarms: list[int], red_acts_at_once: None, event: str
) -> None:
    from factory.chain.event_log import log_story_event

    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=42)
    _seed_fix_cycle(am_root, s)
    assert s.id is not None
    log_story_event(
        s.id, event, {"error": f"because {event}"}, software_factory_root=am_root, slug_hint=s.slug
    )
    # Whatever the old head's CI says now, it is not re-graded / re-dispatched.
    _tick(am_root, s, RED, log="first failure", draft=True)
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "was NOT pushed" in (row.error or "") and event in (row.error or "")
    assert _names(am_root, s).count("ci_fix_redispatch") == 1


def test_must2_fix_push_refuses_commits_a_human_pushed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin, wt = _repo_with_origin(tmp_path)
    _git(wt, "checkout", "-b", "story/1-t")
    (wt / "a.txt").write_text("factory\n")
    _git(wt, "add", "a.txt")
    _git(wt, "commit", "-m", "factory")
    _git(wt, "push", "origin", "story/1-t")
    # A human pushes to the PR branch from elsewhere...
    human = tmp_path / "human"
    _git(tmp_path, "clone", "-b", "story/1-t", str(origin), str(human))
    for k, v in (("user.email", "h@h"), ("user.name", "h"), ("commit.gpgsign", "false")):
        _git(human, "config", k, v)
    (human / "h.txt").write_text("human\n")
    _git(human, "add", "h.txt")
    _git(human, "commit", "-m", "human fix")
    _git(human, "push", "origin", "story/1-t")
    human_sha = _git(human, "rev-parse", "HEAD")
    # ...while the factory committed a CI fix locally.
    (wt / "a.txt").write_text("factory fix\n")
    _git(wt, "commit", "-am", "ci fix")

    root = _root(tmp_path)
    db = root / "state" / "factory.db"
    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: wt)
    s = _story(db, StoryState.DOCS_ENFORCER_CHECK, L.DRAFT_PR, github_pr_number=43)
    pushed, err = H._push_fix_to_existing_pr(s, _cfg(L.DRAFT_PR), root)
    assert pushed is False and "did not write" in (err or "")
    assert _git(origin, "rev-parse", "story/1-t") == human_sha  # never clobbered
    assert "fix_push_refused_foreign_commits" in _names(root, s)


def test_must2_fix_push_fast_forwards_and_records_the_pushed_sha(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin, wt = _repo_with_origin(tmp_path)
    _git(wt, "checkout", "-b", "story/1-t")
    (wt / "a.txt").write_text("v1\n")
    _git(wt, "add", "a.txt")
    _git(wt, "commit", "-m", "v1")
    _git(wt, "push", "origin", "story/1-t")
    (wt / "a.txt").write_text("v2\n")
    _git(wt, "commit", "-am", "ci fix")
    local = _git(wt, "rev-parse", "HEAD")
    root = _root(tmp_path)
    db = root / "state" / "factory.db"
    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: wt)
    s = _story(db, StoryState.DOCS_ENFORCER_CHECK, L.PR, github_pr_number=44)
    assert H._push_fix_to_existing_pr(s, _cfg(L.PR), root) == (True, None)
    assert _git(origin, "rev-parse", "story/1-t") == local
    pushes = [e for e in _events(root, s) if e.get("event") == "fix_push"]
    assert pushes and pushes[-1]["head_sha"] == local


def test_should5_red_on_a_head_the_factory_did_not_push_is_not_redispatched(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    from factory.chain.event_log import log_story_event

    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=45)
    assert s.id is not None
    log_story_event(
        s.id,
        am.EVENT_PR_HEAD_PUSHED,
        {"head_sha": "a" * 40},
        software_factory_root=am_root,
        slug_hint=s.slug,
    )
    _tick(am_root, s, {**RED, "head_sha": "b" * 40}, log="red on the human head")
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "someone else pushed" in (row.error or "")
    assert "ci_fix_redispatch" not in _names(am_root, s)


def test_should5_red_on_our_own_head_is_redispatched_and_recorded_by_sha(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    from factory.chain.event_log import log_story_event

    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=46)
    assert s.id is not None
    log_story_event(
        s.id,
        am.EVENT_PR_HEAD_PUSHED,
        {"head_sha": "c" * 40},
        software_factory_root=am_root,
        slug_hint=s.slug,
    )
    _tick(am_root, s, {**RED, "head_sha": "c" * 40}, log="real red")
    assert _reload(db, s.id).state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    redispatch = [e for e in _events(am_root, s) if e.get("event") == "ci_fix_redispatch"]
    assert redispatch[-1]["head_sha"] == "c" * 40
    from sqlmodel import Session, create_engine, select

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        rows = ses.exec(
            select(am.MergeActionRecord).where(am.MergeActionRecord.pr_number == 46)
        ).all()
    assert rows and rows[-1].head_sha == "c" * 40  # the real head, not local-<id>


def test_should4_infra_only_red_is_not_sent_to_the_dev(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=47)
    _tick(am_root, s, {**RED, "genuine": []}, log="The job was cancelled")
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "infra" in (row.error or "")
    assert "ci_fix_redispatch" not in _names(am_root, s)


def test_should4_no_fetchable_log_is_not_sent_to_the_dev(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=48)
    _tick(am_root, s, RED, log="")
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "no GitHub Actions log" in (row.error or "")
    assert "ci_fix_redispatch" not in _names(am_root, s)


def test_should4_query_pr_checks_marks_only_real_failures_genuine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rollup = [
        {"__typename": "CheckRun", "name": "docker build", "status": "COMPLETED",
         "conclusion": "FAILURE", "completedAt": "2026-11-02T10:00:00Z"},
        {"__typename": "CheckRun", "name": "e2e", "status": "COMPLETED",
         "conclusion": "TIMED_OUT", "completedAt": "2026-11-02T10:00:00Z"},
        {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED",
         "conclusion": "SUCCESS", "completedAt": "2026-11-02T10:00:00Z"},
    ]  # fmt: skip
    out = json.dumps({"statusCheckRollup": rollup, "headRefOid": "d" * 40})

    def _run(cmd: Any, *a: Any, **k: Any) -> subprocess.CompletedProcess[str]:
        assert "statusCheckRollup,headRefOid" in cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")

    monkeypatch.setattr(subprocess, "run", _run)
    ci = am._query_pr_checks(app_config=_cfg(L.PR), pr_number=5)
    assert ci is not None
    assert ci["state"] == "failing"
    assert sorted(ci["failing"]) == ["docker build", "e2e"]
    assert ci["genuine"] == ["docker build"]
    assert ci["head_sha"] == "d" * 40


def test_should6_docs_chain_red_is_not_sent_to_the_code_dev(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=49, chain_kind="docs")
    _tick(am_root, s, RED, log="docs build failed")
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "docs-chain" in (row.error or "")
    assert "ci_fix_redispatch" not in _names(am_root, s)


def test_should3_exhausted_ci_fix_settles_delivered_without_pushing(
    am_root: Path, disarms: list[int], red_acts_at_once: None
) -> None:
    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.DRAFT_PR, github_pr_number=50)
    _tick(am_root, s, RED, log="red", draft=True)
    row = _reload(db, s.id)
    row.state = StoryState.DEV_IN_PROGRESS.value
    row.dev_retries = 3
    H.persist_story(row, db)
    got = H._settle_exhausted_ci_fix_of_watched_pr(
        row, _cfg(L.DRAFT_PR), am_root, db=db, same_sig_count=2
    )
    assert got == StoryState.DELIVERED_PR
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    assert "was NOT pushed" in (row.error or "") and "same failure 2x" in (row.error or "")
    delivered = [e for e in _events(am_root, s) if e.get("event") == "delivered"][-1]
    assert "did not converge" in delivered["ci_note"]
    assert disarms == [50]


def test_should3_first_dev_cycle_and_merging_levels_keep_the_exhausted_path(
    am_root: Path, disarms: list[int]
) -> None:
    db = am_root / "state" / "factory.db"
    fresh = _story(db, StoryState.DEV_IN_PROGRESS, L.DRAFT_PR, github_pr_number=None)
    assert (
        H._settle_exhausted_ci_fix_of_watched_pr(
            fresh, _cfg(L.DRAFT_PR), am_root, db=db, same_sig_count=0
        )
        is None
    )
    merging = _story(
        db, StoryState.DEV_IN_PROGRESS, L.AUTO_MERGE, github_pr_number=51, github_branch="b/2"
    )
    assert (
        H._settle_exhausted_ci_fix_of_watched_pr(
            merging, _cfg(L.AUTO_MERGE), am_root, db=db, same_sig_count=0
        )
        is None
    )
    no_fix_yet = _story(
        db, StoryState.DEV_IN_PROGRESS, L.PR, github_pr_number=52, github_branch="b/3"
    )
    assert (
        H._settle_exhausted_ci_fix_of_watched_pr(
            no_fix_yet, _cfg(L.PR), am_root, db=db, same_sig_count=0
        )
        is None
    )


def test_nice_durable_clock_when_the_watch_start_event_cannot_be_written(
    am_root: Path, disarms: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.chain.event_log as ev

    db = am_root / "state" / "factory.db"
    s = _story(db, StoryState.PR_OPEN, L.PR, github_pr_number=53)
    real_log = ev.log_story_event

    def _log(sid: int, event: str, *a: Any, **k: Any) -> Any:
        if event == am.EVENT_CI_WATCH_STARTED:
            raise OSError("disk full")
        return real_log(sid, event, *a, **k)

    monkeypatch.setattr(ev, "log_story_event", _log)
    row = _reload(db, s.id)
    entered = 2_000_000_000.0
    row.updated_at = "2033-05-18T03:33:20+00:00"  # == entered
    act = am._watch_ci_then_deliver(
        story=row,
        fixture=am.FixturePR(pr_number=53, head_sha="ab" * 20, base_branch="main", story=row),
        level=L.PR,
        cfg=_cfg(L.PR),
        app="sacrifice",
        root=am_root,
        db=db,
        checks_query=lambda **_k: PENDING,
        now_fn=lambda: entered + am.DELIVERY_CI_WAIT_S + 5,
    )
    assert "never merged" in act.reason or "delivered" in act.reason
    assert "did not finish" in (_reload(db, s.id).error or "")
