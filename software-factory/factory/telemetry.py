"""Spans and Claude usage, posted to the personal assistant's Meter.

The PA keeps trace spans of its main hops in its own database and shows p50/p95
per hop on the Meter page (``personal-assistant/src/telemetry``). The factory is
Python and has no way into that database, so it posts what it measured to the
PA's ``POST /api/telemetry`` (native plan 7.5). Two things go:

* **spans** of the factory's hops (a handler: sm, dev, review, tech-writer,
  deploy; a claude_session run), via :func:`span` / :func:`traced`;
* **usage** of a claude_session run (:func:`record_usage`): Claude Code's
  ``total_cost_usd`` and token ``usage`` from the stream-json result record. A
  subscription run is not metered here (``runs.cost_usd`` stays 0), but it
  draws from the Claude credit pool, which the PA tracks against
  ``PA_CLAUDE_POOL_USD``.

Off unless ``PA_TELEMETRY_URL`` is set (the PA's dashboard, e.g.
``http://127.0.0.1:7300``), so tests and a factory with no PA pay nothing and
make no network call. Best effort: a PA that is down loses the points, never a
run. Nothing here carries prompt or reply text: ids, names, counts, durations.
"""

from __future__ import annotations

import atexit
import contextvars
import functools
import json
import os
import secrets
import threading
import time
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, TypeVar

URL_ENV = "PA_TELEMETRY_URL"
#: How long one post may take, and how long exit waits for the last ones.
POST_TIMEOUT_S = 2.0
EXIT_WAIT_S = 2.0
_MAX_ATTR_CHARS = 200

# (trace_id, span_id) of the span being run, so a nested span is its child.
_current: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "factory_telemetry_span", default=None
)
_pending: list[threading.Thread] = []
_pending_lock = threading.Lock()

F = TypeVar("F", bound=Callable[..., Any])


def endpoint() -> str | None:
    """``<PA_TELEMETRY_URL>/api/telemetry``, or None when telemetry is off."""
    base = (os.environ.get(URL_ENV) or "").strip().rstrip("/")
    return f"{base}/api/telemetry" if base else None


def enabled() -> bool:
    return endpoint() is not None


def _post(payload: dict[str, Any]) -> None:
    """One POST to the PA. The seam tests replace; never raises."""
    url = endpoint()
    if url is None:
        return
    try:
        req = urllib.request.Request(  # noqa: S310 - operator-configured URL
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-PA": "1"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=POST_TIMEOUT_S):  # noqa: S310
            pass
    except Exception:  # noqa: BLE001 - telemetry must never fail a run
        return


def _send(payload: dict[str, Any]) -> None:
    """Fire and forget on a daemon thread; exit waits briefly for stragglers."""
    if not enabled():
        return
    t = threading.Thread(target=_post, args=(payload,), daemon=True, name="factory-telemetry")
    with _pending_lock:
        _pending[:] = [p for p in _pending if p.is_alive()]
        _pending.append(t)
    t.start()


def flush(timeout_s: float = EXIT_WAIT_S) -> None:
    """Wait (bounded) for posts still in flight."""
    deadline = time.monotonic() + timeout_s
    with _pending_lock:
        threads = list(_pending)
    for t in threads:
        t.join(max(0.0, deadline - time.monotonic()))


atexit.register(flush)


def _clean(attrs: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in attrs.items():
        if isinstance(value, bool | int | float):
            out[str(key)] = value
        elif isinstance(value, str):
            out[str(key)] = value[:_MAX_ATTR_CHARS]
    return out


@contextmanager
def span(hop: str, name: str | None = None, **attrs: Any) -> Iterator[dict[str, Any]]:
    """Time a block as a span of ``hop`` and post it when it ends.

    Yields the span's attribute dict: the block may add small scalars to it
    (``s["story"] = 12``). An exception marks the span failed and propagates.
    With telemetry off the block just runs.
    """
    live: dict[str, Any] = dict(attrs)
    if not enabled():
        yield live
        return
    parent = _current.get()
    trace_id = parent[0] if parent else secrets.token_hex(16)
    span_id = secrets.token_hex(8)
    token = _current.set((trace_id, span_id))
    started = datetime.now(UTC)
    t0 = time.monotonic()
    ok = True
    try:
        yield live
    except BaseException:
        ok = False
        raise
    finally:
        _current.reset(token)
        _send(
            {
                "spans": [
                    {
                        "traceId": trace_id,
                        "spanId": span_id,
                        "parentSpanId": parent[1] if parent else None,
                        "hop": hop,
                        "name": name or hop,
                        "startedAt": started.isoformat(),
                        "durationMs": round((time.monotonic() - t0) * 1000),
                        "ok": ok,
                        "attrs": _clean(live),
                    }
                ]
            }
        )


def traced(hop: str) -> Callable[[F], F]:
    """Decorator form of :func:`span`: the function's own name is the span's name."""

    def deco(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with span(hop, fn.__name__):
                return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return deco


def record_usage(
    *,
    purpose: str,
    model: str | None,
    cost_usd: float | None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    duration_ms: int | None = None,
    ok: bool = True,
) -> None:
    """Post one claude_session run's usage: the stream-json result's
    ``total_cost_usd`` (what it would have cost at API prices) and tokens. The PA
    records it as a ``claude_session`` llm_spend row, which is what the credit
    pool is summed from."""
    _send(
        {
            "usage": [
                {
                    "purpose": purpose,
                    "model": model,
                    "costUsd": cost_usd,
                    "inputTokens": tokens_in,
                    "outputTokens": tokens_out,
                    "durationMs": duration_ms,
                    "ok": ok,
                }
            ]
        }
    )


__all__ = ["enabled", "endpoint", "flush", "record_usage", "span", "traced"]
