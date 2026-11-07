"""backfill_tracker_issues: finding + persisting a missing tracker-issue number."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlmodel import Session

from factory.app_config import AppConfig, DeployConfig
from factory.directions.creator import create_direction
from factory.directions.schema import DirectionRecord, get_direction
from factory.directions.tracker_backfill import backfill_tracker_issues
from factory.directions.tracker_issue import _format_tracker_body
from factory.directions.watcher import _engine


class _FakeIssue:
    def __init__(self, number: int, title: str, body: str) -> None:
        self.number = number
        self.title = title
        self.body = body


class _FakeRepo:
    def __init__(self, issues: list[_FakeIssue]) -> None:
        self._issues = issues
        self.get_issues_calls: list[dict[str, Any]] = []

    def get_issues(self, *, state: str = "open") -> list[_FakeIssue]:
        self.get_issues_calls.append({"state": state})
        return list(self._issues)


class _FakeGithub:
    def __init__(self, issues: list[_FakeIssue]) -> None:
        self.repo = _FakeRepo(issues)
        self.get_repo_calls: list[str] = []

    def get_repo(self, full_name: str) -> _FakeRepo:
        self.get_repo_calls.append(full_name)
        return self.repo


def _app_config() -> AppConfig:
    return AppConfig(
        name="factory",
        repo="xvanov/software-factory",
        default_branch="main",
        context_dir="context",
        deploy=DeployConfig(enabled=False),
        models={},
    )


def _make_direction(tmp_path: Path, title: str = "Some direction") -> Any:
    from factory.directions.parser import parse_direction_dir

    out = create_direction(
        app="factory",
        title=title,
        type_tag="feature",
        why="Smoke test.",
        has_ui=False,
        flow_steps=None,
        has_api=True,
        api_spec_lines=["- POST /x -> 200"],
        acceptance=["AC"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    return parse_direction_dir("factory", out.dir_path)


def _tracker_body_for(direction: Any) -> str:
    return _format_tracker_body(direction, pm_summary=None, child_issue_numbers=[])


def _db_path(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    return db


def test_finds_and_persists_missing_tracker_dry_run_does_not_write(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path)
    body = _tracker_body_for(direction)
    gh = _FakeGithub([_FakeIssue(171, "[DIRECTION] some other title entirely", body)])
    db = _db_path(tmp_path)

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=True
    )

    assert result.found == [(direction.id, 171)]
    assert result.already_set == 0
    assert result.not_found == []
    assert result.ambiguous == []
    # Dry-run must not create a row.
    engine = _engine(db)
    with Session(engine) as session:
        assert get_direction(session, "factory", direction.id) is None


def test_real_run_persists_to_new_row(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path)
    body = _tracker_body_for(direction)
    gh = _FakeGithub([_FakeIssue(171, "[DIRECTION] renamed since creation", body)])
    db = _db_path(tmp_path)

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=False
    )

    assert result.found == [(direction.id, 171)]
    engine = _engine(db)
    with Session(engine) as session:
        row = get_direction(session, "factory", direction.id)
        assert row is not None
        assert row.tracker_issue == 171


def test_real_run_updates_existing_row_without_tracker(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path)
    body = _tracker_body_for(direction)
    gh = _FakeGithub([_FakeIssue(171, "[DIRECTION] whatever", body)])
    db = _db_path(tmp_path)

    # Pre-seed a row (as if the direction had gone through pm-validated at
    # some point) with tracker_issue NULL — the D018 shape.
    engine = _engine(db)
    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id=direction.id,
                slug=direction.slug,
                status="created",
                tracker_issue=None,
            )
        )
        session.commit()

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=False
    )

    assert result.found == [(direction.id, 171)]
    with Session(engine) as session:
        row = get_direction(session, "factory", direction.id)
        assert row is not None
        assert row.tracker_issue == 171
        # Status untouched by the backfill — only tracker_issue changes.
        assert row.status == "created"


def test_direction_with_good_tracker_is_left_alone(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path)
    db = _db_path(tmp_path)
    engine = _engine(db)
    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id=direction.id,
                slug=direction.slug,
                status="pm-validated",
                tracker_issue=42,
            )
        )
        session.commit()

    # Even if a DIFFERENT issue's body happens to also mention this
    # direction's marker (shouldn't happen in practice), an already-resolved
    # direction is never re-searched or overwritten.
    gh = _FakeGithub([_FakeIssue(999, "[DIRECTION] decoy", _tracker_body_for(direction))])

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=False
    )

    assert result.already_set == 1
    assert result.found == []
    with Session(engine) as session:
        row = get_direction(session, "factory", direction.id)
        assert row is not None
        assert row.tracker_issue == 42


def test_no_matching_issue_reports_not_found_and_never_raises(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path)
    db = _db_path(tmp_path)
    gh = _FakeGithub([_FakeIssue(1, "[DIRECTION] unrelated direction", "no marker here")])

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=False
    )

    assert result.not_found == [direction.id]
    assert result.found == []
    engine = _engine(db)
    with Session(engine) as session:
        assert get_direction(session, "factory", direction.id) is None


def test_ambiguous_match_is_skipped_not_guessed(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path)
    body = _tracker_body_for(direction)
    gh = _FakeGithub(
        [
            _FakeIssue(171, "[DIRECTION] copy one", body),
            _FakeIssue(172, "[DIRECTION] copy two", body),
        ]
    )
    db = _db_path(tmp_path)

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=False
    )

    assert result.found == []
    assert result.ambiguous == [(direction.id, [171, 172])]
    engine = _engine(db)
    with Session(engine) as session:
        assert get_direction(session, "factory", direction.id) is None


def test_bad_repo_client_records_error_and_never_raises(tmp_path: Path) -> None:
    class _BrokenGithub:
        def get_repo(self, full_name: str) -> Any:
            raise RuntimeError("boom")

    result = backfill_tracker_issues(
        _app_config(),
        _BrokenGithub(),
        software_factory_root=tmp_path,
        db_path=_db_path(tmp_path),
        dry_run=True,
    )
    assert result.found == []
    assert len(result.errors) == 1
    assert result.errors[0][0] == "repo"


def test_marker_does_not_false_positive_on_similar_id(tmp_path: Path) -> None:
    """`018` must not match `0180` or `018-other-slug` — the marker is exact."""
    direction = _make_direction(tmp_path, title="Alpha")
    other = _make_direction(tmp_path, title="Alpha beta gamma delta")
    db = _db_path(tmp_path)
    # Only `other`'s marker is present in the fake issue body.
    gh = _FakeGithub([_FakeIssue(5, "[DIRECTION] other", _tracker_body_for(other))])

    result = backfill_tracker_issues(
        _app_config(), gh, software_factory_root=tmp_path, db_path=db, dry_run=False
    )

    found_ids = {d for d, _ in result.found}
    assert other.id in found_ids
    assert direction.id not in found_ids
    assert direction.id in result.not_found
