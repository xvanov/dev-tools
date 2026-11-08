# desktop: the Jarvis desktop shell

Plan item 7.6 (desktop only, D12; Windows and Linux, D14). A Tauri 2 app that opens a stack's
existing browser shell (a termhub front: the Jarvis nav, with the PA under `/pa/`) in its own
window, and adds what a browser tab can't:

- **Tray icon**: open, switch stack, settings, start at login, notifications, quit. Closing the
  window hides it; the app keeps running in the tray.
- **OS notifications** from the PA's live feed (`<stack>/pa/api/events?topics=board,run`, SSE,
  reconnecting with `Last-Event-ID`). Only what needs you: a proposal waiting for your approval,
  a secret request, a draft to review, a run that is waiting on you, landed or failed. Payloads
  are ids and states (sql/034), so a notification says *that*, and the window is where you read
  what. Each (row, state) notifies once; the first connect replays nothing.
- **Stack switcher**: work and personal. Only one is connected at a time: switching destroys the
  old window and stops its event stream before the new ones start. Each stack has its own
  webview data directory (`<app local data>/stacks/<id>`), so cookies and storage never mix.
- **Start at login**: off by default. Turned on from the tray or settings, it starts with
  `--hidden` (tray only).

The stack window is a remote page and gets **no IPC**; only the local settings window
(`ui/`, `src-tauri/capabilities/default.json`) can call the app.

## Configuration

`stacks.json` in the app's config dir (`%APPDATA%\dev.devtools.jarvis` on Windows,
`~/.config/dev.devtools.jarvis` on Linux), edited from the settings window:

```json
{
  "active": "work",
  "stacks": {
    "work": { "name": "Work", "url": "http://127.0.0.1:7000/" },
    "personal": { "name": "Personal", "url": "", "events": null }
  },
  "notifications": true
}
```

`url` is the termhub front to open; `events` overrides the event stream (default
`<url>/pa/api/events?topics=board,run`, through termhub's PA proxy). The personal address is a
tailnet name, so it is left empty here and set on the machine.

## Build

```bash
npm ci                                   # in desktop/: the Tauri CLI
node ../scripts/build.js --only desktop  # local: the binary, incremental
node ../scripts/build.js --only desktop --release   # installers: NSIS (Windows), .deb (Linux)
cd src-tauri && cargo test               # unit tests: config, SSE parsing, notification rules
```

Linux needs `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`.
Windows needs the MSVC build tools; WebView2 ships with Windows 11. CI's `build` job builds the
installers on both systems and publishes them in the `dist-<OS>` artifact. Icons are generated
from `icons/source.svg` (`npm run icons`, then drop the mobile and macOS outputs).

Nothing installs it: no machine runs it at startup unless someone turns on start at login.
