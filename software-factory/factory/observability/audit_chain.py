"""Tamper-evident hash chain over the factory's own event streams.

Why
---
``state/events/*.ndjson`` is the factory's memory of itself: the FMS reads it to
decide what is wrong, and an operator reads it to decide whether the FMS was
right. It was append-only best-effort with no sequence, no linkage, and no
origin identity — so a truncated file, a hand-edited line, or a row written by a
completely different process were all indistinguishable from real history. There
was no integrity code anywhere in ``factory/``.

Two concrete failures this addresses:

* **Test pollution.** A test process and the live daemon wrote structurally
  identical rows. Synthetic failures written by the suite were read back by the
  L1 watcher as genuine persona failures and escalated for weeks. The
  ``FACTORY_STATE_ROOT`` fixture stops new instances; a chain id makes past and
  future confusion *detectable* rather than merely unlikely.
* **Self-edits.** The factory can rewrite its own code. A verifier the
  self-improver could quietly weaken is not a verifier, which is why the tracer
  and checker paths are on the L4 forbidden list.

Design (from ``buzz-audit``)
---------------------------
Each entry carries ``chain_id``, ``seq``, ``prev_hash`` and ``entry_hash``.
``chain_id`` is hashed FIRST, so chain identity carries the origin: a row lifted
out of one chain can never verify inside another. ``prev_hash`` links entries;
``seq`` is monotonic per stream. The payload is canonicalised (sorted keys)
before hashing so the digest is stable across processes and Python versions, and
optional fields get an explicit presence byte so ``None`` and ``""`` hash
differently.

Honest about what this is NOT: a local hash chain detects truncation, reordering
and in-place edits. It does not defend against an attacker who can rewrite the
whole file *and* the head file, because both are writable by the same process.
It makes tampering evident, not impossible.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# The 32-byte sentinel hashed in place of ``prev_hash`` for a stream's first
# entry. Stored as ``prev_hash = None``; hashed as all-zero bytes.
GENESIS_HASH: bytes = b"\x00" * 32

# Files that hold chain state, alongside the streams they describe.
CHAIN_ID_FILENAME = ".chain_id"
CHAIN_HEADS_FILENAME = ".chainheads.json"

# Verification verdicts.
OK = "ok"
UNCHAINED_LEGACY_ROWS = "unchained_legacy_rows"
TRUNCATED_BY_ROTATION = "truncated_by_rotation"
SEQ_GAP = "seq_gap"
BROKEN_LINK = "broken_link"
FOREIGN_CHAIN_ID = "foreign_chain_id"
CORRUPT_ENTRY = "corrupt_entry"

# Verdicts that mean "someone changed history", as opposed to the benign
# explanations (rotation dropped a prefix, rows predate the chain).
#
# SEQ_GAP counts as tampering, which is not obvious. Rotation only ever drops
# the OLDEST segment, so the segments that remain are always contiguous at the
# end — a gap at the START is truncation (benign, its own verdict), but a gap
# MID-STREAM cannot be explained by rotation. It means records between two
# retained entries were removed. Excluding it here would have made deletion
# undetectable, which a test caught.
TAMPER_VERDICTS = frozenset({BROKEN_LINK, FOREIGN_CHAIN_ID, CORRUPT_ENTRY, SEQ_GAP})

# Fields the hash covers, in a FIXED order. Changing this order or set
# invalidates every existing chain — which is why it lives in one place.
_HASHED_FIELDS = ("ts", "event")


def canonical_json(value: Any) -> str:
    """Serialise with sorted keys so the digest is machine-independent.

    A serialisation failure is a hard error, never silently hashed as empty: a
    payload we cannot canonicalise is a payload we cannot honestly attest to.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=repr)


def _hash_optional(hasher: Any, value: str | None) -> None:
    """Feed an optional string with a presence tag.

    Without the tag, ``None`` and ``""`` produce the same digest, so a field
    could be blanked without breaking the chain.
    """
    if value is None:
        hasher.update(b"\x00")
    else:
        hasher.update(b"\x01")
        hasher.update(value.encode("utf-8", "replace"))


def compute_entry_hash(
    *,
    chain_id: str,
    stream: str,
    seq: int,
    prev_hash: str | None,
    record: dict[str, Any],
) -> str:
    """Return the hex SHA-256 digest binding this entry to its chain.

    ``chain_id`` leads the hash (buzz-audit's tenant-binding trick): an entry
    cannot be moved between chains and still verify. ``stream`` is included for
    the same reason at one level down — a row cannot be lifted from ``runs`` into
    ``alerts``.
    """
    hasher = hashlib.sha256()
    hasher.update(chain_id.encode("utf-8"))
    hasher.update(stream.encode("utf-8"))
    hasher.update(seq.to_bytes(8, "big"))
    for field_name in _HASHED_FIELDS:
        raw = record.get(field_name)
        _hash_optional(hasher, None if raw is None else str(raw))
    # The payload minus the chain fields themselves — those are structural, and
    # including entry_hash would be circular.
    payload = {
        k: v for k, v in record.items() if k not in ("chain_id", "seq", "prev_hash", "entry_hash")
    }
    hasher.update(canonical_json(payload).encode("utf-8"))
    if prev_hash is None:
        hasher.update(GENESIS_HASH)
    else:
        hasher.update(bytes.fromhex(prev_hash))
    return hasher.hexdigest()


def chain_id_for(events_dir: Path) -> str:
    """Read (or create) the chain identity for ``events_dir``.

    One id per event directory. A test run redirected by ``FACTORY_STATE_ROOT``
    gets a fresh directory and therefore a fresh id, so test-written rows can
    never verify inside the production chain — the direct fix for the
    test-pollution class described in the module docstring.

    Best-effort: on any I/O failure the caller writes an unchained record rather
    than losing the event.
    """
    path = events_dir / CHAIN_ID_FILENAME
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    new_id = str(uuid.uuid4())
    try:
        events_dir.mkdir(parents=True, exist_ok=True)
        # Exclusive create so two racing processes cannot both claim to have
        # founded the chain; the loser reads the winner's id.
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        try:
            os.write(fd, (new_id + "\n").encode("utf-8"))
        finally:
            os.close(fd)
        return new_id
    except FileExistsError:
        # Another writer won the create. It may not have written the id yet, so
        # an immediate read can come back EMPTY — and returning ``new_id`` there
        # would mint a second identity for the same directory, which verification
        # then reports as FOREIGN_CHAIN_ID. Retry briefly instead of inventing
        # one. ``append_chained`` also calls this inside its lock, so this path
        # is only reachable via a direct caller (the CLI, the verifier).
        for _ in range(20):
            try:
                existing = path.read_text(encoding="utf-8").strip()
            except OSError:
                break
            if existing:
                return existing
            time.sleep(0.01)
        return new_id
    except OSError:
        return new_id


def append_chained(
    events_dir: Path,
    stream: str,
    record: dict[str, Any],
    write_line: Any,
) -> bool:
    """Stamp chain fields onto ``record``, append it, and advance the head —
    all while holding one exclusive lock.

    The lock MUST span reserve → hash → append → commit. An earlier version
    reserved the sequence under a lock and committed the head afterwards; with
    the factory's tick process and manager daemon writing the same streams
    concurrently, both readers saw the same head and were handed the same
    ``seq``. A concurrency test caught it producing duplicate sequence numbers
    (``[1, 1, 2, 2, 2, 2, ...]`` for 40 writers), which would read as tampering
    for a reason that is not tampering. Serialising the whole critical section
    also makes the NDJSON append atomic with respect to other writers.

    ``write_line`` is called with the finished JSON line while the lock is held;
    it must do nothing but append.

    Returns ``True`` when the record was written chained, ``False`` when the
    chain could not be used (no ``fcntl``, unwritable head file) — in which case
    NOTHING has been written and the caller must fall back to an unchained
    append. Losing an event is never acceptable; losing its link is.
    """
    try:
        import fcntl
    except ImportError:  # pragma: no cover - POSIX-only factory
        return False

    try:
        events_dir.mkdir(parents=True, exist_ok=True)
        heads_path = events_dir / CHAIN_HEADS_FILENAME
        # "a+" specifically: it creates the file if absent but NEVER truncates.
        # An earlier version used "w+" for the create case, which truncates at
        # OPEN time — i.e. before the lock is acquired. A second process
        # arriving while the first held the lock would blank the head it had
        # just written, and the next writer would reuse a sequence number,
        # producing a SEQ_GAP that reads as tampering when nothing was tampered
        # with. In append mode all writes land at EOF, so the truncate() inside
        # the lock below is what makes the rewrite work.
        with open(heads_path, "a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                # Resolve the chain id INSIDE the lock. Outside it, two writers
                # racing on a fresh events dir could each mint a different id:
                # the loser of the O_EXCL create can read the file back before
                # the winner has written to it, see empty, and fall back to its
                # own uuid. Two ids in one stream is reported (correctly) as
                # FOREIGN_CHAIN_ID, so the symptom was a rare "tampering"
                # verdict on a stream nobody had touched — a ~1-in-10 flake in
                # the concurrency test.
                chain_id = chain_id_for(events_dir)
                handle.seek(0)
                raw = handle.read().strip()
                heads: dict[str, Any] = json.loads(raw) if raw else {}
                if not isinstance(heads, dict):
                    heads = {}
                entry = heads.get(stream) or {}
                seq = int(entry.get("seq", 0)) + 1
                stored_prev = entry.get("hash")
                prev_hash = str(stored_prev) if stored_prev else None

                record["chain_id"] = chain_id
                record["seq"] = seq
                record["prev_hash"] = prev_hash
                record["entry_hash"] = compute_entry_hash(
                    chain_id=chain_id,
                    stream=stream,
                    seq=seq,
                    prev_hash=prev_hash,
                    record=record,
                )

                # Append BEFORE advancing the head: if the append fails, the
                # head is untouched and the next writer reuses this sequence.
                # The reverse order would leave a permanent gap that reads as a
                # deletion.
                write_line(json.dumps(record) + "\n")

                heads[stream] = {"seq": seq, "hash": record["entry_hash"]}
                handle.seek(0)
                handle.truncate()
                handle.write(json.dumps(heads, sort_keys=True))
                # flush() only — deliberately NOT fsync(). This runs on EVERY
                # telemetry write (the live `prompts` stream alone has 45k
                # records), and an fsync there costs milliseconds each. flush()
                # already makes the head visible to other processes and survives
                # a process crash, which is the failure this needs to tolerate.
                # A machine crash would lose the appended event line too — that
                # is not fsynced either — so fsyncing only the head would be
                # both slower and inconsistent.
                handle.flush()
                return True
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except Exception as exc:  # noqa: BLE001 - telemetry path; degrade to unchained
        print(
            f"[audit_chain] could not chain stream={stream!r} ({exc}); writing unchained",
            file=sys.stderr,
        )
        for key in ("chain_id", "seq", "prev_hash", "entry_hash"):
            record.pop(key, None)
        return False


# --------------------------------------------------------------------------- #
# Verification
# --------------------------------------------------------------------------- #


@dataclass
class VerifyReport:
    """Result of verifying one stream's chain."""

    stream: str
    total_records: int = 0
    chained_records: int = 0
    unchained_records: int = 0
    verdicts: list[str] = field(default_factory=list)
    problems: list[dict[str, Any]] = field(default_factory=list)
    chain_ids_seen: list[str] = field(default_factory=list)

    @property
    def tampered(self) -> bool:
        """True only for verdicts that mean history was altered.

        Rotation truncation and legacy rows are NOT tampering — conflating them
        would make the check cry wolf on every real deployment and get it
        switched off.
        """
        return any(v in TAMPER_VERDICTS for v in self.verdicts)

    @property
    def verdict(self) -> str:
        if self.verdicts:
            return self.verdicts[0]
        return OK

    def as_dict(self) -> dict[str, Any]:
        return {
            "stream": self.stream,
            "total_records": self.total_records,
            "chained_records": self.chained_records,
            "unchained_records": self.unchained_records,
            "verdict": self.verdict,
            "verdicts": list(self.verdicts),
            "tampered": self.tampered,
            "chain_ids_seen": list(self.chain_ids_seen),
            "problems": list(self.problems),
        }


def _ordered_segments(events_dir: Path, stream: str) -> list[Path]:
    """Stream files oldest-first: rotated ``.N`` (highest N oldest), then live.

    Same ordering as ``factory.chain.step_events._ordered_segments``. Rotation
    keeps only a few segments, so a chain read this way legitimately starts
    mid-sequence — which is why ``TRUNCATED_BY_ROTATION`` is a distinct verdict.
    """
    base = events_dir / f"{stream}.ndjson"
    try:
        rotated = sorted(
            events_dir.glob(f"{stream}.ndjson.*"),
            key=lambda p: int(p.suffix.lstrip(".")) if p.suffix.lstrip(".").isdigit() else 0,
            reverse=True,
        )
    except OSError:
        rotated = []
    return [*rotated, base]


def _iter_records(events_dir: Path, stream: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for segment in _ordered_segments(events_dir, stream):
        if not segment.exists():
            continue
        try:
            with segment.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        # A partially-written final line (crash mid-append) must
                        # not make the whole stream unreadable.
                        continue
                    if isinstance(record, dict):
                        out.append(record)
        except OSError:
            continue
    return out


def verify_stream(
    stream: str,
    *,
    events_dir: Path,
    expected_chain_id: str | None = None,
) -> VerifyReport:
    """Verify ``stream``'s hash chain. Read-only.

    Distinguishes four benign conditions from real tampering:

    * ``unchained_legacy_rows`` — records written before chaining existed. They
      have no chain fields and MUST verify clean, or every existing deployment
      would report as tampered on first run.
    * ``truncated_by_rotation`` — the first chained record's ``seq`` is not 1,
      so rotation dropped an earlier segment. Expected, not suspicious.
    * ``seq_gap`` — a jump mid-stream. Usually a rotation boundary; reported
      separately so it can be told apart from a deletion.
    * ``foreign_chain_id`` / ``broken_link`` / ``corrupt_entry`` — history was
      altered, or a row came from a different origin (e.g. a test run's chain).
    """
    report = VerifyReport(stream=stream)
    records = _iter_records(events_dir, stream)
    report.total_records = len(records)
    if not records:
        return report

    resolved_expected = expected_chain_id
    if resolved_expected is None:
        path = events_dir / CHAIN_ID_FILENAME
        try:
            resolved_expected = path.read_text(encoding="utf-8").strip() or None
        except OSError:
            resolved_expected = None

    seen_ids: list[str] = []
    prev_hash: str | None = None
    prev_seq: int | None = None

    for index, record in enumerate(records):
        chain_id = record.get("chain_id")
        entry_hash = record.get("entry_hash")
        if not chain_id or not entry_hash:
            report.unchained_records += 1
            continue

        report.chained_records += 1
        chain_id = str(chain_id)
        if chain_id not in seen_ids:
            seen_ids.append(chain_id)

        if resolved_expected is not None and chain_id != resolved_expected:
            report.verdicts.append(FOREIGN_CHAIN_ID)
            report.problems.append(
                {
                    "index": index,
                    "verdict": FOREIGN_CHAIN_ID,
                    "detail": (
                        f"record carries chain_id {chain_id} but this directory's "
                        f"chain is {resolved_expected} — the row originated "
                        "elsewhere (a different state root, or a test run)"
                    ),
                    "ts": record.get("ts"),
                }
            )
            continue

        try:
            seq = int(record.get("seq", 0))
        except (TypeError, ValueError):
            report.verdicts.append(CORRUPT_ENTRY)
            report.problems.append(
                {"index": index, "verdict": CORRUPT_ENTRY, "detail": "seq is not an integer"}
            )
            continue

        if prev_seq is None:
            if seq != 1:
                report.verdicts.append(TRUNCATED_BY_ROTATION)
                report.problems.append(
                    {
                        "index": index,
                        "verdict": TRUNCATED_BY_ROTATION,
                        "detail": (
                            f"chain starts at seq={seq}; earlier entries were "
                            "dropped by size-based rotation, which is expected"
                        ),
                    }
                )
            # The first record we can see cannot have its prev_hash checked
            # against anything we hold, so trust its own self-consistency only.
            prev_hash = record.get("prev_hash")
        else:
            # Check the sequence and the link INDEPENDENTLY, not as an elif
            # chain: a reordering breaks both, and short-circuiting on the seq
            # gap hid the broken link so the verdict under-reported what
            # happened.
            if seq != prev_seq + 1:
                report.verdicts.append(SEQ_GAP)
                report.problems.append(
                    {
                        "index": index,
                        "verdict": SEQ_GAP,
                        "detail": (
                            f"seq jumped {prev_seq} -> {seq}; rotation only drops the "
                            "OLDEST segment, so a mid-stream gap means entries were "
                            "removed"
                        ),
                        "ts": record.get("ts"),
                    }
                )
            if record.get("prev_hash") != prev_hash:
                report.verdicts.append(BROKEN_LINK)
                report.problems.append(
                    {
                        "index": index,
                        "verdict": BROKEN_LINK,
                        "detail": (
                            f"prev_hash {record.get('prev_hash')!r} does not match the "
                            f"previous entry's hash {prev_hash!r} — an entry was "
                            "edited, removed, or reordered"
                        ),
                        "ts": record.get("ts"),
                    }
                )

        recomputed = compute_entry_hash(
            chain_id=chain_id,
            stream=stream,
            seq=seq,
            prev_hash=record.get("prev_hash"),
            record=record,
        )
        if recomputed != str(entry_hash):
            report.verdicts.append(BROKEN_LINK)
            report.problems.append(
                {
                    "index": index,
                    "verdict": BROKEN_LINK,
                    "detail": (
                        "entry_hash does not match the record's contents — the "
                        "line was edited in place"
                    ),
                    "ts": record.get("ts"),
                }
            )

        prev_hash = str(entry_hash)
        prev_seq = seq

    if report.unchained_records and UNCHAINED_LEGACY_ROWS not in report.verdicts:
        report.verdicts.append(UNCHAINED_LEGACY_ROWS)
    report.chain_ids_seen = seen_ids
    # Deduplicate while preserving first-seen order so the summary verdict is
    # the most significant one encountered.
    report.verdicts = sorted(set(report.verdicts), key=lambda v: (v not in TAMPER_VERDICTS, v))
    return report


def known_streams(events_dir: Path) -> list[str]:
    """Return the bare stream names present in ``events_dir``."""
    try:
        return sorted({p.name.split(".ndjson")[0] for p in events_dir.glob("*.ndjson*")})
    except OSError:
        return []
