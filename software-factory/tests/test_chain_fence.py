from __future__ import annotations

import subprocess
from pathlib import Path

from factory.chain import fence


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "r"
    (repo / ".github" / "workflows").mkdir(parents=True)
    (repo / "src").mkdir()
    (repo / ".github" / "workflows" / "ci.yml").write_text("run: pytest\n")
    (repo / "src" / "a.py").write_text("x = 1\n")
    _git(tmp_path, "init", "-q", "r")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "branch", "-M", "main")
    return repo


def test_is_fenced() -> None:
    assert fence.is_fenced(".github/workflows/ci.yml")
    assert fence.is_fenced("apps/x/config.yaml")
    assert fence.is_fenced("./.gitlab-ci.yml")
    assert not fence.is_fenced("src/a.py")


def test_reverts_committed_modified_and_untracked_fenced_edits(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _git(repo, "checkout", "-q", "-b", "dev")
    (repo / ".github" / "workflows" / "ci.yml").write_text("run: true\n")
    _git(repo, "commit", "-qam", "dev self-commit")
    (repo / "src" / "a.py").write_text("x = 2\n")
    (repo / ".gitlab-ci.yml").write_text("test: true\n")
    reverted = fence.enforce(repo, "main", app="demo")
    assert reverted == [".github/workflows/ci.yml", ".gitlab-ci.yml"]
    assert (repo / ".github" / "workflows" / "ci.yml").read_text() == "run: pytest\n"
    assert not (repo / ".gitlab-ci.yml").exists()
    assert (repo / "src" / "a.py").read_text() == "x = 2\n"  # real work kept


def test_factory_app_is_exempt(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    (repo / ".gitlab-ci.yml").write_text("t\n")
    assert fence.enforce(repo, "main", app="factory") == []
    assert (repo / ".gitlab-ci.yml").exists()
