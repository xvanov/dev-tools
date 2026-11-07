"""Per-unit cost/token/time audit rollups against the ``runs`` table.

D003 — "accurate, complete, auditable per-unit cost/token/time accounting".
This module answers the operator question ``spend.py`` cannot: not just
"how much did we spend today" but "spend broken down by story / by
direction / by app, and how much of it can we NOT attribute to any of
those?"

``CHAIN_PERSONAS`` is the set of personas the D003 direction requires to
stamp ``story_id`` + ``direction_id`` + ``app`` on every run (sm, dev,
reviewer, tech_writer, onboarder, test_implementer). ``docs_enforcer`` is a
deterministic canonical-paths check with no LLM call, so it never produces a
``runs`` row and is intentionally excluded here — including it would make
the unattributed-count denominator wrong. A chain-persona run with a NULL
``story_id`` is "unattributed" — a completeness gap the operator should
drive toward zero for new runs.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel import Session, select

from factory.runner import Run, _engine

# Personas the D003 direction requires to stamp story_id/direction_id/app.
# ``docs_enforcer`` is deliberately excluded — see module docstring.
CHAIN_PERSONAS: frozenset[str] = frozenset(
    {
        "sm",
        "dev",
        "reviewer",
        "tech_writer",
        "onboarder",
        "test_implementer",
    }
)


@dataclass
class RollupRow:
    """One grouped row: tokens/cost/duration summed over its runs."""

    key: str
    run_count: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    duration_s: float = 0.0
    # True if ANY run in this bucket used a model whose price registration
    # carries an "estimated" ``factory_cost_note`` (currently only
    # ``azure/deepseek-v4-pro``'s cache-read rate) — the CLI marks these
    # rows with ``~`` so operators don't read a guess as exact.
    has_estimated_cost: bool = False
    # True if ANY run in this bucket made a real model call whose usage/cost we
    # could NOT read (``Run.usage_reliable is False``). Distinct from
    # ``has_estimated_cost``: that flags a known-quantity priced at a guessed
    # RATE; this flags a quantity we never measured at all, so the bucket's
    # cost is a floor. The CLI marks these rows with ``?``.
    has_unreliable_usage: bool = False
    # Number of runs in the bucket flagged unreliable — lets an operator see
    # whether it's one straggler or the whole bucket.
    unreliable_run_count: int = 0


@dataclass
class UnattributedSummary:
    """Chain-persona runs with no ``story_id`` — an attribution gap."""

    run_count: int = 0
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    by_persona: dict[str, int] = field(default_factory=dict)


@dataclass
class AuditReport:
    window_days: int
    total_run_count: int
    total_cost_usd: float
    by_story: list[RollupRow]
    by_direction: list[RollupRow]
    by_app: list[RollupRow]
    unattributed: UnattributedSummary
    # Cost-accuracy caveat (D003 follow-up): the share of ``total_cost_usd``
    # that came from a model whose price registration is flagged
    # ESTIMATED (see ``_model_cost_is_estimated``) — today that's just
    # ``azure/deepseek-v4-pro``'s cache-read rate, which has no published
    # Azure meter and was derived by scaling a same-model rate published for
    # a different host. Operators must not read cost_usd as exact for the
    # runs this covers until it's reconciled against a real provider bill.
    estimated_cost_usd: float = 0.0
    estimated_cost_pct: float = 0.0
    estimated_models: tuple[str, ...] = ()
    # Usage-completeness caveat: runs that DID call a model but whose usage or
    # cost could not be read (``Run.usage_reliable is False``). Their recorded
    # cost is a floor, so ``total_cost_usd`` understates by an unknown amount.
    # ``unreliable_usage_pct`` is the share of runs, not of dollars — the whole
    # point is that we don't know their dollars.
    #
    # Legacy rows (written before the column existed) have ``usage_reliable is
    # None`` and are counted in ``unknown_usage_run_count`` instead, so a
    # backfill gap can't masquerade as a clean bill of health.
    unreliable_usage_run_count: int = 0
    unreliable_usage_pct: float = 0.0
    unknown_usage_run_count: int = 0


def _window_runs(
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
    days: int,
) -> list[Run]:
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    cutoff = datetime.now(UTC) - timedelta(days=days)
    out: list[Run] = []
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
    for r in rows:
        try:
            ts = datetime.fromisoformat(r.ts)
        except (TypeError, ValueError):
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        if ts >= cutoff:
            out.append(r)
    return out


_ESTIMATED_MARKER = "estimated"


def _model_cost_is_estimated(model: str) -> bool:
    """True if ``model``'s LiteLLM price registration flags itself as an
    ESTIMATE rather than a published provider rate.

    Keys off the ``factory_cost_note`` metadata stamped by
    ``factory.providers.azure_foundry._register_litellm_pricing`` (currently
    only ``azure/deepseek-v4-pro``, whose cache-read rate has no published
    Azure meter). This is a live introspection of LiteLLM's price table —
    not a hardcoded model list — so the flag stays correct if the note is
    ever removed (rate confirmed) or added to another model.
    """
    try:
        from factory.providers.azure_foundry import ensure_bootstrapped

        ensure_bootstrapped()
        import litellm

        entry = litellm.model_cost.get(model) or {}
        note = str(entry.get("factory_cost_note", ""))
        return _ESTIMATED_MARKER in note.lower()
    except Exception:
        return False


def _rollup(runs: list[Run], keyfn: Callable[[Run], str | None]) -> list[RollupRow]:
    buckets: dict[str, RollupRow] = {}
    for r in runs:
        key = keyfn(r)
        if key is None:
            continue
        row = buckets.setdefault(key, RollupRow(key=key))
        row.run_count += 1
        row.tokens_in += r.tokens_in or 0
        row.tokens_out += r.tokens_out or 0
        row.cost_usd += float(r.cost_usd or 0.0)
        row.duration_s += float(r.duration_s or 0.0)
        if _model_cost_is_estimated(r.model):
            row.has_estimated_cost = True
        if getattr(r, "usage_reliable", None) is False:
            row.has_unreliable_usage = True
            row.unreliable_run_count += 1
    for row in buckets.values():
        row.cost_usd = round(row.cost_usd, 6)
    return sorted(buckets.values(), key=lambda row: row.cost_usd, reverse=True)


def _unattributed(runs: list[Run]) -> UnattributedSummary:
    summary = UnattributedSummary()
    for r in runs:
        if r.persona not in CHAIN_PERSONAS or r.story_id is not None:
            continue
        summary.run_count += 1
        summary.cost_usd += float(r.cost_usd or 0.0)
        summary.tokens_in += r.tokens_in or 0
        summary.tokens_out += r.tokens_out or 0
        summary.by_persona[r.persona] = summary.by_persona.get(r.persona, 0) + 1
    summary.cost_usd = round(summary.cost_usd, 6)
    return summary


def build_audit_report(
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
    days: int = 7,
) -> AuditReport:
    """Roll up tokens/cost/duration per story, per direction, per app.

    Also reports the total chain-persona spend with no ``story_id`` (the
    "unattributed" bucket) so an operator can see how complete the
    attribution is for the window, not just what it totals to.
    """
    runs = _window_runs(software_factory_root, db_path=db_path, days=days)

    by_story = _rollup(runs, lambda r: str(r.story_id) if r.story_id is not None else None)
    by_direction = _rollup(runs, lambda r: r.direction_id)
    by_app = _rollup(runs, lambda r: r.app)
    unattributed = _unattributed(runs)

    total_cost_usd = round(sum(float(r.cost_usd or 0.0) for r in runs), 6)
    estimated_cost_usd = 0.0
    estimated_models: set[str] = set()
    for r in runs:
        if _model_cost_is_estimated(r.model):
            estimated_cost_usd += float(r.cost_usd or 0.0)
            estimated_models.add(r.model)
    estimated_cost_usd = round(estimated_cost_usd, 6)
    estimated_cost_pct = (
        round(100.0 * estimated_cost_usd / total_cost_usd, 2) if total_cost_usd else 0.0
    )

    # Usage completeness. A run is only "unreliable" when it explicitly recorded
    # False — None means the row predates the column, which is a DIFFERENT
    # (and equally reportable) kind of not-knowing.
    unreliable_usage_run_count = sum(1 for r in runs if getattr(r, "usage_reliable", None) is False)
    unknown_usage_run_count = sum(1 for r in runs if getattr(r, "usage_reliable", None) is None)
    unreliable_usage_pct = round(100.0 * unreliable_usage_run_count / len(runs), 2) if runs else 0.0

    return AuditReport(
        window_days=days,
        total_run_count=len(runs),
        total_cost_usd=total_cost_usd,
        by_story=by_story,
        by_direction=by_direction,
        by_app=by_app,
        unattributed=unattributed,
        estimated_cost_usd=estimated_cost_usd,
        estimated_cost_pct=estimated_cost_pct,
        estimated_models=tuple(sorted(estimated_models)),
        unreliable_usage_run_count=unreliable_usage_run_count,
        unreliable_usage_pct=unreliable_usage_pct,
        unknown_usage_run_count=unknown_usage_run_count,
    )


def count_unattributed_chain_runs(
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
    days: int = 7,
) -> int:
    """Count chain-persona runs with NULL ``story_id`` in the window.

    The completeness metric the D003 direction asks for: this should trend
    to ~0 for NEW runs going forward, even though the historical backlog
    (pre-fix rows) will never attribute cleanly.
    """
    runs = _window_runs(software_factory_root, db_path=db_path, days=days)
    return _unattributed(runs).run_count


__all__ = [
    "CHAIN_PERSONAS",
    "AuditReport",
    "RollupRow",
    "UnattributedSummary",
    "build_audit_report",
    "count_unattributed_chain_runs",
]
