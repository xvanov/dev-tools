"""Persona files as validated artifacts, not free-form text.

Before this, ``_read_persona_prompt`` was a bare ``path.read_text()``: no
frontmatter, no schema, no validation, and no registry — ``factory/personas/
__init__.py`` was empty and the de-facto list of valid persona names was the key
set of ``routes.yaml``. Three modules bypassed the loader entirely and globbed
the directory, one of which silently degraded to an empty prompt when a persona
file was missing.

This module adds the ``buzz-persona`` shape: a persona is YAML frontmatter
(behavioural config) plus a markdown body (the system prompt), parsed once and
cached.

Frontmatter is OPTIONAL. Every existing file is valid unchanged — a file with no
``---`` block parses as all-defaults with its full text as the body. That
matters because the alternative (a flag day converting 22 prompts) would risk
changing model behaviour in 22 places at once for no functional gain.

The critical invariant: :func:`load_persona` returns the BODY only. Frontmatter
must never reach a model — a persona that grew a ``model:`` key would otherwise
start describing its own routing to itself inside its system prompt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Bounds mirror buzz-persona's MAX_FRONTMATTER_BYTES / MAX_BODY_BYTES. A prompt
# is an input to a paid model call: an unbounded one is an unbounded bill, and a
# 1 MiB YAML header is always a mistake rather than a configuration.
MAX_FRONTMATTER_BYTES = 1_048_576  # 1 MiB
MAX_BODY_BYTES = 262_144  # 256 KiB

_PERSONAS_DIR = Path(__file__).parent


class PersonaError(ValueError):
    """A persona file could not be loaded or is structurally invalid."""


@dataclass(frozen=True)
class PersonaMeta:
    """Behavioural configuration declared in a persona's frontmatter.

    Every field is optional and defaults to None, meaning "inherit". Nothing
    here overrides ``routes.yaml`` today — these are declarations the validator
    can CHECK (e.g. that a declared model is one the router knows), so a persona
    and its routing can be verified to agree instead of drifting silently.
    """

    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    model: str | None = None
    temperature: float | None = None
    max_output_tokens: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> PersonaMeta:
        known = {"name", "display_name", "description", "model", "temperature", "max_output_tokens"}

        def _opt_float(key: str) -> float | None:
            value = raw.get(key)
            return None if value is None else float(value)

        def _opt_int(key: str) -> int | None:
            value = raw.get(key)
            return None if value is None else int(value)

        def _opt_str(key: str) -> str | None:
            value = raw.get(key)
            return None if value is None else str(value)

        return cls(
            name=_opt_str("name"),
            display_name=_opt_str("display_name"),
            description=_opt_str("description"),
            model=_opt_str("model"),
            temperature=_opt_float("temperature"),
            max_output_tokens=_opt_int("max_output_tokens"),
            # Unknown keys are PRESERVED rather than dropped, so the validator
            # can report them. Silently ignoring a typo'd key is how a config
            # that looks set ends up having no effect.
            extra={k: v for k, v in raw.items() if k not in known},
        )


@dataclass(frozen=True)
class Persona:
    """One loaded persona: its identity, its config, and its system prompt."""

    name: str
    meta: PersonaMeta
    body: str
    path: Path

    @property
    def has_frontmatter(self) -> bool:
        return bool(self.meta.name or self.meta.extra or self.meta.model)


# Cache keyed by resolved path. Mirrors ``factory.settings.loader._CACHED`` —
# personas are read on every LLM dispatch and never change mid-run.
_CACHED: dict[Path, Persona] = {}


def reload_personas() -> None:
    """Drop the cache. For tests that write persona files on the fly."""
    _CACHED.clear()


def persona_path(name: str, *, personas_dir: Path | None = None) -> Path:
    return (personas_dir or _PERSONAS_DIR) / f"{name}.md"


def available_personas(*, personas_dir: Path | None = None) -> list[str]:
    """Every persona file present, by name. The registry that did not exist."""
    directory = personas_dir or _PERSONAS_DIR
    try:
        return sorted(p.stem for p in directory.glob("*.md"))
    except OSError:
        return []


def load_persona(name: str, *, personas_dir: Path | None = None) -> Persona:
    """Load and parse ``<name>.md``.

    Raises :class:`PersonaError` for a missing file, oversize content, or
    malformed frontmatter. This is deliberately strict — unlike the telemetry
    paths, a persona that cannot be read means the model call cannot be made
    correctly, and failing loudly beats prompting with an empty string (which is
    what ``scheduled_tasks`` did).
    """
    path = persona_path(name, personas_dir=personas_dir)
    resolved = path.resolve() if path.exists() else path
    cached = _CACHED.get(resolved)
    if cached is not None:
        return cached

    if not path.exists():
        raise PersonaError(
            f"Persona file missing: {path}. Available: "
            f"{available_personas(personas_dir=personas_dir)}"
        )

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PersonaError(f"Persona file unreadable: {path}: {exc}") from exc

    meta_raw, body = _split_frontmatter(text, path)

    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise PersonaError(f"{path}: body exceeds {MAX_BODY_BYTES} bytes")

    persona = Persona(name=name, meta=PersonaMeta.from_mapping(meta_raw), body=body, path=path)
    _CACHED[resolved] = persona
    return persona


def _split_frontmatter(text: str, path: Path) -> tuple[dict[str, Any], str]:
    """Return ``(frontmatter_mapping, body)``.

    A file with no ``---`` opener is not an error: it is the current shape of
    every persona in the repo, and it parses as no frontmatter with the whole
    file as the body.
    """
    if not text.startswith("---"):
        return {}, text

    try:
        import frontmatter
    except ImportError:  # pragma: no cover - declared dependency
        return {}, text

    header_end = text.find("\n---", 3)
    if header_end == -1:
        raise PersonaError(
            f"{path}: frontmatter opened with '---' but was never closed. "
            "Either close it or remove the opening delimiter — an unterminated "
            "header would otherwise be silently prompted to the model as text."
        )
    if header_end > MAX_FRONTMATTER_BYTES:
        raise PersonaError(f"{path}: frontmatter exceeds {MAX_FRONTMATTER_BYTES} bytes")

    try:
        parsed = frontmatter.loads(text)
    except Exception as exc:  # noqa: BLE001 - yaml raises a wide family
        raise PersonaError(f"{path}: could not parse YAML frontmatter: {exc}") from exc

    metadata = dict(parsed.metadata or {})
    return metadata, parsed.content


def read_persona_prompt(name: str, *, personas_dir: Path | None = None) -> str:
    """Return ONLY the system-prompt body for ``name``.

    The single function every dispatch path should use. Frontmatter is stripped
    here so it can never reach a model.
    """
    return load_persona(name, personas_dir=personas_dir).body
