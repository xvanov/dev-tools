"""Everything one sandboxed run needs, started by its host (factory or PA).

:class:`SandboxRun` creates the run's home, starts its egress proxy and (when
the run has a repo) its credential broker, prepares the run's directories for
the OS sandbox, writes the :class:`~factory.sandbox.policy.Policy`, and wraps
a command line so it starts inside the sandbox::

    with SandboxRun(run_id="app-12", workdir=wt, state_dir=d, ceiling="none") as sb:
        subprocess.run(sb.wrap(["claude", "-p", ...]))

For the personal assistant (Node), the same as a process that lives until it
is killed (or ``--ttl``)::

    python -m factory.sandbox.host --spec spec.json --out ready.json

``ready.json`` gets ``{policy, wrap: [argv prefix], pid}``; the PA prepends
``wrap`` to the agent's command.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from factory.sandbox.broker import Broker, BrokerRun, serve
from factory.sandbox.exec import grant_read, new_run_sid, prepare_dir, protect_dir, wrap_argv
from factory.sandbox.policy import (
    Policy,
    default_readable,
    home_layout,
    sandbox_env,
    write_sbx_shims,
)
from factory.sandbox.proxy import Allowlist, EgressProxy, allowlist_from_env

_PROXY_PORT = 3128
_BROKER_PORT = 3129


def push_url_for(repo_path: Path, remote: str = "origin") -> str | None:
    """The push URL of ``remote`` in the TRUSTED checkout (before any sandbox
    could write to its config)."""
    r = subprocess.run(
        ["git", "-C", str(repo_path), "remote", "get-url", "--push", remote],
        capture_output=True,
        text=True,
        check=False,
    )
    return (r.stdout.strip() or None) if r.returncode == 0 else None


def git_common_dir(workdir: Path) -> str | None:
    """A worktree's shared git dir when it lies OUTSIDE the worktree (read-only
    in the sandbox: ``git status`` / ``diff`` work, its hooks and config
    cannot be changed)."""
    r = subprocess.run(
        ["git", "-C", str(workdir), "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True,
        text=True,
        check=False,
    )
    out = r.stdout.strip()
    if r.returncode != 0 or not out:
        return None
    return None if Path(out).resolve().is_relative_to(Path(workdir).resolve()) else out


def readable_for(workdir: Path, extra: list[str] | None = None) -> list[str]:
    """Read-only paths for a run in ``workdir``: the interpreter and ``factory``
    package, each ``extra`` path (a file counts as its directory: the agent's
    binary), and the worktree's common git dir."""
    readable = default_readable()
    for p in extra or []:
        real = os.path.realpath(p)
        readable.append(os.path.dirname(real) if os.path.isfile(real) else real)
    common = git_common_dir(workdir)
    if common:
        readable.append(common)
    return sorted(set(readable))


class SandboxRun:
    def __init__(
        self,
        *,
        run_id: str,
        workdir: Path,
        state_dir: Path,
        ceiling: str = "none",
        repo: str | None = None,
        push_url: str | None = None,
        source: Path | None = None,
        default_branch: str = "main",
        branch_prefix: str | None = None,
        pass_env: list[str] | tuple[str, ...] = (),
        allow: list[str] | None = None,
        readable: list[str] | None = None,
        token_for_repo: Callable[[str], str | None] | None = None,
        api_base: str | None = None,
        allow_private: bool = False,
        hosts: dict[str, str] | None = None,
        base_env: dict[str, str] | None = None,
    ) -> None:
        self.run_id = run_id
        self.workdir = Path(workdir).resolve()
        self.state_dir = Path(state_dir).resolve()
        self.ceiling = ceiling
        self.repo = repo
        self.push_url = push_url
        self.source = Path(source).resolve() if source else self.workdir
        self.default_branch = default_branch
        self.branch_prefix = branch_prefix
        self.pass_env = list(pass_env)
        self.allow = allow if allow is not None else allowlist_from_env()
        self.readable = readable if readable is not None else default_readable()
        self.token_for_repo = token_for_repo
        self.api_base = api_base
        self.allow_private = allow_private
        self.hosts = hosts
        self.base_env = base_env
        self.proxy: EgressProxy | None = None
        self.broker: Broker | None = None
        self.policy_path = self.state_dir / "policy.json"
        self.policy: Policy | None = None
        self._servers: list[socketserver.BaseServer] = []
        self._sock_dir: str | None = None

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> SandboxRun:
        windows = sys.platform == "win32"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if windows:
            # Before anything is written: the policy (with the broker
            # capability), audit and egress logs are no sandbox's to read.
            protect_dir(self.state_dir)
        home = self.state_dir / "home"
        for p in home_layout(home).values():
            p.mkdir(parents=True, exist_ok=True)
        write_sbx_shims(home_layout(home)["bin"])
        if not windows:
            self._sock_dir = tempfile.mkdtemp(prefix="sbx-")  # short: unix socket paths are limited
        self.proxy = EgressProxy(
            Allowlist(self.allow, allow_private=self.allow_private, hosts=self.hosts),
            log_path=self.state_dir / "egress.jsonl",
            run_id=self.run_id,
        )
        relays: dict[str, str] = {}
        if windows:
            server, proxy_url = self.proxy.serve()
        else:
            sock = os.path.join(self._sock_dir or "", "proxy.sock")
            server, _ = self.proxy.serve(unix_path=sock)
            relays[f"127.0.0.1:{_PROXY_PORT}"] = sock
            proxy_url = f"http://127.0.0.1:{_PROXY_PORT}"
        self._servers.append(server)
        broker_url = capability = None
        if self.repo and self.push_url:
            run = BrokerRun(
                run_id=self.run_id,
                repo=self.repo,
                source=self.source,
                ceiling=self.ceiling,
                push_url=self.push_url,
                default_branch=self.default_branch,
                branch_prefix=self.branch_prefix,
            )
            self.broker = Broker(
                run,
                self.state_dir / "broker",
                token_for_repo=self.token_for_repo,
                api_base=self.api_base,
            )
            capability = run.capability
            if windows:
                server, broker_url = serve(self.broker)
            else:
                sock = os.path.join(self._sock_dir or "", "broker.sock")
                server, _ = serve(self.broker, unix_path=sock)
                relays[f"127.0.0.1:{_BROKER_PORT}"] = sock
                broker_url = f"http://127.0.0.1:{_BROKER_PORT}"
            self._servers.append(server)
        env = sandbox_env(
            self.base_env,
            home=home,
            run_id=self.run_id,
            proxy_url=proxy_url,
            broker_url=broker_url,
            capability=capability,
            pass_env=self.pass_env,
        )
        run_sid = None
        if windows:
            run_sid = new_run_sid()
            for d in (self.workdir, home):
                prepare_dir(d, run_sid)
            self._grant_readable()
        self.policy = Policy(
            run_id=self.run_id,
            workdir=str(self.workdir),
            home=str(home),
            readable=list(self.readable),
            env=env,
            relays=relays,
            run_sid=run_sid,
        )
        self.policy.dump(self.policy_path)
        return self

    def wrap(self, cmd: list[str], *, python: str | None = None) -> list[str]:
        if self.policy is None:
            raise RuntimeError("SandboxRun.start() first")
        return wrap_argv(self.policy_path, cmd, python=python)

    def close(self) -> None:
        for s in self._servers:
            try:
                s.shutdown()
                s.server_close()
            except OSError:
                pass
        self._servers.clear()
        if self._sock_dir:
            shutil.rmtree(self._sock_dir, ignore_errors=True)

    def __enter__(self) -> SandboxRun:
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # -- Windows read grants ------------------------------------------------

    def _grant_readable(self) -> None:
        """Grant the sandbox SID read on each readable path once (recorded in
        ``granted.json`` next to the run dirs; icacls walks whole trees)."""
        marker = self.state_dir.parent / "sandbox-granted.json"
        try:
            done = set(json.loads(marker.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            done = set()
        for p in self.readable:
            if p in done or not os.path.exists(p):
                continue
            grant_read(p)
            done.add(p)
        try:
            marker.write_text(json.dumps(sorted(done)), encoding="utf-8")
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m factory.sandbox.host")
    ap.add_argument(
        "--spec", required=True, help="JSON: run_id, workdir, state_dir, ceiling, repo, ..."
    )
    ap.add_argument("--out", required=True, help="written when ready: {policy, wrap, pid}")
    ap.add_argument("--ttl", type=float, default=24 * 3600)
    a = ap.parse_args(argv)
    spec: dict[str, Any] = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    keys = {
        "run_id",
        "workdir",
        "state_dir",
        "ceiling",
        "repo",
        "push_url",
        "source",
        "default_branch",
        "branch_prefix",
        "pass_env",
        "allow",
        "readable",
    }
    kw = {k: v for k, v in spec.items() if k in keys and v is not None}
    if spec.get("trusted_repo"):
        trusted = Path(spec["trusted_repo"])
        kw.setdefault("push_url", push_url_for(trusted))
        if "repo" not in kw and kw.get("push_url"):
            from factory.gh_auth import repo_from_remote_url

            kw["repo"] = repo_from_remote_url(kw["push_url"])
    if "readable" not in kw:
        kw["readable"] = readable_for(Path(kw["workdir"]), spec.get("extra_readable") or [])
    sb = SandboxRun(**kw).start()
    out = Path(a.out)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"policy": str(sb.policy_path), "wrap": sb.wrap([]), "pid": os.getpid()}),
        encoding="utf-8",
    )
    os.replace(tmp, out)
    try:
        time.sleep(a.ttl)
    except KeyboardInterrupt:
        pass
    sb.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
