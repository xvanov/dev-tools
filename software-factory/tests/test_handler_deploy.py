"""Tests for ``factory.chain.handlers.handle_deploy`` (Phase 5).

Dry-run with fixture step outputs. Verifies:

  * happy path → StoryState.DEPLOY_PENDING → DEPLOYED
  * deploy failure → BLOCKED_DEPLOY_FAILED
  * deploy.enabled=false short-circuits to DEPLOYED with skip marker
  * called from a non-DEPLOY_PENDING state surfaces an error
  * missing PR number → DEPLOYED with skip marker (defensive)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from factory.app_config import load_app_config
from factory.chain.handlers import handle_deploy, persist_story
from factory.chain.state_machine import StoryRecord, StoryState


def _write_root(tmp_path: Path, deploy: dict[str, Any] | None = None) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    cfg: dict[str, Any] = {
        "name": "sacrifice",
        "repo": "o/r",
        "default_branch": "main",
        "deploy": deploy
        if deploy is not None
        else {
            "enabled": True,
            "deploy_command": "echo deploy",
            "health_check_command": "echo healthy",
            "smoke_test_command": "echo smoke",
            "rollback_command": "echo rollback",
            "pre_deploy_commands": [],
        },
    }
    (apps / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    (tmp_path / "factory_settings.yaml").write_text(
        "modes:\n  default: normal\n  available: [normal, fix-only, paused, deploy-frozen]\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)
    return tmp_path


def _make_story(root: Path, *, pr: int | None = 42) -> StoryRecord:
    story = StoryRecord(
        direction_id="001",
        app="sacrifice",
        title="add /healthz",
        slug="add-healthz",
        scope="backend",
        state=StoryState.DEPLOY_PENDING.value,
        github_pr_number=pr,
    )
    persist_story(story, root / "state" / "factory.db")
    return story


def test_handle_deploy_happy_path_transitions_to_deployed(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root)

    result = handle_deploy(
        story,
        cfg,
        root,
        dry_run=True,
        fixture_step_outputs=[(0, "", "")] * 10,
    )
    assert result.error is None
    assert result.next_state == StoryState.DEPLOYED
    assert story.state == StoryState.DEPLOYED.value


def test_handle_deploy_smoke_failure_routes_to_blocked(tmp_path: Path) -> None:
    """Smoke test red → DeployAction.success=False → BLOCKED_DEPLOY_FAILED.

    The orchestrator's rollback path runs before the handler sees the
    failure, so we ALSO assert the action.rolled_back propagates into
    handler payload.
    """
    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root)

    result = handle_deploy(
        story,
        cfg,
        root,
        dry_run=True,
        fixture_step_outputs_by_phase={
            "deploy": [(0, "", "")],
            "health_check": [(0, "", "")],
            "smoke_test": [(1, "", "smoke red")],
            "rollback": [(0, "", "")],
        },
    )
    assert result.error is not None
    assert "smoke_test_failed" in (result.error or "")
    assert result.next_state == StoryState.BLOCKED_DEPLOY_FAILED
    assert story.state == StoryState.BLOCKED_DEPLOY_FAILED.value
    assert result.payload.get("rolled_back") is True
    # p0 issue was synthesized for dry-run.
    assert result.payload.get("p0_issue_number") == 7000 + 42


def test_handle_deploy_skips_when_disabled_in_config(tmp_path: Path) -> None:
    root = _write_root(
        tmp_path,
        {
            "enabled": False,
            "deploy_command": "echo deploy",
            "health_check_command": "echo h",
            "smoke_test_command": "echo s",
            "rollback_command": "echo r",
        },
    )
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root)

    result = handle_deploy(story, cfg, root, dry_run=True)
    # Even when deploy is disabled the chain should reach a terminal
    # state (DEPLOYED with skip marker) — otherwise the story would sit
    # in DEPLOY_PENDING forever, blocking the orchestrator.
    assert result.next_state == StoryState.DEPLOYED
    assert story.state == StoryState.DEPLOYED.value
    assert result.payload.get("skipped") is True


def test_handle_deploy_refuses_outside_deploy_pending(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = StoryRecord(
        direction_id="001",
        app="sacrifice",
        title="t",
        slug="t",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        github_pr_number=99,
    )
    persist_story(story, root / "state" / "factory.db")

    result = handle_deploy(story, cfg, root, dry_run=True)
    assert result.error is not None
    assert "non-deploy_pending" in (result.error or "")
    # State unchanged.
    assert story.state == StoryState.PR_OPEN.value


def test_handle_deploy_skip_when_no_pr_number(tmp_path: Path) -> None:
    """A DEPLOY_PENDING story without a PR number is gracefully skipped."""
    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root, pr=None)

    result = handle_deploy(story, cfg, root, dry_run=True)
    assert result.next_state == StoryState.DEPLOYED
    assert story.state == StoryState.DEPLOYED.value


def test_handle_deploy_uses_merged_sha_from_merge_actions(tmp_path: Path) -> None:
    """P6.0 #3: handle_deploy looks up the real SHA from merge_actions.

    Insert a ``merge_actions`` row first, then run handle_deploy, then
    assert the persisted ``deploy_actions`` row records the same SHA
    (proving the orchestrator received it).
    """
    from sqlmodel import Session, SQLModel, create_engine, select

    from factory.chain.auto_merge import MergeActionRecord
    from factory.deploy.models import DeployActionRecord

    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root, pr=314)
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    real_sha = "f00dbabe" * 5
    with Session(eng) as session:
        session.add(
            MergeActionRecord(
                app="sacrifice",
                pr_number=314,
                head_sha=real_sha,
                merged=True,
                reason="auto",
                gates_passed_json="[]",
                blocking_labels_json="[]",
            )
        )
        session.commit()

    result = handle_deploy(story, cfg, root, dry_run=True, fixture_step_outputs=[(0, "", "")] * 10)
    assert result.next_state == StoryState.DEPLOYED
    with Session(eng) as session:
        deploy_rows = list(session.exec(select(DeployActionRecord)).all())
    assert len(deploy_rows) == 1
    assert deploy_rows[0].sha == real_sha


def test_handle_deploy_falls_back_when_no_merge_actions(tmp_path: Path) -> None:
    """Without a merge_actions row, dry-run falls back to ``pending-sha``.

    Dry-run preserves the placeholder so existing unit tests that don't
    seed a merge_actions row still exercise the success/failure paths.
    """
    from sqlmodel import Session, create_engine, select

    from factory.deploy.models import DeployActionRecord

    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root, pr=271)

    result = handle_deploy(story, cfg, root, dry_run=True, fixture_step_outputs=[(0, "", "")] * 10)
    assert result.next_state == StoryState.DEPLOYED
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        deploy_rows = list(session.exec(select(DeployActionRecord)).all())
    assert deploy_rows[0].sha == "pending-sha"


def test_handle_deploy_refuses_when_no_merge_actions_real_run(tmp_path: Path) -> None:
    """P6.0 #3: real-run refuses to deploy without a merge_actions row.

    Deploying an unknown SHA is a category error — the handler must
    refuse and leave the story in DEPLOY_PENDING so the chain retries
    once the webhook lands the merge_actions row.
    """
    root = _write_root(tmp_path)
    cfg = load_app_config("sacrifice", root)
    story = _make_story(root, pr=999)
    # NO merge_actions row seeded.

    result = handle_deploy(story, cfg, root, dry_run=False)
    assert result.error is not None
    assert "merge SHA not recorded" in (result.error or "")
    assert "999" in (result.error or "")
    # Story stays in DEPLOY_PENDING so the chain can retry once the
    # merge row lands (the deploy_post_merge subprocess was never
    # invoked — assertion via the absence of a DeployActionRecord row).
    assert story.state == StoryState.DEPLOY_PENDING.value
    from sqlmodel import Session, create_engine, select

    from factory.deploy.models import DeployActionRecord

    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = list(session.exec(select(DeployActionRecord)).all())
    assert rows == []
