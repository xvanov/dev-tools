"""Detector: stalled_stories — surface ABSOLUTE liveness, not event deltas.

This detector exists to close the monitoring blind spot that let the factory
sit silently stuck for hours: every other detector reads a short rolling
*event window* (``since`` = ~last minute), so when the chain stalls it stops
emitting events, the window goes empty, and the watcher reports "quiet,
healthy." Silence was read as health.

``stalled_stories`` ignores the window entirely. It reads the CURRENT story
state straight from ``state/factory.db`` and the timestamp of the last tick
from ``state/events/ticks.ndjson``, and measures ages relative to ``now``. A
stuck factory produces no events but its DB rows keep aging — so this fires
exactly when the others go blind.

It surfaces three independent liveness signals; the calling L1 agent should
treat a non-empty ``alarms`` list as escalate-worthy:

  * ``stuck_in_progress`` — a story sat in a ``*_in_progress`` state longer
    than ``in_progress_stall_minutes``. A handler was dispatched and never
    returned (process killed mid-run, hang, dirty-tree race, uncaught
    exception). The chain's own stale-recovery may eventually reclaim it, but
    a growing count here means dispatch is wedged.
  * ``stalled`` — a non-terminal, non-deployed story hasn't changed state in
    ``stall_minutes``. Forward progress has stopped for that story.
  * ``no_tick_recently`` — the orchestrator hasn't ticked in
    ``tick_silence_minutes``. The drive loop is likely dead; nothing is being
    dispatched at all.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

# States the chain never advances out of — aging in these is expected and fine.
_TERMINAL_STATES = frozenset(
    {
        "deployed",
        "blocked_tests_need_clarification",
        "blocked_deploy_failed",
        "blocked_review_nonconvergent",
        # Dev-declared underspecification is a terminal, human-pending sink by
        # design — aging in it is the intended behaviour, not a stall to
        # escalate (same rationale as the four sinks around it).
        "blocked_underspecified",
        # A dual-draft loser is an intentional terminal sink (its winning
        # sibling shipped) — aging here is expected, never a stall to escalate.
        "superseded_by_sibling",
        # Budget-exhausted stories are also terminal; their absence here made
        # the stalled-story detector re-alarm on them forever (concern-spam).
        "blocked_budget_exceeded",
        # Operator-closed sink — aging here is the intended end state, not a stall.
        "closed_by_operator",
        # Dependency-deferral CAP park (a blocked foundation can't idle its
        # dependents forever, so the capped dependent lands here to await a
        # human). Its whole design is to park capped stories here rather than
        # loop, which turned this into a NORMAL destination rather than a
        # rarity — without this entry a parked story stays a "stalled"
        # candidate and re-alarms on every watcher cycle even though nothing
        # will ever move it (same rationale as ``blocked_deploy_failed`` and
        # the other three human-pending sinks above).
        "blocked_dependency_unmet",
        # Delivery-level end states (``StoryState.DELIVERED_*``): the job asked
        # for less than a merge, the factory delivered it, and a human owns the
        # next step. Aging here is the intended end state; without these entries
        # every job below auto_merge re-alarmed as "stalled" forever. Raw strings
        # (not an import of ``DELIVERED_UNMERGED_STATES``) to keep this
        # detector free of chain imports, like the rest of the set.
        "delivered_local",
        "delivered_branch",
        "delivered_pr",
    }
)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def _last_tick_ts(root: Path) -> datetime | None:
    """Return the timestamp of the most recent tick event, or None.

    Reads ``state/events/ticks.ndjson`` from the tail; the last well-formed
    record with a ``ts`` wins. Unlike the windowed detectors this does NOT
    take a ``since`` — the whole point is to detect that ticks STOPPED.
    """
    stream = root / "state" / "events" / "ticks.ndjson"
    if not stream.exists():
        return None
    last: datetime | None = None
    try:
        with stream.open(encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                ts = _parse_ts(rec.get("ts"))
                if ts is not None:
                    last = ts
    except OSError:
        return None
    return last


def _last_idle_ts(root: Path) -> datetime | None:
    """Return the ts of the most recent ``app_idle`` event, or None.

    Reads ``state/events/idle.ndjson`` (emitted by the tick's idle detector).
    A recent ``app_idle`` means the tick loop is alive and has affirmatively
    judged the app idle — i.e. the backlog is draining by design, not stuck.
    """
    stream = root / "state" / "events" / "idle.ndjson"
    if not stream.exists():
        return None
    last: datetime | None = None
    try:
        with stream.open(encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict) or rec.get("event") != "app_idle":
                    continue
                ts = _parse_ts(rec.get("ts"))
                if ts is not None:
                    last = ts
    except OSError:
        return None
    return last


def _tick_in_flight(root: Path) -> bool:
    """True when the last tick event is a ``tick_start`` with no ``tick_end``.

    A serial tick over a long queue can legitimately run for an hour-plus;
    during that time the event stream is silent and tick "silence" is
    expected, not a liveness failure.
    """
    stream = root / "state" / "events" / "ticks.ndjson"
    if not stream.exists():
        return False
    last_event: str | None = None
    try:
        with stream.open(encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(rec, dict) and rec.get("event") in ("tick_start", "tick_end"):
                    last_event = str(rec.get("event"))
    except OSError:
        return False
    return last_event == "tick_start"


def _tick_process_alive() -> bool:
    """True when a ``factory tick`` process is currently running.

    A serial tick can run for an hour-plus with quiet gaps between handler
    invocations (no live_handlers row, no story update) — the process's
    existence is the ground-truth liveness signal in those gaps. A crashed
    tick leaves no process and still alarms.
    """
    import os

    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                cmd = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        parts = cmd.split("\x00")
        if any(part.endswith("factory") for part in parts) and "tick" in parts:
            return True
    return False


def _live_handler_count(root: Path) -> int:
    """Number of persona sandboxes/LLM calls running RIGHT NOW.

    The ``live_handlers`` heartbeat table holds a row only while a handler
    is in flight. A long dev sandbox emits no events until it finishes, so
    the event window looks like "only control-plane activity" — this is the
    signal that real work is happening anyway.
    """
    db_path = root / "state" / "factory.db"
    if not db_path.exists():
        return 0
    try:
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute("SELECT COUNT(*) FROM live_handlers").fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except sqlite3.Error:
        return 0


def stalled_stories(
    *,
    root: Path,
    now: datetime | None = None,
    in_progress_stall_minutes: float = 30.0,
    stall_minutes: float = 120.0,
    tick_silence_minutes: float = 15.0,
    idle_recently_minutes: float = 30.0,
) -> dict:
    """Return absolute liveness observations for the chain.

    Parameters
    ----------
    root:
        Factory root directory.
    now:
        Reference time (defaults to ``datetime.now(UTC)``). Injectable for
        deterministic tests.
    in_progress_stall_minutes:
        Age above which a ``*_in_progress`` story is reported as
        ``stuck_in_progress`` (a handler that never returned).
    stall_minutes:
        Age above which any non-terminal, non-deployed story is reported as
        ``stalled`` (no forward progress).
    tick_silence_minutes:
        Minutes since the last tick above which ``no_tick_recently`` fires.
    idle_recently_minutes:
        Freshness window for an ``app_idle`` event to count toward
        ``healthy_drain`` — the tick's idle detector must have fired within
        this many minutes for the aged backlog to read as a healthy drain.

    Returns
    -------
    dict
        ``{"alarms": [...], "stuck_in_progress": [...], "stalled": [...],
        "minutes_since_last_tick": float|None, "no_tick_recently": bool,
        "non_terminal_total": int, "now": iso}``

        ``alarms`` is a short list of human-readable alarm strings; an empty
        list means "no liveness problem detected." Each ``stuck_in_progress`` /
        ``stalled`` entry is ``{"story_id", "state", "app", "slug",
        "age_minutes"}``.
    """
    now = now or datetime.now(UTC)
    db_path = root / "state" / "factory.db"

    stuck_in_progress: list[dict] = []
    stalled: list[dict] = []
    non_terminal_total = 0
    minutes_since_any_story_update: float | None = None

    if db_path.exists():
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(str(db_path))
            rows = conn.execute("SELECT id, state, app, slug, updated_at FROM stories").fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            if conn is not None:
                conn.close()

        for story_id, state, app, slug, updated_at in rows:
            ts = _parse_ts(updated_at)
            if ts is not None:
                age_min_any = (now - ts).total_seconds() / 60.0
                if (
                    minutes_since_any_story_update is None
                    or age_min_any < minutes_since_any_story_update
                ):
                    minutes_since_any_story_update = round(age_min_any, 1)
            if state in _TERMINAL_STATES:
                continue
            non_terminal_total += 1
            if ts is None:
                continue
            age_min = (now - ts).total_seconds() / 60.0
            entry = {
                "story_id": story_id,
                "state": state,
                "app": app,
                "slug": slug,
                "age_minutes": round(age_min, 1),
            }
            if str(state).endswith("_in_progress") and age_min >= in_progress_stall_minutes:
                stuck_in_progress.append(entry)
            elif age_min >= stall_minutes:
                stalled.append(entry)

    last_tick = _last_tick_ts(root)
    minutes_since_last_tick: float | None = None
    if last_tick is not None:
        minutes_since_last_tick = round((now - last_tick).total_seconds() / 60.0, 1)
    tick_in_flight = _tick_in_flight(root)
    live_handlers_active = _live_handler_count(root)
    # Tick silence is only a liveness failure when no tick is mid-run. A
    # serial tick over a long queue emits tick_start, then nothing for an
    # hour-plus — treat a dangling tick_start as alive as long as work is
    # visibly progressing (an in-flight handler or a recent story update);
    # a tick that crashed without tick_end goes quiet on BOTH and still
    # alarms.
    tick_process_alive = _tick_process_alive()
    tick_visibly_working = tick_in_flight and (
        live_handlers_active > 0
        or tick_process_alive
        or (
            minutes_since_any_story_update is not None
            and minutes_since_any_story_update < in_progress_stall_minutes
        )
    )
    no_tick_recently = (
        minutes_since_last_tick is not None
        and minutes_since_last_tick >= tick_silence_minutes
        and not tick_visibly_working
    )

    alarms: list[str] = []
    if stuck_in_progress:
        alarms.append(
            f"{len(stuck_in_progress)} story(ies) stuck >{in_progress_stall_minutes:g}m "
            f"in a *_in_progress state (handler never returned): "
            + ", ".join(f"#{e['story_id']}@{e['state']}" for e in stuck_in_progress[:10])
        )
    # An aged backlog is only an ALARM when the factory is actually idle.
    # While the chain drains a large queue serially, the oldest stories'
    # updated_at keeps aging even though work is flowing — a truly stuck
    # factory shows NO recent story updates AND/OR no recent ticks. Alarming
    # on "old stories exist while the factory is visibly working" caused an
    # L1->L2->L3 churn loop on every watcher cycle (2026-06-11, ~$2/hour of
    # duplicate halt-urgency concerns during a healthy drain).
    draining = not no_tick_recently and (
        live_handlers_active > 0
        or (
            minutes_since_any_story_update is not None
            and minutes_since_any_story_update < in_progress_stall_minutes
        )
    )
    if stalled and not draining:
        alarms.append(
            f"{len(stalled)} non-terminal story(ies) with no state change in "
            f">{stall_minutes:g}m: "
            + ", ".join(f"#{e['story_id']}@{e['state']}" for e in stalled[:10])
        )
    if no_tick_recently:
        alarms.append(
            f"no orchestrator tick in {minutes_since_last_tick:g}m "
            f"(>{tick_silence_minutes:g}m) — the drive loop is likely dead; "
            f"nothing is being dispatched."
        )

    # While draining, present the aged list under a neutral key. The L1
    # watcher is an LLM — a 31-item list named "stalled" reads as an
    # emergency even with zero alarm strings; it escalated on exactly that
    # during a healthy drain (2026-06-11).
    if draining:
        aged_backlog_while_draining, stalled = stalled, []
    else:
        aged_backlog_while_draining = []

    # healthy_drain — an EXPLICIT, unambiguous "do not escalate" signal for L1.
    # The detector already defuses alarms during a drain, but the raw
    # ``draining``/aged-list fields still reach the L1 LLM, which re-escalated
    # on judgment (25 draining-mode concerns/day). healthy_drain is true only
    # when there is nothing alarming (alarms == []) AND the chain is draining
    # AND the tick loop has affirmatively judged the app idle recently — i.e.
    # the backlog is emptying by design, not stuck. L1 is instructed to NOT
    # escalate when this is true.
    last_idle = _last_idle_ts(root)
    idle_recently = (
        last_idle is not None and (now - last_idle).total_seconds() / 60.0 <= idle_recently_minutes
    )
    healthy_drain = (not alarms) and draining and idle_recently

    return {
        "alarms": alarms,
        "healthy_drain": healthy_drain,
        "idle_recently": idle_recently,
        "stuck_in_progress": stuck_in_progress,
        "stalled": stalled,
        "aged_backlog_while_draining": aged_backlog_while_draining,
        "minutes_since_last_tick": minutes_since_last_tick,
        "no_tick_recently": no_tick_recently,
        "tick_in_flight": tick_in_flight,
        "tick_process_alive": tick_process_alive,
        "live_handlers_active": live_handlers_active,
        "non_terminal_total": non_terminal_total,
        "minutes_since_any_story_update": minutes_since_any_story_update,
        "draining": draining,
        "now": now.isoformat(),
    }
