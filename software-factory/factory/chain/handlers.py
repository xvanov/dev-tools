"""Chain handlers — one per state transition.

Each handler:
  * Takes ``(story, app_config, software_factory_root, *, dry_run=False)``.
  * Returns a ``HandlerResult`` carrying the next state, an opaque payload,
    and an optional error.
  * Is responsible for ALL side effects of its transition: LLM calls,
    GitHub API calls, filesystem writes, DB writes.
  * In ``dry_run=True`` mode, MUST NOT make any LLM calls, MUST NOT touch
    GitHub, MUST NOT write to the app repo. The deterministic fixture
    payload exercises the downstream state shape.

The orchestrator (``factory/chain/orchestrator.py``) decides which handler
to invoke based on the story's current state.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, SQLModel, create_engine, select

from factory import diff_paths as _diff_paths
from factory.app_config import AppConfig
from factory.chain.delivery_gate import EVENT_DELIVERED as DELIVERY_EVENT_DELIVERED
from factory.chain.delivery_gate import commit_local_work
from factory.chain.delivery_gate import story_level as delivery_story_level
from factory.chain.event_log import log_story_event
from factory.chain.state_machine import (
    DELIVERED_UNMERGED_STATES,
    EVENT_DELIVERED_BRANCH,
    EVENT_DELIVERED_LOCAL,
    EVENT_DEV_EXHAUSTED,
    EVENT_DEV_STARTED,
    EVENT_DEV_TESTS_GREEN,
    EVENT_DEV_TESTS_RED,
    EVENT_DEV_UNDERSPECIFIED,
    EVENT_DOCS_ENFORCER_CHECK,
    EVENT_DOCS_ENFORCER_FAIL,
    EVENT_DOCS_ENFORCER_PASS,
    EVENT_DOCS_ONBOARDER_DONE,
    EVENT_DOCS_ONBOARDER_FAILED,
    EVENT_DOCS_ONBOARDER_STARTED,
    EVENT_DOCS_SM_DONE,
    EVENT_DOCS_SM_STARTED,
    EVENT_PR_CREATE_EXHAUSTED,
    EVENT_REVIEW_NONCONVERGENT,
    EVENT_REVIEWER_APPROVE,
    EVENT_REVIEWER_REQUEST_CHANGES,
    EVENT_REVIEWER_STARTED,
    EVENT_SM_DONE,
    EVENT_SM_STARTED,
    EVENT_TECH_WRITER_DONE,
    EVENT_TECH_WRITER_STARTED,
    IllegalTransitionError,
    StoryRecord,
    StoryState,
    advance,
    is_terminal,
)
from factory.chain.step_events import emit_chain_step
from factory.chain.worktree import ensure_worktree_for_story
from factory.context.enforcer import format_violation_comment, scan_pr_diff
from factory.context.updater import ContextUpdate, apply_context_updates
from factory.delivery import DeliveryLevel
from factory.directions.parser import Direction, list_direction_dirs, parse_direction_dir
from factory.model_router import max_output_tokens_for, route
from factory.runtime_state import effective_deploy_enabled

_logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Result type
# --------------------------------------------------------------------------- #


@dataclass
class HandlerResult:
    """Outcome of a single handler invocation."""

    next_state: StoryState
    payload: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


# --------------------------------------------------------------------------- #
# Per-story worktree helper
# --------------------------------------------------------------------------- #


def _writing_worktree(
    app_config: AppConfig,
    software_factory_root: Path,
    story: StoryRecord,
) -> Path:
    """Resolve (and lazily create) the per-story worktree the chain writes
    into.

    All "writing" handlers — those that run a sandbox, commit, or push —
    must use this instead of ``resolve_app_repo_path``. The source repo
    at ``app_repo_path`` is the operator's checkout and is treated as
    read-only by the chain; each in-flight story gets its own private
    worktree under ``state/worktrees/`` so multiple sandboxes can run
    in parallel without racing on a shared working tree.

    Read-only callsites (context-prelude scans) keep using
    ``resolve_app_repo_path`` because they don't mutate state.
    """
    import subprocess

    from factory.app_config import resolve_app_repo_path

    source_repo = resolve_app_repo_path(app_config, software_factory_root)
    from factory.chain.delivery_gate import stack_parent

    parent = stack_parent(story, Path(software_factory_root) / "state" / "factory.db")
    wt = ensure_worktree_for_story(
        source_repo,
        software_factory_root=software_factory_root,
        app=story.app,
        story_id=story.github_issue_number,
        slug=story.slug,
        base_branch=app_config.default_branch or "main",
        stack_on=parent.github_branch if parent is not None else None,
    )

    # Refresh the worktree against the CURRENT base before the writing handler
    # runs. ensure_worktree_for_story's reuse path returns a worktree cut from
    # an OLD base; when a fix merges to main while a story is mid-flight (e.g. a
    # sibling un-breaks the test suite), that in-flight story's dev run keeps
    # testing against the stale base and can never go green — the dev churns on
    # a failure it cannot fix. The PR-open path already re-merges base at PR
    # time (see _open_pr_for_story); do the same here so every dev/writing
    # attempt sees since-merged fixes. Best-effort and NON-destructive: `git
    # merge` preserves uncommitted WIP that doesn't overlap the merged files,
    # and on ANY conflict/dirty-overlap we abort and proceed on the current
    # base (never silently clobber the dev's in-progress work).
    base = app_config.default_branch or "main"
    try:
        subprocess.run(
            ["git", "fetch", "origin", base],
            cwd=str(wt),
            check=False,
            capture_output=True,
            timeout=60,
        )
        merged = subprocess.run(
            ["git", "merge", "--no-edit", f"origin/{base}"],
            cwd=str(wt),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if merged.returncode != 0:
            subprocess.run(
                ["git", "merge", "--abort"],
                cwd=str(wt),
                check=False,
                capture_output=True,
                timeout=60,
            )
    except (OSError, subprocess.SubprocessError):
        pass  # base refresh is best-effort; never block the writing handler
    finally:
        # CRITICAL: if the merge timed out or the process was killed mid-merge,
        # the except above skips the return-code abort and leaves the worktree
        # with MERGE_HEAD + an unmerged index. A later `git add -A` + commit in
        # a writing handler would then bake unresolved conflict markers into a
        # real commit and push them (silent corruption, worse than a stale
        # base). Guarantee no in-progress merge is ever left behind, however
        # the merge call exited.
        _abort_inflight_merge(wt)
    return wt


def _abort_inflight_merge(worktree: Path) -> None:
    """Best-effort: clear a left-in-progress merge (MERGE_HEAD present) so no
    downstream ``git add -A`` + commit can bake conflict markers into a real
    commit. Idempotent — a no-op when no merge is in progress."""
    import subprocess

    try:
        head = subprocess.run(
            ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"],
            cwd=str(worktree),
            capture_output=True,
            timeout=15,
        )
        if head.returncode == 0:
            subprocess.run(
                ["git", "merge", "--abort"],
                cwd=str(worktree),
                check=False,
                capture_output=True,
                timeout=30,
            )
    except (OSError, subprocess.SubprocessError):
        pass


# --------------------------------------------------------------------------- #
# DB helpers
# --------------------------------------------------------------------------- #


_MIGRATION_COLUMNS: dict[str, str] = {
    # column_name -> SQL type (idempotent ALTER TABLE ADD COLUMN if missing).
    "sm_result_json": "TEXT",
    "last_rejection_reason": "TEXT",
    # Docs-chain support. Default ``"tdd"`` keeps pre-existing stories on the
    # historical pipeline; new docs-scope stories opt in via PM's child_story
    # output (``chain_kind: "docs"``).
    "chain_kind": "TEXT NOT NULL DEFAULT 'tdd'",
    # Per-job routing stamped at spawn (factory/job_routing.py). Pre-existing
    # stories gain ``chain`` / NULL = exactly today's routing.
    "pipeline": "TEXT NOT NULL DEFAULT 'chain'",
    "model_overrides_json": "TEXT",
    # JSONL of prior dev sandbox attempts (one entry per chain-level retry):
    # ``[{attempt, ts, test_output_tail, files_touched, summary}, ...]``.
    # Fed forward into the next dev invocation's initial message so the LLM
    # sees what it already tried and what failed.
    "dev_attempts_json": "TEXT",
    # WS4.2 resume-from-checkpoint marker (see StoryRecord.dev_step_checkpoint).
    # Nullable TEXT; pre-existing stories gain it as NULL and are unaffected.
    "dev_step_checkpoint": "TEXT",
    # Item 4 — harness precheck flag. Bool, default 0 (False). SQLite
    # stores bool as 0/1 INTEGER; the SQLModel layer coerces on read.
    "harness_precheck_passed": "INTEGER NOT NULL DEFAULT 0",
    # Hard convergence guard counter. INTEGER default 0; pre-existing stories
    # gain it on next visit and start counting from their next reviewer pass.
    "reviewer_cycles": "INTEGER NOT NULL DEFAULT 0",
    # Review-cycle history (last 4 cycles) — reviewer finality memory + dev's
    # "already addressed" digest. See StoryRecord.reviewer_history_json.
    "reviewer_history_json": "TEXT",
    # WS1.2 independent acceptance oracle. ``acceptance_test_ref`` is the stored
    # test path; ``acceptance_expected`` (INTEGER 0/1) is the required/blocking
    # source of truth (set at spawn regardless of authoring success). Pre-WS1.2
    # stories gain both on next visit: expected defaults 0 so they are never
    # retroactively blocked.
    "acceptance_test_ref": "TEXT",
    "acceptance_expected": "INTEGER NOT NULL DEFAULT 0",
    # WS1.1 per-story budget circuit breaker. Aggregate accumulators the
    # pre-dispatch breaker reads; without these ALTERs an existing factory.db
    # (predating the breaker) raises ``no such column: total_attempts`` on the
    # first orchestrator read. Pre-existing stories start at 0 and accrue from
    # their next dispatch, so none are retroactively tripped.
    "total_attempts": "INTEGER NOT NULL DEFAULT 0",
    "total_spend_usd": "REAL NOT NULL DEFAULT 0",
    # WS1.1 advance-decay high-water mark (see StoryRecord.max_progress_ordinal).
    # Pre-existing stories start at 0 and register their progress on next visit;
    # a story mid-flight simply gets its first decay when it next advances to a
    # state above its (freshly-recorded) mark — never retroactively tripped.
    "max_progress_ordinal": "INTEGER NOT NULL DEFAULT 0",
    # Dependency-deferral cap counter (see StoryRecord.dependency_defer_count).
    # Pre-existing rows gain it as 0 and start counting from their next stalled
    # deferral — none is retroactively parked.
    "dependency_defer_count": "INTEGER NOT NULL DEFAULT 0",
    # S4 (019 fail-silent audit) — see StoryRecord.pr_create_retries.
    # Pre-existing rows gain it as 0; none is retroactively parked.
    "pr_create_retries": "INTEGER NOT NULL DEFAULT 0",
    # Per-story delivery level (see StoryRecord.delivery_level). Pre-existing
    # rows gain NULL and are resolved + recorded on first touch by
    # ``delivery_gate.story_level`` — a legacy app resolves to auto_merge, so
    # no in-flight story changes behaviour.
    "delivery_level": "TEXT",
}


def _ensure_story_columns(eng: Any) -> None:
    """Idempotently add Phase 3 columns to the ``stories`` table if missing.

    SQLModel.metadata.create_all() only creates tables that don't exist; it
    won't add new columns to an existing table. For dev we don't need full
    Alembic — just an ``ALTER TABLE ADD COLUMN`` for the small set of new
    columns Phase 3 introduces. Adding a column twice raises; we suppress
    that specific failure.
    """
    from sqlalchemy import text

    from factory.observability.schema import stories_migration_columns

    # Use the MERGED column set, not this module's dict alone: the observability
    # layer migrates the same table from its own list, and the two had drifted
    # apart. Which columns a live factory.db gained used to depend on which
    # engine opened it first.
    with eng.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(stories)")).fetchall()
        existing = {r[1] for r in rows}
        for col, sqltype in stories_migration_columns():
            if col in existing:
                continue
            conn.execute(text(f"ALTER TABLE stories ADD COLUMN {col} {sqltype}"))


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    _ensure_story_columns(eng)
    return eng


def persist_story(story: StoryRecord, db_path: Path, *, allow_reopen: bool = False) -> StoryRecord:
    """Insert-or-update ``story`` in ``state/factory.db.stories``.

    STALE WRITE-BACK GUARD (review 2026-11-02, N2): a handler that loaded the
    row before ``factory job cancel`` parked it would otherwise save its stale
    ``state`` straight over ``closed_by_operator`` — resurrecting cancelled
    work, which the end-of-tick auto-merge then merged. A row whose COMMITTED
    state is ``closed_by_operator`` keeps it: the in-memory state is reverted
    (other columns are still saved — they are evidence, not control) and a
    ``stale_writeback_blocked`` event is logged. Only an explicit operator
    revival (``factory resume-story``) passes ``allow_reopen=True``.
    """
    eng = _engine(db_path)
    from datetime import UTC, datetime

    story.updated_at = datetime.now(UTC).isoformat()
    closed = StoryState.CLOSED_BY_OPERATOR.value
    blocked_from: str | None = None
    if story.id is not None and not allow_reopen and story.state != closed:
        with Session(eng) as probe:
            committed = probe.exec(
                select(StoryRecord.state).where(StoryRecord.id == story.id)
            ).first()
        if committed == closed:
            blocked_from = story.state
            story.state = closed
    if blocked_from is not None:
        _logger.warning(
            "story %s: blocked a stale write-back %s -> over closed_by_operator",
            story.id,
            blocked_from,
        )
        try:
            from factory.chain.event_log import log_story_event

            log_story_event(
                story.id,
                "stale_writeback_blocked",
                {"attempted_state": blocked_from, "kept_state": closed},
                software_factory_root=_root_for_db(db_path),
                slug_hint=story.slug or "",
            )
        except Exception:  # noqa: BLE001 - telemetry only
            pass
    with Session(eng) as session:
        session.add(story)
        session.commit()
        session.refresh(story)
    return story


def _root_for_db(db_path: Path) -> Path:
    """``<root>/state/factory.db`` → ``<root>`` (the event log lives there)."""
    p = Path(db_path)
    return p.parent.parent if p.parent.name == "state" else p.parent


def get_story(story_id: int, db_path: Path) -> StoryRecord | None:
    eng = _engine(db_path)
    with Session(eng) as session:
        return session.get(StoryRecord, story_id)


def stories_in_flight(app: str, db_path: Path) -> list[StoryRecord]:
    """Return every story whose state is not terminal.

    Phase 5 adds DEPLOY_PENDING as an active state (the orchestrator drives
    it to DEPLOYED or BLOCKED_DEPLOY_FAILED). DEPLOYED and
    BLOCKED_DEPLOY_FAILED are terminal — the chain stops driving once a PR
    has been deployed (or its deploy has failed and waits for human
    intervention).
    """
    eng = _engine(db_path)
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    # Terminal: PR_OPEN through READY_FOR_MERGE (the auto-merge worker drives
    # these by polling, not the orchestrator tick), DEPLOYED, and the two
    # blocked states.
    terminal = {
        StoryState.PR_OPEN.value,
        StoryState.CI_PENDING.value,
        StoryState.CI_GREEN.value,
        StoryState.READY_FOR_MERGE.value,
        StoryState.DEPLOYED.value,
        StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
        StoryState.BLOCKED_DEPLOY_FAILED.value,
        # Dual-draft loser: terminal, so its worktree is prunable and it never
        # counts as in-flight.
        StoryState.SUPERSEDED_BY_SIBLING.value,
        # Operator-closed: terminal, worktree prunable, never in-flight.
        StoryState.CLOSED_BY_OPERATOR.value,
        # Delivery-level end states: the factory's part is done.
        *DELIVERED_UNMERGED_STATES,
    }
    # DEPLOY_PENDING is INTENTIONALLY in-flight so the orchestrator's
    # _DISPATCH picks it up for handle_deploy.
    return [r for r in rows if r.state not in terminal]


# --------------------------------------------------------------------------- #
# stories_spawned (from PM result) — invoked by the orchestrator
# --------------------------------------------------------------------------- #


# A4 whole-DIRECTION budget for the single-story collapse (operator decision
# 2026-08-09). Deliberately NOT pm_sync's per-slice ceilings: those exist to
# keep each slice inside ONE dev pass's comfort zone, and applying a per-slice
# cap (modified_files <= 2) to a SUM refuses any 3-slice split where each
# slice touches one file — i.e. the exact direction-120 shape the collapse
# was built for. These are sized to what one dev sandbox run can do: the
# sandbox allows 600 iterations per story (runner.sandbox_run), so 400 leaves
# retry headroom; the file counts allow ~1.5-3x the per-slice caps because a
# split duplicates per-slice overhead (tests, plumbing) that a single story
# pays once. A direction over THESE budgets keeps its split and is flagged
# for the operator to cut into sibling directions.
A4_MAX_NEW_FILES_PER_DIRECTION = 8
A4_MAX_MODIFIED_FILES_PER_DIRECTION = 6
A4_MAX_ITERATIONS_PER_DIRECTION = 400


def _collapse_child_stories(
    direction: Any, child_stories: list[dict[str, Any]], sums: dict[str, int]
) -> dict[str, Any]:
    """Merge PM's slices into ONE story covering the whole direction.

    Used by the A4 single-story rule and by every solo job.
    """
    merged_rationale = "\n\n".join(
        str(c.get("rationale") or "").strip()
        for c in child_stories
        if str(c.get("rationale") or "").strip()
    )
    # Scope: the modal implementation scope. ``docs``/``test`` never win — an
    # AC-carrying direction is by definition graded on app behaviour, and three
    # personas consume scope (module-doc pointer, task_scope, the commit title),
    # so inheriting whatever slice the PM happened to list first is a coin flip
    # on a load-bearing value.
    impl_scopes = [
        str(c.get("scope") or "").strip()
        for c in child_stories
        if str(c.get("scope") or "").strip() not in ("", "docs", "test")
    ]
    # Deterministic tie-break: by count, then alphabetically — ``max(set(...),
    # key=count)`` varies with PYTHONHASHSEED on ties.
    scope = (
        sorted(set(impl_scopes), key=lambda s: (-impl_scopes.count(s), s))[0]
        if impl_scopes
        else "backend"
    )
    # Points: the SUM (the one story does all the slices' work), snapped up to
    # the next Fibonacci value so EBS baselines keyed on (persona, points)
    # aren't poisoned by a 2-point label on 3 slices of work.
    raw_points = 0
    for c in child_stories:
        try:
            raw_points += int(c.get("points"))
        except (TypeError, ValueError):
            pass
    points = next((f for f in (1, 2, 3, 5, 8, 13) if f >= raw_points), 13)
    return {
        # The direction's own title, not the first slice's.
        "title": direction.title or child_stories[0].get("title") or "story",
        "scope": scope,
        # ``docs`` only when EVERY slice is docs (a pure-docs solo job stays a
        # docs story). Otherwise ``tdd``, never inherited by position: an
        # AC-carrying direction on the docs chain (no dev, gates skipped)
        # wedges unmergeably.
        "chain_kind": (
            "docs"
            if child_stories
            and all(str(c.get("chain_kind") or "tdd") == "docs" for c in child_stories)
            else "tdd"
        ),
        "points": points,
        "rationale": merged_rationale
        or "Single story covering every acceptance criterion of the direction.",
        **dict(sums),
    }


_SLUG_RE = re.compile(r"[^A-Za-z0-9]+")


def _route_for(story: Any, persona: str, difficulty: str = "standard") -> str:
    """Model for ``persona`` on ``story``: its spawn-stamped job/app override if
    any (``factory/job_routing.py``), else routes.yaml via ``route``."""
    from factory.job_routing import override_for_story

    chosen = override_for_story(story, persona, difficulty)
    if chosen:
        return chosen
    # Keep the exact pre-override call shapes (tests monkeypatch ``route``).
    if difficulty == "standard":
        return route(persona)
    return route(persona, difficulty=difficulty)


def _slug_of(text: str) -> str:
    s = _SLUG_RE.sub("-", text.strip().lower()).strip("-")
    return (s[:60] or "story").strip("-") or "story"


def _author_acceptance_oracle(
    story: StoryRecord,
    direction: Direction,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool,
    db_path: Path,
) -> None:
    """WS1.2: author the independent acceptance oracle for a freshly-spawned
    story (best-effort, never raises — must not fail story spawn).

    Authored here (spawn time, before dev runs) from the SPEC ONLY and stored
    outside the dev worktree — see ``factory.chain.acceptance``. author_...
    sets ``story.acceptance_expected`` (the required/blocking flag) even when
    authoring itself fails, so a flaked author BLOCKS rather than silently
    ships; the tick self-heal re-authors it later.
    """
    try:
        from factory.chain.acceptance import author_acceptance_test

        author_acceptance_test(
            story,
            direction,
            app_config,
            software_factory_root,
            dry_run=dry_run,
            db_path=db_path,
        )
    except Exception as exc:  # noqa: BLE001 - oracle authoring must never fail spawn
        _logger.warning(
            "acceptance oracle authoring raised for story %s (%s): %r — "
            "acceptance_expected governs blocking; tick self-heal will retry",
            getattr(story, "id", None),
            story.slug,
            exc,
        )


def handle_stories_spawned(
    direction: Direction,
    pm_result: dict[str, Any],
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    github_client: Any = None,
) -> list[StoryRecord]:
    """For each ``child_story`` in ``pm_result``, create a StoryRecord, optionally
    open the GH issue, and write the story file shell to the app repo (if any).

    In dry-run mode:
      * No GH issue is created; ``github_issue_number`` is ``None``.
      * No file is written to the app repo; ``story_file_path`` is a
        plausible placeholder under ``stories/0-<slug>.md``.

    Phase 7 — dual-draft branch:
      * If ``should_spawn_dual_draft(direction, pm_result)`` returns True
        (``(explore)`` tag OR PM confidence < 0.6), the chain produces
        TWO interpretations and spawns two StoryRecords (one per
        interpretation) instead of consuming ``pm_result.child_stories``
        verbatim. Each story carries the ``alt-a`` / ``alt-b`` suffix in
        its slug + branch so downstream draft PRs are distinguishable.
    """
    from factory.chain.dual_draft import (
        link_alternatives,
        produce_interpretations,
        should_spawn_dual_draft,
    )

    db = db_path or (software_factory_root / "state" / "factory.db")
    out: list[StoryRecord] = []

    # Per-job routing (operator decision 2026-11-02): resolve the direction's
    # ``models``/``pipeline`` frontmatter against the app config ONCE, here, and
    # stamp it on every story. Raises ``JobRoutingError`` (an unknown persona,
    # a reviewer/dev model collision, an unavailable solo pipeline) BEFORE any
    # issue or story is created — refused loudly, never silently repaired.
    from factory.job_routing import resolve_for_direction

    routing = resolve_for_direction(direction, app_config)
    if routing.model_overrides or routing.pipeline != "chain":
        for warning in routing.warnings:
            _logger.warning("direction %s: %s", direction.id_slug, warning)
        if not dry_run:
            try:
                from factory.manager.signals import write_event

                write_event(
                    "chain_steps",
                    {
                        "event": "job_routing_stamped",
                        "app": direction.app,
                        "direction_id": direction.id or direction.slug,
                        "pipeline": routing.pipeline,
                        "pipeline_requested": routing.pipeline_requested,
                        "model_overrides": routing.model_overrides,
                        "model_sources": routing.model_sources,
                        "warnings": list(routing.warnings),
                    },
                    software_factory_root=software_factory_root,
                )
            except Exception:  # noqa: BLE001 - telemetry only, never fail spawn
                pass

    # A SOLO job is one agent doing the whole job in one conversation and
    # delivering ONE change (operator decision 2026-11-02): it never fans out
    # into competing drafts or stacked slices. Observed live 2026-11-02: job
    # template-probe:005 (solo) was split by PM into 4 stacked stories / 4
    # draft PRs, each re-containing its parent's diff.
    solo_job = routing.pipeline == "solo"

    # Phase 7: dual-draft branch — spawn two interpretation stories,
    # regardless of how many child_stories the PM emitted.
    if not solo_job and should_spawn_dual_draft(direction, pm_result):
        interpretations = produce_interpretations(
            direction,
            pm_result,
            dry_run=dry_run,
            model_overrides=routing.model_overrides,
        )
        # Pick scope from the first child_story if present; otherwise
        # default to ``backend`` (most common case for ambiguous asks).
        first_child = (pm_result.get("child_stories") or [{}])[0]
        scope = str(first_child.get("scope") or "backend")
        # ``chain_kind`` is inherited from the first child story since
        # dual-draft produces two interpretations of the same underlying
        # work item; the variant doesn't change per-interpretation.
        chain_kind = str(first_child.get("chain_kind") or "tdd")

        for interp in interpretations:
            slug_base = _slug_of(interp.title or direction.title or "story")
            # ALWAYS preserve the dual-draft interpretation suffix (``-alt-a`` /
            # ``-alt-b``). The entire loser-cleanup mechanism identifies siblings
            # via a trailing ``-alt-*`` (``dual_draft._DRAFT_ALT_SLUG_RE``). The
            # old ``f"{base}-{id}"[:60]`` truncated the SUFFIX off for long
            # titles — both siblings collapsed to the same 60-char slug with NO
            # ``-alt-*``, so ``_draft_alt_suffix`` returned None, sibling
            # detection failed silently, and BOTH interpretations merged (the
            # dir 010 over-fire, 2026-07-21). Reserve room for the suffix by
            # truncating the BASE, so ``-alt-a``/``-alt-b`` always survives.
            _alt = f"-{interp.interpretation_id}"
            slug = (slug_base[: max(1, 60 - len(_alt))].strip("-") + _alt) or "story"
            title = f"{interp.title}"[:200]
            issue_number: int | None = None
            story_file_path = f"stories/0-{slug}.md"
            if not dry_run and github_client is not None:
                repo = github_client.get_repo(app_config.repo)
                body = (
                    f"{interp.body}\n\n"
                    f"_Direction: `{direction.id}-{direction.slug}` "
                    f"(tracker: #{direction.state.get('tracker_issue', '?')})._\n"
                    f"\n_Interpretation: `{interp.interpretation_id}` — "
                    f"{interp.key_assumption_diff}_\n"
                )
                issue = repo.create_issue(
                    title=title,
                    body=body,
                    labels=["story", f"scope/{scope}", "draft-alternative"],
                )
                issue_number = int(issue.number)
                story_file_path = f"stories/{issue_number}-{slug}.md"

            # Dual-draft path: use the first child's points as a hint
            # (interpretations share the same underlying work item).
            dd_points_raw = first_child.get("points")
            try:
                dd_points = int(dd_points_raw) if dd_points_raw is not None else 3
            except (TypeError, ValueError):
                dd_points = 3
            from factory.observability.estimator import (
                estimate_story_seconds as _est_secs_dd,
            )

            dd_estimated_seconds = _est_secs_dd(
                db_path=db, points=dd_points, chain_kind=chain_kind, pipeline=routing.pipeline
            )
            story = StoryRecord(
                direction_id=direction.id or direction.slug,
                app=direction.app,
                title=title,
                slug=slug,
                scope=scope,
                state=StoryState.STORY_CREATED.value,
                chain_kind=chain_kind,
                pipeline=routing.pipeline,
                model_overrides_json=routing.overrides_json(),
                github_issue_number=issue_number,
                github_branch=f"story/{issue_number or 0}-{slug}",
                story_file_path=story_file_path,
                points=dd_points,
                estimated_seconds=dd_estimated_seconds,
            )
            # Resolve + record the delivery level ONCE, here, so it cannot drift
            # mid-flight (see factory.chain.delivery_gate).
            from factory.chain.delivery_gate import log_spawn_level, record_spawn_level

            _dl_level, _dl_info = record_spawn_level(
                story, app_config, direction, software_factory_root
            )
            # Dry-run is a pure preview: build the would-be StoryRecord for
            # the returned list but never persist it or author its oracle —
            # a persisted dry-run story is a live dispatchable artifact (the
            # 2026-07-20 self-tick incident: a "safe" preview spawned rebuild
            # stories that the tick then executed).
            if not dry_run:
                persist_story(story, db)
                log_spawn_level(story, _dl_info, software_factory_root)
                _author_acceptance_oracle(
                    story,
                    direction,
                    app_config,
                    software_factory_root,
                    dry_run=dry_run,
                    db_path=db,
                )
            out.append(story)

        # Post the comparison comment on the tracker (real-run only).
        if not dry_run and github_client is not None and len(out) >= 2:
            try:
                link_alternatives(
                    out[0],
                    out[1],
                    interpretations,
                    direction,
                    github_client,
                    app_repo=app_config.repo,
                )
            except Exception:
                # Never fail the spawn on a comparison-comment hiccup.
                pass
        return out

    # EBS: compute baselines lazily so the very first story spawn after a
    # cold start still gets a usable ``estimated_seconds`` (None when no
    # samples yet — the Monte Carlo simulator gates on N>=5 to keep cold
    # starts from emitting bogus ETAs).
    from factory.observability.estimator import estimate_story_seconds

    child_stories = pm_result.get("child_stories") or []

    # A4 (operator decision 2026-08-09, per-app flag
    # ``gates.single_story_per_ac_direction``): an AC-carrying direction
    # spawns exactly ONE story. The acceptance oracle grades EVERY story
    # against the DIRECTION's criteria (``_author_acceptance_oracle`` →
    # ``list(direction.acceptance)``) — deliberately: scoping the oracle to
    # what PM/SM says a story covers would let the chain grade its own
    # descoping, a false-green channel. Under that rule a multi-story split is
    # structurally broken, not merely wasteful: the first sibling to merge
    # satisfies the direction, and every LATER sibling grades green-at-base →
    # ``oracle_not_discriminating`` → operator waiver. Observed live
    # 2026-08-09: direction 120 spawned 3 slices; story 179 implemented every
    # criterion in 22.7 min and siblings 180/181 had to be superseded by hand.
    #
    # The collapse REFUSES to fire when the children's summed size estimates
    # exceed the per-story ceilings PM's re-prompt loop enforces per slice
    # (``pm_sync.MAX_*_PER_STORY``) — silently merging N validated slices
    # into one over-budget story would trade a visible waiver for an
    # invisible budget burn (a timed-out dev run records $0). An oversized
    # AC-carrying direction keeps its split and emits
    # ``direction_not_single_story_sized``: it needs splitting into sibling
    # DIRECTIONS by the operator, which no spawn-time choice can do safely.
    # Directions WITHOUT acceptance criteria keep multi-story splits; the
    # dual-draft branch above already spawns exactly two competing alternates
    # (each stamped with the full-coverage mandate) and is untouched.
    from factory.chain.acceptance import acceptance_expected_for

    if (
        not solo_job
        and len(child_stories) > 1
        and app_config.gates.single_story_per_ac_direction
        and acceptance_expected_for(app_config, direction)
    ):
        estimate_keys = (
            "estimated_new_files",
            "estimated_modified_files",
            "estimated_sandbox_iterations",
        )

        def _summed(key: str) -> int | None:
            """Sum ``key`` over all children; ``None`` when ANY child omits it.

            Polarity matters: in pm_sync a missing estimate is a soft warning
            that KEEPS the split (safe); here summing missing-as-zero would
            COLLAPSE the one direction whose size is unknown (adversarial
            replay over the 48 held-out directions: the only collapse
            candidate was the pm.md anti-example D007, precisely because its
            children carry no estimates). Unknown size ⇒ refuse.
            """
            total = 0
            for c in child_stories:
                try:
                    total += max(0, int(c.get(key)))
                except (TypeError, ValueError):
                    return None
            return total

        maybe_sums = {k: _summed(k) for k in estimate_keys}
        sums: dict[str, int] = {k: v for k, v in maybe_sums.items() if v is not None}
        estimates_complete = len(sums) == len(estimate_keys)
        fits = (
            estimates_complete
            and sums["estimated_new_files"] <= A4_MAX_NEW_FILES_PER_DIRECTION
            and sums["estimated_modified_files"] <= A4_MAX_MODIFIED_FILES_PER_DIRECTION
            and sums["estimated_sandbox_iterations"] <= A4_MAX_ITERATIONS_PER_DIRECTION
        )

        if not dry_run:  # dry-run is a pure preview — write no telemetry
            try:
                from factory.manager.signals import write_event

                write_event(
                    "chain_steps",
                    {
                        "event": (
                            "story_split_collapsed" if fits else "direction_not_single_story_sized"
                        ),
                        "app": direction.app,
                        "direction_id": direction.id or direction.slug,
                        "pm_child_count": len(child_stories),
                        "summed_estimates": sums,
                        "dropped_titles": (
                            [str(c.get("title") or "") for c in child_stories[1:]] if fits else []
                        ),
                        "estimates_complete": estimates_complete,
                        "reason": (
                            "acceptance oracle grades direction criteria; "
                            "one story per AC-carrying direction"
                            if fits
                            else (
                                "summed slice estimates exceed the whole-"
                                "direction budget — this direction cannot be "
                                "one story and, under direction-scoped "
                                "acceptance grading, cannot safely be many; "
                                "split it into sibling directions"
                                if estimates_complete
                                else "one or more slices carry no size "
                                "estimates — size unknown, refusing to "
                                "collapse into a single unbounded story"
                            )
                        ),
                    },
                    software_factory_root=software_factory_root,
                )
            except Exception:  # noqa: BLE001 - telemetry only, never fail spawn
                pass

        if fits:
            child_stories = [_collapse_child_stories(direction, child_stories, sums)]

    if solo_job and len(child_stories) > 1:
        # Solo: always ONE story, whatever PM's slicing and whatever its size
        # estimates. A4's size ceilings exist for the chain's 1800 s dev
        # horizon; the solo conversation is bounded by its own wall clock,
        # no-progress abort and spend cap instead. Estimates a child omits are
        # left out of the sums (they are telemetry here, not a gate).
        solo_sums: dict[str, int] = {}
        for key in (
            "estimated_new_files",
            "estimated_modified_files",
            "estimated_sandbox_iterations",
        ):
            vals = []
            for c in child_stories:
                try:
                    vals.append(max(0, int(c.get(key))))
                except (TypeError, ValueError):
                    pass
            if vals:
                solo_sums[key] = sum(vals)
        if not dry_run:
            try:
                from factory.manager.signals import write_event

                write_event(
                    "chain_steps",
                    {
                        "event": "solo_story_collapsed",
                        "app": direction.app,
                        "direction_id": direction.id or direction.slug,
                        "pm_child_count": len(child_stories),
                        "summed_estimates": solo_sums,
                        "dropped_titles": [str(c.get("title") or "") for c in child_stories[1:]],
                    },
                    software_factory_root=software_factory_root,
                )
            except Exception:  # noqa: BLE001 - telemetry only, never fail spawn
                pass
        child_stories = [_collapse_child_stories(direction, child_stories, solo_sums)]

    for child in child_stories:
        slug = _slug_of(child.get("title") or "story")
        title = str(child.get("title") or "Untitled story")[:200]
        scope = str(child.get("scope") or "backend")
        # ``chain_kind`` decides which chain variant drives this story.
        # PM emits ``"docs"`` for documentation-only deliverables (the new
        # docs chain) and ``"tdd"`` (default) for everything else.
        chain_kind = str(child.get("chain_kind") or "tdd")
        # EBS: Fibonacci difficulty points from PM; default to 3 (median).
        points_raw = child.get("points")
        try:
            points = int(points_raw) if points_raw is not None else 3
        except (TypeError, ValueError):
            points = 3
        estimated_seconds = estimate_story_seconds(
            db_path=db, points=points, chain_kind=chain_kind, pipeline=routing.pipeline
        )
        issue_number = None
        story_file_path = f"stories/0-{slug}.md"

        if not dry_run and github_client is not None:
            # Real-run: open GH issue, then story_file_path uses the issue number.
            repo = github_client.get_repo(app_config.repo)
            body = (
                f"{child.get('rationale') or ''}\n\n"
                f"_Direction: `{direction.id}-{direction.slug}` "
                f"(tracker: #{direction.state.get('tracker_issue', '?')})._\n"
            )
            issue = repo.create_issue(
                title=title,
                body=body,
                labels=["story", f"scope/{scope}"],
            )
            issue_number = int(issue.number)
            story_file_path = f"stories/{issue_number}-{slug}.md"

        story = StoryRecord(
            direction_id=direction.id or direction.slug,
            app=direction.app,
            title=title,
            slug=slug,
            scope=scope,
            state=StoryState.STORY_CREATED.value,
            chain_kind=chain_kind,
            pipeline=routing.pipeline,
            model_overrides_json=routing.overrides_json(),
            github_issue_number=issue_number,
            github_branch=f"story/{issue_number or 0}-{slug}",
            story_file_path=story_file_path,
            points=points,
            estimated_seconds=estimated_seconds,
        )
        # Resolve + record the delivery level ONCE, here, so it cannot drift
        # mid-flight (see factory.chain.delivery_gate).
        from factory.chain.delivery_gate import log_spawn_level, record_spawn_level

        _dl_level, _dl_info = record_spawn_level(
            story, app_config, direction, software_factory_root
        )
        # Dry-run is a pure preview: never persist the story or author its
        # oracle (see the dual-draft branch above and the 2026-07-20 incident).
        if not dry_run:
            persist_story(story, db)
            log_spawn_level(story, _dl_info, software_factory_root)
            _author_acceptance_oracle(
                story,
                direction,
                app_config,
                software_factory_root,
                dry_run=dry_run,
                db_path=db,
            )
        out.append(story)
    return out


# --------------------------------------------------------------------------- #
# sm (Scrum Master)
# --------------------------------------------------------------------------- #


# Matches a story filename like "0-my-slug.md" or "42-some-thing.md" — the
# leading numeric prefix is the issue number (0 = "no issue yet" placeholder).
_STORY_FILENAME_RE = re.compile(r"^(\d+)-(.+\.md)$")


def _substitute_issue_number_in_path(
    target_path_rel: str,
    *,
    issue_number: int | None,
    slug: str,
) -> str:
    """Substitute the leading ``\\d+-`` prefix in the story filename with the
    real ``issue_number`` when known.

    Robust to any directory prefix on ``target_path_rel`` (the path's
    ``parent`` is preserved verbatim). If ``issue_number`` is None, the path
    is returned unchanged. If the filename doesn't carry a numeric prefix at
    all, we fall back to ``stories/<issue_number>-<slug>.md`` so the chain
    still finds the file by convention.
    """
    if issue_number is None:
        return target_path_rel
    path = Path(target_path_rel)
    m = _STORY_FILENAME_RE.match(path.name)
    if m is not None:
        # Only substitute when the existing prefix is the "no issue yet"
        # placeholder (``0``). A real issue number that disagrees with the
        # story's ``github_issue_number`` is left alone — this is more likely
        # a chain bug (split story?) than the SM's intent.
        if m.group(1) == "0":
            new_name = f"{issue_number}-{m.group(2)}"
            return str(path.with_name(new_name))
        return target_path_rel
    # No numeric prefix; conventionalize.
    return f"stories/{issue_number}-{slug}.md"


def _dry_run_sm(
    story: StoryRecord, direction: Direction | None, software_factory_root: Path
) -> dict[str, Any]:
    """Deterministic Scrum-Master result for dry-run mode.

    Produces a BMAD-format story file embedding:
      * the direction's flow.md verbatim if present
      * the direction's api_spec.md verbatim if present
      * acceptance criteria verbatim
      * pointers to context/current-state.md and context/modules/<scope>.md.
    """
    flow_text = ""
    api_text = ""
    acceptance_lines: list[str] = []
    if direction is not None:
        if direction.has_flow:
            try:
                flow_text = (direction.dir_path / "flow.md").read_text(encoding="utf-8").rstrip()
            except FileNotFoundError:
                flow_text = ""
        if direction.has_api_spec:
            try:
                api_text = (direction.dir_path / "api_spec.md").read_text(encoding="utf-8").rstrip()
            except FileNotFoundError:
                api_text = ""
        acceptance_lines = list(direction.acceptance)

    ac_block = (
        "\n".join(f"{i + 1}. {ac}" for i, ac in enumerate(acceptance_lines))
        if acceptance_lines
        else "1. (no explicit acceptance criteria — see Dev Notes)"
    )

    dev_notes_parts = [
        "- Story carries verbatim embeds of user-supplied artifacts below.",
        f"- Read context/current-state.md and context/modules/{story.scope}.md before "
        "implementing.",
        "[Source: context/current-state.md]",
        f"[Source: context/modules/{story.scope}.md]",
    ]
    if flow_text:
        dev_notes_parts.append("\n#### Flow (verbatim from direction)\n\n" + flow_text)
    if api_text:
        dev_notes_parts.append("\n#### API spec (verbatim from direction)\n\n" + api_text)
    dev_notes_parts.append("\n#### Acceptance criteria (verbatim from direction)\n\n" + ac_block)
    dev_notes = "\n".join(dev_notes_parts)

    file_content = (
        f"# Story 1.1: {story.title}\n\n"
        "Status: ready-for-dev\n\n"
        "## Story\n\n"
        f"As a user, I want {story.title.lower()}, so that the documented outcome holds.\n\n"
        "## Acceptance Criteria\n\n"
        f"{ac_block}\n\n"
        "## Tasks / Subtasks\n\n"
        "- [ ] Task 1 (AC: #1)\n"
        "  - [ ] Subtask 1.1\n\n"
        "## Dev Notes\n\n"
        f"{dev_notes}\n\n"
        "### References\n\n"
        f"- [Source: context/modules/{story.scope}.md]\n"
        "- [Source: context/current-state.md]\n\n"
        "## Dev Agent Record\n\n"
        "### Agent Model Used\n\n"
        "(populated by dev)\n\n"
        "### File List\n\n"
        "## Senior Developer Review\n\n"
        "## Review Follow-ups\n"
    )

    return {
        "stories": [
            {
                "title": story.title,
                "slug": story.slug,
                "scope": story.scope,
                "file_content": file_content,
                "target_path": story.story_file_path
                or f"stories/{story.github_issue_number or 0}-{story.slug}.md",
            }
        ],
        "summary": f"Dry-run SM story for {story.slug!r}.",
    }


_SM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["stories", "summary"],
    "properties": {
        "stories": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["title", "slug", "scope", "file_content", "target_path"],
                "properties": {
                    "title": {"type": "string"},
                    "slug": {"type": "string"},
                    "scope": {"type": "string"},
                    "file_content": {"type": "string"},
                    "target_path": {"type": "string"},
                },
            },
        },
        "summary": {"type": "string"},
    },
}


#: Marker opening the code-appended block below. Also the idempotence guard —
#: a re-run of SM over an already-stamped file must not stack the block twice.
_FULL_COVERAGE_MARKER = "<!-- factory:dual-draft-full-coverage -->"


def _with_full_coverage_mandate(
    file_content: str, story: StoryRecord, direction: Any, *, ac_single_story: bool = False
) -> str:
    """Stamp a story file with every direction AC when the oracle grades them all.

    Fires for a dual-draft alternate (always — PR #268), and, when
    ``ac_single_story`` is True, for the only story of an AC-carrying
    direction (A4, 2026-08-09): in both shapes the acceptance oracle grades
    the story against the whole direction and no sibling exists to pick up a
    deferred criterion.

    The prompt above tells SM that ``alt-a``/``alt-b`` are COMPETING attempts at
    the whole direction. This is the same statement enforced in CODE, because a
    prompt is a request and this invariant is load-bearing:

    * ``explore: true`` directions spawn two alternates; measured over the
      sacrifice ledger, 23 such pairs resolved 23 ``deployed`` /
      20 ``superseded_by_sibling``. One ships, one is closed. There is no third
      story.
    * The acceptance oracle grades every story against the DIRECTION's criteria
      (``_author_acceptance_oracle`` → ``list(direction.acceptance)``), never
      the story's.

    So an alternate that defers a criterion is graded on work nobody was asked
    to do. Observed live 2026-08-08 on sacrifice story 173 (direction 117): SM
    wrote "token lifecycle ... is out of scope for this narrow-read story; it
    belongs to sibling stories that implement token model and consumption" — no
    such sibling exists, dev faithfully built only the guard, and the story was
    unmergeable before dev's first line of code.

    Appending rather than validating-and-rejecting is deliberate: a reject loop
    costs another SM call and can fail three times and terminally block, which
    trades a late block for an earlier one. This makes the requirement present
    in the artifact dev actually reads, with no extra LLM spend and no new
    failure mode. Non-alternate stories of a MULTI-story split are returned
    untouched — a genuine split (only possible when no oracle grades it, or
    the A4 collapse refused an oversized direction) SHOULD scope each story
    narrowly.
    """
    # Lazy, like every other ``dual_draft`` use in this module — keeps the
    # import graph minimal for tests that import handlers without the chain.
    from factory.chain.dual_draft import _draft_alt_suffix

    is_alternate = _draft_alt_suffix(story.slug or "") is not None
    if not is_alternate and not ac_single_story:
        return file_content
    acceptance = list(getattr(direction, "acceptance", None) or [])
    if not acceptance:
        return file_content
    if _FULL_COVERAGE_MARKER in file_content:
        return file_content
    criteria = "\n".join(f"- [ ] {ac}" for ac in acceptance)
    if is_alternate:
        heading = "## Required coverage — this is a COMPETING alternate"
        framing = (
            "This story is one of two rival attempts at the whole direction "
            "(`narrow read` / `broad read`). Exactly one ships; the other is closed "
            "as `superseded_by_sibling`. **There is no sibling story that will "
            "implement anything deferred here**, and the acceptance oracle grades "
            "this story against every criterion below."
        )
    else:
        heading = "## Required coverage — the acceptance oracle grades the whole direction"
        framing = (
            "This story is the direction's ONLY story. An independent acceptance "
            "oracle grades it at merge time against every criterion below — never "
            "against a subset the story text declares in scope. **No sibling story "
            "exists or will be created**, so anything deferred here is built by "
            "nobody and the story is then graded against it and blocked."
        )
    return (
        f"{file_content.rstrip()}\n\n"
        f"{_FULL_COVERAGE_MARKER}\n"
        f"{heading}\n\n"
        f"{framing}\n\n"
        "Implement ALL of them:\n\n"
        f"{criteria}\n\n"
        "Anything above that the body of this story describes as out of scope, "
        "deferred, or belonging to another story is an ERROR in the story text — "
        "the criteria here win.\n"
    )


def handle_sm(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    fixture: dict[str, Any] | None = None,
) -> HandlerResult:
    """Run the Scrum-Master persona; write the BMAD story file to disk.

    In dry-run mode: deterministic fixture story is composed from the
    direction's flow.md / api_spec.md / acceptance criteria (if any). The
    story file is written to ``apps/<app>/stories/<issue|0>-<slug>.md``.
    In real-run mode: invokes ``text_run("sm", ...)`` with the SM persona
    prompt + context prelude + PM result + Direction. The chain writes the
    file content from the SM result.
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    story.state = advance(story, EVENT_SM_STARTED).value
    persist_story(story, db)

    direction = find_direction_for_story(story, software_factory_root)

    if fixture is not None:
        result = fixture
    elif dry_run:
        result = _dry_run_sm(story, direction, software_factory_root)
    else:
        from factory.app_config import resolve_app_repo_path
        from factory.context.loader import compose_context_prelude
        from factory.directions.parser import get_direction_chain
        from factory.runner import text_run

        persona = "sm"
        persona_prompt = _read_persona_prompt(persona)
        chain = (
            get_direction_chain(direction, software_factory_root) if direction is not None else None
        )
        prelude = compose_context_prelude(
            persona=persona,
            app_repo_path=resolve_app_repo_path(app_config, software_factory_root),
            task_scope=story.scope,
            direction_chain=chain,
            software_factory_root=software_factory_root,
        )
        flow_text = ""
        api_text = ""
        direction_body = ""
        pm_block = ""
        if direction is not None:
            direction_body = direction.raw_body
            if direction.has_flow:
                try:
                    flow_text = (direction.dir_path / "flow.md").read_text(encoding="utf-8")
                except FileNotFoundError:
                    flow_text = ""
            if direction.has_api_spec:
                try:
                    api_text = (direction.dir_path / "api_spec.md").read_text(encoding="utf-8")
                except FileNotFoundError:
                    api_text = ""
            pm_result = direction.state.get("pm_result") or {}
            try:
                pm_block = json.dumps(pm_result, indent=2)
            except TypeError:
                pm_block = "(pm_result not JSON-serializable)"

        full_prompt = (
            f"{persona_prompt.rstrip()}\n\n"
            "---\n\n"
            "## Context\n\n"
            f"{prelude.rstrip()}\n\n"
            "## PM result\n\n"
            f"```json\n{pm_block}\n```\n\n"
            "## Direction\n\n"
            f"{direction_body.rstrip()}\n\n"
            f"### flow.md\n\n{flow_text.rstrip() if flow_text else '(none)'}\n\n"
            f"### api_spec.md\n\n{api_text.rstrip() if api_text else '(none)'}\n\n"
            "## YOUR ASSIGNMENT — exactly ONE story file\n\n"
            "This invocation prepares the story file for exactly ONE StoryRecord\n"
            "(the chain runs you once per record). The PM result's child_stories\n"
            "above are decomposition CONTEXT — scope boundaries and sequencing —\n"
            "NOT a list of files to emit. If this record is the direction's ONLY\n"
            "story, any sibling or sequencing references in that context are\n"
            "VOID: no sibling exists or will exist, so nothing may be deferred\n"
            "to one. Your `stories` array MUST contain\n"
            "EXACTLY ONE entry, with `slug` set EXACTLY to the value below\n"
            "(verbatim — the chain matches on it and refuses to write on\n"
            "mismatch). If this record is one interpretation of a dual-draft\n"
            "pair (title suffixed 'narrow read'/'broad read'), scope the story\n"
            "content to THAT interpretation.\n\n"
            "### Dual-draft alternates are COMPETING, not COMPLEMENTARY\n\n"
            "'narrow read' and 'broad read' are two rival attempts at the WHOLE\n"
            "direction. Exactly one of them ships; the other is closed as\n"
            "`superseded_by_sibling`. They are NOT a decomposition, and the\n"
            "other alternate is NOT a follow-up that will finish your work.\n\n"
            "Therefore EVERY alternate MUST cover EVERY acceptance criterion\n"
            "in the direction. The narrow/broad axis is how much you do BEYOND\n"
            "the criteria (narrow: nothing beyond; broad: adjacent rough edges\n"
            "too) — it is NEVER which criteria you cover.\n\n"
            "Do NOT defer, descope, or mark a criterion out-of-scope, and do NOT\n"
            "say a 'sibling story' will implement it. For a dual-draft pair no\n"
            "such sibling is ever created, so anything you defer is built by\n"
            "NOBODY and the story is then graded against it and blocked.\n"
            "If a criterion is genuinely untestable as written, still IMPLEMENT\n"
            "it and say why it is hard to observe — do not drop it.\n\n"
            f"- title: {story.title}\n"
            f"- slug: {story.slug}\n"
            f"- scope: {story.scope}\n"
            f"- target_path: {story.story_file_path}\n\n"
            "Return the JSON object. No prose outside the JSON."
        )
        model_id = _route_for(story, persona)
        result_any = text_run(
            persona=persona,
            prompt=full_prompt,
            model_id=model_id,
            schema=_SM_SCHEMA,
            max_tokens=max_output_tokens_for(model_id),
            story_id=story.id,
            app=story.app,
            direction_id=story.direction_id,
            db_path=db,
        )
        if not isinstance(result_any, dict):
            return HandlerResult(
                next_state=StoryState(story.state),
                error="sm returned non-dict",
            )
        result = result_any

    # Find the story entry that matches this StoryRecord. The DB slug is
    # TRUNCATED (column cap) while the SM emits full slugs, so exact equality
    # misses (e.g. "...llm-match-cont" vs "...llm-match-contract") — match by
    # prefix in either direction. And NEVER fall back to "the first story":
    # that silent default wrote the FIRST sibling's contract into 9 stories'
    # files (D009/D010, found 2026-06-11) — dev faithfully re-built story
    # 22's scope under story 23's title, the reviewer approved it against the
    # same wrong file, and the duplicate PR conflicted with the real merged
    # implementation. Writing the wrong contract is strictly worse than
    # failing loudly.
    stories_out = result.get("stories") or []
    matched: dict[str, Any] | None = None
    for s in stories_out:
        s_slug = str(s.get("slug") or "")
        if s_slug == story.slug or (
            s_slug and (s_slug.startswith(story.slug) or story.slug.startswith(s_slug))
        ):
            matched = s
            break

    if matched is None:
        # Slug mismatch: do NOT advance. Advancing to SM_DONE without a
        # written file poisons dispatch forever (dev dies on
        # FileNotFoundError every tick — observed 2026-07-17 when dual-draft
        # records met an SM that emitted per-child_story files). Reset to
        # STORY_CREATED so the next tick re-runs SM against the (now
        # single-story-explicit) prompt; the mismatch is loud in the story
        # event log either way.
        story.error = (
            f"sm output has no story matching slug {story.slug!r} "
            f"(got: {[str(s.get('slug'))[:40] for s in stories_out[:6]]!r}); "
            "refusing to write a sibling's contract into this story's file"
        )
        story.state = StoryState.STORY_CREATED.value
        story.sm_result_json = json.dumps(result)
        log_story_event(
            story.id,
            "sm_slug_mismatch",
            {
                "expected_slug": story.slug,
                "got_slugs": [str(s.get("slug"))[:60] for s in stories_out[:12]],
            },
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )
        persist_story(story, db)
        return HandlerResult(
            next_state=StoryState(story.state),
            payload=result,
            error=story.error,
        )

    # Resolve the on-disk target path. Prefer the SM's emitted target_path; if
    # the filename leads with a numeric prefix (the SM's "<issue-number>"
    # placeholder; ``0-`` in dry-run, but could be any digits a stale fixture
    # carries) and we now know the real issue number, substitute it. Robust
    # to any directory prefix (``stories/...``, ``apps/<x>/stories/...``).
    target_path_rel = str(matched.get("target_path") or story.story_file_path)
    target_path_rel = _substitute_issue_number_in_path(
        target_path_rel,
        issue_number=story.github_issue_number,
        slug=story.slug,
    )

    # A4: the mandate also fires for the ONLY story of an AC-carrying
    # direction (gated on the same per-app flag as the spawn-time collapse).
    # Fail direction on any lookup error is NO stamp — SM may then descope and
    # the story blocks at the gate: a recoverable false-block, never a
    # false-green.
    ac_single_story = False
    try:
        if (
            app_config is not None
            and app_config.gates.single_story_per_ac_direction
            and direction is not None
        ):
            from factory.chain.acceptance import acceptance_expected_for

            if acceptance_expected_for(app_config, direction):
                from sqlmodel import Session, create_engine, select

                eng = create_engine(f"sqlite:///{db}", echo=False)
                with Session(eng) as session:
                    sibs = session.exec(
                        select(StoryRecord).where(
                            StoryRecord.direction_id == story.direction_id,
                            StoryRecord.app == story.app,
                        )
                    ).all()
                # "Only story" means only LIVE story: terminal rows
                # (superseded losers, closed_by_operator, prior blocked
                # attempts) do no further work, so their existence must not
                # stop the stamp — else any direction with history never
                # earns it again. The story must also actually be in the
                # query result (an empty result proves nothing).
                others_live = [
                    s for s in sibs if s.id != story.id and not is_terminal(StoryState(s.state))
                ]
                ac_single_story = any(s.id == story.id for s in sibs) and not others_live
    except Exception:  # noqa: BLE001 - no stamp is the recoverable direction
        ac_single_story = False

    target_abs = software_factory_root / "apps" / story.app / target_path_rel
    target_abs.parent.mkdir(parents=True, exist_ok=True)
    target_abs.write_text(
        _with_full_coverage_mandate(
            matched.get("file_content") or "", story, direction, ac_single_story=ac_single_story
        ),
        encoding="utf-8",
    )
    story.story_file_path = target_path_rel
    story.sm_result_json = json.dumps(result)
    story.state = advance(story, EVENT_SM_DONE).value
    persist_story(story, db)
    return HandlerResult(next_state=StoryState(story.state), payload=result)


# --------------------------------------------------------------------------- #
# test_design
# --------------------------------------------------------------------------- #


_TEST_DESIGN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["test_plan", "e2e_required", "summary"],
    "properties": {
        "test_plan": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "name",
                    "what_it_asserts",
                    "tool",
                    "file_path",
                    "key_steps",
                    "why_meaningful",
                ],
            },
        },
        "e2e_required": {"type": "boolean"},
        "summary": {"type": "string"},
    },
}


def _read_persona_prompt(persona: str) -> str:
    """Defer to the runner's reader to avoid duplicating the personas dir constant."""
    from factory.runner import _read_persona_prompt as _rpp

    return _rpp(persona)


def _finding_location_file(f: dict[str, Any]) -> str:
    """Normalize a finding's location to its file path (drop :line, lowercase).

    Line numbers shift as dev edits; the FILE is the stable identity of where
    a defect lives. Findings without a location normalize to "" (excluded
    from location-set comparisons).
    """
    loc = str(f.get("location") or f.get("file") or "").strip().lower()
    return loc.split(":", 1)[0].strip()


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort parse of a JSON object from an LLM text response.

    The reviewer is dispatched with ``schema=None`` (its output is large and we
    don't want the runner's json_object mode / doubling ladder here), so the
    raw model text can arrive fenced in ```json ... ``` or with a stray
    sentence before/after the object. A bare ``json.loads`` silently fails on
    those and the caller would degrade to an empty ``request_changes`` — losing
    every finding and churning the loop. This recovers the object in three
    escalating steps: (1) parse as-is; (2) strip a Markdown code fence;
    (3) slice from the first ``{`` to the last ``}``. Returns ``None`` only
    when no JSON object can be recovered — the caller MUST treat that as
    ``request_changes`` (never a silent approve).
    """
    if not isinstance(text, str):
        return text if isinstance(text, dict) else None

    def _as_obj(s: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(s)
        except (json.JSONDecodeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None

    candidate = text.strip()
    obj = _as_obj(candidate)
    if obj is not None:
        return obj

    # Strip a fenced block: ```json\n{...}\n``` (or plain ```), keeping body.
    if candidate.startswith("```"):
        body = candidate[3:]
        if body[:4].lower() == "json":
            body = body[4:]
        body = body.strip()
        if body.endswith("```"):
            body = body[:-3].strip()
        obj = _as_obj(body)
        if obj is not None:
            return obj

    # Last resort: slice the outermost brace span.
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start != -1 and end != -1 and end > start:
        obj = _as_obj(candidate[start : end + 1])
        if obj is not None:
            return obj
    return None


def _parse_tech_writer_result(result_any: Any) -> dict[str, Any] | None:
    """Parse + shape-check tech_writer output. Returns ``None`` on anything
    that is not a usable result — the caller retries, then blocks fail-closed.

    Deliberately STRICTER than the reviewer's ``_extract_json_object``: no
    brace-slice. The tech_writer prompt embeds a complete example object, so
    slicing the outermost ``{...}`` out of a prose response can capture the
    prompt's own echoed example — one such shape (``context_updates: []`` with
    ``no_updates_needed: false``) parks the story behind a docs-current gate
    that can never pass, and another (``no_updates_needed: true``) is a FALSE
    GREEN on a merged PR with stale context docs. Fence-stripping alone covers
    the observed failure (story 177 attempt 1: a fully valid object inside a
    ```json fence, rejected by the old bare ``json.loads``); everything
    stranger stays a loud parse failure.

    The shape check exists so a syntactically valid but wrong-shaped body
    (e.g. ``context_updates`` as a list of strings) fails HERE — a retryable
    parse failure — rather than as an uncaught ``TypeError`` in the
    ``ContextUpdate`` build after the result was already persisted.
    """
    candidate: dict[str, Any] | None = None
    if isinstance(result_any, dict):
        candidate = result_any
    elif isinstance(result_any, str):
        text = result_any.strip()
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            parsed = None
            if text.startswith("```"):
                body = text[3:]
                if body[:4].lower() == "json":
                    body = body[4:]
                body = body.strip()
                if body.endswith("```"):
                    body = body[:-3].strip()
                try:
                    parsed = json.loads(body)
                except (json.JSONDecodeError, ValueError):
                    parsed = None
        candidate = parsed if isinstance(parsed, dict) else None
    if candidate is None:
        return None

    updates = candidate.get("context_updates")
    no_updates = bool(candidate.get("no_updates_needed"))
    if updates is None:
        return candidate if no_updates else None
    if not isinstance(updates, list):
        return None
    for u in updates:
        if not isinstance(u, dict) or not isinstance(u.get("path"), str) or not u["path"]:
            return None
    if not updates and not no_updates:
        # "Docs are stale but here are zero updates" — the docs-current gate
        # can never satisfy this; persisting it strands the story terminally.
        return None
    return candidate


def _parse_reviewer_result(result_any: Any) -> dict[str, Any]:
    """Normalize the reviewer's raw output into a review result dict.

    The reviewer runs schema-free, so the raw text may be fenced or
    prose-wrapped; ``_extract_json_object`` recovers the object (fence-strip /
    brace-slice) before we give up. A genuine parse failure degrades to
    ``request_changes`` WITH a synthetic rubric finding — never a silent
    approve, and never an empty ``request_changes`` the dev can't act on. The
    synthetic finding carries a rubric ``criterion`` so it flows through the
    same signature / history / dev-findings plumbing as a real one.
    """
    result = result_any if isinstance(result_any, dict) else _extract_json_object(result_any)
    if isinstance(result, dict) and "verdict" in result:
        return result
    return {
        "verdict": "request_changes",
        "test_quality_score": 0.0,
        "findings": [
            {
                "severity": "high",
                "criterion": "contract",
                "location": "(reviewer output):0",
                "what": (
                    "Reviewer response was not valid rubric JSON; re-review "
                    "required (safe fallback — not an approval)."
                ),
                "fix_suggestion": (
                    "No actionable code change parsed; the reviewer will "
                    "re-run. If this recurs, the reviewer model is not "
                    "emitting the JSON contract."
                ),
            }
        ],
        "test_quality_findings": [],
        "summary": "reviewer JSON parse failed",
    }


# Fixed rubric axes the reviewer grades against. ``scope``/``style`` are
# non-blocking by construction (the persona clamps them to ``low``); the rest
# may be blocking. Kept here so the parse-fallback and the signature agree on
# the vocabulary. An unknown/absent criterion normalizes to "" — it still
# participates in the signature (via location + text) but carries no rubric
# axis, which is the correct backward-compatible behavior for pre-rubric output.
_RUBRIC_CRITERIA = frozenset({"correctness", "contract", "security", "tests", "scope", "style"})


def _finding_criterion(f: dict[str, Any]) -> str:
    """Normalized rubric criterion for a finding ("" when absent/unknown)."""
    crit = str(f.get("criterion") or "").strip().lower()
    return crit if crit in _RUBRIC_CRITERIA else ""


def _findings_signature(result: dict[str, Any]) -> str:
    """Stable hash of a review's actionable findings (order-independent).

    Keys on a NORMALIZED structured signature per finding: location FILE +
    rubric ``criterion`` + ``what``/``issue`` text. Two cycles flagging the
    same site on the same rubric axis count as "same" even when the reviewer
    rewords the complaint (rewording defeated the text-only signature —
    benchmark t3, 2026-07-17, six cycles with consecutive_same=1 throughout).
    The criterion is part of the key so a genuinely different rubric objection
    at the same file (e.g. a NEW ``security`` finding where cycle-1 raised
    ``style``) reads as PROGRESS, not a stuck repeat. Line number is
    deliberately excluded — it shifts as the dev edits, and file-grain identity
    is what the 2026-07-17 fix established. Pre-rubric findings (no criterion)
    normalize to "" and hash exactly as before, so the guard is unchanged for
    legacy output.
    """
    import hashlib

    parts = []
    for f in (result.get("findings") or []) + (result.get("test_quality_findings") or []):
        if isinstance(f, dict):
            loc = _finding_location_file(f)
            crit = _finding_criterion(f)
            what = (f.get("what") or f.get("issue") or "").strip().lower()[:160]
            key = "|".join(p for p in (loc, crit, what) if p)
            parts.append(key)
    digest = hashlib.sha256(" ".join(sorted(parts)).encode("utf-8", "replace"))
    return digest.hexdigest()[:16]


_REVIEWER_HISTORY_MAX_CYCLES = 4


def _append_reviewer_history(story: StoryRecord, result: dict[str, Any]) -> None:
    """Append this cycle's review to ``story.reviewer_history_json`` (capped).

    Stores a digest, not the full result: enough for the reviewer to honor
    finality (location + what + severity + regression flag) and for dev's
    do-not-regress section, without unbounded prompt growth.
    """

    def _digest(findings: Any, *, is_test: bool = False) -> list[dict[str, Any]]:
        out = []
        for f in findings or []:
            if not isinstance(f, dict):
                continue
            out.append(
                {
                    "severity": f.get("severity", "medium" if not is_test else "low"),
                    "criterion": _finding_criterion(f) or ("tests" if is_test else ""),
                    "location": str(f.get("location") or f.get("test_name") or "")[:160],
                    "what": str(f.get("what") or f.get("issue") or "")[:200],
                    "regression": bool(f.get("regression")),
                }
            )
        return out

    entry = {
        "cycle": story.reviewer_cycles,
        "verdict": result.get("verdict", "request_changes"),
        "score": result.get("test_quality_score"),
        "findings": _digest(result.get("findings")),
        "test_quality_findings": _digest(result.get("test_quality_findings"), is_test=True),
    }
    try:
        history = json.loads(story.reviewer_history_json or "[]")
        if not isinstance(history, list):
            history = []
    except (json.JSONDecodeError, TypeError):
        history = []
    history.append(entry)
    story.reviewer_history_json = json.dumps(history[-_REVIEWER_HISTORY_MAX_CYCLES:])


def _render_reviewer_history_section(story: StoryRecord) -> str:
    """The "Your previous findings" prompt section for re-reviews.

    Empty string on the first review. This is what makes the persona's
    finality rule ENFORCEABLE — without it the reviewer has no memory of its
    own prior verdicts and re-derives fresh objections every cycle.
    """
    try:
        history = json.loads(story.reviewer_history_json or "[]")
    except (json.JSONDecodeError, TypeError):
        history = []
    if not history:
        return ""
    lines = [
        "## Your previous findings (this is a RE-REVIEW — read before judging)",
        "",
        "You have reviewed this story before. Per the Review-finality rule, a",
        "new `medium`/`high` finding is legitimate ONLY as (a) a regression",
        'since your last review (mark `"regression": true`) or (b) one of',
        "the findings below not actually addressed. Anything else is `low` /",
        "`comments_to_post`. At cycle 3+ the chain clamps non-compliant",
        "blocking findings to non-blocking.",
        "",
    ]
    for entry in history:
        lines.append(f"### Cycle {entry.get('cycle')} — verdict: {entry.get('verdict')}")
        for f in (entry.get("findings") or []) + (entry.get("test_quality_findings") or []):
            # Legacy history (written before _digest's isinstance guard) can
            # contain a bare-string finding; skip it rather than crash the
            # whole tick with "'str' object has no attribute 'get'". Mirrors
            # the guards in _findings_signature and _append_reviewer_history.
            if not isinstance(f, dict):
                continue
            reg = " (regression)" if f.get("regression") else ""
            crit = f.get("criterion")
            crit_tag = f"/{crit}" if crit else ""
            lines.append(
                f"- [{f.get('severity')}{crit_tag}] {f.get('location')}: {f.get('what')}{reg}"
            )
        lines.append("")
    return "\n".join(lines)


# Pre-model sandbox infrastructure-error cap. A dev sandbox that fails BEFORE
# any model work (``success=False`` with zero tokens/cost and tests never run)
# is shared-infra breakage — a transient ``.venv`` relink from a concurrent
# ``uv run``/``uv sync`` re-materialising site-packages mid-render
# (``TemplateNotFound``), an SDK import failure, or a sandbox boot crash. This
# is NOT a dev-code or test failure, so it must NOT consume the dev retry
# budget; the story is bounced straight back to dev (most transients clear by
# the next tick). Counted from *consecutive trailing* ``dev_sandbox_infra_error``
# events so a recovered story is never punished for an earlier blip; at the cap
# a persistent infra fault escalates loudly via ``factory_needs_redesign``
# instead of looping forever. Capped at 3 per the "nothing loops >3" rule.
_MAX_DEV_SANDBOX_INFRA_RETRIES = 3

# Dev retry budget. A red dev run (tests not green) consumes one retry; at the
# cap the story blocks with an explicit ``factory_needs_redesign`` event so the
# operator sees the signal.
#
# 3 (operator decision 2026-08-01), lowered from 6. The 6 was itself
# operator-approved on 2026-05-29 on the theory that informed extra attempts
# (dev receives prior-attempt history + reviewer findings) improve convergence
# on harder stories, but it contradicted the standing "nothing loops more than
# ~3 times" guardrail in CLAUDE.md, and only ``_MAX_CI_FIX_CYCLES`` honoured
# that. Four stories in the 14 days to 2026-08-01 reached 6 retries; those are
# now cut off at 3 and block for a human instead of burning three more
# attempts. Whether attempts 4-6 were producing PASSING work is unmeasured —
# PLAN.md Phase 1.3's gate-precision number is what would settle it.
#
# It is now partly settled, and not in favour of more retries: the 2026-08-04
# hidden-oracle grading put the chain's own green verdict at 40% precision, and
# ImpossibleBench (arXiv 2510.20270) measured cheating rising 33% -> 38% when an
# agent gets multiple submissions with feedback. Under Loop-4 the dev owns its
# own tests, so an extra attempt is also an extra chance to make the check
# agree with the code. Do not raise this cap as an "improvement" — see the
# ``_MAX_REVIEW_CYCLES`` note below for the same argument in full.
#
# RAISED TO 4 AND MADE CONFIGURABLE, 2026-08-09, by operator decision. Two
# things changed since the argument above was written (2026-08-01):
#
# 1. THE ARGUMENT'S PREMISE WEAKENED. "An extra attempt is an extra chance to
#    make the check agree with the code" was true when the dev's own tests were
#    the only check. The acceptance oracle went live 2026-08-08: it is authored
#    from the spec before the dev starts, frozen, stored outside the dev
#    worktree, and run out of process. The dev cannot see or edit it. So an
#    extra dev attempt is no longer an extra chance to game the grader — the
#    grader is now independent of the dev. ImpossibleBench's own finding points
#    the same way: its most effective mitigation was denying the DEV access to
#    the tests, which is exactly what the oracle now does.
# 2. THE COST OF THE CAP BECAME VISIBLE. Measured 2026-08-09 over 196 dev runs:
#    dev is 658 s average and 97% of all genuine work time in the factory. The
#    cap does not make anything faster — it converts a story that needed a
#    fourth attempt into a BLOCKED story that needs an operator, which measured
#    as hours of stall (story 172: 92.6% dead time).
#
# The "nothing loops more than 3" guardrail in CLAUDE.md still binds every OTHER
# loop. This one is now an operator-tunable threshold with a hard invariant
# enforced below, because the evidence that set it at 3 was specifically about
# a grader the dev could reach, and that is no longer the arrangement.
_DEFAULT_MAX_DEV_RETRIES = 4


def _max_dev_retries(software_factory_root: Path | None = None) -> int:
    """The dev-retry cap, from ``direction_defaults.max_dev_retries``.

    Until 2026-08-09 this key existed in ``factory_settings.yaml`` and in
    ``DirectionDefaults`` and **nothing read it** — the authoritative value was a
    hardcoded constant here. An operator could set it to 6, restart, and observe
    no change. That is the same defect class as the acceptance harness hint: a
    configuration fact whose consumer cannot verify it, so it drifts silently.

    INVARIANT (the CLAUDE.md guardrail this cap must not break): the
    early-escalation guard ``_MAX_DEV_SAME_SIGNATURE`` must stay STRICTLY BELOW
    the hard cap, or it becomes unreachable and two deliberately layered guards
    silently collapse into one. A configured value at or below it is refused and
    the floor is used instead — fail SAFE toward keeping both guards live.
    """
    try:
        from factory.settings.loader import load_settings

        root = software_factory_root or Path(__file__).resolve().parent.parent.parent
        configured = int(getattr(load_settings(root).direction_defaults, "max_dev_retries", 0) or 0)
    except Exception:  # noqa: BLE001 - an unreadable settings file must not unbound the cap
        return _DEFAULT_MAX_DEV_RETRIES
    if configured <= _MAX_DEV_SAME_SIGNATURE:
        # Would make the early-escalation guard unreachable. Refuse it.
        return _MAX_DEV_SAME_SIGNATURE + 1
    return configured


# Module-level FALLBACK only — deliberately NOT the authoritative value.
# ``orchestrator._prune_stale_in_progress`` imports this name; it now calls
# ``_max_dev_retries()`` instead, so the value the orchestrator compares against
# and the value the handler enforces come from one place and cannot disagree.
# Resolving it at import time was rejected: it would do settings I/O during
# module import and risk an import cycle.
_MAX_DEV_RETRIES = _DEFAULT_MAX_DEV_RETRIES


def _dev_retry_cap(story: StoryRecord, software_factory_root: Path | None = None) -> int:
    """The dev-retry cap for THIS story: the configured cap, or the solo cap.

    Solo stories are capped at ``solo.SOLO_MAX_DEV_ATTEMPTS`` (3) because each
    solo attempt is already a multi-round 5400 s conversation. Kept strictly
    above ``_MAX_DEV_SAME_SIGNATURE`` so the early stall guard stays reachable.
    """
    from factory.chain.solo import max_dev_attempts

    return max_dev_attempts(story, _max_dev_retries(software_factory_root))


def _settle_exhausted_ci_fix_of_watched_pr(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    db: Path,
    same_sig_count: int,
) -> StoryState | None:
    """Dev ran out of attempts on a CI-FIX of a ``draft_pr`` / ``pr`` PR.

    The PR exists and is the deliverable; the failed fix must not be pushed
    onto it (the dev-exhausted WIP push would do exactly that), and a failed
    FIX must not turn a delivered PR into a ``blocked_tests_need_clarification``
    story (review of PR #335, SHOULD 3). The broken attempt is left as local,
    UNCOMMITTED work in the worktree (nothing is pushed) and the story is
    settled to ``DELIVERED_PR`` with a note. Returns the new state, or None
    when this does not apply (no PR / not watched / no CI-fix in progress /
    the settle could not take the lock) — the caller's exhausted path runs.
    """
    from factory.chain import auto_merge as _am
    from factory.chain.delivery_gate import story_is_ci_watched
    from factory.chain.event_log import read_story_events

    if not story_is_ci_watched(story) or not story.github_pr_number:
        return None
    if story.github_pr_number <= 0 or story.id is None:
        return None
    try:
        events = read_story_events(
            story.id, software_factory_root=software_factory_root, slug_hint=story.slug
        )
        prior, _since, _start = _am._ci_watch_scope(events)
    except Exception:  # noqa: BLE001
        return None
    if not prior:
        return None
    stall = f"same failure {same_sig_count}x; " if same_sig_count else ""
    note = (
        f"CI fix {len(prior)} for PR #{story.github_pr_number} did not converge "
        f"(dev exhausted: {stall}{story.dev_retries} attempt(s)); the failed fix was NOT "
        "pushed — the PR still holds the last pushed commit, whose CI was red. "
        "Delivered for a human"
    )
    if not _am.deliver_watched_pr_with_note(
        story=story,
        app_config=app_config,
        root=software_factory_root,
        db=db,
        note=note,
        reason="CI-fix cycle exhausted the dev",
    ):
        return None
    return StoryState.DELIVERED_PR


def _block_solo_oracle_leak(
    story: StoryRecord,
    leaks: list[str],
    *,
    db: Path,
    software_factory_root: Path,
) -> HandlerResult:
    """Refuse a solo dev dispatch whose worktree holds a copy of the oracle.

    B.1's coupling: a long solo horizon is more turns in which to go looking
    for the hidden acceptance oracle, so the leak check is a BLOCKING
    precondition. Consumes no dev retry (the dev never ran); routes to the
    human-visible ``BLOCKED_TESTS_NEED_CLARIFICATION`` sink with the reason.
    """
    story.state = advance(story, EVENT_DEV_EXHAUSTED).value
    story.error = (
        "solo pipeline: acceptance-oracle copy found in the dev worktree "
        f"(blocking precondition): {', '.join(leaks[:5])}"
    )[:500]
    persist_story(story, db)
    log_story_event(
        story.id,
        "solo_oracle_leak_blocked",
        {"leaks": leaks[:20], "dev_retries_preserved": story.dev_retries},
        software_factory_root=software_factory_root,
        slug_hint=story.slug,
    )
    return HandlerResult(
        next_state=StoryState(story.state),
        payload={"test_run_passed": False, "solo_oracle_leak": leaks[:20]},
        error=story.error,
    )


# Same-failure-signature fast-escalation cap. When consecutive dev runs fail
# with the IDENTICAL normalized failure signature (the same assertions/errors,
# volatile bits stripped) the model is stuck on something more attempts won't
# fix — every retry re-discovers the same dead end while burning spend. Rather
# than march to ``_MAX_DEV_RETRIES`` (+ the aggregate budget breaker) on no new
# signal, block after this many identical failures. 3 per the "nothing loops
# unproductively >3" operator rule. A CHANGING signature means the model IS
# making progress and keeps its full retry budget.
# 2, lowered from 3 when _MAX_DEV_RETRIES dropped 6 -> 3 (2026-08-01). This
# guard exists to escalate EARLY — before the full retry budget is spent — so
# it must stay strictly below _MAX_DEV_RETRIES. At 3 == 3 it would have had no
# headroom left and the early-escalation layer would have become unreachable,
# silently collapsing two deliberately layered guards into one.
_MAX_DEV_SAME_SIGNATURE = 2

# The stall guard above keys on "the same failure text twice". That is only
# evidence of a dead end when the failure text is a TEST RESULT. When the suite
# never ran, two identical tails mean "we learned nothing, twice" — and blocking
# the story is then throwing away work on no evidence at all.
#
# Measured over all 61 dev attempts in bench sweep 2, 8 red attempts carried no
# test results, and they are exactly the losses:
#
#   * ``jsonpickle-588`` attempts 1 AND 2 — ``2 errors in 0.21s``, a COLLECTION
#     error from a 2-line syntax error. Same signature twice, story blocked
#     terminally, two unused retries. The tree was one edit from green and
#     ``solo-noreview`` solved it.
#   * ``rapid-mlx-289`` (x2) and ``vyper-4801`` shared ONE signature —
#     ``sandbox run timed out ... treating as retryable infrastructure failure``.
#     Two consecutive INFRA TIMEOUTS were being counted as the model failing the
#     same way twice.
#   * ``keras-22642`` and ``jsonpickle-588``/solo — an OpenHands crash dump.
#
# So an attempt only contributes to the streak when its tail shows at least one
# test actually passing or failing. Everything else is non-comparable and gets
# the empty signature, which ``_consecutive_same_dev_signature`` already treats
# as "no comparable evidence yet" and returns 0 for.
#
# The cap is NOT raised: CLAUDE.md requires the early-escalation guard to stay
# strictly below the hard cap, and at 2 against 4 it does. What changes is which
# attempts are comparable. And the loop stays bounded for this class — the hard
# ``_max_dev_retries`` cap and the per-story budget breaker are untouched, so the
# worst case is a collection error consuming the normal retry budget instead of
# terminating the story after two.
#
# Ambiguity resolves toward NOT firing, on purpose: not firing costs retries the
# story already owns, while firing wrongly discarded a correct patch.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_TEST_OUTCOME_RE = re.compile(r"\b(\d+)\s+(passed|failed|xfailed|xpassed)\b")
_TEST_NODE_RESULT_RE = re.compile(r"^(FAILED|PASSED|XFAIL|XPASS)\s+\S+", re.M)
_TEST_ASSERTION_RE = re.compile(r"\bAssertionError\b")


def _tail_shows_test_results(tail: str) -> bool:
    """Did this test run produce a per-test outcome at all?

    True on positive evidence that at least one TEST ran and reported:

    * a pytest summary counting a passed/failed/xfailed/xpassed test;
    * a ``FAILED``/``PASSED`` per-node line (``-r`` output);
    * an ``AssertionError`` — a test-level assertion, as opposed to a
      collection-time crash.

    False for a collection error, an import error, an all-skipped run, a sandbox
    crash dump and an infra timeout. A signature over any of those describes our
    environment, not the dev's fix.

    All three forms are needed, and the third is the one an existing test caught:
    a real pytest tail always ends with a count line (it is the last thing pytest
    prints, so it survives truncation), but a bare ``AssertionError: expected 1
    got 2`` tail IS a test that ran and failed. Requiring the count line alone
    made the guard unreachable for that shape.

    ANSI is stripped first: pytest colourises the summary, and a naive
    word-boundary match against ``111\x1b[0m passed`` misses it — four sweep-2
    attempts have exactly that shape.

    Re-measured over all 61 sweep-2 dev attempts with all three forms: 9 red
    attempts have comparable evidence and keep feeding the stall guard; the 8
    that do not are precisely the collection errors, crash dumps and infra
    timeouts named in the block comment above. The guard stays live; it stops
    counting non-evidence.
    """
    text = _ANSI_RE.sub("", tail or "")
    if not text.strip():
        return False
    if any(int(m.group(1)) > 0 for m in _TEST_OUTCOME_RE.finditer(text)):
        return True
    if _TEST_NODE_RESULT_RE.search(text):
        return True
    return bool(_TEST_ASSERTION_RE.search(text))


# ImpossibleBench escape hatch (arXiv 2510.20270, ICLR 2026). The marker the
# dev persona emits to declare a story unsatisfiable AS WRITTEN instead of
# guessing or making its own tests agree with whatever it built. Measured
# effect of offering the option at all: test-exploitation 54% -> 9% (GPT-5),
# 49% -> 12% (o3).
#
# Line-anchored and upper-case so a discussion OF the mechanism ("I considered
# declaring it underspecified but...") cannot trip it — the same
# contract-literal collision that produced a structural non-convergence on
# story 14 (see the persona_prompt_contract_collision memory). The persona
# prompt must therefore never illustrate the marker at the start of a line.
_UNDERSPECIFIED_MARKER = "UNDERSPECIFIED:"
_UNDERSPECIFIED_REASON_CAP = 600


def parse_underspecified_declaration(text: str) -> str | None:
    """Return the dev's declared reason, or ``None`` if it did not declare.

    Accepts the marker only at the START of a line (leading whitespace is
    tolerated for indented final messages) and requires a non-empty reason: a
    bare ``UNDERSPECIFIED:`` with nothing after it is not a declaration, it is
    an unfinished sentence, and a blocked story with no reason is exactly the
    useless escalation this repo has been burned by before.
    """
    if not text:
        return None
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(_UNDERSPECIFIED_MARKER):
            continue
        reason = line[len(_UNDERSPECIFIED_MARKER) :].strip()
        if reason:
            return reason[:_UNDERSPECIFIED_REASON_CAP]
    return None


def declared_underspecified(run_res: Any) -> str | None:
    """The declared reason from a dev sandbox result, or ``None``.

    Reads only the two places the DEV'S OWN WORDS land: its parsed
    ``SELF_SUMMARY:`` block and its final assistant message.
    ``_extract_self_summary`` already prefers the ``finish`` tool's message over
    a plain trailing message, so a dev that declares via ``finish`` is covered.

    ``run_res.summary`` is deliberately NOT read: it is the pytest output tail
    (``factory/runner.py`` sets it from ``test_out``), which contains captured
    stdout of arbitrary application code. That is a machine-generated, untrusted
    channel, and this transition is terminal and not auto-recoverable — no such
    channel gets to fire it.
    """
    for field_name in ("self_summary", "last_assistant_message"):
        reason = parse_underspecified_declaration(str(getattr(run_res, field_name, "") or ""))
        if reason is not None:
            return reason
    return None


def _block_underspecified(
    story: StoryRecord,
    reason: str,
    *,
    db: Path,
    software_factory_root: Path,
    tests_green: bool,
    files_changed: list[str],
) -> HandlerResult:
    """Park ``story`` in the terminal BLOCKED_UNDERSPECIFIED sink.

    ``story.dev_retries`` is deliberately NOT incremented: a declaration is not
    a failed attempt, and charging a retry for it would price honesty the same
    as failure — the opposite of what ImpossibleBench measured.

    The declaration wins even when the run ended GREEN. A green run on a story
    the dev itself calls unsatisfiable is the exact shape of the false-green
    this closes (under Loop-4 the dev owns the tests that went green), so it
    goes to a human rather than to the reviewer. ``tests_green`` is recorded so
    the operator can see which case they are looking at.
    """
    story.state = advance(story, EVENT_DEV_UNDERSPECIFIED).value
    story.error = f"dev declared the story underspecified: {reason}"
    persist_story(story, db)
    log_story_event(
        story.id,
        "dev_declared_underspecified",
        {
            "reason": reason,
            "tests_green_at_declaration": tests_green,
            "files_changed": files_changed[:20],
            # Proof the escape hatch is free: the operator can check that this
            # is the same count the story carried before the declaration.
            "dev_retries": story.dev_retries,
        },
        software_factory_root=software_factory_root,
        slug_hint=story.slug,
    )
    return HandlerResult(
        next_state=StoryState(story.state),
        payload={
            "test_run_passed": tests_green,
            "underspecified": reason,
            "files_changed": files_changed,
            "summary": (
                "Dev declared the story underspecified rather than guessing: "
                f"{reason}. Terminal, awaiting a human; no dev retry consumed."
            ),
        },
        error=story.error,
    )


def _consecutive_same_dev_signature(prior_attempts: list[Any], current_sig: str) -> int:
    """Count trailing dev attempts sharing ``current_sig`` (newest-first).

    Walks ``prior_attempts`` (the ``dev_attempts_json`` list) from the end and
    counts the unbroken run of red attempts whose ``failure_signature`` equals
    ``current_sig``. A green attempt (``test_run_passed is True``) or a
    different/absent signature breaks the run — a green in between or a changed
    failure both mean genuine progress, so the stall counter resets. Returns 0
    for an empty signature (no comparable evidence yet).
    """
    if not current_sig:
        return 0
    count = 0
    for a in reversed(prior_attempts):
        if not isinstance(a, dict):
            break
        if a.get("test_run_passed") is True:
            break
        if a.get("failure_signature") == current_sig:
            count += 1
        else:
            break
    return count


# Review convergence guard. Judged by finding STABILITY, not raw cycle count: a
# cycle that surfaces DIFFERENT findings is making progress. We block only when
# the reviewer returns the SAME findings _MAX_REVIEW_STUCK times in a row
# (genuine churn — "nothing loops unproductively >3"), with a hard absolute
# backstop (_MAX_REVIEW_CYCLES) so a slowly-mutating loop can't run forever.
#
# Both lowered 2026-08-01 (operator decision) to honour the CLAUDE.md "nothing
# loops more than ~3 times" guardrail, which previously only
# ``_MAX_CI_FIX_CYCLES`` respected. The RATIO is preserved deliberately:
# _MAX_REVIEW_STUCK must stay strictly below _MAX_REVIEW_CYCLES or the
# stability guard becomes unreachable and "findings that CHANGE are progress"
# — the whole reason this is judged by stability rather than raw count —
# silently stops being true. 3/3 would have blocked a story making genuine
# progress at the same point as one in pure churn.
#
# Review convergence is healthy at this cap: in the 14 days to 2026-08-01,
# 101 of 122 stories used zero cycles, 18 used one, and the maximum was 5.
#
# DO NOT RAISE THESE AS AN "IMPROVEMENT". They are a stronger safety property
# than "stop burning budget"; the external literature says more feedback rounds
# buy gaming, not assurance:
#   * ImpossibleBench (ICLR 2026, arXiv 2510.20270) measured cheating rising
#     33% -> 38% when agents get MULTIPLE submissions with feedback. More
#     cycles is the condition that produced more cheating.
#   * Self-refine/self-repair at MATCHED budget (arXiv 2306.09896) buys only
#     3-10% — i.e. the same tokens spent on more independent attempts do about
#     as well, so extra cycles are not where the win is.
# Under Loop-4 the dev owns the tests the reviewer's approve rule reads, so each
# extra cycle is another chance to make the check agree with the code rather
# than the code agree with the story. The 2026-08-04 hidden-oracle grading
# measured the result: the chain's own green verdict was 40% precise.
#
# Lowering them, or replacing a cycle with an independent check that the dev
# cannot author (a hidden oracle, a mutation score, execution output fed to the
# reviewer), are the changes with evidence behind them. Raising them is not.
_MAX_REVIEW_STUCK = 2
_MAX_REVIEW_CYCLES = 3


def _is_premodel_infra_failure(run_res: Any) -> bool:
    """True when a sandbox run failed before any model work began.

    A genuine "dev ran but tests are still red" outcome has
    ``test_run_passed is False`` and (almost always) non-zero token/cost
    usage. A pre-model infrastructure failure — the OpenHands SDK import
    blowing up, the agent prompt template failing to render, or the sandbox
    boot crashing — returns ``success=False`` with ``test_run_passed`` never
    set and zero tokens/cost. Distinguishing the two is what keeps an
    environment blip from masquerading as a code failure and burning the dev
    retry budget.

    The runner now sets an EXPLICIT ``premodel_infra`` flag (True only for
    genuine pre-model breakage; False when the model spent tokens and then
    raised). Prefer it when present: the old zero-cost/None heuristic
    misclassified a run that DID real model work but crashed afterwards (e.g.
    during metrics extraction) as "infra", so the dev handler bounced it back
    for free and NEVER incremented ``dev_retries`` — the story-88 loop where a
    story was re-dispatched 12 times with ``dev_retries`` stuck at 1. A run
    that actually evaluated tests (``test_run_passed is not None``) is a real
    dev attempt and is NEVER infra, regardless of the flag.
    """
    if run_res.test_run_passed is not None:
        # The post-model gate ran (tests passed OR failed, including collection
        # errors that exit pytest non-zero) — this is a genuine dev attempt,
        # never infra. Also covers the runner's "model did real work then
        # raised" path, which now reports test_run_passed=False.
        return False
    if getattr(run_res, "premodel_infra", False):
        # Runner explicitly flagged genuine pre-model breakage.
        return True
    # Backward-compat heuristic for RunResults built without the explicit flag
    # (e.g. legacy fixtures): no success, tests never ran, zero cost/tokens.
    return bool(
        not run_res.success
        and run_res.test_run_passed is None
        and (run_res.cost_usd or 0.0) == 0.0
        and (run_res.tokens_out or 0) == 0
    )


def _consecutive_trailing_infra_errors(story: StoryRecord, software_factory_root: Path) -> int:
    """Count ``dev_sandbox_infra_error`` events with no real dev progress after.

    Walks the per-story event log newest-first and counts the unbroken run of
    trailing infra-error events. Any genuine dev event (retry, exhaustion,
    green, clarification, or a fresh dev_started) resets the count — so a
    story that hit one transient blip, recovered, and only much later hits
    more is never blocked on a stale cumulative tally.
    """
    from factory.chain.event_log import read_story_events

    count = 0
    for e in reversed(
        read_story_events(
            story.id, software_factory_root=software_factory_root, slug_hint=story.slug
        )
    ):
        ev = e.get("event")
        if ev == "dev_sandbox_infra_error":
            count += 1
        elif ev in {
            "dev_retry",
            "dev_exhausted",
            "dev_tests_green",
            "tests_need_clarification",
        }:
            break
    return count


def _dry_run_dev(story: StoryRecord) -> tuple[bool, dict[str, Any]]:
    """Deterministic dev result for dry-run mode.

    Returns (tests_green, payload). Default happy path: tests green after
    the first dev run.
    """
    return True, {
        "files_changed": [f"src/{story.slug.replace('-', '_')}.py"],
        "test_run_passed": True,
        "summary": "Dry-run dev pass: tests green on first attempt.",
    }


def _commit_green_dev_work(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    repo: Path | None = None,
) -> None:
    """Deterministically ``git add -A && commit`` the dev's uncommitted worktree
    changes on a GREEN outcome, so the reviewer's ``origin/base...HEAD`` diff is
    never empty. The dev persona is only *asked* to self-commit; when it forgets
    (story 106, 2026-07-21) the branch has no committed diff and dev<->review
    churns on already-correct code. Idempotent (a clean tree — the agent already
    committed — is a no-op) and best-effort (a git hiccup must never fail the
    green advance; the work still lives in the reused worktree and PR-open
    re-commits). Mirrors the dev-exhausted path's WIP-preservation commit.
    """
    try:
        from factory.chain.branch import _run_git as _git

        # ``repo`` given (solo): commit EXACTLY the tree the gate just graded —
        # ``_writing_worktree`` would first merge origin/<base> into it.
        if repo is None:
            repo = _writing_worktree(app_config, software_factory_root, story)
        _git(repo, "add", "-A")
        if _git(repo, "status", "--porcelain").stdout.strip():
            _git(repo, "commit", "-m", f"dev: implement story {story.id} ({story.slug})")
    except Exception:  # noqa: BLE001 - commit is best-effort; never fail the green advance
        pass


def _try_resume_dev_from_checkpoint(
    story: StoryRecord,
    software_factory_root: Path,
    *,
    app_config: AppConfig,
    db_path: Path | None = None,
) -> HandlerResult | None:
    """WS4.2 resume-from-checkpoint: skip re-running the dev LLM when a prior
    sandbox already completed GREEN but the tick died before the DB advanced
    out of ``dev_in_progress``.

    Returns a ``HandlerResult`` (advanced to ``tests_green``) when a valid
    green checkpoint is present, otherwise ``None`` (the caller proceeds with a
    normal dev run). Correctness rests on two facts: (1) the dev sandbox writes
    its changes into the per-story worktree, which is REUSED across ticks — so
    the green code survives the interruption and re-running the LLM would only
    reproduce it; (2) the checkpoint is written green then cleared within a
    single ``handle_dev`` call, so a lingering one is unambiguous evidence of an
    interruption (never the review-feedback re-entry path, which reaches dev
    only after the checkpoint was already cleared). Idempotent: a second call
    finds no checkpoint and returns ``None``.
    """
    cp_raw = story.dev_step_checkpoint
    if not cp_raw:
        return None
    db = db_path or (software_factory_root / "state" / "factory.db")
    try:
        cp = json.loads(cp_raw)
    except (json.JSONDecodeError, TypeError):
        cp = None
    if not isinstance(cp, dict) or cp.get("outcome") != "green":
        # Malformed / non-green marker — clear it and fall through to a normal
        # dev run. Never skip the LLM on an ambiguous checkpoint.
        story.dev_step_checkpoint = None
        persist_story(story, db)
        return None

    from_state = story.state
    # Drive the pure state machine exactly as a real green run would:
    # dispatch-state -> DEV_IN_PROGRESS -> TESTS_GREEN. ``advance`` is pure and
    # validates the transition, so an unexpected dispatch state raises loudly
    # rather than silently skipping into an illegal state.
    story.state = advance(story, EVENT_DEV_STARTED).value
    # Same deterministic commit as the live green path: a crash could have
    # interrupted the original run BEFORE it committed, leaving the resumed
    # green work uncommitted → empty-diff churn. Idempotent + best-effort.
    _commit_green_dev_work(story, app_config, software_factory_root)
    story.state = advance(story, EVENT_DEV_TESTS_GREEN).value
    story.dev_step_checkpoint = None
    persist_story(story, db)
    log_story_event(
        story.id,
        "dev_resume_from_checkpoint",
        {
            "from_state": from_state,
            "to_state": story.state,
            "checkpoint_attempt": cp.get("attempt"),
            "checkpoint_ts": cp.get("ts"),
        },
        software_factory_root=software_factory_root,
        slug_hint=story.slug,
    )
    return HandlerResult(
        next_state=StoryState(story.state),
        payload={"resumed_from_checkpoint": True, "test_run_passed": True},
    )


def handle_dev(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    force_red: bool = False,
) -> HandlerResult:
    """Run the Dev persona; check tests; retry/escalate on failure.

    With ``dev_convergence.enabled`` (factory_settings.yaml), a red run
    retries IMMEDIATELY in this same invocation — fresh sandbox, prior-
    attempts memory carried forward by ``_handle_dev_once``'s normal red
    bookkeeping — instead of waiting for the next tick. The loop grants no
    extra attempts (``_MAX_DEV_RETRIES`` stays authoritative); it only
    removes the tick-cadence dead time between the same retries. Guards:
    inner-attempt cap, one retry of headroom under the chain cap, per-story
    wall-clock + budget, and a live re-check of the global hourly/daily
    spend caps. Infra failures and content-filter escalations always exit
    the loop into their existing across-ticks paths.

    ``force_red`` is for testing the retry path: when True, the dry-run
    branch returns tests_green=False so the handler exercises the retry +
    escalation logic.
    """
    import time as _time

    from factory.settings.loader import load_settings

    _settings = load_settings(software_factory_root)

    # WS4.2 resume-from-checkpoint. Before spending anything, check whether a
    # prior dev sandbox already completed GREEN and only the state advance was
    # lost to an interruption. If so, resume from the persisted result WITHOUT
    # re-running the expensive dev LLM (the green code already lives in the
    # reused per-story worktree). Real-run only and gated by a default-on flag.
    if not dry_run and getattr(_settings.dev_convergence, "resume_from_checkpoint", True):
        _resumed = _try_resume_dev_from_checkpoint(
            story, software_factory_root, app_config=app_config, db_path=db_path
        )
        if _resumed is not None:
            return _resumed

    result = _handle_dev_once(
        story,
        app_config,
        software_factory_root,
        dry_run=dry_run,
        db_path=db_path,
        force_red=force_red,
    )
    conv = _settings.dev_convergence
    if dry_run or not conv.enabled:
        return result
    from factory.chain.solo import is_solo as _is_solo

    if _is_solo(story):
        # SOLO: the continuity lives INSIDE the one long conversation (gate
        # feedback rounds in ``sandbox_run``). Re-dispatching a FRESH sandbox in
        # this same tick is exactly the N-fresh-conversations pattern solo
        # removes; a red solo attempt goes back through the normal across-ticks
        # retry path, capped by ``solo.SOLO_MAX_DEV_ATTEMPTS``.
        return result

    db = db_path or (software_factory_root / "state" / "factory.db")
    loop_started_mono = _time.monotonic()
    loop_started_ts = datetime.now(UTC).isoformat()
    inner_attempts = 1

    while True:
        stop_reason = _dev_inner_loop_stop_reason(
            story=story,
            result=result,
            conv=conv,
            inner_attempts=inner_attempts,
            elapsed_s=_time.monotonic() - loop_started_mono,
            since_ts=loop_started_ts,
            software_factory_root=software_factory_root,
            db_path=db,
        )
        if stop_reason == "continue":
            inner_attempts += 1
            log_story_event(
                story.id,
                "dev_inner_attempt",
                {"inner_attempt": inner_attempts, "dev_retries": story.dev_retries},
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            result = _handle_dev_once(
                story,
                app_config,
                software_factory_root,
                dry_run=dry_run,
                db_path=db_path,
                force_red=force_red,
            )
            continue
        if stop_reason != "terminal":
            # Stopped while the story is still retryable — record why so the
            # FMS can distinguish "loop budget ran out" from "story done".
            log_story_event(
                story.id,
                "dev_inner_loop_stopped",
                {
                    "reason": stop_reason,
                    "inner_attempts": inner_attempts,
                    "dev_retries": story.dev_retries,
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
        return result


def _dev_inner_loop_stop_reason(
    *,
    story: StoryRecord,
    result: HandlerResult,
    conv: Any,
    inner_attempts: int,
    elapsed_s: float,
    since_ts: str,
    software_factory_root: Path,
    db_path: Path,
) -> str:
    """Decide whether the dev convergence loop re-attempts now.

    Returns ``"continue"`` to re-dispatch immediately, ``"terminal"`` when
    the story left the retryable state (green, exhausted, blocked), or a
    stop-reason label when the story IS retryable but a loop guard says to
    fall back to the normal across-ticks path.
    """
    if StoryState(story.state) is not StoryState.DEV_RETRY:
        return "terminal"
    payload = result.payload or {}
    if payload.get("sandbox_infra_error"):
        return "infra_failure"
    if payload.get("content_filter_tier_escalation"):
        return "content_filter"
    if inner_attempts >= conv.max_inner_attempts:
        return "attempts_cap"
    # Leave the LAST chain retry to the normal tick path so exhaustion
    # bookkeeping (WIP commit/push, factory_needs_redesign) never runs
    # inside a tight loop iteration.
    if story.dev_retries + 1 >= _max_dev_retries(software_factory_root):
        return "retry_headroom"
    if elapsed_s >= conv.per_story_wall_clock_s:
        return "wall_clock"
    story_cost = _story_spend_since(db_path, story.id, since_ts)
    if story_cost >= conv.per_story_budget_usd:
        return "budget"
    # Live re-check of the global caps: the settings enforcer only gates
    # dispatch, so a tight loop must re-verify mid-flight.
    from factory.settings.loader import load_settings
    from factory.settings.spend import hour_spend_usd, today_spend_usd

    caps = load_settings(software_factory_root).caps
    if hour_spend_usd(software_factory_root, db_path=db_path) >= caps.hourly_spend_usd:
        return "hourly_cap"
    if today_spend_usd(software_factory_root, db_path=db_path) >= caps.daily_spend_usd:
        return "daily_cap"
    return "continue"


def _story_spend_since(db_path: Path, story_id: int | None, since_ts: str) -> float:
    """Sum ``runs.cost_usd`` for ``story_id`` with ``ts >= since_ts`` (best-effort)."""
    if story_id is None:
        return 0.0
    try:
        from factory.runner import Run, _engine

        total = 0.0
        with Session(_engine(db_path)) as session:
            rows = session.exec(select(Run).where(Run.story_id == story_id)).all()
            for r in rows:
                if (r.ts or "") >= since_ts:
                    total += float(r.cost_usd or 0.0)
        return total
    except Exception:
        # A broken ledger must not stop the loop-guard decision; treat as
        # budget-exhausted so the loop stops rather than spending blind.
        return float("inf")


def _handle_dev_once(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    force_red: bool = False,
) -> HandlerResult:
    """Single dev attempt: dispatch sandbox, check tests, do retry/escalation
    bookkeeping. See ``handle_dev`` for the convergence-loop wrapper.
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    story.state = advance(story, EVENT_DEV_STARTED).value
    persist_story(story, db)

    if dry_run:
        tests_green = not force_red
        _, payload = _dry_run_dev(story)
        if force_red:
            payload["test_run_passed"] = False
            payload["summary"] = "Dry-run dev failure: tests still red."
    else:
        from factory.chain import solo as _solo
        from factory.chain.branch import feature_branch_name
        from factory.runner import LLMConfig, sandbox_run

        # Dev runs in the same per-story worktree test_impl already created.
        # If test_impl wasn't run yet (e.g. retry path entered directly),
        # ``_writing_worktree`` will create it on demand.
        target_repo = _writing_worktree(app_config, software_factory_root, story)
        repo_path = target_repo
        story_file_path_obj = software_factory_root / "apps" / story.app / story.story_file_path
        difficulty = story.current_model_tier

        branch = feature_branch_name(story.github_issue_number, story.slug)
        story.github_branch = branch
        persist_story(story, db)

        dev_direction = find_direction_for_story(story, software_factory_root)
        from factory.directions.parser import get_direction_chain

        dev_chain = (
            get_direction_chain(dev_direction, software_factory_root)
            if dev_direction is not None
            else None
        )

        llm = LLMConfig(model=_route_for(story, "dev", difficulty))
        import asyncio

        # Carry prior attempts forward — the LLM gets to see what was tried
        # and which assertions are still red, so retry N doesn't re-discover
        # the same dead ends retries 1..N-1 already hit.
        prior_attempts: list[dict[str, Any]] = []
        if story.dev_attempts_json:
            try:
                prior_attempts = json.loads(story.dev_attempts_json) or []
            except (json.JSONDecodeError, TypeError):
                prior_attempts = []

        # When dev is re-dispatched after the reviewer requested changes, hand
        # it the reviewer's actual findings. Tests are already green on this
        # path, so without the findings the dev LLM has no signal about what to
        # fix and the dev<->reviewer loop cannot converge. The most recent
        # verdict carries the actionable items; earlier cycles ride along as a
        # ``prior_cycles`` digest so already-fixed sites don't regress.
        reviewer_findings: dict[str, Any] | None = None
        if story.reviewer_result_json:
            try:
                parsed = json.loads(story.reviewer_result_json)
                if isinstance(parsed, dict) and (
                    parsed.get("findings") or parsed.get("test_quality_findings")
                ):
                    reviewer_findings = parsed
            except (json.JSONDecodeError, TypeError):
                reviewer_findings = None
        if reviewer_findings is not None and story.reviewer_history_json:
            try:
                history = json.loads(story.reviewer_history_json)
                # The final history entry is the latest review — already fully
                # rendered as the actionable findings; only OLDER cycles go in
                # the do-not-regress digest.
                if isinstance(history, list) and len(history) > 1:
                    reviewer_findings["prior_cycles"] = history[:-1]
            except (json.JSONDecodeError, TypeError):
                pass

        from factory.settings.loader import load_settings as _load_settings

        _dev_timeout_s = _load_settings(software_factory_root).dev_convergence.dev_sandbox_timeout_s

        # SOLO pipeline (factory/chain/solo.py): one long conversation with the
        # gate's verdict fed back INTO it, a no-progress abort, and the solo
        # brief. Read from the spawn stamp only.
        solo_kwargs: dict[str, Any] = {}
        if _solo.is_solo(story):
            leaks = _solo.oracle_leak_precheck(app_config, Path(repo_path))
            plan = _solo.checks_plan(app_config, story)
            plan["oracle_leak_precheck"] = (
                "not applicable (acceptance oracle disabled for this app)"
                if leaks is None
                else ("clean" if not leaks else f"BLOCKED: {leaks[:5]}")
            )
            plan["dev_attempt"] = story.dev_retries + 1
            log_story_event(
                story.id,
                "solo_checks",
                plan,
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            if leaks:
                return _block_solo_oracle_leak(
                    story, leaks, db=db, software_factory_root=software_factory_root
                )
            _dev_timeout_s = _solo.SOLO_DEV_WALL_CLOCK_S
            _spend_cap, _spend_basis = _solo.spend_cap_for(story, software_factory_root, db)
            log_story_event(
                story.id,
                "solo_spend_cap",
                {"spend_cap_usd": _spend_cap, **_spend_basis},
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            _require_delta = _solo.requires_production_delta(app_config)
            _base = app_config.default_branch or "main"
            _static = _solo.static_gate_commands(app_config)
            _static_baseline = _solo.static_gate_baseline(Path(repo_path), _base, _static)
            if _static:
                log_story_event(
                    story.id,
                    "solo_static_baseline",
                    {
                        "commands": dict(_static),
                        # True = green on base; null = unknown (blocks);
                        # list = files already flagged on base.
                        "base": {
                            k: (sorted(v) if isinstance(v, (set, frozenset)) else v)
                            for k, v in _static_baseline.items()
                        },
                    },
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
            _brief = _solo.build_solo_brief(dev_direction)
            if _static:
                _brief = (
                    (_brief or "")
                    + "\n\n## The repo's own checks\n\nThe repo's CI also runs these. "
                    "Run them before you finish and fix what YOUR change breaks "
                    "(do not reformat or fix unrelated files):\n\n"
                    + "\n".join(f"- {n}: `{c}`" for n, c in _static)
                )
            solo_kwargs = {
                "gate_check": _solo.make_gate_check(
                    repo_path=Path(repo_path),
                    test_command=app_config.gates.test_command,
                    # READ-ONLY probes on the live tree: never _writing_worktree
                    # (it fetches + merges base) inside the conversation.
                    branch_is_empty=lambda: _solo.branch_is_empty_ro(Path(repo_path), _base),
                    production_delta=(
                        (lambda: _solo.production_delta_ro(Path(repo_path), _base))
                        if _require_delta
                        else None
                    ),
                    static_gates=_static,
                    static_baseline=_static_baseline,
                ),
                "max_gate_rounds": _solo.SOLO_MAX_GATE_ROUNDS,
                "no_progress_abort_s": _solo.SOLO_NO_PROGRESS_ABORT_S,
                "brief_addendum": _brief,
                "spend_cap_usd": _spend_cap,
            }

        run_res = asyncio.run(
            sandbox_run(
                persona="dev",
                story_path=story_file_path_obj,
                repo_path=repo_path,
                llm_config=llm,
                difficulty=difficulty,
                dry_run=False,
                direction_chain=dev_chain,
                software_factory_root=software_factory_root,
                test_command=app_config.gates.test_command,
                prior_attempts=prior_attempts,
                reviewer_findings=reviewer_findings,
                story_id=story.id,
                app=story.app,
                direction_id=story.direction_id,
                wall_clock_timeout_s=_dev_timeout_s,
                db_path=db,
                **solo_kwargs,
            )
        )
        if solo_kwargs:
            # Which independent checks ran inside the conversation, and why it
            # stopped — the evidence ``solo_checks`` promised.
            log_story_event(
                story.id,
                "solo_dev_rounds",
                {
                    "rounds": list(getattr(run_res, "gate_rounds", []) or []),
                    "stop_reason": getattr(run_res, "gate_stop_reason", ""),
                    "test_run_passed": run_res.test_run_passed,
                    "error": (run_res.error or "")[:500] or None,
                    "cost_usd": run_res.cost_usd,
                    "spend_cap_usd": solo_kwargs.get("spend_cap_usd"),
                    "spend_cap_hit_usd": getattr(run_res, "spend_cap_hit_usd", None),
                    "premodel_infra": bool(getattr(run_res, "premodel_infra", False)),
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )

        # Pre-model sandbox infrastructure guard. If the sandbox died before
        # any model work (transient .venv relink → TemplateNotFound, SDK
        # import failure, boot crash), this is shared-infra breakage, NOT a
        # dev-code failure. Treating it as "tests red" below would burn a dev
        # retry on a problem dev cannot fix and produce a $0/0.2s retry storm.
        # Instead: do NOT count it as a dev retry, do NOT escalate the model
        # tier; bounce straight back to dev (the transient usually clears by
        # the next tick), bounded by a consecutive-error cap so a persistent
        # fault escalates loudly rather than looping.
        if not dry_run and _is_premodel_infra_failure(run_res):
            # Provider content-filter blocks are NOT infrastructure: the same
            # conversation deterministically re-trips the filter (observed
            # 2026-06-11, Azure "ResponsibleAI" blocking deepseek's own
            # completion 3/3 on story 32), so retrying the same model just
            # marches to the breaker cap and terminally blocks the story.
            # Escalate to the hard-tier model instead — a different model has
            # a different filter profile. One-shot: if the hard tier also
            # filters, fall through to the bounded infra path below.
            if "content_filter" in (run_res.error or "") and story.current_model_tier != "hard":
                story.current_model_tier = "hard"
                story.state = advance(story, EVENT_DEV_TESTS_RED).value
                story.error = None
                persist_story(story, db)
                log_story_event(
                    story.id,
                    "dev_content_filter_tier_escalation",
                    {
                        "to_tier": "hard",
                        "error": (run_res.error or "")[:300],
                    },
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
                return HandlerResult(
                    next_state=StoryState(story.state),
                    payload={
                        "test_run_passed": False,
                        "content_filter_tier_escalation": True,
                    },
                    error=None,
                )
            prior_infra = _consecutive_trailing_infra_errors(story, software_factory_root)
            infra_err = (run_res.error or "sandbox failed before model work")[:300]
            if prior_infra < _MAX_DEV_SANDBOX_INFRA_RETRIES:
                story.state = advance(story, EVENT_DEV_TESTS_RED).value
                story.error = None
                persist_story(story, db)
                log_story_event(
                    story.id,
                    "dev_sandbox_infra_error",
                    {
                        "attempt": prior_infra + 1,
                        "cap": _MAX_DEV_SANDBOX_INFRA_RETRIES,
                        "error": infra_err,
                        "dev_retries_preserved": story.dev_retries,
                    },
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
                return HandlerResult(
                    next_state=StoryState(story.state),
                    payload={
                        "test_run_passed": False,
                        "sandbox_infra_error": infra_err,
                        "summary": (
                            "Sandbox infrastructure failure before any model "
                            f"work: {infra_err[:200]}. Re-dispatching dev "
                            f"(infra retry {prior_infra + 1}/"
                            f"{_MAX_DEV_SANDBOX_INFRA_RETRIES}); dev retry "
                            "budget untouched."
                        ),
                    },
                    error=None,
                )
            # Cap hit — a persistent sandbox/infra fault dev cannot fix. Block
            # loudly so the operator/FMS sees genuine infra breakage rather
            # than a story silently consuming retries.
            story.state = advance(story, EVENT_DEV_EXHAUSTED).value
            story.error = (
                f"sandbox infrastructure failure persisted across "
                f"{_MAX_DEV_SANDBOX_INFRA_RETRIES} consecutive retries: {infra_err[:200]}"
            )
            persist_story(story, db)
            log_story_event(
                story.id,
                "factory_needs_redesign",
                {
                    "kind": "sandbox_infra_persistent",
                    "infra_retries": prior_infra,
                    "error": infra_err,
                    "suggestions": [
                        "The dev sandbox failed before any model work on every "
                        "attempt (e.g. TemplateNotFound / SDK import / boot "
                        "crash). This is environment breakage, not a code or "
                        "test problem dev can fix. Check for a concurrent "
                        "`uv run`/`uv sync` relinking the shared .venv, a "
                        "corrupt OpenHands install, or a missing prompt template.",
                    ],
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            return HandlerResult(
                next_state=StoryState(story.state),
                payload={
                    "test_run_passed": False,
                    "sandbox_infra_error": infra_err,
                },
                error=story.error,
            )

        # Loop-4 (dev-owns-tests): the dev persona writes BOTH production code
        # and its tests, so there is no "tests are frozen" invariant to enforce
        # and no Test-Designer to route a clarification back to. A failed run is
        # simply a dev retry (below). Test *quality* (no slop, meaningful
        # assertions) is gated downstream by the reviewer + programmatic slop
        # detector, not here.
        tests_green = bool(run_res.test_run_passed)
        # GREEN WITH NO PRODUCTION DELTA IN THE BRANCH is not green — bench only.
        #
        # ``tests_green`` reads the test command's return code and nothing else, so
        # a dev that changed nothing at all reaches green whenever the suite was
        # already passing. Measured on sweep 2: `conan-io__conan-19750` declared
        # green on an empty tree and the row graded `empty_patch`.
        #
        # THE QUESTION IS ABOUT THE BRANCH, NOT THIS ATTEMPT. The first cut asked
        # ``not run_res.files_changed`` — "did THIS attempt touch a file" — and that
        # is a different question with a catastrophic answer. ``files_changed`` is
        # per-attempt: a dev that lands its fix on attempt 1 and then re-runs
        # (after a reviewer round-trip, or to re-verify) reports an EMPTY list on
        # attempt 2 while the tree still carries the fix. Measured on the
        # 2026-08-11 replay, which is why that run was killed:
        #
        #   * `pyinfra-1665` — attempt 0 touched 2 files and went green; attempts 1
        #     and 2 were ALSO green ("32 passed") with `files_changed: []`, were
        #     forced red here, produced an identical signature, and the story
        #     blocked on `same_failure_signature 2x`. It had RESOLVED in sweep 2.
        #   * `opensandbox-816` — attempt 1 touched 15 files and went green
        #     ("108 passed"); attempts 2 and 3 were green ("111 passed") with an
        #     empty list, and the story blocked the same way.
        #
        # So ask the branch. And fail OPEN: when the delta cannot be determined,
        # keep the green. The gate exists to catch a rare "green on an empty tree";
        # its failure mode must never be "block every story", which is exactly what
        # the first cut did.
        #
        # SCOPED TO THE BENCH DRIVER, deliberately. On the live chain a docs-only
        # story, a config-only story and a story whose remaining delta is already
        # on the base branch all legitimately produce no production change, and a
        # global rule would fail every one of them. The bench is the one context
        # where the story is always "fix this bug in this repo".
        if (
            tests_green
            and not solo_kwargs  # solo already ran it inside the conversation
            and bool(getattr(app_config.gates, "require_production_delta", False))
        ):
            delta = _branch_has_production_delta(story, app_config, software_factory_root)
            if delta is False:
                tests_green = False
                log_story_event(
                    story.id,
                    "dev_green_with_no_production_delta",
                    {
                        "reason": (
                            "bench driver: the BRANCH carries no non-test change, "
                            "so a green test command proves nothing"
                        ),
                        "attempt_files_changed": list(run_res.files_changed or []),
                    },
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
        payload = {
            "files_changed": run_res.files_changed,
            "test_run_passed": tests_green,
            "summary": run_res.summary[-2000:],
        }

        # ImpossibleBench escape hatch, checked BEFORE the green/red split and
        # BEFORE any retry bookkeeping. See BLOCKED_UNDERSPECIFIED in
        # state_machine.py for the measurement this implements.
        declared = declared_underspecified(run_res)
        if declared is not None:
            return _block_underspecified(
                story,
                declared,
                db=db,
                software_factory_root=software_factory_root,
                tests_green=tests_green,
                files_changed=list(run_res.files_changed or []),
            )

        # Loop-4: a dev run that ends red — including one that made no code
        # changes — is just a failed attempt and consumes a retry below. There
        # is no longer a separate test author to route a "tests are wrong"
        # signal back to: the dev owns the tests and fixes them on the next
        # attempt. The no-change case still exhausts the budget quickly because
        # ``_MAX_DEV_RETRIES`` caps total attempts.

    if tests_green:
        # Record the GREEN run's test output too. The reviewer's
        # ``_fetch_latest_test_output`` prefers the last dev_attempts_json
        # entry; when only red attempts were recorded, a story with any red
        # history showed the reviewer stale failures forever — story 32 was
        # rejected on 2026-06-11 over a "still 12 failing tests" tail that
        # was ten days old.
        if not dry_run:
            green_record = {
                "attempt": story.dev_retries,
                "ts": datetime.now(UTC).isoformat(),
                "test_run_passed": True,
                "files_touched": (run_res.files_changed or [])[:20],
                "test_output_tail": (run_res.summary or "")[-1800:],
                "summary": "tests green",
                "self_summary": (getattr(run_res, "self_summary", "") or "")[:2000],
            }
            try:
                prior_green = json.loads(story.dev_attempts_json or "[]")
                if not isinstance(prior_green, list):
                    prior_green = []
            except (json.JSONDecodeError, TypeError):
                prior_green = []
            prior_green.append(green_record)
            story.dev_attempts_json = json.dumps(prior_green[-5:])
            # WS4.2 resume checkpoint: persist the completed green artifact +
            # marker BEFORE the state advance. If the tick dies between here and
            # the advance below, the next dev dispatch reads this marker and
            # resumes to TESTS_GREEN without re-running the dev LLM (the green
            # code already lives in the reused worktree). The advance below
            # clears it, so it survives only a genuine interruption.
            story.dev_step_checkpoint = json.dumps(
                {
                    "outcome": "green",
                    "attempt": story.dev_retries,
                    "ts": datetime.now(UTC).isoformat(),
                }
            )
            persist_story(story, db)
            # Deterministically COMMIT the dev's green work before review so the
            # reviewer's origin/base...HEAD diff is never empty (see
            # ``_commit_green_dev_work``). Fixes the dev<->review empty-diff
            # churn observed on story 106 (2026-07-21).
            _commit_green_dev_work(
                story,
                app_config,
                software_factory_root,
                repo=Path(repo_path) if solo_kwargs else None,
            )
        story.state = advance(story, EVENT_DEV_TESTS_GREEN).value
        story.dev_step_checkpoint = None
        from factory.chain.solo import is_solo as _is_solo_green

        if _is_solo_green(story):
            # No reviewer will overwrite these: a CI-fix / enforcer finding that
            # dev just resolved must not be re-rendered into a LATER attempt.
            story.reviewer_result_json = None
        persist_story(story, db)
        return HandlerResult(next_state=StoryState(story.state), payload=payload)

    # Not green — bump retries AND record this attempt's diagnostic so the
    # next retry sees what was tried and what failed. Dry-run has no
    # ``run_res`` (synthetic payload only); skip the feed-forward record
    # so the retry test fixture isn't tangled.
    story.dev_retries += 1
    # Record the retry in the replayable chain_step stream. Dev retries happen
    # INSIDE a single handler invocation, so the orchestrator's two emit sites
    # (which fire once per dispatch) never see them: the stream held 400
    # ``advanced`` + 10 ``error`` rows and zero ``retried`` rows while 41
    # stories carried a non-zero ``dev_retries``. A retry is not a state
    # transition, so from_state == to_state deliberately.
    #
    # ``retry_attempt``/``retry_cap`` are named to avoid colliding with the
    # payload's own ``attempt`` field (which carries ``story.total_attempts``);
    # ``extra`` is merged last and would otherwise silently redefine it.
    emit_chain_step(
        story,
        handler="dev",
        from_state=story.state,
        to_state=story.state,
        outcome="retried",
        software_factory_root=software_factory_root,
        extra={
            "retry_attempt": story.dev_retries,
            "retry_cap": _dev_retry_cap(story, software_factory_root),
        },
    )
    if not dry_run:
        # Capture rich cross-retry memory: the file diff + test tail are
        # the "what failed" signal; ``self_summary`` + ``last_assistant_message``
        # + ``recent_tool_calls`` are the "what dev was thinking" signal.
        # The next retry's _build_initial_message renders both layers into
        # the prompt so the new conversation inherits the prior session's
        # context, not just its stack trace.
        attempt_record = {
            "attempt": story.dev_retries,
            "ts": datetime.now(UTC).isoformat(),
            "test_run_passed": False,
            "files_touched": (run_res.files_changed or [])[:20],
            "test_output_tail": (run_res.summary or "")[-1800:],
            "summary": (run_res.error or "tests not green after run")[:300],
            "self_summary": (getattr(run_res, "self_summary", "") or "")[:2000],
            "last_assistant_message": (getattr(run_res, "last_assistant_message", "") or "")[:2000],
            "recent_tool_calls": list(getattr(run_res, "recent_tool_calls", []) or [])[-8:],
            # How many prose-only endings the harness had to nudge this attempt
            # past. 0 on a healthy run. Recorded here because the counter was
            # otherwise unreadable outside a unit test, so an operator could not
            # tell a rescued run from a clean one.
            "prose_continuations": int(getattr(run_res, "prose_continuations", 0) or 0),
        }
        try:
            prior = json.loads(story.dev_attempts_json or "[]")
            if not isinstance(prior, list):
                prior = []
        except (json.JSONDecodeError, TypeError):
            prior = []
        prior.append(attempt_record)
        # R2: stamp this attempt with its normalized failure signature, reusing
        # the SAME normalize+hash core the recovery / CI-fix loops use (via
        # ``_story_failure_signature``) so "is this the same failure" means the
        # same thing everywhere. Signed from the attempt's own ``test_output_tail``
        # (already in-memory) so we serialize dev_attempts_json exactly ONCE.
        # Cap history to last 5 entries — beyond that the prompt bloat outweighs
        # the signal, and we have the full chain in the per-story event log.
        # Detection survives across ticks via the persisted field.
        from factory.chain.orchestrator import _failure_signature_from_tail

        _tail = str(attempt_record["test_output_tail"])
        # EVIDENCE FRESHNESS, not output similarity — see the comment on
        # ``_tail_shows_test_results``. A tail with no test outcomes in it is not
        # comparable to anything, so it gets the empty signature and cannot feed
        # the stall streak. Recorded explicitly as well, so a reader can tell
        # "no comparable evidence" from "we forgot to stamp it".
        attempt_record["test_results_seen"] = _tail_shows_test_results(_tail)
        attempt_record["failure_signature"] = (
            _failure_signature_from_tail(_tail) if attempt_record["test_results_seen"] else ""
        )
        story.dev_attempts_json = json.dumps(prior[-5:])

    # R2: if the last _MAX_DEV_SAME_SIGNATURE red runs all failed with the
    # identical signature, the loop is unproductive — escalate now instead of
    # burning the rest of the retry + per-story budget re-discovering the same
    # dead end. Dry-run records no attempts, so this never fires there.
    same_sig_count = 0
    if not dry_run:
        try:
            _attempts_now = json.loads(story.dev_attempts_json or "[]")
        except (json.JSONDecodeError, TypeError):
            _attempts_now = []
        _cur_sig = str(attempt_record.get("failure_signature", "") or "")
        same_sig_count = _consecutive_same_dev_signature(_attempts_now, _cur_sig)
    same_sig_stall = same_sig_count >= _MAX_DEV_SAME_SIGNATURE

    if (
        story.dev_retries >= _dev_retry_cap(story, software_factory_root) or same_sig_stall
    ) and not dry_run:
        _settled = _settle_exhausted_ci_fix_of_watched_pr(
            story,
            app_config,
            software_factory_root,
            db=db,
            same_sig_count=same_sig_count if same_sig_stall else 0,
        )
        if _settled is not None:
            payload["dev_exhausted_ci_fix_settled"] = story.state
            return HandlerResult(next_state=_settled, payload=payload)

    if story.dev_retries >= _dev_retry_cap(story, software_factory_root) or same_sig_stall:
        # Preserve whatever dev produced so the work doesn't evaporate
        # into a stash when the next story takes the working tree. Commit
        # any uncommitted changes, push the branch to origin, and surface
        # the failure with enough detail for a human (or follow-up persona
        # run) to pick it up without forensic stash-archaeology. The
        # story still terminates in BLOCKED_TESTS_NEED_CLARIFICATION but
        # the branch exists at origin and any partial code is committed.
        #
        # Dry-run skips the commit/push entirely — there's no real work
        # to preserve and ``_writing_worktree`` would try to ``git
        # worktree add`` against a fixture repo that doesn't exist.
        commit_pushed = False
        commit_sha: str | None = None
        if not dry_run:
            from factory.chain.branch import _run_git as _git

            target_repo = _writing_worktree(app_config, software_factory_root, story)
            try:
                _git(target_repo, "add", "-A")
                dirty = _git(target_repo, "status", "--porcelain").stdout.strip()
                if dirty:
                    _git(
                        target_repo,
                        "commit",
                        "-m",
                        (
                            f"wip(dev-exhausted): preserve partial work for story "
                            f"{story.id} ({story.slug})\n\n"
                            f"Dev exhausted {story.dev_retries} chain-level retries "
                            f"without reaching green. The chain commits this WIP so "
                            f"the work is recoverable from origin rather than living "
                            f"in a local stash. See ``factory why {story.id}`` for "
                            f"the per-attempt event log."
                        ),
                    )
                head_proc = _git(target_repo, "rev-parse", "HEAD")
                commit_sha = head_proc.stdout.strip() or None
                # Delivery level ``none`` never pushes — not even a WIP
                # preservation push. The commit above keeps the work on the
                # local story branch, which is exactly what ``none`` promises.
                _may_push = delivery_story_level(
                    story, app_config, software_factory_root, db
                ).pushes
                if _may_push:
                    push_proc = _git(
                        target_repo,
                        "push",
                        "-u",
                        "origin",
                        story.github_branch or "HEAD",
                        check=False,
                    )
                    commit_pushed = push_proc.returncode == 0
                else:
                    payload["dev_exhausted_push_skipped"] = "delivery_level_none"
                # Emit git signals — best-effort.
                try:
                    from factory.manager.signals import write_git_event as _wge

                    if dirty:
                        _wge(
                            kind="commit",
                            story_id=story.id,
                            worktree_path=str(target_repo),
                            commit_sha=commit_sha,
                            result="ok",
                            software_factory_root=software_factory_root,
                        )
                    if _may_push:
                        _wge(
                            kind="push",
                            story_id=story.id,
                            worktree_path=str(target_repo),
                            result="ok" if commit_pushed else "error",
                            error=None if commit_pushed else "push failed",
                            software_factory_root=software_factory_root,
                        )
                except Exception:  # noqa: BLE001
                    pass
            except Exception as commit_exc:
                payload["dev_exhausted_commit_error"] = repr(commit_exc)

        story.state = advance(story, EVENT_DEV_EXHAUSTED).value
        _stall_note = (
            f"same failure signature {same_sig_count}x (>= {_MAX_DEV_SAME_SIGNATURE}); "
            if same_sig_stall
            else ""
        )
        story.error = (
            f"dev exhausted retries ({story.dev_retries}); {_stall_note}"
            f"partial work {'pushed to origin' if commit_pushed else 'committed locally'}"
            f"{f' as {commit_sha[:12]}' if commit_sha else ''}"
        )
        payload["dev_exhausted_commit_sha"] = commit_sha
        payload["dev_exhausted_pushed"] = commit_pushed
        if same_sig_stall:
            payload["dev_same_signature_stall"] = same_sig_count
        persist_story(story, db)
        log_story_event(
            story.id,
            "dev_exhausted",
            {
                "retries": story.dev_retries,
                "commit_sha": commit_sha,
                "pushed": commit_pushed,
                "files_changed": payload.get("files_changed", []),
                # R2: distinguish "ran out of retry budget" from "same failure
                # N times — escalated early on no new signal".
                "reason": "same_failure_signature" if same_sig_stall else "max_retries",
                "same_signature_count": same_sig_count if same_sig_stall else None,
            },
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )
        # Exhausted retries with the new low cap + prior-attempts feed-forward
        # is a strong signal something upstream of dev is wrong: tests are
        # impossible, persona prompts need work, context docs lack
        # information, or PM cut the story too broadly. Emit a structured
        # "factory_needs_redesign" event with a recommendation so the
        # operator (or a future improver persona) can act on it instead of
        # just retrying more.
        prior_attempts_summary = []
        try:
            prior_attempts_summary = json.loads(story.dev_attempts_json or "[]")
        except (json.JSONDecodeError, TypeError):
            pass

        # Heuristic suggestions based on what the diagnostic actually shows.
        last_tail = ""
        if prior_attempts_summary:
            last_tail = prior_attempts_summary[-1].get("test_output_tail", "")
        suggestions: list[str] = []
        if "ImportError" in last_tail or "ModuleNotFoundError" in last_tail:
            suggestions.append(
                "Test harness fails at import — check .env / DATABASE_URL "
                "replication into the worktree, conftest dependencies, or "
                "missing fixtures. Not a code issue dev can fix."
            )
        if "TESTS_NEED_CLARIFICATION" in last_tail:
            suggestions.append(
                "Dev tried to escalate test-design — verify the escape "
                "hatch wiring is firing and test_implementer re-ran with "
                "the clarification."
            )
        same_tails = (
            len(prior_attempts_summary) >= 2
            and len({a.get("test_output_tail", "")[-300:] for a in prior_attempts_summary}) == 1
        )
        if same_tails:
            suggestions.append(
                "All attempts hit the exact same failure tail — dev's LLM "
                "is stuck on a problem code alone cannot fix. Re-prompt "
                "test_implementer or revisit the story's acceptance criteria."
            )
        if not suggestions:
            suggestions.append(
                "Investigate the per-story event log (``factory trace "
                f"{story.id}``) and the partial commit on origin "
                f"({commit_sha[:12] if commit_sha else 'no commit'}) — "
                "the chain ran out of attempts but the cause isn't obvious "
                "from the diagnostic."
            )

        log_story_event(
            story.id,
            "factory_needs_redesign",
            {
                "kind": "dev_same_signature_stall" if same_sig_stall else "dev_exhausted",
                "retries_used": story.dev_retries,
                "max_retries": _dev_retry_cap(story, software_factory_root),
                "same_signature_count": same_sig_count if same_sig_stall else None,
                "last_test_output_tail": last_tail[-600:],
                "suggestions": suggestions,
                "branch": story.github_branch,
                "commit_sha": commit_sha,
            },
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )

        # Post a comment on the direction's tracker issue (best-effort) so
        # the signal is loud + persistent + linkable.
        if not dry_run:
            try:
                _post_factory_needs_redesign_comment(
                    story=story,
                    app_config=app_config,
                    suggestions=suggestions,
                    last_tail=last_tail,
                    software_factory_root=software_factory_root,
                )
            except Exception as exc:  # never let a comment failure mask the real return
                log_story_event(
                    story.id,
                    "factory_needs_redesign_comment_failed",
                    {"error": repr(exc)},
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )

        return HandlerResult(next_state=StoryState(story.state), payload=payload, error=story.error)

    # Escalate model tier on retry (standard -> hard).
    if story.current_model_tier == "standard":
        story.current_model_tier = "hard"
    story.state = advance(story, EVENT_DEV_TESTS_RED).value
    persist_story(story, db)
    log_story_event(
        story.id,
        "dev_retry",
        {
            "retries": story.dev_retries,
            "model_tier": story.current_model_tier,
            "files_changed": payload.get("files_changed", []),
            "summary_tail": payload.get("summary", "")[-500:],
        },
        software_factory_root=software_factory_root,
    )

    # Each retry IS a factory-improvement signal: under a healthy chain,
    # most stories should land first-pass. A retry means something upstream
    # of dev needs work — test_implementer wrote ambiguous tests, the persona
    # prompts missed context, the harness was subtly off, etc. Emit a
    # ``factory_needs_redesign`` event on EACH retry so it's visible early
    # (via ``factory trace`` / the state event log) instead of waiting for
    # exhaustion. ``kind: dev_retry_observed`` distinguishes this from the
    # exhaustion event below. (Before 2026-08-07 this stream also fed the
    # factory_improver persona; that consumer is gone, but the event is still
    # the operator-visible early-warning signal.)
    if not dry_run:
        log_story_event(
            story.id,
            "factory_needs_redesign",
            {
                "kind": "dev_retry_observed",
                "retries": story.dev_retries,
                "max_retries": _dev_retry_cap(story, software_factory_root),
                "model_tier": story.current_model_tier,
                "last_test_output_tail": (payload.get("summary") or "")[-600:],
                "files_changed": payload.get("files_changed", [])[:10],
                "branch": story.github_branch,
                "suggestions": [
                    "Inspect this story's dev retry — even a single retry is a "
                    "failure signal worth aggregating. Recurring retries on the "
                    "same persona / scope shape mean a prompt or harness gap."
                ],
            },
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )

    return HandlerResult(next_state=StoryState(story.state), payload=payload)


# --------------------------------------------------------------------------- #
# review
# --------------------------------------------------------------------------- #


# Section caps for handle_review / handle_tech_writer prompt plumbing. Keep
# these as module-level constants so the contract tests can import them.
# Section caps for the assembled review/tech_writer prompts. These are
# CHARACTER counts (str.__len__), not byte counts — Python's slicing
# operates on characters, and ``len(s) <= N`` uses the same unit. The
# ``_BYTES`` suffix is preserved for historical naming compatibility
# (and because for ASCII-heavy persona output the two coincide); a future
# refactor may rename them but the semantics are documented here so the
# constant is not ambiguous.
_STORY_CONTENT_CAP_BYTES = 32 * 1024  # characters; ~32KiB ASCII
_TEST_OUTPUT_CAP_BYTES = 8 * 1024  # characters; ~8KiB ASCII
_PR_DIFF_CAP_BYTES = 64 * 1024  # characters; ~64KiB ASCII

# Markers that indicate a prompt section was NOT populated with real data
# (the literal placeholder strings that caused stories 5/15/16/18/19/22 to
# cycle dev<->reviewer 5+ times). The sanity guard in handle_review raises
# RuntimeError if any of these survive into the final prompt; the prompt
# logger in factory.runner.text_run also scans for them so the watcher can
# surface regressions before they burn another month of reviewer cycles.
_BROKEN_PROMPT_MARKERS: tuple[str, ...] = (
    "(fetched from GitHub by the chain",
    "placeholder for real-run",
    # The literal "(see {" never appears when the f-string interpolates a
    # real path — only when the f-string itself was removed and replaced
    # by a bare string. We match the literal substring so a regressing
    # author swapping the f-string out is caught.
    "(see {",
    # Diff-fetch failure text. ``_fetch_pr_diff_for_review`` used to be
    # FAIL-OPEN: any ``gh pr diff`` / ``git diff`` failure returned the error
    # text AS the diff, so the reviewer reviewed blind and produced "I cannot
    # see the diff" blocking findings — a $0.008 reviewer decision triggering
    # ~45x that in dev rework per cycle (2026-07-31 SWE-bench batch: rc=128
    # on a missing ``origin/<base>`` ref poisoned EVERY review). The fetch now
    # RAISES ``ReviewDiffUnavailableError`` instead (fail-closed, handled at
    # both call sites before any prompt is built), so these strings must never
    # reach a prompt again; the markers are the backstop that catches a
    # regression to fail-open.
    #
    # Two rules keep the backstop from misfiring on LEGITIMATE prompt content
    # (the diff section and test output embed arbitrary code/prose — a
    # committed line like ``msg = f"command returned rc={rc}"`` crashed a real
    # review when the marker was the bare ``"returned rc="``):
    #  * anchor on the parenthesized/format-specific prefixes only the OLD
    #    fail-open plumbing emitted, never on generic prose fragments;
    #  * build each marker by CONCATENATION so the contiguous literal never
    #    appears in this repo's own source — otherwise any loop-2 self-edit
    #    whose diff context includes this very tuple would trip the guard and
    #    crash-loop the review.
    # old gh fail-open prefix: paren + command + "#" + PR number + rc text
    "(gh pr diff " + "#",
    # old git fail-open midsection: base ref ellipsis + HEAD + rc text
    "...HEAD " + "returned rc=",
    "(gh pr diff " + "failed",
    "(git diff worktree " + "failed",
    "(could not resolve " + "writing worktree",
)


def _read_story_file_content(story: StoryRecord, software_factory_root: Path) -> str:
    """Return the story markdown content, capped, with a clear error fallback.

    The reviewer / tech_writer prompts used to embed ``(see <path>)`` instead
    of the actual file content — that meant the LLM was guessing about the
    story's acceptance criteria and routinely demanded clarifications about
    information that was already on disk.
    """
    if not story.story_file_path:
        return "(no story_file_path on record)"
    story_path = software_factory_root / "apps" / story.app / story.story_file_path
    try:
        content = story_path.read_text(encoding="utf-8")
    except (OSError, FileNotFoundError) as exc:
        return f"(story file unreadable at {story_path}: {exc!r})"
    if len(content) > _STORY_CONTENT_CAP_BYTES:
        content = content[:_STORY_CONTENT_CAP_BYTES] + "\n...[truncated at 32KB]"
    return content


def _fetch_latest_test_output(
    story: StoryRecord,
    software_factory_root: Path,
) -> str:
    """Return the most recent test output for ``story``.

    Preference order (richest signal first):

    1. The last entry of ``story.dev_attempts_json`` — dev writes a
       ``test_output_tail`` (1800 char tail) here on every red retry. This
       is the freshest signal when dev has run at least once.
    2. The most recent ``harness_precheck`` event in the per-story log —
       captures the output_tail of the one-shot pytest collect+exit that
       the chain runs before dev. Useful when the story bounced back to
       reviewer before dev produced an attempt of its own (e.g. tech_writer
       failure routed to REVIEWER_REQUESTED_CHANGES).
    3. ``"(no recent test run on record)"`` — explicit signal to the
       reviewer that test output isn't available, instead of an empty
       JSON object that looks indistinguishable from a passing run.

    Output is capped at 8KB regardless of source.
    """
    # 1. dev_attempts_json (preferred)
    if story.dev_attempts_json:
        try:
            attempts = json.loads(story.dev_attempts_json)
        except (TypeError, json.JSONDecodeError):
            attempts = None
        if isinstance(attempts, list) and attempts:
            last = attempts[-1]
            tail = (last.get("test_output_tail") or "").strip()
            if tail:
                passed = last.get("test_run_passed")
                verdict = "PASSED" if passed is True else "FAILED" if passed is False else "unknown"
                header = (
                    f"(from dev_attempts[-1]; "
                    f"attempt={last.get('attempt')!r} "
                    f"ts={last.get('ts')!r} "
                    f"run_verdict={verdict})\n"
                )
                body = header + tail
                if len(body) > _TEST_OUTPUT_CAP_BYTES:
                    body = body[:_TEST_OUTPUT_CAP_BYTES] + "\n...[truncated at 8KB]"
                return body

    # 2. harness_precheck event log
    if story.id is not None:
        try:
            from factory.chain.event_log import read_story_events

            events = read_story_events(
                story.id,
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
        except Exception:  # noqa: BLE001 — log read must never break review
            events = []
        for ev in reversed(events):
            if ev.get("event") == "harness_precheck" and ev.get("output_tail"):
                tail = str(ev.get("output_tail")).strip()
                header = (
                    f"(from harness_precheck event; "
                    f"exit_code={ev.get('exit_code')!r} "
                    f"passed={ev.get('passed')!r} "
                    f"ts={ev.get('ts')!r})\n"
                )
                body = header + tail
                if len(body) > _TEST_OUTPUT_CAP_BYTES:
                    body = body[:_TEST_OUTPUT_CAP_BYTES] + "\n...[truncated at 8KB]"
                return body

    return "(no recent test run on record)"


# Cap for the dev self-summary embedded in the reviewer prompt. Matches the
# 2000-char cap ``_handle_dev_once`` applies when persisting the attempt.
_SELF_SUMMARY_PROMPT_CAP = 2000


def _fetch_latest_dev_self_summary(story: StoryRecord) -> str:
    """Return the last dev attempt's ``self_summary``, or an explicit sentinel.

    Same source as ``_fetch_latest_test_output`` preference 1: the trailing
    entry of ``story.dev_attempts_json``. The reviewer needs this because the
    dev's story-silent choices (invented literals, fixture shapes, data
    sources) are only defensible via the precedent the dev cited here — the
    2026-08-02 SWE-bench autopsies found every wrong patch was approved with
    zero findings partly because the reviewer was never told which choices
    were dev-invented versus story-mandated.

    The sentinel for "no summary" is deliberate reviewable signal, never an
    empty string: a dev that provided no self-summary skipped its own
    output contract, and the reviewer should see that.
    """
    sentinel = "(dev provided no self-summary)"
    try:
        attempts = json.loads(story.dev_attempts_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return sentinel
    if not isinstance(attempts, list) or not attempts:
        return sentinel
    last = attempts[-1]
    if not isinstance(last, dict):
        return sentinel
    summary = str(last.get("self_summary") or "").strip()
    if not summary:
        return sentinel
    return summary[:_SELF_SUMMARY_PROMPT_CAP]


def _has_real_dev_attempt(story: StoryRecord) -> bool:
    """True when at least one REAL (non-dry-run) dev attempt is on record.

    ``dev_attempts_json`` is only ever appended to by ``_handle_dev_once``
    on a non-dry-run completion — both the green-run record and the
    red-run/retry record are gated behind ``if not dry_run:`` (see
    ``_handle_dev_once``). So a non-empty list here is proof a real dev
    sandbox actually ran, which is the signal the empty-diff short-circuit
    needs before it's allowed to fire — it must never trigger on a story
    that hasn't given dev a real chance yet.
    """
    try:
        parsed = json.loads(story.dev_attempts_json or "[]")
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(parsed, list) and len(parsed) > 0


def _dev_produced_empty_diff(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
) -> bool | None:
    """Best-effort check: is the story's branch diff-empty against its base?

    Returns ``True`` when the COMMITTED diff (``git diff --quiet
    origin/<base>...HEAD``) AND the working tree are both empty — i.e. the
    dev genuinely produced nothing at all — ``False`` when either a real
    committed diff OR uncommitted/untracked working-tree changes exist, or
    ``None`` when the check itself could not be performed (no worktree yet,
    git error, unexpected exit code, neither ``origin/<base>`` nor a local
    ``<base>`` ref resolving). ``None`` means "unknown" — callers MUST treat
    it as "do not short-circuit" and fall back to the normal review path.

    The working-tree check matters because the dev's "work happened" signal
    is commit-agnostic: ``files_changed``/``test_run_passed`` come from the
    on-disk working tree (``git status --porcelain`` / the pytest run
    against it), but the dev agent is only INSTRUCTED to commit, not forced
    to. An agent that produces real, test-passing work but never runs its
    final ``git commit`` (e.g. it hit a turn/timeout limit) would otherwise
    show an empty COMMITTED diff and get permanently blocked on its first
    pass — worse than the review churn this check exists to prevent. So an
    uncommitted/untracked change in the worktree is treated the same as a
    committed one: NOT empty, fall back to the normal review path (which at
    least gives dev more retries to land the commit).
    """
    import subprocess

    try:
        worktree = _writing_worktree(app_config, software_factory_root, story)
    except Exception:  # noqa: BLE001 - best-effort, fail open
        return None

    # Working-tree check FIRST: uncommitted/untracked changes mean dev did
    # real work even if it never committed. Never short-circuit on that.
    try:
        status_proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            # Paths in status output are arbitrary bytes; tolerate rather
            # than strict-decode-crash (UnicodeDecodeError is a ValueError,
            # outside the OSError taxonomy below).
            errors="replace",
            check=False,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError):
        return None
    if status_proc.returncode != 0:
        return None
    if status_proc.stdout.strip():
        return False

    base = app_config.default_branch or "main"
    # origin/<base> → local <base> fallback (see _resolve_diff_base): keeps
    # this check consistent with _fetch_pr_diff_for_review in worktrees that
    # have no ``origin`` remote, instead of degrading to "unknown" there.
    base_ref = _resolve_diff_base(worktree, base)
    if base_ref is None:
        return None
    try:
        proc = subprocess.run(
            ["git", "diff", "--quiet", f"{base_ref}...HEAD"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError):
        return None
    # ``git diff --quiet`` exits 0 (no diff), 1 (diff present), or >1 on a
    # real error (e.g. bad/missing ref) — only 0/1 are meaningful signals.
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    return None


class ReviewDiffUnavailableError(RuntimeError):
    """The diff a persona must judge could not be fetched.

    Raised by ``_fetch_pr_diff_for_review`` on ANY fetch failure (``gh pr
    diff`` non-zero, git error, missing base ref, unresolvable worktree).
    This is deliberately an exception, not an in-band error string: the old
    fail-open behaviour returned the error text AS the diff, the reviewer
    reviewed blind, and every cheap "I cannot see the diff" blocking finding
    triggered a ~45x more expensive dev rework cycle (observed 2026-07-31:
    a missing ``origin/<base>`` ref made ``git diff`` return rc=128 in every
    review of every SWE-bench batch). Callers must treat this as a hard
    precondition failure: no model call, no review-cycle burn, route the
    story to a blocked state a human can see.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _resolve_diff_base(worktree: Path, base: str) -> str | None:
    """Return the first base ref that resolves in ``worktree``, or ``None``.

    Fallback chain: ``origin/<base>`` (the normal topology against a real
    remote), then local ``<base>`` (worktrees cut from a repo with no
    ``origin`` remote — e.g. a bench harness or a local-only app repo).
    ``None`` means neither ref exists (or git itself failed) — callers must
    fail CLOSED on it, never guess.
    """
    import subprocess

    for ref in (f"origin/{base}", base):
        try:
            proc = subprocess.run(
                ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
                cwd=str(worktree),
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError):
            return None
        if proc.returncode == 0:
            return ref
    return None


def _fetch_pr_diff_for_review(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
) -> str:
    """Return the diff the reviewer should look at. FAIL-CLOSED.

    Two cases:

    * ``story.github_pr_number`` is set → ``gh pr diff <num> -R <repo>``.
      This is the source of truth once a PR exists.
    * Otherwise → ``git diff <base>...HEAD`` inside the per-story worktree,
      where ``<base>`` is resolved by ``_resolve_diff_base`` (``origin/<base>``
      first, then local ``<base>``). The chain creates a PR lazily; reviewer
      can fire before that point, and we still want a real diff, not a
      placeholder.

    The result is capped at 64KB. A genuinely EMPTY diff is returned as ``""``
    — the call sites decide what an empty diff means for their persona (a
    reviewer cannot approve zero commits). Any fetch FAILURE raises
    ``ReviewDiffUnavailableError`` — this helper must never return error text
    as if it were a diff (the fail-open bug that produced blind reviews). The
    BROKEN_PROMPT_MARKERS guard downstream is the backstop that catches a
    regression to fail-open.
    """
    import subprocess

    diff_text: str

    pr_number = story.github_pr_number
    if pr_number is not None:
        try:
            proc = subprocess.run(
                ["gh", "pr", "diff", str(pr_number), "-R", app_config.repo],
                capture_output=True,
                text=True,
                # Diffs are arbitrary bytes: repos legitimately contain
                # non-UTF-8 source (latin-1 files in django et al.). Without
                # this, ``text=True`` strict-decodes inside communicate() and
                # a UnicodeDecodeError (a ValueError — outside the OSError
                # taxonomy) escapes the fail-closed contract entirely. A few
                # U+FFFD replacement chars in an otherwise-real diff is far
                # better than a crash-looping review.
                errors="replace",
                check=False,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError) as exc:
            raise ReviewDiffUnavailableError(f"gh pr diff #{pr_number} failed: {exc!r}") from exc
        if proc.returncode != 0:
            raise ReviewDiffUnavailableError(
                f"gh pr diff #{pr_number} exited rc={proc.returncode}; "
                f"stderr_tail={proc.stderr.strip()[-200:]!r}"
            )
        diff_text = proc.stdout or ""
    else:
        # No PR yet — diff the worktree against the default branch.
        try:
            worktree = _writing_worktree(app_config, software_factory_root, story)
        except Exception as exc:  # noqa: BLE001
            raise ReviewDiffUnavailableError(
                f"could not resolve writing worktree: {exc!r}"
            ) from exc
        base = app_config.default_branch or "main"
        base_ref = _resolve_diff_base(worktree, base)
        if base_ref is None:
            raise ReviewDiffUnavailableError(
                f"no diff base ref: neither 'origin/{base}' nor '{base}' "
                f"resolves in worktree {worktree}"
            )
        try:
            proc = subprocess.run(
                ["git", "diff", f"{base_ref}...HEAD"],
                cwd=str(worktree),
                capture_output=True,
                text=True,
                # See the gh-path comment: diffs are arbitrary bytes; never
                # let a non-UTF-8 hunk strict-decode into a crash.
                errors="replace",
                check=False,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError) as exc:
            raise ReviewDiffUnavailableError(f"git diff in worktree failed: {exc!r}") from exc
        if proc.returncode != 0:
            raise ReviewDiffUnavailableError(
                f"git diff {base_ref}...HEAD exited rc={proc.returncode}; "
                f"stderr_tail={proc.stderr.strip()[-200:]!r}"
            )
        diff_text = proc.stdout or ""

    if not diff_text.strip():
        return ""
    if len(diff_text) > _PR_DIFF_CAP_BYTES:
        diff_text = diff_text[:_PR_DIFF_CAP_BYTES] + "\n...[truncated at 64KB]"
    return diff_text


def _changed_files_for_story(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
) -> list[str] | None:
    """Return the branch's REAL changed-file list, or ``None`` if it cannot be
    computed (worktree GC'd, git error, timeout).

    Uses ``git diff --name-only <base_ref>...HEAD`` inside the per-story
    worktree — the SAME merge-base semantics AND the same
    ``origin/<base>`` → local ``<base>`` fallback (``_resolve_diff_base``)
    ``_fetch_pr_diff_for_review`` uses on its pre-PR path — so the
    docs-enforcer's vacuous-diff guard and the reviewer agree on what the
    branch changed. The enforcer runs before PR creation in the
    normal chain (pr_number is None), so they match in practice; once a PR
    exists the reviewer switches to ``gh pr diff`` (the remote PR), which can
    differ from the local worktree HEAD.

    Returning ``None`` (never ``[]``) on failure lets the caller distinguish
    "no diff available, fall back to declared paths" from "the branch genuinely
    changed nothing" (``[]``, which the vacuous-diff guard blocks).
    """
    import subprocess

    try:
        worktree = _writing_worktree(app_config, software_factory_root, story)
    except Exception:  # noqa: BLE001 - any worktree resolution failure → fall back
        return None
    base = app_config.default_branch or "main"
    # Same origin/<base> → local <base> fallback as _fetch_pr_diff_for_review,
    # so the docs-enforcer and the reviewer keep agreeing on what changed even
    # in a worktree with no ``origin`` remote.
    base_ref = _resolve_diff_base(worktree, base)
    if base_ref is None:
        return None
    try:
        proc = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            # Filenames are arbitrary bytes too (git quotes non-UTF-8 paths,
            # but never rely on it): tolerate, don't strict-decode-crash.
            errors="replace",
            check=False,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError):
        return None
    if proc.returncode != 0:
        return None
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def _assert_no_broken_prompt_markers(full_prompt: str, *, where: str) -> None:
    """Sanity guard — raise if a literal placeholder leaked into the prompt.

    See ``_BROKEN_PROMPT_MARKERS`` for the list. Raised as ``RuntimeError``
    so the orchestrator's normal error handling captures + logs the failure
    instead of silently feeding an inert prompt to the LLM.
    """
    for marker in _BROKEN_PROMPT_MARKERS:
        if marker in full_prompt:
            raise RuntimeError(
                f"{where} produced a prompt containing broken plumbing marker "
                f"{marker!r}; check that PR diff and test output fetches "
                f"actually executed."
            )


def _empty_diff_review_result(story: StoryRecord) -> dict[str, Any]:
    """Deterministic request_changes for a branch whose fetched diff is EMPTY.

    A reviewer cannot approve zero commits, so we never spend a model call on
    an empty diff (the old behaviour embedded "(diff is empty …)" as the
    prompt's diff section — and the model could, and in mocked tests did,
    APPROVE it). The confirmed-empty case (real dev attempt + clean worktree)
    is blocked earlier by the ``_dev_produced_empty_diff`` short-circuit; what
    reaches here is the "give dev another chance" remainder — most commonly
    real, test-passing work left UNCOMMITTED in the worktree (the dev agent is
    only INSTRUCTED to commit, not forced; see ``_dev_produced_empty_diff``).
    The synthetic finding routes back to dev with an explicit instruction.
    Deliberately bounded: the constant findings text gives an identical
    ``_findings_signature`` and the frozen 0.0 score never improves, so the
    stuck + non-improving guards block the story on the second occurrence —
    this path can never churn to the hard cap.
    """
    return {
        "verdict": "request_changes",
        "summary": (
            "empty diff: the branch has no committed changes beyond its base. "
            "A reviewer cannot approve zero commits. If real work exists in "
            "the worktree it was never committed — commit it."
        ),
        "findings": [
            {
                "severity": "high",
                "criterion": "completeness",
                "location": "",
                "what": (
                    "empty diff: no committed changes on this branch beyond "
                    "its base — commit the work (uncommitted files do not ship)"
                ),
            }
        ],
        "test_quality_findings": [],
        "test_quality_score": 0.0,
        "comments_to_post": [],
        "empty_diff_precondition": True,
    }


def _block_on_unavailable_diff(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    persona: str,
    reason: str,
    db: Path,
    github_client: Any = None,
) -> HandlerResult:
    """Route a story whose diff could not be fetched to the blocked sink.

    FAIL-CLOSED hard-precondition handling shared by ``handle_review`` and
    ``handle_tech_writer``: the model is never called, ``reviewer_cycles`` is
    never incremented (this is an infra failure, not a review verdict), and
    the story lands in ``BLOCKED_REVIEW_NONCONVERGENT`` — the same
    human-visible sink the empty-diff short-circuit and the convergence guard
    use. From there the bounded blocked-story auto-recovery
    (``orchestrator._AUTO_RECOVERABLE_STATES``) re-enters the chain at
    ``SM_DONE`` for transient causes (gh auth expiry, rate limit), and a
    persistent cause surfaces to the operator (``last_rejection_reason`` puts
    it in ``factory inbox``; the stalled-stories detector sees the state).
    """
    full_reason = f"{persona} diff precondition failed (fail-closed): {reason}"
    story.state = advance(story, EVENT_REVIEW_NONCONVERGENT).value
    story.error = full_reason
    # Surfaces the story in the `factory inbox` "Needs human action" table,
    # which keys off last_rejection_reason for states outside its small
    # state allowlist.
    story.last_rejection_reason = full_reason
    result: dict[str, Any] = {
        "verdict": "request_changes",
        "summary": full_reason,
        "findings": [],
        "test_quality_findings": [],
        "test_quality_score": 0.0,
        "comments_to_post": [],
        "review_diff_unavailable": True,
    }
    if persona == "reviewer":
        # Keep the review record honest for dev plumbing. tech_writer must
        # NOT overwrite reviewer_result_json — it holds the real approve.
        # Deliberately NOT appended to reviewer_history_json: this is an
        # infra failure, not a review verdict, and a synthetic 0.0-score
        # history entry would make the next REAL rejection trivially count
        # as "improving" in the non-improving-score guard (one wasted cycle).
        story.reviewer_result_json = json.dumps(result)
    persist_story(story, db)
    log_story_event(
        story.id,
        "review_diff_unavailable",
        {
            "persona": persona,
            "reason": reason[:500],
            "branch": story.github_branch,
            "pr_number": story.github_pr_number,
            "reviewer_cycles": story.reviewer_cycles,
        },
        software_factory_root=software_factory_root,
        slug_hint=story.slug,
    )
    if github_client is not None and story.github_pr_number is not None:
        try:  # pragma: no cover - real-run path
            repo = github_client.get_repo(app_config.repo)
            pr = repo.get_pull(story.github_pr_number)
            pr.add_to_labels("review-nonconvergent")
            pr.create_issue_comment(
                f"⚠️ Diff precondition failed for {persona}: {reason}. "
                f"Failing CLOSED (no blind review) and routing to "
                f"{StoryState.BLOCKED_REVIEW_NONCONVERGENT.value}."
            )
        except Exception:  # pragma: no cover - real-run path
            pass
    return HandlerResult(next_state=StoryState(story.state), payload=result, error=story.error)


def _dry_run_review(story: StoryRecord) -> dict[str, Any]:
    return {
        "verdict": "approve",
        "findings": [],
        "test_quality_score": 0.92,
        "test_quality_findings": [],
        "comments_to_post": [],
        "summary": "Dry-run reviewer: approve.",
    }


# Where the slop detector's diff starts, in priority order.
#
# ``swebench-base`` is FIRST because it is the only correct answer inside the
# benchmark, and the old list did not contain it. A bench worktree is a
# ``--depth 1`` clone with the harness's own commits on top, so ``origin/main`` /
# ``main`` are the upstream project's refs and ``HEAD~1`` is whatever commit
# happens to precede the tip. Measured cost on sweep 2: the detector diffed from
# the wrong base on `alibaba__opensandbox-816`, scored PRE-EXISTING UPSTREAM test
# files as slop, and clamped an explicit reviewer `approve` into a nonconvergence
# park — a $4, 17-minute rework cycle against the reviewer's judgement.
#
# ``HEAD~1`` is kept LAST rather than removed: on the live chain a story branch
# with one commit and no reachable main is exactly the case it covers. It is now
# a last resort instead of the third of three.
_SLOP_BASE_REF_CANDIDATES = ("swebench-base", "origin/main", "main", "HEAD~1")


def _resolve_base_ref(worktree: Path) -> str | None:
    """The first of ``_SLOP_BASE_REF_CANDIDATES`` that resolves in ``worktree``.

    Shared by the slop detector and the production-delta gate so "what is this
    branch's base" has exactly one answer. ``swebench-base`` is first — inside the
    benchmark it is the only correct one.
    """
    from factory.chain.branch import _run_git

    for candidate in _SLOP_BASE_REF_CANDIDATES:
        try:
            _run_git(worktree, "rev-parse", "--verify", candidate)
            return candidate
        except Exception:  # noqa: BLE001 — try the next candidate
            continue
    return None


def _branch_has_production_delta(
    story: StoryRecord, app_config: AppConfig, software_factory_root: Path
) -> bool | None:
    """Does this story's BRANCH change at least one non-test file?

    ``True`` yes, ``False`` confirmed no, ``None`` could not determine.

    Deliberately three-valued, and the caller must only act on ``False``. A green
    test run with no production change proves nothing; a green test run we could
    not verify is still a green, and blocking it would trade a rare false green
    for a systematic false red. The first cut of this gate asked the per-attempt
    ``files_changed`` question instead and blocked two stories that had already
    landed real, green fixes — see the call site.
    """
    try:
        worktree = _writing_worktree(app_config, software_factory_root, story)
        base_ref = _resolve_base_ref(worktree)
        if base_ref is None:
            return None
        paths = _story_authored_paths(worktree, base_ref)
        if paths is None:
            return None
        if not paths:
            return False
        return any(not _diff_paths.is_test_path(p) for p in paths)
    except Exception:  # noqa: BLE001 — an unverifiable delta must not fail the story
        return None


def _story_authored_paths(worktree: Path, base_ref: str) -> set[str] | None:
    """Paths whose CONTENT this branch changed since ``base_ref``.

    Measured by ``git diff --numstat``, not ``--diff-filter``: git reports a pure
        MODE change as ``M`` (modified), so no filter letter separates it — only the
        line counts do, and a mode-only change is ``0\t0\tpath``. That distinction is
        load-bearing here: the bench's 0444 test-file lock injects
        ``100755 -> 100644`` flips the dev cannot revert, and they were the single
        largest consumer of reviewer attention in sweep 2 (9 of 40 findings).

        Returns ``None`` when git cannot answer, which the caller reads as "no scope
        information available" and leaves the file list untouched — narrowing on a
        failed read would silently disable the detector.
    """
    try:
        from factory.chain.branch import _run_git

        # ``--no-renames`` is load-bearing. With rename detection ON, git emits a
        # detected rename as ONE compressed numstat row —
        # ``3  1  backend/tests/{test_auth.py => test_auth_email.py}`` — while
        # ``find_test_files_in_diff`` uses ``--name-only`` and yields the NEW path
        # alone. The two never intersect, so a renamed-and-edited test file is
        # silently dropped from the scan. Executed: a renamed test containing
        # ``assert True`` scanned to a real SlopFinding but the intersection was
        # empty. The slop detector is a hard veto that can override an LLM
        # ``approve``, so that is fail-OPEN on a documented fail-safe — and if the
        # story's only touched test file was renamed, the veto is fully disabled
        # for that story. ``--no-renames`` emits the old and new paths as separate
        # rows, and the new path carries the added lines.
        out = _run_git(worktree, "diff", "--numstat", "--no-renames", base_ref).stdout
    except Exception:  # noqa: BLE001 — an unreadable diff must not disable the scan
        return None
    authored: set[str] = set()
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added, deleted, path = parts[0], parts[1], parts[-1].strip()
        if not path:
            continue
        if added == "-" or deleted == "-":
            # Binary: no line counts to reason about. Count it as authored — a
            # binary test file is unusual, and guessing "not authored" would
            # silently exempt it from the scan.
            authored.add(path)
            continue
        if (added, deleted) == ("0", "0"):
            # No content change. A pure MODE flip lands here, and that is the
            # whole point: git reports a mode change as `M`, so --diff-filter
            # cannot separate it (the first cut of this used ACMR and a test
            # caught it). numstat can.
            continue
        authored.add(path)
    return authored


def _slop_findings_for_story(
    story: StoryRecord, app_config: AppConfig, software_factory_root: Path
) -> list[dict[str, Any]]:
    """Programmatically scan the dev-written test files for slop anti-patterns.

    Loop-4 backstop for the dev-owns-tests model: scans the test files this
    story's branch changed (relative to ``origin/main``) with the pure
    ``slop_detector``. Returns a list of ``test_quality_findings``-shaped dicts
    (empty when clean). Defensive: any git/IO failure returns ``[]`` so a
    transient infra problem never blocks a review — the LLM reviewer remains
    the primary judge; this only ADDS deterministic vetoes, never removes them.
    """
    try:
        from factory.chain.branch import find_test_files_in_diff
        from factory.chain.slop_detector import scan_file

        worktree = _writing_worktree(app_config, software_factory_root, story)
        base_ref = None
        for candidate in _SLOP_BASE_REF_CANDIDATES:
            try:
                from factory.chain.branch import _run_git

                _run_git(worktree, "rev-parse", "--verify", candidate)
                base_ref = candidate
                break
            except Exception:
                continue
        if base_ref is None:
            return []
        test_paths = find_test_files_in_diff(worktree, base_ref=base_ref)
        # SCOPE: only files this story's own diff CHANGED may be scored. Even
        # with the right base ref, ``find_test_files_in_diff`` is a diff read, and
        # a diff can list a file for reasons that are not authorship — a mode
        # flip, a rename, a merge bringing upstream tests along. Scoring a file
        # the dev did not write means demanding the dev fix somebody else's test,
        # which it cannot do and which the reviewer then re-raises every cycle.
        # Intersect with the files git says have CONTENT changes attributable to
        # this branch.
        authored = _story_authored_paths(worktree, base_ref)
        if authored is not None:
            test_paths = [rel for rel in test_paths if rel in authored]
        findings: list[dict[str, Any]] = []
        for rel in test_paths:
            for f in scan_file(worktree / rel):
                findings.append(
                    {
                        "test_name": f"{f.path}:{f.line}",
                        "issue": f"slop: {f.kind} — {f.why_slop}",
                        "fix_suggestion": (
                            "Replace this with an assertion on the real behavior "
                            "of the code under test. Make the test fail against an "
                            "absent/empty implementation first, then pass."
                        ),
                        "code_excerpt": f.code_excerpt,
                    }
                )
        return findings
    except Exception:  # pragma: no cover - defensive; never block on infra
        return []


def handle_review(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    fixture: dict[str, Any] | None = None,
    github_client: Any = None,
) -> HandlerResult:
    """Run the Reviewer persona; post inline PR comments; transition state.

    ``fixture`` lets tests inject a specific reviewer JSON (e.g. a
    low-test-quality-score scenario).
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    story.state = advance(story, EVENT_REVIEWER_STARTED).value
    persist_story(story, db)

    # Empty-diff short-circuit. Real (non-fixture, non-dry-run) reviews only:
    # fixture-driven and dry-run tests never touch git and must be
    # completely unaffected. When a REAL dev attempt has already run
    # (``_has_real_dev_attempt``) and the branch's diff against its base is
    # CONFIRMED empty (``_dev_produced_empty_diff`` returns True, never on
    # an unknown/error result), the dev produced no changes at all.
    # Continuing into the normal review flow would waste an LLM call only to
    # have the reviewer correctly reject it, then churn a full
    # request_changes cycle, repeating up to ``_MAX_REVIEW_CYCLES`` times
    # before blocking (observed: D092/D094 each burned ~6 empty-diff cycles).
    # Escalate straight to the terminal blocked state on the FIRST
    # occurrence instead.
    if fixture is None and not dry_run and _has_real_dev_attempt(story):
        empty_diff = _dev_produced_empty_diff(story, app_config, software_factory_root)
        # CONSULT THE RETRY BUDGET FIRST. Going terminal on the first empty diff
        # is right only when there is nothing left to try — and it was firing with
        # the budget untouched. Measured on sweep 2: `conan-io__conan-19750` had
        # its analysis-only first turn truncated by Azure 429s, produced no diff,
        # and short-circuited to a terminal block with FOUR UNUSED RETRIES. The
        # dev had already located the gold site.
        #
        # With headroom, an empty diff is a red attempt: send it back through
        # ``dev_retry`` (which carries the prior-attempt memory forward) instead of
        # ending the story. The original reasoning — do not churn review cycles on
        # an empty diff — is preserved exactly, because this is not a review cycle:
        # the reviewer is still never called on an empty diff.
        # BOUNDED BY reviewer_cycles, NOT ONLY BY dev_retries.
        #
        # The first cut gated on `story.dev_retries + 1 < _max_dev_retries()` and
        # claimed in its own comment that "the review-cycle cap and the stability
        # guard still bound it". NEITHER DID, and an adversarial review reproduced
        # 12 unbounded cycles:
        #
        #   `dev_retries` is incremented only on the RED path (see the green
        #   return above it). A story only reaches `handle_review` via
        #   EVENT_DEV_TESTS_GREEN, so a dev run that goes GREEN while changing
        #   nothing leaves `dev_retries` at 0 — and `0 + 1 < 4` is true forever.
        #   Cycle: reviewer_in_progress -> request_changes -> dev -> tests_green ->
        #   reviewer_in_progress, one dev sandbox run each (live median 644 s,
        #   ~$0.35), until `per_story_spend_usd: 12.0` trips into
        #   BLOCKED_BUDGET_EXCEEDED — a sink `factory resume` REFUSES, and which
        #   emits no `factory_needs_redesign` event at all.
        #
        # That is strictly worse than the terminal block it replaced, which fired
        # once and left an actionable event. And the trigger is already in the
        # tree: direction 126 asks for a password reset that
        # `sacrifice/backend/app/routes/auth.py` already implements.
        #
        # So count the cycle and cap it at `_MAX_REVIEW_CYCLES` — the guard the
        # comment always claimed. Three empty-diff round-trips, then the terminal
        # block with its `factory_needs_redesign` event, as before.
        if (
            empty_diff is True
            and story.dev_retries + 1 < _max_dev_retries(software_factory_root)
            and story.reviewer_cycles + 1 < _MAX_REVIEW_CYCLES
        ):
            # Back to dev via ``reviewer_request_changes`` — the chain's existing
            # "dev, do more work" route. Deliberately NOT a new transition: from
            # ``reviewer_in_progress`` the legal events are approve /
            # request_changes / nonconvergent, and inventing a fourth to reach
            # ``dev_retry`` would add an edge to a 32-state machine to serve one
            # branch. (The first cut of this DID emit ``dev_tests_red`` from here
            # and raised ``IllegalTransitionError``; the existing
            # ``test_empty_diff_short_circuit`` tests caught it.)
            #
            # The original reason for the short-circuit is preserved in full: the
            # reviewer LLM is NEVER CALLED on an empty diff. What the D092/D094
            # churn cost was six review MODEL calls, not six counter increments,
            # and this path makes zero. The review-cycle cap and the stability
            # guard still bound it.
            reason = (
                f"Dev attempt {story.dev_retries} produced an EMPTY DIFF — the "
                "working tree is unchanged, so there is nothing to review. Retry "
                f"budget remains ({story.dev_retries}/"
                f"{_max_dev_retries(software_factory_root)}), so this goes back to "
                "dev rather than ending the story."
            )
            result = {
                "verdict": "request_changes",
                "summary": reason,
                "findings": [
                    {
                        "severity": "high",
                        "criterion": "correctness",
                        "location": "(whole diff)",
                        "what": "The diff is empty: no file was changed.",
                        "fix_suggestion": (
                            "Make the edit in the working tree. The chain reads "
                            "`git diff`, not your summary — describing a change "
                            "does not apply it."
                        ),
                        "regression": False,
                    }
                ],
                "test_quality_findings": [],
                "test_quality_score": 0.0,
                "empty_diff_dev_retry": True,
            }
            story.state = advance(story, EVENT_REVIEWER_REQUEST_CHANGES).value
            story.error = None
            # Count it. Without this the loop is unbounded (see above) AND the
            # synthetic entries below evict real reviewer memory:
            # `_REVIEWER_HISTORY_MAX_CYCLES` is 4, so four silent cycles would
            # flush every genuine prior finding out of the history section that
            # enforces review finality.
            story.reviewer_cycles += 1
            story.reviewer_result_json = json.dumps(result)
            _append_reviewer_history(story, result)
            persist_story(story, db)
            log_story_event(
                story.id,
                "empty_diff_dev_retry",
                {
                    "dev_retries": story.dev_retries,
                    "cap": _max_dev_retries(software_factory_root),
                    "reviewer_cycles": story.reviewer_cycles,
                    "reviewer_cycles_cap": _MAX_REVIEW_CYCLES,
                    "reviewer_called": False,
                    "reason": (
                        "empty diff with retry headroom — back to dev instead of a "
                        "terminal block; the reviewer LLM is still not called"
                    ),
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            return HandlerResult(
                next_state=StoryState(story.state),
                payload={"empty_diff_dev_retry": True, "summary": reason},
                error=None,
            )
        if empty_diff is True:
            reason = (
                f"empty diff after dev attempt {story.dev_retries} — the dev "
                "produced no changes; escalating instead of churning review "
                "cycles; likely an un-doable-by-sandbox (runtime/operational) "
                "task or a malformed story."
            )
            story.state = advance(story, EVENT_REVIEW_NONCONVERGENT).value
            story.error = reason
            result = {
                "verdict": "request_changes",
                "summary": reason,
                "findings": [],
                "test_quality_findings": [],
                "test_quality_score": 0.0,
                "empty_diff_short_circuit": True,
            }
            story.reviewer_result_json = json.dumps(result)
            _append_reviewer_history(story, result)
            persist_story(story, db)
            log_story_event(
                story.id,
                "factory_needs_redesign",
                {
                    "kind": "empty_diff_short_circuit",
                    "dev_retries": story.dev_retries,
                    "reviewer_cycles": story.reviewer_cycles,
                    "branch": story.github_branch,
                    "suggestions": [
                        "Dev produced an empty diff after a real attempt — "
                        "likely a task that isn't doable by a code sandbox "
                        "(a runtime/operational task) or a malformed story. "
                        "Investigate before re-dispatching; do not just "
                        "retry the same chain.",
                    ],
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            if not dry_run and github_client is not None and story.github_pr_number is not None:
                try:
                    repo = github_client.get_repo(app_config.repo)
                    pr = repo.get_pull(story.github_pr_number)
                    pr.add_to_labels("review-nonconvergent")
                    pr.create_issue_comment(
                        "⚠️ Empty-diff short-circuit: the dev produced no "
                        "changes on this branch. Routing directly to "
                        f"{StoryState.BLOCKED_REVIEW_NONCONVERGENT.value} "
                        "instead of churning review cycles."
                    )
                except Exception:  # pragma: no cover - real-run path
                    pass
            return HandlerResult(
                next_state=StoryState(story.state), payload=result, error=story.error
            )

    if fixture is not None:
        result = fixture
    elif dry_run:
        result = _dry_run_review(story)
    else:
        # FAIL-CLOSED diff precondition. Fetched BEFORE any prompt assembly or
        # model call: an unavailable diff must never be reviewed around (the
        # old fail-open behaviour fed the fetch's error text to the model as
        # the diff, and every blind "I cannot see the diff" rejection bought a
        # ~45x more expensive dev rework cycle).
        try:
            pr_diff = _fetch_pr_diff_for_review(story, app_config, software_factory_root)
        except ReviewDiffUnavailableError as exc:
            return _block_on_unavailable_diff(
                story,
                app_config,
                software_factory_root,
                persona="reviewer",
                reason=exc.reason,
                db=db,
                github_client=github_client,
            )
        if not pr_diff.strip():
            # Empty diff: never call the model — a reviewer cannot approve
            # zero commits. Deterministic request_changes that flows through
            # the normal verdict machinery below (cycle count, stuck +
            # non-improving guards), so it stays bounded.
            result = _empty_diff_review_result(story)
        else:
            from factory.app_config import resolve_app_repo_path
            from factory.context.loader import compose_context_prelude
            from factory.directions.parser import get_direction_chain
            from factory.runner import text_run

            persona = "reviewer"
            persona_prompt = _read_persona_prompt(persona)
            direction = find_direction_for_story(story, software_factory_root)
            chain = (
                get_direction_chain(direction, software_factory_root)
                if direction is not None
                else None
            )
            prelude = compose_context_prelude(
                persona=persona,
                app_repo_path=resolve_app_repo_path(app_config, software_factory_root),
                task_scope=story.scope,
                direction_chain=chain,
                software_factory_root=software_factory_root,
            )
            story_content = _read_story_file_content(story, software_factory_root)
            fresh_test_output = _fetch_latest_test_output(story, software_factory_root)
            dev_self_summary = _fetch_latest_dev_self_summary(story)
            rcaps = (
                "## App test capabilities (HONOR when judging test choices)\n\n"
                f"* `e2e_harness_ready`: {str(app_config.gates.e2e_harness_ready).lower()}\n"
                "* If false, this app has NO runnable Playwright/browser harness. Do "
                "NOT require Playwright/E2E and do NOT flag a finding because a smoke/"
                "flow test was written as pytest/httpx instead of Playwright — that "
                "is the CORRECT choice here, and a backend test that covers the "
                "behavior fully satisfies the acceptance criterion. Treat any stray "
                "Playwright config/spec or 'playwright not wired' as NON-blocking "
                "(`low`), never `medium`/`high`.\n\n"
            )
            history_section = _render_reviewer_history_section(story)
            full_prompt = (
                f"{persona_prompt.rstrip()}\n\n"
                "---\n\n"
                "## Context\n\n"
                f"{prelude.rstrip()}\n\n"
                f"{rcaps}" + (f"{history_section}\n\n" if history_section else "") + "## Story\n\n"
                f"{story_content}\n\n"
                "## Test plan\n\n"
                f"{story.test_plan_json or '{}'}\n\n"
                "## Latest test output\n\n"
                f"{fresh_test_output}\n\n"
                "## DEV SELF-SUMMARY (dev's own unverified claims, including "
                "which precedent it followed)\n\n"
                f"{dev_self_summary}\n\n"
                "## PR diff\n\n"
                f"{pr_diff}\n\n"
                "Return the JSON object for the review. No prose outside the JSON."
            )
            _assert_no_broken_prompt_markers(full_prompt, where="handle_review")
            model_id = _route_for(story, persona)
            result_any = text_run(
                persona=persona,
                prompt=full_prompt,
                model_id=model_id,
                schema=None,  # reviewer output is JSON but we don't enforce schema here
                max_tokens=max_output_tokens_for(model_id),
                story_id=story.id,
                app=story.app,
                direction_id=story.direction_id,
                db_path=db,
            )
            result = _parse_reviewer_result(result_any)

    story.reviewer_result_json = json.dumps(result)

    # Post inline comments (real-run only).
    if not dry_run and github_client is not None and story.github_pr_number is not None:
        try:
            repo = github_client.get_repo(app_config.repo)
            pr = repo.get_pull(story.github_pr_number)
            for c in result.get("comments_to_post") or []:
                # Inline comment requires commit_sha, path, position; we
                # use a simpler issue comment in Phase 2 as fallback.
                pr.create_issue_comment(
                    f"**Reviewer note** ({c.get('file')}:{c.get('line')}):\n\n{c.get('body')}"
                )
        except Exception:  # pragma: no cover - real-run path
            pass

    verdict = result.get("verdict", "request_changes")
    score = float(result.get("test_quality_score", 0.0))

    # Loop-4 programmatic slop gate. The dev now writes its own tests, so a
    # deterministic scan of the changed test files is the backstop against the
    # classic failure mode (tautological / assert-True / mock-only tests that
    # pass before any real implementation). This runs BEFORE the approve check
    # and can veto an LLM "approve": slop is a hard block routed back to dev.
    # Runs on every real review (dry_run unit tests pass dry_run=True, and the
    # helper returns [] defensively when there is no worktree to scan).
    if not dry_run:
        slop_findings = _slop_findings_for_story(story, app_config, software_factory_root)
        if slop_findings:
            verdict = "request_changes"
            score = min(score, 0.3)
            result["verdict"] = "request_changes"
            result["test_quality_score"] = score
            result.setdefault("test_quality_findings", [])
            result["test_quality_findings"].extend(slop_findings)
            result["slop_detector_findings"] = slop_findings
            story.reviewer_result_json = json.dumps(result)

    # Finality drift clamp. At cycle 3+, blocking findings that share NO file
    # location with the previous cycle's findings AND are not marked
    # ``regression: true`` violate the persona's finality rule (new objections
    # to code that was already in front of the reviewer). Rotating fresh
    # objections each cycle is exactly how benchmark t3/t8 burned 6 cycles
    # without shipping. Clamp such findings to ``low`` (non-blocking); if
    # nothing blocking remains and the score clears the bar, the verdict
    # flips to approve. Slop-detector findings are never clamped (they are
    # deterministic, not reviewer drift).
    if verdict != "approve" and story.reviewer_cycles >= 2:
        try:
            history = json.loads(story.reviewer_history_json or "[]")
        except (json.JSONDecodeError, TypeError):
            history = []
        prev = history[-1] if history else None
        if prev:
            prev_locs = {
                _finding_location_file(f)
                for f in (prev.get("findings") or []) + (prev.get("test_quality_findings") or [])
            } - {""}
            slop_ids = {id(f) for f in (result.get("slop_detector_findings") or [])}
            clamped: list[dict[str, Any]] = []
            for f in result.get("findings") or []:
                if not isinstance(f, dict) or id(f) in slop_ids:
                    continue
                blocking = f.get("severity") in ("medium", "high")
                is_regression = bool(f.get("regression"))
                known_site = _finding_location_file(f) in prev_locs
                if blocking and not is_regression and not known_site:
                    f["severity"] = "low"
                    f["finality_clamped"] = True
                    clamped.append(f)
            if clamped:
                still_blocking = any(
                    isinstance(f, dict) and f.get("severity") in ("medium", "high")
                    for f in result.get("findings") or []
                ) or bool(result.get("slop_detector_findings"))
                log_story_event(
                    story.id,
                    "reviewer_finality_clamped",
                    {
                        "cycle": story.reviewer_cycles + 1,
                        "clamped": [
                            {"location": f.get("location"), "what": (f.get("what") or "")[:160]}
                            for f in clamped
                        ],
                        "approved_after_clamp": not still_blocking and score >= 0.7,
                    },
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
                if not still_blocking and score >= 0.7:
                    verdict = "approve"
                    result["verdict"] = "approve"
                    result["finality_clamp_applied"] = True
                story.reviewer_result_json = json.dumps(result)

    if verdict == "approve" and score >= 0.7:
        story.state = advance(story, EVENT_REVIEWER_APPROVE).value
    else:
        # Convergence guard based on finding STABILITY. A cycle whose findings
        # differ from the last is progress; only identical findings repeating
        # _MAX_REVIEW_STUCK times is true churn. A hard backstop on total cycles
        # prevents a slowly-mutating loop from running unbounded.
        story.reviewer_cycles += 1
        sig = _findings_signature(result)
        from factory.chain.event_log import read_story_events

        consecutive_same = 1  # this cycle
        for e in reversed(
            read_story_events(
                story.id, software_factory_root=software_factory_root, slug_hint=story.slug
            )
        ):
            if e.get("event") != "reviewer_cycle":
                continue
            if e.get("sig") == sig:
                consecutive_same += 1
            else:
                break
        stuck = consecutive_same >= _MAX_REVIEW_STUCK
        # Non-improving-score early exit. Review cycles are supposed to buy
        # convergence; a score that fails to IMPROVE between consecutive
        # rejecting cycles means more cycles are buying expensive wrong
        # answers (2026-07-31 benchmark trajectories were flat/declining:
        # 0.45→0.35→0.40). Compare against the PREVIOUS cycle's recorded
        # score (reviewer_history_json — this cycle is appended later), and
        # fire strictly BELOW the _MAX_REVIEW_CYCLES hard cap (at cycle 2, cap
        # 3) or the guard would be unreachable. This lives inside the
        # non-approve branch, so it can only ever route to the blocked sink —
        # NEVER to approved.
        prev_score: float | None = None
        try:
            _hist = json.loads(story.reviewer_history_json or "[]")
        except (json.JSONDecodeError, TypeError):
            _hist = []
        if _hist and isinstance(_hist[-1], dict):
            _raw_prev = _hist[-1].get("score")
            if isinstance(_raw_prev, (int, float)):
                prev_score = float(_raw_prev)
        non_improving = (
            story.reviewer_cycles >= 2 and prev_score is not None and score <= prev_score
        )
        log_story_event(
            story.id,
            "reviewer_cycle",
            {
                "sig": sig,
                "cycle": story.reviewer_cycles,
                "consecutive_same": consecutive_same,
                "score": score,
                "prev_score": prev_score,
                "non_improving": non_improving,
            },
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )
        # Mirror the per-story event into the replayable chain_step stream —
        # same reason as the dev-retry emit above: review cycles turn inside a
        # single handler invocation and never reached ``emit_chain_step``.
        # Emitted after the stability computation so the row carries the two
        # facts that explain the cycle (``consecutive_same``, ``stuck``), not
        # merely that one happened.
        emit_chain_step(
            story,
            handler="review",
            from_state=story.state,
            to_state=story.state,
            outcome="review_cycle",
            software_factory_root=software_factory_root,
            extra={
                "retry_attempt": story.reviewer_cycles,
                "retry_cap": _MAX_REVIEW_CYCLES,
                "consecutive_same": consecutive_same,
                "stuck_cap": _MAX_REVIEW_STUCK,
                "stuck": stuck,
                "score": score,
                "prev_score": prev_score,
                "non_improving": non_improving,
            },
        )
        if stuck or non_improving or story.reviewer_cycles >= _MAX_REVIEW_CYCLES:
            story.state = advance(story, EVENT_REVIEW_NONCONVERGENT).value
            if stuck:
                reason = f"same findings repeated {consecutive_same}x (stuck)"
            elif non_improving:
                reason = (
                    f"review score did not improve between consecutive cycles "
                    f"({prev_score} -> {score})"
                )
            else:
                reason = f"hit hard cap of {_MAX_REVIEW_CYCLES} cycles"
            story.error = (
                f"Review did not converge ({reason}); routed to "
                f"{StoryState.BLOCKED_REVIEW_NONCONVERGENT.value} for human review."
            )
            if not dry_run and github_client is not None and story.github_pr_number is not None:
                try:
                    repo = github_client.get_repo(app_config.repo)
                    pr = repo.get_pull(story.github_pr_number)
                    pr.add_to_labels("review-nonconvergent")
                    pr.create_issue_comment(
                        f"⚠️ Convergence guard: this PR has been through "
                        f"{story.reviewer_cycles} reviewer cycles without "
                        f"approval (max {_MAX_REVIEW_CYCLES}). The dev↔reviewer "
                        f"loop is not converging; routing to human review "
                        f"instead of dispatching dev again."
                    )
                except Exception:  # pragma: no cover - real-run path
                    pass
        else:
            # Loop-4: dev owns BOTH code and tests, so every actionable
            # rejection — code defects AND test-quality/slop findings — routes
            # back to dev. There is no longer a separate test author to route a
            # test-quality finding to. dev's prompt receives both ``findings``
            # and ``test_quality_findings`` (see handle_dev's reviewer_findings
            # plumbing), so it knows what to fix in code and in tests.
            story.state = advance(story, EVENT_REVIEWER_REQUEST_CHANGES).value
            if not dry_run and github_client is not None and story.github_pr_number is not None:
                try:
                    repo = github_client.get_repo(app_config.repo)
                    pr = repo.get_pull(story.github_pr_number)
                    pr.add_to_labels("needs-changes")
                except Exception:  # pragma: no cover - real-run path
                    pass

    # Record this cycle in the review history (post-clamp, so the next
    # cycle's reviewer prompt and drift clamp see what was ACTUALLY ruled).
    _append_reviewer_history(story, result)
    persist_story(story, db)
    return HandlerResult(next_state=StoryState(story.state), payload=result)


# --------------------------------------------------------------------------- #
# tech_writer
# --------------------------------------------------------------------------- #

# S3 (019 fail-silent audit): a JSON parse failure used to persist
# ``{"context_updates": [], "rationale": "tech_writer JSON parse failed"}`` —
# a result the ``docs-current`` REQUIRED gate can never satisfy (that string
# matches none of the gate's legacy literal phrases), permanently stranding
# the story. Retry the model call INLINE (same handler invocation, no extra
# tick) before giving up. Strictly below the hard cap of 3 chain-level
# retries used elsewhere (``_MAX_DEV_RETRIES`` / ``_MAX_REVIEW_CYCLES``).
_MAX_TECH_WRITER_PARSE_RETRIES = 2


def _dry_run_tech_writer(story: StoryRecord) -> dict[str, Any]:
    """Deterministic tech_writer result for dry-run mode."""
    return {
        "context_updates": [
            {
                "path": f"context/modules/{story.scope}.md",
                "action": "rewrite",
                "content": (
                    f"# {story.scope} module\n\nUpdated to reflect story `{story.slug}`.\n"
                ),
            }
        ],
        "rationale": "Dry-run tech_writer: minimal context refresh.",
    }


def handle_tech_writer(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    fixture: dict[str, Any] | None = None,
) -> HandlerResult:
    """Run the Tech-Writer persona; apply context updates to the app repo.

    Entered from ``REVIEWER_DONE`` (chain) or, for a SOLO story only, directly
    from ``TESTS_GREEN`` (no reviewer round-trip; see factory/chain/solo.py).
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    if StoryState(story.state) is StoryState.TESTS_GREEN:
        from factory.chain.solo import is_solo

        if not is_solo(story):
            # Fail SAFE: the TESTS_GREEN → tech_writer edge exists for solo
            # stories only. A chain story must never skip its reviewer.
            raise IllegalTransitionError(
                f"story {story.id}: tech_writer from tests_green is solo-only "
                f"(pipeline={getattr(story, 'pipeline', None)!r})"
            )
    story.state = advance(story, EVENT_TECH_WRITER_STARTED).value
    persist_story(story, db)

    if fixture is not None:
        result = fixture
    elif dry_run:
        result = _dry_run_tech_writer(story)
    else:
        from factory.app_config import resolve_app_repo_path
        from factory.context.loader import compose_context_prelude
        from factory.directions.parser import get_direction_chain
        from factory.runner import text_run

        persona = "tech_writer"
        persona_prompt = _read_persona_prompt(persona)
        direction = find_direction_for_story(story, software_factory_root)
        chain = (
            get_direction_chain(direction, software_factory_root) if direction is not None else None
        )
        prelude = compose_context_prelude(
            persona=persona,
            app_repo_path=resolve_app_repo_path(app_config, software_factory_root),
            task_scope=story.scope,
            direction_chain=chain,
            software_factory_root=software_factory_root,
        )
        story_content = _read_story_file_content(story, software_factory_root)
        # FAIL-CLOSED diff precondition, same rationale as handle_review: a
        # tech_writer that cannot see the diff would refresh context docs
        # blind. An EMPTY diff is equally disqualifying HERE (unlike at
        # review time, where it can mean "dev forgot to commit — retry"):
        # tech_writer only runs after the reviewer approved a NON-empty diff,
        # so an empty diff now means the worktree substrate changed under the
        # chain (GC'd/rebuilt) — an infra fault, not a content verdict.
        try:
            pr_diff = _fetch_pr_diff_for_review(story, app_config, software_factory_root)
        except ReviewDiffUnavailableError as exc:
            return _block_on_unavailable_diff(
                story,
                app_config,
                software_factory_root,
                persona="tech_writer",
                reason=exc.reason,
                db=db,
            )
        if not pr_diff.strip():
            return _block_on_unavailable_diff(
                story,
                app_config,
                software_factory_root,
                persona="tech_writer",
                reason=(
                    "diff is empty at tech_writer time, but the reviewer "
                    "approved a non-empty diff — the worktree no longer "
                    "matches what was reviewed"
                ),
                db=db,
            )
        full_prompt = (
            f"{persona_prompt.rstrip()}\n\n"
            "---\n\n"
            "## Context\n\n"
            f"{prelude.rstrip()}\n\n"
            "## Story\n\n"
            f"{story_content}\n\n"
            "## PR diff\n\n"
            f"{pr_diff}\n\n"
            "Return the JSON object. No prose outside the JSON."
        )
        _assert_no_broken_prompt_markers(full_prompt, where="handle_tech_writer")
        model_id = _route_for(story, persona)
        parse_error: str | None = None
        parsed: dict[str, Any] | None = None
        for attempt in range(1, _MAX_TECH_WRITER_PARSE_RETRIES + 1):
            result_any = text_run(
                persona=persona,
                prompt=full_prompt,
                model_id=model_id,
                schema=None,
                # Per-model cap, NOT a small constant: routes.yaml documents
                # tech_writer as "the largest JSON of any text persona", and a
                # 2048 start burned all 4 of the runner's doubling retries
                # (2048+4096+8192+16384 = story 177's exact tokens_out) before
                # returning a still-truncated body as success.
                max_tokens=max_output_tokens_for(model_id),
                story_id=story.id,
                app=story.app,
                direction_id=story.direction_id,
                db_path=db,
            )
            # Fence-strip + shape-check, NOT the reviewer's brace-slice — see
            # _parse_tech_writer_result for why leniency here is a false-green
            # channel (story 177 attempt 1: a fully valid fenced object was
            # rejected by the old bare json.loads; that case parses now).
            candidate = _parse_tech_writer_result(result_any)
            if isinstance(candidate, dict):
                parsed = candidate
                parse_error = None
                break
            parse_error = "tech_writer JSON parse failed"
            log_story_event(
                story.id,
                "tech_writer_parse_retry",
                {"attempt": attempt, "cap": _MAX_TECH_WRITER_PARSE_RETRIES},
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
        if parsed is None:
            # Exhausted retries. NEVER persist a result the docs-current gate
            # can't satisfy — route to the same fail-closed blocked sink the
            # diff-precondition checks above use, so a human sees this
            # instead of a permanently-missing required label.
            return _block_on_unavailable_diff(
                story,
                app_config,
                software_factory_root,
                persona="tech_writer",
                reason=(
                    f"{parse_error} after {_MAX_TECH_WRITER_PARSE_RETRIES} attempts "
                    "(model never returned a parseable JSON object)"
                ),
                db=db,
            )
        result = parsed

    story.tech_writer_result_json = json.dumps(result)

    # Apply context_updates to the app repo. In dry-run we use the factory's
    # apps/<app>/ as a stand-in — but apply_context_updates would write files
    # there. To keep dry-run truly dry (NO writes outside the factory state),
    # we DO NOT call apply_context_updates in dry-run. Instead we record the
    # updates that WOULD have been applied.
    #
    # IMPORTANT: We MUST do the write BEFORE advancing state to TECH_WRITER_DONE
    # so a failed apply leaves the chain in a recoverable place. If the writer
    # produced a forbidden path (or any other write failure), we transition to
    # REVIEWER_REQUESTED_CHANGES so the chain routes back through the dev loop
    # instead of pretending docs are current.
    if not dry_run:
        updates_raw = result.get("context_updates") or []
        updates = [
            ContextUpdate(
                path=u["path"], action=u.get("action", "rewrite"), content=u.get("content", "")
            )
            for u in updates_raw
        ]
        # Context lives in the per-story worktree so concurrent stories
        # don't collide. Each worktree shares ``.git`` with the source
        # repo so refs and history stay consistent.
        repo_path = _writing_worktree(app_config, software_factory_root, story)
        try:
            apply_context_updates(updates, repo_path)
        except Exception as exc:
            # Bounce back through reviewer_requested_changes: tech_writer
            # produced an invalid context update; either the writer is
            # confused (rare) or it tried to write to a forbidden path. The
            # next dev cycle gets a clean shot.
            story.state = advance(story, EVENT_REVIEWER_REQUEST_CHANGES).value
            story.error = f"context update failed: {exc}"
            persist_story(story, db)
            return HandlerResult(
                next_state=StoryState(story.state),
                payload=result,
                error=story.error,
            )

    story.state = advance(story, EVENT_TECH_WRITER_DONE).value
    persist_story(story, db)
    return HandlerResult(next_state=StoryState(story.state), payload=result)


# --------------------------------------------------------------------------- #
# docs_sm — lightweight story-prep for the docs chain
# --------------------------------------------------------------------------- #


def _dry_run_docs_sm(story: StoryRecord) -> dict[str, Any]:
    """Deterministic docs-SM result for dry-run mode.

    Returns the minimum the downstream Onboarder handler needs: a story-file
    body sketch and the list of canonical paths the Onboarder should produce.
    The full BMAD story envelope isn't required — the docs path skips the
    Test-Designer entirely.
    """
    return {
        "story_file_body": (
            f"# {story.title}\n\n"
            f"## Goal\n\nProduce canonical documentation in the app repo.\n\n"
            f"## Canonical paths\n\n"
            f"- `context/project.md`\n"
            f"- `context/current-state.md`\n"
            f"- `context/navigation.md`\n"
            f"- `context/glossary.md`\n"
            f"- `context/architecture-diagrams.md`\n"
            f"- `context/sprint-status.yaml`\n"
            f"- `context/modules/<name>.md` per discovered module\n"
        ),
        "canonical_paths": [
            "context/project.md",
            "context/current-state.md",
            "context/navigation.md",
            "context/glossary.md",
            "context/architecture-diagrams.md",
            "context/sprint-status.yaml",
        ],
    }


def handle_docs_sm(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
) -> HandlerResult:
    """Lightweight SM specialized for the docs chain.

    Produces a story file under ``apps/<app>/stories/<issue>-<slug>.md`` that
    enumerates which canonical paths the Onboarder should produce. NOT a full
    BMAD story — the docs path skips test_design/test_impl/dev entirely.

    In ``dry_run``, emits a deterministic fixture. In real-run, calls
    ``text_run("sm", ...)`` with a docs-flavored prompt. The story file write
    happens BEFORE advancing state so a crash mid-write leaves the chain
    recoverable.
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    story.state = advance(story, EVENT_DOCS_SM_STARTED).value
    persist_story(story, db)

    if dry_run:
        result = _dry_run_docs_sm(story)
    else:
        # Real-run: text_run on a docs-flavored prompt. We re-use the SM
        # persona file but prefix the prompt with a directive to emit a
        # minimal docs story (skip test plans, dev notes, etc.). The SM prompt
        # already knows about canonical paths from CANONICAL_CONTEXT_PATHS.
        from factory.runner import text_run

        persona_prompt = _read_persona_prompt("sm")
        direction = find_direction_for_story(story, software_factory_root)
        direction_title = direction.title if direction else story.title
        direction_why = (direction.why if direction else "") or ""

        docs_directive = (
            "You are running in DOCS-CHAIN mode for this story. The story's "
            "deliverable is canonical documentation under the app's ``context/`` "
            "tree — NO executable code, NO test plans, NO dev notes. Produce a "
            "minimal story body listing the canonical paths the Onboarder must "
            "write and the directive's acceptance criteria verbatim. Output "
            "JSON ONLY with this shape:\n"
            '  {"story_file_body": "<markdown body>", '
            '"canonical_paths": ["context/...", "context/..."]}'
        )
        prompt = (
            f"{docs_directive}\n\n---\n\n"
            f"{persona_prompt.rstrip()}\n\n---\n\n"
            f"## Direction\n\n# {direction_title}\n\n{direction_why}\n"
        )
        schema = {
            "type": "object",
            "properties": {
                "story_file_body": {"type": "string"},
                "canonical_paths": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["story_file_body", "canonical_paths"],
        }
        result_any = text_run(
            persona="sm",
            prompt=prompt,
            model_id=_route_for(story, "sm"),
            schema=schema,
            max_tokens=2048,
            db_path=db,
            story_id=story.id,
            app=story.app,
            direction_id=story.direction_id,
        )
        result = result_any if isinstance(result_any, dict) else _dry_run_docs_sm(story)

    # Persist the SM JSON before any filesystem write so a crash leaves the
    # DB consistent with what the next handler will see.
    story.sm_result_json = json.dumps(result)

    # Write the story file under apps/<app>/stories/<issue>-<slug>.md.
    story_path_abs = software_factory_root / "apps" / story.app / story.story_file_path
    story_path_abs.parent.mkdir(parents=True, exist_ok=True)
    story_path_abs.write_text(result.get("story_file_body", "") + "\n", encoding="utf-8")

    story.state = advance(story, EVENT_DOCS_SM_DONE).value
    persist_story(story, db)
    return HandlerResult(next_state=StoryState(story.state), payload=result)


# --------------------------------------------------------------------------- #
# docs_onboarder — single-shot sandbox run that writes the canonical files
# --------------------------------------------------------------------------- #


def _dry_run_docs_onboarder(story: StoryRecord) -> dict[str, Any]:
    """Dry-run fixture: pretend the Onboarder wrote a plausible canonical set."""
    return {
        "files_changed": [
            "context/project.md",
            "context/current-state.md",
            "context/navigation.md",
            "context/glossary.md",
            "context/architecture-diagrams.md",
            "context/sprint-status.yaml",
        ],
        "summary": "Dry-run docs_onboarder: canonical files would be produced.",
    }


def handle_docs_onboarder(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
) -> HandlerResult:
    """Run the Onboarder persona via sandbox_run.

    The Onboarder reads the app repo, infers the project + module map, and
    writes the canonical context set on the feature branch. The single
    sandbox pass replaces the entire test_impl/dev loop the TDD chain would
    have driven.

    Uses ``resolve_app_repo_path`` for the sandbox working directory (Bug A
    fix) and ``ensure_feature_branch`` for the per-story branch (Fix 1).
    Commits produced by the sandbox land on the feature branch in the real
    app repo.
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    story.state = advance(story, EVENT_DOCS_ONBOARDER_STARTED).value
    persist_story(story, db)

    if dry_run:
        payload = _dry_run_docs_onboarder(story)
        story.state = advance(story, EVENT_DOCS_ONBOARDER_DONE).value
        story.tech_writer_result_json = json.dumps(
            {
                "context_updates": [
                    {"path": p, "action": "rewrite", "content": ""}
                    for p in payload["files_changed"]
                ]
            }
        )
        persist_story(story, db)
        return HandlerResult(next_state=StoryState(story.state), payload=payload)

    from factory.chain.branch import feature_branch_name
    from factory.runner import LLMConfig, sandbox_run

    target_repo = _writing_worktree(app_config, software_factory_root, story)
    branch = feature_branch_name(story.github_issue_number, story.slug)
    story.github_branch = branch
    persist_story(story, db)

    story_file_path_obj = software_factory_root / "apps" / story.app / story.story_file_path
    llm = LLMConfig(model=_route_for(story, "onboarder"))
    import asyncio

    run_res = asyncio.run(
        sandbox_run(
            persona="onboarder",
            story_path=story_file_path_obj,
            repo_path=target_repo,
            llm_config=llm,
            dry_run=False,
            story_id=story.id,
            app=story.app,
            direction_id=story.direction_id,
        )
    )

    # Onboarder writes files via SDK tool calls. The factory then explicitly
    # commits whatever's left untracked on the feature branch — the SDK
    # doesn't always commit cleanly across the full set.
    from factory.chain.branch import _run_git

    try:
        _run_git(target_repo, "add", "-A")
        # Only commit if there's anything to commit; an empty commit would be
        # a chain bug (Onboarder produced nothing) and we want to surface it.
        status = _run_git(target_repo, "status", "--porcelain").stdout.strip()
        if status:
            _run_git(
                target_repo,
                "commit",
                "-m",
                f"docs(context): bootstrap canonical context for {story.app}\n\n"
                f"Produced by Onboarder for story {story.id} ({story.slug}).",
            )
        else:
            # Nothing produced — Onboarder failed silently. Surface it.
            story.state = advance(story, EVENT_DOCS_ONBOARDER_FAILED).value
            story.error = "onboarder produced no files"
            persist_story(story, db)
            return HandlerResult(
                next_state=StoryState(story.state),
                payload={"files_changed": [], "summary": run_res.summary[-1000:]},
                error=story.error,
            )
    except Exception as exc:
        story.state = advance(story, EVENT_DOCS_ONBOARDER_FAILED).value
        story.error = f"docs_onboarder commit failed: {exc}"
        persist_story(story, db)
        return HandlerResult(
            next_state=StoryState(story.state),
            payload={"files_changed": run_res.files_changed, "summary": str(exc)},
            error=story.error,
        )

    # Capture the diff between the feature branch and base for the enforcer.
    diff_proc = _run_git(
        target_repo,
        "diff",
        "--name-only",
        f"{app_config.default_branch or 'main'}..HEAD",
    )
    diff_files = [line.strip() for line in diff_proc.stdout.splitlines() if line.strip()]

    # Persist the file list under tech_writer_result_json so the existing
    # ``handle_docs_enforcer`` can pick it up unchanged — the field name is
    # legacy; semantically it's "list of files this story touched".
    story.tech_writer_result_json = json.dumps(
        {"context_updates": [{"path": p, "action": "rewrite", "content": ""} for p in diff_files]}
    )

    story.state = advance(story, EVENT_DOCS_ONBOARDER_DONE).value
    persist_story(story, db)
    payload = {
        "files_changed": diff_files,
        "summary": run_res.summary[-2000:],
        "tokens_in": run_res.tokens_in,
        "tokens_out": run_res.tokens_out,
        "cost_usd": run_res.cost_usd,
    }
    return HandlerResult(next_state=StoryState(story.state), payload=payload)


# --------------------------------------------------------------------------- #
# docs_enforcer
# --------------------------------------------------------------------------- #

# S4 (019 fail-silent audit): cap on consecutive ``gh pr create`` failures
# before parking the story at BLOCKED_DEPLOY_FAILED instead of retrying
# forever. Strictly below the hard cap of 3 used elsewhere
# (``_MAX_DEV_RETRIES`` / ``_MAX_REVIEW_CYCLES``).
_MAX_PR_CREATE_RETRIES = 2

# Pre-PR lint bounce: how many times ONE story may be sent back to dev because
# ruff is still red on its own changed .py files. Exactly one. The second red
# opens the PR anyway and lets GitHub CI + the existing ci-fix / identical-
# signature park be the backstop they already are. A repeating bounce would be
# a new uncapped loop, which the guardrails forbid — and a dev that cannot
# clear a concise ruff report it was handed verbatim will not clear it on
# attempt three either.
_MAX_LINT_BOUNCES = 1


def _lint_bounces_so_far(story: StoryRecord, software_factory_root: Path) -> int:
    """How many pre-PR lint bounces this story has already taken.

    Derived from the story's OWN event stream (``lint_bounce`` records) rather
    than a new counter column — the ``_gate_block_history`` precedent in
    ``auto_merge``. Three reasons this is the cheapest option that actually
    works:

    * it survives a process restart for free (the events are on disk, hash-
      chained, and already written for audit anyway);
    * it needs no schema change and no migration of live rows;
    * every field that LOOKED reusable is wrong. ``dev_retries`` /
      ``reviewer_cycles`` are reset by the bounce itself (and by the CI-fix
      re-dispatch); ``total_attempts`` is reset by the orchestrator's
      advance-decay on forward progress; ``reviewer_result_json`` and
      ``tech_writer_result_json`` are BOTH overwritten on the way back round
      the loop the bounce sends the story on. A flag in any of them would be
      erased before it was ever read.

    Scoped after the most recent ``story_resumed`` for the same reason
    ``_gate_block_history`` is: an operator resume is a deliberate "try this
    again", and must not be silently overruled by history.

    FAIL DIRECTION: an unreadable / unidentifiable log returns
    ``_MAX_LINT_BOUNCES`` — "cap already reached", so the PR opens. This counter
    is the ONLY thing bounding the bounce loop, and a read that fails
    repeatedly (unreadable log, a story with no id, a wiped ``state/logs``)
    would otherwise report 0 every single time and bounce the story forever.
    Fail-safe HERE means "do not bounce": the un-bounced branch still meets
    GitHub CI, which is the authoritative lint gate. An unbounded loop has no
    such backstop.
    """
    from factory.chain.event_log import read_story_events

    if story.id is None:
        # No id → no log path → nothing can ever be counted. Never bounce.
        return _MAX_LINT_BOUNCES
    try:
        events = read_story_events(
            story.id, software_factory_root=software_factory_root, slug_hint=story.slug or ""
        )
    except Exception:  # noqa: BLE001 - see FAIL DIRECTION above
        _logger.warning(
            "story %s: lint-bounce history unreadable; treating the cap as reached "
            "so the bounce loop stays bounded",
            story.id,
        )
        return _MAX_LINT_BOUNCES
    resume_idx = -1
    for i, e in enumerate(events):
        if e.get("event") == "story_resumed":
            resume_idx = i
    return sum(1 for e in events[resume_idx + 1 :] if e.get("event") == "lint_bounce")


# Attempt headroom a story must still have before it is allowed to spend a
# bounce. One bounce costs a dev dispatch + a review + a tech_writer + this
# handler, so a story with less headroom than that would be sent round a loop it
# cannot finish and would die at BLOCKED_BUDGET_EXCEEDED — with its branch
# unpushed and no PR at all, which is strictly worse than the lint-red PR the
# bounce was trying to avoid.
_LINT_BOUNCE_ATTEMPT_HEADROOM = 4


def _lint_bounce_budget_headroom(
    story: StoryRecord, software_factory_root: Path
) -> tuple[bool, int | None]:
    """``(has enough attempt headroom for a bounce, remaining attempts)``.

    Fails OPEN (``True``) when the caps can't be read or aren't configured:
    an unreadable settings file must not silently disable the lint bounce, and
    the bounce is capped at 1 either way.
    """
    try:
        from factory.settings.loader import load_settings as _load_settings

        caps = _load_settings(software_factory_root).caps
        per_story_attempts = int(getattr(caps, "per_story_attempts", 0) or 0)
    except Exception:  # noqa: BLE001 - unreadable settings must not disable the bounce
        return True, None
    if per_story_attempts <= 0:
        return True, None
    remaining = per_story_attempts - int(story.total_attempts or 0)
    return remaining >= _LINT_BOUNCE_ATTEMPT_HEADROOM, remaining


def _residual_lint_for_story(
    story: StoryRecord, app_config: AppConfig, software_factory_root: Path
) -> str | None:
    """Autoformat the story's branch, then report what ruff still flags.

    Autoformat runs FIRST and here (not only inside ``_open_pr_for_story``) so
    the bounce is never spent on a nit the conservative autoformat fixes for
    free — an I001 import-sort or a missing trailing newline must not cost a
    whole dev cycle. It is idempotent, so the second call inside
    ``_open_pr_for_story`` finds nothing to do and commits nothing.

    Fail-open on any worktree-resolution problem: see
    ``_residual_changed_py_lint``.
    """
    try:
        target_repo = _writing_worktree(app_config, software_factory_root, story)
    except Exception as exc:  # noqa: BLE001 - no worktree → CI stays the backstop
        _logger.warning("pre-PR lint check skipped (no worktree, fail-open): %s", exc)
        return None
    base = app_config.default_branch or "main"
    _autoformat_changed_py_before_pr(target_repo, base, app_config)
    return _residual_changed_py_lint(target_repo, base, app_config)


def _push_fix_to_existing_pr(
    story: StoryRecord, app_config: AppConfig, software_factory_root: Path
) -> tuple[bool, str | None]:
    """Push a post-PR fix cycle's new commits so the PR head actually MOVES.

    Returns ``(pushed, error_reason)``.

    THE BUG THIS CLOSES (sacrifice story 183, 2026-08-09 — live evidence, not
    inference). The chain had exactly ONE push site for a story's work:
    ``_open_pr_for_story``, which ``handle_docs_enforcer`` calls only under
    ``story.github_pr_number is None``. The only other push in the codebase is
    the dev-exhausted WIP-preservation path. So once a PR existed, NOTHING could
    ever push again:

      * CI goes red on PR #N;
      * ``auto_merge._handle_ci_failure`` re-dispatches the story to dev with
        the CI digest as a reviewer finding;
      * dev DOES fix it — story 183's ``response_bodies.ndjson`` at 21:45:07
        shows the F401s and the E712 corrected — and
        ``_commit_green_dev_work`` commits it LOCALLY;
      * the story walks back review → tech_writer → docs_enforcer, whose PR
        block is skipped because ``github_pr_number`` is set;
      * ``git.ndjson`` records exactly ONE push for the whole story: the
        original. The remote head never moved, so GitHub never re-ran CI;
      * the next evaluation re-reads the SAME stale head sha, sees the identical
        failure signature, and terminally parks the story.

    That silently swallowed EVERY post-PR fix, not just lint ones — the ci-fix
    loop was writing fixes to a branch nobody shipped. The lint bounce added in
    the previous commit only ever helped BEFORE a PR exists; this is the other
    half.

    Only pushes when the local branch is genuinely AHEAD of its remote. A cycle
    that produced no new commit must NOT be given a fresh head sha it did not
    earn: the identical-signature park is the correct outcome for a dev that
    truly changed nothing, and manufacturing a new sha would defeat the one
    guard that stops that loop.

    Same ``--force-with-lease`` rationale as ``_open_pr_for_story``: story
    branches are factory-owned and single-writer, origin may hold stale commits
    from abandoned earlier attempts, and the lease still aborts if origin moved
    unexpectedly since our fetch.

    NOTE (deliberate asymmetry): the pre-push autoformat that
    ``_open_pr_for_story`` runs is NOT run here. A post-PR cycle's commits come
    from dev fixing concrete findings, and silently rewriting them on the way to
    a PR whose CI is already contested would confuse the very signal being
    adjudicated. If a fix cycle needs formatting help, that belongs in the dev
    loop, where the findings already say so.
    """
    import subprocess

    from factory.chain.delivery_gate import story_is_ci_watched

    watched = story_is_ci_watched(story)
    branch = story.github_branch
    if not branch:
        return False, "no branch recorded on the story"
    try:
        target_repo = _writing_worktree(app_config, software_factory_root, story)
    except Exception as exc:  # noqa: BLE001
        return False, f"worktree unavailable: {exc}"

    def _git(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(
                ["git", *args],
                cwd=str(target_repo),
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=timeout,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None

    # Refresh + PRUNE remote-tracking refs first: the ahead-check below reads
    # ``origin/<branch>``, and --force-with-lease rejects with "stale info"
    # against a tracking ref that was never updated (story 56, 2026-07-18).
    _git(["fetch", "--prune", "origin"])

    # Gate on the SAME ref the push will act on — the local branch, not HEAD.
    # ``git push origin <branch>`` sends ``refs/heads/<branch>``; deciding
    # "is there anything new?" from HEAD instead would be a proxy for the real
    # artifact, and the two can differ (detached HEAD, a worktree left on
    # another branch). If the local branch ref is missing, rev-list fails and we
    # report a push error rather than guessing.
    remote_ref = f"origin/{branch}"
    exists = _git(["rev-parse", "--verify", "--quiet", f"{remote_ref}^{{commit}}"], timeout=30)
    if exists is not None and exists.returncode == 0:
        ahead = _git(["rev-list", "--count", f"{remote_ref}..{branch}"], timeout=60)
        if ahead is None:
            return False, "could not compare the branch with its remote"
        if ahead.returncode != 0:
            return False, f"git rev-list failed: {(ahead.stderr or '').strip()[:300]}"
        try:
            ahead_n = int((ahead.stdout or "0").strip() or "0")
        except ValueError:
            return False, "unparseable git rev-list output"
        if ahead_n == 0:
            # Genuinely nothing new. Say so out loud and let the
            # identical-signature guard do its (correct) job.
            _logger.info(
                "story %s: no new commits to push to PR #%s; the remote head is current",
                story.id,
                story.github_pr_number,
            )
            log_story_event(
                story.id,
                "fix_push_skipped_no_commits",
                {
                    "branch": branch,
                    "pr_number": story.github_pr_number,
                    "note": (
                        "the fix cycle produced no commit; the PR head is unchanged on "
                        "purpose so the identical-signature guard can park it"
                    ),
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            return False, None
        if watched:
            # draft_pr / pr: the PR is the HUMAN's deliverable. If origin has
            # commits the local branch lacks, someone else pushed to it —
            # never push (and never force) over them (review of PR #335,
            # MUST 2). The CI watch then delivers with a note.
            behind = _git(["rev-list", "--count", f"{branch}..{remote_ref}"], timeout=60)
            try:
                behind_n = int(((behind.stdout if behind else "") or "").strip() or "-1")
            except ValueError:
                behind_n = -1
            if behind is None or behind.returncode != 0 or behind_n != 0:
                why = (
                    f"PR branch {branch} has {behind_n} commit(s) the factory did not write"
                    if behind_n > 0
                    else "could not prove the PR branch has no commits the factory did not write"
                )
                reason = f"{why}; CI fix NOT pushed (never forced over a human)"
                log_story_event(
                    story.id,
                    "fix_push_refused_foreign_commits",
                    {
                        "branch": branch,
                        "pr_number": story.github_pr_number,
                        "behind": behind_n,
                        "error": reason,
                    },
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
                return False, reason
    # A missing remote branch means "never pushed / deleted upstream" — push.

    # draft_pr / pr: fast-forward only — a plain push cannot drop a commit
    # someone else pushed between the check above and this push.
    push_args = (
        ["push", "origin", str(branch)]
        if watched
        else ["push", "--force-with-lease", "origin", str(branch)]
    )
    push = _git(push_args, timeout=120)
    ok = push is not None and push.returncode == 0
    # ``state/events/git.ndjson`` is the stream whose ONE push line exposed this
    # bug in the first place; make sure a fix push is visible there too, with
    # the PR it belongs to.
    try:
        from factory.manager.signals import write_git_event as _wge

        _wge(
            kind="push",
            story_id=story.id,
            worktree_path=str(target_repo),
            pr_number=story.github_pr_number,
            result="ok" if ok else "error",
            error=None if ok else ((push.stderr or "").strip()[:300] if push else "push_failed"),
            software_factory_root=software_factory_root,
        )
    except Exception:  # noqa: BLE001 - signal emission is best-effort
        pass
    if ok:
        sha_proc = _git(["rev-parse", "--verify", "--quiet", f"{branch}^{{commit}}"], timeout=30)
        pushed_sha = (
            (sha_proc.stdout or "").strip() or None
            if sha_proc is not None and sha_proc.returncode == 0
            else None
        )
        log_story_event(
            story.id,
            "fix_push",
            # ``head_sha``: the commit the CI watch must grade
            # (``auto_merge._expected_pr_head``); a different PR head is not ours.
            {"branch": branch, "pr_number": story.github_pr_number, "head_sha": pushed_sha},
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )
        return True, None
    detail = "git push timed out or could not run" if push is None else (push.stderr or "").strip()
    return False, f"git {' '.join(push_args[:-2])} failed: {detail[:300]}"


def _log_watched_pr_head(
    story: StoryRecord, app_config: AppConfig, software_factory_root: Path, pr_number: int
) -> None:
    """Record the commit the factory just pushed for a ``draft_pr`` / ``pr`` PR
    (``auto_merge.EVENT_PR_HEAD_PUSHED``), so the CI watch grades THAT commit
    and recognises a head someone else pushed. Best-effort: with no record the
    watch simply skips the foreign-head check."""
    import subprocess

    from factory.chain.auto_merge import EVENT_PR_HEAD_PUSHED

    sha: str | None = None
    try:
        wt = _writing_worktree(app_config, software_factory_root, story)
        proc = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{story.github_branch}^{{commit}}"],
            cwd=str(wt),
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if proc.returncode == 0:
            sha = (proc.stdout or "").strip() or None
    except Exception:  # noqa: BLE001 - best-effort
        sha = None
    try:
        log_story_event(
            story.id,
            EVENT_PR_HEAD_PUSHED,
            {"pr_number": pr_number, "branch": story.github_branch, "head_sha": sha},
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )
    except Exception:  # noqa: BLE001 - telemetry only
        pass


def handle_docs_enforcer(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    pr_files: list[str] | None = None,
    github_client: Any = None,
) -> HandlerResult:
    """Run the canonical-paths enforcer over the PR's file list.

    Violations → REVIEWER_REQUESTED_CHANGES + label + comment.
    Clean → PR_OPEN. Opens the GitHub PR programmatically when reached via
    the docs chain (TDD path leaves PR creation to a future webhook).

    In dry-run mode without an explicit ``pr_files`` list, we derive a
    plausible set from the tech_writer result (so the enforcer sees the
    same paths the tech_writer claimed to write). Docs chain populates the
    same JSON field with its diff file list.
    """
    db = db_path or (software_factory_root / "state" / "factory.db")
    story.state = advance(story, EVENT_DOCS_ENFORCER_CHECK).value
    persist_story(story, db)

    files = pr_files
    if files is None:
        # Real runs: the authoritative file list is the branch's ACTUAL diff
        # against base — the SAME source the reviewer approves on (see
        # ``_fetch_pr_diff_for_review``) — NOT the tech_writer's self-declared
        # ``context_updates``. A tech_writer that declares only a story-file
        # "update" (story 130 / D109, 2026-07-23) otherwise makes the
        # vacuous-diff guard below misfire on a branch that genuinely contains
        # the code fix: the reviewer approves the real diff, the enforcer sees
        # only ``stories/*.md`` in the declared list, bounces the story to
        # reviewer_requested_changes, and the dev<->enforcer loop churns every
        # cycle until the per-story budget dies. Dry-run has no worktree to
        # diff, so it keeps deriving from the tech_writer result (the enforcer
        # still sees the paths the writer claimed).
        real_files = (
            _changed_files_for_story(story, app_config, software_factory_root)
            if not dry_run
            else None
        )
        if real_files is not None:
            files = real_files
        else:
            # Fallback (dry-run, or the git diff could not be computed — e.g.
            # the worktree was GC'd): derive from the tech_writer result.
            files = []
            tw_raw = story.tech_writer_result_json or "{}"
            try:
                tw = json.loads(tw_raw)
                for u in tw.get("context_updates") or []:
                    files.append(str(u.get("path")))
            except json.JSONDecodeError:
                pass

    violations = scan_pr_diff(files)
    payload: dict[str, Any] = {"violations": [v._asdict() for v in violations], "files": files}

    # Vacuous-diff guard. A deliverable with no substantive file — no code, no
    # context/, no prd.md — delivered nothing. Two shapes, both blocked back to
    # the dev loop rather than opened as a PR:
    #
    #  * only ``stories/*.md`` — the story file is the WORK ORDER, not the work.
    #    scan_pr_diff can't catch it (stories/*.md is a canonical path, so a
    #    story-file-only diff scans clean — exactly how benchmark t7 "passed"
    #    2026-07-17 with a diff that only added the seeded story file).
    #  * empty (``files == []``) — the branch changed nothing at all. Now
    #    reachable since we key off the REAL diff: an in-handler base re-merge
    #    (``_writing_worktree``) can absorb a sibling's identical fix, leaving
    #    an empty ``origin/base...HEAD``. Opening a PR on an empty branch fails
    #    ``gh pr create`` and would strand the story at PR_OPEN with
    #    pr_number=None (auto-merge matches PRs by number → silent limbo), so
    #    bounce instead. NOTE the condition is ``not substantive`` (not the old
    #    ``files and not substantive``): with real-diff semantics the empty
    #    case is a genuine no-op, not the old story-only misfire.
    substantive = [f for f in files if f and not str(f).startswith("stories/")]
    if not substantive:
        story.state = advance(story, EVENT_DOCS_ENFORCER_FAIL).value
        empty = not files
        story.error = (
            "vacuous diff: branch changed nothing — no deliverable content"
            if empty
            else "vacuous diff: only story files changed — no deliverable content"
        )
        payload["vacuous_diff"] = True
        payload["empty_diff"] = empty
        persist_story(story, db)
        log_story_event(
            story.id,
            "vacuous_diff",
            {"files": files[:20], "empty_diff": empty},
            software_factory_root=software_factory_root,
            slug_hint=story.slug,
        )
        return HandlerResult(next_state=StoryState(story.state), payload=payload, error=story.error)

    if violations:
        # Real-run: post the comment + label the PR.
        if not dry_run and github_client is not None and story.github_pr_number is not None:
            try:
                repo = github_client.get_repo(app_config.repo)
                pr = repo.get_pull(story.github_pr_number)
                pr.create_issue_comment(format_violation_comment(violations))
                pr.add_to_labels("canonical-paths-violation")
            except Exception:  # pragma: no cover - real-run path
                pass

        story.state = advance(story, EVENT_DOCS_ENFORCER_FAIL).value
        story.error = f"canonical-paths violations: {len(violations)}"
        persist_story(story, db)
        return HandlerResult(next_state=StoryState(story.state), payload=payload, error=story.error)

    # Open the PR programmatically for BOTH chains. The "separate worker"
    # the TDD path historically deferred to was removed with the test-first
    # machinery in the Loop-4 cleanup — without this, TDD stories reached
    # PR_OPEN with github_pr_number=None and auto-merge (which matches open
    # PRs to stories by number) could never merge them. Observed live
    # 2026-06-11 on story 5, the first Loop-4 story to complete the chain.
    if not dry_run and story.github_pr_number is None and story.github_branch:
        # Pre-PR lint bounce (sacrifice story 183, 2026-08-09). NOTHING in the
        # chain runs lint: an app's ``lint_command`` / ``format_check_command``
        # are config the chain records but never executes, and the pre-PR
        # autoformat is deliberately conservative — it only deletes imports the
        # BRANCH ITSELF added. A dev that edits a PRE-EXISTING file and orphans
        # an import there therefore passes every chain gate and opens a PR whose
        # required lint check is already doomed.
        #
        # WHY THAT USED TO BE FATAL — and what it is NOT. Story 183's evidence
        # is explicit that the dev was NOT the problem: it received the CI
        # findings and FIXED them (``response_bodies.ndjson``, 21:45:07 — the
        # F401s and the E712 corrected), and ``_commit_green_dev_work``
        # committed the fix locally. The defect was downstream: nothing ever
        # PUSHED that commit, because the only push site sat behind
        # ``github_pr_number is None``. The PR head never moved, CI never
        # re-ran, and the identical-signature guard adjudicated a stale sha and
        # parked the story. That is fixed below (``_push_fix_to_existing_pr``).
        #
        # This bounce is the cheaper half of the same story: catching lint while
        # the loop is still pre-PR and non-destructive costs one dev cycle
        # instead of a CI round-trip. Capped at ``_MAX_LINT_BOUNCES``.
        lint_bounces = _lint_bounces_so_far(story, software_factory_root)
        # The check runs even when the cap is spent — it costs one ruff pass and
        # it is the difference between "we know this PR is going to fail CI lint"
        # and inferring it from a closed PR the next morning.
        residual_lint = _residual_lint_for_story(story, app_config, software_factory_root)
        # A bounce is only worth spending if the story can still AFFORD the loop
        # it is being sent round. Below the headroom threshold it would die at
        # BLOCKED_BUDGET_EXCEEDED with no PR at all — worse than the lint-red PR
        # this is trying to prevent.
        has_headroom, remaining_attempts = _lint_bounce_budget_headroom(
            story, software_factory_root
        )
        if residual_lint and lint_bounces < _MAX_LINT_BOUNCES and not has_headroom:
            payload["residual_lint"] = residual_lint
            payload["lint_bounce_skipped_budget"] = True
            log_story_event(
                story.id,
                "lint_bounce_skipped_budget",
                {
                    "branch": story.github_branch,
                    "remaining_attempts": remaining_attempts,
                    "headroom_required": _LINT_BOUNCE_ATTEMPT_HEADROOM,
                    "total_attempts": story.total_attempts,
                    "note": (
                        "too little attempt budget left to survive a bounce; opening the "
                        "PR so the work reaches GitHub instead of dying unpushed"
                    ),
                    "ruff_output": residual_lint,
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
        elif residual_lint and lint_bounces < _MAX_LINT_BOUNCES:
            # Same destination REVIEWER_REQUESTED_CHANGES as the canonical-paths
            # violation above, via the only event DOCS_ENFORCER_CHECK has a
            # transition for. (The tech_writer path reaches the same state with
            # EVENT_REVIEWER_REQUEST_CHANGES, but that pair is not in the
            # transition table from here and would raise IllegalTransitionError.)
            story.state = advance(story, EVENT_DOCS_ENFORCER_FAIL).value
            # Reuse the reviewer-findings plumbing verbatim — the same channel
            # ``auto_merge`` uses for CI failures and merge conflicts. A
            # well-formed finding DICT, never a bare string: every downstream
            # consumer (runner._build_initial_message, _findings_signature,
            # _append_reviewer_history) indexes findings with ``f.get(...)``.
            finding = {
                "severity": "high",
                "criterion": "lint",
                "location": "ruff (changed .py files on this branch)",
                "what": (
                    "Lint is RED on this branch's own changed Python files. The "
                    "app's required GitHub CI lint check runs the same ruff and "
                    "will block the PR, so fix every violation listed below "
                    "before this can ship. Note these are NOT all on lines you "
                    "added — a violation you introduced on a MODIFIED line of a "
                    "pre-existing file counts, and the pre-PR autoformat "
                    "deliberately will not touch it for you:\n\n"
                    f"{residual_lint}"
                ),
                "fix_suggestion": (
                    "Resolve each reported violation in the file it names "
                    "(delete the unused import, use the variable, or make the "
                    "line comply). Do not add per-file ruff ignores to silence "
                    "them. Keep the tests green."
                ),
            }
            story.reviewer_result_json = json.dumps(
                {
                    "findings": [finding],
                    "source": "pre_pr_lint",
                    "summary": "Ruff is red on this branch's changed .py files; fix the "
                    "violations listed.",
                }
            )
            # Reset BOTH per-loop counters, mirroring the CI-fix re-dispatch and
            # for the identical reason: this story is already reviewer-APPROVED,
            # so ``reviewer_cycles`` may sit at the cap, and the follow-up review
            # pass would otherwise trip BLOCKED_REVIEW_NONCONVERGENT on its first
            # non-approving verdict and mislabel a lint nit as non-convergence.
            # Safe against loops: the bounce cap is counted from the EVENT
            # stream, which these resets cannot touch.
            story.dev_retries = 0
            story.reviewer_cycles = 0
            story.error = (
                "pre-PR lint is red on the branch's changed .py files; returned to dev "
                "with the violations (one bounce only — the next pass opens the PR and "
                "lets GitHub CI adjudicate)"
            )
            payload["residual_lint"] = residual_lint
            payload["lint_bounce"] = True
            persist_story(story, db)
            log_story_event(
                story.id,
                "lint_bounce",
                {
                    "branch": story.github_branch,
                    "bounce": lint_bounces + 1,
                    "cap": _MAX_LINT_BOUNCES,
                    "ruff_output": residual_lint,
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            return HandlerResult(
                next_state=StoryState(story.state), payload=payload, error=story.error
            )
        elif residual_lint:
            # Still red after its one bounce. Open the PR regardless and let the
            # real CI rule — loudly, so a repeat offender is visible in the
            # trace. The old path (CI red → ci-fix → identical signature → park)
            # remains exactly the backstop it was; a second bounce would be a
            # new uncapped loop.
            payload["residual_lint"] = residual_lint
            payload["lint_bounce_capped"] = True
            log_story_event(
                story.id,
                "lint_bounce_capped",
                {
                    "branch": story.github_branch,
                    "bounces": lint_bounces,
                    "cap": _MAX_LINT_BOUNCES,
                    "ruff_output": residual_lint,
                    "note": "opening the PR anyway; GitHub CI is the adjudicator",
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
        # DELIVERY LEVEL (factory/chain/delivery_gate.py). Resolved from the
        # value RECORDED at spawn — never re-derived from today's config, so a
        # raised ceiling cannot escalate this story. ``auto_merge`` is the
        # unchanged legacy path below.
        level = delivery_story_level(story, app_config, software_factory_root, db)
        payload["delivery_level"] = level.value
        delivered_event: str | None = None
        delivered_detail: dict[str, Any] = {}
        if level is DeliveryLevel.NONE:
            # Commit, never push, never open a PR.
            try:
                wt = _writing_worktree(app_config, software_factory_root, story)
                local_sha, local_err = commit_local_work(wt, story)
            except Exception as exc:  # noqa: BLE001 - routed into the bounded retry below
                local_sha, local_err = None, repr(exc)[:300]
            delivery_ok = local_sha is not None
            delivered_event = EVENT_DELIVERED_LOCAL
            delivered_detail = {"commit_sha": local_sha, "branch": story.github_branch}
            delivery_failure = f"local commit failed: {local_err}"
        elif level in (DeliveryLevel.BRANCH, DeliveryLevel.PUSH_TO_MAIN):
            # Push the branch, open NO PR. ``push_to_main`` then continues to
            # PR_OPEN (with no PR) so the auto-merge worker runs the full gate
            # set and fast-forwards the default branch.
            delivery_ok = _push_story_branch(story, app_config, software_factory_root)
            if level is DeliveryLevel.BRANCH:
                delivered_event = EVENT_DELIVERED_BRANCH
                delivered_detail = {"branch": story.github_branch}
            delivery_failure = f"git push failed for branch {story.github_branch!r}"
        else:
            opened = _open_pr_for_story(
                story,
                app_config,
                software_factory_root,
                draft=level is DeliveryLevel.DRAFT_PR,
                will_auto_merge=level.merges,
            )
            delivery_ok = opened is not None
            if opened is not None:
                story.github_pr_number = opened
                payload["pr_number"] = opened
                if not level.merges:
                    _log_watched_pr_head(story, app_config, software_factory_root, opened)
            # ``draft_pr`` / ``pr`` do NOT stop here any more (2026-11-02,
            # template-probe PR #18: a red ``docker build`` was never fed back
            # because the story was DELIVERED_PR the moment the PR opened).
            # They continue to PR_OPEN like ``auto_merge``, and the auto-merge
            # worker WATCHES the PR's CI — feeding a red run back to dev, at
            # most ``_MAX_CI_FIX_CYCLES`` times — before settling the story to
            # DELIVERED_PR. It never merges them and never marks a draft
            # ready (``auto_merge._watch_ci_then_deliver``).
            delivery_failure = f"gh pr create failed for branch {story.github_branch!r}"
        if delivery_ok:
            story.pr_create_retries = 0
            story.error = None
            story.last_rejection_reason = None
            persist_story(story, db)
            if delivered_event is not None:
                # The story reached the END of its delivery level. Terminal:
                # nothing downstream (auto-merge, deploy, tracker closing) may
                # act on it — a human owns the next step.
                story.state = advance(story, delivered_event).value
                persist_story(story, db)
                log_story_event(
                    story.id,
                    DELIVERY_EVENT_DELIVERED,
                    {"level": level.value, "state": story.state, **delivered_detail},
                    software_factory_root=software_factory_root,
                    slug_hint=story.slug,
                )
                payload["delivered"] = story.state
                return HandlerResult(next_state=StoryState(story.state), payload=payload)
        else:
            # S4 (019 fail-silent audit): this USED TO fall through to
            # EVENT_DOCS_ENFORCER_PASS anyway — the story advanced to
            # PR_OPEN with github_pr_number still None, a state with NO
            # ``orchestrator._DISPATCH`` entry, so nothing ever drove it
            # again. The only trace was a ``git_op result=error`` line in
            # ``state/events/git.ndjson`` — absent from `factory inbox` and
            # from GitHub. Refuse the transition instead: stay in
            # DOCS_ENFORCER_CHECK (which DOES have a dispatch entry, so the
            # next tick retries `_open_pr_for_story` for free — no LLM call,
            # `github_pr_number` is still None) and surface the failure via
            # `error`/`last_rejection_reason` so `factory inbox` lists it.
            # Bounded by `_MAX_PR_CREATE_RETRIES` (strictly below the hard
            # cap of 3) so a persistently broken `gh`/push doesn't retry
            # forever; past that it parks at BLOCKED_DEPLOY_FAILED.
            story.pr_create_retries += 1
            reason = (
                f"{delivery_failure} "
                f"(attempt {story.pr_create_retries}/{_MAX_PR_CREATE_RETRIES}); "
                "see state/events/git.ndjson for the git_op error"
            )
            payload["pr_create_failed"] = True
            payload["pr_create_retries"] = story.pr_create_retries
            if story.pr_create_retries >= _MAX_PR_CREATE_RETRIES:
                story.state = advance(story, EVENT_PR_CREATE_EXHAUSTED).value
                reason = f"{reason} — retries exhausted, parked for human action"
            story.error = reason
            story.last_rejection_reason = reason
            persist_story(story, db)
            log_story_event(
                story.id,
                "pr_create_failed",
                {
                    "branch": story.github_branch,
                    "delivery_level": level.value,
                    "retries": story.pr_create_retries,
                    "exhausted": story.pr_create_retries >= _MAX_PR_CREATE_RETRIES,
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            return HandlerResult(next_state=StoryState(story.state), payload=payload, error=reason)

    elif not dry_run and story.github_pr_number is not None and story.github_branch:
        # POST-PR FIX CYCLE — the story already has a PR and has just come back
        # round through dev (CI failure, reviewer changes, or the lint bounce
        # above). Its fix is committed in the worktree and, until this existed,
        # was never pushed anywhere: the branch above is the ONLY place the
        # chain pushed a story's work, and it is gated on
        # ``github_pr_number is None``. See ``_push_fix_to_existing_pr`` for
        # story 183's evidence. Push it, so the PR head moves and GitHub
        # actually re-runs CI on the fix.
        pushed, push_error = _push_fix_to_existing_pr(story, app_config, software_factory_root)
        payload["fix_pushed"] = pushed
        if push_error:
            # Do NOT block the transition: PR_OPEN is where auto-merge can see
            # the story, and refusing to advance would strand it. But the park
            # that follows must NAME this — a failed push swallowed in silence
            # is the exact failure class being fixed here, one level up.
            payload["fix_push_error"] = push_error
            story.error = (
                f"fix commits were NOT pushed to PR #{story.github_pr_number}: {push_error}. "
                "The PR head is stale, so its CI verdict does not describe the current "
                "work — re-push the branch by hand before trusting any red on it."
            )
            _logger.error("story %s: %s", story.id, story.error)
            log_story_event(
                story.id,
                "fix_push_failed",
                {
                    "branch": story.github_branch,
                    "pr_number": story.github_pr_number,
                    "error": push_error,
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )
            persist_story(story, db)

    story.state = advance(story, EVENT_DOCS_ENFORCER_PASS).value
    persist_story(story, db)
    return HandlerResult(next_state=StoryState(story.state), payload=payload)


def _post_factory_needs_redesign_comment(
    *,
    story: StoryRecord,
    app_config: AppConfig,
    suggestions: list[str],
    last_tail: str,
    software_factory_root: Path,
) -> None:
    """Post a 'factory needs redesign' comment on the direction's tracker issue.

    Operator-loud signal that the chain ran out of dev retries on a small
    story — likely the factory itself needs work (test_implementer wrote
    impossible tests, persona prompt missing context, env/runtime gap,
    etc.) rather than dev needing more chances.

    Best-effort: silently no-ops when ``gh`` isn't on PATH, the direction
    has no tracker_issue recorded, or the call fails. The structured
    event log entry is the durable record; this comment is the surface.
    """
    direction = find_direction_for_story(story, software_factory_root)
    if direction is None:
        return
    tracker = direction.state.get("tracker_issue") if hasattr(direction, "state") else None
    if not tracker:
        return
    repo = f"{app_config.repo_owner}/{app_config.repo_name}"
    body_parts = [
        f"## :warning: factory_needs_redesign — story #{story.id} ({story.slug})",
        "",
        f"Dev exhausted **{story.dev_retries}/{_max_dev_retries(software_factory_root)}** chain-level "
        f"retries with prior-attempt feed-forward enabled. That's a strong "
        f"signal something upstream of dev needs work — not that dev needs more chances.",
        "",
        f"- Branch: `{story.github_branch}`",
        f"- Story slug: `{story.slug}`",
        f"- Direction: `{story.direction_id}`",
        "",
        "### Suggestions",
    ]
    for s in suggestions:
        body_parts.append(f"- {s}")
    if last_tail.strip():
        body_parts += [
            "",
            "### Last test-output tail",
            "```",
            last_tail[-1500:],
            "```",
        ]
    body_parts.append("")
    body_parts.append(f"Inspect via `factory trace {story.id}` for the per-attempt event log.")
    body = "\n".join(body_parts)

    import subprocess

    subprocess.run(
        ["gh", "issue", "comment", str(tracker), "--repo", repo, "--body", body],
        check=False,
        timeout=30,
        capture_output=True,
    )


def _changed_py_lint_scope(
    target_repo: Path, base: str, app_config: AppConfig | None = None
) -> tuple[list[str], list[str], str] | None:
    """``(changed .py files, ruff isolation flags, resolved base ref)``, or ``None``.

    ``None`` means "there is nothing for ruff to do here": the repo/app does not
    use ruff, the base ref could not be resolved, git failed, or the branch
    changed no ``.py`` file.

    Shared by :func:`_autoformat_changed_py_before_pr` (which FIXES what it
    safely can) and :func:`_residual_changed_py_lint` (which REPORTS what is
    left). They MUST agree on both halves or the residual check would grade the
    branch under different rules than the autoformat just applied — and, worse,
    under different rules than the app's own CI lint. Hence one function.

    ``--isolated`` reproduces the app's CI exactly when the app has no ruff
    config of its own: the per-story worktree is physically nested under the
    factory repo, so a bare ``ruff check`` would walk up and pick the FACTORY's
    ``[tool.ruff]`` (line-length 100) instead of the built-in defaults
    (line-length 88) the app's ``ruff check .`` actually runs under. Ruff
    resolves config by nearest ancestor, and the nearest ancestor here is the
    wrong repo.
    """
    import subprocess

    # Only for repos/apps that actually use ruff — otherwise a ``ruff format``
    # would be meaningless / could touch code the repo's own CI does not lint.
    # Detection: a ruff config file, ``[tool.ruff*]`` in pyproject, OR the app's
    # configured lint/format gate command invokes ruff (sacrifice runs
    # default-config ``ruff check .`` with NO ``[tool.ruff]`` table).
    local_config = (target_repo / "ruff.toml").exists() or (target_repo / ".ruff.toml").exists()
    if not local_config:
        pyproject = target_repo / "pyproject.toml"
        if pyproject.exists():
            try:
                # Matches ``[tool.ruff]`` and any sub-table (``[tool.ruff.lint]``,
                # ``[tool.ruff.format]``) — a repo may configure only a sub-table.
                local_config = "[tool.ruff" in pyproject.read_text(encoding="utf-8")
            except OSError:
                local_config = False
    has_ruff = local_config
    if not has_ruff and app_config is not None:
        gate_cmds = " ".join(
            c
            for c in (
                getattr(app_config.gates, "lint_command", None),
                getattr(app_config.gates, "format_check_command", None),
            )
            if c
        )
        has_ruff = "ruff" in gate_cmds
    if not has_ruff:
        return None

    iso = ["--isolated"] if not local_config else []

    # ``origin/<base>`` normally; local ``<base>`` when the worktree has no
    # ``origin`` remote (bench harness / local-only app repo). Same fallback
    # ``_changed_files_for_story`` and the reviewer's pre-PR diff use, so all
    # three agree on "what this branch changed". In production topology this
    # always resolves to ``origin/<base>`` — the fallback only fires where the
    # old hard-coded ``origin/<base>`` silently did nothing at all.
    base_ref = _resolve_diff_base(target_repo, base)
    if base_ref is None:
        return None
    try:
        diff = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
            cwd=str(target_repo),
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=60,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if diff.returncode != 0:
        return None
    py_files = [f for f in diff.stdout.split() if f.endswith(".py") and (target_repo / f).is_file()]
    if not py_files:
        return None
    return py_files, iso, base_ref


# Bound on how much ruff output rides along in the synthetic finding fed back to
# dev. Concise format is one line per violation; 4000 chars is ~50 lines, far
# more than a story's own changed files ever produce, while keeping the dev
# prompt from being swamped by a pathological run.
_RESIDUAL_LINT_MAX_CHARS = 4000


def _residual_changed_py_lint(
    target_repo: Path, base: str, app_config: AppConfig | None = None
) -> str | None:
    """Ruff findings still on the branch's changed ``.py`` files, or ``None``.

    Run AFTER :func:`_autoformat_changed_py_before_pr`, so what comes back is
    exactly what the conservative autoformat could NOT fix for itself — the
    F401 on a MODIFIED line of a PRE-EXISTING file being the shape that opened
    sacrifice story 183's PR lint-red (2026-08-09). The autoformat only ever
    deletes imports the branch itself added; a dev that edits an old file and
    orphans an import there sails past it and past every chain gate, because no
    chain gate runs lint at all — an app's ``lint_command`` /
    ``format_check_command`` are config the chain records but never executes.

    BOTH CI lint commands are reproduced, because an app's CI runs two:
    ``ruff check`` AND ``ruff format --check`` (see ``gates.lint_command`` /
    ``gates.format_check_command`` in ``apps/*/config.yaml``; sacrifice and the
    factory both configure the pair). Checking only the former would still ship
    a PR doomed by a format-only red — the exact failure shape this function
    exists to prevent, one command over.

    VERSION SKEW CAVEAT: ``ruff format`` output is version-dependent, so the
    locally-installed ruff and the app's CI ruff can legitimately disagree about
    what "formatted" means. The consequences are both benign and bounded: a
    local-only red costs at most ONE capped bounce (and the dev is handed the
    concrete file list), and a CI-only red is exactly today's behavior. Do NOT
    "harden" this into anything that can block the PR permanently.

    Same scope and same ruff config as the autoformat (see
    :func:`_changed_py_lint_scope`).

    NEVER raises, and FAILS OPEN (returns ``None``) on anything that is not an
    unambiguous finding report: missing ``uv``/``ruff``, a timeout, a ruff usage
    error (exit 2), an empty report. GitHub CI is the authoritative lint
    backstop; this check is an optimization that saves a doomed PR round-trip.
    Blocking PR creation because the LOCAL ruff is broken would trade a bounded,
    already-handled failure for a new unbounded one.
    """
    import subprocess

    scope = _changed_py_lint_scope(target_repo, base, app_config)
    if scope is None:
        return None
    py_files, iso, _base_ref = scope

    def _probe(args: list[str], label: str) -> str | None:
        """Report text for one ruff command, or ``None`` (clean OR inconclusive)."""
        try:
            proc = subprocess.run(
                args,
                cwd=str(target_repo),
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=180,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            _logger.warning(
                "residual %s skipped (fail-open; GitHub CI remains the backstop): %s", label, exc
            )
            return None
        if proc.returncode == 0:
            return None
        out = (proc.stdout or "").strip()
        if proc.returncode != 1 or not out:
            # Exit 2 = ruff itself errored (bad config, unreadable file); exit 1
            # with no stdout should not happen. Neither is evidence of a real
            # finding, so do not bounce on it.
            _logger.warning(
                "residual %s inconclusive (rc=%s, fail-open): %s",
                label,
                proc.returncode,
                (proc.stderr or "")[-500:],
            )
            return None
        return out

    reports: list[str] = []
    check_out = _probe(
        ["uv", "run", "ruff", "check", "--output-format", "concise", *iso, *py_files],
        "lint check",
    )
    if check_out:
        reports.append(f"$ ruff check\n{check_out}")
    format_out = _probe(
        ["uv", "run", "ruff", "format", "--check", *iso, *py_files],
        "format check",
    )
    if format_out:
        reports.append(f"$ ruff format --check\n{format_out}")
    if not reports:
        return None
    return "\n\n".join(reports)[:_RESIDUAL_LINT_MAX_CHARS]


def _autoformat_changed_py_before_pr(
    target_repo: Path, base: str, app_config: AppConfig | None = None
) -> None:
    """Best-effort: make the story's own changed ``.py`` files ruff-clean and
    commit the result before the PR is opened.

    Two scoped passes on the branch's OWN changed files (never a whole-repo
    reformat):
      1. ``ruff check --fix --select F401`` restricted to imports the BRANCH
         ITSELF added — an unused import the dev just added is safe to delete;
         a pre-existing (possibly side-effect) import is never touched (the file
         is reverted if the fix would remove a line the branch didn't add).
      2. ``ruff check --fix --select I`` (import-sort) + ``ruff format`` — the
         non-semantic nits.

    Rationale: a factory self-edit (PR #57) shipped with an ``I001`` unsorted
    import; sacrifice PRs (#301/#293/#286/#275, 2026-07-21) sat lint-blocked on
    ``F401`` unused imports the dev left in its own new/changed files. The
    chain's pre-merge gates (tests-green / smoke / staging-clone) do NOT run
    ``ruff``, so the nit only surfaced at GitHub's required lint check — blocking
    the merge and, via auto-merge-enabled, stranding the story. Making the
    pushed branch ruff-clean removes that class of false-block.

    Safe: scoped to ``origin/<base>...HEAD`` changed files, F401 only ever
    deletes branch-added imports, no-op when the repo/app doesn't use ruff, and
    NEVER raises — a formatting hiccup must not block PR creation.
    """
    import subprocess

    # Which files, and under which ruff config — see ``_changed_py_lint_scope``.
    # Shared with ``_residual_changed_py_lint`` so "what was fixed" and "what is
    # left" are computed over the identical scope and rules.
    scope = _changed_py_lint_scope(target_repo, base, app_config)
    if scope is None:
        return
    py_files, iso, base_ref = scope

    # Pass 1 — remove the auto-fixable pyflakes nits the dev leaves in its OWN
    # new code, restricted to the branch's OWN added lines. A blanket ``ruff
    # check --fix`` under the full ruleset (E/F/I/W/UP/B) could delete a
    # PRE-EXISTING side-effect import or rewrite typing and, since the code is
    # NOT re-tested after this step, break CI and re-create the strand. So a
    # given rule is fixed in a file ONLY when EVERY violation of that rule sits
    # on a line THIS branch added (decided from ruff's line numbers vs the diff
    # hunks BEFORE fixing). Codes handled: F401 (unused import), F541 (f-string
    # without placeholders), F841 (unused local variable) — exactly the F-class
    # nits a human hand-fixed on #349/#351. A pre-existing violation of any of
    # these is left for the dev loop / CI, never silently mutated here.
    _strip_own_added_fixable_lint(target_repo, base_ref, py_files, iso)

    try:
        # Pass 2 — NON-SEMANTIC nits: import-sorting (``--select I``) plus
        # ``ruff format`` (I001 unsorted imports, missing trailing newline,
        # whitespace) — exactly PR #57's failure. These never change behavior.
        subprocess.run(
            ["uv", "run", "ruff", "check", "--fix", "--select", "I", *iso, *py_files],
            cwd=str(target_repo),
            check=False,
            capture_output=True,
            timeout=180,
        )
        subprocess.run(
            ["uv", "run", "ruff", "format", *iso, *py_files],
            cwd=str(target_repo),
            check=False,
            capture_output=True,
            timeout=180,
        )
    except (subprocess.TimeoutExpired, OSError):
        return

    # Commit only if ruff actually changed something.
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain", *py_files],
            cwd=str(target_repo),
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if status.returncode == 0 and status.stdout.strip():
            # Pathspec-scoped add+commit: only the story's own py files are
            # committed, even if some earlier step left unrelated staged content
            # in the index. The trailing ``-- <files>`` keeps the commit tight.
            subprocess.run(
                ["git", "add", "--", *py_files],
                cwd=str(target_repo),
                check=False,
                capture_output=True,
                timeout=30,
            )
            subprocess.run(
                [
                    "git",
                    "commit",
                    "-m",
                    "style: ruff F401/F541/F841 (own added lines) + isort + format (pre-PR autoformat)",
                    "--",
                    *py_files,
                ],
                cwd=str(target_repo),
                check=False,
                capture_output=True,
                timeout=60,
            )
    except (subprocess.TimeoutExpired, OSError):
        return


def _added_line_numbers(diff_text: str) -> set[int]:
    """New-file line numbers of the lines a unified diff ADDS.

    Walks hunk headers (``@@ -a,b +c,d @@``) and counts ``+``/context lines in
    the new-file coordinate system, so we can ask "was line N added by this
    branch?" positionally — content matching alone is unsafe (a pre-existing
    import can share text with an unrelated branch-added line).
    """
    import re

    added: set[int] = set()
    new_ln = 0
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            new_ln = int(m.group(1)) if m else 0
            continue
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            added.add(new_ln)
            new_ln += 1
        elif line.startswith("-"):
            continue  # old-only line — does not advance the new-file counter
        else:
            new_ln += 1  # context line
    return added


# The auto-fixable pyflakes nits stripped from the story's OWN added lines,
# mapped to whether ruff classifies the fix as "unsafe" (needs ``--unsafe-fixes``).
#   F401 unused import          — safe fix: delete the import.
#   F541 f-string, no placeholder — safe fix: drop the ``f`` prefix.
#   F841 unused local variable   — UNSAFE fix: ruff rewrites ``x = call()`` to a
#        bare ``call()`` (the binding goes, the side-effecting RHS stays), so it
#        is behaviorally safe but ruff still gates it behind ``--unsafe-fixes``.
# (E402 module-import-not-at-top is intentionally absent: ruff ships no autofix
# for it, so nothing to do here — the dev loop / CI reorders those.)
_OWN_LINE_FIXABLE_CODES: dict[str, bool] = {"F401": False, "F541": False, "F841": True}


def _removed_line_numbers(diff_text: str) -> set[int]:
    """OLD-file line numbers of the lines a unified diff REMOVES or ALTERS.

    The mirror of :func:`_added_line_numbers`: walks hunk headers
    (``@@ -a,b +c,d @@``) counting ``-``/context lines in the OLD-file
    coordinate system, so we can ask "which lines of the pre-fix file did this
    change touch?". Used to verify a ``ruff --fix`` only removed/altered lines
    the branch itself added (``git diff HEAD`` old-side == HEAD coordinates,
    the same coordinates :func:`_added_line_numbers` yields for
    ``origin/<base>...HEAD``).
    """
    import re

    removed: set[int] = set()
    old_ln = 0
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            m = re.search(r"-(\d+)", line)
            old_ln = int(m.group(1)) if m else 0
            continue
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("-"):
            removed.add(old_ln)
            old_ln += 1
        elif line.startswith("+"):
            continue  # new-only line — does not advance the old-file counter
        else:
            old_ln += 1  # context line
    return removed


def _strip_own_added_fixable_lint(
    target_repo: Path, base_ref: str, py_files: list[str], iso: list[str]
) -> None:
    """Auto-fix the F-class nits in :data:`_OWN_LINE_FIXABLE_CODES`, but ONLY the
    ones whose EVERY violation sits on a line THIS branch added — decided by line
    number, not text.

    ``base_ref`` is an ALREADY-RESOLVED ref (``_changed_py_lint_scope`` resolves
    it once via ``_resolve_diff_base``) — never a bare branch name to be
    re-prefixed here. One resolution for the whole pre-PR lint path means the
    file list, the added-line hunks and the residual check can never disagree
    about which base they are measuring against.

    Per file: compute the branch's added new-file line numbers (diff hunks vs
    ``<base_ref>...HEAD``); ask ruff for the violations as JSON (their row
    numbers, WITHOUT fixing) in ONE probe while the working tree still equals
    HEAD (so probe rows and diff rows share a coordinate system); then, for each
    candidate code independently, fix it ONLY IF every violation of that code is
    a branch-added row. A code with even one violation on a pre-existing line is
    dropped for this file (a possibly load-bearing side-effect import / a var the
    dev didn't add is never silently mutated; the dev loop / CI handles it).

    Codes are gated INDEPENDENTLY — a pre-existing F841 must not block removing
    the dev's own newly-added F401. Fixes are then applied in a single
    ``ruff --fix`` pass over just the cleared codes. ``--unsafe-fixes`` is added
    only when a code needing it (F841) survives the gate.

    Because a single ``ruff --fix`` pass is ITERATIVE (fixing one violation can
    expose another and fix it too, on a line the input gate never evaluated), a
    RESULT CHECK follows every fix: the applied change is diffed against HEAD and
    the file is reverted whole if the fix removed/altered any line the branch did
    NOT add. The input gate is thus an optimisation; the result check is the
    load-bearing safety guarantee. Best-effort; never raises.
    """
    import json
    import subprocess

    def _run(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(
                args,
                cwd=str(target_repo),
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None

    select_all = ",".join(_OWN_LINE_FIXABLE_CODES)
    for f in py_files:
        diff = _run(["git", "diff", f"{base_ref}...HEAD", "--", f])
        if diff is None or diff.returncode != 0:
            continue
        added = _added_line_numbers(diff.stdout)
        # All candidate violations (code + line number) in the CURRENT (committed)
        # file — one probe, no fix yet, so every row is in HEAD's coordinates.
        probe = _run(
            [
                "uv",
                "run",
                "ruff",
                "check",
                "--select",
                select_all,
                "--output-format",
                "json",
                *iso,
                f,
            ],
            timeout=120,
        )
        if probe is None or not probe.stdout.strip():
            continue
        try:
            violations = json.loads(probe.stdout)
        except (ValueError, TypeError):
            continue
        # rows_by_code[code] = {row numbers of that code's violations in this file}
        rows_by_code: dict[str, set[int]] = {}
        for v in violations:
            if not isinstance(v, dict):
                continue
            code = v.get("code")
            row = v.get("location", {}).get("row")
            if code in _OWN_LINE_FIXABLE_CODES and row is not None:
                rows_by_code.setdefault(code, set()).add(int(row))
        # A code is clearable iff it HAS violations here and every one is on a
        # branch-added line. Codes are independent — one dropped code never
        # blocks another.
        clearable = [c for c, rows in rows_by_code.items() if rows and rows <= added]
        if not clearable:
            continue
        fix_args = ["uv", "run", "ruff", "check", "--fix"]
        if any(_OWN_LINE_FIXABLE_CODES[c] for c in clearable):
            fix_args.append("--unsafe-fixes")
        fix_args += ["--select", ",".join(sorted(clearable)), *iso, f]
        _run(fix_args, timeout=180)

        # RESULT CHECK (not just an input gate): a single ``ruff --fix`` pass is
        # ITERATIVE — resolving one violation can create/expose another and fix
        # THAT too within the same invocation, on a line the per-code gate never
        # evaluated. E.g. removing a branch-added unused local (``x = os``, F841)
        # orphans a PRE-EXISTING ``import os``, and with F401 co-selected ruff
        # then deletes that pre-existing import (adversarial review, PR #105).
        # So verify the APPLIED change touched ONLY branch-added lines: diff the
        # fixed tree against HEAD and require every HEAD line it removed/altered
        # to be a branch-added line. If the fix reached a pre-existing line,
        # revert the whole file — the dev loop / CI handles it, we never ship a
        # silent mutation of code the branch didn't author.
        post = _run(["git", "diff", "HEAD", "--", f])
        if post is not None and post.returncode == 0 and post.stdout.strip():
            touched_head_lines = _removed_line_numbers(post.stdout)
            if not (touched_head_lines <= added):
                _run(["git", "checkout", "HEAD", "--", f])


def _sync_and_push_story_branch(
    target_repo: Path, base: str, branch: str, app_config: AppConfig
) -> None:
    """Re-merge base, prune-fetch, autoformat, then ``--force-with-lease`` push
    the story branch. Raises ``subprocess.CalledProcessError`` /
    ``TimeoutExpired`` / ``FileNotFoundError`` when the PUSH fails (the earlier
    steps are best-effort). Shared by ``_open_pr_for_story`` and the
    PR-less delivery levels (``branch`` / ``push_to_main``) via
    ``_push_story_branch``, so every level pushes exactly the same way.
    """
    import subprocess

    # Sync with the base before pushing. Sibling stories merge
    # continuously, so a branch cut earlier in the day is stale by PR
    # time and its PR arrives conflicted (three operator hand-merges on
    # 2026-06-11). A clean auto-merge here keeps the PR mergeable; on
    # conflict we abort and proceed — the PR opens conflicted and a
    # human resolves it (never silently auto-resolve). Best-effort: a
    # fetch/merge failure must not block PR creation.
    try:
        subprocess.run(
            ["git", "fetch", "origin", base],
            cwd=str(target_repo),
            check=False,
            capture_output=True,
            timeout=60,
        )
        base_merge = subprocess.run(
            ["git", "merge", "--no-edit", f"origin/{base}"],
            cwd=str(target_repo),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if base_merge.returncode != 0:
            subprocess.run(
                ["git", "merge", "--abort"],
                cwd=str(target_repo),
                check=False,
                capture_output=True,
                timeout=60,
            )
    except (subprocess.TimeoutExpired, OSError):
        pass

    # Refresh + PRUNE remote-tracking refs before the lease push. If the
    # feature branch was deleted on origin since this worktree last
    # fetched (e.g. an operator closed a conflicted PR with
    # --delete-branch), the stale local tracking ref makes
    # --force-with-lease reject with "stale info" and PR creation
    # silently fails (story 56, 2026-07-18). A plain single-branch fetch
    # does NOT remove the stale ref — only --prune does.
    subprocess.run(
        ["git", "fetch", "--prune", "origin"],
        cwd=str(target_repo),
        check=False,
        capture_output=True,
        timeout=120,
    )
    # Auto-format the story's own changed .py files (ruff --fix + format)
    # and commit any fixes BEFORE pushing. Trivial lint/format nits (import
    # sort, missing trailing newline) that the dev persona leaves would
    # otherwise fail GitHub's required lint check — which the chain's
    # pre-merge gates (tests-green / smoke / staging) do NOT cover — and,
    # via the auto-merge-enabled path, strand the story at deploy_pending
    # (found 2026-07-21 on the first factory self-edit, PR #57). Best-effort
    # and scoped to changed files, so it never reformats unrelated code and
    # never blocks PR creation.
    _autoformat_changed_py_before_pr(target_repo, base, app_config)
    # Push the branch; gh pr create needs an upstream ref.
    # --force-with-lease: story branches are factory-owned and single-
    # writer, and origin may hold STALE commits from abandoned earlier
    # attempts (pre-rewrite runs pushed work-preservation commits). The
    # locally approved state is authoritative; a plain push gets a
    # non-fast-forward rejection against that stale history (story 5,
    # 2026-06-11). The lease still aborts if origin moved unexpectedly
    # since our last fetch.
    subprocess.run(
        ["git", "push", "--force-with-lease", "-u", "origin", str(branch)],
        cwd=str(target_repo),
        check=True,
        capture_output=True,
        timeout=60,
    )


def _push_story_branch(
    story: StoryRecord, app_config: AppConfig, software_factory_root: Path
) -> bool:
    """Push the story branch WITHOUT opening a PR (delivery levels ``branch``
    and ``push_to_main``). Returns True on success; failures are swallowed and
    reported as False (the caller's bounded retry handles them)."""
    import subprocess

    target_repo = _writing_worktree(app_config, software_factory_root, story)
    base = app_config.default_branch or "main"
    try:
        _sync_and_push_story_branch(target_repo, base, str(story.github_branch), app_config)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as exc:
        try:
            from factory.manager.signals import write_git_event as _wge_err

            _wge_err(
                kind="push",
                story_id=story.id,
                worktree_path=str(target_repo),
                result="error",
                error=repr(exc),
                software_factory_root=software_factory_root,
            )
        except Exception:  # noqa: BLE001
            pass
        return False
    try:
        from factory.manager.signals import write_git_event as _wge

        _wge(
            kind="push",
            story_id=story.id,
            worktree_path=str(target_repo),
            result="ok",
            software_factory_root=software_factory_root,
        )
    except Exception:  # noqa: BLE001
        pass
    return True


def _open_pr_for_story(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    draft: bool = False,
    will_auto_merge: bool = True,
) -> int | None:
    """Push the feature branch and open a PR via the ``gh`` CLI (both chains).

    ``draft=True`` opens a DRAFT PR (delivery level ``draft_pr``); nothing in
    the factory ever marks it ready. ``will_auto_merge=False`` (levels
    ``draft_pr`` / ``pr``, and a refused ``push_to_main``) changes only the
    PR body, so a human reading it is not told a merge worker will land it.

    Returns the PR number on success, ``None`` on any failure. Failures are
    swallowed — the chain still transitions to ``PR_OPEN`` and the operator
    can open the PR by hand from the (already-pushed) branch.

    Uses ``gh`` rather than pygithub because the chain runs locally with
    ``gh auth login`` already configured; no extra token plumbing needed.

    Pushes from the per-story worktree (same one the writing persona ran in)
    rather than the source repo — that's where the branch's HEAD is.
    """
    import subprocess

    target_repo = _writing_worktree(app_config, software_factory_root, story)
    base = app_config.default_branch or "main"
    branch = story.github_branch
    if story.chain_kind == "docs":
        title = f"docs(context): {story.title}"
        summary_line = "Canonical context files added/updated."
    else:
        title = f"feat({story.scope or 'app'}): {story.title}"
        from factory.chain.solo import is_solo

        if is_solo(story):
            summary_line = (
                "Code + tests written by ONE dev agent in a single long conversation "
                "(solo pipeline: no separate reviewer); checked in-conversation by "
                "the app's test command, then by the docs-enforcer and the merge gates."
            )
        else:
            summary_line = (
                "Code + tests written by the dev persona, approved by the reviewer "
                "and docs-enforcer gates."
            )
    from factory.chain.delivery_gate import stack_parent

    parent = stack_parent(story, Path(software_factory_root) / "state" / "factory.db")
    stack_note = (
        f"**Stacked on** `{parent.github_branch}`"
        + (f" (PR #{parent.github_pr_number})" if parent.github_pr_number else "")
        + ": this branch was cut from that earlier, unmerged story of the same job, so "
        "this PR's diff includes its changes. Merge that one first.\n\n"
        if parent is not None
        else ""
    )
    body = (
        stack_note + f"Generated by the factory {story.chain_kind} chain "
        f"({getattr(story, 'pipeline', 'chain') or 'chain'} pipeline) for story "
        f"#{story.github_issue_number}.\n\n"
        f"Branch: `{branch}`\n"
        f"Story slug: `{story.slug}`\n"
        f"Direction: `{story.direction_id}`\n\n"
        + (
            f"{summary_line} The end-of-tick auto-merge worker merges this PR "
            f"when its gates pass (factory_settings.yaml::auto_merge)."
            if will_auto_merge
            else f"{summary_line} Delivery level `{story.delivery_level}`: the factory "
            f"will NOT {'mark this PR ready or ' if draft else ''}merge it — "
            f"a human owns the next step."
        )
    )
    try:
        _sync_and_push_story_branch(target_repo, base, str(branch), app_config)
        # Emit push signal — best-effort.
        try:
            from factory.manager.signals import write_git_event as _wge

            _wge(
                kind="push",
                story_id=story.id,
                worktree_path=str(target_repo),
                result="ok",
                software_factory_root=software_factory_root,
            )
        except Exception:  # noqa: BLE001
            pass

        proc = subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--repo",
                app_config.repo,
                "--base",
                base,
                "--head",
                str(branch),
                "--title",
                title,
                "--body",
                body,
                *(["--draft"] if draft else []),
            ],
            cwd=str(target_repo),
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
    ) as _push_exc:
        # A PR may already exist for this branch (e.g. the story re-reached
        # PR_OPEN after a CI-fix / review re-dispatch). `gh pr create` then
        # exits non-zero with "already exists" — but the story genuinely HAS a
        # PR, so RELINK it: look up the existing PR number and return it.
        # Without this, github_pr_number stays None and the auto-merge / CI-fix
        # machinery can never act on the existing PR (it sits orphaned forever).
        stderr = getattr(_push_exc, "stderr", "") or ""
        if isinstance(_push_exc, subprocess.CalledProcessError) and "already exists" in stderr:
            try:
                existing = subprocess.run(
                    [
                        "gh",
                        "pr",
                        "view",
                        str(branch),
                        "--repo",
                        app_config.repo,
                        "--json",
                        "number",
                        "-q",
                        ".number",
                    ],
                    cwd=str(target_repo),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                num = (existing.stdout or "").strip()
                if existing.returncode == 0 and num.isdigit():
                    try:
                        from factory.manager.signals import write_git_event as _wge_relink

                        _wge_relink(
                            kind="pr_open",
                            story_id=story.id,
                            pr_number=int(num),
                            result="relinked",
                            software_factory_root=software_factory_root,
                        )
                    except Exception:  # noqa: BLE001
                        pass
                    return int(num)
            except (subprocess.SubprocessError, OSError):
                pass
        # Emit error signal — best-effort.
        try:
            from factory.manager.signals import write_git_event as _wge_err

            _wge_err(
                kind="pr_open",
                story_id=story.id,
                worktree_path=str(target_repo),
                result="error",
                error=repr(_push_exc),
                software_factory_root=software_factory_root,
            )
        except Exception:  # noqa: BLE001
            pass
        return None

    # gh prints the PR URL on stdout; parse the trailing digits.
    url = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    # URL shape: https://github.com/<org>/<repo>/pull/<n>
    m = re.search(r"/pull/(\d+)$", url)
    pr_num = int(m.group(1)) if m else None

    # Emit pr_open signal — best-effort.
    try:
        from factory.manager.signals import write_git_event as _wge_pr

        _wge_pr(
            kind="pr_open",
            story_id=story.id,
            pr_number=pr_num,
            result="ok",
            software_factory_root=software_factory_root,
        )
    except Exception:  # noqa: BLE001
        pass

    return pr_num


# --------------------------------------------------------------------------- #
# helpers used by the orchestrator
# --------------------------------------------------------------------------- #


def find_direction_for_story(story: StoryRecord, software_factory_root: Path) -> Direction | None:
    """Look up the parsed Direction record for a story (by direction_id)."""
    for dpath in list_direction_dirs(story.app, software_factory_root):
        if dpath.name.startswith(f"{story.direction_id}-"):
            return parse_direction_dir(
                story.app, dpath, software_factory_root=software_factory_root
            )
    return None


# --------------------------------------------------------------------------- #
# Phase 5 — handle_deploy
# --------------------------------------------------------------------------- #


def _lookup_merged_sha(app: str, pr_number: int, db_path: Path) -> str | None:
    """Return the head_sha of the most-recent merged ``merge_actions`` row.

    Returns ``None`` when no merge has been recorded for this PR yet.
    Imported lazily to avoid a chain → auto_merge import cycle.
    """
    from factory.chain.auto_merge import MergeActionRecord

    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        row = session.exec(
            select(MergeActionRecord)
            .where(
                MergeActionRecord.app == app,
                MergeActionRecord.pr_number == pr_number,
                MergeActionRecord.merged == True,  # noqa: E712
            )
            .order_by(MergeActionRecord.id.desc())  # type: ignore[union-attr]
        ).first()
    if row is None:
        return None
    return row.head_sha


def _close_issues_on_deploy(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    db: Path,
    github_client: Any,
    dry_run: bool,
) -> None:
    """Close a deployed story's GH issue + its direction tracker (when all
    siblings are deployed). Best-effort; never raises. Fixes the accumulation
    of open story/tracker issues for already-shipped work (audit 2026-07-18).

    ``github_client`` is ``None`` on every real call today: the orchestrator's
    ``_invoke_handler`` never passes one to ``handle_deploy``, so this used to
    silently no-op on every deploy (nothing ever closed). When not
    ``dry_run``, self-construct a client via the shared
    ``factory.providers.github.build_github_client`` helper — the same one
    ``factory.cli._ensure_github_client`` uses — rather than requiring the
    caller to thread one through. Missing token is swallowed to a warning:
    bookkeeping must never break deploy.
    """
    if dry_run:
        return
    client = github_client
    if client is None:
        from factory.providers.github import build_github_client

        client = build_github_client()
        if client is None:
            _logger.warning(
                "deploy: no GitHub token available (GITHUB_TOKEN/GH_TOKEN/"
                "gh auth token) — skipping auto-close of story %s issue(s)",
                story.id,
            )
            return
    try:
        from factory.directions.tracker_issue import (
            close_story_issue,
            maybe_close_tracker_issue,
        )

        close_story_issue(story, app_config, client)
        if story.direction_id:
            maybe_close_tracker_issue(
                story.direction_id,
                app_config,
                client,
                software_factory_root=software_factory_root,
                db_path=db,
            )
    except Exception:  # noqa: BLE001 - bookkeeping must never break deploy
        pass


def handle_deploy(
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    fixture_step_outputs: list[tuple[int, str, str]] | None = None,
    fixture_step_outputs_by_phase: dict[str, list[tuple[int, str, str]]] | None = None,
    github_client: Any = None,
) -> HandlerResult:
    """Drive the post-merge deploy for ``story``.

    Pre-conditions: story.state == DEPLOY_PENDING and
    ``story.github_pr_number`` is set. The handler delegates to the deploy
    orchestrator, then flips the story state to DEPLOYED on success,
    BLOCKED_DEPLOY_FAILED on hard failure, or DEPLOYED with skip marker
    when the app has ``deploy.enabled=false``.
    """
    from factory.chain.state_machine import (
        EVENT_DEPLOY_FAILED,
        EVENT_DEPLOY_SKIPPED,
        EVENT_DEPLOY_STARTED,
        EVENT_DEPLOY_SUCCEEDED,
    )
    from factory.deploy.orchestrator import deploy_post_merge

    db = db_path or (software_factory_root / "state" / "factory.db")
    if story.state != StoryState.DEPLOY_PENDING.value:
        return HandlerResult(
            next_state=StoryState(story.state),
            error=f"handle_deploy called from non-deploy_pending state {story.state!r}",
        )
    # ``push_to_main`` lands with NO PR: the auto-merge worker recorded the
    # fast-forward's merge_actions row under the story's placeholder number
    # ``-(story.id)``, so the deploy keys off that instead of skipping.
    deploy_pr_key = story.github_pr_number
    if (
        deploy_pr_key is None
        and story.delivery_level == DeliveryLevel.PUSH_TO_MAIN.value
        and story.id is not None
    ):
        deploy_pr_key = -story.id
    if deploy_pr_key is None:
        # No PR number means we can't deploy a specific SHA; treat as skip.
        story.state = advance(story, EVENT_DEPLOY_SKIPPED).value
        story.error = "deploy_skipped_no_pr_number"
        persist_story(story, db)
        return HandlerResult(next_state=StoryState(story.state), error=story.error)

    # If deploy is disabled, transition to DEPLOYED with skip marker. The
    # orchestrator's deploy_post_merge already records the action row with
    # status="skipped"; we just observe the result here and short-circuit
    # the state.
    if not effective_deploy_enabled(app_config, software_factory_root):
        story.state = advance(story, EVENT_DEPLOY_SKIPPED).value
        persist_story(story, db)
        # This early-return short-circuits before the ``deploy_post_merge``
        # call below, so the reachable-but-only-via-that-path close call a
        # few lines down never runs for apps with deploy.enabled=false
        # (e.g. sacrifice) — the story reaches DEPLOYED here but its GH
        # issues never closed (audit 2026-07-18). Close them here too.
        _close_issues_on_deploy(
            story, app_config, software_factory_root, db, github_client, dry_run
        )
        return HandlerResult(
            next_state=StoryState(story.state),
            payload={"skipped": True, "reason": "deploy_disabled_in_config"},
        )

    # Look up the merged_sha from the ``merge_actions`` row this PR
    # produced. We pick the most-recent ``merged=True`` row for this PR.
    # If no row exists, refuse to dispatch — deploying without knowing
    # the SHA we just merged is a category error (we'd be deploying an
    # unspecified commit). The webhook path inserts a ``merge_actions``
    # row at PR-merged time, and tests can seed one via
    # ``factory.chain.auto_merge.MergeActionRecord`` directly.
    #
    # IMPORTANT: do this BEFORE advancing to deploy_in_progress so the
    # story stays in DEPLOY_PENDING (recoverable) when the SHA isn't
    # there yet. Otherwise we'd advance to deploy_in_progress, leaving
    # the chain with no way to resume that PR's deploy.
    merged_sha = _lookup_merged_sha(story.app, deploy_pr_key, db)
    if merged_sha is None:
        # Allow dry-run a fallback so unit tests that don't seed a
        # merge_actions row can still exercise the success/failure paths.
        if dry_run:
            merged_sha = "pending-sha"
        else:
            err = f"merge SHA not recorded for PR {deploy_pr_key}"
            story.error = err
            persist_story(story, db)
            return HandlerResult(
                next_state=StoryState(story.state),
                error=err,
            )

    # Mark started.
    story.state = advance(story, EVENT_DEPLOY_STARTED).value
    persist_story(story, db)

    action = deploy_post_merge(
        story.app,
        deploy_pr_key,
        merged_sha,
        software_factory_root,
        dry_run=dry_run,
        fixture_step_outputs=fixture_step_outputs,
        fixture_step_outputs_by_phase=fixture_step_outputs_by_phase,
        github_client=github_client,
        db_path=db,
    )

    if action.success:
        story.state = advance(story, EVENT_DEPLOY_SUCCEEDED).value
        story.error = None
        persist_story(story, db)
        _close_issues_on_deploy(
            story, app_config, software_factory_root, db, github_client, dry_run
        )
        return HandlerResult(
            next_state=StoryState(story.state),
            payload={"deploy_action": True, "success": True},
        )

    # Failure (or skipped via pre-flight). If pre-flight skipped (e.g.
    # mode_blocks_deploy), route to DEPLOYED with the marker rather than
    # BLOCKED — the operator hasn't actually deployed yet but the story
    # isn't blocked by code quality.
    if action.error and action.error in {
        "mode_blocks_deploy",
        "deploy_disabled_in_config",
    }:
        story.state = advance(story, EVENT_DEPLOY_SKIPPED).value
        story.error = action.error
        persist_story(story, db)
        # deploy_disabled_in_config still reaches DEPLOYED — the story is done
        # from the chain's perspective, so close its issues too.
        _close_issues_on_deploy(
            story, app_config, software_factory_root, db, github_client, dry_run
        )
        return HandlerResult(
            next_state=StoryState(story.state),
            payload={"skipped": True, "reason": action.error},
        )

    story.state = advance(story, EVENT_DEPLOY_FAILED).value
    story.error = action.error or "deploy_failed_unknown"
    persist_story(story, db)
    return HandlerResult(
        next_state=StoryState(story.state),
        payload={
            "deploy_action": True,
            "rolled_back": action.rolled_back,
            "p0_issue_number": action.p0_issue_number,
        },
        error=story.error,
    )
