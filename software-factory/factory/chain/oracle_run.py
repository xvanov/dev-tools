"""Run the acceptance oracle OUT OF PROCESS, over HTTP (019 AC3).

Two jobs, and both exist because the oracle's own process must never be the
thing computing the verdict about the diff's code:

1. :func:`oracle_import_check` — a STATIC, pre-run check that the stored oracle
   source imports only the standard library, ``httpx``, and ``pytest``. A
   legacy import-form oracle (``from app.mod import normalize_email``) is
   rejected here, before a single boot is paid for — the whole reason this
   subsystem exists is that importing the diff's code puts it in the
   interpreter that grades it, which is exactly what a hostile diff can
   subvert (``_pytest.python.Function.runtest = lambda self: None``, the
   attack ``tests/test_acceptance_oracle_green_means_something.py`` pins).
   This is a MISTAKE detector, not a sandbox: a spec-blind author has no
   reason to import app code at all when it must drive the app over HTTP, so
   catching it here turns "the author regressed to the old shape" into a
   retried authoring attempt rather than a silent hole.

2. :func:`run_oracle` — runs the (allowlisted) oracle file in a FACTORY-OWNED
   pytest invocation: its own temp cwd, its own (empty) ini, ``--rootdir``/
   ``--confcutdir``/``--noconftest`` pinned to that temp dir, a scrubbed
   environment with no ``PYTHONPATH``. None of the diff's ``conftest.py`` /
   ``pyproject.toml`` / ``tests/__init__.py`` attacks documented in the
   in-process module's history are reachable by pytest's OWN collection —
   none of those files are anywhere on this process's collection path.

⚠ WHAT THAT PARAGRAPH DOES **NOT** CLOSE (found 2026-08-07 by an adversarial
review, reproduced twice against this exact module). The oracle's tmpdir is a
same-user, same-machine, discoverable location: HEAD's production code is
BOOTED (imported) before the oracle ever runs, so it can run a background
thread that polls for a fresh ``factory-oracle-run-*`` directory and (a)
PLANTS a ``conftest.py`` there — ``--noconftest`` below closes exactly this —
or (b) OVERWRITES the oracle source file itself, keeping the same
``test_*`` function names so the junit node ids (and therefore the credited
set ``K``) survive untouched. Neither attack needs root, a shared filesystem,
or anything but the ordinary ability to list ``/tmp`` and open files the
current unix user owns — **the isolation boundary this module provides is
PROCESS, not PRIVILEGE**. Closing (b) needs a different mechanism than
"don't collect files you didn't ask for": it needs to know, AFTER the run,
that the file it asked pytest to grade is the file it is now reading the
verdict from. That is :func:`_tamper_check` — the load-bearing half of this
module, not a nice-to-have. A different uid (or a container) per boot is the
v1.1 closure that removes the same-user assumption entirely; until then this
module's own after-the-fact check is what makes a same-user attack SELF-
DEFEATING rather than merely inconvenient (see ``gates.acceptance_verified``'s
``oracle_run_tampered`` — never waivable, always authoritative).

The result carries a PER-CRITERION outcome map (junit-derived, keyed
``classname::name``) alongside the aggregate summary, because the
gutted-implementation control (AC2) grades criteria individually: a set with
one real assertion and nine tautologies must credit only the real one.
"""

from __future__ import annotations

import ast
import hashlib
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from factory.chain.red_green import TIMEOUT_EXIT_CODE, PytestSummary, classify_pytest_run

#: Bumped whenever THIS module's runner behaviour changes materially (argv,
#: isolation, allowlist) — joins ``STUB_VERSION`` in the stub-run cache key so
#: a cached stub verdict from an older runner is never reused as current.
#: Bumped 2026-08-07: ``--noconftest`` + the post-run tamper check.
RUNNER_VERSION = 2

# stdlib ∪ {httpx, pytest}. ``sys.stdlib_module_names`` (3.10+) is the
# authoritative, version-matched list — no hand-maintained set to fall behind.
# NOTE (found 2026-08-07): this is a MISTAKE detector, not a sandbox. It walks
# ``ast.Import``/``ast.ImportFrom`` nodes; ``__import__("app.mod")``,
# ``importlib.import_module("app.mod")`` and a bare ``exec("import app.mod")``
# are all valid stdlib calls that never appear as an import node and so are
# invisible to this walk. Nothing here claims otherwise any more — an author
# who writes those forms on purpose is not the threat model this catches (a
# spec-blind persona that regressed to the OLD in-process shape); an attacker
# who controls the AUTHOR is a different, unaddressed problem.
_ALLOWED_EXTRA = frozenset({"httpx", "pytest"})

OracleStatus = Literal[
    "pass", "fail", "vacuous", "unreadable", "conflicting", "blocked_imports", "tampered",
]


@dataclass
class OracleRun:
    status: OracleStatus
    summary: PytestSummary | None
    criteria: dict[str, str] = field(default_factory=dict)  # nodeid -> PASS/FAIL/ERROR/SKIP
    exit_code: int = -1
    output: str = ""
    junit_ok: bool = False
    command: str = ""
    # A3 (arrange/assert split): nodeids whose junit failure MESSAGE carries
    # the author-side "SETUP:" prefix — the harness could not arrange the
    # scenario (register/login/create-prerequisite failed), which is a
    # category apart from "the feature's observable is wrong". Advisory:
    # nothing here changes an outcome in ``criteria``.
    setup_failures: list[str] = field(default_factory=list)


def oracle_import_check(src: str) -> str | None:
    """``None`` when ``src`` imports only stdlib/httpx/pytest; else the reason.

    Runs BEFORE any boot is paid for, and is never bypassable by a valid
    program that merely avoids naming the disallowed module directly at
    module scope — ``ast.walk`` finds every ``Import``/``ImportFrom`` node
    regardless of nesting (inside a function, a conditional, a try/except).
    A relative import (``from . import x``) is always rejected: there is no
    package context this oracle ever legitimately belongs to.
    """
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return f"oracle is not valid python: {exc}"

    allowed = set(sys.stdlib_module_names) | _ALLOWED_EXTRA
    bad: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".", 1)[0]
                if top not in allowed:
                    bad.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                bad.add("." * node.level + (node.module or ""))
                continue
            top = (node.module or "").split(".", 1)[0]
            if top and top not in allowed:
                bad.add(node.module or "<relative>")
    if not bad:
        return None
    return (
        f"oracle imports non-allowlisted module(s) {sorted(bad)!r} — the "
        "out-of-process oracle may import only the standard library, httpx, "
        "and pytest; it must drive the app over HTTP, never by importing its code"
    )


def _oracle_env(*, base_url: str, run_id: str) -> dict[str, str]:
    """A deliberately MINIMAL environment. No ``PYTHONPATH`` — ever — is the
    point: the oracle's cwd is a bare temp directory with nothing else in it,
    but a stray ``PYTHONPATH`` inherited from the caller could still put an
    app package on ``sys.path``. Belt-and-braces alongside the static check."""
    import os

    env: dict[str, str] = {}
    for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"):
        val = os.environ.get(key)
        if val is not None:
            env[key] = val
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["ACCEPTANCE_BASE_URL"] = base_url
    env["ACCEPTANCE_RUN_ID"] = run_id
    return env


def _sha256_file(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _tamper_check(tmpdir: Path, oracle_path: Path, pre_sha: str, expected_names: set[str]) -> str | None:
    """``None`` if the run dir looks exactly as this module left it; else why not.

    Two independent checks, because either alone is beatable:

    * the oracle FILE's content must be byte-identical to what was written
      before the run (closes attack B: overwriting the file in place while
      keeping the same ``test_*`` names so junit node ids — and therefore the
      credited set ``K`` — survive);
    * the run dir's entry set must be EXACTLY what this module created (closes
      any OTHER file dropped alongside it — a planted ``conftest.py`` that
      ``--noconftest`` did not stop for some pytest version, a ``sitecustomize.py``,
      anything). Checked by NAME, not content, deliberately over-inclusive:
      a legitimate ``__pycache__`` would also trip this, which is why ``-B``
      (no bytecode) is load-bearing for this check too, not just for hygiene.

    Called BEFORE junit is ever parsed — a tampered run dir means the junit
    file itself is not trustworthy either.
    """
    post_sha = _sha256_file(oracle_path)
    if post_sha != pre_sha:
        return (
            f"the oracle file changed during the run (sha {pre_sha[:12]} -> "
            f"{post_sha[:12] if post_sha else 'MISSING'}) — something else wrote to "
            "the run directory while pytest was executing"
        )
    try:
        actual_names = {p.name for p in tmpdir.iterdir()}
    except OSError as exc:
        return f"could not list the run directory after the run ({exc})"
    extra = actual_names - expected_names
    missing = expected_names - actual_names
    if extra or missing:
        return (
            f"the run directory does not contain exactly the expected files "
            f"(extra={sorted(extra)!r}, missing={sorted(missing)!r}) — something else "
            "wrote into or removed from it while pytest was executing"
        )
    return None


#: Author-side marker for arrange-step failures (A3). The authoring prompt
#: instructs setup helpers to ``pytest.fail(f"SETUP: ...")`` on any unexpected
#: response — such a failure means the harness could not ARRANGE the scenario,
#: not that the feature under acceptance is wrong.
SETUP_FAILURE_PREFIX = "SETUP:"


def _parse_junit(path: Path) -> tuple[dict[str, str], list[str]] | None:
    """``({nodeid: PASS|FAIL|ERROR|SKIP}, [setup-failure nodeids])`` from a
    junit-xml file, or ``None`` if it cannot be parsed at all (missing,
    truncated, not XML).

    A nodeid lands in the setup list when its failure/error message starts
    with :data:`SETUP_FAILURE_PREFIX` — purely diagnostic; the outcome map is
    byte-identical to what it was before the split existed.
    """
    try:
        tree = ET.parse(path)  # noqa: S314 - our own runner's own output file
    except (OSError, ET.ParseError):
        return None
    root = tree.getroot()
    suite = root if root.tag == "testsuite" else root.find("testsuite")
    if suite is None:
        return {}, []
    out: dict[str, str] = {}
    setup_keys: set[str] = set()
    for case in suite.iter("testcase"):
        classname = case.get("classname", "")
        name = case.get("name", "")
        key = f"{classname}::{name}" if classname else name
        problem = case.find("failure")
        if problem is None:
            problem = case.find("error")
        if problem is not None:
            out[key] = "FAIL" if case.find("failure") is not None else "ERROR"
            # pytest renders ``pytest.fail("SETUP: ...")`` as message
            # "Failed: SETUP: ..." (and, from inside a fixture, as
            # 'failed on setup with "Failed: SETUP: ..."'). Match by
            # STARTSWITH on those exact author-side shapes — never by
            # substring: a bare assert's junit first line is the REPR OF THE
            # APP'S RESPONSE (`assert {'detail': 'SETUP: db down'} == ...`),
            # i.e. production-controlled text, and a contains-match would let
            # the app under test classify a genuine feature failure as an
            # arrange failure (proxy ≠ real: the classifier's input must be
            # the author's intent, not the response body).
            message = (problem.get("message") or "").strip() or (problem.text or "").strip()
            first_line = message.splitlines()[0] if message else ""
            is_setup = first_line.startswith(
                (
                    SETUP_FAILURE_PREFIX,
                    f"Failed: {SETUP_FAILURE_PREFIX}",
                    f'failed on setup with "Failed: {SETUP_FAILURE_PREFIX}',
                )
            )
            # Per-key, last-write-wins alignment with ``out`` — a rerun
            # plugin replaying a nodeid must not leave a stale setup mark
            # from an earlier attempt.
            if is_setup:
                setup_keys.add(key)
            else:
                setup_keys.discard(key)
        elif case.find("skipped") is not None:
            out[key] = "SKIP"
        else:
            out[key] = "PASS"
    return out, sorted(setup_keys)


#: Ceiling for the authoring-time collection smoke. Measured cost is
#: 0.2-0.5 s; anything near this bound means module-level code is doing real
#: work (a loop, a network wait), which an oracle must never do before its
#: fixtures run — so the bound is deliberately tight (2 attempts × 10 stories
#: at a loose bound is a dead tick, and a slow collect IS a defect signal).
COLLECT_CHECK_TIMEOUT_S = 15


def oracle_collect_check(src: str, *, timeout_s: int = COLLECT_CHECK_TIMEOUT_S) -> str | None:
    """``None`` when pytest can COLLECT ``src`` cleanly; else the reason.

    ``ast.parse`` cannot see a collection-time NameError: ``@pytestFixture``
    (story 186, 2026-08-10) is valid *syntax* whose name only resolves at
    import, so the stored oracle sailed through authoring validation and was
    discovered at MERGE time as ``vacuous_oracle`` — after full dev spend.
    Running the runner's own collection here (same interpreter, same scrubbed
    env, same isolation flags as :func:`run_oracle`) turns that class into a
    retried AUTHOR attempt at authoring cost instead.

    The env carries dummy ``ACCEPTANCE_BASE_URL`` / ``ACCEPTANCE_RUN_ID``
    values so a module-level ``os.environ[...]`` read — a legitimate oracle
    shape — does not KeyError; no app is booted and nothing is exercised.

    Fail-SAFE: an inability to RUN the check (pytest missing from this
    interpreter, timeout, OSError — including a failed mkdtemp) is reported as
    a failure, never waved through — a broken validator must block. STATED
    TRADE-OFF (adversarial review 2026-08-10): an environment fault therefore
    burns author passes exactly like a bad oracle does, and a fault lasting
    ≥3 tick self-heals wedges the story at ``author_exhausted`` until
    ``factory resume-story --reauthor-oracle``. That is chosen over the
    alternative — not charging the pass — because an uncharged environment
    failure retries the FULL LLM authoring call every tick, unbounded, which
    violates both the loop cap and the spend rules. The wedge is visible
    (``author_exhausted`` reaches ``factory inbox``) and has a one-command
    path back; unbounded spend has neither.
    """
    try:
        tmpdir = Path(tempfile.mkdtemp(prefix="factory-oracle-collect-"))
    except OSError as exc:
        return f"could not create the collect-check directory ({exc!r}) — environment fault, failing SAFE"
    try:
        oracle_path = tmpdir / "test_acceptance.py"
        oracle_path.write_text(src, encoding="utf-8")
        ini_path = tmpdir / "factory_oracle.ini"
        ini_path.write_text("[pytest]\n", encoding="utf-8")
        argv = [
            sys.executable, "-B", "-m", "pytest", str(oracle_path),
            "--collect-only", "-q", "-p", "no:cacheprovider", "--noconftest",
            "-c", str(ini_path),
            "--rootdir", str(tmpdir), "--confcutdir", str(tmpdir),
        ]
        env = _oracle_env(base_url="http://127.0.0.1:9", run_id="authoring-collect-check")
        try:
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                argv, cwd=str(tmpdir), env=env,
                capture_output=True, text=True, timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            return (
                f"pytest collection did not finish within {timeout_s}s — module-level "
                "code must not do real work before fixtures run (or the machine is "
                "badly overloaded — environment fault, failing SAFE)"
            )
        except OSError as exc:
            return (
                f"could not run pytest collection at all ({exc!r}) — "
                "environment fault, failing SAFE"
            )
        if proc.returncode != 0:
            tail = (proc.stdout + proc.stderr)[-2000:]
            return (
                f"pytest --collect-only exited {proc.returncode} — the oracle cannot be "
                "collected (a NameError/ImportError at import time, or module-level "
                f"code that needs the live app, which does not exist yet here):\n{tail}"
            )
        return None
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


def run_oracle(
    oracle_src: str,
    *,
    base_url: str,
    run_id: str,
    dest_name: str,
    timeout_s: int,
) -> OracleRun:
    """Run ``oracle_src`` against ``base_url`` in a throwaway, factory-owned tree.

    Isolation: its own temp cwd (nothing else on disk there), its own EMPTY
    pytest ini passed via ``-c`` (the app's ``pyproject.toml``/``pytest.ini``,
    wherever it lives, is never on this run's collection path at all),
    ``--rootdir``/``--confcutdir`` pinned to that temp dir so nothing above it
    is walked for a ``conftest.py``, and a scrubbed environment with no
    ``PYTHONPATH``. ``-B`` disables bytecode; ``-p no:cacheprovider`` disables
    ``.pytest_cache`` — neither leaves a trace naming the hidden oracle.

    Junit (via ``--junitxml``) is the PRIMARY source of per-criterion outcomes;
    the stdout summary is a cross-check (:func:`classify_pytest_run`), and a
    count mismatch between the two — or two distinct stdout summaries — flips
    the status to ``conflicting``, never silently trusting whichever line was
    read.
    """
    problem = oracle_import_check(oracle_src)
    if problem:
        return OracleRun(status="blocked_imports", summary=None, output=problem)

    tmpdir = Path(tempfile.mkdtemp(prefix="factory-oracle-run-"))
    try:
        oracle_path = tmpdir / dest_name
        oracle_path.write_text(oracle_src, encoding="utf-8")
        pre_sha = _sha256_file(oracle_path) or ""
        ini_path = tmpdir / "factory_oracle.ini"
        ini_path.write_text("[pytest]\n", encoding="utf-8")
        junit_path = tmpdir / "junit.xml"
        expected_names = {oracle_path.name, ini_path.name, junit_path.name}

        argv = [
            sys.executable, "-B", "-m", "pytest", str(oracle_path),
            "-q", "-p", "no:cacheprovider", "--noconftest",
            "-c", str(ini_path),
            "--rootdir", str(tmpdir), "--confcutdir", str(tmpdir),
            f"--junitxml={junit_path}",
        ]
        command_str = " ".join(argv)
        env = _oracle_env(base_url=base_url, run_id=run_id)

        try:
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                argv, cwd=str(tmpdir), env=env,
                capture_output=True, text=True, timeout=timeout_s,
            )
            exit_code, output = proc.returncode, (proc.stdout + proc.stderr)[-8000:]
        except subprocess.TimeoutExpired as exc:
            exit_code = TIMEOUT_EXIT_CODE

            def _decode(part: bytes | str | None) -> str:
                if part is None:
                    return ""
                return part.decode("utf-8", errors="replace") if isinstance(part, bytes) else part

            tail = _decode(exc.stdout) + _decode(exc.stderr)
            output = f"oracle run timed out after {timeout_s}s\n{tail}"[-8000:]

        # TAMPER CHECK — before junit is trusted at all. See the module
        # docstring: this is the load-bearing half of the isolation story, not
        # a nice-to-have layered on top of ``--noconftest``.
        tamper_why = _tamper_check(tmpdir, oracle_path, pre_sha, expected_names)
        if tamper_why:
            return OracleRun(
                status="tampered", summary=None, criteria={}, exit_code=exit_code,
                output=tamper_why, junit_ok=False, command=command_str,
            )

        status, summary = classify_pytest_run(exit_code, output)
        parsed = _parse_junit(junit_path)
        junit_ok = parsed is not None
        criteria, setup_failures = parsed if parsed is not None else ({}, [])

        if junit_ok and summary is not None and not summary.conflicting:
            counts = Counter(criteria.values())
            mismatch = (
                counts.get("PASS", 0) != summary.passed
                or counts.get("FAIL", 0) != summary.failed
                or counts.get("ERROR", 0) != summary.errors
            )
            if mismatch:
                status = "conflicting"

        return OracleRun(
            status=status, summary=summary, criteria=criteria,
            exit_code=exit_code, output=output, junit_ok=junit_ok, command=command_str,
            setup_failures=setup_failures,
        )
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


__all__ = [
    "COLLECT_CHECK_TIMEOUT_S",
    "RUNNER_VERSION",
    "SETUP_FAILURE_PREFIX",
    "OracleRun",
    "OracleStatus",
    "oracle_collect_check",
    "oracle_import_check",
    "run_oracle",
]
