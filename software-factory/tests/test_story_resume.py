"""Operator story-resume: the dependency-gate fix that makes re-triage possible,
the gate-block window reset that makes a resume actually retry, and the
resume planner's refusals.

The three regressions pinned here are the ones that made the factory unable to
finish work it had already substantially done:

1. a superseded sibling counted as a permanently-dead DEPENDENCY, so re-filing a
   direction's failed work always deadlocked the replacement (sacrifice story
   182, 2026-08-09) and every non-alt story downstream of a dual-draft pair;
2. the merge-gate block counter counted its own history, so resuming a story at
   the same head sha re-parked it before the fixed gate ever ran;
3. a resume that keeps a maxed-out attempt counter re-parks on the first tick.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import SQLModel, create_engine

from factory.chain.handlers import persist_story
from factory.chain.orchestrator import (
    _deps_permanently_dead,
    _direction_deps_pending,
)
from factory.chain.resume import (
    ResumePlan,
    apply_resume,
    infer_point,
    load_story,
    plan_resume,
    resumable_stories,
)
from factory.chain.state_machine import StoryRecord, StoryState


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}"))
    return db


def _story(db: Path, *, sid: int, state: str, direction: str = "120", **kw: object) -> StoryRecord:
    fields: dict[str, object] = {
        "id": sid,
        "direction_id": direction,
        "app": "sacrifice",
        "title": "t",
        "slug": kw.pop("slug", None) or f"s{sid}",
        "scope": "backend",
        "state": state,
    }
    fields.update(kw)
    return persist_story(StoryRecord(**fields), db)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# 1. A superseded sibling is NOT a dependency.
# --------------------------------------------------------------------------- #


def test_superseded_sibling_is_not_a_pending_dependency(tmp_path: Path) -> None:
    """The sacrifice-182 regression, exactly as it happened.

    Direction 120's stories 179/180/181 failed (their oracle was authored against
    an invented 401 body), were closed as ``superseded_by_sibling``, and the work
    was re-filed as story 182. 182 then listed all three as pending deps, every
    one of them permanently dead, and parked in ``blocked_dependency_unmet`` —
    twice. Re-triage after any story failure was structurally impossible.
    """
    db = _seed(tmp_path)
    for sid in (179, 180, 181):
        _story(db, sid=sid, state=StoryState.SUPERSEDED_BY_SIBLING.value)
    s182 = _story(db, sid=182, state=StoryState.STORY_CREATED.value)

    assert _direction_deps_pending(db, s182) == []
    assert not _deps_permanently_dead(db, _direction_deps_pending(db, s182))


def test_dualdraft_loser_does_not_deadlock_a_later_non_alt_story(tmp_path: Path) -> None:
    """The second, never-observed head of the same bug.

    When alt-a wins, ``close_abandoned_draft_sibling`` parks alt-b in
    ``superseded_by_sibling``. A later NON-alt story gets no dual-draft exemption,
    so alt-b was its only pending dep once deployed alt-a dropped out of the set —
    and it was terminalized the first time the gate ran. Every story filed after a
    dual-draft pair was stranded.
    """
    db = _seed(tmp_path)
    _story(db, sid=10, state=StoryState.DEPLOYED.value, slug="feature-alt-a")
    _story(db, sid=11, state=StoryState.SUPERSEDED_BY_SIBLING.value, slug="feature-alt-b")
    downstream = _story(db, sid=12, state=StoryState.STORY_CREATED.value, slug="smoke-test")

    assert _direction_deps_pending(db, downstream) == []


def test_a_genuinely_unbuilt_foundation_still_blocks(tmp_path: Path) -> None:
    """The exemption is narrow: only SUPERSEDED drops out. A real in-flight or
    human-blocked foundation must still hold its dependents back, or the fix
    would have traded a deadlock for the out-of-order construction the gate
    exists to prevent."""
    db = _seed(tmp_path)
    _story(db, sid=20, state=StoryState.SUPERSEDED_BY_SIBLING.value)
    _story(db, sid=21, state=StoryState.DEV_IN_PROGRESS.value)
    _story(db, sid=22, state=StoryState.BLOCKED_DEPLOY_FAILED.value)
    s23 = _story(db, sid=23, state=StoryState.STORY_CREATED.value)

    assert _direction_deps_pending(db, s23) == [21, 22]


def test_all_dead_dependencies_still_deadlock(tmp_path: Path) -> None:
    """The deadlock guard itself is untouched — a dependent behind only
    operator-closed / CI-unresolved foundations must still be parked rather than
    deferring forever."""
    db = _seed(tmp_path)
    _story(db, sid=30, state=StoryState.CLOSED_BY_OPERATOR.value)
    _story(db, sid=31, state=StoryState.BLOCKED_CI_UNRESOLVED.value)
    s32 = _story(db, sid=32, state=StoryState.STORY_CREATED.value)

    pending = _direction_deps_pending(db, s32)
    assert pending == [30, 31]
    assert _deps_permanently_dead(db, pending)


# --------------------------------------------------------------------------- #
# 2. The merge-gate block window resets on resume.
# --------------------------------------------------------------------------- #


def _write_events(root: Path, story_id: int, slug: str, events: list[dict[str, object]]) -> None:
    from factory.chain.event_log import log_story_event

    for ev in events:
        log_story_event(
            story_id,
            str(ev.pop("event")),
            dict(ev),
            software_factory_root=root,
            slug_hint=slug,
        )


def test_gate_block_history_counts_blocks_at_the_same_head(tmp_path: Path) -> None:
    from factory.chain.auto_merge import _gate_block_history

    _write_events(
        tmp_path,
        7,
        "s7",
        [
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
        ],
    )
    count, last = _gate_block_history(story_id=7, head_sha="abc", root=tmp_path, slug="s7")
    assert count == 2
    assert last is not None


def test_story_resumed_resets_the_gate_block_window(tmp_path: Path) -> None:
    """Without this, ``resume-story`` was a no-op with a success message.

    The common resume fixes the GATE, not the code — so there is no new commit and
    the head sha is unchanged. The next evaluation re-read the story's own three
    historical blocks, hit the cap on evaluation #1, and re-parked it before the
    fixed gate ever ran.
    """
    from factory.chain.auto_merge import _MAX_GATE_BLOCK_CYCLES, _gate_block_history

    _write_events(
        tmp_path,
        8,
        "s8",
        [
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
        ],
    )
    exhausted, _ = _gate_block_history(story_id=8, head_sha="abc", root=tmp_path, slug="s8")
    assert exhausted >= _MAX_GATE_BLOCK_CYCLES  # would re-park immediately

    _write_events(tmp_path, 8, "s8", [{"event": "story_resumed", "to_state": "pr_open"}])

    count, last = _gate_block_history(story_id=8, head_sha="abc", root=tmp_path, slug="s8")
    assert count == 0
    assert last is None  # and no cached payload, so the gates REALLY re-run


def test_blocks_after_a_resume_still_count(tmp_path: Path) -> None:
    """The reset is a window, not an amnesty: a story that keeps failing the same
    gate after being resumed must still exhaust the cap rather than loop forever
    (the hamster-wheel this cap exists to stop)."""
    from factory.chain.auto_merge import _gate_block_history

    _write_events(
        tmp_path,
        9,
        "s9",
        [{"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]}],
    )
    _write_events(tmp_path, 9, "s9", [{"event": "story_resumed", "to_state": "pr_open"}])
    _write_events(
        tmp_path,
        9,
        "s9",
        [
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
            {"event": "merge_gates_failed", "head_sha": "abc", "missing_labels": ["acceptance"]},
        ],
    )
    count, _ = _gate_block_history(story_id=9, head_sha="abc", root=tmp_path, slug="s9")
    assert count == 2


# --------------------------------------------------------------------------- #
# 3. The resume planner.
# --------------------------------------------------------------------------- #


def _root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


def test_infer_point_prefers_the_cheapest_re_entry() -> None:
    def mk(**kw: object) -> StoryRecord:
        base: dict[str, object] = {
            "direction_id": "120",
            "app": "sacrifice",
            "title": "t",
            "slug": "s",
            "scope": "backend",
            "state": StoryState.BLOCKED_CI_UNRESOLVED.value,
        }
        base.update(kw)
        return StoryRecord(**base)  # type: ignore[arg-type]

    # A PR means the diff is banked and gradeable — re-run the GATES, no persona.
    assert infer_point(mk(github_pr_number=395, github_branch="b")) == "gates"
    # Dev really ran — it continues from its own attempt history.
    assert infer_point(mk(dev_attempts_json=json.dumps([{"attempt": 1}]))) == "dev"
    # The SM ran; its story file is on disk. Skip straight to dev.
    assert infer_point(mk(sm_result_json="{}")) == "dev"
    # Nothing banked — a true rebuild is the only option.
    assert infer_point(mk()) == "sm"


def test_a_planned_branch_name_is_not_evidence_of_banked_work() -> None:
    """``github_branch`` is written with a PLANNED name when the row is spawned,
    before anything is built. Sacrifice story 182 was parked in
    ``blocked_dependency_unmet`` having never run its SM, with
    ``github_branch='story/396-…'`` already set — inferring ``dev`` from it would
    dispatch the dev persona against a story with no story file and no SM output.
    A field naming an intended artifact is not the artifact."""
    story = StoryRecord(
        direction_id="120",
        app="sacrifice",
        title="t",
        slug="120-add-get-api-goals-count-endpoint",
        scope="backend",
        state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
        github_branch="story/396-120-add-get-api-goals-count-endpoint",
        github_issue_number=396,
    )
    assert infer_point(story) == "sm"


def test_an_empty_dev_attempts_list_is_not_banked_work() -> None:
    """``dev_attempts_json`` is initialised to ``[]`` on some paths; a present but
    EMPTY list means dev never ran, so it must not route to ``dev``."""
    story = StoryRecord(
        direction_id="120",
        app="sacrifice",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.BLOCKED_UNDERSPECIFIED.value,
        dev_attempts_json="[]",
    )
    assert infer_point(story) == "sm"


def test_plan_refuses_a_deployed_story(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, sid=1, state=StoryState.DEPLOYED.value)
    plan = plan_resume(story=s, db=db, root=_root(tmp_path), point="sm")
    assert not plan.ok
    assert "already `deployed`" in plan.refusals[0]


def test_plan_refuses_an_unknown_point(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, sid=1, state=StoryState.BLOCKED_UNDERSPECIFIED.value)
    plan = plan_resume(story=s, db=db, root=_root(tmp_path), point="whenever")
    assert not plan.ok
    assert "unknown resume point" in plan.refusals[0]


def test_plan_refuses_gates_without_a_pr(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, sid=1, state=StoryState.BLOCKED_CI_UNRESOLVED.value)
    plan = plan_resume(story=s, db=db, root=_root(tmp_path), point="gates")
    assert not plan.ok
    assert "needs a PR" in plan.refusals[0]


def test_plan_refuses_when_the_pr_state_is_unreadable(tmp_path: Path) -> None:
    """Ambiguous evidence must BLOCK, not be optimistically read as OPEN — moving
    a story to ``pr_open`` on a PR that is really closed creates a phantom the
    auto-merge poller re-evaluates every tick forever."""
    db = _seed(tmp_path)
    s = _story(db, sid=1, state=StoryState.BLOCKED_CI_UNRESOLVED.value, github_pr_number=395)
    plan = plan_resume(
        story=s, db=db, root=_root(tmp_path), point="gates", app_repo=tmp_path / "nope"
    )
    assert not plan.ok
    assert "refusing rather than assuming it is open" in plan.refusals[0]


def test_plan_refuses_when_the_dependency_gate_would_re_park_it(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, sid=40, state=StoryState.CLOSED_BY_OPERATOR.value)
    s = _story(db, sid=41, state=StoryState.BLOCKED_DEPENDENCY_UNMET.value)
    plan = plan_resume(story=s, db=db, root=_root(tmp_path), point="sm")
    assert not plan.ok
    assert "dependency gate would re-park" in plan.refusals[0]


def test_plan_refuses_an_exhausted_spend_cap_but_force_downgrades_it(tmp_path: Path) -> None:
    """The budget breaker would re-park the story on its first dispatch, so a
    resume into an exhausted cap is refused. ``--force`` makes the operator own
    the overrun knowingly — it never zeroes the ledger."""
    db = _seed(tmp_path)
    root = _root(tmp_path)
    (root / "factory_settings.yaml").write_text(
        "caps:\n  per_story_spend_usd: 5.0\n", encoding="utf-8"
    )
    s = _story(db, sid=1, state=StoryState.BLOCKED_BUDGET_EXCEEDED.value, total_spend_usd=9.0)

    plan = plan_resume(story=s, db=db, root=root, point="sm")
    assert not plan.ok
    assert any("per_story_spend_usd" in r for r in plan.refusals)

    forced = plan_resume(story=s, db=db, root=root, point="sm", force=True)
    assert forced.ok
    assert any("per_story_spend_usd" in w for w in forced.warnings)


def test_plan_is_a_pure_preview(tmp_path: Path) -> None:
    """``pm-sync --dry-run`` once spawned live stories. A planner that mutates is
    the same bug in a new place, so this pins purity directly."""
    db = _seed(tmp_path)
    s = _story(
        db,
        sid=1,
        state=StoryState.BLOCKED_UNDERSPECIFIED.value,
        total_attempts=9,
        error="boom",
        last_rejection_reason="nope",
    )
    plan_resume(story=s, db=db, root=_root(tmp_path), point="dev")

    after = load_story(db, 1)
    assert after is not None
    assert after.state == StoryState.BLOCKED_UNDERSPECIFIED.value
    assert after.total_attempts == 9
    assert after.error == "boom"
    assert after.last_rejection_reason == "nope"


def test_apply_preserves_the_work_and_resets_only_the_re_park_counters(
    tmp_path: Path,
) -> None:
    """The point of the whole feature: the branch, the PR, the dev/reviewer
    history and — above all — the SPEND LEDGER survive; only the counters that
    would immediately re-park the story are cleared."""
    db = _seed(tmp_path)
    root = _root(tmp_path)
    s = _story(
        db,
        sid=1,
        state=StoryState.BLOCKED_CI_UNRESOLVED.value,
        github_branch="factory/story-391",
        github_pr_number=395,
        github_issue_number=391,
        dev_attempts_json=json.dumps([{"attempt": 1}, {"attempt": 2}]),
        reviewer_history_json=json.dumps([{"cycle": 1}]),
        sm_result_json="{}",
        story_file_path="stories/391.md",
        total_spend_usd=1.332,
        total_attempts=12,
        dependency_defer_count=3,
        error="gate_block_exhausted",
        last_rejection_reason="gate_block_exhausted: acceptance-verified",
    )
    plan = plan_resume(story=s, db=db, root=root, point="dev", reason="contract was wrong")
    assert plan.ok
    apply_resume(plan=plan, story=s, db=db, root=root)

    after = load_story(db, 1)
    assert after is not None
    # Preserved — none of this is re-done or re-paid for.
    assert after.github_branch == "factory/story-391"
    assert after.github_pr_number == 395
    assert after.github_issue_number == 391
    assert json.loads(after.dev_attempts_json or "[]") == [{"attempt": 1}, {"attempt": 2}]
    assert json.loads(after.reviewer_history_json or "[]") == [{"cycle": 1}]
    assert after.story_file_path == "stories/391.md"
    # The money ledger is TRUTH. A resume is not permission to forget the cost.
    assert after.total_spend_usd == pytest.approx(1.332)
    # Reset — otherwise the first tick re-parks it.
    assert after.state == StoryState.DEV_RETRY.value
    assert after.total_attempts == 0
    assert after.dependency_defer_count == 0
    assert after.error is None
    assert after.last_rejection_reason is None


def test_apply_logs_an_auditable_story_resumed_event(tmp_path: Path) -> None:
    """The event is not decoration — ``_gate_block_history`` reads it to reset the
    block window, so a resume that failed to log one would silently not retry."""
    from factory.chain.event_log import read_story_events

    db = _seed(tmp_path)
    root = _root(tmp_path)
    s = _story(db, sid=1, state=StoryState.BLOCKED_UNDERSPECIFIED.value, sm_result_json="{}")
    plan = plan_resume(story=s, db=db, root=root, point="dev", reason="spec fixed in #278")
    apply_resume(plan=plan, story=s, db=db, root=root)

    events = [e for e in read_story_events(1, software_factory_root=root, slug_hint="s1")]
    resumed = [e for e in events if e.get("event") == "story_resumed"]
    assert len(resumed) == 1
    assert resumed[0]["from_state"] == StoryState.BLOCKED_UNDERSPECIFIED.value
    assert resumed[0]["to_state"] == StoryState.DEV_RETRY.value
    assert resumed[0]["reason"] == "spec fixed in #278"
    assert resumed[0]["actor"] == "operator"


def test_apply_refuses_to_execute_a_refused_plan(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, sid=1, state=StoryState.DEPLOYED.value)
    bad = ResumePlan(
        story_id=1,
        slug="s1",
        app="sacrifice",
        from_state=s.state,
        to_state=StoryState.DEV_RETRY.value,
        point="dev",
        reason="",
        reauthor_oracle=False,
        refusals=["nope"],
    )
    with pytest.raises(RuntimeError):
        apply_resume(plan=bad, story=s, db=db, root=_root(tmp_path))
    after = load_story(db, 1)
    assert after is not None and after.state == StoryState.DEPLOYED.value


def test_reauthor_oracle_deletes_the_frozen_oracle(tmp_path: Path) -> None:
    """The oracle is deliberately frozen before dev starts (the anti-reward-hack
    property), so re-authoring must be an EXPLICIT operator act — and when the
    spec itself was wrong, it is the only way forward."""
    db = _seed(tmp_path)
    root = _root(tmp_path)
    acc = root / "state" / "acceptance" / "sacrifice" / "1"
    acc.mkdir(parents=True)
    (acc / "test_acceptance.py").write_text("# bad oracle\n", encoding="utf-8")
    (acc / "stub_runs.json").write_text("{}", encoding="utf-8")
    (acc / "attempts.json").write_text('{"passes": 3}', encoding="utf-8")

    s = _story(
        db,
        sid=1,
        state=StoryState.BLOCKED_CI_UNRESOLVED.value,
        sm_result_json="{}",
        acceptance_test_ref="state/acceptance/sacrifice/1/test_acceptance.py",
    )
    plan = plan_resume(
        story=s, db=db, root=root, point="dev", reauthor_oracle=True, reason="bad spec"
    )
    apply_resume(plan=plan, story=s, db=db, root=root)

    assert not (acc / "test_acceptance.py").exists()
    assert not (acc / "stub_runs.json").exists()
    # The exhausted author-pass counter goes too, or authoring stays blocked.
    assert not (acc / "attempts.json").exists()
    after = load_story(db, 1)
    assert after is not None and after.acceptance_test_ref is None


def test_resumable_stories_lists_parked_rows_only(tmp_path: Path) -> None:
    """Never ``is_terminal``: ``ci_pending`` is terminal-by-omission but ACTIVE
    (the auto-merge poller drives it), and offering to resume it would yank a
    live story backwards."""
    db = _seed(tmp_path)
    _story(db, sid=1, state=StoryState.BLOCKED_CI_UNRESOLVED.value)
    _story(db, sid=2, state=StoryState.SUPERSEDED_BY_SIBLING.value, total_spend_usd=1.5)
    _story(db, sid=4, state=StoryState.CI_PENDING.value)
    _story(db, sid=5, state=StoryState.DEV_IN_PROGRESS.value)

    assert sorted(s.id or 0 for s in resumable_stories(db)) == [1, 2]


def test_a_decision_parked_row_with_nothing_banked_is_not_offered(tmp_path: Path) -> None:
    """The suggestion surface would otherwise be a wall of settled history — 60+
    rows on the live DB, burying the two that needed an operator.

    A never-started dual-draft alternate (no PR, no dev attempt, $0) has nothing
    a resume could preserve, so re-triage is its correct path, not resume. A
    genuinely BLOCKED row is offered regardless of what it banked: it is stuck by
    a failure, not by a decision.
    """
    db = _seed(tmp_path)
    _story(db, sid=1, state=StoryState.SUPERSEDED_BY_SIBLING.value)  # $0, no PR
    _story(db, sid=2, state=StoryState.SUPERSEDED_BY_SIBLING.value, github_pr_number=395)
    _story(db, sid=3, state=StoryState.SUPERSEDED_BY_SIBLING.value, total_spend_usd=4.31)
    _story(
        db,
        sid=4,
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
        dev_attempts_json=json.dumps([{"attempt": 1}]),
    )
    # Blocked by a failure, nothing banked — still offered.
    _story(db, sid=5, state=StoryState.BLOCKED_DEPENDENCY_UNMET.value)
    # A planned branch name is not banked work (same trap as infer_point).
    _story(db, sid=6, state=StoryState.SUPERSEDED_BY_SIBLING.value, github_branch="story/9-x")

    assert sorted(s.id or 0 for s in resumable_stories(db)) == [2, 3, 4, 5]


def test_a_shipped_direction_retires_its_superseded_siblings(tmp_path: Path) -> None:
    """Once a sibling has DEPLOYED, the work a superseded row was abandoned in
    favour of is done — offering it would re-open settled history. The dual-draft
    loser is the canonical case: it is superseded precisely BECAUSE the winner
    shipped."""
    db = _seed(tmp_path)
    _story(db, sid=1, state=StoryState.DEPLOYED.value, direction="007", slug="f-alt-a")
    _story(
        db,
        sid=2,
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
        direction="007",
        slug="f-alt-b",
        total_spend_usd=3.0,
        github_pr_number=69,
    )
    # A different direction with nothing deployed keeps its superseded row.
    _story(
        db,
        sid=3,
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
        direction="120",
        total_spend_usd=1.33,
    )

    assert sorted(s.id or 0 for s in resumable_stories(db)) == [3]


def test_plan_resume_does_not_consult_the_suggestion_filter(tmp_path: Path) -> None:
    """The scoping shapes what the factory VOLUNTEERS; it must not become a
    permission check. An operator who names a retired story explicitly can still
    resume it — taking that away would remove a recovery they may legitimately
    want, on the basis of a heuristic."""
    db = _seed(tmp_path)
    _story(db, sid=1, state=StoryState.DEPLOYED.value, direction="007", slug="f-alt-a")
    loser = _story(
        db,
        sid=2,
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
        direction="007",
        slug="f-alt-b",
        sm_result_json="{}",
    )
    assert resumable_stories(db) == []  # not volunteered
    assert plan_resume(story=loser, db=db, root=_root(tmp_path), point="dev").ok  # still allowed


def test_tech_writer_re_entry_keeps_the_approved_diff_and_verdict(tmp_path: Path) -> None:
    """The blunt automatic recovery for a late failure re-enters at ``SM_DONE``,
    re-running SM + dev + review to reach the step that actually failed —
    sacrifice story 177 burned $5.96 over two recoveries rediscovering that its
    tech_writer model would not emit parseable JSON. Resuming at ``reviewer_done``
    re-runs only the failed step."""
    db = _seed(tmp_path)
    root = _root(tmp_path)
    # Pin the cap explicitly: the point of this test is the re-entry point, and a
    # defaulted cap below the story's real spend would fail it for the unrelated
    # budget reason (which has its own test).
    (root / "factory_settings.yaml").write_text(
        "caps:\n  per_story_spend_usd: 12.0\n", encoding="utf-8"
    )
    s = _story(
        db,
        sid=177,
        state=StoryState.BLOCKED_REVIEW_NONCONVERGENT.value,
        sm_result_json="{}",
        reviewer_result_json='{"verdict": "approve"}',
        reviewer_history_json=json.dumps([{"cycle": 1, "verdict": "approve"}]),
        dev_attempts_json=json.dumps([{"attempt": 1}]),
        total_spend_usd=5.96,
    )
    plan = plan_resume(story=s, db=db, root=root, point="tech_writer", reason="parse flake")
    assert plan.ok
    assert plan.to_state == StoryState.REVIEWER_DONE.value
    apply_resume(plan=plan, story=s, db=db, root=root)

    after = load_story(db, 177)
    assert after is not None
    assert after.state == StoryState.REVIEWER_DONE.value
    # The reviewer's approval and the dev's work are NOT discarded.
    assert after.reviewer_result_json == '{"verdict": "approve"}'
    assert json.loads(after.reviewer_history_json or "[]") == [{"cycle": 1, "verdict": "approve"}]
    assert after.total_spend_usd == pytest.approx(5.96)


def test_inbox_parked_section_is_opt_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``inbox``'s default output answers "what needs a human DECISION", and two
    existing tests pin specific parked rows as invisible there so the inbox and
    the tracker-closer can never disagree about that. A parked row is recoverable
    WORK, not a pending decision — a different claim, which must not be smuggled
    into the default view. It also runs ~20 rows deep on the live DB, which would
    bury the one or two rows that do need action.
    """
    from typer.testing import CliRunner

    import factory.cli as cli_mod

    db = _seed(tmp_path)
    _story(db, sid=1, state=StoryState.BLOCKED_DEPENDENCY_UNMET.value, slug="parked-deadlock")

    runner = CliRunner()
    monkeypatch.setattr(cli_mod, "_FACTORY_ROOT", tmp_path)
    default = runner.invoke(cli_mod.app, ["inbox", "--app", "sacrifice"])
    opted_in = runner.invoke(cli_mod.app, ["inbox", "--app", "sacrifice", "--parked"])

    assert default.exit_code == 0, default.stdout
    assert "parked-deadlock" not in default.stdout
    assert opted_in.exit_code == 0, opted_in.stdout
    assert "parked-deadlock" in opted_in.stdout


def test_apply_refuses_a_plan_built_for_a_different_story(tmp_path: Path) -> None:
    """``plan`` and ``story`` arrive as independent arguments and every mutation
    lands on ``story``. A mismatch would write one story's resume onto another
    row, and nothing downstream would object — every value in ``RESUME_POINTS``
    is a valid state string, so the bad write persists silently."""
    db = _seed(tmp_path)
    root = _root(tmp_path)
    planned = _story(db, sid=1, state=StoryState.BLOCKED_UNDERSPECIFIED.value, sm_result_json="{}")
    other = _story(db, sid=2, state=StoryState.BLOCKED_UNDERSPECIFIED.value, sm_result_json="{}")

    plan = plan_resume(story=planned, db=db, root=root, point="dev")
    with pytest.raises(RuntimeError, match="plan/story mismatch"):
        apply_resume(plan=plan, story=other, db=db, root=root)

    after = load_story(db, 2)
    assert after is not None
    assert after.state == StoryState.BLOCKED_UNDERSPECIFIED.value


def test_a_lost_resume_event_aborts_before_the_row_moves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The event IS the gate-block reset, not a record of one — and
    ``log_story_event`` is best-effort, reporting failure by staying silent.

    Row-first-event-lost would resume the story with its window un-reset, so the
    next evaluation re-parks it at the unchanged head sha: exactly the bug this
    module exists to fix, behind a green "resumed" panel. So the event is written
    and READ BACK first, and a missing one leaves the story parked.
    """
    import factory.chain.event_log as event_log

    db = _seed(tmp_path)
    root = _root(tmp_path)
    s = _story(db, sid=1, state=StoryState.BLOCKED_UNDERSPECIFIED.value, sm_result_json="{}")
    plan = plan_resume(story=s, db=db, root=root, point="dev")

    monkeypatch.setattr(event_log, "log_story_event", lambda *a, **k: None)
    with pytest.raises(RuntimeError, match="could not be written"):
        apply_resume(plan=plan, story=s, db=db, root=root)

    after = load_story(db, 1)
    assert after is not None
    assert after.state == StoryState.BLOCKED_UNDERSPECIFIED.value  # NOT resumed
    assert after.error is None or after.error == s.error


def test_resume_story_list_runs_without_a_story_id(tmp_path: Path) -> None:
    """``--list`` takes no story, but ``story_id`` was a required positional, so
    the documented flag exited 2 with "Missing argument 'STORY_ID'"."""
    from typer.testing import CliRunner

    import factory.cli as cli_mod

    db = _seed(tmp_path)
    _story(db, sid=1, state=StoryState.BLOCKED_DEPENDENCY_UNMET.value, slug="parked-one")

    runner = CliRunner()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cli_mod, "_FACTORY_ROOT", tmp_path)
        listed = runner.invoke(cli_mod.app, ["resume-story", "--list"])
        missing = runner.invoke(cli_mod.app, ["resume-story"])

    assert listed.exit_code == 0, listed.stdout
    assert "parked-one" in listed.stdout
    # Omitting the id WITHOUT --list is still an error, just a legible one.
    assert missing.exit_code == 2
