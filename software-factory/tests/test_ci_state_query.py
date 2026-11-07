"""Unit tests for ``_query_ci_state`` — the real-CI conclusion query that
replaced the hardcoded ``ci_state="success"`` in the auto-merge worker.

These pin the parsing of ``gh pr checks --required`` output (tab-separated
rows) so a green string literal can never again masquerade as a real CI pass
(the "thinks CI passed then it crashes" regression class). Note gh v2.45's
``gh pr checks`` does NOT support ``--json`` — the query parses rows, and the
"no required checks reported" case MUST map to None, not "success".
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from factory.chain.auto_merge import _query_ci_state

APP = SimpleNamespace(repo="acme/widget")


def _fake_run(stdout: str, *, stderr: str = "", returncode: int = 0, raise_exc=None):
    def _run(cmd, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if raise_exc is not None:
            raise raise_exc
        return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr=stderr)

    return _run


def _rows(*pairs: tuple[str, str]) -> str:
    # Mimic gh's tab-separated "<name>\t<status>\t<elapsed>\t<url>" rows.
    return "\n".join(f"{name}\t{status}\t10s\thttps://x/{name}" for name, status in pairs)


@pytest.mark.parametrize(
    ("rows", "expected"),
    [
        (_rows(("lint", "pass"), ("pytest", "pass")), "success"),
        (_rows(("lint", "pass"), ("pytest", "fail")), "failure"),
        (_rows(("lint", "pass"), ("pytest", "pending")), "pending"),
        (_rows(("lint", "cancel")), "failure"),
        (_rows(("lint", "pass"), ("cov", "skipping")), "success"),
    ],
)
def test_status_reduction(monkeypatch, rows, expected):
    monkeypatch.setattr(subprocess, "run", _fake_run(rows))
    assert _query_ci_state(app_config=APP, pr_number=42) == expected


def test_no_required_checks_is_none_not_success(monkeypatch):
    # THE false-green trap: gh prints this and exits 0 when protection/required
    # checks are absent. Must be None (fall back to recorded flag), never
    # "success" — otherwise an unprotected repo fabricates a green CI signal.
    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_run("", stderr="no required checks reported on the 'main' branch", returncode=0),
    )
    assert _query_ci_state(app_config=APP, pr_number=42) is None


def test_no_checks_reported_is_none(monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", _fake_run("", stderr="no checks reported on the 'main' branch")
    )
    assert _query_ci_state(app_config=APP, pr_number=42) is None


def test_empty_output_returns_none(monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run(""))
    assert _query_ci_state(app_config=APP, pr_number=42) is None


def test_placeholder_pr_number_skips_query(monkeypatch):
    called = {"n": 0}

    def _boom(*a, **k):  # noqa: ANN002, ANN003
        called["n"] += 1
        raise AssertionError("should not run gh for placeholder PR")

    monkeypatch.setattr(subprocess, "run", _boom)
    assert _query_ci_state(app_config=APP, pr_number=-5) is None
    assert called["n"] == 0


def test_gh_missing_returns_none(monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run("", raise_exc=FileNotFoundError()))
    assert _query_ci_state(app_config=APP, pr_number=42) is None


def test_gh_timeout_returns_none(monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", _fake_run("", raise_exc=subprocess.TimeoutExpired("gh", 60))
    )
    assert _query_ci_state(app_config=APP, pr_number=42) is None


# --------------------------------------------------------------------------- #
# E6 STAGE 2 — `main-green` is an ENVIRONMENT HOLD, not a PR defect.
#
# Once `main-green` is a REQUIRED check, a PR whose `main-green` ran while main
# was red carries a red required aggregate. (Not EVERY open PR: GitHub does not
# re-run pull_request checks when the base moves, so already-open PRs keep the
# green they were computed with — see auto_merge._CI_STATE_HOLD.) Reading that
# red as "this PR failed CI" would burn a dev run on tick 1 and CLOSE the PR +
# terminally park the story on tick 2.
# So a red set whose ONLY red member is `main-green` must classify as "hold".
# Everything else — including main-green red ALONGSIDE a real red — keeps the
# historical "failure" verdict. The hold only ever SUPPRESSES action; it can
# never wave a real failure through, because tests-green passes on "success"
# alone.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("rows", "expected", "why"),
    [
        (
            _rows(("main-green", "fail"), ("lint", "pass"), ("pytest (1)", "pass")),
            "hold",
            "only main-green is red -> environment hold",
        ),
        (
            _rows(("main-green", "fail")),
            "hold",
            "main-green is the only required check at all",
        ),
        (
            _rows(("main-green", "fail"), ("pytest (1)", "pending")),
            "hold",
            "a PENDING sibling is not a red one",
        ),
        (
            _rows(("main-green", "fail"), ("pytest (1)", "fail")),
            "failure",
            "a REAL red alongside main-green is a genuine CI failure",
        ),
        (
            _rows(("main-green", "fail"), ("lint", "cancel")),
            "failure",
            "any second red bucket, even an infra one, is today's path",
        ),
        (
            _rows(("main-green", "pending"), ("pytest (1)", "pass")),
            "pending",
            "main-green not yet reported is just pending",
        ),
        (
            _rows(("main-green", "pass"), ("pytest (1)", "pass")),
            "success",
            "green main-green does not change the green verdict",
        ),
        (
            _rows(("Main-Green", "fail"), ("lint", "pass")),
            "hold",
            "check names are matched case-insensitively",
        ),
    ],
)
def test_main_green_hold_classification(monkeypatch, rows, expected, why):
    monkeypatch.setattr(subprocess, "run", _fake_run(rows))
    assert _query_ci_state(app_config=APP, pr_number=42) == expected, why


def test_unnamed_failing_row_is_never_a_hold(monkeypatch):
    # FAIL DIRECTION: if we cannot NAME a failing required check, we must not
    # discount it as an environment hold — a hold that swallows an unparseable
    # red is exactly the "wave a real failure through" bug. Falls back to the
    # historical failure path.
    rows = "\tfail\t10s\thttps://x/mystery\nmain-green\tfail\t10s\thttps://x/main-green"
    monkeypatch.setattr(subprocess, "run", _fake_run(rows))
    assert _query_ci_state(app_config=APP, pr_number=42) == "failure"
