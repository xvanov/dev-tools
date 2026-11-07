"""factory.manager.circuit_breaker — Circuit breaker for manager-authored commits (Phase 8).

The circuit breaker watches for test regressions on ``main`` that were caused
by manager-authored commits.  When a regression is detected:

1. Identifies the most-recent manager-authored commit on ``main``.
2. Auto-reverts it on a new branch ``factory-manager-revert/<ts>``.
3. Opens a PR for the revert (operator must merge — no auto-merge).
4. Writes ``state/circuit_breaker.json`` with a 24h halt window.

Before 2026-08-07, a 5th step gated the L4 apply pipeline
(``apply_manager_proposals`` refused any safe auto-apply while tripped,
logged as ``status=apply_pipeline_halted_by_circuit_breaker``). That pipeline
was deleted along with the other three FMS LLM tiers — see STATUS.md and the
Exteroception v1 direction, P0. The breaker itself (revert + trip state +
``factory manager circuit-breaker status``) still stands: there is currently
no auto-apply surface left for it to gate, but tripping still records the
regression and reverts the commit.

Design principles
-----------------
* DETERMINISTIC — no LLM calls.  A test failure is a hard fact;
  reverting is fail-safe.
* Only tracks commits recorded via ``record_manager_commit``.  Non-manager
  commits that break tests are outside the breaker's scope (the operator
  owns those).
* The breaker guards *safe auto-apply*; risky / operator-reviewed proposals
  are unaffected (the operator is already in the loop for those).

Schema (``state/circuit_breaker.json``)
---------------------------------------
.. code-block:: json

    {
        "schema_version": 1,
        "tripped_at": "<ISO 8601 UTC>",
        "regression_commit": "<sha>",
        "regression_commit_message": "...",
        "revert_branch": "factory-manager-revert/...",
        "revert_pr_number": <int | null>,
        "test_output_excerpt": "<≤2KB tail of failing test output>",
        "halt_until": "<tripped_at + 24h>"
    }

Public API
----------
* ``record_manager_commit`` — track a manager-authored commit.
* ``check_and_trip`` — run tests; if they fail AND the tip of main is a
  tracked SHA, revert and trip.
* ``is_tripped`` — True if the breaker is active (halt_until > now).
* ``get_state`` — return the current state dict or None.
* ``reset`` — operator-only; archive + clear the breaker state.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SCHEMA_VERSION = 1

# State file locations.
_CB_FILE = "circuit_breaker.json"
_CB_HISTORY_FILE = ".circuit_breaker_history.json"
_MANAGER_COMMITS_FILE = ".manager_commits.ndjson"

# Halt window after tripping.
_HALT_WINDOW = timedelta(hours=24)

# How many bytes of test output to keep in the state file (tail).
_TEST_OUTPUT_CAP = 2 * 1024  # 2 KB


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _cb_path(root: Path) -> Path:
    return root / "state" / _CB_FILE


def _history_path(root: Path) -> Path:
    return root / "state" / _CB_HISTORY_FILE


def _commits_path(root: Path) -> Path:
    return root / "state" / _MANAGER_COMMITS_FILE


# ---------------------------------------------------------------------------
# record_manager_commit
# ---------------------------------------------------------------------------


def record_manager_commit(*, root: Path, sha: str, proposal_path: str) -> None:
    """Track a manager-authored commit.

    Called by ``apply.py`` after each successful commit.  Appended to
    ``state/.manager_commits.ndjson`` (one JSON object per line).

    Parameters
    ----------
    root:
        Factory root directory.
    sha:
        The commit SHA (branch HEAD at apply time — see module docstring
        for why squash SHA isn't available here).
    proposal_path:
        Absolute path to the proposal JSON that produced this commit.
    """
    root = Path(root)
    path = _commits_path(root)
    record: dict[str, Any] = {
        "schema_version": _SCHEMA_VERSION,
        "ts": datetime.now(UTC).isoformat(),
        "sha": sha,
        "proposal_path": proposal_path,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception as exc:  # noqa: BLE001
        print(
            f"[circuit_breaker] WARNING: failed to record manager commit {sha!r}: {exc!r}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# _load_manager_commits
# ---------------------------------------------------------------------------


def _load_manager_commits(root: Path) -> list[dict[str, Any]]:
    """Return all tracked manager commits, oldest first."""
    path = _commits_path(root)
    if not path.exists():
        return []
    commits: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    if isinstance(rec, dict) and rec.get("sha"):
                        commits.append(rec)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return commits


# ---------------------------------------------------------------------------
# _get_main_tip_sha
# ---------------------------------------------------------------------------


def _get_main_tip_sha(root: Path) -> str | None:
    """Return the current HEAD sha on the current branch."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            return proc.stdout.strip() or None
    except Exception:  # noqa: BLE001
        pass
    return None


def _get_commit_message(root: Path, sha: str) -> str:
    """Return the first line of the commit message for *sha*."""
    try:
        proc = subprocess.run(
            ["git", "log", "-1", "--format=%s", sha],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


# ---------------------------------------------------------------------------
# check_and_trip
# ---------------------------------------------------------------------------


def check_and_trip(
    *,
    root: Path,
    test_command: str = "uv run pytest -q",
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Run the test suite; if it fails AND the HEAD is a tracked manager commit, trip.

    Steps:
    1. Load tracked manager commits.
    2. Run the test command.
    3. If tests PASS → no action.
    4. If tests FAIL:
       a. Get HEAD sha.
       b. If HEAD sha is NOT in tracked commits → no action (not our fault).
       c. If HEAD sha IS tracked → revert, open PR, write state, return state dict.

    Parameters
    ----------
    root:
        Factory root directory.
    test_command:
        Shell command to run the test suite.  Default: ``uv run pytest -q``.
    now:
        Override the current time (for tests).

    Returns
    -------
    dict | None
        The breaker state dict if tripped, None if no action taken.
    """
    root = Path(root)
    now = now or datetime.now(UTC)

    manager_commits = _load_manager_commits(root)
    tracked_shas = {c["sha"] for c in manager_commits}

    # Run tests.
    test_output = ""
    try:
        proc = subprocess.run(
            test_command,
            shell=True,
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=600,
        )
        tests_passed = proc.returncode == 0
        combined = (proc.stdout or "") + (proc.stderr or "")
        test_output = combined[-_TEST_OUTPUT_CAP:] if len(combined) > _TEST_OUTPUT_CAP else combined
    except Exception as exc:  # noqa: BLE001
        # Cannot run tests at all — treat as test failure.
        tests_passed = False
        test_output = f"[circuit_breaker] test_command raised: {exc!r}"

    if tests_passed:
        return None

    # Tests failed — check if HEAD is a manager commit.
    tip_sha = _get_main_tip_sha(root)
    if not tip_sha:
        print(
            "[circuit_breaker] WARNING: could not determine HEAD sha; "
            "skipping circuit-breaker trip.",
            file=sys.stderr,
        )
        return None

    if tip_sha not in tracked_shas:
        # Test failure, but HEAD isn't a manager commit — not our regression.
        return None

    # HEAD is a tracked manager commit and tests fail → trip the breaker.
    commit_message = _get_commit_message(root, tip_sha)
    ts_str = now.strftime("%Y%m%dT%H%M%S")
    revert_branch = f"factory-manager-revert/{ts_str}"

    # Create revert branch and run git revert.
    pr_number: int | None = None

    try:
        # Create branch from HEAD.
        br_proc = subprocess.run(
            ["git", "checkout", "-b", revert_branch],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if br_proc.returncode == 0:
            # Revert the commit.
            rv_proc = subprocess.run(
                ["git", "revert", "--no-edit", tip_sha],
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=60,
            )
            if rv_proc.returncode == 0:
                # Push the revert branch.
                push_proc = subprocess.run(
                    ["git", "push", "-u", "origin", revert_branch],
                    cwd=str(root),
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if push_proc.returncode == 0:
                    # Open a PR for the revert.
                    pr_body = (
                        f"Auto-revert of manager-authored commit {tip_sha[:12]}\n\n"
                        f"The circuit breaker tripped because tests failed after this commit merged.\n\n"
                        f"**Regression commit:** `{tip_sha[:12]}`\n"
                        f"**Commit message:** {commit_message}\n\n"
                        f"**Test output excerpt:**\n```\n{test_output[:500]}\n```\n\n"
                        "Operator review required before merging this revert.\n"
                        "After merging, run `factory manager circuit-breaker reset` to clear the halt."
                    )
                    gh_proc = subprocess.run(
                        [
                            "gh",
                            "pr",
                            "create",
                            "--title",
                            f"[auto-revert] revert manager commit {tip_sha[:12]}",
                            "--body",
                            pr_body,
                            "--head",
                            revert_branch,
                            "--label",
                            "factory-self-improvement-review",
                        ],
                        cwd=str(root),
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    if gh_proc.returncode == 0:
                        # Parse PR number from URL line.
                        pr_url = (gh_proc.stdout or "").strip()
                        try:
                            pr_number = int(pr_url.rstrip("/").split("/")[-1])
                        except (ValueError, IndexError):
                            pr_number = None
    except Exception as exc:  # noqa: BLE001
        print(
            f"[circuit_breaker] WARNING: revert/PR creation failed: {exc!r}",
            file=sys.stderr,
        )

    halt_until = (now + _HALT_WINDOW).isoformat()
    state: dict[str, Any] = {
        "schema_version": _SCHEMA_VERSION,
        "tripped_at": now.isoformat(),
        "regression_commit": tip_sha,
        "regression_commit_message": commit_message,
        "revert_branch": revert_branch,
        "revert_pr_number": pr_number,
        "test_output_excerpt": test_output,
        "halt_until": halt_until,
    }

    cb_file = _cb_path(root)
    try:
        cb_file.parent.mkdir(parents=True, exist_ok=True)
        cb_file.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        # A control-plane write failure must be visible, not swallowed to
        # stderr alone: if we cannot persist the tripped state, the breaker
        # will not block the next apply cycle. Surface it as an anomaly alert.
        _alert_cb_unreadable(
            root,
            cb_file,
            f"failed to WRITE circuit_breaker.json after tripping "
            f"(regression_commit={tip_sha[:12]!r}): {exc!r}. The breaker may "
            "not block the next apply cycle.",
        )

    print(
        f"[circuit_breaker] TRIPPED: regression_commit={tip_sha[:12]!r} "
        f"revert_branch={revert_branch!r} pr_number={pr_number} "
        f"halt_until={halt_until}",
        file=sys.stderr,
    )
    return state


# ---------------------------------------------------------------------------
# is_tripped
# ---------------------------------------------------------------------------


def is_tripped(*, root: Path, now: datetime | None = None) -> bool:
    """Return True if the circuit breaker is active (halt_until > now).

    A tripped breaker blocks the L4 apply pipeline from auto-applying
    safe proposals until the operator resets it.

    Fail-CLOSED semantics (consistent with :func:`factory.manager.halt.is_halted`):
    * No state file            → not tripped (normal state).
    * State file present but unreadable/corrupt → **stay tripped** + CRITICAL
      alert. A breaker exists to block risky auto-apply; if we cannot read it
      we must not silently reopen the gate.
    * Valid state, unparseable ``halt_until`` → stay tripped + alert.
    * Valid state, valid ``halt_until``       → tripped iff now < halt_until.
    """
    path = _cb_path(root)
    if not path.exists():
        return False

    state = get_state(root=root)
    if state is None:
        # File exists but get_state could not parse it → fail-closed + alert.
        _alert_cb_unreadable(
            root,
            path,
            "circuit_breaker.json present but unreadable/corrupt; staying TRIPPED "
            "(fail-closed). Reset with `factory manager circuit-breaker reset` "
            "once the file is fixed.",
        )
        return True

    halt_until_str = state.get("halt_until")
    if not halt_until_str:
        _alert_cb_unreadable(
            root, path, "circuit_breaker.json has no halt_until; staying TRIPPED."
        )
        return True  # state exists but no halt_until → treat as tripped
    try:
        halt_until = datetime.fromisoformat(halt_until_str)
        if halt_until.tzinfo is None:
            halt_until = halt_until.replace(tzinfo=UTC)
        ts_now = now or datetime.now(UTC)
        if ts_now.tzinfo is None:
            ts_now = ts_now.replace(tzinfo=UTC)
        return ts_now < halt_until
    except (ValueError, TypeError):
        _alert_cb_unreadable(
            root,
            path,
            f"circuit_breaker.json halt_until={halt_until_str!r} unparseable; "
            "staying TRIPPED (fail-closed).",
        )
        return True  # unparseable → fail-closed (stay tripped)


def _alert_cb_unreadable(root: Path, path: Path, detail: str) -> None:
    """Emit a CRITICAL, visible alert for a corrupt/ambiguous breaker state.

    Best-effort — alerting must never raise out of ``is_tripped``.
    """
    try:
        from factory.manager.signals import write_alert_event

        write_alert_event(
            "circuit_breaker_state_corrupt",
            detail,
            severity="critical",
            software_factory_root=root,
            cb_path=str(path),
        )
    except Exception:  # noqa: BLE001 - alerting is best-effort; never raise here
        print(f"[circuit_breaker] CRITICAL: {detail}", file=sys.stderr)


# ---------------------------------------------------------------------------
# get_state
# ---------------------------------------------------------------------------


def get_state(*, root: Path) -> dict[str, Any] | None:
    """Return the circuit-breaker state dict or None if not tripped."""
    path = _cb_path(root)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return None


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------


def reset(
    *,
    root: Path,
    cleared_by: str = "operator",
    reason: str | None = None,
) -> dict[str, Any]:
    """Clear the circuit breaker.  OPERATOR-ONLY.

    Archives the current state to ``state/.circuit_breaker_history.json`` and
    removes ``state/circuit_breaker.json``.

    Parameters
    ----------
    root:
        Factory root directory.
    cleared_by:
        Who is clearing the breaker.  Defaults to "operator".
    reason:
        Optional free-text reason.

    Returns
    -------
    dict
        The archived state (with ``cleared_at``, ``cleared_by``,
        ``clear_reason`` added).

    Raises
    ------
    FileNotFoundError
        If there is no active circuit-breaker state to clear.
    """
    root = Path(root)
    cb_file = _cb_path(root)

    if not cb_file.exists():
        raise FileNotFoundError(
            f"No circuit-breaker state file at {cb_file}; nothing to reset."
        )

    state = json.loads(cb_file.read_text(encoding="utf-8"))
    archived = dict(state)
    archived["cleared_at"] = datetime.now(UTC).isoformat()
    archived["cleared_by"] = cleared_by
    if reason is not None:
        archived["clear_reason"] = reason

    _append_history(root, archived)
    cb_file.unlink()

    print(
        f"[circuit_breaker] RESET by {cleared_by!r}: "
        f"regression_commit={state.get('regression_commit', '?')[:12]!r}",
        file=sys.stderr,
    )
    return archived


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _append_history(root: Path, entry: dict[str, Any]) -> None:
    """Append an entry to the circuit-breaker history archive."""
    hist_path = _history_path(root)
    history: list[dict[str, Any]] = []
    if hist_path.exists():
        try:
            data = json.loads(hist_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                history = data
        except (OSError, json.JSONDecodeError):
            pass
    history.append(entry)
    hist_path.parent.mkdir(parents=True, exist_ok=True)
    hist_path.write_text(json.dumps(history, indent=2), encoding="utf-8")


__all__ = [
    "record_manager_commit",
    "check_and_trip",
    "is_tripped",
    "get_state",
    "reset",
]
