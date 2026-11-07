"""Tests for factory.events.rotation — size-based rotation + tail reads (WS0.3)."""

from __future__ import annotations

from pathlib import Path

from factory.events.rotation import (
    read_tail_bytes,
    read_tail_lines,
    rotate_if_needed,
)


def _write_lines(path: Path, n: int) -> None:
    path.write_text("".join(f"line-{i}\n" for i in range(n)), encoding="utf-8")


# ---------------------------------------------------------------------------
# rotate_if_needed
# ---------------------------------------------------------------------------


def test_no_rotation_under_threshold(tmp_path: Path) -> None:
    p = tmp_path / "s.ndjson"
    p.write_text("small\n", encoding="utf-8")
    assert rotate_if_needed(p, max_bytes=1000) is False
    assert p.read_text() == "small\n"
    assert not (tmp_path / "s.ndjson.1").exists()


def test_missing_file_is_noop(tmp_path: Path) -> None:
    assert rotate_if_needed(tmp_path / "nope.ndjson", max_bytes=10) is False


def test_rotation_rolls_and_keeps_copies_no_data_loss(tmp_path: Path) -> None:
    p = tmp_path / "s.ndjson"

    # Round 1: fill past threshold, rotate. Live content moves to .1.
    p.write_text("A" * 100 + "\n", encoding="utf-8")
    assert rotate_if_needed(p, max_bytes=50, keep=3) is True
    # Live file is left absent after rotation; the next append (open "a")
    # recreates it losslessly, avoiding a cross-process truncate race.
    assert not p.exists()
    assert (tmp_path / "s.ndjson.1").read_text() == "A" * 100 + "\n"

    # Round 2: .1 -> .2
    p.write_text("B" * 100 + "\n", encoding="utf-8")
    assert rotate_if_needed(p, max_bytes=50, keep=3) is True
    assert (tmp_path / "s.ndjson.1").read_text() == "B" * 100 + "\n"
    assert (tmp_path / "s.ndjson.2").read_text() == "A" * 100 + "\n"

    # Round 3: .2 -> .3, .1 -> .2
    p.write_text("C" * 100 + "\n", encoding="utf-8")
    assert rotate_if_needed(p, max_bytes=50, keep=3) is True
    assert (tmp_path / "s.ndjson.1").read_text() == "C" * 100 + "\n"
    assert (tmp_path / "s.ndjson.2").read_text() == "B" * 100 + "\n"
    assert (tmp_path / "s.ndjson.3").read_text() == "A" * 100 + "\n"

    # Round 4: oldest (A, at .3) is dropped; keep stays at 3.
    p.write_text("D" * 100 + "\n", encoding="utf-8")
    assert rotate_if_needed(p, max_bytes=50, keep=3) is True
    assert (tmp_path / "s.ndjson.1").read_text() == "D" * 100 + "\n"
    assert (tmp_path / "s.ndjson.2").read_text() == "C" * 100 + "\n"
    assert (tmp_path / "s.ndjson.3").read_text() == "B" * 100 + "\n"
    assert not (tmp_path / "s.ndjson.4").exists()


# ---------------------------------------------------------------------------
# read_tail_lines
# ---------------------------------------------------------------------------


def test_read_tail_lines_returns_last_n_in_order(tmp_path: Path) -> None:
    p = tmp_path / "s.ndjson"
    _write_lines(p, 10000)
    tail = read_tail_lines(p, 5)
    assert tail == [f"line-{i}" for i in range(9995, 10000)]


def test_read_tail_lines_smaller_than_n(tmp_path: Path) -> None:
    p = tmp_path / "s.ndjson"
    _write_lines(p, 3)
    assert read_tail_lines(p, 100) == ["line-0", "line-1", "line-2"]


def test_read_tail_lines_missing_or_empty(tmp_path: Path) -> None:
    assert read_tail_lines(tmp_path / "nope.ndjson", 10) == []
    empty = tmp_path / "empty.ndjson"
    empty.write_text("", encoding="utf-8")
    assert read_tail_lines(empty, 10) == []


def test_read_tail_lines_spanning_chunks(tmp_path: Path) -> None:
    # Force many chunk reads: lines large enough that N lines exceed 64KB.
    p = tmp_path / "s.ndjson"
    p.write_text("".join(f"{i}-{'x' * 500}\n" for i in range(1000)), encoding="utf-8")
    tail = read_tail_lines(p, 300)
    assert len(tail) == 300
    assert tail[-1].startswith("999-")
    assert tail[0].startswith("700-")


# ---------------------------------------------------------------------------
# read_tail_bytes
# ---------------------------------------------------------------------------


def test_read_tail_bytes_drops_partial_leading_line(tmp_path: Path) -> None:
    p = tmp_path / "s.ndjson"
    _write_lines(p, 100)
    # Small byte budget cuts mid-line; partial leading line is dropped.
    text = read_tail_bytes(p, 30)
    lines = [ln for ln in text.split("\n") if ln]
    assert lines
    assert all(ln.startswith("line-") for ln in lines)
    assert lines[-1] == "line-99"


def test_read_tail_bytes_whole_file_when_small(tmp_path: Path) -> None:
    p = tmp_path / "s.ndjson"
    _write_lines(p, 3)
    text = read_tail_bytes(p, 10_000)
    assert text == "line-0\nline-1\nline-2\n"
