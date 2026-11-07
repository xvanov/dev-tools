"""Persona files as validated artifacts.

Persona prompts are the input to every paid model call and the chain's whole
behaviour depends on them, but nothing validated them: ``_read_persona_prompt``
was a bare ``read_text()``, ``factory/personas/__init__.py`` was empty, and the
de-facto registry of valid names was the key set of ``routes.yaml``.

The load-bearing test here is the contract-collision group. Story 14 never
converged — dev and reviewer disagreed forever — because a prompt demonstrated
an example value outside a field's real enum. Dev implemented the example, the
reviewer correctly rejected it every round, and neither model was wrong.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.personas.loader import (
    MAX_BODY_BYTES,
    PersonaError,
    available_personas,
    load_persona,
    read_persona_prompt,
    reload_personas,
)
from factory.personas.validator import ERROR, WARNING, validate_all, validate_persona

_REAL_PERSONAS = Path(__file__).resolve().parent.parent / "factory" / "personas"


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    reload_personas()


def _write(directory: Path, name: str, text: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.md"
    path.write_text(text, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# The real corpus must stay valid
# --------------------------------------------------------------------------- #


def test_every_shipped_persona_loads() -> None:
    names = available_personas(personas_dir=_REAL_PERSONAS)
    # Structural, not a magic number: every ``*.md`` on disk must come back
    # from available_personas() (no silent drops), and vice versa. Was a bare
    # ``>= 20`` floor; 4 persona files (the deleted FMS LLM tiers + the
    # factory_improver) were removed 2026-08-07 — see the Exteroception v1
    # direction, P0 — dropping the real count from 22 to 18. A second batch
    # (bug_hunter, ralph, architect, release_manager, ux_designer) was
    # removed the same day — 019 AC5 — dropping the count again, 18 -> 13.
    on_disk = {p.stem for p in _REAL_PERSONAS.glob("*.md")}
    assert set(names) == on_disk, (set(names), on_disk)
    assert len(names) >= 12, names
    for name in names:
        persona = load_persona(name, personas_dir=_REAL_PERSONAS)
        assert persona.body.strip(), f"{name} has an empty body"


def test_the_real_corpus_has_no_errors() -> None:
    """The gate. A persona file that fails validation must fail CI, not ship."""
    report = validate_all(personas_dir=_REAL_PERSONAS)
    assert report.ok, [f.as_dict() for f in report.errors]


def test_no_shipped_persona_leaks_frontmatter() -> None:
    for name in available_personas(personas_dir=_REAL_PERSONAS):
        body = read_persona_prompt(name, personas_dir=_REAL_PERSONAS)
        assert not body.lstrip().startswith("---"), name


def test_runner_entry_point_returns_the_body(tmp_path: Path) -> None:
    """``runner._read_persona_prompt`` is what eight modules call. It must go
    through the loader so frontmatter can never reach a model."""
    from factory.runner import _read_persona_prompt

    for name in available_personas(personas_dir=_REAL_PERSONAS)[:3]:
        assert _read_persona_prompt(name).startswith("# ")


def test_missing_persona_still_raises_file_not_found() -> None:
    """Eight call sites handle FileNotFoundError; the loader's own PersonaError
    must not leak through and change their behaviour."""
    from factory.runner import _read_persona_prompt

    with pytest.raises(FileNotFoundError):
        _read_persona_prompt("no_such_persona_anywhere")


# --------------------------------------------------------------------------- #
# Frontmatter is optional, and must never reach the model
# --------------------------------------------------------------------------- #


def test_a_file_without_frontmatter_is_valid(tmp_path: Path) -> None:
    """Every persona in the repo has no frontmatter today. Requiring it would
    mean rewriting 22 prompts at once for no functional gain."""
    _write(tmp_path, "dev", "# Dev persona — `dev`\n\nDo the thing.\n")
    persona = load_persona("dev", personas_dir=tmp_path)
    assert persona.meta.model is None
    assert persona.body.startswith("# Dev persona")
    assert not persona.has_frontmatter


def test_frontmatter_is_parsed_and_stripped(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "dev",
        "---\nname: dev\nmodel: azure/gpt-5.4\ntemperature: 0.2\n---\n"
        "# Dev persona — `dev`\n\nDo the thing.\n",
    )
    persona = load_persona("dev", personas_dir=tmp_path)
    assert persona.meta.model == "azure/gpt-5.4"
    assert persona.meta.temperature == 0.2
    assert "---" not in persona.body
    assert "model:" not in persona.body, "config must never be prompted to the model"
    assert persona.body.startswith("# Dev persona")


def test_unterminated_frontmatter_is_an_error(tmp_path: Path) -> None:
    """Left unchecked, the header would be silently prompted to the model as
    prose."""
    _write(tmp_path, "dev", "---\nname: dev\n\n# Dev persona — `dev`\n\nbody\n")
    with pytest.raises(PersonaError, match="never closed"):
        load_persona("dev", personas_dir=tmp_path)


def test_malformed_yaml_is_an_error(tmp_path: Path) -> None:
    _write(tmp_path, "dev", "---\nname: [unclosed\n---\n# Dev persona — `dev`\n\nbody\n")
    with pytest.raises(PersonaError):
        load_persona("dev", personas_dir=tmp_path)


def test_oversize_body_is_rejected(tmp_path: Path) -> None:
    """A prompt is an input to a paid call; an unbounded one is an unbounded
    bill."""
    _write(tmp_path, "dev", "# Dev persona — `dev`\n\n" + ("x" * (MAX_BODY_BYTES + 10)))
    with pytest.raises(PersonaError, match="exceeds"):
        load_persona("dev", personas_dir=tmp_path)


def test_frontmatter_name_must_match_the_filename(tmp_path: Path) -> None:
    _write(tmp_path, "dev", "---\nname: reviewer\n---\n# Dev persona — `dev`\n\nbody\n")
    codes = {f.code for f in validate_persona("dev", personas_dir=tmp_path)}
    assert "name_mismatch" in codes


def test_unknown_frontmatter_keys_are_reported(tmp_path: Path) -> None:
    """A silently-ignored key is a setting that looks applied but is not."""
    _write(tmp_path, "dev", "---\nname: dev\ntempreature: 0.5\n---\n# Dev persona — `dev`\n\nb\n")
    findings = validate_persona("dev", personas_dir=tmp_path)
    assert any(f.code == "unknown_meta_key" and f.severity == WARNING for f in findings)


def test_out_of_range_numeric_settings_are_errors(tmp_path: Path) -> None:
    _write(tmp_path, "dev", "---\nname: dev\ntemperature: 9\n---\n# Dev persona — `dev`\n\nb\n")
    codes = {f.code for f in validate_persona("dev", personas_dir=tmp_path)}
    assert "temperature_out_of_range" in codes


# --------------------------------------------------------------------------- #
# Structure
# --------------------------------------------------------------------------- #


def test_empty_body_is_an_error(tmp_path: Path) -> None:
    _write(tmp_path, "dev", "---\nname: dev\n---\n\n")
    codes = {f.code for f in validate_persona("dev", personas_dir=tmp_path)}
    assert "empty_body" in codes


def test_missing_heading_is_an_error(tmp_path: Path) -> None:
    _write(tmp_path, "dev", "You are a developer.\n")
    codes = {f.code for f in validate_persona("dev", personas_dir=tmp_path)}
    assert "missing_heading" in codes


def test_heading_naming_a_different_persona_is_an_error(tmp_path: Path) -> None:
    """How a copy-pasted prompt ends up dispatched under the wrong key."""
    _write(tmp_path, "dev", "# Reviewer persona — `reviewer`\n\nYou review code.\n")
    codes = {f.code for f in validate_persona("dev", personas_dir=tmp_path)}
    assert "heading_name_mismatch" in codes


def test_the_one_shipped_heading_variant_is_accepted(tmp_path: Path) -> None:
    """``factory_self_context.md`` uses ``# <key> persona`` rather than the
    ``# Title persona — `key``` form. Both are fine; only a heading that names a
    DIFFERENT persona is a problem."""
    _write(tmp_path, "factory_self_context", "# factory_self_context persona\n\nGenerate.\n")
    errors = [
        f
        for f in validate_persona("factory_self_context", personas_dir=tmp_path)
        if f.severity == ERROR
    ]
    assert errors == []


# --------------------------------------------------------------------------- #
# Contract collisions — the story-14 class
# --------------------------------------------------------------------------- #


def test_the_story_14_bug_is_caught(tmp_path: Path) -> None:
    """A prompt demonstrating a scope value the chain does not accept.

    Dev implements ``orphan``; the reviewer rejects it because the contract
    allows only backend/frontend/test; neither model is wrong and the story
    never converges.
    """
    _write(
        tmp_path,
        "pm",
        "# PM persona — `pm`\n\n"
        "Emit child stories as JSON:\n\n"
        '```json\n{\n  "title": "t",\n  "scope": "orphan",\n  "chain_kind": "tdd"\n}\n```\n',
    )
    findings = [
        f for f in validate_persona("pm", personas_dir=tmp_path) if f.code == "contract_collision"
    ]
    assert len(findings) == 1
    assert "orphan" in findings[0].message
    assert findings[0].severity == ERROR


def test_an_invalid_chain_kind_is_caught(tmp_path: Path) -> None:
    _write(tmp_path, "pm", '# PM persona — `pm`\n\n`chain_kind: "hybrid"`\n')
    codes = {f.code for f in validate_persona("pm", personas_dir=tmp_path)}
    assert "contract_collision" in codes


def test_valid_contract_values_are_not_flagged(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "pm",
        "# PM persona — `pm`\n\n"
        '```json\n{"scope": "backend", "chain_kind": "docs", "state": "pr_open"}\n```\n',
    )
    codes = {f.code for f in validate_persona("pm", personas_dir=tmp_path)}
    assert "contract_collision" not in codes


def test_sibling_json_keys_are_not_mistaken_for_values(tmp_path: Path) -> None:
    """The false-positive class that made the first implementation unusable.

    A window-based scan after the field name read the NEXT key as a value and
    produced 80 findings on the real corpus, every one of them wrong. Requiring
    an explicit ``field: value`` position is what fixed it.
    """
    _write(
        tmp_path,
        "pm",
        "# PM persona — `pm`\n\n"
        '```json\n{\n  "scope": "backend",\n  "rationale": "first vertical slice",\n'
        '  "estimated_new_files": 1\n}\n```\n',
    )
    findings = [
        f for f in validate_persona("pm", personas_dir=tmp_path) if f.code == "contract_collision"
    ]
    assert findings == [], [f.message for f in findings]


def test_prose_mentioning_a_field_is_not_flagged(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "pm",
        "# PM persona — `pm`\n\n"
        "Choose the scope carefully. A story whose scope is unclear should be "
        "split. The state of the story is tracked by the chain.\n",
    )
    codes = {f.code for f in validate_persona("pm", personas_dir=tmp_path)}
    assert "contract_collision" not in codes


def test_placeholder_values_are_not_flagged(tmp_path: Path) -> None:
    _write(tmp_path, "pm", '# PM persona — `pm`\n\n`"scope": "<value>"` and `scope: value`\n')
    codes = {f.code for f in validate_persona("pm", personas_dir=tmp_path)}
    assert "contract_collision" not in codes


def test_collision_findings_are_deduplicated(tmp_path: Path) -> None:
    """One wrong example repeated five times is one problem, not five."""
    body = "# PM persona — `pm`\n\n" + '`"scope": "orphan"`\n' * 5
    _write(tmp_path, "pm", body)
    findings = [
        f for f in validate_persona("pm", personas_dir=tmp_path) if f.code == "contract_collision"
    ]
    assert len(findings) == 1


# --------------------------------------------------------------------------- #
# Routing drift
# --------------------------------------------------------------------------- #


def test_a_persona_with_no_route_is_a_warning_not_an_error() -> None:
    """Two shipped personas have no routes.yaml entry and silently use the block
    fallback. Worth surfacing, not worth blocking CI over."""
    report = validate_all(personas_dir=_REAL_PERSONAS)
    routeless = {f.persona for f in report.warnings if f.code == "no_model_route"}
    assert routeless, "expected the known routeless personas to be surfaced"
    assert report.ok, "routing drift must not fail the gate"


# The "FMS classifier must route frontmatter edits by the right rules" tests
# that used to live here tested ``_diff_touches_persona_frontmatter`` /
# ``_validate_prompt_edit`` — both from ``factory/manager/apply.py``, deleted
# 2026-08-07 along with the L4 apply tier. See STATUS.md and the
# Exteroception v1 direction, P0.

