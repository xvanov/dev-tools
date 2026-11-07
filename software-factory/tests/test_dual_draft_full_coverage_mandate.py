"""A dual-draft alternate must carry EVERY acceptance criterion of its direction.

Measured live 2026-08-08, sacrifice direction 117 (``explore: true``). SM wrote
story 173 ("narrow read") with:

    "This story is the **narrow read** ... It does NOT implement the full token
     model, token generation endpoint, token consumption endpoint, or email
     sending. Those are implemented in sibling stories."

No such sibling is ever created. ``explore: true`` spawns exactly two
alternates, ``-alt-a`` and ``-alt-b``, and they are RIVALS: measured over the
sacrifice ledger, 23 pairs resolved 23 ``deployed`` / 20
``superseded_by_sibling``. Meanwhile the acceptance oracle grades every story
against the DIRECTION's criteria, never the story's
(``_author_acceptance_oracle`` → ``list(direction.acceptance)``).

So the deferred criterion was built by nobody and then graded — the story was
unmergeable before dev wrote a line. Dev faithfully implemented only the guard
and flipped ``email_verified`` with a raw SQL ``UPDATE`` in its own test,
because no endpoint existed to do it.

``_with_full_coverage_mandate`` states the invariant in the artifact dev reads,
in code, so it does not depend on SM obeying a prompt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from factory.chain.handlers import _FULL_COVERAGE_MARKER, _with_full_coverage_mandate


@dataclass
class _Direction:
    acceptance: list[str] = field(default_factory=list)


@dataclass
class _Story:
    slug: str


_ACS = [
    "New email/password accounts require successful verification before sensitive operations",
    "Verification tokens are single-use, short-lived, and invalidated after use",
    "Tests cover unverified vs verified authorization behavior",
]

# The exact descoping sentence SM produced for story 173.
_DESCOPED_BODY = (
    "# Story: Add verified-email lifecycle controls — narrow read\n\n"
    "This story is the **narrow read**. It does NOT implement the full token "
    "model, token generation endpoint, token consumption endpoint, or email "
    "sending. Those are implemented in sibling stories.\n"
)


def test_alternate_gets_every_direction_criterion_appended() -> None:
    out = _with_full_coverage_mandate(
        _DESCOPED_BODY, _Story(slug="add-verified-email-narrow-read-alt-a"), _Direction(_ACS)
    )
    for ac in _ACS:
        assert ac in out, f"criterion missing from the alternate's story file: {ac}"
    assert _FULL_COVERAGE_MARKER in out


def test_the_descoped_criterion_specifically_survives() -> None:
    """The one story 173 deferred is the one that must come back."""
    out = _with_full_coverage_mandate(
        _DESCOPED_BODY, _Story(slug="x-narrow-read-alt-a"), _Direction(_ACS)
    )
    assert "single-use, short-lived, and invalidated after use" in out
    # And the mandate must outrank the descoping prose still present above it.
    assert out.index(_FULL_COVERAGE_MARKER) > out.index("sibling stories")
    assert "the criteria here win" in out


def test_alt_b_is_covered_too() -> None:
    out = _with_full_coverage_mandate(
        "# broad read\n", _Story(slug="x-broad-read-alt-b"), _Direction(_ACS)
    )
    assert _FULL_COVERAGE_MARKER in out
    assert all(ac in out for ac in _ACS)


def test_non_alternate_story_is_untouched() -> None:
    """CONTROL — a genuine multi-story split SHOULD scope each story narrowly.

    Stamping every story with the whole direction would undo decomposition and
    make each story of a real split responsible for all of it.
    """
    body = "# Story: add the healthz route\n"
    out = _with_full_coverage_mandate(
        body, _Story(slug="d078-add-backend-healthz-route"), _Direction(_ACS)
    )
    assert out == body
    assert _FULL_COVERAGE_MARKER not in out


def test_is_idempotent_when_sm_reruns() -> None:
    """SM re-runs on slug mismatch; the block must not stack."""
    story = _Story(slug="x-narrow-read-alt-a")
    once = _with_full_coverage_mandate(_DESCOPED_BODY, story, _Direction(_ACS))
    twice = _with_full_coverage_mandate(once, story, _Direction(_ACS))
    assert twice == once
    assert twice.count(_FULL_COVERAGE_MARKER) == 1


def test_direction_without_criteria_is_untouched() -> None:
    """No criteria to mandate → append nothing rather than an empty section."""
    body = "# story\n"
    assert _with_full_coverage_mandate(body, _Story(slug="x-alt-a"), _Direction([])) == body


def test_missing_direction_does_not_raise() -> None:
    """``find_direction_for_story`` can return None; SM must still write a file."""
    body = "# story\n"
    assert _with_full_coverage_mandate(body, _Story(slug="x-alt-a"), None) == body


def test_alternate_detection_matches_the_slug_convention() -> None:
    """Pin the detector against the real generated slugs, not a guess."""
    from factory.chain.dual_draft import _draft_alt_suffix

    assert _draft_alt_suffix("add-verified-email-lifecycle-controls-narrow-read-alt-a") == "alt-a"
    assert _draft_alt_suffix("add-verified-email-lifecycle-controls-broad-read-alt-b") == "alt-b"
    assert _draft_alt_suffix("d119-add-unauthenticated-get-api-meta") is None


def test_body_content_is_preserved_not_replaced() -> None:
    """The mandate augments SM's story; it must never discard it."""
    out: Any = _with_full_coverage_mandate(
        _DESCOPED_BODY, _Story(slug="x-alt-a"), _Direction(_ACS)
    )
    assert "# Story: Add verified-email lifecycle controls — narrow read" in out
