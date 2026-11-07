"""Tests for ``pull_request.closed[merged=true]`` webhook routing (Phase 5).

The webhook enqueues a ``deploy_queue`` row and flips the matching
StoryRecord (if any) to DEPLOY_PENDING. We test the pure
``dispatch_event`` path (no FastAPI server).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, create_engine, select

from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.deploy.models import DeployQueueEntry


def _set_factory_root(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    """Point the webhook module at a temp factory root for the duration."""
    import factory.webhook.github as gh

    monkeypatch.setattr(gh, "_FACTORY_ROOT", root)


def _write_sacrifice(root: Path) -> None:
    apps = root / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\ndefault_branch: main\ndeploy:\n  enabled: true\n",
        encoding="utf-8",
    )
    (root / "factory_settings.yaml").write_text(
        "modes:\n  default: normal\n  available: [normal, fix-only, paused, deploy-frozen]\n",
        encoding="utf-8",
    )
    (root / "state").mkdir()
    from factory.settings.loader import reload_settings

    reload_settings(root)


def _make_payload(*, pr_number: int, merged: bool, merge_sha: str, repo: str) -> dict[str, Any]:
    return {
        "action": "closed",
        "pull_request": {
            "number": pr_number,
            "merged": merged,
            "merge_commit_sha": merge_sha,
            "head": {"ref": "story/42-x", "sha": "headsha"},
        },
        "repository": {"full_name": repo},
    }


def test_merged_pr_enqueues_deploy_and_flips_story(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The happy path: a recognized merged PR + a matching READY_FOR_MERGE
    story enqueues a deploy candidate and transitions the story state."""
    root = tmp_path
    _write_sacrifice(root)
    _set_factory_root(monkeypatch, root)

    db = root / "state" / "factory.db"
    story = StoryRecord(
        direction_id="001",
        app="sacrifice",
        title="add /healthz",
        slug="add-healthz",
        scope="backend",
        state=StoryState.READY_FOR_MERGE.value,
        github_pr_number=42,
    )
    persist_story(story, db)

    from factory.webhook.github import dispatch_event

    result = dispatch_event(
        "pull_request",
        _make_payload(pr_number=42, merged=True, merge_sha="cafebabe" * 5, repo="o/r"),
    )

    assert result["acted"] is True
    assert result["pr_number"] == 42
    assert result["merged_sha"] == "cafebabe" * 5
    assert result["app"] == "sacrifice"
    assert result["next"] == "deploy-orchestrator-tick"

    # A deploy_queue row was written.
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployQueueEntry)).all()
    assert len(rows) == 1
    assert rows[0].app == "sacrifice"
    assert rows[0].sha == "cafebabe" * 5
    assert rows[0].merged_pr_number == 42
    assert rows[0].processed_at is None

    # Story flipped to DEPLOY_PENDING.
    with Session(eng) as session:
        s2 = session.exec(select(StoryRecord).where(StoryRecord.id == story.id)).first()
    assert s2 is not None
    assert s2.state == StoryState.DEPLOY_PENDING.value


def test_unmerged_closed_pr_is_ignored(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``action=closed`` with ``merged=false`` is NOT a deploy trigger."""
    root = tmp_path
    _write_sacrifice(root)
    _set_factory_root(monkeypatch, root)

    from factory.webhook.github import dispatch_event

    result = dispatch_event(
        "pull_request",
        _make_payload(pr_number=99, merged=False, merge_sha="", repo="o/r"),
    )
    assert result["acted"] is False, result


def test_merged_pr_with_no_matching_story_still_enqueues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A merged PR whose story we don't track (e.g. a manual PR) still gets
    enqueued so the operator can see the deploy attempt in
    ``factory deploys``."""
    root = tmp_path
    _write_sacrifice(root)
    _set_factory_root(monkeypatch, root)

    from factory.webhook.github import dispatch_event

    result = dispatch_event(
        "pull_request",
        _make_payload(pr_number=777, merged=True, merge_sha="deadbeef" * 5, repo="o/r"),
    )
    assert result["acted"] is True
    assert result["pr_number"] == 777
    assert result["story_slug"] is None
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployQueueEntry)).all()
    assert len(rows) == 1
    assert rows[0].sha == "deadbeef" * 5


def test_merged_pr_for_unknown_repo_does_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Webhook for a repo we don't manage is a no-op (no enqueue)."""
    root = tmp_path
    _write_sacrifice(root)
    _set_factory_root(monkeypatch, root)

    from factory.webhook.github import dispatch_event

    result = dispatch_event(
        "pull_request",
        _make_payload(pr_number=42, merged=True, merge_sha="x" * 40, repo="someone/else"),
    )
    assert result["acted"] is False
    assert "no local app" in result["reason"]
