"""create_direction behavior — pure (non-interactive)."""

from __future__ import annotations

from pathlib import Path

import yaml

from factory.directions.creator import create_direction
from factory.directions.parser import parse_direction_dir


def test_creates_minimal_direction(tmp_path: Path) -> None:
    out = create_direction(
        app="sacrifice",
        title="Add a thing",
        type_tag="feature",
        why="Because users keep asking for it.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["Feature exists in the UI", "Tests cover it"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )

    assert out.dir_path.exists()
    assert out.dir_path.name == "001-add-a-thing"
    assert (out.dir_path / "direction.md").exists()
    assert not (out.dir_path / "flow.md").exists()
    assert not (out.dir_path / "api_spec.md").exists()
    assert (out.dir_path / "state.yaml").exists()

    # Round-trip through the parser to verify everything reads back.
    parsed = parse_direction_dir("sacrifice", out.dir_path)
    assert parsed.title == "Add a thing"
    assert parsed.type_tag == "feature"
    assert parsed.has_flow is False
    assert parsed.has_api_spec is False
    assert parsed.acceptance == ["Feature exists in the UI", "Tests cover it"]
    assert parsed.status == "created"

    state = yaml.safe_load((out.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "created"
    assert state["source"] == "cli"
    assert len(state["audit"]) == 1
    assert state["audit"][0]["event"] == "created"


def test_creates_with_flow_and_api(tmp_path: Path) -> None:
    out = create_direction(
        app="sacrifice",
        title="Add healthz endpoint",
        type_tag="feature",
        why="Smoke test wants a stable endpoint.",
        has_ui=True,
        flow_steps=["User opens admin panel", "User clicks 'Run health check'"],
        has_api=True,
        api_spec_lines=['- `GET /healthz` -> 200 {"version":str,"status":"ok"}'],
        acceptance=["Endpoint returns 200", "Returns JSON with version + status"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )

    flow_content = (out.dir_path / "flow.md").read_text(encoding="utf-8")
    assert "User opens admin panel" in flow_content
    assert "1." in flow_content and "2." in flow_content

    api_content = (out.dir_path / "api_spec.md").read_text(encoding="utf-8")
    assert "/healthz" in api_content

    parsed = parse_direction_dir("sacrifice", out.dir_path)
    assert parsed.has_flow is True
    assert parsed.has_api_spec is True


def test_increments_id_across_creations(tmp_path: Path) -> None:
    out1 = create_direction(
        app="sacrifice",
        title="One",
        type_tag="feature",
        why="x",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    out2 = create_direction(
        app="sacrifice",
        title="Two",
        type_tag="feature",
        why="y",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    assert out1.dir_path.name == "001-one"
    assert out2.dir_path.name == "002-two"


def test_attach_files_copied(tmp_path: Path) -> None:
    artifact_src = tmp_path / "mockup.png"
    artifact_src.write_bytes(b"\x89PNG\r\nfake\n")
    out = create_direction(
        app="sacrifice",
        title="With artifact",
        type_tag="feature",
        why="x",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=True,
        attach_files=[artifact_src],
        software_factory_root=tmp_path,
    )
    dest = out.dir_path / "artifacts" / "mockup.png"
    assert dest.exists()
    assert dest.read_bytes() == artifact_src.read_bytes()


def test_frontmatter_explore_persists(tmp_path: Path) -> None:
    out = create_direction(
        app="sacrifice",
        title="Explore mode",
        type_tag="feature",
        why="x",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    parsed = parse_direction_dir("sacrifice", out.dir_path)
    assert parsed.explore_tag is True
