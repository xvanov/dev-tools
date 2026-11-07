"""One test per HISTORICAL DEFECT of the swebench bench harness.

Every bug named here was found by running the thing, and every one of them
produced a NUMBER that looked publishable. That is what makes them worth a file of
their own: a crash announces itself, but a harness that reports \\$0.00 for a run
that spent \\$3.40, or 0% for a model that was never reached, hands you a table you
cannot tell apart from a real result. Four reports were retracted before this
file existed.

So this is not a unit-test file for a module. It is the ARTEFACT THAT STOPS THESE
RECURRING, and its rules are:

* one test per defect, named after the defect;
* each docstring states THE BUG, THE MEASURED EVIDENCE it was found by, and WHAT
  BREAKS IF THE GUARD GOES — because a regression test whose reason nobody can
  reconstruct gets deleted the first time it is inconvenient;
* where the guard already has a test elsewhere, this file asserts the GUARANTEE
  rather than duplicating the mechanism — but it must still FAIL if the guarantee
  is removed. Every test here was verified by breaking the underlying behaviour and
  watching it fail (see the commit that introduced it);
* no network, no model call, no docker, no money. Every fixture is planted.

The twelve:

  1. the ``developer`` role 422, swallowed as an empty response
  2. cost read from ``agent_end``, which is empty when a phase raises
  3. shared-db cost accumulating across attempts
  4. provider starvation counted as a capability failure
  5. diff pollution — scaffold paths in the graded diff, markdown over-excluded
  6. a "per-run" cost cap measured across runs, and the projection it zeroed
  7. a phase cap frozen at 18 while the engine's limits became configurable
  8. a resumed run's phases counted against the attempt that did not run them
  9. a plumbing abort counted in the capability denominator
 10. the base ref shadowed by the agent's own commits
 11. ``preflight`` reporting no credential problem while the model was unreachable
 12. prompt parity across all four sssf arms
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from tests._bench_host import requires_bench_host

_REPO_ROOT = Path(__file__).parent.parent
_ADAPTER = _REPO_ROOT / "bench" / "swebench_adapter.py"

_SSSF_ARMS = ("gpt54-solo", "chain", "v32-solo",
               # PRE-EXISTING GAP, fixed incidentally while adding the Sail
               # A/B below. Against the last COMMIT this tuple was only
               # `("gpt54-solo", "chain", "v32-solo", "full-sdlc")` — SEVEN
               # sssf arms already registered in `_ARMS` with base="sssf"
               # were missing from this test's coverage (flash-solo,
               # nano-solo, codexmini-solo, kimi-solo, flash-chain,
               # flash-kimichain, flash-selfchain), not the two the working
               # tree's own uncommitted, unreviewed edit had already added
               # here (flash-solo..flash-chain) while still leaving out
               # flash-kimichain/flash-selfchain. This test's own coverage
               # assertion (`{n for n, s in A._ARMS.items() if s.base ==
               # "sssf"} == set(_SSSF_ARMS)`) was failing before this change
               # touched anything Sail-related. Unrelated to the Sail A/B;
               # fixed here because it blocked the whole file from running
               # green.
               "flash-solo", "full-sdlc", "nano-solo", "codexmini-solo",
               "kimi-solo", "flash-chain", "flash-kimichain", "flash-selfchain",
               # The Sail A/B (frozen/PRE-REGISTRATION-SAIL-AB.md): four more
               # builder-only arms, one on a new Azure registry entry and three
               # on the new `sail` provider — same "one variable" guarantee.
               "flash-solo-az-r2", "flash-solo-sail-p1", "flash-solo-sail-wprobe",
               "flash-solo-sail",
               # The planner ablation (PRE-REGISTRATION-PLANNER-ABLATION.md):
               # two more builder-only-shaped arms on the same Sail deployment.
               "flash-noplan-sail", "flash-plan-sail",
               # Same ablation, moved to Azure after Sail's rate limiter
               # locked out mid-launch (PRE-REGISTRATION-PLANNER-ABLATION.md's
               # amendment).
               "flash-noplan-azure", "flash-plan-azure")


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_regressions_under_test", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_regressions_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


# --------------------------------------------------------------------------- #
# planted fixtures — pi's own stream shape, the engine's trace, a real git repo
# --------------------------------------------------------------------------- #

_V32 = "azure/DeepSeek-V3.2"
_FLASH = "azure/DeepSeek-V4-Flash"
# (input, output, cacheRead) per 1e6 tokens, as ``~/.pi/agent/models.json`` has
# them. Written out so a planted turn's ``usage.cost.total`` is what pi would
# really have computed for it.
_RATES = {_V32: (0.58, 1.68, 0.58), _FLASH: (0.21, 0.56, 0.031)}

# The provider's own words, from the incident. Kept verbatim because the whole
# point of recording ``empty_response_reasons`` is that "422 developer role" and
# "429 throttled" are different bugs with different fixes.
_DEVELOPER_422 = (
    "422 {'detail': [{'loc': ['body', 'messages', 0, 'role'], 'msg': \"Input "
    "should be 'system','user','assistant' or 'tool'\", 'input': 'developer'}]}"
)


def _turn(
    *,
    model: str = _V32,
    tokens_in: int = 0,
    tokens_out: int = 0,
    empty: bool = False,
    error: str | None = None,
) -> str:
    """One ``message_end`` line as pi streams it. ``empty=True`` is the swallow."""
    provider, _, deployment = model.partition("/")
    r_in, r_out, _r_cache = _RATES[model]
    usage: dict[str, Any] = {
        "input": 0 if empty else tokens_in,
        "output": 0 if empty else tokens_out,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0 if empty else tokens_in + tokens_out,
    }
    usage["cost"] = {
        "total": (
            0.0
            if empty
            else usage["input"] / 1e6 * r_in + usage["output"] / 1e6 * r_out
        )
    }
    message: dict[str, Any] = {
        "role": "assistant",
        "provider": provider,
        "model": deployment,
        # An EMPTY content list with all-zero usage is exactly what pi emits when
        # the provider refuses the request and the engine carries on regardless.
        "content": [] if empty else [{"type": "text", "text": "ok"}],
        "stopReason": "error" if empty else "endTurn",
        "usage": usage,
    }
    if error:
        message["errorMessage"] = error
    return json.dumps({"type": "message_end", "message": message})


def _stream(session_dir: Path, role: str, turns: list[str]) -> Path:
    """Plant one role's ``raw_output.jsonl``, with the noise pi really writes.

    The noise is load-bearing: these files are mostly ``message_update`` deltas and
    the USER half of every exchange is a ``message_end`` too, so a reader that
    counted either would double the run's measured cost.
    """
    role_dir = session_dir / role
    role_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        json.dumps({"type": "session", "role": role}),
        json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "user",
                    "content": [{"text": "task"}],
                    "usage": {"input": 999_999},
                },
            }
        ),
    ]
    for turn in turns:
        lines.append(json.dumps({"type": "message_update", "delta": "x"}))
        lines.append(turn)
    path = role_dir / "raw_output.jsonl"
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    return path


def _agent_end(role: str, *, cost: float, tokens_in: int, tokens_out: int) -> str:
    return json.dumps(
        {
            "type": "agent_end",
            "name": role,
            "payload": {
                "usage": {
                    "input_tokens": tokens_in,
                    "output_tokens": tokens_out,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "reasoning_tokens": 0,
                    "total_tokens": tokens_in + tokens_out,
                    "total_cost": cost,
                }
            },
        }
    )


@pytest.fixture
def repo_at_a_base_commit(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """A real git repository at a real base commit, plus the instance pinning it.

    Real git, because two of the defects below are about what ``git diff`` answers
    when a REF MOVED, and no fake can reproduce that.
    """
    src = tmp_path_factory.mktemp("origin") / "repo"
    src.mkdir()

    def git(*args: str) -> None:
        subprocess.run(["git", "-C", str(src), *args], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "bench@example.invalid")
    git("config", "user.name", "swebench regressions")
    (src / "pkg").mkdir()
    (src / "pkg" / "thing.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    (src / "tests").mkdir()
    (src / "tests" / "test_thing.py").write_text(
        "from pkg.thing import f\n\n\ndef test_f():\n    assert f() == 1\n",
        encoding="utf-8",
    )
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    git("checkout", "-q", "-B", "swebench-base")
    sha = subprocess.run(
        ["git", "-C", str(src), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return {
        "src": src,
        "inst": {
            "instance_id": "acme__widget-1",
            "repo": "acme/widget",
            "base_commit": sha,
            "problem_statement": "f() must return 2.",
            "problem_statement_sha256": "0" * 64,
            "profile": "swe-rebench",
            "docker_image": "example/img:latest",
            "test_targets": ["tests/test_thing.py"],
        },
    }


def _offline_row(
    A: Any,  # noqa: N803
    *,
    instance: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    arm: str = "chain",
    shared_db_running_sum: float | None = None,
) -> dict[str, Any]:
    """Drive ``run_sssf``'s REAL row assembly with planted evidence, for $0.

    ``--probe-plumbing`` means the engine is never invoked and no model is called,
    but the streams, the phase ledger and the shared database are all planted — so
    every published token and dollar still travels the production code path.

    The planted evidence reproduces the measured defect: the builder spent three
    turns of real money and its phase then RAISED, so there is an ``agent_start``
    for it and no ``agent_end`` at all.
    """
    inst, src = instance["inst"], instance["src"]
    adw_id = A._sssf_adw_id(inst["instance_id"], arm)
    work = tmp_path / "work" / f"{inst['instance_id']}__{arm}"
    work.mkdir(parents=True)
    data_dir = work / "adw_data"
    session = data_dir / "sessions" / adw_id
    _stream(session, "planner", [_turn(tokens_in=100_000, tokens_out=2_000)])
    _stream(
        session,
        "builder",
        [
            _turn(tokens_in=400_000, tokens_out=5_000),
            _turn(tokens_in=500_000, tokens_out=6_000),
            _turn(tokens_in=434_000, tokens_out=4_000),
        ],
    )
    events_path = A._sssf_events_path(data_dir, adw_id)
    events_path.parent.mkdir(parents=True, exist_ok=True)
    events_path.write_text(
        "\n".join(
            [
                json.dumps({"type": "config", "name": "session"}),
                json.dumps({"type": "phase_start", "name": "plan"}),
                json.dumps(
                    {"type": "agent_start", "name": "planner", "payload": {"model": _V32}}
                ),
                _agent_end("planner", cost=0.06136, tokens_in=100_000, tokens_out=2_000),
                json.dumps({"type": "phase_start", "name": "build"}),
                # The builder RAN and there is no ``agent_end``: the phase raised
                # after the money was spent. This is the defect, planted.
                json.dumps(
                    {"type": "agent_start", "name": "builder", "payload": {"model": _V32}}
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    db_path = tmp_path / "runs" / "sssf-bench.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if shared_db_running_sum is not None:
        conn = sqlite3.connect(db_path)
        conn.execute(
            "CREATE TABLE sessions (adw_id TEXT, status TEXT, total_cost REAL, "
            "total_tokens INTEGER)"
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?)",
            (adw_id, "fail", shared_db_running_sum, 3_000_000),
        )
        conn.commit()
        conn.close()

    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_work_root", lambda: tmp_path / "work")
    # NOT wiped: the planted streams stand in for a run that already happened.
    monkeypatch.setattr(A, "_work_dir", lambda i, a, fresh=False: work)
    monkeypatch.setattr(A, "_SSSF_SHARED_DB", db_path)
    monkeypatch.setattr(A, "_instance", lambda i: inst)
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "a" * 16})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda insts: None)
    monkeypatch.setattr(A, "_ensure_image", lambda *a, **k: True)
    monkeypatch.setattr(A, "_clone", lambda i, dest: shutil.copytree(src, dest))
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda *a, **k: None)
    monkeypatch.setattr(
        A,
        "_precheck_collect",
        lambda i, r: {
            "collect_ok": True,
            "tail": "",
            "exit_code": 0,
            "mode": "m",
            "collected_targets": [],
            "duration_s": 0.0,
        },
    )
    A.run_sssf(
        inst["instance_id"], arm=arm, max_steps=18, timeout_s=600, probe_plumbing=True
    )
    run_dir = A._run_dir(inst["instance_id"], arm)
    return json.loads((run_dir / "result.json").read_text(encoding="utf-8"))


def _reported_row(
    runs: Path,
    iid: str,
    arm: str,
    *,
    sha: str,
    resolved: bool = False,
    starved: int = 0,
    crashed: bool = False,
    writes_breach: bool = False,
) -> Path:
    """One (instance, arm) row dir with all three artifacts ``_report_rows`` needs.

    The four shapes it can take are the four verdicts the table has to keep apart:
    a clean counted failure, a provider-starved row, an engine crash, and an agent
    that wrote outside its declared scope.
    """
    d = runs / iid / arm
    d.mkdir(parents=True, exist_ok=True)
    (d / "prediction.diff").write_text(
        f"diff --git a/{iid}.py b/{iid}.py\n+# x\n", encoding="utf-8"
    )
    (d / "audit.json").write_text(
        json.dumps({"ok": True, "failures": [], "warnings": []}), encoding="utf-8"
    )
    payload: dict[str, Any] = {
        "arm": arm,
        "instance_id": iid,
        "manifest_sha256": sha,
        "error": None,
        "termination": "terminal-state",
        "tokens_in": 1000,
        "cached_input_tokens": 0,
        "tokens_out": 100,
        "cost_usd": 0.5,
        "wall_clock_s": 60.0,
        "empty_response_turns": 0,
        "provider_starved": False,
        "grade": {
            "oracle_resolved": resolved,
            "outcome": "resolved" if resolved else "empty_patch",
            "pass_to_pass_count": 42,
            "pass_to_pass_source": "manifest",
        },
    }
    if starved:
        payload |= {
            "termination": "provider-empty-response",
            "error": f"provider-empty-response: {starved} assistant turn(s) came "
            "back with EMPTY content and all-zero usage",
            "empty_response_turns": starved,
            "empty_response_by_role": {"builder": starved},
            "provider_starved": True,
        }
    if crashed:
        payload |= {
            "termination": "engine-crash",
            "error": "engine-crash: the sssf engine raised an unhandled "
            "AttributeError and died — 'str' object has no attribute 'get'",
            "sssf_failure_class": "engine_crash",
            "sssf_failure_counted": False,
        }
    if writes_breach:
        # NO error on purpose: the agent's own behaviour stays counted.
        payload |= {
            "termination": "writes-scope-breach",
            "sssf_failure_class": "writes_scope_breach",
            "sssf_failure_counted": True,
        }
    (d / "result.json").write_text(json.dumps(payload), encoding="utf-8")
    return d


# --------------------------------------------------------------------------- #
# 1. the ``developer`` role 422, swallowed as an empty response
# --------------------------------------------------------------------------- #


@requires_bench_host
def test_every_deepseek_deployment_declares_supportsdeveloperrole_false(A: Any) -> None:
    """THE BUG. ``pi`` sends the system message under the ``developer`` role unless
    the price table says otherwise. Azure's DeepSeek serving rejects that role with
    HTTP 422 — ``Input should be 'system','user','assistant' or 'tool'``, input
    ``developer`` — and pi SWALLOWS the 422: it returns an assistant message with
    empty content and all-zero usage and carries on as if the model had answered.

    MEASURED EVIDENCE. ``DeepSeek-V3.2`` 422'd on 100% of requests for a whole arm
    on 2026-08-13. The rows recorded ``cost_usd: 0.00``, ``roles_run: []``, an empty
    patch and ``credential_problem: null`` — indistinguishable from a model that
    tried and failed. The flag was then set on V3.2 only, and
    ``DeepSeek-V4-Flash`` / ``deepseek-v4-pro`` were left without it: the SECOND
    deployment to inherit the bug by omission, and V4-Flash is the deployment every
    role of ``full-sdlc`` runs on.

    IF THIS GUARD GOES: a newly added DeepSeek deployment silently answers a whole
    sweep with empty messages, and the harness publishes $0.00 and 0% as a
    capability result.

    Asserted over the LIVE table, not a fixture, because the file is the artifact
    that has to be right — and over every DeepSeek entry, not the named ones, so
    the next deployment added cannot slip through.
    """
    table = json.loads(A._PI_PRICE_TABLE.read_bytes())
    seen: list[str] = []
    for provider, config in (table.get("providers") or {}).items():
        for entry in config.get("models") or []:
            model_id = str(entry.get("id") or "")
            if "deepseek" not in model_id.lower():
                continue
            key = f"{provider}/{model_id}"
            # ``sail`` is a DIFFERENT serving stack from Azure's, and this guard is
            # about the ONE measured bug: Azure's DeepSeek deployments 422 on the
            # `developer` role. Whether Sail's does too is an open question the
            # pre-registration (frozen/PRE-REGISTRATION-SAIL-AB.md, P-2c) resolves
            # with a live ≤$0.01 probe BEFORE the freeze — not by copying Azure's
            # answer onto a different vendor's serving. Asserted here as the
            # deliberate pre-P-2c state (``compat`` absent) rather than silently
            # excluded, so a future edit that guesses `false` — or `true` — without
            # running the probe still fails a test.
            if provider == "sail":
                seen.append(key)
                compat = entry.get("compat")
                assert compat is None or (
                    isinstance(compat, dict)
                    and isinstance(compat.get("supportsDeveloperRole"), bool)
                ), (
                    f"{key}: compat must be absent (pre-P-2c) or carry a BOOLEAN "
                    f"supportsDeveloperRole measured by P-2c's live probe, never a "
                    f"guess copied from Azure: {compat!r}"
                )
                continue
            seen.append(key)
            compat = entry.get("compat")
            assert isinstance(compat, dict), (
                f"{key} declares no compat block at all, so pi will send the "
                "'developer' role and Azure's DeepSeek serving will answer 422 to "
                "every request — silently, as an empty assistant message"
            )
            assert compat.get("supportsDeveloperRole") is False, (
                f"{key} does not declare supportsDeveloperRole: false ({compat!r})"
            )
    assert len(seen) >= 3, f"expected the DeepSeek deployments, found {seen}"
    assert f"{A._SSSF_FLASH}" in seen, "full-sdlc's own deployment is not covered"
    assert f"{A._SSSF_CHEAP}" in seen


@requires_bench_host
def test_the_sail_rate_card_is_the_one_discovered_pre_freeze(A: Any) -> None:
    """Pins the P-2a rate card so a later hand-edit cannot drift it quietly.

    `deepseek/deepseek-v4-flash-0731`'s rates (0.09/0.18/0.02, `asap` tier)
    came from `docs.sailresearch.com/pricing.md`, a FREE public page, not the
    logged-in dashboard the pre-registration originally assumed was required
    — see SAIL-DISCOVERY.md for the full evidence trail. Asserted over the
    LIVE table, the same accessor `_PI_PRICE_TABLE_SHA256`'s own regression
    test uses, so the file is the artifact that has to stay right.
    """
    table = json.loads(A._PI_PRICE_TABLE.read_bytes())
    entry, = table["providers"]["sail"]["models"]
    assert entry["id"] == "deepseek/deepseek-v4-flash-0731"
    assert entry["cost"] == {
        "input": 0.09, "output": 0.18, "cacheRead": 0.02, "cacheWrite": 0.0
    }, "docs.sailresearch.com/pricing.md, asap tier — see SAIL-DISCOVERY.md"


@requires_bench_host
def test_the_row_records_the_compat_flag_it_ran_under(A: Any) -> None:
    """The flag is not a rate, and the row carries it anyway.

    IF THIS GUARD GOES: an archived row whose cost is $0.00 cannot be told apart
    from a row that ran against a serving which refused every request — the one
    piece of configuration that can zero a measured cost would be missing from the
    evidence.
    """
    block = A._sssf_price_table([A._SSSF_FLASH, A._SSSF_CHEAP, A._SSSF_STRONG])
    assert block["missing"] == []
    for model in (A._SSSF_FLASH, A._SSSF_CHEAP):
        compat = block["rates"][model]["compat"]
        assert compat == {"supportsDeveloperRole": False}, (model, compat)


def test_an_empty_zero_usage_turn_is_starvation_and_not_a_real_answer(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """THE SECOND HALF of the same defect: even with the flag right, a refusal can
    still arrive mid-run (429 under concurrency), and it arrives in this shape.

    MEASURED EVIDENCE. ``alibaba__opensandbox-816``/``v32-solo`` at ``--workers 6``
    recorded ``roles_run=[]``, $0.00 and an empty patch; the SAME instance at
    ``--workers 1`` recorded a real 1,878-byte patch and $1.522. Peak single-turn
    input was 32,847 tokens against a 128,000 window, so it was not overflow.

    IF THIS GUARD GOES: a content-free, zero-usage turn reads as the model having
    answered, so a starved row is published as the arm's own failure — and it takes
    a denominator with it.
    """
    session = tmp_path / "adw_data" / "sessions" / "d42a2793"
    _stream(
        session,
        "builder",
        [
            _turn(tokens_in=1_000, tokens_out=10),
            _turn(empty=True, error=_DEVELOPER_422),
        ],
    )
    usage = A._sssf_raw_usage_by_role(tmp_path / "adw_data", "d42a2793")
    assert usage["provider_starved"] is True
    assert usage["empty_response_turns"] == 1
    assert usage["empty_response_by_role"] == {"builder": 1}
    assert any("developer" in r for r in usage["empty_response_reasons"]), (
        "the provider's own reason is what tells a 422 developer-role rejection "
        "apart from a 429 — a bare count cannot"
    )
    # The real turn is still counted: the guard must not blank a working run.
    assert usage["calls"] == 2
    assert usage["tokens_in"] == 1_000
    assert usage["cost_usd"] > 0

    # And a turn that SAID something is never read as a swallowed failure, whatever
    # its usage numbers look like — the fail-closed direction.
    _stream(session, "planner", [_turn(tokens_in=0, tokens_out=0)])
    clean = A._sssf_raw_usage_by_role(tmp_path / "adw_data", "d42a2793")
    assert clean["empty_response_by_role"] == {"builder": 1}


@requires_bench_host
def test_the_probe_sends_the_role_pi_will_send(A: Any) -> None:
    """The reachability probe (defect 11) derives its role name from the SAME flag.

    IF THIS GUARD GOES: the probe sends ``system`` while pi sends ``developer``, so
    the probe passes against a deployment that will refuse every one of the run's
    real requests — a green preflight that certifies nothing.
    """
    _block, entry, error = A._pi_model_entry(A._SSSF_FLASH)
    assert error is None, error
    assert A._sssf_system_role(entry) == A._SSSF_ROLE_SYSTEM
    # gpt-5.4 has no such restriction, so the probe must NOT downgrade it: sending
    # ``system`` where pi sends ``developer`` is the same blindness mirrored.
    _b, openai_entry, err = A._pi_model_entry(A._SSSF_STRONG)
    assert err is None, err
    assert A._sssf_system_role(openai_entry) == A._SSSF_ROLE_DEVELOPER


# --------------------------------------------------------------------------- #
# 2. cost read from ``agent_end``, which is empty when a phase raises
# --------------------------------------------------------------------------- #


def test_the_per_turn_stream_is_primary_and_a_raised_phase_still_costs(
    A: Any,  # noqa: N803
    repo_at_a_base_commit: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE BUG. The row read its tokens and dollars from the engine's ``agent_end``
    events, which the engine emits ONLY when a phase SUCCEEDS. A builder that did
    its work through tool calls and then failed to emit valid output JSON raised
    before ``agent_end`` — so the row published $0.00 for a phase that had already
    spent the money.

    MEASURED EVIDENCE. The 2026-08-12 sweep: ``v32-solo`` understated its arm total
    by 45% ($4.18 reported against $7.55 actually spent). One builder's own stream
    showed 819k-1.34M tokens against an ``agent_end`` ledger that showed nothing.

    IF THIS GUARD GOES: every arm's published cost silently excludes its failed
    phases, i.e. exactly the phases a comparison of failure modes turns on, and the
    cheaper-model arms look cheaper than they are in proportion to how often they
    fail.

    Asserted through the driver's own row assembly: ``raw_output.jsonl`` primary,
    the ``agent_end`` ledger recorded beside it and visibly lower, and the gap
    published as its own number rather than reconciled away.
    """
    row = _offline_row(
        A, instance=repo_at_a_base_commit, tmp_path=tmp_path, monkeypatch=monkeypatch
    )
    # A row with turns and NO agent_end for the builder still reports real money.
    assert row["sssf_roles_run"] == ["builder", "planner"]
    assert row["sssf_assistant_turns"] == 4
    assert row["tokens_in"] == 1_434_000
    assert row["cost_usd"] > 0.8, row["cost_usd"]
    assert A._SSSF_RAW_OUTPUT_NAME in row["usage_source"], row["usage_source"]

    # The old source is kept as a CROSS-CHECK and is visibly the smaller figure.
    assert row["sssf_roles_run_events"] == ["planner"], "the defect, reproduced"
    assert row["cost_usd_events"] == pytest.approx(0.06136)
    assert row["cost_usd"] > row["cost_usd_events"] * 10
    assert row["cost_missing_from_events_usd"] == pytest.approx(
        row["cost_usd"] - row["cost_usd_events"], abs=5e-4
    )
    # And the evidence outlives the streams, which the next attempt deletes.
    assert row["sssf_turn_digest_file"] == A._SSSF_TURNS_NAME


# --------------------------------------------------------------------------- #
# 3. shared-db cost accumulating across attempts
# --------------------------------------------------------------------------- #


def test_the_published_cost_is_this_attempts_and_not_the_running_sum(
    A: Any,  # noqa: N803
    repo_at_a_base_commit: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE BUG. ``sessions.total_cost`` in the shared trace database is a RUNNING
    SUM keyed by a stable ``adw_id``, and ``_sssf_adw_id`` is a function of
    (instance, arm) — so a re-run of a cell inherits every dead attempt's spend.
    Reading it as "this run's cost" both overstated rows and, worse, drove the
    per-run kill switch.

    MEASURED EVIDENCE. ``pyinfra-dev__pyinfra-1665`` reported $2.0101 in the shared
    db for two attempts of $0.883 and $1.1271. ``keras-team__keras-22316``/``chain``
    was SIGTERMed on its last phase with 7 of 8 phases green: it had spent $4.0303,
    the guard added the $4.1721 of a dead attempt and fired a $6 cap.

    IF THIS GUARD GOES: a re-run cell's cost is its own spend plus every previous
    attempt's, so the more a cell is retried the more expensive the arm looks — and
    a per-run cap kills healthy runs for money they never spent.

    The published figure comes from the per-attempt stream; the running sum is
    recorded in its OWN key, with the difference published rather than reconciled.
    """
    row = _offline_row(
        A,
        instance=repo_at_a_base_commit,
        tmp_path=tmp_path,
        monkeypatch=monkeypatch,
        # This attempt's real spend is ~$0.86; the shared db carries it PLUS a dead
        # attempt's $4.17, exactly as the keras incident did.
        shared_db_running_sum=5.03,
    )
    assert row["cost_usd"] < 1.0, "the running sum leaked into the published figure"
    assert row["cost_usd_shared_db"] == pytest.approx(5.03)
    assert row["cost_usd_shared_db"] > row["cost_usd"] * 5
    assert row["cost_mismatch_usd"] == pytest.approx(5.03 - row["cost_usd"], abs=5e-4)
    # Named, so a reader knows which file each figure came from.
    assert row["shared_db"] == A._SSSF_SHARED_DB.name
    assert A._SSSF_RAW_OUTPUT_NAME in row["usage_source"]


def test_the_shared_db_is_read_scoped_by_adw_id_and_never_kills_on_a_lost_race(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The two properties that make one bench-wide database safe at all.

    IF THIS GUARD GOES: either two cells read each other's spend (the id scope), or
    contention from a sibling run terminates a healthy one (an unreadable db read
    as $0 would re-open headroom; read as a kill signal would fire the cap).
    """
    db = tmp_path / "sssf-bench.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE sessions (adw_id TEXT, status TEXT, total_cost REAL, "
        "total_tokens INTEGER)"
    )
    conn.executemany(
        "INSERT INTO sessions VALUES (?, ?, ?, ?)",
        [("aaaa1111", "fail", 9.99, 10), ("bbbb2222", "success", 0.25, 20)],
    )
    conn.commit()
    conn.close()
    assert A._sssf_sqlite_totals(db, "bbbb2222")["cost_usd"] == pytest.approx(0.25)
    assert A._sssf_sqlite_totals(db, "aaaa1111")["cost_usd"] == pytest.approx(9.99)
    # A db that cannot be read is None — NOT zero, and not a reason to kill.
    assert A._sssf_sqlite_totals(tmp_path / "gone.db", "aaaa1111") is None
    # The live guard takes the MAX of the two signals, so a lost race cannot make
    # accumulated spend appear to go down and re-open headroom.
    src = inspect.getsource(A.run_sssf)
    assert "live_cost = max(live_cost, reading)" in src


# --------------------------------------------------------------------------- #
# 4. provider starvation counted as a capability failure
# --------------------------------------------------------------------------- #


def test_a_starved_row_is_refused_from_the_numerator_and_the_denominator(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """THE BUG. A row whose turns the provider refused was counted as an attempt
    that failed. It is not an attempt at all — it is a measurement of someone
    else's queue — and counting it publishes one throttling episode as a capability
    number.

    MEASURED EVIDENCE. An 18-wide sweep on 2026-08-11 lost all 18 rows to 429s and
    would have published 0/18 = 0% for the arm.

    IF THIS GUARD GOES: the rate's denominator grows with the provider's load, so
    the same arm scores differently depending on how many workers the sweep used.

    Both rows here graded UNRESOLVED with an empty patch: the clean one is the arm's
    own failure and belongs in the denominator, the starved one must leave it
    entirely — numerator AND denominator, exactly as a ``grade_parse_failed`` row
    does one level down.
    """
    runs = tmp_path / "runs"
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    sha = "pinned-manifest-sha"
    _reported_row(runs, "inst_clean", "v32-solo", sha=sha)
    _reported_row(runs, "inst_starved", "v32-solo", sha=sha, starved=27)

    rows, refused, foreign, superseded = A._report_rows(runs, sha)
    assert (refused, foreign, superseded) == ([], [], [])
    view = A._arm_view(rows, "v32-solo")
    assert [r["instance_id"] for r in view.valid] == ["inst_clean"]
    assert [r["instance_id"] for r in view.excluded] == ["inst_starved"]
    assert view.resolved == []
    assert A._fmt_rate(len(view.resolved), len(view.valid)) == "0/1 = 0%"

    starved = next(r for r in rows if r["instance_id"] == "inst_starved")
    # NOT a counted cap hit: a cap hit is an attempt that used its budget.
    assert starved["_budget_exhausted"] is False
    assert starved["_run_failed"] is True
    assert A._row_provider_starved(starved) is True
    assert A._outcome_cell(starved) == "S", "filed as the provider's, not the arm's"
    assert "provider-empty-response" in A._exclusion_reason(starved)
    # The termination is in the ERROR vocabulary, so the step-count fallback cannot
    # re-label it as budget-exhausted and walk it back into the denominator.
    assert A._SSSF_EMPTY_RESPONSE_TERMINATION in A._ERROR_TERMINATIONS
    assert (
        A.budget_exhausted_reason(
            {
                "termination": A._SSSF_EMPTY_RESPONSE_TERMINATION,
                "steps_used": 18,
                "step_cap": 18,
            }
        )
        is None
    )


# --------------------------------------------------------------------------- #
# 5. diff pollution — scaffold paths in, markdown over-excluded
# --------------------------------------------------------------------------- #


def test_scaffold_paths_are_excluded_into_their_own_key_and_markdown_is_not(
    A: Any,  # noqa: N803
) -> None:
    """THE BUG, IN BOTH DIRECTIONS.

    Too little: the sssf ADW commits a plan under ``specs/`` and a write-up under
    ``app_docs/`` before and after the code, and its engine runtime lives in
    ``adw_data/``. Left in the graded diff, the planner-bearing arms carry bytes the
    solo arms structurally cannot produce, and the arm is credited or penalised for
    its planning STYLE.

    Too much: the obvious fix — exclude markdown — is worse. The documenter's
    declared ``writes`` is markdown ANYWHERE (``**/*.md``), and this repo's own
    grading rules count markdown as production code, so a blanket markdown
    exclusion discards the legitimate documentation edits a gold patch may
    contain: the arm is then graded as having matched a patch it only partly
    produced, biased in its own favour.

    MEASURED EVIDENCE. ``full-sdlc`` is the first arm to run the documenter at all,
    so ``app_docs/`` and ``docs/`` moved from defensive configuration to a rule that
    something actually hits; the probe row for it records
    ``sssf_paths_excluded: ['app_docs/<id>.md', 'specs/<id>_plan.md']``.

    IF THIS GUARD GOES: either scaffold bytes reach the oracle, or real
    documentation edits are silently dropped from the patch being graded. And if
    the buckets are merged, a plan file is reported as a suppressed TEST edit —
    accusing the arm of the behaviour the strip exists to police.
    """
    for prefix in A._SSSF_EXCLUDED_PREFIXES:
        assert prefix.endswith("/"), f"{prefix} is not a directory prefix"
        assert "*" not in prefix and "?" not in prefix, f"{prefix} is a glob"
    assert set(A._SSSF_EXCLUDED_PREFIXES) >= {
        "specs/",
        "app_docs/",
        "docs/",
        "adw_data/",
    }

    diff = "".join(
        f"diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n@@ -0,0 +1 @@\n+x\n"
        for p in (
            "pkg/thing.py",
            "README.md",
            "specs/plan.md",
            "app_docs/writeup.md",
            "docs/guide.md",
            "adw_data/sessions/x/events.jsonl",
            "tests/test_thing.py",
        )
    )
    excluded: list[str] = []
    code, kept, stripped = A.split_diff(
        diff, exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES, excluded=excluded
    )
    # Markdown outside the fenced directories is PRODUCTION and stays graded.
    assert kept == ["pkg/thing.py", "README.md"], kept
    assert excluded == [
        "specs/plan.md",
        "app_docs/writeup.md",
        "docs/guide.md",
        "adw_data/sessions/x/events.jsonl",
    ], excluded
    # Its OWN bucket: a doc file is not a suppressed test edit.
    assert stripped == ["tests/test_thing.py"], stripped
    assert "README.md" in code and "specs/plan.md" not in code
    A.assert_no_test_edits(code)


def test_an_exclusion_can_never_launder_a_test_edit(A: Any) -> None:
    """The ordering property that keeps the exclusion honest.

    IF THIS GUARD GOES: a test file that happens to live under an excluded prefix is
    dropped as scaffold instead of being reported as a stripped test edit, so the
    one thing the strip exists to detect becomes invisible.
    """
    path = "docs/test_sneaky.py"
    diff = f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -0,0 +1 @@\n+x\n"
    excluded: list[str] = []
    _code, kept, stripped = A.split_diff(
        diff, exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES, excluded=excluded
    )
    assert stripped == [path], "the test strip must win over the exclusion"
    assert excluded == [] and kept == []


# --------------------------------------------------------------------------- #
# 6. a "per-run" cost cap measured across runs
# --------------------------------------------------------------------------- #


def test_the_kill_threshold_and_the_projection_default_are_separate_constants(
    A: Any,
) -> None:
    """THE BUG, TWICE OVER.

    First: the "per-run" cap was measured from ``max(this run's events.jsonl,
    shared db sessions.total_cost)``, and the second term is a running sum across
    attempts — so a re-run was killed for a dead attempt's money (see defect 3).

    Second, and subtler: the kill threshold and the arms'
    ``ArmSpec.default_cost_usd`` were ONE constant, on the reasoning that an
    enforced cap is an upper bound a run cannot exceed. Disabling the cap then
    silently set every sssf arm's projection input to $0 — which makes
    ``spend_guard``'s projection $0 for any number of instances, i.e. a guard that
    can never say no.

    MEASURED EVIDENCE. ``keras-team__keras-22316``/``chain`` SIGTERMed at $4.03 of
    its own spend having inherited $4.17; ``getmoto__moto-9841``/``chain`` killed at
    $2.27 having inherited $4.63.

    IF THIS GUARD GOES: turning the cap off disarms the sweep-level projection
    refusal at the same time, and nothing is left that can refuse a sweep.
    """
    # Two constants, and the projection input stays positive with the cap disabled.
    assert A._SSSF_DEFAULT_COST_USD > 0
    assert A._SSSF_RUN_COST_CAP_USD <= 0, "the operator disabled the kill threshold"
    assert A._SSSF_DEFAULT_COST_USD != A._SSSF_RUN_COST_CAP_USD
    # The Sail A/B's four arms declare their own literal 0.50 (see their
    # registry comment: pre-declared in frozen/PRE-REGISTRATION-SAIL-AB.md as a
    # fail-safe-upward projection input for a provider with zero measured
    # rows) rather than `_SSSF_DEFAULT_COST_USD` — still independent of the
    # kill threshold, just pinned to a different, equally deliberate constant.
    _SAIL_AB_ARMS = {
        "flash-solo-az-r2", "flash-solo-sail-p1", "flash-solo-sail-wprobe",
        "flash-solo-sail",
    }
    for arm in _SSSF_ARMS:
        expected = 0.50 if arm in _SAIL_AB_ARMS else A._SSSF_DEFAULT_COST_USD
        assert A._ARMS[arm].default_cost_usd == expected, arm
        assert A._DEFAULT_COST_USD[arm] == expected, arm

    total, _peak, refusal = A.spend_guard(
        n_instances=100,
        workers=1,
        usd_per_instance=A._DEFAULT_COST_USD["full-sdlc"],
        hours_per_instance=0.25,
        hourly_cap=50.0,
        daily_cap=50.0,
    )
    assert total > 0
    assert refusal is not None, "a $0 projection would make this unrefusable"

    # And a disabled threshold must not kill every run on its first polled dollar.
    src = inspect.getsource(A.run_sssf)
    assert "_SSSF_RUN_COST_CAP_USD > 0 and" in src


# --------------------------------------------------------------------------- #
# 7. a phase cap frozen while the engine's limits became configurable
# --------------------------------------------------------------------------- #


def test_the_phase_cap_is_derived_from_the_rosters_own_limits(A: Any) -> None:
    """THE BUG. The cap was the literal 18, derived by hand from loop bounds that
    were module constants in the engine. The engine then moved those bounds into a
    configurable ``limits:`` roster block — after which a roster with
    ``fix_loops: 5`` legitimately opens more phases, and a frozen 18 flags that
    healthy run as "the graph changed under us": the harness reporting its own
    stale arithmetic as an anomaly in the engine.

    MEASURED EVIDENCE. The test that grepped the engine for ``MAX_FIX_LOOPS``
    raised ``IndexError`` the moment the bounds became configuration.

    IF THIS GUARD GOES: a run under non-default limits is killed at
    ``phase-cap``, or a run under tighter limits is measured against a budget three
    phases larger than its graph can reach.

    ``full-sdlc`` is the arm this matters for: it skips nothing, so it is the only
    arm whose graph can actually reach the derived ceiling.
    """
    defaults = A._sssf_phase_cap()
    assert defaults == 18, "the engine's default bounds still give 18"
    assert A._SSSF_PHASE_CAP == defaults
    # DERIVED: a roster with wider bounds gets a wider cap, through one formula.
    assert A._sssf_phase_cap({"fix_loops": 5, "revision_loops": 2}) == 22
    assert A._sssf_phase_cap({"fix_loops": 3, "revision_loops": 4}) == 22
    assert A._sssf_phase_cap({"fix_loops": 1, "revision_loops": 1}) == 12

    # The cap the run is measured against comes from the document the harness
    # actually handed the engine, not from the constant it was built out of.
    document = A._sssf_roster_document(
        "full-sdlc",
        A._SSSF_ROSTERS["full-sdlc"],
        data_dir=Path("/w/adw_data"),
        db_path=Path("/w/db.sqlite"),
        test_command="pytest -q",
        timeout_s=900,
        skip_where="SSSFConfig",
    )
    limits = A._sssf_limits_of(document)
    assert limits == A._SSSF_LIMITS
    cap, source = A._sssf_effective_phase_cap(A._SSSF_PHASE_CAP, limits)
    assert cap == 18 and "derived from roster limits" in source
    wider = A._sssf_limits_of({**document, "limits": {**limits, "fix_loops": 5}})
    cap, source = A._sssf_effective_phase_cap(A._SSSF_PHASE_CAP, wider)
    assert cap == 22, "a roster that widens its bounds must widen its own cap"
    assert "derived from roster limits" in source
    # An explicit operator budget still wins, and says what it overrode.
    cap, source = A._sssf_effective_phase_cap(7, limits)
    assert cap == 7 and "explicit --max-steps 7" in source and "would be 18" in source
    # Only the four-role roster can reach the ceiling at all.
    assert A._sssf_skip_list(A._SSSF_ROSTERS["full-sdlc"]) == []


# --------------------------------------------------------------------------- #
# 8. a resumed run's phases counted against the attempt that did not run them
# --------------------------------------------------------------------------- #


def test_only_this_attempts_own_phases_are_counted(A: Any, tmp_path: Path) -> None:
    """THE BUG. A resumed run APPENDS to the previous attempt's ``events.jsonl`` —
    the tracer's path is keyed by ``adw_id`` alone and a resume reuses the id — and
    it re-records the whole graph, marking the prefix it served from the prior
    attempt as ``replayed``. Counting either the dead attempt's phases or this
    attempt's replayed ones charged a healthy resume for work it never did.

    MEASURED EVIDENCE. The keras session's phases are seq 1-8 then 9-16 in ONE
    file. Counted whole, the resumed attempt reported 16 phases against a cap of
    18 and ``budget_exhausted_reason`` flagged it as having used all its steps —
    and at a wider trace it would have been KILLED at ``phase-cap`` mid-run.

    IF THIS GUARD GOES: every resumed row is either flagged as budget-exhausted or
    killed outright, and both verdicts are about the file's append-only shape rather
    than about the run.
    """
    events = tmp_path / "events.jsonl"
    events.write_text(
        "\n".join(
            [
                # attempt 1 — three real phases, then it died
                json.dumps({"type": "config", "name": "session"}),
                json.dumps({"type": "phase_start", "name": "request"}),
                json.dumps({"type": "phase_start", "name": "plan"}),
                json.dumps({"type": "phase_start", "name": "build"}),
                # attempt 2 — replays those three, then opens two of its own
                json.dumps({"type": "config", "name": "session"}),
                json.dumps(
                    {"type": "phase_start", "name": "request", "payload": {"replayed": True}}
                ),
                json.dumps(
                    {"type": "phase_start", "name": "plan", "payload": {"replayed": True}}
                ),
                json.dumps(
                    {"type": "phase_start", "name": "build", "payload": {"replayed": True}}
                ),
                json.dumps({"type": "phase_start", "name": "test_1"}),
                json.dumps({"type": "phase_start", "name": "fix_1"}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    rows = A._sssf_read_events(events)
    assert len(rows) == 10, "the whole file is still read"
    assert A._sssf_phase_count(rows) == 2, (
        "only this attempt's own, non-replayed phases are what it bought"
    )
    assert A._sssf_replayed_phase_count(rows) == 3
    assert A._sssf_attempt_count(rows) == 2
    # And the exclusions are auditable from the row rather than only from the code.
    assert A.budget_exhausted_reason({"steps_used": 2, "step_cap": 18}) is None
    assert A.budget_exhausted_reason({"steps_used": 18, "step_cap": 18}) is not None


# --------------------------------------------------------------------------- #
# 9. a plumbing abort counted in the capability denominator
# --------------------------------------------------------------------------- #


def test_an_engine_crash_is_refused_and_a_writes_scope_breach_is_counted(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """THE BUG. Two failures were byte-identical in ``result.json`` — ``error:
    null``, ``termination: "terminal-state"``, ``adw_exit_code: 1``,
    ``adw_session_status: "fail"``, ``steps_used: 2`` — and they are not the same
    kind of thing at all. Both reached the arm's denominator as ``empty_patch``,
    i.e. as "the arm was asked and produced nothing".

    MEASURED EVIDENCE.
    ``idaholab__montepy-933_interface`` — an unhandled ``AttributeError`` inside the
    engine's own stream reader. The planner never got to decide anything: a defect
    in the machinery, published as the arm's capability.
    ``keras-team__keras-22316`` — the engine's permission layer refusing the run
    because the PLANNER wrote 18 paths outside its declared ``writes`` scope. That
    is the agent's own behaviour, and it must stay counted.

    IF THIS GUARD GOES: harness defects are published as arm failures (one bug
    becomes a uniform low score across every arm), or real misbehaviour is quietly
    excluded and the arm is flattered.
    """
    runs = tmp_path / "runs"
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    sha = "pinned-manifest-sha"
    _reported_row(runs, "inst_ok", "chain", sha=sha, resolved=True)
    _reported_row(runs, "inst_crash", "chain", sha=sha, crashed=True)
    _reported_row(runs, "inst_breach", "chain", sha=sha, writes_breach=True)

    rows, refused, _foreign, _superseded = A._report_rows(runs, sha)
    assert refused == []
    view = A._arm_view(rows, "chain")
    valid = sorted(r["instance_id"] for r in view.valid)
    assert valid == ["inst_breach", "inst_ok"], (
        "the engine crash must leave the denominator and the scope breach must stay "
        f"in it — got {valid}"
    )
    assert [r["instance_id"] for r in view.excluded] == ["inst_crash"]
    assert A._fmt_rate(len(view.resolved), len(view.valid)) == "1/2 = 50%"

    crash = next(r for r in rows if r["instance_id"] == "inst_crash")
    breach = next(r for r in rows if r["instance_id"] == "inst_breach")
    assert A._row_engine_crashed(crash) is True
    assert A._row_engine_crashed(breach) is False
    assert A._row_writes_scope_breach(breach) is True
    assert A._outcome_cell(crash) == "C"
    assert A._outcome_cell(breach) == "W", "counted, with the REASON on the record"
    # ``engine-crash`` is in the error vocabulary so the step-count fallback cannot
    # re-label it as a counted cap hit; ``writes-scope-breach`` deliberately is not.
    assert A._SSSF_ENGINE_CRASH_TERMINATION in A._ERROR_TERMINATIONS
    assert A._SSSF_WRITES_SCOPE_TERMINATION not in A._ERROR_TERMINATIONS

    # And the classification is made from the artifacts, not from message text.
    breach_events = [
        {
            "type": "error",
            "name": "permission_breach",
            "payload": {"agent": "planner", "writes": ["specs/"], "error": "nope"},
        }
    ]
    verdict = A._sssf_failure_classification(breach_events, "")
    assert verdict["kind"] == "writes_scope_breach" and verdict["counted"] is True
    crash_log = (
        "Traceback (most recent call last):\n"
        '  File "/home/k/sssf/adws/adw_modules/agent_pi.py", line 88, in run\n'
        "    payload.get('x')\n"
        "AttributeError: 'str' object has no attribute 'get'\n"
    )
    verdict = A._sssf_failure_classification([], crash_log)
    assert verdict["kind"] == "engine_crash" and verdict["counted"] is False
    # An exception class nobody has classified stays COUNTED: a dropped row moves a
    # published denominator, and only a named infra class has earned that.
    odd = A._sssf_failure_classification(
        [], "Traceback (most recent call last):\nSomeNovelError: who knows\n"
    )
    assert odd["counted"] is True


# --------------------------------------------------------------------------- #
# 10. the base ref shadowed by the agent's own commits
# --------------------------------------------------------------------------- #


def test_the_diff_resolves_against_the_base_sha_even_after_the_branch_moved(
    A: Any, repo_at_a_base_commit: dict[str, Any], tmp_path: Path  # noqa: N803
) -> None:
    """THE BUG. The capture diffed against the ``swebench-base`` BRANCH NAME. A
    branch is a mutable pointer, the agents commit as they work, and the pointer
    moved — so ``git diff swebench-base`` came back EMPTY and a run that had
    produced a real patch was graded as having produced nothing.

    MEASURED EVIDENCE. ``tox-dev__tox-3931``: a full patch on disk, an empty
    ``prediction.diff``, graded ``empty_patch``.

    IF THIS GUARD GOES: any arm that commits (the sssf arms make THREE commits —
    ``commit_plan``, ``commit_build``, ``commit_docs``) can have its whole patch
    silently disappear, and the row looks like a model that did nothing.
    """
    repo = tmp_path / "repo"
    shutil.copytree(repo_at_a_base_commit["src"], repo)
    base = repo_at_a_base_commit["inst"]["base_commit"]

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
        ).stdout

    # The agent works and commits, ON the base branch — which moves it, exactly as
    # the ADW's own commit phases do.
    (repo / "pkg" / "thing.py").write_text("def f():\n    return 2\n", encoding="utf-8")
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "commit_build")
    (repo / "app_docs").mkdir(parents=True, exist_ok=True)
    (repo / "app_docs" / "writeup.md").write_text("# done\n", encoding="utf-8")
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "commit_docs")

    # THE DEFECT, REPRODUCED, and this assertion is what makes the rest of the test
    # mean anything: the branch pointer now sits ON the agent's own work, so a
    # capture that trusted the NAME sees a clean tree and reports no patch at all.
    assert git("diff", "swebench-base").strip() == "", (
        "this test is meaningless unless the branch really was shadowed"
    )

    # ...and the run then leaves one uncommitted edit, as a run that fails its suite
    # does. Added after the assertion above so the shadowing is proven on committed
    # work alone — the half that really disappeared on tox-3931.
    (repo / "pkg" / "thing.py").write_text(
        "def f():\n    return 2  # and one dirty line\n", encoding="utf-8"
    )
    assert "app_docs/writeup.md" not in git("diff", "swebench-base"), (
        "the committed doc write is invisible against the moved branch name"
    )

    integrity: dict[str, Any] = {}
    captured = A._capture_diff(repo, expected_base_commit=base, integrity=integrity)
    assert "def f():" in captured and "return 2" in captured, captured[:400]
    assert "app_docs/writeup.md" in captured, "a committed doc write is still seen"
    assert "and one dirty line" in captured, "the uncommitted edit is still seen"
    # The integrity report is what stops an empty capture being graded as "nothing
    # changed" rather than as "we could not measure".
    assert integrity, "the capture must report what it resolved against"


# --------------------------------------------------------------------------- #
# 11. ``preflight`` reporting no credential problem while the model was unreachable
# --------------------------------------------------------------------------- #


def _fake_post(status: int | None, body: Any, *, seen: list[dict[str, Any]] | None = None):
    """A stand-in for ``_sssf_post_json`` — the file's only network seam."""

    def post(url: str, payload: dict[str, Any], headers: dict[str, str], timeout_s: float):
        if seen is not None:
            seen.append({"url": url, "payload": payload, "timeout_s": timeout_s})
        return {
            "status": status,
            "body": body if isinstance(body, str) else json.dumps(body),
            "error": None if status is not None else "URLError: refused",
        }

    return post


def _ok_body(text: str = "ok") -> dict[str, Any]:
    return {
        "choices": [{"message": {"role": "assistant", "content": text}}],
        "usage": {
            "prompt_tokens": 20,
            "completion_tokens": 3,
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    }


def test_preflight_cannot_report_a_clean_credential_while_the_model_is_unreachable(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """THE BUG. ``result.json.preflight`` recorded ``credential_problem: null``
    while DeepSeek-V3.2 answered 422 to EVERY request. The check behind that field
    was ``AZURE_API_KEY in os.environ`` — so a green result was affirmative evidence
    for a false conclusion ("the credentials are fine, therefore the model was
    reached, therefore the arm simply failed"), and every row of the sweep carried
    the reassurance.

    MEASURED EVIDENCE. 100% of that arm's requests refused; rows published $0.00,
    ``roles_run: []``, an empty patch — and a clean preflight.

    IF THIS GUARD GOES: an arm burns a whole run against a model that answers
    nothing, and the harness certifies the result.

    Driven with no network: the transport is one injected function.
    """
    monkeypatch.setenv(A._SSSF_API_KEY_VAR, "not-a-real-key")
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(
        A, "_instance", lambda i: {"repo": "x/y", "base_commit": "a" * 40}
    )
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda insts: None)
    monkeypatch.setattr(
        A, "_ensure_image", lambda *a, **k: pytest.fail("spent before the probe refused")
    )
    monkeypatch.setattr(
        A,
        "_sssf_post_json",
        _fake_post(
            422,
            {
                "detail": [
                    {
                        "loc": ["body", "messages", 0, "role"],
                        "msg": "Input should be 'system','user','assistant' or 'tool'",
                        "input": "developer",
                    }
                ]
            },
        ),
    )
    with pytest.raises(SystemExit) as exc:
        A.run_sssf("i1", arm="full-sdlc", max_steps=18, timeout_s=60)
    msg = str(exc.value)
    assert "refused this run before the clone" in msg
    assert A._SSSF_FLASH in msg
    assert "422" in msg
    # The message must name the actionable fix, because this exact failure has now
    # been diagnosed twice from scratch.
    assert "supportsDeveloperRole" in msg


@requires_bench_host
def test_a_reachable_model_passes_the_probe_and_the_probe_costs_are_kept_apart(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The other direction: the probe must not refuse a working deployment, and its
    own spend must never be folded into the arm's measured cost.

    IF THIS GUARD GOES: either every run is blocked by its own preflight, or the
    harness's overhead is added to the figure the comparison is made on.
    """
    monkeypatch.setenv(A._SSSF_API_KEY_VAR, "not-a-real-key")
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(A, "_sssf_post_json", _fake_post(200, _ok_body(), seen=seen))
    prices = A._sssf_price_table([A._SSSF_FLASH])
    report = A._sssf_reachability_report(
        [A._SSSF_FLASH], env={A._SSSF_API_KEY_VAR: "k"}, price_table=prices
    )
    assert report["checked"] is True
    assert report["unreachable"] == []
    assert report["problem"] is None
    entry = report["models"][A._SSSF_FLASH]
    assert entry["reachable"] is True and entry["status"] == 200
    # The request pi will make: the role name from the price table's compat flag.
    assert entry["system_role_sent"] == A._SSSF_ROLE_SYSTEM
    assert seen[0]["payload"]["messages"][0]["role"] == A._SSSF_ROLE_SYSTEM
    assert seen[0]["payload"]["model"] == "DeepSeek-V4-Flash"
    assert seen[0]["timeout_s"] == A._SSSF_REACHABILITY_TIMEOUT_S
    # A SHORT timeout, so a hung endpoint cannot stall a whole sweep behind it.
    assert 0 < A._SSSF_REACHABILITY_TIMEOUT_S <= 60
    # RAISED 16 -> 512 on 2026-08-14, because "a handful of tokens" refused a
    # working deployment. A 16-token probe against ``Kimi-K2.7-Code`` returns HTTP
    # 200 with ``completion_tokens: 16`` and ``content: ""`` — the reply budget went
    # entirely to reasoning — so the empty-200 rule declared it unreachable and the
    # whole ``kimi-solo`` arm failed preflight on all 8 instances with zero model
    # calls. The bound that stops a hung endpoint stalling a sweep is
    # ``_SSSF_REACHABILITY_TIMEOUT_S``, asserted just above; this one only has to
    # separate "answered" from "thought, then answered".
    #
    # Still bounded, and the ceiling is a COST statement: 512 output tokens at the
    # most expensive rate in the table (gpt-5.4, $15/1M) is $0.0077 per probe.
    assert A._SSSF_REACHABILITY_MAX_TOKENS <= 1024, "a probe is still not a task"
    assert A._SSSF_REACHABILITY_MAX_TOKENS >= 256, (
        "too small and a reasoning-first deployment spends the whole budget "
        "thinking and is reported unreachable — see Kimi-K2.7-Code, 2026-08-14"
    )
    # Its cost is measured, tiny, and reported in its own field.
    assert report["probe_tokens_in"] == 20 and report["probe_tokens_out"] == 3
    assert 0 < report["probe_cost_usd"] < 0.001, report["probe_cost_usd"]
    expected = 20 / 1e6 * 0.21 + 3 / 1e6 * 0.56
    assert report["probe_cost_usd"] == pytest.approx(expected, abs=1e-9)


@requires_bench_host
def test_a_200_with_an_empty_message_is_not_a_reachable_model(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The incident's own shape, one layer earlier: pi turns a refusal into a 200-
    shaped empty message with zero usage. A probe that accepted that would have
    passed straight through the sweep this whole check exists for.

    IF THIS GUARD GOES: the probe certifies a deployment that answers nothing.
    """
    monkeypatch.setattr(
        A,
        "_sssf_post_json",
        _fake_post(
            200,
            {"choices": [{"message": {"role": "assistant", "content": ""}}], "usage": {}},
        ),
    )
    report = A._sssf_reachability_report(
        [A._SSSF_FLASH],
        env={A._SSSF_API_KEY_VAR: "k"},
        price_table=A._sssf_price_table([A._SSSF_FLASH]),
    )
    assert report["unreachable"] == [A._SSSF_FLASH]
    assert "EMPTY assistant message" in report["models"][A._SSSF_FLASH]["error"]
    assert report["problem"]


@requires_bench_host
def test_a_transport_failure_is_recorded_as_such_and_is_not_retried_blindly(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A DNS/TLS/timeout failure is not a parameter-name problem, so it must not
    burn a second timeout — and the error text has to survive into the row.

    IF THIS GUARD GOES: an unreachable endpoint costs every worker two full
    timeouts at the head of every run of a sweep.
    """
    monkeypatch.setattr(A, "_sssf_post_json", _fake_post(None, ""))
    report = A._sssf_reachability_report(
        [A._SSSF_FLASH],
        env={A._SSSF_API_KEY_VAR: "k"},
        price_table=A._sssf_price_table([A._SSSF_FLASH]),
    )
    entry = report["models"][A._SSSF_FLASH]
    assert entry["reachable"] is False
    assert entry["status"] is None
    assert "URLError" in str(entry["error"])
    assert len(entry["attempts"]) == 1, "one transport failure, one attempt"


def test_the_plumbing_probe_path_never_calls_a_model_and_says_why(
    A: Any,  # noqa: N803
    repo_at_a_base_commit: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``--probe-plumbing`` must stay $0, which means the reachability probe is
    SKIPPED rather than faked — and the row must record that it was skipped, not
    that it passed.

    IF THIS GUARD GOES: either the free path starts spending, or a skipped check is
    recorded as a green one, which is the very defect this section is about.
    """
    monkeypatch.setattr(
        A, "_sssf_post_json", lambda *a, **k: pytest.fail("the probe called a model")
    )
    row = _offline_row(
        A,
        instance=repo_at_a_base_commit,
        tmp_path=tmp_path,
        monkeypatch=monkeypatch,
        arm="full-sdlc",
    )
    reach = row["preflight"]["reachability"]
    assert reach["checked"] is False
    assert "probe-plumbing" in reach["skipped_reason"]
    assert reach["models"] == {} and reach["probe_cost_usd"] == 0.0
    assert row["preflight_probe_cost_usd"] == 0.0
    # And the row can never be read as a measurement.
    assert row["probe_plumbing"] is True
    status, _detail = A.classify_run(row)
    assert status == A._RUN_FAILED


# --------------------------------------------------------------------------- #
# 12. prompt parity across all four sssf arms
# --------------------------------------------------------------------------- #


def test_all_four_sssf_arms_render_a_byte_identical_task(A: Any) -> None:
    """THE BUG. Two arms of one comparison received DIFFERENT PROMPTS, which
    invalidates the comparison rather than merely the arm.

    MEASURED EVIDENCE. The bare arm's 0/19 was retracted for exactly this: its task
    text had drifted from the arm it was being compared against.

    IF THIS GUARD GOES: an arm can be handicapped or flattered by its prompt and
    nothing in the row would show it, because both arms would still be running "the
    same" harness.

    Proven STRUCTURALLY — the arm id cannot reach the prompt expression at all —
    and then by rendering. A string comparison alone would only prove the arms
    agree today.
    """
    tree = ast.parse(_ADAPTER.read_text(encoding="utf-8"))
    driver = next(
        n
        for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "run_sssf"
    )
    calls = [
        n
        for n in ast.walk(driver)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "format"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "_STORY_TEMPLATE"
    ]
    assert len(calls) == 1, "the task must be assembled in exactly ONE place"
    names = {n.id for n in ast.walk(calls[0]) if isinstance(n, ast.Name)}
    assert "arm" not in names and "roster" not in names, names
    # No arm comparison anywhere in the driver: per-arm behaviour is a TABLE lookup.
    assert [
        ast.unparse(n)
        for n in ast.walk(driver)
        if isinstance(n, ast.Compare)
        and isinstance(n.left, ast.Name)
        and n.left.id == "arm"
    ] == []

    rendered = set()
    for arm in _SSSF_ARMS:
        assert A._ARMS[arm].base == "sssf"
        roster = A._sssf_roster_for(arm)
        assert roster["builder"], arm
        rendered.add(
            A._STORY_TEMPLATE.format(
                instance_id="acme__widget-1",
                statement="f() must return 2.",
                test_command="pytest -q",
            )
        )
    assert len(rendered) == 1, "the four sssf arms do not render one task text"
    only = rendered.pop()
    assert A._TEST_POLICY in only and A._BASE_TESTS_NOTE in only
    # Every sssf arm, and only sssf arms, are covered here.
    assert {n for n, s in A._ARMS.items() if s.base == "sssf"} == set(_SSSF_ARMS)
