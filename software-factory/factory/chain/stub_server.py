"""The gutted-implementation control (019 AC2): a catch-all HTTP stub.

Pure stdlib, in-process, no app tree involved. This is what the acceptance
oracle runs against BEFORE any real boot happens: a server that answers every
request with a fixed ``200 {}`` — a no-op implementation of the story's whole
surface. A criterion that STILL passes here could be satisfied by a no-op and
must never be credited (see ``factory.chain.gates.acceptance_verified``); an
oracle that sends zero requests, or one where EVERY criterion passes the stub,
is ``vacuous_oracle`` and blocks before a single real boot is paid for.

Deliberately a catch-all rather than a route-scoped 404 responder: a fixed
``200 {}`` for every path and every method is the STRICTER control — a
criterion that only checks a status code or an absence is satisfied by it, so
it is the control that catches the most vacuous criteria, which is the
direction this control must err in. (A route-scoped 404 would be MORE
permissive: a criterion asserting "the route returns 404" would pass a 404
stub even though a real broken route also returns 404, hiding the vacuity.)

TWO VARIANTS, and crediting requires failing BOTH (found 2026-08-07). The
single ``{}`` (empty) variant is too PERMISSIVE in one specific, likely shape:
an LLM-authored criterion like ``assert r.status_code == 200; items =
r.json()["items"]; assert len(items) >= 0`` fails the empty stub with a
``KeyError`` on ``"items"`` — which LOOKS like discriminating evidence, but
the actual boolean the author wrote (``len(items) >= 0``) is true for ANY
list, including the empty one a real no-op would return. The failure is an
accident of the stub's THINNESS, not of the assertion's strength. The
``plausible`` variant answers with a body carrying commonly-shaped keys
(``items: []``, ``id``, ``data``, …) precisely so that a criterion whose only
real content is "the response has roughly this shape" PASSES it — correctly
outing the criterion as vacuous — while a criterion that checks a SPECIFIC
value (``items[0]["email"] == "..."``) still fails it (``IndexError``) and
stays credited. A criterion must fail BOTH variants to enter ``K``; passing
either one is enough to exclude it. Kept in-process and cheap (two catch-all
stdlib servers, no boot) rather than app-specific — this is a heuristic
widening of the control, not a claim that it enumerates every possible
plausible shape.

Every request's body is drained before responding (Content-Length or
chunked): skipping this leaves unread bytes on the socket, ``httpx`` sees a
connection reset on keep-alive, and a criterion that legitimately would have
failed the stub instead reports a client-side ERROR that looks like
discriminating evidence. ``protocol_version = "HTTP/1.1"`` is what makes that
drain logic load-bearing rather than decorative: HTTP/1.0 (the stdlib
default) closes the connection after every response, so a client never
reuses one and never observes an undrained body corrupting the NEXT request
on the same connection — the exact bug the drain exists to prevent.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

#: Bumped whenever the stub's *behaviour* changes (its response shape, its
#: draining logic, which methods it answers) — the stub run is cached on
#: ``(oracle_sha, STUB_VERSION, RUNNER_VERSION)``, and a stale cache entry from
#: a behaviourally different stub must not be reused as if nothing changed.
#: Bumped 2026-08-07: the ``plausible`` variant + HTTP/1.1 keep-alive.
STUB_VERSION = 2

_EMPTY_BODY = b"{}"
_PLAUSIBLE_BODY = json.dumps(
    {
        "id": "stub", "items": [], "results": [], "data": {}, "count": 0,
        "total": 0, "status": "ok", "message": "stub", "name": "stub",
        "email": "stub@example.com", "value": None, "ok": True, "success": True,
    }
).encode("utf-8")

#: The variant names crediting must fail BOTH of.
STUB_VARIANTS = ("empty", "plausible")
_MAX_LOG = 200


class _StubHandler(BaseHTTPRequestHandler):
    # Set by ``stub_app()`` on the per-instance handler subclass before the
    # server starts; a plain class attribute would leak counts across
    # concurrent stub instances in the same test process.
    protocol_version = "HTTP/1.1"
    _counter: list[int]
    _log: deque[str]
    _body: bytes

    def _drain_body(self) -> None:
        length = self.headers.get("Content-Length")
        if length is not None:
            try:
                n = int(length)
            except ValueError:
                n = 0
            if n > 0:
                self.rfile.read(n)
            return
        if (self.headers.get("Transfer-Encoding") or "").strip().lower() == "chunked":
            # Best-effort chunked drain — good enough for an oracle's httpx
            # client, which does not send chunked request bodies by default.
            while True:
                try:
                    size_line = self.rfile.readline(64).strip()
                    size = int(size_line, 16) if size_line else 0
                except (ValueError, OSError):
                    return
                if size <= 0:
                    self.rfile.readline(2)
                    return
                self.rfile.read(size)
                self.rfile.read(2)

    def _respond(self) -> None:
        self._drain_body()
        self._counter[0] += 1
        self._log.append(f"{self.command} {self.path}")
        if self.command == "HEAD":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(self._body)))
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self._body)))
        self.end_headers()
        try:
            self.wfile.write(self._body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler naming
        self._respond()

    def do_POST(self) -> None:  # noqa: N802
        self._respond()

    def do_PUT(self) -> None:  # noqa: N802
        self._respond()

    def do_PATCH(self) -> None:  # noqa: N802
        self._respond()

    def do_DELETE(self) -> None:  # noqa: N802
        self._respond()

    def do_HEAD(self) -> None:  # noqa: N802
        self._respond()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._respond()

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A002
        pass  # never write request noise to the gate's captured stderr


class StubApp:
    """A live catch-all HTTP stub. ``request_count``/``requests`` update live."""

    def __init__(self, base_url: str, counter: list[int], log: deque[str]) -> None:
        self.base_url = base_url
        self._counter = counter
        self._log = log

    @property
    def request_count(self) -> int:
        return self._counter[0]

    @property
    def requests(self) -> list[str]:
        return list(self._log)


@contextmanager
def stub_app(variant: str = "empty") -> Iterator[StubApp]:
    """A catch-all HTTP stub on an ephemeral port, torn down on exit.

    ``variant``: ``"empty"`` (fixed ``200 {}``) or ``"plausible"`` (a body
    with commonly-shaped keys — see the module docstring for why crediting
    needs both). In-process (a daemon thread), not a subprocess — there is
    nothing to boot and nothing that can leak a process group: the whole
    point of the stub is that it is the factory's OWN trusted code, never
    the diff's.
    """
    if variant not in STUB_VARIANTS:
        raise ValueError(f"unknown stub variant {variant!r}, expected one of {STUB_VARIANTS!r}")
    body = _EMPTY_BODY if variant == "empty" else _PLAUSIBLE_BODY
    counter = [0]
    log: deque[str] = deque(maxlen=_MAX_LOG)

    class _Bound(_StubHandler):
        pass

    _Bound._counter = counter
    _Bound._log = log
    _Bound._body = body

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Bound)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="factory-stub")
    thread.start()
    try:
        yield StubApp(base_url=f"http://127.0.0.1:{port}", counter=counter, log=log)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


__all__ = ["STUB_VARIANTS", "STUB_VERSION", "StubApp", "stub_app"]
