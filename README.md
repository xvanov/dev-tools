# dev-tools

Internal tooling for AI-assisted workflows: push-to-talk dictation, batch transcription/summarization, and Claude Code utilities.

## Tools

| Tool | Description |
|------|-------------|
| [voice-dictation](./voice-dictation/) | Push-to-talk voice transcription via faster-whisper → auto-paste (Windows + Linux) |
| [summarize-recording](./summarize-recording/) | Transcribe and summarize audio recordings via Azure OpenAI |
| [claude-ctx-statusline](./claude-ctx-statusline/) | Shows context window usage in the Claude Code status bar |
| [keep-awake](./keep-awake/) | Keeps a Windows session awake (F15 tap + execution-state) so it never idle-logs-out; auto-starts at logon |

## Quick start

Clone:

```bash
git clone https://github.com/xvanov/dev-tools.git
cd dev-tools
```

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

## Repo layout

```
dev-tools/
├── voice-dictation/          # real-time dictation (recorder + overlay + warm server)
├── summarize-recording/      # transcribe + Azure summarization CLI
└── claude-ctx-statusline/    # Claude Code statusLine helper
```

Each tool has its own README, requirements, and install scripts.
