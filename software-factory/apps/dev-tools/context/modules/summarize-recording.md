# summarize-recording — Audio Transcription and Summarization

## What it does

A CLI tool that transcribes audio files (MP4, WAV, M4A, MP3, AAC, OGG) via
faster-whisper and summarises them via Azure OpenAI. Takes a file path,
outputs: full transcript (to file or stdout), a punchpoint summary (list of
key points with timestamps), and action items. Designed for meeting recordings
and voice notes.

## Language / Runtime

Python 3.10+. Key dependencies: `faster-whisper`, `openai` (Azure API), `ffmpeg`
(for audio format conversion).

## Platforms

Windows and Linux (requires ffmpeg on PATH).

## Test command

No automated tests.

```
echo "No tests"
```

## Install / Deploy

- Setup: `pip install -r requirements.txt` in an environment with ffmpeg
- Configuration: Azure OpenAI endpoint + key in environment variables or `.env`
- Usage: `python summarize-recording.py <file>` generates transcript + summary
  + action items in markdown