"""The ONE path classifier both the bench harness and the merge gate call.

Two matchers, one definition, opposite safe directions (see
``factory/diff_paths.py``): the bench STRIPS on the broad one, the merge gate
BLOCKS on the strict one. The invariant that keeps them from contradicting each
other — strict ⊆ broad — is asserted here, over this repo's own file list as
well as fixed cases.

The reason the split exists is measured, and it is pinned below: the broad
matcher calls ``factory/testing/flake.py`` a test file. That file is imported by
``factory/chain/gates/tests_green.py``. A REQUIRED merge gate using the broad
matcher would have refused to merge a story whose diff is confined to it — and
refused the ``factory_improver`` prompt_edit path outright, whose diffs are
persona ``.md`` files named ``test_*``.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from factory.diff_paths import (
    is_collection_channel_path,
    is_production_path,
    is_test_code_path,
    is_test_path,
    production_paths,
)

_REPO_ROOT = Path(__file__).resolve().parents[1]

_CASES = [
    # (path, broad-test, strict-test-code)
    ("tests/test_a.py", True, True),
    ("pkg/tests/helpers.py", True, True),
    ("test/unit/thing.py", True, True),
    ("src/test_foo.py", True, True),
    ("src/foo_test.go", True, True),
    ("pkg/conftest.py", True, True),
    ("web/app.spec.tsx", True, True),
    # broad-only: a testing/ package and a test_*.md document are production.
    ("factory/testing/flake.py", True, False),
    ("factory/personas/test_designer.md", True, False),
    ("docs/test_plan.md", True, False),
    # neither
    ("src/app.py", False, False),
    ("README.md", False, False),
]


def test_strict_is_a_subset_of_broad_on_fixed_cases() -> None:
    for path, broad, strict in _CASES:
        assert is_test_path(path) is broad, path
        assert is_test_code_path(path) is strict, path
        if strict:
            assert broad, f"{path}: strict matched where broad did not"


def test_strict_is_a_subset_of_broad_across_this_repo() -> None:
    """The invariant has to hold on real paths, not only on chosen ones."""
    tracked = subprocess.run(
        ["git", "ls-files"],
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert len(tracked) > 100, "git ls-files returned suspiciously little"
    broad = {p for p in tracked if is_test_path(p)}
    strict = {p for p in tracked if is_test_code_path(p)}
    assert strict <= broad
    # The exact broad-only set in this repo, pinned: every one of these is
    # PRODUCTION code that a required gate must not mistake for a test.
    assert sorted(broad - strict) == [
        "factory/personas/test_designer.md",
        "factory/personas/test_implementer.md",
        "factory/testing/__init__.py",
        "factory/testing/flake.py",
    ]


def test_the_gate_predicate_treats_those_four_as_production() -> None:
    for path in (
        "factory/testing/flake.py",
        "factory/testing/__init__.py",
        "factory/personas/test_designer.md",
        "factory/personas/test_implementer.md",
    ):
        assert is_production_path(path), path
    assert production_paths(["tests/test_a.py", "factory/testing/flake.py"]) == [
        "factory/testing/flake.py"
    ]


def test_collection_channels_are_not_production() -> None:
    for path in (
        "pyproject.toml",
        "setup.cfg",
        "tox.ini",
        "pytest.ini",
        "setup.py",
        "noxfile.py",
        "sitecustomize.py",
        "usercustomize.py",
        "vendor/x.pth",
        "my_pytest_plugin.py",
        "pkg/conftest.py",
        # Added 2026-08-05. Each of these was classified PRODUCTION and each was a
        # forced pass measured against the acceptance-oracle gate — the "whole test
        # surface from base" rollback passed them through from HEAD.
        ".pytest.ini",  # pytest honours the DOT-prefixed inifile, and it OUTRANKS
        "backend/.pytest.ini",  # pyproject.toml. Every other name is (^|/)-anchored.
        # importlib.metadata scans every sys.path entry for these and pytest calls
        # load_setuptools_entrypoints("pytest11") — a plugin with NO config edit.
        "backend/devhelper-1.0.dist-info/entry_points.txt",
        "backend/devhelper.egg-info/PKG-INFO",
        # The runner's own import names. ``python -m pytest`` puts the run cwd at
        # sys.path[0], so a pytest.py there IS the pytest run.
        "backend/pytest.py",
        "backend/_pytest.py",
        "pluggy.py",
        "py.py",
    ):
        assert is_collection_channel_path(path), path
        assert not is_production_path(path), path


def test_runner_shadowing_matches_the_whole_basename_only() -> None:
    """The runner-name rule must not swallow ordinary production modules: it is the
    exact basename that shadows an import, not a substring of one."""
    for path in (
        "pkg/path.py",
        "app/copy.py",
        "app/pytest_helpers.py",
        "app/my_py.py",
        "app/pluggy_client.py",
        "docs/pytest.md",
        "app/dist-info.py",
    ):
        assert not is_collection_channel_path(path), path
        assert is_production_path(path), path


def test_paths_are_normalized_before_matching() -> None:
    """A gate must not be defeated by ``./`` or a backslash."""
    for path in ("./tests/test_a.py", r"tests\test_a.py", "/tests/test_a.py"):
        assert is_test_code_path(path), path
        assert not is_production_path(path), path
    assert not is_production_path("")


def test_no_chain_produced_commit_in_recent_history_would_be_blocked() -> None:
    """Regression for the measured false-block class.

    Over the last 400 non-merge commits on this branch, the only zero-production
    diffs left under the STRICT predicate are test-only changes — which this gate
    exists to block — and none of them is a persona/``testing/`` diff. Before the
    split, ``factory/personas/test_implementer.md`` commits (including one the
    factory's own ``factory_improver`` produced) scored as zero-production.
    """
    shas = subprocess.run(
        ["git", "log", "--no-merges", "-400", "--format=%H"],
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    if len(shas) < 50:  # shallow clone — nothing to measure
        return
    offenders: list[str] = []
    for sha in shas:
        paths = [
            line.strip()
            for line in subprocess.run(
                ["git", "show", "--pretty=", "--name-only", sha],
                cwd=str(_REPO_ROOT),
                capture_output=True,
                text=True,
                check=True,
            ).stdout.splitlines()
            if line.strip()
        ]
        if not paths or production_paths(paths):
            continue
        # A zero-production diff is EXPECTED for a genuinely test-only commit.
        if all(is_test_code_path(p) or is_collection_channel_path(p) for p in paths):
            continue
        offenders.append(f"{sha[:9]} {paths[:5]}")
    assert offenders == [], f"non-test diffs scored as zero-production: {offenders}"
