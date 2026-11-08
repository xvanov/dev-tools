"""``sbx``: the sandboxed agent's way to push and open a draft PR.

Inside a sandboxed run there is no GitHub token and no SSH key; this talks to
the run's credential broker (:mod:`factory.sandbox.broker`) instead. Stdlib
only and import-free of the ``factory`` package, so it runs by path::

    sbx info
    sbx push <branch> [--ref <sha>]
    sbx pr --head <branch> --title "..." [--body "..." | --body-file F] [--base main]

Reads ``SANDBOX_BROKER_URL`` and ``SANDBOX_BROKER_CAPABILITY`` from the
environment (the sandbox sets them). Prints the broker's JSON answer; exits 0
on success, 1 on a refusal (the answer says why, and the run's ceiling).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def call(method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
    base = os.environ.get("SANDBOX_BROKER_URL", "").rstrip("/")
    cap = os.environ.get("SANDBOX_BROKER_CAPABILITY", "")
    if not base or not cap:
        return 2, {"error": "no broker in this environment (SANDBOX_BROKER_URL is unset)"}
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(  # noqa: S310 - broker URL set by the sandbox
        base + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {cap}", "Content-Type": "application/json"},
    )
    # The broker is local: never route it through the egress proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=600) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {"error": f"HTTP {exc.code}"}
    except OSError as exc:
        return 2, {"error": f"broker unreachable: {exc}"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sbx", description="push / open a draft PR via the run's broker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    p = sub.add_parser("push")
    p.add_argument("branch")
    p.add_argument("--ref", default="HEAD")
    r = sub.add_parser("pr")
    r.add_argument("--head", required=True)
    r.add_argument("--title", required=True)
    r.add_argument("--body", default="")
    r.add_argument("--body-file", default=None)
    r.add_argument("--base", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "info":
        status, data = call("GET", "/v1/info")
    elif a.cmd == "push":
        status, data = call("POST", "/v1/push", {"branch": a.branch, "ref": a.ref})
    else:
        body = Path(a.body_file).read_text(encoding="utf-8") if a.body_file else a.body
        payload = {"title": a.title, "body": body, "head": a.head}
        if a.base:
            payload["base"] = a.base
        status, data = call("POST", "/v1/pr", payload)
    print(json.dumps(data, indent=2))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
