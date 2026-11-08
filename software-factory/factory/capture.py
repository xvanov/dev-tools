"""Per-thread stdout/stderr capture, so ``factory serve`` can run CLI calls concurrently.

The CLI writes its one JSON object to ``sys.stdout`` and diverts everything
else to stderr with ``contextlib.redirect_stdout`` — a PROCESS-WIDE swap. Two
threads doing that at once corrupt each other's output, and can leave
``sys.stdout`` permanently swapped (each restores what it saw on entry). So:

* :func:`install` replaces ``sys.stdout``/``sys.stderr`` once with routers that
  write to the calling thread's buffer when it is capturing, else to the real
  stream;
* :func:`capture` gives the calling thread its own stdout/stderr buffers;
* :func:`stdout_to_stderr` is what CLI code uses instead of
  ``redirect_stdout(sys.stderr)``: thread-local while capturing, the usual
  global redirect otherwise (a plain ``factory`` CLI run is unchanged).
"""

from __future__ import annotations

import contextlib
import io
import sys
import threading
from collections.abc import Iterator
from typing import Any, TextIO

_local = threading.local()
_install_lock = threading.Lock()


class _Router(io.TextIOBase):
    def __init__(self, name: str, real: TextIO) -> None:
        self._name = name
        self._real = real

    def _target(self) -> TextIO:
        return getattr(_local, self._name, None) or self._real

    def write(self, s: str) -> int:
        return self._target().write(s)

    def flush(self) -> None:
        self._target().flush()

    def isatty(self) -> bool:
        # Always False: click (typer.echo) resolves a console/binary wrapper for
        # a tty and CACHES it per stream object; for this long-lived router that
        # wrapper would write to the real console forever, bypassing capture.
        return False

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return getattr(self._real, "encoding", "utf-8") or "utf-8"

    def fileno(self) -> int:
        # No file descriptor: on Windows click (typer.echo) detects a console
        # by fileno() + GetConsoleMode and then writes to the console handle
        # directly, around the router (seen live under serve: `app list --json`
        # came back with an empty stdout).
        raise io.UnsupportedOperation("fileno")

    def __getattr__(self, name: str) -> Any:
        # No binary buffer: click would wrap the REAL stream's buffer and write
        # around the router. (A property raising AttributeError would land here.)
        if name == "buffer":
            raise AttributeError(name)
        return getattr(self._real, name)


def install() -> None:
    """Route sys.stdout/sys.stderr per thread (idempotent)."""
    with _install_lock:
        if not isinstance(sys.stdout, _Router):
            sys.stdout = _Router("stdout", sys.stdout)
        if not isinstance(sys.stderr, _Router):
            sys.stderr = _Router("stderr", sys.stderr)


def capturing() -> bool:
    return getattr(_local, "stdout", None) is not None


@contextlib.contextmanager
def capture() -> Iterator[tuple[io.StringIO, io.StringIO]]:
    """This thread's stdout/stderr go to two fresh buffers for the block."""
    install()
    out, err = io.StringIO(), io.StringIO()
    prev = (getattr(_local, "stdout", None), getattr(_local, "stderr", None))
    _local.stdout, _local.stderr = out, err
    try:
        yield out, err
    finally:
        _local.stdout, _local.stderr = prev


@contextlib.contextmanager
def stdout_to_stderr() -> Iterator[None]:
    """``redirect_stdout(sys.stderr)``, but only for this thread when capturing."""
    if not capturing():
        with contextlib.redirect_stdout(sys.stderr):
            yield
        return
    prev = _local.stdout
    _local.stdout = _local.stderr
    try:
        yield
    finally:
        _local.stdout = prev


__all__ = ["capture", "capturing", "install", "stdout_to_stderr"]
