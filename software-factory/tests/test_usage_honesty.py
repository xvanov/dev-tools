"""Usage honesty: ``cost_usd == 0`` must stop meaning three different things.

Before this, a zero-cost run row could be a dry-run, a pre-model infra failure,
or a real model call whose cost we failed to read — and every aggregator
(spend, audit, the cost_spike and fms_yield detectors) treated all three as
"free". Measured on the live ledger at the time of writing: 1016 text runs had
output tokens but zero recorded cost, silently indistinguishable from free.

The fix is buzz's ``delta_reliable`` idea applied to our ledger: persist an
explicit ``premodel_infra`` and a THREE-valued ``usage_reliable`` so
"unknown" is representable instead of collapsing to zero.
"""

from __future__ import annotations

import asyncio
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlmodel import Session, select

from factory.observability.schema import (
    _RUNS_NEW_COLUMNS,
    migrate,
    stories_migration_columns,
)
from factory.runner import LLMConfig, Run, RunResult, _engine, _record_run, sandbox_run, text_run


def _rows(db_path: Path) -> list[Run]:
    with Session(_engine(db_path)) as session:
        return list(session.exec(select(Run)).all())


# --------------------------------------------------------------------------- #
# The three-state contract
# --------------------------------------------------------------------------- #


def test_runresult_defaults_usage_reliable_to_unknown() -> None:
    """A RunResult built without an explicit verdict must not claim reliability."""
    assert RunResult(success=False).usage_reliable is None


def test_record_run_persists_the_three_states(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    for reliable in (True, False, None):
        _record_run(
            persona="dev",
            model="azure/gpt-5.4",
            mode="sandbox",
            tokens_in=10,
            tokens_out=5,
            cost_usd=0.0,
            success=False,
            story_path=None,
            repo_path=None,
            error=None,
            db_path=db,
            usage_reliable=reliable,
        )
    assert sorted((r.usage_reliable for r in _rows(db)), key=lambda v: (v is None, v)) == [
        False,
        True,
        None,
    ]


def test_premodel_infra_is_persisted_not_just_in_memory(tmp_path: Path) -> None:
    """The flag that disambiguates a zero-cost row must survive to the DB.

    It previously existed only on the in-memory RunResult, so the ledger — and
    therefore every aggregator — still had to guess from zeroes.
    """
    db = tmp_path / "factory.db"
    _record_run(
        persona="dev",
        model="azure/gpt-5.4",
        mode="sandbox",
        tokens_in=0,
        tokens_out=0,
        cost_usd=0.0,
        success=False,
        story_path=None,
        repo_path=None,
        error="No API key available",
        db_path=db,
        premodel_infra=True,
    )
    row = _rows(db)[0]
    assert row.premodel_infra is True
    # ...and the ambiguity it resolves: zero cost, but NOT a free real call.
    assert row.cost_usd == 0.0


def test_zero_cost_rows_are_now_distinguishable(tmp_path: Path) -> None:
    """The whole point: three zero-cost rows, three different meanings."""
    db = tmp_path / "factory.db"
    common = dict(
        persona="pm",
        model="azure/gpt-5.4",
        success=True,
        story_path=None,
        repo_path=None,
        error=None,
        db_path=db,
    )
    # 1. a dry-run — zero is the correct, known answer
    _record_run(**common, mode="text-dry-run", tokens_in=0, tokens_out=0, cost_usd=0.0)
    # 2. a pre-model infra failure — no call was made
    _record_run(**common, mode="text", tokens_in=0, tokens_out=0, cost_usd=0.0, premodel_infra=True)
    # 3. a REAL call whose cost we could not read — zero is a floor, not a fact
    _record_run(
        **common,
        mode="text",
        tokens_in=900,
        tokens_out=120,
        cost_usd=0.0,
        premodel_infra=False,
        usage_reliable=False,
    )
    by_mode = {(r.mode, r.premodel_infra, r.usage_reliable) for r in _rows(db)}
    assert ("text-dry-run", None, None) in by_mode
    assert ("text", True, None) in by_mode
    assert ("text", False, False) in by_mode


# --------------------------------------------------------------------------- #
# text_run — the 1016-row class: a real call whose cost we cannot read
# --------------------------------------------------------------------------- #


def _fake_litellm(monkeypatch: pytest.MonkeyPatch, response: Any) -> None:
    fake = type("FakeLitellm", (), {"completion": staticmethod(lambda **_: response)})
    monkeypatch.setitem(sys.modules, "litellm", fake)


class _Response(dict):
    """A litellm-shaped response that can carry ``_hidden_params``."""

    def __init__(self, hidden: Any = ..., **kw: Any) -> None:
        super().__init__(
            choices=[{"message": {"content": "ok"}, "finish_reason": "stop"}],
            usage={"prompt_tokens": 1000, "completion_tokens": 100},
            **kw,
        )
        if hidden is not ...:
            self._hidden_params = hidden


def _only_row(db_path: Path) -> Run:
    rows = _rows(db_path)
    assert len(rows) == 1, rows
    return rows[0]


def test_text_run_marks_usage_reliable_when_cost_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    _fake_litellm(monkeypatch, _Response(hidden={"response_cost": 0.0123}))

    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="azure/deepseek-v4-pro", db_path=db)

    row = _only_row(db)
    assert row.usage_reliable is True
    assert row.premodel_infra is False
    assert row.cost_usd == pytest.approx(0.0123)


def test_text_run_flags_unreliable_when_hidden_params_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact live failure: tokens consumed, no cost readable.

    Previously ``cost_usd`` silently stayed 0.0 and the row was
    indistinguishable from a free call — 1016 rows in the live ledger.
    """
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    _fake_litellm(monkeypatch, _Response())  # no _hidden_params attribute at all

    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="azure/deepseek-v4-pro", db_path=db)

    row = _only_row(db)
    assert row.tokens_out == 100, "the call really happened"
    assert row.cost_usd == 0.0, "and still records zero — that part is unchanged"
    assert row.usage_reliable is False, "but the zero is now labelled as a floor"


def test_text_run_flags_unreliable_when_response_cost_is_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``_hidden_params`` present but no price computed is equally unknown."""
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    _fake_litellm(monkeypatch, _Response(hidden={"response_cost": None}))

    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="azure/deepseek-v4-pro", db_path=db)

    assert _only_row(db).usage_reliable is False


def test_text_run_reported_zero_cost_is_reliable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider that genuinely reports $0 is RELIABLE, not unknown.

    This is the distinction the None sentinel buys: "reported 0.0" and "could
    not read a cost" are different facts and must not collapse together.
    """
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    _fake_litellm(monkeypatch, _Response(hidden={"response_cost": 0.0}))

    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="azure/deepseek-v4-pro", db_path=db)

    row = _only_row(db)
    assert row.cost_usd == 0.0
    assert row.usage_reliable is True


def test_text_run_dry_run_records_neither_flag(tmp_path: Path) -> None:
    """No call attempted → both flags stay NULL (not applicable), not False."""
    db = tmp_path / "state" / "factory.db"
    text_run(persona="sm", prompt="hi", model_id="stub/model", dry_run=True, db_path=db)
    row = _only_row(db)
    assert row.usage_reliable is None
    assert row.premodel_infra is None


def test_text_run_missing_api_key_records_premodel_infra(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AZURE_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_AI_API_KEY", raising=False)
    db = tmp_path / "state" / "factory.db"
    with pytest.raises(RuntimeError):
        text_run(persona="sm", prompt="hi", model_id="azure/deepseek-v4-pro", db_path=db)
    row = _only_row(db)
    assert row.premodel_infra is True
    assert row.usage_reliable is None, "no call was made; there is no usage to judge"


# --------------------------------------------------------------------------- #
# Silent-$0 guard — 2026-08-08: an unpriced model must WARN, not read as free
# --------------------------------------------------------------------------- #


def test_record_run_warns_loudly_on_unpriced_model_with_real_usage(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The exact live bug: a model with no LiteLLM price burns real tokens
    and lands cost_usd=0.0. usage_reliable=False already carries the honest
    signal (set by text_run/sandbox_run when the provider's cost read
    fails) — this asserts it is also made LOUD, naming the model and token
    counts, instead of only being visible to a ``factory audit`` deep-dive.
    """
    import logging

    db = tmp_path / "factory.db"
    with caplog.at_level(logging.WARNING, logger="factory.runner"):
        _record_run(
            persona="dev",
            model="azure/some-brand-new-deployment",
            mode="sandbox",
            tokens_in=50_000,
            tokens_out=8_000,
            cost_usd=0.0,
            success=True,
            story_path=None,
            repo_path=None,
            error=None,
            db_path=db,
            usage_reliable=False,
        )
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings, "no WARNING emitted for a real call with an unreadable cost"
    msg = warnings[0].getMessage()
    assert "azure/some-brand-new-deployment" in msg
    assert "50000" in msg
    assert "8000" in msg


def test_record_run_does_not_warn_when_usage_is_reliable(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A model that genuinely reports $0.00 (usage_reliable=True) is a known
    fact, not a blind spot — no warning, no false alarm."""
    import logging

    db = tmp_path / "factory.db"
    with caplog.at_level(logging.WARNING, logger="factory.runner"):
        _record_run(
            persona="dev",
            model="azure/gpt-5.4",
            mode="text",
            tokens_in=100,
            tokens_out=10,
            cost_usd=0.0,
            success=True,
            story_path=None,
            repo_path=None,
            error=None,
            db_path=db,
            usage_reliable=True,
        )
    assert not any(r.levelno >= logging.WARNING for r in caplog.records)


def test_record_run_does_not_warn_when_no_tokens_were_spent(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A pre-model infra failure or dry-run has zero tokens AND
    usage_reliable is None/False-but-inapplicable — must not false-positive
    as an unpriced-model blind spot."""
    import logging

    db = tmp_path / "factory.db"
    with caplog.at_level(logging.WARNING, logger="factory.runner"):
        _record_run(
            persona="dev",
            model="azure/gpt-5.4",
            mode="sandbox",
            tokens_in=0,
            tokens_out=0,
            cost_usd=0.0,
            success=False,
            story_path=None,
            repo_path=None,
            error="No API key available",
            db_path=db,
            premodel_infra=True,
            usage_reliable=None,
        )
    assert not any(r.levelno >= logging.WARNING for r in caplog.records)


def test_text_run_against_an_unpriced_model_warns_via_the_real_call_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """End-to-end through ``text_run``: a model LiteLLM cannot price hits the
    same ``_hidden_params`` miss as the live ``azure/DeepSeek-V4-Flash`` /
    ``azure/Kimi-K2.7-Code`` incident, and the guard fires from the real call
    path (not just a direct ``_record_run`` call)."""
    import logging

    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    _fake_litellm(monkeypatch, _Response())  # no _hidden_params → unreadable cost

    db = tmp_path / "state" / "factory.db"
    with caplog.at_level(logging.WARNING, logger="factory.runner"):
        text_run(persona="sm", prompt="hi", model_id="azure/still-unpriced", db_path=db)

    row = _only_row(db)
    assert row.cost_usd == 0.0
    assert row.usage_reliable is False
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("azure/still-unpriced" in r.getMessage() for r in warnings)


# --------------------------------------------------------------------------- #
# sandbox_run — the SDK-shape-drift equivalent
# --------------------------------------------------------------------------- #


def _install_fake_sdk(monkeypatch: pytest.MonkeyPatch, *, report_cost: bool) -> None:
    """Fake OpenHands SDK whose metrics object may omit ``accumulated_cost``.

    ``report_cost=False`` simulates an SDK shape change: reading the cost with a
    0.0 default would make every run in the ledger silently look free.
    """

    class _FakeConversation:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def send_message(self, *_: Any, **__: Any) -> None:
            pass

        def run(self) -> None:
            pass

        def close(self) -> None:
            pass

        @property
        def conversation_stats(self) -> Any:
            class _S:
                def get_combined_metrics(self) -> Any:
                    attrs: dict[str, Any] = {
                        "accumulated_token_usage": type(
                            "U",
                            (),
                            {
                                "prompt_tokens": 1000,
                                "completion_tokens": 100,
                                "cache_read_tokens": 0,
                            },
                        )()
                    }
                    if report_cost:
                        attrs["accumulated_cost"] = 0.5
                    return type("_M", (), attrs)()

            return _S()

    fake_sdk = types.ModuleType("openhands.sdk")
    fake_sdk.LLM = type("_FakeLLM", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    fake_sdk.Conversation = _FakeConversation  # type: ignore[attr-defined]
    fake_sdk.LocalWorkspace = type(  # type: ignore[attr-defined]
        "_FakeWorkspace", (), {"__init__": lambda self, **kw: None}
    )
    monkeypatch.setitem(sys.modules, "openhands.sdk", fake_sdk)

    fake_tools = types.ModuleType("openhands.tools.preset.default")
    fake_tools.get_default_agent = lambda **_: object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.tools.preset.default", fake_tools)

    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.SecretStr = lambda s: s  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)


def _run_sandbox(tmp_path: Path, db: Path) -> Any:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    (repo / "README.md").write_text("# test\n", encoding="utf-8")
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")
    return asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/deepseek-v4-pro", api_key="x"),
            dry_run=False,
            db_path=db,
        )
    )


def test_sandbox_run_marks_usage_reliable_when_sdk_reports_cost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_sdk(monkeypatch, report_cost=True)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    db = tmp_path / "state" / "factory.db"
    result = _run_sandbox(tmp_path, db)
    row = _only_row(db)
    assert row.usage_reliable is True
    assert row.premodel_infra is False
    assert result.usage_reliable is True


def test_sandbox_run_flags_unreliable_when_sdk_drops_the_cost_field(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An SDK shape change must be visible, not silently priced at zero."""
    _install_fake_sdk(monkeypatch, report_cost=False)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    db = tmp_path / "state" / "factory.db"
    result = _run_sandbox(tmp_path, db)
    row = _only_row(db)
    assert row.tokens_out == 100, "the model really ran"
    assert row.cost_usd == 0.0
    assert row.usage_reliable is False
    assert result.usage_reliable is False


def test_sandbox_run_missing_api_key_records_premodel_infra(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for var in ("AZURE_API_KEY", "AZURE_AI_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    db = tmp_path / "state" / "factory.db"
    repo = tmp_path / "repo"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")
    result = asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="azure/deepseek-v4-pro", api_key=None),
            dry_run=False,
            db_path=db,
        )
    )
    assert result.premodel_infra is True
    row = _only_row(db)
    assert row.premodel_infra is True
    assert row.usage_reliable is None


# --------------------------------------------------------------------------- #
# Migration
# --------------------------------------------------------------------------- #


def test_new_run_columns_are_declared_for_migration() -> None:
    declared = {name for name, _ in _RUNS_NEW_COLUMNS}
    assert {"premodel_infra", "usage_reliable"} <= declared


def test_legacy_runs_table_gains_the_columns(tmp_path: Path) -> None:
    """A live factory.db predates these columns; migrate must add them."""
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE runs (id INTEGER PRIMARY KEY, ts TEXT, persona TEXT, "
        "model TEXT, mode TEXT, tokens_in INTEGER, tokens_out INTEGER, "
        "cost_usd REAL, success BOOLEAN)"
    )
    conn.execute(
        "INSERT INTO runs (id, ts, persona, model, mode, tokens_in, tokens_out, "
        "cost_usd, success) VALUES (1,'2026-01-01T00:00:00+00:00','dev','m','text',1,1,0.0,1)"
    )
    conn.commit()
    conn.close()

    migrate(db)

    conn = sqlite3.connect(str(db))
    cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
    legacy = conn.execute("SELECT premodel_infra, usage_reliable FROM runs WHERE id=1").fetchone()
    conn.close()
    assert {"premodel_infra", "usage_reliable"} <= cols
    # A backfilled row must read as UNKNOWN, never as a confident False —
    # otherwise a migration gap masquerades as a clean bill of health.
    assert legacy == (None, None)


def test_both_stories_migration_paths_apply_the_same_columns(tmp_path: Path) -> None:  # noqa: slop
    """The two independent migrators for ``stories`` must not diverge.

    ``observability.schema.migrate`` and ``chain.handlers._ensure_story_columns``
    each ALTER the same table from their own list. They had drifted, so which
    columns a live DB gained depended on which engine opened it first.
    """
    from factory.chain.handlers import _MIGRATION_COLUMNS, _ensure_story_columns

    merged = {name for name, _ in stories_migration_columns()}
    assert set(_MIGRATION_COLUMNS) <= merged, "chain columns dropped from the merged set"

    def _legacy(name: str):
        eng = create_engine(f"sqlite:///{tmp_path / name}", echo=False)
        with eng.begin() as conn:
            conn.execute(
                text(
                    "CREATE TABLE stories (id INTEGER PRIMARY KEY, app TEXT, slug TEXT, state TEXT)"
                )
            )
        return eng

    eng = _legacy("via_handlers.db")
    _ensure_story_columns(eng)
    with eng.begin() as conn:
        via_handlers = {r[1] for r in conn.execute(text("PRAGMA table_info(stories)")).fetchall()}

    db2 = tmp_path / "via_schema.db"
    _legacy("via_schema.db")
    migrate(db2)
    conn2 = sqlite3.connect(str(db2))
    via_schema = {r[1] for r in conn2.execute("PRAGMA table_info(stories)").fetchall()}
    conn2.close()

    assert merged <= via_handlers
    assert merged <= via_schema


# --------------------------------------------------------------------------- #
# The audit surface
# --------------------------------------------------------------------------- #


def test_audit_report_separates_unreliable_from_unknown(tmp_path: Path) -> None:
    from factory.settings.audit import build_audit_report

    db = tmp_path / "factory.db"
    common = dict(
        persona="dev",
        model="azure/gpt-5.4",
        mode="text",
        tokens_in=100,
        tokens_out=10,
        success=True,
        story_path=None,
        repo_path=None,
        error=None,
        db_path=db,
        story_id=7,
        app="sacrifice",
    )
    _record_run(**common, cost_usd=1.0, usage_reliable=True)
    _record_run(**common, cost_usd=0.0, usage_reliable=False)
    _record_run(**common, cost_usd=2.0)  # legacy-shaped: verdict unknown

    report = build_audit_report(tmp_path, db_path=db, days=7)

    assert report.unreliable_usage_run_count == 1
    assert report.unknown_usage_run_count == 1
    # Share of RUNS, not of dollars — the point is we don't know their dollars.
    assert report.unreliable_usage_pct == round(100.0 / 3, 2)
    # And the bucket carrying the unreadable run is marked, so the rollup
    # cannot be read as an exact total.
    story_row = next(r for r in report.by_story if r.key == "7")
    assert story_row.has_unreliable_usage is True
    assert story_row.unreliable_run_count == 1


def test_audit_report_clean_when_every_run_is_reliable(tmp_path: Path) -> None:
    """No false alarms: a fully-measured window reports zero and marks nothing."""
    from factory.settings.audit import build_audit_report

    db = tmp_path / "factory.db"
    for _ in range(3):
        _record_run(
            persona="dev",
            model="azure/gpt-5.4",
            mode="text",
            tokens_in=100,
            tokens_out=10,
            cost_usd=0.5,
            success=True,
            story_path=None,
            repo_path=None,
            error=None,
            db_path=db,
            story_id=1,
            usage_reliable=True,
        )
    report = build_audit_report(tmp_path, db_path=db, days=7)
    assert report.unreliable_usage_run_count == 0
    assert report.unreliable_usage_pct == 0.0
    assert report.unknown_usage_run_count == 0
    assert all(not r.has_unreliable_usage for r in report.by_story)
