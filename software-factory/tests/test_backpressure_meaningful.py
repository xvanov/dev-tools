"""Tests for ``factory.backpressure.parser`` helpers added in Phase 3."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.backpressure.parser import (
    extract_acceptance_criteria,
    has_meaningful_api_spec,
    has_meaningful_flow,
)
from factory.backpressure.validator import validate_direction
from factory.directions.parser import parse_direction_dir


def _write_direction(
    root: Path,
    *,
    name: str = "002-add-healthz-endpoint",
    flow: str | None = None,
    api: str | None = None,
    acceptance: list[str] | None = None,
    explore: bool = False,
) -> Path:
    d = root / "apps" / "sacrifice" / "directions" / name
    d.mkdir(parents=True, exist_ok=True)
    ac_block = ""
    if acceptance:
        ac_block = "## Acceptance Criteria\n\n" + "\n".join(f"- {a}" for a in acceptance) + "\n"
    fm = "---\ntitle: thing\n"
    if explore:
        fm += "explore: true\n"
    fm += "---\n\n"
    (d / "direction.md").write_text(f"{fm}# thing\n\n## Why\nbecause.\n\n{ac_block}", "utf-8")
    if flow is not None:
        (d / "flow.md").write_text(flow, "utf-8")
    if api is not None:
        (d / "api_spec.md").write_text(api, "utf-8")
    return d


def test_extract_acceptance_criteria_returns_bullets_verbatim(tmp_path: Path) -> None:
    d = _write_direction(
        tmp_path,
        acceptance=["p95 latency < 200ms", "Returns 200 on success"],
    )
    direction = parse_direction_dir("sacrifice", d)
    ac = extract_acceptance_criteria(direction)
    assert ac == ["p95 latency < 200ms", "Returns 200 on success"]


def test_meaningful_flow_passes_with_two_verb_steps(tmp_path: Path) -> None:
    flow = (
        "# Flow\n\n"
        "1. User taps the `Pledge` button.\n"
        "2. User enters $5 and submits the form.\n"
        "3. User sees a `Pledged $5` toast.\n"
    )
    d = _write_direction(tmp_path, flow=flow)
    direction = parse_direction_dir("sacrifice", d)
    assert has_meaningful_flow(direction)


def test_meaningful_flow_fails_with_no_verbs(tmp_path: Path) -> None:
    flow = "# Flow\n\n1. step one\n2. step two\n"
    d = _write_direction(tmp_path, flow=flow)
    direction = parse_direction_dir("sacrifice", d)
    assert not has_meaningful_flow(direction)


def test_meaningful_flow_fails_with_one_step(tmp_path: Path) -> None:
    flow = "# Flow\n\n1. User taps `Pledge`.\n"
    d = _write_direction(tmp_path, flow=flow)
    direction = parse_direction_dir("sacrifice", d)
    assert not has_meaningful_flow(direction)


def test_meaningful_flow_returns_false_when_no_flow_md(tmp_path: Path) -> None:
    d = _write_direction(tmp_path)  # no flow.md
    direction = parse_direction_dir("sacrifice", d)
    assert not has_meaningful_flow(direction)


def test_meaningful_api_spec_passes(tmp_path: Path) -> None:
    api = "`GET /healthz` -> 200 returns `{version, status}`\n"
    d = _write_direction(tmp_path, api=api)
    direction = parse_direction_dir("sacrifice", d)
    assert has_meaningful_api_spec(direction)


def test_meaningful_api_spec_fails_without_method(tmp_path: Path) -> None:
    api = "/healthz -> returns 200 OK\n"
    d = _write_direction(tmp_path, api=api)
    direction = parse_direction_dir("sacrifice", d)
    assert not has_meaningful_api_spec(direction)


def test_meaningful_api_spec_fails_without_response_code(tmp_path: Path) -> None:
    api = "GET /healthz -> returns the version\n"
    d = _write_direction(tmp_path, api=api)
    direction = parse_direction_dir("sacrifice", d)
    assert not has_meaningful_api_spec(direction)


def test_meaningful_api_spec_fails_without_path(tmp_path: Path) -> None:
    api = "GET healthz returns 200\n"  # no leading slash
    d = _write_direction(tmp_path, api=api)
    direction = parse_direction_dir("sacrifice", d)
    assert not has_meaningful_api_spec(direction)


@pytest.mark.parametrize(
    "flow,api,want_severity",
    [
        # Rich flow + AC -> ok
        ("1. User taps `Pledge`.\n2. User sees `Pledged $5` toast.\n", None, "ok"),
        # Thin flow (steps but no verbs) -> warning (still sufficient via steps).
        ("1. step one\n2. step two\n", None, "warning"),
        # API spec with method+path but no response code -> warning.
        (None, "GET /healthz returns the version\n", "warning"),
        # No artifacts at all -> blocking.
        (None, None, "blocking"),
    ],
)
def test_validator_severity_field(
    tmp_path: Path, flow: str | None, api: str | None, want_severity: str
) -> None:
    d = _write_direction(tmp_path, flow=flow, api=api, acceptance=["AC"])
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.severity == want_severity, (
        f"got {result.severity!r} structural_issues={result.structural_issues!r} "
        f"missing={result.missing!r}"
    )


# ---------------------------------------------------------------------------
# Vacuity gate (019 AC1 / Flow A) wired into validate_direction
# ---------------------------------------------------------------------------


def test_all_vacuous_acceptance_blocks_even_with_flow_and_api(tmp_path: Path) -> None:
    """An all-vacuous criteria set must block regardless of flow/api-spec
    sufficiency — Flow A step 3: 'is_sufficient=False regardless of
    flow/api-spec'."""
    flow = "1. User taps `Reset`.\n2. User sees the confirmation screen.\n"
    d = _write_direction(
        tmp_path,
        flow=flow,
        acceptance=["returns 202", "the token is not in the response body", "no error is raised"],
    )
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.is_valid is False
    assert result.severity == "blocking"
    assert "vacuous_criteria" in result.missing
    assert result.vacuity is not None
    assert result.vacuity.all_vacuous is True
    assert any("returns 202" in issue for issue in result.issues)
    # Names each vacuous criterion and shows a rewritten example.
    assert any("Rewrite" in issue or "rewrite" in issue for issue in result.issues)


def test_one_positive_criterion_passes_with_warnings(tmp_path: Path) -> None:
    """At least one positive-observable criterion -> triage proceeds; the
    vacuous ones are recorded as warnings, not blockers — Flow A step 4."""
    flow = "1. User taps `Reset`.\n2. User sees the confirmation screen.\n"
    d = _write_direction(
        tmp_path,
        flow=flow,
        acceptance=[
            "returns 202",
            "an email arrives containing a link that opens a working reset form",
        ],
    )
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.is_valid is True
    assert "vacuous_criteria" not in result.missing
    assert result.vacuity is not None
    assert result.vacuity.all_vacuous is False
    assert any("returns 202" in issue for issue in result.structural_issues)
    assert result.severity == "warning"


def test_all_positive_criteria_has_no_vacuity_warnings(tmp_path: Path) -> None:
    flow = "1. User taps `Reset`.\n2. User sees the confirmation screen.\n"
    d = _write_direction(
        tmp_path,
        flow=flow,
        acceptance=["an email arrives containing a link"],
    )
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.is_valid is True
    assert result.structural_issues == []
    assert result.severity == "ok"


def test_empty_acceptance_skips_vacuity_gate(tmp_path: Path) -> None:
    """No criteria to classify -> the gate has nothing to say; the existing
    'acceptance_criteria' missing-marker behavior is unaffected."""
    d = _write_direction(tmp_path, explore=True, acceptance=[])
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.vacuity is None
    assert "vacuous_criteria" not in result.missing


# ---------------------------------------------------------------------------
# F2/F3 — explore-tagged directions must NEVER be blocked on vacuity.
# ``explore: true`` exists precisely so machine-filed repair/finding
# directions (scheduled personas — see ci_health.py, scheduled_tasks.py)
# aren't wedged at needs-direction when their acceptance criteria are terse
# (the 2026-07-06 incident). An all-vacuous explore-tagged direction is
# demoted to a warning, not blocked.
# ---------------------------------------------------------------------------


def test_explore_tagged_all_vacuous_direction_is_not_blocked(tmp_path: Path) -> None:
    d = _write_direction(
        tmp_path,
        explore=True,
        acceptance=["returns 202", "does not leak the token", "no error is raised"],
    )
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.is_valid is True, result.issues
    assert "vacuous_criteria" not in result.missing
    assert result.vacuity is not None
    assert result.vacuity.all_vacuous is True
    # Demoted to a warning, not silently dropped.
    assert any("returns 202" in w for w in result.structural_issues)
    assert result.severity == "warning"


def test_non_explore_all_vacuous_direction_still_blocks(tmp_path: Path) -> None:
    """Regression guard: the explore exemption must be narrowly scoped —a
    non-explore direction with the same all-vacuous criteria set must still
    block exactly as before."""
    flow = "1. User taps `Reset`.\n2. User sees the confirmation screen.\n"
    d = _write_direction(
        tmp_path,
        flow=flow,
        acceptance=["returns 202", "does not leak the token", "no error is raised"],
    )
    direction = parse_direction_dir("sacrifice", d)
    result = validate_direction(direction)
    assert result.is_valid is False
    assert "vacuous_criteria" in result.missing
    assert result.severity == "blocking"
