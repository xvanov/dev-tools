"""Cross-check a machine-filed direction's premises against the app's REAL routes.

The treadmill this closes
------------------------
A scheduled scanner persona reads the app's context docs and files work orders
from them. It has **no tools**: ``factory.chain.scheduled_tasks._live_run``
dispatches ``text_run`` with the persona prompt plus a composed context prelude,
so the persona cannot open the app tree and cannot check a single claim it
makes. Whatever the prose says is missing, *is* missing as far as it knows — and
the prelude tells it in so many words that "if something here contradicts your
priors, the context wins".

So one stale sentence buys an unbounded number of directions. Password reset was
re-filed as d094, d098, d108, d113, 118 — five times, the last one after it
shipped (memory: ``stale_context_doc_refiles_shipped_work``). The doc fix
(sacrifice PR #382) corrected ``context/modules/security.md`` and **only** that
file; the same false premise survived verbatim in ``context/current-state.md``
and ``context/modules/auth.md``, and on 2026-08-10T15:34 the same persona filed
five more (126–130), two of them against routes that already exist.

Fixing prose is necessary and not sufficient: there is no bound on how many docs
can hold a stale sentence. This module is the mechanical half — it asks the one
artifact in this repo that cannot be stale by accident,
``apps/<app>/derived/api_surface.json`` (AST-parsed from the real app tree by
``scripts/generate_sacrifice_api_surface.py``), whether the direction is asking
for a route that is already there.

What it flags, and what it deliberately does not
------------------------------------------------
A route is reported only when all three hold, inside ONE **claim unit** — the
direction's title, or one of its acceptance bullets. Nothing else is read: the
``## Why`` prose is background, and matching it produced false positives on
routes a direction merely builds on.

1. **The claim unit frames something as new** — an ADD verb (``add``,
   ``implement``, ``expose``, …).
2. **The same unit names the route** — the literal path, or the route's
   *distinctive* path segments (``/api/auth/password/reset/request`` →
   ``password`` + ``reset``). The leading ``api`` and the resource group
   (``auth``, ``goals``) are dropped, so ``/api/goals`` is unmatchable by
   segments: one generic word would flag half the backlog.
3. **The route is in the snapshot**, i.e. it already exists.

Requirement 1 is why a *harden*/*improve* direction is not flagged: it
presupposes the route exists, which is the opposite error. Direction 127
("Harden token lifecycle…") escapes this guard for exactly that reason, and that
is correct behaviour rather than a miss — see
``tests/test_direction_route_premise_guard.py``, which pins it.

Known imprecision, deliberately tolerated: an acceptance bullet that names an
*existing* route as scaffolding for a genuinely new one ("expose
``GET /api/goals/draft-count`` alongside ``GET /api/goals``") flags the
scaffolding route too. That is survivable because the check is advisory and runs
only where it can save money — ``factory approve-direction`` on a MACHINE-FILED,
still-pending direction. Operator-filed directions never reach it, and one
spurious line costs an operator one ``--acknowledge-shipped-routes``. Silently
approving a re-file costs a chain run.

This is a **premise** check, not a verdict on the work. A route existing does
not mean the behaviour behind it is complete: sacrifice's
``POST /api/auth/password/reset/request`` mints a reset token into a discarded
local and there is no email transport anywhere in ``backend/app`` (memory:
``criterion_vacuity_is_the_second_sensor_failure``). So the guard's job is to
make the operator look at the route before spending, never to auto-reject.
``factory approve-direction`` refuses once and takes
``--acknowledge-shipped-routes`` to proceed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

#: Verbs that frame a direction's title as ADDING something that is not there.
_ADD_VERB_RE = re.compile(
    r"\b(add|adds|adding|create|creates|creating|implement|implements|implementing"
    r"|introduce|introduces|introducing|expose|exposes|new|support)\b",
    re.IGNORECASE,
)

#: Single-segment route names too generic to carry a claim on their own. A route
#: whose only distinctive segment is one of these is never matched by segments
#: (it can still match by literal path).
_GENERIC_SEGMENTS: frozenset[str] = frozenset(
    {
        "me",
        "config",
        "status",
        "count",
        "counts",
        "stats",
        "history",
        "search",
        "lookup",
        "token",
        "tokens",
        "read-all",
        "messages",
        "sessions",
        "video",
        "health",
        "callback",
        "login",
        "logs",
        "dev",
    }
)


@dataclass(frozen=True)
class ShippedRouteClaim:
    """One route the direction asks for that the app's surface already has."""

    #: ``"POST /api/auth/logout"`` — method and path as the snapshot records them.
    route: str
    #: What in the direction's text matched (a literal path, or path segments).
    matched: tuple[str, ...]
    #: ``"literal-path"`` or ``"path-segments"``.
    kind: str

    def describe(self) -> str:
        return f"{self.route} (matched {', '.join(self.matched)}; {self.kind})"


def api_surface_path(app: str, software_factory_root: Path) -> Path:
    """Where the derived route-table snapshot for ``app`` lives."""
    return Path(software_factory_root) / "apps" / app / "derived" / "api_surface.json"


@lru_cache(maxsize=8)
def _load_surface_cached(path_str: str, mtime: float) -> tuple[dict[str, Any], ...]:
    data = json.loads(Path(path_str).read_text(encoding="utf-8"))
    routes = data.get("routes")
    if not isinstance(routes, list):
        return ()
    return tuple(r for r in routes if isinstance(r, dict) and r.get("path"))


def load_api_surface(app: str, software_factory_root: Path) -> tuple[dict[str, Any], ...] | None:
    """Return the derived routes for ``app``, or ``None`` when there is no snapshot.

    ``None`` is NOT "no conflicts" — it means the check could not run, and every
    caller must say so out loud rather than printing a clean bill of health. Only
    ``sacrifice`` ships a snapshot today; an app without one is unchecked, and an
    operator who is not told that will read silence as an all-clear.
    """
    path = api_surface_path(app, software_factory_root)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    try:
        return _load_surface_cached(str(path), mtime)
    except (OSError, ValueError):
        return None


def surface_provenance(app: str, software_factory_root: Path) -> str:
    """One-line provenance for the snapshot, for operator-facing messages."""
    path = api_surface_path(app, software_factory_root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "unknown"
    commit = str(data.get("source_commit") or "?")[:12]
    return f"{len(data.get('routes') or [])} routes, {app}@{commit}, generated {data.get('generated_at')}"


def route_segments(path: str) -> tuple[str, ...]:
    """Distinctive path segments of ``path``, lowercased.

    Drops path parameters, the leading ``api``, and the resource group, so
    ``/api/auth/password/reset/request`` → ``("password", "reset", "request")``
    and ``/api/goals`` → ``()``. A route with no distinctive segment is never
    matched by segments: matching on ``goals`` alone would flag every direction
    that mentions a goal.
    """
    segs = [s for s in path.strip("/").split("/") if s and not s.startswith("{")]
    if segs and segs[0] == "api":
        segs = segs[1:]
    if len(segs) < 2:
        return ()
    return tuple(s.lower() for s in segs[1:])


def _words(text: str) -> set[str]:
    """Whole words in ``text``, keeping hyphenated forms AND their parts.

    Both are needed. ``read-all`` and ``csrf-token`` are single route segments
    and must match as written; but a direction titled "…and logout-all" has to
    match the segment ``logout`` too, and a hyphen-preserving tokenizer alone
    silently missed exactly that on direction 128.
    """
    words: set[str] = set()
    for token in re.findall(r"[a-z0-9][a-z0-9_-]*", text.lower()):
        words.add(token)
        if "-" in token:
            words.update(part for part in token.split("-") if part)
    return words


def _literal_path_hit(path: str, text: str) -> bool:
    """True when ``path`` appears in ``text`` as a path, not as a prefix of a longer one."""
    pattern = re.escape(path)
    if "{" in path:
        pattern = re.sub(r"\\\{[^}]*\\\}", r"[^/\\s]+", pattern)
    return re.search(pattern + r"(?![\w-])", text, re.IGNORECASE) is not None


def _segments_hit(segments: tuple[str, ...], words: set[str]) -> tuple[str, ...]:
    """Segments of a route present in ``words``, or ``()`` when the hit is too weak."""
    present = tuple(s for s in segments if s in words)
    if len(segments) == 1:
        return present if present and segments[0] not in _GENERIC_SEGMENTS else ()
    return present if len(present) >= 2 else ()


def find_shipped_route_claims(
    claim_units: list[str],
    routes: tuple[dict[str, Any], ...],
) -> list[ShippedRouteClaim]:
    """Routes in ``routes`` that ``claim_units`` asks for as if they were new.

    ``claim_units`` is the direction's title followed by its acceptance bullets —
    the only text that commits the chain to build something.
    """
    units = [(u, _words(u)) for u in claim_units if u and _ADD_VERB_RE.search(u)]
    if not units:
        return []

    claims: dict[str, ShippedRouteClaim] = {}
    for route in routes:
        path = str(route.get("path") or "")
        if not path:
            continue
        label = f"{str(route.get('method') or '').upper()} {path}".strip()
        segments = route_segments(path)
        for unit, words in units:
            kind: str
            matched: tuple[str, ...]
            if _literal_path_hit(path, unit):
                kind, matched = "literal-path", (path,)
            else:
                matched = _segments_hit(segments, words)
                if not matched:
                    continue
                kind = "path-segments"
            claims[label] = ShippedRouteClaim(route=label, matched=matched, kind=kind)
            break
    return [claims[k] for k in sorted(claims)]


def direction_claim_units(direction: Any) -> list[str]:
    """Title + acceptance bullets: the text that commits the chain to build."""
    units = [str(direction.title or "")]
    units.extend(str(bullet) for bullet in (direction.acceptance or []))
    return [u for u in units if u.strip()]


def check_direction_route_premises(
    direction: Any,
    software_factory_root: Path,
) -> list[ShippedRouteClaim] | None:
    """Run the premise check for a parsed ``Direction``.

    Returns ``None`` when the app ships no derived route table — "unchecked", not
    "clean". See :func:`load_api_surface`.
    """
    routes = load_api_surface(direction.app, software_factory_root)
    if routes is None:
        return None
    return find_shipped_route_claims(direction_claim_units(direction), routes)


def render_route_table_block(app: str, software_factory_root: Path) -> str:
    """The route table as a prompt block for a tool-less scheduled persona.

    ``security`` runs through ``text_run``: it has no filesystem access, so
    telling it in the prompt to "check the route table" is unenforceable unless
    the table is IN the prompt. This renders it.
    """
    routes = load_api_surface(app, software_factory_root)
    if routes is None:
        return (
            f"# Derived route table for `{app}`\n\n"
            f"NOT AVAILABLE — this app ships no `apps/{app}/derived/api_surface.json`.\n"
            "You therefore cannot satisfy the route-citation rule for an endpoint\n"
            "claim, so do NOT claim any endpoint is missing in this run.\n"
        )
    lines = [
        f"# Derived route table for `{app}` (AUTHORITATIVE)\n",
        f"Machine-generated from the app tree — {surface_provenance(app, software_factory_root)}.",
        "This is the app's REAL HTTP surface. It outranks every prose context doc,",
        "including any 'remaining gaps' bullet: a doc can be months stale, this",
        "cannot. Before you claim an endpoint or flow is missing, find it here.",
        "A route being listed does NOT prove the behaviour behind it is complete —",
        "it proves the endpoint exists, so any finding about it is a GAP IN AN",
        "EXISTING ROUTE, never a request to add it.\n",
    ]
    for route in routes:
        lines.append(f"- `{str(route.get('method') or '').upper()} {route.get('path')}`")
    return "\n".join(lines) + "\n"


__all__ = [
    "ShippedRouteClaim",
    "api_surface_path",
    "check_direction_route_premises",
    "direction_claim_units",
    "find_shipped_route_claims",
    "load_api_surface",
    "render_route_table_block",
    "route_segments",
    "surface_provenance",
]
