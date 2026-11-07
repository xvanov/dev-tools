"""``deploy-factory-from-main.sh`` must never destroy uncommitted work.

The script syncs changed ``factory/**/*.py`` from origin/main by running
``git checkout <ref> -- <file>``, which overwrites the working-tree copy with no
warning and no way back. It assumed the live tree differs from main ONLY by
deployed commits. It does not: on 2026-07-24 the tree carried 131 modified files
and this loop silently reverted an in-progress edit to ``factory/cli.py``
mid-session. A locally-modified file is someone's work, not a deploy candidate.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "deploy-factory-from-main.sh"


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=str(repo), capture_output=True, text=True, check=True
    )


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """A repo with an ``origin/main`` that is AHEAD of the working tree."""
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-q", "-b", "main")
    _git(origin, "config", "user.email", "t@e.com")
    _git(origin, "config", "user.name", "T")
    _git(origin, "config", "commit.gpgsign", "false")
    for rel in ("factory/chain/alpha.py", "factory/chain/beta.py"):
        p = origin / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("VERSION = 'base'\n", encoding="utf-8")
    (origin / "scripts").mkdir(exist_ok=True)
    _git(origin, "add", ".")
    _git(origin, "commit", "-q", "-m", "base")

    clone = tmp_path / "live"
    subprocess.run(
        ["git", "clone", "-q", str(origin), str(clone)], check=True, capture_output=True
    )
    _git(clone, "config", "user.email", "t@e.com")
    _git(clone, "config", "user.name", "T")
    _git(clone, "config", "commit.gpgsign", "false")

    # origin/main moves ahead on BOTH files.
    for rel in ("factory/chain/alpha.py", "factory/chain/beta.py"):
        (origin / rel).write_text("VERSION = 'from_main'\n", encoding="utf-8")
    _git(origin, "add", ".")
    _git(origin, "commit", "-q", "-m", "advance")

    # git does not track empty dirs, so the clone has no scripts/ — create it.
    (clone / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy2(SCRIPT, clone / "scripts" / SCRIPT.name)
    _git(clone, "fetch", "-q", "origin", "main")
    return clone


def _run_script(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run the script against ``repo``.

    ``FACTORY_DIR`` MUST be set: the script defaults it to the real
    ``/home/k/software-factory`` and ``cd``s there, so without the override these
    tests would operate on the live tree instead of the fixture.
    """
    import os

    env = {
        **os.environ,
        "FACTORY_DIR": str(repo),
        # Per-fixture lock, like the sibling test file already does: the
        # script's default is a GLOBAL /tmp/factory-self-deploy.lock, and a
        # held lock makes it exit 0 having deployed nothing — under a live
        # factory-self-deploy.timer or a parallel test run that surfaced as a
        # bare stdout-assertion failure with no hint of the cause.
        "LOCK_FILE": str(repo / ".test-self-deploy.lock"),
    }
    return subprocess.run(
        ["bash", str(repo / "scripts" / SCRIPT.name), *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
    )


def test_locally_modified_file_is_never_overwritten(fake_repo: Path) -> None:
    """The regression: uncommitted work must survive a self-deploy."""
    dirty = fake_repo / "factory" / "chain" / "alpha.py"
    dirty.write_text("VERSION = 'MY_UNCOMMITTED_WORK'\n", encoding="utf-8")

    proc = _run_script(fake_repo)

    assert "MY_UNCOMMITTED_WORK" in dirty.read_text(encoding="utf-8"), (
        f"self-deploy destroyed uncommitted work.\nstdout={proc.stdout}\nstderr={proc.stderr}"
    )
    combined = proc.stdout + proc.stderr
    assert "locally-modified paths SKIPPED" in combined, "the skip must be loud, not silent"
    assert "factory/chain/alpha.py" in combined


def test_clean_files_are_still_selected_for_deploy(fake_repo: Path) -> None:
    """The guard must not disable the deploy for files nobody is editing.

    Asserts on SELECTION rather than final file content: a synthetic repo has no
    Python env, so the script's own post-apply import gate fails and reverts
    everything (correct behaviour, verified manually). Selection is what the
    dirty-file guard governs, so that is what this pins.
    """
    dirty = fake_repo / "factory" / "chain" / "alpha.py"
    dirty.write_text("VERSION = 'MY_UNCOMMITTED_WORK'\n", encoding="utf-8")

    proc = _run_script(fake_repo)

    assert "MY_UNCOMMITTED_WORK" in dirty.read_text(encoding="utf-8")
    # The deploy list goes to stdout; alerts go to stderr. Asserting per-stream
    # keeps this precise (concatenating the two loses chronological order).
    assert "would deploy 1 changed factory file" in proc.stdout, proc.stdout
    assert "factory/chain/beta.py" in proc.stdout, "the clean file should be a candidate"
    assert "factory/chain/alpha.py" not in proc.stdout, "the dirty file must not be deployed"
    assert "locally-modified paths SKIPPED" in proc.stderr


def test_dry_run_mutates_nothing(fake_repo: Path) -> None:
    clean = fake_repo / "factory" / "chain" / "beta.py"
    before = clean.read_text(encoding="utf-8")
    _run_script(fake_repo, "--dry-run")
    assert clean.read_text(encoding="utf-8") == before
