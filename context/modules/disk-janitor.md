# Module: disk-janitor

**Path:** `disk-janitor/`

## Purpose

Safe, scheduled reclamation of rebuildable disk space (package caches + aged temp/cache). Whitelist-only, never touches user data. Supports Windows and Ubuntu/Debian.

## Key files

| File | Role |
|------|------|
| `disk_janitor.py` | Main janitor logic — cache cleanup, temp file reclamation. |
| `windows/` | Windows-specific cleanup rules and installer. |
| `linux/` | Linux-specific cleanup rules and installer. |

## Tech

- Python
- Platform-specific cleanup targets (whitelist only)