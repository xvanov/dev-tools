"""``factory.backpressure.vacuity`` — the vacuity classifier (019 AC1 / Flow A).

Cases are drawn straight from ``flow.md``'s two example lists plus the
password-reset incident named in the direction's ``Why`` section.
"""

from __future__ import annotations

import pytest

from factory.backpressure.vacuity import (
    CriterionClass,
    assess_direction,
    classify_criterion,
    suggest_rewrite,
)

# ---------------------------------------------------------------------------
# Flow A's positive-observable examples
# ---------------------------------------------------------------------------


def test_email_arrives_with_working_link_is_positive() -> None:
    result = classify_criterion(
        "an email arrives containing a link that opens a working reset form"
    )
    assert result.label == "positive-observable"


def test_get_returns_created_goal_with_status_is_positive() -> None:
    result = classify_criterion(
        "GET /goals/{id} returns the created goal with status 'active'"
    )
    assert result.label == "positive-observable"


# ---------------------------------------------------------------------------
# Flow A's vacuous-satisfiable examples
# ---------------------------------------------------------------------------


def test_bare_status_code_is_vacuous() -> None:
    result = classify_criterion("returns 202")
    assert result.label == "vacuous-satisfiable"
    assert result.reasons


def test_pure_absence_does_not_leak_is_vacuous() -> None:
    result = classify_criterion("does not leak the token")
    assert result.label == "vacuous-satisfiable"


def test_no_error_is_raised_is_vacuous() -> None:
    result = classify_criterion("no error is raised")
    assert result.label == "vacuous-satisfiable"


# ---------------------------------------------------------------------------
# The password-reset incident trio, verbatim from the direction's Why section
# ---------------------------------------------------------------------------


def test_password_reset_trio_all_vacuous() -> None:
    trio = ["returns 202", "token not in body", "no error is raised"]
    for criterion in trio:
        result = classify_criterion(criterion)
        assert result.label == "vacuous-satisfiable", criterion

    assessment = assess_direction(trio)
    assert assessment.all_vacuous is True
    assert set(assessment.vacuous) == set(trio)
    assert assessment.positive == []


# ---------------------------------------------------------------------------
# Mixed: negation + positive clause -> positive (the AND rule)
# ---------------------------------------------------------------------------


def test_negation_plus_positive_clause_is_positive() -> None:
    result = classify_criterion(
        "returns the goal and does not leak the token"
    )
    assert result.label == "positive-observable"


def test_returns_2xx_and_response_body_contains_is_positive() -> None:
    result = classify_criterion(
        "returns a 2xx and the response body contains the created invoice"
    )
    assert result.label == "positive-observable"


# ---------------------------------------------------------------------------
# Non-observable / process facts
# ---------------------------------------------------------------------------


def test_code_is_refactored_is_vacuous() -> None:
    assert classify_criterion("the code is refactored").label == "vacuous-satisfiable"


def test_tests_pass_is_vacuous() -> None:
    assert classify_criterion("all tests pass").label == "vacuous-satisfiable"


def test_coverage_increases_is_vacuous() -> None:
    assert classify_criterion("test coverage increases").label == "vacuous-satisfiable"


# ---------------------------------------------------------------------------
# The calibration trap named in the plan: "OK" must not be read as content
# ---------------------------------------------------------------------------


def test_returns_200_ok_is_vacuous_not_credited_for_the_word_ok() -> None:
    """'OK' matching a content-ish word must not make this positive — it's
    still a bare status assertion with nothing named as returned content."""
    result = classify_criterion("returns 200 OK")
    assert result.label == "vacuous-satisfiable"


# ---------------------------------------------------------------------------
# Markdown noise resilience
# ---------------------------------------------------------------------------


def test_markdown_bold_and_checkbox_noise_still_classifies() -> None:
    result = classify_criterion("[x] **Returns 202** with no body")
    assert result.label == "vacuous-satisfiable"


def test_backticks_do_not_prevent_positive_classification() -> None:
    result = classify_criterion(
        "`GET /pledges/{id}` returns the created pledge with its `amount`"
    )
    assert result.label == "positive-observable"


def test_case_insensitivity() -> None:
    assert classify_criterion("RETURNS 202").label == "vacuous-satisfiable"
    assert classify_criterion("An Email Arrives Containing A Link").label == (
        "positive-observable"
    )


# ---------------------------------------------------------------------------
# assess_direction: mixed sets, empty sets, and the all_vacuous boundary
# ---------------------------------------------------------------------------


def test_assess_direction_empty_list_is_not_all_vacuous() -> None:
    assessment = assess_direction([])
    assert assessment.all_vacuous is False
    assert assessment.vacuous == []
    assert assessment.positive == []


def test_assess_direction_one_positive_among_vacuous_is_not_all_vacuous() -> None:
    criteria = [
        "returns 202",
        "does not leak the token",
        "an email arrives containing a link that opens a working reset form",
    ]
    assessment = assess_direction(criteria)
    assert assessment.all_vacuous is False
    assert len(assessment.positive) == 1
    assert len(assessment.vacuous) == 2


def test_assess_direction_all_positive() -> None:
    criteria = [
        "an email arrives containing a link",
        "the page shows the confirmation toast",
    ]
    assessment = assess_direction(criteria)
    assert assessment.all_vacuous is False
    assert assessment.vacuous == []
    assert len(assessment.positive) == 2


def test_assess_direction_suggestion_mentions_original_criterion() -> None:
    assessment = assess_direction(["returns 202"])
    suggestion = assessment.suggestion("returns 202")
    assert "returns 202" in suggestion
    assert "202" in suggestion


def test_suggest_rewrite_is_deterministic() -> None:
    assert suggest_rewrite("returns 202") == suggest_rewrite("returns 202")


# ---------------------------------------------------------------------------
# Fail-safe: a crashing classifier must degrade to "no verdict", never block
# ---------------------------------------------------------------------------


def test_assess_direction_degrades_on_classifier_crash(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import factory.backpressure.vacuity as vacuity_mod

    def _boom(text: str) -> CriterionClass:
        raise RuntimeError("boom")

    monkeypatch.setattr(vacuity_mod, "classify_criterion", _boom)
    assessment = vacuity_mod.assess_direction(["returns 202", "no error is raised"])
    assert assessment.all_vacuous is False
    assert assessment.vacuous == []
    assert assessment.positive == ["returns 202", "no error is raised"]
    assert assessment.error is not None
    assert "boom" in assessment.error


def test_suggestion_degrades_to_empty_string_on_crash(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """F6: ``VacuityAssessment.suggestion`` is called from the triage-blocking
    path in ``validator.py`` OUTSIDE the try/except that wraps classification
    itself — a crash there must not propagate and kill triage for what may
    be a perfectly valid direction."""
    import factory.backpressure.vacuity as vacuity_mod

    def _boom(criterion: str) -> str:
        raise RuntimeError("boom in suggest_rewrite")

    monkeypatch.setattr(vacuity_mod, "suggest_rewrite", _boom)
    assessment = vacuity_mod.assess_direction(["returns 202"])
    assert assessment.suggestion("returns 202") == ""


# ---------------------------------------------------------------------------
# F1 — status-code and negation branches are INSUFFICIENT ALONE: a criterion
# naming real content (a literal JSON value, an email/redirect/download, an
# affirmative capability) must not be flagged just because it also contains
# a bare status code or a negation word. Corpus false blocks confirmed by
# adversarial review: sacrifice 078, 101, 087, 024.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "criterion",
    [
        # F1's own cited false blocks, corpus-verbatim.
        'GET /healthz returns 200 with JSON body {"status": "ok"}',
        'returns 503 with body {"db":"unreachable"} when the DB round-trip fails',
        "Users can submit proof through an in-app capture or upload path "
        "without needing to paste a YouTube URL for the primary proof flow.",
        # the docstring's own example shape, cited directly in the review
        "POST /reset returns 202 and an email is delivered to the user's inbox",
        # additional probes: real content alongside a bare status code
        "returns 201 and the response body contains the new invoice id",
        "the upload fails with 413 and the UI shows a file-too-large banner",
        "GET /orders/{id} returns 404 when the order does not belong to the "
        "caller, and 200 with the order otherwise",
        "a webhook POSTs the delivery confirmation to the configured callback URL",
        "the CSV export downloads with one row per completed goal",
        # additional probes: real content alongside a negation
        "attempting to reuse the link redirects to an expired-link page "
        "instead of the reset form",
        "without requiring a page reload, the dashboard updates to show the "
        "new balance",
    ],
)
def test_status_or_negation_with_real_content_is_positive(criterion: str) -> None:
    result = classify_criterion(criterion)
    assert result.label == "positive-observable", (criterion, result.reasons)


@pytest.mark.parametrize(
    "criterion",
    [
        "returns 202",
        "does not leak the token",
        "no error is raised",
        "the response is not an error",
        "returns a 2xx",
        "without a stack trace",
        "the request does not fail",
        "never returns a 500",
        "the call succeeds",
        "nothing is thrown",
        "requires no special headers",
    ],
)
def test_bare_status_or_negation_alone_stays_vacuous(criterion: str) -> None:
    """The residue check must not become so permissive that genuinely bare
    status/negation criteria stop being flagged — these have nothing beyond
    the trigger phrase itself."""
    result = classify_criterion(criterion)
    assert result.label == "vacuous-satisfiable", (criterion, result.reasons)


def test_json_literal_overrides_bare_status_code() -> None:
    result = classify_criterion('GET /healthz/db returns 200 with body {"db": "ok"}')
    assert result.label == "positive-observable"
    assert "literal" in result.reasons[0] or "json" in result.reasons[0].lower()


# ---------------------------------------------------------------------------
# F2/F3 — explore-tagged directions must never be BLOCKED on vacuity (tested
# at the classifier level: the label itself is unaffected by explore; the
# explore exemption lives in ``validate_direction`` and is covered in
# ``test_backpressure_meaningful.py``). Also: the typecheck/lint
# inconsistency the review found (`type-?checking?` only made the trailing
# "g" optional, so "typecheck passes" never matched).
# ---------------------------------------------------------------------------


def test_typecheck_passes_is_vacuous_like_lint_passes() -> None:
    lint = classify_criterion("lint passes on sacrifice's main branch")
    typecheck = classify_criterion("typecheck passes")
    assert lint.label == "vacuous-satisfiable"
    assert typecheck.label == "vacuous-satisfiable", typecheck.reasons


# ---------------------------------------------------------------------------
# F4 — enforcement/process verbs with no named observable artifact. The
# motivating case: sacrifice 094 (the password-reset direction the gate
# exists for) must flag once its "enforces"/"revokes" criteria stop being
# default-credited.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "criterion",
    [
        "Reset endpoint enforces token validity, complexity checks, and attempt throttling",
        "Successful reset revokes prior active sessions/tokens",
        "All state-changing authenticated routes reject requests without a "
        "valid CSRF token or equivalent protection.",
        "Session cookie settings are reviewed and hardened for SameSite, "
        "Secure, and HttpOnly semantics.",
        "Access and refresh token policy documented and enforced in backend auth middleware",
        "Refresh token rotation with revocation implemented and tested for replay attempts",
        "New email/password accounts remain restricted until verification",
        "Verification token is single-use, time-bounded, and auditable",
    ],
)
def test_enforcement_and_property_claims_are_vacuous(criterion: str) -> None:
    result = classify_criterion(criterion)
    assert result.label == "vacuous-satisfiable", (criterion, result.reasons)


def test_094_and_018_and_082_and_107_are_all_vacuous_directions() -> None:
    """The four corpus directions F4 explicitly requires to flag."""
    cases = {
        "094": [
            "Forgot-password issues expiring single-use reset tokens without "
            "disclosing account existence",
            "Reset endpoint enforces token validity, complexity checks, and "
            "attempt throttling",
            "Successful reset revokes prior active sessions/tokens",
        ],
        "018": [
            "All state-changing authenticated routes reject requests without "
            "a valid CSRF token or equivalent protection.",
            "Session cookie settings are reviewed and hardened for SameSite, "
            "Secure, and HttpOnly semantics.",
        ],
        "082": [
            "Access and refresh token policy documented and enforced in "
            "backend auth middleware",
            "Refresh token rotation with revocation implemented and tested "
            "for replay attempts",
            "Protected endpoints reject tokens with invalid issuer/audience/expiry",
        ],
        "107": [
            "New email/password accounts remain restricted until verification",
            "Verification token is single-use, time-bounded, and auditable",
            "Protected routes reject unverified sessions with clear error semantics",
        ],
    }
    for direction_id, criteria in cases.items():
        assessment = assess_direction(criteria)
        assert assessment.all_vacuous is True, (direction_id, assessment.positive)


# ---------------------------------------------------------------------------
# F5 — vague success/correctness language must not be default-credited.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "criterion",
    [
        "responds correctly",
        "returns a valid response",
        "returns the expected response",
        "the endpoint returns OK",
        "no exception is thrown",
        "completes cleanly",
        "returns the correct value",
        "well-formed",
        "handled gracefully",
        "a success status",
        "proper HTTP response",
        "idempotent",
    ],
)
def test_vague_positive_language_is_vacuous(criterion: str) -> None:
    result = classify_criterion(criterion)
    assert result.label == "vacuous-satisfiable", (criterion, result.reasons)
