"""JOBS-API v1.3 — ``factory job resume`` (failed / cancelled / stalled jobs).

Shares the throwaway factory root and the faked ``gh`` seam with
``test_jobs_pickup.py``.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
import yaml

import factory.jobs.resume as resume_mod
from factory.chain import delivery_gate
from factory.chain.state_machine import StoryState
from factory.directions.parser import parse_direction_dir
from tests.test_jobs_pickup import REPO, _cli, _story, _submit, make_root


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return make_root(tmp_path, monkeypatch)


def _plain_job(root: Path) -> dict[str, Any]:
    code, obj = _submit()
    assert code == 0, obj
    return obj


def test_resume_a_failed_job_continues_from_dev(root: Path) -> None:
    job = _plain_job(root)
    s = _story(
        root,
        "001",
        StoryState.BLOCKED_CI_UNRESOLVED.value,
        sm_result_json="{}",
        github_branch="factory/story-0-x",
    )
    kept = _story(root, "001", StoryState.SUPERSEDED_BY_SIBLING.value, slug="loser")
    assert _cli("status", job["job_id"], "--json", "--no-github")[1]["state"] == "failed"
    rc, obj = _cli("resume", job["job_id"], "--json", "--no-github")
    assert rc == 0, obj
    assert obj["was"] == "failed"
    assert obj["resumed"] == [
        {
            "id": s.id,
            "from_state": "blocked_ci_unresolved",
            "to_state": StoryState.DEV_RETRY.value,
            "point": "dev",
        }
    ]
    assert obj["kept"] == [{"id": kept.id, "state": "superseded_by_sibling"}]
    assert obj["state"] == "in_progress"


def test_resume_a_cancelled_job_clears_both_markers(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.directions.watcher import mark_direction_status, merge_state
    from factory.jobs.status import CANCEL_KEY

    reopened: list[tuple[str, int]] = []
    monkeypatch.setattr(resume_mod, "_issue_reopen", lambda repo, n: reopened.append((repo, n)))
    job = _plain_job(root)
    d = parse_direction_dir("demo", Path(job["direction_path"]))
    db = root / "state" / "factory.db"
    s = _story(
        root,
        "001",
        StoryState.CLOSED_BY_OPERATOR.value,
        github_issue_number=17,
        dev_attempts_json='[{"attempt": 1}]',
    )
    done = _story(root, "001", StoryState.DELIVERED_LOCAL.value, slug="done")
    # What 'factory job cancel' leaves behind (it needs fcntl, so it is staged).
    merge_state(d, {CANCEL_KEY: {"at": "2026-11-07T00:00:00+00:00", "by": "test"}})
    delivery_gate.mark_job_cancelled(db, "demo", "001", by="test")
    mark_direction_status(d, "closed", by="test")
    assert _cli("status", job["job_id"], "--json", "--no-github")[1]["state"] == "cancelled"

    rc, obj = _cli("resume", job["job_id"], "--json")
    assert rc == 0, obj
    assert [r["id"] for r in obj["resumed"]] == [s.id]
    assert obj["kept"] == [{"id": done.id, "state": "delivered_local"}]
    assert not delivery_gate.is_job_cancelled(db, "demo", "001")
    state = yaml.safe_load((Path(job["direction_path"]) / "state.yaml").read_text())
    assert CANCEL_KEY not in state and state["previous_cancel"]["by"] == "test"
    assert parse_direction_dir("demo", Path(job["direction_path"])).status == "pm-validated"
    assert reopened == [(REPO, 17)]
    assert obj["state"] == "in_progress"


def test_resume_refuses_running_and_done_jobs(root: Path) -> None:
    running = _plain_job(root)
    _story(root, "001", StoryState.DEV_IN_PROGRESS.value)
    rc, obj = _cli("resume", running["job_id"], "--json", "--no-github")
    assert rc == 1 and obj["error"] == "job_running"

    _, done = _submit("--external-id", "two")
    _story(root, "002", StoryState.DELIVERED_LOCAL.value, slug="d")
    rc, obj = _cli("resume", done["job_id"], "--json", "--no-github")
    assert rc == 1 and obj["error"] == "job_done"

    _, queued = _submit("--external-id", "three")
    rc, obj = _cli("resume", queued["job_id"], "--json", "--no-github")
    assert rc == 1 and obj["error"] == "job_running"


def test_a_stalled_job_reads_stalled_and_resumes(root: Path) -> None:
    job = _plain_job(root)
    s = _story(root, "001", StoryState.DEV_IN_PROGRESS.value, sm_result_json="{}")
    old = (datetime.now(UTC) - timedelta(hours=5)).isoformat()
    con = sqlite3.connect(root / "state" / "factory.db")
    con.execute("UPDATE stories SET updated_at = ?, created_at = ? WHERE id = ?", (old, old, s.id))
    con.commit()
    con.close()
    state_path = Path(job["direction_path"]) / "state.yaml"
    state = yaml.safe_load(state_path.read_text())
    state["created_at"] = old
    for entry in state.get("audit") or []:
        entry["ts"] = old
    state_path.write_text(yaml.safe_dump(state))

    status = _cli("status", job["job_id"], "--json", "--no-github")[1]
    assert status["state"] == "in_progress" and status["stalled"] is True
    rc, obj = _cli("resume", job["job_id"], "--json", "--no-github")
    assert rc == 0, obj
    assert obj["resumed"][0]["to_state"] == StoryState.DEV_RETRY.value


def test_resume_refuses_a_job_with_nothing_to_resume(root: Path) -> None:
    from factory.directions.watcher import mark_direction_status

    job = _plain_job(root)
    d = parse_direction_dir("demo", Path(job["direction_path"]))
    mark_direction_status(d, "needs-direction", by="test")
    rc, obj = _cli("resume", job["job_id"], "--json", "--no-github")
    assert rc == 1 and obj["error"] == "not_resumable"


def test_resume_a_job_cancelled_before_triage_requeues_it(root: Path) -> None:
    from factory.directions.watcher import mark_direction_status

    job = _plain_job(root)
    mark_direction_status(
        parse_direction_dir("demo", Path(job["direction_path"])), "closed", by="t"
    )
    rc, obj = _cli("resume", job["job_id"], "--json", "--no-github")
    assert rc == 0, obj
    assert obj["requeued"] is True and obj["state"] == "queued"


def test_resume_a_failed_research_job_requeues_it(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.jobs.tasks import FAILED, find_task, update_meta

    rc, job = _cli(
        "submit", "--json", "--kind", "research", "--title", "Q", "--ask", "Why is it slow?"
    )
    assert rc == 0, job
    rc, obj = _cli("resume", job["job_id"], "--json")
    assert rc == 1 and obj["error"] == "job_running"  # still queued
    update_meta(find_task(root, job["job_id"]).dir_path, state=FAILED, why="boom")
    rc, obj = _cli("resume", job["job_id"], "--json")
    assert rc == 0 and obj["state"] == "queued" and obj["was"] == "failed"
    meta = find_task(root, job["job_id"]).meta
    assert meta["state"] == "queued" and meta["resumed"][0]["why"] == "boom"
