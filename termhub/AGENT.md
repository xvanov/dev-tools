# termhub — install & troubleshooting (detailed)

Companion to [README.md](./README.md). termhub is **one self-contained server per machine**:
it serves the web UI and owns that machine's terminals (PTYs). There is no hub/proxy and no
list of other machines — you reach each machine directly at its own URL.

## Mental model

```
browser tab ──► http://<machine>:7000 ──► termhub server ──► node-pty PTYs
```

- Run it on every machine you want terminals on.
- Open one browser tab per machine (bookmark each Tailscale URL on your phone).
- A session = one PTY living in the server process, with an in-memory scrollback buffer.
  Browser (re)connections attach to it and get a replay of the buffer, then live output.

## Ports & binding

- Listens on `TERMHUB_PORT` (default 7000), bound to `TERMHUB_BIND` if set, else auto:
  `tailscale ip -4` → any `100.64.0.0/10` interface → `127.0.0.1`. The loopback fallback
  means it never silently exposes itself on a public interface.
- Local dev without Tailscale: `TERMHUB_BIND=127.0.0.1 node server.js`, then open
  `http://127.0.0.1:7000`.

## Manual run / smoke test

```bash
npm install
node server.js
# browser → http://<tailscale-ip>:7000
```

API quick checks:

```bash
curl -s http://<host>:7000/api/info | jq
curl -s http://<host>:7000/api/sessions | jq
curl -s -X POST http://<host>:7000/api/sessions \
  -H 'content-type: application/json' -d '{"cwd":"'"$HOME"'"}' | jq
```

HTTP API: `GET /api/info`, `GET /api/sessions`, `POST /api/sessions`
(`{cwd?, command?, title?, cols, rows}`), `DELETE /api/sessions/:id`, `GET /api/recents`.
Terminal stream: WebSocket `/ws/term/:id` with JSON `{type:'input'|'resize'}` up and
`{type:'replay'|'output'|'exit'}` down.

## Linux service management

```bash
systemctl --user status termhub
systemctl --user restart termhub
journalctl --user -u termhub -f          # live logs

# edit env (port / bind / machine name):
systemctl --user edit termhub            # add: [Service]\nEnvironment=TERMHUB_BIND=100.x.y.z
systemctl --user daemon-reload && systemctl --user restart termhub
```

Keep it running after logout (servers/headless): `sudo loginctl enable-linger "$USER"`.

The installer also auto-removes units from the older two-process layout
(`termhub-agent.service` / `termhub-hub.service`) if they exist.

## Windows task management

```powershell
Get-ScheduledTask Termhub | Get-ScheduledTaskInfo
Start-ScheduledTask Termhub
Stop-ScheduledTask  Termhub
setx TERMHUB_BIND 100.x.y.z              # then restart the task
```

To see errors, run `node server.js` in a console manually (the task has no log redirection
by default). The installer removes old `TermhubAgent` / `TermhubHub` tasks if present.

The Windows installer binds termhub to loopback (`TERMHUB_BIND=127.0.0.1`, set via `setx`) and
publishes it with Tailscale Serve. Manage the published endpoint with:

```powershell
tailscale serve status
tailscale serve --https=7000 off        # stop publishing
```

Non-admin installs use a hidden Startup-folder launcher instead of a task; the installer writes
it with the absolute project path baked in (a path resolved relative to the .vbs breaks once the
file is copied into the Startup folder).

## node-pty build prerequisites

`node-pty` is a native addon and compiles on install:

- **Linux:** `sudo apt-get install -y build-essential python3` (or distro equivalent).
- **Windows:** **Visual Studio Build Tools** with the *Desktop development with C++* workload,
  plus a matching Python. After installing, delete `node_modules` and re-run `npm install`.

`windows\install.ps1` builds the native addon itself (npm runs with `--ignore-scripts`, then
the installer drives `node-gyp configure` + MSBuild) so it can work around two stock-Windows
build failures automatically:

- **`'GetCommitHash.bat' is not recognized`** — caused by the environment variable
  `NoDefaultCurrentDirectoryInExePath=1`, which stops `cmd` from running winpty's batch file
  from the current directory. The installer clears it for the build.
- **`MSB8040: Spectre-mitigated libraries are required`** — newer VS toolsets (e.g. 2022/2026)
  demand Spectre libs that aren't installed by default. The installer passes
  `/p:SpectreMitigation=false` to MSBuild. To keep the mitigation instead, install
  *MSVC … Spectre-mitigated libs* from the VS Installer (Individual components) and drop that flag.

If building by hand, reproduce both: clear `NoDefaultCurrentDirectoryInExePath`, then
`npx node-gyp configure` and `MSBuild build\binding.sln /p:Configuration=Release /p:Platform=x64 /p:SpectreMitigation=false`.

## Mobile notes

- The on-screen key bar sends real escape sequences: `Esc` (`\x1b`), `Tab` (`\t`), arrows
  (`\x1b[A/B/C/D`), `^C` (`\x03`). The sticky **Ctrl** key arms a modifier applied to the next
  letter you type (e.g. `Ctrl` then `d` → `\x04`).
- Inputs use a 16px font so iOS Safari doesn't zoom on focus.
- The terminal refits on focus, `orientationchange`, and `visualViewport` resize (soft
  keyboard show/hide).
- Add the tab to your home screen for an app-like, full-screen experience.

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Bound to `127.0.0.1`, unreachable from other devices | No Tailscale IP detected | Set `TERMHUB_BIND` to the tailnet IP; ensure `tailscaled` is up |
| Can't reach `:7000` from phone (loads forever) | Windows firewall drops raw ports on the Tailscale interface | Use Tailscale Serve (Windows installer does this): bind loopback + `tailscale serve --bg --https=7000 http://127.0.0.1:7000`, then open `https://<host>.<tailnet>.ts.net:7000/` |
| Can't reach `:7000` from phone | Tailnet ACL or firewall | Confirm both devices are on the tailnet and ACLs allow the port |
| Terminal opens but no output | WebSocket blocked | Ensure nothing between browser and server strips WebSocket upgrades |
| Input ignored after sleep/wake | WebSocket dropped; reconnecting | Output replays on reconnect; if it gave up ("session no longer available"), the server restarted — open a new terminal |
| Wrong size / wrapping | Pane resized while backgrounded | Switch tabs or rotate to force a refit |
| `npm install` errors on `node-pty` | Missing build toolchain | See prerequisites above |

## Security notes

- There is **no authentication** — anyone who can reach the port on your tailnet can open
  terminals on that machine. Keep your tailnet ACLs tight.
- termhub binds only the Tailscale interface by default. Do **not** set `TERMHUB_BIND=0.0.0.0`
  on a machine with a public interface unless you add your own access control in front.
