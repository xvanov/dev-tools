"""The credential broker: pushes and PRs for a sandboxed run, outside the sandbox.

Keys never enter the sandbox (native plan 5.3). The agent's process has no
GitHub token, no ``gh`` login and no SSH key; it gets this broker's address and
a per-run capability (a random secret that is worth nothing outside this
broker). The broker runs as the operator, holds the credentials (the per-owner
resolver :func:`factory.gh_auth.token_for_repo`, and the operator's own git/SSH
setup for pushes) and does exactly two things, each checked against the run's
**ceiling** before it acts:

=============  ===============================================================
ceiling        allowed
=============  ===============================================================
``none``       nothing (info only)
``push_branch``  push the run's commit to a non-protected branch, no force
``draft_pr``   that, plus open ONE draft PR from a branch this broker pushed
=============  ===============================================================

The ceiling comes from the run's delivery level (``factory.sandbox.
ceiling_for_delivery``): a factory agent run is ``none`` because the factory
delivers its work itself; a PA session runs at its mode's ceiling. Nothing the
agent sends can raise it, choose the repo, mark a PR ready, merge, force-push
or touch a protected branch (the default branch, ``main``, ``master``).

**The agent's checkout is untrusted.** The broker never runs git *in* it (a
planted ``core.sshCommand``, hook or ``url.<x>.insteadOf`` would run as the
operator). It fetches the commit from the checkout into a bare mirror of its
own and pushes from there to a push URL the caller captured from the trusted
repo before the sandbox started.

HTTP API (JSON, ``Authorization: Bearer <capability>``):

* ``GET  /v1/info`` -> ``{repo, ceiling, default_branch, branch_prefix, pushed, prs}``
* ``POST /v1/push`` ``{branch, ref?}`` -> ``{branch, sha}``
* ``POST /v1/pr``   ``{title, body?, head, base?}`` -> ``{number, url, draft: true}``

Every request, allowed or refused, is appended to ``<state_dir>/audit.jsonl``
(never a token). CLI for callers that are not Python (the PA)::

    python -m factory.sandbox.broker serve --spec run.json --endpoint-file ep.json
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from factory.sandbox import CEILINGS

_BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
_SHA_RE = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$")
_MAX_BODY = 256 * 1024
_GIT_TIMEOUT_S = 300
DEFAULT_API = "https://api.github.com"


class BrokerError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class BrokerRun:
    """One run's broker configuration. Set by the caller, never by the agent."""

    run_id: str
    repo: str
    source: Path
    ceiling: str
    push_url: str
    default_branch: str = "main"
    branch_prefix: str | None = None
    max_prs: int = 1
    capability: str = field(default_factory=lambda: secrets.token_urlsafe(32))

    def __post_init__(self) -> None:
        if self.ceiling not in CEILINGS:
            # Fail safe: an unknown ceiling is the most restrictive one.
            self.ceiling = "none"
        if not _REPO_RE.match(self.repo or ""):
            raise ValueError(f"repo must be owner/name, got {self.repo!r}")
        self.source = Path(self.source)

    @property
    def protected(self) -> frozenset[str]:
        return frozenset({"main", "master", self.default_branch})

    @classmethod
    def from_spec(cls, spec: dict[str, Any]) -> BrokerRun:
        keys = {
            "run_id", "repo", "source", "ceiling", "push_url", "default_branch",
            "branch_prefix", "max_prs", "capability",
        }
        return cls(**{k: v for k, v in spec.items() if k in keys and v is not None})


def valid_branch(name: str) -> bool:
    """A branch name git accepts and that cannot be read as an option or a
    revision expression. Conservative on purpose."""
    if not isinstance(name, str) or not _BRANCH_RE.match(name):
        return False
    bad = ("..", "//", "@{", "/.", ".lock/")
    if any(b in name for b in bad) or name.endswith((".lock", "/", ".")):
        return False
    return True


class Broker:
    """The broker's logic, independent of HTTP (tests call :meth:`handle`)."""

    def __init__(
        self,
        run: BrokerRun,
        state_dir: Path,
        *,
        token_for_repo: Callable[[str], str | None] | None = None,
        api_base: str | None = None,
        git: str = "git",
    ) -> None:
        self.run = run
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if token_for_repo is None:
            from factory.gh_auth import token_for_repo as _resolver

            token_for_repo = _resolver
        self._token_for_repo = token_for_repo
        self.api_base = (api_base or os.environ.get("FACTORY_GITHUB_API_URL") or DEFAULT_API).rstrip("/")
        self.git = git
        self.pushed: dict[str, str] = {}
        self.prs: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    # -- entry point ---------------------------------------------------------

    def authorized(self, header: str | None) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].strip().encode(), self.run.capability.encode())

    def handle(
        self, method: str, path: str, auth: str | None, body: dict[str, Any] | None
    ) -> tuple[int, dict[str, Any]]:
        """``(status, json)`` for one request. Audited, whatever the outcome."""
        op = f"{method} {path}"
        try:
            if not self.authorized(auth):
                raise BrokerError(401, "missing or wrong broker capability")
            with self._lock:
                if method == "GET" and path == "/v1/info":
                    result = self.info()
                elif method == "POST" and path == "/v1/push":
                    result = self.push(**_only(body, "branch", "ref"))
                elif method == "POST" and path == "/v1/pr":
                    result = self.create_pr(**_only(body, "title", "body", "head", "base"))
                else:
                    raise BrokerError(404, f"no such broker operation: {op}")
            self._audit(op, body, 200, None)
            return 200, result
        except BrokerError as exc:
            self._audit(op, body, exc.status, exc.message)
            return exc.status, {"error": exc.message, "ceiling": self.run.ceiling}
        except TypeError as exc:  # unexpected/missing JSON fields
            self._audit(op, body, 400, str(exc))
            return 400, {"error": f"bad request: {exc}"}

    # -- operations ----------------------------------------------------------

    def info(self) -> dict[str, Any]:
        r = self.run
        return {
            "repo": r.repo,
            "ceiling": r.ceiling,
            "default_branch": r.default_branch,
            "branch_prefix": r.branch_prefix,
            "pushed": dict(self.pushed),
            "prs": list(self.prs),
        }

    def _check_branch(self, branch: Any, *, what: str) -> str:
        if not isinstance(branch, str) or not valid_branch(branch):
            raise BrokerError(400, f"{what}: not an acceptable branch name: {branch!r}")
        if branch in self.run.protected:
            raise BrokerError(403, f"{what}: {branch!r} is protected; the agent never writes it")
        prefix = self.run.branch_prefix
        if prefix and not branch.startswith(prefix):
            raise BrokerError(403, f"{what}: this run may only use branches under {prefix!r}")
        return branch

    def push(self, branch: Any = None, ref: Any = "HEAD") -> dict[str, Any]:
        if self.run.ceiling not in ("push_branch", "draft_pr"):
            raise BrokerError(403, f"push refused: this run's ceiling is {self.run.ceiling!r}")
        branch = self._check_branch(branch, what="push")
        ref = "HEAD" if ref in (None, "") else ref
        if ref != "HEAD" and not (isinstance(ref, str) and _SHA_RE.match(ref)):
            raise BrokerError(400, "ref must be HEAD or a full commit sha")
        mirror = self._mirror()
        # Fetch FROM the untrusted checkout into our own bare mirror. Only the
        # mirror's (clean) config is in effect; nothing runs in the checkout.
        self._git(
            ["-C", str(mirror), "-c", "protocol.file.allow=always", "fetch", "--no-tags",
             "--no-recurse-submodules", "--no-write-fetch-head", "--",
             str(self.run.source), f"+{ref}:refs/sbx/incoming"],
            failure=(502, "could not read the commit from the run's checkout"),
        )
        sha = self._git(
            ["-C", str(mirror), "rev-parse", "--verify", "refs/sbx/incoming^{commit}"],
            failure=(502, "the fetched ref is not a commit"),
        ).strip()
        self._git(
            ["-C", str(mirror), "push", "--porcelain", "--no-verify", "--",
             self.run.push_url, f"{sha}:refs/heads/{branch}"],
            failure=(409, f"push to {branch!r} was rejected (no force pushes; is it behind?)"),
        )
        self.pushed[branch] = sha
        return {"branch": branch, "sha": sha}

    def create_pr(
        self, title: Any = None, body: Any = "", head: Any = None, base: Any = None
    ) -> dict[str, Any]:
        if self.run.ceiling != "draft_pr":
            raise BrokerError(403, f"PR refused: this run's ceiling is {self.run.ceiling!r}")
        if len(self.prs) >= self.run.max_prs:
            raise BrokerError(403, f"PR refused: this run may open at most {self.run.max_prs}")
        if not isinstance(title, str) or not title.strip() or len(title) > 256:
            raise BrokerError(400, "title is required (at most 256 characters)")
        body = "" if body is None else body
        if not isinstance(body, str) or len(body) > 60000:
            raise BrokerError(400, "body must be text (at most 60000 characters)")
        head = self._check_branch(head, what="pr head")
        if head not in self.pushed:
            raise BrokerError(409, f"push {head!r} through the broker before opening a PR from it")
        base = self.run.default_branch if base in (None, "") else base
        if not isinstance(base, str) or not valid_branch(base):
            raise BrokerError(400, f"not an acceptable base branch: {base!r}")
        token = self._token_for_repo(self.run.repo)
        if not token:
            raise BrokerError(502, f"no GitHub credential for {self.run.repo.split('/')[0]!r}")
        payload = {"title": title, "body": body, "head": head, "base": base, "draft": True}
        status, data = self._github("POST", f"/repos/{self.run.repo}/pulls", token, payload)
        if status not in (200, 201):
            msg = data.get("message") if isinstance(data, dict) else None
            raise BrokerError(502, f"GitHub refused the PR ({status}): {msg or 'no message'}")
        pr = {"number": data.get("number"), "url": data.get("html_url"), "draft": True}
        self.prs.append(pr)
        return pr

    # -- helpers -------------------------------------------------------------

    def _mirror(self) -> Path:
        mirror = self.state_dir / "mirror.git"
        if not (mirror / "HEAD").exists():
            self._git(["init", "--quiet", "--bare", str(mirror)], failure=(500, "mirror init failed"))
        return mirror

    def _git(self, args: list[str], *, failure: tuple[int, str]) -> str:
        env = dict(os.environ)
        env["GIT_TERMINAL_PROMPT"] = "0"
        try:
            r = subprocess.run(  # noqa: S603
                [self.git, *args],
                capture_output=True,
                text=True,
                timeout=_GIT_TIMEOUT_S,
                env=env,
                stdin=subprocess.DEVNULL,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BrokerError(failure[0], f"{failure[1]}: {exc}") from exc
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
            raise BrokerError(failure[0], f"{failure[1]}: {' | '.join(tail)}")
        return r.stdout

    def _github(
        self, method: str, path: str, token: str, payload: dict[str, Any]
    ) -> tuple[int, Any]:
        req = urllib.request.Request(  # noqa: S310 - fixed scheme from config
            self.api_base + path,
            data=json.dumps(payload).encode(),
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "factory-sandbox-broker",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read() or b"{}")
            except ValueError:
                return exc.code, {}
        except (OSError, ValueError) as exc:
            raise BrokerError(502, f"GitHub unreachable: {exc}") from exc

    def _audit(self, op: str, body: dict[str, Any] | None, status: int, error: str | None) -> None:
        entry = {
            "ts": time.time(),
            "run": self.run.run_id,
            "op": op,
            "status": status,
            "ceiling": self.run.ceiling,
            "args": {k: v for k, v in (body or {}).items() if k != "body"},
        }
        if error:
            entry["error"] = error
        try:
            with (self.state_dir / "audit.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry) + "\n")
        except OSError:
            pass


def _only(body: dict[str, Any] | None, *keys: str) -> dict[str, Any]:
    body = body or {}
    if not isinstance(body, dict):
        raise BrokerError(400, "the request body must be a JSON object")
    extra = set(body) - set(keys)
    if extra:
        raise BrokerError(400, f"unknown fields: {', '.join(sorted(extra))}")
    return body


# -- HTTP --------------------------------------------------------------------


def _handler_for(broker: Broker) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "factory-broker"

        def log_message(self, *_a: Any) -> None:  # the audit log is the record
            return

        def _reply(self, status: int, data: dict[str, Any]) -> None:
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def _body(self) -> dict[str, Any] | None:
            n = int(self.headers.get("Content-Length") or 0)
            if n > _MAX_BODY:
                raise BrokerError(413, "request too large")
            if not n:
                return None
            try:
                data = json.loads(self.rfile.read(n))
            except ValueError as exc:
                raise BrokerError(400, "the request body is not JSON") from exc
            if not isinstance(data, dict):
                raise BrokerError(400, "the request body must be a JSON object")
            return data

        def _do(self, method: str) -> None:
            try:
                body = self._body() if method == "POST" else None
            except BrokerError as exc:
                self._reply(exc.status, {"error": exc.message})
                return
            status, data = broker.handle(method, self.path, self.headers.get("Authorization"), body)
            self._reply(status, data)

        def do_GET(self) -> None:  # noqa: N802
            self._do("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._do("POST")

    return Handler


def _unix_server(path: str, handler: type[BaseHTTPRequestHandler]) -> socketserver.BaseServer:
    """POSIX only: the Linux sandbox reaches the broker through a socket file."""
    if sys.platform != "win32":

        class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

            def get_request(self) -> tuple[Any, Any]:
                request, _ = super().get_request()
                return request, ("unix", 0)

        return UnixHTTPServer(path, handler)
    raise OSError("unix sockets are not used on Windows")


def serve(
    broker: Broker, *, host: str = "127.0.0.1", port: int = 0, unix_path: str | None = None
) -> tuple[socketserver.BaseServer, str]:
    """Start serving in a daemon thread. Returns ``(server, address)``;
    ``address`` is ``http://host:port`` or ``unix:<path>``."""
    handler = _handler_for(broker)
    server: socketserver.BaseServer
    if unix_path:
        server = _unix_server(unix_path, handler)
        address = f"unix:{unix_path}"
    else:
        tcp = ThreadingHTTPServer((host, port), handler)
        tcp.daemon_threads = True
        server, address = tcp, f"http://{host}:{tcp.server_address[1]}"
    threading.Thread(target=server.serve_forever, name="sandbox-broker", daemon=True).start()
    return server, address


def write_private(path: Path, data: dict[str, Any]) -> None:
    """Write JSON readable by the owner only (it holds the run's capability)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m factory.sandbox.broker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="serve one run's broker until killed or --ttl")
    s.add_argument("--spec", required=True, help="JSON: run_id, repo, source, ceiling, push_url, ...")
    s.add_argument("--state-dir", required=True)
    s.add_argument("--endpoint-file", required=True, help="written with {url, capability} (0600)")
    s.add_argument("--unix", default=None, help="serve on this unix socket instead of TCP")
    s.add_argument("--ttl", type=float, default=24 * 3600)
    a = ap.parse_args(argv)
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    run = BrokerRun.from_spec(spec)
    broker = Broker(run, Path(a.state_dir))
    server, address = serve(broker, unix_path=a.unix)
    write_private(Path(a.endpoint_file), {"url": address, "capability": run.capability,
                                          "ceiling": run.ceiling, "pid": os.getpid()})
    try:
        time.sleep(a.ttl)
    except KeyboardInterrupt:
        pass
    server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
