"""PM-sync pipeline — direction → tracker issue.

For each pending direction in ``apps/<app>/directions/``:

0. Operator-approval gate: a MACHINE-FILED direction (any
   ``scheduled-<persona>`` source, any other machine filer, or a direction
   whose source cannot be determined) is skipped until an operator approves
   it — see ``factory.directions.approval`` and ``factory approve-direction``.
   Human-filed directions skip straight to step 1, exactly as before.
1. Parse the directory → ``Direction`` record.
2. Fast pre-check via ``backpressure.validator.validate_direction``.
3. Insufficient → ``record_needs_direction`` + status = ``needs-direction``.
4. Sufficient → invoke PM persona via ``text_run`` with the direction body +
   the canonical context prelude (loader from Phase 0).
5. Persist the PM JSON response under ``pm_result`` in ``state.yaml``.
6. ``open_or_update_tracker_issue`` (idempotent).
7. Status → ``pm-validated`` (Phase 2 spawns child story issues from
   ``pm_result.child_stories``).

``dry_run=True`` is a PURE PREVIEW — it skips the LLM and GitHub calls AND
makes no persistent mutation: no ``state.yaml`` write (status/pm_result stay
as-is), no ``runs`` row, no StoryRecord persisted, no GC close on disk. It
only computes what the real run WOULD decide and returns it in the summary
(``pm_result`` from a deterministic fixture, ``gc_closed`` as the would-close
list). This makes dry-run repeatable and, crucially, incapable of spawning
live dispatchable work: a "safe" preview that flipped a direction to
``pm-validated`` and persisted rebuild-stories once caused the 2026-07-20
self-tick incident. The real (non-dry) run is the only writer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.app_config import (
    AppConfig,
    load_app_config,
    resolve_app_repo_path,
    targets_factory_repo,
)
from factory.backpressure.validator import ValidationResult, validate_direction
from factory.context.loader import compose_context_prelude
from factory.directions.approval import approval_blocked_reason, is_auto_buildable
from factory.directions.parser import Direction, MissingDirection, resolve_direction_chain
from factory.directions.tracker_issue import (
    open_or_update_tracker_issue,
    record_needs_direction,
)
from factory.directions.watcher import (
    mark_direction_status,
    merge_state,
    pending_directions,
)
from factory.model_router import route

_PM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": [
        "type",
        "priority",
        "has_sufficient_backpressure",
        "missing",
        "tracker_title",
        "tracker_body",
        "child_stories",
        "labels",
        "confidence",
    ],
    "properties": {
        "type": {
            "type": "string",
            "enum": [
                "feature",
                "bug",
                "security",
                "refactor",
                "deploy",
                "chore",
                "infra",
                "ux",
                "docs",
            ],
        },
        "priority": {"type": "string", "enum": ["p0", "p1", "p2", "p3"]},
        "has_sufficient_backpressure": {"type": "boolean"},
        "missing": {"type": "array", "items": {"type": "string"}},
        "tracker_title": {"type": "string"},
        "tracker_body": {"type": "string"},
        "child_stories": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["title", "scope", "rationale"],
                "properties": {
                    "title": {"type": "string"},
                    "scope": {
                        "type": "string",
                        "enum": ["frontend", "backend", "infra", "test", "docs"],
                    },
                    # ``chain_kind`` decides which chain variant runs for the
                    # story: the historical TDD pipeline or the lightweight
                    # docs path. Optional in the schema for backward compat;
                    # the handler defaults missing values to ``"tdd"``.
                    "chain_kind": {"type": "string", "enum": ["tdd", "docs"]},
                    "rationale": {"type": "string"},
                    # Size estimates per the PM persona's hard sizing rule.
                    # Used by ``_validate_story_sizes`` to reject oversized
                    # stories and re-prompt the PM. Optional (legacy PM runs
                    # don't emit them) — when absent, the validator treats
                    # them as 0 (passes) and logs a warning so the operator
                    # can spot under-instrumented decomposition.
                    "estimated_new_files": {"type": "integer", "minimum": 0},
                    "estimated_modified_files": {"type": "integer", "minimum": 0},
                    "estimated_sandbox_iterations": {"type": "integer", "minimum": 0},
                    # Phase 3 EBS: Fibonacci difficulty points the
                    # estimator uses to project ETA. Optional — when
                    # absent, the chain defaults to 3 (median bucket)
                    # and the estimator emits a wider error band.
                    "points": {"type": "integer", "enum": [1, 2, 3, 5, 8, 13]},
                },
            },
        },
        "labels": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
    },
}


@dataclass
class PMSyncSummary:
    processed: int = 0
    validated: int = 0
    needs_direction: int = 0
    errors: list[tuple[str, str]] = field(default_factory=list)
    # Direction ids closed by the stale-scheduled-direction GC pass (see
    # ``factory.directions.gc``) this pm-sync run. Empty unless one or more
    # scheduler-filed directions crossed the GC threshold.
    gc_closed: list[str] = field(default_factory=list)
    # ``(direction_id, reason)`` for every pending direction this pass REFUSED
    # to triage because it was machine-filed and no operator has approved it
    # (see ``factory.directions.approval``). These are not errors and not
    # ``processed`` — they are parked, and surfaced to the operator by
    # ``factory inbox`` / ``factory approve-direction``.
    awaiting_approval: list[tuple[str, str]] = field(default_factory=list)


def _build_pm_prompt(direction: Direction, context_prelude: str) -> str:
    """Construct the user-message prompt for the PM persona text_run."""
    flow_text = ""
    api_text = ""
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

    parts: list[str] = []
    parts.append(context_prelude.rstrip())
    parts.append("\n---\n# Direction\n")
    parts.append(f"id: {direction.id}\nslug: {direction.slug}\napp: {direction.app}\n")
    parts.append(f"frontmatter: {json.dumps(direction.raw_frontmatter, default=str)}\n")
    parts.append("\n## direction.md\n")
    parts.append(direction.raw_body.rstrip())
    if flow_text:
        parts.append("\n\n## flow.md\n")
        parts.append(flow_text.rstrip())
    if api_text:
        parts.append("\n\n## api_spec.md\n")
        parts.append(api_text.rstrip())
    if direction.artifacts_paths:
        parts.append("\n\n## artifacts/ (filenames only)\n")
        for p in direction.artifacts_paths:
            parts.append(f"- {p.name}")
    return "\n".join(parts)


def _dry_run_pm_result(direction: Direction, validation: ValidationResult) -> dict[str, Any]:
    """Deterministic stub PM result for dry-run mode.

    Mirrors the structural validation: if backpressure is sufficient, emits a
    plausible "validated" record; otherwise emits a "needs-direction" record
    with the validator's missing list. No LLM call; no randomness.
    """
    typ = direction.type_tag or "feature"
    priority_default = "p1" if typ in {"security", "bug"} else "p2"
    priority = direction.raw_frontmatter.get("priority") or priority_default

    title_short = direction.title[:60]
    tracker_title = f"[DIRECTION] {title_short}"
    if len(tracker_title) > 69:
        tracker_title = tracker_title[:66] + "..."

    if validation.is_valid:
        child_stories: list[dict[str, str]] = []
        # Docs-typed directions get a single ``chain_kind: "docs"`` story by
        # default — the dry-run fixture mirrors what a live PM call would
        # emit for a context-bootstrap or onboarder-style direction. The
        # docs path skips test_design/test_impl/dev entirely.
        if typ == "docs":
            child_stories.append(
                {
                    "title": title_short,
                    "scope": "docs",
                    "chain_kind": "docs",
                    "rationale": "Documentation-only direction; routed through the docs chain.",
                    "points": 2,
                }
            )
        else:
            if direction.has_api_spec:
                child_stories.append(
                    {
                        "title": f"Implement API: {title_short}",
                        "scope": "backend",
                        "chain_kind": "tdd",
                        "rationale": "Direction declares an API contract; one backend story to implement it.",
                        "points": 3,
                    }
                )
            if direction.has_flow:
                child_stories.append(
                    {
                        "title": f"Implement UI flow: {title_short}",
                        "scope": "frontend",
                        "chain_kind": "tdd",
                        "rationale": "Direction declares a user flow; one frontend story to implement it.",
                        "points": 3,
                    }
                )
        if not child_stories:
            child_stories.append(
                {
                    "title": title_short,
                    "scope": "backend",
                    "chain_kind": "tdd",
                    "rationale": "Explore-tagged direction; single backend story as a starting point.",
                    "points": 3,
                }
            )
        return {
            "type": typ,
            "priority": priority,
            "has_sufficient_backpressure": True,
            "missing": [],
            "tracker_title": tracker_title,
            "tracker_body": (
                f"**{direction.title}**\n\n{(direction.why or '_(no why captured)_').strip()}\n"
            ),
            "child_stories": child_stories,
            "labels": [typ, f"priority/{priority}"],
            "confidence": 0.75,
        }
    return {
        "type": typ,
        "priority": priority,
        "has_sufficient_backpressure": False,
        "missing": validation.missing,
        "tracker_title": tracker_title,
        "tracker_body": (
            f"**{direction.title}**\n\n"
            f"_(needs more backpressure: {', '.join(validation.missing)})_\n"
        ),
        "child_stories": [],
        "labels": [typ, f"priority/{priority}", "needs-direction"],
        "confidence": 0.4,
    }


# --------------------------------------------------------------------------- #
# Story sizing — enforce the PM persona's hard size rule
# --------------------------------------------------------------------------- #


# Per-story size ceilings the chain rejects on. Aligned with the PM persona
# prompt's hard sizing rule; any single child_story exceeding these gets sent
# back to the PM for further decomposition. Picked from observed dev-pass
# budgets: dev sandbox has a 600-iteration default with up to 10 chain
# retries, so a 200-iteration single-story estimate leaves ample headroom.
MAX_NEW_FILES_PER_STORY = 5
MAX_MODIFIED_FILES_PER_STORY = 2
MAX_SANDBOX_ITERATIONS_PER_STORY = 200

# Cap on how many times the chain will re-prompt the PM with size feedback
# before accepting whatever it returns. Each re-prompt is a fresh LLM call;
# small bound keeps cost predictable without giving up after one try.
MAX_PM_REDECOMPOSITION_RETRIES = 3


def _story_size_violations(child_story: dict[str, Any]) -> list[str]:
    """Return a human-readable list of size violations for one child_story.

    Empty list means the story fits. Missing/None estimates are treated as
    zero (assumed-fine) but logged via the returned ``"missing_estimate_..."``
    sentinel so the operator can spot under-instrumented PM output.
    """
    violations: list[str] = []
    nf = child_story.get("estimated_new_files")
    mf = child_story.get("estimated_modified_files")
    it = child_story.get("estimated_sandbox_iterations")
    if nf is None:
        violations.append("missing_estimate_new_files")
    elif isinstance(nf, int) and nf > MAX_NEW_FILES_PER_STORY:
        violations.append(
            f"estimated_new_files={nf} exceeds max {MAX_NEW_FILES_PER_STORY}"
        )
    if mf is None:
        violations.append("missing_estimate_modified_files")
    elif isinstance(mf, int) and mf > MAX_MODIFIED_FILES_PER_STORY:
        violations.append(
            f"estimated_modified_files={mf} exceeds max {MAX_MODIFIED_FILES_PER_STORY}"
        )
    if it is None:
        violations.append("missing_estimate_sandbox_iterations")
    elif isinstance(it, int) and it > MAX_SANDBOX_ITERATIONS_PER_STORY:
        violations.append(
            f"estimated_sandbox_iterations={it} exceeds max "
            f"{MAX_SANDBOX_ITERATIONS_PER_STORY}"
        )
    return violations


def _validate_pm_story_sizes(pm_result: dict[str, Any]) -> dict[int, list[str]]:
    """Return ``{story_index: [violations]}`` for stories that exceed limits.

    Skips when ``has_sufficient_backpressure`` is False (no stories spawn
    anyway) or ``child_stories`` is empty. Missing-estimate sentinels are
    included so the operator can see when PM is emitting unsized output.
    """
    if not pm_result.get("has_sufficient_backpressure"):
        return {}
    out: dict[int, list[str]] = {}
    for idx, story in enumerate(pm_result.get("child_stories") or []):
        violations = _story_size_violations(story)
        # Treat the "missing_estimate_*" sentinels as soft warnings — they
        # don't trigger re-prompts on their own (back-compat with PMs that
        # haven't been updated to emit the fields). Only real-exceed
        # violations gate the re-prompt loop.
        hard = [v for v in violations if not v.startswith("missing_estimate_")]
        if hard:
            out[idx] = hard
    return out


def _format_redecomposition_feedback(violations: dict[int, list[str]]) -> str:
    """Compose the operator-visible feedback string the chain hands back to PM."""
    lines = [
        "## Chain feedback — story sizes exceed dev's per-pass budget",
        "",
        "Your previous decomposition included stories that are too large for a",
        "single dev sandbox pass. The chain rejects oversized stories so dev",
        "doesn't burn retry budget on un-completable slices. Re-decompose the",
        "flagged stories into smaller vertical slices and re-emit the full PM",
        "JSON.",
        "",
        "Per-story size ceilings (HARD):",
        f"  - estimated_new_files ≤ {MAX_NEW_FILES_PER_STORY}",
        f"  - estimated_modified_files ≤ {MAX_MODIFIED_FILES_PER_STORY}",
        f"  - estimated_sandbox_iterations ≤ {MAX_SANDBOX_ITERATIONS_PER_STORY}",
        "",
        "Flagged stories from your last output:",
    ]
    for idx, vs in sorted(violations.items()):
        lines.append(f"  - story[{idx}]: {'; '.join(vs)}")
    lines.append("")
    lines.append(
        "Re-emit the full PM JSON with every child_story now within the limits."
    )
    return "\n".join(lines)


def _call_pm_persona(
    direction: Direction,
    app_repo_path: Path,
    software_factory_root: Path,
    model_overrides: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Real LLM call. Returns the parsed PM JSON result.

    Loops up to ``MAX_PM_REDECOMPOSITION_RETRIES`` times when the returned
    ``child_stories`` exceed the chain's per-story size ceilings, threading
    structured feedback through to each retry so the PM can correct.
    """
    # Import lazily so dry-run paths don't pull litellm.
    from factory.runner import text_run

    persona = "pm"
    persona_prompt = _read_persona_prompt(persona)

    chain = _resolve_chain_for_direction(direction, software_factory_root)
    context_prelude = compose_context_prelude(
        persona=persona,
        app_repo_path=app_repo_path,
        direction_chain=chain,
        software_factory_root=software_factory_root,
    )
    direction_block = _build_pm_prompt(direction, context_prelude)

    base_prompt = (
        f"{persona_prompt.rstrip()}\n\n"
        "---\n\n"
        "## Input\n\n"
        f"{direction_block}\n\n"
        "---\n\n"
        "Return the JSON object for this direction. No prose outside the JSON."
    )
    # Per-job/app override (job > app > routes.yaml), already validated by
    # ``resolve_for_direction`` in the caller.
    if model_overrides and (
        model_overrides.get(f"{persona}.standard") or model_overrides.get(persona)
    ):
        from factory.model_router import route_with_overrides

        model_id = route_with_overrides(persona, "standard", model_overrides)
    else:
        model_id = route(persona)

    feedback: str | None = None
    last_result: dict[str, Any] | None = None
    for attempt in range(1, MAX_PM_REDECOMPOSITION_RETRIES + 2):
        # On retries, prepend the chain's structured feedback so the PM sees
        # what failed and re-decomposes accordingly. The persona prompt's
        # sizing rule already covers the policy; this just surfaces which
        # specific stories tripped it.
        full_prompt = base_prompt
        if feedback is not None:
            full_prompt = f"{base_prompt}\n\n---\n\n{feedback}\n"

        # Cap output tokens at 2048 — PM JSON is small.
        result = text_run(
            persona=persona,
            prompt=full_prompt,
            model_id=model_id,
            schema=_PM_SCHEMA,
            max_tokens=2048,
        )
        if not isinstance(result, dict):
            # text_run only returns str when schema is None; treat anything
            # else as failure.
            raise RuntimeError("PM text_run returned a non-dict for schema-mode call")

        last_result = result
        violations = _validate_pm_story_sizes(result)
        if not violations:
            return result
        if attempt > MAX_PM_REDECOMPOSITION_RETRIES:
            break
        feedback = _format_redecomposition_feedback(violations)

    # Out of retries — return the last result with the violations recorded
    # so downstream code can see we tried. Operators surface these via
    # ``factory why`` / the tracker body.
    assert last_result is not None
    last_result.setdefault("_chain_warnings", []).append(
        {
            "kind": "story_sizes_exceeded_after_retries",
            "retries_used": MAX_PM_REDECOMPOSITION_RETRIES,
            "violations": _validate_pm_story_sizes(last_result),
        }
    )
    return last_result


def _resolve_chain_for_direction(
    direction: Direction,
    software_factory_root: Path,
) -> list[Direction | MissingDirection] | None:
    """Resolve the direction chain for ``direction``, returning ``None`` if no
    ``parent_direction`` is set (avoids a useless single-element list)."""
    if not direction.parent_direction:
        return None
    return resolve_direction_chain(direction, software_factory_root)


def _read_persona_prompt(persona: str) -> str:
    from factory.runner import _read_persona_prompt as _rpp

    return _rpp(persona)


def pm_sync(
    app: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    github_client: Any = None,
    state_db_path: Path | None = None,
    pending_statuses: frozenset[str] = frozenset({"created", "needs-direction"}),
    run_gc: bool = True,
) -> PMSyncSummary:
    """Run the PM-sync pipeline once for ``app``. Returns a summary record.

    ``pending_statuses`` narrows which pending directions are processed.
    The default (operator-invoked ``factory pm-sync``) re-validates
    ``needs-direction`` entries too, so an operator who just fleshed out a
    direction gets it re-checked. Automated callers should pass
    ``frozenset({"created"})`` — re-validating an unchanged insufficient
    direction on every tick only re-posts the same tracker-issue comment.

    ``run_gc=False`` skips this call's own stale-scheduled-direction GC pass
    (see ``factory.directions.gc``). ``maybe_auto_pm_sync`` runs GC itself
    independently of the ``created``-gate that decides whether it calls into
    this function at all, then passes ``run_gc=False`` here to avoid running
    the GC pass twice in the same tick. Manual ``factory pm-sync`` callers
    should leave this at the default ``True``.
    """
    root = Path(software_factory_root)
    db_path = state_db_path or (root / "state" / "factory.db")

    app_config: AppConfig | None = None
    try:
        app_config = load_app_config(app, root)
    except FileNotFoundError as exc:
        # Hard error — without a config we don't know the GitHub repo.
        # Dry-run still works (no GH calls), but real-run cannot.
        if not dry_run:
            raise RuntimeError(f"Cannot run pm-sync without app config: {exc}") from exc

    # In real-run, the GitHub client is required.
    if not dry_run and github_client is None:
        raise RuntimeError(
            "github_client is required for real pm-sync; pass --dry-run for offline use"
        )

    # Self-tick guard (Tier 3 — FACTORY-SELF-TICK). The factory building its OWN
    # repo (apps/factory) is OFF by default: while ``self_tick_enabled`` is
    # False we do NOT turn apps/factory directions into chain stories, so merely
    # bootstrapping apps/factory (config + directions on disk) never silently
    # starts the factory ticking on itself. The orchestrator flips the flag to
    # enable self-improvement deliberately. Non-factory apps are unaffected
    # (the guard only triggers for the factory's own repo). The chain-side
    # staging gate is a SEPARATE, always-on protection — this guard only decides
    # whether self-improvement work enters the chain at all.
    if (
        app_config is not None
        and targets_factory_repo(app_config.repo)
        and not app_config.self_tick_enabled
    ):
        return PMSyncSummary()

    summary = PMSyncSummary()
    candidates = [
        d for d in pending_directions(app, root, db_path) if d.status in pending_statuses
    ]

    # Operator-approval gate (2026-07-30). A direction the FACTORY filed for
    # itself — every ``scheduled-<persona>`` source, any other machine filer,
    # and (fail-safe) any direction whose source cannot be determined — does
    # not enter the build pipeline until an operator approves it. This is the
    # single door from direction → stories, so gating here covers the automated
    # tick (``maybe_auto_pm_sync``) AND a manual ``factory pm-sync``: a habit of
    # running pm-sync by hand must not be a way around the gate. Human-filed
    # directions are unaffected. See ``factory.directions.approval``.
    pending: list[Direction] = []
    for direction in candidates:
        if is_auto_buildable(direction):
            pending.append(direction)
            continue
        summary.awaiting_approval.append(
            (direction.id or direction.slug, approval_blocked_reason(direction))
        )
    summary.processed = len(pending)

    # App repo path for the context prelude. Phase 7 resolves this via the
    # app's ``config.yaml::app_repo_path`` (default ``../<name>``); on
    # operator-typical layouts that's a sibling of the factory root.
    # If the path doesn't exist on disk yet, the loader returns the
    # NO_CONTEXT_AVAILABLE notice cleanly.
    # ``load_app_config`` may raise FileNotFoundError when the apps/ entry
    # for this app doesn't exist (e.g. test fixtures without a config) —
    # the earlier ``app_config = load_app_config(...)`` block has already
    # handled that case, so reuse the loaded record when available.
    if app_config is not None:
        app_repo_path = resolve_app_repo_path(app_config, root)
    else:
        # Dry-run path with no on-disk config: synthesize a stub.
        app_repo_path = root / "apps" / app

    for direction in pending:
        try:
            validation = validate_direction(direction)

            if not validation.is_valid:
                # Dry-run is a PURE PREVIEW: it must not mutate any persistent
                # state (no state.yaml write, no runs row, no GitHub call). A
                # dry-run that flips a direction's status or records a pm row
                # is the proxy!=real footgun that once let a "safe" preview
                # spawn live rebuild-stories (2026-07-20 self-tick incident).
                # We still compute pm_result so the returned summary reflects
                # exactly what the real run would decide.
                pm_result = _dry_run_pm_result(direction, validation)
                if not dry_run:
                    assert app_config is not None and github_client is not None
                    record_needs_direction(
                        direction,
                        validation.missing,
                        app_config,
                        github_client,
                        pm_result=pm_result,
                        detail_lines=validation.issues,
                    )
                    merge_state(
                        direction,
                        {
                            "pm_result": pm_result,
                            "validation_issues": validation.issues,
                            # Top-level (not just the mark_direction_status audit
                            # entry) so state.yaml carries the named reason —
                            # including "vacuous_criteria" when the vacuity gate
                            # (019 AC1) blocked — at a glance, mirroring
                            # ``validation_issues`` above.
                            "missing": validation.missing,
                        },
                    )
                    mark_direction_status(
                        direction,
                        "needs-direction",
                        by="factory.chain.pm_sync",
                        details={"missing": validation.missing},
                    )
                summary.needs_direction += 1
                continue

            # Per-job routing (operator decision 2026-11-02): refuse a bad
            # ``models``/``pipeline`` request BEFORE spending a PM call on it.
            # ``handle_stories_spawned`` re-resolves (and binds) at spawn.
            from factory.job_routing import JobRoutingError, resolve_for_direction

            try:
                job_routing = resolve_for_direction(
                    direction, app_config or AppConfig(name=app, repo="<dry-run>")
                )
            except JobRoutingError as routing_exc:
                if not dry_run:
                    merge_state(
                        direction,
                        {
                            "job_routing_error": {
                                "code": routing_exc.code,
                                "message": routing_exc.message,
                            },
                            "missing": ["job_routing"],
                        },
                    )
                    mark_direction_status(
                        direction,
                        "needs-direction",
                        by="factory.chain.pm_sync",
                        details={"missing": ["job_routing"], "code": routing_exc.code},
                    )
                summary.needs_direction += 1
                summary.errors.append(
                    (
                        direction.id or direction.slug,
                        f"job-routing[{routing_exc.code}]: {routing_exc.message}",
                    )
                )
                continue

            # Backpressure is sufficient — invoke PM persona (or fixture).
            # Dry-run stays a pure preview: no PM LLM call, no state.yaml
            # write, no runs row, no GitHub issue — it only computes what the
            # real run WOULD do and surfaces it in the returned summary.
            if dry_run:
                pm_result = _dry_run_pm_result(direction, validation)
            else:
                pm_result = _call_pm_persona(
                    direction, app_repo_path, root, job_routing.model_overrides
                )
                merge_state(direction, {"pm_result": pm_result})
                assert app_config is not None and github_client is not None
                # Some-vacuous-some-positive (Flow A step 4): triage proceeds,
                # but the vacuous criteria still surface as warnings on the
                # tracker issue rather than vanishing silently.
                extra_sections = (
                    ["## Warnings\n\n" + "\n".join(f"- {w}" for w in validation.structural_issues)]
                    if validation.structural_issues
                    else None
                )
                open_or_update_tracker_issue(
                    direction,
                    app_config,
                    github_client,
                    pm_result=pm_result,
                    software_factory_root=root,
                    extra_sections=extra_sections,
                )
                mark_direction_status(
                    direction,
                    "pm-validated",
                    by="factory.chain.pm_sync",
                    details={"confidence": pm_result.get("confidence")},
                )
            summary.validated += 1

            # Spawn StoryRecord rows for each child_story in pm_result.
            # In dry-run, no GitHub issue is created; story_file_path uses
            # a placeholder issue number of 0. In real-run, the chain
            # opens the GH issue and uses the real number.
            try:
                from factory.chain.handlers import handle_stories_spawned

                if app_config is None and not dry_run:
                    raise RuntimeError("app config required for real-run spawn")
                # In dry-run we still need an AppConfig stub for the handler
                # signature; build a minimal one from the app name if missing.
                spawn_config: AppConfig
                if app_config is not None:
                    spawn_config = app_config
                else:
                    spawn_config = AppConfig(name=app, repo="<dry-run>")
                handle_stories_spawned(
                    direction=direction,
                    pm_result=pm_result,
                    app_config=spawn_config,
                    software_factory_root=root,
                    dry_run=dry_run,
                    db_path=db_path,
                    github_client=github_client,
                )
            except Exception as spawn_exc:
                # Don't fail pm-sync on a spawn error; record it.
                summary.errors.append(
                    (direction.id or direction.slug, f"story-spawn: {spawn_exc!r}")
                )

        except Exception as exc:  # pragma: no cover - exercised in error tests
            summary.errors.append((direction.id or direction.slug, repr(exc)))

    # GC pass: close scheduler-filed directions that have sat unactioned at
    # needs-direction past the threshold (audit 2026-07-18, leak 2 of 4).
    # Best-effort — a GC failure must never fail the pm-sync pass it rides
    # along with. Skipped when the caller (``maybe_auto_pm_sync``) already
    # ran GC itself this tick — see ``run_gc``'s docstring.
    if run_gc:
        try:
            from factory.directions.gc import gc_stale_scheduled_directions

            summary.gc_closed = gc_stale_scheduled_directions(
                app,
                root,
                app_config,
                github_client,
                dry_run=dry_run,
            )
        except Exception as gc_exc:  # noqa: BLE001 - GC is a side pass, never fatal
            summary.errors.append(("__gc__", repr(gc_exc)))

    return summary


def _pm_runs_last_hour(db_path: Path) -> int:
    """Count real ``pm`` persona rows recorded in the last hour."""
    import sqlite3
    from datetime import UTC, datetime, timedelta

    if not db_path.exists():
        return 0
    cutoff = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    try:
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM runs WHERE persona='pm' AND ts > ?",
                (cutoff,),
            ).fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except sqlite3.OperationalError:
        # Fresh DB without a runs table yet — nothing has run.
        return 0


def maybe_auto_pm_sync(
    app: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    github_client_factory: Any = None,
    state_db_path: Path | None = None,
) -> tuple[PMSyncSummary | None, str]:
    """Tick-driven auto-triage of pending directions.

    Directions filed by the scheduled personas (or ``factory tell``) used to
    sit in ``status: created`` until an operator remembered to run
    ``factory pm-sync`` — generated work rotted at the inbox. When
    ``auto_pm_sync.enabled`` is set, every tick calls this; it runs the
    pm-sync pipeline only when there is something to triage and the
    ``pm_invocations_per_hour`` budget (measured from real ``pm`` rows in the
    runs table) has headroom, so an erroring direction can't burn spend by
    being retriaged on every tick.

    ``github_client_factory`` is called (no args) only when a real sync will
    actually run, so ticks on hosts without GitHub credentials don't fail
    when there's nothing to triage.

    Only ``status: created`` directions are auto-triaged. ``needs-direction``
    entries are deliberately excluded from the LLM-heavy pm-sync pipeline:
    they failed backpressure validation and re-validating them unchanged
    every tick just re-posts the same "Needs direction" comment on their
    tracker issues (observed live 2026-06-11: 15 stuck directions x one
    comment per 5-minute tick). They are re-checked by an operator-invoked
    ``factory pm-sync`` after the missing artifacts are added.

    The stale-scheduled-direction GC pass (``factory.directions.gc``) is the
    one exception: it runs on every tick regardless of whether a ``created``
    direction is pending, BEFORE the ``created``-gate below. GC is pure
    filesystem work (plus an optional best-effort GitHub issue-close) — no
    LLM call — so it doesn't need to wait behind the same gate that protects
    the expensive pm-sync pipeline. Previously GC only rode along inside
    ``pm_sync()``, which this function only reached when a ``created``
    direction existed; a backlog of stale ``needs-direction`` directions
    with nothing fresh alongside meant GC never fired on the automated tick
    (audit 2026-07-18).

    Machine-filed directions (``scheduled-<persona>`` and friends) are NOT
    auto-triaged: they wait for ``factory approve-direction``. See
    ``factory.directions.approval`` and the gate inside ``pm_sync``.

    Returns ``(summary_or_None, reason)`` with reason in
    {"disabled", "no_pending", "awaiting_approval", "rate_limited", "synced"}.
    """
    from datetime import UTC, datetime

    from factory.directions.gc import gc_stale_scheduled_directions, is_gc_eligible
    from factory.settings.loader import load_settings

    root = Path(software_factory_root)
    db_path = state_db_path or (root / "state" / "factory.db")

    settings = load_settings(root)
    if not settings.auto_pm_sync.enabled:
        return None, "disabled"

    pending = pending_directions(app, root, db_path)

    # GC pass — independent of the ``created``-gate, see docstring above.
    # Only bothers loading the app config / GitHub client when at least one
    # direction actually crosses the GC threshold, so a tick with nothing
    # pending (or nothing GC-eligible) still never touches GitHub — hosts
    # without credentials must not fail on an idle queue.
    now = datetime.now(UTC)
    github_client: Any = None
    if any(is_gc_eligible(d, now=now) for d in pending):
        gc_app_config = None
        if not dry_run:
            try:
                gc_app_config = load_app_config(app, root)
            except FileNotFoundError:
                gc_app_config = None
            if github_client_factory is not None:
                github_client = github_client_factory()
        try:
            gc_stale_scheduled_directions(
                app,
                root,
                gc_app_config,
                github_client,
                dry_run=dry_run,
                now=now,
            )
        except Exception:  # noqa: BLE001 - GC is a side pass, never fatal
            pass

    auto_statuses = frozenset({"created"})
    fresh = [d for d in pending if d.status in auto_statuses]
    if not fresh:
        return None, "no_pending"

    # Operator-approval gate. ``pm_sync`` re-applies this (it is the
    # authoritative choke point) — repeating it here buys two things: no LLM
    # budget is consumed and no GitHub client is constructed for a tick whose
    # only pending work is parked, and the tick reports a DISTINCT
    # ``awaiting_approval`` reason instead of a silent ``synced`` with zero
    # processed, so the park is visible in the tick output.
    if not any(is_auto_buildable(d) for d in fresh):
        return None, "awaiting_approval"

    if _pm_runs_last_hour(db_path) >= settings.rate_limits.pm_invocations_per_hour:
        return None, "rate_limited"

    if github_client is None and not dry_run and github_client_factory is not None:
        github_client = github_client_factory()

    summary = pm_sync(
        app=app,
        software_factory_root=root,
        dry_run=dry_run,
        github_client=github_client,
        state_db_path=db_path,
        pending_statuses=auto_statuses,
        run_gc=False,
    )
    return summary, "synced"
