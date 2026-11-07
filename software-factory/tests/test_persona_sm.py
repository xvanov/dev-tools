"""Tests for the SM (Scrum Master) persona prompt constraints.

Verifies that the SM persona prompt documents the output-size budget
constraint that prevents the 114k-token overflow incident. The incident
occurred because SM was emitting verbatim copies of flow.md + api_spec.md
in every story's Dev Notes — multiplying those large documents by the
story count and blowing past every model's max_tokens cap.

Tests here are prompt-content assertions (no LLM / no GitHub).
"""

from __future__ import annotations

from pathlib import Path

_FACTORY_ROOT = Path(__file__).resolve().parent.parent
_SM_PERSONA_PATH = _FACTORY_ROOT / "factory" / "personas" / "sm.md"


def test_sm_persona_prompt_includes_output_size_guidance() -> None:
    """The SM persona MUST document an explicit token-budget / terse-output
    instruction so the 114k-overflow incident cannot recur silently.

    Regression: before this fix SM asked for verbatim embed of flow.md +
    api_spec.md in EVERY story, multiplying those docs by the story count and
    hitting every model's max_tokens cap.
    """
    body = _SM_PERSONA_PATH.read_text(encoding="utf-8")

    # The budget section must exist.
    assert "Output-size budget" in body, (
        "sm.md missing 'Output-size budget' section — required to prevent "
        "the 114k-token overflow incident from recurring"
    )

    # An explicit numeric upper bound must be stated (token count or keyword).
    # We check for the phrase used in the section header.
    assert "16,000" in body or "20,000" in body, (
        "sm.md must state a numeric token budget in the Output-size budget section"
    )

    # The cross-reference pattern for verbatim embeds must be documented.
    assert "cross-reference" in body or "see <" in body, (
        "sm.md must document the cross-reference form for verbatim embeds so "
        "flow.md / api_spec.md are not copied into every story"
    )


def test_sm_persona_prompt_verbatim_embed_is_scope_conditional() -> None:
    """The verbatim-embed rule must be scope-conditional (not blanket-copy
    into every story), which was the direct cause of the token explosion.
    """
    body = _SM_PERSONA_PATH.read_text(encoding="utf-8")

    # The operating contract must qualify which stories get the verbatim embed.
    assert "scope" in body.lower(), (
        "sm.md must mention scope in the verbatim-embed rule"
    )
    # The cross-reference escape hatch must exist.
    assert "verbatim embed" in body, (
        "sm.md must retain the verbatim-embed requirement (just scoped, not removed)"
    )


def test_sm_persona_prompt_has_truncated_indicator_escape_hatch() -> None:
    """SM must document the TRUNCATED_INDICATOR escape hatch so the chain can
    detect and handle partial output rather than silently losing stories.
    """
    body = _SM_PERSONA_PATH.read_text(encoding="utf-8")
    assert "TRUNCATED_INDICATOR" in body, (
        "sm.md must document TRUNCATED_INDICATOR so downstream chain can detect "
        "partial SM output"
    )
