# keep-awake — Windows Session Awake Utility

## What it does

Prevents a Windows machine from sleeping or locking by simulating an F15
keystroke via a scheduled task. The approach is the least-intrusive Windows
keepalive trick: F15 is a no-op for every application, but the OS treats any
keystroke as user activity. Runs daily at 08:00 with repetition every 29
minutes — staying inside Windows's 30-minute idle timeout.

## Language / Runtime

PowerShell 5.1+ (uses `System.Windows.Forms.SendKeys`).

## Platforms

Windows only (uses Windows Forms).

## Test command

No automated tests.

```
echo "No tests"
```

## Install / Deploy

- `.\install.ps1` — registers a `keep-awake` daily scheduled task starting at
  08:00, repeating every 29 minutes, and ending at 23:00
- Uninstall: `.\KeepAwake.ps1 --uninstall` or manually delete the task in
  Task Scheduler