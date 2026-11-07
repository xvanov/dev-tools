"""D003 — attribution threading through ``sandbox_run`` / ``text_run``.

Every chain-persona call site (handle_sm/dev/reviewer/tech_writer/onboarder)
already passes ``story_id``, ``app``, and ``direction_id`` into these two
runner entry points. The bug was that the runner silently dropped ``app``
and ``direction_id`` before writing the ``runs`` row — these tests pin that
the full triple survives into the persisted ``Run`` row, using ``dry_run``
mode so no API key / SDK / network is required.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from sqlmodel import Session, select

from factory.runner import LLMConfig, Run, _engine, sandbox_run, text_run


def _only_row(db_path: Path) -> Run:
    eng = _engine(db_path)
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    assert len(rows) == 1, rows
    return rows[0]


def test_text_run_dry_run_persists_full_attribution_triple(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    text_run(
        persona="sm",
        prompt="irrelevant",
        model_id="stub/model",
        dry_run=True,
        story_id=101,
        app="sacrifice",
        direction_id="d-42",
        db_path=db,
        software_factory_root=tmp_path,
    )
    row = _only_row(db)
    assert row.story_id == 101
    assert row.app == "sacrifice"
    assert row.direction_id == "d-42"


def test_text_run_dry_run_leaves_app_level_attribution_partial(tmp_path: Path) -> None:
    """A scheduled app-level persona (no story yet) stamps ``app`` only —
    story_id/direction_id are legitimately NULL, not a bug."""
    db = tmp_path / "state" / "factory.db"
    text_run(
        persona="security",
        prompt="irrelevant",
        model_id="stub/model",
        dry_run=True,
        app="sacrifice",
        db_path=db,
        software_factory_root=tmp_path,
    )
    row = _only_row(db)
    assert row.story_id is None
    assert row.direction_id is None
    assert row.app == "sacrifice"


def test_sandbox_run_dry_run_persists_full_attribution_triple(tmp_path: Path) -> None:
    story_file = tmp_path / "story.md"
    story_file.write_text("# Story\nbody\n", encoding="utf-8")
    repo = tmp_path / "repo"
    repo.mkdir()
    db = tmp_path / "state" / "factory.db"

    asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story_file,
            repo_path=repo,
            llm_config=LLMConfig(model="stub/model"),
            dry_run=True,
            story_id=202,
            app="sacrifice",
            direction_id="d-7",
            db_path=db,
            software_factory_root=tmp_path,
        )
    )
    row = _only_row(db)
    assert row.story_id == 202
    assert row.app == "sacrifice"
    assert row.direction_id == "d-7"


def test_sandbox_run_dry_run_without_story_still_stamps_known_app(tmp_path: Path) -> None:
    story_file = tmp_path / "story.md"
    story_file.write_text("# Story\nbody\n", encoding="utf-8")
    repo = tmp_path / "repo"
    repo.mkdir()
    db = tmp_path / "state" / "factory.db"

    asyncio.run(
        sandbox_run(
            persona="onboarder",
            story_path=story_file,
            repo_path=repo,
            llm_config=LLMConfig(model="stub/model"),
            dry_run=True,
            app="sacrifice",
            db_path=db,
            software_factory_root=tmp_path,
        )
    )
    row = _only_row(db)
    assert row.story_id is None
    assert row.app == "sacrifice"
