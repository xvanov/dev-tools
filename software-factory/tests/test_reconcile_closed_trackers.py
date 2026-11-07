"""``reconcile_closed_trackers`` settles pending-human stories the operator closed.

GitHub is the system of record for whether work is still WANTED, not just for PR
state. The four ``_PENDING_HUMAN_STATES`` are deliberately excluded from the
resolved-states allowlist because an operator may revive them — so when the
operator instead closes the tracker ISSUE, the two views disagree permanently and
the factory keeps listing a story as awaiting a human who has already ruled.

Observed 2026-07-24: stories 81 and 130 sat 5.1 days / 24.8h in the operator inbox
with tracker issues #267/#337 closed days earlier and zero open PRs or issues on
either repo.

The ``gh`` shell-out is injected via ``query_issue_state`` so these tests never
touch the network.
"""

from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from factory.app_config import AppConfig
from factory.chain.handlers import persist_story
from factory.chain.orchestrator import _PENDING_HUMAN_STATES, reconcile_closed_trackers
from factory.chain.state_machine import StoryRecord, StoryState

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
    issue_number: int | None = 267,
) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id="092", app="sacrifice", title="t", slug=slug,
            scope="backend", state=state, github_issue_number=issue_number,
        ),
        db,
    )


def _reload(db: Path, story_id: int | None) -> StoryRecord:
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return ses.exec(select(StoryRecord).where(StoryRecord.id == story_id)).one()


def _fixed(value: str | None):
    calls: list[int] = []

    def _q(*, app_config: AppConfig, issue_number: int) -> str | None:
        calls.append(issue_number)
        return value

    return _q, calls


# --------------------------------------------------------------------------- #
# The drift case
# --------------------------------------------------------------------------- #


def test_closed_issue_settles_blocked_deploy_failed(tmp_path: Path) -> None:
    """Story 81's exact shape."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="verify-deploy")
    q, calls = _fixed("CLOSED")

    out = reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    )

    assert out == [
        ("verify-deploy", StoryState.BLOCKED_DEPLOY_FAILED.value, StoryState.CLOSED_BY_OPERATOR.value)
    ]
    assert calls == [267]
    row = _reload(db, s.id)
    assert row.state == StoryState.CLOSED_BY_OPERATOR.value
    assert "#267" in (row.error or "")
    assert "Re-open the issue" in (row.error or ""), "must tell the operator how to revive"


def test_closed_issue_settles_budget_exceeded(tmp_path: Path) -> None:
    """Story 130's exact shape."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_BUDGET_EXCEEDED.value, slug="fix-lint", issue_number=337)
    q, _ = _fixed("CLOSED")
    reconcile_closed_trackers(db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q)
    assert _reload(db, s.id).state == StoryState.CLOSED_BY_OPERATOR.value


def test_every_pending_human_state_is_settleable(tmp_path: Path) -> None:
    """Guards the set from drifting out of sync with the states it names."""
    db = _seed(tmp_path)
    ids = {
        st: _story(db, state=st, slug=f"s-{st}").id for st in sorted(_PENDING_HUMAN_STATES)
    }
    q, _ = _fixed("CLOSED")
    out = reconcile_closed_trackers(db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q)

    assert len(out) == len(_PENDING_HUMAN_STATES)
    for st, sid in ids.items():
        assert _reload(db, sid).state == StoryState.CLOSED_BY_OPERATOR.value, st


# --------------------------------------------------------------------------- #
# Fail-safe posture
# --------------------------------------------------------------------------- #


def test_open_issue_is_a_noop(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="still-wanted")
    q, _ = _fixed("OPEN")
    assert reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    ) == []
    assert _reload(db, s.id).state == StoryState.BLOCKED_DEPLOY_FAILED.value


def test_unknown_issue_state_is_a_noop(tmp_path: Path) -> None:
    """A gh outage must never mass-close the backlog."""
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="gh-down")
    q, _ = _fixed(None)
    assert reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    ) == []
    assert _reload(db, s.id).state == StoryState.BLOCKED_DEPLOY_FAILED.value


def test_non_pending_human_states_are_never_touched(tmp_path: Path) -> None:
    """Live and already-terminal stories are out of scope even with a closed issue."""
    db = _seed(tmp_path)
    live = _story(db, state=StoryState.DEV_IN_PROGRESS.value, slug="working")
    done = _story(db, state=StoryState.DEPLOYED.value, slug="shipped")
    gone = _story(db, state=StoryState.SUPERSEDED_BY_SIBLING.value, slug="loser")
    q, calls = _fixed("CLOSED")

    assert reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    ) == []
    assert calls == [], "must not spend gh calls on out-of-scope rows"
    assert _reload(db, live.id).state == StoryState.DEV_IN_PROGRESS.value
    assert _reload(db, done.id).state == StoryState.DEPLOYED.value
    assert _reload(db, gone.id).state == StoryState.SUPERSEDED_BY_SIBLING.value


def test_story_without_tracker_issue_is_skipped(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="no-issue", issue_number=None)
    q, calls = _fixed("CLOSED")
    assert reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    ) == []
    assert calls == []
    assert _reload(db, s.id).state == StoryState.BLOCKED_DEPLOY_FAILED.value


def test_other_apps_are_not_touched(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    persist_story(
        StoryRecord(
            direction_id="001", app="factory", title="t", slug="other-app",
            scope="backend", state=StoryState.BLOCKED_DEPLOY_FAILED.value,
            github_issue_number=999,
        ),
        db,
    )
    q, calls = _fixed("CLOSED")
    assert reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    ) == []
    assert calls == []


# --------------------------------------------------------------------------- #
# Idempotency + bounding
# --------------------------------------------------------------------------- #


def test_second_run_is_a_pure_noop(tmp_path: Path) -> None:
    """A settled row leaves the candidate set, so a consistent DB mutates nothing."""
    db = _seed(tmp_path)
    _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="once")
    q, calls = _fixed("CLOSED")

    first = reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    )
    second = reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q
    )
    assert len(first) == 1
    assert second == []
    assert len(calls) == 1, "second pass must not re-query gh"


def test_bounded_by_max_reconcile(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    for i in range(5):
        _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug=f"s{i}", issue_number=100 + i)
    q, calls = _fixed("CLOSED")

    out = reconcile_closed_trackers(
        db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q, max_reconcile=2
    )
    assert len(out) == 2
    assert len(calls) == 2


def test_settled_state_is_terminal_and_not_dispatchable(tmp_path: Path) -> None:
    """The whole point: the chain must stop driving a settled row."""
    from factory.chain.state_machine import is_terminal

    db = _seed(tmp_path)
    s = _story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="settled")
    q, _ = _fixed("CLOSED")
    reconcile_closed_trackers(db, "sacrifice", cfg=_CFG, root=tmp_path, query_issue_state=q)

    assert is_terminal(StoryState(_reload(db, s.id).state))
