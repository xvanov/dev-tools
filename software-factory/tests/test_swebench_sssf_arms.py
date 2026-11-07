"""The three sssf arms — ``gpt54-solo``, ``chain``, ``v32-solo``.

These arms do not drive ``factory/``. They drive a SEPARATE software factory at
``/home/k/sssf``, whose ``adws/adw_simple_sdlc.py`` runs a fixed phase graph over
a roster of named agents (planner, builder, reviewer, documenter). All three arms
run that ONE file with ONE graph and differ in exactly one thing: which model each
role is routed to.

This harness has been retracted four times, twice because two variables moved at
once and once specifically because two arms received DIFFERENT PROMPTS. So every
test here pins one of those failure modes shut, for $0:

1. **prompt parity** — the three arms render a byte-identical task, proven
   structurally (the arm id cannot reach the prompt expression at all), never by
   comparing two strings;
2. **one variable** — the three rosters differ only in models; ``thinking``, the
   tool lists, the ``writes`` fences, the test command and the phase graph are
   identical, and the three ``ArmSpec`` rows differ only in identity fields;
3. **the arm label is the truth** — three independent layers stop a row claiming a
   model set it did not run: a $0 pre-flight that the engine really implements
   ``skip_phases``, a roster that omits skipped roles so a regression dies at $0,
   and a post-run tripwire against the run's own trace;
4. **the spend guard is real** — the sssf engine enforces NO cost limit, so the
   harness's per-run dollar cap and its process-group kill are the only bound that
   exists, and it must not be defeated by a shared-database read losing a race;
5. **the published arms are untouched** — their registry rows are pinned by hash;
6. **the probe is genuinely free** — ``--probe-plumbing`` never invokes the engine,
   and its row always carries a recorded ``error`` so nothing can report it as a
   measurement.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

from tests._bench_host import requires_bench_host

_REPO_ROOT = Path(__file__).parent.parent
_ADAPTER = _REPO_ROOT / "bench" / "swebench_adapter.py"

_ARMS_UNDER_TEST = ("gpt54-solo", "chain", "v32-solo", "flash-solo", "full-sdlc",
                    "nano-solo", "codexmini-solo", "kimi-solo", "flash-chain",
                    "flash-kimichain", "flash-selfchain",
                    # The Sail A/B (frozen/PRE-REGISTRATION-SAIL-AB.md), appended
                    # last so no published arm's registry position moves.
                    "flash-solo-az-r2", "flash-solo-sail-p1",
                    "flash-solo-sail-wprobe", "flash-solo-sail",
                    # The planner ablation (PRE-REGISTRATION-PLANNER-ABLATION.md),
                    # appended last for the same reason.
                    "flash-noplan-sail", "flash-plan-sail",
                    # Same ablation, moved to Azure after Sail's rate limiter
                    # locked out mid-launch.
                    "flash-noplan-azure", "flash-plan-azure")
_SOLO = ("gpt54-solo", "v32-solo", "flash-solo", "nano-solo", "codexmini-solo",
         "kimi-solo")
# The only arm that skips NOTHING: all four roles, all 13 phases. Named because
# several invariants below are stated as "every arm except this one skips a role".
_FULL = "full-sdlc"


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_sssf_under_test", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_sssf_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


@pytest.fixture(scope="module")
def tree() -> ast.Module:
    return ast.parse(_ADAPTER.read_text(encoding="utf-8"))


def _fn(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} is gone")


@pytest.fixture(scope="module")
def run_sssf_ast(tree: ast.Module) -> ast.FunctionDef:
    return _fn(tree, "run_sssf")


# --------------------------------------------------------------------------- #
# 1. prompt parity — the invalidating defect, twice retracted
# --------------------------------------------------------------------------- #


def test_all_four_arms_render_a_byte_identical_task(
    A: Any, run_sssf_ast: ast.FunctionDef  # noqa: N803
) -> None:
    """Prompt asymmetry between arms of one comparison invalidates the comparison,
    not just the arm (the bare arm's retracted 0/19).

    Proven STRUCTURALLY, following the precedent set for the two chain arms: the
    task is assembled by exactly one ``_STORY_TEMPLATE.format(...)`` call whose
    arguments come only from the instance and the clone, so there is no expression
    through which the arm id could reach the prompt. A string comparison would
    only prove the four arms agree TODAY; this proves they cannot disagree.

    ``full-sdlc`` is included for a reason beyond completeness: it is the only arm
    whose roster names all four roles, so it is the one an "adapt the prompt to the
    roster" change would look most reasonable in.
    """
    calls = [
        n
        for n in ast.walk(run_sssf_ast)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "format"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "_STORY_TEMPLATE"
    ]
    assert len(calls) == 1, "the sssf driver must assemble its task in ONE place"
    call = calls[0]
    assert sorted(k.arg or "" for k in call.keywords) == [
        "instance_id",
        "statement",
        "test_command",
    ]
    names = {n.id for n in ast.walk(call) if isinstance(n, ast.Name)}
    assert "arm" not in names, (
        "the arm id reaches the rendered task — the three sssf arms could be "
        "prompted differently, which is the defect that retracted the bare column"
    )
    assert "roster" not in names, "the roster reaches the rendered task"
    # And the rendering is genuinely arm-free: same bytes, whoever asks. Rendered
    # once PER ARM — through each arm's own roster, so a registered arm that somehow
    # could not be rendered would fail here — and reduced to a set of one.
    rendered = set()
    for arm in _ARMS_UNDER_TEST:
        roster = A._sssf_roster_for(arm)
        assert roster["builder"], f"{arm} routes no builder"
        rendered.add(
            A._STORY_TEMPLATE.format(
                instance_id="i", statement="s", test_command="CMD"
            )
        )
    assert len(rendered) == 1, "the four sssf arms do not render one task text"
    only = rendered.pop()
    assert A._TEST_POLICY in only and A._BASE_TESTS_NOTE in only


def test_the_story_assembly_is_not_inside_a_conditional(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """A prompt behind an ``if`` is one refactor away from being arm-dependent."""
    for node in ast.walk(run_sssf_ast):
        if not isinstance(node, ast.If):
            continue
        for inner in ast.walk(node):
            if (
                isinstance(inner, ast.Attribute)
                and inner.attr == "format"
                and isinstance(inner.value, ast.Name)
                and inner.value.id == "_STORY_TEMPLATE"
            ):
                raise AssertionError("the task assembly sits inside a conditional")


def test_no_arm_conditional_anywhere_in_the_sssf_driver(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """Arm-dependence is a TABLE lookup, not a branch.

    Every per-arm behaviour must arrive through ``_SSSF_ROSTERS``/``_ARMS``; an
    ``if arm == "chain"`` inside the driver is how a second, undeclared variable
    gets in. There is no permitted comparison at all here — unlike the chain
    driver, whose registry guard is an ``in`` test, this driver's guard lives
    inside ``_sssf_roster_for``.
    """
    compares = [
        n
        for n in ast.walk(run_sssf_ast)
        if isinstance(n, ast.Compare)
        and isinstance(n.left, ast.Name)
        and n.left.id == "arm"
    ]
    assert compares == [], [ast.unparse(c) for c in compares]


def test_the_arm_id_reaches_only_the_roster_and_the_run_directory(
    A: Any, run_sssf_ast: ast.FunctionDef  # noqa: N803
) -> None:
    """Where ``arm`` is allowed to appear at all, enumerated.

    A whitelist rather than a prohibition, because the arm id legitimately keys
    the run directory, the scratch directory and the roster lookup — and must
    reach nothing else that can change what the model sees.
    """
    allowed = {
        "_sssf_roster_for",  # the roster table lookup
        "_run_dir",  # the artifact directory
        "_work_dir",  # the scratch directory
        "_write_result",  # the row's own arm field
        "_sssf_roster_document",  # records the arm id INTO the roster, inertly
        "_sssf_adw_id",  # the session id, which MUST be per (instance, arm) so two
        # cells cannot collide in the shared trace database
        "_SSSF_SKIPPED_ROLE_ERROR",  # the tripwire's message
        "_sssf_green_state",  # which claim the roster can make
    }
    for node in ast.walk(run_sssf_ast):
        if not isinstance(node, ast.Call):
            continue
        uses_arm = any(
            isinstance(n, ast.Name) and n.id == "arm" for n in ast.walk(node)
        )
        if not uses_arm:
            continue
        func = node.func
        name = (
            func.id
            if isinstance(func, ast.Name)
            else func.attr if isinstance(func, ast.Attribute) else "?"
        )
        assert name in allowed or name in {"format", "dict", "str"}, (
            f"the arm id reaches {name}(), which is not on the whitelist — if that "
            "call can influence what the model sees, the three arms are no longer "
            "one variable apart"
        )


def test_no_sssf_arm_learned_about_the_factory_arms_acceptance_oracle(A: Any) -> None:
    """The chain's independent acceptance oracle belongs to the factory arm alone.

    Same rule the other four arms are already held to: if it leaked into these
    arms, the comparison would vary the oracle alongside the engine.
    """
    import inspect

    src = inspect.getsource(A.run_sssf).lower()
    assert "acceptance" not in src
    assert "_build_bench_root" not in inspect.getsource(A.run_sssf)


# --------------------------------------------------------------------------- #
# 2. one variable — the rosters, and the registry rows
# --------------------------------------------------------------------------- #


def test_the_rosters_are_exactly_the_registered_four(A: Any) -> None:
    strong, cheap, flash = A._SSSF_STRONG, A._SSSF_CHEAP, A._SSSF_FLASH
    assert strong == "azure/gpt-5.4"
    assert cheap == "azure/DeepSeek-V3.2"
    assert flash == "azure/DeepSeek-V4-Flash"
    assert A._SSSF_ROSTERS == {
        "gpt54-solo": {
            "planner": None,
            "builder": strong,
            "reviewer": None,
            "documenter": None,
        },
        "chain": {
            "planner": cheap,
            "builder": cheap,
            "reviewer": strong,
            "documenter": None,
        },
        "v32-solo": {
            "planner": None,
            "builder": cheap,
            "reviewer": None,
            "documenter": None,
        },
        # The cost floor: the SAME builder-only graph as the two arms above, on the
        # cheapest deployment. Three solo arms now differ only in the weights.
        "flash-solo": {
            "planner": None,
            "builder": flash,
            "reviewer": None,
            "documenter": None,
        },
        # THE COMPLETE GRAPH, one model for all four roles.
        "full-sdlc": {
            "planner": flash,
            "builder": flash,
            "reviewer": flash,
            "documenter": flash,
        },
        # The 2026-08-14 model sweep: the same builder-only graph, four more
        # weights, plus the one arm that adds ONLY a reviewer.
        "nano-solo": {
            "planner": None, "builder": A._SSSF_NANO,
            "reviewer": None, "documenter": None,
        },
        "codexmini-solo": {
            "planner": None, "builder": A._SSSF_CODEX_MINI,
            "reviewer": None, "documenter": None,
        },
        "kimi-solo": {
            "planner": None, "builder": A._SSSF_KIMI,
            "reviewer": None, "documenter": None,
        },
        "flash-chain": {
            "planner": None, "builder": flash,
            "reviewer": strong, "documenter": None,
        },
        # The reviewer ladder: identical to flash-chain but for the reviewer
        # model, so the three arms isolate reviewer strength as the only
        # variable. flash-selfchain routes ONE model to both roles, which is the
        # null case — the writer's own blind spots reviewing the writer.
        "flash-kimichain": {
            "planner": None, "builder": flash,
            "reviewer": A._SSSF_KIMI, "documenter": None,
        },
        "flash-selfchain": {
            "planner": None, "builder": flash,
            "reviewer": flash, "documenter": None,
        },
        # The Sail A/B: four more builder-only rosters, structurally identical
        # to flash-solo — one on a new Azure registry entry (fresh engine commit,
        # the pre-registration's control) and three on the new `sail` provider's
        # DeepSeek V4 Flash 0731 (the treatment and its two probe arms).
        "flash-solo-az-r2": {
            "planner": None, "builder": flash,
            "reviewer": None, "documenter": None,
        },
        "flash-solo-sail-p1": {
            "planner": None, "builder": A._SSSF_FLASH_SAIL,
            "reviewer": None, "documenter": None,
        },
        "flash-solo-sail-wprobe": {
            "planner": None, "builder": A._SSSF_FLASH_SAIL,
            "reviewer": None, "documenter": None,
        },
        "flash-solo-sail": {
            "planner": None, "builder": A._SSSF_FLASH_SAIL,
            "reviewer": None, "documenter": None,
        },
        # The planner ablation: the SAME model in both roles (no reviewer in
        # either arm), so splitting the graph into planner+builder is the
        # only variable — isolating exactly what E5.4's chain arm confounded.
        "flash-noplan-sail": {
            "planner": None, "builder": A._SSSF_FLASH_SAIL,
            "reviewer": None, "documenter": None,
        },
        "flash-plan-sail": {
            "planner": A._SSSF_FLASH_SAIL, "builder": A._SSSF_FLASH_SAIL,
            "reviewer": None, "documenter": None,
        },
        # Same ablation, on Azure — see the registry comment on these two.
        "flash-noplan-azure": {
            "planner": None, "builder": flash,
            "reviewer": None, "documenter": None,
        },
        "flash-plan-azure": {
            "planner": flash, "builder": flash,
            "reviewer": None, "documenter": None,
        },
    }
    assert A._SSSF_FLASH_SAIL == "sail/deepseek/deepseek-v4-flash-0731"
    # The roster-SHAPE claim ("structurally identical to flash-solo, builder
    # only") is only half tested by the dict equality above — the OTHER half
    # is that Table 3 must print "harness varies? no" for these four against
    # every other builder-only solo arm, which is what a SHARED harness_id
    # asserts. Pinned here so a future edit cannot give one of the four its
    # own id without a test noticing.
    for arm in ("flash-solo-az-r2", "flash-solo-sail-p1",
                "flash-solo-sail-wprobe", "flash-solo-sail"):
        assert A._ARMS[arm].harness_id == "sssf-solo-builder", arm


def test_exactly_one_arm_runs_the_documenter_and_it_skips_nothing(A: Any) -> None:
    """``full-sdlc`` is the arm that makes the exclusion bucket load-bearing.

    Until it existed, every roster skipped the documenter and
    ``_SSSF_EXCLUDED_PREFIXES``' ``app_docs/`` and ``docs/`` entries were
    configuration nothing had ever hit. This pins both halves of the new state: the
    other arms still skip the role (so their diffs cannot contain documentation at
    all), and this one skips NOTHING — an empty ``skip_phases`` is what makes
    ``adw_simple_sdlc.py`` run its ``changes``, ``document`` and ``commit_docs``
    phases.
    """
    for arm, roster in A._SSSF_ROSTERS.items():
        if arm == _FULL:
            continue
        assert roster["documenter"] is None, arm
        assert "documenter" in A._sssf_skip_list(roster), arm
    full = A._SSSF_ROSTERS[_FULL]
    assert all(full[role] for role in A._SSSF_ROLES), full
    assert A._sssf_skip_list(full) == [], (
        "the whole point of this arm is that it skips nothing — a non-empty "
        "skip_phases means the graph it runs is not the complete one"
    )


def test_the_documenters_own_fence_is_the_shipped_one(A: Any) -> None:
    """``full-sdlc``'s documenter keeps the engine's shipped ``writes`` list.

    Narrowing it here would change the ENGINE's permission behaviour rather than
    just the routing — a documenter fenced to two directories that then edits
    ``README.md`` is refused by ``permissions.enforce`` and the whole run is lost
    to a writes-scope breach the harness caused. The graded diff is kept honest by
    the exclusion bucket instead (see
    ``test_markdown_is_never_blanket_excluded``).
    """
    writes = A._sssf_agent_block("documenter", A._SSSF_FLASH)["writes"]
    assert writes == ["app_docs/", "docs/", "**/*.md", "*.md"]
    assert A._SSSF_ROSTERS[_FULL]["documenter"] == A._SSSF_FLASH


def test_flash_solo_is_clamped_to_one_worker_and_cannot_be_widened(A: Any) -> None:
    """Flash's deployment cannot serve the provider-safe default, so the arm
    declares its own ceiling and an explicit ``--workers`` may not raise it.

    MEASURED EVIDENCE. ``flash-solo`` at ``--workers 2`` on 2026-08-14 lost
    ``alibaba__opensandbox-816`` to a 429 on ``DeepSeek-V4-Flash`` in eastus2;
    ``pi`` swallowed the refusal into an empty assistant turn with all-zero
    usage, and the adapter marked the row ``provider_starved`` and NOT
    reportable. The same instance re-run at ``--workers 1`` finished clean in
    360.2 s. Both Flash quota pools are at 100% subscription-wide, so this is a
    property of the deployment and not a conservative guess.

    The ``--workers`` override is honoured verbatim for every OTHER arm (see
    ``_PROVIDER_SAFE_WORKERS``' docstring), which is exactly why this ceiling has
    to live somewhere the override cannot reach.
    """
    assert A._ARMS["flash-solo"].max_workers == 1
    assert A.default_workers_for_arm("flash-solo") == 1
    for requested in (2, 4, 24):
        assert A.clamp_workers_for_arm("flash-solo", requested) == 1, requested

    # The ceiling is PER-DEPLOYMENT, so only arms whose deployment cannot serve
    # the provider-safe default declare one, each for a reason recorded on the
    # registry entry: flash-solo and flash-chain share the 250-unit Flash
    # deployment (measured 429 at width 2); kimi-solo runs on the smallest
    # deployment on the resource (capacity 100). Everything else must stay None,
    # or an arm with real quota gets silently capped.
    #
    # The two reviewer-ladder arms are constrained for a STRONGER reason than
    # their siblings: flash-selfchain drives the 250-unit Flash deployment from
    # two roles within a single run, so even width 1 is already two concurrent
    # lanes against it, and flash-kimichain additionally inherits the capacity-100
    # Kimi deployment. Neither can be widened without hitting the 429 that
    # flash-solo measured.
    # `full-sdlc` is the one that was MISSING until 2026-08-15, and it is the
    # heaviest consumer of the Flash deployment in the set: all four roles route
    # to `_SSSF_FLASH`, so it drove more Flash traffic per run than any other arm
    # while being handed the provider-safe default of 4.
    CONSTRAINED = {"flash-solo": 1, "flash-chain": 1, "kimi-solo": 1,
                   "flash-kimichain": 1, "flash-selfchain": 1, "full-sdlc": 1,
                   # The Sail A/B: all width-1 except the width probe, whose
                   # ENTIRE job is measuring width 1 -> 2 -> 4 and which is
                   # never verdict or cost-ratio evidence (see its registry
                   # comment in `_ARMS`).
                   "flash-solo-az-r2": 1, "flash-solo-sail-p1": 1,
                   "flash-solo-sail-wprobe": 4, "flash-solo-sail": 1,
                   # The planner ablation: capped at the Sail A/B's own
                   # measured-clean ceiling (R5, width 2) rather than left to
                   # an operator's --workers flag, since 3+ was never probed
                   # and the registry is where that has to be unforgettable.
                   "flash-noplan-sail": 2, "flash-plan-sail": 2,
                   # Same ablation, on Azure's Flash deployment — the real,
                   # measured width-1 ceiling every other Azure Flash arm
                   # shares.
                   "flash-noplan-azure": 1, "flash-plan-azure": 1}
    for name, spec in A._ARMS.items():
        if name in CONSTRAINED:
            assert spec.max_workers == CONSTRAINED[name], name
            assert A.clamp_workers_for_arm(name, 8) == CONSTRAINED[name], name
            continue
        assert spec.max_workers is None, name
        assert A.clamp_workers_for_arm(name, 8) == 8, name


def test_the_solo_arms_differ_only_in_the_builders_model(A: Any) -> None:
    """The cleanest comparison in the set: same harness, one model swapped.

    Stated over the whole ``_SOLO`` family rather than over a hardcoded pair, so
    that registering a third weight (``flash-solo``) is caught by this invariant
    instead of unpacking-erroring out of it.
    """
    ref = A._SSSF_ROSTERS[_SOLO[0]]
    for name in _SOLO[1:]:
        other = A._SSSF_ROSTERS[name]
        moved = {role for role in A._SSSF_ROLES if ref[role] != other[role]}
        assert moved == {"builder"}, (name, moved)
    ids = {A._ARMS[n].harness_id for n in _SOLO}
    assert len(ids) == 1, (
        "Table 3 keys 'harness varies?' off harness_id; these arms hold the harness "
        f"constant and vary only the model, so it must print 'no' across them: {ids}"
    )


def test_the_chain_arm_has_its_own_harness_id(A: Any) -> None:
    """Against the solo arms the chain arm IS a different harness — it runs two
    extra roles — so sharing their id would make Table 3 claim the pair differs in
    nothing."""
    assert A._ARMS["chain"].harness_id not in {
        A._ARMS["gpt54-solo"].harness_id,
        A._ARMS["factory"].harness_id,
    }


def test_every_sssf_arm_is_distinguishable_from_software_factory(A: Any) -> None:
    """A shared ``harness_id`` would make the report treat an sssf row and a
    software-factory row as the same harness measured twice."""
    factory_ids = {
        s.harness_id for s in A._ARMS.values() if s.base in ("factory", "openhands")
    }
    for arm in _ARMS_UNDER_TEST:
        spec = A._ARMS[arm]
        assert spec.harness_id not in factory_ids
        assert spec.harness_id.startswith("sssf-")
        assert "sssf" in spec.harness.lower()


def test_the_three_arm_specs_differ_only_in_identity_fields(A: Any) -> None:
    """Same base, same budget, same wall clock, same cost basis, same trajectory
    expectation, same chain-verdict capability, same cost guard. Anything else
    would be a second variable in a three-arm comparison.

    ``max_workers`` is admitted to the allowed set, and the reason is worth
    stating because it IS a real difference between the arms: ``flash-solo`` runs
    serially and its siblings run four-wide. It is admitted because concurrency
    is an EXECUTION property, not a MEASUREMENT one — it changes wall clock and
    429 exposure, not what the model is asked or what the oracle grades — and
    because running Flash wide is precisely what corrupts its rows
    (``provider_starved``, not reportable). Serial is the width at which this arm
    produces a valid row at all, so holding it equal to its siblings would buy
    comparability in the field and lose it in the data.

    It is declared in the registry rather than left to the operator's
    ``--workers`` so that the difference is visible in the arm table and in the
    sweep's own stdout, instead of living in a README.
    """
    # ``default_cost_usd`` is admitted for the Sail A/B's four arms ONLY (see
    # their registry comment: a literal 0.50, a fail-safe-upward projection
    # input pre-declared for a provider with zero measured rows, not a rate).
    # The invariant this test protects — the ORIGINAL family's cost projection
    # is one shared constant — is re-asserted explicitly below rather than
    # merely widened away.
    _SAIL_AB_ARMS = {
        "flash-solo-az-r2", "flash-solo-sail-p1", "flash-solo-sail-wprobe",
        "flash-solo-sail",
    }
    non_sail_specs = [A._ARMS[n] for n in _ARMS_UNDER_TEST if n not in _SAIL_AB_ARMS]
    assert len({s.default_cost_usd for s in non_sail_specs}) == 1, (
        "the original family's cost projection must still be one shared constant"
    )
    for spec in [A._ARMS[n] for n in _SAIL_AB_ARMS]:
        assert spec.default_cost_usd == 0.50, spec.name

    specs = [A._ARMS[n] for n in _ARMS_UNDER_TEST]
    for other in specs[1:]:
        moved = {f for f in specs[0]._fields if getattr(specs[0], f) != getattr(other, f)}
        assert moved <= {"name", "harness", "harness_id", "max_workers",
                          "default_cost_usd"}, moved
    for spec in specs:
        assert spec.base == "sssf"
        assert spec.model is None and spec.model_selectable is False
        assert spec.max_steps == A._SSSF_PHASE_CAP
        assert spec.cost_source == A._COST_PRICE_TABLE
        assert spec.trajectories == A._TRAJECTORIES_SSSF_EVENTS
        assert spec.superseded_by is None


def test_every_sssf_arm_claims_a_chain_verdict(A: Any) -> None:
    """``has_chain`` asks whether Table 5's gate precision is DEFINED for the arm.

    It is, for all three: the ADW gates its own acceptance on a deterministic test
    phase and reports ``accepted`` either way, so each makes a real falsifiable
    claim — mirroring ``solo-noreview`` (``tests_green``) rather than ``bare``,
    which has no gate at all and records ``factory_says_green: None``.
    """
    for arm in _ARMS_UNDER_TEST:
        assert A._ARMS[arm].has_chain is True
        assert A._arm_has_chain(arm) is True
    assert A._ARMS["bare"].has_chain is False


def test_the_green_claim_is_derived_from_the_roster_not_the_arm_id(A: Any) -> None:
    """The two claims are genuinely different quantities and the row must say
    which one it made: with no reviewer only half of the ADW's ``tests_green and
    review_ok`` conjunction is ever evaluated."""
    assert A._sssf_green_state(A._SSSF_ROSTERS["chain"]) == A._SSSF_GREEN_CHAIN
    for arm in _SOLO:
        assert A._sssf_green_state(A._SSSF_ROSTERS[arm]) == A._SSSF_GREEN_TESTS
    assert A._SSSF_GREEN_CHAIN != A._SSSF_GREEN_TESTS
    # A roster with a reviewer cannot be labelled as making the weaker claim.
    assert A._sssf_green_state({"reviewer": "azure/gpt-5.4"}) == A._SSSF_GREEN_CHAIN


def test_the_registrys_cost_default_is_independent_of_the_kill_threshold(
    A: Any,
) -> None:
    """The projection input and the kill threshold are SEPARATE constants.

    They were one, on the reasoning that an enforced cap is an upper bound a run
    cannot exceed. That coupling was a trap: disabling the kill threshold then
    silently set every sssf arm's ``default_cost_usd`` to $0, which makes
    ``spend_guard``'s projection $0 for any number of instances — a guard that
    cannot say no. So the registry keeps its own conservative figure regardless
    of whether anything is being killed.
    """
    # The Sail A/B's four arms declare their OWN literal 0.50 (see their registry
    # comment): a fail-safe-upward guess for a provider with zero measured rows,
    # pre-declared in frozen/PRE-REGISTRATION-SAIL-AB.md rather than derived from
    # `_SSSF_DEFAULT_COST_USD` — that constant is the whole-graph fallback and
    # these arms are all builder-only. This does not weaken the invariant this
    # test protects: their `default_cost_usd` is still independent of the kill
    # threshold, just pinned to a different, equally deliberate figure.
    _SAIL_AB_ARMS = {
        "flash-solo-az-r2", "flash-solo-sail-p1", "flash-solo-sail-wprobe",
        "flash-solo-sail",
    }
    for arm in _ARMS_UNDER_TEST:
        expected = 0.50 if arm in _SAIL_AB_ARMS else A._SSSF_DEFAULT_COST_USD
        assert A._ARMS[arm].default_cost_usd == expected, arm
        assert A._DEFAULT_COST_USD[arm] == expected, arm
        assert A._DEFAULT_HOURS[arm] == A._ARMS[arm].default_hours
    # The projection input must stay positive even with the cap disabled, or the
    # sweep guard silently stops being able to refuse anything.
    assert A._SSSF_DEFAULT_COST_USD > 0
    total, _peak, refusal = A.spend_guard(
        n_instances=100,
        workers=1,
        usd_per_instance=A._SSSF_DEFAULT_COST_USD,
        hours_per_instance=0.25,
        hourly_cap=50.0,
        daily_cap=50.0,
    )
    assert total > 0
    assert refusal is not None, "a $0 projection would make this unrefusable"


def test_a_disabled_kill_threshold_is_expressed_as_non_positive(A: Any) -> None:
    """``<= 0`` disables the per-run kill, and the guard site must honour that.

    Enforced structurally rather than by value, so the constant can be flipped
    back on without this test dictating the operator's number.
    """
    import inspect

    src = inspect.getsource(A.run_sssf)
    assert "_SSSF_RUN_COST_CAP_USD > 0 and" in src, (
        "the cost-cap branch must short-circuit when the threshold is disabled, "
        "or a 0.0 cap kills every run on its first polled dollar"
    )


def test_every_sssf_arm_appears_in_every_derived_lookup(A: Any) -> None:
    for arm in _ARMS_UNDER_TEST:
        assert arm in A._ARM_NAMES
        assert A._resolve_max_steps(arm, None) == A._SSSF_PHASE_CAP
        assert A.arm_spec(arm).base == "sssf"
        assert A.run_key(arm) == arm
        assert A._is_sssf_arm(arm) is True
        assert A._arm_label(arm) == A._ARMS[arm].harness
        assert A._arm_cost_source(arm) == A._COST_PRICE_TABLE
        assert A._ARM_TRAJECTORY_EXPECTATION[arm] == A._TRAJECTORIES_SSSF_EVENTS
    assert A._is_sssf_arm("factory") is False
    assert A._is_sssf_arm("bare") is False


def test_a_model_override_is_refused_for_every_sssf_arm(A: Any) -> None:
    """The roster IS the model set. Pinning one model over a per-role roster would
    report weights the run did not use."""
    for arm in _ARMS_UNDER_TEST:
        with pytest.raises(SystemExit, match="--model is not accepted"):
            A.resolve_arm_model(arm, "azure/gpt-5.4")


# --------------------------------------------------------------------------- #
# 3. the published arms must be byte-identical in behaviour
# --------------------------------------------------------------------------- #

_PUBLISHED_ARMS = ("factory", "openhands", "bare", "claude", "claude-5", "claude-4.8")
_PUBLISHED_ARMS_SHA256 = (
    # MOVED 2026-08-14, by the ADDITION OF A FIELD, not by a change to any of these
# arms. ``ArmSpec`` gained ``max_workers: int | None = None``; every published
# arm takes the default ``None``, which is byte-for-byte the previous behaviour
# (bounded by ``_PROVIDER_SAFE_WORKERS``, nothing else). The digest is taken over
# the whole NamedTuple repr, so a new field with a default moves it while
# changing no arm's budget, cost guard or trajectory rule — the same
# cosmetic-digest-move that ``_sssf_role_color`` documents for
# ``sssf_roster_sha256``. Verified before re-pinning: all six read
# ``max_workers=None``.
    # was c1fa09873f46104831f9bdde953ac7d068530a5e62119056b9db0ebabb72c9c9
    "1161fd0f8ba83059e7f0053ebeef470ea91fc1e09e7277662f67e0e71e7672f7"
)


def test_the_published_arms_are_unchanged(A: Any) -> None:
    """The same hash ``tests/test_swebench_solo_noreview_arm.py`` pins. Adding
    three arms must not perturb one field of a published one — the published
    columns and the new ones would then have run under different budgets, cost
    guards or trajectory rules."""
    specs = [A._ARMS[n] for n in _PUBLISHED_ARMS]
    got = hashlib.sha256(repr(specs).encode("utf-8")).hexdigest()
    assert got == _PUBLISHED_ARMS_SHA256


def test_the_sssf_arms_are_registered_last(A: Any) -> None:
    """Registry order decides ``_ARM_NAMES`` and three argparse ``choices=``
    orderings. Appended, so no published arm's position moves."""
    assert A._ARM_NAMES[:7] == (
        "factory",
        "solo-noreview",
        "openhands",
        "bare",
        "claude",
        "claude-5",
        "claude-4.8",
    )
    assert A._ARM_NAMES[7:] == _ARMS_UNDER_TEST, A._ARM_NAMES[7:]
    # The invariant is APPEND-ONLY, not "full-sdlc is last" — that spelling was
    # written when full-sdlc happened to be the newest arm, and it turned a
    # correctly-appended 2026-08-14 sweep into a failure. What must hold is that
    # every arm which already has rows keeps the index it had, so the prefix is
    # pinned and only the tail grows.
    PRE_2026_08_14 = ("gpt54-solo", "chain", "v32-solo", "flash-solo", "full-sdlc")
    assert A._ARM_NAMES[7:7 + len(PRE_2026_08_14)] == PRE_2026_08_14, (
        "an arm with archived rows moved index; the report keys off these names"
    )
    assert A._ARM_NAMES == tuple(A._ARMS)


def test_every_sssf_base_arm_has_a_roster_and_vice_versa(A: Any) -> None:
    """A ``base="sssf"`` arm with no roster would run an undeclared model set; a
    roster with no arm is dead configuration."""
    assert {n for n, s in A._ARMS.items() if s.base == "sssf"} == set(A._SSSF_ROSTERS)


def test_an_unregistered_sssf_arm_is_refused_before_anything_is_cloned(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The roster guard is the FIRST statement after the wall clock, so no
    instance is looked up, no image pulled, no clone made and nothing spent."""
    called: list[str] = []
    monkeypatch.setattr(A, "_instance", lambda i: called.append(i) or {})
    monkeypatch.setattr(A, "_run_dir", lambda *a, **k: called.append("run_dir"))
    monkeypatch.setattr(A, "_ensure_image", lambda *a, **k: called.append("image"))
    with pytest.raises(SystemExit) as exc:
        A.run_sssf("i1", arm="not-an-arm", max_steps=1, timeout_s=1)
    assert "_SSSF_ROSTERS" in str(exc.value)
    assert called == [], "work happened before the arm was validated"


# --------------------------------------------------------------------------- #
# 4. the synthesised roster
# --------------------------------------------------------------------------- #

_DOCKER_CMD = (
    'docker run --rm -v "$PWD":/testbed -w /testbed --user "$(id -u):$(id -g)" '
    "-e HOME=/tmp --entrypoint bash img:1 -lc "
    "'python -m pytest -p no:cacheprovider tests/test_a.py'"
)


def _document(A: Any, arm: str, *, data_dir: Path, cmd: str = _DOCKER_CMD,
              timeout_s: int = 5400) -> dict[str, Any]:
    roster = A._sssf_roster_for(arm)
    return A._sssf_roster_document(
        arm,
        roster,
        data_dir=data_dir,
        db_path=A._SSSF_SHARED_DB,
        test_command=cmd,
        timeout_s=timeout_s,
        skip_where="SSSFConfig",
    )


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
@requires_bench_host
def test_the_roster_validates_under_the_engines_own_config_model(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    """Validated against the model the ENGINE will use, loaded from the engine —
    not against a schema re-declared here, which could drift and let a roster pass
    that the paid run then rejects after the clone."""
    roster = A._sssf_roster_for(arm)
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    assert A._sssf_validate_roster(doc, roster) is None
    # And it survives the YAML round trip the engine actually reads it through.
    parsed = yaml.safe_load(yaml.safe_dump(doc, sort_keys=False))
    cfg = A._sssf_engine_config_model()(**parsed)
    assert cfg.skip_phases == A._sssf_skip_list(roster)


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
@requires_bench_host
def test_every_path_in_the_roster_is_absolute(A: Any, arm: str, tmp_path: Path) -> None:
    """The engine resolves these against the process cwd, which is the CLONE. A
    relative prompt path would point inside a SWE-bench checkout that has never
    heard of this factory; a relative ``data_dir`` would put the engine's session
    runtime inside the tree being graded, and inside the diff."""
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    assert Path(doc["defaults"]["data_dir"]).is_absolute()
    assert Path(doc["observability"]["db"]).is_absolute()
    for agent in doc["agents"]:
        for which in ("system", "user"):
            path = Path(agent["prompt_engineering"][which])
            assert path.is_absolute(), (agent["name"], which)
            assert path.is_file(), f"{agent['name']} {which} prompt missing: {path}"


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_thinking_is_pinned_identically_across_every_role_and_arm(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    """The engine's shipped roster gives planner and reviewer ``high`` and the
    rest the default, which would mean the chain arm's reviewer thought harder
    than the solo arms' builder — two variables at once."""
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    levels = {a["thinking"] for a in doc["agents"]} | {doc["defaults"]["thinking"]}
    assert levels == {A._SSSF_THINKING}


_HEX = "0123456789abcdef"
# The rosters the ENGINE ships. Read, never copied: the point of the harness's
# palette is that it agrees with these files, and a second hard-coded copy here
# would agree with itself while both drifted from the UI.
_SHIPPED_ROSTERS = tuple(
    (Path("/home/k/sssf") / "adws" / "adw_sssf_config" / name)
    for name in ("sssf.config.yaml", "sssf.azure.config.yaml")
)


def _shipped_colors(path: Path) -> dict[str, str]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    return {a["name"]: a.get("color", "") for a in doc["agents"]}


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
@requires_bench_host
def test_every_role_in_every_arm_gets_a_non_empty_lane_colour(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    """``agent_sessions.color`` was the EMPTY STRING for every benchmark agent.

    The tracer writes the roster's ``color`` straight into that column and the
    observability UI paints lanes from it, so a synthesised roster that omitted the
    field rendered a whole unattended hour-long sweep as invisible blocks. Asserted
    through the engine's own config model, which is what the tracer reads — not
    just on the dict, which could carry a key the model drops.
    """
    assert set(_ARMS_UNDER_TEST) == set(A._SSSF_ROSTERS), (
        "a registered sssf arm is not parametrized here, so its roster's colours "
        "are unasserted — add it to _ARMS_UNDER_TEST"
    )
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    cfg = A._sssf_engine_config_model()(**yaml.safe_load(yaml.safe_dump(doc)))
    assert [a.name for a in cfg.agents] == [a["name"] for a in doc["agents"]]
    for agent in cfg.agents:
        color = agent.color
        assert color, f"{arm}/{agent.name} would render as an invisible lane"
        assert color[0] == "#" and len(color) == 7, (arm, agent.name, color)
        assert all(c in _HEX for c in color[1:]), (arm, agent.name, color)


@pytest.mark.parametrize("shipped", _SHIPPED_ROSTERS, ids=lambda p: p.name)
def test_the_lane_colours_are_the_shipped_rosters_own_values(
    A: Any, shipped: Path  # noqa: N803
) -> None:
    """Same role, same colour as an ordinary run — so the UI cannot tell a
    benchmark lane from a factory lane by its palette, and a timeline from either
    reads the same way."""
    if not shipped.is_file():
        pytest.skip(f"engine roster not present: {shipped}")
    theirs = _shipped_colors(shipped)
    for role, color in theirs.items():
        assert color, f"the shipped roster stopped colouring {role}"
        assert A._sssf_role_color(role) == color, role
    for role in A._SSSF_ROLES:
        assert role in theirs, f"{role} is not in the shipped roster at all"


def test_the_lane_colour_is_a_pure_function_of_the_role_name(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Deterministic per ROLE, across arms and across runs.

    A colour keyed off the model or the arm would paint the planner violet in one
    row and pink in the next, and two sweep timelines could not be compared
    side by side. An unknown role is digest-indexed into the same palette rather
    than left empty, so adding a role cannot silently reintroduce the bug — and
    ``sha256`` rather than ``hash()``, which is salted per process.
    """
    seen: dict[str, set[str]] = {}
    for arm in _ARMS_UNDER_TEST:
        for agent in _document(A, arm, data_dir=tmp_path / arm)["agents"]:
            seen.setdefault(agent["name"], set()).add(agent["color"])
    assert seen, "no agents were emitted at all"
    for role, colors in seen.items():
        assert len(colors) == 1, f"{role} is painted {sorted(colors)} across arms"
    palette = set(A._SSSF_ROLE_COLORS.values())
    for unknown in ("auditor", "scribe", "role-that-does-not-exist-yet"):
        picked = A._sssf_role_color(unknown)
        assert picked in palette and picked == A._sssf_role_color(unknown)


def test_the_lane_colour_is_inside_sssf_roster_sha256_and_adds_no_variance(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The colour is presentation, and it is nevertheless hashed into provenance.

    ``sssf_roster_sha256`` is taken over the serialised roster as a whole, so a
    cosmetic field is inside it. That is deliberate — a digest that covered only
    "semantic" fields would no longer cover the bytes the engine was handed — but
    it has one real consequence, pinned here so it is stated rather than
    discovered: rows written before and after this change carry DIFFERENT roster
    digests for the SAME model wiring.

    What must hold is that the colour adds no per-run variance: two builds of the
    same arm still serialise identically, so the digest is as stable going forward
    as it ever was.
    """
    def sha(doc: dict[str, Any]) -> str:
        text = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    for arm in _ARMS_UNDER_TEST:
        first = _document(A, arm, data_dir=tmp_path / "adw_data")
        again = _document(A, arm, data_dir=tmp_path / "adw_data")
        assert sha(first) == sha(again), (
            f"{arm}: the roster digest moves between two identical builds"
        )
        uncoloured = json.loads(json.dumps(first))
        for agent in uncoloured["agents"]:
            del agent["color"]
        assert sha(uncoloured) != sha(first), (
            "the colour is expected to be INSIDE the provenance digest; if this "
            "ever passes, the docstring above is wrong"
        )


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_the_roster_declares_only_the_roles_that_run(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    """A safety property, not tidiness: if a future engine change stopped
    honouring ``skip_phases``, an omitted agent makes the run die at $0 on "agent
    'reviewer' is not defined" instead of quietly executing extra roles and being
    published under an arm id that names fewer."""
    roster = A._sssf_roster_for(arm)
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    declared = [a["name"] for a in doc["agents"]]
    assert declared == [r for r in A._SSSF_ROLES if roster.get(r)]
    assert set(declared).isdisjoint(doc["skip_phases"])
    for agent in doc["agents"]:
        assert agent["model"] == roster[agent["name"]]


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_skip_phases_names_roster_roles_and_covers_every_missing_one(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    roster = A._sssf_roster_for(arm)
    assert doc["skip_phases"] == [r for r in A._SSSF_ROLES if roster[r] is None]
    assert set(doc["skip_phases"]) <= set(A._SSSF_ROLES), (
        "skip_phases must name ROSTER ROLES — the engine tests that vocabulary"
    )


@requires_bench_host
def test_the_roster_is_emitted_where_the_engine_declares_the_key(A: Any) -> None:
    """The engine currently declares ``skip_phases`` on ``SSSFConfig`` (top level).
    The key is written at BOTH the top level and under ``defaults`` because these
    pydantic models silently DROP unrecognised keys, so writing only the wrong one
    would be invisible — and being invisible is what makes a mislabelled arm
    possible."""
    ok, reason, where = A._sssf_skip_support()
    assert ok, reason
    assert where == "SSSFConfig"
    doc = _document(A, "chain", data_dir=Path("/w/adw_data"))
    assert doc["skip_phases"] == doc["defaults"]["skip_phases"] == ["documenter"]


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_the_quality_check_is_the_docker_pytest_command(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    doc = _document(A, arm, data_dir=tmp_path / "adw_data")
    checks = doc["quality"]["checks"]
    assert len(checks) == 1
    argv = checks[0]["argv"]
    assert argv[0] == "bash" and argv[1] == "-lc"
    assert "docker run" in argv[2] and "pytest" in argv[2]
    # The engine's `run_inkwell_tests` asks for the `tests` set BY NAME, and an
    # unknown or empty set is fatal there — a quality phase that runs nothing has
    # no failures, and no failures reports success.
    assert doc["quality"]["sets"]["tests"] == [checks[0]["name"]]


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
@requires_bench_host
def test_the_check_timeout_is_far_above_the_engines_default(
    A: Any, arm: str, tmp_path: Path  # noqa: N803
) -> None:
    """The engine's default is 120s, which a cold docker pytest run over a real
    repository blows through — and a timed-out test phase hands the builder a
    FAKE failure to repair, burning the run against the harness."""
    doc = _document(A, arm, data_dir=tmp_path / "adw_data", timeout_s=5400)
    assert doc["quality"]["checks"][0]["timeout_seconds"] == 5400
    engine_default = (
        A._sssf_engine_config_model()
        .model_fields["quality"]
        .annotation.model_fields["checks"]
    )
    assert engine_default is not None  # the field exists; the number is below
    assert doc["quality"]["checks"][0]["timeout_seconds"] > 120


def test_braces_in_every_argv_part_survive_the_engines_format_pass(A: Any) -> None:
    """``adw_modules/quality._bind`` runs ``str.format`` over every argv part to
    substitute ``{output_dir}``. An unescaped brace is either a ``KeyError`` that
    kills the run's only verification channel, or a silent substitution."""
    nasty = "python -m pytest 'tests/test_x.py::test[a{b}c]' && echo ${HOME}"
    doc = _document(A, "chain", data_dir=Path("/w"), cmd=nasty)
    for part in doc["quality"]["checks"][0]["argv"]:
        # Exactly what the engine does, with its own binding set.
        assert part.format(output_dir="/tmp/out", bun="bun") == part.replace(
            "{{", "{"
        ).replace("}}", "}")
    assert doc["quality"]["checks"][0]["argv"][2].format(output_dir="/x") == nasty
    assert A._sssf_escape_braces("a{b}c") == "a{{b}}c"


def test_the_shared_observability_db_is_the_bench_wide_constant(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """One db for every run so the engine's UI can watch a sweep live — the
    designed usage of a file the tracer opens in WAL mode. Bench-only: a
    visualizer pointed at a host project's db is watching real work, and benchmark
    sessions have no business in it."""
    assert A._SSSF_SHARED_DB == A.RUNS_DIR / "sssf-bench.db"
    assert "inkwell" not in str(A._SSSF_SHARED_DB)
    for arm in _ARMS_UNDER_TEST:
        doc = _document(A, arm, data_dir=tmp_path / arm / "adw_data")
        assert doc["observability"]["db"] == str(A._SSSF_SHARED_DB)


def test_the_data_dir_is_per_run_and_distinct_between_two_arms(
    A: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path  # noqa: N803
) -> None:
    """Cost accounting must never share a file. ``data_dir`` holds each run's own
    append-only ``events.jsonl``, which is immune to the lock contention a shared
    sqlite would see at sweep width — so the two arms of one instance must land in
    different directories."""
    monkeypatch.setattr(A, "_work_root", lambda: tmp_path / "work")
    a = A._work_dir("inst-1", "chain") / "adw_data"
    b = A._work_dir("inst-1", "v32-solo") / "adw_data"
    assert a != b
    assert not a.is_relative_to(b) and not b.is_relative_to(a)
    # ...and neither is inside the run dir the agents' cwd can reach.
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    assert not a.is_relative_to(A._run_dir("inst-1", "chain"))


def test_the_events_path_matches_where_the_engines_tracer_writes(A: Any) -> None:
    """``session.ensure`` builds it as ``{data_dir}/sessions/{adw_id}/events.jsonl``
    — relative to cwd unless ``data_dir`` is absolute, which is why the roster
    insists it is."""
    assert A._sssf_events_path(Path("/w/adw_data"), "abcd1234") == Path(
        "/w/adw_data/sessions/abcd1234/events.jsonl"
    )


def test_the_adw_id_is_stable_and_unique_per_instance_and_arm(A: Any) -> None:
    """Stable for the same reason ``_story_slug`` is (an id that changes per
    process makes a run's own trace unfindable), and per-(instance, arm) so that
    two cells can never collide in the SHARED database."""
    assert A._sssf_adw_id("i1", "chain") == A._sssf_adw_id("i1", "chain")
    ids = {
        A._sssf_adw_id(i, a)
        for i in ("i1", "i2")
        for a in _ARMS_UNDER_TEST
    }
    assert len(ids) == 2 * len(_ARMS_UNDER_TEST)
    assert len(A._sssf_adw_id("i1", "chain")) == 8


def test_the_child_env_keeps_the_credential_and_drops_the_stray_roster_pointer(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Two failure modes, opposite directions.

    ``AZURE_API_KEY`` must be INHERITED — pi authenticates from it, and copying
    ``_claude_child_env``'s deliberate provider-stripping would break every run.
    ``SSSF_CONFIG`` must be CLEARED — it is set in the engine repo's own ``.env``
    and is second in that engine's roster-resolution order, so a stray value is
    one precedence bug away from an arm running a roster we did not write.
    """
    monkeypatch.setenv(A._SSSF_API_KEY_VAR, "secret")
    monkeypatch.setenv(A._SSSF_CONFIG_ENV, "/somebody/elses/roster.yaml")
    env, problem = A._sssf_child_env()
    assert problem is None
    assert env[A._SSSF_API_KEY_VAR] == "secret"
    assert A._SSSF_CONFIG_ENV not in env
    assert "VIRTUAL_ENV" not in env


def test_a_missing_credential_is_named_before_anything_spawns(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Otherwise it surfaces as a failure deep inside pi, after the clone, the
    image pull and the collect precheck have all been paid for in wall clock."""
    monkeypatch.delenv(A._SSSF_API_KEY_VAR, raising=False)
    _env, problem = A._sssf_child_env()
    assert problem and A._SSSF_API_KEY_VAR in problem


def test_the_config_flag_is_always_passed(run_sssf_ast: ast.FunctionDef) -> None:
    """The engine's resolution order is ``--config`` · ``$SSSF_CONFIG`` · repo-root
    · bundled. ``--config`` is the only thing that guarantees the roster this
    harness wrote is the roster that runs, and a silently-wrong roster means the
    arm ran different models than its label claims."""
    src = ast.unparse(run_sssf_ast)
    assert "'--config'" in src
    assert "'--adw-id'" in src
    # The argv list is built in exactly one place, so there is no second spawn
    # path that could omit it.
    argv_assigns = [
        n
        for n in ast.walk(run_sssf_ast)
        if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "argv" for t in n.targets)
    ]
    assert len(argv_assigns) == 1
    unparsed = ast.unparse(argv_assigns[0])
    assert "'--config'" in unparsed and "roster_path" in unparsed
    assert "_SSSF_ADW" in unparsed


# --------------------------------------------------------------------------- #
# 5. the pre-flight that keeps an arm label honest
# --------------------------------------------------------------------------- #


@requires_bench_host
def test_skip_phases_support_is_verified_against_the_live_engine(A: Any) -> None:
    """Both halves are required: a config model that DECLARES the field (else the
    key is dropped at parse time, because these models do not forbid extras) and
    an ADW script that READS it (a declared-but-unread field is exactly as silent
    as a missing one)."""
    ok, reason, where = A._sssf_skip_support()
    assert ok, reason
    assert where in ("SSSFConfig", "ConfigDefaults")
    assert "skip_phases" in A._SSSF_ADW.read_text(encoding="utf-8")
    assert "skip_phases" in A._sssf_engine_config_model().model_fields


@requires_bench_host
def test_an_engine_that_only_declares_the_field_is_not_good_enough(
    A: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path  # noqa: N803
) -> None:
    """The dangerous case: the roster key parses, the graph ignores it, and every
    role runs while the arm id names one. Detected by reading the ADW's source."""
    decoy = tmp_path / "adw_simple_sdlc.py"
    decoy.write_text('"""a graph that never heard of it"""\n', encoding="utf-8")
    monkeypatch.setattr(A, "_SSSF_ADW", decoy)
    ok, reason, where = A._sssf_skip_support()
    assert ok is False
    assert "never mentions" in reason
    assert where == "SSSFConfig"


def test_an_engine_whose_model_lacks_the_field_is_refused(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    class _NoSkip:
        model_fields: dict[str, Any] = {}

    monkeypatch.setattr(A, "_sssf_engine_config_model", lambda: _NoSkip)
    ok, reason, where = A._sssf_skip_support()
    assert ok is False and where is None
    assert "silently DROPPED" in reason


def test_an_unloadable_engine_model_is_refused_rather_than_assumed(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    def _boom() -> Any:
        raise ImportError("no such engine")

    monkeypatch.setattr(A, "_sssf_engine_config_model", _boom)
    ok, reason, _where = A._sssf_skip_support()
    assert ok is False
    assert "cannot load" in reason


def test_a_real_run_refuses_when_skip_phases_is_unsupported(
    A: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path  # noqa: N803
) -> None:
    """$0, before the image pull — and it must be a REFUSAL, because the
    alternative is spending money on a row whose arm label is a lie."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_instance", lambda i: {"repo": "x/y", "base_commit": "a" * 40})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda insts: None)
    monkeypatch.setattr(A, "_sssf_skip_support", lambda: (False, "no such key", None))
    monkeypatch.setattr(A, "_ensure_image", lambda *a, **k: pytest.fail("spent"))
    with pytest.raises(SystemExit) as exc:
        A.run_sssf("i1", arm="chain", max_steps=18, timeout_s=60)
    msg = str(exc.value)
    assert "pre-flight refused this run before the clone" in msg
    assert "skip_phases" in msg
    # The refusal discloses what the pre-flight itself spent. It is not $0 any more
    # — the reachability probe issues one real request per deployment — so the
    # message states the figure instead of claiming a zero it cannot promise.
    assert "on reachability probes" in msg


def test_the_skipped_role_tripwire_message_is_fail_closed(A: Any) -> None:
    """Recorded as the run's ``error``, which ``classify_run`` turns into
    ``run_failed`` — so a row whose model set does not match its arm label can
    never reach a headline even if the pre-flight check was fooled."""
    error = A._SSSF_SKIPPED_ROLE_ERROR.format(
        skipped=["reviewer"], ran=["reviewer"], arm="gpt54-solo"
    )
    status, detail = A.classify_run({"error": error, "termination": "terminal-state"})
    assert status == A._RUN_FAILED
    assert "arm integrity" in (detail or "")


# --------------------------------------------------------------------------- #
# 6. the spend guard — the only bound that exists
# --------------------------------------------------------------------------- #


def test_the_cap_terminations_are_in_the_shared_budget_vocabulary(A: Any) -> None:
    """One rule for all arms: a cap hit is a COMPLETED, COUNTED, FLAGGED attempt,
    never an excluded run. The retracted run excluded a capped row that had PASSED
    the oracle, silently improving its own denominator."""
    for term in ("cost-cap", "phase-cap", "wall-clock-cap"):
        assert term in A._BUDGET_TERMINATIONS
        status, detail = A.classify_run(
            {"termination": term, "wall_clock_s": 12.0, "steps_used": 3, "step_cap": 18}
        )
        assert status == A._RUN_BUDGET_EXHAUSTED, term
        assert term in (detail or "")


def test_the_live_cost_takes_the_max_of_the_two_signals(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """They measure the same money at different resolutions: the per-run log is
    complete but phase-granular, the shared db additionally sees spend inside a
    phase that has not ended. The guard's job is to be the first to notice."""
    events = tmp_path / "events.jsonl"
    events.write_text(
        json.dumps(
            {
                "type": "agent_end",
                "name": "builder",
                "tokens": 100,
                "payload": {"cost": 1.5, "usage": {"total_cost": 1.5, "input_tokens": 10}},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    missing_db = tmp_path / "nope.db"
    cost, source = A._sssf_live_cost(events, missing_db, "abc")
    assert cost == pytest.approx(1.5)
    assert "events.jsonl" in source


def test_an_unreadable_shared_db_never_kills_a_run(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The db is SHARED, so a read can lose a race against a sibling run's
    writer. Letting that terminate a healthy run would make sweep width itself a
    source of failed rows."""
    assert A._sssf_sqlite_totals(tmp_path / "absent.db", "abc") is None
    garbage = tmp_path / "garbage.db"
    garbage.write_bytes(b"not a database at all")
    assert A._sssf_sqlite_totals(garbage, "abc") is None
    # ...and the guard still returns a usable number from the per-run log.
    events = tmp_path / "events.jsonl"
    events.write_text("", encoding="utf-8")
    cost, source = A._sssf_live_cost(events, garbage, "abc")
    assert cost == 0.0
    assert "unreadable" in source


def test_the_guard_reads_a_shared_db_scoped_by_adw_id(A: Any, tmp_path: Path) -> None:
    """What makes one bench-wide database safe: every session row is keyed by
    ``adw_id``, and ``_sssf_adw_id`` derives it from (instance, arm), so no two
    cells can read each other's spend."""
    import sqlite3

    db = tmp_path / "shared.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, total_tokens INTEGER,"
        " total_cost REAL)"
    )
    conn.executemany(
        "INSERT INTO sessions VALUES (?,?,?)",
        [("mine", 10, 2.5), ("someone-elses", 999, 99.0)],
    )
    conn.commit()
    conn.close()
    assert A._sssf_sqlite_totals(db, "mine") == {"cost_usd": 2.5, "total_tokens": 10}
    # An adw_id with no row is $0 spent, not "unreadable".
    assert A._sssf_sqlite_totals(db, "unknown") == {"cost_usd": 0.0, "total_tokens": 0}


def test_the_guard_kills_the_process_group_not_just_the_child(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """A child that spawns pi, git and docker orphans them if only the parent is
    killed — and an orphaned pi keeps calling the model, i.e. keeps spending."""
    src = ast.unparse(run_sssf_ast)
    assert "start_new_session=True" in src
    assert "_kill_tree(proc)" in src
    assert src.count("_kill_tree(proc)") >= 3, (
        "every break in the poll loop that leaves a live child must kill its group"
    )


def test_the_cost_cap_is_a_greppable_module_constant(A: Any) -> None:
    src = _ADAPTER.read_text(encoding="utf-8")
    assert "_SSSF_RUN_COST_CAP_USD = " in src
    assert isinstance(A._SSSF_RUN_COST_CAP_USD, float)
    # Beside the other caps, and disclosed in the row rather than inferred.
    assert "_BENCH_ROOT_CAPS" in src


def test_the_spend_signal_is_monotonic_in_the_driver(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """A shared-db read that loses a race must never make accumulated spend appear
    to go DOWN and re-open headroom under the cap."""
    src = ast.unparse(run_sssf_ast)
    assert "live_cost = max(live_cost, reading)" in src


# --------------------------------------------------------------------------- #
# 7. usage accounting, per role
# --------------------------------------------------------------------------- #


def _agent_end(role: str, **usage: Any) -> str:
    breakdown = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "total_tokens": 0,
        "total_cost": 0.0,
    } | usage
    return json.dumps(
        {
            "type": "agent_end",
            "name": role,
            "tokens": breakdown["total_tokens"],
            "payload": {"cost": breakdown["total_cost"], "usage": breakdown},
        }
    )


def test_usage_is_summed_per_role_across_all_of_that_roles_phases(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """One role owns several phases: the builder alone owns ``build``, every
    ``fix_i`` and every ``revise_i``. Per-phase totals would under-report it."""
    events = tmp_path / "events.jsonl"
    events.write_text(
        "\n".join(
            [
                json.dumps({"type": "agent_start", "name": "builder",
                            "payload": {"model": "azure/DeepSeek-V3.2"}}),
                _agent_end("builder", input_tokens=100, output_tokens=10,
                           total_tokens=110, total_cost=0.5),
                _agent_end("builder", input_tokens=200, output_tokens=20,
                           total_tokens=220, total_cost=1.0),
                json.dumps({"type": "agent_start", "name": "reviewer",
                            "payload": {"model": "azure/gpt-5.4"}}),
                _agent_end("reviewer", input_tokens=50, output_tokens=5,
                           total_tokens=55, total_cost=0.25),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    usage = A._sssf_usage_by_role(A._sssf_read_events(events))
    assert usage["by_role"]["builder"]["calls"] == 2
    assert usage["by_role"]["builder"]["input_tokens"] == 300
    assert usage["by_role"]["builder"]["total_cost"] == pytest.approx(1.5)
    assert usage["by_role"]["reviewer"]["models"] == ["azure/gpt-5.4"]
    assert usage["roles_run"] == ["builder", "reviewer"]
    assert usage["tokens_in"] == 350
    assert usage["tokens_out"] == 35
    assert usage["cost_usd"] == pytest.approx(1.75)
    assert usage["calls"] == 3


def test_cached_reads_are_reported_separately_from_fresh_input(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The engine mirrors pi's shape, where ``input`` EXCLUDES cache reads because
    they bill at their own cheaper rate. Folding them into ``tokens_in`` would
    make a cache-heavy run look like it sent more fresh context than it did, and
    would price it wrong in the expensive direction — so the split has to be
    computable from the row."""
    events = tmp_path / "events.jsonl"
    events.write_text(
        _agent_end(
            "builder",
            input_tokens=1_000,
            cache_read_tokens=50_000,
            cache_write_tokens=7,
            output_tokens=300,
            reasoning_tokens=120,
            total_tokens=51_300,
            total_cost=0.9,
        )
        + "\n",
        encoding="utf-8",
    )
    usage = A._sssf_usage_by_role(A._sssf_read_events(events))
    assert usage["tokens_in"] == 1_000, "fresh input must exclude cache reads"
    assert usage["cached_input_tokens"] == 50_000
    assert usage["cache_write_tokens"] == 7
    # Reasoning is the thinking SHARE of output, never a fifth component.
    assert usage["reasoning_tokens"] == 120
    assert usage["tokens_out"] == 300
    assert usage["reasoning_tokens"] <= usage["tokens_out"]
    # The prompt actually sent is the SUM, and the row can reconstruct it.
    assert usage["tokens_in"] + usage["cached_input_tokens"] == 51_000


def test_a_truncated_or_absent_event_log_reads_as_zero_not_as_an_exception(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """A killed run's log ends mid-line. That must not take the whole row down —
    the row is what records that the run was killed."""
    assert A._sssf_read_events(tmp_path / "nope.jsonl") == []
    partial = tmp_path / "events.jsonl"
    partial.write_text(_agent_end("builder", total_cost=1.0) + "\n{\"type\": \"age",
                       encoding="utf-8")
    usage = A._sssf_usage_by_role(A._sssf_read_events(partial))
    assert usage["cost_usd"] == pytest.approx(1.0)
    assert usage["roles_run"] == ["builder"]


def test_the_phase_count_is_the_arms_step_measure(A: Any, tmp_path: Path) -> None:
    events = tmp_path / "events.jsonl"
    events.write_text(
        "\n".join(
            json.dumps({"type": t, "name": n})
            for t, n in [
                ("phase_start", "request"),
                ("phase_end", "request"),
                ("phase_start", "build"),
                ("log", "build"),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    assert A._sssf_phase_count(A._sssf_read_events(events)) == 2


@requires_bench_host
def test_the_phase_cap_is_the_graphs_own_maximum(A: Any) -> None:
    """Derived from the engine's own loop bounds rather than guessed: request 1 +
    plan 1 + commit_plan 1 + build 1 + (test,fix)*fix_loops + (review,revise)
    bounded by revision_loops + retest 1 + commit_build 1 + changes 1 + document 1
    + commit_docs 1.

    Reads the bounds from the engine's CONFIG DEFAULTS, not from module constants.
    They used to be ``MAX_FIX_LOOPS``/``MAX_REVISION_LOOPS`` literals and this test
    grepped for them; the engine has since moved them into a ``limits:`` roster
    block so an operator can reshape the graph without editing code. Grepping the
    old names raised IndexError the moment that landed — a test that breaks
    because the thing it measures became configurable was measuring the wrong
    surface.

    NOTE the cap is only correct for a run that used the DEFAULT limits. A roster
    that raises ``fix_loops`` legitimately emits more phases, and a fixed cap would
    flag that healthy run as "the graph changed under us". Per-run derivation from
    the synthesised roster is the follow-up; this test pins the default case.
    """
    limits = _engine_default_limits(A)
    expected = (
        4
        + (2 * limits["fix_loops"])
        + (2 * limits["revision_loops"] - 1)
        + 1
        + 4
    )
    assert A._SSSF_PHASE_CAP == expected, (
        f"the engine's graph can emit {expected} phases at default limits "
        f"({limits}); the cap says {A._SSSF_PHASE_CAP}"
    )


def _engine_default_limits(A: Any) -> dict[str, int]:
    """The engine's default loop bounds, preferring the real config object.

    Imports the engine's own ``SSSFConfig`` so the defaults come from the schema
    that actually runs. Falls back to parsing the source, because the harness must
    not hard-fail merely because the engine's dependencies are not importable from
    this venv — the two repos have separate environments.
    """
    import re
    import subprocess
    import sys

    engine_adws = A._SSSF_ROOT / "adws"
    probe = (
        "import sys, json;"
        f"sys.path.insert(0, {str(engine_adws)!r});"
        "from adw_modules.data_types import SSSFConfig;"
        "print(json.dumps(SSSFConfig().limits.model_dump()))"
    )
    proc = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return {k: int(v) for k, v in json.loads(proc.stdout).items()}

    source = (engine_adws / "adw_modules" / "data_types.py").read_text(
        encoding="utf-8"
    )
    out: dict[str, int] = {}
    for key in ("fix_loops", "revision_loops"):
        match = re.search(rf"^\s*{key}\s*:\s*int\s*=\s*(\d+)", source, re.M)
        assert match, f"cannot find the engine's default for {key!r}"
        out[key] = int(match.group(1))
    return out


def test_the_engines_not_accepted_event_is_read_as_the_arms_red_verdict(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """A red verdict is a completely different thing from a crash: the arm ran,
    gated itself red and still produced a diff worth grading."""
    events = tmp_path / "events.jsonl"
    events.write_text(
        json.dumps(
            {
                "type": "error",
                "name": "not_accepted",
                "payload": {"reason": "the suite never came back clean"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    rows = A._sssf_read_events(events)
    assert A._sssf_not_accepted(rows) == "the suite never came back clean"
    assert A._sssf_not_accepted([{"type": "phase_end", "name": "build"}]) is None


# --------------------------------------------------------------------------- #
# 7b. cost and roles come from pi's OWN per-turn stream
# --------------------------------------------------------------------------- #
#
# The defect: the row read its dollars from ``agent_end``, which the engine emits
# ONLY when a phase SUCCEEDS. A builder that did its work through tool calls and
# then failed to emit valid ``BuildOutput`` JSON raised before ``agent_end``, so
# the row published ``cost_usd: 0.00`` and ``sssf_roles_run: ['planner']`` while
# that builder's own stream proved 819k-1.34M tokens. Measured on the 2026-08-12
# sweep: v32-solo understated its arm total by 45% ($4.18 reported, $7.55 true).
#
# The shared sqlite is right on those rows and WRONG on re-run rows, because
# ``sessions.total_cost`` is a running sum keyed by a stable ``adw_id``: pyinfra
# reported $2.0101 there for two attempts of $0.883 and $1.1271.

_V32 = "azure/DeepSeek-V3.2"
_GPT54 = "azure/gpt-5.4"
# The rates in ``~/.pi/agent/models.json``, per 1e6 tokens: (in, out, cacheRead).
# Written out here so a fixture turn's ``usage.cost.total`` is what pi would
# really have computed, which is what makes the drift assertions meaningful.
_RATES = {_V32: (0.58, 1.68, 0.58), _GPT54: (2.50, 15.00, 0.25)}


def _raw_turn(
    *,
    model: str = _V32,
    tokens_in: int = 0,
    tokens_out: int = 0,
    cache_read: int = 0,
    empty: bool = False,
    error: str | None = None,
) -> str:
    """One ``message_end`` line, shaped exactly as pi streams it.

    ``empty=True`` is the swallowed provider failure: empty content, all-zero
    usage, ``stopReason: "error"`` — what pi emits when the deployment refuses the
    request and the engine carries on as if the model had answered.
    """
    provider, _, deployment = model.partition("/")
    r_in, r_out, r_cache = _RATES[model]
    usage = {
        "input": 0 if empty else tokens_in,
        "output": 0 if empty else tokens_out,
        "cacheRead": 0 if empty else cache_read,
        "cacheWrite": 0,
        "totalTokens": 0 if empty else tokens_in + tokens_out + cache_read,
    }
    usage["cost"] = {
        "total": (
            0.0
            if empty
            else usage["input"] / 1e6 * r_in
            + usage["output"] / 1e6 * r_out
            + usage["cacheRead"] / 1e6 * r_cache
        )
    }
    message: dict[str, Any] = {
        "role": "assistant",
        "provider": provider,
        "model": deployment,
        "content": [] if empty else [{"type": "text", "text": "ok"}],
        "stopReason": "error" if empty else "endTurn",
        "usage": usage,
    }
    if error:
        message["errorMessage"] = error
    return json.dumps({"type": "message_end", "message": message})


def _raw_stream(session_dir: Path, role: str, turns: list[str]) -> Path:
    """Plant one role's ``raw_output.jsonl``, with the noise pi really writes.

    The noise matters: these files reach 56 MB and are mostly ``message_update``
    deltas, and the USER half of every exchange is a ``message_end`` too. A reader
    that counted either would double the run's cost.
    """
    role_dir = session_dir / role
    role_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        json.dumps({"type": "session", "role": role}),
        json.dumps({"type": "message_end", "message": {"role": "user",
                                                       "content": [{"text": "task"}],
                                                       "usage": {"input": 99_999}}}),
    ]
    for turn in turns:
        lines.append(json.dumps({"type": "message_update", "delta": "message_end?"}))
        lines.append(turn)
    path = role_dir / "raw_output.jsonl"
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    return path


def _planted_session(
    tmp_path: Path, adw_id: str = "d42a2793"
) -> tuple[Path, Path]:
    """A run's ``data_dir`` with a SUCCEEDED role and a role that raised.

    The builder here is the measured failure mode: 3 real turns of work and no
    ``agent_end`` anywhere, because the phase raised on its output schema after
    the money was already spent.
    """
    data_dir = tmp_path / "adw_data"
    session = data_dir / "sessions" / adw_id
    _raw_stream(
        session,
        "planner",
        [_raw_turn(tokens_in=100_000, tokens_out=2_000)],
    )
    _raw_stream(
        session,
        "builder",
        [
            _raw_turn(tokens_in=400_000, tokens_out=5_000),
            _raw_turn(tokens_in=500_000, tokens_out=6_000),
            _raw_turn(tokens_in=434_000, tokens_out=4_000),
        ],
    )
    # A role directory with no stream in it is not a role: the engine writes
    # ``context_handoff`` beside the agents and it holds only phase payloads.
    (session / "context_handoff" / "quality").mkdir(parents=True)
    return data_dir, session


def test_the_stream_sees_the_spend_of_a_phase_that_raised_before_agent_end(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """THE defect. The events ledger sees the planner only; the streams see both,
    and the builder is where 1.34M tokens and most of the dollars went."""
    data_dir, _session = _planted_session(tmp_path)
    events = tmp_path / "events.jsonl"
    events.write_text(
        "\n".join(
            [
                json.dumps({"type": "agent_start", "name": "planner",
                            "payload": {"model": _V32}}),
                _agent_end("planner", input_tokens=100_000, output_tokens=2_000,
                           total_tokens=102_000, total_cost=0.06136),
                # The builder's agent_start is here — it RAN — and there is no
                # agent_end for it, because the phase raised.
                json.dumps({"type": "agent_start", "name": "builder",
                            "payload": {"model": _V32}}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    ledger = A._sssf_usage_by_role(A._sssf_read_events(events))
    assert ledger["roles_run"] == ["planner"], "the defect, reproduced"
    assert ledger["tokens_in"] == 100_000

    raw = A._sssf_raw_usage_by_role(data_dir, "d42a2793")
    assert raw["roles_run"] == ["builder", "planner"]
    assert raw["by_role"]["builder"]["calls"] == 3
    assert raw["tokens_in"] == 1_434_000, "the user half and the deltas are not turns"
    assert raw["tokens_out"] == 17_000
    assert raw["calls"] == 4
    # NON-ZERO, which is the whole point: the money was spent before the raise.
    assert raw["cost_usd"] > 0.8
    assert raw["cost_usd"] == pytest.approx(
        1_434_000 / 1e6 * 0.58 + 17_000 / 1e6 * 1.68, abs=1e-6
    )
    assert raw["cost_usd"] > ledger["cost_usd"] * 10
    assert raw["provider_starved"] is False
    assert raw["empty_response_turns"] == 0


def test_a_role_directory_with_no_stream_is_not_a_role(A: Any, tmp_path: Path) -> None:
    """``context_handoff`` sits beside the agents and holds only phase payloads.
    Counting it as a role would put a phantom in ``sssf_roles_run`` and trip the
    skipped-role tripwire on a healthy run."""
    data_dir, _session = _planted_session(tmp_path)
    assert sorted(A._sssf_role_streams(data_dir, "d42a2793")) == ["builder", "planner"]
    assert "context_handoff" not in A._sssf_raw_usage_by_role(data_dir, "d42a2793")["by_role"]


def test_an_absent_or_truncated_stream_reads_as_zero_not_as_an_exception(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """A killed run's stream ends mid-line. The row is what records that the run
    was killed, so reading it must not take the row down."""
    empty = A._sssf_raw_usage_by_role(tmp_path / "nothing", "d42a2793")
    assert empty["cost_usd"] == 0.0
    assert empty["calls"] == 0
    assert empty["roles_run"] == []
    assert empty["provider_starved"] is False

    session = tmp_path / "adw_data" / "sessions" / "d42a2793"
    path = _raw_stream(session, "builder", [_raw_turn(tokens_in=1_000, tokens_out=10)])
    path.write_text(
        path.read_text(encoding="utf-8") + '{"type": "message_end", "mess',
        encoding="utf-8",
    )
    usage = A._sssf_raw_usage_by_role(tmp_path / "adw_data", "d42a2793")
    assert usage["calls"] == 1
    assert usage["tokens_in"] == 1_000


@requires_bench_host
def test_the_provider_figure_is_checked_against_an_independent_re_derivation(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """pi's ``usage.cost.total`` is itself derived — it multiplies models.json
    locally per turn — so the row carries this harness's own multiply beside it.
    A gap means the rate table moved under the sweep, which nothing else in the
    row can detect."""
    data_dir, _session = _planted_session(tmp_path)
    raw = A._sssf_raw_usage_by_role(data_dir, "d42a2793")
    table = A._sssf_price_table([_V32])
    rederived = A._sssf_rederive_cost(raw["by_role"], table)
    assert rederived["models_missing_a_rate"] == []
    assert rederived["cost_usd"] == pytest.approx(raw["cost_usd"], abs=1e-6)
    assert abs(rederived["cost_usd"] - raw["cost_usd"]) <= A._SSSF_COST_DRIFT_TOLERANCE_USD

    # A rate table that does not name the deployment is a DISCLOSURE, never a
    # discount: pricing the unknown model at zero is how a run gets cheaper by
    # losing its provenance.
    blind = A._sssf_rederive_cost(raw["by_role"], {"rates": {}})
    assert blind["cost_usd"] == 0.0
    assert blind["models_missing_a_rate"] == [_V32]

    # And a table whose rates MOVED shows up as drift, not as a silent reprice.
    moved = A._sssf_rederive_cost(
        raw["by_role"], {"rates": {_V32: {"cost": {"input": 5.80, "output": 16.8}}}}
    )
    assert moved["cost_usd"] - raw["cost_usd"] > A._SSSF_COST_DRIFT_TOLERANCE_USD


def test_the_turn_digest_survives_the_work_dir_that_holds_the_streams(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``_work_dir(fresh=True)`` deletes the streams at the next attempt and they
    run to tens of megabytes each, so the row's published dollars would be
    unauditable without the digest beside result.json."""
    data_dir, _session = _planted_session(tmp_path)
    raw = A._sssf_raw_usage_by_role(data_dir, "d42a2793")
    digest = tmp_path / A._SSSF_TURNS_NAME
    assert A._sssf_write_turn_digest(digest, raw["by_role"], "d42a2793") == 2
    rows = A._sssf_read_turn_digest(digest)
    assert [r["role"] for r in rows] == ["builder", "planner"]
    assert sum(r["input_tokens"] for r in rows) == raw["tokens_in"]
    assert sum(r["provider_cost_usd"] for r in rows) == pytest.approx(
        raw["cost_usd"], abs=1e-6
    )
    assert A._sssf_read_turn_digest(tmp_path / "absent.jsonl") == []


@requires_bench_host
def test_the_driver_publishes_the_stream_and_records_the_other_two_sources(
    A: Any,  # noqa: N803
    fake_instance: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End to end, through ``run_sssf``'s own row assembly, for $0.

    The streams are PLANTED and the engine is never invoked (``--probe-plumbing``),
    so the run is free — but every published token and dollar still goes through
    the real code path, and the two cross-checks have to land in their own keys
    with the events figure visibly LOWER than what was really spent.
    """
    inst = fake_instance["inst"]
    src = fake_instance["src"]
    arm = "chain"
    adw_id = A._sssf_adw_id("acme__widget-1", arm)

    work = tmp_path / "work" / f"acme__widget-1__{arm}"
    work.mkdir(parents=True)
    data_dir, session = _planted_session(work, adw_id)
    assert data_dir == work / "adw_data", "run_sssf reads data_dir from the work dir"
    # The engine's own phase ledger, seeing the planner only — the defect.
    events_path = A._sssf_events_path(data_dir, adw_id)
    events_path.write_text(
        "\n".join(
            [
                json.dumps({"type": "phase_start", "name": "plan"}),
                json.dumps({"type": "agent_start", "name": "planner",
                            "payload": {"model": _V32}}),
                _agent_end("planner", input_tokens=100_000, output_tokens=2_000,
                           total_tokens=102_000, total_cost=0.06136),
                json.dumps({"type": "phase_start", "name": "build"}),
                json.dumps({"type": "agent_start", "name": "builder",
                            "payload": {"model": _V32}}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_work_root", lambda: tmp_path / "work")
    # NOT wiped: the planted streams stand in for a run that already happened.
    monkeypatch.setattr(A, "_work_dir", lambda i, a, fresh=False: work)
    monkeypatch.setattr(A, "_SSSF_SHARED_DB", tmp_path / "runs" / "sssf-bench.db")
    monkeypatch.setattr(A, "_instance", lambda i: inst)
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "a" * 16})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda insts: None)
    monkeypatch.setattr(A, "_ensure_image", lambda *a, **k: True)
    monkeypatch.setattr(A, "_clone", lambda i, dest: shutil.copytree(src, dest))
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda *a, **k: None)
    monkeypatch.setattr(
        A, "_precheck_collect",
        lambda i, r: {"collect_ok": True, "tail": "", "exit_code": 0, "mode": "m",
                      "collected_targets": [], "duration_s": 0.0},
    )

    A.run_sssf("acme__widget-1", arm=arm, max_steps=18, timeout_s=600,
               probe_plumbing=True)
    run_dir = A._run_dir("acme__widget-1", arm)
    row = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))

    # --- the published figures are the STREAM's ------------------------------
    assert row["sssf_roles_run"] == ["builder", "planner"]
    assert row["tokens_in"] == 1_434_000
    assert row["tokens_out"] == 17_000
    assert row["persona_calls"] == 4
    assert row["sssf_assistant_turns"] == 4
    assert row["cost_usd"] > 0.8
    assert sorted(row["usage_by_role"]) == ["builder", "planner"]
    assert A._SSSF_RAW_OUTPUT_NAME in row["usage_source"]

    # --- and the other two sources are RECORDED, not merged ------------------
    assert row["sssf_roles_run_events"] == ["planner"], "the coarser ledger's view"
    assert row["cost_usd_events"] == pytest.approx(0.06136)
    assert row["tokens_in_events"] == 100_000
    assert row["cost_usd"] > row["cost_usd_events"]
    assert row["cost_missing_from_events_usd"] == pytest.approx(
        row["cost_usd"] - row["cost_usd_events"], abs=5e-4
    )
    # No shared db exists in this fixture, and "could not read it" is recorded as
    # None rather than as $0 — a missing signal is not a measured zero.
    assert row["cost_usd_shared_db"] is None
    assert row["cost_mismatch_usd"] is None
    assert row["shared_db_totals"] is None

    # --- the rate table, re-derived here beside the provider's own figure ----
    assert row["cost_usd_rederived"] == pytest.approx(row["cost_usd"], abs=5e-4)
    assert row["cost_rederivation_disagrees"] is False
    assert row["models_missing_a_rate"] == []
    assert row["cost_rederivation_tolerance_usd"] == A._SSSF_COST_DRIFT_TOLERANCE_USD

    # --- the evidence outlives the work dir ---------------------------------
    assert row["sssf_turn_digest_file"] == A._SSSF_TURNS_NAME
    digest = A._sssf_read_turn_digest(run_dir / A._SSSF_TURNS_NAME)
    assert sum(r["input_tokens"] for r in digest) == row["tokens_in"]
    assert row["provider_starved"] is False
    assert row["empty_response_turns"] == 0

    # --- and the audit certifies the row against BOTH ledgers ---------------
    shutil.copy2(events_path, run_dir / A._SSSF_EVENTS_NAME)
    failures, _warnings, ledger = A._audit_sssf_run(run_dir, row, True, arm)
    assert failures == [], failures
    assert ledger[0] == pytest.approx(row["cost_usd"], abs=5e-4)


def test_the_audit_refuses_a_row_published_below_its_own_phase_ledger(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``agent_end`` fires only for a phase that SUCCEEDED, so it can only ever
    MISS turns, never invent them. A published figure below it means the primary
    reader lost spend — which is the defect, in the other direction."""
    _events_file(tmp_path)
    row = _row(
        A,
        cost_usd=0.10,
        tokens_in=10,
        tokens_out=1,
        cost_usd_events=1.75,
        tokens_in_events=350,
        tokens_out_events=35,
        cached_input_tokens_events=0,
    )
    failures, _w, _t = A._audit_sssf_run(tmp_path, row, True, "chain")
    assert any("cost_usd below the events ledger" in f for f in failures), failures
    assert any("tokens_out below the events ledger" in f for f in failures), failures


def test_the_audit_refuses_a_row_whose_events_cross_check_was_edited(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The cross-check keys are certified against the trace exactly, as the
    published figures used to be — a cross-check nobody checks is decoration."""
    _events_file(tmp_path)
    row = _row(
        A,
        cost_usd=2.00,
        cost_usd_events=0.01,
        tokens_in_events=350,
        tokens_out_events=35,
        cached_input_tokens_events=0,
    )
    failures, _w, _t = A._audit_sssf_run(tmp_path, row, True, "chain")
    assert any("cost_usd_events mismatch" in f for f in failures), failures


# --------------------------------------------------------------------------- #
# 7c. a throttled request is NOT a capability failure
# --------------------------------------------------------------------------- #
#
# Under concurrency the deployment refuses requests and pi SWALLOWS the failure:
# an assistant message with empty content, all-zero usage and
# ``stopReason: "error"``, after which the engine carries on as if the model had
# answered. Verified both directions on ``alibaba__opensandbox-816``/``v32-solo``:
# at ``--workers 6`` the row recorded ``roles_run=[]``, $0.00, ``green=False`` and
# ``empty_patch``; at ``--workers 1`` the SAME instance recorded
# ``roles_run=['builder']``, $1.522, ``green=True`` and a real 1,878-byte patch.
# Peak single-turn input was 32,847 tokens against V3.2's 128,000 window, so it is
# not context overflow — it is the provider's queue.
#
# Such a row must be REFUSED from every rate, on the ``grade_parse_failed``
# precedent: a defect on our side of the wire reported as an arm failure is how one
# bug becomes a uniform 0% across every arm.

_THROTTLE = (
    "429 Your requests to DeepSeek-V3.2 for DeepSeek-V3.2 have exceeded the "
    "token rate limit"
)


def test_an_empty_response_with_zero_usage_is_counted_per_role(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    session = tmp_path / "adw_data" / "sessions" / "abc12345"
    _raw_stream(
        session,
        "builder",
        [
            _raw_turn(tokens_in=30_000, tokens_out=400),
            _raw_turn(empty=True, error=_THROTTLE),
            _raw_turn(empty=True, error=_THROTTLE),
            _raw_turn(tokens_in=32_847, tokens_out=500),
        ],
    )
    _raw_stream(session, "planner", [_raw_turn(tokens_in=1_000, tokens_out=10)])
    usage = A._sssf_raw_usage_by_role(tmp_path / "adw_data", "abc12345")
    assert usage["empty_response_turns"] == 2
    assert usage["empty_response_by_role"] == {"builder": 2}, "WHICH role was starved"
    assert usage["provider_starved"] is True
    assert any("429" in r for r in usage["empty_response_reasons"])
    # The swallowed turns cost nothing and are not context overflow: the peak
    # single-turn prompt is far inside V3.2's 128,000-token window.
    assert usage["by_role"]["builder"]["total_cost"] == pytest.approx(
        62_847 / 1e6 * 0.58 + 900 / 1e6 * 1.68, abs=1e-6
    )
    assert usage["by_role"]["builder"]["calls"] == 4, "a refused turn was still a send"
    assert usage["peak_turn_input_tokens"] == 32_847
    assert usage["by_role"]["planner"]["empty_response_turns"] == 0


@pytest.mark.parametrize(
    "content",
    [
        [{"type": "toolCall", "toolCall": {"name": "bash"}}],
        [{"type": "text", "text": "I fixed it"}],
        [{"type": "thinking", "thinking": "hmm"}],
    ],
)
def test_a_turn_that_said_something_is_never_read_as_a_swallowed_failure(
    A: Any, content: list[dict[str, Any]]  # noqa: N803
) -> None:
    """Fail-closed toward "not empty". A tool call with no prose beside it is
    still work, and an unrecognised shape must never be able to disqualify a
    healthy row — that would turn this tripwire into its own uniform 0%."""
    assert A._sssf_turn_is_empty(content) is False
    assert A._sssf_turn_is_empty([]) is True
    assert A._sssf_turn_is_empty(None) is True
    assert A._sssf_turn_is_empty("   ") is True
    assert A._sssf_turn_is_empty([{"type": "text", "text": "  "}]) is True


def test_a_zero_token_turn_that_still_said_something_is_not_starvation(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """BOTH conditions, ANDed: measured on keras-team__keras-22316, one turn came
    back with zero usage but real content. Only the empty-AND-zero pair is pi
    swallowing a refusal."""
    session = tmp_path / "adw_data" / "sessions" / "abc12345"
    line = json.loads(_raw_turn(empty=True))
    line["message"]["content"] = [{"type": "text", "text": "a free retry"}]
    _raw_stream(session, "builder", [json.dumps(line)])
    usage = A._sssf_raw_usage_by_role(tmp_path / "adw_data", "abc12345")
    assert usage["calls"] == 1
    assert usage["empty_response_turns"] == 0
    assert usage["provider_starved"] is False


def test_the_starved_termination_is_an_error_not_a_counted_cap_hit(A: Any) -> None:
    """A cap hit is a COUNTED attempt: the arm had its budget and used it. A
    starved row is not an attempt at all. Putting it in ``_BUDGET_TERMINATIONS``
    would count it as unresolved; ``_ERROR_TERMINATIONS`` also stops the
    step-count fallback re-labelling it as budget-exhausted."""
    term = A._SSSF_EMPTY_RESPONSE_TERMINATION
    assert term == "provider-empty-response"
    assert term in A._ERROR_TERMINATIONS
    assert term not in A._BUDGET_TERMINATIONS
    row = {
        "termination": term,
        "error": "provider-empty-response: 2 assistant turn(s) came back EMPTY",
        "empty_response_turns": 2,
        "steps_used": 18,
        "step_cap": 18,
        "wall_clock_s": 12.0,
    }
    assert A.budget_exhausted_reason(row) is None, "a cap hit is a counted attempt"
    status, detail = A.classify_run(row)
    assert status == A._RUN_FAILED
    assert "provider-empty-response" in (detail or "")


def test_the_driver_refuses_a_starved_row_and_carries_the_prior_verdict(
    run_sssf_ast: ast.FunctionDef, A: Any  # noqa: N803
) -> None:
    """LAST of the error rules and it OVERRIDES them, carrying what they found
    along in the message: if a row is both capped and starved, the fact that
    disqualifies it wins — but nothing is hidden. Exempt under
    ``--probe-plumbing``, which called no model and already carries its own
    error."""
    src = ast.unparse(run_sssf_ast)
    assert "if raw_usage['provider_starved'] and (not probe_plumbing):" in src
    assert "termination = _SSSF_EMPTY_RESPONSE_TERMINATION" in src
    assert "Prior verdict, carried forward" in src
    # The message names the count, the roles and the provider's own reason.
    for field in ("{turns}", "{roles}", "{reasons}"):
        assert field in A._SSSF_EMPTY_RESPONSE_ERROR
    assert "NOT reportable" in A._SSSF_EMPTY_RESPONSE_ERROR


def _reported_row(
    runs: Path,
    iid: str,
    arm: str,
    *,
    sha: str,
    starved: int = 0,
    resolved: bool = False,
) -> Path:
    """One (instance, arm) row dir with all three artifacts ``_report_rows`` needs."""
    d = runs / iid / arm
    d.mkdir(parents=True, exist_ok=True)
    (d / "prediction.diff").write_text(f"diff --git a/{iid}.py b/{iid}.py\n+# x\n",
                                      encoding="utf-8")
    (d / "audit.json").write_text(json.dumps({"ok": True, "failures": [],
                                              "warnings": []}), encoding="utf-8")
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
    (d / "result.json").write_text(json.dumps(payload), encoding="utf-8")
    return d


def test_a_starved_row_is_refused_from_every_rate_and_a_clean_row_is_not(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The reporting half of the fix, through the real ``_report_rows`` ->
    ``_arm_view`` path.

    Both rows here graded UNRESOLVED with an empty patch. The clean one is the
    arm's own failure and belongs in the denominator; the starved one is a
    measurement of the provider's queue and must leave the denominator entirely —
    otherwise one throttling episode publishes itself as a capability rate.
    """
    runs = tmp_path / "runs"
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    sha = "pinned-manifest-sha"
    _reported_row(runs, "inst_clean", "v32-solo", sha=sha)
    _reported_row(runs, "inst_starved", "v32-solo", sha=sha, starved=27)

    rows, refused, foreign, superseded = A._report_rows(runs, sha)
    assert (refused, foreign, superseded) == ([], [], [])
    assert len(rows) == 2
    starved = next(r for r in rows if r["instance_id"] == "inst_starved")
    clean = next(r for r in rows if r["instance_id"] == "inst_clean")

    assert starved["_run_failed"] is True
    assert starved["_budget_exhausted"] is False, "not a counted cap hit"
    assert clean["_run_failed"] is False

    view = A._arm_view(rows, "v32-solo")
    assert [r["instance_id"] for r in view.valid] == ["inst_clean"]
    assert [r["instance_id"] for r in view.excluded] == ["inst_starved"]
    assert view.resolved == []
    # The rate's denominator is the clean row alone — the starved row is neither
    # numerator nor denominator, exactly as a `grade_parse_failed` row is not.
    assert A._fmt_rate(len(view.resolved), len(view.valid)) == "0/1 = 0%"

    # ...and the matrix says WHY, rather than filing it under the arm's own
    # invalid rows with an `X`.
    assert A._outcome_cell(starved) == "S"
    assert A._outcome_cell(clean) == "E"
    assert "provider-starved" in A._outcome_codes(rows)
    assert "provider-starved" not in A._outcome_codes([clean])
    assert "provider-empty-response" in A._exclusion_reason(starved)


def test_the_sweep_says_out_loud_that_its_own_width_starved_the_rows(A: Any) -> None:
    """The count belongs in the sweep artifact, not only in a row nobody re-reads:
    a sweep whose concurrency caused the refusals has to say so where its own
    headline number is printed."""
    records = [
        {"instance_id": "a", "status": A._RUN_OK, "audit_ok": True,
         "oracle_resolved": True, "outcome": "resolved", "provider_starved": False,
         "empty_response_turns": 0},
        {"instance_id": "b", "status": A._RUN_FAILED, "audit_ok": True,
         "oracle_resolved": False, "outcome": "empty_patch",
         "provider_starved": True, "empty_response_turns": 29},
    ]
    summary = A._sweep_summary(records, arm="v32-solo", workers=6, wall_s=1.0)
    assert summary["provider_starved"] == 1
    assert summary["empty_response_turns"] == 29
    rendered = A._render_summary(summary)
    assert "PROVIDER-STARVED" in rendered
    assert "lower concurrency" in rendered
    # A row the provider starved is never one of the sweep's own clean results.
    assert summary["resolved"] == 1
    assert A._row_provider_starved(records[1]) is True
    assert A._row_provider_starved(records[0]) is False


def test_the_audit_refuses_a_starved_row_that_does_not_terminate_as_starved(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The tripwire has to be certifiable from the artifacts, not just set by the
    driver: a row that counted the swallowed turns and then reported a normal
    termination would walk straight back into the denominator."""
    _events_file(tmp_path)
    row = _row(
        A,
        cost_usd_events=1.75,
        tokens_in_events=350,
        tokens_out_events=35,
        cached_input_tokens_events=0,
        empty_response_turns=27,
        termination="terminal-state",
    )
    failures, _w, _t = A._audit_sssf_run(tmp_path, row, True, "chain")
    assert any("must terminate as" in f for f in failures), failures

    row["termination"] = A._SSSF_EMPTY_RESPONSE_TERMINATION
    failures, warnings, _t = A._audit_sssf_run(tmp_path, row, True, "chain")
    assert failures == [], failures
    assert any("NOT REPORTABLE" in w for w in warnings), warnings


# --------------------------------------------------------------------------- #
# 8. the price table, serialised with its hash
# --------------------------------------------------------------------------- #


@requires_bench_host
def test_the_price_table_is_serialised_with_its_content_hash(A: Any) -> None:
    """Dollars here are DERIVED: pi multiplies measured token counts by this file
    locally. Recording the rates AND the hash is what lets a later price change be
    applied to past rows arithmetically instead of by re-running them."""
    block = A._sssf_price_table([A._SSSF_STRONG, A._SSSF_CHEAP])
    assert block["sha256"] == A._PI_PRICE_TABLE_SHA256
    assert block["matches_pinned"] is True
    assert block["missing"] == []
    assert block["units"] == "USD per 1,000,000 tokens"
    for model in (A._SSSF_STRONG, A._SSSF_CHEAP):
        rate = block["rates"][model]
        # The FULL block, not just the two headline numbers: cache reads bill at
        # their own rate and a re-derivation needs it.
        assert set(rate["cost"]) == {"input", "output", "cacheRead", "cacheWrite"}
        assert rate["contextWindow"] > 0 and rate["maxTokens"] > 0
    assert block["rates"][A._SSSF_STRONG]["cost"]["input"] == 2.5
    assert block["rates"][A._SSSF_STRONG]["cost"]["output"] == 15.0
    assert block["rates"][A._SSSF_CHEAP]["cost"]["input"] == 0.58
    assert block["rates"][A._SSSF_CHEAP]["cost"]["output"] == 1.68


def test_a_changed_price_table_is_detectable_from_the_row(
    A: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path  # noqa: N803
) -> None:
    """``matches_pinned: false`` is the flag that says rows either side of a price
    edit are not directly comparable. Silently re-deriving would hide it."""
    fake = tmp_path / "models.json"
    fake.write_text(
        json.dumps(
            {
                "providers": {
                    "azure": {
                        "api": "openai-completions",
                        "models": [
                            {
                                "id": "gpt-5.4",
                                "contextWindow": 1,
                                "maxTokens": 1,
                                "reasoning": True,
                                "cost": {"input": 99.0, "output": 1.0,
                                         "cacheRead": 0.0, "cacheWrite": 0.0},
                            }
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "_PI_PRICE_TABLE", fake)
    block = A._sssf_price_table(["azure/gpt-5.4", "azure/DeepSeek-V3.2"])
    assert block["matches_pinned"] is False
    assert block["rates"]["azure/gpt-5.4"]["cost"]["input"] == 99.0
    # A deployment the table does not know is NAMED, not silently priced at zero.
    assert block["missing"] == ["azure/DeepSeek-V3.2"]


def test_an_unreadable_price_table_is_recorded_rather_than_assumed(
    A: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "_PI_PRICE_TABLE", tmp_path / "gone.json")
    block = A._sssf_price_table(["azure/gpt-5.4"])
    assert block["sha256"] is None
    assert block["matches_pinned"] is False
    assert "unreadable" in str(block["error"])


@requires_bench_host
def test_every_roster_model_is_priced_by_the_live_table(A: Any) -> None:
    """A typo'd deployment id would otherwise be discovered as a $0 cost column on
    a row that really spent money."""
    declared = sorted(
        {m for roster in A._SSSF_ROSTERS.values() for m in roster.values() if m}
    )
    block = A._sssf_price_table(declared)
    assert block["missing"] == [], f"unpriced deployments: {block['missing']}"


# --------------------------------------------------------------------------- #
# 9. the graded diff — the scaffold bucket
# --------------------------------------------------------------------------- #


def _diff(*paths: str) -> str:
    out = []
    for p in paths:
        out.append(
            f"diff --git a/{p} b/{p}\n"
            "--- a/{p}\n".replace("{p}", p)
            + f"+++ b/{p}\n@@ -1 +1 @@\n-old\n+new\n"
        )
    return "".join(out)


def test_the_planners_spec_is_excluded_while_the_source_change_is_kept(
    A: Any,  # noqa: N803
) -> None:
    """Only ``chain`` runs the planner, so this exclusion is load-bearing for that
    arm specifically: leave it in and ``chain`` carries diff bytes the two solo
    arms structurally cannot produce, and the arm is graded on its planning STYLE.
    """
    excluded: list[str] = []
    code, kept, stripped = A.split_diff(
        _diff("specs/0a1b_plan.md", "src/thing.py"),
        exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES,
        excluded=excluded,
    )
    assert kept == ["src/thing.py"]
    assert excluded == ["specs/0a1b_plan.md"]
    assert "src/thing.py" in code and "specs/0a1b_plan.md" not in code
    # THE POINT OF A SEPARATE KEY: `stripped` feeds the report's "test files
    # stripped" column, and a plan file appearing there would accuse the arm of
    # suppressing a TEST edit.
    assert stripped == []


def test_every_documenter_destination_and_engine_state_path_is_excluded(
    A: Any,  # noqa: N803
) -> None:
    excluded: list[str] = []
    paths = (
        "specs/plan.md",
        "app_docs/writeup.md",
        "docs/guide.md",
        "adw_data/sessions/x/events.jsonl",
        "adws/adw_modules/agents.py",
    )
    code, kept, stripped = A.split_diff(
        _diff(*paths, "pkg/real.py"),
        exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES,
        excluded=excluded,
    )
    assert kept == ["pkg/real.py"]
    assert excluded == list(paths)
    assert stripped == []
    assert A._SSSF_EXCLUDED_PREFIXES == (
        "specs/",
        "app_docs/",
        "docs/",
        "adw_data/",
        "adws/",
    )


def test_markdown_is_never_blanket_excluded(A: Any) -> None:
    """The documenter's declared ``writes`` is markdown ANYWHERE, and this repo's
    own rules count markdown as PRODUCTION. Excluding ``**/*.md`` would discard
    the legitimate documentation edits a gold patch may contain — grading the arm
    as having matched a patch it only partly produced, biased in its favour.

    ``full-sdlc`` runs the documenter, so this is no longer hypothetical: that arm
    really can emit markdown outside ``app_docs/`` and ``docs/``, and when it does
    the file is GRADED as the production change this repo's rules say it is. The
    narrow path rule stays narrow on purpose."""
    excluded: list[str] = []
    _code, kept, _stripped = A.split_diff(
        _diff("README.md", "pkg/api.md", "pkg/deep/nested/notes.md"),
        exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES,
        excluded=excluded,
    )
    assert kept == ["README.md", "pkg/api.md", "pkg/deep/nested/notes.md"]
    assert excluded == []
    assert not any("*.md" in p for p in A._SSSF_EXCLUDED_PREFIXES)


def test_a_test_file_under_an_excluded_prefix_is_still_stripped_as_a_test(
    A: Any,  # noqa: N803
) -> None:
    """Ordering: the exclusion is checked LAST, so it can never launder a test
    edit out of its own verdict."""
    excluded: list[str] = []
    _code, kept, stripped = A.split_diff(
        _diff("specs/tests/test_sneaky.py", "src/x.py"),
        exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES,
        excluded=excluded,
    )
    assert stripped == ["specs/tests/test_sneaky.py"]
    assert excluded == []
    assert kept == ["src/x.py"]


def test_a_collection_channel_under_an_excluded_prefix_still_refuses_the_row(
    A: Any,  # noqa: N803
) -> None:
    """Fail-closed: an edit that can neuter the hidden suite must refuse the row
    whether or not it happens to sit under a scaffold directory."""
    with pytest.raises(A.DiffRefused):
        A.split_diff(
            _diff("docs/setup.py"),
            exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES,
            excluded=[],
        )


def test_split_diff_is_unchanged_for_every_other_arm(A: Any) -> None:
    """The new parameters default to off, so the four published arms' behaviour is
    byte-identical — no scaffold path is excluded and no bucket is filled."""
    text = _diff("specs/plan.md", "docs/x.md", "src/a.py")
    code, kept, stripped = A.split_diff(text)
    assert kept == ["specs/plan.md", "docs/x.md", "src/a.py"]
    assert stripped == []
    assert code == text
    # And an out-parameter is cleared even when nothing matches, so a caller can
    # never read a previous call's leftovers.
    leftover = ["stale"]
    A.split_diff(_diff("src/a.py"), excluded=leftover)
    assert leftover == []
    A.split_diff("", excluded=leftover)
    assert leftover == []


def test_the_exclusion_is_a_directory_prefix_and_nothing_cleverer(A: Any) -> None:
    """A pattern language here would be one typo away from silently excluding
    production code, which is the one direction this must never fail in."""
    assert A._has_excluded_prefix("specs/a.md", ("specs/",)) is True
    assert A._has_excluded_prefix("specs", ("specs/",)) is False
    assert A._has_excluded_prefix("myspecs/a.md", ("specs/",)) is False
    assert A._has_excluded_prefix("src/specs/a.md", ("specs/",)) is False
    assert all(p.endswith("/") for p in A._SSSF_EXCLUDED_PREFIXES)


def test_the_shared_diff_path_module_is_untouched() -> None:
    """``factory/diff_paths.py`` is shared with the chain's merge gate, so the
    exclusion lives at the ONE site in ``split_diff`` instead."""
    src = (_REPO_ROOT / "factory" / "diff_paths.py").read_text(encoding="utf-8")
    for token in ("app_docs", "adw_data", "sssf", "specs/"):
        assert token not in src, f"{token} leaked into the shared diff-path module"


# --------------------------------------------------------------------------- #
# 10. the mandatory call order
# --------------------------------------------------------------------------- #


def _stmt_index(fn: ast.FunctionDef, callee: str) -> int:
    for i, stmt in enumerate(fn.body):
        if any(
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == callee
            for n in ast.walk(stmt)
        ):
            return i
    raise AssertionError(f"run_sssf never calls {callee}")


def test_the_wall_clock_starts_before_the_clone(run_sssf_ast: ast.FunctionDef) -> None:
    """Otherwise clone and setup time is silently excluded from ``wall_clock_s``."""
    entered_at = next(
        i
        for i, stmt in enumerate(run_sssf_ast.body)
        if isinstance(stmt, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "entered" for t in stmt.targets)
    )
    assert entered_at < _stmt_index(run_sssf_ast, "_clone")


def test_artifacts_are_reset_before_any_exit_path(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """No early exit (pre-flight, image, precheck, crash) may strand a previous
    run's prediction beside a fresh result."""
    reset_at = _stmt_index(run_sssf_ast, "_reset_run_artifacts")
    for callee in ("_ensure_image", "_clone", "_prepare_cloned_tree"):
        assert reset_at < _stmt_index(run_sssf_ast, callee), callee


def _last_stmt_index(fn: ast.FunctionDef, callee: str) -> int:
    found = [
        i
        for i, stmt in enumerate(fn.body)
        if any(
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == callee
            for n in ast.walk(stmt)
        )
    ]
    assert found, f"run_sssf never calls {callee}"
    return found[-1]


def test_the_full_mandatory_order_is_respected(run_sssf_ast: ast.FunctionDef) -> None:
    """The order every arm's runner shares. Each step exists because skipping it
    produced a wrong published number once.

    ``_write_result`` and ``_print_run_summary`` are checked on their LAST
    occurrence, not their first: the collect-precheck early exit legitimately
    writes a row of its own before the pipeline continues, and that is the point of
    it — a $0 refusal still has to leave a readable result behind.
    """
    order = [
        "_instance",
        "_assert_oracle_store_complete",
        "_run_dir",
        "_reset_run_artifacts",
        "_ensure_image",
        "_work_dir",
        "_clone",
        "assert_workspace_isolated",
        "_prepare_cloned_tree",
        "_precheck_collect",
        "lock_test_files",
        "_capture_diff",
        "_refuse_untrustworthy_empty_diff",
        "split_diff",
        "assert_no_test_edits",
    ]
    indices = [_stmt_index(run_sssf_ast, name) for name in order]
    assert indices == sorted(indices), [
        (n, i) for n, i in zip(order, indices, strict=True)
    ]
    last_check = indices[-1]
    for terminal in ("_write_result", "_print_run_summary"):
        assert _last_stmt_index(run_sssf_ast, terminal) > last_check, terminal
    # The early-exit row is written BEFORE the agent could run, so a failed
    # precheck can never be published with a prediction attached.
    assert _stmt_index(run_sssf_ast, "_write_result") < _stmt_index(
        run_sssf_ast, "lock_test_files"
    )


def test_the_capture_is_pinned_to_the_manifests_base_commit(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """A branch name is a mutable pointer the arm's own commits can move — and the
    ADW makes three commits as it goes. ``tox-3931`` lost a correct patch exactly
    this way."""
    src = ast.unparse(run_sssf_ast)
    assert "expected_base_commit=str(inst.get('base_commit') or '')" in src
    assert "integrity=diff_integrity" in src


def test_the_new_arms_cannot_destroy_another_arms_artifacts(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """``_reset_run_artifacts`` wipes the run dir at the top of every run, so the
    run directories must be keyed by arm."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    factory_dir = A._run_dir("inst-1", "factory")
    corpus = factory_dir / "root" / "state" / "events" / "prompt_bodies.ndjson"
    corpus.parent.mkdir(parents=True, exist_ok=True)
    corpus.write_text('{"persona": "reviewer"}\n', encoding="utf-8")
    dirs = {arm: A._run_dir("inst-1", arm) for arm in _ARMS_UNDER_TEST}
    assert len(set(dirs.values())) == len(_ARMS_UNDER_TEST)
    for arm, d in dirs.items():
        assert d != factory_dir, arm
        (d / "result.json").write_text("{}", encoding="utf-8")
    for arm in _ARMS_UNDER_TEST:
        A._reset_run_artifacts(dirs[arm])
    assert corpus.is_file(), "an sssf arm wiped the factory arm's reviewer corpus"


def test_the_sssf_artifacts_are_wiped_between_runs(A: Any, tmp_path: Path) -> None:
    """A stale roster beside a fresh result.json would let a reader attribute this
    run's dollars to the previous run's model set."""
    for name in (A._SSSF_ROSTER_NAME, A._SSSF_EVENTS_NAME, A._SSSF_TRAJECTORY_NAME):
        (tmp_path / name).write_text("stale", encoding="utf-8")
    A._reset_run_artifacts(tmp_path)
    for name in (A._SSSF_ROSTER_NAME, A._SSSF_EVENTS_NAME, A._SSSF_TRAJECTORY_NAME):
        assert not (tmp_path / name).exists(), name


# --------------------------------------------------------------------------- #
# 11. the CLI
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_the_cli_routes_the_arm_id_into_the_sssf_driver(
    A: Any, arm: str, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Selected by BASE and called with no arm at all, every sssf arm would have
    run under one roster."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "run_sssf", lambda iid, **kw: seen.update(iid=iid, **kw))
    monkeypatch.setattr(
        sys, "argv", ["swebench_adapter.py", "run", "--instance", "i1", "--arm", arm]
    )
    A.main()
    assert seen["iid"] == "i1"
    assert seen["arm"] == arm
    assert seen["max_steps"] == A._SSSF_PHASE_CAP
    assert seen["timeout_s"]
    assert "probe_plumbing" not in seen


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_the_cli_routes_the_probe_into_the_sssf_driver(
    A: Any, arm: str, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "run_sssf", lambda iid, **kw: seen.update(iid=iid, **kw))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "swebench_adapter.py", "run", "--instance", "i1", "--arm", arm,
            "--probe-plumbing",
        ],
    )
    A.main()
    assert seen == {
        "iid": "i1",
        "arm": arm,
        "max_steps": A._SSSF_PHASE_CAP,
        "timeout_s": seen["timeout_s"],
        "probe_plumbing": True,
    }


def test_the_argparse_choices_include_the_new_arms_without_an_edit(A: Any) -> None:
    import inspect

    main_src = inspect.getsource(A.main)
    assert main_src.count("choices=list(_ARM_NAMES)") >= 3
    for arm in _ARMS_UNDER_TEST:
        assert arm in A._ARM_NAMES


def test_grade_and_audit_can_address_an_sssf_run_dir(A: Any) -> None:
    """The run key is the bare arm id (no ``--model`` is accepted), so ``grade``
    and ``audit`` address the same directory ``run`` wrote."""
    for arm in _ARMS_UNDER_TEST:
        assert A.run_key(arm, None) == arm
        assert A._split_run_key(arm) == (arm, None)


# --------------------------------------------------------------------------- #
# 12. --probe-plumbing must be genuinely free
# --------------------------------------------------------------------------- #


def test_the_probe_never_spawns_the_engine(run_sssf_ast: ast.FunctionDef) -> None:
    """Structural, not behavioural: the Popen call must sit in the ELSE branch of
    the probe test, so there is no path on which a probe reaches a model."""
    popens = [
        n
        for n in ast.walk(run_sssf_ast)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "Popen"
    ]
    assert len(popens) == 1, "one spawn site only"
    guarding = [
        node
        for node in ast.walk(run_sssf_ast)
        if isinstance(node, ast.If)
        and isinstance(node.test, ast.Name)
        and node.test.id == "probe_plumbing"
        and any(popens[0] is c for c in ast.walk(ast.Module(body=node.orelse,
                                                           type_ignores=[])))
    ]
    assert guarding, (
        "the engine spawn is not inside `else:` of `if probe_plumbing:` — a probe "
        "could reach a real model call"
    )
    # And the probe branch itself contains no spawn of any kind.
    probe_body = ast.Module(body=guarding[0].body, type_ignores=[])
    for node in ast.walk(probe_body):
        if isinstance(node, ast.Attribute):
            assert node.attr not in {"Popen", "run", "check_output", "call"}, (
                f"the probe branch calls subprocess.{node.attr}"
            )


def test_a_probe_row_can_never_be_read_as_a_measurement(A: Any) -> None:
    """``classify_run`` buckets it ``run_failed`` unconditionally — before the
    budget check, so a probe that happens to end on its last phase is still a
    failed run and not a budget-exhausted attempt."""
    assert "PLUMBING PROBE" in A._SSSF_PROBE_ERROR
    status, detail = A.classify_run(
        {
            "probe_plumbing": True,
            "error": A._SSSF_PROBE_ERROR,
            "termination": "cost-cap",
            "steps_used": 18,
            "step_cap": 18,
        }
    )
    assert status == A._RUN_FAILED
    assert "PLUMBING PROBE" in (detail or "")


def test_a_probe_is_not_counted_as_an_attempt_at_the_task(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Using the FREE check must not make every later row look like a re-roll —
    the report flags any attempt > 1 as a protocol violation."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    A._write_result("i1", "chain", {"arm": "chain", "probe_plumbing": True})
    assert json.loads((A._run_dir("i1", "chain") / "result.json").read_text())["attempt"] == 0
    A._write_result("i1", "chain", {"arm": "chain", "probe_plumbing": False})
    assert json.loads((A._run_dir("i1", "chain") / "result.json").read_text())["attempt"] == 1


# --------------------------------------------------------------------------- #
# 13. the probe, end to end, against a real git tree — $0 and no model
# --------------------------------------------------------------------------- #


@pytest.fixture
def fake_instance(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """A real git repository at a real base commit, and the instance that pins it.

    Built once so the base commit sha is a fact the monkeypatched ``_clone`` can
    reproduce by copying, which is what lets ``_capture_diff``'s
    ``expected_base_commit`` path be exercised for real.
    """
    src = tmp_path_factory.mktemp("origin") / "repo"
    src.mkdir()

    def git(*args: str) -> None:
        subprocess.run(
            ["git", "-C", str(src), *args], check=True, capture_output=True
        )

    git("init", "-q")
    git("config", "user.email", "bench@example.invalid")
    git("config", "user.name", "swebench adapter")
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
        check=True, capture_output=True, text=True,
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


@requires_bench_host
def test_the_probe_runs_the_whole_pipeline_for_zero_dollars(
    A: Any,  # noqa: N803
    fake_instance: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """THE headline probe test: clone, prepare, precheck, roster synthesis and
    validation, the three-commit tree shape a real ADW leaves, the diff capture
    across those commits, both diff buckets, and the ``result.json`` write — with
    no model call and no engine process anywhere.

    Everything stubbed here is stubbed because it needs docker or the network, and
    each stub is recorded so the test cannot silently stop exercising a stage.
    """
    inst = fake_instance["inst"]
    src = fake_instance["src"]
    ran: list[str] = []

    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_work_root", lambda: tmp_path / "work")
    monkeypatch.setattr(A, "_SSSF_SHARED_DB", tmp_path / "runs" / "sssf-bench.db")
    monkeypatch.setattr(A, "_instance", lambda i: inst)
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "923aef05add32124"})
    monkeypatch.setattr(
        A, "_assert_oracle_store_complete", lambda insts: ran.append("oracle-store")
    )
    monkeypatch.setattr(
        A, "_ensure_image", lambda *a, **k: bool(ran.append("ensure-image")) or True
    )

    def _clone(instance: dict[str, Any], dest: Path) -> None:
        ran.append("clone")
        shutil.copytree(src, dest)

    monkeypatch.setattr(A, "_clone", _clone)
    monkeypatch.setattr(
        A, "_prepare_cloned_tree", lambda *a, **k: ran.append("prepare") and None
    )
    monkeypatch.setattr(
        A,
        "_precheck_collect",
        lambda instance, repo: (
            ran.append("precheck")
            or {"collect_ok": True, "duration_s": 0.1, "mode": "existing-targets",
                "collected_targets": ["tests/test_thing.py"], "exit_code": 0,
                "tail": "1 passed"}
        ),
    )

    A.run_sssf("acme__widget-1", arm="chain", max_steps=18, timeout_s=900,
               probe_plumbing=True)

    assert ran == [
        "oracle-store", "ensure-image", "clone", "prepare", "precheck"
    ], ran

    run_dir = A._run_dir("acme__widget-1", "chain")
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))

    # --- the row is fail-closed and unmistakable -----------------------------
    assert result["arm"] == "chain", "must equal the run-dir name or _report_rows refuses it"
    assert result["probe_plumbing"] is True
    assert result["error"] == A._SSSF_PROBE_ERROR
    assert A.classify_run(result)[0] == A._RUN_FAILED
    assert result["cost_usd"] == 0.0
    assert result["tokens_in"] == 0 and result["tokens_out"] == 0
    assert result["cached_input_tokens"] == 0
    assert result["persona_calls"] == 0
    assert result["factory_says_green"] is False
    assert result["green_state"] == A._SSSF_GREEN_CHAIN
    assert result["attempt"] == 0

    # --- every key the report and the classifier require --------------------
    for key in (
        "manifest_sha256", "factory_says_green", "error", "cost_usd", "tokens_in",
        "tokens_out", "termination", "steps_used", "step_cap",
    ):
        assert key in result, key
    assert result["manifest_sha256"] == "923aef05add32124"
    assert result["step_cap"] == 18

    # --- the diff, captured ACROSS THREE COMMITS plus a dirty tree ----------
    assert result["files_changed"] == [A._SSSF_PROBE_FILE]
    assert sorted(result["sssf_paths_excluded"]) == [
        f"app_docs/{result['sssf_adw_id']}.md",
        f"specs/{result['sssf_adw_id']}_plan.md",
    ]
    assert result["test_files_stripped"] == ["test_swebench_sssf_plumbing_probe.py"]
    assert result["diff_bytes"] > 0
    prediction = (run_dir / "prediction.diff").read_text(encoding="utf-8")
    assert A._SSSF_PROBE_FILE in prediction
    for excluded in result["sssf_paths_excluded"]:
        assert excluded not in prediction
    assert "test_swebench_sssf_plumbing_probe.py" not in prediction
    # the uncommitted line proves the capture is not staged-only
    assert "one uncommitted line" in prediction
    # ...and the raw capture DOES contain everything, so the split is what removed it
    raw = (run_dir / "raw.diff").read_text(encoding="utf-8")
    for excluded in result["sssf_paths_excluded"]:
        assert excluded in raw
    assert result["diff_integrity"]["trustworthy"] is True
    assert result["diff_integrity"]["expected_resolves"] is True

    # --- provenance ---------------------------------------------------------
    roster_on_disk = yaml.safe_load(
        (run_dir / A._SSSF_ROSTER_NAME).read_text(encoding="utf-8")
    )
    assert roster_on_disk["skip_phases"] == ["documenter"]
    assert [a["name"] for a in roster_on_disk["agents"]] == [
        "planner", "builder", "reviewer",
    ]
    assert result["sssf_roster"] == A._SSSF_ROSTERS["chain"]
    assert result["sssf_roster_sha256"] == hashlib.sha256(
        (run_dir / A._SSSF_ROSTER_NAME).read_bytes()
    ).hexdigest()
    assert result["sssf_skip_phases"] == ["documenter"]
    assert result["sssf_roles_skipped"] == ["documenter"]
    assert result["price_table"]["matches_pinned"] is True
    assert set(result["price_table"]["rates"]) == {A._SSSF_CHEAP, A._SSSF_STRONG}
    assert result["sssf_caps"]["run_cost_cap_usd"] == A._SSSF_RUN_COST_CAP_USD
    assert result["sssf_caps"]["wall_clock_cap_s"] == 900
    assert result["cost_source"] == "derived-from-price-table"

    # --- the prompt is on disk and IS the shared template, byte for byte ----
    # Reconstructed from the template plus the command the story itself carries, so
    # the assertion is "these bytes are _STORY_TEMPLATE rendered with this
    # instance", not a restatement of how the command happens to be built.
    story = (run_dir / "sssf-prompt.md").read_text(encoding="utf-8")
    embedded_command = story.split("```\n", 1)[1].split("\n```", 1)[0]
    assert story == A._STORY_TEMPLATE.format(
        instance_id="acme__widget-1",
        statement=inst["problem_statement"],
        test_command=embedded_command,
    )
    assert "acme__widget-1" in story and "f() must return 2." in story
    # ...and the command it carries is the real docker one-liner every arm gets.
    assert "docker run" in embedded_command and "pytest" in embedded_command
    assert "tests/test_thing.py" in embedded_command
    # The prompt names no model, no roster and no arm: three arms, one task text.
    for leak in ("gpt-5.4", "DeepSeek", "chain", "planner", "reviewer", "skip_phases"):
        assert leak not in story, leak

    # --- the trajectory says, in writing, that nothing ran ------------------
    traj = (run_dir / A._SSSF_TRAJECTORY_NAME).read_text(encoding="utf-8")
    assert "the sssf ADW was NOT invoked" in traj
    assert "commit_plan" in traj and "dirty_worktree" in traj
    # No shared db was created, because no engine ran.
    assert not (tmp_path / "runs" / "sssf-bench.db").exists()

    out = capsys.readouterr().out
    assert "chain arm" in out
    assert "roles that ran" in out


def test_the_capture_spans_the_adws_intermediate_commits(
    A: Any, fake_instance: dict[str, Any], tmp_path: Path  # noqa: N803
) -> None:
    """The ADW COMMITS AS IT GOES — ``commit_plan``, ``commit_build``,
    ``commit_docs`` — so the graded diff has to be taken against the manifest's
    base commit, not against the index.

    Demonstrated by contrast rather than asserted: a staged-only capture
    (``git diff --cached``, the fallback ``_capture_diff`` uses when nothing else
    resolves) sees ONLY the work that is still uncommitted, and would score three
    committed phases as nothing. This is the ``tox-3931`` failure class — a correct
    patch published as ``empty_patch`` — with commits instead of a moved ref.
    """
    src, inst = fake_instance["src"], fake_instance["inst"]
    repo = tmp_path / "repo"
    shutil.copytree(src, repo)
    base = inst["base_commit"]

    A._sssf_probe_tree(repo, "deadbeef")

    # What a staged-only capture would have seen, after the same `git add -A`.
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, capture_output=True)
    staged = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached"],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "specs/" not in staged, "the fixture no longer commits its plan phase"
    assert "app_docs/" not in staged

    integrity: dict[str, Any] = {}
    raw = A._capture_diff(repo, expected_base_commit=base, integrity=integrity)

    # THE tox-3931 SHAPE, REPRODUCED ON PURPOSE. The ADW commits onto the branch it
    # was handed, and that branch IS ``swebench-base`` — so the base REF moves with
    # the arm's own commits, and `git diff swebench-base` compares the work against a
    # ref that already contains it. That is byte-for-byte the failure that scored a
    # correct patch as "the arm produced nothing".
    #
    # It is survivable here for exactly one reason: ``_capture_diff`` diffs against
    # the manifest's immutable SHA first and only falls back to the branch name. This
    # assertion is the proof that these arms depend on that, so nobody "simplifies"
    # the capture back to the branch name.
    assert integrity["base_ref_matches"] is False, (
        "the base ref did NOT move — this test no longer reproduces the condition "
        "the sssf arms actually run under"
    )
    assert integrity["head_is_base"] is True  # it moved all the way to HEAD
    assert integrity["base_ref_ahead_of_expected"] == 3  # the ADW's three commits
    # ...and the capture is still complete and still trusted, because the immutable
    # sha resolves in this tree.
    assert integrity["expected_resolves"] is True
    assert integrity["trustworthy"] is True
    for path in (
        "specs/deadbeef_plan.md",
        A._SSSF_PROBE_FILE,
        "test_swebench_sssf_plumbing_probe.py",
        "app_docs/deadbeef.md",
    ):
        assert path in raw, f"{path} was lost by the commit-spanning capture"
    assert "one uncommitted line" in raw
    assert len(raw) > len(staged)

    excluded: list[str] = []
    code, kept, stripped = A.split_diff(
        raw, exclude_prefixes=A._SSSF_EXCLUDED_PREFIXES, excluded=excluded
    )
    assert kept == [A._SSSF_PROBE_FILE]
    assert stripped == ["test_swebench_sssf_plumbing_probe.py"]
    assert sorted(excluded) == ["app_docs/deadbeef.md", "specs/deadbeef_plan.md"]
    A.assert_no_test_edits(code)


@pytest.mark.parametrize("arm", _ARMS_UNDER_TEST)
def test_the_probe_writes_a_gradeable_row_for_every_arm(
    A: Any,  # noqa: N803
    arm: str,
    fake_instance: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All three arms must reach a complete row, and the two solo arms must record
    the WEAKER green claim."""
    inst = fake_instance["inst"]
    src = fake_instance["src"]
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_work_root", lambda: tmp_path / "work")
    monkeypatch.setattr(A, "_SSSF_SHARED_DB", tmp_path / "runs" / "sssf-bench.db")
    monkeypatch.setattr(A, "_instance", lambda i: inst)
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "923aef05add32124"})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda insts: None)
    monkeypatch.setattr(A, "_ensure_image", lambda *a, **k: True)
    monkeypatch.setattr(A, "_clone", lambda i, dest: shutil.copytree(src, dest))
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda *a, **k: None)
    monkeypatch.setattr(
        A, "_precheck_collect",
        lambda i, r: {"collect_ok": True, "tail": "", "exit_code": 0, "mode": "m",
                      "collected_targets": [], "duration_s": 0.0},
    )
    A.run_sssf("acme__widget-1", arm=arm, max_steps=18, timeout_s=600,
               probe_plumbing=True)
    run_dir = A._run_dir("acme__widget-1", arm)
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert result["arm"] == arm
    # DERIVED FROM THE ROSTER, never from the arm id: the two arms that route a
    # reviewer make the stronger claim, the solo arms the weaker one.
    assert result["green_state"] == (
        A._SSSF_GREEN_CHAIN
        if A._SSSF_ROSTERS[arm]["reviewer"]
        else A._SSSF_GREEN_TESTS
    )
    assert result["files_changed"] == [A._SSSF_PROBE_FILE]
    # Two of the three _ROW_ARTIFACTS exist after a run; `audit` writes the third.
    for name in ("result.json", "prediction.diff"):
        assert (run_dir / name).is_file(), name
    assert A._ROW_ARTIFACTS == ("result.json", "audit.json", "prediction.diff")


# --------------------------------------------------------------------------- #
# 14. audit — without it, every table refuses the row
# --------------------------------------------------------------------------- #


def _row(A: Any, **over: Any) -> dict[str, Any]:  # noqa: N803
    base = {
        "arm": "chain",
        "cost_usd": 1.75,
        "tokens_in": 350,
        "tokens_out": 35,
        "cached_input_tokens": 0,
        "persona_calls": 3,
        "sssf_roster": dict(A._SSSF_ROSTERS["chain"]),
        "price_table": {"sha256": "x" * 64, "matches_pinned": True,
                        "rates": {"azure/gpt-5.4": {}}},
    }
    return base | over


def _events_file(dir_path: Path) -> Path:
    dir_path.mkdir(parents=True, exist_ok=True)
    path = dir_path / "sssf-events.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "agent_start", "name": "builder",
                            "payload": {"model": "azure/DeepSeek-V3.2"}}),
                _agent_end("builder", input_tokens=300, output_tokens=30,
                           total_tokens=330, total_cost=1.5),
                json.dumps({"type": "agent_start", "name": "reviewer",
                            "payload": {"model": "azure/gpt-5.4"}}),
                _agent_end("reviewer", input_tokens=50, output_tokens=5,
                           total_tokens=55, total_cost=0.25),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def test_the_audit_certifies_the_row_against_the_engines_own_trace(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    _events_file(tmp_path)
    failures, warnings, (cost, tin, tout) = A._audit_sssf_run(
        tmp_path, _row(A), True, "chain"
    )
    assert failures == [], failures
    # A PRE-SPLIT row: it publishes the events figures directly and carries no
    # per-turn digest, so it is certified the old way — and the audit says out
    # loud that its dollars can no longer be re-summed from anything, because the
    # streams they came from live in a work dir the next attempt deletes.
    assert any(A._SSSF_TURNS_NAME in w for w in warnings), warnings
    assert (cost, tin, tout) == (pytest.approx(1.75), 350, 35)


def test_the_audit_fails_a_row_whose_numbers_disagree_with_the_trace(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The whole point of an audit: a published number that is not what the run's
    own trace says it spent must not be laundered into a headline."""
    _events_file(tmp_path)
    failures, _w, _t = A._audit_sssf_run(
        tmp_path, _row(A, cost_usd=0.10, tokens_out=99999), True, "chain"
    )
    assert any("cost_usd mismatch" in f for f in failures), failures
    assert any("tokens_out mismatch" in f for f in failures), failures


def test_the_audit_fails_a_row_whose_roles_are_not_in_its_roster(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """A ``gpt54-solo`` row whose trace contains a reviewer is not a measurement
    of ``gpt54-solo``, however clean everything else looks."""
    _events_file(tmp_path)
    row = _row(
        A,
        arm="gpt54-solo",
        sssf_roster=dict(A._SSSF_ROSTERS["gpt54-solo"]),
        cost_usd=1.75, tokens_in=350, tokens_out=35,
    )
    failures, _w, _t = A._audit_sssf_run(tmp_path, row, True, "gpt54-solo")
    assert any("role integrity" in f for f in failures), failures
    assert any("reviewer" in f for f in failures)


def test_the_audit_fails_a_row_that_cannot_say_what_rates_it_used(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Every dollar is DERIVED from the price table, so a row without it can never
    be re-derived or checked against a later price change."""
    _events_file(tmp_path)
    failures, _w, _t = A._audit_sssf_run(
        tmp_path, _row(A, price_table=None), True, "chain"
    )
    assert any("price_table hash" in f for f in failures), failures
    failures, _w, _t = A._audit_sssf_run(
        tmp_path,
        _row(A, price_table={"sha256": "y" * 64, "matches_pinned": True, "rates": {}}),
        True,
        "chain",
    )
    assert any("no rate block" in f for f in failures), failures


def test_a_changed_price_table_is_a_warning_not_a_failure(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The row's dollars are still re-derivable from the rates it recorded — but
    rows either side of the change are not directly comparable, and that has to be
    said out loud."""
    _events_file(tmp_path)
    failures, warnings, _t = A._audit_sssf_run(
        tmp_path,
        _row(A, price_table={"sha256": "z" * 64, "sha256_pinned": "a" * 64,
                             "matches_pinned": False, "rates": {"m": {}}}),
        True,
        "chain",
    )
    assert failures == []
    assert any("price table has changed" in w for w in warnings), warnings


def test_a_missing_trace_is_a_warning_here_and_fail_closed_in_the_probe_scan(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Fail-closed, the same way the bare arm's missing command log is: an arm
    that reports model calls but left no scannable trail cannot be cleared of
    oracle access."""
    failures, warnings, totals = A._audit_sssf_run(tmp_path, _row(A), True, "chain")
    assert failures == []
    assert any(A._SSSF_EVENTS_NAME in w for w in warnings)
    assert totals == (0.0, 0, 0)

    probe_failures, _traj, trails = A._scan_oracle_probes(
        tmp_path, tmp_path, _row(A), instance_id="i1", arm="chain"
    )
    assert trails == 0
    assert any("left no" in f and A._SSSF_EVENTS_NAME in f for f in probe_failures)


def test_the_trace_is_a_scannable_action_trail(A: Any, tmp_path: Path) -> None:
    """``audit`` turns "reports model calls but scanned zero trails" into a
    failure, so the engine's event log has to count as a trail."""
    _events_file(tmp_path)
    failures, _traj, trails = A._scan_oracle_probes(
        tmp_path, tmp_path, _row(A), instance_id="i1", arm="chain"
    )
    assert trails == 1
    assert failures == []


def test_an_oracle_probe_in_the_trace_invalidates_the_run(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """An arm that went looking for the withheld answer is not a measurement."""
    path = _events_file(tmp_path)
    path.write_text(
        path.read_text(encoding="utf-8")
        + json.dumps(
            {
                "type": "tool_call",
                "name": "bash",
                "payload": {"command": "python -c 'import zlib; "
                                       "print(open(\"bench/swebench/oracle.json.z\"))'"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    failures, _traj, trails = A._scan_oracle_probes(
        tmp_path, tmp_path, _row(A), instance_id="i1", arm="chain"
    )
    assert trails == 1
    assert any("oracle-probe" in f for f in failures), failures


def test_the_audit_reads_the_sssf_state_root_from_the_run_family(A: Any) -> None:
    """Keyed off the runner FAMILY, not the arm id: three arm ids share one base,
    and none of them has a ``root/`` subtree."""
    src = _ADAPTER.read_text(encoding="utf-8")
    assert '_audit_base == "sssf"' in src
    assert 'state_root = run_dir / "root" if _audit_base == "factory" else run_dir' in src
    for arm in _ARMS_UNDER_TEST:
        assert A._ARMS[arm].base == "sssf"


# --------------------------------------------------------------------------- #
# FIX 1 — the phase cap is DERIVED from the limits the row ran under
# --------------------------------------------------------------------------- #


@requires_bench_host
def test_the_harness_states_the_loop_bounds_in_the_roster_it_writes(A: Any) -> None:
    """A limit the row does not state is a limit the row cannot be reproduced under.

    The engine's ``limits:`` defaults are the ENGINE's to change. A roster that
    says nothing about ``fix_loops`` therefore reproduces whatever the engine
    happens to default to on the day it is replayed — which is not necessarily the
    graph this row measured. So the harness writes them explicitly, at the engine's
    current defaults, and the archived roster becomes self-sufficient.
    """
    document = A._sssf_roster_document(
        "chain",
        A._sssf_roster_for("chain"),
        data_dir=Path("/tmp/d"),
        db_path=Path("/tmp/db.sqlite"),
        test_command="pytest -q",
        timeout_s=600,
        skip_where="top-level",
    )
    assert A._SSSF_LIMITS_KEY in document, (
        "the roster must STATE its loop bounds, not inherit them silently"
    )
    stated = document[A._SSSF_LIMITS_KEY]
    assert set(stated) == {
        "fix_loops",
        "revision_loops",
        "agent_retries",
        "json_fix_attempts",
    }
    # And it is what the engine's own config model reads, at its own defaults —
    # so stating them changes no graph.
    engine_defaults = _engine_default_limits(A)
    for key, value in engine_defaults.items():
        assert stated[key] == value, (
            f"the harness writes {key}={stated[key]} but the engine defaults to "
            f"{value}; if that divergence is intended, say so in _SSSF_LIMITS"
        )
    # The synthesised document must still satisfy the engine's own validator.
    assert A._sssf_validate_roster(document, A._sssf_roster_for("chain")) is None


@pytest.mark.parametrize(
    ("limits", "expected"),
    [
        # The engine's defaults: 4 + 2*3 + (2*2-1) + 1 + 4 = 18, the number the
        # cap used to be a bare constant for.
        ({"fix_loops": 3, "revision_loops": 2}, 18),
        # A roster that gives the builder five repair passes legitimately emits
        # four more phases. Under the old constant this healthy run was flagged as
        # "the graph changed under us".
        ({"fix_loops": 5, "revision_loops": 2}, 22),
        # And one that reviews three times emits two more.
        ({"fix_loops": 3, "revision_loops": 3}, 20),
        # The floors the engine permits.
        ({"fix_loops": 1, "revision_loops": 1}, 12),
    ],
)
def test_the_cap_is_a_function_of_the_limits_not_a_constant(
    A: Any, limits: dict[str, int], expected: int
) -> None:
    assert A._sssf_phase_cap(limits) == expected


def test_the_retry_limits_do_not_widen_the_phase_budget(A: Any) -> None:
    """``agent_retries`` and ``json_fix_attempts`` are retries INSIDE one phase — a
    re-entered agent session, a re-parsed response. They buy turns and dollars but
    never open a second ``phase_start``, so a cap derived from them would be a
    budget the graph cannot spend."""
    base = A._sssf_phase_cap({"fix_loops": 3, "revision_loops": 2})
    for key in ("agent_retries", "json_fix_attempts"):
        assert (
            A._sssf_phase_cap({"fix_loops": 3, "revision_loops": 2, key: 9}) == base
        ), f"{key} must not move the phase cap"


def test_the_named_default_is_the_formula_evaluated_at_the_defaults(A: Any) -> None:
    """``ArmSpec.max_steps`` is built at import time, before any roster exists, so
    it needs a static number. It must come through the SAME formula, or the
    registry and the per-run budget can disagree about the arithmetic as well as
    about the limits."""
    assert A._SSSF_PHASE_CAP == A._sssf_phase_cap(A._SSSF_LIMITS)
    for arm in _ARMS_UNDER_TEST:
        assert A._ARMS[arm].max_steps == A._SSSF_PHASE_CAP


def test_the_effective_cap_prefers_the_derivation_but_obeys_an_override(A: Any) -> None:
    """``_resolve_max_steps`` hands ``run_sssf`` the registry default when nobody
    overrode it, so "requested == the registry default" IS "nobody overrode this"
    and the derived value is the better answer. An explicit ``--max-steps`` must
    still win: a harness that quietly ignored it would enforce a bound the command
    line did not ask for."""
    wide = {**A._SSSF_LIMITS, "fix_loops": 5}
    cap, source = A._sssf_effective_phase_cap(A._SSSF_PHASE_CAP, wide)
    assert cap == A._sssf_phase_cap(wide) == 22
    assert "derived" in source and "fix_loops=5" in source

    cap, source = A._sssf_effective_phase_cap(7, wide)
    assert cap == 7, "an explicit budget must win"
    assert "explicit" in source and "22" in source, source

    # At the defaults the two agree, which is why this change moves no old row.
    cap, _ = A._sssf_effective_phase_cap(A._SSSF_PHASE_CAP, A._SSSF_LIMITS)
    assert cap == A._SSSF_PHASE_CAP == 18


def test_the_limits_block_is_read_back_from_the_document_not_the_constant(
    A: Any,
) -> None:
    """The budget must come from the bytes handed to the engine. This is the line
    that makes an arm which declares its own ``limits:`` get the right cap without
    a second edit somewhere else."""
    assert A._sssf_limits_of({}) == A._SSSF_LIMITS
    assert A._sssf_limits_of({"limits": {"fix_loops": 5}})["fix_loops"] == 5
    # Junk in the roster must not take a run down; the default stands.
    assert A._sssf_limits_of({"limits": {"fix_loops": "nope"}})["fix_loops"] == (
        A._SSSF_LIMITS["fix_loops"]
    )
    assert A._sssf_limits_of({"limits": "not-a-dict"}) == A._SSSF_LIMITS


def test_run_sssf_derives_its_budget_and_never_reads_the_bare_constant(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """Structural, because the failure this prevents is a future edit reaching for
    ``_SSSF_PHASE_CAP`` again inside the per-run path — where it is exactly the
    stale constant this fix removed."""
    names = [
        n.id for n in ast.walk(run_sssf_ast) if isinstance(n, ast.Name)
    ]
    assert "_SSSF_PHASE_CAP" not in names, (
        "run_sssf must derive its phase budget from the roster's limits, not read "
        "the registry's static default"
    )
    calls = [
        n.func.id
        for n in ast.walk(run_sssf_ast)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    ]
    assert "_sssf_effective_phase_cap" in calls
    assert "_sssf_limits_of" in calls


# --------------------------------------------------------------------------- #
# FIX 2 — a resumed attempt must not be charged for the dead one's phases
# --------------------------------------------------------------------------- #


def _resumed_events(path: Path) -> Path:
    """Two attempts in ONE ``events.jsonl``, exactly as the engine leaves it.

    The tracer's path is keyed by ``adw_id`` alone (``session.ensure``) and a
    resume REUSES the id, so attempt 2 appends. Attempt 2 records the FULL graph
    with the prefix it served from attempt 1 marked ``replayed`` — the keras
    session's seq 1-8 then 9-16 in one file — and continues the sequence rather
    than resetting it.

    Attempt 1: 8 real phases, then a crash.
    Attempt 2: 5 replayed + 3 real = 8 phase_start events, 3 of which cost money.
    """
    lines: list[str] = []

    def config() -> None:
        lines.append(
            json.dumps(
                {
                    "adw_id": "6000935a",
                    "type": "config",
                    "name": "run_config",
                    "payload": {
                        "limits": {
                            "fix_loops": 3,
                            "revision_loops": 2,
                            "agent_retries": 1,
                            "json_fix_attempts": 2,
                        },
                        "skip_phases": ["documenter"],
                    },
                }
            )
        )

    def phase(seq: int, name: str, *, replayed: bool) -> None:
        pid = f"6000935a_{seq:02d}_{name}"
        lines.append(
            json.dumps(
                {
                    "adw_id": "6000935a",
                    "phase_id": pid,
                    "type": "phase_start",
                    "name": name,
                    "payload": {
                        "kind": "agent",
                        "owner": "builder",
                        "description": name,
                        "replayed": replayed,
                    },
                }
            )
        )
        if replayed:
            lines.append(
                json.dumps(
                    {
                        "adw_id": "6000935a",
                        "phase_id": pid,
                        "type": "resume_replay",
                        "name": "builder",
                        "tokens": 0,
                        "payload": {
                            "source_phase_id": f"6000935a_{seq - 8:02d}_{name}",
                            "cost": 0.0,
                            "output_type": "BuildOutput",
                            "summary": "replayed",
                            "artifacts": [],
                        },
                    }
                )
            )
        lines.append(
            json.dumps(
                {
                    "adw_id": "6000935a",
                    "phase_id": pid,
                    "type": "phase_end",
                    "name": name,
                    "payload": {"status": "success"},
                }
            )
        )

    graph = [
        "request", "plan", "commit_plan", "build",
        "test_1", "fix_1", "test_2", "review_1",
    ]
    config()
    for i, name in enumerate(graph, start=1):
        phase(i, name, replayed=False)
    # ---- attempt 2: a new process, so a new config event, then the full graph --
    config()
    for i, name in enumerate(graph, start=9):
        phase(i, name, replayed=(i - 9) < 5)

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_a_resumed_attempt_counts_only_the_phases_it_actually_bought(
    A: Any, tmp_path: Path
) -> None:
    """THE BUG: ``_sssf_phase_count`` counted every ``phase_start`` in the file. A
    resumed attempt APPENDS to the prior attempt's log, so the count included dead
    attempts, overflowed ``step_cap`` and flagged a good row — or, mid-run, made
    ``run_sssf`` kill it for a "phase cap exceeded" it had not exceeded.

    16 ``phase_start`` events are in this file. 8 belong to a dead attempt and 5 of
    the survivors were replayed from it at $0. THREE cost money.
    """
    events = A._sssf_read_events(_resumed_events(tmp_path / "events.jsonl"))
    assert sum(1 for e in events if e.get("type") == "phase_start") == 16, (
        "the fixture must really contain both attempts"
    )
    assert A._sssf_phase_count(events) == 3
    assert A._sssf_replayed_phase_count(events) == 5
    assert A._sssf_attempt_count(events) == 2
    # ... and the count must be under the cap, which is the point: 16 > 18 is
    # false only by luck, and 8 + 8 phases of a wider graph would not be.
    assert A._sssf_phase_count(events) <= A._SSSF_PHASE_CAP


def test_a_first_attempt_is_unaffected(A: Any, tmp_path: Path) -> None:
    """The fix must not cost the single-attempt case anything: one ``config``
    event, no replays, every phase counted."""
    path = tmp_path / "events.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "config", "name": "run_config",
                            "payload": {"limits": {"fix_loops": 3}}}),
                json.dumps({"type": "phase_start", "name": "request",
                            "payload": {"replayed": False}}),
                json.dumps({"type": "phase_start", "name": "plan",
                            "payload": {"replayed": False}}),
                json.dumps({"type": "phase_end", "name": "plan",
                            "payload": {"status": "success"}}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    events = A._sssf_read_events(path)
    assert A._sssf_phase_count(events) == 2
    assert A._sssf_replayed_phase_count(events) == 0
    assert A._sssf_attempt_count(events) == 1


def test_a_trace_with_no_config_marker_is_read_whole(A: Any, tmp_path: Path) -> None:
    """An older engine emitted neither ``config`` nor ``replayed``. Reading such a
    trace whole is the CORRECT answer for it, not a fallback: the engine version
    that marks replays is the same one that emits the boundary, so a trace missing
    the marker also cannot contain a resumed attempt."""
    path = tmp_path / "events.jsonl"
    path.write_text(
        "\n".join(
            json.dumps({"type": t, "name": n})
            for t, n in [("phase_start", "request"), ("phase_start", "plan")]
        )
        + "\n",
        encoding="utf-8",
    )
    events = A._sssf_read_events(path)
    assert A._sssf_attempt_count(events) == 0, "absent is not the same as one"
    assert A._sssf_phase_count(events) == 2


def test_the_engines_own_limits_are_read_back_as_a_cross_check(
    A: Any, tmp_path: Path
) -> None:
    """``SSSFConfig.snapshot`` is written into the ``config`` event, so the engine
    states the graph shape it actually ran. Recorded beside the harness's copy and
    never merged with it: a disagreement means the engine did not honour the
    roster, and that is a finding rather than a number to average."""
    events = A._sssf_read_events(_resumed_events(tmp_path / "events.jsonl"))
    assert A._sssf_engine_limits(events) == {
        "fix_loops": 3,
        "revision_loops": 2,
        "agent_retries": 1,
        "json_fix_attempts": 2,
    }
    assert A._sssf_engine_limits([]) is None


def test_the_replay_flag_is_read_from_the_payload_the_engine_writes(A: Any) -> None:
    """``runner.Run.phase`` writes ``payload.replayed`` on every ``phase_start``
    (the same boolean it stores in the ``phases.replayed`` column). Absent means
    False — an older engine's row is a real phase, not a replayed one."""
    assert A._sssf_event_replayed({"payload": {"replayed": True}}) is True
    assert A._sssf_event_replayed({"payload": {"replayed": False}}) is False
    assert A._sssf_event_replayed({"payload": {}}) is False
    assert A._sssf_event_replayed({}) is False


# --------------------------------------------------------------------------- #
# FIX 3 — a plumbing abort is not a capability failure; an agent's abort is
# --------------------------------------------------------------------------- #

_CRASH_LOG = """\
▶ 06 plan  agent · planner  Turn the request into an implementable plan
  ✗ plan 149.4s  'str' object has no attribute 'get'
Traceback (most recent call last):
  File "/home/k/sssf/adws/adw_simple_sdlc.py", line 221, in <module>
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
  File "/home/k/sssf/adws/adw_modules/agent_pi.py", line 315, in run
    if event.get("type") == "message_end":
       ^^^^^^^^^
AttributeError: 'str' object has no attribute 'get'
"""

_BREACH_LOG = """\
▶ 18 plan  agent · planner  Turn the request into an implementable plan
Traceback (most recent call last):
  File "/home/k/sssf/adws/adw_simple_sdlc.py", line 221, in <module>
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
  File "/home/k/sssf/adws/adw_modules/permissions.py", line 282, in enforce
    raise PermissionBreach(
adw_modules.permissions.PermissionBreach: planner is limited to ['specs/'] but \
modified 18 path(s):
  - add_map_print.py — deleted
  - test_fix.py — deleted
"""


def _crash_events() -> list[dict[str, Any]]:
    """montepy's trace: ONE generic error event, ``name`` == the phase name, a
    payload whose only key is ``error``. No cause label anywhere, because nothing
    decided this — the engine fell over."""
    return [
        {"type": "config", "name": "run_config", "payload": {"limits": {}}},
        {"type": "phase_start", "name": "plan", "phase_id": "dbe9e440_06_plan",
         "payload": {"kind": "agent", "owner": "planner", "replayed": False}},
        {"type": "error", "name": "plan", "phase_id": "dbe9e440_06_plan",
         "payload": {"error": "'str' object has no attribute 'get'"}},
        {"type": "phase_end", "name": "plan", "phase_id": "dbe9e440_06_plan",
         "payload": {"status": "fail"}},
    ]


def _breach_events() -> list[dict[str, Any]]:
    """keras's trace: the engine's own LABELLED event (``agents.execute`` emits
    ``permission_breach`` with ``agent``/``writes``/``protected_files`` and
    re-raises), followed by the generic one carrying the identical message under
    the PHASE's name — which is precisely why message text cannot classify this."""
    msg = "planner is limited to ['specs/'] but modified 18 path(s):\n  - x.py — deleted"
    return [
        {"type": "config", "name": "run_config", "payload": {"limits": {}}},
        {"type": "phase_start", "name": "plan", "phase_id": "6000935a_18_plan",
         "payload": {"kind": "agent", "owner": "planner", "replayed": False}},
        {"type": "gate_pass", "name": "artifacts_exist",
         "phase_id": "6000935a_18_plan", "payload": {}},
        {"type": "error", "name": "permission_breach",
         "phase_id": "6000935a_18_plan",
         "payload": {"agent": "planner", "error": msg, "writes": ["specs/"],
                     "protected_files": []}},
        {"type": "error", "name": "plan", "phase_id": "6000935a_18_plan",
         "payload": {"error": msg}},
        {"type": "phase_end", "name": "plan", "phase_id": "6000935a_18_plan",
         "payload": {"status": "fail"}},
    ]


def test_an_unhandled_engine_exception_is_refused_from_every_rate(A: Any) -> None:
    """``idaholab__montepy-933_interface``: ``plan -> fail ERR:'str' object has no
    attribute 'get'`` — an ``AttributeError`` inside the engine's own stream
    reader. The planner never got to decide anything, so the arm was never asked
    the question and the row is not a capability result on EITHER side of a rate.
    """
    got = A._sssf_failure_classification(_crash_events(), _CRASH_LOG)
    assert got["kind"] == "engine_crash"
    assert got["counted"] is False
    assert "AttributeError" in got["reason"]
    # The evidence, so the verdict is re-derivable from the archived row.
    assert got["evidence"]["traceback"]["exception"] == "AttributeError"
    assert "agent_pi.py" in got["evidence"]["traceback"]["frame"]


def test_a_writes_scope_breach_stays_counted_under_its_own_reason(A: Any) -> None:
    """``keras-team__keras-22316``: the PLANNER wrote 18 paths outside its declared
    ``writes`` scope and ``permissions.enforce`` refused the run. That is the
    agent's own behaviour, and behaviour is what the arm is measured on — so it
    stays COUNTED, and gets its own reason so it can be re-classified later from
    the record instead of by re-running it."""
    got = A._sssf_failure_classification(_breach_events(), _BREACH_LOG)
    assert got["kind"] == "writes_scope_breach"
    assert got["counted"] is True
    assert "specs/" in got["reason"]
    assert got["evidence"]["abort_events"][0]["name"] == "permission_breach"
    assert got["evidence"]["abort_events"][0]["payload"]["writes"] == ["specs/"]


def test_the_two_failures_are_not_the_same_verdict(A: Any) -> None:
    """The point of the whole fix: these two rows were BOTH in the chain arm's
    denominator as ``empty_patch``, and every field of ``result.json`` that a
    reader could have used to tell them apart was identical."""
    crash = A._sssf_failure_classification(_crash_events(), _CRASH_LOG)
    breach = A._sssf_failure_classification(_breach_events(), _BREACH_LOG)
    assert crash["kind"] != breach["kind"]
    assert crash["counted"] is not breach["counted"]


def test_the_classification_is_structural_not_a_message_match(A: Any) -> None:
    """Two proofs that this is not string-matching one message:

    1. the breach is recognised from the engine's LABELLED event alone, with the
       message text replaced by something unrecognisable;
    2. the crash is recognised from the exception CLASS, with a message this
       harness has never seen.
    """
    events = _breach_events()
    for ev in events:
        if isinstance(ev.get("payload"), dict) and "error" in ev["payload"]:
            ev["payload"]["error"] = "totally different wording"
    got = A._sssf_failure_classification(events, "")
    assert got["kind"] == "writes_scope_breach", "the engine's LABEL is the signal"

    novel = _CRASH_LOG.replace(
        "AttributeError: 'str' object has no attribute 'get'",
        "KeyError: 'some_field_nobody_has_seen'",
    )
    got = A._sssf_failure_classification(_crash_events(), novel)
    assert got["kind"] == "engine_crash", "the exception CLASS is the signal"


def test_a_deliberate_engine_refusal_is_not_called_a_crash(A: Any) -> None:
    """The engine raises on purpose all the time — a failed gate, an envelope that
    will not parse, a SIGTERM from this harness's own kill. "There is a traceback"
    is therefore NOT a crash signal: the breach case has one too."""
    for exc, tail in [
        ("GateFailure", "adw_modules.agents.GateFailure: gate diff_matches_claims"),
        ("ValueError", "ValueError: no JSON object found in the response"),
        ("SystemExit", "SystemExit: 143"),
    ]:
        log = _CRASH_LOG.replace(
            "AttributeError: 'str' object has no attribute 'get'", tail
        )
        got = A._sssf_failure_classification(_crash_events(), log)
        assert got["kind"] != "engine_crash", f"{exc} is deliberate"
        assert got["counted"] is True


def test_an_unclassified_exception_stays_counted(A: Any) -> None:
    """Fail-closed toward COUNTING. ``classify_run``'s posture is that a flagged
    counted row is safer than a silently dropped one, because a dropped row moves
    a published denominator — so only a NAMED, understood infra class earns the
    exclusion."""
    log = _CRASH_LOG.replace(
        "AttributeError: 'str' object has no attribute 'get'",
        "SomeBrandNewError: who knows",
    )
    got = A._sssf_failure_classification(_crash_events(), log)
    assert got["kind"] == "unclassified_exception"
    assert got["counted"] is True


def test_a_clean_failure_with_no_traceback_classifies_as_nothing(A: Any) -> None:
    """A red verdict the ADW reached on purpose (tests never went green) has no
    traceback and no abort label. It must stay exactly what it was."""
    got = A._sssf_failure_classification(
        [{"type": "config", "payload": {}},
         {"type": "phase_start", "name": "test_3", "payload": {"replayed": False}}],
        "▶ 12 test_3\n  ✗ tests still red\n",
    )
    assert got["kind"] is None
    assert got["counted"] is True


def test_the_last_traceback_wins_over_a_chained_one(A: Any) -> None:
    """Exception chaining emits several tracebacks; the final one is what actually
    killed the process."""
    chained = (
        "Traceback (most recent call last):\n"
        '  File "/home/k/sssf/adws/adw_modules/agents.py", line 1, in x\n'
        "    raise ValueError('first')\n"
        "ValueError: first\n"
        "\n"
        "During handling of the above exception, another exception occurred:\n"
        "\n"
        "Traceback (most recent call last):\n"
        '  File "/home/k/sssf/adws/adw_modules/tracer.py", line 9, in y\n'
        "    row['k']\n"
        "TypeError: string indices must be integers\n"
    )
    tb = A._sssf_traceback_exception(chained)
    assert tb["exception"] == "TypeError"
    assert "tracer.py:9" in tb["frame"]
    assert A._sssf_failure_classification([], chained)["kind"] == "engine_crash"


def test_the_crash_termination_is_refused_the_way_a_starved_row_is(A: Any) -> None:
    """The mechanism, not just the label: ``engine-crash`` is in
    ``_ERROR_TERMINATIONS``, so the step-count fallback cannot re-label it as
    budget-exhausted and hand it back to the denominator it has to stay out of —
    exactly the treatment ``provider-empty-response`` gets."""
    assert A._SSSF_ENGINE_CRASH_TERMINATION in A._ERROR_TERMINATIONS
    row = {"termination": A._SSSF_ENGINE_CRASH_TERMINATION, "error": "engine-crash: …",
           "steps_used": 18, "step_cap": 18}
    assert A.budget_exhausted_reason(row) is None, (
        "a crashed run must not be re-labelled as a cap hit"
    )
    assert A.classify_run(row)[0] == A._RUN_FAILED
    assert A._row_engine_crashed(row) is True

    # A writes-scope breach is deliberately NOT in that set, and carries no
    # ``error``: it must stay a COUNTED failure of the arm.
    breach = {"termination": A._SSSF_WRITES_SCOPE_TERMINATION, "error": None,
              "steps_used": 2, "step_cap": 18}
    assert A._SSSF_WRITES_SCOPE_TERMINATION not in A._ERROR_TERMINATIONS
    assert A.classify_run(breach)[0] == A._RUN_OK
    assert A._row_writes_scope_breach(breach) is True
    assert A._row_engine_crashed(breach) is False


def test_the_row_predicates_derive_from_the_classification_too(A: Any) -> None:
    """A row written before the termination value existed is still recognised from
    its recorded ``sssf_failure_class`` — the derive-don't-trust posture that lets
    an archived row be re-read under the new rule instead of taken on faith."""
    assert A._row_engine_crashed({"sssf_failure_class": "engine_crash"}) is True
    assert (
        A._row_writes_scope_breach({"sssf_failure_class": "writes_scope_breach"})
        is True
    )
    assert A._row_engine_crashed({"sssf_failure_class": "writes_scope_breach"}) is False


def test_the_report_gives_each_failure_its_own_cell_code(A: Any) -> None:
    """`C` excluded and `W` counted, each with its own legend line. Lumping them
    would hide which of two different problems, with two different owners, is
    happening."""
    crash = {"grade": {"oracle_resolved": False, "outcome": "empty_patch"},
             "termination": A._SSSF_ENGINE_CRASH_TERMINATION,
             "_audit_ok": True, "_run_failed": True, "_budget_exhausted": False,
             "_attempt": 1}
    breach = {"grade": {"oracle_resolved": False, "outcome": "empty_patch"},
              "termination": A._SSSF_WRITES_SCOPE_TERMINATION,
              "_audit_ok": True, "_run_failed": False, "_budget_exhausted": False,
              "_attempt": 1}
    plain = {"grade": {"oracle_resolved": False, "outcome": "empty_patch"},
             "termination": "terminal-state",
             "_audit_ok": True, "_run_failed": False, "_budget_exhausted": False,
             "_attempt": 1}
    assert A._outcome_cell(crash) == "C"
    assert A._outcome_cell(breach) == "W"
    assert A._outcome_cell(plain) == "E", "the plain empty patch is unchanged"
    codes = A._outcome_codes([crash, breach])
    assert "`C` engine-crash" in codes
    assert "`W` writes-scope breach" in codes
    assert "COUNTED" in codes


def test_run_sssf_classifies_from_the_artifacts_and_records_the_evidence(
    run_sssf_ast: ast.FunctionDef,
) -> None:
    """Structural: the classification has to be made where the artifacts are still
    on disk and written into the row, because nothing downstream can re-derive it
    from the fields the two rows shared."""
    src = ast.unparse(run_sssf_ast)
    assert "_sssf_failure_classification(" in src
    assert "sssf_failure_class" in src
    assert "sssf_failure_evidence" in src
    # The crash sets an ``error`` (which is what excludes it); the breach must not.
    assert "_SSSF_ENGINE_CRASH_TERMINATION" in src
    assert "_SSSF_WRITES_SCOPE_TERMINATION" in src


# --------------------------------------------------------------------------- #
# the oracle-probe scan must judge ACTIONS, never what the agent was shown
# --------------------------------------------------------------------------- #

def test_a_tool_result_is_not_scanned_for_retrieval_verbs(A: Any) -> None:
    """MEASURED FALSE POSITIVE, 2026-08-14, worth three discarded runs.

    An sssf ``tool_call`` payload carries ``result_snippet`` — up to ~18 KB of the
    tool's OUTPUT. It was absent from ``_ACTION_CONTENT_FIELDS``, so
    ``_command_side_text`` kept it and the retrieval-verb patterns scanned file
    bodies. ``harumiweb__exstruct-113``'s own ``tasks/todo.md`` contains

        - [x] Confirm issue `#107` details with `gh issue view 107`.

    so every arm that merely READ that file was failed for "the arm went looking
    for the answer": ``flash-solo`` attempt 2 and both ``flash-chain`` attempts.
    That is worse than lost data — it excluded one instance for whichever arms
    happened to read the file, which biases a paired comparison.
    """
    seen = {
        "tool": "read",
        "args": {"path": "/work/repo/tasks/todo.md"},
        "ok": True,
        "result_snippet": "- [x] Confirm issue `#107` with `gh issue view 107`.\n"
                          "  see also: curl https://github.com/o/r/pull/9.diff",
        "duration_ms": 12,
        "agent": "builder",
    }
    assert A._retrieval_hits(A._command_side_text(seen)) == [], (
        "a fetch verb inside a tool RESULT is what the agent saw, not what it ran"
    )


def test_a_real_retrieval_command_is_still_caught(A: Any) -> None:
    """The narrowing must not fail open: the args side is still scanned."""
    for command, expected in (
        ("gh issue view 107 --repo harumiweb/exstruct", "gh cli"),
        ("curl -s https://github.com/o/r/pull/9.diff", "curl"),
        ("git fetch origin refs/pull/9/head", "git fetch/pull/ls-remote"),
    ):
        ran = {"tool": "bash", "args": {"command": command}, "result_snippet": "ok"}
        assert expected in A._retrieval_hits(A._command_side_text(ran)), command


def test_oracle_paths_are_still_scanned_over_the_whole_line(A: Any) -> None:
    """Only the retrieval-VERB half was narrowed.

    SEEING answer material is itself the finding, so the oracle/manifest PATH
    patterns keep scanning the entire serialised event — including results.
    """
    import inspect
    src = inspect.getsource(A._scan_oracle_probes)
    assert "_probe_line_hits(line" in src, (
        "the path scan must still read the whole line; narrowing it too would "
        "let an arm read grade.log and pass the audit"
    )
