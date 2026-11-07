"""A red dev attempt must tell the retry WHY tests failed, not just which.

sacrifice's ``test_command`` is ``cd backend && uv run --extra dev pytest -q
tests/``. ``uv run`` re-syncs the environment on every invocation and writes
that chatter to **stderr**, which ``_run_pytest`` appends AFTER pytest's stdout.
The persisted signal is a TAIL (``summary[-2000:]`` then
``test_output_tail[-1800:]``), so the bootstrap lines evict exactly the
assertion detail the next attempt needs.

Measured on story 178, attempt 1: of an 1800-char tail, ~400 chars were
bootstrap noise, and the survivor held FAILED test NAMES with no ``assert`` and
no traceback anywhere.
"""

from __future__ import annotations

from factory.runner import _strip_bootstrap_noise


def test_bootstrap_lines_are_dropped() -> None:
    raw = "\n".join(
        [
            "Using CPython 3.12.3 interpreter at: /usr/bin/python3",
            "Creating virtual environment at: .venv",
            "   Building sacrifice-backend @ file:///x/backend",
            "      Built sacrifice-backend @ file:///x/backend",
            "Installed 83 packages in 12ms",
            "Resolved 375 packages in 0.50ms",
            "Audited 209 packages in 0.87ms",
        ]
    )
    assert _strip_bootstrap_noise(raw).strip() == ""


def test_real_failure_detail_is_preserved_verbatim() -> None:
    raw = "\n".join(
        [
            "FAILED tests/test_email_auth.py::test_verify - AssertionError",
            "E       assert 400 == 200",
            'E        +  where 400 = <Response [400]>.status_code',
            "Traceback (most recent call last):",
            '  File "tests/test_email_auth.py", line 42, in test_verify',
            "Installed 83 packages in 12ms",
        ]
    )
    out = _strip_bootstrap_noise(raw)
    assert "assert 400 == 200" in out
    assert "Traceback (most recent call last):" in out
    assert "Installed 83 packages" not in out


def test_unrecognised_lines_are_kept() -> None:
    """CONTROL — the filter must never guess. Losing detail is the bug."""
    raw = "some tool said Installing things\nBuildingBlocks failed to import"
    out = _strip_bootstrap_noise(raw)
    assert "some tool said Installing things" in out
    assert "BuildingBlocks failed to import" in out


def test_the_tail_now_carries_why_not_just_which() -> None:
    """End-to-end shape: the story-178 case, budgeted to 1800 chars."""
    noise = "\n".join(
        [
            "Using CPython 3.12.3 interpreter at: /usr/bin/python3",
            "Creating virtual environment at: .venv",
            "   Building sacrifice-backend @ file:///very/long/worktree/path/backend",
            "      Built sacrifice-backend @ file:///very/long/worktree/path/backend",
            "Installed 83 packages in 12ms",
        ]
    )
    detail = "\n".join(
        [f"E       assert response.status_code == 200, got 403  # line {i}" for i in range(40)]
    )
    raw = f"FAILED tests/test_x.py::test_y\n{detail}\n{noise}"

    before = raw[-1800:]
    after = _strip_bootstrap_noise(raw)[-1800:]

    assert "Installed 83 packages" in before, "precondition: noise used to reach the tail"
    assert "Installed 83 packages" not in after
    assert after.count("assert response.status_code") > before.count("assert response.status_code")


def test_empty_and_whitespace_inputs_are_safe() -> None:
    """No content to lose, and no raise. Trailing-newline normalisation from
    ``splitlines()``/``join()`` is accepted — this output is only ever read as
    a human/LLM-facing tail, never parsed."""
    assert _strip_bootstrap_noise("") == ""
    assert _strip_bootstrap_noise("\n\n").strip() == ""
    assert _strip_bootstrap_noise("one line").strip() == "one line"
