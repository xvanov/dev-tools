"""parse_direction_dir behavior."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from factory.directions.parser import (
    Direction,
    DirectionChainCycleError,
    MissingDirection,
    next_direction_id,
    parse_direction_dir,
    resolve_direction_chain,
)


def _write_direction_md(
    dir_path: Path,
    *,
    title: str,
    type_tag: str | None = "feature",
    explore: bool = False,
    body_extra: str = "",
    acceptance: list[str] | None = None,
    parent_direction: str | None = None,
    related_directions: list[str] | None = None,
) -> None:
    fm: dict[str, Any] = {
        "title": title,
        "type": type_tag or "",
        "priority": "p2",
        "explore": explore,
        "created_at": "2025-01-01T00:00:00+00:00",
    }
    if parent_direction:
        fm["parent_direction"] = parent_direction
    if related_directions:
        fm["related_directions"] = related_directions
    ac_lines = ""
    if acceptance is not None:
        ac_lines = "\n".join(f"- [ ] {item}" for item in acceptance)
    body = f"""---
{yaml.safe_dump(fm, sort_keys=False).strip()}
---

# {title}

## Why

{body_extra or "Because reasons."}

## Acceptance Criteria

{ac_lines}
"""
    (dir_path / "direction.md").write_text(body, encoding="utf-8")


def test_minimal_direction_title_and_why(tmp_path: Path) -> None:
    d = tmp_path / "001-minimal"
    d.mkdir()
    _write_direction_md(d, title="Minimal one", acceptance=["AC one"])
    direction = parse_direction_dir("sacrifice", d)

    assert direction.id == "001"
    assert direction.slug == "minimal"
    assert direction.title == "Minimal one"
    assert direction.type_tag == "feature"
    assert direction.why is not None and "Because reasons" in direction.why
    assert direction.acceptance == ["AC one"]
    assert direction.has_flow is False
    assert direction.has_api_spec is False
    assert direction.explore_tag is False
    assert direction.artifacts_paths == []
    assert direction.status == "created"
    assert isinstance(direction, Direction)


def test_direction_with_flow_md(tmp_path: Path) -> None:
    d = tmp_path / "002-has-flow"
    d.mkdir()
    _write_direction_md(d, title="Has flow")
    (d / "flow.md").write_text("# flow\n1. Click submit\n2. See toast\n", encoding="utf-8")
    direction = parse_direction_dir("sacrifice", d)
    assert direction.has_flow is True
    assert direction.has_api_spec is False


def test_direction_with_api_spec_md(tmp_path: Path) -> None:
    d = tmp_path / "003-has-api"
    d.mkdir()
    _write_direction_md(d, title="Has api")
    (d / "api_spec.md").write_text(
        '# api\n- POST /healthz -> 200 {"status":"ok"}\n', encoding="utf-8"
    )
    direction = parse_direction_dir("sacrifice", d)
    assert direction.has_api_spec is True
    assert direction.has_flow is False


def test_direction_with_artifacts(tmp_path: Path) -> None:
    d = tmp_path / "004-has-art"
    d.mkdir()
    _write_direction_md(d, title="Has art")
    (d / "artifacts").mkdir()
    (d / "artifacts" / "screenshot.png").write_bytes(b"\x89PNG\r\n")
    (d / "artifacts" / "sample.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    direction = parse_direction_dir("sacrifice", d)
    assert len(direction.artifacts_paths) == 2
    names = sorted(p.name for p in direction.artifacts_paths)
    assert names == ["sample.csv", "screenshot.png"]


def test_direction_with_explore_tag(tmp_path: Path) -> None:
    d = tmp_path / "005-explore"
    d.mkdir()
    _write_direction_md(d, title="Explore one", explore=True)
    direction = parse_direction_dir("sacrifice", d)
    assert direction.explore_tag is True


def test_state_yaml_status_read(tmp_path: Path) -> None:
    d = tmp_path / "006-stateful"
    d.mkdir()
    _write_direction_md(d, title="With state")
    (d / "state.yaml").write_text(
        yaml.safe_dump({"status": "pm-validated", "tracker_issue": 42}),
        encoding="utf-8",
    )
    direction = parse_direction_dir("sacrifice", d)
    assert direction.status == "pm-validated"
    assert direction.state["tracker_issue"] == 42


def test_acceptance_multiline_bullet_joins_continuation_lines(tmp_path: Path) -> None:
    """A bullet whose text wraps onto indented continuation lines (this
    repo's own direction.md style — see 019 AC1) must be joined into one
    criterion string, not truncated at the first physical line. Downstream
    consumers (the vacuity classifier) need the whole sentence."""
    d = tmp_path / "007-multiline"
    d.mkdir()
    body = """---
title: Multiline
type: feature
priority: p2
explore: false
---

# Multiline

## Why

Because reasons.

## Acceptance Criteria

- [ ] **Vacuity gate at triage.** Given a direction whose acceptance criteria
  are all satisfiable by a fixed-response no-op, the direction goes to
  needs-direction.
- [ ] A second, single-line criterion.
"""
    (d / "direction.md").write_text(body, encoding="utf-8")
    direction = parse_direction_dir("sacrifice", d)
    assert len(direction.acceptance) == 2
    assert direction.acceptance[0] == (
        "**Vacuity gate at triage.** Given a direction whose acceptance criteria "
        "are all satisfiable by a fixed-response no-op, the direction goes to "
        "needs-direction."
    )
    assert direction.acceptance[1] == "A second, single-line criterion."


def test_acceptance_continuation_stops_at_blank_line(tmp_path: Path) -> None:
    """A blank line between a bullet and a freestanding paragraph must NOT
    pull that paragraph into the bullet — matches the pre-existing behavior
    for un-indented trailing prose."""
    d = tmp_path / "008-blank-stop"
    d.mkdir()
    body = """---
title: Blank stop
type: feature
priority: p2
explore: false
---

# Blank stop

## Acceptance Criteria

- [ ] First criterion, single line.

Some unrelated freestanding paragraph that is not a bullet.

- [ ] Second criterion.
"""
    (d / "direction.md").write_text(body, encoding="utf-8")
    direction = parse_direction_dir("sacrifice", d)
    assert direction.acceptance == ["First criterion, single line.", "Second criterion."]


def test_acceptance_continuation_stops_at_next_heading(tmp_path: Path) -> None:
    d = tmp_path / "009-heading-stop"
    d.mkdir()
    body = """---
title: Heading stop
type: feature
priority: p2
explore: false
---

# Heading stop

## Acceptance Criteria

- [ ] Only criterion, wraps onto
  this continuation line.

## Out of scope

- Not an acceptance criterion.
"""
    (d / "direction.md").write_text(body, encoding="utf-8")
    direction = parse_direction_dir("sacrifice", d)
    assert direction.acceptance == ["Only criterion, wraps onto this continuation line."]


def test_next_direction_id_empty(tmp_path: Path) -> None:
    # No apps/<app>/directions/ at all
    assert next_direction_id("sacrifice", tmp_path) == "001"


def test_next_direction_id_increments(tmp_path: Path) -> None:
    root = tmp_path
    base = root / "apps" / "sacrifice" / "directions"
    base.mkdir(parents=True)
    (base / "001-first").mkdir()
    (base / "002-second").mkdir()
    (base / "010-tenth").mkdir()
    (base / "not-a-direction").mkdir()
    assert next_direction_id("sacrifice", root) == "011"


# ─── chain resolution tests ─────────────────────────────────────────────


def _make_parent_on_disk(
    root: Path,
    id_slug: str,
    *,
    title: str | None = None,
    acceptance: list[str] | None = None,
    parent_direction: str | None = None,
) -> Path:
    """Create a minimal direction directory on disk under
    ``<root>/apps/sacrifice/directions/<id_slug>/``."""
    base = root / "apps" / "sacrifice" / "directions" / id_slug
    base.mkdir(parents=True)
    parts = id_slug.rsplit("-", 1) if "-" in id_slug else [id_slug, id_slug]
    h1 = title or parts[1].replace("-", " ").title()
    _write_direction_md(
        base,
        title=h1,
        acceptance=acceptance or ["AC1"],
        parent_direction=parent_direction,
    )
    return base


def test_parse_direction_with_parent_direction(tmp_path: Path) -> None:
    d = tmp_path / "012-iter-on-011"
    d.mkdir()
    _write_direction_md(d, title="Iter on parent", parent_direction="011-parent")
    direction = parse_direction_dir("sacrifice", d)
    assert direction.parent_direction == "011-parent"
    assert direction.related_directions == []


def test_parse_direction_with_related_directions(tmp_path: Path) -> None:
    d = tmp_path / "013-with-related"
    d.mkdir()
    _write_direction_md(
        d,
        title="Has related",
        related_directions=["005-foo", "008-bar"],
    )
    direction = parse_direction_dir("sacrifice", d)
    assert direction.parent_direction is None
    assert direction.related_directions == ["005-foo", "008-bar"]


def test_chain_resolves_single_parent(tmp_path: Path) -> None:
    _make_parent_on_disk(tmp_path, "011-parent", title="Parent")
    d = tmp_path / "012-iter-on-011"
    d.mkdir()
    _write_direction_md(d, title="Iter", parent_direction="011-parent")
    direction = parse_direction_dir("sacrifice", d)
    chain = resolve_direction_chain(direction, tmp_path)
    assert len(chain) == 2
    assert isinstance(chain[0], Direction)
    assert chain[0].id_slug == "011-parent"
    assert isinstance(chain[1], Direction)
    assert chain[1].id_slug == "012-iter-on-011"


def test_chain_missing_parent_returns_sentinel(tmp_path: Path) -> None:
    d = tmp_path / "012-iter-on-missing"
    d.mkdir()
    _write_direction_md(d, title="Iter", parent_direction="999-noexist")
    direction = parse_direction_dir("sacrifice", d)
    chain = resolve_direction_chain(direction, tmp_path)
    assert len(chain) == 2
    assert isinstance(chain[0], MissingDirection)
    assert chain[0].id_slug == "999-noexist"
    assert isinstance(chain[1], Direction)
    assert chain[1].id_slug == "012-iter-on-missing"


def test_self_reference_rejected(tmp_path: Path) -> None:
    d = tmp_path / "014-self-ref"
    d.mkdir()
    _write_direction_md(d, title="Self", parent_direction="014-self-ref")
    with pytest.raises(ValueError, match="Self-referential"):
        parse_direction_dir("sacrifice", d)


def test_related_directions_not_in_chain(tmp_path: Path) -> None:
    _make_parent_on_disk(tmp_path, "005-foo", title="Foo")
    _make_parent_on_disk(tmp_path, "006-bar", title="Bar")
    d = tmp_path / "013-with-related-only"
    d.mkdir()
    _write_direction_md(
        d,
        title="Related only, no parent",
        related_directions=["005-foo", "006-bar"],
    )
    direction = parse_direction_dir("sacrifice", d)
    assert direction.parent_direction is None
    chain = resolve_direction_chain(direction, tmp_path)
    assert len(chain) == 1  # just the current direction, no ancestors
    assert isinstance(chain[0], Direction)
    assert chain[0].id_slug == "013-with-related-only"


def test_id_slug_derived_from_dir_name(tmp_path: Path) -> None:
    """id_slug must match the directory name's <id>-<slug> form, not just
    echo back constructor inputs. Parse a real directory and verify."""
    d = tmp_path / "017-real-slug"
    d.mkdir()
    _write_direction_md(d, title="Irrelevant Title")
    direction = parse_direction_dir("sacrifice", d)
    assert direction.title == "Irrelevant Title"
    assert direction.id_slug == "017-real-slug"
    # id and slug parsed independently from directory name
    assert direction.id == "017"
    assert direction.slug == "real-slug"


def test_two_node_cycle_rejected(tmp_path: Path) -> None:
    _make_parent_on_disk(tmp_path, "018-node-b", title="B", parent_direction="019-node-a")
    d = tmp_path / "019-node-a"
    d.mkdir()
    _write_direction_md(d, title="A", parent_direction="018-node-b")
    with pytest.raises(
        DirectionChainCycleError, match="parent_direction chain that cycles"
    ) as exc_info:
        parse_direction_dir("sacrifice", d, software_factory_root=tmp_path)
    assert "018-node-b" in str(exc_info.value)
    assert "019-node-a" in str(exc_info.value)


def test_three_node_cycle_rejected(tmp_path: Path) -> None:
    _make_parent_on_disk(tmp_path, "020-node-b", title="B", parent_direction="021-node-c")
    _make_parent_on_disk(tmp_path, "021-node-c", title="C", parent_direction="022-node-a")
    d = tmp_path / "022-node-a"
    d.mkdir()
    _write_direction_md(d, title="A", parent_direction="020-node-b")
    with pytest.raises(
        DirectionChainCycleError, match="parent_direction chain that cycles"
    ):
        parse_direction_dir("sacrifice", d, software_factory_root=tmp_path)


def test_chain_depth_capped(tmp_path: Path) -> None:
    # Construct a 12-deep linear chain (001→002→...→012). Cap at 8 ancestors.
    for i in range(1, 13):
        id_slug = f"{i:03d}-deep"
        pd = f"{i-1:03d}-deep" if i > 1 else None
        _make_parent_on_disk(tmp_path, id_slug, parent_direction=pd)
    d = tmp_path / "013-deepest"
    d.mkdir()
    _write_direction_md(d, title="Deepest", parent_direction="012-deep")
    direction = parse_direction_dir("sacrifice", d)
    chain = resolve_direction_chain(direction, tmp_path)
    # 8 ancestors + current = 9
    assert len(chain) == 9
    # Oldest ancestor is 8 steps back from 012 → 005-deep
    assert isinstance(chain[0], Direction)
    assert chain[0].id_slug == "005-deep"
    # Last entry is always the current direction
    assert isinstance(chain[-1], Direction)
    assert chain[-1].id_slug == "013-deepest"
