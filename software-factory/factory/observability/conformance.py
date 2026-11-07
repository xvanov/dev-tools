"""Replay checker for the story control plane — judges the runtime trace.

The question this module answers is NOT "does the state machine look correct?"
but "did the running code emit a trace the model accepts?". It consumes the
``state_writes`` stream produced by :mod:`factory.observability.state_trace` and
validates every recorded hop against ``conformance_model.yaml``.

Independence
------------
This module reads ONLY the YAML model and the trace record schema. It must
never import ``_TRANSITIONS``, ``advance``, or ``_dispatch_for_story``: sharing
the transition table between the emitter and the checker would let a bug in the
table hide itself from both, which is precisely the failure being guarded
against. ``tests/test_conformance.py`` asserts the YAML and the table agree, so
drift is a CI failure rather than silent mutual agreement.

Verdicts
--------
``legal_edge``
    The hop is an edge the transition table can produce. Nothing to see.
``legal_path``
    Not a single edge, but the *net effect* of a chain of legal edges that one
    handler dispatch can produce. This is the common case in real traces: a
    handler enters its ``*_in_progress`` state and exits to its terminal state
    within one dispatch, persisting only once, so the row moves
    ``tests_green -> reviewer_done`` without ``reviewer_in_progress`` ever
    reaching disk. Measured against the live stream, 249 of 270 real hops have
    this shape — a checker that demanded single edges would flag them all and be
    switched off within a day.
``allowed_direct_write``
    Not a table edge, but a writer explicitly sanctioned in the model to bypass
    ``advance()`` (source state is "any in-flight", so no single event fits).
``illegal_transition``
    A sanctioned writer produced a state it is not permitted to produce, or an
    unsanctioned hop from a known writer. The control plane was violated.
``coverage_breach``
    The hop's writer is unknown to the model — an undocumented code path that
    changes control-plane state, or a write we could not attribute at all.

The last verdict is the load-bearing one. Without it a conformance check only
validates the paths someone remembered to declare, and silently blesses
everything else — decorative logging rather than a gate. A breach is a finding
to triage (either the path is legitimate and belongs in the model, or it is a
bug), which is why the checker reports rather than raises.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

_MODEL_PATH = Path(__file__).with_name("conformance_model.yaml")

# Verdict constants — string-valued so they survive a JSON round trip into the
# alerts stream and the detector output.
LEGAL_EDGE = "legal_edge"
LEGAL_PATH = "legal_path"
ALLOWED_DIRECT_WRITE = "allowed_direct_write"
ILLEGAL_TRANSITION = "illegal_transition"
COVERAGE_BREACH = "coverage_breach"

# The verdicts that constitute a finding an operator (or the FMS) should look at.
FINDING_VERDICTS = frozenset({ILLEGAL_TRANSITION, COVERAGE_BREACH})

_WILDCARD = "*"

# How many table edges a single persisted hop may collapse.
#
# Two, because one handler dispatch is at most "enter my in-progress state, do
# the work, exit to my outcome state" — and the orchestrator persists once, at
# the end. Allowing three or more would start accepting genuine SKIPS (a story
# jumping past a whole phase, e.g. sm_done straight to reviewer_done), which is
# exactly the class of bug this checker exists to catch. The bound is the
# strictness: raise it and the check weakens.
_MAX_PATH_EDGES = 2


@dataclass(frozen=True)
class WriterRule:
    """What one sanctioned direct-writing code path is permitted to do.

    ``targets`` / ``sources`` are state-name sets (``{"*"}`` meaning any).
    ``allow_rollback`` additionally permits a hop whose REVERSE direction is a
    legal path: that is the exact shape of the orchestrator's crash rollback and
    stale-in-progress rewind, which restore a story to a state it legitimately
    came from. Expressing it this way rather than with a ``*`` target keeps
    forward phase-SKIPS detectable, which a wildcard would silently accept.
    """

    targets: frozenset[str]
    sources: frozenset[str]
    allow_rollback: bool = False


@dataclass(frozen=True)
class ConformanceModel:
    """The abstract model, loaded from YAML."""

    legal_edges: frozenset[tuple[str, str]]
    # writer -> declared permissions
    allowed_writers: dict[str, WriterRule]

    def edge_is_legal(self, from_state: str | None, to_state: str) -> bool:
        return (str(from_state), to_state) in self.legal_edges

    def shortest_path(self, from_state: str | None, to_state: str) -> list[str] | None:
        """Return the shortest chain of legal edges ``from_state -> to_state``.

        Bounded at :data:`_MAX_PATH_EDGES` edges. ``None`` when no such short
        path exists — which is what makes a genuine phase skip detectable.
        Breadth-first so the returned path is minimal, and the bound keeps the
        search trivially cheap regardless of graph size.
        """
        start = str(from_state)
        if start == to_state:
            return None
        frontier: list[list[str]] = [[start]]
        for _ in range(_MAX_PATH_EDGES):
            next_frontier: list[list[str]] = []
            for path in frontier:
                for edge_from, edge_to in self.legal_edges:
                    if edge_from != path[-1]:
                        continue
                    if edge_to in path:  # never loop back through a visited state
                        continue
                    extended = [*path, edge_to]
                    if edge_to == to_state:
                        return extended
                    next_frontier.append(extended)
            frontier = next_frontier
            if not frontier:
                break
        return None


@dataclass
class Hop:
    """One judged state change."""

    verdict: str
    story_id: int | None
    app: str | None
    from_state: str | None
    to_state: str
    writer: str
    ts: str | None = None
    reason: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "story_id": self.story_id,
            "app": self.app,
            "from_state": self.from_state,
            "to_state": self.to_state,
            "writer": self.writer,
            "ts": self.ts,
            "reason": self.reason,
        }


@dataclass
class ConformanceReport:
    """Aggregate result of replaying a trace."""

    checked: int = 0
    counts: dict[str, int] = field(default_factory=dict)
    findings: list[Hop] = field(default_factory=list)
    unknown_writers: list[str] = field(default_factory=list)

    @property
    def conformant(self) -> bool:
        """True when no hop produced a finding verdict."""
        return not self.findings

    def as_dict(self) -> dict[str, Any]:
        return {
            "checked": self.checked,
            "conformant": self.conformant,
            "counts": dict(self.counts),
            "unknown_writers": list(self.unknown_writers),
            "findings": [f.as_dict() for f in self.findings],
        }


def load_model(path: Path | None = None) -> ConformanceModel:
    """Load and validate ``conformance_model.yaml``.

    Raises ``ValueError`` on a malformed model: unlike the telemetry write path
    (which must degrade quietly), a checker that silently loads an empty model
    would report perfect conformance for every trace — the worst possible
    failure mode for a verifier.
    """
    model_path = path or _MODEL_PATH
    raw = yaml.safe_load(model_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{model_path}: top-level must be a mapping")

    edges_raw = raw.get("legal_edges")
    if not isinstance(edges_raw, list) or not edges_raw:
        raise ValueError(f"{model_path}: legal_edges must be a non-empty list")
    edges: set[tuple[str, str]] = set()
    for entry in edges_raw:
        if not isinstance(entry, dict) or "from" not in entry or "to" not in entry:
            raise ValueError(f"{model_path}: bad legal_edges entry {entry!r}")
        edges.add((str(entry["from"]), str(entry["to"])))

    writers: dict[str, WriterRule] = {}
    for entry in raw.get("allowed_direct_writes") or []:
        if not isinstance(entry, dict) or "writer" not in entry:
            raise ValueError(f"{model_path}: bad allowed_direct_writes entry {entry!r}")
        if "why" not in entry:
            # A bypass without a recorded rationale is how an allowlist rots
            # into a rubber stamp. Make the omission a load error.
            raise ValueError(
                f"{model_path}: allowed_direct_writes entry for "
                f"{entry['writer']!r} must carry a 'why'"
            )
        targets = entry.get("to", [])
        if isinstance(targets, str):
            targets = [targets]
        sources = entry.get("from", _WILDCARD)
        if isinstance(sources, str):
            sources = [sources]
        writers[str(entry["writer"])] = WriterRule(
            targets=frozenset(str(t) for t in targets),
            sources=frozenset(str(s) for s in sources),
            allow_rollback=bool(entry.get("allow_rollback", False)),
        )

    return ConformanceModel(legal_edges=frozenset(edges), allowed_writers=writers)


def _matches(value: str | None, allowed: frozenset[str]) -> bool:
    return _WILDCARD in allowed or str(value) in allowed


def judge_hop(record: dict[str, Any], model: ConformanceModel) -> Hop:
    """Classify a single ``state_write`` record against ``model``."""
    raw_from = record.get("from_state")
    from_state = str(raw_from) if raw_from is not None else None
    to_state = str(record.get("to_state") or "")
    writer = str(record.get("writer") or "unknown")
    raw_story_id = record.get("story_id")
    raw_app = record.get("app")
    raw_ts = record.get("ts")

    def _hop(verdict: str, reason: str = "") -> Hop:
        return Hop(
            verdict=verdict,
            story_id=int(raw_story_id) if isinstance(raw_story_id, int) else None,
            app=str(raw_app) if raw_app is not None else None,
            from_state=from_state,
            to_state=to_state,
            writer=writer,
            ts=str(raw_ts) if raw_ts is not None else None,
            reason=reason,
        )

    if model.edge_is_legal(from_state, to_state):
        return _hop(LEGAL_EDGE)

    # One dispatch usually persists only its NET effect, collapsing the
    # in-progress hop. Accept a short chain of legal edges before considering
    # the hop suspicious — but keep the bound tight so a real phase skip
    # still fails.
    path = model.shortest_path(from_state, to_state)
    if path is not None:
        return _hop(LEGAL_PATH, "net effect of one dispatch: " + " -> ".join(path))

    # Not reachable through the table — it must be a sanctioned bypass, or it
    # is a finding.
    if writer not in model.allowed_writers:
        return _hop(
            COVERAGE_BREACH,
            f"writer {writer!r} is not declared in the model and no legal path "
            f"of <={_MAX_PATH_EDGES} edges explains {from_state} -> {to_state}, "
            "so this is an undocumented control-plane path",
        )

    rule = model.allowed_writers[writer]

    # A rollback restores a story to a state it legitimately came from, so the
    # REVERSE hop is a legal path. Checked before the target list because a
    # rollback's target is by definition data-driven and cannot be enumerated.
    if rule.allow_rollback:
        reverse = model.shortest_path(to_state, str(from_state))
        if reverse is not None or model.edge_is_legal(to_state, str(from_state)):
            return _hop(
                ALLOWED_DIRECT_WRITE,
                f"rollback: reverse hop {to_state} -> {from_state} is legal",
            )

    if not _matches(to_state, rule.targets):
        return _hop(
            ILLEGAL_TRANSITION,
            f"writer {writer!r} is only permitted to produce {sorted(rule.targets)}"
            + (" (or a rollback)" if rule.allow_rollback else "")
            + f", but produced {to_state!r} from {from_state!r}",
        )
    if not _matches(from_state, rule.sources):
        return _hop(
            ILLEGAL_TRANSITION,
            f"writer {writer!r} is only permitted to write from "
            f"{sorted(rule.sources)}, but wrote from {from_state!r}",
        )
    return _hop(ALLOWED_DIRECT_WRITE)


def check_trace(
    records: list[dict[str, Any]],
    *,
    model: ConformanceModel | None = None,
) -> ConformanceReport:
    """Replay ``records`` against the model and return a report.

    Pure: no I/O, no DB, no mutation. Feed it
    ``state_trace.read_state_writes()`` output (or a synthetic list in tests).
    """
    resolved = model or load_model()
    report = ConformanceReport()
    counter: Counter[str] = Counter()
    unknown: set[str] = set()

    for record in records:
        hop = judge_hop(record, resolved)
        report.checked += 1
        counter[hop.verdict] += 1
        if hop.verdict in FINDING_VERDICTS:
            report.findings.append(hop)
        if hop.verdict == COVERAGE_BREACH:
            unknown.add(hop.writer)

    report.counts = dict(sorted(counter.items()))
    report.unknown_writers = sorted(unknown)
    return report


def check_live_trace(
    *,
    software_factory_root: Path | None = None,
    app: str | None = None,
    story_id: int | None = None,
    model: ConformanceModel | None = None,
) -> ConformanceReport:
    """Read the on-disk ``state_writes`` stream and check it. Read-only."""
    from factory.observability.state_trace import read_state_writes

    records = read_state_writes(software_factory_root=software_factory_root, story_id=story_id)
    if app is not None:
        records = [r for r in records if r.get("app") == app]
    return check_trace(records, model=model)
