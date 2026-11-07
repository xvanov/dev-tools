"""The production-delta gate must ask the BRANCH, not the attempt.

`gates.require_production_delta` (bench only) exists because `tests_green` reads
the test command's return code and nothing else, so a dev that changed nothing
reaches green whenever the suite already passed — `conan-io__conan-19750` declared
green on an empty tree in sweep 2.

**The first cut asked the wrong question and had to be killed mid-sweep.** It
tested `not run_res.files_changed` — "did THIS attempt touch a file". That is
per-attempt, and a dev that lands its fix on attempt 1 then re-runs reports an
empty list on attempt 2 while the tree still carries the fix. Measured on the
2026-08-11 replay:

* `pyinfra-1665` — attempt 0 touched 2 files and went green; attempts 1 and 2 were
  ALSO green ("32 passed") with `files_changed: []`, were forced red, produced an
  identical signature, and the story blocked on `same_failure_signature 2x`.
  **It had RESOLVED in sweep 2.**
* `opensandbox-816` — attempt 1 touched 15 files and went green ("108 passed");
  attempts 2 and 3 were green ("111 passed") with an empty list and blocked the
  same way.

1 resolve in 5 rows before the run was killed. So: ask the branch, and **fail
open** — the gate catches a rare false green, and its failure mode must never be a
systematic false red.
"""

from __future__ import annotations

import inspect
import subprocess
from pathlib import Path

from factory.app_config import AppConfig, AppGatesConfig
from factory.chain import handlers as H
from factory.chain.state_machine import StoryRecord, StoryState


def _git(wt: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(wt), *args], capture_output=True, text=True, check=False
    ).stdout


def _repo(tmp_path: Path) -> Path:
    wt = tmp_path / "app"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    (wt / "src").mkdir()
    (wt / "src" / "thing.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    (wt / "tests").mkdir()
    (wt / "tests" / "test_thing.py").write_text("def test_f():\n    assert 1\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    _git(wt, "branch", "swebench-base")
    return wt


def _story() -> StoryRecord:
    return StoryRecord(
        direction_id="099",
        app="swebench",
        title="t",
        slug="swe-abc",
        scope="backend",
        state=StoryState.DEV_IN_PROGRESS.value,
        story_file_path="stories/1-swe-abc.md",
    )


def _cfg(wt: Path) -> AppConfig:
    return AppConfig(
        name="swebench",
        repo="x/y",
        app_repo_path=str(wt),
        default_branch="swebench-base",
        gates=AppGatesConfig(require_production_delta=True),
    )


def _delta(monkeypatch, wt: Path) -> bool | None:
    monkeypatch.setattr(H, "_writing_worktree", lambda *_a, **_k: wt)
    return H._branch_has_production_delta(_story(), _cfg(wt), wt)


def test_a_branch_with_a_production_change_has_a_delta(monkeypatch, tmp_path: Path) -> None:
    wt = _repo(tmp_path)
    (wt / "src" / "thing.py").write_text("def f():\n    return 2\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "the fix")
    assert _delta(monkeypatch, wt) is True


def test_the_delta_survives_a_later_attempt_that_touches_nothing(
    monkeypatch, tmp_path: Path
) -> None:
    """THE REGRESSION. The fix landed on an earlier attempt; this attempt changed
    nothing. The branch still carries a production change, so the green stands.

    Under the first cut this returned "no delta" and forced a red, which is what
    blocked `pyinfra-1665` (a sweep-2 RESOLVE) and `opensandbox-816`.
    """
    wt = _repo(tmp_path)
    (wt / "src" / "thing.py").write_text("def f():\n    return 2\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "the fix, on an earlier attempt")
    # This attempt: nothing new in the tree at all.
    assert _delta(monkeypatch, wt) is True


def test_a_test_only_branch_has_no_production_delta(monkeypatch, tmp_path: Path) -> None:
    """What the gate is actually for: the graded diff strips tests, so a branch
    that only edits tests ships nothing."""
    wt = _repo(tmp_path)
    (wt / "tests" / "test_thing.py").write_text("def test_f():\n    assert 2\n", encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "tests only")
    assert _delta(monkeypatch, wt) is False


def test_an_untouched_branch_has_no_production_delta(monkeypatch, tmp_path: Path) -> None:
    """`conan-io__conan-19750`'s shape: green on an empty tree."""
    wt = _repo(tmp_path)
    assert _delta(monkeypatch, wt) is False


def test_an_undeterminable_delta_is_None_and_never_blocks(monkeypatch, tmp_path: Path) -> None:
    """Fail OPEN. A gate for a rare false green must not become a systematic false
    red when git cannot answer."""
    missing = tmp_path / "not-a-repo"
    missing.mkdir()
    assert _delta(monkeypatch, missing) is None
    # And the caller acts on False ONLY.
    src = inspect.getsource(H._handle_dev_once)
    assert "if delta is False:" in src
    assert "delta is None" not in src.split("if delta is False:")[0][-400:]


def test_the_caller_asks_the_branch_not_the_attempt() -> None:
    """Pin the question. `not run_res.files_changed` was the bug."""
    src = inspect.getsource(H._handle_dev_once)
    i = src.index("require_production_delta")
    window = src[i : i + 900]
    assert "_branch_has_production_delta(" in window
    assert "not (run_res.files_changed or [])" not in window, "that was the regression"
    # The per-attempt list is still RECORDED on the event, because it is useful
    # diagnostics — it just must not be the decision.
    assert "attempt_files_changed" in window


def test_the_gate_is_still_off_by_default_and_bench_only() -> None:
    assert AppGatesConfig().require_production_delta is False


def test_the_base_ref_resolution_is_shared_with_the_slop_detector() -> None:
    """One answer to "what is this branch's base", or the two gates disagree."""
    assert H._SLOP_BASE_REF_CANDIDATES[0] == "swebench-base"
    src = inspect.getsource(H._branch_has_production_delta)
    assert "_resolve_base_ref(" in src
    assert "_SLOP_BASE_REF_CANDIDATES" in inspect.getsource(H._resolve_base_ref)
