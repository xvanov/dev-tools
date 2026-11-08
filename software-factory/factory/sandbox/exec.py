"""Start one process inside the OS sandbox described by a :class:`Policy`.

    python -I -m factory.sandbox.exec run --policy policy.json -- argv...
    python -I -m factory.sandbox.exec setup --grant-read DIR... --deny-read DIR...

**Linux: bubblewrap.** New user, PID, IPC, UTS and network namespaces (only
``lo``; the egress proxy and the broker are reached through unix sockets that
:mod:`factory.sandbox.inner` relays to loopback). The host filesystem is
mounted read-only, with ``/home``, ``/root``, ``/run`` and ``/tmp`` replaced by
empty tmpfs, so the operator's ``~/.ssh``, ``~/.config/gh``, keyrings, the
D-Bus session and every ``.env`` under ``/home`` are absent. The run's workdir
and home are bound read-write; the interpreter and the ``factory`` package
read-only. ``--die-with-parent``: killing the launcher kills the sandbox.

**Windows: a restricted, low-integrity token in a job object.** The token is
the operator's with Administrators deny-only, every privilege but traverse
dropped, a second access check against a short list of restricting SIDs
(Everyone, Users, RESTRICTED, the logon session, the per-run SID and the
fixed sandbox SID), and Low integrity. So the process can read what any
local user can (``C:\\Windows``, ``Program Files``), cannot read the
operator's profile (``%USERPROFILE%``: SSH keys, gh's login, ``.claude``),
cannot reach the Credential Vault, and can write only where the run's
directories were granted to its run SID and labelled Low. The job kills the
whole tree when the launcher goes. Two limits, both said out loud:

* Directories any local user can read are readable (``C:\\repos`` inherits
  ``Users: RX`` from ``C:\\``). ``setup --deny-read C:\\repos`` adds an
  inherited deny for the sandbox SID there (the run's own worktree keeps its
  protected ACL); it changes ACLs outside this repo, so it is an operator step.
* Egress is not enforced: the process is pointed at the allowlist proxy
  (``HTTPS_PROXY``) but a raw socket is not stopped. Enforcing it needs a
  firewall rule or a separate account, both admin steps (``docs`` of 5.2).
"""

from __future__ import annotations

import argparse
import os
import posixpath
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

from factory.sandbox.policy import Policy

#: Present in every sandbox token: tool directories are granted to it, and the
#: operator's ``setup --deny-read`` roots deny it. icacls can map it (it is a
#: logon-session-style SID, ``LogonSessionId_7726_1``); no real session uses
#: a non-zero first sub-authority.
SANDBOX_SID = "S-1-5-5-7726-1"
_LOW_IL = "S-1-16-4096"


def new_run_sid() -> str:
    """A fresh per-run SID (Windows): its run's directories are granted to it."""
    return f"S-1-5-5-7726-{1000 + secrets.randbelow(2**31 - 1000)}"


# --- Linux ------------------------------------------------------------------


def bwrap_argv(
    policy: Policy, cmd: list[str], *, python: str | None = None, bwrap: str = "bwrap"
) -> list[str]:
    """The full ``bwrap`` command line for ``cmd`` under ``policy``. Pure."""
    py = python or sys.executable
    inner = str(Path(__file__).resolve().with_name("inner.py"))
    argv = [
        bwrap,
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
    ]
    for hidden in ("/tmp", "/var/tmp", "/run", "/home", "/root"):
        argv += ["--tmpfs", hidden]
    for p in policy.readable:
        if os.path.exists(p):
            argv += ["--ro-bind", p, p]
    sock_dirs = sorted({posixpath.dirname(t) for t in policy.relays.values()})
    for p in [policy.workdir, policy.home, *policy.writable, *sock_dirs]:
        argv += ["--bind", p, p]
    argv += ["--chdir", policy.workdir, "--clearenv"]
    for k, v in sorted(policy.env.items()):
        argv += ["--setenv", k, v]
    argv += [py, "-I", inner]
    for listen, target in sorted(policy.relays.items()):
        argv += ["--relay", f"{listen}={target}"]
    return [*argv, "--", *cmd]


def run_linux(policy: Policy, cmd: list[str]) -> int:
    bwrap = shutil.which("bwrap")
    if not bwrap:
        print("sandbox: bubblewrap (bwrap) is not installed", file=sys.stderr)
        return 125
    argv = bwrap_argv(policy, cmd, bwrap=bwrap)
    os.execv(bwrap, argv)  # noqa: S606 - replaces this launcher
    return 125  # pragma: no cover


# --- Windows ----------------------------------------------------------------


def _icacls(*args: str) -> None:
    r = subprocess.run(["icacls", *args], capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise OSError(f"icacls {' '.join(args)}: {(r.stdout + r.stderr).strip()[-300:]}")


def grant_read(path: str | Path, sid: str = SANDBOX_SID) -> None:
    """Let sandboxed processes read (and run) ``path`` and below. Adds one
    inheritable ACE; existing ACEs are untouched."""
    _icacls(str(path), "/grant", f"*{sid}:(OI)(CI)RX", "/C", "/Q")


def deny_read(path: str | Path, sid: str = SANDBOX_SID) -> None:
    """Make ``path`` and below unreadable to every sandbox (an operator step)."""
    _icacls(str(path), "/deny", f"*{sid}:(OI)(CI)R", "/C", "/Q")


def protect_dir(path: str | Path) -> None:
    """The operator and SYSTEM only, inherited below: a run's state dir (its
    policy holds the broker capability; no sandbox, this run's or another's,
    may read it). Its ``home`` inside is then granted to the run by
    :func:`prepare_dir`."""
    _set_sddl(path, f"D:P(A;OICI;FA;;;{_current_user_sid()})(A;OICI;FA;;;SY)", label=False)


def prepare_dir(path: str | Path, run_sid: str) -> None:
    """Make ``path`` the run's: a protected DACL (the operator, SYSTEM and the
    run SID, full control, inherited by everything below) and a Low integrity
    label, so the sandboxed process may write there and nowhere else. Removes
    inherited ``Users``/``Authenticated Users`` access, so other runs cannot
    read it either."""
    user = _current_user_sid()
    _set_sddl(
        path,
        f"D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;{run_sid})S:(ML;OICI;NW;;;LW)",
        label=True,
    )


def _set_sddl(path: str | Path, sddl: str, *, label: bool) -> None:
    """Replace ``path``'s DACL (protected; children inherit) and, with
    ``label``, its integrity label. Windows only; a no-op elsewhere."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    psd = ctypes.c_void_p()
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p,
    ]
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, 1, ctypes.byref(psd), None
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    present, defaulted = wintypes.BOOL(), wintypes.BOOL()
    dacl, sacl = ctypes.c_void_p(), ctypes.c_void_p()
    for fn, out in ((adv.GetSecurityDescriptorDacl, dacl), (adv.GetSecurityDescriptorSacl, sacl)):
        fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        if not fn(psd, ctypes.byref(present), ctypes.byref(out), ctypes.byref(defaulted)):
            raise ctypes.WinError(ctypes.get_last_error())
    adv.SetNamedSecurityInfoW.argtypes = [
        wintypes.LPWSTR,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    dacl_info, protected, label_info = 0x4, 0x80000000, 0x10
    flags = dacl_info | protected | (label_info if label else 0)
    err = adv.SetNamedSecurityInfoW(
        str(path), 1, flags, None, None, dacl, sacl if label else None
    )
    ctypes.WinDLL("kernel32").LocalFree(psd)
    if err:
        raise ctypes.WinError(err)


def _current_user_sid() -> str:
    out = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True
    )
    return out.stdout.strip().split(",")[-1].strip('"')


def _logon_sid() -> str | None:
    out = subprocess.run(["whoami", "/logonid"], capture_output=True, text=True, check=False)
    sid = out.stdout.strip()
    return sid if sid.startswith("S-1-5-5-") else None


def run_windows(policy: Policy, cmd: list[str]) -> int:  # pragma: no cover - Windows only
    if sys.platform != "win32":
        raise OSError("run_windows is Windows only")
    import ctypes
    import msvcrt
    from ctypes import wintypes as w

    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    h = w.HANDLE
    vp = ctypes.c_void_p
    k32.GetCurrentProcess.restype = h
    adv.OpenProcessToken.argtypes = [h, w.DWORD, vp]
    adv.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, vp]
    adv.CreateRestrictedToken.argtypes = [h, w.DWORD, w.DWORD, vp, w.DWORD, vp, w.DWORD, vp, vp]
    adv.SetTokenInformation.argtypes = [h, ctypes.c_int, vp, w.DWORD]
    adv.CreateProcessAsUserW.argtypes = [
        h,
        w.LPCWSTR,
        ctypes.c_wchar_p,
        vp,
        vp,
        w.BOOL,
        w.DWORD,
        vp,
        w.LPCWSTR,
        vp,
        vp,
    ]
    k32.CreateJobObjectW.restype = h
    k32.CreateJobObjectW.argtypes = [vp, w.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [h, ctypes.c_int, vp, w.DWORD]
    k32.AssignProcessToJobObject.argtypes = [h, h]
    k32.ResumeThread.argtypes = [h]
    k32.WaitForSingleObject.argtypes = [h, w.DWORD]
    k32.GetExitCodeProcess.argtypes = [h, vp]
    k32.SetHandleInformation.argtypes = [h, w.DWORD, w.DWORD]

    class SidAndAttributes(ctypes.Structure):
        _fields_ = [("Sid", vp), ("Attributes", w.DWORD)]

    def sid(s: str) -> ctypes.c_void_p:
        p = vp()
        if not adv.ConvertStringSidToSidW(s, ctypes.byref(p)):
            raise ctypes.WinError(ctypes.get_last_error())
        return p

    tok = h()
    if not adv.OpenProcessToken(k32.GetCurrentProcess(), 0xF01FF, ctypes.byref(tok)):
        raise ctypes.WinError(ctypes.get_last_error())
    restrict = ["S-1-1-0", "S-1-5-32-545", "S-1-5-12", SANDBOX_SID]
    if policy.run_sid:
        restrict.append(policy.run_sid)
    logon = _logon_sid()
    if logon:  # console and named objects of the session are granted to it
        restrict.append(logon)
    rs = (SidAndAttributes * len(restrict))(*[SidAndAttributes(sid(s), 0) for s in restrict])
    deny = (SidAndAttributes * 1)(SidAndAttributes(sid("S-1-5-32-544"), 0))
    new = h()
    disable_max_privilege = 0x1
    if not adv.CreateRestrictedToken(
        tok, disable_max_privilege, 1, deny, 0, None, len(restrict), rs, ctypes.byref(new)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    label = SidAndAttributes(sid(_LOW_IL), 0x20)  # SE_GROUP_INTEGRITY
    if not adv.SetTokenInformation(new, 25, ctypes.byref(label), ctypes.sizeof(label) + 64):
        raise ctypes.WinError(ctypes.get_last_error())

    class IoCounters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

    class BasicLimit(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", w.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", w.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", w.DWORD),
            ("SchedulingClass", w.DWORD),
        ]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [
            ("Basic", BasicLimit),
            ("Io", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    job = k32.CreateJobObjectW(None, None)
    lim = ExtendedLimit()
    lim.Basic.LimitFlags = 0x2000 | 0x400  # KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION
    if not k32.SetInformationJobObject(job, 9, ctypes.byref(lim), ctypes.sizeof(lim)):
        raise ctypes.WinError(ctypes.get_last_error())

    class StartupInfo(ctypes.Structure):
        _fields_ = [
            ("cb", w.DWORD),
            ("lpReserved", w.LPWSTR),
            ("lpDesktop", w.LPWSTR),
            ("lpTitle", w.LPWSTR),
            ("dwX", w.DWORD),
            ("dwY", w.DWORD),
            ("dwXSize", w.DWORD),
            ("dwYSize", w.DWORD),
            ("dwXCountChars", w.DWORD),
            ("dwYCountChars", w.DWORD),
            ("dwFillAttribute", w.DWORD),
            ("dwFlags", w.DWORD),
            ("wShowWindow", w.WORD),
            ("cbReserved2", w.WORD),
            ("lpReserved2", vp),
            ("hStdInput", h),
            ("hStdOutput", h),
            ("hStdError", h),
        ]

    class ProcInfo(ctypes.Structure):
        _fields_ = [
            ("hProcess", h),
            ("hThread", h),
            ("dwProcessId", w.DWORD),
            ("dwThreadId", w.DWORD),
        ]

    si = StartupInfo()
    si.cb = ctypes.sizeof(si)
    si.dwFlags = 0x100  # STARTF_USESTDHANDLES
    std = []
    for fd in (0, 1, 2):
        try:
            hd = msvcrt.get_osfhandle(fd)
            k32.SetHandleInformation(hd, 1, 1)  # HANDLE_FLAG_INHERIT
        except OSError:
            hd = None
        std.append(hd)
    si.hStdInput, si.hStdOutput, si.hStdError = std
    env_path = next((v for k, v in policy.env.items() if k.upper() == "PATH"), None)
    exe = shutil.which(cmd[0], path=env_path) or cmd[0]
    if os.path.basename(exe).lower() in ("cmd", "cmd.exe"):
        # cmd.exe does not parse MSVC-style \" escapes: pass its arguments raw,
        # as subprocess does for shell=True.
        cmdline = subprocess.list2cmdline([exe]) + " " + " ".join(cmd[1:])
    else:
        cmdline = subprocess.list2cmdline([exe, *cmd[1:]])
    block = "".join(f"{k}={v}\0" for k, v in policy.env.items()) + "\0"
    pi = ProcInfo()
    flags = 0x4 | 0x400  # CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT
    if not adv.CreateProcessAsUserW(
        new,
        None,
        ctypes.create_unicode_buffer(cmdline),
        None,
        None,
        True,
        flags,
        ctypes.create_unicode_buffer(block, len(block)),
        policy.workdir,
        ctypes.byref(si),
        ctypes.byref(pi),
    ):
        err = ctypes.get_last_error()
        print(f"sandbox: cannot start {exe!r}: {ctypes.FormatError(err)}", file=sys.stderr)
        return 127
    k32.AssignProcessToJobObject(job, pi.hProcess)
    k32.ResumeThread(pi.hThread)
    k32.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF)
    code = w.DWORD()
    k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    return int(code.value)


def run(policy: Policy, cmd: list[str]) -> int:
    if sys.platform == "win32":
        return run_windows(policy, cmd)
    return run_linux(policy, cmd)


def wrap_argv(policy_path: Path, cmd: list[str], *, python: str | None = None) -> list[str]:
    """``cmd`` started inside the sandbox: the launcher's argv."""
    return [
        python or sys.executable,
        "-I",
        "-X",
        "utf8",
        "-m",
        "factory.sandbox.exec",
        "run",
        "--policy",
        str(policy_path),
        "--",
        *cmd,
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m factory.sandbox.exec")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--policy", required=True)
    r.add_argument("argv", nargs=argparse.REMAINDER)
    s = sub.add_parser("setup", help="Windows, operator step: tool reads and denied roots")
    s.add_argument("--grant-read", nargs="*", default=[])
    s.add_argument("--deny-read", nargs="*", default=[])
    a = ap.parse_args(argv)
    if a.cmd == "setup":
        for p in a.grant_read:
            grant_read(p)
        for p in a.deny_read:
            deny_read(p)
        return 0
    cmd = a.argv[1:] if a.argv[:1] == ["--"] else a.argv
    if not cmd:
        ap.error("no command after --")
    return run(Policy.load(Path(a.policy)), cmd)


if __name__ == "__main__":
    sys.exit(main())
