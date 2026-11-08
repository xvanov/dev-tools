"""factory/state_dir.py + factory/state_migrate.py: state outside the repo."""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
from pathlib import Path

import pytest

from factory import oscompat
from factory import state_dir as sd
from factory.chain import worktree as wt_mod
from factory.jobs.common import state_db_path
from factory.state_migrate import MigrateError, migrate


@pytest.fixture(autouse=True)
def _fresh_cache() -> None:
    sd.clear_cache()
    yield
    sd.clear_cache()


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


def _root_in_repo(tmp_path: Path) -> tuple[Path, Path]:
    """A repo with the factory root inside it (the dev-tools monorepo shape)."""
    repo = tmp_path / "repo"
    root = repo / "software-factory"
    (root / "state" / "logs").mkdir(parents=True)
    (root / "state" / ".gitignore").write_text("*\n!.gitignore\n", encoding="utf-8")
    (root / "state" / "logs" / "1-x.log").write_text("{}\n", encoding="utf-8")
    con = sqlite3.connect(root / "state" / "factory.db")
    con.execute("create table t (x)")
    con.execute("insert into t values (1)")
    con.commit()
    con.close()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.invalid")
    _git(repo, "config", "user.name", "t")
    (repo / "README.md").write_text("r\n", encoding="utf-8")
    (root / ".gitignore").write_text(".state-dir\n", encoding="utf-8")
    _git(
        repo, "add", "README.md", "software-factory/.gitignore", "software-factory/state/.gitignore"
    )
    _git(repo, "commit", "-q", "-m", "init")
    return repo, root


def test_unmigrated_root_keeps_state_in_root(tmp_path: Path) -> None:
    assert sd.state_dir(tmp_path) == tmp_path / "state"
    assert state_db_path(tmp_path) == tmp_path / "state" / "factory.db"
    assert not sd.is_external(tmp_path)


def test_pointer_moves_every_path(tmp_path: Path) -> None:
    out = tmp_path / "elsewhere"
    (tmp_path / sd.POINTER_NAME).write_text(f"{out}\n", encoding="utf-8")
    assert sd.state_dir(tmp_path) == out
    assert state_db_path(tmp_path) == out / "factory.db"
    assert wt_mod.worktree_path(tmp_path, "app", 3, "s").parent == out / "worktrees"


def test_relative_pointer_is_ignored(tmp_path: Path) -> None:
    (tmp_path / sd.POINTER_NAME).write_text("rel/dir\n", encoding="utf-8")
    assert sd.state_dir(tmp_path) == tmp_path / "state"


def test_no_environment_redirects_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # An inherited variable would follow serve's children into a worktree copy
    # of the factory and point it at the live state; only the pointer counts.
    monkeypatch.setenv("FACTORY_STATE_DIR", str(tmp_path / "live-state"))
    assert sd.state_dir(tmp_path) == tmp_path / "state"
    assert not hasattr(sd, "ENV_VAR")


def test_default_external_dir_is_outside_home_repo(monkeypatch: pytest.MonkeyPatch) -> None:
    d = sd.default_external_dir()
    assert d.parts[-2:] == ("software-factory", "state")


def test_migrate_moves_state_and_relinks_worktrees(tmp_path: Path) -> None:
    repo, root = _root_in_repo(tmp_path)
    wt = root / "state" / "worktrees" / "app-1-s"
    _git(repo, "worktree", "add", "-q", "-b", "story/1", str(wt))
    target = tmp_path / "outside" / "state"

    dry = migrate(root, target, dry_run=True)
    assert dry.entries == ["factory.db", "logs", "worktrees"]
    assert not target.exists() and (root / "state" / "factory.db").exists()

    rep = migrate(root, target)
    assert rep.entries == ["factory.db", "logs", "worktrees"]
    assert (root / sd.POINTER_NAME).read_text(encoding="utf-8").strip() == str(target.resolve())
    assert sd.state_dir(root) == target.resolve()
    # moved, data intact; the tracked .gitignore stays
    assert sorted(p.name for p in (root / "state").iterdir()) == [".gitignore"]
    con = sqlite3.connect(target / "factory.db")
    assert con.execute("select x from t").fetchall() == [(1,)]
    con.close()
    assert (target / "logs" / "1-x.log").exists()
    # the worktree works from its new place and the main repo knows the new path
    moved_wt = target / "worktrees" / "app-1-s"
    assert rep.repaired == [str(moved_wt)] and not rep.repair_failed
    assert _git(moved_wt, "rev-parse", "--abbrev-ref", "HEAD").strip() == "story/1"
    listed = _git(repo, "worktree", "list", "--porcelain")
    assert moved_wt.resolve().as_posix().lower() in listed.replace("\\", "/").lower()
    # nothing under the repo is dirty
    assert _git(repo, "status", "--porcelain").strip() == ""

    with pytest.raises(MigrateError, match="already migrated"):
        migrate(root, tmp_path / "again")


def test_migrate_refuses_target_inside_repo(tmp_path: Path) -> None:
    repo, root = _root_in_repo(tmp_path)
    with pytest.raises(MigrateError, match="inside the repo"):
        migrate(root, repo / "state-copy")
    assert not (root / sd.POINTER_NAME).exists()


def test_migrate_refuses_non_empty_target(tmp_path: Path) -> None:
    _repo, root = _root_in_repo(tmp_path)
    target = tmp_path / "busy"
    target.mkdir()
    (target / "x").write_text("x", encoding="utf-8")
    with pytest.raises(MigrateError, match="not empty"):
        migrate(root, target)


def test_root_for_db_finds_the_installed_root_through_its_external_state(
    tmp_path: Path,
) -> None:
    out = tmp_path / "ext"
    sd._cache[os.path.abspath(sd.PACKAGE_ROOT)] = out  # as if its pointer named `out`
    assert sd.root_for_db(out / "factory.db") == sd.PACKAGE_ROOT
    assert sd.root_for_db(tmp_path / "r" / "state" / "factory.db") == tmp_path / "r"
    assert sd.root_for_db(tmp_path / "flat" / "factory.db") == tmp_path / "flat"


def test_acceptance_refs_resolve_into_the_state_dir(tmp_path: Path) -> None:
    from factory.chain.acceptance import acceptance_dir, acceptance_ref_path

    ref = "state/acceptance/app/7/test_acceptance.py"
    assert acceptance_ref_path(tmp_path, ref) == tmp_path / "state" / "acceptance" / "app" / "7" / "test_acceptance.py"
    out = tmp_path / "elsewhere"
    (tmp_path / sd.POINTER_NAME).write_text(f"{out}\n", encoding="utf-8")
    sd.clear_cache()
    # a ref stored before the migration names the moved file
    assert acceptance_ref_path(tmp_path, ref) == out / "acceptance" / "app" / "7" / "test_acceptance.py"
    assert acceptance_dir(tmp_path, "app", 7) == out / "acceptance" / "app" / "7"
    assert acceptance_ref_path(tmp_path, "other/x.py") == tmp_path / "other" / "x.py"


def test_a_failed_rename_puts_everything_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.state_migrate as sm

    _repo, root = _root_in_repo(tmp_path)
    (root / "state" / "worktrees").mkdir()
    target = tmp_path / "outside" / "state"
    real = sm.os.rename

    def rename(a: object, b: object) -> None:
        if Path(str(a)).name == "logs" and Path(str(b)).parent == target.resolve():
            raise PermissionError("in use")
        real(a, b)

    monkeypatch.setattr(sm.os, "rename", rename)
    with pytest.raises(MigrateError, match="nothing changed"):
        migrate(root, target)
    assert sorted(p.name for p in (root / "state").iterdir()) == [
        ".gitignore", "factory.db", "logs", "worktrees"
    ]
    assert not target.exists()
    assert not (root / sd.POINTER_NAME).exists()


def test_migrate_repairs_a_relative_gitdir(tmp_path: Path) -> None:
    repo, root = _root_in_repo(tmp_path)
    wt = root / "state" / "worktrees" / "app-2-s"
    _git(repo, "worktree", "add", "-q", "-b", "story/2", str(wt))
    admin = Path((wt / ".git").read_text(encoding="utf-8").split(":", 1)[1].strip())
    rel = Path(os.path.relpath(admin, wt))
    with open(wt / ".git", "r+", encoding="utf-8") as fh:  # hidden on Windows: no "w"
        fh.write(f"gitdir: {rel.as_posix()}\n")
        fh.truncate()
    target = tmp_path / "outside" / "state"
    rep = migrate(root, target)
    moved = target / "worktrees" / "app-2-s"
    assert rep.repaired == [str(moved)]
    assert _git(moved, "rev-parse", "--abbrev-ref", "HEAD").strip() == "story/2"


def test_install_script_never_migrates_by_itself() -> None:
    script = sd.PACKAGE_ROOT / "scripts" / "windows" / "install-serve.ps1"
    runs = [
        ln for ln in script.read_text(encoding="utf-8").splitlines()
        if not ln.lstrip().startswith("#") and re.search(r"&\s*\S+.*\bstate\b.*\bmigrate\b", ln)
    ]
    assert runs == [], "migrating is the operator's step (docs/WINDOWS.md)"


def test_migrate_refuses_while_serve_holds_its_lock(tmp_path: Path) -> None:
    _repo, root = _root_in_repo(tmp_path)
    (root / "state" / "locks").mkdir()
    lock = root / "state" / "locks" / "serve.lock"
    # A different process holds it (Windows LockFileEx and flock are per handle).
    holder = subprocess.Popen(
        [
            __import__("sys").executable,
            "-c",
            "import sys,time; from factory import oscompat; f=open(sys.argv[1],'a+b'); "
            "oscompat.lock_file(f); print('held', flush=True); time.sleep(60)",
            str(lock),
        ],
        stdout=subprocess.PIPE,
        text=True,
        cwd=str(sd.PACKAGE_ROOT),
    )
    try:
        assert holder.stdout is not None and holder.stdout.readline().strip() == "held"
        with pytest.raises(MigrateError, match="serve.lock"):
            migrate(root, tmp_path / "out")
        assert (root / "state" / "factory.db").exists()
    finally:
        holder.kill()
        holder.wait()
    assert oscompat is not None
