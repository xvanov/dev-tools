"""Gate: ``docs-current``.

Asserts the Tech-Writer ran and recorded non-empty ``context_updates``, OR
explicitly marked "no updates needed" via the ``no_updates_needed`` boolean
(authoritative) or, for backward compatibility with already-persisted rows
that predate that field, one of four literal phrases in ``rationale``.

S3 (019 fail-silent audit): the rationale-substring path alone made this
REQUIRED gate unsatisfiable for any tech_writer phrasing outside the four
literals (e.g. "the change is internal; docs unaffected") — including the
JSON-parse-failure fallback string persisted by
``handlers.handle_tech_writer``, which matched none of them. A permanently
missing required label strands the story with no human ever seeing it,
because the auto-merge worker just keeps reporting "gate not satisfied" every
tick forever. The boolean gives the model (and the handler) an explicit,
unambiguous way to assert the same claim the gate actually checks for.
"""

from __future__ import annotations

import json

from factory.app_config import AppConfig
from factory.chain.gates.evaluator import GateResult, PRContext


def evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:
    label = "docs-current"
    story = pr.story
    if story is None:
        return GateResult(label=label, passed=False, reason="no story linked to PR")
    if not story.tech_writer_result_json:
        return GateResult(label=label, passed=False, reason="tech_writer never produced a result")
    try:
        tw = json.loads(story.tech_writer_result_json)
    except json.JSONDecodeError:
        return GateResult(label=label, passed=False, reason="tech_writer_result_json unparseable")

    updates = tw.get("context_updates") or []
    rationale = (tw.get("rationale") or "").lower()
    if updates:
        return GateResult(
            label=label,
            passed=True,
            reason=f"{len(updates)} context update(s)",
            details={"updates": updates},
        )
    # No updates. Authoritative path: the explicit boolean, when present.
    # ``is True`` (not merely truthy) so a stray non-bool value in a
    # malformed/legacy row never accidentally passes.
    if tw.get("no_updates_needed") is True:
        return GateResult(
            label=label,
            passed=True,
            reason="tech_writer set no_updates_needed=true",
            details={"rationale": rationale, "no_updates_needed": True},
        )
    if tw.get("no_updates_needed") is False:
        # The model explicitly asserted updates WERE needed but produced
        # none — that is a real failure, not a case for the legacy-phrase
        # fallback below (which exists only for rows that PREDATE this
        # field, i.e. never set it at all).
        return GateResult(
            label=label,
            passed=False,
            reason="tech_writer set no_updates_needed=false but produced 0 updates",
            details={"rationale": rationale or "(empty)"},
        )
    # Backward-compatible fallback for historical rows persisted before the
    # ``no_updates_needed`` field existed: only acceptable if the writer's
    # rationale happens to match one of four literal phrases.
    no_updates_phrases = ("no updates needed", "no context updates", "no-op", "nothing to update")
    if any(p in rationale for p in no_updates_phrases):
        return GateResult(
            label=label,
            passed=True,
            reason="tech_writer marked 'no updates needed' with rationale (legacy fallback)",
            details={"rationale": rationale},
        )
    return GateResult(
        label=label,
        passed=False,
        reason="tech_writer produced 0 updates and no rationale for why",
        details={"rationale": rationale or "(empty)"},
    )
