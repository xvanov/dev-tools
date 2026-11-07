"""Structural checks over persona files.

Nothing validated persona prompts. They are inputs to every paid model call and
the chain's entire behaviour depends on them, but the only constraint anywhere
was ``path.exists()``.

The check that earns this module's existence is
:func:`_check_contract_collisions`. Story 14 failed to converge structurally —
dev and reviewer disagreed forever — because a persona prompt used example
tokens (``orphan`` / ``unassigned``) for an enumerated field whose real values
are something else. Dev could not tell an invented example token from a live
contract value, implemented the example, and the reviewer correctly rejected it
every round. The model was never the problem; the prompt was.

So the collision check does not ask "does this prompt mention a state name" —
personas legitimately discuss states all the time. It asks the narrower,
answerable question: **near a field whose values are enumerated in code, does
this prompt show a value that is not in that enum?** That is precisely the
mistake that broke story 14, and it is decidable.

Severities
----------
``error``   the file cannot be trusted as a prompt (unparseable, empty body,
            frontmatter that would leak, a contract collision).
``warning`` drift worth knowing about but not worth blocking on (a persona with
            no model route, a file nothing dispatches).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.personas.loader import (
    MAX_BODY_BYTES,
    Persona,
    PersonaError,
    available_personas,
    load_persona,
)

ERROR = "error"
WARNING = "warning"

# Frontmatter keys the loader understands. Anything else is almost certainly a
# typo, and a silently-ignored key is a setting that looks applied but is not.
_KNOWN_META_KEYS = frozenset(
    {"name", "display_name", "description", "model", "temperature", "max_output_tokens"}
)

# Enumerated contract fields the personas describe to the model, and their REAL
# allowed values. A prompt that demonstrates a value outside these sets is
# teaching the model a vocabulary the chain will reject.
#
# ``state`` is resolved lazily from StoryState so it can never drift from the
# enum; the others are small and defined at their use sites.
_ENUM_CONTRACTS: dict[str, frozenset[str]] = {
    "scope": frozenset({"backend", "frontend", "test"}),
    "chain_kind": frozenset({"tdd", "docs"}),
}

# A token only counts as a demonstrated VALUE when it sits in an actual
# key-value position: ``"scope": "backend"``, ``scope: backend``,
# ``scope="backend"``. Requiring the separator is what makes this check usable.
#
# An earlier version scanned a 120-character window after any mention of the
# field name, which produced 80 findings against the real 22-persona corpus and
# every single one was a false positive — it was reading sibling JSON keys
# (``"scope": "backend", "rationale": "..."`` flagged ``rationale``) and
# ordinary prose as values. A check that noisy is one nobody runs twice.
_FIELD_VALUE = r"""["'`]?\b{field}\b["'`]?\s*[:=]\s*["'`]([a-z][a-z0-9_]{{2,40}})["'`]"""

# Values that are obviously placeholders rather than claims about the contract.
_PLACEHOLDER_VALUES = frozenset(
    {"value", "string", "str", "text", "name", "one_of", "enum", "example", "todo", "xxx"}
)


@dataclass
class Finding:
    persona: str
    severity: str
    code: str
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "persona": self.persona,
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }


@dataclass
class ValidationReport:
    findings: list[Finding] = field(default_factory=list)
    checked: int = 0

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == ERROR]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == WARNING]

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {
            "checked": self.checked,
            "ok": self.ok,
            "errors": [f.as_dict() for f in self.errors],
            "warnings": [f.as_dict() for f in self.warnings],
        }


def _state_values() -> frozenset[str]:
    from factory.chain.state_machine import StoryState

    return frozenset(s.value for s in StoryState)


def _check_structure(persona: Persona) -> list[Finding]:
    out: list[Finding] = []
    body = persona.body.strip()
    if not body:
        out.append(
            Finding(
                persona.name,
                ERROR,
                "empty_body",
                "persona body is empty — the model would be prompted with nothing",
            )
        )
        return out

    first_line = body.splitlines()[0].strip()
    if not first_line.startswith("# "):
        out.append(
            Finding(
                persona.name,
                ERROR,
                "missing_heading",
                f"first line must be an H1 identifying the persona, got {first_line[:60]!r}",
            )
        )
    elif "persona" not in first_line.lower():
        out.append(
            Finding(
                persona.name,
                WARNING,
                "heading_shape",
                f"H1 does not say 'persona': {first_line[:60]!r}",
            )
        )
    elif persona.name not in first_line:
        # The heading is what a reader (and the model) uses to know which
        # persona it is. A heading naming a DIFFERENT persona than the filename
        # is how a copy-pasted prompt ends up dispatched under the wrong key.
        out.append(
            Finding(
                persona.name,
                ERROR,
                "heading_name_mismatch",
                f"H1 does not mention the persona key {persona.name!r}: {first_line[:60]!r}",
            )
        )

    if len(persona.body.encode("utf-8")) > MAX_BODY_BYTES:
        out.append(Finding(persona.name, ERROR, "body_too_large", "body exceeds the size bound"))
    return out


def _check_frontmatter(persona: Persona) -> list[Finding]:
    out: list[Finding] = []
    meta = persona.meta
    if meta.name and meta.name != persona.name:
        out.append(
            Finding(
                persona.name,
                ERROR,
                "name_mismatch",
                f"frontmatter name {meta.name!r} does not match filename {persona.name!r}",
            )
        )
    for key in sorted(meta.extra):
        out.append(
            Finding(
                persona.name,
                WARNING,
                "unknown_meta_key",
                f"frontmatter key {key!r} is not understood and has no effect",
            )
        )
    if meta.temperature is not None and not 0.0 <= meta.temperature <= 2.0:
        out.append(
            Finding(
                persona.name,
                ERROR,
                "temperature_out_of_range",
                f"temperature {meta.temperature} is outside 0.0–2.0",
            )
        )
    if meta.max_output_tokens is not None and meta.max_output_tokens <= 0:
        out.append(
            Finding(
                persona.name,
                ERROR,
                "max_output_tokens_invalid",
                f"max_output_tokens must be positive, got {meta.max_output_tokens}",
            )
        )
    # Frontmatter must never reach the model.
    if persona.body.lstrip().startswith("---"):
        out.append(
            Finding(
                persona.name,
                ERROR,
                "frontmatter_leak",
                "body still begins with '---' — frontmatter was not stripped",
            )
        )
    return out


def _check_contract_collisions(persona: Persona) -> list[Finding]:
    """Flag demonstrated values that are not in the field's real enum.

    The story-14 failure mode: a prompt shows ``"scope": "orphan"`` as an
    example, dev implements ``orphan``, the reviewer rejects it because the
    contract only allows backend/frontend/test, and the two never converge. The
    model behaved correctly on both sides.

    Only tokens in an explicit ``field: value`` position count, so prose that
    merely mentions a field is never flagged.
    """
    out: list[Finding] = []
    contracts = dict(_ENUM_CONTRACTS)
    contracts["state"] = _state_values()
    body = persona.body
    seen: set[tuple[str, str]] = set()

    for field_name, allowed in contracts.items():
        pattern = re.compile(_FIELD_VALUE.format(field=re.escape(field_name)))
        for match in pattern.finditer(body):
            token = match.group(1)
            if token in allowed or token in _PLACEHOLDER_VALUES:
                continue
            if (field_name, token) in seen:
                continue
            seen.add((field_name, token))
            out.append(
                Finding(
                    persona.name,
                    ERROR,
                    "contract_collision",
                    f"shows {token!r} as a value for {field_name!r}, but the "
                    f"contract only allows {sorted(allowed)}. A prompt example the "
                    "chain will reject causes structural dev/reviewer "
                    "non-convergence (story 14).",
                )
            )
    return out


def _check_routing(persona: Persona) -> list[Finding]:
    out: list[Finding] = []
    try:
        from factory.model_router import all_known_personas

        known = set(all_known_personas())
    except Exception:  # noqa: BLE001 - a routing read must not fail validation
        return out

    if persona.name not in known:
        out.append(
            Finding(
                persona.name,
                WARNING,
                "no_model_route",
                "no entry in routes.yaml — this persona silently uses the block "
                "fallback model, so its cost and capability are unintentional",
            )
        )
    return out


def validate_persona(name: str, *, personas_dir: Path | None = None) -> list[Finding]:
    """Run every check against one persona."""
    try:
        persona = load_persona(name, personas_dir=personas_dir)
    except PersonaError as exc:
        return [Finding(name, ERROR, "unloadable", str(exc))]

    return [
        *_check_structure(persona),
        *_check_frontmatter(persona),
        *_check_contract_collisions(persona),
        *_check_routing(persona),
    ]


def validate_all(*, personas_dir: Path | None = None) -> ValidationReport:
    """Validate every persona file present."""
    report = ValidationReport()
    for name in available_personas(personas_dir=personas_dir):
        report.checked += 1
        report.findings.extend(validate_persona(name, personas_dir=personas_dir))
    return report
