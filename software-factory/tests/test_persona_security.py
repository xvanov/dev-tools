"""Persona-prompt tests for the Security (``security``) persona — P7.0 cleanup.

Mirrors the shape of ``test_persona_ux_auditor.py``: verifies the persona's
markdown prompt declares its Operating contract
and requires structured JSON output. The Phase-6 behavioral tests for
the security scheduled run live in ``test_security.py``; this file is
purely the prompt-content audit.
"""

from __future__ import annotations

from pathlib import Path

_FACTORY_ROOT = Path(__file__).resolve().parent.parent
_PERSONA_PATH = _FACTORY_ROOT / "factory" / "personas" / "security.md"


def test_persona_security_prompt_exists() -> None:
    """Security persona prompt must be on disk at the canonical location."""
    assert _PERSONA_PATH.exists(), f"missing persona file: {_PERSONA_PATH}"


def test_persona_security_prompt_has_operating_contract() -> None:
    """P7.0 cleanup: every persona prompt must declare its Operating contract."""
    body = _PERSONA_PATH.read_text(encoding="utf-8")
    assert "## Operating contract" in body, "security.md missing 'Operating contract' section"


def test_persona_security_prompt_requires_json_output() -> None:
    """P7.0 cleanup: Security emits structured JSON; the prompt must say so."""
    body = _PERSONA_PATH.read_text(encoding="utf-8")
    assert "JSON" in body, "security.md missing JSON output requirement"
    assert "```json" in body, "security.md missing fenced JSON output schema"
