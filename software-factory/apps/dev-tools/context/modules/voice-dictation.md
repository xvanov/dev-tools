# voice-dictation — Push-to-Talk Voice Transcription

## What it does

Push-to-talk voice transcription. Press Ctrl+Alt+V, speak, release, and the
transcribed text appears at the cursor. Runs on-device via faster-whisper with
an optional Ollama cleanup pass (removes filler words, punctuation breathing).
Always-warm Whisper server keeps latency under 1 s end-to-end. Live overlay
shows transcription as you speak. VAD auto-stops after ~2 s of silence.

## Language / Runtime

Python 3.10+. Key dependencies: `faster-whisper` (on-device transcription),
`sounddevice` (audio capture), `numpy`, `ollama` (optional cleanup pass),
`pystray` (tray icon).

## Platforms

Windows (native, WinRT audio capture, AutoHotkey for hotkey registration) and
Linux (PulseAudio capture, xdotool for paste).

## Test command

No automated tests — the tool is validated by manual smoke testing.

```
echo "No tests"
```

## Install / Deploy

- **Linux:** `linux/install.sh` — installs python3-venv, sets up systemd user
  service for transcribe_server.py + recorder.py
- **Windows:** `.\windows\install.ps1` — installs Python + deps, registers
  scheduled tasks for server + recorder
- Audio streaming: recorder streams chunks to transcribe_server via TCP
- Cleanup pass: optional Ollama endpoint at `http://localhost:11434`