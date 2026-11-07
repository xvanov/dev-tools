"""Diff-scoped mutation scoring — the rewrite of the ablation branch.

Each test here corresponds to one of the four defects the old
``tests_meaningful`` ablation branch had. All four were reproduced against the
old code before it was deleted; the reproductions are recorded in the module
docstring of ``factory/chain/gates/tests_meaningful.py``. These tests pin the
behaviour that replaced them, so a regression cannot re-open any of them
silently.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from factory.chain import mutation
from factory.chain.mutation import (
    GREEN,
    INFRA,
    RED,
    STATUS_BASELINE_INFRA,
    STATUS_BASELINE_RED,
    STATUS_MEASURED,
    STATUS_NO_REPO,
    STATUS_NO_SYMBOLS,
    STATUS_NO_TEST_COMMAND,
    _run_suite,
    cache_path,
    measure,
    mutate_source,
    select_symbols,
)

PY = sys.executable
PYTEST_CMD = f"{PY} -m pytest -q"


# --------------------------------------------------------------------------- #
# Fixtures: real two-commit git repos
# --------------------------------------------------------------------------- #


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=str(repo), capture_output=True, text=True, check=True
    )
    return proc.stdout


def _init(repo: Path) -> None:
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "commit.gpgsign", "false")


_Z_LAST_OLD = (
    "def target():\n"
    "    # CANARY-COMMENT do not strip me\n"
    "    return 'old'\n"
    "\n\n"
    "def untouched():\n"
    "    return 0\n"
)
_Z_LAST_NEW = _Z_LAST_OLD.replace("'old'", "'new'")


def _repo(
    tmp_path: Path,
    *,
    exercised: bool = True,
    red: bool = False,
) -> tuple[Path, str]:
    """A repo shaped like the ``e13d98e0`` case: the diff touches ONE symbol in
    the alphabetically-LAST file, while the alphabetically-FIRST file is
    untouched and full of public symbols.

    ``exercised`` controls whether the suite asserts on the touched symbol —
    i.e. whether its mutant should be killed or survive.
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "conftest.py").write_text("", encoding="utf-8")
    (repo / "a_first.py").write_text(
        "\n\n".join(f"def alpha{i}():\n    return {i}" for i in range(1, 7)) + "\n",
        encoding="utf-8",
    )
    (repo / "z_last.py").write_text(_Z_LAST_OLD, encoding="utf-8")
    (repo / "tests").mkdir()
    body = [
        "from a_first import alpha1, alpha2, alpha3, alpha4, alpha5, alpha6",
        "from z_last import target, untouched",
        "",
        "def test_alphas():",
        "    assert [alpha1(), alpha2(), alpha3(), alpha4(), alpha5(), alpha6()] == "
        "[1, 2, 3, 4, 5, 6]",
        "",
        "def test_untouched():",
        "    assert untouched() == 0",
    ]
    if exercised:
        body += ["", "def test_target():", "    assert target() == 'new'"]
    else:
        # Imports the symbol (so the module loads) but never calls it.
        body += ["", "def test_target_is_importable():", "    assert callable(target)"]
    if red:
        body += ["", "def test_broken():", "    assert False"]
    (repo / "tests" / "test_all.py").write_text("\n".join(body) + "\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "story")

    # HEAD commit: change ONLY z_last.target's body.
    (repo / "z_last.py").write_text(_Z_LAST_NEW, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    return repo, _git(repo, "rev-parse", "HEAD").strip()


def _measure(
    repo: Path,
    head: str,
    tmp_path: Path,
    test_command: str = PYTEST_CMD,
    **kwargs: object,
) -> mutation.MutationReport:
    return measure(
        repo_root=repo,
        head_sha=head,
        base_branch="main",
        test_command=test_command,
        app="toy",
        software_factory_root=tmp_path / "factory-root",
        **kwargs,  # type: ignore[arg-type]
    )


# --------------------------------------------------------------------------- #
# Defect 1 — selection must follow the diff
# --------------------------------------------------------------------------- #


def test_selection_is_scoped_to_the_diff_hunks(tmp_path: Path) -> None:
    """The old selector enumerated every public symbol of every changed file and
    took the first five by ``(path, lineno)`` — on this fixture:
    ``a_first.py::alpha1..alpha5``, zero overlap with what changed."""
    repo, head = _repo(tmp_path)
    selection = select_symbols(repo, "main", head)
    assert selection is not None
    sample, candidates, _notes = selection
    assert [s.key for s in sample] == ["z_last.py::target"]
    assert candidates == 1


def test_selection_ignores_test_code_and_collection_channels(tmp_path: Path) -> None:
    """Path classification is delegated to ``factory.diff_paths``; a diff in a
    test file or in ``pyproject.toml`` yields no ablation candidate."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "tests").mkdir()
    (repo / "tests" / "test_x.py").write_text("def test_a():\n    assert True\n", encoding="utf-8")
    (repo / "conftest.py").write_text("def pytest_configure(config):\n    return None\n", "utf-8")
    (repo / "pyproject.toml").write_text("[tool.x]\na = 1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "story")
    (repo / "tests" / "test_x.py").write_text(
        "def test_a():\n    assert 1 == 1\n", encoding="utf-8"
    )
    (repo / "conftest.py").write_text(
        "def pytest_configure(config):\n    return True\n", encoding="utf-8"
    )
    (repo / "pyproject.toml").write_text("[tool.x]\na = 2\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    head = _git(repo, "rev-parse", "HEAD").strip()

    selection = select_symbols(repo, "main", head)
    assert selection is not None
    sample, candidates, _notes = selection
    assert sample == [] and candidates == 0


def test_selection_skips_bodies_that_are_already_no_ops(tmp_path: Path) -> None:
    """An ``...``/``pass``/``raise NotImplementedError`` body produces a mutant
    identical to the original — the suite CANNOT go red, so reporting it
    "survived" would be a finding from a measurement that never happened."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "m.py").write_text("def stub():\n    ...\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "story")
    (repo / "m.py").write_text(
        "def stub():\n    ...\n\n\ndef real():\n    return 1\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    head = _git(repo, "rev-parse", "HEAD").strip()

    (repo / "m.py").write_text(
        "def stub():\n    pass\n\n\ndef real():\n    return 1\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head2")
    head = _git(repo, "rev-parse", "HEAD").strip()

    selection = select_symbols(repo, "main", head)
    assert selection is not None
    sample, _candidates, notes = selection
    assert [s.key for s in sample] == ["m.py::real"]
    assert any("equivalent mutant" in n for n in notes)


def test_selection_ranks_the_most_changed_symbol_first(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "m.py").write_text(
        "def small():\n    return 1\n\n\ndef big():\n    return 2\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "story")
    (repo / "m.py").write_text(
        "def small():\n    return 11\n\n\ndef big():\n"
        + "".join(f"    x{i} = {i}\n" for i in range(8))
        + "    return 22\n",
        encoding="utf-8",
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    head = _git(repo, "rev-parse", "HEAD").strip()

    selection = select_symbols(repo, "main", head, max_symbols=1)
    assert selection is not None
    sample, candidates, _notes = selection
    assert [s.key for s in sample] == ["m.py::big"]
    assert candidates == 2


# --------------------------------------------------------------------------- #
# Defect 2 — no green baseline, and infra read as "exercised"
# --------------------------------------------------------------------------- #


def test_broken_test_command_never_certifies_coverage(tmp_path: Path) -> None:
    """The old gate answered "ablation: all 2 sampled symbol(s) exercised by
    tests" when ``test_command`` was a nonexistent binary."""
    repo, head = _repo(tmp_path)
    report = _measure(repo, head, tmp_path, test_command="definitely-not-a-command-xyz")
    assert report.status == STATUS_BASELINE_INFRA
    assert report.score is None
    assert report.baseline == INFRA
    assert report.killed == [] and report.survived == []


def test_an_already_red_suite_never_certifies_coverage(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path, red=True)
    report = _measure(repo, head, tmp_path)
    assert report.status == STATUS_BASELINE_RED
    assert report.score is None
    assert "baseline suite is red" in report.reason


def test_pytest_internal_error_is_infra_not_a_red(tmp_path: Path) -> None:
    """pytest exits 2/3/4/5 for interrupted / internal error / usage error / no
    tests collected. None of those is a test failure, and none may read as
    "the suite noticed"."""
    repo, head = _repo(tmp_path)
    report = _measure(repo, head, tmp_path, test_command="exit 5")
    assert report.status == STATUS_BASELINE_INFRA
    assert report.score is None


def test_a_timeout_is_infra_not_a_red(tmp_path: Path) -> None:
    """``_run_pytest`` returned ``False`` on a 600 s timeout, indistinguishable
    from a genuine failure. Three outcomes, not two."""
    outcome, output = _run_suite(tmp_path, f"{PY} -c \"import time; time.sleep(30)\"", 1)
    assert outcome == INFRA
    assert "timed out" in output


def test_run_suite_distinguishes_green_red_infra(tmp_path: Path) -> None:
    assert _run_suite(tmp_path, "exit 0", 30)[0] == GREEN
    assert _run_suite(tmp_path, "exit 1", 30)[0] == RED
    assert _run_suite(tmp_path, "exit 127", 30)[0] == INFRA


def test_a_red_we_cannot_attribute_is_skipped_not_killed(tmp_path: Path) -> None:
    """A run that goes red for a reason other than the mutation must not be
    scored as a kill. Here the second invocation of the "suite" fails without
    ever importing the mutated module."""
    repo, head = _repo(tmp_path)
    counter = tmp_path / "invocations"
    cmd = (
        f'{PY} -c "import pathlib,sys; p=pathlib.Path({str(counter)!r}); '
        "n=int(p.read_text()) if p.exists() else 0; p.write_text(str(n + 1)); "
        'sys.exit(1 if n >= 1 else 0)"'
    )
    report = _measure(repo, head, tmp_path, test_command=cmd)
    assert report.status == STATUS_MEASURED
    assert report.baseline == GREEN
    assert report.killed == [] and report.survived == []
    assert report.score is None
    assert any("not attributable" in s["why"] for s in report.skipped)


# --------------------------------------------------------------------------- #
# Defect 3 — the live checkout must never be written to
# --------------------------------------------------------------------------- #


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
        if p.is_file() and ".git" not in p.parts
    }


def test_the_source_checkout_is_never_written_to(tmp_path: Path) -> None:
    """The old branch mutated ``repo_root`` — the very checkout the chain pushes
    from — and restored it in a ``finally``. Nothing outside the scratch tree
    may be touched at all, not even its mtimes."""
    repo, head = _repo(tmp_path)
    seen = tmp_path / "seen.py"
    cmd = (
        f'{PY} -c "import shutil; shutil.copy(\'z_last.py\', {str(seen)!r})"'
        f" && {PYTEST_CMD}"
    )
    before = _snapshot(repo)
    report = _measure(repo, head, tmp_path, test_command=cmd)
    assert _snapshot(repo) == before, "the source checkout was written to"

    # ...and the mutation really did reach the suite, in the scratch tree.
    assert seen.exists(), "the suite never ran"
    mutated = seen.read_text(encoding="utf-8")
    assert "NotImplementedError" in mutated
    # Defect 3's other half: the ast.unparse round-trip stripped every comment.
    assert "CANARY-COMMENT" in mutated, "the mutation stripped comments"
    assert report.tree_source.startswith("git-clone")


def test_mutate_source_only_rewrites_the_target_body() -> None:
    source = (
        "import os  # keep me\n"
        "\n\n"
        "def before():\n"
        "    return 1  # also keep me\n"
        "\n\n"
        "class Widget:\n"
        "    # a comment inside the class\n"
        "    def render(self):\n"
        "        # the body we replace\n"
        "        return 'x'\n"
        "\n"
        "    def other(self):\n"
        "        return 'y'\n"
    )
    out = mutate_source(source, "Widget.render", sentinel=Path("/tmp/sentinel"))
    assert out is not None
    assert "import os  # keep me" in out
    assert "return 1  # also keep me" in out
    assert "# a comment inside the class" in out
    assert "def other(self):\n        return 'y'" in out
    # Only STATEMENTS are replaced, so a comment leading the body survives too —
    # the point is that nothing outside the target's statements is rewritten.
    assert "# the body we replace" in out
    assert "return 'x'" not in out
    assert "NotImplementedError('FACTORY_ABLATION Widget.render')" in out
    # Still valid Python and still the same set of definitions.
    import ast

    tree = ast.parse(out)
    assert [n.name for n in tree.body if hasattr(n, "name")] == ["before", "Widget"]


def test_mutate_source_handles_a_one_line_def() -> None:
    out = mutate_source("def f(): return 1\n", "f", sentinel=Path("/tmp/s"))
    assert out is not None and out.startswith("def f(): __import__")
    import ast

    ast.parse(out)


def test_mutate_source_returns_none_for_an_unknown_symbol() -> None:
    assert mutate_source("def f():\n    return 1\n", "nope", sentinel=Path("/tmp/s")) is None


# --------------------------------------------------------------------------- #
# The measurement itself
# --------------------------------------------------------------------------- #


def test_an_unexercised_symbol_survives_and_scores_zero(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path, exercised=False)
    report = _measure(repo, head, tmp_path)
    assert report.status == STATUS_MEASURED
    assert report.baseline == GREEN
    assert report.survived == ["z_last.py::target"]
    assert report.killed == []
    assert report.score == 0.0


def test_an_exercised_symbol_is_killed_and_scores_one(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path, exercised=True)
    report = _measure(repo, head, tmp_path)
    assert report.status == STATUS_MEASURED
    assert report.killed == ["z_last.py::target"]
    assert report.survived == []
    assert report.score == 1.0


def test_survived_says_whether_the_symbol_was_even_reached(tmp_path: Path) -> None:
    """"Never invoked" and "invoked but not asserted on" are different kinds of
    illusory coverage; the sentinel tells them apart."""
    repo, head = _repo(tmp_path, exercised=False)
    report = _measure(repo, head, tmp_path)
    assert report.survived == ["z_last.py::target"]
    cached = json.loads(cache_path(tmp_path / "factory-root", "toy", head).read_text())
    assert cached["symbols"]["z_last.py::target"]["detail"] == "never invoked by the suite"


def test_no_symbols_when_the_diff_touches_no_production_code(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    _git(repo, "checkout", "-q", "main")
    _git(repo, "checkout", "-qb", "docs")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "docs")
    head = _git(repo, "rev-parse", "HEAD").strip()
    report = _measure(repo, head, tmp_path)
    assert report.status == STATUS_NO_SYMBOLS
    assert report.score is None


def test_missing_preconditions_are_reported_not_guessed(tmp_path: Path) -> None:
    assert (
        measure(
            repo_root=None, head_sha="x", base_branch="main", test_command="pytest"
        ).status
        == STATUS_NO_REPO
    )
    assert (
        measure(
            repo_root=tmp_path, head_sha="x", base_branch="main", test_command=None
        ).status
        == STATUS_NO_TEST_COMMAND
    )


def test_head_sha_that_does_not_resolve_falls_back_and_says_so(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    report = _measure(repo, "deadbeef" * 5, tmp_path)
    assert any("used HEAD" in n for n in report.notes)
    assert report.status == STATUS_MEASURED
    # ...and it reports the sha it ACTUALLY measured, not the one asked for.
    assert report.head_sha == head


def test_an_unresolvable_head_never_shares_a_cache_bucket(tmp_path: Path) -> None:
    """MEASURED on the first clean real run: with no ``--head``, the cache was
    written to ``state/mutation/factory/unknown.json``. Two different commits
    would then share one bucket and a measurement of A would be served as a
    measurement of B."""
    repo, head = _repo(tmp_path)
    report = _measure(repo, "", tmp_path)  # no head_sha supplied
    assert report.head_sha == head
    root = tmp_path / "factory-root"
    assert cache_path(root, "toy", head).is_file()
    assert not (root / "state" / "mutation" / "toy" / "unknown.json").exists()


# --------------------------------------------------------------------------- #
# The cache — without it the gate could not be afforded at all
# --------------------------------------------------------------------------- #


def test_the_cache_makes_a_second_measurement_free(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    first = _measure(repo, head, tmp_path)
    assert first.cache_hits == 0
    assert first.tree_source.startswith("git-clone")

    cache_file = cache_path(tmp_path / "factory-root", "toy", head)
    assert cache_file.is_file()
    stored = json.loads(cache_file.read_text(encoding="utf-8"))
    assert stored["symbols"]["z_last.py::target"]["outcome"] == "killed"

    started = time.monotonic()
    second = _measure(repo, head, tmp_path)
    elapsed = time.monotonic() - started
    assert second.cache_hits == 1
    assert second.tree_source == "cache"
    assert second.score == first.score
    # No tree materialized and no suite run: the whole point of the cache.
    assert elapsed < first.elapsed_s


def test_the_cache_is_keyed_on_the_head_sha(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    _measure(repo, head, tmp_path)
    (repo / "z_last.py").write_text(_Z_LAST_NEW + "\n# another change\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head2")
    head2 = _git(repo, "rev-parse", "HEAD").strip()
    report = _measure(repo, head2, tmp_path)
    assert report.cache_hits == 0, "a new commit must be re-measured"


def test_a_non_green_baseline_never_populates_the_cache(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path, red=True)
    report = _measure(repo, head, tmp_path)
    assert report.status == STATUS_BASELINE_RED
    assert not cache_path(tmp_path / "factory-root", "toy", head).exists()


def test_a_changed_test_command_invalidates_the_cache(tmp_path: Path) -> None:
    """An outcome is a fact about ``(tree, symbol, test command)``. Keying the
    cache on the SHA alone would let a ``test_command`` change re-publish
    outcomes the new command never produced."""
    repo, head = _repo(tmp_path)
    first = _measure(repo, head, tmp_path)
    assert first.score == 1.0

    # Same SHA, different command — and a command that cannot measure anything.
    second = _measure(repo, head, tmp_path, test_command="exit 5")
    assert second.cache_hits == 0
    assert second.status == STATUS_BASELINE_INFRA
    assert second.score is None


def test_no_cache_forces_a_re_measurement(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    _measure(repo, head, tmp_path)
    report = _measure(repo, head, tmp_path, use_cache=False)
    assert report.cache_hits == 0
    assert report.score == 1.0


def test_the_budget_truncates_instead_of_blocking(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    report = _measure(repo, head, tmp_path, budget_s=0)
    assert report.budget_exhausted
    assert report.score is None
    assert report.skipped == [{"symbol": "z_last.py::target", "why": "budget_exhausted"}]


# --------------------------------------------------------------------------- #
# Coupling that must fail loudly rather than degrade
# --------------------------------------------------------------------------- #


def test_the_base_ref_resolver_is_the_chain_s_own(tmp_path: Path) -> None:
    """``_resolve_base_ref`` deliberately imports the chain's single
    implementation instead of growing a second copy. The import is not
    defensive: if it is renamed, this fails loudly here rather than turning
    every measurement into a silent ``skipped``."""
    from factory.chain.handlers import _resolve_diff_base  # noqa: F401

    repo, _head = _repo(tmp_path)
    assert mutation._resolve_base_ref(repo, "main") == "main"
    assert mutation._resolve_base_ref(repo, "no-such-branch") is None


# The ONLY names a gate may reach in this module. ``check_can_fail`` answers a
# boolean about ONE check and is used in the safe direction only (True can lift a
# block; False leaves it in place) — ``gates/acceptance_verified`` calls it as the
# fallback route to oracle failability. ``select_symbols`` is pure diff→symbol
# mapping and exists here so the gate does not grow a second copy.
#
# Everything else — ``measure``, ``MutationReport``, the score, the cache — stays
# unreachable from a merge decision. THAT is the advisory guarantee, and it is
# what this test defends now that the module is no longer gate-free.
_GATE_ALLOWED_MUTATION_NAMES = frozenset({"check_can_fail", "select_symbols"})


def test_gates_reach_only_the_failability_seam_of_the_mutation_module() -> None:
    """No merge decision may reach the mutation SCORE.

    This test used to assert that no gate imports this module at all. That claim
    died on 2026-08-05, deliberately: ``gates/acceptance_verified`` composes
    ``check_can_fail`` as the fallback route to "can this oracle fail?" when the
    merge-base run gives no usable answer. The guarantee worth defending was never
    "no import", it was **"no gate can turn a mutation score into a merge
    verdict"** — so the test now enforces an ALLOWLIST of reachable names rather
    than a ban on the module, and a drive-by ``from ..mutation import measure``
    still fails here.

    Deliberately over-inclusive in the same ways as before: recursive over the
    package, and AST-based, so every import spelling is caught. It additionally
    walks attribute access, because ``mutation.measure(...)`` after a bare
    ``from factory.chain import mutation`` is the form the allowlist has to catch.
    """
    import ast as _ast

    gates_dir = Path(mutation.__file__).parent / "gates"
    files = sorted(gates_dir.rglob("*.py"))
    assert files, "gates package not found — this guarantee would be vacuous"

    offenders: list[str] = []
    for path in files:
        tree = _ast.parse(path.read_text(encoding="utf-8"))
        module_aliases: set[str] = set()
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Import):
                for a in node.names:
                    if a.name.endswith("chain.mutation"):
                        module_aliases.add(a.asname or a.name)
            elif isinstance(node, _ast.ImportFrom):
                mod = node.module or ""
                if mod.endswith("mutation"):  # covers ``from ..mutation import x``
                    # ``from …mutation import X`` — X must be on the allowlist.
                    offenders.extend(
                        f"{path.name}:{node.lineno}: from-import {a.name!r}"
                        for a in node.names
                        if a.name not in _GATE_ALLOWED_MUTATION_NAMES
                    )
                for a in node.names:
                    if a.name == "mutation":
                        module_aliases.add(a.asname or "mutation")
        if not module_aliases:
            continue
        # ``mutation.<name>`` — every attribute touched must be on the allowlist.
        for node in _ast.walk(tree):
            if (
                isinstance(node, _ast.Attribute)
                and isinstance(node.value, _ast.Name)
                and node.value.id in module_aliases
                and node.attr not in _GATE_ALLOWED_MUTATION_NAMES
            ):
                offenders.append(f"{path.name}:{node.lineno}: mutation.{node.attr}")
    assert offenders == [], f"gates reaching the mutation measurement: {offenders}"


def test_the_gates_allowlist_is_not_vacuous() -> None:
    """The allowlist only means something if the gate really does reach this module
    — otherwise the test above would pass on an empty set forever, which is how
    the ``tests-meaningful`` ablation branch sat broken and unnoticed for months.
    """
    import ast as _ast

    src = (Path(mutation.__file__).parent / "gates" / "acceptance_verified.py").read_text(
        encoding="utf-8"
    )
    tree = _ast.parse(src)
    reached = {
        n.attr
        for n in _ast.walk(tree)
        if isinstance(n, _ast.Attribute)
        and isinstance(n.value, _ast.Name)
        and n.value.id == "mutation"
    }
    assert "check_can_fail" in reached, (
        "the acceptance gate no longer calls mutation.check_can_fail — either the "
        "composition was reverted (then delete the allowlist) or it was renamed"
    )


def test_the_gate_score_detector_actually_detects(tmp_path: Path) -> None:
    """A guard that cannot fail is the bug this whole module treats. Proves the
    detector's teeth on every spelling of a reach at the SCORE, and proves it stays
    quiet for the two allowlisted seam names."""
    import ast as _ast

    def _offenders(source: str) -> list[str]:
        tree = _ast.parse(source)
        found: list[str] = []
        aliases: set[str] = set()
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Import):
                for a in node.names:
                    if a.name.endswith("chain.mutation"):
                        aliases.add(a.asname or a.name)
            elif isinstance(node, _ast.ImportFrom):
                mod = node.module or ""
                if mod.endswith("mutation"):  # covers ``from ..mutation import x``
                    found.extend(
                        a.name
                        for a in node.names
                        if a.name not in _GATE_ALLOWED_MUTATION_NAMES
                    )
                for a in node.names:
                    if a.name == "mutation":
                        aliases.add(a.asname or "mutation")
        for node in _ast.walk(tree):
            if (
                isinstance(node, _ast.Attribute)
                and isinstance(node.value, _ast.Name)
                and node.value.id in aliases
                and node.attr not in _GATE_ALLOWED_MUTATION_NAMES
            ):
                found.append(node.attr)
        return found

    caught = [
        "from factory.chain.mutation import measure",
        "from ..mutation import measure",
        "from factory.chain import mutation\nmutation.measure(x)",
        "from . import mutation\nmutation.MutationReport()",
        "import factory.chain.mutation as m\nm.cache_path(a, b, c)",
        "from factory.chain import mutation as mu\nmu.measure(x)",
    ]
    for form in caught:
        assert _offenders(form), form

    allowed = [
        "from factory.chain.mutation import check_can_fail",
        "from factory.chain import mutation\nmutation.check_can_fail(**kw)",
        "from factory.chain import mutation\nmutation.select_symbols(a, b, c)",
        "from factory.chain.gates.evaluator import GateResult",
    ]
    for form in allowed:
        assert _offenders(form) == [], form


@pytest.mark.parametrize("status", [STATUS_BASELINE_RED, STATUS_BASELINE_INFRA])
def test_skipped_statuses_never_carry_a_score(status: str) -> None:
    report = mutation.MutationReport(status=status, reason="x")
    assert report.score is None
    assert not report.measured


# --------------------------------------------------------------------------- #
# What the adversarial pass found
# --------------------------------------------------------------------------- #


def test_a_stale_sentinel_cannot_manufacture_a_kill(tmp_path: Path) -> None:
    """The sentinel is the evidence that a red run is attributable to the
    mutation. A leftover file with that name must not be usable as evidence, so
    each run clears it first."""
    repo, head = _repo(tmp_path, exercised=False)
    sentinels = tmp_path / "sentinels"
    sentinels.mkdir()
    sym = mutation.Symbol(path="z_last.py", qualname="target", lineno=1, touched_lines=1)
    import hashlib

    stale = sentinels / f"FACTORY_ABLATION-{hashlib.sha1(sym.key.encode()).hexdigest()[:12]}"
    stale.write_text("stale", encoding="utf-8")

    outcome, _dirty = mutation._ablate_one(repo, sym, PYTEST_CMD, sentinels, 120)
    # The symbol is never called, so the suite stays green: "survived", and the
    # detail must say it was never invoked despite the pre-existing file.
    assert outcome["outcome"] == "survived"
    assert outcome["detail"] == "never invoked by the suite"


def test_attribution_requires_the_symbol_name_not_just_the_marker(tmp_path: Path) -> None:
    """Measuring this repo puts this module's own source — which contains the
    literal marker — inside the tree under test. Attribution therefore matches
    the full ``FACTORY_ABLATION <qualname>`` message, so a traceback that merely
    quotes the marker cannot buy a kill."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "z_last.py").write_text(_Z_LAST_NEW, encoding="utf-8")
    sentinels = tmp_path / "s"
    sentinels.mkdir()
    sym = mutation.Symbol(path="z_last.py", qualname="target", lineno=1, touched_lines=1)
    # A "suite" that fails while printing the bare marker and never running the
    # mutated code.
    cmd = f"{PY} -c \"print('FACTORY_ABLATION appears in our own source'); raise SystemExit(1)\""
    outcome, _dirty = mutation._ablate_one(repo, sym, cmd, sentinels, 120)
    assert outcome["outcome"] == "skipped"
    assert "not attributable" in outcome["detail"]


def test_a_duplicate_definition_is_measured_once(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "m.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "story")
    (repo / "m.py").write_text(
        "def f():\n    return 2\n\n\ndef f():\n    return 3\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    head = _git(repo, "rev-parse", "HEAD").strip()

    selection = select_symbols(repo, "main", head)
    assert selection is not None
    sample, candidates, notes = selection
    assert [s.key for s in sample] == ["m.py::f"]
    assert candidates == 1
    assert any("duplicate definition" in n for n in notes)


def test_uv_is_exposed_without_restoring_the_callers_venv_bin(tmp_path: Path) -> None:
    """``uv`` must resolve, but never by putting its parent directory back: on a
    machine where ``uv`` lives inside the caller's virtualenv, that directory also
    holds ``pytest`` and restoring it re-opens the leak. So the fallback is a shim
    holding a link to the ONE executable."""
    fake_venv_bin = tmp_path / "caller" / ".venv" / "bin"
    fake_venv_bin.mkdir(parents=True)
    for name in ("uv", "pytest"):
        exe = fake_venv_bin / name
        exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        exe.chmod(0o755)

    tree = tmp_path / "scratch" / "repo"
    tree.mkdir(parents=True)
    env = mutation._mutant_env(tree)
    entries = env["PATH"].split(":")
    assert str(fake_venv_bin) not in entries, "the caller's venv bin was restored"
    # Whatever uv resolves to on this machine, pytest must NOT come from a venv
    # outside the scratch tree.
    resolved_pytest = shutil.which("pytest", path=env["PATH"])
    if resolved_pytest is not None:
        parts = Path(resolved_pytest).resolve().parts
        assert not any(p in {".venv", "venv", "virtualenv"} for p in parts), resolved_pytest


def test_the_uv_shim_exposes_only_uv(tmp_path: Path) -> None:
    venv_bin = tmp_path / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "uv").write_text("", encoding="utf-8")
    (venv_bin / "pytest").write_text("", encoding="utf-8")
    tree = tmp_path / "scratch" / "repo"
    tree.mkdir(parents=True)

    shim = mutation._uv_shim_dir(tree, venv_bin / "uv")
    assert shim is not None
    assert [p.name for p in shim.iterdir()] == ["uv"]
    assert shutil.which("pytest", path=str(shim)) is None


def test_the_callers_virtualenv_is_unreachable_from_the_scratch_tree(tmp_path: Path) -> None:
    """The first real run of this tool ran
    ``<caller>/.venv/bin/python <caller>/.venv/bin/pytest`` with cwd inside the
    scratch tree, because ``uv run`` fell back to PATH for a runner its fresh
    project env did not have. That interpreter imports the CALLER's source, so
    the mutation is invisible and every mutant "survives"."""
    env = mutation._mutant_env(tmp_path)
    assert "VIRTUAL_ENV" not in env
    assert "PYTHONPATH" not in env
    outside_venv_bins = [
        entry
        for entry in env["PATH"].split(":")
        if any(
            part in {".venv", "venv", "virtualenv", "site-packages"}
            for part in Path(entry).parts
        )
        and not entry.startswith(str(tmp_path.resolve()))
    ]
    assert outside_venv_bins == [], outside_venv_bins
    # ...and the command an app actually declares can still find its driver,
    # however uv happens to be installed on this machine.
    assert shutil.which("uv", path=env["PATH"]) is not None


def test_a_survived_verdict_is_withdrawn_when_the_suite_reads_another_tree(
    tmp_path: Path,
) -> None:
    """The ambiguity the provenance probe exists to remove: a suite that does not
    import the mutated file is green for every mutant, which is
    indistinguishable from tests that simply never assert on it."""
    repo, head = _repo(tmp_path, exercised=False)
    # A "suite" that passes without ever reading the repo it runs in.
    report = _measure(repo, head, tmp_path, test_command="exit 0")
    assert report.status == STATUS_MEASURED
    assert report.baseline == GREEN
    assert report.survived == [], "a survived verdict was published for an unread tree"
    assert report.score is None
    assert any("provenance probe stayed green" in s["why"] for s in report.skipped)
    assert any("provenance failed" in n for n in report.notes)


def test_provenance_is_not_probed_when_something_was_killed(tmp_path: Path) -> None:
    """A kill already proves the suite reads the tree, so the extra suite run is
    not spent."""
    repo, head = _repo(tmp_path, exercised=True)
    report = _measure(repo, head, tmp_path)
    assert report.killed == ["z_last.py::target"]
    assert not any("provenance" in n for n in report.notes)


def test_a_genuine_unexercised_symbol_survives_the_probe(tmp_path: Path) -> None:
    """The probe must not swallow real findings: here the suite DOES import the
    file (it imports the symbol without calling it), so the ``survived`` verdict
    stands."""
    repo, head = _repo(tmp_path, exercised=False)
    report = _measure(repo, head, tmp_path)
    assert report.survived == ["z_last.py::target"]
    assert report.score == 0.0
    assert any("provenance ok" in n for n in report.notes)
    stored = json.loads(cache_path(tmp_path / "factory-root", "toy", head).read_text())
    assert stored["provenance"] == {"z_last.py": "ok"}


# --------------------------------------------------------------------------- #
# check_can_fail — the "does this check carry information" seam
# --------------------------------------------------------------------------- #


def test_check_can_fail_proves_a_real_check(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path, exercised=True)
    proven, detail = mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="target",
        check_command=f"{PY} -m pytest -q tests/test_all.py::test_target",
        timeout_s=120,
    )
    assert proven, detail
    assert "went red" in detail


def test_check_can_fail_rejects_a_check_that_cannot_fail(tmp_path: Path) -> None:
    """The acceptance-oracle hole in one assertion: a check of
    ``def test_x(): assert True`` passes, reports "1 passed", and proves
    nothing."""
    repo, head = _repo(tmp_path, exercised=True)
    (repo / "tests" / "test_vacuous.py").write_text(
        "def test_x():\n    assert True\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "vacuous oracle")
    head = _git(repo, "rev-parse", "HEAD").strip()

    proven, detail = mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="target",
        check_command=f"{PY} -m pytest -q tests/test_vacuous.py",
        timeout_s=120,
    )
    assert not proven
    assert "stayed green" in detail


def test_check_can_fail_never_returns_true_on_infrastructure_failure(tmp_path: Path) -> None:
    """"Could not prove it" must never read as "it can". A caller on the merge
    path has to be able to treat False as blocking."""
    repo, head = _repo(tmp_path)
    proven, detail = mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="target",
        check_command="definitely-not-a-command-xyz",
        timeout_s=60,
    )
    assert not proven
    # The baseline catches it before any mutation, and says which state it saw.
    assert "the check is infra, not green" in detail

    proven2, detail2 = mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="no_such_symbol",
        check_command=f"{PY} -m pytest -q",
        timeout_s=60,
    )
    assert not proven2
    assert "could not be mutated" in detail2


def test_check_can_fail_requires_a_green_check_first(tmp_path: Path) -> None:
    """Without a baseline, an ALREADY-RED check "goes red" under any mutation and
    would be certified as able to fail. ``True`` is the permissive answer here, so
    this is the fail-open direction."""
    repo, head = _repo(tmp_path, exercised=True)
    (repo / "tests" / "test_broken_oracle.py").write_text(
        "def test_oracle():\n    assert False\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "broken oracle")
    head = _git(repo, "rev-parse", "HEAD").strip()

    proven, detail = mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="target",
        check_command=f"{PY} -m pytest -q tests/test_broken_oracle.py",
        timeout_s=120,
    )
    assert not proven
    assert "not green, BEFORE any mutation" in detail


def test_check_can_fail_prepare_hook_can_inject_the_check_being_measured(
    tmp_path: Path,
) -> None:
    """``prepare`` exists because the acceptance oracle is not in the repo at all —
    it is a hidden file the gate copies into the tree. A check that does not exist
    until ``prepare`` runs must still be measurable."""
    repo, head = _repo(tmp_path, exercised=True)

    def _inject(tree: Path) -> None:
        (tree / "tests" / "test_hidden.py").write_text(
            "from z_last import target\n\ndef test_h():\n    assert target() == 'new'\n",
            encoding="utf-8",
        )

    proven, detail = mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="target",
        check_command=f"{PY} -m pytest -q tests/test_hidden.py",
        timeout_s=120,
        prepare=lambda tree: _inject(tree),  # type: ignore[func-returns-value]
    )
    assert proven, detail


def test_check_can_fail_treats_a_failed_or_raising_prepare_as_cannot_prove(
    tmp_path: Path,
) -> None:
    """A setup the caller could not complete is not evidence of failability. Both
    the reported error and an exception must land on ``False`` — a ``prepare`` that
    silently no-ops would measure a tree the caller never built."""
    repo, head = _repo(tmp_path, exercised=True)
    cmd = f"{PY} -m pytest -q tests/test_all.py::test_target"

    proven, detail = mutation.check_can_fail(
        repo_root=repo, head_ref=head, target_path="z_last.py", qualname="target",
        check_command=cmd, timeout_s=120,
        prepare=lambda _tree: "the collection channels could not be rolled back",
    )
    assert not proven
    assert "could not be set up" in detail
    assert "rolled back" in detail

    def _boom(_tree: Path) -> str | None:
        raise RuntimeError("disk gone")

    proven2, detail2 = mutation.check_can_fail(
        repo_root=repo, head_ref=head, target_path="z_last.py", qualname="target",
        check_command=cmd, timeout_s=120, prepare=_boom,
    )
    assert not proven2
    assert "RuntimeError: disk gone" in detail2


def test_check_can_fail_runs_the_check_in_the_requested_subdirectory(
    tmp_path: Path,
) -> None:
    """An app's harness is usually not rooted at the repo root — sacrifice's lives
    in ``backend/``. The MUTATION is still written relative to the tree root; only
    the command's cwd moves."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "backend").mkdir()
    (repo / "backend" / "mod.py").write_text("def target():\n    return 1\n", encoding="utf-8")
    (repo / "backend" / "tests").mkdir()
    (repo / "backend" / "tests" / "test_it.py").write_text(
        "from mod import target\n\ndef test_t():\n    assert target() == 1\n", encoding="utf-8"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    head = _git(repo, "rev-parse", "HEAD").strip()

    proven, detail = mutation.check_can_fail(
        repo_root=repo, head_ref=head,
        target_path="backend/mod.py", qualname="target",
        check_command=f"{PY} -m pytest -q tests/test_it.py",
        timeout_s=120, run_cwd="backend",
    )
    assert proven, detail


def test_check_can_fail_refuses_a_run_cwd_that_does_not_resolve(tmp_path: Path) -> None:
    """A cwd that escapes the clone or does not exist is a ``False``, never a
    silent fall back to the tree root: running the check somewhere other than
    where the caller asked measures a different thing, and "measured something
    else" must not be indistinguishable from "proven failable"."""
    repo, head = _repo(tmp_path, exercised=True)
    cmd = f"{PY} -m pytest -q"
    for bad in ("../escape", "no/such/dir"):
        proven, detail = mutation.check_can_fail(
            repo_root=repo, head_ref=head, target_path="z_last.py", qualname="target",
            check_command=cmd, timeout_s=60, run_cwd=bad,
        )
        assert not proven, bad
        assert "run_cwd" in detail


def test_check_can_fail_never_writes_to_the_source_checkout(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path)
    before = _snapshot(repo)
    mutation.check_can_fail(
        repo_root=repo,
        head_ref=head,
        target_path="z_last.py",
        qualname="target",
        check_command=f"{PY} -m pytest -q",
        timeout_s=120,
    )
    assert _snapshot(repo) == before


def test_changed_lines_outside_any_symbol_are_reported(tmp_path: Path) -> None:
    """Module-level code is not ablatable this way; the score must not read as
    "the whole diff is covered"."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _init(repo)
    (repo / "m.py").write_text("VALUE = 1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "story")
    (repo / "m.py").write_text("VALUE = 2\nOTHER = 3\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    head = _git(repo, "rev-parse", "HEAD").strip()

    selection = select_symbols(repo, "main", head)
    assert selection is not None
    sample, _candidates, notes = selection
    assert sample == []
    assert any("outside any ablatable symbol" in n for n in notes)
