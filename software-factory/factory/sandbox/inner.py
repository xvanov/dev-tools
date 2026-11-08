"""Runs INSIDE the Linux sandbox, first: loopback relays, then the agent.

The sandbox has its own network namespace with only ``lo``. The egress proxy
and the broker live outside and are reached through unix sockets bound into
the sandbox; this relays ``127.0.0.1:<port>`` to each socket so ordinary tools
(``HTTPS_PROXY=http://127.0.0.1:3128``) work unchanged. Then it runs the
agent's command and exits with its status.

Stdlib only, run by path with ``python -I``::

    inner.py --relay 127.0.0.1:3128=/sbx/proxy.sock -- argv...
"""

from __future__ import annotations

import socket
import subprocess
import sys
import threading


def _pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def relay(listen: str, target: str) -> None:
    host, _, port = listen.rpartition(":")
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, int(port)))
    srv.listen(64)

    def loop() -> None:
        while True:
            client, _ = srv.accept()
            try:
                up = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # type: ignore[attr-defined,unused-ignore]
                up.connect(target)
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pipe, args=(client, up), daemon=True).start()
            threading.Thread(target=_pipe, args=(up, client), daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()


def main(argv: list[str]) -> int:
    relays: list[tuple[str, str]] = []
    i = 0
    while i < len(argv) and argv[i] != "--":
        if argv[i] == "--relay":
            listen, _, target = argv[i + 1].partition("=")
            relays.append((listen, target))
            i += 2
        else:
            print(f"inner: unknown argument {argv[i]!r}", file=sys.stderr)
            return 96
    cmd = argv[i + 1 :]
    if not cmd:
        print("inner: no command", file=sys.stderr)
        return 96
    for listen, target in relays:
        relay(listen, target)
    try:
        return subprocess.call(cmd)  # noqa: S603
    except OSError as exc:
        print(f"inner: cannot run {cmd[0]!r}: {exc}", file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
