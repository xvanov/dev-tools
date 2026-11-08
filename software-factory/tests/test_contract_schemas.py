"""Native plan 1.1 (D15): ``factory job status --json`` matches ``schemas/job.schema.json``.

The schemas at the monorepo root are the one contract source the PA and the
factory share (the PA side is personal-assistant/test/schemas.test.js). Here:
the shared examples validate with ``jsonschema`` exactly as they do with the
PA's validator, and the factory's real status objects validate -- a queued
code job, one with a story, an open PR and a Claude Code step with its session
links (v1.4), and a research job.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory import contract_schemas as cs
from factory.claude_session import cli as claude_cli
from factory.claude_session import run as claude_run
from factory.jobs import submit as submit_mod
from factory.jobs.status import job_status, list_jobs
from tests.test_jobs_cli import _cli, _fake_gh, _story, _submit, gh_mod, root  # noqa: F401
from tests.test_session_links import _LinkLauncher

EXAMPLES = cs.schemas_dir() / "examples"


def _ok(name: str, value: object) -> None:
    assert cs.errors(name, json.loads(json.dumps(value))) == []


@pytest.mark.parametrize("example", sorted(p.name for p in EXAMPLES.glob("job-*.json")))
def test_shared_examples_validate(example: str) -> None:
    _ok("job", json.loads((EXAMPLES / example).read_text(encoding="utf-8")))


def test_a_broken_status_is_refused() -> None:
    job = json.loads((EXAMPLES / "job-code.json").read_text(encoding="utf-8"))
    assert cs.errors("job", {**job, "state": "running"})
    assert cs.errors("job", {**job, "runs": [{**job["runs"][0], "billing": "free"}]})
    assert cs.errors("job", {k: v for k, v in job.items() if k != "why"})
    with pytest.raises(ValueError, match="not a valid job"):
        cs.validate("job", {})
    # A $defs entry, and a cross-file $ref (run -> job) resolve.
    assert cs.errors("run#/$defs/storedStep", {"step_id": "1"})
    assert cs.errors("run", {"card": None, "run": 1, "status": None, "route": "claude", "job": None,
                             "jobState": "nope", "session": None, "steps": [], "prs": []})  # fmt: skip


def test_code_job_status_validates_through_its_life(
    root: Path,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = _submit()
    _ok("job", job_status(root, job["job_id"]))  # queued, GitHub down

    pr = {
        "number": 7, "url": "https://github.com/acme/demo/pull/7", "state": "OPEN",
        "headRefName": "story/1-x", "mergedAt": None, "isDraft": True,
    }  # fmt: skip
    monkeypatch.setattr(gh_mod, "_run_gh", _fake_gh([pr]))
    _story(root, "001", "pr_open", github_pr_number=7, github_branch="story/1-x")
    monkeypatch.setattr(claude_run, "launcher_factory", lambda: (_LinkLauncher(), None))
    monkeypatch.setattr(claude_cli, "claude_binary", lambda env=None: "/usr/bin/claude")
    claude_run.run_claude(
        db_path=root / "state" / "factory.db", persona="dev", cwd=root, run_dir=root / "run",
        prompt="p", title="t", model=None, wall_clock_s=60, story_id=1, app="demo",
        direction_id="001", links={"external": "45"},
    )  # fmt: skip
    st = job_status(root, job["job_id"])
    _ok("job", st)
    assert st["runs"] and st["runs"][0]["session"]["links"]["job"] == job["job_id"]
    _ok("job", list_jobs(root, github=False)["jobs"][0])


def test_research_job_status_validates(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    monkeypatch.setattr(submit_mod, "claude_available", lambda: (True, "fake: logged in"))
    code, obj = _cli(
        "submit", "--json", "--kind", "research", "--title", "Why is CI slow",
        "--ask", "Find out.", "--done", "Which step?",
    )  # fmt: skip
    assert code == 0, obj
    _ok("job", job_status(root, obj["job_id"]))
