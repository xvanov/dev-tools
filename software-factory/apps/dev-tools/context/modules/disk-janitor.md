# disk-janitor — Automated Disk Space Reclamation

## What it does

Runs nightly via a scheduled task / systemd timer and deletes whitelisted files.
Safe by design: targets only paths explicitly listed in the config (`TARGETS`
variable), and lists everything it plans to delete (non-destructive dry-run by
default). Default targets: `node_modules/`, `target/`, `.next/`, `__pycache__/`,
`<repo>/.git/objects/` (loose objects after `git gc`), and npm/Bun caches
older than 30 days.

## Language / Runtime

Python 3.9+ (stdlib only — no pip dependencies needed).

## Platforms

Windows (scheduled task) and Linux (systemd timer).

## Test command

No dedicated test suite. The script is stdlib-only Python and tested via CI's
build job using conformance checks.

```
echo "No tests — stdlib only"
```

## Install / Deploy

- **Windows:** `.\windows\install.ps1` — registers `disk-janitor` daily
  scheduled task (10:00 AM) with `--confirm` flag
- **Linux:** `linux/install.sh` — writes systemd timer + service units
- Default run: dry-run mode (lists only). Pass `--confirm` to actually delete.
- Safe guards: only deletes paths in `TARGETS`; requires `--confirm` to act.