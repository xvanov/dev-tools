"""The benchmark must be reproducible and must not destroy its own evidence.

Three defects made the July 2026 campaign unciteable, and this module pins the
fix for each:

1. ``base_sha`` was ``""`` and resolved ``origin/main`` at run time, so the
   base tree was a function of WHEN an arm ran.
2. The Claude arm invoked ``claude -p`` with no ``--model``, so the arm had no
   defined identity.
3. ``clean()`` ended in ``shutil.rmtree(RUNS_DIR)``, which is why all 20 rows
   in ``bench/results/summary.md`` have no surviving ``result.json``.

Plus the Phase 0.4 contract: tokens are the measurement, dollars are a derived
presentation layer that a price correction can move without touching a token.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

_BENCH_PY = Path(__file__).parent.parent / "bench" / "bench.py"


def _load_bench() -> Any:
    """Import ``bench/bench.py`` (a script, not a package module)."""
    spec = importlib.util.spec_from_file_location("_bench_under_test", _BENCH_PY)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_bench_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def B() -> Any:  # noqa: N802 - terse alias for the module under test
    return _load_bench()


# --------------------------------------------------------------------------- #
# 1. base_sha is pinned, and refused when it is not
# --------------------------------------------------------------------------- #


def test_shipped_tasks_yaml_pins_a_real_sha(B: Any) -> None:  # noqa: N803
    data = B._load_tasks()
    sha = B._base_sha(data)
    assert B._SHA_RE.match(sha), sha


@pytest.mark.parametrize("bad", [{}, {"base_sha": ""}, {"base_sha": "   "}])
def test_empty_base_sha_is_refused_not_resolved(B: Any, bad: dict) -> None:  # noqa: N803
    """The whole defect: it used to shell out to ``rev-parse origin/main``."""
    with pytest.raises(SystemExit, match="base_sha is empty"):
        B._base_sha(bad)


@pytest.mark.parametrize("bad", ["b40e87a", "origin/main", "main", "z" * 40])
def test_non_full_sha_is_refused(B: Any, bad: str) -> None:  # noqa: N803
    with pytest.raises(SystemExit, match="40-char hex"):
        B._base_sha({"base_sha": bad})


# --------------------------------------------------------------------------- #
# 2. the Claude arm is pinned
# --------------------------------------------------------------------------- #


def test_claude_arm_pins_a_model_by_default(B: Any) -> None:  # noqa: N803
    assert B.DEFAULT_CLAUDE_MODEL
    assert "claude" in B.DEFAULT_CLAUDE_MODEL


def test_claude_invocation_passes_model(B: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """Guards the actual argv — a pinned constant nobody passes is useless."""
    seen: list[list[str]] = []

    class _Proc:
        returncode = 0
        stdout = json.dumps({"total_cost_usd": 1.0, "usage": {"input_tokens": 5}})
        stderr = ""

    def _fake_run(cmd: list[str], **kw: Any) -> Any:
        seen.append(list(cmd))
        return _Proc()

    monkeypatch.setattr(B, "_make_worktree", lambda *a, **k: Path("/tmp"))
    monkeypatch.setattr(B, "_prompt_text", lambda t: "do the thing")
    monkeypatch.setattr(B, "_diff_stats", lambda wt: {})
    monkeypatch.setattr(B, "_write_result", lambda *a, **k: Path("/tmp/result.json"))
    monkeypatch.setattr(B.subprocess, "run", _fake_run)

    B.run_claude("t1_a11y_selector", 1, budget_usd=1.0, timeout_s=10, model="claude-test-9")

    # Provenance shells out to `git hash-object` afterwards, so pick the
    # claude invocation rather than the last call.
    claude_cmds = [c for c in seen if c and c[0] == "claude"]
    assert len(claude_cmds) == 1, seen
    cmd = claude_cmds[0]
    assert "--model" in cmd
    assert cmd[cmd.index("--model") + 1] == "claude-test-9"


def test_claude_tokens_unknown_is_none_not_zero(B: Any) -> None:  # noqa: N803
    """A missing count must never be recorded as a measured zero."""
    assert B._claude_tokens({}) == {
        "tokens_in": None,
        "tokens_out": None,
        "cached_input_tokens": None,
    }
    got = B._claude_tokens(
        {"usage": {"input_tokens": 10, "output_tokens": 3, "cache_read_input_tokens": 7}}
    )
    assert got == {"tokens_in": 10, "tokens_out": 3, "cached_input_tokens": 7}


# --------------------------------------------------------------------------- #
# 3. clean() preserves the evidence
# --------------------------------------------------------------------------- #


@pytest.fixture
def isolated_bench(B: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the module at throwaway dirs and an empty git repo.

    Never let this test touch the real sacrifice checkout — ``clean()`` removes
    worktrees and force-deletes branches there.
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T E"], cwd=repo, check=True)
    (repo / "f.txt").write_text("x\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)

    runs = tmp_path / "runs"
    (runs / "t1" / "factory-1").mkdir(parents=True)
    (runs / "t1" / "factory-1" / "result.json").write_text(
        json.dumps({"task": "t1", "arm": "factory", "run": 1}), encoding="utf-8"
    )
    monkeypatch.setattr(B, "SACRIFICE_REPO", repo)
    monkeypatch.setattr(B, "RUNS_DIR", runs)
    monkeypatch.setattr(B, "RESULTS_DIR", tmp_path / "results")
    return runs


def test_clean_keeps_raw_results_by_default(
    B: Any, isolated_bench: Path, capsys: pytest.CaptureFixture  # noqa: N803
) -> None:
    B.clean()
    assert (isolated_bench / "t1" / "factory-1" / "result.json").exists()
    assert "kept 1 result.json" in capsys.readouterr().out


def test_purge_runs_is_opt_in(B: Any, isolated_bench: Path) -> None:  # noqa: N803
    B.clean(purge_runs=True)
    assert not (isolated_bench / "t1" / "factory-1" / "result.json").exists()


# --------------------------------------------------------------------------- #
# 4. tokens are the measurement; dollars are a presentation layer
# --------------------------------------------------------------------------- #


def _seed(runs: Path, **over: Any) -> None:
    row = {
        "task": "t1", "arm": "factory", "run": 1, "gates_passed": True,
        "tokens_in": 1234, "tokens_out": 567, "cached_input_tokens": 89,
        "cost_usd": 0.42, "wall_clock_s": 12.0,
        "base_sha": "a" * 40, "routes_sha": "b" * 40, "price_table_sha": "cafe1234",
    }
    row.update(over)
    d = runs / "t1" / "factory-1"
    d.mkdir(parents=True, exist_ok=True)
    (d / "result.json").write_text(json.dumps(row), encoding="utf-8")


def test_report_leads_with_tokens_and_stamps_provenance(
    B: Any, isolated_bench: Path, tmp_path: Path  # noqa: N803
) -> None:
    _seed(isolated_bench)
    B.report()
    text = (tmp_path / "results" / "summary.md").read_text(encoding="utf-8")
    assert "tokens in" in text and "tokens out" in text and "cached in" in text
    assert "1,234" in text and "567" in text and "89" in text
    assert "price_table_sha: cafe1234" in text
    assert "routes_sha: " + "b" * 40 in text
    assert "Tokens are the primary metric" in text


def test_a_price_change_moves_only_the_dollar_column(
    B: Any, isolated_bench: Path, tmp_path: Path  # noqa: N803
) -> None:
    """The Phase 0.4 contract, asserted rather than asserted-about: re-report
    with a corrected price and every token column is byte-identical."""
    summary = tmp_path / "results" / "summary.md"

    _seed(isolated_bench, cost_usd=0.42)
    B.report()
    before = summary.read_text(encoding="utf-8")

    _seed(isolated_bench, cost_usd=0.99)
    B.report()
    after = summary.read_text(encoding="utf-8")

    def _cells(md: str) -> list[list[str]]:
        rows = [ln for ln in md.splitlines() if ln.startswith("| t1 ")]
        return [[c.strip() for c in r.strip("|").split("|")] for r in rows]

    b_cells, a_cells = _cells(before), _cells(after)
    assert b_cells and len(b_cells) == len(a_cells)
    for b_row, a_row in zip(b_cells, a_cells, strict=True):
        # tokens in / out / cached in are columns 5,6,7
        assert b_row[5:8] == a_row[5:8], "token columns must not move with price"
        assert b_row[9] != a_row[9], "the dollar column must reflect the new price"
    assert "0.42" in before and "0.99" in after


def test_mismatched_base_shas_are_flagged_loudly(
    B: Any, isolated_bench: Path, tmp_path: Path  # noqa: N803
) -> None:
    """Rows from different base trees are not comparable, and the report must
    say so rather than quietly tabulating them side by side."""
    _seed(isolated_bench)
    d2 = isolated_bench / "t2" / "claude-1"
    d2.mkdir(parents=True)
    (d2 / "result.json").write_text(
        json.dumps({"task": "t2", "arm": "claude", "run": 1, "base_sha": "f" * 40}),
        encoding="utf-8",
    )
    B.report()
    text = (tmp_path / "results" / "summary.md").read_text(encoding="utf-8")
    assert "do not share a base SHA" in text


# --------------------------------------------------------------------------- #
# 5. provenance
# --------------------------------------------------------------------------- #


def test_provenance_records_what_produced_the_number(B: Any) -> None:  # noqa: N803
    prov = B._provenance("a" * 40)
    assert prov["base_sha"] == "a" * 40
    assert prov["routes_sha"] and len(prov["routes_sha"]) == 40
    assert prov["price_table_sha"] == prov["price_table"]["hash"]
    # The estimated rate is labelled as such, so nobody reads it as measured.
    assert "deepseek_v4_pro_cache_read_per_token" in prov["price_table"]["estimated_rates"]


def test_price_table_hash_changes_with_the_price(B: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """The hash has to be a function of the rates, or it cannot certify them."""
    first = B._price_table()["hash"]
    from factory.providers import azure_foundry as az

    monkeypatch.setattr(az, "_DEEPSEEK_V4_PRO_INPUT_PER_TOKEN", 9.99e-06)
    assert B._price_table()["hash"] != first
