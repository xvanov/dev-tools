# ios-messages — iPhone Backup Message Export and Analysis

## What it does

Extracts messages from an unencrypted iPhone backup, classifies them by
context (work, personal, etc. via keyword rules or prompting), and anonymizes
them for sharing. Outputs a flat JSONL export. The classify step can use
keyword matching (rule-based) or LLM prompting (OpenAI-compatible). The
anonymize step replaces names, email addresses, and phone numbers with
placeholders to produce shareable transcripts.

## Language / Runtime

Python 3.12+. Key dependencies: `rich`, `prompt-toolkit` (CLI), `openai`,
`python-dotenv`, `ijson` (streaming JSON parsing of iPhone backup
`messages.db` JSON export).

## Platforms

Windows and Linux (requires an unencrypted iPhone backup to be available).

## Test command

```
cd ios-messages && python -m pytest tests/
```

Unit tests cover message parsing, classification rules, and anonymization
patterns.

## Install / Deploy

- `pip install -r requirements.txt` in a Python 3.12+ environment
- The backup must be unencrypted and located at the default iTunes backup
  path (Windows) or manually specified
- Usage: `python ios-messages.py <backup_dir> --classify --anonymize`