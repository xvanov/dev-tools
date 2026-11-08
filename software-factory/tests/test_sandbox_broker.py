"""The credential broker (native plan 5.3): pushes and draft PRs for a
sandboxed run, checked against its ceiling. GitHub is a local mock server;
the "remote" is a local bare repo. No network, no real PRs."""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from factory.sandbox import ceiling_for_delivery, ceiling_for_mode, client
from factory.sandbox.broker import Broker, BrokerRun, serve, valid_branch

FAKE_TOKEN = "ghp_fake_broker_test_token"
GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(
        ["git", *GIT_ID, *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


class MockGitHub:
    """Records requests; answers POST /repos/<o>/<r>/pulls with a PR."""

    def __init__(self, status: int = 201) -> None:
        self.requests: list[dict[str, Any]] = []
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_a: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                mock.requests.append(
                    {"path": self.path, "auth": self.headers.get("Authorization"), "json": body}
                )
                raw = json.dumps(
                    {"number": 7, "html_url": "https://github.example/o/r/pull/7", "draft": body.get("draft")}
                    if status == 201
                    else {"message": "Validation Failed"}
                ).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Built once (git is slow to start on Windows); each test gets a copy."""
    root = tmp_path_factory.mktemp("broker-template")
    remote = root / "remote.git"
    git("init", "--quiet", "--bare", "--initial-branch=main", str(remote))
    src = root / "work"
    git("init", "--quiet", "--initial-branch=main", str(src))
    (src / "a.txt").write_text("one\n")
    git("add", "a.txt", cwd=src)
    git("commit", "--quiet", "-m", "one", cwd=src)
    git("push", "--quiet", str(remote), "main", cwd=src)
    (src / "a.txt").write_text("two\n")
    git("commit", "--quiet", "-am", "two", cwd=src)
    return root


@pytest.fixture
def repos(template: Path, tmp_path: Path) -> dict[str, Path]:
    shutil.copytree(template / "remote.git", tmp_path / "remote.git")
    shutil.copytree(template / "work", tmp_path / "work")
    return {"remote": tmp_path / "remote.git", "src": tmp_path / "work", "state": tmp_path / "broker-state"}


@pytest.fixture
def github():
    m = MockGitHub()
    yield m
    m.close()


def make(repos: dict[str, Path], github: MockGitHub, ceiling: str, **kw: Any) -> Broker:
    run = BrokerRun(
        run_id="run-1",
        repo="xvanov/dev-tools",
        source=repos["src"],
        ceiling=ceiling,
        push_url=str(repos["remote"]),
        **kw,
    )
    return Broker(run, repos["state"], token_for_repo=lambda _r: FAKE_TOKEN, api_base=github.url)


def bearer(b: Broker) -> str:
    return f"Bearer {b.run.capability}"


def remote_sha(repos: dict[str, Path], branch: str) -> str | None:
    r = subprocess.run(
        ["git", "-C", str(repos["remote"]), "rev-parse", "--verify", "-q", f"refs/heads/{branch}"],
        capture_output=True, text=True, check=False,
    )
    return r.stdout.strip() or None


def test_wrong_or_missing_capability_is_refused(repos, github):
    b = make(repos, github, "draft_pr")
    assert b.handle("GET", "/v1/info", None, None)[0] == 401
    assert b.handle("GET", "/v1/info", "Bearer nope", None)[0] == 401
    assert b.handle("GET", "/v1/info", bearer(b), None)[0] == 200


def test_ceiling_none_refuses_push_and_pr(repos, github):
    b = make(repos, github, "none")
    status, data = b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})
    assert status == 403 and "ceiling" in data["error"]
    status, _ = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x"})
    assert status == 403
    assert remote_sha(repos, "feat/x") is None
    assert github.requests == []


def test_unknown_ceiling_fails_safe_to_none(repos, github):
    b = make(repos, github, "push_to_main")
    assert b.run.ceiling == "none"
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})[0] == 403


def test_push_branch_pushes_the_checkout_head(repos, github):
    b = make(repos, github, "push_branch")
    status, data = b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})
    assert status == 200, data
    assert data["sha"] == git("rev-parse", "HEAD", cwd=repos["src"])
    assert remote_sha(repos, "feat/x") == data["sha"]
    # ...but a PR is beyond push_branch.
    status, data = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x"})
    assert status == 403 and github.requests == []


@pytest.mark.parametrize("branch", ["main", "master", "trunk"])
def test_protected_branches_are_never_pushed(repos, github, branch):
    b = make(repos, github, "draft_pr", default_branch="trunk")
    before = remote_sha(repos, "main")
    status, _ = b.handle("POST", "/v1/push", bearer(b), {"branch": branch})
    assert status == 403
    assert remote_sha(repos, "main") == before


@pytest.mark.parametrize("branch", ["-f", "a..b", "x@{1}", "x.lock", "x/", "", "+main", "a b", None])
def test_bad_branch_names_are_rejected(repos, github, branch):
    b = make(repos, github, "push_branch")
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": branch})[0] == 400
    assert not valid_branch(branch or "")


def test_branch_prefix_is_enforced(repos, github):
    b = make(repos, github, "push_branch", branch_prefix="pa/run-1")
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})[0] == 403
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": "pa/run-1"})[0] == 200


def test_ref_must_be_head_or_a_sha(repos, github):
    b = make(repos, github, "push_branch")
    status, _ = b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x", "ref": "--upload-pack=evil"})
    assert status == 400


def test_no_force_push(repos, github):
    b = make(repos, github, "push_branch")
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})[0] == 200
    git("reset", "--quiet", "--hard", "HEAD~1", cwd=repos["src"])
    (repos["src"] / "a.txt").write_text("diverged\n")
    git("commit", "--quiet", "-am", "diverged", cwd=repos["src"])
    status, data = b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})
    assert status == 409, data


def test_draft_pr_only_from_a_branch_the_broker_pushed(repos, github):
    b = make(repos, github, "draft_pr")
    status, data = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x"})
    assert status == 409 and "push" in data["error"]
    assert github.requests == []


def test_draft_pr_is_always_a_draft_on_the_run_repo(repos, github):
    b = make(repos, github, "draft_pr")
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})[0] == 200
    status, data = b.handle(
        "POST", "/v1/pr", bearer(b), {"title": "Fix it", "body": "why", "head": "feat/x"}
    )
    assert status == 200, data
    assert data == {"number": 7, "url": "https://github.example/o/r/pull/7", "draft": True}
    (req,) = github.requests
    assert req["path"] == "/repos/xvanov/dev-tools/pulls"
    assert req["auth"] == f"Bearer {FAKE_TOKEN}"
    assert req["json"] == {"title": "Fix it", "body": "why", "head": "feat/x", "base": "main", "draft": True}
    # One PR per run; the agent cannot ask for a non-draft or another repo.
    assert b.handle("POST", "/v1/pr", bearer(b), {"title": "again", "head": "feat/x"})[0] == 403
    status, _ = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x", "draft": False})
    assert status == 400
    status, _ = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x", "repo": "evil/x"})
    assert status == 400


def test_github_refusal_is_reported_without_the_token(repos):
    gh = MockGitHub(status=422)
    try:
        b = make(repos, gh, "draft_pr")
        b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})
        status, data = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x"})
        assert status == 502 and "Validation Failed" in data["error"]
        assert FAKE_TOKEN not in json.dumps(data)
    finally:
        gh.close()


def test_missing_credential_is_a_clear_refusal(repos, github):
    b = make(repos, github, "draft_pr")
    b._token_for_repo = lambda _r: None
    b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})
    status, data = b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "head": "feat/x"})
    assert status == 502 and "credential" in data["error"]


def test_nothing_runs_in_the_untrusted_checkout(repos, github, tmp_path):
    """A hook or sshCommand planted in the agent's checkout never runs: the
    broker fetches from it into its own mirror and pushes from there."""
    marker = tmp_path / "pwned"
    hooks = repos["src"] / ".git" / "hooks"
    for name in ("pre-push", "post-checkout", "reference-transaction", "pre-receive"):
        hook = hooks / name
        hook.write_text(f"#!/bin/sh\necho x > '{marker.as_posix()}'\n")
        hook.chmod(0o755)
    git("config", "core.sshCommand", f"sh -c 'echo x > {marker.as_posix()}'", cwd=repos["src"])
    git("config", "core.hooksPath", str(hooks), cwd=repos["src"])
    b = make(repos, github, "push_branch")
    assert b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})[0] == 200
    assert not marker.exists()


def test_audit_log_records_every_request_and_no_secret(repos, github):
    b = make(repos, github, "draft_pr")
    b.handle("POST", "/v1/push", bearer(b), {"branch": "main"})
    b.handle("POST", "/v1/push", bearer(b), {"branch": "feat/x"})
    b.handle("POST", "/v1/pr", bearer(b), {"title": "t", "body": "secret-ish body", "head": "feat/x"})
    text = (repos["state"] / "audit.jsonl").read_text()
    lines = [json.loads(x) for x in text.splitlines()]
    assert [x["status"] for x in lines] == [403, 200, 200]
    assert FAKE_TOKEN not in text and b.run.capability not in text and "secret-ish" not in text


def test_over_http_with_the_sbx_client(repos, github, monkeypatch, capsys):
    b = make(repos, github, "draft_pr")
    server, url = serve(b)
    try:
        monkeypatch.setenv("SANDBOX_BROKER_URL", url)
        monkeypatch.setenv("SANDBOX_BROKER_CAPABILITY", b.run.capability)
        assert client.main(["push", "feat/x"]) == 0
        assert client.main(["pr", "--head", "feat/x", "--title", "via client"]) == 0
        assert '"number": 7' in capsys.readouterr().out
        assert github.requests[-1]["json"]["draft"] is True
        monkeypatch.setenv("SANDBOX_BROKER_CAPABILITY", "wrong")
        assert client.main(["info"]) == 1
    finally:
        server.shutdown()


def test_client_without_a_broker_says_so(monkeypatch):
    monkeypatch.delenv("SANDBOX_BROKER_URL", raising=False)
    status, data = client.call("GET", "/v1/info")
    assert status == 2 and "no broker" in data["error"]


@pytest.mark.parametrize(
    ("level", "ceiling"),
    [("none", "none"), ("branch", "push_branch"), ("draft_pr", "draft_pr"), ("pr", "draft_pr"),
     ("auto_merge", "draft_pr"), ("push_to_main", "none"), ("garbage", "none"), (None, "none")],
)
def test_ceiling_for_delivery(level, ceiling):
    assert ceiling_for_delivery(level) == ceiling


def test_ceiling_for_mode():
    assert [ceiling_for_mode(m) for m in ("plan", "local", "branch", "mr", "full", None)] == [
        "none", "none", "push_branch", "draft_pr", "draft_pr", "none",
    ]
