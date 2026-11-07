"""Shared helper: a real BOOTABLE stdlib HTTP app for the out-of-process
acceptance-oracle tests (019 AC2/AC3).

Not named ``test_*`` and not a conftest, so pytest neither collects nor
auto-imports it; the oracle test modules import it explicitly. Pairs with
``tests/oracle_repo.py`` (git plumbing) — this module owns the APP fixture,
that one owns the REPO fixture.

``app_server.py`` is pure stdlib (no app dependencies to install, no venv to
build) so boot is fast and deterministic in CI. It imports ``app.mod`` INSIDE
the request handler (not at module import time) so the mutation ablation's
sentinel — written by the mutated body just before it raises — fires on every
request, not only on the process's first import.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from factory.app_config import AcceptanceBootConfig

GOOD_IMPL = "def normalize_email(e):\n    return e.lower()\n"
BAD_IMPL = "def normalize_email(e):\n    return e.strip()\n"

_APP_SERVER_SRC = '''\
"""Stdlib-only bootable test app (fixture, not app code under test)."""
import http.server
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.BaseHTTPRequestHandler):
    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def _broken_here(self):
        # KNOWN OPEN #1 fixture support: FIXTURE_RUN_ID carries the boot's
        # own run_id (literal-substituted by ``boot._build_env`` from
        # ``{run_id}``) — "healthy but broken" is turned on ONLY for boots
        # whose run_id starts with "base-", modelling a real app whose health
        # endpoint never checks its own dependency (so it always answers 200)
        # while every OTHER route 500s because that dependency (a DB pool,
        # here) never became ready at THIS boot.
        return os.environ.get("FIXTURE_RUN_ID", "").startswith("base-")

    def do_GET(self):
        if self.path == "/health":
            # Deliberately does NOT consult ``_broken_here`` — the whole
            # point of the fixture is a health check that lies.
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {})

    def do_POST(self):
        data = self._read_json()
        if self.path == "/normalize":
            if self._broken_here():
                self._send_json(500, {"error": "db pool not ready"})
                return
            # Imported HERE (request time), not at module load: the mutation
            # ablation's sentinel write happens inside normalize_email's body,
            # and must fire on every call, not only the process's first import.
            import app.mod as mod

            out = mod.normalize_email(data.get("email", ""))
            self._send_json(200, {"email": out})
            return
        self._send_json(404, {})

    def log_message(self, *args):
        pass


def main():
    port = 8000
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
'''


def write_bootable_app(repo: Path, *, impl: str = GOOD_IMPL, subdir: str = "backend") -> None:
    """Write ``<subdir>/app_server.py`` + ``<subdir>/app/mod.py`` into ``repo``."""
    base = repo / subdir
    (base / "app").mkdir(parents=True, exist_ok=True)
    (base / "app" / "__init__.py").write_text("", encoding="utf-8")
    (base / "app" / "mod.py").write_text(impl, encoding="utf-8")
    (base / "app_server.py").write_text(_APP_SERVER_SRC, encoding="utf-8")


def boot_cfg(
    *,
    subdir: str = "backend",
    boot_timeout_seconds: int = 15,
    run_timeout_seconds: int = 20,
    broken_at_base: bool = False,
    **overrides: object,
) -> AcceptanceBootConfig:
    """``broken_at_base=True`` (KNOWN OPEN #1 regression fixture): the booted
    app's ``/health`` always answers 200, but ``/normalize`` (its one real
    route) 500s at ANY boot whose run_id starts with ``"base-"`` — the
    "healthy but broken" shape a lying health check produces at the merge
    base. ``{run_id}`` is substituted literally by ``boot._build_env``, so
    this threads through with no change to ``boot.py`` itself."""
    from factory.app_config import AcceptanceBootConfig

    kwargs: dict[str, object] = {
        "command": f"{sys.executable} -B app_server.py --port {{port}}",
        "cwd": subdir,
        "health_path": "/health",
        "boot_timeout_seconds": boot_timeout_seconds,
        "run_timeout_seconds": run_timeout_seconds,
        "shutdown_grace_seconds": 2,
    }
    if broken_at_base:
        kwargs["env"] = {"FIXTURE_RUN_ID": "{run_id}"}
    kwargs.update(overrides)
    return AcceptanceBootConfig(**kwargs)  # type: ignore[arg-type]


#: An oracle that genuinely drives ``/normalize`` and asserts a real value —
#: red against BAD_IMPL, green against GOOD_IMPL, fails the gutted stub.
HTTP_ORACLE = (
    "import os\n"
    "import httpx\n"
    "\n"
    "def test_ac1_email_is_lowercased():\n"
    "    base = os.environ['ACCEPTANCE_BASE_URL']\n"
    "    r = httpx.post(f'{base}/normalize', json={'email': 'User@Example.COM'}, timeout=5)\n"
    "    assert r.json()['email'] == 'user@example.com'\n"
)

#: Passes at the stub too (no real assertion) — the vacuity case.
HTTP_TAUTOLOGY = (
    "def test_ac1_email_is_lowercased():\n"
    "    assert True\n"
)

#: Checks the status code BEFORE the body — common, reasonable oracle style,
#: and the exact shape that turns a "healthy but broken" base (KNOWN OPEN #1)
#: into a FAIL (an AssertionError on ``status_code == 200``) rather than an
#: ERROR (a KeyError reading a missing field out of a ``{"error": ...}``
#: body). ``verdict_over`` never counted ERROR as red, so the bug needs a
#: FAIL to actually forge one — this is what reproduces that.
HTTP_ORACLE_STRICT = (
    "import os\n"
    "import httpx\n"
    "\n"
    "def test_ac1_email_is_lowercased():\n"
    "    base = os.environ['ACCEPTANCE_BASE_URL']\n"
    "    r = httpx.post(f'{base}/normalize', json={'email': 'User@Example.COM'}, timeout=5)\n"
    "    assert r.status_code == 200\n"
    "    assert r.json()['email'] == 'user@example.com'\n"
)

#: A legacy import-form oracle — statically rejected before any boot.
IMPORT_FORM_ORACLE = (
    "from app.mod import normalize_email\n"
    "\n"
    "def test_ac1_email_is_lowercased():\n"
    "    assert normalize_email('User@Example.COM') == 'user@example.com'\n"
)
