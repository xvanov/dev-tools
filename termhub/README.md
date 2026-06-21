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
- **Survives disconnects *and updates*** — the PTY and its scrollback live in a persistent
  supervisor (`sessiond`), separate from the swappable web/proxy tier (`front`). Close your
  phone and reopen later, *or* deploy a new version with `update.ps1`, and your sessions keep
  running; the browser auto-reconnects and replays scrollback either way.
- **Claude Code launcher** — a directory field that autocompletes against the filesystem
  as you type (recents when blank), and a single editable command box (default
  `claude --dangerously-skip-permissions`, with presets you can pick or type over, or clear
  for a plain shell); it opens a terminal there and runs it.
- **Update from the UI** — a ⟳ Update button checks GitHub (once a day in the background, and
  on demand) and, when the termhub tool itself has changed, opens a terminal that runs the
  safe blue-green updater. See [Updating safely](#updating-safely-terminals-survive).
- **Mobile-friendly** — responsive layout, slide-out session drawer, on-screen keys.
- **Tailscale-native** — binds to the Tailscale interface only; no login screen, trust is
  delegated to your tailnet ACLs.

## Architecture

Two processes per machine — a **persistent** PTY supervisor and a **swappable** front, so
updates don't kill terminals:

```
                         Tailscale Serve (stable public :7000)
                                    │   (re-pointed atomically on update)
                                    ▼
browser tab ──http+ws──►  front  (UI + proxy, 127.0.0.1:7001⇆7002)
                              │   proxies /api/* and /ws/term/* to ↓
                              ▼
                          sessiond  (127.0.0.1:7010)
                              └─► PTYs (node-pty) + scrollback  ← survive every update
```

- **`sessiond`** owns the terminals (the `node-pty` PTYs and their scrollback). It's long-lived
  and only restarting *it* loses sessions.
- **`front`** serves the web UI and reverse-proxies to `sessiond`. Updates start a new `front`
  on the alternate loopback port, health-check it, then re-point Tailscale Serve at it — the
  browser reconnects through the new `front` to the *same* PTYs and replays scrollback.

Sessions still don't survive a full **reboot** (the supervisor restarts) — by design, no tmux.
For local dev, `node server.js` runs both tiers in one process on `:7000` (no update-survival,
which is fine for dev).

## Install (on each machine)

### Linux (systemd user service)

```bash
git clone https://github.com/xvanov/dev-tools.git
cd dev-tools/termhub
./linux/install.sh
```

Compiles `node-pty`, writes `~/.config/systemd/user/termhub.service`, and starts it. The
installer prints the URL (`http://<tailscale-ip>:7000`).

### Windows (Tailscale Serve)

```powershell
cd termhub
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install.ps1
```

On Windows the installer binds termhub to **loopback** and publishes it on your tailnet with
**Tailscale Serve** (HTTPS), giving you `https://<machine>.<tailnet>.ts.net:7000/`. This is the
mechanism that actually works from a phone: a raw port on the Tailscale interface is dropped by
Windows' default inbound-block firewall and just hangs. Requires the Tailscale CLI signed in,
and HTTPS/MagicDNS enabled for your tailnet (the default).

Auto-start adapts to privileges: **elevated** → a Scheduled Task (at logon, auto-restart);
**non-admin** → a hidden launcher in your Startup folder. The Serve config is persisted by
`tailscaled` and restored on boot.

It also compiles `node-pty` itself, working around two common Windows build failures
(`GetCommitHash.bat` and Spectre-lib `MSB8040`) — see [AGENT.md](./AGENT.md). Needs the Visual
Studio Build Tools (Desktop development with C++ workload).

### Run manually (no service)

```bash
npm install
node server.js
```

Then browse to `http://<this-machine-tailscale-ip>:7000`.

## Updating safely (terminals survive)

The easiest way is the **⟳ Update** button in the sidebar header — it opens a terminal that
runs the updater for you. To do it by hand instead, from **any termhub terminal on the machine**
(so you can do it remotely from your phone/laptop):

```powershell
cd <project-dir>
.\windows\update.ps1
```

It's deterministic and reversible:

1. `git pull --ff-only` (records the old commit for rollback; aborts cleanly if not a fast-forward).
2. Starts a new **green** `front` on the alternate loopback port and health-checks it
   (front up, `sessiond` reachable, proxy + static both serving).
3. **Healthy** → re-points Tailscale Serve to green, then stops the old front. The published URL
   never changes; browsers reconnect to the same sessions and replay scrollback.
4. **Unhealthy** → kills green, `git reset --hard` to the old commit, leaves the old front
   serving. Zero downtime, terminals untouched.

Because only `front` is swapped — `sessiond` and its PTYs are never touched — even the terminal
running `update.ps1` survives the update.

> **First-time bootstrap:** moving from the old single-process layout to the two-tier one
> requires one restart that *does* clear current sessions. Run `.\windows\install.ps1` (or
> `.\windows\start.ps1`) once; every `update.ps1` after that is non-disruptive.

## Using it

- **+ New terminal** — optionally a starting directory (it autocompletes against the
  filesystem as you type; leave blank for home) and a command. The **Command** box is a
  single editable combobox: type a command, pick a preset from the list, or clear it for a
  plain shell. The command runs in a fresh shell, so when it exits you still have a shell.
- **⟳ Update** (sidebar header) — opens a panel showing whether termhub is behind GitHub and
  whether the tool itself changed, with the incoming commit list. **Update now** opens a
  terminal that runs the safe updater (see below). It also checks once a day in the background
  and highlights the button when an update is waiting.
- Switch terminals via the sidebar or tabs. Closing a **tab** detaches (the session keeps
  running); the **✕** next to a session **kills** it.
- On mobile: tap **☰** for the session drawer, **＋** for a new terminal, and use the key bar
  at the bottom for `Esc` / `Ctrl` / `Tab` / arrows / `^C`. Tap **⌨** to bring the keyboard back.

## Configuration

All optional environment variables:

| Variable | Default | Notes |
|---|---|---|
| `TERMHUB_PORT` | `7000` | Front port for the single-process dev server (`node server.js`) |
| `TERMHUB_SESSIOND_PORT` | `7010` | Supervisor (`sessiond`) loopback port |
| `TERMHUB_FRONT_PORT` | `7001` | Front loopback port (production alternates `7001`⇆`7002`) |
| `TERMHUB_BIND` | auto | Front bind address. Auto-detects the Tailscale IP (`tailscale ip -4`, else a 100.64.0.0/10 interface), falling back to `127.0.0.1`. On Windows the installer pins it to `127.0.0.1` (Tailscale Serve does the exposure). `sessiond` always binds loopback regardless. |
| `TERMHUB_MACHINE` | hostname | Name shown in the UI |
| `TERMHUB_SHELL` | `$SHELL` / `pwsh`→`powershell` | Shell to spawn |
| `TERMHUB_SCROLLBACK_BYTES` | `2097152` (2 MB) | Per-session replay buffer size |
| `TERMHUB_DATA_DIR` | `~/.local/termhub` (Win: `%LOCALAPPDATA%\termhub`) | Where recent dirs are stored |

On Linux set these with `systemctl --user edit termhub`; on Windows via `setx` + restart the task.

## Files

| Path | Purpose |
|---|---|
| `sessiond.js` | **Persistent supervisor**: HTTP API + terminal WebSocket; owns the PTYs (loopback) |
| `front.js` | **Swappable front**: serves the static UI + reverse-proxies `/api/*` and `/ws/term/*` to `sessiond` |
| `server.js` | Single-process dev entrypoint — runs both tiers in one process (`npm start`) |
| `lib/session.js` | PTY lifecycle (`node-pty`), scrollback ring buffer, replay |
| `lib/state.js` | Deployment state (`state.json`) + pid-file helpers shared by the tiers and scripts |
| `lib/dirs.js` | Directory autocomplete for the new-terminal dialog |
| `lib/shell.js` | Default-shell resolution per OS |
| `lib/recents.js` | Recent-directory persistence |
| `lib/bind.js` | Tailscale-address detection |
| `lib/paths.js` | Per-user data directory resolution |
| `web/` | xterm.js single-page UI (sidebar, tabs, key bar, dialogs) + vendored xterm assets |
| `windows/start.ps1` | Boots both tiers and publishes the front via Tailscale Serve (run by the scheduled task) |
| `windows/update.ps1` | Safe blue-green updater (run from any terminal; terminals survive) |
| `windows/common.ps1` | Shared PowerShell helpers (state, pid files, health checks) |
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
