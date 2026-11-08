# Module: termhub

**Path:** `termhub/`

## Purpose

Mobile-friendly web terminal over Tailscale. One server per machine; open/reattach shell sessions, including Claude Code. Works on Windows + Linux.

## Key files

| File | Role |
|------|------|
| `server.js` | Main server — HTTP + WebSocket server for terminal sessions. |
| `sessiond.js` | Session daemon — manages terminal session lifecycle. |
| `front.js` | Frontend JavaScript — xterm.js-based terminal UI. |
| `lib/` | Server-side library code. |
| `web/` | Web frontend assets. |
| `test/` | Test files. |
| `watchdog/` | Watchdog process for session health. |
| `linux/` | Linux installer (`install.sh` — systemd user service). |
| `windows/` | Windows installer (`install.ps1` — elevated PowerShell). |
| `package.json` | NPM dependencies. |

## Tech

- Node.js with Express/WS for the server
- xterm.js for the terminal emulator in the browser
- Tailscale for network connectivity