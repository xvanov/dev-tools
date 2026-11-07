"""Tests for ``factory.directions.gc`` — the stale-scheduled-direction GC pass.

Regression coverage for audit 2026-07-18 leak 2 of 4: directions filed by
scheduled personas (ralph/bug_hunter/security/ux_auditor) that fail the
backpressure gate sit at ``needs-direction`` forever because nobody
re-triages them — no operator, no automated re-check (``maybe_auto_pm_sync``
deliberately excludes ``needs-direction``). Their tracker issues never
close either. This module's GC pass is a conservative safety net: only
scheduler-filed directions, only once genuinely stale.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from factory.directions.creator import create_direction
from factory.directions.gc import (
    GC_BY,
    GC_REASON,
    MAX_AGE_DAYS,
    MIN_CONSECUTIVE_NEEDS_DIRECTION_ENTRIES,
    gc_stale_scheduled_directions,
    is_gc_eligible,
)
from factory.directions.parser import Direction

NOW = datetime(2026, 7, 18, 12, 0, 0, tzinfo=UTC)


def _mk_direction(
    *,
    status: str = "needs-direction",
    source: str | None = "scheduled-security",
    created_at: str | None = None,
    audit_events: list[str] | None = None,
    tracker_issue: int | None = None,
) -> Direction:
    state: dict[str, Any] = {"status": status}
    if source is not None:
        state["source"] = source
    if created_at is not None:
        state["created_at"] = created_at
    if audit_events is not None:
        state["audit"] = [{"event": e} for e in audit_events]
    if tracker_issue is not None:
        state["tracker_issue"] = tracker_issue
    return Direction(
        id="042",
        slug="rate-limit-pledge",
        title="rate-limit /api/pledge",
        type_tag="security",
        why="pledge flooding",
        has_flow=False,
        has_api_spec=False,
        acceptance=["429 after 5/min"],
        explore_tag=True,
        artifacts_paths=[],
        app="sacrifice",
        status=status,
        raw_frontmatter={},
        raw_body="",
        dir_path=Path("."),
        state=state,
    )


# --------------------------------------------------------------------------- #
# is_gc_eligible — pure logic, deterministic ``now``
# --------------------------------------------------------------------------- #


def test_eligible_via_consecutive_needs_direction_count() -> None:
    d = _mk_direction(
        audit_events=["status -> needs-direction"] * MIN_CONSECUTIVE_NEEDS_DIRECTION_ENTRIES,
        created_at=NOW.isoformat(),  # fresh — only the count triggers this
    )
    assert is_gc_eligible(d, now=NOW) is True


def test_not_eligible_below_consecutive_threshold_and_fresh() -> None:
    d = _mk_direction(
        audit_events=["status -> needs-direction"] * (MIN_CONSECUTIVE_NEEDS_DIRECTION_ENTRIES - 1),
        created_at=NOW.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False


def test_eligible_via_age_even_with_few_audit_entries() -> None:
    old = NOW - timedelta(days=MAX_AGE_DAYS + 1)
    d = _mk_direction(audit_events=["status -> needs-direction"], created_at=old.isoformat())
    assert is_gc_eligible(d, now=NOW) is True


def test_not_eligible_when_age_exactly_at_threshold() -> None:
    at_threshold = NOW - timedelta(days=MAX_AGE_DAYS)
    d = _mk_direction(audit_events=["status -> needs-direction"], created_at=at_threshold.isoformat())
    assert is_gc_eligible(d, now=NOW) is False


def test_github_issue_source_never_eligible_even_when_stale() -> None:
    old = NOW - timedelta(days=100)
    d = _mk_direction(
        source="github_issue",
        audit_events=["status -> needs-direction"] * 10,
        created_at=old.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False


def test_operator_source_never_eligible_even_when_stale() -> None:
    old = NOW - timedelta(days=100)
    d = _mk_direction(
        source="operator",
        audit_events=["status -> needs-direction"] * 10,
        created_at=old.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False


def test_user_source_never_eligible_even_when_stale() -> None:
    old = NOW - timedelta(days=100)
    d = _mk_direction(
        source="user",
        audit_events=["status -> needs-direction"] * 10,
        created_at=old.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False


def test_missing_source_never_eligible_even_when_stale() -> None:
    old = NOW - timedelta(days=100)
    d = _mk_direction(
        source=None,
        audit_events=["status -> needs-direction"] * 10,
        created_at=old.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False


def test_wrong_status_never_eligible() -> None:
    old = NOW - timedelta(days=100)
    d = _mk_direction(
        status="pm-validated",
        audit_events=["status -> needs-direction"] * 10,
        created_at=old.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False


# --------------------------------------------------------------------------- #
# created + parked at the operator-approval gate (2026-07-30)
# --------------------------------------------------------------------------- #


def test_stale_unapproved_created_direction_is_eligible() -> None:
    """A scheduled direction parked at the approval gate for >14 days is reaped.

    Without this the approval gate would trade one rot (auto-built junk PRs) for
    another (an inbox that only ever grows).
    """
    old = NOW - timedelta(days=MAX_AGE_DAYS + 1)
    d = _mk_direction(status="created", created_at=old.isoformat())
    assert is_gc_eligible(d, now=NOW) is True


def test_fresh_unapproved_created_direction_is_not_eligible() -> None:
    d = _mk_direction(status="created", created_at=NOW.isoformat())
    assert is_gc_eligible(d, now=NOW) is False


def test_created_direction_with_no_created_at_is_not_eligible() -> None:
    """No age evidence → leave it alone (never guess a direction into the bin)."""
    d = _mk_direction(status="created", created_at=None)
    assert is_gc_eligible(d, now=NOW) is False


def test_approved_created_direction_is_never_eligible() -> None:
    """Once an operator says yes, GC must not reap the work out from under them."""
    old = NOW - timedelta(days=100)
    d = _mk_direction(status="created", created_at=old.isoformat())
    d.state["operator_approval"] = {"approved": True, "approved_by": "kalin"}
    assert is_gc_eligible(d, now=NOW) is False


def test_operator_filed_created_direction_is_never_eligible() -> None:
    """A human's own direction at ``created`` is never reaped, however old."""
    old = NOW - timedelta(days=100)
    d = _mk_direction(status="created", source="operator", created_at=old.isoformat())
    assert is_gc_eligible(d, now=NOW) is False


def test_non_consecutive_needs_direction_entries_dont_count() -> None:
    """A direction that went needs-direction -> pm-validated -> needs-direction
    again only counts the TRAILING run, not the total historical count."""
    d = _mk_direction(
        audit_events=(
            ["status -> needs-direction"] * 10
            + ["status -> pm-validated"]
            + ["status -> needs-direction"] * 2
        ),
        created_at=NOW.isoformat(),
    )
    assert is_gc_eligible(d, now=NOW) is False  # only 2 trailing, not stale by age either


# --------------------------------------------------------------------------- #
# gc_stale_scheduled_directions — on-disk + GitHub integration
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


class _AppConfig:
    name = "sacrifice"
    repo = "owner/sacrifice"


def _stale_scheduled_direction_dir(root: Path, *, tracker_issue: int) -> Path:
    created = create_direction(
        "sacrifice",
        title="rate-limit pledge endpoint",
        type_tag="security",
        why="pledge flooding",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["429 after 5/min"],
        explore=True,
        attach_files=None,
        software_factory_root=root,
        source="scheduled-security",
    )
    dir_path = created.dir_path
    state_path = dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    old = (NOW - timedelta(days=MAX_AGE_DAYS + 1)).isoformat()
    state["created_at"] = old
    state["status"] = "needs-direction"
    state["tracker_issue"] = tracker_issue
    state["audit"] = [{"event": "status -> needs-direction"}]
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return dir_path


def test_gc_closes_stale_scheduled_direction_on_disk_and_github(tmp_path: Path) -> None:
    dir_path = _stale_scheduled_direction_dir(tmp_path, tracker_issue=210)
    issue = _Issue(210)
    client = _Client(_Repo({210: issue}))

    closed = gc_stale_scheduled_directions(
        "sacrifice", tmp_path, _AppConfig(), client, dry_run=False, now=NOW
    )

    assert len(closed) == 1
    state = yaml.safe_load((dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "closed"
    audit = state["audit"]
    assert audit[-1]["by"] == GC_BY
    assert audit[-1]["event"] == "status -> closed"
    assert audit[-1]["details"]["reason"] == GC_REASON

    assert issue.state == "closed"
    assert issue.close_reason == "not_planned"
    assert issue.comments  # explanatory comment posted


def test_gc_dry_run_previews_without_touching_disk_or_github(tmp_path: Path) -> None:
    """Dry-run is a pure preview: it reports which directions WOULD be closed
    (via the returned list) but mutates neither state.yaml on disk nor GitHub.
    (Before 2026-07-20 the dry-run wrote the on-disk close — a preview with a
    real side effect.)"""
    dir_path = _stale_scheduled_direction_dir(tmp_path, tracker_issue=211)
    issue = _Issue(211)
    client = _Client(_Repo({211: issue}))

    closed = gc_stale_scheduled_directions(
        "sacrifice", tmp_path, _AppConfig(), client, dry_run=True, now=NOW
    )

    assert len(closed) == 1  # previewed
    state = yaml.safe_load((dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "needs-direction", "dry-run must not close on disk"
    # No GitHub calls happened in dry-run.
    assert issue.state == "open"
    assert issue.comments == []


def test_gc_leaves_github_issue_sourced_direction_untouched(tmp_path: Path) -> None:
    created = create_direction(
        "sacrifice",
        title="fix reported crash on submit",
        type_tag="bug",
        why="user reported",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["no crash"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="github_issue",
    )
    dir_path = created.dir_path
    state_path = dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    old = (NOW - timedelta(days=100)).isoformat()
    state["created_at"] = old
    state["status"] = "needs-direction"
    state["tracker_issue"] = 300
    state["audit"] = [{"event": "status -> needs-direction"}] * 10
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    issue = _Issue(300)
    client = _Client(_Repo({300: issue}))

    closed = gc_stale_scheduled_directions(
        "sacrifice", tmp_path, _AppConfig(), client, dry_run=False, now=NOW
    )

    assert closed == []
    final_state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert final_state["status"] == "needs-direction"
    assert issue.state == "open"


def test_gc_leaves_recent_scheduled_direction_untouched(tmp_path: Path) -> None:
    created = create_direction(
        "sacrifice",
        title="recent scheduled finding",
        type_tag="security",
        why="just filed",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["fixed"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-bug_hunter",
    )
    dir_path = created.dir_path
    state_path = dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    state["status"] = "needs-direction"
    state["tracker_issue"] = 301
    state["audit"] = [{"event": "status -> needs-direction"}]
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    issue = _Issue(301)
    client = _Client(_Repo({301: issue}))

    closed = gc_stale_scheduled_directions(
        "sacrifice", tmp_path, _AppConfig(), client, dry_run=False, now=NOW
    )

    assert closed == []
    final_state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert final_state["status"] == "needs-direction"
    assert issue.state == "open"
