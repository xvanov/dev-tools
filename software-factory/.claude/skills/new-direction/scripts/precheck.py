#!/usr/bin/env python
"""Precheck a hand-written direction before spending a PM call on it.

Parses the direction exactly the way the factory does (``factory.directions.parser``)
and reports what the PM persona will actually see: the parsed fields, the
backpressure verdict, and heuristic warnings for phrasing the PM flags as
untestable.

Usage:
    uv run python .claude/skills/new-direction/scripts/precheck.py apps/<app>/directions/<NNN>-<slug>

Exit codes: 0 = would pass the gate, 1 = would be rejected, 2 = unparseable.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# The direction dir lives under <root>/apps/<app>/directions/<dir>, so the repo
# root is four levels up. Put it on sys.path so the script runs from anywhere.
_VALID_TYPES = {
    "feature",
    "bug",
    "security",
    "refactor",
    "deploy",
    "chore",
    "infra",
    "ux",
    "docs",
}
_VALID_PRIORITIES = {"p0", "p1", "p2", "p3"}

# Phrasing with no observable trigger/response or measurable threshold. The PM
# counts criteria like these as a `missing: [acceptance_criteria]` entry.
_VAGUE_PATTERNS = [
    r"\bfeels?\b",
    r"\bfast\b",
    r"\bslow\b",
    r"\bquick(?:ly)?\b",
    r"\beas(?:y|ily)\b",
    r"\bintuitive\b",
    r"\bseamless(?:ly)?\b",
    r"\bsmooth(?:ly)?\b",
    r"\bnice(?:ly)?\b",
    r"\bgood\b",
    r"\bbetter\b",
    r"\brobust\b",
    r"\buser[- ]friendly\b",
    r"\bworks? well\b",
    r"\bproperly\b",
    r"\bcorrectly\b",
    r"\bappropriate(?:ly)?\b",
    r"\breasonabl[ey]\b",
    r"\bas needed\b",
    r"\bif necessary\b",
    r"\betc\.?\b",
    r"\bsupport(?:s)? .*\bas appropriate\b",
]


def _fail(msg: str) -> int:
    print(f"ERROR: {msg}")
    return 2


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return _fail("usage: precheck.py apps/<app>/directions/<NNN>-<slug>")

    dir_path = Path(argv[1]).resolve()
    if not dir_path.is_dir():
        return _fail(f"not a directory: {dir_path}")

    parts = dir_path.parts
    if "apps" not in parts:
        return _fail(f"expected a path under apps/<app>/directions/, got {dir_path}")
    apps_idx = len(parts) - 1 - parts[::-1].index("apps")
    root = Path(*parts[:apps_idx])
    try:
        app = parts[apps_idx + 1]
    except IndexError:
        return _fail(f"cannot infer app name from {dir_path}")

    sys.path.insert(0, str(root))
    try:
        from factory.directions.parser import parse_direction_dir
    except ImportError as exc:  # pragma: no cover - env problem, not a direction problem
        return _fail(f"cannot import the factory parser ({exc}). Run via `uv run python ...`")

    try:
        d = parse_direction_dir(app, dir_path, software_factory_root=root)
    except (FileNotFoundError, ValueError) as exc:
        return _fail(str(exc))

    warnings: list[str] = []
    print(f"direction : {d.id_slug}")
    print(f"app       : {d.app}")
    print(f"title     : {d.title}")
    print(f"type      : {d.type_tag or '(unset)'}")
    print(f"priority  : {d.raw_frontmatter.get('priority', '(unset)')}")
    print(f"explore   : {d.explore_tag}")
    if d.parent_direction:
        print(f"parent    : {d.parent_direction}")
    print(f"flow.md   : {'present, non-empty' if d.has_flow else 'absent/empty'}")
    print(f"api_spec  : {'present, non-empty' if d.has_api_spec else 'absent/empty'}")
    print(f"artifacts : {len(d.artifacts_paths)} file(s)")
    print(f"status    : {d.status}")

    print(f"\nwhy       : {'parsed' if d.why else 'MISSING'}")
    if d.why:
        first = " ".join(d.why.split())
        print(f"            {first[:120]}{'…' if len(first) > 120 else ''}")

    print(f"\nacceptance criteria parsed: {len(d.acceptance)}")
    for i, ac in enumerate(d.acceptance, 1):
        print(f"  {i}. {ac}")
        hits = [p for p in _VAGUE_PATTERNS if re.search(p, ac, re.IGNORECASE)]
        if hits:
            readable = ", ".join(h.strip("\\b").replace("\\b", "").replace("(?:", "(") for h in hits)
            warnings.append(f"AC {i} reads as untestable ({readable}): {ac[:80]}")
        if len(ac) > 220:
            warnings.append(f"AC {i} is very long ({len(ac)} chars) — likely a compound; consider splitting")

    # Field-level checks the PM or the chain will trip on later.
    if not d.why:
        warnings.append("no `## Why` section parsed — check the heading spelling")
    if not d.acceptance:
        warnings.append(
            "zero acceptance criteria parsed — check the `## Acceptance Criteria` heading "
            "and that bullets use `- ` / `- [ ]`"
        )
    elif len(d.acceptance) > 10:
        warnings.append(
            f"{len(d.acceptance)} criteria — large directions decompose better as an "
            "explicit parent + iterations"
        )
    if d.type_tag not in _VALID_TYPES:
        warnings.append(f"type {d.type_tag!r} is not one of {sorted(_VALID_TYPES)}")
    prio = str(d.raw_frontmatter.get("priority", "")).lower()
    if prio not in _VALID_PRIORITIES:
        warnings.append(f"priority {prio!r} is not one of {sorted(_VALID_PRIORITIES)}")
    if "<!-- fill in" in d.raw_body or "<!-- one paragraph" in d.raw_body:
        warnings.append("template placeholder comments are still in the body")
    if not (dir_path / "state.yaml").exists():
        warnings.append("state.yaml missing — pm-sync writes it, but hand-written dirs should ship one")

    gate = d.has_flow or d.has_api_spec or d.explore_tag
    print("\n" + "=" * 68)
    if gate:
        reason = (
            "flow.md" if d.has_flow else "api_spec.md" if d.has_api_spec else "explore: true"
        )
        print(f"BACKPRESSURE GATE: PASS (satisfied by {reason})")
    else:
        print("BACKPRESSURE GATE: FAIL")
        print("  The PM will emit child_stories: [] and set status -> needs-direction.")
        print("  Fix by adding a non-empty flow.md OR api_spec.md, or setting explore: true.")
    print("=" * 68)

    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  - {w}")
        print(
            "\nWarnings are heuristics, not the gate. Untestable criteria are still a "
            "hard PM rejection reason — treat those seriously."
        )
    else:
        print("\nNo warnings.")

    return 0 if gate else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
