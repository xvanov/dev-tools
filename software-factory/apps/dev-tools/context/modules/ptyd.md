# ptyd — Rust Terminal Host for termhub

## What it does

termhub's terminal host in Rust (native rebuild plan item 5.1). Owns PTYs
(ConPTY on Windows, Unix PTY on Linux via `portable-pty`) and speaks the
session half of termhub sessiond's protocol on loopback. Opt-in via
`TERMHUB_PTYD=1`. When active, sessiond creates every PTY in ptyd instead of
node-pty, making the PTY host itself restartable without losing terminals.

## Language / Runtime

Rust. Key dependencies: `portable-pty` (cross-platform PTY abstraction),
`tokio` (async runtime), `warp` (HTTP/WebSocket server).

## Platforms

Windows and Linux. Binds 127.0.0.1 only.

## Test command

```
cd ptyd && cargo test
```

Unit tests cover env spec, session links, request guard, UTF-8 handling.
Black-box conformance suite is in `termhub/test/ptydConformance.test.js`
(run against sessiond, ptyd, and sessiond-on-ptyd).

## Install / Deploy

- Build: `cargo build --release` in `ptyd/`
- CI builds it via `scripts/build.js` as part of the `build` job
- Windows: registered as `termhub-ptyd` logon task via `windows/ptyd.ps1`
- Linux: `termhub-ptyd.service` via `linux/ptyd-unit.sh`
- Updates: a new build is installed beside the running binary (named by hash);
  switching requires a restart that ends terminals.