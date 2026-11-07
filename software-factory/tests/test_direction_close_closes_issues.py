"""Closing a direction must close its GitHub issues (tracker + child stories).

Regression coverage for the 2026-07-28 operator-close leak: an operator closed
directions D015/D016/D017 via ``mark_direction_status(..., "closed")``. The DB
rows read ``closed`` but six GitHub issues (2 trackers + 4 story issues, plus
D017's tracker) stayed open forever — the *detect-without-remediate* class: the
state transition happened and nothing closed the loop.

Two halves, matching the two ways the loop is closed:

  * forward — ``mark_direction_status`` closes the tracker AND every child story
    issue when the new status resolves the direction, best-effort so a GitHub
    failure never fails (or raises out of) the transition;
  * recoverable — ``reconcile_completed_issues`` closes issues for any direction
    whose status is already ``closed``, so an already-orphaned direction (or one
    closed without a GitHub client in scope) self-heals on the next sweep.
    ``_direction_is_complete`` can never cover this: an operator-closed
    direction's children are parked mid-flight, or it has no children at all.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from sqlmodel import Session

from factory.app_config import AppConfig, DeployConfig
from factory.chain.state_machine import StoryRecord, StoryState
from factory.directions.parser import Direction
from factory.directions.schema import RESOLVED_DIRECTION_STATUSES, get_direction
from factory.directions.tracker_issue import close_direction_issues, reconcile_completed_issues
from factory.directions.watcher import _engine, mark_direction_status

# ─── fakes (same shape as tests/test_reconcile_completed_issues.py) ─────────


class _Issue:
    def __init__(self, number: int, state: str = "open") -> None:
        self.number = number
        self.state = state
        self.comments: list[str] = []
        self.edits: list[dict[str, Any]] = []

    def create_comment(self, body: str) -> None:
        self.comments.append(body)

    def edit(self, state: str | None = None, state_reason: str | None = None, **_: Any) -> None:
        if state is not None:
            self.state = state
        self.edits.append({"state": state, "state_reason": state_reason})


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


class _BoomClient:
    """A client whose very first call explodes (no token / GH outage / 500)."""

    def get_repo(self, full_name: str) -> Any:
        raise RuntimeError("gh 503 service unavailable")


def _app_config() -> AppConfig:
    return AppConfig(
        name="factory",
        repo="xvanov/software-factory",
        default_branch="main",
        context_dir="context",
        deploy=DeployConfig(enabled=False),
        models={},
    )


def _direction(
    root: Path, *, direction_id: str = "015", tracker_issue: int | None = 156
) -> Direction:
    """Build a Direction whose dir_path mirrors the canonical layout."""
    dir_path = root / "apps" / "factory" / "directions" / f"{direction_id}-test-direction"
    dir_path.mkdir(parents=True, exist_ok=True)
    fm = {
        "title": "Test Direction",
        "type": "feature",
        "priority": "p2",
        "explore": False,
        "created_at": "2025-01-01T00:00:00+00:00",
    }
    (dir_path / "direction.md").write_text(
        f"---\n{yaml.safe_dump(fm, sort_keys=False).strip()}\n---\n\n"
        "# Test Direction\n\n## Why\n\nReason.\n\n## Acceptance Criteria\n\n- AC1\n",
        encoding="utf-8",
    )
    state: dict[str, Any] = {"status": "pm-validated"}
    if tracker_issue is not None:
        state["tracker_issue"] = tracker_issue
    (dir_path / "state.yaml").write_text(yaml.safe_dump(state), encoding="utf-8")
    return Direction(
        id=direction_id,
        slug="test-direction",
        title="Test Direction",
        type_tag=None,
        why=None,
        has_flow=False,
        has_api_spec=False,
        acceptance=[],
        explore_tag=False,
        artifacts_paths=[],
        app="factory",
        status="pm-validated",
        raw_frontmatter={},
        raw_body="",
        dir_path=dir_path,
        state=state,
    )


def _persist(root: Path, **kw: Any) -> None:
    from factory.chain.handlers import persist_story

    persist_story(StoryRecord(app="factory", **kw), root / "state" / "factory.db")


def _dual_draft_stories(root: Path, direction_id: str = "015") -> None:
    """Two mid-flight dual-draft stories, the D015/D016 shape."""
    _persist(
        root,
        direction_id=direction_id,
        title="narrow",
        slug=f"d{direction_id}-narrow-alt-a",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        github_issue_number=157,
    )
    _persist(
        root,
        direction_id=direction_id,
        title="broad",
        slug=f"d{direction_id}-broad-alt-b",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        github_issue_number=158,
    )


def _status_in_db(root: Path, direction_id: str = "015") -> str | None:
    with Session(_engine(root / "state" / "factory.db")) as session:
        row = get_direction(session, "factory", direction_id)
        return None if row is None else row.status


# ─── forward path: mark_direction_status ───────────────────────────────────


def test_closing_a_direction_closes_tracker_and_story_issues(tmp_path: Path) -> None:
    """THE bug: closing a direction left its tracker + story issues open."""
    direction = _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}
    client = _Client(_Repo(issues))

    mark_direction_status(
        direction,
        "closed",
        by="operator",
        details={"reason": "superseded by a broader direction"},
        app_config=_app_config(),
        github_client=client,
    )

    assert issues[156].state == "closed", "direction tracker must close"
    assert issues[157].state == "closed", "child story issue must close"
    assert issues[158].state == "closed", "child story issue must close"
    # Every close carries an explanatory comment naming the direction.
    for num in (156, 157, 158):
        assert issues[num].comments and "015" in issues[num].comments[0]
    assert _status_in_db(tmp_path) == "closed"


def test_closing_a_direction_without_stories_closes_the_tracker(tmp_path: Path) -> None:
    """The D017 shape: a direction that never filed a story still has a tracker."""
    direction = _direction(tmp_path, direction_id="017", tracker_issue=162)
    issues = {162: _Issue(162)}
    client = _Client(_Repo(issues))

    mark_direction_status(
        direction, "closed", by="operator", app_config=_app_config(), github_client=client
    )

    assert issues[162].state == "closed"
    assert _status_in_db(tmp_path, "017") == "closed"


def test_close_is_idempotent_and_never_reopens(tmp_path: Path) -> None:
    direction = _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}
    client = _Client(_Repo(issues))
    cfg = _app_config()

    mark_direction_status(direction, "closed", by="operator", app_config=cfg, github_client=client)
    mark_direction_status(direction, "closed", by="operator", app_config=cfg, github_client=client)

    # An already-closed issue is never re-commented or re-edited.
    for num in (156, 157, 158):
        assert len(issues[num].edits) == 1
        assert len(issues[num].comments) == 1


def test_github_failure_does_not_fail_the_transition(tmp_path: Path) -> None:
    """Best-effort contract: the DB row is already committed, so a GitHub
    outage must neither raise nor roll back the status transition."""
    direction = _direction(tmp_path)
    _dual_draft_stories(tmp_path)

    mark_direction_status(
        direction,
        "closed",
        by="operator",
        app_config=_app_config(),
        github_client=_BoomClient(),  # get_repo raises
    )

    assert _status_in_db(tmp_path) == "closed"
    assert direction.status == "closed"
    state = yaml.safe_load((direction.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "closed"


def test_one_bad_issue_does_not_block_the_other_closes(tmp_path: Path) -> None:
    """A 404/500 on ONE issue must not stop the remaining closes."""
    direction = _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}

    class _PartialBoomRepo(_Repo):
        def get_issue(self, n: int) -> _Issue:
            if n == 157:
                raise RuntimeError("gh 404 not found")
            return super().get_issue(n)

    report = close_direction_issues(
        direction, _app_config(), _Client(_PartialBoomRepo(issues)), by="operator"
    )

    assert issues[156].state == "closed"
    assert issues[158].state == "closed"
    assert any(num == 157 for _, num, _ in report["errors"])


def test_missing_github_client_still_transitions(tmp_path: Path) -> None:
    """The operator/REPL path (no client wired) must keep working — the
    reconcile sweep is what closes the issues in that case."""
    direction = _direction(tmp_path)

    mark_direction_status(direction, "closed", by="operator")  # no app_config, no client

    assert _status_in_db(tmp_path) == "closed"


def test_non_resolving_status_touches_no_github_issue(tmp_path: Path) -> None:
    """Guard against over-firing: only a RESOLVED status closes issues."""
    direction = _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}
    client = _Client(_Repo(issues))

    for status in ("created", "needs-direction", "pm-validated"):
        assert status not in RESOLVED_DIRECTION_STATUSES
        mark_direction_status(
            direction,
            status,
            by="factory.chain.pm_sync",
            app_config=_app_config(),
            github_client=client,
        )

    assert all(issues[n].state == "open" for n in (156, 157, 158))
    assert all(not issues[n].comments for n in (156, 157, 158))


# ─── recoverable path: reconcile-issues ───────────────────────────────────


def _close_direction_on_disk_only(root: Path, direction_id: str) -> None:
    """Mark a direction closed WITHOUT any GitHub call — reproduces exactly what
    the operator's ``mark_direction_status`` call left behind."""
    base = root / "apps" / "factory" / "directions" / f"{direction_id}-test-direction"
    state = yaml.safe_load((base / "state.yaml").read_text(encoding="utf-8"))
    state["status"] = "closed"
    (base / "state.yaml").write_text(yaml.safe_dump(state), encoding="utf-8")


def _seed_orphaned_direction(root: Path, direction_id: str = "015") -> dict[int, _Issue]:
    direction = _direction(root, direction_id=direction_id)
    _dual_draft_stories(root, direction_id)
    mark_direction_status(direction, "closed", by="operator")  # no client — the leak
    _close_direction_on_disk_only(root, direction_id)
    return {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}


def test_reconcile_closes_issues_of_an_already_closed_direction(tmp_path: Path) -> None:
    """The six orphaned issues must be swept up on the next reconcile run."""
    issues = _seed_orphaned_direction(tmp_path)
    client = _Client(_Repo(issues))

    report = reconcile_completed_issues(_app_config(), client, software_factory_root=tmp_path)

    assert 156 in {n for _, n in report["trackers_closed"]}
    assert {n for _, n in report["stories_closed"]} == {157, 158}
    assert all(issues[n].state == "closed" for n in (156, 157, 158))
    assert not report["errors"]
    # Closed as "not planned" — the direction was abandoned, not delivered.
    assert issues[156].edits[0]["state_reason"] == "not_planned"


def test_reconcile_closes_the_exact_production_d015_shape(tmp_path: Path) -> None:
    """The real D015/D016 rows: both children parked in ``blocked_deploy_failed``,
    a RECOVERABLE-pending-human block that is deliberately absent from
    ``_RESOLVED_STORY_STATES``. Pass 2 can therefore never reach those story
    issues, and ``_direction_is_complete`` is False — the direction's own
    ``closed`` status is the only signal that closes them."""
    direction = _direction(tmp_path)
    _persist(
        tmp_path,
        direction_id="015",
        title="narrow",
        slug="d015-narrow-alt-a",
        scope="backend",
        state=StoryState.BLOCKED_DEPLOY_FAILED.value,
        github_issue_number=157,
    )
    _persist(
        tmp_path,
        direction_id="015",
        title="broad",
        slug="d015-broad-alt-b",
        scope="backend",
        state=StoryState.BLOCKED_DEPLOY_FAILED.value,
        github_issue_number=158,
    )
    mark_direction_status(direction, "closed", by="operator")  # no client — the leak
    _close_direction_on_disk_only(tmp_path, "015")
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path
    )

    assert 156 in {n for _, n in report["trackers_closed"]}
    assert {n for _, n in report["stories_closed"]} == {157, 158}
    assert all(issues[n].state == "closed" for n in (156, 157, 158))


def test_reconcile_closed_but_shipped_direction_keeps_complete_wording(tmp_path: Path) -> None:
    """The real D005/D006 shape: status ``closed`` AND complete-by-children
    (deployed winner + superseded loser). The tracker keeps the existing
    "Direction complete" wording (not "not planned"), and each story issue is
    closed by pass 2 with its own precise wording — no double handling."""
    direction = _direction(tmp_path, direction_id="005", tracker_issue=54)
    _persist(
        tmp_path,
        direction_id="005",
        title="winner",
        slug="d005-winner",
        scope="backend",
        state=StoryState.DEPLOYED.value,
        github_issue_number=55,
    )
    _persist(
        tmp_path,
        direction_id="005",
        title="loser",
        slug="d005-loser-alt-b",
        scope="backend",
        state=StoryState.SUPERSEDED_BY_SIBLING.value,
        github_issue_number=56,
    )
    mark_direction_status(direction, "closed", by="operator")
    issues = {54: _Issue(54), 55: _Issue(55), 56: _Issue(56)}

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path
    )

    assert 54 in {n for _, n in report["trackers_closed"]}
    assert "Direction complete" in issues[54].comments[0]
    assert issues[54].edits[0]["state_reason"] is None
    # Each story issue closed exactly once, by pass 2's shipped wording.
    assert {n for _, n in report["stories_closed"]} == {55, 56}
    assert len(issues[55].comments) == 1 and "Deployed" in issues[55].comments[0]
    assert len(issues[56].comments) == 1 and "Superseded" in issues[56].comments[0]


def test_reconcile_closed_direction_with_mixed_children(tmp_path: Path) -> None:
    """A closed direction with one deployed and one mid-flight child: both issues
    close, each exactly once and with the wording that fits its own state."""
    direction = _direction(tmp_path)
    _persist(
        tmp_path,
        direction_id="015",
        title="shipped",
        slug="d015-shipped",
        scope="backend",
        state=StoryState.DEPLOYED.value,
        github_issue_number=157,
    )
    _persist(
        tmp_path,
        direction_id="015",
        title="wip",
        slug="d015-wip",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        github_issue_number=158,
    )
    mark_direction_status(direction, "closed", by="operator")
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path
    )

    assert {n for _, n in report["stories_closed"]} == {157, 158}
    assert len(issues[157].comments) == 1 and "Deployed" in issues[157].comments[0]
    assert len(issues[158].comments) == 1 and "Parent direction closed" in issues[158].comments[0]
    assert all(len(issues[n].edits) == 1 for n in (156, 157, 158))


def test_reconcile_closed_direction_is_idempotent(tmp_path: Path) -> None:
    issues = _seed_orphaned_direction(tmp_path)
    client = _Client(_Repo(issues))

    reconcile_completed_issues(_app_config(), client, software_factory_root=tmp_path)
    report2 = reconcile_completed_issues(_app_config(), client, software_factory_root=tmp_path)

    assert report2["trackers_closed"] == [] and report2["stories_closed"] == []
    assert all(len(issues[n].edits) == 1 for n in (156, 157, 158))


def test_reconcile_dry_run_previews_closed_direction_without_mutating(tmp_path: Path) -> None:
    issues = _seed_orphaned_direction(tmp_path)
    client = _Client(_Repo(issues))

    report = reconcile_completed_issues(
        _app_config(), client, software_factory_root=tmp_path, dry_run=True
    )

    assert {n for _, n, _ in report["would_close"]} == {156, 157, 158}
    assert len(report["would_close"]) == 3, "no duplicate rows across the two passes"
    assert all(issues[n].state == "open" for n in (156, 157, 158))
    assert all(not issues[n].comments for n in (156, 157, 158))


def test_reconcile_db_status_beats_stale_state_yaml(tmp_path: Path) -> None:
    """DB-first precedence: the ``directions`` row is authoritative, so a stale
    ``state.yaml`` that still says ``pm-validated`` must not keep issues open."""
    direction = _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    mark_direction_status(direction, "closed", by="operator")  # DB row = closed
    # state.yaml rewritten stale (as if the projection was lost / hand-edited).
    base = tmp_path / "apps" / "factory" / "directions" / "015-test-direction"
    (base / "state.yaml").write_text(
        yaml.safe_dump({"status": "pm-validated", "tracker_issue": 156}), encoding="utf-8"
    )
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path
    )

    assert 156 in {n for _, n in report["trackers_closed"]}
    assert {n for _, n in report["stories_closed"]} == {157, 158}


def test_reconcile_leaves_an_open_direction_untouched(tmp_path: Path) -> None:
    """Fail-safe guard: a direction that is NOT closed keeps every issue open,
    even though its children are mid-flight."""
    _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path
    )

    assert report["trackers_closed"] == [] and report["stories_closed"] == []
    assert all(issues[n].state == "open" for n in (156, 157, 158))


def test_reconcile_unknown_direction_status_keeps_issues_open(tmp_path: Path) -> None:
    """A status the allowlist does not know is treated as NOT resolved — a broken
    or future status must block the remediation, never wave issues closed."""
    _direction(tmp_path)
    _dual_draft_stories(tmp_path)
    base = tmp_path / "apps" / "factory" / "directions" / "015-test-direction"
    (base / "state.yaml").write_text(
        yaml.safe_dump({"status": "some-future-status", "tracker_issue": 156}), encoding="utf-8"
    )
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path
    )

    assert report["trackers_closed"] == [] and report["stories_closed"] == []
    assert all(issues[n].state == "open" for n in (156, 157, 158))


def test_reconcile_closed_direction_bad_db_closes_nothing(tmp_path: Path) -> None:
    """FAIL SAFE: with an unreadable DB the sweep cannot tell resolved work from
    in-flight work, so it closes nothing and reports the error."""
    _seed_orphaned_direction(tmp_path)
    issues = {156: _Issue(156), 157: _Issue(157), 158: _Issue(158)}
    bogus = tmp_path / "corrupt.db"
    bogus.write_bytes(b"this is not a sqlite database")

    report = reconcile_completed_issues(
        _app_config(), _Client(_Repo(issues)), software_factory_root=tmp_path, db_path=bogus
    )

    assert report["errors"] and report["errors"][0][0] == "db"
    assert report["trackers_closed"] == [] and report["stories_closed"] == []
    assert all(issues[n].state == "open" for n in (156, 157, 158))


# ─── the GC path keeps working (and now closes story issues too) ───────────


def test_gc_close_also_closes_child_story_issues(tmp_path: Path) -> None:
    """``factory.directions.gc`` routes through the same shared helper, so a
    GC'd direction no longer leaks its child story issues either."""
    from datetime import UTC, datetime

    from factory.directions.creator import create_direction
    from factory.directions.gc import gc_stale_scheduled_directions

    created = create_direction(
        "factory",
        title="rate-limit /api/pledge",
        type_tag="security",
        why="flooding",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["429 after 5/min"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-security",
    )
    state_path = created.dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
    state.update(
        {
            "status": "needs-direction",
            "source": "scheduled-security",
            "tracker_issue": 400,
            "created_at": "2020-01-01T00:00:00+00:00",  # far past MAX_AGE_DAYS
            "audit": [{"event": "status -> needs-direction"}],
        }
    )
    state_path.write_text(yaml.safe_dump(state), encoding="utf-8")
    _persist(
        tmp_path,
        direction_id=created.direction.id,
        title="wip",
        slug="gc-child",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        github_issue_number=401,
    )
    issues = {400: _Issue(400), 401: _Issue(401)}

    closed = gc_stale_scheduled_directions(
        "factory",
        tmp_path,
        _app_config(),
        _Client(_Repo(issues)),
        dry_run=False,
        now=datetime.now(UTC),
    )

    assert closed == [created.direction.id]
    assert issues[400].state == "closed"
    assert issues[400].edits[0]["state_reason"] == "not_planned"
    assert issues[401].state == "closed", "GC'd direction's story issue must close too"
