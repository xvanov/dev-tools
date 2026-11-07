"""Review-convergence upgrades (2026-07-17 post-benchmark fixes).

Covers: reviewer-proposed edits rendered into dev's prompt; reviewer history
persistence + prompt sections; the location-aware findings signature; and the
cycle-3+ finality drift clamp in handle_review.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import (
    _append_reviewer_history,
    _findings_signature,
    _render_reviewer_history_section,
    handle_review,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import _build_initial_message

# --------------------------------------------------------------------------- #
# signature
# --------------------------------------------------------------------------- #


def test_signature_same_site_reworded_matches() -> None:
    a = {"findings": [{"location": "backend/app/auth.py:120",
                       "what": "wrong cookie name used for csrf"}]}
    b = {"findings": [{"location": "backend/app/auth.py:184",
                       "what": "wrong cookie name used for csrf"}]}
    # Same file + same complaint text, different line → same signature.
    assert _findings_signature(a) == _findings_signature(b)


def test_signature_different_sites_differ() -> None:
    a = {"findings": [{"location": "backend/app/auth.py:1", "what": "x"}]}
    b = {"findings": [{"location": "frontend/services/auth.ts:1", "what": "x"}]}
    assert _findings_signature(a) != _findings_signature(b)


# --------------------------------------------------------------------------- #
# history persistence + rendering
# --------------------------------------------------------------------------- #


def _mk_story(**kw: Any) -> StoryRecord:
    base: dict[str, Any] = dict(
        id=1, direction_id="099", app="myapp", title="t", slug="z",
        scope="backend", state=StoryState.TESTS_GREEN.value,
        github_issue_number=1, story_file_path="stories/1-x.md",
    )
    base.update(kw)
    return StoryRecord(**base)


def test_history_appends_and_caps() -> None:
    story = _mk_story()
    for i in range(6):
        story.reviewer_cycles = i
        _append_reviewer_history(
            story,
            {"verdict": "request_changes",
             "findings": [{"severity": "high", "location": f"f{i}.py:1", "what": f"bug {i}"}]},
        )
    history = json.loads(story.reviewer_history_json)
    assert len(history) == 4  # capped
    assert history[-1]["findings"][0]["location"] == "f5.py:1"


def test_history_section_renders_for_rereview_only() -> None:
    story = _mk_story()
    assert _render_reviewer_history_section(story) == ""
    _append_reviewer_history(
        story,
        {"verdict": "request_changes",
         "findings": [{"severity": "medium", "location": "a.py:3", "what": "off by one"}]},
    )
    section = _render_reviewer_history_section(story)
    assert "RE-REVIEW" in section
    assert "a.py:3" in section and "off by one" in section


# --------------------------------------------------------------------------- #
# dev prompt rendering: suggested_edit + prior_cycles digest
# --------------------------------------------------------------------------- #


def test_suggested_edit_rendered_verbatim_in_dev_prompt() -> None:
    findings = {
        "findings": [{
            "severity": "high",
            "location": "frontend/services/auth.ts:230",
            "what": "cookie fallback reads the wrong key",
            "fix_suggestion": "read csrf_token, not sacrifice_csrf_token",
            "suggested_edit": {
                "file": "frontend/services/auth.ts",
                "find": "getCookie('sacrifice_csrf_token')",
                "replace": "getCookie('csrf_token')",
            },
        }],
        "summary": "cookie name mismatch",
    }
    msg = _build_initial_message(
        persona="dev", story_text="# story", context_prelude="ctx",
        persona_prompt="p", reviewer_findings=findings,
    )
    assert "Reviewer-proposed edit in `frontend/services/auth.ts`" in msg
    assert "getCookie('sacrifice_csrf_token')" in msg
    assert "getCookie('csrf_token')" in msg
    assert "FIND:" in msg and "REPLACE WITH:" in msg


def test_prior_cycles_digest_rendered() -> None:
    findings = {
        "findings": [{"severity": "medium", "location": "b.py:2", "what": "new issue"}],
        "prior_cycles": [
            {"cycle": 1, "findings": [
                {"severity": "high", "location": "a.py:9", "what": "fixed in cycle 1"}]},
        ],
    }
    msg = _build_initial_message(
        persona="dev", story_text="# story", context_prelude="ctx",
        persona_prompt="p", reviewer_findings=findings,
    )
    assert "do NOT regress" in msg
    assert "(cycle 1) a.py:9: fixed in cycle 1" in msg


# --------------------------------------------------------------------------- #
# finality drift clamp (handle_review, fixture-driven)
# --------------------------------------------------------------------------- #


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "myapp" / "stories" / "1-x.md").write_text("# s\n", encoding="utf-8")
    src = tmp_path / "myapp"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(src), check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=str(src), check=True)
    (src / "README.md").write_text("# init\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(src), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src), check=True)
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    return AppConfig(name="myapp", repo="x/y", default_branch="main",
                     app_repo_path=str(temp_root / "myapp"))


def _persisted_story(temp_root: Path, **kw: Any) -> StoryRecord:
    base: dict[str, Any] = dict(
        id=None, direction_id="099", app="myapp", title="t", slug="z",
        scope="backend", state=StoryState.TESTS_GREEN.value,
        github_issue_number=1, story_file_path="stories/1-x.md",
    )
    base.update(kw)
    return persist_story(StoryRecord(**base), temp_root / "state" / "factory.db")


def _history(*cycles: list[dict[str, Any]]) -> str:
    return json.dumps([
        {"cycle": i + 1, "verdict": "request_changes", "score": 0.8,
         "findings": c, "test_quality_findings": []}
        for i, c in enumerate(cycles)
    ])


def _review(story: StoryRecord, temp_root: Path, app_config: AppConfig,
            fixture: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(handlers_module, "_slop_findings_for_story", lambda *a, **kw: [])
    return handle_review(
        story, app_config, temp_root,
        dry_run=False, db_path=temp_root / "state" / "factory.db",
        fixture=fixture, github_client=None,
    )


def test_drift_clamp_approves_rotating_findings_at_cycle_3(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two prior cycles on file A; cycle 3 raises a brand-new site (file C),
    # unmarked as regression → clamped to low → approve (score clears bar).
    story = _persisted_story(
        temp_root,
        reviewer_cycles=2,
        reviewer_history_json=_history(
            [{"severity": "high", "location": "a.py:1", "what": "bug a"}],
            [{"severity": "high", "location": "a.py:2", "what": "bug a again"}],
        ),
    )
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "medium", "location": "c.py:5",
                      "what": "brand new objection"}],
        "test_quality_findings": [],
        "summary": "s",
    }
    _review(story, temp_root, app_config, fixture, monkeypatch)

    assert StoryState(story.state) is StoryState.REVIEWER_DONE
    result = json.loads(story.reviewer_result_json)
    assert result["verdict"] == "approve"
    assert result["finality_clamp_applied"] is True
    assert result["findings"][0]["severity"] == "low"
    assert result["findings"][0]["finality_clamped"] is True


def test_regression_tagged_findings_are_not_clamped(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    # reviewer_cycles=1 (was 2): at _MAX_REVIEW_CYCLES=3 seeding 2 would make
    # this cycle the third and block for EXHAUSTION before the clamp logic
    # under test could be observed. The finality-clamp behaviour is
    # cycle-count independent; the seed only has to leave one cycle of room.
    story = _persisted_story(
        temp_root,
        reviewer_cycles=1,
        reviewer_history_json=_history(
            [{"severity": "high", "location": "a.py:1", "what": "bug a"}],
            [{"severity": "high", "location": "a.py:2", "what": "bug a again"}],
        ),
    )
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "high", "location": "c.py:5",
                      "what": "dev broke this since last review", "regression": True}],
        "test_quality_findings": [],
        "summary": "s",
    }
    _review(story, temp_root, app_config, fixture, monkeypatch)

    assert StoryState(story.state) is StoryState.REVIEWER_REQUESTED_CHANGES
    result = json.loads(story.reviewer_result_json)
    assert result["findings"][0]["severity"] == "high"


def test_unaddressed_same_site_findings_are_not_clamped(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    story = _persisted_story(
        temp_root,
        reviewer_cycles=2,
        reviewer_history_json=_history(
            [{"severity": "high", "location": "a.py:1", "what": "bug a"}],
            [{"severity": "high", "location": "a.py:2", "what": "bug a still"}],
        ),
    )
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "high", "location": "a.py:3",
                      "what": "bug a STILL not fixed"}],
        "test_quality_findings": [],
        "summary": "s",
    }
    _review(story, temp_root, app_config, fixture, monkeypatch)

    # Same file as prior cycles → legitimate unaddressed finding → no clamp.
    assert StoryState(story.state) is not StoryState.REVIEWER_DONE
    result = json.loads(story.reviewer_result_json)
    assert result["findings"][0]["severity"] == "high"


def test_no_clamp_before_cycle_3(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    story = _persisted_story(
        temp_root,
        reviewer_cycles=1,
        reviewer_history_json=_history(
            [{"severity": "high", "location": "a.py:1", "what": "bug a"}],
        ),
    )
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "medium", "location": "c.py:5", "what": "new site"}],
        "test_quality_findings": [],
        "summary": "s",
    }
    _review(story, temp_root, app_config, fixture, monkeypatch)

    assert StoryState(story.state) is StoryState.REVIEWER_REQUESTED_CHANGES
    result = json.loads(story.reviewer_result_json)
    assert result["findings"][0]["severity"] == "medium"


def test_history_written_after_review(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    story = _persisted_story(temp_root)
    fixture = {
        "verdict": "request_changes",
        "test_quality_score": 0.9,
        "findings": [{"severity": "high", "location": "a.py:1", "what": "bug"}],
        "test_quality_findings": [],
        "summary": "s",
    }
    _review(story, temp_root, app_config, fixture, monkeypatch)

    history = json.loads(story.reviewer_history_json)
    assert len(history) == 1
    assert history[0]["findings"][0]["location"] == "a.py:1"
