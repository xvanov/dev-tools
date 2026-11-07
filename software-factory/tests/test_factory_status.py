"""Tests for the Phase 7 ``factory-status`` pinned issue.

Verifies:

  * ``compose_status_body`` includes every required section heading even
    on an empty fixture.
  * Active blockers + active Direction Trackers + recent deploys show up
    when the underlying fixture rows exist.
  * ``update_status_issue`` is idempotent: a second call with a fake GH
    client edits the same issue rather than opening a new one.
  * The CLI command ``factory status-sync --app <app> --dry-run`` prints
    the composed body and never touches GitHub.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from sqlmodel import Session

from factory.chain.factory_status import (
    FactoryStatusRecord,
    _engine,
    compose_status_body,
    update_status_issue,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.deploy.models import DeployActionRecord
from factory.deploy.orchestrator import _engine as _deploy_engine


def _write_root(tmp_path: Path) -> Path:
    """Set up a minimal factory root for the sacrifice app."""
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        yaml.safe_dump({"name": "sacrifice", "repo": "owner/sacrifice"}),
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir(parents=True)
    # Minimal factory_settings so load_settings doesn't drift to a real
    # YAML file outside the tmp tree.
    (tmp_path / "factory_settings.yaml").write_text(
        yaml.safe_dump(
            {
                "caps": {
                    "global_concurrent_agents": 2,
                    "per_repo_concurrent_agents": 2,
                    "daily_spend_usd": 10.0,
                    "hourly_spend_usd": 2.0,
                },
                "modes": {"default": "normal", "available": ["normal", "paused", "fix-only"]},
            }
        ),
        encoding="utf-8",
    )
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)
    return tmp_path


def test_compose_status_body_empty_fixture_has_all_sections(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    body = compose_status_body("sacrifice", root)
    # Every required section heading must be present even on an empty
    # state — otherwise the operator's pinned issue loses load-bearing
    # rows after a quiet period.
    assert "### Current mode" in body
    assert "### Queue depth" in body
    assert "### Today's spend" in body
    assert "### Last 5 deploys" in body
    assert "### Active blockers" in body
    assert "### Active Direction Trackers" in body
    # Mode default = normal from the fixture settings.
    assert "`normal`" in body
    assert "0 story / stories in flight" in body
    # Empty placeholders.
    assert "_(no deploys recorded yet)_" in body
    assert "_(none)_" in body


def test_compose_status_body_includes_blockers_and_deploys(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    db = root / "state" / "factory.db"

    # Insert a blocked story.
    eng = _engine(db)
    with Session(eng) as session:
        session.add(
            StoryRecord(
                direction_id="001",
                app="sacrifice",
                title="Add /healthz",
                slug="add-healthz",
                scope="backend",
                state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
            )
        )
        session.commit()

    # Insert a recent failed deploy.
    deng = _deploy_engine(db)
    with Session(deng) as session:
        session.add(
            DeployActionRecord(
                app="sacrifice",
                sha="abc123def4567890",
                status="rolled_back",
                error="smoke failed",
            )
        )
        session.commit()

    # Insert an active Direction Tracker via state.yaml.
    direction_dir = root / "apps" / "sacrifice" / "directions" / "001-add-healthz"
    direction_dir.mkdir(parents=True)
    (direction_dir / "direction.md").write_text(
        "---\ntitle: Add /healthz\n---\n\n# Add /healthz\n", encoding="utf-8"
    )
    (direction_dir / "state.yaml").write_text(
        yaml.safe_dump({"status": "pm-validated", "tracker_issue": 42}),
        encoding="utf-8",
    )

    body = compose_status_body("sacrifice", root)

    # Story 1 is in blockers.
    assert "blocked_tests_need_clarification" in body
    assert "add-healthz" in body
    # Deploy row appears with its (short) sha.
    assert "abc123def456" in body
    assert "rolled_back" in body
    # Direction tracker.
    assert "001-add-healthz" in body
    assert "pm-validated" in body
    assert "tracker #42" in body


class _FakeIssue:
    """Stand-in for a ``pygithub.Issue`` carrying only the fields we touch."""

    def __init__(self, number: int) -> None:
        self.number = number
        self.title: str | None = None
        self.body: str | None = None
        self.labels: list[str] = []
        self._edit_count = 0

    def edit(self, *, title: str, body: str, labels: list[str]) -> None:
        self.title = title
        self.body = body
        self.labels = labels
        self._edit_count += 1


class _FakeRepo:
    def __init__(self) -> None:
        self._next = 100
        self.created: list[_FakeIssue] = []
        self.by_number: dict[int, _FakeIssue] = {}

    def create_issue(self, *, title: str, body: str, labels: list[str]) -> _FakeIssue:
        issue = _FakeIssue(self._next)
        self._next += 1
        issue.title = title
        issue.body = body
        issue.labels = labels
        self.created.append(issue)
        self.by_number[issue.number] = issue
        return issue

    def get_issue(self, number: int) -> _FakeIssue:
        return self.by_number[number]


class _FakeClient:
    def __init__(self) -> None:
        self.repo = _FakeRepo()

    def get_repo(self, _full_name: str) -> _FakeRepo:
        return self.repo


def test_update_status_issue_is_idempotent(tmp_path: Path) -> None:
    """First call creates; subsequent calls edit the same issue."""
    root = _write_root(tmp_path)
    gh = _FakeClient()

    n1 = update_status_issue("sacrifice", root, gh)
    assert n1 == 100
    assert len(gh.repo.created) == 1
    assert gh.repo.created[0].title == "[FACTORY] sacrifice live status"
    assert gh.repo.created[0].labels == ["factory-status"]

    # Second call must NOT create another issue — it must edit.
    n2 = update_status_issue("sacrifice", root, gh)
    assert n2 == 100
    assert len(gh.repo.created) == 1  # still one
    assert gh.repo.by_number[100]._edit_count == 1

    # Persisted row carries the issue number.
    db = root / "state" / "factory.db"
    eng = _engine(db)
    with Session(eng) as session:
        rows = list(session.exec(__import__("sqlmodel").select(FactoryStatusRecord)).all())
    assert len(rows) == 1
    assert rows[0].app == "sacrifice"
    assert rows[0].gh_issue_number == 100


def test_status_sync_cli_dry_run(tmp_path: Path) -> None:
    """``factory status-sync --app sacrifice --dry-run`` prints the body and exits 0."""
    from typer.testing import CliRunner

    from factory import cli as cli_mod

    root = _write_root(tmp_path)
    # Point the CLI at our tmp root.
    cli_mod._FACTORY_ROOT = root

    runner = CliRunner()
    result = runner.invoke(cli_mod.app, ["status-sync", "--app", "sacrifice", "--dry-run"])
    assert result.exit_code == 0, result.output
    # The dry-run path prints the composed body verbatim.
    assert "### Current mode" in result.output
    assert "### Queue depth" in result.output
    assert "### Today's spend" in result.output
    assert "### Last 5 deploys" in result.output
    assert "### Active blockers" in result.output
    assert "### Active Direction Trackers" in result.output


_ = (datetime, UTC, Any)  # silence "imported but unused" — kept for test scaffolding
