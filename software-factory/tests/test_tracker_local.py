"""Local tracker (factory/tracker.py, operator decision 2026-11-09).

The factory must work WITHOUT GitHub Issues; a non-personal repo (owner not
one of the operator's personal owners) must never have an issue created,
commented, labelled or closed. Live failure this pins: job raven:001
(innergy-dev/raven, Issues disabled) looped in pm-sync on
``GithubException(410, "Issues has been disabled in this repository.")``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from factory import tracker
from factory.app_config import AppConfig, load_app_config
from factory.directions.creator import create_direction

# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #


class _IssuesDisabled(Exception):
    """Shape of PyGithub's GithubException for a repo with Issues off."""

    def __init__(self) -> None:
        self.status = 410
        self.data = {
            "message": "Issues has been disabled in this repository.",
            "documentation_url": "https://docs.github.com/rest/issues/issues#create-an-issue",
        }
        super().__init__(f"410 {self.data}")


class _Repo:
    """Records every call; any Issues call is a test failure unless allowed."""

    def __init__(self, *, has_issues: Any = "absent", raise_410: bool = False) -> None:
        if has_issues != "absent":
            self.has_issues = has_issues
        self.raise_410 = raise_410
        self.issue_calls: list[str] = []
        self._next = 500

    def create_issue(self, **kw: Any) -> Any:
        self.issue_calls.append("create_issue")
        if self.raise_410:
            raise _IssuesDisabled()

        class _I:
            number = self._next

        self._next += 1
        return _I()

    def get_issue(self, n: int) -> Any:
        self.issue_calls.append(f"get_issue:{n}")
        raise AssertionError("no issue may be read for a local-tracker app")

    def get_issues(self, **kw: Any) -> Any:
        self.issue_calls.append("get_issues")
        raise AssertionError("no issue may be listed for a local-tracker app")


class _Client:
    def __init__(self, repo: _Repo) -> None:
        self.repo = repo
        self.get_repo_calls = 0

    def get_repo(self, name: str) -> _Repo:
        self.get_repo_calls += 1
        return self.repo


def _seed(tmp_path: Path, *, repo: str, app: str = "raven", extra: str = "") -> Path:
    d = tmp_path / "apps" / app
    d.mkdir(parents=True)
    (d / "config.yaml").write_text(
        f"name: {app}\nrepo: {repo}\ndefault_branch: main\ncontext_dir: context\n"
        f"app_repo_path: {tmp_path / 'checkout'}\n{extra}",
        encoding="utf-8",
    )
    (tmp_path / "checkout").mkdir(exist_ok=True)
    db = tmp_path / "state" / "factory.db"
    from factory.observability.schema import migrate

    migrate(db)
    from factory.chain.handlers import _engine

    _engine(db)
    return db


def _direction(tmp_path: Path, app: str = "raven") -> Any:
    return create_direction(
        app=app,
        title="Add healthz endpoint",
        type_tag="feature",
        why="Ops wants a stable endpoint.",
        has_ui=False,
        flow_steps=None,
        has_api=True,
        api_spec_lines=['- `GET /healthz` -> 200 {"status":"ok"}'],
        acceptance=["GET /healthz returns 200", "the body is {status: ok}"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
        source="pa",
    ).direction


def _fake_pm(monkeypatch: pytest.MonkeyPatch, calls: list[str]) -> None:
    import factory.chain.pm_sync as P

    def _pm(direction: Any, *a: Any, **k: Any) -> dict[str, Any]:
        calls.append(direction.id)
        return {
            "status": "pm-validated",
            "confidence": 0.9,
            "missing": [],
            "tracker_title": "[DIRECTION] healthz",
            "tracker_body": "PM summary: add a healthz endpoint.",
            "labels": ["feature"],
            "priority": "p2",
            "child_stories": [
                {
                    "title": "Add healthz route",
                    "scope": "backend",
                    "rationale": "Needed by ops.",
                    "points": 2,
                    "chain_kind": "tdd",
                }
            ],
        }

    monkeypatch.setattr(P, "_call_pm_persona", _pm)


def _stories(db: Path) -> list[sqlite3.Row]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT id, tracker, github_issue_number, github_branch, story_file_path, slug "
            "FROM stories ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #


@pytest.mark.real_tracker_policy
def test_default_tracker_is_owner_derived(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FACTORY_PERSONAL_OWNERS", raising=False)
    assert tracker.default_tracker("xvanov/sacrifice") == "github_issues"
    assert tracker.default_tracker("XVANOV/x") == "github_issues"
    assert tracker.default_tracker("innergy-dev/raven") == "local"
    assert tracker.default_tracker(None) == "local"  # unclassifiable -> fail safe
    assert tracker.default_tracker("garbage") == "local"


@pytest.mark.real_tracker_policy
def test_work_owner_in_token_map_is_not_personal(monkeypatch: pytest.MonkeyPatch) -> None:
    """FACTORY_GH_OWNER_MAP picks tokens and carries WORK owners too."""
    monkeypatch.delenv("FACTORY_PERSONAL_OWNERS", raising=False)
    monkeypatch.setenv("FACTORY_GH_OWNER_MAP", "innergy-dev=work-user")
    assert tracker.default_tracker("innergy-dev/raven") == "local"


@pytest.mark.real_tracker_policy
def test_personal_owners_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_PERSONAL_OWNERS", "alice, Bob")
    assert tracker.default_tracker("bob/x") == "github_issues"
    assert tracker.default_tracker("xvanov/x") == "local"


@pytest.mark.real_tracker_policy
def test_explicit_config_wins_except_issues_on_a_work_repo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FACTORY_PERSONAL_OWNERS", raising=False)
    personal_local = AppConfig(name="a", repo="xvanov/a", tracker="local")
    assert tracker.configured_tracker(personal_local) == "local"
    assert tracker.tracker_source(personal_local) == "config"
    work_issues = AppConfig(name="r", repo="innergy-dev/raven", tracker="github_issues")
    assert tracker.configured_tracker(work_issues) == "local"
    assert tracker.uses_github_issues(work_issues) is False
    with pytest.raises(ValueError, match="not a personal repo"):
        tracker.check_tracker_allowed("innergy-dev/raven", "github_issues")
    tracker.check_tracker_allowed("innergy-dev/raven", "local")


def test_parse_tracker() -> None:
    assert tracker.parse_tracker(None) is None
    assert tracker.parse_tracker("github-issues") == "github_issues"
    assert tracker.parse_tracker("LOCAL") == "local"
    with pytest.raises(ValueError):
        tracker.parse_tracker("jira")


def test_has_issues_false_falls_back_to_local() -> None:
    cfg = AppConfig(name="p", repo="xvanov/p")  # conftest: personal -> github_issues
    assert tracker.uses_github_issues(cfg, _Client(_Repo(has_issues=True))) is True
    tracker.reset_cache()
    assert tracker.uses_github_issues(cfg, _Client(_Repo(has_issues=False))) is False
    # memoised: no client needed for the next decision
    assert tracker.uses_github_issues(cfg, None) is False


def test_issues_disabled_error_detection() -> None:
    assert tracker.is_issues_disabled_error(_IssuesDisabled())
    assert not tracker.is_issues_disabled_error(RuntimeError("boom"))

    class _Gone(Exception):
        status = 410

    assert not tracker.is_issues_disabled_error(_Gone("repository moved"))
    assert tracker.is_issues_disabled_error(RuntimeError("the repo has disabled issues"))


# --------------------------------------------------------------------------- #
# Local store
# --------------------------------------------------------------------------- #


def test_local_store_round_trip(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    assert tracker.get_item(db, app="a", kind="direction", ref="001") is None
    item = tracker.upsert_item(
        db, app="a", kind="direction", ref="001", title="T", body="B", labels=["x", "x", "y"]
    )
    assert (
        tracker.upsert_item(
            db, app="a", kind="direction", ref="001", title="T2", body="B2", labels=["y"]
        )
        == item
    )
    assert tracker.add_note(db, app="a", kind="direction", ref="001", body="n1")
    assert not tracker.add_note(db, app="a", kind="direction", ref="001", body="n1")  # deduped
    assert not tracker.add_note(db, app="a", kind="direction", ref="nope", body="n")
    view = tracker.item_view(db, app="a", kind="direction", ref="001")
    assert view is not None
    assert view["title"] == "T2" and view["labels"] == ["y"] and view["state"] == "open"
    assert [n["body"] for n in view["notes"]] == ["n1"]
    assert tracker.close_item(db, app="a", kind="direction", ref="001", note="done")
    assert not tracker.close_item(db, app="a", kind="direction", ref="001")  # idempotent
    assert tracker.list_items(db, app="a", state="closed")[0]["ref"] == "001"
    assert tracker.list_items(db, app="a", state="open") == []


def test_reads_never_create_the_tables(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    sqlite3.connect(db).close()
    assert tracker.get_item(db, app="a", kind="story", ref=1) is None
    assert tracker.list_items(db) == []
    assert tracker.notes(db, 1) == []
    conn = sqlite3.connect(db)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert "tracker_items" not in tables


# --------------------------------------------------------------------------- #
# pm-sync end to end
# --------------------------------------------------------------------------- #


@pytest.mark.real_tracker_policy
def test_work_repo_pm_sync_never_touches_issues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """innergy-dev/raven with no tracker config: derived local; stories spawn
    with their own ids as identity; GitHub Issues are never called."""
    monkeypatch.delenv("FACTORY_PERSONAL_OWNERS", raising=False)
    from factory.chain.pm_sync import pm_sync

    db = _seed(tmp_path, repo="innergy-dev/raven")
    d = _direction(tmp_path)
    pm_calls: list[str] = []
    _fake_pm(monkeypatch, pm_calls)
    repo = _Repo(has_issues=False)
    client = _Client(repo)

    summary = pm_sync("raven", tmp_path, github_client=client, state_db_path=db)

    assert summary.errors == []
    assert summary.validated == 1
    assert repo.issue_calls == []
    assert client.get_repo_calls == 0  # a local app never even looks GitHub Issues up
    rows = _stories(db)
    assert len(rows) == 1
    s = rows[0]
    assert s["tracker"] == "local" and s["github_issue_number"] is None
    assert s["github_branch"] == f"story/{s['id']}-{s['slug']}"
    assert s["story_file_path"] == f"stories/{s['id']}-{s['slug']}.md"
    direction_item = tracker.item_view(db, app="raven", kind="direction", ref=d.id)
    assert direction_item is not None
    assert "PM summary" in direction_item["summary"]
    assert "no GitHub issue exists" in direction_item["summary"]
    assert tracker.get_item(db, app="raven", kind="story", ref=s["id"]) is not None

    from factory.chain.branch import feature_branch_name
    from factory.chain.handlers import get_story
    from factory.chain.state_machine import story_number

    story = get_story(int(s["id"]), db)
    assert story is not None and story_number(story) == s["id"]
    assert feature_branch_name(story_number(story), story.slug).endswith(f"-{s['id']}-{s['slug']}")


def test_raven_410_loop_recovers_on_next_pm_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The raven:001 failure: an app that resolves to github_issues (here: a
    misconfigured one, has_issues unknown) on a repo whose Issues are off.

    Before: create_issue raised the 410, the direction stayed ``created`` and
    the next tick paid for the PM run again. After: the 410 flips the app to
    the local tracker, the direction is pm-validated and its story spawned —
    on the very pass that hit the 410, and a resumed/next pass is a no-op."""
    from factory.chain.pm_sync import pm_sync
    from factory.directions.watcher import pending_directions

    db = _seed(tmp_path, repo="xvanov/raven-misconfigured")
    _direction(tmp_path)
    pm_calls: list[str] = []
    _fake_pm(monkeypatch, pm_calls)
    repo = _Repo(raise_410=True)  # no has_issues attribute: only the 410 tells

    summary = pm_sync("raven", tmp_path, github_client=_Client(repo), state_db_path=db)

    assert summary.errors == [], summary.errors
    assert repo.issue_calls == ["create_issue"]  # tried once, never again
    rows = _stories(db)
    assert len(rows) == 1 and rows[0]["tracker"] == "local"
    assert [d.status for d in pending_directions("raven", tmp_path, db)] == []

    again = pm_sync("raven", tmp_path, github_client=_Client(repo), state_db_path=db)
    assert again.processed == 0
    assert pm_calls == [pm_calls[0]]  # the PM was not paid for twice
    assert repo.issue_calls == ["create_issue"]


def test_raven_job_status_reports_local_tracker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain.pm_sync import pm_sync
    from factory.jobs.status import job_status
    from factory.jobs.submit import SubmitRequest, submit_job

    db = _seed(
        tmp_path,
        repo="innergy-dev/raven",
        extra="tracker: local\ngates:\n  test_command: none\n",
    )
    job = submit_job(
        tmp_path,
        SubmitRequest(
            title="Add healthz",
            ask="Add GET /healthz returning 200.",
            source="pa",
            app="raven",
            done=["GET /healthz returns 200"],
        ),
    )
    _fake_pm(monkeypatch, [])
    pm_sync("raven", tmp_path, github_client=_Client(_Repo()), state_db_path=db)

    st = job_status(tmp_path, job["job_id"], github=False)
    assert st["tracker"]["name"] == "local"
    assert st["tracker"]["source"] == "config"
    # The submitted ask is too thin for the backpressure gate: what a GitHub
    # tracker issue would have said ("Needs direction. Missing: ...") is in
    # the status the PA's Build page reads, with no issue anywhere.
    assert st["state"] == "needs_human"
    view = st["tracker"]["direction"]
    assert view["title"] == "[DIRECTION] Add healthz"
    assert "needs-direction" in view["labels"]
    assert view["notes"] and view["notes"][-1]["body"].startswith("**Needs direction.**")


def test_needs_direction_note_is_local_and_deduped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.directions.parser import parse_direction_dir
    from factory.directions.tracker_issue import record_needs_direction

    db = _seed(tmp_path, repo="innergy-dev/raven", extra="tracker: local\n")
    d = _direction(tmp_path)
    direction = parse_direction_dir("raven", d.dir_path, software_factory_root=tmp_path)
    cfg = load_app_config("raven", tmp_path)
    repo = _Repo()
    for _ in range(2):
        assert record_needs_direction(direction, ["flow"], cfg, _Client(repo)) == 0
    assert repo.issue_calls == []
    view = tracker.item_view(db, app="raven", kind="direction", ref=d.id)
    assert view is not None and "needs-direction" in view["labels"]
    assert len(view["notes"]) == 1 and "Missing: flow" in view["notes"][0]["body"]


def test_close_paths_are_local(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from factory.chain.pm_sync import pm_sync
    from factory.directions.parser import parse_direction_dir
    from factory.directions.tracker_issue import (
        close_direction_issues,
        close_story_issue,
        reconcile_completed_issues,
    )

    db = _seed(tmp_path, repo="innergy-dev/raven", extra="tracker: local\n")
    d = _direction(tmp_path)
    _fake_pm(monkeypatch, [])
    repo = _Repo()
    pm_sync("raven", tmp_path, github_client=_Client(repo), state_db_path=db)
    cfg = load_app_config("raven", tmp_path)
    sid = _stories(db)[0]["id"]

    from factory.chain.handlers import get_story

    story = get_story(int(sid), db)
    assert close_story_issue(story, cfg, _Client(repo), db_path=db) is True
    assert tracker.get_item(db, app="raven", kind="story", ref=sid)["state"] == "closed"

    direction = parse_direction_dir("raven", d.dir_path, software_factory_root=tmp_path)
    report = close_direction_issues(direction, cfg, _Client(repo), db_path=db, by="test")
    assert report["tracker_closed"] == f"local:{d.id}" and report["errors"] == []
    assert tracker.get_item(db, app="raven", kind="direction", ref=d.id)["state"] == "closed"

    rep = reconcile_completed_issues(cfg, _Client(repo), software_factory_root=tmp_path, db_path=db)
    assert rep["errors"] == []
    assert repo.issue_calls == []


# --------------------------------------------------------------------------- #
# Other touchpoints
# --------------------------------------------------------------------------- #


def test_status_issue_is_local(tmp_path: Path) -> None:
    from factory.chain.factory_status import update_status_issue

    db = _seed(tmp_path, repo="innergy-dev/raven", extra="tracker: local\n")
    repo = _Repo()
    assert update_status_issue("raven", tmp_path, None, db_path=db) == 0
    assert repo.issue_calls == []
    item = tracker.get_item(db, app="raven", kind="status", ref="live")
    assert item is not None and item["title"] == "[FACTORY] raven live status"


def test_deploy_p0_is_local(tmp_path: Path) -> None:
    from factory.deploy.orchestrator import _file_p0_issue

    db = _seed(tmp_path, repo="innergy-dev/raven", extra="tracker: local\n")
    cfg = load_app_config("raven", tmp_path)
    repo = _Repo()
    n = _file_p0_issue(
        app="raven",
        merged_pr_number=7,
        merged_sha="abc",
        error="boom",
        github_client=_Client(repo),
        repo=cfg.repo,
        dry_run=False,
        app_config=cfg,
        db_path=db,
    )
    assert n is None and repo.issue_calls == []
    items = tracker.list_items(db, app="raven", kind="escalation")
    assert items and "Deploy failed for PR #7" in items[0]["title"]


def test_intake_skips_local_apps(tmp_path: Path) -> None:
    from factory.chain.issue_intake import maybe_auto_intake

    _seed(tmp_path, repo="innergy-dev/raven", extra="tracker: local\n")
    (tmp_path / "factory_settings.yaml").write_text(
        "auto_intake:\n  enabled: true\n", encoding="utf-8"
    )
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)

    def _factory() -> Any:
        raise AssertionError("no GitHub client for a local-tracker app")

    assert maybe_auto_intake("raven", tmp_path, github_client_factory=_factory) == (
        None,
        "tracker_local",
    )


def test_ingest_issue_refused_for_local_app(tmp_path: Path) -> None:
    from factory.directions.ingester import ingest_github_direction_issue

    _seed(tmp_path, repo="innergy-dev/raven", extra="tracker: local\n")
    with pytest.raises(ValueError, match="local tracker"):
        ingest_github_direction_issue(1, "raven", tmp_path, _Client(_Repo()))


def test_story_number_identity() -> None:
    from factory.chain.state_machine import StoryRecord, story_number

    assert story_number(StoryRecord(id=9, github_issue_number=42, slug="s")) == 42
    assert story_number(StoryRecord(id=9, tracker="local", slug="s")) == 9
    assert story_number(StoryRecord(id=9, slug="s")) is None  # legacy dry-run shape


# --------------------------------------------------------------------------- #
# factory app add / set
# --------------------------------------------------------------------------- #


@pytest.mark.real_tracker_policy
def test_app_set_tracker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FACTORY_PERSONAL_OWNERS", raising=False)
    from factory.cli_apps import AppAddError, set_app, show_app

    _seed(tmp_path, repo="innergy-dev/raven")
    assert show_app(tmp_path, "raven")["tracker"] == "local"
    assert show_app(tmp_path, "raven")["tracker_source"] == "derived"
    with pytest.raises(AppAddError) as exc:
        set_app(root=tmp_path, app="raven", tracker="github_issues")
    assert exc.value.code == "invalid_tracker"
    res = set_app(root=tmp_path, app="raven", tracker="local")
    assert res["tracker"] == "local" and res["tracker_source"] == "config"
    assert "tracker" in res["changed"]
    assert load_app_config("raven", tmp_path).tracker == "local"


@pytest.mark.real_tracker_policy
def test_render_config_writes_derived_tracker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FACTORY_PERSONAL_OWNERS", raising=False)
    import yaml

    from factory.app_detect import Detection
    from factory.cli_apps import render_config
    from factory.delivery import DeliveryConfig

    for repo, want in (("innergy-dev/raven", "local"), ("xvanov/x", "github_issues")):
        text = render_config(
            name="x",
            repo=repo,
            app_repo_path="../x",
            default_branch="main",
            delivery=DeliveryConfig(),
            detection=Detection(),
        )
        assert AppConfig.model_validate(yaml.safe_load(text)).tracker == want


def test_failed_tracker_write_does_not_repay_the_pm_every_tick(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """raven:001 (2026-11-10): a tracker write failing AFTER a paid PM call left the
    direction ``created``; every serve tick paid for a fresh PM run (9 in 90 min,
    the hourly budget only slowed it). The PM answer for an unchanged direction is
    reused; the model is called once."""
    from factory.chain.pm_sync import pm_sync

    db = _seed(tmp_path, repo="xvanov/raven-personal")
    _direction(tmp_path)
    pm_calls: list[str] = []
    _fake_pm(monkeypatch, pm_calls)

    class _Down(Exception):
        status = 404

    repo = _Repo(has_issues=True)
    repo.create_issue = lambda **kw: (_ for _ in ()).throw(_Down("404 Not Found"))  # type: ignore[method-assign]

    for _ in range(3):
        summary = pm_sync("raven", tmp_path, github_client=_Client(repo), state_db_path=db)
        assert summary.errors
    assert len(pm_calls) == 1
