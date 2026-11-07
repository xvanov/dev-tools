"""Tests for the keyword-based semantic dedup stopgap in scheduled_tasks.py.

Regression coverage for audit 2026-07-18 leak 3 of 4: scheduler personas
re-surface the same underlying finding with a slightly different title each
run ("Add CSRF protections to cookie-auth API routes" vs "...API flows"),
which slipped past the exact-title-only dedup guard (CSRF filed as 2
directions, SSRF as 2, OAuth as 4, observed live). ``_has_open_duplicate_direction``
now ALSO dedups on a small set of precise keywords shared between the new
finding and an existing non-terminal direction for the same app + source +
type.
"""

from __future__ import annotations

from pathlib import Path

from factory.chain.scheduled_tasks import (
    _extract_dedup_keywords,
    _has_open_duplicate_direction,
)
from factory.directions.creator import create_direction


def test_extract_dedup_keywords_is_precise() -> None:
    assert _extract_dedup_keywords("Add CSRF protections to cookie-auth API routes") == {"csrf"}
    assert _extract_dedup_keywords("Audit goal-type selector accessibility") == {"a11y"}
    assert _extract_dedup_keywords("Make the dashboard nicer") == set()
    # Multiple distinct keywords can co-occur without collapsing distinctness
    # of OTHER checks; extraction itself just reports what's present.
    assert _extract_dedup_keywords("harden oauth state and CSRF token handling") == {
        "oauth",
        "csrf",
    }


def test_csrf_reworded_title_dedups_to_existing_direction(tmp_path: Path) -> None:
    """The exact bug from the audit: same finding, reworded title each run."""
    create_direction(
        "sacrifice",
        title="Add CSRF protections to cookie-authenticated API routes",
        type_tag="security",
        why="Cookie-auth endpoints accept state-changing requests without a CSRF token.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["POST endpoints reject requests without a valid CSRF token"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-security",
    )

    # A fresh run reworded "routes" -> "flows"; exact-title match would MISS
    # this, but the keyword check must catch it.
    assert _has_open_duplicate_direction(
        "sacrifice",
        "Add CSRF protections to cookie-authenticated API flows",
        tmp_path,
        source="scheduled-security",
        type_tag="security",
        body="Cookie-auth endpoints are still missing CSRF tokens on mutating routes.",
    )


def test_different_keyword_findings_do_not_collapse(tmp_path: Path) -> None:
    """csrf vs a11y are materially different findings — must NOT dedup."""
    create_direction(
        "sacrifice",
        title="Add CSRF protections to cookie-authenticated API routes",
        type_tag="security",
        why="Cookie-auth endpoints accept state-changing requests without a CSRF token.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["POST endpoints reject requests without a valid CSRF token"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-security",
    )

    assert not _has_open_duplicate_direction(
        "sacrifice",
        "Audit goal-type selector accessibility",
        tmp_path,
        source="scheduled-ux_auditor",
        type_tag="ux",
        body="Screen reader users cannot distinguish goal-type radio options.",
    )


def test_keyword_dedup_scoped_to_same_source_and_type(tmp_path: Path) -> None:
    """Same keyword, but different source or type, must NOT dedup — the
    keyword check is deliberately scoped narrowly (same app + source + type)."""
    create_direction(
        "sacrifice",
        title="Add CSRF protections to cookie-authenticated API routes",
        type_tag="security",
        why="Cookie-auth endpoints accept state-changing requests without a CSRF token.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["POST endpoints reject requests without a valid CSRF token"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-security",
    )

    # Different source (a different persona filed it) — not a dup by keyword.
    assert not _has_open_duplicate_direction(
        "sacrifice",
        "harden CSRF handling on the checkout flow",
        tmp_path,
        source="scheduled-bug_hunter",
        type_tag="security",
        body="csrf gap found via bug-hunter static analysis.",
    )
    # Different type — not a dup by keyword either.
    assert not _has_open_duplicate_direction(
        "sacrifice",
        "document CSRF token contract",
        tmp_path,
        source="scheduled-security",
        type_tag="docs",
        body="csrf token doc gap.",
    )


def test_keyword_dedup_skipped_when_source_or_type_omitted(tmp_path: Path) -> None:
    """Callers that don't pass source/type_tag (e.g. the pre-existing
    call-site signature) get ONLY the original exact-title behavior —
    backward compatible, no accidental over-matching."""
    create_direction(
        "sacrifice",
        title="Add CSRF protections to cookie-authenticated API routes",
        type_tag="security",
        why="Cookie-auth endpoints accept state-changing requests without a CSRF token.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["POST endpoints reject requests without a valid CSRF token"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-security",
    )

    assert not _has_open_duplicate_direction(
        "sacrifice",
        "Add CSRF protections to cookie-authenticated API flows",
        tmp_path,
    )


def test_ssrf_variants_dedup_via_file_finding_as_direction(tmp_path: Path) -> None:
    """End-to-end through ``_file_finding_as_direction`` (the real call site
    wired to the dedup guard): a second, reworded finding for the same
    underlying SSRF issue is suppressed on a real (non-dry-run) filing."""
    from factory.chain.scheduled_tasks import _file_finding_as_direction

    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: o/r\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True)

    finding1 = {
        "suggested_direction": {
            "title": "Constrain verifier SSRF and sandbox egress",
            "type": "security",
            "why": "The verifier fetches user-supplied URLs with no SSRF guard.",
            "acceptance": ["Outbound fetches reject private/link-local IPs"],
        }
    }
    direction1 = _file_finding_as_direction(
        persona="security",
        app="sacrifice",
        finding=finding1,
        software_factory_root=tmp_path,
        dry_run=False,
    )
    assert direction1 is not None

    finding2 = {
        "suggested_direction": {
            "title": "Restrict verifier SSRF exposure in outbound requests",
            "type": "security",
            "why": "SSRF is still reachable via the verifier's fetch path.",
            "acceptance": ["Outbound fetches reject private/link-local IPs"],
        }
    }
    direction2 = _file_finding_as_direction(
        persona="security",
        app="sacrifice",
        finding=finding2,
        software_factory_root=tmp_path,
        dry_run=False,
    )
    assert direction2 is None
