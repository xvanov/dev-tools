"""Provider keys from the OS keychain, falling back to ``.env``.

The personal assistant (``personal-assistant/src/secrets``) keeps secrets in
the OS keychain, labelled by stack: Windows Credential Manager resource
``dev-tools/<stack>``, Linux Secret Service ``service=dev-tools stack=<stack>
name=<NAME>``; older entries live under ``personal-assistant``. The factory
reads its keys from the same place, so ``pa secrets migrate --from-env`` can
empty ``software-factory/.env`` and nothing here changes.

Order, per key: a real environment variable (non-empty) wins, then the
``.env`` file (``python-dotenv``, ``override=False``), then the keychain. A
key already set is never asked of the keychain, so a machine with a full
``.env`` pays nothing. Everything here is best effort: no keychain, a locked
one, a timeout and an unknown platform all mean "not found", never an
exception: the factory runs headless on boxes with no session bus.

``FACTORY_KEYCHAIN=0`` turns the lookup off. Values are written into
``os.environ`` and nowhere else: they are never logged or returned.

:func:`load_dotenv` is a drop-in for ``dotenv.load_dotenv`` that also fills
from the keychain (once per process), so call sites only change their import.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Iterable, Mapping, MutableMapping
from pathlib import Path
from typing import Any

from dotenv import load_dotenv as _dotenv_load

_LEGACY = "personal-assistant"
_TIMEOUT_S = 15
_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
_SECRET_RE = re.compile(r"(KEY|TOKEN|SECRET)$")

# What the factory may read from the keychain when ``.env.example`` is not at
# hand: the providers' keys.
_FALLBACK_NAMES = (
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "AZURE_API_KEY",
    "AZURE_FOUNDRY_API_KEY",
    "AZURE_OPENAI_API_KEY",
)

Runner = Callable[[list[str], str | None], "subprocess.CompletedProcess[str] | None"]

_loaded = False


def stack(env: Mapping[str, str] | None = None, platform: str | None = None) -> str:
    """'work' (the Windows laptop) or 'personal' (Linux); ``PA_STACK`` overrides."""
    e = os.environ if env is None else env
    v = (e.get("PA_STACK") or "").strip().lower()
    if v in ("work", "personal"):
        return v
    return "work" if (platform or sys.platform) == "win32" else "personal"


def known_names(example: Path | None = None) -> list[str]:
    """Secret-shaped names ``.env.example`` declares (commented or not)."""
    path = example or Path(__file__).resolve().parent.parent / ".env.example"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return list(_FALLBACK_NAMES)
    found: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^\s*#?\s*([A-Z][A-Z0-9_]+)\s*(?:=.*)?$", line)
        if m and _NAME_RE.match(m.group(1)) and _SECRET_RE.search(m.group(1)) and m.group(1) not in found:
            found.append(m.group(1))
    return found or list(_FALLBACK_NAMES)


# ---------------------------------------------------------------- backends --

# One Windows PowerShell process answers for every name: the request (names,
# resources) is a base64 JSON line on stdin, so no name can break out of the
# script, and nothing secret is ever on a command line.
_WIN_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $line = [Console]::In.ReadLine()
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
  $out = @{}
  foreach ($name in @($req.names)) {
    foreach ($r in @($req.resources)) {
      try { $c = $vault.Retrieve($r, $name); $c.RetrievePassword(); $out[$name] = $c.Password; break } catch {}
    }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
} catch { [Console]::Out.WriteLine('{}') }
"""


def _run(cmd: list[str], stdin: str | None) -> "subprocess.CompletedProcess[str] | None":
    try:
        return subprocess.run(  # noqa: S603 - fixed argv, value-free
            cmd,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _windows(names: list[str], st: str, run: Runner) -> dict[str, str]:
    encoded = base64.b64encode(_WIN_SCRIPT.encode("utf-16-le")).decode("ascii")
    request = json.dumps({"names": names, "resources": [f"dev-tools/{st}", _LEGACY]})
    r = run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        base64.b64encode(request.encode("utf-8")).decode("ascii") + "\n",
    )
    if r is None or r.returncode != 0:
        return {}
    last = (r.stdout or "").strip().splitlines()[-1:] or ["{}"]
    try:
        data = json.loads(last[0])
    except ValueError:
        return {}
    return {k: str(v) for k, v in data.items() if k in names and v} if isinstance(data, dict) else {}


def _linux(names: list[str], st: str, run: Runner, env: Mapping[str, str]) -> dict[str, str]:
    if not shutil.which("secret-tool") or not (env.get("DBUS_SESSION_BUS_ADDRESS") or env.get("XDG_RUNTIME_DIR")):
        return {}
    out: dict[str, str] = {}
    for name in names:
        for attrs in (
            ["service", "dev-tools", "stack", st, "name", name],
            ["service", _LEGACY, "name", name],
        ):
            r = run(["secret-tool", "lookup", *attrs], None)
            if r is None:
                return out  # a hung or missing tool: stop asking
            if r.returncode == 0 and r.stdout:
                out[name] = r.stdout.rstrip("\r\n")
                break
    return out


def fill(
    names: Iterable[str] | None = None,
    env: MutableMapping[str, str] | None = None,
    platform: str | None = None,
    run: Runner | None = None,
) -> list[str]:
    """Sets each unset name from the keychain; returns the names it set (never values)."""
    target: Any = os.environ if env is None else env
    if (target.get("FACTORY_KEYCHAIN") or "").strip() == "0":
        return []
    wanted = [n for n in (names if names is not None else known_names()) if _NAME_RE.match(n) and not (target.get(n) or "").strip()]
    if not wanted:
        return []
    plat = platform or sys.platform
    runner = run or _run
    st = stack(target, plat)
    if plat == "win32":
        found = _windows(wanted, st, runner)
    elif plat.startswith("linux"):
        found = _linux(wanted, st, runner, target)
    else:
        found = {}
    for name, value in found.items():
        target[name] = value
    return sorted(found)


def load_dotenv(*args: Any, **kwargs: Any) -> bool:
    """``dotenv.load_dotenv``, then the keychain for what is still unset (once per process)."""
    global _loaded
    ok = _dotenv_load(*args, **kwargs)
    # The bare ``load_dotenv()`` (a .env found from the cwd) is followed by the
    # factory's own ``load_dotenv(<root>/.env)``; the keychain is asked after
    # that one, so a ``.env`` value always beats it.
    if (args or "dotenv_path" in kwargs) and not _loaded and os.environ.get("PYTEST_CURRENT_TEST") is None:
        _loaded = True
        fill()
    return ok
