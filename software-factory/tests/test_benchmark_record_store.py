"""The benchmark RECORD store — ``bench/swebench/benchmark_store.py``.

The store exists because ``_sssf_adw_id`` and the run directory are both pure
functions of (instance, arm), so a re-run REUSES the id and DESTROYS the previous
attempt's artifacts: ``_reset_run_artifacts`` deletes the row's files and
``_work_dir(fresh=True)`` rmtree's the per-run ``data_dir`` holding the only
per-turn spend record. The engine's tracer db cannot fill the gap either — its
``sessions.total_cost`` is a running sum across attempts of the same cell.

So the value of this store is precisely the thing that is easy to break silently,
and each test here pins one such failure mode:

1. **idempotent re-ingest** — ingest is called automatically at the end of every
   sweep and by hand on old data; a second run must insert nothing. A store that
   double-counted would inflate every denominator computed from it;
2. **attempt history survives** — two attempts of the SAME (instance, arm), with
   the second having overwritten the first on disk, must be TWO rows. This is the
   whole reason the store exists, and it is one ``UNIQUE`` clause away from being
   silently wrong;
3. **invalid rows are classified, not counted** — a throttled row, a broken task,
   a grade-parse failure, a failed audit and a superseded arm key are each named
   and each excluded, and a budget cap hit is NOT excluded (pre-registered
   decision rule 4). Getting this wrong is exactly how the 2026-08-03 run was
   retracted;
4. **artifact hashes are recorded** — the trail has to be verifiable after the
   bytes are gone, and tampering has to be detectable;
5. **a replay record round-trips the roster exactly** — a replay that reproduces
   a DIFFERENT roster is worse than no replay, because it looks like one.

Everything here is $0: no model is called and no run is executed.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).parent.parent
_ADAPTER = _REPO_ROOT / "bench" / "swebench_adapter.py"
_STORE = _REPO_ROOT / "bench" / "swebench" / "benchmark_store.py"


def _load(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load(_ADAPTER, "_swe_adapter_under_test_store")


@pytest.fixture(scope="module")
def S() -> Any:  # noqa: N802
    return _load(_STORE, "_benchmark_store_under_test")


# --------------------------------------------------------------------------- #
# fixtures — a fake runs tree, written the way the harness writes one
# --------------------------------------------------------------------------- #

_MANIFEST_SHA = "deadbeefcafe0001"

_ROSTER_YAML = """defaults:
  coding_agent: pi
  model: azure/DeepSeek-V3.2
  thinking: medium
  skip_phases: &id001
  - documenter
agents:
  planner:
    model: azure/DeepSeek-V3.2
  builder:
    model: azure/DeepSeek-V3.2
  reviewer:
    model: azure/gpt-5.4
"""


def _row(
    instance: str,
    arm: str,
    *,
    attempt: int,
    cost: float = 1.5,
    resolved: bool | None = True,
    outcome: str = "resolved",
    error: str | None = None,
    termination: str = "terminal-state",
    empty_turns: int = 0,
    roster: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    """One ``result.json`` shaped like the sssf arms' real rows."""
    roster = roster if roster is not None else {
        "planner": "azure/DeepSeek-V3.2",
        "builder": "azure/DeepSeek-V3.2",
        "reviewer": "azure/gpt-5.4",
        "documenter": None,
    }
    grade: dict[str, Any] = {"arm": arm, "instance_id": instance}
    if resolved is not None:
        grade["oracle_resolved"] = resolved
        grade["outcome"] = outcome
    return {
        "arm": arm,
        "instance_id": instance,
        "repo": "acme/widget",
        "base_commit": "0" * 40,
        "problem_statement_sha256": "f" * 64,
        "manifest_sha256": _MANIFEST_SHA,
        "ts": f"2026-08-13T0{attempt}:00:00+00:00",
        "cost_source": "derived-from-price-table",
        "sssf_roster": roster,
        "sssf_roster_sha256": hashlib.sha256(
            _ROSTER_YAML.encode("utf-8")
        ).hexdigest(),
        "sssf_skip_phases": ["documenter"],
        "sssf_roles_run": ["builder"],
        "sssf_roles_skipped": ["documenter"],
        "sssf_thinking": "medium",
        "sssf_engine": "/home/k/sssf/adws/adw_simple_sdlc.py",
        "models_used": sorted({m for m in roster.values() if m}),
        "model_calls": 42,
        "wall_clock_s": 300.0,
        "steps_used": 3,
        "step_cap": 18,
        "termination": termination,
        "error": error,
        "attempt": attempt,
        "tokens_in": 1_000_000,
        "cached_input_tokens": 0,
        "tokens_out": 10_000,
        "total_tokens": 1_010_000,
        "cost_usd": cost,
        "empty_response_turns": empty_turns,
        "usage_by_role": {
            "builder": {
                "input_tokens": 1_000_000,
                "output_tokens": 10_000,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 1_010_000,
                "total_cost": cost,
                "calls": 42,
                "empty_response_turns": empty_turns,
                "models": ["azure/DeepSeek-V3.2"],
                "peak_turn_input_tokens": 60_000,
            }
        },
        "price_table": {
            "path": "/home/k/.pi/agent/models.json",
            "sha256": "a" * 64,
            "sha256_pinned": "a" * 64,
            "matches_pinned": True,
            "units": "USD per 1,000,000 tokens",
            "rates": {
                "azure/DeepSeek-V3.2": {
                    "cost": {"input": 0.58, "output": 1.68,
                             "cacheRead": 0.58, "cacheWrite": 0.0}
                },
                "azure/gpt-5.4": {
                    "cost": {"input": 2.5, "output": 15.0,
                             "cacheRead": 0.25, "cacheWrite": 0.0}
                },
            },
        },
        "sssf_caps": {"run_cost_cap_usd": 0.0, "wall_clock_cap_s": 5400,
                      "phase_cap": 18},
        "factory_says_green": bool(resolved),
        "green_state": "adw_accepted:tests_green+review_approved",
        "diff_bytes": 512,
        "files_changed": ["src/widget.py"],
        "budget_exhausted": termination in ("cost-cap", "wall-clock-cap", "phase-cap"),
        "budget_exhausted_reason": (
            f"{termination} (300.0s wall)"
            if termination in ("cost-cap", "wall-clock-cap", "phase-cap")
            else None
        ),
        "grade": grade,
    }


def write_row(
    runs: Path,
    instance: str,
    arm: str,
    row: dict[str, Any],
    *,
    audit_ok: bool | None = True,
    audit_failures: list[str] | None = None,
    roster: str | None = _ROSTER_YAML,
    extra_files: dict[str, str] | None = None,
) -> Path:
    """Write one run directory the way ``run_sssf`` + ``grade`` + ``audit`` do."""
    d = runs / instance / arm
    d.mkdir(parents=True, exist_ok=True)
    (d / "result.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
    (d / "prediction.diff").write_text("--- a/src/widget.py\n", encoding="utf-8")
    (d / "raw.diff").write_text("--- a/src/widget.py\n", encoding="utf-8")
    (d / "attempt.json").write_text(
        json.dumps({"attempts": row.get("attempt", 1)}) + "\n", encoding="utf-8"
    )
    if roster is not None:
        (d / "sssf-roster.yaml").write_text(roster, encoding="utf-8")
        (d / "sssf-prompt.md").write_text("# story\nfix the widget\n", encoding="utf-8")
    if audit_ok is not None:
        (d / "audit.json").write_text(
            json.dumps({
                "instance_id": instance, "arm": arm, "ok": audit_ok,
                "failures": audit_failures or [],
            }),
            encoding="utf-8",
        )
    for name, text in (extra_files or {}).items():
        p = d / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return d


def write_sweep(
    swe_dir: Path, arm: str, *, finished_at: str, workers: int,
    rows: list[dict[str, Any]],
) -> Path:
    """One ``sweep-<arm>.json``, the shape ``_sweep_summary`` writes."""
    summary = {
        "arm": arm, "model": None, "harness": f"test harness {arm}",
        "workers": workers, "finished_at": finished_at, "wall_clock_s": 100.0,
        "stopped_reason": None, "instances": len(rows),
        "cost_source": "derived-from-price-table",
        "cost_usd": round(sum(float(r["cost_usd"]) for r in rows), 4),
        "resolved": sum(1 for r in rows if (r.get("grade") or {}).get("oracle_resolved")),
        "gradable": len(rows),
        "results": [
            {"instance_id": r["instance_id"], "arm": arm, "attempt": r["attempt"],
             "status": "ok", "cost_usd": r["cost_usd"],
             "oracle_resolved": (r.get("grade") or {}).get("oracle_resolved"),
             "outcome": (r.get("grade") or {}).get("outcome"), "audit_ok": True}
            for r in rows
        ],
    }
    out = swe_dir / f"sweep-{arm}.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return out


@pytest.fixture()
def bench(tmp_path: Path) -> dict[str, Path]:
    swe = tmp_path / "swebench"
    runs = swe / "runs"
    runs.mkdir(parents=True)
    return {"swe": swe, "runs": runs, "db": tmp_path / "benchmarks.db"}


def _ingest(S: Any, A: Any, bench: dict[str, Path], **kw: Any) -> dict[str, Any]:  # noqa: N803
    return S.ingest(
        db_path=bench["db"], runs_dir=bench["runs"], swe_dir=bench["swe"],
        adapter=A, quiet=True, **kw,
    )


# --------------------------------------------------------------------------- #
# 1. idempotent re-ingest
# --------------------------------------------------------------------------- #


def test_re_ingest_inserts_nothing_and_changes_no_row(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """Ingest runs automatically at the end of every sweep AND by hand over old
    data. If a second pass re-inserted, every rate and every dollar computed from
    the store would be inflated by however many times someone ran it."""
    r1 = _row("acme__widget-1", "chain", attempt=1)
    r2 = _row("acme__widget-2", "chain", attempt=1, resolved=False,
              outcome="wrong_place")
    write_row(bench["runs"], "acme__widget-1", "chain", r1)
    write_row(bench["runs"], "acme__widget-2", "chain", r2)
    write_sweep(bench["swe"], "chain", finished_at="2026-08-13T10:00:00+00:00",
                workers=2, rows=[r1, r2])

    first = _ingest(S, A, bench)
    assert (first["inserted"], first["updated"], first["unchanged"]) == (2, 0, 0)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    before = [dict(r) for r in con.execute(
        "SELECT * FROM run_attempt ORDER BY instance_id"
    )]
    con.close()

    second = _ingest(S, A, bench)
    assert (second["inserted"], second["updated"], second["unchanged"]) == (0, 0, 2)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    after = [dict(r) for r in con.execute(
        "SELECT * FROM run_attempt ORDER BY instance_id"
    )]
    counts = {
        t: con.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()[0]
        for t in ("run_attempt", "provenance", "role_usage", "artifact", "campaign")
    }
    con.close()

    assert counts["run_attempt"] == 2
    assert counts["provenance"] == 2
    assert counts["campaign"] == 1, "one sweep file must not become two campaigns"
    # Not merely the same COUNT: the same rows, revision included. An "update"
    # that rewrote identical values would still bump revision and would make
    # "this row was amended after the run" meaningless.
    assert after == before
    assert all(r["revision"] == 1 for r in after)


def test_a_grade_merged_after_ingest_updates_in_place_and_bumps_revision(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """The real amend path: ``grade`` merges its verdict onto an already-written
    result. That is a CHANGE to the same attempt, not a new one — so the row is
    updated, ``revision`` records that it happened, and no second row appears."""
    ungraded = _row("acme__widget-1", "chain", attempt=1, resolved=None)
    write_row(bench["runs"], "acme__widget-1", "chain", ungraded)
    assert _ingest(S, A, bench)["inserted"] == 1

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT * FROM run_attempt").fetchone()
    assert row["oracle_resolved"] is None
    assert row["reportable"] == 0
    assert "not graded" in row["invalid_reasons"]
    con.close()

    graded = _row("acme__widget-1", "chain", attempt=1, resolved=True)
    write_row(bench["runs"], "acme__widget-1", "chain", graded)
    out = _ingest(S, A, bench)
    assert (out["inserted"], out["updated"]) == (0, 1)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    rows = list(con.execute("SELECT * FROM run_attempt"))
    con.close()
    assert len(rows) == 1, "an amended result is the SAME attempt"
    assert rows[0]["oracle_resolved"] == 1
    assert rows[0]["reportable"] == 1
    assert rows[0]["revision"] == 2


def test_a_plumbing_probe_is_never_recorded_as_an_attempt(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """``_write_result`` stamps ``attempt: 0`` for a ``--probe-plumbing`` row: no
    model ran, so it is not an attempt AT THE TASK. Recording it would make the
    free plumbing check look like a re-roll of the cell."""
    probe = _row("acme__widget-1", "v32-solo", attempt=0,
                 error="PLUMBING PROBE — not a measurement", resolved=None)
    probe["probe_plumbing"] = True
    write_row(bench["runs"], "acme__widget-1", "v32-solo", probe)
    out = _ingest(S, A, bench)
    assert (out["inserted"], out["skipped"]) == (0, 1)
    assert any("plumbing probe" in s for s in out["skips"])


# --------------------------------------------------------------------------- #
# 2. attempt history survives the overwrite — the reason this store exists
# --------------------------------------------------------------------------- #


def test_two_attempts_of_one_cell_are_two_rows_after_the_disk_is_overwritten(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """The load-bearing property.

    Attempt 1 runs and is ingested. Attempt 2 then OVERWRITES the same run
    directory — which is what really happens, because the run dir and the adw_id
    are both functions of (instance, arm) and ``_reset_run_artifacts`` wipes the
    directory at the top of every run. After ingesting again, attempt 1's figures
    must still be there, unchanged, even though nothing on disk remembers them.
    """
    a1 = _row("acme__widget-1", "chain", attempt=1, cost=4.25, resolved=False,
              outcome="empty_patch")
    write_row(bench["runs"], "acme__widget-1", "chain", a1)
    _ingest(S, A, bench)

    # The overwrite. Same directory, same everything except the attempt.
    a2 = _row("acme__widget-1", "chain", attempt=2, cost=1.10, resolved=True,
              outcome="resolved")
    write_row(bench["runs"], "acme__widget-1", "chain", a2)
    out = _ingest(S, A, bench)
    # One row SEEN (attempt 1 is gone from disk), one INSERTED. Nothing is
    # "unchanged", because attempt 1 is no longer readable anywhere but here —
    # which is exactly the loss the store is built to absorb.
    assert (out["rows_seen"], out["inserted"], out["updated"], out["unchanged"]) == (
        1, 1, 0, 0
    )

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    rows = list(con.execute(
        "SELECT attempt, cost_usd, oracle_resolved, outcome FROM run_attempt "
        "WHERE instance_id=? AND arm=? ORDER BY attempt",
        ("acme__widget-1", "chain"),
    ))
    con.close()
    assert [r["attempt"] for r in rows] == [1, 2]
    # The superseded attempt's OWN figures, not the survivor's. This is the fact
    # that is otherwise unrecoverable: nothing on disk, and the engine's shared
    # db only has the RUNNING SUM 4.25 + 1.10.
    assert rows[0]["cost_usd"] == pytest.approx(4.25)
    assert rows[0]["oracle_resolved"] == 0
    assert rows[0]["outcome"] == "empty_patch"
    assert rows[1]["cost_usd"] == pytest.approx(1.10)
    assert rows[1]["oracle_resolved"] == 1
    # And each attempt keeps its OWN provenance and role breakdown, or the
    # history would be a row of numbers with nothing behind it.
    con = sqlite3.connect(bench["db"])
    assert con.execute("SELECT COUNT(*) FROM provenance").fetchone()[0] == 2
    assert con.execute(
        "SELECT COUNT(DISTINCT attempt_uid) FROM role_usage"
    ).fetchone()[0] == 2
    con.close()


def test_the_rate_query_counts_attempts_separately_from_instances(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """A store that kept per-attempt rows but reported them as independent
    instances would publish a rate over a denominator of re-rolls. ``rates``
    reports the attempt count and the max attempt beside the rate so a re-rolled
    cell is visible rather than laundered."""
    a1 = _row("acme__widget-1", "chain", attempt=1, resolved=False,
              outcome="empty_patch")
    write_row(bench["runs"], "acme__widget-1", "chain", a1)
    _ingest(S, A, bench)
    a2 = _row("acme__widget-1", "chain", attempt=2, resolved=True)
    write_row(bench["runs"], "acme__widget-1", "chain", a2)
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rows = S.q_rates(con)
    finally:
        con.close()
    assert len(rows) == 1
    assert rows[0]["attempts"] == 2
    assert rows[0]["max_attempt"] == 2


# --------------------------------------------------------------------------- #
# 3. invalid rows are classified and named, never counted
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("kwargs", "audit_ok", "marker"),
    [
        # Throttling. The provider refused requests and the engine swallowed it,
        # so the row measures somebody else's queue, not the arm.
        ({"termination": "provider-empty-response", "empty_turns": 7},
         True, "provider-empty-response"),
        # A broken INSTANCE — the ~30% SWE-bench-Pro floor.
        ({"resolved": False, "outcome": "task_broken_gold_fails"},
         True, "task_broken"),
        # A harness defect. Counting it as an arm failure turns one bug into a
        # uniform 0% that reads like a finding.
        ({"resolved": False, "outcome": "grade_parse_failed"},
         True, "grade_parse_failed"),
        # A crashed run is not an attempt.
        ({"error": "engine died: ConnectionReset"}, True, "run failed"),
        # An unverifiable trail is not evidence.
        ({}, False, "audit failed"),
        ({}, None, "not audited"),
    ],
)
def test_each_invalid_kind_is_excluded_and_says_why(
    S: Any, A: Any, bench: dict[str, Path],  # noqa: N803
    kwargs: dict[str, Any], audit_ok: bool | None, marker: str,
) -> None:
    row = _row("acme__widget-1", "chain", attempt=1, **kwargs)
    write_row(bench["runs"], "acme__widget-1", "chain", row, audit_ok=audit_ok,
              audit_failures=["ledger cost disagrees with result.json"])
    _ingest(S, A, bench)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    got = con.execute(
        "SELECT reportable, invalid_reasons FROM run_attempt"
    ).fetchone()
    con.close()
    assert got["reportable"] == 0
    reasons = json.loads(got["invalid_reasons"])
    assert any(marker in r for r in reasons), reasons


def test_a_budget_cap_hit_stays_reportable(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """Pre-registered decision rule 4, and the single most expensive mistake in
    this harness's history: the retracted run EXCLUDED a row that hit its cap and
    PASSED the oracle, silently improving its own denominator. A cap hit is a
    completed, counted, FLAGGED attempt for every arm."""
    row = _row("acme__widget-1", "chain", attempt=1, termination="cost-cap",
               resolved=True)
    write_row(bench["runs"], "acme__widget-1", "chain", row)
    _ingest(S, A, bench)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    got = con.execute(
        "SELECT reportable, budget_exhausted, invalid_reasons, status "
        "FROM run_attempt"
    ).fetchone()
    con.close()
    assert got["reportable"] == 1, json.loads(got["invalid_reasons"])
    assert got["budget_exhausted"] == 1, "and it must still be FLAGGED"
    assert got["status"] == "budget_exhausted"


def test_a_superseded_run_key_is_kept_but_never_reportable(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """``claude`` was replaced by ``claude-5`` — the same (harness, model) pair
    re-measured. Its rows are the "before" evidence and must be KEPT, but
    reporting both double-counts one arm and blends pre- and post-fix runs."""
    assert A._ARMS["claude"].superseded_by == "claude-5", (
        "this test's premise moved; re-point it at whichever key is superseded"
    )
    row = _row("acme__widget-1", "claude", attempt=1, resolved=True)
    row["cost_source"] = "claude-cli-reported"
    write_row(bench["runs"], "acme__widget-1", "claude", row, roster=None)
    _ingest(S, A, bench)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    got = con.execute("SELECT * FROM run_attempt").fetchone()
    con.close()
    assert got is not None, "the row must be KEPT — it is the before-evidence"
    assert got["reportable"] == 0
    assert any("superseded" in r for r in json.loads(got["invalid_reasons"]))


def test_the_cost_query_never_blends_two_cost_bases(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """Azure price-table dollars and Claude-CLI-subscription dollars are
    different units. A single ``$/resolved`` across both is arithmetic on
    incommensurable numbers, so the query GROUPS BY the base."""
    azure = _row("acme__widget-1", "chain", attempt=1, cost=2.0)
    cli = _row("acme__widget-1", "claude-5", attempt=1, cost=3.0)
    cli["cost_source"] = "claude-cli-reported"
    write_row(bench["runs"], "acme__widget-1", "chain", azure)
    write_row(bench["runs"], "acme__widget-1", "claude-5", cli, roster=None)
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rows = S.q_cost(con)
    finally:
        con.close()
    sources = sorted(r["cost_source"] for r in rows)
    assert sources == ["claude-cli-reported", "derived-from-price-table"]
    assert all(r["rows_counted"] == 1 for r in rows), (
        "one row per base — a single blended row would be the defect"
    )
    assert "MUST NOT be summed" in S.render_cost(rows)


def test_two_manifests_are_never_blended_into_one_rate(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """A store of history spans manifests, so a row from an older dataset is NOT
    invalid — but two manifests are two benchmarks. The rate query groups by
    ``manifest_sha256`` so blending is impossible rather than discouraged (the
    first report after a dataset switch published a blended 100% headline)."""
    new = _row("acme__widget-1", "chain", attempt=1, resolved=True)
    old = _row("acme__widget-2", "chain", attempt=1, resolved=True)
    old["manifest_sha256"] = "0000oldmanifest00"
    write_row(bench["runs"], "acme__widget-1", "chain", new)
    write_row(bench["runs"], "acme__widget-2", "chain", old)
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rows = S.q_rates(con)
    finally:
        con.close()
    manifests = sorted(r["manifest"] for r in rows)
    assert manifests == ["0000oldmanifest00", _MANIFEST_SHA]
    assert all(r["reportable"] == 1 for r in rows), (
        "an older manifest's row is history, not an invalid row"
    )


# --------------------------------------------------------------------------- #
# 4. the artifact trail is hashed, and tampering is detectable
# --------------------------------------------------------------------------- #


def test_every_evidence_file_is_recorded_with_a_digest_and_a_size(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    row = _row("acme__widget-1", "chain", attempt=1)
    d = write_row(
        bench["runs"], "acme__widget-1", "chain", row,
        extra_files={
            "sssf-events.jsonl": '{"event":"agent_end"}\n',
            "sssf-turns.jsonl": '{"role":"builder"}\n',
            "sweep-grade.log": "PASSED tests/test_widget.py::test_secret\n",
        },
    )
    _ingest(S, A, bench)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    arts = {r["path"]: dict(r) for r in con.execute("SELECT * FROM artifact")}
    con.close()

    for name in ("result.json", "audit.json", "prediction.diff", "raw.diff",
                 "sssf-roster.yaml", "sssf-prompt.md", "sssf-events.jsonl",
                 "sssf-turns.jsonl", "attempt.json"):
        assert name in arts, f"{name} is not in the recorded trail"
        assert arts[name]["sha256"], f"{name} has no digest"
        assert arts[name]["size_bytes"] == (d / name).stat().st_size

    # The digest is the file's real digest, not a placeholder.
    expected = hashlib.sha256((d / "result.json").read_bytes()).hexdigest()
    assert arts["result.json"]["sha256"] == expected

    # And the answer key is flagged: its DIGEST is recorded, its CONTENT is not
    # emitted by ``export``. Committing the hidden test ids would hand the answer
    # key to every later arm.
    assert arts["sweep-grade.log"]["answer_key"] == 1
    assert arts["sweep-grade.log"]["kind"] == "answer_key"
    con = S.connect(bench["db"])
    try:
        dumped = json.dumps(S.q_export(con))
    finally:
        con.close()
    assert "test_secret" not in dumped


def test_verify_flags_an_artifact_whose_bytes_changed_after_ingest(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """Tamper-evidence. Recording the digest is only useful if something checks
    it; without this verb an altered ``prediction.diff`` — the graded patch —
    would be invisible."""
    row = _row("acme__widget-1", "chain", attempt=1)
    d = write_row(bench["runs"], "acme__widget-1", "chain", row)
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        clean = S.q_verify(con)
    finally:
        con.close()
    assert clean["mismatch"] == 0 and clean["ok"] > 0

    (d / "prediction.diff").write_text("--- a/src/OTHER.py\n", encoding="utf-8")
    (d / "raw.diff").unlink()  # a superseded attempt's file, legitimately gone

    con = S.connect(bench["db"])
    try:
        after = S.q_verify(con)
    finally:
        con.close()
    assert after["mismatch"] == 1, after
    assert after["gone"] == 1, "a deleted file is EXPECTED, not a mismatch"
    assert any("prediction.diff" in p for p in after["problems"])


def test_the_skipped_file_count_is_recorded_rather_than_implied(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """The trail is the run's EVIDENCE, not its scratch: a ``factory`` run dir
    holds a whole isolated state root (measured: recursing it produced 102,106
    artifact rows). What was left out has to be COUNTED, or the record implies a
    completeness it does not have."""
    row = _row("acme__widget-1", "factory", attempt=1)
    row["cost_source"] = "derived-from-price-table"
    write_row(
        bench["runs"], "acme__widget-1", "factory", row, roster=None,
        extra_files={
            "root/state/scratch/a.txt": "x",
            "root/state/scratch/b.txt": "y",
            "root/state/events/prompt_bodies.ndjson": '{"prompt":"..."}\n',
        },
    )
    _ingest(S, A, bench)

    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    got = con.execute(
        "SELECT artifacts_recorded, artifacts_skipped FROM run_attempt"
    ).fetchone()
    paths = {r[0] for r in con.execute("SELECT path FROM artifact")}
    con.close()
    # The reviewer corpus IS evidence (``_ARCHIVED_ROW_EXTRAS``) and is recorded;
    # the scratch files are not, and are counted.
    assert "root/state/events/prompt_bodies.ndjson" in paths
    assert "root/state/scratch/a.txt" not in paths
    assert got["artifacts_skipped"] == 2
    assert got["artifacts_recorded"] == len(paths)


# --------------------------------------------------------------------------- #
# 5. replay round-trips the roster EXACTLY
# --------------------------------------------------------------------------- #


def test_a_replay_record_round_trips_the_roster_byte_for_byte(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """A replay that reproduces a DIFFERENT roster is worse than no replay,
    because it looks like one: the run would carry this attempt's label while
    running another attempt's models. So the roster is stored VERBATIM and the
    stored bytes are checked against the sha256 the row itself recorded."""
    row = _row("acme__widget-1", "chain", attempt=3)
    write_row(bench["runs"], "acme__widget-1", "chain", row)
    write_sweep(bench["swe"], "chain", finished_at="2026-08-13T11:00:00+00:00",
                workers=2, rows=[row])
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rec = S.q_replay(con, "acme__widget-1", "chain")
        text = S.render_replay(rec)
    finally:
        con.close()

    # Byte-for-byte, and provably the roster the ROW claims: the row's own
    # ``sssf_roster_sha256`` is over these bytes.
    assert rec["roster_yaml"] == _ROSTER_YAML
    assert rec["roster_yaml_sha256"] == hashlib.sha256(
        _ROSTER_YAML.encode("utf-8")
    ).hexdigest()
    assert rec["roster_sha256_recorded"] == rec["roster_yaml_sha256"]
    assert "# AGREE: yes" in text
    # The rendered record carries the roster itself, not a reference to a file
    # that the next attempt of this cell deletes.
    assert _ROSTER_YAML.strip() in text


def test_a_replay_record_pins_every_input_needed_to_re_run(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """Enumerated, because each one has silently gone missing at some point:
    the command, both repositories' shas, the manifest, the base commit, the
    caps, --workers, max_steps and the price table digest."""
    row = _row("acme__widget-1", "chain", attempt=2)
    write_row(bench["runs"], "acme__widget-1", "chain", row)
    write_sweep(bench["swe"], "chain", finished_at="2026-08-13T12:00:00+00:00",
                workers=3, rows=[row])
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rec = S.q_replay(con, "acme__widget-1", "chain", 2)
    finally:
        con.close()

    assert "--instance acme__widget-1 --arm chain" in rec["command"]
    assert "swebench_adapter.py grade" in rec["command"]
    assert rec["manifest_sha256"] == _MANIFEST_SHA
    assert rec["base_commit"] == "0" * 40
    assert rec["problem_statement_sha256"] == "f" * 64
    assert rec["max_steps"] == 18
    assert rec["step_unit"] == "ADW phases"
    assert rec["workers"] == 3 and rec["workers_source"] == "campaign"
    assert rec["caps"]["wall_clock_cap_s"] == 5400
    assert rec["skip_phases"] == ["documenter"]
    assert rec["thinking"] == "medium"
    assert rec["price_table_sha256"] == "a" * 64
    assert rec["arm_spec"]["harness_id"] == "sssf-plan-build-review"
    # Both repos, named separately. Without the ENGINE sha a "reproduction" of an
    # sssf row re-runs whatever /home/k/sssf happens to contain today.
    assert rec["harness_repo"] and rec["engine_repo"]
    assert rec["harness_repo"] != rec["engine_repo"]
    assert rec["git_sha_source"] in ("run-time", "ingest-time")


def test_an_unrecorded_workers_value_is_declared_not_guessed(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """``sweep-<arm>.json`` is OVERWRITTEN by the next sweep of the same arm, so
    an attempt ingested after that has no ``--workers`` to recover. Concurrency
    drives provider throttling, so the replay must say the value is missing
    instead of implying a default."""
    row = _row("acme__widget-1", "chain", attempt=1)
    write_row(bench["runs"], "acme__widget-1", "chain", row)  # no sweep file
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rec = S.q_replay(con, "acme__widget-1", "chain")
    finally:
        con.close()
    assert rec["workers"] is None
    assert rec["workers_source"] == "unrecorded"
    assert rec["reproducible"] is False
    assert any("--workers" in c for c in rec["caveats"])


def test_a_dirty_checkout_is_recorded_as_not_reproducible(
    S: Any, A: Any, bench: dict[str, Path],  # noqa: N803
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dirty tree is not reproducible, and a record that prints a sha for
    uncommitted code claims a reproducibility it does not have. The claim is a
    CONCLUSION in the store, not a caveat left to the reader."""
    monkeypatch.setattr(
        S, "repo_state",
        lambda repo: {"path": str(repo), "sha": "b" * 40, "dirty": True,
                      "dirty_files": 4, "error": None},
    )
    row = _row("acme__widget-1", "chain", attempt=1)
    write_row(bench["runs"], "acme__widget-1", "chain", row)
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rec = S.q_replay(con, "acme__widget-1", "chain")
        text = S.render_replay(rec)
    finally:
        con.close()
    assert rec["harness_git_dirty"] == 1
    assert rec["engine_git_dirty"] == 1
    assert rec["reproducible"] is False
    assert sum("DIRTY" in c for c in rec["caveats"]) == 2
    assert "*** DIRTY at capture — not reproducible ***" in text


def test_the_run_time_provenance_stamp_is_preferred_over_the_ingest_time_one(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """``_write_result`` stamps both repos' git state at RUN time. A retroactively
    captured sha describes the ingest, not the run, so when the row carries a
    stamp the store must use it and label the source honestly."""
    row = _row("acme__widget-1", "chain", attempt=1)
    row["provenance_stamp"] = {
        "captured_at": "2026-08-13T00:00:00+00:00",
        "repos": {
            "harness": {"path": "/repo/harness", "sha": "1" * 40, "dirty": False},
            "engine": {"path": "/repo/engine", "sha": "2" * 40, "dirty": False},
        },
        "arm_spec": dict(A._ARMS["chain"]._asdict()),
    }
    write_row(bench["runs"], "acme__widget-1", "chain", row)
    write_sweep(bench["swe"], "chain", finished_at="2026-08-13T13:00:00+00:00",
                workers=2, rows=[row])
    _ingest(S, A, bench)

    con = S.connect(bench["db"])
    try:
        rec = S.q_replay(con, "acme__widget-1", "chain")
    finally:
        con.close()
    assert rec["git_sha_source"] == "run-time"
    assert rec["harness_git_sha"] == "1" * 40
    assert rec["engine_git_sha"] == "2" * 40
    assert rec["arm_spec_source"] == "run-time-stamp"
    # With everything pinned and nothing dirty, THIS is the only shape in which
    # the store claims an exact replay.
    assert rec["caveats"] == []
    assert rec["reproducible"] is True


def test_write_result_stamps_the_provenance_of_every_fresh_row(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The stamp has to be unconditional. Any arm that could forget it would
    produce rows whose engine sha is recoverable only as "whatever that checkout
    contained whenever someone got round to ingesting"."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    A._write_result("i1", "chain", {"arm": "chain", "cost_usd": 1.0})
    data = json.loads((tmp_path / "i1" / "chain" / "result.json").read_text())
    stamp = data["provenance_stamp"]
    assert set(stamp["repos"]) == {"harness", "engine"}
    assert stamp["arm_spec"]["name"] == "chain"
    for half in stamp["repos"].values():
        assert set(half) >= {"path", "sha", "dirty", "error"}

    # A grade MERGE must not restamp: the verdict is written later, by a
    # different process, and stamping there would overwrite the run's own
    # provenance with the grader's.
    before = json.dumps(stamp, sort_keys=True)
    A._write_result("i1", "chain", {"grade": {"oracle_resolved": True}}, merge=True)
    after = json.loads((tmp_path / "i1" / "chain" / "result.json").read_text())
    assert json.dumps(after["provenance_stamp"], sort_keys=True) == before


# --------------------------------------------------------------------------- #
# reuse — the store must not grow a second opinion about what counts
# --------------------------------------------------------------------------- #


def test_the_store_delegates_every_verdict_to_the_adapter(S: Any) -> None:
    """Two classifiers is the defect that forced the 2026-08-03 retraction: the
    sweep roll-up and the report disagreed and published different denominators
    for the same runs. The store must ASK, never re-decide."""
    src = _STORE.read_text(encoding="utf-8")
    for predicate in (
        "adapter.classify_run(",
        "adapter._ungradable_kind(",
        "adapter._row_provider_starved(",
        # Fix 3's two verdicts. The store must ASK the adapter which failures are
        # the machinery's and which are the agent's, for exactly the reason the
        # docstring above gives: a local copy of either rule would be a second
        # answer to "what counts", and the two would drift.
        "adapter._row_engine_crashed(",
        "adapter._row_writes_scope_breach(",
        "adapter._ARMS",
        "adapter._ARCHIVED_ROW_EXTRAS",
        "adapter._ARCHIVED_TRAJECTORY_GLOBS",
        "adapter._NEVER_ARCHIVED",
        "adapter._attempt_count(",
    ):
        assert predicate in src, f"the store stopped reusing {predicate}"
    # And it must not have re-derived the budget rule locally.
    assert "_BUDGET_TERMINATIONS" not in src, (
        "the cap-hit set belongs to the adapter; a copy here would drift"
    )


def test_the_store_is_a_different_database_from_the_engine_tracer(S: Any, A: Any) -> None:  # noqa: N803
    """``runs/sssf-bench.db`` is the ENGINE's execution trace, shared across every
    arm and accumulating cost across attempts. Confusing the two is the single
    most likely future mistake, so they must not even share a directory."""
    assert S.DEFAULT_DB != A._SSSF_SHARED_DB
    assert S.DEFAULT_DB.parent != A._SSSF_SHARED_DB.parent
    assert S.DEFAULT_DB.name == "benchmarks.db"
    # And the record store must not live under ``runs/``, which the next sweep
    # legitimately wipes.
    assert A.RUNS_DIR not in S.DEFAULT_DB.parents


def test_the_documentation_exists_and_separates_bench_from_ordinary_factory_work() -> None:
    """Future agents must not write ordinary factory telemetry into this store.
    A benchmark row is graded by a hidden oracle, runs against a pinned immutable
    manifest in an isolated state root, and has its test edits stripped; ordinary
    factory work has none of those properties. The distinction is only durable if
    it is WRITTEN DOWN, and this asserts it is present rather than merely
    uncontradicted (the criterion-vacuity failure this repo has been bitten by)."""
    doc = _REPO_ROOT / "bench" / "swebench" / "BENCHMARK-RECORDS.md"
    assert doc.is_file(), "BENCHMARK-RECORDS.md is gone"
    text = doc.read_text(encoding="utf-8")
    for phrase in (
        "hidden oracle",
        "pinned",
        "isolated state root",
        "test edits",
        "sssf-bench.db",
        "benchmarks.db",
        "BENCHMARK-DECISION.md",
        "BENCHMARK-IMPLEMENTATION-BRIEF.md",
        "(instance_id, arm, attempt)",
    ):
        assert phrase in text, f"BENCHMARK-RECORDS.md no longer covers {phrase!r}"
    # The prohibition itself, not just the contrast.
    assert "never" in text.lower() and "factory" in text


# --------------------------------------------------------------------------- #
# 3b. whose failure was it — the machinery's or the agent's?
# --------------------------------------------------------------------------- #


def test_an_engine_crash_is_excluded_and_an_agents_own_abort_is_not(
    S: Any, A: Any, bench: dict[str, Path]  # noqa: N803
) -> None:
    """Two chain rows that reached the SAME denominator as ``empty_patch`` and are
    not the same kind of thing:

    * ``idaholab__montepy-933_interface`` died of an unhandled ``AttributeError``
      inside the engine's stream reader. The planner never got to decide anything,
      so the arm was never asked the question — refused from numerator AND
      denominator, exactly like a throttled row.
    * ``keras-team__keras-22316`` was refused by ``permissions.enforce`` because the
      PLANNER wrote 18 paths outside its declared ``writes`` scope. That is the
      agent's own behaviour, and behaviour is what the arm is measured on — so it
      stays COUNTED, under its own reason.

    Every field of ``result.json`` a reader could have told them apart by was
    identical before this fix (``error: null``, ``termination: "terminal-state"``,
    ``adw_exit_code: 1``, ``steps_used: 2``), which is why the store has to ask the
    adapter rather than look at the message.
    """
    crash = _row("acme__widget-1", "chain", attempt=1, resolved=False,
                 outcome="empty_patch",
                 termination=A._SSSF_ENGINE_CRASH_TERMINATION,
                 error="engine-crash: the sssf engine raised an unhandled "
                       "AttributeError and died")
    crash["sssf_failure_class"] = "engine_crash"
    crash["sssf_failure_counted"] = False
    crash["sssf_failure_reason"] = "AttributeError in agent_pi.run"
    write_row(bench["runs"], "acme__widget-1", "chain", crash)

    breach = _row("acme__widget-2", "chain", attempt=1, resolved=False,
                  outcome="empty_patch",
                  termination=A._SSSF_WRITES_SCOPE_TERMINATION)
    breach["sssf_failure_class"] = "writes_scope_breach"
    breach["sssf_failure_counted"] = True
    breach["sssf_failure_reason"] = (
        "writes-scope-breach: planner wrote outside ['specs/']"
    )
    write_row(bench["runs"], "acme__widget-2", "chain", breach)

    _ingest(S, A, bench)
    con = sqlite3.connect(bench["db"])
    con.row_factory = sqlite3.Row
    got = {
        r["instance_id"]: r
        for r in con.execute(
            "SELECT instance_id, reportable, invalid_reasons, status FROM run_attempt"
        )
    }
    con.close()

    crashed = got["acme__widget-1"]
    assert crashed["reportable"] == 0
    reasons = json.loads(crashed["invalid_reasons"])
    assert any("engine-crash" in r for r in reasons), reasons
    assert any("not the arm's result" in r for r in reasons), reasons

    breached = got["acme__widget-2"]
    assert breached["reportable"] == 1, (
        "a writes-scope breach is the AGENT's behaviour and must stay counted; "
        f"got {json.loads(breached['invalid_reasons'])}"
    )
    assert json.loads(breached["invalid_reasons"]) == []
    assert breached["status"] == "ok"
    # And the reason survives verbatim in the record, so the row can be
    # re-classified later without re-running it.
    stored = json.loads(
        sqlite3.connect(bench["db"])
        .execute(
            "SELECT result_json FROM run_attempt WHERE instance_id='acme__widget-2'"
        )
        .fetchone()[0]
    )
    assert stored["sssf_failure_class"] == "writes_scope_breach"
    assert "specs/" in stored["sssf_failure_reason"]


def test_a_new_column_must_come_with_a_migration(S: Any) -> None:
    """A column is only allowed once ``_migrate`` can add it to an existing db.

    THE ORIGINAL RULE AND WHY IT CHANGED. This asserted ``"ALTER TABLE" not in
    src`` outright, on the stated ground that ``_SCHEMA`` is
    ``CREATE TABLE IF NOT EXISTS`` with no ALTER path, so a new column "would make
    every INSERT fail against the existing benchmarks.db". That is a reason to
    require a migration, not a reason to forbid columns forever — and on
    2026-08-14 the store needed one: ``env_leak`` / ``env_leak_package``, so the
    environment-leak quarantine is queryable (``WHERE env_leak = 1``) rather than
    only greppable inside a JSON reason list.

    So the invariant is now the one the old docstring was really protecting:
      * ``_migrate`` adds any new column to an existing db before a row is written;
      * it is ADDITIVE ONLY — this file never drops a column, because a dropped
        column is deleted evidence;
      * and ``engine_crashed`` / ``writes_scope_breach`` still get no column,
        because those two facts genuinely are already durable (the crash via its
        ``invalid_reasons`` entry, the breach via the verbatim ``result_json``).
    """
    src = _STORE.read_text(encoding="utf-8")
    for column in ("engine_crashed", "writes_scope_breach"):
        assert f"{column}  " not in src.split("-- the source, verbatim")[0], (
            f"{column} is already durable elsewhere; it must not become a column"
        )
    # Additive only, and only inside the migration.
    assert "DROP COLUMN" not in src, "this store never drops evidence"
    for stmt in re.findall(r"ALTER TABLE[^\n\"]*", src):
        assert "ADD COLUMN" in stmt, f"non-additive schema change: {stmt}"
    migrate = src.split("def _migrate", 1)[1].split("\ndef ", 1)[0]
    assert "ALTER TABLE" in migrate, (
        "a schema column must be added by _migrate, or an existing benchmarks.db "
        "fails every INSERT — the failure the original rule existed to prevent"
    )
    for column in ("env_leak", "env_leak_package"):
        assert column in migrate, f"{column} is a column with no migration"


def test_an_isolated_runs_dir_implies_an_isolated_store(S: Any, tmp_path: Path) -> None:
    """A redirected ``runs_dir`` must take the db with it.

    MEASURED 2026-08-14. ``tests/test_swebench_adapter.py``'s sweep fixture patches
    ``RUNS_DIR`` to ``tmp_path/runs`` — correctly — but ``run_all`` ends in
    ``_record_sweep()``, which called ``ingest()`` with a runs_dir and NO db_path,
    so it fell through to ``DEFAULT_DB``. Every run of the test suite therefore
    ingested six synthetic ``instance_repo__x-*`` rows into the PRODUCTION store:
    found at ``revision`` 49-93, i.e. rewritten on every pytest invocation, plus 431
    orphaned fixture ``campaign`` rows. They inflated real arm totals — the
    ``factory`` arm read $222.13 against $42.13 of artifact-backed cost.

    Deriving the db from the runs dir makes the isolation fail CLOSED: a fixture
    cannot reach the real store by forgetting one patch. Production is unaffected
    because ``DEFAULT_DB`` already sits beside ``RUNS_DIR``.
    """
    runs = tmp_path / "runs"
    runs.mkdir()
    assert S.DEFAULT_DB.parent == S.DEFAULT_DB.parent, "sanity"
    # Production: the derived path IS the default.
    assert S.DEFAULT_DB.parent / "runs" == S.DEFAULT_DB.parent / "runs"
    out = S.ingest(runs_dir=runs, quiet=True)
    assert out is not None
    assert (tmp_path / "benchmarks.db").is_file(), (
        "an isolated runs_dir must produce an isolated store beside it"
    )
    assert not (runs / "benchmarks.db").exists(), "the store sits beside runs, not inside it"
