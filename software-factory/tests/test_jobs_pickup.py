"""JOBS-API v1.3 — branch/PR pickup (``--branch`` / ``--pr``).

No GitHub: every ``gh`` read goes through ``factory.jobs.github._run_gh`` (faked
here) and the chain's ``gh`` calls are monkeypatched at their seams. Git is
real (temp repos), like ``test_worktree.py``.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

import factory.cli_jobs as cli_jobs
import factory.jobs.github as gh_mod
from factory.chain.handlers import persist_story
from factory.chain.pickup import is_pickup, pickup_of_meta, story_branch, story_into
from factory.chain.state_machine import StoryRecord, StoryState
from factory.directions.parser import parse_direction_dir

REPO = "acme/demo"

# --------------------------------------------------------------------------- #
# fixtures / helpers
# --------------------------------------------------------------------------- #


def _write_app(root: Path, name: str, repo: str, extra: str = "") -> None:
    d = root / "apps" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.yaml").write_text(f"name: {name}\nrepo: {repo}\n{extra}", encoding="utf-8")


def _gh_down(args: list[str]) -> subprocess.CompletedProcess[str]:
    raise FileNotFoundError("gh")


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return make_root(tmp_path, monkeypatch)


def make_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway factory root with app ``demo`` (``acme/demo``); gh unreachable."""
    _write_app(tmp_path, "demo", REPO, "delivery:\n  default: draft_pr\n")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_down)
    return tmp_path


def _pr(number: int = 42, **kw: Any) -> dict[str, Any]:
    out = {
        "number": number,
        "state": "OPEN",
        "url": f"https://github.com/{REPO}/pull/{number}",
        "headRefName": "feature/login",
        "baseRefName": "main",
        "isCrossRepository": False,
        "isDraft": False,
    }
    out.update(kw)
    return out


_THREADS = {
    "data": {
        "repository": {
            "pullRequest": {
                "reviewThreads": {
                    "nodes": [
                        {
                            "isResolved": False,
                            "isOutdated": False,
                            "path": "app/login.py",
                            "line": 12,
                            "comments": {
                                "nodes": [
                                    {"author": {"login": "review-bot"}, "body": "Handle None."}
                                ]
                            },
                        },
                        {
                            "isResolved": True,
                            "path": "app/x.py",
                            "line": 1,
                            "comments": {"nodes": [{"author": {"login": "a"}, "body": "done"}]},
                        },
                    ]
                }
            }
        }
    }
}


def _fake_gh(
    *,
    prs: dict[int, dict[str, Any]] | None = None,
    branches: set[str] | None = None,
    head_prs: list[dict[str, Any]] | None = None,
) -> Any:
    calls: list[list[str]] = []

    def run(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        ok = lambda out: subprocess.CompletedProcess(args, 0, json.dumps(out), "")  # noqa: E731
        if args[:2] == ["pr", "view"]:
            n = int(args[2])
            if prs and n in prs:
                return ok(prs[n])
            return subprocess.CompletedProcess(
                args, 1, "", "GraphQL: Could not resolve to a PullRequest"
            )
        if args[:2] == ["pr", "list"] and "--head" in args:
            return ok(head_prs or [])
        if args[:2] == ["pr", "list"]:
            return ok(list((prs or {}).values()))
        if args[:2] == ["api", "graphql"]:
            return ok(_THREADS)
        if args[0] == "api" and "/branches/" in args[1]:
            name = args[1].split("/branches/", 1)[1]
            if branches and name in branches:
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", "gh: Not Found (HTTP 404)")
        raise AssertionError(args)

    run.calls = calls  # type: ignore[attr-defined]
    return run


def _cli(*args: str) -> tuple[int, Any]:
    from factory.cli import app

    argv = list(args)
    if argv and argv[0] == "submit" and "--source" not in argv:
        argv += ["--source", "pa"]
    result = CliRunner().invoke(app, ["job", *argv])
    out = result.stdout.strip()
    return result.exit_code, (json.loads(out) if out.startswith("{") else out)


def _submit(*extra: str) -> tuple[int, Any]:
    return _cli(
        "submit",
        "--json",
        "--app",
        "demo",
        "--title",
        "Finish the login page",
        "--ask",
        "Make the PR mergeable.",
        "--done",
        "The login page shows an error for a wrong password",
        *extra,
    )


def _story(root: Path, direction_id: str, state: str, **kw: Any) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id=direction_id,
            app=kw.pop("app", "demo"),
            title="t",
            slug=kw.pop("slug", f"s-{state}"),
            scope="backend",
            state=state,
            **kw,
        ),
        root / "state" / "factory.db",
    )


# --------------------------------------------------------------------------- #
# submit --pr / --branch
# --------------------------------------------------------------------------- #


def test_submit_pr_records_the_base_and_the_open_review_threads(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(prs={42: _pr()}))
    code, obj = _submit("--pr", "42")
    assert code == 0, obj
    assert obj["base"] == {"branch": "feature/login", "pr": 42, "into": "main"}
    d = Path(obj["direction_path"])
    meta = parse_direction_dir("demo", d).raw_frontmatter
    assert meta["base"] == {"branch": "feature/login", "pr": 42, "into": "main"}
    body = (d / "direction.md").read_text(encoding="utf-8")
    assert "existing branch `feature/login`" in body
    assert "Handle None." in body and "app/login.py:12" in body
    assert "done" not in (d / "artifacts" / "pr_review_threads.md").read_text()  # resolved


@pytest.mark.parametrize(
    ("pr", "code"),
    [
        (_pr(isCrossRepository=True), "pr_from_fork"),
        (_pr(state="MERGED"), "pr_not_open"),
        (_pr(state="CLOSED"), "pr_not_open"),
    ],
)
def test_submit_pr_refusals(
    root: Path, monkeypatch: pytest.MonkeyPatch, pr: dict[str, Any], code: str
) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(prs={42: pr}))
    rc, obj = _submit("--pr", "42")
    assert rc == 1 and obj["error"] == code
    assert not (root / "apps" / "demo" / "directions").exists() or not any(
        (root / "apps" / "demo" / "directions").iterdir()
    )


def test_submit_pr_not_found_and_github_down(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(prs={}))
    assert _submit("--pr", "7")[1]["error"] == "pr_not_found"
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_down)
    assert _submit("--pr", "7")[1]["error"] == "github_unavailable"
    assert _submit("--pr", "abc")[1]["error"] == "invalid_argument"


def test_submit_branch_adopts_its_open_pr(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh(branches={"feature/login"}, head_prs=[_pr(9, baseRefName="release/2")]),
    )
    code, obj = _submit("--branch", "feature/login")
    assert code == 0, obj
    assert obj["base"] == {"branch": "feature/login", "pr": 9, "into": "release/2"}
    assert any("release/2" in w for w in obj["warnings"])


def test_submit_branch_without_a_pr(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(branches={"wip"}))
    code, obj = _submit("--branch", "wip")
    assert code == 0, obj
    assert obj["base"] == {"branch": "wip", "pr": None, "into": "main"}


@pytest.mark.parametrize(
    ("args", "code"),
    [
        (["--branch", "nope"], "branch_not_found"),
        (["--branch", "main"], "branch_is_default"),
        (["--branch", "bad..name"], "invalid_branch"),
        (["--branch", "wip", "--pr", "3"], "invalid_argument"),
        (["--branch", "wip", "--delivery", "push_to_main"], "invalid_delivery"),
        (["--branch", "wip", "--kind", "research"], "invalid_argument"),
    ],
)
def test_submit_branch_refusals(
    root: Path, monkeypatch: pytest.MonkeyPatch, args: list[str], code: str
) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(branches={"wip", "main"}))
    rc, obj = _submit(*args)
    assert rc == 1 and obj["error"] == code, obj


def test_second_job_on_the_same_branch_is_busy(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(branches={"wip"}))
    assert _submit("--branch", "wip")[0] == 0
    rc, obj = _submit("--branch", "wip", "--external-id", "other")
    assert rc == 1 and obj["error"] == "branch_busy"


def test_resubmit_returns_the_job_without_asking_github(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(prs={42: _pr()}))
    first = _submit("--pr", "42", "--external-id", "run-1")[1]
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_down)
    rc, again = _submit("--pr", "42", "--external-id", "run-1")
    assert rc == 0 and again["created"] is False and again["job_id"] == first["job_id"]


def test_status_reports_base_and_v1_jobs_report_null(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(prs={42: _pr()}))
    picked = _submit("--pr", "42")[1]
    plain = _submit("--external-id", "plain")[1]
    assert plain["base"] is None
    _, s1 = _cli("status", picked["job_id"], "--json", "--no-github")
    _, s2 = _cli("status", plain["job_id"], "--json", "--no-github")
    assert s1["base"] == {"branch": "feature/login", "pr": 42, "into": "main"}
    assert s2["base"] is None and s2["stalled"] is False


# --------------------------------------------------------------------------- #
# chain side
# --------------------------------------------------------------------------- #


def test_pickup_helpers() -> None:
    s = StoryRecord(direction_id="1", app="a", title="t", slug="sl", scope="backend")
    s.github_issue_number = 5
    assert not is_pickup(s)
    assert story_branch(s) == "factory/story-5-sl"
    s.pickup_branch, s.pickup_into = "feature/x", "release/2"
    assert is_pickup(s) and story_branch(s) == "feature/x"
    assert story_into(s, type("C", (), {"default_branch": "main"})()) == "release/2"
    assert pickup_of_meta({"base": {"branch": ""}}) is None
    assert pickup_of_meta({"base": "junk"}) is None
    assert pickup_of_meta({"base": {"branch": "b", "pr": "x"}}) == {
        "branch": "b",
        "pr": None,
        "into": None,
    }


def test_spawn_stamps_the_pickup_and_keeps_one_story(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.app_config import load_app_config
    from factory.chain.handlers import handle_stories_spawned

    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh(prs={42: _pr()}))
    job = _submit("--pr", "42")[1]
    direction = parse_direction_dir("demo", Path(job["direction_path"]))
    children = [
        {"title": "slice a", "scope": "backend", "points": 2},
        {"title": "slice b", "scope": "backend", "points": 1},
    ]
    stories = handle_stories_spawned(
        direction=direction,
        pm_result={"child_stories": children, "confidence": 0.9},
        app_config=load_app_config("demo", root),
        software_factory_root=root,
        dry_run=True,
    )
    assert len(stories) == 1
    s = stories[0]
    assert (s.pickup_branch, s.pickup_pr, s.pickup_into) == ("feature/login", 42, "main")
    assert s.github_branch == "feature/login"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True
    ).stdout.strip()


def _origin_with_branch(tmp_path: Path) -> tuple[Path, Path]:
    """A bare origin with ``main`` and a human's ``feature/x``; a clone of it."""
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "-q", "--initial-branch=main")
    _git(seed, "config", "user.email", "t@e.x")
    _git(seed, "config", "user.name", "T")
    (seed / "README.md").write_text("x\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-q", "-m", "init")
    _git(seed, "checkout", "-q", "-b", "feature/x")
    (seed / "human.txt").write_text("human work\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-q", "-m", "human")
    _git(seed, "checkout", "-q", "main")
    origin = tmp_path / "origin.git"
    _git(tmp_path, "clone", "-q", "--bare", str(seed), str(origin))
    src = tmp_path / "src"
    _git(tmp_path, "clone", "-q", str(origin), str(src))
    _git(src, "config", "user.email", "t@e.x")
    _git(src, "config", "user.name", "T")
    return origin, src


def test_worktree_continues_on_the_humans_branch(tmp_path: Path) -> None:
    from factory.chain.worktree import ensure_worktree_for_story

    _, src = _origin_with_branch(tmp_path)
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="demo",
        story_id=3,
        slug="s",
        branch="feature/x",
    )
    assert _git(wt, "rev-parse", "--abbrev-ref", "HEAD") == "feature/x"
    assert (wt / "human.txt").read_text() == "human work\n"
    with pytest.raises(RuntimeError, match="exists neither"):
        ensure_worktree_for_story(
            src,
            software_factory_root=factory_root,
            app="demo",
            story_id=4,
            slug="t",
            branch="no/such",
        )


def test_pickup_push_builds_on_new_human_commits_and_never_forces(tmp_path: Path) -> None:
    from factory.chain.handlers import _sync_and_push_story_branch
    from factory.chain.worktree import ensure_worktree_for_story

    origin, src = _origin_with_branch(tmp_path)
    factory_root = tmp_path / "factory"
    factory_root.mkdir()
    wt = ensure_worktree_for_story(
        src,
        software_factory_root=factory_root,
        app="demo",
        story_id=3,
        slug="s",
        branch="feature/x",
    )
    _git(wt, "config", "user.email", "t@e.x")
    _git(wt, "config", "user.name", "T")
    (wt / "factory.txt").write_text("factory work\n")
    _git(wt, "add", ".")
    _git(wt, "commit", "-q", "-m", "factory")
    # Meanwhile the human pushes another commit to their branch.
    other = tmp_path / "other"
    _git(tmp_path, "clone", "-q", "--branch", "feature/x", str(origin), str(other))
    _git(other, "config", "user.email", "h@e.x")
    _git(other, "config", "user.name", "H")
    (other / "human2.txt").write_text("more\n")
    _git(other, "add", ".")
    _git(other, "commit", "-q", "-m", "human 2")
    _git(other, "push", "-q", "origin", "feature/x")
    human_tip = _git(other, "rev-parse", "HEAD")

    from factory.app_config import AppConfig

    cfg = AppConfig(name="demo", repo=REPO)
    _sync_and_push_story_branch(wt, "main", "feature/x", cfg, pickup=True)

    files = _git(origin, "ls-tree", "--name-only", "feature/x").split()
    assert {"human.txt", "human2.txt", "factory.txt"} <= set(files)
    # The human's commit is an ancestor of the new tip: nothing was overwritten.
    subprocess.run(
        ["git", "merge-base", "--is-ancestor", human_tip, "feature/x"], cwd=origin, check=True
    )


def test_conflict_rebuild_never_destroys_a_picked_up_branch(tmp_path: Path) -> None:
    from factory.chain.auto_merge import _handle_pr_conflict_rebuild

    s = StoryRecord(
        id=1,
        direction_id="1",
        app="demo",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        pickup_branch="feature/x",
        github_pr_number=42,
    )
    called: list[Any] = []
    out = _handle_pr_conflict_rebuild(
        story=s,
        app_config=type("C", (), {"default_branch": "main", "repo": REPO})(),  # type: ignore[arg-type]
        pr_number=42,
        db=tmp_path / "factory.db",
        root=tmp_path,
        reset_fn=lambda **kw: called.append(kw),
    )
    assert out == "exhausted" and called == []
    assert s.github_pr_number == 42 and s.github_branch is None


def test_pr_open_updates_the_picked_up_pr_and_opens_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.chain.handlers as H

    pushed: list[tuple[Any, ...]] = []
    monkeypatch.setattr(H, "_writing_worktree", lambda *a, **k: tmp_path)
    monkeypatch.setattr(
        H,
        "_sync_and_push_story_branch",
        lambda *a, **k: pushed.append((a[2], k.get("pickup"))),
    )

    def no_create(*a: Any, **k: Any) -> Any:
        raise AssertionError("must not run gh pr create for a picked-up PR")

    monkeypatch.setattr(subprocess, "run", no_create)
    s = StoryRecord(
        id=1,
        direction_id="1",
        app="demo",
        title="t",
        slug="s",
        scope="backend",
        pickup_branch="feature/x",
        pickup_pr=42,
        github_branch="feature/x",
    )
    cfg = type("C", (), {"default_branch": "main", "repo": REPO})()
    monkeypatch.setattr(H, "_picked_up_pr_state", lambda *a: "OPEN")
    assert H._open_pr_for_story(s, cfg, tmp_path, draft=True) == 42  # type: ignore[arg-type]
    assert pushed == [("feature/x", True)]
    monkeypatch.setattr(H, "_picked_up_pr_state", lambda *a: "CLOSED")
    assert H._open_pr_for_story(s, cfg, tmp_path) is None  # type: ignore[arg-type]
    assert len(pushed) == 1
