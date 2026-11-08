# desktop — Jarvis Desktop Shell

## What it does

A Tauri 2 app that opens a stack's termhub front (the Jarvis nav with the PA
under `/pa/`) in its own window. Adds tray icon, OS notifications from the PA's
live event stream, stack switcher (work/personal), and start-at-login. Closing
the window hides it to the tray.

## Language / Runtime

TypeScript (UI) + Rust (Tauri 2 backend). Key dependencies: Tauri 2, the Tauri
Rust crate set (webkit2gtk on Linux, WebView2 on Windows).

## Platforms

Windows and Linux (D14: no macOS). Needs `libwebkit2gtk-4.1-dev` on Linux;
WebView2 ships with Windows 11.

## Test command

```
cd desktop/src-tauri && cargo test
```

Unit tests: config parsing, SSE parsing, notification rules. The Rust crate
also runs `cargo fmt --check` and `cargo clippy` in CI.

## Install / Deploy

- Build: `node scripts/build.js --only desktop --release` produces NSIS
  (Windows) or .deb (Linux) installer
- CI builds installers and publishes as `dist-<OS>` artifact
- No machine runs it at startup unless the user enables start-at-login