"""open_or_update_tracker_issue idempotency + needs-direction comment."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from factory.app_config import AppConfig, DeployConfig
from factory.directions.creator import create_direction
from factory.directions.parser import (
    MissingDirection,
    parse_direction_dir,
    resolve_direction_chain,
)
from factory.directions.tracker_issue import (
    _format_tracker_body,
    open_or_update_tracker_issue,
    record_needs_direction,
)


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeIssue:
    def __init__(self, number: int, title: str, body: str, labels: list[str]) -> None:
        self.number = number
        self.title = title
        self.body = body
        self.labels = [_FakeLabel(lbl) for lbl in labels]
        self.comments: list[str] = []
        self.edit_calls: list[dict[str, Any]] = []

    def edit(
        self,
        *,
        title: str | None = None,
        body: str | None = None,
        labels: list[str] | None = None,
    ) -> None:
        if title is not None:
            self.title = title
        if body is not None:
            self.body = body
        if labels is not None:
            self.labels = [_FakeLabel(lbl) for lbl in labels]
        self.edit_calls.append(
            {"title": self.title, "body": self.body, "labels": [lb.name for lb in self.labels]}
        )

    def create_comment(self, body: str) -> None:
        self.comments.append(body)

    def get_comments(self) -> list[Any]:
        class _C:
            def __init__(self, body: str) -> None:
                self.body = body

        return [_C(b) for b in self.comments]


class _FakeRepo:
    def __init__(self) -> None:
        self.issues: dict[int, _FakeIssue] = {}
        self.create_calls: list[dict[str, Any]] = []
        self._next = 100

    def create_issue(self, *, title: str, body: str, labels: list[str]) -> _FakeIssue:
        n = self._next
        self._next += 1
        issue = _FakeIssue(n, title, body, labels)
        self.issues[n] = issue
        self.create_calls.append({"title": title, "body": body, "labels": labels})
        return issue

    def get_issue(self, n: int) -> _FakeIssue:
        return self.issues[n]


class _FakeGithub:
    def __init__(self) -> None:
        self.repo = _FakeRepo()
        self.get_repo_calls: list[str] = []

    def get_repo(self, full_name: str) -> _FakeRepo:
        self.get_repo_calls.append(full_name)
        return self.repo


def _seed(tmp_path: Path):  # type: ignore[no-untyped-def]
    out = create_direction(
        app="sacrifice",
        title="Add healthz",
        type_tag="feature",
        why="Smoke test.",
        has_ui=False,
        flow_steps=None,
        has_api=True,
        api_spec_lines=["- POST /healthz -> 200"],
        acceptance=["AC"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    return parse_direction_dir("sacrifice", out.dir_path)


def _app_config() -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="xvanov/sacrifice",
        default_branch="main",
        context_dir="context",
        deploy=DeployConfig(enabled=False),
        models={},
    )


def test_creates_issue_on_first_call(tmp_path: Path) -> None:
    direction = _seed(tmp_path)
    gh = _FakeGithub()
    cfg = _app_config()

    pm_result = {
        "type": "feature",
        "priority": "p2",
        "has_sufficient_backpressure": True,
        "missing": [],
        "tracker_title": "Add healthz endpoint",
        "tracker_body": "We need /healthz for smoke tests.",
        "child_stories": [{"title": "stub", "scope": "backend", "rationale": "x"}],
        "labels": ["feature", "priority/p2"],
        "confidence": 0.8,
    }
    number = open_or_update_tracker_issue(direction, cfg, gh, pm_result=pm_result)
    assert number == 100
    assert len(gh.repo.create_calls) == 1
    call = gh.repo.create_calls[0]
    assert call["title"].startswith("[DIRECTION]")
    assert "feature" in call["labels"]
    assert "direction-tracker" in call["labels"]
    assert "priority/p2" in call["labels"]
    # The body must include the PM's summary text.
    assert "smoke tests" in call["body"]
    # state.yaml has the issue number persisted.
    re_parsed = parse_direction_dir("sacrifice", direction.dir_path)
    assert re_parsed.state["tracker_issue"] == 100


def test_state_yaml_write_failure_after_issue_creation_does_not_raise(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """A state.yaml write failure right after GitHub issue creation must be
    best-effort, matching ``_persist_tracker_issue``'s guard on the DB write.

    Before this hardening, an uncaught exception from ``merge_state`` here
    would propagate out of ``open_or_update_tracker_issue`` and abort the rest
    of the caller's pm-sync iteration — including the ``mark_direction_status``
    call that is the only other place a brand-new direction's tracker_issue
    gets persisted — leaving a real, already-created GitHub issue recorded
    nowhere in factory state (the D018 shape).
    """
    direction = _seed(tmp_path)
    gh = _FakeGithub()
    cfg = _app_config()

    import factory.directions.tracker_issue as ti_mod

    def _boom(*args: Any, **kwargs: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(ti_mod, "merge_state", _boom)

    pm_result = {
        "type": "feature",
        "priority": "p2",
        "has_sufficient_backpressure": True,
        "missing": [],
        "tracker_title": "Add healthz endpoint",
        "tracker_body": "We need /healthz for smoke tests.",
        "child_stories": [],
        "labels": ["feature", "priority/p2"],
        "confidence": 0.8,
    }
    # Must not raise, and must still return the real issue number — the
    # GitHub issue was already created before the failing write.
    number = open_or_update_tracker_issue(direction, cfg, gh, pm_result=pm_result)
    assert number == 100
    assert len(gh.repo.create_calls) == 1


def test_idempotent_no_duplicate_issue(tmp_path: Path) -> None:
    direction = _seed(tmp_path)
    gh = _FakeGithub()
    cfg = _app_config()
    pm_result = {
        "type": "feature",
        "priority": "p2",
        "has_sufficient_backpressure": True,
        "missing": [],
        "tracker_title": "Add healthz endpoint",
        "tracker_body": "We need /healthz.",
        "child_stories": [],
        "labels": ["feature", "priority/p2"],
        "confidence": 0.8,
    }
    n1 = open_or_update_tracker_issue(direction, cfg, gh, pm_result=pm_result)
    # Re-parse so the fresh state.yaml is loaded into the direction
    direction = parse_direction_dir("sacrifice", direction.dir_path)

    n2 = open_or_update_tracker_issue(direction, cfg, gh, pm_result=pm_result)
    assert n1 == n2 == 100
    assert len(gh.repo.create_calls) == 1
    # The existing issue's edit was called on the second call.
    assert len(gh.repo.issues[100].edit_calls) == 1


def test_record_needs_direction_labels_and_comments(tmp_path: Path) -> None:
    direction = _seed(tmp_path)
    gh = _FakeGithub()
    cfg = _app_config()
    pm_result = {
        "type": "feature",
        "priority": "p2",
        "has_sufficient_backpressure": False,
        "missing": ["user_flow", "acceptance_criteria"],
        "tracker_title": "Vague request",
        "tracker_body": "_(needs more info)_",
        "child_stories": [],
        "labels": ["feature", "priority/p2"],
        "confidence": 0.4,
    }
    number = record_needs_direction(
        direction,
        ["user_flow", "acceptance_criteria"],
        cfg,
        gh,
        pm_result=pm_result,
    )
    assert number == 100
    issue = gh.repo.issues[number]
    assert "needs-direction" in [lbl.name for lbl in issue.labels]
    assert any("user_flow" in c for c in issue.comments)


def test_record_needs_direction_does_not_repost_identical_comment(tmp_path: Path) -> None:
    """Re-validating an unchanged direction must not append the same comment
    again — auto pm-sync runs every tick and was spamming tracker issues."""
    direction = _seed(tmp_path)
    gh = _FakeGithub()
    cfg = _app_config()
    for _ in range(3):
        record_needs_direction(direction, ["user_flow"], cfg, gh)
        direction = parse_direction_dir("sacrifice", direction.dir_path)
    issue = gh.repo.issues[100]
    assert len(issue.comments) == 1

    # A DIFFERENT missing-list is new information and must post.
    record_needs_direction(direction, ["api_spec"], cfg, gh)
    assert len(issue.comments) == 2


# ─── tracker body chain rendering tests ───────────────────────────────


def _make_direction(
    root: Path,
    id_slug: str,
    *,
    parent_direction: str | None = None,
    tracker_issue_num: int | None = None,
) -> Any:
    import yaml as _yaml

    base = root / "apps" / "sacrifice" / "directions" / id_slug
    base.mkdir(parents=True)
    fm = {
        "title": id_slug.replace("-", " ").title(),
        "type": "feature",
        "priority": "p2",
        "explore": False,
        "created_at": "2025-01-01T00:00:00+00:00",
    }
    if parent_direction:
        fm["parent_direction"] = parent_direction
    md = (
        f"---\n{_yaml.safe_dump(fm, sort_keys=False).strip()}\n---\n\n"
        f"# {fm['title']}\n\n## Why\n\nReason.\n\n## Acceptance Criteria\n\n- AC1\n"
    )
    (base / "direction.md").write_text(md, encoding="utf-8")
    if tracker_issue_num is not None:
        (base / "state.yaml").write_text(
            _yaml.safe_dump({"status": "pm-validated", "tracker_issue": tracker_issue_num}),
            encoding="utf-8",
        )
    return parse_direction_dir("sacrifice", base)


def test_tracker_body_renders_chain_line(tmp_path: Path) -> None:
    _make_direction(
        tmp_path, "060-parent", tracker_issue_num=42
    )
    child = _make_direction(tmp_path, "061-child", parent_direction="060-parent")
    chain = resolve_direction_chain(child, tmp_path)

    body = _format_tracker_body(
        child,
        pm_summary="summary text",
        child_issue_numbers=[100],
        direction_chain=chain,
    )
    assert "**Chain:**" in body
    # Parent renders as `id-slug` #42 (bare hash, no markdown-link parens)
    assert "`060-parent` #42" in body
    # Current direction renders as **THIS**
    assert "**THIS**" in body
    # The chain arrow between parent and child
    assert " ← " in body


def test_tracker_body_no_chain_when_parent_not_set(tmp_path: Path) -> None:
    direction = _make_direction(tmp_path, "062-standalone")
    body = _format_tracker_body(
        direction,
        pm_summary="summary text",
        child_issue_numbers=[],
    )
    assert "**Chain:**" not in body


def test_tracker_body_parent_without_tracker_issue_no_hash(tmp_path: Path) -> None:
    # Parent has no tracker_issue in state.yaml
    _make_direction(tmp_path, "063-parent", tracker_issue_num=None)
    child = _make_direction(tmp_path, "064-child", parent_direction="063-parent")
    chain = resolve_direction_chain(child, tmp_path)

    body = _format_tracker_body(
        child,
        pm_summary="summary text",
        child_issue_numbers=[],
        direction_chain=chain,
    )
    assert "**Chain:**" in body
    # Parent id-slug present but NO #N following it
    assert "`063-parent`" in body
    assert "`063-parent` #" not in body


def test_tracker_body_missing_parent_sentinel_in_chain(tmp_path: Path) -> None:
    child = _make_direction(tmp_path, "065-child", parent_direction="999-missing")
    chain = resolve_direction_chain(child, tmp_path)
    assert isinstance(chain[0], MissingDirection)

    body = _format_tracker_body(
        child,
        pm_summary="summary text",
        child_issue_numbers=[],
        direction_chain=chain,
    )
    assert "**Chain:**" in body
    assert "999-missing" in body
