"""Author a direction's ``api_spec.md`` — the contract dev and the oracle share.

The acceptance oracle is dev-blind by design (019 AC3). Its only inputs are the
direction's acceptance criteria and, when present, the direction's ``flow.md`` /
``api_spec.md`` — read verbatim by ``acceptance._compose_spec``. SM's prompt
carries the same ``api_spec.md`` section. So the pipeline already has a seam for
a shared interface contract; directions simply almost never carry one.

That gap is what made sacrifice direction 117 unbuildable. It asks for
verification tokens that are "single-use, short-lived, and invalidated after
use" and names no route at all. With nothing to anchor on, the dev-blind author
first *guessed* routes (an oracle that 404s at HEAD regardless of the code —
PR #266) and then, once the harness hint stopped supplying wrong facts, honestly
*declined* to test anything: three ``pytest.skip``s and a vacuous oracle. Both
outcomes block. Neither is the model's fault.

This module fills the seam. It is the ONLY role that reads both the app and the
spec, and it runs BEFORE any story exists, so:

* the contract is frozen before the implementer starts,
* the implementer cannot edit it,
* the grader still never sees the implementer's diff.

That is spec-first development, not a leak of implementation detail into the
grader — and it is strictly stronger than a grader guessing.

The gradeability verdict is a side effect worth as much as the contract: an
author that reports ``observable: false`` for a criterion has proven the
direction cannot be graded as written, for a few cents, before any story spawns
or any sandbox runs.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from factory.chain.route_table import extract_routes, render_route_table

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["endpoints", "criteria", "security_notes"],
    "properties": {
        "endpoints": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "method", "path", "new", "purpose", "request", "response", "status_codes",
                ],
                "properties": {
                    "method": {"type": "string"},
                    "path": {"type": "string"},
                    "new": {"type": "boolean"},
                    "purpose": {"type": "string"},
                    "request": {"type": "string"},
                    "response": {"type": "string"},
                    "status_codes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            # ``body`` is REQUIRED. A contract that fixes the
                            # happy path and leaves edge/environment-conditional
                            # bodies unstated produces review ping-pong: the
                            # implementer picks a shape, the reviewer calls it a
                            # contract violation, the implementer picks the
                            # opposite, and the reviewer objects again. Measured
                            # on sacrifice direction 117 — story 177 reached
                            # ``blocked_review_nonconvergent`` with the score
                            # unmoved across two cycles for exactly this reason.
                            "required": ["code", "when", "body"],
                            "properties": {
                                "code": {"type": "string"},
                                "when": {"type": "string"},
                                "body": {"type": "string"},
                            },
                        },
                    },
                },
            },
        },
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["criterion", "verified_by", "how", "endpoints"],
                "properties": {
                    "criterion": {"type": "string"},
                    "verified_by": {"type": "string", "enum": ["oracle", "test-suite", "none"]},
                    "how": {"type": "string"},
                    "endpoints": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "security_notes": {"type": "string"},
    },
}


@dataclass
class ContractResult:
    """Outcome of one contract-authoring pass."""

    markdown: str
    gradeable: bool
    ungradeable_criteria: list[str]
    oracle_criteria: list[str]
    other_gate_criteria: list[str]
    raw: dict[str, Any]

    @property
    def blocked_reason(self) -> str:
        if self.gradeable:
            return ""
        n = len(self.ungradeable_criteria)
        return (
            f"{n} acceptance criterion(s) cannot be verified by anything the "
            f"pipeline runs: " + "; ".join(self.ungradeable_criteria)
        )


def render_markdown(direction_title: str, payload: dict[str, Any]) -> str:
    """Deterministic markdown from the structured payload.

    Rendered here rather than asked for as prose so the document's shape is ours
    and cannot drift per call, and so ``criteria`` can be validated as data
    before it becomes text.
    """
    out: list[str] = [
        f"# API contract — {direction_title}",
        "",
        "> Authored by the `contract` persona from the direction's acceptance",
        "> criteria and the app's REAL route table. This file is the shared",
        "> contract: the implementer builds to it and the independent acceptance",
        "> oracle grades against it. Paths here are exact.",
        "",
        "## Endpoints",
        "",
    ]
    endpoints = payload.get("endpoints") or []
    if not endpoints:
        out += ["_(none specified)_", ""]
    for ep in endpoints:
        tag = " **(new)**" if ep.get("new") else " _(existing)_"
        out += [
            f"### `{ep.get('method', '?')} {ep.get('path', '?')}`{tag}",
            "",
            f"{ep.get('purpose', '').strip()}",
            "",
            f"- **Request:** {ep.get('request', 'none')}",
            f"- **Response:** {ep.get('response', '')}",
        ]
        codes = ep.get("status_codes") or []
        if codes:
            out.append("- **Status codes:**")
            for c in codes:
                line = f"  - `{c.get('code', '?')}` — {c.get('when', '')}"
                body = (c.get("body") or "").strip()
                if body:
                    line += f" → body: `{body}`"
                out.append(line)
        out.append("")

    out += ["## Acceptance criteria — how each is observed", ""]
    _MARK = {
        "oracle": "graded by the acceptance oracle (HTTP)",
        "test-suite": "verified by the implementation's own test suite, not the oracle",
        "none": "**NOT VERIFIABLE — this direction cannot be built as written**",
    }
    for i, c in enumerate(payload.get("criteria") or [], start=1):
        mark = _MARK.get(str(c.get("verified_by")), "**UNCLASSIFIED**")
        out += [
            f"### {i}. {c.get('criterion', '').strip()}",
            "",
            f"- **Status:** {mark}",
            f"- **How:** {c.get('how', '').strip()}",
        ]
        eps = c.get("endpoints") or []
        if eps:
            out.append("- **Endpoints:** " + ", ".join(f"`{e}`" for e in eps))
        out.append("")

    notes = (payload.get("security_notes") or "").strip()
    if notes:
        out += ["## Observability affordances and their constraints", "", notes, ""]
    return "\n".join(out).rstrip() + "\n"


def author_contract(
    *,
    direction: Any,
    app_repo_path: Path,
    harness_hint: str,
    text_run: Any,
    model_id: str,
    app: str | None = None,
    max_tokens: int | None = None,
    db_path: Path | None = None,
) -> ContractResult:
    """Run the ``contract`` persona and return the rendered contract + verdict.

    ``text_run`` is injected so tests drive this without network or an API key.
    """
    from factory.runner import _read_persona_prompt  # local: keeps import graph light

    acceptance = list(getattr(direction, "acceptance", None) or [])
    routes = extract_routes(app_repo_path)
    title = getattr(direction, "title", None) or getattr(direction, "slug", "") or "(untitled)"

    prompt = "\n".join(
        [
            _read_persona_prompt("contract").rstrip(),
            "",
            "---",
            "",
            "## Direction",
            "",
            f"- Title: {title}",
            f"- Why: {(getattr(direction, 'why', '') or '(none given)').strip()}",
            "",
            "## Acceptance criteria (verbatim — the SPEC)",
            "",
            *(f"{i}. {ac}" for i, ac in enumerate(acceptance, start=1)),
            "",
            "## The app's REAL route table (parsed from source — evidence, not a suggestion)",
            "",
            "```",
            render_route_table(routes),
            "```",
            "",
            "## Acceptance-harness facts",
            "",
            harness_hint.strip() or "(none provided)",
            "",
            "Return the JSON object. No prose outside the JSON.",
        ]
    )

    raw = text_run(
        persona="contract",
        prompt=prompt,
        model_id=model_id,
        schema=_SCHEMA,
        max_tokens=max_tokens,
        app=app,
        direction_id=getattr(direction, "id", None),
        db_path=db_path,
    )
    if not isinstance(raw, dict):
        raise ValueError(f"contract persona returned {type(raw).__name__}, expected dict")

    reported = list(raw.get("criteria") or [])
    # Coverage is checked against the DIRECTION's criteria, not the author's own
    # list: an author that silently drops a criterion would otherwise report a
    # clean gradeable verdict for a spec it never considered.
    missing = [ac for ac in acceptance if not _covered(ac, reported)]

    def _label(c: dict[str, Any]) -> str:
        return str(c.get("criterion", "")).strip()

    oracle_criteria = [_label(c) for c in reported if c.get("verified_by") == "oracle"]
    other_gate = [_label(c) for c in reported if c.get("verified_by") == "test-suite"]
    # Only ``none`` is a real blocker. A criterion about the implementation's own
    # tests ("tests cover X") is unobservable to ANY black-box grader by
    # construction, and the chain already runs the app's suite as a merge gate —
    # treating that as unbuildable would reject most well-formed directions,
    # including sacrifice 117's AC3.
    ungradeable = [_label(c) for c in reported if c.get("verified_by") == "none"]
    ungradeable += [f"(not addressed by the contract author) {ac}" for ac in missing]

    # A direction whose criteria are ALL delegated elsewhere has nothing for the
    # oracle to grade, which is the vacuous-oracle block arriving early. Fail
    # safe: say so here rather than after a story has been built.
    if not ungradeable and not oracle_criteria:
        ungradeable = [
            "no criterion is observable over HTTP — the acceptance oracle would "
            "have nothing to grade (vacuous)"
        ]

    return ContractResult(
        markdown=render_markdown(title, raw),
        gradeable=not ungradeable,
        ungradeable_criteria=ungradeable,
        oracle_criteria=oracle_criteria,
        other_gate_criteria=other_gate,
        raw=raw,
    )


def _covered(criterion: str, reported: list[dict[str, Any]]) -> bool:
    """Whether the author addressed ``criterion``.

    Compared on a normalised prefix rather than exact equality — the author is
    told to quote verbatim, but a stray period or re-wrap must not read as a
    dropped criterion and block a good contract.
    """
    want = _norm(criterion)
    for c in reported:
        got = _norm(str(c.get("criterion", "")))
        if not got or not want:
            continue
        if got == want or got.startswith(want[:60]) or want.startswith(got[:60]):
            return True
    return False


#: Markdown emphasis/code characters stripped before comparing a criterion the
#: author quoted against the criterion the direction wrote. A direction is
#: markdown, so its criteria routinely carry backticks around a route or
#: asterisks around a word; the author quotes the PROSE. Without this, a fully
#: addressed criterion reads as "not addressed" and the direction is blocked as
#: ungradeable — a FALSE block, measured 2026-08-09 on direction 120, whose AC1
#: wrapped the route in backticks while the author (correctly) quoted the prose
#: without them.
_MD_CHARS = str.maketrans("", "", "`*_~")


def _norm(s: str) -> str:
    return " ".join(s.lower().translate(_MD_CHARS).split()).strip(" .")


def write_contract(direction_dir: Path, markdown: str) -> Path:
    path = direction_dir / "api_spec.md"
    path.write_text(markdown, encoding="utf-8")
    return path


__all__ = [
    "ContractResult",
    "author_contract",
    "render_markdown",
    "write_contract",
]
