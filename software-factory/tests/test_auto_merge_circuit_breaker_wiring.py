"""Chain-side wiring for the circuit breaker's commit ledger.

``factory.manager.circuit_breaker.record_manager_commit`` had ZERO
production callers after PR #247 deleted ``factory/manager/apply.py`` — its
only caller. ``check_and_trip`` can never find a tracked SHA at HEAD without
an entry in the ledger, so the breaker was permanently inert even though
``factory manager circuit-breaker status/check/reset`` still existed. This
pins the chain-side replacement caller: once a factory self-edit PR has
ACTUALLY merged (not merely been decided upon in dry-run), auto_merge
records its merge-commit SHA.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory.app_config import AppConfig
from factory.chain.auto_merge import FixturePR, auto_merge_tick
from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager.staging import StagingDecision

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

_SELF_EDIT_PATCH = """\
diff --git a/factory/foo.py b/factory/foo.py
--- a/factory/foo.py
+++ b/factory/foo.py
@@ -1 +1 @@
-x = 1
+x = 2
"""


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    fac = tmp_path / "apps" / "factory"
    fac.mkdir(parents=True)
    (fac / "config.yaml").write_text(_FACTORY_CONFIG, encoding="utf-8")
    (tmp_path / "state").mkdir()
    return tmp_path


def _good_story(*, pr: int = 42) -> StoryRecord:
    return StoryRecord(
        direction_id="003",
        app="factory",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.PR_OPEN.value,
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
        tech_writer_result_json=json.dumps({"context_updates": [{"path": "context/project.md"}]}),
        github_pr_number=pr,
    )


def _fixture(story: StoryRecord, *, pr: int = 42, files: list[str] | None = None) -> FixturePR:
    return FixturePR(
        pr_number=pr,
        head_sha="deadbeef",
        base_branch="main",
        labels=[],
        files_changed=files if files is not None else ["factory/foo.py"],
        ci_state="success",
        story=story,
    )


def _healthy_gate(proposal: dict, proposal_path: str, *, root: Path) -> StagingDecision:
    return StagingDecision(promote=True, status="staging_validated")


def _noop_escalate(proposal: dict, *, root: Path, repo: str, classification: str, result=None):
    return {"notified": True}


def test_real_merge_of_self_edit_records_commit_for_circuit_breaker(
    factory_root: Path,
) -> None:
    story = _good_story()
    sha_calls: list[int] = []

    def _sha_provider(*, app_config: AppConfig, pr_number: int) -> str:
        sha_calls.append(pr_number)
        return "deadbeefcafe0123"

    actions = auto_merge_tick(
        factory_root,
        "factory",
        dry_run=False,
        fixture_prs=[_fixture(story)],
        self_edit_gate=_healthy_gate,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        escalate=_noop_escalate,
        merge_fn=lambda **kwargs: None,  # gh merge succeeds
        pr_merged_query=lambda **kwargs: False,  # not already merged
        wait_for_ci=False,  # synchronous merge: success == merged
        merge_commit_sha_provider=_sha_provider,
    )

    assert actions[0].merged is True, actions[0].reason
    assert sha_calls == [42]

    ledger = factory_root / "state" / ".manager_commits.ndjson"
    assert ledger.exists(), "record_manager_commit never wrote the ledger"
    records = [json.loads(line) for line in ledger.read_text().splitlines() if line.strip()]
    assert any(r["sha"] == "deadbeefcafe0123" for r in records)


def test_app_repo_merge_never_records_a_commit(factory_root: Path) -> None:
    """A non-factory-repo merge (sacrifice, ...) must never touch the
    circuit breaker's ledger — it isn't a self-edit."""
    sac = factory_root / "apps" / "sacrifice"
    sac.mkdir(parents=True)
    (sac / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\n"
        "gates:\n"
        "  lint_command: 'ruff check .'\n"
        "  format_check_command: 'ruff format --check .'\n"
        "  type_check_command: 'mypy .'\n"
        "  coverage_command: 'pytest --cov-fail-under=70'\n",
        encoding="utf-8",
    )
    story = StoryRecord(
        direction_id="003",
        app="sacrifice",
        title="t",
        slug="s",
        scope="docs",
        state=StoryState.PR_OPEN.value,
        chain_kind="docs",
        github_pr_number=42,
    )
    sha_calls: list[int] = []

    def _sha_provider(*, app_config: AppConfig, pr_number: int) -> str:
        sha_calls.append(pr_number)
        return "shouldnothappen"

    auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        fixture_prs=[_fixture(story, files=["apps/sacrifice/foo.py"])],
        merge_fn=lambda **kwargs: None,
        pr_merged_query=lambda **kwargs: False,
        wait_for_ci=False,
        merge_commit_sha_provider=_sha_provider,
    )

    assert sha_calls == []
    ledger = factory_root / "state" / ".manager_commits.ndjson"
    assert not ledger.exists()


def test_non_self_edit_factory_repo_merge_does_not_record(factory_root: Path) -> None:
    """A factory-repo PR that touches only docs/directions (not
    ``factory/``) is not a self-edit — the breaker only tracks runtime
    self-edits, matching ``staging.is_self_edit``."""
    story = _good_story()
    sha_calls: list[int] = []

    def _sha_provider(*, app_config: AppConfig, pr_number: int) -> str:
        sha_calls.append(pr_number)
        return "shouldnothappen"

    auto_merge_tick(
        factory_root,
        "factory",
        dry_run=False,
        fixture_prs=[_fixture(story, files=["apps/factory/directions/003-x/direction.md"])],
        self_edit_gate=_healthy_gate,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        escalate=_noop_escalate,
        merge_fn=lambda **kwargs: None,
        pr_merged_query=lambda **kwargs: False,
        wait_for_ci=False,
        merge_commit_sha_provider=_sha_provider,
    )

    assert sha_calls == []


def test_sha_provider_failure_never_blocks_the_merge(factory_root: Path) -> None:
    """Recording is advisory: if the sha lookup blows up, the merge still
    succeeds — the breaker just can't track that one commit."""
    story = _good_story()

    def _boom(*, app_config: AppConfig, pr_number: int) -> str:
        raise RuntimeError("gh unavailable")

    actions = auto_merge_tick(
        factory_root,
        "factory",
        dry_run=False,
        fixture_prs=[_fixture(story)],
        self_edit_gate=_healthy_gate,
        patch_provider=lambda cfg, pr: _SELF_EDIT_PATCH,
        escalate=_noop_escalate,
        merge_fn=lambda **kwargs: None,
        pr_merged_query=lambda **kwargs: False,
        wait_for_ci=False,
        merge_commit_sha_provider=_boom,
    )

    assert actions[0].merged is True, actions[0].reason
    ledger = factory_root / "state" / ".manager_commits.ndjson"
    assert not ledger.exists()
