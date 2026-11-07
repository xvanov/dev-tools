"""Tests for the FACTORY-SELF-TICK capstone (Tier 3).

Two safety mechanisms are exercised here:

  1. **Chain-side staging gate** — a story that modifies the factory's OWN code
     must be validated on a cloned factory (``staging.gate_self_edit``) before
     auto-merge lets it land on the live factory. App-repo stories (sacrifice)
     bypass the gate entirely. A forbidden path (``factory/manager/**`` /
     ``bench/**``) is refused BEFORE staging. Every uncertain outcome resolves
     to "do not merge" (fail-safe).

  2. **Self-tick guard** — pm-sync refuses to turn ``apps/factory`` directions
     into chain stories unless ``self_tick_enabled`` is True (OFF by default).

All staging + gh calls are mocked; nothing touches the network or clones a repo.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory.app_config import AppConfig, load_app_config, targets_factory_repo
from factory.chain.auto_merge import (
    FixturePR,
    _evaluate_self_edit_gate,
    auto_merge_tick,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager.staging import StagingDecision

# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #

_FACTORY_CONFIG = """\
name: factory
repo: xvanov/software-factory
default_branch: main
app_repo_path: "."
self_tick_enabled: false
deploy:
  enabled: false
gates:
  lint_command: "uv run ruff check ."
  format_check_command: "uv run ruff format --check ."
  type_check_command: "uv run mypy factory"
  test_command: "uv run pytest -q"
"""

_SACRIFICE_CONFIG = (
    "name: sacrifice\nrepo: xvanov/sacrifice\n"
    "gates:\n"
    "  lint_command: 'ruff check .'\n"
    "  format_check_command: 'ruff format --check .'\n"
    "  type_check_command: 'mypy .'\n"
    "  coverage_command: 'pytest --cov-fail-under=70'\n"
)

# A well-formed unified diff that edits factory-owned python (a self-edit).
_SELF_EDIT_PATCH = """\
diff --git a/factory/foo.py b/factory/foo.py
--- a/factory/foo.py
+++ b/factory/foo.py
@@ -1 +1 @@
-x = 1
+x = 2
"""

# A self-edit touching the safety mechanism — forbidden regardless of staging.
_FORBIDDEN_MANAGER_PATCH = """\
diff --git a/factory/manager/apply.py b/factory/manager/apply.py
--- a/factory/manager/apply.py
+++ b/factory/manager/apply.py
@@ -1 +1 @@
-y = 1
+y = 2
"""

# A change touching the grader — forbidden.
_FORBIDDEN_BENCH_PATCH = """\
diff --git a/bench/grader.py b/bench/grader.py
--- a/bench/grader.py
+++ b/bench/grader.py
@@ -1 +1 @@
-score = 1
+score = 2
"""

# A factory-repo change that is NOT a runtime self-edit (docs/directions only).
_DOCS_ONLY_PATCH = """\
diff --git a/apps/factory/directions/003-x/direction.md b/apps/factory/directions/003-x/direction.md
--- a/apps/factory/directions/003-x/direction.md
+++ b/apps/factory/directions/003-x/direction.md
@@ -1 +1 @@
-old
+new
"""


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    fac = tmp_path / "apps" / "factory"
    fac.mkdir(parents=True)
    (fac / "config.yaml").write_text(_FACTORY_CONFIG, encoding="utf-8")
    sac = tmp_path / "apps" / "sacrifice"
    sac.mkdir(parents=True)
    (sac / "config.yaml").write_text(_SACRIFICE_CONFIG, encoding="utf-8")
    (tmp_path / "state").mkdir()
    return tmp_path


def _factory_cfg() -> AppConfig:
    return AppConfig(name="factory", repo="xvanov/software-factory")


def _app_cfg() -> AppConfig:
    return AppConfig(name="sacrifice", repo="xvanov/sacrifice")


class _Recorder:
    """Records every call so tests can assert on args + call count."""

    def __init__(self, *, decision: StagingDecision | None = None, raises: Exception | None = None):
        self.calls: list[dict] = []
        self._decision = decision
        self._raises = raises

    def gate(self, proposal, proposal_path, *, root):  # staging.gate_self_edit shape
        self.calls.append({"proposal": proposal, "proposal_path": proposal_path, "root": root})
        if self._raises is not None:
            raise self._raises
        assert self._decision is not None
        return self._decision

    def escalate(self, proposal, *, root, repo, classification, result=None):
        self.calls.append(
            {
                "proposal": proposal,
                "repo": repo,
                "classification": classification,
                "result": result,
            }
        )
        return {"notified": True}


def _good_story(*, app: str, state: str = StoryState.PR_OPEN.value, pr: int = 42) -> StoryRecord:
    return StoryRecord(
        direction_id="003",
        app=app,
        title="t",
        slug="s",
        scope="backend",
        state=state,
        test_plan_json=json.dumps(
            {
                "test_plan": [
                    {
                        "name": "test_x",
                        "what_it_asserts": "a real user-facing outcome holds",
                        "why_meaningful": "Real outcome — user flow",
                        "key_steps": ["arrange", "act", "assert"],
                    }
                ]
            }
        ),
        tech_writer_result_json=json.dumps(
            {"context_updates": [{"path": "context/project.md"}]}
        ),
        github_pr_number=pr,
    )


def _fixture(story: StoryRecord, *, pr: int = 42) -> FixturePR:
    return FixturePR(
        pr_number=pr,
        head_sha="deadbeef",
        base_branch="main",
        labels=[],
        files_changed=["factory/foo.py"],
        ci_state="success",
        story=story,
    )


# --------------------------------------------------------------------------- #
# Config loading + guard flag
# --------------------------------------------------------------------------- #


def test_apps_factory_config_loads(factory_root: Path) -> None:
    cfg = load_app_config("factory", factory_root)
    assert cfg.repo == "xvanov/software-factory"
    # OFF by default — self-tick must never be silently enabled.
    assert cfg.self_tick_enabled is False
    assert cfg.deploy.enabled is False
    assert cfg.gates.test_command == "uv run pytest -q"


def test_self_tick_enabled_defaults_false() -> None:
    assert AppConfig(name="factory", repo="xvanov/software-factory").self_tick_enabled is False


def test_targets_factory_repo_helper() -> None:
    assert targets_factory_repo("xvanov/software-factory")
    assert targets_factory_repo("XVANOV/Software-Factory")  # case-insensitive
    assert not targets_factory_repo("xvanov/sacrifice")
    assert not targets_factory_repo(None)


# --------------------------------------------------------------------------- #
# _evaluate_self_edit_gate — unit
# --------------------------------------------------------------------------- #


def test_app_repo_story_bypasses_gate(tmp_path: Path) -> None:
    """A non-factory app never touches staging or gh — unchanged path."""
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    called = {"patch": 0}

    def _patch(cfg, pr):
        called["patch"] += 1
        return _SELF_EDIT_PATCH

    d = _evaluate_self_edit_gate(
        app_config=_app_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=_patch,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is True
    assert d.status == "not_factory_repo"
    assert called["patch"] == 0  # diff never even fetched
    assert rec.calls == []  # staging + escalate untouched


def test_self_edit_healthy_allows(tmp_path: Path) -> None:
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is True
    assert d.status == "staging_validated"
    # staging was consulted, no escalation.
    assert len(rec.calls) == 1
    assert "proposal_path" in rec.calls[0]


def test_self_edit_unhealthy_blocks_and_escalates(tmp_path: Path) -> None:
    rec = _Recorder(
        decision=StagingDecision(
            promote=False, status="staging_rejected", stage_failed="pytest", logs_tail="boom"
        )
    )
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is False
    assert d.status == "staging_rejected"
    # gate + escalate both called.
    classifications = [c.get("classification") for c in rec.calls if "classification" in c]
    assert classifications == ["escalate_to_human"]


def test_self_edit_staging_infra_failure_does_not_merge(tmp_path: Path) -> None:
    """A staging harness exception is fail-safe: never merge."""
    rec = _Recorder(raises=RuntimeError("copy repo unreachable"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is False
    assert d.status == "staging_infra_failed"


def test_self_edit_infra_decision_not_promoted(tmp_path: Path) -> None:
    """gate_self_edit returning promote=False/infra-status is also fail-safe."""
    rec = _Recorder(decision=StagingDecision(promote=False, status="staging_infra_failed"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is False
    assert d.status == "staging_infra_failed"


@pytest.mark.parametrize("patch", [_FORBIDDEN_MANAGER_PATCH, _FORBIDDEN_BENCH_PATCH])
def test_forbidden_path_refused_before_staging(tmp_path: Path, patch: str) -> None:
    """factory/manager/** and bench/** are refused BEFORE staging runs."""
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: patch,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is False
    assert d.status == "forbidden"
    assert d.forbidden is True
    # staging.gate_self_edit must NOT have been called (no proposal_path calls).
    assert not any("proposal_path" in c for c in rec.calls)
    # escalated as forbidden.
    assert any(c.get("classification") == "forbidden" for c in rec.calls)


def test_diff_unavailable_is_fail_safe(tmp_path: Path) -> None:
    """No diff → cannot validate → refuse (never merge an unvalidated self-edit)."""
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: None,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is False
    assert d.status == "diff_unavailable"
    assert not any("proposal_path" in c for c in rec.calls)


def test_unparseable_diff_is_fail_safe(tmp_path: Path) -> None:
    """A non-empty diff that parses to NO target paths must be refused — we
    cannot rule out a self-edit/forbidden path, so we never merge it."""
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        # Non-empty, but no ``diff --git`` / ``+++`` headers → zero paths.
        patch_provider=lambda cfg, pr: "just some prose, not a real diff\nmore text\n",
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is False
    assert d.status == "unparseable_diff"
    # staging never consulted; escalated instead.
    assert not any("proposal_path" in c for c in rec.calls)
    assert any(c.get("classification") == "escalate_to_human" for c in rec.calls)


def test_factory_repo_non_self_edit_allows_without_staging(tmp_path: Path) -> None:
    """A factory-repo docs/directions change is not a runtime self-edit → merge
    without staging (staging validates 'does it run', which docs can't change)."""
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    d = _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=None,
        pr_number=42,
        root=tmp_path,
        patch_provider=lambda cfg, pr: _DOCS_ONLY_PATCH,
        self_edit_gate=rec.gate,
        escalate=rec.escalate,
    )
    assert d.allow is True
    assert d.status == "not_self_edit"
    assert rec.calls == []  # neither staging nor escalation


# --------------------------------------------------------------------------- #
# auto_merge_tick — integration (the hook + state sink + escalation wiring)
# --------------------------------------------------------------------------- #


def test_tick_factory_self_edit_healthy_merges(factory_root: Path) -> None:
    story = _good_story(app="factory")
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    actions = auto_merge_tick(
        factory_root,
        "factory",
        dry_run=True,
        fixture_prs=[_fixture(story)],
        self_edit_gate=rec.gate,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        escalate=rec.escalate,
    )
    assert actions[0].merged is True, actions[0].reason
    # staging was consulted before the merge.
    assert any("proposal_path" in c for c in rec.calls)


def test_tick_factory_self_edit_unhealthy_blocks_and_sinks(factory_root: Path) -> None:
    story = _good_story(app="factory")
    rec = _Recorder(
        decision=StagingDecision(promote=False, status="staging_rejected", logs_tail="pytest red")
    )
    actions = auto_merge_tick(
        factory_root,
        "factory",
        dry_run=True,
        fixture_prs=[_fixture(story)],
        self_edit_gate=rec.gate,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        escalate=rec.escalate,
    )
    assert actions[0].merged is False
    assert actions[0].staging_blocked is True
    assert actions[0].staging_status == "staging_rejected"
    # story sunk to a blocked/attention state; live factory untouched.
    assert story.state == StoryState.BLOCKED_DEPLOY_FAILED.value
    assert "self-edit" in (story.error or "")
    # escalation fired on the WS3.1 channel.
    assert any(c.get("classification") == "escalate_to_human" for c in rec.calls)


def test_tick_factory_self_edit_infra_failure_not_merged(factory_root: Path) -> None:
    story = _good_story(app="factory")
    rec = _Recorder(raises=RuntimeError("copy unreachable"))
    actions = auto_merge_tick(
        factory_root,
        "factory",
        dry_run=True,
        fixture_prs=[_fixture(story)],
        self_edit_gate=rec.gate,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        escalate=rec.escalate,
    )
    assert actions[0].merged is False
    assert actions[0].staging_status == "staging_infra_failed"


def test_tick_factory_self_edit_forbidden_refused(factory_root: Path) -> None:
    story = _good_story(app="factory")
    rec = _Recorder(decision=StagingDecision(promote=True, status="staging_validated"))
    actions = auto_merge_tick(
        factory_root,
        "factory",
        dry_run=True,
        fixture_prs=[_fixture(story)],
        self_edit_gate=rec.gate,
        patch_provider=lambda cfg, pr: _FORBIDDEN_MANAGER_PATCH,
        escalate=rec.escalate,
    )
    assert actions[0].merged is False
    assert actions[0].staging_status == "forbidden"
    # staging never ran; forbidden short-circuits.
    assert not any("proposal_path" in c for c in rec.calls)


def test_tick_app_repo_story_bypasses_self_edit_gate(factory_root: Path) -> None:
    """A sacrifice story merges normally; the self-edit gate is never consulted."""
    story = _good_story(app="sacrifice")
    rec = _Recorder(decision=StagingDecision(promote=False, status="staging_rejected"))
    called = {"patch": 0}

    def _patch(cfg, pr):
        called["patch"] += 1
        return _SELF_EDIT_PATCH

    actions = auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=True,
        fixture_prs=[_fixture(story)],
        self_edit_gate=rec.gate,
        patch_provider=_patch,
        escalate=rec.escalate,
    )
    # Even with a would-reject staging fake wired in, the app-repo story merges
    # because the gate short-circuits on repo mismatch.
    assert actions[0].merged is True, actions[0].reason
    assert actions[0].staging_blocked is False
    assert called["patch"] == 0
    assert rec.calls == []


# --------------------------------------------------------------------------- #
# pm-sync self-tick guard (OFF by default)
# --------------------------------------------------------------------------- #


def _write_direction(root: Path, num: str = "003") -> None:
    d = root / "apps" / "factory" / "directions" / f"{num}-improve"
    d.mkdir(parents=True)
    (d / "direction.md").write_text(
        "# Improve\n\n## Goal\nMake the factory better.\n\n"
        "## Acceptance Criteria\n- it is better\n",
        encoding="utf-8",
    )
    # ``source: operator`` keeps these fixtures on the human path: this file
    # tests the SELF-TICK guard, not the operator-approval gate for
    # machine-filed directions (``factory.directions.approval``), which would
    # otherwise park a direction whose source cannot be determined.
    (d / "state.yaml").write_text("status: created\nsource: operator\n", encoding="utf-8")


def test_pm_sync_skips_factory_when_self_tick_disabled(factory_root: Path) -> None:
    from factory.chain.pm_sync import pm_sync

    _write_direction(factory_root)
    summary = pm_sync("factory", factory_root, dry_run=True)
    # Guard returns an empty summary — no direction becomes a story.
    assert summary.processed == 0
    assert summary.validated == 0
    assert summary.needs_direction == 0


def test_pm_sync_processes_factory_when_self_tick_enabled(factory_root: Path) -> None:
    from factory.chain.pm_sync import pm_sync

    # Flip the guard on.
    cfg_path = factory_root / "apps" / "factory" / "config.yaml"
    cfg_path.write_text(
        _FACTORY_CONFIG.replace("self_tick_enabled: false", "self_tick_enabled: true"),
        encoding="utf-8",
    )
    _write_direction(factory_root)
    summary = pm_sync("factory", factory_root, dry_run=True)
    # With self-tick enabled the guard no longer short-circuits — the pending
    # direction is processed (the dry-run PM path runs).
    assert summary.processed == 1
