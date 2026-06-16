# termhub

A simple, self-hosted **web terminal** for your tailnet. Run one small server on each
machine you want to reach; from your phone or laptop, open that machine's URL in a browser
tab and manage its terminals — open several, switch between them, scroll back, and reattach
after a disconnect with full scrollback intact. Includes a one-click **Claude Code** launcher.

Works on Linux and Windows. Mobile-friendly. No tmux, no complex shortcuts.

## How you use it

You run `termhub` **separately on each machine** (1 Linux + 2 Windows, say). Every machine
serves its own UI. From a single device (phone/laptop) you open **one browser tab per
machine** at that machine's Tailscale address:

```
phone / laptop
  ├─ tab → http://linux-box:7000      (terminals on the Linux box)
  ├─ tab → http://win-1:7000          (terminals on Windows #1)
  └─ tab → http://win-2:7000          (terminals on Windows #2)
```

Each tab is independent and self-contained — there is no central hub, proxy, or config of
other machines to maintain.

## Features

- **Terminals in the browser** — powered by [xterm.js](https://xtermjs.org): proper colors,
  wide chars, scrollback. Full TUIs like `htop`/`vim` render correctly.
- **Real keys, including on mobile** — send `Ctrl-C`, arrows, `Esc`, `Tab`, and respond to
  interactive prompts. An on-screen key bar provides these (phone keyboards lack them), plus
  a sticky **Ctrl** modifier (tap `Ctrl`, then a letter → `Ctrl-<letter>`).
- **Survives disconnects** — the PTY and its scrollback live in the server process. Close
  your phone, reopen later, and the session is still running; the browser auto-reconnects
  and replays scrollback.
- **Claude Code launcher** — pick a directory (dropdown of recently used dirs) and an
  editable command (default `claude`); it opens a terminal there and runs it.
- **Mobile-friendly** — responsive layout, slide-out session drawer, on-screen keys.
- **Tailscale-native** — binds to the Tailscale interface only; no login screen, trust is
  delegated to your tailnet ACLs.

## Architecture

One process per machine, that's it:

```
browser tab ──http+ws──► termhub server (this machine) ──► PTYs (node-pty)
```

The server serves the web UI and owns the machine's terminals. Sessions are kept in the
server's memory, so they survive browser disconnects but **not** a server restart or reboot
(by design — keeps it simple, no tmux).

## Install (on each machine)

### Linux (systemd user service)

```bash
git clone https://github.com/xvanov/dev-tools.git
cd dev-tools/termhub
./linux/install.sh
```

Compiles `node-pty`, writes `~/.config/systemd/user/termhub.service`, and starts it. The
installer prints the URL (`http://<tailscale-ip>:7000`).

### Windows (scheduled task or Startup-folder launcher)

```powershell
cd termhub
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install.ps1
```

The installer adapts to your privileges:

- **Elevated PowerShell** → auto-start via a **Scheduled Task** (runs at logon, auto-restarts
  on crash) plus a Windows Firewall rule (inbound TCP 7000, restricted to the tailnet).
- **Non-admin PowerShell** → auto-start via a hidden launcher in your **Startup folder**, then
  it self-elevates *only* the firewall step (one UAC prompt).

It also compiles `node-pty` itself, working around two common Windows build failures
(`GetCommitHash.bat` and Spectre-lib `MSB8040`) — see [AGENT.md](./AGENT.md). Needs the Visual
Studio Build Tools (Desktop development with C++ workload).

### Run manually (no service)

```bash
npm install
node server.js
```

Then browse to `http://<this-machine-tailscale-ip>:7000`.

## Using it

- **+ New terminal** — optionally a starting directory; opens a shell.
- **★ Claude Code** — pick a directory (dropdown remembers recent ones) and an editable
  command (default `claude`, e.g. `claude --resume`). The command runs in a fresh shell, so
  when it exits you still have a shell.
- Switch terminals via the sidebar or tabs. Closing a **tab** detaches (the session keeps
  running); the **✕** next to a session **kills** it.
- On mobile: tap **☰** for the session drawer, **＋** for a new terminal, and use the key bar
  at the bottom for `Esc` / `Ctrl` / `Tab` / arrows / `^C`. Tap **⌨** to bring the keyboard back.

## Configuration

All optional environment variables:

| Variable | Default | Notes |
|---|---|---|
| `TERMHUB_PORT` | `7000` | Port to listen on |
| `TERMHUB_BIND` | auto | Bind address. Auto-detects the Tailscale IP (`tailscale ip -4`, else a 100.64.0.0/10 interface), falling back to `127.0.0.1`. Set to override (e.g. `0.0.0.0` for local dev). |
| `TERMHUB_MACHINE` | hostname | Name shown in the UI |
| `TERMHUB_SHELL` | `$SHELL` / `pwsh`→`powershell` | Shell to spawn |
| `TERMHUB_SCROLLBACK_BYTES` | `2097152` (2 MB) | Per-session replay buffer size |
| `TERMHUB_DATA_DIR` | `~/.local/termhub` (Win: `%LOCALAPPDATA%\termhub`) | Where recent dirs are stored |

On Linux set these with `systemctl --user edit termhub`; on Windows via `setx` + restart the task.

## Files

| Path | Purpose |
|---|---|
| `server.js` | The server: HTTP API, terminal WebSocket, static UI, Tailscale bind |
| `lib/session.js` | PTY lifecycle (`node-pty`), scrollback ring buffer, replay |
| `lib/shell.js` | Default-shell resolution per OS |
| `lib/recents.js` | Recent-directory persistence |
| `lib/bind.js` | Tailscale-address detection |
| `lib/paths.js` | Per-user data directory resolution |
| `web/` | xterm.js single-page UI (sidebar, tabs, key bar, dialogs) + vendored xterm assets |
| `linux/`, `windows/` | Installers + the systemd service definition |
| `AGENT.md` | Detailed install / troubleshooting guide |

## Troubleshooting

- **`node-pty` fails to build** — needs a C/C++ toolchain. Linux: `build-essential`,
  `python3`. Windows: Visual Studio Build Tools (Desktop development with C++).
- **Bound to loopback / unreachable from other devices** — no Tailscale IP detected. Set
  `TERMHUB_BIND` to this machine's tailnet IP (`tailscale ip -4`).
- **Session disappeared after a reboot** — expected; sessions live in the server's memory.
- **On iPhone the page zooms when typing** — inputs use 16px font to avoid this; if it still
  happens, ensure you're on the current build (hard-refresh the tab).
- **Garbled output / wrong size** — the terminal refits on focus, rotate, and keyboard
  show/hide; switch tabs or resize to force a refit.

See [AGENT.md](./AGENT.md) for a deeper walkthrough.
