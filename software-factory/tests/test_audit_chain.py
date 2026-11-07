"""Hash-chained event streams: history becomes verifiable, not merely trusted.

``state/events/*.ndjson`` is the factory's memory of itself. It was append-only
best-effort with no sequence, linkage, or origin identity, so a truncated file, a
hand-edited line, and a row written by a different process were all
indistinguishable from real history. Two failures this addresses concretely:

* Test pollution — the suite and the live daemon wrote structurally identical
  rows, and synthetic failures were escalated by L1 as genuine ones for weeks.
* Self-edits — the factory rewrites its own code, and a verifier it can quietly
  weaken is not a verifier.

The tests below are organised as: the hash contract, then tamper detection, then
the benign conditions that must NOT be reported as tampering (this is the part
that decides whether the check survives contact with a real deployment).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

from factory.manager.signals import write_event
from factory.observability.audit_chain import (
    BROKEN_LINK,
    CHAIN_HEADS_FILENAME,
    CHAIN_ID_FILENAME,
    FOREIGN_CHAIN_ID,
    OK,
    SEQ_GAP,
    TRUNCATED_BY_ROTATION,
    UNCHAINED_LEGACY_ROWS,
    canonical_json,
    chain_id_for,
    compute_entry_hash,
    known_streams,
    verify_stream,
)


def _events(root: Path) -> Path:
    return root / "state" / "events"


def _emit_one(args: tuple[str, int]) -> None:
    """Module-level so ProcessPoolExecutor can pickle it."""
    root, index = args
    write_event("runs", {"event": "run_finished", "i": index}, software_factory_root=Path(root))


def _emit(root: Path, count: int, stream: str = "runs") -> None:
    for i in range(count):
        write_event(
            stream, {"event": "run_finished", "persona": "dev", "i": i}, software_factory_root=root
        )


def _lines(root: Path, stream: str = "runs") -> list[str]:
    return (_events(root) / f"{stream}.ndjson").read_text(encoding="utf-8").splitlines()


def _rewrite(root: Path, lines: list[str], stream: str = "runs") -> None:
    (_events(root) / f"{stream}.ndjson").write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- #
# The hash contract
# --------------------------------------------------------------------------- #


def test_hash_is_stable_across_calls_and_key_order() -> None:
    """The digest must not depend on dict iteration order.

    Records are rebuilt from JSON on the verify side, so a hash that depended on
    insertion order would report tampering for every untouched record.
    """
    a = {"ts": "2026-07-24T00:00:00+00:00", "event": "x", "alpha": 1, "beta": 2}
    b = {"beta": 2, "alpha": 1, "event": "x", "ts": "2026-07-24T00:00:00+00:00"}
    kw = dict(chain_id="c1", stream="runs", seq=1, prev_hash=None)
    assert compute_entry_hash(record=a, **kw) == compute_entry_hash(record=b, **kw)


def test_chain_id_leads_the_hash_so_rows_cannot_move_between_chains() -> None:
    """buzz-audit's tenant-binding trick: identical content, different chain."""
    record = {"ts": "t", "event": "x", "payload": 1}
    kw = dict(stream="runs", seq=1, prev_hash=None, record=record)
    assert compute_entry_hash(chain_id="chain-a", **kw) != compute_entry_hash(
        chain_id="chain-b", **kw
    )


def test_stream_name_is_bound_too() -> None:
    """A row cannot be lifted from ``runs`` into ``alerts`` and still verify."""
    record = {"ts": "t", "event": "x"}
    kw = dict(chain_id="c1", seq=1, prev_hash=None, record=record)
    assert compute_entry_hash(stream="runs", **kw) != compute_entry_hash(stream="alerts", **kw)


def test_none_and_empty_string_hash_differently() -> None:
    """Without a presence byte, a field could be blanked without breaking the
    chain — ``None`` and ``""`` would collide."""
    kw = dict(chain_id="c1", stream="runs", seq=1, prev_hash=None)
    a = compute_entry_hash(record={"ts": None, "event": "x"}, **kw)
    b = compute_entry_hash(record={"ts": "", "event": "x"}, **kw)
    assert a != b


def test_seq_is_bound_so_records_cannot_be_reordered() -> None:
    record = {"ts": "t", "event": "x"}
    kw = dict(chain_id="c1", stream="runs", prev_hash=None, record=record)
    assert compute_entry_hash(seq=1, **kw) != compute_entry_hash(seq=2, **kw)


def test_canonical_json_never_raises_on_odd_values() -> None:
    """A payload we cannot canonicalise must degrade to a repr, not blow up a
    telemetry write — but it must still produce a stable string."""
    value = {"path": Path("/tmp/x"), "n": 1}
    assert canonical_json(value) == canonical_json(dict(reversed(list(value.items()))))


# --------------------------------------------------------------------------- #
# Emission
# --------------------------------------------------------------------------- #


def test_write_event_stamps_a_contiguous_chain(tmp_path: Path) -> None:
    _emit(tmp_path, 5)
    records = [json.loads(line) for line in _lines(tmp_path)]
    assert [r["seq"] for r in records] == [1, 2, 3, 4, 5]
    assert records[0]["prev_hash"] is None, "the first entry links to genesis"
    for previous, current in zip(records, records[1:], strict=False):
        assert current["prev_hash"] == previous["entry_hash"]
    assert len({r["chain_id"] for r in records}) == 1


def test_a_fresh_state_root_gets_its_own_chain_id(tmp_path: Path) -> None:
    """The direct fix for the test-pollution class: a run redirected by
    ``FACTORY_STATE_ROOT`` cannot produce rows that verify in production."""
    one, two = tmp_path / "a", tmp_path / "b"
    _emit(one, 1)
    _emit(two, 1)
    assert chain_id_for(_events(one)) != chain_id_for(_events(two))


def test_chain_id_is_created_once_and_reused(tmp_path: Path) -> None:
    first = chain_id_for(_events(tmp_path))
    assert chain_id_for(_events(tmp_path)) == first
    assert re.fullmatch(r"[0-9a-f-]{36}", first)


def test_verify_accepts_an_untouched_stream(tmp_path: Path) -> None:
    _emit(tmp_path, 4)
    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.verdict == OK
    assert not report.tampered
    assert report.chained_records == 4
    assert report.unchained_records == 0


def test_non_serializable_payload_still_verifies(tmp_path: Path) -> None:
    """Regression: the repr() fallback used to run AFTER hashing, so a record
    containing e.g. a Path was written in a form that no longer matched its own
    entry_hash — reporting tampering for a record nobody touched."""
    write_event(
        "runs",
        {"event": "run_finished", "where": Path("/tmp/somewhere"), "n": 1},
        software_factory_root=tmp_path,
    )
    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.verdict == OK, report.as_dict()
    assert not report.tampered


# --------------------------------------------------------------------------- #
# Tamper detection
# --------------------------------------------------------------------------- #


def test_in_place_edit_is_detected(tmp_path: Path) -> None:
    _emit(tmp_path, 5)
    lines = _lines(tmp_path)
    record = json.loads(lines[2])
    record["persona"] = "reviewer"  # rewrite history
    lines[2] = json.dumps(record)
    _rewrite(tmp_path, lines)

    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.tampered
    assert BROKEN_LINK in report.verdicts


def test_deleting_a_record_is_detected(tmp_path: Path) -> None:
    _emit(tmp_path, 5)
    lines = _lines(tmp_path)
    del lines[2]
    _rewrite(tmp_path, lines)

    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.tampered
    assert SEQ_GAP in report.verdicts or BROKEN_LINK in report.verdicts


def test_reordering_records_is_detected(tmp_path: Path) -> None:
    _emit(tmp_path, 5)
    lines = _lines(tmp_path)
    lines[1], lines[3] = lines[3], lines[1]
    _rewrite(tmp_path, lines)

    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.tampered


def test_a_row_from_another_chain_is_detected(tmp_path: Path) -> None:
    """The test-pollution scenario, exactly: a row produced by a different state
    root is appended to the production stream. Its own hash is internally
    consistent, so ONLY the chain id catches it."""
    production, other = tmp_path / "prod", tmp_path / "other"
    _emit(production, 3)
    _emit(other, 1)

    foreign = _lines(other)[0]
    _rewrite(production, [*_lines(production), foreign])

    report = verify_stream("runs", events_dir=_events(production))
    assert report.tampered
    assert FOREIGN_CHAIN_ID in report.verdicts
    assert len(report.chain_ids_seen) == 2


def test_appending_a_forged_record_without_a_valid_link_is_detected(tmp_path: Path) -> None:
    """Forging requires knowing the head hash; a plausible-looking append fails."""
    _emit(tmp_path, 3)
    lines = _lines(tmp_path)
    last = json.loads(lines[-1])
    forged = dict(last)
    forged["seq"] = last["seq"] + 1
    forged["i"] = 999
    forged["prev_hash"] = last["entry_hash"]
    # entry_hash left as the previous record's — the forger did not recompute it.
    _rewrite(tmp_path, [*lines, json.dumps(forged)])

    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.tampered
    assert BROKEN_LINK in report.verdicts


# --------------------------------------------------------------------------- #
# Benign conditions — must NOT be reported as tampering
# --------------------------------------------------------------------------- #


def test_legacy_unchained_rows_verify_clean(tmp_path: Path) -> None:
    """Every existing deployment has thousands of pre-chain rows. If those read
    as tampering the check is useless on day one, so they get their own verdict
    and ``tampered`` stays False."""
    events = _events(tmp_path)
    events.mkdir(parents=True)
    (events / "runs.ndjson").write_text(
        json.dumps(
            {"ts": "2026-01-01T00:00:00+00:00", "schema_version": 1, "event": "run_finished"}
        )
        + "\n",
        encoding="utf-8",
    )
    report = verify_stream("runs", events_dir=events)
    assert not report.tampered
    assert report.verdicts == [UNCHAINED_LEGACY_ROWS]
    assert report.unchained_records == 1
    assert report.chained_records == 0


def test_legacy_rows_followed_by_chained_rows_verify_clean(tmp_path: Path) -> None:
    """The real migration shape: an existing stream that starts being chained
    mid-file. Neither half may be reported as tampering."""
    events = _events(tmp_path)
    events.mkdir(parents=True)
    (events / "runs.ndjson").write_text(
        json.dumps({"ts": "2026-01-01T00:00:00+00:00", "schema_version": 1, "event": "old"}) + "\n",
        encoding="utf-8",
    )
    _emit(tmp_path, 3)

    report = verify_stream("runs", events_dir=events)
    assert not report.tampered, report.as_dict()
    assert report.verdicts == [UNCHAINED_LEGACY_ROWS]
    assert (report.unchained_records, report.chained_records) == (1, 3)


def test_rotation_truncation_is_reported_as_truncation_not_tampering(tmp_path: Path) -> None:
    """Rotation keeps only a few segments, so a live chain legitimately starts
    mid-sequence. That is expected operation, not a deletion."""
    _emit(tmp_path, 6)
    lines = _lines(tmp_path)
    _rewrite(tmp_path, lines[3:])  # simulate the oldest segment being dropped

    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert TRUNCATED_BY_ROTATION in report.verdicts
    assert not report.tampered, report.as_dict()


def test_rotated_segments_are_read_oldest_first(tmp_path: Path) -> None:
    """A rotated stream must replay in append order, or the chain reads as
    broken purely because of file naming."""
    _emit(tmp_path, 6)
    events = _events(tmp_path)
    lines = _lines(tmp_path)
    (events / "runs.ndjson.1").write_text("\n".join(lines[:3]) + "\n", encoding="utf-8")
    _rewrite(tmp_path, lines[3:])

    report = verify_stream("runs", events_dir=events)
    assert report.verdict == OK, report.as_dict()
    assert report.chained_records == 6


def test_empty_and_missing_streams_are_not_failures(tmp_path: Path) -> None:
    events = _events(tmp_path)
    events.mkdir(parents=True)
    assert verify_stream("nope", events_dir=events).verdict == OK
    (events / "empty.ndjson").write_text("", encoding="utf-8")
    assert verify_stream("empty", events_dir=events).total_records == 0


def test_a_truncated_final_line_does_not_break_the_whole_stream(tmp_path: Path) -> None:
    """A crash mid-append leaves half a line. That must cost one record, not the
    entire history."""
    _emit(tmp_path, 3)
    path = _events(tmp_path) / "runs.ndjson"
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"event": "run_fin')
    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert report.verdict == OK
    assert report.chained_records == 3


# --------------------------------------------------------------------------- #
# Operational properties
# --------------------------------------------------------------------------- #


def test_write_event_still_writes_when_chaining_is_impossible(tmp_path: Path) -> None:
    """Fail-open: losing an event is never acceptable, losing its link is.

    The heads file is made unwritable, so the chain cannot advance; the event
    must still land, unchained, and verification must call that out rather than
    treat the absence of links as proof of integrity.
    """
    events = _events(tmp_path)
    events.mkdir(parents=True)
    heads = events / CHAIN_HEADS_FILENAME
    heads.write_text("{}", encoding="utf-8")
    heads.chmod(0o400)
    try:
        write_event("runs", {"event": "run_finished"}, software_factory_root=tmp_path)
        records = [json.loads(line) for line in _lines(tmp_path)]
        assert len(records) == 1, "the event itself must never be lost"
        if "entry_hash" not in records[0]:
            report = verify_stream("runs", events_dir=events)
            assert report.unchained_records == 1
            assert UNCHAINED_LEGACY_ROWS in report.verdicts
    finally:
        heads.chmod(0o600)


def test_concurrent_writers_do_not_collide(tmp_path: Path) -> None:
    """The tick process and the manager daemon write the same streams. Without
    the flock on the head file they would be handed the same ``seq`` and the
    chain would break for a reason that is not tampering."""
    from concurrent.futures import ThreadPoolExecutor

    def emit(i: int) -> None:
        write_event("runs", {"event": "run_finished", "i": i}, software_factory_root=tmp_path)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(emit, range(40)))

    records = [json.loads(line) for line in _lines(tmp_path)]
    seqs = sorted(r["seq"] for r in records)
    assert seqs == list(range(1, 41)), "every writer got a distinct seq"
    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert not report.tampered, report.as_dict()


def test_concurrent_processes_racing_on_head_creation_do_not_collide(tmp_path: Path) -> None:
    """Separate PROCESSES racing on the first write, head file absent.

    Stronger than the thread test above: ``flock`` is a cross-process lock, and
    threads in one interpreter can mask a locking mistake that separate
    processes would expose.

    Honest limitation: this exercises the create path but does NOT
    deterministically reproduce the truncate-before-lock window that the ``"a+"``
    open mode fixes. That window needs a specific interleaving (process B calls
    ``exists()`` before A creates the file, then opens after A has written), and
    on a fast local filesystem it does not reliably occur — this test passed
    against the buggy version on three consecutive runs. The fix stands on
    reasoning (``"w+"`` truncates before the lock is held) and on being simpler
    code; this test guards the surrounding behaviour, not that one window.
    """
    from concurrent.futures import ProcessPoolExecutor

    assert not (_events(tmp_path) / CHAIN_HEADS_FILENAME).exists()

    with ProcessPoolExecutor(max_workers=6) as pool:
        list(pool.map(_emit_one, [(str(tmp_path), i) for i in range(30)]))

    records = [json.loads(line) for line in _lines(tmp_path)]
    assert sorted(r["seq"] for r in records) == list(range(1, 31)), (
        "every process must get a distinct seq"
    )
    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert not report.tampered, report.as_dict()


def test_chain_state_files_are_hidden_and_not_mistaken_for_streams(tmp_path: Path) -> None:
    _emit(tmp_path, 1)
    streams = known_streams(_events(tmp_path))
    assert streams == ["runs"]
    assert CHAIN_ID_FILENAME not in streams
    assert CHAIN_HEADS_FILENAME not in streams


def test_head_is_advanced_only_after_the_append(tmp_path: Path) -> None:
    """The stored head must match the last record actually on disk. Committing
    before the append would leave a permanent gap that reads as tampering."""
    _emit(tmp_path, 3)
    heads = json.loads((_events(tmp_path) / CHAIN_HEADS_FILENAME).read_text(encoding="utf-8"))
    last = json.loads(_lines(tmp_path)[-1])
    assert heads["runs"] == {"seq": last["seq"], "hash": last["entry_hash"]}


# --------------------------------------------------------------------------- #
# The verifiers must be off-limits to the self-improver
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    [
        "factory/observability/audit_chain.py",
        "factory/observability/conformance.py",
        "factory/observability/conformance_model.yaml",
        "factory/observability/state_trace.py",
    ],
)
def test_integrity_paths_are_forbidden_to_the_self_improver(path: str) -> None:
    """Weng's rule: the tracer and verifiers stay read-only to the agent they
    judge. A loop that can weaken its own integrity check is unfalsifiable in
    exactly the way an editable grader is.

    Note the YAML model would NOT have been caught by the existing
    ``factory/manager/.+\\.py$`` patterns — they only match Python.
    """
    from factory.manager.forbidden_paths import _any_path_is_forbidden_in_patch

    patch = (
        f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,1 @@\n-old\n+new\n"
    )
    assert _any_path_is_forbidden_in_patch([path], patch)


def test_creating_an_integrity_file_is_also_forbidden() -> None:
    """CREATING a new file at an integrity path must not become a way to
    introduce a competing, weaker verifier — forbidden regardless of whether
    the patch modifies an existing file or creates a new one."""
    from factory.manager.forbidden_paths import _any_path_is_forbidden_in_patch

    path = "factory/observability/audit_chain.py"
    patch = (
        f"diff --git a/{path} b/{path}\n"
        "new file mode 100644\n"
        "--- /dev/null\n"
        f"+++ b/{path}\n"
        "@@ -0,0 +1,1 @@\n"
        "+def verify_stream(*a, **k): return True\n"
    )
    assert _any_path_is_forbidden_in_patch([path], patch)


def test_creating_a_new_manager_detector_file_is_forbidden() -> None:
    """Regression pin (2026-08-07 review round): a patch CREATING a new file
    under ``factory/manager/detectors/`` used to be carved out here so it
    could be handed to ``_validate_detector_tool`` in the L4 apply tier. That
    validator (and the L3 Diagnostician that authored detector proposals) is
    deleted, so the carve-out is gone too — a self-edit adding a new detector
    file must be forbidden exactly like modifying an existing one. CLAUDE.md:
    ``factory/manager/**`` is operator-PR-only, no exceptions."""
    from factory.manager.forbidden_paths import _any_path_is_forbidden_in_patch

    path = "factory/manager/detectors/new_check.py"
    patch = (
        f"diff --git a/{path} b/{path}\n"
        "new file mode 100644\n"
        "--- /dev/null\n"
        f"+++ b/{path}\n"
        "@@ -0,0 +1,2 @@\n"
        "+def new_check(root):\n"
        "+    return []\n"
    )
    assert _any_path_is_forbidden_in_patch([path], patch)


def test_unrelated_observability_files_stay_editable() -> None:
    """The lock-down is targeted: only the tracer and verifiers. Broadening it to
    all of factory/observability/ would needlessly block legitimate
    self-improvement of the TUI queries and estimator."""
    from factory.manager.forbidden_paths import _any_path_is_forbidden_in_patch

    path = "factory/observability/queries.py"
    patch = f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-a\n+b\n"
    assert not _any_path_is_forbidden_in_patch([path], patch)


def test_events_dir_env_seam_still_isolates_writes(tmp_path: Path, monkeypatch) -> None:
    """The chain does not change where events go: FACTORY_STATE_ROOT still
    redirects everything, which is what keeps test rows out of production."""
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))
    write_event("runs", {"event": "run_finished"})
    assert (tmp_path / "state" / "events" / "runs.ndjson").exists()
    assert os.environ["FACTORY_STATE_ROOT"] == str(tmp_path)


def test_chain_id_is_resolved_under_the_lock_not_before_it(tmp_path: Path) -> None:
    """A stream must never end up with two chain ids.

    Regression for a ~1-in-10 flake in the concurrency test above. ``chain_id_for``
    used to be called BEFORE the head-file lock, so two writers racing on a fresh
    events dir could each mint a different id: the loser of the ``O_EXCL`` create
    reads the file back before the winner has written to it, sees empty, and falls
    back to its own uuid. Two ids in one stream is then reported (correctly) as
    FOREIGN_CHAIN_ID — so the symptom was a "tampering" verdict on a stream nobody
    had touched.

    Asserted on the RECORDS rather than by trying to hit the window: whatever the
    interleaving, one directory must yield exactly one id.
    """
    from concurrent.futures import ThreadPoolExecutor

    assert not (_events(tmp_path) / CHAIN_ID_FILENAME).exists()

    def emit(i: int) -> None:
        write_event("runs", {"event": "run_finished", "i": i}, software_factory_root=tmp_path)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(emit, range(40)))

    records = [json.loads(line) for line in _lines(tmp_path)]
    ids = {r["chain_id"] for r in records}
    assert len(ids) == 1, f"one events dir must have exactly one chain id, got {ids}"
    assert ids == {chain_id_for(_events(tmp_path))}

    report = verify_stream("runs", events_dir=_events(tmp_path))
    assert not report.tampered, report.as_dict()
    assert report.chain_ids_seen == [chain_id_for(_events(tmp_path))]
