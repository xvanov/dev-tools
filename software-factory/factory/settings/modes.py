"""Runtime factory mode: a single mutable value in ``state/factory.db``.

The set of allowed mode names lives in ``factory_settings.yaml``; the
CURRENT mode is mutable runtime state and lives in a tiny dedicated
table here. Keeping it out of the YAML means an operator can flip the
mode without committing a config change.

Default mode is read from ``factory_settings.yaml::modes.default`` on
first read.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlmodel import Field, Session, SQLModel, create_engine, select

from factory.settings.loader import FactorySettings, is_valid_mode, load_settings


class FactoryState(SQLModel, table=True):
    """Single-row global state for the factory.

    The row with ``id=1`` is canonical; all reads/writes target it. This
    keeps the schema simple — there is only ever one current mode.
    """

    __tablename__ = "factory_state"

    id: int | None = Field(default=1, primary_key=True)
    mode: str = "normal"


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    return eng


def get_mode(software_factory_root: Path, *, db_path: Path | None = None) -> str:
    """Return the current factory mode (default from YAML on first read)."""
    settings = load_settings(software_factory_root)
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    with Session(eng) as session:
        row = session.exec(select(FactoryState).where(FactoryState.id == 1)).first()
        if row is None:
            row = FactoryState(id=1, mode=settings.modes.default)
            session.add(row)
            session.commit()
            session.refresh(row)
        return row.mode


def set_mode(
    new_mode: str,
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
    settings: FactorySettings | None = None,
) -> str:
    """Persist ``new_mode``. Raises ValueError if not in the available set."""
    settings = settings or load_settings(software_factory_root)
    if not is_valid_mode(new_mode, settings):
        raise ValueError(f"mode={new_mode!r} not allowed; available={settings.modes.available!r}")
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    with Session(eng) as session:
        row = session.exec(select(FactoryState).where(FactoryState.id == 1)).first()
        if row is None:
            row = FactoryState(id=1, mode=new_mode)
        else:
            row.mode = new_mode
        session.add(row)
        session.commit()
    return new_mode
