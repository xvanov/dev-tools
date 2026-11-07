"""_writing_worktree must refresh an existing worktree against current
origin/<base> before a writing handler runs, so an in-flight story picks up a
fix that merged to main while it was mid-flight — WITHOUT clobbering the dev's
uncommitted work. Regression guard for the "dev churns forever on a stale base"
class (a sibling un-broke the suite on main, but the in-flight story never saw
it and kept failing).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from factory.app_config import AppConfig
from factory.chain.handlers import _abort_inflight_merge, _writing_worktree, persist_story
from factory.chain.state_machine import StoryRecord


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True)


def _seed_repo(path: Path) -> None:
    _git(path, "config", "user.email", "t@e.x")
    _git(path, "config", "user.name", "T E")


def test_writing_worktree_refreshes_base_and_preserves_wip(tmp_path: Path) -> None:
    # Source repo with one commit on main, then a bare origin it pushes to.
    src = tmp_path / "sacrifice"
    src.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main", str(src)], check=True)
    _seed_repo(src)
    (src / "README.md").write_text("# r\n", encoding="utf-8")
    _git(src, "add", ".")
    _git(src, "commit", "-q", "-m", "init")
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", str(origin)], check=True)
    _git(src, "remote", "add", "origin", str(origin))
    _git(src, "push", "-q", "-u", "origin", "main")

    # Factory metadata layout.
    factory_root = tmp_path / "sf"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "stories").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "stories" / "1-x.md").write_text("# s\n", "utf-8")
    story = persist_story(
        StoryRecord(
            id=None, direction_id="005", app="sacrifice", title="t", slug="x",
            scope="backend", state="dev_in_progress", github_issue_number=1,
            story_file_path="stories/1-x.md",
        ),
        factory_root / "state" / "factory.db",
    )
    cfg = AppConfig(name="sacrifice", repo="x/y", default_branch="main", app_repo_path=str(src))

    # First acquire: creates the worktree cut from the CURRENT origin/main.
    wt = _writing_worktree(cfg, factory_root, story)
    assert not (wt / "fix_from_main.txt").exists()
    # Dev leaves uncommitted WIP in the worktree (as the real dev path does).
    (wt / "dev_wip.txt").write_text("in progress\n", encoding="utf-8")

    # A sibling merges a fix to main: advance origin/main by committing on the
    # source repo's main (it shares .git with the worktree) and pushing.
    _git(src, "checkout", "-q", "main")
    (src / "fix_from_main.txt").write_text("the fix\n", encoding="utf-8")
    _git(src, "add", ".")
    _git(src, "commit", "-q", "-m", "fix on main")
    _git(src, "push", "-q", "origin", "main")

    # Re-acquire (reuse path): must merge the since-pushed main AND keep WIP.
    wt2 = _writing_worktree(cfg, factory_root, story)
    assert wt2 == wt
    assert (wt / "fix_from_main.txt").exists(), "base refresh did not merge since-pushed main"
    assert (wt / "dev_wip.txt").read_text(encoding="utf-8") == "in progress\n", (
        "uncommitted dev WIP must be preserved by the base refresh"
    )


def test_abort_inflight_merge_clears_leftover_merge_no_conflict_markers(tmp_path: Path) -> None:
    """A merge left in progress (e.g. the base-refresh merge timed out and the
    except skipped the abort) must be cleared, so a later `git add -A` + commit
    cannot bake unresolved conflict markers into a real commit and push them.
    """
    repo = tmp_path / "r"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main", str(repo)], check=True)
    _seed_repo(repo)
    f = repo / "c.txt"
    f.write_text("base\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base")
    # Two branches that conflict on the same line.
    _git(repo, "checkout", "-q", "-b", "feature")
    f.write_text("feature\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "feature")
    _git(repo, "checkout", "-q", "main")
    f.write_text("mainline\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "mainline")
    _git(repo, "checkout", "-q", "feature")
    # Start a merge that conflicts and is LEFT IN PROGRESS (simulates the
    # timeout/kill path where our except skipped `git merge --abort`).
    subprocess.run(["git", "merge", "--no-edit", "main"], cwd=str(repo), capture_output=True)
    merge_head = subprocess.run(
        ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=str(repo), capture_output=True
    )
    assert merge_head.returncode == 0, "precondition: merge should be in progress"

    _abort_inflight_merge(repo)

    after = subprocess.run(
        ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=str(repo), capture_output=True
    )
    assert after.returncode != 0, "MERGE_HEAD must be cleared after abort"
    assert "<<<<<<<" not in f.read_text(encoding="utf-8"), "no conflict markers left in file"
    # And a subsequent add -A + commit is a clean no-op (nothing to corrupt).
    _git(repo, "add", "-A")
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=str(repo), capture_output=True, text=True
    ).stdout.strip()
    assert status == "", f"worktree should be clean after abort, got: {status!r}"
