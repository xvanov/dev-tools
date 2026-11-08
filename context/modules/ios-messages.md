# Module: ios-messages

**Path:** `ios-messages/`

## Purpose

Decrypt messages from an iPhone backup (iMazing/iTunes), export every conversation as text, sort property chats into tenants / landlords / contractors (house group chats included), and pseudonymize them consistently across chats.

## Key files

| File | Role |
|------|------|
| `ios-messages.py` | CLI entry point — `pipeline`, `export`, `anonymize` commands. |
| `ios_messages/` | Library package with decryption, export, and anonymization logic. |
| `tests/` | Test suite. |
| `requirements.txt` | Python dependencies. |

## Tech

- Python
- Processes iPhone backup data (iMazing/iTunes format)
- Pseudonymization for privacy-preserving export