"""Portable process and file-lock primitives (POSIX and native Windows).

The factory grew up on Linux: ``fcntl.flock`` for cross-process locks,
``os.killpg`` for process-tree teardown, ``os.kill(pid, 0)`` for liveness. None
of those exist on Windows, and one is actively dangerous there:
``os.kill(pid, 0)`` calls ``TerminateProcess(pid, 0)``, so a liveness probe
KILLS the process it asks about. Everything that needs one of these goes
through this module instead.

Semantics kept identical on both OSes:

* :func:`lock_file` is an exclusive advisory lock on an open file, released by
  :func:`unlock_file`, by closing the handle, or by the process dying (no stale
  lock after a crash). POSIX: ``flock``. Windows: ``LockFileEx`` on one byte at
  an offset far past any real data, so the lock never blocks reads or writes of
  the file's contents (``msvcrt.locking`` locks byte 0 and would).
* :func:`pid_alive` never signals the process.
* :func:`kill_tree` stops a process and its descendants. POSIX: ``killpg`` of
  the group a :func:`detached_popen_kwargs` child leads. Windows: ``taskkill
  /T`` (``/F`` when forced), since Windows has no process groups to signal.

Branches test ``sys.platform`` literally so mypy checks each OS's half on that OS.
"""

from __future__ import annotations

import os
import subprocess
import sys
from typing import IO, Any

IS_WINDOWS = sys.platform == "win32"

if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _OVERLAPPED(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_size_t),
            ("InternalHigh", ctypes.c_size_t),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

    _LockFileEx = _kernel32.LockFileEx
    _LockFileEx.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(_OVERLAPPED),
    ]
    _LockFileEx.restype = wintypes.BOOL
    _UnlockFileEx = _kernel32.UnlockFileEx
    _UnlockFileEx.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(_OVERLAPPED),
    ]
    _UnlockFileEx.restype = wintypes.BOOL
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL

    _LOCKFILE_FAIL_IMMEDIATELY = 0x1
    _LOCKFILE_EXCLUSIVE_LOCK = 0x2
    _ERROR_LOCK_VIOLATION = 33
    _ERROR_IO_PENDING = 997
    _ERROR_ACCESS_DENIED = 5
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _STILL_ACTIVE = 259
    # Lock one byte at 2**62: far beyond any data, so reads/writes are never
    # blocked by the (mandatory, on Windows) byte-range lock.
    _LOCK_OFFSET_HIGH = 0x40000000

    def _overlapped() -> _OVERLAPPED:
        ov = _OVERLAPPED()
        ov.Offset = 0
        ov.OffsetHigh = _LOCK_OFFSET_HIGH
        return ov

    def _os_handle(fileobj: IO[Any] | int) -> int:
        fd = fileobj if isinstance(fileobj, int) else fileobj.fileno()
        return int(msvcrt.get_osfhandle(fd))


def _fd(fileobj: IO[Any] | int) -> int:
    return fileobj if isinstance(fileobj, int) else fileobj.fileno()


# --------------------------------------------------------------------------- #
# File locks
# --------------------------------------------------------------------------- #


def lock_file(fileobj: IO[Any] | int, *, blocking: bool = True) -> None:
    """Take an exclusive lock on ``fileobj`` (a file object or fd).

    Blocks until held when ``blocking``; otherwise raises ``BlockingIOError``
    when another holder has it.
    """
    if sys.platform == "win32":  # pragma: no cover - Windows only
        flags = _LOCKFILE_EXCLUSIVE_LOCK | (0 if blocking else _LOCKFILE_FAIL_IMMEDIATELY)
        ov = _overlapped()
        if not _LockFileEx(_os_handle(fileobj), flags, 0, 1, 0, ctypes.byref(ov)):
            err = ctypes.get_last_error()
            if err in (_ERROR_LOCK_VIOLATION, _ERROR_IO_PENDING):
                raise BlockingIOError(err, "file is locked by another holder")
            raise OSError(err, ctypes.FormatError(err))
    else:
        import fcntl

        fcntl.flock(_fd(fileobj), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def unlock_file(fileobj: IO[Any] | int) -> None:
    """Release a lock taken by :func:`lock_file`. Never raises."""
    try:
        if sys.platform == "win32":  # pragma: no cover - Windows only
            ov = _overlapped()
            _UnlockFileEx(_os_handle(fileobj), 0, 1, 0, ctypes.byref(ov))
        else:
            import fcntl

            fcntl.flock(_fd(fileobj), fcntl.LOCK_UN)
    except (OSError, ValueError):
        pass


# --------------------------------------------------------------------------- #
# Processes
# --------------------------------------------------------------------------- #


def pid_alive(pid: int) -> bool:
    """Is ``pid`` a running process? Never signals or stops it."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":  # pragma: no cover - Windows only
        handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            # Exists but not ours to query -> alive; anything else -> gone.
            return bool(ctypes.get_last_error() == _ERROR_ACCESS_DENIED)
        try:
            code = wintypes.DWORD()
            if not _kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return bool(code.value == _STILL_ACTIVE)
        finally:
            _kernel32.CloseHandle(handle)
    else:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True  # exists, owned by another uid
        except OSError:
            return False
        return True


def detached_popen_kwargs() -> dict[str, Any]:
    """``Popen`` kwargs that make the child the root of its own killable tree.

    POSIX: a new session (the child leads its own process group, so
    :func:`kill_tree` reaches every descendant with one ``killpg``).
    Windows: a new process group with no console window.
    """
    if sys.platform == "win32":  # pragma: no cover - Windows only
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def process_group_of(pid: int) -> int:
    """The id :func:`kill_tree` takes for a child started with
    :func:`detached_popen_kwargs`: its pgid on POSIX, its pid on Windows."""
    if sys.platform == "win32":  # pragma: no cover - Windows only
        return int(pid)
    else:
        try:
            return int(os.getpgid(pid))
        except OSError:
            return int(pid)


def kill_tree(pgid: int, *, force: bool = False) -> bool:
    """Stop the tree rooted at ``pgid`` (see :func:`process_group_of`).

    ``force=False`` asks politely (SIGTERM / ``taskkill /T``), ``force=True``
    does not (SIGKILL / ``taskkill /T /F``). Returns whether a signal was
    delivered. Never raises.
    """
    try:
        pgid = int(pgid)
    except (TypeError, ValueError):
        return False
    if pgid <= 0:
        return False
    if sys.platform == "win32":  # pragma: no cover - Windows only
        # Console processes ignore taskkill's polite WM_CLOSE; a "polite" stop
        # of a console tree is therefore usually a no-op and the caller's grace
        # period ends in the forced kill, exactly as SIGTERM-ignored would.
        argv = ["taskkill", "/PID", str(pgid), "/T"] + (["/F"] if force else [])
        try:
            proc = subprocess.run(
                argv, capture_output=True, timeout=30, check=False,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        # /T reports failure when any member of the tree exited mid-kill; what
        # matters is whether the root is gone (or at least was signalled).
        return proc.returncode == 0 or (force and not pid_alive(pgid))
    else:
        import signal

        try:
            os.killpg(pgid, signal.SIGKILL if force else signal.SIGTERM)
            return True
        except OSError:
            return False


def group_alive(pgid: int) -> bool:
    """Does any process of the tree rooted at ``pgid`` still run?"""
    if sys.platform == "win32":  # pragma: no cover - Windows only
        return pid_alive(pgid)
    else:
        try:
            os.killpg(pgid, 0)
            return True
        except OSError:
            return False


#: NTSTATUS a Windows process exits with when a DLL's initialisation failed in
#: the loader, before any of the program's own code ran. Seen from ``git``
#: under a starved machine (docs/WINDOWS.md); it did nothing, so a retry is safe.
STATUS_DLL_INIT_FAILED = 0xC0000142


def failed_to_start(returncode: int | None) -> bool:
    """Did the process die in the Windows loader (``STATUS_DLL_INIT_FAILED``)?

    Never true on POSIX, whose exit codes are 0-255 (negative for signals).
    """
    return returncode is not None and (returncode & 0xFFFFFFFF) == STATUS_DLL_INIT_FAILED


#: Variables a Windows process cannot run without (CPython's ``os.urandom``
#: needs SYSTEMROOT; ``cmd /c`` needs COMSPEC; most tools need TEMP and the
#: profile dirs). An env allow-list built for POSIX (PATH, HOME, LANG) drops
#: them all, so allow-list builders add these on Windows. OS plumbing, not
#: config, and no secrets.
WINDOWS_ESSENTIAL_ENV: tuple[str, ...] = (
    "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
)


def essential_env(environ: dict[str, str] | None = None) -> dict[str, str]:
    """The OS-essential variables from ``environ`` (empty on POSIX)."""
    if not IS_WINDOWS:
        return {}
    src = os.environ if environ is None else environ
    return {k: src[k] for k in WINDOWS_ESSENTIAL_ENV if k in src}


__all__ = [
    "IS_WINDOWS",
    "STATUS_DLL_INIT_FAILED",
    "WINDOWS_ESSENTIAL_ENV",
    "detached_popen_kwargs",
    "essential_env",
    "failed_to_start",
    "group_alive",
    "kill_tree",
    "lock_file",
    "pid_alive",
    "process_group_of",
    "unlock_file",
]
