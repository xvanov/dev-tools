"""Tests for ``factory.webhook.github.verify_signature`` + dispatch logic."""

from __future__ import annotations

import hashlib
import hmac
import json

from factory.webhook.github import dispatch_event, verify_signature


def _sign(body: bytes, secret: str) -> str:
    """Compute the GitHub-format X-Hub-Signature-256 header value."""
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def test_valid_signature_passes() -> None:
    """A correctly-signed body must verify with the same secret."""
    body = b'{"action": "opened"}'
    secret = "factory-test-secret"
    sig = _sign(body, secret)
    assert verify_signature(body, sig, secret) is True


def test_tampered_body_fails() -> None:
    """If the body changes after signing, verification must fail."""
    body = b'{"action": "opened"}'
    secret = "factory-test-secret"
    sig = _sign(body, secret)
    tampered = b'{"action": "closed"}'
    assert verify_signature(tampered, sig, secret) is False


def test_wrong_secret_fails() -> None:
    body = b"x"
    sig = _sign(body, "right-secret")
    assert verify_signature(body, sig, "wrong-secret") is False


def test_missing_header_fails() -> None:
    assert verify_signature(b"x", None, "any") is False
    assert verify_signature(b"x", "", "any") is False


def test_malformed_header_fails() -> None:
    """A header missing the ``sha256=`` prefix must fail."""
    assert verify_signature(b"x", "deadbeef", "any") is False
    assert verify_signature(b"x", "sha1=deadbeef", "any") is False


def test_dispatch_issues_direction_label_routes_to_ingester() -> None:
    """``issues.opened`` with the direction label triggers the ingester path."""
    payload = {
        "action": "opened",
        "repository": {"full_name": "xvanov/sacrifice"},
        "issue": {
            "number": 42,
            "labels": [{"name": "direction"}],
        },
    }
    result = dispatch_event("issues", payload)
    assert result["acted"] is True
    assert result["issue_number"] == 42
    # App resolves from apps/sacrifice/config.yaml in this repo.
    assert result["app"] == "sacrifice"


def test_dispatch_issues_without_direction_label_no_op() -> None:
    payload = {
        "action": "opened",
        "repository": {"full_name": "xvanov/sacrifice"},
        "issue": {"number": 7, "labels": [{"name": "bug"}]},
    }
    result = dispatch_event("issues", payload)
    assert result["acted"] is False
    assert "no direction" in result["reason"]


def test_dispatch_labeled_event_only_acts_on_direction_label() -> None:
    """``issues.labeled`` with label.name != 'direction' is a no-op."""
    payload = {
        "action": "labeled",
        "label": {"name": "feature"},
        "repository": {"full_name": "xvanov/sacrifice"},
        "issue": {"number": 9, "labels": [{"name": "feature"}]},
    }
    result = dispatch_event("issues", payload)
    assert result["acted"] is False


def test_dispatch_labeled_with_direction_label_acts() -> None:
    payload = {
        "action": "labeled",
        "label": {"name": "direction"},
        "repository": {"full_name": "xvanov/sacrifice"},
        "issue": {"number": 11, "labels": [{"name": "direction"}]},
    }
    result = dispatch_event("issues", payload)
    assert result["acted"] is True
    assert result["issue_number"] == 11


def test_dispatch_check_suite_extracts_pr_and_conclusion() -> None:
    payload = {
        "check_suite": {
            "conclusion": "success",
            "pull_requests": [{"number": 99}],
        }
    }
    result = dispatch_event("check_suite", payload)
    assert result["pr_number"] == 99
    assert result["conclusion"] == "success"


def test_dispatch_unhandled_event_is_no_op() -> None:
    result = dispatch_event("ping", {})
    assert result["acted"] is False


def test_signature_distinguishes_payloads_with_same_prefix() -> None:
    """Regression: an attacker who controls a prefix of the payload must not
    forge a valid signature. HMAC under SHA256 is collision-resistant; we
    encode that as a behavioral test."""
    secret = "s"
    a = b'{"action":"opened","number":1}'
    b = b'{"action":"opened","number":2}'
    sig_a = _sign(a, secret)
    sig_b = _sign(b, secret)
    assert sig_a != sig_b
    assert verify_signature(a, sig_a, secret) is True
    assert verify_signature(b, sig_a, secret) is False  # cross-payload fails
    assert verify_signature(a, sig_b, secret) is False
    # And the JSON parses (sanity).
    assert json.loads(a)["number"] == 1
    assert json.loads(b)["number"] == 2
