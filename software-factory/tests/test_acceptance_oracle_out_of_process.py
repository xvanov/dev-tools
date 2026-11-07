"""019 AC3 — the out-of-process runner's OWN mechanics: isolation, boot
lifecycle, teardown, and the gate's wiring to all of it. Crediting/vacuity is
covered in ``test_acceptance_oracle_gutted_control.py``; the forgery closure
is covered in ``test_acceptance_oracle_green_means_something.py``.
"""

from __future__ import annotations

import os
import socket
import sys
import time
from pathlib import Path

import pytest

from factory.app_config import AcceptanceBootConfig, AppConfig, AppGatesConfig
from factory.chain import boot as boot_mod
from factory.chain import oracle_run
from factory.chain.gates import acceptance_verified
from factory.chain.gates.evaluator import PRContext
from factory.chain.state_machine import StoryRecord, StoryState
from tests.oracle_boot_fixture import (
    BAD_IMPL,
    GOOD_IMPL,
    HTTP_ORACLE,
    IMPORT_FORM_ORACLE,
    boot_cfg,
    write_bootable_app,
)
from tests.oracle_repo import commit_all, git, init_repo, two_commit_repo

# --------------------------------------------------------------------------- #
# oracle_run isolation
# --------------------------------------------------------------------------- #


def test_run_oracle_env_never_carries_pythonpath(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Even if the CALLING process has a ``PYTHONPATH``, the oracle subprocess
    must never inherit it — belt-and-braces alongside the static allowlist."""
    poison = tmp_path / "poison"
    poison.mkdir()
    (poison / "sitecustomize.py").write_text(
        "raise RuntimeError('PYTHONPATH leaked into the oracle run')\n", encoding="utf-8"
    )
    monkeypatch.setenv("PYTHONPATH", str(poison))
    from factory.chain import stub_server

    with stub_server.stub_app() as stub:
        run = oracle_run.run_oracle(
            "def test_ac1():\n    assert True\n",
            base_url=stub.base_url, run_id="iso-1", dest_name="test_oracle_iso.py", timeout_s=15,
        )
    assert run.status == "pass", run.output


def test_run_oracle_confcutdir_ignores_a_hostile_parent_conftest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A ``conftest.py`` sitting ABOVE the oracle's own throwaway temp dir must
    never be collected — ``--confcutdir``/``--rootdir`` pin the boundary."""
    parent = tmp_path / "tmp_parent"
    parent.mkdir()
    (parent / "conftest.py").write_text(
        "def pytest_configure(config):\n"
        "    raise RuntimeError('a conftest ABOVE the oracle temp dir was loaded')\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("tempfile.tempdir", str(parent))
    from factory.chain import stub_server

    with stub_server.stub_app() as stub:
        run = oracle_run.run_oracle(
            "def test_ac1():\n    assert True\n",
            base_url=stub.base_url, run_id="iso-2", dest_name="test_oracle_iso2.py", timeout_s=15,
        )
    assert run.status == "pass", run.output
    assert "a conftest ABOVE" not in run.output


# --------------------------------------------------------------------------- #
# gate wiring: config faults, cannot-run states
# --------------------------------------------------------------------------- #


def _story(*, story_id: int = 7, ref: str, expected: bool = True) -> StoryRecord:
    return StoryRecord(
        id=story_id, direction_id="002", app="sacrifice", title="t", slug="lowercase-email",
        scope="backend", state=StoryState.PR_OPEN.value, acceptance_test_ref=ref,
        acceptance_expected=expected,
    )


def _store(root: Path, *, story_id: int = 7, content: str = HTTP_ORACLE) -> str:
    from factory.chain.acceptance import acceptance_dir

    out = acceptance_dir(root, "sacrifice", story_id)
    out.mkdir(parents=True, exist_ok=True)
    (out / "test_acceptance.py").write_text(content, encoding="utf-8")
    return str((out / "test_acceptance.py").relative_to(root))


def _pr(root: Path, repo: Path, story: StoryRecord, sha: str) -> PRContext:
    return PRContext(pr_number=1, head_sha=sha, base_branch="main", story=story,
                      repo_root=repo, software_factory_root=root, dry_run=False)


def _cfg(*, boot: AcceptanceBootConfig | None) -> AppConfig:
    return AppConfig(name="sacrifice", repo="o/r", gates=AppGatesConfig(acceptance_oracle=True, acceptance_boot=boot))


def _bootable_repo(tmp_path: Path, *, base_impl: str = BAD_IMPL, head_impl: str = GOOD_IMPL):
    """A repo whose HEAD *commit* carries the bootable app fixture.

    ``judge_worktree``/``boot_app`` operate on a CHECKOUT of the committed
    tree — writing fixture files straight into the working tree after the
    fact would never reach that checkout, so every write here is followed by
    a real commit.
    """
    repo = tmp_path / "repo"
    base_sha, head_sha = two_commit_repo(
        repo,
        base={"backend/app/__init__.py": "", "backend/app/mod.py": base_impl},
        head={"backend/app/mod.py": head_impl, "backend/app/story_marker.py": "MARKER = 1\n"},
    )
    write_bootable_app(repo, impl=head_impl)
    head_sha = commit_all(repo, "add boot fixture")
    return repo, base_sha, head_sha


def test_missing_port_token_is_an_authoritative_block_via_the_wrapper(tmp_path: Path) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    bad_boot = boot_cfg(command=f"{sys.executable} -B app_server.py")  # no {port} at all
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=bad_boot))
    assert not r.passed
    assert r.details["authoritative"] is True
    assert "{port}" in str(r.details.get("infra_error", ""))


def test_prerequisite_failure_blocks_before_any_boot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    cfg = boot_cfg(prerequisite_command="exit 1", prerequisite_hint="make up-db")

    calls = {"n": 0}
    real_boot_app = boot_mod.boot_app

    def _spy(*a: object, **k: object):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        return real_boot_app(*a, **k)

    monkeypatch.setattr(acceptance_verified.boot_mod, "boot_app", _spy)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=cfg))
    assert not r.passed
    assert r.details["unverifiable_kind"] == "environment_unavailable"
    assert "make up-db" in r.details["prerequisite"]
    assert calls["n"] == 0, "a failed prerequisite must never pay for a boot"


def test_head_never_healthy_is_waivable_head_boot_failed(tmp_path: Path) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    cfg = boot_cfg(health_path="/nonexistent-health-path", boot_timeout_seconds=3)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=cfg))
    assert not r.passed
    assert r.details["unverifiable_kind"] == "head_boot_failed"
    assert r.details["authoritative"] is False

    from factory.chain.acceptance import oracle_sha256, write_waiver

    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256(Path(root / ref).read_text()), reason="known flaky harness")
    waived = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=cfg))
    assert waived.passed
    assert waived.details["verified"] is False


def test_base_boot_failure_falls_through_to_ablation(tmp_path: Path) -> None:
    """The BASE commit has no bootable app at all (a story that adds the whole
    HTTP surface) — the base run must come back ``unknown``, not red, and the
    ablation fallback must be ATTEMPTED (never skipped as if base failure were
    itself a block)."""
    repo = tmp_path / "repo"
    base_sha, head_sha = two_commit_repo(
        repo, base={"README.md": "nothing bootable here\n"},
        head={"backend/app/mod.py": GOOD_IMPL, "backend/app/__init__.py": ""},
    )
    write_bootable_app(repo, impl=GOOD_IMPL)
    head_sha = commit_all(repo, "add boot fixture at HEAD only")
    root = tmp_path / "factory"
    ref = _store(root)
    cfg = boot_cfg()
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head_sha), _cfg(boot=cfg))
    assert r.passed, r.reason
    assert r.details["base_run"].get("boot_failed") is True
    assert r.details["failability_route"] == "ablation"
    assert "failability_ablation" in r.details


def test_app_that_crashes_mid_request_is_authoritative_not_excused(tmp_path: Path) -> None:
    """A request that reaches the booted app and finds it gone (the whole
    process died) surfaces as an ordinary pytest test FAILURE (an exception
    raised inside the test body, not a collection/fixture error) — and that IS
    real evidence the implementation is broken (branch (a): ``failed>=1`` is
    UNCONDITIONALLY authoritative, liveness or not). A production crash under
    the oracle's own request is not something a rollback or a liveness check
    should excuse."""
    repo = tmp_path / "repo"
    _base_sha, head_sha = two_commit_repo(
        repo, base={"backend/app/__init__.py": "", "backend/app/mod.py": BAD_IMPL},
        head={"backend/app/mod.py": GOOD_IMPL},
    )
    (repo / "backend" / "app_server.py").write_text(
        "import http.server, sys, os\n\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        if self.path == '/health':\n"
        "            self.send_response(200); self.send_header('Content-Length','2')\n"
        "            self.end_headers(); self.wfile.write(b'{}'); return\n"
        "        self.send_response(404); self.end_headers()\n"
        "    def do_POST(self):\n"
        "        os._exit(1)  # the whole process dies, no response at all\n"
        "    def log_message(self, *a): pass\n\n"
        "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
        "http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()\n",
        encoding="utf-8",
    )
    head_sha = commit_all(repo, "add crashy boot fixture")
    root = tmp_path / "factory"
    ref = _store(root, content=HTTP_ORACLE)
    cfg = boot_cfg()
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head_sha), _cfg(boot=cfg))
    assert not r.passed
    assert r.details["head_app_alive_after_run"] is False
    assert r.details["head_summary"]["failed"] >= 1
    assert r.details["authoritative"] is True


def test_errors_only_red_is_authoritative_when_the_app_stayed_healthy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The (b)/(c) split, exercised deterministically: a genuine pytest
    COLLECTION/FIXTURE error (``errors`` in the summary, ``failed=0``) — the
    HTTP-mode analogue of the old in-process ``ModuleNotFoundError`` case — is
    still blamed on the dev when the booted app was alive and healthy the
    whole time."""
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)

    from factory.chain import red_green
    from factory.chain.oracle_run import OracleRun

    errors_only = OracleRun(
        status="fail",
        summary=red_green.PytestSummary(passed=0, failed=0, errors=1, line="1 error"),
        criteria={"test_acceptance_oracle_7::test_x": "ERROR"},
        exit_code=2, output="a fixture blew up", junit_ok=True, command="pytest",
    )
    real_run_oracle = acceptance_verified.oracle_run.run_oracle

    def _fake(oracle_src: str, *, base_url: str, run_id: str, dest_name: str, timeout_s: int):  # type: ignore[no-untyped-def]
        if run_id.startswith("head-"):
            return errors_only
        return real_run_oracle(oracle_src, base_url=base_url, run_id=run_id, dest_name=dest_name, timeout_s=timeout_s)

    monkeypatch.setattr(acceptance_verified.oracle_run, "run_oracle", _fake)
    monkeypatch.setattr(acceptance_verified.boot_mod, "is_alive", lambda app: True)
    monkeypatch.setattr(acceptance_verified.boot_mod, "probe_health", lambda app, cfg, **k: True)

    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=boot_cfg()))
    assert not r.passed
    assert r.details["authoritative"] is True
    assert "unverifiable_kind" not in r.details


def test_errors_only_red_is_app_crashed_during_run_when_unhealthy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)

    from factory.chain import red_green
    from factory.chain.oracle_run import OracleRun

    errors_only = OracleRun(
        status="fail",
        summary=red_green.PytestSummary(passed=0, failed=0, errors=1, line="1 error"),
        criteria={"test_acceptance_oracle_7::test_x": "ERROR"},
        exit_code=2, output="a fixture blew up", junit_ok=True, command="pytest",
    )
    real_run_oracle = acceptance_verified.oracle_run.run_oracle

    def _fake(oracle_src: str, *, base_url: str, run_id: str, dest_name: str, timeout_s: int):  # type: ignore[no-untyped-def]
        if run_id.startswith("head-"):
            return errors_only
        return real_run_oracle(oracle_src, base_url=base_url, run_id=run_id, dest_name=dest_name, timeout_s=timeout_s)

    monkeypatch.setattr(acceptance_verified.oracle_run, "run_oracle", _fake)
    monkeypatch.setattr(acceptance_verified.boot_mod, "is_alive", lambda app: False)
    monkeypatch.setattr(acceptance_verified.boot_mod, "probe_health", lambda app, cfg, **k: False)

    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=boot_cfg()))
    assert not r.passed
    assert r.details["unverifiable_kind"] == "app_crashed_during_run"
    assert r.details["authoritative"] is False


def test_legacy_import_form_oracle_never_reaches_a_boot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root, content=IMPORT_FORM_ORACLE)

    calls = {"n": 0}
    real_boot_app = boot_mod.boot_app

    def _spy(*a: object, **k: object):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        return real_boot_app(*a, **k)

    monkeypatch.setattr(acceptance_verified.boot_mod, "boot_app", _spy)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=boot_cfg()))
    assert not r.passed
    assert r.details["unverifiable_kind"] == "oracle_imports_app_code"
    assert calls["n"] == 0, "an import-form oracle must be rejected before any boot"
    assert "waived" not in r.details


def test_no_boot_configured_is_oracle_runner_unconfigured_never_waivable(tmp_path: Path) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=None))
    assert not r.passed
    assert r.details["unverifiable_kind"] == "oracle_runner_unconfigured"

    from factory.chain.acceptance import oracle_sha256, write_waiver

    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256(Path(root / ref).read_text()), reason="try to skip config")
    still_blocked = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=None))
    assert not still_blocked.passed
    assert still_blocked.details.get("waived") is not True


def test_gate_budget_exhausted_is_oracle_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _base, head = _bootable_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    monkeypatch.setattr(acceptance_verified, "_GATE_BUDGET_S", -1)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=boot_cfg()))
    assert not r.passed
    assert r.details["unverifiable_kind"] == "oracle_timeout"
    assert r.details["authoritative"] is False


def test_bench_pin_flag_without_boot_does_not_raise_at_config_load() -> None:
    """``bench/swebench_adapter.py`` writes ``acceptance_oracle: True`` with no
    boot block at all (the swebench arm has no real app). Config LOAD must
    never raise for that shape — the refusal lives at the GATE."""
    cfg = AppConfig(name="swebench", repo="x/y", gates=AppGatesConfig(acceptance_oracle=True))
    assert cfg.gates.acceptance_boot is None
    assert cfg.gates.acceptance_oracle is True


# --------------------------------------------------------------------------- #
# boot.py — port allocation, teardown, PGID/grandchild kill
# --------------------------------------------------------------------------- #


def test_free_port_gives_different_ports_concurrently() -> None:
    ports = {boot_mod.free_port() for _ in range(5)}
    assert len(ports) == 5


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
            return False


def test_pgid_teardown_kills_the_grandchild_and_frees_the_port(tmp_path: Path) -> None:
    """The boot command is a SHELL that forks a grandchild server and waits.
    Killing only the direct child would leave the grandchild (and the port)
    alive; PGID teardown must reach both."""
    tree = tmp_path / "tree"
    tree.mkdir()
    server_script = tree / "server.py"
    server_script.write_text(
        "import http.server, sys\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200); self.send_header('Content-Length','2')\n"
        "        self.end_headers(); self.wfile.write(b'{}')\n"
        "    def log_message(self, *a): pass\n"
        "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
        "http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()\n",
        encoding="utf-8",
    )
    cfg = AcceptanceBootConfig(
        command=f"sh -c '{sys.executable} {server_script} --port {{port}} & wait'",
        health_path="/", boot_timeout_seconds=10, run_timeout_seconds=10, shutdown_grace_seconds=2,
    )
    with boot_mod.boot_app(tree, cfg, "pgid-test", label="pgid") as (app, why):
        assert app is not None, why
        assert _port_in_use(app.port)
        port = app.port
        pgid = app.pgid
    # Outside the with-block: teardown has already run in boot_app's finally.
    time.sleep(0.3)
    assert not _port_in_use(port)
    with pytest.raises(OSError):
        os.killpg(pgid, 0)  # the whole process group is gone


def test_child_process_death_is_observed_by_is_alive(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "app_server.py").write_text(
        "import http.server, sys, threading, time, os\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        if self.path == '/health':\n"
        "            self.send_response(200); self.send_header('Content-Length','2')\n"
        "            self.end_headers(); self.wfile.write(b'{}')\n"
        "    def log_message(self, *a): pass\n"
        "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
        "srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), H)\n"
        "def _die():\n"
        "    time.sleep(1.5)\n"
        "    os._exit(0)\n"
        "threading.Thread(target=_die, daemon=True).start()\n"
        "srv.serve_forever()\n",
        encoding="utf-8",
    )
    cfg = boot_cfg(health_path="/health", subdir=None)  # cwd=tree root
    with boot_mod.boot_app(tree, cfg, "die-test", label="die") as (app, why):
        assert app is not None, why
        assert boot_mod.is_alive(app)
        time.sleep(2.0)
        assert not boot_mod.is_alive(app)


# --------------------------------------------------------------------------- #
# F1 review round — the tamper check itself, in isolation (no boot needed)
# --------------------------------------------------------------------------- #


def test_tamper_check_catches_the_oracle_file_being_overwritten(tmp_path: Path) -> None:
    oracle_path = tmp_path / "test_oracle.py"
    oracle_path.write_text("def test_x():\n    assert True\n", encoding="utf-8")
    pre_sha = oracle_run._sha256_file(oracle_path)
    assert pre_sha is not None
    expected = {"test_oracle.py"}

    assert oracle_run._tamper_check(tmp_path, oracle_path, pre_sha, expected) is None

    oracle_path.write_text("def test_x():\n    pass\n", encoding="utf-8")
    why = oracle_run._tamper_check(tmp_path, oracle_path, pre_sha, expected)
    assert why is not None
    assert "changed during the run" in why


def test_tamper_check_catches_an_extra_file_in_the_run_dir(tmp_path: Path) -> None:
    oracle_path = tmp_path / "test_oracle.py"
    oracle_path.write_text("def test_x():\n    assert True\n", encoding="utf-8")
    pre_sha = oracle_run._sha256_file(oracle_path)
    assert pre_sha is not None
    expected = {"test_oracle.py"}

    (tmp_path / "conftest.py").write_text("# planted\n", encoding="utf-8")
    why = oracle_run._tamper_check(tmp_path, oracle_path, pre_sha, expected)
    assert why is not None
    assert "conftest.py" in why


def test_tamper_check_catches_a_missing_expected_file(tmp_path: Path) -> None:
    oracle_path = tmp_path / "test_oracle.py"
    oracle_path.write_text("def test_x():\n    assert True\n", encoding="utf-8")
    pre_sha = oracle_run._sha256_file(oracle_path)
    assert pre_sha is not None
    junit = tmp_path / "junit.xml"
    junit.write_text("<x/>", encoding="utf-8")
    expected = {"test_oracle.py", "junit.xml"}
    junit.unlink()
    why = oracle_run._tamper_check(tmp_path, oracle_path, pre_sha, expected)
    assert why is not None
    assert "junit.xml" in why


def test_run_oracle_status_is_tampered_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Drive ``run_oracle`` for real (a real pytest subprocess against a real
    stub) and confirm a run dir tampered with WHILE pytest was executing is
    caught — not just the isolated ``_tamper_check`` unit above."""
    from factory.chain import stub_server

    original_check = oracle_run._tamper_check
    calls = {"n": 0}

    def _tamper_after_first_check(tmpdir: Path, oracle_path: Path, pre_sha: str, expected: set[str]) -> str | None:
        calls["n"] += 1
        # Simulate a background watcher having planted a file DURING the run,
        # discovered the moment this module checks for it.
        (Path(tmpdir) / "conftest.py").write_text("# planted mid-run\n", encoding="utf-8")
        return original_check(tmpdir, oracle_path, pre_sha, expected)

    monkeypatch.setattr(oracle_run, "_tamper_check", _tamper_after_first_check)
    with stub_server.stub_app() as stub:
        run = oracle_run.run_oracle(
            "def test_x():\n    assert True\n", base_url=stub.base_url, run_id="t",
            dest_name="test_x.py", timeout_s=15,
        )
    assert run.status == "tampered"
    assert calls["n"] == 1


# --------------------------------------------------------------------------- #
# F2 review round — the ablation probe's crediting wiring
# --------------------------------------------------------------------------- #


def test_ablation_probe_command_serializes_credit_flags() -> None:
    from factory.chain.gates.acceptance_verified import _ablation_probe_command

    cmd = _ablation_probe_command(
        factory_root=Path("/factory"), dest_name="test_oracle_7.py", boot=boot_cfg(),
        run_id="ablation-abc123", credited={"test_oracle_7::test_ac1", "test_oracle_7::test_ac2"},
    )
    assert "--credit test_oracle_7::test_ac1" in cmd
    assert "--credit test_oracle_7::test_ac2" in cmd


def test_ablation_probe_command_with_no_credits_omits_the_flag() -> None:
    from factory.chain.gates.acceptance_verified import _ablation_probe_command

    cmd = _ablation_probe_command(
        factory_root=Path("/factory"), dest_name="test_oracle_7.py", boot=boot_cfg(),
        run_id="ablation-abc123", credited=set(),
    )
    assert "--credit" not in cmd


# --------------------------------------------------------------------------- #
# F11 review round — env values under {run_dir} get their directory created
# --------------------------------------------------------------------------- #


def test_boot_creates_directories_named_by_run_dir_env_values(tmp_path: Path) -> None:
    """A boot recipe like sacrifice's (``SACRIFICE_MEDIA_DIR: "{run_dir}/media"``)
    must not fail just because ``mkdtemp`` only created ``run_dir`` ITSELF."""
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "app_server.py").write_text(
        "import http.server, json, os, sys\n\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        if self.path == '/health':\n"
        "            media = os.environ.get('APP_MEDIA_DIR', '')\n"
        "            ok = os.path.isdir(media)\n"
        "            body = json.dumps({'media_exists': ok}).encode()\n"
        "            self.send_response(200)\n"
        "            self.send_header('Content-Length', str(len(body)))\n"
        "            self.end_headers()\n"
        "            self.wfile.write(body)\n"
        "            return\n"
        "        self.send_response(404); self.end_headers()\n"
        "    def log_message(self, *a): pass\n\n"
        "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
        "http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()\n",
        encoding="utf-8",
    )
    cfg = AcceptanceBootConfig(
        command=f"{sys.executable} -B app_server.py --port {{port}}",
        health_path="/health", boot_timeout_seconds=15, run_timeout_seconds=20,
        env={"APP_MEDIA_DIR": "{run_dir}/media/uploads"},
    )
    with boot_mod.boot_app(tree, cfg, "rundir-test", label="rundir") as (app, why):
        assert app is not None, why
        import httpx

        r = httpx.get(f"{app.base_url}/health", timeout=5)
        assert r.json()["media_exists"] is True


def test_acceptance_run_id_is_unique_per_evaluation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """KNOWN OPEN #2 regression: two evaluations of the SAME story must never
    reuse an ``ACCEPTANCE_RUN_ID``.

    The id used to be ``head-{sid}``/``base-{sid}`` — deterministic per story —
    so a re-grade (every new dev commit re-evaluates gates) collided with its
    own previous run's namespaced rows in a shared persistent DB: story 179
    left ``accept_head-179_*`` users in the shared dev Postgres, and the next
    evaluation's register would 409 into an unwaivable authoritative block.
    The authoring prompt promises the id is "a value UNIQUE to this run"; this
    pins that promise to the implementation.
    """
    from tests.oracle_repo import git as _git
    from tests.oracle_repo import init_repo as _init_repo

    # Bootable at BASE too (BAD_IMPL) — _bootable_repo's base carries no
    # app_server.py, which sends the gate down the ablation route and the
    # base run this test exists to pin would never execute.
    repo = tmp_path / "repo"
    _init_repo(repo)
    write_bootable_app(repo, impl=BAD_IMPL)
    commit_all(repo, "base")
    _git(repo, "checkout", "-q", "-b", "feat/story")
    write_bootable_app(repo, impl=GOOD_IMPL)
    (repo / "backend" / "app" / "story_marker.py").write_text("MARKER = 1\n", encoding="utf-8")
    head = commit_all(repo, "story work")

    root = tmp_path / "factory"
    ref = _store(root)

    seen: list[str] = []
    real_run_oracle = acceptance_verified.oracle_run.run_oracle

    def _spy(oracle_src: str, *, base_url: str, run_id: str, dest_name: str, timeout_s: int):  # type: ignore[no-untyped-def]
        seen.append(run_id)
        return real_run_oracle(
            oracle_src, base_url=base_url, run_id=run_id, dest_name=dest_name, timeout_s=timeout_s
        )

    monkeypatch.setattr(acceptance_verified.oracle_run, "run_oracle", _spy)
    cfg = _cfg(boot=boot_cfg())

    r1 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), cfg)
    assert r1.passed, r1.reason
    r2 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), cfg)
    assert r2.passed, r2.reason

    heads = [r for r in seen if r.startswith("head-7-")]
    assert len(heads) >= 2, f"expected a live HEAD run per evaluation, saw {seen!r}"
    assert heads[0] != heads[1], "ACCEPTANCE_RUN_ID must be unique per evaluation"

    # The BASE half decides merge_base_red → passed=True, so it is the half
    # that most needs pinning. Collect by the BARE prefix — filtering on
    # "base-7-" would skip the assertion entirely if the base id regressed to
    # the deterministic "base-7" (asserting a property by filtering on it is
    # the criterion-vacuity failure class).
    bases = [r for r in seen if r.startswith("base-")]
    assert bases, f"expected at least one live BASE run, saw {seen!r}"
    assert bases[0] != "base-7", "base run id must carry the per-evaluation nonce"
    # Within one evaluation HEAD and BASE share the nonce but differ by prefix
    # (that prefix split is what keeps them from colliding with each other).
    assert bases[0].removeprefix("base-") == heads[0].removeprefix("head-")

    # run_ids.json must record exactly the ids that ACTUALLY executed — two
    # head runs, one base run (the second evaluation's base is a cache hit).
    # Gate details survive only on the fail path, so this file is the only
    # durable row→evaluation mapping for the shared DB's accept_* leftovers.
    import json as _json

    from factory.chain.acceptance import acceptance_dir

    recorded = _json.loads(
        (acceptance_dir(root, "sacrifice", 7) / "run_ids.json").read_text(encoding="utf-8")
    )
    kinds = [e["kind"] for e in recorded]
    assert kinds.count("head") == 2, recorded
    assert kinds.count("base") == 1, recorded
    assert {e["run_id"] for e in recorded} == set(heads) | set(bases)


# --------------------------------------------------------------------------- #
# A2 (BENCHMARK-READINESS-PLAN.md) — base_failures_matching_stub: ADVISORY
# instrumentation only. No taxonomy, no blocking: see the module docstring's
# KNOWN OPEN #3 for why a status-code taxonomy INVERTS on this app (a 401
# from an auth dependency shadowing a would-be 404).
# --------------------------------------------------------------------------- #

#: A single-route app whose response body is CONTROLLED BY AN ENV VAR, so the
#: same ``/widget`` route answers "GOOD" at one boot and "BAD" at another
#: without needing two different implementations to import. The oracle below
#: asserts a fixed expected value; a stub's catch-all body and the "BAD" base
#: response both fail that assertion for the SAME reason (wrong string), so
#: the junit OUTCOME (``FAIL``) is identical across base and both stub
#: variants — the exact "credited criterion whose base failure looks just
#: like its stub failure" case A2 exists to surface for a human, without this
#: gate ever asserting what that means.
_WIDGET_APP_SERVER_SRC = '''\
"""Stdlib-only bootable test app (fixture, not app code under test)."""
import http.server
import json
import os
import sys

ECHO = os.environ.get("WIDGET_ECHO", "BAD")


class Handler(http.server.BaseHTTPRequestHandler):
    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _drain(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {})

    def do_POST(self):
        self._drain()
        if self.path == "/widget":
            self._send_json(200, {"echo": ECHO})
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

#: Asserts a FIXED expected value (not a status code, not a KeyError-prone
#: access) so every failing world — both gutted stubs (neither has an "echo"
#: key matching "GOOD") and a "BAD"-echoing base — fails via the SAME junit
#: outcome, ``FAIL`` (an ``AssertionError``, never an ``ERROR``).
_WIDGET_ORACLE = (
    "import os\n"
    "import httpx\n"
    "\n"
    "def test_ac1_widget_echoes_good():\n"
    "    base = os.environ['ACCEPTANCE_BASE_URL']\n"
    "    r = httpx.post(f'{base}/widget', json={}, timeout=5)\n"
    "    assert r.json().get('echo') == 'GOOD'\n"
)


def _widget_repo(tmp_path: Path):
    """``main`` boots with ``WIDGET_ECHO=BAD`` baked into base's server file;
    the story branch overwrites it with ``WIDGET_ECHO=GOOD`` baked into
    HEAD's — no env passthrough needed, so the boot config stays the plain
    ``boot_cfg()`` every other test in this module uses."""
    repo = tmp_path / "repo"
    base_src = _WIDGET_APP_SERVER_SRC.replace('os.environ.get("WIDGET_ECHO", "BAD")', '"BAD"')
    head_src = _WIDGET_APP_SERVER_SRC.replace('os.environ.get("WIDGET_ECHO", "BAD")', '"GOOD"')
    base_sha, head_sha = two_commit_repo(
        repo,
        base={"backend/app_server.py": base_src, "backend/app/__init__.py": ""},
        head={"backend/app_server.py": head_src, "backend/app/story_marker.py": "MARKER = 1\n"},
    )
    return repo, base_sha, head_sha


def test_base_failures_matching_stub_flags_a_credited_criterion(tmp_path: Path) -> None:
    """The criterion PASSES at HEAD (echo == "GOOD"), is credited (it fails
    BOTH gutted-implementation stub variants — neither answers "GOOD"), and
    fails at the merge base with the exact same junit outcome (``FAIL``) it
    also produced against both stubs. A2's advisory diagnostic must name it in
    ``details["base_failures_matching_stub"]`` — and must NOT change the
    verdict: this is a completely ordinary red-at-base/green-at-HEAD story,
    which is why the gate still PASSES it."""
    repo, _base, head = _widget_repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root, content=_WIDGET_ORACLE)
    cfg = boot_cfg()
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=cfg))

    assert r.passed, r.reason
    assert r.details["failability_route"] == "merge_base_red"
    nodeid = next(iter(r.details["credited_criteria"]))
    assert r.details["base_failures_matching_stub"] == [nodeid]


def test_base_failures_matching_stub_never_changes_the_verdict(tmp_path: Path) -> None:
    """A2 must be PURE INSTRUMENTATION: rerun the exact story shape
    ``test_D1_real_oracle_red_at_base_green_at_head_passes``
    (``test_acceptance_oracle_green_means_something.py``) already pins to a
    ``passed``/``verified``/``authoritative``/``tests_passed==1``/
    ``merge_base_red`` verdict — bootable at BOTH base and head (the
    ``test_acceptance_run_id_is_unique_per_evaluation`` construction;
    ``_bootable_repo`` leaves base unbootable, which steers onto the
    ablation route and never exercises ``_base_run`` at all) — and assert
    every ONE of those pre-existing fields is untouched by the new
    instrumentation, regardless of what it reports.

    It DOES report this criterion here: the empty stub's ``KeyError`` and the
    plausible stub's wrong-value ``AssertionError`` are BOTH classified
    ``FAIL`` by pytest's own junit-xml (``<error>`` is reserved for
    setup/collection failures, never for an exception raised during the test
    body itself), and the base's wrong-value ``AssertionError`` is the same
    ``FAIL`` — so this credited criterion legitimately matches on all three.
    That is exactly the kind of ordinary, ship-it story A2 must never block:
    proof the flag is advisory is that ``r.passed`` stays ``True`` anyway."""
    repo = tmp_path / "repo"
    init_repo(repo)
    write_bootable_app(repo, impl=BAD_IMPL)
    commit_all(repo, "base")
    git(repo, "checkout", "-q", "-b", "feat/story")
    write_bootable_app(repo, impl=GOOD_IMPL)
    (repo / "backend" / "app" / "story_marker.py").write_text("MARKER = 1\n", encoding="utf-8")
    head = commit_all(repo, "story work")

    root = tmp_path / "factory"
    ref = _store(root)
    cfg = boot_cfg()
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg(boot=cfg))

    assert r.passed, r.reason
    assert r.details["verified"] is True
    assert r.details["authoritative"] is True
    assert r.details["tests_passed"] == 1
    assert r.details["failability_route"] == "merge_base_red"
    nodeid = next(iter(r.details["credited_criteria"]))
    assert r.details["base_failures_matching_stub"] == [nodeid]
