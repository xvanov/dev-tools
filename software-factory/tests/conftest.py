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

from collections.abc import Iterator

import pytest

import factory.runner as _runner


@pytest.fixture(autouse=True)
def _isolate_factory_state(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    state_root = tmp_path_factory.mktemp("factory_state")
    # Event streams (runs.ndjson, ticks.ndjson, …) resolved by signals._events_dir.
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(state_root))
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
