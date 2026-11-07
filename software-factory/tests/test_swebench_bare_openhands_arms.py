"""The bare arm's loop, the openhands reference arm, and per-row model recording.

Why this file exists: on 2026-08-03 an adversarial audit destroyed the published
``bare deepseek-v4-pro 0/19`` column — and with it the "+58pp scaffold lift at
matched weights" headline — by showing that every one of those rows measured
``run_bare``'s bugs rather than the model. Nebius publishes the SAME deployment
at 40.2% under its own minimal scaffold, so P(0 of 19 | p=0.402) = 5.7e-5.

Every test below pins one of those defects shut. They are fixture-driven and
call NO model: the loop is driven by a scripted ``text_run`` stand-in over a
real throwaway git repo, so the whole pipeline (prompt assembly → parse →
execute → observe → diff capture → ``split_diff`` → ``assert_no_test_edits`` →
``result.json``) is exercised for $0. That is deliberate — the arm's failures
were all in the plumbing, and plumbing is exactly what a free test can prove.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).parent.parent
_ADAPTER = _REPO_ROOT / "bench" / "swebench_adapter.py"
_RUNNER = _REPO_ROOT / "factory" / "runner.py"


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_arms_under_test", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_arms_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


@pytest.fixture(autouse=True)
def _isolate_the_scratch_work_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The arms' live working trees live OUTSIDE the repo now, under
    ``$SWEBENCH_WORK_ROOT`` (default ``$XDG_CACHE_HOME/swebench-work``).

    Without this every test that drives ``run_bare``/``run_openhands`` would
    clone into the operator's real cache. Test pollution of production state has
    already faked a whole class of failure in this repo once.
    """
    monkeypatch.setenv("SWEBENCH_WORK_ROOT", str(tmp_path / "work"))


# --------------------------------------------------------------------------- #
# prompt parity — the invalidating defect
# --------------------------------------------------------------------------- #

# The rendered story template, hashed. Re-pinned 2026-08-03 when the operator
# decided to give the base-suite note to EVERY arm (it was bare-only in #223, to
# avoid confounding two axes at once). The five-arm re-run is therefore a fresh
# baseline, not a before/after against the retracted run. The pin stays because
# a silent later drift would again mean two arms ran under different
# instructions.
_STORY_TEMPLATE_SHA256 = "4ffb8e821bb56b236667d11076f3729c5dc25cd03001fa4aa2aa6c0b84b91da1"


def test_story_template_rendering_is_unchanged(A: Any) -> None:  # noqa: N803
    got = hashlib.sha256(A._STORY_TEMPLATE.encode("utf-8")).hexdigest()
    assert got == _STORY_TEMPLATE_SHA256, (
        "the factory/openhands/claude prompt text moved. That is allowed only "
        "in a PR that re-runs those arms — otherwise the published columns and "
        "the new ones were produced under different instructions."
    )


def test_bare_arm_gets_the_shared_test_policy_verbatim(A: Any) -> None:  # noqa: N803
    """THE invalidating asymmetry: bare was told test edits are "wasted effort"
    while factory and claude were told to write tests as their feedback loop.
    Same stripping mechanic, opposite instruction, on the control arm."""
    assert A._TEST_POLICY in A._STORY_TEMPLATE
    assert A._TEST_POLICY in A._BARE_SYSTEM
    lowered = A._BARE_SYSTEM.lower()
    assert "wasted effort" not in lowered
    assert "do not create, edit or delete test files" not in lowered


def test_bare_task_says_the_targeted_tests_already_pass(A: Any) -> None:  # noqa: N803
    """The test command bare gates DONE on cannot fail: it targets the
    fail_to_pass FILES at base_commit, before the withheld gold test patch adds
    the tests. Measured on the 19 pinned instances: 3 target a file that does
    not exist, 11 more contain ZERO fail_to_pass functions, and the other 5
    contain them asserting the OLD behaviour."""
    task = A._BARE_TASK.format(repo="x/y", statement="s", test_command="CMD")
    assert "ALREADY" in task and "PASS" in task
    assert "do NOT cover the task" in task
    assert A._BASE_TESTS_NOTE in task


def test_every_arm_gets_the_base_tests_note_byte_identical(A: Any) -> None:
    """Prompt parity, actually true now.

    #223 gave the base-suite warning to `bare` only and left a TODO(operator):
    the factory/openhands/claude prompts carried the same unqualified "run this
    command" instruction, so "matched prompt" was false. The operator's decision
    is to apply it identically everywhere. ONE string reaches all four arms, and
    the TODO is gone — a residual asymmetry here is the invalidating defect, not
    a nitpick.
    """
    note = A._BASE_TESTS_NOTE
    assert note in A._STORY_TEMPLATE, "factory/openhands/claude render this"
    assert note in A._BARE_TASK
    rendered_shared = A._STORY_TEMPLATE.format(
        instance_id="i", statement="s", test_command="CMD"
    )
    assert note in rendered_shared
    src = _ADAPTER.read_text(encoding="utf-8")
    assert "TODO(operator)" not in src, "the parity TODO must be discharged"
    # And exactly one definition of it, so the arms cannot drift apart again.
    assert src.count("_BASE_TESTS_NOTE = ") == 1


# --------------------------------------------------------------------------- #
# the parser: fabricated observations, and deepseek's native fence
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "fabrication",
    [
        "Exit 0",
        "Exit code: 0",
        "Output: 3 passed",
        "Result: 3 passed, 0 failed",
    ],
)
def test_parser_truncates_at_every_fabricated_observation_shape(
    A: Any, fabrication: str  # noqa: N803
) -> None:
    """``Exit code:`` and ``Result:`` were NOT caught by the old stop pattern,
    and 76 of 231 measured replies carried a fabricated observation line."""
    cmd = A._parse_bash(f"BASH\ntouch real.txt\n{fabrication}\nrm -rf /\n")
    assert cmd == "touch real.txt"


def test_parser_accepts_a_plain_bash_fence(A: Any) -> None:  # noqa: N803
    """deepseek's native output shape. 34 of 231 replies had no BASH marker;
    12 were exactly this and were discarded as "Invalid reply", burning turns
    on protocol tax."""
    assert A._parse_bash("Here is the fix:\n\n```bash\nls -la\n```") == "ls -la"
    assert A._parse_bash("```sh\necho hi\n```") == "echo hi"
    # …and the fabrication rules still apply INSIDE a fence.
    assert (
        A._parse_bash("```bash\ntouch a\nResult: ok\ntouch b\n```") == "touch a"
    )


def test_parser_still_rejects_a_fence_with_no_shell_language(A: Any) -> None:  # noqa: N803
    """An untagged or python-tagged fence is as likely to be code or pasted
    output as a command; guessing would execute the model's prose."""
    assert A._parse_bash("```\nls\n```") is None
    assert A._parse_bash("```python\nprint(1)\n```") is None


# --------------------------------------------------------------------------- #
# a real repo + a scripted model: the loop end to end, for $0
# --------------------------------------------------------------------------- #

_INST = {
    "instance_id": "acme__widget-1",
    "repo": "acme/widget",
    "base_commit": "0" * 40,
    "problem_statement": "widget() must return 2",
    "problem_statement_sha256": "f" * 64,
    "fail_to_pass": ["tests/test_widget.py::test_widget"],
    "selected_test_files_to_run": ["tests/test_widget.py"],
    "docker_image": "example/image:latest",
}


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
    )


def _seed_repo(dest: Path) -> str:
    """A throwaway repo shaped like a prepared bench clone: one production
    file, one test file, and the ``swebench-base`` ref the diff capture uses.

    Returns the base commit sha. Callers stamp it onto the INSTANCE DICT they
    hand the arm — see ``_clone_stub`` — because a real prepared clone is checked
    out AT ``base_commit``, so that sha always resolves in the tree. The old
    ``"0" * 40`` placeholder did not, which made this fixture the only tree in the
    suite with no honest ref to diff against (measured over 114 real prepared
    trees: 114/114 carry their manifest base commit).
    """
    dest.mkdir(parents=True, exist_ok=True)
    _git(dest, "init", "-q")
    (dest / "widget.py").write_text("def widget():\n    return 1\n", encoding="utf-8")
    (dest / "tests").mkdir()
    (dest / "tests" / "test_widget.py").write_text(
        "from widget import widget\n\n\ndef test_widget():\n    assert widget() == 1\n",
        encoding="utf-8",
    )
    _git(dest, "add", "-A")
    _git(
        dest,
        "-c", "user.email=bench@example.com",
        "-c", "user.name=bench",
        "commit", "-q", "-m", "base",
    )
    _git(dest, "branch", "-f", "swebench-base", "HEAD")
    return subprocess.run(
        ["git", "-C", str(dest), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _clone_stub(inst: dict[str, Any], dest: Path) -> None:
    """``_clone`` stand-in that keeps ``inst["base_commit"]`` true of the tree.

    Deliberately NOT a mutation of the module-level ``_INST``: tests in one
    worker share it, every ``_seed_repo`` produces a DIFFERENT sha, and under
    ``-n`` a test then read another test's sha and the diff-capture integrity
    check correctly refused the row. Stamping the dict the arm was handed, from
    the tree this call just built, is order-independent.
    """
    inst["base_commit"] = _seed_repo(dest)


class _ScriptedModel:
    """A ``text_run`` stand-in. Records every message list it is handed, so a
    test can assert what the model could and could not have seen."""

    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.seen: list[list[dict[str, str]]] = []
        self.calls = 0

    def __call__(self, **kwargs: Any) -> str:
        self.calls += 1
        msgs = kwargs.get("messages")
        assert msgs is not None, (
            "run_bare must send a ROLE-TAGGED message list; a flat user string "
            "is what let the model read its own fabrications back as real"
        )
        self.seen.append([dict(m) for m in msgs])
        return self.replies.pop(0) if self.replies else "DONE"


@pytest.fixture
def bare_run(A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:  # noqa: N803
    """Drive ``run_bare`` against a real git tree with a scripted model."""
    import factory.runner as runner_mod

    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_instance", lambda _id: dict(_INST))
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "deadbeef"})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda _insts: None)
    monkeypatch.setattr(A, "_ensure_image", lambda _inst, timeout_s=1800: True)
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda _inst, _repo: None)
    monkeypatch.setattr(
        A,
        "_precheck_collect",
        lambda _inst, _repo: {
            "collect_ok": True,
            "duration_s": 0.1,
            "mode": "existing-targets",
            "collected_targets": ["tests/test_widget.py"],
            "exit_code": 0,
            "tail": "",
        },
    )
    monkeypatch.setattr(
        A, "instance_test_command", lambda *a, **k: "echo '1 passed'"
    )
    monkeypatch.setattr(A, "_clone", _clone_stub)

    def _drive(
        replies: list[str], *, model: Any = None, **kw: Any
    ) -> tuple[Any, dict[str, Any], Path]:
        # ``model`` lets a test supply its OWN stand-in (e.g. one that also
        # writes the ledger row a real ``text_run`` writes) instead of the plain
        # scripted one.
        model = model if model is not None else _ScriptedModel(replies)
        monkeypatch.setattr(runner_mod, "text_run", model)
        A.run_bare(_INST["instance_id"], max_steps=kw.pop("max_steps", 10),
                   timeout_s=kw.pop("timeout_s", 600), **kw)
        run_dir = (tmp_path / "runs") / str(_INST["instance_id"]) / "bare"
        result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
        return model, result, run_dir

    return _drive


_WRITE_FIX_FENCED = (
    "Now the fix:\n\n```bash\nprintf 'def widget():\\n    return 2\\n' > widget.py\n```"
)


def test_a_fabricated_result_line_can_never_become_an_observation(
    bare_run: Any, A: Any  # noqa: N803
) -> None:
    """THE core fix. The loop used to send ``"\\n\\n".join(history)`` as one flat
    user string and echo the model's RAW reply into it, so a hallucinated
    ``Exit 0 / Output: / Result:`` block was indistinguishable from the
    environment's real answer. Two runs declared DONE on invented results;
    ``conan-19750`` wrote 11,890 characters, executed ZERO commands and said
    "The tests now pass. DONE"."""
    fabricated = (
        "I ran the suite.\n"
        "Exit code: 0\n"
        "Output:\n15 passed, 0 failed\n"
        "Result: all green\n"
        "SECRET_FABRICATION_MARKER\n"
    )
    model, result, _run_dir = bare_run([fabricated, _WRITE_FIX_FENCED, "DONE"])
    every_message = [
        m["content"] for conversation in model.seen for m in conversation
    ]
    blob = "\n".join(every_message)
    assert "SECRET_FABRICATION_MARKER" not in blob, (
        "the model's raw reply reached the context; only the PARSED COMMAND "
        "may be echoed back"
    )
    # The only "Exit …/Output:" lines in the context are the environment's own
    # observations, and there is exactly one per executed command.
    assert blob.count("Result: all green") == 0
    assert blob.count("Exit code: 0") == 0
    assert result["diff_bytes"] > 0


def test_a_fabricated_tail_after_a_REAL_command_is_neither_run_nor_echoed(
    bare_run: Any, A: Any  # noqa: N803
) -> None:
    """The other half of the fix, and the half a fabrication-only reply cannot
    reach: a reply that carries a GENUINE command AND then invents its result.

    That is the measured shape — ``conan-19750`` emitted 8 fenced blocks in one
    11,890-character reply. Two things must hold, and only one of them is about
    the parser: the fabricated tail must not be EXECUTED (the old greedy regex
    ran it as shell), and the ASSISTANT turn written into history must be the
    parsed command alone. Echoing ``reply`` here would put the invented result
    back in the context wearing the model's own role, which is exactly how the
    arm came to trust it.
    """
    reply = (
        "```bash\n"
        "printf 'def widget():\\n    return 2\\n' > widget.py\n"
        "```\n"
        "Exit 0. Output:\n"
        "1 passed\n"
        "```bash\n"
        "touch SHOULD_NEVER_BE_EXECUTED\n"
        "```\n"
    )
    model, result, run_dir = bare_run([reply, "DONE"])
    # The live tree is OUTSIDE the repo now (`_work_dir`), so asserting against
    # `run_dir / "repo"` would pass vacuously and stop testing the parser.
    work_repo = A._work_dir(str(_INST["instance_id"]), "bare") / "repo"
    assert work_repo.is_dir(), "the arm's clone is not where _work_dir puts it"
    assert not (work_repo / "SHOULD_NEVER_BE_EXECUTED").exists(), (
        "the fabricated tail was executed as real shell"
    )
    assert (work_repo / "widget.py").exists(), "the REAL command did not run"
    assistant_turns = [
        m["content"]
        for conv in model.seen
        for m in conv
        if m["role"] == "assistant"
    ]
    assert assistant_turns, "the executed command was never echoed into history"
    for turn in assistant_turns:
        assert "Exit 0. Output:" not in turn, (
            "the RAW reply reached history under the assistant role — only the "
            "parsed command may be echoed"
        )
        assert "SHOULD_NEVER_BE_EXECUTED" not in turn
    # And the real command did land: one production change, one observation.
    assert result["diff_bytes"] > 0
    assert result["files_changed"] == ["widget.py"]
    logged = [
        json.loads(line)
        for line in (run_dir / "bare-commands.ndjson")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    ran = [r for r in logged if "command" in r]
    assert len(ran) == 1, f"expected exactly one executed command, got {ran}"
    assert "widget.py" in ran[0]["command"]
    assert "output" in ran[0], "the command log must record what the model saw"


def test_done_with_an_empty_diff_does_not_terminate_the_loop(
    bare_run: Any, A: Any  # noqa: N803
) -> None:
    """6 of 19 measured rows (32%) shipped 0 bytes. DONE was accepted
    unconditionally, so an arm that never wrote a file — or that reverted its
    own correct fix, as ``ucfopen__canvasapi-716`` did — reported "done"."""
    model, result, run_dir = bare_run(["DONE", _WRITE_FIX_FENCED, "DONE"])
    assert model.calls == 3, "the first DONE must have been rejected and nudged"
    assert result["done_nudges"] == 1
    assert result["termination"] == "done"
    assert result["done_with_empty_diff"] is False
    assert result["diff_bytes"] > 0
    # The nudge is an environment turn, and it says what is wrong.
    nudges = [
        m["content"]
        for conv in model.seen
        for m in conv
        if m["role"] == "user" and "would be EMPTY" in m["content"]
    ]
    assert nudges, "the model was never told its tree was empty"


def test_the_empty_diff_nudge_is_capped(bare_run: Any, A: Any) -> None:  # noqa: N803
    """CLAUDE.md: nothing loops more than 3 times. A model that insists on DONE
    with an empty tree must be accepted and RECORDED, not nudged forever."""
    model, result, _run_dir = bare_run(["DONE"] * 10, max_steps=10)
    assert model.calls == A._BARE_DONE_NUDGES + 1 == 3
    assert result["termination"] == "done-empty-diff"
    assert result["done_with_empty_diff"] is True
    assert result["diff_bytes"] == 0


def test_test_only_changes_count_as_an_empty_diff(bare_run: Any) -> None:
    """``split_diff`` strips test edits before grading, so a tree holding only
    test edits grades as nothing. The nudge has to agree with the grader."""
    write_test_only = (
        "```bash\nprintf 'def test_x():\\n    assert True\\n' > tests/test_new.py\n```"
    )
    model, result, _run_dir = bare_run([write_test_only, "DONE", "DONE", "DONE"])
    assert result["termination"] == "done-empty-diff"
    assert result["diff_bytes"] == 0
    assert result["test_files_stripped"], "the test edit should have been stripped"


def test_the_system_prompt_and_task_are_never_evicted(
    bare_run: Any, A: Any  # noqa: N803
) -> None:
    """``history[-24:]`` over a list that started at 2 and grew by 2 per step
    dropped the system prompt and the task after step 11 — and invalid-format
    replies clustered at exactly steps 12-24, in the four longest runs, all four
    of which ended wrong or empty."""
    model, _result, _run_dir = bare_run(["BASH\ntrue"] * 30, max_steps=30)
    assert model.calls == 30
    for conversation in model.seen:
        assert conversation[0]["role"] == "system"
        assert conversation[0]["content"] == A._BARE_SYSTEM
        assert conversation[1]["role"] == "user"
        assert "widget() must return 2" in conversation[1]["content"]
        assert len(conversation) <= 2 + A._BARE_HISTORY_TURNS


def test_a_command_timeout_is_an_observation_not_a_crash(
    bare_run: Any, A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """``subprocess.run(..., timeout=300)`` had no handler, so one slow
    ``docker run … pytest`` raised out of ``run_bare`` and killed the run with
    no result.json at all — the sweep then reported a row that never existed."""
    monkeypatch.setattr(A, "_BARE_CMD_TIMEOUT_S", 1)
    model, result, run_dir = bare_run(["BASH\nsleep 30", _WRITE_FIX_FENCED, "DONE"])
    assert result["error"] is None, "a slow command must not fail the run"
    observations = [
        m["content"]
        for conv in model.seen
        for m in conv
        if m["role"] == "user" and "timed out" in m["content"]
    ]
    assert observations, "the model was never told its command timed out"
    rows = [
        json.loads(line)
        for line in (run_dir / "bare-commands.ndjson").read_text().splitlines()
    ]
    assert any("timed out" in str(r.get("output", "")) for r in rows)


def test_the_command_log_records_exit_code_and_output(bare_run: Any) -> None:
    """``bare-commands.ndjson`` held commands only and ``result.json``'s
    transcript held 300-char commands with NO output, so reconstructing what the
    arm actually SAW meant hand-joining prompt_bodies.ndjson. The audit's
    oracle-probe scan also never saw command OUTPUT."""
    _model, result, run_dir = bare_run(
        ["BASH\necho hello-from-the-shell", _WRITE_FIX_FENCED, "DONE"]
    )
    rows = [
        json.loads(line)
        for line in (run_dir / "bare-commands.ndjson").read_text().splitlines()
    ]
    first = rows[0]
    assert first["command"] == "echo hello-from-the-shell"
    assert first["exit"] == 0
    assert "hello-from-the-shell" in first["output"]
    # Terminal reason and trajectory pointer are in the row, not folklore.
    assert result["trajectory"] == "bare-commands.ndjson"
    assert {r["step"] for r in rows} == {r["step"] for r in result["transcript"]}


def test_an_unparseable_reply_is_told_so_without_being_echoed(
    bare_run: Any,  # noqa: N803
) -> None:
    model, _result, run_dir = bare_run(
        ["let me think about this\nResult: nothing", _WRITE_FIX_FENCED, "DONE"]
    )
    blob = "\n".join(m["content"] for conv in model.seen for m in conv)
    assert "let me think about this" not in blob
    assert "no runnable command" in blob
    rows = [
        json.loads(line)
        for line in (run_dir / "bare-commands.ndjson").read_text().splitlines()
    ]
    assert rows[0]["action"] == "invalid"


def test_a_reply_that_both_patches_and_says_done_runs_the_command(
    bare_run: Any,  # noqa: N803
) -> None:
    """The old test was ``"DONE" in reply and "BASH" not in reply``, so whether a
    patch-plus-"then reply DONE" message executed depended on the word BASH
    appearing anywhere in it."""
    reply = _WRITE_FIX_FENCED + "\n\nThen I will reply DONE."
    _model, result, _run_dir = bare_run([reply, "DONE"])
    assert result["diff_bytes"] > 0
    assert result["files_changed"] == ["widget.py"]


def test_the_summary_shouts_when_the_diff_is_empty(
    bare_run: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    """An empty diff was 6 of 19 rows and nothing said so on stdout."""
    bare_run(["DONE"] * 5, max_steps=5)
    out = capsys.readouterr().out
    assert "EMPTY DIFF" in out
    assert "terminated by    : done-empty-diff" in out


def test_the_summary_reports_model_steps_and_files(
    bare_run: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    bare_run([_WRITE_FIX_FENCED, "DONE"])
    out = capsys.readouterr().out
    assert "model (nominal)" in out
    assert "steps used / cap : 2 / 10" in out
    assert "widget.py" in out
    assert "EMPTY DIFF" not in out


# --------------------------------------------------------------------------- #
# the free plumbing probe
# --------------------------------------------------------------------------- #


def test_probe_plumbing_exercises_the_pipeline_without_a_model(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """``run --arm bare --probe-plumbing`` must reach result.json with $0 spend,
    and the row must be fail-closed so it can never be reported."""
    import factory.runner as runner_mod

    def _explode(**_kw: Any) -> str:
        raise AssertionError("a plumbing probe must never call the model")

    monkeypatch.setattr(runner_mod, "text_run", _explode)
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_instance", lambda _id: dict(_INST))
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "deadbeef"})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda _insts: None)
    monkeypatch.setattr(A, "_ensure_image", lambda _inst, timeout_s=1800: True)
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda _inst, _repo: None)
    monkeypatch.setattr(
        A,
        "_precheck_collect",
        lambda _inst, _repo: {"collect_ok": True, "tail": "", "mode": "existing-targets"},
    )
    monkeypatch.setattr(A, "instance_test_command", lambda *a, **k: "echo ok")
    monkeypatch.setattr(A, "_clone", _clone_stub)

    A.run_bare(_INST["instance_id"], max_steps=10, timeout_s=600, probe=True)

    run_dir = (tmp_path / "runs") / str(_INST["instance_id"]) / "bare"
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert result["probe_plumbing"] is True
    assert result["error"] == A._PROBE_ERROR, "a probe row must be fail-closed"
    assert result["cost_usd"] == 0.0
    # Every stage really ran: parse (marker AND fence), execute, nudge, capture.
    assert result["done_nudges"] == 1
    assert result["diff_bytes"] > 0
    assert result["files_changed"] == [A._PROBE_FILE]
    assert (run_dir / "prediction.diff").read_text(encoding="utf-8").strip()
    assert (run_dir / "bare-commands.ndjson").exists()


def test_probe_plumbing_is_refused_only_for_the_factory_arm(A: Any) -> None:  # noqa: N803
    """Every arm but `factory` has a FREE plumbing probe as of 2026-08-03 — the
    claude arms' cheapest check used to be a one-turn CLI call, i.e. a real
    subscription call, which is no way to verify a run-dir key change.

    Selected off the arm's registry BASE, so a model-suffixed variant of a
    probe-capable arm is probe-capable too.
    """
    src = _ADAPTER.read_text(encoding="utf-8")
    assert "--probe-plumbing" in src
    main_src = src[src.index("def main()") :]
    assert 'base not in ("bare", "openhands", "claude", "sssf")' in main_src
    assert "pm-sync --dry-run" in main_src, "factory's free surface must be named"


# --------------------------------------------------------------------------- #
# the runnable test command (the salvage the bare arm never had)
# --------------------------------------------------------------------------- #


def test_a_missing_test_target_falls_back_to_its_nearest_ancestor(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``repo`` was accepted and ignored, so 3 of 19 pinned instances handed
    EVERY arm a command containing a path that does not exist at base_commit
    (hkuds-217, vyper-4801, line-981) — pytest exits 4 and the arm's only
    verification channel is dead before it starts."""
    (tmp_path / "tests").mkdir()
    inst = {**_INST, "selected_test_files_to_run": ["tests/test_not_created_yet.py"]}
    without = A.instance_test_command(inst)
    with_repo = A.instance_test_command(inst, repo=tmp_path)
    assert "tests/test_not_created_yet.py" in without
    assert "tests/test_not_created_yet.py" not in with_repo
    assert "tests" in with_repo


def test_an_existing_test_target_is_left_alone(A: Any, tmp_path: Path) -> None:  # noqa: N803
    _seed_repo(tmp_path / "r")
    inst = {**_INST, "selected_test_files_to_run": ["tests/test_widget.py"]}
    assert "tests/test_widget.py" in A.instance_test_command(
        inst, repo=tmp_path / "r"
    )


def test_the_bare_arm_runs_the_collect_precheck(A: Any) -> None:  # noqa: N803
    """The factory and claude arms refuse before spend when the environment
    cannot collect; bare had no gate at all and would burn its whole budget."""
    src = ast.parse(_ADAPTER.read_text(encoding="utf-8"))
    for fname in ("run_factory", "run_bare", "run_claude", "run_openhands"):
        fn = next(
            n for n in src.body if isinstance(n, ast.FunctionDef) and n.name == fname
        )
        assert any(
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == "_precheck_collect"
            for n in ast.walk(fn)
        ), f"{fname} does not run the collect precheck"


# --------------------------------------------------------------------------- #
# per-row model recording — "matched weights" was false and invisible
# --------------------------------------------------------------------------- #


def test_model_mix_counts_calls_per_persona_and_tier(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """Measured in this repo's own run dirs: the factory arm escalated 7 dev
    calls to azure/gpt-5.3-codex (hard tier) across 5 instances, and 4 of its 11
    resolves used that tier. ``result.json["model"]`` was absent on every
    factory row, so nothing in the artifact said so."""
    events = tmp_path / "state" / "events"
    events.mkdir(parents=True)
    rows = [
        {"event": "run", "persona": "dev", "model": "azure/deepseek-v4-pro",
         "model_tier": "standard", "cost_usd": 0.5},
        {"event": "run", "persona": "dev", "model": "azure/gpt-5.3-codex",
         "model_tier": "hard", "cost_usd": 1.25},
        {"event": "run", "persona": "dev", "model": "azure/gpt-5.3-codex",
         "model_tier": "hard", "cost_usd": 0.75},
        {"event": "run", "persona": "reviewer", "model": "azure/gpt-5.4",
         "model_tier": None, "cost_usd": 0.25},
        {"event": "something_else", "persona": "dev", "model": "ignored"},
        "{not json",
    ]
    (events / "runs.ndjson").write_text(
        "\n".join(r if isinstance(r, str) else json.dumps(r) for r in rows) + "\n",
        encoding="utf-8",
    )
    mix = A._model_mix(events, nominal="azure/deepseek-v4-pro")
    assert mix["models_used"] == [
        "azure/deepseek-v4-pro",
        "azure/gpt-5.3-codex",
        "azure/gpt-5.4",
    ]
    assert mix["model_escalated_calls"] == 3  # 2 hard dev + 1 reviewer
    hard = next(
        r for r in mix["model_calls"] if r["model"] == "azure/gpt-5.3-codex"
    )
    assert hard == {
        "persona": "dev",
        "model": "azure/gpt-5.3-codex",
        "model_tier": "hard",
        "calls": 2,
        "cost_usd": 2.0,
    }


def test_model_mix_of_a_missing_ledger_is_empty_not_a_crash(A: Any, tmp_path: Path) -> None:  # noqa: N803
    assert A._model_mix(tmp_path / "nope", nominal="m") == A._no_model_mix()


@pytest.mark.parametrize(
    "fname", ["run_factory", "run_bare", "run_claude", "run_openhands"]
)
def test_every_arm_records_which_weights_ran(A: Any, fname: str) -> None:  # noqa: N803
    """Contract: every run function's result payload carries a non-None
    ``model`` plus the measured mix. ``result.json["model"]`` was None on 25 of
    25 factory rows, which is how a hard-tier escalation stayed invisible."""
    import inspect

    src = inspect.getsource(getattr(A, fname))
    assert '"model"' in src, f"{fname} records no model"
    # The three ledger-backed arms read the mix from their own
    # ``state/events/runs.ndjson``; the claude arm's ledger IS the CLI
    # transcript, so it fills the same three keys from ``modelUsage``.
    if "_model_mix(" not in src:
        for key in A._MODEL_MIX_KEYS:
            assert f'"{key}"' in src, f"{fname} records no {key}"


def test_the_bare_row_reports_a_real_model_id(bare_run: Any) -> None:
    _model, result, _run_dir = bare_run([_WRITE_FIX_FENCED, "DONE"])
    assert result["model"], "the bare row must name the deployment it ran"
    assert result["model"].startswith(("azure/", "azure_ai/", "deepseek/"))
    assert result["models_used"] == []  # no ledger rows: the stub writes none
    assert result["model_escalated_calls"] == 0


def test_the_bare_row_reports_the_weights_its_own_ledger_recorded(
    bare_run: Any, A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The mix must come from THIS run's ledger — nothing above proves that.

    ``models_used == []`` passes just as happily when ``run_bare`` hands
    ``_model_mix`` the wrong directory, which is the ``proxy != real`` shape
    that hid the factory's hard-tier escalation in the first place. So have the
    scripted model write the ledger row a real ``text_run`` would write, on a
    DIFFERENT model than the nominal route, and require the row to notice.
    """
    events = tmp_path / "runs" / str(_INST["instance_id"]) / "bare" / "state" / "events"

    class _LedgerWritingModel(_ScriptedModel):
        def __call__(self, **kwargs: Any) -> str:
            events.mkdir(parents=True, exist_ok=True)
            model = "azure/deepseek-v4-pro" if self.calls == 0 else "azure/gpt-5.3-codex"
            with (events / "runs.ndjson").open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "event": "run",
                            "persona": "dev",
                            "model": model,
                            "model_tier": "standard" if self.calls == 0 else "hard",
                            "cost_usd": 0.02,
                        }
                    )
                    + "\n"
                )
            return super().__call__(**kwargs)

    _m, result, _rd = bare_run(
        [], model=_LedgerWritingModel([_WRITE_FIX_FENCED, "DONE"])
    )

    assert result["models_used"] == ["azure/deepseek-v4-pro", "azure/gpt-5.3-codex"]
    assert result["model_escalated_calls"] == 1, (
        "a call on weights other than the nominal route must be counted"
    )
    tiers = {c["model_tier"] for c in result["model_calls"]}
    assert tiers == {"standard", "hard"}, "the mix must be per-tier, not per-arm"
    assert all(c["persona"] == "dev" for c in result["model_calls"])


# --------------------------------------------------------------------------- #
# the openhands reference arm
# --------------------------------------------------------------------------- #


def test_openhands_is_registered_everywhere_an_arm_must_be(A: Any) -> None:  # noqa: N803
    assert "openhands" in A._ARM_NAMES
    assert A._resolve_max_steps("openhands", None) == A._OPENHANDS_ITERATION_CAP
    assert A._resolve_max_steps("openhands", 7) == 7
    assert "openhands" in A._DEFAULT_COST_USD
    assert "openhands" in A._DEFAULT_HOURS
    assert "openhands" in A._ARM_TRAJECTORY_EXPECTATION
    import inspect

    main_src = inspect.getsource(A.main)
    assert '"openhands": run_openhands' in main_src
    # run/grade/audit/run-all all take --arm from the one registry.
    assert main_src.count("choices=list(_ARM_NAMES)") >= 3


def test_openhands_gets_the_identical_story_template(A: Any) -> None:  # noqa: N803
    """The whole point: the only difference from the factory arm is THE CHAIN.
    A privileged prompt would make the comparison meaningless."""
    import inspect

    src = inspect.getsource(A.run_openhands)
    assert "_STORY_TEMPLATE.format(" in src
    assert "instance_test_command(inst, repo=repo)" in src
    # No arm-specific extras (the claude arm's _CLAUDE_RULES has no analogue).
    assert "_CLAUDE_RULES" not in src
    assert "_BARE_SYSTEM" not in src


def test_openhands_runs_the_factory_dev_route_and_iteration_budget(A: Any) -> None:  # noqa: N803
    import inspect

    src = inspect.getsource(A.run_openhands)
    assert 'route("dev", "standard")' in src
    # The budget comes from the ONE arm registry, which _resolve_max_steps reads.
    assert A._ARMS["openhands"].max_steps == A._OPENHANDS_ITERATION_CAP
    assert A._resolve_max_steps("openhands", None) == A._OPENHANDS_ITERATION_CAP
    # The factory dev's own per-attempt cap is sandbox_run's signature default.
    runner_src = _RUNNER.read_text(encoding="utf-8")
    tree = ast.parse(runner_src)
    fn = next(
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.AsyncFunctionDef) and n.name == "sandbox_run"
    )
    idx = fn.args.kwonlyargs.index(
        next(a for a in fn.args.kwonlyargs if a.arg == "max_iterations")
    )
    default = fn.args.kw_defaults[idx]
    assert isinstance(default, ast.Constant)
    assert default.value == A._OPENHANDS_ITERATION_CAP, (
        "the openhands arm's iteration cap must track the factory dev's own "
        "per-attempt cap, or the arms differ on budget as well as on the chain"
    )
    assert "dev" not in _dev_iteration_overrides(runner_src), (
        "dev gained a PERSONA_ITERATION_CAPS override; the arm's cap must follow"
    )


def _dev_iteration_overrides(runner_src: str) -> str:
    start = runner_src.index("PERSONA_ITERATION_CAPS: dict[str, int] = {")
    return runner_src[start : runner_src.index("}", start)]


def test_openhands_reads_the_same_azure_env_vars_as_the_chain(A: Any) -> None:  # noqa: N803
    """``_azure_llm_env`` deliberately mirrors ``factory.runner`` instead of
    importing a private helper that does not exist. Pin the variable names so
    the two cannot drift silently — a wrong base_url is a 100% failure rate that
    reads as model incompetence."""
    import inspect

    mine = inspect.getsource(A._azure_llm_env)
    runner_src = _RUNNER.read_text(encoding="utf-8")
    for var in (
        "AZURE_AI_API_BASE",
        "AZURE_AI_API_VERSION",
        "AZURE_API_BASE",
        "AZURE_API_VERSION",
        "AZURE_ENDPOINT",
        "AZURE_FOUNDRY_ENDPOINT",
        "AZURE_FOUNDRY_API_VERSION",
    ):
        assert var in mine, f"{var} missing from the bench arm's resolution"
        assert var in runner_src, f"{var} no longer used by the chain"


def test_openhands_uses_the_runner_own_agent_and_key_helpers(A: Any) -> None:  # noqa: N803
    import inspect

    src = inspect.getsource(A._build_openhands_agent)
    for name in ("_build_agent_for_persona", "_persona_llm_overrides", "_resolve_api_key"):
        assert name in src, f"{name} must come from factory.runner, not a copy"
    assert "get_default_agent" in src
    assert "LocalWorkspace" in src


def test_openhands_writes_a_ledger_row_and_reads_it_back(A: Any) -> None:  # noqa: N803
    """The audit certifies result.json against the ledger's own sums, so the
    reported numbers must BE the ledger's — not a parallel in-memory tally."""
    import inspect

    src = inspect.getsource(A.run_openhands)
    assert "_record_run(" in src
    assert "_read_ledger_totals(db_path)" in src
    assert 'ledger["cost_usd"]' in src


def test_read_ledger_totals_of_a_missing_db_is_zero(A: Any, tmp_path: Path) -> None:  # noqa: N803
    assert A._read_ledger_totals(tmp_path / "nope.db")["persona_calls"] == 0


def test_openhands_persists_the_sdk_trajectory(A: Any) -> None:  # noqa: N803
    """"Persist whatever OpenHands' own event stream gives you rather than
    inventing a format" — so the arm reuses the chain's own capture helper,
    which is also what the audit's oracle-probe scan reads."""
    import inspect

    src = inspect.getsource(A.run_openhands)
    assert "_capture_trajectory(" in src
    assert "persistence_dir" in src
    assert "conversation_id" in src


def test_openhands_bounds_the_agent_by_the_shared_wall_clock(A: Any) -> None:  # noqa: N803
    import inspect

    src = inspect.getsource(A.run_openhands)
    assert "daemon=True" in src, (
        "a non-daemon worker would hold the interpreter open past the cap"
    )
    assert "worker.join(timeout=float(timeout_s))" in src
    assert "wall-clock-cap" in src


def test_openhands_probe_plumbing_runs_the_whole_arm_without_a_model(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """EXECUTE the openhands arm's free path, don't just read its source.

    Every other openhands test above inspects source text, which cannot catch a
    NameError, a bad keyword or a crash on a path only the probe takes — and the
    probe is precisely what the operator runs before committing to a paid sweep.
    So drive the real function: clone, prompt assembly, prompt telemetry, agent
    construction, diff capture, ``split_diff``, ``assert_no_test_edits``,
    ledger read-back, ``result.json``, summary. Only the provider is absent.

    ``_build_openhands_agent`` is the ONE thing stubbed, because it needs a real
    API key (a real ``--probe-plumbing`` invocation does build it for real — that
    is the point of the flag). Its own contract is pinned separately by
    ``test_openhands_uses_the_runner_own_agent_and_key_helpers``.
    """
    built: list[str] = []

    def _fake_agent(model: str, repo: Path) -> tuple[Any, Any]:
        built.append(model)
        assert (repo / "widget.py").exists(), "the agent must be built on the clone"
        return object(), object()

    class _NoThreads:
        """Stands in for the ``threading`` module the arm reaches for. A shim
        rather than ``setattr(threading, "Thread", …)``: patching the real
        module would make any UNRELATED thread pytest spawns during this test
        blow up."""

        @staticmethod
        def Thread(*_a: Any, **_kw: Any) -> Any:  # noqa: N802
            raise AssertionError("a plumbing probe must never open a conversation")

    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "_instance", lambda _id: dict(_INST))
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "deadbeef"})
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda _insts: None)
    monkeypatch.setattr(A, "_ensure_image", lambda _inst, timeout_s=1800: True)
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda _inst, _repo: None)
    monkeypatch.setattr(
        A,
        "_precheck_collect",
        lambda _inst, _repo: {"collect_ok": True, "tail": "", "mode": "existing-targets"},
    )
    monkeypatch.setattr(A, "instance_test_command", lambda *a, **k: "echo ok")
    monkeypatch.setattr(A, "_clone", _clone_stub)
    monkeypatch.setattr(A, "_build_openhands_agent", _fake_agent)
    monkeypatch.setattr(A, "threading", _NoThreads)

    A.run_openhands(_INST["instance_id"], max_steps=5, timeout_s=600, probe=True)

    run_dir = (tmp_path / "runs") / str(_INST["instance_id"]) / "openhands"
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert built and built[0].startswith(("azure/", "azure_ai/", "deepseek/"))
    assert result["arm"] == "openhands"
    assert result["model"] == built[0]
    assert result["probe_plumbing"] is True
    assert result["termination"] == "plumbing-probe"
    assert result["error"] == A._PROBE_ERROR, "a probe row must be fail-closed"
    assert result["cost_usd"] == 0.0
    assert result["persona_calls"] == 0
    # The prediction path really ran over a real tree.
    assert result["files_changed"] == [A._PROBE_FILE]
    assert result["diff_bytes"] > 0
    assert (run_dir / "prediction.diff").read_text(encoding="utf-8").strip()
    assert (run_dir / "raw.diff").exists()
    # And the mix keys are present-but-empty rather than missing.
    for key in A._MODEL_MIX_KEYS:
        assert key in result


def test_openhands_probe_reuses_the_shared_prediction_helpers(A: Any) -> None:  # noqa: N803
    """``split_diff``/``assert_no_test_edits`` are called, not reimplemented —
    an arm with its own stripping rule could ship a test edit past the grader."""
    import inspect

    src = inspect.getsource(A.run_openhands)
    assert "split_diff(raw_diff)" in src
    assert "assert_no_test_edits(code_diff)" in src


# --------------------------------------------------------------------------- #
# the audit must not cry wolf on the arm whose trail is a command log
# --------------------------------------------------------------------------- #


def test_trajectory_coverage_is_scoped_by_arm_not_by_a_stray_file(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """A warning printed on every single bare row trains the reader to ignore
    warnings. The bare arm's dev calls are single completions — there is no
    OpenHands trajectory to capture, and its full trail is the command log
    (whose ABSENCE beside executed commands is already a hard failure).

    But the exemption must be keyed on the ARM, not on "is a command log
    present": inferring an arm's identity from a file on disk is `proxy != real`
    — a FACTORY run that lost its trajectories would be waved through by a
    stray `bare-commands.ndjson` in its state root.
    """
    calls = {"dev": 3}
    root = tmp_path / "state-root"
    (root / "state" / "events" / "trajectories").mkdir(parents=True)

    # bare: no trajectory is expected, and its own trail IS present -> silent.
    (root / "bare-commands.ndjson").write_text("{}\n", encoding="utf-8")
    assert A._trajectory_coverage_warnings(root, "bare", calls) == []
    # …and if the bare arm's one trail is missing, say so.
    (root / "bare-commands.ndjson").unlink()
    bare_warn = A._trajectory_coverage_warnings(root, "bare", calls)
    assert len(bare_warn) == 1
    assert "bare-commands.ndjson" in bare_warn[0]

    # factory: one trajectory per dev call. A stray command log must NOT excuse
    # missing trajectories — this is the hole in the file-presence version.
    (root / "bare-commands.ndjson").write_text("{}\n", encoding="utf-8")
    assert len(A._trajectory_coverage_warnings(root, "factory", calls)) == 1
    for i in range(3):
        (root / "state" / "events" / "trajectories" / f"1-{i}.ndjson").touch()
    assert A._trajectory_coverage_warnings(root, "factory", calls) == []

    # openhands: ONE conversation for the whole run, so one trajectory is
    # enough however many ledger rows there are.
    single = tmp_path / "oh-root"
    (single / "state" / "events" / "trajectories").mkdir(parents=True)
    assert len(A._trajectory_coverage_warnings(single, "openhands", {"dev": 1})) == 1
    (single / "state" / "events" / "trajectories" / "nostory-1.ndjson").touch()
    assert A._trajectory_coverage_warnings(single, "openhands", {"dev": 1}) == []
    assert A._trajectory_coverage_warnings(single, "openhands", {"dev": 9}) == []

    # an UNKNOWN arm gets the strictest rule, never a free pass.
    assert len(A._trajectory_coverage_warnings(single, "brand-new-arm", {"dev": 4})) == 1

    # a run that made no dev calls has nothing to be missing.
    assert A._trajectory_coverage_warnings(root, "factory", {}) == []


# --------------------------------------------------------------------------- #
# read-only test files (ImpossibleBench, arXiv 2510.20270)
# --------------------------------------------------------------------------- #
#
# The measured claim: making test files read-only "significantly reduces
# cheating while maintaining performance" — hiding them entirely killed cheating
# but degraded legitimate work, so read-only is the setting worth having. The arm
# keeps its red/green loop (it can read and RUN the tests) and loses the ability
# to quietly rewrite what judges it.
#
# These drive the REAL loop over a REAL git tree with a scripted model, so the OS
# itself decides whether the write is refused. They cost $0.


def test_lock_makes_tracked_test_files_read_only_and_leaves_code_writable(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    repo = tmp_path / "repo"
    _seed_repo(repo)
    lock = A.lock_test_files(repo)

    assert lock["files"] == 1
    assert set(lock["digests"]) == {"tests/test_widget.py"}
    assert lock["errors"] == []
    assert (repo / "tests" / "test_widget.py").stat().st_mode & 0o222 == 0
    # Production code stays writable: the countermeasure is about the oracle,
    # not about freezing the tree.
    assert (repo / "widget.py").stat().st_mode & 0o200


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file modes")
def test_the_lock_is_enforced_by_the_os_not_just_recorded(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    repo = tmp_path / "repo"
    _seed_repo(repo)
    A.lock_test_files(repo)
    with pytest.raises(PermissionError):
        (repo / "tests" / "test_widget.py").write_text("def test_widget(): pass\n")


def test_verify_reports_a_bypass_when_the_lock_is_defeated(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Every arm owns these files and has a shell, so ``chmod u+w`` defeats the
    lock. That is why the report separates what the lock PREVENTED from what it
    only recorded — a non-zero ``bypassed_count`` is the signal that the lock
    needs real enforcement before anyone claims tests were unwritable."""
    repo = tmp_path / "repo"
    _seed_repo(repo)
    lock = A.lock_test_files(repo)
    target = repo / "tests" / "test_widget.py"
    target.chmod(0o644)
    target.write_text("def test_widget():\n    assert True\n", encoding="utf-8")

    report = A.verify_test_files_locked(repo, lock["digests"])
    assert report["bypassed"] == ["tests/test_widget.py"]
    assert report["bypassed_count"] == 1


def test_refusal_count_needs_both_an_os_refusal_and_a_locked_path(A: Any) -> None:  # noqa: N803
    locked = ["tests/test_widget.py"]
    both = "sed: couldn't open temporary file tests/test_widget.py: Permission denied"
    assert A.count_refused_test_writes(both, locked)["refused"] == 1
    # basename-only quoting still counts…
    assert (
        A.count_refused_test_writes("cannot write test_widget.py: EACCES", locked)[
            "refused"
        ]
        == 1
    )
    # …but neither half alone does.
    assert A.count_refused_test_writes("pip: Permission denied", locked)["refused"] == 0
    assert (
        A.count_refused_test_writes("ran tests/test_widget.py: 1 passed", locked)[
            "refused"
        ]
        == 0
    )


def test_a_git_failure_is_reported_not_swallowed(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """A silent ``[]`` from ``git ls-files`` would report ``files: 0,
    bypassed: 0`` — indistinguishable from a clean run while protecting nothing.
    That is the "countermeasure that silently stops applying" class."""
    not_a_repo = tmp_path / "plain"
    (not_a_repo / "tests").mkdir(parents=True)
    (not_a_repo / "tests" / "test_a.py").write_text("def test_a(): pass\n")

    lock = A.lock_test_files(not_a_repo)
    assert lock["files"] == 0
    assert lock["git_ok"] is False
    assert lock["errors"], lock
    report = A.readonly_test_report(not_a_repo, lock)
    assert report["git_ok"] is False
    assert report["lock_errors"]


def test_a_lapsed_lock_is_reported_even_when_the_content_is_restored(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """MEASURED: ``git apply`` / ``git checkout --`` onto a 0444 tracked file
    succeeds and leaves it at 0664, and an arm that edits a test then reverts it
    ends byte-identical. Both look clean under ``bypassed_count`` alone, so the
    lapse has to be reported next to it."""
    repo = tmp_path / "repo"
    _seed_repo(repo)
    lock = A.lock_test_files(repo)
    target = repo / "tests" / "test_widget.py"
    original = target.read_text(encoding="utf-8")
    target.chmod(0o644)
    target.write_text("def test_widget():\n    assert True\n", encoding="utf-8")
    target.write_text(original, encoding="utf-8")  # revert

    report = A.readonly_test_report(repo, lock)
    assert report["bypassed_count"] == 0
    assert report["unlocked_mode"] == ["tests/test_widget.py"]
    assert report["lock_lapsed_count"] == 1


def test_report_says_none_when_no_output_was_scanned(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """"We did not look" and "we looked and found none" are different claims;
    only one of them is evidence."""
    repo = tmp_path / "repo"
    _seed_repo(repo)
    lock = A.lock_test_files(repo)
    assert A.readonly_test_report(repo, lock)["refused"] is None
    assert A.readonly_test_report(repo, lock, output_paths=[])["refused"] is None


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file modes")
def test_bare_arm_records_a_refused_test_write_end_to_end(
    bare_run: Any, A: Any  # noqa: N803
) -> None:
    """The whole mechanism through the real loop: the arm tries to overwrite the
    test file, the OS refuses, the refusal is counted in result.json, and the
    file's content is unchanged."""
    attempt = (
        "Make the test agree with me:\n\n```bash\n"
        "printf 'def test_widget():\\n    assert True\\n' > tests/test_widget.py\n"
        "```"
    )
    _model, result, _run_dir = bare_run([attempt, "DONE"])

    ro = result["test_readonly"]
    assert ro["files"] == 1
    assert ro["mode"] == "0444"
    assert ro["refused"] >= 1, ro
    assert ro["refused_samples"], ro
    assert ro["bypassed_count"] == 0, ro
    # The diff carries no test edit either — the two mechanisms agree.
    assert result["test_files_stripped"] == []
    assert "tests/test_widget.py" not in (result["files_changed"] or [])


def test_the_factory_arms_worktree_lock_seam_still_exists() -> None:
    """``run_factory`` locks the dev's per-story worktree by wrapping
    ``handlers.ensure_worktree_for_story``: ``git worktree add`` materialises
    fresh files, so locking the source clone cannot reach the tree dev works in.
    If that name moves, the run fails loudly by design — this makes it fail at
    CI time instead of mid-sweep."""
    from factory.chain import handlers

    assert callable(handlers.ensure_worktree_for_story)
