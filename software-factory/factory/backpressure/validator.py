"""Structural validation on top of completeness.

``compute_completeness`` answers "does the direction have the right *kinds* of
artifacts?". ``validate_direction`` adds the next layer: are those artifacts
actually usable? A ``flow.md`` that's empty fails. An ``api_spec.md`` with no
endpoint line fails.

The chain consumes the ``ValidationResult`` for its pre-check. The PM persona
may still override if the structural check is overly strict for an edge case
(e.g. a single-line api_spec like ``DELETE /thing → 204``).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from factory.backpressure.parser import (
    compute_completeness,
    has_meaningful_api_spec,
    has_meaningful_flow,
)
from factory.backpressure.vacuity import VacuityAssessment, assess_direction
from factory.directions.parser import Direction

logger = logging.getLogger(__name__)

_HTTP_METHOD_RE = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b", re.IGNORECASE)
_PATH_RE = re.compile(r"(?:^|\s)/[A-Za-z0-9_\-./{}]+")


@dataclass
class ValidationResult:
    is_valid: bool
    missing: list[str] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    # Structural issues are NOT fatal: PM may still proceed but the chain
    # records them so the tracker issue can ask the user for richer
    # backpressure. ``severity`` summarises:
    #   * ``ok``       — everything passed (no missing, no structural issues)
    #   * ``warning``  — sufficient, but flow.md or api_spec.md is "thin"
    #   * ``blocking`` — direction is insufficient; PM cannot proceed
    structural_issues: list[str] = field(default_factory=list)
    severity: str = "ok"
    has_flow: bool = False
    has_api_spec: bool = False
    has_acceptance: bool = False
    explore_tag: bool = False
    # Vacuity gate (019 AC1 / Flow A). ``None`` when acceptance is empty (the
    # gate has nothing to classify) or the classifier crashed and degraded to
    # "no verdict" — see ``factory.backpressure.vacuity.assess_direction``.
    vacuity: VacuityAssessment | None = None


def _read_or_empty(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _flow_md_useful(content: str) -> tuple[bool, str | None]:
    """True if flow.md has at least one numbered or bulleted step line."""
    body = "\n".join(ln for ln in content.splitlines() if not ln.strip().startswith("<!--"))
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    has_step = re.search(r"(?m)^\s*(?:\d+\.\s+\S|[-*]\s+\S)", body) is not None
    if not has_step:
        return False, "flow.md has no numbered or bulleted step lines"
    return True, None


def _api_spec_useful(content: str) -> tuple[bool, str | None]:
    """True if api_spec.md mentions an HTTP method AND a path."""
    body = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL)
    if not _HTTP_METHOD_RE.search(body):
        return False, "api_spec.md has no HTTP method (GET/POST/...)"
    if not _PATH_RE.search(body):
        return False, "api_spec.md has no path (starts with /)"
    return True, None


def validate_direction(direction: Direction) -> ValidationResult:
    """Combine ``compute_completeness`` with structural file-content checks."""
    rep = compute_completeness(direction)
    issues: list[str] = []
    structural_issues: list[str] = []
    has_flow = rep.has_flow
    has_api_spec = rep.has_api_spec

    if rep.has_flow:
        ok, msg = _flow_md_useful(_read_or_empty(direction.dir_path / "flow.md"))
        if not ok:
            has_flow = False
            if msg:
                issues.append(msg)
        else:
            # Flow exists and parses as steps — but is it MEANINGFUL? A flow
            # of two unverbed bullets isn't enough for the Test-Designer to
            # build E2E coverage. Record as a structural issue, not a fatal.
            if not has_meaningful_flow(direction):
                structural_issues.append(
                    "flow.md has steps but is thin (fewer than 2 user-visible verbs)"
                )

    if rep.has_api_spec:
        ok, msg = _api_spec_useful(_read_or_empty(direction.dir_path / "api_spec.md"))
        if not ok:
            has_api_spec = False
            if msg:
                issues.append(msg)
        else:
            # Same logic for api_spec: method+path passed, but is there a
            # response code declared? Without one, Test-Designer can't
            # assert correctness.
            if not has_meaningful_api_spec(direction):
                structural_issues.append(
                    "api_spec.md has method+path but no response code (e.g. 200/400)"
                )

    is_sufficient = has_flow or has_api_spec or rep.explore_tag
    missing = list(rep.missing)
    if not is_sufficient:
        # Re-compute missing under the stricter check.
        missing = []
        if not has_flow:
            missing.append("user_flow")
        if not has_api_spec:
            missing.append("api_spec")
        if not rep.explore_tag:
            missing.append("explore_tag_or_artifacts")
        if not rep.has_acceptance:
            missing.append("acceptance_criteria")

    # Vacuity gate (019 AC1 / Flow A step 2-4): run only when there ARE
    # acceptance criteria to classify — an empty set is already reported as
    # missing ``acceptance_criteria`` above and the gate has nothing to say
    # about it. Wrapped so an internal classifier exception can never block a
    # direction: ``assess_direction`` itself already degrades to "no verdict"
    # on a crash, but we log here too since this is the only call site that
    # knows it's on the triage-blocking path.
    vacuity: VacuityAssessment | None = None
    if direction.acceptance:
        try:
            vacuity = assess_direction(direction.acceptance)
        except Exception as exc:  # noqa: BLE001 - fail-safe: never block on a crash
            logger.warning(
                "vacuity classifier crashed for direction %s; degrading to no verdict: %r",
                direction.id_slug,
                exc,
            )
            vacuity = None

        if vacuity is not None and vacuity.error is not None:
            logger.warning(
                "vacuity classifier crashed for direction %s; degrading to no verdict: %s",
                direction.id_slug,
                vacuity.error,
            )

        if vacuity is not None and vacuity.all_vacuous and not rep.explore_tag:
            # Blocking path — but NEVER for an explore-tagged direction (F2/F3):
            # `explore: true` exists precisely so machine-filed repair/finding
            # directions (scheduled personas, ci_health.py, scheduled_tasks.py)
            # aren't wedged at needs-direction when their acceptance criteria
            # are terse (the 2026-07-06 incident this tag was introduced to
            # fix). An explore-tagged all-vacuous direction still gets the
            # warnings below, just not blocked.
            is_sufficient = False
            if "vacuous_criteria" not in missing:
                missing.append("vacuous_criteria")
            names = "; ".join(f'"{c}"' for c in vacuity.vacuous)
            example = vacuity.suggestion(vacuity.vacuous[0]) if vacuity.vacuous else ""
            issues.append(
                "All acceptance criteria are vacuous-satisfiable (a fixed-response "
                f"no-op would pass every one): {names}. Rewrite at least one to "
                f"name a positive observable outcome. Example rewrite: {example}"
            )
        elif vacuity is not None and vacuity.vacuous:
            # Either some-vacuous-some-positive, OR an explore-tagged
            # all-vacuous direction (demoted from blocking to warning, F2/F3).
            for criterion in vacuity.vacuous:
                structural_issues.append(
                    f'acceptance criterion is vacuous-satisfiable (a no-op would '
                    f'pass it): "{criterion}" — {vacuity.suggestion(criterion)}'
                )

    if not is_sufficient:
        severity = "blocking"
    elif structural_issues:
        severity = "warning"
    else:
        severity = "ok"

    return ValidationResult(
        is_valid=is_sufficient,
        missing=missing,
        issues=issues,
        structural_issues=structural_issues,
        severity=severity,
        has_flow=has_flow,
        has_api_spec=has_api_spec,
        has_acceptance=rep.has_acceptance,
        explore_tag=rep.explore_tag,
        vacuity=vacuity,
    )
