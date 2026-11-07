"""Regression: a legacy string finding in reviewer history must not crash the tick.

Live story 82 carried a ``reviewer_history_json`` entry whose ``findings`` list
held a bare string (written before ``_append_reviewer_history``'s isinstance
guard existed). ``_render_reviewer_history_section`` iterated it and hit
``'str' object has no attribute 'get'`` on EVERY tick, erroring the tick out
(exit 1) until the per-story budget breaker would eventually trip. The reader
now skips non-dict findings like the signature/digest paths already do.
"""

from __future__ import annotations

import json

from factory.chain.handlers import _render_reviewer_history_section
from factory.chain.state_machine import StoryRecord, StoryState


def _story_with_history(history: list) -> StoryRecord:
    return StoryRecord(
        app="sacrifice",
        slug="s",
        state=StoryState.REVIEWER_REQUESTED_CHANGES,
        reviewer_history_json=json.dumps(history),
    )


def test_string_finding_in_history_does_not_crash():
    history = [
        {
            "cycle": 1,
            "verdict": "request_changes",
            # legacy corruption: a bare string where a dict is expected
            "findings": ["some old free-text finding", {"severity": "high", "what": "real one", "location": "a.py"}],
            "test_quality_findings": ["stringy too"],
        }
    ]
    out = _render_reviewer_history_section(_story_with_history(history))
    # It renders without raising and includes the well-formed finding...
    assert "real one" in out
    # ...and does not choke on / echo the malformed string as a finding line.
    assert "'str'" not in out


def test_normal_history_still_renders():
    history = [
        {
            "cycle": 1,
            "verdict": "request_changes",
            "findings": [{"severity": "high", "criterion": "correctness", "location": "x.py", "what": "bug"}],
        }
    ]
    out = _render_reviewer_history_section(_story_with_history(history))
    assert "bug" in out and "x.py" in out


def test_empty_history_is_blank():
    assert _render_reviewer_history_section(_story_with_history([])) == ""
