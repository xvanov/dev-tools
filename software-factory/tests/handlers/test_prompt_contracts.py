"""Prompt-contract tests for every handler that calls ``factory.runner.text_run``.

For each handler, we drive a real-run invocation with a capturing stub in
place of ``text_run`` and assert two properties of the assembled prompt:

1. It contains NONE of the ``_BROKEN_PROMPT_MARKERS`` from
   ``factory.chain.handlers`` — these are the literal placeholder strings
   that turned the reviewer into a no-op for months (see
   ``fix(handlers): handle_review fetches story content, fresh test output,
   and real PR diff``).
2. It contains the expected ``## <section>`` markdown headers, so a
   refactor that accidentally collapses a section is caught here instead
   of by an LLM looking at half a prompt.

Handlers covered (the four that call ``text_run`` today):
  * ``handle_sm`` (persona ``sm``)
  * ``handle_test_design`` (persona ``test_designer``)
  * ``handle_review`` (persona ``reviewer``)
  * ``handle_tech_writer`` (persona ``tech_writer``)
  * ``handle_docs_sm`` (persona ``sm`` in docs-chain mode)

Personas that do NOT call ``text_run`` and therefore have no contract
test here: ``dev``, ``test_implementer``, ``docs_onboarder``,
``docs_enforcer`` — these go through ``sandbox_run`` which builds its
prompt inside the OpenHands SDK, not from a string in ``handlers.py``.
The verification surface for those is the sandbox conversation, not a
string-substring check.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain.handlers import (
    _BROKEN_PROMPT_MARKERS,
    handle_docs_sm,
    handle_review,
    handle_sm,
    handle_tech_writer,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState

# --------------------------------------------------------------------------- #
# Shared fixtures
# --------------------------------------------------------------------------- #


def _init_git_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-q", "--initial-branch=main"], cwd=str(path), check=True
    )
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.name", "T E"], cwd=str(path), check=True)
    (path / "README.md").write_text("# test\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(path), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(path), check=True)


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice" / "stories").mkdir(parents=True, exist_ok=True)
    _init_git_repo(tmp_path / "sacrifice")
    return tmp_path


@pytest.fixture
def app_config(temp_root: Path) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="x/y",
        app_repo_path=str(temp_root / "sacrifice"),
        default_branch="main",
        context_dir="context",
    )


class _CapturingTextRun:
    def __init__(self, return_value: Any) -> None:
        self.calls: list[dict[str, Any]] = []
        self._return = return_value

    def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self._return

    @property
    def last_prompt(self) -> str:
        assert self.calls, "text_run was never called"
        return self.calls[-1]["prompt"]


def _patch_common(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub out heavy callsites used by every handler."""
    import factory.chain.handlers as h
    import factory.context.loader as loader_mod
    import factory.directions.parser as parser_mod

    monkeypatch.setattr(
        loader_mod, "compose_context_prelude", lambda **_kw: "(inert context)"
    )
    monkeypatch.setattr(h, "find_direction_for_story", lambda *_a, **_k: None)
    monkeypatch.setattr(parser_mod, "get_direction_chain", lambda *_a, **_k: [])
    monkeypatch.setattr(h, "_read_persona_prompt", lambda _persona: "(persona prompt)")
    monkeypatch.setattr(h, "route", lambda _persona: "stub/model")
    monkeypatch.setattr(h, "max_output_tokens_for", lambda _m: 1024)


def _install_text_run(
    monkeypatch: pytest.MonkeyPatch, return_value: Any
) -> _CapturingTextRun:
    cap = _CapturingTextRun(return_value)
    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", cap)
    return cap


def _assert_no_broken_markers(prompt: str) -> None:
    for marker in _BROKEN_PROMPT_MARKERS:
        assert marker not in prompt, (
            f"prompt contains broken-placeholder marker {marker!r}; "
            f"head=\n{prompt[:1500]}"
        )


def _story_with_file(
    root: Path,
    *,
    slug: str,
    state: StoryState,
    title: str = "fixture story",
    scope: str = "backend",
) -> StoryRecord:
    db = root / "state" / "factory.db"
    rel = f"stories/0-{slug}.md"
    (root / "apps" / "sacrifice" / rel).write_text(
        f"# {title}\n\nContract-test story body for {slug}.\n", encoding="utf-8"
    )
    return persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title=title,
            slug=slug,
            scope=scope,
            state=state.value,
            story_file_path=rel,
        ),
        db,
    )


# --------------------------------------------------------------------------- #
# Per-handler contracts
# --------------------------------------------------------------------------- #


def test_handle_sm_prompt_contract(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``handle_sm`` real-run path: prompt has Context, PM result, Direction sections."""
    _patch_common(monkeypatch)
    cap = _install_text_run(
        monkeypatch,
        return_value={
            "stories": [
                {
                    "slug": "fix-sm-contract",
                    "title": "t",
                    "scope": "backend",
                    "target_path": "stories/0-fix-sm-contract.md",
                    "story_file_body": "# t\n",
                }
            ]
        },
    )
    s = _story_with_file(
        temp_root, slug="fix-sm-contract", state=StoryState.STORY_CREATED
    )
    db = temp_root / "state" / "factory.db"
    handle_sm(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    _assert_no_broken_markers(prompt)
    for header in (
        "## Context",
        "## PM result",
        "## Direction",
        "## YOUR ASSIGNMENT — exactly ONE story file",
    ):
        assert header in prompt, f"missing section header {header!r}"
    # The single-story contract must pin the record's exact slug (the chain
    # matches on it and refuses to write on mismatch).
    assert "- slug: fix-sm-contract" in prompt
    assert "EXACTLY ONE entry" in prompt


def test_handle_review_prompt_contract(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``handle_review`` real-run path: prompt has Story / Test plan / Latest
    test output / PR diff sections and no broken markers."""
    _patch_common(monkeypatch)
    cap = _install_text_run(
        monkeypatch,
        return_value='{"verdict":"approve","findings":[],"test_quality_score":0.9,'
        '"test_quality_findings":[],"comments_to_post":[],"summary":"ok"}',
    )
    # Stub the diff helper — we don't want to invoke git/gh from this test.
    import factory.chain.handlers as h

    monkeypatch.setattr(h, "_fetch_pr_diff_for_review", lambda *_a, **_k: "(stub diff)")

    s = _story_with_file(
        temp_root, slug="rev-contract", state=StoryState.TESTS_GREEN
    )
    db = temp_root / "state" / "factory.db"
    handle_review(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    _assert_no_broken_markers(prompt)
    for header in (
        "## Context",
        "## Story",
        "## Test plan",
        "## Latest test output",
        "## PR diff",
    ):
        assert header in prompt, f"missing section header {header!r}"
    assert "Contract-test story body for rev-contract" in prompt


def test_handle_tech_writer_prompt_contract(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``handle_tech_writer`` real-run path: prompt has Story + PR diff + no broken markers."""
    _patch_common(monkeypatch)
    cap = _install_text_run(
        monkeypatch, return_value='{"context_updates":[],"rationale":"noop"}'
    )
    import factory.chain.handlers as h

    monkeypatch.setattr(h, "_fetch_pr_diff_for_review", lambda *_a, **_k: "(stub diff)")

    s = _story_with_file(
        temp_root, slug="tw-contract", state=StoryState.REVIEWER_DONE
    )
    db = temp_root / "state" / "factory.db"
    handle_tech_writer(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    _assert_no_broken_markers(prompt)
    for header in ("## Context", "## Story", "## PR diff"):
        assert header in prompt, f"missing section header {header!r}"
    assert "Contract-test story body for tw-contract" in prompt


def test_handle_docs_sm_prompt_contract(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``handle_docs_sm`` real-run path: prompt has Direction section, no broken markers.

    docs_sm uses a smaller prompt than the other handlers because it skips
    the context prelude and per-story fetches — the only data it needs is
    the parent direction. We still pin the no-broken-markers contract.
    """
    _patch_common(monkeypatch)
    cap = _install_text_run(
        monkeypatch,
        return_value={
            "story_file_body": "# docs story\n",
            "canonical_paths": ["context/project.md"],
        },
    )
    s = _story_with_file(
        temp_root,
        slug="docs-sm-contract",
        state=StoryState.STORY_CREATED,
        scope="docs",
    )
    db = temp_root / "state" / "factory.db"
    handle_docs_sm(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    _assert_no_broken_markers(prompt)
    assert "## Direction" in prompt
