"""Read-side query layer for the TUI.

The TUI polls these helpers ~1 Hz. Each call opens its own sqlite
connection so the polling thread doesn't share a session with handler
writers — sqlite3 in WAL mode handles this cleanly.

All times are returned as ``datetime`` (UTC) so the TUI can format them
in whatever way it wants. Durations are seconds (float).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from factory.observability.estimator import (
    ETAResult,
    completed_handlers_for_story,
    monte_carlo_eta,
    remaining_handlers_for_story,
    total_handlers_for_chain,
)
from factory.observability.heartbeat import reap_stale_heartbeats
from factory.observability.schema import migrate

# --------------------------------------------------------------------------- #
# Lightweight DTOs the TUI consumes (immutable snapshots)
# --------------------------------------------------------------------------- #


@dataclass
class AppSummary:
    name: str
    in_flight_stories: int
    last_run_ts: datetime | None
    spend_24h_usd: float
    spend_7d_usd: float
    active: bool  # any handler ran in the last 60s


@dataclass
class LiveHandlerRow:
    persona: str
    model: str
    mode: str
    story_id: int | None
    app: str | None
    direction_id: str | None
    started_at: datetime
    elapsed_seconds: float


@dataclass
class StoryRow:
    id: int
    app: str
    direction_id: str
    title: str
    slug: str
    state: str
    chain_kind: str
    points: int | None
    estimated_seconds: float | None
    dev_retries: int
    last_rejection_reason: str | None
    completed_handlers: int
    total_handlers: int
    remaining_handlers: list[str]


@dataclass
class DirectionProgress:
    app: str
    direction_id: str
    title: str  # derived from first story.title or direction state.yaml
    total_stories: int
    completed_stories: int
    in_flight_stories: int
    total_points: int
    completed_points: int
    total_handlers: int
    completed_handlers: int
    eta: ETAResult | None
    current_personas: list[str]  # personas mid-flight on stories in this dir
    stories: list[StoryRow] = field(default_factory=list)


@dataclass
class RunRow:
    ts: datetime
    persona: str
    model: str
    mode: str
    tokens_in: int
    tokens_out: int
    cost_usd: float
    success: bool
    duration_s: float | None
    story_id: int | None
    error: str | None


@dataclass
class VelocityCell:
    persona: str
    model_tier: str
    sample_count: int
    median_velocity: float
    p25_velocity: float
    p75_velocity: float


@dataclass
class FactorySnapshot:
    """Top-level snapshot returned by ``collect_snapshot``."""

    now: datetime
    mode: str
    active: bool
    spend_24h_usd: float
    spend_7d_usd: float
    spend_24h_cap_usd: float | None
    spend_sparkline_hourly: list[float]
    apps: list[AppSummary]
    live_handlers: list[LiveHandlerRow]
    directions: list[DirectionProgress]
    recent_runs: list[RunRow]
    velocity: list[VelocityCell]


# --------------------------------------------------------------------------- #
# Implementation
# --------------------------------------------------------------------------- #


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


# Terminal-for-progress states. From the estimator's remaining-by-state map,
# any story whose remaining list is empty is considered "complete enough" for
# direction progress — the value-producing handlers are done.
_TERMINAL_STATES_FOR_PROGRESS = {
    "tech_writer_done",
    "tech_writer_in_progress",
    "docs_enforcer_check",
    "pr_open",
    "ci_pending",
    "ci_green",
    "ready_for_merge",
    "deploy_pending",
    "deployed",
    "docs_onboarder_done",
    "docs_onboarder_in_progress",
    # A dual-draft direction is complete once ONE interpretation ships; the
    # superseded loser is terminal-for-progress so the direction reads done
    # (1/1 effective) instead of a perpetual 1/2.
    "superseded_by_sibling",
    # Operator-closed stories are settled; they must not hold a direction open.
    "closed_by_operator",
    # Delivery-level end states: the factory finished its part.
    "delivered_local",
    "delivered_branch",
    "delivered_pr",
}

# Stories in these states are out-of-band and should NOT contribute to
# "in flight" counts on the dashboard. They've either landed or stalled.
_NOT_IN_FLIGHT_STATES = {
    "pr_open",
    "ci_pending",
    "ci_green",
    "ready_for_merge",
    "deploy_pending",
    "deployed",
    "blocked_tests_need_clarification",
    "blocked_deploy_failed",
    # Dual-draft loser sink — terminal (abandoned); not in flight.
    "superseded_by_sibling",
    # Delivery-level end states — terminal; not in flight.
    "delivered_local",
    "delivered_branch",
    "delivered_pr",
}


def get_factory_mode(db_path: Path) -> str:
    """Return the current factory mode, or ``"normal"`` if unset."""
    migrate(db_path)
    conn = _connect(db_path)
    try:
        cur = conn.execute("SELECT mode FROM factory_state LIMIT 1")
        row = cur.fetchone()
        if row is None:
            return "normal"
        return str(row[0])
    except sqlite3.OperationalError:
        # Table may not exist yet on a fresh checkout.
        return "normal"
    finally:
        conn.close()


def spend_window(
    db_path: Path, *, hours: int = 24, app: str | None = None
) -> float:
    """Sum ``runs.cost_usd`` for runs in the last ``hours`` hours."""
    migrate(db_path)
    cutoff = (datetime.now(UTC) - timedelta(hours=hours)).isoformat()
    conn = _connect(db_path)
    try:
        if app is None:
            cur = conn.execute(
                "SELECT COALESCE(SUM(cost_usd), 0.0) FROM runs WHERE ts >= ?",
                (cutoff,),
            )
        else:
            cur = conn.execute(
                """
                SELECT COALESCE(SUM(runs.cost_usd), 0.0)
                FROM runs
                LEFT JOIN stories ON runs.story_id = stories.id
                WHERE runs.ts >= ?
                  AND stories.app = ?
                """,
                (cutoff, app),
            )
        return round(float(cur.fetchone()[0] or 0.0), 6)
    finally:
        conn.close()


def spend_sparkline_hourly(db_path: Path, hours: int = 24) -> list[float]:
    """Per-hour spend totals for the last ``hours`` hours. Newest last."""
    migrate(db_path)
    now = datetime.now(UTC)
    bucket_starts = [
        now - timedelta(hours=h)
        for h in range(hours, 0, -1)
    ]
    buckets = [0.0] * hours
    cutoff = (now - timedelta(hours=hours)).isoformat()
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT ts, cost_usd FROM runs WHERE ts >= ?",
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    for row in rows:
        ts = _parse_ts(row["ts"])
        if ts is None:
            continue
        idx = int((ts - bucket_starts[0]).total_seconds() // 3600)
        if 0 <= idx < hours:
            buckets[idx] += float(row["cost_usd"] or 0.0)
    return buckets


def list_apps(software_factory_root: Path) -> list[str]:
    apps_dir = software_factory_root / "apps"
    if not apps_dir.exists():
        return []
    return sorted(
        p.name for p in apps_dir.iterdir() if (p / "config.yaml").exists()
    )


def app_summary(
    db_path: Path, *, app: str
) -> AppSummary:
    migrate(db_path)
    conn = _connect(db_path)
    try:
        in_flight = conn.execute(
            f"""
            SELECT COUNT(*) FROM stories
            WHERE app = ?
              AND state NOT IN ({','.join('?' for _ in _NOT_IN_FLIGHT_STATES)})
            """,
            (app, *_NOT_IN_FLIGHT_STATES),
        ).fetchone()[0]
        last_run_row = conn.execute(
            """
            SELECT MAX(runs.ts)
            FROM runs
            LEFT JOIN stories ON runs.story_id = stories.id
            WHERE stories.app = ?
            """,
            (app,),
        ).fetchone()
        last_run_ts = _parse_ts(last_run_row[0]) if last_run_row else None
    finally:
        conn.close()
    spend_24h = spend_window(db_path, hours=24, app=app)
    spend_7d = spend_window(db_path, hours=24 * 7, app=app)
    active = bool(
        last_run_ts and last_run_ts > (datetime.now(UTC) - timedelta(seconds=60))
    )
    return AppSummary(
        name=app,
        in_flight_stories=int(in_flight),
        last_run_ts=last_run_ts,
        spend_24h_usd=spend_24h,
        spend_7d_usd=spend_7d,
        active=active,
    )


def live_handlers(db_path: Path) -> list[LiveHandlerRow]:
    """Return active heartbeats, reaping stale ones first."""
    migrate(db_path)
    try:
        reap_stale_heartbeats(db_path)
    except Exception:
        pass
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT started_at, persona, model, mode, story_id, app, direction_id "
            "FROM live_handlers ORDER BY started_at ASC"
        ).fetchall()
    finally:
        conn.close()
    now = datetime.now(UTC)
    out: list[LiveHandlerRow] = []
    for r in rows:
        started = _parse_ts(r["started_at"])
        if started is None:
            continue
        out.append(
            LiveHandlerRow(
                persona=r["persona"],
                model=r["model"],
                mode=r["mode"],
                story_id=r["story_id"],
                app=r["app"],
                direction_id=r["direction_id"],
                started_at=started,
                elapsed_seconds=(now - started).total_seconds(),
            )
        )
    return out


def in_flight_stories(db_path: Path, app: str | None = None) -> list[StoryRow]:
    migrate(db_path)
    conn = _connect(db_path)
    try:
        sql = f"""
            SELECT *
            FROM stories
            WHERE state NOT IN ({','.join('?' for _ in _NOT_IN_FLIGHT_STATES)})
        """
        params: list[Any] = list(_NOT_IN_FLIGHT_STATES)
        if app is not None:
            sql += " AND app = ?"
            params.append(app)
        sql += " ORDER BY updated_at DESC"
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    out: list[StoryRow] = []
    for r in rows:
        chain_kind = r["chain_kind"] or "tdd"
        # ``pipeline`` is absent on a DB that predates per-job routing.
        pipeline = r["pipeline"] if "pipeline" in r.keys() else None
        out.append(
            StoryRow(
                id=int(r["id"]),
                app=r["app"],
                direction_id=r["direction_id"],
                title=r["title"],
                slug=r["slug"],
                state=r["state"],
                chain_kind=chain_kind,
                points=int(r["points"]) if r["points"] is not None else None,
                estimated_seconds=(
                    float(r["estimated_seconds"])
                    if r["estimated_seconds"] is not None
                    else None
                ),
                dev_retries=int(r["dev_retries"] or 0),
                last_rejection_reason=r["last_rejection_reason"],
                completed_handlers=completed_handlers_for_story(
                    r["state"], chain_kind, pipeline
                ),
                total_handlers=total_handlers_for_chain(chain_kind, pipeline),
                remaining_handlers=remaining_handlers_for_story(
                    r["state"], chain_kind, pipeline
                ),
            )
        )
    return out


def stories_for_direction(
    db_path: Path, *, app: str, direction_id: str
) -> list[StoryRow]:
    migrate(db_path)
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT *
            FROM stories
            WHERE app = ? AND direction_id = ?
            ORDER BY id ASC
            """,
            (app, direction_id),
        ).fetchall()
    finally:
        conn.close()
    out: list[StoryRow] = []
    for r in rows:
        chain_kind = r["chain_kind"] or "tdd"
        # ``pipeline`` is absent on a DB that predates per-job routing.
        pipeline = r["pipeline"] if "pipeline" in r.keys() else None
        out.append(
            StoryRow(
                id=int(r["id"]),
                app=r["app"],
                direction_id=r["direction_id"],
                title=r["title"],
                slug=r["slug"],
                state=r["state"],
                chain_kind=chain_kind,
                points=int(r["points"]) if r["points"] is not None else None,
                estimated_seconds=(
                    float(r["estimated_seconds"])
                    if r["estimated_seconds"] is not None
                    else None
                ),
                dev_retries=int(r["dev_retries"] or 0),
                last_rejection_reason=r["last_rejection_reason"],
                completed_handlers=completed_handlers_for_story(
                    r["state"], chain_kind, pipeline
                ),
                total_handlers=total_handlers_for_chain(chain_kind, pipeline),
                remaining_handlers=remaining_handlers_for_story(
                    r["state"], chain_kind, pipeline
                ),
            )
        )
    return out


def direction_titles_from_disk(
    software_factory_root: Path, app: str
) -> dict[str, str]:
    """Map ``direction_id -> direction title`` by scanning the apps dir."""
    out: dict[str, str] = {}
    d = software_factory_root / "apps" / app / "directions"
    if not d.exists():
        return out
    for child in sorted(d.iterdir()):
        if not child.is_dir():
            continue
        direction_md = child / "direction.md"
        if not direction_md.exists():
            continue
        # The directory name is the canonical "id-slug"; the title is the
        # ``title:`` frontmatter, but parsing YAML is overkill — first
        # ``# ...`` heading or directory name will do.
        title = child.name
        try:
            with direction_md.open("r", encoding="utf-8") as f:
                head = f.read(4096)
                # Pull title from frontmatter if obvious, else first ATX heading.
                import re

                m = re.search(r"^title:\s*['\"]?(.+?)['\"]?\s*$", head, re.M)
                if m:
                    title = m.group(1).strip()
                else:
                    m2 = re.search(r"^#\s+(.+?)\s*$", head, re.M)
                    if m2:
                        title = m2.group(1).strip()
        except OSError:
            pass
        out[child.name] = title
    return out


def directions_in_flight(
    db_path: Path,
    software_factory_root: Path,
    *,
    app: str | None = None,
    compute_eta: bool = True,
) -> list[DirectionProgress]:
    """Group in-flight stories by (app, direction_id) into progress bars."""
    stories = in_flight_stories(db_path, app=app)
    # Also include directions where ALL stories are landed but spawned recently
    # — for completeness we keep this scoped to active directions only.
    by_key: dict[tuple[str, str], list[StoryRow]] = {}
    for s in stories:
        by_key.setdefault((s.app, s.direction_id), []).append(s)

    # Pull all stories per direction (including landed ones) so the bar
    # shows accurate completion ratios across the WHOLE direction, not
    # just the in-flight subset.
    out: list[DirectionProgress] = []
    title_caches: dict[str, dict[str, str]] = {}

    live_by_story = {
        h.story_id: h for h in live_handlers(db_path) if h.story_id is not None
    }

    for (a, did), _in_flight_subset in sorted(by_key.items()):
        all_stories = stories_for_direction(db_path, app=a, direction_id=did)
        total_stories = len(all_stories)
        completed_stories = sum(
            1 for s in all_stories if s.state in _TERMINAL_STATES_FOR_PROGRESS
        )
        in_flight_count = sum(
            1 for s in all_stories if s.state not in _NOT_IN_FLIGHT_STATES
        )
        total_points = sum(int(s.points or 0) for s in all_stories)
        completed_points = sum(
            int(s.points or 0)
            for s in all_stories
            if s.state in _TERMINAL_STATES_FOR_PROGRESS
        )
        total_h = sum(s.total_handlers for s in all_stories)
        completed_h = sum(s.completed_handlers for s in all_stories)
        eta: ETAResult | None = None
        if compute_eta:
            try:
                eta = monte_carlo_eta(db_path, direction_id=did, app=a)
            except Exception:
                eta = None

        current_personas: list[str] = []
        for s in all_stories:
            hb = live_by_story.get(s.id)
            if hb is not None:
                current_personas.append(hb.persona)

        if a not in title_caches:
            title_caches[a] = direction_titles_from_disk(
                software_factory_root, a
            )
        title = title_caches[a].get(did) or (
            all_stories[0].title if all_stories else did
        )

        out.append(
            DirectionProgress(
                app=a,
                direction_id=did,
                title=title,
                total_stories=total_stories,
                completed_stories=completed_stories,
                in_flight_stories=in_flight_count,
                total_points=total_points,
                completed_points=completed_points,
                total_handlers=total_h,
                completed_handlers=completed_h,
                eta=eta,
                current_personas=current_personas,
                stories=all_stories,
            )
        )
    return out


def recent_runs(db_path: Path, limit: int = 10) -> list[RunRow]:
    migrate(db_path)
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT ts, persona, model, mode, tokens_in, tokens_out, cost_usd,
                   success, duration_s, story_id, error
            FROM runs
            ORDER BY ts DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    out: list[RunRow] = []
    for r in rows:
        ts = _parse_ts(r["ts"])
        if ts is None:
            continue
        out.append(
            RunRow(
                ts=ts,
                persona=r["persona"],
                model=r["model"],
                mode=r["mode"],
                tokens_in=int(r["tokens_in"] or 0),
                tokens_out=int(r["tokens_out"] or 0),
                cost_usd=float(r["cost_usd"] or 0.0),
                success=bool(r["success"]),
                duration_s=(
                    float(r["duration_s"])
                    if r["duration_s"] is not None
                    else None
                ),
                story_id=r["story_id"],
                error=r["error"],
            )
        )
    return out


def velocity_table(
    db_path: Path, lookback_days: int = 30
) -> list[VelocityCell]:
    """Compact per-(persona, model_tier) velocity stats for the velocity panel."""
    from factory.observability.estimator import (
        _model_tier_of,
        _raw_sql_iter,
        baseline_seconds,
    )

    cutoff = (datetime.now(UTC) - timedelta(days=lookback_days)).isoformat()
    rows = _raw_sql_iter(
        db_path,
        """
        SELECT runs.persona, runs.model, runs.duration_s, COALESCE(stories.points, 3), runs.success
        FROM runs
        JOIN stories ON runs.story_id = stories.id
        WHERE runs.duration_s IS NOT NULL AND runs.duration_s > 0
          AND runs.ts >= ?
        """,
        (cutoff,),
    )
    by_cell: dict[tuple[str, str], list[float]] = {}
    for persona, model, duration_s, points, success in rows:
        if not success:
            continue
        est, _n = baseline_seconds(
            db_path, persona=persona, points=int(points)
        )
        if est is None or est <= 0:
            continue
        v = est / float(duration_s)
        if 0.05 <= v <= 20.0:
            by_cell.setdefault((persona, _model_tier_of(model)), []).append(v)
    out: list[VelocityCell] = []
    for (persona, tier), vals in sorted(by_cell.items()):
        vals.sort()
        if not vals:
            continue
        median_v = vals[len(vals) // 2]
        p25 = vals[len(vals) // 4] if len(vals) >= 4 else vals[0]
        p75 = vals[(3 * len(vals)) // 4] if len(vals) >= 4 else vals[-1]
        out.append(
            VelocityCell(
                persona=persona,
                model_tier=tier,
                sample_count=len(vals),
                median_velocity=median_v,
                p25_velocity=p25,
                p75_velocity=p75,
            )
        )
    return out


def collect_snapshot(
    db_path: Path,
    software_factory_root: Path,
    *,
    spend_cap_usd: float | None = None,
    app_filter: str | None = None,
) -> FactorySnapshot:
    """Single read-side call: returns everything the TUI renders this tick."""
    now = datetime.now(UTC)
    mode = get_factory_mode(db_path)
    spend_24h = spend_window(db_path, hours=24)
    spend_7d = spend_window(db_path, hours=24 * 7)
    spark = spend_sparkline_hourly(db_path, hours=24)
    apps = [
        app_summary(db_path, app=a)
        for a in list_apps(software_factory_root)
        if app_filter is None or a == app_filter
    ]
    handlers = live_handlers(db_path)
    directions = directions_in_flight(
        db_path, software_factory_root, app=app_filter, compute_eta=True
    )
    runs = recent_runs(db_path, limit=10)
    vel = velocity_table(db_path)
    active = bool(handlers) or any(a.active for a in apps)
    return FactorySnapshot(
        now=now,
        mode=mode,
        active=active,
        spend_24h_usd=spend_24h,
        spend_7d_usd=spend_7d,
        spend_24h_cap_usd=spend_cap_usd,
        spend_sparkline_hourly=spark,
        apps=apps,
        live_handlers=handlers,
        directions=directions,
        recent_runs=runs,
        velocity=vel,
    )
