"""019 AC2 — the gutted-implementation control.

Two layers get their own coverage here: the stub server itself
(``factory.chain.stub_server``, pure stdlib) and the crediting algebra
(``red_green.verdict_over``) that decides which criteria a HEAD green is
allowed to be credited for. The gate's end-to-end wiring of both is covered in
``test_acceptance_oracle_green_means_something.py`` and
``test_acceptance_oracle_out_of_process.py``.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from factory.chain import stub_server
from factory.chain.red_green import verdict_over

# --------------------------------------------------------------------------- #
# the stub server
# --------------------------------------------------------------------------- #


def test_stub_answers_every_method_with_a_fixed_200(tmp_path: Path) -> None:
    with stub_server.stub_app() as stub:
        client = httpx.Client(base_url=stub.base_url, timeout=5)
        for method, path in [
            ("GET", "/anything"), ("POST", "/x"), ("PUT", "/y"),
            ("PATCH", "/z"), ("DELETE", "/w"), ("OPTIONS", "/o"),
        ]:
            resp = client.request(method, path)
            assert resp.status_code == 200, (method, path, resp.status_code)
            if method != "HEAD":
                assert resp.json() == {}
        head = client.head("/health")
        assert head.status_code == 200
        assert head.content == b""
    assert stub.request_count == 7


def test_stub_drains_the_request_body_so_keepalive_survives(tmp_path: Path) -> None:
    """A body left undrained poisons the NEXT request on a keep-alive
    connection — httpx sees a connection reset that looks like a real
    discriminating failure rather than a harness bug."""
    with stub_server.stub_app() as stub:
        client = httpx.Client(base_url=stub.base_url, timeout=5)
        big_payload = {"email": "x" * 5000, "note": "y" * 5000}
        for _ in range(5):
            resp = client.post("/normalize", json=big_payload)
            assert resp.status_code == 200
            assert resp.json() == {}
    assert stub.request_count == 5


def test_stub_records_requests_and_is_capped(tmp_path: Path) -> None:
    with stub_server.stub_app() as stub:
        client = httpx.Client(base_url=stub.base_url, timeout=5)
        for i in range(5):
            client.get(f"/r{i}")
    assert stub.request_count == 5
    assert stub.requests == [f"GET /r{i}" for i in range(5)]


def test_stub_torn_down_even_when_the_body_raises() -> None:
    port_holder: dict[str, str] = {}
    with pytest.raises(RuntimeError):
        with stub_server.stub_app() as stub:
            port_holder["url"] = stub.base_url
            raise RuntimeError("boom")
    # The port must be free again — connecting now must fail outright.
    with pytest.raises(httpx.ConnectError):
        httpx.get(port_holder["url"] + "/health", timeout=1)


# --------------------------------------------------------------------------- #
# verdict_over — the crediting algebra, in isolation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("credited", "base", "expected"),
    [
        # K empty -> unknown (belt-and-braces; the gate's own vacuous_oracle
        # check should already have caught this before paying for a boot).
        ([], {}, "unknown"),
        # A single credited criterion FAILS at base -> red -> credit.
        (["ac1"], {"ac1": "FAIL"}, "red"),
        # Every credited criterion already passes at base -> green.
        (["ac1", "ac2"], {"ac1": "PASS", "ac2": "PASS"}, "green"),
        # Mixed: one FAIL is enough, even with others passing.
        (["ac1", "ac2"], {"ac1": "FAIL", "ac2": "PASS"}, "red"),
        # ERROR at base is NOT red — same reason base_verdict excludes it.
        (["ac1"], {"ac1": "ERROR"}, "unknown"),
        # SKIP/MISSING at base -> never red, and not uniformly PASS either.
        (["ac1"], {"ac1": "SKIP"}, "unknown"),
        (["ac1"], {}, "unknown"),  # MISSING
        # Mixed ERROR + PASS (no FAIL) -> unknown, not green (not ALL pass).
        (["ac1", "ac2"], {"ac1": "ERROR", "ac2": "PASS"}, "unknown"),
    ],
)
def test_verdict_over_table(credited, base, expected) -> None:
    verdict, _reason = verdict_over(credited, base)
    assert verdict == expected


def test_verdict_over_names_the_failed_criteria_in_its_reason() -> None:
    verdict, reason = verdict_over(["ac1", "ac2"], {"ac1": "FAIL", "ac2": "FAIL"})
    assert verdict == "red"
    assert "ac1" in reason or "ac2" in reason


# --------------------------------------------------------------------------- #
# the crediting decision as it appears in the gate's per-criterion table
# (the core §4.2 test: an excluded criterion's base-red is NOT evidence)
# --------------------------------------------------------------------------- #


def _credited_set(head: dict[str, str], stub: dict[str, str]) -> set[str]:
    """The exact rule ``gates.acceptance_verified`` applies."""
    return {c for c, outcome in head.items() if outcome == "PASS" and stub.get(c) in ("FAIL", "ERROR")}


def test_status_only_criterion_is_excluded_status_only_check() -> None:
    """A criterion satisfiable by a bare status-code check passes the stub too."""
    head = {"ac1": "PASS"}
    stub = {"ac1": "PASS"}  # the no-op stub also returns the "right" status
    assert _credited_set(head, stub) == set()


def test_absence_only_criterion_is_excluded() -> None:
    """"the response does not contain an error field" is satisfied by {} too."""
    head = {"ac1": "PASS"}
    stub = {"ac1": "PASS"}
    assert _credited_set(head, stub) == set()


def test_mixed_set_credits_only_the_discriminating_criterion() -> None:
    """One real assertion (ac2) among tautologies (ac1, ac3): only ac2 credits."""
    head = {"ac1": "PASS", "ac2": "PASS", "ac3": "PASS"}
    stub = {"ac1": "PASS", "ac2": "FAIL", "ac3": "PASS"}
    assert _credited_set(head, stub) == {"ac2"}


def test_excluded_criterions_base_red_is_not_evidence_the_lazy_reconciliation_bug() -> None:
    """THE CORE TEST (§4.2): ac1 is RED at the base (looks like great evidence!)
    but it ALSO passes the stub, so it must be EXCLUDED — a lazy "any criterion
    red at base" reconciliation would credit this and be wrong. Only ac2 (which
    fails the stub) may license the credit, and the base verdict must be
    computed OVER {ac2} only."""
    head = {"ac1": "PASS", "ac2": "PASS"}
    stub = {"ac1": "PASS", "ac2": "FAIL"}  # ac1 excluded, ac2 credited
    credited = _credited_set(head, stub)
    assert credited == {"ac2"}

    base_if_reconciled_lazily = {"ac1": "FAIL", "ac2": "PASS"}
    verdict, _ = verdict_over(credited, base_if_reconciled_lazily)
    # Graded over {ac2} ONLY: ac2 passes at base too -> green, not red. A gate
    # that graded over the WHOLE criterion set (including the excluded ac1)
    # would have wrongly called this "red" off ac1's irrelevant base failure.
    assert verdict == "green"


def test_zero_credited_after_exclusion_is_unknown_not_a_free_pass() -> None:
    head = {"ac1": "PASS"}
    stub = {"ac1": "PASS"}
    credited = _credited_set(head, stub)
    assert credited == set()
    verdict, reason = verdict_over(credited, {"ac1": "FAIL"})
    assert verdict == "unknown"
    assert "empty" in reason
