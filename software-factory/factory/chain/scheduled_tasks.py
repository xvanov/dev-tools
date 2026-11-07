"""Phase-6 scheduled persona runner + chain integration.

Public entry point: ``run_scheduled_persona(persona, app,
software_factory_root, *, dry_run=False) -> ScheduledRunRecord``.

What the function does:

  1. Loads the persona prompt from ``factory/personas/<persona>.md``.
  2. Composes a context prelude (current-state + module map).
  3. Invokes ``runner.text_run`` (security) or
     ``runner.sandbox_run`` (ux_auditor — needs the browser tool).
  4. Parses the structured JSON output.
  5. For each finding/drift, calls
     ``factory.directions.creator.create_direction`` to file a fresh
     direction directory under ``apps/<app>/directions/``.
  6. Persists a ``ScheduledRunRecord`` row.

Dry-run is truly dry: no LLM call, no GitHub call, no real subprocesses.
The fixture path returns a deterministic ``ScheduledRunOutput`` per
persona so the CLI's ``--dry-run`` flag can exercise the full chain
end-to-end.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Field, Session, SQLModel, create_engine

from factory.directions.creator import create_direction
from factory.directions.parser import Direction
from factory.model_router import route

# --------------------------------------------------------------------------- #
# DB
# --------------------------------------------------------------------------- #


class ScheduledRunRecord(SQLModel, table=True):
    """Per-run audit row for the scheduled personas.

    Recorded for every dispatch — success, failure, or skip. The cron
    scheduler reads these to enforce rate limits.
    """

    __tablename__ = "scheduled_runs"

    id: int | None = Field(default=None, primary_key=True)
    ts: str = Field(default_factory=lambda: datetime.now(UTC).isoformat(), index=True)
    persona: str = Field(index=True)
    app: str = Field(index=True)
    duration_s: float = 0.0
    findings_count: int = 0
    directions_filed_json: str = "[]"  # JSON list of direction ids
    status: str = "ok"  # 'ok' | 'errored' | 'dry_run'
    error: str | None = None
    dry_run: bool = False


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    return eng


# --------------------------------------------------------------------------- #
# Output dataclasses
# --------------------------------------------------------------------------- #


@dataclass
class ScheduledRunOutput:
    """Aggregated result returned to the CLI."""

    persona: str
    app: str
    findings_count: int = 0
    directions_filed: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    status: str = "ok"
    error: str | None = None
    dry_run: bool = False
    raw_output: dict[str, Any] = field(default_factory=dict)


# Personas Phase 6 knows about and the JSON key under which they emit
# findings/drifts. Drives both the dry-run fixture and the live parser.
# (ralph/bug_hunter deleted 2026-08-07 — 019 AC5.)
_PERSONA_FINDINGS_KEY: dict[str, str] = {
    "security": "findings",
    "ux_auditor": "findings",
}

# Strict cap on output tokens per persona.
_OUTPUT_TOKEN_CAP: dict[str, int] = {
    "security": 3000,
    "ux_auditor": 3000,
}


# --------------------------------------------------------------------------- #
# Dry-run fixtures
# --------------------------------------------------------------------------- #


def _dry_run_fixture(persona: str, app: str) -> dict[str, Any]:
    """Deterministic per-persona fixture used by ``--dry-run`` paths.

    Each fixture mirrors the persona's documented output schema so the
    direction-creator and DB-record code paths exercise the same shapes
    they would on a real run.
    """
    if persona == "security":
        return {
            "threat_model_summary": (
                "Fixture: app posture appears defense-in-depth at the "
                "auth layer but missing rate limits on /api/pledge."
            ),
            "findings": [
                {
                    "asset": "pledge integrity",
                    "actor": "authenticated user",
                    "path": (
                        "Endpoint /api/pledge has no rate limit; "
                        "an authenticated user can flood pledges, "
                        "corrupting goal totals."
                    ),
                    "severity": "medium",
                    "evidence": ["backend/api/pledge.py:30"],
                    "mitigation": "add per-user rate limit on /api/pledge",
                    "suggested_direction": {
                        "title": "rate-limit /api/pledge",
                        "type": "security",
                        "why": (
                            "Security dry-run fixture: pledge flooding can corrupt goal totals."
                        ),
                        "acceptance": [
                            "POST /api/pledge returns 429 after >5 pledges/min per user",
                        ],
                    },
                }
            ],
            "runs_completed": ["threat_model:dry_run"],
            "duration_s": 0.01,
        }
    if persona == "ux_auditor":
        return {
            "findings": [
                {
                    "flow": "pledge-flow.md",
                    "step": 4,
                    "kind": "friction",
                    "evidence": (
                        "Fixture: getByRole('button', name='Confirm') "
                        "requires 6 clicks to confirm a single pledge."
                    ),
                    "suggestion": "collapse the confirmation sub-flow to 2 clicks",
                    "suggested_direction": {
                        "title": "collapse pledge confirmation to 2 clicks",
                        "type": "ux",
                        "why": (
                            "UX-auditor dry-run fixture: confirmation flow "
                            "is 6 clicks for a 2-click task."
                        ),
                        "acceptance": [
                            "User can confirm a pledge in <= 2 clicks from the goal page",
                        ],
                    },
                }
            ],
            "duration_s": 0.01,
        }
    return {"findings": [], "duration_s": 0.0}


# --------------------------------------------------------------------------- #
# Direction filing
# --------------------------------------------------------------------------- #


def _slugify_title(title: str) -> str:
    import re

    s = re.sub(r"[^A-Za-z0-9]+", "-", title.strip().lower()).strip("-")
    return (s[:40] or "scheduled-finding").strip("-") or "scheduled-finding"


# Statuses that mean a direction is finished/abandoned — a new duplicate for
# the same issue is fine once the prior one is closed out.
_TERMINAL_DIRECTION_STATUSES = frozenset(
    {"done", "complete", "completed", "merged", "abandoned", "superseded", "cancelled"}
)


def _normalize_title(title: str) -> str:
    return " ".join(title.lower().split())


# Stopgap semantic dedup (audit 2026-07-18, leak 3 of 4): scheduler personas
# invent a fresh title every run for the SAME underlying finding ("Add CSRF
# protections to cookie-auth API routes" vs "...API flows"), so the
# exact-title check in ``_has_open_duplicate_direction`` lets duplicates
# through (CSRF filed as 2 directions, SSRF as 2, OAuth as 4, observed
# live). Rather than touch the persona prompt or add a schema field, extract
# a small, precise set of stable keywords from the normalized title+body and
# treat a new finding as a duplicate of an EXISTING NON-TERMINAL direction
# for the same app + same ``source`` + same ``type`` if they share a
# keyword. Deliberately narrow — only named, specific terms trigger a
# match, never generic words — so unrelated findings (e.g. csrf vs a11y)
# never collapse into each other.
_DEDUP_KEYWORD_GROUPS: dict[str, tuple[str, ...]] = {
    "csrf": ("csrf",),
    "ssrf": ("ssrf",),
    "oauth": ("oauth",),
    "xss": ("xss", "cross-site scripting"),
    "authz": (
        "authz",
        "authorization",
        "object-level authorization",
        "access control",
        "object level authorization",
    ),
    "rate-limit": ("rate limit", "rate-limit", "rate limiting", "throttl", "abuse control"),
    "webhook": ("webhook",),
    "replay": ("replay",),
    "redaction": ("redact", "secret leak", "secret exposure", "secret sprawl"),
    "a11y": ("accessib", "a11y"),
    "proof-schema": ("proof schema", "proof-schema"),
}


def _extract_dedup_keywords(text: str) -> set[str]:
    """Extract the small set of stable dedup keywords present in ``text``.

    Case-insensitive substring match against ``_DEDUP_KEYWORD_GROUPS``.
    Returns the set of canonical keyword ids (e.g. ``{"csrf"}``) whose any
    trigger phrase appears in ``text``. Empty text or no matches -> empty
    set, which never dedups anything (precise-by-default).
    """
    normalized = text.lower()
    return {
        keyword
        for keyword, triggers in _DEDUP_KEYWORD_GROUPS.items()
        if any(trigger in normalized for trigger in triggers)
    }


def _has_open_duplicate_direction(
    app: str,
    title: str,
    software_factory_root: Path,
    *,
    source: str | None = None,
    type_tag: str | None = None,
    body: str = "",
) -> bool:
    """True if an existing non-terminal direction is a duplicate of this finding.

    Two independent checks, either of which is sufficient:

      1. Exact match: a non-terminal direction with the same normalized
         title exists (original guard, app-wide — unchanged behavior when
         ``source``/``type_tag`` are omitted).
      2. Semantic (stopgap): when ``source`` and ``type_tag`` are both
         given, a non-terminal direction for the same app + same
         ``source`` + same ``type`` whose title+body shares a dominant
         dedup keyword (see ``_DEDUP_KEYWORD_GROUPS``) with this finding's
         title+body.

    Scans ``apps/<app>/directions/*/`` reading each direction.md
    title/body and state.yaml status/source directly (cheap, no full
    parse). Errors on any single directory are ignored so a malformed
    sibling never blocks filing.
    """
    import frontmatter as _frontmatter
    import yaml as _yaml

    target = _normalize_title(title)
    target_keywords = _extract_dedup_keywords(f"{title}\n{body}")
    directions_dir = Path(software_factory_root) / "apps" / app / "directions"
    if not directions_dir.is_dir():
        return False
    for d in directions_dir.iterdir():
        md = d / "direction.md"
        if not md.is_file():
            continue
        try:
            post = _frontmatter.load(str(md))
            metadata = post.metadata or {}
            existing_title = str(metadata.get("title") or "")

            state_path = d / "state.yaml"
            status = "created"
            existing_source: Any = None
            if state_path.is_file():
                state = _yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
                status = str(state.get("status", "created"))
                existing_source = state.get("source")
            if status in _TERMINAL_DIRECTION_STATUSES:
                continue

            if _normalize_title(existing_title) == target:
                return True

            if (
                target_keywords
                and source is not None
                and type_tag is not None
                and existing_source == source
                and str(metadata.get("type") or "") == type_tag
            ):
                existing_body = str(getattr(post, "content", "") or "")
                existing_keywords = _extract_dedup_keywords(f"{existing_title}\n{existing_body}")
                if target_keywords & existing_keywords:
                    return True
        except Exception:
            continue
    return False


def _file_finding_as_direction(
    *,
    persona: str,
    app: str,
    finding: dict[str, Any],
    software_factory_root: Path,
    dry_run: bool = False,
) -> Direction | None:
    """Create a direction directory for one finding. Returns the parsed Direction.

    Falls back gracefully if the finding lacks a ``suggested_direction``
    block (returns ``None``).

    When ``dry_run`` is True, the direction is written to a scratch
    directory under ``<software_factory_root>/state/dry_run_scratch/`` so
    the canonical ``apps/<app>/directions/`` tree is NOT polluted. The
    parser still reads it so the caller sees a real ``Direction`` and
    asserts the same shape it would on a real run.
    """
    suggested = finding.get("suggested_direction")
    if not isinstance(suggested, dict):
        return None
    title = str(suggested.get("title") or "").strip()
    type_tag = str(suggested.get("type") or "bug").strip()
    why = str(suggested.get("why") or "").strip()
    acceptance_raw = suggested.get("acceptance") or []
    acceptance = [str(a) for a in acceptance_raw if str(a).strip()]
    if not title or not why:
        return None

    # Dedup guard. Scheduled personas re-run on a schedule and re-surface the
    # same finding until it's fixed; without this an unresolved issue spawns a
    # new near-identical direction every run (observed 2026-07-06: ~38 duplicate
    # "resolve conflicted navigation context" directions). If a non-terminal
    # direction with the same normalized title already exists for this app,
    # skip filing another. Also catches the same finding re-titled slightly
    # differently each run (e.g. "...API routes" vs "...API flows") via the
    # keyword-based semantic check — see ``_has_open_duplicate_direction``.
    # (Real runs only — dry-run writes to a scratch tree.)
    if not dry_run and _has_open_duplicate_direction(
        app,
        title,
        software_factory_root,
        source=f"scheduled-{persona}",
        type_tag=type_tag,
        body=why,
    ):
        return None
    target_root = software_factory_root
    if dry_run:
        # Route every write under state/dry_run_scratch/ so apps/<app>/
        # directions/ remains untouched on dry-run paths.
        scratch = Path(software_factory_root) / "state" / "dry_run_scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        target_root = scratch
        # next_direction_id scans target_root/apps/<app>/directions/, so
        # ensure it exists.
        (scratch / "apps" / app / "directions").mkdir(parents=True, exist_ok=True)
    # UX auditor findings carry flow + step data; surface a flow.md so the
    # next slice (citation/parsing) has concrete filenames and step numbers
    # to reference. All other personas stay as-is — their findings are not
    # UI-specific.
    has_ui = persona == "ux_auditor"
    flow_steps: list[str] | None = None
    if has_ui:
        flow_name = str(finding.get("flow") or "").strip()
        step = finding.get("step")
        evidence = str(finding.get("evidence") or "").strip()
        suggestion = str(finding.get("suggestion") or "").strip()
        steps: list[str] = []
        if flow_name:
            steps.append(f"Flow: {flow_name}")
        if isinstance(step, int):
            steps.append(f"Step: {step}")
        if evidence:
            steps.append(f"Evidence: {evidence}")
        if suggestion:
            steps.append(f"Suggestion: {suggestion}")
        if steps:
            flow_steps = steps

    created = create_direction(
        app,
        title=title,
        type_tag=type_tag,
        why=why,
        has_ui=has_ui,
        flow_steps=flow_steps,
        has_api=False,
        api_spec_lines=None,
        acceptance=acceptance,
        # Scheduled personas (security/ux_auditor) file findings the
        # factory itself should investigate and fix. They have no
        # user_flow/api_spec — a bug report isn't a feature spec — so with
        # explore=False they ALWAYS failed the backpressure gate and produced
        # zero stories (observed 2026-07-06: every scheduled-* direction stuck
        # at needs-direction, nothing ever built). explore=True is the correct
        # channel: "here's a problem, investigate and fix it", which the PM can
        # decompose without a spec. This is what makes idle bug-hunting actually
        # ship fixes instead of accumulating dead directions.
        explore=True,
        attach_files=None,
        software_factory_root=target_root,
        source=f"scheduled-{persona}{'-dry' if dry_run else ''}",
    )
    return created.direction


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #


def run_scheduled_persona(
    persona: str,
    app: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    db_path: Path | None = None,
    fixture_output: dict[str, Any] | None = None,
) -> ScheduledRunOutput:
    """Execute one scheduled persona run.

    On ``dry_run=True`` no LLM is called, no GH issue is opened, and the
    canonical ``apps/<app>/directions/`` tree is NOT mutated — directions
    are written to ``<root>/state/dry_run_scratch/apps/<app>/directions/``
    so the CLI's --dry-run is end-to-end testable without API keys or
    pollution. The ``cron_schedules.last_run`` column is also untouched
    on a dry-run; only real runs update it. Pass ``fixture_output`` to
    override the default per-persona fixture.

    On real-run, ``text_run`` is invoked with the persona prompt + the
    composed context prelude; the output is parsed as JSON and findings
    are filed.

    Rate-limit gate runs FIRST: ``can_dispatch(persona, app, state,
    settings)`` consults the per-persona daily-run cap recorded in
    ``factory_settings.yaml`` (``rate_limits.<persona>_runs_per_day``).
    When refused, the run records a ``rejected`` row with the canonical
    ``rejected_reason`` and returns immediately (no LLM, no directions).
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    started = datetime.now(UTC)
    findings_key = _PERSONA_FINDINGS_KEY.get(persona)
    if findings_key is None:
        return _record_and_return(
            persona=persona,
            app=app,
            duration_s=0.0,
            findings_count=0,
            directions_filed=[],
            status="errored",
            error=f"unknown_scheduled_persona: {persona!r}",
            dry_run=dry_run,
            raw_output={},
            db_path=db,
        )

    # Rate-limit gate. Phase 6 personas (security/ux_auditor) each have a
    # per-day cap in
    # ``factory_settings.yaml.rate_limits``; ``can_dispatch`` returns
    # ``rejected_reason="<persona>_rate_limit_exceeded"`` when the cap is
    # hit. Runs that are refused are recorded with status="rejected" so
    # the audit trail captures the attempt.
    from factory.settings.enforcer import can_dispatch
    from factory.settings.loader import load_settings
    from factory.settings.modes import get_mode
    from factory.settings.spend import (
        hour_spend_usd,
        persona_runs_today,
        today_spend_usd,
    )

    if persona in _PERSONA_FINDINGS_KEY:
        settings = load_settings(root)
        state = {
            "mode": get_mode(root, db_path=db),
            "global_in_flight": 0,
            "app_in_flight": 0,
            "today_spend_usd": today_spend_usd(root, db_path=db),
            "hour_spend_usd": hour_spend_usd(root, db_path=db),
            "open_prs_for_app": None,
            "failing_ci_count": None,
            "pm_invocations_last_hour": 0,
            f"{persona}_runs_today": persona_runs_today(persona, root, db_path=db),
        }
        decision = can_dispatch(persona, app, state, settings)
        if not decision.allowed:
            duration = (datetime.now(UTC) - started).total_seconds()
            return _record_and_return(
                persona=persona,
                app=app,
                duration_s=duration,
                findings_count=0,
                directions_filed=[],
                status="rejected",
                error=decision.rejected_reason,
                dry_run=dry_run,
                raw_output={},
                db_path=db,
            )

    raw: dict[str, Any]
    error: str | None = None
    if dry_run:
        raw = fixture_output if fixture_output is not None else _dry_run_fixture(persona, app)
    else:
        # UX auditor gate: skip the run when no flow.md artifacts are
        # available. A replay-based UX audit without concrete flow steps
        # is evidence-free and not useful. This gate runs before the LLM
        # call so we never spend tokens on a no-evidence audit.
        if persona == "ux_auditor" and not _collect_flow_artifacts(app, root):
            duration = (datetime.now(UTC) - started).total_seconds()
            return _record_and_return(
                persona=persona,
                app=app,
                duration_s=duration,
                findings_count=0,
                directions_filed=[],
                status="rejected",
                error="ux_auditor_no_flow_artifacts",
                dry_run=False,
                raw_output={},
                db_path=db,
            )
        try:
            raw = _live_run(persona, app, root)
        except Exception as exc:  # noqa: BLE001 - capture all exceptions for audit
            duration = (datetime.now(UTC) - started).total_seconds()
            return _record_and_return(
                persona=persona,
                app=app,
                duration_s=duration,
                findings_count=0,
                directions_filed=[],
                status="errored",
                error=str(exc),
                dry_run=False,
                raw_output={},
                db_path=db,
            )

    findings = raw.get(findings_key) or []
    if not isinstance(findings, list):
        findings = []

    directions_filed: list[str] = []
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        try:
            direction = _file_finding_as_direction(
                persona=persona,
                app=app,
                finding=finding,
                software_factory_root=root,
                dry_run=dry_run,
            )
        except Exception as exc:  # noqa: BLE001 - one bad finding shouldn't kill the run
            error = f"direction_create_failed: {exc}"
            continue
        if direction is not None:
            directions_filed.append(direction.id)

    duration = (datetime.now(UTC) - started).total_seconds()
    return _record_and_return(
        persona=persona,
        app=app,
        duration_s=duration,
        findings_count=len(findings),
        directions_filed=directions_filed,
        status="dry_run" if dry_run else "ok",
        error=error,
        dry_run=dry_run,
        raw_output=raw,
        db_path=db,
    )


def _record_and_return(
    *,
    persona: str,
    app: str,
    duration_s: float,
    findings_count: int,
    directions_filed: list[str],
    status: str,
    error: str | None,
    dry_run: bool,
    raw_output: dict[str, Any],
    db_path: Path,
) -> ScheduledRunOutput:
    eng = _engine(db_path)
    rec = ScheduledRunRecord(
        persona=persona,
        app=app,
        duration_s=round(duration_s, 4),
        findings_count=findings_count,
        directions_filed_json=json.dumps(directions_filed),
        status=status,
        error=error,
        dry_run=dry_run,
    )
    with Session(eng) as session:
        session.add(rec)
        session.commit()
        session.refresh(rec)
    # Update the schedule's last-run timestamp so the cron scheduler
    # doesn't re-fire this slot. Best-effort; failure here is recorded
    # but doesn't fail the run.
    #
    # Dry-run is truly dry: NEVER mutate cron_schedules.last_run on a
    # dry-run path. Otherwise an operator probing with --dry-run could
    # cause the real cron loop to think a slot already fired and skip it.
    if not dry_run:
        try:
            from factory.scheduler.cron import load_schedules, upsert_schedule_row

            for sched in load_schedules(Path(db_path).parent.parent):
                if sched.persona == persona:
                    upsert_schedule_row(
                        name=sched.name,
                        cron_expr=sched.cron_expr,
                        last_run=datetime.now(UTC).isoformat(),
                        last_status=status,
                        db_path=db_path,
                    )
        except Exception:  # noqa: BLE001 - schedule update is best-effort
            pass
    return ScheduledRunOutput(
        persona=persona,
        app=app,
        findings_count=findings_count,
        directions_filed=directions_filed,
        duration_s=round(duration_s, 4),
        status=status,
        error=error,
        dry_run=dry_run,
        raw_output=raw_output,
    )


def _collect_flow_artifacts(app: str, software_factory_root: Path) -> list[tuple[str, str]]:
    """Collect flow.md files from all direction directories for ``app``.

    Returns a list of (label, content) tuples. The label is
    ``<direction-id-slug>/flow.md`` so the UX auditor can cite it by name.
    Empty directories and missing files are silently skipped.
    """
    directions_dir = Path(software_factory_root) / "apps" / app / "directions"
    if not directions_dir.is_dir():
        return []
    artifacts: list[tuple[str, str]] = []
    for d in sorted(directions_dir.iterdir()):
        if not d.is_dir():
            continue
        flow_md = d / "flow.md"
        if not flow_md.is_file():
            continue
        try:
            content = flow_md.read_text(encoding="utf-8").strip()
            if content:
                artifacts.append((f"{d.name}/flow.md", content))
        except Exception:  # noqa: BLE001 - best-effort collection
            continue
    return artifacts


def _collect_tests_meaningful_findings(
    app: str, software_factory_root: Path
) -> list[dict[str, object]]:
    """Collect reproducible ``tests-meaningful`` slop findings for ``app``.

    Scans test files under ``apps/<app>/repo/`` using the slop detector.
    Returns a list of ``SlopFinding.as_dict()`` payloads — deterministic
    for a given set of test files on disk.
    """
    from factory.chain.slop_detector import scan_file

    repo_dir = Path(software_factory_root) / "apps" / app / "repo"
    if not repo_dir.is_dir():
        return []

    findings: list[dict[str, object]] = []
    repo_root_resolved = repo_dir.resolve()
    for py_file in sorted(repo_dir.rglob("test_*.py")):
        try:
            for fnd in scan_file(py_file):
                payload = fnd.as_dict()
                finding_path = Path(str(payload.get("path", ""))).resolve()
                try:
                    payload["path"] = finding_path.relative_to(repo_root_resolved).as_posix()
                except ValueError:
                    payload["path"] = str(payload.get("path", ""))
                findings.append(payload)
        except Exception:  # noqa: BLE001 - best-effort collection
            continue
    findings.sort(key=lambda item: (str(item.get("path", "")), int(item.get("line", 0))))
    return findings


def _extract_http_urls(text: str) -> list[str]:
    """Return distinct HTTP(S) URLs found in arbitrary shell text."""
    import re

    matches = re.findall(r"https?://[^\s`\"')]+", text)
    return sorted({m.rstrip(".,;:") for m in matches})


def _build_ux_auditor_context(app: str, software_factory_root: Path) -> str:
    """Build UX-auditor runtime input context for scheduled dispatch.

    The scheduled UX run MUST carry at least one concrete ``flow.md`` artifact;
    if none are available, the scheduler refuses dispatch instead of sending a
    guess-based prompt.
    """
    from datetime import UTC, datetime

    from factory.app_config import load_app_config

    parts: list[str] = ["## Scheduled UX Audit Runtime Inputs\n"]

    # -- Flow artifacts (AC1.1) --
    flow_artifacts = _collect_flow_artifacts(app, software_factory_root)
    if not flow_artifacts:
        raise ValueError(
            f"scheduled ux_auditor input for app '{app}' requires at least one flow.md artifact"
        )

    parts.append("\n### Flow Artifacts\n")
    parts.append(
        f"_Collected {len(flow_artifacts)} flow.md file(s) from prior directions. "
        "Use these concrete filenames and numbered steps during the audit._\n"
    )
    for label, content in flow_artifacts:
        parts.append(f"\n#### {label}\n")
        parts.append(content + "\n")

    # -- Gate findings: tests-meaningful (D017) --
    parts.append("\n### Gate Findings\n")
    gate_findings = _collect_tests_meaningful_findings(app, software_factory_root)
    if gate_findings:
        parts.append(
            f"_Collected {len(gate_findings)} `tests-meaningful` slop finding(s) "
            "from the app's test files. Each finding names the file, line, "
            "rule id (kind), and remediation suggestion._\n"
        )
        for fnd in gate_findings:
            parts.append(
                f"\n- **Rule**: `{fnd['kind']}`\n"
                f"  - **File**: `{fnd['path']}`\n"
                f"  - **Line**: {fnd['line']}\n"
                f"  - **Remediation**: {fnd['why_slop']}\n"
            )
    else:
        parts.append("_No `tests-meaningful` slop findings detected in the app's test files._\n")

    # -- App URL context (AC1.2) --
    parts.append("\n### App URL Context\n")
    try:
        cfg = load_app_config(app, software_factory_root)
        parts.append(f"- App name: `{cfg.name}`\n")
        parts.append(f"- Repo: `{cfg.repo}`\n")

        url_candidates: list[str] = []
        if cfg.deploy.health_check_command:
            url_candidates.extend(_extract_http_urls(cfg.deploy.health_check_command))
        if cfg.deploy.smoke_test_command:
            url_candidates.extend(_extract_http_urls(cfg.deploy.smoke_test_command))

        if cfg.deploy.enabled:
            parts.append("- Deploy: **enabled**\n")
            if cfg.deploy.health_check_command:
                parts.append(f"  - Health check command: `{cfg.deploy.health_check_command}`\n")
            if url_candidates:
                for url in sorted(set(url_candidates)):
                    parts.append(f"  - App URL candidate: `{url}`\n")
            else:
                parts.append("  - App URL candidate: not declared in deploy commands\n")
        else:
            parts.append("- Deploy: **disabled** (no live URL configured)\n")
    except Exception:  # noqa: BLE001 - best-effort
        parts.append("- (could not load app config)\n")

    # -- Runtime context (AC1.3) --
    parts.append("\n### Runtime Context\n")
    parts.append(f"- Timestamp (UTC): `{datetime.now(UTC).isoformat()}`\n")
    parts.append(f"- Software factory root: `{software_factory_root}`\n")
    parts.append(f"- Target app: `{app}`\n")
    parts.append("- Scheduler transport: `text_run`\n")

    return "".join(parts)


def _live_run(persona: str, app: str, software_factory_root: Path) -> dict[str, Any]:
    """Compose context + persona prompt + dispatch via runner.

    Security/ux_auditor both use ``text_run`` for v1; the
    sandbox path (browser tool) is reserved for a future ux_auditor
    enhancement when the live deploy URL exists.
    """
    from factory.app_config import load_app_config, resolve_app_repo_path
    from factory.context.loader import compose_context_prelude
    from factory.runner import text_run

    cfg = load_app_config(app, software_factory_root)
    prelude = compose_context_prelude(
        persona,
        app_repo_path=resolve_app_repo_path(cfg, software_factory_root),
        task_scope=None,
    )
    # Go through the loader rather than reading the file directly: it strips
    # frontmatter (which must never reach the model) and raises on a missing
    # persona instead of silently degrading to an empty prompt. The old
    # ``if exists() else ""`` meant a typo'd or deleted persona produced a
    # scheduled run with NO system prompt that still cost money and still wrote
    # its findings back as if authoritative.
    from factory.personas.loader import read_persona_prompt

    persona_prompt = read_persona_prompt(persona)

    # UX auditor: enrich the prompt with flow artifacts, app URL, and runtime context.
    if persona == "ux_auditor":
        ux_context = _build_ux_auditor_context(app, software_factory_root)
        prompt = f"{persona_prompt}\n\n{ux_context}\n\n# Context prelude\n\n{prelude}\n"
    elif persona == "security":
        # The persona prompt requires a route citation before any "X is missing"
        # claim. It has NO tools — this is a ``text_run`` — so that rule is
        # unenforceable unless the route table is in the prompt. Without it, the
        # only auth facts reaching this persona are prose "remaining gaps"
        # bullets, and one stale bullet re-filed shipped password reset five
        # times (memory: stale_context_doc_refiles_shipped_work), then five more
        # directions on 2026-08-10.
        from factory.directions.route_premise import render_route_table_block

        route_table = render_route_table_block(app, software_factory_root)
        prompt = f"{persona_prompt}\n\n{route_table}\n\n# Context prelude\n\n{prelude}\n"
    else:
        prompt = f"{persona_prompt}\n\n# Context prelude\n\n{prelude}\n"

    model = route(persona)
    max_tokens = _OUTPUT_TOKEN_CAP.get(persona, 2048)
    result = text_run(
        persona,
        prompt,
        model,
        schema={"type": "object"},
        max_tokens=max_tokens,
        # These app-level personas (security/ux_auditor) run
        # ahead of any story, so story_id/direction_id are legitimately
        # unknown here — but ``app`` IS known and must be stamped so
        # ``factory audit`` can roll spend up per app instead of leaving it
        # in the unattributed bucket.
        app=app,
    )
    if isinstance(result, dict):
        return result
    # text_run returned a raw string (schema not respected); try to parse.
    try:
        parsed = json.loads(result)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}
