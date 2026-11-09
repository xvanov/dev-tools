"""JOBS-API v1.7: serve's job status/list and app list do no GitHub or subprocess.

The CLI still asks GitHub live. ``factory serve`` (``run_cli``) reads the
background snapshot in :mod:`factory.jobs.read_cache` and the local db.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest

import factory.cli_apps as cli_apps
import factory.cli_jobs as cli_jobs
import factory.jobs.github as gh_mod
import factory.scheduler.serve as serve_mod
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.jobs.github import PRInfo
from factory.jobs.read_cache import RepoSnap, clear, refresh, seed_coverage, seed_repo
from factory.jobs.status import job_status
from factory.scheduler import api
from factory.scheduler.coverage import TickCoverage

_AS_OF = "2026-11-08T12:00:00+00:00"
_PR_URL = "https://github.com/acme/demo/pull/7"


@pytest.fixture(autouse=True)
def _isolated_cache() -> Any:
    clear()
    yield
    clear()


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    app = tmp_path / "apps" / "demo"
    app.mkdir(parents=True)
    (app / "config.yaml").write_text(
        "name: demo\nrepo: acme/demo\ndelivery:\n  default: auto_merge\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setattr(cli_apps, "_FACTORY_ROOT", tmp_path)
    return tmp_path


def _direction(root: Path, n: int, *, title: str = "Job") -> str:
    did = f"{n:03d}"
    d = root / "apps" / "demo" / "directions" / f"{did}-job"
    d.mkdir(parents=True)
    (d / "direction.md").write_text(
        f"---\nsource: pa\ntitle: {title} {n}\nexternal_id: e{n}\n---\n\nAsk {n}.\n",
        encoding="utf-8",
    )
    (d / "state.yaml").write_text(
        "status: created\ncreated_at: '2026-11-08T00:00:00+00:00'\n",
        encoding="utf-8",
    )
    return did


def _story(root: Path, direction_id: str, state: str, **kw: Any) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id=direction_id,
            app="demo",
            title="t",
            slug=kw.pop("slug", f"s-{direction_id}"),
            scope="backend",
            state=state,
            **kw,
        ),
        root / "state" / "factory.db",
    )


def _merged_snap() -> RepoSnap:
    return RepoSnap(
        repo="acme/demo",
        as_of=_AS_OF,
        index_ok=True,
        prs={7: PRInfo(7, "merged", _PR_URL, "feature")},
        errors=[],
        rollups={},
        branches={},
        contains={},
        api={},
    )


def _seed_host() -> None:
    seed_repo(_merged_snap())
    seed_coverage(TickCoverage(["demo"], True, timers=lambda: (_ for _ in ()).throw(AssertionError("timers"))))


def _guard_subprocesses(monkeypatch: pytest.MonkeyPatch) -> None:
    real = subprocess.run

    def run(args: Any, *a: Any, **k: Any) -> Any:
        cmd = args if isinstance(args, (list, tuple)) else [str(args)]
        head = str(cmd[0]).lower() if cmd else ""
        if any(bit in head for bit in ("gh", "git", "systemctl")):
            raise AssertionError(f"subprocess during a serve read: {cmd[:6]}")
        return real(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(gh_mod, "_run_gh", lambda args: (_ for _ in ()).throw(AssertionError(f"gh {args}")))
    monkeypatch.setattr(
        serve_mod, "systemd_timers_active", lambda: (_ for _ in ()).throw(AssertionError("systemctl"))
    )


def _json(res: dict[str, Any]) -> dict[str, Any]:
    assert res["code"] == 0, res
    return json.loads(res["stdout"])


def test_cached_status_uses_the_snapshot_and_not_github(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _direction(root, 1, title="Ship it")
    _story(root, "001", StoryState.PR_OPEN.value, github_pr_number=7, github_branch="feature")
    _seed_host()
    _guard_subprocesses(monkeypatch)

    st = job_status(root, "demo:001", cached=True)
    assert st["state"] == "done" and st["merged"] is True
    assert st["stories"][0]["pr_state"] == "merged"
    assert st["stories"][0]["pr_url"] == _PR_URL
    assert st["github_as_of"] == _AS_OF

    listed = _json(api.run_cli(["job", "list", "--json"]))
    assert listed["jobs"][0]["state"] == "done"
    assert listed["jobs"][0]["github_as_of"] == _AS_OF
    status = _json(api.run_cli(["job", "status", "demo:001", "--json"]))
    assert status["state"] == "done" and status["github_as_of"] == _AS_OF
    apps = _json(api.run_cli(["app", "list", "--json"]))
    assert apps["apps"][0]["ticked"] is True


def test_cli_status_asks_github_live_and_ignores_the_snapshot(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _direction(root, 1)
    _story(root, "001", StoryState.PR_OPEN.value, github_pr_number=7)
    seed_repo(_merged_snap())  # would say merged, if the CLI consulted it
    calls: list[list[str]] = []

    def run(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        if args[:2] == ["pr", "list"]:
            body = json.dumps(
                [{"number": 7, "state": "OPEN", "url": _PR_URL, "headRefName": "feature"}]
            )
            return subprocess.CompletedProcess(args, 0, body, "")
        return subprocess.CompletedProcess(args, 1, "", "no")

    monkeypatch.setattr(gh_mod, "_run_gh", run)
    st = job_status(root, "demo:001")
    assert calls and calls[0][:2] == ["pr", "list"]
    assert st["state"] == "in_progress"
    assert st["stories"][0]["pr_state"] == "open"
    assert st["github_as_of"]  # the live read's own timestamp, not the snapshot


def test_no_github_on_the_api_does_not_use_the_snapshot(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _direction(root, 1)
    _story(root, "001", StoryState.PR_OPEN.value, github_pr_number=7)
    _seed_host()
    _guard_subprocesses(monkeypatch)
    st = _json(api.run_cli(["job", "status", "demo:001", "--json", "--no-github"]))
    assert st["stories"][0]["pr_state"] is None
    assert st["github_as_of"] is None
    assert st["state"] != "done"


def test_refresh_fills_the_snapshot_the_api_then_reads(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _direction(root, 1)
    _story(root, "001", StoryState.PR_OPEN.value, github_pr_number=7, github_branch="feature")
    calls: list[list[str]] = []

    def run(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        if args[:2] == ["pr", "list"]:
            body = json.dumps(
                [{"number": 7, "state": "MERGED", "url": _PR_URL, "headRefName": "feature"}]
            )
            return subprocess.CompletedProcess(args, 0, body, "")
        if args[0] == "api":
            return subprocess.CompletedProcess(args, 0, "{}", "")
        return subprocess.CompletedProcess(args, 1, "", "no pull request")

    monkeypatch.setattr(gh_mod, "_run_gh", run)
    monkeypatch.setattr(serve_mod, "systemd_timers_active", lambda: [])
    refresh(root)
    assert any(c[:2] == ["pr", "list"] for c in calls)
    n = len(calls)
    monkeypatch.setattr(gh_mod, "_run_gh", lambda args: (_ for _ in ()).throw(AssertionError(args)))
    st = job_status(root, "demo:001", cached=True)
    assert st["state"] == "done" and st["merged"] is True
    assert st["github_as_of"]
    assert len(calls) == n


def test_warm_serve_reads_a_populated_db_in_under_100ms(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for n in range(1, 31):
        did = _direction(root, n)
        _story(root, did, StoryState.STORY_CREATED.value, slug=f"s-{n}")
    _seed_host()
    _guard_subprocesses(monkeypatch)

    warm = (
        ["app", "list", "--json"],
        ["job", "list", "--json"],
        ["job", "status", "demo:001", "--json"],
    )
    for argv in warm:
        assert api.run_cli(argv)["code"] == 0
    for argv in warm:
        t0 = time.perf_counter()
        res = api.run_cli(argv)
        dt = time.perf_counter() - t0
        assert res["code"] == 0, res
        assert dt < 0.1, f"{argv} took {dt * 1000:.0f} ms"
    body = json.loads(api.run_cli(["job", "list", "--json"])["stdout"])
    assert len(body["jobs"]) == 30
