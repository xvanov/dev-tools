"""Per-direction backpressure completeness check.

This is the *fast pre-check* the chain runs before paying for an LLM call.
The PM persona's JSON output can override for ambiguous cases (e.g. the user
wrote a verbose flow.md but called it ``walkthrough.md`` — the persona may
still rule the direction sufficient). The structural rule encoded here is
the floor: if this report says ``is_sufficient=False``, downstream agents
will not produce useful work and the chain immediately routes back to the
user.

Rule: a direction has sufficient backpressure if and only if AT LEAST ONE of
``has_flow``, ``has_api_spec``, or ``explore_tag`` is true. Acceptance
criteria are tracked for the report but do NOT independently make a
direction sufficient (the user can ship "do the thing" with no AC if they
also say `(explore)`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from factory.directions.parser import Direction

# Verbs that signal a user-visible step in flow.md. We require at least
# two such steps so a flow that just says "open the page" doesn't count.
_USER_VERB_RE = re.compile(
    r"\b(?:tap|click|press|see|sees|view|views|open|opens|navigate|navigates|"
    r"submit|submits|select|selects|type|types|enter|enters|scroll|scrolls|"
    r"swipe|swipes|drag|drags|drop|drops|hover|hovers|focus|focuses|expect|"
    r"expects|observe|observes|confirm|confirms|read|reads|taps|clicks|presses)\b",
    re.IGNORECASE,
)
_STEP_RE = re.compile(r"(?m)^\s*(?:\d+\.\s+\S|[-*]\s+\S)")
_HTTP_METHOD_RE = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b", re.IGNORECASE)
_PATH_RE = re.compile(r"(?:^|\s)/[A-Za-z0-9_\-./{}]+")
_RESPONSE_CODE_RE = re.compile(r"\b([1-5][0-9][0-9])\b")


@dataclass
class CompletenessReport:
    is_sufficient: bool
    missing: list[str] = field(default_factory=list)
    has_flow: bool = False
    has_api_spec: bool = False
    has_acceptance: bool = False
    explore_tag: bool = False


def compute_completeness(direction: Direction) -> CompletenessReport:
    """Return the structural completeness report for ``direction``."""
    has_flow = direction.has_flow
    has_api_spec = direction.has_api_spec
    explore_tag = direction.explore_tag
    has_acceptance = bool(direction.acceptance)

    is_sufficient = has_flow or has_api_spec or explore_tag

    missing: list[str] = []
    if not is_sufficient:
        if not has_flow:
            missing.append("user_flow")
        if not has_api_spec:
            missing.append("api_spec")
        if not explore_tag:
            missing.append("explore_tag_or_artifacts")
    if not has_acceptance:
        missing.append("acceptance_criteria")

    return CompletenessReport(
        is_sufficient=is_sufficient,
        missing=missing,
        has_flow=has_flow,
        has_api_spec=has_api_spec,
        has_acceptance=has_acceptance,
        explore_tag=explore_tag,
    )


def extract_acceptance_criteria(direction: Direction) -> list[str]:
    """Return the parsed ``## Acceptance Criteria`` bullets verbatim.

    Thin alias over ``direction.acceptance`` so the per-direction backpressure
    layer doesn't depend on the directions parser's internal name.
    """
    return list(direction.acceptance)


def has_meaningful_flow(direction: Direction) -> bool:
    """True iff ``flow.md`` exists AND has >=2 user-visible steps.

    A step is "user-visible" if it (a) matches the step-line shape
    (numbered or bulleted), AND (b) contains at least one user-facing verb
    (tap/click/see/...). The heuristic is intentionally aggressive: a
    flow like "1. open\n2. close" without a user-facing verb is rejected
    so the PM gets a structural hint to push the user for a richer flow.
    """
    if not direction.has_flow:
        return False
    flow_path = direction.dir_path / "flow.md"
    try:
        content = flow_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    # Strip HTML comments before scanning steps.
    body = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL)
    steps = _STEP_RE.findall(body)
    if len(steps) < 2:
        return False
    # Each step (matched by _STEP_RE) must carry a verb; we scan each step
    # line independently to avoid one verb covering the entire file.
    step_lines = [ln for ln in body.splitlines() if _STEP_RE.match(ln)]
    verb_carrying = sum(1 for ln in step_lines if _USER_VERB_RE.search(ln))
    return verb_carrying >= 2


def has_meaningful_api_spec(direction: Direction) -> bool:
    """True iff ``api_spec.md`` has at least one HTTP method+path AND a 1xx-5xx code.

    Examples that pass:
      ``GET /healthz -> 200``
      ``POST /pledge`` then later ``Returns 201 / 400``
    Examples that fail:
      ``Backend should return JSON.`` (no method/path)
      ``GET /health`` with no response code anywhere
    """
    if not direction.has_api_spec:
        return False
    spec_path = direction.dir_path / "api_spec.md"
    try:
        content = spec_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    body = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL)
    if not _HTTP_METHOD_RE.search(body):
        return False
    if not _PATH_RE.search(body):
        return False
    if not _RESPONSE_CODE_RE.search(body):
        return False
    return True
