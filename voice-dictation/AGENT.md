# AGENT.md - install instructions for coding agents

This document is the source of truth for installing voice-dictation on a fresh
machine. It is written for an autonomous coding agent (Claude Code, Cursor,
etc.). Follow it top to bottom for the target platform. Stop and report when a
step requires the human (interactive auth, BIOS, etc.).

The end state is: pressing `Ctrl+Alt+V` opens a live-preview overlay, records
audio via VAD auto-stop, and pastes the LLM-cleaned transcript at the cursor.
Pressing `Esc` cancels. Pressing `Ctrl+Alt+V` a second time stops recording
early and proceeds to transcription.

## Decision tree

1. Detect the platform: `uname` -> Linux, or `$PSVersionTable` -> Windows.
2. Detect GPU: `nvidia-smi` -> CUDA, else fall back to CPU (`WHISPER_DEVICE=cpu`,
   `WHISPER_COMPUTE=int8`).
3. Run the platform-specific section below.
4. Run the **Verification** section.

---

## Linux (Ubuntu 22.04+ / GNOME / X11)

### Prerequisites the user must have

- `sudo` access (needed for `apt-get install portaudio19-dev xdotool python3-tk`).
- An NVIDIA driver if GPU mode is desired. The agent must **not** install
  drivers; if `nvidia-smi` fails, switch to CPU and warn the user.

### Steps

1. **Install OS dependencies** (skip any already present):
   ```bash
   sudo apt-get update
   sudo apt-get install -y python3 python3-venv portaudio19-dev xdotool python3-tk libnotify-bin
   ```

2. **Clone the repo** (the agent should have done this already to read this file):
   ```bash
   git clone https://github.com/xvanov/dev-tools.git ~/dev-tools
   cd ~/dev-tools/voice-dictation
   ```

3. **Run the installer**:
   ```bash
   ./linux/install.sh
   ```
   - Creates `~/.local/voice-dictation/venv`, pip-installs all deps including
     `sounddevice`, `soundfile`, `pyperclip`, `requests`.
   - (If GPU) installs `nvidia-cudnn-cu12 nvidia-cublas-cu12`.
   - Installs a systemd --user service `voice-dictation.service` and starts it.
   - For CPU-only install, prefix: `INSTALL_GPU=0 WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8`.

4. **Bind the global hotkey**:
   ```bash
   SCHEMA=org.gnome.settings-daemon.plugins.media-keys
   PATHKEY=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/voice-dictation/
   gsettings set $SCHEMA custom-keybindings "['$PATHKEY']"
   gsettings set $SCHEMA.custom-keybinding:$PATHKEY name 'Voice Dictation'
   gsettings set $SCHEMA.custom-keybinding:$PATHKEY command "$HOME/.local/voice-dictation/voice-toggle.sh"
   gsettings set $SCHEMA.custom-keybinding:$PATHKEY binding '<Ctrl><Alt>v'
   ```
   If `gsettings` is unavailable, tell the user to bind the hotkey manually.

5. **Verify** (see Verification section below).

6. **Optional — LLM cleanup pass**: install Ollama and pull a model:
   ```bash
   curl -fsSL https://ollama.ai/install.sh | sh
   ollama pull llama3.2
   ```
   Set `OLLAMA_MODEL=<model>` in the systemd unit or shell env to use a
   different model. If Ollama is not running, recorder.py falls back to the
   raw transcript automatically.

### Common Linux failure modes

- `sounddevice` raises `PortAudioError: No Default Input Device` → user is in
  the wrong audio group: `sudo usermod -aG audio $USER`, then re-login.
- `xdotool` not found → auto-paste silently skips; install `xdotool` manually.
- Overlay doesn't appear → `python3-tk` missing; `sudo apt-get install python3-tk`.
- First transcription fails with `Could not load library libcudnn_ops.so.9` →
  `~/.local/voice-dictation/venv/bin/pip install --force-reinstall nvidia-cudnn-cu12 nvidia-cublas-cu12`.
- Hotkey fires but nothing happens → confirm the custom shortcut path is
  correct and that `python3` and `sounddevice` deps are installed in the venv.

---

## Windows 10 / 11

### Prerequisites the user must have

- A working `winget` (preinstalled on Win 11; on Win 10 install "App Installer"
  from the Microsoft Store).
- Local admin rights for the first run (winget installs Python / AutoHotkey
  machine-wide).
- An NVIDIA driver if GPU mode is desired.

### Steps

1. **Clone the repo**:
   ```powershell
   git clone https://github.com/xvanov/dev-tools.git $env:USERPROFILE\dev-tools
   cd $env:USERPROFILE\dev-tools\voice-dictation
   ```

2. **Open an elevated PowerShell** and run the installer:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\windows\install.ps1
   ```
   The installer will:
   - Install Python 3.11 and AutoHotkey v2 via winget if missing.
   - Create a venv at `%LOCALAPPDATA%\voice-dictation\venv`.
   - Pip-install all deps: `faster-whisper`, `sounddevice`, `soundfile`,
     `numpy`, `pyperclip`, `requests`, and (GPU) CUDA runtime DLLs.
   - Register scheduled task `VoiceDictationServer` at logon.
   - Copy `voice-toggle.ahk` to startup and launch it immediately.

3. **CPU-only install**:
   ```powershell
   $env:WHISPER_DEVICE  = 'cpu'
   $env:WHISPER_COMPUTE = 'int8'
   .\windows\install.ps1
   ```

4. **Verify** (see Verification section below).

5. **Optional — LLM cleanup pass**: download and install Ollama from
   `https://ollama.ai`, then run `ollama pull llama3.2` in a terminal.
   Set `OLLAMA_MODEL` in `start-server.bat` (or as a user env var) to
   change the model. Falls back to raw transcript if Ollama is not running.

### Common Windows failure modes

- `winget` not found → install "App Installer" from Microsoft Store and retry.
- `sounddevice` raises `PortAudioError` on first recording → sounddevice ships
  its own PortAudio on Windows; if it still fails, check that the microphone
  is not disabled in Sound settings (Control Panel → Sound → Recording).
- Scheduled task shows "0x41301" (still running) but transcripts return
  empty → CUDA DLLs missing. Activate the venv and run:
  `pip install --force-reinstall nvidia-cudnn-cu12 nvidia-cublas-cu12`.
- The first model download stalls behind a corporate proxy → set
  `HF_HUB_ETAG_TIMEOUT=30` and `HTTPS_PROXY` in the task's environment.
- Hotkey doesn't fire → another app is bound to `Ctrl+Alt+V`. Edit
  `%LOCALAPPDATA%\voice-dictation\voice-toggle.ahk`, change `^!v::` to
  something else (e.g. `^!d::`) and restart AutoHotkey.
- Overlay flashes and disappears → tkinter DLLs missing from the venv; this
  should not happen with Python 3.11 from winget. If it does, reinstall Python.
- Overlay shows `<model>/cpu` although `nvidia-smi` works → the running server
  fell back to CPU after a GPU error. Read
  `%LOCALAPPDATA%\voice-dictation\server.log` for the original error, then
  restart the server (kill the python process owning port 47821; the
  `server-loop.bat` watchdog relaunches it). The fallback expires by itself
  after `CUDA_RETRY_SEC` (default 600 s).

---

## Verification (both platforms)

1. **Server is up**:
   - Linux: `systemctl --user is-active voice-dictation` → `active`.
   - Windows: `schtasks /Query /TN VoiceDictationServer /V /FO LIST` → Last
     Result `0` or `0x41301`.

2. **Server responds**: record a 2-second clip and pipe it through the client.
   - Linux:
     ```bash
     python3 -c "
     import sounddevice as sd, soundfile as sf, numpy as np
     data = sd.rec(32000, samplerate=16000, channels=1, dtype='int16')
     sd.wait()
     sf.write('/tmp/test.wav', data, 16000, subtype='PCM_16')
     "
     ~/.local/voice-dictation/venv/bin/python \
       ~/.local/voice-dictation/transcribe_client.py /tmp/test.wav
     ```
   - Windows (PowerShell):
     ```powershell
     & "$env:LOCALAPPDATA\voice-dictation\venv\Scripts\python.exe" -c @"
     import sounddevice as sd, soundfile as sf
     data = sd.rec(32000, samplerate=16000, channels=1, dtype='int16')
     sd.wait()
     sf.write(r'$env:TEMP\test.wav', data, 16000, subtype='PCM_16')
     "@
     & "$env:LOCALAPPDATA\voice-dictation\venv\Scripts\python.exe" `
       "$env:LOCALAPPDATA\voice-dictation\transcribe_client.py" "$env:TEMP\test.wav"
     ```
   - First call may take 10–30 s while the model loads.

3. **Hotkey works end-to-end**: press `Ctrl+Alt+V`, say "this is a test", then
   stop speaking and wait — the overlay should auto-stop after ~2 s of silence,
   show "Transcribing…", then "Done", and paste the text at your cursor.
   Alternatively, press `Ctrl+Alt+V` a second time to stop manually.

4. **Cancel works**: press `Ctrl+Alt+V`, speak briefly, press `Esc` — overlay
   closes with "Cancelled" and nothing is pasted.

If all four checks pass, report success and stop.

---

## Tuning

| Env var | Default | Notes |
|---|---|---|
| `WHISPER_MODEL` | `small` (Linux) / `medium` (Win) | `tiny`/`base`/`small`/`medium`/`large-v3` |
| `WHISPER_DEVICE` | `cuda` | `cpu` for no-GPU machines |
| `WHISPER_COMPUTE` | `float16` | CPU: use `int8` |
| `VD_SILENCE_THRESHOLD` | `0.01` | RMS cutoff (0–1). Raise in noisy environments |
| `VD_SILENCE_DURATION` | `2.0` | Seconds of silence to trigger auto-stop |
| `VD_MAX_DURATION` | `120.0` | Hard cap in seconds |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `llama3.2` | Any model pulled via `ollama pull` |
| `CUDA_RETRY_SEC` | `600` | Seconds on CPU after a GPU error before retrying CUDA |
| `VD_SERVER_LOG` | `server.log` beside the script | Server log; only record of a CPU fallback |

---

## Updating

`git pull` in the cloned repo, then re-run the installer. It is idempotent and
reuses the existing venv and model cache.

## Uninstall

- Linux: `~/dev-tools/voice-dictation/linux/uninstall.sh`
- Windows: `.\windows\uninstall.ps1` from an elevated PowerShell.

Both leave the model cache (`~/.cache/huggingface`) intact. Delete it manually
to reclaim disk space.

---

## What the agent should NOT do

- Do not install NVIDIA drivers.
- Do not modify global / system Python; everything goes in the venv.
- Do not change the hotkey binding without telling the user.
- Do not commit any files from `~/.cache/huggingface` to git.
- Do not edit `transcribe_server.py` to add non-loopback network bindings.
