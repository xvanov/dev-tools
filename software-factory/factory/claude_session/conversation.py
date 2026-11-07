"""Drive ONE Claude Code conversation: rounds, gate feedback, wall clock, cancel.

The claude_session counterpart of ``runner.sandbox_run``'s in-conversation gate
loop (solo pipeline), with the same contract:

* round 1 gets the full prompt; when it ends, ``gate_check()`` grades the tree;
* red → the gate's reason (``runner._render_gate_feedback``) goes back into the
  SAME Claude session (``claude -p --resume <session_id>``), at most
  ``max_gate_rounds`` gate checks in total (≤ 3, the repo's loop rule);
* a round that leaves the tree byte-identical ends the run
  (``no_progress_between_rounds``), as does an unchanged tree
  ``no_progress_abort_s`` into round 1 (``no_progress_first_write``);
* ``wall_clock_s`` bounds the whole conversation; at the deadline the run is
  killed and the tree is graded as it stands (``wall_clock``);
* ``cancelled()`` is polled; a cancel kills the run (``cancelled``) and nothing
  is graded.

With no ``gate_check`` (chain pipeline, research/report jobs) the conversation
is one round and the caller grades the result itself.

Every dependency with a side effect (launcher, clock, sleep, fingerprint) is
injectable so tests run it without ``claude`` or termhub.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.claude_session.launcher import (
    Launcher,
    RoundPlan,
    SessionInfo,
    build_claude_argv,
    build_round_script,
    round_plan,
)
from factory.claude_session.stream import ClaudeResult, parse_stream

#: Rounds never start with less than this left on the wall clock.
MIN_ROUND_S = 120
#: How often (in polls) termhub is asked whether the session still exists.
_ALIVE_EVERY = 15


@dataclass
class ConversationResult:
    rounds: list[ClaudeResult] = field(default_factory=list)
    gate_rounds: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str = ""
    final_verdict: Any = None  # GateVerdict | None
    session: SessionInfo | None = None
    session_id: str | None = None
    cancelled: bool = False
    timed_out: bool = False
    error: str | None = None
    duration_s: float = 0.0

    @property
    def subscription_equiv_usd(self) -> float:
        return round(sum(r.total_cost_usd for r in self.rounds), 6)

    @property
    def tokens_in(self) -> int:
        return sum(r.tokens_in for r in self.rounds)

    @property
    def tokens_out(self) -> int:
        return sum(r.tokens_out for r in self.rounds)

    @property
    def cached_input_tokens(self) -> int:
        return sum(r.cached_input_tokens for r in self.rounds)

    @property
    def any_result(self) -> bool:
        return any(r.found for r in self.rounds)

    @property
    def last_text(self) -> str:
        for r in reversed(self.rounds):
            if r.result_text or r.last_assistant_text:
                return r.result_text or r.last_assistant_text
        return ""


def _default_fingerprint(path: Path) -> str | None:
    from factory.runner import _worktree_fingerprint

    return _worktree_fingerprint(path)


def _feedback(verdict: Any, round_no: int, max_rounds: int) -> str:
    from factory.runner import _render_gate_feedback

    return _render_gate_feedback(verdict, round_no, max_rounds)


def run_conversation(
    *,
    cwd: Path,
    run_dir: Path,
    prompt: str,
    title: str,
    launcher: Launcher,
    claude_bin: str,
    model: str | None = None,
    wall_clock_s: float = 5400,
    gate_check: Callable[[], Any] | None = None,
    max_gate_rounds: int = 1,
    no_progress_abort_s: float | None = None,
    cancelled: Callable[[], bool] = lambda: False,
    on_session: Callable[[SessionInfo], None] | None = None,
    add_dirs: list[str] | None = None,
    poll_s: float = 2.0,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    fingerprint: Callable[[Path], str | None] = _default_fingerprint,
) -> ConversationResult:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    out = ConversationResult()
    started = clock()
    deadline = started + float(wall_clock_s)
    plans: list[RoundPlan] = []
    session_uuid = str(uuid.uuid4())
    resume: str | None = None
    message = prompt
    max_rounds = max(1, int(max_gate_rounds)) if gate_check is not None else 1
    session: SessionInfo | None = None

    for round_no in range(1, max_rounds + 1):
        plan = round_plan(run_dir, round_no)
        plans.append(plan)
        plan.prompt_path.write_text(message, encoding="utf-8")
        argv = build_claude_argv(
            claude_bin,
            model=model,
            session_uuid=session_uuid if round_no == 1 else None,
            resume=resume,
            add_dirs=add_dirs,
        )
        plan.script_path.write_text(
            build_round_script(plan, cwd=cwd, claude_argv=argv, title=title), encoding="utf-8"
        )
        before = fingerprint(cwd)
        try:
            if session is None:
                session = launcher.start(plan, cwd=cwd, title=title)
                out.session = session
                if on_session is not None:
                    on_session(session)
            else:
                launcher.next_round(session, plan, cwd=cwd)
        except Exception as exc:  # noqa: BLE001 - report, never raise into the chain
            out.error = f"could not start Claude Code round {round_no}: {exc}"[:500]
            out.stop_reason = "launch_failed"
            break

        # ---- wait for the round to end ----------------------------------- #
        polls = 0
        ended = False
        while True:
            if plan.exit_path.exists():
                ended = True
                break
            if cancelled():
                launcher.kill(session, plans)
                out.cancelled = True
                out.stop_reason = "cancelled"
                break
            now = clock()
            if now >= deadline:
                launcher.kill(session, plans)
                out.timed_out = True
                out.stop_reason = "wall_clock"
                break
            if (
                round_no == 1
                and no_progress_abort_s is not None
                and now - started >= no_progress_abort_s
                and before is not None
                and fingerprint(cwd) == before
            ):
                launcher.kill(session, plans)
                out.stop_reason = "no_progress_first_write"
                break
            polls += 1
            if polls % _ALIVE_EVERY == 0 and launcher.alive(session) is False:
                if plan.exit_path.exists():
                    ended = True
                    break
                out.error = "the Claude Code session ended without finishing the round"
                out.stop_reason = "session_lost"
                break
            sleep(poll_s)

        try:
            stream = plan.stream_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            stream = ""
        result = parse_stream(stream)
        out.rounds.append(result)
        if result.session_id:
            out.session_id = result.session_id
            resume = result.session_id
        if not ended:
            break
        if not result.found:
            try:
                err = plan.stderr_path.read_text(encoding="utf-8", errors="replace")[-400:]
            except OSError:
                err = ""
            out.error = f"Claude Code round {round_no} ended with no result event: {err}".strip()
            out.stop_reason = "no_result"
            break
        if gate_check is None:
            out.stop_reason = "error" if result.is_error else "done"
            if result.is_error:
                out.error = (result.result_text or result.subtype or "error")[:500]
            break

        # ---- grade the tree inside the conversation ---------------------- #
        t0 = clock()
        verdict = gate_check()
        out.final_verdict = verdict
        out.gate_rounds.append(
            {
                "round": round_no,
                "passed": bool(verdict.passed),
                "reason": verdict.reason,
                "elapsed_s": round(clock() - t0, 1),
            }
        )
        if verdict.passed:
            out.stop_reason = "green"
            break
        if round_no >= max_rounds:
            out.stop_reason = "rounds_exhausted"
            break
        after = fingerprint(cwd)
        if before is not None and after is not None and before == after:
            out.stop_reason = "no_progress_between_rounds"
            break
        if deadline - clock() < MIN_ROUND_S:
            out.stop_reason = "no_time"
            break
        if not resume:
            out.stop_reason = "no_session_to_resume"
            break
        message = _feedback(verdict, round_no, max_rounds)

    # Killed mid-round (wall clock / no progress / lost session): grade the tree
    # as it stands, like the OpenHands soft deadline does. Never after a cancel.
    if (
        gate_check is not None
        and not out.cancelled
        and out.stop_reason in ("wall_clock", "no_progress_first_write", "session_lost")
    ):
        verdict = gate_check()
        out.final_verdict = verdict
        out.gate_rounds.append(
            {
                "round": len(out.rounds),
                "passed": bool(verdict.passed),
                "reason": verdict.reason,
                "elapsed_s": 0.0,
                "after": out.stop_reason,
            }
        )
    out.duration_s = round(clock() - started, 1)
    return out


__all__ = ["MIN_ROUND_S", "ConversationResult", "run_conversation"]
