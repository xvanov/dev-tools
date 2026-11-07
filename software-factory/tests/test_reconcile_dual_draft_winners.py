"""``reconcile_dual_draft_winners`` — the STANDING dual-draft loser supersede.

``close_abandoned_draft_sibling`` only fires the single tick a winner's merge is
first detected. If the losing sibling was mid-dispatch that exact tick (or the
winner shipped via a path that skipped the cleanup), the loser is stranded — and
once the winner is terminal (``deployed``) it leaves ``reconcile_from_github``'s
candidate set, so no later tick retries the supersede (G2: stories 133/137).

This pass re-derives the supersede from ground truth EVERY tick: any dual-draft
group with a shipped sibling (``DEPLOYED`` / ``DEPLOY_PENDING``) has its
still-in-flight siblings superseded. Idempotent and fail-safe. The DB supersede
runs without a GitHub token, so these tests inject a ``None`` client factory.
"""

from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from factory.app_config import AppConfig
from factory.chain.handlers import persist_story
from factory.chain.orchestrator import reconcile_dual_draft_winners
from factory.chain.state_machine import StoryRecord, StoryState

_CFG = AppConfig(name="sacrifice", repo="acme/sacrifice")


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _story(
    db: Path, *, direction_id: str, slug: str, state: str, pr: int | None = None
) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id=direction_id,
            app="sacrifice",
            title="t",
            slug=slug,
            scope="backend",
            state=state,
            github_pr_number=pr,
            github_branch=f"factory/{slug}",
        ),
        db,
    )


def _reload(db: Path, sid: int | None) -> StoryRecord:
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return ses.exec(select(StoryRecord).where(StoryRecord.id == sid)).one()


def _no_client():
    return None


def test_supersedes_inflight_loser_of_deployed_winner(tmp_path: Path) -> None:
    """The core G2 fix: a DEPLOYED sibling + a still-in-dev sibling → the loser
    is superseded, even though reconcile_from_github would never revisit the
    terminal winner."""
    db = _seed(tmp_path)
    winner = _story(db, direction_id="110", slug="oauth-alt-a", state=StoryState.DEPLOYED.value)
    loser = _story(
        db, direction_id="110", slug="oauth-alt-b", state=StoryState.DEV_IN_PROGRESS.value
    )

    out = reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert out == [
        ("oauth-alt-b", StoryState.DEV_IN_PROGRESS.value, StoryState.SUPERSEDED_BY_SIBLING.value)
    ]
    assert _reload(db, loser.id).state == StoryState.SUPERSEDED_BY_SIBLING.value
    assert _reload(db, winner.id).state == StoryState.DEPLOYED.value  # winner untouched


def test_supersedes_loser_when_winner_only_deploy_pending(tmp_path: Path) -> None:
    """A winner still at DEPLOY_PENDING (merged, deploy not finished) also counts
    as shipped — its loser is retired so it can't race to a second merge."""
    db = _seed(tmp_path)
    _story(db, direction_id="112", slug="redeploy-alt-a", state=StoryState.DEPLOY_PENDING.value)
    loser = _story(
        db, direction_id="112", slug="redeploy-alt-b", state=StoryState.STORY_CREATED.value
    )

    reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert _reload(db, loser.id).state == StoryState.SUPERSEDED_BY_SIBLING.value


def test_idempotent_when_loser_already_superseded(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, direction_id="111", slug="signin-alt-a", state=StoryState.DEPLOYED.value)
    _story(
        db,
        direction_id="111",
        slug="signin-alt-b",
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
    )

    out = reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert out == []  # nothing to do


def test_noop_when_no_sibling_shipped(tmp_path: Path) -> None:
    """Both siblings still in flight → nothing is superseded (no winner yet)."""
    db = _seed(tmp_path)
    a = _story(db, direction_id="120", slug="x-alt-a", state=StoryState.DEV_IN_PROGRESS.value)
    b = _story(db, direction_id="120", slug="x-alt-b", state=StoryState.PR_OPEN.value)

    out = reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert out == []
    assert _reload(db, a.id).state == StoryState.DEV_IN_PROGRESS.value
    assert _reload(db, b.id).state == StoryState.PR_OPEN.value


def test_both_deployed_not_downgraded(tmp_path: Path) -> None:
    """Over-fire residue (both siblings deployed) is left alone — never downgrade
    a shipped sibling to superseded."""
    db = _seed(tmp_path)
    a = _story(db, direction_id="007", slug="dup-alt-a", state=StoryState.DEPLOYED.value)
    b = _story(db, direction_id="007", slug="dup-alt-b", state=StoryState.DEPLOYED.value)

    out = reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert out == []
    assert _reload(db, a.id).state == StoryState.DEPLOYED.value
    assert _reload(db, b.id).state == StoryState.DEPLOYED.value


def test_both_deploy_pending_not_downgraded(tmp_path: Path) -> None:
    """The transient BOTH-merged race: both siblings at DEPLOY_PENDING (each PR
    landed, deploy enqueued). Neither must be downgraded to superseded — that
    would mislabel a merged story and delete its branch. DEPLOY_PENDING counts as
    shipped for BOTH winner-selection and loser-exclusion."""
    db = _seed(tmp_path)
    a = _story(db, direction_id="140", slug="race-alt-a", state=StoryState.DEPLOY_PENDING.value)
    b = _story(db, direction_id="140", slug="race-alt-b", state=StoryState.DEPLOY_PENDING.value)

    out = reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert out == []
    assert _reload(db, a.id).state == StoryState.DEPLOY_PENDING.value
    assert _reload(db, b.id).state == StoryState.DEPLOY_PENDING.value


def test_non_dualdraft_stories_ignored(tmp_path: Path) -> None:
    """A direction with no ``-alt-*`` siblings is never touched."""
    db = _seed(tmp_path)
    solo = _story(
        db, direction_id="130", slug="plain-story", state=StoryState.DEV_IN_PROGRESS.value
    )

    out = reconcile_dual_draft_winners(
        db, "sacrifice", cfg=_CFG, root=tmp_path, github_client_factory=_no_client
    )

    assert out == []
    assert _reload(db, solo.id).state == StoryState.DEV_IN_PROGRESS.value
