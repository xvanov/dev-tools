"""Step 3b — machinery hygiene. NO resolve yield is claimed for any of it.

Each fix names the sweep-2 row that cost something, and each is scoped so it
cannot change the live chain's behaviour where the live chain is already right.

1. **Slop detector base ref + scope.** Its candidate list was
   `("origin/main", "main", "HEAD~1")` — no `swebench-base`, which is the only
   correct base inside the benchmark. On `alibaba__opensandbox-816` it diffed from
   the wrong base, scored PRE-EXISTING UPSTREAM test files as slop, and clamped an
   explicit reviewer `approve` into a nonconvergence park: a $4, 17-minute rework
   cycle against the reviewer's judgement. The veto itself is documented
   fail-safe behaviour and is KEPT.

2. **`tests_green` with zero files changed.** It reads the return code and nothing
   else, so a dev that changed nothing reaches green whenever the suite already
   passed — `conan-io__conan-19750` declared green on an empty tree. Scoped to the
   bench driver by an explicit gate flag, because a docs-only, config-only or
   already-delivered story on the live chain legitimately changes no production
   file.

3. **Empty-diff short-circuit consults the retry budget.** It went terminal on the
   first empty diff with the budget untouched: `conan-19750` blocked with FOUR
   unused retries after Azure 429s truncated its analysis-only first turn.

4. **Containment: restore, don't just measure.** `test_readonly.bypassed_count >=
   1` on 33 of 38 chain rows. Grading strips test edits, so the graded PATCH was
   always clean — what was not clean is the CHAIN'S OWN GREEN. On
   `ucfopen__canvasapi-716` the dev rewrote an upstream negative test so its
   missing type check would pass, and the green was established against the
   weakened test.

5. **Pre-existing-failure baseline: NOT BUILT, on evidence.** Its only named
   beneficiary was `pandas-63945`, the sole row in the sweep with that shape (>=3
   red attempts, all red) — and the fresh control rules it a BROKEN instance, so
   `--only-working` excludes it. `selftest` + `--only-working` already IS the
   pre-existing-failure gate; the baseline only looked necessary because the
   control was nine days stale. Building a subtract-failures-and-call-it-green
   path with no beneficiary would add a way to declare a broken patch green.
"""

from __future__ import annotations

import importlib.util
import inspect
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppGatesConfig
from factory.chain import handlers as H

_ROOT = Path(__file__).resolve().parents[1]
_ADAPTER = _ROOT / "bench" / "swebench_adapter.py"


@pytest.fixture
def A() -> Any:  # noqa: N802
    spec = importlib.util.spec_from_file_location("_swe_hygiene", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _git(wt: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(wt), *args], capture_output=True, text=True, check=False
    ).stdout


# --------------------------------------------------------------------------- #
# 1 — slop detector: the right base, and only files the story authored
# --------------------------------------------------------------------------- #


def test_swebench_base_is_the_first_slop_base_candidate() -> None:
    assert H._SLOP_BASE_REF_CANDIDATES[0] == "swebench-base"
    # HEAD~1 is KEPT, as a last resort: on the live chain a one-commit branch with
    # no reachable main is exactly the case it covers.
    assert H._SLOP_BASE_REF_CANDIDATES[-1] == "HEAD~1"
    assert set(H._SLOP_BASE_REF_CANDIDATES) >= {"origin/main", "main"}


def test_the_slop_veto_is_not_removed() -> None:
    """The plan is explicit: fix the scope and the base ref, NOT the veto. A
    detector that cannot block is not a fail-safe."""
    src = inspect.getsource(H._slop_findings_for_story)
    assert "findings.append" in src
    assert "return findings" in src


def test_a_mode_only_change_is_not_authorship(tmp_path: Path) -> None:
    """The 0444 lock injects `100755 -> 100644` flips the dev cannot revert; they
    were 9 of 40 reviewer findings in sweep 2. `--diff-filter=ACMR` drops them."""
    wt = tmp_path / "repo"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    (wt / "tests").mkdir()
    (wt / "tests" / "test_a.py").write_text("def test_a():\n    assert 1\n", encoding="utf-8")
    (wt / "tests" / "test_b.py").write_text("def test_b():\n    assert 1\n", encoding="utf-8")
    (wt / "tests" / "test_a.py").chmod(0o755)
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    _git(wt, "branch", "swebench-base")
    # A mode flip on one file, a real edit on the other.
    (wt / "tests" / "test_a.py").chmod(0o644)
    (wt / "tests" / "test_b.py").write_text("def test_b():\n    assert 2\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "work")

    authored = H._story_authored_paths(wt, "swebench-base")
    assert authored is not None
    assert "tests/test_b.py" in authored
    assert "tests/test_a.py" not in authored, "a mode flip is not authorship"


def test_an_unreadable_diff_does_not_silently_disable_the_scan(tmp_path: Path) -> None:
    """None means "no scope information", and the caller must then leave the file
    list alone — narrowing on a failed read would turn the detector off."""
    assert H._story_authored_paths(tmp_path / "not-a-repo", "swebench-base") is None
    src = inspect.getsource(H._slop_findings_for_story)
    assert "if authored is not None:" in src


# --------------------------------------------------------------------------- #
# 2 — green with no production delta, bench only
# --------------------------------------------------------------------------- #


def test_the_production_delta_gate_is_off_by_default() -> None:
    """It CANNOT default on: a docs-only, config-only, or already-delivered story
    legitimately changes no production file, and the reviewer rubric has a whole
    section saying so."""
    assert AppGatesConfig().require_production_delta is False


def test_the_bench_driver_opts_in(A: Any) -> None:  # noqa: N803
    src = inspect.getsource(A._build_bench_root)
    assert '"require_production_delta": True' in src


def test_green_with_no_production_delta_is_red_only_under_the_flag() -> None:
    """``_handle_dev_once`` is the per-attempt body; ``handle_dev`` is the loop.

    The question is about the BRANCH, not the attempt — the per-attempt form was a
    regression that blocked two stories which had already landed green fixes, and
    is pinned by ``test_production_delta_is_branch_wide.py``.
    """
    src = inspect.getsource(H._handle_dev_once)
    assert 'getattr(app_config.gates, "require_production_delta", False)' in src
    assert "dev_green_with_no_production_delta" in src
    assert "_branch_has_production_delta(" in src
    assert "not (run_res.files_changed or [])" not in src, "the per-attempt form was the bug"
    # And only a CONFIRMED absence blocks: an undeterminable delta keeps the green.
    assert "if delta is False:" in src


# --------------------------------------------------------------------------- #
# 3 — empty diff consults the retry budget
# --------------------------------------------------------------------------- #


def test_an_empty_diff_with_headroom_is_a_red_attempt_not_a_block() -> None:
    src = inspect.getsource(H.handle_review)
    assert "empty_diff_dev_retry" in src
    assert "story.dev_retries + 1 < _max_dev_retries(" in src
    # It routes back to dev through the EXISTING "dev, do more work" event. A
    # fourth transition out of ``reviewer_in_progress`` was the first cut, and it
    # raised IllegalTransitionError — the legal events there are approve /
    # request_changes / nonconvergent.
    assert "EVENT_REVIEWER_REQUEST_CHANGES" in src
    # And the reviewer LLM is still never called on an empty diff: that was the
    # original, correct reason for the short-circuit, and this path builds its
    # verdict dict locally rather than calling a persona.
    i = src.index("empty_diff_dev_retry")
    assert '"verdict": "request_changes"' in src[max(0, i - 2000) : i + 2000]
    assert "reviewer_called" in src


def test_an_empty_diff_with_no_headroom_still_blocks_terminally() -> None:
    """The guard is preserved at the boundary: with the budget spent, an empty diff
    is still a terminal nonconvergence park."""
    src = inspect.getsource(H.handle_review)
    assert "EVENT_REVIEW_NONCONVERGENT" in src
    assert "empty_diff_short_circuit" in src


# --------------------------------------------------------------------------- #
# 4 — containment: restore a weakened graded test
# --------------------------------------------------------------------------- #


def test_a_weakened_graded_test_is_restored_and_relocked(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """The canvasapi shape: the dev rewrites an upstream negative test so its own
    bug passes. Grading strips the edit, but the CHAIN'S green was established
    against it. Restore before the next dispatch."""
    wt = tmp_path / "repo"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    (wt / "tests").mkdir()
    graded = wt / "tests" / "test_obj.py"
    graded.write_text('def test_type():\n    obj_or_str("user", 1)\n', encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")

    lock = A.lock_test_files(wt)
    assert "tests/test_obj.py" in lock["digests"]

    # chmod u+w then weaken it — the documented bypass.
    graded.chmod(0o644)
    graded.write_text('def test_type():\n    obj_or_str(123, 1)\n', encoding="utf-8")

    out = A.restore_locked_test_files(wt, lock["digests"])
    assert out["restored"] == ["tests/test_obj.py"]
    assert 'obj_or_str("user", 1)' in graded.read_text(encoding="utf-8")
    # Re-locked: git checkout replaces the file and resets the mode, which is the
    # same mechanism that makes the lock LAPSE.
    assert graded.stat().st_mode & 0o777 == A._TEST_FILE_RO_MODE


def test_an_untouched_tree_restores_nothing(A: Any, tmp_path: Path) -> None:  # noqa: N803
    wt = tmp_path / "repo"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    (wt / "tests").mkdir()
    (wt / "tests" / "test_x.py").write_text("def test_x():\n    assert 1\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    lock = A.lock_test_files(wt)
    out = A.restore_locked_test_files(wt, lock["digests"])
    assert out["restored"] == []
    assert out["errors"] == []


def test_a_committed_edit_is_reported_rather_than_falsely_restored(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """`git checkout --` restores from the INDEX/HEAD, so if the dev committed its
    edit the restore is a no-op. Saying "restored" there would be a false clean."""
    wt = tmp_path / "repo"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    (wt / "tests").mkdir()
    graded = wt / "tests" / "test_y.py"
    graded.write_text("def test_y():\n    assert 1\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    lock = A.lock_test_files(wt)
    graded.chmod(0o644)
    graded.write_text("def test_y():\n    assert 2\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "dev committed the weakened test")

    out = A.restore_locked_test_files(wt, lock["digests"])
    assert out["restored"] == []
    assert out["errors"] and "committed" in out["errors"][0]


def test_the_restore_runs_before_each_dispatch_and_is_reported(A: Any) -> None:  # noqa: N803
    src = inspect.getsource(A.run_factory)
    assert "restore_locked_test_files" in src
    assert "restored_test_files" in src, "the row must say containment was breached"
    # Restore BEFORE re-locking, using the FIRST digests: an edit from attempt N
    # must not survive into attempt N+1's green.
    assert src.index("restore_locked_test_files") < src.index("locked = lock_test_files")


# --------------------------------------------------------------------------- #
# 5 — the baseline that is NOT built, and why
# --------------------------------------------------------------------------- #


def test_the_control_is_already_the_pre_existing_failure_gate() -> None:
    """Item 5's only named beneficiary was `pandas-63945`, the sole sweep-2 row
    with >=3 all-red attempts — and the fresh control rules it BROKEN, so
    `--only-working` excludes it. The gate already exists."""
    # The ruling itself is pinned by the selftest PR, which owns that artifact
    # (`test_selftest_parallel_and_merge.py`). What matters HERE is the structural
    # claim: the sweep's instance list really is derived from the control, so an
    # instance with a pre-existing failure that blocks resolution is already
    # excluded without any new baseline machinery.
    src = (_ADAPTER).read_text(encoding="utf-8")
    assert "selftest_working_instances() if only_working else None" in src
