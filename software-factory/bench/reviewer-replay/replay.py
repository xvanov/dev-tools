#!/usr/bin/env python3
"""A.4 reviewer execution-evidence replay — see PRE-REGISTRATION-A4.md.

Replays archived reviewer prompts from a preserved bench corpus at the same
model, in two arms:

* **control**   — the archived prompt, byte-for-byte.
* **treatment** — the same prompt with the Dev's self-reported test tail
  replaced by an independent, runtime-recorded execution transcript plus an
  evidence-precedence instruction.

Then scores both against the hidden SWE-bench oracle
(``grade.oracle_resolved``) and reports Clopper-Pearson intervals and a paired
exact McNemar test.

The oracle is a LABEL, never an INPUT. ``load_labels`` is the only function
allowed to read the results archive, and ``build_treatment_prompt`` asserts
provenance of every emitted byte against the source trajectory.

Subcommands
-----------
``baseline``  reproduce the pre-change baseline from the archive. No model calls.
``build``     assemble both arms' prompts, run every assertion, print sizes.
              No model calls.
``run``       make the paid calls for one arm/replicate.
``analyze``   score whatever ``run`` has produced and emit the results tables.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Pinned constants — every one of these is fixed by PRE-REGISTRATION-A4.md.
# ---------------------------------------------------------------------------

REVIEWER_MODEL = "azure/gpt-5.4"
ARCHIVE_ID = "2026-08-04T23-19-24.998844Z"
DEFAULT_CORPUS = Path("/home/k/sf-reviewer-corpus-2026-08-05")
REPLICATES = 3
PRIMARY_REPLICATE = 1

#: The instance that never reached review; carries no reviewer verdict.
NO_REVIEW_INSTANCES = frozenset({"pandas-dev__pandas-63945"})

TEST_OUTPUT_HEADER = "\n\n## Latest test output\n\n"
DEV_SUMMARY_HEADER = "\n\n## DEV SELF-SUMMARY"

TRANSCRIPT_HEADER = (
    "\n\n## Independent execution transcript "
    "(sandbox runtime record — NOT the dev's report)\n\n"
)

PRECEDENCE_BLOCK = """

## Evidence precedence (READ THIS BEFORE THE DIFF)

The transcript above is the sandbox runtime's own record of every action the Dev
took and the exact bytes that came back. The Dev did not write it and cannot
edit it. The `## DEV SELF-SUMMARY` and the `## PR diff` below are the Dev's own
artefacts: one is a claim, the other is a delta the Dev chose to produce.

**When the transcript disagrees with the self-summary, or with what the diff
appears to do, the transcript wins.** Concretely:

- Judge whether the tests actually exercise the reported defect from what the
  transcript shows the tests DOING — which tests ran, which failed, what the
  failure said — not from the Dev's description of them.
- A test that only ever ran green, and never once ran red against the
  unfixed code, is weak evidence that it covers the defect. Say so.
- If the transcript shows a test being edited after it failed, and then passing,
  treat the pass as unproven until you can see from the diff that the assertion
  still constrains the behaviour the story asks for.
- If a claim in the self-summary has no corresponding command in the
  transcript, it is unverified. Do not credit it.
"""

TEST_CMD_RE = re.compile(
    r"(pytest|unittest|\btox\b|npm (run )?test|go test|cargo test|nosetests)",
    re.IGNORECASE,
)

#: Deterministic redaction. Collapses the host path PREFIX and testbed image
#: references, which carry the SWE-bench instance identity the control prompt
#: does not have. The repo-relative tail is deliberately preserved: which file
#: was edited is the signal, the machine it lived on is not.
_P = r"""[^\s'"]"""
REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?:swerebench/)?sweb\.eval\.[\w.\-]+(?:@sha256:[0-9a-f]+)?"), "<TESTBED_IMAGE>"),
    (re.compile(rf"/{_P}*?/state/worktrees/[\w.\-]+"), "<REPO>"),
    (re.compile(rf"/{_P}*?/swebench-work(?:/[\w.\-]+)?"), "<REPO>"),
)

SPINE_BUDGET = 5_000
SPINE_HEAD = 15
SPINE_TAIL = 60
TEST_OUTPUT_BUDGET = 12_000
TEST_TAIL_MIN = 500
TEST_TAIL_MAX = 3_000
MAX_TEST_RUNS = 24

HARD_SPEND_CAP_USD = 5.0

#: Strings that must never appear in a built prompt (oracle-leakage tripwire).
LEAK_TOKENS = ("FAIL_TO_PASS", "PASS_TO_PASS")


def redact(text: str) -> str:
    for pat, sub in REDACTIONS:
        text = pat.sub(sub, text)
    return text


# ---------------------------------------------------------------------------
# Corpus reading — trajectories, prompt bodies, response bodies.
# ---------------------------------------------------------------------------


@dataclass
class ReviewCall:
    """The last reviewer call on one instance, plus its causal dev sessions."""

    instance: str
    story_id: int
    seq: int
    model_id: str
    prompt: str
    prompt_hash: str
    recorded_verdict: str
    trajectory_paths: list[Path] = field(default_factory=list)


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def load_review_calls(corpus: Path, instances: list[str]) -> list[ReviewCall]:
    """Load the LAST reviewer call per instance, with its causal trajectories.

    Only reads files under ``corpus``. Never reads the results archive.
    """
    calls: list[ReviewCall] = []
    for inst in instances:
        idir = corpus / inst
        prompts = [
            r for r in _read_ndjson(idir / "prompt_bodies.ndjson") if r["persona"] == "reviewer"
        ]
        responses = _read_ndjson(idir / "response_bodies.ndjson")
        if not prompts:
            continue
        last = prompts[-1]
        if hashlib.sha256(last["prompt"].encode()).hexdigest() != last["prompt_hash"]:
            raise AssertionError(f"{inst}: archived prompt_hash does not match sha256(prompt)")

        rev_resp = [r for r in responses if r["persona"] == "reviewer"]
        if not rev_resp:
            raise AssertionError(f"{inst}: reviewer prompt with no reviewer response")
        recorded = _parse_verdict(rev_resp[-1]["response"])

        trajs: list[Path] = []
        for r in sorted(responses, key=lambda r: r["seq"]):
            if r["persona"] != "dev" or r["seq"] >= last["seq"]:
                continue
            tp = r.get("trajectory_path")
            if not tp:
                continue
            p = idir / "trajectories" / os.path.basename(tp)
            if not p.exists():
                raise AssertionError(f"{inst}: trajectory {p.name} referenced but absent")
            trajs.append(p)

        calls.append(
            ReviewCall(
                instance=inst,
                story_id=int(last["story_id"]),
                seq=int(last["seq"]),
                model_id=last["model_id"],
                prompt=last["prompt"],
                prompt_hash=last["prompt_hash"],
                recorded_verdict=recorded,
                trajectory_paths=trajs,
            )
        )
    return calls


def _parse_verdict(raw: str) -> str:
    """Verdict via the production parser, so parse failures degrade identically."""
    from factory.chain.handlers import _parse_reviewer_result

    return str(_parse_reviewer_result(raw).get("verdict", "request_changes"))


# ---------------------------------------------------------------------------
# Evidence block construction.
# ---------------------------------------------------------------------------


@dataclass
class Action:
    session: int
    ordinal: int
    kind: str  # "terminal" | "edit"
    command: str
    exit_code: int | None
    output: str


def _observation_text(obs: dict[str, Any]) -> str:
    parts: list[str] = []
    for chunk in obs.get("content") or []:
        if isinstance(chunk, dict) and chunk.get("type") == "text":
            parts.append(chunk.get("text") or "")
    return "".join(parts)


def read_actions(trajectory_paths: list[Path]) -> list[Action]:
    """Every recorded terminal/editor observation, chronological, per session.

    Redaction is applied here, to whole field values, **before** any truncation.
    Redacting a truncated fragment would not agree with redacting the full
    string, which would break the provenance assertion for no good reason.
    """
    actions: list[Action] = []
    for si, path in enumerate(trajectory_paths, start=1):
        n = 0
        for row in _read_ndjson(path):
            obs = row.get("observation")
            if not isinstance(obs, dict):
                continue
            kind = obs.get("kind")
            if kind == "TerminalObservation":
                n += 1
                actions.append(
                    Action(
                        session=si,
                        ordinal=n,
                        kind="terminal",
                        command=redact(str(obs.get("command") or "")),
                        exit_code=obs.get("exit_code"),
                        output=redact(_observation_text(obs)),
                    )
                )
            elif kind == "FileEditorObservation":
                n += 1
                cmd = str(obs.get("command") or "edit")
                pth = str(obs.get("path") or "")
                actions.append(
                    Action(
                        session=si,
                        ordinal=n,
                        kind="edit",
                        command=redact(f"{cmd} {pth}".strip()),
                        exit_code=None,
                        output="",
                    )
                )
    return actions


def _one_line(text: str, limit: int) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 3] + "..."


def build_evidence_block(actions: list[Action], n_sessions: int) -> str:
    """The pre-registered evidence block. Purely mechanical."""
    test_runs = [a for a in actions if a.kind == "terminal" and TEST_CMD_RE.search(a.command)]
    exits = ", ".join("?" if a.exit_code is None else str(a.exit_code) for a in test_runs)

    head = (
        f"Dev sandbox sessions: {n_sessions}  (chronological)\n"
        f"Total recorded actions: {len(actions)}\n"
        f"Test-runner invocations: {len(test_runs)}\n"
        f"Test-runner exit codes, in order: {exits or '(none)'}\n"
    )

    # --- spine -------------------------------------------------------------
    def spine_line(a: Action) -> str:
        if a.kind == "edit":
            return f"[s{a.session} #{a.ordinal:03d}] EDIT {_one_line(a.command, 160)}"
        exit_s = "?" if a.exit_code is None else str(a.exit_code)
        return f"[s{a.session} #{a.ordinal:03d}] exit={exit_s} $ {_one_line(a.command, 160)}"

    lines = [spine_line(a) for a in actions]
    spine_body = "\n".join(lines)
    if len(spine_body) > SPINE_BUDGET and len(lines) > SPINE_HEAD + SPINE_TAIL:
        elided = len(lines) - SPINE_HEAD - SPINE_TAIL
        spine_body = "\n".join(
            lines[:SPINE_HEAD]
            + [f"... [{elided} actions elided] ..."]
            + lines[-SPINE_TAIL:]
        )
    spine = "### Command spine — every recorded action, in order\n\n" + (
        spine_body or "(no recorded actions)"
    )

    # --- test-runner outputs ----------------------------------------------
    kept = test_runs
    elision_note = ""
    if len(kept) * TEST_TAIL_MIN > TEST_OUTPUT_BUDGET:
        dropped = len(kept) - MAX_TEST_RUNS
        kept = kept[-MAX_TEST_RUNS:]
        elision_note = f"[{dropped} earlier test-runner invocations elided]\n\n"
    per = TEST_OUTPUT_BUDGET // max(1, len(kept))
    per = max(TEST_TAIL_MIN, min(TEST_TAIL_MAX, per))

    chunks: list[str] = []
    for j, a in enumerate(kept, start=1):
        exit_s = "?" if a.exit_code is None else str(a.exit_code)
        tail = a.output[-per:]
        if len(a.output) > per:
            tail = f"[... {len(a.output) - per} earlier chars of output elided ...]\n" + tail
        chunks.append(
            f"--- run {j}/{len(kept)}  session {a.session}  exit={exit_s}\n"
            f"$ {_one_line(a.command, 400)}\n{tail}"
        )
    runs = (
        "### Test-runner invocations — verbatim recorded output\n\n"
        + elision_note
        + ("\n\n".join(chunks) if chunks else "(no test-runner invocation was recorded)")
    )

    return redact(f"{head}\n{spine}\n\n{runs}")


def _all_strings(obj: Any, out: list[str]) -> None:
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _all_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _all_strings(v, out)


def _norm(text: str) -> str:
    return " ".join(text.split())


def assert_evidence_provenance(block: str, trajectory_paths: list[Path]) -> None:
    """Every command and every output chunk in the block must come from a trajectory.

    Provenance-by-construction: the block cannot contain text the sandbox did
    not record, so it cannot contain oracle information. The check re-parses the
    trajectory files independently of :func:`read_actions` — it collects *every*
    string value in the JSON, so it does not inherit that function's field
    selection and is not circular.
    """
    strings: list[str] = []
    for p in trajectory_paths:
        for row in _read_ndjson(p):
            _all_strings(row, strings)
    haystack = "\n".join(_norm(redact(s)) for s in strings)

    def present(fragment: str) -> bool:
        f = _norm(fragment)
        return not f or f in haystack

    for line in block.splitlines():
        m = re.match(r"^\[s\d+ #\d+\] exit=\S+ \$ (.*)$", line)
        if m:
            cmd = m.group(1)
            if cmd.endswith("..."):
                cmd = cmd[:-3]
            if not present(cmd):
                raise AssertionError(f"evidence command has no provenance: {line[:160]!r}")
            continue
        m = re.match(r"^\[s\d+ #\d+\] EDIT (.*)$", line)
        if m:
            # An editor line is two recorded fields joined (verb + path), so the
            # joined string is not itself in the trajectory; check each field.
            for token in m.group(1).removesuffix("...").split():
                if not present(token):
                    raise AssertionError(
                        f"evidence editor token has no provenance: {token[:120]!r}"
                    )

    # Test-runner output chunks: split on the run delimiter, drop the two header
    # lines and any elision marker, then require the remainder verbatim.
    body = block.split("### Test-runner invocations — verbatim recorded output", 1)
    if len(body) == 2:
        for chunk in body[1].split("\n--- run ")[1:]:
            lines = chunk.splitlines()
            payload = "\n".join(
                x for x in lines[2:] if not x.startswith("[... ") and not x.endswith(" elided ...]")
            )
            if not present(payload):
                raise AssertionError(
                    f"evidence output chunk has no provenance: {payload[:160]!r}"
                )


# ---------------------------------------------------------------------------
# Prompt assembly.
# ---------------------------------------------------------------------------


def splice_treatment(prompt: str, evidence_block: str) -> str:
    """Replace the dev's self-reported test tail with the transcript + precedence.

    Hard-fails when either literal section boundary is missing, rather than
    silently producing a control-shaped prompt in the treatment arm.
    """
    start = prompt.find(TEST_OUTPUT_HEADER)
    if start < 0:
        raise AssertionError(f"missing boundary {TEST_OUTPUT_HEADER!r}")
    end = prompt.find(DEV_SUMMARY_HEADER, start)
    if end < 0:
        raise AssertionError(f"missing boundary {DEV_SUMMARY_HEADER!r}")
    return prompt[:start] + TRANSCRIPT_HEADER + evidence_block + PRECEDENCE_BLOCK + prompt[end:]


def build_prompts(call: ReviewCall) -> tuple[str, str, str]:
    """Return (control_prompt, treatment_prompt, evidence_block)."""
    actions = read_actions(call.trajectory_paths)
    block = build_evidence_block(actions, len(call.trajectory_paths))
    assert_evidence_provenance(block, call.trajectory_paths)
    treatment = splice_treatment(call.prompt, block)
    for tok in LEAK_TOKENS:
        if tok in treatment and tok not in call.prompt:
            raise AssertionError(f"{call.instance}: leak token {tok!r} entered the treatment prompt")
    return call.prompt, treatment, block


# ---------------------------------------------------------------------------
# Labels — the ONLY function permitted to read the results archive.
# ---------------------------------------------------------------------------


def load_labels(archive_root: Path) -> dict[str, dict[str, Any]]:
    """``{instance: {"oracle_resolved": bool, "factory_says_green": bool, ...}}``."""
    out: dict[str, dict[str, Any]] = {}
    for d in sorted(archive_root.iterdir()):
        res = d / "factory" / "result.json"
        if not d.is_dir() or not res.exists():
            continue
        payload = json.loads(res.read_text())
        grade = payload.get("grade") or {}
        out[d.name] = {
            "oracle_resolved": bool(grade.get("oracle_resolved")),
            "factory_says_green": bool(payload.get("factory_says_green")),
            "log_tail": grade.get("log_tail") or "",
            "gold_files": list(grade.get("gold_files") or []),
        }
    return out


def assert_no_oracle_leakage(prompt: str, label: dict[str, Any]) -> None:
    """Tripwire: nothing oracle-derived may appear in a prompt we send."""
    tail = (label.get("log_tail") or "").strip()
    if len(tail) > 80 and tail in prompt:
        raise AssertionError("oracle log_tail found in prompt")
    for gf in label.get("gold_files") or []:
        if gf and f"GOLD:{gf}" in prompt:
            raise AssertionError(f"oracle gold-file marker {gf!r} found in prompt")
    for tok in LEAK_TOKENS:
        if tok in prompt:
            raise AssertionError(f"oracle token {tok!r} found in prompt")


# ---------------------------------------------------------------------------
# Statistics — dependency-free.
# ---------------------------------------------------------------------------


def _binom_tail_ge(k: int, n: int, p: float) -> float:
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))


def _binom_tail_le(k: int, n: int, p: float) -> float:
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, k + 1))


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Exact binomial (Clopper-Pearson) CI by bisection. No scipy needed."""
    if n == 0:
        return (0.0, 1.0)
    lo = 0.0
    if k > 0:
        a, b = 0.0, 1.0
        for _ in range(200):
            mid = (a + b) / 2
            if _binom_tail_ge(k, n, mid) < alpha / 2:
                a = mid
            else:
                b = mid
        lo = (a + b) / 2
    hi = 1.0
    if k < n:
        a, b = 0.0, 1.0
        for _ in range(200):
            mid = (a + b) / 2
            if _binom_tail_le(k, n, mid) > alpha / 2:
                a = mid
            else:
                b = mid
        hi = (a + b) / 2
    return (lo, hi)


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value on discordant counts ``b`` and ``c``."""
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2.0 * _binom_tail_le(min(b, c), n, 0.5))


def confusion(
    verdicts: dict[str, str], labels: dict[str, dict[str, Any]], instances: list[str]
) -> dict[str, Any]:
    tp = fp = fn = tn = 0
    for inst in instances:
        approve = verdicts[inst] == "approve"
        resolved = labels[inst]["oracle_resolved"]
        if approve and resolved:
            tp += 1
        elif approve and not resolved:
            fp += 1
        elif not approve and resolved:
            fn += 1
        else:
            tn += 1
    n = tp + fp + fn + tn
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "n": n,
        "accuracy": (tp + tn) / n if n else 0.0,
        "precision": tp / (tp + fp) if (tp + fp) else None,
        "recall": tp / (tp + fn) if (tp + fn) else None,
        "acc_ci": clopper_pearson(tp + tn, n),
    }


# ---------------------------------------------------------------------------
# Subcommands.
# ---------------------------------------------------------------------------


def _scoped_instances(corpus: Path, archive: Path) -> list[str]:
    """The graded instances that carry a reviewer verdict. n = 18."""
    labels = load_labels(archive)
    out = []
    for inst in sorted(labels):
        if inst in NO_REVIEW_INSTANCES:
            continue
        prompts = [
            r
            for r in _read_ndjson(corpus / inst / "prompt_bodies.ndjson")
            if r["persona"] == "reviewer"
        ]
        if prompts:
            out.append(inst)
    return out


def cmd_baseline(args: argparse.Namespace) -> int:
    labels = load_labels(args.archive)
    instances = _scoped_instances(args.corpus, args.archive)
    calls = load_review_calls(args.corpus, instances)
    recorded = {c.instance: c.recorded_verdict for c in calls}
    green = {i: ("approve" if labels[i]["factory_says_green"] else "request_changes") for i in instances}

    rv = confusion(recorded, labels, instances)
    gv = confusion(green, labels, instances)
    print(f"scoped instances: n = {len(instances)}")
    print(f"reviewer last-verdict : {rv}")
    print(f"factory_says_green    : {gv}")
    expected = {"tp": 6, "fp": 9, "fn": 1, "tn": 2}
    got = {k: rv[k] for k in expected}
    if got != expected:
        print(f"STOP: baseline mismatch. expected {expected} got {got}", file=sys.stderr)
        return 2
    if {k: gv[k] for k in expected} != expected:
        print("STOP: factory_says_green table does not match the reviewer table", file=sys.stderr)
        return 2
    print("baseline reproduced: TP=6 FP=9 FN=1 TN=2  acc=8/18=44.4%  prec=40.0%  recall=85.7%")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    labels = load_labels(args.archive)
    instances = _scoped_instances(args.corpus, args.archive)
    calls = load_review_calls(args.corpus, instances)
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    for c in calls:
        control, treatment, block = build_prompts(c)
        if hashlib.sha256(control.encode()).hexdigest() != c.prompt_hash:
            raise AssertionError(f"{c.instance}: control prompt is not byte-identical")
        assert_no_oracle_leakage(treatment, labels[c.instance])
        assert_no_oracle_leakage(control, labels[c.instance])
        (args.out / f"{c.instance}.control.txt").write_text(control)
        (args.out / f"{c.instance}.treatment.txt").write_text(treatment)
        rows.append(
            {
                "instance": c.instance,
                "seq": c.seq,
                "sessions": len(c.trajectory_paths),
                "recorded_verdict": c.recorded_verdict,
                "oracle_resolved": labels[c.instance]["oracle_resolved"],
                "control_chars": len(control),
                "treatment_chars": len(treatment),
                "evidence_chars": len(block),
            }
        )
        print(
            f"{c.instance[:46]:47s} sessions={len(c.trajectory_paths)} "
            f"control={len(control):6d} treatment={len(treatment):6d} evidence={len(block):6d} "
            f"recorded={c.recorded_verdict:15s} oracle={labels[c.instance]['oracle_resolved']}"
        )
    (args.out / "build-index.json").write_text(json.dumps(rows, indent=2))
    tot_c = sum(r["control_chars"] for r in rows)
    tot_t = sum(r["treatment_chars"] for r in rows)
    print(f"\nn={len(rows)}  control total {tot_c:,} chars (~{tot_c // 4:,} tok)")
    print(f"           treatment total {tot_t:,} chars (~{tot_t // 4:,} tok)")
    print(f"projected input tokens for {REPLICATES} replicates x 2 arms: "
          f"~{REPLICATES * (tot_c + tot_t) // 4:,}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    from dotenv import load_dotenv

    from factory.model_router import max_output_tokens_for, route
    from factory.runner import text_run

    # Same precedence as ``factory/cli.py:92`` — cwd first, then the nearest
    # ancestor ``.env``. Walking up matters when running from a git worktree,
    # which does not carry the (gitignored) provider keys.
    load_dotenv()
    for parent in Path(__file__).resolve().parents:
        if (parent / ".env").exists():
            load_dotenv(parent / ".env", override=False)
            break

    resolved = route("reviewer")
    if resolved != REVIEWER_MODEL:
        print(f"STOP: route('reviewer') = {resolved!r}, expected {REVIEWER_MODEL!r}", file=sys.stderr)
        return 2

    labels = load_labels(args.archive)
    instances = _scoped_instances(args.corpus, args.archive)
    calls = load_review_calls(args.corpus, instances)

    args.out.mkdir(parents=True, exist_ok=True)
    telemetry = args.out / "telemetry"
    telemetry.mkdir(exist_ok=True)
    os.environ["FACTORY_STATE_ROOT"] = str(telemetry)
    db_path = telemetry / "replay.db"

    spent_path = args.out / "spend.json"
    spent = json.loads(spent_path.read_text()) if spent_path.exists() else {"total_usd": 0.0}

    out_path = args.out / f"{args.arm}.rep{args.replicate}.ndjson"
    done = {json.loads(x)["instance"] for x in out_path.read_text().splitlines() if x.strip()} if out_path.exists() else set()

    for c in calls:
        if c.instance in done:
            continue
        control, treatment, _ = build_prompts(c)
        prompt = control if args.arm == "control" else treatment
        if args.arm == "control" and hashlib.sha256(prompt.encode()).hexdigest() != c.prompt_hash:
            raise AssertionError(f"{c.instance}: control arm prompt is not byte-identical")
        assert_no_oracle_leakage(prompt, labels[c.instance])

        if spent["total_usd"] >= HARD_SPEND_CAP_USD:
            print(f"STOP: hard spend cap ${HARD_SPEND_CAP_USD} reached", file=sys.stderr)
            return 3

        before = _sum_cost(db_path)
        raw = text_run(
            persona="reviewer",
            prompt=prompt,
            model_id=REVIEWER_MODEL,
            schema=None,
            max_tokens=max_output_tokens_for(REVIEWER_MODEL),
            story_id=c.story_id,
            app="reviewer-replay",
            db_path=db_path,
            software_factory_root=telemetry,
        )
        after = _sum_cost(db_path)
        cost = round(after[0] - before[0], 6)
        spent["total_usd"] = round(after[0], 6)
        spent["tokens_in"] = after[1]
        spent["tokens_out"] = after[2]
        spent_path.write_text(json.dumps(spent, indent=2))

        verdict = _parse_verdict(raw if isinstance(raw, str) else json.dumps(raw))
        rec = {
            "instance": c.instance,
            "arm": args.arm,
            "replicate": args.replicate,
            "model_id": REVIEWER_MODEL,
            "prompt_chars": len(prompt),
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "verdict": verdict,
            "recorded_verdict": c.recorded_verdict,
            "cost_usd": cost,
            "response": raw if isinstance(raw, str) else json.dumps(raw),
        }
        with out_path.open("a") as fh:
            fh.write(json.dumps(rec) + "\n")
        print(
            f"{args.arm}/rep{args.replicate} {c.instance[:44]:45s} "
            f"verdict={verdict:15s} recorded={c.recorded_verdict:15s} "
            f"${cost:.4f}  cum=${spent['total_usd']:.4f}"
        )
    print(f"\narm={args.arm} rep={args.replicate} done. cumulative spend ${spent['total_usd']:.4f}")
    return 0


def _sum_cost(db_path: Path) -> tuple[float, int, int]:
    import sqlite3

    if not db_path.exists():
        return (0.0, 0, 0)
    con = sqlite3.connect(db_path)
    try:
        row = con.execute(
            "SELECT COALESCE(SUM(cost_usd),0), COALESCE(SUM(tokens_in),0), "
            "COALESCE(SUM(tokens_out),0) FROM runs"
        ).fetchone()
    finally:
        con.close()
    return (float(row[0]), int(row[1]), int(row[2]))


def cmd_analyze(args: argparse.Namespace) -> int:
    labels = load_labels(args.archive)
    instances = _scoped_instances(args.corpus, args.archive)
    calls = {c.instance: c for c in load_review_calls(args.corpus, instances)}

    arms: dict[tuple[str, int], dict[str, str]] = {}
    for path in sorted(args.out.glob("*.rep*.ndjson")):
        arm, rep = path.name.split(".")[0], int(path.name.split(".rep")[1].split(".")[0])
        arms[(arm, rep)] = {
            json.loads(x)["instance"]: json.loads(x)["verdict"]
            for x in path.read_text().splitlines()
            if x.strip()
        }

    report: dict[str, Any] = {
        "archive_id": ARCHIVE_ID,
        "n": len(instances),
        "instances": instances,
        "model_id": REVIEWER_MODEL,
        "baseline_recorded": confusion(
            {i: calls[i].recorded_verdict for i in instances}, labels, instances
        ),
        "arms": {},
    }
    for (arm, rep), verdicts in sorted(arms.items()):
        missing = [i for i in instances if i not in verdicts]
        if missing:
            print(f"WARN {arm}/rep{rep}: missing {len(missing)} instances {missing}")
            continue
        entry = confusion(verdicts, labels, instances)
        entry["verdicts"] = verdicts
        if arm == "control":
            entry["fidelity_vs_recorded"] = sum(
                1 for i in instances if verdicts[i] == calls[i].recorded_verdict
            )
        report["arms"][f"{arm}.rep{rep}"] = entry

    ck = f"control.rep{PRIMARY_REPLICATE}"
    tk = f"treatment.rep{PRIMARY_REPLICATE}"
    if ck in report["arms"] and tk in report["arms"]:
        cv, tv = report["arms"][ck]["verdicts"], report["arms"][tk]["verdicts"]
        b = c_ = 0
        flips = []
        for i in instances:
            res = labels[i]["oracle_resolved"]
            c_ok = (cv[i] == "approve") == res
            t_ok = (tv[i] == "approve") == res
            if c_ok and not t_ok:
                b += 1
                flips.append((i, "control_right_treatment_wrong"))
            elif t_ok and not c_ok:
                c_ += 1
                flips.append((i, "treatment_right_control_wrong"))
        report["paired"] = {
            "control_right_treatment_wrong": b,
            "treatment_right_control_wrong": c_,
            "discordant": b + c_,
            "mcnemar_exact_p": mcnemar_exact(b, c_),
            "delta_accuracy": report["arms"][tk]["accuracy"] - report["arms"][ck]["accuracy"],
            "flips": flips,
        }

    # Robustness: every (control replicate, treatment replicate) pairing. The
    # decision rule reads rep1-vs-rep1 only; this shows whether the sign of the
    # effect survives the Reviewer's own nondeterminism.
    pairings = []
    for cr in sorted(r for (a, r) in arms if a == "control"):
        for tr in sorted(r for (a, r) in arms if a == "treatment"):
            cv, tv = arms[("control", cr)], arms[("treatment", tr)]
            if any(i not in cv or i not in tv for i in instances):
                continue
            b = c_ = 0
            for i in instances:
                res = labels[i]["oracle_resolved"]
                c_ok = (cv[i] == "approve") == res
                t_ok = (tv[i] == "approve") == res
                b += int(c_ok and not t_ok)
                c_ += int(t_ok and not c_ok)
            pairings.append(
                {
                    "control_rep": cr,
                    "treatment_rep": tr,
                    "control_correct": sum(
                        1 for i in instances if (cv[i] == "approve") == labels[i]["oracle_resolved"]
                    ),
                    "treatment_correct": sum(
                        1 for i in instances if (tv[i] == "approve") == labels[i]["oracle_resolved"]
                    ),
                    "control_right_treatment_wrong": b,
                    "treatment_right_control_wrong": c_,
                    "mcnemar_exact_p": mcnemar_exact(b, c_),
                }
            )
    report["pairings"] = pairings

    # Self-agreement across replicates, per arm.
    for arm in ("control", "treatment"):
        reps = sorted(r for (a, r) in arms if a == arm)
        if len(reps) < 2:
            continue
        pairs = []
        for x in range(len(reps)):
            for y in range(x + 1, len(reps)):
                vx, vy = arms[(arm, reps[x])], arms[(arm, reps[y])]
                common = [i for i in instances if i in vx and i in vy]
                if common:
                    pairs.append(
                        {
                            "reps": [reps[x], reps[y]],
                            "agree": sum(1 for i in common if vx[i] == vy[i]),
                            "n": len(common),
                        }
                    )
        report.setdefault("self_agreement", {})[arm] = pairs

    spend = args.out / "spend.json"
    report["spend"] = json.loads(spend.read_text()) if spend.exists() else None

    (args.out / "analysis.json").write_text(json.dumps(report, indent=2, default=str))
    (args.out / "grid.md").write_text(_verdict_grid(report, labels, calls, instances))
    print(json.dumps({k: v for k, v in report.items() if k != "arms"}, indent=2, default=str))
    for k, v in report["arms"].items():
        print(
            f"{k:20s} acc={v['accuracy']:.4f} ({v['tp'] + v['tn']}/{v['n']}) "
            f"CI=[{v['acc_ci'][0]:.3f},{v['acc_ci'][1]:.3f}] "
            f"TP={v['tp']} FP={v['fp']} FN={v['fn']} TN={v['tn']} "
            f"prec={v['precision']} rec={v['recall']} "
            f"fidelity={v.get('fidelity_vs_recorded')}"
        )
    return 0


def _verdict_grid(
    report: dict[str, Any],
    labels: dict[str, dict[str, Any]],
    calls: dict[str, ReviewCall],
    instances: list[str],
) -> str:
    """Per-instance verdict grid, as markdown, so the writeup is generated."""
    arm_keys = [k for k in ("control", "treatment") for r in (1, 2, 3) if f"{k}.rep{r}" in report["arms"]]
    cols = [k for k in sorted(report["arms"]) if k.startswith(("control", "treatment"))]

    def cell(v: str, resolved: bool) -> str:
        mark = "ok" if (v == "approve") == resolved else "**X**"
        return f"{'A' if v == 'approve' else 'RC'} {mark}"

    head = "| instance | oracle | recorded | " + " | ".join(cols) + " |"
    rule = "|---" * (3 + len(cols)) + "|"
    lines = [head, rule]
    for i in instances:
        res = labels[i]["oracle_resolved"]
        row = [
            f"`{i}`",
            "resolved" if res else "not resolved",
            cell(calls[i].recorded_verdict, res),
        ]
        row += [cell(report["arms"][c]["verdicts"][i], res) for c in cols]
        lines.append("| " + " | ".join(row) + " |")
    totals = ["**correct / 18**", "", f"{report['baseline_recorded']['tp'] + report['baseline_recorded']['tn']}"]
    totals += [f"{report['arms'][c]['tp'] + report['arms'][c]['tn']}" for c in cols]
    lines.append("| " + " | ".join(totals) + " |")
    del arm_keys
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    ap.add_argument(
        "--archive",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "swebench" / "results-archive" / ARCHIVE_ID,
    )
    ap.add_argument("--out", type=Path, default=Path("/tmp/reviewer-replay-out"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("baseline").set_defaults(fn=cmd_baseline)
    sub.add_parser("build").set_defaults(fn=cmd_build)
    r = sub.add_parser("run")
    r.add_argument("--arm", choices=["control", "treatment"], required=True)
    r.add_argument("--replicate", type=int, default=1)
    r.set_defaults(fn=cmd_run)
    sub.add_parser("analyze").set_defaults(fn=cmd_analyze)
    args = ap.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    raise SystemExit(main())
