"""factory serve's HTTP API (plan 2.1), job-state push (E3) and DB lease (2.2)."""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from factory.scheduler import api, serve


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _call(port: int, path: str, body: dict[str, Any] | None = None, guard: bool = True) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if guard:
        headers[api.GUARD_HEADER] = "1"
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers,
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


@pytest.mark.parametrize(
    ("argv", "ok"),
    [
        (["job", "status", "a:001", "--json"], True),
        (["job", "list", "--json"], True),
        (["app", "list", "--json"], True),
        (["job", "follow", "a:001"], False),  # streams forever: CLI only
        (["tick", "--app", "x"], False),
        (["serve"], False),
        ([], False),
        (["job"], False),
    ],
)
def test_only_jobs_api_verbs_are_allowed(argv: list[str], ok: bool) -> None:
    assert api.allowed(argv) is ok


def test_run_cli_returns_the_cli_contract() -> None:
    res = api.run_cli(["job", "status", "nope:999", "--json", "--no-github"])
    assert set(res) == {"code", "stdout", "stderr"}
    assert res["code"] != 0
    assert "error" in json.loads(res["stdout"])  # one JSON object, as the CLI prints


def test_run_cli_usage_error_is_a_reply_not_a_crash() -> None:
    res = api.run_cli(["job", "status", "--no-such-flag"])
    assert res["code"] != 0


def test_capture_is_per_thread_and_never_leaks(tmp_path: Path) -> None:
    import sys
    import threading

    from factory import capture

    results: dict[int, tuple[str, str]] = {}
    gate = threading.Barrier(8)

    def worker(i: int) -> None:
        with capture.capture() as (out, err):
            gate.wait()
            for _ in range(50):
                print(f"out-{i}")
                with capture.stdout_to_stderr():
                    print(f"noise-{i}")  # the CLI's diverted chatter
            results[i] = (out.getvalue(), err.getvalue())

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for i, (out, err) in results.items():
        assert set(out.split()) == {f"out-{i}"}
        assert set(err.split()) == {f"noise-{i}"}
    # Outside a capture, writes still reach the real stream (a router, not a sink).
    assert not capture.capturing()
    assert sys.stdout is not None


#: One harmless call per served verb (no side effects: refusals, unknown ids,
#: dry runs) and the JSON key its stdout must carry.
_EVERY_SERVED_VERB = [
    (["job", "submit", "--json"], "error"),  # refused: --title missing
    (["job", "status", "nope:001", "--json", "--no-github"], "error"),
    (["job", "list", "--json", "--no-github", "--app", "nope"], "jobs"),
    (["job", "cancel", "nope:001", "--json"], "error"),
    (["job", "resume", "nope:001", "--json", "--no-github"], "error"),
    (["job", "report", "nope:r0001", "--json"], "error"),
    (["job", "dispatch", "--dry-run", "--json"], "started"),
    (["app", "list", "--json"], "apps"),  # typer.echo: the live empty-stdout bug
    (["app", "set", "nope-app", "--json"], "error"),
]


@pytest.mark.parametrize(("argv", "key"), _EVERY_SERVED_VERB, ids=lambda v: " ".join(v) if isinstance(v, list) else v)
def test_every_served_verb_returns_its_json_on_stdout(argv: list[str], key: str) -> None:
    """Regression (6e96a0d): a served verb answered exit 0 with an EMPTY stdout."""
    from factory import capture

    capture.install()  # as under serve: the per-thread router is in place
    res = api.run_cli(argv)
    assert res["stdout"].strip(), f"{argv}: empty stdout (code {res['code']}, stderr {res['stderr'][:200]!r})"
    body = json.loads(res["stdout"])  # exactly one JSON object
    assert key in body


def test_submit_and_reads_run_concurrently_each_with_its_own_json() -> None:
    import threading

    from factory import capture

    capture.install()
    calls = [argv for argv, _ in _EVERY_SERVED_VERB] * 3
    outs: list[tuple[list[str], dict[str, Any]]] = []
    lock = threading.Lock()

    def go(argv: list[str]) -> None:
        res = api.run_cli(argv)
        with lock:
            outs.append((argv, res))

    threads = [threading.Thread(target=go, args=(a,)) for a in calls]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(outs) == len(calls)
    for argv, res in outs:
        body = json.loads(res["stdout"])  # never empty, never two objects glued together
        assert isinstance(body, dict), argv


def test_router_exposes_nothing_click_could_write_around() -> None:
    """click finds a console via fileno() (Windows) or isatty(), and a binary
    writer via .buffer; any of them lets typer.echo bypass the capture."""
    import io as _io
    import sys

    import click

    from factory import capture

    capture.install()
    assert sys.stdout.isatty() is False
    with pytest.raises(_io.UnsupportedOperation):
        sys.stdout.fileno()
    assert not hasattr(sys.stdout, "buffer")
    with capture.capture() as (out, _err):
        click.echo("through click")
    assert out.getvalue() == "through click\n"


def test_click_echo_is_captured_even_when_the_real_stdout_is_a_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live bug: under serve (a console) `app list --json` (typer.echo) returned an
    empty stdout: click cached a wrapper of the real tty stream on the router."""
    import io
    import sys

    from factory import capture

    class _TTY(io.TextIOWrapper):
        def isatty(self) -> bool:
            return True

    real = _TTY(io.BytesIO(), encoding="utf-8")
    monkeypatch.setattr(sys, "stdout", real)
    capture.install()
    try:
        import typer

        typer.echo("warm-up outside a capture")  # click resolves and caches here
        for i in range(2):
            with capture.capture() as (out, _err):
                typer.echo(f'{{"n": {i}}}')
            assert out.getvalue() == f'{{"n": {i}}}\n'
    finally:
        monkeypatch.setattr(sys, "stdout", real)


def test_read_only_calls_run_concurrently_and_stay_separate() -> None:
    import threading

    outs: dict[str, dict[str, Any]] = {}

    def call(jid: str) -> None:
        outs[jid] = api.run_cli(["job", "status", jid, "--json", "--no-github"])

    threads = [threading.Thread(target=call, args=(f"nope{i}:00{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for jid, res in outs.items():
        body = json.loads(res["stdout"])  # exactly one JSON object each
        assert jid.split(":")[0] in body["message"]


def test_api_guards_and_serves(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(api, "run_cli", lambda argv: {"code": 0, "stdout": '{"ok": 1}\n', "stderr": ""})
    port = _free_port()
    srv = api.start_api(port, health=lambda: {"ok": True}, after_call=lambda argv, res: calls.append(argv))
    try:
        assert _call(port, "/api/health", guard=False)[0] == 403
        assert _call(port, "/api/health") == (200, {"ok": True})
        status, body = _call(port, "/api/cli", {"argv": ["job", "list", "--json"]})
        assert status == 200 and body["code"] == 0 and body["stdout"] == '{"ok": 1}\n'
        assert calls == [["job", "list", "--json"]]
        assert _call(port, "/api/cli", {"argv": ["tick", "--app", "x"]})[0] == 400
        assert _call(port, "/api/cli", {"argv": ["job", "list"]}, guard=False)[0] == 403
    finally:
        srv.shutdown()


def test_api_binds_loopback_only() -> None:
    port = _free_port()
    srv = api.start_api(port, health=lambda: {})
    try:
        assert srv.server_address[0] == "127.0.0.1"
    finally:
        srv.shutdown()


# --------------------------------------------------------------------------- #
# push
# --------------------------------------------------------------------------- #


def test_pusher_sends_only_changes_after_a_baseline(tmp_path: Path) -> None:
    states = {"a:001": "queued", "a:r0001": "in_progress"}
    sent: list[dict[str, Any]] = []

    def list_fn(_root: Path, _skip: frozenset[str] = frozenset()) -> list[dict[str, Any]]:
        return [{"job_id": k, "state": v, "why": f"w-{v}"} for k, v in states.items()]

    p = api.JobStatePusher(tmp_path, "http://pa/x", list_fn=list_fn,
                           post=lambda url, body, t: sent.append(body) or 200)
    assert p.check() == [] and sent == []  # baseline, nothing announced
    states["a:001"] = "in_progress"
    changed = p.check()
    assert [c["job_id"] for c in changed] == ["a:001"]
    assert sent[0]["jobs"][0]["state"] == "in_progress" and sent[0]["jobs"][0]["why"] == "w-in_progress"
    assert p.check() == []  # no change, no post
    states["a:002"] = "queued"  # a new job is a change
    assert [c["job_id"] for c in p.check()] == ["a:002"]


def test_pusher_never_raises_when_the_pa_is_down(tmp_path: Path) -> None:
    state = {"s": "queued"}

    def down(url: str, body: dict[str, Any], t: float) -> int:
        raise urllib.error.URLError("refused")

    p = api.JobStatePusher(tmp_path, "http://127.0.0.1:9/x",
                           list_fn=lambda r, s: [{"job_id": "a:1", "state": state["s"]}], post=down)
    p.check()
    state["s"] = "done"
    assert len(p.check()) == 1 and p.pushed == 0


def test_pusher_off_without_url(tmp_path: Path) -> None:
    p = api.JobStatePusher(tmp_path, "", list_fn=lambda r, s: (_ for _ in ()).throw(AssertionError()))
    assert p.check() == []


def test_pusher_payload_is_what_the_pa_accepts(tmp_path: Path) -> None:
    """The PA's pushedPatches(): {jobs: [...]} with job_id + JOBS-API state; ≤ 50 per post."""
    rows = {f"a:{i:03d}": "queued" for i in range(120)}
    bodies: list[dict[str, Any]] = []
    p = api.JobStatePusher(tmp_path, "u", list_fn=lambda r, s: [{"job_id": k, "state": v} for k, v in rows.items()],
                           post=lambda url, body, t: bodies.append(body) or 200)
    p.check()
    for k in rows:
        rows[k] = "done"
    p.check()
    assert [len(b["jobs"]) for b in bodies] == [50, 50, 20]
    assert set(bodies[0]["jobs"][0]) == {"job_id", "state", "why", "updated_at"}


# --------------------------------------------------------------------------- #
# DB lease
# --------------------------------------------------------------------------- #


def test_db_lease_is_exclusive_until_expired_or_released(tmp_path: Path) -> None:
    now = {"t": 1000.0}
    db = tmp_path / "leases.db"
    a = serve.DbLease(db, ttl_s=30, clock=lambda: now["t"])
    b = serve.DbLease(db, ttl_s=30, clock=lambda: now["t"])
    b.host = "another-host"  # not ours to probe by pid
    assert a.acquire() is True
    assert b.acquire() is False
    now["t"] += 20
    assert a.renew() is True
    now["t"] += 20
    assert b.acquire() is False  # renewed: still valid
    now["t"] += 31
    assert b.acquire() is True  # expired: taken over
    assert a.renew() is False  # a learns it lost it
    b.release()
    assert a.acquire() is True


def test_db_lease_taken_over_from_a_dead_pid_on_this_host(tmp_path: Path) -> None:
    db = tmp_path / "leases.db"
    dead = serve.DbLease(db, ttl_s=300)
    dead.pid = 2**22 + 12345  # no such process
    assert dead.acquire() is True
    live = serve.DbLease(db, ttl_s=300)
    assert live.acquire() is True  # same host, holder pid dead: no waiting out the TTL
    cur = live.current()
    assert cur is not None and cur["holder"] == live.holder and cur["expired"] is False


def test_supervise_restarts_with_delays_per_exit_code(tmp_path: Path) -> None:
    codes = iter([serve.EXIT_UPDATED, serve.EXIT_LEASE_HELD, 1, 0])
    argvs: list[list[str]] = []
    sleeps: list[float] = []

    class _Child:
        def __init__(self, rc: int) -> None:
            self.rc = rc

        def wait(self) -> int:
            return self.rc

    def spawn(argv: list[str]) -> _Child:
        argvs.append(argv)
        return _Child(next(codes))

    rc = serve.supervise(tmp_path, ["serve", "--port", "0"], spawn=spawn,
                         sleep=sleeps.append, max_restarts=3, out=lambda s: None)
    assert rc == 0 and len(argvs) == 4
    assert sleeps == [0.0, 30.0, 5.0]  # updated: at once; lease held: slowly; else 5 s
    assert argvs[0][-4:-2] == ["--port", "0"] and argvs[0][-2] == "--parent-pid"
    assert argvs[0][1:5] == ["-X", "utf8", "-m", "factory"]


def test_serve_forever_periodic_can_end_the_loop(tmp_path: Path) -> None:
    sched = serve.Scheduler(
        serve.ServeConfig(root=tmp_path, apps=[], dispatch=False), out=lambda s: None
    )
    n = {"calls": 0}

    def moved() -> bool:
        n["calls"] += 1
        return n["calls"] >= 2

    why = serve.serve_forever(sched, stop=lambda: False, sleep=lambda s: None,
                              periodic=[(0.0, moved)])
    assert why == "periodic" and n["calls"] == 2
