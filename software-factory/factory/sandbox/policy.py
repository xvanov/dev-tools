"""What a sandboxed run may touch: its policy, and the environment it gets.

A :class:`Policy` is written by the host (the factory or the PA, running as the
operator) before the run starts, and read by :mod:`factory.sandbox.exec`, which
starts the agent's process inside the OS sandbox. JSON on disk so a process in
another language (the PA) can produce it with ``factory.sandbox.host``.

The environment is built from an ALLOWLIST, not by deleting known secrets: a
variable the sandbox does not need is not there. Profile and temp variables
point into the run's own home, so tools write their caches inside the sandbox;
git and gh find no system/global config and no login; the proxy and broker
variables point at the run's egress proxy and credential broker.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

#: Non-secret variables a sandboxed process keeps (case-insensitive on Windows).
KEEP_ENV = (
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "TZ",
    "SHELL",
    "USER",
    "USERNAME",
    "LOGNAME",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
)

#: Never passed, even if a caller asks (``pass_env``): these are credentials.
NEVER_PASS = (
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "FACTORY_GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
)

_PROXY_VARS = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy")


@dataclass
class Policy:
    run_id: str
    #: Where the agent works and may write (the worktree / scratch dir).
    workdir: str
    #: The run's own home (profile, caches, temp); inside the run's state.
    home: str
    #: More writable paths (rare).
    writable: list[str] = field(default_factory=list)
    #: Read-only paths the run needs (interpreters, tools, the factory's code).
    readable: list[str] = field(default_factory=list)
    #: The environment the process starts with (from :func:`sandbox_env`).
    env: dict[str, str] = field(default_factory=dict)
    #: Linux: unix sockets the in-sandbox relay exposes on loopback,
    #: ``{"127.0.0.1:3128": "/path/proxy.sock"}``.
    relays: dict[str, str] = field(default_factory=dict)
    #: Windows: the per-run SID the run's directories are granted to.
    run_sid: str | None = None

    def dump(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        return path

    @classmethod
    def load(cls, path: Path) -> Policy:
        data: dict[str, Any] = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


def home_layout(home: Path) -> dict[str, Path]:
    """The profile directories inside a run's home (created by the host)."""
    return {
        "home": home,
        "appdata": home / "AppData" / "Roaming",
        "localappdata": home / "AppData" / "Local",
        "tmp": home / "tmp",
        "config": home / ".config",
        "cache": home / ".cache",
        "data": home / ".local" / "share",
        "bin": home / "bin",
        "gh": home / ".config" / "gh",
    }


def sandbox_env(
    base: dict[str, str] | None,
    *,
    home: Path,
    run_id: str,
    proxy_url: str | None,
    broker_url: str | None,
    capability: str | None,
    pass_env: list[str] | tuple[str, ...] = (),
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    """The sandboxed process's whole environment. See the module docstring.

    ``pass_env`` names variables to copy through on purpose (for example
    ``CLAUDE_CODE_OAUTH_TOKEN`` when Claude Code itself runs inside: the model
    credential is then the one key in the sandbox, and the operator chose it).
    GitHub tokens and SSH agent sockets are never passed.
    """
    src = dict(os.environ if base is None else base)
    upper = {k.upper(): k for k in src}
    env: dict[str, str] = {}
    for name in KEEP_ENV:
        key = upper.get(name.upper())
        if key is not None:
            env[key] = src[key]
    for name in pass_env:
        if name.upper() in NEVER_PASS:
            continue
        key = upper.get(name.upper())
        if key is not None:
            env[key] = src[key]
    lay = home_layout(home)
    env.update(
        HOME=str(lay["home"]),
        USERPROFILE=str(lay["home"]),
        APPDATA=str(lay["appdata"]),
        LOCALAPPDATA=str(lay["localappdata"]),
        TEMP=str(lay["tmp"]),
        TMP=str(lay["tmp"]),
        TMPDIR=str(lay["tmp"]),
        XDG_CONFIG_HOME=str(lay["config"]),
        XDG_CACHE_HOME=str(lay["cache"]),
        XDG_DATA_HOME=str(lay["data"]),
        # git: no system or global config (credential helpers live there), no prompts.
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=str(lay["home"] / ".gitconfig"),
        GIT_TERMINAL_PROMPT="0",
        GCM_INTERACTIVE="never",
        # gh: an empty config dir of the run's own; no hosts.yml, no login.
        GH_CONFIG_DIR=str(lay["gh"]),
        GH_PROMPT_DISABLED="1",
        SANDBOX="1",
        SANDBOX_RUN_ID=run_id,
    )
    if proxy_url:
        for name in _PROXY_VARS:
            env[name] = proxy_url
        # The broker is local and is reached directly, never via the proxy.
        env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost,::1"
    if broker_url and capability:
        env["SANDBOX_BROKER_URL"] = broker_url
        env["SANDBOX_BROKER_CAPABILITY"] = capability
    path_key = next((k for k in env if k.upper() == "PATH"), "PATH")
    env[path_key] = os.pathsep.join([str(lay["bin"]), env.get(path_key, "")]).rstrip(os.pathsep)
    env.update(extra or {})
    return env


def write_sbx_shims(bin_dir: Path, *, python: str | None = None) -> list[Path]:
    """``sbx`` / ``sbx.cmd`` in the run's ``bin``: the broker client, by path
    (``-I``: nothing from the working directory is imported)."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    py = python or sys.executable
    client = Path(__file__).resolve().with_name("client.py")
    sh = bin_dir / "sbx"
    sh.write_text(f'#!/bin/sh\nexec "{py}" -I "{client}" "$@"\n', encoding="utf-8")
    try:
        sh.chmod(0o755)
    except OSError:
        pass
    cmd = bin_dir / "sbx.cmd"
    cmd.write_text(f'@"{py}" -I "{client}" %*\r\n', encoding="utf-8")
    return [sh, cmd]


def default_readable() -> list[str]:
    """What every sandboxed run needs to read: this interpreter (venv and its
    base install) and the ``factory`` package source. Not the factory root:
    its ``.env`` and ``state/`` stay out."""
    paths = {sys.prefix, sys.base_prefix, str(Path(__file__).resolve().parents[1])}
    extra = os.environ.get("SANDBOX_READ_PATHS", "")
    paths.update(p for p in extra.split(os.pathsep) if p.strip())
    return sorted(str(Path(p)) for p in paths)
