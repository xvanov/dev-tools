"""Vacuity classifier — is an acceptance criterion satisfiable by a no-op?

Named after Beer et al. 2001 ("vacuity" in formal verification: a property
that passes not because the implementation is correct, but because the
property is too weak to fail on anything). The motivating incident (see
``apps/factory/directions/019-exteroception-v1-close-the-sensing-gap/``): the
password-reset feature was certified by three green tests against criteria
that only asserted a status code and an absence —

    - "returns 202"
    - "the token is not in the response body"
    - "no error is raised"

— none of which requires an email to ever be sent. A fixed-response HTTP
handler with no transport layer at all satisfies every one of them. That
feature shipped with no working reset path four times before anyone noticed,
because nothing in the acceptance criteria forced an artifact (the reset
email) to actually arrive.

This module is a deterministic, LLM-free classifier (Flow A,
``apps/factory/directions/019-exteroception-v1-close-the-sensing-gap/flow.md``)
run at direction triage, before any persona is invoked. It sorts each parsed
acceptance-criterion string into exactly one of two buckets:

``positive-observable``
    Names an outcome a client could observe at the system boundary — response
    *content* ("returns the created goal with status 'active'", "the body
    contains the token"), an artifact arriving ("an email arrives containing
    a link", "a file downloads"), or a visible state change ("appears in the
    list", "the page shows the toast", "redirects to /dashboard", "persists
    across reload", "a subsequent GET returns it").

``vacuous-satisfiable``
    A fixed-response or reject-everything no-op could satisfy it with zero
    real implementation behind it. Several shapes, each independently
    sufficient:

    1. **Bare status-code / success assertion** — "returns 202", "responds
       with a 2xx" — but ONLY when nothing else in the criterion names real
       content (see "insufficient alone" below); "returns 200 with JSON body
       {"status": "ok"}" is NOT this shape, because the JSON payload IS named
       content.
    2. **Pure absence / negation** — "does not leak the token", "no error is
       raised", "without a stack trace" — again only when the residue after
       the negation names nothing else (see below); "users can submit proof
       ... without needing to paste a YouTube URL" is NOT this shape, because
       "submit proof ... " is a positive capability independent of the
       negated clause.
    3. **Pure non-observable / process fact** — "the code is refactored",
       "tests pass", "coverage increases", "a backend test covers X" —
       describes an internal/process fact, not anything a client of the
       system could observe.
    4. **Vague success/correctness language** — "responds correctly",
       "returns a valid response", "returns OK", "no exception is thrown",
       "completes cleanly", "well-formed", "handled gracefully", "a success
       status", "idempotent" — asserts correctness without naming what
       correct output actually looks like. A no-op that never errors
       trivially "responds correctly" by this wording.
    5. **Enforcement/process verbs with no named observable artifact** —
       "enforces token validity", "revokes prior active sessions",
       "validates X", "restricts Y", "settings are reviewed and hardened".
       A reject-everything (or accept-everything) handler can "enforce",
       "reject", "revoke", or "restrict" trivially without implementing the
       actual policy, AS LONG AS nothing else in the criterion (or the
       positive lexicon) names the resulting observable behavior (a
       specific status code on the wrong input, a session cookie that stops
       working, a field that appears/disappears). This is deliberately
       aggressive — see "Design tension" below.

Bucket 1 and 2 are "insufficient alone": a bare status code or a negation
does not, by itself, prove nothing else in the sentence names real content.
Both are checked with a residue analysis — see ``_has_sufficient_residue``.
Buckets 3-5 are unconditional once matched (no residue check): the operator
review that shaped this module found that giving them the same leniency
either let real vacuous claims slip through (F4) or required implausibly
long exemption lists.

A criterion that mixes a negation with a positive clause ("returns the goal
AND does not leak the token") is ``positive-observable``: the positive half
already forces real behavior, so the no-op can no longer pass. Likewise a
criterion embedding a literal JSON-shaped value (``{"status": "ok"}``) is
``positive-observable`` regardless of an accompanying bare status code — a
no-op that emits an ARBITRARY fixed body would not, in general, happen to
match a specific named field/value.

Design tension (read before extending the vacabulary further): Bucket 5
(enforcement verbs) is inherently the fuzziest heuristic here — "validates X"
legitimately describes real, checkable behavior in many contexts. It is kept
aggressive on purpose because the operator review's motivating case (a
password-reset direction whose ONLY criteria were "enforces token validity",
"revokes prior sessions", and an absence) is exactly the shape a reviewer
must catch, and under-flagging is the direction's explicitly accepted safe
failure mode (see :func:`assess_direction`). Concretely this means a handful
of criteria that ARE reasonably specific ("validates each conforms to the
base [class], and exposes list_types()") get individually mislabeled
``vacuous-satisfiable`` when they sit in an otherwise well-specified
direction; this does not change any WHOLE-DIRECTION verdict as long as at
least one sibling criterion is genuinely positive-observable, which is the
only thing :func:`assess_direction` acts on.

Fail-safe direction: the two buckets are the only two labels this module
emits, and the DEFAULT — when nothing here recognizes a criterion as
vacuous — is ``positive-observable``. Blocking a real, well-formed criterion
because a crude regex didn't understand it would wedge triage on every
direction that phrases things unusually; the asymmetry the direction cares
about is a no-op sailing through, not a legitimate criterion being flagged.
Callers that need "no verdict" semantics (e.g. an internal classifier crash)
should catch exceptions around :func:`assess_direction`'s call site, or use
its own try/except — see the docstring there. Note also that a direction
with NO acceptance criteria at all bypasses this gate entirely (empty
acceptance is reported separately, unchanged, as missing
``acceptance_criteria`` — see ``factory.backpressure.validator``); this
module has nothing to classify and makes no claim either way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

CriterionLabel = Literal["positive-observable", "vacuous-satisfiable"]

# --------------------------------------------------------------------------
# Markdown-noise stripping. Criteria arrive with checkboxes already peeled
# off by ``factory.directions.parser._parse_acceptance``, but bold/italic
# markers, backticks, and stray brackets survive (this direction's own AC1
# bullet starts "**Vacuity gate at triage.**").
# --------------------------------------------------------------------------


def _clean(text: str) -> str:
    t = text
    t = re.sub(r"`+", "", t)
    t = re.sub(r"\*\*|\*|__|_", "", t)
    t = re.sub(r"^\s*\[[ xX]\]\s*", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t.lower()


# --------------------------------------------------------------------------
# A literal, structured value embedded in the criterion — a JSON-ish object
# (``{"status": "ok"}``) is "naming exact content" regardless of whatever
# else the sentence says (a bare status code, a negation). Checked BEFORE
# anything else. Braces survive ``_clean`` untouched.
# --------------------------------------------------------------------------

_JSON_LITERAL_RE = re.compile(r"\{[^{}]+\}")

# --------------------------------------------------------------------------
# Pattern 1: bare status-code / bare-success assertion. "Insufficient
# alone" — see ``_has_sufficient_residue``.
# --------------------------------------------------------------------------

_STATUS_CODE_RE = re.compile(r"\b(?:[1-5]\d{2}|[2-5]xx)\b", re.IGNORECASE)
_SUCCESS_WORD_RE = re.compile(
    r"\b(?:responds?\s+successfully|returns?\s+successfully|succeeds?|"
    r"completes?\s+successfully|request\s+succeeds|call\s+succeeds)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Pattern 2: pure absence / negation. "Insufficient alone" — see
# ``_has_sufficient_residue``.
#
# Deliberately does NOT include "no longer <verb>" ("exec.py invocations no
# longer use shell=True", "the detector no longer fires on the same
# subject" — Flow D's own built-in criterion, called out there as
# "impossible to satisfy with a no-op"). A "no longer" criterion regresses
# against a CURRENTLY-TRUE bad state (the vulnerable call, the firing
# detector): a no-op that changes nothing leaves that bad state intact and
# fails the criterion. That's the opposite of "does not leak the token" or
# "no error is raised", which assert an absence in output the system never
# had to produce in the first place — a no-op trivially has nothing to leak
# and raises nothing. Treating both shapes the same would block every
# regression/security-fix finding of this shape on a technicality the
# direction's own Flow D disagrees with.
# --------------------------------------------------------------------------

_NEGATION_RE = re.compile(
    r"\b(?:does\s+not|doesn't|never|no\s+error|is\s+not|isn't|"
    r"cannot|can't|without|won't|will\s+not|not\s+leak|not\s+expose|"
    r"not\s+return|not\s+raised|not\s+present|not\s+included|not\s+in\b|"
    r"requires?\s+no\b|needs?\s+no\b|nothing\s+is)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Pattern 3: pure non-observable (implementation/process fact, not a
# boundary-observable outcome). Unconditional — no residue check.
# --------------------------------------------------------------------------

_NON_OBSERVABLE_RE = re.compile(
    r"\b(?:code\s+is\s+refactored|is\s+refactored|refactoring|tests?\s+pass(?:es)?|"
    r"tests?\s+(?:cover|covers|covering|verify|verifies|verifying)|"
    r"test\s+coverage|coverage\s+(?:increases?|improves?)|lint\s+passes?|"
    r"type-?check(?:ing)?\s+passes?|passes\s+ci|(?:is|stays)\s+green|"
    r"is\s+cleaner|readability\s+improves?|"
    r"reviewed\s+and\s+hardened|is\s+hardened|are\s+hardened)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Pattern 4 (F5): vague success/correctness language — asserts things went
# "fine" without ever saying what "fine" looks like. Unconditional.
# --------------------------------------------------------------------------

_VAGUE_POSITIVE_RE = re.compile(
    r"\b(?:"
    r"responds?\s+correctly|"
    r"returns?\s+(?:a\s+)?valid\s+response|"
    r"returns?\s+the\s+expected\s+response|"
    r"returns?\s+the\s+correct\s+value|"
    r"returns?\s+ok\b|"
    r"no\s+exceptions?\s+(?:is|are)?\s*(?:thrown|raised)|"
    r"completes?\s+cleanly|"
    r"well-?formed|"
    r"handled\s+gracefully|"
    r"(?:a|the)\s+success\s+status|"
    r"proper\s+(?:http\s+)?response|"
    r"idempotent"
    r")\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Pattern 5 (F4): enforcement/process verbs with no named observable
# artifact. Unconditional once matched — see the module docstring's "Design
# tension" note before extending this list.
# --------------------------------------------------------------------------

_ENFORCEMENT_RE = re.compile(
    r"\b(?:enforc\w*|validat\w*|reject(?:s|ed|ing|ion)?|revok\w*|revoc\w*|"
    r"restrict(?:s|ed|ing|ion)?|(?:is|are|gets?)\s+blocked|blocks(?:\s+until)?|"
    r"harden(?:s|ed|ing)?)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Pattern 6 (F4, narrower): bare security/lifecycle PROPERTY claims
# ("single-use", "time-bounded", "auditable", "rate-limited") with no stated
# observable check. These read as real constraints but are typically
# unfalsifiable from outside the system without a companion criterion that
# actually exercises them.
# --------------------------------------------------------------------------

_PROPERTY_CLAIM_RE = re.compile(
    r"\b(?:single-use|single\s+use|time-bounded|auditable|rate-limited)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# Positive-observable content markers. Deliberately does NOT include bare
# words like "ok" or "success" — "returns 200 OK" must not be credited as
# positive just because "OK" is in the string (the calibration trap named in
# the direction's implementation plan). Also excludes VAGUE adjectives
# (expected/correct/valid/proper/appropriate/right/desired) immediately
# before a generic noun (response/value/result/output/field) from the
# "returns/contains the <noun>" branches (F5) — "returns the expected
# response" is not naming content, it is Pattern 4 above.
# --------------------------------------------------------------------------

_VAGUE_ADJ = r"(?:expected|correct|valid|proper|appropriate|right|desired)"

_POSITIVE_RE = re.compile(
    r"\b(?:"
    r"body\s+(?:contains|includes|has)|"
    r"response\s+(?:contains|includes)|"
    rf"contains?\s+the\s+(?!{_VAGUE_ADJ}\b)|"
    rf"includes?\s+the\s+(?!{_VAGUE_ADJ}\b)|"
    rf"returns?\s+the\s+(?!\d|{_VAGUE_ADJ}\b)\w+|"
    r"returns?\s+it\b|"
    r"lists?\b|"
    r"appears?\s+in\b|"
    r"shows?\s+the|displays?\s+the|"
    r"persists?\s+across|"
    r"redirects?\s+to|"
    r"subsequent\s+get|"
    r"email\s+arrives|arrives\s+containing|"
    r"downloads?\b|"
    r"opens?\s+a\s+working|"
    r"page\s+shows|"
    r"toast\s+(?:appears|shows)|"
    r"is\s+(?:visible|displayed)\s+(?:in|on)"
    r")\b",
    re.IGNORECASE,
)

# A "positive" verb (returns/contains/includes/shows/...) immediately after a
# negation cue is NOT a positive clause — "never returns the reset token" is
# an absence assertion, not a claim that content is returned. Without this,
# ``_POSITIVE_RE``'s broad "returns the <noun>" branch would credit exactly
# the kind of criterion the calibration is meant to catch (see 019's
# password-reset incident: "the token is not in the response body"-shaped
# text is common in security criteria). Masked out of a scan COPY only, so a
# genuinely separate positive clause elsewhere in the same criterion (the AND
# rule) still counts.
_NEGATION_WORD_RE = (
    r"(?:never|does\s+not|doesn't|cannot|can't|won't|will\s+not|is\s+not|"
    r"isn't|no\s+longer|not)"
)
_POSITIVE_VERB_RE = (
    r"(?:returns?|returning|contains?|containing|includes?|including|shows?|"
    r"showing|displays?|displaying|lists?|listing|redirects?|redirecting|"
    r"persists?|persisting|appears?|appearing|arrives?|arriving|downloads?|"
    r"downloading)"
)
_NEGATED_POSITIVE_VERB_RE = re.compile(
    rf"\b{_NEGATION_WORD_RE}\s+{_POSITIVE_VERB_RE}\b", re.IGNORECASE
)

# --------------------------------------------------------------------------
# Residue analysis for Patterns 1 and 2 (F1): a bare status code or a
# negation does not, alone, prove the rest of the sentence is content-free.
# After stripping the matched trigger phrase(s), tokenize what's left and
# count tokens that are NOT (a) true stopwords/prepositions/modals, (b)
# generic HTTP/API vocabulary (get/post/returns/response/body/endpoint/...),
# or (c) generic security/account vocabulary that shows up on BOTH sides of
# the vacuous/positive line in this corpus (token, password, session,
# existence, single-use, reset, issues/discloses...) and therefore does not,
# by itself, distinguish a real claim from a restatement of the negated
# subject. If >=3 such tokens remain, the criterion names something real and
# is NOT flagged via bucket 1/2 alone (though bucket 3-5 may still apply).
#
# This list is deliberately curated against the operator review's concrete
# cases, not exhaustive: "the token is not in the response body" (no
# residual content -> stays vacuous) vs. "users can submit proof through an
# in-app capture or upload path without needing to paste a YouTube URL" (five
# non-generic content words survive -> not vacuous via this bucket).
# --------------------------------------------------------------------------

_NON_CONTENT_WORDS = frozenset(
    {
        # true stopwords / function words
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "and", "or", "but", "if", "then", "else", "when", "while", "with",
        "without", "for", "of", "to", "in", "on", "at", "by", "as", "that",
        "this", "these", "those", "it", "its", "their", "they", "we", "you",
        "your", "i", "not", "no", "never", "does", "do", "did", "cannot",
        "cant", "wont", "will", "must", "should", "shall", "only", "also",
        "both", "from", "into", "onto", "than", "so", "such", "which", "who",
        "whom", "whose", "there", "here", "http", "https", "e", "g", "eg",
        "can", "could", "may", "might", "would", "through",
        # HTTP verbs / generic response vocabulary
        "get", "post", "put", "patch", "delete", "head", "options",
        "returns", "return", "returning", "responds", "respond",
        "response", "responses", "request", "requests", "requested",
        "endpoint", "endpoints", "call", "calls", "body", "bodies",
        "header", "headers", "field", "fields", "value", "values",
        "status", "code", "codes", "result", "results", "output", "outputs",
        # security/account generic vocabulary that repeats the negated
        # subject rather than naming a NEW distinguishing fact
        "token", "tokens", "password", "passwords", "account", "accounts",
        "session", "sessions", "credential", "credentials", "existence",
        "auth", "authentication", "authorization", "validity", "complexity",
        "throttling", "policy", "single", "use", "reset",
        # abstract internal-process verbs describing a side effect with no
        # stated way to observe it externally
        "issue", "issues", "issued", "issuing", "disclose", "discloses",
        "disclosed", "disclosing", "expire", "expires", "expired",
        "expiring", "generate", "generates", "generated", "generating",
        "create", "creates", "created", "creating", "store", "stores",
        "stored", "storing",
    }
)

_WORD_RE = re.compile(r"[a-z0-9]+")


def _content_token_count(text: str) -> int:
    """Count tokens in ``text`` that survive the non-content exclusion list."""
    return sum(
        1
        for tok in _WORD_RE.findall(text)
        if len(tok) > 1 and tok not in _NON_CONTENT_WORDS
    )


_RESIDUE_THRESHOLD = 3


def _has_sufficient_residue(cleaned: str) -> bool:
    """True if, after removing every status-code/success/negation match,
    at least ``_RESIDUE_THRESHOLD`` content tokens remain."""
    residue = _STATUS_CODE_RE.sub(" ", cleaned)
    residue = _SUCCESS_WORD_RE.sub(" ", residue)
    residue = _NEGATION_RE.sub(" ", residue)
    return _content_token_count(residue) >= _RESIDUE_THRESHOLD


@dataclass
class CriterionClass:
    """The classification of one acceptance criterion."""

    label: CriterionLabel
    reasons: list[str] = field(default_factory=list)


def classify_criterion(text: str) -> CriterionClass:
    """Classify a single acceptance-criterion string.

    Deterministic, case-insensitive, resilient to markdown noise. See the
    module docstring for the full heuristic, its bucket-by-bucket rationale,
    and its Flow A provenance.
    """
    cleaned = _clean(text)

    # A literal structured value trumps everything else — naming an exact
    # payload shape is "content" regardless of an accompanying bare status
    # code (F1: sacrifice 078, 101).
    if _JSON_LITERAL_RE.search(cleaned):
        return CriterionClass(
            label="positive-observable",
            reasons=["embeds a literal structured value (JSON-shaped content)"],
        )

    # Scan copy with negated positive-verbs masked out, so "never returns the
    # token" can't satisfy the "returns the <noun>" branch — see
    # ``_NEGATED_POSITIVE_VERB_RE``'s docstring above.
    positive_scan = _NEGATED_POSITIVE_VERB_RE.sub(" omits ", cleaned)
    if _POSITIVE_RE.search(positive_scan):
        return CriterionClass(
            label="positive-observable",
            reasons=["names response content, a delivered artifact, or a visible state change"],
        )

    # Unconditional vacuous triggers (buckets 3-5): once matched, no residue
    # check — see the module docstring's "Design tension" note.
    reasons: list[str] = []
    if _VAGUE_POSITIVE_RE.search(cleaned):
        reasons.append("vague success/correctness claim with no named observable output")
    if _ENFORCEMENT_RE.search(cleaned):
        reasons.append(
            "enforcement/process verb with no named observable artifact "
            "(a reject-everything or accept-everything no-op can satisfy it)"
        )
    if _PROPERTY_CLAIM_RE.search(cleaned):
        reasons.append("internal lifecycle property asserted with no stated observable check")
    if _NON_OBSERVABLE_RE.search(cleaned):
        reasons.append("describes an internal/process fact, not a boundary-observable outcome")
    if reasons:
        return CriterionClass(label="vacuous-satisfiable", reasons=reasons)

    # Buckets 1-2 (F1): insufficient alone. Only flag if the residue left
    # after removing the trigger phrase(s) is itself content-free.
    status_hit = bool(_STATUS_CODE_RE.search(cleaned) or _SUCCESS_WORD_RE.search(cleaned))
    negation_hit = bool(_NEGATION_RE.search(cleaned))
    if (status_hit or negation_hit) and not _has_sufficient_residue(cleaned):
        residue_reasons: list[str] = []
        if status_hit:
            residue_reasons.append("bare status-code/success assertion with no named response content")
        if negation_hit:
            residue_reasons.append("pure absence/negation with no accompanying positive clause")
        return CriterionClass(label="vacuous-satisfiable", reasons=residue_reasons)

    return CriterionClass(
        label="positive-observable",
        reasons=["no vacuous pattern matched (default: assume meaningful)"],
    )


@dataclass
class VacuityAssessment:
    """The vacuity verdict for a direction's full acceptance-criteria set."""

    all_vacuous: bool
    vacuous: list[str] = field(default_factory=list)
    positive: list[str] = field(default_factory=list)
    # Populated only when the classifier raised internally; ``all_vacuous`` is
    # then forced False (fail-safe: never block on a crash) and callers can
    # log/surface this for visibility.
    error: str | None = None

    def suggestion(self, criterion: str) -> str:
        """Return one rewritten example for ``criterion``.

        Fail-safe (F6): this is called from the triage-blocking path
        (``factory.backpressure.validator``) OUTSIDE the try/except that
        wraps classification itself, so a crash here must not propagate — an
        internal error degrades to an empty string rather than killing
        triage for what may otherwise be a perfectly valid direction. See
        :func:`suggest_rewrite`.
        """
        try:
            return suggest_rewrite(criterion)
        except Exception:  # noqa: BLE001 - fail-safe: never crash triage over a suggestion
            return ""


def suggest_rewrite(criterion: str) -> str:
    """Return one deterministic, criterion-aware rewrite suggestion.

    Cheap and template-based — not a persona call. Picks a template by which
    vacuous pattern matched so the suggestion echoes back something specific
    to the criterion (e.g. the status code it named) rather than a single
    generic line for everything.
    """
    original = criterion.strip()
    cleaned = _clean(criterion)

    code_match = _STATUS_CODE_RE.search(cleaned)
    if code_match:
        code = code_match.group(0)
        return (
            f'"{original}" is satisfiable by a fixed-response no-op handler. '
            f"Name the response content a client would observe, e.g.: "
            f'"returns {code} and the response body contains the created '
            f'<resource> with its <field>; a subsequent GET returns it."'
        )
    if _ENFORCEMENT_RE.search(cleaned) or _PROPERTY_CLAIM_RE.search(cleaned):
        return (
            f'"{original}" describes an enforcement/lifecycle property with no '
            f"stated observable check — a reject-everything or accept-everything "
            f"handler can satisfy it trivially. Rewrite to name the observable "
            f'consequence, e.g.: "a request with an invalid/expired value is '
            f'rejected with 401/403, and a request with a valid value succeeds; '
            f'a session cookie issued before revocation stops working afterward."'
        )
    if _VAGUE_POSITIVE_RE.search(cleaned):
        return (
            f'"{original}" asserts correctness without saying what correct '
            f"output looks like. Rewrite to name the actual response content, "
            f'e.g.: "returns 200 and the response body contains {{"id": '
            f'<created-id>, "status": "active"}}."'
        )
    if _NEGATION_RE.search(cleaned):
        return (
            f'"{original}" only asserts an absence — a handler that does nothing '
            f"also satisfies it. Pair it with a positive outcome, e.g.: "
            f'"returns the created <resource> and the response body never '
            f'includes the raw value; a subsequent GET confirms the field is '
            f'absent while the <resource> itself is present."'
        )
    if _NON_OBSERVABLE_RE.search(cleaned):
        return (
            f'"{original}" describes an implementation/process detail, not '
            f"something observable at the system boundary. Rewrite to name what "
            f'a client sees, e.g.: "a subsequent GET /<resource>/{{id}} returns '
            f'the updated <field> value."'
        )
    return (
        f'"{original}" does not name an observable outcome. Rewrite to name '
        f'response content, a delivered artifact, or a visible state change, '
        f'e.g.: "the response body contains <field>" or "the page shows '
        f'<state>."'
    )


def assess_direction(criteria: list[str]) -> VacuityAssessment:
    """Classify every criterion and decide whether the whole set is vacuous.

    ``all_vacuous`` is True only when ``criteria`` is non-empty AND zero
    criteria classify ``positive-observable`` — an empty list is "no verdict",
    not "vacuous" (the caller already reports empty acceptance separately as
    missing ``acceptance_criteria``; a vacuity gate has nothing to say about a
    direction with no criteria to classify).

    Fail-safe: if :func:`classify_criterion` raises for any reason, the whole
    assessment degrades to "no verdict" — ``all_vacuous=False``, every
    criterion reported ``positive`` (i.e. not held against the direction),
    and ``error`` set to the exception repr. A crashing classifier must never
    block a direction; it is a quality gate, not a safety gate, and the
    caller should log the ``error`` field as a warning.
    """
    if not criteria:
        return VacuityAssessment(all_vacuous=False, vacuous=[], positive=[])

    vacuous: list[str] = []
    positive: list[str] = []
    try:
        for criterion in criteria:
            result = classify_criterion(criterion)
            if result.label == "vacuous-satisfiable":
                vacuous.append(criterion)
            else:
                positive.append(criterion)
    except Exception as exc:  # noqa: BLE001 - fail-safe: a crash must never block
        return VacuityAssessment(
            all_vacuous=False,
            vacuous=[],
            positive=list(criteria),
            error=repr(exc),
        )

    all_vacuous = len(positive) == 0
    return VacuityAssessment(all_vacuous=all_vacuous, vacuous=vacuous, positive=positive)
