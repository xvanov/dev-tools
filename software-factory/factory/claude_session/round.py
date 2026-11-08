"""``python -m factory.claude_session.round <spec.json>`` — one round, no shell.

The Windows form of the bash round script (:func:`launcher.build_round_script`).
Windows has no ``bash`` (``bash.exe`` on PATH is often the WSL shim, and the
factory must not depend on WSL), and PowerShell is no substitute for the
pipeline: Windows PowerShell 5.1 re-encodes native output line by line,
``Tee-Object`` writes UTF-16, and piping into a native stdin goes through
``$OutputEncoding``. Any of those corrupts ``stream-<n>.jsonl``. So the
pipeline is done here, byte-faithfully, and the shell only has to start one
program:

* writes this process's pid to ``pid-<n>`` (``kill`` stops the tree from here);
* ``cd`` to the run's working directory (failure → exit 97, as the bash script);
* runs ``claude`` with the API-key variables REMOVED (subscription billing),
  stdin from ``prompt-<n>.md``, stderr to ``stderr-<n>.log``;
* copies every stdout byte to ``stream-<n>.jsonl`` and renders each line for the
  human watching (the same renderer as ``factory.claude_session.pretty``);
* writes the exit code to ``exit-<n>`` atomically (tmp + replace) when it ends.

The spec (``round-<n>.json``) is written by :func:`launcher.build_round_script`.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

EXIT_CANNOT_CD = 97
EXIT_CANNOT_START = 127


def _write_exit(exit_path: Path, rc: int) -> None:
    tmp = exit_path.with_name(exit_path.name + ".tmp")
    tmp.write_text(f"{rc}\n", encoding="utf-8")
    os.replace(tmp, exit_path)


def _say(text: str) -> None:
    try:
        print(text, flush=True)
    except Exception:  # noqa: BLE001 - the terminal is for humans; never die on it
        pass


def _setup_stdout() -> None:
    try:
        if sys.stdout.isatty():
            sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
        else:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass


def run_round(spec: dict[str, Any]) -> int:
    from factory.claude_session.cli import clean_env
    from factory.claude_session.pretty import render_line

    round_no = spec.get("round_no")
    exit_path = Path(spec["exit_path"])
    Path(spec["pid_path"]).write_text(f"{os.getpid()}\n", encoding="utf-8")
    _say(f"── factory: {spec.get('title') or 'run'} — round {round_no}")
    cwd = Path(spec["cwd"])
    try:
        os.chdir(cwd)
    except OSError:
        _write_exit(exit_path, EXIT_CANNOT_CD)
        return EXIT_CANNOT_CD

    rc: int
    with (
        open(spec["prompt_path"], "rb") as fin,
        open(spec["stderr_path"], "wb") as ferr,
        open(spec["stream_path"], "wb") as fout,
    ):
        try:
            proc = subprocess.Popen(  # noqa: S603 - argv built by the launcher
                list(spec["argv"]), cwd=str(cwd), stdin=fin, stdout=subprocess.PIPE,
                stderr=ferr, env=clean_env(),
            )
        except OSError as exc:
            ferr.write(f"could not start claude: {exc}\n".encode())
            rc = EXIT_CANNOT_START
        else:
            assert proc.stdout is not None
            for raw in iter(proc.stdout.readline, b""):
                fout.write(raw)
                fout.flush()
                text = render_line(raw.decode("utf-8", errors="replace"))
                if text:
                    _say(text)
            rc = proc.wait()
    _write_exit(exit_path, rc)
    _say(f"── factory: round {round_no} finished (exit {rc})")
    return rc


def main(argv: list[str]) -> int:
    _setup_stdout()
    if len(argv) != 2:
        print("usage: python -m factory.claude_session.round <spec.json>", file=sys.stderr)
        return 2
    spec = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    return run_round(spec)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv))
