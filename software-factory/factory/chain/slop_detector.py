"""Programmatic slop detector — scans test files for anti-patterns.

The detector is the safety net behind the ``tests-meaningful`` auto-merge
gate. It refuses to advance a PR whose tests are obviously empty:

  * ``assert True`` / ``assert False`` / ``assert 1 == 1`` — trivially
    green/red regardless of code under test.
  * ``assert x == x`` (reflexive) — same variable on both sides.
  * ``expect(x).toBe(x)`` and ``expect(true).toBe(true)`` in JS/TS.
  * ``pytest.raises`` blocks whose body re-raises the same exception they
    expect (the test catches its own throw).
  * "Asserted-on-a-just-assigned value" — ``x = 5; assert x == 5``.
  * "Mock-only assertion" — a test function whose only assertions touch
    ``mock.called`` / ``mock.assert_called*`` but never the subject's
    real return value.
  * Direct DB bootstrap in test files — calls to
    ``SQLModel.metadata.create_all``, ``sqlmodel.create_engine``, or
    ``sqlalchemy.create_engine`` that bypass the application's initializer.

The detector is intentionally precision-biased: false negatives are
preferable to false positives because a wrong rejection bounces a PR
back to Test-Designer, which costs budget. Edge cases the detector
deliberately skips:

  * tests that USE mocks but ALSO assert on real return values are not
    flagged — only mock-call-only tests are slop.
  * ``# noqa: slop`` on a single test suppresses the direct DB-bootstrap
    rule for that test only — an escape hatch when the raw engine path is
    itself the subject.

This module has zero LLM calls. It is pure programmatic scanning.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

# --------------------------------------------------------------------------- #
# Anti-pattern registries
# --------------------------------------------------------------------------- #

SLOP_REGEXES_PYTHON: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^\s*assert\s+True\s*(#.*)?$"), "assert True"),
    (re.compile(r"^\s*assert\s+False\s*(#.*)?$"), "assert False"),
    (re.compile(r"^\s*assert\s+1\s*==\s*1\s*(#.*)?$"), "assert 1 == 1"),
    (re.compile(r"^\s*assert\s+(\w+)\s*==\s*\1\s*(#.*)?$"), "assert x == x"),
]

SLOP_REGEXES_JS_TS: list[tuple[re.Pattern[str], str]] = [
    # Order matters: literal-keyword anti-patterns are listed first so they
    # take precedence over the generic ``expect(x).toBe(x)`` capture which
    # would also match ``expect(true).toBe(true)``.
    (re.compile(r"expect\(\s*true\s*\)\.toBe\(\s*true\s*\)"), "expect(true).toBe(true)"),
    (re.compile(r"expect\(\s*false\s*\)\.toBe\(\s*false\s*\)"), "expect(false).toBe(false)"),
    (re.compile(r"expect\(\s*1\s*\)\.toBe\(\s*1\s*\)"), "expect(1).toBe(1)"),
    (re.compile(r"expect\(\s*([A-Za-z_$][\w$.]*)\s*\)\.toBe\(\s*\1\s*\)"), "expect(x).toBe(x)"),
]

# Test-file path heuristic (used by ``scan_diff``).
_TEST_PATH_RE = re.compile(
    r"(^|/)(tests?/|test_[^/]*\.py$|[^/]*_test\.py$|[^/]*\.test\.tsx?$|[^/]*\.spec\.tsx?$)"
)


# --------------------------------------------------------------------------- #
# Result type
# --------------------------------------------------------------------------- #


@dataclass
class SlopFinding:
    """A single anti-pattern hit. ``code_excerpt`` is the offending source line
    (or a small window for AST-detected patterns)."""

    path: str
    line: int
    kind: str
    code_excerpt: str
    why_slop: str

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "line": self.line,
            "kind": self.kind,
            "code_excerpt": self.code_excerpt,
            "why_slop": self.why_slop,
        }


# --------------------------------------------------------------------------- #
# AST detection (Python only)
# --------------------------------------------------------------------------- #


def _noqa_slop_suppressed(
    fn: ast.FunctionDef | ast.AsyncFunctionDef, source_lines: list[str]
) -> bool:
    """True if the function carries ``# noqa: slop`` on its def line or any
    comment line immediately preceding it, or on any line inside its body."""
    # Check the def line itself
    if fn.lineno - 1 < len(source_lines):
        if "noqa: slop" in source_lines[fn.lineno - 1]:
            return True
    # Check the line immediately before the def (decorator-style)
    if fn.lineno - 2 >= 0:
        prev = source_lines[fn.lineno - 2].strip()
        if prev.startswith("#") and "noqa: slop" in prev:
            return True
    # Check lines inside the function body
    if fn.end_lineno is not None:
        for i in range(fn.lineno, min(fn.end_lineno, len(source_lines))):
            if "noqa: slop" in source_lines[i]:
                return True
    return False


def _ast_findings_python(path_str: str, source: str) -> list[SlopFinding]:
    """Walk Python source AST for the harder anti-patterns.

    Catches:
      * ``x = literal; assert x == literal``  (assert-on-just-set)
      * ``pytest.raises(X): raise X(...)``    (self-throwing raises)
      * "mock-only" test bodies — test function whose only assertions touch
        ``mock.called`` / ``mock.assert_called*`` and never compare real
        return values.
      * Direct DB bootstrap — ``SQLModel.metadata.create_all``,
        ``sqlmodel.create_engine``, ``sqlalchemy.create_engine`` in test files.
    """
    out: list[SlopFinding] = []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # Don't fail the gate on a syntactically-broken test file; the
        # downstream pytest gate will catch it.
        return out

    db_bootstrap_names = _collect_db_bootstrap_imports(tree)
    source_lines = source.splitlines()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith(
            "test_"
        ):
            out.extend(_assert_on_just_set(path_str, node))
            out.extend(_self_throwing_raises(path_str, node))
            out.extend(_mock_only_assertions(path_str, node))
            out.extend(_self_constructed_compare(path_str, node))
            out.extend(_direct_db_bootstrap(path_str, node, db_bootstrap_names, source_lines))
    return out


def _param_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Names bound as function parameters — pytest fixtures, ``self``/``cls``.

    A reference to one of these is treated as IMPURE (it may carry production
    behavior injected by pytest), so an assertion that touches a parameter is
    never flagged as self-constructed.
    """
    a = fn.args
    names = {p.arg for p in (*a.posonlyargs, *a.args, *a.kwonlyargs)}
    if a.vararg:
        names.add(a.vararg.arg)
    if a.kwarg:
        names.add(a.kwarg.arg)
    return names


def _is_pure_constructed(expr: ast.expr, local_pure: dict[str, ast.expr], params: set[str]) -> bool:
    """True if ``expr`` is built ENTIRELY inside the test from literals / f-strings
    / string concat / local names that are themselves pure — i.e. it involves NO
    call to production code, no fixture/param reference, no attribute/subscript on
    a non-pure value. Precision-biased: anything we don't recognise → impure.
    """
    if isinstance(expr, ast.Constant):
        return True
    if isinstance(expr, ast.JoinedStr):  # f-string
        return all(_is_pure_constructed(v, local_pure, params) for v in expr.values)
    if isinstance(expr, ast.FormattedValue):
        return _is_pure_constructed(expr.value, local_pure, params)
    if isinstance(expr, ast.BinOp) and isinstance(expr.op, (ast.Add, ast.Mod)):
        return _is_pure_constructed(expr.left, local_pure, params) and _is_pure_constructed(
            expr.right, local_pure, params
        )
    if isinstance(expr, (ast.Tuple, ast.List)):
        return all(_is_pure_constructed(e, local_pure, params) for e in expr.elts)
    if isinstance(expr, ast.Name):
        # A parameter (fixture) is impure; a local bound to a pure expr is pure.
        if expr.id in params:
            return False
        bound = local_pure.get(expr.id)
        return bound is not None and _is_pure_constructed(bound, local_pure, params)
    return False  # Call, Attribute, Subscript, Await, etc. → exercises something


def _contains_stringish(expr: ast.expr, local_pure: dict[str, ast.expr]) -> bool:
    """True if ``expr`` (resolving local names) is string-ish — an f-string, a
    str literal, or string concatenation. Keeps the check focused on the
    path/format/sentinel anti-pattern rather than numeric tautologies."""
    if isinstance(expr, ast.JoinedStr):
        return True
    if isinstance(expr, ast.Constant):
        return isinstance(expr.value, str)
    if isinstance(expr, ast.BinOp):
        return _contains_stringish(expr.left, local_pure) or _contains_stringish(
            expr.right, local_pure
        )
    if isinstance(expr, ast.Name):
        bound = local_pure.get(expr.id)
        return bound is not None and _contains_stringish(bound, local_pure)
    return False


def _eq_operands(node: ast.AST) -> tuple[ast.expr, ast.expr, int] | None:
    """Return ``(lhs, rhs, lineno)`` for an ``assert a == b`` or a
    ``*.assertEqual(a, b)`` / ``assertEqual(a, b)`` call; else None."""
    if isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare):
        cmp = node.test
        if len(cmp.ops) == 1 and isinstance(cmp.ops[0], ast.Eq):
            return cmp.left, cmp.comparators[0], node.lineno
        return None
    if isinstance(node, ast.Call) and len(node.args) >= 2:
        func = node.func
        name = (
            func.attr
            if isinstance(func, ast.Attribute)
            else (func.id if isinstance(func, ast.Name) else "")
        )
        if name in ("assertEqual", "assertEquals"):
            return node.args[0], node.args[1], getattr(node, "lineno", 0)
    return None


def _self_constructed_compare(
    path_str: str, fn: ast.FunctionDef | ast.AsyncFunctionDef
) -> list[SlopFinding]:
    """Flag the #1 hollow-test anti-pattern: an equality assertion where BOTH
    sides are values the TEST itself constructed (literals / f-strings / local
    pure names) and NEITHER side calls production code or touches a fixture.

    Example::

        expected = f"{base}/{goal_id}/file"
        path = f"{base}/{goal_id}/file"   # also built in the test
        assert path == expected            # passes even if production is absent

    Such a test verifies the test's own string-building, not the code under
    test. The check is precision-biased: if EITHER operand involves a call, a
    fixture/parameter, or an attribute/subscript on a non-literal, it is NOT
    flagged (it probably exercises real behavior).
    """
    params = _param_names(fn)
    # Names assigned exactly once to a pure expression (top-down; a name may
    # depend on earlier pure names). Names reassigned or assigned from impure
    # expressions are excluded so a later real call can't be mistaken for pure.
    local_pure: dict[str, ast.expr] = {}
    seen: set[str] = set()
    for stmt in ast.walk(fn):
        if (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
        ):
            nm = stmt.targets[0].id
            if nm in seen:
                local_pure.pop(nm, None)  # reassigned → no longer trustworthy
                continue
            seen.add(nm)
            if _is_pure_constructed(stmt.value, local_pure, params):
                local_pure[nm] = stmt.value

    out: list[SlopFinding] = []
    for node in ast.walk(fn):
        ops = _eq_operands(node)
        if ops is None:
            continue
        lhs, rhs, lineno = ops
        if (
            _is_pure_constructed(lhs, local_pure, params)
            and _is_pure_constructed(rhs, local_pure, params)
            and (_contains_stringish(lhs, local_pure) or _contains_stringish(rhs, local_pure))
        ):
            try:
                excerpt = f"assert {ast.unparse(lhs)} == {ast.unparse(rhs)}"[:120]
            except Exception:
                excerpt = "assert <test-built value> == <test-built value>"
            out.append(
                SlopFinding(
                    path=path_str,
                    line=lineno,
                    kind="self_constructed_compare",
                    code_excerpt=excerpt,
                    why_slop=(
                        "Both sides of this equality are strings the test itself "
                        "built (literals/f-strings); neither calls production "
                        "code. The test passes even if the implementation is "
                        "missing or wrong. Call the production function/endpoint "
                        "that produces the value and assert on ITS output."
                    ),
                )
            )
    return out


def _assert_on_just_set(
    path_str: str, fn: ast.FunctionDef | ast.AsyncFunctionDef
) -> list[SlopFinding]:
    out: list[SlopFinding] = []
    body = fn.body
    for i in range(len(body) - 1):
        stmt = body[i]
        next_stmt = body[i + 1]
        if not isinstance(stmt, ast.Assign):
            continue
        if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
            continue
        target_name = stmt.targets[0].id
        rhs = stmt.value
        if not isinstance(next_stmt, ast.Assert):
            continue
        test = next_stmt.test
        if not isinstance(test, ast.Compare):
            continue
        if not isinstance(test.left, ast.Name) or test.left.id != target_name:
            continue
        if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
            continue
        comp = test.comparators[0]
        # Compare values by AST equivalence for literals; or same ``Name`` id.
        if _ast_equiv(rhs, comp):
            out.append(
                SlopFinding(
                    path=path_str,
                    line=next_stmt.lineno,
                    kind="assert_on_just_set",
                    code_excerpt=f"{target_name} = ...; assert {target_name} == <same>",
                    why_slop=(
                        f"Test asserts {target_name!r} equals the literal it was just assigned. "
                        "This tests Python's =, not the code under test."
                    ),
                )
            )
    return out


def _ast_equiv(a: ast.expr, b: ast.expr) -> bool:
    """True if two AST expressions are structurally identical (for slop check).

    Handles ``ast.Constant``, ``ast.Name``, simple ``Tuple``/``List`` /
    ``Dict``. Conservative: returns False for any node it doesn't understand.
    """
    if type(a) is not type(b):
        return False
    if isinstance(a, ast.Constant) and isinstance(b, ast.Constant):
        return a.value == b.value
    if isinstance(a, ast.Name) and isinstance(b, ast.Name):
        return a.id == b.id
    if isinstance(a, (ast.Tuple, ast.List)) and isinstance(b, (ast.Tuple, ast.List)):
        if len(a.elts) != len(b.elts):
            return False
        return all(_ast_equiv(x, y) for x, y in zip(a.elts, b.elts, strict=True))
    if isinstance(a, ast.Dict) and isinstance(b, ast.Dict):
        if len(a.keys) != len(b.keys):
            return False
        keys_match = all(
            (k1 is None and k2 is None)
            or (k1 is not None and k2 is not None and _ast_equiv(k1, k2))
            for k1, k2 in zip(a.keys, b.keys, strict=True)
        )
        if not keys_match:
            return False
        return all(_ast_equiv(v1, v2) for v1, v2 in zip(a.values, b.values, strict=True))
    return False


def _self_throwing_raises(
    path_str: str, fn: ast.FunctionDef | ast.AsyncFunctionDef
) -> list[SlopFinding]:
    """``with pytest.raises(X): raise X(...)`` — the test catches its own throw."""
    out: list[SlopFinding] = []
    for node in ast.walk(fn):
        if not isinstance(node, ast.With):
            continue
        for item in node.items:
            ctx = item.context_expr
            # Match ``pytest.raises(<ExcType>)`` — Call on Attribute "raises".
            if not isinstance(ctx, ast.Call):
                continue
            if not (
                isinstance(ctx.func, ast.Attribute)
                and ctx.func.attr == "raises"
                and isinstance(ctx.func.value, ast.Name)
                and ctx.func.value.id == "pytest"
            ):
                continue
            if not ctx.args:
                continue
            expected_exc = ctx.args[0]
            # Look for ``raise <expected_exc>(...)`` directly in the With body.
            for stmt in node.body:
                if isinstance(stmt, ast.Raise) and stmt.exc is not None:
                    raised = stmt.exc
                    if isinstance(raised, ast.Call):
                        raised = raised.func
                    if _ast_equiv(expected_exc, raised):
                        out.append(
                            SlopFinding(
                                path=path_str,
                                line=stmt.lineno,
                                kind="self_throwing_raises",
                                code_excerpt=(
                                    f"with pytest.raises({ast.unparse(expected_exc)}): "
                                    f"raise {ast.unparse(expected_exc)}(...)"
                                ),
                                why_slop=(
                                    "Test raises the same exception it expects to catch. The "
                                    "code under test is never invoked."
                                ),
                            )
                        )
    return out


def _collect_db_bootstrap_imports(tree: ast.Module) -> set[str]:
    """Collect bare names imported from ``sqlmodel`` or ``sqlalchemy`` that are
    DB bootstrap calls — ``create_engine``. These are the names that, when
    called as a bare function, should be flagged."""
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module in {"sqlmodel", "sqlalchemy"}:
            for alias in node.names:
                if alias.name == "create_engine":
                    names.add(alias.asname or alias.name)
    return names


def _direct_db_bootstrap(
    path_str: str,
    fn: ast.FunctionDef | ast.AsyncFunctionDef,
    db_bootstrap_names: set[str],
    source_lines: list[str],
) -> list[SlopFinding]:
    """Flag test functions that bootstrap the database directly instead of
    calling the application initializer ``factory.observability.schema.migrate``.

    Matches:
      * ``SQLModel.metadata.create_all(...)``
      * ``sqlmodel.create_engine(...)`` (qualified)
      * ``sqlalchemy.create_engine(...)`` (qualified)
      * ``create_engine(...)`` (bare, when imported from sqlmodel / sqlalchemy)
    """
    if _noqa_slop_suppressed(fn, source_lines):
        return []

    out: list[SlopFinding] = []
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        matched = _match_db_bootstrap_call(node, db_bootstrap_names)
        if matched is None:
            continue
        out.append(
            SlopFinding(
                path=path_str,
                line=node.lineno,
                kind="direct_db_bootstrap",
                code_excerpt=matched,
                why_slop=(
                    "Test bypasses the application initializer and constructs its own "
                    "database engine / schema. Call factory.observability.schema.migrate "
                    "instead so the test drives the same path production uses."
                ),
            )
        )
    return out


def _match_db_bootstrap_call(call: ast.Call, db_bootstrap_names: set[str]) -> str | None:
    """Return a code excerpt string if ``call`` matches a direct DB bootstrap
    pattern, else None."""
    # SQLModel.metadata.create_all(...)
    if (
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "create_all"
        and isinstance(call.func.value, ast.Attribute)
        and call.func.value.attr == "metadata"
        and isinstance(call.func.value.value, ast.Name)
        and call.func.value.value.id == "SQLModel"
    ):
        return "SQLModel.metadata.create_all(...)"

    # sqlmodel.create_engine(...) or sqlalchemy.create_engine(...) — qualified
    if (
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "create_engine"
        and isinstance(call.func.value, ast.Name)
        and call.func.value.id in {"sqlmodel", "sqlalchemy"}
    ):
        return f"{call.func.value.id}.create_engine(...)"

    # Bare create_engine(...) — from sqlmodel / sqlalchemy import
    if (
        isinstance(call.func, ast.Name)
        and call.func.id == "create_engine"
        and call.func.id in db_bootstrap_names
    ):
        return "create_engine(...)"

    return None


def _is_mock_name(name: str) -> bool:
    """Heuristic: variable name starts with ``mock_`` or ends with ``_mock``."""
    return name.startswith("mock_") or name.endswith("_mock") or name == "mock"


def _mock_only_assertions(
    path_str: str, fn: ast.FunctionDef | ast.AsyncFunctionDef
) -> list[SlopFinding]:
    """Flag tests whose ONLY assertions are mock-call assertions.

    Specifically:
      * one or more ``assert <mock>.called`` / ``<mock>.call_count == ...``
        or ``<mock>.assert_called*(...)`` expressions
      * NO assert that compares against a non-mock value (i.e. no real
        outcome verification)

    Tests that mix both mock-call AND real-outcome assertions are NOT
    flagged — that's a legitimate pattern.
    """
    mock_only = True
    saw_assertion = False
    for node in ast.walk(fn):
        # bare assert statements
        if isinstance(node, ast.Assert):
            saw_assertion = True
            if not _is_mock_assertion(node.test):
                mock_only = False
        # mock.assert_called_with(...) is an Expr/Call, not an Assert
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if isinstance(call.func, ast.Attribute) and call.func.attr.startswith("assert_called"):
                if isinstance(call.func.value, ast.Name) and _is_mock_name(call.func.value.id):
                    saw_assertion = True
                    # mock-only-ish; do not flip mock_only=False
                else:
                    # assert_called* on something not heuristically a mock — let it pass
                    pass

    if saw_assertion and mock_only:
        # Only emit if there was AT LEAST ONE mock-style assertion (otherwise
        # the test is just a no-op which is caught by other detectors).
        only_mock_call_assertions = any(
            (
                isinstance(n, ast.Expr)
                and isinstance(n.value, ast.Call)
                and isinstance(n.value.func, ast.Attribute)
                and n.value.func.attr.startswith("assert_called")
            )
            or (isinstance(n, ast.Assert) and _is_mock_assertion(n.test))
            for n in ast.walk(fn)
        )
        if only_mock_call_assertions:
            return [
                SlopFinding(
                    path=path_str,
                    line=fn.lineno,
                    kind="mock_only_assertion",
                    code_excerpt=f"def {fn.name}(...): # only asserts on mock.called / assert_called*",
                    why_slop=(
                        "Test only verifies that a mock was called. It never asserts the real "
                        "outcome of the code under test. Replace with an assertion on the real "
                        "return value or observable side effect."
                    ),
                )
            ]
    return []


def _is_mock_assertion(test: ast.expr) -> bool:
    """``mock.called`` or ``mock.call_count == ...`` shape."""
    if isinstance(test, ast.Attribute):
        if test.attr in {"called", "call_count"}:
            if isinstance(test.value, ast.Name) and _is_mock_name(test.value.id):
                return True
    if isinstance(test, ast.Compare):
        # mock.call_count == N
        return _is_mock_assertion(test.left)
    return False


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def _looks_like_test_file(path: str) -> bool:
    return bool(_TEST_PATH_RE.search(path.replace("\\", "/")))


def _language_for(path: str) -> str | None:
    if path.endswith(".py"):
        return "python"
    if path.endswith((".ts", ".tsx", ".js", ".jsx")):
        return "js_ts"
    return None


def scan_file(path: Path, language: str | None = None) -> list[SlopFinding]:
    """Scan a single file for slop. Unknown languages return ``[]``."""
    path_str = str(path)
    try:
        source = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    lang = language or _language_for(path_str)
    if lang is None:
        return []
    out: list[SlopFinding] = []
    if lang == "python":
        for lineno, line in enumerate(source.splitlines(), start=1):
            for pat, kind in SLOP_REGEXES_PYTHON:
                if pat.match(line):
                    out.append(
                        SlopFinding(
                            path=path_str,
                            line=lineno,
                            kind=kind,
                            code_excerpt=line.strip(),
                            why_slop=_WHY_PY.get(kind, "trivially-green test"),
                        )
                    )
                    break
        out.extend(_ast_findings_python(path_str, source))
    elif lang == "js_ts":
        for lineno, line in enumerate(source.splitlines(), start=1):
            for pat, kind in SLOP_REGEXES_JS_TS:
                if pat.search(line):
                    out.append(
                        SlopFinding(
                            path=path_str,
                            line=lineno,
                            kind=kind,
                            code_excerpt=line.strip(),
                            why_slop=_WHY_JS.get(kind, "trivially-green test"),
                        )
                    )
                    break
    return out


_WHY_PY: dict[str, str] = {
    "assert True": "Trivially passes regardless of the code under test.",
    "assert False": "Trivially fails — placeholder, not a real test.",
    "assert 1 == 1": "Tests Python's ==, not the subject. Trivially passes.",
    "assert x == x": "Reflexive equality — same variable on both sides. Trivially passes.",
}
_WHY_JS: dict[str, str] = {
    "expect(x).toBe(x)": "Reflexive equality. Trivially passes.",
    "expect(true).toBe(true)": "Trivially passes regardless of the code under test.",
    "expect(false).toBe(false)": "Trivially passes regardless of the code under test.",
    "expect(1).toBe(1)": "Trivially passes regardless of the code under test.",
}


@dataclass
class PRDiffFile:
    """Minimal representation of a PR file. ``status`` mirrors GH's added/modified/removed."""

    path: str
    status: str = "modified"


def scan_diff(
    files: Iterable[PRDiffFile | str], *, repo_root: Path | None = None
) -> list[SlopFinding]:
    """Scan all test files in a PR's file list.

    Accepts either ``PRDiffFile`` objects or bare path strings (the latter
    is convenient for tests and CLI use). Skips deleted files and non-test
    paths. If ``repo_root`` is set, paths are resolved relative to it; else
    paths are interpreted as-is.
    """
    out: list[SlopFinding] = []
    for entry in files:
        if isinstance(entry, str):
            path_str = entry
            status = "modified"
        else:
            path_str = entry.path
            status = entry.status
        if status == "removed":
            continue
        if not _looks_like_test_file(path_str):
            continue
        path = Path(path_str)
        if repo_root is not None:
            path = repo_root / path
        if not path.is_file():
            continue
        out.extend(scan_file(path))
    return out
