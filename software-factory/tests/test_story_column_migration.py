"""Regression: existing factory.db gains new StoryRecord columns on migrate.

The unit suite creates a fresh DB from the model (all columns present), so a
missing entry in ``_MIGRATION_COLUMNS`` is invisible to it — but the LIVE
factory.db predates newly-added columns and raises ``no such column`` on the
first read. This test simulates that: build a ``stories`` table missing the
Tier-1 columns, run the migration, and assert every declared migration column
is present and idempotent. It is the guard that would have caught the budget
breaker's fields (total_attempts/total_spend_usd) shipping without a migration.
"""

from __future__ import annotations

from sqlalchemy import create_engine, text

from factory.chain.handlers import _MIGRATION_COLUMNS, _ensure_story_columns

# The Tier-1 columns whose absence would break a real deploy.
_TIER1_COLUMNS = {
    "total_attempts",
    "total_spend_usd",
    "acceptance_test_ref",
    "acceptance_expected",
}


def _legacy_engine(tmp_path):
    """A stories table with only the original pre-migration columns."""
    eng = create_engine(f"sqlite:///{tmp_path/'legacy.db'}", echo=False)
    with eng.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE stories ("
                "id INTEGER PRIMARY KEY, app TEXT, slug TEXT, state TEXT)"
            )
        )
    return eng


def _columns(eng) -> set[str]:
    with eng.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(stories)")).fetchall()
    return {r[1] for r in rows}


def test_tier1_columns_declared_in_migration_map():
    # Fields exist on the model AND in the migration map — the invariant the
    # budget breaker violated.
    for col in _TIER1_COLUMNS:
        assert col in _MIGRATION_COLUMNS, f"{col} missing from _MIGRATION_COLUMNS"


def test_legacy_db_gains_all_migration_columns(tmp_path):
    eng = _legacy_engine(tmp_path)
    before = _columns(eng)
    for col in _TIER1_COLUMNS:
        assert col not in before  # genuinely absent to start

    _ensure_story_columns(eng)

    after = _columns(eng)
    for col in _MIGRATION_COLUMNS:
        assert col in after, f"{col} not added by migration"


def test_migration_is_idempotent(tmp_path):
    eng = _legacy_engine(tmp_path)
    _ensure_story_columns(eng)
    # Second run must not raise (columns already present).
    _ensure_story_columns(eng)
    assert _TIER1_COLUMNS <= _columns(eng)


def test_migrated_budget_columns_default_to_zero(tmp_path):
    eng = _legacy_engine(tmp_path)
    with eng.begin() as conn:
        conn.execute(
            text("INSERT INTO stories (id, app, slug, state) VALUES (1,'x','s','story_created')")
        )
    _ensure_story_columns(eng)
    with eng.begin() as conn:
        row = conn.execute(
            text("SELECT total_attempts, total_spend_usd FROM stories WHERE id=1")
        ).fetchone()
    assert row[0] == 0
    assert row[1] == 0
