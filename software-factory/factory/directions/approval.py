"""Operator-approval gate for machine-filed directions.

The treadmill this closes
-------------------------
A scheduled scanner persona (``security``, ``ux_auditor``) can file its own
work orders: every run it looks for
something to complain about, and it always finds something. On 2026-07-24 the
UX auditor filed D114/115/116 in ~2h (~$145 projected EOD spend); on
2026-07-30 it filed 015/016/017 — every one of them asking for *better inputs
for the auditor itself* — and ``auto_pm_sync`` triaged them into stories
WITHOUT an operator ever seeing them. Four PRs (#165/#166/#167/#169) had to be
closed by hand.

Throttling the schedule only slows the treadmill down; the structural fix is
that **a direction the factory filed for itself must not reach the build
pipeline until a human says yes.** This module is that predicate, and
``factory.chain.pm_sync`` (the single door from direction → stories) enforces
it.

Fail-safe by construction
-------------------------
The rule is an ALLOWLIST of sources that may auto-build, not a denylist of
scanner personas:

* human-filed (``operator*``, ``cli*``, ``user*``, ``human*``) → auto-builds,
  exactly as before. The human path is not slowed down at all.
* delegated-human (exactly ``pa``, the personal assistant, which only files
  what its human already approved) → auto-builds. See
  ``_DELEGATED_HUMAN_SOURCES``.
* deterministic, externally-triggered detectors (``ci-health``,
  ``flake-quarantine``, ``github``/``github_issue`` intake of a *user-filed*
  issue) → auto-builds. These are not opinions: a required check went red, a
  test flaked, a person opened an issue.
* everything else — every ``scheduled-<persona>`` source, any future
  machine filer, **and any direction whose source cannot be determined**
  (missing/corrupt ``state.yaml``) → requires an explicit operator approval.

Approval is recorded in the direction's ``state.yaml`` under
``operator_approval`` (the same file that already carries ``source``,
``status`` and the ``audit`` trail), so it is human-readable, human-editable
and survives a restart. ``factory approve-direction`` is the supported way to
write it; ``factory inbox`` lists everything still waiting.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from factory.directions.parser import Direction

#: ``state.yaml`` key holding the approval record.
APPROVAL_KEY = "operator_approval"

#: Source prefix used by every cron-scheduled persona (see
#: ``factory.chain.scheduled_tasks``). Directions carrying it are exactly the
#: self-filed work orders this gate exists to stop.
SCHEDULED_SOURCE_PREFIX = "scheduled-"

#: Sources whose *family* is a human. Prefix-matched because operators tag
#: free-form suffixes in practice (``operator-loop3``, ``cli-tell``, …).
_HUMAN_SOURCE_PREFIXES: tuple[str, ...] = ("operator", "cli", "user", "human")

#: Sources that act for a human by DELEGATION. Exact match, deliberately.
#:
#: ``pa`` is the personal assistant (``factory job submit --source pa``, see
#: ``docs/JOBS-API.md``). It is not a scanner persona with opinions about what
#: the factory should build next: the PA only submits a job after the human
#: approved that exact plan in the PA's own approval step, so its filing IS
#: operator intent, relayed. Treating it as machine-filed would make every
#: PA job sit in ``factory inbox`` waiting for a second, redundant yes.
#: ``factory job submit`` additionally writes a signed ``operator_approval``
#: record for ``pa`` and ``human`` jobs only (any other ``--source`` waits for
#: approval like any machine filer); this allowlist entry is what keeps a
#: PA job buildable even if that ``state.yaml`` record is lost and only the
#: ``directions`` row's ``source`` survives (D018: ``state.yaml`` is gitignored).
_DELEGATED_HUMAN_SOURCES: frozenset[str] = frozenset({"pa"})

#: Non-human sources that may still auto-build: deterministic detectors whose
#: trigger is an objective external fact, not an LLM's opinion about what the
#: factory should work on next. Exact match — a new machine filer must be
#: added here deliberately, and until it is, it needs operator approval.
_DETERMINISTIC_SOURCES: frozenset[str] = frozenset(
    {
        "ci-health",  # a REQUIRED check went red on main (D004)
        "flake-quarantine",  # a test was observed flaking
        "github",  # webhook intake of a human-filed issue
        "github_issue",  # `factory ingest-issue` of a human-filed issue
    }
)

#: Statuses at which a direction is still waiting to enter the pipeline. Only
#: these can be "awaiting approval" — an already-triaged direction is past
#: this gate.
PENDING_STATUSES: frozenset[str] = frozenset({"created", "needs-direction"})


def direction_source(direction: Direction) -> str:
    """Return the recorded ``source`` for ``direction``, or ``""`` when unknown.

    Reads ``direction.state``, i.e. the ``state.yaml`` projection. That file is
    gitignored (D018), so callers that want the AUTHORITATIVE value must resolve
    it from the ``directions`` row first — see
    :func:`factory.directions.watcher.hydrate_direction_source`, which
    ``pending_directions`` (and therefore the pm-sync gate) applies before this
    predicate ever runs.

    Reading the file alone was the whole of the outage: D012 gave the table no
    ``source`` column, D018 stopped tracking the file, and this gate's
    "unknown ⇒ park" fail-safe then parked EVERY direction as soon as an operator
    followed the documented ``directions-regenerate-state`` recovery path.

    A genuinely unknown source still yields ``""`` — which
    :func:`requires_operator_approval` treats as "needs a human", never as
    "safe to build".
    """
    state = direction.state or {}
    if not isinstance(state, dict):
        return ""
    raw = state.get("source")
    return str(raw).strip() if raw not in (None, "") else ""


def is_scheduled_persona_source(source: str) -> bool:
    """True when ``source`` names a cron-scheduled persona (``scheduled-*``)."""
    return source.startswith(SCHEDULED_SOURCE_PREFIX)


def requires_operator_approval(direction: Direction) -> bool:
    """True when ``direction`` may not be auto-triaged without an operator.

    Allowlist semantics (see the module docstring): only a human-filed source
    or a known deterministic detector auto-builds. Anything else — including
    an unresolvable source — requires approval.
    """
    source = direction_source(direction)
    if not source:
        # Fail SAFE: we cannot prove a human asked for this.
        return True
    if source.startswith(_HUMAN_SOURCE_PREFIXES):
        return False
    if source in _DELEGATED_HUMAN_SOURCES:
        return False
    if source in _DETERMINISTIC_SOURCES:
        return False
    return True


def approval_record(direction: Direction) -> dict[str, Any] | None:
    """Return the ``operator_approval`` block from ``state.yaml``, if valid."""
    state = direction.state or {}
    if not isinstance(state, dict):
        return None
    record = state.get(APPROVAL_KEY)
    if isinstance(record, dict):
        return record
    return None


def is_operator_approved(direction: Direction) -> bool:
    """True when an operator explicitly approved this direction.

    Requires ``operator_approval.approved is True`` (exactly ``True``, not a
    truthy string) AND a non-empty ``approved_by``: an approval nobody signed
    is not an approval.
    """
    record = approval_record(direction)
    if record is None:
        return False
    if record.get("approved") is not True:
        return False
    return bool(str(record.get("approved_by") or "").strip())


def is_auto_buildable(direction: Direction) -> bool:
    """True when the chain may triage ``direction`` without a human.

    The single predicate ``pm_sync`` gates on.
    """
    if not requires_operator_approval(direction):
        return True
    return is_operator_approved(direction)


def awaiting_operator_approval(direction: Direction) -> bool:
    """True when ``direction`` is parked at this gate and needs an operator.

    Narrower than ``not is_auto_buildable``: only directions still at a
    pending status (``created`` / ``needs-direction``) are *waiting* — a
    closed or already-validated one is not in the operator's inbox.
    """
    if direction.status not in PENDING_STATUSES:
        return False
    return not is_auto_buildable(direction)


def approval_blocked_reason(direction: Direction) -> str:
    """Short, operator-facing reason this direction is parked at the gate."""
    source = direction_source(direction)
    if not source:
        return "source unknown (fail-safe: treated as machine-filed)"
    if is_scheduled_persona_source(source):
        persona = source[len(SCHEDULED_SOURCE_PREFIX) :] or "?"
        return f"auto-filed by scheduled persona '{persona}'"
    return f"machine-filed (source={source})"


def approve_direction(
    direction: Direction,
    *,
    by: str,
    note: str | None = None,
    now: datetime | None = None,
    acknowledged_shipped_routes: list[str] | None = None,
) -> dict[str, Any]:
    """Record an operator approval on ``direction`` and return the record.

    Writes the ``operator_approval`` block plus an audit entry into
    ``state.yaml`` via ``watcher.merge_state`` (which also refreshes
    ``direction.state`` in memory). Raises ``ValueError`` when ``by`` is
    empty — an unsigned approval is not an approval.
    """
    signer = (by or "").strip()
    if not signer:
        raise ValueError("approve_direction requires a non-empty 'by' (who approved)")

    # Imported here (not at module import) to keep this module dependency-light
    # for the pure predicates above.
    from factory.directions.watcher import _read_state_yaml, merge_state

    ts = (now or datetime.now(UTC)).isoformat()
    record: dict[str, Any] = {
        "approved": True,
        "approved_by": signer,
        "approved_at": ts,
    }
    if note:
        record["note"] = note
    if acknowledged_shipped_routes:
        # The routes ``factory.directions.route_premise`` said this direction
        # asks for although they already exist, which the operator overrode.
        # Recorded because the note is otherwise the only trace of why, and a
        # duplicate approved on purpose must be distinguishable from one nobody
        # looked at (memory: stale_context_doc_refiles_shipped_work).
        record["acknowledged_shipped_routes"] = list(acknowledged_shipped_routes)

    # Append to the audit trail as it is ON DISK, not as it was when this
    # Direction was parsed: ``merge_state`` merges into the current file, so
    # writing a stale list back would silently drop entries added in between.
    on_disk = _read_state_yaml(direction.dir_path / "state.yaml")
    audit = on_disk.get("audit")
    audit = list(audit) if isinstance(audit, list) else []
    audit.append(
        {
            "ts": ts,
            "by": signer,
            "event": "operator_approved",
            "details": {"note": note} if note else {},
        }
    )
    merge_state(direction, {APPROVAL_KEY: record, "audit": audit})
    return record


__all__ = [
    "APPROVAL_KEY",
    "PENDING_STATUSES",
    "SCHEDULED_SOURCE_PREFIX",
    "approval_blocked_reason",
    "approval_record",
    "approve_direction",
    "awaiting_operator_approval",
    "direction_source",
    "is_auto_buildable",
    "is_operator_approved",
    "is_scheduled_persona_source",
    "requires_operator_approval",
]
