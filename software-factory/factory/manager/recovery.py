"""factory.manager.recovery — operational self-healing layer for the FMS.

Problem this closes
--------------------
The L3 Diagnostician (``factory/manager/diagnostician.py`` — deleted
2026-08-07 along with the other three FMS LLM tiers; see STATUS.md and the
Exteroception v1 direction, P0) proposed fixes to factory CODE (prompts,
persona settings, dispatch code, detectors). But most of what actually goes
wrong in production is OPERATIONAL: a story got stuck in a blocked state
after a transient PR conflict resolved itself, a story's branch/PR never got
created and the row is now an orphan, an app's ``deploy.enabled`` flag got
flipped on before the deploy artifacts existed, or a single deploy failure
auto-flipped the whole factory into ``fix-only`` mode and nothing ever
flipped it back. No code diff fixes any of that — it needs an ACTION (reset a
DB row, flip a config flag, flip the mode back). Because L3's action-space
was code-diffs-only, every one of these landed as
``target_class: escalate_to_human`` (100% of 124 proposals in production, 0
fixes applied). This module adds a rule-based recovery executor that performs
the action directly, for a short, hand-audited list of playbooks, instead of
dumping the fix on a human every time.

This module OUTLIVED the diagnostician it was built to complement: L3's
code-diff proposals are gone, but the operational faults it recovers from are
unrelated to L3 and still happen. Design originally mirrored
``factory/manager/apply.py``'s classifier philosophy (also deleted
2026-08-07; see ``factory/manager/forbidden_paths.py`` for the one piece of
it that survives): this is the one part of the recovery path that is
DETERMINISTIC and LLM-free, because mutating live story/deploy state requires
hard guarantees an LLM cannot provide. Structure:

  * PRECONDITION detectors (``detect_*``) — pure functions. They read the
    stories DB and (read-only) ``gh``/``git`` state and return a list of
    ``RecoveryTarget``. No mutation, no logging, fully unit-testable with
    injected DB paths and injected ``gh``/``git`` callables.
  * EXECUTE functions (``execute_*``) — perform the actual mutation, gated by
    ``dry_run``. In dry-run, no DB write / git / gh / file edit happens at
    all; only the intended action is logged.
  * ``run_recovery_cycle`` — the orchestrator. Runs every precondition
    detector, applies cooldown + per-cycle-cap anti-thrash guards, executes
    matched targets (or escalates), and logs every decision to
    ``state/events/recovery.ndjson``.

Safety rails
------------
* Every mutation is REVERSIBLE: playbooks 1/2 only move a story between
  states already reachable by the normal chain (a re-block or a fresh
  dispatch just re-runs the existing pipeline); playbook 3 only sets a
  machine ``deploy_enabled=false`` OVERRIDE in the app's runtime-state file
  (``state/runtime/<app>.json``) that the operator can clear — the
  operator-authored ``config.yaml`` is never touched; playbook 5 only flips the factory mode
  back to ``normal``, which the operator or the deploy-failure/rollback path
  can re-set to ``fix-only`` at any time.
* Every action (including dry-run intents and escalations) is appended to
  ``state/events/recovery.ndjson`` via ``factory.manager.signals.write_event``
  — ts, playbook, target, action_taken, precondition_snapshot.
* Anti-thrash: ``_recently_recovered`` blocks re-applying the SAME playbook
  to the SAME target within ``cooldown`` (default 30 min) — a target that
  was just recovered and re-failed escalates instead of looping. A hard cap
  (default 5) on real mutations per cycle bounds blast radius.
* Strict preconditions: any uncertain signal (a ``gh``/``git`` call that
  fails, a config value that can't be parsed) causes the detector to SKIP
  that target rather than guess — it falls through to the existing
  escalate-to-human path untouched.
* Scope discipline: no playbook here ever touches a direction's content,
  title, scope, or body — only pipeline bookkeeping fields on
  ``StoryRecord`` (state/error/PR identifiers), the machine
  ``deploy_enabled`` override in an app's runtime-state file, or the global
  factory mode. Whatever
  a human (operator or end-user, e.g. via the auto-intake GitHub-issue flow)
  actually asked for is defined by the direction/story content, which this
  module never edits
  — recovery only un-wedges the PIPELINE moving that content through the
  chain, never reinterprets or overrides it.
* ``gh``/``git`` calls are wrapped so a transient CLI failure (network,
  auth, rate limit) can never crash the manager loop — it just makes that
  target's precondition "uncertain" and the target is skipped.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlmodel import Session, create_engine, select

from factory.app_config import AppConfig, load_app_config, resolve_app_repo_path
from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager.signals import write_event
from factory.runtime_state import effective_deploy_enabled, set_deploy_enabled_override
from factory.settings.loader import FactorySettings
from factory.settings.modes import get_mode, set_mode

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

RECOVERY_STREAM = "recovery"

# Anti-thrash rails (overridable per-call for tests).
DEFAULT_MAX_ACTIONS_PER_CYCLE = 5
DEFAULT_COOLDOWN = timedelta(minutes=30)

# Playbook 2: a phantom PR_OPEN row must be at least this old before we
# redispatch it — a story that JUST left STORY_CREATED may simply be
# mid-dispatch (branch/PR creation still in flight on this same tick).
DEFAULT_PHANTOM_PR_AGE_THRESHOLD = timedelta(minutes=30)

_SUBPROCESS_TIMEOUT_S = 30

CommandRunner = Callable[..., "subprocess.CompletedProcess[str]"]

# Playbook name constants.
PLAYBOOK_RETRY_MERGEABLE_BLOCKED = "retry-mergeable-blocked-story"
PLAYBOOK_REDISPATCH_PHANTOM_PR = "redispatch-phantom-pr-open"
PLAYBOOK_REVERT_PREMATURE_DEPLOY = "revert-premature-deploy-enable"
PLAYBOOK_CONFLICTING_GATED_PR = "conflicting-gated-pr"  # escalate-only, v1
PLAYBOOK_RECOVER_STUCK_FIXONLY = "recover-stuck-fixonly-mode"
PLAYBOOK_QUARANTINE_INVALID_ENUM = "quarantine-invalid-enum-story"

# Story states already known (auto_merge.py's _MERGEABLE_STATES) to mean
# "already reached the merge gate" — reused here to spot a PR that passed
# gates and then hit a real conflict (playbook 4, escalate-only).
_GATE_PASSED_STATES = frozenset(
    {
        StoryState.PR_OPEN.value,
        StoryState.CI_GREEN.value,
        StoryState.READY_FOR_MERGE.value,
    }
)


# --------------------------------------------------------------------------- #
# Data shapes
# --------------------------------------------------------------------------- #


@dataclass
class RecoveryTarget:
    """One precondition match. Pure data — produced by detectors, consumed by
    executors and by the cooldown/cap guards. No side effects attached."""

    playbook: str
    # Stable identity for cooldown/idempotency tracking, e.g. "story:42" or
    # "app:sacrifice". Two targets with the same (playbook, key) are the
    # "same target" for anti-thrash purposes.
    key: str
    description: str
    story_id: int | None = None
    app: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class RecoveryOutcome:
    """Result of attempting (or skipping) an action for one target."""

    playbook: str
    target: RecoveryTarget
    # "recovered" | "dry_run" | "skipped_cooldown" | "skipped_cap" |
    # "skipped_stale" | "escalated" | "error"
    status: str
    action_taken: str
    error: str | None = None


# --------------------------------------------------------------------------- #
# DB helpers
# --------------------------------------------------------------------------- #


def _db_path(root: Path, db_path: Path | None) -> Path:
    return Path(db_path) if db_path is not None else (Path(root) / "state" / "factory.db")


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(f"sqlite:///{db_path}", echo=False)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


# --------------------------------------------------------------------------- #
# gh / git wrappers — read-only, never raise
# --------------------------------------------------------------------------- #


def _run_cmd(
    cmd: list[str], *, runner: CommandRunner | None = None, timeout: int = _SUBPROCESS_TIMEOUT_S
) -> subprocess.CompletedProcess[str] | None:
    """Run a command, swallowing every failure mode (missing binary, timeout,
    network error) into ``None`` so a transient CLI hiccup can never crash
    the manager loop. Callers treat ``None`` as "uncertain" and skip."""
    runner = runner or subprocess.run
    try:
        return runner(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception:  # noqa: BLE001
        return None


def _gh_pr_view(
    *, repo: str, pr_number: int, runner: CommandRunner | None = None
) -> dict[str, Any] | None:
    """Read-only ``gh pr view --json state,mergeable,mergeStateStatus``.

    Returns ``None`` (uncertain) on any failure — missing ``gh``, auth
    error, rate limit, non-zero exit, unparseable output. Mirrors
    ``factory.chain.auto_merge._pr_terminally_unmergeable``'s shell-out.
    """
    proc = _run_cmd(
        [
            "gh", "pr", "view", str(pr_number), "--repo", repo,
            "--json", "state,mergeable,mergeStateStatus",
        ],
        runner=runner,
    )
    if proc is None or proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _gh_branch_exists(
    *, repo: str, branch: str, runner: CommandRunner | None = None
) -> bool | None:
    """Read-only check for whether ``branch`` exists on ``repo``'s origin.

    Returns ``True``/``False`` when we can say so with confidence, or
    ``None`` (uncertain — auth/network error, unexpected response) when we
    cannot; callers must treat ``None`` as "do nothing".
    """
    if not branch:
        return None
    proc = _run_cmd(["gh", "api", f"repos/{repo}/branches/{branch}", "--silent"], runner=runner)
    if proc is None:
        return None
    if proc.returncode == 0:
        return True
    combined = f"{proc.stdout or ''}{proc.stderr or ''}"
    if "404" in combined or "Branch not found" in combined or "Not Found" in combined:
        return False
    return None  # some other failure (auth, rate limit) — uncertain


# --------------------------------------------------------------------------- #
# Playbook 1 — retry-mergeable-blocked-story
# --------------------------------------------------------------------------- #


def detect_retry_mergeable_blocked_stories(
    root: Path,
    *,
    db_path: Path | None = None,
    apps: list[str] | None = None,
    gh_pr_view: Callable[..., dict[str, Any] | None] | None = None,
    runner: CommandRunner | None = None,
) -> list[RecoveryTarget]:
    """PRECONDITION: story.state == blocked_deploy_failed AND its PR is OPEN
    and MERGEABLE on GitHub.

    This is the state_machine's ``(PR_OPEN, EVENT_PR_UNMERGEABLE) ->
    BLOCKED_DEPLOY_FAILED`` transition having since resolved itself (the base
    moved, the conflict was fixed out-of-band, or the merge failure was
    transient) — the PR is provably mergeable NOW, so the block is stale.
    Read-only: queries the DB and calls ``gh pr view`` (no mutation).
    """
    gh_pr_view = gh_pr_view or _gh_pr_view
    eng = _engine(_db_path(root, db_path))
    with Session(eng) as session:
        stmt = select(StoryRecord).where(
            StoryRecord.state == StoryState.BLOCKED_DEPLOY_FAILED.value
        )
        if apps:
            stmt = stmt.where(StoryRecord.app.in_(apps))  # type: ignore[attr-defined]
        rows = session.exec(stmt).all()

    targets: list[RecoveryTarget] = []
    for story in rows:
        if not story.github_pr_number or story.github_pr_number <= 0:
            continue  # no real PR to check — uncertain, skip
        try:
            cfg = load_app_config(story.app, root)
        except Exception:  # noqa: BLE001
            continue  # can't resolve the repo — uncertain, skip
        info = gh_pr_view(repo=cfg.repo, pr_number=story.github_pr_number, runner=runner)
        if info is None:
            continue  # gh call failed/uncertain — strict precondition, skip
        state = str(info.get("state", "")).upper()
        mergeable = str(info.get("mergeable", "")).upper()
        if state != "OPEN" or mergeable != "MERGEABLE":
            continue
        targets.append(
            RecoveryTarget(
                playbook=PLAYBOOK_RETRY_MERGEABLE_BLOCKED,
                key=f"story:{story.id}",
                description=(
                    f"story {story.id} ({story.app}/{story.slug}) is "
                    f"blocked_deploy_failed but PR #{story.github_pr_number} "
                    "is OPEN and MERGEABLE on GitHub"
                ),
                story_id=story.id,
                app=story.app,
                extra={
                    "pr_number": story.github_pr_number,
                    "gh_state": state,
                    "gh_mergeable": mergeable,
                    "prior_error": story.error,
                },
            )
        )
    return targets


def execute_retry_mergeable_blocked_story(
    root: Path,
    target: RecoveryTarget,
    *,
    dry_run: bool,
    db_path: Path | None = None,
) -> RecoveryOutcome:
    """ACTION: reset story.state to pr_open, clear error.

    Reversible: the story simply re-enters the merge path it already left;
    if it fails again it re-blocks exactly the same way it did before.
    """
    action_desc = (
        f"reset story {target.story_id} state -> {StoryState.PR_OPEN.value!r}, "
        "clear error"
    )
    if dry_run:
        return RecoveryOutcome(target.playbook, target, "dry_run", action_desc)

    eng = _engine(_db_path(root, db_path))
    try:
        with Session(eng) as session:
            story = session.get(StoryRecord, target.story_id)
            # Re-check the precondition at execute time — the detector's
            # snapshot could be stale if anything mutated the row between
            # detection and execution within this cycle.
            if story is None or story.state != StoryState.BLOCKED_DEPLOY_FAILED.value:
                return RecoveryOutcome(
                    target.playbook,
                    target,
                    "skipped_stale",
                    "story no longer in blocked_deploy_failed at execute time",
                )
            story.state = StoryState.PR_OPEN.value
            story.error = None
            story.updated_at = datetime.now(UTC).isoformat()
            session.add(story)
            session.commit()
    except Exception as exc:  # noqa: BLE001
        return RecoveryOutcome(target.playbook, target, "error", action_desc, error=repr(exc))
    return RecoveryOutcome(target.playbook, target, "recovered", action_desc)


# --------------------------------------------------------------------------- #
# Playbook 2 — redispatch-phantom-pr-open
# --------------------------------------------------------------------------- #


def detect_phantom_pr_open_stories(
    root: Path,
    *,
    now: datetime | None = None,
    age_threshold: timedelta = DEFAULT_PHANTOM_PR_AGE_THRESHOLD,
    db_path: Path | None = None,
    apps: list[str] | None = None,
    gh_branch_exists: Callable[..., bool | None] | None = None,
    runner: CommandRunner | None = None,
) -> list[RecoveryTarget]:
    """PRECONDITION: story.state == pr_open AND github_pr_number IS NULL AND
    no matching branch exists on origin AND updated_at older than
    ``age_threshold``.

    This is a story whose dispatcher crashed/died between "advance state to
    PR_OPEN" and "actually create the branch/PR" — there is nothing to lose
    by starting over. Read-only: queries the DB and calls a branch-existence
    check (no mutation).
    """
    now = now or datetime.now(UTC)
    gh_branch_exists = gh_branch_exists or _gh_branch_exists
    eng = _engine(_db_path(root, db_path))
    with Session(eng) as session:
        stmt = select(StoryRecord).where(
            StoryRecord.state == StoryState.PR_OPEN.value,
            StoryRecord.github_pr_number.is_(None),  # type: ignore[union-attr]
        )
        if apps:
            stmt = stmt.where(StoryRecord.app.in_(apps))  # type: ignore[attr-defined]
        rows = session.exec(stmt).all()

    targets: list[RecoveryTarget] = []
    for story in rows:
        if not story.github_branch:
            continue  # nothing to check a remote branch against — skip
        updated = _parse_ts(story.updated_at)
        if updated is None:
            continue  # can't establish age — uncertain, skip
        if now - updated < age_threshold:
            continue  # too fresh — may still be mid-dispatch, skip
        try:
            cfg = load_app_config(story.app, root)
        except Exception:  # noqa: BLE001
            continue
        exists = gh_branch_exists(repo=cfg.repo, branch=story.github_branch, runner=runner)
        if exists is not False:
            continue  # True (branch is real) or None (uncertain) — skip
        targets.append(
            RecoveryTarget(
                playbook=PLAYBOOK_REDISPATCH_PHANTOM_PR,
                key=f"story:{story.id}",
                description=(
                    f"story {story.id} ({story.app}/{story.slug}) is pr_open "
                    "with no PR number and no matching branch on origin "
                    f"(last updated {story.updated_at})"
                ),
                story_id=story.id,
                app=story.app,
                extra={
                    "github_branch": story.github_branch,
                    "updated_at": story.updated_at,
                    "prior_error": story.error,
                },
            )
        )
    return targets


def execute_redispatch_phantom_pr(
    root: Path,
    target: RecoveryTarget,
    *,
    dry_run: bool,
    db_path: Path | None = None,
) -> RecoveryOutcome:
    """ACTION: reset story.state to story_created, clear PR/branch fields
    and error, so the chain redispatches from scratch.

    Reversible/safe: no PR or branch exists to lose — there is nothing this
    could orphan or overwrite.
    """
    action_desc = (
        f"reset story {target.story_id} state -> {StoryState.STORY_CREATED.value!r}; "
        "clear github_pr_number/github_branch/error"
    )
    if dry_run:
        return RecoveryOutcome(target.playbook, target, "dry_run", action_desc)

    eng = _engine(_db_path(root, db_path))
    try:
        with Session(eng) as session:
            story = session.get(StoryRecord, target.story_id)
            if (
                story is None
                or story.state != StoryState.PR_OPEN.value
                or story.github_pr_number is not None
            ):
                return RecoveryOutcome(
                    target.playbook,
                    target,
                    "skipped_stale",
                    "story no longer matches the phantom-PR precondition at execute time",
                )
            story.state = StoryState.STORY_CREATED.value
            story.github_pr_number = None
            story.github_branch = None
            story.error = None
            story.updated_at = datetime.now(UTC).isoformat()
            session.add(story)
            session.commit()
    except Exception as exc:  # noqa: BLE001
        return RecoveryOutcome(target.playbook, target, "error", action_desc, error=repr(exc))
    return RecoveryOutcome(target.playbook, target, "recovered", action_desc)


# --------------------------------------------------------------------------- #
# Playbook 3 — revert-premature-deploy-enable
# --------------------------------------------------------------------------- #


def _config_paths(root: Path, apps: list[str] | None) -> list[Path]:
    apps_dir = Path(root) / "apps"
    if apps is not None:
        return [apps_dir / a / "config.yaml" for a in apps]
    if not apps_dir.exists():
        return []
    return sorted(apps_dir.glob("*/config.yaml"))


_PRE_DEPLOY_FILE_FLAG_RE = re.compile(r"(?:^|\s)(?:-f|--file)\s+(\S+)")

# Only commands that are actually invoking docker compose get their ``-f``
# argument treated as a compose-file artifact path. ``-f``/``--file`` is a
# common flag on many other CLIs (``curl -f``, ``grep -f patterns``) whose
# argument is NOT a deploy artifact at all -- blindly extracting it would
# make the detector GUESS an artifact path and could flip a healthy app's
# deploy.enabled off. Whitespace-normalized so "docker  compose" or leading
# indentation doesn't dodge the check.
_DOCKER_COMPOSE_PREFIX_RE = re.compile(r"^(?:docker compose|docker-compose)\b")


def _extract_pre_deploy_artifact(cfg: AppConfig) -> str | None:
    """Best-effort extraction of the file path a pre_deploy_command's
    ``-f``/``--file`` flag references (e.g. ``docker compose -f
    docker-compose.prod.yml build``). Returns ``None`` when no
    pre_deploy_command is a recognized ``docker compose``/``docker-compose``
    invocation with a ``-f``/``--file`` flag -- the precondition is then
    "uncertain" and the caller skips rather than guessing (e.g. a
    ``curl -f https://...`` or ``grep -f patterns`` pre-deploy command is
    NOT a compose-file reference and must not be treated as one)."""
    for cmd in cfg.deploy.pre_deploy_commands:
        normalized = " ".join(cmd.split())
        if not _DOCKER_COMPOSE_PREFIX_RE.match(normalized):
            continue
        m = _PRE_DEPLOY_FILE_FLAG_RE.search(cmd)
        if m:
            return m.group(1)
    return None


def detect_premature_deploy_enabled(
    root: Path,
    *,
    apps: list[str] | None = None,
) -> list[RecoveryTarget]:
    """PRECONDITION: app config has deploy.enabled == true AND the deploy
    artifact its own pre_deploy_commands reference does not exist in the
    app's repo tree.

    This is the case where ``deploy.enabled`` was flipped on before the
    Dockerfiles/compose file actually landed — every merge then fails
    ``docker compose build`` in ``handle_deploy``. Read-only: only reads
    config.yaml and stats a path (no mutation).
    """
    targets: list[RecoveryTarget] = []
    for cfg_path in _config_paths(root, apps):
        app = cfg_path.parent.name
        try:
            cfg = load_app_config(app, root)
        except Exception:  # noqa: BLE001
            continue
        # Use the EFFECTIVE value (config default merged with any machine
        # runtime override) so an app already disabled via a prior override
        # is skipped — no re-thrash re-writing an override that's already set.
        if not effective_deploy_enabled(cfg, root):
            continue
        artifact = _extract_pre_deploy_artifact(cfg)
        if not artifact:
            continue  # can't determine the required artifact — uncertain, skip
        try:
            repo_path = resolve_app_repo_path(cfg, root)
        except Exception:  # noqa: BLE001
            continue
        artifact_path = repo_path / artifact
        if artifact_path.exists():
            continue  # artifact is present — deploy.enabled is legitimate
        targets.append(
            RecoveryTarget(
                playbook=PLAYBOOK_REVERT_PREMATURE_DEPLOY,
                key=f"app:{app}",
                description=(
                    f"app {app!r} has deploy.enabled=true but required deploy "
                    f"artifact {artifact!r} is missing at {artifact_path}"
                ),
                app=app,
                extra={
                    "config_path": str(cfg_path),
                    "missing_artifact": str(artifact_path),
                },
            )
        )
    return targets


def execute_revert_premature_deploy_enable(
    root: Path,
    target: RecoveryTarget,
    *,
    dry_run: bool,
) -> RecoveryOutcome:
    """ACTION: set a machine ``deploy_enabled=false`` OVERRIDE in the app's
    runtime-state file (``state/runtime/<app>.json``) — the operator-authored
    ``config.yaml`` is NEVER touched.

    This is the config/runtime split: ``config.yaml`` holds the operator
    DEFAULT, the runtime-state file holds this machine OVERRIDE, and the
    effective value is override-if-present else the default. So a machine flip
    and an operator edit no longer collide over the same bytes, and a settings
    deploy of ``config.yaml`` can't silently revert this flip.

    Reversible: the operator (or a re-enable recovery path) clears the
    override via ``factory.runtime_state.clear_deploy_enabled_override`` once
    the deploy artifacts land; nothing about the app's source tree or its
    config.yaml is touched.
    """
    app = target.app
    action_desc = f"set runtime override deploy_enabled=false for app {app!r} (config.yaml untouched)"
    if dry_run:
        return RecoveryOutcome(target.playbook, target, "dry_run", action_desc)
    if not app:
        return RecoveryOutcome(
            target.playbook, target, "error", action_desc, error="target.app missing"
        )

    try:
        # Re-check the precondition at execute time — the effective value
        # could have changed (an operator edit, or a prior override) between
        # detection and execution.
        cfg = load_app_config(app, root)
        if not effective_deploy_enabled(cfg, root):
            return RecoveryOutcome(
                target.playbook,
                target,
                "skipped_stale",
                "deploy already disabled (config default or runtime override) at execute time",
            )
        set_deploy_enabled_override(root, app, False)
    except Exception as exc:  # noqa: BLE001
        return RecoveryOutcome(target.playbook, target, "error", action_desc, error=repr(exc))
    return RecoveryOutcome(target.playbook, target, "recovered", action_desc)


# --------------------------------------------------------------------------- #
# Playbook 4 — conflicting-gated-pr (escalate-only, v1)
# --------------------------------------------------------------------------- #


def detect_conflicting_gated_prs(
    root: Path,
    *,
    db_path: Path | None = None,
    apps: list[str] | None = None,
    gh_pr_view: Callable[..., dict[str, Any] | None] | None = None,
    runner: CommandRunner | None = None,
) -> list[RecoveryTarget]:
    """PRECONDITION: a story already reached a gate-passed state (PR_OPEN /
    CI_GREEN / READY_FOR_MERGE — the same set auto_merge.py treats as
    mergeable) AND its PR's ``mergeable`` is CONFLICTING.

    Deliberately NOT auto-fixed: resolving a real content conflict needs
    human judgment (which side's change wins), so this playbook only
    produces a concrete, actionable escalation — never a rebase attempt.
    """
    gh_pr_view = gh_pr_view or _gh_pr_view
    eng = _engine(_db_path(root, db_path))
    with Session(eng) as session:
        stmt = select(StoryRecord).where(
            StoryRecord.state.in_(list(_GATE_PASSED_STATES))  # type: ignore[attr-defined]
        )
        if apps:
            stmt = stmt.where(StoryRecord.app.in_(apps))  # type: ignore[attr-defined]
        rows = session.exec(stmt).all()

    targets: list[RecoveryTarget] = []
    for story in rows:
        if not story.github_pr_number or story.github_pr_number <= 0:
            continue
        try:
            cfg = load_app_config(story.app, root)
        except Exception:  # noqa: BLE001
            continue
        info = gh_pr_view(repo=cfg.repo, pr_number=story.github_pr_number, runner=runner)
        if info is None:
            continue
        mergeable = str(info.get("mergeable", "")).upper()
        if mergeable != "CONFLICTING":
            continue
        base = cfg.default_branch or "main"
        recommendation = (
            f"PR #{story.github_pr_number} ({cfg.repo}) passed its gates in "
            f"state={story.state!r} but GitHub reports mergeable=CONFLICTING "
            f"against {base!r}. Recommended: `gh pr checkout "
            f"{story.github_pr_number} --repo {cfg.repo}`, `git merge "
            f"origin/{base}`, resolve the reported conflicts by hand, then "
            "push. Auto-rebase is intentionally NOT attempted — conflict "
            "resolution requires judgment about which side's change wins."
        )
        targets.append(
            RecoveryTarget(
                playbook=PLAYBOOK_CONFLICTING_GATED_PR,
                key=f"story:{story.id}",
                description=(
                    f"story {story.id} ({story.app}/{story.slug}) PR "
                    f"#{story.github_pr_number} passed gates but is CONFLICTING"
                ),
                story_id=story.id,
                app=story.app,
                extra={
                    "pr_number": story.github_pr_number,
                    "recommendation": recommendation,
                },
            )
        )
    return targets


# --------------------------------------------------------------------------- #
# Playbook 5 — recover-stuck-fixonly-mode
# --------------------------------------------------------------------------- #


def detect_stuck_fixonly_mode(
    root: Path,
    *,
    db_path: Path | None = None,
    apps: list[str] | None = None,
) -> list[RecoveryTarget]:
    """PRECONDITION: factory mode == "fix-only" AND, for every in-scope app,
    ``deploy.enabled`` is False.

    ``fix-only`` is set by ``factory/deploy/orchestrator.py`` and
    ``factory/chain/rollback.py`` on a deploy/rollback failure, to stop
    feature/infra work from reaching production while a regression is being
    fixed (``can_dispatch`` rejects non-bug-fix job kinds in this mode). But
    NOTHING flips it back — a single deploy failure wedges the factory in
    ``fix-only`` indefinitely, even after the cause is addressed or was
    itself spurious.

    The safe recovery condition: if NO in-scope app can actually reach
    production (``deploy.enabled`` is False everywhere), ``fix-only`` cannot
    be protecting a live deploy from a regression — merged feature work
    can't reach prod either way, so blocking it serves no purpose. This
    holds regardless of who/what set fix-only or why, which is what makes
    the precondition robust without needing to reconstruct history.

    Conversely, if ANY in-scope app has ``deploy.enabled`` true, a real
    deploy is live and could be regressing — that is exactly the case
    ``fix-only`` exists for, so this playbook must NOT match and the mode
    stays put. An app whose ``deploy.enabled`` can't be determined (config
    missing/unparseable) is treated the same as "enabled": strict
    precondition, skip rather than guess it's safe.

    Read-only: reads the mode from the DB and ``deploy.enabled`` from each
    app's ``config.yaml`` (no mutation).
    """
    mode = get_mode(root, db_path=db_path)
    if mode != "fix-only":
        return []

    deploy_enabled_by_app: dict[str, bool] = {}
    for cfg_path in _config_paths(root, apps):
        app = cfg_path.parent.name
        try:
            cfg = load_app_config(app, root)
            effective = effective_deploy_enabled(cfg, root)
        except Exception:  # noqa: BLE001
            # Can't determine this app's deploy.enabled — uncertain. A real
            # deploy could be live for it; do not guess it's safe.
            return []
        if effective:
            # A real deploy is live for this app — fix-only may legitimately
            # be protecting it. Do not auto-recover.
            return []
        deploy_enabled_by_app[app] = effective

    return [
        RecoveryTarget(
            playbook=PLAYBOOK_RECOVER_STUCK_FIXONLY,
            key="mode:factory",
            description=(
                "factory mode is fix-only but deploy.enabled is False for "
                f"every in-scope app ({sorted(deploy_enabled_by_app)!r}) — "
                "fix-only cannot be protecting a live deploy, safe to "
                "return to normal"
            ),
            extra={
                "mode_before": mode,
                "deploy_enabled_by_app": deploy_enabled_by_app,
            },
        )
    ]


def execute_recover_stuck_fixonly_mode(
    root: Path,
    target: RecoveryTarget,
    *,
    dry_run: bool,
    db_path: Path | None = None,
    settings: FactorySettings | None = None,
) -> RecoveryOutcome:
    """ACTION: set factory mode fix-only -> normal.

    Reversible: the operator, or the deploy-failure/rollback path itself,
    can set fix-only again at any time (subject to this playbook's own
    cooldown before it would re-recover) — this only un-wedges a mode that
    would otherwise never flip back on its own.
    """
    action_desc = "set factory mode fix-only -> normal"
    if dry_run:
        return RecoveryOutcome(target.playbook, target, "dry_run", action_desc)

    # Re-check the precondition at execute time — the detector's snapshot
    # could be stale if anything mutated mode/config between detection and
    # execution within this cycle.
    current_mode = get_mode(root, db_path=db_path)
    if current_mode != "fix-only":
        return RecoveryOutcome(
            target.playbook,
            target,
            "skipped_stale",
            "factory mode no longer fix-only at execute time",
        )
    for app in target.extra.get("deploy_enabled_by_app", {}):
        try:
            cfg = load_app_config(app, root)
            app_effective = effective_deploy_enabled(cfg, root)
        except Exception:  # noqa: BLE001
            return RecoveryOutcome(
                target.playbook,
                target,
                "skipped_stale",
                f"could not re-verify deploy.enabled for app {app!r} at execute time",
            )
        if app_effective:
            return RecoveryOutcome(
                target.playbook,
                target,
                "skipped_stale",
                f"app {app!r} now has deploy.enabled=true at execute time",
            )

    try:
        new_mode = set_mode("normal", root, db_path=db_path, settings=settings)
    except Exception as exc:  # noqa: BLE001
        return RecoveryOutcome(target.playbook, target, "error", action_desc, error=repr(exc))
    return RecoveryOutcome(target.playbook, target, "recovered", f"mode fix-only -> {new_mode}")


# --------------------------------------------------------------------------- #
# Playbook 6 — quarantine-invalid-enum-story
# --------------------------------------------------------------------------- #


def _is_valid_story_state(value: str | None) -> bool:
    """True iff ``value`` is a recognised :class:`StoryState` enum value."""
    if value is None:
        return False
    try:
        StoryState(value)
    except ValueError:
        return False
    return True


def detect_invalid_enum_stories(
    root: Path,
    *,
    db_path: Path | None = None,
    apps: list[str] | None = None,
) -> list[RecoveryTarget]:
    """PRECONDITION: story.state is a string OUTSIDE the ``StoryState`` enum.

    This is a "poisoned" row — a bad manual/manager write (e.g. the
    ``abandoned`` row that halted the factory for days on 2026-07-07). The
    orchestrator's poisoned-row guard skips it NON-FATALLY every tick, but that
    skip is otherwise silent and permanent: the invalid row is re-evaluated and
    re-skipped forever until a human hand-repairs it. This detector surfaces such
    rows so the reconciler can park them in a terminal quarantine sink.

    Read-only: queries the DB and classifies each row's state string in Python
    (the invalid value cannot be expressed as a SQL enum filter). Every other
    recovery playbook targets a SPECIFIC valid state; this is the one that
    handles the INVALID-enum case the others structurally cannot.
    """
    eng = _engine(_db_path(root, db_path))
    with Session(eng) as session:
        stmt = select(StoryRecord)
        if apps:
            stmt = stmt.where(StoryRecord.app.in_(apps))  # type: ignore[attr-defined]
        rows = session.exec(stmt).all()

    targets: list[RecoveryTarget] = []
    for story in rows:
        if _is_valid_story_state(story.state):
            continue  # healthy enum value — not our concern
        targets.append(
            RecoveryTarget(
                playbook=PLAYBOOK_QUARANTINE_INVALID_ENUM,
                key=f"story:{story.id}",
                description=(
                    f"story {story.id} ({story.app}/{story.slug}) has invalid "
                    f"state {story.state!r} (outside the StoryState enum) — "
                    "quarantining to a terminal sink so it stops being re-skipped"
                ),
                story_id=story.id,
                app=story.app,
                extra={
                    "invalid_state": story.state,
                    "slug": story.slug,
                    "prior_error": story.error,
                },
            )
        )
    return targets


def execute_quarantine_invalid_enum_story(
    root: Path,
    target: RecoveryTarget,
    *,
    dry_run: bool,
    db_path: Path | None = None,
) -> RecoveryOutcome:
    """ACTION: move an invalid-enum row to the terminal
    ``StoryState.QUARANTINED_INVALID_STATE`` sink, preserving the original
    invalid string in ``error`` for forensics.

    Reversible: an operator who identifies the root cause can move the row back
    to a live dispatch state and clear ``error``. Idempotent: a row already in
    the quarantine sink is a valid enum value, so the detector never re-matches
    it. Fail-safe: the precondition is re-checked at execute time; if the row
    became a valid state out-of-band between detection and execution, we skip.
    """
    invalid_state = target.extra.get("invalid_state")
    action_desc = (
        f"quarantine story {target.story_id}: state {invalid_state!r} -> "
        f"{StoryState.QUARANTINED_INVALID_STATE.value!r} "
        "(original invalid state preserved in error)"
    )
    if dry_run:
        return RecoveryOutcome(target.playbook, target, "dry_run", action_desc)

    eng = _engine(_db_path(root, db_path))
    try:
        with Session(eng) as session:
            story = session.get(StoryRecord, target.story_id)
            # Re-check the precondition at execute time — if the row became a
            # valid state (operator repair, or already quarantined) between
            # detection and execution, there is nothing to do.
            if story is None or _is_valid_story_state(story.state):
                return RecoveryOutcome(
                    target.playbook,
                    target,
                    "skipped_stale",
                    "story state is no longer an invalid enum at execute time",
                )
            original = story.state
            story.state = StoryState.QUARANTINED_INVALID_STATE.value
            # Preserve the poisoned value so the forensic trail survives the
            # quarantine — never clobber an existing error, append to it.
            note = f"quarantined invalid state {original!r}"
            story.error = f"{story.error}; {note}" if story.error else note
            story.updated_at = datetime.now(UTC).isoformat()
            session.add(story)
            session.commit()
    except Exception as exc:  # noqa: BLE001
        return RecoveryOutcome(target.playbook, target, "error", action_desc, error=repr(exc))
    return RecoveryOutcome(target.playbook, target, "recovered", action_desc)


# --------------------------------------------------------------------------- #
# Recovery log (state/events/recovery.ndjson)
# --------------------------------------------------------------------------- #


def _read_recovery_log(root: Path) -> list[dict[str, Any]]:
    path = Path(root) / "state" / "events" / f"{RECOVERY_STREAM}.ndjson"
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(rec, dict):
                    out.append(rec)
    except OSError:
        return []
    return out


def _recently_recovered(
    root: Path, playbook: str, key: str, *, now: datetime, cooldown: timedelta
) -> bool:
    """True if a REAL (non-dry-run) ``recovered`` action for this exact
    (playbook, target key) was logged within ``cooldown`` of ``now``. This is
    the anti-thrash guard: a target that was just recovered and re-failed
    must escalate, not loop."""
    cutoff = now - cooldown
    for rec in _read_recovery_log(root):
        if rec.get("playbook") != playbook or rec.get("target_key") != key:
            continue
        if rec.get("status") != "recovered":
            continue
        ts = _parse_ts(rec.get("ts"))
        if ts is not None and ts >= cutoff:
            return True
    return False


def _recently_escalated(
    root: Path, playbook: str, key: str, *, now: datetime, cooldown: timedelta
) -> bool:
    """True if this exact (playbook, target key) was already logged as
    ``escalated`` within ``cooldown`` of ``now``.

    Mirrors ``_recently_recovered`` but for escalate-only playbooks (e.g.
    conflicting-gated-pr) that never reach ``"recovered"`` status and so are
    invisible to that check. Without this, an unresolved conflict
    re-escalates identically every recovery cycle (observed: 9 escalations
    in 9 minutes for one story), drowning real signal."""
    cutoff = now - cooldown
    for rec in _read_recovery_log(root):
        if rec.get("playbook") != playbook or rec.get("target_key") != key:
            continue
        if rec.get("status") != "escalated":
            continue
        ts = _parse_ts(rec.get("ts"))
        if ts is not None and ts >= cutoff:
            return True
    return False


def _log_recovery(
    root: Path, outcome: RecoveryOutcome, *, precondition_snapshot: dict[str, Any]
) -> None:
    """Append one record to state/events/recovery.ndjson. Best-effort — a
    logging failure must never bubble out of the recovery cycle (mirrors
    every other FMS event writer)."""
    try:
        write_event(
            RECOVERY_STREAM,
            {
                "event": "recovery_action",
                "playbook": outcome.playbook,
                "target_key": outcome.target.key,
                "target_description": outcome.target.description,
                "story_id": outcome.target.story_id,
                "app": outcome.target.app,
                "status": outcome.status,
                "action_taken": outcome.action_taken,
                "error": outcome.error,
                "precondition_snapshot": precondition_snapshot,
            },
            software_factory_root=root,
        )
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------- #
# Orchestration: cooldown + cap guard shared by every executable playbook
# --------------------------------------------------------------------------- #


def _apply_playbook(
    root: Path,
    targets: list[RecoveryTarget],
    execute_fn: Callable[..., RecoveryOutcome],
    *,
    dry_run: bool,
    now: datetime,
    cooldown: timedelta,
    max_actions: int,
    actions_taken: int,
    summary: dict[str, Any],
    execute_kwargs: dict[str, Any] | None = None,
) -> int:
    """Apply the cooldown + per-cycle-cap guards to ``targets``, execute the
    ones that pass, log every decision, and return the updated
    ``actions_taken`` counter. Shared by every executable (non-escalate-only)
    playbook so the anti-thrash logic lives in exactly one place."""
    execute_kwargs = execute_kwargs or {}
    for target in targets:
        if _recently_recovered(root, target.playbook, target.key, now=now, cooldown=cooldown):
            outcome = RecoveryOutcome(
                target.playbook,
                target,
                "skipped_cooldown",
                "cooldown active — a target recovered recently and matched "
                "again escalates instead of re-looping the same fix",
            )
            _log_recovery(root, outcome, precondition_snapshot=target.extra)
            summary["skipped_cooldown"].append({"playbook": target.playbook, "key": target.key})
            summary["escalated"].append(
                {"playbook": target.playbook, "key": target.key, "reason": "cooldown"}
            )
            continue

        if not dry_run and actions_taken >= max_actions:
            outcome = RecoveryOutcome(
                target.playbook, target, "skipped_cap", "per-cycle recovery action cap reached"
            )
            _log_recovery(root, outcome, precondition_snapshot=target.extra)
            summary["skipped_cap"].append({"playbook": target.playbook, "key": target.key})
            summary["escalated"].append(
                {"playbook": target.playbook, "key": target.key, "reason": "cap"}
            )
            continue

        outcome = execute_fn(root, target, dry_run=dry_run, **execute_kwargs)
        _log_recovery(root, outcome, precondition_snapshot=target.extra)

        if outcome.status == "recovered":
            actions_taken += 1
            summary["recovered"].append(
                {"playbook": target.playbook, "key": target.key, "action": outcome.action_taken}
            )
        elif outcome.status == "dry_run":
            summary["recovered"].append(
                {
                    "playbook": target.playbook,
                    "key": target.key,
                    "action": outcome.action_taken,
                    "dry_run": True,
                }
            )
        elif outcome.status == "error":
            summary["errors"].append(
                {"playbook": target.playbook, "key": target.key, "error": outcome.error}
            )
        # "skipped_stale" falls through silently: the re-check at execute
        # time found the precondition no longer holds (already resolved or
        # changed out from under us) — nothing to report, nothing to escalate.
    return actions_taken


# --------------------------------------------------------------------------- #
# Escalate-only playbook seam (no mutation, never counts against the cap)
# --------------------------------------------------------------------------- #


def _apply_escalate_only_playbook(
    root: Path,
    targets: list[RecoveryTarget],
    *,
    now: datetime,
    cooldown: timedelta,
    summary: dict[str, Any],
) -> None:
    """Escalate each target once per cooldown window (never mutates, never
    counts against the per-cycle action cap). Deduped via the SAME cooldown
    mechanism the mutating playbooks use, so an unresolved condition is
    escalated once per window rather than every cycle. Extracted verbatim from
    the former inline Playbook-4 block so behavior is identical."""
    for target in targets:
        if _recently_escalated(root, target.playbook, target.key, now=now, cooldown=cooldown):
            outcome = RecoveryOutcome(
                target.playbook,
                target,
                "skipped_cooldown",
                "cooldown active — this conflict was already escalated recently; "
                "suppressing the duplicate escalation",
            )
            _log_recovery(root, outcome, precondition_snapshot=target.extra)
            summary["skipped_cooldown"].append({"playbook": target.playbook, "key": target.key})
            continue

        recommendation = target.extra.get("recommendation", "manual rebase required")
        outcome = RecoveryOutcome(target.playbook, target, "escalated", recommendation)
        _log_recovery(root, outcome, precondition_snapshot=target.extra)
        summary["escalated"].append(
            {
                "playbook": target.playbook,
                "key": target.key,
                "reason": "conflict_needs_human_judgment",
                "recommendation": recommendation,
            }
        )


# --------------------------------------------------------------------------- #
# Playbook registry — declarative descriptors so adding a playbook is additive
# --------------------------------------------------------------------------- #


@dataclass
class _RecoveryContext:
    """Everything the detectors/executors need for one recovery cycle. Bundled
    so a playbook descriptor's ``detect`` closure can be a zero-arg call."""

    root: Path
    now: datetime
    cooldown: timedelta
    max_actions: int
    phantom_pr_age_threshold: timedelta
    db_path: Path | None
    apps: list[str] | None
    gh_pr_view: Callable[..., dict[str, Any] | None] | None
    gh_branch_exists: Callable[..., bool | None] | None
    runner: CommandRunner | None


@dataclass
class PlaybookSpec:
    """One recovery playbook, declared once.

    ``kind`` is ``"mutating"`` (runs through ``_apply_playbook`` with the
    cooldown + per-cycle-cap guards) or ``"escalate_only"`` (runs through
    ``_apply_escalate_only_playbook`` — never mutates, never counts against the
    cap). ``detect`` is a zero-arg closure bound to the cycle context;
    ``execute`` + ``execute_kwargs`` are only used by mutating playbooks.
    """

    name: str
    kind: str
    detect: Callable[[], list[RecoveryTarget]]
    execute: Callable[..., RecoveryOutcome] | None = None
    execute_kwargs: dict[str, Any] = field(default_factory=dict)


def build_recovery_registry(ctx: _RecoveryContext) -> list[PlaybookSpec]:
    """Return the ordered list of recovery playbooks for this cycle.

    This is the single place a playbook is registered: adding one is a new
    ``PlaybookSpec`` entry, not a copy-paste of an inline detect+guard+execute
    block. Order is preserved (1→5) so behavior is identical to the former
    hand-wired sequence.
    """
    return [
        # Playbook 1: retry-mergeable-blocked-story
        PlaybookSpec(
            name=PLAYBOOK_RETRY_MERGEABLE_BLOCKED,
            kind="mutating",
            detect=lambda: detect_retry_mergeable_blocked_stories(
                ctx.root,
                db_path=ctx.db_path,
                apps=ctx.apps,
                gh_pr_view=ctx.gh_pr_view,
                runner=ctx.runner,
            ),
            execute=execute_retry_mergeable_blocked_story,
            execute_kwargs={"db_path": ctx.db_path},
        ),
        # Playbook 2: redispatch-phantom-pr-open
        PlaybookSpec(
            name=PLAYBOOK_REDISPATCH_PHANTOM_PR,
            kind="mutating",
            detect=lambda: detect_phantom_pr_open_stories(
                ctx.root,
                now=ctx.now,
                age_threshold=ctx.phantom_pr_age_threshold,
                db_path=ctx.db_path,
                apps=ctx.apps,
                gh_branch_exists=ctx.gh_branch_exists,
                runner=ctx.runner,
            ),
            execute=execute_redispatch_phantom_pr,
            execute_kwargs={"db_path": ctx.db_path},
        ),
        # Playbook 3: revert-premature-deploy-enable
        PlaybookSpec(
            name=PLAYBOOK_REVERT_PREMATURE_DEPLOY,
            kind="mutating",
            detect=lambda: detect_premature_deploy_enabled(ctx.root, apps=ctx.apps),
            execute=execute_revert_premature_deploy_enable,
            execute_kwargs={},
        ),
        # Playbook 4: conflicting-gated-pr — escalate-only, never mutates.
        PlaybookSpec(
            name=PLAYBOOK_CONFLICTING_GATED_PR,
            kind="escalate_only",
            detect=lambda: detect_conflicting_gated_prs(
                ctx.root,
                db_path=ctx.db_path,
                apps=ctx.apps,
                gh_pr_view=ctx.gh_pr_view,
                runner=ctx.runner,
            ),
        ),
        # Playbook 5: recover-stuck-fixonly-mode
        PlaybookSpec(
            name=PLAYBOOK_RECOVER_STUCK_FIXONLY,
            kind="mutating",
            detect=lambda: detect_stuck_fixonly_mode(
                ctx.root, db_path=ctx.db_path, apps=ctx.apps
            ),
            execute=execute_recover_stuck_fixonly_mode,
            execute_kwargs={"db_path": ctx.db_path},
        ),
        # Playbook 6: quarantine-invalid-enum-story
        PlaybookSpec(
            name=PLAYBOOK_QUARANTINE_INVALID_ENUM,
            kind="mutating",
            detect=lambda: detect_invalid_enum_stories(
                ctx.root, db_path=ctx.db_path, apps=ctx.apps
            ),
            execute=execute_quarantine_invalid_enum_story,
            execute_kwargs={"db_path": ctx.db_path},
        ),
    ]


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #


def run_recovery_cycle(
    root: Path,
    *,
    dry_run: bool = False,
    now: datetime | None = None,
    max_actions: int = DEFAULT_MAX_ACTIONS_PER_CYCLE,
    cooldown: timedelta = DEFAULT_COOLDOWN,
    phantom_pr_age_threshold: timedelta = DEFAULT_PHANTOM_PR_AGE_THRESHOLD,
    db_path: Path | None = None,
    apps: list[str] | None = None,
    gh_pr_view: Callable[..., dict[str, Any] | None] | None = None,
    gh_branch_exists: Callable[..., bool | None] | None = None,
    runner: CommandRunner | None = None,
) -> dict[str, Any]:
    """Run one operational-recovery cycle: detect, then act-or-escalate for
    every playbook, before any LLM-driven escalation happens.

    Returns a summary dict:
      ``{"dry_run", "recovered": [...], "escalated": [...],
         "skipped_cooldown": [...], "skipped_cap": [...], "errors": [...]}``

    If the factory is halted (``factory.manager.halt.is_halted``), mutations
    are forced into dry-run regardless of the ``dry_run`` argument — recovery
    keeps detecting and logging, but performs no mutation while halted (the
    same "detection continues, action stops" posture the L1 watcher and L4
    apply pipeline already use for halt/circuit-breaker state).
    """
    root = Path(root)
    now = now or datetime.now(UTC)

    forced_dry_run = False
    if not dry_run:
        try:
            from factory.manager.halt import is_halted

            if is_halted(root=root):
                forced_dry_run = True
        except Exception as _halt_exc:  # noqa: BLE001
            # Fail-open (mirrors factory/chain/orchestrator.py's halt-check
            # guard): a broken halt module must not block recovery. The
            # dangerous corrupt-halt-FILE path fails safe inside is_halted; this
            # only fires on a broken halt MODULE. Make it a visible CRITICAL
            # alert rather than a stderr line the FMS cannot see.
            try:
                from factory.manager.signals import write_alert_event

                write_alert_event(
                    "halt_check_module_error",
                    f"[recovery] halt-check raised {_halt_exc!r}; continuing "
                    "without forcing dry-run (fail-open).",
                    severity="critical",
                    software_factory_root=root,
                )
            except Exception:  # noqa: BLE001 - alerting is best-effort
                import sys as _sys

                print(
                    f"[recovery] CRITICAL: halt-check raised {_halt_exc!r}; "
                    "continuing (fail-open) and alert emit failed.",
                    file=_sys.stderr,
                )
    effective_dry_run = dry_run or forced_dry_run

    summary: dict[str, Any] = {
        "dry_run": effective_dry_run,
        "forced_dry_run_halted": forced_dry_run,
        "recovered": [],
        "escalated": [],
        "skipped_cooldown": [],
        "skipped_cap": [],
        "errors": [],
    }

    actions_taken = 0

    # Drive every playbook from the registry (see build_recovery_registry).
    # Registry order == the former hand-wired order (1→5); mutating playbooks go
    # through the shared cooldown+cap guard, escalate-only ones through their own
    # never-mutates seam. Adding a playbook is a new registry entry, not another
    # inline detect+guard+execute block here.
    ctx = _RecoveryContext(
        root=root,
        now=now,
        cooldown=cooldown,
        max_actions=max_actions,
        phantom_pr_age_threshold=phantom_pr_age_threshold,
        db_path=db_path,
        apps=apps,
        gh_pr_view=gh_pr_view,
        gh_branch_exists=gh_branch_exists,
        runner=runner,
    )
    for spec in build_recovery_registry(ctx):
        targets = spec.detect()
        if spec.kind == "escalate_only":
            _apply_escalate_only_playbook(
                root, targets, now=now, cooldown=cooldown, summary=summary
            )
        else:
            assert spec.execute is not None  # mutating playbooks always have one
            actions_taken = _apply_playbook(
                root,
                targets,
                spec.execute,
                dry_run=effective_dry_run,
                now=now,
                cooldown=cooldown,
                max_actions=max_actions,
                actions_taken=actions_taken,
                summary=summary,
                execute_kwargs=spec.execute_kwargs,
            )

    return summary


__all__ = [
    "RecoveryTarget",
    "RecoveryOutcome",
    "PlaybookSpec",
    "build_recovery_registry",
    "PLAYBOOK_RETRY_MERGEABLE_BLOCKED",
    "PLAYBOOK_REDISPATCH_PHANTOM_PR",
    "PLAYBOOK_REVERT_PREMATURE_DEPLOY",
    "PLAYBOOK_CONFLICTING_GATED_PR",
    "PLAYBOOK_RECOVER_STUCK_FIXONLY",
    "PLAYBOOK_QUARANTINE_INVALID_ENUM",
    "detect_retry_mergeable_blocked_stories",
    "execute_retry_mergeable_blocked_story",
    "detect_phantom_pr_open_stories",
    "execute_redispatch_phantom_pr",
    "detect_premature_deploy_enabled",
    "execute_revert_premature_deploy_enable",
    "detect_conflicting_gated_prs",
    "detect_stuck_fixonly_mode",
    "execute_recover_stuck_fixonly_mode",
    "detect_invalid_enum_stories",
    "execute_quarantine_invalid_enum_story",
    "run_recovery_cycle",
]
