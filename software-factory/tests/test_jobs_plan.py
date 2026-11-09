"""JOBS-API v1.8: the read-only ``plan`` job kind.

A plan job is a research-like task job whose agent may change nothing. On
``claude_session`` Claude Code starts in its ``plan`` permission mode (never
``--dangerously-skip-permissions``), so the factory itself saves the plan the
run proposed as the job's report. Throwaway factory root per test; nothing runs
a model.
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
from factory.claude_session.conversation import ConversationResult
from factory.claude_session.launcher import build_claude_argv
from factory.claude_session.stream import parse_stream
from factory.jobs import kinds, tasks
from factory.jobs import submit as submit_mod
from factory.jobs.status import job_status


def _gh_down(args: list[str]) -> subprocess.CompletedProcess[str]:
    raise FileNotFoundError("gh")


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "apps" / "demo"
    d.mkdir(parents=True)
    (d / "config.yaml").write_text("name: demo\nrepo: acme/demo\n", encoding="utf-8")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_down)
    monkeypatch.setattr(submit_mod, "claude_available", lambda: (True, "fake: logged in"))
    return tmp_path


def _submit_plan(*extra: str) -> dict[str, Any]:
    from factory.cli import app

    argv = ["job", "submit", "--json", "--source", "pa", "--kind", "plan",
            "--title", "Plan the retry change", "--ask", "How should retries work?", *extra]  # fmt: skip
    result = CliRunner().invoke(app, argv)
    obj = json.loads(result.stdout.strip())
    assert result.exit_code == 0, obj
    return obj


def test_plan_is_a_read_only_task_kind() -> None:
    assert kinds.normalize_kind("plan") == "plan"
    assert "plan" in kinds.TASK_KINDS and "plan" in kinds.READ_ONLY_KINDS
    assert "research" not in kinds.READ_ONLY_KINDS


def test_argv_read_only_uses_plan_permission_mode_never_skip() -> None:
    argv = build_claude_argv("/c", model=None, session_uuid="u", resume=None, permission_mode="plan")
    assert argv[argv.index("--permission-mode") + 1] == "plan"
    assert "--dangerously-skip-permissions" not in argv
    default = build_claude_argv("/c", model=None, session_uuid="u", resume=None)
    assert "--dangerously-skip-permissions" in default and "--permission-mode" not in default


def test_stream_keeps_the_exit_plan_mode_plan() -> None:
    lines = [
        {"type": "system", "subtype": "init", "session_id": "s", "model": "m"},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "ExitPlanMode", "input": {"plan": "# Plan\n1. do it"}},
        ]}},  # fmt: skip
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "waiting"}]}},
        {"type": "result", "subtype": "success", "result": "waiting", "session_id": "s"},
    ]
    res = parse_stream("\n".join(json.dumps(x) for x in lines))
    assert res.plan_text == "# Plan\n1. do it"
    conv = ConversationResult(rounds=[res])
    assert conv.plan_text == "# Plan\n1. do it"
    # No ExitPlanMode: the final message is the plan.
    plain = parse_stream(json.dumps({"type": "result", "subtype": "success", "result": "# P\nx"}))
    assert ConversationResult(rounds=[plain]).plan_text == "# P\nx"


def test_brief_for_a_claude_plan_asks_for_the_final_message() -> None:
    brief = tasks.build_brief(kind="plan", title="T", ask="a", questions=["q?"],
                              workspace_note="here", final_answer=True)  # fmt: skip
    assert brief.startswith("# Plan job: T") and "READ-ONLY" in brief
    assert "final message" in brief and f"saved as `{tasks.REPORT_NAME}`" not in brief
    api = tasks.build_brief(kind="plan", title="T", ask="a", questions=[], workspace_note="here")
    assert f"saved as `{tasks.REPORT_NAME}`" in api


def test_save_plan_never_saves_an_error(tmp_path: Path) -> None:
    assert not tasks.save_plan(tmp_path, "Claude Code error: limit", is_error=True)
    assert not tasks.save_plan(tmp_path, "   ")
    assert not (tmp_path / tasks.REPORT_NAME).exists()
    assert tasks.save_plan(tmp_path, "# Plan\nok")
    assert (tmp_path / tasks.REPORT_NAME).read_text(encoding="utf-8") == "# Plan\nok\n"


def test_submit_plan_delivers_none(root: Path) -> None:
    job = _submit_plan("--runtime", "claude_session")
    assert job["kind"] == "plan" and job["runtime"] == "claude_session"
    assert job["delivery"] == "none" and job["job_id"].startswith("scratch:r")


def test_claude_plan_job_runs_read_only_and_keeps_the_plan(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.claude_session.run as run_mod

    seen: dict[str, Any] = {}

    def fake_run_claude(**kw: Any) -> Any:
        seen.update(kw)
        # A plan-mode run cannot write: it only proposes its plan.
        assert not (Path(kw["cwd"]) / tasks.REPORT_NAME).exists()
        rounds = [parse_stream(json.dumps({"type": "result", "subtype": "success", "result": "# Retry plan\n1. x"}))]
        return run_mod.ClaudeRunOutcome(ConversationResult(rounds=rounds, stop_reason="done"), 1, None)

    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    job = _submit_plan("--runtime", "claude_session")
    final = tasks.run_task(root, job["job_id"])
    assert final["state"] == "done", final
    assert seen["permission_mode"] == "plan" and seen["gate_check"] is None
    assert "plan mode" in seen["prompt"]
    st = job_status(root, job["job_id"])
    assert st["kind"] == "plan" and st["report"]["title"] == "Retry plan"


def test_claude_plan_job_that_errors_fails(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import factory.claude_session.run as run_mod

    def fake_run_claude(**kw: Any) -> Any:
        conv = ConversationResult(stop_reason="claude_error", error="Claude Code error: API Error: 500 internal")
        return run_mod.ClaudeRunOutcome(conv, 1, None)

    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    job = _submit_plan("--runtime", "claude_session")
    final = tasks.run_task(root, job["job_id"])
    assert final["state"] == "failed" and "500 internal" in final["why"]


def test_claude_plan_job_at_its_limit_is_paused_not_failed(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """v1.9: the subscription limit pauses the job (queued + breaker), never fails it."""
    import factory.claude_session.run as run_mod

    def fake_run_claude(**kw: Any) -> Any:
        conv = ConversationResult(
            stop_reason="claude_error",
            error="Claude Code error: You've hit your limit \u00b7 resets 3pm (UTC)",
        )
        return run_mod.ClaudeRunOutcome(conv, 1, None)

    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    job = _submit_plan("--runtime", "claude_session")
    final = tasks.run_task(root, job["job_id"])
    assert final["state"] == "queued"
    assert final["paused"]["runtime"] == "claude_session"
    assert final["why"].startswith("paused: Claude limit, resumes ")


def test_research_still_skips_permissions(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import factory.claude_session.run as run_mod

    seen: dict[str, Any] = {}

    def fake_run_claude(**kw: Any) -> Any:
        seen.update(kw)
        (Path(kw["cwd"]) / tasks.REPORT_NAME).write_text("# R\n", encoding="utf-8")
        return run_mod.ClaudeRunOutcome(ConversationResult(stop_reason="green"), 1, None)

    monkeypatch.setattr(run_mod, "run_claude", fake_run_claude)
    from factory.cli import app

    out = CliRunner().invoke(app, ["job", "submit", "--json", "--source", "pa", "--kind", "research",
                                   "--runtime", "claude_session", "--title", "R", "--ask", "a"])  # fmt: skip
    job = json.loads(out.stdout.strip())
    assert tasks.run_task(root, job["job_id"])["state"] == "done"
    assert seen["permission_mode"] is None and seen["gate_check"] is not None
