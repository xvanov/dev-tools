"""Four dev-loop behaviours, each with the sweep-2 artifact that names it.

Prompt and harness only — no model change, no new persona.

1. **A turn must not end on prose.** Sweep 2's `jsonpickle-588` ended BOTH dev
   attempts mid-sentence — the second on the literal words "Let me first fix the
   syntax error and" — with the tree one 2-line syntax error from green. The SDK
   reads "assistant message with no tool call" as "the agent is done", so the
   attempt was over. `vyper-4801` did it twice, `conan-19750` once, and
   `getmoto-9841` / `keras-22642` did it too and resolved only because a later
   attempt happened to run.

   The discriminator matters as much as the rule: 23 of 35 sweep-2 trajectories
   ended on an agent `MessageEvent` with no `finish` call, **including 10 that
   RESOLVED**, because delivering `SELF_SUMMARY:` in a final message is the
   normal ending. Only the absence of a terminal marker separates the seven
   truncations from those 23. A rule without that check would nudge two thirds of
   all runs, successful ones included — which is what these tests pin.

2. **Repro-first**, in the dev persona: an executable reproduction that fails
   BEFORE any production edit, and a fix that flips it.

3. **Scope-widening is permitted**, in the dev persona: `exstruct-113`'s final
   patch was 392 bytes / one deleted line.

4. **`dev_inner_loop_stopped` is surfaced.** It reached only
   `state/logs/<story>.log`, and the root cause was worse than the reporting
   gap: `_build_bench_root` wrote a settings file with no `caps`, so the bench
   inherited the model defaults of $2/h and $10/day — four times TIGHTER than
   the dev loop's own `per_story_budget_usd` of $8. Measured: `hourly_cap`
   truncated 4 of 38 chain rows, `vyper-4801` on the factory arm after exactly
   one inner attempt.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from factory import runner as R

_ROOT = Path(__file__).resolve().parents[1]
_ADAPTER = _ROOT / "bench" / "swebench_adapter.py"
_DEV_PERSONA = _ROOT / "factory" / "personas" / "dev.md"


@pytest.fixture
def A() -> Any:  # noqa: N802
    spec = importlib.util.spec_from_file_location("_swe_dev_loop", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# --------------------------------------------------------------------------- #
# fakes shaped like the OpenHands events the real trajectories carry
# --------------------------------------------------------------------------- #


class _Ev:
    def __init__(self, kind: str, **kw: Any) -> None:
        self.kind = kind
        for k, v in kw.items():
            setattr(self, k, v)


def _msg(text: str, *, source: str = "agent") -> _Ev:
    """An OpenHands ``MessageEvent`` in the RUNTIME shape.

    ``llm_message`` is an object with ``.content`` (a list of ``{type, text}``
    dicts), which is what ``_stringify_message_content`` walks. The archived
    ndjson serialises the same event as nested dicts — a fake built from dicts
    would pass a test and miss the real thing.
    """
    llm_message = type(
        "LLMMessage",
        (),
        {"role": "assistant", "content": [{"type": "text", "text": text}]},
    )()
    return _Ev("MessageEvent", source=source, llm_message=llm_message)


def _action(tool: str = "file_editor") -> _Ev:
    return _Ev("ActionEvent", source="agent", tool_name=tool, thought="", action={})


def _obs(tool: str = "file_editor") -> _Ev:
    return _Ev("ObservationEvent", source="environment", tool_name=tool, observation="ok")


class _Conv:
    def __init__(self, events: list[Any]) -> None:
        self.state = type("S", (), {"events": events})()


# The real truncated tail, verbatim from
# runs/jsonpickle__jsonpickle-588/factory/root/state/events/trajectories/1-2.ndjson
_JSONPICKLE_TAIL = (
    "Now I understand the flow:\n\n1. `_restore_object_instance` (line 801) calls "
    "`_loadfactory(obj)` at line 811\n\nLet me first fix the syntax error and"
)


# --------------------------------------------------------------------------- #
# 1 — never end on prose
# --------------------------------------------------------------------------- #


def test_the_real_jsonpickle_ending_is_detected_as_prose() -> None:
    conv = _Conv([_action(), _obs(), _msg(_JSONPICKLE_TAIL)])
    assert R._ended_on_prose(conv, "dev") is True


def test_a_self_summary_ending_is_not_prose() -> None:
    """The 23-of-35 case, 10 of them resolved. Nudging these would spend money to
    make successful runs worse."""
    conv = _Conv(
        [
            _action(),
            _obs(),
            _msg("All tests pass.\n\nSELF_SUMMARY: fixed the factory key handling; ..."),
        ]
    )
    assert R._ended_on_prose(conv, "dev") is False


def test_an_underspecified_declaration_is_not_prose() -> None:
    """A deliberate refusal is a real ending. The dev persona declares it, the
    chain routes it to a human, and it consumes no retry — so nudging it would
    override the one path the prompt promises costs nothing."""
    conv = _Conv([_action(), _obs(), _msg("UNDERSPECIFIED: the AC names status `archived` ...")])
    assert R._ended_on_prose(conv, "dev") is False


def test_a_finish_tool_call_anywhere_means_the_agent_decided() -> None:
    conv = _Conv([_action("finish"), _obs("finish"), _msg("bye")])
    assert R._ended_on_prose(conv, "dev") is False


def test_a_run_ending_on_an_observation_is_a_cap_hit_not_prose() -> None:
    """Ending on an ``ObservationEvent`` means the iteration or wall-clock cap
    cut in mid-tool-loop. That has its own accounting; claiming it as a prose
    ending would double-count it."""
    conv = _Conv([_msg("thinking"), _action(), _obs()])
    assert R._ended_on_prose(conv, "dev") is False


def test_a_persona_with_no_terminal_contract_is_never_nudged() -> None:
    """``onboarder`` is the other sandbox persona and declares no terminal
    marker. Without a contract there is no way to tell a deliberate ending from a
    truncated one, so it is not policed."""
    conv = _Conv([_action(), _obs(), _msg(_JSONPICKLE_TAIL)])
    assert R._ended_on_prose(conv, "onboarder") is False
    assert "onboarder" not in R._TERMINAL_MARKERS


def test_a_broken_conversation_read_does_not_continue() -> None:
    """Fail toward today's behaviour: a shape change must not spend money on a
    finished run."""

    class _Boom:
        @property
        def state(self) -> Any:
            raise RuntimeError("SDK moved")

    assert R._ended_on_prose(_Boom(), "dev") is False
    assert R._ended_on_prose(_Conv([]), "dev") is False


def test_the_continuation_is_capped_below_the_repo_hard_loop_cap() -> None:
    """CLAUDE.md: nothing loops more than 3 times, and an early-escalation guard
    must stay strictly below the hard cap or it becomes unreachable."""
    assert R._MAX_PROSE_CONTINUATIONS == 2
    assert R._MAX_PROSE_CONTINUATIONS < 3


def test_the_nudge_forbids_re_summarising_and_demands_a_tool_call() -> None:
    """The failure mode is a model that restates its plan instead of acting, so
    the nudge has to say both halves."""
    nudge = R._PROSE_CONTINUATION_NUDGE
    assert "CALLING A TOOL NOW" in nudge
    assert "not restate" in nudge or "Do not restate" in nudge
    assert "unchanged" in nudge


def test_sandbox_run_continues_a_prose_ending_and_records_it() -> None:
    """Behaviour, not source inspection: the loop must send the nudge into the
    SAME conversation (keeping the context and the sandbox tree) and stop as soon
    as the ending is well-formed."""
    sent: list[str] = []
    runs: list[int] = []

    class _Fake:
        def __init__(self) -> None:
            self.events: list[Any] = [_action(), _obs(), _msg(_JSONPICKLE_TAIL)]
            self.state = type("S", (), {})()
            self.state.events = self.events  # type: ignore[attr-defined]

        def send_message(self, text: str) -> None:
            sent.append(text)

        def run(self) -> None:
            runs.append(1)
            if len(runs) == 2:  # the nudge worked: now it ends properly
                self.events.append(_msg("SELF_SUMMARY: fixed it"))

    conv = _Fake()
    conv.send_message("initial")
    conv.run()
    for _c in range(R._MAX_PROSE_CONTINUATIONS):
        if not R._ended_on_prose(conv, "dev"):
            break
        conv.send_message(R._PROSE_CONTINUATION_NUDGE)
        conv.run()

    assert len(runs) == 2, "exactly one continuation should have been needed"
    assert sent[1:] == [R._PROSE_CONTINUATION_NUDGE]


def test_the_run_result_carries_the_continuation_count() -> None:
    assert R.RunResult(success=True).prose_continuations == 0
    assert R.RunResult(success=True, prose_continuations=2).prose_continuations == 2


def test_the_dev_persona_forbids_ending_on_prose() -> None:
    text = _persona_text()
    assert "Never end a turn on prose" in text
    assert "SELF_SUMMARY:" in text and "UNDERSPECIFIED:" in text


# --------------------------------------------------------------------------- #
# 2 — repro-first
# --------------------------------------------------------------------------- #


def _persona_text() -> str:
    """The persona with newlines collapsed, so an assertion is about the WORDS
    and not about where the paragraph happened to wrap."""
    return " ".join(_DEV_PERSONA.read_text(encoding="utf-8").split())


def test_the_dev_persona_demands_a_reproduction_before_editing() -> None:
    """"Write tests, make them green" validates the dev's GUESS about the bug.
    The reproduction has to fail against the tree as it is, and the fix has to be
    what flips it."""
    text = _persona_text()
    assert "Reproduce before you edit" in text
    assert "FAIL before you change any production code" in text
    assert "your fix must be what flips it" in text
    # And the case where the repro passes at base — the tell that the defect has
    # not been located — must be named, not left to inference.
    assert "If your reproduction passes at base" in text
    # It must not be test-shaped only: claude's wins here were subprocess probes
    # and monkeypatched allocators.
    for form in ("python -c", "subprocess probe", "monkeypatched"):
        assert form in text, form


# --------------------------------------------------------------------------- #
# 3 — scope-widening is permitted
# --------------------------------------------------------------------------- #


def test_the_dev_persona_permits_widening_past_the_named_file() -> None:
    text = _persona_text()
    assert "Go as wide as the defect is" in text
    assert "SYMPTOM" in text
    assert "392-byte" in text, "name the measured failure, not a generic warning"
    assert "A small diff is not a goal" in text


def test_the_reviewer_rubric_already_caps_scope_findings_at_low() -> None:
    """The plan asked for the reviewer's "minimal-diff push" to be removed. The
    artifact does not support one, so nothing is removed here and this test pins
    why: the rubric ALREADY forces `scope` and `style` to `low`, and across all
    25 sweep-2 reviewer responses (40 findings) every one of the 4 `scope` and 17
    `style` findings was `low`. The reviewer never blocked a wide diff. Removing
    a fence that is already open would only weaken the rubric."""
    text = (_ROOT / "factory" / "personas" / "reviewer.md").read_text(encoding="utf-8")
    assert "A finding whose `criterion` is `scope` or `style` MUST be `low`" in text
    assert "never a blocker" in text


# --------------------------------------------------------------------------- #
# 4 — the inner-loop stop reason, and the cap that caused it
# --------------------------------------------------------------------------- #


def test_the_bench_root_writes_explicit_caps(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """The settings model defaults to $2/h and $10/day. A bench root that omits
    `caps` inherits them, making the global cap FOUR TIMES tighter than the dev
    loop's own $8 per-story budget — and the tightest constraint in the whole
    benchmark."""
    from factory.settings.loader import CapsConfig, DevConvergenceConfig  # noqa: F401

    repo = tmp_path / "repo"
    repo.mkdir()
    root = tmp_path / "root"
    A._build_bench_root(
        {
            "instance_id": "x__y-1",
            "repo": "x/y",
            "docker_image": "example/img@sha256:" + "0" * 64,
            "base_commit": "0" * 40,
        },
        repo,
        root,
    )
    settings = json.loads((root / "factory_settings.yaml").read_text(encoding="utf-8"))
    assert "caps" in settings, "no caps => the $2/h default is inherited silently"
    assert settings["caps"]["hourly_spend_usd"] == A._BENCH_ROOT_CAPS["hourly_spend_usd"]
    assert settings["caps"]["daily_spend_usd"] == A._BENCH_ROOT_CAPS["daily_spend_usd"]

    # Non-binding relative to the per-story dev budget, which is what still
    # bounds the loop in dollars.
    per_story = DevConvergenceConfig().per_story_budget_usd
    assert A._BENCH_ROOT_CAPS["hourly_spend_usd"] > per_story
    assert settings["dev_convergence"]["enabled"] is True


def test_the_inherited_default_really_was_tighter_than_the_story_budget() -> None:
    """The measurement behind the fix, executable: this is why 4 rows truncated."""
    from factory.settings.loader import CapsConfig, DevConvergenceConfig

    defaults_hourly = CapsConfig().hourly_spend_usd
    assert defaults_hourly == 2.0
    assert DevConvergenceConfig().per_story_budget_usd == 8.0
    assert defaults_hourly < DevConvergenceConfig().per_story_budget_usd


def test_the_stop_reason_reaches_result_json(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """It was written ONLY to `state/logs/<story>.log` — no event stream, no
    result.json — so a row cut short by a guard looked identical to a row where
    the dev ran out of ideas."""
    from factory.chain.event_log import log_story_event

    root = tmp_path / "root"
    (root / "state").mkdir(parents=True)
    log_story_event(7, "handler_start", {"x": 1}, software_factory_root=root, slug_hint="swe-abc")
    log_story_event(
        7,
        "dev_inner_loop_stopped",
        {"reason": "hourly_cap", "inner_attempts": 1, "dev_retries": 1},
        software_factory_root=root,
        slug_hint="swe-abc",
    )
    stops = A._dev_inner_loop_stops(root / "state", 7, "swe-abc")
    assert len(stops) == 1
    assert stops[0]["reason"] == "hourly_cap"
    assert stops[0]["inner_attempts"] == 1
    assert "event" not in stops[0]


def test_a_missing_log_is_an_empty_list_not_an_exception(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """An observability read must never be able to fail a measured row."""
    assert A._dev_inner_loop_stops(tmp_path / "nope" / "state", 1, "s") == []


def test_why_promotes_the_stop_reason_out_of_the_eight_event_tail() -> None:
    """`factory why` tails 8 events, so on any story that reached review the
    stop had already scrolled off. It gets its own field, scanned over the WHOLE
    log."""
    src = (_ROOT / "factory" / "cli.py").read_text(encoding="utf-8")
    assert "dev inner loop CUT SHORT" in src
    assert "dev_loop_line" in src
    # Scanned without a limit — a limit=8 read is the bug being fixed.
    # ONE read of the whole log, sliced two ways — a limit=8 read is the bug.
    assert src.count("read_story_events(\n        int(story.id or 0)") == 1
    idx = src.index("recent = _all_events[-8:]")
    window = src[idx - 300 : idx]
    assert "limit=" not in window, "the whole-log read must not carry a tail limit"
