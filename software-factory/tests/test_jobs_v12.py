"""JOBS-API v1.2: ``--kind``, ``--runtime``, research/report jobs, ``runs[]``, ``job report``.

Throwaway factory root per test. The agent runtimes, worker spawn and the
``claude`` login check are all seams (faked here); nothing runs a model.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

import factory.cli_jobs as cli_jobs
import factory.jobs.github as gh_mod
from factory.jobs import submit as submit_mod
from factory.jobs import tasks
from factory.jobs.status import job_status, list_jobs


def _write_app(root: Path, name: str, repo: str, extra: str = "") -> None:
    d = root / "apps" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.yaml").write_text(f"name: {name}\nrepo: {repo}\n{extra}", encoding="utf-8")


def _gh_down(args: list[str]) -> subprocess.CompletedProcess[str]:
    raise FileNotFoundError("gh")


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _write_app(tmp_path, "demo", "acme/demo", "delivery:\n  default: draft_pr\n")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_down)
    monkeypatch.setattr(submit_mod, "claude_available", lambda: (True, "fake: logged in"))
    return tmp_path


def _cli(*args: str) -> tuple[int, Any]:
    from factory.cli import app

    argv = list(args)
    if argv and argv[0] == "submit" and "--source" not in argv:
        argv += ["--source", "pa"]
    result = CliRunner().invoke(app, ["job", *argv])
    out = result.stdout.strip()
    return result.exit_code, (json.loads(out) if out.startswith("{") else out)


def _research(*extra: str) -> dict[str, Any]:
    code, obj = _cli(
        "submit",
        "--json",
        "--kind",
        "research",
        "--title",
        "Why is the build slow",
        "--ask",
        "Find out why CI takes 20 minutes.",
        "--done",
        "Which step dominates?",
        "--done",
        "What would halve it?",
        *extra,
    )
    assert code == 0, obj
    return obj


# --------------------------------------------------------------------------- #
# submit
# --------------------------------------------------------------------------- #


def test_default_submit_is_unchanged_code_api(root: Path) -> None:
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "T", "--ask", "a", "--done", "x"
    )
    assert code == 0, obj
    assert obj["kind"] == "code" and obj["runtime"] == "api" and obj["job_id"] == "demo:001"
    text = (Path(obj["direction_path"]) / "direction.md").read_text(encoding="utf-8")
    assert "runtime:" not in text and "claude_model" not in text  # v1 frontmatter unchanged


@pytest.mark.parametrize(
    ("args", "error"),
    [
        (["--kind", "poem"], "invalid_kind"),
        (["--runtime", "gpu"], "invalid_runtime"),
        (["--model", "claude_session=claude-x"], "bad_model_flag"),  # needs claude runtime
        (["--kind", "research", "--delivery", "draft_pr"], "invalid_delivery"),
    ],
)
def test_submit_refusals(root: Path, args: list[str], error: str) -> None:
    code, obj = _cli("submit", "--json", "--app", "demo", "--title", "T", "--ask", "a", *args)
    assert code == 1 and obj["error"] == error, obj


def test_runtime_unavailable(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(submit_mod, "claude_available", lambda: (False, "not logged in"))
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "T", "--ask", "a",
        "--runtime", "claude_session",
    )  # fmt: skip
    assert code == 1 and obj["error"] == "runtime_unavailable"
    assert (
        not list((root / "apps" / "demo" / "directions").glob("*"))
        if (root / "apps" / "demo" / "directions").exists()
        else True
    )


def test_claude_code_job_defaults_to_solo_and_stamps_the_frontmatter(root: Path) -> None:
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "T", "--ask", "a", "--done", "x",
        "--runtime", "claude_session", "--model", "claude_session=claude-sonnet-x",
    )  # fmt: skip
    assert code == 0, obj
    assert obj["runtime"] == "claude_session" and obj["pipeline"] == "solo"
    from factory.app_config import load_app_config
    from factory.directions.parser import parse_direction_dir
    from factory.job_routing import resolve_for_direction

    direction = parse_direction_dir("demo", Path(obj["direction_path"]))
    fm = direction.raw_frontmatter
    assert fm["runtime"] == "claude_session" and fm["claude_model"] == "claude-sonnet-x"
    assert "claude_session" not in (fm.get("models") or {})
    routing = resolve_for_direction(direction, load_app_config("demo", root))
    assert routing.pipeline == "solo" and routing.runtime == "claude_session"
    assert routing.claude_model == "claude-sonnet-x"


def test_claude_code_job_with_chain_keeps_the_chain(root: Path) -> None:
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "T", "--ask", "a", "--done", "x",
        "--runtime", "claude_session", "--pipeline", "chain",
    )  # fmt: skip
    assert code == 0 and obj["pipeline"] == "chain" and obj["runtime"] == "claude_session"


def test_research_job_without_app_is_a_scratch_task(root: Path) -> None:
    obj = _research()
    assert obj["job_id"] == "scratch:r0001" and obj["app"] is None
    assert obj["kind"] == "research" and obj["delivery"] == "none" and obj["pipeline"] is None
    d = Path(obj["direction_path"])
    assert d.parent == root / "state" / "jobs"
    meta = tasks.read_meta(d)
    assert meta["state"] == "queued" and meta["done"] == [
        "Which step dominates?",
        "What would halve it?",
    ]
    assert (d / "ask.md").read_text(encoding="utf-8").startswith("Find out")
    # Not a direction: pm-sync never sees it.
    assert not (root / "apps" / "demo" / "directions").exists()


def test_research_job_is_idempotent_and_with_app(root: Path) -> None:
    a = _research("--repo", "acme/demo", "--external-id", "run-9")
    b = _research("--repo", "acme/demo", "--external-id", "run-9")
    assert a["job_id"] == b["job_id"] == "demo:r0001" and b["created"] is False
    assert _research()["job_id"] == "scratch:r0002"


def test_report_kind_and_researcher_model_override(root: Path) -> None:
    obj = _research("--kind", "report", "--model", "researcher=azure/some-model")
    assert obj["kind"] == "report"  # last --kind wins at the Typer level
    meta = tasks.read_meta(Path(obj["direction_path"]))
    assert meta["models"] == {"researcher": "azure/some-model"}


# --------------------------------------------------------------------------- #
# status / list / dispatch / run / report / cancel
# --------------------------------------------------------------------------- #


def test_queued_task_status_shape(root: Path) -> None:
    job = _research()
    st = job_status(root, job["job_id"])
    assert st["state"] == "queued" and not st["terminal"]
    for key in ("kind", "runtime", "report", "runs", "subscription_equiv_usd", "cost_usd"):
        assert key in st
    assert st["report"] is None and st["runs"] == [] and st["stories"] == []
    assert st["started_at"] is None
    listed = list_jobs(root, source="pa", github=False)["jobs"]
    assert [j["job_id"] for j in listed] == [job["job_id"]]
    assert list_jobs(root, app="demo", github=False)["jobs"] == []


def test_dispatch_starts_up_to_the_cap_and_reaps_dead_workers(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []
    monkeypatch.setattr(tasks, "spawn_worker", lambda r, ref: started.append(ref.job_id) or 4242)
    monkeypatch.setattr(tasks, "pid_alive", lambda pid: True)
    monkeypatch.setenv("FACTORY_TASK_MAX_WORKERS", "2")
    ids = [_research()["job_id"] for _ in range(3)]
    out = tasks.dispatch_tasks(root)
    assert out["started"] == ids[:2] and started == ids[:2]
    assert job_status(root, ids[0])["state"] == "in_progress"
    assert job_status(root, ids[2])["state"] == "queued"
    assert tasks.dispatch_tasks(root)["started"] == []  # cap still full
    monkeypatch.setattr(tasks, "pid_alive", lambda pid: False)
    out = tasks.dispatch_tasks(root)
    assert sorted(out["reaped"]) == sorted(ids[:2]) and out["started"] == [ids[2]]
    st = job_status(root, ids[0])
    assert st["state"] == "failed" and "worker" in st["why"]


def test_orphaned_claim_is_reaped_after_the_stale_window(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = _research()
    ref = tasks.find_task(root, job["job_id"])
    meta = tasks.read_meta(ref.dir_path)
    meta.update(state="starting", worker_pid=None, updated_at="2020-01-01T00:00:00+00:00")
    tasks.write_meta(ref.dir_path, meta)
    out = tasks.dispatch_tasks(root, dry_run=True)
    assert out["reaped"] == [job["job_id"]]


def test_list_filters_scratch_jobs_by_app(root: Path) -> None:
    job = _research()
    assert [j["job_id"] for j in list_jobs(root, app="scratch", github=False)["jobs"]] == [
        job["job_id"]
    ]


def test_dispatch_cli_and_dry_run(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks, "spawn_worker", lambda r, ref: 1)
    job = _research()
    code, obj = _cli("dispatch", "--json", "--dry-run")
    assert code == 0 and obj["started"] == [job["job_id"]]
    assert job_status(root, job["job_id"])["state"] == "queued"


def _fake_runner(text: str | None, error: str | None = None) -> Any:
    def run(root: Path, ref: Any, cwd: Path, brief: Path, db: Path) -> dict[str, Any]:
        assert "Which step dominates?" in brief.read_text(encoding="utf-8")
        if text is not None:
            (cwd / tasks.REPORT_NAME).write_text(text, encoding="utf-8")
        return {"error": error}

    return run


def test_run_task_api_writes_the_report(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks, "api_runner", _fake_runner("# Slow build\n\nIt is the docker step."))
    job = _research()
    final = tasks.run_task(root, job["job_id"])
    assert final["state"] == "done"
    st = job_status(root, job["job_id"])
    assert st["state"] == "done" and st["terminal"]
    assert st["report"]["title"] == "Slow build" and st["report"]["words"] == 8
    started = datetime.fromisoformat(st["started_at"])
    assert started.tzinfo is not None and started <= datetime.fromisoformat(st["updated_at"])
    code, obj = _cli("report", job["job_id"], "--json")
    assert code == 0 and obj["markdown"].startswith("# Slow build")
    code, text = _cli("report", job["job_id"])
    assert code == 0 and text.startswith("# Slow build")


def test_run_task_without_report_fails(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks, "api_runner", _fake_runner(None, error="rate limited"))
    job = _research()
    tasks.run_task(root, job["job_id"])
    st = job_status(root, job["job_id"])
    assert st["state"] == "failed" and "without writing a report" in st["why"]
    assert "rate limited" in st["why"]
    code, obj = _cli("report", job["job_id"], "--json")
    assert code == 1 and obj["error"] == "no_report"


def test_run_task_claude_runtime_uses_the_claude_runner(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    used: list[str] = []

    def claude(root_: Path, ref: Any, cwd: Path, brief: Path, db: Path) -> dict[str, Any]:
        used.append(ref.meta["runtime"])
        (cwd / tasks.REPORT_NAME).write_text("# R\nok\n", encoding="utf-8")
        return {"error": None}

    monkeypatch.setattr(tasks, "claude_runner", claude)
    monkeypatch.setattr(tasks, "api_runner", _fake_runner(None, "should not run"))
    job = _research("--runtime", "claude_session")
    assert job["runtime"] == "claude_session"
    assert tasks.run_task(root, job["job_id"])["state"] == "done"
    assert used == ["claude_session"]


def test_task_runs_and_subscription_equivalent_in_status(root: Path) -> None:
    from factory.claude_session import ledger

    job = _research()
    db = root / "state" / "factory.db"
    rid = ledger.open_run(
        db, persona="researcher", model=None, story_id=None, app="scratch",
        direction_id="r0001", repo_path="/w",
    )  # fmt: skip
    links = {"job": job["job_id"], "step": str(rid)}
    ledger.set_session(
        db, rid, {"machine": "box", "termhub_session_id": "th", "url": "https://u", "links": links}
    )
    st = job_status(root, job["job_id"])
    assert st["runs"][0]["state"] == "running" and st["runs"][0]["session"]["url"] == "https://u"
    # v1.4 (E1): the step names its job, and its session keeps its links.
    assert st["runs"][0]["job_id"] == job["job_id"] and st["runs"][0]["id"] == rid
    assert st["runs"][0]["session"]["links"] == links
    assert st["runs"][0]["billing"] == "subscription" and st["runs"][0]["ended_at"] is None
    ledger.close_run(
        db, rid, success=True, error=None, tokens_in=1, tokens_out=1, cached_input_tokens=0,
        subscription_equiv_usd=1.25, duration_s=10, usage_reliable=True,
    )  # fmt: skip
    st = job_status(root, job["job_id"])
    assert st["runs"][0]["state"] == "ok" and st["runs"][0]["ended_at"]
    assert st["subscription_equiv_usd"] == 1.25 and st["cost_usd"] == 0.0


def test_cancel_queued_task(root: Path) -> None:
    job = _research()
    code, obj = _cli("cancel", job["job_id"], "--json")
    assert code == 0 and obj["state"] == "cancelled"
    assert job_status(root, job["job_id"])["state"] == "cancelled"
    assert tasks.dispatch_tasks(root)["started"] == []


def test_cancel_done_task_is_a_noop(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks, "api_runner", _fake_runner("# R\n"))
    job = _research()
    tasks.run_task(root, job["job_id"])
    code, obj = _cli("cancel", job["job_id"], "--json")
    assert obj["state"] == "done" and job_status(root, job["job_id"])["state"] == "done"


def test_cancel_running_task_then_worker_finishes_cancelled(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = _research()

    def runner(root_: Path, ref: Any, cwd: Path, brief: Path, db: Path) -> dict[str, Any]:
        tasks.cancel_task(root_, ref.job_id)  # cancel lands mid-run
        (cwd / tasks.REPORT_NAME).write_text("# partial\n", encoding="utf-8")
        return {"error": None}

    monkeypatch.setattr(tasks, "api_runner", runner)
    monkeypatch.setattr(tasks, "_kill_worker", lambda pid: None)
    assert tasks.run_task(root, job["job_id"])["state"] == "cancelled"
    assert job_status(root, job["job_id"])["state"] == "cancelled"


def test_report_on_a_code_job_is_no_report(root: Path) -> None:
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "T", "--ask", "a", "--done", "x"
    )
    code, obj = _cli("report", obj["job_id"], "--json")
    assert code == 1 and obj["error"] == "no_report"


def test_code_job_status_has_v12_fields(root: Path) -> None:
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "T", "--ask", "a", "--done", "x"
    )
    st = job_status(root, obj["job_id"], github=False)
    assert st["kind"] == "code" and st["runtime"] == "api" and st["report"] is None
    assert st["runs"] == [] and st["subscription_equiv_usd"] == 0.0


def test_unknown_task_id(root: Path) -> None:
    code, obj = _cli("status", "scratch:r0099", "--json")
    assert code == 1 and obj["error"] == "not_found"


def test_build_brief_lists_questions_and_deliverable() -> None:
    brief = tasks.build_brief(
        kind="report",
        title="Q3 plan",
        ask="Write the plan.",
        questions=["Goals?", "Risks?"],
        workspace_note="scratch",
    )
    assert brief.startswith("# Report job: Q3 plan")
    assert "1. Goals?" in brief and "2. Risks?" in brief and tasks.REPORT_NAME in brief


def test_story_runtime_column_is_migrated(tmp_path: Path) -> None:
    from factory.chain.handlers import get_story, persist_story
    from factory.chain.state_machine import StoryRecord

    db = tmp_path / "state" / "factory.db"
    s = persist_story(
        StoryRecord(
            direction_id="001", app="demo", title="t", slug="s", scope="backend",
            runtime="claude_session", runtime_model="claude-x",
        ),
        db,
    )  # fmt: skip
    got = get_story(s.id, db)
    assert got.runtime == "claude_session" and got.runtime_model == "claude-x"
    plain = persist_story(
        StoryRecord(direction_id="002", app="demo", title="t", slug="p", scope="backend"), db
    )
    assert get_story(plain.id, db).runtime == "api"


def test_research_submit_answers_while_factory_db_is_locked(root: Path) -> None:
    """A tick's open transaction on factory.db must not sit in front of a
    research submit. The 8.7 s after ``created_at`` (8.4.45) is not this lock:
    ``_submit_task`` does not open factory.db."""
    import sqlite3
    import time

    from factory.jobs.submit import SubmitRequest, submit_job
    from factory.state_dir import state_dir

    db = state_dir(root) / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    holder = sqlite3.connect(db)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        t0 = time.perf_counter()
        out = submit_job(
            root,
            SubmitRequest(
                title="Why is the build slow",
                ask="Find out why CI takes 20 minutes.",
                done=["Which step dominates?"],
                source="pa",
                kind="research",
            ),
        )
        elapsed = time.perf_counter() - t0
    finally:
        holder.rollback()
        holder.close()
    assert elapsed < 1.0, elapsed
    assert out["created"] is True and out["job_id"]
