"""Extract an app's REAL HTTP route table from its source tree.

This exists to kill one specific bug class at its source. The acceptance author
is dev-blind by design (019 AC3): it never imports or reads the app tree, so it
cannot check that a route it writes into a test actually exists. On 2026-08-08
that turned a wrong line in ``acceptance_harness_hint`` — two auth routes that
had never existed — into an oracle that 404s at HEAD no matter how correct the
implementation is (PR #266).

The contract author is a DIFFERENT role and is deliberately NOT blind: it reads
the app so the interface contract it writes can only reuse or extend paths that
are really there. Feeding it a route table derived by *parsing*, not by asking a
model, is what makes the contract trustworthy — a model asked to recall routes
will confabulate them, which is the failure we are removing.

Deliberately a best-effort textual scan rather than an import-and-introspect:

* importing an app requires its env, its DB and its dependency tree, which is
  exactly the coupling the oracle architecture exists to avoid;
* a partial, honest route list is useful, while a crashed import is not.

So this never raises and never blocks. When it finds nothing it says so, and the
contract author is told to treat the table as evidence rather than as an
exhaustive inventory.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: ``@router.get("/x")`` / ``@app.post('/y', ...)`` — FastAPI, Flask-RESTful and
#: friends all decorate this way. The method set is the HTTP verbs we care about.
_DECORATOR_RE = re.compile(
    r"@(?P<obj>\w+)\.(?P<method>get|post|put|patch|delete|head|options)\s*\(\s*"
    r"(?P<q>['\"])(?P<path>[^'\"]*)(?P=q)",
    re.IGNORECASE,
)

#: ``APIRouter(prefix="/api/auth")`` — the prefix is joined onto every route in
#: the file. Missing it is how ``/email/register`` reads as a top-level path.
_PREFIX_RE = re.compile(
    r"APIRouter\s*\([^)]*?prefix\s*=\s*(?P<q>['\"])(?P<prefix>[^'\"]*)(?P=q)",
    re.DOTALL,
)

_SKIP_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", ".mypy_cache",
    ".pytest_cache", "dist", "build", ".next", "migrations", "alembic",
}


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    source: str  # repo-relative file the decorator was found in

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.method:<6} {self.path}"


def _join(prefix: str, path: str) -> str:
    if not prefix:
        return path or "/"
    return f"{prefix.rstrip('/')}/{path.lstrip('/')}".rstrip("/") or "/"


def extract_routes(repo_path: Path, *, max_files: int = 2000) -> list[Route]:
    """Best-effort HTTP route inventory for the app rooted at ``repo_path``.

    Returns routes sorted by path then method, de-duplicated. Never raises: an
    unreadable tree yields an empty list, and the caller degrades to "no route
    table available" rather than failing the run.
    """
    found: set[Route] = set()
    try:
        if not repo_path.is_dir():
            return []
        seen_files = 0
        for py in sorted(repo_path.rglob("*.py")):
            if seen_files >= max_files:
                break
            if any(part in _SKIP_DIRS for part in py.parts):
                continue
            seen_files += 1
            try:
                src = py.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if "@" not in src:
                continue
            # One prefix per module is the overwhelmingly common shape. Taking
            # the FIRST is deliberate: guessing per-decorator which of several
            # routers a path belongs to needs real name resolution, and a wrong
            # prefix is worse than a missing one.
            m = _PREFIX_RE.search(src)
            prefix = m.group("prefix") if m else ""
            try:
                rel = str(py.relative_to(repo_path))
            except ValueError:  # pragma: no cover - defensive
                rel = py.name
            for d in _DECORATOR_RE.finditer(src):
                found.add(
                    Route(
                        method=d.group("method").upper(),
                        path=_join(prefix, d.group("path")),
                        source=rel,
                    )
                )
    except Exception:  # noqa: BLE001 - a scan must never break the caller
        return sorted(found, key=lambda r: (r.path, r.method))
    return sorted(found, key=lambda r: (r.path, r.method))


def render_route_table(routes: list[Route], *, limit: int = 300) -> str:
    """Prompt-ready rendering, explicitly labelled as evidence not inventory."""
    if not routes:
        return (
            "(no route table could be extracted from the app tree — treat every "
            "path below as UNVERIFIED and prefer paths the direction states)"
        )
    lines = [f"{r.method:<7} {r.path}    ({r.source})" for r in routes[:limit]]
    if len(routes) > limit:
        lines.append(f"... and {len(routes) - limit} more")
    return "\n".join(lines)


__all__ = ["Route", "extract_routes", "render_route_table"]
