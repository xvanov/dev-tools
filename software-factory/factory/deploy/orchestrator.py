"""Generic deploy orchestrator.

Public entry point: ``deploy_post_merge(app, merged_pr_number, merged_sha,
software_factory_root, *, dry_run=False) -> DeployAction``.

Flow:
  1. Load AppConfig + DeployConfig.
  2. Honor factory mode (``paused`` / ``deploy-frozen`` refuse).
  3. Consult ``can_dispatch("deploy", ...)`` for spend caps.
  4. Run ``pre_deploy_commands`` in order. Stop on first nonzero exit.
  5. Run ``deploy_command``.
  6. Run ``health_check_command`` with polling.
  7. Run ``smoke_test_command``.
  8. On success: record SHA + run post_deploy_record metadata commands.
  9. On failure: run ``rollback_command``, file a p0 regression issue,
     auto-switch mode to ``fix-only`` (real-run only).

Dry-run is TRULY dry: NO ``subprocess.run`` for the deploy commands. The
caller passes ``fixture_step_outputs`` (a list of ``(exit_code, stdout,
stderr)`` tuples, one per executed step) or ``fixture_step_outputs_by_phase``
to drive the decision logic deterministically. The orchestrator records
the DeployAction the same way it would in real-run.

GENERIC: this module is stack-agnostic. The factory itself knows nothing
about Docker, Compose, Fly, Vercel, etc. Every command comes from the
app's ``apps/<name>/config.yaml`` ``deploy:`` block.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, SQLModel, create_engine, select

from factory.app_config import DeployConfig, load_app_config
from factory.deploy.models import DeployActionRecord, DeployQueueEntry
from factory.deploy.runner import run_command
from factory.runtime_state import effective_deploy_enabled, get_deploy_enabled_override
from factory.settings.enforcer import can_dispatch
from factory.settings.loader import load_settings
from factory.settings.modes import get_mode, set_mode
from factory.settings.spend import hour_spend_usd, today_spend_usd

# Phases in order (originally mirrored the orphan ``release_manager``
# persona's deploy_plan; that persona had no dispatch path and was deleted
# 2026-08-07 — 019 AC5 — this deploy orchestrator is the real implementation).
PHASE_PRE_DEPLOY = "pre_deploy"
PHASE_DEPLOY = "deploy"
PHASE_HEALTH_CHECK = "health_check"
PHASE_SMOKE_TEST = "smoke_test"
PHASE_ROLLBACK = "rollback"
PHASE_POST_DEPLOY_RECORD = "post_deploy_record"

# How much stdout/stderr to keep on each StepResult. Larger outputs are
# excerpted to keep DB rows manageable; the full output is only logged.
_EXCERPT_BYTES = 4_096


@dataclass
class StepResult:
    """Outcome of a single shell step in the deploy plan."""

    phase: str
    command: str
    exit_code: int
    stdout_excerpt: str = ""
    stderr_excerpt: str = ""
    duration_seconds: float = 0.0
    attempts: int = 1  # health_check polls multiple times; everything else is 1


@dataclass
class DeployAction:
    """Returned to the caller. Pure data shape for the CLI/tests."""

    app: str
    merged_pr_number: int
    merged_sha: str
    started_at: str
    completed_at: str | None = None
    steps: list[StepResult] = field(default_factory=list)
    success: bool = False
    smoke_passed: bool = False
    rolled_back: bool = False
    error: str | None = None
    p0_issue_number: int | None = None
    mode_after: str | None = None


# --------------------------------------------------------------------------- #
# DB helpers
# --------------------------------------------------------------------------- #


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    return eng


def _status_from_action(action: DeployAction) -> str:
    """Map a DeployAction's flags to the DeployActionRecord.status literal.

    * ``deployed`` — all phases succeeded.
    * ``rolled_back`` — a phase failed AND the rollback step ran.
    * ``errored`` — failure with no rollback (rollback command missing, or
      rollback step itself nonzero).
    * ``skipped`` — pre-flight guard rejected (mode, caps, config missing).
    """
    if action.success:
        return "deployed"
    if action.rolled_back:
        return "rolled_back"
    # Pre-flight rejection reasons set ``error`` without running any steps.
    skip_reasons = {
        "mode_blocks_deploy",
        "deploy_disabled_in_config",
        "deploy_disabled_by_runtime_override",
        "app_config_missing",
    }
    if action.error and (
        action.error in skip_reasons
        or action.error.startswith("app_config_missing")
        or action.error.startswith("mode_")
        or action.error.endswith("_cap_exceeded")
    ):
        return "skipped"
    return "errored"


def _phase_duration(action: DeployAction, phase: str) -> float:
    return round(sum(s.duration_seconds for s in action.steps if s.phase == phase), 4)


def _phase_passed(action: DeployAction, phase: str) -> bool:
    """True iff at least one step ran in ``phase`` and the last one exited 0."""
    relevant = [s for s in action.steps if s.phase == phase]
    return bool(relevant) and relevant[-1].exit_code == 0


def _record_deploy(action: DeployAction, db_path: Path) -> int:
    eng = _engine(db_path)
    status = _status_from_action(action)
    skipped_reason: str | None = None
    if status == "skipped":
        skipped_reason = action.error
    rec = DeployActionRecord(
        app=action.app,
        sha=action.merged_sha,
        status=status,
        pre_deploy_duration_s=_phase_duration(action, PHASE_PRE_DEPLOY),
        deploy_duration_s=_phase_duration(action, PHASE_DEPLOY),
        health_check_passed=_phase_passed(action, PHASE_HEALTH_CHECK),
        smoke_passed=action.smoke_passed,
        rollback_triggered=action.rolled_back,
        rollback_passed=_phase_passed(action, PHASE_ROLLBACK),
        error=action.error,
        per_phase_results_json=json.dumps([asdict(s) for s in action.steps]),
        skipped_reason=skipped_reason,
    )
    with Session(eng) as session:
        session.add(rec)
        session.commit()
        session.refresh(rec)
        assert rec.id is not None
        return int(rec.id)


def enqueue_deploy(
    *,
    app: str,
    sha: str,
    merged_pr_number: int | None,
    software_factory_root: Path,
    db_path: Path | None = None,
) -> int:
    """Push a deploy candidate onto ``deploy_queue`` for the webhook path.

    Returns the queue row id. Idempotent only by row insertion — the
    webhook may legitimately enqueue the same sha twice if the same PR
    triggers ``closed[merged=true]`` twice (we still record both attempts).
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    eng = _engine(db)
    entry = DeployQueueEntry(app=app, sha=sha, merged_pr_number=merged_pr_number)
    with Session(eng) as session:
        session.add(entry)
        session.commit()
        session.refresh(entry)
        assert entry.id is not None
        return int(entry.id)


def drain_deploy_queue(
    *,
    app: str,
    software_factory_root: Path,
    dry_run: bool = True,
    fixture_step_outputs_by_sha: dict[str, list[tuple[int, str, str]]] | None = None,
    github_client: Any = None,
    db_path: Path | None = None,
) -> list[DeployAction]:
    """Pop unprocessed deploy queue entries for ``app`` and run each.

    Used by the webhook tick path so the request handler can return fast
    while the actual deploy runs on the next orchestrator tick.
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    eng = _engine(db)
    out: list[DeployAction] = []
    with Session(eng) as session:
        rows = list(
            session.exec(
                select(DeployQueueEntry).where(
                    DeployQueueEntry.app == app,
                    DeployQueueEntry.processed_at.is_(None),  # type: ignore[union-attr]
                )
            ).all()
        )
    for row in rows:
        fixtures = (fixture_step_outputs_by_sha or {}).get(row.sha)
        action = deploy_post_merge(
            app,
            row.merged_pr_number or 0,
            row.sha,
            root,
            dry_run=dry_run,
            fixture_step_outputs=fixtures,
            github_client=github_client,
            db_path=db,
        )
        # Mark the queue row processed.
        with Session(eng) as session:
            entry = session.get(DeployQueueEntry, row.id)
            if entry is not None:
                entry.processed_at = datetime.now(UTC).isoformat()
                entry.result_status = _status_from_action(action)
                session.add(entry)
                session.commit()
        out.append(action)
    return out


# --------------------------------------------------------------------------- #
# Step execution (real-run + dry-run paths)
# --------------------------------------------------------------------------- #


def _excerpt(text: str | bytes | None) -> str:
    if text is None:
        return ""
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - belt-and-suspenders
            return ""
    if len(text) <= _EXCERPT_BYTES:
        return text
    head = text[: _EXCERPT_BYTES // 2]
    tail = text[-_EXCERPT_BYTES // 2 :]
    return f"{head}\n... [truncated {len(text) - _EXCERPT_BYTES} bytes] ...\n{tail}"


@dataclass
class _FixtureOutput:
    exit_code: int
    stdout: str = ""
    stderr: str = ""


class _FixtureQueue:
    """Iterator over fixture step outputs.

    ``by_phase`` takes precedence: if a step's phase has a queue, we pop
    from it. Otherwise we fall back to the global ``ordered`` queue.
    """

    def __init__(
        self,
        ordered: list[tuple[int, str, str]] | None,
        by_phase: dict[str, list[tuple[int, str, str]]] | None,
    ) -> None:
        self._ordered: list[tuple[int, str, str]] = list(ordered or [])
        self._by_phase: dict[str, list[tuple[int, str, str]]] = {
            k: list(v) for k, v in (by_phase or {}).items()
        }

    def next(self, phase: str) -> _FixtureOutput:
        if phase in self._by_phase and self._by_phase[phase]:
            exit_code, stdout, stderr = self._by_phase[phase].pop(0)
        elif self._ordered:
            exit_code, stdout, stderr = self._ordered.pop(0)
        else:
            # Default to success when no fixture is provided.
            return _FixtureOutput(0, "", "")
        return _FixtureOutput(exit_code=exit_code, stdout=stdout, stderr=stderr)


def _resolve_cwd(working_directory: str | None, root: Path) -> Path:
    """Resolve the deploy step's working directory against the factory root.

    ``working_directory`` is interpreted relative to ``root`` when it is a
    relative path, and used as-is when absolute. ``None`` falls back to
    ``root`` itself.
    """
    if working_directory is None:
        return root
    wd = Path(working_directory)
    if wd.is_absolute():
        return wd
    return (root / wd).resolve()


def _run_step(
    *,
    phase: str,
    command: str,
    dry_run: bool,
    fixtures: _FixtureQueue,
    deploy_config: DeployConfig | None = None,
    root: Path | None = None,
) -> StepResult:
    """Execute a single shell step, returning a StepResult.

    In dry-run mode, NO subprocess is launched — the result comes from
    ``fixtures``. In real-run, delegate to ``factory.deploy.runner.run_command``
    so the deploy honors ``timeout_seconds``, ``working_directory``, and
    ``env_var_passthrough`` from the app's deploy config.
    """
    started = time.monotonic()
    if dry_run:
        fx = fixtures.next(phase)
        elapsed = time.monotonic() - started
        return StepResult(
            phase=phase,
            command=command,
            exit_code=fx.exit_code,
            stdout_excerpt=_excerpt(fx.stdout),
            stderr_excerpt=_excerpt(fx.stderr),
            duration_seconds=round(elapsed, 4),
        )
    # Real run: delegate to runner.run_command so timeout/cwd/env are honored.
    assert deploy_config is not None, "deploy_config required for real-run _run_step"
    assert root is not None, "root required for real-run _run_step"
    cwd = _resolve_cwd(deploy_config.working_directory, root)
    cwd.mkdir(parents=True, exist_ok=True)
    result = run_command(
        command,
        cwd=cwd,
        env_var_passthrough=deploy_config.env_var_passthrough,
        timeout=deploy_config.timeout_seconds,
        phase=phase,
    )
    elapsed = time.monotonic() - started
    return StepResult(
        phase=phase,
        command=command,
        exit_code=int(result.exit_code),
        stdout_excerpt=_excerpt(result.stdout),
        stderr_excerpt=_excerpt(result.stderr),
        duration_seconds=round(elapsed, 4),
    )


def _run_health_check(
    *,
    deploy_config: DeployConfig,
    dry_run: bool,
    fixtures: _FixtureQueue,
    sleep_fn: Any = time.sleep,
    root: Path | None = None,
) -> StepResult:
    """Health check with poll-and-retry semantics.

    Attempts up to ``health_check_max_attempts`` with
    ``health_check_interval_seconds`` between tries. Any 0-exit attempt
    short-circuits success; the final attempt's outcome is recorded.
    """
    command = deploy_config.health_check_command or ""
    max_attempts = max(1, int(deploy_config.health_check_max_attempts))
    interval = max(0, int(deploy_config.health_check_interval_seconds))
    last: StepResult | None = None
    for attempt in range(1, max_attempts + 1):
        step = _run_step(
            phase=PHASE_HEALTH_CHECK,
            command=command,
            dry_run=dry_run,
            fixtures=fixtures,
            deploy_config=deploy_config,
            root=root,
        )
        step.attempts = attempt
        last = step
        if step.exit_code == 0:
            return step
        if attempt < max_attempts and interval > 0:
            sleep_fn(interval)
    assert last is not None
    return last


# --------------------------------------------------------------------------- #
# Rollback / failure handling
# --------------------------------------------------------------------------- #


def _file_p0_issue(
    *,
    app: str,
    merged_pr_number: int,
    merged_sha: str,
    error: str,
    github_client: Any,
    repo: str,
    dry_run: bool,
) -> int | None:
    """File the deploy-regression p0 issue. Dry-run returns a synthesized number.

    Mirrors the rollback worker's p0 conventions so the reviewer/inbox can
    consume both consistently.
    """
    if dry_run or github_client is None:
        # Synthesize a deterministic number so tests can assert on it.
        return 7000 + int(merged_pr_number)
    gh_repo = github_client.get_repo(repo)
    issue = gh_repo.create_issue(
        title=f"[p0] Deploy failed for PR #{merged_pr_number} (sha {merged_sha})",
        body=(
            f"Deploy of PR #{merged_pr_number} (sha `{merged_sha}`) failed.\n\n"
            f"Error: {error}\n\n"
            "Rollback command was attempted. Factory mode auto-flipped to `fix-only`."
        ),
        labels=["priority/p0", "deploy-regression"],
    )
    return int(issue.number)


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #


def deploy_post_merge(  # noqa: C901 - top-level orchestration; refactor when phases grow
    app: str,
    merged_pr_number: int,
    merged_sha: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    fixture_step_outputs: list[tuple[int, str, str]] | None = None,
    fixture_step_outputs_by_phase: dict[str, list[tuple[int, str, str]]] | None = None,
    github_client: Any = None,
    db_path: Path | None = None,
    sleep_fn: Any = time.sleep,
) -> DeployAction:
    """Orchestrate the post-merge deploy for ``merged_pr_number`` on ``app``.

    Returns a ``DeployAction`` recording every step + final disposition.
    Always writes a ``DeployActionRecord`` row so ``factory deploys`` lists
    every attempt.

    ``fixture_step_outputs`` (positional queue) and
    ``fixture_step_outputs_by_phase`` drive dry-run behavior; by_phase
    takes precedence when both are supplied. ``sleep_fn`` is injectable so
    tests can run health-check retries without wall-clock waits.
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    started_at = datetime.now(UTC).isoformat()

    action = DeployAction(
        app=app,
        merged_pr_number=merged_pr_number,
        merged_sha=merged_sha,
        started_at=started_at,
    )

    try:
        cfg = load_app_config(app, root)
    except FileNotFoundError as exc:
        action.error = f"app_config_missing: {exc}"
        action.completed_at = datetime.now(UTC).isoformat()
        _record_deploy(action, db)
        return action

    dcfg = cfg.deploy
    # Effective deploy.enabled merges the operator-authored config default
    # with an optional machine runtime override (state/runtime/<app>.json),
    # so a recovery flip and an operator edit no longer collide in the same
    # file. When the override is what disabled it, record a distinct reason
    # so config-authored vs machine-flipped is observable in the action row.
    if not effective_deploy_enabled(cfg, root):
        override = get_deploy_enabled_override(root, app)
        action.error = (
            "deploy_disabled_by_runtime_override"
            if override is False and dcfg.enabled
            else "deploy_disabled_in_config"
        )
        action.completed_at = datetime.now(UTC).isoformat()
        _record_deploy(action, db)
        return action

    # Mode gate.
    mode = get_mode(root, db_path=db)
    if mode in {"paused", "deploy-frozen"}:
        action.error = "mode_blocks_deploy"
        action.mode_after = mode
        action.completed_at = datetime.now(UTC).isoformat()
        _record_deploy(action, db)
        return action

    # Spend / cap gate via the settings enforcer.
    settings = load_settings(root)
    state_dict = {
        "mode": mode,
        "global_in_flight": 0,  # deploys are not counted as in-flight stories
        "app_in_flight": 0,
        "today_spend_usd": today_spend_usd(root, db_path=db),
        "hour_spend_usd": hour_spend_usd(root, db_path=db),
        "open_prs_for_app": None,
        "failing_ci_count": None,
        "pm_invocations_last_hour": 0,
    }
    decision = can_dispatch("deploy", app, state_dict, settings)
    if not decision.allowed:
        action.error = decision.rejected_reason or "deploy_dispatch_rejected"
        action.mode_after = mode
        action.completed_at = datetime.now(UTC).isoformat()
        _record_deploy(action, db)
        return action

    fixtures = _FixtureQueue(fixture_step_outputs, fixture_step_outputs_by_phase)

    # Run the plan. Stop on first nonzero exit and route to failure.
    failure_reason: str | None = None

    # 1. pre_deploy_commands
    for cmd in dcfg.pre_deploy_commands:
        step = _run_step(
            phase=PHASE_PRE_DEPLOY,
            command=cmd,
            dry_run=dry_run,
            fixtures=fixtures,
            deploy_config=dcfg,
            root=root,
        )
        action.steps.append(step)
        if step.exit_code != 0:
            failure_reason = f"pre_deploy_failed: {cmd}"
            break

    # 2. deploy_command
    if failure_reason is None:
        if not dcfg.deploy_command:
            failure_reason = "deploy_command_missing_in_config"
        else:
            step = _run_step(
                phase=PHASE_DEPLOY,
                command=dcfg.deploy_command,
                dry_run=dry_run,
                fixtures=fixtures,
                deploy_config=dcfg,
                root=root,
            )
            action.steps.append(step)
            if step.exit_code != 0:
                failure_reason = f"deploy_failed: exit={step.exit_code}"

    # 3. health_check_command (poll)
    if failure_reason is None:
        if not dcfg.health_check_command:
            failure_reason = "health_check_command_missing_in_config"
        else:
            step = _run_health_check(
                deploy_config=dcfg,
                dry_run=dry_run,
                fixtures=fixtures,
                sleep_fn=sleep_fn,
                root=root,
            )
            action.steps.append(step)
            if step.exit_code != 0:
                failure_reason = (
                    f"health_check_failed after {step.attempts} attempt(s): exit={step.exit_code}"
                )

    # 4. smoke_test_command
    if failure_reason is None:
        if not dcfg.smoke_test_command:
            failure_reason = "smoke_test_command_missing_in_config"
        else:
            step = _run_step(
                phase=PHASE_SMOKE_TEST,
                command=dcfg.smoke_test_command,
                dry_run=dry_run,
                fixtures=fixtures,
                deploy_config=dcfg,
                root=root,
            )
            action.steps.append(step)
            if step.exit_code == 0:
                action.smoke_passed = True
            else:
                failure_reason = f"smoke_test_failed: exit={step.exit_code}"

    if failure_reason is None:
        action.success = True
        # post_deploy_record metadata commands (best-effort; nonzero exits do
        # NOT trigger rollback — they're audit metadata).
        for _label, cmd in dcfg.post_deploy_record.items():
            step = _run_step(
                phase=PHASE_POST_DEPLOY_RECORD,
                command=cmd,
                dry_run=dry_run,
                fixtures=fixtures,
                deploy_config=dcfg,
                root=root,
            )
            action.steps.append(step)
        action.mode_after = mode
    else:
        action.error = failure_reason
        # Rollback path. ``rolled_back`` is True only when the rollback
        # step itself exits 0 — a rollback that fails to actually roll
        # back leaves the system in an undefined state and must be
        # reflected as ``status="errored"`` in the persisted record (see
        # ``_status_from_action``).
        if dcfg.rollback_command:
            rb_step = _run_step(
                phase=PHASE_ROLLBACK,
                command=dcfg.rollback_command,
                dry_run=dry_run,
                fixtures=fixtures,
                deploy_config=dcfg,
                root=root,
            )
            action.steps.append(rb_step)
            action.rolled_back = rb_step.exit_code == 0
        # p0 issue.
        action.p0_issue_number = _file_p0_issue(
            app=app,
            merged_pr_number=merged_pr_number,
            merged_sha=merged_sha,
            error=failure_reason,
            github_client=github_client,
            repo=cfg.repo,
            dry_run=dry_run,
        )
        # Mode flip — real-run only. Dry-run synthesizes the would-be mode.
        if not dry_run:
            action.mode_after = set_mode("fix-only", root, db_path=db, settings=settings)
        else:
            action.mode_after = "fix-only"

    action.completed_at = datetime.now(UTC).isoformat()
    _record_deploy(action, db)
    return action


# --------------------------------------------------------------------------- #
# Spec-aligned wrapper: deploy_tick
# --------------------------------------------------------------------------- #


def _latest_undeployed_sha(app: str, db: Path) -> tuple[str | None, int | None]:
    """Return the latest merged SHA for ``app`` not yet recorded as deployed.

    Older merged-but-undeployed SHAs are implicitly superseded — deploy
    the latest and move on. Returns ``(None, None)`` when there is
    nothing to deploy.
    """
    # Local import to avoid the deploy package importing chain at module
    # load (chain.auto_merge imports deploy.orchestrator).
    from factory.chain.auto_merge import MergeActionRecord

    eng = _engine(db)
    with Session(eng) as session:
        deployed_shas = {
            row.sha
            for row in session.exec(
                select(DeployActionRecord).where(
                    DeployActionRecord.app == app,
                    DeployActionRecord.status == "deployed",
                )
            ).all()
        }
        merged_rows = list(
            session.exec(
                select(MergeActionRecord)
                .where(
                    MergeActionRecord.app == app,
                    MergeActionRecord.merged == True,  # noqa: E712
                )
                .order_by(MergeActionRecord.id.desc())  # type: ignore[union-attr]
            ).all()
        )
    for row in merged_rows:
        if row.head_sha not in deployed_shas:
            return row.head_sha, int(row.pr_number)
    return None, None


def deploy_tick(
    software_factory_root: Path,
    app: str,
    *,
    dry_run: bool = True,
    sha: str | None = None,
    db_path: Path | None = None,
    fixture_step_outputs: list[tuple[int, str, str]] | None = None,
    fixture_step_outputs_by_phase: dict[str, list[tuple[int, str, str]]] | None = None,
    github_client: Any = None,
) -> list[DeployAction]:
    """Single deploy pass for ``app``.

    Selects the candidate SHA (explicit ``sha`` arg, or the latest
    merged-but-undeployed entry from ``merge_actions``) and invokes
    ``deploy_post_merge`` for it. Returns an empty list when there is
    nothing to deploy.

    This is the public spec-aligned entry point; ``deploy_post_merge``
    is the lower-level implementation that accepts an explicit PR
    number.
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    candidate_sha = sha
    pr_number: int | None = None
    if candidate_sha is None:
        candidate_sha, pr_number = _latest_undeployed_sha(app, db)
        if candidate_sha is None:
            return []
    action = deploy_post_merge(
        app,
        pr_number or 0,
        candidate_sha,
        root,
        dry_run=dry_run,
        fixture_step_outputs=fixture_step_outputs,
        fixture_step_outputs_by_phase=fixture_step_outputs_by_phase,
        github_client=github_client,
        db_path=db,
    )
    return [action]


def deploy_action_as_dict(action: DeployAction) -> dict[str, Any]:
    return {
        "app": action.app,
        "merged_pr_number": action.merged_pr_number,
        "merged_sha": action.merged_sha,
        "started_at": action.started_at,
        "completed_at": action.completed_at,
        "success": action.success,
        "smoke_passed": action.smoke_passed,
        "rolled_back": action.rolled_back,
        "error": action.error,
        "p0_issue_number": action.p0_issue_number,
        "mode_after": action.mode_after,
        "steps": [asdict(s) for s in action.steps],
    }
