"""Complete runtime trace of every story state change (the conformance emitter).

Why this exists
---------------
``chain_steps.ndjson`` records a story's progression, but it is emitted from
exactly TWO places (both inside the orchestrator tick), while sixteen sites
across ``auto_merge``, ``recovery``, ``dual_draft``, ``orchestrator``,
``handlers`` and ``webhook`` assign ``story.state`` directly. Every one of
those hops is invisible in that stream, so the factory cannot prove what its
own control plane did — and the FMS cannot see a state change nobody recorded.

Design: listen on the ORM, not on call sites
--------------------------------------------
The obvious hook is ``handlers.persist_story``, but it is NOT the choke point
it looks like: ten writers use their own ``Session`` and never call it
(``dual_draft`` retiring a superseded sibling, three ``recovery`` playbooks,
four ``auto_merge`` paths, two ``webhook`` handlers). Instrumenting call sites
would therefore be silently incomplete — the exact failure mode this module
exists to detect.

Instead we register a mapper-level ``after_update`` listener on
``StoryRecord``. That fires for every flush of the row through SQLModel
regardless of which session, engine, or module performed it, so coverage is
complete by construction rather than by discipline. No call site changes.

The one thing a mapper listener cannot guarantee on its own is that it was
*registered* before the write. :func:`install` is therefore called at import
time by every package that contains a story writer, and
``tests/test_state_trace.py`` re-derives the writer set from the AST and fails
if an uninstrumented writer appears. That test is the coverage gate — without
it this module is decorative logging (see ``buzz-conformance``, whose
"coverage breach is load-bearing" note is the same argument).

Best-effort, always: the listener runs inside a flush, so a telemetry failure
must never poison a transaction. Every path is wrapped and swallowed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Bare stream name (→ ``state/events/state_writes.ndjson``) and the event
# discriminator every record carries.
STATE_WRITE_STREAM = "state_writes"
STATE_WRITE_EVENT = "state_write"

# Frames to skip when attributing a write to a writer. These are plumbing:
# naming them as the writer would tell an operator nothing about WHICH code
# path changed the state. ``persist_story`` is the shared persistence helper —
# its caller is the interesting frame.
_PLUMBING_FUNCTIONS = frozenset(
    {
        "persist_story",
        "_engine",
        "_record_state_write",
        "_after_update",
        "install",
    }
)

# Path fragments identifying frames that are library machinery rather than
# factory code. Matched against the frame's filename.
#
# ``<`` catches pseudo-filenames like ``<string>`` and ``<frozen importlib…>``:
# SQLAlchemy's flush path runs through exec-generated functions whose frames
# carry no real filename, so a fragment match on "sqlalchemy" alone attributes
# every write to ``<string>._prepare_impl``.
_LIBRARY_PATH_FRAGMENTS = ("sqlalchemy", "sqlmodel", "/observability/state_trace.py")

# Module-level guard so repeated ``install()`` calls (one per writer package)
# register the listener exactly once.
_installed = False

# Overridable root for the event stream. ``None`` means "resolve the same way
# every other signal writer does" (explicit arg → FACTORY_STATE_ROOT → cwd),
# which is what keeps test writes out of the production stream.
_root_override: Path | None = None


def set_root_override(root: Path | None) -> None:
    """Point emitted records at ``root`` instead of the ambient resolution.

    A mapper listener has no call-site parameters, so unlike
    ``emit_chain_step`` it cannot be handed a ``software_factory_root``. Tests
    that need to assert on the stream set this explicitly; production leaves it
    unset and inherits ``FACTORY_STATE_ROOT`` / cwd from
    ``factory.manager.signals``.
    """
    global _root_override
    _root_override = Path(root) if root is not None else None


def _attribute_writer() -> str:
    """Return ``module.function`` for the code that caused this write.

    Walks out of the SQLAlchemy flush machinery to the first factory frame that
    is not shared plumbing. Uses ``sys._getframe`` rather than
    ``inspect.stack()``: the latter reads source files for context lines, which
    is far too expensive to run on every state change.

    Returns ``"unknown"`` when attribution fails — which the conformance
    checker treats as a coverage breach rather than silently accepting.
    """
    try:
        depth = 1
        while depth < 60:
            try:
                frame = sys._getframe(depth)
            except ValueError:  # walked off the top of the stack
                break
            filename = frame.f_code.co_filename
            name = frame.f_code.co_name
            if filename.startswith("<") or any(
                frag in filename for frag in _LIBRARY_PATH_FRAGMENTS
            ):
                depth += 1
                continue
            if name in _PLUMBING_FUNCTIONS:
                depth += 1
                continue
            module = Path(filename).stem
            return f"{module}.{name}"
        return "unknown"
    except Exception:  # noqa: BLE001 - attribution must never break a flush
        return "unknown"


def _emit(payload: dict[str, Any]) -> None:
    try:
        from factory.manager.signals import write_event

        write_event(
            STATE_WRITE_STREAM,
            payload,
            software_factory_root=_root_override,
        )
    except Exception:  # noqa: BLE001 - telemetry path, never break a flush
        pass


def record_state_write(
    story: Any,
    *,
    from_state: str | None,
    to_state: str,
    writer: str | None = None,
) -> None:
    """Append one ``state_write`` record. Exposed for tests and direct use."""
    _emit(
        {
            "event": STATE_WRITE_EVENT,
            "story_id": getattr(story, "id", None),
            "app": getattr(story, "app", None),
            "slug": getattr(story, "slug", None),
            "chain_kind": getattr(story, "chain_kind", None),
            "from_state": from_state,
            "to_state": to_state,
            "writer": writer or _attribute_writer(),
        }
    )


def install() -> None:
    """Register the ``after_update`` listener on ``StoryRecord``. Idempotent.

    Safe to call from many modules; only the first call registers. Imports are
    deferred so this module stays importable from anywhere without dragging in
    the ORM at import time.
    """
    global _installed
    if _installed:
        return
    try:
        from sqlalchemy import event
        from sqlalchemy.orm.attributes import get_history

        from factory.chain.state_machine import StoryRecord

        def _after_update(_mapper: Any, _connection: Any, target: Any) -> None:
            try:
                history = get_history(target, "state")
                if not history.deleted and not history.added:
                    return  # this flush did not touch ``state``
                old = history.deleted[0] if history.deleted else None
                new = history.added[0] if history.added else getattr(target, "state", None)
                if new is None or old == new:
                    return
                record_state_write(
                    target,
                    from_state=str(old) if old is not None else None,
                    to_state=str(new),
                )
            except Exception:  # noqa: BLE001 - inside a flush; never raise
                pass

        event.listen(StoryRecord, "after_update", _after_update)
        _installed = True
    except Exception:  # noqa: BLE001 - a telemetry install must never break import
        pass


def _ordered_segments(directory: Path) -> list[Path]:
    """Stream files oldest-first: rotated ``.N`` (highest N = oldest) then live.

    Mirrors ``factory.chain.step_events._ordered_segments`` — the streams share
    the same size-based rotation, so any reader must handle segments the same
    way or it will replay history out of order.
    """
    base = directory / f"{STATE_WRITE_STREAM}.ndjson"
    try:
        rotated = sorted(
            directory.glob(f"{STATE_WRITE_STREAM}.ndjson.*"),
            key=lambda p: int(p.suffix.lstrip(".")) if p.suffix.lstrip(".").isdigit() else 0,
            reverse=True,
        )
    except OSError:
        rotated = []
    return [*rotated, base]


def read_state_writes(
    *,
    software_factory_root: Path | None = None,
    story_id: int | None = None,
) -> list[dict[str, Any]]:
    """Replay the ``state_writes`` stream in append order. Read-only.

    Filters to ``story_id`` when given. Malformed lines are skipped rather than
    raising: a partially-written final line (crash mid-append) must not make an
    entire history unreadable.
    """
    import json

    from factory.manager.signals import _events_dir

    directory = _events_dir(software_factory_root or _root_override)
    out: list[dict[str, Any]] = []
    for segment in _ordered_segments(directory):
        if not segment.exists():
            continue
        try:
            with segment.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(record, dict):
                        continue
                    if record.get("event") != STATE_WRITE_EVENT:
                        continue
                    if story_id is not None and record.get("story_id") != story_id:
                        continue
                    out.append(record)
        except OSError:
            continue
    return out
