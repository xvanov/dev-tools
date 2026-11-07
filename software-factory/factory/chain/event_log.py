"""Per-story event log — write-only audit trail of chain activity.

Every important transition (handler start/end, retry, exhausted-retries
commit, JSON-truncation retry, sandbox failure, etc.) appends a JSONL
record to ``state/logs/<story_id>-<slug>.log``. The log is the source
of truth when an operator runs ``factory why <id>`` — the chain's own
internal state tells you *what* state a story is in; the event log
tells you *how it got there* and *why it failed*.

Design notes:
  * Append-only JSONL. One event per line. UTC timestamps. No locking
    — concurrent writes are serialized by the orchestrator's per-repo
    cap; if that ever changes, we can swap to ``fcntl.flock`` later.
  * Best-effort: a logging failure must never bubble out of a handler.
    Every call is wrapped in ``try/except`` so a missing directory or
    permission glitch can't take down a real-run tick.
  * ``state/logs/`` is the canonical location alongside ``state/factory.db``.
    Per-story files keep ``factory why`` fast (no scan over the whole
    history); ``factory.db`` row IDs are stable so the filename never
    changes for a given story.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _logs_dir(software_factory_root: Path | None) -> Path:
    root = Path(software_factory_root) if software_factory_root else Path.cwd()
    return root / "state" / "logs"


def _story_log_path(
    story_id: int | None,
    software_factory_root: Path | None,
    slug_hint: str = "",
) -> Path | None:
    if story_id is None:
        return None
    slug = (slug_hint or "story").strip().replace("/", "-").replace(" ", "-")
    return _logs_dir(software_factory_root) / f"{story_id:04d}-{slug[:60] or 'story'}.log"


def log_story_event(
    story_id: int | None,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    software_factory_root: Path | None = None,
    slug_hint: str = "",
) -> None:
    """Append one JSONL record to the story's log.

    Best-effort: any I/O error is swallowed (logged once to stderr via
    ``print``) so a chain handler never crashes because of audit logging.

    Schema of a record:
      {"ts": "...", "story_id": N, "event": "...", **payload}

    Common ``event_type`` values:
      * ``handler_start`` / ``handler_end``
      * ``dispatch_rejected``
      * ``persona_call`` (per LLM round-trip, with tokens + cost)
      * ``test_command`` (with exit code + tail of output)
      * ``json_retry`` (truncation auto-retry kicked in)
      * ``dev_retry``  /  ``dev_exhausted``
      * ``commit`` / ``push``
      * ``handler_exception``
    """
    path = _story_log_path(story_id, software_factory_root, slug_hint)
    if path is None:
        return
    record = {
        "ts": datetime.now(UTC).isoformat(),
        "story_id": story_id,
        "event": event_type,
    }
    if payload:
        # Filter out non-serializable values defensively.
        for key, val in payload.items():
            try:
                json.dumps(val)
                record[key] = val
            except (TypeError, ValueError):
                record[key] = repr(val)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as exc:
        # Last-resort fallback — never escalate. Stderr makes the failure
        # visible to operators tailing logs without affecting the chain.
        import sys

        print(f"[event_log] failed to write {path}: {exc}", file=sys.stderr)


def read_story_events(
    story_id: int,
    *,
    software_factory_root: Path | None = None,
    slug_hint: str = "",
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Return the JSONL records for a story, oldest first.

    Returns an empty list if the log file doesn't exist or can't be
    parsed. ``limit`` returns the most-recent N events when set.
    """
    path = _story_log_path(story_id, software_factory_root, slug_hint)
    if path is None or not path.exists():
        return []
    out: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    rec = None
                if not isinstance(rec, dict):
                    # Either undecodable or valid JSON that isn't an object
                    # (a bare int/str) — callers expect dicts with .get().
                    rec = {"event": "malformed_log_line", "raw": line}
                out.append(rec)
    except OSError:
        return []
    if limit is not None and limit > 0:
        out = out[-limit:]
    return out
