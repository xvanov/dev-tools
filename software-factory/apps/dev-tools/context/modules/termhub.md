# termhub — Web Terminal over Tailscale

## What it does

A self-hosted web terminal for a tailnet. Run one server per machine; from a
phone or laptop browser, open that machine's Tailscale URL for terminals, session
management, scrollback, and a one-click Claude Code launcher. Includes spoken
announcements (kokoro/piper TTS), voice commands (wake word "Sputnik"), agent
time tracking with ntfy push escalation, and a safe blue-green updater.

## Language / Runtime

TypeScript / JavaScript on Node.js 18+. Key dependencies: `node-pty` (PTY
allocation), `ws` (WebSocket), `@xterm/headless` (server-side terminal emulation),
`@xterm/xterm` (browser UI, vendored).

## Platforms

Windows (two-tier: sessiond + front, Tailscale Serve) and Linux (single-process).
Mobile-friendly (responsive layout, on-screen key bar).

## Test command

```
cd termhub && npm test
```

Uses `../scripts/run-tests.js` (custom runner). Tests include: CSRF guard,
front swap (terminals survive front restart), ptyd conformance (black-box suite
against sessiond, ptyd, and sessiond-on-ptyd), voice commands (pure), idle
state machine, peer discovery, theme drift detection.

## Install / Deploy

- **Linux:** `./linux/install.sh` — writes systemd user service + watchdog
  timer, compiles node-pty
- **Windows:** `.\windows\install.ps1` (elevated) — registers scheduled tasks
  for Termhub + watchdog
- **Blue-green updates:** `windows/update.ps1` swaps front without killing
  terminals; on Linux updates restart the single process (terminals end)
- **Dev mode:** `node server.js` runs both tiers in one process on `:7000`