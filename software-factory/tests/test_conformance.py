"""Trace conformance: does the running code emit a trace the model accepts?

Four things are pinned here, in increasing order of load-bearingness:

1. The YAML model agrees with ``_TRANSITIONS``. The checker deliberately does
   NOT import the table (a shared object would hide its own bugs from both
   emitter and checker), so this test is what makes the duplication safe: drift
   becomes a CI failure instead of silent mutual agreement.
2. Each verdict is produced for the right shape of hop.
3. The emitter cannot be bypassed. Every story writer goes through the ORM, and
   the listener is installed by importing ``factory.chain`` — which writing a
   story cannot avoid, because ``StoryRecord`` lives there.
4. **Coverage.** An undeclared writer is a finding, not a pass. Without this a
   conformance check only validates the paths someone remembered to declare and
   blesses everything else — decorative logging (buzz-conformance's own note:
   "coverage breach is load-bearing").
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, SQLModel, create_engine

from factory.observability import state_trace
from factory.observability.conformance import (
    ALLOWED_DIRECT_WRITE,
    COVERAGE_BREACH,
    ILLEGAL_TRANSITION,
    LEGAL_EDGE,
    LEGAL_PATH,
    check_trace,
    judge_hop,
    load_model,
)

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _record(**kw: Any) -> dict[str, Any]:
    base = {
        "event": "state_write",
        "story_id": 1,
        "app": "sacrifice",
        "slug": "s",
        "chain_kind": "tdd",
        "ts": "2026-07-24T00:00:00+00:00",
    }
    base.update(kw)
    return base


# --------------------------------------------------------------------------- #
# 1. The model must not drift from the transition table
# --------------------------------------------------------------------------- #


def test_model_matches_the_transition_table() -> None:
    """The YAML edges are exactly the (from -> to) pairs ``advance()`` produces.

    If this fails, someone changed ``_TRANSITIONS`` without updating
    ``conformance_model.yaml``. Regenerate it with the snippet in the YAML
    header — do NOT make the checker import the table instead, which is the
    coupling this whole design avoids.
    """
    from factory.chain.state_machine import _TRANSITIONS

    expected = {(f.value, t.value) for (f, _event), t in _TRANSITIONS.items()}
    assert load_model().legal_edges == expected


def test_checker_does_not_import_the_state_machine() -> None:
    """Structural independence guard, in the style of the existing
    ``test_state_machine_module_is_io_free``: parse the checker's AST and assert
    it never reaches into the production control plane. Sharing the transition
    table (or ``advance`` / ``_dispatch_for_story``) between the thing that
    emits a projection and the thing that judges it would let one bug satisfy
    both sides.
    """
    src = (
        Path(__file__).resolve().parent.parent / "factory" / "observability" / "conformance.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(src)
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    for banned in ("factory.chain.state_machine", "factory.chain.orchestrator", "factory.chain"):
        assert banned not in imported, f"conformance.py must not import {banned}"

    # Check IDENTIFIER usage via the AST, not raw text: the module docstring
    # legitimately names these symbols while explaining why it avoids them.
    used = (
        {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        | {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
        | {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            for alias in node.names
        }
    )
    for banned in ("_TRANSITIONS", "advance", "_dispatch_for_story", "StoryState"):
        assert banned not in used, f"conformance.py must not reference {banned}"


def test_model_rejects_an_empty_or_malformed_file(tmp_path: Path) -> None:
    """A verifier that silently loads an empty model would report perfect
    conformance for every trace — the worst possible failure mode. Loading must
    raise, unlike the telemetry write path which degrades quietly."""
    bad = tmp_path / "model.yaml"
    bad.write_text("version: 1\nlegal_edges: []\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_model(bad)

    bad.write_text("- not a mapping\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_model(bad)


# --------------------------------------------------------------------------- #
# 2. Verdicts
# --------------------------------------------------------------------------- #


def test_a_table_edge_is_a_legal_edge() -> None:
    model = load_model()
    hop = judge_hop(
        _record(from_state="story_created", to_state="sm_in_progress", writer="orchestrator.tick"),
        model,
    )
    assert hop.verdict == LEGAL_EDGE


def test_a_collapsed_dispatch_is_a_legal_path() -> None:
    """One dispatch persists its NET effect, so the in-progress hop never lands.

    This is the shape of 249 of the 270 hops in the live stream: the review
    handler enters ``reviewer_in_progress`` and exits to ``reviewer_done``
    within a single dispatch, and the orchestrator persists once. A checker that
    demanded single edges would flag essentially all real history.
    """
    model = load_model()
    hop = judge_hop(
        _record(from_state="tests_green", to_state="reviewer_done", writer="orchestrator.tick"),
        model,
    )
    assert hop.verdict == LEGAL_PATH
    assert "reviewer_in_progress" in hop.reason


@pytest.mark.parametrize(
    ("from_state", "to_state"),
    [
        ("story_created", "reviewer_done"),  # skipped SM planning and dev entirely
        ("sm_done", "pr_open"),  # skipped dev, review and tech-writer
        ("story_created", "deployed"),  # skipped the whole pipeline
    ],
)
def test_a_genuine_phase_skip_is_rejected(from_state: str, to_state: str) -> None:
    """The strictness that makes ``legal_path`` safe.

    Collapsing two edges is normal; collapsing more means a story jumped a whole
    phase — no dev ran, or no review happened — which is exactly the false-green
    class this checker exists to catch. These must NOT be waved through, and in
    particular must not be rescued by a writer wildcard: an earlier draft of the
    model gave ``orchestrator.tick`` ``to: ["*"]`` and silently accepted all
    three.
    """
    model = load_model()
    hop = judge_hop(
        _record(from_state=from_state, to_state=to_state, writer="orchestrator.tick"), model
    )
    assert hop.verdict == ILLEGAL_TRANSITION


def test_no_writer_rule_may_wildcard_its_targets_except_github_reconcile() -> None:
    """Guard against the wildcard creeping back in.

    A ``to: ["*"]`` rule accepts forward phase skips as well as the intended
    bypass, which quietly disables skip detection for that writer. Only the
    GitHub reconcile is genuinely unbounded (its target is external truth, not a
    chain decision); anything else must use an explicit list or
    ``allow_rollback``.
    """
    model = load_model()
    wildcarded = {writer for writer, rule in model.allowed_writers.items() if "*" in rule.targets}
    assert wildcarded == {"orchestrator.reconcile_from_github"}, (
        "a new wildcard target rule disables phase-skip detection for that "
        f"writer: {sorted(wildcarded)}"
    )


def test_a_rollback_is_allowed_because_its_reverse_is_legal() -> None:
    """The crash guard and stale-in-progress rewind restore a story to a state
    it legitimately came from. Modelled as "the reverse hop is legal" rather
    than a wildcard, so forward skips stay detectable."""
    model = load_model()
    for from_state, to_state, writer in [
        ("dev_in_progress", "sm_done", "orchestrator.tick"),
        ("reviewer_in_progress", "tests_green", "orchestrator._prune_stale_in_progress"),
        (
            "blocked_tests_need_clarification",
            "dev_retry",
            "orchestrator._recover_blocked_stories",
        ),
    ]:
        hop = judge_hop(_record(from_state=from_state, to_state=to_state, writer=writer), model)
        assert hop.verdict == ALLOWED_DIRECT_WRITE, hop.as_dict()
        assert "rollback" in hop.reason


def test_model_entries_must_carry_a_rationale(tmp_path: Path) -> None:
    """An allowlist whose entries need no justification becomes a rubber stamp."""
    bad = tmp_path / "model.yaml"
    bad.write_text(
        "version: 1\n"
        "legal_edges:\n  - {from: a, to: b}\n"
        "allowed_direct_writes:\n  - {writer: sneaky.path, to: [deployed]}\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="must carry a 'why'"):
        load_model(bad)


def test_a_sanctioned_bypass_is_an_allowed_direct_write() -> None:
    """dual_draft retires a superseded sibling from ANY in-flight state; there
    is no event edge for it, and that is deliberate."""
    model = load_model()
    hop = judge_hop(
        _record(
            from_state="reviewer_in_progress",
            to_state="superseded_by_sibling",
            writer="dual_draft.retire_superseded_siblings",
        ),
        model,
    )
    assert hop.verdict == ALLOWED_DIRECT_WRITE


def test_a_declared_writer_producing_a_forbidden_state_is_illegal() -> None:
    """recovery may return a blocked story to ``pr_open`` — nothing else."""
    model = load_model()
    hop = judge_hop(
        _record(
            from_state="blocked_ci_unresolved",
            to_state="deployed",
            writer="recovery.execute_retry_mergeable_blocked_story",
        ),
        model,
    )
    assert hop.verdict == ILLEGAL_TRANSITION
    assert "only permitted to produce" in hop.reason


def test_a_hop_the_table_cannot_produce_from_an_undeclared_writer_is_a_breach() -> None:
    model = load_model()
    hop = judge_hop(
        _record(from_state="story_created", to_state="deployed", writer="somewhere.sneaky_fix"),
        model,
    )
    assert hop.verdict == COVERAGE_BREACH
    assert "not declared in the model" in hop.reason


def test_unattributable_write_is_a_breach_not_a_pass() -> None:
    """When frame attribution fails we must NOT assume the write was fine."""
    model = load_model()
    hop = judge_hop(
        _record(from_state="pr_open", to_state="story_created", writer="unknown"), model
    )
    assert hop.verdict == COVERAGE_BREACH


def test_every_documented_bypass_in_the_real_code_is_accepted() -> None:
    """The sixteen direct-assignment sites that exist on main must all pass.

    A model that flagged them would drown the operator in noise on the first
    real tick, which is how a verifier gets switched off.
    """
    model = load_model()
    observed = [
        ("dev_in_progress", "sm_done", "orchestrator._prune_stale_in_progress"),
        ("blocked_tests_need_clarification", "dev_retry", "orchestrator._recover_blocked_stories"),
        ("pr_open", "closed_by_operator", "orchestrator.reconcile_closed_trackers"),
        ("pr_open", "ready_for_merge", "orchestrator.reconcile_from_github"),
        ("sm_done", "blocked_dependency_unmet", "orchestrator.tick"),
        ("dev_in_progress", "sm_done", "orchestrator.tick"),
        ("pr_open", "blocked_ci_unresolved", "auto_merge._park"),
        ("pr_open", "blocked_ci_unresolved", "auto_merge._park_gate_block_exhausted"),
        ("pr_open", "reviewer_requested_changes", "auto_merge._handle_ci_failure"),
        ("pr_open", "reviewer_requested_changes", "auto_merge._redispatch_ci_fix"),
        ("pr_open", "reviewer_requested_changes", "auto_merge._handle_pr_conflict_rebuild"),
        ("ready_for_merge", "superseded_by_sibling", "auto_merge.auto_merge_tick"),
        ("tests_green", "superseded_by_sibling", "dual_draft.retire_superseded_siblings"),
        ("sm_in_progress", "story_created", "handlers.handle_sm"),
        ("blocked_ci_unresolved", "pr_open", "recovery.execute_retry_mergeable_blocked_story"),
        # D013: reconcile_from_github revives blocked_ci_unresolved → deploy_pending
        # and unparks dependent blocked_dependency_unmet → story_created.
        ("blocked_ci_unresolved", "deploy_pending", "orchestrator.reconcile_from_github"),
        ("blocked_dependency_unmet", "story_created", "orchestrator.reconcile_from_github"),
        ("pr_open", "story_created", "recovery.execute_redispatch_phantom_pr"),
        ("pr_open", "quarantined_invalid_state", "recovery.execute_quarantine_invalid_enum_story"),
    ]
    report = check_trace(
        [_record(from_state=f, to_state=t, writer=w) for f, t, w in observed], model=model
    )
    assert report.conformant, [f.as_dict() for f in report.findings]


def test_real_recorded_history_is_conformant() -> None:
    """Every hop shape the live factory has actually produced must pass.

    These are the distinct (from -> to) pairs found in the production
    ``chain_steps`` stream (270 real hops across 2 apps). They are checked here
    as a fixture so the model cannot regress into flagging normal operation —
    the failure mode that gets a verifier switched off.
    """
    model = load_model()
    real_pairs = [
        ("tests_green", "reviewer_done"),
        ("reviewer_done", "tech_writer_done"),
        ("tech_writer_done", "pr_open"),
        ("sm_done", "tests_green"),
        ("story_created", "sm_done"),
        ("reviewer_requested_changes", "tests_green"),
        ("deploy_pending", "deployed"),
        ("tests_green", "reviewer_requested_changes"),
        ("tech_writer_done", "reviewer_requested_changes"),
        ("sm_done", "dev_retry"),
        ("tests_green", "blocked_review_nonconvergent"),
        ("dev_retry", "blocked_tests_need_clarification"),
        ("dev_retry", "tests_green"),
    ]
    report = check_trace(
        [_record(from_state=f, to_state=t, writer="orchestrator.tick") for f, t in real_pairs],
        model=model,
    )
    assert report.conformant, [f.as_dict() for f in report.findings]
    assert set(report.counts) <= {LEGAL_EDGE, LEGAL_PATH}, report.counts


def test_report_counts_and_conformant_flag() -> None:
    model = load_model()
    report = check_trace(
        [
            _record(from_state="story_created", to_state="sm_in_progress", writer="a.b"),
            _record(from_state="story_created", to_state="deployed", writer="mystery.writer"),
        ],
        model=model,
    )
    assert report.checked == 2
    assert report.counts == {COVERAGE_BREACH: 1, LEGAL_EDGE: 1}
    assert not report.conformant
    assert report.unknown_writers == ["mystery.writer"]


def test_empty_trace_is_conformant_not_an_error() -> None:
    report = check_trace([], model=load_model())
    assert report.conformant
    assert report.checked == 0


# --------------------------------------------------------------------------- #
# 3. The emitter cannot be bypassed
# --------------------------------------------------------------------------- #


def test_importing_the_state_machine_installs_the_listener() -> None:
    """The completeness guarantee, stated as an executable invariant.

    Every story write needs ``StoryRecord``, which lives in
    ``factory.chain.state_machine``; importing it initialises the
    ``factory.chain`` package, which installs the trace listener. So there is no
    way to write a story state without the listener being live first.

    Run in a fresh interpreter — an in-process check would pass trivially
    because the test session already imported everything.
    """
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import factory.chain.state_machine;"
            "from factory.observability import state_trace;"
            "print(state_trace._installed)",
        ],
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().endswith("True"), proc.stdout


def test_every_story_writer_module_imports_the_state_machine() -> None:
    """Mechanically re-derive the writer set and check it stays instrumented.

    This is the coverage gate. It scans for modules that assign
    ``<something>.state`` on a story and asserts each imports
    ``factory.chain.state_machine`` (directly or lazily) — which is what
    guarantees the listener is installed before the write. A NEW writer added in
    an uninstrumented way fails here instead of silently going untraced.
    """
    offenders: list[str] = []
    for path in sorted((_REPO_ROOT / "factory").rglob("*.py")):
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src)
        writes_state = any(
            isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Attribute) and t.attr == "state" for t in node.targets)
            and "StoryState" in (ast.get_source_segment(src, node.value) or "")
            for node in ast.walk(tree)
        )
        if not writes_state:
            continue
        if "factory.chain.state_machine" not in src and "state_machine import" not in src:
            offenders.append(str(path.relative_to(_REPO_ROOT)))
    assert not offenders, (
        "these modules write a story state but do not import the state machine, "
        f"so the trace listener may not be installed: {offenders}"
    )


def test_orm_listener_traces_a_write_from_an_unrelated_session(tmp_path: Path) -> None:
    """A writer using its OWN Session (the dual_draft / recovery shape) is
    traced. This is why the hook is on the ORM and not on ``persist_story`` —
    ten writers never call that helper.
    """
    from factory.chain.state_machine import StoryRecord

    state_trace.set_root_override(tmp_path)
    state_trace.install()
    try:
        engine = create_engine(f"sqlite:///{tmp_path / 'stories.db'}", echo=False)
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            story = StoryRecord(
                direction_id="001",
                app="demo",
                title="t",
                slug="t",
                scope="backend",
                state="story_created",
            )
            session.add(story)
            session.commit()
            story_id = story.id

        def a_writer_with_its_own_session() -> None:
            with Session(engine) as session:
                row = session.get(StoryRecord, story_id)
                assert row is not None
                row.state = "superseded_by_sibling"
                session.add(row)
                session.commit()

        a_writer_with_its_own_session()

        records = state_trace.read_state_writes(software_factory_root=tmp_path)
        assert len(records) == 1, records
        assert records[0]["from_state"] == "story_created"
        assert records[0]["to_state"] == "superseded_by_sibling"
        # Attribution names the FUNCTION that changed the state, skipping ORM
        # machinery and shared persistence plumbing.
        assert records[0]["writer"].endswith("a_writer_with_its_own_session")
    finally:
        state_trace.set_root_override(None)


def test_insert_is_not_traced_as_a_transition(tmp_path: Path) -> None:
    """Creating a story is genesis, not a hop — only updates are transitions."""
    from factory.chain.state_machine import StoryRecord

    state_trace.set_root_override(tmp_path)
    state_trace.install()
    try:
        engine = create_engine(f"sqlite:///{tmp_path / 'stories.db'}", echo=False)
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            session.add(
                StoryRecord(
                    direction_id="001",
                    app="demo",
                    title="t",
                    slug="t",
                    scope="backend",
                    state="story_created",
                )
            )
            session.commit()
        assert state_trace.read_state_writes(software_factory_root=tmp_path) == []
    finally:
        state_trace.set_root_override(None)


def test_non_state_updates_are_not_traced(tmp_path: Path) -> None:
    """Touching any other column must not emit a hop — the stream would fill
    with noise and the real transitions would be unfindable."""
    from factory.chain.state_machine import StoryRecord

    state_trace.set_root_override(tmp_path)
    state_trace.install()
    try:
        engine = create_engine(f"sqlite:///{tmp_path / 'stories.db'}", echo=False)
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            story = StoryRecord(
                direction_id="001",
                app="demo",
                title="t",
                slug="t",
                scope="backend",
                state="story_created",
            )
            session.add(story)
            session.commit()
            story.total_attempts = 3
            session.add(story)
            session.commit()
        assert state_trace.read_state_writes(software_factory_root=tmp_path) == []
    finally:
        state_trace.set_root_override(None)


def test_emitter_never_raises_on_a_broken_stream_dir(tmp_path: Path) -> None:
    """Telemetry runs inside a flush: a write failure must not poison the
    transaction. Point the stream at an unwritable location and confirm the
    story write still commits."""
    from factory.chain.state_machine import StoryRecord

    blocked = tmp_path / "blocked"
    blocked.write_text("not a directory", encoding="utf-8")
    state_trace.set_root_override(blocked)
    state_trace.install()
    try:
        engine = create_engine(f"sqlite:///{tmp_path / 'stories.db'}", echo=False)
        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            story = StoryRecord(
                direction_id="001",
                app="demo",
                title="t",
                slug="t",
                scope="backend",
                state="story_created",
            )
            session.add(story)
            session.commit()
            story.state = "sm_in_progress"
            session.add(story)
            session.commit()
            session.refresh(story)
            assert story.state == "sm_in_progress", "the real write must survive"
    finally:
        state_trace.set_root_override(None)


# --------------------------------------------------------------------------- #
# 4. The detector
# --------------------------------------------------------------------------- #


def test_detector_is_registered() -> None:
    from factory.manager.detectors import DETECTOR_DOCS, DETECTORS

    assert "conformance_breach" in DETECTORS
    assert DETECTOR_DOCS["conformance_breach"].strip()


def test_detector_reports_findings_and_nothing_else(tmp_path: Path) -> None:
    from factory.manager.detectors.conformance_breach import conformance_breach
    from factory.manager.signals import write_event

    events = tmp_path / "state" / "events"
    events.mkdir(parents=True)
    write_event(
        state_trace.STATE_WRITE_STREAM,
        _record(from_state="story_created", to_state="sm_in_progress", writer="orchestrator.tick"),
        software_factory_root=tmp_path,
    )
    write_event(
        state_trace.STATE_WRITE_STREAM,
        _record(story_id=42, from_state="story_created", to_state="deployed", writer="x.y"),
        software_factory_root=tmp_path,
    )

    findings = conformance_breach(root=tmp_path)
    assert len(findings) == 1
    assert findings[0]["verdict"] == COVERAGE_BREACH
    assert findings[0]["story_id"] == 42


def test_detector_returns_empty_when_nothing_recorded(tmp_path: Path) -> None:
    from factory.manager.detectors.conformance_breach import conformance_breach

    assert conformance_breach(root=tmp_path) == []
