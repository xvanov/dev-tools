"""Derive sacrifice's real HTTP route surface by AST-parsing its route/schema files.

Workstream A1 (docs/BENCHMARK-READINESS-PLAN.md): `acceptance_harness_hint`
(apps/sacrifice/config.yaml) is hand-maintained prose fed to a dev-blind
acceptance-oracle author. It has drifted from the real app three times
(fabricated auth routes, an invented 401 body, an absent goal-creation
schema), each time blocking a correct implementation. This script derives the
app's ACTUAL route surface — method, path, and required request-body fields —
into a checked-in JSON snapshot so a test can mechanically cross-check the
hint's claims against reality, without booting the app or touching its DB.

Why AST parsing, not `import app.main`: importing the app pulls in
`app.config.Settings`, which is a pydantic settings model with secret fields
that refuse a hardcoded default (see apps/sacrifice/config.yaml's
`acceptance_boot` comments) — an import-time boot with no env configured
would either explode or, worse, require replicating the acceptance oracle's
whole boot recipe here. Static AST parsing needs nothing but the source tree:
no venv, no DATABASE_URL, no docker, no network, and it works in CI where
sacrifice's repo is never checked out (this script only ever runs on a box
that has a local `/home/k/sacrifice`-style checkout; CI consumes the
committed JSON output, not this script).

What this derives (and nothing more — it must not invent facts):
  - method + full path, from `@<router_var>.<method>("<path>")` decorators,
    combined with that router's `APIRouter(prefix=...)` string.
  - required request-body fields, from the one function parameter (if any)
    whose type annotation names a local `class X(BaseModel)` and which has
    no default (a `Depends(...)` default marks a dependency, not a body).
    A field is "required" iff its class-body annotation has no assignment,
    or its assignment is `Field(...)` with no positional/`default=` value.
  - Nothing about response bodies or error vocabularies: FastAPI routes here
    declare no `responses=`, so those stay hand-maintained prose (A1 scope).

Scope note (read before editing the cross-check test): this snapshot covers
ALL discoverable routes, deliberately unpruned — apps/sacrifice/derived/
api_surface.json is not fed to the acceptance author, so its size does not
dilute an authoring prompt the way an unpruned hint would. The PRUNING lives
in the cross-check itself (tests/test_sacrifice_acceptance_harness_hint.py),
which only ever looks up the handful of routes the hint actually mentions.
Keep that split: broad snapshot, narrow cross-check.

Usage:
    uv run python scripts/generate_sacrifice_api_surface.py \\
        [--app-root ../sacrifice] [--output apps/sacrifice/derived/api_surface.json]

Regenerate this whenever sacrifice's routes or request schemas change, and
commit the result — the snapshot records the sacrifice commit SHA it was
derived from (`source_commit`) so the local-only staleness test
(test_api_surface_snapshot_is_not_stale, skipped in CI) can tell a merely-old
snapshot from a genuinely wrong one.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]


def _default_app_root() -> Path:
    """The app checkout the operator config names — never a guessed sibling.

    ``apps/sacrifice/config.yaml``'s ``app_repo_path`` is the operator-written
    source of truth for where the sacrifice checkout lives; a relative
    ``../sacrifice`` guess broke the moment this script ran from a git
    worktree (adversarial review finding #15).
    """
    cfg = _REPO_ROOT / "apps" / "sacrifice" / "config.yaml"
    try:
        import yaml

        loaded = yaml.safe_load(cfg.read_text())
        path = Path(loaded["app_repo_path"]).expanduser()
        if path.is_dir():
            return path
    except Exception:  # noqa: BLE001 - fall through to the historical default
        pass
    return Path("/home/k/sacrifice")


_DEFAULT_OUTPUT = (
    Path(__file__).resolve().parents[1] / "apps" / "sacrifice" / "derived" / "api_surface.json"
)
_ROUTES_SUBDIR = Path("backend/app/routes")
_SCHEMAS_SUBDIR = Path("backend/app/schemas")
_MAIN_FILE = Path("backend/app/main.py")

_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


@dataclass
class RouteFact:
    method: str
    path: str
    required_fields: list[str] = field(default_factory=list)
    all_fields: list[str] = field(default_factory=list)
    body_model: str | None = None
    source_file: str = ""


def _git_head_sha(app_root: Path) -> str:
    out = subprocess.run(
        ["git", "-C", str(app_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return out.stdout.strip()


def _git_is_dirty(app_root: Path) -> bool:
    out = subprocess.run(
        ["git", "-C", str(app_root), "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    )
    return bool(out.stdout.strip())


def _is_ellipsis(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and node.value is Ellipsis


def _field_is_required(assign: ast.expr | None) -> bool:
    """A pydantic field is required iff it has no default value.

    Bare annotation (``x: str``) -> required. ``x: str = "usd"`` -> optional.
    ``x: str = Field(...)`` -> required (explicit pydantic v1-style marker).
    ``x: str = Field(min_length=8)`` -> required (no ``default=`` kwarg and no
    positional default supplied). ``x: str = Field(default="a")`` -> optional.
    """
    if assign is None:
        return True
    if isinstance(assign, ast.Call):
        func = assign.func
        is_field_call = isinstance(func, ast.Name) and func.id == "Field"
        if not is_field_call:
            # Some other callable default (e.g. a factory) -> has a default.
            return False
        if assign.args:
            # Positional default; `Field(...)` is the required marker.
            return _is_ellipsis(assign.args[0])
        for kw in assign.keywords:
            if kw.arg == "default" or kw.arg == "default_factory":
                return False
        return True
    # Any other literal/expression assignment is a concrete default value.
    return False


def parse_schema_models(*dirs: Path) -> dict[str, dict[str, bool]]:
    """Return {ClassName: {field_name: required}} for every ``class X(BaseModel)``.

    Scans EVERY directory given — sacrifice declares six request-body models
    INLINE in ``routes/*.py`` (GoogleAuthRequest, SendMessageBody, ...), and a
    schemas-only scan recorded ``required_fields: []`` for their routes: the
    cross-check then instructed a human to DELETE a true hint fact
    (adversarial review finding #1). Duplicate class names across files
    collide last-sorted-file-wins; none exist today, and the consumer treats
    an unresolvable body as UNKNOWN, never as "no fields".
    """
    models: dict[str, dict[str, bool]] = {}
    py_files = [f for d in dirs for f in sorted(d.glob("*.py"))]
    for py_file in py_files:
        tree = ast.parse(py_file.read_text(), filename=str(py_file))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            base_names = {b.id for b in node.bases if isinstance(b, ast.Name)} | {
                b.attr for b in node.bases if isinstance(b, ast.Attribute)
            }
            if "BaseModel" not in base_names:
                continue
            fields: dict[str, bool] = {}
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    fields[stmt.target.id] = _field_is_required(stmt.value)
            models[node.name] = fields
    return models


def _string_const(node: ast.expr | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _router_prefixes(tree: ast.Module) -> dict[str, str]:
    """Map every ``<var> = APIRouter(...)`` assignment to its ``prefix=""``."""
    prefixes: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not (
            isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "APIRouter"
        ):
            continue
        prefix = ""
        for kw in node.value.keywords:
            if kw.arg == "prefix":
                prefix = _string_const(kw.value) or ""
        for target in node.targets:
            if isinstance(target, ast.Name):
                prefixes[target.id] = prefix
    return prefixes


def _join_path(prefix: str, suffix: str) -> str:
    combined = f"{prefix}{suffix}"
    if not combined.startswith("/"):
        combined = "/" + combined
    while "//" in combined:
        combined = combined.replace("//", "/")
    if len(combined) > 1 and combined.endswith("/"):
        combined = combined[:-1]
    return combined


def _decorator_route(dec: ast.expr, router_vars: dict[str, str]) -> tuple[str, str] | None:
    """Return (router_var, method) if `dec` is `<router_var>.<http_method>(...)`."""
    if not isinstance(dec, ast.Call):
        return None
    func = dec.func
    if not isinstance(func, ast.Attribute):
        return None
    if not isinstance(func.value, ast.Name):
        return None
    router_var = func.value.id
    method = func.attr.lower()
    if router_var not in router_vars or method not in _HTTP_METHODS:
        return None
    return router_var, method


def _body_field_for(
    fn: ast.AsyncFunctionDef | ast.FunctionDef, schema_models: dict[str, dict[str, bool]]
) -> str | None:
    """Find the request-body parameter: a bare `name: SchemaClass` with no default.

    A parameter with a default (including `Depends(...)`) is a dependency or
    an optional query param, never the JSON body FastAPI parses positionally.
    """
    args = fn.args
    positional = args.posonlyargs + args.args
    defaults_for_positional: dict[str, ast.expr] = {}
    n_defaults = len(args.defaults)
    if n_defaults:
        for a, d in zip(positional[-n_defaults:], args.defaults, strict=True):
            defaults_for_positional[a.arg] = d
    kw_only_defaults = {
        a.arg: d for a, d in zip(args.kwonlyargs, args.kw_defaults, strict=True) if d is not None
    }
    all_params = positional + args.kwonlyargs
    all_defaults = {**defaults_for_positional, **kw_only_defaults}
    for a in all_params:
        if a.arg == "self":
            continue
        if a.arg in all_defaults:
            continue  # has a default -> not the required JSON body
        ann = a.annotation
        name = None
        if isinstance(ann, ast.Name):
            name = ann.id
        elif isinstance(ann, ast.Attribute):
            name = ann.attr
        elif isinstance(ann, ast.BinOp):  # `X | None`
            left = ann.left
            if isinstance(left, ast.Name):
                name = left.id
        if name and name in schema_models:
            return name
    return None


def parse_routes(
    routes_dir: Path,
    main_file: Path,
    schema_models: dict[str, dict[str, bool]],
    app_root: Path,
) -> list[RouteFact]:
    facts: list[RouteFact] = []
    files = sorted(routes_dir.glob("*.py"))
    if main_file.exists():
        files.append(main_file)
    for py_file in files:
        tree = ast.parse(py_file.read_text(), filename=str(py_file))
        router_vars = _router_prefixes(tree)
        if py_file == main_file:
            router_vars.setdefault("app", "")
        for node in ast.walk(tree):
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            for dec in node.decorator_list:
                resolved = _decorator_route(dec, router_vars)
                if resolved is None:
                    continue
                router_var, method = resolved
                assert isinstance(dec, ast.Call)
                path_suffix = _string_const(dec.args[0]) if dec.args else None
                if path_suffix is None:
                    raise ValueError(
                        f"{py_file}:{node.lineno} — route path is not a string "
                        "literal; cannot derive it statically without inventing "
                        "a fact"
                    )
                full_path = _join_path(router_vars[router_var], path_suffix)
                body_model = _body_field_for(node, schema_models)
                required = (
                    sorted(name for name, req in schema_models[body_model].items() if req)
                    if body_model
                    else []
                )
                all_fields = sorted(schema_models[body_model]) if body_model else []
                facts.append(
                    RouteFact(
                        method=method.upper(),
                        path=full_path,
                        required_fields=required,
                        all_fields=all_fields,
                        body_model=body_model,
                        source_file=str(py_file.relative_to(app_root)),
                    )
                )
    return facts


def build_surface(app_root: Path) -> dict:
    routes_dir = app_root / _ROUTES_SUBDIR
    schemas_dir = app_root / _SCHEMAS_SUBDIR
    main_file = app_root / _MAIN_FILE
    if not routes_dir.is_dir():
        raise SystemExit(f"routes dir not found: {routes_dir}")
    schema_models = parse_schema_models(schemas_dir, routes_dir)
    facts = parse_routes(routes_dir, main_file, schema_models, app_root)
    facts.sort(key=lambda f: (f.path, f.method))
    return {
        "app": "sacrifice",
        "generated_at": datetime.now(UTC).isoformat(),
        "generator": "scripts/generate_sacrifice_api_surface.py",
        "source_commit": _git_head_sha(app_root),
        "source_dirty": _git_is_dirty(app_root),
        "scope_note": (
            "ALL discoverable routes, unpruned by design -- this snapshot is "
            "not fed to the acceptance author. The cross-check that reads it "
            "(tests/test_sacrifice_acceptance_harness_hint.py) narrows to only "
            "the routes the hint names; do not remove routes from here to "
            "narrow scope, narrow the consumer instead."
        ),
        "routes": [
            {
                "method": f.method,
                "path": f.path,
                "required_fields": f.required_fields,
                "all_fields": f.all_fields,
                "body_model": f.body_model,
                "source_file": f.source_file,
            }
            for f in facts
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-root", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=_DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    app_root = (args.app_root or _default_app_root()).resolve()
    surface = build_surface(app_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(surface, indent=2, sort_keys=False) + "\n")
    print(
        f"Wrote {len(surface['routes'])} routes from {app_root} "
        f"@ {surface['source_commit'][:12]} to {args.output}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
