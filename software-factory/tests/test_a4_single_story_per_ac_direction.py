"""A4 (operator decision 2026-08-09): an AC-carrying direction spawns ONE story.

The acceptance oracle grades every story against the DIRECTION's criteria
(``_author_acceptance_oracle`` → ``list(direction.acceptance)``) — deliberately,
because scoping the oracle to what PM/SM says a story covers would let the
chain grade its own descoping (a false-green channel). Under that rule a
multi-story split is structurally broken: the first sibling to merge satisfies
the direction, and every later sibling grades green-at-base →
``oracle_not_discriminating`` → operator waiver. Observed live 2026-08-09:
direction 120 spawned three slices; story 179 implemented every criterion and
siblings 180/181 had to be superseded by hand.

Pinned here:
* the collapse fires only behind the per-app flag AND only when the summed
  slice estimates fit the per-story ceilings (silently merging N validated
  slices into one over-budget story would trade a visible waiver for an
  invisible budget burn);
* ``chain_kind`` is forced to ``tdd`` (an AC-carrying direction routed onto
  the docs chain — no dev, production_tree_changed skipped — wedges
  unmergeably) and ``scope`` is the modal implementation scope, never
  position-inherited;
* an oversized direction keeps its split and emits
  ``direction_not_single_story_sized``;
* the full-coverage mandate (PR #268) generalizes to the only story of an
  AC-carrying direction.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory.app_config import AppConfig, AppGatesConfig
from factory.chain.handlers import _with_full_coverage_mandate, handle_stories_spawned
from factory.chain.state_machine import StoryRecord
from factory.directions.parser import Direction


@pytest.fixture(autouse=True)
def _no_llm_authoring(monkeypatch: pytest.MonkeyPatch) -> None:
    """Real-run spawns author the acceptance oracle, which is a PAID LLM call
    (``_author_acceptance_oracle`` → ``acceptance_author`` persona) — stub it
    for every test here so ``pytest -q`` never spends money or hits the
    network."""
    import factory.chain.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "_author_acceptance_oracle", lambda *a, **k: None)


def _mk_direction(
    *,
    acceptance: list[str],
    title: str = "Expose a widget endpoint",
    explore: bool = False,
) -> Direction:
    return Direction(
        id="900",
        slug="expose-a-widget-endpoint",
        title=title,
        type_tag=None,
        why="Operators need widgets.",
        has_flow=False,
        has_api_spec=False,
        acceptance=acceptance,
        explore_tag=explore,
        artifacts_paths=[],
        app="sacrifice",
        status="pm-validated",
        raw_frontmatter={"title": title, "explore": explore},
        raw_body=f"# {title}",
        dir_path=Path("."),
        state={"tracker_issue": 42},
    )


def _cfg(*, oracle: bool = True, collapse: bool = True) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="owner/sacrifice",
        gates=AppGatesConfig(
            acceptance_oracle=oracle,
            single_story_per_ac_direction=collapse,
        ),
    )


def _root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir(exist_ok=True)
    return tmp_path


def _child(
    title: str,
    *,
    scope: str = "backend",
    chain_kind: str = "tdd",
    points: int = 2,
    new_files: int = 1,
    modified: int = 0,
    iterations: int = 40,
) -> dict[str, object]:
    return {
        "title": title,
        "scope": scope,
        "chain_kind": chain_kind,
        "points": points,
        "rationale": f"rationale for {title}",
        "estimated_new_files": new_files,
        "estimated_modified_files": modified,
        "estimated_sandbox_iterations": iterations,
    }


def _pm(children: list[dict[str, object]]) -> dict[str, object]:
    return {"child_stories": children, "confidence": 0.9}


_SMALL_SPLIT = [
    _child("happy-path smoke test", points=2),
    _child("unauthenticated rejection", points=1),
    _child("incremental integration", points=2, modified=1),
]


def test_ac_direction_collapses_a_fitting_split_to_one_story(tmp_path: Path) -> None:
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["GET /api/widgets returns the caller's widgets."]),
        pm_result=_pm(list(_SMALL_SPLIT)),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 1, "an AC-carrying direction must spawn exactly one story"
    s = stories[0]
    # The direction's own title, not the first slice's — the oracle grades
    # every criterion, and "happy-path smoke test" under-describes the work.
    assert s.title == "Expose a widget endpoint"
    assert s.chain_kind == "tdd"
    assert s.scope == "backend"
    # points = sum (2+1+2=5) snapped to Fibonacci — the one story does ALL the
    # slices' work; labelling it with one slice's points poisons EBS baselines.
    assert s.points == 5


def test_collapse_is_off_by_default(tmp_path: Path) -> None:
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm(list(_SMALL_SPLIT)),
        app_config=_cfg(collapse=False),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 3, "flag off → split passes through untouched"
    assert AppGatesConfig().single_story_per_ac_direction is False


def test_chain_kind_is_never_position_inherited(tmp_path: Path) -> None:
    """A docs-first PM ordering must not route a feature direction onto the
    docs chain (no dev, production_tree_changed skipped, acceptance gate still
    required → unmergeable wedge). Live example: direction 082's first child
    is scope=docs/chain_kind=docs ahead of three slices of real security work."""
    children = [
        _child("document the endpoint", scope="docs", chain_kind="docs", new_files=1),
        _child("implement the endpoint", scope="backend", points=3),
        _child("frontend affordance", scope="frontend", points=2),
    ]
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm(children),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 1
    assert stories[0].chain_kind == "tdd"
    # scope: modal over implementation scopes only (docs/test never win);
    # a backend/frontend 1:1 tie breaks deterministically (count, then
    # alphabetical) — never by PYTHONHASHSEED.
    assert stories[0].scope == "backend"


def test_oversized_direction_keeps_its_split(tmp_path: Path) -> None:
    """Summed estimates over the whole-DIRECTION budget must NOT collapse —
    merging N validated slices into one over-budget story voids the size
    guard the PM re-prompt loop enforces (36 of 37 multi-child held-out
    directions are this shape). The split proceeds unchanged."""
    children = [
        _child("slice 1", new_files=4, modified=2, iterations=200),
        _child("slice 2", new_files=4, modified=2, iterations=200),
        _child("slice 3", new_files=4, modified=2, iterations=200),
    ]
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm(children),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 3, "oversized → refuse to collapse, keep the split"


def test_missing_estimates_refuse_to_collapse(tmp_path: Path) -> None:
    """A child WITHOUT size estimates means the direction's size is unknown —
    the guard must refuse, not sum missing-as-zero and collapse the one
    direction whose size nobody validated (adversarial replay: the only
    held-out direction the zero-sum version collapsed was the pm.md
    anti-example D007, precisely because its children carry no estimates)."""
    unsized = {
        "title": "slice without estimates",
        "scope": "backend",
        "chain_kind": "tdd",
        "points": 2,
        "rationale": "r",
    }
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm([unsized, _child("sized slice")]),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 2, "unknown size → refuse to collapse, keep the split"


def test_oversized_direction_emits_the_operator_signal(tmp_path: Path) -> None:
    root = _root(tmp_path)
    children = [
        _child("slice 1", new_files=6, modified=2, iterations=150),
        _child("slice 2", new_files=6, modified=2, iterations=150),
    ]
    handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm(children),
        app_config=_cfg(),
        software_factory_root=root,
        dry_run=False,  # events are real-run only; no GH client → no issues
    )
    stream = root / "state" / "events" / "chain_steps.ndjson"
    assert stream.exists(), "real-run must record the refusal on the chain_steps stream"
    events = [json.loads(line) for line in stream.read_text().splitlines() if line.strip()]
    hits = [e for e in events if e.get("event") == "direction_not_single_story_sized"]
    assert hits, f"expected direction_not_single_story_sized, saw {[e.get('event') for e in events]}"
    assert hits[0]["summed_estimates"]["estimated_new_files"] == 12
    assert hits[0]["estimates_complete"] is True


def test_fitting_collapse_emits_the_collapsed_event_in_real_run(tmp_path: Path) -> None:
    root = _root(tmp_path)
    handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm(list(_SMALL_SPLIT)),
        app_config=_cfg(),
        software_factory_root=root,
        dry_run=False,
    )
    stream = root / "state" / "events" / "chain_steps.ndjson"
    assert stream.exists()
    events = [json.loads(line) for line in stream.read_text().splitlines() if line.strip()]
    hits = [e for e in events if e.get("event") == "story_split_collapsed"]
    assert hits and hits[0]["pm_child_count"] == 3
    assert hits[0]["dropped_titles"] == ["unauthenticated rejection", "incremental integration"]


def test_direction_without_acceptance_keeps_its_split(tmp_path: Path) -> None:
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=[]),
        pm_result=_pm(list(_SMALL_SPLIT)),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 3, "no acceptance criteria → nothing to grade → split stands"


def test_app_without_oracle_keeps_its_split(tmp_path: Path) -> None:
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm(list(_SMALL_SPLIT)),
        app_config=_cfg(oracle=False),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 3


def test_single_child_is_untouched(tmp_path: Path) -> None:
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."]),
        pm_result=_pm([_child("the one story", points=3)]),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 1
    assert stories[0].title == "the one story", "a single child passes through verbatim"


def test_explore_dual_draft_branch_is_untouched(tmp_path: Path) -> None:
    stories = handle_stories_spawned(
        direction=_mk_direction(acceptance=["Observable outcome."], explore=True),
        pm_result=_pm(list(_SMALL_SPLIT)),
        app_config=_cfg(),
        software_factory_root=_root(tmp_path),
        dry_run=True,
    )
    assert len(stories) == 2
    assert sorted("alt-a" in s.slug or "alt-b" in s.slug for s in stories) == [True, True]


# --------------------------------------------------------------------------- #
# the generalized full-coverage mandate
# --------------------------------------------------------------------------- #


def _story(slug: str) -> StoryRecord:
    return StoryRecord(
        direction_id="900", app="sacrifice", title="t", slug=slug, scope="backend",
    )


def test_mandate_fires_for_the_only_story_of_an_ac_direction() -> None:
    d = _mk_direction(acceptance=["AC one.", "AC two."])
    out = _with_full_coverage_mandate("# Story\n", _story("plain-slug"), d, ac_single_story=True)
    assert "Required coverage" in out
    assert "- [ ] AC one." in out and "- [ ] AC two." in out
    assert "COMPETING alternate" not in out, "non-alternate framing must not claim rivalry"
    assert "ONLY story" in out


def test_mandate_still_skips_plain_stories_without_the_flag_condition() -> None:
    d = _mk_direction(acceptance=["AC one."])
    out = _with_full_coverage_mandate("# Story\n", _story("plain-slug"), d)
    assert out == "# Story\n", "default path (multi-story split) stays unstamped"


def test_mandate_keeps_the_alternate_framing_for_dual_draft() -> None:
    d = _mk_direction(acceptance=["AC one."])
    out = _with_full_coverage_mandate("# Story\n", _story("some-story-alt-a"), d)
    assert "COMPETING alternate" in out
