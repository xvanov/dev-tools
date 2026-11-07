"""Tests for flaky-test detection + quarantine (WS4.4).

Suite runs are MOCKED via an injectable ``TestRunner`` — no nested pytest.

Covers:
* a test that fails-then-passes across reruns -> flaky -> quarantined,
  suite treated non-blocking, a surfacing event emitted.
* a test that fails consistently -> NOT quarantined, real failure -> blocks.
* the merge_group trigger is present in .github/workflows/test.yml.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from factory.testing.flake import (
    FlakeResult,
    TestRunResult,
    detect_flakes,
    load_quarantine_registry,
    parse_failed_tests,
    record_quarantine,
    run_with_quarantine,
)

# --------------------------------------------------------------------------- #
# Scripted runner helper
# --------------------------------------------------------------------------- #


def _make_scripted_runner(script: dict[str | None, list[TestRunResult]]):
    """Return a runner whose result depends on the scoped node-ids.

    ``script`` maps a key (``None`` for the full-suite run, or a single node-id
    for an isolated rerun) to a QUEUE of results consumed in order; the last
    result repeats once the queue drains.
    """
    calls: list[list[str] | None] = []
    cursors: dict[str | None, int] = {}

    def _run(node_ids: list[str] | None) -> TestRunResult:
        calls.append(node_ids)
        key = None if node_ids is None else node_ids[0]
        queue = script[key]
        idx = min(cursors.get(key, 0), len(queue) - 1)
        cursors[key] = cursors.get(key, 0) + 1
        return queue[idx]

    _run.calls = calls  # type: ignore[attr-defined]
    return _run


# --------------------------------------------------------------------------- #
# parse_failed_tests
# --------------------------------------------------------------------------- #


def test_parse_failed_tests_pytest_output() -> None:
    out = (
        "some noise\n"
        "FAILED tests/test_a.py::test_x - AssertionError: boom\n"
        "ERROR tests/test_b.py::test_y\n"
        "FAILED tests/test_a.py::test_x - AssertionError: boom\n"  # dup
        "1 passed, 2 failed\n"
    )
    assert parse_failed_tests(out) == [
        "tests/test_a.py::test_x",
        "tests/test_b.py::test_y",
    ]


# --------------------------------------------------------------------------- #
# detect_flakes — classification
# --------------------------------------------------------------------------- #


def test_flaky_test_fail_then_pass_is_quarantined() -> None:
    node = "tests/test_flaky.py::test_timing"
    runner = _make_scripted_runner(
        {
            # full suite fails once, reporting the flaky node
            None: [TestRunResult(exit_code=1, failed_tests=[node])],
            # isolated rerun PASSES -> it flapped
            node: [TestRunResult(exit_code=0, failed_tests=[])],
        }
    )
    result = detect_flakes(runner, rerun_count=3)
    assert result.quarantined == [node]
    assert result.real_failures == []
    assert result.blocking is False
    assert result.passed is True


def test_consistent_failure_is_not_quarantined_and_blocks() -> None:
    node = "tests/test_real.py::test_bug"
    runner = _make_scripted_runner(
        {
            None: [TestRunResult(exit_code=1, failed_tests=[node])],
            # every isolated rerun fails too -> real regression
            node: [TestRunResult(exit_code=1, failed_tests=[node])],
        }
    )
    result = detect_flakes(runner, rerun_count=3)
    assert result.real_failures == [node]
    assert result.quarantined == []
    assert result.blocking is True
    assert result.passed is False


def test_mixed_real_and_flaky_blocks_but_still_quarantines_flaky() -> None:
    flaky = "tests/test_a.py::test_flap"
    real = "tests/test_b.py::test_broken"
    runner = _make_scripted_runner(
        {
            None: [TestRunResult(exit_code=1, failed_tests=[flaky, real])],
            flaky: [TestRunResult(exit_code=0, failed_tests=[])],
            real: [TestRunResult(exit_code=1, failed_tests=[real])],
        }
    )
    result = detect_flakes(runner, rerun_count=3)
    assert result.quarantined == [flaky]
    assert result.real_failures == [real]
    assert result.blocking is True  # a real failure present -> still blocks


def test_green_first_run_no_quarantine() -> None:
    runner = _make_scripted_runner({None: [TestRunResult(exit_code=0)]})
    result = detect_flakes(runner)
    assert result.passed is True
    assert result.blocking is False
    assert result.quarantined == []


def test_red_with_unparseable_failures_blocks_conservatively() -> None:
    runner = _make_scripted_runner(
        {None: [TestRunResult(exit_code=2, failed_tests=[])]}
    )
    result = detect_flakes(runner)
    assert result.blocking is True
    assert result.passed is False
    assert result.quarantined == []


def test_flake_needs_only_one_pass_across_reruns() -> None:
    """A test that fails twice then passes on the 3rd rerun still quarantines."""
    node = "tests/test_x.py::test_slow"
    runner = _make_scripted_runner(
        {
            None: [TestRunResult(exit_code=1, failed_tests=[node])],
            node: [
                TestRunResult(exit_code=1, failed_tests=[node]),
                TestRunResult(exit_code=1, failed_tests=[node]),
                TestRunResult(exit_code=0, failed_tests=[]),
            ],
        }
    )
    result = detect_flakes(runner, rerun_count=3)
    assert result.quarantined == [node]
    assert result.blocking is False


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #


def test_record_quarantine_persists_and_dedups(tmp_path: Path) -> None:
    node = "tests/test_a.py::test_x"
    newly = record_quarantine("myapp", [node], software_factory_root=tmp_path)
    assert newly == [node]

    reg = load_quarantine_registry(tmp_path)
    entry = reg["quarantined"]["myapp"][node]  # type: ignore[index]
    assert entry["occurrences"] == 1
    assert entry["status"] == "open"

    # Second time: not newly quarantined, occurrences bumped.
    newly2 = record_quarantine("myapp", [node], software_factory_root=tmp_path)
    assert newly2 == []
    reg2 = load_quarantine_registry(tmp_path)
    assert reg2["quarantined"]["myapp"][node]["occurrences"] == 2  # type: ignore[index]


def test_load_registry_missing_file(tmp_path: Path) -> None:
    assert load_quarantine_registry(tmp_path) == {"quarantined": {}}


# --------------------------------------------------------------------------- #
# run_with_quarantine — surfacing
# --------------------------------------------------------------------------- #


def test_run_with_quarantine_emits_event_and_records(tmp_path: Path) -> None:
    node = "tests/test_flaky.py::test_timing"
    runner = _make_scripted_runner(
        {
            None: [TestRunResult(exit_code=1, failed_tests=[node])],
            node: [TestRunResult(exit_code=0, failed_tests=[])],
        }
    )
    result = run_with_quarantine(
        app="myapp",
        runner=runner,
        software_factory_root=tmp_path,
        rerun_count=3,
        emit_event=True,
        file_direction=False,
    )
    assert isinstance(result, FlakeResult)
    assert result.quarantined == [node]
    assert result.blocking is False

    # Persisted to the registry.
    reg = load_quarantine_registry(tmp_path)
    assert node in reg["quarantined"]["myapp"]  # type: ignore[index]

    # Surfacing event emitted (not silently swallowed).
    events_file = tmp_path / "state" / "events" / "flakes.ndjson"
    assert events_file.is_file()
    rows = [json.loads(line) for line in events_file.read_text().splitlines() if line]
    assert any(
        r["event"] == "flake_quarantined" and node in r["quarantined"] for r in rows
    )


def test_run_with_quarantine_real_failure_no_event(tmp_path: Path) -> None:
    node = "tests/test_real.py::test_bug"
    runner = _make_scripted_runner(
        {
            None: [TestRunResult(exit_code=1, failed_tests=[node])],
            node: [TestRunResult(exit_code=1, failed_tests=[node])],
        }
    )
    result = run_with_quarantine(
        app="myapp",
        runner=runner,
        software_factory_root=tmp_path,
        emit_event=True,
        file_direction=False,
    )
    assert result.blocking is True
    assert result.quarantined == []
    # Nothing quarantined -> no event, no registry file.
    assert not (tmp_path / "state" / "events" / "flakes.ndjson").is_file()
    assert not (tmp_path / "state" / "flake_quarantine.json").is_file()


# --------------------------------------------------------------------------- #
# merge_group workflow trigger
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# tests_green gate integration (opt-in flag)
# --------------------------------------------------------------------------- #


def _real_run_pr(tmp_path: Path):
    from factory.chain.gates.evaluator import PRContext

    return PRContext(
        pr_number=1,
        head_sha="abc",
        base_branch="main",
        repo_root=tmp_path,
        software_factory_root=tmp_path,
        dry_run=False,
    )


def test_gate_quarantines_flaky_red_when_opted_in(tmp_path, monkeypatch) -> None:
    from factory.app_config import AppConfig, AppGatesConfig
    from factory.chain.gates import tests_green

    # Real-run test_command reports RED.
    monkeypatch.setattr(
        tests_green, "_run_command", lambda cmd, cwd: (1, "FAILED x - boom")
    )
    # Flake analysis says: it flapped -> quarantined, non-blocking.
    monkeypatch.setattr(
        tests_green,
        "_flake_analyze",
        lambda pr, cfg, cmd: FlakeResult(
            blocking=False,
            passed=True,
            quarantined=["tests/x.py::test_flap"],
            reason="all failing test(s) flapped on rerun — quarantined",
        ),
    )
    cfg = AppConfig(
        name="myapp",
        repo="o/r",
        gates=AppGatesConfig(test_command="pytest -q", flake_quarantine=True),
    )
    res = tests_green.evaluate(_real_run_pr(tmp_path), cfg)
    assert res.passed is True
    assert res.details["quarantined"] == ["tests/x.py::test_flap"]


def test_gate_blocks_red_when_flake_quarantine_off(tmp_path, monkeypatch) -> None:
    from factory.app_config import AppConfig, AppGatesConfig
    from factory.chain.gates import tests_green

    monkeypatch.setattr(
        tests_green, "_run_command", lambda cmd, cwd: (1, "FAILED x - boom")
    )
    # Guard: analysis must not even be consulted when the flag is off.
    monkeypatch.setattr(
        tests_green,
        "_flake_analyze",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not run")),
    )
    cfg = AppConfig(
        name="myapp",
        repo="o/r",
        gates=AppGatesConfig(test_command="pytest -q", flake_quarantine=False),
    )
    res = tests_green.evaluate(_real_run_pr(tmp_path), cfg)
    assert res.passed is False


def test_gate_blocks_real_failure_even_when_opted_in(tmp_path, monkeypatch) -> None:
    from factory.app_config import AppConfig, AppGatesConfig
    from factory.chain.gates import tests_green

    monkeypatch.setattr(
        tests_green, "_run_command", lambda cmd, cwd: (1, "FAILED x - boom")
    )
    monkeypatch.setattr(
        tests_green,
        "_flake_analyze",
        lambda pr, cfg, cmd: FlakeResult(
            blocking=True,
            passed=False,
            real_failures=["tests/x.py::test_bug"],
            reason="1 consistently-failing test(s) block",
        ),
    )
    cfg = AppConfig(
        name="myapp",
        repo="o/r",
        gates=AppGatesConfig(test_command="pytest -q", flake_quarantine=True),
    )
    res = tests_green.evaluate(_real_run_pr(tmp_path), cfg)
    assert res.passed is False


def test_merge_group_trigger_present_in_test_yml() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    wf = repo_root / ".github" / "workflows" / "test.yml"
    data = yaml.safe_load(wf.read_text())
    # PyYAML parses the bareword ``on:`` key as the boolean True.
    triggers = data.get("on", data.get(True))
    assert triggers is not None, "no 'on:' block in test.yml"
    assert "merge_group" in triggers, "merge_group trigger missing from test.yml"
    # The SAME required jobs must run on the queue (no vacuous-required-check).
    assert set(data["jobs"]) >= {"lint", "typecheck", "pytest"}
