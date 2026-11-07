"""The ``solo-noreview`` arm — PLAN.md B.1 Phase 1a, the reviewer ablation.

Pre-registration: ``bench/swebench/frozen/PRE-REGISTRATION-B1.md``.

The arm exists to answer ONE question — does removing the reviewer round-trip
change the resolve rate — and it can only answer it if exactly one thing differs
from the ``factory`` arm. This harness has been retracted four times, twice
because two variables moved at once and neither was attributable, and once
specifically because two arms received DIFFERENT PROMPTS. So every test in this
file pins one of those failure modes shut, for $0:

1. **arm parity** — the two chain arms render a byte-identical task, proven
   structurally (the prompt expression has no arm-dependence at all), not by
   eyeballing two strings;
2. **single variable** — the two ``ArmSpec`` rows and the two driver modes differ
   only in the fields the ablation is allowed to move;
3. **the other five arms are untouched** — their registry rows are pinned by a
   hash of their exact tuples;
4. **fail loud** — a chain-driver arm with no mode entry is refused before any
   clone or any spend, rather than silently running the full chain and being
   published as an ablation;
5. **no artifact collision** — the new arm's run directory is its own, so it
   cannot destroy the ``factory`` arm's reviewer replay corpus.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).parent.parent
_ADAPTER = _REPO_ROOT / "bench" / "swebench_adapter.py"

_ARM = "solo-noreview"


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_solo_under_test", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_solo_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


@pytest.fixture(scope="module")
def run_factory_ast() -> ast.FunctionDef:
    tree = ast.parse(_ADAPTER.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "run_factory":
            return node
    raise AssertionError("run_factory is gone")


class _FakeStoryState:
    """Just enough of ``StoryState`` to resolve a driver mode without importing
    the factory package (which ``run_factory`` only puts on ``sys.path`` at run
    time)."""

    class _V:
        def __init__(self, v: str) -> None:
            self.value = v

    REVIEWER_DONE = _V("reviewer_done")
    TESTS_GREEN = _V("tests_green")
    BLOCKED_TESTS_NEED_CLARIFICATION = _V("blocked_tests_need_clarification")
    BLOCKED_REVIEW_NONCONVERGENT = _V("blocked_review_nonconvergent")
    BLOCKED_UNDERSPECIFIED = _V("blocked_underspecified")


# --------------------------------------------------------------------------- #
# 1. arm parity — the invalidating defect, twice retracted
# --------------------------------------------------------------------------- #


def test_the_two_chain_arms_render_a_byte_identical_task(
    A: Any, run_factory_ast: ast.FunctionDef  # noqa: N803
) -> None:
    """Prompt asymmetry between two arms of one comparison invalidates the
    comparison, not just the arm (bare's retracted 0/19).

    Proven STRUCTURALLY rather than by comparing two rendered strings: the story
    file is assembled by exactly one ``_STORY_TEMPLATE.format(...)`` call whose
    arguments come only from the instance and the clone, so there is no
    expression through which the arm id could reach the prompt. A string
    comparison would only prove the two arms agree TODAY; this proves they
    cannot disagree.
    """
    calls = [
        n
        for n in ast.walk(run_factory_ast)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "format"
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == "_STORY_TEMPLATE"
    ]
    assert len(calls) == 1, "the chain driver must assemble its task in ONE place"
    call = calls[0]
    assert sorted(k.arg or "" for k in call.keywords) == [
        "instance_id",
        "statement",
        "test_command",
    ]
    names = {n.id for n in ast.walk(call) if isinstance(n, ast.Name)}
    assert "arm" not in names, (
        "the arm id reaches the rendered task — the two chain arms could be "
        "prompted differently, which is the defect that retracted the bare column"
    )
    # And the rendering is genuinely arm-free: same bytes, whoever asks.
    rendered = A._STORY_TEMPLATE.format(
        instance_id="i", statement="s", test_command="CMD"
    )
    assert A._TEST_POLICY in rendered and A._BASE_TESTS_NOTE in rendered


def test_the_story_write_is_not_inside_a_conditional(
    run_factory_ast: ast.FunctionDef,
) -> None:
    """A prompt behind an ``if`` is one refactor away from being arm-dependent."""
    for node in ast.walk(run_factory_ast):
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


def test_no_arm_conditional_anywhere_in_the_chain_driver(
    run_factory_ast: ast.FunctionDef,
) -> None:
    """The ablation is a TABLE lookup, not a branch.

    Every arm-dependent behaviour must arrive through
    ``_factory_driver_mode``/``_ARMS``; an ``if arm == "..."`` inside the driver
    is how a second, undeclared variable gets in. The one permitted test of
    ``arm`` is the fail-loud registry guard at the top.
    """
    compares = [
        n
        for n in ast.walk(run_factory_ast)
        if isinstance(n, ast.Compare)
        and isinstance(n.left, ast.Name)
        and n.left.id == "arm"
    ]
    assert len(compares) == 1, [ast.unparse(c) for c in compares]
    assert ast.unparse(compares[0]) == "arm not in _FACTORY_DRIVER_MODES"


# --------------------------------------------------------------------------- #
# 2. the single variable
# --------------------------------------------------------------------------- #


def test_the_two_driver_modes_differ_only_in_personas_and_green_state(
    A: Any,  # noqa: N803
) -> None:
    full = A._FACTORY_DRIVER_MODES["factory"]
    solo = A._FACTORY_DRIVER_MODES[_ARM]
    assert full.personas == frozenset({"dev", "review"})
    assert solo.personas == frozenset({"dev"})
    assert full.green_state_attr == "REVIEWER_DONE"
    assert solo.green_state_attr == "TESTS_GREEN"
    # Nothing else is even representable: the mode has exactly two fields.
    assert full._fields == ("personas", "green_state_attr")


def test_the_terminal_blocked_sinks_are_identical_across_the_two_arms(
    A: Any,  # noqa: N803
) -> None:
    """The BLOCKED_* set is deliberately shared. ``BLOCKED_REVIEW_NONCONVERGENT``
    is unreachable without a reviewer, and removing it from one arm would be a
    second difference for no benefit."""
    _, full_terminal, full_green = A._factory_driver_mode("factory", _FakeStoryState)
    _, solo_terminal, solo_green = A._factory_driver_mode(_ARM, _FakeStoryState)
    assert full_green == "reviewer_done"
    assert solo_green == "tests_green"
    assert full_terminal - {full_green} == solo_terminal - {solo_green}
    assert full_terminal - {full_green} == {
        "blocked_tests_need_clarification",
        "blocked_review_nonconvergent",
        "blocked_underspecified",
    }


def test_the_solo_arm_dispatches_dev_only(A: Any) -> None:  # noqa: N803
    allowed, _terminal, _green = A._factory_driver_mode(_ARM, _FakeStoryState)
    assert allowed == {"dev"}
    assert "review" not in allowed


def test_the_two_arm_specs_differ_only_in_identity_fields(A: Any) -> None:  # noqa: N803
    """Same driver family, same budget, same wall clock, same cost basis, same
    trajectory expectation, same chain-verdict capability. Any other difference
    is a second variable in a two-arm comparison."""
    factory = A._ARMS["factory"]
    solo = A._ARMS[_ARM]
    moved = {
        f
        for f in factory._fields
        if getattr(factory, f) != getattr(solo, f)
    }
    assert moved == {"name", "harness", "harness_id"}, moved
    assert solo.base == "factory"
    assert solo.max_steps == factory.max_steps == A._FACTORY_STEP_DEFAULT
    assert solo.has_chain is True
    assert solo.model is None and solo.model_selectable is False


def test_the_solo_arm_has_its_own_harness_id(A: Any) -> None:  # noqa: N803
    """Table 3 keys "harness varies?" off ``harness_id``. Sharing the factory's
    would print "no" and label the pair "nothing — the arms are the same pair",
    i.e. exactly the opposite of what the arm measures."""
    assert A._ARMS[_ARM].harness_id != A._ARMS["factory"].harness_id
    assert "reviewer" in A._ARMS[_ARM].harness.lower()


def test_the_result_row_records_which_green_claim_was_made(
    run_factory_ast: ast.FunctionDef,
) -> None:
    """``factory_says_green`` means two different states in the two arms, so the
    row has to say which one it was — otherwise Table 5's precision column is
    two different quantities under one heading."""
    src = ast.unparse(run_factory_ast)
    assert "'factory_says_green': final.state == green_state" in src
    assert "'green_state': green_state" in src
    assert "'chain_personas': sorted(allowed)" in src
    assert "StoryState.REVIEWER_DONE.value" not in src, (
        "the green state is still hard-coded to the reviewer's terminal state"
    )


# --------------------------------------------------------------------------- #
# 3. the other five arms must be byte-identical in behaviour
# --------------------------------------------------------------------------- #

# sha256 over the exact ``ArmSpec`` tuples of every PUBLISHED arm, in registry
# order. Adding an arm must not perturb one field of another — the published
# columns and the new one would then have been produced under different budgets,
# cost guards or trajectory rules.
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


def test_the_published_arms_are_unchanged(A: Any) -> None:  # noqa: N803
    specs = [A._ARMS[n] for n in _PUBLISHED_ARMS]
    got = hashlib.sha256(repr(specs).encode("utf-8")).hexdigest()
    assert got == _PUBLISHED_ARMS_SHA256, (
        "a published arm's registry row moved. That invalidates the comparison "
        "between the existing columns and any new one; re-run those arms or "
        "revert the change."
    )


def test_the_new_arm_is_registered_after_factory_and_before_the_rest(A: Any) -> None:
    """Registry order decides ``_ARM_NAMES`` and the argparse ``choices`` order.
    Pinned only so the new entry cannot be read as having displaced one.

    Pinned as a PREFIX, not as the whole tuple: this test's job is that
    ``solo-noreview`` sits where it was put and that no arm published before it
    moved. A later arm registered AFTER these seven cannot displace any of them,
    so asserting the full tuple only meant that adding one anywhere in the file
    failed here — which says nothing about this ablation.
    """
    assert A._ARM_NAMES[:7] == (
        "factory",
        "solo-noreview",
        "openhands",
        "bare",
        "claude",
        "claude-5",
        "claude-4.8",
    )


def test_the_trajectory_expectation_derives_from_the_registry(A: Any) -> None:
    """Not a second hand-maintained table: adding an arm must not need an edit
    here at all."""
    assert A._ARM_TRAJECTORY_EXPECTATION == {
        name: spec.trajectories for name, spec in A._ARMS.items()
    }
    assert A._ARM_TRAJECTORY_EXPECTATION[_ARM] == A._TRAJECTORIES_PER_DEV_CALL


def test_the_solo_arm_appears_in_every_derived_lookup(A: Any) -> None:
    """The six per-arm lookups that used to fall back silently."""
    assert _ARM in A._ARM_NAMES
    assert A._resolve_max_steps(_ARM, None) == A._FACTORY_STEP_DEFAULT
    assert A._DEFAULT_COST_USD[_ARM] == A._ARMS[_ARM].default_cost_usd
    assert A._DEFAULT_HOURS[_ARM] == A._ARMS[_ARM].default_hours
    assert A.arm_spec(_ARM).base == "factory"
    assert A.run_key(_ARM) == _ARM
    assert A._arm_has_chain(_ARM) is True
    assert A._ARMS[_ARM].superseded_by is None


# --------------------------------------------------------------------------- #
# 4. fail loud, before spend
# --------------------------------------------------------------------------- #


def test_every_chain_driver_arm_has_a_mode_and_vice_versa(A: Any) -> None:
    """A ``base="factory"`` arm with no mode entry would run the FULL chain and
    be published as an ablation. A mode with no arm is dead configuration."""
    chain_arms = {n for n, s in A._ARMS.items() if s.base == "factory"}
    assert chain_arms == set(A._FACTORY_DRIVER_MODES)


def test_an_unregistered_chain_arm_is_refused_before_anything_is_cloned(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The guard is the FIRST statement after the wall clock starts, so no
    instance is looked up, no image pulled, no clone made and nothing spent."""
    called: list[str] = []
    monkeypatch.setattr(A, "_instance", lambda i: called.append(i) or {})
    monkeypatch.setattr(A, "_run_dir", lambda *a, **k: called.append("run_dir"))
    with pytest.raises(SystemExit) as exc:
        A.run_factory("i1", max_steps=1, timeout_s=1, arm="not-an-arm")
    assert "_FACTORY_DRIVER_MODES" in str(exc.value)
    assert called == [], "work happened before the arm was validated"


def test_the_mode_resolver_fails_loud_on_an_unknown_arm(A: Any) -> None:
    with pytest.raises(SystemExit) as exc:
        A._factory_driver_mode("nope", _FakeStoryState)
    msg = str(exc.value)
    assert "no _FACTORY_DRIVER_MODES entry" in msg
    assert _ARM in msg  # the message names the registered modes


def test_the_mode_resolver_fails_loud_on_a_renamed_story_state(A: Any) -> None:
    """FAIL SAFE, ``_DIFF_HEADER`` precedent: a terminal set built from a
    renamed enum would be silently incomplete, the driver would run to its tick
    cap and the row would grade a half-finished tree as the arm's answer."""

    for dropped in ("TESTS_GREEN", "BLOCKED_UNDERSPECIFIED"):
        partial = type(
            "_Partial",
            (),
            {
                k: v
                for k, v in vars(_FakeStoryState).items()
                if not k.startswith("_") and k != dropped
            },
        )
        assert not hasattr(partial, dropped)
        with pytest.raises(SystemExit) as exc:
            A._factory_driver_mode(_ARM, partial)
        assert dropped in str(exc.value)


def test_probe_plumbing_still_refuses_the_chain_driver_arms(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """``--probe-plumbing`` has no factory-base implementation; it must say so
    rather than silently doing a real run."""
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "swebench_adapter.py",
            "run",
            "--instance",
            "i1",
            "--arm",
            _ARM,
            "--probe-plumbing",
        ],
    )
    with pytest.raises(SystemExit) as exc:
        A.main()
    assert "probe-plumbing" in str(exc.value)


# --------------------------------------------------------------------------- #
# 5. the CLI, and no artifact collision
# --------------------------------------------------------------------------- #


def test_the_cli_routes_the_arm_id_into_the_chain_driver(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The runner used to be selected by BASE and called with no arm at all, so
    every chain-driver arm would have written a ``factory`` row."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "run_factory", lambda iid, **kw: seen.update(iid=iid, **kw))
    monkeypatch.setattr(
        sys,
        "argv",
        ["swebench_adapter.py", "run", "--instance", "i1", "--arm", _ARM],
    )
    A.main()
    assert seen == {
        "iid": "i1",
        "arm": _ARM,
        "max_steps": A._FACTORY_STEP_DEFAULT,
        "timeout_s": seen.get("timeout_s"),
    }
    assert seen["timeout_s"]


def test_the_default_arm_is_still_factory(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "run_factory", lambda iid, **kw: seen.update(**kw))
    monkeypatch.setattr(
        sys, "argv", ["swebench_adapter.py", "run", "--instance", "i1"]
    )
    A.main()
    assert seen["arm"] == "factory"


def test_the_new_arm_cannot_destroy_the_factory_arms_reviewer_corpus(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """``_reset_run_artifacts`` rmtree's ``runs/<instance>/<arm>/root`` at the top
    of every run. The ONLY replayable reviewer corpus this repo has lives in
    exactly that subtree for the ``factory`` arm, and one re-run destroys it
    permanently. Run directories are keyed by arm, so the ablation gets its own —
    asserted here rather than assumed.
    """
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    factory_dir = A._run_dir("inst-1", "factory")
    corpus = factory_dir / "root" / "state" / "events" / "prompt_bodies.ndjson"
    corpus.parent.mkdir(parents=True, exist_ok=True)
    corpus.write_text('{"persona": "reviewer"}\n', encoding="utf-8")
    (factory_dir / "result.json").write_text("{}", encoding="utf-8")

    solo_dir = A._run_dir("inst-1", _ARM)
    assert solo_dir != factory_dir
    A._reset_run_artifacts(solo_dir)

    assert corpus.is_file(), "the ablation wiped the factory arm's reviewer corpus"
    assert (factory_dir / "result.json").is_file()


def test_the_audit_reads_the_chain_arms_state_root_from_the_run_family(
    A: Any,  # noqa: N803
) -> None:
    """``audit`` located the factory state root by comparing the arm id to the
    literal ``"factory"``. A second chain-driver arm would have been audited
    against an empty directory and failed with "no Run ledger" on a good row."""
    src = _ADAPTER.read_text(encoding="utf-8")
    assert 'state_root = run_dir / "root" if arm == "factory" else run_dir' not in src
    assert '_audit_base == "factory"' in src
    assert A._ARMS[_ARM].base == "factory"


# --------------------------------------------------------------------------- #
# 6. the pre-registration is committed and says what it must
# --------------------------------------------------------------------------- #


def test_the_pre_registration_exists_and_binds_the_mde(A: Any) -> None:  # noqa: N803
    """At n=19 the MDE is +/-38 pp. A decision rule phrased as a significance
    test would be unanswerable at any outcome — which is the mistake
    ``PRE-REGISTRATION-1.6.md``'s own "What this run cannot show" recorded."""
    doc = (_REPO_ROOT / "bench" / "swebench" / "frozen" / "PRE-REGISTRATION-B1.md").read_text(
        encoding="utf-8"
    )
    assert "38 pp" in doc
    assert "not a significance test" in doc or "no decision rule" in doc.lower()
    # the pre-committed stop signal and the prediction, both quotable
    assert "only-factory" in doc and "5 of 19" in doc
    assert _ARM in doc
    # the manifest and k, so the run cannot be re-scoped after the fact
    assert "923aef05add32124" in doc
    assert "k = 1" in doc


def test_the_pinned_manifest_and_instance_count_are_unchanged(A: Any) -> None:
    """Same 19 instances, same manifest sha — the arm is added to an existing
    measurement bed, not a new one."""
    manifest = json.loads(
        (_REPO_ROOT / "bench" / "swebench" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    assert manifest["manifest_sha256"] == "923aef05add32124"
    assert len(manifest["instances"]) == 20  # 19 with a working oracle + flax-5171
