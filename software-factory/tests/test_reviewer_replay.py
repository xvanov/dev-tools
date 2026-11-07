"""Tests for the A.4 reviewer execution-evidence replay harness.

The two properties that actually matter are the **splice** (the treatment arm
must be the archived prompt with exactly one section swapped, never a
control-shaped prompt smuggled through) and the **oracle-leakage assertion**
(the hidden oracle is a label, never an input). Both get adversarial cases here,
not just happy paths.

The harness lives in a hyphenated directory so it can carry its own
pre-registration and results next to it, which means it is loaded by path.
"""

from __future__ import annotations

import builtins
import importlib.util
import json
import sys
from pathlib import Path

import pytest

_REPLAY = Path(__file__).resolve().parents[1] / "bench" / "reviewer-replay" / "replay.py"


def _load():
    spec = importlib.util.spec_from_file_location("_a4_replay", _REPLAY)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_a4_replay"] = mod
    spec.loader.exec_module(mod)
    return mod


replay = _load()


# ---------------------------------------------------------------------------
# Fixtures — a minimal synthetic corpus. No network, no real corpus needed.
# ---------------------------------------------------------------------------

ARCHIVED_PROMPT = (
    "# Reviewer persona\n\n## Goal\n\nDecide.\n\n"
    "## Story\n\nfix the thing\n\n"
    "## Test plan\n\n{}\n\n"
    "## Latest test output\n\n"
    "(from dev_attempts[-1]; attempt=0 ts='2026-08-03T20:00:00+00:00' run_verdict=PASSED)\n"
    "1 passed in 0.10s\n\n"
    "## DEV SELF-SUMMARY (dev's own unverified claims)\n\nI fixed it.\n\n"
    "## PR diff\n\ndiff --git a/x.py b/x.py\n+pass\n\n"
    "Return the JSON object for the review. No prose outside the JSON."
)


def _traj_rows() -> list[dict]:
    wt = "/home/k/.cache/swebench-work/acme__widget-1/root/state/worktrees/swebench-9-abc"
    return [
        {
            "observation": {
                "kind": "FileEditorObservation",
                "command": "str_replace",
                "path": f"{wt}/tests/test_x.py",
                "content": [{"type": "text", "text": "edited"}],
            }
        },
        {
            "observation": {
                "kind": "TerminalObservation",
                "command": f"cd {wt} && python -m pytest tests/test_x.py",
                "exit_code": 1,
                "content": [{"type": "text", "text": "E   AssertionError: boom\n1 failed"}],
            }
        },
        {
            "observation": {
                "kind": "TerminalObservation",
                "command": f"cd {wt} && python -m pytest tests/test_x.py",
                "exit_code": 0,
                "content": [{"type": "text", "text": "1 passed in 0.10s"}],
            }
        },
        {
            "observation": {
                "kind": "TerminalObservation",
                "command": f"cd {wt} && git diff",
                "exit_code": 0,
                "content": [{"type": "text", "text": "diff"}],
            }
        },
    ]


@pytest.fixture
def traj(tmp_path: Path) -> Path:
    p = tmp_path / "1-1.ndjson"
    p.write_text("\n".join(json.dumps(r) for r in _traj_rows()) + "\n")
    return p


# ---------------------------------------------------------------------------
# The splice.
# ---------------------------------------------------------------------------


def test_splice_replaces_only_the_test_output_section():
    out = replay.splice_treatment(ARCHIVED_PROMPT, "EVIDENCE-BLOCK")

    # The dev's self-reported tail is gone.
    assert "## Latest test output" not in out
    assert "run_verdict=PASSED" not in out
    # The transcript and the precedence rule are in.
    assert "## Independent execution transcript" in out
    assert "the transcript wins" in out
    assert "EVIDENCE-BLOCK" in out
    # Everything else survives byte-for-byte, in order.
    for keep in (
        "# Reviewer persona",
        "## Goal",
        "## Story\n\nfix the thing",
        "## Test plan\n\n{}",
        "## DEV SELF-SUMMARY",
        "## PR diff\n\ndiff --git a/x.py b/x.py\n+pass",
        "Return the JSON object for the review.",
    ):
        assert keep in out
    assert out.index("## Independent execution transcript") < out.index("## DEV SELF-SUMMARY")
    assert out.index("## DEV SELF-SUMMARY") < out.index("## PR diff")


def test_splice_preserves_the_prompt_prefix_and_suffix_exactly():
    out = replay.splice_treatment(ARCHIVED_PROMPT, "E")
    head = ARCHIVED_PROMPT[: ARCHIVED_PROMPT.index(replay.TEST_OUTPUT_HEADER)]
    tail = ARCHIVED_PROMPT[ARCHIVED_PROMPT.index(replay.DEV_SUMMARY_HEADER) :]
    assert out.startswith(head)
    assert out.endswith(tail)


def test_splice_keeps_the_whole_diff_untouched():
    big = ARCHIVED_PROMPT.replace("+pass", "+pass\n" + "\n".join(f"+line{i}" for i in range(500)))
    out = replay.splice_treatment(big, "E")
    assert big[big.index("## PR diff") :] in out


@pytest.mark.parametrize(
    "broken",
    [
        ARCHIVED_PROMPT.replace("\n\n## Latest test output\n\n", "\n\n## Test output\n\n"),
        ARCHIVED_PROMPT.replace("\n\n## DEV SELF-SUMMARY", "\n\n## Dev summary"),
        "no sections at all",
    ],
)
def test_splice_hard_fails_on_a_missing_boundary(broken: str):
    """A missing boundary must raise, never silently yield a control-shaped prompt."""
    with pytest.raises(AssertionError, match="missing boundary"):
        replay.splice_treatment(broken, "E")


def test_splice_is_not_a_no_op_fallback():
    """Regression guard: the treatment must never equal the control."""
    out = replay.splice_treatment(ARCHIVED_PROMPT, "E")
    assert out != ARCHIVED_PROMPT


# ---------------------------------------------------------------------------
# Oracle-leakage assertions.
# ---------------------------------------------------------------------------


def test_assert_no_oracle_leakage_catches_log_tail():
    label = {"log_tail": "x" * 100, "gold_files": []}
    replay.assert_no_oracle_leakage("clean prompt", label)
    with pytest.raises(AssertionError, match="log_tail"):
        replay.assert_no_oracle_leakage("prefix " + "x" * 100, label)


def test_assert_no_oracle_leakage_catches_oracle_tokens():
    label = {"log_tail": "", "gold_files": []}
    for tok in replay.LEAK_TOKENS:
        with pytest.raises(AssertionError, match=tok):
            replay.assert_no_oracle_leakage(f"... {tok}: tests/test_x.py ...", label)


def test_assert_no_oracle_leakage_catches_gold_file_marker():
    label = {"log_tail": "", "gold_files": ["src/a.py"]}
    replay.assert_no_oracle_leakage("touches src/a.py in the diff", label)
    with pytest.raises(AssertionError, match="gold-file"):
        replay.assert_no_oracle_leakage("GOLD:src/a.py", label)


def test_short_log_tail_is_not_treated_as_a_leak():
    """A tiny tail like 'ok' would false-positive on any prompt; bound it."""
    replay.assert_no_oracle_leakage("everything is ok here", {"log_tail": "ok", "gold_files": []})


def test_build_prompts_never_opens_the_results_archive(traj: Path, monkeypatch):
    """Module boundary: the prompt path must not read oracle-bearing files."""
    real_open = builtins.open
    forbidden = ("result.json", "results-archive", "oracle.json")
    opened: list[str] = []

    def check(file) -> None:
        opened.append(str(file))
        if any(f in str(file) for f in forbidden):
            raise AssertionError(f"prompt path opened an oracle file: {file}")

    real_path_open = Path.open
    real_read_text = Path.read_text

    def guard(file, *a, **kw):
        check(file)
        return real_open(file, *a, **kw)

    def guard_path_open(self, *a, **kw):
        check(self)
        return real_path_open(self, *a, **kw)

    def guard_read_text(self, *a, **kw):
        check(self)
        return real_read_text(self, *a, **kw)

    monkeypatch.setattr(builtins, "open", guard)
    monkeypatch.setattr(Path, "open", guard_path_open)
    monkeypatch.setattr(Path, "read_text", guard_read_text)

    call = replay.ReviewCall(
        instance="acme__widget-1",
        story_id=1,
        seq=2,
        model_id=replay.REVIEWER_MODEL,
        prompt=ARCHIVED_PROMPT,
        prompt_hash="",
        recorded_verdict="approve",
        trajectory_paths=[traj],
    )
    control, treatment, block = replay.build_prompts(call)
    assert control == ARCHIVED_PROMPT
    assert treatment != control
    assert block
    assert opened, "the guard did not observe any file access"


# ---------------------------------------------------------------------------
# Evidence block + provenance.
# ---------------------------------------------------------------------------


def test_evidence_block_reports_the_red_then_green_sequence(traj: Path):
    actions = replay.read_actions([traj])
    block = replay.build_evidence_block(actions, 1)
    assert "Test-runner invocations: 2" in block
    assert "Test-runner exit codes, in order: 1, 0" in block
    assert "AssertionError: boom" in block
    assert "1 passed in 0.10s" in block
    # The edit is visible with its repo-relative path, which is the point.
    assert "EDIT str_replace <REPO>/tests/test_x.py" in block
    # `git diff` is not a test-runner invocation.
    assert "$ cd <REPO> && git diff" in block
    assert block.count("--- run ") == 2


def test_redaction_strips_host_prefix_and_image_but_keeps_the_repo_tail():
    raw = (
        "cd /home/k/.cache/swebench-work/acme__w-1/root/state/worktrees/swebench-9-abc"
        "/tests/test_x.py && docker run swerebench/sweb.eval.x86_64.acme_1776_w-1@sha256:deadbeef"
    )
    out = replay.redact(raw)
    assert "/home/k/" not in out
    assert "swebench-work" not in out
    assert "sweb.eval" not in out
    assert "sha256" not in out
    assert "<REPO>/tests/test_x.py" in out
    assert "<TESTBED_IMAGE>" in out


def test_provenance_assertion_rejects_an_injected_command(traj: Path):
    actions = replay.read_actions([traj])
    block = replay.build_evidence_block(actions, 1)
    replay.assert_evidence_provenance(block, [traj])

    injected = block.replace(
        "[s1 #002] exit=1 $ cd <REPO> && python -m pytest tests/test_x.py",
        "[s1 #002] exit=1 $ cd <REPO> && python -m pytest ORACLE_ONLY_TEST_ID",
        1,
    )
    assert injected != block
    with pytest.raises(AssertionError, match="provenance"):
        replay.assert_evidence_provenance(injected, [traj])


def test_provenance_assertion_rejects_an_injected_output_chunk(traj: Path):
    actions = replay.read_actions([traj])
    block = replay.build_evidence_block(actions, 1)
    injected = block.replace("1 passed in 0.10s", "FAIL_TO_PASS satisfied", 1)
    with pytest.raises(AssertionError, match="provenance"):
        replay.assert_evidence_provenance(injected, [traj])


def test_evidence_block_respects_its_budgets(tmp_path: Path):
    wt = "/x/swebench-work/i/root/state/worktrees/w"
    rows = [
        {
            "observation": {
                "kind": "TerminalObservation",
                "command": f"cd {wt} && pytest tests/test_{i}.py",
                "exit_code": 0,
                "content": [{"type": "text", "text": f"run{i} " + "Z" * 40_000}],
            }
        }
        for i in range(60)
    ]
    p = tmp_path / "1-1.ndjson"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    block = replay.build_evidence_block(replay.read_actions([p]), 1)
    replay.assert_evidence_provenance(block, [p])
    assert "Test-runner invocations: 60" in block
    # Elided down to the most recent MAX_TEST_RUNS, and inside budget.
    assert block.count("--- run ") == replay.MAX_TEST_RUNS
    assert "earlier test-runner invocations elided" in block
    assert len(block) < replay.SPINE_BUDGET + replay.TEST_OUTPUT_BUDGET + 20_000


def test_spine_elides_but_keeps_head_and_tail(tmp_path: Path):
    wt = "/x/swebench-work/i/root/state/worktrees/w"
    rows = [
        {
            "observation": {
                "kind": "TerminalObservation",
                "command": f"cd {wt} && echo marker-{i} " + "y" * 200,
                "exit_code": 0,
                "content": [{"type": "text", "text": "ok"}],
            }
        }
        for i in range(300)
    ]
    p = tmp_path / "1-1.ndjson"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    block = replay.build_evidence_block(replay.read_actions([p]), 1)
    replay.assert_evidence_provenance(block, [p])
    assert "actions elided" in block
    assert "marker-0 " in block
    assert "marker-299 " in block
    assert "marker-150 " not in block


# ---------------------------------------------------------------------------
# Statistics.
# ---------------------------------------------------------------------------


def test_clopper_pearson_matches_published_values():
    # R: binom.test(8, 18)$conf.int -> 0.2153, 0.6924
    lo, hi = replay.clopper_pearson(8, 18)
    assert lo == pytest.approx(0.21530, abs=5e-5)
    assert hi == pytest.approx(0.69243, abs=5e-5)
    # R: binom.test(0, 10)$conf.int -> 0.0000, 0.3085
    lo0, hi0 = replay.clopper_pearson(0, 10)
    assert lo0 == 0.0
    assert hi0 == pytest.approx(0.30850, abs=5e-5)
    # R: binom.test(10, 10)$conf.int -> 0.6915, 1.0000
    lo1, hi1 = replay.clopper_pearson(10, 10)
    assert lo1 == pytest.approx(0.69150, abs=5e-5)
    assert hi1 == 1.0


def test_mcnemar_exact_matches_hand_computation():
    assert replay.mcnemar_exact(0, 0) == 1.0
    # 6-0 discordant: 2 * 0.5^6 = 0.03125
    assert replay.mcnemar_exact(6, 0) == pytest.approx(0.03125)
    assert replay.mcnemar_exact(0, 6) == pytest.approx(0.03125)
    # 5-1: 2 * (0.5^6 + 6*0.5^6) = 0.21875
    assert replay.mcnemar_exact(5, 1) == pytest.approx(0.21875)
    # Symmetric and never above 1.
    assert replay.mcnemar_exact(3, 3) == 1.0


def test_confusion_matches_the_preregistered_baseline_shape():
    labels = {f"i{k}": {"oracle_resolved": k < 7} for k in range(18)}
    verdicts = {f"i{k}": ("approve" if k in {0, 1, 2, 3, 4, 5} else "request_changes") for k in range(18)}
    # 9 of the 11 negatives also approved.
    for k in range(7, 16):
        verdicts[f"i{k}"] = "approve"
    got = replay.confusion(verdicts, labels, list(labels))
    assert (got["tp"], got["fp"], got["fn"], got["tn"]) == (6, 9, 1, 2)
    assert got["accuracy"] == pytest.approx(8 / 18)
    assert got["precision"] == pytest.approx(0.4)
    assert got["recall"] == pytest.approx(6 / 7)


def test_parse_verdict_degrades_unparseable_to_request_changes():
    assert replay._parse_verdict('{"verdict": "approve"}') == "approve"
    assert replay._parse_verdict("not json at all") == "request_changes"
