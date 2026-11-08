"""The PA <-> factory contract schemas (native plan 1.1, D15).

One JSON Schema source lives at the monorepo root (``schemas/*.schema.json``):
Job, Run, Card, Event, Approval. The PA validates with its own small validator
(``schemas/index.js``) and generates its TS types from the same files; the
factory validates here with ``jsonschema`` (a dependency of litellm and mcp,
so always installed). ``job.schema.json`` is the shape ``factory job status
--json`` prints (docs/JOBS-API.md).
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

NAMES = ("job", "run", "card", "event", "approval")


def schemas_dir() -> Path:
    """``schemas/`` at the monorepo root (``FACTORY_SCHEMAS_DIR`` overrides)."""
    env = os.environ.get("FACTORY_SCHEMAS_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "schemas"


@lru_cache(maxsize=1)
def _registry() -> tuple[Any, dict[str, dict[str, Any]]]:
    from referencing import Registry, Resource

    docs: dict[str, dict[str, Any]] = {}
    for name in NAMES:
        path = schemas_dir() / f"{name}.schema.json"
        docs[name] = json.loads(path.read_text(encoding="utf-8"))
    registry = Registry().with_resources(
        (doc["$id"], Resource.from_contents(doc)) for doc in docs.values()
    )
    return registry, docs


def errors(name: str, value: Any) -> list[str]:
    """Every way ``value`` breaks schema ``name`` (``job``, or ``run#/$defs/chain``)."""
    from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

    registry, docs = _registry()
    base, _, frag = name.partition("#")
    doc = docs[base]
    schema: dict[str, Any] = {"$ref": f"{doc['$id']}#{frag}"} if frag else doc
    validator = Draft202012Validator(schema, registry=registry)
    return [
        f"{'/'.join(map(str, e.absolute_path)) or '$'}: {e.message}"
        for e in sorted(validator.iter_errors(value), key=lambda e: list(map(str, e.path)))
    ]


def validate(name: str, value: Any) -> None:
    """Raise ``ValueError`` listing every error when ``value`` breaks ``name``."""
    errs = errors(name, value)
    if errs:
        raise ValueError(f"not a valid {name}:\n  " + "\n  ".join(errs[:20]))
