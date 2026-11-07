"""End-to-end docs-chain integration test (dry-run mode).

Drives a docs-kind story through the orchestrator and verifies the
transitions land in the expected order: STORY_CREATED → DOCS_SM_IN_PROGRESS
→ DOCS_SM_DONE → DOCS_ONBOARDER_IN_PROGRESS → DOCS_ONBOARDER_DONE →
DOCS_ENFORCER_CHECK → PR_OPEN.

The TDD path (test_design / test_impl / dev) MUST NOT appear anywhere on a
docs-kind story's transition history. That's the whole point of the docs
chain — it skips the red→green loop entirely.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.app_config import AppConfig
from factory.chain import orchestrator
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def factory_tree(tmp_path: Path) -> Path:
    """Minimal factory layout — enough for the orchestrator to find a story."""
    factory_root = tmp_path / "software-factory"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "stories").mkdir(parents=True)
    # App config so ``load_app_config`` succeeds in the orchestrator tick.
    # Point ``app_repo_path`` at an in-tree sibling to keep all writes inside
    # the tmp tree.
    (tmp_path / "sacrifice").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "config.yaml").write_text(
        f"name: sacrifice\nrepo: x/y\ndefault_branch: main\n"
        f"app_repo_path: {tmp_path / 'sacrifice'}\n",
        encoding="utf-8",
    )
    # Direction folder so ``find_direction_for_story`` doesn't return None.
    direction_dir = factory_root / "apps" / "sacrifice" / "directions" / "005-bootstrap-context"
    direction_dir.mkdir(parents=True)
    (direction_dir / "direction.md").write_text(
        "---\ntitle: Bootstrap canonical context\ntype: docs\nexplore: true\n---\n\n"
        "# Bootstrap\n\nProduce canonical context.\n",
        encoding="utf-8",
    )
    (direction_dir / "state.yaml").write_text("status: pm-validated\n", encoding="utf-8")
    return factory_root


@pytest.fixture
def app_config() -> AppConfig:
    return AppConfig(name="sacrifice", repo="x/y", default_branch="main")


def _docs_story(state: StoryState, factory_root: Path) -> StoryRecord:
    """Persist a docs-kind story at ``state``."""
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="Bootstrap context",
            slug="bootstrap-ctx",
            scope="docs",
            state=state.value,
            chain_kind="docs",
            github_issue_number=42,
            story_file_path="stories/42-bootstrap-ctx.md",
        ),
        factory_root / "state" / "factory.db",
    )


def test_docs_chain_dry_run_reaches_pr_open(factory_tree: Path, app_config: AppConfig) -> None:
    """Drive a docs story through the orchestrator dry-run loop and assert
    it reaches PR_OPEN via the docs path (NOT through test_design)."""
    story = _docs_story(StoryState.STORY_CREATED, factory_tree)

    summary = orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
        # 10 advances is plenty — docs chain has at most 6 transitions to
        # reach PR_OPEN. Test fails fast if the chain loops.
        max_advances_per_story=10,
    )

    # Refresh from DB so we see the chain's final state.
    from sqlmodel import Session, create_engine, select

    eng = create_engine(f"sqlite:///{factory_tree / 'state' / 'factory.db'}", echo=False)
    with Session(eng) as session:
        refreshed = session.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()

    assert refreshed.state == StoryState.PR_OPEN.value, (
        f"docs chain should land at PR_OPEN; got {refreshed.state!r}. tick summary: {summary}"
    )


def test_docs_chain_does_not_invoke_tdd_handlers(
    factory_tree: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sentinel test: monkeypatch the TDD handlers to raise; the docs path
    must reach PR_OPEN without invoking any of them.

    This is the regression guard against routing-table bugs where the
    chain_kind branch in ``_dispatch_for_story`` gets skipped after
    STORY_CREATED.
    """
    from factory.chain import handlers as handlers_module

    def _explode(*args: object, **kwargs: object) -> object:
        raise AssertionError("TDD handler called on a docs-kind story — chain routing is wrong")

    monkeypatch.setattr(handlers_module, "handle_sm", _explode)
    monkeypatch.setattr(handlers_module, "handle_dev", _explode)
    monkeypatch.setattr(handlers_module, "handle_review", _explode)
    monkeypatch.setattr(handlers_module, "handle_tech_writer", _explode)

    story = _docs_story(StoryState.STORY_CREATED, factory_tree)

    orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
        max_advances_per_story=10,
    )

    # Just verifying no TDD handler ran. The state assertion in the prior
    # test covers the positive flow.
    from sqlmodel import Session, create_engine, select

    eng = create_engine(f"sqlite:///{factory_tree / 'state' / 'factory.db'}", echo=False)
    with Session(eng) as session:
        refreshed = session.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert refreshed.state == StoryState.PR_OPEN.value


def test_tdd_kind_story_still_uses_tdd_chain(factory_tree: Path, app_config: AppConfig) -> None:
    """Sanity check: a chain_kind='tdd' story at STORY_CREATED dispatches
    to ``handle_sm`` — the historical path is preserved.

    Catches the inverse failure mode of the previous test: if the docs
    branch over-applied and stole TDD stories too.
    """
    story = persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="Implement endpoint",
            slug="impl-endpoint",
            scope="backend",
            state=StoryState.STORY_CREATED.value,
            chain_kind="tdd",
            github_issue_number=43,
            story_file_path="stories/43-impl-endpoint.md",
        ),
        factory_tree / "state" / "factory.db",
    )

    orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
        max_advances_per_story=1,  # one step is enough to see SM dispatch
    )

    from sqlmodel import Session, create_engine, select

    eng = create_engine(f"sqlite:///{factory_tree / 'state' / 'factory.db'}", echo=False)
    with Session(eng) as session:
        refreshed = session.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()

    # SM handler ran (would have advanced past STORY_CREATED into the SM
    # progression). Specifically: SM_DONE after a single advance.
    assert refreshed.state != StoryState.DOCS_SM_IN_PROGRESS.value
    assert refreshed.state != StoryState.DOCS_SM_DONE.value
    # SM dry-run advances to SM_DONE in one tick step.
    assert refreshed.state in (StoryState.SM_DONE.value, StoryState.SM_IN_PROGRESS.value)


def test_second_docs_story_deferred_while_another_has_open_pr(
    factory_tree: Path, app_config: AppConfig
) -> None:
    """Docs serialization gate: while one docs story for the app holds an open
    PR, a second docs story must NOT leave STORY_CREATED.

    Regression guard for the blocked_deploy_failed docs backlog — two docs PRs
    open at once rewrite overlapping context files and conflict at merge time
    (observed: PRs #88/#89). The first must fully deploy before the second
    starts, so the second regenerates against the first's merged content.
    """
    db = factory_tree / "state" / "factory.db"
    # Story A already mid-flight with an open PR (active for serialization).
    active = persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="Docs A",
            slug="docs-a",
            scope="docs",
            state=StoryState.PR_OPEN.value,
            chain_kind="docs",
            github_issue_number=50,
            github_pr_number=88,
            story_file_path="stories/50-docs-a.md",
        ),
        db,
    )
    # Story B freshly queued — must be held back.
    queued = persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="Docs B",
            slug="docs-b",
            scope="docs",
            state=StoryState.STORY_CREATED.value,
            chain_kind="docs",
            github_issue_number=51,
            story_file_path="stories/51-docs-b.md",
        ),
        db,
    )

    orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=db,
        max_advances_per_story=10,
    )

    from sqlmodel import Session, create_engine, select

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        b = session.exec(select(StoryRecord).where(StoryRecord.id == queued.id)).one()
        a = session.exec(select(StoryRecord).where(StoryRecord.id == active.id)).one()
    # B stays queued (deferred); A (terminal-for-orchestrator PR_OPEN) untouched.
    assert b.state == StoryState.STORY_CREATED.value, (
        f"second docs story should be deferred while another has an open PR; got {b.state!r}"
    )
    assert a.state == StoryState.PR_OPEN.value
