# summarize-recording

Transcribe an audio recording with faster-whisper and summarize it via Azure OpenAI / AI Foundry.

Works for meetings, voice memos, dictation sessions, or any spoken audio. Process one file or batch many and optionally merge summaries.

## Requirements

- Python 3.10+
- Azure OpenAI or AI Foundry endpoint + API key

## Configuration

Create a `.env` file in the **repo root** (or set environment variables):

| Variable | Description |
|---|---|
| `AZURE_OPENAI_ENDPOINT` or `AZURE_FOUNDRY_ENDPOINT` | Endpoint URL |
| `AZURE_OPENAI_API_KEY` or `AZURE_FOUNDRY_API_KEY` | API key |
| `AZURE_OPENAI_DEPLOYMENT` or `AZURE_FOUNDRY_DEPLOYMENT` | Model deployment name |
| `AZURE_OPENAI_API_VERSION` or `AZURE_FOUNDRY_API_VERSION` | API version (default: `2024-05-01-preview`) |

## Install

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Usage

```bash
# Full pipeline: transcribe then summarize
python summarize-recording.py run recording.mp3
python summarize-recording.py run /path/to/recordings/

# Step by step
python summarize-recording.py transcribe recording.mp3
python summarize-recording.py summarize recording.json

# Combine existing summaries into one digest
python summarize-recording.py combine /path/to/recordings/
```

Options: `--force` to redo, `--device cpu` for CPU, `--model tiny` for a smaller model,
`--shortest-first` to get results out of a long batch early. All of these work on both
`transcribe` and `run`.

A `run` over a directory loads the model once and keeps going when a file fails: a bad
file is reported at the end rather than losing the hours of batch already done. A failed
summary leaves its transcript on disk, so re-running only redoes the summary.

On CPU, `large-v3` transcribes dense speech at roughly 1x realtime on a 16-core machine.
Batched inference and thread tuning were measured and make no difference there — the
speedup lives on the GPU, not in these knobs.

## Output

For each audio file `recording.mp3`:

- `recording.json` — aligned segments with timestamps
- `recording.srt` / `recording.vtt` / `recording.txt` — subtitle/text exports
- `recording.summary.md` — AI-generated summary

When processing multiple files, `combined-summary.md` merges them into one digest.
