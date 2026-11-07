"""Diff-scoped mutation scoring — a MEASUREMENT, deliberately not a merge gate.

What this answers
=================
"Do the tests in this diff actually catch a change to the code in this diff?"
For each symbol the diff *touched*, replace its body with a raise, re-run the
suite, and see whether the suite notices. Suite goes red ⇒ the mutant is
**killed** (the tests exercise and assert on the symbol). Suite stays green ⇒
the mutant **survived** (the "coverage" is illusory). The score is
``killed / (killed + survived)``.

Why it lives here and not in a gate
===================================
This code is the rewrite of the ablation branch that used to live inside the
REQUIRED ``tests-meaningful`` merge gate (``gates/tests_meaningful.py``), behind
``gates.mutation_testing``. That flag was the only thing between four defects
and every merge in the factory:

1. it ablated symbols the diff never touched (whole-file symbol enumeration,
   capped at 5, sorted by path — i.e. the top five of the alphabetically-first
   changed file);
2. it was fail-OPEN — a 600 s timeout, a missing command or an already-red
   suite all produced "suite did not stay green", which it read as
   "exercised → good", with no green baseline to rule any of that out;
3. it mutated the live ``state/worktrees/`` checkout the chain pushes from, via
   a whole-file ``ast.unparse`` round-trip (comments stripped), restoring in a
   ``finally`` that a SIGKILL does not run;
4. it returned ``passed=False`` in dry-run, which is the default.

The branch was deleted rather than re-wired: an advisory branch inside a
required gate is still one edit away from blocking merges, and there is no
measured case for gating on this number yet. See ``factory mutation-score`` for
the operator entry point.

⚠ WHAT IS AND IS NOT ON THE MERGE PATH (amended 2026-08-05)
===========================================================

This module's docstring used to claim that nothing in ``factory/chain/gates/``
imports it, so no merge decision could reach any of this code. **That is no
longer true, and the distinction matters:**

* the **SCORE** — ``measure`` / ``MutationReport`` / the cache / the CLI — is
  still reachable only from ``factory mutation-score``. No gate imports it, no
  merge decision reads a mutation score, and that stays the invariant.
* :func:`check_can_fail` **is** on the merge path: ``gates/acceptance_verified``
  calls it as the fallback route to "can this oracle fail at all?" when the
  merge-base run returns ``unknown``. It is a boolean about ONE check, not a
  score, and it is used in the safe direction only — ``True`` licenses crediting
  a green that would otherwise have been blocked; ``False`` leaves the block in
  place. Nothing that gate does can turn a mutation *score* into a merge verdict.

So the "advisory" property is now about the score, not about the module. Anyone
adding a second gate caller here must keep both halves of that sentence true.

How each defect is fixed here
=============================
* **Diff-scoped selection** (``select_symbols``): ``git diff -U0 base...head``
  hunks are mapped to the functions/methods whose source span contains them.
  Production-vs-test classification is delegated to ``factory.diff_paths`` —
  the one shared classifier — never re-defined here.
* **Green baseline** (``measure``): the suite must be GREEN in the throwaway
  tree before anything is mutated. Not green ⇒ ``skipped_baseline_red`` /
  ``skipped_baseline_infra``, with the output tail recorded. There is no path
  from a non-green baseline to a score.
* **Tri-state runs** (``_run_suite``): green / red / infra are distinct. Infra
  (timeout, command-not-found, pytest exit 2-5) is never read as "exercised".
* **Kill attribution**: the injected body touches a per-symbol sentinel file
  before raising, so "red" only counts as a kill when the mutation demonstrably
  ran. A red we cannot attribute to the mutation (a flake, an unrelated
  failure) is recorded as skipped, never as a kill.
* **Throwaway tree** (``_materialize_tree``): a ``git clone --local`` of the
  repo checked out at the graded SHA. The source checkout is never written to;
  correctness does not depend on the cleanup ``finally`` running, because the
  only thing the ``finally`` deletes is scratch. Stale trees from a killed
  process are reaped by age on the next run.
* **Mutation is a line splice**, not an ``ast.unparse`` round-trip: every byte
  outside the target body — comments included — survives.

Two defences the FIRST REAL RUN of this tool made necessary
==========================================================
Measuring the factory on its own diff found a way for the whole thing to be
green and meaningless, which the toy fixtures could not surface:

* **The caller's virtualenv leaked into the scratch tree.** ``uv run pytest -q``
  in a fresh clone installs only base dependencies (``pytest`` is a dev EXTRA),
  so ``uv`` resolved ``pytest`` from ``PATH`` — the calling process's venv — and
  ran that interpreter, whose editable install points at the CALLER's source.
  The mutation would have been invisible and every mutant would have "survived".
  ``_mutant_env`` now makes the caller's venv unreachable, so a command that
  cannot find its runner reports ``skipped`` instead.
* **A surviving mutant is ambiguous.** "The tests never assert on this" and "the
  suite is not importing the tree we mutated" both look like a green mutant.
  ``_provenance_probe`` breaks the file's syntax and re-runs: a suite that stays
  green is not reading the file, and every ``survived`` verdict for that file is
  withdrawn. It only runs where nothing was killed — a kill already proves it.

Interaction with the acceptance oracle's transient file
======================================================
``gates/acceptance_verified`` runs a hidden, spec-authored oracle test that exists
nowhere in the repo — which is why that gate must stay last in
``evaluate_all_gates``'s tuple (asserted by
``tests/test_gates_evaluation.py::test_H8_acceptance_gate_is_last_in_the_evaluator_tuple``),
so ``tests-meaningful`` can never score the oracle as one of the dev's tests.

The **score** cannot see the oracle at all: it operates on a ``git clone`` at a
COMMITTED sha, and selection reads file content through ``git show <ref>:<path>``
rather than off the working tree, so an uncommitted file cannot enter the clone,
the symbol selection, or the score. :func:`check_can_fail` deliberately CAN see
it — the gate's ``prepare`` hook copies the oracle into that function's own
scratch clone, because the whole question there is whether the oracle notices a
gutted symbol. Both stay outside the source checkout either way.

Cost and the cache
==================
One suite run per symbol plus one baseline. The factory's own suite is ~5m36s
warm, so five symbols is ~34 min uncached. Results are therefore cached per
``(head_sha, symbol)`` under ``state/mutation/<app>/<head_sha>.json``: a
re-measurement of the same SHA does no work and materializes no tree. A
wall-clock budget stops a run early rather than blocking for an hour, and
because the cache is per-symbol the next run resumes where it stopped.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.diff_paths import is_production_path

# Ablation is O(symbols) full test runs. Symbols beyond the cap are reported as
# truncated, never silently dropped.
_MAX_SYMBOLS = 5
# Per suite run. Longer than the chain's usual 600 s because the first run in a
# fresh tree may also have to build a venv.
_PER_RUN_TIMEOUT_S = 900
# Whole-measurement wall clock. Hitting it truncates the sample (recorded);
# the per-symbol cache means the next run continues rather than restarting.
_TOTAL_BUDGET_S = 1800
_TREE_PREFIX = "factory-mutation-tree-"
_SENTINEL_PREFIX = "factory-mutation-sentinel-"
_STALE_TREE_AGE_S = 6 * 3600

# Appears in the injected body and in the sentinel filename, so a traceback OR
# a filesystem check can attribute a red run to the mutation.
_MARKER = "FACTORY_ABLATION"

_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")

# ``measure`` never raises for an expected condition; it returns one of these.
STATUS_MEASURED = "measured"
STATUS_NO_SYMBOLS = "no_symbols"
STATUS_NO_REPO = "skipped_no_repo_root"
STATUS_NO_TEST_COMMAND = "skipped_no_test_command"
STATUS_NO_DIFF_BASE = "skipped_no_diff_base"
STATUS_NO_DIFF = "skipped_diff_unavailable"
STATUS_NO_TREE = "skipped_tree_unavailable"
STATUS_BASELINE_RED = "skipped_baseline_red"
STATUS_BASELINE_INFRA = "skipped_baseline_infra"


# --------------------------------------------------------------------------- #
# Types
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Symbol:
    """One ablation candidate: a function/method the diff actually touched."""

    path: str
    qualname: str
    lineno: int
    touched_lines: int

    @property
    def key(self) -> str:
        return f"{self.path}::{self.qualname}"


@dataclass
class MutationReport:
    """The outcome of one measurement. ``status`` is the only field a caller
    may branch on: anything other than ``measured`` means no score exists."""

    status: str
    reason: str
    head_sha: str = ""
    base_ref: str = ""
    score: float | None = None
    killed: list[str] = field(default_factory=list)
    survived: list[str] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    sampled: list[str] = field(default_factory=list)
    candidates: int = 0
    truncated: bool = False
    budget_exhausted: bool = False
    baseline: str = "unrun"
    baseline_output: str = ""
    tree_source: str = "none"
    cache_hits: int = 0
    elapsed_s: float = 0.0
    notes: list[str] = field(default_factory=list)

    @property
    def measured(self) -> bool:
        return self.status == STATUS_MEASURED

    def as_dict(self) -> dict[str, Any]:
        return {
            "mutation_status": self.status,
            "reason": self.reason,
            "head_sha": self.head_sha,
            "base_ref": self.base_ref,
            "mutation_score": self.score,
            "killed": list(self.killed),
            "survived": list(self.survived),
            "skipped": list(self.skipped),
            "sampled": list(self.sampled),
            "candidates": self.candidates,
            "truncated": self.truncated,
            "budget_exhausted": self.budget_exhausted,
            "baseline": self.baseline,
            "tree_source": self.tree_source,
            "cache_hits": self.cache_hits,
            "elapsed_s": round(self.elapsed_s, 2),
            "notes": list(self.notes),
            # Only when the precondition failed — that is when an operator needs
            # to see WHY, and it keeps a green report small.
            "baseline_output": "" if self.baseline in {GREEN, "cached"} else self.baseline_output[-1000:],
        }


# --------------------------------------------------------------------------- #
# git helpers
# --------------------------------------------------------------------------- #


def _git(repo: Path, *args: str, timeout: int = 120) -> tuple[int, str, str]:
    """Run git in ``repo``. Returns ``(rc, stdout, stderr)``; rc 128 for a
    failure to invoke git at all (never raises)."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(repo),
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError) as exc:
        return 128, "", f"git {' '.join(args)}: {exc}"
    return proc.returncode, proc.stdout, proc.stderr


def _resolve_base_ref(repo_root: Path, base_branch: str) -> str | None:
    """``origin/<base>`` then local ``<base>``, or None.

    Deliberately delegated to the chain's single implementation rather than
    grown as a second copy — the review path, the docs enforcer and this
    measurement must agree on what "the base" is. The import is intentionally
    NOT defensive: a rename must fail loudly in CI (``tests/test_mutation.py``
    pins it) rather than degrade this tool to a silent ``skipped``.
    """
    from factory.chain.handlers import _resolve_diff_base

    return _resolve_diff_base(repo_root, base_branch)


def _resolve_head_ref(repo_root: Path, head_sha: str) -> tuple[str, str, list[str]]:
    """Return ``(ref_to_check_out, concrete_sha, notes)``.

    The CONCRETE sha matters as much as the ref: it is the cache key. Keying on
    the caller-supplied string would put every run that omitted ``--head`` under
    the same ``"unknown"`` key, so a measurement of commit A would be served as a
    measurement of commit B. MEASURED: the first clean run of this tool wrote
    ``state/mutation/factory/unknown.json``. An empty ``concrete_sha`` disables
    the cache entirely rather than guessing a key.
    """
    notes: list[str] = []
    ref = "HEAD"
    if head_sha:
        rc, _out, _err = _git(
            repo_root, "rev-parse", "--verify", "--quiet", f"{head_sha}^{{commit}}"
        )
        if rc == 0:
            ref = head_sha
        else:
            notes.append(f"head_sha {head_sha!r} does not resolve in the checkout; used HEAD")
    rc, out, _err = _git(repo_root, "rev-parse", ref)
    concrete = out.strip() if rc == 0 else ""
    if not concrete:
        notes.append(f"{ref} does not resolve to a commit; caching disabled for this run")
    return ref, concrete, notes


def _touched_lines(repo_root: Path, base_ref: str, head_ref: str) -> dict[str, set[int]] | None:
    """``{path: {new-file line numbers the diff touched}}``, or None if the
    diff itself could not be computed (never an empty-dict stand-in for it)."""
    rc, out, _err = _git(
        repo_root,
        "diff",
        "--no-color",
        "--no-ext-diff",
        # Pin the prefixes: a user/repo ``diff.noprefix=true`` would emit
        # ``+++ path`` instead of ``+++ b/path`` and every path here would be
        # parsed two characters short — a silent-substrate failure that would
        # quietly select nothing.
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U0",
        f"{base_ref}...{head_ref}",
    )
    if rc != 0:
        return None
    touched: dict[str, set[int]] = {}
    current: str | None = None
    for line in out.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target == "/dev/null" or not target.startswith("b/"):
                current = None
            else:
                current = target[2:]
                touched.setdefault(current, set())
            continue
        if current is None:
            continue
        match = _HUNK_RE.match(line)
        if match is None:
            continue
        start = int(match.group(1))
        count = 1 if match.group(2) is None else int(match.group(2))
        if count == 0:
            # A pure deletion: nothing on the new side. The removal happened
            # between ``start`` and ``start + 1``, so both bracket the change
            # and either can put us inside the enclosing symbol.
            touched[current].update({max(1, start), max(1, start + 1)})
        else:
            touched[current].update(range(start, start + count))
    return touched


def _file_at(repo_root: Path, ref: str, path: str) -> str | None:
    rc, out, _err = _git(repo_root, "show", f"{ref}:{path}")
    if rc != 0:
        return None
    return out


# --------------------------------------------------------------------------- #
# Symbol selection — diff-scoped
# --------------------------------------------------------------------------- #


def _walk_functions(
    body: list[ast.stmt], prefix: str = ""
) -> Iterator[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]]:
    """Yield ``(qualname, node)`` for module-level functions and methods of
    (possibly nested) classes. Functions nested inside functions are NOT
    yielded: their enclosing function already covers those lines, and the
    mutator addresses symbols by this same dotted path."""
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield prefix + node.name, node
        elif isinstance(node, ast.ClassDef):
            yield from _walk_functions(node.body, prefix + node.name + ".")


def _span(node: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[int, int]:
    """First-to-last source line, decorators included (a decorator change
    changes the symbol's behaviour)."""
    start = node.lineno
    for dec in node.decorator_list:
        start = min(start, dec.lineno)
    return start, (node.end_lineno or node.lineno)


def _is_trivial_body(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """True when the body is already equivalent to the mutant we would inject.

    ``...``, ``pass``, a bare docstring and ``raise NotImplementedError`` are
    all no-ops to ablate: the mutant is indistinguishable from the original, so
    the suite CANNOT go red and the symbol would be reported "survived" on a
    measurement that never happened. Overload stubs and abstract methods are
    the common real cases.
    """
    body = list(node.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if not body:
        return True
    if len(body) != 1:
        return False
    stmt = body[0]
    if isinstance(stmt, ast.Pass):
        return True
    if (
        isinstance(stmt, ast.Expr)
        and isinstance(stmt.value, ast.Constant)
        and stmt.value.value is Ellipsis
    ):
        return True
    if isinstance(stmt, ast.Raise):
        exc = stmt.exc
        name: str | None = None
        if isinstance(exc, ast.Name):
            name = exc.id
        elif isinstance(exc, ast.Call) and isinstance(exc.func, ast.Name):
            name = exc.func.id
        return name in {"NotImplementedError", "NotImplemented"}
    return False


def select_symbols(
    repo_root: Path,
    base_ref: str,
    head_ref: str,
    *,
    max_symbols: int = _MAX_SYMBOLS,
) -> tuple[list[Symbol], int, list[str]] | None:
    """The symbols the diff TOUCHED, capped.

    Returns ``(sample, candidate_count, notes)``, or None when the diff could
    not be computed. Candidates are ranked by how much of the symbol the diff
    changed (most-changed first) and the returned sample is re-sorted by
    ``(path, lineno)`` so the report reads in file order.
    """
    touched = _touched_lines(repo_root, base_ref, head_ref)
    if touched is None:
        return None

    notes: list[str] = []
    candidates: list[Symbol] = []
    seen: set[str] = set()
    unmapped = 0
    for path in sorted(touched):
        lines = touched[path]
        if not lines or not path.endswith(".py"):
            continue
        # ONE definition of production-vs-test, shared with the bench harness
        # and the production-tree-changed gate. Never re-implemented here.
        if not is_production_path(path):
            continue
        source = _file_at(repo_root, head_ref, path)
        if source is None:
            continue  # deleted at head — nothing to ablate
        try:
            tree = ast.parse(source)
        except (SyntaxError, ValueError):
            notes.append(f"{path}: unparseable at {head_ref}")
            continue
        covered: set[int] = set()
        for qualname, node in _walk_functions(tree.body):
            start, end = _span(node)
            hits = sum(1 for line in lines if start <= line <= end)
            if not hits:
                continue
            covered.update(line for line in lines if start <= line <= end)
            if _is_trivial_body(node):
                notes.append(f"{path}::{qualname}: body is already a no-op (equivalent mutant)")
                continue
            key = f"{path}::{qualname}"
            if key in seen:
                # A module-level redefinition of the same name. Ablating it
                # twice would reuse one attribution sentinel and could score the
                # second run off the first run's evidence.
                notes.append(f"{key}: duplicate definition, measured once")
                continue
            seen.add(key)
            candidates.append(
                Symbol(path=path, qualname=qualname, lineno=start, touched_lines=hits)
            )
        unmapped += len(lines - covered)

    if unmapped:
        # Module-level code — imports, constants, class bodies — is changed by
        # plenty of real diffs and is NOT ablatable this way. Saying so keeps
        # the score from reading as "the whole diff is covered".
        notes.append(f"{unmapped} changed line(s) sit outside any ablatable symbol")
    ranked = sorted(candidates, key=lambda s: (-s.touched_lines, s.path, s.lineno))
    sample = sorted(ranked[:max_symbols], key=lambda s: (s.path, s.lineno))
    return sample, len(candidates), notes


# --------------------------------------------------------------------------- #
# Mutation — a line splice, not a round-trip
# --------------------------------------------------------------------------- #


def _find_function(
    tree: ast.Module, qualname: str
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for name, node in _walk_functions(tree.body):
        if name == qualname:
            return node
    return None


def mutate_source(source: str, qualname: str, *, sentinel: Path) -> str | None:
    """``source`` with ``qualname``'s body replaced, or None if it cannot be.

    Only the body's line range is rewritten, so every other byte of the file —
    comments, formatting, the rest of the module — is preserved exactly. The
    injected body touches ``sentinel`` and then RAISES: the raise makes any
    real invocation fail loudly (so a suite that stays green proves the tests
    never assert on this symbol), and the sentinel proves the injected body ran
    at all, which is what lets a red run be attributed to the mutation instead
    of to a flake.
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    node = _find_function(tree, qualname)
    if node is None or not node.body:
        return None

    first = node.body[0]
    start_line, start_col = first.lineno, first.col_offset
    end_line = node.end_lineno or start_line
    lines = source.splitlines(keepends=True)
    if start_line < 1 or end_line > len(lines) or start_line > end_line:
        return None

    raw = lines[start_line - 1]
    # ``col_offset`` is a UTF-8 byte offset. For the normal case this is just
    # the indentation; for a one-line ``def f(): ...`` it keeps the signature.
    prefix = raw.encode("utf-8")[:start_col].decode("utf-8", "replace")
    message = f"{_MARKER} {qualname}"
    injected = (
        f'__import__("pathlib").Path({str(sentinel)!r}).write_text("1"); '
        f"raise NotImplementedError({message!r})"
    )
    mutated = (
        "".join(lines[: start_line - 1]) + prefix + injected + "\n" + "".join(lines[end_line:])
    )
    if mutated == source:
        return None
    try:
        ast.parse(mutated)
    except (SyntaxError, ValueError):
        return None
    return mutated


# --------------------------------------------------------------------------- #
# Running the suite — green / red / infra are three different things
# --------------------------------------------------------------------------- #

GREEN, RED, INFRA = "green", "red", "infra"

# PATH entries under one of these directory names belong to a virtualenv.
_VENV_DIR_NAMES = {".venv", "venv", "virtualenv", "site-packages"}


def _mutant_env(tree_dir: Path) -> dict[str, str]:
    """The test-run environment, with the CALLER's virtualenv made unreachable.

    MEASURED on the first real run of this tool against the factory itself: the
    factory's own ``test_command`` is ``uv run pytest -q``, ``pytest`` is a dev
    EXTRA, and ``uv run`` in a fresh clone installs only the base dependencies.
    ``uv`` then resolved the ``pytest`` executable from ``PATH`` — finding the
    calling process's venv — and ran
    ``<caller>/.venv/bin/python <caller>/.venv/bin/pytest`` with cwd inside the
    scratch tree. That interpreter's editable install points at the CALLER's
    source, so the mutation would have been invisible: every mutant survives and
    the tool reports "your tests exercise nothing" having measured nothing.

    So the caller's venv is stripped out (``VIRTUAL_ENV``, ``PYTHONPATH``,
    ``PYTHONHOME``, ``UV_PROJECT_ENVIRONMENT``, and any venv ``bin`` on ``PATH``
    that is not inside the scratch tree). A test command that then cannot find
    its runner fails as INFRA — which reports ``skipped``, the honest answer —
    instead of silently measuring the wrong tree.

    ``uv`` still has to resolve, because that is what most app test commands start
    with. It is exposed through a shim directory holding a symlink to the ONE
    executable, never by putting its parent directory back: on a machine where
    ``uv`` lives inside the caller's virtualenv, restoring that directory would
    hand ``pytest`` back and re-open the exact leak this function exists to close.
    """
    from factory.runner import _isolated_test_env

    env = _isolated_test_env()
    for var in ("VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "UV_PROJECT_ENVIRONMENT"):
        env.pop(var, None)

    tree = str(tree_dir.resolve())
    kept: list[str] = []
    for entry in env.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        if any(part in _VENV_DIR_NAMES for part in Path(entry).parts) and not entry.startswith(
            tree
        ):
            continue
        kept.append(entry)

    if shutil.which("uv", path=os.pathsep.join(kept)) is None:
        original_uv = shutil.which("uv", path=env.get("PATH", ""))
        if original_uv is not None:
            shim = _uv_shim_dir(tree_dir, Path(original_uv))
            if shim is not None:
                kept.insert(0, str(shim))
    env["PATH"] = os.pathsep.join(kept)
    return env


def _uv_shim_dir(tree_dir: Path, uv_path: Path) -> Path | None:
    """A directory containing only a link to ``uv``, or None.

    Deliberately NOT ``uv_path.parent``: that directory may be the caller's
    virtualenv ``bin``, which also holds ``pytest``. Exposing one executable
    cannot re-open the leak. Lives beside the scratch tree so it is removed with
    it; a symlink failure returns None (``uv`` then does not resolve, the command
    fails as INFRA, and the run reports ``skipped`` — never a score).
    """
    shim = tree_dir.parent / ".factory-uv-shim"
    link = shim / uv_path.name
    try:
        shim.mkdir(parents=True, exist_ok=True)
        if not link.exists():
            link.symlink_to(uv_path)
    except OSError:
        return None
    return shim


def _run_suite(cwd: Path, test_command: str, timeout_s: int) -> tuple[str, str]:
    """Return ``(GREEN|RED|INFRA, output tail)``.

    The old code collapsed all three into a bool and read "not green" as
    "exercised", so a timeout, a missing interpreter or a broken venv all
    certified coverage that was never measured. Exit-code mapping follows
    pytest: 0 green, 1 tests failed, 2 interrupted, 3 internal error, 4 usage
    error, 5 no tests collected — and 127 command-not-found from the shell.
    Anything that is not a clean pass or a genuine test failure is INFRA, which
    can never mean "good".
    """
    try:
        proc = subprocess.run(
            test_command,
            shell=True,  # noqa: S602 — the command comes from trusted app config
            cwd=str(cwd),
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=timeout_s,
            env=_mutant_env(cwd),
        )
    except subprocess.TimeoutExpired:
        return INFRA, f"test command timed out after {timeout_s}s: {test_command}"
    except (FileNotFoundError, OSError, ValueError) as exc:
        return INFRA, f"test command could not be invoked: {exc}"
    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        return GREEN, output
    if proc.returncode == 1:
        return RED, output
    return INFRA, f"exit={proc.returncode} (not a test failure)\n{output}"


# --------------------------------------------------------------------------- #
# The throwaway tree
# --------------------------------------------------------------------------- #

_COPY_IGNORE = shutil.ignore_patterns(
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "state",
)


def _reap_stale_trees() -> None:
    """Delete mutation scratch older than ``_STALE_TREE_AGE_S``.

    Cleanup runs in a ``finally``, which a SIGKILL does not honour, and the
    tick unit has ``TimeoutStartSec=3h``. Nothing in the live checkout depends
    on that ``finally`` any more, but the disk does, so age-reap as well.
    """
    cutoff = time.time() - _STALE_TREE_AGE_S
    root = Path(tempfile.gettempdir())
    for prefix in (_TREE_PREFIX, _SENTINEL_PREFIX):
        try:
            for path in root.glob(f"{prefix}*"):
                try:
                    if path.is_dir() and path.stat().st_mtime < cutoff:
                        shutil.rmtree(path, ignore_errors=True)
                except OSError:
                    continue
        except OSError:
            continue


def _materialize_tree(repo_root: Path, head_ref: str, dest: Path) -> str | None:
    """Build a scratch checkout at ``head_ref``. Returns a source label.

    ``git clone --local`` hardlinks the (immutable) object store and writes
    NOTHING into ``repo_root`` — not even worktree metadata, which is why this
    is preferred over ``git worktree add`` against the checkout the chain
    pushes from. The clone is at the graded commit, so it is also a more
    faithful subject than a possibly-dirty working tree.
    """
    rc, _out, err = _git(repo_root, "clone", "--local", "--quiet", "--no-checkout", ".", str(dest))
    if rc == 0:
        rc2, _o2, err2 = _git(dest, "checkout", "--quiet", "--detach", head_ref)
        if rc2 == 0:
            return "git-clone"
        # The clone has every local ref; a PR head that is not among them can
        # still be fetched directly from the source repo.
        rc3, _o3, _e3 = _git(dest, "fetch", "--quiet", str(repo_root), head_ref)
        if rc3 == 0 and _git(dest, "checkout", "--quiet", "--detach", "FETCH_HEAD")[0] == 0:
            return "git-clone+fetch"
        shutil.rmtree(dest, ignore_errors=True)
        err = err2
    # Not a git repo (or git unusable): copy the working tree. Recorded, because
    # a copy without ``.git`` can turn a git-dependent suite red — which shows
    # up as a non-green baseline, i.e. ``skipped``, not as a score.
    try:
        shutil.copytree(repo_root, dest, ignore=_COPY_IGNORE, symlinks=True)
    except (OSError, shutil.Error):
        return None
    return f"worktree-copy ({err.strip()[:120]})" if err.strip() else "worktree-copy"


# --------------------------------------------------------------------------- #
# Cache
# --------------------------------------------------------------------------- #


def cache_path(software_factory_root: Path | None, app: str, head_sha: str) -> Path:
    """``state/mutation/<app>/<head_sha>.json``.

    ``head_sha`` must be a CONCRETE resolved sha — see ``_resolve_head_ref``.
    Root resolution is the one every other state writer uses (explicit arg →
    ``FACTORY_STATE_ROOT`` → cwd), reused rather than reimplemented so a test
    run can never write into production state.
    """
    from factory.manager.signals import _events_dir

    safe_app = (app or "unknown").replace("/", "-")
    safe_sha = (head_sha or "unknown").replace("/", "-")[:64]
    return _events_dir(software_factory_root).parent / "mutation" / safe_app / f"{safe_sha}.json"


def _command_fingerprint(test_command: str) -> str:
    return hashlib.sha256(test_command.encode("utf-8")).hexdigest()[:16]  # noqa: S324


def _load_cache(path: Path, *, fingerprint: str) -> dict[str, dict[str, str]]:
    """Cached outcomes for this SHA — but only if they were measured with the
    SAME test command.

    An outcome is a fact about ``(tree at head_sha, symbol, test command)``.
    Keying the file on the SHA alone would let a config change to
    ``test_command`` silently re-publish outcomes the new command never
    produced: a stale "killed" reported as a fresh measurement. Mismatched
    fingerprint ⇒ measure again.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if raw.get("command_fingerprint") != fingerprint:
        return {}
    symbols = raw.get("symbols")
    if not isinstance(symbols, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for key, val in symbols.items():
        if not isinstance(key, str) or not isinstance(val, dict):
            continue
        if val.get("outcome") not in {"killed", "survived"}:
            continue
        out[key] = {"outcome": str(val["outcome"]), "detail": str(val.get("detail", ""))}
    return out


def _load_provenance(path: Path, *, fingerprint: str) -> dict[str, str]:
    """Per-file "is the suite reading this tree" verdicts from a previous run."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if raw.get("command_fingerprint") != fingerprint:
        return {}
    stored = raw.get("provenance")
    if not isinstance(stored, dict):
        return {}
    return {
        key: str(val)
        for key, val in stored.items()
        if isinstance(key, str) and val in {"ok", "failed"}
    }


def _save_cache(
    path: Path,
    *,
    app: str,
    head_sha: str,
    fingerprint: str,
    symbols: dict[str, dict[str, str]],
    provenance: dict[str, str],
    report: MutationReport,
) -> None:
    """Persist determinate per-symbol outcomes plus the rolled-up score.

    Only ``killed``/``survived`` are stored: a ``skipped`` symbol was not
    measured, and caching it would freeze a non-measurement in place. This file
    is also the durable RECORD of the measurement — the number an operator reads
    when deciding whether this signal is worth gating on.
    """
    payload = {
        "app": app,
        "head_sha": head_sha,
        "command_fingerprint": fingerprint,
        "updated": datetime.now(UTC).isoformat(),
        "mutation_score": report.score,
        "candidates": report.candidates,
        "truncated": report.truncated,
        "baseline": report.baseline,
        "symbols": symbols,
        "provenance": provenance,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# The measurement
# --------------------------------------------------------------------------- #


def measure(
    *,
    repo_root: Path | None,
    head_sha: str,
    base_branch: str,
    test_command: str | None,
    app: str = "unknown",
    software_factory_root: Path | None = None,
    max_symbols: int = _MAX_SYMBOLS,
    per_run_timeout_s: int = _PER_RUN_TIMEOUT_S,
    budget_s: int = _TOTAL_BUDGET_S,
    use_cache: bool = True,
) -> MutationReport:
    """Measure the diff-scoped mutation score. Never raises for an expected
    condition; a condition we cannot measure under comes back as a
    ``skipped_*`` status with no score attached."""
    started = time.monotonic()

    if repo_root is None or not Path(repo_root).is_dir():
        return MutationReport(
            status=STATUS_NO_REPO, reason="no local checkout to measure", head_sha=head_sha
        )
    repo_root = Path(repo_root)
    if not test_command:
        return MutationReport(
            status=STATUS_NO_TEST_COMMAND,
            reason="no test_command configured",
            head_sha=head_sha,
        )

    base_ref = _resolve_base_ref(repo_root, base_branch)
    if base_ref is None:
        return MutationReport(
            status=STATUS_NO_DIFF_BASE,
            reason=f"neither origin/{base_branch} nor {base_branch} resolves in the checkout",
            head_sha=head_sha,
        )
    head_ref, concrete_sha, notes = _resolve_head_ref(repo_root, head_sha)

    selection = select_symbols(repo_root, base_ref, head_ref, max_symbols=max_symbols)
    if selection is None:
        return MutationReport(
            status=STATUS_NO_DIFF,
            reason=f"git diff {base_ref}...{head_ref} failed",
            head_sha=head_sha,
            base_ref=base_ref,
            notes=notes,
        )
    sample, candidates, sel_notes = selection
    notes.extend(sel_notes)

    report = MutationReport(
        status=STATUS_MEASURED,
        reason="",
        # The sha actually measured, not the one asked for.
        head_sha=concrete_sha or head_sha,
        base_ref=base_ref,
        sampled=[s.key for s in sample],
        candidates=candidates,
        truncated=candidates > len(sample),
        notes=notes,
    )
    if not sample:
        report.status = STATUS_NO_SYMBOLS
        report.reason = "the diff touched no ablatable production symbol"
        report.elapsed_s = time.monotonic() - started
        return report

    fingerprint = _command_fingerprint(test_command)
    # No resolvable sha ⇒ no safe cache key ⇒ no cache. Never a shared bucket.
    use_cache = use_cache and bool(concrete_sha)
    cache_file = cache_path(software_factory_root, app, concrete_sha)
    cached = _load_cache(cache_file, fingerprint=fingerprint) if use_cache else {}
    cached_provenance = (
        _load_provenance(cache_file, fingerprint=fingerprint) if use_cache else {}
    )
    provenance: dict[str, str] = dict(cached_provenance)
    outcomes: dict[str, dict[str, str]] = {}
    pending: list[Symbol] = []
    for sym in sample:
        hit = cached.get(sym.key)
        if hit is not None:
            outcomes[sym.key] = hit
            report.cache_hits += 1
        else:
            pending.append(sym)

    if not pending:
        report.tree_source = "cache"
        report.baseline = "cached"
        _finish(report, outcomes, started)
        return report

    _reap_stale_trees()
    try:
        tree = Path(tempfile.mkdtemp(prefix=_TREE_PREFIX))
        sentinels = Path(tempfile.mkdtemp(prefix=_SENTINEL_PREFIX))
    except OSError as exc:
        # No scratch space ⇒ no measurement. Never a score.
        report.status = STATUS_NO_TREE
        report.reason = f"could not create scratch space: {exc}"
        _finish(report, outcomes, started, save=None, allow_score=False)
        return report
    tree_dir = tree / "repo"
    try:
        source_label = _materialize_tree(repo_root, head_ref, tree_dir)
        if source_label is None:
            report.status = STATUS_NO_TREE
            report.reason = "could not materialize a scratch checkout to mutate"
            _finish(report, outcomes, started, save=None, allow_score=False)
            return report
        report.tree_source = source_label

        # THE PRECONDITION. Nothing is mutated until the suite is green here.
        baseline, baseline_out = _run_suite(tree_dir, test_command, per_run_timeout_s)
        report.baseline = baseline
        report.baseline_output = baseline_out[-4000:]
        if baseline != GREEN:
            report.status = (
                STATUS_BASELINE_RED if baseline == RED else STATUS_BASELINE_INFRA
            )
            report.reason = (
                f"baseline suite is {baseline} at {head_ref} before any mutation — "
                "no coverage claim can be derived"
            )
            # No path from a non-green baseline to a score, not even via the
            # cache: this run measured nothing, so it publishes nothing.
            _finish(report, outcomes, started, save=None, allow_score=False)
            return report

        dirty = False
        for sym in pending:
            if dirty:
                # A failed restore would make the NEXT symbol's run judge a
                # composed mutant: red for the previous symbol's reason, which
                # could be scored as this symbol's kill. Stop instead of
                # guessing generously.
                report.skipped.append({"symbol": sym.key, "why": "scratch tree left dirty"})
                continue
            if time.monotonic() - started > budget_s:
                report.budget_exhausted = True
                report.skipped.append({"symbol": sym.key, "why": "budget_exhausted"})
                continue
            outcome, dirty = _ablate_one(
                tree_dir, sym, test_command, sentinels, per_run_timeout_s
            )
            if outcome["outcome"] in {"killed", "survived"}:
                outcomes[sym.key] = outcome
            else:
                report.skipped.append({"symbol": sym.key, "why": outcome["detail"]})

        _verify_provenance(
            report,
            outcomes,
            tree_dir=tree_dir,
            test_command=test_command,
            per_run_timeout_s=per_run_timeout_s,
            budget_s=budget_s,
            started=started,
            provenance=provenance,
            dirty=dirty,
        )
    finally:
        shutil.rmtree(tree, ignore_errors=True)
        shutil.rmtree(sentinels, ignore_errors=True)

    # Cache only a measurement of the COMMIT. The ``worktree-copy`` fallback
    # copies the working tree, which may be dirty and is not guaranteed to be at
    # ``head_ref``; storing its outcomes under the sha would let a later run serve
    # them as a measurement of that commit.
    cacheable = bool(concrete_sha) and not report.tree_source.startswith("worktree-copy")
    if not cacheable and concrete_sha:
        report.notes.append(
            f"not cached: tree_source={report.tree_source!r} is not the graded commit"
        )
    _finish(
        report,
        outcomes,
        started,
        save=(cache_file, app, fingerprint) if cacheable else None,
        provenance=provenance,
    )
    return report


def _verify_provenance(
    report: MutationReport,
    outcomes: dict[str, dict[str, str]],
    *,
    tree_dir: Path,
    test_command: str,
    per_run_timeout_s: int,
    budget_s: int,
    started: float,
    provenance: dict[str, str],
    dirty: bool,
) -> None:
    """Withdraw every ``survived`` verdict whose file the suite does not read.

    A file with a KILL in it is already proven. For any other file carrying a
    ``survived``, run the syntax-break probe once. Unproven ⇒ those outcomes are
    demoted to ``skipped``, because "the tests do not exercise this" and "we
    measured the wrong tree" are indistinguishable from a green mutant, and
    publishing the first when it might be the second is a false accusation
    dressed as a measurement.
    """
    killed_files = {k.split("::", 1)[0] for k, v in outcomes.items() if v["outcome"] == "killed"}
    suspect_files = {
        k.split("::", 1)[0]
        for k, v in outcomes.items()
        if v["outcome"] == "survived" and k.split("::", 1)[0] not in killed_files
    }
    for rel_path in sorted(suspect_files):
        verdict = provenance.get(rel_path)
        if verdict is None:
            if dirty or time.monotonic() - started > budget_s:
                verdict = "unverified"
            else:
                verdict, dirty = _provenance_probe(
                    tree_dir, rel_path, test_command, per_run_timeout_s
                )
                # Only a clean probe's verdict is trustworthy enough to cache.
                if not dirty:
                    provenance[rel_path] = verdict
                else:
                    verdict = "unverified"
        # Recorded either way: "this survived verdict was checked" is part of the
        # evidence, not just the failures.
        report.notes.append(f"{rel_path}: provenance {verdict}")
        if verdict == "ok":
            continue
        for key in [k for k in list(outcomes) if k.split("::", 1)[0] == rel_path]:
            if outcomes[key]["outcome"] != "survived":
                continue
            del outcomes[key]
            report.skipped.append(
                {
                    "symbol": key,
                    "why": (
                        "the suite does not read the mutated tree for this file "
                        "(provenance probe stayed green)"
                        if verdict == "failed"
                        else "provenance for this file could not be verified"
                    ),
                }
            )


def _finish(
    report: MutationReport,
    outcomes: dict[str, dict[str, str]],
    started: float,
    save: tuple[Path, str, str] | None = None,
    allow_score: bool = True,
    provenance: dict[str, str] | None = None,
) -> None:
    report.killed = sorted(k for k, v in outcomes.items() if v["outcome"] == "killed")
    report.survived = sorted(k for k, v in outcomes.items() if v["outcome"] == "survived")
    denom = len(report.killed) + len(report.survived)
    if allow_score:
        report.score = (len(report.killed) / denom) if denom else None
    else:
        report.score = None
        report.notes.append("score withheld: the precondition for measuring did not hold")
    report.elapsed_s = time.monotonic() - started
    if not report.reason:
        if report.score is None:
            report.reason = "no symbol could be measured"
        else:
            report.reason = (
                f"mutation score {report.score:.2f} "
                f"({len(report.killed)} killed / {denom} measured"
                f", {len(report.skipped)} skipped, {report.candidates} candidates)"
            )
    if save is not None and outcomes:
        cache_file, app, fingerprint = save
        _save_cache(
            cache_file,
            app=app,
            head_sha=report.head_sha,
            fingerprint=fingerprint,
            symbols=outcomes,
            provenance=provenance or {},
            report=report,
        )


def check_can_fail(
    *,
    repo_root: Path,
    head_ref: str,
    target_path: str,
    qualname: str,
    check_command: str,
    timeout_s: int = _PER_RUN_TIMEOUT_S,
    prepare: Callable[[Path], str | None] | None = None,
    run_cwd: str | None = None,
) -> tuple[bool, str]:
    """Can ``check_command`` FAIL when ``target_path::qualname`` stops working?

    Returns ``(proven, detail)``. ``True`` only when the check was observed going
    red on a mutation we can attribute to ourselves. Every other outcome —
    green, an unattributable red, a timeout, a tree we could not materialize — is
    ``False`` with the reason, because "we could not prove it" is not "it can".

    This is the general shape of the question a required gate has to be able to
    answer about its own green: *does this check carry information?* The mutation
    machinery above answers it for a whole test suite; this answers it for ONE
    check, which is the cheap case — a single oracle file runs in seconds where
    the factory's suite takes ~380 s.

    The concrete case it was written for, and now has a caller for:
    an acceptance oracle of ``def test_x(): assert True`` is stored, runs, reports
    "1 passed", and yields an authoritative green against an implementation that
    violates the criterion. Ablate the symbol the criterion is about, require the
    oracle to go red, and that green means something. **A caller on the merge path
    must treat ``False`` as blocking, not as a pass** — this function deliberately
    does not decide that for you, but a "cannot prove" that waves the check
    through is the fail-open bug this whole module exists to correct.

    Like ``measure``, it never writes to ``repo_root``: the mutation happens in a
    throwaway ``git clone`` at ``head_ref``. And like ``measure``, it takes a
    GREEN baseline first — an already-red check "goes red" under any mutation, and
    reporting that as proof would be the fail-open direction on the one call where
    ``True`` is the permissive answer.

    ``prepare`` and ``run_cwd`` exist for the one real caller
    (``gates.acceptance_verified``), whose check is not "run this repo's own suite
    at the repo root":

    * ``prepare(tree_dir)`` runs against the materialized clone BEFORE the green
      baseline. It returns ``None`` on success, or a string explaining why the
      check cannot be set up — which is a ``False``, never a pass. The acceptance
      gate uses it to copy the hidden oracle in (the file does not exist in the
      repo at all) and to roll the diff's COLLECTION CHANNELS back to the merge
      base, so the tree that judges the diff is not configured by the diff. Any
      exception out of ``prepare`` is also a ``False``.
    * ``run_cwd`` is a tree-relative directory to run ``check_command`` in
      (default: the tree root), because an app's test harness usually is not
      rooted at the repo root — sacrifice's is ``backend/``. It must resolve
      inside the clone.
    """
    _reap_stale_trees()
    try:
        scratch = Path(tempfile.mkdtemp(prefix=_TREE_PREFIX))
        sentinels = Path(tempfile.mkdtemp(prefix=_SENTINEL_PREFIX))
    except OSError as exc:
        return False, f"could not create scratch space: {exc}"
    tree_dir = scratch / "repo"
    try:
        if _materialize_tree(repo_root, head_ref, tree_dir) is None:
            return False, "could not materialize a scratch checkout to mutate"
        if prepare is not None:
            try:
                problem = prepare(tree_dir)
            except Exception as exc:  # noqa: BLE001 - a setup fault is "cannot prove"
                problem = f"{type(exc).__name__}: {exc}"
            if problem:
                return False, f"the check could not be set up in the scratch tree: {problem}"
        try:
            work_dir = _resolve_run_cwd(tree_dir, run_cwd)
        except ValueError as exc:
            return False, str(exc)
        baseline, baseline_out = _run_suite(work_dir, check_command, timeout_s)
        if baseline != GREEN:
            return False, (
                f"the check is {baseline}, not green, BEFORE any mutation — a red "
                f"check proves nothing about the criterion: {baseline_out.strip()[:200]}"
            )
        sym = Symbol(path=target_path, qualname=qualname, lineno=0, touched_lines=0)
        outcome, _dirty = _ablate_one(
            tree_dir, sym, check_command, sentinels, timeout_s, run_cwd=work_dir
        )
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        shutil.rmtree(sentinels, ignore_errors=True)
    if outcome["outcome"] == "killed":
        return True, f"{target_path}::{qualname} ablated → the check went red"
    if outcome["outcome"] == "survived":
        return False, f"the check stayed green with {target_path}::{qualname} gutted"
    return False, outcome["detail"]


def _provenance_probe(
    tree_dir: Path, rel_path: str, test_command: str, per_run_timeout_s: int
) -> tuple[str, bool]:
    """Is the suite actually reading THIS file in THIS tree?

    Returns ``(("ok"|"failed"), tree_left_dirty)``.

    A surviving mutant is ambiguous: either the tests never assert on the
    symbol, or the suite is not importing the tree we mutated at all (a leaked
    outer virtualenv, a stale installed copy of the package, a monorepo test
    command rooted in a different directory). Both produce "green with the body
    gutted", and only one of them is a finding about the tests.

    The probe removes the ambiguity without needing to know anything about the
    project: make the file syntactically INVALID and re-run. Any suite that
    imports it must now fail. If it stays green, the file is not in the suite's
    import path and nothing about it was measured.

    A KILLED mutant already proves provenance, so this only runs for a file
    where nothing was killed — the exact case where the score would otherwise be
    an unfalsifiable zero.
    """
    target = tree_dir / rel_path
    try:
        original = target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return "failed", False
    try:
        target.write_text(original + "\nthis is (not valid python\n", encoding="utf-8")
        outcome, _output = _run_suite(tree_dir, test_command, per_run_timeout_s)
    except OSError:
        return "failed", True
    finally:
        try:
            target.write_text(original, encoding="utf-8")
        except OSError:
            pass
    # A failed restore leaves a syntactically broken file behind, and the NEXT
    # file's probe would then be red for THIS file's reason and read as "ok" —
    # a proof of provenance that proves nothing. The caller stops on dirty.
    try:
        dirty = target.read_text(encoding="utf-8", errors="replace") != original
    except OSError:
        dirty = True
    # Green with a syntactically broken file ⇒ the suite never reads it.
    # Anything else ⇒ it does. A timeout would also read as "ok" here, which
    # only risks KEEPING a survived finding, never manufacturing a kill.
    return ("failed" if outcome == GREEN else "ok"), dirty


def _resolve_run_cwd(tree_dir: Path, rel: str | None) -> Path:
    """A tree-relative working directory for the check, refusing to escape the clone.

    ``ValueError`` rather than a silent fall back to the tree root: running the
    check somewhere other than where the caller asked would silently measure a
    different thing, and for :func:`check_can_fail` "measured something else" is
    indistinguishable from "proven failable".
    """
    base = Path(tree_dir).resolve()
    if not rel or not rel.strip():
        return base
    target = (base / rel.strip()).resolve()
    if target != base and base not in target.parents:
        raise ValueError(f"run_cwd={rel!r} resolves outside the scratch tree ({target})")
    if not target.is_dir():
        raise ValueError(f"run_cwd={rel!r} does not exist in the scratch checkout ({target})")
    return target


def _ablate_one(
    tree_dir: Path,
    sym: Symbol,
    test_command: str,
    sentinels: Path,
    per_run_timeout_s: int,
    *,
    run_cwd: Path | None = None,
) -> tuple[dict[str, str], bool]:
    """Mutate one symbol in the scratch tree, run the suite, classify.

    Returns ``(outcome, tree_left_dirty)``. The mutation is always written
    relative to ``tree_dir``; ``run_cwd`` only moves where the command runs
    (default ``tree_dir``), for a harness that is not rooted at the repo root.

    * green ⇒ **survived** — the tests do not notice the symbol's body being
      replaced by a raise. Whether the symbol was even reached is recorded
      (the sentinel), because "never called" and "called but not asserted on"
      are different kinds of illusory coverage.
    * red + evidence the mutant ran ⇒ **killed**.
    * red WITHOUT that evidence ⇒ skipped. We cannot attribute the failure to
      the mutation, and guessing in the generous direction is how the old code
      certified coverage it never measured.
    * infra ⇒ skipped.

    KNOWN LIMIT, stated here because it is the one remaining way this can be
    optimistic: a suite that flakes red on a run where the mutant WAS invoked is
    scored as a kill. The green baseline immediately before, in the same tree,
    narrows it; only re-runs would close it. It inflates a score; it cannot pass
    a merge, because nothing on the merge path reads this.
    """
    target = tree_dir / sym.path
    try:
        original = target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return {"outcome": "skipped", "detail": f"unreadable: {exc}"}, False

    digest = hashlib.sha1(sym.key.encode("utf-8")).hexdigest()[:12]  # noqa: S324 — not security
    sentinel = sentinels / f"{_MARKER}-{digest}"
    # A leftover sentinel would be read as "this mutant ran". Start from absent.
    try:
        sentinel.unlink(missing_ok=True)
    except OSError:
        return {"outcome": "skipped", "detail": "could not clear the attribution sentinel"}, False

    mutated = mutate_source(original, sym.qualname, sentinel=sentinel)
    if mutated is None:
        return {"outcome": "skipped", "detail": "symbol could not be mutated"}, False

    try:
        target.write_text(mutated, encoding="utf-8")
        outcome, output = _run_suite(run_cwd or tree_dir, test_command, per_run_timeout_s)
    except OSError as exc:
        return {"outcome": "skipped", "detail": f"mutation write failed: {exc}"}, True
    finally:
        # The tree is scratch, so this restore protects the NEXT symbol's
        # measurement, not the source checkout. The caller stops if it fails.
        try:
            target.write_text(original, encoding="utf-8")
        except OSError:
            pass
    try:
        dirty = target.read_text(encoding="utf-8", errors="replace") != original
    except OSError:
        # Reading back is part of the never-raises contract, not outside it: an
        # unreadable scratch file is exactly the condition ``dirty`` exists for.
        dirty = True

    ran = sentinel.exists()
    if outcome == GREEN:
        return {
            "outcome": "survived",
            "detail": "invoked but not asserted on" if ran else "never invoked by the suite",
        }, dirty
    # The fallback matches the FULL message, symbol name included. Matching the
    # bare marker would false-attribute when the tree under test contains this
    # module's own source (measuring the factory on itself does).
    if outcome == RED and (ran or f"{_MARKER} {sym.qualname}" in output):
        return {"outcome": "killed", "detail": "suite went red on the ablated body"}, dirty
    if outcome == RED:
        return {
            "outcome": "skipped",
            "detail": "suite red but the failure is not attributable to the mutation",
        }, dirty
    return {
        "outcome": "skipped",
        "detail": f"infrastructure failure: {output.strip()[:200]}",
    }, dirty
