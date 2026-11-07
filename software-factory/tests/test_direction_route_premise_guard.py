"""A machine-filed direction must not ask for a route the app already has.

The recurrence this pins
------------------------
2026-08-08: the scheduled ``security`` persona had re-filed password reset five
times (d094, d098, d108, d113, 118) off one stale bullet in sacrifice's
``context/modules/security.md``. That bullet was corrected (sacrifice PR #382)
and the memory ``stale_context_doc_refiles_shipped_work`` recorded the cure:
"check the route table, then fix the doc".

2026-08-10T15:34: the same persona filed directions 126–130. Two of them rest on
the same false premise, because the doc fix landed in ONE file and the identical
sentence survived in two others the same persona reads —
``context/current-state.md`` ("no password reset flow") and
``context/modules/auth.md`` ("lacks … password reset and email verification").

Fixing prose cannot be the whole cure: nothing bounds how many docs hold a stale
sentence, and the persona is a ``text_run`` with no tools, so it cannot check one
of its own claims. The mechanical half is
``factory.directions.route_premise``, which asks the derived route table —
``apps/<app>/derived/api_surface.json``, AST-parsed from the real app tree — and
``factory approve-direction``, which refuses once before any spend.

Why these assertions are not vacuous
------------------------------------
Every claim here is anchored to an artifact that exists independently of this
test (memory: ``criterion_vacuity_is_the_second_sensor_failure``):

* the five ``direction.md`` files as the persona wrote them, committed alongside
  this test;
* the committed ``api_surface.json`` snapshot;
* the persona prompt, asserted together with the artifact it points at — a
  prompt naming a route table that does not exist would fail;
* the ``text_run`` prompt actually dispatched, not the prompt file, because an
  instruction the persona never receives is worth nothing;
* negative controls throughout: a route that genuinely does not exist must NOT
  be flagged, and a clean direction must approve without the override.
"""

from __future__ import annotations

import importlib
import json
import os
import re
from pathlib import Path
from typing import Any

import pytest
import yaml
from sqlmodel import SQLModel, create_engine
from typer.testing import CliRunner

from factory.directions.parser import parse_direction_dir
from factory.directions.route_premise import (
    check_direction_route_premises,
    find_shipped_route_claims,
    load_api_surface,
    render_route_table_block,
    route_segments,
)

_ROOT = Path(__file__).resolve().parents[1]
_DIRECTIONS = _ROOT / "apps" / "sacrifice" / "directions"
_SECURITY_PERSONA = _ROOT / "factory" / "personas" / "security.md"

#: The 2026-08-10T15:34 scheduled-security filing batch, verbatim on disk.
_BATCH = {
    "126": "126-add-email-verification-and-password-reset",
    "127": "127-harden-token-lifecycle-and-local-storage",
    "128": "128-add-session-invalidation-and-logout-all",
    "129": "129-improve-secrets-encryption-key-management",
    "130": "130-protect-cli-bearer-token-with-os-keychain",
}

#: Routes that existed in sacrifice on the day those directions were filed,
#: verified against ``backend/app/routes/auth.py`` decorator lines 714/728/751
#: at sacrifice@5799cee.
_ALREADY_SHIPPED = (
    "POST /api/auth/password/reset/request",
    "POST /api/auth/password/reset/confirm",
    "POST /api/auth/logout",
)


def _batch_claims(direction_id: str) -> list[str]:
    ddir = _DIRECTIONS / _BATCH[direction_id]
    assert ddir.is_dir(), (
        f"{ddir} is missing. The five 2026-08-10 filings are committed as the "
        "evidence this guard was built from; without them this test is vacuous."
    )
    direction = parse_direction_dir("sacrifice", ddir, software_factory_root=_ROOT)
    claims = check_direction_route_premises(direction, _ROOT)
    assert claims is not None, "sacrifice must ship a derived api_surface.json"
    return [c.route for c in claims]


# --------------------------------------------------------------------------- #
# The route table itself
# --------------------------------------------------------------------------- #


def test_the_denied_routes_really_are_in_the_derived_surface() -> None:
    """Ground truth. Everything below is worthless if this snapshot lacks them."""
    routes = load_api_surface("sacrifice", _ROOT)
    assert routes, "sacrifice ships no derived route table"
    labels = {f"{str(r['method']).upper()} {r['path']}" for r in routes}
    for route in _ALREADY_SHIPPED:
        assert route in labels, (
            f"{route} is absent from apps/sacrifice/derived/api_surface.json. "
            "Either the snapshot is stale (regenerate it) or the route was "
            "removed — verify against backend/app/routes/auth.py before "
            "weakening this test."
        )


def test_route_segments_drops_the_generic_prefix() -> None:
    assert route_segments("/api/auth/password/reset/request") == ("password", "reset", "request")
    assert route_segments("/api/auth/logout") == ("logout",)
    # A single generic resource is deliberately unmatchable: one word must never
    # be able to flag every direction that mentions a goal.
    assert route_segments("/api/goals") == ()
    assert route_segments("/api/goals/{goal_id}") == ()
    assert route_segments("/healthz") == ()


# --------------------------------------------------------------------------- #
# The real filings — this is what the guard would have caught
# --------------------------------------------------------------------------- #


def test_direction_126_asks_for_the_password_reset_routes_that_exist() -> None:
    claims = _batch_claims("126")
    assert "POST /api/auth/password/reset/request" in claims
    assert "POST /api/auth/password/reset/confirm" in claims


def test_direction_128_asks_for_the_logout_route_that_exists() -> None:
    assert "POST /api/auth/logout" in _batch_claims("128")


def test_directions_129_and_130_are_left_alone() -> None:
    """The negative control that makes the two above mean something.

    Both are real gaps: sacrifice derives its Fernet key from ``jwt_secret``
    with no KMS and no key version (``backend/app/core/crypto.py``), and the CLI
    writes the bearer token in plaintext to ``~/.config/sacrifice/config.json``
    (``backend/cli/client.py:35``). A guard that flagged these would be a guard
    that flags everything.
    """
    assert _batch_claims("129") == []
    assert _batch_claims("130") == []


def test_direction_127_is_not_flagged_because_hardening_presupposes_the_route() -> None:
    """A documented limit, pinned so it cannot drift silently.

    127 ("Harden token lifecycle and local storage") names refresh-token
    rotation, which ``POST /api/auth/refresh`` already does
    (``backend/app/routes/auth.py:702`` calls ``rotate_auth_session``). It is
    still not flagged: its title carries no ADD verb, and a harden/improve
    direction correctly presupposes the route exists. Widening the guard to
    catch it would flag every legitimate hardening direction, so the check stays
    narrow and this test records the trade.
    """
    assert _batch_claims("127") == []


# --------------------------------------------------------------------------- #
# The matcher's polarity — a missing route must NOT be flagged
# --------------------------------------------------------------------------- #


def test_a_route_that_does_not_exist_is_never_flagged() -> None:
    routes = load_api_surface("sacrifice", _ROOT)
    assert routes is not None
    # Email verification IS the one real gap in direction 126: no verification
    # route exists and there is no email transport anywhere in backend/app.
    labels = {r["path"] for r in routes}
    assert not any("verify" in p for p in labels), (
        "sacrifice grew a verification route — re-derive this test's premise"
    )
    claims = find_shipped_route_claims(
        ["Add POST /api/auth/email/verify so registration proves mailbox ownership"],
        routes,
    )
    assert claims == []


def test_only_title_and_acceptance_count_as_claims() -> None:
    routes = load_api_surface("sacrifice", _ROOT)
    assert routes is not None
    # No ADD verb anywhere -> nothing is being asked for.
    assert find_shipped_route_claims(["Audit the password reset flow"], routes) == []
    # The same words with an ADD verb -> a claim.
    assert find_shipped_route_claims(["Add a password reset flow"], routes)


# --------------------------------------------------------------------------- #
# The persona prompt — asserted together with the artifact it names
# --------------------------------------------------------------------------- #


def test_security_persona_requires_a_route_citation() -> None:
    prompt = _SECURITY_PERSONA.read_text(encoding="utf-8")
    assert "Derived route table" in prompt, (
        "the security persona must be told the route table exists"
    )
    assert "route table" in prompt.lower()
    assert re.search(r"never claim an endpoint or flow is missing", prompt, re.IGNORECASE), (
        "the persona must be forbidden from claiming an endpoint is missing "
        "without checking the route table"
    )
    assert "evidence" in prompt, "the citation has to land somewhere checkable"


def test_the_rendered_route_table_carries_the_routes_the_docs_denied() -> None:
    """Pairs the prompt rule with the artifact — prose alone would be vacuous."""
    block = render_route_table_block("sacrifice", _ROOT)
    for route in _ALREADY_SHIPPED:
        method, path = route.split(" ", 1)
        assert f"`{method} {path}`" in block, f"{route} missing from the rendered table"
    assert "outranks every prose context doc" in block


def test_route_table_block_says_unavailable_rather_than_clean(tmp_path: Path) -> None:
    """An app with no snapshot must not read as 'no routes exist'."""
    block = render_route_table_block("nosuchapp", tmp_path)
    assert "NOT AVAILABLE" in block
    assert "do NOT claim any endpoint is missing" in block


def test_the_route_table_reaches_the_dispatched_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The persona has no tools: an instruction to check the table is only
    enforceable if the table is in the prompt ``text_run`` actually sends."""
    from factory.chain.scheduled_tasks import _live_run

    app_dir = tmp_path / "apps" / "sacrifice"
    (app_dir / "derived").mkdir(parents=True)
    (app_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: x/y\ndefault_branch: main\ncontext_dir: context\nmodels: {}\n",
        encoding="utf-8",
    )
    (app_dir / "derived" / "api_surface.json").write_text(
        json.dumps(
            {
                "app": "sacrifice",
                "source_commit": "deadbeef",
                "routes": [{"method": "POST", "path": "/api/auth/password/reset/request"}],
            }
        ),
        encoding="utf-8",
    )

    captured: dict[str, Any] = {}

    def _fake_text_run(_persona: str, prompt: str, _model: str, **_kwargs: Any) -> dict[str, Any]:
        captured["prompt"] = prompt
        return {"findings": []}

    monkeypatch.setattr("factory.context.loader.compose_context_prelude", lambda *a, **k: "PRELUDE")
    monkeypatch.setattr("factory.runner.text_run", _fake_text_run)
    monkeypatch.setattr("factory.chain.scheduled_tasks.route", lambda _p: "fake-model")

    _live_run("security", "sacrifice", tmp_path)

    prompt = str(captured["prompt"])
    assert "Derived route table" in prompt
    assert "`POST /api/auth/password/reset/request`" in prompt
    assert "# Context prelude\n\nPRELUDE" in prompt


# --------------------------------------------------------------------------- #
# The gate — refuse once, before any spend
# --------------------------------------------------------------------------- #


def _seed_root(tmp_path: Path, *, routes: list[dict[str, str]]) -> Path:
    app_dir = tmp_path / "apps" / "sacrifice"
    (app_dir / "derived").mkdir(parents=True, exist_ok=True)
    (app_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\ndefault_branch: main\n"
        "context_dir: context\ndeploy:\n  enabled: false\nmodels: {}\n",
        encoding="utf-8",
    )
    (app_dir / "derived" / "api_surface.json").write_text(
        json.dumps({"app": "sacrifice", "source_commit": "cafe1234", "routes": routes}),
        encoding="utf-8",
    )
    (tmp_path / "factory_settings.yaml").write_text(
        "auto_pm_sync:\n  enabled: true\nrate_limits:\n  pm_invocations_per_hour: 4\n",
        encoding="utf-8",
    )
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return tmp_path


def _file(root: Path, *, title: str, acceptance: list[str]):
    from factory.directions.creator import create_direction

    return create_direction(
        app="sacrifice",
        title=title,
        type_tag="security",
        why="Filed by the scheduled security persona.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=acceptance,
        explore=True,
        attach_files=None,
        software_factory_root=root,
        source="scheduled-security",
    )


def _cli(root: Path) -> tuple[CliRunner, Any]:
    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


@pytest.fixture
def gate_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FACTORY_WEBHOOK_LAZY", "1")
    monkeypatch.setenv("COLUMNS", "240")
    monkeypatch.setenv("TERM", "xterm-256color")
    return _seed_root(
        tmp_path, routes=[{"method": "POST", "path": "/api/auth/password/reset/request"}]
    )


def test_approve_refuses_a_direction_that_re_files_a_shipped_route(gate_root: Path) -> None:
    created = _file(
        gate_root,
        title="Add password reset",
        acceptance=["Password reset uses a time-limited signed token."],
    )
    runner, cli_mod = _cli(gate_root)

    result = runner.invoke(
        cli_mod.app,
        ["approve-direction", created.direction.id, "--app", "sacrifice", "--by", "kalin"],
    )

    assert result.exit_code == 3, result.stdout
    assert "ALREADY EXIST" in result.stdout
    assert "/api/auth/password/reset/request" in result.stdout
    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert "operator_approval" not in state, "a refused approval must not be recorded"


def test_the_override_approves_and_records_which_routes_were_overridden(gate_root: Path) -> None:
    created = _file(
        gate_root,
        title="Add password reset",
        acceptance=["Password reset uses a time-limited signed token."],
    )
    runner, cli_mod = _cli(gate_root)

    result = runner.invoke(
        cli_mod.app,
        [
            "approve-direction",
            created.direction.id,
            "--app",
            "sacrifice",
            "--by",
            "kalin",
            "--acknowledge-shipped-routes",
            "--note",
            "the route exists but mints a token and discards it",
        ],
    )

    assert result.exit_code == 0, result.stdout
    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    record = state["operator_approval"]
    assert record["approved"] is True
    assert record["acknowledged_shipped_routes"] == ["POST /api/auth/password/reset/request"]


def test_a_direction_with_no_shipped_route_claim_still_approves_normally(
    gate_root: Path,
) -> None:
    """The control. A gate that blocks everything is not a gate."""
    created = _file(
        gate_root,
        title="Add email verification on registration",
        acceptance=["Registration sends a verification email before goal mutations."],
    )
    runner, cli_mod = _cli(gate_root)

    result = runner.invoke(
        cli_mod.app,
        ["approve-direction", created.direction.id, "--app", "sacrifice", "--by", "kalin"],
    )

    assert result.exit_code == 0, result.stdout
    state = yaml.safe_load((created.dir_path / "state.yaml").read_text(encoding="utf-8"))
    assert state["operator_approval"]["approved"] is True
    assert "acknowledged_shipped_routes" not in state["operator_approval"]


def test_an_app_without_a_route_table_is_told_so_not_waved_through(tmp_path: Path) -> None:
    """``None`` means unchecked. Silence would read as an all-clear."""
    root = _seed_root(tmp_path, routes=[])
    (root / "apps" / "sacrifice" / "derived" / "api_surface.json").unlink()
    created = _file(root, title="Add password reset", acceptance=["It works."])
    runner, cli_mod = _cli(root)

    result = runner.invoke(
        cli_mod.app,
        ["approve-direction", created.direction.id, "--app", "sacrifice", "--by", "kalin"],
    )

    assert result.exit_code == 0, result.stdout
    assert "did NOT run" in result.stdout


def test_the_pending_listing_shows_which_directions_re_file_shipped_routes(
    gate_root: Path,
) -> None:
    _file(
        gate_root,
        title="Add password reset",
        acceptance=["Password reset uses a time-limited signed token."],
    )
    runner, cli_mod = _cli(gate_root)

    listing = runner.invoke(cli_mod.app, ["approve-direction"])

    assert listing.exit_code == 0, listing.stdout
    assert "routes it asks for" in listing.stdout
    assert "ALREADY EXIST" in listing.stdout


# --------------------------------------------------------------------------- #
# The prose half of the cure — needs the app checkout, so local-only
# --------------------------------------------------------------------------- #


def _app_repo() -> Path:
    """The sacrifice checkout, resolved exactly as the chain resolves it.

    ``apps/sacrifice/config.yaml`` carries ``app_repo_path: "../sacrifice"``, which
    is what every ``compose_context_prelude`` call already uses — so this test
    reads the same docs the persona reads, rather than a path hardcoded here.
    ``SACRIFICE_REPO_PATH`` overrides it, which is how a candidate doc fix can be
    proven green from a clone before it is merged into the operator's tree.
    """
    override = os.environ.get("SACRIFICE_REPO_PATH")
    if override:
        return Path(override)
    from factory.app_config import load_app_config, resolve_app_repo_path

    return resolve_app_repo_path(load_app_config("sacrifice", _ROOT), _ROOT)


#: ``(doc, phrase, route that disproves it)``. Each phrase is a real sentence
#: that was on disk on 2026-08-10 and each route is in the derived surface, so
#: this table cannot be satisfied by rewording — only by the docs agreeing with
#: the route table.
_STALE_DENIALS = (
    ("context/current-state.md", "no password reset flow", "POST /api/auth/password/reset/request"),
    (
        "context/modules/auth.md",
        "such as password reset and email verification",
        "POST /api/auth/password/reset/request",
    ),
)


@pytest.mark.parametrize(("doc", "phrase", "route"), _STALE_DENIALS)
def test_app_context_docs_do_not_deny_a_route_the_surface_has(
    doc: str, phrase: str, route: str
) -> None:
    app_repo = _app_repo()
    if not (app_repo / "context").is_dir():
        pytest.skip(f"needs the sacrifice checkout at {app_repo}; CI never has it")

    routes = load_api_surface("sacrifice", _ROOT)
    assert routes is not None
    labels = {f"{str(r['method']).upper()} {r['path']}" for r in routes}
    assert route in labels, f"{route} vanished from the derived surface"

    text = (app_repo / doc).read_text(encoding="utf-8")
    assert phrase.lower() not in text.lower(), (
        f"{doc} still says {phrase!r} while the derived route table has {route}. "
        "The scheduled security persona reads this file and re-files the work: "
        "d094/d098/d108/d113/118, then 126 and 128."
    )
