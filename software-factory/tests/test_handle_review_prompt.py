"""Tests for the ``handle_review`` prompt plumbing.

These exist because handle_review spent months sending the LLM literal
placeholder strings ("(see <path>)", "(fetched from GitHub by the chain
— placeholder for real-run)", and stale test_implementer JSON) instead
of real data — see commit fix(handlers): handle_review fetches story
content, fresh test output, and real PR diff. The reviewer kept asking
for missing information that was already on disk, costing 5-10x the
expected dev<->reviewer cycle count on stories 5, 15, 16, 18, 19, 22.

Each test here pins one piece of the plumbing in place so a regressing
edit fires a clear assertion instead of silently degrading review quality.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain.handlers import handle_review, persist_story
from factory.chain.state_machine import StoryRecord, StoryState

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


def _init_git_repo(path: Path) -> None:
    """Initialise a minimal git repo at ``path`` so ``_writing_worktree`` works."""
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
    )


def _story(root: Path, *, story_md: str | None = None) -> StoryRecord:
    """Persist a story sitting at TESTS_GREEN with a real story file on disk."""
    db = root / "state" / "factory.db"
    slug = "plumbing-fixture"
    story_path_rel = f"stories/0-{slug}.md"
    story_path_abs = root / "apps" / "sacrifice" / story_path_rel
    if story_md is None:
        story_md = (
            "# Story: plumbing fixture\n\n"
            "MAGIC-STORY-MARKER-2718281828\n\n"
            "## Acceptance criteria\n\n"
            "- The reviewer must actually see this content.\n"
        )
    story_path_abs.write_text(story_md, encoding="utf-8")
    return persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug=slug,
            scope="backend",
            state=StoryState.TESTS_GREEN.value,
            story_file_path=story_path_rel,
        ),
        db,
    )


class _CapturingTextRun:
    """Stand-in for ``factory.runner.text_run`` that captures the prompt."""

    def __init__(
        self, return_value: dict[str, Any] | str | None = None
    ) -> None:
        self.calls: list[dict[str, Any]] = []
        if return_value is None:
            return_value = json.dumps(
                {
                    "verdict": "approve",
                    "findings": [],
                    "test_quality_score": 0.95,
                    "test_quality_findings": [],
                    "comments_to_post": [],
                    "summary": "captured prompt; auto-approve",
                }
            )
        self._return_value = return_value

    def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self._return_value

    @property
    def last_prompt(self) -> str:
        assert self.calls, "text_run was never called"
        return self.calls[-1]["prompt"]


def _patch_text_run(monkeypatch: pytest.MonkeyPatch) -> _CapturingTextRun:
    cap = _CapturingTextRun()
    import factory.runner as runner_mod

    monkeypatch.setattr(runner_mod, "text_run", cap)
    return cap


def _patch_helpers_to_be_inert(monkeypatch: pytest.MonkeyPatch) -> None:
    """Avoid invoking heavy real-run helpers (context prelude / direction chain).

    We don't care what the context section contains for these tests; only that
    the story / test-output / PR-diff sections are populated correctly.
    """
    import factory.chain.handlers as handlers_mod
    import factory.context.loader as loader_mod
    import factory.directions.parser as parser_mod

    monkeypatch.setattr(
        loader_mod,
        "compose_context_prelude",
        lambda **_kw: "(inert context for plumbing test)",
    )
    monkeypatch.setattr(handlers_mod, "find_direction_for_story", lambda *_a, **_k: None)
    monkeypatch.setattr(parser_mod, "get_direction_chain", lambda *_a, **_k: [])
    # _read_persona_prompt reads from disk; stub it.
    monkeypatch.setattr(
        handlers_mod, "_read_persona_prompt", lambda _persona: "(inert persona prompt)"
    )
    # route() consults model_router config; pin to a stub.
    monkeypatch.setattr(handlers_mod, "route", lambda _persona: "stub/model")
    monkeypatch.setattr(handlers_mod, "max_output_tokens_for", lambda _m: 1024)


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def test_handle_review_prompt_includes_story_content(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reviewer prompt MUST contain the story file's actual content."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    # Force the diff-fetch helper to return a benign sentinel so we don't shell
    # out to gh/git in this story-content-focused test.
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff for story test)",
    )

    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    handle_review(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    assert "MAGIC-STORY-MARKER-2718281828" in prompt, (
        "expected story content embedded in prompt, got:\n" + prompt[:2000]
    )
    # And the broken-placeholder form must NOT survive.
    assert f"(see {s.story_file_path})" not in prompt
    assert "(fetched from GitHub by the chain" not in prompt


def test_handle_review_prompt_includes_fresh_test_output(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When dev has written attempts, the prompt MUST embed the latest test tail."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff)",
    )
    # This story has a real dev attempt below, and the fixture repo has no
    # remote — the empty-diff short-circuit (with its local-base fallback)
    # would legitimately fire and block before any prompt is built. This test
    # pins prompt PLUMBING, not diff semantics, so force "diff not empty".
    monkeypatch.setattr(handlers_mod, "_dev_produced_empty_diff", lambda *_a, **_k: False)

    s = _story(temp_root)
    s.dev_attempts_json = json.dumps(
        [
            {
                "attempt": 1,
                "ts": "2026-01-01T00:00:00+00:00",
                "test_output_tail": (
                    "FAILED tests/test_x.py::test_widget - AssertionError: "
                    "MAGIC-TEST-TAIL-3141592653"
                ),
                "files_touched": ["src/x.py"],
                "summary": "tests not green",
            }
        ]
    )
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)
    handle_review(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    assert "MAGIC-TEST-TAIL-3141592653" in prompt, (
        "expected fresh dev-attempt tail in prompt, got:\n" + prompt[:2000]
    )
    assert "## Latest test output" in prompt


def test_handle_review_prompt_includes_dev_self_summary(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The dev's SELF_SUMMARY must reach the reviewer, clearly labeled as the
    dev's own unverified claims (the provenance-mandate input)."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff)",
    )
    # A real dev attempt exists; keep the empty-diff short-circuit out of the way.
    monkeypatch.setattr(handlers_mod, "_dev_produced_empty_diff", lambda *_a, **_k: False)

    s = _story(temp_root)
    s.dev_attempts_json = json.dumps(
        [
            {
                "attempt": 1,
                "ts": "2026-01-01T00:00:00+00:00",
                "test_output_tail": "1 passed",
                "test_run_passed": True,
                "self_summary": (
                    "MAGIC-SELF-SUMMARY-1732050807: I followed the precedent at "
                    "fake_pkg/example_sibling.py:7 for the field spelling."
                ),
            }
        ]
    )
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)
    handle_review(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    assert "## DEV SELF-SUMMARY" in prompt
    assert "unverified claims" in prompt
    assert "MAGIC-SELF-SUMMARY-1732050807" in prompt


def test_handle_review_prompt_flags_missing_dev_self_summary(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No self_summary on record -> the explicit sentinel, never an empty
    section (a dev that skipped its output contract is itself signal)."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff)",
    )

    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    handle_review(s, app_config, temp_root, db_path=db)

    prompt = cap.last_prompt
    assert "## DEV SELF-SUMMARY" in prompt
    assert "(dev provided no self-summary)" in prompt


def test_handle_review_prompt_falls_back_to_no_recent_run_when_empty(
    temp_root: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No dev_attempts + no harness_precheck event -> explicit sentinel string."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff)",
    )

    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    handle_review(s, app_config, temp_root, db_path=db)

    assert "(no recent test run on record)" in cap.last_prompt


def test_handle_review_prompt_includes_pr_diff_from_worktree(
    temp_root: Path,
    app_config: AppConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No PR yet -> diff comes from ``git diff origin/<base>...HEAD`` in worktree."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)

    s = _story(temp_root)
    assert s.github_pr_number is None
    db = temp_root / "state" / "factory.db"

    # Stub subprocess.run inside handlers module to return a fake git diff.
    fake_diff = (
        "diff --git a/src/x.py b/src/x.py\n"
        "+MAGIC-DIFF-MARKER-2236067977\n"
    )

    def fake_run(cmd: list[str], *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        if cmd[:2] == ["git", "rev-parse"]:
            # _resolve_diff_base probing origin/<base> — report it resolvable.
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="abc123\n", stderr="")
        assert cmd[:2] == ["git", "diff"], f"unexpected cmd: {cmd}"
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=fake_diff, stderr="")

    # _fetch_pr_diff_for_review calls subprocess.run via the lazily-imported
    # subprocess module; patching the module-level subprocess.run covers it.
    monkeypatch.setattr(subprocess, "run", fake_run)
    # _writing_worktree uses subprocess via ensure_worktree_for_story —
    # bypass that by stubbing the helper to return a path that exists.
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_writing_worktree",
        lambda *_a, **_k: temp_root / "sacrifice",
    )

    handle_review(s, app_config, temp_root, db_path=db)
    prompt = cap.last_prompt
    assert "MAGIC-DIFF-MARKER-2236067977" in prompt, (
        "expected worktree git-diff content in prompt, got:\n" + prompt[:2000]
    )


def test_handle_review_prompt_includes_pr_diff_from_gh(
    temp_root: Path,
    app_config: AppConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``story.github_pr_number`` is set -> use ``gh pr diff``."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)

    s = _story(temp_root)
    s.github_pr_number = 42
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    fake_diff = (
        "diff --git a/src/y.py b/src/y.py\n"
        "+MAGIC-GH-DIFF-MARKER-1414213562\n"
    )
    seen_cmds: list[list[str]] = []

    def fake_run(cmd: list[str], *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        seen_cmds.append(cmd)
        assert cmd[:3] == ["gh", "pr", "diff"], f"unexpected cmd: {cmd}"
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=fake_diff, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    handle_review(s, app_config, temp_root, db_path=db)
    prompt = cap.last_prompt
    assert "MAGIC-GH-DIFF-MARKER-1414213562" in prompt
    assert seen_cmds, "gh pr diff was never invoked"
    assert "-R" in seen_cmds[0] and "x/y" in seen_cmds[0]


def test_handle_review_raises_on_broken_placeholder(
    temp_root: Path,
    app_config: AppConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If a fetch regresses and returns a literal placeholder, the guard fires."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    # Inject the regression: diff fetcher returns a broken-marker string.
    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(fetched from GitHub by the chain — placeholder for real-run)",
    )

    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    with pytest.raises(RuntimeError, match="broken plumbing marker"):
        handle_review(s, app_config, temp_root, db_path=db)
    # text_run must NOT have been reached when the guard fires.
    assert cap.calls == []


def test_handle_review_tolerates_malformed_dev_attempts_json(
    temp_root: Path,
    app_config: AppConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Malformed ``dev_attempts_json`` must NOT raise — fall through to the
    next signal source (harness_precheck log, then the explicit sentinel)."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff)",
    )

    s = _story(temp_root)
    # Garbage in the DB column — historically possible if a write was
    # truncated mid-flight or a migration replaced the field with a string
    # literal. The reviewer must still get a prompt; the section just
    # falls back to the sentinel.
    s.dev_attempts_json = "{not valid json"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)

    # Should not raise.
    handle_review(s, app_config, temp_root, db_path=db)
    prompt = cap.last_prompt
    # With no harness_precheck event either, we land on the explicit sentinel.
    assert "(no recent test run on record)" in prompt


def test_handle_review_truncates_large_story_file_at_32kb(
    temp_root: Path,
    app_config: AppConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A story file larger than 32K chars MUST be capped with the truncation
    marker so the LLM context window isn't blown out by a runaway story."""
    _patch_helpers_to_be_inert(monkeypatch)
    cap = _patch_text_run(monkeypatch)
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(
        handlers_mod,
        "_fetch_pr_diff_for_review",
        lambda *_a, **_k: "(inert diff)",
    )

    # Story whose body is 40K chars of filler — far past the 32K cap.
    huge_body = (
        "# Story: huge\n\n"
        "MAGIC-HUGE-MARKER-1618033988\n\n"
        + ("x" * (40 * 1024))
    )
    s = _story(temp_root, story_md=huge_body)
    db = temp_root / "state" / "factory.db"

    handle_review(s, app_config, temp_root, db_path=db)
    prompt = cap.last_prompt

    # Truncation marker must appear, and the head of the story must still
    # be visible (it's where acceptance criteria live).
    assert "\n...[truncated at 32KB]" in prompt
    assert "MAGIC-HUGE-MARKER-1618033988" in prompt

    # Extract the Story section and confirm its body is bounded.
    # Section runs from "## Story\n\n" to the next "## " header.
    story_start = prompt.index("## Story\n\n") + len("## Story\n\n")
    story_end = prompt.index("\n## ", story_start)
    story_section = prompt[story_start:story_end]
    # Cap (32 * 1024 chars) + suffix "\n...[truncated at 32KB]".
    max_expected = handlers_mod._STORY_CONTENT_CAP_BYTES + len(
        "\n...[truncated at 32KB]"
    )
    # Two trailing newlines surround the section in the assembled prompt;
    # the actual content sits inside, so length <= max_expected + a small
    # padding for the trailing newline.
    assert len(story_section.rstrip()) <= max_expected, (
        f"story section length {len(story_section.rstrip())} exceeds "
        f"expected cap {max_expected}"
    )
