"""A docs-chain story stays on the docs chain when it is recovered or resumed.

Story 17 (dev-tools:019, 2026-11-08): the docs onboarder wrote 19 context files,
its commit failed in the pre-commit hook, and the story parked in
``blocked_tests_need_clarification``. Auto-recovery moved it to ``sm_done`` (the
code chain's re-entry), which dispatched dev; dev refused documentation-only
work and parked it ``blocked_underspecified``. ``factory job resume`` would have
sent it to ``dev_retry`` the same way.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers as handlers_module
from factory.chain.event_log import log_story_event, read_story_events
from factory.chain.handlers import handle_docs_onboarder, persist_story
from factory.chain.orchestrator import _dispatch_for_story, _recover_blocked_stories
from factory.chain.resume import infer_point, plan_resume
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _reload(db: Path, sid: int | None) -> StoryRecord:
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return ses.exec(select(StoryRecord).where(StoryRecord.id == sid)).one()


def _docs_story(db: Path, *, state: str, **kw: Any) -> StoryRecord:
    fields: dict[str, Any] = {
        "direction_id": "019",
        "app": "sacrifice",
        "title": "Generate context",
        "slug": "generate-context",
        "scope": "docs",
        "state": state,
        "chain_kind": "docs",
        "pipeline": "solo",
        "github_issue_number": 65,
        "story_file_path": "stories/65-generate-context.md",
    }
    fields.update(kw)
    return persist_story(StoryRecord(**fields), db)


# --------------------------------------------------------------------------- #
# Auto-recovery
# --------------------------------------------------------------------------- #


def test_a_blocked_docs_story_recovers_onto_the_docs_chain(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _docs_story(
        db,
        state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
        error="docs_onboarder commit failed: git commit ... rc=1",
        sm_result_json="{}",
    )

    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)

    assert out == [
        (s.slug, StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.DOCS_SM_DONE.value)
    ]
    r = _reload(db, s.id)
    assert r.state == StoryState.DOCS_SM_DONE.value
    assert _dispatch_for_story(r) == "docs_onboarder"


def test_a_code_story_still_recovers_to_sm_done(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _docs_story(db, state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, chain_kind="tdd")
    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out and out[0][2] == StoryState.SM_DONE.value
    assert _reload(db, s.id).state == StoryState.SM_DONE.value


def test_the_docs_recovery_budget_is_capped(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _docs_story(db, state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, error="e1")
    for i in range(2):
        log_story_event(
            s.id,
            "auto_recovery",
            {"from_state": s.state, "to_state": StoryState.DOCS_SM_DONE.value, "failure_signature": f"x{i}"},
            software_factory_root=tmp_path,
            slug_hint=s.slug,
        )
    assert _recover_blocked_stories(db, "sacrifice", root=tmp_path) == []
    assert _reload(db, s.id).state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value


# --------------------------------------------------------------------------- #
# Operator / job resume
# --------------------------------------------------------------------------- #


def test_infer_point_never_sends_a_docs_story_to_dev() -> None:
    def mk(**kw: Any) -> StoryRecord:
        base: dict[str, Any] = {
            "direction_id": "019",
            "app": "sacrifice",
            "title": "t",
            "slug": "s",
            "scope": "docs",
            "chain_kind": "docs",
            "state": StoryState.BLOCKED_UNDERSPECIFIED.value,
        }
        base.update(kw)
        return StoryRecord(**base)

    assert infer_point(mk(sm_result_json="{}")) == "docs"
    # story 17's row: the refused dev run left no attempts, but even one is not a reason.
    assert infer_point(mk(sm_result_json="{}", dev_attempts_json=json.dumps([{"attempt": 1}]))) == "docs"
    assert infer_point(mk(github_pr_number=7, sm_result_json="{}")) == "gates"
    assert infer_point(mk()) == "sm"


def test_job_resume_puts_story_17_back_on_the_docs_onboarder(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _docs_story(
        db,
        state=StoryState.BLOCKED_UNDERSPECIFIED.value,
        sm_result_json="{}",
        total_spend_usd=0.1288,
        error="dev declared the story underspecified: The story is documentation-only",
    )
    plan = plan_resume(story=s, db=db, root=tmp_path, point="auto")
    assert plan.ok, plan.refusals
    assert (plan.point, plan.to_state) == ("docs", StoryState.DOCS_SM_DONE.value)


@pytest.mark.parametrize("point", ["dev", "review", "tech_writer"])
def test_a_code_step_is_refused_for_a_docs_story(tmp_path: Path, point: str) -> None:
    db = _seed(tmp_path)
    s = _docs_story(db, state=StoryState.BLOCKED_UNDERSPECIFIED.value, sm_result_json="{}")
    plan = plan_resume(story=s, db=db, root=tmp_path, point=point)
    assert not plan.ok
    assert "not a step of the docs chain" in plan.refusals[0]


def test_the_docs_step_is_refused_for_a_code_story(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _docs_story(db, state=StoryState.BLOCKED_UNDERSPECIFIED.value, chain_kind="tdd")
    plan = plan_resume(story=s, db=db, root=tmp_path, point="docs")
    assert not plan.ok
    assert "not a step of the tdd chain" in plan.refusals[0]


# --------------------------------------------------------------------------- #
# The re-run onboarder commits the output a failed commit left behind
# --------------------------------------------------------------------------- #


def _git(path: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=str(path), check=True, capture_output=True, text=True).stdout


@pytest.fixture
def factory_tree(tmp_path: Path) -> Iterator[tuple[Path, Path, AppConfig]]:
    root = tmp_path / "software-factory"
    (root / "state").mkdir(parents=True)
    (root / "apps" / "sacrifice" / "stories").mkdir(parents=True)
    target = tmp_path / "sacrifice"
    target.mkdir()
    _git(target, "init", "-q", "--initial-branch=main")
    _git(target, "config", "user.email", "t@e.x")
    _git(target, "config", "user.name", "T E")
    (target / "README.md").write_text("# x\n", encoding="utf-8")
    _git(target, "add", ".")
    _git(target, "commit", "-q", "-m", "init")
    cfg = AppConfig(name="sacrifice", repo="x/y", default_branch="main", app_repo_path=str(target))
    yield root, target, cfg


def _set_hook(target: Path, failing: bool) -> None:
    hook = target / ".git" / "hooks" / "pre-commit"
    if failing:
        hook.write_text(
            "#!/bin/sh\necho 'tests: software-factory: FAILED (exit 4)' >&2\nexit 1\n", encoding="utf-8"
        )
        hook.chmod(0o755)
    elif hook.exists():
        hook.unlink()


def _handler_end(root: Path, story: StoryRecord, result: Any) -> None:
    """What the orchestrator logs after every dispatch (``handler_end``)."""
    log_story_event(
        story.id,
        "handler_end",
        {"handler": "docs_onboarder", "to_state": story.state, "had_error": bool(result.error), "error": result.error},
        software_factory_root=root,
        slug_hint=story.slug,
    )


def _writing_onboarder(calls: list[Path], files: tuple[str, ...] = ("context/project.md", "context/modules/a.md")):
    async def _run(*args: Any, **kwargs: Any) -> RunResult:
        repo = Path(kwargs["repo_path"])
        calls.append(repo)
        for rel in files:
            (repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (repo / rel).write_text(f"# {rel}\n", encoding="utf-8")
        return RunResult(success=True, files_changed=list(files), cost_usd=0.12, summary="wrote context")

    return _run


def test_story_17_replay_commits_the_pending_output_without_a_new_model_run(
    factory_tree: tuple[Path, Path, AppConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    root, target, cfg = factory_tree
    db = root / "state" / "factory.db"
    calls: list[Path] = []
    monkeypatch.setattr(runner_module, "sandbox_run", _writing_onboarder(calls))
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/deepseek-v4-flash")
    story = _docs_story(db, state=StoryState.DOCS_SM_DONE.value, sm_result_json="{}")

    _set_hook(target, failing=True)
    first = handle_docs_onboarder(story, cfg, root, dry_run=False, db_path=db)
    _handler_end(root, story, first)
    assert first.next_state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION
    assert first.error and first.error.startswith("docs_onboarder commit failed")
    assert "FAILED (exit 4)" in first.error
    assert len(calls) == 1

    assert _recover_blocked_stories(db, "sacrifice", root=root)[0][2] == StoryState.DOCS_SM_DONE.value
    story = _reload(db, story.id)

    _set_hook(target, failing=False)
    second = handle_docs_onboarder(story, cfg, root, dry_run=False, db_path=db)

    assert second.next_state == StoryState.DOCS_ONBOARDER_DONE, second.error
    assert len(calls) == 1, "the onboarder ran again instead of committing its output"
    wt = calls[0]
    assert "docs(context)" in _git(wt, "log", "--oneline", "-1")
    assert set(_git(wt, "show", "--name-only", "--format=", "HEAD").split()) == {
        "context/project.md",
        "context/modules/a.md",
    }
    events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
    reused = [e for e in events if e.get("event") == "docs_onboarder_output_reused"]
    assert reused and reused[-1]["count"] == 2


def test_output_is_regenerated_when_the_last_pass_did_not_fail_at_the_commit(
    factory_tree: tuple[Path, Path, AppConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A sandbox killed mid-write also leaves files; only a failed commit vouches for them."""
    root, target, cfg = factory_tree
    db = root / "state" / "factory.db"
    calls: list[Path] = []
    monkeypatch.setattr(runner_module, "sandbox_run", _writing_onboarder(calls))
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/deepseek-v4-flash")
    story = _docs_story(db, state=StoryState.DOCS_SM_DONE.value, sm_result_json="{}")
    wt = handlers_module._writing_worktree(cfg, root, story)
    (wt / "context").mkdir()
    (wt / "context" / "partial.md").write_text("half\n", encoding="utf-8")
    log_story_event(
        story.id,
        "handler_end",
        {"handler": "docs_onboarder", "error": "stale in-progress handler pruned"},
        software_factory_root=root,
        slug_hint=story.slug,
    )

    result = handle_docs_onboarder(story, cfg, root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.DOCS_ONBOARDER_DONE
    assert len(calls) == 1


def test_output_is_regenerated_when_files_outside_the_context_are_dirty(
    factory_tree: tuple[Path, Path, AppConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    root, target, cfg = factory_tree
    db = root / "state" / "factory.db"
    calls: list[Path] = []
    monkeypatch.setattr(runner_module, "sandbox_run", _writing_onboarder(calls))
    monkeypatch.setattr(handlers_module, "route", lambda *a, **kw: "azure/deepseek-v4-flash")
    story = _docs_story(db, state=StoryState.DOCS_SM_DONE.value, sm_result_json="{}")
    wt = handlers_module._writing_worktree(cfg, root, story)
    (wt / "context").mkdir()
    (wt / "context" / "project.md").write_text("x\n", encoding="utf-8")
    (wt / "app.py").write_text("x = 1\n", encoding="utf-8")
    log_story_event(
        story.id,
        "handler_end",
        {"handler": "docs_onboarder", "error": "docs_onboarder commit failed: rc=1"},
        software_factory_root=root,
        slug_hint=story.slug,
    )

    handle_docs_onboarder(story, cfg, root, dry_run=False, db_path=db)

    assert len(calls) == 1
