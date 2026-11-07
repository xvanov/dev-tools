"""Tests for the auto-merge gate evaluators.

Each gate gets pass + fail cases driven from fixture PRContext / story
records. Where a gate runs subprocesses, we drive it in ``dry_run=True``
mode so the test never shells out — except the ablation tests, which need a
real checkout + suite to substantiate the opt-in claim.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig, AppGatesConfig
from factory.chain.gates import (
    canonical_paths_only,
    docs_current,
    production_tree_changed,
    smoke_green,
    tests_green,
    tests_meaningful,
)
from factory.chain.gates.evaluator import (
    ALL_GATE_LABELS,
    LOOP4_REQUIRED_GATE_LABELS,
    GateResult,
    PRContext,
    evaluate_all_gates,
    gate_label_for,
    required_gate_labels,
)
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def app_cfg_with_commands() -> AppConfig:
    return AppConfig(
        name="x",
        repo="o/r",
        gates=AppGatesConfig(
            lint_command="ruff check .",
            format_check_command="ruff format --check .",
            type_check_command="mypy .",
            coverage_command="pytest --cov-fail-under=70",
        ),
    )


@pytest.fixture
def app_cfg_empty() -> AppConfig:
    return AppConfig(name="x", repo="o/r")


def _story(
    *,
    state: str = StoryState.TESTS_GREEN.value,
    test_plan: dict | None = None,
    tech_writer: dict | None = None,
    smoke_passed: bool | None = None,
) -> StoryRecord:
    return StoryRecord(
        direction_id="002",
        app="sacrifice",
        title="t",
        slug="s",
        scope="backend",
        state=state,
        test_plan_json=json.dumps(test_plan) if test_plan is not None else None,
        tech_writer_result_json=json.dumps(tech_writer) if tech_writer is not None else None,
        smoke_passed=smoke_passed,
    )


# --- gate_label_for ------------------------------------------------------ #


def test_gate_label_for_replaces_underscores() -> None:
    assert gate_label_for("canonical_paths_only") == "canonical-paths-only"


def test_all_gate_labels_complete() -> None:
    """The canonical set of labels matches the project spec (WS1.6 trimmed the
    six vestigial gates)."""
    assert ALL_GATE_LABELS == [
        "tests-green",
        "tests-meaningful",
        "production-tree-changed",
        "docs-current",
        "canonical-paths-only",
        "smoke-green",
        "acceptance-verified",
    ]
    # production-tree-changed is REQUIRED, not merely evaluated: auto_merge
    # filters non-required gate failures out of ``missing_labels``, so a
    # non-required blocking result would not block.
    assert "production-tree-changed" in LOOP4_REQUIRED_GATE_LABELS


def test_removed_gate_labels_are_gone() -> None:
    """The six vestigial gates (read unwritten flags / deleted-persona
    payloads) must no longer appear as canonical labels."""
    for removed in [
        "tests-red-first-confirmed",
        "flow-verified",
        "coverage-verified",
        "lint-clean",
        "format-clean",
        "types-clean",
    ]:
        assert removed not in ALL_GATE_LABELS
        assert removed not in required_gate_labels(AppConfig(name="x", repo="o/r"))


def test_removed_gate_modules_are_deleted() -> None:
    """Importing a removed gate module must fail (the files are gone)."""
    import importlib

    for mod in (
        "tests_red_first_confirmed",
        "flow_verified",
        "coverage_verified",
        "lint_clean",
        "format_clean",
        "types_clean",
    ):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(f"factory.chain.gates.{mod}")


# --- tests_green --------------------------------------------------------- #


def test_tests_green_dry_run_uses_ci_state(app_cfg_empty: AppConfig) -> None:
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", ci_state="success")
    r = tests_green.evaluate(pr, app_cfg_empty)
    assert r.passed
    pr_failed = PRContext(pr_number=1, head_sha="a", base_branch="main", ci_state="failure")
    r = tests_green.evaluate(pr_failed, app_cfg_empty)
    assert not r.passed


def test_tests_green_dry_run_falls_back_to_story_state(app_cfg_empty: AppConfig) -> None:
    story = _story(state=StoryState.TESTS_GREEN.value)
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = tests_green.evaluate(pr, app_cfg_empty)
    assert r.passed
    assert "dry-run" in r.reason
    assert r.details.get("authoritative") is False


def test_tests_green_fails_when_story_not_yet_green(app_cfg_empty: AppConfig) -> None:
    story = _story(state=StoryState.DEV_IN_PROGRESS.value)
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = tests_green.evaluate(pr, app_cfg_empty)
    assert not r.passed


def test_tests_green_real_run_reruns_test_command(tmp_path: Path) -> None:
    """WS1.4: in real-run the gate RE-RUNS the app's test_command and passes
    only on exit 0 — it must not trust recorded story state / ci_state."""
    green_cfg = AppConfig(name="x", repo="o/r", gates=AppGatesConfig(test_command="true"))
    # Story looks 'green' and CI says success — but the authoritative signal is
    # the re-run, which we force red below.
    story = _story(state=StoryState.PR_OPEN.value)
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=story,
        repo_root=tmp_path,
        ci_state="success",
        dry_run=False,
    )
    r = tests_green.evaluate(pr, green_cfg)
    assert r.passed and r.details["authoritative"] is True

    red_cfg = AppConfig(name="x", repo="o/r", gates=AppGatesConfig(test_command="false"))
    r_red = tests_green.evaluate(pr, red_cfg)
    assert not r_red.passed, "recorded-green story must still fail when the re-run is red"
    assert r_red.details["authoritative"] is True


def test_tests_green_real_run_no_command_falls_back_to_ci(tmp_path: Path) -> None:
    cfg = AppConfig(name="x", repo="o/r")  # no test_command
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(),
        repo_root=tmp_path,
        ci_state="failure",
        dry_run=False,
    )
    r = tests_green.evaluate(pr, cfg)
    assert not r.passed and "ci_state=failure" in r.reason


# --- tests_meaningful ---------------------------------------------------- #


def test_tests_meaningful_passes_on_clean_diff(tmp_path: Path, app_cfg_empty: AppConfig) -> None:
    f = tmp_path / "tests" / "test_real.py"
    f.parent.mkdir(parents=True)
    f.write_text(
        "def test_a():\n    result = compute()\n    assert result == 5\n", encoding="utf-8"
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["tests/test_real.py"],
        repo_root=tmp_path,
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert r.passed, r.reason


def test_tests_meaningful_fails_on_slop_diff(tmp_path: Path, app_cfg_empty: AppConfig) -> None:
    f = tmp_path / "tests" / "test_slop.py"
    f.parent.mkdir(parents=True)
    f.write_text("def test_a():\n    assert True\n", encoding="utf-8")
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["tests/test_slop.py"],
        repo_root=tmp_path,
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert not r.passed
    assert r.details["findings"]


def test_tests_meaningful_fails_on_direct_db_bootstrap_diff(
    tmp_path: Path, app_cfg_empty: AppConfig
) -> None:
    f = tmp_path / "tests" / "test_bootstrap.py"
    f.parent.mkdir(parents=True)
    f.write_text(
        "from sqlmodel import create_engine\n"
        "def test_bootstrap():\n"
        "    create_engine('sqlite:///tmp.db')\n",
        encoding="utf-8",
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["tests/test_bootstrap.py"],
        repo_root=tmp_path,
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert not r.passed
    assert r.label == "tests-meaningful"
    findings = r.details["findings"]
    kinds = {finding["kind"] for finding in findings}
    assert "direct_db_bootstrap" in kinds
    # AC6.1 / AC6.2: operator-visible output is tied to the finding.
    db_findings = [fnd for fnd in findings if fnd["kind"] == "direct_db_bootstrap"]
    assert len(db_findings) >= 1, f"Expected >=1 direct_db_bootstrap, got {db_findings}"
    fnd = db_findings[0]
    assert fnd["path"].endswith("tests/test_bootstrap.py"), f"path={fnd['path']}"
    assert fnd["line"] == 3
    assert "create_engine" in fnd["code_excerpt"]
    assert "factory.observability.schema.migrate" in fnd["why_slop"], (
        f"why_slop must teach the fix: {fnd['why_slop']}"
    )
    # AC6.2: no new gate label.
    assert r.label == "tests-meaningful"


def test_tests_meaningful_fails_on_SQLModel_metadata_create_all(
    tmp_path: Path, app_cfg_empty: AppConfig
) -> None:
    """AC1.1 at gate level: SQLModel.metadata.create_all also trips the gate."""
    f = tmp_path / "tests" / "test_create_all.py"
    f.parent.mkdir(parents=True)
    f.write_text(
        "from sqlmodel import SQLModel\n"
        "def test_creates():\n"
        "    SQLModel.metadata.create_all(engine)\n",
        encoding="utf-8",
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["tests/test_create_all.py"],
        repo_root=tmp_path,
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert not r.passed
    db_findings = [f for f in r.details["findings"] if f["kind"] == "direct_db_bootstrap"]
    assert len(db_findings) >= 1
    assert "SQLModel.metadata.create_all" in db_findings[0]["code_excerpt"]


def test_tests_meaningful_passes_on_app_initializer_diff(
    tmp_path: Path, app_cfg_empty: AppConfig
) -> None:
    """AC3.1 at gate level: a test driving migrate() produces no finding."""
    f = tmp_path / "tests" / "test_good.py"
    f.parent.mkdir(parents=True)
    f.write_text(
        "from factory.observability.schema import migrate\n"
        "def test_good(tmp_path):\n"
        "    db = tmp_path / 'db'\n"
        "    migrate(db)\n",
        encoding="utf-8",
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["tests/test_good.py"],
        repo_root=tmp_path,
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert r.passed, r.reason
    assert all(fnd["kind"] != "direct_db_bootstrap" for fnd in r.details.get("findings", []))


def test_tests_meaningful_reports_that_mutation_is_not_a_gate(
    app_cfg_empty: AppConfig,
) -> None:
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", files_changed=[])
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert r.passed
    assert r.details["mutation_status"] == "not_a_merge_gate"


def test_tests_meaningful_does_not_pass_vacuously_when_files_unavailable(
    app_cfg_empty: AppConfig,
) -> None:
    """2026-08-07: the tick path synthesized ``files_changed=[]`` for every
    real PR (no ``github_client``), so this REQUIRED gate always scanned
    nothing and reported "no findings" — green without ever running. A real,
    real-run PR (``pr_number > 0``, ``dry_run=False``) with an unresolved file
    list must BLOCK, not pass."""
    pr = PRContext(
        pr_number=42, head_sha="a" * 40, base_branch="main", files_changed=[], dry_run=False
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert not r.passed
    assert "cannot determine" in r.reason
    assert r.details["files_changed_unavailable"] is True


def test_tests_meaningful_dry_run_empty_files_still_passes_vacuously(
    app_cfg_empty: AppConfig,
) -> None:
    """The genuine dry-run / no-checkout preview keeps its old shape — an
    empty file list there means "nothing to preview", not "couldn't resolve
    the diff", so it must not start blocking previews that never touched gh."""
    pr = PRContext(
        pr_number=42, head_sha="a" * 40, base_branch="main", files_changed=[], dry_run=True
    )
    r = tests_meaningful.evaluate(pr, app_cfg_empty)
    assert r.passed


# --- the hazard this gate used to carry ----------------------------------- #
#
# ``tests-meaningful`` is in LOOP4_REQUIRED_GATE_LABELS, and it used to run
# real ablation behind ``gates.mutation_testing``. That flag — false in all
# three app configs, never once flipped — was the only thing between four
# defects (wrong symbols, fail-open on infra failure, mutation of the live
# story worktree, and passed=False in dry-run) and every merge in the factory.
# The measurement moved to ``factory/chain/mutation.py`` and is reachable only
# from ``factory mutation-score``. These two tests are the closure: the flag can
# no longer reach a merge verdict, in dry-run or in real-run.


@pytest.mark.parametrize("dry_run", [True, False])
def test_mutation_testing_flag_cannot_change_the_verdict(tmp_path: Path, dry_run: bool) -> None:
    (tmp_path / "mod.py").write_text(
        "def add(a, b):\n    return a + b\n\n\ndef unused():\n    return 42\n",
        encoding="utf-8",
    )
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_mod.py").write_text(
        "from mod import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n", encoding="utf-8"
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["mod.py", "tests/test_mod.py"],
        repo_root=tmp_path,
        dry_run=dry_run,
    )
    off = tests_meaningful.evaluate(
        pr,
        AppConfig(
            name="x",
            repo="o/r",
            gates=AppGatesConfig(mutation_testing=False, test_command="python -m pytest -q"),
        ),
    )
    on = tests_meaningful.evaluate(
        pr,
        AppConfig(
            name="x",
            repo="o/r",
            gates=AppGatesConfig(mutation_testing=True, test_command="python -m pytest -q"),
        ),
    )
    assert on.as_dict() == off.as_dict()
    assert on.passed


def test_tests_meaningful_never_shells_out(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A required merge gate must not be able to run a test suite, mutate a
    checkout, or block for 600 s waiting on one."""

    def _boom(*_a: object, **_k: object) -> None:
        raise AssertionError("tests-meaningful shelled out")

    monkeypatch.setattr("subprocess.run", _boom)
    monkeypatch.setattr("subprocess.Popen", _boom)
    (tmp_path / "mod.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["mod.py"],
        repo_root=tmp_path,
        dry_run=False,
    )
    cfg = AppConfig(
        name="x",
        repo="o/r",
        gates=AppGatesConfig(mutation_testing=True, test_command="python -m pytest -q"),
    )
    assert tests_meaningful.evaluate(pr, cfg).passed


# --- docs_current -------------------------------------------------------- #


def test_docs_current_passes_with_updates(app_cfg_empty: AppConfig) -> None:
    story = _story(tech_writer={"context_updates": [{"path": "context/project.md"}]})
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert r.passed


def test_docs_current_passes_with_no_updates_but_rationale(app_cfg_empty: AppConfig) -> None:
    story = _story(tech_writer={"context_updates": [], "rationale": "No updates needed."})
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert r.passed


def test_docs_current_fails_with_no_updates_and_no_rationale(app_cfg_empty: AppConfig) -> None:
    story = _story(tech_writer={"context_updates": []})
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert not r.passed


def test_docs_current_fails_without_tech_writer_result(app_cfg_empty: AppConfig) -> None:
    story = _story(state=StoryState.TECH_WRITER_DONE.value)
    story.tech_writer_result_json = None
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert not r.passed


# --- S3 (019 fail-silent audit): no_updates_needed boolean is authoritative -- #


def test_docs_current_passes_with_no_updates_needed_true_and_no_rationale(
    app_cfg_empty: AppConfig,
) -> None:
    """The explicit boolean is sufficient on its own — no rationale needed."""
    story = _story(tech_writer={"context_updates": [], "no_updates_needed": True})
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert r.passed


def test_docs_current_passes_with_no_updates_needed_true_and_off_script_rationale(
    app_cfg_empty: AppConfig,
) -> None:
    """Prose phrasing outside the four legacy literals still passes when the
    boolean is set — this is the exact defect: "the change is internal;
    docs unaffected" matches none of ("no updates needed", "no context
    updates", "no-op", "nothing to update")."""
    story = _story(
        tech_writer={
            "context_updates": [],
            "no_updates_needed": True,
            "rationale": "the change is internal; docs unaffected",
        }
    )
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert r.passed


def test_docs_current_fails_when_no_updates_needed_false_despite_off_script_rationale(
    app_cfg_empty: AppConfig,
) -> None:
    """An explicit false is not overridden by prose alone — the boolean is
    authoritative in both directions, not just when true."""
    story = _story(
        tech_writer={
            "context_updates": [],
            "no_updates_needed": False,
            "rationale": "the change is internal; docs unaffected",
        }
    )
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert not r.passed


def test_docs_current_legacy_rationale_fallback_still_works_without_the_boolean(
    app_cfg_empty: AppConfig,
) -> None:
    """Backward compatibility: historical rows that predate the boolean
    field (it's simply absent) still pass via the literal-phrase fallback."""
    story = _story(tech_writer={"context_updates": [], "rationale": "No updates needed."})
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert r.passed


def test_docs_current_fails_on_parse_failure_placeholder_rationale(
    app_cfg_empty: AppConfig,
) -> None:
    """The historical JSON-parse-failure fallback string
    ("tech_writer JSON parse failed") matches none of the legacy literals and
    carries no boolean — this was the unsatisfiable-gate half of S3 before
    ``handle_tech_writer`` stopped persisting it at all. The gate itself must
    still fail closed on any row shaped like it (defense in depth)."""
    story = _story(
        tech_writer={"context_updates": [], "rationale": "tech_writer JSON parse failed"}
    )
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story)
    r = docs_current.evaluate(pr, app_cfg_empty)
    assert not r.passed


# --- canonical_paths_only ----------------------------------------------- #


def test_canonical_paths_only_passes_on_canonical_diff(app_cfg_empty: AppConfig) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["context/project.md", "context/modules/payments.md", "src/payments.py"],
    )
    r = canonical_paths_only.evaluate(pr, app_cfg_empty)
    assert r.passed


def test_canonical_paths_only_fails_on_forbidden_diff(app_cfg_empty: AppConfig) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=["context/decisions/0001-stack.md"],
    )
    r = canonical_paths_only.evaluate(pr, app_cfg_empty)
    assert not r.passed


def test_canonical_paths_only_does_not_pass_vacuously_when_files_unavailable(
    app_cfg_empty: AppConfig,
) -> None:
    """Same fail-open as ``tests-meaningful`` (2026-08-07): an unresolved file
    list on a real PR must block, never pass by scanning nothing."""
    pr = PRContext(
        pr_number=42, head_sha="a" * 40, base_branch="main", files_changed=[], dry_run=False
    )
    r = canonical_paths_only.evaluate(pr, app_cfg_empty)
    assert not r.passed
    assert "cannot determine" in r.reason


def test_canonical_paths_only_dry_run_empty_files_still_passes_vacuously(
    app_cfg_empty: AppConfig,
) -> None:
    pr = PRContext(
        pr_number=42, head_sha="a" * 40, base_branch="main", files_changed=[], dry_run=True
    )
    r = canonical_paths_only.evaluate(pr, app_cfg_empty)
    assert r.passed


# --- production_tree_changed --------------------------------------------- #
#
# The false-green this closes was MEASURED (2026-08-04, hidden-oracle grading):
# ``harumiweb__exstruct-113`` spent $2.45, edited only
# ``tests/cli/test_cli_lazy_imports.py``, was approved by the reviewer at
# test_quality_score=0.90 and reached ``reviewer_done`` with diff_bytes=0.


def _ptc_pr(paths: list[str], **kw: object) -> PRContext:
    return PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=list(paths),
        **kw,  # type: ignore[arg-type]
    )


def test_production_tree_changed_passes_on_code_and_tests(app_cfg_empty: AppConfig) -> None:
    r = production_tree_changed.evaluate(
        _ptc_pr(["src/payments.py", "tests/test_payments.py"]), app_cfg_empty
    )
    assert r.passed, r.reason
    assert r.details["production_paths"] == ["src/payments.py"]
    assert r.details["authoritative"] is True


def test_production_tree_changed_blocks_test_only_diff(app_cfg_empty: AppConfig) -> None:
    """A story with a test-only diff must NOT reach green."""
    r = production_tree_changed.evaluate(
        _ptc_pr(["tests/cli/test_cli_lazy_imports.py", "src/pkg/conftest.py"]),
        app_cfg_empty,
    )
    assert not r.passed
    assert "no production-code change" in r.reason
    assert "tests/cli/test_cli_lazy_imports.py" in r.details["test_paths"]


def test_production_tree_changed_blocks_pytest_config_only_diff(
    app_cfg_empty: AppConfig,
) -> None:
    """A story whose only non-test change is ``pyproject.toml`` must NOT reach
    green: ``addopts = "-p _fixup"`` plus a collection hook makes the whole
    suite exit 0 with "skipped" (measured against real pytest)."""
    for cfg_path in (
        "pyproject.toml",
        "pytest.ini",
        "tox.ini",
        "setup.cfg",
        "noxfile.py",
        "sitecustomize.py",
        "src/_vendor.pth",
        "my_pytest_plugin.py",
    ):
        r = production_tree_changed.evaluate(
            _ptc_pr(["tests/test_a.py", cfg_path]), app_cfg_empty
        )
        assert not r.passed, f"{cfg_path} was treated as production code"
        assert cfg_path in r.details["collection_config_paths"]


def test_production_tree_changed_blocks_empty_diff(app_cfg_empty: AppConfig) -> None:
    r = production_tree_changed.evaluate(
        _ptc_pr([], repo_root=None), app_cfg_empty
    )
    assert not r.passed
    assert "cannot determine" in r.reason


def test_production_tree_changed_counts_docs_as_production(app_cfg_empty: AppConfig) -> None:
    """The predicate asks "was anything but the oracle touched" — so a
    docs-only story still passes, keeping the false-block surface at zero."""
    r = production_tree_changed.evaluate(_ptc_pr(["README.md"]), app_cfg_empty)
    assert r.passed


def test_production_tree_changed_derives_from_git_when_no_file_list(
    tmp_path: Path, app_cfg_empty: AppConfig
) -> None:
    """The production merge path builds fixtures with ``files_changed=[]`` and a
    story worktree, so the git derivation is the branch that actually runs."""
    import subprocess

    def git(*args: str) -> None:
        subprocess.run(
            ["git", *args], cwd=str(tmp_path), check=True, capture_output=True
        )

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_a.py").write_text("def test_a():\n    assert 1\n")
    git("add", "-A")
    git("commit", "-qm", "base")
    git("checkout", "-qb", "feature")
    # Test-only commit on the branch → blocked.
    (tmp_path / "tests" / "test_a.py").write_text("def test_a():\n    assert 2\n")
    git("commit", "-qam", "tests only")
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=[],
        repo_root=tmp_path,
        dry_run=False,
    )
    r = production_tree_changed.evaluate(pr, app_cfg_empty)
    assert not r.passed, r.reason
    assert r.details["changed_paths"] == ["tests/test_a.py"]

    # ...and passes once real code lands.
    (tmp_path / "src.py").write_text("x = 1\n")
    git("add", "-A")
    git("commit", "-qm", "code")
    r2 = production_tree_changed.evaluate(pr, app_cfg_empty)
    assert r2.passed, r2.reason
    assert r2.details["production_paths"] == ["src.py"]


def test_production_tree_changed_fails_closed_without_a_derivable_diff(
    tmp_path: Path, app_cfg_empty: AppConfig
) -> None:
    """No file list and a repo_root git cannot read → BLOCK. A gate that cannot
    see the diff must never bless it."""
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        files_changed=[],
        repo_root=tmp_path / "not-a-repo",
        dry_run=False,
    )
    r = production_tree_changed.evaluate(pr, app_cfg_empty)
    assert not r.passed
    assert r.details["authoritative"] is False


def test_production_tree_changed_falls_back_to_gh_when_the_worktree_is_gone(
    monkeypatch: pytest.MonkeyPatch, app_cfg_empty: AppConfig
) -> None:
    """``_story_worktree`` swallows every failure into ``repo_root=None``. Without
    a GitHub fallback, a required fail-closed gate would turn any worktree fault
    into a permanently unmergeable PR."""
    calls: list[tuple[int, str]] = []

    def _fake_gh(pr_number: int, repo: str) -> tuple[list[str], str]:
        calls.append((pr_number, repo))
        return ["src/app.py"], "gh pr diff --name-only #7"

    monkeypatch.setattr(production_tree_changed, "_gh_changed_paths", _fake_gh)
    pr = PRContext(
        pr_number=7,
        head_sha="a",
        base_branch="main",
        files_changed=[],
        repo_root=None,
        dry_run=False,
    )
    r = production_tree_changed.evaluate(pr, app_cfg_empty)
    assert r.passed, r.reason
    assert calls == [(7, "o/r")]

    # Dry-run must NOT shell out to GitHub — and with nothing to read it blocks.
    calls.clear()
    dry = PRContext(
        pr_number=7, head_sha="a", base_branch="main", files_changed=[], dry_run=True
    )
    assert not production_tree_changed.evaluate(dry, app_cfg_empty).passed
    assert calls == []


def test_production_tree_changed_shares_the_bench_classifier() -> None:
    """The gate and the bench harness must not grow divergent definitions of
    "production code" — the harness strips/refuses on exactly this predicate."""
    import importlib.util

    adapter = Path(__file__).resolve().parents[1] / "bench" / "swebench_adapter.py"
    spec = importlib.util.spec_from_file_location("_swe_ptc", adapter)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    from factory import diff_paths

    assert mod._TEST_PATH is diff_paths._TEST_PATH
    assert mod._COLLECTION_CHANNEL is diff_paths._COLLECTION_CHANNEL
    for p in (
        "tests/test_a.py",
        "pyproject.toml",
        "src/app.py",
        "pkg/conftest.py",
        "docs/x.md",
    ):
        assert mod.is_test_path(p) is diff_paths.is_test_path(p)
        assert mod.is_collection_channel_path(p) is diff_paths.is_collection_channel_path(p)


# --- evaluate_all_gates ------------------------------------------------- #


def test_evaluate_all_gates_returns_every_label(
    tmp_path: Path, app_cfg_with_commands: AppConfig
) -> None:
    """The aggregator runs every gate and returns one result per label."""
    story = _story(
        test_plan={"test_plan": [{"name": "test_a", "key_steps": ["x"]}]},
        tech_writer={"context_updates": [{"path": "context/project.md"}]},
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=story,
        repo_root=tmp_path,
        ci_state="success",
        files_changed=["src/foo.py", "tests/test_foo.py"],
        dry_run=True,
    )
    # Provide a fixture test file for the slop scan.
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_foo.py").write_text(
        "def test_foo():\n    result = compute()\n    assert result == 5\n",
        encoding="utf-8",
    )
    results = evaluate_all_gates(pr, app_cfg_with_commands)
    assert set(results.keys()) == set(ALL_GATE_LABELS)
    # All gates pass for this happy-path fixture under dry-run.
    failed = [(k, v.reason) for k, v in results.items() if not v.passed]
    assert not failed, f"unexpected gate failures: {failed!r}"


def test_H8_acceptance_gate_is_last_in_the_evaluator_tuple(
    tmp_path: Path, app_cfg_with_commands: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``acceptance_verified`` must run LAST, and that must be a test.

    The acceptance gate briefly copies the hidden, spec-authored oracle test into
    the dev's checkout to run it, then sweeps it out. Any gate that reads the tree
    while that copy exists sees a file the dev never wrote: ``tests-meaningful``
    would scan it as one of the dev's tests, ``production-tree-changed`` reads the
    tree too. ``evaluate_all_gates`` carries a comment saying so and, until now,
    nothing enforced it — exactly the kind of silent guarantee a concurrent
    refactor breaks without any test going red.

    Asserted on OBSERVED call order, not on the source text, so a restructure
    that keeps the comment but changes the behaviour still fails.
    """
    from factory.chain.gates import (
        acceptance_verified,
        canonical_paths_only,
        docs_current,
        production_tree_changed,
        smoke_green,
        tests_green,
        tests_meaningful,
    )

    order: list[str] = []
    for mod in (
        tests_green,
        tests_meaningful,
        production_tree_changed,
        docs_current,
        canonical_paths_only,
        smoke_green,
        acceptance_verified,
    ):
        label = gate_label_for(mod.__name__.rsplit(".", 1)[-1])
        real = mod.evaluate

        def _spy(
            pr_ctx: PRContext,
            cfg: AppConfig,
            _label: str = label,
            _real: Any = real,
        ) -> GateResult:
            order.append(_label)
            return _real(pr_ctx, cfg)

        monkeypatch.setattr(mod, "evaluate", _spy)

    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(),
        repo_root=tmp_path,
        files_changed=["src/foo.py"],
        dry_run=True,
    )
    evaluate_all_gates(pr, app_cfg_with_commands)
    assert order[-1] == "acceptance-verified", f"call order was {order}"
    # And the two gates that read the tree must both precede it.
    assert order.index("tests-meaningful") < order.index("acceptance-verified")
    assert order.index("production-tree-changed") < order.index("acceptance-verified")


# --- smoke_green (D002 runtime verifier) --------------------------------- #


def _smoke_cfg(*, ready: bool, command: str | None) -> AppConfig:
    return AppConfig(
        name="x",
        repo="o/r",
        gates=AppGatesConfig(smoke_harness_ready=ready, smoke_command=command),
    )


def test_smoke_skips_when_no_harness(app_cfg_empty: AppConfig) -> None:
    """Apps without a declared harness pass (skip) — never a new merge block."""
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=_story())
    r = smoke_green.evaluate(pr, app_cfg_empty)
    assert r.passed and r.label == "smoke-green"
    assert "skipped" in r.reason


def test_smoke_skips_when_ready_but_no_command() -> None:
    """ready=True but no command is still a skip, not a hard fail."""
    cfg = _smoke_cfg(ready=True, command=None)
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=_story())
    r = smoke_green.evaluate(pr, cfg)
    assert r.passed and "skipped" in r.reason


def test_smoke_dry_run_fails_closed_even_with_the_recorded_flag_set() -> None:
    """The gate must NOT accept a recorded boolean in place of a real run.

    ``StoryRecord.smoke_passed`` had no writer anywhere in ``factory/**``, so
    the old "trust the dev handler's flag" branch was unreachable and the gate
    was fail-closed only by accident. This pins the fail-closed posture
    structurally: even a story that claims ``smoke_passed=True`` does not get
    the gate, because nothing booted the product.
    """
    cfg = _smoke_cfg(ready=True, command="docker compose up -d && ./smoke.sh")
    story = _story(smoke_passed=True)
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story, dry_run=True)
    r = smoke_green.evaluate(pr, cfg)
    assert not r.passed
    assert "was not run" in r.reason


def test_smoke_dry_run_fails_without_recorded_flag() -> None:
    cfg = _smoke_cfg(ready=True, command="docker compose up -d && ./smoke.sh")
    story = _story(smoke_passed=None)
    pr = PRContext(pr_number=1, head_sha="a", base_branch="main", story=story, dry_run=True)
    r = smoke_green.evaluate(pr, cfg)
    assert not r.passed and "was not run" in r.reason


def test_smoke_failure_details_survive_for_diagnosis() -> None:
    """A blocked merge has to be diagnosable: the failing result carries the
    exit code and the command output tail."""
    cfg = _smoke_cfg(ready=True, command="echo boom-from-smoke && exit 3")
    import pathlib as _pathlib

    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(),
        dry_run=False,
        repo_root=_pathlib.Path.cwd(),
    )
    r = smoke_green.evaluate(pr, cfg)
    assert not r.passed
    assert r.details["exit_code"] == 3
    assert "boom-from-smoke" in r.details["output_tail"]
    assert r.as_dict()["details"]["exit_code"] == 3


def test_smoke_real_run_reflects_command_exit(tmp_path: Path) -> None:
    cfg = _smoke_cfg(ready=True, command="true")
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(),
        repo_root=tmp_path,
        dry_run=False,
    )
    r = smoke_green.evaluate(pr, cfg)
    assert r.passed and r.details["exit_code"] == 0

    cfg_fail = _smoke_cfg(ready=True, command="false")
    pr_fail = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(),
        repo_root=tmp_path,
        dry_run=False,
    )
    r_fail = smoke_green.evaluate(pr_fail, cfg_fail)
    assert not r_fail.passed and r_fail.details["exit_code"] != 0


# --- required_gate_labels (per-app opt-in) ------------------------------- #


def test_required_gates_unchanged_without_harness(app_cfg_empty: AppConfig) -> None:
    """An app with no smoke harness keeps exactly the base Loop-4 set."""
    assert required_gate_labels(app_cfg_empty) == LOOP4_REQUIRED_GATE_LABELS
    assert "smoke-green" not in required_gate_labels(app_cfg_empty)


def test_required_gates_add_smoke_when_opted_in() -> None:
    cfg = _smoke_cfg(ready=True, command="docker compose up -d && ./smoke.sh")
    labels = required_gate_labels(cfg)
    assert "smoke-green" in labels
    # Base set is preserved, smoke is additive.
    for base in LOOP4_REQUIRED_GATE_LABELS:
        assert base in labels


def test_required_gates_no_smoke_when_ready_but_no_command() -> None:
    cfg = _smoke_cfg(ready=True, command=None)
    assert "smoke-green" not in required_gate_labels(cfg)
