# dev-tools

Internal tooling for AI-assisted workflows: push-to-talk dictation, batch transcription/summarization, and Claude Code utilities.

## Tools

| Tool | Description |
|------|-------------|
| [bootstrap](./bootstrap/) | One-shot provisioning for a new Linux machine (Raspberry Pi / Ubuntu): base packages, Node.js, Tailscale, SSH key + git repos, and the dev-tools — all from one script |
| [voice-dictation](./voice-dictation/) | Push-to-talk voice transcription via faster-whisper → auto-paste (Windows + Linux) |
| [summarize-recording](./summarize-recording/) | Transcribe and summarize audio recordings via Azure OpenAI |
| [claude-ctx-statusline](./claude-ctx-statusline/) | Shows context window usage in the Claude Code status bar |
| [keep-awake](./keep-awake/) | Keeps a Windows session awake (F15 tap + execution-state) so it never idle-logs-out; auto-starts at logon |
| [termhub](./termhub/) | Mobile-friendly web terminal over Tailscale — one server per machine; open/reattach shell sessions, incl. Claude Code (Windows + Linux) |
| [disk-janitor](./disk-janitor/) | Safe, scheduled reclamation of rebuildable disk space (package caches + aged temp/cache); whitelist-only, never touches user data (Windows + Ubuntu/Debian) |
| [personal-assistant](./personal-assistant/) | *(planning)* Context layer over Outlook/Teams/GitLab/meetings that distils asks into commitments and dispatches them to Claude Code sessions you can attach to |

## Quick start

Clone:

```bash
git clone https://github.com/xvanov/dev-tools.git
cd dev-tools
```

### Bootstrap a new Linux machine (Raspberry Pi / Ubuntu)

Provision a fresh box end-to-end — base packages, Node.js, Tailscale, an SSH key
+ your git repos, and the dev-tools — with one self-contained script. Flash
Ubuntu, then:

```bash
scp bootstrap/pi-setup.sh <user>@<pi>:~/
ssh <user>@<pi>
TS_AUTHKEY=tskey-auth-xxxx ./pi-setup.sh
```

See [bootstrap/README.md](./bootstrap/) for options. Re-runnable and idempotent.

### Voice dictation (Windows)

```powershell
cd voice-dictation
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install.ps1
```

Press `Ctrl+Alt+V` to record. Recording auto-stops on silence; transcript is cleaned up and pasted at the cursor.

### Voice dictation (Linux)

```bash
cd voice-dictation
./linux/install.sh
```

Bind `~/.local/voice-dictation/voice-toggle.sh` to `Ctrl+Alt+V` in keyboard settings.

### summarize-recording

```bash
cd summarize-recording
python -m venv .venv
source .venv/bin/activate   # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Set AZURE_OPENAI_* or AZURE_FOUNDRY_* in repo-root .env
python summarize-recording.py run recording.mp3
```

### Claude context status line

```powershell
cd claude-ctx-statusline
.\install.ps1
```

Restart Claude Code to see `Ctx: 30k/200k (15%)` in the status bar.

### keep-awake (Windows)

```powershell
cd keep-awake
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Starts immediately and auto-starts at every logon (hidden). Remove with `.\install.ps1 -Uninstall`.

### termhub (web terminal over Tailscale)

Install on each machine you want terminal access to:

```bash
cd termhub
./linux/install.sh        # Linux (systemd user service)
# Windows: .\windows\install.ps1  (elevated PowerShell)
```

Then open `http://<machine-tailscale-ip>:7000` in a browser tab per machine (works on your
phone). Open terminals, switch between them, scroll back, and reattach after disconnects.
Mobile-friendly, with an on-screen key bar (Ctrl-C, arrows, Esc, Tab) and a one-click
Claude Code launcher.

## Repo layout

```
dev-tools/
├── bootstrap/                # provision a new Linux machine (Pi/Ubuntu) end-to-end
├── voice-dictation/          # real-time dictation (recorder + overlay + warm server)
├── summarize-recording/      # transcribe + Azure summarization CLI
├── claude-ctx-statusline/    # Claude Code statusLine helper
├── keep-awake/               # Windows keep-session-awake helper
└── termhub/                  # web terminal over Tailscale (agent + hub + xterm.js UI)
```

Each tool has its own README, requirements, and install scripts.
