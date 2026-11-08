# Module: voice-dictation

**Path:** `voice-dictation/`

## Purpose

Push-to-talk voice transcription via faster-whisper → auto-paste at cursor. Runs on both Windows and Linux.

## Key files

| File | Role |
|------|------|
| `recorder.py` | Audio recorder — push-to-talk, silence detection, auto-stop. |
| `overlay.py` | Screen overlay for recording status indication. |
| `transcribe.py` | Transcription via faster-whisper. |
| `transcribe_server.py` | Transcription server for warm-model mode. |
| `transcribe_client.py` | Client for the transcription server. |
| `llm_cleanup.py` | LLM-based transcript cleanup/normalization. |
| `history.py` | Dictation history management. |
| `linux/` | Linux installer (`install.sh`). |
| `windows/` | Windows installer (`install.ps1`). |
| `requirements.txt` | Python dependencies. |

## Tech

- Python
- faster-whisper for local transcription
- Hotkey binding (Ctrl+Alt+V) for push-to-talk