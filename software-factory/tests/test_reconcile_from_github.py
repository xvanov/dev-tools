"""``reconcile_from_github`` pulls authoritative GitHub PR state into the DB.

Local ``factory.db`` state is a PROJECTION; GitHub is the system of record for
whether a PR merged, closed, or is still open. The projection drifts (a merge
completed out-of-band while the local story still says ``pr_open``; a PR closed
while the story keeps looping on a dead branch). This pass runs at the TOP of a
tick and reconciles each non-terminal story that has a real PR against GitHub
BEFORE any dispatch decision, logging every reconciliation as a first-class
``state_drift_reconciled`` anomaly.

The ``gh`` shell-out is injected via ``query_pr_state`` so these tests never
touch the network.
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from factory.app_config import AppConfig
from factory.chain.event_log import read_story_events
from factory.chain.handlers import persist_story
from factory.chain.orchestrator import reconcile_from_github
from factory.chain.state_machine import (
    EVENT_DEPLOY_SUCCEEDED,
    StoryRecord,
    StoryState,
    advance,
)

_CFG = AppConfig(name="sacrifice", repo="acme/sacrifice")


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _story(
    db: Path,
    *,
    state: str,
    slug: str,
    pr_number: int | None = 42,
) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="t",
            slug=slug,
            scope="backend",
            state=state,
            github_pr_number=pr_number,
            github_branch=f"factory/{slug}",
        ),
        db,
    )


def _reload(db: Path, story_id: int | None) -> StoryRecord:
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return ses.exec(select(StoryRecord).where(StoryRecord.id == story_id)).one()


def _fixed_state(value: str | None):
    """A ``query_pr_state`` stub that always returns ``value``."""

    def _q(*, app_config: AppConfig, pr_number: int) -> str | None:
        return value

    return _q


def _git_events(tmp_path: Path) -> list[dict]:
    path = tmp_path / "state" / "events" / "git.ndjson"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _drift_events(tmp_path: Path) -> list[dict]:
    return [e for e in _git_events(tmp_path) if e.get("event") == "state_drift_reconciled"]


# --------------------------------------------------------------------------- #
# Drift case: PR MERGED on GitHub but local state pre-merge
# --------------------------------------------------------------------------- #


def test_merged_on_github_advances_local_to_deploy_pending(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="merged")

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    assert out == [("merged", StoryState.PR_OPEN.value, StoryState.DEPLOY_PENDING.value)]
    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value

    # First-class drift anomaly on the git stream (an L1 watcher _RAW_STREAM).
    drift = _drift_events(tmp_path)
    assert len(drift) == 1
    ev = drift[0]
    assert ev["story_id"] == s.id
    assert ev["local_state_before"] == StoryState.PR_OPEN.value
    assert ev["authoritative_pr_state"] == "MERGED"
    assert ev["action"] == f"advanced_to:{StoryState.DEPLOY_PENDING.value}"
    assert ev["pr_number"] == 42

    # And on the per-story timeline.
    story_events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    assert [e for e in story_events if e.get("event") == "state_drift_reconciled"]


def test_merged_advances_from_ci_green_and_ready_for_merge(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    a = _story(db, state=StoryState.CI_GREEN.value, slug="cg", pr_number=7)
    b = _story(db, state=StoryState.READY_FOR_MERGE.value, slug="rfm", pr_number=8)

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    to_states = {slug: to for slug, _, to in out}
    assert to_states == {
        "cg": StoryState.DEPLOY_PENDING.value,
        "rfm": StoryState.DEPLOY_PENDING.value,
    }
    assert _reload(db, a.id).state == StoryState.DEPLOY_PENDING.value
    assert _reload(db, b.id).state == StoryState.DEPLOY_PENDING.value


# --------------------------------------------------------------------------- #
# Drift case: PR CLOSED (not merged) on GitHub
# --------------------------------------------------------------------------- #


def test_closed_on_github_moves_story_to_attention_state(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="closed")

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("CLOSED"),
    )

    assert out == [("closed", StoryState.PR_OPEN.value, StoryState.BLOCKED_DEPLOY_FAILED.value)]
    r = _reload(db, s.id)
    assert r.state == StoryState.BLOCKED_DEPLOY_FAILED.value
    assert r.error and "CLOSED on GitHub" in r.error

    drift = _drift_events(tmp_path)
    assert len(drift) == 1
    assert drift[0]["authoritative_pr_state"] == "CLOSED"
    assert drift[0]["action"] == f"advanced_to:{StoryState.BLOCKED_DEPLOY_FAILED.value}"


# --------------------------------------------------------------------------- #
# No-op cases
# --------------------------------------------------------------------------- #


def test_open_pr_is_noop_no_event(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="open")

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("OPEN"),
    )

    assert out == []
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value
    assert _drift_events(tmp_path) == []


def test_gh_query_failure_is_failsafe_noop(tmp_path: Path) -> None:
    """A gh query returning None (gh missing / timeout / unresolvable) must NOT
    advance the story — never reconcile on uncertainty — and must not crash."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="unknown")

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state(None),
    )

    assert out == []
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value  # untouched
    assert _drift_events(tmp_path) == []


def test_terminal_and_no_pr_stories_are_skipped(tmp_path: Path) -> None:
    """Only non-terminal stories in a mergeable state WITH a real PR are
    candidates. A deployed (terminal) story and a mergeable story lacking a PR
    number must never be queried or advanced."""
    db = _seed(tmp_path)
    terminal = _story(db, state=StoryState.DEPLOYED.value, slug="done", pr_number=99)
    no_pr = _story(db, state=StoryState.PR_OPEN.value, slug="nopr", pr_number=None)
    placeholder = _story(db, state=StoryState.PR_OPEN.value, slug="ph", pr_number=0)

    calls: list[int] = []

    def _tracking_q(*, app_config: AppConfig, pr_number: int) -> str | None:
        calls.append(pr_number)
        return "MERGED"

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_tracking_q,
    )

    assert out == []
    assert calls == []  # none of the three were queried
    assert _reload(db, terminal.id).state == StoryState.DEPLOYED.value
    assert _reload(db, no_pr.id).state == StoryState.PR_OPEN.value
    assert _reload(db, placeholder.id).state == StoryState.PR_OPEN.value


# --------------------------------------------------------------------------- #
# Idempotency + bounding
# --------------------------------------------------------------------------- #


def test_reconcile_is_idempotent(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="idem")

    first = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )
    assert first  # advanced once

    # Re-run: the story is now in DEPLOY_PENDING (not a mergeable candidate),
    # so nothing is queried and no new event is emitted.
    second = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )
    assert second == []
    assert len(_drift_events(tmp_path)) == 1  # still only the first event
    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value


# --------------------------------------------------------------------------- #
# Reconcile is now the PRIMARY detector of the real (async) merge: it must also
# record a merged=True merge-action row and enqueue the deploy, else a merge
# that lands between ticks advances the story to deploy_pending but nothing ever
# deploys it.
# --------------------------------------------------------------------------- #


def _merged_rows(db: Path) -> list:
    from factory.chain.auto_merge import MergeActionRecord

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return list(
            ses.exec(select(MergeActionRecord).where(MergeActionRecord.merged == True))  # noqa: E712
        )


def _deploy_queue(db: Path) -> list:
    from factory.deploy.models import DeployQueueEntry

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return list(ses.exec(select(DeployQueueEntry)))


def test_merged_records_merge_action_and_enqueues_deploy(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="ship")

    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value
    # A merged=True merge-action row was recorded for this story's head sha, so
    # deploy._latest_undeployed_sha will pick it up.
    merged = _merged_rows(db)
    assert [r.head_sha for r in merged] == [f"local-{s.id}"]
    assert merged[0].pr_number == 42
    # And a deploy was enqueued for that same sha.
    q = _deploy_queue(db)
    assert [e.sha for e in q] == [f"local-{s.id}"]
    assert q[0].merged_pr_number == 42


def test_open_pr_records_no_merge_and_no_deploy(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, state=StoryState.PR_OPEN.value, slug="stillopen")

    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("OPEN"),
    )

    assert _merged_rows(db) == []
    assert _deploy_queue(db) == []


def test_merged_record_and_enqueue_is_idempotent(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="idem-ship")

    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )
    # Re-run: the story already left the mergeable states, so it is no longer a
    # candidate — no duplicate merge row, no duplicate deploy.
    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    assert len(_merged_rows(db)) == 1
    assert len(_deploy_queue(db)) == 1
    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value


def test_closed_pr_records_no_merge_and_no_deploy(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, state=StoryState.PR_OPEN.value, slug="dead")

    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("CLOSED"),
    )

    # CLOSED (not merged) → attention state, never a deploy.
    assert _merged_rows(db) == []
    assert _deploy_queue(db) == []


def test_reconcile_is_bounded_per_tick(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    for i in range(5):
        _story(db, state=StoryState.PR_OPEN.value, slug=f"s{i}", pr_number=100 + i)

    calls: list[int] = []

    def _tracking_q(*, app_config: AppConfig, pr_number: int) -> str | None:
        calls.append(pr_number)
        return "OPEN"  # no-op action, we only care about the call count

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_tracking_q,
        max_reconcile=2,
    )

    assert out == []
    assert len(calls) == 2  # capped — the other 3 wait for a later tick


# --------------------------------------------------------------------------- #
# Part 1 — reconcile runs the dual-draft sibling cleanup on a detected merge.
#
# Because fix A routes the real async ``gh pr merge --auto`` merge through
# RECONCILE (auto-merge only ENABLES auto-merge, returning merged=False),
# reconcile is the PRIMARY detector of the winner's merge for ``--auto`` PRs. It
# must therefore supersede the losing dual-draft sibling exactly like the
# auto-merge worker's own merged path does — else the loser proceeds to a
# redundant second merge (the dual-draft over-fire #70 meant to fix).
# --------------------------------------------------------------------------- #


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


class _RunResult:
    returncode = 0
    stdout = ""
    stderr = ""


class _Runner:
    """Recording stand-in for ``subprocess.run`` — captures every ``gh pr
    close`` argv so the test asserts the loser's PR was closed without a real gh."""

    def __init__(self) -> None:
        self.calls: list[list] = []

    def __call__(self, argv: list, **kwargs) -> _RunResult:
        self.calls.append(list(argv))
        return _RunResult()


def _dual_pair(db: Path) -> tuple[StoryRecord, StoryRecord]:
    """Winner (``-alt-a``, PR 555) + loser (``-alt-b``, PR 556), same direction."""
    winner = persist_story(
        StoryRecord(
            direction_id="008",
            app="sacrifice",
            title="w",
            slug="dd-topic-alt-a",
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_issue_number=209,
            github_pr_number=555,
            github_branch="factory/dd-topic-alt-a",
        ),
        db,
    )
    loser = persist_story(
        StoryRecord(
            direction_id="008",
            app="sacrifice",
            title="l",
            slug="dd-topic-alt-b",
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_issue_number=210,
            github_pr_number=556,
            github_branch="factory/dd-topic-alt-b",
        ),
        db,
    )
    return winner, loser


def _per_pr_state(mapping: dict[int, str]):
    """A ``query_pr_state`` stub keyed by pr_number (default OPEN)."""

    def _q(*, app_config: AppConfig, pr_number: int) -> str | None:
        return mapping.get(pr_number, "OPEN")

    return _q


def test_reconcile_merge_supersedes_losing_dual_draft_sibling(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    winner, loser = _dual_pair(db)

    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))
    runner = _Runner()

    # Only the winner's PR (555) is MERGED on GitHub; the loser's (556) is still
    # OPEN, so reconcile does NOT advance the loser itself — the supersede must
    # come from the Part-1 sibling cleanup, not reconcile's own EVENT_MERGED.
    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({555: "MERGED"}),
        github_client_factory=lambda: client,
        sibling_cleanup_runner=runner,
    )

    # Winner advanced to deploy_pending; loser terminally superseded.
    assert (winner.slug, StoryState.PR_OPEN.value, StoryState.DEPLOY_PENDING.value) in out
    assert _reload(db, winner.id).state == StoryState.DEPLOY_PENDING.value
    assert _reload(db, loser.id).state == StoryState.SUPERSEDED_BY_SIBLING.value
    # Loser's PR (556) was closed via gh, and its issue (210) was closed.
    assert any("556" in argv and "--delete-branch" in argv for argv in runner.calls)
    assert sibling_issue.state == "closed"
    assert sibling_issue.close_reason == "not_planned"


def test_reconcile_loser_pr_closed_midloop_is_not_clobbered(tmp_path: Path) -> None:
    """Regression (adversarial review 2026-07-21): the winner is ordered before
    the loser in the reconcile ``candidates`` snapshot; the winner's Part-1
    cleanup closes the loser's PR + supersedes it. When the loop then reaches
    the loser, its (now CLOSED) PR must NOT drive EVENT_PR_UNMERGEABLE ->
    BLOCKED_DEPLOY_FAILED, clobbering the SUPERSEDED_BY_SIBLING just written.
    The loop re-reads the live state and skips the already-terminal loser."""
    db = _seed(tmp_path)
    winner, loser = _dual_pair(db)

    client = _Client(_Repo({209: _Issue(209), 210: _Issue(210)}))
    runner = _Runner()

    # Winner MERGED; loser's PR reports CLOSED (the cleanup just closed it) —
    # exactly the stale-snapshot ordering that caused the clobber.
    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({555: "MERGED", 556: "CLOSED"}),
        github_client_factory=lambda: client,
        sibling_cleanup_runner=runner,
    )

    assert _reload(db, winner.id).state == StoryState.DEPLOY_PENDING.value
    # The loser is SUPERSEDED (by the cleanup), NOT the false BLOCKED_DEPLOY_FAILED.
    assert _reload(db, loser.id).state == StoryState.SUPERSEDED_BY_SIBLING.value


def test_reconcile_merge_non_dual_draft_never_builds_client(tmp_path: Path) -> None:
    """A normal (non-``-alt-*``) merge must NOT build a GitHub client or touch a
    sibling — the winner just advances to deploy_pending as before."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.PR_OPEN.value, slug="ordinary", pr_number=42)

    built: list[int] = []

    def _factory():
        built.append(1)
        raise AssertionError("client should not be built for a non-dual-draft merge")

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
        github_client_factory=_factory,
    )

    assert out == [("ordinary", StoryState.PR_OPEN.value, StoryState.DEPLOY_PENDING.value)]
    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value
    assert built == []  # short-circuited before building a client


def test_reconcile_merge_winner_never_self_superseded(tmp_path: Path) -> None:
    """The winning dual-draft story (the one whose PR merged) advances to
    deploy_pending and is NEVER itself superseded."""
    db = _seed(tmp_path)
    winner, loser = _dual_pair(db)
    client = _Client(_Repo({209: _Issue(209), 210: _Issue(210)}))

    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({555: "MERGED"}),
        github_client_factory=lambda: client,
        sibling_cleanup_runner=_Runner(),
    )

    assert _reload(db, winner.id).state == StoryState.DEPLOY_PENDING.value


def test_reconcile_sibling_cleanup_failure_never_breaks_reconcile(tmp_path: Path) -> None:
    """A client-build blowup during the sibling cleanup must be swallowed — the
    winner's own reconcile (advance + deploy enqueue) still completes."""
    db = _seed(tmp_path)
    winner, loser = _dual_pair(db)

    def _boom_factory():
        raise RuntimeError("token resolution exploded")

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({555: "MERGED"}),
        github_client_factory=_boom_factory,
    )

    # Winner still advanced despite the cleanup failure.
    assert (winner.slug, StoryState.PR_OPEN.value, StoryState.DEPLOY_PENDING.value) in out
    assert _reload(db, winner.id).state == StoryState.DEPLOY_PENDING.value
    # Loser untouched (cleanup could not run) — Part 2 self-check is the backstop.
    assert _reload(db, loser.id).state == StoryState.PR_OPEN.value


# --------------------------------------------------------------------------- #
# G2 broadening: a merged PR on a NON-mergeable, non-terminal state
# --------------------------------------------------------------------------- #


def test_merged_advances_from_reviewer_requested_changes(tmp_path: Path) -> None:
    """A PR merged out-of-band while the story had bounced to
    REVIEWER_REQUESTED_CHANGES (e.g. after a CI-failure re-dispatch) must still
    be detected and routed to DEPLOY_PENDING — there is no EVENT_MERGED edge
    from that state, so reconcile FORCES DEPLOY_PENDING (a merged PR is ground
    truth). This is the story-136 stuck-winner case (G2)."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.REVIEWER_REQUESTED_CHANGES.value, slug="stuck", pr_number=99)

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    assert out == [
        ("stuck", StoryState.REVIEWER_REQUESTED_CHANGES.value, StoryState.DEPLOY_PENDING.value)
    ]
    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value


def test_merged_advances_from_dev_in_progress(tmp_path: Path) -> None:
    """Same, from DEV_IN_PROGRESS (story 132's shape: CI-failed, re-dispatched
    to dev, PR merged out-of-band). Forced to DEPLOY_PENDING."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.DEV_IN_PROGRESS.value, slug="devmerged", pr_number=101)

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    assert _reload(db, s.id).state == StoryState.DEPLOY_PENDING.value
    assert out and out[0][2] == StoryState.DEPLOY_PENDING.value


def test_closed_pr_on_dev_in_progress_is_noop(tmp_path: Path) -> None:
    """A CLOSED (not merged) PR on an in-DEV story is NORMAL churn — the story
    will open a fresh PR — so it must NOT be sunk to BLOCKED_DEPLOY_FAILED. Only
    a CLOSED PR on a MERGEABLE (open-PR) state sinks to attention."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.DEV_IN_PROGRESS.value, slug="devchurn", pr_number=77)

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("CLOSED"),
    )

    assert out == []  # no drift recorded
    assert _reload(db, s.id).state == StoryState.DEV_IN_PROGRESS.value  # untouched


def test_terminal_story_with_pr_is_never_reconsidered(tmp_path: Path) -> None:
    """A terminal story (already DEPLOYED / SUPERSEDED) that still carries a PR
    number is not a candidate — reconcile never queries or mutates it."""
    db = _seed(tmp_path)
    d = _story(db, state=StoryState.DEPLOYED.value, slug="done", pr_number=88)
    sup = _story(db, state=StoryState.SUPERSEDED_BY_SIBLING.value, slug="sup", pr_number=89)

    calls: list[int] = []

    def _spy(*, app_config: AppConfig, pr_number: int) -> str | None:
        calls.append(pr_number)
        return "MERGED"

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_spy,
    )

    assert out == []
    assert calls == []  # neither terminal story was queried
    assert _reload(db, d.id).state == StoryState.DEPLOYED.value
    assert _reload(db, sup.id).state == StoryState.SUPERSEDED_BY_SIBLING.value


# --------------------------------------------------------------------------- #
# D013: blocked_ci_unresolved reconciliation
# --------------------------------------------------------------------------- #


def test_blocked_ci_unresolved_merged_pr_revives_to_deploy_pending(
    tmp_path: Path,
) -> None:
    """D013 AC2.1-AC2.4: A ``blocked_ci_unresolved`` story whose PR was merged
    out-of-band advances to ``deploy_pending`` via the same reconciled-merge path
    as normal mergeable states. Includes merge-action persistence and deploy
    enqueue side effects."""
    from factory.chain.auto_merge import _MERGEABLE_STATES

    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_CI_UNRESOLVED.value, slug="ci-revived", pr_number=99)

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("MERGED"),
    )

    assert out == [
        ("ci-revived", StoryState.BLOCKED_CI_UNRESOLVED.value, StoryState.DEPLOY_PENDING.value)
    ]
    r = _reload(db, s.id)
    assert r.state == StoryState.DEPLOY_PENDING.value

    # Drift event logged (AC5.1).
    drift = _drift_events(tmp_path)
    assert len(drift) >= 1
    ev = drift[0]
    assert ev["local_state_before"] == StoryState.BLOCKED_CI_UNRESOLVED.value
    assert ev["authoritative_pr_state"] == "MERGED"
    assert ev["action"] == f"advanced_to:{StoryState.DEPLOY_PENDING.value}"

    # Per-story event log (AC5.2).
    story_events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    assert [e for e in story_events if e.get("event") == "state_drift_reconciled"]

    # Merge-action row persisted (AC2.2).
    from sqlmodel import Session, select

    from factory.chain.auto_merge import MergeActionRecord

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        rows = ses.exec(select(MergeActionRecord).where(MergeActionRecord.pr_number == 99)).all()
    assert len(rows) >= 1
    assert any(row.merged is True for row in rows)

    # Deploy enqueued (AC2.3): a DeployQueueEntry row exists for this PR.
    from sqlmodel import Session, select

    from factory.deploy.orchestrator import DeployQueueEntry

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        queue_rows = ses.exec(
            select(DeployQueueEntry).where(DeployQueueEntry.merged_pr_number == 99)
        ).all()
    assert len(queue_rows) >= 1

    # blocked_ci_unresolved is NOT in _MERGEABLE_STATES — the revival is driven
    # by the candidate selection expansion, not by adding the state to mergeable.
    assert StoryState.BLOCKED_CI_UNRESOLVED.value not in _MERGEABLE_STATES


def test_blocked_ci_unresolved_closed_unmerged_stays_blocked(
    tmp_path: Path,
) -> None:
    """D013 AC3.1: A ``blocked_ci_unresolved`` story whose PR is CLOSED (not
    merged) stays blocked — no state change, no drift event, no time-based
    revival."""
    db = _seed(tmp_path)
    s = _story(
        db, state=StoryState.BLOCKED_CI_UNRESOLVED.value, slug="stays-blocked", pr_number=200
    )

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("CLOSED"),
    )

    assert out == []  # no drift, no-op
    r = _reload(db, s.id)
    assert r.state == StoryState.BLOCKED_CI_UNRESOLVED.value
    # No drift events logged for closed-unmerged blocked story.
    assert _drift_events(tmp_path) == []


def test_blocked_ci_unresolved_open_pr_is_noop(tmp_path: Path) -> None:
    """A ``blocked_ci_unresolved`` story with an OPEN PR (operator re-opened it
    but hasn't merged yet) is a no-op — reconcile should not advance."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_CI_UNRESOLVED.value, slug="reopened", pr_number=150)

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_fixed_state("OPEN"),
    )

    assert out == []
    assert _reload(db, s.id).state == StoryState.BLOCKED_CI_UNRESOLVED.value
    assert _drift_events(tmp_path) == []


def test_blocked_ci_unresolved_revives_dependents(
    tmp_path: Path,
) -> None:
    """D013 AC4.1: When a ``blocked_ci_unresolved`` story is revived by
    reconcile, a dependent parked in ``blocked_dependency_unmet`` because this
    blocker was dead must be re-evaluated and moved back to ``story_created``."""
    db = _seed(tmp_path)

    # Blocker (lower ID) in blocked_ci_unresolved with a PR.
    blocker = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="blocker",
            slug="blocker",
            scope="backend",
            state=StoryState.BLOCKED_CI_UNRESOLVED.value,
            github_pr_number=300,
            github_branch="factory/blocker",
        ),
        db,
    )

    # Dependent (higher ID) in blocked_dependency_unmet — parked because blocker
    # was dead.
    dependent = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="dependent",
            slug="dependent",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            github_pr_number=None,
            github_branch="factory/dependent",
        ),
        db,
    )

    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({300: "MERGED"}),
    )

    # Blocker revived.
    assert (
        blocker.slug,
        StoryState.BLOCKED_CI_UNRESOLVED.value,
        StoryState.DEPLOY_PENDING.value,
    ) in out
    assert _reload(db, blocker.id).state == StoryState.DEPLOY_PENDING.value

    # Dependent revived — moved from blocked_dependency_unmet back to story_created.
    dep_reloaded = _reload(db, dependent.id)
    assert dep_reloaded.state == StoryState.STORY_CREATED.value
    assert dep_reloaded.error is None

    # Drift events for both.
    drift = _drift_events(tmp_path)
    actions = {e["action"] for e in drift}
    assert "dependent_revived:blocker_1_no_longer_dead" in actions
    assert f"advanced_to:{StoryState.DEPLOY_PENDING.value}" in actions

    # AC2.2: A merged=True merge-action row was recorded for the revived blocker.
    merged = _merged_rows(db)
    assert [r.head_sha for r in merged] == [f"local-{blocker.id}"]
    assert merged[0].pr_number == 300

    # AC2.3: A deploy was enqueued for the revived blocker.
    q = _deploy_queue(db)
    assert [e.sha for e in q] == [f"local-{blocker.id}"]
    assert q[0].merged_pr_number == 300


def test_blocked_ci_unresolved_does_not_revive_when_other_blocker_still_dead(
    tmp_path: Path,
) -> None:
    """D013 AC4.1 edge case: A dependent in ``blocked_dependency_unmet`` that
    still has another dead-end blocker (not revived) stays parked. Only when ALL
    blockers are non-dead does it become dispatchable."""
    db = _seed(tmp_path)

    # Two blockers in the same direction (IDs 1 and 2), both dead-end.
    blocker1 = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="blocker1",
            slug="blocker1",
            scope="backend",
            state=StoryState.BLOCKED_CI_UNRESOLVED.value,
            github_pr_number=400,
            github_branch="factory/blocker1",
        ),
        db,
    )
    blocker2 = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="blocker2",
            slug="blocker2",
            scope="backend",
            state=StoryState.BLOCKED_CI_UNRESOLVED.value,
            github_pr_number=401,
            github_branch="factory/blocker2",
        ),
        db,
    )

    # Dependent (ID 3) in blocked_dependency_unmet. Both blockers (IDs 1 and 2)
    # are dead-end states. Only blocker1's PR is merged — blocker2 stays blocked.
    dependent = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="dependent",
            slug="dependent",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            github_pr_number=None,
            github_branch="factory/dependent",
        ),
        db,
    )

    reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({400: "MERGED", 401: "CLOSED"}),
    )

    # Blocker1 revived.
    assert _reload(db, blocker1.id).state == StoryState.DEPLOY_PENDING.value
    # Blocker2 stays blocked (CLOSED-unmerged).
    assert _reload(db, blocker2.id).state == StoryState.BLOCKED_CI_UNRESOLVED.value
    # Dependent stays parked — blocker2 is still a dead end.
    assert _reload(db, dependent.id).state == StoryState.BLOCKED_DEPENDENCY_UNMET.value


def test_full_path_block_ci_merge_revive_dependent(
    tmp_path: Path,
) -> None:
    """D013 AC6.1-AC6.2: Full-path regression test. Block a story on CI, merge
    its PR out of band, run reconcile, and observe ``deploy_pending`` plus an
    unblocked dependent."""
    db = _seed(tmp_path)

    # Blocker — simulate CI-exhaustion resulting in blocked_ci_unresolved with a
    # PR that the operator subsequently merges out of band.
    blocker = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="blocker",
            slug="full-path-blocker",
            scope="backend",
            state=StoryState.BLOCKED_CI_UNRESOLVED.value,
            github_pr_number=500,
            github_branch="factory/full-path-blocker",
            error="dev exhausted retries (6): identical CI failure",
        ),
        db,
    )

    # Dependent — parked because the blocker was in a dead-end sink.
    dependent = persist_story(
        StoryRecord(
            direction_id="099",
            app="sacrifice",
            title="dependent",
            slug="full-path-dependent",
            scope="backend",
            state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            github_pr_number=None,
            github_branch="factory/full-path-dependent",
        ),
        db,
    )

    # The operator merges the blocker's PR out of band. reconcile detects it.
    out = reconcile_from_github(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_pr_state=_per_pr_state({500: "MERGED"}),
    )

    # AC6.1: Blocker in deploy_pending.
    assert (
        blocker.slug,
        StoryState.BLOCKED_CI_UNRESOLVED.value,
        StoryState.DEPLOY_PENDING.value,
    ) in out
    assert _reload(db, blocker.id).state == StoryState.DEPLOY_PENDING.value

    # AC6.2: The dependent is dispatchable again after the blocker proceeds to
    # deployed on the normal path.
    blocker_after_reconcile = _reload(db, blocker.id)
    blocker_after_reconcile.state = advance(blocker_after_reconcile, EVENT_DEPLOY_SUCCEEDED).value
    persist_story(blocker_after_reconcile, db)
    assert _reload(db, blocker.id).state == StoryState.DEPLOYED.value

    dep = _reload(db, dependent.id)
    assert dep.state == StoryState.STORY_CREATED.value
    assert dep.error is None

    # AC5.1: Drift events logged for the revival — both the blocker advance and
    # the dependent revival are represented in the anomaly stream.
    drift = _drift_events(tmp_path)
    drift_actions = {e["action"] for e in drift}
    assert f"advanced_to:{StoryState.DEPLOY_PENDING.value}" in drift_actions
    assert f"dependent_revived:blocker_{blocker.id}_no_longer_dead" in drift_actions
    # Verify the event payload carries the expected fields.
    blocker_drift = [
        e for e in drift if e["action"] == f"advanced_to:{StoryState.DEPLOY_PENDING.value}"
    ][0]
    assert blocker_drift["story_id"] == blocker.id
    assert blocker_drift["local_state_before"] == StoryState.BLOCKED_CI_UNRESOLVED.value
    assert blocker_drift["authoritative_pr_state"] == "MERGED"
    assert blocker_drift["pr_number"] == 500

    # AC2.2: A merged=True merge-action row was recorded for the revived blocker.
    merged = _merged_rows(db)
    assert [r.head_sha for r in merged] == [f"local-{blocker.id}"]
    assert merged[0].pr_number == 500

    # AC2.3: Deploy enqueued for blocker.
    q = _deploy_queue(db)
    assert [e.sha for e in q] == [f"local-{blocker.id}"]
    assert q[0].merged_pr_number == 500
