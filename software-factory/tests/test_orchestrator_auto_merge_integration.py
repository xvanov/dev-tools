"""End-of-tick auto-merge wiring.

The orchestrator's ``tick`` calls ``auto_merge_tick`` after every story
handler has run when ``factory_settings.auto_merge.enabled=true`` and
the factory mode is not ``paused`` / ``drain-reviews``.

These tests drive the wiring in dry-run mode so no GitHub mutations
escape the process: the merge worker reads local StoryRecords, evaluates
gates, and records a decision on the TickSummary.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.chain import orchestrator
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.settings.loader import reload_settings


@pytest.fixture
def factory_tree(tmp_path: Path) -> Path:
    """Minimal factory layout — app config, state dir, no LLM keys needed."""
    factory_root = tmp_path / "software-factory"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice").mkdir(parents=True)
    (tmp_path / "sacrifice").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "config.yaml").write_text(
        f"name: sacrifice\nrepo: x/y\ndefault_branch: main\n"
        f"app_repo_path: {tmp_path / 'sacrifice'}\n"
        "gates:\n"
        "  lint_command: 'ruff check .'\n"
        "  format_check_command: 'ruff format --check .'\n"
        "  type_check_command: 'mypy .'\n"
        "  coverage_command: 'pytest --cov-fail-under=70'\n",
        encoding="utf-8",
    )
    return factory_root


def _persist_docs_pr_open_story(factory_root: Path) -> StoryRecord:
    """Persist a docs-chain story already sitting at PR_OPEN."""
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="Bootstrap context",
            slug="bootstrap-ctx",
            scope="docs",
            state=StoryState.PR_OPEN.value,
            chain_kind="docs",
            github_issue_number=42,
            github_pr_number=123,
            story_file_path="stories/42-bootstrap-ctx.md",
        ),
        factory_root / "state" / "factory.db",
    )


def _write_settings(factory_root: Path, *, auto_merge_enabled: bool) -> None:
    (factory_root / "factory_settings.yaml").write_text(
        "caps:\n  daily_spend_usd: 100\n"
        "auto_merge:\n"
        f"  enabled: {'true' if auto_merge_enabled else 'false'}\n"
        "  trigger: end_of_tick\n"
        "  merge_method: squash\n"
        "  wait_for_ci: true\n"
        "  delete_branch_after_merge: true\n",
        encoding="utf-8",
    )
    # Bust the loader cache so the next ``load_settings`` re-reads the file.
    reload_settings(factory_root)


def test_tick_auto_merges_docs_chain_story_at_pr_open(factory_tree: Path) -> None:
    """A docs-chain story at PR_OPEN gets a merge decision recorded on the
    TickSummary when ``auto_merge.enabled=true``.

    No in-flight stories exist (PR_OPEN is terminal for ``stories_in_flight``)
    but the merge hook still fires.
    """
    _write_settings(factory_tree, auto_merge_enabled=True)
    _persist_docs_pr_open_story(factory_tree)

    summary = orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
    )

    assert len(summary.merges) == 1, (
        f"expected one merge decision; got {len(summary.merges)}. summary={summary}"
    )
    action = summary.merges[0]
    assert action.merged, action.reason
    assert action.pr_number == 123
    assert "docs chain" in action.reason


def test_tick_skips_auto_merge_when_disabled(factory_tree: Path) -> None:
    """``auto_merge.enabled=false`` means the hook does not fire even when
    a mergeable story is sitting at PR_OPEN."""
    _write_settings(factory_tree, auto_merge_enabled=False)
    _persist_docs_pr_open_story(factory_tree)

    summary = orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
    )
    assert summary.merges == []


def test_tick_skips_auto_merge_when_mode_paused(factory_tree: Path) -> None:
    """In ``paused`` mode the merge hook is suppressed alongside the rest
    of the chain — operators expect a true pause to halt all forward
    motion, including merges."""
    _write_settings(factory_tree, auto_merge_enabled=True)
    _persist_docs_pr_open_story(factory_tree)

    from factory.settings.modes import set_mode

    set_mode("paused", factory_tree, db_path=factory_tree / "state" / "factory.db")

    summary = orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
    )
    assert summary.merges == []


def test_tick_summary_serializes_merges(factory_tree: Path) -> None:
    """``tick_summary_as_dict`` includes the merges list so the webhook /
    JSON consumers see the same data the rich CLI does."""
    _write_settings(factory_tree, auto_merge_enabled=True)
    _persist_docs_pr_open_story(factory_tree)

    summary = orchestrator.tick(
        factory_tree,
        "sacrifice",
        dry_run=True,
        db_path=factory_tree / "state" / "factory.db",
    )
    d = orchestrator.tick_summary_as_dict(summary)
    assert "merges" in d
    assert len(d["merges"]) == 1
    assert d["merges"][0]["merged"] is True
    assert d["merges"][0]["pr_number"] == 123
