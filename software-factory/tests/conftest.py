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
# Data this public snapshot does not ship (any OS). The live factory machine
# has them; a fresh clone does not (software-factory/.gitignore keeps other
# apps' configs local, and the bench results stay in xvanov/software-factory).
# --------------------------------------------------------------------------- #
_SACRIFICE = os.path.join(_FACTORY_ROOT, "apps", "sacrifice", "config.yaml")
_BENCH_DATA = os.path.join(_FACTORY_ROOT, "bench", "swebench", "manifest.json")
_D = "tests/test_direction_route_premise_guard.py::"
_H = "tests/test_sacrifice_acceptance_harness_hint.py::"
NEEDS_LOCAL_DATA: dict[str, str] = {
    "tests/test_app_gates_config.py::test_sacrifice_config_yaml_has_gates_section": _SACRIFICE,
    "tests/test_deploy_app_config.py::test_sacrifice_config_yaml_has_deploy_block": _SACRIFICE,
    "tests/test_deploy_orchestrator.py::test_real_run_env_var_passthrough_filters_env": _SACRIFICE,
    "tests/test_deploy_orchestrator.py::test_sacrifice_deploy_config_fields_consumed_by_runner": _SACRIFICE,
    _D + "test_a_route_that_does_not_exist_is_never_flagged": _SACRIFICE,
    _D + "test_app_context_docs_do_not_deny_a_route_the_surface_has": _SACRIFICE,
    _D + "test_direction_126_asks_for_the_password_reset_routes_that_exist": _SACRIFICE,
    _D + "test_direction_127_is_not_flagged_because_hardening_presupposes_the_route": _SACRIFICE,
    _D + "test_direction_128_asks_for_the_logout_route_that_exists": _SACRIFICE,
    _D + "test_directions_129_and_130_are_left_alone": _SACRIFICE,
    _D + "test_only_title_and_acceptance_count_as_claims": _SACRIFICE,
    _D + "test_the_denied_routes_really_are_in_the_derived_surface": _SACRIFICE,
    _D + "test_the_rendered_route_table_carries_the_routes_the_docs_denied": _SACRIFICE,
    _H + "test_hint_does_not_name_routes_that_do_not_exist": _SACRIFICE,
    _H + "test_hint_gives_a_known_good_email_domain": _SACRIFICE,
    _H + "test_hint_gives_a_known_good_password_pattern": _SACRIFICE,
    _H + "test_hint_names_the_real_auth_routes": _SACRIFICE,
    _H + "test_hint_required_fields_match_derived_surface": _SACRIFICE,
    _H + "test_hint_routes_exist_in_derived_surface": _SACRIFICE,
    "tests/test_webhook_github_signature.py::test_dispatch_issues_direction_label_routes_to_ingester": _SACRIFICE,
    "tests/test_webhook_github_signature.py::test_dispatch_labeled_with_direction_label_acts": _SACRIFICE,
    "tests/test_benchmark_record_store.py": _BENCH_DATA,
    "tests/test_selftest_parallel_and_merge.py::test_pandas_63945_is_ruled_broken_and_out_of_the_denominator": _BENCH_DATA,
    "tests/test_selftest_parallel_and_merge.py::test_the_working_set_is_eighteen_not_nineteen": _BENCH_DATA,
    "tests/test_swebench_archive_diagnostics.py::test_check_still_passes_on_the_committed_sweep_2_archive": _BENCH_DATA,
    "tests/test_swebench_archive_diagnostics.py::test_the_archive_snapshots_the_diagnostic_evidence": _BENCH_DATA,
    "tests/test_swebench_archive_diagnostics.py::test_the_store_can_be_regenerated_from_an_archive_alone": _BENCH_DATA,
    "tests/test_swebench_five_arm_report.py::test_the_committed_retracted_archive_carries_its_disclaimer": _BENCH_DATA,
    "tests/test_swebench_five_arm_report.py::test_the_committed_retracted_archive_now_counts_its_capped_row": _BENCH_DATA,
    "tests/test_swebench_integrity.py::test_production_tree_gate_would_have_blocked_exactly_one_graded_row": _BENCH_DATA,
    "tests/test_swebench_integrity.py::test_the_committed_prediction_corpus_is_refused_nowhere": _BENCH_DATA,
    "tests/test_swebench_integrity.py::test_the_pinned_gold_patches_survive_the_arm_refusal_rules": _BENCH_DATA,
    "tests/test_swebench_solo_noreview_arm.py::test_the_pinned_manifest_and_instance_count_are_unchanged": _BENCH_DATA,
    "tests/test_swebench_solo_noreview_arm.py::test_the_pre_registration_exists_and_binds_the_mde": _BENCH_DATA,
}


def _matches(nodeid: str, key: str) -> bool:
    """A key ending in ``.py``, ``::`` or ``_`` is a prefix (module, or a
    family of tests); any other key is one test and its parametrizations."""
    if key.endswith((".py", "::", "_")):
        return nodeid.startswith(key)
    return nodeid == key or nodeid.startswith(key + "[")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    for item in items:
        nodeid = item.nodeid.replace("\\", "/")
        if sys.platform == "win32":
            for key, why in WINDOWS_POSIX_ONLY.items():
                if _matches(nodeid, key):
                    item.add_marker(pytest.mark.skip(reason=f"POSIX-only on Windows: {why}"))
                    break
        for key, needed in NEEDS_LOCAL_DATA.items():
            if _matches(nodeid, key) and not os.path.exists(needed):
                rel = os.path.relpath(needed, _FACTORY_ROOT).replace("\\", "/")
                item.add_marker(pytest.mark.skip(reason=f"needs {rel}, which this checkout does not ship"))
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
