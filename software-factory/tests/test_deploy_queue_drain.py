"""Tests for ``deploy_queue`` enqueue + drain.

Verifies:
  * auto_merge enqueues a deploy candidate on successful merge
  * drain_deploy_queue drains entries in FIFO order
  * drain respects deploy-frozen mode (entries marked skipped)
  * processed entries are not re-drained
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from sqlmodel import Session, create_engine, select

from factory.chain.auto_merge import FixturePR, auto_merge_tick
from factory.chain.state_machine import StoryRecord, StoryState
from factory.deploy.models import DeployActionRecord, DeployQueueEntry
from factory.deploy.orchestrator import (
    drain_deploy_queue,
    enqueue_deploy,
)
from factory.settings.modes import set_mode


def _write_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    cfg = {
        "name": "sacrifice",
        "repo": "o/r",
        "default_branch": "main",
        "deploy": {
            "enabled": True,
            "deploy_command": "echo deploy",
            "health_check_command": "echo h",
            "smoke_test_command": "echo s",
            "rollback_command": "echo r",
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


def test_enqueue_then_drain_runs_each_entry_in_order(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    enqueue_deploy(app="sacrifice", sha="a" * 40, merged_pr_number=1, software_factory_root=root)
    enqueue_deploy(app="sacrifice", sha="b" * 40, merged_pr_number=2, software_factory_root=root)

    actions = drain_deploy_queue(
        app="sacrifice",
        software_factory_root=root,
        dry_run=True,
    )
    assert len(actions) == 2
    # FIFO — first row queued is first row drained.
    assert actions[0].merged_sha == "a" * 40
    assert actions[1].merged_sha == "b" * 40
    # Both were dry-run successful.
    assert all(a.success for a in actions)

    # Queue is fully processed.
    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployQueueEntry)).all()
    assert all(r.processed_at is not None for r in rows)
    assert {r.result_status for r in rows} == {"deployed"}


def test_drain_respects_deploy_frozen_mode(tmp_path: Path) -> None:
    """Mode=deploy-frozen → drained entries mark deploy as skipped."""
    root = _write_root(tmp_path)
    set_mode("deploy-frozen", root)
    enqueue_deploy(app="sacrifice", sha="z" * 40, merged_pr_number=9, software_factory_root=root)

    actions = drain_deploy_queue(
        app="sacrifice",
        software_factory_root=root,
        dry_run=True,
    )
    assert len(actions) == 1
    assert actions[0].error == "mode_blocks_deploy"

    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        q = session.exec(select(DeployQueueEntry)).all()
        dep = session.exec(select(DeployActionRecord)).all()
    assert q[0].result_status == "skipped"
    assert dep[0].status == "skipped"


def test_drain_does_not_replay_processed_entries(tmp_path: Path) -> None:
    """A second drain after a first finds nothing pending."""
    root = _write_root(tmp_path)
    enqueue_deploy(app="sacrifice", sha="q" * 40, merged_pr_number=11, software_factory_root=root)
    first = drain_deploy_queue(app="sacrifice", software_factory_root=root, dry_run=True)
    assert len(first) == 1
    second = drain_deploy_queue(app="sacrifice", software_factory_root=root, dry_run=True)
    assert second == []


def test_auto_merge_enqueues_deploy_on_successful_merge(tmp_path: Path) -> None:
    """auto_merge_tick writes a deploy_queue row whenever a merge succeeds."""
    root = _write_root(tmp_path)
    story = StoryRecord(
        direction_id="002",
        app="sacrifice",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        test_plan_json=json.dumps({"test_plan": [{"name": "test_a", "key_steps": ["x"]}]}),
        tech_writer_result_json=json.dumps({"context_updates": [{"path": "context/project.md"}]}),
        github_pr_number=99,
    )
    fixture = FixturePR(
        pr_number=99,
        head_sha="m" * 40,
        base_branch="main",
        labels=[],
        files_changed=["src/foo.py"],
        ci_state="success",
        story=story,
    )
    actions = auto_merge_tick(root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert actions[0].merged is True

    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        queue = session.exec(select(DeployQueueEntry)).all()
    assert len(queue) == 1
    assert queue[0].app == "sacrifice"
    assert queue[0].sha == "m" * 40
    assert queue[0].merged_pr_number == 99
    assert queue[0].processed_at is None


def test_drain_writes_one_deploy_action_per_entry(tmp_path: Path) -> None:
    """Each queue entry produces one DeployActionRecord row."""
    root = _write_root(tmp_path)
    enqueue_deploy(app="sacrifice", sha="1" * 40, merged_pr_number=1, software_factory_root=root)
    enqueue_deploy(app="sacrifice", sha="2" * 40, merged_pr_number=2, software_factory_root=root)
    drain_deploy_queue(app="sacrifice", software_factory_root=root, dry_run=True)

    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployActionRecord)).all()
    shas = sorted(r.sha for r in rows)
    assert shas == ["1" * 40, "2" * 40]
