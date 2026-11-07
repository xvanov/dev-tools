"""Tests for the auto-merge worker.

Driven entirely in dry-run mode with fixture PRs so no network calls
escape the process.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import Session, create_engine, select

from factory.chain.auto_merge import (
    ALL_GATE_LABELS,
    FixturePR,
    MergeActionRecord,
    auto_merge_tick,
)
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\n"
        "gates:\n"
        "  lint_command: 'ruff check .'\n"
        "  format_check_command: 'ruff format --check .'\n"
        "  type_check_command: 'mypy .'\n"
        "  coverage_command: 'pytest --cov-fail-under=70'\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    return tmp_path


def _good_story(*, state: str = StoryState.PR_OPEN.value) -> StoryRecord:
    return StoryRecord(
        direction_id="002",
        app="sacrifice",
        title="t",
        slug="s",
        scope="backend",
        state=state,
        test_plan_json=json.dumps(
            {
                "test_plan": [
                    {
                        "name": "test_pledge_button",
                        "what_it_asserts": "User pledge dollars flow stores amount",
                        "why_meaningful": "Real outcome — user pledge flow",
                        "key_steps": ["arrange", "act", "assert"],
                    }
                ]
            }
        ),
        tech_writer_result_json=json.dumps({"context_updates": [{"path": "context/project.md"}]}),
        github_pr_number=42,
    )


def _good_fixture(*, pr_number: int = 42, labels: list[str] | None = None) -> FixturePR:
    return FixturePR(
        pr_number=pr_number,
        head_sha="deadbeef",
        base_branch="main",
        labels=list(labels or []),
        files_changed=["src/foo.py", "tests/test_foo.py"],
        ci_state="success",
        story=_good_story(),
    )


def test_all_gates_pass_yields_merge(factory_root: Path) -> None:
    pr = _good_fixture()
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[pr])
    assert len(actions) == 1
    assert actions[0].merged, actions[0].reason
    assert "all required gates" in actions[0].reason
    assert set(actions[0].gates_passed) == set(ALL_GATE_LABELS)


def test_blocking_label_prevents_merge(factory_root: Path) -> None:
    pr = _good_fixture(labels=["tests-slop"])
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[pr])
    assert not actions[0].merged
    assert "blocking labels" in actions[0].reason
    assert "tests-slop" in actions[0].blocking_labels


def test_do_not_merge_label_blocks(factory_root: Path) -> None:
    pr = _good_fixture(labels=["do-not-merge"])
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[pr])
    assert not actions[0].merged
    assert "do-not-merge" in actions[0].blocking_labels


def test_needs_test_quality_fix_blocks(factory_root: Path) -> None:
    pr = _good_fixture(labels=["needs-test-quality-fix"])
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[pr])
    assert not actions[0].merged


def test_missing_gate_blocks_merge(factory_root: Path) -> None:
    """If any gate would not pass, the missing-label list reflects it."""
    story = _good_story()
    # Wipe the tech_writer record so docs-current fails.
    story.tech_writer_result_json = None
    fixture = FixturePR(
        pr_number=43,
        head_sha="cafe",
        base_branch="main",
        labels=[],
        files_changed=["src/foo.py"],
        ci_state="success",
        story=story,
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert not actions[0].merged
    assert "missing gate labels" in actions[0].reason
    assert "docs-current" in actions[0].reason


def test_test_only_diff_blocks_merge(factory_root: Path) -> None:
    """The measured false-green (2026-08-04): a story whose whole diff is test
    files must not merge. ``harumiweb__exstruct-113`` spent $2.45, edited only
    ``tests/cli/test_cli_lazy_imports.py``, was approved at tq=0.90 and reached
    ``reviewer_done`` with diff_bytes=0."""
    fixture = FixturePR(
        pr_number=71,
        head_sha="cafe",
        base_branch="main",
        labels=[],
        files_changed=["tests/test_foo.py", "pyproject.toml"],
        ci_state="success",
        story=_good_story(),
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert not actions[0].merged
    assert "production-tree-changed" in actions[0].reason
    failed = {g["label"]: g for g in actions[0].gates_failed}
    assert "no production-code change" in failed["production-tree-changed"]["reason"]


def test_a_pr_label_cannot_satisfy_the_production_diff_gate(factory_root: Path) -> None:
    """``present_labels`` unions applied PR labels with the gates that just
    passed. For a fail-closed precondition that would be a recorded-flag hole:
    a label named after the gate would clear the requirement without the diff
    ever being looked at."""
    fixture = FixturePR(
        pr_number=72,
        head_sha="cafe",
        base_branch="main",
        labels=["production-tree-changed"],  # the forged evidence
        files_changed=["tests/test_foo.py"],
        ci_state="success",
        story=_good_story(),
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert not actions[0].merged
    assert "production-tree-changed" in actions[0].reason


def test_story_state_guard_prevents_premature_merge(factory_root: Path) -> None:
    """A story still in DEV_IN_PROGRESS is not eligible for merge even if
    fixture gates green."""
    story = _good_story(state=StoryState.DEV_IN_PROGRESS.value)
    fixture = FixturePR(
        pr_number=44,
        head_sha="aaaa",
        base_branch="main",
        labels=[],
        files_changed=["src/foo.py"],
        ci_state="success",
        story=story,
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert not actions[0].merged
    assert "not in mergeable states" in actions[0].reason


def test_merge_action_persisted_in_db(factory_root: Path) -> None:
    """Every evaluation records a row in ``merge_actions`` for the rollback worker."""
    pr = _good_fixture()
    auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[pr])
    db = factory_root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(MergeActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].pr_number == 42
    assert rows[0].merged is True
    assert "tests-meaningful" in json.loads(rows[0].gates_passed_json)


def test_no_fixtures_no_actions(factory_root: Path) -> None:
    """Dry-run with no PRs returns an empty list, not an error."""
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[])
    assert actions == []


# --------------------------------------------------------------------------- #
# Docs-chain auto-merge — the docs chain skips the 10 TDD gates because the
# canonical-paths enforcer already vetted the PR before reaching PR_OPEN.
# --------------------------------------------------------------------------- #


def _docs_story(*, state: str = StoryState.PR_OPEN.value) -> StoryRecord:
    """Minimal docs-chain StoryRecord at ``state`` with no TDD payload."""
    return StoryRecord(
        direction_id="005",
        app="sacrifice",
        title="Bootstrap context",
        slug="bootstrap-ctx",
        scope="docs",
        state=state,
        chain_kind="docs",
        github_pr_number=99,
    )


def test_docs_chain_pr_open_merges_without_tdd_gates(factory_root: Path) -> None:
    """A docs-chain story at PR_OPEN with no TDD gate labels merges; the
    chain enforcer already ran in ``handle_docs_enforcer``."""
    fixture = FixturePR(
        pr_number=99,
        head_sha="docs-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=_docs_story(),
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert actions[0].merged, actions[0].reason
    assert "docs chain" in actions[0].reason


def test_docs_chain_blocking_label_blocks(factory_root: Path) -> None:
    """A docs-chain story with a blocking label is refused, same as TDD."""
    fixture = FixturePR(
        pr_number=99,
        head_sha="docs-sha",
        base_branch="main",
        labels=["needs-human-verification"],
        files_changed=["context/project.md"],
        ci_state="success",
        story=_docs_story(),
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert not actions[0].merged
    assert "blocking labels" in actions[0].reason


def test_tdd_chain_still_requires_all_ten_gates(factory_root: Path) -> None:
    """Regression guard: the docs-chain branch must NOT relax TDD gates.
    A TDD story missing one gate is still refused (here we drop the
    tech_writer payload so docs-current fails)."""
    story = _good_story()
    story.tech_writer_result_json = None  # docs-current gate will fail
    fixture = FixturePR(
        pr_number=42,
        head_sha="tdd-sha",
        base_branch="main",
        labels=[],
        files_changed=["src/foo.py"],
        ci_state="success",
        story=story,
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert not actions[0].merged
    assert "missing gate labels" in actions[0].reason
    assert "docs-current" in actions[0].reason


# --------------------------------------------------------------------------- #
# _attempt_pr_reconcile — safe branch-update (gh pr update-branch) before sink
# --------------------------------------------------------------------------- #


def test_attempt_pr_reconcile_returns_true_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am

    calls: dict[str, list] = {}

    def _fake_run(cmd, **kw):
        calls["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)
    cfg = AppConfig(name="sacrifice", repo="x/sacrifice", default_branch="main")
    assert am._attempt_pr_reconcile(app_config=cfg, pr_number=90) is True
    # Uses gh pr update-branch (a merge, never --force).
    assert calls["cmd"][:3] == ["gh", "pr", "update-branch"]
    assert "90" in calls["cmd"] and "--force" not in calls["cmd"]


def test_attempt_pr_reconcile_returns_false_on_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am

    def _fake_run(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd, "", "merge conflict")

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)
    cfg = AppConfig(name="sacrifice", repo="x/sacrifice", default_branch="main")
    assert am._attempt_pr_reconcile(app_config=cfg, pr_number=90) is False


def test_loop4_story_merges_on_surviving_gates(tmp_path) -> None:
    """A Loop-4 story (dev-owns-tests; no test_implementer/test_designer
    payloads, no recorded lint/coverage flags, no labels applied by anyone)
    must be mergeable when the surviving gates pass: tests-green (recorded
    green dev run), tests-meaningful (no slop), docs-current (tech_writer
    result), canonical-paths-only. The historical 10-label requirement
    permanently blocked every Loop-4 merge (PRs 110/111, 2026-06-11)."""
    import json

    from factory.chain.auto_merge import FixturePR, auto_merge_tick
    from factory.chain.state_machine import StoryRecord, StoryState

    root = tmp_path
    (root / "apps" / "sacrifice").mkdir(parents=True, exist_ok=True)
    (root / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: x/y\ndefault_branch: main\n", encoding="utf-8"
    )
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    from sqlmodel import SQLModel, create_engine

    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}"))
    from factory.chain.handlers import persist_story

    story = persist_story(
        StoryRecord(
            direction_id="007",
            app="sacrifice",
            title="t",
            slug="loop4",
            scope="frontend",
            state=StoryState.PR_OPEN.value,
            chain_kind="tdd",
            github_pr_number=110,
            tech_writer_result_json=json.dumps(
                {"context_updates": ["context/modules/frontend.md"], "rationale": "updated"}
            ),
        ),
        db,
    )
    # Record a green dev run shape the tests-green gate reads in dry-run.
    import sqlite3 as _sq

    conn = _sq.connect(str(db))
    conn.execute(
        "UPDATE stories SET dev_attempts_json=? WHERE id=?",
        (json.dumps([{"test_run_passed": True, "test_output_tail": "ok"}]), story.id),
    )
    conn.commit()
    conn.close()

    fixture = FixturePR(
        pr_number=110,
        head_sha="abc",
        base_branch="main",
        labels=[],
        files_changed=["frontend/services/api.ts"],
        ci_state="success",
        story=story,
        repo_root=None,
    )
    actions = auto_merge_tick(
        app="sacrifice",
        software_factory_root=root,
        dry_run=True,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert len(actions) == 1
    act = actions[0]
    assert act.merged, f"expected merge, got reason={act.reason!r}"


# --------------------------------------------------------------------------- #
# Dual-draft sibling cleanup wiring (audit 2026-07-18, leak 4 of 4)
# --------------------------------------------------------------------------- #


def test_auto_merge_closes_sibling_draft_alternative_on_merge(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a dual-draft story's PR merges (real-run, not dry-run), the
    losing sibling draft-alternative's still-open GitHub issue gets closed
    automatically — the cleanup the tracker comment promised but that never
    actually ran (e.g. #210 stayed open forever after #209 merged)."""
    import subprocess

    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"

    winner = StoryRecord(
        direction_id="007",
        app="sacrifice",
        title="Make it better — narrow read",
        slug="make-it-better-alt-a",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_issue_number=209,
        github_pr_number=555,
    )
    persist_story(winner, db)
    loser = StoryRecord(
        direction_id="007",
        app="sacrifice",
        title="Make it better — broad read",
        slug="make-it-better-alt-b",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_issue_number=210,
        github_pr_number=556,
    )
    persist_story(loser, db)

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)

    class _Issue:
        def __init__(self, number: int, state: str = "open") -> None:
            self.number = number
            self.state = state
            self.comments: list[str] = []
            self.close_reason: str | None = None

        def create_comment(self, body: str) -> None:
            self.comments.append(body)

        def edit(self, *, state: str, state_reason: str | None = None) -> None:
            self.state = state
            self.close_reason = state_reason

    class _Repo:
        def __init__(self, issues: dict[int, _Issue]) -> None:
            self._issues = issues

        def get_issue(self, n: int) -> _Issue:
            return self._issues[n]

    class _Client:
        def __init__(self, repo: _Repo) -> None:
            self._repo = repo

        def get_repo(self, full_name: str) -> _Repo:
            return self._repo

    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))

    fixture = FixturePR(
        pr_number=555,
        head_sha="alt-a-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=winner,
    )

    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        github_client=client,
        db_path=db,
        # Real-run now CONFIRMS the merge on GitHub before claiming merged=True
        # (``--auto`` only enables async auto-merge). This PR's checks were
        # already green, so the confirmation query reports it merged.
        pr_merged_query=lambda **_kwargs: True,
    )

    assert actions[0].merged, actions[0].reason
    assert sibling_issue.state == "closed"
    assert sibling_issue.close_reason == "not_planned"
    assert sibling_issue.comments and "#209" in sibling_issue.comments[0]


def test_auto_merge_does_not_close_sibling_when_dry_run(
    factory_root: Path,
) -> None:
    """Sanity: dry-run merges must never touch GitHub for the sibling
    cleanup either (mirrors the rest of the worker's dry-run contract)."""
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    winner = StoryRecord(
        direction_id="011",
        app="sacrifice",
        title="Make it better — narrow read",
        slug="make-it-better-alt-a",
        scope="docs",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_issue_number=219,
        github_pr_number=565,
    )
    persist_story(winner, db)
    loser = StoryRecord(
        direction_id="011",
        app="sacrifice",
        title="Make it better — broad read",
        slug="make-it-better-alt-b",
        scope="docs",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_issue_number=220,
        github_pr_number=566,
    )
    persist_story(loser, db)

    fixture = FixturePR(
        pr_number=565,
        head_sha="alt-a-sha-2",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=winner,
    )
    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=True,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert actions[0].merged, actions[0].reason
    # No github_client was even provided in dry-run; nothing to assert on
    # the (nonexistent) sibling issue beyond "no exception raised".


# --------------------------------------------------------------------------- #
# merged != auto-merge-enabled: ``gh pr merge --auto`` only ENABLES GitHub
# auto-merge; it does NOT merge now. ``merged=True`` must reflect a REAL merge.
# --------------------------------------------------------------------------- #


def _docs_pr_story(*, pr_number: int, state: str = StoryState.PR_OPEN.value) -> StoryRecord:
    """A docs-chain story so real-run gate evaluation is hermetic (the docs
    chain synthesizes ``canonical-paths-only`` — no gate command shell-outs)."""
    return StoryRecord(
        direction_id="030",
        app="sacrifice",
        title="t",
        slug=f"amerge-{pr_number}",
        scope="docs",
        state=state,
        chain_kind="docs",
        github_issue_number=pr_number,
        github_pr_number=pr_number,
    )


def _merged_rows(db: Path) -> list[MergeActionRecord]:
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return list(
            ses.exec(select(MergeActionRecord).where(MergeActionRecord.merged == True))  # noqa: E712
        )


def _reload_story(db: Path, story_id: int | None) -> StoryRecord:
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return ses.exec(select(StoryRecord).where(StoryRecord.id == story_id)).one()


def test_auto_merge_enabled_but_not_merged_does_not_advance_or_record(
    factory_root: Path,
) -> None:
    """The strand root cause: ``gh pr merge --auto`` succeeded (auto-merge
    ENABLED) but the PR is not merged yet (required checks pending). The worker
    must NOT claim merged=True, NOT record a merged merge-action, and NOT
    advance the story — it stays in a mergeable state so reconcile + the
    CI-failure loop keep watching it."""
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_docs_pr_story(pr_number=801), db)

    # Fake gh merge: "enables auto-merge" — returns success (None) WITHOUT
    # merging. Records that it was invoked.
    called: list[bool] = []

    def _fake_merge(**_kwargs: object) -> str | None:
        called.append(True)
        return None

    # PR state query: the PR is still OPEN / not merged.
    def _not_merged(**_kwargs: object) -> bool:
        return False

    fixture = FixturePR(
        pr_number=801,
        head_sha="pending-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )

    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_fake_merge,
        pr_merged_query=_not_merged,
    )

    assert called  # the merge (auto-merge enable) was actually attempted
    assert len(actions) == 1
    act = actions[0]
    assert act.merged is False
    assert act.auto_merge_enabled is True
    assert "awaiting required checks" in act.reason
    # No merged=True row → _latest_undeployed_sha never picks it up (no deploy).
    assert _merged_rows(db) == []
    # Story is NOT advanced — stays in a mergeable state (reconcile + CI-failure
    # loop keep watching it); it is NOT stranded at deploy_pending.
    assert _reload_story(db, story.id).state == StoryState.PR_OPEN.value


def test_auto_merge_confirmed_merge_advances_and_enqueues_deploy(
    factory_root: Path,
) -> None:
    """When the post-merge GitHub query confirms the PR ACTUALLY merged (e.g.
    ``--auto`` merged immediately because checks were already green), the worker
    claims merged=True, records a merged merge-action, advances the story to
    DEPLOY_PENDING, and enqueues a deploy — exactly as before."""
    from factory.chain.handlers import persist_story
    from factory.deploy.models import DeployQueueEntry

    db = factory_root / "state" / "factory.db"
    story = persist_story(_docs_pr_story(pr_number=802), db)

    # Start query returns False (not yet merged at the top of _evaluate_one_pr),
    # post-merge query returns True (the --auto merge landed). Stateful by count.
    calls: list[int] = []

    def _merged_after_merge(**_kwargs: object) -> bool:
        calls.append(1)
        return len(calls) >= 2  # 1st call (start short-circuit) False, 2nd True

    def _fake_merge(**_kwargs: object) -> str | None:
        return None  # success (merge requested/performed)

    fixture = FixturePR(
        pr_number=802,
        head_sha="merged-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )

    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_fake_merge,
        pr_merged_query=_merged_after_merge,
    )

    assert actions[0].merged is True
    assert actions[0].auto_merge_enabled is False
    # Merged row recorded for the head sha → deploy pipeline can pick it up.
    merged = _merged_rows(db)
    assert [r.head_sha for r in merged] == ["merged-sha"]
    # Story advanced to DEPLOY_PENDING.
    assert _reload_story(db, story.id).state == StoryState.DEPLOY_PENDING.value
    # Deploy enqueued for the merged sha.
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        q = list(ses.exec(select(DeployQueueEntry).where(DeployQueueEntry.sha == "merged-sha")))
    assert len(q) == 1


def test_auto_merge_already_merged_short_circuits(factory_root: Path) -> None:
    """If the PR is ALREADY merged on GitHub at the top of the tick (the async
    ``--auto`` merge landed between ticks), the worker short-circuits to
    merged=True without re-running gates/staging, and drives deploy."""
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_docs_pr_story(pr_number=803), db)

    def _already(**_kwargs: object) -> bool:
        return True

    def _fake_merge(**_kwargs: object) -> str | None:  # must NOT be called
        raise AssertionError("merge should be short-circuited when already merged")

    fixture = FixturePR(
        pr_number=803,
        head_sha="landed-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )

    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_fake_merge,
        pr_merged_query=_already,
    )

    assert actions[0].merged is True
    assert actions[0].reason == "already merged on GitHub"
    assert _reload_story(db, story.id).state == StoryState.DEPLOY_PENDING.value


def test_auto_merge_enabled_then_failing_check_leaves_story_redispatchable(
    factory_root: Path,
) -> None:
    """Regression for the exact strand (factory story 102 / PR #57): auto-merge
    was ENABLED, then a required check (ruff lint) FAILED, so the PR never
    merges. The story must remain in ``_MERGEABLE_STATES`` so a later tick's
    CI-failure path (``_handle_ci_failure``, guarded to those states) can
    re-dispatch dev — NOT stranded at deploy_pending where nothing watches it."""
    from factory.chain.auto_merge import _MERGEABLE_STATES
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_docs_pr_story(pr_number=804), db)

    # Tick 1: auto-merge enabled, PR not merged yet.
    fixture = FixturePR(
        pr_number=804,
        head_sha="strand-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )
    auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=lambda **_k: None,
        pr_merged_query=lambda **_k: False,
    )

    reloaded = _reload_story(db, story.id)
    # The story is still in a mergeable state — reachable by _handle_ci_failure.
    assert reloaded.state in _MERGEABLE_STATES
    assert reloaded.state == StoryState.PR_OPEN.value
    assert _merged_rows(db) == []


# --------------------------------------------------------------------------- #
# Part 2 — dual-draft loser self-check: a story must REFUSE to merge if a
# sibling already shipped. This is the defense-in-depth backstop that composes
# with the reconcile-detected ``--auto`` merge path: Part 1 supersedes losers
# the winner's cleanup can reach; this catches a loser whose OWN PR reaches the
# merge worker in the SAME window the winner merged.
# --------------------------------------------------------------------------- #


def _seed_dual_pair(
    db: Path,
    *,
    winner_state: str,
    loser_state: str = StoryState.PR_OPEN.value,
    loser_pr: int = 556,
) -> tuple[StoryRecord, StoryRecord]:
    """Docs-chain dual-draft pair (hermetic gates): winner ``-alt-a`` in
    ``winner_state``, loser ``-alt-b`` in ``loser_state`` with PR ``loser_pr``."""
    from factory.chain.handlers import persist_story

    winner = persist_story(
        StoryRecord(
            direction_id="042",
            app="sacrifice",
            title="w",
            slug="picker-refactor-alt-a",
            scope="docs",
            state=winner_state,
            chain_kind="docs",
            github_issue_number=209,
            github_pr_number=555,
        ),
        db,
    )
    loser = persist_story(
        StoryRecord(
            direction_id="042",
            app="sacrifice",
            title="l",
            slug="picker-refactor-alt-b",
            scope="docs",
            state=loser_state,
            chain_kind="docs",
            github_issue_number=210,
            github_pr_number=loser_pr,
        ),
        db,
    )
    return winner, loser


def _cfg() -> object:
    from factory.app_config import AppConfig

    return AppConfig(name="sacrifice", repo="o/r", default_branch="main")


def test_sibling_already_shipped_true_for_each_shipped_state(factory_root: Path) -> None:
    """A dual-draft loser is 'superseded' when its sibling is in ANY shipped
    state: deployed, deploy_pending, or superseded_by_sibling."""
    from factory.chain.auto_merge import _sibling_already_shipped

    for st in (
        StoryState.DEPLOYED.value,
        StoryState.DEPLOY_PENDING.value,
        StoryState.SUPERSEDED_BY_SIBLING.value,
    ):
        db = factory_root / "state" / f"dd-{st}.db"
        _winner, loser = _seed_dual_pair(db, winner_state=st)
        assert _sibling_already_shipped(story=loser, db_path=db) is True, st


def test_sibling_already_shipped_true_when_sibling_has_merged_pr(factory_root: Path) -> None:
    """Even before the winner's StoryRecord advances to a shipped state, a
    merged=True merge-action row for its PR marks the loser as superseded."""
    from factory.chain.auto_merge import (
        MergeAction,
        _record_merge_action,
        _sibling_already_shipped,
    )

    db = factory_root / "state" / "merged-pr.db"
    # Winner still in a mergeable state, but its PR (555) recorded a merge.
    winner, loser = _seed_dual_pair(db, winner_state=StoryState.PR_OPEN.value)
    _record_merge_action(
        MergeAction(app="sacrifice", pr_number=555, merged=True, reason="merged"),
        "sha-win",
        db,
    )
    assert _sibling_already_shipped(story=loser, db_path=db) is True


def test_sibling_already_shipped_false_when_no_sibling_shipped(factory_root: Path) -> None:
    """Both siblings still in-flight → neither is superseded (the first to merge
    wins normally)."""
    from factory.chain.auto_merge import _sibling_already_shipped

    db = factory_root / "state" / "both-open.db"
    winner, loser = _seed_dual_pair(db, winner_state=StoryState.PR_OPEN.value)
    assert _sibling_already_shipped(story=loser, db_path=db) is False
    assert _sibling_already_shipped(story=winner, db_path=db) is False


def test_sibling_already_shipped_false_for_non_dual_draft(factory_root: Path) -> None:
    """A story without an ``-alt-*`` suffix is never superseded, even if a
    same-direction sibling shipped."""
    from factory.chain.auto_merge import _sibling_already_shipped
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "non-dd.db"
    persist_story(
        StoryRecord(
            direction_id="043",
            app="sacrifice",
            title="s",
            slug="plain-shipped",
            scope="docs",
            state=StoryState.DEPLOYED.value,
            github_pr_number=1,
        ),
        db,
    )
    normal = persist_story(
        StoryRecord(
            direction_id="043",
            app="sacrifice",
            title="n",
            slug="plain-other",
            scope="docs",
            state=StoryState.PR_OPEN.value,
            github_pr_number=2,
        ),
        db,
    )
    assert _sibling_already_shipped(story=normal, db_path=db) is False


def test_sibling_already_shipped_failsafe_on_query_error(factory_root: Path) -> None:
    """A query blowup must fail-safe to False — NEVER wrongly supersede a
    legitimate story on a DB hiccup."""
    from factory.chain.auto_merge import _sibling_already_shipped

    db = factory_root / "state" / "boom.db"
    _winner, loser = _seed_dual_pair(db, winner_state=StoryState.DEPLOYED.value)

    def _boom(**_kwargs):
        raise RuntimeError("db exploded")

    # Even though the real query WOULD supersede (sibling deployed), the raising
    # injected query is swallowed → False.
    assert _sibling_already_shipped(story=loser, db_path=db, sibling_rows=_boom) is False


def test_evaluate_one_pr_refuses_loser_when_sibling_shipped(factory_root: Path) -> None:
    """``_evaluate_one_pr`` returns a non-merged, ``superseded_by_sibling`` action
    for a loser whose sibling already shipped — before any merge is attempted."""
    from factory.chain.auto_merge import FixturePR, _evaluate_one_pr

    db = factory_root / "state" / "eval.db"
    _winner, loser = _seed_dual_pair(db, winner_state=StoryState.DEPLOYED.value)

    fixture = FixturePR(
        pr_number=556,
        head_sha="loser-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=loser,
    )
    action = _evaluate_one_pr(
        app="sacrifice",
        fixture=fixture,
        app_config=_cfg(),
        dry_run=True,
        github_client=None,
        db_path=db,
    )
    assert action.merged is False
    assert action.superseded_by_sibling is True
    assert action.reason == "superseded: sibling already shipped"


def test_evaluate_one_pr_failsafe_merges_on_query_error(factory_root: Path) -> None:
    """A raising ``sibling_shipped_query`` must NOT block a legitimate merge — the
    self-check fails safe and evaluation proceeds to a normal (merged) decision."""
    from factory.chain.auto_merge import FixturePR, _evaluate_one_pr

    db = factory_root / "state" / "eval-safe.db"
    _winner, loser = _seed_dual_pair(db, winner_state=StoryState.DEPLOYED.value)

    def _boom(**_kwargs):
        raise RuntimeError("query exploded")

    fixture = FixturePR(
        pr_number=556,
        head_sha="loser-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=loser,
    )
    action = _evaluate_one_pr(
        app="sacrifice",
        fixture=fixture,
        app_config=_cfg(),
        dry_run=True,
        github_client=None,
        db_path=db,
        sibling_shipped_query=_boom,
    )
    # Despite the deployed sibling, the raising query fails safe → the docs-chain
    # loser merges normally (dry-run merged=True), never wrongly superseded.
    assert action.superseded_by_sibling is False
    assert action.merged is True


def test_auto_merge_tick_supersedes_loser_and_closes_pr(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: the merge worker refuses the loser, parks it terminally in
    SUPERSEDED_BY_SIBLING, and closes its PR via gh (defense-in-depth for the
    same-window race the reconcile path can miss)."""
    import subprocess

    db = factory_root / "state" / "factory.db"
    _winner, loser = _seed_dual_pair(db, winner_state=StoryState.DEPLOYED.value)

    closed: list[list] = []

    def _fake_run(cmd: list, **kwargs: object) -> subprocess.CompletedProcess:
        closed.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)

    fixture = FixturePR(
        pr_number=556,
        head_sha="loser-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=loser,
    )
    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        github_client=None,
        db_path=db,
    )

    assert actions[0].merged is False
    assert actions[0].superseded_by_sibling is True
    assert _reload_story(db, loser.id).state == StoryState.SUPERSEDED_BY_SIBLING.value
    # The loser's PR (556) was closed so it can never auto-merge.
    assert any(
        c[:3] == ["gh", "pr", "close"] and "556" in c and "--delete-branch" in c for c in closed
    )
    # No merge row recorded for the loser.
    assert _merged_rows(db) == []


def test_auto_merge_tick_does_not_supersede_when_no_sibling_shipped(
    factory_root: Path,
) -> None:
    """Both dual-draft siblings still in-flight → the evaluated one merges
    normally; neither is superseded (the winner must never be blocked)."""
    db = factory_root / "state" / "factory.db"
    winner, _loser = _seed_dual_pair(db, winner_state=StoryState.PR_OPEN.value)

    fixture = FixturePR(
        pr_number=555,
        head_sha="win-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=winner,
    )
    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=True,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert actions[0].superseded_by_sibling is False
    assert actions[0].merged is True
    assert _reload_story(db, winner.id).state == StoryState.DEPLOY_PENDING.value


# --------------------------------------------------------------------------- #
# Conflict -> dev REBUILD loop: a genuinely-CONFLICTING PR is regenerated on a
# FRESH branch off current main (bounded), instead of parking forever the first
# time ``gh pr update-branch`` can't reconcile it.
# --------------------------------------------------------------------------- #


def _conflict_story(*, pr_number: int, issue: int, slug: str = "conflict-story") -> StoryRecord:
    """A docs-chain story (hermetic gates) sitting at PR_OPEN with a PR."""
    return StoryRecord(
        direction_id="099",
        app="sacrifice",
        title="t",
        slug=slug,
        scope="docs",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_issue_number=issue,
        github_branch=f"factory/story-{issue}-{slug}",
        github_pr_number=pr_number,
    )


def _read_events(root: Path, story: StoryRecord) -> list[dict]:
    from factory.chain.event_log import read_story_events

    return read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)


def _event_types(root: Path, story: StoryRecord) -> list[str]:
    return [e.get("event") for e in _read_events(root, story)]


# --- _pr_is_conflicting -----------------------------------------------------


def test_pr_is_conflicting_true_on_conflicting(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am

    def _run(cmd, **kw):
        return subprocess.CompletedProcess(
            cmd, 0, json.dumps({"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"}), ""
        )

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    assert am._pr_is_conflicting(app_config=cfg, pr_number=7) is True


def test_pr_is_conflicting_false_on_clean(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am

    def _run(cmd, **kw):
        return subprocess.CompletedProcess(
            cmd, 0, json.dumps({"mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"}), ""
        )

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    assert am._pr_is_conflicting(app_config=cfg, pr_number=7) is False


def test_pr_is_conflicting_failsafe_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am

    def _run(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd, "", "boom")

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    assert am._pr_is_conflicting(app_config=cfg, pr_number=7) is False


# --- _reset_branch_for_fresh_rebuild ---------------------------------------


def test_reset_branch_closes_pr_and_wipes_branch(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reset closes the PR with --delete-branch, removes the worktree, and
    deletes the stale LOCAL branch so the next worktree is cut from origin/main."""
    import subprocess

    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am

    calls: list[list] = []

    def _run(cmd, **kw):
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    removed: list[dict] = []

    def _fake_remove(source_repo, **kwargs):
        removed.append(dict(kwargs))
        return True

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    monkeypatch.setattr("factory.app_config.resolve_app_repo_path", lambda cfg, root: factory_root)
    monkeypatch.setattr(
        "factory.chain.worktree.remove_worktree_for_story", _fake_remove, raising=True
    )

    story = _conflict_story(pr_number=321, issue=42, slug="s")
    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    ok = am._reset_branch_for_fresh_rebuild(
        story=story, app_config=cfg, pr_number=321, root=factory_root
    )
    assert ok is True
    # PR closed with --delete-branch.
    assert any(
        c[:3] == ["gh", "pr", "close"] and "321" in c and "--delete-branch" in c for c in calls
    )
    # Stale local branch deleted.
    assert any(c[:3] == ["git", "branch", "-D"] and "factory/story-42-s" in c for c in calls)
    # Worktree removed for the right story.
    assert removed and removed[0]["story_id"] == 42


# --- _handle_pr_conflict_rebuild (orchestrator) ----------------------------


def test_conflict_rebuild_under_cap_redispatches(factory_root: Path) -> None:
    """Case 1: a conflicting PR under the cap is reset to a FRESH branch and
    re-dispatched to dev — PR pointer cleared, state flipped, NOT parked."""
    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=400, issue=50), db)

    reset_calls: list[dict] = []

    def _fake_reset(*, story, app_config, pr_number, root):
        reset_calls.append({"pr_number": pr_number})
        return True

    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    outcome = am._handle_pr_conflict_rebuild(
        story=story,
        app_config=cfg,
        pr_number=400,
        db=db,
        root=factory_root,
        reset_fn=_fake_reset,
    )
    assert outcome == "rebuild_redispatched"
    assert reset_calls == [{"pr_number": 400}]
    reloaded = _reload_story(db, story.id)
    assert reloaded.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert reloaded.github_pr_number is None
    assert reloaded.github_branch is None
    payload = json.loads(reloaded.reviewer_result_json)
    assert payload["source"] == "merge_conflict"
    assert payload["findings"][0]["criterion"] == "merge_conflict"
    assert "conflict_rebuild_redispatch" in _event_types(factory_root, story)


def test_conflict_rebuild_parks_after_cap(factory_root: Path) -> None:
    """Case 2 (unit): once the cap of prior rebuilds is reached, the orchestrator
    returns 'exhausted', logs a deduped conflict_rebuild_exhausted, and leaves
    the story untouched (the caller parks it)."""
    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=401, issue=51), db)
    for _ in range(am._MAX_CONFLICT_REBUILDS):
        log_story_event(
            story.id,
            "conflict_rebuild_redispatch",
            {"pr_number": 401},
            software_factory_root=factory_root,
            slug_hint=story.slug,
        )

    def _fake_reset(**_kwargs):  # must NOT be called once exhausted
        raise AssertionError("reset must not run after the cap")

    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    outcome = am._handle_pr_conflict_rebuild(
        story=story,
        app_config=cfg,
        pr_number=401,
        db=db,
        root=factory_root,
        reset_fn=_fake_reset,
    )
    assert outcome == "exhausted"
    assert "conflict_rebuild_exhausted" in _event_types(factory_root, story)
    reloaded = _reload_story(db, story.id)
    # Untouched — still mergeable + PR intact; the tick performs the actual park.
    assert reloaded.state == StoryState.PR_OPEN.value
    assert reloaded.github_pr_number == 401


def test_conflict_rebuild_persists_before_reset_raises(factory_root: Path) -> None:
    """PERSIST-FIRST / destroy-last: a raising reset seam is swallowed AFTER the
    redispatch intent is already durably persisted → 'rebuild_redispatched', the
    story is redispatched (state flipped, PR pointer cleared), and no work is
    lost. The reset runs LAST, so its failure never reverts the redispatch."""
    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=402, issue=52), db)

    def _boom(**_kwargs):
        raise RuntimeError("reset exploded")

    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
    outcome = am._handle_pr_conflict_rebuild(
        story=story,
        app_config=cfg,
        pr_number=402,
        db=db,
        root=factory_root,
        reset_fn=_boom,
    )
    assert outcome == "rebuild_redispatched"
    reloaded = _reload_story(db, story.id)
    assert reloaded.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert reloaded.github_pr_number is None
    assert "conflict_rebuild_redispatch" in _event_types(factory_root, story)


def test_conflict_rebuild_persist_failure_destroys_nothing(factory_root: Path) -> None:
    """DESTROY-LAST guarantee: if the persist of the redispatch intent fails, the
    destructive reset must NOT run — nothing is closed/deleted — and the result
    is 'failed' so the tick parks a fully-recoverable story (PR + branch intact,
    retryable next tick)."""
    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=403, issue=53), db)

    reset_called: list[bool] = []

    def _record_reset(**_kwargs):
        reset_called.append(True)
        return True

    def _persist_boom(*_a, **_k):
        raise RuntimeError("db write failed")

    # Make ONLY the redispatch persist fail (the one inside _handle_pr_conflict_
    # rebuild). Patch at the handlers module where the function imports it.
    import factory.chain.handlers as _handlers

    orig_persist = _handlers.persist_story
    _handlers.persist_story = _persist_boom
    try:
        cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main")
        outcome = am._handle_pr_conflict_rebuild(
            story=story,
            app_config=cfg,
            pr_number=403,
            db=db,
            root=factory_root,
            reset_fn=_record_reset,
        )
    finally:
        _handlers.persist_story = orig_persist

    assert outcome == "failed"
    # DESTROY-LAST: the reset (which closes the PR + deletes the branch) never ran.
    assert reset_called == []
    # DB row is unchanged — the failed persist wrote nothing.
    assert _reload_story(db, story.id).state == StoryState.PR_OPEN.value
    assert "conflict_rebuild_redispatch" not in _event_types(factory_root, story)


# --- Integration through auto_merge_tick ------------------------------------


def _gh_fake(*, view_status: str, update_branch_ok: bool, record: list | None = None):
    """A subprocess.run stand-in that answers the gh/git calls the conflict path
    makes: ``gh pr view`` (mergeability), ``gh pr update-branch`` (reconcile),
    ``gh pr close`` / ``git branch -D`` (reset), everything else → success."""
    import subprocess as _sp

    def _run(cmd, **kw):
        if record is not None:
            record.append(list(cmd))
        if cmd[:3] == ["gh", "pr", "view"]:
            payload = {
                "state": "OPEN",
                "mergeable": "CONFLICTING" if view_status == "CONFLICTING" else "UNKNOWN",
                "mergeStateStatus": "DIRTY"
                if view_status in ("CONFLICTING", "DIRTY")
                else "BEHIND",
            }
            return _sp.CompletedProcess(cmd, 0, json.dumps(payload), "")
        if cmd[:3] == ["gh", "pr", "update-branch"]:
            if update_branch_ok:
                return _sp.CompletedProcess(cmd, 0, "", "")
            raise _sp.CalledProcessError(1, cmd, "", "merge conflict")
        return _sp.CompletedProcess(cmd, 0, "", "")

    return _run


def _conflict_merge_fn(**_kwargs) -> str:
    """A merge_fn that always reports a merge failure, driving the tick into the
    terminal-unmergeable branch (reason starts with 'gh merge failed')."""
    return "merge conflict"


def test_tick_conflicting_pr_under_cap_is_rebuilt_not_parked(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Case 1 (integration): a CONFLICTING PR whose update-branch reconcile
    fails is re-dispatched to dev on a fresh branch — NOT parked to
    blocked_deploy_failed."""
    import subprocess

    from factory.chain import auto_merge as am
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=500, issue=60), db)

    monkeypatch.setattr(
        subprocess, "run", _gh_fake(view_status="CONFLICTING", update_branch_ok=False), raising=True
    )
    monkeypatch.setattr("factory.app_config.resolve_app_repo_path", lambda cfg, root: factory_root)
    monkeypatch.setattr(
        "factory.chain.worktree.remove_worktree_for_story", lambda *a, **k: True, raising=True
    )

    fixture = FixturePR(
        pr_number=500,
        head_sha="conf-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )
    actions = am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_conflict_merge_fn,
    )
    assert actions[0].merged is False
    reloaded = _reload_story(db, story.id)
    assert reloaded.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert reloaded.state != StoryState.BLOCKED_DEPLOY_FAILED.value
    assert reloaded.github_pr_number is None
    assert "conflict_rebuild_redispatch" in _event_types(factory_root, story)


def test_tick_conflicting_pr_parks_after_cap(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Case 2 (integration): after the rebuild cap is exhausted, a still-
    conflicting PR parks to blocked_deploy_failed."""
    import subprocess

    from factory.chain import auto_merge as am
    from factory.chain.event_log import log_story_event, read_story_events
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=501, issue=61), db)
    # Capture id/slug BEFORE the tick: the park path commits the story object
    # without refreshing it, detaching it from its session (accessing attributes
    # afterward would raise DetachedInstanceError).
    sid, slug = story.id, story.slug
    for _ in range(am._MAX_CONFLICT_REBUILDS):
        log_story_event(
            sid,
            "conflict_rebuild_redispatch",
            {"pr_number": 501},
            software_factory_root=factory_root,
            slug_hint=slug,
        )

    monkeypatch.setattr(
        subprocess, "run", _gh_fake(view_status="CONFLICTING", update_branch_ok=False), raising=True
    )

    fixture = FixturePR(
        pr_number=501,
        head_sha="conf-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )
    am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_conflict_merge_fn,
    )
    reloaded = _reload_story(db, sid)
    assert reloaded.state == StoryState.BLOCKED_DEPLOY_FAILED.value
    assert "conflict_rebuild_exhausted" in [
        e.get("event")
        for e in read_story_events(sid, software_factory_root=factory_root, slug_hint=slug)
    ]


def test_tick_behind_pr_uses_update_branch_not_rebuild(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Case 3 (integration): a branch that update-branch CAN advance (merely
    behind) is recovered via update-branch — the rebuild path is never taken,
    and the story is left in place for re-evaluation."""
    import subprocess

    from factory.chain import auto_merge as am
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=502, issue=62), db)

    monkeypatch.setattr(
        subprocess, "run", _gh_fake(view_status="DIRTY", update_branch_ok=True), raising=True
    )

    fixture = FixturePR(
        pr_number=502,
        head_sha="behind-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )
    am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_conflict_merge_fn,
    )
    reloaded = _reload_story(db, story.id)
    # update-branch recovered it → left in place (still mergeable), NOT rebuilt.
    assert reloaded.state == StoryState.PR_OPEN.value
    assert reloaded.github_pr_number == 502
    types = _event_types(factory_root, story)
    assert "branch_updated" in [
        e.get("result")
        for e in _read_events(factory_root, story)
        if e.get("event") == "auto_merge_reconcile_attempt"
    ]
    assert "conflict_rebuild_redispatch" not in types


def test_tick_conflict_rebuild_reset_failure_still_redispatches(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Case 4 (integration / persist-first): if the fresh-branch reset raises, the
    tick does NOT propagate the error AND does NOT lose the story — because the
    redispatch intent is persisted BEFORE the (best-effort) reset, the story is
    still redispatched to dev, not parked. A partial reset failure is bounded by
    the rebuild cap, never irreversible work loss."""
    import subprocess

    from factory.chain import auto_merge as am
    from factory.chain.event_log import read_story_events
    from factory.chain.handlers import persist_story

    db = factory_root / "state" / "factory.db"
    story = persist_story(_conflict_story(pr_number=503, issue=63), db)
    sid, slug = story.id, story.slug

    monkeypatch.setattr(
        subprocess, "run", _gh_fake(view_status="CONFLICTING", update_branch_ok=False), raising=True
    )

    def _boom(**_kwargs):
        raise RuntimeError("reset exploded mid-tick")

    monkeypatch.setattr(am, "_reset_branch_for_fresh_rebuild", _boom, raising=True)

    fixture = FixturePR(
        pr_number=503,
        head_sha="conf-sha",
        base_branch="main",
        labels=[],
        files_changed=["context/project.md"],
        ci_state="success",
        story=story,
    )
    # Must not raise.
    am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
        merge_fn=_conflict_merge_fn,
    )
    reloaded = _reload_story(db, sid)
    # Persisted BEFORE the raising reset → redispatched, NOT parked, no work lost.
    assert reloaded.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert reloaded.state != StoryState.BLOCKED_DEPLOY_FAILED.value
    assert reloaded.github_pr_number is None
    assert "conflict_rebuild_redispatch" in [
        e.get("event")
        for e in read_story_events(sid, software_factory_root=factory_root, slug_hint=slug)
    ]


# --------------------------------------------------------------------------- #
# Real-git integration for the irreversible reset — no monkeypatched subprocess.
# Proves _reset_branch_for_fresh_rebuild genuinely wipes the stale surfaces so
# the NEXT ensure_worktree_for_story cuts a branch straight off CURRENT
# origin/main (conflict-free). This is the one operation that deletes work, so
# it is exercised against a real repo rather than mocked seams.
# --------------------------------------------------------------------------- #


def _git(args: list[str], cwd: Path, *, check: bool = True):
    import subprocess

    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=check, timeout=60
    )


def test_reset_branch_real_git_yields_fresh_cut_off_current_main(tmp_path: Path) -> None:
    """A story branch cut from an OLDER main that has since advanced with a
    CONFLICTING change is genuinely wiped by ``_reset_branch_for_fresh_rebuild``
    (real git, no mocks): the next ``ensure_worktree_for_story`` cuts a branch
    straight off CURRENT origin/main, conflict-free."""
    from factory.app_config import AppConfig
    from factory.chain import auto_merge as am
    from factory.chain.branch import feature_branch_name
    from factory.chain.worktree import ensure_worktree_for_story

    # 1. Bare origin + source clone; origin/main starts at "v0".
    origin = tmp_path / "origin.git"
    _git(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], tmp_path)
    source = tmp_path / "src"
    source.mkdir()
    _git(["git", "init", "-q", "--initial-branch=main"], source)
    _git(["git", "config", "user.email", "t@e.x"], source)
    _git(["git", "config", "user.name", "T E"], source)
    (source / "data.txt").write_text("v0\n", encoding="utf-8")
    _git(["git", "add", "."], source)
    _git(["git", "commit", "-q", "-m", "init"], source)
    _git(["git", "remote", "add", "origin", str(origin)], source)
    _git(["git", "push", "-u", "-q", "origin", "main"], source)

    # 2. Cut the per-story worktree/branch off origin/main (v0), commit a
    #    divergent change to data.txt.
    root = tmp_path / "sf"
    (root / "state").mkdir(parents=True)
    issue, slug = 77, "conflict-rebuild"
    branch = feature_branch_name(issue, slug)
    wt = ensure_worktree_for_story(
        source,
        software_factory_root=root,
        app="sacrifice",
        story_id=issue,
        slug=slug,
        base_branch="main",
    )
    (Path(wt) / "data.txt").write_text("STORY VERSION\n", encoding="utf-8")
    _git(["git", "add", "data.txt"], wt)
    _git(["git", "commit", "-q", "-m", "story change"], wt)
    stale_head = _git(["git", "rev-parse", "HEAD"], wt).stdout.strip()

    # 3. Advance origin/main with a CONFLICTING change to the SAME file.
    _git(["git", "checkout", "-q", "main"], source)
    (source / "data.txt").write_text("MAIN VERSION\n", encoding="utf-8")
    _git(["git", "add", "data.txt"], source)
    _git(["git", "commit", "-q", "-m", "main change"], source)
    _git(["git", "push", "-q", "origin", "main"], source)

    # Sanity: the stale story branch really DOES conflict with current main.
    _git(["git", "fetch", "-q", "origin", "main"], wt)
    conflict = _git(["git", "merge", "--no-commit", "--no-ff", "origin/main"], wt, check=False)
    assert conflict.returncode != 0
    _git(["git", "merge", "--abort"], wt, check=False)

    # 4. Run the ACTUAL destructive reset. pr_number=0 skips the gh pr close
    #    (no GitHub needed) so this exercises the real worktree + local-branch
    #    wipe — the part that irreversibly deletes work.
    story = StoryRecord(
        direction_id="099",
        app="sacrifice",
        title="t",
        slug=slug,
        scope="docs",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_issue_number=issue,
        github_branch=branch,
    )
    cfg = AppConfig(name="sacrifice", repo="o/r", default_branch="main", app_repo_path=str(source))
    assert (
        am._reset_branch_for_fresh_rebuild(story=story, app_config=cfg, pr_number=0, root=root)
        is True
    )
    # The stale local branch was deleted by the reset.
    assert branch not in _git(["git", "branch", "--list", branch], source).stdout

    # 5. The next worktree cut is FRESH off CURRENT origin/main (conflict-free):
    #    a freshly-cut branch with no commits sits exactly at the current main tip.
    wt2 = ensure_worktree_for_story(
        source,
        software_factory_root=root,
        app="sacrifice",
        story_id=issue,
        slug=slug,
        base_branch="main",
    )
    fresh_head = _git(["git", "rev-parse", "HEAD"], wt2).stdout.strip()
    origin_main = _git(["git", "rev-parse", "origin/main"], source).stdout.strip()
    assert fresh_head == origin_main  # cut from CURRENT main
    assert fresh_head != stale_head  # NOT the old conflicting branch
    # Current main's content is present — no conflict markers, no stale story work.
    assert (Path(wt2) / "data.txt").read_text(encoding="utf-8") == "MAIN VERSION\n"
