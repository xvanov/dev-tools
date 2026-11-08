"""The egress allowlist proxy for sandboxed runs (native plan 5.2).

A small HTTP proxy: ``CONNECT host:port`` (HTTPS, git over HTTPS, npm, pip,
the model APIs) and absolute-form plain-HTTP requests. A host is let through
only when it is on the allowlist and resolves to a public address; everything
else gets ``403`` and a line in the decision log. TLS is not intercepted: the
proxy sees host names, never content.

Allowlist entries: ``example.com`` (that host only), ``*.example.com`` (any
subdomain, not the apex), optionally ``:port`` (default ports 443 and 80).
:data:`DEFAULT_ALLOW` covers GitHub, the model APIs the factory and Claude Code
use, and the common package registries. ``SANDBOX_EGRESS_ALLOW=a,b`` adds to
it; ``SANDBOX_EGRESS_ALLOW_ONLY=a,b`` replaces it.

Where it is the boundary: on Linux the sandbox has its own network namespace
with no route out, and this proxy (reached through a unix socket) is the only
way out. On Windows the sandbox is pointed at it through ``HTTPS_PROXY`` /
``HTTP_PROXY``; a process that ignores those variables is not stopped there
(see ``factory.sandbox.exec``).
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import select
import socket
import socketserver
import sys
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

DEFAULT_ALLOW: tuple[str, ...] = (
    # GitHub (clone/fetch over HTTPS, API, release assets, raw files)
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    # model APIs
    "api.anthropic.com",
    "statsig.anthropic.com",
    "console.anthropic.com",
    "api.openai.com",
    "*.openai.azure.com",
    "*.services.ai.azure.com",
    "*.cognitiveservices.azure.com",
    "api.deepseek.com",
    "openrouter.ai",
    # package registries
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "api.nuget.org",
    "rubygems.org",
)
DEFAULT_PORTS = (443, 80)
_HEAD_MAX = 32 * 1024
_IDLE_S = 300.0


def allowlist_from_env(env: dict[str, str] | None = None) -> list[str]:
    env = dict(os.environ if env is None else env)
    only = env.get("SANDBOX_EGRESS_ALLOW_ONLY", "").strip()
    base = [x for x in only.split(",") if x.strip()] if only else list(DEFAULT_ALLOW)
    extra = [x for x in env.get("SANDBOX_EGRESS_ALLOW", "").split(",") if x.strip()]
    return [x.strip().lower() for x in base + extra]


@dataclass(frozen=True)
class Rule:
    host: str
    wildcard: bool
    port: int | None

    @classmethod
    def parse(cls, entry: str) -> Rule:
        e = entry.strip().lower()
        port: int | None = None
        if e.count(":") == 1:
            e, p = e.split(":")
            port = int(p)
        wildcard = e.startswith("*.")
        return cls(host=e[2:] if wildcard else e, wildcard=wildcard, port=port)

    def matches(self, host: str, port: int) -> bool:
        if self.port is not None and port != self.port:
            return False
        if self.port is None and port not in DEFAULT_PORTS:
            return False
        if self.wildcard:
            return host.endswith("." + self.host)
        return host == self.host


class Allowlist:
    def __init__(
        self,
        entries: Iterable[str],
        *,
        allow_private: bool = False,
        hosts: dict[str, str] | None = None,
    ) -> None:
        self.rules = [Rule.parse(e) for e in entries if e.strip()]
        self.allow_private = allow_private
        #: Static name -> address answers checked before DNS (tests; pinning).
        self.hosts = {k.lower(): v for k, v in (hosts or {}).items()}

    def allows(self, host: str, port: int) -> bool:
        h = host.strip().lower().rstrip(".")
        return any(r.matches(h, port) for r in self.rules)

    def resolve(self, host: str, port: int) -> list[tuple[str, int]]:
        """The addresses of ``host`` it may connect to; empty if none. Refuses
        names that resolve to loopback / private / link-local space (the
        broker, the dashboard, the LAN) unless ``allow_private``: ALL of a
        name's addresses must be public, so one private answer poisons it."""
        pinned = self.hosts.get(host.lower())
        if pinned:
            addrs = [(pinned, port)]
        else:
            try:
                infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
            except OSError:
                return []
            addrs = [(str(info[4][0]), port) for info in infos]
        if not self.allow_private and not all(
            ipaddress.ip_address(a[0].split("%")[0]).is_global for a in addrs
        ):
            return []
        return addrs


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


class EgressProxy:
    def __init__(
        self, allowlist: Allowlist, *, log_path: Path | None = None, run_id: str = ""
    ) -> None:
        self.allowlist = allowlist
        self.log_path = log_path
        self.run_id = run_id
        self.decisions: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def log(self, host: str, port: int, allowed: bool, why: str) -> None:
        entry = {
            "ts": time.time(),
            "run": self.run_id,
            "host": host,
            "port": port,
            "allowed": allowed,
            "why": why,
        }
        with self._lock:
            self.decisions.append(entry)
            if self.log_path:
                try:
                    with self.log_path.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(entry) + "\n")
                except OSError:
                    pass

    def decide(self, host: str, port: int) -> list[tuple[str, int]] | None:
        if not self.allowlist.allows(host, port):
            self.log(host, port, False, "not on the allowlist")
            return None
        addrs = self.allowlist.resolve(host, port)
        if not addrs:
            self.log(host, port, False, "does not resolve to a public address")
            return None
        self.log(host, port, True, "allowlisted")
        return addrs

    def serve(
        self, host: str = "127.0.0.1", port: int = 0, *, unix_path: str | None = None
    ) -> tuple[socketserver.BaseServer, str]:
        """Serve in a daemon thread; ``(server, url)``. With ``unix_path`` (POSIX),
        on that socket instead: the Linux sandbox reaches it through a relay."""
        proxy = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                proxy._handle(self.request)

        server: socketserver.BaseServer
        if unix_path:
            if sys.platform == "win32":
                raise OSError("unix sockets are not used on Windows")
            else:

                class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
                    daemon_threads = True

                server, url = UnixServer(unix_path, Handler), f"unix:{unix_path}"
        else:
            tcp = _Server((host, port), Handler)
            server, url = tcp, f"http://{host}:{tcp.server_address[1]}"
        threading.Thread(target=server.serve_forever, name="egress-proxy", daemon=True).start()
        return server, url

    # -- one client connection ----------------------------------------------

    def _handle(self, conn: socket.socket) -> None:
        conn.settimeout(30)
        try:
            head = _read_head(conn)
            if head is None:
                return
            line, _, rest = head.partition(b"\r\n")
            parts = line.decode("latin-1").split(" ")
            if len(parts) != 3:
                _deny(conn, 400, "bad request line")
                return
            method, target, version = parts
            if method.upper() == "CONNECT":
                host, port = _split_host_port(target, 443)
                if host is None:
                    _deny(conn, 400, "bad CONNECT target")
                    return
                addr = self.decide(host, port)
                if addr is None:
                    _deny(conn, 403, f"egress to {host}:{port} is not allowed from this sandbox")
                    return
                upstream = _connect(addr)
                if upstream is None:
                    _deny(conn, 502, f"could not connect to {host}:{port}")
                    return
                conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                _pipe(conn, upstream)
                return
            url = urlsplit(target)
            if url.scheme != "http" or not url.hostname:
                _deny(conn, 400, "only absolute http:// URLs or CONNECT")
                return
            host, port = url.hostname, url.port or 80
            addr = self.decide(host, port)
            if addr is None:
                _deny(conn, 403, f"egress to {host}:{port} is not allowed from this sandbox")
                return
            path = url.path or "/"
            if url.query:
                path += "?" + url.query
            headers = [
                h
                for h in rest.split(b"\r\n")
                if h and not h.lower().startswith((b"proxy-", b"connection:"))
            ]
            upstream = _connect(addr)
            if upstream is None:
                _deny(conn, 502, f"could not connect to {host}:{port}")
                return
            upstream.sendall(
                f"{method} {path} {version}\r\n".encode("latin-1")
                + b"\r\n".join([*headers, b"Connection: close"])
                + b"\r\n\r\n"
            )
            _pipe(conn, upstream)
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


def _connect(addrs: list[tuple[str, int]]) -> socket.socket | None:
    for addr in addrs:
        try:
            return socket.create_connection(addr, timeout=15)
        except OSError:
            continue
    return None


def _read_head(conn: socket.socket) -> bytes | None:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > _HEAD_MAX:
            _deny(conn, 431, "request head too large")
            return None
    head, _, extra = buf.partition(b"\r\n\r\n")
    if extra:
        # Pipelined bytes after the head (a body): not supported here; the
        # tools we serve send the head first. Refuse rather than drop them.
        if not head.upper().startswith(b"CONNECT "):
            _deny(conn, 400, "request bodies must follow the head separately")
            return None
    return head


def _split_host_port(target: str, default: int) -> tuple[str | None, int]:
    if target.startswith("["):
        host, _, port = target[1:].partition("]:")
        return (host or None), int(port or default)
    host, _, port = target.rpartition(":")
    if not host:
        return target or None, default
    try:
        return host, int(port)
    except ValueError:
        return None, default


def _deny(conn: socket.socket, status: int, why: str) -> None:
    reason = {
        400: "Bad Request",
        403: "Forbidden",
        502: "Bad Gateway",
        431: "Request Header Fields Too Large",
    }.get(status, "Error")
    body = (why + "\n").encode()
    try:
        conn.sendall(
            f"HTTP/1.1 {status} {reason}\r\nX-Sandbox-Egress: denied\r\n"
            f"Content-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )
    except OSError:
        pass


def _pipe(a: socket.socket, b: socket.socket) -> None:
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, _IDLE_S)
            if x or not r:
                return
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    finally:
        b.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m factory.sandbox.proxy")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--log", default=None)
    ap.add_argument("--ttl", type=float, default=24 * 3600)
    a = ap.parse_args(argv)
    proxy = EgressProxy(Allowlist(allowlist_from_env()), log_path=Path(a.log) if a.log else None)
    server, url = proxy.serve(a.host, a.port)
    print(json.dumps({"url": url}), flush=True)
    try:
        time.sleep(a.ttl)
    except KeyboardInterrupt:
        pass
    server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
