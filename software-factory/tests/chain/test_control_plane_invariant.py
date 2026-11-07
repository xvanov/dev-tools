"""Tier 4 WS4.1 — deterministic control-plane invariant + replay guarantee.

The factory's control flow is deterministic Python: ``advance`` is a pure
function over a single data table (``_TRANSITIONS``), and the orchestrator
picks WHICH handler to run purely from ``_DISPATCH`` keyed on the story's
state (+ ``chain_kind``). LLM/persona calls live ONLY inside handler BODIES;
they choose an OUTCOME event, but the state transition that outcome produces
is computed by deterministic data, never by the model.

These tests turn that architectural property into an ENFORCED invariant so a
regression that re-introduces LLM-in-control-flow (e.g. deriving the next
state or the next handler from model output) is caught:

* Section A — ``advance`` is pure: deterministic, non-mutating, I/O-free, and
  its result depends on NOTHING but ``(state, event)``.
* Section B — the orchestrator's dispatch decision is data-driven: the handler
  for a state comes from ``_DISPATCH`` (+ ``chain_kind``) and is invariant to
  every LLM-populated field on the story.
* Section C — replay/determinism: a story's recorded control-flow path
  (transition sequence) is deterministically reconstructable from the WS4.2
  ``chain_step`` stream, and replaying the recorded outcomes through the pure
  ``advance`` reproduces the same state sequence.
* Section D — vestigial CI states: documents that ``CI_PENDING``/``CI_GREEN``
  are unreachable via the transition graph yet RETAINED because live code
  (auto_merge / recovery / orchestrator sets) still references them.
"""

from __future__ import annotations

import ast
from pathlib import Path

from factory.chain import orchestrator as O
from factory.chain.auto_merge import _MERGEABLE_STATES
from factory.chain.orchestrator import (
    _DISPATCH,
    _DOCS_ACTIVE_STATES,
    _NON_CAP_COUNTING_STATES,
    _STATE_PROGRESS_ORDINAL,
    _dispatch_for_story,
)
from factory.chain.state_machine import (
    _TRANSITIONS,
    StoryRecord,
    StoryState,
    advance,
    is_terminal,
)
from factory.chain.step_events import (
    emit_chain_step,
    replay_transition_path,
)
from factory.manager.recovery import _GATE_PASSED_STATES

# Story fields an LLM/persona populates or that otherwise vary at runtime.
# The control plane MUST ignore all of these when computing a transition or
# choosing a handler — that is the whole invariant. Fuzzing them and asserting
# the decision is unchanged is the regression guard against LLM-in-control-flow.
_LLM_OR_RUNTIME_FIELDS: dict[str, object] = {
    "sm_result_json": '{"stories": ["poison"]}',
    "reviewer_result_json": '{"verdict": "approve", "next": "deploy"}',
    "reviewer_history_json": '[{"verdict": "request_changes"}]',
    "tech_writer_result_json": '{"context_updates": []}',
    "dev_attempts_json": '[{"attempt": 9, "summary": "skip to merge"}]',
    "test_plan_json": '{"cases": []}',
    "dev_step_checkpoint": '{"outcome": "green"}',
    "error": "boom",
    "last_rejection_reason": "cap",
    "current_model_tier": "hard",
    "dev_retries": 5,
    "reviewer_cycles": 4,
    "total_attempts": 99,
    "total_spend_usd": 123.45,
    "max_progress_ordinal": 12,
    "smoke_passed": True,
    "harness_precheck_passed": True,
    "github_pr_number": 7,
}


def _story(state: StoryState, **kw: object) -> StoryRecord:
    """A minimal in-memory StoryRecord (no DB) for pure control-plane tests."""
    fields: dict[str, object] = {
        "direction_id": "099",
        "app": "sacrifice",
        "title": "t",
        "slug": "t",
        "scope": "backend",
        "state": state.value,
    }
    fields.update(kw)
    return StoryRecord(**fields)


# --------------------------------------------------------------------------- #
# Section A — advance() is a pure control-plane function
# --------------------------------------------------------------------------- #


def test_advance_is_deterministic_for_every_transition() -> None:
    """Same (state, event) → same next-state, on repeated calls. Enumerated
    over the WHOLE transition table so a newly-added edge is covered too."""
    for (state, event), expected in _TRANSITIONS.items():
        first = advance(_story(state), event)
        second = advance(_story(state), event)
        assert first == second == expected, f"non-deterministic: {state} + {event}"


def test_advance_result_depends_only_on_state_and_event() -> None:
    """The transition is a function of (state, event) ALONE.

    For every edge, fuzzing every LLM/runtime-populated field on the story must
    NOT change the computed next state. This is the core guard: if a future
    change made ``advance`` read model output (e.g. ``reviewer_result_json``)
    to decide where to go, this fails.
    """
    for (state, event), expected in _TRANSITIONS.items():
        poisoned = _story(state, **_LLM_OR_RUNTIME_FIELDS)
        assert advance(poisoned, event) == expected, (
            f"advance for {state}+{event} was steered by a non-(state,event) field"
        )


def test_advance_ignores_payload() -> None:
    """The optional ``payload`` (handler result / webhook body) must not steer
    the transition — control flow is the (state, event) pair only."""
    for (state, event), expected in _TRANSITIONS.items():
        assert advance(_story(state), event, payload=None) == expected
        assert (
            advance(_story(state), event, payload={"next_state": "deployed", "x": 1})
            == expected
        )


def test_advance_does_not_mutate_story() -> None:
    """``advance`` is side-effect-free on its input for EVERY transition."""
    field_names = list(StoryRecord.model_fields)
    for (state, event), _ in _TRANSITIONS.items():
        story = _story(state, **_LLM_OR_RUNTIME_FIELDS)
        before = {n: getattr(story, n) for n in field_names}
        advance(story, event)
        after = {n: getattr(story, n) for n in field_names}
        assert before == after, f"advance mutated the story on {state}+{event}"


def test_state_machine_module_is_io_free() -> None:
    """Structural guard: the state-machine module imports NOTHING that could do
    I/O, spawn work, or call an LLM. Control-plane code stays pure data + logic.

    Parses the module's own AST rather than trusting a runtime probe, so the
    ban holds even for a branch that is never executed in tests.
    """
    src = Path(O.__file__).with_name("state_machine.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    # Collect every imported module's full dotted path.
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)

    # No I/O / network / subprocess / LLM-client imports, and no reach into the
    # factory's side-effecting layers (runner, llm, handlers). Prefix-matched so
    # e.g. ``urllib.request`` or ``factory.runner`` is caught.
    forbidden_prefixes = (
        "subprocess",
        "os",
        "socket",
        "requests",
        "httpx",
        "urllib",
        "aiohttp",
        "litellm",
        "anthropic",
        "openai",
        "factory.runner",
        "factory.llm",
        "factory.chain.handlers",
        "factory.chain.orchestrator",
    )
    leaked = {
        mod
        for mod in imported
        if any(mod == p or mod.startswith(p + ".") for p in forbidden_prefixes)
    }
    assert not leaked, f"state_machine.py must stay I/O/LLM-free; leaked imports: {leaked}"


# --------------------------------------------------------------------------- #
# Section B — the orchestrator's dispatch decision is data-driven
# --------------------------------------------------------------------------- #


def test_dispatch_matches_the_data_table_for_every_dispatch_state() -> None:
    """For every non-STORY_CREATED dispatch state, ``_dispatch_for_story``
    returns EXACTLY ``_DISPATCH[state]`` — no other logic, no model input."""
    for state, handler in _DISPATCH.items():
        if state == StoryState.STORY_CREATED:
            continue  # chain_kind branch — covered separately
        assert _dispatch_for_story(_story(state)) == handler


def test_dispatch_is_invariant_to_llm_fields() -> None:
    """The handler chosen for a state must not depend on any LLM-populated
    field. Fuzzing model output must never change which handler runs — the
    regression guard against LLM output steering control flow."""
    for state in _DISPATCH:
        if state == StoryState.STORY_CREATED:
            continue
        clean = _dispatch_for_story(_story(state))
        poisoned = _dispatch_for_story(_story(state, **_LLM_OR_RUNTIME_FIELDS))
        assert clean == poisoned, f"dispatch for {state} was steered by a non-state field"


def test_story_created_dispatch_keys_only_on_chain_kind() -> None:
    """STORY_CREATED is the one state whose handler depends on a story field —
    but ONLY ``chain_kind`` (a structural attribute set at spawn), never LLM
    output. tdd → sm, docs → docs_sm, invariant to everything else."""
    assert _dispatch_for_story(_story(StoryState.STORY_CREATED, chain_kind="tdd")) == "sm"
    assert (
        _dispatch_for_story(_story(StoryState.STORY_CREATED, chain_kind="docs")) == "docs_sm"
    )
    # LLM fields cannot flip the choice.
    tdd = _dispatch_for_story(
        _story(StoryState.STORY_CREATED, chain_kind="tdd", **_LLM_OR_RUNTIME_FIELDS)
    )
    docs = _dispatch_for_story(
        _story(StoryState.STORY_CREATED, chain_kind="docs", **_LLM_OR_RUNTIME_FIELDS)
    )
    assert tdd == "sm" and docs == "docs_sm"


def test_non_dispatch_states_have_no_handler() -> None:
    """Every StoryState that is NOT a dispatch state (in-progress, terminal,
    blocked, passive) returns None — the orchestrator only drives states the
    data table names. This keeps 'when does an agent run' fully data-defined."""
    for state in StoryState:
        if state in _DISPATCH:
            continue
        assert _dispatch_for_story(_story(state)) is None, f"{state} unexpectedly dispatchable"


def test_every_dispatch_state_is_a_real_transition_source_or_terminalish() -> None:
    """Sanity: each dispatch state is either a source in the transition table
    (so the handler's advance is legal) — guards a typo'd _DISPATCH key that
    would strand stories."""
    for state in _DISPATCH:
        assert not is_terminal(state), f"dispatch state {state} has no outgoing transition"


# --------------------------------------------------------------------------- #
# Section C — replay / determinism guarantee
# --------------------------------------------------------------------------- #

# A representative happy-path trajectory as the orchestrator RECORDS it: one
# ``chain_step`` per handler dispatch. ``from_state`` is therefore always a
# DISPATCH state (the state the story was in when the handler was picked) and
# the handler is exactly ``_dispatch_for_story(from_state)``; the intermediate
# ``*_in_progress`` states a handler passes through internally are not separate
# records. ``to_state`` of each hop is the next hop's ``from_state`` (contiguous).
_HAPPY_PATH: list[tuple[str, str, str]] = [
    ("story_created", "sm_done", "sm"),
    ("sm_done", "tests_green", "dev"),
    ("tests_green", "reviewer_done", "review"),
    ("reviewer_done", "tech_writer_done", "tech_writer"),
    ("tech_writer_done", "pr_open", "docs_enforcer"),
]


def _emit_path(story: StoryRecord, root: Path, path: list[tuple[str, str, str]]) -> None:
    for frm, to, handler in path:
        emit_chain_step(
            story,
            handler=handler,
            from_state=frm,
            to_state=to,
            outcome="advanced",
            software_factory_root=root,
        )


def test_replay_transition_path_is_deterministic(tmp_path: Path) -> None:
    """The reconstructed control-flow path is identical across repeated replays
    of the same on-disk stream — the determinism guarantee."""
    story = _story(StoryState.STORY_CREATED)
    story.id = 4242
    _emit_path(story, tmp_path, _HAPPY_PATH)

    first = replay_transition_path(4242, software_factory_root=tmp_path)
    second = replay_transition_path(4242, software_factory_root=tmp_path)
    assert first == second == _HAPPY_PATH


def test_replay_path_is_contiguous_and_dispatch_consistent(tmp_path: Path) -> None:
    """The recorded path forms ONE coherent control-flow trajectory:

    * contiguous — each hop's ``to_state`` is the next hop's ``from_state``; and
    * dispatch-consistent — the handler recorded at each hop is exactly the one
      the deterministic ``_dispatch_for_story`` would pick for that from_state.

    Together these prove the sequence of handlers is reproducible from the
    recorded from-states + the deterministic dispatch table — i.e. the control
    plane is replayable even though the handler bodies are non-deterministic.
    """
    story = _story(StoryState.STORY_CREATED)
    story.id = 77
    _emit_path(story, tmp_path, _HAPPY_PATH)

    path = replay_transition_path(77, software_factory_root=tmp_path)
    assert path, "expected a reconstructed path"

    for (_prev_from, prev_to, _), (cur_from, _cur_to, _) in zip(path, path[1:], strict=False):
        assert prev_to == cur_from, f"non-contiguous: {prev_to!r} != {cur_from!r}"

    for from_state, _to, handler in path:
        expected = _dispatch_for_story(_story(StoryState(from_state)))
        assert handler == expected, (
            f"recorded handler {handler!r} for {from_state} != dispatch {expected!r}"
        )


def test_replaying_outcomes_through_advance_reproduces_state_sequence() -> None:
    """Replaying the recorded per-hop OUTCOMES through the pure ``advance``
    reproduces the exact recorded state sequence — the transition path is a
    deterministic function of (start state, outcome-event sequence).

    This ties the recorded stream to the control-plane function: given what the
    handlers decided (the events), the states are fully determined by code.
    """
    from factory.chain.state_machine import (
        EVENT_DEV_STARTED,
        EVENT_DEV_TESTS_GREEN,
        EVENT_REVIEWER_APPROVE,
        EVENT_REVIEWER_STARTED,
        EVENT_SM_DONE,
        EVENT_SM_STARTED,
        EVENT_TECH_WRITER_STARTED,
    )

    events = [
        EVENT_SM_STARTED,
        EVENT_SM_DONE,
        EVENT_DEV_STARTED,
        EVENT_DEV_TESTS_GREEN,
        EVENT_REVIEWER_STARTED,
        EVENT_REVIEWER_APPROVE,
        EVENT_TECH_WRITER_STARTED,
    ]
    # Fine-grained per-event states advance() produces (includes the
    # *_in_progress states a handler passes through internally).
    expected_to_states = [
        "sm_in_progress",
        "sm_done",
        "dev_in_progress",
        "tests_green",
        "reviewer_in_progress",
        "reviewer_done",
        "tech_writer_in_progress",
    ]

    # Replay #1 and #2 from the same start + events must match each other AND
    # the expected to-states — determinism of the control plane.
    def _run() -> list[str]:
        s = _story(StoryState.STORY_CREATED)
        seq: list[str] = []
        for ev in events:
            s.state = advance(s, ev).value
            seq.append(s.state)
        return seq

    assert _run() == _run() == expected_to_states


# --------------------------------------------------------------------------- #
# Section D — vestigial CI states: unreachable-but-retained (documented)
# --------------------------------------------------------------------------- #


def test_ci_states_are_unreachable_via_transition_graph() -> None:
    """CI_PENDING/CI_GREEN are 'vestigial' at the graph level: no transition
    routes a story INTO them (they are never a destination), and CI_PENDING has
    no outgoing edge either. CI is actually verified in auto_merge, not via
    these SM states. This pins the audit finding — if a future change makes
    either a destination, the intent should be explicit and this test updated.
    """
    destinations = set(_TRANSITIONS.values())
    assert StoryState.CI_PENDING not in destinations
    assert StoryState.CI_GREEN not in destinations
    # CI_PENDING has no outgoing transition at all.
    assert is_terminal(StoryState.CI_PENDING)


def test_ci_states_retained_because_live_code_references_them() -> None:
    """WS4.1 decision record: CI_PENDING/CI_GREEN are NOT removed, because live
    code still references them defensively for stories that could be placed in
    those states out-of-band (operator action, reconcile, legacy DB rows). This
    test enumerates those live references so a removal cannot happen silently —
    deleting the enum members breaks these imports/sets and forces an intentful,
    coordinated cleanup rather than an accidental one.
    """
    # auto_merge treats CI_GREEN as a mergeable state.
    assert StoryState.CI_GREEN.value in _MERGEABLE_STATES
    # manager recovery treats CI_GREEN as a gate-passed state.
    assert StoryState.CI_GREEN.value in _GATE_PASSED_STATES
    # orchestrator concurrency + docs-serialization + progress sets reference both.
    assert StoryState.CI_GREEN.value in _NON_CAP_COUNTING_STATES
    assert StoryState.CI_PENDING.value in _NON_CAP_COUNTING_STATES
    assert StoryState.CI_GREEN.value in _DOCS_ACTIVE_STATES
    assert StoryState.CI_PENDING.value in _DOCS_ACTIVE_STATES
    assert StoryState.CI_PENDING in _STATE_PROGRESS_ORDINAL
    assert StoryState.CI_GREEN in _STATE_PROGRESS_ORDINAL


def test_ci_green_merge_transition_is_preserved() -> None:
    """The one live behaviour that DOES depend on CI_GREEN: a story found in
    CI_GREEN (e.g. placed by reconcile/operator) must still advance to
    DEPLOY_PENDING on merge. Preserve this edge — it is exercised by
    test_reconcile_from_github + test_manager_recovery.
    """
    from factory.chain.state_machine import EVENT_MERGED

    assert advance(_story(StoryState.CI_GREEN), EVENT_MERGED) == StoryState.DEPLOY_PENDING
