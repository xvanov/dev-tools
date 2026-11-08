"""Global test isolation.

Several tests call ``factory.runner.text_run`` / ``code_run`` (often with a
fake ``litellm`` module) WITHOUT threading an explicit ``db_path`` or
``software_factory_root``. Left unchecked, those calls fall back to the
production defaults:

  * ``factory.runner._DEFAULT_DB_PATH`` — the real ``state/factory.db`` — and
    write ``Run`` rows there (the ``attempt_n`` counter visibly grew into the
    hundreds across runs).
  * ``signals._events_dir`` — ``$CWD/state/events`` — and append synthetic
    persona-failure records (e.g. SM ``finish_reason=length`` JSON-parse
    failures from the json-retry tests) to the real ``runs.ndjson``.

The live FMS watcher reads those streams and escalates them as genuine
persona failures, so every ``pytest`` run injected phantom SM-truncation
signals that the manager re-escalated to a human every tick.

This autouse fixture redirects BOTH defaults to a per-test tmp directory so no
test can ever touch production state. Tests that already pass explicit tmp
paths are unaffected (they never hit the defaults).
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator

import pytest

import factory.runner as _runner

# Windows: run like Linux, in Python's UTF-8 mode (the factory does: the
# factory-serve task, serve's children and the PA set it). Set before xdist
# starts its workers, so every worker and every subprocess a test starts gets
# it; a serial run (no -n) still decodes as cp1252 in this process.
if sys.platform == "win32":
    os.environ.setdefault("PYTHONUTF8", "1")

# Run from a git hook (pre-commit), the suite inherits GIT_DIR/GIT_INDEX_FILE/...
# pointing at the REAL repository. Many tests run `git init --bare <tmp>`; with
# GIT_DIR set, git re-initialises the real repo instead and writes core.bare=true
# into its shared config (seen 2026-11-08: it broke the live checkout's deploys).
# Tests must only ever see their own temp repos.
for _var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
             "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
    os.environ.pop(_var, None)

_FACTORY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --------------------------------------------------------------------------- #
# Inherently POSIX tests, skipped on native Windows (plan item 2.3). Keyed by
# node-id prefix; every entry says why. The factory code they cover runs on
# Windows through factory/oscompat.py; these TESTS exercise POSIX-only means
# (sh/bash, /proc, /tmp, mode bits, symlinks, getuid, POSIX signals). Listed in
# docs/native/PLAN.md, item 2.3. Keep this the only place they are listed.
# --------------------------------------------------------------------------- #
_SH = "the command under test is POSIX sh (sh -c, sleep, true/false, $VAR); cmd.exe runs it on Windows"
_BENCH = "the SWE-bench harness is Linux-only (docker, bwrap, getuid, POSIX signals); bench/** is operator-only"
WINDOWS_POSIX_ONLY: dict[str, str] = {
    "tests/manager/test_stalled_stories.py": "the stalled-stories detector reads Linux /proc (it ships disabled)",
    "tests/manager/test_detector_registry.py::test_detector_runs_on_empty_root[stalled_stories]":
        "the stalled-stories detector reads Linux /proc (it ships disabled)",
    "tests/test_factory_self_deploy.py": "tests the retired bash self-deploy script",
    "tests/test_self_deploy_never_clobbers.py": "tests the retired bash self-deploy script",
    "tests/test_deploy_runner.py::test_run_command_timeout_is_enforced": _SH,
    "tests/test_deploy_runner.py::test_run_command_passes_through_path_env": _SH,
    "tests/test_deploy_runner.py::test_run_command_passthrough_env_var": _SH,
    "tests/test_deploy_runner.py::test_run_command_sequence_all_pass": _SH,
    "tests/test_gates_evaluation.py::test_tests_green_real_run_reruns_test_command": _SH,
    "tests/test_gates_evaluation.py::test_smoke_real_run_reflects_command_exit": _SH,
    "tests/chain/test_solo_one_story_and_static_gates.py::test_static_baseline_runs_on_the_base_commit_not_the_tree": _SH,
    "tests/test_acceptance_oracle_out_of_process.py::test_pgid_teardown_kills_the_grandchild_and_frees_the_port":
        "boots `sh` and asserts POSIX process-group teardown",
    "tests/test_acceptance_oracle_green_means_something.py::test_H41b_":
        "relies on a 0o555 directory refusing deletes; Windows ignores POSIX mode bits",
    "tests/test_acceptance_oracle_green_means_something.py::test_H5c_":
        "the simulated attacker polls the POSIX /tmp for the oracle's run dir",
    "tests/test_acceptance_oracle_green_means_something.py::test_H5d_":
        "the simulated attacker polls the POSIX /tmp for the oracle's run dir",
    "tests/test_acceptance_oracle_green_means_something.py::test_B2k_":
        "creates a symlink (needs Developer Mode or admin on Windows)",
    "tests/test_diff_capture_and_stall_signature.py::test_a_symlinked_gitlink_is_reported_untrustworthy":
        "creates a symlink (needs Developer Mode or admin on Windows)",
    "tests/test_swebench_acceptance_oracle.py::test_a_dev_trail_that_touched_the_stored_oracle_is_detected": _BENCH,
    "tests/test_swebench_acceptance_oracle.py::test_the_authors_input_is_persisted_in_the_run_dir_not_the_store": _BENCH,
    "tests/test_swebench_acceptance_oracle.py::test_the_trail_scan_also_catches_the_RELATIVE_ref": _BENCH,
    "tests/test_swebench_adapter.py::test_abort_all_kills_running_children": _BENCH,
    "tests/test_swebench_adapter.py::test_bench_subprocess_leaves_no_orphan_after_a_timeout": _BENCH,
    "tests/test_swebench_adapter.py::test_bench_subprocess_turns_a_timeout_into_a_return_code": _BENCH,
    "tests/test_swebench_adapter.py::test_child_spawned_during_abort_race_is_killed_not_awaited": _BENCH,
    "tests/test_swebench_adapter.py::test_clone_fails_loudly_when_a_submodule_cannot_fetch": _BENCH,
    "tests/test_swebench_adapter.py::test_docker_bash_mounts_the_prepared_tree_as_the_invoking_uid": _BENCH,
    "tests/test_swebench_adapter.py::test_precheck_salvages_new_test_file_instances_via_ancestor_env_check": _BENCH,
    "tests/test_swebench_adapter.py::test_prepare_cloned_tree_replays_install_and_commits_artifacts": _BENCH,
    "tests/test_swebench_adapter.py::test_prepare_failure_is_an_error_and_pro_is_untouched": _BENCH,
    "tests/test_swebench_adapter.py::test_story_slug_is_stable_across_processes": _BENCH,
    "tests/test_swebench_sandbox_isolation.py::test_a_symlink_cannot_smuggle_a_bind_source_out_of_the_tree": _BENCH,
    "tests/test_swebench_sandbox_isolation.py::test_short_boolean_clusters_and_inline_values_are_handled": _BENCH,
    "tests/test_swebench_sandbox_isolation.py::test_the_broker_refuses[argv17---user root]": _BENCH,
    "tests/test_swebench_sandbox_isolation.py::test_the_broker_refuses[argv18---user by name]": _BENCH,
    "tests/test_swebench_sandbox_isolation.py::test_the_graded_argv_is_allowed_and_its_bind_is_resolved": _BENCH,
}

# Modules that cannot even be imported on Windows (POSIX calls at import time).
collect_ignore: list[str] = []
if sys.platform == "win32":
    collect_ignore.append("test_swebench_bare_openhands_arms.py")  # os.geteuid at import; _BENCH

# --------------------------------------------------------------------------- #
# Guard: no default-run test may reach the real `claude` CLI or a paid model.
# A stub `claude` that only fails goes first on PATH and is FACTORY_CLAUDE_BIN
# (factory.claude_session.cli.claude_binary honours it before PATH). Set at
# import so every xdist worker and every subprocess inherits it.
# --------------------------------------------------------------------------- #
def _install_fake_claude() -> None:
    import tempfile

    d = tempfile.mkdtemp(prefix="factory-fake-claude-")
    if sys.platform == "win32":
        stub = os.path.join(d, "claude.cmd")
        body = "@echo off\r\necho fake claude: real claude CLI is blocked under pytest 1>&2\r\nexit /b 1\r\n"
    else:
        stub = os.path.join(d, "claude")
        body = "#!/bin/sh\necho 'fake claude: real claude CLI is blocked under pytest' >&2\nexit 1\n"
    with open(stub, "w", newline="") as fh:
        fh.write(body)
    os.chmod(stub, 0o755)
    os.environ["FACTORY_CLAUDE_BIN"] = stub
    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


_install_fake_claude()


# Oracle-boot tests spawn child python processes that die with 0xC0000142 when
# the box is loaded. They run in CI; the local pre-commit hook deselects them
# (changed-pytest.py passes -m "not slow and not flaky_under_load").
FLAKY_UNDER_LOAD = (
    "tests/test_a3_arrange_assert_split.py",
    "tests/test_acceptance_oracle",
    "tests/test_oracle_probe_cli.py",
    "tests/test_cli_tui.py::test_baselines_cli_runs_and_returns_count",  # no such table: stories, depends on test order
)


def _matches(nodeid: str, key: str) -> bool:
    """A key ending in ``.py``, ``::`` or ``_`` is a prefix (module, or a
    family of tests); any other key is one test and its parametrizations."""
    if key.endswith((".py", "::", "_")):
        return nodeid.startswith(key)
    return nodeid == key or nodeid.startswith(key + "[")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    for item in items:
        nodeid = item.nodeid.replace("\\", "/")
        if nodeid.startswith(FLAKY_UNDER_LOAD):
            item.add_marker(pytest.mark.flaky_under_load)
        if sys.platform == "win32":
            for key, why in WINDOWS_POSIX_ONLY.items():
                if _matches(nodeid, key):
                    item.add_marker(pytest.mark.skip(reason=f"POSIX-only on Windows: {why}"))
                    break


@pytest.fixture(autouse=True)
def _isolate_factory_state(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    state_root = tmp_path_factory.mktemp("factory_state")
    # Event streams (runs.ndjson, ticks.ndjson, …) resolved by signals._events_dir.
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(state_root))
    # Watchable API runs (E2): never open a real termhub session from a test.
    # The stream file still lands under the (tmp) factory root.
    monkeypatch.setenv("FACTORY_API_WATCH", "file")
    # Default DB used by runner._engine when no db_path is supplied.
    monkeypatch.setattr(
        _runner, "_DEFAULT_DB_PATH", state_root / "state" / "factory.db", raising=True
    )
    yield


@pytest.fixture(autouse=True)
def _reset_provider_bootstrap_memo() -> None:
    """The Azure provider bootstrap is memoized process-wide
    (``azure_foundry._bootstrapped``). Several test files monkeypatch a FAKE
    ``litellm`` into ``sys.modules``; if such a test triggers the bootstrap,
    the pricing registration lands in the fake and the memo records "done" —
    then a LATER test in the same process introspects the REAL
    ``litellm.model_cost`` and finds nothing (observed: the fast CI lane's
    xdist scheduling paired ``test_runner_response_bodies.py`` with
    ``test_settings_audit.py`` and the estimated-cost flag read False; the
    single-threaded alphabetical order had merely masked the dependence).
    Resetting the memo around every test costs one boolean write and makes
    each test's first bootstrap a real one.
    """
    from factory.providers import azure_foundry

    azure_foundry.reset_for_tests()
    yield
    azure_foundry.reset_for_tests()


@pytest.fixture(autouse=True)
def _restore_module_factory_roots() -> Iterator[None]:
    """Several CLI/webhook test helpers assign ``factory.cli._FACTORY_ROOT`` (or
    the webhook's) directly. Restore both after every test so a pinned root
    cannot leak into whatever the same xdist worker runs next."""
    names = ("factory.cli", "factory.webhook.github")
    saved = {n: sys.modules[n]._FACTORY_ROOT for n in names if n in sys.modules and hasattr(sys.modules[n], "_FACTORY_ROOT")}
    yield
    for n, v in saved.items():
        mod = sys.modules.get(n)
        if mod is not None:
            mod._FACTORY_ROOT = v
