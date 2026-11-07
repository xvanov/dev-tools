"""Structured NDJSON event streams — the FMS signal foundation (Phase 1).

Six append-only streams live under ``state/events/``.  Every line is a
single JSON object with at minimum:

  ``ts``             — ISO-8601 UTC timestamp with tz suffix
  ``schema_version`` — integer (currently ``1``)
  ``event``          — discriminator string

Design mirrors ``factory.chain.event_log``:
  * Append-only. One JSON object per line. No locking needed because
    the orchestrator is single-process.
  * Best-effort: a write failure MUST NOT bubble out of a handler.
    Every call is wrapped in try/except; failures go to stderr.
  * ``state/events/`` is the canonical directory (alongside
    ``state/factory.db`` and ``state/logs/``).

Wiring summary
--------------
Stream           | Wired in
-----------------|----------------------------------------------------
runs.ndjson      | factory/runner.py  — _record_run()
ticks.ndjson     | factory/chain/orchestrator.py — tick()
queue.ndjson     | factory/chain/orchestrator.py — tick()
webhooks.ndjson  | factory/webhook/github.py (placeholder emitted)
git.ndjson       | factory/chain/worktree.py + handlers.py commit/push sites
spend.ndjson     | factory/chain/orchestrator.py — tick()
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION: int = 1

# Name of the append-only stream that records control-plane anomalies and
# fail-safe events (halt/circuit-breaker read failures, control-plane write
# failures). The FMS L1 watcher can read this stream to SEE when the factory
# failed to record or read its own control state — the whole point of making
# these failures observable rather than swallowing them to /dev/null.
ALERT_STREAM: str = "alerts"

# Process-local counter of write_event failures. Telemetry appends stay
# best-effort (a disk glitch must not crash a tick), but a swallowed failure
# is invisible; this counter + the loud stderr line below make the failure
# observable to anything that samples it (tests, a future health probe).
_write_failure_count: int = 0


def get_write_failure_count() -> int:
    """Return the number of ``write_event`` failures seen this process.

    Used to make best-effort telemetry-append failures observable without
    crashing the caller: a rising count means the factory is failing to
    record its own signals.
    """
    return _write_failure_count


# --------------------------------------------------------------------------- #
# Core helper
# --------------------------------------------------------------------------- #


def _events_dir(software_factory_root: Path | None) -> Path:
    # Resolution order: explicit arg → FACTORY_STATE_ROOT env → cwd. The env
    # seam lets the test suite redirect ALL event writes to a tmp dir (see
    # tests/conftest.py) so a test that calls text_run without threading an
    # explicit root can never pollute the production event log — which the FMS
    # watcher reads and would otherwise escalate as real persona failures.
    if software_factory_root:
        root = Path(software_factory_root)
    else:
        env_root = os.environ.get("FACTORY_STATE_ROOT")
        root = Path(env_root) if env_root else Path.cwd()
    return root / "state" / "events"


def write_event(
    stream: str,
    payload: dict[str, Any],
    *,
    software_factory_root: Path | None = None,
    rotate_max_bytes: int | None = None,
    rotate_keep: int | None = None,
) -> None:
    """Append one NDJSON line to ``state/events/<stream>.ndjson``.

    Idempotently creates the parent directory. Adds ``ts`` (now, UTC
    ISO-8601 with tz suffix) and ``schema_version`` if not already
    present in ``payload``. Never raises — I/O failures go to stderr.

    Parameters
    ----------
    stream:
        Bare stream name, e.g. ``"runs"`` → writes to
        ``state/events/runs.ndjson``.
    payload:
        The event dict. MUST include an ``"event"`` discriminator field.
        ``ts`` and ``schema_version`` are injected if absent.
    software_factory_root:
        Overrides the stream directory location (useful for tests).
    rotate_max_bytes, rotate_keep:
        Per-stream rotation overrides. Default to the module defaults in
        ``factory.events.rotation`` (25 MB, 3 segments), which suit the
        small-record signal streams. A stream whose records are large —
        ``prompt_bodies`` holds whole prompts, tens of KB each — needs a
        bigger window to retain a useful number of rows.
    """
    try:
        record: dict[str, Any] = {}
        record["ts"] = payload.get("ts") or datetime.now(UTC).isoformat()
        record["schema_version"] = payload.get("schema_version", SCHEMA_VERSION)
        for k, v in payload.items():
            if k in ("ts", "schema_version"):
                continue
            record[k] = v
        directory = _events_dir(software_factory_root)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{stream}.ndjson"

        # Normalise to a JSON-serializable form BEFORE stamping the chain. The
        # fallback below repr()s unserializable values; doing that after hashing
        # would mean the line on disk no longer matches its own entry_hash, and
        # verification would report a broken link for a record nobody touched.
        try:
            json.dumps(record)
        except (TypeError, ValueError) as enc_exc:
            safe: dict[str, Any] = {}
            for k, v in record.items():
                try:
                    json.dumps(v)
                    safe[k] = v
                except (TypeError, ValueError):
                    safe[k] = repr(v)
            record = safe
            print(
                f"[signals] non-serializable value in stream={stream}: {enc_exc}",
                file=sys.stderr,
            )

        # Cap unbounded stream growth: roll the file BEFORE appending when it
        # has crossed the size threshold. Rotation is best-effort and never
        # raises; a failure here must not lose the event we are about to write.
        try:
            from factory.events.rotation import rotate_if_needed

            rot_kwargs: dict[str, int] = {}
            if rotate_max_bytes is not None:
                rot_kwargs["max_bytes"] = rotate_max_bytes
            if rotate_keep is not None:
                rot_kwargs["keep"] = rotate_keep
            rotate_if_needed(path, **rot_kwargs)
        except Exception as rot_exc:  # noqa: BLE001 - telemetry path, never fail
            print(f"[signals] rotation check failed stream={stream!r}: {rot_exc}", file=sys.stderr)

        def _append(line: str) -> None:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line)

        # Stamp the tamper-evident chain fields (chain_id, seq, prev_hash,
        # entry_hash) and append, all under one lock, so this stream's history
        # can be verified rather than merely trusted.
        #
        # Deliberately fail-open: if the chain cannot be used (no fcntl,
        # unwritable head file) nothing has been written yet and we fall through
        # to a plain unchained append. Losing an event is never acceptable;
        # losing its link is — and `factory audit-chain` reports unchained rows
        # explicitly rather than treating their absence as proof of integrity.
        chained = False
        try:
            from factory.observability.audit_chain import append_chained

            chained = append_chained(directory, stream, record, _append)
        except Exception as chain_exc:  # noqa: BLE001 - never lose the event
            print(
                f"[signals] chain stamp failed stream={stream!r}: {chain_exc}",
                file=sys.stderr,
            )
        if not chained:
            _append(json.dumps(record) + "\n")
    except Exception as exc:  # noqa: BLE001
        # Best-effort: never crash a tick on a telemetry-append failure. But
        # never swallow it silently either — bump an observable counter and log
        # loudly at error level so the failure to record a signal is itself a
        # visible anomaly. We deliberately do NOT recurse into write_alert_event
        # here: if the events dir is unwritable, the alert write would fail too.
        global _write_failure_count
        _write_failure_count += 1
        print(
            f"[signals] ANOMALY write_event stream={stream!r} failed "
            f"(total_failures={_write_failure_count}): {exc}",
            file=sys.stderr,
        )


def write_alert_event(
    kind: str,
    detail: str,
    *,
    severity: str = "critical",
    software_factory_root: Path | None = None,
    **fields: Any,
) -> None:
    """Emit a loud, visible control-plane alert.

    Writes an ``event="alert"`` record to ``state/events/alerts.ndjson`` AND
    prints an unmistakable line to stderr. Used by the fail-safe paths in
    ``halt`` and ``circuit_breaker`` (and by control-plane write-failure
    handlers) so that an operator and the FMS watcher can SEE when the factory
    could not determine or record its own control state.

    Best-effort like every other signal writer: the stderr line is emitted
    FIRST so it is guaranteed even if the event write itself fails.

    Parameters
    ----------
    kind:
        Short discriminator, e.g. ``"halt_unreadable"`` or
        ``"circuit_breaker_state_corrupt"``.
    detail:
        Human-readable description of what went wrong.
    severity:
        ``"critical"`` (default), ``"error"``, or ``"warning"``.
    **fields:
        Extra structured fields merged into the alert record.
    """
    # Loud stderr first — guaranteed even if the disk is gone.
    print(
        f"[ALERT:{severity.upper()}] {kind}: {detail}",
        file=sys.stderr,
    )
    payload: dict[str, Any] = {
        "event": "alert",
        "kind": kind,
        "severity": severity,
        "detail": detail,
    }
    payload.update(fields)
    write_event(ALERT_STREAM, payload, software_factory_root=software_factory_root)


# --------------------------------------------------------------------------- #
# Per-stream convenience wrappers
# --------------------------------------------------------------------------- #


def write_run_event(
    *,
    started_at: str,
    ended_at: str,
    duration_s: float | None,
    cost_usd: float,
    success: bool,
    error: str | None,
    tokens_in: int,
    tokens_out: int,
    model: str,
    model_tier: str | None,
    attempt_n: int,
    story_id: int | None,
    persona: str,
    worktree_path: str | None = None,
    tick_id: str | None = None,
    software_factory_root: Path | None = None,
) -> None:
    """Append one record to ``state/events/runs.ndjson``."""
    write_event(
        "runs",
        {
            "event": "run",
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_s": duration_s,
            "cost_usd": cost_usd,
            "success": success,
            "error": error,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "model": model,
            "model_tier": model_tier,
            "attempt_n": attempt_n,
            "story_id": story_id,
            "persona": persona,
            "worktree_path": worktree_path,
            "tick_id": tick_id,
        },
        software_factory_root=software_factory_root,
    )


def write_tick_event(
    event: str,
    *,
    tick_id: str,
    app: str,
    dry_run: bool,
    duration_s: float | None = None,
    stories_advanced: int | None = None,
    stories_blocked: int | None = None,
    errors: int | None = None,
    skipped: int | None = None,
    merges_attempted: int | None = None,
    success: bool | None = None,
    exception: str | None = None,
    software_factory_root: Path | None = None,
) -> None:
    """Append a ``tick_start`` or ``tick_end`` record to ``state/events/ticks.ndjson``.

    ``skipped`` is the count of rows the tick QUARANTINED this cycle (invalid-enum
    "poisoned" rows the poisoned-row guard skips non-fatally, see
    ``TickSummary.skipped``). It is optional and defaults to omitted so existing
    callers stay unaffected; when passed, it carries the skip count into the
    ``tick_end`` signal so the FMS can escalate a persistent poisoned row rather
    than let it be silently re-skipped every tick.
    """
    payload: dict[str, Any] = {
        "event": event,
        "tick_id": tick_id,
        "app": app,
        "dry_run": dry_run,
    }
    if duration_s is not None:
        payload["duration_s"] = duration_s
    if stories_advanced is not None:
        payload["stories_advanced"] = stories_advanced
    if stories_blocked is not None:
        payload["stories_blocked"] = stories_blocked
    if errors is not None:
        payload["errors"] = errors
    if skipped is not None:
        payload["skipped"] = skipped
    if merges_attempted is not None:
        payload["merges_attempted"] = merges_attempted
    if success is not None:
        payload["success"] = success
    if exception is not None:
        payload["exception"] = exception
    write_event("ticks", payload, software_factory_root=software_factory_root)


def write_queue_snapshot(
    *,
    app: str,
    counts_by_state: dict[str, int],
    software_factory_root: Path | None = None,
) -> None:
    """Append one record to ``state/events/queue.ndjson``."""
    write_event(
        "queue",
        {
            "event": "queue_snapshot",
            "app": app,
            "counts_by_state": counts_by_state,
        },
        software_factory_root=software_factory_root,
    )


def write_webhook_event(
    *,
    source: str,
    kind: str,
    story_id: int | None = None,
    payload_excerpt: str = "",
    software_factory_root: Path | None = None,
) -> None:
    """Append one record to ``state/events/webhooks.ndjson``."""
    write_event(
        "webhooks",
        {
            "event": "webhook",
            "source": source,
            "kind": kind,
            "story_id": story_id,
            "payload_excerpt": payload_excerpt[:500],
        },
        software_factory_root=software_factory_root,
    )


def write_git_event(
    *,
    kind: str,
    story_id: int | None = None,
    worktree_path: str | None = None,
    commit_sha: str | None = None,
    pr_number: int | None = None,
    result: str = "ok",
    error: str | None = None,
    software_factory_root: Path | None = None,
) -> None:
    """Append one record to ``state/events/git.ndjson``.

    ``kind`` must be one of: ``worktree_create``, ``worktree_destroy``,
    ``commit``, ``push``, ``pr_open``, ``pr_close``, ``pr_merge``,
    ``auto_merge_attempt``.
    """
    write_event(
        "git",
        {
            "event": "git_op",
            "kind": kind,
            "story_id": story_id,
            "worktree_path": worktree_path,
            "commit_sha": commit_sha,
            "pr_number": pr_number,
            "result": result,
            "error": error,
        },
        software_factory_root=software_factory_root,
    )


def write_spend_snapshot(
    *,
    today_usd: float,
    last_hour_usd: float,
    projected_eod_usd: float,
    daily_cap_usd: float,
    hourly_cap_usd: float,
    by_persona: dict[str, float],
    software_factory_root: Path | None = None,
) -> None:
    """Append one record to ``state/events/spend.ndjson``."""
    write_event(
        "spend",
        {
            "event": "spend_snapshot",
            "today_usd": today_usd,
            "last_hour_usd": last_hour_usd,
            "projected_eod_usd": projected_eod_usd,
            "daily_cap_usd": daily_cap_usd,
            "hourly_cap_usd": hourly_cap_usd,
            "by_persona": by_persona,
        },
        software_factory_root=software_factory_root,
    )
