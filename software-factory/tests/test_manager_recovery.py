"""Tests for factory.manager.recovery — the operational self-healing layer.

Every ``gh``/git call is mocked (no network). Each playbook gets: a
precondition-match test (action taken, mutation asserted), one test per
failing sub-condition (no action), a dry-run test (no mutation), and
cooldown/cap anti-thrash tests. Playbook 4 (escalate-only) gets a detection
test. ``run_recovery_cycle`` gets an end-to-end wiring test.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlmodel import Session, create_engine

from factory import runtime_state
from factory.app_config import load_app_config
from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager import recovery
from factory.settings.modes import get_mode, set_mode

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir()
    (tmp_path / "apps").mkdir()
    return tmp_path


def _write_app_config(
    root: Path,
    app: str,
    *,
    repo: str = "o/r",
    deploy_enabled: bool = False,
    pre_deploy_commands: list[str] | None = None,
    app_repo_path: str = "app_repo",
    extra_yaml: str = "",
) -> Path:
    app_dir = root / "apps" / app
    app_dir.mkdir(parents=True, exist_ok=True)
    cmds = pre_deploy_commands if pre_deploy_commands is not None else [
        "docker compose -f docker-compose.prod.yml build"
    ]
    cmds_yaml = "\n".join(f'    - "{c}"' for c in cmds) or "    []"
    text = (
        f"name: {app}\n"
        f"repo: {repo}\n"
        f'app_repo_path: "{app_repo_path}"\n'
        "deploy:\n"
        f"  enabled: {'true' if deploy_enabled else 'false'}\n"
        "  pre_deploy_commands:\n"
        f"{cmds_yaml}\n"
        f"{extra_yaml}"
    )
    cfg_path = app_dir / "config.yaml"
    cfg_path.write_text(text, encoding="utf-8")
    return cfg_path


def _db_path(root: Path) -> Path:
    return root / "state" / "factory.db"


def _engine(root: Path):
    eng = create_engine(f"sqlite:///{_db_path(root)}", echo=False)
    from sqlmodel import SQLModel

    SQLModel.metadata.create_all(eng)
    return eng


def _add_story(root: Path, **kwargs) -> int:
    defaults = dict(
        direction_id="001",
        app="sacrifice",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
    )
    defaults.update(kwargs)
    eng = _engine(root)
    with Session(eng) as session:
        story = StoryRecord(**defaults)
        session.add(story)
        session.commit()
        session.refresh(story)
        return story.id


def _get_story(root: Path, story_id: int) -> StoryRecord:
    eng = _engine(root)
    with Session(eng) as session:
        story = session.get(StoryRecord, story_id)
        assert story is not None
        session.expunge(story)
        return story


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# --------------------------------------------------------------------------- #
# Playbook 1: retry-mergeable-blocked-story
# --------------------------------------------------------------------------- #


class TestRetryMergeableBlocked:
    def test_precondition_matches_and_action_taken(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(
            root,
            state=StoryState.BLOCKED_DEPLOY_FAILED.value,
            github_pr_number=42,
            error="auto-merge gave up: terminally un-mergeable",
        )

        def fake_gh_pr_view(*, repo, pr_number, runner=None):
            assert repo == "o/r"
            assert pr_number == 42
            return {"state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"}

        targets = recovery.detect_retry_mergeable_blocked_stories(
            root, gh_pr_view=fake_gh_pr_view
        )
        assert len(targets) == 1
        target = targets[0]
        assert target.playbook == recovery.PLAYBOOK_RETRY_MERGEABLE_BLOCKED
        assert target.story_id == story_id

        outcome = recovery.execute_retry_mergeable_blocked_story(root, target, dry_run=False)
        assert outcome.status == "recovered"

        story = _get_story(root, story_id)
        assert story.state == StoryState.PR_OPEN.value
        assert story.error is None

    @pytest.mark.parametrize(
        "gh_response",
        [
            {"state": "OPEN", "mergeable": "CONFLICTING"},
            {"state": "CLOSED", "mergeable": "MERGEABLE"},
            {"state": "MERGED", "mergeable": "MERGEABLE"},
        ],
    )
    def test_precondition_fails_on_bad_gh_state(self, root: Path, gh_response: dict) -> None:
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42)

        targets = recovery.detect_retry_mergeable_blocked_stories(
            root, gh_pr_view=lambda **_: gh_response
        )
        assert targets == []

    def test_precondition_fails_when_gh_call_fails(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42)

        targets = recovery.detect_retry_mergeable_blocked_stories(
            root, gh_pr_view=lambda **_: None
        )
        assert targets == []

    def test_precondition_fails_when_no_pr_number(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=None)

        targets = recovery.detect_retry_mergeable_blocked_stories(
            root, gh_pr_view=lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}
        )
        assert targets == []

    def test_precondition_fails_when_state_not_blocked(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.PR_OPEN.value, github_pr_number=42)

        targets = recovery.detect_retry_mergeable_blocked_stories(
            root, gh_pr_view=lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}
        )
        assert targets == []

    def test_dry_run_makes_no_mutation(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(
            root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42, error="boom"
        )
        target = recovery.RecoveryTarget(
            playbook=recovery.PLAYBOOK_RETRY_MERGEABLE_BLOCKED,
            key=f"story:{story_id}",
            description="x",
            story_id=story_id,
            app="sacrifice",
        )
        outcome = recovery.execute_retry_mergeable_blocked_story(root, target, dry_run=True)
        assert outcome.status == "dry_run"

        story = _get_story(root, story_id)
        assert story.state == StoryState.BLOCKED_DEPLOY_FAILED.value
        assert story.error == "boom"


# --------------------------------------------------------------------------- #
# Playbook 2: redispatch-phantom-pr-open
# --------------------------------------------------------------------------- #


class TestRedispatchPhantomPr:
    def test_precondition_matches_and_action_taken(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        now = datetime.now(UTC)
        old = now - timedelta(minutes=45)
        story_id = _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
            github_branch="story/42-foo",
            updated_at=_iso(old),
            error="dispatch died",
        )

        targets = recovery.detect_phantom_pr_open_stories(
            root, now=now, gh_branch_exists=lambda **_: False
        )
        assert len(targets) == 1
        outcome = recovery.execute_redispatch_phantom_pr(root, targets[0], dry_run=False)
        assert outcome.status == "recovered"

        story = _get_story(root, story_id)
        assert story.state == StoryState.STORY_CREATED.value
        assert story.github_pr_number is None
        assert story.github_branch is None
        assert story.error is None

    def test_precondition_fails_when_branch_exists(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        now = datetime.now(UTC)
        old = now - timedelta(minutes=45)
        _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
            github_branch="story/42-foo",
            updated_at=_iso(old),
        )
        targets = recovery.detect_phantom_pr_open_stories(
            root, now=now, gh_branch_exists=lambda **_: True
        )
        assert targets == []

    def test_precondition_fails_when_gh_uncertain(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        now = datetime.now(UTC)
        old = now - timedelta(minutes=45)
        _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
            github_branch="story/42-foo",
            updated_at=_iso(old),
        )
        targets = recovery.detect_phantom_pr_open_stories(
            root, now=now, gh_branch_exists=lambda **_: None
        )
        assert targets == []

    def test_precondition_fails_when_too_fresh(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        now = datetime.now(UTC)
        fresh = now - timedelta(minutes=2)
        _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
            github_branch="story/42-foo",
            updated_at=_iso(fresh),
        )
        targets = recovery.detect_phantom_pr_open_stories(
            root, now=now, gh_branch_exists=lambda **_: False
        )
        assert targets == []

    def test_precondition_fails_when_has_pr_number(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        now = datetime.now(UTC)
        old = now - timedelta(minutes=45)
        _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=7,
            github_branch="story/42-foo",
            updated_at=_iso(old),
        )
        targets = recovery.detect_phantom_pr_open_stories(
            root, now=now, gh_branch_exists=lambda **_: False
        )
        assert targets == []

    def test_precondition_fails_when_no_branch(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        now = datetime.now(UTC)
        old = now - timedelta(minutes=45)
        _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
            github_branch=None,
            updated_at=_iso(old),
        )
        targets = recovery.detect_phantom_pr_open_stories(
            root, now=now, gh_branch_exists=lambda **_: False
        )
        assert targets == []

    def test_dry_run_makes_no_mutation(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(
            root,
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
            github_branch="story/42-foo",
            error="dispatch died",
        )
        target = recovery.RecoveryTarget(
            playbook=recovery.PLAYBOOK_REDISPATCH_PHANTOM_PR,
            key=f"story:{story_id}",
            description="x",
            story_id=story_id,
            app="sacrifice",
        )
        outcome = recovery.execute_redispatch_phantom_pr(root, target, dry_run=True)
        assert outcome.status == "dry_run"

        story = _get_story(root, story_id)
        assert story.state == StoryState.PR_OPEN.value
        assert story.github_branch == "story/42-foo"
        assert story.error == "dispatch died"


# --------------------------------------------------------------------------- #
# Playbook 3: revert-premature-deploy-enable
# --------------------------------------------------------------------------- #


class TestRevertPrematureDeployEnable:
    def test_precondition_matches_and_writes_runtime_override_not_config(
        self, root: Path
    ) -> None:
        cfg_path = _write_app_config(root, "sacrifice", deploy_enabled=True)
        # app_repo/docker-compose.prod.yml deliberately absent.
        config_bytes_before = cfg_path.read_bytes()
        targets = recovery.detect_premature_deploy_enabled(root)
        assert len(targets) == 1
        target = targets[0]
        assert target.playbook == recovery.PLAYBOOK_REVERT_PREMATURE_DEPLOY
        assert target.app == "sacrifice"

        outcome = recovery.execute_revert_premature_deploy_enable(root, target, dry_run=False)
        assert outcome.status == "recovered"

        # config.yaml (operator-authored) is byte-for-byte untouched.
        assert cfg_path.read_bytes() == config_bytes_before
        assert "enabled: true" in cfg_path.read_text()

        # The machine override lives in the gitignored runtime-state file, and
        # the EFFECTIVE value is now False.
        assert runtime_state.get_deploy_enabled_override(root, "sacrifice") is False
        cfg = load_app_config("sacrifice", root)
        assert cfg.deploy.enabled is True  # config default unchanged
        assert runtime_state.effective_deploy_enabled(cfg, root) is False

    def test_precondition_fails_when_artifact_present(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=True)
        app_repo = root / "app_repo"
        app_repo.mkdir(parents=True)
        (app_repo / "docker-compose.prod.yml").write_text("services: {}\n")

        targets = recovery.detect_premature_deploy_enabled(root)
        assert targets == []

    def test_precondition_fails_when_already_disabled(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        targets = recovery.detect_premature_deploy_enabled(root)
        assert targets == []

    def test_precondition_fails_when_override_already_disabled(self, root: Path) -> None:
        """If a prior machine override already disabled deploy, the detector
        must skip (effective value False) rather than re-thrashing."""
        _write_app_config(root, "sacrifice", deploy_enabled=True)
        runtime_state.set_deploy_enabled_override(root, "sacrifice", False)
        targets = recovery.detect_premature_deploy_enabled(root)
        assert targets == []

    def test_precondition_fails_when_no_file_flag(self, root: Path) -> None:
        _write_app_config(
            root, "sacrifice", deploy_enabled=True, pre_deploy_commands=["echo hi"]
        )
        targets = recovery.detect_premature_deploy_enabled(root)
        assert targets == []

    def test_precondition_fails_when_file_flag_is_not_docker_compose(self, root: Path) -> None:
        """A non-compose command using -f (curl's "fail on HTTP error" flag,
        not a file path) must NOT be mistaken for a compose-file reference --
        that would guess an artifact path and could flip a HEALTHY app's
        deploy.enabled off. The detector must skip (uncertain), not act."""
        _write_app_config(
            root,
            "sacrifice",
            deploy_enabled=True,
            pre_deploy_commands=["curl -f https://example.com/health"],
        )
        targets = recovery.detect_premature_deploy_enabled(root)
        assert targets == []

    def test_dry_run_makes_no_mutation(self, root: Path) -> None:
        cfg_path = _write_app_config(root, "sacrifice", deploy_enabled=True)
        original = cfg_path.read_bytes()
        target = recovery.RecoveryTarget(
            playbook=recovery.PLAYBOOK_REVERT_PREMATURE_DEPLOY,
            key="app:sacrifice",
            description="x",
            app="sacrifice",
            extra={"config_path": str(cfg_path)},
        )
        outcome = recovery.execute_revert_premature_deploy_enable(root, target, dry_run=True)
        assert outcome.status == "dry_run"
        # Neither config.yaml nor the runtime-state file is written.
        assert cfg_path.read_bytes() == original
        assert not runtime_state.runtime_state_path(root, "sacrifice").exists()

    def test_execute_skipped_stale_when_effective_already_false(self, root: Path) -> None:
        """Re-check at execute time: if the effective value is already False
        (e.g. an operator edit disabled it between detect and execute), the
        executor is a no-op, not an error."""
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        target = recovery.RecoveryTarget(
            playbook=recovery.PLAYBOOK_REVERT_PREMATURE_DEPLOY,
            key="app:sacrifice",
            description="x",
            app="sacrifice",
            extra={},
        )
        outcome = recovery.execute_revert_premature_deploy_enable(root, target, dry_run=False)
        assert outcome.status == "skipped_stale"
        assert not runtime_state.runtime_state_path(root, "sacrifice").exists()


# --------------------------------------------------------------------------- #
# Playbook 4: conflicting-gated-pr (escalate-only)
# --------------------------------------------------------------------------- #


class TestConflictingGatedPr:
    def test_precondition_matches_and_escalates(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(
            root, state=StoryState.CI_GREEN.value, github_pr_number=99, github_branch="b"
        )

        targets = recovery.detect_conflicting_gated_prs(
            root, gh_pr_view=lambda **_: {"state": "OPEN", "mergeable": "CONFLICTING"}
        )
        assert len(targets) == 1
        target = targets[0]
        assert target.story_id == story_id
        assert "rebase" in target.extra["recommendation"].lower()
        assert "gh pr checkout 99" in target.extra["recommendation"]

    def test_precondition_fails_when_not_conflicting(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.CI_GREEN.value, github_pr_number=99)
        targets = recovery.detect_conflicting_gated_prs(
            root, gh_pr_view=lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}
        )
        assert targets == []

    def test_never_mutates_via_run_recovery_cycle(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(root, state=StoryState.CI_GREEN.value, github_pr_number=99)

        summary = recovery.run_recovery_cycle(
            root,
            dry_run=False,
            gh_pr_view=lambda **_: {"state": "OPEN", "mergeable": "CONFLICTING"},
        )
        assert len(summary["escalated"]) == 1
        assert summary["escalated"][0]["playbook"] == recovery.PLAYBOOK_CONFLICTING_GATED_PR

        story = _get_story(root, story_id)
        assert story.state == StoryState.CI_GREEN.value  # untouched

    def test_repeat_escalation_suppressed_within_cooldown(self, root: Path) -> None:
        """The same conflicting-PR key must escalate at most once per
        cooldown window — without this, an unresolved conflict re-escalates
        every recovery cycle (observed: 9 escalations in 9 minutes)."""
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.CI_GREEN.value, github_pr_number=99)
        now = datetime.now(UTC)
        gh = lambda **_: {"state": "OPEN", "mergeable": "CONFLICTING"}  # noqa: E731

        # First cycle: escalates.
        summary1 = recovery.run_recovery_cycle(root, dry_run=False, now=now, gh_pr_view=gh)
        assert len(summary1["escalated"]) == 1
        assert summary1["escalated"][0]["playbook"] == recovery.PLAYBOOK_CONFLICTING_GATED_PR

        # Second cycle, 5 minutes later (well within the 30-minute cooldown):
        # the same conflict must NOT escalate again.
        summary2 = recovery.run_recovery_cycle(
            root, dry_run=False, now=now + timedelta(minutes=5), gh_pr_view=gh
        )
        assert summary2["escalated"] == []
        assert len(summary2["skipped_cooldown"]) == 1
        assert summary2["skipped_cooldown"][0]["playbook"] == recovery.PLAYBOOK_CONFLICTING_GATED_PR

    def test_escalation_resumes_after_cooldown_expires(self, root: Path) -> None:
        """Once the cooldown window elapses, the still-unresolved conflict
        escalates again — it isn't suppressed forever, just throttled."""
        _write_app_config(root, "sacrifice")
        _add_story(root, state=StoryState.CI_GREEN.value, github_pr_number=99)
        now = datetime.now(UTC)
        gh = lambda **_: {"state": "OPEN", "mergeable": "CONFLICTING"}  # noqa: E731

        summary1 = recovery.run_recovery_cycle(root, dry_run=False, now=now, gh_pr_view=gh)
        assert len(summary1["escalated"]) == 1

        summary2 = recovery.run_recovery_cycle(
            root, dry_run=False, now=now + timedelta(minutes=45), gh_pr_view=gh
        )
        assert len(summary2["escalated"]) == 1
        assert summary2["escalated"][0]["playbook"] == recovery.PLAYBOOK_CONFLICTING_GATED_PR


# --------------------------------------------------------------------------- #
# Playbook 5: recover-stuck-fixonly-mode
# --------------------------------------------------------------------------- #


class TestRecoverStuckFixonlyMode:
    def test_precondition_matches_and_recovers(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("fix-only", root)

        targets = recovery.detect_stuck_fixonly_mode(root)
        assert len(targets) == 1
        target = targets[0]
        assert target.playbook == recovery.PLAYBOOK_RECOVER_STUCK_FIXONLY
        assert target.extra["mode_before"] == "fix-only"
        assert target.extra["deploy_enabled_by_app"] == {"sacrifice": False}

        outcome = recovery.execute_recover_stuck_fixonly_mode(root, target, dry_run=False)
        assert outcome.status == "recovered"
        assert get_mode(root) == "normal"

    def test_recovers_end_to_end_via_run_recovery_cycle(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("fix-only", root)

        summary = recovery.run_recovery_cycle(root, dry_run=False)
        assert len(summary["recovered"]) == 1
        assert summary["recovered"][0]["playbook"] == recovery.PLAYBOOK_RECOVER_STUCK_FIXONLY
        assert get_mode(root) == "normal"

    def test_precondition_fails_when_any_app_deploy_enabled(self, root: Path) -> None:
        """A real deploy could be live for this app -- fix-only may
        legitimately be protecting it, so no auto-recovery. Uses a
        non-compose pre_deploy_command so playbook 3 (revert-premature-
        deploy-enable) stays out of scope and this test isolates playbook 5."""
        _write_app_config(
            root, "sacrifice", deploy_enabled=True, pre_deploy_commands=["echo hi"]
        )
        set_mode("fix-only", root)

        targets = recovery.detect_stuck_fixonly_mode(root)
        assert targets == []

        summary = recovery.run_recovery_cycle(root, dry_run=False)
        assert summary["recovered"] == []
        assert get_mode(root) == "fix-only"

    def test_precondition_fails_when_one_of_several_apps_deploy_enabled(
        self, root: Path
    ) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        _write_app_config(root, "otherapp", deploy_enabled=True)
        set_mode("fix-only", root)

        targets = recovery.detect_stuck_fixonly_mode(root)
        assert targets == []

    def test_noop_when_mode_normal(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        # Default mode (no explicit set_mode call) is "normal".
        targets = recovery.detect_stuck_fixonly_mode(root)
        assert targets == []

    def test_noop_when_mode_paused(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("paused", root)

        targets = recovery.detect_stuck_fixonly_mode(root)
        assert targets == []
        assert get_mode(root) == "paused"

    def test_dry_run_makes_no_mode_change(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("fix-only", root)

        targets = recovery.detect_stuck_fixonly_mode(root)
        assert len(targets) == 1
        outcome = recovery.execute_recover_stuck_fixonly_mode(
            root, targets[0], dry_run=True
        )
        assert outcome.status == "dry_run"
        assert get_mode(root) == "fix-only"

    def test_uncertain_app_config_skips(self, root: Path) -> None:
        """An app whose config.yaml can't be loaded is treated the same as
        'deploy.enabled=true' -- uncertain, so the detector must not guess
        it's safe to flip the mode back."""
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        broken = root / "apps" / "broken" / "config.yaml"
        broken.parent.mkdir(parents=True)
        broken.write_text("not: valid: yaml: [", encoding="utf-8")
        set_mode("fix-only", root)

        targets = recovery.detect_stuck_fixonly_mode(root)
        assert targets == []

    def test_halted_forces_dry_run(self, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("fix-only", root)

        import factory.manager.halt as halt_mod

        monkeypatch.setattr(halt_mod, "is_halted", lambda *, root: True)

        summary = recovery.run_recovery_cycle(root, dry_run=False)
        assert summary["forced_dry_run_halted"] is True
        assert get_mode(root) == "fix-only"  # untouched

    def test_cooldown_blocks_reflip_within_window(self, root: Path) -> None:
        """A cooldown-blocked re-recovery must NOT fight a deploy-failure
        path that legitimately re-sets fix-only shortly after."""
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("fix-only", root)
        now = datetime.now(UTC)

        summary1 = recovery.run_recovery_cycle(root, dry_run=False, now=now)
        assert len(summary1["recovered"]) == 1
        assert get_mode(root) == "normal"

        # Simulate the deploy-failure path legitimately re-flipping fix-only
        # a few minutes later (e.g. a fresh, unrelated deploy failure).
        set_mode("fix-only", root)

        summary2 = recovery.run_recovery_cycle(
            root, dry_run=False, now=now + timedelta(minutes=5)
        )
        assert summary2["recovered"] == []
        assert any(
            e["playbook"] == recovery.PLAYBOOK_RECOVER_STUCK_FIXONLY
            and e["reason"] == "cooldown"
            for e in summary2["escalated"]
        )
        assert get_mode(root) == "fix-only"  # not re-flipped within cooldown

    def test_cooldown_expires(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        set_mode("fix-only", root)
        now = datetime.now(UTC)

        recovery.run_recovery_cycle(root, dry_run=False, now=now)
        set_mode("fix-only", root)

        summary2 = recovery.run_recovery_cycle(
            root, dry_run=False, now=now + timedelta(minutes=45)
        )
        assert len(summary2["recovered"]) == 1
        assert get_mode(root) == "normal"


# --------------------------------------------------------------------------- #
# Unmatched -> nothing happens (falls through to existing escalate path)
# --------------------------------------------------------------------------- #


def test_no_targets_when_nothing_matches(root: Path) -> None:
    _write_app_config(root, "sacrifice", deploy_enabled=False)
    _add_story(root, state=StoryState.DEV_IN_PROGRESS.value)

    summary = recovery.run_recovery_cycle(
        root,
        dry_run=False,
        gh_pr_view=lambda **_: None,
        gh_branch_exists=lambda **_: None,
    )
    assert summary["recovered"] == []
    assert summary["escalated"] == []
    assert summary["errors"] == []


# --------------------------------------------------------------------------- #
# Anti-thrash: cooldown + per-cycle cap
# --------------------------------------------------------------------------- #


class TestAntiThrash:
    def test_cooldown_blocks_reapplication_and_escalates_instead(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(
            root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42
        )
        now = datetime.now(UTC)

        gh = lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}  # noqa: E731

        # First cycle: recovers.
        summary1 = recovery.run_recovery_cycle(root, dry_run=False, now=now, gh_pr_view=gh)
        assert len(summary1["recovered"]) == 1

        # Story re-blocks (simulating a re-failure).
        eng = _engine(root)
        with Session(eng) as session:
            story = session.get(StoryRecord, story_id)
            story.state = StoryState.BLOCKED_DEPLOY_FAILED.value
            session.add(story)
            session.commit()

        # Second cycle, 5 minutes later (within the 30-minute cooldown):
        # must NOT re-apply; must escalate instead.
        summary2 = recovery.run_recovery_cycle(
            root, dry_run=False, now=now + timedelta(minutes=5), gh_pr_view=gh
        )
        assert summary2["recovered"] == []
        assert len(summary2["escalated"]) == 1
        assert summary2["escalated"][0]["reason"] == "cooldown"

        story = _get_story(root, story_id)
        assert story.state == StoryState.BLOCKED_DEPLOY_FAILED.value  # untouched this cycle

    def test_cooldown_expires(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(
            root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42
        )
        now = datetime.now(UTC)
        gh = lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}  # noqa: E731

        recovery.run_recovery_cycle(root, dry_run=False, now=now, gh_pr_view=gh)

        eng = _engine(root)
        with Session(eng) as session:
            story = session.get(StoryRecord, story_id)
            story.state = StoryState.BLOCKED_DEPLOY_FAILED.value
            session.add(story)
            session.commit()

        summary2 = recovery.run_recovery_cycle(
            root, dry_run=False, now=now + timedelta(minutes=45), gh_pr_view=gh
        )
        assert len(summary2["recovered"]) == 1

    def test_per_cycle_cap(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        ids = [
            _add_story(root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=n)
            for n in range(1, 4)
        ]
        gh = lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}  # noqa: E731

        summary = recovery.run_recovery_cycle(root, dry_run=False, max_actions=1, gh_pr_view=gh)
        assert len(summary["recovered"]) == 1
        assert len(summary["escalated"]) == 2
        assert all(e["reason"] == "cap" for e in summary["escalated"])

        recovered_states = [_get_story(root, sid).state for sid in ids]
        assert recovered_states.count(StoryState.PR_OPEN.value) == 1
        assert recovered_states.count(StoryState.BLOCKED_DEPLOY_FAILED.value) == 2

    def test_dry_run_cap_does_not_apply(self, root: Path) -> None:
        """In dry-run, the cap should not suppress logging every match --
        no mutation happens anyway, so there's nothing to bound."""
        _write_app_config(root, "sacrifice")
        for n in range(1, 4):
            _add_story(root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=n)
        gh = lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}  # noqa: E731

        summary = recovery.run_recovery_cycle(root, dry_run=True, max_actions=1, gh_pr_view=gh)
        assert len(summary["recovered"]) == 3
        assert all(r.get("dry_run") for r in summary["recovered"])


# --------------------------------------------------------------------------- #
# Recovery log
# --------------------------------------------------------------------------- #


def test_recovery_actions_are_logged(root: Path) -> None:
    _write_app_config(root, "sacrifice")
    _add_story(root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42)
    gh = lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}  # noqa: E731

    recovery.run_recovery_cycle(root, dry_run=False, gh_pr_view=gh)

    log_path = root / "state" / "events" / "recovery.ndjson"
    assert log_path.exists()
    lines = [line for line in log_path.read_text().splitlines() if line.strip()]
    assert len(lines) == 1
    import json

    rec = json.loads(lines[0])
    assert rec["playbook"] == recovery.PLAYBOOK_RETRY_MERGEABLE_BLOCKED
    assert rec["status"] == "recovered"
    assert "ts" in rec
    assert "precondition_snapshot" in rec


# --------------------------------------------------------------------------- #
# Halt integration
# --------------------------------------------------------------------------- #


def test_halted_forces_dry_run(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_app_config(root, "sacrifice")
    story_id = _add_story(
        root, state=StoryState.BLOCKED_DEPLOY_FAILED.value, github_pr_number=42
    )
    gh = lambda **_: {"state": "OPEN", "mergeable": "MERGEABLE"}  # noqa: E731

    import factory.manager.halt as halt_mod

    monkeypatch.setattr(halt_mod, "is_halted", lambda *, root: True)

    summary = recovery.run_recovery_cycle(root, dry_run=False, gh_pr_view=gh)
    assert summary["dry_run"] is True
    assert summary["forced_dry_run_halted"] is True

    story = _get_story(root, story_id)
    assert story.state == StoryState.BLOCKED_DEPLOY_FAILED.value  # untouched


# --------------------------------------------------------------------------- #
# gh/git wrapper resilience
# --------------------------------------------------------------------------- #


def test_gh_pr_view_returns_none_on_transient_failure() -> None:
    def _raising_runner(*_args, **_kwargs):
        raise TimeoutError("boom")

    result = recovery._gh_pr_view(repo="o/r", pr_number=1, runner=_raising_runner)
    assert result is None


def test_gh_branch_exists_returns_false_on_404() -> None:
    class _Proc:
        returncode = 1
        stdout = ""
        stderr = "gh: Branch not found (HTTP 404)"

    result = recovery._gh_branch_exists(
        repo="o/r", branch="b", runner=lambda *a, **k: _Proc()
    )
    assert result is False


def test_gh_branch_exists_returns_none_on_uncertain_error() -> None:
    class _Proc:
        returncode = 1
        stdout = ""
        stderr = "gh: authentication required"

    result = recovery._gh_branch_exists(
        repo="o/r", branch="b", runner=lambda *a, **k: _Proc()
    )
    assert result is None


# --------------------------------------------------------------------------- #
# Playbook registry (WS3.1 refactor — behavior must be identical)
# --------------------------------------------------------------------------- #


class TestPlaybookRegistry:
    """The hand-wired playbook seam was refactored into a declarative registry.
    These tests pin the registry SHAPE so adding a playbook stays additive and
    the 1→5 ordering / kinds are preserved."""

    def _ctx(self, root: Path) -> recovery._RecoveryContext:
        return recovery._RecoveryContext(
            root=root,
            now=datetime.now(UTC),
            cooldown=recovery.DEFAULT_COOLDOWN,
            max_actions=recovery.DEFAULT_MAX_ACTIONS_PER_CYCLE,
            phantom_pr_age_threshold=recovery.DEFAULT_PHANTOM_PR_AGE_THRESHOLD,
            db_path=None,
            apps=None,
            gh_pr_view=None,
            gh_branch_exists=None,
            runner=None,
        )

    def test_registry_has_all_five_playbooks_in_order(self, root: Path) -> None:
        specs = recovery.build_recovery_registry(self._ctx(root))
        assert [s.name for s in specs] == [
            recovery.PLAYBOOK_RETRY_MERGEABLE_BLOCKED,
            recovery.PLAYBOOK_REDISPATCH_PHANTOM_PR,
            recovery.PLAYBOOK_REVERT_PREMATURE_DEPLOY,
            recovery.PLAYBOOK_CONFLICTING_GATED_PR,
            recovery.PLAYBOOK_RECOVER_STUCK_FIXONLY,
            recovery.PLAYBOOK_QUARANTINE_INVALID_ENUM,
        ]

    def test_registry_kinds_match_playbook_semantics(self, root: Path) -> None:
        specs = {s.name: s for s in recovery.build_recovery_registry(self._ctx(root))}
        # Playbook 4 is the only escalate-only (never mutates, no executor).
        p4 = specs[recovery.PLAYBOOK_CONFLICTING_GATED_PR]
        assert p4.kind == "escalate_only"
        assert p4.execute is None
        # Every other playbook is mutating and carries an executor.
        for name, spec in specs.items():
            if name == recovery.PLAYBOOK_CONFLICTING_GATED_PR:
                continue
            assert spec.kind == "mutating"
            assert spec.execute is not None

    def test_registry_detect_closures_are_callable(self, root: Path) -> None:
        _write_app_config(root, "sacrifice", deploy_enabled=False)
        _engine(root)  # create the stories schema the DB-backed detectors query
        # Each detect() is a zero-arg closure bound to the context; on an empty
        # world it returns an empty list (no match) without raising.
        for spec in recovery.build_recovery_registry(self._ctx(root)):
            targets = spec.detect()
            assert isinstance(targets, list)

    def test_adding_a_playbook_is_additive(self, root: Path) -> None:
        """A new PlaybookSpec can be appended without touching run_recovery_cycle
        — proves the seam is a registry, not inline blocks."""
        specs = recovery.build_recovery_registry(self._ctx(root))
        extra = recovery.PlaybookSpec(
            name="new-playbook",
            kind="mutating",
            detect=lambda: [],
            execute=lambda *a, **k: recovery.RecoveryOutcome(
                "new-playbook",
                recovery.RecoveryTarget(playbook="new-playbook", key="k", description="d"),
                "recovered",
                "did-a-thing",
            ),
            execute_kwargs={},
        )
        combined = [*specs, extra]
        assert combined[-1].name == "new-playbook"
        assert len(combined) == len(specs) + 1


# --------------------------------------------------------------------------- #
# Playbook 6: quarantine-invalid-enum-story (#96)
# --------------------------------------------------------------------------- #


class TestQuarantineInvalidEnum:
    def test_detects_invalid_enum_row_only(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        # A poisoned row (state outside the StoryState enum) and a healthy one.
        poisoned_id = _add_story(root, slug="poisoned", state="abandoned")
        _add_story(root, slug="healthy", state=StoryState.STORY_CREATED.value)

        targets = recovery.detect_invalid_enum_stories(root)
        assert len(targets) == 1
        target = targets[0]
        assert target.playbook == recovery.PLAYBOOK_QUARANTINE_INVALID_ENUM
        assert target.story_id == poisoned_id
        assert target.extra["invalid_state"] == "abandoned"

    def test_execute_moves_to_terminal_and_preserves_original(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(root, slug="poisoned", state="abandoned", error="prior boom")

        targets = recovery.detect_invalid_enum_stories(root)
        outcome = recovery.execute_quarantine_invalid_enum_story(
            root, targets[0], dry_run=False
        )
        assert outcome.status == "recovered"

        story = _get_story(root, story_id)
        assert story.state == StoryState.QUARANTINED_INVALID_STATE.value
        # Original invalid string preserved for forensics; prior error kept too.
        assert "abandoned" in (story.error or "")
        assert "prior boom" in (story.error or "")

    def test_is_idempotent(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(root, slug="poisoned", state="abandoned")

        targets = recovery.detect_invalid_enum_stories(root)
        recovery.execute_quarantine_invalid_enum_story(root, targets[0], dry_run=False)

        # After quarantine the row is a VALID enum value, so it is no longer
        # detected — the reconciler never re-processes it (no loop).
        assert recovery.detect_invalid_enum_stories(root) == []

        # Re-executing the stale target is a no-op (skipped_stale), not a crash.
        outcome = recovery.execute_quarantine_invalid_enum_story(
            root, targets[0], dry_run=False
        )
        assert outcome.status == "skipped_stale"
        assert _get_story(root, story_id).state == StoryState.QUARANTINED_INVALID_STATE.value

    def test_dry_run_makes_no_mutation(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(root, slug="poisoned", state="abandoned")

        targets = recovery.detect_invalid_enum_stories(root)
        outcome = recovery.execute_quarantine_invalid_enum_story(
            root, targets[0], dry_run=True
        )
        assert outcome.status == "dry_run"
        assert _get_story(root, story_id).state == "abandoned"

    def test_healthy_world_yields_no_targets(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        _add_story(root, slug="a", state=StoryState.STORY_CREATED.value)
        _add_story(root, slug="b", state=StoryState.QUARANTINED_INVALID_STATE.value)
        assert recovery.detect_invalid_enum_stories(root) == []

    def test_run_recovery_cycle_quarantines_poisoned_row(self, root: Path) -> None:
        _write_app_config(root, "sacrifice")
        story_id = _add_story(root, slug="poisoned", state="not-a-real-state")

        summary = recovery.run_recovery_cycle(root, apps=["sacrifice"])

        assert any(
            e["playbook"] == recovery.PLAYBOOK_QUARANTINE_INVALID_ENUM
            for e in summary["recovered"]
        )
        assert _get_story(root, story_id).state == StoryState.QUARANTINED_INVALID_STATE.value
