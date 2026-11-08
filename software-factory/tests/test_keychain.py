"""factory.keychain: keys from the OS keychain when present, .env otherwise."""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

from factory import keychain

SECRET = "kc-value-not-real-9Zq"


def _cp(stdout: str = "", code: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], code, stdout, "")


def test_stack_defaults_and_override():
    assert keychain.stack({}, "win32") == "work"
    assert keychain.stack({}, "linux") == "personal"
    assert keychain.stack({"PA_STACK": "Personal"}, "win32") == "personal"
    assert keychain.stack({"PA_STACK": "nonsense"}, "linux") == "personal"


def test_known_names_reads_secret_shaped_names(tmp_path: Path):
    ex = tmp_path / ".env.example"
    ex.write_text("# note\nDEEPSEEK_API_KEY\n# OPENAI_API_KEY\nOPENAI_COMPAT_API_BASE\nFOO=bar\nSOME_TOKEN=\n")
    assert keychain.known_names(ex) == ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "SOME_TOKEN"]
    assert "DEEPSEEK_API_KEY" in keychain.known_names(tmp_path / "missing")


def test_linux_fills_unset_names_only_and_tries_legacy(monkeypatch):
    monkeypatch.setattr(keychain.shutil, "which", lambda _: "/usr/bin/secret-tool")
    asked: list[list[str]] = []

    def run(cmd, stdin):
        asked.append(cmd)
        attrs = dict(zip(cmd[2::2], cmd[3::2], strict=False))
        if attrs.get("name") == "A_API_KEY" and attrs.get("service") == "dev-tools" and attrs.get("stack") == "personal":
            return _cp(SECRET + "\n")
        if attrs.get("name") == "OLD_API_KEY" and attrs.get("service") == "personal-assistant":
            return _cp("legacy-value")
        return _cp("", 1)

    env = {"DBUS_SESSION_BUS_ADDRESS": "x", "SET_API_KEY": "already"}
    got = keychain.fill(["A_API_KEY", "OLD_API_KEY", "SET_API_KEY", "MISSING_API_KEY"], env, "linux", run)
    assert got == ["A_API_KEY", "OLD_API_KEY"]
    assert env["A_API_KEY"] == SECRET and env["OLD_API_KEY"] == "legacy-value"
    assert env["SET_API_KEY"] == "already"
    assert not any("SET_API_KEY" in " ".join(c) for c in asked), "a key already set is never looked up"
    assert all(SECRET not in " ".join(c) for c in asked)


def test_empty_env_value_counts_as_unset_and_opt_out(monkeypatch):
    monkeypatch.setattr(keychain.shutil, "which", lambda _: "/usr/bin/secret-tool")
    run = lambda cmd, stdin: _cp(SECRET)  # noqa: E731
    env = {"DBUS_SESSION_BUS_ADDRESS": "x", "A_API_KEY": ""}
    assert keychain.fill(["A_API_KEY"], env, "linux", run) == ["A_API_KEY"]
    env2 = {"DBUS_SESSION_BUS_ADDRESS": "x", "FACTORY_KEYCHAIN": "0"}
    assert keychain.fill(["A_API_KEY"], env2, "linux", run) == []
    assert "A_API_KEY" not in env2


def test_no_session_bus_or_tool_is_a_miss_not_an_error(monkeypatch):
    monkeypatch.setattr(keychain.shutil, "which", lambda _: None)
    assert keychain.fill(["A_API_KEY"], {}, "linux", lambda c, s: _cp(SECRET)) == []


def test_windows_request_is_stdin_only_and_stack_labelled():
    seen: dict = {}

    def run(cmd, stdin):
        seen["cmd"], seen["stdin"] = cmd, stdin
        return _cp(json.dumps({"A_API_KEY": SECRET, "OTHER": "x"}))

    env: dict[str, str] = {}
    assert keychain.fill(["A_API_KEY", "B_API_KEY"], env, "win32", run) == ["A_API_KEY"]
    assert env == {"A_API_KEY": SECRET}
    assert SECRET not in " ".join(seen["cmd"])
    req = json.loads(base64.b64decode(seen["stdin"].strip()))
    assert req["resources"] == ["dev-tools/work", "personal-assistant"]
    assert req["names"] == ["A_API_KEY", "B_API_KEY"]


def test_load_dotenv_env_file_beats_keychain(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("FROM_FILE_API_KEY", raising=False)
    monkeypatch.setattr(keychain, "_loaded", False)
    f = tmp_path / ".env"
    f.write_text("FROM_FILE_API_KEY=file-value\n")
    called: list[str] = []
    monkeypatch.setattr(keychain, "fill", lambda *a, **k: called.append("fill") or [])
    keychain.load_dotenv()
    assert called == [], "the bare cwd call does not ask the keychain yet"
    keychain.load_dotenv(f, override=False)
    assert called == ["fill"]
    import os

    assert os.environ["FROM_FILE_API_KEY"] == "file-value"
    monkeypatch.delenv("FROM_FILE_API_KEY", raising=False)
