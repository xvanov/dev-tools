#!/usr/bin/env python3
"""disk-janitor — safe, automatic reclamation of rebuildable disk space.

Runs on a schedule (Windows Scheduled Task / Linux systemd timer) and frees
space that is *cheap to rebuild*: package-manager caches and aged files inside
temp / cache directories. It is deliberately conservative:

  * It only ever deletes **files inside explicitly whitelisted directories**.
  * Every target must resolve to a path under $HOME or the OS temp dir, and must
    NOT be a user-data folder (Downloads, Documents, Desktop, ...). Any target
    that violates this is skipped with a warning — the config cannot be talked
    into deleting your home directory.
  * Files are only deleted once older than a per-target age threshold.
  * `--dry-run` reports exactly what would be freed without deleting anything.

Stdlib only — no pip install needed. Works on Windows, Ubuntu and Debian with
a system python3.

Usage:
    python disk_janitor.py            # run cleanup
    python disk_janitor.py --dry-run  # report only, delete nothing
    python disk_janitor.py --report   # alias for --dry-run
    python disk_janitor.py --config /path/to/config.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# --------------------------------------------------------------------------- #
# Defaults. Override any key via a JSON file (see --config / ~/.disk-janitor). #
# --------------------------------------------------------------------------- #

DEFAULT_CONFIG = {
    # Informational: logged, and used to decide whether to shout in the log.
    "min_free_percent": 10,
    # Rotate the log when it grows past this many bytes.
    "log_max_bytes": 5_000_000,

    # Package-manager caches. Each entry runs `argv` iff `check` is on PATH.
    # These re-download instantly from their registries, so they are safe to
    # purge wholesale.
    "package_caches": [
        {"name": "pip",  "check": "pip",  "argv": ["pip", "cache", "purge"]},
        {"name": "uv",   "check": "uv",   "argv": ["uv", "cache", "clean"]},
        {"name": "npm",  "check": "npm",  "argv": ["npm", "cache", "clean", "--force"]},
        {"name": "yarn", "check": "yarn", "argv": ["yarn", "cache", "clean"]},
        {"name": "pnpm", "check": "pnpm", "argv": ["pnpm", "store", "prune"]},
    ],

    # Age-based cleanup. Delete files whose mtime is older than min_age_days,
    # but only inside these directories. `platforms` gates by OS.
    "age_targets": [
        # -- Windows ------------------------------------------------------- #
        {"path": r"%LOCALAPPDATA%\Temp",           "min_age_days": 7,  "platforms": ["windows"]},
        {"path": r"%TEMP%",                        "min_age_days": 7,  "platforms": ["windows"]},
        {"path": r"%LOCALAPPDATA%\CrashDumps",     "min_age_days": 3,  "platforms": ["windows"]},
        {"path": r"%LOCALAPPDATA%\NuGet\v3-cache", "min_age_days": 14, "platforms": ["windows"]},
        {"path": r"%LOCALAPPDATA%\pip\cache",      "min_age_days": 14, "platforms": ["windows"]},
        # -- Linux (Ubuntu / Debian) --------------------------------------- #
        {"path": "~/.cache/pip",                   "min_age_days": 14, "platforms": ["linux"]},
        {"path": "~/.cache/uv",                    "min_age_days": 14, "platforms": ["linux"]},
        {"path": "~/.cache/thumbnails",            "min_age_days": 7,  "platforms": ["linux"]},
        {"path": "~/.local/share/Trash/files",     "min_age_days": 30, "platforms": ["linux"]},
        {"path": "~/.local/share/Trash/info",      "min_age_days": 30, "platforms": ["linux"]},
    ],
}

WINDOWS = os.name == "nt"
PLATFORM = "windows" if WINDOWS else "linux"

# Directories that must never be cleaned, even if a config target points at them.
_HOME = Path.home()
USER_DATA_DIRS = [
    _HOME / name for name in (
        "Downloads", "Documents", "Desktop", "Pictures", "Videos", "Music",
        "OneDrive", "Dropbox", "Google Drive", ".ssh", ".gnupg", ".config",
        "source", "repos", "src", "Projects", "code",
    )
]


# --------------------------------------------------------------------------- #
# Logging                                                                      #
# --------------------------------------------------------------------------- #

class Logger:
    def __init__(self, path: Path, max_bytes: int):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            if self.path.exists() and self.path.stat().st_size > max_bytes:
                # keep one previous generation
                self.path.replace(self.path.with_suffix(".log.1"))
        except OSError:
            pass
        self._fh = open(self.path, "a", encoding="utf-8")

    def __call__(self, msg: str) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"{stamp}  {msg}"
        print(line)
        try:
            self._fh.write(line + "\n")
            self._fh.flush()
        except OSError:
            pass

    def close(self) -> None:
        try:
            self._fh.close()
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #

def human(nbytes: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(nbytes) < 1024.0:
            return f"{nbytes:,.1f} {unit}"
        nbytes /= 1024.0
    return f"{nbytes:,.1f} PB"


def expand(raw: str) -> Path:
    """Expand %VARS% / $VARS and ~ into an absolute, resolved path."""
    return Path(os.path.expandvars(os.path.expanduser(raw))).resolve()


def temp_roots() -> list[Path]:
    roots = []
    for var in ("TMPDIR", "TEMP", "TMP"):
        val = os.environ.get(var)
        if val:
            try:
                roots.append(Path(val).resolve())
            except OSError:
                pass
    for fixed in ("/tmp", "/var/tmp"):
        p = Path(fixed)
        if p.exists():
            roots.append(p.resolve())
    return roots


def is_safe_target(path: Path, log) -> bool:
    """Hard invariant: a cleanable dir must live under $HOME or a temp root and
    must not be (or sit inside) a user-data directory or a filesystem root."""
    try:
        resolved = path.resolve()
    except OSError:
        return False

    # Reject roots and absurdly shallow paths.
    if resolved == resolved.anchor or len(resolved.parts) < 3:
        log(f"  SKIP  refusing shallow/root path: {resolved}")
        return False

    home = _HOME.resolve()
    allowed_bases = [home, *temp_roots()]
    if not any(resolved == b or b in resolved.parents for b in allowed_bases):
        log(f"  SKIP  outside $HOME and temp roots: {resolved}")
        return False

    for guarded in USER_DATA_DIRS:
        try:
            g = guarded.resolve()
        except OSError:
            continue
        if resolved == g or g in resolved.parents or resolved in g.parents:
            log(f"  SKIP  user-data / protected dir: {resolved}")
            return False

    return True


def free_bytes(path: Path) -> tuple[int, int]:
    usage = shutil.disk_usage(path)
    return usage.free, usage.total


# --------------------------------------------------------------------------- #
# Cleanup steps                                                                #
# --------------------------------------------------------------------------- #

def run_package_caches(cfg, log, dry_run) -> None:
    log("-- package-manager caches --")
    for entry in cfg.get("package_caches", []):
        exe = shutil.which(entry["check"])
        if not exe:
            continue
        argv = entry["argv"]
        if dry_run:
            log(f"  WOULD RUN  {' '.join(argv)}")
            continue
        try:
            if WINDOWS:
                # npm/yarn/pnpm are .cmd/.ps1 shims that CreateProcess can't run
                # by bare name; let the shell resolve them.
                res = subprocess.run(" ".join(argv), shell=True,
                                     capture_output=True, text=True, timeout=300)
            else:
                argv = [exe, *argv[1:]]
                res = subprocess.run(argv, capture_output=True, text=True, timeout=300)
            tail = (res.stdout or res.stderr or "").strip().splitlines()
            note = tail[-1] if tail else "(no output)"
            log(f"  {entry['name']}: {note}")
        except (subprocess.SubprocessError, OSError) as e:
            log(f"  {entry['name']}: FAILED - {e}")


def clean_by_age(cfg, log, dry_run) -> int:
    log("-- aged temp / cache files --")
    now = time.time()
    total_freed = 0

    for target in cfg.get("age_targets", []):
        if PLATFORM not in target.get("platforms", ["windows", "linux"]):
            continue
        base = expand(target["path"])
        if not base.exists():
            continue
        if not is_safe_target(base, log):
            continue

        cutoff = now - target["min_age_days"] * 86400
        freed_here = 0
        removed = 0
        for root, dirs, files in os.walk(base, topdown=False):
            root_path = Path(root)
            for fname in files:
                fpath = root_path / fname
                try:
                    st = fpath.lstat()
                    if st.st_mtime >= cutoff:
                        continue
                    size = st.st_size
                    if dry_run:
                        freed_here += size
                        removed += 1
                        continue
                    fpath.unlink()
                    freed_here += size
                    removed += 1
                except OSError:
                    continue  # locked / in-use / permission — leave it
            # prune now-empty subdirs (never the base itself)
            if not dry_run and root_path != base:
                try:
                    root_path.rmdir()
                except OSError:
                    pass

        if removed:
            verb = "would free" if dry_run else "freed"
            log(f"  {base}  (> {target['min_age_days']}d): "
                f"{verb} {human(freed_here)} in {removed} files")
        total_freed += freed_here

    return total_freed


# --------------------------------------------------------------------------- #
# Config loading                                                               #
# --------------------------------------------------------------------------- #

def load_config(path: Path | None, log) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    candidates = []
    if path:
        candidates.append(path)
    candidates.append(_HOME / ".disk-janitor" / "config.json")
    for c in candidates:
        try:
            if c and c.exists():
                user = json.loads(c.read_text(encoding="utf-8"))
                cfg.update(user)
                log(f"config: merged overrides from {c}")
                break
        except (OSError, json.JSONDecodeError) as e:
            log(f"config: ignoring {c} — {e}")
    return cfg


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Safe automatic disk cleanup.")
    ap.add_argument("--dry-run", "--report", action="store_true", dest="dry_run",
                    help="report what would be freed; delete nothing")
    ap.add_argument("--config", type=Path, default=None,
                    help="path to a JSON config file (overrides defaults)")
    ap.add_argument("--log", type=Path,
                    default=_HOME / ".disk-janitor" / "janitor.log",
                    help="log file path")
    args = ap.parse_args(argv)

    log = Logger(args.log, DEFAULT_CONFIG["log_max_bytes"])
    try:
        mode = "DRY-RUN" if args.dry_run else "RUN"
        log(f"==== disk-janitor {mode} on {PLATFORM} ====")

        cfg = load_config(args.config, log)
        anchor = _HOME
        before, total = free_bytes(anchor)
        pct = 100 * before / total if total else 0
        flag = "  ** below threshold **" if pct < cfg.get("min_free_percent", 10) else ""
        log(f"free before: {human(before)} / {human(total)} ({pct:.1f}%){flag}")

        run_package_caches(cfg, log, args.dry_run)
        aged = clean_by_age(cfg, log, args.dry_run)

        after, _ = free_bytes(anchor)
        if args.dry_run:
            log(f"would reclaim ~ {human(aged)} from aged files "
                f"(+ package caches, not measured in dry-run)")
        else:
            log(f"free after:  {human(after)} ({100*after/total:.1f}%)  "
                f"- reclaimed ~ {human(after - before)}")
        log("==== done ====")
        return 0
    finally:
        log.close()


if __name__ == "__main__":
    sys.exit(main())
