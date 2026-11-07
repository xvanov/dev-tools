"""PM story-size validator + re-prompt loop.

The PM persona now emits per-story size estimates and the chain rejects
decompositions that exceed the per-story dev-pass budget. This guard
keeps the chain from spawning stories the dev sandbox can't complete
in one shot — see ``factory/personas/pm.md`` for the user-facing rule.
"""

from __future__ import annotations

from typing import Any

import pytest

from factory.chain.pm_sync import (
    MAX_MODIFIED_FILES_PER_STORY,
    MAX_NEW_FILES_PER_STORY,
    MAX_PM_REDECOMPOSITION_RETRIES,
    MAX_SANDBOX_ITERATIONS_PER_STORY,
    _format_redecomposition_feedback,
    _story_size_violations,
    _validate_pm_story_sizes,
)


def _story(**overrides: Any) -> dict[str, Any]:
    base = {
        "title": "x",
        "scope": "backend",
        "rationale": "y",
        "estimated_new_files": 3,
        "estimated_modified_files": 1,
        "estimated_sandbox_iterations": 120,
    }
    base.update(overrides)
    return base


def test_story_within_limits_has_no_violations() -> None:
    assert _story_size_violations(_story()) == []


def test_story_exceeding_new_files_is_flagged() -> None:
    v = _story_size_violations(_story(estimated_new_files=MAX_NEW_FILES_PER_STORY + 1))
    assert any("estimated_new_files" in s for s in v)


def test_story_exceeding_modified_files_is_flagged() -> None:
    v = _story_size_violations(
        _story(estimated_modified_files=MAX_MODIFIED_FILES_PER_STORY + 1)
    )
    assert any("estimated_modified_files" in s for s in v)


def test_story_exceeding_iterations_is_flagged() -> None:
    v = _story_size_violations(
        _story(estimated_sandbox_iterations=MAX_SANDBOX_ITERATIONS_PER_STORY + 1)
    )
    assert any("estimated_sandbox_iterations" in s for s in v)


def test_missing_estimates_emit_soft_sentinels() -> None:
    # Stories without estimates (legacy PM output) emit sentinels but
    # don't trigger hard violations — the chain logs and accepts.
    v = _story_size_violations(
        {"title": "x", "scope": "backend", "rationale": "y"}
    )
    assert all(s.startswith("missing_estimate_") for s in v)


def test_validate_skips_when_backpressure_insufficient() -> None:
    pm_result = {
        "has_sufficient_backpressure": False,
        "child_stories": [_story(estimated_new_files=999)],
    }
    # No stories spawn anyway, so no validation runs.
    assert _validate_pm_story_sizes(pm_result) == {}


def test_validate_returns_indexed_violations() -> None:
    pm_result = {
        "has_sufficient_backpressure": True,
        "child_stories": [
            _story(),  # idx 0 — fine
            _story(estimated_new_files=99),  # idx 1 — bad
            _story(estimated_modified_files=99),  # idx 2 — bad
        ],
    }
    out = _validate_pm_story_sizes(pm_result)
    assert set(out.keys()) == {1, 2}


def test_validate_ignores_soft_missing_estimates() -> None:
    """Missing estimates are warnings, not gate failures."""
    pm_result = {
        "has_sufficient_backpressure": True,
        "child_stories": [
            {"title": "x", "scope": "backend", "rationale": "y"},  # no estimates
        ],
    }
    assert _validate_pm_story_sizes(pm_result) == {}


def test_feedback_string_mentions_indices_and_limits() -> None:
    out = _format_redecomposition_feedback(
        {0: ["estimated_new_files=20 exceeds max 5"]}
    )
    assert "story[0]" in out
    assert "estimated_new_files=20" in out
    assert f"{MAX_NEW_FILES_PER_STORY}" in out
    assert f"{MAX_SANDBOX_ITERATIONS_PER_STORY}" in out


def test_call_pm_persona_re_prompts_on_oversized_stories(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the first PM result is oversized, the chain feeds back and re-prompts."""
    from factory.chain import pm_sync as P
    from factory.directions.parser import Direction

    direction = Direction(
        id="099",
        slug="big",
        title="big direction",
        type_tag=None,
        why=None,
        has_flow=True,
        has_api_spec=True,
        acceptance=[],
        explore_tag=False,
        artifacts_paths=[],
        app="dummyapp",
        status="created",
        raw_frontmatter={},
        raw_body="",
    )

    calls: list[dict[str, Any]] = []

    oversized_result = {
        "type": "refactor",
        "priority": "p1",
        "has_sufficient_backpressure": True,
        "missing": [],
        "tracker_title": "big direction",
        "tracker_body": "...",
        "child_stories": [
            _story(estimated_new_files=20)  # well past the limit
        ],
        "labels": ["refactor", "priority/p1"],
        "confidence": 0.9,
    }
    fine_result = {
        **oversized_result,
        "child_stories": [_story(estimated_new_files=3)],
    }

    def fake_text_run(**kwargs: Any) -> Any:
        calls.append(kwargs)
        if len(calls) == 1:
            return oversized_result
        return fine_result

    monkeypatch.setattr(P, "text_run", fake_text_run, raising=False)
    # Patch the lazy import inside ``_call_pm_persona``.
    import factory.runner as _runner

    monkeypatch.setattr(_runner, "text_run", fake_text_run, raising=False)
    # Avoid context-prelude file reads.
    monkeypatch.setattr(
        P, "compose_context_prelude", lambda **kwargs: "(no prelude)", raising=False
    )

    out = P._call_pm_persona(direction, app_repo_path=P.Path("/tmp"), software_factory_root=P.Path("/tmp"))

    assert len(calls) == 2, "PM should be re-prompted exactly once"
    assert out is fine_result
    # Second call's prompt must carry the feedback block.
    second_prompt = calls[1]["prompt"]
    assert "exceed dev" in second_prompt or "exceeds max" in second_prompt
    assert "story[0]" in second_prompt


def test_call_pm_persona_accepts_after_retry_budget_exhausts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If PM keeps emitting oversized stories, the chain gives up and tags
    the result with a warning instead of looping forever."""
    from factory.chain import pm_sync as P
    from factory.directions.parser import Direction

    direction = Direction(
        id="099",
        slug="stubborn",
        title="stubborn direction",
        type_tag=None,
        why=None,
        has_flow=True,
        has_api_spec=True,
        acceptance=[],
        explore_tag=False,
        artifacts_paths=[],
        app="dummyapp",
        status="created",
        raw_frontmatter={},
        raw_body="",
    )

    calls: list[dict[str, Any]] = []

    always_bad = {
        "type": "refactor",
        "priority": "p1",
        "has_sufficient_backpressure": True,
        "missing": [],
        "tracker_title": "stubborn",
        "tracker_body": "...",
        "child_stories": [_story(estimated_new_files=99)],
        "labels": ["refactor", "priority/p1"],
        "confidence": 0.9,
    }

    def fake_text_run(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return {**always_bad, "child_stories": [_story(estimated_new_files=99)]}

    import factory.runner as _runner

    monkeypatch.setattr(_runner, "text_run", fake_text_run, raising=False)
    monkeypatch.setattr(P, "text_run", fake_text_run, raising=False)
    monkeypatch.setattr(
        P, "compose_context_prelude", lambda **kwargs: "(no prelude)", raising=False
    )

    out = P._call_pm_persona(direction, app_repo_path=P.Path("/tmp"), software_factory_root=P.Path("/tmp"))

    # Original attempt + MAX_PM_REDECOMPOSITION_RETRIES retries.
    assert len(calls) == MAX_PM_REDECOMPOSITION_RETRIES + 1
    warnings = out.get("_chain_warnings", [])
    assert warnings, "should record a warning after exhausting retries"
    assert warnings[0]["kind"] == "story_sizes_exceeded_after_retries"
