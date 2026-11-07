"""Idle becomes a ping (019 AC6 / Flow C).

``factory/chain/idle.py`` (deleted 2026-08-07, 019 AC5) detected a drained app
and rotated through scanner personas to manufacture more work — it fired 957
times and reached a human zero times. This module replaces that whole shape:
when an app has no dispatchable work and no live human-filed direction, it
writes exactly ONE deduplicated ``operator_ping`` per **idle episode** and
files NO machine-authored direction. The operator decides what happens next
(file a direction, or ignore it).

Idle episode, precisely
------------------------
An idle episode STARTS the first tick where both hold:

  * zero dispatchable stories: ``factory.chain.handlers.stories_in_flight``
    returns an empty list for the app AFTER subtracting every story parked
    in a PERMANENT-park sink (``factory.directions.tracker_issue.
    _story_is_resolved`` — deployed/superseded/closed/closed_by_operator/
    blocked_ci_unresolved/blocked_dependency_unmet/quarantined_invalid_state,
    with the dependency-cap carve-out that predicate already encodes). Without
    this subtraction, ONE story permanently parked in e.g.
    ``blocked_ci_unresolved`` (absent from ``stories_in_flight``'s own,
    narrower terminal set — see the note below) makes the app read as
    "in flight" forever, silencing every future ping. See the note below on
    why ``stories_in_flight``, not ``factory_status._TERMINAL_STATES``, is
    the base source.
  * zero LIVE human-filed directions (see ``_has_live_human_direction``).

The episode ENDS the first tick where either condition flips: a story gets
dispatched/advanced (the filtered ``in_flight`` becomes non-empty) or a human
files a new direction (or an existing one is still pending). Ending the
episode is entirely implicit — the next non-idle tick simply finds no reason
to ping and clears the persisted marker; there is no separate "work happened"
timestamp to track, because the in-flight computation and the human-direction
scan are themselves fresh, authoritative reads of "has anything happened"
every single tick.

Exactly ONE operator ping is written per episode: the FIRST idle tick writes
the marker; every subsequent idle tick, while the marker is still present, is
a no-op for the marker/ping. A second episode (idle -> work -> idle again)
gets a second ping. The ``app_idle`` EVENT is a different signal with a
different cadence — see "Two signals, two cadences" below.

Two signals, two cadences
--------------------------
``app_idle`` (the event, on ``state/events/idle.ndjson``) and the operator
ping (the marker + ``factory inbox`` entry) look related but answer different
questions, and conflating them was a real bug (found in a 019 fail-silent
audit, corrected here — see ``STATUS.md``):

  * The operator ping answers "has a HUMAN been notified about this episode
    yet" — deduplicated once per episode, because notifying the same human
    of the same ongoing silence every tick is the 957-fires-zero-humans
    failure mode this module exists to end.
  * ``app_idle`` answers "is the tick loop ALIVE and does it currently judge
    this app idle" — a liveness heartbeat
    ``factory.manager.detectors.stalled_stories`` consumes with a 30-minute
    freshness window (``idle_recently`` / ``healthy_drain``). A heartbeat
    that fires once and then goes quiet for the rest of a multi-hour episode
    reads as "not idle recently" to that consumer well before the episode
    actually ends — exactly backwards. So ``app_idle`` fires on EVERY idle
    tick, not once per episode; only the ping is deduplicated.

Why ``stories_in_flight``, not ``factory_status._TERMINAL_STATES``
--------------------------------------------------------------------
The deleted ``idle.py::_stories_in_flight`` counted stories using
``factory_status._TERMINAL_STATES``, which additionally treats
``blocked_review_nonconvergent`` and ``blocked_underspecified`` as terminal
(so those stories did NOT count as "in flight" -> the app could read as idle
even while a story sat in one of those states). ``factory.chain.handlers.
stories_in_flight`` is narrower: it is the literal list
``factory.chain.orchestrator.tick`` iterates to decide what to dispatch this
tick (see ``orchestrator.tick``'s ``stories = H.stories_in_flight(app, db)``
call). Using it here means "dispatchable work" in the ping can never disagree
with what the tick itself just did or didn't do — a re-derived terminal-state
set is exactly the kind of drift-prone duplication that caused silent-
detection-failure bugs elsewhere in this codebase. The tradeoff: an app whose
only story sits in ``blocked_review_nonconvergent`` / ``blocked_underspecified``
will NOT be pinged as idle here (those states are absent from ``handlers.
stories_in_flight``'s terminal set, so the story still counts as "in flight").
That story is not silently lost, though — it already surfaces via
``factory inbox``'s "Needs human action" table and ``factory why``.

Fail-safe direction: toward silence, not noise
-------------------------------------------------
This whole module exists because a detector that fires constantly and is
never acted on is worse than one that occasionally stays quiet a tick too
long. So every ambiguous case here resolves to "don't ping":

  * Ping-state file missing -> no active episode (normal case).
  * Ping-state file present and parses -> already pinged this episode,
    stay quiet.
  * Ping-state file present but UNREADABLE/CORRUPT (bad JSON, wrong shape)
    -> SELF-HEALED: overwritten with a valid, deliberately-suppressed marker
    (never a guessed fresh ping — we don't know if this is a continuing
    episode), and the read failure is surfaced as an error the caller can
    record exactly ONCE (never silently swallowed, and — since the marker is
    now valid — never spammed on every subsequent tick either). Before this
    fix the corrupt-marker path never repaired the file, so the same error
    recurred every tick forever; ``orchestrator.tick`` appends every
    ``.error`` to ``summary.errors``, and ``factory tick``'s CLI exits 1
    whenever that list is non-empty, so one bad marker turned into a
    permanent ``factory-tick@.service`` crash-loop.
  * Cannot determine whether a live human direction exists (DB/parse error)
    -> assume one exists, i.e. do not ping this tick.

A write failure when *setting* the marker is best-effort (mirrors the
``idle_generator.json`` / issue-hygiene-marker precedent elsewhere in the
chain): the ``app_idle`` event still fires so ``stalled_stories``' consumer
keeps working, but a persistently failing filesystem could theoretically
re-ping on the next tick. That residual risk is accepted here exactly as it
is for the pre-existing markers this module's persistence follows.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast


@dataclass
class IdlePingResult:
    """Outcome of one idle-ping evaluation for a single app."""

    fired: bool
    reason: str = ""
    idle_since: str | None = None
    last_delivered_unit: str | None = None
    error: str | None = None


def _ping_state_dir(software_factory_root: Path) -> Path:
    return Path(software_factory_root) / "state" / "idle_ping"


def _ping_state_path(software_factory_root: Path, app: str) -> Path:
    return _ping_state_dir(software_factory_root) / f"{app}.json"


def _load_ping_state(software_factory_root: Path, app: str) -> tuple[dict[str, Any] | None, str | None]:
    """Read the per-app ping marker.

    Returns ``(state, None)`` when no marker exists (no active episode) or
    the marker was read and parsed fine. Returns ``(None, error)`` when the
    marker EXISTS but is unreadable/malformed — the caller (S8 self-heal)
    treats this tick as "already pinged" (suppress the ping, never a guessed
    fresh one) and then OVERWRITES the marker with a valid one, so the SAME
    error is never returned twice in a row.
    """
    path = _ping_state_path(software_factory_root, app)
    if not path.exists():
        return None, None
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"idle_ping state unreadable for app={app}: {exc!r}"
    if not isinstance(data, dict) or not isinstance(data.get("idle_since"), str):
        return None, f"idle_ping state malformed for app={app}"
    return data, None


def _write_ping_state(
    software_factory_root: Path,
    app: str,
    *,
    idle_since: str,
    pinged_at: str,
    last_delivered_unit: str | None,
) -> None:
    """Persist the marker. Best-effort — never raises."""
    path = _ping_state_path(software_factory_root, app)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "idle_since": idle_since,
                    "pinged_at": pinged_at,
                    "last_delivered_unit": last_delivered_unit,
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
    except OSError:
        return


def _clear_ping_state(software_factory_root: Path, app: str) -> None:
    """Delete the marker (the idle episode ended). Best-effort."""
    path = _ping_state_path(software_factory_root, app)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return


def _last_delivered_unit(app: str, db_path: Path) -> str | None:
    """Return a short human-readable tag for the most recently touched story.

    "Last delivered unit" is shown in ``factory inbox`` so an operator who
    sees a ping has SOME context on what the factory was last doing before it
    went quiet, without needing to run ``factory queue``. Not restricted to
    terminal/deployed stories: any story's most recent ``updated_at`` is a
    reasonable proxy for "the last thing that happened", and an app that has
    never had a story yet correctly returns ``None``.
    """
    from sqlmodel import Session, select

    from factory.chain.handlers import _engine
    from factory.chain.state_machine import StoryRecord

    try:
        eng = _engine(db_path)
        with Session(eng) as session:
            rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    except Exception:  # noqa: BLE001 - a DB hiccup must never crash the ping
        return None
    if not rows:
        return None
    newest = max(rows, key=lambda r: (r.updated_at or "", r.id or 0))
    return f"{newest.slug} ({newest.state})"


def _has_live_human_direction(app: str, software_factory_root: Path, db_path: Path) -> bool:
    """True when a human-filed direction is still pending triage/decomposition.

    "Live" = status in ``PENDING_STATUSES`` (``created`` / ``needs-direction``)
    AND ``source`` resolves to one of ``approval._HUMAN_SOURCE_PREFIXES``
    (operator/cli/user/human), resolved DB-first exactly the way the
    operator-approval gate resolves it (``watcher.pending_directions`` already
    applies ``hydrate_direction_source`` before returning). A direction that
    has been pm-validated into stories is NOT re-checked here — if it still
    has stories in flight, rule 1 (``stories_in_flight``) already covers it;
    if it doesn't, it isn't "live" work waiting on anyone.

    Fail-safe: any lookup failure (missing DB, parse error) returns True —
    "assume a human direction exists" — so the ambiguous case never fires a
    ping, matching this module's fail-toward-silence design.
    """
    from factory.directions.approval import _HUMAN_SOURCE_PREFIXES, direction_source
    from factory.directions.watcher import pending_directions

    try:
        pendings = pending_directions(app, software_factory_root, db_path)
    except Exception:  # noqa: BLE001 - fail-safe: assume live human work exists
        return True
    for d in pendings:
        if direction_source(d).startswith(_HUMAN_SOURCE_PREFIXES):
            return True
    return False


def run_idle_ping_tick(
    software_factory_root: Path,
    app: str,
    db_path: Path,
    *,
    now: datetime | None = None,
) -> IdlePingResult:
    """Evaluate idle state for ``app``; fire the liveness event every idle
    tick and the deduplicated operator ping at most once per episode.

    Caller contract: this function NEVER files a direction. It touches the
    ``idle_ping`` marker (deduplicating the OPERATOR ping, once per episode)
    and the ``app_idle`` event stream (S9: emitted on EVERY idle tick — a
    load-bearing liveness signal ``stalled_stories.idle_recently`` /
    ``healthy_drain`` consumes with a 30-minute freshness window, NOT the
    same thing as the deduplicated ping). It is safe to call every tick.
    """
    from factory.chain.handlers import stories_in_flight
    from factory.directions.tracker_issue import _story_is_resolved
    from factory.manager.signals import write_event

    root = Path(software_factory_root)
    moment = now or datetime.now(UTC)

    state, corrupt_error = _load_ping_state(root, app)
    if corrupt_error is not None:
        # S8 self-heal: a corrupt/malformed marker used to return here EVERY
        # tick forever — never repaired, never re-checked — which (a)
        # suppressed the ping forever on this app and (b) appended an
        # "idle-ping" entry to ``summary.errors`` on every single tick.
        # ``factory tick``'s CLI (cli.py) raises ``typer.Exit(1)`` whenever
        # ``summary.errors`` is non-empty, so one bad marker turned into a
        # PERMANENT ``factory-tick@.service`` crash-loop (Result=exit-code on
        # every run, carrying no new information after the first). Repair it
        # now: overwrite with a valid, deliberately SUPPRESSED marker (we
        # don't know whether this is a continuing episode or a fresh one, so
        # we never guess a fresh ping) and surface the failure exactly ONCE
        # — this tick's ``.error`` — never again once the marker is clean.
        idle_since = moment.isoformat()
        _write_ping_state(
            root,
            app,
            idle_since=idle_since,
            pinged_at=idle_since,
            last_delivered_unit=_last_delivered_unit(app, db_path),
        )
        return IdlePingResult(
            fired=False,
            reason="corrupt_state_repaired",
            idle_since=idle_since,
            error=corrupt_error,
        )

    # S8: subtract the PERMANENT-park sinks before the emptiness test.
    # ``stories_in_flight``'s own terminal set (see its docstring) is
    # narrower than the resolved-states allowlist used elsewhere (it
    # deliberately keeps ``blocked_review_nonconvergent`` /
    # ``blocked_underspecified`` "in flight" so they stay visible to the
    # dispatcher's own bookkeeping) — but it OMITS ``blocked_ci_unresolved``,
    # ``blocked_dependency_unmet`` and the other permanent sinks
    # ``_story_is_resolved`` treats as done. One story parked in any of those
    # made ``in_flight`` permanently non-empty, so the app could NEVER be
    # judged idle again — a single dead story silencing every future ping.
    in_flight = [s for s in stories_in_flight(app, db_path) if not _story_is_resolved(s)]
    idle_now = not in_flight and not _has_live_human_direction(app, root, db_path)

    if not idle_now:
        if state is not None:
            _clear_ping_state(root, app)
        return IdlePingResult(fired=False, reason="not_idle")

    # S9: emit ``app_idle`` on EVERY idle tick (restoring the pre-AC5
    # contract the deleted ``idle.py`` writer had), decoupled from the
    # once-per-episode operator ping below. ``stalled_stories.idle_recently``
    # requires an ``app_idle`` within 30 minutes; the once-per-EPISODE
    # writer this module shipped with (#252) could go stale mid-episode
    # (measured live: last emission 03:24, next tick's read at 04:22 — 55
    # min stale — ``healthy_drain`` false for the whole window). The two
    # signals are genuinely different (a continuous liveness heartbeat vs. a
    # deduplicated human-facing notification) and conflating them was the
    # bug.
    # ``state["idle_since"]`` is validated as a ``str`` by ``_load_ping_state``
    # whenever ``state`` is not None; the cast just tells mypy what that
    # validation already guarantees.
    idle_since = cast(str, state["idle_since"]) if state is not None else moment.isoformat()
    last_unit = _last_delivered_unit(app, db_path)
    # S8: emit the event BEFORE writing/touching the marker below — a crash
    # between the two used to lose the episode's ``app_idle`` silently
    # (marker written, event never emitted, no retry because the marker now
    # reads "already pinged").
    write_event(
        "idle",
        {
            "event": "app_idle",
            "app": app,
            "idle_since": idle_since,
            "last_delivered_unit": last_unit,
        },
        software_factory_root=root,
    )

    if state is not None:
        # Already pinged for this episode — no NEW operator ping, but
        # ``app_idle`` above still fired this tick (S9).
        return IdlePingResult(
            fired=False,
            reason="already_pinged",
            idle_since=state.get("idle_since"),
            last_delivered_unit=state.get("last_delivered_unit"),
        )

    # First idle tick of a NEW episode — fire the deduplicated operator ping.
    pinged_at = moment.isoformat()
    _write_ping_state(
        root, app, idle_since=idle_since, pinged_at=pinged_at, last_delivered_unit=last_unit
    )
    return IdlePingResult(
        fired=True, reason="pinged", idle_since=idle_since, last_delivered_unit=last_unit
    )


def active_pings(software_factory_root: Path, apps: list[str]) -> list[dict[str, Any]]:
    """Return ``{"app", "idle_since", "last_delivered_unit"}`` for every app
    currently carrying an active (already-pinged) idle episode marker.

    Used by ``factory inbox``. Tolerant per-app: a corrupt marker for one app
    is skipped rather than hiding every other app's ping (mirrors the
    per-section try/except style the rest of ``inbox_cmd`` already uses).
    """
    root = Path(software_factory_root)
    out: list[dict[str, Any]] = []
    for app in apps:
        state, error = _load_ping_state(root, app)
        if error is not None or state is None:
            continue
        out.append(
            {
                "app": app,
                "idle_since": state.get("idle_since"),
                "last_delivered_unit": state.get("last_delivered_unit"),
            }
        )
    return out
