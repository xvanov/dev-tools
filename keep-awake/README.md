# keep-awake

Keeps a Windows session awake so it never registers as idle and never gets
logged out or locked by idle/sleep policy.

Taps the harmless **F15** key every 59 seconds and tells Windows the system is
in use (`SetThreadExecutionState`). Nothing visible is typed, no mouse moves,
no window is focused. A single-instance mutex prevents duplicate copies.

## Requirements

- Windows + Windows PowerShell 5.1 (built in)

## Install

```powershell
cd keep-awake
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Starts immediately and auto-starts at every logon (hidden, no window).

## Uninstall

```powershell
.\install.ps1 -Uninstall
```

Removes the scheduled task, stops the running process, deletes the copy.

## What it does

`install.ps1`:
1. Copies `KeepAwake.ps1` to `~/.keep-awake/`
2. Registers a per-user scheduled task `KeepAwake` triggered at logon, running
   the script hidden via `powershell.exe -WindowStyle Hidden`
3. Starts the task now

## Run manually (no install)

```powershell
.\KeepAwake.ps1
```

Leave the window open (or minimize). Press `Ctrl+C` or close it to stop.

## Notes

- Idle policy enforced by Group Policy / screensaver-with-password may still
  lock the screen on some managed machines; F15 + execution-state covers the
  common idle-logout and sleep cases.
- F15 is chosen because no physical keyboard sends it, so it won't collide with
  anything you type.
