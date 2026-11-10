"""Build's board (native plan 8.8): the factory at a glance, and one step's turns.

Two reads for the personal assistant's Build page, both served warm by
``factory serve`` (``POST /api/cli``, JOBS-API v1.11) and both plain CLI verbs
too:

* ``factory job board --json`` -> :func:`board_snapshot`: what ``factory tui``
  shows (``observability.queries``): active/idle, spend today and over 7 days on
  both runtimes, paused runtimes (provider limits), per-direction progress with
  the EBS ETA, the persona mid-flight on each story, recent steps and velocity.
  A snapshot is reused for 2 s; up to 30 s old it is answered at once while a
  background thread builds the next (ETAs and velocity are recomputed every 60 s).
* ``factory job step <id> --json`` -> :func:`step_events`: one step's turn
  stream (model text, tool calls and results, diffs, gates, usage, the end),
  normalized by :func:`factory.claude_session.stream.normalize_event` for both
  runtimes, read from a cursor (``<file>:<byte offset>``) so a viewer only ever
  fetches what it has not seen. ``--wait`` holds the read until a new line
  arrives (a long poll), so a live step streams without a timer re-reading
  anything.

Nothing here writes, except ``live_handlers``' reaping of stale heartbeats,
which ``factory tui`` does on every refresh too.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from factory.claude_session.stream import normalize_event
from factory.jobs.common import JobError
from factory.state_dir import state_dir

#: One read returns at most this many stream lines' events and this many bytes.
DEFAULT_LIMIT = 200
MAX_LIMIT = 1000
MAX_BYTES = 512 * 1024
#: A single line longer than this is skipped with a note (a runaway record).
MAX_LINE_BYTES = 32 * 1024 * 1024
#: The longest ``--wait`` honoured, and how often a waiting read looks again.
MAX_WAIT_S = 25.0
POLL_S = 0.25

_CURSOR = re.compile(r"^(\d{1,4}):(\d{1,15})$")
_ROUND = re.compile(r"^stream-(\d+)\.jsonl$")


def db_path(root: Path) -> Path:
    return state_dir(Path(root)) / "factory.db"


def _connect(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db), timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


# --------------------------------------------------------------------------- #
# One step's stream
# --------------------------------------------------------------------------- #


def parse_cursor(text: str | None) -> tuple[int, int]:
    """``"<file index>:<byte offset>"`` -> ``(index, offset)``; ``None``/``""`` = start."""
    if not text:
        return 0, 0
    m = _CURSOR.match(text.strip())
    if not m:
        raise JobError("invalid_cursor", f"a cursor is <file>:<offset>, got {text!r}"[:200])
    return int(m.group(1)), int(m.group(2))


def _session(row: dict[str, Any]) -> dict[str, Any] | None:
    raw = row.get("session_json")
    if not raw:
        return None
    try:
        loaded = json.loads(str(raw))
    except ValueError:
        return None
    return loaded if isinstance(loaded, dict) else None


def stream_files(row: dict[str, Any]) -> list[Path]:
    """The step's stream files, in order. An api step has one ``stream.jsonl``;
    a Claude Code step has a run dir with one ``stream-<n>.jsonl`` per round.
    A step from before ``runs.stream_path`` falls back to its session's
    ``stream`` (api runs that had a termhub session)."""
    raw = row.get("stream_path") or (_session(row) or {}).get("stream")
    if not raw:
        return []
    p = Path(str(raw))
    if p.is_dir():
        rounds: list[tuple[int, Path]] = []
        for child in p.iterdir():
            m = _ROUND.match(child.name)
            if m:
                rounds.append((int(m.group(1)), child))
        return [c for _, c in sorted(rounds)]
    if p.suffix == ".jsonl":
        return [p]  # it may not exist yet: the run writes it at its first turn
    return []


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _events_of_line(raw: bytes, at: str, *, full: bool) -> list[dict[str, Any]]:
    line = raw.strip()
    if not line:
        return []
    try:
        obj = json.loads(line.decode("utf-8", errors="replace"))
    except ValueError:
        return [{"kind": "note", "text": line[:500].decode("utf-8", errors="replace"), "at": at}]
    if not isinstance(obj, dict):
        return []
    out = normalize_event(obj, full=full)
    ts = obj.get("ts")
    for ev in out:
        ev["at"] = at
        if ts:
            ev["ts"] = ts
    return out


def read_events(
    files: list[Path],
    cursor: tuple[int, int],
    *,
    limit: int = DEFAULT_LIMIT,
    max_bytes: int = MAX_BYTES,
    full: bool = False,
) -> tuple[list[dict[str, Any]], tuple[int, int], bool]:
    """Events from ``cursor`` on: ``(events, next cursor, more)``.

    Only complete lines are read, so a record being written is never split.
    ``limit`` counts stream lines; ``more`` says bytes are already waiting past
    the returned cursor (read again at once). A finished file gives way to the
    next round's file.
    """
    idx, off = cursor
    events: list[dict[str, Any]] = []
    lines = 0
    budget = max_bytes
    while idx < len(files) and lines < limit and budget > 0:
        path = files[idx]
        size = _size(path)
        off = min(off, size)
        if off < size:
            try:
                with path.open("rb") as fh:
                    fh.seek(off)
                    data = fh.read(min(budget, size - off))
                    end = data.rfind(b"\n")
                    if end < 0 and len(data) == budget and size - off > budget:
                        # One line longer than the whole budget: read just it.
                        data = data + fh.readline(MAX_LINE_BYTES)
                        end = data.rfind(b"\n")
                        if end < 0:  # still no end: skip what we read
                            events.append(
                                {"kind": "note", "text": f"(a record over {len(data)} bytes was skipped)",
                                 "at": f"{idx}:{off}"}
                            )
                            off += len(data)
                            budget = 0
                            continue
            except OSError:
                break
            if end < 0:
                break  # only a partial line so far: wait for its end
            pos = 0
            chunk = data[: end + 1]
            for raw in chunk.split(b"\n")[:-1]:
                at = f"{idx}:{off + pos}"
                pos += len(raw) + 1
                events.extend(_events_of_line(raw, at, full=full))
                lines += 1
                if lines >= limit:
                    break
            off += pos
            budget -= pos
            if off < _size(path):
                continue  # more in this file (limit/budget decides)
        if idx + 1 < len(files):
            idx, off = idx + 1, 0
            continue
        break
    more = False
    if idx < len(files):
        more = off < _size(files[idx]) or idx + 1 < len(files)
    return events, (idx, off), more


def read_one(files: list[Path], at: tuple[int, int]) -> list[dict[str, Any]]:
    """The full (uncapped up to ``VIEW_FULL_CAP``) events of the one line at ``at``."""
    idx, off = at
    if idx >= len(files):
        return []
    try:
        with files[idx].open("rb") as fh:
            fh.seek(off)
            raw = fh.readline(MAX_LINE_BYTES)
    except OSError:
        return []
    return _events_of_line(raw, f"{idx}:{off}", full=True)


def _step_row(db: Path, step_id: int) -> dict[str, Any] | None:
    if not db.exists():
        return None
    from factory.observability.schema import migrate

    migrate(db)
    conn = _connect(db)
    try:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (int(step_id),)).fetchone()
    finally:
        conn.close()
    return dict(row) if row is not None else None


def step_view(row: dict[str, Any]) -> dict[str, Any]:
    """The step as the viewer's header shows it (the ``runs[]`` view plus usage)."""
    from factory.jobs.status import runs_view
    from factory.runner import _PROVISIONAL_RUN_ERROR

    app, did = row.get("app"), row.get("direction_id")
    job_id = f"{app}:{did}" if app and did else None
    view = runs_view([row], job_id)[0]
    error = row.get("error")
    view.update(
        {
            "app": app,
            "direction_id": did,
            "tokens_in": int(row.get("tokens_in") or 0),
            "tokens_out": int(row.get("tokens_out") or 0),
            "cached_input_tokens": int(row.get("cached_input_tokens") or 0),
            "subscription_equiv_usd": round(float(row.get("subscription_equiv_usd") or 0.0), 4),
            "duration_s": row.get("duration_s"),
            "error": None if error == _PROVISIONAL_RUN_ERROR or not error else str(error)[:600],
        }
    )
    return view


def step_events(
    root: Path,
    step_id: int,
    *,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
    wait_s: float = 0.0,
    at: str | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """``factory job step <id> --json`` (JOBS-API v1.11).

    ``{"step", "events", "cursor", "more", "done", "has_stream"}``. With ``at``
    (an event's ``at``), the one record there, uncapped: a viewer's "show all".
    With ``wait_s``, a read that finds nothing new on a running step waits up to
    that long for the next line.
    """
    db = db_path(root)
    row = _step_row(db, step_id)
    if row is None:
        raise JobError("not_found", f"no step {step_id}")
    files = stream_files(row)
    if at:
        pos = parse_cursor(at)
        return {
            "step": step_view(row),
            "events": read_one(files, pos),
            "cursor": at,
            "more": False,
            "done": False,
            "has_stream": bool(files),
        }
    pos = parse_cursor(cursor)
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    deadline = clock() + max(0.0, min(float(wait_s or 0.0), MAX_WAIT_S))
    last_row_check = clock()
    while True:
        events, pos, more = read_events(files, pos, limit=limit)
        view = step_view(row)
        running = view["state"] == "running"
        if events or more or not running or clock() >= deadline:
            break
        sleep(POLL_S)
        if clock() - last_row_check >= 1.0:
            # The step may have ended, or a Claude run started its next round.
            last_row_check = clock()
            row = _step_row(db, step_id) or row
            files = stream_files(row)
    return {
        "step": view,
        "events": events,
        "cursor": f"{pos[0]}:{pos[1]}",
        "more": more,
        "done": not running and not more,
        "has_stream": bool(files),
    }


# --------------------------------------------------------------------------- #
# The board snapshot
# --------------------------------------------------------------------------- #

_FAST_TTL_S = 2.0
_SLOW_TTL_S = 60.0
_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float, fn: Callable[[], Any], now: float) -> Any:
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (now, value)
    return value


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat() if dt is not None else None


def _spend(db: Path, now: datetime) -> dict[str, Any]:
    """Metered (``cost_usd``) and notional (Claude Code's ``subscription_equiv_usd``)
    spend since the factory host's local midnight and over the last 7 days."""
    midnight = now.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    week = now - timedelta(days=7)
    out: dict[str, Any] = {"today_since": _iso(midnight)}
    conn = _connect(db)
    try:
        for key, since in (("today", midnight), ("week", week)):
            r = conn.execute(
                "SELECT COALESCE(SUM(cost_usd), 0), COALESCE(SUM(subscription_equiv_usd), 0) "
                "FROM runs WHERE ts >= ?",
                (since.astimezone(UTC).isoformat(),),
            ).fetchone()
            out[key] = {"metered_usd": round(float(r[0]), 4), "notional_usd": round(float(r[1]), 4)}
    finally:
        conn.close()
    return out


def _daily_cap(root: Path) -> float | None:
    try:
        from factory.settings.loader import load_settings

        return float(load_settings(Path(root)).caps.daily_spend_usd) or None
    except Exception:  # noqa: BLE001 - a missing settings file is no cap
        return None


def _paused(root: Path) -> list[dict[str, Any]]:
    from factory.provider_limits import RUNTIMES, open_entry, pause_view

    out = []
    for rt in RUNTIMES:
        view = pause_view(open_entry(Path(root), rt))
        if view:
            out.append(view)
    return out


def _recent(db: Path, limit: int = 15) -> list[dict[str, Any]]:
    from factory.jobs.status import runs_view

    conn = _connect(db)
    try:
        rows = [dict(r) for r in conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,))]
    finally:
        conn.close()
    out = []
    for r in rows:
        app, did = r.get("app"), r.get("direction_id")
        v = runs_view([r], f"{app}:{did}" if app and did else None)[0]
        v.update(
            {
                "tokens_in": int(r.get("tokens_in") or 0),
                "tokens_out": int(r.get("tokens_out") or 0),
                "subscription_equiv_usd": round(float(r.get("subscription_equiv_usd") or 0.0), 4),
                "duration_s": r.get("duration_s"),
            }
        )
        out.append(v)
    return out


def _eta_view(eta: Any) -> dict[str, Any] | None:
    if eta is None:
        return None
    return {
        "p50_s": round(float(eta.p50_seconds), 1),
        "p75_s": round(float(eta.p75_seconds), 1),
        "p95_s": round(float(eta.p95_seconds), 1),
        "samples": int(eta.sample_count),
        "insufficient": bool(eta.insufficient_data),
        "reason": eta.reason or None,
    }


def _directions(db: Path, root: Path, now_m: float, live_by_story: dict[int, Any]) -> list[dict[str, Any]]:
    from factory.observability.estimator import monte_carlo_eta
    from factory.observability.queries import directions_in_flight

    out = []
    for d in directions_in_flight(db, Path(root), compute_eta=False):

        def _eta(d: Any = d) -> Any:
            try:
                return _eta_view(monte_carlo_eta(db, direction_id=d.direction_id, app=d.app, iterations=300))
            except Exception:  # noqa: BLE001 - an ETA is nice-to-have
                return None

        eta = _cached(f"eta:{d.app}:{d.direction_id}", _SLOW_TTL_S, _eta, now_m)
        stories = []
        for s in d.stories:
            hb = live_by_story.get(s.id)
            stories.append(
                {
                    "id": s.id,
                    "title": s.title,
                    "state": s.state,
                    "points": s.points,
                    "completed_handlers": s.completed_handlers,
                    "total_handlers": s.total_handlers,
                    "remaining": list(s.remaining_handlers)[:12],
                    "persona": hb.persona if hb is not None else None,
                    "persona_elapsed_s": round(hb.elapsed_seconds) if hb is not None else None,
                    "dev_retries": s.dev_retries,
                    "last_rejection_reason": (s.last_rejection_reason or "")[:300] or None,
                }
            )
        out.append(
            {
                "job_id": f"{d.app}:{d.direction_id}",
                "app": d.app,
                "direction_id": d.direction_id,
                "title": d.title,
                "total_stories": d.total_stories,
                "completed_stories": d.completed_stories,
                "in_flight_stories": d.in_flight_stories,
                "total_handlers": d.total_handlers,
                "completed_handlers": d.completed_handlers,
                "progress": round(d.completed_handlers / d.total_handlers, 4) if d.total_handlers else None,
                "eta": eta,
                "current_personas": list(d.current_personas),
                "stories": stories,
            }
        )
    return out


def _velocity(db: Path) -> list[dict[str, Any]]:
    from factory.observability.queries import velocity_table

    return [
        {
            "persona": v.persona,
            "model_tier": v.model_tier,
            "samples": v.sample_count,
            "median": round(v.median_velocity, 3),
            "p25": round(v.p25_velocity, 3),
            "p75": round(v.p75_velocity, 3),
        }
        for v in velocity_table(db)
    ]


#: A snapshot older than the fast TTL but younger than this is answered at once
#: while a background thread builds the next one (stale-while-revalidate). On a
#: real factory db a build is ~0.3 s warm and ~1.5 s when the ETAs and velocity
#: are due (every 60 s): a page must never wait for that.
_STALE_OK_S = 30.0
_building: set[str] = set()


def board_snapshot(
    root: Path,
    *,
    now: datetime | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    background: bool = True,
) -> dict[str, Any]:
    """``factory job board --json`` (JOBS-API v1.11). See the module doc."""
    root = Path(root)
    key = f"board:{root}"
    now_m = monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now_m - hit[0] < _FAST_TTL_S:
        return dict(hit[1])
    if hit is not None and background and now_m - hit[0] < _STALE_OK_S:
        with _lock:
            start = key not in _building
            _building.add(key)
        if start:
            threading.Thread(
                target=_rebuild, args=(root, key, monotonic), name="factory-board", daemon=True
            ).start()
        return dict(hit[1])
    return _build(root, key, now or datetime.now(UTC), monotonic)


def _rebuild(root: Path, key: str, monotonic: Callable[[], float]) -> None:
    try:
        _build(root, key, datetime.now(UTC), monotonic)
    except Exception:  # noqa: BLE001 - the next request builds it in line instead
        pass
    finally:
        with _lock:
            _building.discard(key)


def _build(root: Path, key: str, now: datetime, monotonic: Callable[[], float]) -> dict[str, Any]:
    db = db_path(root)
    now_m = monotonic()
    if not db.exists():
        return {
            "as_of": _iso(now), "mode": "unknown", "active": False, "spend": None,
            "spend_cap_usd": None, "paused": _paused(root), "live": [], "directions": [],
            "recent_runs": [], "velocity": [],
        }
    from factory.observability.queries import get_factory_mode, live_handlers

    handlers = live_handlers(db)
    live = [
        {
            "persona": h.persona,
            "model": h.model,
            "story_id": h.story_id,
            "app": h.app,
            "direction_id": h.direction_id,
            "job_id": f"{h.app}:{h.direction_id}" if h.app and h.direction_id else None,
            "started_at": _iso(h.started_at),
            "elapsed_s": round(h.elapsed_seconds),
        }
        for h in handlers
    ]
    live_by_story = {h.story_id: h for h in handlers if h.story_id is not None}
    recent = _recent(db)
    snap: dict[str, Any] = {
        "as_of": _iso(now),
        "mode": get_factory_mode(db),
        "active": bool(handlers) or any(r["state"] == "running" for r in recent),
        "spend": _spend(db, now),
        "spend_cap_usd": _cached(f"cap:{root}", _SLOW_TTL_S, lambda: _daily_cap(root), now_m),
        "paused": _paused(root),
        "live": live,
        "directions": _directions(db, root, now_m, live_by_story),
        "recent_runs": recent,
        "velocity": _cached(f"velocity:{root}", _SLOW_TTL_S, lambda: _velocity(db), now_m),
    }
    with _lock:
        # Stamped when built, not when asked: a slow build is not born stale.
        _cache[key] = (monotonic(), snap)
    return dict(snap)


__all__ = [
    "board_snapshot",
    "clear_cache",
    "parse_cursor",
    "read_events",
    "read_one",
    "step_events",
    "step_view",
    "stream_files",
]
