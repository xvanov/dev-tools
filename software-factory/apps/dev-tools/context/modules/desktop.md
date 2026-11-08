# desktop — Jarvis Desktop Shell

## What it does

A Tauri 2 app that opens a stack's termhub front (the Jarvis nav with the PA
under `/pa/`) in its own window. Adds tray icon, OS notifications from the PA's
live event stream, stack switcher (work/personal), and start-at-login. Closing
the window hides it to the tray.

## Language / Runtime

Rust (Tauri 2) with a plain HTML/CSS/JS settings window (`desktop/ui/`); no
TypeScript. The stack window is the remote termhub front page. Node is only the
Tauri CLI (`npm ci` in `desktop/`). Key dependencies: Tauri 2 (WebKitGTK on
Linux, WebView2 on Windows).

## Platforms

Windows and Linux (D14: no macOS). Needs `libwebkit2gtk-4.1-dev` on Linux;
WebView2 ships with Windows 11.

## Test command

```
cd desktop/src-tauri && cargo test
```

Six Rust unit tests (`src-tauri/src/config.rs`, `events.rs`): config parsing,
SSE parsing, notification rules. There is no `desktop` CI job: CI's `build` job
(Linux and Windows) runs `cargo fmt --check`, `cargo clippy -D warnings` and
`cargo test` on the crate, then builds the installers. It runs only when
`ptyd/`, `desktop/` or `scripts/build.js` change.

## Install / Deploy

- Build: `node scripts/build.js --only desktop --release` produces NSIS
  (Windows) or .deb (Linux) installer
- CI builds installers and publishes as `dist-<OS>` artifact
- No machine runs it at startup unless the user enables start-at-login