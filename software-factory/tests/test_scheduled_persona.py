"""Tests for ``run_scheduled_persona`` end-to-end (without an LLM).

Covers:

  * Unknown persona → errored without filing directions.
  * A finding without ``suggested_direction`` is silently skipped.
  * A multi-finding fixture produces multiple directions in one run.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from factory.chain.scheduled_tasks import run_scheduled_persona


def _write_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        yaml.safe_dump({"name": "sacrifice", "repo": "o/r"}), encoding="utf-8"
    )
    (tmp_path / "state").mkdir(parents=True)
    return tmp_path


def test_unknown_persona_errors_without_filing_directions(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    out = run_scheduled_persona("not_a_persona", "sacrifice", root, dry_run=True)
    assert out.status == "errored"
    assert out.findings_count == 0
    assert out.directions_filed == []
    assert "unknown_scheduled_persona" in (out.error or "")


def test_finding_without_suggested_direction_is_skipped(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    fx = {
        "findings": [
            {"tool": "semgrep", "rule_id": "x", "severity": "low"},  # no suggested_direction
        ]
    }
    out = run_scheduled_persona("security", "sacrifice", root, dry_run=True, fixture_output=fx)
    assert out.findings_count == 1
    assert out.directions_filed == []


def test_multi_finding_fixture_files_multiple_directions(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    fx = {
        "findings": [
            {
                "suggested_direction": {
                    "title": "fix A",
                    "type": "bug",
                    "why": "A is broken",
                    "acceptance": ["A works"],
                }
            },
            {
                "suggested_direction": {
                    "title": "fix B",
                    "type": "refactor",
                    "why": "B is gnarly",
                    "acceptance": ["B is clean"],
                }
            },
        ]
    }
    out = run_scheduled_persona("security", "sacrifice", root, dry_run=True, fixture_output=fx)
    assert out.findings_count == 2
    assert len(out.directions_filed) == 2
    # IDs must be unique.
    assert len(set(out.directions_filed)) == 2


def test_scheduled_directions_are_explore_enabled_so_they_clear_backpressure(
    tmp_path: Path,
) -> None:
    """Regression: scheduled findings have no user_flow/api_spec, so unless
    they're filed explore=True they dead-end at the backpressure gate with zero
    stories (the hamster-wheel bug, 2026-07-06). Every filed direction.md must
    carry explore: true in its frontmatter."""
    root = _write_root(tmp_path)
    fx = {
        "findings": [
            {
                "suggested_direction": {
                    "title": "fix the thing",
                    "type": "bug",
                    "why": "it is broken",
                    "acceptance": ["it works"],
                }
            }
        ]
    }
    out = run_scheduled_persona(
        "security", "sacrifice", root, dry_run=True, fixture_output=fx
    )
    assert len(out.directions_filed) == 1
    # Find the written direction.md under the dry-run scratch tree and confirm
    # explore: true in frontmatter.
    matches = list(
        (root / "state" / "dry_run_scratch" / "apps" / "sacrifice" / "directions").glob(
            "*/direction.md"
        )
    )
    assert matches, "no direction.md was written"
    text = matches[0].read_text(encoding="utf-8")
    fm = yaml.safe_load(text.split("---")[1])
    assert fm.get("explore") is True, f"expected explore: true, got {fm.get('explore')!r}"


def test_dedup_guard_detects_open_duplicate_by_title(tmp_path: Path) -> None:
    """Regression: the spam guard suppresses a re-filed finding while an
    existing direction with the same title is still open (the spam-loop bug,
    2026-07-06: ~38 duplicate 'resolve conflicted navigation context').

    Unit-tests the guard directly against real directions written by
    create_direction (the full real-run persona path invokes the model, so it
    can't be driven from a fixture)."""
    import yaml as _yaml

    from factory.chain.scheduled_tasks import _has_open_duplicate_direction
    from factory.directions.creator import create_direction

    root = _write_root(tmp_path)
    title = "Resolve conflicted navigation context"

    # No directions yet → no duplicate.
    assert not _has_open_duplicate_direction("sacrifice", title, root)

    created = create_direction(
        "sacrifice",
        title=title,
        type_tag="docs",
        why="conflict markers present",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["no markers"],
        explore=True,
        attach_files=None,
        software_factory_root=root,
        source="scheduled-ux_auditor",
    )

    # Same title, direction still open (status=created) → duplicate detected.
    assert _has_open_duplicate_direction("sacrifice", title, root)
    # Case/whitespace-insensitive.
    assert _has_open_duplicate_direction("sacrifice", "  resolve   CONFLICTED navigation context ", root)
    # A different title is not a duplicate.
    assert not _has_open_duplicate_direction("sacrifice", "Add rate limiting to pledges", root)

    # Once the direction is closed out, an identical finding may be re-filed.
    state_path = root / "apps" / "sacrifice" / "directions" / created.direction.id_slug / "state.yaml"
    if not state_path.exists():
        # id_slug may differ from dir name; find the single created dir.
        state_path = next(
            (root / "apps" / "sacrifice" / "directions").glob("*/state.yaml")
        )
    data = _yaml.safe_load(state_path.read_text(encoding="utf-8"))
    data["status"] = "done"
    state_path.write_text(_yaml.safe_dump(data), encoding="utf-8")
    assert not _has_open_duplicate_direction("sacrifice", title, root)
