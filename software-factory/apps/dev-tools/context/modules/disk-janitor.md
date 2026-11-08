# disk-janitor — Automated Disk Space Reclamation

## What it does

Reclaims rebuildable disk space on a schedule: package-manager caches (pip, uv,
npm, yarn, pnpm, purged through each tool's own `cache` command when installed)
and aged files in whitelisted temp/cache directories (`%TEMP%`, `CrashDumps`,
NuGet and pip caches on Windows; `~/.cache/pip`, `~/.cache/uv`, thumbnails and
the Trash on Linux), each with an age threshold. Two-layer safety: the config
lists what to clean, and `is_safe_target()` independently vetoes anything outside
`$HOME`/the temp dir, any user-data folder (Downloads, Documents, repos, `.ssh`,
...) and any too-shallow path. Symlinks and junctions are never followed. It
never cleans repos or user data; when free space stays low it logs where the
space is instead. Optional JSON config (paths, ages, thresholds):
`~/.disk-janitor/config.json`; log: `~/.disk-janitor/janitor.log`.

## Language / Runtime

Python 3.9+ (stdlib only — no pip dependencies needed).

## Platforms

Windows (scheduled task) and Ubuntu/Debian (systemd user timer).

## Test command

None. disk-janitor has no tests and no CI job (the `build` job covers only
`ptyd/`, `desktop/` and `scripts/build.js`). Check a change by hand:
`python disk_janitor.py --dry-run` reports what would be freed and deletes
nothing.

## Install / Deploy

- **Windows:** `.\windows\install.ps1` — hidden scheduled task, daily at 03:00
  and at logon (`-DryRun` for a report-only task, `-Time`, `-Uninstall`)
- **Linux:** `./linux/install.sh` — systemd user timer, daily and on boot
  (`--dry-run`, `--uninstall`)
- A plain run (`python disk_janitor.py`) cleans; `--dry-run` only reports;
  `--space-report` forces the where-is-the-space report.
