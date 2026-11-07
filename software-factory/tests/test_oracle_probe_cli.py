"""``factory/chain/oracle_probe.py`` — the ablation's out-of-process check.

Invoked by ``mutation.check_can_fail`` as a plain shell command with the
caller's venv stripped from ``PATH`` (``mutation._mutant_env``), so every test
here calls it the same way: by ABSOLUTE path, via ``sys.executable``, never
relying on import machinery beyond what the script bootstraps itself.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from tests.oracle_boot_fixture import BAD_IMPL, GOOD_IMPL, HTTP_ORACLE, boot_cfg, write_bootable_app

_FACTORY_ROOT = Path(__file__).resolve().parent.parent
_PROBE = _FACTORY_ROOT / "factory" / "chain" / "oracle_probe.py"


def _run_probe(
    tree: Path, *, oracle_name: str, boot, run_id: str, timeout: int = 60, credit: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    args = [
        sys.executable, str(_PROBE),
        "--factory-root", str(_FACTORY_ROOT),
        "--tree", str(tree),
        "--oracle", oracle_name,
        "--boot-command", boot.command,
        "--boot-cwd", boot.cwd or "",
        "--health-path", boot.health_path,
        "--boot-timeout", str(boot.boot_timeout_seconds),
        "--run-timeout", str(boot.run_timeout_seconds),
        "--shutdown-grace", str(boot.shutdown_grace_seconds),
        "--run-id", run_id,
    ]
    for c in credit or []:
        args += ["--credit", c]
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)  # noqa: S603


# The node id ``HTTP_ORACLE`` produces once collected under the name "oracle.py".
_ORACLE_NODE_ID = "oracle::test_ac1_email_is_lowercased"


def test_exit_mapping_green_red_infra(tmp_path: Path) -> None:
    good = tmp_path / "good"
    write_bootable_app(good, impl=GOOD_IMPL)
    (good / "oracle.py").write_text(HTTP_ORACLE, encoding="utf-8")
    ok = _run_probe(good, oracle_name="oracle.py", boot=boot_cfg(), run_id="t-green")
    assert ok.returncode == 0, ok.stdout + ok.stderr

    bad = tmp_path / "bad"
    write_bootable_app(bad, impl=BAD_IMPL)
    (bad / "oracle.py").write_text(HTTP_ORACLE, encoding="utf-8")
    red = _run_probe(
        bad, oracle_name="oracle.py", boot=boot_cfg(), run_id="t-red", credit=[_ORACLE_NODE_ID],
    )
    assert red.returncode == 1, red.stdout + red.stderr

    missing = tmp_path / "missing"
    missing.mkdir()
    infra = _run_probe(missing, oracle_name="does_not_exist.py", boot=boot_cfg(), run_id="t-infra")
    assert infra.returncode >= 2, infra.stdout + infra.stderr


def test_red_requires_the_credited_node_to_be_the_one_that_failed(tmp_path: Path) -> None:
    """AC2/K-awareness (found 2026-08-07): a RED on a criterion that is NOT in
    ``--credit`` must be INFRA, never a kill — the whole point of crediting is
    that a stub-excluded (vacuous) criterion going red proves nothing."""
    bad = tmp_path / "bad"
    write_bootable_app(bad, impl=BAD_IMPL)
    (bad / "oracle.py").write_text(HTTP_ORACLE, encoding="utf-8")

    not_credited = _run_probe(bad, oracle_name="oracle.py", boot=boot_cfg(), run_id="t-nocredit", credit=[])
    assert not_credited.returncode == 2, not_credited.stdout

    wrong_credit = _run_probe(
        bad, oracle_name="oracle.py", boot=boot_cfg(), run_id="t-wrongcredit",
        credit=["oracle::test_some_other_unrelated_criterion"],
    )
    assert wrong_credit.returncode == 2, wrong_credit.stdout

    right_credit = _run_probe(
        bad, oracle_name="oracle.py", boot=boot_cfg(), run_id="t-rightcredit", credit=[_ORACLE_NODE_ID],
    )
    assert right_credit.returncode == 1, right_credit.stdout


def test_boot_failure_is_infra_not_a_crash(tmp_path: Path) -> None:
    """A boot command that names ``{port}`` (so it passes the config-shape
    check) but never actually opens it — a real crash-on-start, the common
    failure this exists to distinguish from a RED."""
    tree = tmp_path / "nothingtobook"
    tree.mkdir()
    (tree / "oracle.py").write_text(HTTP_ORACLE, encoding="utf-8")
    broken = boot_cfg(
        command=f"{sys.executable} -c \"print('port {{port}} noted, exiting'); import sys; sys.exit(3)\"",
        boot_timeout_seconds=3,
    )
    r = _run_probe(tree, oracle_name="oracle.py", boot=broken, run_id="t-boot-fail", timeout=30)
    assert r.returncode >= 2
    assert "BOOT FAILED" in r.stdout


def test_malformed_boot_command_is_infra_not_a_1_exit(tmp_path: Path) -> None:
    """A boot command missing ``{port}`` entirely is a CONFIG error
    (``boot_app`` raises ``ValueError``) — the probe must map that to INFRA
    (exit >=2), never to exit 1, which the ablation harness reads as RED."""
    tree = tmp_path / "noport"
    tree.mkdir()
    (tree / "oracle.py").write_text(HTTP_ORACLE, encoding="utf-8")
    broken = boot_cfg(command=f"{sys.executable} -c \"import sys; sys.exit(3)\"", boot_timeout_seconds=3)
    r = _run_probe(tree, oracle_name="oracle.py", boot=broken, run_id="t-noport", timeout=30)
    assert r.returncode >= 2
    assert "BOOT ERROR" in r.stdout


def test_server_log_tail_is_echoed_on_a_red(tmp_path: Path) -> None:
    """The booted server's own stdout/stderr — captured to its log file by
    ``boot.boot_app`` — is echoed by the probe whenever it is non-empty, so a
    human reading a blocked ablation attempt's ``detail`` has something to go
    on. Uses a tiny custom server that PRINTS explicitly (rather than the
    shared fixture, whose handler silences ``log_message``) so the assertion
    does not depend on incidental server logging behaviour."""
    tree = tmp_path / "logtail"
    tree.mkdir()
    (tree / "app_server.py").write_text(
        "import http.server, json, sys\n\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        print('FACTORY_TEST_LOG_MARKER health probe served')\n"
        "        if self.path == '/health':\n"
        "            body = b'{}'\n"
        "            self.send_response(200)\n"
        "            self.send_header('Content-Length', str(len(body)))\n"
        "            self.end_headers()\n"
        "            self.wfile.write(body)\n"
        "            return\n"
        "        self.send_response(404); self.end_headers()\n\n"
        "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
        "http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()\n",
        encoding="utf-8",
    )
    (tree / "oracle.py").write_text(
        "import os, httpx\n\n"
        "def test_boom():\n"
        "    base = os.environ['ACCEPTANCE_BASE_URL']\n"
        "    httpx.get(f'{base}/health', timeout=5)\n"
        "    assert False, 'deliberate red for log-tail coverage'\n",
        encoding="utf-8",
    )
    cfg = boot_cfg(cwd=None, health_path="/health")
    r = _run_probe(
        tree, oracle_name="oracle.py", boot=cfg, run_id="t-logtail", credit=["oracle::test_boom"],
    )
    assert r.returncode == 1
    assert "server log tail" in r.stdout
    assert "FACTORY_TEST_LOG_MARKER" in r.stdout


def test_env_is_the_constructed_boot_env_not_the_probes_inherited_one(tmp_path: Path) -> None:
    """The booted app's env comes from ``AcceptanceBootConfig`` (passthrough +
    explicit ``env``), never a blind inheritance of the probe's own process
    env — a sentinel var set only in the probe's environment must NOT reach
    the booted app."""
    tree = tmp_path / "envcheck"
    (tree / "backend").mkdir(parents=True)
    (tree / "backend" / "app_server.py").write_text(
        "import http.server, json, os, sys\n\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        if self.path == '/health':\n"
        "            leaked = 'PROBE_ONLY_SENTINEL' in os.environ\n"
        "            body = json.dumps({'leaked': leaked}).encode()\n"
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
    (tree / "oracle.py").write_text(
        "import os, httpx\n\n"
        "def test_env_not_leaked():\n"
        "    base = os.environ['ACCEPTANCE_BASE_URL']\n"
        "    r = httpx.get(f'{base}/health', timeout=5)\n"
        "    assert r.json()['leaked'] is False\n",
        encoding="utf-8",
    )
    import os as _os

    env = dict(_os.environ)
    env["PROBE_ONLY_SENTINEL"] = "1"
    args = [
        sys.executable, str(_PROBE),
        "--factory-root", str(_FACTORY_ROOT),
        "--tree", str(tree),
        "--oracle", "oracle.py",
        "--boot-command", boot_cfg().command,
        "--boot-cwd", "backend",
        "--health-path", "/health",
        "--boot-timeout", "15",
        "--run-timeout", "20",
        "--shutdown-grace", "2",
        "--run-id", "t-env",
    ]
    r = subprocess.run(args, capture_output=True, text=True, timeout=60, env=env)  # noqa: S603
    assert r.returncode == 0, r.stdout + r.stderr
