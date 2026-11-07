"""A minimal termhub HTTP client (the API ``personal-assistant/src/dispatch/termhub.js`` uses).

termhub (``termhub/`` in dev-tools) owns PTYs a human can open from a browser
or phone. The factory starts each Claude Code run as a termhub session so the
run can be watched live; see ``termhub/AGENT.md`` for the API:

* ``POST /api/sessions`` ``{cwd, command, title, cols, rows}`` → ``{id}`` (or
  ``{session: {id}}`` on some versions) — the command is typed into a shell.
* ``POST /api/sessions/:id/input`` ``{data, submit}`` — type into it.
* ``DELETE /api/sessions/:id`` — kill it.
* ``GET /api/sessions`` → ``{sessions: [...]}``.
* ``GET /api/secure-url`` → ``{secureUrl}`` (answered by termhub's front only).

Every state-changing call carries ``X-Termhub: 1`` (termhub's CSRF guard).

Config (env, usually set in the factory's ``.env``):

* ``FACTORY_TERMHUB_URL`` — API base, default ``http://127.0.0.1:7010``
  (termhub's sessiond on the same machine).
* ``FACTORY_TERMHUB_PUBLIC_URL`` — the origin a human opens (e.g. the
  Tailscale HTTPS address). Default: ``/api/secure-url`` if the base answers
  it, else the base.
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_URL = "http://127.0.0.1:7010"


class TermhubError(RuntimeError):
    pass


@dataclass
class TermhubClient:
    base: str
    public: str | None = None
    timeout_s: float = 15.0

    @classmethod
    def from_env(cls) -> TermhubClient:
        base = (os.environ.get("FACTORY_TERMHUB_URL") or DEFAULT_URL).rstrip("/")
        public = (os.environ.get("FACTORY_TERMHUB_PUBLIC_URL") or "").rstrip("/") or None
        return cls(base=base, public=public)

    def _call(self, path: str, *, method: str = "GET", body: Any = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"X-Termhub": "1"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:200].decode(errors="replace") if exc.fp else ""
            raise TermhubError(f"termhub {exc.code} on {method} {path}: {detail}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise TermhubError(f"termhub unreachable at {self.base}: {exc}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def reachable(self) -> bool:
        try:
            self._call("/api/sessions")
            return True
        except TermhubError:
            return False

    def create_session(self, *, cwd: str, command: str, title: str) -> str:
        payload = self._call(
            "/api/sessions",
            method="POST",
            body={"cwd": cwd, "command": command, "title": title, "cols": 140, "rows": 40},
        )
        sid = None
        if isinstance(payload, dict):
            sid = payload.get("id") or (payload.get("session") or {}).get("id")
        if not sid:
            raise TermhubError("termhub did not return a session id")
        return str(sid)

    def type_line(self, session_id: str, text: str) -> None:
        self._call(
            f"/api/sessions/{urllib.parse.quote(session_id)}/input",
            method="POST",
            body={"data": text, "submit": True},
        )

    def kill(self, session_id: str) -> bool:
        try:
            self._call(f"/api/sessions/{urllib.parse.quote(session_id)}", method="DELETE")
            return True
        except TermhubError:
            return False

    def alive(self, session_id: str) -> bool | None:
        """True/False when termhub answered; ``None`` when it could not be asked."""
        try:
            payload = self._call("/api/sessions")
        except TermhubError:
            return None
        sessions = payload.get("sessions") if isinstance(payload, dict) else payload
        if not isinstance(sessions, list):
            return None
        return any(isinstance(s, dict) and str(s.get("id")) == session_id for s in sessions)

    def public_origin(self) -> str:
        if self.public:
            return self.public
        try:
            payload = self._call("/api/secure-url")
            if isinstance(payload, dict) and payload.get("secureUrl"):
                self.public = str(payload["secureUrl"]).rstrip("/")
                return self.public
        except TermhubError:
            pass
        return self.base

    def session_url(self, session_id: str) -> str:
        return f"{self.public_origin()}/#session={urllib.parse.quote(session_id)}"


def machine_name() -> str:
    return socket.gethostname()


__all__ = ["DEFAULT_URL", "TermhubClient", "TermhubError", "machine_name"]
