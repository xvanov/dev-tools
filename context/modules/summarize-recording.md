# Module: summarize-recording

**Path:** `summarize-recording/`

## Purpose

Transcribe and summarize audio recordings via Azure OpenAI (or Azure Foundry). CLI tool for batch processing of audio files.

## Key files

| File | Role |
|------|------|
| `summarize-recording.py` | CLI entry point — `run` command for processing a recording. |
| `summarize_recording/` | Library package with transcription and summarization logic. |
| `requirements.txt` | Python dependencies (Azure OpenAI, etc.). |

## Tech

- Python
- Azure OpenAI / Azure Foundry for transcription and summarization