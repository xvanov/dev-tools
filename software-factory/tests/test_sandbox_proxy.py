"""The egress allowlist proxy (native plan 5.2). Upstreams are local servers;
nothing leaves the machine."""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from factory.sandbox.proxy import (
    DEFAULT_ALLOW,
    Allowlist,
    EgressProxy,
    Rule,
    allowlist_from_env,
)


@pytest.fixture
def upstream():
    class H(BaseHTTPRequestHandler):
        def log_message(self, *_a: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802
            raw = f"hello {self.path}".encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


def start(entries: list[str], tmp_path: Path, *, allow_private: bool = True):
    proxy = EgressProxy(
        Allowlist(entries, allow_private=allow_private), log_path=tmp_path / "egress.jsonl"
    )
    server, url = proxy.serve()
    return proxy, server, int(url.rsplit(":", 1)[1])


def roundtrip(port: int, data: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(data)
        out = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                return out
            out += chunk


def connect_then_get(port: int, target: str, path: str = "/x") -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
        head = s.recv(4096)
        if not head.startswith(b"HTTP/1.1 200"):
            return head
        s.sendall(f"GET {path} HTTP/1.0\r\nHost: {target}\r\n\r\n".encode())
        out = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                return out
            out += chunk


@pytest.mark.parametrize(
    ("entry", "host", "port", "ok"),
    [
        ("github.com", "github.com", 443, True),
        ("github.com", "api.github.com", 443, False),
        ("github.com", "github.com", 22, False),
        ("*.github.com", "api.github.com", 443, True),
        ("*.github.com", "github.com", 443, False),
        ("*.github.com", "evilgithub.com", 443, False),
        ("localhost:8080", "localhost", 8080, True),
        ("localhost:8080", "localhost", 443, False),
    ],
)
def test_rule_matching(entry, host, port, ok):
    assert Rule.parse(entry).matches(host, port) is ok


def test_allowlist_env_adds_or_replaces():
    assert allowlist_from_env({})[: len(DEFAULT_ALLOW)] == list(DEFAULT_ALLOW)
    assert "example.org" in allowlist_from_env({"SANDBOX_EGRESS_ALLOW": "example.org"})
    assert allowlist_from_env({"SANDBOX_EGRESS_ALLOW_ONLY": "a.test, b.test"}) == [
        "a.test",
        "b.test",
    ]


def test_defaults_cover_github_models_and_registries():
    a = Allowlist(DEFAULT_ALLOW)
    for host in (
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "api.anthropic.com",
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
    ):
        assert a.allows(host, 443), host
    for host in ("example.com", "pastebin.com", "github.com.evil.io"):
        assert not a.allows(host, 443), host


def test_connect_to_an_allowlisted_host_tunnels(upstream, tmp_path):
    proxy, server, port = start([f"127.0.0.1:{upstream}"], tmp_path)
    try:
        out = connect_then_get(port, f"127.0.0.1:{upstream}", "/ok")
        assert b"hello /ok" in out
        assert proxy.decisions[-1]["allowed"] is True
    finally:
        server.shutdown()


def test_connect_to_a_non_allowlisted_host_is_refused(upstream, tmp_path):
    proxy, server, port = start(["github.com"], tmp_path)
    try:
        out = connect_then_get(port, f"127.0.0.1:{upstream}")
        assert out.startswith(b"HTTP/1.1 403") and b"X-Sandbox-Egress: denied" in out
        log = [json.loads(x) for x in (tmp_path / "egress.jsonl").read_text().splitlines()]
        assert log[-1]["host"] == "127.0.0.1" and log[-1]["allowed"] is False
    finally:
        server.shutdown()


def test_plain_http_is_filtered_too(upstream, tmp_path):
    _proxy, server, port = start([f"127.0.0.1:{upstream}"], tmp_path)
    try:
        ok = roundtrip(
            port, f"GET http://127.0.0.1:{upstream}/p?q=1 HTTP/1.1\r\nHost: x\r\n\r\n".encode()
        )
        assert b"hello /p?q=1" in ok
        no = roundtrip(port, b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
        assert no.startswith(b"HTTP/1.1 403")
    finally:
        server.shutdown()


def test_allowlisted_name_resolving_to_a_private_address_is_refused(upstream, tmp_path):
    """The broker, the dashboard and the LAN stay unreachable even if a name
    on the list points there."""
    proxy, server, port = start([f"127.0.0.1:{upstream}"], tmp_path, allow_private=False)
    try:
        out = connect_then_get(port, f"127.0.0.1:{upstream}")
        assert out.startswith(b"HTTP/1.1 403")
        assert "public address" in proxy.decisions[-1]["why"]
    finally:
        server.shutdown()


def test_garbage_is_a_bad_request(tmp_path):
    _proxy, server, port = start(["github.com"], tmp_path)
    try:
        assert roundtrip(port, b"HELLO\r\n\r\n").startswith(b"HTTP/1.1 400")
        assert roundtrip(port, b"GET /relative HTTP/1.1\r\n\r\n").startswith(b"HTTP/1.1 400")
    finally:
        server.shutdown()
