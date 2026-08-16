# voice-dictation

Push-to-talk voice dictation using [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
Press `Ctrl+Alt+V`, speak, and the transcript is auto-pasted at your cursor.
Works on Linux (X11/GNOME) and Windows.

Features:
- **VAD auto-stop** — stops recording automatically after ~2 s of silence
- **Live preview overlay** — borderless always-on-top window streams the transcript as you speak
- **Done-state controls** — after transcription: Copy (full text), History, and ✕ to dismiss
- **Transcription history** — today's dictations saved locally; re-copy from overlay or tray menu
- **LLM cleanup pass** — optional local [Ollama](https://ollama.ai) pass fixes punctuation/capitalisation
- **Auto-paste** — result lands at the cursor via Ctrl+V simulation
- **Esc to cancel** — discard the recording at any time
- **Local / private** — faster-whisper runs on your GPU, audio never leaves the machine

Architecture:

```
hotkey (Ctrl+Alt+V)
  → recorder.py
      ├─ sounddevice capture (16 kHz mono)
      ├─ RMS VAD → auto-stop on silence
      ├─ every 1 s → transcribe_server (TCP) → overlay live preview
      ├─ tkinter overlay (status + running transcript)
      └─ on stop → final transcription → Ollama cleanup → clipboard → Ctrl+V
```

## Quick install

### Linux (Ubuntu / GNOME)

```bash
git clone https://github.com/xvanov/dev-tools.git
cd dev-tools/voice-dictation
./linux/install.sh
```

Then bind a global hotkey in **Settings → Keyboard → Custom Shortcuts** to:

```
~/.local/voice-dictation/voice-toggle.sh
```

Suggested binding: `Ctrl+Alt+V`.

### Windows 10/11

Open an **elevated PowerShell** in the tool directory:

```powershell
cd voice-dictation
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install.ps1
```

## Optional: LLM cleanup pass

Install [Ollama](https://ollama.ai) and pull a model:

```bash
ollama pull llama3.2   # ~2 GB
```

If Ollama is not running, `recorder.py` silently falls back to the raw transcript.
Set `OLLAMA_MODEL` to use a different model.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `WHISPER_MODEL` | `small` | `tiny`/`base`/`small`/`medium`/`large-v3` |
| `WHISPER_DEVICE` | `cuda` | `cpu` if no NVIDIA GPU |
| `WHISPER_COMPUTE` | `float16` | CPU: `int8` |
| `WHISPER_LANGUAGE` | `en` | `auto` for multilingual |
| `VD_SILENCE_THRESHOLD` | `0.01` | RMS cutoff; raise in noisy rooms |
| `VD_SILENCE_DURATION` | `2.0` | Seconds of silence to trigger auto-stop |
| `VD_MAX_DURATION` | `120.0` | Hard recording cap in seconds |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `llama3.2` | Any model pulled via `ollama pull` |
| `TRANSCRIBE_PORT` | `47821` | Loopback TCP port |
| `CUDA_RETRY_SEC` | `600` | After a GPU error the server runs on CPU this long, then retries CUDA |
| `VD_SERVER_LOG` | `server.log` beside the script | Server log; the only record of a CPU fallback |

On Linux, vars go in the systemd unit (`~/.config/systemd/user/voice-dictation.service`).
On Windows, they're baked into `start-server.bat` by the installer.

## Picking a Whisper model

| Model | Size | VRAM | Notes |
|---|---|---|---|
| `tiny` | ~75 MB | <1 GB | Low latency, mediocre accuracy |
| `small` | ~470 MB | ~1 GB | Good balance (Linux default) |
| `medium` | ~1.5 GB | ~2 GB | Better accuracy (Windows default) |
| `large-v3` | ~3 GB | ~5 GB | Best accuracy, noticeably slower |

## Hotkeys

| Key | Action |
|---|---|
| `Ctrl+Alt+V` | Start recording (first press) |
| `Ctrl+Alt+V` | Stop early → transcribe (second press) |
| `Esc` | Cancel and discard recording |

After a successful dictation, the overlay shows timing info plus **Copy**, **History**, and **✕**.
Copy uses the full cleaned transcript (not the truncated preview). The overlay auto-closes after
~2.5 s unless you hover a button or open History.

### Transcription history

Successful transcriptions are appended to a local JSONL file:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\voice-dictation\history.jsonl` |
| Linux | `~/.local/voice-dictation/history.jsonl` |

Each line is one JSON object: `timestamp`, `text`, and optional `meta` (whisper/cleanup timing,
cleanup backend, whisper model). Entries older than **7 days** are pruned automatically.

Open history from the Done overlay (**History** button) or without recording:

- **Windows** — tray icon → *Transcription history…*
- **Linux** — `~/.local/voice-dictation/voice-toggle.sh --history`

Cancelled recordings and "No speech detected" results are **not** saved.

## Files

| Path | Purpose |
|---|---|
| `recorder.py` | Main orchestrator (VAD, preview, LLM, clipboard, paste) |
| `overlay.py` | tkinter always-on-top overlay (+ `--history` standalone mode) |
| `history.py` | Local transcription history (JSONL load/save/prune) |
| `llm_cleanup.py` | Ollama LLM cleanup pass |
| `transcribe_server.py` | Always-warm faster-whisper TCP server |
| `transcribe_client.py` | TCP client (also used by recorder.py internally) |
| `transcribe.py` | One-shot CLI (slow; for testing) |
| `linux/voice-toggle.sh` | Linux hotkey toggle |
| `linux/install.sh` | Linux installer + systemd unit |
| `windows/voice-toggle.ahk` | Windows hotkey (AutoHotkey v2) |
| `windows/install.ps1` | Windows installer + scheduled task |
| `AGENT.md` | Detailed install/troubleshoot guide for agents |

## Troubleshooting

- **Overlay doesn't appear** — `python3-tk` missing on Linux (`sudo apt-get install python3-tk`).
- **No auto-paste** — `xdotool` missing on Linux (`sudo apt-get install xdotool`).
- **"No speech detected"** — transcription server not running.
  - Linux: `systemctl --user status voice-dictation`
  - Windows: open Task Scheduler → find `VoiceDictationServer`.
- **PortAudio error on Linux** — add your user to the `audio` group:
  `sudo usermod -aG audio $USER`, then log out and back in.
- **CUDA / cuDNN error** — reinstall CUDA wheels into the venv:
  `pip install --force-reinstall nvidia-cudnn-cu12 nvidia-cublas-cu12`.
- **Overlay shows `<model>/cpu` on a GPU machine** — the server hit a GPU error
  (driver update mid-run, VRAM exhausted by another app) and fell back. It
  retries CUDA after `CUDA_RETRY_SEC`; `server.log` records the original error.
  Restarting the server also clears it. CPU transcription is several times
  slower, so a stuck `/cpu` is the first thing to check when dictation crawls.
- **Hotkey conflict** — edit `voice-toggle.ahk` (Windows) or rebind the GNOME
  shortcut (Linux) to a different key combination.
