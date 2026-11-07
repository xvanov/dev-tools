"""Tests for the slop detector.

Meta-note: these tests must themselves avoid the anti-patterns they
detect. Every fixture file is created inside a ``tmp_path`` so the
detector NEVER recursively flags this test file when it is later
scanned in CI.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.chain.slop_detector import (
    PRDiffFile,
    SlopFinding,
    _looks_like_test_file,
    scan_diff,
    scan_file,
)

# --------------------------------------------------------------------------- #
# Path heuristic
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_x.py",
        "backend/tests/test_y.py",
        "test_inline.py",
        "thing_test.py",
        "frontend/src/foo.test.ts",
        "frontend/src/bar.spec.tsx",
    ],
)
def test_looks_like_test_file_recognizes_common_test_paths(path: str) -> None:
    assert _looks_like_test_file(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "src/module.py",
        "frontend/src/foo.ts",
        "README.md",
        "context/project.md",
    ],
)
def test_looks_like_test_file_rejects_non_test_paths(path: str) -> None:
    assert _looks_like_test_file(path) is False


# --------------------------------------------------------------------------- #
# Python regex anti-patterns
# --------------------------------------------------------------------------- #


def _write_py(tmp_path: Path, body: str) -> Path:
    f = tmp_path / "test_fixture.py"
    f.write_text(body, encoding="utf-8")
    return f


def test_detects_assert_true(tmp_path: Path) -> None:
    f = _write_py(tmp_path, "def test_a():\n    assert True\n")
    findings = scan_file(f)
    assert any(fnd.kind == "assert True" and fnd.line == 2 for fnd in findings), findings


def test_detects_assert_false(tmp_path: Path) -> None:
    f = _write_py(tmp_path, "def test_a():\n    assert False\n")
    findings = scan_file(f)
    assert [fnd.kind for fnd in findings if fnd.kind == "assert False"], findings


def test_detects_assert_1_equals_1(tmp_path: Path) -> None:
    f = _write_py(tmp_path, "def test_a():\n    assert 1 == 1\n")
    findings = scan_file(f)
    assert any(fnd.kind == "assert 1 == 1" for fnd in findings), findings


def test_detects_reflexive_assert_x_eq_x(tmp_path: Path) -> None:
    f = _write_py(tmp_path, "def test_a():\n    x = compute()\n    assert x == x\n")
    findings = scan_file(f)
    assert any(fnd.kind == "assert x == x" for fnd in findings), findings


# --------------------------------------------------------------------------- #
# Python AST anti-patterns
# --------------------------------------------------------------------------- #


def test_detects_assert_on_just_set_literal(tmp_path: Path) -> None:
    """``x = 5; assert x == 5`` — the assertion tests Python's ==, not the SUT."""
    f = _write_py(
        tmp_path,
        "def test_a():\n    x = 5\n    assert x == 5\n",
    )
    findings = scan_file(f)
    kinds = [fnd.kind for fnd in findings]
    assert "assert_on_just_set" in kinds, kinds


def test_detects_assert_on_just_set_string(tmp_path: Path) -> None:
    f = _write_py(
        tmp_path,
        'def test_a():\n    name = "alice"\n    assert name == "alice"\n',
    )
    findings = scan_file(f)
    assert any(fnd.kind == "assert_on_just_set" for fnd in findings), findings


def test_does_not_flag_assert_against_call_result(tmp_path: Path) -> None:
    """``x = compute(); assert x == 5`` is a legitimate test of compute()."""
    f = _write_py(
        tmp_path,
        "def test_a():\n    x = compute()\n    assert x == 5\n",
    )
    findings = scan_file(f)
    assert all(fnd.kind != "assert_on_just_set" for fnd in findings), findings


def test_detects_self_throwing_pytest_raises(tmp_path: Path) -> None:
    """``with pytest.raises(V): raise V()`` — the test catches its own throw."""
    f = _write_py(
        tmp_path,
        "import pytest\n"
        "def test_a():\n"
        "    with pytest.raises(ValueError):\n"
        "        raise ValueError('nope')\n",
    )
    findings = scan_file(f)
    assert any(fnd.kind == "self_throwing_raises" for fnd in findings), findings


def test_does_not_flag_pytest_raises_around_real_call(tmp_path: Path) -> None:
    """``with pytest.raises(V): some_func()`` is legitimate — SUT may raise V."""
    f = _write_py(
        tmp_path,
        "import pytest\ndef test_a():\n    with pytest.raises(ValueError):\n        compute()\n",
    )
    findings = scan_file(f)
    assert all(fnd.kind != "self_throwing_raises" for fnd in findings), findings


def test_detects_mock_only_assertion(tmp_path: Path) -> None:
    """Test that only asserts on ``mock.called`` is slop."""
    f = _write_py(
        tmp_path,
        "def test_a():\n"
        "    service_mock = make_mock()\n"
        "    do_work(service_mock)\n"
        "    assert service_mock.called\n",
    )
    findings = scan_file(f)
    kinds = [fnd.kind for fnd in findings]
    assert "mock_only_assertion" in kinds, kinds


def test_detects_mock_assert_called_with_only(tmp_path: Path) -> None:
    """Test that only calls ``mock.assert_called_with(...)`` is slop."""
    f = _write_py(
        tmp_path,
        "def test_a():\n"
        "    service_mock = make_mock()\n"
        "    do_work(service_mock)\n"
        "    service_mock.assert_called_with(42)\n",
    )
    findings = scan_file(f)
    assert any(fnd.kind == "mock_only_assertion" for fnd in findings), findings


def test_does_not_flag_mock_plus_real_outcome_assertion(tmp_path: Path) -> None:
    """A test that asserts BOTH mock.called AND a real return value is OK."""
    f = _write_py(
        tmp_path,
        "def test_a():\n"
        "    service_mock = make_mock()\n"
        "    result = do_work(service_mock)\n"
        "    assert result == 'expected_outcome'\n"
        "    assert service_mock.called\n",
    )
    findings = scan_file(f)
    assert all(fnd.kind != "mock_only_assertion" for fnd in findings), findings


# --------------------------------------------------------------------------- #
# JS / TS regex anti-patterns
# --------------------------------------------------------------------------- #


def test_detects_expect_x_tobe_x(tmp_path: Path) -> None:
    f = tmp_path / "thing.test.ts"
    f.write_text("it('a', () => { expect(value).toBe(value); });\n", encoding="utf-8")
    findings = scan_file(f)
    assert any(fnd.kind == "expect(x).toBe(x)" for fnd in findings), findings


def test_detects_expect_true_tobe_true(tmp_path: Path) -> None:
    f = tmp_path / "thing.spec.tsx"
    f.write_text("it('a', () => { expect(true).toBe(true); });\n", encoding="utf-8")
    findings = scan_file(f)
    assert any(fnd.kind == "expect(true).toBe(true)" for fnd in findings), findings


def test_js_clean_file_yields_no_findings(tmp_path: Path) -> None:
    f = tmp_path / "thing.test.ts"
    f.write_text(
        "it('renders', () => { expect(render(<App/>).text()).toBe('Hello'); });\n",
        encoding="utf-8",
    )
    findings = scan_file(f)
    assert findings == [], findings


# --------------------------------------------------------------------------- #
# Clean files & multi-pattern files
# --------------------------------------------------------------------------- #


def test_clean_python_test_file_yields_no_findings(tmp_path: Path) -> None:
    """A meaningful test with proper assertions on real return values produces
    zero findings."""
    f = _write_py(
        tmp_path,
        "def test_division_handles_zero():\n    result = divide(10, 2)\n    assert result == 5\n",
    )
    findings = scan_file(f)
    assert findings == [], f"clean file should be clean, got {findings!r}"


def test_multi_pattern_file_emits_all(tmp_path: Path) -> None:
    """A file containing multiple anti-patterns reports each one."""
    f = _write_py(
        tmp_path,
        "def test_a():\n"
        "    assert True\n"
        "def test_b():\n"
        "    x = 1\n"
        "    assert x == 1\n"
        "def test_c():\n"
        "    assert 1 == 1\n",
    )
    findings = scan_file(f)
    kinds = {fnd.kind for fnd in findings}
    assert "assert True" in kinds
    assert "assert 1 == 1" in kinds
    assert "assert_on_just_set" in kinds


# --------------------------------------------------------------------------- #
# scan_diff
# --------------------------------------------------------------------------- #


def test_scan_diff_skips_non_test_files(tmp_path: Path) -> None:
    """Non-test files are not scanned even if they contain ``assert True``."""
    src = tmp_path / "src" / "module.py"
    src.parent.mkdir(parents=True)
    src.write_text("def f():\n    assert True\n", encoding="utf-8")
    findings = scan_diff([str(src)])
    assert findings == [], findings


def test_scan_diff_skips_removed_files(tmp_path: Path) -> None:
    """Deleted files are not scanned (they don't exist on disk anyway)."""
    findings = scan_diff([PRDiffFile(path="tests/test_gone.py", status="removed")])
    assert findings == []


def test_scan_diff_scans_test_files(tmp_path: Path) -> None:
    """Test files in the diff are scanned and findings are aggregated."""
    test_file = tmp_path / "tests" / "test_thing.py"
    test_file.parent.mkdir(parents=True)
    test_file.write_text("def test_a():\n    assert True\n", encoding="utf-8")
    findings = scan_diff([str(test_file)])
    assert any(fnd.kind == "assert True" for fnd in findings), findings


def test_scan_diff_with_repo_root_resolves_relative_paths(tmp_path: Path) -> None:
    """``repo_root`` resolves relative paths from the GH diff (which are repo-relative)."""
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_thing.py").write_text(
        "def test_a():\n    assert True\n", encoding="utf-8"
    )
    findings = scan_diff(["tests/test_thing.py"], repo_root=tmp_path)
    assert any(fnd.kind == "assert True" for fnd in findings), findings


# --------------------------------------------------------------------------- #
# SlopFinding serialization
# --------------------------------------------------------------------------- #


def test_slopfinding_as_dict_carries_all_fields() -> None:
    finding = SlopFinding(
        path="tests/x.py", line=12, kind="assert True", code_excerpt="assert True", why_slop="..."
    )
    d = finding.as_dict()
    assert d == {
        "path": "tests/x.py",
        "line": 12,
        "kind": "assert True",
        "code_excerpt": "assert True",
        "why_slop": "...",
    }


# --------------------------------------------------------------------------- #
# self_constructed_compare — the #1 hollow-test anti-pattern (Loop-4)
# --------------------------------------------------------------------------- #


def _kinds(findings: list[SlopFinding]) -> set[str]:
    return {f.kind for f in findings}


def test_detects_self_constructed_fstring_compare(tmp_path: Path) -> None:
    """assert <test-built f-string> == <test-built f-string> → flagged."""
    src = (
        "def test_path_convention():\n"
        "    base = '/var/media'\n"
        "    goal_id = 'g1'\n"
        "    path = f'{base}/{goal_id}/file'\n"
        "    expected = f'{base}/{goal_id}/file'\n"
        "    assert path == expected\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert "self_constructed_compare" in _kinds(findings)


def test_detects_inline_fstring_tautology(tmp_path: Path) -> None:
    src = "def test_x():\n    gid = 'abc'\n    assert f'media/{gid}' == f'media/{gid}'\n"
    findings = scan_file(_write_py(tmp_path, src))
    assert "self_constructed_compare" in _kinds(findings)


def test_self_constructed_compare_not_flagged_when_calling_production(tmp_path: Path) -> None:
    """If a side CALLS production code, it exercises behavior → NOT flagged."""
    src = (
        "from app.media import storage_path\n"
        "def test_path_convention():\n"
        "    base = '/var/media'\n"
        "    assert storage_path('g1') == f'{base}/g1/file'\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert "self_constructed_compare" not in _kinds(findings)


def test_self_constructed_compare_not_flagged_for_fixture_endpoint_test(tmp_path: Path) -> None:
    """A fixture-driven endpoint test references a param (client/response) →
    impure → NOT flagged, even though one side is a literal."""
    src = (
        "def test_upload_endpoint(client):\n"
        "    response = client.post('/uploads', json={'x': 1})\n"
        "    assert response.status_code == 201\n"
        "    assert response.json()['path'] == '/var/media/g1/file'\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert "self_constructed_compare" not in _kinds(findings)


def test_self_constructed_compare_not_flagged_for_settings_call(tmp_path: Path) -> None:
    """Constructing a production object and asserting on its attr is real."""
    src = (
        "from app.config import Settings\n"
        "def test_media_dir_default():\n"
        "    s = Settings(_env_file=None)\n"
        "    assert s.media_dir == '/var/sacrifice/media'\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert "self_constructed_compare" not in _kinds(findings)


# --------------------------------------------------------------------------- #
# Direct DB bootstrap (D014)
# --------------------------------------------------------------------------- #

_NOQA_SLOP = "  # noqa: slop"


def test_detects_SQLModel_metadata_create_all(tmp_path: Path) -> None:
    src = (
        "from sqlmodel import SQLModel\ndef test_foo():\n    SQLModel.metadata.create_all(engine)\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" in kinds, kinds
    fnd = next(f for f in findings if f.kind == "direct_db_bootstrap")
    assert fnd.line == 3
    assert "SQLModel.metadata.create_all" in fnd.code_excerpt


def test_detects_sqlmodel_create_engine_bare(tmp_path: Path) -> None:
    src = (
        "from sqlmodel import create_engine\n"
        "def test_bar():\n"
        "    e = create_engine('sqlite:///x')\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" in kinds, kinds
    fnd = next(f for f in findings if f.kind == "direct_db_bootstrap")
    assert fnd.line == 3
    assert "create_engine" in fnd.code_excerpt


def test_detects_sqlalchemy_create_engine_bare(tmp_path: Path) -> None:
    src = (
        "from sqlalchemy import create_engine\n"
        "def test_baz():\n"
        "    e = create_engine('sqlite:///x')\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" in kinds, kinds
    fnd = next(f for f in findings if f.kind == "direct_db_bootstrap")
    assert fnd.line == 3
    assert "create_engine" in fnd.code_excerpt


def test_detects_sqlmodel_create_engine_qualified(tmp_path: Path) -> None:
    src = "import sqlmodel\ndef test_qux():\n    sqlmodel.create_engine('sqlite:///x')\n"
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" in kinds, kinds
    fnd = next(f for f in findings if f.kind == "direct_db_bootstrap")
    assert fnd.line == 3
    assert "sqlmodel.create_engine" in fnd.code_excerpt


def test_detects_sqlalchemy_create_engine_qualified(tmp_path: Path) -> None:
    src = "import sqlalchemy\ndef test_quux():\n    sqlalchemy.create_engine('sqlite:///x')\n"
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" in kinds, kinds
    fnd = next(f for f in findings if f.kind == "direct_db_bootstrap")
    assert fnd.line == 3
    assert "sqlalchemy.create_engine" in fnd.code_excerpt


def test_direct_db_bootstrap_why_slop_names_migrate(tmp_path: Path) -> None:
    """AC2.1: the why_slop text must name factory.observability.schema.migrate."""
    src = "from sqlmodel import create_engine\ndef test_x():\n    create_engine('sqlite:///x')\n"
    findings = scan_file(_write_py(tmp_path, src))
    assert len(findings) >= 1
    for f in findings:
        if f.kind == "direct_db_bootstrap":
            assert "factory.observability.schema.migrate" in f.why_slop, f.why_slop


def test_migrate_call_produces_no_finding(tmp_path: Path) -> None:
    """AC3.1: app-initializer path (migrate) produces no finding."""
    src = (
        "from factory.observability.schema import migrate\n"
        "def test_good():\n"
        "    db = tmp_path / 'db'\n"
        "    migrate(db)\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert all(f.kind != "direct_db_bootstrap" for f in findings), findings


def test_noqa_slop_suppresses_direct_db_bootstrap_finding(tmp_path: Path) -> None:
    """AC4.1: # noqa: slop on a test suppresses the finding."""
    src = (
        "from sqlmodel import create_engine\n"
        f"def test_legit_raw_engine():{_NOQA_SLOP}\n"
        "    e = create_engine('sqlite:///x')\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert all(f.kind != "direct_db_bootstrap" for f in findings), findings


def test_noqa_slop_suppresses_create_all_finding(tmp_path: Path) -> None:
    """# noqa: slop in the body also suppresses."""
    src = (
        "from sqlmodel import SQLModel\n"
        "def test_legit_migration():\n"
        f"    SQLModel.metadata.create_all(engine)  {_NOQA_SLOP}\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert all(f.kind != "direct_db_bootstrap" for f in findings), findings


def test_noqa_slop_is_single_test_granularity(tmp_path: Path) -> None:
    """AC4.1: suppression applies only to the annotated test in a file."""
    src = (
        "from sqlmodel import create_engine\n"
        f"def test_raw_engine_subject():{_NOQA_SLOP}\n"
        "    create_engine('sqlite:///raw.db')\n"
        "\n"
        "def test_unsuppressed_neighbor():\n"
        "    create_engine('sqlite:///unsuppressed.db')\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    db_findings = [f for f in findings if f.kind == "direct_db_bootstrap"]
    assert len(db_findings) == 1, db_findings
    assert db_findings[0].line == 6


def test_story148_bad_form_is_flagged(tmp_path: Path) -> None:
    """AC1.1 / AC7.1: exact story-148 test body is flagged.

    The fixture body is intentionally kept as the exact multiline snippet from
    the direction so this remains a byte-faithful regression.
    """
    bad_body = """db = tmp_path / "factory.db"
engine = create_engine(f"sqlite:///{db}", echo=False)
SQLModel.metadata.create_all(engine)
assert "directions" in _tables(db)
"""
    src = (
        "from pathlib import Path\n"
        "from sqlmodel import SQLModel, create_engine\n"
        "\n"
        "\n"
        "def test_tables_exist(tmp_path):\n"
        + "".join(f"    {line}\n" for line in bad_body.rstrip("\n").splitlines())
    )
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" in kinds, f"Expected direct_db_bootstrap in {kinds}"
    db_findings = [f for f in findings if f.kind == "direct_db_bootstrap"]
    assert len(db_findings) >= 2, (
        f"Expected >=2 bootstrap findings (create_engine + create_all), "
        f"got {len(db_findings)}: {db_findings}"
    )


def test_story148_fixed_form_is_not_flagged(tmp_path: Path) -> None:
    """AC1.2 / AC7.2: fixed form drives migrate() and stays clean."""
    fixed_body = """db = tmp_path / "factory.db"
migrate(db)
assert "directions" in _tables(db)
"""
    src = (
        "from pathlib import Path\n"
        "from factory.observability.schema import migrate\n"
        "\n"
        "\n"
        "def test_tables_exist(tmp_path):\n"
        + "".join(f"    {line}\n" for line in fixed_body.rstrip("\n").splitlines())
    )
    findings = scan_file(_write_py(tmp_path, src))
    assert all(f.kind != "direct_db_bootstrap" for f in findings), findings


def test_schema_related_repo_tests_have_no_unsuppressed_direct_bootstrap_findings() -> None:
    """AC1.1: repo-owned schema-coverage tests are clean or intentionally suppressed."""
    repo_root = Path(__file__).resolve().parents[1]
    checked = [
        repo_root / "tests" / "test_observability_schema.py",
        repo_root / "tests" / "test_directions_schema.py",
        repo_root / "tests" / "test_usage_honesty.py",
    ]

    unsuppressed: dict[str, list[tuple[int, str]]] = {}
    for path in checked:
        findings = [f for f in scan_file(path) if f.kind == "direct_db_bootstrap"]
        if findings:
            unsuppressed[str(path.relative_to(repo_root))] = [
                (f.line, f.code_excerpt) for f in findings
            ]

    assert unsuppressed == {}, unsuppressed


def test_noqa_slop_does_not_block_other_ast_detectors(tmp_path: Path) -> None:
    """# noqa: slop suppresses ONLY direct_db_bootstrap; unrelated AST rules
    still fire for the same test body."""
    src = (
        "from sqlmodel import create_engine\n"
        f"def test_mixed():{_NOQA_SLOP}\n"
        "    e = create_engine('sqlite:///x')\n"
        "    expected = 'x'\n"
        "    assert expected == 'x'\n"
    )
    findings = scan_file(_write_py(tmp_path, src))
    kinds = _kinds(findings)
    assert "direct_db_bootstrap" not in kinds, "direct_db_bootstrap should be suppressed"
    assert "assert_on_just_set" in kinds, "other AST detectors should still fire"
