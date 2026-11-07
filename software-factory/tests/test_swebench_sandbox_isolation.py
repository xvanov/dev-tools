"""PHYSICAL isolation for one benchmark run, and proof that it is physical.

Three contamination channels were closed before this file existed — the
venv-on-PATH leak, the oracle trees moved out of the scratch root, and the shared
``/tmp``. All three were closed by arranging the filesystem more carefully, and none
of them stops an agent's bash tool from simply naming a path: another arm's working
tree, ``bench/swebench/oracle.json.z``, ``manifest.json``, the harness source, or
``ps -eo args``, which on this host prints another run's entire problem statement.

``SWEBENCH_SANDBOX=1`` puts the ADW child in a bubblewrap mount+pid namespace whose
root starts EMPTY, so those paths do not fail with EACCES — they do not exist.

EVERY TEST HERE IS AN EXPLOIT FIRST AND A REGRESSION SECOND, and each denial test
carries its own CONTROL: the same command is run on the host, where it must SUCCEED
and print the sentinel. A test that only proves the flag reaches ``Popen`` proves
nothing, and a denial test that would also pass against a sandbox that isolated
nothing (because the file was missing, or the path was wrong) is worse than no test.

Nothing here spawns ``pi``, calls a model, or writes ``benchmarks.db``. The docker
tests use ``alpine:latest`` from the local image cache, so they pull nothing.
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from tests._bench_host import requires_bench_host

_ADAPTER = Path(__file__).parent.parent / "bench" / "swebench_adapter.py"

# The sentinels. Distinct strings, because "the read failed" and "the read succeeded
# and returned the wrong thing" have to be distinguishable in an assertion message.
_SIBLING_SENTINEL = "SENTINEL-A-SIBLING-ARMS-SOLUTION"
_ORACLE_SENTINEL = "SENTINEL-AN-ORACLE-TREE-HOLDING-THE-ANSWER"
_HOST_TMP_SENTINEL = "SENTINEL-ANOTHER-RUNS-SCRATCH-IN-SLASH-TMP"
_OWN_SENTINEL = "SENTINEL-THIS-RUNS-OWN-REPO"


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_sandbox_under_test", _ADAPTER)
    assert spec and spec.loader, f"cannot load the adapter at {_ADAPTER}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_sandbox_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


class _Tree:
    """The filesystem a single run sees, plus the things it must NOT see."""

    def __init__(self, root: Path) -> None:
        self.work_root = root / "swebench-work"
        self.mine = self.work_root / "acme__widget-1__armA"
        self.repo = self.mine / "repo"
        self.sibling = self.work_root / "acme__widget-1__armB"
        self.oracle_root = root / "swebench-oracle-trees"
        self.ledger = root / "swebench-sssf-ledger"
        for d in (self.repo, self.mine / "tmp", self.sibling / "repo", self.oracle_root,
                  self.ledger):
            d.mkdir(parents=True, exist_ok=True)
        (self.repo / "own.txt").write_text(f"{_OWN_SENTINEL}\n", encoding="utf-8")
        # The shape the audit predicate was written for: a SIBLING ARM of the SAME
        # instance, one ``..`` away under the flat ``<instance>__<arm>`` layout.
        (self.sibling / "repo" / "SOLUTION.py").write_text(
            f"# {_SIBLING_SENTINEL}\n", encoding="utf-8"
        )
        # An oracle tree of the kind that was found stranded, 134 MB, with the hidden
        # test bodies applied in plaintext.
        (self.oracle_root / "grade-acme__widget-1-xxxxxxxx.py").write_text(
            f"# {_ORACLE_SENTINEL}\n", encoding="utf-8"
        )


@pytest.fixture
def tree(A: Any, tmp_path: Path) -> _Tree:  # noqa: N803
    """The run's filesystem — and the gate on the mechanism.

    Requesting this fixture is what marks a test as "executes a real namespace", so
    the skip lives here rather than in an autouse hook: the pure-policy tests below
    take ``policy`` instead and must still run on a machine without bwrap.
    """
    ok, problem = A._sandbox_probe()
    if not ok:
        pytest.skip(f"bwrap cannot build a namespace here: {problem}")
    return _Tree(tmp_path)


def _sandboxed(A: Any, tree: _Tree, script: str, **kw: Any) -> subprocess.CompletedProcess[str]:  # noqa: N803
    """Run ``script`` under /bin/sh INSIDE the sandbox, as ``run_sssf`` would."""
    argv = A._sandbox_argv(
        ["/bin/sh", "-c", script],
        tree=tree.mine,
        cwd=tree.repo,
        ledger_dir=tree.ledger,
        docker_mode=kw.pop("docker_mode", "none"),
        broker_sock=kw.pop("broker_sock", None),
    )
    return subprocess.run(  # noqa: S603
        argv, capture_output=True, text=True, cwd=str(tree.repo), timeout=180, **kw
    )


def _on_host(script: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """THE CONTROL. The same shell script with no namespace at all."""
    return subprocess.run(  # noqa: S602
        ["/bin/sh", "-c", script], capture_output=True, text=True, cwd=str(cwd), timeout=180
    )


# --------------------------------------------------------------------------- #
# what this machine supports, reported rather than assumed
# --------------------------------------------------------------------------- #


def test_the_mechanism_is_probed_by_running_it_not_by_looking_for_the_binary(A: Any) -> None:  # noqa: N803
    """``_sandbox_probe`` must EXECUTE bwrap, because presence on PATH proves nothing.

    bwrap on this host is ``-rwxr-xr-x`` — NOT setuid — so it can only build a
    namespace if unprivileged user namespaces are permitted, which is a policy
    question spread across ``kernel.unprivileged_userns_clone`` (absent on this 6.12
    kernel), ``user.max_user_namespaces`` and an AppArmor toggle. A check that
    stopped at ``Path.exists()`` would report "isolation available" on a machine
    where every run then died in bwrap.
    """
    source = _ADAPTER.read_text(encoding="utf-8")
    probe = source.split("def _sandbox_probe(")[1].split("\ndef ")[0]
    assert "subprocess.run(" in probe, (
        "_sandbox_probe must actually invoke bwrap; a presence check on a "
        "non-setuid binary says nothing about whether userns is permitted"
    )
    ok, problem = A._sandbox_probe()
    assert isinstance(ok, bool) and (ok or problem), (
        "the probe must report a reason whenever it reports failure, or the "
        "refused-run message in run_sssf has nothing to say"
    )


def test_isolation_is_off_unless_asked_for(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """OFF BY DEFAULT, because a campaign is normally in flight.

    The whole point of the opt-in is that an unset variable reproduces the previous
    behaviour exactly, so this change cannot disturb runs that are already going.
    """
    monkeypatch.delenv(A._SANDBOX_ENV, raising=False)
    assert A._sandbox_requested() is False, "no variable must mean no sandbox"
    for off in ("", "0", "false", "no", "off", "maybe"):
        monkeypatch.setenv(A._SANDBOX_ENV, off)
        assert A._sandbox_requested() is False, f"{off!r} must not switch isolation on"
    for on in ("1", "true", "yes", "on", "TRUE"):
        monkeypatch.setenv(A._SANDBOX_ENV, on)
        assert A._sandbox_requested() is True, f"{on!r} must switch isolation on"
    # And the launch path defaults to the UNWRAPPED argv, so the false branch is the
    # one the campaign in flight is taking.
    source = _ADAPTER.read_text(encoding="utf-8")
    body = source.split("def run_sssf(")[1]
    assert "launch = argv" in body, (
        "run_sssf must start from the unwrapped argv so a run with the sandbox off "
        "spawns exactly what it spawned before"
    )
    assert 'if sandbox_plan["active"]:' in body, (
        "the bwrap wrap must sit behind the recorded plan, not behind an ad-hoc "
        "environment read at the spawn site"
    )


def test_asking_for_isolation_that_is_unavailable_refuses_the_run(A: Any) -> None:  # noqa: N803
    """FAIL CLOSED. An operator who asked for isolation must not silently get none.

    The failure this guards against is a provenance lie, not a crash: a sweep that
    groups its rows by "sandbox requested" would otherwise contain rows that ran
    completely unconfined under that heading.
    """
    body = _ADAPTER.read_text(encoding="utf-8").split("def run_sssf(")[1]
    fatal_block = body.split("fatal = [p for p in (credential_problem,) if p]")[1]
    fatal_block = fatal_block.split("if fatal and not probe_plumbing")[0]
    assert "sandbox_on and not sandbox_ok" in fatal_block, (
        "an unavailable sandbox must join the pre-flight ``fatal`` list, which is "
        "the list that refuses the run before the clone and before any spend"
    )


# --------------------------------------------------------------------------- #
# DENIAL — each with its control
# --------------------------------------------------------------------------- #


def test_a_sibling_arms_working_tree_does_not_exist_inside_the_sandbox(A: Any, tree: _Tree) -> None:  # noqa: N803
    """The channel that is still open today: ``cat ../<other-arm>/repo/…``.

    Flat ``<instance>__<arm>`` naming already stopped the nested-layout ``..`` walk;
    it does not stop an absolute path, and an absolute path is what an agent writes.
    """
    script = f"cat {tree.sibling / 'repo' / 'SOLUTION.py'}"
    control = _on_host(script, tree.repo)
    assert _SIBLING_SENTINEL in control.stdout, (
        "CONTROL FAILED: the sibling solution must be readable on the host, or this "
        f"test would pass against a sandbox that isolates nothing. Got {control!r}"
    )
    inside = _sandboxed(A, tree, script)
    assert _SIBLING_SENTINEL not in inside.stdout + inside.stderr, (
        "the sandbox handed over another arm's solution: " + inside.stdout[:400]
    )
    assert inside.returncode != 0, "reading a sibling arm's tree must FAIL, not read empty"
    assert "No such file" in inside.stderr, (
        "the sibling must be ABSENT rather than permission-denied — a path that does "
        f"not exist has nothing to escalate against. Got: {inside.stderr[:300]}"
    )


def test_the_answer_key_does_not_exist_inside_the_sandbox(A: Any, tree: _Tree) -> None:  # noqa: N803
    """``manifest.json``, ``oracle.json.z``, ``benchmarks.db`` and this harness.

    ``_ORACLE_FIELDS`` — fail_to_pass, pass_to_pass, patch, test_patch — is exactly
    what the hidden suite grades on, and it is one ``cat`` away today.
    """
    targets = [
        A.MANIFEST_PATH,
        A.SWE_DIR / "oracle.json.z",
        A.SWE_DIR / "benchmarks.db",
        _ADAPTER,
    ]
    present = [t for t in targets if t.exists()]
    assert len(present) >= 3, (
        f"CONTROL FAILED: expected the answer key and the harness to exist on this "
        f"host; found only {present}"
    )
    for target in present:
        inside = _sandboxed(A, tree, f"cat {target} | head -c 200")
        assert inside.returncode != 0 or not inside.stdout.strip(), (
            f"{target} was READABLE inside the sandbox: {inside.stdout[:200]!r}"
        )
        listed = _sandboxed(A, tree, f"ls -la {target.parent}")
        assert listed.returncode != 0, (
            f"{target.parent} could still be listed inside the sandbox, so an agent "
            f"can enumerate its way to the answer: {listed.stdout[:300]}"
        )


def test_an_oracle_tree_does_not_exist_inside_the_sandbox(A: Any, tree: _Tree) -> None:  # noqa: N803
    """The stranded grading tree, in the shape it was actually found in.

    ``_prepared_tree_dir``'s comment records one at
    ``<work_root>/_prepared/grade-getmoto__moto-9841-claude-5-zstru7yi``, 134 MB, with
    the hidden test bodies applied. It now lives in a SIBLING of the scratch root —
    which the sandbox never mounts, so the unguessable suffix stops being the only
    thing between an agent and the answer.
    """
    planted = tree.oracle_root / "grade-acme__widget-1-xxxxxxxx.py"
    control = _on_host(f"cat {planted}", tree.repo)
    assert _ORACLE_SENTINEL in control.stdout, f"CONTROL FAILED: {control!r}"
    inside = _sandboxed(A, tree, f"cat {planted}; ls {tree.oracle_root}")
    assert _ORACLE_SENTINEL not in inside.stdout, "an oracle tree leaked into the sandbox"
    assert "No such file" in inside.stderr or "cannot access" in inside.stderr, (
        f"the oracle tree root must not exist in the namespace: {inside.stderr[:300]}"
    )
    # And the REAL one, on this machine, by the same rule.
    real = A._oracle_tree_root()
    real_probe = _sandboxed(A, tree, f"ls {real}")
    assert real_probe.returncode != 0, (
        f"the live oracle tree root {real} is visible inside the sandbox"
    )


@requires_bench_host
def test_writes_outside_the_runs_own_tree_never_land(A: Any, tree: _Tree) -> None:  # noqa: N803
    """Asserted on the HOST after the sandbox exits, not from the error message.

    An error message is what the sandbox chose to say; the absence of the file is
    what happened. Writes are checked as well as reads because the open channel is
    symmetric — the uid can write another arm's tree, and the engine's own source.
    """
    victims = {
        "sibling repo": tree.sibling / "repo" / "PWNED",
        "sibling root": tree.sibling / "PWNED",
        "oracle root": tree.oracle_root / "PWNED",
        "engine": A._SSSF_ROOT / "adws" / "PWNED-BY-SANDBOX-TEST",
        "bench dir": A.SWE_DIR / "PWNED-BY-SANDBOX-TEST",
        "home": Path.home() / "PWNED-BY-SANDBOX-TEST",
    }
    script = "; ".join(f"touch {p} 2>&1" for p in victims.values())
    script += f"; touch {tree.repo / 'legit.txt'} && echo OWN-WRITE-OK"
    inside = _sandboxed(A, tree, script)
    assert "OWN-WRITE-OK" in inside.stdout, (
        "the run must still be able to write its OWN repo, or the sandbox has broken "
        f"the thing being measured: {inside.stdout[:300]} / {inside.stderr[:300]}"
    )
    assert (tree.repo / "legit.txt").exists(), (
        "the run's own write must be visible to the HARNESS afterwards — the work "
        "tree is bound, not copied, and the diff capture reads it from outside"
    )
    landed = {name: p for name, p in victims.items() if p.exists()}
    assert not landed, f"writes escaped the sandbox and landed on the host: {landed}"


@requires_bench_host
def test_the_engine_is_readable_but_cannot_be_tampered_with(A: Any, tree: _Tree) -> None:  # noqa: N803
    """A stated limitation, pinned so it cannot quietly get worse.

    ``/home/k/sssf/adws`` HAS to be mounted: the engine executes out of it in the
    same namespace as the agent it supervises, so an agent that wants to read the ADW
    still can. What the read-only bind buys is that the engine measuring the arm can
    no longer be EDITED by the arm mid-run, which it could before.
    """
    adw = A._SSSF_ADW
    inside = _sandboxed(A, tree, f"head -c 40 {adw}; echo; touch {adw}.pwn 2>&1")
    assert "uv run" in inside.stdout, (
        f"the engine must stay readable or the child cannot start: {inside.stdout[:200]}"
    )
    assert "Read-only file system" in inside.stdout + inside.stderr, (
        "the engine mount must be read-only, so an arm cannot edit the harness that "
        f"is grading it: {inside.stdout[:300]} / {inside.stderr[:300]}"
    )
    assert not Path(f"{adw}.pwn").exists(), "a write to the engine tree LANDED"


@requires_bench_host
def test_slash_tmp_is_private_and_must_exist(A: Any, tree: _Tree) -> None:  # noqa: N803
    """Both halves matter, and they pull in opposite directions.

    IT MUST EXIST because every role prompt tells the agent to put scratch output in
    ``/tmp``, and bwrap's root starts empty — an unmounted ``/tmp`` turns sanctioned
    advice into ENOENT. IT MUST BE PRIVATE because the proven cross-instance read
    (``chain`` on one instance reading ``/tmp/old.txt`` 1.3 s before its own first
    write, the previous writer being another instance 15 minutes earlier) used a
    LITERAL ``/tmp`` path, which honours no ``TMPDIR``.
    """
    host_marker = Path("/tmp") / "swebench-sandbox-isolation-probe.txt"
    host_marker.write_text(f"{_HOST_TMP_SENTINEL}\n", encoding="utf-8")
    try:
        inside = _sandboxed(
            A,
            tree,
            f"echo private > /tmp/from-inside.txt && cat /tmp/from-inside.txt; "
            f"cat {host_marker} 2>&1",
        )
        assert "private" in inside.stdout, (
            f"/tmp must be writable inside the sandbox: {inside.stdout} {inside.stderr}"
        )
        assert _HOST_TMP_SENTINEL not in inside.stdout, (
            "another run's /tmp scratch was readable inside the sandbox"
        )
        assert not Path("/tmp/from-inside.txt").exists(), (
            "a write to /tmp inside the sandbox landed on the HOST /tmp, so /tmp is "
            "still the cross-run bus it was"
        )
    finally:
        host_marker.unlink(missing_ok=True)


def test_other_runs_are_invisible_in_the_process_table(A: Any, tree: _Tree) -> None:  # noqa: N803
    """``ps`` is a contamination channel no path-naming audit can see.

    MEASURED on this host: ``ps -eo args`` printed the FULL problem statement and the
    work-dir path of a live run to any process on the machine. An agent does not have
    to guess a sibling path when the process table hands it over.
    """
    marker = "SWEBENCH-SANDBOX-PS-PROBE"
    # The marker has to be IN THE ARGV, not in a shell comment — ``exec sleep 30 #
    # marker`` replaces the shell and the comment vanishes, which is how the first
    # version of this test managed to fail its own control. ``-ww`` because ``ps``
    # otherwise truncates args to the terminal width, and the leaked problem
    # statements are long.
    victim = subprocess.Popen(  # noqa: S603
        [sys.executable, "-c", f"import time  # {marker}\ntime.sleep(30)"],
        start_new_session=True,
    )
    try:
        control = _on_host("ps -eww -o args", tree.repo)
        assert marker in control.stdout, f"CONTROL FAILED: {control.stdout[-500:]}"
        inside = _sandboxed(A, tree, "ps -eww -o args")
        assert marker not in inside.stdout, (
            "another process's argv was visible inside the sandbox, so the process "
            "table is still a cross-arm channel"
        )
        assert inside.stdout.count("\n") < 8, (
            "the pid namespace should show only this run's own handful of processes; "
            f"saw {inside.stdout.count(chr(10))} lines"
        )
    finally:
        victim.kill()
        victim.wait(timeout=10)


# --------------------------------------------------------------------------- #
# AND IT CAN STILL DO THE JOB — the other half of the proof
# --------------------------------------------------------------------------- #


@requires_bench_host
def test_the_toolchain_the_run_needs_is_still_reachable(A: Any, tree: _Tree) -> None:  # noqa: N803
    """uv, its python toolchain, pi, models.json, the prompt library, the ledger.

    Enumerated at the head of the sandbox section for a reason: a sandbox missing one
    of these does not fail loudly, it produces a mystery arm that scores 0.
    """
    script = "\n".join(
        [
            "command -v uv && uv --version",
            "command -v pi",
            f"test -r {Path.home() / '.pi' / 'agent' / 'models.json'} && echo MODELS-OK",
            f"test -d {A._SSSF_PROMPT_ROOT} && echo PROMPTS-OK",
            f"touch {tree.ledger}/probe && echo LEDGER-WRITABLE",
            'test -n "$TMPDIR" || echo TMPDIR-UNSET',
            "python3 -c 'import ssl; print(\"SSL-OK\")'",
            "git --version >/dev/null && echo GIT-OK",
        ]
    )
    inside = _sandboxed(A, tree, script)
    out = inside.stdout
    for needed in ("uv ", "/pi", "MODELS-OK", "PROMPTS-OK", "LEDGER-WRITABLE",
                   "SSL-OK", "GIT-OK"):
        assert needed in out, (
            f"{needed!r} missing inside the sandbox — the run cannot work without it. "
            f"stdout={out[:600]!r} stderr={inside.stderr[:400]!r}"
        )


@requires_bench_host
def test_the_real_engine_starts_inside_the_sandbox_for_zero_dollars(A: Any, tree: _Tree) -> None:  # noqa: N803
    """``uv run <the real ADW> --help`` — the strongest check that spends nothing.

    This is the single most likely production breakage: ``uv run`` has to build the
    engine's PEP-723 environment from inside the namespace, which needs ~/.cache/uv
    READ-WRITE, ~/.local/share/uv for the interpreter, and the engine tree readable.
    ``--help`` exits in argparse, so no model is called and no ``pi`` is spawned.
    """
    env, _problem = A._sssf_child_env()
    env = A._sandbox_env_overlay(env, tree=tree.mine, shim_dir=None, brokered=False)
    for var in ("TMPDIR", "TEMP", "TMP"):
        env[var] = str(tree.mine / "tmp")
    argv = A._sandbox_argv(
        ["uv", "run", str(A._SSSF_ADW), "--help"],
        tree=tree.mine,
        cwd=tree.repo,
        ledger_dir=tree.ledger,
        docker_mode="none",
    )
    proc = subprocess.run(  # noqa: S603
        argv, capture_output=True, text=True, env=env, cwd=str(tree.repo), timeout=600
    )
    assert proc.returncode == 0, (
        "the real engine could not even start inside the sandbox: "
        f"rc={proc.returncode} stderr={proc.stderr[-1500:]}"
    )
    assert "adw_simple_sdlc.py" in proc.stdout, (
        f"expected the ADW's own usage text, got {proc.stdout[:300]!r}"
    )


def _model_host() -> str | None:
    """The model endpoint's hostname, without printing the credential beside it."""
    endpoint = os.environ.get("AZURE_ENDPOINT", "").strip()
    if not endpoint:
        env_file = Path("/home/k/sssf/.env")
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("AZURE_ENDPOINT"):
                    endpoint = line.split("=", 1)[1].strip().strip("\"'")
                    break
    if not endpoint:
        return None
    return re.sub(r"^https?://", "", endpoint).split("/")[0] or None


@requires_bench_host
def test_the_model_endpoint_is_still_reachable_from_inside(A: Any, tree: _Tree) -> None:  # noqa: N803
    """NO ``--unshare-net``, and the reason is that the run cannot work without it.

    Also the regression for a MEASURED near-miss: with ``--ro-bind /etc /etc`` alone,
    ``/etc/resolv.conf`` is a symlink into ``/run``, ``/run`` is a blank tmpfs, and
    every lookup inside the sandbox failed with ``gaierror [Errno -3]`` while uv, pi
    and the engine all resolved perfectly. That sweep would have read as "the
    deployment is down" for every arm.
    """
    host = _model_host()
    if host is None:
        pytest.skip("no AZURE_ENDPOINT to test reachability against")
    try:
        ctx = ssl.create_default_context()
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        with socket.create_connection((host, 443), timeout=15) as raw:
            with ctx.wrap_socket(raw, server_hostname=host):
                pass
    except OSError as exc:  # pragma: no cover — offline machine
        pytest.skip(f"CONTROL: the host itself cannot reach {host}: {exc}")
    probe = (
        "python3 -c \"import socket,ssl;"
        "c=ssl.create_default_context();"
        f"s=socket.create_connection(('{host}',443),timeout=20);"
        f"t=c.wrap_socket(s,server_hostname='{host}');"
        "print('TLS-OK',t.version())\""
    )
    inside = _sandboxed(A, tree, probe)
    assert "TLS-OK" in inside.stdout, (
        "the sandboxed child cannot reach the model endpoint, so no run can work: "
        f"stdout={inside.stdout[:300]!r} stderr={inside.stderr[-800:]!r}"
    )


@requires_bench_host
def test_the_spend_guard_still_reaches_through_the_namespace(A: Any, tree: _Tree) -> None:  # noqa: N803
    """THE MOST DANGEROUS THING A SANDBOX COULD BREAK, so it is checked directly.

    ``run_sssf``'s docstring is explicit that this function IS the spend guard: the
    sssf engine enforces no cost limit, so the per-run dollar cap is a poll plus
    ``_kill_tree`` on the child's process group. If bwrap swallowed that kill, a
    cost-cap hit would leave a ``pi`` process calling the model with nobody watching
    — the exact failure ``abort_all``'s docstring records having been debugged by pid.

    The children here IGNORE SIGTERM on purpose. A ``sleep`` that dies politely
    proves nothing about a node process under load.

    MEASURED, and the result is the opposite of the worry. Without the sandbox this
    same script leaves 2 of 3 processes alive after ``_kill_tree``, because the
    direct child exits on the SIGTERM, ``proc.wait()`` returns, and the escalation to
    SIGKILL never happens — a pre-existing hole in the guard. WITH the sandbox the
    count is 0: the outer bwrap dies, ``--die-with-parent`` takes the inner bwrap
    (pid 1 of the namespace) with it, and the kernel SIGKILLs everything left in that
    pid namespace. Isolation makes the kill STRONGER, not weaker.
    """
    marker = "SWEBENCH-SANDBOX-KILL-PROBE"
    ignore_term = (
        "python3 -c 'import signal,time;"
        "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
        f"time.sleep(600)  # {marker}'"
    )
    argv = A._sandbox_argv(
        ["/bin/sh", "-c", f"{ignore_term} & {ignore_term} & {ignore_term}"],
        tree=tree.mine,
        cwd=tree.repo,
        ledger_dir=tree.ledger,
        docker_mode="none",
    )

    def survivors() -> list[str]:
        out = subprocess.run(  # noqa: S603
            ["ps", "-eww", "-o", "pid,args"], capture_output=True, text=True, timeout=60
        ).stdout
        return [ln for ln in out.splitlines() if marker in ln and "ps -eww" not in ln]

    proc = subprocess.Popen(  # noqa: S603
        argv, cwd=str(tree.repo), start_new_session=True, text=True
    )
    try:
        deadline = time.monotonic() + 30
        while not survivors() and time.monotonic() < deadline:
            time.sleep(0.2)
        assert survivors(), (
            "CONTROL FAILED: the probe children never started, so the kill below "
            "would prove nothing"
        )
        A._kill_tree(proc)
        time.sleep(2)
        left = survivors()
        assert not left, (
            "a cost-cap kill did NOT reach inside the sandbox; these would keep "
            f"spending: {left}"
        )
        assert proc.poll() is not None, "bwrap itself survived _kill_tree"
    finally:
        for line in survivors():
            with contextlib.suppress(OSError, ValueError):
                os.kill(int(line.split()[0]), signal.SIGKILL)
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            proc.kill()
            proc.wait(timeout=10)


# --------------------------------------------------------------------------- #
# DOCKER — the one channel that would have made all of the above theatre
# --------------------------------------------------------------------------- #
#
# uid 1000 is in the ``docker`` group, so ``docker run -v /:/host alpine cat
# /host/…/oracle.json.z`` is root-equivalent and defeats every mount above in one
# line. The run cannot do without docker either: the test command handed to every arm
# IS a ``docker run`` (``instance_test_command``), because the clone has no
# dependencies installed. So the socket is not bound and an argv broker stands in.

_DOCKER_IMAGE = "alpine:latest"


def _docker_usable() -> str | None:
    try:
        proc = subprocess.run(  # noqa: S603
            ["docker", "image", "inspect", _DOCKER_IMAGE],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"docker is not usable here: {exc}"
    if proc.returncode != 0:
        return f"{_DOCKER_IMAGE} is not in the local image cache (this test pulls nothing)"
    return None


@pytest.fixture
def brokered(A: Any, tree: _Tree) -> Any:  # noqa: N803
    """A live broker plus the environment the sandbox needs to reach it."""
    reason = _docker_usable()
    if reason:
        pytest.skip(reason)
    broker = A._SandboxDockerBroker(
        tree=tree.mine, images=frozenset({_DOCKER_IMAGE}), timeout_s=120
    )
    broker.start()
    shim_dir = A._sandbox_write_shims(tree.mine)
    env = A._sandbox_env_overlay(
        os.environ.copy(), tree=tree.mine, shim_dir=shim_dir, brokered=True
    )
    try:
        yield broker, env
    finally:
        broker.stop()


@requires_bench_host
def test_the_graded_test_commands_own_shape_still_runs(A: Any, tree: _Tree, brokered: Any) -> None:  # noqa: N803
    """The exact flag set ``instance_test_command`` emits, end to end, through the broker.

    ``--rm -v "$PWD":<wd> -w <wd> --user "$(id -u):$(id -g)" -e HOME=/tmp -e
    PYTHONDONTWRITEBYTECODE=1 --entrypoint …``. If this shape is refused, the arm has
    no verification channel at all and the sandbox has destroyed the measurement
    instead of protecting it.
    """
    broker, env = brokered
    script = (
        'docker run --rm -v "$PWD":/testbed -w /testbed --user "$(id -u):$(id -g)" '
        "-e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 --entrypoint sh "
        f"{_DOCKER_IMAGE} -c 'cat /testbed/own.txt'"
    )
    inside = _sandboxed(
        A, tree, script, docker_mode="broker", broker_sock=broker.sock_path, env=env
    )
    assert _OWN_SENTINEL in inside.stdout, (
        "the graded test command's own shape was refused or produced nothing: "
        f"rc={inside.returncode} stdout={inside.stdout[:400]!r} "
        f"stderr={inside.stderr[:600]!r}"
    )
    assert inside.returncode == 0, f"rc={inside.returncode} stderr={inside.stderr[:400]}"
    assert broker.allowed == 1 and broker.refused == 0, (
        f"expected exactly one allowed request, got allowed={broker.allowed} "
        f"refused={broker.refused}"
    )
    assert "ALLOWED" in broker.log_path.read_text(encoding="utf-8"), (
        "every brokered request must be recorded — the log is this row's only "
        "provenance for what it ran in a container"
    )


@requires_bench_host
def test_the_broker_relays_the_exit_code_and_both_streams_faithfully(A: Any, tree: _Tree, brokered: Any) -> None:  # noqa: N803
    """A failing test run must still LOOK like a failing test run to the agent.

    The whole feedback loop the arm is being measured on is "run the command, read
    the output, react to the exit code". A broker that flattened a red pytest to
    rc 0, or lost stderr, would not be isolation — it would be a harness quietly
    changing the signal the arm is scored on.
    """
    broker, env = brokered
    script = (
        f"docker run --rm --entrypoint sh {_DOCKER_IMAGE} "
        "-c 'echo to-stdout; echo to-stderr >&2; exit 3'; echo \"seen-rc=$?\""
    )
    inside = _sandboxed(
        A, tree, script, docker_mode="broker", broker_sock=broker.sock_path, env=env
    )
    assert "to-stdout" in inside.stdout, f"stdout was lost: {inside.stdout!r}"
    assert "to-stderr" in inside.stderr, f"stderr was lost or merged: {inside.stderr!r}"
    assert "seen-rc=3" in inside.stdout, (
        "the container's exit code must reach the agent's shell unchanged, or a red "
        f"test suite reads as green: {inside.stdout!r}"
    )


@requires_bench_host
def test_docker_cannot_be_turned_into_an_escape(A: Any, tree: _Tree, brokered: Any) -> None:  # noqa: N803
    """The escape that motivates the broker, tried six ways, denied six ways.

    Each one is asserted on CONTENT as well as on the return code: a refusal that
    still printed the oracle would satisfy an rc-only assertion.
    """
    broker, env = brokered
    attempts = {
        "bind the whole root": f"docker run --rm -v /:/host {_DOCKER_IMAGE} "
                               f"sh -c 'cat /host{A.SWE_DIR}/oracle.json.z'",
        "bind the bench dir": f"docker run --rm -v {A.SWE_DIR}:/b {_DOCKER_IMAGE} "
                              "sh -c 'ls /b'",
        "bind a sibling arm": f"docker run --rm -v {tree.sibling}:/s {_DOCKER_IMAGE} "
                              "sh -c 'cat /s/repo/SOLUTION.py'",
        "bind the docker socket": "docker run --rm -v /var/run/docker.sock:/d "
                                  f"{_DOCKER_IMAGE} sh -c 'ls -l /d'",
        "a named volume": f"docker run --rm -v shared:/s {_DOCKER_IMAGE} sh -c 'ls /s'",
        "privileged": f"docker run --rm --privileged {_DOCKER_IMAGE} sh -c 'ls /'",
        "another image": "docker run --rm busybox:latest sh -c 'ls /'",
        "an undeclared flag before the image": "docker run --rm --cgroupns host "
                                               f"{_DOCKER_IMAGE} sh -c 'ls /'",
        "raw client, no shim": "/usr/bin/docker ps",
        "any other subcommand": "docker ps -a",
    }
    for name, script in attempts.items():
        inside = _sandboxed(
            A, tree, script, docker_mode="broker", broker_sock=broker.sock_path, env=env
        )
        blob = inside.stdout + inside.stderr
        assert inside.returncode != 0, f"{name!r} SUCCEEDED inside the sandbox: {blob[:400]}"
        for leaked in (_SIBLING_SENTINEL, _ORACLE_SENTINEL):
            assert leaked not in blob, f"{name!r} exfiltrated {leaked}: {blob[:400]}"
        assert "manifest.json" not in blob, f"{name!r} listed the bench dir: {blob[:400]}"
    assert broker.allowed == 0, (
        f"none of these should have been allowed; broker allowed {broker.allowed}"
    )
    assert broker.refused >= len(attempts) - 1, (
        "every attempt except the raw-client one goes through the broker and must be "
        f"logged as refused; refused={broker.refused} of {len(attempts)}"
    )


def test_the_raw_docker_socket_is_not_in_the_namespace(A: Any, tree: _Tree) -> None:  # noqa: N803
    """THE ENFORCEMENT IS THE MISSING SOCKET, not the PATH order.

    Stated separately because it is the property that makes the shim safe to be a
    convenience rather than a fence: an agent that ignores ``sandbox-bin/docker`` and
    calls the real client finds nothing to connect to.
    """
    assert Path("/var/run/docker.sock").exists(), (
        "CONTROL FAILED: there is no docker socket on this host to withhold"
    )
    inside = _sandboxed(A, tree, "ls -l /var/run/docker.sock /run/docker.sock 2>&1")
    assert "No such file" in inside.stdout + inside.stderr, (
        f"the docker socket is reachable inside the sandbox: {inside.stdout[:300]}"
    )
    argv = A._sandbox_argv(
        ["/bin/true"],
        tree=tree.mine,
        cwd=tree.repo,
        ledger_dir=tree.ledger,
        docker_mode="broker",
    )
    assert "/var/run/docker.sock" not in argv, (
        "the default docker mode must never bind the real socket; only the explicit "
        f"{A._SANDBOX_DOCKER_ENV}=raw escape hatch may"
    )


# --------------------------------------------------------------------------- #
# the broker's policy, as pure logic, at $0
# --------------------------------------------------------------------------- #


@pytest.fixture
def policy(A: Any, tmp_path: Path) -> Any:  # noqa: N803
    """``(verdict, tree)`` for a run whose own tree is ``tmp_path/work``."""
    work = tmp_path / "work"
    (work / "repo").mkdir(parents=True)

    def verdict(argv: list[str], images: set[str] | None = None) -> tuple[Any, Any]:
        return A._sandbox_docker_verdict(
            argv, tree=work, images=frozenset(images or {"img:1"})
        )

    return verdict, work


def test_the_graded_argv_is_allowed_and_its_bind_is_resolved(policy: Any) -> None:
    """Allowed, and the bind source is REWRITTEN to the resolved path.

    The rewrite is not cosmetic: handing dockerd the path the agent typed leaves a
    check-then-use gap, and handing it the already-resolved path closes the easy half
    of it.
    """
    verdict, work = policy
    argv = [
        "run", "--rm", "-v", f"{work / 'repo'}:/testbed", "-w", "/testbed",
        "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
        "-e", "PYTHONDONTWRITEBYTECODE=1", "--entrypoint", "bash",
        "img:1", "-lc", "python -m pytest -p no:cacheprovider tests/",
    ]
    out, refusal = verdict(argv)
    assert refusal is None, f"the graded shape must be allowed, got: {refusal}"
    assert out is not None and out[0] == "docker", out
    assert f"{os.path.realpath(work / 'repo')}:/testbed" in out, (
        f"the bind must be rewritten to its resolved source: {out}"
    )
    assert out[-1] == "python -m pytest -p no:cacheprovider tests/", (
        "everything after the image is the container's own command and must pass "
        f"through untouched: {out}"
    )


@pytest.mark.parametrize(
    ("argv", "because"),
    [
        (["run", "-v", "/:/host", "img:1", "sh"], "the whole root"),
        (["run", "-v", "/home:/h", "img:1", "sh"], "somebody else's home"),
        (["run", "--volume=/etc:/e", "img:1", "sh"], "the inline = spelling"),
        (["run", "-v", "shared:/s", "img:1", "sh"], "a named volume, i.e. a cross-run bus"),
        (["run", "-v", "relative:/s", "img:1", "sh"], "a relative source"),
        (["run", "-v", "/a:/b:z", "img:1", "sh"], "an unvetted bind option"),
        (["run", "-v", "/a", "img:1", "sh"], "an unparseable bind"),
        (["run", "--privileged", "img:1", "sh"], "--privileged"),
        (["run", "--cap-add", "SYS_ADMIN", "img:1", "sh"], "--cap-add"),
        (["run", "--device", "/dev/sda:/dev/sda", "img:1", "sh"], "--device"),
        (["run", "--security-opt", "seccomp=unconfined", "img:1", "sh"], "--security-opt"),
        (["run", "--pid", "host", "img:1", "sh"], "--pid host"),
        (["run", "--userns", "host", "img:1", "sh"], "--userns"),
        (["run", "--volumes-from", "other", "img:1", "sh"], "--volumes-from"),
        (["run", "--mount", "type=bind,src=/,dst=/host", "img:1", "sh"], "--mount"),
        (["run", "--env-file", "/home/k/sssf/.env", "img:1", "sh"], "--env-file"),
        (["run", "--network", "host", "img:1", "sh"], "--network host"),
        (["run", "--user", "0:0", "img:1", "sh"], "--user root"),
        (["run", "--user", "root", "img:1", "sh"], "--user by name"),
        (["run", "-d", "img:1", "sh"], "detach, which outlives the run"),
        (["run", "other:2", "sh"], "another image"),
        (["run", "--rm"], "no image at all"),
        (["ps"], "a subcommand that is not brokered"),
        (["exec", "-it", "c", "sh"], "exec into a container"),
        (["pull", "other:2"], "pulling an image that is not this instance's"),
        (["image", "ls"], "image ls"),
        (["run", "-itP", "img:1", "sh"], "an unknown letter hidden in a short cluster"),
        (["run", "--name", "shared", "img:1", "sh"],
         "a container name, which is a global namespace one arm can deny to another"),
        (["run", "--rm=yes", "img:1", "sh"], "a value on a boolean flag"),
        (["run", "-v", "img:1"], "a flag whose value was eaten by the image"),
        ([], "nothing at all"),
    ],
)
def test_the_broker_refuses(policy: Any, argv: list[str], because: str) -> None:
    """DENY BY DEFAULT, and the flag table is what makes the parse total.

    The subtle one is ``-itP``/``--cgroupns``: a parser that skipped tokens it did not
    recognise could walk past a flag's value and mistake it for the image, or mistake
    the image for a value. An undeclared token can never reach that decision here,
    because the parse refuses first.
    """
    verdict, _work = policy
    out, refusal = verdict(argv)
    assert out is None and refusal, f"{because} must be refused; got {out}"


def test_a_symlink_cannot_smuggle_a_bind_source_out_of_the_tree(policy: Any) -> None:
    """The obvious bypass: put the escape INSIDE the tree and point it out.

    ``realpath`` is why the check is on the resolved path rather than on the prefix of
    the string the agent typed.
    """
    verdict, work = policy
    (work / "escape").symlink_to("/")
    out, refusal = verdict(["run", "-v", f"{work / 'escape'}:/host", "img:1", "sh"])
    assert out is None and refusal and "outside this run's own tree" in refusal, (
        f"a symlink out of the tree must be refused; got {out} / {refusal}"
    )


def test_short_boolean_clusters_and_inline_values_are_handled(policy: Any) -> None:
    """``-it`` has to work, because agents write it, and expansion must not lose it."""
    verdict, work = policy
    out, refusal = verdict(
        ["run", "-it", "--rm", f"--volume={work / 'repo'}:/t", "-w=/t", "img:1", "sh"]
    )
    assert refusal is None, refusal
    assert out is not None and "-i" in out and "-t" in out, (
        f"a short cluster must expand rather than be dropped: {out}"
    )
    assert "-w" in out and "/t" in out, f"the inline = spelling must survive: {out}"


# --------------------------------------------------------------------------- #
# the two arrangements that make the whole thing possible at all
# --------------------------------------------------------------------------- #


def test_the_broker_socket_cannot_outgrow_the_af_unix_limit(A: Any) -> None:  # noqa: N803
    """MEASURED: 108 bytes, and a work-dir path already reaches 99.

    ``<work_root>/line__line-bot-sdk-python-981_interface__flash-chain/
    docker-broker.sock`` is 99 bytes on an instance that is already pinned in the
    manifest — nine bytes of headroom before ``bind()`` raises ``AF_UNIX path too
    long`` and every brokered ``docker run`` in that row fails. The first end-to-end
    attempt at this design raised exactly that, which is why the socket does not live
    in the work dir.
    """
    naive = A._work_root() / "line__line-bot-sdk-python-981_interface__flash-chain" / "docker-broker.sock"
    assert len(str(naive)) > 90, (
        "this regression only means something while the naive path is near the "
        f"limit; it is now {len(str(naive))} bytes ({naive})"
    )
    assert len(A._SANDBOX_BROKER_SOCK_IN_SANDBOX) < 100, (
        "the in-sandbox socket path must stay far below the 108-byte AF_UNIX cap"
    )
    source = _ADAPTER.read_text(encoding="utf-8")
    start = source.split("class _SandboxDockerBroker:")[1]
    assert "tempfile.mkdtemp(prefix=\"swebench-broker-" in start, (
        "the host-side socket must live in a short mkdtemp, not under the work dir, "
        "or a long instance id silently breaks every brokered docker run"
    )


def test_the_ledger_moves_out_of_the_directory_that_holds_the_answer(A: Any) -> None:  # noqa: N803
    """``_SSSF_SHARED_DB`` lives beside ``oracle.json.z``, and the child must write it.

    Mounting ``bench/swebench/runs`` so the engine could write its ledger would hand
    back the directory the sandbox exists to withhold, and binding the single db file
    instead puts sqlite's WAL on a private tmpfs — two concurrent runs each with a
    private WAL over one shared db is corruption, not isolation.
    """
    ledger = A._sandbox_ledger_dir()
    assert not str(ledger).startswith(str(A.SWE_DIR)), (
        f"the sandboxed ledger {ledger} is inside {A.SWE_DIR}, which also holds "
        "manifest.json and oracle.json.z"
    )
    assert not str(ledger).startswith(str(A._work_root()) + os.sep), (
        f"the ledger must be a SIBLING of the scratch root, not a child of it: "
        f"{ledger} is under {A._work_root()} and every arm walks past that parent"
    )
    body = _ADAPTER.read_text(encoding="utf-8").split("def run_sssf(")[1]
    assert "_sandbox_ledger_dir() / _SSSF_SHARED_DB.name" in body, (
        "the same db_path must feed both the roster the child reads and "
        "_sssf_live_cost, or the spend guard polls a file nobody writes"
    )


def test_the_mount_order_puts_the_tmpfs_before_the_windows_through_it(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """ORDER IS SEMANTICS. Measured: with the tmpfs last, ``uv`` disappeared.

    bwrap applies each operation in argv order onto a root that starts empty, so
    ``--tmpfs $HOME`` after the read-only binds under ``$HOME`` throws them away —
    and the failure is ``uv: not found`` deep in a child, not an error from bwrap.
    """
    work = tmp_path / "w"
    (work / "repo").mkdir(parents=True)
    argv = A._sandbox_argv(
        ["/bin/true"], tree=work, cwd=work / "repo", ledger_dir=tmp_path / "l",
        docker_mode="none",
    )
    home = str(Path.home())
    tmpfs_home = argv.index(home)
    uv_bin = argv.index(str(Path.home() / ".local" / "bin"))
    assert tmpfs_home < uv_bin, (
        f"--tmpfs {home} must come before the binds beneath it, or they are silently "
        f"discarded: {argv}"
    )
    assert argv.index("/run") < argv.index("/run/systemd/resolve"), (
        "the blank /run must be mounted before the resolver directory is bound into "
        "it, or DNS fails inside the sandbox with gaierror -3"
    )
    assert "--unshare-net" not in argv, (
        "the network must stay: pi cannot reach the model endpoint without it and uv "
        "cannot resolve PEP-723 dependencies on a cold cache"
    )
    for required in ("--unshare-user", "--unshare-pid", "--die-with-parent"):
        assert required in argv, f"{required} is what makes this a namespace at all"
