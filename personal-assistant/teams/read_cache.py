"""Reads new Teams messages from the new Teams client's local IndexedDB cache.

The new Teams (MSTeams package) is a WebView2 app that keeps chats and
channel posts in Chromium IndexedDB, which is LevelDB on disk. Teams holds
that directory open, so nothing here writes to it, locks it, or keeps a file
open: every source file is opened read-only with all share flags (so Teams
can still rotate and delete it), tables and blobs are copied to --work and
parsed there, and the work directory is removed at the end.

Parsing all ~100 MB in pure Python takes five to ten minutes, which rules out
a full read per tick. It is also unnecessary: LevelDB writes every change to
its append-only write-ahead `.log` first, and only later compacts it into
`.ldb` tables. So a pass reads the log from where the last pass stopped
(--log NAME:OFFSET; a few KB) plus any `.ldb` table numbered above --after-ldb
(what a flush or compaction wrote since), oldest first and capped by
--max-ldb. On the first pass only the log is read: history is the
connector's job.

Records are recognised by shape, not by database name, so there is no
metadata scan: a reply chain has a `messageMap`, a conversation has
`threadProperties` and `members`. Both tenants' databases are read alike.

Output is JSON lines on stdout -- `msg`, `conv`, then one `status` -- and
nothing else. Message bodies go to the caller, never to stderr or a log.

Usage: read_cache.py --src DIR [--blobs DIR] --work DIR [--since-ms N]
                     [--after-ldb N] [--max-ldb N]
"""

import argparse
import glob
import io
import json
import os
import pathlib
import shutil
import struct
import sys
import time

from ccl_chromium_reader import ccl_chromium_indexeddb as idb
from ccl_chromium_reader.serialization_formats import ccl_blink_value_deserializer, ccl_v8_value_deserializer
from ccl_chromium_reader.storage_formats import ccl_leveldb


def open_shared(path):
    """Opens one of Teams' files read-only without getting in its way.

    Python's open() on Windows does not grant FILE_SHARE_DELETE, so a reader
    holding a log open at the moment LevelDB rotates it would make Teams'
    delete fail. CreateFileW with every share flag does not.
    """
    if os.name != "nt":
        return open(path, "rb")
    import ctypes
    import msvcrt
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    handle = k32.CreateFileW(str(path), 0x80000000, 0x7, None, 3, 0x80, None)  # GENERIC_READ, share all, OPEN_EXISTING
    if handle in (None, wintypes.HANDLE(-1).value):
        err = ctypes.get_last_error()
        if err in (2, 3):
            raise FileNotFoundError(path)
        raise OSError(err, "CreateFileW failed", str(path))
    return os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb")


def copy_shared(src, dst):
    with open_shared(src) as f, open(dst, "wb") as out:
        shutil.copyfileobj(f, out, 1 << 20)


def plain(v):
    """Undefined and other deserializer sentinels become None."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    return None


class Decoder:
    """Just enough of ccl's IndexedDb to decode a value from a raw record.

    IndexedDb proper reads every record of every file on construction (the
    five-minute part). Its value-envelope code only needs the records that
    hold blob entries, which live in the same batch as the value they belong
    to, so the records of the files being read are enough.
    """

    def __init__(self, records, blob_dir, work):
        self.db = object.__new__(idb.IndexedDb)
        self.db._fetched_records = records
        self.db._blob_lookup_cache = {}
        self.db._blob_dir = None
        self.blob_dir = blob_dir
        self.work = work
        self.blink = ccl_blink_value_deserializer.BlinkV8Deserializer()
        self.db.get_blob = self._get_blob

    def _get_blob(self, db_id, store_id, raw_key, file_index):
        # Large values live in the .blob directory. Copied before reading,
        # like everything else of Teams'.
        if not self.blob_dir:
            raise FileNotFoundError("no blob dir")
        info = self.db.get_blob_info(db_id, store_id, raw_key, file_index)
        rel = pathlib.Path(f"{db_id:x}", f"{info.blob_number >> 8:02x}", f"{info.blob_number:x}")
        dst = pathlib.Path(self.work, "blob", rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        copy_shared(pathlib.Path(self.blob_dir, rel), dst)
        return dst.open("rb")

    def decode(self, db_id, store_id, key, value):
        _, raw = idb._le_varint_from_bytes(value)
        pre = self.db.read_record_precursor(key, db_id, store_id, value[len(raw):], lambda k, b: None)
        if pre is None:
            return None
        return ccl_v8_value_deserializer.Deserializer(pre[1], host_object_delegate=self.blink.read).read()


def mentions_of(props):
    """`properties.mentions` is a JSON string (sometimes a list) of {mri, ...}."""
    m = (props or {}).get("mentions")
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            return []
    if not isinstance(m, list):
        return []
    return [x.get("mri") for x in m if isinstance(x, dict) and x.get("mri")]


def message_out(m, db_id):
    props = m.get("properties") or {}
    return {
        "t": "msg",
        "db": db_id,
        "conversationId": m.get("conversationId"),
        "id": m.get("id"),
        "version": m.get("version"),
        "parentMessageId": m.get("parentMessageId"),
        "creator": m.get("creator"),
        "fromName": m.get("imDisplayName"),
        "messageType": m.get("messageType"),
        "contentType": m.get("contentType"),
        "content": m.get("content"),
        "arrival": m.get("originalArrivalTime"),
        "mine": bool(m.get("isSentByCurrentUser")),
        "mentions": mentions_of(props),
        "subject": props.get("subject") if isinstance(props.get("subject"), str) else None,
        "importance": props.get("importance") if isinstance(props.get("importance"), str) else None,
        "deleted": bool(m.get("deletionInfo") or props.get("deletetime")),
        "threadType": m.get("threadType") or None,
    }


def conv_out(v, db_id):
    tp = v.get("threadProperties") or {}
    members = v.get("members")
    mris = []
    if isinstance(members, list):
        mris = [x.get("id") for x in members if isinstance(x, dict) and x.get("id")]
    elif isinstance(members, dict):
        mris = [str(k) for k in members.keys()]
    return {
        "t": "conv",
        "db": db_id,
        "id": v.get("id"),
        "threadType": tp.get("threadType") or None,
        "productThreadType": tp.get("productThreadType") or None,
        "topic": tp.get("topic") or tp.get("topicThreadTopic") or None,
        "spaceThreadTopic": tp.get("spaceThreadTopic") or None,
        "groupId": tp.get("groupId") or None,
        "teamId": v.get("teamId") or None,
        "members": mris[:50],
        "memberCount": len(mris),
    }


def file_no(path):
    try:
        return int(pathlib.Path(path).stem)
    except ValueError:
        return -1


BLOCK = 32768  # LevelDB log block size; a record fragment never crosses one


def log_batches(data):
    """Write batches in a LevelDB log fragment that starts on a block boundary.

    Tolerant where ccl's LogFile is strict, because a tail read starts in the
    middle of the log and a live copy can end mid-write: a leading Middle/Last
    fragment (its First is before the tail) is skipped, and a torn record at
    the end stops the walk.
    """
    pos, pending = 0, None
    while pos + 7 <= len(data):
        room = BLOCK - (pos % BLOCK)
        if room < 7:  # block trailer padding
            pos += room
            continue
        length = data[pos + 4] | (data[pos + 5] << 8)
        kind = data[pos + 6]
        body = data[pos + 7:pos + 7 + length]
        if len(body) < length or (kind == 0 and length == 0):
            break  # torn or zero-filled: the writer is not past here yet
        pos += 7 + length
        if kind == 1:  # Full
            pending = None
            yield body
        elif kind == 2:  # First
            pending = bytearray(body)
        elif kind == 3 and pending is not None:  # Middle
            pending += body
        elif kind == 4 and pending is not None:  # Last
            pending += body
            yield bytes(pending)
            pending = None


def log_records(data, path):
    for batch in log_batches(data):
        buf = io.BytesIO(batch)
        header = buf.read(12)
        if len(header) < 12:
            continue
        seq, count = struct.unpack("<QI", header)
        try:
            for i in range(count):
                state = ccl_leveldb.KeyState(buf.read(1)[0])
                key = buf.read(ccl_leveldb.read_le_varint(buf, is_google_32bit=True))
                value = b""
                if state != ccl_leveldb.KeyState.Deleted:
                    value = buf.read(ccl_leveldb.read_le_varint(buf, is_google_32bit=True))
                yield ccl_leveldb.Record.log_record(key, value, seq + i, state, path, 0)
        except Exception:
            continue


def ldb_records(path):
    out = []
    reader = ccl_leveldb.LdbFile(pathlib.Path(path))
    try:
        for rec in reader:
            out.append(rec)
    except Exception:
        pass
    finally:
        reader.close()
    return out


def read_tail(src, start):
    """Bytes of a live log from the block boundary at or before `start`.
    Opened read-only; Teams keeps writing it, which is fine for an
    append-only file."""
    start = (max(0, start) // BLOCK) * BLOCK
    with open_shared(src) as f:
        f.seek(start)
        return f.read(), start


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--blobs")
    ap.add_argument("--work", required=True)
    ap.add_argument("--since-ms", type=float, default=0)
    ap.add_argument("--after-ldb", type=int)
    ap.add_argument("--max-ldb", type=int, default=3)
    ap.add_argument("--log", default="", help="NAME:OFFSET already read of the active log")
    a = ap.parse_args()

    started = time.time()
    logs = sorted(glob.glob(os.path.join(a.src, "*.log")), key=file_no)
    ldbs = sorted(glob.glob(os.path.join(a.src, "*.ldb")), key=file_no)
    max_ldb = file_no(ldbs[-1]) if ldbs else 0
    # Tables written since the last pass. The oldest of them is the flush of
    # the log that just rotated, whose last seconds may not have been read;
    # the rest are compactions rewriting old data. So oldest first, capped.
    fresh = [p for p in ldbs if a.after_ldb is not None and file_no(p) > a.after_ldb]
    skipped = max(0, len(fresh) - a.max_ldb)
    fresh = fresh[:a.max_ldb] if a.max_ldb > 0 else []
    seen_name, _, seen_off = a.log.partition(":")
    seen_off = int(seen_off or 0)

    shutil.rmtree(a.work, ignore_errors=True)
    os.makedirs(a.work, exist_ok=True)
    records = []
    copied = 0
    for p in fresh:  # oldest first, so a later write of a key wins
        dst = os.path.join(a.work, os.path.basename(p))
        try:
            copy_shared(p, dst)
        except FileNotFoundError:
            continue  # compacted away between listing and copying
        copied += os.path.getsize(dst)
        records.extend(ldb_records(dst))
    log_state = []
    for p in logs:
        name = os.path.basename(p)
        try:
            data, start = read_tail(p, seen_off if name == seen_name else 0)
        except FileNotFoundError:
            continue
        copied += len(data)
        log_state.append({"name": name, "offset": start + len(data)})
        records.extend(log_records(data, pathlib.Path(p)))

    dec = Decoder(records, a.blobs, a.work)
    msgs, convs = {}, {}
    errors = 0
    for rec in records:
        if not rec.value:
            continue
        try:
            db_id, store_id, index_id, plen = idb.IndexedDb.read_prefix(io.BytesIO(rec.key))
        except Exception:
            continue
        if index_id != 1 or store_id == 0 or db_id == 0:
            continue
        # Cheap pre-filter before decoding: the field names are stored as
        # one-byte-per-char strings in the serialized value (or the value is
        # snappy-compressed / external, which this cannot see into).
        if b"messageMap" not in rec.value and b"threadProperties" not in rec.value and b"\xff\x11" not in rec.value[:8]:
            continue
        try:
            v = dec.decode(db_id, store_id, idb.IdbKey(rec.key[plen:]), rec.value)
        except Exception:
            errors += 1
            continue
        if not isinstance(v, dict):
            continue
        if isinstance(v.get("messageMap"), dict):
            for m in v["messageMap"].values():
                if not isinstance(m, dict) or not m.get("id") or not m.get("conversationId"):
                    continue
                edited = float(m.get("version") or 0)
                if max(float(m.get("originalArrivalTime") or 0), edited) < a.since_ms:
                    continue
                msgs[(m["conversationId"], m["id"])] = message_out(plain(m), db_id)
        elif "threadProperties" in v and "members" in v and v.get("id"):
            convs[v["id"]] = conv_out(plain(v), db_id)

    shutil.rmtree(a.work, ignore_errors=True)
    out = sys.stdout
    for m in sorted(msgs.values(), key=lambda x: x["arrival"] or 0):
        out.write(json.dumps(m) + "\n")
    wanted = {m["conversationId"] for m in msgs.values()}
    for c in convs.values():
        if c["id"] in wanted:
            out.write(json.dumps(c) + "\n")
    out.write(json.dumps({
        "t": "status",
        "log": log_state[-1] if log_state else None,
        "ldbRead": len(fresh),
        "ldbSkipped": skipped,
        "maxLdb": max_ldb,
        "records": len(records),
        "messages": len(msgs),
        "decodeErrors": errors,
        "bytes": copied,
        "ms": round((time.time() - started) * 1000),
    }) + "\n")


if __name__ == "__main__":
    main()
