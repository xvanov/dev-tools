# disk-janitor

Safe, automatic reclamation of **rebuildable** disk space — package-manager
caches and aged temp/cache files — on a schedule. Windows, Ubuntu and Debian.

It is deliberately conservative. It will never delete your data:

- Only ever deletes **files inside explicitly whitelisted directories**.
- Every target must resolve to a path under `$HOME` or the OS temp dir **and**
  must not be a user-data folder (`Downloads`, `Documents`, `Desktop`,
  `OneDrive`, `.ssh`, repos, …). A target that violates this is skipped with a
  warning — the config cannot be pointed at your home or a drive root.
- Deletes files only once they are older than a per-target age threshold.
- `--dry-run` reports exactly what would be freed and deletes nothing.
- Package caches (pip / uv / npm / yarn / pnpm) are purged via each tool's own
  `cache` command, and only if that tool is installed.

Stdlib-only Python 3.9+ — nothing to `pip install`.

## What it cleans by default

| Default target | Age | OS |
|----------------|-----|----|
| pip / uv / npm / yarn / pnpm caches | n/a (native purge) | all |
| `%LOCALAPPDATA%\Temp`, `%TEMP%` | 7d | Windows |
| `%LOCALAPPDATA%\CrashDumps` | 3d | Windows |
| `%LOCALAPPDATA%\NuGet\v3-cache`, `pip\cache` | 14d | Windows |
| `~/.cache/pip`, `~/.cache/uv` | 14d | Linux |
| `~/.cache/thumbnails` | 7d | Linux |
| `~/.local/share/Trash/*` | 30d | Linux |

Tune everything (paths, ages, thresholds) via a JSON config — see
[`config.example.json`](./config.example.json). Copy it to
`~/.disk-janitor/config.json`.

## Run it manually

```bash
python disk_janitor.py --dry-run   # see what it would free, delete nothing
python disk_janitor.py             # actually clean
```

Every run logs to `~/.disk-janitor/janitor.log`.

## Install as a scheduled job

### Windows (Scheduled Task, hidden, daily + at logon)

```powershell
cd disk-janitor
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install.ps1                 # active cleanup, daily 03:00
.\windows\install.ps1 -DryRun         # report-only task
.\windows\install.ps1 -Time 12:00     # custom time
.\windows\install.ps1 -Uninstall
```

### Ubuntu / Debian (systemd user timer, daily + on boot)

```bash
cd disk-janitor
./linux/install.sh                    # active cleanup
./linux/install.sh --dry-run          # report-only
./linux/install.sh --uninstall
systemctl --user list-timers disk-janitor.timer   # when it next runs
journalctl --user -u disk-janitor.service         # what it did
```

The Linux timer runs even while you're logged out once `loginctl enable-linger`
is set (the installer attempts this).

## Design notes

- **Two-layer safety.** The config lists *what* to clean; `is_safe_target()`
  independently vetoes anything outside `$HOME`/temp, any user-data dir, and any
  path shallower than three components. Both must agree before a file is touched.
- **Locked / in-use files are left alone** — per-file `OSError` is swallowed, so
  a running build or mounted image never breaks a sweep.
- **Idempotent** installers — re-run any time; the task/timer is overwritten.
- Starts in report-only? Install with `-DryRun` / `--dry-run`, read the log for
  a few days, then re-install without the flag.
