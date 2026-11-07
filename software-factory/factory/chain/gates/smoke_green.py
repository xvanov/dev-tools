"""Gate: ``smoke-green``.

Karpathy Layer-2 "external signal" (D002). The factory's other gates verify
the code statically — unit/integration tests (``tests-green``), slop detection
(``tests-meaningful``), lint/types. None of them BOOT the product. The full
sacrifice backlog shipped with every gate green while the running app could
not log in, because nothing ever started it. This gate is the runtime oracle
that closes that class: it runs ``app_config.gates.smoke_command``, which is
expected to stand up the stack and exercise one real user journey
(sign-up → login → core action), and reports whether the product actually runs.

Per-app opt-in (regression-safe). When the app has not declared a smoke
harness this gate PASSES (skips) — exactly like the optional lint/format/types
gates — and ``required_gate_labels`` does NOT add ``smoke-green`` to the
merge-required set. Only when ``smoke_harness_ready`` is True does the gate
both run for real AND become required. This keeps apps without a harness
unaffected (no new merge blocks), avoiding the PRs 110/111 deadlock where a
universally-required gate blocked every merge.

Real-run vs dry-run: in real-run with a local checkout we shell out and run
the command. Without one there is no evidence the product boots, so the gate
FAILS CLOSED — it accepts no recorded stand-in for an actual runtime
observation.
"""

from __future__ import annotations

from factory.app_config import AppConfig
from factory.chain.gates.evaluator import GateResult, PRContext, _run_command


def evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:
    label = "smoke-green"
    gates = app_config.gates

    # Not opted in: skip (pass). Mirrors the optional command gates — a missing
    # capability means "this gate does not apply", not "this gate fails".
    if not gates.smoke_harness_ready or not gates.smoke_command:
        return GateResult(
            label=label,
            passed=True,
            reason="no smoke harness configured (skipped)",
            details={
                "smoke_harness_ready": gates.smoke_harness_ready,
                "configured": bool(gates.smoke_command),
            },
        )

    # Real-run with a local checkout: boot the stack and run the journey.
    if not pr.dry_run and pr.repo_root is not None:
        code, output = _run_command(gates.smoke_command, pr.repo_root)
        return GateResult(
            label=label,
            passed=code == 0,
            reason=f"smoke_command exit={code}",
            details={"exit_code": code, "output_tail": output},
        )

    # Dry-run (or real-run with no checkout): FAIL CLOSED. There is no
    # substitute for having booted the product.
    #
    # This branch used to pass the gate when ``story.smoke_passed`` was True,
    # described as "trust the dev handler's recorded flag". No dev handler ever
    # set it: ``StoryRecord.smoke_passed`` (state_machine.py) was declared and
    # read here and assigned NOWHERE in ``factory/**`` — the ``smoke_passed``
    # writes in ``factory/deploy/orchestrator.py`` are on ``DeployAction``, a
    # different object. So the flag was always None, the pass branch was
    # unreachable, and the gate was fail-closed only by accident.
    #
    # A gate keyed on a never-written flag is textbook proxy != real: the
    # moment anything started writing it, a merge could be waved through on a
    # recorded boolean instead of a runtime observation. Deleting the reader
    # makes the fail-closed posture structural rather than accidental, and
    # changes no observable behaviour today.
    return GateResult(
        label=label,
        passed=False,
        reason="smoke harness required but the smoke command was not run (no local checkout)",
        details={"dry_run": pr.dry_run, "has_repo_root": pr.repo_root is not None},
    )
