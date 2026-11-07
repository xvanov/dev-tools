"""Fix B — ``freshen_behind_prs`` keeps OPEN mergeable PRs fast-forwarded.

A PR cut from an older ``main`` falls BEHIND as ``main`` advances and, left
alone, eventually CONFLICTS. This tick step merges the base back into any PR
that is merely ``BEHIND`` (``gh pr update-branch`` — a merge, never a
force-push) so branches stay fresh and never drift far enough to truly
conflict. It touches ONLY ``BEHIND`` PRs — conflicting/dirty ones are left to
the conflict-recovery path, clean ones need nothing.

The ``gh`` shell-outs (merge-state query + update-branch) are injected so these
tests never touch the network.
"""

from __future__ import annotations

from pathlib import Path

from sqlmodel import SQLModel, create_engine

from factory.app_config import AppConfig
from factory.chain.handlers import persist_story
from factory.chain.orchestrator import freshen_behind_prs
from factory.chain.state_machine import StoryRecord, StoryState

_CFG = AppConfig(name="sacrifice", repo="acme/sacrifice")


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _story(db: Path, *, state: str, slug: str, pr_number: int | None = 42) -> StoryRecord:
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


def _merge_state(mapping: dict[int, str | None]):
    """A ``query_merge_state`` stub driven by a {pr_number: status} mapping."""

    def _q(*, app_config: AppConfig, pr_number: int) -> str | None:
        return mapping.get(pr_number)

    return _q


class _RecordingUpdate:
    """An ``update_branch`` stub that records the PRs it was asked to refresh."""

    def __init__(self, *, succeed: bool = True) -> None:
        self.calls: list[int] = []
        self._succeed = succeed

    def __call__(self, *, app_config: AppConfig, pr_number: int) -> bool:
        self.calls.append(pr_number)
        return self._succeed


def test_behind_pr_is_refreshed(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, state=StoryState.PR_OPEN.value, slug="a", pr_number=42)
    upd = _RecordingUpdate()
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({42: "BEHIND"}),
        update_branch=upd,
    )
    assert upd.calls == [42]
    assert refreshed == [("a", 42)]


def test_conflicting_and_dirty_and_clean_are_skipped(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    # Real ``gh pr view --json mergeStateStatus`` values: a merge conflict is
    # DIRTY (never "CONFLICTING" — that's the separate ``mergeable`` enum the
    # code never queries); BLOCKED = required checks/reviews pending.
    _story(db, state=StoryState.PR_OPEN.value, slug="blocked", pr_number=1)
    _story(db, state=StoryState.CI_GREEN.value, slug="dirty", pr_number=2)
    _story(db, state=StoryState.READY_FOR_MERGE.value, slug="clean", pr_number=3)
    _story(db, state=StoryState.PR_OPEN.value, slug="unknown", pr_number=4)
    upd = _RecordingUpdate()
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({1: "BLOCKED", 2: "DIRTY", 3: "CLEAN", 4: None}),
        update_branch=upd,
    )
    # Nothing BEHIND → nothing touched.
    assert upd.calls == []
    assert refreshed == []


def test_only_behind_touched_among_mixed(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, state=StoryState.PR_OPEN.value, slug="behind", pr_number=10)
    _story(db, state=StoryState.PR_OPEN.value, slug="dirty", pr_number=11)
    upd = _RecordingUpdate()
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({10: "BEHIND", 11: "DIRTY"}),
        update_branch=upd,
    )
    assert upd.calls == [10]
    assert refreshed == [("behind", 10)]


def test_non_mergeable_states_are_not_candidates(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    # A story mid-dev with an old PR number is NOT a freshening candidate even
    # if it would report BEHIND — only pr_open/ci_green/ready_for_merge qualify.
    _story(db, state=StoryState.DEV_IN_PROGRESS.value, slug="dev", pr_number=99)
    upd = _RecordingUpdate()
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({99: "BEHIND"}),
        update_branch=upd,
    )
    assert upd.calls == []
    assert refreshed == []


def test_update_branch_failure_is_not_reported_refreshed(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _story(db, state=StoryState.PR_OPEN.value, slug="a", pr_number=42)
    upd = _RecordingUpdate(succeed=False)
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({42: "BEHIND"}),
        update_branch=upd,
    )
    assert upd.calls == [42]  # attempted
    assert refreshed == []  # but the command failed → not counted


def test_cap_bounds_update_branch_calls(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    for n in range(1, 6):
        _story(db, state=StoryState.PR_OPEN.value, slug=f"s{n}", pr_number=n)
    upd = _RecordingUpdate()
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({n: "BEHIND" for n in range(1, 6)}),
        update_branch=upd,
        max_freshen=2,
    )
    assert len(upd.calls) == 2
    assert len(refreshed) == 2


def test_no_candidates_is_clean_noop(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    upd = _RecordingUpdate()
    refreshed = freshen_behind_prs(
        db,
        "sacrifice",
        cfg=_CFG,
        root=tmp_path,
        query_merge_state=_merge_state({}),
        update_branch=upd,
    )
    assert upd.calls == []
    assert refreshed == []
