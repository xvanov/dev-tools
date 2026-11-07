"""Auto-intake of user-filed GitHub issues into directions."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from factory.chain.issue_intake import maybe_auto_intake


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "apps" / "sacrifice" / "directions").mkdir(parents=True)
    (tmp_path / "state").mkdir()
    (tmp_path / "apps" / "sacrifice" / "config.yaml").write_text(
        yaml.safe_dump({"name": "sacrifice", "repo": "owner/sacrifice", "default_branch": "main"}),
        encoding="utf-8",
    )
    return tmp_path


class _Label:
    def __init__(self, name: str) -> None:
        self.name = name


class _Issue:
    def __init__(self, number: int, title: str, body: str, labels: list[str]) -> None:
        self.number = number
        self.title = title
        self.body = body
        self.labels = [_Label(n) for n in labels]
        self.added_labels: list[str] = []
        self.comments: list[str] = []

    def add_to_labels(self, name: str) -> None:
        self.added_labels.append(name)
        self.labels.append(_Label(name))

    def create_comment(self, body: str) -> None:
        self.comments.append(body)


class _Repo:
    def __init__(self, issues: list[_Issue]) -> None:
        self._issues = issues

    def get_issues(self, state: str = "open", labels: list[str] | None = None) -> list[_Issue]:
        want = set(labels or [])
        return [i for i in self._issues if want.issubset({lbl.name for lbl in i.labels})]

    def get_issue(self, number: int) -> _Issue:
        return next(i for i in self._issues if i.number == number)


class _Client:
    def __init__(self, repo: _Repo) -> None:
        self._repo = repo

    def get_repo(self, full_name: str) -> _Repo:
        return self._repo


def _factory(repo: _Repo) -> Any:
    return lambda: _Client(repo)


def test_disabled_returns_reason(root: Path) -> None:
    (root / "factory_settings.yaml").write_text(
        "auto_intake:\n  enabled: false\n", encoding="utf-8"
    )
    summary, reason = maybe_auto_intake("sacrifice", root, github_client_factory=_factory(_Repo([])))
    assert summary is None and reason == "disabled"


def test_dry_run_skips(root: Path) -> None:
    summary, reason = maybe_auto_intake(
        "sacrifice", root, dry_run=True, github_client_factory=_factory(_Repo([]))
    )
    assert summary is None and reason == "dry_run"


def test_new_user_report_becomes_direction(root: Path) -> None:
    issue = _Issue(42, "[BUG] Login returns 400 on mobile",
                   "## Why\nLogin fails on Expo Go.\n", ["user-report"])
    summary, reason = maybe_auto_intake(
        "sacrifice", root, github_client_factory=_factory(_Repo([issue]))
    )
    assert reason == "ok"
    assert summary is not None and summary.accepted == [42]
    # Direction dir created on disk.
    dirs = list((root / "apps" / "sacrifice" / "directions").glob("*"))
    assert len(dirs) == 1
    # Issue marked accepted + back-linked so next tick skips it.
    assert "intake-accepted" in issue.added_labels
    assert issue.comments and "factory" in issue.comments[0].lower()


def test_already_accepted_is_skipped(root: Path) -> None:
    issue = _Issue(7, "[BUG] x", "body", ["user-report", "intake-accepted"])
    summary, reason = maybe_auto_intake(
        "sacrifice", root, github_client_factory=_factory(_Repo([issue]))
    )
    assert summary is not None and summary.accepted == [] and summary.skipped == 1
    assert not list((root / "apps" / "sacrifice" / "directions").glob("*"))


def test_max_per_tick_bounds_the_flood(root: Path) -> None:
    (root / "factory_settings.yaml").write_text(
        "auto_intake:\n  max_per_tick: 2\n", encoding="utf-8"
    )
    issues = [_Issue(n, f"[BUG] {n}", "b", ["user-report"]) for n in (1, 2, 3, 4)]
    summary, reason = maybe_auto_intake(
        "sacrifice", root, github_client_factory=_factory(_Repo(issues))
    )
    assert summary is not None and len(summary.accepted) == 2


def test_factory_own_issues_are_not_intaken(root: Path) -> None:
    # direction-tracker / story issues (the factory's own) lack the intake
    # label, so get_issues(labels=[user-report]) never returns them.
    own = [_Issue(90, "D001 tracker", "b", ["direction-tracker"]),
           _Issue(91, "story x", "b", ["story"])]
    summary, reason = maybe_auto_intake(
        "sacrifice", root, github_client_factory=_factory(_Repo(own))
    )
    assert summary is None and reason == "no_new_issues"
