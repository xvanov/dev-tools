"""Find an iPhone backup (iMazing or iTunes/Apple Devices) and pull the message
and contact databases out of it, decrypting when the backup is encrypted.

Password lookup order: --password-env variable, then the credential iMazing
saves in Windows Credential Manager ("iMazing/<UDID>"), then an interactive
prompt. The password is never printed or written to disk.
"""
from __future__ import annotations

import getpass
import json
import os
import plistlib
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime

FILES = {
    "sms.db": "Library/SMS/sms.db",
    "AddressBook.sqlitedb": "Library/AddressBook/AddressBook.sqlitedb",
}
SQLITE_MAGIC = b"SQLite format 3\x00"


@dataclass
class Backup:
    path: str
    udid: str
    device: str
    modified: datetime
    encrypted: bool
    source: str  # "imazing-partial", "imazing", "itunes"


def _roots() -> list[tuple[str, str]]:
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
    roots = [
        (os.path.join(appdata, "iMazing", "Caches"), "imazing-partial"),
        (os.path.join(appdata, "iMazing", "Backups"), "imazing"),
        (os.path.join(home, "Documents", "iMazing", "Backups"), "imazing"),
        (os.path.join(appdata, "Apple Computer", "MobileSync", "Backup"), "itunes"),
        (os.path.join(home, "Apple", "MobileSync", "Backup"), "itunes"),
        (os.path.join(home, "Library", "Application Support", "MobileSync", "Backup"), "itunes"),
    ]
    return [r for r in roots if os.path.isdir(r[0])]


def _read_plist(path: str) -> dict:
    try:
        with open(path, "rb") as f:
            return plistlib.load(f)
    except Exception:
        return {}


def find_backups(extra_roots: list[str] | None = None) -> list[Backup]:
    """Every backup folder (one containing Manifest.db + Manifest.plist), newest first."""
    roots = _roots() + [(r, "custom") for r in (extra_roots or [])]
    found: dict[str, Backup] = {}
    for root, source in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath[len(root):].count(os.sep) > 4:
                dirnames[:] = []
                continue
            if "Manifest.db" in filenames and "Manifest.plist" in filenames:
                dirnames[:] = []  # never descend into the 00..ff hash folders
                info = _read_plist(os.path.join(dirpath, "Info.plist"))
                manifest = _read_plist(os.path.join(dirpath, "Manifest.plist"))
                udid = info.get("Unique Identifier") or info.get("Target Identifier") or os.path.basename(dirpath)
                found[os.path.normcase(dirpath)] = Backup(
                    path=dirpath, udid=str(udid), device=str(info.get("Device Name", "")),
                    modified=datetime.fromtimestamp(os.path.getmtime(os.path.join(dirpath, "Manifest.db"))),
                    encrypted=bool(manifest.get("IsEncrypted")), source=source)
    return sorted(found.values(), key=lambda b: b.modified, reverse=True)


def windows_credential(target: str) -> list[str]:
    """Candidate decodings of a Generic credential's secret (UTF-16 and UTF-8)."""
    if sys.platform != "win32":
        return []
    import ctypes
    import ctypes.wintypes as wt

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("TargetName", wt.LPWSTR),
                    ("Comment", wt.LPWSTR), ("LastWritten", wt.FILETIME),
                    ("CredentialBlobSize", wt.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                    ("Persist", wt.DWORD), ("AttributeCount", wt.DWORD),
                    ("Attributes", ctypes.c_void_p), ("TargetAlias", wt.LPWSTR),
                    ("UserName", wt.LPWSTR)]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    p = ctypes.POINTER(CREDENTIAL)()
    if not advapi.CredReadW(target, 1, 0, ctypes.byref(p)):
        return []
    try:
        raw = bytes(p.contents.CredentialBlob[:p.contents.CredentialBlobSize])
    finally:
        advapi.CredFree(p)
    out = []
    for enc in ("utf-16-le", "utf-8"):
        try:
            s = raw.decode(enc)
            if s and s not in out:
                out.append(s)
        except UnicodeDecodeError:
            pass
    return out


def _passwords(backup: Backup, password_env: str | None):
    if password_env and os.environ.get(password_env):
        yield os.environ[password_env]
    yield from windows_credential(f"iMazing/{backup.udid}")
    if sys.stdin.isatty():
        yield getpass.getpass(f"Backup password for {backup.device or backup.udid}: ")


def _extract_plain(backup: Backup, out_dir: str) -> list[str]:
    db = sqlite3.connect(os.path.join(backup.path, "Manifest.db"))
    got = []
    for name, rel in FILES.items():
        row = db.execute("select fileID from Files where domain='HomeDomain' and relativePath=?",
                         (rel,)).fetchone()
        if row:
            shutil.copyfile(os.path.join(backup.path, row[0][:2], row[0]), os.path.join(out_dir, name))
            got.append(name)
    db.close()
    return got


def _extract_encrypted(backup: Backup, out_dir: str, password_env: str | None) -> list[str]:
    try:
        from iphone_backup_decrypt import EncryptedBackup
    except ImportError:
        raise SystemExit("Encrypted backup: pip install -r requirements.txt (iphone_backup_decrypt)")
    eb, errors = None, []
    for pw in _passwords(backup, password_env):
        try:
            candidate = EncryptedBackup(backup_directory=backup.path, passphrase=pw)
            candidate.test_decryption()
            eb = candidate
            break
        except (OSError, MemoryError):
            raise  # a disk or read problem is not a wrong password
        except Exception as e:
            errors.append(type(e).__name__)
    if eb is None:
        raise SystemExit("Could not unlock the backup: no working password "
                         f"(tried ${password_env or '-'}, Credential Manager iMazing/{backup.udid}, prompt; "
                         f"errors: {', '.join(errors) or 'none'}).")
    got = []
    for name, rel in FILES.items():
        try:
            eb.extract_file(relative_path=rel, domain_like="HomeDomain",
                            output_filename=os.path.join(out_dir, name))
            got.append(name)
        except Exception as e:  # a partial backup may lack AddressBook
            print(f"  skip {name}: {type(e).__name__}", file=sys.stderr)
    return got


def extract(backup: Backup, out_dir: str, password_env: str | None = None) -> dict:
    """Decrypt into a fresh folder and swap it in only when everything worked, so
    a wrong password never destroys the last good extraction, and a backup without
    contacts never leaves stale ones behind."""
    final_dir, out_dir = out_dir, out_dir.rstrip("\\/") + ".new"
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    try:
        return _extract_into(backup, out_dir, final_dir, password_env)
    except BaseException:
        shutil.rmtree(out_dir, ignore_errors=True)  # never leave a half-decrypted db.new behind
        raise


def _extract_into(backup: Backup, out_dir: str, final_dir: str, password_env: str | None) -> dict:
    got = (_extract_encrypted(backup, out_dir, password_env) if backup.encrypted
           else _extract_plain(backup, out_dir))
    if "sms.db" not in got:
        raise SystemExit("sms.db not found in backup")
    for name in got:
        with open(os.path.join(out_dir, name), "rb") as f:
            if f.read(16) != SQLITE_MAGIC:
                raise SystemExit(f"{name} did not decrypt to a SQLite file")
    info = _read_plist(os.path.join(backup.path, "Info.plist"))
    meta = {
        "udid": backup.udid, "device": backup.device, "source": backup.source,
        "backup_path": backup.path, "backup_modified": backup.modified.isoformat(),
        "extracted": datetime.now().isoformat(timespec="seconds"),
        "owner_phone": str(info.get("Phone Number", "")),
        "files": got,
    }
    with open(os.path.join(out_dir, "backup-info.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    old_dir = final_dir.rstrip("\\/") + ".old"
    if os.path.isdir(old_dir):
        shutil.rmtree(old_dir)
    if os.path.isdir(final_dir):
        os.replace(final_dir, old_dir)
    os.replace(out_dir, final_dir)
    shutil.rmtree(old_dir, ignore_errors=True)
    return meta
