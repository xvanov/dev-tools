"""A prose nudge must not spend wall clock the run does not have.

The continuation borrows the SAME `asyncio.wait_for` budget as the original run,
and `max_iteration_per_run` resets on every `run()` — so a nudge gets a fresh
600-iteration budget and no time of its own.

Measured on the live sacrifice trajectories: the ONE run that would have been
nudged (story 178) had already burned **1663 s of its 1800 s**, and 9 of the last
60 live dev runs exceeded 1200 s.

If the wall clock fires mid-continuation, the `TimeoutError` path returns
`test_run_passed=False, files_changed=[]` and the chain's test command NEVER RUNS
— so a tree that may have been green is never graded, a dev retry is burned, the
`files_touched` retry memory is lost, and the resulting timeout tail carries no
test results, so the stall guard cannot catch the repeat either. The rescue would
manufacture a worse failure than the one it fixes.
"""

from __future__ import annotations

import inspect

from factory import runner as R


def test_a_reserve_exists_and_leaves_real_headroom() -> None:
    assert 0.0 < R._PROSE_CONTINUATION_TIME_RESERVE < 1.0
    # 1800 s default: the nudge must be refused with less than ~450 s left, which
    # covers the measured 1663/1800 case.
    remaining = (1.0 - R._PROSE_CONTINUATION_TIME_RESERVE) * 1800
    assert remaining >= 300, f"only {remaining:.0f}s reserved for a continuation"
    assert 1663 > R._PROSE_CONTINUATION_TIME_RESERVE * 1800, (
        "story 178's real run would still have been nudged at 1663/1800"
    )


def test_the_loop_checks_elapsed_time_before_nudging() -> None:
    src = inspect.getsource(R.sandbox_run)
    i = src.index("_MAX_PROSE_CONTINUATIONS")
    window = src[i : i + 3000]
    assert "_PROSE_CONTINUATION_TIME_RESERVE" in window
    assert "_elapsed()" in window
    # The check must come BEFORE the send/run pair, or it reserves nothing.
    assert window.index("_PROSE_CONTINUATION_TIME_RESERVE") < window.index(
        "send_message(_PROSE_CONTINUATION_NUDGE)"
    )


def test_a_skipped_nudge_is_recorded_not_silent() -> None:
    """"We detected a truncation and chose not to act" must be distinguishable
    from "there was nothing to do"."""
    src = inspect.getsource(R.sandbox_run)
    assert "skipped_no_time" in src


def test_the_nudge_count_reaches_the_dev_attempt_record() -> None:
    """It was declared, set, and read by nothing but a unit test — so on the live
    chain an operator could not tell a rescued run from a clean one."""
    from factory.chain import handlers as H

    src = inspect.getsource(H._handle_dev_once)
    assert '"prose_continuations"' in src
    assert 'getattr(run_res, "prose_continuations", 0)' in src
