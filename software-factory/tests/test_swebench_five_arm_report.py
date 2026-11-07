"""The five-arm harness and the honest report (bench PR 3 of 3).

Two classes of bug are under test here, and they failed in opposite ways:

* **silent data loss** — the run key was ``(instance, arm)``, so the two
  pre-registered Claude runs (same CLI, two models) resolved to the same
  directory and the second DELETED the first's result, prediction and
  transcript. Nothing anywhere said a measurement had been destroyed.
* **reporting that flattered itself** — ``report --from-archive`` overwrote the
  file it was verifying, budget-exhausted rows were dropped from denominators,
  excluded failures were invisible while excluded passes were named, cached and
  fresh tokens were summed into one column, and an arm with no chain verdict
  published a recall of "0/16 = 0%".

Every test below names the concrete artifact or number the bug produced.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_ADAPTER = Path(__file__).resolve().parents[1] / "bench" / "swebench_adapter.py"


@pytest.fixture
def A() -> Any:  # noqa: N802
    spec = importlib.util.spec_from_file_location("_swe_five_arm", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_SHA = "test-manifest-sha"


def _patch_dirs(A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:  # noqa: N803
    runs = tmp_path / "runs"
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    monkeypatch.setattr(A, "SWE_DIR", tmp_path)
    monkeypatch.setattr(A, "RESULTS_ARCHIVE_DIR", tmp_path / "results-archive")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "profile": "swe-rebench",
                "manifest_sha256": _SHA,
                "instances": [
                    {"instance_id": "inst_old", "created_at": "2026-01-15 00:00:00"},
                    {"instance_id": "inst_new", "created_at": "2026-05-10 00:00:00"},
                    {"instance_id": "inst_mid", "created_at": "2026-03-01 00:00:00"},
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", manifest)
    return runs


def _row(
    runs: Path,
    iid: str,
    key: str,
    *,
    resolved: bool | None = True,
    audit: bool | None = True,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
    outcome: str | None = None,
    p2p: int | None = 42,
    attempt: int = 1,
) -> Path:
    """One (instance, run-key) row dir with all three required artifacts."""
    d = runs / iid / key
    d.mkdir(parents=True, exist_ok=True)
    (d / "prediction.diff").write_text(
        f"diff --git a/{iid}.py b/{iid}.py\n+# x\n", encoding="utf-8"
    )
    payload: dict[str, Any] = {
        "arm": key,
        "instance_id": iid,
        "manifest_sha256": _SHA,
        "error": error,
        "attempt": attempt,
        "tokens_in": 1000,
        "cached_input_tokens": 400,
        "tokens_out": 100,
        "cost_usd": 0.5,
        "wall_clock_s": 60.0,
        "factory_says_green": None,
    }
    if resolved is not None:
        payload["grade"] = {
            "oracle_resolved": resolved,
            "outcome": outcome or ("resolved" if resolved else "wrong_place"),
            "pass_to_pass_count": p2p,
            "pass_to_pass_source": "manifest",
        }
    payload.update(extra or {})
    (d / "result.json").write_text(json.dumps(payload), encoding="utf-8")
    if audit is not None:
        (d / "audit.json").write_text(
            json.dumps(
                {
                    "ok": audit,
                    "failures": [] if audit else ["cost mismatch"],
                    "warnings": [],
                    "trails_scanned": 1,
                    "oracle_probe_failures": [],
                }
            ),
            encoding="utf-8",
        )
    return d


# --------------------------------------------------------------------------- #
# 1. the (instance, arm, MODEL) key — the silent-data-loss bug
# --------------------------------------------------------------------------- #


def test_two_same_arm_different_model_runs_cannot_collide(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """THE bug this PR exists to close.

    The re-run drives the Claude CLI twice on ONE arm — `--model claude-opus-5`
    and `--model claude-opus-4-8`. With a `(instance, arm)` key both resolved to
    `runs/<instance>/claude/`, so the second run's `_reset_run_artifacts` deleted
    the first's `result.json`, `prediction.diff` and transcript and the report
    showed one row where two runs happened.
    """
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    default = A.run_key("claude")
    other = A.run_key("claude", "claude-opus-4-8")
    assert default != other

    d1 = A._run_dir("i1", default)
    d2 = A._run_dir("i1", other)
    assert d1 != d2

    # Write run #1's artifacts, then do everything run #2 does at its top.
    (d1 / "result.json").write_text('{"arm": "claude"}', encoding="utf-8")
    (d1 / "prediction.diff").write_text("run-1 patch", encoding="utf-8")
    (d1 / "claude-transcript.ndjson").write_text("run-1 trail", encoding="utf-8")
    A._reset_run_artifacts(d2)

    assert (d1 / "result.json").exists(), "run #2 destroyed run #1's result"
    assert (d1 / "prediction.diff").read_text(encoding="utf-8") == "run-1 patch"
    assert (d1 / "claude-transcript.ndjson").exists()

    # Same for the work dir (the checkout the agent edits) and the grade mount.
    assert A._work_dir("i1", default) != A._work_dir("i1", other)
    assert A._grade_mount_dir("i1", default) != A._grade_mount_dir("i1", other)


def test_the_two_preregistered_claude_arms_are_separate_rows(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """`claude-5` and `claude-4.8` are the pre-registered ids, and the report
    must treat them as two arms with two rates, not merge them."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "claude-5", resolved=True)
    _row(runs, "inst_old", "claude-4.8", resolved=False)
    rows, refused, foreign, superseded = A._report_rows(runs, _SHA)
    assert not refused and not foreign and not superseded
    assert sorted(r["_arm"] for r in rows) == ["claude-4.8", "claude-5"]
    assert A.arm_spec("claude-5").model == "claude-opus-5"
    assert A.arm_spec("claude-4.8").model == "claude-opus-4-8"
    # Same harness, so a comparison of the two isolates the MODEL.
    assert A.arm_spec("claude-5").harness_id == A.arm_spec("claude-4.8").harness_id


def test_a_superseded_run_key_is_not_a_sixth_arm(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """MEASURED: 18 rows sat in ``runs/*/claude/`` from the pre-fix sweep — the
    same harness and model as ``claude-5``, produced before ``--model`` and the
    model-keyed run dirs existed. The report emitted them beside ``claude-5`` as
    a SIXTH arm, mixing pre- and post-fix evidence in one table.

    The pinned-sha filter cannot catch this: both ran under the same manifest.
    """
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "claude-5", resolved=True)
    _row(runs, "inst_old", "claude", resolved=True)
    rows, refused, foreign, superseded = A._report_rows(runs, _SHA)
    assert [r["_arm"] for r in rows] == ["claude-5"]
    assert not refused and not foreign
    assert len(superseded) == 1
    assert superseded[0]["row"] == "inst_old/claude"
    assert "superseded by 'claude-5'" in superseded[0]["why"]


def test_a_superseded_arm_cannot_be_run(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """Detect-without-remediate guard: segregating the rows in ``report`` is
    not enough on its own — a sweep would still spend real money producing rows
    no table can ever show. Both spend entry points refuse."""
    monkeypatch.setattr(A, "_load_env", lambda: None)
    for argv in (
        ["swebench_adapter.py", "run", "--instance", "i1", "--arm", "claude"],
        ["swebench_adapter.py", "run-all", "--arm", "claude"],
    ):
        monkeypatch.setattr(sys, "argv", argv)
        with pytest.raises(SystemExit, match="superseded by claude-5"):
            A.main()


def test_the_superseded_disclosure_survives_re_derivation(A: Any) -> None:  # noqa: N803
    """A disclosure that does not survive ``--from-archive`` is not a
    disclosure — the same defect the refused/foreign lists were persisted to
    fix. The superseded list is written into the archive meta and read back."""
    import inspect

    assert '"superseded": superseded' in inspect.getsource(A._archive_report_artifacts)
    src = inspect.getsource(A.report)
    assert 'meta.get("superseded")' in src


def test_a_row_in_the_wrong_arm_directory_is_refused(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Two identities for one run (the dir name and the recorded ``arm``) must
    agree, or the row is refused rather than filed under either — a mismatch is
    how a collision would show up after the fact."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    d = _row(runs, "inst_old", "claude-5")
    payload = json.loads((d / "result.json").read_text(encoding="utf-8"))
    payload["arm"] = "claude-4.8"
    (d / "result.json").write_text(json.dumps(payload), encoding="utf-8")
    rows, refused, _foreign, _superseded = A._report_rows(runs, _SHA)
    assert rows == []
    assert "one run cannot be two arms" in refused[0]["why"]


def test_a_sweep_writes_one_file_per_arm_and_model(A: Any) -> None:  # noqa: N803
    """`sweep-<arm>.json` had no model in its name either, so the second claude
    sweep's roll-up overwrote the first's."""
    import inspect

    src = inspect.getsource(A.run_all)
    assert 'SWE_DIR / f"sweep-{key}.json"' in src
    assert 'f"sweep-{arm}.json"' not in src


def test_a_non_selectable_arm_is_one_to_one_with_its_run_dir(A: Any) -> None:  # noqa: N803
    """A run directory must be a function of the ARM, never of the runner family.

    The bare/openhands runners hard-code their own arm name in `_run_dir`, which
    is only safe while each of those bases has exactly ONE registry entry and no
    `--model`. Registering a second variant of one of them would silently
    reintroduce the collision, so the invariant is asserted.

    The `factory` base is the exception, and it is an exception by CONSTRUCTION:
    B.1's `solo-noreview` ablation is a second `base="factory"` arm, so
    `run_factory` takes its arm id and keys every artifact off it. That is
    checked here rather than assumed — if it ever regressed, the ablation would
    overwrite the `factory` arm's rows AND its reviewer replay corpus.
    """
    import inspect

    src = inspect.getsource(A.run_factory)
    assert '_run_dir(instance_id, arm)' in src
    assert '_run_dir(instance_id, "factory")' not in src
    assert '_work_dir(instance_id, arm' in src
    # The `sssf` base is an exception for the SAME reason and is held to the same
    # standard: three arms share `run_sssf`, which differs between them only by
    # the roster the arm id selects, so it must key every artifact off the arm.
    sssf_src = inspect.getsource(A.run_sssf)
    assert "_run_dir(instance_id, arm)" in sssf_src
    assert "_work_dir(instance_id, arm" in sssf_src
    assert '_run_dir(instance_id, "sssf")' not in sssf_src
    parameterized_bases = {"factory", "sssf"}

    bases: dict[str, list[str]] = {}
    for name, spec in A._ARMS.items():
        assert A.run_key(name) == name, f"{name} keys a different directory"
        if not spec.model_selectable:
            bases.setdefault(spec.base, []).append(name)
    for base, names in bases.items():
        if base in parameterized_bases:
            # Distinct run keys are all that is required once the runner is
            # arm-parameterized — and distinctness is what stops a collision.
            assert len(set(names)) == len(names)
            continue
        assert names == [base], (
            f"{base} has non-selectable variants {names}; its runner hard-codes "
            f"{base!r} as its run dir, so they would collide"
        )


# --------------------------------------------------------------------------- #
# 2. --model
# --------------------------------------------------------------------------- #


def test_cli_model_reaches_run_claude_and_defaults_to_opus_5(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(
        A,
        "run_claude",
        lambda iid, **kw: seen.update(iid=iid, **kw),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["swebench_adapter.py", "run", "--instance", "i1", "--arm", "claude-5"],
    )
    A.main()
    assert seen["model"] is None
    assert A.resolve_arm_model("claude-5", None) == "claude-opus-5" == A._CLAUDE_MODEL

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "swebench_adapter.py", "run", "--instance", "i1",
            "--arm", "claude-5", "--model", "claude-opus-4-8",
        ],
    )
    A.main()
    assert seen["model"] == "claude-opus-4-8"
    assert seen["arm"] == "claude-5"


def test_grade_and_audit_take_the_model_too(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A grade that cannot name the model cannot find the right prediction: it
    would grade whichever run happened to own the plain arm directory."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "grade", lambda iid, arm, **kw: seen.update(g_arm=arm))
    monkeypatch.setattr(A, "audit", lambda iid, arm, **kw: seen.update(a_arm=arm))
    for cmd, field in (("grade", "g_arm"), ("audit", "a_arm")):
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "swebench_adapter.py", cmd, "--instance", "i1",
                "--arm", "claude", "--model", "claude-opus-4-8",
            ],
        )
        A.main()
        assert seen[field] == "claude@claude-opus-4-8"


def test_model_is_refused_for_an_arm_whose_weights_come_from_routes(A: Any) -> None:  # noqa: N803
    """Pinning a model on the factory arm here would REPORT a model the run did
    not necessarily use — the escalation-to-hard-tier finding is exactly that."""
    with pytest.raises(SystemExit, match="routes.yaml"):
        A.resolve_arm_model("factory", "azure/gpt-5.4")
    with pytest.raises(SystemExit, match="routes.yaml"):
        A.run_key("bare", "azure/gpt-5.4")


def test_a_model_suffixed_run_key_is_still_certified_as_a_claude_arm(A: Any) -> None:  # noqa: N803
    """#224 attached every claude-specific certification via `_is_claude_arm`.
    A run key carrying an off-default model matches no `claude-` prefix, so the
    registry has to answer — otherwise the transcript scan, the
    missing-transcript failure and the ledger path are all SKIPPED, fail-open,
    on the highest-scoring arm."""
    for arm in (
        "claude",
        "claude-5",
        "claude-4.8",
        "claude-opus-5",
        "claude@claude-opus-4-8",
    ):
        assert A._is_claude_arm(arm), arm
    for arm in ("factory", "bare", "openhands", "claudette", "clause"):
        assert not A._is_claude_arm(arm), arm


# --------------------------------------------------------------------------- #
# 3. data-driven arm registration
# --------------------------------------------------------------------------- #


def test_registering_an_arm_needs_no_argparse_edit(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Adding the fifth arm used to touch `_ARM_NAMES`, three argparse
    `choices=`, `_resolve_max_steps`, two cost tables and the trajectory
    expectation — six places, three of them silent on an unknown key."""
    assert A._ARM_NAMES == tuple(A._ARMS)
    for name in ("factory", "openhands", "bare", "claude", "claude-5", "claude-4.8"):
        assert name in A._ARM_NAMES

    # A brand-new arm becomes fully addressable from the registry alone.
    extended = dict(A._ARMS)
    extended["claude-9"] = A._ARMS["claude-5"]._replace(
        name="claude-9", model="claude-opus-9"
    )
    monkeypatch.setattr(A, "_ARMS", extended)
    monkeypatch.setattr(A, "_ARM_NAMES", tuple(extended))
    monkeypatch.setattr(A, "_load_env", lambda: None)
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "run_claude", lambda iid, **kw: seen.update(**kw))
    monkeypatch.setattr(
        sys,
        "argv",
        ["swebench_adapter.py", "run", "--instance", "i1", "--arm", "claude-9"],
    )
    A.main()
    assert seen["arm"] == "claude-9"
    assert A._resolve_max_steps("claude-9", None) == A._CLAUDE_TURN_CAP


def test_every_arm_but_factory_has_a_free_plumbing_probe(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A five-arm sweep is the expensive commitment; the plumbing check must not
    be. The claude arms had none — their cheapest check was a one-turn CLI call,
    which is still a subscription call — so the run-dir key change had no free
    way to be verified end to end on the two arms it mattered most for."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    for name in ("run_bare", "run_openhands", "run_claude"):
        monkeypatch.setattr(
            A, name, lambda iid, **kw: seen.update(fn=kw.get("arm", "?"), **kw)
        )
    for arm in ("bare", "openhands", "claude-5", "claude-4.8"):
        seen.clear()
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "swebench_adapter.py", "run", "--instance", "i1",
                "--arm", arm, "--probe-plumbing",
            ],
        )
        A.main()
        assert seen["probe"] is True, arm
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "swebench_adapter.py", "run", "--instance", "i1",
            "--arm", "factory", "--probe-plumbing",
        ],
    )
    with pytest.raises(SystemExit, match="pm-sync --dry-run"):
        A.main()


def test_a_claude_probe_row_can_never_reach_a_rate(A: Any) -> None:  # noqa: N803
    """Fail-closed like the other probes: a row that called no model must be a
    failed run in every consumer, whatever else its fields say."""
    status, detail = A.classify_run(
        {
            "arm": "claude-5",
            "probe_plumbing": True,
            "error": A._PROBE_ERROR,
            "termination": "plumbing-probe",
            "grade": {"oracle_resolved": True},
        }
    )
    assert status == "run_failed"
    assert "PLUMBING PROBE" in str(detail)


def test_a_leftover_unregistered_arm_dir_is_named_not_hidden(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The registry fails loud where a WRONG value would be spent or reported
    (budgets, cost guards), and degrades VISIBLY where refusing would throw away
    evidence already on disk. A row from an arm nobody registered still renders,
    labelled `(unregistered arm X)` — the failure mode to avoid is a row that
    silently reads like a registered arm's."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "junk", resolved=True)
    _row(runs, "inst_old", "factory", resolved=True)
    text = A.report()
    capsys.readouterr()
    assert "| junk | (unregistered arm junk) |" in text
    row = next(
        ln for ln in text.splitlines() if ln.startswith("| factory vs junk |")
    )
    assert "n/a (unregistered arm)" in row


def test_argparse_choices_are_derived_not_listed(A: Any) -> None:  # noqa: N803
    import inspect

    main_src = inspect.getsource(A.main)
    assert main_src.count("choices=list(_ARM_NAMES)") >= 3
    for hardcoded in ('"factory", "bare", "claude"', '["factory", "bare"]'):
        assert hardcoded not in main_src


# --------------------------------------------------------------------------- #
# 4. per-arm budgets and guards FAIL LOUD on an unknown arm
# --------------------------------------------------------------------------- #


def test_an_unknown_arm_is_a_hard_error_not_a_silent_default(A: Any) -> None:  # noqa: N803
    """`_resolve_max_steps` ended in `return _FACTORY_STEP_DEFAULT`, so an arm it
    did not enumerate silently ran 16 steps — for the Claude CLI that is 16 turns
    instead of 60, a quarter of the pre-registered budget, reported as if it
    were the budget. The cost tables did the same with `.get(arm, 3.00)`."""
    with pytest.raises(SystemExit, match="unknown arm"):
        A._resolve_max_steps("clyde", None)
    with pytest.raises(SystemExit, match="unknown arm"):
        A.arm_spec("clyde")
    with pytest.raises(SystemExit, match="default per-instance cost"):
        A._DEFAULT_COST_USD["clyde"]
    with pytest.raises(SystemExit, match="default per-instance duration"):
        A._DEFAULT_HOURS["clyde"]
    with pytest.raises(SystemExit, match="unknown arm"):
        A.estimate_instance_cost("clyde")
    # An explicit --max-steps still wins for a REGISTERED arm.
    assert A._resolve_max_steps("claude-4.8", 7) == 7
    # And the registered budgets are the pre-registered ones.
    assert A._resolve_max_steps("claude-4.8", None) == 60
    assert A._resolve_max_steps("bare", None) == 40
    assert A._resolve_max_steps("factory", None) == 16
    assert A._resolve_max_steps("openhands", None) == 600


# --------------------------------------------------------------------------- #
# 5. --from-archive must not write; --check must exit non-zero
# --------------------------------------------------------------------------- #


def test_from_archive_never_writes_results_md(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """It overwrote the very file it was verifying, and in doing so silently
    deleted a 20-line disclosure section from committed evidence."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    A.report()
    capsys.readouterr()
    archive = next((tmp_path / "results-archive").iterdir())

    sentinel = "# HAND-WRITTEN DISCLOSURE THAT MUST SURVIVE\n"
    (tmp_path / "results.md").write_text(sentinel, encoding="utf-8")
    A.report(from_archive=archive)
    capsys.readouterr()
    assert (tmp_path / "results.md").read_text(encoding="utf-8") == sentinel


def test_check_passes_on_a_byte_identical_table(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """PLAN 1.5's acceptance criterion, made executable."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    _row(runs, "inst_new", "factory", resolved=False)
    A.report()
    capsys.readouterr()
    A.report(check=True)  # newest archive by default; must not raise
    assert "CHECK OK" in capsys.readouterr().out


def test_check_exits_non_zero_on_any_difference(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    A.report()
    capsys.readouterr()
    published = tmp_path / "results.md"
    published.write_text(
        published.read_text(encoding="utf-8").replace("= 100%", "= 140%"),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="CHECK FAILED"):
        A.report(check=True)
    out = capsys.readouterr().out
    assert "140%" in out, "the diff itself must be printed, not just a verdict"


def test_publish_is_the_only_write_from_an_archive_and_is_check_clean(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """A shell redirect is not an acceptable publish path: `print` adds a
    trailing newline, so the file it produces fails its own `--check`. One
    explicit flag instead, and `--check`/`--publish` are mutually exclusive."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    A.report()
    capsys.readouterr()
    archive = next((tmp_path / "results-archive").iterdir())
    (tmp_path / "results.md").write_text("stale\n", encoding="utf-8")

    A.report(from_archive=archive, publish=True)
    capsys.readouterr()
    A.report(check=True)  # must not raise
    assert "CHECK OK" in capsys.readouterr().out

    with pytest.raises(SystemExit, match="opposites"):
        A.report(from_archive=archive, check=True, publish=True)


def test_an_archive_can_be_marked_retracted_without_editing_its_evidence(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """A run can be marked retracted by ADDING a file, never by rewriting rows,
    audits or the original meta. Rewriting an archive to change what a published
    number says about itself is the failure this whole PR is about."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    A.report()
    capsys.readouterr()
    archive = next((tmp_path / "results-archive").iterdir())
    before = {
        p.name: p.read_bytes() for p in archive.rglob("*") if p.is_file()
    }

    (archive / A._DISCLAIMER_NAME).write_text(
        "> ## RETRACTED — do not quote these numbers\n>\n> because reasons.\n",
        encoding="utf-8",
    )
    text = A.report(from_archive=archive)
    capsys.readouterr()
    assert "> ## RETRACTED — do not quote these numbers" in text
    assert "> because reasons." in text
    # Nothing that was already in the archive changed.
    for name, blob in before.items():
        assert (
            next(p for p in archive.rglob("*") if p.is_file() and p.name == name)
        ).read_bytes() == blob, name
    # And the published table is now out of date, which --check must say.
    with pytest.raises(SystemExit, match="CHECK FAILED"):
        A.report(check=True)
    capsys.readouterr()
    A.report(from_archive=archive, publish=True)
    capsys.readouterr()
    A.report(check=True)
    assert "CHECK OK" in capsys.readouterr().out


def test_the_committed_retracted_archive_carries_its_disclaimer(A: Any) -> None:  # noqa: N803
    """The 2026-08-03 three-way numbers are kept as the report code's regression
    corpus, and must never be re-published as a result.

    This used to also assert the retraction banner was in the PUBLISHED
    ``results.md``, which was true only while the retracted table WAS the
    published one. A valid five-arm sweep has since been published, so the
    durable invariants are the two below: the retracted snapshot keeps its
    disclaimer, and the published table is not derived from it.
    """
    swe = _ADAPTER.parents[1] / "bench" / "swebench"
    retracted = swe / "results-archive" / "2026-08-03T05-12-08.813897Z"
    disclaimer = (retracted / A._DISCLAIMER_NAME).read_text(encoding="utf-8")
    assert "RETRACTED" in disclaimer
    published = (swe / "results.md").read_text(encoding="utf-8")
    if "RETRACTED — do not quote these numbers" in published:
        # Still publishing the retracted table: then it must be THAT archive's,
        # banner and all — never a retracted number with the banner stripped.
        assert retracted.name in published
        return
    # Publishing a live table: it must name its own snapshot, and that snapshot
    # must not be the retracted one.
    assert retracted.name not in published, (
        "the retracted archive must not back the published table"
    )
    assert "results-archive/" in published


def test_check_with_no_published_table_is_a_failure_not_a_pass(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    A.report()
    capsys.readouterr()
    (tmp_path / "results.md").unlink()
    with pytest.raises(SystemExit, match="nothing to compare against"):
        A.report(check=True)


# --------------------------------------------------------------------------- #
# 6. the excluded-rows disclosure must survive re-derivation
# --------------------------------------------------------------------------- #


def test_foreign_and_refused_disclosures_are_persisted_and_re_emitted(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """`foreign`/`refused` were recomputed from `runs/` at report time, so from
    an archive they were always EMPTY — a re-derivation silently dropped the
    "these rows ran under another manifest" section. A disclosure that does not
    survive re-derivation is not a disclosure."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    # One row from another manifest, one row missing its audit.
    d = _row(runs, "inst_mid", "factory", resolved=True)
    payload = json.loads((d / "result.json").read_text(encoding="utf-8"))
    payload["manifest_sha256"] = "some-other-manifest"
    (d / "result.json").write_text(json.dumps(payload), encoding="utf-8")
    _row(runs, "inst_new", "factory", resolved=True, audit=None)

    live = A.report()
    capsys.readouterr()
    assert "some-other-manifest" in live
    assert "inst_new/factory` — missing artifact(s): audit.json" in live

    archive = next((tmp_path / "results-archive").iterdir())
    meta = json.loads((archive / "report-meta.json").read_text(encoding="utf-8"))
    assert meta["meta_version"] == A._REPORT_META_VERSION
    assert any("some-other-manifest" in x["why"] for x in meta["foreign"])
    assert any("audit.json" in x["why"] for x in meta["refused"])

    import shutil as _shutil

    _shutil.rmtree(runs)
    rederived = A.report(from_archive=archive)
    capsys.readouterr()
    assert rederived == live, "the disclosure did not survive re-derivation"


def test_a_pre_1_6_archive_says_its_disclosure_is_unrecoverable(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """An older archive cannot be made to yield a list it never recorded. Say
    so, loudly — an empty section reads as "nothing was excluded"."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    A.report()
    capsys.readouterr()
    archive = next((tmp_path / "results-archive").iterdir())
    meta = json.loads((archive / "report-meta.json").read_text(encoding="utf-8"))
    for key in ("refused", "foreign", "meta_version"):
        meta.pop(key, None)
    (archive / "report-meta.json").write_text(json.dumps(meta), encoding="utf-8")

    text = A.report(from_archive=archive)
    capsys.readouterr()
    assert "## Excluded-row disclosure" in text
    assert "archive predates" in text


# --------------------------------------------------------------------------- #
# 7. ONE classifier, and one budget rule for every arm
# --------------------------------------------------------------------------- #


def test_the_sweep_and_the_report_use_the_same_classifier(A: Any) -> None:  # noqa: N803
    """They disagreed on the retracted run: `sweep-claude.json` said 17 resolved
    while `results.md` said 16 of 18, because the sweep read the child's exit
    code and the report read `result.json["error"]`."""
    import inspect

    assert "classify_run(" in inspect.getsource(A.sweep_one)
    assert "classify_run(" in inspect.getsource(A._report_rows)
    # And no second definition of the question anywhere.
    src = _ADAPTER.read_text(encoding="utf-8")
    assert src.count("def classify_run(") == 1
    assert '_run_failed"] = bool(' not in src


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ({"error": None}, "ok"),
        ({"error": "dev: RuntimeError: boom"}, "run_failed"),
        ({"error": None, "termination": "wall-clock-cap"}, "budget_exhausted"),
        ({"error": None, "termination": "tick-cap"}, "budget_exhausted"),
        ({"error": None, "termination": "step-cap"}, "budget_exhausted"),
        ({"error": None, "termination": "turn-cap"}, "budget_exhausted"),
        ({"error": "wall-clock cap 5400s hit"}, "budget_exhausted"),
        # The measured pre-1.6 shape: the CLI exits 1 with empty stderr AT its
        # turn cap. This is the row the retracted run threw away.
        (
            {"error": "claude CLI exited 1: ", "num_turns": 61, "turn_cap": 60},
            "budget_exhausted",
        ),
        # A real crash that happens to land on the last step is still a crash.
        (
            {
                "error": "dev: boom",
                "termination": "error",
                "steps_used": 16,
                "step_cap": 16,
            },
            "run_failed",
        ),
        # A plumbing probe called no model and can never reach a rate.
        ({"error": None, "probe_plumbing": True}, "run_failed"),
        ({}, "no_result"),
    ],
)
def test_one_documented_rule_per_run_state(
    A: Any, result: dict[str, Any], expected: str  # noqa: N803
) -> None:
    status, _detail = A.classify_run(result)
    assert status == expected


def test_a_budget_exhausted_pass_is_counted_not_excluded(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The retracted run excluded a Claude row that hit its turn cap AND passed
    the oracle, which silently improved its own denominator. One rule, all
    arms: a cap hit is a completed, counted, FLAGGED attempt."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "claude-5", resolved=True)
    _row(
        runs,
        "inst_new",
        "claude-5",
        resolved=True,
        error="claude CLI exited 1: ",
        extra={"num_turns": 61, "turn_cap": 60},
    )
    text = A.report()
    capsys.readouterr()
    assert "resolve rate: **2/2 = 100% audited-valid**" in text
    assert "budget-exhausted, COUNTED as attempts: 1" in text
    assert "row(s) EXCLUDED" not in text


def test_the_committed_retracted_archive_now_counts_its_capped_row(A: Any) -> None:  # noqa: N803
    """Against the REAL committed evidence, not a fixture.

    `harumiweb__exstruct-113/claude` recorded `num_turns 61`, `turn_cap 60` and
    `error: "claude CLI exited 1: "`, and PASSED the oracle. The retracted
    report dropped it, publishing 16/18; under the one rule it is 17/19.
    """
    archive = (
        _ADAPTER.parents[1]
        / "bench"
        / "swebench"
        / "results-archive"
        / "2026-08-03T05-12-08.813897Z"
    )
    row = json.loads(
        (archive / "harumiweb__exstruct-113" / "claude" / "result.json").read_text(
            encoding="utf-8"
        )
    )
    assert row["grade"]["oracle_resolved"] is True
    status, detail = A.classify_run(row)
    assert status == "budget_exhausted", status
    assert "60" in str(detail)


# --------------------------------------------------------------------------- #
# 8. excluded FAILURES are named too
# --------------------------------------------------------------------------- #


def test_excluded_failures_are_named_with_their_verdict(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The loud line named only excluded PASSES, so an excluded FAILURE
    vanished with no verdict shown — and a reader could not tell whether the
    exclusions were helping or hurting the published rate."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    _row(runs, "inst_mid", "factory", resolved=True, audit=False)
    _row(runs, "inst_new", "factory", resolved=False, audit=False)
    text = A.report()
    capsys.readouterr()
    assert "2 row(s) EXCLUDED" in text
    assert "inst_mid [PASS]: audit failed" in text
    assert "inst_new [FAIL]: audit failed" in text


# --------------------------------------------------------------------------- #
# 9. fresh vs cached tokens, and the cost column's source
# --------------------------------------------------------------------------- #


def test_fresh_and_cache_read_tokens_are_separate_columns(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """Cache share was 0% (bare) / 78% (factory) / 97% (claude), and one blended
    "tokens in" column made the published "34x tokens" claim wrong by 4.5x."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(
        runs, "inst_old", "bare", resolved=False,
        extra={"tokens_in": 1000, "cached_input_tokens": 0},
    )
    _row(
        runs, "inst_old", "claude-5", resolved=True,
        extra={"tokens_in": 1000, "cached_input_tokens": 970},
    )
    text = A.report()
    capsys.readouterr()
    assert "| fresh in | cache read |" in text
    rows = [ln for ln in text.splitlines() if ln.startswith("| bare |")]
    assert any("| 1,000 | 0 |" in ln for ln in rows), rows
    rows = [ln for ln in text.splitlines() if ln.startswith("| claude-5 |")]
    assert any("| 30 | 970 |" in ln for ln in rows), rows


def test_the_cost_column_is_labelled_with_its_source_per_arm(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """A price-table estimate over Azure tokens and the Claude CLI's own report
    against a subscription are not the same quantity and must never be summed."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    _row(runs, "inst_old", "claude-5", resolved=True)
    text = A.report()
    capsys.readouterr()
    assert A._COST_PRICE_TABLE == "price-table estimate"
    assert A._COST_CLI_SUBSCRIPTION == "CLI-reported, subscription"
    factory_line = next(ln for ln in text.splitlines() if ln.startswith("| factory |"))
    claude_line = next(ln for ln in text.splitlines() if ln.startswith("| claude-5 |"))
    assert factory_line.rstrip().endswith(f"| {A._COST_PRICE_TABLE} |")
    assert claude_line.rstrip().endswith(f"| {A._COST_CLI_SUBSCRIPTION} |")
    assert "never be summed" in text


# --------------------------------------------------------------------------- #
# 10. attempt column and the discarded-runs section
# --------------------------------------------------------------------------- #


def test_a_second_attempt_is_visible_in_the_table_and_its_own_section(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The retracted run published 4 second attempts after the integrity gate
    invalidated the first, disclosed nowhere."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True, attempt=1)
    _row(runs, "inst_new", "factory", resolved=True, attempt=2)
    text = A.report()
    capsys.readouterr()
    assert "## Discarded runs (attempt > 1)" in text
    assert "`inst_new/factory` — attempt 2" in text
    assert "| attempt |" in text
    # And a clean run says so rather than leaving the section ambiguous.
    (runs / "inst_new").rename(runs / "inst_gone")
    (runs / "inst_gone" / "factory" / "result.json").write_text(
        json.dumps(
            {
                **json.loads(
                    (runs / "inst_gone" / "factory" / "result.json").read_text(
                        encoding="utf-8"
                    )
                ),
                "instance_id": "inst_gone",
                "attempt": 1,
            }
        ),
        encoding="utf-8",
    )
    text2 = A.report()
    capsys.readouterr()
    assert "None — every published row is its cell's first attempt." in text2


def test_a_free_plumbing_probe_does_not_burn_an_attempt(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Otherwise using the FREE plumbing check would make every subsequent real
    row of that cell read as `attempt 2`, which the report flags as a protocol
    violation — a footgun that would punish the operator for checking first."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    d = A._run_dir("i1", "bare")
    for _ in range(3):  # probe it as many times as you like
        A._reset_run_artifacts(d)
        A._write_result("i1", "bare", {"error": A._PROBE_ERROR, "probe_plumbing": True})
        assert json.loads((d / "result.json").read_text(encoding="utf-8"))["attempt"] == 0
    A._reset_run_artifacts(d)
    A._write_result("i1", "bare", {"error": None})
    assert json.loads((d / "result.json").read_text(encoding="utf-8"))["attempt"] == 1


def test_the_attempt_counter_survives_the_artifact_reset(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Every run function calls `_reset_run_artifacts` at its top before any exit
    path, which makes it the only hook that fires exactly once per attempt —
    including the attempts that die early."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    d = A._run_dir("i1", "factory")
    for expected in (1, 2, 3):
        A._reset_run_artifacts(d)
        A._write_result("i1", "factory", {"error": None})
        assert (
            json.loads((d / "result.json").read_text(encoding="utf-8"))["attempt"]
            == expected
        )


# --------------------------------------------------------------------------- #
# 11. no chain verdict => n/a for BOTH rates
# --------------------------------------------------------------------------- #


def test_an_arm_with_no_chain_gets_n_a_not_a_division_artifact(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The retracted table published "claude recall 0/16 = 0%", which reads as a
    finding about Claude and is actually a division on a column that does not
    exist for that arm."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    for i, iid in enumerate(("inst_old", "inst_mid", "inst_new")):
        _row(runs, iid, "claude-5", resolved=i < 2)
    _row(runs, "inst_old", "factory", resolved=True,
         extra={"factory_says_green": True, "reviewer_cycles": 0, "dev_retries": 1})
    _row(runs, "inst_mid", "factory", resolved=False,
         extra={"factory_says_green": True, "reviewer_cycles": 1, "dev_retries": 0})
    text = A.report()
    capsys.readouterr()

    claude_lines = [ln for ln in text.splitlines() if ln.startswith("| claude-5 | chain")]
    assert len(claude_lines) == 2, claude_lines
    for ln in claude_lines:
        assert ln.count("n/a (arm has no chain verdict)") == 2, ln
        assert "0%" not in ln
    # The arm that DOES have a chain still gets real numbers with a CI.
    assert "| factory | chain-verdict precision" in text
    assert "1/2 = 50%" in text


def test_a_chain_arm_that_recorded_no_verdict_is_flagged_as_a_bug(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """`n/a` is correct for an arm with no chain and a BUG for the factory arm —
    the two must not print identically."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)  # factory_says_green: None
    text = A.report()
    capsys.readouterr()
    assert "| factory | **WARNING** |" in text
    assert "HAS a chain but recorded no verdict" in text


# --------------------------------------------------------------------------- #
# 12. PASS_TO_PASS surfaced
# --------------------------------------------------------------------------- #


def test_pass_to_pass_count_and_source_are_surfaced_and_empties_flagged(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """#224 records them and nothing read them. Two instances in the pinned
    manifest declare NO PASS_TO_PASS, so their grade has no regression half and
    a patch cannot be caught breaking anything."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True, p2p=149,
         extra={"model": "azure/deepseek-v4-pro"})
    _row(runs, "inst_new", "factory", resolved=True, p2p=0,
         extra={"model": "azure/deepseek-v4-pro"})
    text = A.report()
    capsys.readouterr()
    assert "| p2p |" in text
    assert "**0 (no regression half)**" in text
    assert "| p2p empty rows |" in text
    provenance = next(
        ln
        for ln in text.splitlines()
        if ln.startswith("| factory | `") and "p2p" not in ln and "after" not in ln
    )
    assert "manifest" in provenance, provenance
    factory_row = next(
        ln for ln in text.splitlines() if ln.startswith("| inst_old | factory |")
    )
    assert "| 149 |" in factory_row


# --------------------------------------------------------------------------- #
# 13. cost samples are pooled within ONE manifest
# --------------------------------------------------------------------------- #


def test_the_cost_estimate_ignores_other_manifests(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """Pooling across manifests poisons the projection: Pro instances are far
    bigger than rebench ones, and their MINIMUM wall clock became the rebench
    sweep's projected per-instance duration — the denominator of the hourly
    burn rate."""
    runs = tmp_path / "runs"
    for i, (sha, cost, wall) in enumerate(
        [
            (_SHA, 1.10, 600.0),
            (_SHA, 1.20, 700.0),
            ("other-manifest", 40.0, 30.0),
            ("other-manifest", 41.0, 31.0),
        ]
    ):
        d = runs / f"i{i}" / "factory"
        d.mkdir(parents=True)
        (d / "result.json").write_text(
            json.dumps(
                {
                    "manifest_sha256": sha,
                    "error": None,
                    "cost_usd": cost,
                    "wall_clock_s": wall,
                }
            ),
            encoding="utf-8",
        )
    usd, hours, source = A.estimate_instance_cost(
        "factory", runs, manifest_sha=_SHA
    )
    assert usd == pytest.approx(1.20)  # NOT 41.0
    assert hours == pytest.approx(600.0 / 3600.0)  # NOT 30 s
    assert "2 clean prior factory run(s)" in source
    assert "2 other-manifest row(s) ignored" in source


def test_a_row_with_no_recorded_manifest_is_not_a_cost_sample(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    runs = tmp_path / "runs"
    d = runs / "i0" / "factory"
    d.mkdir(parents=True)
    (d / "result.json").write_text(
        json.dumps({"error": None, "cost_usd": 99.0, "wall_clock_s": 10.0}),
        encoding="utf-8",
    )
    usd, _hours, source = A.estimate_instance_cost("factory", runs, manifest_sha=_SHA)
    assert usd == A._ARMS["factory"].default_cost_usd
    assert "no clean prior runs on this manifest" in source


# --------------------------------------------------------------------------- #
# 14. the archive carries the sweep roll-ups and the gold-patch control
# --------------------------------------------------------------------------- #


def test_the_archive_carries_the_sweeps_and_the_selftest_control(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The gold-patch control rested on a summary that could not be re-derived:
    `selftest.json` sat in the working tree and the next selftest overwrote it."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "factory", resolved=True)
    _row(runs, "inst_old", "claude-4.8", resolved=True)
    (tmp_path / "sweep-factory.json").write_text('{"arm": "factory"}', encoding="utf-8")
    (tmp_path / "sweep-claude-4.8.json").write_text(
        '{"arm": "claude-4.8"}', encoding="utf-8"
    )
    (tmp_path / "sweep-bare.json").write_text('{"arm": "bare"}', encoding="utf-8")
    (tmp_path / "selftest.json").write_text('{"results": []}', encoding="utf-8")
    (tmp_path / "selftest-logs").mkdir()
    (tmp_path / "selftest-logs" / "inst_old.log").write_text("gold", encoding="utf-8")

    A.report()
    capsys.readouterr()
    archive = next((tmp_path / "results-archive").iterdir())
    assert (archive / "sweep-factory.json").is_file()
    assert (archive / "sweep-claude-4.8.json").is_file()
    # Only the arms that produced rows — an unrelated sweep file is not evidence
    # for this table.
    assert not (archive / "sweep-bare.json").exists()
    assert (archive / "selftest.json").is_file()
    assert (archive / "selftest-logs" / "inst_old.log").read_text(
        encoding="utf-8"
    ) == "gold"
    meta = json.loads((archive / "report-meta.json").read_text(encoding="utf-8"))
    assert sorted(meta["sweeps"]) == ["sweep-claude-4.8.json", "sweep-factory.json"]
    assert meta["extras"] == ["selftest.json"]
    assert meta["log_files"] == 1


# --------------------------------------------------------------------------- #
# 15. the pre-registered tables, the CIs and the McNemar test
# --------------------------------------------------------------------------- #


def test_the_report_emits_all_five_preregistered_tables(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    for iid in ("inst_old", "inst_mid", "inst_new"):
        _row(
            runs, iid, "factory", resolved=True,
            extra={"factory_says_green": True, "model": "azure/deepseek-v4-pro"},
        )
        _row(runs, iid, "claude-5", resolved=True)
        _row(runs, iid, "claude-4.8", resolved=False)
    text = A.report()
    capsys.readouterr()
    for heading in (
        "## Table 1 — headline, one row per arm",
        "## Table 2 — per-instance outcome matrix",
        "## Table 3 — the comparisons, and which ones may mean anything",
        "## Table 4 — provenance and integrity, per arm",
        "## Table 5 — chain-verdict quality",
    ):
        assert heading in text, heading
    # Harness AND models inline on every headline row.
    assert "| software-factory chain on OpenHands |" in text
    assert "| Claude Code CLI |" in text
    # The two claude arms differ in model and NOT in harness, so that pair is
    # the one comparison here that isolates something.
    row = next(
        ln for ln in text.splitlines() if ln.startswith("| claude-4.8 vs claude-5 |")
    )
    assert "| no | yes |" in row
    assert "the model (same harness)" in row
    # factory vs a claude arm varies both halves and is attributable to neither.
    row = next(ln for ln in text.splitlines() if ln.startswith("| claude-5 vs factory |"))
    assert "nothing attributable" in row


def test_margin_columns_and_bound_types_come_from_the_bound_table(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """`deepseek-v4-pro` publishes no cutoff, so its bound is its RELEASE date —
    a weaker claim than a published cutoff, and the table has to say which."""
    assert A._MODEL_BOUNDS["deepseek-v4-pro"] == (
        "2026-04-24",
        A._BOUND_RELEASE_PROXY,
    )
    assert A._MODEL_BOUNDS["claude-opus-5"] == ("2026-05-31", A._BOUND_PUBLISHED)
    assert A._MODEL_BOUNDS["claude-opus-4-8"] == ("2026-01-31", A._BOUND_PUBLISHED)
    assert A._MODEL_BOUNDS["gpt-5.4"] == ("2025-08-31", A._BOUND_PUBLISHED)
    assert A._MODEL_BOUNDS["gpt-5.3-codex"] == ("2025-08-31", A._BOUND_PUBLISHED)
    # Provider prefixes and the CLI's context-variant suffix are packaging.
    assert A._norm_model("azure/deepseek-v4-pro") == "deepseek-v4-pro"
    assert A._norm_model("claude-opus-5[1m]") == "claude-opus-5"
    assert A._model_bound("azure/deepseek-v4-pro") is not None

    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "claude-4.8", resolved=True,
         extra={"model": "claude-opus-4-8"})   # 2026-01-15, 16 days BEFORE
    _row(runs, "inst_new", "claude-4.8", resolved=True,
         extra={"model": "claude-opus-4-8"})   # 2026-05-10, 99 days AFTER
    text = A.report()
    capsys.readouterr()
    assert "margin vs `claude-opus-4-8` (2026-01-31)" in text
    old = next(ln for ln in text.splitlines() if ln.startswith("| inst_old | 2026-01-15"))
    new = next(ln for ln in text.splitlines() if ln.startswith("| inst_new | 2026-05-10"))
    assert "| -16 |" in old
    assert "| **+99** |" in new
    assert f"| `claude-opus-4-8` | 2026-01-31 | {A._BOUND_PUBLISHED} |" in text
    assert f"| `deepseek-v4-pro` | 2026-04-24 | {A._BOUND_RELEASE_PROXY} |" in text


@pytest.mark.parametrize(
    ("k", "n", "lo", "hi"),
    [
        # Checked against R's binom.test / the exact Clopper-Pearson definition.
        (11, 19, 0.3348, 0.7975),
        (17, 19, 0.6686, 0.9870),
        (0, 19, 0.0, 0.1765),
        (19, 19, 0.8235, 1.0),
        (1, 6, 0.0042, 0.6412),
    ],
)
def test_clopper_pearson_matches_the_exact_definition(
    A: Any, k: int, n: int, lo: float, hi: float  # noqa: N803
) -> None:
    got_lo, got_hi = A.clopper_pearson(k, n)
    assert got_lo == pytest.approx(lo, abs=5e-4)
    assert got_hi == pytest.approx(hi, abs=5e-4)


def test_clopper_pearson_bounds_actually_bracket_the_estimate(A: Any) -> None:  # noqa: N803
    """Written with the bisection monotonicity backwards it returned 1.0 for
    EVERY lower bound — an interval that always contains the estimate is not a
    confidence interval, and nothing in the printed table would have looked
    wrong."""
    for n in range(1, 20):
        for k in range(n + 1):
            lo, hi = A.clopper_pearson(k, n)
            assert 0.0 <= lo <= k / n <= hi <= 1.0, (k, n, lo, hi)


@pytest.mark.parametrize(
    ("b", "c", "p"),
    [
        (0, 0, 1.0),
        (0, 1, 1.0),
        (0, 5, 0.0625),
        (1, 5, 0.21875),
        (3, 3, 1.0),
        (0, 16, 2 / 2**16),
    ],
)
def test_mcnemar_exact_matches_the_sign_test(A: Any, b: int, c: int, p: float) -> None:  # noqa: N803
    assert A.mcnemar_exact_p(b, c) == pytest.approx(p)


def test_a_tiny_p_value_is_not_printed_as_zero(A: Any) -> None:  # noqa: N803
    assert A._fmt_p(2 / 2**16) == "<0.001"
    assert A._fmt_p(0.0625) == "0.062"
    assert A._fmt_p(1.0) == "1.000"


def test_the_paired_comparison_only_uses_instances_both_arms_ran(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """An unpaired instance in a paired test is a free win for whichever arm
    happens to have the row."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "claude-5", resolved=True)
    _row(runs, "inst_mid", "claude-5", resolved=True)
    _row(runs, "inst_new", "claude-5", resolved=True)  # no claude-4.8 partner
    _row(runs, "inst_old", "claude-4.8", resolved=False)
    _row(runs, "inst_mid", "claude-4.8", resolved=True)
    text = A.report()
    capsys.readouterr()
    row = next(
        ln for ln in text.splitlines() if ln.startswith("| claude-4.8 vs claude-5 |")
    )
    # 2 paired instances; only-claude-5 = 1 (inst_old); only-claude-4.8 = 0.
    assert "| 2 | 0 / 1 |" in row


# --------------------------------------------------------------------------- #
# 12. a HARNESS parse failure is not an ARM failure
# --------------------------------------------------------------------------- #


def _parse_failed_row(runs: Path, iid: str, key: str) -> Path:
    return _row(
        runs,
        iid,
        key,
        resolved=False,
        outcome="grade_parse_failed",
        extra={
            "grade": {
                "oracle_resolved": False,
                "outcome": "grade_parse_failed",
                "pass_to_pass_count": 149,
                "pass_to_pass_source": "dataset",
                "node_parse_failures": [
                    "pass_to_pass: pytest reported 153 node outcome(s) (153 passed) "
                    "and the per-node parser extracted ZERO"
                ],
            }
        },
    )


def test_a_grade_parse_failure_is_excluded_not_counted_as_unresolved(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """MEASURED on `getmoto__moto-9841/openhands`: 153 tests passed in the grade
    container and the row was recorded as an ordinary unresolved attempt because
    pytest's ANSI colour hid every `PASSED` line from the per-node parser.

    Counted as unresolved, one harness defect reports ~0% for EVERY arm. It must
    land in neither numerator nor denominator, and it must be named.
    """
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "openhands", resolved=True)
    _parse_failed_row(runs, "inst_new", "openhands")
    text = A.report()
    capsys.readouterr()

    # Denominator: 1, not 2. The parse failure is not an attempt at anything.
    assert "resolve rate: **1/1 = 100% audited-valid**" in text
    assert "1 as `grade_parse_failed`" in text
    assert "EXCLUDED as `grade_parse_failed`" in text
    assert "a HARNESS defect, not an arm failure" in text
    # The reason travels with it, so nobody has to spelunk the run dir.
    assert "extracted ZERO" in text
    # Its own matrix code, documented in the legend — never `F`, never `X`.
    assert "`P` grade-parse failed" in text
    row = next(ln for ln in text.splitlines() if ln.startswith("| inst_new |"))
    assert "| P |" in row


def test_the_parse_failure_legend_is_absent_when_no_row_has_one(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """`report --check` asserts the committed table is byte-for-byte re-derivable
    from its archive, so new vocabulary may only appear when a row uses it."""
    runs = _patch_dirs(A, tmp_path, monkeypatch)
    _row(runs, "inst_old", "openhands", resolved=True)
    _row(runs, "inst_new", "openhands", resolved=False)
    text = A.report()
    capsys.readouterr()
    assert "grade-parse failed" not in text
    assert "grade_parse_failed" not in text


def test_a_parse_failure_is_excluded_from_the_sweep_rollup_too(A: Any) -> None:  # noqa: N803
    """`sweep-<arm>.json` is what a reader quotes before the report exists."""
    records = [
        {
            "status": "ok",
            "oracle_resolved": True,
            "outcome": "resolved",
            "audit_ok": True,
        },
        {
            "status": "ok",
            "oracle_resolved": False,
            "outcome": "grade_parse_failed",
            "audit_ok": True,
        },
    ]
    s = A._sweep_summary(records, arm="openhands", workers=1, wall_s=1.0)
    assert s["gradable"] == 1
    assert s["resolved"] == 1
    assert s["grade_parse_failed"] == 1
    rendered = A._render_summary(s)
    assert "1/1 resolved clean" in rendered
    assert "GRADE-PARSE FAILED" in rendered
