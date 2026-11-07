"""compute_completeness + validate_direction cases."""

from __future__ import annotations

from pathlib import Path

from factory.backpressure.parser import compute_completeness
from factory.backpressure.validator import validate_direction
from factory.directions.creator import create_direction
from factory.directions.parser import parse_direction_dir


def _mk(tmp_path: Path, **kwargs):  # type: ignore[no-untyped-def]
    defaults = dict(
        app="sacrifice",
        title="Test direction",
        type_tag="feature",
        why="Test why",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    defaults.update(kwargs)
    out = create_direction(**defaults)
    return parse_direction_dir("sacrifice", out.dir_path)


def test_no_flow_no_api_no_explore_is_insufficient(tmp_path: Path) -> None:
    direction = _mk(tmp_path, acceptance=["AC one"])
    rep = compute_completeness(direction)
    assert rep.is_sufficient is False
    assert "user_flow" in rep.missing
    assert "api_spec" in rep.missing
    assert "explore_tag_or_artifacts" in rep.missing
    assert "acceptance_criteria" not in rep.missing  # AC present


def test_flow_only_is_sufficient(tmp_path: Path) -> None:
    direction = _mk(
        tmp_path,
        has_ui=True,
        flow_steps=["Click", "Verify"],
        acceptance=["AC"],
    )
    rep = compute_completeness(direction)
    assert rep.is_sufficient is True
    assert rep.has_flow is True
    assert "user_flow" not in rep.missing


def test_api_spec_only_is_sufficient(tmp_path: Path) -> None:
    direction = _mk(
        tmp_path,
        has_api=True,
        api_spec_lines=["- POST /healthz -> 200"],
        acceptance=["AC"],
    )
    rep = compute_completeness(direction)
    assert rep.is_sufficient is True
    assert rep.has_api_spec is True


def test_explore_only_is_sufficient(tmp_path: Path) -> None:
    direction = _mk(tmp_path, explore=True)
    rep = compute_completeness(direction)
    assert rep.is_sufficient is True
    assert rep.explore_tag is True


def test_flow_and_api_is_sufficient(tmp_path: Path) -> None:
    direction = _mk(
        tmp_path,
        has_ui=True,
        flow_steps=["Click"],
        has_api=True,
        api_spec_lines=["- GET /x -> 200"],
        acceptance=["AC"],
    )
    rep = compute_completeness(direction)
    assert rep.is_sufficient is True
    assert rep.has_flow is True
    assert rep.has_api_spec is True


def test_missing_acceptance_is_flagged_but_does_not_block(tmp_path: Path) -> None:
    direction = _mk(tmp_path, explore=True, acceptance=[])
    rep = compute_completeness(direction)
    assert rep.is_sufficient is True
    assert "acceptance_criteria" in rep.missing
    assert rep.has_acceptance is False


def test_validator_rejects_empty_flow_md(tmp_path: Path) -> None:
    direction = _mk(
        tmp_path,
        has_ui=True,
        flow_steps=[],  # produces a flow.md that's only a header + comment
        acceptance=["AC"],
    )
    # The created flow.md has only the placeholder comment + no real steps,
    # so the validator should treat it as not useful.
    result = validate_direction(direction)
    assert result.has_flow is False
    assert result.is_valid is False
    assert any("flow.md" in issue for issue in result.issues)


def test_validator_accepts_well_formed_api_spec(tmp_path: Path) -> None:
    direction = _mk(
        tmp_path,
        has_api=True,
        api_spec_lines=["- GET /healthz -> 200 OK"],
        acceptance=["AC"],
    )
    result = validate_direction(direction)
    assert result.is_valid is True
    assert result.has_api_spec is True


def test_validator_rejects_api_spec_without_method(tmp_path: Path) -> None:
    direction = _mk(
        tmp_path,
        has_api=True,
        api_spec_lines=["- /healthz -> 200"],  # no HTTP method
        acceptance=["AC"],
    )
    result = validate_direction(direction)
    assert result.has_api_spec is False
    assert any("HTTP method" in issue for issue in result.issues)
