"""Harness-owned red→green verification (PLAN A.6) — one implementation.

Why this module exists
======================

A test the harness never ran at the BASE commit cannot tell you whether it is
able to fail. "Red-first" is *instructed* in ``factory/personas/dev.md`` and in
``factory/personas/acceptance_author.md``, and the chain then trusts the claim:
``PRContext.commit_history`` carries the dev's own ``tests_run_red`` report, and
nothing anywhere re-derives it. A gate whose green is produced by a test that
cannot fail is a gate detached from a real check, which
``factory/chain/gates/evaluator.py:18-29`` says is worse than no gate at all.

So the harness runs the test ITSELF at the merge base and observes the result.
Two consumers need exactly this, which is why it lives here and not inside one
of them:

* the ``acceptance-verified`` gate — the oracle must be RED at the merge base
  before its green at HEAD is credited (A.1c);
* a future gate over the DEV's new tests (A.6 proper) — same question, same
  states, same fallback.

⚠ THE CAVEAT — read this before tightening anything below
=========================================================

**Only the fails-at-base half of red→green is oracle-free.** Agentless measured
213/300 generated tests reproducing a bug but only 94/300 of those ALSO flipping
green under the gold patch, so a hard both-halves gate rejects good patches.
Two consequences are encoded in this module and must stay encoded:

1. "Fails at base" means **at least one test FAILED** at base
   (:func:`base_verdict`), never "the whole file was red". A story that
   implements one of its direction's several acceptance criteria produces an
   oracle whose other tests legitimately pass at base.

   An ERROR-only red is not "fails at base" — it is ``unknown``. An oracle that
   cannot be collected at the merge base (``from app.mod import thing`` for a
   module the story adds) is red no matter what it asserts, so a tautology rides
   that route to a credited green. See :func:`base_verdict` for the measurement.
   Errors and failures are different facts here, and only the second one is
   evidence.
2. When the base run cannot be TRUSTED — infra error, timeout, unreadable
   output, nothing collected, no merge base — the verdict is ``unknown``, and an
   ``unknown`` falls back to **regression-only selection: it must never be read
   as "approve"**. Callers get three states, ``red`` / ``green`` / ``unknown``,
   and only ``red`` licenses crediting a green at HEAD. ``unknown`` is a
   *skipped-with-reason*: not a pass, and not evidence against the dev either.

Tampering
=========

:func:`parse_pytest_summary` reads the LAST summary line in the output and flags
CONFLICTING summaries, because a dev-controlled ``conftest.py`` can print
``"7 passed in 0.01s"`` before pytest's own summary and a first-match parse
credits the forgery. Parsing alone cannot close that hole (a conftest can
implement ``pytest_report_teststatus`` and relabel skip→pass); the structural fix
is running in a throwaway :func:`judge_worktree` whose collection channels come
from the merge base, not from the dev's HEAD. Both layers are used together.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

_log = logging.getLogger(__name__)

_GIT_TIMEOUT = 60
# pytest's own exit code for "killed by our timeout" never exists; ``_run_command``
# in the gate evaluator synthesises 124, and a timed-out run's output tail is a
# fragment we must never classify as a real red.
TIMEOUT_EXIT_CODE = 124


# --------------------------------------------------------------------------- #
# pytest summary parsing
# --------------------------------------------------------------------------- #

# One ``<n> <outcome>`` token from a pytest summary line. ``warnings`` is
# deliberately NOT a member: it is not a test outcome, and including it would
# make "1 passed, 2 warnings" and "1 passed" read as CONFLICTING summaries.
_TOKEN_RE = re.compile(
    r"(?<![\w.])(\d+)\s+(passed|failed|errors?|skipped|xfailed|xpassed|deselected)\b"
)
_NO_TESTS_RE = re.compile(r"no tests ran", re.IGNORECASE)


@dataclass(frozen=True)
class PytestSummary:
    """The counts from a pytest summary line, plus whether we can trust them."""

    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    xfailed: int = 0
    xpassed: int = 0
    deselected: int = 0
    no_tests_ran: bool = False
    # More than one DISTINCT summary appeared in the output. pytest prints one;
    # a second one means something else printed a summary-shaped line, i.e. the
    # count we would read is forgeable. Callers must refuse to grade on it.
    conflicting: bool = False
    line: str = ""

    @property
    def ran_something(self) -> bool:
        """Did any test actually reach a per-test outcome?"""
        return bool(
            self.passed or self.failed or self.errors
            or self.skipped or self.xfailed or self.xpassed
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "passed": self.passed,
            "failed": self.failed,
            "errors": self.errors,
            "skipped": self.skipped,
            "xfailed": self.xfailed,
            "xpassed": self.xpassed,
            "deselected": self.deselected,
            "no_tests_ran": self.no_tests_ran,
            "conflicting": self.conflicting,
            "line": self.line[:200],
        }


def _counts_from_line(line: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for n, word in _TOKEN_RE.findall(line):
        key = "errors" if word.startswith("error") else word
        counts[key] = counts.get(key, 0) + int(n)
    return counts


def parse_pytest_summary(output: str) -> PytestSummary | None:
    """The counts pytest reported, or ``None`` when the output carries none.

    Takes the **LAST** summary-shaped line, not the first: pytest prints its
    summary last, so a line printed earlier by a dev-controlled ``conftest.py``
    (``print("7 passed in 0.01s")`` from ``pytest_configure``) is a forgery. When
    two DIFFERENT summaries appear, ``conflicting`` is set and the caller must
    refuse to grade on the numbers at all — we cannot tell which one pytest
    wrote, and one of them is a lie.
    """
    if not output:
        return None
    seen: list[tuple[str, dict[str, int]]] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        counts = _counts_from_line(line)
        if counts:
            seen.append((line, counts))
        elif _NO_TESTS_RE.search(line):
            seen.append((line, {}))
    if not seen:
        return None

    line, counts = seen[-1]
    distinct = {json.dumps(c, sort_keys=True) for _l, c in seen}
    return PytestSummary(
        passed=counts.get("passed", 0),
        failed=counts.get("failed", 0),
        errors=counts.get("errors", 0),
        skipped=counts.get("skipped", 0),
        xfailed=counts.get("xfailed", 0),
        xpassed=counts.get("xpassed", 0),
        deselected=counts.get("deselected", 0),
        no_tests_ran=not counts and bool(_NO_TESTS_RE.search(line)),
        conflicting=len(distinct) > 1,
        line=line,
    )


RunStatus = Literal["pass", "fail", "vacuous", "unreadable", "conflicting"]


def classify_pytest_run(exit_code: int, output: str) -> tuple[RunStatus, PytestSummary | None]:
    """Grade one pytest run from its exit code and output.

    * ``pass`` — exit 0 and at least one test passed and nothing failed;
    * ``fail`` — a test failed or errored (or pytest disagreed with the counts);
    * ``vacuous`` — nothing reached an outcome, or only skips/xfails did. Exit 0
      here is NOT evidence of anything (the acceptance author is allowed to
      ``pytest.skip`` a criterion it cannot express);
    * ``unreadable`` — no summary at all: a timeout, a missing runner, a summary
      evicted from the captured tail, or output we simply cannot grade;
    * ``conflicting`` — two different summaries; the numbers are forgeable.
    """
    if exit_code == TIMEOUT_EXIT_CODE:
        # A killed run's tail can contain a partial summary; grading it would let
        # a timeout masquerade as a real red.
        return "unreadable", parse_pytest_summary(output)
    summary = parse_pytest_summary(output)
    if summary is None:
        return "unreadable", None
    if summary.conflicting:
        return "conflicting", summary
    if not summary.ran_something:
        return "vacuous", summary
    if summary.failed or summary.errors:
        return "fail", summary
    if exit_code != 0:
        # pytest exited non-zero while reporting no failure. Trust the exit code.
        return "fail", summary
    if summary.passed >= 1:
        return "pass", summary
    return "vacuous", summary


BaseVerdict = Literal["red", "green", "unknown"]


def base_verdict(exit_code: int, output: str) -> tuple[BaseVerdict, str, PytestSummary | None]:
    """Grade the BASE run: was the test able to fail without the story's diff?

    * ``red`` — at least one test **FAILED** at the merge base: an assertion in
      the oracle ran and disagreed with the base implementation. This is the only
      verdict that licenses crediting a green at HEAD. Deliberately "at least
      one", not "all": see the caveat at the top of this module — requiring every
      test to be red rejects good work.
    * ``green`` — every test already passed at the merge base, so the test does
      not discriminate this story's diff and its green at HEAD carries no
      information about it.
    * ``unknown`` — the base run cannot be trusted (nothing collected, timeout,
      unreadable output, conflicting summaries, or a red made ENTIRELY of
      errors). Regression-only fallback: never "approve".

    ⚠ WHY AN ERRORS-ONLY RED IS ``unknown`` AND NOT ``red`` (2026-08-05)
    -------------------------------------------------------------------
    This function used to count ``errors`` as red alongside ``failed``, and that
    was a MEASURED forced pass. For a story that ADDS a module, an oracle whose
    only relationship to the criterion is ``from app.mod import thing`` raises
    ``ModuleNotFoundError`` at the merge base — a COLLECTION error — whatever it
    goes on to assert. So::

        from app.mod import normalize_email

        def test_ac1():
            assert True

    was red at base, green at HEAD, and credited ``verified=True,
    authoritative=True`` against an implementation that violated the criterion.
    The whole D1 family (``assert True``, a self-referential assertion, an
    assertion inside ``try/except``) rides that route, and it is the COMMON story
    shape rather than an exotic one: any story creating a new module reaches it
    whenever the app's test directory already exists at base, which it does for
    every app past its first commit.

    An error says the oracle could not RUN. Only a failure says its assertions
    ran and discriminated. Those are different facts and no parse of the base run
    alone can turn the first into the second — the file that failed to import is
    exactly the file whose assertions we are trying to evaluate.

    So an errors-only red is ``unknown``, which is not a block: it falls through
    to the ABLATION route, and ablation answers precisely the question the base
    run could not. The good case still merges — the real oracle for a new module
    goes red when its symbol is gutted — and the tautology does not, because
    gutting the code changes nothing ``assert True`` can see. The cost is that
    new-module stories take the (more expensive) ablation route rather than the
    cheap cached one; that is the price of the green meaning something.

    A mixed run (``1 failed, 1 error``) IS red: an assertion did run and did
    discriminate, and the caveat above forbids demanding that all of them do.
    """
    status, summary = classify_pytest_run(exit_code, output)
    if status == "fail":
        if summary is not None and summary.failed >= 1:
            n = summary.failed
            return (
                "red",
                f"{n} test(s) FAILED at the merge base (RED as required)",
                summary,
            )
        # Errors only, or pytest exited non-zero while reporting no outcome at
        # all. Nothing here shows the oracle's assertions ran, so it is not proof
        # of failability. ``unknown`` → the ablation fallback, never a credit.
        n_err = summary.errors if summary is not None else 0
        return (
            "unknown",
            (
                f"the base run is red but ENTIRELY from {n_err} error(s) and no test "
                "failure (exit_code="
                f"{exit_code}) — an oracle that cannot even be COLLECTED at the base "
                "(a story that adds the module it imports) is red whatever it asserts, "
                "so this is not evidence that its assertions discriminate anything"
            ),
            summary,
        )
    if status == "pass":
        n = summary.passed if summary else 0
        return (
            "green",
            f"all {n} test(s) ALREADY PASS at the merge base — the test does not "
            "discriminate this story's diff",
            summary,
        )
    reasons = {
        "vacuous": "the base run reached no test outcome (nothing collected, or all skipped)",
        "unreadable": f"the base run produced no readable pytest summary (exit_code={exit_code})",
        "conflicting": "the base run printed conflicting pytest summaries",
    }
    return "unknown", reasons[status], summary


# --------------------------------------------------------------------------- #
# git plumbing
# --------------------------------------------------------------------------- #


def _git(repo: Path, *args: str, timeout: int = _GIT_TIMEOUT) -> tuple[int, str, str]:
    """Run git in ``repo``; ``(returncode, stdout, stderr)``. Never raises."""
    try:
        proc = subprocess.run(  # noqa: S603,S607 - fixed argv, no shell
            ["git", *args],
            cwd=str(repo),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return 128, "", f"{type(exc).__name__}: {exc}"
    return proc.returncode, proc.stdout or "", proc.stderr or ""


_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


def head_sha(repo: Path) -> str | None:
    code, out, _err = _git(repo, "rev-parse", "HEAD")
    return out.strip() or None if code == 0 else None


def head_contains_sha(repo: Path, sha: str | None) -> tuple[bool | None, str]:
    """Is ``sha`` an ancestor of (or equal to) ``repo``'s HEAD?

    ``(True, why)`` / ``(False, why)`` / ``(None, why)`` where ``None`` means the
    question could not be answered (not a git checkout, unknown object, git
    unavailable). PROVENANCE, and it is not the same question as SHA equality:
    ``auto_merge._story_worktree`` merges ``origin/main`` into the feature branch
    before gates run, so the checkout's HEAD is normally a merge commit whose
    ancestor is the PR head. Equality would false-block every such PR;
    ancestry is the real property ("the tree I am about to grade contains the
    commit that will be merged").
    """
    if not sha or not _SHA_RE.match(sha.strip()):
        return None, f"head_sha={sha!r} is not a commit id"
    sha = sha.strip()
    code, _out, _err = _git(repo, "rev-parse", "--git-dir")
    if code != 0:
        return None, "the checkout is not a git repository"
    code, _out, _err = _git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    if code != 0:
        return None, f"commit {sha[:12]} is unknown to the checkout (fetch failed?)"
    code, _out, err = _git(repo, "merge-base", "--is-ancestor", sha, "HEAD")
    if code == 0:
        return True, f"{sha[:12]} is an ancestor of HEAD"
    if code == 1:
        local = head_sha(repo) or "?"
        return False, f"{sha[:12]} is NOT an ancestor of the checkout HEAD {local[:12]}"
    return None, f"git merge-base --is-ancestor failed: {err.strip()[:200]}"


def _base_refs(base_branch: str | None) -> list[str]:
    """The refs that stand for "the base branch", most authoritative first.

    ``origin/<base>`` is what the merge is actually computed against; the local
    branch of the same name can be arbitrarily stale in a worktree, and a bare
    test repo has no remote at all.
    """
    branch = (base_branch or "main").strip() or "main"
    return [f"origin/{branch}", branch, f"refs/remotes/origin/{branch}"]


def extra_commits_beyond(
    repo: Path, head_sha: str, base_branch: str | None
) -> tuple[list[str] | None, str]:
    """Non-merge commits HEAD adds over ``head_sha`` that did NOT come from the base.

    ``([], why)`` is the clean answer, a non-empty list names the offending commits,
    and ``None`` means the question could not be answered — which a caller on the
    merge path must treat as *cannot verify*, never as clean.

    WHY THIS IS NOT REDUNDANT WITH :func:`head_contains_sha`. Ancestry says the
    checkout contains the PR head; it does not say the checkout is ONLY the PR head
    plus the base. ``auto_merge._story_worktree`` legitimately produces
    ``merge(origin/<feature>, origin/<base>)`` — hence ancestry rather than SHA
    equality — but a worktree whose feature branch is AHEAD of ``origin/<feature>``
    (a commit the chain made and failed to push) also passes ancestry, and grading
    it returns an authoritative verdict about code that is not being merged. That is
    D2's own bug class, one level in.

    ``--no-merges`` is the deliberate limit: a merge commit can carry conflict
    resolutions, so a hostile resolving merge would not be listed here. The chain
    never makes one — it aborts a conflicting merge and evaluates as-is
    (``auto_merge._story_worktree``) — so the residual needs an actor who can commit
    into the worktree directly, which is a strictly larger breach than this gate.
    """
    if not head_sha or not _SHA_RE.match(head_sha.strip()):
        return None, f"head_sha={head_sha!r} is not a commit id"
    head_sha = head_sha.strip()
    for ref in _base_refs(base_branch):
        code, out, _err = _git(
            repo, "rev-list", "--no-merges", f"{head_sha}..HEAD", "--not", ref
        )
        if code == 0:
            extra = [line.strip() for line in out.splitlines() if line.strip()]
            return extra, f"rev-list --no-merges {head_sha[:12]}..HEAD --not {ref}"
    return None, f"no base ref resolved among {_base_refs(base_branch)!r}"


def resolve_base_sha(repo: Path, base_branch: str | None) -> tuple[str | None, str]:
    """``merge-base(<base ref>, HEAD)`` — the commit the story's work sits on.

    Tries ``origin/<base>`` first: that is the ref the merge itself is computed
    against, and the local branch of the same name can be arbitrarily stale in a
    worktree. Returns ``(sha, how)`` or ``(None, why-not)``.
    """
    tried: list[str] = []
    for ref in _base_refs(base_branch):
        code, out, _err = _git(repo, "merge-base", ref, "HEAD")
        tried.append(ref)
        if code == 0 and out.strip():
            return out.strip().splitlines()[0], f"merge-base({ref}, HEAD)"
    return None, f"no merge base against any of {tried!r}"


def changed_paths_since(repo: Path, base_sha: str) -> list[str] | None:
    """Repo-relative paths that differ between ``base_sha`` and HEAD (None on error)."""
    code, out, _err = _git(repo, "diff", "--name-only", "-z", f"{base_sha}..HEAD")
    if code != 0:
        return None
    return [p for p in out.split("\0") if p]


@contextmanager
def judge_worktree(repo: Path, committish: str, *, label: str = "judge") -> Iterator[tuple[Path | None, str]]:
    """A THROWAWAY detached checkout of ``committish``, outside the dev worktree.

    The point is that the tree we grade in is not the tree the dev works in:

    * nothing the dev leaves UNTRACKED (a stray ``conftest.py``, a ``.pth``, a
      ``sitecustomize.py``) exists here, because a fresh checkout has only
      tracked content;
    * the hidden acceptance oracle is copied in HERE, so it is never on disk
      inside the dev's worktree at all — no leak window, nothing for the chain's
      ``git add -A`` to stage;
    * uncommitted work is excluded by construction, so we grade the commit that
      will actually be merged rather than whatever the worktree happens to hold.

    Yields ``(path, "")`` on success and ``(None, why)`` on failure — callers
    must treat the failure as *cannot verify*, never as a pass. Cleaned up on
    exit, including the git registration (``worktree remove`` + ``prune``).
    """
    tmp: Path | None = None
    tree: Path | None = None
    try:
        try:
            tmp = Path(tempfile.mkdtemp(prefix=f"factory-{label}-"))
        except OSError as exc:
            yield None, f"could not create a temp dir: {exc}"
            return
        tree = tmp / "tree"
        code, _out, err = _git(
            repo, "worktree", "add", "--detach", str(tree), committish, timeout=300
        )
        if code != 0:
            yield None, f"git worktree add {committish} failed: {err.strip()[:300]}"
            return
        yield tree, ""
    finally:
        if tree is not None:
            _git(repo, "worktree", "remove", "--force", str(tree), timeout=120)
        if tmp is not None and tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        _git(repo, "worktree", "prune", timeout=60)


def restore_paths_from(
    tree: Path, sha: str, paths: Sequence[str]
) -> tuple[list[str], list[str], list[str]]:
    """Make ``paths`` inside ``tree`` identical to their state at ``sha``.

    Returns ``(restored, removed, failed)``. A path that does not exist at
    ``sha`` was ADDED by the diff and is deleted from ``tree``. ``failed`` must
    be treated as *cannot verify* by the caller: a channel we failed to restore
    is still under the diff's control.

    Symlinks are tested with :meth:`Path.is_symlink` BEFORE ``is_file`` /
    ``exists``, both of which follow the link. A BROKEN symlink — say the diff
    adds ``backend/tests/conftest.py -> ./generated.py`` and never generates it —
    answers False to both, so the old code reported it in ``removed`` while
    leaving it on disk: a path this function claims to have neutralised, still
    under the diff's control. (It could not forge a green, because pytest cannot
    read it either and the run goes red — but ``removed`` has to be true or the
    caller's "the diff no longer decides this" is not a fact.)
    """
    restored: list[str] = []
    removed: list[str] = []
    failed: list[str] = []
    for rel in paths:
        code, _out, _err = _git(tree, "cat-file", "-e", f"{sha}:{rel}")
        if code == 0:
            c, _o, _e = _git(tree, "checkout", sha, "--", rel)
            (restored if c == 0 else failed).append(rel)
            continue
        target = tree / rel
        try:
            if target.is_symlink() or target.is_file():
                target.unlink()
                removed.append(rel)
            elif not target.exists():
                removed.append(rel)
            else:
                # A directory where the diff put one. Never removed blindly.
                failed.append(rel)
        except OSError:
            failed.append(rel)
    return restored, removed, failed


# --------------------------------------------------------------------------- #
# pyproject.toml — a pytest ini source AND the dependency manifest
# --------------------------------------------------------------------------- #
#
# THE ONE FILE THE ROLLBACK MUST NOT REVERT WHOLESALE (2026-08-05)
#
# ``restore_paths_from`` reverts every path in the rollback set — the complement
# of ``is_production_path`` — to the merge base, and ``pyproject.toml`` is in that
# set because ``[tool.pytest.ini_options] addopts`` is a real forced-pass channel.
# But the same file is the DEPENDENCY MANIFEST, and an app's acceptance command
# resolves its environment from it: sacrifice runs
# ``uv run --extra dev pytest {test_file} -q`` with cwd ``backend``, and ``uv``
# reads exactly the file we reverted.
#
# MEASURED CONSEQUENCE: a story that adds a dependency, with a CORRECT
# implementation, produced ``passed=False, authoritative=True,
# reason="ran independent acceptance oracle exit_code=2"`` — the oracle died at
# collection on the dependency the story itself declares. ``authoritative`` means
# the gate blames the dev and re-dispatches with an identical failure signature, at
# $2+ per cycle, which is the non-convergence loop the gate's own comments warn
# about. The whole-file rollback INTRODUCED that: before it, the oracle ran in the
# dev's worktree where HEAD's dependencies were present.
#
# THE OPERATOR DECISION: separate the file's two roles. **Dependencies come from
# HEAD; pytest configuration comes from the merge base.** ``[project]``,
# ``[project.optional-dependencies]``, ``[tool.uv]``, ``[build-system]`` and every
# other table stay at HEAD; only ``[tool.pytest.*]`` is rolled back.
#
# ⚠ THE COST, STATED PLAINLY: the rollback set is no longer the clean complement
# of ``is_production_path``. ``pyproject.toml`` is a DOCUMENTED SPECIAL CASE, and
# that loss of uniformity is the price of the fix — a future reader widening either
# path classifier gets the rest of the set for free but must remember this file has
# its own handler.
#
# WHY NOT ``pytest -c <factory-owned ini>``, the more uniform-looking option.
# Measured 2026-08-05 against the real attack from the review: ``-c`` DOES fully
# neutralise the repo's ``[tool.pytest.ini_options]`` — ``addopts = "-p _fixup"``
# stops loading the plugin and the forced pass dies — and a conftest under the run
# cwd still loads. But an EMPTY factory-owned ini also discards
# ``asyncio_mode = "auto"``, and pytest then reports "async def functions are not
# natively supported" for every ``async def`` test. sacrifice is a FastAPI app whose
# shipped ``acceptance_harness_hint`` tells the dev-blind acceptance author that
# ``asyncio_mode = auto`` is set and ``async def`` tests need no decorator, so that
# is a false block on the app's normal oracle shape — the exact class of substrate
# mismatch that made this subsystem false-block 100% of stories the first time it
# ran. Filling the ``-c`` file from the merge base instead of leaving it empty does
# work (measured: ``mode=Mode.AUTO`` preserved, rootdir unchanged when the file sits
# beside the real one), but it buys the same semantics as the splice below for
# strictly more machinery: an ``env``/command channel threaded through
# ``evaluator._run_command`` AND ``mutation._run_suite`` so both routes get the
# flag, a dependence on the APP's pytest being new enough to accept ``-c`` with a
# ``.toml``, and a silent no-op for any app whose command is not a direct pytest
# invocation. The splice needs none of that and is verified against ``tomllib``
# before it is trusted.
#
# ⚠ WHAT TAKING DEPENDENCIES FROM HEAD NECESSARILY ADMITS. A dependency is code,
# and pytest auto-loads any installed distribution advertising a ``pytest11`` entry
# point. So ``dependencies = ["evil @ file:./tools/evil"]`` at HEAD is a forced-pass
# channel that no rollback of this file can close, and ``-c`` would not close it
# either (entry-point autoload does not read the ini). It is the same class as the
# in-process hole documented in ``gates/acceptance_verified``'s docstring and pinned
# by ``test_KNOWN_OPEN_production_code_can_patch_pytest_in_process``: dev-controlled
# code executing in the interpreter that computes the verdict. It is one more reason
# ``gates.acceptance_oracle`` stays OFF.

DEP_MANIFEST_NAME = "pyproject.toml"
_PYTEST_TABLE_PREFIX = "tool.pytest"


def is_dependency_manifest(path: str) -> bool:
    """True for a rollback path that is also the dependency manifest.

    Only ``pyproject.toml``. ``setup.cfg`` and ``tox.ini`` can carry dependency
    metadata too, but no app in this repo resolves an acceptance command's
    environment from them, and widening this predicate widens the surface that
    keeps HEAD's content — the permissive direction. Add to it only with a
    measurement.
    """
    return Path(path.strip().replace("\\", "/")).name == DEP_MANIFEST_NAME


def _advance_toml_string_state(line: str, state: str | None) -> str | None:
    """Track whether a TOML multi-line string is open at the END of ``line``.

    A ``[header]`` at column 0 inside ``description = \"\"\"…\"\"\"`` is legal TOML
    content, not a table, so the table scanner has to know where strings are. Not a
    complete TOML lexer — ``rollback_pytest_config_only`` re-parses its own output
    with ``tomllib`` and refuses to trust a result this scanner got wrong, so the
    failure mode is a fail-safe block rather than a bad splice.
    """
    i, n = 0, len(line)
    while i < n:
        if state is not None:
            j = line.find(state, i)
            if j == -1:
                return state
            i, state = j + 3, None
            continue
        ch = line[i]
        if ch == "#":
            return None
        if line.startswith('"""', i) or line.startswith("'''", i):
            state = line[i : i + 3]
            i += 3
            continue
        if ch in ('"', "'"):
            quote, i = ch, i + 1
            while i < n:
                if quote == '"' and line[i] == "\\":
                    i += 2
                    continue
                if line[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        i += 1
    return state


def _toml_table_spans(text: str) -> list[tuple[str, int, int]]:
    """``(header, first_line, last_line_exclusive)`` for each top-level TOML table."""
    lines = text.splitlines(keepends=True)
    starts: list[tuple[str, int]] = []
    state: str | None = None
    for idx, raw in enumerate(lines):
        if state is None:
            stripped = raw.lstrip()
            if stripped.startswith("["):
                if stripped.startswith("[["):
                    end = stripped.find("]]")
                    name = stripped[2:end].strip() if end != -1 else ""
                else:
                    end = stripped.find("]")
                    name = stripped[1:end].strip() if end != -1 else ""
                if name:
                    starts.append((name, idx))
        state = _advance_toml_string_state(raw, state)
    spans: list[tuple[str, int, int]] = []
    for pos, (name, start) in enumerate(starts):
        stop = starts[pos + 1][1] if pos + 1 < len(starts) else len(lines)
        spans.append((name, start, stop))
    return spans


def _is_pytest_table(header: str) -> bool:
    h = header.strip().replace('"', "").replace("'", "").replace(" ", "")
    return h == _PYTEST_TABLE_PREFIX or h.startswith(f"{_PYTEST_TABLE_PREFIX}.")


def _split_pytest_tables(text: str) -> tuple[str, str]:
    """``(text without its [tool.pytest.*] tables, just those tables)``."""
    lines = text.splitlines(keepends=True)
    drop: set[int] = set()
    taken: list[str] = []
    for header, start, stop in _toml_table_spans(text):
        if _is_pytest_table(header):
            drop.update(range(start, stop))
            taken.append("".join(lines[start:stop]))
    kept = "".join(line for idx, line in enumerate(lines) if idx not in drop)
    return kept, "".join(taken)


def _pytest_config(doc: dict[str, object]) -> object:
    tool = doc.get("tool")
    return tool.get("pytest") if isinstance(tool, dict) else None


def _without_pytest_config(doc: dict[str, object]) -> dict[str, object]:
    """``doc`` minus ``tool.pytest``, with an emptied ``tool`` table dropped.

    Dropping the emptied table matters: a manifest whose only ``[tool.*]`` entry is
    ``[tool.pytest.ini_options]`` parses to no ``tool`` key at all once the tables
    are removed, and comparing that against ``{"tool": {}}`` would fail the
    verification below on a perfectly good splice.
    """
    out = {k: v for k, v in doc.items() if k != "tool"}
    tool = doc.get("tool")
    if isinstance(tool, dict):
        rest = {k: v for k, v in tool.items() if k != "pytest"}
        if rest:
            out["tool"] = rest
    return out


def rollback_pytest_config_only(tree: Path, sha: str, rel: str) -> tuple[bool, str]:
    """Roll back ONLY ``[tool.pytest.*]`` inside ``rel``; keep the rest at HEAD.

    ``(True, what-happened)`` / ``(False, why-not)``. A ``False`` is *cannot
    verify* — the caller must block on it, non-authoritatively, exactly as it does
    for a channel it failed to restore.

    The result is VERIFIED before it is written back: the new document's pytest
    configuration must equal the base's, and every other table must still equal
    HEAD's. Both halves matter and they fail in opposite directions — the first
    catches a neutralisation that did not happen (``[tool]`` with dotted
    ``pytest.ini_options.addopts`` keys walks past the table scanner), the second
    catches a splice that ate a dependency. Anything the scanner got wrong shows up
    as a mismatch and blocks, so a text-level edit is safe to make here.
    """
    import tomllib

    target = Path(tree) / rel
    if target.is_symlink():
        # REFUSED, not followed. ``read_text`` and ``write_text`` both follow a
        # symlink: reading one would take the judge run's dependency set from a file
        # that is not part of the merge candidate (the link may point outside the tree
        # entirely), and writing one would put the spliced manifest there. "Grade the
        # merge candidate or grade nothing" is this gate's D2 property; a symlinked
        # manifest is neither, and no real project ships one.
        return False, (
            f"{rel} is a SYMLINK in the judge tree — its dependency set is not "
            "demonstrably part of the merge candidate, and splicing it would write "
            "through the link"
        )
    if not target.exists():
        # The diff DELETES the manifest. There is no HEAD pytest config left to
        # neutralise, and restoring the base's would resurrect a file the story
        # removed on purpose.
        return True, f"{rel} does not exist at HEAD (deleted by the diff); nothing to do"
    try:
        head_text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"could not read {rel} in the judge tree ({exc})"

    code, base_text, _err = _git(tree, "show", f"{sha}:{rel}")
    base_exists = code == 0
    if not base_exists:
        base_text = ""

    kept, _head_tables = _split_pytest_tables(head_text)
    _base_kept, base_tables = _split_pytest_tables(base_text)
    spliced = kept if kept.endswith("\n") or not kept else kept + "\n"
    spliced += base_tables

    try:
        head_doc = tomllib.loads(head_text)
        base_doc = tomllib.loads(base_text) if base_exists else {}
        new_doc = tomllib.loads(spliced)
    except tomllib.TOMLDecodeError as exc:
        return False, f"{rel} is not parseable TOML, so its two roles cannot be split ({exc})"

    if _pytest_config(new_doc) != _pytest_config(base_doc):
        return False, (
            f"{rel}: the pytest configuration after the splice is not the merge base's "
            "(config expressed as dotted keys in another table?), so the diff would "
            "still decide how the oracle is collected"
        )
    if _without_pytest_config(new_doc) != _without_pytest_config(head_doc):
        return False, (
            f"{rel}: splicing the base's pytest tables in changed something else in the "
            "manifest, so the dependency set is no longer HEAD's"
        )

    try:
        target.write_text(spliced, encoding="utf-8")
    except OSError as exc:
        return False, f"could not write the split {rel} ({exc})"
    return True, (
        f"{rel}: [tool.pytest.*] from {sha[:12]}, every other table from HEAD"
        if base_tables
        else f"{rel}: [tool.pytest.*] removed (absent at {sha[:12]}), every other table from HEAD"
    )


# --------------------------------------------------------------------------- #
# a tiny keyed cache (a base run is pure in (base sha, test source, command))
# --------------------------------------------------------------------------- #


def run_key(*parts: str) -> str:
    """A stable cache key over everything a run's result depends on."""
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8", errors="replace"))
        h.update(b"\0")
    return h.hexdigest()


def cache_get(path: Path, key: str) -> dict[str, object] | None:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - a missing/corrupt cache is simply a miss
        return None
    entry = raw.get(key) if isinstance(raw, dict) else None
    return entry if isinstance(entry, dict) else None


def cache_put(path: Path, key: str, value: dict[str, object], *, keep: int = 10) -> None:
    """Best-effort write of one cache entry, keeping the ``keep`` newest."""
    try:
        p = Path(path)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raw = {}
        except Exception:  # noqa: BLE001
            raw = {}
        raw[key] = {**value, "recorded_at": time.time()}
        if len(raw) > keep:
            ordered = sorted(
                raw.items(),
                key=lambda kv: float(kv[1].get("recorded_at", 0) or 0)
                if isinstance(kv[1], dict)
                else 0.0,
                reverse=True,
            )
            raw = dict(ordered[:keep])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(raw, indent=2, sort_keys=True), encoding="utf-8")
    except OSError:
        _log.debug("red_green cache write failed for %s", path)


# --------------------------------------------------------------------------- #
# per-criterion crediting (019 AC2/AC3 — the gutted-implementation control)
# --------------------------------------------------------------------------- #
#
# Under the out-of-process runner, "is this oracle able to fail" is no longer a
# single whole-file verdict: a criterion set with one real assertion and nine
# tautologies must credit only the real one. ``CriterionOutcome`` is the
# per-criterion vocabulary (junit-derived), and :func:`verdict_over`
# generalises :func:`base_verdict` to grade the merge-base run over a SUBSET of
# criteria — the set ``K`` that survived the stub exclusion
# (``gates.acceptance_verified``: HEAD == PASS *and* stub in {FAIL, ERROR}).
#
# ``base_verdict`` itself is UNTOUCHED. CORRECTION (2026-08-07, found by an
# adversarial review): an earlier version of this note claimed "the swebench
# arm" calls it — checked, and that is FALSE. As of this writing NOTHING in
# this codebase calls ``base_verdict`` except its own unit test
# (``tests/test_acceptance_oracle_green_means_something.py::test_base_verdict``);
# ``gates.acceptance_verified`` calls ``verdict_over`` exclusively. It is kept
# (not deleted) because it answers the whole-file question directly for any
# FUTURE caller that never adopts per-criterion crediting — ``verdict_over``
# is a generalisation, not a replacement, and the whole-file question is
# still a coherent thing to ask. Its unit test is what gives it a caller at
# all right now; do not let that test rot to "restore" status again.

CriterionOutcome = Literal["PASS", "FAIL", "ERROR", "SKIP", "MISSING"]


def verdict_over(credited: Sequence[str] | set[str], base: dict[str, str]) -> tuple[BaseVerdict, str]:
    """Grade the merge-base run restricted to the credited criterion set ``K``.

    ``credited`` is ``K`` (every criterion the caller has already established
    passes at HEAD and fails the gutted-implementation stub). ``base`` is the
    per-criterion outcome map from the merge-base run (``MISSING`` for any key
    ``base`` never reported — e.g. the module does not exist there at all).

    * ``red`` — at least one credited criterion **FAILED** at the base. Same
      "at least one, not all" caveat as :func:`base_verdict`: a criterion set
      testing several ACs legitimately has some already-passing at the base.
    * ``green`` — every credited criterion already PASSES at the base, so
      nothing in ``K`` discriminates this diff.
    * ``unknown`` — neither of the above: an ``ERROR``/``SKIP``/``MISSING``
      mix with no ``FAIL``. An ``ERROR`` is deliberately NOT counted as red
      here for the same reason :func:`base_verdict` excludes it — a criterion
      that could not even be OBSERVED at the base is not evidence that its
      assertion discriminates anything.
    * ``K`` empty ⇒ ``unknown`` (belt-and-braces; the caller's own
      ``vacuous_oracle`` check at the stub stage should already have caught an
      empty ``K`` before paying for a base boot at all).
    """
    keys = list(credited)
    if not keys:
        return "unknown", "no criterion survived the stub exclusion (the credited set K is empty)"
    outcomes = [base.get(c, "MISSING") for c in keys]
    failed = [c for c, o in zip(keys, outcomes, strict=True) if o == "FAIL"]
    if failed:
        return "red", f"{len(failed)} credited criterion/criteria FAILED at the merge base: {failed[:5]}"
    if all(o == "PASS" for o in outcomes):
        return "green", "every credited criterion ALREADY PASSES at the merge base"
    return "unknown", (
        "the credited criteria are not uniformly PASS at the base, but none FAILED either "
        "(ERROR/SKIP/MISSING only) — not proof of failability"
    )


__all__ = [
    "DEP_MANIFEST_NAME",
    "TIMEOUT_EXIT_CODE",
    "BaseVerdict",
    "CriterionOutcome",
    "PytestSummary",
    "RunStatus",
    "base_verdict",
    "cache_get",
    "cache_put",
    "changed_paths_since",
    "classify_pytest_run",
    "extra_commits_beyond",
    "head_contains_sha",
    "head_sha",
    "is_dependency_manifest",
    "judge_worktree",
    "parse_pytest_summary",
    "resolve_base_sha",
    "restore_paths_from",
    "rollback_pytest_config_only",
    "run_key",
    "verdict_over",
]
