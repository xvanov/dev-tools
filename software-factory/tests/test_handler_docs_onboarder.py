"""Docs-chain handlers: ``handle_docs_sm`` + ``handle_docs_onboarder``.

The Onboarder sandbox MUST run against the real app source tree, not the
factory's per-app metadata dir (Bug A regression check for the docs path).
The dry-run variants must not touch the network and must produce
deterministic fixtures the next handler can consume.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.handlers import (
    handle_docs_onboarder,
    handle_docs_sm,
    persist_story,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.name", "T E"], cwd=str(path), check=True)
    (path / "README.md").write_text("# x\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(path), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(path), check=True)


@pytest.fixture
def factory_tree(tmp_path: Path) -> Iterator[tuple[Path, Path]]:
    factory_root = tmp_path / "software-factory"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "stories").mkdir(parents=True)
    target = tmp_path / "sacrifice"
    _init_repo(target)
    yield factory_root, target


def _story_at(state: StoryState, factory_root: Path) -> StoryRecord:
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="Bootstrap context",
            slug="bootstrap-context",
            scope="docs",
            state=state.value,
            chain_kind="docs",
            github_issue_number=42,
            story_file_path="stories/42-bootstrap-context.md",
        ),
        factory_root / "state" / "factory.db",
    )


def _app_config(target: Path) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(target),
    )


# --------------------------------------------------------------------------- #
# handle_docs_sm — dry-run produces story file + advances state
# --------------------------------------------------------------------------- #


def test_docs_sm_dry_run_writes_story_file_and_advances(
    factory_tree: tuple[Path, Path],
) -> None:
    """Dry-run must (a) write a story file shell under apps/<app>/stories/
    and (b) transition the story to DOCS_SM_DONE so the orchestrator's next
    iteration dispatches docs_onboarder."""
    factory_root, target = factory_tree
    cfg = _app_config(target)
    story = _story_at(StoryState.STORY_CREATED, factory_root)

    result = handle_docs_sm(
        story,
        cfg,
        factory_root,
        dry_run=True,
        db_path=factory_root / "state" / "factory.db",
    )

    assert result.next_state == StoryState.DOCS_SM_DONE
    story_path = factory_root / "apps" / "sacrifice" / "stories" / "42-bootstrap-context.md"
    assert story_path.exists()
    body = story_path.read_text(encoding="utf-8")
    assert "context/project.md" in body, "story file should enumerate canonical paths"


def test_docs_sm_records_canonical_paths_in_sm_result(
    factory_tree: tuple[Path, Path],
) -> None:
    """``story.sm_result_json`` carries the canonical-paths list so the
    Onboarder can read it as a hint (and so the integration test can
    inspect SM's output without re-running the handler)."""
    factory_root, target = factory_tree
    cfg = _app_config(target)
    story = _story_at(StoryState.STORY_CREATED, factory_root)

    handle_docs_sm(
        story,
        cfg,
        factory_root,
        dry_run=True,
        db_path=factory_root / "state" / "factory.db",
    )

    assert story.sm_result_json
    sm = json.loads(story.sm_result_json)
    assert "canonical_paths" in sm
    assert "context/project.md" in sm["canonical_paths"]


# --------------------------------------------------------------------------- #
# handle_docs_onboarder — Bug A regression + state transition
# --------------------------------------------------------------------------- #


def test_docs_onboarder_dry_run_advances_state(
    factory_tree: tuple[Path, Path],
) -> None:
    """Dry-run advances to DOCS_ONBOARDER_DONE and records a plausible
    files_changed list under tech_writer_result_json (the enforcer reads
    that field; semantically it's the list of files this story touched)."""
    factory_root, target = factory_tree
    cfg = _app_config(target)
    story = _story_at(StoryState.DOCS_SM_DONE, factory_root)

    result = handle_docs_onboarder(
        story,
        cfg,
        factory_root,
        dry_run=True,
        db_path=factory_root / "state" / "factory.db",
    )

    assert result.next_state == StoryState.DOCS_ONBOARDER_DONE
    assert "context/project.md" in result.payload["files_changed"]
    # The enforcer reads this field. Empty would cause a false-pass.
    assert story.tech_writer_result_json
    tw = json.loads(story.tech_writer_result_json)
    paths = [u["path"] for u in tw["context_updates"]]
    assert "context/project.md" in paths


def test_docs_onboarder_uses_real_app_repo_path(
    factory_tree: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bug A regression for the docs chain: ``handle_docs_onboarder`` must
    pass ``resolve_app_repo_path(...)`` as the sandbox ``repo_path``.

    If this regresses, the Onboarder will operate on the factory's metadata
    dir and silently produce no canonical files under ``~/sacrifice/``.
    """
    factory_root, target = factory_tree
    cfg = _app_config(target)
    story = _story_at(StoryState.DOCS_SM_DONE, factory_root)

    captured: dict[str, Any] = {}

    async def _fake_sandbox_run(*args: Any, **kwargs: Any) -> RunResult:
        captured["repo_path"] = kwargs.get("repo_path")
        captured["persona"] = kwargs.get("persona")
        # Simulate the Onboarder writing a canonical file in the REAL repo.
        target = captured["repo_path"]
        (target / "context").mkdir(parents=True, exist_ok=True)
        (target / "context" / "project.md").write_text("# Project\n", encoding="utf-8")
        return RunResult(
            success=True,
            files_changed=["context/project.md"],
            test_run_passed=None,
            tokens_in=10,
            tokens_out=10,
            cost_usd=0.001,
            summary="fake onboarder",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _fake_sandbox_run, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/deepseek-v4-pro")

    result = handle_docs_onboarder(
        story,
        cfg,
        factory_root,
        dry_run=False,
        db_path=factory_root / "state" / "factory.db",
    )

    assert captured["persona"] == "onboarder"
    # Post-worktree refactor: sandbox runs in the per-story worktree under
    # ``state/worktrees/``. The worktree shares ``.git`` with the source repo
    # at ``target`` so commits made there land on the per-story branch ref.
    repo_path = captured["repo_path"]
    expected_prefix = factory_root / "state" / "worktrees"
    assert str(repo_path).startswith(str(expected_prefix)), (
        f"docs_onboarder must run sandbox in a per-story worktree under "
        f"{expected_prefix}, got {repo_path!r}. Bug A regression."
    )
    assert (Path(repo_path) / ".git").exists()
    # The handler commits the produced files on the feature branch.
    assert result.next_state == StoryState.DOCS_ONBOARDER_DONE
    # Verify the commit exists on the feature branch — read git from the
    # worktree (the source repo's HEAD may be on a different branch).
    log = subprocess.run(
        ["git", "log", "--oneline", "-1"],
        cwd=str(repo_path),
        capture_output=True,
        text=True,
        check=True,
    )
    assert "docs(context)" in log.stdout, (
        f"docs_onboarder should commit canonical files on the feature branch; "
        f"git log shows: {log.stdout!r}"
    )


def test_docs_onboarder_no_files_routes_to_blocked(
    factory_tree: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the Onboarder sandbox writes nothing, the chain must surface that
    explicitly as BLOCKED_TESTS_NEED_CLARIFICATION rather than silently
    advancing through to PR_OPEN with an empty diff."""
    factory_root, target = factory_tree
    cfg = _app_config(target)
    story = _story_at(StoryState.DOCS_SM_DONE, factory_root)

    async def _empty_sandbox(*args: Any, **kwargs: Any) -> RunResult:
        # No files written. Tree stays clean.
        return RunResult(
            success=True,
            files_changed=[],
            test_run_passed=None,
            tokens_in=1,
            tokens_out=1,
            cost_usd=0.0,
            summary="onboarder did nothing",
        )

    monkeypatch.setattr(runner_module, "sandbox_run", _empty_sandbox, raising=True)
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/deepseek-v4-pro")

    result = handle_docs_onboarder(
        story,
        cfg,
        factory_root,
        dry_run=False,
        db_path=factory_root / "state" / "factory.db",
    )

    assert result.next_state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
    assert result.error and "produced no files" in result.error
