"""factory.telemetry: spans and claude_session usage posted to the PA's Meter.

No network: ``_post`` is the seam, replaced with a recorder.
"""

from __future__ import annotations

import pytest

from factory import telemetry


@pytest.fixture
def posts(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    got: list[dict] = []
    monkeypatch.setenv(telemetry.URL_ENV, "http://127.0.0.1:7300/")
    monkeypatch.setattr(telemetry, "_post", got.append)
    return got


def test_off_without_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(telemetry.URL_ENV, raising=False)
    got: list[dict] = []
    monkeypatch.setattr(telemetry, "_post", got.append)
    assert not telemetry.enabled()
    with telemetry.span("factory.dev", "x") as s:
        s["n"] = 1
    telemetry.record_usage(purpose="p", model="m", cost_usd=1.0)
    telemetry.flush()
    assert got == []


def test_endpoint_trims_the_base(posts: list[dict]) -> None:
    assert telemetry.endpoint() == "http://127.0.0.1:7300/api/telemetry"


def test_span_posts_hop_name_duration_and_attrs(posts: list[dict]) -> None:
    with telemetry.span("factory.dev", "handle_dev", story=12) as s:
        s["rounds"] = 2
        s["ignored"] = object()  # not a scalar: dropped
    telemetry.flush()
    (payload,) = posts
    (sp,) = payload["spans"]
    assert (sp["hop"], sp["name"], sp["ok"]) == ("factory.dev", "handle_dev", True)
    assert sp["attrs"] == {"story": 12, "rounds": 2}
    assert sp["durationMs"] >= 0 and len(sp["traceId"]) == 32 and len(sp["spanId"]) == 16
    assert sp["parentSpanId"] is None


def test_nested_span_is_a_child_in_the_same_trace(posts: list[dict]) -> None:
    with telemetry.span("factory.dev", "outer"):
        with telemetry.span("factory.claude_session", "inner"):
            pass
    telemetry.flush()
    spans = {p["spans"][0]["name"]: p["spans"][0] for p in posts}
    assert spans["inner"]["parentSpanId"] == spans["outer"]["spanId"]
    assert spans["inner"]["traceId"] == spans["outer"]["traceId"]


def test_an_exception_marks_the_span_failed_and_propagates(posts: list[dict]) -> None:
    with pytest.raises(ValueError), telemetry.span("deploy", "boom"):
        raise ValueError("no")
    telemetry.flush()
    assert posts[0]["spans"][0]["ok"] is False


def test_traced_names_the_span_after_the_function(posts: list[dict]) -> None:
    @telemetry.traced("factory.review")
    def handle_x(a: int) -> int:
        return a + 1

    assert handle_x(1) == 2
    assert handle_x.__name__ == "handle_x"
    telemetry.flush()
    assert posts[0]["spans"][0]["hop"] == "factory.review"
    assert posts[0]["spans"][0]["name"] == "handle_x"


def test_record_usage_payload(posts: list[dict]) -> None:
    telemetry.record_usage(
        purpose="factory-dev",
        model="claude-opus-5",
        cost_usd=1.25,
        tokens_in=100,
        tokens_out=20,
        duration_ms=4000,
        ok=True,
    )
    telemetry.flush()
    assert posts == [
        {
            "usage": [
                {
                    "purpose": "factory-dev",
                    "model": "claude-opus-5",
                    "costUsd": 1.25,
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "durationMs": 4000,
                    "ok": True,
                }
            ]
        }
    ]
