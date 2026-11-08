"""factory/live_tree_guard.py: an agent's writes into the live checkout."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory import live_tree_guard as g
from factory import runner


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def live_and_wt(tmp_path: Path) -> tuple[Path, Path]:
    live = tmp_path / "live"
    live.mkdir()
    _git(live, "init", "-q", "-b", "main")
    _git(live, "config", "user.email", "t@example.invalid")
    _git(live, "config", "user.name", "t")
    (live / "tracked.txt").write_text("a\n", encoding="utf-8")
    (live / ".gitignore").write_text("state/\n", encoding="utf-8")
    (live / "old-untracked.txt").write_text("x\n", encoding="utf-8")
    _git(live, "add", "tracked.txt", ".gitignore")
    _git(live, "commit", "-q", "-m", "init")
    wt = tmp_path / "wt"
    _git(live, "worktree", "add", "-q", "-b", "story", str(wt))
    return live, wt


def test_live_checkout_of_a_linked_worktree(live_and_wt: tuple[Path, Path]) -> None:
    live, wt = live_and_wt
    assert g.live_checkout(wt) == live.resolve() or g.live_checkout(wt) == live
    assert g.live_checkout(live) is None  # the main checkout itself
    assert g.live_checkout(live.parent) is None  # not a repo


def test_new_files_move_into_the_worktree(live_and_wt: tuple[Path, Path]) -> None:
    live, wt = live_and_wt
    guard = g.LiveTreeGuard(wt)
    ctx = live / "apps" / "x" / "context"
    ctx.mkdir(parents=True)
    (ctx / "project.md").write_text("p\n", encoding="utf-8")
    (live / "state").mkdir()
    (live / "state" / "runtime.json").write_text("{}", encoding="utf-8")  # ignored: unseen
    (live / "tracked.txt").write_text("b\n", encoding="utf-8")
    report = guard.check()
    assert report is not None
    assert report.moved == ["apps/x/context/project.md"]
    assert report.modified == ["tracked.txt"]  # reported, never reverted
    assert (wt / "apps" / "x" / "context" / "project.md").read_text(encoding="utf-8") == "p\n"
    assert not (live / "apps").exists()  # emptied dirs pruned
    assert (live / "tracked.txt").read_text(encoding="utf-8") == "b\n"
    assert (live / "old-untracked.txt").exists()  # there before the run: untouched
    assert "live checkout" in report.note()


def test_clean_run_reports_nothing(live_and_wt: tuple[Path, Path]) -> None:
    live, wt = live_and_wt
    guard = g.LiveTreeGuard(wt)
    (wt / "inside.md").write_text("ok\n", encoding="utf-8")
    assert guard.check() is None


def test_existing_worktree_file_is_left(live_and_wt: tuple[Path, Path]) -> None:
    live, wt = live_and_wt
    guard = g.LiveTreeGuard(wt)
    (live / "dup.md").write_text("live\n", encoding="utf-8")
    (wt / "dup.md").write_text("wt\n", encoding="utf-8")
    report = guard.check()
    assert report is not None and report.left == ["dup.md"] and not report.moved
    assert (wt / "dup.md").read_text(encoding="utf-8") == "wt\n"


def test_sandbox_run_wrapper_moves_and_notes(
    live_and_wt: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    live, wt = live_and_wt

    async def fake_impl(persona: str, story_path: Path, repo_path: Path, llm_config: Any,
                        difficulty: str = "standard", **kw: Any) -> runner.RunResult:  # fmt: skip
        (live / "escaped.md").write_text("e\n", encoding="utf-8")
        return runner.RunResult(success=True, summary="done")

    import inspect

    fake_impl.__signature__ = inspect.signature(runner._sandbox_run_impl)  # type: ignore[attr-defined]
    monkeypatch.setattr(runner, "_sandbox_run_impl", fake_impl)
    res = asyncio.run(
        runner.sandbox_run(
            persona="onboarder", story_path=wt / "s.md", repo_path=wt, llm_config=None
        )
    )
    assert (wt / "escaped.md").exists() and not (live / "escaped.md").exists()
    assert "wrote into the live checkout" in res.summary


def test_prompt_pins_the_working_directory(tmp_path: Path) -> None:
    rule = runner._workdir_rule(tmp_path)
    assert str(tmp_path) in rule and "Never write anywhere else" in rule
