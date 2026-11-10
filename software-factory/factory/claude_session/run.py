"""One Claude Code run, end to end: ledger row → launch → conversation → close.

Two callers:

* the dev step of a ``runtime: claude_session`` story
  (:func:`claude_dev_run`, called from ``handlers._handle_dev_once`` instead of
  ``runner.sandbox_run``; same arguments that matter, same ``RunResult``);
* a research/report job (``factory.jobs.tasks``), via :func:`run_claude`.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from factory import telemetry
from factory.claude_session import ledger
from factory.claude_session.conversation import ConversationResult, run_conversation
from factory.claude_session.launcher import Launcher, select_launcher
from factory.state_dir import state_dir

#: Seam: tests replace this to inject a fake launcher.
launcher_factory: Callable[[], tuple[Launcher, str | None]] = select_launcher


@dataclass
class ClaudeRunOutcome:
    conversation: ConversationResult
    run_row_id: int | None
    warning: str | None


def job_cancel_probe(
    db_path: Path, app: str | None, direction_id: str | None
) -> Callable[[], bool]:
    """``cancelled()`` for a run: True only when the durable cancel row EXISTS.

    Unlike ``delivery_gate.is_job_cancelled`` (which answers True on a read
    error, because there it guards a merge), a transient sqlite lock here must
    not kill a running conversation — the next poll asks again.
    """

    def _probe() -> bool:
        if not app or not direction_id:
            return False
        try:
            con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        except sqlite3.Error:
            return False
        try:
            row = con.execute(
                "SELECT 1 FROM job_cancellations WHERE app = ? AND direction_id = ?",
                (app, str(direction_id)),
            ).fetchone()
            return row is not None
        except sqlite3.Error:
            return False
        finally:
            con.close()

    return _probe


def session_links(
    *,
    app: str | None,
    direction_id: str | None,
    story_id: int | None,
    row_id: int | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, str] | None:
    """What a run's termhub session belongs to, as termhub's ``links``
    (``termhub/lib/sessionLinks.js``): the job, this step (the ``runs`` row),
    the story and the job's external id (the PA's ``<install>-<run>``, which is
    how the PA gets from a session back to its run and card). Ids only; empty
    values are left out. ``None`` when there is nothing to say."""
    from factory.jobs.common import format_job_id

    out: dict[str, str] = {}
    if app and direction_id:
        out["job"] = format_job_id(str(app), str(direction_id))
    if row_id is not None:
        out["step"] = str(row_id)
    if story_id is not None:
        out["story"] = str(story_id)
    for key, value in (extra or {}).items():
        if value not in (None, "") and key not in out:
            out[str(key)] = str(value)
    return out or None


def job_external_id(root: Path, app: str | None, direction_id: str | None) -> str | None:
    """The job's ``external_id`` (from its meta), or None. Best-effort: a
    link is never worth failing a run over."""
    if not app or not direction_id:
        return None
    try:
        from factory.jobs.common import find_job, format_job_id

        value = find_job(Path(root), format_job_id(app, str(direction_id))).meta.get("external_id")
    except Exception:  # noqa: BLE001 - nice-to-have
        return None
    return str(value) if value else None


def start_run_sandbox(
    *, run_id: str, workdir: Path, state_dir: Path, extra_readable: list[str] | None = None
) -> Any:
    """A started :class:`factory.sandbox.host.SandboxRun` for one agent run
    (ceiling ``none``, no broker). Readable: the interpreter and ``factory``
    package, the agent's binary, its ``--add-dir`` dirs, and the worktree's
    common git dir (read-only, so ``git status`` / ``git diff`` work).

    ``FACTORY_SANDBOX_PASS_ENV`` (comma list, default
    ``CLAUDE_CODE_OAUTH_TOKEN``) names the model credential passed in: Claude
    Code calls the model from inside, so that one key enters; GitHub tokens
    never do."""
    import os

    from factory.sandbox.host import SandboxRun, readable_for

    pass_env = [
        x.strip()
        for x in os.environ.get("FACTORY_SANDBOX_PASS_ENV", "CLAUDE_CODE_OAUTH_TOKEN").split(",")
        if x.strip()
    ]
    return SandboxRun(
        run_id=run_id,
        workdir=workdir,
        state_dir=state_dir,
        ceiling="none",
        readable=readable_for(workdir, extra_readable),
        pass_env=pass_env,
    ).start()


def run_claude(
    *,
    db_path: Path,
    persona: str,
    cwd: Path,
    run_dir: Path,
    prompt: str,
    title: str,
    model: str | None,
    wall_clock_s: float,
    story_id: int | None = None,
    app: str | None = None,
    direction_id: str | None = None,
    story_path: str | None = None,
    gate_check: Callable[[], Any] | None = None,
    max_gate_rounds: int = 1,
    no_progress_abort_s: float | None = None,
    cancelled: Callable[[], bool] | None = None,
    add_dirs: list[str] | None = None,
    success: Callable[[ConversationResult], bool] | None = None,
    links: dict[str, Any] | None = None,
    permission_mode: str | None = None,
    resume_session: str | None = None,
    budget_left_usd: Callable[[], float | None] | None = None,
) -> ClaudeRunOutcome:
    from factory.claude_session.cli import claude_binary

    row_id = ledger.open_run(
        db_path,
        persona=persona,
        model=model,
        story_id=story_id,
        app=app,
        direction_id=direction_id,
        repo_path=str(cwd),
        story_path=story_path,
        run_dir=str(run_dir),
    )
    claude_bin = claude_binary()
    if claude_bin is None:
        conv = ConversationResult(
            stop_reason="launch_failed", error="the `claude` CLI is not available here"
        )
        ledger.close_run(
            db_path,
            row_id,
            success=False,
            error=conv.error,
            tokens_in=0,
            tokens_out=0,
            cached_input_tokens=0,
            subscription_equiv_usd=0.0,
            duration_s=0.0,
            usage_reliable=False,
        )
        return ClaudeRunOutcome(conv, row_id, None)
    launcher, warning = launcher_factory()
    # E1: the session carries its job/step/story ids (and the caller's extras,
    # e.g. the external id), so Run links back to Build without reading titles.
    if hasattr(launcher, "links"):
        launcher.links = session_links(
            app=app, direction_id=direction_id, story_id=story_id, row_id=row_id, extra=links
        )

    # 5.2: FACTORY_SANDBOX=on starts claude inside an OS sandbox with no
    # GitHub credential and egress through the allowlist proxy. Ceiling
    # `none`: a factory agent never pushes; the factory delivers. Fail safe: a
    # sandbox that cannot start fails the run, it never runs unsandboxed.
    sandbox: Any = None
    argv_wrap: Callable[[list[str]], list[str]] | None = None
    from factory.sandbox import enabled as _sandbox_enabled

    if _sandbox_enabled("FACTORY_SANDBOX"):
        try:
            sandbox = start_run_sandbox(
                run_id=f"{app or 'run'}-{story_id or 0}-{row_id}",
                workdir=Path(cwd),
                state_dir=Path(run_dir) / "sandbox",
                extra_readable=[claude_bin, *(add_dirs or [])],
            )
            argv_wrap = sandbox.wrap
        except Exception as exc:  # noqa: BLE001 - reported on the run row
            conv = ConversationResult(
                stop_reason="launch_failed", error=f"FACTORY_SANDBOX=on but the sandbox did not start: {exc}"[:500]
            )
            ledger.close_run(
                db_path, row_id, success=False, error=conv.error, tokens_in=0, tokens_out=0,
                cached_input_tokens=0, subscription_equiv_usd=0.0, duration_s=0.0, usage_reliable=False,
            )
            return ClaudeRunOutcome(conv, row_id, None)

    def _on_session(info: Any) -> None:
        ledger.set_session(db_path, row_id, info.as_json())
        try:
            (Path(run_dir) / "session.json").write_text(
                json.dumps(info.as_json() or {"machine": info.machine, **info.extra}),
                encoding="utf-8",
            )
        except OSError:
            pass

    try:
        with telemetry.span("factory.claude_session", persona, persona=persona) as tel:
            conv = run_conversation(
                cwd=Path(cwd),
                run_dir=Path(run_dir),
                prompt=prompt,
                title=title,
                launcher=launcher,
                claude_bin=claude_bin,
                model=model,
                wall_clock_s=wall_clock_s,
                gate_check=gate_check,
                max_gate_rounds=max_gate_rounds,
                no_progress_abort_s=no_progress_abort_s,
                cancelled=cancelled or (lambda: False),
                on_session=_on_session,
                add_dirs=add_dirs,
                permission_mode=permission_mode,
                argv_wrap=argv_wrap,
                resume_session=resume_session,
                budget_left_usd=budget_left_usd,
            )
            tel["stop_reason"] = conv.stop_reason
            tel["rounds"] = len(conv.rounds)
    finally:
        if sandbox is not None:
            sandbox.close()
    ok = success(conv) if success is not None else (conv.stop_reason in ("done", "green"))
    error = conv.error
    if not ok and not error:
        verdict = conv.final_verdict
        error = getattr(verdict, "reason", None) or f"stopped: {conv.stop_reason}"
    actual_model = model or next((r.model for r in conv.rounds if r.model), None)
    ledger.close_run(
        db_path,
        row_id,
        success=ok,
        error=None if ok else error,
        tokens_in=conv.tokens_in,
        tokens_out=conv.tokens_out,
        cached_input_tokens=conv.cached_input_tokens,
        subscription_equiv_usd=conv.subscription_equiv_usd,
        duration_s=conv.duration_s,
        usage_reliable=conv.any_result,
        model=actual_model,
    )
    # The credit pool (native plan 7.5): the run's total_cost_usd and token usage go
    # to the PA's Meter. Only when Claude reported a result: a launch that never
    # reached the model drew nothing.
    if conv.any_result:
        telemetry.record_usage(
            purpose=f"factory-{persona}",
            model=actual_model,
            cost_usd=conv.subscription_equiv_usd,
            tokens_in=conv.tokens_in,
            tokens_out=conv.tokens_out,
            duration_ms=round(conv.duration_s * 1000),
            ok=bool(ok),
        )
    return ClaudeRunOutcome(conv, row_id, warning)


_CLAUDE_DEV_FOOTER = """\
# Running as Claude Code inside the software factory

- Your working directory is the story's git worktree. Make the change there and
  run the repo's test command yourself until it is green.
- Do NOT push, open pull requests, switch or create branches, or rewrite git
  history. The factory commits your working tree and delivers it.
- Nobody will answer questions mid-run. Decide, and say what you assumed.
- End your final message with the `SELF_SUMMARY:` block your instructions ask
  for (and `UNDERSPECIFIED: <why>` instead of guessing, if the job cannot be
  done as written).
"""


def claude_dev_run(
    *,
    story_path: Path,
    repo_path: Path,
    software_factory_root: Path,
    db_path: Path,
    model: str | None,
    test_command: str | None,
    direction_chain: list[Any] | None = None,
    prior_attempts: list[dict[str, Any]] | None = None,
    reviewer_findings: dict[str, Any] | None = None,
    story_id: int | None = None,
    app: str | None = None,
    direction_id: str | None = None,
    wall_clock_timeout_s: int | None = None,
    gate_check: Callable[[], Any] | None = None,
    max_gate_rounds: int = 1,
    no_progress_abort_s: int | None = None,
    brief_addendum: str | None = None,
    context_dir: str | None = None,
    resume_session_id: str | None = None,
    job_budget_left_usd: float | None = None,
    **_ignored: Any,
) -> Any:
    """The claude_session twin of ``runner.sandbox_run(persona="dev", …)``.

    Returns a ``runner.RunResult`` the dev handler reads exactly like an
    OpenHands result. ``cost_usd`` is 0.0 (subscription, unmetered; the API
    equivalent is on the run row). A run that produced no Claude result event
    at all (CLI crashed, not logged in, launch failed) is ``premodel_infra`` so
    the handler's bounded infra path re-dispatches it without burning a dev
    retry. ``spend_cap_usd`` is ignored: nothing here is metered.
    """
    from factory.context.loader import compose_context_prelude
    from factory.runner import (
        RunResult,
        _build_initial_message,
        _extract_self_summary,
        _read_persona_prompt,
        _run_pytest,
        _scan_repo_for_changed_files,
    )

    story_text = Path(story_path).read_text(encoding="utf-8")
    prelude = compose_context_prelude(
        persona="dev",
        app_repo_path=repo_path,
        direction_chain=direction_chain,
        software_factory_root=software_factory_root,
        context_dir=context_dir,
    )
    prompt = _build_initial_message(
        persona="dev",
        story_text=story_text,
        context_prelude=prelude,
        persona_prompt=_read_persona_prompt("dev", context_dir),
        prior_attempts=prior_attempts,
        reviewer_findings=reviewer_findings,
    )
    if brief_addendum:
        prompt = f"{prompt.rstrip()}\n\n---\n\n{brief_addendum.strip()}\n"
    prompt = f"{prompt.rstrip()}\n\n---\n\n{_CLAUDE_DEV_FOOTER}"

    from datetime import UTC, datetime

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir = (
        state_dir(Path(software_factory_root))
        / "claude_runs"
        / f"{app or 'app'}-{story_id or 0}-{stamp}"
    )
    def _go(text: str, resume: str | None, sub_dir: str) -> ClaudeRunOutcome:
        return run_claude(
            db_path=db_path,
            persona="dev",
            cwd=Path(repo_path),
            run_dir=run_dir / sub_dir if sub_dir else run_dir,
            prompt=text,
            title=f"factory dev · {app}:{direction_id} story {story_id}",
            model=model,
            wall_clock_s=float(wall_clock_timeout_s or 1800),
            story_id=story_id,
            app=app,
            direction_id=direction_id,
            story_path=str(story_path),
            gate_check=gate_check,
            max_gate_rounds=max_gate_rounds,
            no_progress_abort_s=no_progress_abort_s,
            cancelled=job_cancel_probe(db_path, app, direction_id),
            success=None,
            links={"external": job_external_id(software_factory_root, app, direction_id)},
            resume_session=resume,
            budget_left_usd=(lambda: job_budget_left_usd)
            if job_budget_left_usd is not None
            else None,
        )

    outcome: ClaudeRunOutcome | None = None
    if resume_session_id and reviewer_findings:
        # JOBS-API v1.9: the review's findings go back into the dev's OWN
        # conversation (``--resume``), which still holds the job, the repo
        # reading and its reasoning. If that session cannot be resumed (gone,
        # another machine) and nothing was done, start fresh with everything.
        outcome = _go(fix_round_message(reviewer_findings), resume_session_id, "")
        c = outcome.conversation
        if not c.any_result and c.tokens_out == 0 and not c.cancelled:
            outcome = _go(prompt, None, "fresh")
    if outcome is None:
        outcome = _go(prompt, None, "")
    conv = outcome.conversation
    if gate_check is not None:
        verdict = conv.final_verdict
        passed = bool(verdict is not None and verdict.passed)
        summary_tail = getattr(verdict, "output", "") or ""
        error = None if passed else (getattr(verdict, "reason", None) or conv.error)
    elif conv.any_result and not conv.cancelled:
        passed, summary_tail = _run_pytest(Path(repo_path), test_command=test_command)
        error = None if passed else (conv.error or "tests red after the Claude Code run")
    else:
        passed, summary_tail, error = False, "", conv.error
    if conv.cancelled:
        error = "cancelled: the job was cancelled while Claude Code was running"
    last_text = conv.last_text
    recent = conv.rounds[-1].tool_calls[-8:] if conv.rounds else []
    # Claude did no work at all (CLI crash, logged out, launch failure, or an
    # error result with zero output such as the subscription's usage limit)
    # and no grade was taken: infrastructure, not a dev attempt. The handler's
    # ``_is_premodel_infra_failure`` needs ``test_run_passed is None`` for that.
    premodel = (
        conv.tokens_out == 0 and not conv.cancelled and not conv.timed_out and not conv.gate_rounds
    )
    return RunResult(
        success=passed,
        files_changed=_scan_repo_for_changed_files(Path(repo_path)),
        test_run_passed=None if premodel else passed,
        tokens_in=conv.tokens_in,
        tokens_out=conv.tokens_out,
        cost_usd=0.0,
        error=error,
        summary=(summary_tail or last_text)[-4000:],
        last_assistant_message=last_text[-2000:],
        recent_tool_calls=recent,
        self_summary=_extract_self_summary(last_text),
        premodel_infra=premodel,
        usage_reliable=conv.any_result or None,
        gate_rounds=list(conv.gate_rounds),
        gate_stop_reason=conv.stop_reason,
        agent_session_id=conv.session_id,
        provider_error=conv.error if conv.stop_reason == "claude_error" else None,
    )


def fix_round_message(reviewer_findings: dict[str, Any]) -> str:
    """The message a resumed dev session gets for a review fix round: the
    findings, rendered as the fresh prompt renders them, and the rules."""
    from factory.runner import _build_initial_message

    marker = "\u2063FIX-ROUND\u2063"
    full = _build_initial_message(
        persona="dev",
        story_text=marker,
        context_prelude="",
        persona_prompt="",
        reviewer_findings=reviewer_findings,
    )
    findings = full.split(marker, 1)[1].strip() if marker in full else full
    return (
        "# An independent review of your change found blocking issues\n\n"
        "A separate read-only reviewer read your diff. Fix what it found in this "
        "same working tree, keep the tests green, and do not touch unrelated code. "
        "This is the ONE fix round: a blocking finding that survives it stops the "
        "job for a human. The factory grades your tree again when you stop.\n\n"
        f"{findings}\n\n"
        "End with the `SELF_SUMMARY:` block again.\n"
    )


_CLAUDE_REVIEW_FOOTER = """\
# Running as Claude Code inside the software factory: the REVIEW step

- You are the independent reviewer. You did not write this change; judge it.
- This run is READ-ONLY (Claude Code plan permission mode): read, grep and
  list any file in the working directory (the story's worktree, with the
  change applied) and run read-only git (`git diff`, `git log`). Do not try
  to edit anything.
- Your FINAL message must be ONLY the review JSON object your instructions
  describe. If you use ExitPlanMode, the plan you submit must be that JSON.
"""

_CLAUDE_TEXT_FOOTER = """# Running as Claude Code inside the software factory: the {persona} step

- This run is READ-ONLY (Claude Code plan permission mode): read, grep and
  list any file in the working directory and run read-only git. Do not try
  to edit anything; the factory writes files from your answer.
- Your FINAL message must be ONLY the JSON object your instructions describe.
  If you use ExitPlanMode, the plan you submit must be that JSON.
"""

#: One review run's wall clock. A review reads; it does not iterate.
CLAUDE_REVIEW_WALL_CLOCK_S = 1800


def claude_review_run(
    *,
    prompt: str,
    worktree: Path,
    software_factory_root: Path,
    db_path: Path,
    model: str | None,
    story_id: int | None,
    app: str | None,
    direction_id: str | None,
    wall_clock_s: float = CLAUDE_REVIEW_WALL_CLOCK_S,
    persona: str = "reviewer",
) -> tuple[str, ConversationResult]:
    """The review step on ``claude_session`` (JOBS-API v1.9).

    The same reviewer prompt the api runtime sends to ``text_run``, run by a
    separate Claude Code conversation in ``plan`` permission mode (read-only,
    enforced by Claude Code, not by the prompt), in the story worktree so it
    can open any file. Returns the review text (the last ``ExitPlanMode`` plan,
    else the final message) for ``handlers._parse_reviewer_result``, and the
    conversation (its ``error`` carries a provider-limit message).
    """
    from datetime import UTC, datetime

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    is_review = persona == "reviewer"
    step = "review" if is_review else persona
    footer = _CLAUDE_REVIEW_FOOTER if is_review else _CLAUDE_TEXT_FOOTER.format(persona=persona)
    run_dir = (
        state_dir(Path(software_factory_root))
        / "claude_runs"
        / f"{app or 'app'}-{story_id or 0}-{step}-{stamp}"
    )
    outcome = run_claude(
        db_path=db_path,
        persona=persona,
        cwd=Path(worktree),
        run_dir=run_dir,
        prompt=f"{prompt.rstrip()}\n\n---\n\n{footer}",
        title=f"factory {step} · {app}:{direction_id} story {story_id}",
        model=model,
        wall_clock_s=float(wall_clock_s),
        story_id=story_id,
        app=app,
        direction_id=direction_id,
        cancelled=job_cancel_probe(db_path, app, direction_id),
        success=lambda c: bool(c.any_result) and not c.error,
        links={"external": job_external_id(software_factory_root, app, direction_id)},
        permission_mode="plan",
    )
    conv = outcome.conversation
    return ("" if conv.error else conv.plan_text), conv


__all__ = [
    "CLAUDE_REVIEW_WALL_CLOCK_S",
    "claude_review_run",
    "ClaudeRunOutcome",
    "claude_dev_run",
    "job_cancel_probe",
    "job_external_id",
    "launcher_factory",
    "run_claude",
    "session_links",
]
