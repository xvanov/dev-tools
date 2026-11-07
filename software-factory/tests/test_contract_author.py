"""The interface contract that dev and the dev-blind oracle both build against.

Sacrifice direction 117 asks for verification tokens that are "single-use,
short-lived, and invalidated after use" and names no route anywhere. Measured
2026-08-08, the dev-blind acceptance author responded to that in the only two
ways available to it:

* with a wrong route fact in the harness hint, it GUESSED — producing an oracle
  built on ``POST /api/auth/register``, a path that has never existed, which
  404s at HEAD however correct the implementation is (PR #266);
* with the hint corrected, it honestly DECLINED — three ``pytest.skip``s and a
  vacuous oracle.

Both block. Neither is the model's fault: nothing in the pipeline ever wrote the
interface down. These tests cover the piece that does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from factory.chain.contract import author_contract, render_markdown, write_contract
from factory.chain.route_table import Route, extract_routes, render_route_table


@dataclass
class _Direction:
    id: str = "117"
    title: str = "Add verified-email lifecycle controls"
    why: str = "Mailbox proof is foundational to account trust."
    acceptance: list[str] = field(default_factory=list)
    dir_path: Path = Path(".")


_ACS = [
    "New email/password accounts require successful verification before sensitive operations",
    "Verification tokens are single-use, short-lived, and invalidated after use",
    "Tests cover unverified vs verified authorization behavior",
]


def _payload(vb: tuple[str, str, str] = ("oracle", "oracle", "test-suite")) -> dict[str, Any]:
    return {
        "endpoints": [
            {
                "method": "POST", "path": "/api/auth/email/register", "new": False,
                "purpose": "Register an email/password account.",
                "request": '{"email": str, "password": str}',
                "response": '{"access_token": str, "user": {...}}',
                "status_codes": [{"code": "200", "when": "created", "body": '{"access_token": str, "user": {...}}'}],
            },
            {
                "method": "POST", "path": "/api/auth/email/verify", "new": True,
                "purpose": "Redeem a verification token.",
                "request": '{"token": str}',
                "response": '{"email_verified": true}',
                "status_codes": [
                    {"code": "200", "when": "token valid and unused",
                     "body": '{"email_verified": true}'},
                    {"code": "410", "when": "token already redeemed",
                     "body": '{"error": "invalid_token"}'},
                ],
            },
        ],
        "criteria": [
            {
                "criterion": _ACS[0], "verified_by": vb[0],
                "how": "Register, then call a sensitive route; expect 403 until verified.",
                "endpoints": ["/api/auth/email/register"],
            },
            {
                "criterion": _ACS[1], "verified_by": vb[1],
                "how": "Redeem the token twice; second call returns 410.",
                "endpoints": ["/api/auth/email/verify"],
            },
            {
                "criterion": _ACS[2], "verified_by": vb[2],
                "how": "Compare the sensitive route before and after verification.",
                "endpoints": ["/api/auth/me"],
            },
        ],
        "security_notes": "The token is returned in the register response only when "
        "SACRIFICE_EXPOSE_VERIFICATION_TOKEN is set, which production never sets.",
    }


def _runner(payload: dict[str, Any], captured: dict[str, Any] | None = None) -> Any:
    def _text_run(**kwargs: Any) -> dict[str, Any]:
        if captured is not None:
            captured.update(kwargs)
        return payload

    return _text_run


# --------------------------------------------------------------------------- #
# route table — the anti-fabrication input
# --------------------------------------------------------------------------- #


def test_router_prefix_is_joined_onto_each_path(tmp_path: Path) -> None:
    """The exact bug PR #266 had to hand-correct: dropping the prefix turns
    ``/api/auth/email/register`` into something that does not exist."""
    src = tmp_path / "app" / "routes"
    src.mkdir(parents=True)
    (src / "auth.py").write_text(
        'router = APIRouter(prefix="/api/auth", tags=["auth"])\n'
        '@router.post("/email/register", response_model=AuthResponse)\n'
        "def email_register(): ...\n"
        '@router.get("/me")\n'
        "def me(): ...\n",
        encoding="utf-8",
    )
    paths = {r.path for r in extract_routes(tmp_path)}
    assert "/api/auth/email/register" in paths
    assert "/api/auth/me" in paths
    assert "/api/auth/register" not in paths, "the fabricated path must not appear"


def test_extract_routes_never_raises_on_a_missing_tree() -> None:
    assert extract_routes(Path("/nonexistent-tree-xyz")) == []


def test_render_route_table_is_explicit_when_empty() -> None:
    assert "UNVERIFIED" in render_route_table([])


def test_render_route_table_lists_method_path_and_source() -> None:
    rendered = render_route_table([Route("GET", "/api/health", "app/routes/health.py")])
    assert "GET" in rendered and "/api/health" in rendered and "health.py" in rendered


# --------------------------------------------------------------------------- #
# gradeability verdict
# --------------------------------------------------------------------------- #


def test_oracle_plus_test_suite_criteria_are_gradeable(tmp_path: Path) -> None:
    """AC3 of sacrifice 117 ("tests cover X") is verified by the test suite, not
    the oracle. That must NOT read as unbuildable."""
    res = author_contract(
        direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="- base url is $ACCEPTANCE_BASE_URL",
        text_run=_runner(_payload()),
        model_id="stub/model",
    )
    assert res.gradeable is True
    assert res.ungradeable_criteria == []
    assert res.blocked_reason == ""
    assert len(res.oracle_criteria) == 2
    assert res.other_gate_criteria == [_ACS[2]]


def test_one_unobservable_criterion_blocks_the_direction(tmp_path: Path) -> None:
    """This is the whole point: prove unbuildability for cents, before stories."""
    res = author_contract(
        direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="",
        text_run=_runner(_payload(vb=("oracle", "none", "test-suite"))),
        model_id="stub/model",
    )
    assert res.gradeable is False
    assert len(res.ungradeable_criteria) == 1
    assert "single-use" in res.ungradeable_criteria[0]
    assert "cannot be verified by anything the pipeline runs" in res.blocked_reason


def test_a_silently_dropped_criterion_is_not_a_pass(tmp_path: Path) -> None:
    """CONTROL — coverage is checked against the DIRECTION's criteria.

    An author that simply omits a criterion would otherwise report a clean
    gradeable verdict for a spec it never considered.
    """
    payload = _payload()
    payload["criteria"] = payload["criteria"][:2]  # drops AC3
    res = author_contract(
        direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="",
        text_run=_runner(payload),
        model_id="stub/model",
    )
    assert res.gradeable is False
    assert any("not addressed" in c for c in res.ungradeable_criteria)


def test_verbatim_drift_does_not_read_as_a_dropped_criterion(tmp_path: Path) -> None:
    """Re-wrapping or a stray period must not block an otherwise good contract."""
    payload = _payload()
    payload["criteria"][0]["criterion"] = "  New email/password accounts require  successful "
    payload["criteria"][0]["criterion"] += "verification before sensitive operations."
    res = author_contract(
        direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="",
        text_run=_runner(payload),
        model_id="stub/model",
    )
    assert res.gradeable is True


def test_non_dict_response_raises_rather_than_writing_a_broken_contract(tmp_path: Path) -> None:
    res_fn = lambda **_: "not a dict"  # noqa: E731
    with pytest.raises(ValueError, match="expected dict"):
        author_contract(
            direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
            app_repo_path=tmp_path,
            harness_hint="",
            text_run=res_fn,
            model_id="stub/model",
        )


# --------------------------------------------------------------------------- #
# the prompt, and what lands on disk
# --------------------------------------------------------------------------- #


def test_prompt_carries_the_real_route_table_and_the_criteria(tmp_path: Path) -> None:
    src = tmp_path / "app"
    src.mkdir()
    (src / "r.py").write_text(
        'router = APIRouter(prefix="/api/auth")\n@router.post("/email/login")\ndef x(): ...\n',
        encoding="utf-8",
    )
    captured: dict[str, Any] = {}
    author_contract(
        direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="- auth is JSON",
        text_run=_runner(_payload(), captured),
        model_id="stub/model",
    )
    prompt = captured["prompt"]
    assert "/api/auth/email/login" in prompt, "the parsed route table must reach the author"
    assert _ACS[1] in prompt, "criteria must be verbatim in the prompt"
    assert "- auth is JSON" in prompt
    assert captured["persona"] == "contract"


def test_markdown_marks_new_versus_existing_and_flags_unobservable() -> None:
    md = render_markdown("D117", _payload(vb=("oracle", "none", "test-suite")))
    assert "`POST /api/auth/email/verify`" in md and "**(new)**" in md
    assert "_(existing)_" in md
    assert "NOT VERIFIABLE" in md
    assert "verified by the implementation's own test suite" in md
    assert "SACRIFICE_EXPOSE_VERIFICATION_TOKEN" in md


def test_written_file_is_api_spec_md_so_both_consumers_pick_it_up(tmp_path: Path) -> None:
    """``has_api_spec`` is existence+size, and both SM and the acceptance author
    read that file — so writing it is the entire integration."""
    path = write_contract(tmp_path, render_markdown("D117", _payload()))
    assert path.name == "api_spec.md"
    assert path.stat().st_size > 0

    from factory.directions.parser import parse_direction_dir

    (tmp_path / "direction.md").write_text(
        "---\ntitle: t\ntype: feature\npriority: p2\n---\n\n# t\n\n## Why\n\nw\n\n"
        "## Acceptance Criteria\n\n- [ ] a\n",
        encoding="utf-8",
    )
    parsed = parse_direction_dir("sacrifice", tmp_path, software_factory_root=tmp_path)
    assert parsed.has_api_spec is True


def test_all_criteria_delegated_elsewhere_is_still_a_block(tmp_path: Path) -> None:
    """CONTROL — if nothing is oracle-graded, the oracle has nothing to grade.

    That is the vacuous-oracle block, arriving before a story is built instead
    of after a dev sandbox has been paid for.
    """
    res = author_contract(
        direction=_Direction(acceptance=_ACS, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="",
        text_run=_runner(_payload(vb=("test-suite", "test-suite", "test-suite"))),
        model_id="stub/model",
    )
    assert res.gradeable is False
    assert "vacuous" in res.blocked_reason


def test_status_code_bodies_are_rendered_so_the_implementer_can_see_them() -> None:
    """The fix for sacrifice 117's review ping-pong.

    A contract that lists status codes without their bodies leaves the
    implementer guessing: it picks a shape, the reviewer calls it a contract
    violation, it picks the opposite, and the reviewer objects again. Story 177
    reached ``blocked_review_nonconvergent`` with an unmoved score across two
    cycles for exactly this reason — the contract said the verify-request token
    must be hidden outside non-production but never said what the body IS when
    hidden.
    """
    md = render_markdown("D117", _payload())
    assert '{"access_token": str, "user": {...}}' in md
    assert '{"error": "invalid_token"}' in md
    assert "body:" in md


def test_a_status_code_without_a_body_still_renders_rather_than_crashing() -> None:
    """CONTROL — the schema requires ``body``, but a legacy/hand-written payload
    must degrade to the old rendering, never raise."""
    payload = _payload()
    payload["endpoints"][0]["status_codes"] = [{"code": "200", "when": "created"}]
    md = render_markdown("D117", payload)
    assert "`200` — created" in md


def test_markdown_in_a_criterion_does_not_read_as_unaddressed(tmp_path: Path) -> None:
    """A FALSE block, measured on direction 120.

    Directions are markdown, so criteria routinely carry backticks around a
    route. The contract author quotes the prose. Before this, the mismatch made
    a fully addressed criterion read as "(not addressed by the contract author)"
    and blocked the direction as ungradeable.
    """
    acs = [
        "`GET /api/goals/count` returns the authenticated caller's own goal total",
        "**An unauthenticated request** is rejected rather than returning a count",
    ]
    payload = {
        "endpoints": [],
        "security_notes": "",
        "criteria": [
            {
                "criterion": "GET /api/goals/count returns the authenticated caller's own goal total",
                "verified_by": "oracle", "how": "call it", "endpoints": ["/api/goals/count"],
            },
            {
                "criterion": "An unauthenticated request is rejected rather than returning a count",
                "verified_by": "oracle", "how": "call it without a token", "endpoints": ["/api/goals/count"],
            },
        ],
    }
    res = author_contract(
        direction=_Direction(acceptance=acs, dir_path=tmp_path),
        app_repo_path=tmp_path,
        harness_hint="",
        text_run=_runner(payload),
        model_id="stub/model",
    )
    assert res.gradeable is True, res.ungradeable_criteria
    assert res.ungradeable_criteria == []


def test_a_genuinely_missing_criterion_is_still_caught(tmp_path: Path) -> None:
    """CONTROL — loosening the match must not blind the coverage check."""
    payload = {
        "endpoints": [], "security_notes": "",
        "criteria": [{"criterion": "something else entirely", "verified_by": "oracle",
                      "how": "x", "endpoints": []}],
    }
    res = author_contract(
        direction=_Direction(acceptance=["`GET /api/goals/count` returns the total"], dir_path=tmp_path),
        app_repo_path=tmp_path, harness_hint="", text_run=_runner(payload), model_id="stub/model",
    )
    assert res.gradeable is False
    assert any("not addressed" in c for c in res.ungradeable_criteria)
