# Module: keep-awake

**Path:** `keep-awake/`

## Purpose

Keeps a Windows session awake (F15 tap + execution-state) so it never idle-logs-out. Auto-starts at every logon via a hidden scheduled task.

## Key files

| File | Role |
|------|------|
| `KeepAwake.ps1` | Main script — F15 keystroke + execution-state management. |
| `install.ps1` | Installer — sets up scheduled task for auto-start at logon. |

## Tech

- PowerShell
- Windows scheduled tasks for auto-start