"""ONE path classifier for "is this file part of the oracle, or the fix?".

Two subsystems have to answer that question and they must never disagree:

* ``bench/swebench_adapter.py`` strips test edits out of a prediction before
  the hidden suite grades it, and REFUSES a prediction that edits a pytest
  collection channel;
* the ``production-tree-changed`` merge gate (``factory/chain/gates/``) blocks
  a story whose diff contains no production-code change at all.

The bench harness owned these regexes first and they were measured against
real pytest behaviour (see the comments below). They live here so the gate
reuses the SAME definition instead of growing a second, drifting one — a
divergence would mean the benchmark and the chain disagree about what a
"production change" is, and the number the benchmark reports would stop
describing the thing the chain gates on.

Definitions
-----------
* **test path** (``is_test_path``) — anything that might belong to a repo's test
  surface: test code, a ``testing/`` directory, ``conftest.py``,
  ``test_<anything>`` whatever its extension. Deliberately OVER-inclusive.
* **test CODE path** (``is_test_code_path``) — a file that unambiguously IS a
  test: under ``tests/``/``test/``, ``test_x.<code-ext>``,
  ``x_test.<code-ext>``, ``conftest.py``, ``*.spec.tsx``. A strict SUBSET of
  ``is_test_path`` — asserted by ``tests/test_diff_paths.py``, over this repo's
  own file list as well as fixed cases.
* **collection channel** — a file that decides WHICH tests run, or WHETHER
  they run, without being test code.
* **production path** — not test CODE, and not a collection channel. Docs,
  non-collection config and source all count: the predicate answers "did the
  change touch something other than the oracle", not "is this file
  interesting".

Two matchers, one definition, opposite safe directions
------------------------------------------------------
The bench STRIPS on its matcher, so over-inclusion is safe (stripping one file
too many can only weaken the arm's own patch) and under-inclusion would let an
arm edit the oracle judging it. The merge gate BLOCKS on its matcher, so
over-inclusion costs real merges. They therefore need the same notion pointed in
opposite directions, and the strict one is a subset of the broad one.

This is not a theoretical split. MEASURED in this repo: the broad matcher calls
``factory/testing/flake.py`` — live merge-gate code, imported by
``gates/tests_green.py`` — and ``factory/personas/test_designer.md`` test files.
Used as a REQUIRED merge gate it would have refused any story whose diff is
confined to those; 2 of the last 400 commits on ``main`` are exactly that shape
(a ``factory_improver`` prompt_edit, and a persona clarification). Both matchers
live here and the subset relation is a test, so they cannot drift into
disagreeing about a real file.

There is a THIRD, narrower test-path matcher in ``factory/chain/branch.py``
(``is_test_file`` / ``_TEST_FILE_PATTERNS``). It is deliberately left alone:
it drives the legacy "dev must not modify frozen tests" diff check, and
widening it would change unrelated enforcement. Do not add a fourth.
"""

from __future__ import annotations

import re

# A tests?/ or test/ directory anywhere, test_foo.py, foo_test.go, conftest.py
# (fixtures shape the oracle too), *.spec.tsx, a testing/ directory.
_TEST_PATH = re.compile(
    r"(^|/)tests?(/|$)"           # a tests/ or test/ directory anywhere
    r"|(^|/)test_[^/]+$"          # test_foo.py
    r"|_test\.[a-z]+$"            # foo_test.go
    r"|(^|/)conftest\.py$"        # pytest fixtures shape the oracle too
    r"|\.spec\.[jt]sx?$"
    r"|(^|/)testing(/|$)"
)

# Extensions a TEST is actually written in. A ``test_*``/``*_test`` file with any
# other extension (``.md``, ``.txt``, ``.json``, ``.csv``) is a document or a
# fixture, not a test — and the strict matcher is used where a false positive
# costs a merge, so it must not guess.
_TEST_CODE_EXT = (
    r"(py|pyi|pyx|rb|go|js|jsx|mjs|cjs|ts|tsx|java|kt|kts|rs|c|cc|cpp|cxx|h|hpp"
    r"|cs|php|sh|bash|lua|pl|swift|scala|ex|exs|m|mm|dart|zig)"
)

# The STRICT matcher — a strict subset of ``_TEST_PATH``. Drops the two branches
# that make the broad matcher over-inclusive:
#   * ``(^|/)testing(/|$)``: a ``testing/`` package is production code in plenty
#     of repos, including this one (``factory/testing/flake.py`` is imported by
#     the tests-green merge gate);
#   * an extension-agnostic ``test_[^/]+$``: it swallows
#     ``factory/personas/test_designer.md``, a persona PROMPT — i.e. product.
_TEST_CODE_PATH = re.compile(
    r"(^|/)tests?(/|$)"
    rf"|(^|/)test_[^/]*\.{_TEST_CODE_EXT}$"
    rf"|_test\.{_TEST_CODE_EXT}$"
    r"|(^|/)conftest\.py$"
    r"|\.spec\.[jt]sx?$"
)

# Files that decide WHICH tests run and WHETHER they run, without being test
# files themselves. ``_TEST_PATH`` matches test code; these are the collection
# and auto-import channels that reach the same outcome sideways:
#
#   * ``pyproject.toml`` / ``setup.cfg`` / ``tox.ini`` / ``pytest.ini`` —
#     ``[tool.pytest.ini_options] addopts``, ``-p <plugin>``, markers,
#     ``collect_ignore``;
#   * ``setup.py`` / ``noxfile.py`` — run at build/test time;
#   * ``sitecustomize.py`` / ``usercustomize.py`` / ``*.pth`` — imported by
#     the interpreter itself, before pytest starts;
#   * ``*pytest*plugin*.py`` — an entry-point plugin.
#
# Measured against real pytest: a root ``_fixup.py`` with
# ``pytest_collection_modifyitems`` marking every item skipped plus
# ``addopts = "-p _fixup"`` makes ``python -m pytest <ids>`` exit 0 with
# "2 skipped". Under exit-code grading that was RESOLVED. The plugin file
# itself is ordinary production-looking code, so the CONFIG edit is the
# chokepoint worth refusing on.
#
# THREE MORE, each a forced pass measured 2026-08-05 against the acceptance
# oracle gate — every one of them classified PRODUCTION before this, so nothing
# rolled it back:
#
#   * ``.pytest.ini`` — pytest honours the DOT-prefixed name as an inifile and it
#     outranks ``pyproject.toml``. Every other name here is anchored on
#     ``(^|/)``, which the leading dot walked straight past. Same attack as
#     ``addopts = "-p _fixup"``, routed around the ``pyproject.toml`` rollback.
#   * ``*.dist-info/`` and ``*.egg-info/`` — ``importlib.metadata`` scans every
#     ``sys.path`` entry for these, and pytest calls
#     ``load_setuptools_entrypoints("pytest11")``. An ``entry_points.txt``
#     committed in the run cwd auto-loads a dev-authored plugin with NO config
#     edit at all. They are build artifacts; a diff has no business in them.
#   * a module that SHADOWS THE RUNNER in the run cwd (``pytest.py``,
#     ``_pytest.py``, ``py.py``, ``pluggy.py``). ``python -m pytest`` puts the cwd
#     at ``sys.path[0]``, so ``pytest.py`` there *becomes* the whole "pytest run"
#     — print a summary, ``sys.exit(0)``, done.
_COLLECTION_CHANNEL = re.compile(
    r"(^|/)(pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|\.pytest\.ini|setup\.py"
    r"|noxfile\.py|sitecustomize\.py|usercustomize\.py|conftest\.py)$"
    r"|\.pth$"
    # The test runner's own import names. Shadowing any of them replaces the
    # thing that reports the verdict.
    r"|(^|/)(pytest|_pytest|py|pluggy)\.py$"
    # Installed-distribution metadata: the pytest11 entry-point channel.
    r"|(^|/)[^/]*\.(dist-info|egg-info)(/|$)"
    r"|(^|/)[^/]*pytest[^/]*plugin[^/]*\.py$"
    r"|(^|/)[^/]*plugin[^/]*pytest[^/]*\.py$"
)


def _normalize(path: str) -> str:
    """``a/b`` form, no leading ``./``, backslashes folded to ``/``."""
    norm = path.strip().replace("\\", "/")
    while norm.startswith("./"):
        norm = norm[2:]
    return norm.lstrip("/")


def is_test_path(path: str) -> bool:
    """BROAD: anything that might belong to the test surface. Bench-side.

    Over-inclusive on purpose — the bench strips these out of a prediction, and
    stripping one file too many can only weaken the arm's own patch.
    """
    return bool(_TEST_PATH.search(_normalize(path)))


def is_test_code_path(path: str) -> bool:
    """STRICT: the file unambiguously IS a test. Gate-side.

    A subset of ``is_test_path``. Used where a false positive BLOCKS a merge, so
    it never guesses: a ``test_*`` file whose extension is not a programming
    language is a document or a fixture, and a ``testing/`` package is ordinary
    production code.
    """
    return bool(_TEST_CODE_PATH.search(_normalize(path)))


def is_collection_channel_path(path: str) -> bool:
    """True for a file that can change which tests run, or whether they run."""
    return bool(_COLLECTION_CHANNEL.search(_normalize(path)))


def is_production_path(path: str) -> bool:
    """True when changing ``path`` changes the code under test.

    Neither test CODE (the strict matcher — this predicate gates merges, and a
    false positive costs a real one) nor a collection channel. A story whose
    whole diff is test files plus ``pyproject.toml`` changed no production code,
    however many lines it moved.
    """
    norm = _normalize(path)
    if not norm:
        return False
    return not is_test_code_path(norm) and not is_collection_channel_path(norm)


def production_paths(paths: list[str]) -> list[str]:
    """The subset of ``paths`` that is production code, order preserved."""
    return [p for p in paths if is_production_path(p)]


def _diff_target_paths(patch: str) -> list[str]:
    """Extract the list of file paths a unified diff touches.

    Strips the ``a/`` / ``b/`` prefixes ``git diff`` emits, and dedupes
    while preserving order so callers can present a stable list to the
    operator.

    Moved from ``factory/chain/factory_improver_apply.py`` (deleted
    2026-08-07 along with the L2/L4 self-improvement tiers) — this is the one
    remaining place that turns a raw unified diff into a path list, consumed
    by ``factory.manager.staging`` and the ``auto_merge`` self-edit guard.
    """
    paths: list[str] = []
    seen: set[str] = set()

    def _add(raw: str) -> None:
        p = raw
        if p.startswith("a/") or p.startswith("b/"):
            p = p[2:]
        if p and p != "/dev/null" and p not in seen:
            seen.add(p)
            paths.append(p)

    for line in patch.splitlines():
        if line.startswith("diff --git "):
            # ``diff --git a/path/to/file b/path/to/file``
            # Extract BOTH the a/ (source) AND b/ (destination) sides. A pure
            # 100%-similarity rename carries NO ``+++`` hunk header, so the
            # destination path lives ONLY on this line — e.g. a rename INTO
            # factory/ (``diff --git a/apps/x.py b/factory/evil.py``) would
            # otherwise be seen only as ``apps/x.py`` and evade the self-edit /
            # forbidden-path detection that both the staging gate and the
            # forbidden guard rely on.
            parts = line.split()
            if len(parts) >= 4:
                _add(parts[2])  # a/ (source)
                _add(parts[3])  # b/ (destination — the rename/copy target)
        elif line.startswith("+++ ") and not line.startswith("+++ /dev/null"):
            _add(line[4:].strip())
    return paths
