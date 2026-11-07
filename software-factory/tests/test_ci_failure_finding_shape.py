"""Regression: CI-failure feedback must produce dict findings, and the dev
message builder must never crash on a legacy string finding.

The CI-failure feedback loop (auto_merge) injected a bare STRING into
``reviewer_result_json['findings']``; every consumer indexes findings with
``f.get(...)``, so the dev re-dispatch crashed with "'str' object has no
attribute 'get'" — silently breaking the whole loop (live story 82, PR #275).
"""

from __future__ import annotations

from factory.runner import _build_initial_message


def _msg(reviewer_findings):
    return _build_initial_message(
        persona="dev",
        story_text="story",
        context_prelude="ctx",
        persona_prompt="p",
        reviewer_findings=reviewer_findings,
    )


def test_string_finding_does_not_crash_and_text_survives():
    # The exact shape the CI-failure path used to produce.
    payload = {
        "findings": ["Real GitHub Actions CI failed on PR #275. Fix the exact failure:\n\nsome log"],
        "source": "ci_failure",
        "summary": "Real GitHub Actions CI failed; fix the exact failure it reported.",
    }
    out = _msg(payload)  # must not raise
    assert "Real GitHub Actions CI failed" in out


def test_dict_findings_still_render():
    payload = {
        "findings": [{"severity": "high", "criterion": "ci", "location": "x", "what": "boom"}],
    }
    out = _msg(payload)
    assert "boom" in out


def test_string_test_quality_finding_does_not_crash():
    out = _msg({"test_quality_findings": ["weak assertion somewhere"]})
    assert "weak assertion somewhere" in out


def test_ci_failure_payload_is_dict_finding():
    # Lock in the source fix: the CI-failure finding must be a dict, not a str.
    import inspect

    from factory.chain import auto_merge

    src = inspect.getsource(auto_merge)
    # The finding assignment near the CI-failure path builds a dict with 'what'.
    assert '"findings": [finding]' in src
    # crude but effective: the finding must be constructed as a dict literal
    assert 'finding = {' in src, "CI-failure finding should be a dict literal"
