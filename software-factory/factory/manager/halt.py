"""factory.manager.halt — Halt authority for the factory (Phase 7).

Only the L3 Diagnostician may *request* a halt (via ``request_halt``).
Only a human operator may *clear* a halt (via ``clear_halt``).
The driver loop and ``tick()`` each call ``is_halted`` before dispatching.

OPERATOR-ONLY MODULE
--------------------
This file MUST NOT be invoked by any LLM pathway.  It is in the
``factory/manager/*.py`` forbidden class and will never be auto-applied
by the L4 pipeline.  ``clear_halt`` in particular must only be called by
``factory resume`` (a CLI command requiring human interaction).
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from pathlib import Path  # noqa: E402

# Schema version for the halt state file.
_SCHEMA_VERSION = 1

# Bounded retry for reading the halt file. A halt exists precisely to STOP the
# factory, so a read/parse failure must not silently be treated as "not
# halted". We retry a few times with a tiny backoff to ride out a transient FS
# glitch (a half-written file mid-flush, a momentary EIO) before concluding.
_HALT_READ_RETRIES = 3
_HALT_READ_BACKOFF_S = 0.05

# Standard filename for the halt mode state.
_HALT_FILE = "factory_mode.json"

# Standard filename for the halt history archive.
_HALT_HISTORY_FILE = ".halt_history.json"

# Grace window after an operator clears a halt during which the manager may
# NOT re-halt. An operator resume is an explicit override; stall-class
# concerns (e.g. "no ticks for N minutes") can only clear AFTER the resume
# lets the orchestrator run again, so an immediate re-halt deadlocks the
# factory against its own manager: halt blocks ticks -> tick gap grows ->
# re-halt. Observed live 2026-06-11: L3 re-halted 94 seconds after an
# operator resume, before the first post-resume tick could land.
_RESUME_GRACE_MINUTES = 30


def _halt_path(root: Path) -> Path:
    return root / "state" / _HALT_FILE


def _history_path(root: Path) -> Path:
    return root / "state" / _HALT_HISTORY_FILE


def request_halt(
    *,
    root: Path,
    concern_title: str,
    proposal_path: str | None,
    reason: str,
) -> Path | None:
    """Write the halt mode file.

    Idempotent — if halt is already set, append the old state to the
    history archive and overwrite with the new halt (most recent wins).

    Returns the path to the halt state file, or ``None`` when the halt was
    suppressed because an operator cleared a halt less than
    ``_RESUME_GRACE_MINUTES`` ago (the factory gets that window to
    demonstrate liveness before the manager may halt it again).

    Parameters
    ----------
    root:
        Factory root directory.
    concern_title:
        The L3 concern title that triggered this halt request.
    proposal_path:
        Absolute path (as str) to the proposal file that carried the
        halt request.  May be None when called from tests or tooling.
    reason:
        Free-text justification from the L3 proposal's ``halt_reason``
        field.
    """
    root = Path(root)
    halt_path = _halt_path(root)

    # Operator-resume grace: a recent manual clear overrides halt authority.
    last_cleared = _last_operator_clear_at(root)
    if last_cleared is not None:
        age_s = (datetime.now(UTC) - last_cleared).total_seconds()
        if age_s < _RESUME_GRACE_MINUTES * 60:
            return None

    # If halt already set, archive the previous state before overwriting.
    if halt_path.exists():
        try:
            old_state = json.loads(halt_path.read_text(encoding="utf-8"))
            _append_history(root, old_state)
        except (OSError, json.JSONDecodeError):
            pass

    state: dict = {
        "schema_version": _SCHEMA_VERSION,
        "mode": "halted",
        "set_at": datetime.now(UTC).isoformat(),
        "set_by": "manager_diagnostician",
        "concern_title": concern_title,
        "proposal_path": proposal_path,
        "reason": reason,
    }

    halt_path.parent.mkdir(parents=True, exist_ok=True)
    halt_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    return halt_path


def is_halted(*, root: Path) -> bool:
    """Return True if the factory should be treated as halted.

    Fail-SAFE semantics
    -------------------
    * No halt file          → not halted (normal running state).
    * Valid file, mode set  → honour ``mode == "halted"``.
    * File present but the contents cannot be read/parsed after a bounded
      retry → **treat as halted** and emit a CRITICAL alert.

    The last rule is the important one. Historically this path returned
    ``False`` (fail-OPEN): a corrupt/unreadable halt file made the factory
    treat itself as NOT halted and keep dispatching — silently ignoring the
    very halt that was meant to stop it. That is the single most dangerous
    failure this module can have.

    Tradeoff: a *persistent* read error over-halts the factory. That is
    acceptable because a visible over-halt is fully recoverable — an operator
    sees the alert and clears it with ``factory resume`` (``clear_halt`` is
    tolerant of a corrupt file for exactly this reason) — whereas a silently
    ignored halt is not recoverable and defeats the control plane. The bounded
    retry keeps a mere transient FS blip from wedging the factory.
    """
    root = Path(root)
    p = _halt_path(root)
    if not p.exists():
        return False
    last_exc: Exception | None = None
    for attempt in range(_HALT_READ_RETRIES):
        try:
            state = json.loads(p.read_text(encoding="utf-8"))
            return state.get("mode") == "halted"
        except (OSError, json.JSONDecodeError) as exc:
            last_exc = exc
            if attempt < _HALT_READ_RETRIES - 1:
                time.sleep(_HALT_READ_BACKOFF_S)
    # Every read failed. Fail SAFE (halted) and make it unmistakable.
    _alert_halt_unreadable(root, p, last_exc)
    return True


def get_halt_state(*, root: Path) -> dict | None:
    """Return the halt state dict or None if not halted.

    Uses the same bounded retry as :func:`is_halted`. Returns ``None`` only
    when the file is genuinely absent or a valid file has a non-halted mode.
    If the file is present but unreadable after retries, returns a synthetic
    ``mode="halted"`` state so callers that display the halt reason stay
    consistent with :func:`is_halted` (which fail-safes to halted).
    """
    root = Path(root)
    p = _halt_path(root)
    if not p.exists():
        return None
    last_exc: Exception | None = None
    for attempt in range(_HALT_READ_RETRIES):
        try:
            state = json.loads(p.read_text(encoding="utf-8"))
            if state.get("mode") == "halted":
                return state
            return None
        except (OSError, json.JSONDecodeError) as exc:
            last_exc = exc
            if attempt < _HALT_READ_RETRIES - 1:
                time.sleep(_HALT_READ_BACKOFF_S)
    _alert_halt_unreadable(root, p, last_exc)
    return {
        "mode": "halted",
        "reason": "halt file present but unreadable/corrupt (fail-safe halt)",
        "set_by": "fail_safe",
    }


def clear_halt(
    *,
    root: Path,
    cleared_by: str = "operator",
    reason: str | None = None,
) -> dict:
    """Clear the halt mode.

    Moves the current halt state to ``state/.halt_history.json`` and
    removes (or resets) ``state/factory_mode.json``.

    OPERATOR-ONLY — must never be called by any LLM path.

    Parameters
    ----------
    root:
        Factory root directory.
    cleared_by:
        Who cleared the halt.  Defaults to "operator".
    reason:
        Optional free-text reason for clearing.

    Returns
    -------
    dict
        The archived halt state (with ``cleared_at``, ``cleared_by``,
        ``clear_reason`` added).

    Raises
    ------
    FileNotFoundError
        If there is no active halt to clear.
    """
    root = Path(root)
    halt_path = _halt_path(root)

    if not halt_path.exists():
        raise FileNotFoundError(
            f"No halt state file found at {halt_path}; nothing to clear."
        )

    # Read the current halt state, tolerating a corrupt/unreadable file. This
    # is essential: is_halted() fail-safes to *halted* on a corrupt file, so an
    # operator MUST still be able to clear that halt with `factory resume`. If
    # we raised here on a parse error, a corrupt halt file would wedge the
    # factory permanently — the exact deadlock the fail-safe posture must avoid.
    try:
        state = json.loads(halt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        state = {
            "mode": "halted",
            "reason": "halt file unreadable/corrupt at clear time",
            "corrupt_read_error": repr(exc),
        }
    if not isinstance(state, dict):
        state = {"mode": "halted", "reason": "halt file had non-object contents"}
    if state.get("mode") != "halted":
        raise ValueError(
            f"factory_mode.json exists but mode={state.get('mode')!r} (not 'halted'); "
            "nothing to clear."
        )

    # Annotate the archived entry with clearance metadata.
    archived = dict(state)
    archived["cleared_at"] = datetime.now(UTC).isoformat()
    archived["cleared_by"] = cleared_by
    if reason is not None:
        archived["clear_reason"] = reason

    _append_history(root, archived)

    # Remove the halt file so is_halted() returns False.
    halt_path.unlink()

    return archived


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _alert_halt_unreadable(root: Path, path: Path, exc: Exception | None) -> None:
    """Emit a CRITICAL, visible alert that the halt file could not be read.

    Best-effort: alerting must never itself raise out of the halt check. The
    fail-safe decision (treat as halted) does not depend on this succeeding.
    """
    try:
        from factory.manager.signals import write_alert_event

        write_alert_event(
            "halt_unreadable",
            f"halt file present but unreadable/corrupt after "
            f"{_HALT_READ_RETRIES} attempts; failing SAFE (treating factory as "
            f"HALTED). Clear with `factory resume` once the file is fixed.",
            severity="critical",
            software_factory_root=root,
            halt_path=str(path),
            read_error=repr(exc) if exc is not None else None,
        )
    except Exception:  # noqa: BLE001 - alerting is best-effort; never raise here
        import sys as _sys

        print(
            f"[halt] CRITICAL: halt file {path} unreadable and alert emit failed: {exc!r}",
            file=_sys.stderr,
        )


def _last_operator_clear_at(root: Path) -> datetime | None:
    """Return when an operator last cleared a halt, or None.

    Scans the history archive newest-first for an entry carrying
    ``cleared_at`` (only ``clear_halt`` writes that field; entries archived
    by ``request_halt`` overwrites do not).
    """
    history_path = _history_path(root)
    if not history_path.exists():
        return None
    try:
        data = json.loads(history_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, list):
        return None
    for entry in reversed(data):
        if isinstance(entry, dict) and entry.get("cleared_at"):
            try:
                return datetime.fromisoformat(entry["cleared_at"])
            except (TypeError, ValueError):
                return None
    return None


def _append_history(root: Path, entry: dict) -> None:
    """Append ``entry`` to the halt history archive."""
    history_path = _history_path(root)
    history: list[dict] = []
    if history_path.exists():
        try:
            data = json.loads(history_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                history = data
        except (OSError, json.JSONDecodeError):
            pass
    history.append(entry)
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(history, indent=2), encoding="utf-8")


__all__ = [
    "request_halt",
    "is_halted",
    "get_halt_state",
    "clear_halt",
]
