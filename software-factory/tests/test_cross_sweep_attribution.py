"""The 37% → 53% move is not a machinery result, and the docs must not say it is.

Two committed archives measure the `factory` arm on the same 19 pinned
instances. The tempting reading of the move — "we removed machinery losses" —
is refuted by the archives themselves: **every** gained row had already produced
a real, non-empty patch in sweep 1, graded `right_place_wrong_fix`. There was no
subtraction on any of them to lift. Meanwhile the machinery's own losses got
worse (empty-patch rows 1 → 3) and one sweep-1 resolve was lost.

This file makes the decomposition **executable** rather than editorial. Two
halves, and both are needed:

* the numbers are re-derived from `results-archive/` on every run, so a claim in
  `README.md` / `STATUS.md` cannot drift away from the evidence;
* the documented sentences must be PRESENT, not merely un-contradicted. A test
  that only asserted "the docs do not say 'machinery'" would be satisfied by
  deleting the paragraph — the criterion-vacuity failure this repo has already
  been bitten by.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_ARCHIVES = _ROOT / "bench" / "swebench" / "results-archive"
_SWEEP_1 = _ARCHIVES / "2026-08-04T23-19-24.998844Z"
_SWEEP_2 = _ARCHIVES / "2026-08-10T21-53-14.959258Z"

# The four rows sweep 2 gained, and the sweep-1 diff size each already had.
# These bytes are the whole argument: a row with a 15,039-byte wrong patch was
# not being blocked by the machinery.
_GAINED_WITH_SWEEP1_DIFF_BYTES = {
    "conan-io__conan-19735_interface": 1360,
    "hiero-ledger__hiero-sdk-python-1914_interface": 15039,
    "pyinfra-dev__pyinfra-1665": 1072,
    "raullenchai__rapid-mlx-289": 8341,
}
_LOST = {"jsonpickle__jsonpickle-588"}
_EMPTY_SWEEP_1 = {"harumiweb__exstruct-113"}
_EMPTY_SWEEP_2 = {
    "conan-io__conan-19750",
    "tox-dev__tox-3931",
    "vyperlang__vyper-4801",
}


def _factory_rows(archive: Path) -> dict[str, dict[str, Any]]:
    if not archive.is_dir():
        pytest.skip(f"{archive} is not present in this checkout")
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(archive.glob("*/factory/result.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        out[p.parent.parent.name] = d
    return out


def _resolved(row: dict[str, Any]) -> bool | None:
    grade = row.get("grade") or {}
    return grade.get("oracle_resolved")


@pytest.fixture(scope="module")
def sweeps() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    return _factory_rows(_SWEEP_1), _factory_rows(_SWEEP_2)


def test_the_move_is_plus_four_minus_one_on_identical_instances(
    sweeps: tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]],
) -> None:
    s1, s2 = sweeps
    assert set(s1) == set(s2), "the two sweeps did not measure the same instances"
    assert len(s1) == 19
    assert sum(1 for r in s1.values() if _resolved(r)) == 7
    assert sum(1 for r in s2.values() if _resolved(r)) == 10

    gained = {k for k in s2 if _resolved(s2[k]) and not _resolved(s1[k])}
    lost = {k for k in s2 if not _resolved(s2[k]) and _resolved(s1[k])}
    assert gained == set(_GAINED_WITH_SWEEP1_DIFF_BYTES), gained
    assert lost == _LOST, lost


def test_no_gained_row_was_a_machinery_loss_being_lifted(
    sweeps: tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]],
) -> None:
    """The load-bearing fact. Each gained row already had a real patch that was
    GRADED and found wrong — not an empty diff, not a park, not a block. So there
    was nothing for a machinery fix to un-subtract, and the dev produced a
    different, correct patch instead."""
    s1, s2 = sweeps
    for iid, expected_bytes in _GAINED_WITH_SWEEP1_DIFF_BYTES.items():
        before = s1[iid]
        assert before["diff_bytes"] == expected_bytes, iid
        assert before["diff_bytes"] > 0, iid
        assert (before.get("grade") or {}).get("outcome") == "right_place_wrong_fix", iid
        # And in sweep 2 it landed first try: no retry budget was involved.
        assert _dev_retries(s2[iid]) == 0, iid


def _dev_retries(row: dict[str, Any]) -> int | None:
    for container in (row, row.get("chain") or {}):
        if isinstance(container, dict) and "dev_retries" in container:
            return int(container["dev_retries"])
    return None


def test_the_machinery_losses_got_worse_not_better(
    sweeps: tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]],
) -> None:
    """The counter-evidence to any "we fixed the machinery" reading: the number
    of rows that shipped ZERO bytes tripled."""
    s1, s2 = sweeps
    empty1 = {k for k, r in s1.items() if (r.get("diff_bytes") or 0) == 0}
    empty2 = {k for k, r in s2.items() if (r.get("diff_bytes") or 0) == 0}
    assert empty1 == _EMPTY_SWEEP_1, empty1
    assert empty2 == _EMPTY_SWEEP_2, empty2
    assert len(empty2) > len(empty1)


def test_the_confounds_are_at_least_six_and_named(sweeps: Any) -> None:
    """The sweep-2 pre-registration disclosed four changes. Four MORE landed in
    `factory/runner.py` between the sweeps, each altering what the dev sees on a
    retry — so the disclosure list was incomplete, and the docs must name the
    real count."""
    for doc in ("README.md", "STATUS.md"):
        text = (_ROOT / doc).read_text(encoding="utf-8")
        assert "runner.py" in text, f"{doc} does not name the undisclosed confounds"
        for pr in ("#267", "#270", "#273", "#276"):
            assert pr in text, f"{doc} does not name {pr}"


def test_the_docs_state_the_decomposition_and_do_not_credit_the_machinery(
    sweeps: Any,
) -> None:
    """PRESENCE first, absence second. A test that only forbade the wrong claim
    would be satisfied by deleting the paragraph."""
    status = (_ROOT / "STATUS.md").read_text(encoding="utf-8")
    readme = (_ROOT / "README.md").read_text(encoding="utf-8")

    assert "NOT a machinery result" in status
    assert "not a machinery result" in readme
    for text in (status, readme):
        assert "+4 / −1" in text or "+4 / -1" in text
        assert "zero" in text and "retries" in text
        assert "1 → 3" in text or "1 -> 3" in text
    # Every sweep-1 diff size that carries the argument is quoted somewhere.
    for n in ("1,360", "15,039", "1,072", "8,341"):
        assert n in status, n

    # And the test that backs the paragraph is named in it, so a reader can run
    # the claim rather than trust it.
    assert "test_cross_sweep_attribution" in status
    assert "test_cross_sweep_attribution" in readme
