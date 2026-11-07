"""factory.manager.staging — canary/shadow deploy for factory self-modification.

Safety foundation (Tier 3 WS3.5): let the factory modify its OWN code
(paths under ``factory/``) without being able to kill itself.

The problem
-----------
When the FMS proposes a change to the factory's own source, applying it
directly to the live repo and auto-merging means a fatal self-edit (an import
error, a broken CLI, a green-but-non-running suite) lands on the running
factory. The circuit-breaker (``factory.manager.circuit_breaker``) can *revert*
a bad self-edit after the fact, but only once a regression is observed on the
live self — the damage window is real.

The mechanism (operator-designed)
---------------------------------
This module is a *shadow deploy* for self-modification. Instead of applying a
self-edit to the live factory, we:

  1. **Sync** a throwaway COPY repo's ``main`` to the real ``origin/main`` so
     the self-edit is validated on top of *current* factory code, not stale
     code (``sync_copy_from_main``).
  2. **Apply** the proposal's diff on a fresh ``staging/<id>`` branch of the
     COPY, commit, and push it to the COPY (never the real factory).
  3. **Validate** by *actually running the cloned factory* in an isolated
     checkout: deps resolve, the full test suite is green, the package imports
     + CLI loads, and a dry-run tick exercises the real orchestration loop
     end-to-end on the changed code (``stage_and_validate_self_edit`` →
     ``StagingResult``).
  4. Only if the clone runs **healthy** does the caller PROMOTE (the existing
     PR-to-real-factory + auto-merge path). A fatal self-edit fails on the
     clone and never touches the live self.

Why no real (non-dry-run) tick
------------------------------
A real tick spends LLM budget and mutates app state. The validation therefore
stops at the held-out behavioral bench — the full suite + import/CLI smoke + a
**dry-run** tick. The dry-run tick still runs the real tick orchestration code
(``factory tick --dry-run`` performs no LLM/GitHub/repo writes), so a self-edit
that breaks the tick loop is caught, without paying for a real run. This is a
deliberate cost/coverage tradeoff: we trade "would a *real* tick succeed" for
"does the changed code import, pass its own suite, and drive a dry tick".

Fail-safe posture
-----------------
Every uncertain outcome resolves to **do not promote**. A subprocess timeout,
a clone/push failure, an unreadable result — all return ``healthy=False`` (or
raise ``StagingInfraError``, which the caller treats as not-promoted + escalate).
A staging infra failure must never crash the L4 manager cycle and must never be
interpreted as "promote anyway".
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.diff_paths import _diff_target_paths
from factory.manager.signals import write_alert_event, write_event

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: The throwaway staging COPY repo. A fatal self-edit fails HERE, never on the
#: live factory. This repo is disposable and continuously reset to origin/main.
DEFAULT_COPY_URL = "git@github.com:xvanov/software-factory-copy.git"

#: Event stream for staging outcomes.
STAGING_STREAM = "manager_staging"

#: Per-stage subprocess timeouts (seconds). Generous but finite — the whole
#: point is that a hung self-edit cannot wedge the manager cycle forever.
TIMEOUT_GIT = 180              # clone / fetch / push
TIMEOUT_UV_SYNC = 900          # uv sync --all-extras (cold cache can be slow)
TIMEOUT_PYTEST = 1800          # full uv run pytest -q (the behavioral bench)
TIMEOUT_SMOKE = 180            # uv run factory --help (import + CLI load)
TIMEOUT_DRY_TICK = 600         # uv run factory tick --app <a> --dry-run

#: How many characters of captured logs to retain on the result (tail).
_LOGS_TAIL_CHARS = 4000

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


# ---------------------------------------------------------------------------
# Result / error types
# ---------------------------------------------------------------------------


@dataclass
class StagingResult:
    """Outcome of validating a self-edit on the staging COPY.

    Attributes
    ----------
    healthy:
        True ONLY when every validation stage passed on the isolated clone.
        The caller must treat anything other than ``healthy is True`` as
        "do not promote" (fail-safe).
    stage_failed:
        The name of the first stage that failed (``None`` when healthy), one of
        ``{"sync", "clone", "apply", "push", "uv_sync", "pytest",
        "import_smoke", "dry_run_tick"}``.
    logs_tail:
        Tail of captured stdout/stderr from the failing stage (or a short
        success note), for the escalation event / operator triage.
    branch:
        The ``staging/<id>`` branch pushed to the COPY (for auditing).
    proposal_id:
        The proposal's stable id (echoed for correlation).
    """

    healthy: bool
    stage_failed: str | None = None
    logs_tail: str = ""
    branch: str | None = None
    proposal_id: str = ""


class StagingInfraError(RuntimeError):
    """Raised when the staging harness itself fails (not the self-edit).

    Distinct from a *validation* failure (``StagingResult(healthy=False)``):
    an infra error means we could not even determine health (e.g. the COPY
    repo is unreachable, a temp clone could not be created). The caller
    treats this as fail-safe: NOT promoted + escalate, never "promote anyway".
    """


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _tail(text: str, n: int = _LOGS_TAIL_CHARS) -> str:
    if not text:
        return ""
    return text[-n:]


def _run(
    args: list[str],
    *,
    cwd: Path | None,
    runner: Runner,
    timeout: int,
) -> subprocess.CompletedProcess[str]:
    """Invoke ``runner`` uniformly. Never raises for a non-zero rc; a timeout
    surfaces as ``subprocess.TimeoutExpired`` which callers convert to a
    fail-safe (not-promoted) outcome."""
    return runner(
        args,
        cwd=str(cwd) if cwd is not None else None,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )


def is_self_edit(paths: list[str]) -> bool:
    """Return True if any target path is under ``factory/`` (a self-edit).

    Uses the same notion of "target path" as the forbidden-path guard in
    ``factory.manager.forbidden_paths`` (both consume ``_diff_target_paths``).
    An app-repo change (paths under ``apps/`` or elsewhere) is NOT a self-edit
    and bypasses staging.
    """
    return any(p == "factory" or p.startswith("factory/") for p in paths)


def self_edit_paths(patch: str) -> list[str]:
    """Convenience: the target paths of *patch* that are self-edits."""
    return [p for p in _diff_target_paths(patch) if p == "factory" or p.startswith("factory/")]


def _slugify(text: str, *, max_len: int = 40) -> str:
    """Lowercase, collapse non-alnum runs into ``-``, trim, clip.

    Moved from ``factory/chain/factory_improver_apply.py`` (deleted
    2026-08-07); this module is its only surviving consumer.
    """
    s = re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-").lower()
    return (s[:max_len] or "improvement").rstrip("-")


def _extract_patch(proposal: dict[str, Any]) -> str:
    inner = proposal.get("proposal", {})
    patch = inner.get("suggested_patch", "") if isinstance(inner, dict) else ""
    return patch if isinstance(patch, str) else ""


def _resolve_dry_tick_app(root: Path) -> str:
    """Pick a throwaway/first configured app for the dry-run tick.

    Prefers a non-``factory`` app (so the tick exercises real app plumbing),
    falling back to the first apps/ subdir, then to ``"factory"``.
    """
    apps_dir = root / "apps"
    try:
        candidates = sorted(
            p.name for p in apps_dir.iterdir() if p.is_dir() and not p.name.startswith(".")
        )
    except OSError:
        candidates = []
    for name in candidates:
        if name != "factory":
            return name
    if candidates:
        return candidates[0]
    return "factory"


# ---------------------------------------------------------------------------
# Step 1 — keep the COPY's main mirroring the real origin/main
# ---------------------------------------------------------------------------


def sync_copy_from_main(
    *,
    root: Path,
    copy_url: str = DEFAULT_COPY_URL,
    runner: Runner | None = None,
    timeout: int = TIMEOUT_GIT,
) -> None:
    """Force the COPY repo's ``main`` to match the real ``origin/main``.

    Idempotent: fetches ``origin`` in the live repo, then force-pushes the
    fetched ``origin/main`` straight onto the COPY's ``main``. Running it twice
    in a row is a no-op the second time. This guarantees each staging run
    applies the self-edit on top of CURRENT factory code, not a stale seed.

    Raises
    ------
    StagingInfraError
        If either the fetch or the mirror-push fails. (Fail-safe: the caller
        will not promote when it cannot establish a current baseline.)
    """
    runner = runner or subprocess.run
    assert runner is not None

    # 1. Refresh our knowledge of the real origin/main.
    fetch = _run(["git", "fetch", "origin", "main"], cwd=root, runner=runner, timeout=timeout)
    if fetch.returncode != 0:
        raise StagingInfraError(
            f"git fetch origin main failed rc={fetch.returncode}: {_tail(fetch.stderr or '', 500)}"
        )

    # 2. Force-update the COPY's main to exactly the fetched origin/main.
    #    Refspec origin/main:refs/heads/main pushes the *fetched* remote-tracking
    #    ref onto the copy's main; --force makes it a hard mirror (idempotent).
    push = _run(
        ["git", "push", "--force", copy_url, "refs/remotes/origin/main:refs/heads/main"],
        cwd=root,
        runner=runner,
        timeout=timeout,
    )
    if push.returncode != 0:
        raise StagingInfraError(
            f"mirror-push to copy failed rc={push.returncode}: {_tail(push.stderr or '', 500)}"
        )


# ---------------------------------------------------------------------------
# Step 2/3 — apply the self-edit on the COPY and validate an isolated checkout
# ---------------------------------------------------------------------------


def _default_validator(
    checkout_dir: Path,
    *,
    root: Path,
    runner: Runner,
) -> StagingResult:
    """Run the "does-it-still-run" validation IN ORDER on a fresh checkout.

    Stops at the first failing stage. Each stage is bounded by a finite
    timeout; a ``subprocess.TimeoutExpired`` is caught and converted to a
    fail-safe (``healthy=False``) result for that stage.

    Stages (in order):
      1. ``uv sync --all-extras``           — deps resolve       (uv_sync)
      2. ``uv run pytest -q``               — behavioral bench   (pytest)
      3. ``uv run factory --help``          — import + CLI load  (import_smoke)
      4. ``uv run factory tick --app <a> --dry-run``  — tick loop (dry_run_tick)

    The checkout is a DIFFERENT working tree from the live suite, so a self-edit
    cannot have tampered with the suite that judges it.
    """
    app = _resolve_dry_tick_app(root)
    stages: list[tuple[str, list[str], int]] = [
        ("uv_sync", ["uv", "sync", "--all-extras"], TIMEOUT_UV_SYNC),
        ("pytest", ["uv", "run", "pytest", "-q"], TIMEOUT_PYTEST),
        ("import_smoke", ["uv", "run", "factory", "--help"], TIMEOUT_SMOKE),
        (
            "dry_run_tick",
            ["uv", "run", "factory", "tick", "--app", app, "--dry-run"],
            TIMEOUT_DRY_TICK,
        ),
    ]

    for stage_name, cmd, timeout in stages:
        try:
            proc = _run(cmd, cwd=checkout_dir, runner=runner, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            return StagingResult(
                healthy=False,
                stage_failed=stage_name,
                logs_tail=f"TIMEOUT after {timeout}s running {' '.join(cmd)}: {exc!r}",
            )
        except Exception as exc:  # noqa: BLE001 - fail-safe: any harness error = not healthy
            return StagingResult(
                healthy=False,
                stage_failed=stage_name,
                logs_tail=f"harness error running {' '.join(cmd)}: {exc!r}",
            )
        if proc.returncode != 0:
            combined = (proc.stdout or "") + "\n--- stderr ---\n" + (proc.stderr or "")
            return StagingResult(
                healthy=False,
                stage_failed=stage_name,
                logs_tail=_tail(combined),
            )

    return StagingResult(healthy=True, stage_failed=None, logs_tail="all stages passed")


def stage_and_validate_self_edit(
    proposal: dict[str, Any],
    *,
    root: Path,
    copy_url: str = DEFAULT_COPY_URL,
    runner: Runner | None = None,
    validator: Callable[..., StagingResult] | None = None,
) -> StagingResult:
    """Stage a self-edit on the COPY repo and validate it by actually running it.

    Steps:
      a. Sync the COPY to current ``origin/main`` (``sync_copy_from_main``).
      b. Clone the COPY into a temp dir, create ``staging/<proposal_id>``, apply
         the proposal's diff, commit, and push the branch to the COPY.
      c. In an ISOLATED fresh checkout of that pushed branch, run the validation
         stages in order, stopping at the first failure (``validator``).

    A real (non-dry-run) tick is deliberately NOT run — see module docstring.

    Returns
    -------
    StagingResult
        ``healthy=True`` only when every stage passed. Any git/clone/push/apply
        failure returns ``healthy=False`` with the failing ``stage_failed``.

    Raises
    ------
    StagingInfraError
        For harness-level failures where health could not be determined (COPY
        unreachable, temp dir unusable, sync failed). The caller converts this
        to NOT-promoted + escalate (fail-safe); it must never crash L4.
    """
    runner = runner or subprocess.run
    assert runner is not None
    validator = validator or _default_validator

    proposal_id = str(proposal.get("proposal_id", "") or "")
    patch = _extract_patch(proposal)
    if not patch.strip():
        raise StagingInfraError("proposal has no suggested_patch to stage")

    branch = f"staging/{_slugify(proposal_id or proposal.get('concern_title', 'unknown'))}"

    # (a) Sync the COPY's main to CURRENT origin/main so we validate on top of
    #     live code, not a stale seed. A sync failure is an infra error.
    sync_copy_from_main(root=root, copy_url=copy_url, runner=runner)

    workdir = Path(tempfile.mkdtemp(prefix="fms-staging-"))
    build_dir = workdir / "build"
    verify_dir = workdir / "verify"
    try:
        # (b) Clone the COPY, build the staging branch, push it back.
        clone = _run(
            ["git", "clone", "--branch", "main", copy_url, str(build_dir)],
            cwd=None,
            runner=runner,
            timeout=TIMEOUT_GIT,
        )
        if clone.returncode != 0:
            raise StagingInfraError(
                f"clone of copy failed rc={clone.returncode}: {_tail(clone.stderr or '', 500)}"
            )

        # Identity for the commit (the clone may not inherit a global git user).
        _run(["git", "config", "user.email", "fms@factory"], cwd=build_dir, runner=runner, timeout=30)
        _run(["git", "config", "user.name", "FMS Staging"], cwd=build_dir, runner=runner, timeout=30)
        _run(["git", "config", "commit.gpgsign", "false"], cwd=build_dir, runner=runner, timeout=30)

        co = _run(["git", "checkout", "-b", branch], cwd=build_dir, runner=runner, timeout=30)
        if co.returncode != 0:
            return StagingResult(
                healthy=False,
                stage_failed="apply",
                logs_tail=f"branch create failed: {_tail(co.stderr or '', 500)}",
                branch=branch,
                proposal_id=proposal_id,
            )

        # Apply the diff.
        patch_for_apply = patch if patch.endswith("\n") else patch + "\n"
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".patch", delete=False, encoding="utf-8"
        )
        try:
            tmp.write(patch_for_apply)
            tmp.flush()
            tmp.close()
            applied = _run(
                ["git", "apply", "--whitespace=nowarn", tmp.name],
                cwd=build_dir,
                runner=runner,
                timeout=60,
            )
        finally:
            Path(tmp.name).unlink(missing_ok=True)

        if applied.returncode != 0:
            return StagingResult(
                healthy=False,
                stage_failed="apply",
                logs_tail=f"git apply failed: {_tail(applied.stderr or '', 800)}",
                branch=branch,
                proposal_id=proposal_id,
            )

        _run(["git", "add", "-A"], cwd=build_dir, runner=runner, timeout=30)
        committed = _run(
            ["git", "commit", "-m", f"staging: {proposal_id or branch}"],
            cwd=build_dir,
            runner=runner,
            timeout=30,
        )
        if committed.returncode != 0:
            return StagingResult(
                healthy=False,
                stage_failed="apply",
                logs_tail=f"commit failed: {_tail(committed.stderr or '', 500)}",
                branch=branch,
                proposal_id=proposal_id,
            )

        pushed = _run(
            ["git", "push", "--force", "origin", branch],
            cwd=build_dir,
            runner=runner,
            timeout=TIMEOUT_GIT,
        )
        if pushed.returncode != 0:
            return StagingResult(
                healthy=False,
                stage_failed="push",
                logs_tail=f"push to copy failed: {_tail(pushed.stderr or '', 500)}",
                branch=branch,
                proposal_id=proposal_id,
            )

        # (c) Fresh ISOLATED checkout of the pushed branch — a different working
        #     tree from `build_dir`, so validation reads exactly what landed in
        #     the COPY (not a possibly-dirty build tree).
        verify_clone = _run(
            ["git", "clone", "--branch", branch, copy_url, str(verify_dir)],
            cwd=None,
            runner=runner,
            timeout=TIMEOUT_GIT,
        )
        if verify_clone.returncode != 0:
            raise StagingInfraError(
                f"verify-clone failed rc={verify_clone.returncode}: "
                f"{_tail(verify_clone.stderr or '', 500)}"
            )

        result = validator(verify_dir, root=root, runner=runner)
        # Stamp branch / id for auditing regardless of what the validator set.
        result.branch = branch
        result.proposal_id = proposal_id
        return result
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Caller-facing gate: run staging + emit the first-class events
# ---------------------------------------------------------------------------


@dataclass
class StagingDecision:
    """What the apply pipeline should do with a self-edit after staging.

    ``promote`` is True ONLY on a healthy validation. Every other outcome
    (unhealthy validation, infra failure) is ``promote=False`` with a status
    the caller records — the real factory is never touched.
    """

    promote: bool
    status: str
    stage_failed: str | None = None
    logs_tail: str = ""
    branch: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def gate_self_edit(
    proposal: dict[str, Any],
    proposal_path: str,
    *,
    root: Path,
    copy_url: str = DEFAULT_COPY_URL,
    runner: Runner | None = None,
    validator: Callable[..., StagingResult] | None = None,
) -> StagingDecision:
    """Run staging for a self-edit and emit a first-class outcome event.

    Fail-safe contract:
      * healthy validation      → ``promote=True``  (caller proceeds to PR/merge)
      * unhealthy validation    → ``promote=False`` status ``staging_rejected``
      * staging infra failure   → ``promote=False`` status ``staging_infra_failed``
        (escalated; the manager cycle continues — this never raises)

    Uncertainty ALWAYS resolves to ``promote=False``.
    """
    proposal_id = str(proposal.get("proposal_id", "") or "")
    concern_title = str(proposal.get("concern_title", "unknown"))
    try:
        result = stage_and_validate_self_edit(
            proposal,
            root=root,
            copy_url=copy_url,
            runner=runner,
            validator=validator,
        )
    except StagingInfraError as exc:
        # Harness could not determine health → fail-safe: do not promote.
        write_alert_event(
            "staging_infra_failure",
            f"self-edit staging harness failed for {concern_title!r}: {exc}",
            severity="error",
            software_factory_root=root,
            proposal_id=proposal_id,
            proposal_path=proposal_path,
        )
        write_event(
            STAGING_STREAM,
            {
                "event": "staging_infra_failed",
                "proposal_id": proposal_id,
                "proposal_path": proposal_path,
                "concern_title": concern_title,
                "promoted": False,
                "detail": str(exc)[:1000],
            },
            software_factory_root=root,
        )
        return StagingDecision(
            promote=False,
            status="staging_infra_failed",
            logs_tail=str(exc)[:_LOGS_TAIL_CHARS],
        )
    except Exception as exc:  # noqa: BLE001 - never crash L4; fail-safe.
        write_alert_event(
            "staging_unexpected_error",
            f"unexpected staging error for {concern_title!r}: {exc!r}",
            severity="error",
            software_factory_root=root,
            proposal_id=proposal_id,
            proposal_path=proposal_path,
        )
        write_event(
            STAGING_STREAM,
            {
                "event": "staging_infra_failed",
                "proposal_id": proposal_id,
                "proposal_path": proposal_path,
                "concern_title": concern_title,
                "promoted": False,
                "detail": repr(exc)[:1000],
            },
            software_factory_root=root,
        )
        return StagingDecision(
            promote=False,
            status="staging_infra_failed",
            logs_tail=repr(exc)[:_LOGS_TAIL_CHARS],
        )

    if result.healthy:
        write_event(
            STAGING_STREAM,
            {
                "event": "staging_validated",
                "proposal_id": proposal_id,
                "proposal_path": proposal_path,
                "concern_title": concern_title,
                "promoted": True,
                "branch": result.branch,
            },
            software_factory_root=root,
        )
        return StagingDecision(
            promote=True,
            status="staging_validated",
            branch=result.branch,
        )

    # Unhealthy: a real stage failed on the clone. Do NOT touch the real factory.
    write_alert_event(
        "staging_rejected",
        f"self-edit for {concern_title!r} failed staging at "
        f"{result.stage_failed!r}; NOT promoted to live factory.",
        severity="warning",
        software_factory_root=root,
        proposal_id=proposal_id,
        proposal_path=proposal_path,
        stage_failed=result.stage_failed,
    )
    write_event(
        STAGING_STREAM,
        {
            "event": "staging_rejected",
            "proposal_id": proposal_id,
            "proposal_path": proposal_path,
            "concern_title": concern_title,
            "promoted": False,
            "stage_failed": result.stage_failed,
            "branch": result.branch,
            "logs_tail": result.logs_tail[:2000],
        },
        software_factory_root=root,
    )
    return StagingDecision(
        promote=False,
        status="staging_rejected",
        stage_failed=result.stage_failed,
        logs_tail=result.logs_tail,
        branch=result.branch,
    )


__all__ = [
    "DEFAULT_COPY_URL",
    "STAGING_STREAM",
    "StagingResult",
    "StagingDecision",
    "StagingInfraError",
    "is_self_edit",
    "self_edit_paths",
    "sync_copy_from_main",
    "stage_and_validate_self_edit",
    "gate_self_edit",
]
