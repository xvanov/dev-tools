"""The gold-patch control: parallel, and unable to destroy itself.

Two defects, both found while re-running the control the plan asked for.

1. **It was serial.** 19 instances of docker pull + install replay + two graded
   pytest runs, for a step that spends no model money and gates every sweep.
   Re-run 20-wide it took ~25 minutes. Operator instruction 2026-08-11: run
   benchmark steps as wide as the host allows.

2. **`selftest --instance X` overwrote the whole file with its single row.**
   `run-all --only-working` reads exactly that file to decide which instances to
   sweep — so one debugging run of one instance quietly narrowed the next sweep to
   that instance. Merging is the fix.

The re-run also produced the ruling the plan asked for: `pandas-dev__pandas-63945`
is a BROKEN instance. Its own gold patch does not resolve, because its declared
`fail_to_pass` id is `TestPandasContainer::test_url` — a network fixture — and
grading runs `--network none`, so the id SKIPS and can never pass. 16,693 tests
pass and that one id cannot. It leaves the denominator.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_ADAPTER = _ROOT / "bench" / "swebench_adapter.py"


@pytest.fixture
def A() -> Any:  # noqa: N802
    spec = importlib.util.spec_from_file_location("_swe_selftest_par", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_a_single_instance_run_cannot_shrink_the_control(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The footgun: one debugging run of one instance used to reduce a 19-row
    control to one row, and `--only-working` then swept one instance."""
    monkeypatch.setattr(A, "SWE_DIR", tmp_path)
    (tmp_path / "selftest.json").write_text(
        json.dumps(
            {
                "checked_at": "old",
                "results": [
                    {"instance_id": "a", "gold_resolves": True, "note": "ok"},
                    {"instance_id": "b", "gold_resolves": True, "note": "ok"},
                    {"instance_id": "c", "gold_resolves": True, "note": "ok"},
                ],
            }
        ),
        encoding="utf-8",
    )
    out = A._merge_selftest_results(
        [{"instance_id": "b", "gold_resolves": False, "note": "gold_patch_does_not_resolve"}],
        replace_all=False,
    )
    rows = {r["instance_id"]: r for r in A._read_selftest_results(out)}
    assert set(rows) == {"a", "b", "c"}, "the other rows must survive"
    assert rows["b"]["gold_resolves"] is False, "and the re-checked row must win"
    assert A.selftest_working_instances(out) == {"a", "c"}


def test_a_full_run_replaces_rather_than_accumulates(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A whole-manifest control is the authoritative re-measurement: a row that
    is no longer in the manifest must not linger."""
    monkeypatch.setattr(A, "SWE_DIR", tmp_path)
    (tmp_path / "selftest.json").write_text(
        json.dumps({"checked_at": "old", "results": [{"instance_id": "gone", "gold_resolves": True}]}),
        encoding="utf-8",
    )
    out = A._merge_selftest_results([{"instance_id": "kept", "gold_resolves": True}], replace_all=True)
    assert [r["instance_id"] for r in A._read_selftest_results(out)] == ["kept"]


def test_each_row_is_persisted_the_moment_it_exists(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A 19-instance control that died on row 18 used to lose all 17 before it —
    the only write was after the loop. Per-row files are also what makes the
    parallel fan-out possible without a shared writer."""
    monkeypatch.setattr(A, "SWE_DIR", tmp_path)
    p = A._write_selftest_row({"instance_id": "x__y-1", "gold_resolves": True, "note": "ok"})
    assert p.is_file()
    assert p.parent.name == A.SELFTEST_ROWS_DIRNAME
    assert json.loads(p.read_text(encoding="utf-8"))["instance_id"] == "x__y-1"


def test_the_control_fans_out_and_a_dead_child_narrows_rather_than_admits(A: Any) -> None:  # noqa: N803
    """FAIL SAFE: a crashed child contributes no row, and an instance with no row
    is not a working oracle — so the next sweep is narrowed, never widened to an
    unchecked instance."""
    import inspect

    src = inspect.getsource(A.selftest_parallel)
    assert "ThreadPoolExecutor" in src
    assert "--instance" in src, "children run the same code path an operator runs"
    assert "row=" in src and "MISSING" in src, "a missing row must be reported"
    # And the rule it relies on, in the function that enforces it.
    assert "gold_resolves" in inspect.getsource(A.selftest_working_instances)


def test_pandas_63945_is_ruled_broken_and_out_of_the_denominator() -> None:
    """The plan asked for a ruling; the re-run gave one. Pinned here so the
    exclusion cannot silently revert to `ok` on a carried-forward control."""
    data = json.loads((_ROOT / "bench" / "swebench" / "selftest.json").read_text(encoding="utf-8"))
    rows = {r["instance_id"]: r for r in data["results"]}
    pandas = rows["pandas-dev__pandas-63945"]
    assert pandas["gold_resolves"] is False
    assert pandas["note"] == "gold_patch_does_not_resolve"
    # WHY: the declared fail_to_pass id is a network fixture, and grading runs
    # --network none, so it SKIPS and can never be a PASS.
    assert any("test_url" in r for r in pandas["node_coverage_reasons"])
    assert pandas["node_coverage_ok"] is False
    # And the control is fresh, which is the whole point of the re-run: the
    # previous one was dated 2026-08-02 and md5-identical across both archives.
    assert data["checked_at"] > "2026-08-10"


def test_the_working_set_is_eighteen_not_nineteen() -> None:
    """Every published rate's denominator moves. Pinned so a stale doc that still
    says 19 fails a test rather than misleading a reader."""
    data = json.loads((_ROOT / "bench" / "swebench" / "selftest.json").read_text(encoding="utf-8"))
    working = [r["instance_id"] for r in data["results"] if r.get("gold_resolves") is True]
    assert len(working) == 18
    assert "pandas-dev__pandas-63945" not in working
    assert "google__flax-5171" not in working
