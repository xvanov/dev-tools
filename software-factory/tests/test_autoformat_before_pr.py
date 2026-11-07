"""Pre-PR autoformat — see factory/chain/handlers.py::_autoformat_changed_py_before_pr.

A factory self-edit (PR #57, 2026-07-21) shipped with a trivial ``I001``
unsorted-import + missing-trailing-newline. The chain's pre-merge gates
(tests-green / smoke / staging-clone) do NOT run ``ruff``, so the nit only
surfaced at GitHub's required lint check, which blocked the merge and — because
auto-merge had already been enabled — left the story stranded at
``deploy_pending``. The helper runs ``ruff --fix`` + ``ruff format`` on the
story's OWN changed ``.py`` files and commits the result before the branch is
pushed, so the PR is ruff-clean.

These tests use a real git repo (bare 'origin' + working clone) and real
``ruff`` so the ``git diff origin/<base>...HEAD`` scoping and the actual fix
behavior are exercised, not mocked.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from factory.chain.handlers import _autoformat_changed_py_before_pr


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, check=True, timeout=60
    )


def _init_repo_with_origin(app_dir: Path, *, ruff_config: bool = True) -> Path:
    """Working repo pushed to a bare 'origin' remote, so ``origin/main`` is a
    resolvable ref — the same topology the chain uses against a real remote."""
    origin = app_dir.parent / f"{app_dir.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=app_dir.parent)
    app_dir.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=app_dir)
    _run(["git", "config", "user.email", "t@e.x"], cwd=app_dir)
    _run(["git", "config", "user.name", "T E"], cwd=app_dir)
    if ruff_config:
        # A clean, already-formatted file on main so the branch diff is the
        # only dirty thing the helper can touch.
        # Mirror the factory's real config: isort (I) enabled, so an unsorted
        # import block is a real ``ruff check --fix`` target (that was PR #57's
        # I001 failure).
        (app_dir / "pyproject.toml").write_text(
            '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
        )
        (app_dir / "clean.py").write_text('"""Clean."""\n\nX = 1\n', encoding="utf-8")
    else:
        (app_dir / "README.md").write_text("# init\n", encoding="utf-8")
    _run(["git", "add", "."], cwd=app_dir)
    _run(["git", "commit", "-q", "-m", "init"], cwd=app_dir)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=app_dir)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=app_dir)
    return app_dir


def _new_branch_with_dirty_file(repo: Path, name: str, rel: str, content: str) -> None:
    _run(["git", "checkout", "-q", "-b", name], cwd=repo)
    (repo / rel).write_text(content, encoding="utf-8")
    _run(["git", "add", rel], cwd=repo)
    _run(["git", "commit", "-q", "-m", f"add {rel}"], cwd=repo)


# A file with an unsorted import block (ruff I001) and no trailing newline —
# exactly the shape of the PR #57 lint failure. ``\n`` omitted at end on purpose.
_DIRTY = (
    '"""Dirty module."""\n\nfrom pathlib import Path\nimport os\n\nP = os.getcwd()\nQ = Path(P)'
)


def _head_message(repo: Path) -> str:
    return _run(["git", "log", "-1", "--pretty=%s"], cwd=repo).stdout.strip()


def _changed_since_origin(repo: Path) -> list[str]:
    out = _run(["git", "diff", "--name-only", "origin/main...HEAD"], cwd=repo).stdout
    return out.split()


def test_autoformat_fixes_and_commits_changed_file(tmp_path: Path) -> None:
    repo = _init_repo_with_origin(tmp_path / "app")
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", _DIRTY)
    head_before = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

    _autoformat_changed_py_before_pr(repo, "main")

    # A new commit was created by the helper (HEAD advanced) with its label.
    head_after = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
    assert head_after != head_before
    assert "autoformat" in _head_message(repo)

    # The file is now ruff-clean (imports sorted, trailing newline present).
    clean = subprocess.run(
        ["uv", "run", "ruff", "check", str(repo / "feat.py")],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr
    body = (repo / "feat.py").read_text(encoding="utf-8")
    assert body.endswith("\n")
    assert body.index("import os") < body.index("from pathlib import Path")


def test_autoformat_noop_when_already_clean(tmp_path: Path) -> None:
    repo = _init_repo_with_origin(tmp_path / "app")
    clean = '"""OK."""\n\nimport os\n\nP = os.getcwd()\n'
    _new_branch_with_dirty_file(repo, "story/1-x", "ok.py", clean)
    head_before = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

    _autoformat_changed_py_before_pr(repo, "main")

    # Nothing to fix → no extra commit.
    assert _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip() == head_before


def test_autoformat_only_touches_changed_files(tmp_path: Path) -> None:
    """A TRACKED, ruff-dirty file that lives on the base (origin/main) but is
    NOT part of the branch diff must be left byte-for-byte untouched — the
    helper is scoped strictly to the branch's own changed files, never a
    whole-repo reformat."""
    # ``legacy.py`` is committed on main (thus part of origin/main) while it is
    # ruff-dirty (unsorted imports, no trailing newline). Because main is not
    # required to be ruff-clean here, this proves the helper never touches a
    # file outside ``origin/main...HEAD`` even when that file IS ruff-dirty.
    legacy = '"""Legacy."""\n\nfrom pathlib import Path\nimport os\n\nL = Path(os.getcwd())'
    repo = tmp_path / "app"
    origin = repo.parent / f"{repo.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)
    repo.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=repo)
    _run(["git", "config", "user.email", "t@e.x"], cwd=repo)
    _run(["git", "config", "user.name", "T E"], cwd=repo)
    (repo / "pyproject.toml").write_text(
        '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
    )
    (repo / "legacy.py").write_text(legacy, encoding="utf-8")
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-q", "-m", "init with dirty legacy"], cwd=repo)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=repo)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=repo)

    # Branch changes ONLY feat.py.
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", _DIRTY)

    _autoformat_changed_py_before_pr(repo, "main")

    # legacy.py (dirty, on base, not in the branch diff) is byte-for-byte
    # unchanged; feat.py (in the diff) is the only thing formatted.
    assert (repo / "legacy.py").read_text(encoding="utf-8") == legacy
    assert (repo / "feat.py").read_text(encoding="utf-8").endswith("\n")
    assert "feat.py" in _changed_since_origin(repo)


def test_autoformat_strips_branch_added_unused_import(tmp_path: Path) -> None:
    """An unused import the BRANCH itself added (F401) is now deleted — this is
    the sacrifice backlog fix. The dev's own new/changed file's unused imports
    are safe to remove (they were just added, so nothing depends on them)."""
    repo = _init_repo_with_origin(tmp_path / "app")
    # ``sys`` is imported but unused (F401); ``os`` is used. New file on branch.
    dirty = '"""Has unused import."""\n\nimport os\nimport sys\n\nP = os.getcwd()\n'
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", dirty)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "feat.py").read_text(encoding="utf-8")
    assert "import sys" not in body  # branch-added unused import removed
    assert "import os" in body  # used import kept
    # File is now fully ruff-clean.
    clean = subprocess.run(
        ["uv", "run", "ruff", "check", str(repo / "feat.py")],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr


def test_autoformat_keeps_preexisting_unused_import(tmp_path: Path) -> None:
    """A PRE-EXISTING unused import (on base, not added by this branch) must
    NOT be deleted even when the branch changes the file — it could be a
    load-bearing side-effect import, and the code is not re-tested here."""
    repo = tmp_path / "app"
    origin = repo.parent / f"{repo.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)
    repo.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=repo)
    _run(["git", "config", "user.email", "t@e.x"], cwd=repo)
    _run(["git", "config", "user.name", "T E"], cwd=repo)
    (repo / "pyproject.toml").write_text(
        '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
    )
    # feat.py exists on main with an unused ``import sys`` (pre-existing F401).
    (repo / "feat.py").write_text('"""M."""\n\nimport sys\n\nP = 1\n', encoding="utf-8")
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-q", "-m", "init"], cwd=repo)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=repo)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=repo)

    # Branch MODIFIES feat.py (adds a used line) — file is now in the diff, but
    # the unused import is NOT a branch addition.
    _run(["git", "checkout", "-q", "-b", "story/1-x"], cwd=repo)
    (repo / "feat.py").write_text('"""M."""\n\nimport sys\n\nP = 1\nQ = 2\n', encoding="utf-8")
    _run(["git", "commit", "-q", "-am", "extend feat"], cwd=repo)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "feat.py").read_text(encoding="utf-8")
    # Pre-existing unused import PRESERVED (reverted the unsafe F401 removal).
    assert "import sys" in body
    assert "Q = 2" in body


def test_autoformat_keeps_shadowed_preexisting_import_collision(tmp_path: Path) -> None:
    """Adversarial-review HIGH: the guard must be line-number based, not text.
    Base has a load-bearing top-level ``import os``; the branch adds a function
    with a *local* ``import os`` (same text). F401 flags the now-shadowed
    top-level import — but it's PRE-EXISTING, so it must NOT be deleted even
    though a branch-added line has identical stripped text."""
    repo = tmp_path / "app"
    origin = repo.parent / f"{repo.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)
    repo.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=repo)
    _run(["git", "config", "user.email", "t@e.x"], cwd=repo)
    _run(["git", "config", "user.name", "T E"], cwd=repo)
    (repo / "pyproject.toml").write_text(
        '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
    )
    (repo / "m.py").write_text(
        '"""M."""\n\nimport os\n\n\ndef existing():\n    return 1\n', encoding="utf-8"
    )
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-q", "-m", "init"], cwd=repo)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=repo)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=repo)

    # Branch adds a function with a local ``import os`` (used) — same text as the
    # pre-existing top-level import, which is now shadowed/unused (F401).
    _run(["git", "checkout", "-q", "-b", "story/1-x"], cwd=repo)
    (repo / "m.py").write_text(
        '"""M."""\n\nimport os\n\n\ndef existing():\n    return 1\n\n\n'
        "def new_feature():\n    import os\n\n    return os.getcwd()\n",
        encoding="utf-8",
    )
    _run(["git", "commit", "-q", "-am", "add feature"], cwd=repo)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "m.py").read_text(encoding="utf-8")
    # The pre-existing top-level import must survive (F401 was on a pre-existing
    # line → the whole file is left for CI/dev, never auto-deleted here).
    assert body.count("import os") == 2, body


def test_autoformat_strips_branch_added_f541(tmp_path: Path) -> None:
    """An f-string with no placeholders (F541) the BRANCH added is de-prefixed —
    a safe, behavior-preserving fix on the story's own new line."""
    repo = _init_repo_with_origin(tmp_path / "app")
    dirty = '"""Has F541."""\n\nMSG = f"no placeholder here"\n'
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", dirty)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "feat.py").read_text(encoding="utf-8")
    assert 'MSG = "no placeholder here"' in body  # f-prefix dropped
    assert 'f"' not in body
    clean = subprocess.run(
        ["uv", "run", "ruff", "check", str(repo / "feat.py")],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr


def test_autoformat_strips_branch_added_unused_variable(tmp_path: Path) -> None:
    """An unused local variable (F841) the BRANCH added is removed via ruff's
    ``--unsafe-fixes`` — the binding goes, the side-effecting RHS call stays."""
    repo = _init_repo_with_origin(tmp_path / "app")
    dirty = (
        '"""Has F841."""\n\n\n'
        "def feature():\n    unused = compute()\n    return 1\n\n\n"
        "def compute():\n    return 2\n"
    )
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", dirty)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "feat.py").read_text(encoding="utf-8")
    assert "unused =" not in body  # unused binding removed
    assert "compute()" in body  # side-effecting call preserved
    clean = subprocess.run(
        ["uv", "run", "ruff", "check", str(repo / "feat.py")],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr


def test_autoformat_preexisting_f841_does_not_block_own_f401(tmp_path: Path) -> None:
    """Per-code independence: a PRE-EXISTING unused variable (F841 on a base
    line) must NOT be mutated, and must NOT stop the branch's OWN newly-added
    unused import (F401) from being removed. The two codes are gated
    independently, by line number."""
    repo = tmp_path / "app"
    origin = repo.parent / f"{repo.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)
    repo.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=repo)
    _run(["git", "config", "user.email", "t@e.x"], cwd=repo)
    _run(["git", "config", "user.name", "T E"], cwd=repo)
    (repo / "pyproject.toml").write_text(
        '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
    )
    # Base has a pre-existing unused local (F841) inside a function.
    (repo / "feat.py").write_text(
        '"""M."""\n\n\ndef existing():\n    leftover = 5\n    return 1\n',
        encoding="utf-8",
    )
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-q", "-m", "init"], cwd=repo)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=repo)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=repo)

    # Branch ADDS an unused import at the top (F401 on a branch-added line).
    _run(["git", "checkout", "-q", "-b", "story/1-x"], cwd=repo)
    (repo / "feat.py").write_text(
        '"""M."""\n\nimport os\n\n\ndef existing():\n    leftover = 5\n    return 1\n',
        encoding="utf-8",
    )
    _run(["git", "commit", "-q", "-am", "add unused import"], cwd=repo)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "feat.py").read_text(encoding="utf-8")
    assert "import os" not in body  # branch-added F401 removed...
    assert "leftover = 5" in body  # ...pre-existing F841 preserved (not on an added line)


def test_autoformat_fix_cascade_never_deletes_preexisting_import(tmp_path: Path) -> None:
    """RESULT-CHECK regression (adversarial review, PR #105): a single
    ``ruff --fix`` pass is iterative — removing a branch-added unused local
    (F841) can orphan a PRE-EXISTING import and, with F401 co-selected, ruff
    deletes that pre-existing import in the SAME invocation, on a line the
    per-code input gate never evaluated. The file must be reverted whole rather
    than ship a silent deletion of code the branch did not author."""
    repo = tmp_path / "app"
    origin = repo.parent / f"{repo.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)
    repo.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=repo)
    _run(["git", "config", "user.email", "t@e.x"], cwd=repo)
    _run(["git", "config", "user.name", "T E"], cwd=repo)
    (repo / "pyproject.toml").write_text(
        '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n', encoding="utf-8"
    )
    # Base: a load-bearing top-level ``import os`` used only via ``feature``.
    (repo / "feat.py").write_text(
        '"""M."""\n\nimport os\n\n\ndef feature():\n    return os\n',
        encoding="utf-8",
    )
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-q", "-m", "init"], cwd=repo)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=repo)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=repo)

    # Branch ADDS: an unused import (F401 row) AND, inside feature, an unused
    # local ``x = os`` (F841 row) that is the sole remaining reference to the
    # top-level ``import os`` once removed. Both violations are on branch-added
    # lines, so both codes pass the input gate — but the combined fix cascades.
    _run(["git", "checkout", "-q", "-b", "story/1-x"], cwd=repo)
    (repo / "feat.py").write_text(
        '"""M."""\n\nimport os\nimport sys\n\n\ndef feature():\n    x = os\n    return 1\n',
        encoding="utf-8",
    )
    _run(["git", "commit", "-q", "-am", "add feature"], cwd=repo)

    _autoformat_changed_py_before_pr(repo, "main")

    body = (repo / "feat.py").read_text(encoding="utf-8")
    # The pre-existing top-level ``import os`` MUST survive (the cascade was
    # caught and the file reverted). It's fine that the added ``import sys``
    # (also unused) survives too — reverting whole is safe; CI/dev handles it.
    assert "import os" in body, body


def test_added_line_numbers_parses_hunks() -> None:
    from factory.chain.handlers import _added_line_numbers

    diff = (
        "diff --git a/m.py b/m.py\n"
        "--- a/m.py\n+++ b/m.py\n"
        "@@ -1,3 +1,5 @@\n"
        " line1\n line2\n+added3\n+added4\n line5\n"
    )
    # new-file: 1,2 context; 3,4 added; 5 context
    assert _added_line_numbers(diff) == {3, 4}


def test_autoformat_runs_for_app_with_ruff_lint_command_no_tool_ruff(tmp_path: Path) -> None:
    """sacrifice-shape: no ``[tool.ruff]`` table, but the app's lint gate runs
    ``ruff check .`` — detection must fire via app_config.gates.lint_command."""
    from factory.app_config import AppConfig, AppGatesConfig, DeployConfig

    repo = tmp_path / "app"
    origin = repo.parent / f"{repo.name}-origin.git"
    _run(["git", "init", "-q", "--bare", "--initial-branch=main", str(origin)], cwd=tmp_path)
    repo.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch=main"], cwd=repo)
    _run(["git", "config", "user.email", "t@e.x"], cwd=repo)
    _run(["git", "config", "user.name", "T E"], cwd=repo)
    # NO [tool.ruff] — default-config ruff, like sacrifice.
    (repo / "pyproject.toml").write_text('[project]\nname = "x"\nversion = "0"\n', encoding="utf-8")
    (repo / "clean.py").write_text('"""C."""\n\nX = 1\n', encoding="utf-8")
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-q", "-m", "init"], cwd=repo)
    _run(["git", "remote", "add", "origin", str(origin)], cwd=repo)
    _run(["git", "push", "-u", "-q", "origin", "main"], cwd=repo)
    dirty = '"""Unused."""\n\nimport os\nimport sys\n\nP = os.getcwd()\n'
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", dirty)

    cfg = AppConfig(
        name="sacrifice",
        repo="o/r",
        default_branch="main",
        context_dir="context",
        deploy=DeployConfig(enabled=False),
        models={},
        gates=AppGatesConfig(lint_command="ruff check . && cd frontend && npm run lint"),
    )
    _autoformat_changed_py_before_pr(repo, "main", cfg)

    body = (repo / "feat.py").read_text(encoding="utf-8")
    assert "import sys" not in body  # F401 fired despite no [tool.ruff] table
    assert "import os" in body


def test_autoformat_still_skips_app_without_ruff_gate(tmp_path: Path) -> None:
    """An app whose gates do NOT mention ruff → still a no-op (never touch it)."""
    from factory.app_config import AppConfig, AppGatesConfig, DeployConfig

    repo = _init_repo_with_origin(tmp_path / "app", ruff_config=False)
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", _DIRTY)
    head_before = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
    cfg = AppConfig(
        name="x",
        repo="o/r",
        default_branch="main",
        context_dir="context",
        deploy=DeployConfig(enabled=False),
        models={},
        gates=AppGatesConfig(lint_command="flake8 ."),
    )
    _autoformat_changed_py_before_pr(repo, "main", cfg)
    assert _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip() == head_before


def test_autoformat_noop_without_ruff_config(tmp_path: Path) -> None:
    """No [tool.ruff] / ruff.toml → skip entirely (never touch a non-ruff repo)."""
    repo = _init_repo_with_origin(tmp_path / "app", ruff_config=False)
    _new_branch_with_dirty_file(repo, "story/1-x", "feat.py", _DIRTY)
    head_before = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

    _autoformat_changed_py_before_pr(repo, "main")

    assert _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip() == head_before


def test_autoformat_never_raises_on_bad_repo(tmp_path: Path) -> None:
    """A path that isn't a git repo (or has no origin) must not raise."""
    not_a_repo = tmp_path / "nope"
    not_a_repo.mkdir()
    (not_a_repo / "pyproject.toml").write_text("[tool.ruff]\n", encoding="utf-8")
    # Must return cleanly (best-effort contract), not raise.
    _autoformat_changed_py_before_pr(not_a_repo, "main")
