"""Tests for ``factory version`` command and its underlying ``get_git_state`` helper."""

from __future__ import annotations

import subprocess
from pathlib import Path


def _init_temp_repo(tmp_path: Path) -> Path:
    """Create a temp git repo with an initial commit, return the repo root.

    The repo has one committed file (``README.md``) so it has a real SHA
    and branch to read.
    """
    repo = tmp_path / "test_repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@factory.local")
    _git(repo, "config", "user.name", "Test Factory")
    (repo / "README.md").write_text("# Test Repo\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "initial commit")
    return repo


def _git(repo: Path, *args: str) -> str:
    """Run a git command in *repo* and return stdout."""
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=10,
    )
    result.check_returncode()
    return result.stdout


# ---------------------------------------------------------------------------
# Helper-level tests (temp git repo, no CLI involved)
# ---------------------------------------------------------------------------


class TestGetGitStateAgainstTempRepo:
    """AC4.1–4.3: validate helper against controlled git states."""

    def test_sha_matches_repo_state(self, tmp_path: Path) -> None:
        """AC4.1: reported SHA matches the actual HEAD commit."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        expected_sha = _git(repo, "rev-parse", "--short", "HEAD").strip()

        state = get_git_state(repo)
        assert state.sha == expected_sha

    def test_branch_matches_repo_state(self, tmp_path: Path) -> None:
        """AC4.2: reported branch matches the actual HEAD branch."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        expected_branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip()

        state = get_git_state(repo)
        assert state.branch == expected_branch

    def test_dirty_false_on_clean_repo(self, tmp_path: Path) -> None:
        """AC4.3: dirty is False when working tree has no uncommitted changes."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)

        state = get_git_state(repo)
        assert state.dirty is False

    def test_dirty_true_after_uncommitted_change(self, tmp_path: Path) -> None:
        """AC4.3: dirty becomes True after an uncommitted file change."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)

        # Introduce an uncommitted change.
        (repo / "README.md").write_text("# Modified\n", encoding="utf-8")

        state = get_git_state(repo)
        assert state.dirty is True

    def test_dirty_true_after_untracked_file(self, tmp_path: Path) -> None:
        """AC4.3: dirty is True when an untracked file exists."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)

        # Create an untracked file.
        (repo / "untracked.txt").write_text("hello\n", encoding="utf-8")

        state = get_git_state(repo)
        assert state.dirty is True

    def test_read_only_no_mutations(self, tmp_path: Path) -> None:
        """AC3.1: helper does not write or mutate anything in the repo."""
        from factory.git_state import get_git_state

        repo = _init_temp_repo(tmp_path)
        sha_before = _git(repo, "rev-parse", "HEAD").strip()
        porcelain_before = _git(repo, "status", "--porcelain")

        # Call multiple times — should be idempotent.
        get_git_state(repo)
        get_git_state(repo)

        sha_after = _git(repo, "rev-parse", "HEAD").strip()
        porcelain_after = _git(repo, "status", "--porcelain")

        assert sha_before == sha_after
        assert porcelain_before == porcelain_after


# ---------------------------------------------------------------------------
# CLI-level smoke tests (AC1, AC2, AC3)
# ---------------------------------------------------------------------------


class TestCliVersionSmoke:
    """Smoke tests for ``factory version`` CLI command.

    Uses a temp git repo as the factory root via ``_FACTORY_ROOT`` override,
    so the CLI reads git state from the isolated repo.

    ``_setup_cli_runner`` adds a commit (settings + state/), so all expected
    values are read *after* setup to match what the CLI will see.
    """

    def test_cli_version_exit_zero(self, tmp_path: Path) -> None:
        """AC3.3: exits 0 when invoked in a valid git repo."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)
        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output

    def test_cli_version_prints_sha(self, tmp_path: Path) -> None:
        """AC1.1: output contains the short commit SHA."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)
        expected_sha = _git(repo, "rev-parse", "--short", "HEAD").strip()

        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output
        assert expected_sha in result.output

    def test_cli_version_prints_branch(self, tmp_path: Path) -> None:
        """AC1.2: output contains the branch name."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)
        expected_branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip()

        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output
        assert expected_branch in result.output

    def test_cli_version_prints_dirty_when_dirty(self, tmp_path: Path) -> None:
        """AC2.1: output contains '(dirty: ...)' when the tree is dirty."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)
        # Dirty the repo after setup.
        (repo / "new_file.txt").write_text("untracked\n", encoding="utf-8")

        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output
        assert "(dirty:" in result.output
        assert "1 untracked" in result.output

    def test_cli_version_no_dirty_when_clean(self, tmp_path: Path) -> None:
        """AC2.1: output does NOT contain '(dirty' when tree is clean."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)

        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output
        assert "(dirty" not in result.output

    def test_cli_version_prints_staged_change(self, tmp_path: Path) -> None:
        """AC2.1: staged changes appear in dirty breakdown."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)
        (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
        _git(repo, "add", "staged.txt")

        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output
        assert "(dirty:" in result.output
        assert "1 staged" in result.output

    def test_cli_version_prints_unstaged_change(self, tmp_path: Path) -> None:
        """AC2.1: unstaged changes appear in dirty breakdown."""
        repo = _init_temp_repo(tmp_path)
        runner, cli_mod = _setup_cli_runner(repo)
        # Modify a tracked file without staging.
        (repo / "README.md").write_text("# Modified readme\n", encoding="utf-8")

        result = runner.invoke(cli_mod.app, ["version"])
        assert result.exit_code == 0, result.output
        assert "(dirty:" in result.output
        assert "1 unstaged" in result.output


def _setup_cli_runner(factory_root: Path):
    """Set up a CliRunner with _FACTORY_ROOT pointed at *factory_root*.

    Writes minimal factory_settings.yaml and state/ into *factory_root*
    (which must be a git repo), then commits them so the repo stays clean
    for tests that assert on the dirty flag.
    """
    import importlib

    import yaml

    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    (factory_root / "factory_settings.yaml").write_text(
        yaml.safe_dump({"caps": {}, "modes": {"default": "normal", "available": ["normal"]}}),
        encoding="utf-8",
    )
    (factory_root / "state").mkdir(exist_ok=True)

    # Commit setup files so the repo stays clean after setup.
    _git(factory_root, "add", "factory_settings.yaml", "state")
    _git(factory_root, "commit", "-m", "cli runner setup")

    reload_settings(factory_root)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = factory_root  # type: ignore[attr-defined]

    from typer.testing import CliRunner

    return CliRunner(), cli_mod
