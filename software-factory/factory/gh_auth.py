"""Per-owner GitHub credential resolution (standalone: stdlib only).

One machine can hold several ``gh`` accounts (e.g. a personal one and a work
one) and the *active* account must never be switched at runtime. This module
picks the token by the **owner of the repo** being touched.

Resolution for ``token_for_repo("owner/name")``:

  1. ``FACTORY_GITHUB_TOKEN`` - explicit operator override. Wins for every
     repo. Use it for CI / PAT deployments where there is no ``gh`` login.
  2. Owner is in the owner map -> ``gh auth token --user <gh-user>``. If that
     lookup fails, fall back to the ambient ``GITHUB_TOKEN`` / ``GH_TOKEN``
     env, else ``None``. It never silently falls back to the active account:
     acting as the wrong identity is worse than failing.
  3. Owner not in the map -> ambient ``GITHUB_TOKEN`` / ``GH_TOKEN`` env, else
     ``gh auth token`` (the active account).

Why ambient env tokens rank *below* the owner map for mapped owners: a stray
``GH_TOKEN`` exported in a shell belongs to whichever identity that shell was
for, so it cannot be trusted to match the repo. Only the dedicated
``FACTORY_GITHUB_TOKEN`` is an unambiguous override.

Owner map: ``FACTORY_GH_OWNER_MAP="owner=gh-user,owner2=gh-user2"``. The
built-in default is ``xvanov=xvanov``; entries in the env var add to or
replace it (``owner=`` with an empty user removes a default entry). Company
owners are configured only through this env var, never in the repo.

This file imports nothing from the ``factory`` package so the ``bin/gh`` shim
can load it by path without paying for (or depending on) package import.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_OWNER_MAP = {"xvanov": "xvanov"}
_TIMEOUT_S = 10
_REPO_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9._-]+)$")
_REMOTE_RE = re.compile(
    r"(?:github\.com|github-[A-Za-z0-9_.-]+)[:/]+([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/?$"
)


def owner_map() -> dict[str, str]:
    """Return the owner(lowercase) -> gh-user map (default + env)."""
    m = {k.lower(): v for k, v in DEFAULT_OWNER_MAP.items()}
    for part in os.environ.get("FACTORY_GH_OWNER_MAP", "").split(","):
        owner, sep, user = part.partition("=")
        owner, user = owner.strip().lower(), user.strip()
        if not sep or not owner:
            continue
        if user:
            m[owner] = user
        else:
            m.pop(owner, None)
    return m


def repo_owner(repo: str | None) -> str | None:
    """Owner part of ``owner/name`` (also accepts ``host/owner/name``)."""
    if not repo:
        return None
    parts = repo.strip().split("/")
    if len(parts) == 3:
        parts = parts[1:]
    if len(parts) != 2 or not _REPO_RE.match("/".join(parts)):
        return None
    return parts[0]


def repo_from_remote_url(url: str) -> str | None:
    """``owner/name`` from an https / ssh / ssh-alias GitHub remote URL."""
    m = _REMOTE_RE.search(url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def repo_from_cwd(cwd: str | os.PathLike[str] | None = None) -> str | None:
    """``owner/name`` of ``origin`` for the git checkout at ``cwd``."""
    try:
        out = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            check=False,
            timeout=_TIMEOUT_S,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    return repo_from_remote_url(out.stdout) if out.returncode == 0 else None


def _gh_token(user: str | None, gh_bin: str = "gh") -> str | None:
    cmd = [gh_bin, "auth", "token"] + (["--user", user] if user else [])
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=_TIMEOUT_S
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout.strip() or None


def _env_token() -> str | None:
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        v = os.environ.get(name, "").strip()
        if v:
            return v
    return None


def token_for_repo(repo: str | None, gh_bin: str = "gh") -> str | None:
    """Token to use for ``repo`` (``owner/name``); see module docstring."""
    override = os.environ.get("FACTORY_GITHUB_TOKEN", "").strip()
    if override:
        return override
    owner = repo_owner(repo)
    user = owner_map().get(owner.lower()) if owner else None
    if user:
        return _gh_token(user, gh_bin) or _env_token()
    return _env_token() or _gh_token(None, gh_bin)


def is_pinned(repo: str | None) -> bool:
    """True when the token for ``repo`` must be injected (not the default)."""
    if os.environ.get("FACTORY_GITHUB_TOKEN", "").strip():
        return True
    owner = repo_owner(repo)
    return bool(owner and owner.lower() in owner_map())


def gh_env(repo: str | None, base: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for a ``gh`` subprocess touching ``repo``.

    Returns ``base`` (default ``os.environ``) copied, with ``GH_TOKEN`` set
    only when the repo's owner needs a specific identity. For other owners the
    environment is returned unchanged so ``gh`` uses its active account.
    """
    env = dict(os.environ if base is None else base)
    if is_pinned(repo):
        tok = token_for_repo(repo)
        if tok:
            env["GH_TOKEN"] = tok
            env.pop("GITHUB_TOKEN", None)
    return env


SKIP_VERBS = {"auth", "config", "extension", "alias", "completion", "version", "help"}


def repo_from_gh_args(args: list[str]) -> str | None:
    """Best-effort ``owner/name`` from ``gh`` args (after the ``gh`` word)."""
    for i, a in enumerate(args):
        if a in ("--repo", "-R") and i + 1 < len(args):
            return args[i + 1]
        if a.startswith("--repo="):
            return a.split("=", 1)[1]
    if args and args[0] == "api":
        for a in args[1:]:
            m = re.match(r"^/?repos/([^/]+/[^/?]+)", a)
            if m:
                return m.group(1)
    if args and args[0] == "repo":
        for a in args[2:]:
            if not a.startswith("-") and repo_owner(a):
                return a
    return None


def pinned_token_for_gh_args(
    args: list[str], cwd: str | os.PathLike[str] | None = None, gh_bin: str = "gh"
) -> str | None:
    """Token to inject for a ``gh`` invocation, or None to leave auth alone."""
    if not args or args[0].startswith("-") or args[0] in SKIP_VERBS:
        return None
    repo = repo_from_gh_args(args) or repo_from_cwd(cwd)
    if repo and is_pinned(repo):
        return token_for_repo(repo, gh_bin=gh_bin)
    return None


_hook_installed = False


def install_popen_hook() -> None:
    """Inject the per-owner ``GH_TOKEN`` into ``gh`` children, in-process.

    On Windows ``CreateProcess`` never resolves the extension-less ``bin/gh``
    shim, so the factory's own ``subprocess`` calls to ``gh`` are covered by
    wrapping ``subprocess.Popen.__init__`` instead. Only list-style commands
    whose first element is ``gh`` / ``gh.exe`` are touched; other callers and
    non-pinned owners are unaffected. Idempotent.
    """
    global _hook_installed
    if _hook_installed:
        return
    _hook_installed = True
    orig = subprocess.Popen.__init__

    def init(self, args, *a, **kw):  # type: ignore[no-untyped-def]
        try:
            if (
                isinstance(args, (list, tuple))
                and args
                and os.path.basename(str(args[0])).lower() in ("gh", "gh.exe")
                and not kw.get("shell")
            ):
                tok = pinned_token_for_gh_args([str(x) for x in args[1:]], kw.get("cwd"))
                if tok:
                    env = dict(kw["env"] if kw.get("env") is not None else os.environ)
                    env["GH_TOKEN"] = tok
                    env.pop("GITHUB_TOKEN", None)
                    kw["env"] = env
        except Exception:  # noqa: BLE001 - never break a gh call over the hook
            pass
        orig(self, args, *a, **kw)

    subprocess.Popen.__init__ = init  # type: ignore[method-assign]


def shim_dir() -> Path:
    """Directory holding the ``gh`` shim (``software-factory/bin``)."""
    return Path(__file__).resolve().parent.parent / "bin"


def install_shim_on_path() -> None:
    """Prepend the ``gh`` shim dir to ``PATH`` (idempotent, opt-out).

    Every ``gh`` the factory (or an agent session it spawns) runs then goes
    through ``bin/gh``, which picks the token by repo owner. Set
    ``FACTORY_GH_SHIM=0`` to disable.
    """
    if os.environ.get("FACTORY_GH_SHIM", "1") == "0":
        return
    if sys.platform == "win32":
        # The factory's own list-style subprocess calls never resolve gh.cmd
        # (CreateProcess only appends .exe), so hook Popen for those; shells
        # and agent sessions get bin\gh.cmd via PATH below.
        install_popen_hook()
        os.environ.setdefault("FACTORY_PYTHON", sys.executable)
    d = shim_dir()
    if not (d / "gh").is_file():
        return
    parts = os.environ.get("PATH", "").split(os.pathsep)
    if str(d) not in parts:
        os.environ["PATH"] = os.pathsep.join([str(d), *parts])
