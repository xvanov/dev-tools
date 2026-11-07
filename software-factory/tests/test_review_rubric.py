"""Rubric-graded review (WS1.7).

Covers the additions layered onto the existing structured review:
  * robust JSON extraction (fenced / prose-wrapped) with a safe, non-silent
    fallback on genuine parse failure;
  * the rubric ``criterion`` axis in the findings signature (progress vs churn);
  * criterion surfaced in the dev change-request rendering.

The dev↔reviewer routing and stability-cap behaviour proper are already
covered in ``test_handler_review.py`` / ``test_review_convergence.py``; these
tests exercise only the rubric-graded delta.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import (
    _MAX_REVIEW_STUCK,
    _extract_json_object,
    _finding_criterion,
    _findings_signature,
    _parse_reviewer_result,
    handle_review,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import _build_initial_message

# --------------------------------------------------------------------------- #
# robust JSON extraction
# --------------------------------------------------------------------------- #


def test_extract_plain_object() -> None:
    assert _extract_json_object('{"verdict": "approve"}') == {"verdict": "approve"}


def test_extract_fenced_json_block() -> None:
    text = '```json\n{"verdict": "request_changes", "findings": []}\n```'
    assert _extract_json_object(text) == {"verdict": "request_changes", "findings": []}


def test_extract_plain_fence_without_lang() -> None:
    assert _extract_json_object('```\n{"verdict": "approve"}\n```') == {"verdict": "approve"}


def test_extract_object_with_surrounding_prose() -> None:
    text = 'Here is my review:\n{"verdict": "approve", "test_quality_score": 0.9}\nDone.'
    assert _extract_json_object(text) == {
        "verdict": "approve",
        "test_quality_score": 0.9,
    }


def test_extract_returns_none_on_garbage() -> None:
    assert _extract_json_object("not json at all") is None
    assert _extract_json_object("") is None


def test_extract_returns_none_on_json_array() -> None:
    # A top-level array is not a review object → None (caller must not approve).
    assert _extract_json_object("[1, 2, 3]") is None


# --------------------------------------------------------------------------- #
# parse-fallback: malformed output never silently approves
# --------------------------------------------------------------------------- #


def test_parse_fallback_on_garbage_is_request_changes() -> None:
    result = _parse_reviewer_result("the model refused to answer")
    assert result["verdict"] == "request_changes"
    assert result["test_quality_score"] == 0.0
    # A finding is present so the dev has actionable signal, not an empty bounce.
    assert result["findings"] and result["findings"][0]["criterion"] == "contract"


def test_parse_fallback_never_approves_on_partial_dict() -> None:
    # A dict with no ``verdict`` key is not a valid review → safe fallback.
    result = _parse_reviewer_result('{"summary": "looks fine"}')
    assert result["verdict"] == "request_changes"


def test_parse_recovers_fenced_verdict() -> None:
    result = _parse_reviewer_result('```json\n{"verdict": "approve", '
                                    '"test_quality_score": 0.9}\n```')
    assert result["verdict"] == "approve"


def test_parse_passes_through_dict() -> None:
    d = {"verdict": "request_changes", "findings": []}
    assert _parse_reviewer_result(d) is d


# --------------------------------------------------------------------------- #
# criterion in the signature (progress vs churn)
# --------------------------------------------------------------------------- #


def test_signature_same_site_different_criterion_differs() -> None:
    a = {"findings": [{"location": "app/x.py:10", "criterion": "style",
                       "what": "cleanup"}]}
    b = {"findings": [{"location": "app/x.py:10", "criterion": "security",
                       "what": "cleanup"}]}
    # Same file + text but a NEW rubric axis = progress, not a stuck repeat.
    assert _findings_signature(a) != _findings_signature(b)


def test_signature_same_site_same_criterion_matches() -> None:
    a = {"findings": [{"location": "app/x.py:10", "criterion": "security",
                       "what": "missing authz check"}]}
    b = {"findings": [{"location": "app/x.py:88", "criterion": "security",
                       "what": "missing authz check"}]}
    # Same file + same axis + same complaint, different line → same signature.
    assert _findings_signature(a) == _findings_signature(b)


def test_signature_backward_compatible_without_criterion() -> None:
    # Pre-rubric findings (no criterion) hash exactly as the file+text key did.
    a = {"findings": [{"location": "app/x.py:10", "what": "bug"}]}
    b = {"findings": [{"location": "app/x.py:99", "what": "bug"}]}
    assert _findings_signature(a) == _findings_signature(b)


def test_finding_criterion_normalizes_unknown_to_empty() -> None:
    assert _finding_criterion({"criterion": "SECURITY"}) == "security"
    assert _finding_criterion({"criterion": "vibes"}) == ""
    assert _finding_criterion({}) == ""


# --------------------------------------------------------------------------- #
# criterion surfaced to the dev
# --------------------------------------------------------------------------- #


def test_criterion_rendered_in_dev_prompt() -> None:
    findings = {
        "findings": [{
            "severity": "high",
            "criterion": "security",
            "location": "api/routes.py:42",
            "what": "no authz on the delete endpoint",
        }],
        "summary": "authz gap",
    }
    msg = _build_initial_message(
        persona="dev", story_text="# story", context_prelude="ctx",
        persona_prompt="p", reviewer_findings=findings,
    )
    assert "**[high/security]**" in msg
    assert "api/routes.py:42" in msg


def test_dev_prompt_without_criterion_still_renders() -> None:
    findings = {"findings": [{"severity": "medium", "location": "a.py:1",
                              "what": "x"}], "summary": "s"}
    msg = _build_initial_message(
        persona="dev", story_text="# story", context_prelude="ctx",
        persona_prompt="p", reviewer_findings=findings,
    )
    assert "**[medium]**" in msg  # no trailing slash when criterion absent


# --------------------------------------------------------------------------- #
# handle_review: rubric findings route, approve advances, parse-fallback,
# stuck-at-cap / reset — fixture-driven (fixture bypasses the LLM + parse).
# --------------------------------------------------------------------------- #


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    src = temp_root / "sacrifice"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=str(src), check=True)
    (src / "README.md").write_text("# init\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(src), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src), check=True)
    return AppConfig(name="sacrifice", repo="x/y", default_branch="main",
                     app_repo_path=str(src))


def _story(temp_root: Path, **kw: Any) -> StoryRecord:
    base: dict[str, Any] = dict(
        direction_id="002", app="sacrifice", title="t", slug="t",
        scope="backend", state=StoryState.TESTS_GREEN.value,
    )
    base.update(kw)
    return persist_story(StoryRecord(**base), temp_root / "state" / "factory.db")


def _no_slop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handlers_module, "_slop_findings_for_story", lambda *a, **kw: [])


def test_blocker_criterion_finding_routes_to_dev(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_slop(monkeypatch)
    s = _story(temp_root)
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "high", "criterion": "correctness",
                      "location": "app/x.py:5", "what": "off by one"}],
        "test_quality_findings": [],
        "summary": "s",
    }
    result = handle_review(s, app_config, temp_root, dry_run=True,
                           db_path=temp_root / "state" / "factory.db", fixture=fixture)
    assert result.next_state == StoryState.REVIEWER_REQUESTED_CHANGES
    # criterion is preserved into the persisted result the dev reads.
    import json
    assert json.loads(s.reviewer_result_json)["findings"][0]["criterion"] == "correctness"


def test_clean_approve_advances(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_slop(monkeypatch)
    s = _story(temp_root)
    fixture = {"verdict": "approve", "test_quality_score": 0.95,
               "findings": [], "test_quality_findings": [], "summary": "lgtm"}
    result = handle_review(s, app_config, temp_root, dry_run=True,
                           db_path=temp_root / "state" / "factory.db", fixture=fixture)
    assert result.next_state == StoryState.REVIEWER_DONE


def test_identical_rubric_findings_escalate_at_cap(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_slop(monkeypatch)
    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "high", "criterion": "security",
                      "location": "app/x.py:5", "what": "missing authz"}],
        "test_quality_findings": [],
        "summary": "s",
    }
    last = None
    for _ in range(_MAX_REVIEW_STUCK):
        s.state = StoryState.TESTS_GREEN.value
        persist_story(s, db)
        last = handle_review(s, app_config, temp_root, dry_run=True, db_path=db,
                             fixture=fixture)
    assert last is not None
    assert last.next_state == StoryState.BLOCKED_REVIEW_NONCONVERGENT
    assert s.error is not None and "stuck" in s.error


def test_rotating_criterion_findings_do_not_escalate(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_slop(monkeypatch)
    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    # Same file, DIFFERENT rubric axis each cycle → progress, never stuck.
    criteria = ["style", "correctness", "security", "contract"]
    last = None
    # Bounded by _MAX_REVIEW_STUCK, not STUCK+1: at _MAX_REVIEW_CYCLES=3 the
    # absolute backstop now sits one cycle above the stability threshold, so
    # an extra cycle would block for EXHAUSTION and prove nothing about
    # stability. Identical findings would already have blocked by here.
    for i in range(_MAX_REVIEW_STUCK):
        s.state = StoryState.TESTS_GREEN.value
        persist_story(s, db)
        fixture = {
            "verdict": "request_changes",
            # Strictly improving score: since the non-improving-score early
            # exit (2026-08-01), rotating findings alone no longer count as
            # progress — a flat score at cycle 2 blocks.
            "test_quality_score": 0.8 + i * 0.05,
            "findings": [{"severity": "high", "criterion": criteria[i],
                          "location": "app/x.py:5", "what": "same site diff axis"}],
            "test_quality_findings": [],
            "summary": "s",
        }
        last = handle_review(s, app_config, temp_root, dry_run=True, db_path=db,
                             fixture=fixture)
    assert last is not None
    assert last.next_state != StoryState.BLOCKED_REVIEW_NONCONVERGENT
