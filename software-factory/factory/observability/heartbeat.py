"""Live-handler heartbeat helpers.

A ``live_handlers`` row is inserted when a runner enters and deleted when
it exits, so the TUI can show what's *currently* executing. Stale rows
(from crashed processes) are reaped on every read by checking the
recorded pid against ``os.kill(pid, 0)``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import Session, create_engine, select

from factory.observability.schema import LiveHandler, migrate


def _engine(db_path: Path):
    migrate(db_path)
    return create_engine(f"sqlite:///{db_path}", echo=False)


def start_heartbeat(
    db_path: Path,
    *,
    persona: str,
    model: str,
    mode: str,
    story_id: int | None = None,
    app: str | None = None,
    direction_id: str | None = None,
) -> int:
    """Insert a ``live_handlers`` row and return its id."""
    engine = _engine(db_path)
    with Session(engine) as session:
        row = LiveHandler(
            started_at=datetime.now(UTC).isoformat(),
            persona=persona,
            model=model,
            mode=mode,
            story_id=story_id,
            app=app,
            direction_id=direction_id,
            pid=os.getpid(),
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        assert row.id is not None
        return row.id


def end_heartbeat(db_path: Path, hb_id: int) -> None:
    """Delete the heartbeat row identified by ``hb_id``. Idempotent."""
    engine = _engine(db_path)
    with Session(engine) as session:
        row = session.get(LiveHandler, hb_id)
        if row is not None:
            session.delete(row)
            session.commit()


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False  # pid does not exist
    except PermissionError:
        return True  # exists, owned by a different uid — still alive
    except OSError:
        return False
    return True


def reap_stale_heartbeats(db_path: Path) -> int:
    """Delete heartbeat rows whose pid is no longer alive. Returns count."""
    engine = _engine(db_path)
    removed = 0
    with Session(engine) as session:
        rows = list(session.exec(select(LiveHandler)).all())
        for r in rows:
            if not _pid_alive(r.pid):
                session.delete(r)
                removed += 1
        if removed:
            session.commit()
    return removed


@contextmanager
def live_handler(
    db_path: Path,
    *,
    persona: str,
    model: str,
    mode: str,
    story_id: int | None = None,
    app: str | None = None,
    direction_id: str | None = None,
) -> Iterator[None]:
    """Context manager: inserts a heartbeat on enter, deletes on exit.

    Use as::

        with live_handler(db_path, persona="dev", model=m, mode="sandbox",
                          story_id=story.id, app=story.app):
            ...do the work...
    """
    hb_id = start_heartbeat(
        db_path,
        persona=persona,
        model=model,
        mode=mode,
        story_id=story_id,
        app=app,
        direction_id=direction_id,
    )
    try:
        yield
    finally:
        try:
            end_heartbeat(db_path, hb_id)
        except Exception:
            pass
