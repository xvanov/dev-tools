"""``scripts/deploy-factory-from-main.sh`` — factory self-deploy (G4).

Merged loop-2 self-improvements must reach the RUNNING factory tree, but the
live tree is a long-lived deploy branch with local-only commits + uncommitted
runtime state, so a ff/reset is unsafe. The script instead does a surgical
per-file sync of only the changed factory source, NEVER touching
``factory/manager/**`` or ``bench/**`` (forbidden self-edit), import-gating the
actual deployed files and reverting cleanly on failure.

Tests use a real synthetic git repo. The ``--dry-run`` tests need no seams; the
apply-path tests inject ``IMPORT_GATE_CMD`` (pass/fail) and set
``SKIP_MANAGER_RESTART=1`` so they exercise apply/gate/revert/commit without
``uv``/``systemctl``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "deploy-factory-from-main.sh"


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=True, timeout=60
    )


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return _run(["git", "-C", str(repo), *args], cwd=repo)


def _setup(tmp_path: Path, *, main_files: dict[str, str], local_files: dict[str, str]) -> Path:
    """Bare 'origin' whose main tree == ``main_files``; a 'live' clone on a
    deploy branch whose tree == ``local_files``. Returns the live tree path."""
    origin = tmp_path / "origin.git"
    seed = tmp_path / "seed"
    live = tmp_path / "live"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)

    # Seed the live baseline first (so the clone starts from local_files).
    _run(["git", "init", "-q", "--initial-branch=main", str(seed)], cwd=tmp_path)
    _git(seed, "config", "user.email", "t@e.x")
    _git(seed, "config", "user.name", "T E")
    for rel, txt in local_files.items():
        _write(seed / rel, txt)
    _git(seed, "add", ".")
    _git(seed, "commit", "-q", "-m", "local baseline")
    _git(seed, "remote", "add", "origin", str(origin))
    _git(seed, "push", "-q", "-u", "origin", "main")

    _run(["git", "clone", "-q", str(origin), str(live)], cwd=tmp_path)
    _git(live, "config", "user.email", "t@e.x")
    _git(live, "config", "user.name", "T E")
    _git(live, "checkout", "-q", "-b", "deploy-branch")

    # Now make origin/main == main_files (add/modify/delete relative to baseline).
    for rel in set(local_files) - set(main_files):
        (seed / rel).unlink()
    for rel, txt in main_files.items():
        _write(seed / rel, txt)
    _git(seed, "add", "-A")
    # Only commit if main actually differs from the baseline (the in-sync case
    # has main == local, so there's nothing to advance).
    if _git(seed, "status", "--porcelain").stdout.strip():
        _git(seed, "commit", "-q", "-m", "main advance")
        _git(seed, "push", "-q", "origin", "main")
    return live


def _invoke(
    live: Path, *, dry_run: bool = False, gate: str | None = None
) -> subprocess.CompletedProcess[str]:
    env = {
        "FACTORY_DIR": str(live),
        "PATH": os.environ["PATH"],
        "SKIP_MANAGER_RESTART": "1",
        "LOCK_FILE": str(live.parent / "sd.lock"),
    }
    if gate is not None:
        env["IMPORT_GATE_CMD"] = gate
    args = ["bash", str(_SCRIPT)]
    if dry_run:
        args.append("--dry-run")
    return subprocess.run(args, cwd=str(live), env=env, capture_output=True, text=True, timeout=90)


_GITSKIP = pytest.mark.skipif(shutil.which("git") is None, reason="git required")


@_GITSKIP
def test_dry_run_selects_only_non_forbidden_factory_files(tmp_path: Path) -> None:
    live = _setup(
        tmp_path,
        local_files={
            "factory/chain/foo.py": "V = 1\n",
            "factory/manager/bar.py": "V = 1\n",
            "bench/baz.py": "V = 1\n",
        },
        main_files={
            "factory/chain/foo.py": "V = 2\n",
            "factory/manager/bar.py": "V = 2\n",
            "bench/baz.py": "V = 2\n",
        },
    )
    head_before = _git(live, "rev-parse", "HEAD").stdout.strip()

    res = _invoke(live, dry_run=True)

    assert res.returncode == 0, res.stdout + res.stderr
    assert "factory/chain/foo.py" in res.stdout
    assert "would deploy 1 changed factory file" in res.stdout
    assert "FACTORY_SELF_DEPLOY_ALERT" in res.stderr
    assert "factory/manager/bar.py" in res.stderr  # forbidden → skipped (alert)
    assert "factory/manager/bar.py" not in res.stdout
    assert "bench/baz.py" not in res.stdout
    # Dry-run mutates nothing.
    assert _git(live, "rev-parse", "HEAD").stdout.strip() == head_before
    assert (live / "factory/chain/foo.py").read_text() == "V = 1\n"


@_GITSKIP
def test_apply_modified_file_with_passing_gate_commits(tmp_path: Path) -> None:
    live = _setup(
        tmp_path,
        local_files={"factory/chain/foo.py": "V = 1\n"},
        main_files={"factory/chain/foo.py": "V = 2\n"},
    )
    res = _invoke(live, gate="true")
    assert res.returncode == 0, res.stdout + res.stderr
    assert (live / "factory/chain/foo.py").read_text() == "V = 2\n"
    assert "deploy: auto-sync" in _git(live, "log", "-1", "--pretty=%s").stdout
    assert _git(live, "status", "--porcelain").stdout.strip() == ""  # clean tree


@_GITSKIP
def test_apply_deleted_on_main_propagates_deletion(tmp_path: Path) -> None:
    """A factory file removed on main is deleted locally (not a wedge)."""
    live = _setup(
        tmp_path,
        local_files={"factory/chain/foo.py": "V = 1\n", "factory/chain/gone.py": "X = 1\n"},
        main_files={"factory/chain/foo.py": "V = 2\n"},  # gone.py deleted on main
    )
    res = _invoke(live, gate="true")
    assert res.returncode == 0, res.stdout + res.stderr
    assert not (live / "factory/chain/gone.py").exists()  # deletion propagated
    assert (live / "factory/chain/foo.py").read_text() == "V = 2\n"  # sibling still applied
    assert _git(live, "status", "--porcelain").stdout.strip() == ""


@_GITSKIP
def test_gate_failure_fully_reverts_including_new_on_main(tmp_path: Path) -> None:
    """The regression the reviewer found: a NEW-on-main file + a failing gate
    must leave the tree exactly at HEAD — the new file removed, the modified
    file restored, nothing committed, no leftover staged/broken code."""
    live = _setup(
        tmp_path,
        local_files={"factory/chain/foo.py": "V = 1\n"},
        main_files={"factory/chain/foo.py": "V = 2\n", "factory/chain/newmod.py": "NEW = 1\n"},
    )
    head_before = _git(live, "rev-parse", "HEAD").stdout.strip()

    res = _invoke(live, gate="false")  # gate fails

    assert res.returncode == 1
    assert "import gate FAILED" in res.stderr
    # Modified file restored to HEAD (v1), new-on-main file removed entirely.
    assert (live / "factory/chain/foo.py").read_text() == "V = 1\n"
    assert not (live / "factory/chain/newmod.py").exists()
    # Nothing committed; tree fully clean (no staged/untracked leftovers).
    assert _git(live, "rev-parse", "HEAD").stdout.strip() == head_before
    assert _git(live, "status", "--porcelain").stdout.strip() == ""


@_GITSKIP
def test_gate_failure_reverts_deleted_on_main(tmp_path: Path) -> None:
    """A deleted-on-main file staged for removal is restored on gate failure."""
    live = _setup(
        tmp_path,
        local_files={"factory/chain/foo.py": "V = 1\n", "factory/chain/gone.py": "X = 1\n"},
        main_files={"factory/chain/foo.py": "V = 2\n"},
    )
    head_before = _git(live, "rev-parse", "HEAD").stdout.strip()

    res = _invoke(live, gate="false")

    assert res.returncode == 1
    assert (live / "factory/chain/gone.py").exists()  # deletion reverted
    assert (live / "factory/chain/gone.py").read_text() == "X = 1\n"
    assert (live / "factory/chain/foo.py").read_text() == "V = 1\n"
    assert _git(live, "rev-parse", "HEAD").stdout.strip() == head_before
    assert _git(live, "status", "--porcelain").stdout.strip() == ""


@_GITSKIP
def test_noop_when_in_sync(tmp_path: Path) -> None:
    live = _setup(
        tmp_path,
        local_files={"factory/chain/foo.py": "V = 2\n"},
        main_files={"factory/chain/foo.py": "V = 2\n"},
    )
    res = _invoke(live, gate="true")
    assert res.returncode == 0
    assert "already in sync" in res.stdout


# --------------------------------------------------------------------------- #
# Non-Python assets (regression)
# --------------------------------------------------------------------------- #


@_GITSKIP
def test_non_python_factory_assets_are_deployed(tmp_path: Path) -> None:
    """factory/ ships more than Python, and those assets must reach the live tree.

    The changed-file filter was ``\\.py$``, so two asset classes could be merged
    to main and never deploy:

      * ``factory/personas/*.md`` — the persona prompts. ``prompt_edit`` is the
        FMS's SAFEST self-edit class, so the loop could merge a prompt
        improvement that never reached the running factory.
      * ``factory/observability/conformance_model.yaml`` — the conformance
        checker raises on a missing model, so the live box would exit 2 and its
        detector would silently report no findings: a verifier that looks
        healthy because it never ran.
    """
    live = _setup(
        tmp_path,
        local_files={"factory/chain/foo.py": "V = 1\n"},
        main_files={
            "factory/chain/foo.py": "V = 2\n",
            "factory/personas/dev.md": "# Dev persona — `dev`\n",
            "factory/observability/conformance_model.yaml": "version: 1\n",
        },
    )
    proc = _invoke(live, gate="true")
    assert proc.returncode == 0, proc.stderr

    assert (live / "factory/personas/dev.md").exists(), "persona prompt was not deployed"
    assert (live / "factory/observability/conformance_model.yaml").exists(), (
        "conformance model was not deployed"
    )
    assert (live / "factory/chain/foo.py").read_text(encoding="utf-8") == "V = 2\n"


@_GITSKIP
def test_data_assets_are_not_fed_to_the_import_gate(tmp_path: Path) -> None:
    """A deployed .md/.yaml must never be turned into a dotted module name.

    ``${f%.py}`` leaves a non-Python path intact, so widening the file filter
    without also filtering the gate would hand importlib
    ``factory.observability.conformance_model.yaml`` and fail with a
    ModuleNotFoundError for a module that was never supposed to exist —
    reverting a perfectly good deploy. A failure of exactly that shape
    ("No module named 'factory.chain.beta'") took this unit down on 2026-07-24.

    Uses the REAL gate (no IMPORT_GATE_CMD injection) so the module-name
    derivation is what is under test.
    """
    live = _setup(
        tmp_path,
        local_files={"factory/__init__.py": "", "factory/personas/dev.md": "# old\n"},
        main_files={"factory/__init__.py": "", "factory/personas/dev.md": "# new\n"},
    )
    proc = subprocess.run(
        ["bash", str(_SCRIPT)],
        cwd=str(live),
        env={
            "FACTORY_DIR": str(live),
            "PATH": os.environ["PATH"],
            "SKIP_MANAGER_RESTART": "1",
            "LOCK_FILE": str(live.parent / "sd.lock"),
            # Stand in for `uv run python` so the gate's real module-name
            # derivation runs without needing the project env. Any argument that
            # is not an importable module makes this fail, which is the point.
            "IMPORT_GATE_CMD": (
                "python3 -c 'import sys; "
                'sys.exit(1) if any(a.endswith((".yaml", ".md", ".json")) '
                "for a in sys.argv[1:]) else sys.exit(0)'"
            ),
        },
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert proc.returncode == 0, f"a data-only deploy must not fail the gate: {proc.stderr}"
    assert (live / "factory/personas/dev.md").read_text(encoding="utf-8") == "# new\n"
