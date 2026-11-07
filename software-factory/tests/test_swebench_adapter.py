"""The SWE-bench adapter's oracle must stay hidden and its sample must be pinned.

The whole point of this adapter is an EXTERNAL grader. Two things can quietly
destroy that, and both are cheap to get wrong:

* The factory's dev owns its tests (the Loop-4 design), so a diff containing
  test edits would let the arm under test rewrite the oracle judging it. This
  is the single most common way SWE-bench numbers get inflated.
* A sample chosen after seeing results is not a sample.

These tests cover the pure logic. The docker grading path is exercised
end-to-end by an actual run, not mocked here — a mocked oracle proves nothing.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_ADAPTER = Path(__file__).parent.parent / "bench" / "swebench_adapter.py"


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_under_test", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


@pytest.fixture(autouse=True)
def _isolate_bench_store_paths(
    request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No test may ever touch the REPO's pinned bench artifacts.

    The first live sweep produced ZERO audited-valid rows because a unit
    test invoked ``fetch`` with only ``MANIFEST_PATH`` patched — the fetch
    then wrote its one fixture record over the real committed
    ``bench/swebench/oracle.json.z``, and every live grade refused with
    "oracle store has no record" AFTER $24.78 of model spend. Exactly the
    test-pollution class this repo has been bitten by before (the FMS
    sm-truncation noise). Every store/manifest read+write path is
    parameterized via these module globals; this autouse fixture points them
    at tmp_path for EVERY test, so forgetting a patch in one test can never
    reach the repo again. Tests that need specific paths still set their own
    (their setattr simply overrides this one).
    """
    if "A" not in request.fixturenames:
        return  # test doesn't touch the adapter at all
    a = request.getfixturevalue("A")
    monkeypatch.setattr(a, "MANIFEST_PATH", tmp_path / "isolated-manifest.json")
    monkeypatch.setattr(a, "ORACLE_PATH", tmp_path / "isolated-oracle.json.z")
    monkeypatch.setattr(a, "SELFTEST_LOG_DIR", tmp_path / "isolated-selftest-logs")
    # Live working trees now live OUTSIDE the repo, so without this a test that
    # drives an arm would clone into the operator's real ~/.cache. Same
    # test-pollution class as the clobbered oracle store above.
    monkeypatch.setenv("SWEBENCH_WORK_ROOT", str(tmp_path / "isolated-work"))


# --------------------------------------------------------------------------- #
# test-path detection
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_foo.py",
        "test/database.js",
        "src/tests/helpers.py",
        "pkg/foo_test.go",
        "app/test_thing.py",
        "conftest.py",
        "src/conftest.py",
        "web/component.spec.tsx",
        "testing/fixtures.py",
    ],
)
def test_test_paths_are_recognised(A: Any, path: str) -> None:  # noqa: N803
    assert A.is_test_path(path), path


@pytest.mark.parametrize(
    "path",
    [
        "src/main.py",
        "lib/latest.py",           # contains "test" as a substring only
        "app/contest/views.py",    # "contest", not "test"
        "src/protester.go",
        "docs/testing.md" ,        # NOTE: under a testing/ dir this WOULD match
    ],
)
def test_production_paths_are_not_flagged(A: Any, path: str) -> None:  # noqa: N803
    if path == "docs/testing.md":
        pytest.skip("documented boundary: a testing/ DIRECTORY does match")
    assert not A.is_test_path(path), path


# --------------------------------------------------------------------------- #
# diff splitting
# --------------------------------------------------------------------------- #

_DIFF = """diff --git a/src/app.py b/src/app.py
index 111..222 100644
--- a/src/app.py
+++ b/src/app.py
@@ -1,2 +1,3 @@
 x = 1
+y = 2
diff --git a/tests/test_app.py b/tests/test_app.py
index 333..444 100644
--- a/tests/test_app.py
+++ b/tests/test_app.py
@@ -1,2 +1,2 @@
-assert app.y == 2
+assert True
diff --git a/src/other.py b/src/other.py
index 555..666 100644
--- a/src/other.py
+++ b/src/other.py
@@ -1 +1,2 @@
 z = 3
+w = 4
"""


def test_split_keeps_code_and_strips_tests(A: Any) -> None:  # noqa: N803
    code, kept, stripped = A.split_diff(_DIFF)
    assert kept == ["src/app.py", "src/other.py"]
    assert stripped == ["tests/test_app.py"]
    assert "y = 2" in code and "w = 4" in code
    # The neutering test edit is gone entirely, not merely unreferenced.
    assert "assert True" not in code
    assert "tests/test_app.py" not in code


def test_split_of_an_empty_diff_is_empty(A: Any) -> None:  # noqa: N803
    assert A.split_diff("") == ("", [], [])
    assert A.split_diff("   \n") == ("", [], [])


def test_split_output_is_a_valid_standalone_diff(A: Any) -> None:  # noqa: N803
    """Each kept file keeps its own header and hunks, in order."""
    code, _, _ = A.split_diff(_DIFF)
    headers = [ln for ln in code.splitlines() if ln.startswith("diff --git")]
    assert headers == [
        "diff --git a/src/app.py b/src/app.py",
        "diff --git a/src/other.py b/src/other.py",
    ]


# --------------------------------------------------------------------------- #
# the assertion that protects the oracle
# --------------------------------------------------------------------------- #


def test_assert_rejects_a_diff_that_touches_tests(A: Any) -> None:  # noqa: N803
    with pytest.raises(AssertionError, match="tests/test_app.py"):
        A.assert_no_test_edits(_DIFF)


def test_assert_accepts_the_stripped_diff(A: Any) -> None:  # noqa: N803
    code, _, _ = A.split_diff(_DIFF)
    A.assert_no_test_edits(code)  # must not raise


def test_assert_accepts_an_empty_diff(A: Any) -> None:  # noqa: N803
    A.assert_no_test_edits("")


def test_strip_then_assert_is_idempotent(A: Any) -> None:  # noqa: N803
    """Re-stripping an already-clean diff must not change it — `grade` re-runs
    the assertion at grading time as a second line of defence."""
    code, _, _ = A.split_diff(_DIFF)
    again, kept, stripped = A.split_diff(code)
    assert again == code
    assert stripped == []
    assert kept == ["src/app.py", "src/other.py"]


# --------------------------------------------------------------------------- #
# dataset field coercion
# --------------------------------------------------------------------------- #


def test_fail_to_pass_json_string_is_parsed(A: Any) -> None:  # noqa: N803
    """The dataset ships these as JSON-encoded STRINGS, not lists. Treating the
    string as a single test name would silently grade against one nonexistent
    test and call everything unresolved."""
    assert A._as_list('["a::test_one", "b::test_two"]') == ["a::test_one", "b::test_two"]
    assert A._as_list(["x", "y"]) == ["x", "y"]
    assert A._as_list("") == []
    assert A._as_list(None) == []
    # Not valid JSON: treat as a single opaque name rather than dropping it.
    assert A._as_list("plain::name") == ["plain::name"]


def test_nested_python_repr_list_is_flattened(A: Any) -> None:  # noqa: N803
    """The shape that actually broke grading, from a real instance.

    ``ansible__ansible-9a21e2477...`` encodes ``fail_to_pass`` as a JSON array
    holding ONE element, which is itself a Python repr of the real list —
    single-quoted, so not valid JSON. Parsed naively, pytest receives all six
    ids as a single argument, collects 0 items, and the instance grades as
    unresolved no matter what the arm produced. Left unfixed this yields a 0%
    resolve rate across the board that reads as factory incompetence.
    """
    real = (
        '["[\'test/units/module_utils/common/test_sys_info.py'
        '::test_get_distribution_not_linux[FreeBSD-Freebsd]\', '
        '\'test/units/module_utils/common/test_sys_info.py'
        '::test_get_distribution_version_not_linux[FreeBSD-12.1]\']"]'
    )
    got = A._as_list(real)
    assert len(got) == 2, got
    assert got[0].endswith("::test_get_distribution_not_linux[FreeBSD-Freebsd]")
    assert got[1].endswith("::test_get_distribution_version_not_linux[FreeBSD-12.1]")
    # Nothing retains the wrapping brackets — those are what pytest choked on.
    assert not any(t.startswith("[") for t in got)


def test_flattening_is_idempotent_and_bounded(A: Any) -> None:  # noqa: N803
    flat = ["a::t1", "b::t2"]
    assert A._as_list(flat) == flat
    assert A._as_list(A._as_list(flat)) == flat
    # A test id containing brackets (pytest params) must survive intact.
    assert A._as_list('["x.py::test[a-b]"]') == ["x.py::test[a-b]"]


# --------------------------------------------------------------------------- #
# manifest pinning
# --------------------------------------------------------------------------- #


def test_run_without_a_manifest_refuses(A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "nope.json")
    with pytest.raises(SystemExit, match="Run `fetch` first"):
        A._manifest()


def test_instance_must_be_in_the_manifest(A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """Grading an instance that was never pinned would be picking the sample
    after seeing the results."""
    m = tmp_path / "manifest.json"
    m.write_text(
        json.dumps({"manifest_sha256": "abc", "instances": [{"instance_id": "known"}]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", m)
    assert A._instance("known")["instance_id"] == "known"
    with pytest.raises(SystemExit, match="not in the pinned manifest"):
        A._instance("unknown")


def test_manifest_path_defaults_to_the_shared_manifest_when_unset(
    A: Any, monkeypatch: pytest.MonkeyPatch
) -> None:  # noqa: N803
    """No env var, no behaviour change — every existing caller of `_manifest()`
    is unaffected by the alt-dir mechanism existing at all."""
    monkeypatch.delenv("SWEBENCH_MANIFEST_DIR", raising=False)
    assert A._manifest_path() == A.MANIFEST_PATH
    assert A._oracle_path() == A.ORACLE_PATH


def test_manifest_path_honors_the_alt_manifest_dir_for_a_fresh_experiment(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:  # noqa: N803
    """An experiment needing its OWN pinned instance set (e.g. the planner
    ablation) sets ONE env var rather than editing the shared manifest.json —
    which `fetch` overwrites wholesale and which several frozen documents cite
    by exact sha. Reading must come from the alt dir, never the shared one."""
    alt = tmp_path / "alt-experiment"
    alt.mkdir()
    (alt / "manifest.json").write_text(
        json.dumps({"manifest_sha256": "altsha", "instances": [{"instance_id": "alt-only"}]}),
        encoding="utf-8",
    )
    monkeypatch.setenv("SWEBENCH_MANIFEST_DIR", str(alt))
    assert A._manifest_path() == alt / "manifest.json"
    assert A._oracle_path() == alt / "oracle.json.z"
    assert A._instance("alt-only")["instance_id"] == "alt-only"
    with pytest.raises(SystemExit, match="not in the pinned manifest"):
        A._instance("known")  # the real manifest's fixture id from the test above


def test_shell_quoting_survives_test_names_with_quotes(A: Any) -> None:  # noqa: N803
    """Real fail_to_pass entries contain apostrophes (e.g. "should return ...
    and null if key doesn't exist"), which would break the grade script."""
    quoted = A._shq("test.js | Key methods doesn't explode")
    assert quoted.startswith("'") and quoted.endswith("'")
    # The embedded apostrophe is escaped, not left to terminate the string.
    assert "doesn'\\''t" in quoted


# --------------------------------------------------------------------------- #
# the factory arm's test environment
# --------------------------------------------------------------------------- #


_INST = {
    "instance_id": "instance_x__y-abc",
    "dockerhub_tag": "x.y-abc",
    "selected_test_files_to_run": (
        '["test/units/test_sys_info.py::test_get_distribution[SunOS-Solaris]", '
        '"test/units/test_sys_info.py::test_get_distribution[Darwin-Darwin]", '
        '"test/units/test_other.py::test_thing"]'
    ),
}


def test_test_command_runs_inside_the_instance_image(A: Any) -> None:  # noqa: N803
    """A bare clone has no dependencies: plain pytest dies with
    ModuleNotFoundError and dev — whose mechanism is run-until-green — blocks
    with an empty diff. The image has the deps, so mount the tree over /app."""
    cmd = A.instance_test_command(_INST)
    assert cmd.startswith("docker run --rm")
    assert '-v "$PWD":/app' in cmd, "must mount the CURRENT worktree, not a baked path"
    assert "-w /app" in cmd
    assert "jefzda/sweap-images:x.y-abc" in cmd
    assert "python -m pytest" in cmd


def test_test_command_does_not_leak_oracle_test_names(A: Any) -> None:  # noqa: N803
    """``selected_test_files_to_run`` holds the oracle's fail_to_pass NODE IDS
    despite its name. Passing them to dev leaks the hidden suite AND asks for
    tests that do not exist in dev's tree (they arrive with the test patch),
    so every run died on `ERROR: not found` and dev never got a green signal."""
    cmd = A.instance_test_command(_INST)
    assert "::" not in cmd, cmd
    assert "test_get_distribution" not in cmd
    assert "test/units/test_sys_info.py" in cmd
    assert "test/units/test_other.py" in cmd


def test_node_ids_reduce_to_distinct_files(A: Any) -> None:  # noqa: N803
    assert A._test_file_paths(
        ["a/b.py::t1", "a/b.py::t2[x-y]", "c/d.py", "a/b.py::t3"]
    ) == ["a/b.py", "c/d.py"]
    assert A._test_file_paths([]) == []


def test_container_cannot_litter_the_host_with_root_owned_files(A: Any) -> None:  # noqa: N803
    """Root-owned `.pytest_cache` left by the container made the next run
    unable to delete its own workspace ("Permission denied")."""
    cmd = A.instance_test_command(_INST)
    assert '--user "$(id -u):$(id -g)"' in cmd
    assert "-p no:cacheprovider" in cmd
    assert "PYTHONDONTWRITEBYTECODE=1" in cmd


# --------------------------------------------------------------------------- #
# result.json integrity — a fresh run must not inherit a previous run's keys
# --------------------------------------------------------------------------- #


def test_fresh_run_result_drops_stale_keys(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """`_write_result` used to MERGE unconditionally, so keys from a previous
    run in the same dir (context_*, an old grade) persisted forever."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    A._write_result("i1", "factory", {"cost_usd": 1.0, "context_files": ["stale.md"]})
    A._write_result("i1", "factory", {"grade": {"oracle_resolved": True}}, merge=True)
    A._write_result("i1", "factory", {"cost_usd": 2.0})  # a NEW run
    data = json.loads((tmp_path / "i1" / "factory" / "result.json").read_text())
    # Nothing survives from the previous run: not the context keys, and not the
    # grade — that verdict was for a prediction that no longer exists. The
    # attempt/budget/provenance stamps are added BY this write, not carried over.
    #
    # ``provenance_stamp`` is compared by SHAPE, not by value: it carries the two
    # repos' live git shas (see ``_provenance_stamp``), which move with every
    # commit. Pinning its value would make this test fail on the next commit;
    # pinning its presence is what the assertion is for — a fresh row that lost
    # its provenance is a row nothing can reproduce.
    stamp = data.pop("provenance_stamp")
    assert set(stamp) >= {"captured_at", "repos", "arm_spec"}
    assert set(stamp["repos"]) == {"harness", "engine"}
    assert data == {
        "cost_usd": 2.0,
        "attempt": 1,
        "budget_exhausted": False,
        "budget_exhausted_reason": None,
    }


def test_grade_still_merges_onto_the_run_result(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    A._write_result("i1", "factory", {"cost_usd": 2.0, "arm": "factory"})
    A._write_result("i1", "factory", {"grade": {"oracle_resolved": False}}, merge=True)
    data = json.loads((tmp_path / "i1" / "factory" / "result.json").read_text())
    assert data["cost_usd"] == 2.0, "grade must not clobber the run payload"
    assert data["grade"] == {"oracle_resolved": False}


# --------------------------------------------------------------------------- #
# ledger totals — every Run row counts, attribution gaps stay visible
# --------------------------------------------------------------------------- #


def test_ledger_totals_count_every_row_and_expose_unattributed(A: Any) -> None:  # noqa: N803
    """Summing only story_id-attributed rows hid onboarder/setup persona spend
    (measured 1.62x cost under-reporting). The state root is per-run isolated,
    so EVERY row in the DB belongs to the run."""
    from types import SimpleNamespace as R  # noqa: N814

    runs = [
        R(story_id=7, tokens_in=100, tokens_out=10, cached_input_tokens=5, cost_usd=1.0),
        # An onboarder-style row with NO story attribution — previously invisible.
        R(story_id=None, tokens_in=200, tokens_out=20, cached_input_tokens=0, cost_usd=0.62),
        R(story_id=9, tokens_in=50, tokens_out=5, cached_input_tokens=None, cost_usd=0.38),
    ]
    t = A._ledger_totals(runs, 7)
    assert t["cost_usd"] == 2.0
    assert t["tokens_in"] == 350
    assert t["tokens_out"] == 35
    assert t["cached_input_tokens"] == 5
    assert t["persona_calls"] == 3
    assert t["unattributed_persona_calls"] == 2
    assert t["unattributed_cost_usd"] == 1.0


# --------------------------------------------------------------------------- #
# wall clock — reported wall_clock_s must include clone/setup time
# --------------------------------------------------------------------------- #


def test_wall_clock_starts_before_clone_and_setup(A: Any) -> None:  # noqa: N803
    """The clock used to start AFTER _clone/_build_bench_root, silently
    excluding setup from wall_clock_s. Contract: the entry clock (`entered`)
    is assigned before any statement that calls _clone."""
    import ast

    tree = ast.parse(_ADAPTER.read_text(encoding="utf-8"))
    for fname in ("run_factory", "run_bare", "run_claude", "run_openhands"):
        fn = next(
            n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == fname
        )

        def _stmt_index(pred: Any, fn: ast.FunctionDef = fn) -> int:
            for i, stmt in enumerate(fn.body):
                if pred(stmt):
                    return i
            raise AssertionError(f"pattern not found in {fn.name}")

        entered_at = _stmt_index(
            lambda s: isinstance(s, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "entered" for t in s.targets)
        )
        clone_at = _stmt_index(
            lambda s: any(
                isinstance(n, ast.Call)
                and isinstance(n.func, ast.Name)
                and n.func.id == "_clone"
                for n in ast.walk(s)
            )
        )
        assert entered_at < clone_at, (
            f"{fname}: the wall clock must start before _clone (entered at "
            f"stmt {entered_at}, _clone at stmt {clone_at})"
        )


# --------------------------------------------------------------------------- #
# stale artifacts — a new run must never inherit a previous run's outputs
# --------------------------------------------------------------------------- #


def test_reset_run_artifacts_deletes_stale_outputs_and_ledger(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Run #2 failing early (precheck/timeout/crash) must not leave run #1's
    prediction.diff for `grade` to certify, nor run #1's Run rows for the
    bare arm's sum-all totals to absorb."""
    for name in ("prediction.diff", "raw.diff", "grade.log", "result.json", "audit.json"):
        (tmp_path / name).write_text("stale", encoding="utf-8")
    (tmp_path / "state" / "events").mkdir(parents=True)
    (tmp_path / "state" / "factory.db").write_text("stale-ledger", encoding="utf-8")
    A._reset_run_artifacts(tmp_path)
    for name in ("prediction.diff", "raw.diff", "grade.log", "result.json", "audit.json"):
        assert not (tmp_path / name).exists(), name
    assert not (tmp_path / "state").exists(), "bare-arm ledger must not accumulate"
    # Idempotent on a clean dir.
    A._reset_run_artifacts(tmp_path)


def test_run_functions_reset_artifacts_before_any_exit_path(A: Any) -> None:  # noqa: N803
    """Contract (AST): both run functions call _reset_run_artifacts before
    _clone — and run_factory before _ensure_image, its earliest SystemExit —
    so no early exit can strand a previous run's prediction beside a fresh
    result."""
    import ast

    tree = ast.parse(_ADAPTER.read_text(encoding="utf-8"))
    for fname, must_precede in (
        ("run_factory", ("_ensure_image", "_clone")),
        ("run_bare", ("_ensure_image", "_clone")),
        ("run_claude", ("_ensure_image", "_clone")),
        ("run_openhands", ("_ensure_image", "_clone")),
    ):
        fn = next(
            n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == fname
        )

        def _call_index(callee: str, fn: ast.FunctionDef = fn, fname: str = fname) -> int:
            for i, stmt in enumerate(fn.body):
                if any(
                    isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Name)
                    and n.func.id == callee
                    for n in ast.walk(stmt)
                ):
                    return i
            raise AssertionError(f"{fname} never calls {callee}")

        reset_at = _call_index("_reset_run_artifacts")
        for callee in must_precede:
            assert reset_at < _call_index(callee), (
                f"{fname}: _reset_run_artifacts must run before {callee}"
            )


# --------------------------------------------------------------------------- #
# clone — submodules must be initialised, and loudly fail when they cannot be
# --------------------------------------------------------------------------- #


def _mk_git_repo(path: Path, files: dict[str, str]) -> str:
    import subprocess as sp

    path.mkdir(parents=True)
    def g(*args: str) -> None:
        sp.run(
            ["git", "-C", str(path), "-c", "user.email=t@t", "-c", "user.name=t", *args],
            check=True, capture_output=True, text=True,
        )
    g("init", "-q")
    for rel, content in files.items():
        target = path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    g("add", ".")
    g("commit", "-q", "-m", "init")
    out = sp.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


@pytest.fixture
def submodule_fixture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path, str]:
    """(main_repo, sub_repo, base_commit) — main has `vendor/infogami` as a
    real git submodule, like openlibrary."""
    import subprocess as sp

    # git >= 2.38 blocks file-path submodule clones by default.
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "protocol.file.allow")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "always")

    sub = tmp_path / "upstream-sub"
    _mk_git_repo(sub, {"infogami_mod.py": "VALUE = 1\n"})
    main = tmp_path / "upstream-main"
    _mk_git_repo(main, {"app.py": "import vendor.infogami\n"})
    sp.run(
        ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t",
         "submodule", "add", str(sub), "vendor/infogami"],
        check=True, capture_output=True, text=True,
    )
    sp.run(
        ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "-m", "add submodule"],
        check=True, capture_output=True, text=True,
    )
    sha = sp.run(
        ["git", "-C", str(main), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return main, sub, sha


def test_clone_initialises_submodules(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,  # noqa: N803
    submodule_fixture: tuple[Path, Path, str],
) -> None:
    """openlibrary's `infogami` symlink points into an uninitialised submodule:
    without init, the mounted tree import-fails in <1s, deterministically."""
    import subprocess as sp

    main, _sub, sha = submodule_fixture
    monkeypatch.setattr(A, "_clone_url", lambda inst: f"file://{main}")
    inst = {"instance_id": "local__main-abc", "repo": "local/main", "base_commit": sha}
    dest = tmp_path / "clone"
    A._clone(inst, dest)
    assert (dest / "vendor" / "infogami" / "infogami_mod.py").exists(), (
        "submodule content missing — the mounted tree would import-fail"
    )
    # The content must be TRACKED (vendored), not a gitlink: the chain builds
    # per-story worktrees with `git worktree add`, which never populates
    # submodules — a gitlink would pass this precheck on the clone while dev's
    # actual worktree import-fails (proxy != real).
    tracked = sp.run(
        ["git", "-C", str(dest), "ls-files", "vendor/infogami/infogami_mod.py"],
        capture_output=True, text=True,
    ).stdout.strip()
    assert tracked == "vendor/infogami/infogami_mod.py"
    wt = tmp_path / "story-worktree"
    sp.run(
        ["git", "-C", str(dest), "worktree", "add", "-b", "swebench-95000-x", str(wt)],
        check=True, capture_output=True, text=True,
    )
    assert (wt / "vendor" / "infogami" / "infogami_mod.py").exists(), (
        "a worktree derived from the clone lost the submodule content"
    )


def test_clone_fails_loudly_when_a_submodule_cannot_fetch(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,  # noqa: N803
    submodule_fixture: tuple[Path, Path, str],
) -> None:
    """A submodule that cannot fetch must be a hard error, not a silent skip —
    a silently-partial clone would reintroduce the exact bug this fixes."""
    import shutil as _shutil

    main, sub, sha = submodule_fixture
    _shutil.rmtree(sub)  # the submodule's upstream is now unreachable
    monkeypatch.setattr(A, "_clone_url", lambda inst: f"file://{main}")
    inst = {"instance_id": "local__main-abc", "repo": "local/main", "base_commit": sha}
    with pytest.raises(RuntimeError, match="submodule init failed"):
        A._clone(inst, tmp_path / "clone")


def test_clone_creates_the_remote_tracking_base_ref(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,  # noqa: N803
    submodule_fixture: tuple[Path, Path, str],
) -> None:
    """The reviewer's diff helper runs `git diff origin/<default_branch>...HEAD`,
    which was rc=128 without a remote-tracking ref — the reviewer then saw an
    error string instead of the diff."""
    import subprocess as sp

    main, _sub, sha = submodule_fixture
    monkeypatch.setattr(A, "_clone_url", lambda inst: f"file://{main}")
    inst = {"instance_id": "local__main-abc", "repo": "local/main", "base_commit": sha}
    dest = tmp_path / "clone"
    A._clone(inst, dest)
    ref = sp.run(
        ["git", "-C", str(dest), "rev-parse", "refs/remotes/origin/swebench-base"],
        capture_output=True, text=True,
    )
    assert ref.returncode == 0
    head = sp.run(
        ["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    # Points at the FINAL base commit (after submodule vendoring), so a
    # worktree branched from it diffs empty against it.
    assert ref.stdout.strip() == head
    diff = sp.run(
        ["git", "-C", str(dest), "diff", "origin/swebench-base...HEAD"],
        capture_output=True, text=True,
    )
    assert diff.returncode == 0, diff.stderr
    assert diff.stdout.strip() == "", "base ref must match HEAD — a non-empty diff pollutes review"


def test_vendoring_forces_files_the_superproject_ignores(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A superproject .gitignore matching files INSIDE a submodule (tracked in
    the submodule's own repo, so its ignores never applied) must not make them
    silently vanish from the vendored tree — that would recreate the
    clone-passes/worktree-fails gap for exactly those paths."""
    import subprocess as sp

    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "protocol.file.allow")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "always")

    sub = tmp_path / "upstream-sub"
    _mk_git_repo(sub, {"infogami_mod.py": "VALUE = 1\n", "data.generated": "payload\n"})
    main = tmp_path / "upstream-main"
    # The superproject ignores *.generated — the submodule legitimately tracks one.
    _mk_git_repo(main, {"app.py": "import vendor\n", ".gitignore": "*.generated\n"})
    for args in (
        ["submodule", "add", str(sub), "vendor/infogami"],
        ["commit", "-q", "-m", "add submodule"],
    ):
        sp.run(
            ["git", "-C", str(main), "-c", "user.email=t@t", "-c", "user.name=t", *args],
            check=True, capture_output=True, text=True,
        )
    sha = sp.run(
        ["git", "-C", str(main), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()

    monkeypatch.setattr(A, "_clone_url", lambda inst: f"file://{main}")
    inst = {"instance_id": "local__main-ign", "repo": "local/main", "base_commit": sha}
    dest = tmp_path / "clone"
    A._clone(inst, dest)
    tracked = sp.run(
        ["git", "-C", str(dest), "ls-files", "vendor/infogami/data.generated"],
        capture_output=True, text=True,
    ).stdout.strip()
    assert tracked == "vendor/infogami/data.generated", (
        "ignore-matched submodule file was dropped from the vendored tree"
    )


# --------------------------------------------------------------------------- #
# pre-dispatch collect gate — test_command must WORK, not merely be set
# --------------------------------------------------------------------------- #


def test_collect_only_command_keeps_the_real_environment(A: Any) -> None:  # noqa: N803
    """The gate must test the REAL environment (image + mount), so the collect
    command is the same docker invocation dev runs, plus --collect-only."""
    cmd = A.instance_test_command(_INST, collect_only=True)
    assert "--collect-only -q" in cmd
    assert cmd.startswith("docker run --rm")
    assert '-v "$PWD":/app' in cmd
    assert "jefzda/sweap-images:x.y-abc" in cmd
    # And the default command is unchanged.
    assert "--collect-only" not in A.instance_test_command(_INST)


def _mk_targets(repo: Path, *rels: str) -> None:
    for rel in rels:
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("def test_x():\n    pass\n", encoding="utf-8")


def _fake_collect(monkeypatch: pytest.MonkeyPatch, A: Any, rc: int, out: str) -> dict[str, Any]:  # noqa: N803
    from types import SimpleNamespace

    seen: dict[str, Any] = {}

    def fake_run(cmd: Any, **kw: Any) -> Any:
        seen["cmd"], seen["kw"] = cmd, kw
        return SimpleNamespace(returncode=rc, stdout=out, stderr="")

    monkeypatch.setattr(A.subprocess, "run", fake_run)
    return seen


def test_precheck_fails_loudly_when_collection_fails(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The infogami class: targets EXIST but collection dies on a broken
    import. Mocked at the subprocess boundary; must stay a hard fail."""
    _mk_targets(tmp_path, "test/units/test_sys_info.py", "test/units/test_other.py")
    seen = _fake_collect(
        monkeypatch, A, 2, "ModuleNotFoundError: No module named 'infogami'"
    )
    pre = A._precheck_collect(_INST, tmp_path)
    assert pre["collect_ok"] is False
    assert pre["mode"] == "existing-targets"
    assert pre["exit_code"] == 2
    assert "infogami" in pre["tail"]
    assert pre["duration_s"] >= 0
    assert "--collect-only" in seen["cmd"]
    assert seen["kw"]["shell"] is True, "must run the docker command verbatim"
    assert seen["kw"]["cwd"] == str(tmp_path), "must mount the run's own clone"


def test_precheck_passes_when_collection_succeeds(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    _mk_targets(tmp_path, "test/units/test_sys_info.py", "test/units/test_other.py")
    _fake_collect(monkeypatch, A, 0, "12 tests collected")
    pre = A._precheck_collect(_INST, tmp_path)
    assert pre["collect_ok"] is True
    assert pre["mode"] == "existing-targets"
    assert sorted(pre["collected_targets"]) == [
        "test/units/test_other.py", "test/units/test_sys_info.py",
    ]
    assert "collected" in pre["tail"]


def test_precheck_existing_mode_collects_only_the_targets_that_exist(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """SOME targets exist → strict mode over exactly those; the missing one
    (which dev will create) must not poison the command with rc 4."""
    _mk_targets(tmp_path, "test/units/test_sys_info.py")  # test_other.py missing
    seen = _fake_collect(monkeypatch, A, 0, "ok")
    pre = A._precheck_collect(_INST, tmp_path)
    assert pre["mode"] == "existing-targets"
    assert pre["collected_targets"] == ["test/units/test_sys_info.py"]
    assert "test_sys_info.py" in seen["cmd"]
    assert "test_other.py" not in seen["cmd"]


def test_precheck_existing_mode_stays_strict_about_rc5(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """rc 5 over targets that EXIST means the suite dev must run collects
    nothing — that is still a broken setup, not a TDD instance."""
    _mk_targets(tmp_path, "test/units/test_sys_info.py", "test/units/test_other.py")
    _fake_collect(monkeypatch, A, 5, "no tests collected")
    pre = A._precheck_collect(_INST, tmp_path)
    assert pre["collect_ok"] is False
    assert pre["mode"] == "existing-targets"


def test_precheck_salvages_new_test_file_instances_via_ancestor_env_check(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The openlibrary-798055 class: NO target exists at base_commit because
    dev is supposed to CREATE it (legit TDD red). The gate must verify the
    environment via the nearest existing ancestor dir, and rc 5 (nothing
    collected there, no errors) must PASS."""
    (tmp_path / "test" / "units").mkdir(parents=True)  # ancestor exists, files don't
    seen = _fake_collect(monkeypatch, A, 5, "no tests ran")
    pre = A._precheck_collect(_INST, tmp_path)
    assert pre["collect_ok"] is True
    assert pre["mode"] == "ancestor-env-check"
    assert pre["collected_targets"] == ["test/units"]
    assert pre["exit_code"] == 5
    assert "'test/units'" in seen["cmd"], "must collect the ancestor, not the missing file"
    assert "test_sys_info.py" not in seen["cmd"]


def test_precheck_ancestor_mode_still_hard_fails_on_import_errors(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Ancestor collection still executes conftest/package imports, so a
    wrecked environment (rc 2) must stay a hard fail even in salvage mode."""
    (tmp_path / "test" / "units").mkdir(parents=True)
    _fake_collect(monkeypatch, A, 2, "ImportError while loading conftest")
    pre = A._precheck_collect(_INST, tmp_path)
    assert pre["collect_ok"] is False
    assert pre["mode"] == "ancestor-env-check"
    assert pre["exit_code"] == 2
    assert "conftest" in pre["tail"]


# --------------------------------------------------------------------------- #
# audit — a run whose trail is broken or missing must FAIL, not pass
# --------------------------------------------------------------------------- #

_RUNS_DDL = (
    "CREATE TABLE runs (id INTEGER PRIMARY KEY, ts TEXT, persona TEXT, model TEXT, "
    "story_id INTEGER, tokens_in INTEGER, tokens_out INTEGER, "
    "cached_input_tokens INTEGER, cost_usd REAL, duration_s REAL, "
    "success INTEGER, error TEXT)"
)


def _mk_audit_run(
    runs_root: Path,
    *,
    arm: str = "factory",
    rows: list[tuple[Any, ...]] | None = None,
    result: dict[str, Any] | None = None,
    bodies: list[dict[str, Any]] | None = None,
    write_db: bool = True,
    write_bodies: bool = True,
    responses: list[dict[str, Any]] | None = None,
    trajectories: int = 1,
) -> None:
    """Fabricate a run directory shaped like a real one.

    ``trajectories`` defaults to 1 because a real run HAS an action trail, and
    an arm that reports model calls with no trail at all now fails the audit
    (it used to be silently fine, so a wiped state root audited clean).
    """
    import sqlite3

    run_dir = runs_root / "inst1" / arm
    state_root = run_dir / "root" if arm == "factory" else run_dir
    (state_root / "state" / "events").mkdir(parents=True, exist_ok=True)
    run_dir.mkdir(parents=True, exist_ok=True)

    default_rows = [
        ("t0", "dev", "m", 1, 100, 10, 0, 1.25, 90.0, 1, None),
        ("t1", "reviewer", "m", 1, 50, 5, 0, 0.75, 30.0, 1, None),
    ]
    if write_db:
        con = sqlite3.connect(state_root / "state" / "factory.db")
        con.execute(_RUNS_DDL)
        con.executemany(
            "INSERT INTO runs (ts, persona, model, story_id, tokens_in, tokens_out, "
            "cached_input_tokens, cost_usd, duration_s, success, error) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows if rows is not None else default_rows,
        )
        con.commit()
        con.close()

    if result is None:
        result = {"cost_usd": 2.0, "tokens_in": 150, "tokens_out": 15}
    (run_dir / "result.json").write_text(json.dumps(result), encoding="utf-8")

    if write_bodies:
        if bodies is None:
            bodies = [
                {"event": "prompt_body", "persona": "dev", "prompt": "fix it", "prompt_hash": "a" * 16},
                {"event": "prompt_body", "persona": "reviewer", "prompt": "diff --git a/x b/x", "prompt_hash": "b" * 16},
            ]
        (state_root / "state" / "events" / "prompt_bodies.ndjson").write_text(
            "\n".join(json.dumps(b) for b in bodies) + "\n", encoding="utf-8"
        )

    if responses is not None:
        (state_root / "state" / "events" / "response_bodies.ndjson").write_text(
            "\n".join(json.dumps(r) for r in responses) + "\n", encoding="utf-8"
        )

    for i in range(trajectories):
        traj_dir = state_root / "state" / "events" / "trajectories"
        traj_dir.mkdir(parents=True, exist_ok=True)
        (traj_dir / f"1-{i + 1}.ndjson").write_text(
            json.dumps(
                {
                    "source": "agent",
                    "llm_message": {
                        "content": [{"type": "text", "text": f"dev reasoning step {i}"}]
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )


def _audit_json(runs_root: Path, arm: str = "factory") -> dict[str, Any]:
    return json.loads((runs_root / "inst1" / arm / "audit.json").read_text(encoding="utf-8"))


def test_audit_passes_a_coherent_run_and_writes_audit_json(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path)
    A.audit("inst1", "factory")  # must not raise
    data = _audit_json(tmp_path)
    assert data["ok"] is True
    assert data["failures"] == []
    assert len(data["persona_calls"]) == 2
    assert data["ledger_cost_usd"] == 2.0


def test_audit_fails_on_cost_mismatch(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The 1.62x under-reporting class: result.json says less than the ledger."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, result={"cost_usd": 1.25, "tokens_in": 150, "tokens_out": 15})
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("cost mismatch" in f for f in failures), failures


def test_audit_fails_when_a_reviewer_prompt_saw_an_error_instead_of_a_diff(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        bodies=[
            {
                "event": "prompt_body",
                "persona": "reviewer",
                "prompt": "(git diff origin/swebench-base...HEAD returned rc=128; stderr_tail='fatal')",
                "prompt_hash": "c" * 16,
            },
        ],
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("broken-diff markers" in f for f in failures), failures


def test_audit_ignores_error_strings_in_non_reviewer_prompts(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A dev prompt legitimately quotes test output, which can contain
    arbitrary strings; only the REVIEWER seeing them invalidates the run."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        bodies=[
            {"event": "prompt_body", "persona": "dev",
             "prompt": "prior attempt: command returned rc=1", "prompt_hash": "d" * 16},
            {"event": "prompt_body", "persona": "reviewer",
             "prompt": "diff --git a/x b/x", "prompt_hash": "e" * 16},
        ],
    )
    A.audit("inst1", "factory")  # must not raise
    assert _audit_json(tmp_path)["ok"] is True


def test_audit_fails_when_prompt_bodies_are_missing(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FAIL SAFE: an unauditable run is an invalid run, not a pass."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, write_bodies=False)
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("prompt_bodies" in f for f in failures), failures


def test_audit_fails_when_the_run_ledger_is_missing(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, write_db=False, result={"cost_usd": 0.0})
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("factory.db" in f for f in failures), failures


def test_audit_flags_a_fast_failing_first_dev_run(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A first dev call that failed in under ~5s never tested anything — the
    unrunnable-environment signature (e.g. ModuleNotFoundError in 0.8s)."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        rows=[("t0", "dev", "m", 1, 10, 1, 0, 0.01, 0.8, 0, "boom")],
        result={"cost_usd": 0.01, "tokens_in": 10, "tokens_out": 1},
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("unrunnable-environment" in f for f in failures), failures


def test_audit_fails_on_empty_result_json(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """`{}` used to skip the whole ledger<->result section via truthiness and
    audit-pass a run that reported nothing. Fail safe instead."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, result={})
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("empty or not a JSON object" in f for f in failures), failures


def test_audit_fails_on_non_object_result_json(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path)
    (tmp_path / "inst1" / "factory" / "result.json").write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("empty or not a JSON object" in f for f in failures), failures


def test_audit_detects_the_worktree_resolution_failure_marker(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The fifth handlers.py fallback string — `(could not resolve writing
    worktree: ...)` — is also an error-instead-of-diff reviewer prompt."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        bodies=[
            {
                "event": "prompt_body",
                "persona": "reviewer",
                "prompt": "(could not resolve writing worktree: OSError('gone'))",
                "prompt_hash": "f" * 16,
            },
        ],
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("broken-diff markers" in f for f in failures), failures


def test_audit_fails_when_reviewer_prompts_were_rotated_away(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The ledger shows a reviewer ran, but zero reviewer prompt bodies are
    scannable (rotated away / never captured): the marker scan finds nothing
    only because there is nothing to scan — silence must not read as clean."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        bodies=[
            {"event": "prompt_body", "persona": "dev",
             "prompt": "fix it", "prompt_hash": "a" * 16},
        ],
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("reviewer input is unauditable" in f for f in failures), failures


def test_audit_fails_a_run_with_a_recorded_failed_precheck(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        rows=[],
        result={
            "cost_usd": 0.0,
            "tokens_in": 0,
            "tokens_out": 0,
            "precheck": {"collect_ok": False, "duration_s": 0.9},
            "error": "precheck: test command does not collect: ...",
        },
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("precheck" in f for f in failures), failures


# --------------------------------------------------------------------------- #
# audit — response-side coverage is a WARNING, never a failure
# --------------------------------------------------------------------------- #

_RESPONSE_ROWS = [
    {"event": "response_body", "persona": "dev", "story_id": 1, "mode": "sandbox",
     "response": "SELF_SUMMARY: fixed it.", "ts": "t0"},
    {"event": "response_body", "persona": "reviewer", "story_id": 1, "mode": "text",
     "response": "APPROVED — no findings.", "ts": "t1"},
]


def test_audit_warns_but_passes_when_response_bodies_are_missing(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """A run without response capture (older factory, capture off, capped
    trajectory) stays VALID — invalidating it would fail every historical
    run — but the gap must be loud."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    # One trajectory (a real run has a trail; zero is its own failure now) but
    # no response bodies, and only one of the two personas covered.
    _mk_audit_run(tmp_path, trajectories=1)
    A.audit("inst1", "factory")  # must not raise
    data = _audit_json(tmp_path)
    assert data["ok"] is True
    assert any("response" in w for w in data["warnings"]), data["warnings"]
    # The missing-trajectory case moved to its own test: with a trail present
    # the run stays valid, with NO trail at all it fails.
    out = capsys.readouterr().out
    assert "AUDIT WARN" in out
    assert "resp=NO" in out


def test_audit_is_warning_free_when_responses_and_trajectory_are_present(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, responses=_RESPONSE_ROWS, trajectories=1)
    A.audit("inst1", "factory")
    data = _audit_json(tmp_path)
    assert data["ok"] is True
    assert data["warnings"] == []
    out = capsys.readouterr().out
    assert "resp=NO" not in out
    assert "traj=yes" in out


def test_audit_fails_when_the_action_trail_is_missing_entirely(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A run with model calls and NO trail cannot be cleared of oracle access.

    This used to be a warning that still audited OK — the oracle-probe scan
    returned no findings because it had nothing to scan, so a wiped state root
    passed. Fail closed: no trail, no clearance. The per-persona trajectory
    warning stays, because a PARTIAL trail is still scannable.
    """
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, responses=_RESPONSE_ROWS, trajectories=0)
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    data = _audit_json(tmp_path)
    assert any("no action trail" in f for f in data["failures"]), data["failures"]
    assert any("trajectory" in w for w in data["warnings"]), data["warnings"]
    assert data["trajectories_scanned"] == 0
    assert data["trails_scanned"] == 0


def test_audit_show_responses_prints_the_reviewer_text_and_dev_messages(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """The operator-readability contract: what the reviewer said and what dev
    was thinking, without spelunking through ndjson by hand."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, responses=_RESPONSE_ROWS, trajectories=1)
    A.audit("inst1", "factory", show_responses=True)
    out = capsys.readouterr().out
    assert "APPROVED — no findings." in out
    assert "dev reasoning step 0" in out


def test_audit_survives_an_unreadable_response_stream_with_a_warning(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """SHIP-BLOCKER class: response coverage is warnings-class by contract, so
    an UNREADABLE response stream must degrade to a warning — an unhandled
    OSError here would crash audit() before audit.json is written and
    invalidate the whole run through the back door."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, trajectories=1)
    state_root = tmp_path / "inst1" / "factory" / "root"
    # A directory matching the stream glob raises IsADirectoryError (an
    # OSError) on open() for ANY uid — unlike chmod 0, which root ignores.
    (state_root / "state" / "events" / "response_bodies.ndjson").mkdir()
    A.audit("inst1", "factory")  # must not raise
    data = _audit_json(tmp_path)
    assert data["ok"] is True
    assert any("unreadable" in w for w in data["warnings"]), data["warnings"]


def test_show_responses_picks_the_newest_trajectory_by_mtime(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """Lexicographic 'newest' is wrong twice over: retry-suffixed names sort
    before their base file, and '10-1' sorts before '9-1'. mtime is truth."""
    import os

    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, responses=_RESPONSE_ROWS, trajectories=0)
    traj_dir = tmp_path / "inst1" / "factory" / "root" / "state" / "events" / "trajectories"
    traj_dir.mkdir(parents=True)

    def _traj(name: str, text: str, mtime: int) -> None:
        p = traj_dir / name
        p.write_text(
            json.dumps(
                {"source": "agent",
                 "llm_message": {"content": [{"type": "text", "text": text}]}}
            ) + "\n",
            encoding="utf-8",
        )
        os.utime(p, (mtime, mtime))

    # '9-1' is the newest run but sorts LAST lexicographically in this set
    # only by accident — pin the trap: '10-1' and a retry-suffixed '5-1-...'
    # both sort after/around it depending on the set. mtimes disagree with
    # every lexicographic ordering here.
    _traj("5-1.ndjson", "from 5-1", 1000)
    _traj("5-1-1700000000000.ndjson", "from 5-1 retry", 2000)
    _traj("10-1.ndjson", "from 10-1", 3000)
    _traj("9-1.ndjson", "from 9-1 NEWEST", 4000)

    A.audit("inst1", "factory", show_responses=True)
    out = capsys.readouterr().out
    assert "from 9-1 NEWEST" in out
    assert "from 10-1" not in out


def test_audit_response_warning_does_not_mask_a_real_failure(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Warnings and failures are separate channels: a run that is BOTH
    uncaptured and cost-mismatched still fails."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, result={"cost_usd": 0.10, "tokens_in": 150, "tokens_out": 15})
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    data = _audit_json(tmp_path)
    assert data["ok"] is False
    assert any("cost mismatch" in f for f in data["failures"])
    assert any("response" in w for w in data["warnings"])


def test_story_slug_is_stable_across_processes(A: Any) -> None:  # noqa: N803
    """Was ``abs(hash(instance_id))``, which Python salts per process — every
    run produced a different worktree name, orphaning the previous one, and
    the diff capture could then grade the WRONG run's tree."""
    import subprocess as sp
    import sys as _sys

    code = (
        "import importlib.util,sys;"
        f"spec=importlib.util.spec_from_file_location('A',{str(_ADAPTER)!r});"
        "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
        "print(m._story_slug('instance_x__y-abc'))"
    )
    outs = {
        sp.run(
            [_sys.executable, "-c", code],
            capture_output=True, text=True, check=True,
            env={"PYTHONHASHSEED": seed, "PATH": "/usr/bin:/bin"},
        ).stdout.strip()
        for seed in ("0", "1", "12345")
    }
    assert len(outs) == 1, f"slug varies with PYTHONHASHSEED: {outs}"


# --------------------------------------------------------------------------- #
# run-all — the parallel sweep
#
# Nothing here executes a real sweep: a run costs real money and needs API
# keys. Every test below replaces the child-process layer with a fake, which is
# the correct seam — the whole design is "the parent orchestrates, children do
# the work", so faking the child tests the orchestration and nothing else.
# --------------------------------------------------------------------------- #


class _FakeChild:
    """Stands in for ``_bench_subprocess``: records calls, fabricates artifacts.

    Also measures how many calls were in flight at once, which is the only way
    to prove the pool actually fans out rather than quietly running in series.
    """

    def __init__(
        self,
        A: Any,
        *,
        fail: dict[str, str] | None = None,
        delay: float = 0.0,
        cost: float = 0.5,
    ):
        self.A = A
        self.fail = fail or {}
        self.delay = delay
        self.cost = cost
        self.calls: list[list[str]] = []
        self.log_paths: list[Path] = []
        self.live = 0
        self.max_live = 0
        self._lock = __import__("threading").Lock()

    def __call__(self, argv: list[str], *, timeout_s: int, log_path: Path) -> tuple[int, str]:
        import time as _time

        with self._lock:
            self.calls.append(list(argv))
            self.log_paths.append(log_path)
            self.live += 1
            self.max_live = max(self.max_live, self.live)
        try:
            if self.delay:
                _time.sleep(self.delay)
            cmd = argv[2]
            iid = argv[argv.index("--instance") + 1]
            arm = argv[argv.index("--arm") + 1]
            mode = self.fail.get(iid)

            if cmd == "run":
                if mode == "raise":
                    raise RuntimeError("worker exploded")
                if mode == "no_image":
                    return 1, "image for X is unavailable"
                if mode == "timeout":
                    return -9, "timeout after 1s"
                d = self.A._run_dir(iid, arm)
                (d / "prediction.diff").write_text("diff --git a/x.py b/x.py\n", encoding="utf-8")
                (d / "result.json").write_text(
                    json.dumps(
                        {
                            "arm": arm,
                            "instance_id": iid,
                            "final_state": "reviewer_done",
                            "tokens_in": 1000,
                            "tokens_out": 100,
                            "cost_usd": self.cost,
                            "factory_says_green": True,
                        }
                    ),
                    encoding="utf-8",
                )
                if mode == "late_fail":
                    # A run that failed LATE: prediction + result already
                    # written, then the run exits non-zero.
                    return 1, "run crashed after writing its prediction"
                return 0, "factory arm done"

            if cmd == "audit":
                d = self.A._run_dir(iid, arm)
                if mode == "audit_crash":
                    # the audit child died before writing audit.json
                    return 1, "audit crashed"
                if mode == "audit_fail":
                    (d / "audit.json").write_text(
                        json.dumps(
                            {"ok": False, "failures": ["cost mismatch: ledger vs result.json"]}
                        ),
                        encoding="utf-8",
                    )
                    return 1, "audit FAILED (1 finding(s))"
                # Mirror the real audit's fail-safety: a run that left no
                # result.json is an audit FAILURE, never a pass.
                if not (d / "result.json").exists():
                    (d / "audit.json").write_text(
                        json.dumps({"ok": False, "failures": ["missing artifact: result.json"]}),
                        encoding="utf-8",
                    )
                    return 1, "audit FAILED (missing artifact)"
                (d / "audit.json").write_text(
                    json.dumps({"ok": True, "failures": []}), encoding="utf-8"
                )
                return 0, "audit OK"

            # grade
            if mode == "grade_fail":
                return 2, "docker died"
            d = self.A._run_dir(iid, arm)
            existing = json.loads((d / "result.json").read_text(encoding="utf-8"))
            existing["grade"] = {"oracle_resolved": True, "outcome": "resolved"}
            (d / "result.json").write_text(json.dumps(existing), encoding="utf-8")
            return 0, "graded"
        finally:
            with self._lock:
                self.live -= 1


def _sweep_env(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ids: list[str]
) -> None:
    """Point every path the sweep writes at ``tmp_path`` and pin a manifest."""
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "manifest_sha256": "deadbeef",
                "instances": [{"instance_id": i, "dockerhub_tag": "t"} for i in ids],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", manifest)
    monkeypatch.setattr(A, "SWE_DIR", tmp_path)
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(A, "load_spend_caps", lambda *a, **k: (1000.0, 10000.0))


_IDS = [f"instance_repo__x-{n}" for n in range(6)]


def test_sweep_fans_out_and_grades_every_instance(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Every instance is run AND graded, and the work genuinely overlaps."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    fake = _FakeChild(A, delay=0.05)
    monkeypatch.setattr(A, "_bench_subprocess", fake)

    A.run_all(
        arm="factory", workers=3, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )

    ran = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "run"}
    graded = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "grade"}
    audited = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "audit"}
    assert ran == set(_IDS)
    assert graded == set(_IDS), "grade must follow each run, in the same pool"
    assert audited == set(_IDS), "every instance must be audited, in the same pool"
    assert fake.max_live > 1, "workers ran strictly in series — the pool is not fanning out"

    out = capsys.readouterr().out
    for iid in _IDS:
        assert iid in out
    assert "6 ok, 0 failed" in out
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    assert summary["instances"] == 6 and summary["resolved"] == 6
    assert summary["audited_valid"] == 6 and summary["audit_failed"] == 0
    assert summary["tokens_in"] == 6000 and summary["tokens_out"] == 600


def test_sweep_runs_children_as_separate_processes(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The unsafe work MUST happen behind a process boundary.

    ``run_factory`` sets ``os.environ['FACTORY_STATE_ROOT']``, mutates
    ``sys.path`` and relies on ``factory.settings.loader``'s module-global
    cache. Two of those in one interpreter cross-contaminate, and the losing
    run writes synthetic telemetry into the other's root — or into production
    ``state/``. So the pool must never call ``run_factory`` in-process.
    """
    import sys as _sys

    _sweep_env(A, tmp_path, monkeypatch, _IDS[:2])
    fake = _FakeChild(A)
    monkeypatch.setattr(A, "_bench_subprocess", fake)

    def _boom(*a: Any, **k: Any) -> None:
        raise AssertionError("run_factory called IN-PROCESS — that is not thread-safe")

    monkeypatch.setattr(A, "run_factory", _boom)
    monkeypatch.setattr(A, "run_bare", _boom)
    monkeypatch.setattr(A, "grade", _boom)
    monkeypatch.setattr(A, "audit", _boom)

    A.run_all(
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    assert fake.calls
    for argv in fake.calls:
        assert argv[0] == _sys.executable, argv
        assert argv[1].endswith("swebench_adapter.py"), argv


def test_no_two_workers_write_the_same_path(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deterministic, collision-free result files.

    Two workers sharing a ``result.json`` would let the last writer silently
    win, and the sweep would report a score for a run that never happened.
    """
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    fake = _FakeChild(A)
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=4, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    assert len(fake.log_paths) == len(set(fake.log_paths)), "two workers shared a log path"
    results = sorted((tmp_path / "runs").glob("*/factory/result.json"))
    assert len(results) == len(_IDS)
    assert len({p.parent.parent.name for p in results}) == len(_IDS)


def test_duplicate_instances_are_collapsed(A: Any) -> None:  # noqa: N803
    """The same instance twice would be two workers on one result path."""
    assert A.select_instances(["a", "b"], requested=["a", "a", "b"]) == ["a", "b"]
    assert A.select_instances(["a", "a", "b"]) == ["a", "b"]


def test_requesting_an_unpinned_instance_refuses(A: Any) -> None:  # noqa: N803
    with pytest.raises(SystemExit, match="not in the pinned manifest"):
        A.select_instances(["a", "b"], requested=["a", "zzz"])


# --------------------------------------------------------------------------- #
# --only-working
# --------------------------------------------------------------------------- #


def test_only_working_keeps_instances_with_a_resolving_gold_patch(A: Any) -> None:  # noqa: N803
    """``gold_resolves: None`` means "could not check", which is NOT evidence
    of a working oracle — it must be filtered out just like an explicit
    failure, or a score gets computed over instances nobody validated."""
    working = {"ok1", "ok2"}
    got = A.select_instances(
        ["ok1", "broken", "unchecked", "ok2"], only_working=True, working=working
    )
    assert got == ["ok1", "ok2"]


def test_only_working_reads_selftest_json(A: Any, tmp_path: Path) -> None:  # noqa: N803
    p = tmp_path / "selftest.json"
    p.write_text(
        json.dumps(
            {
                "results": [
                    {"instance_id": "good", "gold_resolves": True},
                    {"instance_id": "bad", "gold_resolves": False},
                    {"instance_id": "unknown", "gold_resolves": None},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert A.selftest_working_instances(p) == {"good"}


def test_only_working_without_a_selftest_refuses(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """Fail SAFE: no control run means we cannot know which oracles work, so
    refuse rather than silently sweep everything."""
    with pytest.raises(SystemExit, match="Run `selftest` first"):
        A.selftest_working_instances(tmp_path / "absent.json")


def test_only_working_with_nothing_left_refuses(A: Any) -> None:  # noqa: N803
    with pytest.raises(SystemExit, match="no instances left after --only-working"):
        A.select_instances(["a", "b"], only_working=True, working=set())


def test_sweep_honours_only_working_end_to_end(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    (tmp_path / "selftest.json").write_text(
        json.dumps(
            {
                "results": [
                    {"instance_id": i, "gold_resolves": i in (_IDS[0], _IDS[3])}
                    for i in _IDS
                ]
            }
        ),
        encoding="utf-8",
    )
    fake = _FakeChild(A)
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=4, instances=None, only_working=True,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    ran = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "run"}
    assert ran == {_IDS[0], _IDS[3]}


# --------------------------------------------------------------------------- #
# failure isolation
# --------------------------------------------------------------------------- #


def test_one_bad_instance_does_not_kill_the_sweep(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A crash, a timeout, a missing image and a failed grade — all four are
    recorded and the other instances still finish."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    fake = _FakeChild(
        A,
        fail={
            _IDS[0]: "raise",
            _IDS[1]: "timeout",
            _IDS[2]: "no_image",
            _IDS[3]: "grade_fail",
        },
    )
    monkeypatch.setattr(A, "_bench_subprocess", fake)

    A.run_all(
        arm="factory", workers=3, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )

    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    assert summary["instances"] == 6, "the sweep must visit every instance"
    assert summary["ok"] == 2 and summary["failed"] == 4
    by_id = {r["instance_id"]: r for r in summary["results"]}
    assert by_id[_IDS[0]]["status"] == "crashed"
    assert "worker exploded" in by_id[_IDS[0]]["error"]
    assert by_id[_IDS[1]]["status"] == "run_failed"
    assert "timeout" in by_id[_IDS[1]]["error"]
    assert by_id[_IDS[2]]["status"] == "run_failed"
    assert by_id[_IDS[3]]["status"] == "grade_failed"
    # The two healthy instances still produced a real graded verdict.
    assert by_id[_IDS[4]]["oracle_resolved"] is True
    assert by_id[_IDS[5]]["outcome"] == "resolved"
    # Audit tri-state: a crashed worker never audits (None); a run that left
    # no result.json FAILS its audit (missing artifact, fail safe); healthy
    # rows pass.
    assert by_id[_IDS[0]]["audit_ok"] is None
    assert by_id[_IDS[1]]["audit_ok"] is False
    assert by_id[_IDS[2]]["audit_ok"] is False
    assert by_id[_IDS[4]]["audit_ok"] is True
    assert summary["audited_valid"] == 3  # grade_failed row still audits clean
    assert summary["audit_failed"] == 2 and summary["not_audited"] == 1
    assert summary["resolved"] == 2
    out = capsys.readouterr().out
    assert "failures (isolated — the sweep continued)" in out


def test_a_failed_run_is_not_graded(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No prediction.diff means nothing to grade; grading anyway would only
    stack a confusing second error on top of the real one."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:2])
    fake = _FakeChild(A, fail={_IDS[0]: "no_image"})
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    graded = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "grade"}
    assert graded == {_IDS[1]}


# --------------------------------------------------------------------------- #
# the per-instance audit gate
#
# Every benchmark run must be fully auditable (the operator's standing
# requirement); the sweep is where that becomes automatic. A row whose audit
# fails is INVALID and must never be silently averaged into a score.
# --------------------------------------------------------------------------- #


def test_a_failed_run_is_still_audited(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audit runs UNCONDITIONALLY after run+grade — the real audit treats a
    missing artifact as a finding (fail safe), so skipping it for failed runs
    would let exactly the suspicious rows dodge scrutiny."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:2])
    fake = _FakeChild(A, fail={_IDS[0]: "no_image"})
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    audited = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "audit"}
    assert audited == set(_IDS[:2]), "failed runs must be audited too"
    # And within one instance, audit is the LAST step.
    order = [c[2] for c in fake.calls if c[c.index("--instance") + 1] == _IDS[1]]
    assert order == ["run", "grade", "audit"]


def test_audit_failure_marks_the_row_invalid(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A run can look perfect (green, graded, resolved) and still be invalid —
    the audit found its trail does not support its numbers. The row keeps its
    status but is flagged ``audit_ok: false`` with the reasons, and the
    summary separates audited-valid results from invalid ones."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    fake = _FakeChild(A, fail={_IDS[1]: "audit_fail"})
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=3, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    by_id = {r["instance_id"]: r for r in summary["results"]}
    row = by_id[_IDS[1]]
    assert row["status"] == "ok", "audit failure must not rewrite what the run did"
    assert row["audit_ok"] is False
    assert any("cost mismatch" in f for f in row["audit_failures"])
    assert summary["audited_valid"] == 5 and summary["audit_failed"] == 1
    # The invalid row's oracle pass is visible but flagged — never in the
    # headline number.
    assert summary["resolved"] == 5
    assert summary["resolved_but_audit_failed"] == 1
    out = capsys.readouterr().out
    assert "audit failures (rows are INVALID" in out
    assert "audit: 5 valid, 1 failed" in out


def test_a_sweep_where_every_row_fails_audit_exits_nonzero(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """rc=0 means "results are in". A sweep with zero audited-valid rows has
    no results, and anything scripted on top of it must see that."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:2])
    fake = _FakeChild(A, fail={i: "audit_fail" for i in _IDS[:2]})
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    with pytest.raises(SystemExit, match="NO audited-valid rows"):
        A.run_all(
            arm="factory", workers=2, instances=None, only_working=False,
            max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        )
    # The summary is still written — it is the evidence of WHY it failed.
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    assert summary["audit_failed"] == 2 and summary["audited_valid"] == 0
    assert summary["resolved"] == 0


def test_one_null_audit_row_does_not_defeat_the_exit_gate(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`all(audit_ok is False)` was the old gate, and a single crashed row
    (audit_ok null) broke it: 3 audit-FAILs + 1 crash exited 0 with zero
    audited-valid rows. The gate is `not any(audit_ok is True)` — a crash is
    not evidence of validity."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:4])
    fake = _FakeChild(
        A,
        fail={
            _IDS[0]: "audit_fail",
            _IDS[1]: "audit_fail",
            _IDS[2]: "audit_fail",
            _IDS[3]: "raise",  # crashed -> audit_ok null, never True
        },
    )
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    with pytest.raises(SystemExit, match="NO audited-valid rows"):
        A.run_all(
            arm="factory", workers=2, instances=None, only_working=False,
            max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        )
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    assert summary["audited_valid"] == 0
    assert summary["audit_failed"] == 3 and summary["not_audited"] == 1


def test_audit_reasons_fall_back_to_child_output(  # noqa: N803
    A: Any, tmp_path: Path
) -> None:
    """An invalid row must always say WHY: if the audit child died without
    writing audit.json, the child's last line is the reason."""
    d = tmp_path / "run"
    d.mkdir()
    assert A._audit_failure_reasons(d, "audit blew up") == ["audit blew up"]
    (d / "audit.json").write_text(
        json.dumps({"ok": False, "failures": ["finding A", "finding B"]}), encoding="utf-8"
    )
    assert A._audit_failure_reasons(d, "ignored") == ["finding A", "finding B"]


def test_stale_audit_json_is_not_read_as_this_rows_findings(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the run child never ran ``_reset_run_artifacts`` and the audit child
    crashed before writing, a PREVIOUS run's audit.json must not be read as
    this row's findings — the sweep unlinks it before invoking the audit."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:1])
    stale = A._run_dir(_IDS[0], "factory") / "audit.json"
    stale.write_text(
        json.dumps({"ok": False, "failures": ["STALE finding from a previous run"]}),
        encoding="utf-8",
    )
    fake = _FakeChild(A, fail={_IDS[0]: "audit_crash"})
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    with pytest.raises(SystemExit):  # the only row has no valid audit
        A.run_all(
            arm="factory", workers=1, instances=None, only_working=False,
            max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        )
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    row = summary["results"][0]
    assert row["audit_ok"] is False
    assert row["audit_failures"] == ["audit crashed"]
    assert not any("STALE" in f for f in row["audit_failures"])


def test_resolved_but_run_failed_is_flagged_not_conflated(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A run that failed LATE can still have written a prediction that
    resolves the oracle (safe to grade only because ``_reset_run_artifacts``
    guarantees the prediction is THIS run's). That pass is recorded — but in
    its own flagged counter, never in the headline ``resolved``."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:2])
    fake = _FakeChild(A, fail={_IDS[0]: "late_fail"})
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    by_id = {r["instance_id"]: r for r in summary["results"]}
    assert by_id[_IDS[0]]["status"] == "run_failed"
    assert by_id[_IDS[0]]["oracle_resolved"] is True, "the late prediction WAS graded"
    assert summary["resolved"] == 1, "only the clean run counts"
    assert summary["resolved_but_run_failed"] == 1
    out = capsys.readouterr().out
    assert "resolved but run FAILED" in out


def test_bench_subprocess_turns_a_timeout_into_a_return_code(  # noqa: N803
    A: Any, tmp_path: Path
) -> None:
    """A wedged child must become a row in the summary, not an exception that
    unwinds the pool."""
    import sys as _sys

    log = tmp_path / "t.log"
    rc, tail = A._bench_subprocess(
        [_sys.executable, "-c", "import time; time.sleep(30)"], timeout_s=1, log_path=log
    )
    assert rc == -9
    assert "timeout" in tail
    assert "TIMEOUT" in log.read_text(encoding="utf-8")


def test_bench_subprocess_leaves_no_orphan_after_a_timeout(  # noqa: N803
    A: Any, tmp_path: Path
) -> None:
    """A timed-out child must be DEAD, not detached.

    ``subprocess.run(timeout=…)`` kills only the direct child; a ``run`` child
    spawns git, pytest and an OpenHands agent, and an orphaned dev run keeps
    calling the model — i.e. keeps spending, unattended. Killing the process
    GROUP is the fix, and this asserts the grandchild dies too.
    """
    import os as _os
    import sys as _sys

    marker = tmp_path / "grandchild.pid"
    script = (
        "import os,subprocess,sys,time;"
        f"p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']);"
        f"open({str(marker)!r},'w').write(str(p.pid));"
        "time.sleep(120)"
    )
    rc, _ = A._bench_subprocess(
        [_sys.executable, "-c", script], timeout_s=3, log_path=tmp_path / "t.log"
    )
    assert rc == -9
    grandchild = int(marker.read_text())
    for _ in range(50):
        try:
            _os.kill(grandchild, 0)
        except OSError:
            break
        __import__("time").sleep(0.1)
    else:
        _os.kill(grandchild, 9)
        pytest.fail(f"grandchild {grandchild} survived the timeout — orphaned spend")


def test_abort_all_kills_running_children(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """``abort_all`` is what makes Ctrl-C actually stop the spend."""
    import sys as _sys
    import threading as _threading
    import time as _time

    result: list[tuple[int, str]] = []

    def _worker() -> None:
        result.append(
            A._bench_subprocess(
                [_sys.executable, "-c", "import time; time.sleep(120)"],
                timeout_s=300,
                log_path=tmp_path / "a.log",
            )
        )

    t = _threading.Thread(target=_worker)
    t.start()
    try:
        for _ in range(50):  # wait for the child to register as live
            if A._LIVE_CHILDREN:
                break
            _time.sleep(0.1)
        assert A._LIVE_CHILDREN, "child never registered; abort could not reach it"
        started = _time.monotonic()
        assert A.abort_all() == 1
        t.join(timeout=30)
        assert not t.is_alive()
        assert _time.monotonic() - started < 30, "abort did not actually stop the child"
        assert A._ABORT.is_set()
        # A queued instance must not start once abort is set.
        assert A._bench_subprocess(["/bin/true"], timeout_s=5, log_path=tmp_path / "b.log") == (
            -2,
            "aborted before start",
        )
    finally:
        A._ABORT.clear()
        t.join(timeout=5)
    assert result and result[0][0] != 0


def test_child_spawned_during_abort_race_is_killed_not_awaited(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TOCTOU: ``abort_all`` snapshots the live set ONCE. A child spawned
    between the pre-spawn abort check and its registration is invisible to
    that snapshot — the supervisor must re-check after registering and kill
    the child itself, or it sits in ``communicate()`` for the child's whole
    lifetime while the child keeps spending."""
    import os as _os
    import subprocess as _sp
    import sys as _sys
    import time as _time

    spawned_pids: list[int] = []
    real_popen = _sp.Popen

    def _racing_popen(*args: Any, **kw: Any) -> Any:
        proc = real_popen(*args, **kw)
        spawned_pids.append(proc.pid)
        A._ABORT.set()  # the abort lands exactly in the un-registered window
        return proc

    monkeypatch.setattr(A.subprocess, "Popen", _racing_popen)
    try:
        started = _time.monotonic()
        rc, tail = A._bench_subprocess(
            [_sys.executable, "-c", "import time; time.sleep(120)"],
            timeout_s=300,
            log_path=tmp_path / "race.log",
        )
    finally:
        A._ABORT.clear()
    assert rc == -2 and "aborted" in tail
    assert _time.monotonic() - started < 60, "supervisor sat in communicate() past the abort"
    assert not A._LIVE_CHILDREN
    # The child itself must be DEAD, not merely unwatched.
    assert spawned_pids
    for _ in range(50):
        try:
            _os.kill(spawned_pids[0], 0)
        except OSError:
            break
        _time.sleep(0.1)
    else:
        _os.kill(spawned_pids[0], 9)
        pytest.fail(f"child {spawned_pids[0]} survived the abort race — orphaned spend")


def test_interrupt_writes_a_partial_summary_and_stops(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Ctrl-C mid-sweep: kill the children, keep what finished, do not raise."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    killed: list[int] = []
    monkeypatch.setattr(A, "abort_all", lambda: (killed.append(1), 2)[1])

    fake = _FakeChild(A)
    real_call = fake.__call__

    def _interrupting(argv: list[str], **kw: Any) -> tuple[int, str]:
        if argv[argv.index("--instance") + 1] == _IDS[2] and argv[2] == "run":
            raise KeyboardInterrupt
        return real_call(argv, **kw)

    monkeypatch.setattr(A, "_bench_subprocess", _interrupting)

    A.run_all(  # must NOT propagate
        arm="factory", workers=1, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )

    assert killed, "the interrupt handler did not abort in-flight children"
    out = capsys.readouterr().out
    assert "INTERRUPTED" in out
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    # The two that completed before the interrupt are kept, not thrown away.
    # (>= not ==: the worker may have already dequeued the NEXT instance when
    # the interrupt lands, and abort_all is a no-op fake here, so that row can
    # legitimately finish during shutdown — and the drain must then keep it
    # rather than silently dropping a completed row and its spend.)
    assert summary["ok"] >= 2
    assert len(summary["results"]) == len(_IDS), "every instance must appear in the summary"
    assert any(r["status"] == "aborted" for r in summary["results"])


def test_interrupt_collects_in_flight_results_and_their_spend(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An in-flight row that finishes during executor shutdown must land in
    the summary WITH its spend. The old handler only blank-recorded cancelled
    futures, so a row that was running when Ctrl-C hit — and its real dollars
    — silently vanished from the partial summary."""
    import threading as _threading

    _sweep_env(A, tmp_path, monkeypatch, _IDS[:4])
    gate = _threading.Event()
    fake = _FakeChild(A)
    real_call = fake.__call__

    def _wrapped(argv: list[str], **kw: Any) -> tuple[int, str]:
        iid = argv[argv.index("--instance") + 1]
        if argv[2] == "run" and iid == _IDS[0]:
            # in flight until "abort" releases it (as a real abort would kill
            # its child and return promptly)
            assert gate.wait(timeout=30), "abort never released the in-flight child"
        if argv[2] == "run" and iid == _IDS[1]:
            raise KeyboardInterrupt
        return real_call(argv, **kw)

    monkeypatch.setattr(A, "_bench_subprocess", _wrapped)
    monkeypatch.setattr(A, "abort_all", lambda: (gate.set(), 1)[1])

    A.run_all(  # must NOT propagate
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )

    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    by_id = {r["instance_id"]: r for r in summary["results"]}
    assert len(summary["results"]) == 4, "every row must appear, collected or not"
    # THE fix: the in-flight row finished during shutdown and was drained
    # into the summary, spend included.
    assert by_id[_IDS[0]]["status"] == "ok"
    assert by_id[_IDS[0]]["cost_usd"] == 0.5
    assert summary["cost_usd"] >= 0.5
    # The row whose worker raised is present too, not silently dropped.
    assert by_id[_IDS[1]]["status"] == "aborted"
    assert "KeyboardInterrupt" in by_id[_IDS[1]]["error"]


def test_bench_subprocess_survives_an_unspawnable_command(A: Any, tmp_path: Path) -> None:  # noqa: N803
    rc, tail = A._bench_subprocess(
        ["/nonexistent/binary/xyzzy"], timeout_s=5, log_path=tmp_path / "s.log"
    )
    assert rc == -1
    assert "Error" in tail or "error" in tail


# --------------------------------------------------------------------------- #
# the spend guard
# --------------------------------------------------------------------------- #


def test_caps_come_from_factory_settings(A: Any, tmp_path: Path) -> None:  # noqa: N803
    p = tmp_path / "factory_settings.yaml"
    p.write_text("caps:\n  hourly_spend_usd: 40\n  daily_spend_usd: 300\n", encoding="utf-8")
    assert A.load_spend_caps(p) == (40.0, 300.0)


def test_unreadable_settings_fall_back_to_the_TIGHT_caps(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """Fail SAFE. A guard that cannot read its limits must assume the strict
    ones — treating a missing file as "no cap" is how an unattended sweep
    spends four figures."""
    assert A.load_spend_caps(tmp_path / "absent.yaml") == (2.0, 10.0)
    bad = tmp_path / "broken.yaml"
    bad.write_text("caps: [this is not a mapping\n", encoding="utf-8")
    assert A.load_spend_caps(bad) == (2.0, 10.0)


def test_a_small_sweep_is_allowed(A: Any) -> None:  # noqa: N803
    """6 instances at $3 is $18 total: it cannot breach a $40/h cap however
    many workers run it, because the whole sweep costs less than the cap."""
    total, peak, refusal = A.spend_guard(
        n_instances=6, workers=4, usd_per_instance=3.0, hours_per_instance=0.05,
        hourly_cap=40.0, daily_cap=300.0,
    )
    assert refusal is None
    assert total == 18.0 and peak == 18.0


def test_a_big_parallel_sweep_is_refused_on_the_hourly_cap(A: Any) -> None:  # noqa: N803
    total, peak, refusal = A.spend_guard(
        n_instances=100, workers=4, usd_per_instance=3.0, hours_per_instance=0.05,
        hourly_cap=40.0, daily_cap=1000.0,
    )
    assert refusal is not None
    assert "hourly_spend_usd" in refusal
    assert peak > 40.0 and total == 300.0


def test_the_daily_cap_is_checked_too(A: Any) -> None:  # noqa: N803
    _, _, refusal = A.spend_guard(
        n_instances=100, workers=1, usd_per_instance=3.0, hours_per_instance=0.05,
        hourly_cap=10_000.0, daily_cap=250.0,
    )
    assert refusal is not None and "daily_spend_usd" in refusal


def test_refusal_says_when_fewer_workers_would_not_help(A: Any) -> None:  # noqa: N803
    """An instance costing $60/h all by itself is not a parallelism problem.
    Advising "--workers 0" would be nonsense; say the true thing instead."""
    _, _, refusal = A.spend_guard(
        n_instances=100, workers=8, usd_per_instance=3.0, hours_per_instance=0.05,
        hourly_cap=40.0, daily_cap=1000.0,
    )
    assert refusal is not None
    assert "even ONE worker" in refusal
    assert "--workers 0" not in refusal


def test_refusal_suggests_a_worker_count_that_fits(A: Any) -> None:  # noqa: N803
    _, _, refusal = A.spend_guard(
        n_instances=100, workers=16, usd_per_instance=1.0, hours_per_instance=0.25,
        hourly_cap=12.0, daily_cap=1000.0,
    )
    assert refusal is not None and "--workers 3" in refusal


def test_sweep_refuses_to_start_over_cap_and_spends_nothing(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The refusal must happen BEFORE the pool starts. A guard that fires after
    the first worker has already burned $3 is not a guard."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    monkeypatch.setattr(A, "load_spend_caps", lambda *a, **k: (0.5, 1.0))
    fake = _FakeChild(A)
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    with pytest.raises(SystemExit, match="REFUSING TO START"):
        A.run_all(
            arm="factory", workers=4, instances=None, only_working=False,
            max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        )
    assert fake.calls == [], "the guard let work start before refusing"


def test_force_over_cap_is_explicit_and_loud(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Exceeding a cap is allowed only by a deliberate flag, and never quietly."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS[:2])
    monkeypatch.setattr(A, "load_spend_caps", lambda *a, **k: (0.5, 1.0))
    monkeypatch.setattr(A, "_bench_subprocess", _FakeChild(A))
    A.run_all(
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=True,
    )
    out = capsys.readouterr().out
    assert "WARNING" in out and "proceeding over cap" in out


def test_cost_estimate_prefers_measured_runs_and_errs_high(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Gate on the real artifact: use what prior runs actually cost. Take the
    MAX cost and the MIN duration, because both push the projected burn rate
    up, which is the fail-safe direction for a guard that refuses."""
    runs = tmp_path / "runs"
    for n, (cost, wall) in enumerate([(1.0, 600.0), (4.0, 120.0)]):
        d = runs / f"inst{n}" / "factory"
        d.mkdir(parents=True)
        (d / "result.json").write_text(
            json.dumps({"cost_usd": cost, "wall_clock_s": wall}), encoding="utf-8"
        )
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    usd, hours, source = A.estimate_instance_cost("factory")
    assert usd == 4.0
    assert hours == pytest.approx(120.0 / 3600.0)
    assert "measured" in source

    # No prior runs for this arm -> the documented conservative default.
    usd, hours, source = A.estimate_instance_cost("bare")
    assert usd == A._DEFAULT_COST_USD["bare"]
    assert "default" in source


def test_cost_estimate_ignores_failed_runs_and_floors_a_single_sample(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Guard poisoning: a run that died after one $0.05 call must not become
    the 'measured' per-instance estimate (that once projected a 100-instance
    sweep at $5.00; real cost ~$300). Failed runs (recorded ``error``) are not
    samples, and a single clean sample never LOWERS the estimate below the
    documented default."""
    runs = tmp_path / "runs"
    # Two failed runs with tiny partial spend — must be ignored entirely.
    for n, cost in enumerate([0.05, 0.02]):
        d = runs / f"dead{n}" / "factory"
        d.mkdir(parents=True)
        (d / "result.json").write_text(
            json.dumps(
                {"cost_usd": cost, "wall_clock_s": 3.0, "error": "wall-clock cap 1s hit"}
            ),
            encoding="utf-8",
        )
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    usd, hours, source = A.estimate_instance_cost("factory")
    assert usd == A._DEFAULT_COST_USD["factory"], "failed runs poisoned the estimate"
    assert "default" in source

    # ONE clean-but-cheap run: an anecdote — floored at the default.
    d = runs / "clean0" / "factory"
    d.mkdir(parents=True)
    (d / "result.json").write_text(
        json.dumps({"cost_usd": 0.40, "wall_clock_s": 120.0, "error": None}),
        encoding="utf-8",
    )
    usd, hours, source = A.estimate_instance_cost("factory")
    assert usd == A._DEFAULT_COST_USD["factory"]
    assert "floored" in source

    # TWO clean runs: the measured max stands on its own.
    d = runs / "clean1" / "factory"
    d.mkdir(parents=True)
    (d / "result.json").write_text(
        json.dumps({"cost_usd": 0.60, "wall_clock_s": 100.0, "error": None}),
        encoding="utf-8",
    )
    usd, hours, source = A.estimate_instance_cost("factory")
    assert usd == 0.60
    assert "2 clean prior" in source


def test_mid_sweep_actual_spend_breach_stops_new_children(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The start-of-sweep guard is a projection and projections can be wrong.
    Actual accumulated cost_usd is enforced after every completed row: on
    breach no NEW children start (in-flight ones finish — the documented
    residual window), the summary records stopped_reason, and the sweep exits
    non-zero."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    # Projection passes (tiny estimate), reality breaches (each row costs $0.5
    # against a $1.20 daily cap -> stop after the 3rd completed row).
    monkeypatch.setattr(A, "estimate_instance_cost", lambda *a, **k: (0.01, 0.05, "test"))
    monkeypatch.setattr(A, "load_spend_caps", lambda *a, **k: (1000.0, 1.2))
    fake = _FakeChild(A)
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    with pytest.raises(SystemExit, match="spend cap"):
        A.run_all(
            arm="factory", workers=1, instances=None, only_working=False,
            max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        )
    summary = json.loads((tmp_path / "sweep-factory.json").read_text(encoding="utf-8"))
    assert str(summary["stopped_reason"]).startswith("spend cap")
    assert len(summary["results"]) == len(_IDS), "every row accounted, run or not"
    ran = {c[c.index("--instance") + 1] for c in fake.calls if c[2] == "run"}
    # 3 rows breach the cap; at most one more was already in flight (the
    # residual window is bounded by the worker count, here 1).
    assert 3 <= len(ran) <= 4, f"children kept launching after the breach: {sorted(ran)}"
    aborted = [r for r in summary["results"] if r["status"] == "aborted"]
    assert len(aborted) >= 2
    assert any("spend cap" in str(r["error"]) for r in aborted)
    out = capsys.readouterr().out
    assert "SPEND CAP" in out and "STOPPED EARLY" in out


def test_operator_notices_key_off_actual_spend_not_projection(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """$50/$75/$100 notices fire as REAL accumulated spend crosses each
    threshold — a poisoned projection must not silence them."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    monkeypatch.setattr(A, "estimate_instance_cost", lambda *a, **k: (0.01, 0.05, "test"))
    fake = _FakeChild(A, cost=30.0)  # 6 rows x $30 = $180 actual
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    A.run_all(
        arm="factory", workers=2, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
    )
    out = capsys.readouterr().out
    for threshold in (50, 75, 100):
        hits = [
            ln
            for ln in out.splitlines()
            if "accumulated sweep spend" in ln and f"${threshold} operator" in ln
        ]
        assert len(hits) == 1, f"threshold ${threshold}: expected exactly one notice, got {hits}"


# --------------------------------------------------------------------------- #
# readable interleaved output
# --------------------------------------------------------------------------- #


def test_progress_lines_never_interleave_partially(A: Any) -> None:  # noqa: N803
    """Workers finish concurrently, so the ONLY guarantee that matters is that
    a line is written whole. Assert it at the write layer: every ``_emit`` must
    reach stdout as a single ``write`` call."""
    import threading as _threading

    writes: list[str] = []

    class _Spy:
        def write(self, s: str) -> int:
            writes.append(s)
            return len(s)

        def flush(self) -> None:
            pass

    import sys as _sys

    real, _sys.stdout = _sys.stdout, _Spy()  # type: ignore[assignment]
    try:
        threads = [
            _threading.Thread(target=A._emit, args=(f"line-{i}" * 20,)) for i in range(40)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        _sys.stdout = real
    assert len(writes) == 40, "a line was split across multiple writes"
    assert all(w.endswith("\n") and w.count("\n") == 1 for w in writes)


def test_progress_line_reports_the_four_required_fields(A: Any) -> None:  # noqa: N803
    line = A._progress_line(
        3,
        6,
        {
            "instance_id": "instance_qutebrowser__qutebrowser-0833b5f6",
            "status": "ok",
            "final_state": "reviewer_done",
            "tokens_in": 560580,
            "tokens_out": 4998,
            "oracle_resolved": True,
            "outcome": "resolved",
            "sweep_wall_s": 102.7,
        },
    )
    assert "\n" not in line
    assert "instance_qutebrowser__qutebrowser-0833b5f6" in line
    assert "reviewer_done" in line
    assert "560,580" in line and "4,998" in line
    assert "PASS" in line and "resolved" in line
    assert "[  3/6" in line


def test_cli_wires_run_all_through(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """Guards against argparse drift — a flag that parses but reaches nothing."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "run_all", lambda **kw: seen.update(kw))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "swebench_adapter.py", "run-all", "--arm", "bare", "--workers", "7",
            "--instances", "a, b ,", "--only-working", "--force-over-cap",
            "--timeout-s", "11", "--grade-timeout-s", "12", "--max-steps", "3",
            "--dry-run",
        ],
    )
    A.main()
    assert seen == {
        "arm": "bare",
        "model": None,
        "workers": 7,
        "instances": ["a", "b"],
        "only_working": True,
        "max_steps": 3,
        "run_timeout_s": 11,
        "grade_timeout_s": 12,
        "force_over_cap": True,
        "dry_run": True,
    }


def test_cli_run_all_defaults_are_safe(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """Never over-cap by default, and never invent an instance list."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(A, "run_all", lambda **kw: seen.update(kw))
    monkeypatch.setattr(sys, "argv", ["swebench_adapter.py", "run-all"])
    A.main()
    assert seen["force_over_cap"] is False
    assert seen["only_working"] is False
    assert seen["instances"] is None
    assert seen["arm"] == "factory"
    assert seen["dry_run"] is False


# --------------------------------------------------------------------------- #
# --dry-run must be a PURE preview
# --------------------------------------------------------------------------- #


def test_dry_run_spawns_nothing_and_writes_nothing(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """This repo has been bitten by a "dry-run" that did real work (pm-sync,
    2026-07-20 — it spawned live dispatchable stories). Assert the absence of
    side effects, not just the presence of output."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    fake = _FakeChild(A)
    monkeypatch.setattr(A, "_bench_subprocess", fake)
    before = sorted(p.name for p in tmp_path.iterdir())

    A.run_all(
        arm="factory", workers=3, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        dry_run=True,
    )

    assert fake.calls == []
    assert sorted(p.name for p in tmp_path.iterdir()) == before, "dry-run wrote to disk"
    assert not (tmp_path / "runs").exists(), "dry-run created run directories"
    assert not (tmp_path / "sweep-factory.json").exists()
    out = capsys.readouterr().out
    assert "nothing was executed and nothing was written" in out
    for iid in _IDS:
        assert iid in out


def test_dry_run_previews_a_refusal_instead_of_raising(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """You must be able to preview a sweep that would be refused — that is
    exactly when you most want to see the numbers."""
    _sweep_env(A, tmp_path, monkeypatch, _IDS)
    monkeypatch.setattr(A, "load_spend_caps", lambda *a, **k: (0.5, 1.0))
    monkeypatch.setattr(A, "_bench_subprocess", _FakeChild(A))
    A.run_all(
        arm="factory", workers=4, instances=None, only_working=False,
        max_steps=1, run_timeout_s=10, grade_timeout_s=10, force_over_cap=False,
        dry_run=True,
    )
    out = capsys.readouterr().out
    assert "WOULD REFUSE TO START" in out


def test_progress_line_surfaces_a_failure(A: Any) -> None:  # noqa: N803
    line = A._progress_line(
        1,
        2,
        {
            "instance_id": "instance_x",
            "status": "run_failed",
            "error": "image unavailable",
            "final_state": "—",
            "tokens_in": 0,
            "tokens_out": 0,
            "oracle_resolved": None,
            "outcome": "—",
            "sweep_wall_s": 1.0,
        },
    )
    assert "!run_failed" in line and "image unavailable" in line
    assert "\n" not in line


# --------------------------------------------------------------------------- #
# report() must respect the audit gate
# --------------------------------------------------------------------------- #


_TEST_MANIFEST_SHA = "test-manifest-sha"


def _report_run(
    runs: Path,
    iid: str,
    *,
    resolved: bool,
    audit: bool | None,
    error: str | None = None,
    with_diff: bool = True,
    manifest_sha: str = _TEST_MANIFEST_SHA,
) -> None:
    """One (instance, factory) run dir with a result.json and optional audit.json."""
    d = runs / iid / "factory"
    d.mkdir(parents=True)
    if with_diff:
        (d / "prediction.diff").write_text(
            f"diff --git a/{iid}.py b/{iid}.py\n+# fake\n", encoding="utf-8"
        )
    (d / "result.json").write_text(
        json.dumps(
            {
                "arm": "factory",
                "instance_id": iid,
                "manifest_sha256": manifest_sha,
                "factory_says_green": resolved,
                "error": error,
                "tokens_in": 1000,
                "tokens_out": 100,
                "wall_clock_s": 60.0,
                "grade": {
                    "oracle_resolved": resolved,
                    "outcome": "resolved" if resolved else "wrong_place",
                },
            }
        ),
        encoding="utf-8",
    )
    if audit is not None:
        (d / "audit.json").write_text(
            json.dumps({"ok": audit, "failures": [] if audit else ["cost mismatch"]}),
            encoding="utf-8",
        )


def test_report_headline_counts_only_audited_valid_rows(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """An oracle-PASS row whose audit failed or whose run failed must be
    EXCLUDED from the headline resolve rate and named loudly. A row that was
    never audited at all is REFUSED outright (missing audit.json — see the
    fail-closed tests below). report() used to count grade.oracle_resolved
    alone, which laundered invalid rows into results.md."""
    runs = tmp_path / "runs"
    _report_run(runs, "inst_valid_pass", resolved=True, audit=True)
    _report_run(runs, "inst_valid_fail", resolved=False, audit=True)
    _report_run(runs, "inst_audit_failed_pass", resolved=True, audit=False)
    _report_run(
        runs, "inst_run_failed_pass", resolved=True, audit=True,
        error="dev: RuntimeError: boom",
    )
    _patch_report_dirs(A, tmp_path, monkeypatch)

    A.report()

    md = (tmp_path / "results.md").read_text(encoding="utf-8")
    # Headline: 1 resolved of 2 audited-valid (valid_pass + valid_fail); the
    # two other oracle passes are excluded, each with its reason.
    assert "resolve rate: **1/2 = 50% audited-valid**" in md
    assert "2 row(s) EXCLUDED" in md
    assert "inst_audit_failed_pass [PASS]: audit failed" in md
    assert "inst_run_failed_pass [PASS]: run failed" in md
    assert "audit gate: **2 audited-valid** of 4 gradable" in md
    # The per-row table carries the audit column.
    assert "| audit |" in md
    assert "| FAIL |" in md  # the audit-failed row
    capsys.readouterr()  # silence report()'s stdout echo


# --------------------------------------------------------------------------- #
# report — artifact-backed evidence (PLAN 1.5)
# --------------------------------------------------------------------------- #


def _patch_report_dirs(A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:  # noqa: N803
    runs = tmp_path / "runs"
    monkeypatch.setattr(A, "RUNS_DIR", runs)
    monkeypatch.setattr(A, "SWE_DIR", tmp_path)
    monkeypatch.setattr(A, "RESULTS_ARCHIVE_DIR", tmp_path / "results-archive")
    # A live report is pinned to the live manifest's sha; give the fixture
    # rows a matching manifest to run under.
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {"profile": "swebench-pro", "manifest_sha256": _TEST_MANIFEST_SHA, "instances": []}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", manifest)
    return runs


def test_report_archives_every_consumed_artifact(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A live report() must snapshot result.json + audit.json + prediction.diff
    per row into a dated results-archive dir, byte-for-byte. Publishing a
    number without archiving its evidence is the July retraction class."""
    runs = _patch_report_dirs(A, tmp_path, monkeypatch)
    _report_run(runs, "inst_a", resolved=True, audit=True)
    _report_run(runs, "inst_b", resolved=False, audit=True)

    A.report()
    capsys.readouterr()

    archives = list((tmp_path / "results-archive").iterdir())
    assert len(archives) == 1, "exactly one dated archive dir per report run"
    archive = archives[0]
    for iid in ("inst_a", "inst_b"):
        for name in ("result.json", "audit.json", "prediction.diff"):
            src = runs / iid / "factory" / name
            dst = archive / iid / "factory" / name
            assert dst.is_file(), f"{name} not archived for {iid}"
            assert dst.read_bytes() == src.read_bytes()
    # The rendered table and the meta travel with the evidence.
    assert (archive / "results.md").read_text(encoding="utf-8") == (
        tmp_path / "results.md"
    ).read_text(encoding="utf-8")
    meta = json.loads((archive / "report-meta.json").read_text(encoding="utf-8"))
    assert meta["rows"] == 2
    assert meta["generated_at"]


def test_report_refuses_row_with_missing_artifacts(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """FAIL-CLOSED: a row without its backing artifacts is refused BY NAME —
    not silently dropped, not emitted as a table row, not archived."""
    runs = _patch_report_dirs(A, tmp_path, monkeypatch)
    _report_run(runs, "inst_complete", resolved=True, audit=True)
    _report_run(runs, "inst_no_audit", resolved=True, audit=None)
    _report_run(runs, "inst_no_diff", resolved=True, audit=True, with_diff=False)

    A.report()
    capsys.readouterr()

    md = (tmp_path / "results.md").read_text(encoding="utf-8")
    assert "## Refused rows (fail-closed: backing artifacts missing)" in md
    assert "`inst_no_audit/factory` — missing artifact(s): audit.json" in md
    assert "`inst_no_diff/factory` — missing artifact(s): prediction.diff" in md
    # Refused rows are not table rows and count in no rate.
    assert "| inst_no_audit |" not in md
    assert "| inst_no_diff |" not in md
    assert "resolve rate: **1/1 = 100% audited-valid**" in md
    # And their partial evidence is not archived.
    archive = next((tmp_path / "results-archive").iterdir())
    assert (archive / "inst_complete").is_dir()
    assert not (archive / "inst_no_audit").exists()
    assert not (archive / "inst_no_diff").exists()


def test_report_refuses_everything_rather_than_an_empty_table(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every row refused -> SystemExit naming each refusal, no results.md."""
    runs = _patch_report_dirs(A, tmp_path, monkeypatch)
    _report_run(runs, "inst_only", resolved=True, audit=None)

    with pytest.raises(SystemExit, match="fail-closed"):
        A.report()
    assert not (tmp_path / "results.md").exists()


def test_report_from_archive_rederives_the_table_byte_for_byte(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """report --from-archive re-derives the committed table purely from the
    archive — no live runs dir, no new archive, identical bytes, AND NO WRITE."""
    import shutil as _shutil

    runs = _patch_report_dirs(A, tmp_path, monkeypatch)
    _report_run(runs, "inst_a", resolved=True, audit=True)
    _report_run(runs, "inst_b", resolved=False, audit=True)

    live_text = A.report()
    capsys.readouterr()
    archive = next((tmp_path / "results-archive").iterdir())

    # The next sweep wipes runs/ — exactly the scenario that destroyed the
    # 1.3 evidence. The archive must be sufficient on its own.
    _shutil.rmtree(runs)

    rederived = A.report(from_archive=archive)
    capsys.readouterr()

    assert rederived == live_text
    # AND it must not have touched the file it is verifying.
    assert (tmp_path / "results.md").read_text(encoding="utf-8") == live_text
    # Re-deriving must not mint a second archive.
    assert len(list((tmp_path / "results-archive").iterdir())) == 1


def test_report_from_archive_requires_report_meta(  # noqa: N803
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dir without report-meta.json is not a report archive — refuse."""
    _patch_report_dirs(A, tmp_path, monkeypatch)
    not_an_archive = tmp_path / "random-dir"
    not_an_archive.mkdir()

    with pytest.raises(SystemExit, match="not a report archive"):
        A.report(from_archive=not_an_archive)


# --------------------------------------------------------------------------- #
# dataset profiles — selected at fetch, pinned in the manifest, never mixed
# --------------------------------------------------------------------------- #

_FIXTURES = Path(__file__).parent / "fixtures"


def _rebench_row() -> dict[str, Any]:
    """A REAL row from the live nebius/SWE-rebench-leaderboard rows API
    (fetched 2026-08-02; PASS_TO_PASS truncated to 5 ids for fixture size).
    The mapping is tested against the actual upstream schema, not against
    what a memo said the field names were."""
    return json.loads(
        (_FIXTURES / "swe_rebench_row.json").read_text(encoding="utf-8")
    )


def _rebench_instance(A: Any) -> dict[str, Any]:  # noqa: N803
    return A._row_to_instance(A.PROFILES["swe-rebench"], _rebench_row())


def test_profile_defaults_to_pro_for_pre_profile_artifacts(A: Any) -> None:  # noqa: N803
    """Old manifests and old run dirs carry no profile key. They mean Pro —
    frozen, not dropped."""
    assert A._profile_of({}).name == "swebench-pro"
    assert A._profile_of({"profile": "swe-rebench"}).name == "swe-rebench"


def test_unknown_profile_is_a_hard_error_not_a_fallback(A: Any) -> None:  # noqa: N803
    """Grading a rebench instance with Pro plumbing (or vice versa) would
    produce a confident wrong number; refuse instead."""
    with pytest.raises(SystemExit, match="unknown dataset profile"):
        A._profile_of({"profile": "swe-bench-ultra"})


def test_fetch_refuses_an_unknown_dataset(A: Any) -> None:  # noqa: N803
    with pytest.raises(SystemExit, match="unknown --dataset"):
        A.fetch(dataset="nope", language="python", limit=1, seed=1, after=None)


def test_fetch_pins_the_profile_in_manifest_and_instances(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Every later command reads the profile back FROM the manifest, so fetch
    must persist it at both levels (instances travel alone through helpers)."""
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(A, "ORACLE_PATH", tmp_path / "oracle.json.z")
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: None)
    monkeypatch.setattr(A, "_all_rows", lambda profile: [_rebench_row()])
    A.fetch(dataset="swe-rebench", language="python", limit=5, seed=1, after=None)
    m = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert m["profile"] == "swe-rebench"
    assert m["dataset"] == "nebius/SWE-rebench-leaderboard"
    assert all(i["profile"] == "swe-rebench" for i in m["instances"])


def test_fetch_filters_to_post_cutoff_instances_by_default(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Contamination control: swe-rebench defaults to created_at > 2026-01-01
    (DeepSeek-V4 Pro's cutoff is undocumented; the stand-in is recorded in the
    manifest so the choice is auditable)."""
    fresh = _rebench_row()                      # created_at 2026-02-19
    stale = dict(_rebench_row(), instance_id="old__one-1", created_at="2025-06-01 00:00:00")
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(A, "ORACLE_PATH", tmp_path / "oracle.json.z")
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: None)
    monkeypatch.setattr(A, "_all_rows", lambda profile: [fresh, stale])
    A.fetch(dataset="swe-rebench", language="python", limit=10, seed=1, after=None)
    m = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert m["created_at_after"] == "2026-01-01"
    ids = [i["instance_id"] for i in m["instances"]]
    assert ids == [fresh["instance_id"]], ids


def test_rebench_row_maps_the_real_upstream_schema(A: Any) -> None:  # noqa: N803
    """Field mapping against the REAL rows-API schema: uppercase
    FAIL_TO_PASS/PASS_TO_PASS (real JSON lists), in-row gold `patch`, verbatim
    `docker_image`, `created_at` present."""
    row = _rebench_row()
    inst = _rebench_instance(A)
    assert inst["profile"] == "swe-rebench"
    assert inst["instance_id"] == row["instance_id"]
    assert inst["base_commit"] == row["base_commit"]
    assert inst["fail_to_pass"] == row["FAIL_TO_PASS"]
    assert inst["pass_to_pass"] == row["PASS_TO_PASS"]
    assert inst["gold_patch"] == row["patch"] and inst["gold_patch"].startswith("diff --git")
    assert inst["docker_image"] == row["docker_image"]
    assert inst["docker_image"].startswith("swerebench/")
    assert inst["created_at"] == row["created_at"]
    assert inst["test_patch"] == row["test_patch"]


def test_rebench_test_targets_are_files_never_node_ids(A: Any) -> None:  # noqa: N803
    """The dev-facing targets are FAIL_TO_PASS reduced to FILE paths at fetch
    time — node ids would leak the hidden oracle's test names AND point at
    tests that only exist after the withheld test patch."""
    inst = _rebench_instance(A)
    assert inst["test_targets"], "expected at least one dev-facing target"
    assert all("::" not in t for t in inst["test_targets"])
    # Derived from fail_to_pass, so they point at the oracle's FILES.
    f2p_files = {t.split("::", 1)[0] for t in inst["fail_to_pass"]}
    assert set(inst["test_targets"]) == f2p_files


def test_rebench_test_command_uses_the_image_verbatim_and_testbed(A: Any) -> None:  # noqa: N803
    """The collect gate and dev's run-until-green both go through this exact
    command: in-row image, mount over /testbed (not Pro's /app), conda env
    activated explicitly (a non-root login shell does not inherit it)."""
    inst = _rebench_instance(A)
    cmd = A.instance_test_command(inst)
    assert inst["docker_image"] in cmd
    assert '-v "$PWD":/testbed' in cmd and "-w /testbed" in cmd
    assert "source /opt/conda/bin/activate testbed" in cmd
    assert "jefzda" not in cmd
    assert "::" not in cmd, "oracle node ids must never reach dev's command"
    # The host-litter guards apply across profiles.
    assert '--user "$(id -u):$(id -g)"' in cmd
    assert "-p no:cacheprovider" in cmd
    # And the collect-gate variant keeps the identical environment.
    collect = A.instance_test_command(inst, collect_only=True)
    assert "--collect-only -q" in collect
    assert '-v "$PWD":/testbed' in collect
    assert "source /opt/conda/bin/activate testbed" in collect


def test_rebench_precheck_collects_the_pinned_targets(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The pre-dispatch collect gate must work from the rebench manifest shape
    (test_targets), same modes as Pro."""
    inst = _rebench_instance(A)
    target = inst["test_targets"][0]
    p = tmp_path / target
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("def test_x():\n    pass\n", encoding="utf-8")
    seen = _fake_collect(monkeypatch, A, 0, "1 test collected")
    pre = A._precheck_collect(inst, tmp_path)
    assert pre["collect_ok"] is True
    assert pre["mode"] == "existing-targets"
    assert pre["collected_targets"] == [target]
    assert inst["docker_image"] in seen["cmd"]
    assert "/testbed" in seen["cmd"]


def test_rebench_grade_script_gets_testbed_and_conda(A: Any) -> None:  # noqa: N803
    """grade and selftest share _grade_script_for, so the control validates
    exactly the script the measurement uses — per profile."""
    inst = _rebench_instance(A)
    script = A._grade_script_for(inst, "diff --git a/x.py b/x.py\n")
    assert "cd /testbed" in script
    assert "source /opt/conda/bin/activate testbed" in script
    assert "cd /app 2>" not in script
    for f2p_id in inst["fail_to_pass"]:
        assert f2p_id in script  # the hidden oracle runs the real node ids


def test_rebench_oracle_setup_applies_the_test_patch_unconditionally(A: Any) -> None:  # noqa: N803
    """The nicegui-5858 false-BROKEN_ALREADY_GREEN class: when the f2p test
    NAMES exist at base_commit with old assertions, a collect-gated fallback
    never installs the updated oracle and the old tests pass. swe-rebench has
    no before_repo_set_cmd, so the test patch must be applied always; Pro
    keeps the fallback (its before_cmd already installs the oracle files and
    the patch would conflict)."""
    rebench_script = A._grade_script_for(_rebench_instance(A), "diff --git a/x b/x\n")
    assert "SWEBENCH_SETUP: test_patch applied" in rebench_script
    assert "applying test_patch as fallback" not in rebench_script
    assert "SWEBENCH_SETUP: before_repo_set_cmd" not in rebench_script

    pro_inst = _pro_manifest()["instances"][0]
    pro_script = A._grade_script_for(pro_inst, "diff --git a/x b/x\n")
    assert "applying test_patch as fallback" in pro_script
    assert "SWEBENCH_SETUP: before_repo_set_cmd rc=$?" in pro_script


def test_truncated_param_ids_are_repaired_to_whole_functions(A: Any) -> None:  # noqa: N803
    """SWE-rebench's log parser splits ids on whitespace, so a parametrized id
    with a space in its parameter arrives with an UNCLOSED bracket and can
    never match (real shapes from getmoto__moto-9841 / conan-19735). Repair
    selects the whole function — a strict superset, fail-safe."""
    assert A._repair_truncated_param_ids(
        [
            "tests/test_kms/test_kms.py::test_sign_happy[some",
            "tests/test_kms/test_kms.py::test_verify_happy[some",
            "tests/test_kms/test_kms.py::test_create_key",
            "x.py::test_ok[a-b]",  # well-formed parametrized id: untouched
        ]
    ) == [
        "tests/test_kms/test_kms.py::test_sign_happy",
        "tests/test_kms/test_kms.py::test_verify_happy",
        "tests/test_kms/test_kms.py::test_create_key",
        "x.py::test_ok[a-b]",
    ]
    # Collapsed params dedupe; order preserved.
    assert A._repair_truncated_param_ids(
        ["t.py::f[a", "t.py::f[b", "t.py::g"]
    ) == ["t.py::f", "t.py::g"]
    assert A._repair_truncated_param_ids([]) == []


def test_grade_script_treats_pre_patch_no_collect_as_red_not_broken(A: Any) -> None:  # noqa: N803
    """The pandas-63945 TDD class: the oracle test module import-errors until
    the fix lands. Pre-patch no-collect is a red baseline (official SWE-bench
    semantics); the broken-instance signal is POST-patch no-collect, which
    only the gold patch (selftest) can decide."""
    script = A._grade_script_for(_rebench_instance(A), "diff --git a/x b/x\n")
    assert "NO_COLLECT_PRE_PATCH" in script
    assert "treated as a red baseline" in script
    assert (
        "SWEBENCH_POST_PATCH_${_N}: FAIL_TO_PASS_IDS_DO_NOT_COLLECT"
        in script
    )
    # The hard pre-patch exit is Pro-only; the rebench script never emits it.
    assert "SWEBENCH_BASELINE_${_N}: BROKEN_NO_COLLECT" not in script


def test_gold_patch_comes_from_the_row_with_no_network(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The Pro HF-lookup was a rate-limit failure mode under parallel sweeps;
    for swe-rebench the gold patch is pinned in the manifest and the lookup
    path must never fire."""
    inst = _rebench_instance(A)
    m = tmp_path / "manifest.json"
    m.write_text(
        json.dumps({"profile": "swe-rebench", "manifest_sha256": "x", "instances": [inst]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", m)

    def _no_network(*a: Any, **k: Any) -> dict[str, str]:
        raise AssertionError("HF gold-patch lookup must not fire for swe-rebench")

    monkeypatch.setattr(A, "_gold_patches", _no_network)
    files = A.gold_touched_files(inst["instance_id"])
    assert files, "gold patch from the row must yield touched files"
    assert all(not A.is_test_path(f) for f in files)


def test_pro_gold_patch_still_falls_back_to_the_lookup(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    m = tmp_path / "manifest.json"
    m.write_text(
        json.dumps(
            {"manifest_sha256": "x", "instances": [{"instance_id": "pro-1"}]}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", m)
    seen: dict[str, Any] = {}

    def _lookup(wanted: set[str], profile: Any) -> dict[str, str]:
        seen["wanted"], seen["profile"] = wanted, profile.name
        return {"pro-1": "diff --git a/src/x.py b/src/x.py\n"}

    monkeypatch.setattr(A, "_gold_patches", _lookup)
    assert A.gold_touched_files("pro-1") == ["src/x.py"]
    assert seen == {"wanted": {"pro-1"}, "profile": "swebench-pro"}


# --------------------------------------------------------------------------- #
# Pro regression — frozen means old artifacts keep working, verbatim
# --------------------------------------------------------------------------- #


def _pro_manifest() -> dict[str, Any]:
    """A verbatim pre-profile Pro manifest (one real pinned instance), taken
    from the committed manifest the 2026-08-02 runs used."""
    return json.loads(
        (_FIXTURES / "swebench_pro_manifest.json").read_text(encoding="utf-8")
    )


def test_old_pro_manifest_loads_and_resolves_pro_plumbing(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    m = tmp_path / "manifest.json"
    m.write_text(json.dumps(_pro_manifest()), encoding="utf-8")
    monkeypatch.setattr(A, "MANIFEST_PATH", m)
    manifest = A._manifest()
    assert A._profile_of(manifest).name == "swebench-pro"
    inst = manifest["instances"][0]
    assert A._instance(inst["instance_id"]) == inst
    image = A._image_for(inst)
    assert image == f"jefzda/sweap-images:{inst['dockerhub_tag']}"
    cmd = A.instance_test_command(inst)
    assert '-v "$PWD":/app' in cmd and "-w /app" in cmd
    assert image in cmd
    assert "conda" not in cmd
    script = A._grade_script_for(inst, "diff --git a/x.py b/x.py\n")
    assert "cd /app" in script
    assert inst["before_repo_set_cmd"].strip().splitlines()[0] in script


def test_image_resolution_fails_loudly_with_neither_source(A: Any) -> None:  # noqa: N803
    with pytest.raises(SystemExit, match="neither docker_image nor"):
        A._image_for({"instance_id": "x", "profile": "swe-rebench"})


def test_declared_test_entries_reads_both_manifest_shapes(A: Any) -> None:  # noqa: N803
    assert A._declared_test_entries(
        {"test_targets": ["tests/a.py", "tests/b.py"]}
    ) == ["tests/a.py", "tests/b.py"]
    assert A._declared_test_entries(
        {"selected_test_files_to_run": '["tests/a.py::t1", "tests/a.py::t2"]'}
    ) == ["tests/a.py::t1", "tests/a.py::t2"]
    assert A._declared_test_entries({}) == []


# --------------------------------------------------------------------------- #
# adversarial-review fixes (PR #213): oracle store, report pinning, frozen Pro
# semantics, verdict-channel integrity, image digests, cutoff parsing
# --------------------------------------------------------------------------- #


def test_fetch_keeps_oracle_material_out_of_the_manifest(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 1a: both arms shell around on this host filesystem, so a plaintext
    manifest hands the gold patch to `grep <instance_id>`. Fetch must write
    only digests into the manifest and the material into the compressed
    store; consumers verify the digest and refuse a tampered store."""
    row = _rebench_row()
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(A, "ORACLE_PATH", tmp_path / "oracle.json.z")
    monkeypatch.setattr(A, "_all_rows", lambda profile: [row])
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: f"{image.split(':')[0]}@sha256:{'0' * 64}")
    A.fetch(dataset="swe-rebench", language="python", limit=1, seed=1, after=None)

    manifest_text = (tmp_path / "manifest.json").read_text(encoding="utf-8")
    gold_marker = row["patch"].splitlines()[0]          # "diff --git a/..."
    f2p_id = row["FAIL_TO_PASS"][0].split("::", 1)[1]   # the hidden test NAME
    assert gold_marker not in manifest_text
    assert f2p_id not in manifest_text
    assert row["test_patch"].splitlines()[0] not in manifest_text
    # The store round-trips through the digest-verifying loader.
    inst = json.loads(manifest_text)["instances"][0]
    assert inst["oracle_sha256"]
    oracle = A._oracle_for(inst)
    assert oracle["gold_patch"] == row["patch"]
    assert oracle["test_patch"] == row["test_patch"]
    assert oracle["fail_to_pass"] == row["FAIL_TO_PASS"]
    # Tampering with the store after the pin is a hard refusal, not a grade.
    store = A._load_oracle_store()
    store[inst["instance_id"]]["gold_patch"] = "diff --git a/evil b/evil\n"
    A._write_oracle_store(store)
    with pytest.raises(SystemExit, match="pinned digest"):
        A._oracle_for(inst)


def test_audit_fails_when_the_arm_probed_the_oracle_paths(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 1b (detection layer): any reference to the harness's oracle or
    manifest paths in the arm's own action trail invalidates the run."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, responses=_RESPONSE_ROWS, trajectories=1)
    traj_dir = tmp_path / "inst1" / "factory" / "root" / "state" / "events" / "trajectories"
    (traj_dir / "2-1.ndjson").write_text(
        json.dumps(
            {
                "source": "agent",
                "action": "run",
                "args": {"command": "cat /home/k/software-factory/bench/swebench/oracle.json.z"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("oracle-probe" in f for f in failures), failures
    # An honest trail (no harness-path reference) stays clean — the marker
    # must not fire on the target repo's OWN manifest.json.
    (traj_dir / "2-1.ndjson").write_text(
        json.dumps(
            {"source": "agent", "action": "run",
             "args": {"command": "cat static/manifest.json"}}
        )
        + "\n",
        encoding="utf-8",
    )
    A.audit("inst1", "factory")  # must not raise


def test_bare_arm_without_a_full_command_log_cannot_be_cleared(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 1b: result.json keeps only 20 truncated steps — exactly where a
    probe would hide. A bare run that executed commands but left no
    untruncated bare-commands.ndjson fails the audit (fail safe)."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(
        tmp_path,
        arm="bare",
        rows=[("t0", "dev", "m", None, 100, 10, 0, 2.0, 9.0, 1, None)],
        result={
            "cost_usd": 2.0, "tokens_in": 100, "tokens_out": 10,
            "transcript": [{"step": 0, "action": "bash", "command": "ls", "exit": 0}],
        },
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "bare")
    failures = _audit_json(tmp_path, arm="bare")["failures"]
    assert any("bare-commands.ndjson" in f for f in failures), failures
    # With the full log present (and clean) the same run audits fine.
    (tmp_path / "inst1" / "bare" / "bare-commands.ndjson").write_text(
        json.dumps({"step": 0, "command": "ls"}) + "\n", encoding="utf-8"
    )
    A.audit("inst1", "bare")  # must not raise


def test_report_excludes_rows_from_another_manifest(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]  # noqa: N803
) -> None:
    """FIX 2: runs/ still holding a previous dataset's rows must not blend
    into the new manifest's headline (executed probe: Pro + rebench merged
    into one 100% rate). Foreign rows are named, never counted."""
    runs = _patch_report_dirs(A, tmp_path, monkeypatch)
    _report_run(runs, "inst_current", resolved=True, audit=True)
    _report_run(runs, "inst_old_pro", resolved=True, audit=True, manifest_sha="old-pro-sha")
    d = runs / "inst_no_sha" / "factory"
    _report_run(runs, "inst_no_sha", resolved=True, audit=True, manifest_sha="")
    assert d.exists()

    text = A.report()
    capsys.readouterr()
    assert "inst_current" in text.split("## Excluded rows")[0]
    assert "## Excluded rows (other manifest/profile)" in text
    assert "inst_old_pro" in text.split("## Excluded rows")[1]
    assert "inst_no_sha" in text.split("## Excluded rows")[1]
    # The rates count ONLY the pinned manifest's row.
    assert "resolve rate: **1/1 = 100% audited-valid**" in text
    # And the archive meta records the sha the rows actually ran under.
    archives = list((tmp_path / "results-archive").iterdir())
    meta = json.loads((archives[0] / "report-meta.json").read_text(encoding="utf-8"))
    assert meta["manifest_sha256"] == _TEST_MANIFEST_SHA


def test_pro_grade_script_keeps_frozen_no_collect_semantics(A: Any) -> None:  # noqa: N803
    """FIX 3: Pro is FROZEN — persistent no-collect stays a hard
    BROKEN_NO_COLLECT exit (task_broken, excluded from the denominator),
    exactly as every published Pro archive was labeled. The TDD-red-baseline
    semantics are swe-rebench-only."""
    pro_inst = _pro_manifest()["instances"][0]
    pro_script = A._grade_script_for(pro_inst, "diff --git a/x b/x\n")
    assert "SWEBENCH_BASELINE_${_N}: BROKEN_NO_COLLECT" in pro_script
    assert "exit 3" in pro_script
    assert "NO_COLLECT_PRE_PATCH" not in pro_script
    assert "SWEBENCH_POST_PATCH" not in pro_script

    rebench_script = A._grade_script_for(_rebench_instance(A), "diff --git a/x b/x\n")
    assert "SWEBENCH_BASELINE_${_N}: BROKEN_NO_COLLECT" not in rebench_script
    assert "NO_COLLECT_PRE_PATCH" in rebench_script


def test_verdict_channel_is_not_forgeable_or_swallowable(A: Any) -> None:  # noqa: N803
    """FIX 4: the script must not sit on stdin while arm-authored tests run
    (a stdin-reader ate the verdict echo; a stdin-echoer forged a RESOLVED
    line), and the verdict markers must be nonce-suffixed so no static text
    can ever match the checked string."""
    from types import SimpleNamespace
    seen: dict[str, Any] = {}

    def fake_run(argv: Any, **kw: Any) -> Any:
        seen["argv"], seen["kw"] = argv, kw
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    orig_run = A.subprocess.run
    A.subprocess.run = fake_run
    try:
        A._docker_bash("img:latest", "echo hi", 60, nonce="cafe1234")
    finally:
        A.subprocess.run = orig_run
    argv = seen["argv"]
    # Script travels via stdin, is drained to a file, and executes with
    # stdin re-pointed at /dev/null — never left readable to test code.
    assert "-i" in argv
    launcher = argv[-1]
    assert "cat > /tmp/.swebench_grade.sh" in launcher
    assert "exec bash -l /tmp/.swebench_grade.sh < /dev/null" in launcher
    assert seen["kw"]["input"] == "echo hi"
    assert "SWEBENCH_NONCE=cafe1234" in argv
    # Every verdict marker in the generated script carries the nonce var, and
    # every pytest invocation is cut off from stdin.
    script = A._grade_script_for(_rebench_instance(A), "diff --git a/x b/x\n")
    for name in ("SWEBENCH_RESULT", "SWEBENCH_APPLY", "SWEBENCH_BASELINE"):
        assert f"{name}_${{_N}}:" in script, name
    assert "SWEBENCH_RESULT:" not in script  # no un-nonced verdict marker
    # The nonce arrives as an ENV var and is copied to a shell variable, then
    # unset: pytest (and any arm-authored test code it runs) inherits no nonce,
    # so it cannot read one and print a well-formed marker.
    assert '_N="${SWEBENCH_NONCE}"' in script
    assert "unset SWEBENCH_NONCE" in script
    for line in script.splitlines():
        if "python -m pytest" in line:
            assert "</dev/null" in line.replace("< /dev/null", "</dev/null"), line


def test_fetch_pins_image_digests(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 5: `:latest` tags are mutable upstream — the selftest certifies an
    environment only as of the day it ran. Fetch resolves each image to its
    immutable repo@sha256 digest and every later command pulls by digest."""
    row = _rebench_row()
    repo = row["docker_image"].rsplit(":", 1)[0]
    digest_ref = f"{repo}@sha256:{'a' * 64}"
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(A, "ORACLE_PATH", tmp_path / "oracle.json.z")
    monkeypatch.setattr(A, "_all_rows", lambda profile: [row])
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: digest_ref)
    A.fetch(dataset="swe-rebench", language="python", limit=1, seed=1, after=None)
    inst = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))["instances"][0]
    assert inst["docker_image_digest"] == digest_ref
    assert A._image_for(inst) == digest_ref, "digest must win over the mutable tag"
    # A digest that cannot be resolved keeps the tag (loudly), never fails fetch.
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: None)
    A.fetch(dataset="swe-rebench", language="python", limit=1, seed=1, after=None)
    inst = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))["instances"][0]
    assert inst["docker_image_digest"] is None
    assert A._image_for(inst) == row["docker_image"]


def test_cutoff_excludes_the_cutoff_day_itself(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 6a: created_at was compared as a STRING, so cutoff-day instances
    slipped in ("2026-01-01 00:00:01" > "2026-01-01" is string-true) while
    the docs said "strictly after". Parsed as datetimes, the whole cutoff
    DAY is excluded; unparseable created_at is excluded too (fail safe)."""
    on_cutoff = dict(_rebench_row(), instance_id="on__cutoff-1", created_at="2026-01-01 23:59:59")
    day_after = dict(_rebench_row(), instance_id="day__after-1", created_at="2026-01-02 00:00:00")
    unparseable = dict(_rebench_row(), instance_id="bad__date-1", created_at="not-a-date")
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(A, "ORACLE_PATH", tmp_path / "oracle.json.z")
    monkeypatch.setattr(A, "_all_rows", lambda profile: [on_cutoff, day_after, unparseable])
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: None)
    A.fetch(dataset="swe-rebench", language="python", limit=10, seed=1, after=None)
    m = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert [i["instance_id"] for i in m["instances"]] == ["day__after-1"]
    with pytest.raises(SystemExit, match="YYYY-MM-DD"):
        A._created_after(day_after, "01/02/2026")


def test_fetch_cli_requires_an_explicit_dataset(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """FIX 6b: defaulting --dataset to the FROZEN pro profile pinned the
    wrong dataset silently; the flag is now required."""
    monkeypatch.setattr(
        A.sys, "argv", ["swebench_adapter.py", "fetch", "--seed", "1"]
    )
    with pytest.raises(SystemExit) as exc:
        A.main()
    assert exc.value.code == 2  # argparse usage error, not a fetch attempt


def test_pre_port_archive_rerenders_with_the_pro_heading(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A pre-port archive's report-meta has no profile key: it is Pro by
    definition, and re-deriving it must say so even though the LIVE manifest
    now pins swe-rebench — otherwise old committed tables stop reproducing."""
    _patch_report_dirs(A, tmp_path, monkeypatch)
    # Live manifest pins the NEW profile.
    live = tmp_path / "manifest.json"
    live.write_text(
        json.dumps({"profile": "swe-rebench", "manifest_sha256": "x", "instances": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr(A, "MANIFEST_PATH", live)
    # A minimal pre-port archive: one row, meta WITHOUT a profile key.
    archive = tmp_path / "old-archive"
    row_dir = archive / "inst1" / "factory"
    row_dir.mkdir(parents=True)
    (row_dir / "result.json").write_text(
        json.dumps(
            {
                "arm": "factory",
                "instance_id": "inst1",
                "factory_says_green": True,
                "grade": {"oracle_resolved": True, "outcome": "resolved"},
                "tokens_in": 1,
                "tokens_out": 1,
                "wall_clock_s": 1.0,
            }
        ),
        encoding="utf-8",
    )
    (row_dir / "audit.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
    (row_dir / "prediction.diff").write_text("diff --git a/x b/x\n", encoding="utf-8")
    (archive / "report-meta.json").write_text(
        json.dumps({"generated_at": "2026-08-02T17:00:00+00:00", "rows": 1}),
        encoding="utf-8",
    )
    text = A.report(from_archive=archive)
    assert text.startswith("# SWE-bench Pro — externally graded")
    assert "OpenAI's" in text  # the Pro broken-task note, not the rebench one


# --------------------------------------------------------------------------- #
# live-sweep fixes: store integrity, probe discrimination, topology parity
# --------------------------------------------------------------------------- #


def test_store_paths_are_isolated_from_the_repo_under_pytest(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 1a: the first live sweep died because a unit test's fetch wrote
    ONE fixture record over the real committed oracle.json.z (only
    MANIFEST_PATH was patched). The autouse fixture must redirect BOTH store
    paths for every test, so a forgotten patch can never reach the repo."""
    repo_swe_dir = A.SWE_DIR  # the real bench/swebench dir (module constant)
    assert not str(A.ORACLE_PATH).startswith(str(repo_swe_dir))
    assert not str(A.MANIFEST_PATH).startswith(str(repo_swe_dir))
    # A fetch with NO explicit path patches (the exact pollution shape that
    # clobbered the store) lands entirely inside the isolated paths.
    real_store_before = (
        (repo_swe_dir / "oracle.json.z").read_bytes()
        if (repo_swe_dir / "oracle.json.z").exists()
        else None
    )
    monkeypatch.setattr(A, "_resolve_image_digest", lambda image: None)
    monkeypatch.setattr(A, "_all_rows", lambda profile: [_rebench_row()])
    A.fetch(dataset="swe-rebench", language="python", limit=1, seed=1, after=None)
    assert A.ORACLE_PATH.exists() and A.MANIFEST_PATH.exists()
    real_store_after = (
        (repo_swe_dir / "oracle.json.z").read_bytes()
        if (repo_swe_dir / "oracle.json.z").exists()
        else None
    )
    assert real_store_after == real_store_before, (
        "a test fetch reached the repo's committed oracle store"
    )


def test_spend_paths_refuse_before_spend_when_the_store_is_incomplete(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 1c: grade was the FIRST place a broken store was consulted — after
    $24.78 of model spend. selftest, run-all and run must refuse at START."""
    inst = dict(_rebench_instance(A))
    inst["oracle_sha256"] = "f" * 64  # pinned, but the store has no record
    for k in A._ORACLE_FIELDS:
        inst.pop(k, None)
    manifest = {
        "profile": "swe-rebench",
        "manifest_sha256": "shaX",
        "instances": [inst],
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(A, "MANIFEST_PATH", tmp_path / "manifest.json")
    A._write_oracle_store({}, tmp_path / "oracle.json.z")
    monkeypatch.setattr(A, "ORACLE_PATH", tmp_path / "oracle.json.z")

    with pytest.raises(SystemExit, match="BEFORE"):
        A._assert_oracle_store_complete([inst])
    # selftest refuses before any docker work…
    with pytest.raises(SystemExit, match="refusing BEFORE any spend"):
        A.selftest(None, timeout_s=60)
    # …and so does run-all, including its dry-run preview.
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path / "runs")
    with pytest.raises(SystemExit, match="refusing BEFORE any spend"):
        A.run_all(
            arm="factory", workers=1, instances=None, only_working=False,
            max_steps=1, run_timeout_s=1, grade_timeout_s=1,
            force_over_cap=False, dry_run=True,
        )
    # A complete store passes the guard.
    good = dict(_rebench_instance(A))
    record = {k: good.pop(k) for k in A._ORACLE_FIELDS if k in good}
    good["oracle_sha256"] = A._oracle_record_digest(record)
    A._write_oracle_store({good["instance_id"]: record}, tmp_path / "oracle.json.z")
    A._assert_oracle_store_complete([good])  # must not raise


def test_probe_ignores_the_runs_own_cwd_and_the_system_prompt(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """FIX 2: the first live sweep false-flagged 13/19 factory rows (the
    OpenHands system prompt carries the run's own cwd) and both bare rows
    (the arm referencing its OWN repo by absolute path). Own-subtree
    references and harness-authored events are not probes; everything else
    stays fail-closed."""
    iid, arm = "inst1", "factory"
    own = f"/home/k/software-factory/bench/swebench/runs/{iid}/{arm}/root/x"
    # Own-run references: never a hit. All four shapes measured live:
    assert A._probe_line_hits(f"cwd is {own}", iid, arm) == []
    assert A._probe_line_hits(
        f'{{"command": "cat > {own}/repo/pkg/mod.py <<EOF"}}', iid, arm
    ) == []
    # find/ls targeting the own run DIR itself (no arm suffix)…
    assert A._probe_line_hits(
        f'find /home/k/sf/bench/swebench/runs/{iid} -name "*.md"', iid, arm
    ) == []
    # …a condenser-abbreviated own path…
    assert A._probe_line_hits(
        f"work done in bench/swebench/runs/{iid}/.../worktrees/x`", iid, arm
    ) == []
    # …and an observation clipped MID-PATH at the OpenHands sentinel.
    assert A._probe_line_hits(
        "listing bench/swebench/ru<response clipped><NOTE>use ls -la</NOTE>",
        iid, arm,
    ) == []
    # Genuine probes: the store, the manifest, another run's subtree
    # (its grade log carries oracle test ids), the harness dir itself, a
    # non-sentinel truncation, an id-prefix collision — and the own run's
    # oracle-bearing subdirs (selftest logs / the other arm's grade log).
    assert A._probe_line_hits("cat bench/swebench/oracle.json.z", iid, arm)
    assert A._probe_line_hits("cat bench/swebench/manifest.json", iid, arm)
    assert A._probe_line_hits(
        "cat bench/swebench/runs/OTHER__inst-9/factory/grade.log", iid, arm
    )
    assert A._probe_line_hits("ls /home/k/software-factory/bench/swebench", iid, arm)
    assert A._probe_line_hits("ls bench/swebench/ru", iid, arm)
    assert A._probe_line_hits(f"ls bench/swebench/runs/{iid}22/x", iid, arm)
    assert A._probe_line_hits(
        f"cat bench/swebench/runs/{iid}/selftest/selftest.log", iid, arm
    ) == ["another run subdir runs/…/selftest (own arm is factory)"]
    assert A._probe_line_hits(
        f"cat bench/swebench/runs/{iid}/bare/grade.log", iid, arm
    ) == ["another run subdir runs/…/bare (own arm is factory)"]

    # End-to-end through audit: a trajectory whose SYSTEM PROMPT carries the
    # cwd (line 1, exactly as OpenHands writes it) plus an ActionEvent that
    # echoes the own cwd must audit CLEAN…
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_audit_run(tmp_path, responses=_RESPONSE_ROWS, trajectories=0)
    traj_dir = tmp_path / "inst1" / "factory" / "root" / "state" / "events" / "trajectories"
    traj_dir.mkdir(parents=True, exist_ok=True)
    (traj_dir / "1-1.ndjson").write_text(
        json.dumps(
            {"kind": "SystemPromptEvent", "source": "agent",
             "system_prompt": f"Your current working directory is: {own}"}
        )
        + "\n"
        + json.dumps(
            {"kind": "ActionEvent", "source": "agent",
             "action": {"command": f"ls {own}/repo"},
             "llm_message": {"content": [{"type": "text", "text": "listing"}]}}
        )
        + "\n",
        encoding="utf-8",
    )
    A.audit("inst1", "factory")  # must not raise
    # …while an ActionEvent that reads ANOTHER path under bench/swebench
    # still fails, and the system prompt cannot launder it.
    (traj_dir / "1-1.ndjson").write_text(
        json.dumps(
            {"kind": "ActionEvent", "source": "agent",
             "action": {"command": "cat ../../../../../../manifest.json "
                        "/home/k/software-factory/bench/swebench/oracle.json.z"}}
        )
        + "\n",
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "factory")
    failures = _audit_json(tmp_path)["failures"]
    assert any("oracle-probe" in f and "ActionEvent" in f for f in failures), failures


def test_prepare_cloned_tree_replays_install_and_commits_artifacts(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,  # noqa: N803
    submodule_fixture: tuple[Path, Path, str],
) -> None:
    """FIX 3 (proxy≠real): selftest graded the image's BAKED tree while run
    mounted a fresh clone missing build-generated artifacts — 3 live rows
    died at the collect gate. The prepare step replays the dataset's install
    command against the mounted clone (as root, chowning back) and COMMITS
    what it generates, so per-story worktrees and the grade script's
    `git clean -fd` keep the artifacts."""
    import subprocess as sp

    main, _sub, sha = submodule_fixture
    monkeypatch.setattr(A, "_clone_url", lambda inst: f"file://{main}")
    inst = dict(
        _rebench_instance(A),
        instance_id="local__main-abc", repo="local/main", base_commit=sha,
        install_cmd="pip install -e . --quiet",
    )
    dest = tmp_path / "clone"
    A._clone(inst, dest)

    real_run = A.subprocess.run
    seen: dict[str, Any] = {}

    def fake_run(argv: Any, **kw: Any) -> Any:
        if isinstance(argv, list) and argv and argv[0] == "docker":
            seen["argv"], seen["input"] = argv, kw.get("input")
            # Simulate the install step generating an untracked artifact
            # in the mounted tree (what setuptools-scm / a C build does).
            (dest / "pkg_version.py").write_text("__version__ = '1.0'\n")
            from types import SimpleNamespace
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return real_run(argv, **kw)

    monkeypatch.setattr(A.subprocess, "run", fake_run)
    assert A._prepare_cloned_tree(inst, dest) is None
    monkeypatch.setattr(A.subprocess, "run", real_run)

    # The docker invocation: mounted over /testbed, script via stdin, runs
    # the dataset's install command and chowns back to the invoking uid.
    assert f"{dest}:/testbed" in " ".join(seen["argv"])
    assert "--user" not in seen["argv"], "install must run as root (conda writes)"
    assert "pip install -e . --quiet" in seen["input"]
    assert f"chown -R {os.getuid()}:{os.getgid()} /testbed" in seen["input"]
    # The generated artifact is COMMITTED: a derived worktree carries it and
    # the base ref points at the final commit (empty review diff).
    tracked = sp.run(
        ["git", "-C", str(dest), "ls-files", "pkg_version.py"],
        capture_output=True, text=True,
    ).stdout.strip()
    assert tracked == "pkg_version.py"
    wt = tmp_path / "story-wt"
    sp.run(
        ["git", "-C", str(dest), "worktree", "add", "-b", "swebench-95000-y", str(wt)],
        check=True, capture_output=True, text=True,
    )
    assert (wt / "pkg_version.py").exists(), "worktree lost the build artifact"
    ref = sp.run(
        ["git", "-C", str(dest), "rev-parse", "refs/remotes/origin/swebench-base"],
        capture_output=True, text=True,
    ).stdout.strip()
    head = sp.run(
        ["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    assert ref == head


def test_prepare_failure_is_an_error_and_pro_is_untouched(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """A failing install step must come back as an error string (selftest
    excludes the instance, run fails at $0); the frozen Pro profile never
    runs a prepare CONTAINER at all.

    Pro is frozen with respect to its ENVIRONMENT — no install replay, no docker
    invocation, the baked topology untouched. It is deliberately NOT frozen with
    respect to the base-ref pin (``_pin_base_ref``): the ref-shadowing bug is a
    property of how the clone is checked out, not of which dataset it came from,
    so a Pro tree that left the agent standing on ``swebench-base`` would carry the
    same defect. So the assertion below is about docker, which is what "frozen"
    ever meant, and the pin is asserted to have run for Pro too.
    """
    from types import SimpleNamespace

    inst = dict(_rebench_instance(A), install_cmd="exit 1")
    calls: list[Any] = []

    def fake_run(argv: Any, **kw: Any) -> Any:
        calls.append(argv)
        return SimpleNamespace(returncode=97, stdout="boom", stderr="")

    monkeypatch.setattr(A.subprocess, "run", fake_run)
    err = A._prepare_cloned_tree(inst, tmp_path / "clone")
    assert err is not None and "install step failed" in err

    calls.clear()
    pro = _pro_manifest()["instances"][0]
    assert A._prepare_cloned_tree(pro, tmp_path / "clone") is None
    assert not [c for c in calls if "docker" in list(c)], (
        f"Pro is frozen — no prepare container may run, got {calls}"
    )
    # ... and the pin DID run, for both profiles.
    assert any("tag" in list(c) and A._BASE_TAG in list(c) for c in calls), calls
    assert any(
        "checkout" in list(c) and A._WORK_BRANCH in list(c) for c in calls
    ), calls


def test_docker_bash_mounts_the_prepared_tree_as_the_invoking_uid(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """Grade/selftest for swe-rebench must operate on the mounted prepared
    clone as the invoking uid; Pro (no mount) keeps the baked-tree call."""
    from types import SimpleNamespace

    seen: dict[str, Any] = {}

    def fake_run(argv: Any, **kw: Any) -> Any:
        seen["argv"] = argv
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(A.subprocess, "run", fake_run)
    A._docker_bash("img", "echo hi", 60, nonce="n1", mount=Path("/x/repo"))
    argv = " ".join(seen["argv"])
    assert "-v /x/repo:/testbed" in argv
    assert f"--user {os.getuid()}:{os.getgid()}" in argv
    assert "--network none" in argv

    A._docker_bash("img", "echo hi", 60, nonce="n1")
    argv = " ".join(seen["argv"])
    assert "-v" not in seen["argv"] and "--user" not in seen["argv"]


# --------------------------------------------------------------------------- #
# claude arm — hermetic CLI invocation, prompt parity, transcript-backed audit
# --------------------------------------------------------------------------- #


def test_claude_prompt_is_built_from_the_shared_story_template(A: Any) -> None:  # noqa: N803
    """No arm gets privileged wording: the claude prompt is the SAME story
    template the factory dev receives (statement + test command + the
    test-edits-are-stripped note), and none of the oracle reaches it."""
    inst = _rebench_instance(A)
    prompt = A._claude_task_prompt(inst, Path("/nonexistent"))
    # Same pieces, same source (_STORY_TEMPLATE):
    assert prompt.startswith(f"# {inst['instance_id']}")
    assert inst["problem_statement"] in prompt
    assert A.instance_test_command(inst, repo=Path("/nonexistent")) in prompt
    assert "Your test edits are removed from the diff" in prompt
    # Byte-identical to what run_factory writes into the story file.
    story = A._STORY_TEMPLATE.format(
        instance_id=inst["instance_id"],
        statement=inst["problem_statement"],
        test_command=A.instance_test_command(inst, repo=Path("/nonexistent")),
    )
    assert prompt.startswith(story)
    # The only addition is the no-network rule (the bare arm has it too).
    assert prompt == story + A._CLAUDE_RULES
    # Oracle material must be absent.
    assert "oracle.json" not in prompt
    assert "manifest.json" not in prompt
    for f2p_id in inst["fail_to_pass"]:
        assert f2p_id not in prompt, "hidden test id leaked into the prompt"


def test_claude_cli_argv_is_hermetic_and_oracle_free(A: Any) -> None:  # noqa: N803
    """The flags ARE the isolation: MCP dropped, settings dropped, web tools
    disallowed, sessions unpersisted, model pinned, turns bounded."""
    inst = _rebench_instance(A)
    prompt = A._claude_task_prompt(inst, Path("/nonexistent"))
    argv = A._claude_cli_argv(prompt, model=A._CLAUDE_MODEL, max_turns=60)
    assert argv[0] == "claude"
    joined = "\x00".join(argv)
    for flag in (
        "--safe-mode",
        "--strict-mcp-config",
        "--setting-sources",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--output-format",
    ):
        assert flag in argv, flag
    assert argv[argv.index("--model") + 1] == A._CLAUDE_MODEL
    assert argv[argv.index("--max-turns") + 1] == "60"
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv  # the CLI requires it for -p stream-json
    i = argv.index("--disallowedTools")
    assert argv[i + 1 : i + 3] == ["WebFetch", "WebSearch"]
    # No oracle material anywhere in the constructed command.
    assert "oracle.json" not in joined
    assert "manifest.json" not in joined
    for f2p_id in inst["fail_to_pass"]:
        assert f2p_id not in joined


def test_claude_child_env_scrubs_claude_and_anthropic_vars(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The dogfooding hazard: this harness runs where Claude Code is the daily
    tool, and the factory .env exports ANTHROPIC_API_KEY. The child must see
    neither this session's nesting markers nor a billing/routing override."""
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-nope")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://evil")
    monkeypatch.setenv("FACTORY_STATE_ROOT", "/x")
    monkeypatch.setenv("HOME", "/home/k")
    env = A._claude_child_env()
    assert "CLAUDECODE" not in env
    assert "CLAUDE_CODE_ENTRYPOINT" not in env
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_BASE_URL" not in env
    assert "FACTORY_STATE_ROOT" not in env
    assert env["HOME"] == "/home/k"  # auth needs the CLI's stored login


def _claude_stream_events(
    *, model: str = "claude-opus-5", cost: float = 0.5, mcp: list[Any] | None = None,
    tools: list[str] | None = None, probe_line: str | None = None,
    with_result: bool = True,
) -> str:
    events: list[dict[str, Any]] = [
        {
            "type": "system", "subtype": "init", "model": model,
            "mcp_servers": mcp or [], "tools": tools or ["Bash", "Edit", "Read"],
            "permissionMode": "bypassPermissions", "session_id": "s1",
        },
        {
            "type": "assistant",
            "message": {
                "id": "m1", "model": model,
                "content": [{"type": "text", "text": "on it"}],
                "usage": {
                    "input_tokens": 10, "output_tokens": 5,
                    "cache_read_input_tokens": 3, "cache_creation_input_tokens": 2,
                },
            },
        },
    ]
    if probe_line is not None:
        events.append(
            {
                "type": "user",
                "message": {
                    "content": [{"type": "tool_result", "content": probe_line}]
                },
            }
        )
    if with_result:
        events.append(
            {
                "type": "result", "is_error": False, "num_turns": 2,
                "total_cost_usd": cost, "session_id": "s1",
                "modelUsage": {
                    model: {
                        "inputTokens": 10, "outputTokens": 5,
                        "cacheReadInputTokens": 3, "cacheCreationInputTokens": 2,
                        "costUSD": cost,
                    }
                },
            }
        )
    return "\n".join(json.dumps(e) for e in events) + "\n"


def test_run_claude_end_to_end_with_a_mocked_cli(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The full run path with the CLI mocked at the subprocess boundary:
    transcript persisted, usage/cost taken from the CLI's own report, the
    pinned AND reported model ids recorded, diff captured from the clone."""
    import subprocess as sp

    inst = dict(_rebench_instance(A), instance_id="inst1")
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(A, "_instance", lambda iid: inst)
    monkeypatch.setattr(A, "_assert_oracle_store_complete", lambda insts: None)
    monkeypatch.setattr(A, "_manifest", lambda: {"manifest_sha256": "shaX"})
    monkeypatch.setattr(A, "_ensure_image", lambda i: True)
    monkeypatch.setattr(A, "_prepare_cloned_tree", lambda i, r, **kw: None)
    monkeypatch.setattr(A, "_claude_cli_version", lambda: "2.1.220 (Claude Code)")
    monkeypatch.setattr(
        A, "_precheck_collect",
        lambda i, r: {"collect_ok": True, "duration_s": 0.1, "mode": "existing-targets",
                      "collected_targets": [], "exit_code": 0, "tail": ""},
    )

    def fake_clone(i: dict[str, Any], dest: Path) -> None:
        _mk_git_repo(dest, {"pkg/mod.py": "BROKEN = True\n"})
        sp.run(
            ["git", "-C", str(dest), "checkout", "-q", "-B", "swebench-base"],
            check=True, capture_output=True,
        )

    monkeypatch.setattr(A, "_clone", fake_clone)

    seen: dict[str, Any] = {}
    real_popen = sp.Popen

    def _fake_popen(argv: list[str], **kw: Any) -> Any:
        # subprocess.run (git plumbing, _capture_diff) also goes through
        # Popen — only the CLI spawn is mocked; everything else stays real.
        if argv[0] != "claude":
            return real_popen(argv, **kw)

        class _FakeCli:
            returncode = 0

            def communicate(self, timeout: float | None = None) -> tuple[str, str]:
                return "", ""

        seen["argv"] = argv
        seen["cwd"] = kw["cwd"]
        seen["env"] = kw["env"]
        mod = Path(kw["cwd"]) / "pkg" / "mod.py"
        mod.write_text("BROKEN = False\n", encoding="utf-8")
        kw["stdout"].write(_claude_stream_events())
        return _FakeCli()

    monkeypatch.setattr(A.subprocess, "Popen", _fake_popen)
    A.run_claude("inst1", max_steps=60, timeout_s=300)

    run_dir = tmp_path / "inst1" / "claude"
    # The child ran IN the clone with a scrubbed env and the pinned model —
    # and the clone is OUTSIDE the harness dir, so the CLI's cwd has no
    # ancestor holding the oracle store or another arm's grade log.
    assert seen["cwd"] == str(A._work_dir("inst1", "claude") / "repo")
    assert not Path(seen["cwd"]).is_relative_to(A.SWE_DIR)
    assert "ANTHROPIC_API_KEY" not in seen["env"]
    assert seen["argv"][seen["argv"].index("--model") + 1] == A._CLAUDE_MODEL
    # Transcript persisted verbatim.
    transcript = (run_dir / "claude-transcript.ndjson").read_text(encoding="utf-8")
    assert '"subtype": "init"' in transcript and '"type": "result"' in transcript
    # result.json: CLI-reported usage/cost, both model ids, no gate verdict.
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert result["arm"] == "claude"
    assert result["model"] == A._CLAUDE_MODEL
    assert result["model_reported"] == "claude-opus-5"
    assert result["models_observed"] == ["claude-opus-5"]
    assert result["cost_usd"] == 0.5
    assert result["cost_source"] == "claude-cli-reported"
    assert result["tokens_in"] == 15  # raw 10 + cacheRead 3 + cacheCreation 2
    assert result["tokens_out"] == 5
    assert result["cached_input_tokens"] == 3
    assert result["num_turns"] == 2
    assert result["error"] is None
    assert result["factory_says_green"] is None
    assert result["mcp_servers"] == []
    assert result["claude_cli_version"] == "2.1.220 (Claude Code)"
    # The diff came from the clone, test-edit-stripped and graded-ready.
    diff = (run_dir / "prediction.diff").read_text(encoding="utf-8")
    assert "pkg/mod.py" in diff and "BROKEN = False" in diff
    # And the run is audit-clean end-to-end (no factory ledger required).
    A.audit("inst1", "claude")  # must not raise
    audit = json.loads((run_dir / "audit.json").read_text(encoding="utf-8"))
    assert audit["ok"] is True
    assert audit["ledger_cost_usd"] == 0.5


def _mk_claude_run(
    runs_root: Path,
    *,
    result: dict[str, Any] | None = None,
    transcript: str | None = None,
) -> Path:
    run_dir = runs_root / "inst1" / "claude"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "claude-transcript.ndjson").unlink(missing_ok=True)
    if result is None:
        result = {
            "arm": "claude", "model": "claude-opus-5", "cost_usd": 0.5,
            "tokens_in": 15, "tokens_out": 5, "num_turns": 2, "error": None,
        }
    (run_dir / "result.json").write_text(json.dumps(result), encoding="utf-8")
    if transcript is not None:
        (run_dir / "claude-transcript.ndjson").write_text(transcript, encoding="utf-8")
    return run_dir


def test_claude_audit_fails_on_cost_or_token_mismatch(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The transcript is this arm's ledger: result.json must report exactly
    what the CLI's result event says, or the number is not the real spend."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_claude_run(
        tmp_path,
        result={"arm": "claude", "model": "claude-opus-5", "cost_usd": 0.1,
                "tokens_in": 15, "tokens_out": 5, "num_turns": 2, "error": None},
        transcript=_claude_stream_events(cost=0.5),
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "claude")
    failures = _audit_json(tmp_path, "claude")["failures"]
    assert any("cost mismatch" in f for f in failures), failures


def test_claude_audit_fails_when_the_transcript_probed_the_oracle(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The transcript's tool calls/results are the command-log equivalent —
    a reference to the store or another arm's run dir invalidates the run."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    for probe in (
        "cat bench/swebench/oracle.json.z",
        "cat bench/swebench/runs/inst1/bare/grade.log",  # sibling arm's dir
    ):
        _mk_claude_run(tmp_path, transcript=_claude_stream_events(probe_line=probe))
        with pytest.raises(SystemExit, match="audit FAILED"):
            A.audit("inst1", "claude")
        failures = _audit_json(tmp_path, "claude")["failures"]
        assert any(
            "oracle-probe" in f and "claude-transcript.ndjson" in f for f in failures
        ), failures


def test_claude_audit_fails_closed_without_a_transcript(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Same posture as the bare arm's missing command log: a run that made
    model calls but left no action trail cannot be cleared of oracle access."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_claude_run(tmp_path, transcript=None)  # result says num_turns=2
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "claude")
    failures = _audit_json(tmp_path, "claude")["failures"]
    assert any("no claude-transcript.ndjson" in f for f in failures), failures


def test_claude_audit_fails_when_the_hermetic_config_did_not_load(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The init event is the artifact proving what config REALLY loaded: an
    MCP server or a web tool present means the contamination control failed
    — gate on the real artifact, not on the flags we intended to pass."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_claude_run(
        tmp_path,
        transcript=_claude_stream_events(mcp=[{"name": "hubspot", "status": "connected"}]),
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "claude")
    assert any(
        "hermetic-config" in f and "MCP" in f
        for f in _audit_json(tmp_path, "claude")["failures"]
    )

    _mk_claude_run(
        tmp_path, transcript=_claude_stream_events(tools=["Bash", "WebSearch"])
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "claude")
    assert any(
        "hermetic-config" in f and "WebSearch" in f
        for f in _audit_json(tmp_path, "claude")["failures"]
    )


def test_claude_audit_fails_a_truncated_stream_that_claims_success(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """No result event (killed run) is only acceptable when the run recorded
    an error; a clean-looking result.json with a truncated transcript is a
    run whose spend cannot be certified."""
    monkeypatch.setattr(A, "RUNS_DIR", tmp_path)
    _mk_claude_run(
        tmp_path,
        result={"arm": "claude", "model": "claude-opus-5", "cost_usd": 0.0,
                "tokens_in": 15, "tokens_out": 5, "num_turns": 0, "error": None},
        transcript=_claude_stream_events(with_result=False),
    )
    with pytest.raises(SystemExit, match="audit FAILED"):
        A.audit("inst1", "claude")
    failures = _audit_json(tmp_path, "claude")["failures"]
    assert any("must not read as clean" in f for f in failures), failures
    # With the error recorded (the wall-clock kill path), the same artifacts
    # audit clean — truncation becomes a warning, not a finding.
    _mk_claude_run(
        tmp_path,
        result={"arm": "claude", "model": "claude-opus-5", "cost_usd": 0.0,
                "tokens_in": 15, "tokens_out": 5, "num_turns": 0,
                "error": "wall-clock cap 300s hit; partial work is still graded"},
        transcript=_claude_stream_events(with_result=False),
    )
    A.audit("inst1", "claude")  # must not raise
    assert _audit_json(tmp_path, "claude")["ok"] is True


def test_probe_flags_every_sibling_arm_dir_not_just_one(A: Any) -> None:  # noqa: N803
    """For any arm, EVERY subdir under the own run dir that is not the arm's
    OWN is oracle-bearing (their grade logs carry hidden test ids).

    The rule is "own arm only", not an allowlist of the arms this file happens
    to know about: the next sweep adds ``openhands`` and runs the Claude CLI
    under two model-suffixed names, and an allowlist would have waved those
    through silently.
    """
    iid = "inst1"
    arms = ("claude", "factory", "bare", "openhands", "claude-opus-4-8")
    for arm in arms:
        assert (
            A._probe_line_hits(f"ls bench/swebench/runs/{iid}/{arm}/repo", iid, arm) == []
        ), f"{arm}: own cwd must not be a probe"
        for other in (*arms, "selftest", "some-arm-nobody-listed"):
            if other == arm:
                continue
            hits = A._probe_line_hits(
                f"cat bench/swebench/runs/{iid}/{other}/grade.log", iid, arm
            )
            assert hits == [
                f"another run subdir runs/…/{other} (own arm is {arm})"
            ], (arm, other, hits)


def test_reset_run_artifacts_deletes_the_claude_transcript(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    (tmp_path / "claude-transcript.ndjson").write_text("stale", encoding="utf-8")
    (tmp_path / "claude-stderr.log").write_text("stale", encoding="utf-8")
    A._reset_run_artifacts(tmp_path)
    assert not (tmp_path / "claude-transcript.ndjson").exists()
    assert not (tmp_path / "claude-stderr.log").exists()


def test_cli_claude_arm_defaults_to_the_turn_cap(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """--max-steps means CLI turns for the claude arm; when omitted the arm
    gets its own generous-but-bounded default, the others keep 16."""
    seen: dict[str, Any] = {}
    monkeypatch.setattr(A, "_load_env", lambda: None)
    monkeypatch.setattr(
        A, "run_claude", lambda iid, *, max_steps, timeout_s, arm, model: seen.update(
            iid=iid, max_steps=max_steps, timeout_s=timeout_s, arm=arm, model=model
        )
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["swebench_adapter.py", "run", "--instance", "i1", "--arm", "claude-5"],
    )
    A.main()
    assert seen["max_steps"] == A._CLAUDE_TURN_CAP

    monkeypatch.setattr(
        A, "run_factory", lambda iid, *, max_steps, timeout_s, arm: seen.update(
            factory_steps=max_steps, factory_arm=arm
        )
    )
    monkeypatch.setattr(
        sys, "argv", ["swebench_adapter.py", "run", "--instance", "i1", "--arm", "factory"]
    )
    A.main()
    assert seen["factory_steps"] == 16
    assert seen["factory_arm"] == "factory"

    # The chain driver serves more than one arm id since the B.1 reviewer
    # ablation, so it is handed the arm and the ablation keeps the same budget.
    monkeypatch.setattr(
        sys,
        "argv",
        ["swebench_adapter.py", "run", "--instance", "i1", "--arm", "solo-noreview"],
    )
    A.main()
    assert seen["factory_steps"] == 16
    assert seen["factory_arm"] == "solo-noreview"


# --------------------------------------------------------------------------- #
# the bare arm — an honest baseline: parser, prompt parity, step budget
# --------------------------------------------------------------------------- #

# The real hallucination shape, measured on the first rebench sweep: the model
# writes its actual patch command, then fabricates the rest of the session —
# exit statuses, output, further commands. One run executed 4 fabricated
# commands (exit 2) while its real patch script was written but never run.
_HALLUCINATED_REPLY = """\
BASH
python - <<'EOF'
with open('pkg/mod.py') as f:
    src = f.read()
open('pkg/mod.py', 'w').write(src.replace('a', 'b'))
EOF
Exit 0. Output:
import collections
collections.OrderedDict()
BASH
python -m pytest tests/
Exit 2. Output:
2 failed, 1 passed
DONE
"""


def test_parser_drops_the_hallucinated_tail(A: Any) -> None:  # noqa: N803
    """Only the real first command executes; the fabricated transcript
    (Exit lines, fake output, follow-on BASH blocks) must never reach bash."""
    cmd = A._parse_bash(_HALLUCINATED_REPLY)
    assert cmd is not None
    assert cmd.startswith("python - <<'EOF'")
    assert cmd.endswith("EOF")
    assert "Exit 0" not in cmd
    assert "Output:" not in cmd
    assert "collections" not in cmd
    assert "pytest" not in cmd, "the fabricated second command must not execute"


def test_parser_takes_only_the_first_bash_block(A: Any) -> None:  # noqa: N803
    assert A._parse_bash("BASH\nls -la\n\nBASH\necho second\n") == "ls -la"


def test_parser_preserves_a_multiline_heredoc(A: Any) -> None:  # noqa: N803
    reply = "BASH\ncat > f.py <<'EOF'\ndef f():\n    return 1\nEOF"
    assert A._parse_bash(reply) == "cat > f.py <<'EOF'\ndef f():\n    return 1\nEOF"


def test_parser_unwraps_code_fences(A: Any) -> None:  # noqa: N803
    assert A._parse_bash("```bash\nBASH\nls\n```") == "ls"
    assert A._parse_bash("BASH\n```bash\nls\n```") == "ls"


def test_parser_rejects_replies_without_a_bash_marker(A: Any) -> None:  # noqa: N803
    assert A._parse_bash("I will now fix the bug.") is None
    assert A._parse_bash("DONE") is None
    assert A._parse_bash("BASH\n") is None  # marker with no command


def test_bare_task_carries_the_factory_story_test_command_verbatim(A: Any) -> None:  # noqa: N803
    """Parity: the bare prompt embeds the SAME docker one-liner string the
    factory story template gets — same source, no privileged wording. A bare
    arm with no way to run tests measures verification-blindness, not
    scaffold lift (0 of 19 first-sweep bare runs ever invoked pytest)."""
    cmd = A.instance_test_command(_INST)
    bare = A._BARE_TASK.format(repo="x/y", statement="s", test_command=cmd)
    story = A._STORY_TEMPLATE.format(
        instance_id="i", statement="s", test_command=cmd
    )
    assert cmd in bare
    assert cmd in story
    # And the prompt closes the loop: verify BEFORE declaring done.
    assert "DONE" in bare
    assert "docker" in bare


def test_both_arms_derive_the_test_command_from_the_same_call(A: Any) -> None:  # noqa: N803
    """Pin the call shape: identical arguments, so no arm can drift to a
    privileged variant (extra targets, collect-only, leaked node ids)."""
    import inspect

    for fn in (A.run_bare, A.run_factory, A.run_openhands, A._claude_task_prompt):
        assert "instance_test_command(inst, repo=repo)" in inspect.getsource(fn), (
            f"{fn.__name__} derives its test command differently"
        )


def test_step_budget_defaults_are_per_arm(A: Any) -> None:  # noqa: N803
    """All 19 first-sweep bare runs inherited the factory's 16-step default
    while _BARE_STEP_CAP sat unused — under half the intended budget. ONE
    resolver covers every arm; a second mechanism would drift."""
    assert A._BARE_STEP_CAP == 40
    assert A._resolve_max_steps("bare", None) == 40
    assert A._resolve_max_steps("factory", None) == 16
    assert A._resolve_max_steps("claude", None) == A._CLAUDE_TURN_CAP == 60
    assert (
        A._resolve_max_steps("openhands", None) == A._OPENHANDS_ITERATION_CAP == 600
    )
    # An explicit --max-steps still overrides, for any arm.
    assert A._resolve_max_steps("bare", 5) == 5
    assert A._resolve_max_steps("factory", 33) == 33
    assert A._resolve_max_steps("claude", 2) == 2
    assert A._resolve_max_steps("openhands", 11) == 11


def test_cli_resolves_the_step_budget_per_arm(A: Any) -> None:  # noqa: N803
    """run AND run-all must route through the per-arm resolver; a hard-coded
    argparse default silently starves whichever arm it wasn't tuned for."""
    import inspect

    src = inspect.getsource(A.main)
    assert src.count("_resolve_max_steps(args.arm, args.max_steps)") >= 2
    assert 'p.add_argument("--max-steps", type=int, default=16)' not in src
    # ONE mechanism: main must not shadow the module-level resolver.
    assert "def _resolve_max_steps" not in src
