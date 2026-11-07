"""Tests for worktree_orphans detector."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from factory.manager.detectors.worktree_orphans import worktree_orphans


def _make_worktree_dir(root: Path, name: str) -> Path:
    d = root / "state" / "worktrees" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _make_db(root: Path, stories: list[tuple[int, str]]) -> Path:
    db_path = root / "state" / "factory.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE stories (id INTEGER PRIMARY KEY, state TEXT NOT NULL)"
    )
    for sid, state in stories:
        conn.execute("INSERT INTO stories VALUES (?, ?)", (sid, state))
    conn.commit()
    conn.close()
    return db_path


def test_no_worktrees_dir_returns_empty(tmp_path: Path) -> None:
    result = worktree_orphans(root=tmp_path)
    assert result == []


def test_empty_worktrees_dir_returns_empty(tmp_path: Path) -> None:
    wt_dir = tmp_path / "state" / "worktrees"
    wt_dir.mkdir(parents=True, exist_ok=True)
    result = worktree_orphans(root=tmp_path)
    assert result == []


def test_single_worktree_no_db_returns_missing(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "sacrifice-42-my-cool-feature")
    result = worktree_orphans(root=tmp_path)
    assert len(result) == 1
    row = result[0]
    assert row["story_id"] == 42
    assert row["app"] == "sacrifice"
    assert row["slug"] == "my-cool-feature"
    assert row["db_state"] == "missing"


def test_worktree_with_matching_db_row(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "sacrifice-10-some-story")
    _make_db(tmp_path, [(10, "dev_in_progress")])
    result = worktree_orphans(root=tmp_path)
    assert len(result) == 1
    assert result[0]["db_state"] == "dev_in_progress"
    assert result[0]["story_id"] == 10


def test_worktree_with_done_story(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "factory-5-build-fms")
    _make_db(tmp_path, [(5, "done")])
    result = worktree_orphans(root=tmp_path)
    assert result[0]["db_state"] == "done"


def test_worktree_id_missing_from_db_returns_missing(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "sacrifice-99-orphan")
    _make_db(tmp_path, [(1, "done")])  # story 99 not present
    result = worktree_orphans(root=tmp_path)
    assert result[0]["db_state"] == "missing"


def test_directory_not_matching_pattern_ignored(tmp_path: Path) -> None:
    # Create a dir that doesn't match <app>-<id>-<slug>
    (tmp_path / "state" / "worktrees" / "context-refresh").mkdir(parents=True, exist_ok=True)
    (tmp_path / "state" / "worktrees" / "dry_run_scratch").mkdir(parents=True, exist_ok=True)
    result = worktree_orphans(root=tmp_path)
    assert result == []


def test_multiple_worktrees_all_returned(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "sacrifice-1-story-one")
    _make_worktree_dir(tmp_path, "sacrifice-2-story-two")
    _make_db(tmp_path, [(1, "test_in_progress"), (2, "done")])
    result = worktree_orphans(root=tmp_path)
    assert len(result) == 2
    states = {r["story_id"]: r["db_state"] for r in result}
    assert states[1] == "test_in_progress"
    assert states[2] == "done"


def test_path_field_is_absolute(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "factory-7-some-feature")
    result = worktree_orphans(root=tmp_path)
    assert Path(result[0]["path"]).is_absolute()


def test_files_in_worktrees_dir_ignored(tmp_path: Path) -> None:
    wt_dir = tmp_path / "state" / "worktrees"
    wt_dir.mkdir(parents=True, exist_ok=True)
    # Create a file (not a dir) in the worktrees dir — should be skipped
    (wt_dir / "sacrifice-3-some-story").write_text("not a dir", encoding="utf-8")
    result = worktree_orphans(root=tmp_path)
    assert result == []


def test_app_field_extracted_correctly(tmp_path: Path) -> None:
    _make_worktree_dir(tmp_path, "my-app-55-feature-slug")
    result = worktree_orphans(root=tmp_path)
    assert result[0]["app"] == "my-app"
    assert result[0]["story_id"] == 55
    assert result[0]["slug"] == "feature-slug"
