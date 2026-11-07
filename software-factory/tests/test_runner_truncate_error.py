"""D007 — bound persisted run error text length."""

from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, select

from factory.runner import _DEFAULT_ERROR_MAX_LENGTH, Run, _engine, _record_run, truncate_error

# ---------------------------------------------------------------------------
# Pure helper tests (no DB)
# ---------------------------------------------------------------------------


def test_truncate_error_under_bound_returns_unchanged():
    """AC1.1 / AC3.1: text at or under the bound is returned verbatim."""
    text = "short error"
    assert truncate_error(text, max_length=100) == text
    assert truncate_error(text, max_length=100).encode("utf-8") == text.encode("utf-8")


def test_truncate_error_at_bound_returns_unchanged():
    """AC3.1: text exactly at the bound is returned unchanged."""
    text = "a" * 50
    assert truncate_error(text, max_length=50) == text


def test_truncate_error_over_bound_truncates_with_marker():
    """AC1.1: over-long text is truncated with a marker indicating chars removed."""
    text = "a" * 100
    result = truncate_error(text, max_length=50)
    # Total output (including marker) must fit within max_length
    assert len(result) <= 50
    assert "...[truncated " in result
    assert "chars]" in result
    # The truncated portion is the prefix of the original
    marker_start = result.index("...[truncated ")
    assert text.startswith(result[:marker_start])


def test_truncate_error_default_max_length():
    """AC1.2: default max_length is 4000."""
    assert _DEFAULT_ERROR_MAX_LENGTH == 4000
    text = "x" * 200_000
    result = truncate_error(text)
    # Total output fits within the default bound
    assert len(result) <= _DEFAULT_ERROR_MAX_LENGTH
    assert "...[truncated " in result
    assert "chars]" in result
    # The prefix before the marker matches the original text
    marker_start = result.index("...[truncated ")
    assert text.startswith(result[:marker_start])


def test_truncate_error_idempotent():
    """AC3.2 / AC3.3: repeated application is idempotent."""
    text = "x" * 200_000
    first = truncate_error(text)
    second = truncate_error(first)
    assert first == second
    assert len(first) <= _DEFAULT_ERROR_MAX_LENGTH


def test_truncate_error_idempotent_on_within_bound_text():
    """AC3.2: text within bound is returned unchanged on repeated calls."""
    text = "normal error message"
    first = truncate_error(text)
    second = truncate_error(first)
    assert first == text
    assert second == text


def test_truncate_error_idempotent_on_previously_truncated_text():
    """AC3.3: previously truncated output is unchanged on reapplication."""
    text = "y" * 6000
    first = truncate_error(text, max_length=300)
    second = truncate_error(first, max_length=300)
    third = truncate_error(second, max_length=300)
    assert first == second
    assert second == third


# ---------------------------------------------------------------------------
# Persistence-path tests (DB required)
# ---------------------------------------------------------------------------


def test_record_run_truncates_long_error(tmp_path: Path):
    """AC4.1: over-long error is truncated with marker on the persistence path."""
    db = tmp_path / "state" / "factory.db"
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)

    # Use a character that won't match the hex/base64 secret patterns so
    # redact_secrets is a no-op and we test truncation in isolation.
    long_error = "@" * 200_000

    _record_run(
        persona="dev",
        model="stub/model",
        mode="text-dry-run",
        tokens_in=0,
        tokens_out=0,
        cost_usd=0.0,
        success=False,
        story_path=None,
        repo_path=None,
        error=long_error,
        db_path=db,
        duration_s=0.5,
        story_id=99,
        model_tier="standard",
        software_factory_root=tmp_path,
    )

    eng = _engine(db)
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    assert len(rows) == 1
    stored_error = rows[0].error
    assert stored_error is not None
    # Total stored error must fit within the bound
    assert len(stored_error) <= _DEFAULT_ERROR_MAX_LENGTH
    assert "...[truncated " in stored_error
    assert "chars]" in stored_error
    # The prefix before the marker matches the original text
    marker_start = stored_error.index("...[truncated ")
    assert long_error.startswith(stored_error[:marker_start])


def test_record_run_stores_short_error_verbatim(tmp_path: Path):
    """AC4.2: short error is stored verbatim on the persistence path."""
    db = tmp_path / "state" / "factory.db"
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)

    short_error = "simple failure"

    _record_run(
        persona="dev",
        model="stub/model",
        mode="text-dry-run",
        tokens_in=0,
        tokens_out=0,
        cost_usd=0.0,
        success=False,
        story_path=None,
        repo_path=None,
        error=short_error,
        db_path=db,
        duration_s=0.5,
        story_id=99,
        model_tier="standard",
        software_factory_root=tmp_path,
    )

    eng = _engine(db)
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    assert len(rows) == 1
    assert rows[0].error == short_error


def test_record_run_truncation_applied_after_redaction(tmp_path: Path):
    """Truncation is applied after redaction: long secret-bearing error is both
    redacted and truncated."""
    db = tmp_path / "state" / "factory.db"
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)

    # Build a long error with a secret embedded in it. Use '@' for the body
    # to avoid matching hex/base64 patterns.
    secret_prefix = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"
    long_body = " @" * 2500  # make it long, '@' won't match hex/base64 pattern
    long_error = secret_prefix + long_body

    _record_run(
        persona="dev",
        model="stub/model",
        mode="text-dry-run",
        tokens_in=0,
        tokens_out=0,
        cost_usd=0.0,
        success=False,
        story_path=None,
        repo_path=None,
        error=long_error,
        db_path=db,
        duration_s=0.5,
        story_id=99,
        model_tier="standard",
        software_factory_root=tmp_path,
    )

    eng = _engine(db)
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    assert len(rows) == 1
    stored = rows[0].error
    assert stored is not None
    # Secret must be redacted
    assert "sk-proj" not in stored
    assert "[REDACTED]" in stored
    # And the result must be bounded
    assert len(stored) <= _DEFAULT_ERROR_MAX_LENGTH


def test_record_run_none_error_persists_none(tmp_path: Path):
    """_record_run with error=None should still persist None after truncation change."""
    db = tmp_path / "state" / "factory.db"
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)

    _record_run(
        persona="sm",
        model="stub/model",
        mode="text-dry-run",
        tokens_in=0,
        tokens_out=0,
        cost_usd=0.0,
        success=False,
        story_path=None,
        repo_path=None,
        error=None,
        db_path=db,
        duration_s=0.5,
        story_id=99,
        model_tier="standard",
        software_factory_root=tmp_path,
    )

    eng = _engine(db)
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    assert len(rows) == 1
    assert rows[0].error is None
