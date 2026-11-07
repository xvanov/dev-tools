"""D005 — provider-secret redaction from persisted run error text."""

from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, select

from factory.runner import Run, _engine, _record_run, redact_secrets

# ---------------------------------------------------------------------------
# Pure helper tests (no DB)
# ---------------------------------------------------------------------------


def test_redact_sk_openai_token():
    """AC1.1 / AC4.1: sk-... token is replaced with [REDACTED]."""
    assert redact_secrets("Error: API key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 is bad") == (
        "Error: API key [REDACTED] is bad"
    )


def test_redact_sk_ant_anthropic_token():
    """AC1.1: sk-ant-... token is replaced with [REDACTED]."""
    assert redact_secrets(
        "Bad key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop"
    ) == "Bad key: [REDACTED]"


def test_redact_bearer_header():
    """AC1.2 / AC4.2: Bearer token is replaced with [REDACTED]."""
    assert redact_secrets("401: Bearer abcdefghijklmnopqrstuvwxyz0123456789") == (
        "401: [REDACTED]"
    )


def test_redact_authorization_header():
    """AC1.3 / AC4.2: Authorization header value is replaced with [REDACTED]."""
    assert redact_secrets(
        "Failed: Authorization: Bearer sk-ant-api03-abcdefghijklmnop"
    ) == "Failed: [REDACTED]"


def test_redact_long_hex_run():
    """AC1.4: Long hex run (>=64 hex chars) is replaced with [REDACTED]."""
    assert redact_secrets(
        "secret=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef leaked"
    ) == "secret=[REDACTED] leaked"


def test_redact_long_base64_run():
    """AC1.4: Long base64 run (>=32 chars) is replaced with [REDACTED]."""
    assert redact_secrets(
        "key: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"
    ) == "key: [REDACTED]"


def test_redact_multiple_patterns():
    """Multiple patterns in one string are each replaced."""
    result = redact_secrets(
        "sk-abc123def456ghi789jkl012mno345pqr678stu + "
        "Bearer xyzabcdefghijklmnopqrstuvwxyz1234567890"
    )
    assert result == "[REDACTED] + [REDACTED]"


def test_plain_text_unchanged():
    """AC3.2 / AC4.3: Text with no secret pattern is byte-for-byte unchanged."""
    plain = "something went wrong with the request: timeout after 30s"
    assert redact_secrets(plain) == plain
    assert redact_secrets(plain).encode("utf-8") == plain.encode("utf-8")


def test_short_text_not_redacted():
    """Short hex (below base64-run threshold) is unchanged — only long runs are flagged."""
    text = "short sha abcdef12 and error code E1234"
    assert redact_secrets(text) == text


def test_already_redacted_with_new_secret_still_redacts():
    """A string containing [REDACTED] AND a raw secret must still scrub the raw secret.

    This is the regression test for the reviewer finding: the old idempotency
    short-circuit returned early whenever [REDACTED] appeared anywhere,
    leaving raw secrets in the same string untouched.
    """
    result = redact_secrets(
        "Already redacted: [REDACTED] but here is a new sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"
    )
    assert result == "Already redacted: [REDACTED] but here is a new [REDACTED]"


def test_idempotent():
    """AC3.1: Re-redacting already-redacted text is a no-op."""
    redacted = "Error: [REDACTED] and [REDACTED] happened"
    result = redact_secrets(redacted)
    assert result == redacted
    assert result.encode("utf-8") == redacted.encode("utf-8")


def test_none_error_handled(tmp_path: Path):
    """_record_run with error=None should persist None without crashing."""
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


# ---------------------------------------------------------------------------
# Persistence-path tests (DB required)
# ---------------------------------------------------------------------------


def test_record_run_redacts_secret_in_error(tmp_path: Path):
    """AC2.1 / AC2.2 / AC4.4: _record_run stores [REDACTED] for a secret-bearing error."""
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
        error="LLM call failed: sk-proj-mysecretkey12345678901234567890 and request aborted",
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
    assert "sk-proj" not in stored_error
    assert "[REDACTED]" in stored_error
    assert stored_error == (
        "LLM call failed: [REDACTED] and request aborted"
    )


def test_record_run_preserves_clean_error(tmp_path: Path):
    """_record_run with a clean error stores it verbatim."""
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
        error="timeout after 30s",
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
    assert rows[0].error == "timeout after 30s"
