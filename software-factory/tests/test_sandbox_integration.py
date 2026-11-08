"""A real sandboxed process (native plan 5.2/5.3), end to end on this OS.

It cannot read a file outside its directories, cannot see the host's GH_TOKEN,
cannot reach a host that is not on the allowlist, and can open a draft PR only
through the broker. GitHub is a local mock; the remote is a local bare repo;
the "internet" is a local server behind pinned names. No real PRs, no network.

Linux needs a working bubblewrap (CI installs it and allows unprivileged user
namespaces); Windows runs as is (restricted token, see factory.sandbox.exec).
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from factory.sandbox.exec import bwrap_argv
from factory.sandbox.host import SandboxRun
from factory.sandbox.policy import Policy, interpreter_prefixes, sandbox_env

WIN = sys.platform == "win32"
HOST_TOKEN = "ghp_host_token_must_not_leak_" + secrets.token_hex(4)
FAKE_GH_TOKEN = "ghp_broker_side_token"
GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]


def _bwrap_works() -> bool:
    if not shutil.which("bwrap"):
        return False
    r = subprocess.run(
        [
            "bwrap",
            "--unshare-all",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "true",
        ],
        capture_output=True,
        check=False,
    )
    return r.returncode == 0


needs_sandbox = pytest.mark.skipif(
    sys.platform == "darwin" or (not WIN and not _bwrap_works()),
    reason="needs Windows, or Linux with a working bubblewrap (unprivileged user namespaces)",
)


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(
        ["git", *GIT_ID, *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


class Upstream:
    """The 'internet': a local HTTP server answering every path with 200."""

    def __init__(self, host: str = "127.0.0.1") -> None:
        class H(BaseHTTPRequestHandler):
            def log_message(self, *_a: Any) -> None:
                return

            def do_GET(self) -> None:  # noqa: N802
                raw = b"upstream-ok"
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer((host, 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


class MockGitHub:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_a: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(
                    self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"
                )
                mock.requests.append(
                    {"path": self.path, "auth": self.headers.get("Authorization"), "json": body}
                )
                raw = json.dumps(
                    {"number": 42, "html_url": "https://github.example/pull/42"}
                ).encode()
                self.send_response(201)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory):
    root = tmp_path_factory.mktemp("sbx-it")
    remote = root / "remote.git"
    git("init", "--quiet", "--bare", "--initial-branch=main", str(remote))
    work = root / "work"
    git("init", "--quiet", "--initial-branch=main", str(work))
    (work / "inside.txt").write_text("inside-ok\n")
    git("add", "inside.txt", cwd=work)
    git("commit", "--quiet", "-m", "one", cwd=work)
    git("push", "--quiet", str(remote), "main", cwd=work)
    (work / "inside.txt").write_text("inside-ok\nchanged\n")
    git("commit", "--quiet", "-am", "two", cwd=work)
    # A secret where the operator's real secrets live: their home directory.
    outside = Path.home() / f".sbx-it-{secrets.token_hex(4)}"
    outside.mkdir()
    (outside / "secret.txt").write_text("outside-secret\n")
    up, gh = Upstream(), MockGitHub()
    env = dict(os.environ)
    env["GH_TOKEN"] = HOST_TOKEN
    env["GITHUB_TOKEN"] = HOST_TOKEN
    sb = SandboxRun(
        run_id="it-1",
        workdir=work,
        state_dir=root / "state",
        ceiling="draft_pr",
        repo="xvanov/dev-tools",
        push_url=str(remote),
        allow=[f"allowed.test:{up.port}"],
        hosts={"allowed.test": "127.0.0.1", "denied.test": "127.0.0.1"},
        allow_private=True,  # the pinned "internet" is on loopback
        readable=None if not WIN else [],  # Windows: system tools only, no grants
        token_for_repo=lambda _r: FAKE_GH_TOKEN,
        api_base=gh.url,
        base_env=env,
    ).start()
    yield {"sb": sb, "work": work, "remote": remote, "outside": outside, "up": up, "gh": gh}
    sb.close()
    up.close()
    gh.close()
    shutil.rmtree(outside, ignore_errors=True)


def run_in(
    sb: SandboxRun, cmd: list[str], timeout: float = 120
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        sb.wrap(cmd), capture_output=True, text=True, timeout=timeout, check=False
    )


def shell(script: str) -> list[str]:
    return ["cmd.exe", "/d", "/c", script] if WIN else ["sh", "-c", script]


@needs_sandbox
def test_reads_its_own_dir_but_not_outside(world):
    sb, work, outside = world["sb"], world["work"], world["outside"]
    cat = "type" if WIN else "cat"
    inside = run_in(sb, shell(f'{cat} "{work / "inside.txt"}"'))
    assert inside.returncode == 0 and "inside-ok" in inside.stdout, inside.stderr
    out = run_in(sb, shell(f'{cat} "{outside / "secret.txt"}"'))
    assert out.returncode != 0
    assert "outside-secret" not in out.stdout


@needs_sandbox
def test_cannot_read_the_run_state_with_the_broker_capability(world):
    """policy.json holds the capability; another run's sandbox must not get it."""
    sb = world["sb"]
    cat = "type" if WIN else "cat"
    r = run_in(sb, shell(f'{cat} "{sb.policy_path}"'))
    assert r.returncode != 0 and "capability" not in r.stdout.lower()


@needs_sandbox
def test_writes_only_inside(world):
    sb, work, outside = world["sb"], world["work"], world["outside"]
    ok = run_in(sb, shell(f'echo x> "{work / "w.txt"}"'))
    assert ok.returncode == 0 and (work / "w.txt").exists(), ok.stderr
    bad = run_in(sb, shell(f'echo x> "{outside / "w.txt"}"'))
    assert bad.returncode != 0 and not (outside / "w.txt").exists()


@needs_sandbox
def test_host_github_token_is_not_visible(world):
    r = run_in(world["sb"], shell("set" if WIN else "env"))
    assert r.returncode == 0, r.stderr
    assert HOST_TOKEN not in r.stdout
    names = {line.split("=", 1)[0].upper() for line in r.stdout.splitlines() if "=" in line}
    assert not names & {"GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"}
    # and git has no credential helper (the system config's manager is not read)
    h = run_in(world["sb"], ["git", "config", "--get", "credential.helper"])
    assert h.returncode == 1 and not h.stdout.strip()


@needs_sandbox
def test_egress_goes_through_the_allowlist(world):
    sb, port = world["sb"], world["up"].port
    curl = "curl.exe" if WIN else "curl"
    fmt = "%{http_code}"
    ok = run_in(
        sb,
        shell(
            f"{curl} -s -o {'NUL' if WIN else '/dev/null'} -w {fmt} http://allowed.test:{port}/x"
        ),
    )
    assert ok.stdout.strip() == "200", (ok.stdout, ok.stderr)
    no = run_in(
        sb,
        shell(f"{curl} -s -o {'NUL' if WIN else '/dev/null'} -w {fmt} http://denied.test:{port}/x"),
    )
    assert no.stdout.strip() == "403", (no.stdout, no.stderr)
    log = [json.loads(x) for x in (sb.state_dir / "egress.jsonl").read_text().splitlines()]
    assert {(e["host"], e["allowed"]) for e in log} >= {
        ("allowed.test", True),
        ("denied.test", False),
    }


def _host_ip() -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # no packet is sent
        ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None
    finally:
        s.close()


@needs_sandbox
@pytest.mark.skipif(
    WIN,
    reason="Windows egress is proxy-routed, not enforced: a raw socket "
    "is not stopped without a firewall rule or a separate account (admin step)",
)
def test_direct_connection_bypassing_the_proxy_fails(world):
    ip = _host_ip()
    if ip is None:
        pytest.skip("no non-loopback address on this host")
    up = Upstream("0.0.0.0")
    try:
        plain = subprocess.run(
            ["curl", "-s", "--noproxy", "*", "-m", "5", f"http://{ip}:{up.port}/"],
            capture_output=True,
            text=True,
            check=False,
        )
        assert plain.stdout == "upstream-ok"  # reachable from the host...
        r = run_in(
            world["sb"], ["curl", "-s", "--noproxy", "*", "-m", "5", f"http://{ip}:{up.port}/"]
        )
        assert r.returncode != 0 and "upstream-ok" not in r.stdout  # ...not from the sandbox
    finally:
        up.close()


@needs_sandbox
def test_draft_pr_only_through_the_broker(world):
    sb, gh, remote = world["sb"], world["gh"], world["remote"]
    if WIN:
        # curl.exe against the broker (python is not granted in this test).
        (world["work"] / "push.json").write_text('{"branch": "feat/sbx"}')
        (world["work"] / "pr.json").write_text('{"head": "feat/sbx", "title": "From the sandbox"}')
        auth = '-H "Authorization: Bearer %SANDBOX_BROKER_CAPABILITY%"'
        push = run_in(
            sb,
            shell(f"curl.exe -s -f {auth} --data-binary @push.json %SANDBOX_BROKER_URL%/v1/push"),
        )
        pr = run_in(
            sb, shell(f"curl.exe -s -f {auth} --data-binary @pr.json %SANDBOX_BROKER_URL%/v1/pr")
        )
    else:
        push = run_in(sb, ["sbx", "push", "feat/sbx"])
        pr = run_in(sb, ["sbx", "pr", "--head", "feat/sbx", "--title", "From the sandbox"])
    assert push.returncode == 0, (push.stdout, push.stderr)
    assert pr.returncode == 0, (pr.stdout, pr.stderr)
    assert json.loads(pr.stdout)["number"] == 42
    (req,) = gh.requests
    assert req["json"]["draft"] is True and req["json"]["head"] == "feat/sbx"
    assert req["auth"] == f"Bearer {FAKE_GH_TOKEN}"
    sha = subprocess.run(
        ["git", "-C", str(remote), "rev-parse", "refs/heads/feat/sbx"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert sha == git("rev-parse", "HEAD", cwd=world["work"]).strip()
    # The broker refuses anything past the ceiling, even with the capability.
    if not WIN:
        main = run_in(sb, ["sbx", "push", "main"])
        assert main.returncode != 0 and "protected" in main.stdout


def test_bwrap_argv_hides_home_and_binds_only_the_run(tmp_path):
    pol = Policy(
        run_id="r",
        workdir=str(tmp_path / "w"),
        home=str(tmp_path / "h"),
        readable=[str(tmp_path)],
        env={"A": "1"},
        relays={"127.0.0.1:3128": "/tmp/sbx-x/proxy.sock"},
    )
    argv = bwrap_argv(pol, ["claude", "-p"], python="/usr/bin/python3", bwrap="bwrap")
    joined = " ".join(argv)
    assert "--unshare-all" in argv and "--die-with-parent" in argv and "--clearenv" in argv
    for hidden in ("/home", "/root", "/run", "/tmp"):
        assert f"--tmpfs {hidden}" in joined
    assert f"--bind {pol.workdir} {pol.workdir}" in joined
    assert "--bind /tmp/sbx-x /tmp/sbx-x" in joined
    assert argv.index("--tmpfs") < argv.index("--bind")  # binds land on top of the tmpfs
    assert argv[-3:] == ["--", "claude", "-p"]
    assert "--relay" in argv and "127.0.0.1:3128=/tmp/sbx-x/proxy.sock" in argv


def test_bwrap_argv_never_rebinds_root_or_a_hidden_parent(tmp_path):
    pol = Policy(run_id="r", workdir=str(tmp_path), home=str(tmp_path), readable=["/", "/home", "/var", "/run"])
    argv = bwrap_argv(pol, ["true"], python="/usr/bin/python3", bwrap="bwrap")
    ro = [argv[i + 1] for i, a in enumerate(argv) if a == "--ro-bind"]
    assert ro == ["/"]  # only the first, read-only root, under the tmpfs mounts


@pytest.mark.skipif(WIN, reason="symlinks")
def test_interpreter_prefixes_follow_the_unresolved_link_chain(tmp_path):
    real = tmp_path / "uv" / "cpython-3.12.12-x" / "bin"
    real.mkdir(parents=True)
    (real / "python3.12").write_text("")
    link_dir = tmp_path / "uv" / "cpython-3.12-x"
    link_dir.symlink_to(real.parent)
    venv = tmp_path / "venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").symlink_to(link_dir / "bin" / "python3.12")
    got = interpreter_prefixes(str(venv / "python"))
    assert str(tmp_path / "venv") in got and str(link_dir) in got


def test_sandbox_env_is_an_allowlist(tmp_path):
    base = {
        "PATH": "/usr/bin",
        "GH_TOKEN": "x",
        "AWS_SECRET_ACCESS_KEY": "y",
        "DATABASE_URL": "z",
        "SSH_AUTH_SOCK": "/s",
        "CLAUDE_CODE_OAUTH_TOKEN": "c",
        "LANG": "C.UTF-8",
    }
    env = sandbox_env(
        base,
        home=tmp_path,
        run_id="r",
        proxy_url="http://127.0.0.1:3128",
        broker_url="http://127.0.0.1:3129",
        capability="cap",
        pass_env=["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"],
    )
    assert (
        "GH_TOKEN" not in env and "AWS_SECRET_ACCESS_KEY" not in env and "DATABASE_URL" not in env
    )
    assert "SSH_AUTH_SOCK" not in env
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "c"  # passed on purpose; GH_TOKEN never is
    assert (
        env["HTTPS_PROXY"] == "http://127.0.0.1:3128" and env["SANDBOX_BROKER_CAPABILITY"] == "cap"
    )
    assert env["HOME"] == str(tmp_path) and env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert env["PATH"].startswith(str(tmp_path / "bin"))
