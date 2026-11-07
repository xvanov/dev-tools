"""E6 — guard the PR fast lane's hand-curated exclude manifest.

CI's PR lane runs the suite MINUS the files in ``tests/fast_lane_excludes.txt``
(they still run in the post-merge full lane). The manifest is HAND-CURATED on
a capability rule — a file belongs there iff it boots a server, runs a
sandbox/docker, or is parallelism-hostile (nested pytest, bulk subprocess
spawning) — because adversarial review showed both automatic directions
misfire: a text regex evicted the merge-gate evaluator's only behavioural
tests over an incidental "docker" string, and a hard "every match must be
listed" assertion ratchets the coverage hole wider on every new match.

So the guards here are deliberately asymmetric:

* a STALE entry fails — an ``--ignore`` for a file that no longer exists is a
  test silently dropped from the PR lane for no reason at all;
* an unlisted heavy file does NOT fail here — it runs in the PR lane (slow
  but SAFE), and the workflow's 5-minute step timeout on the fast lane is the
  loud budget backstop that forces classification.
"""

from __future__ import annotations

from pathlib import Path

_TESTS_DIR = Path(__file__).parent
_MANIFEST = _TESTS_DIR / "fast_lane_excludes.txt"


def _manifest_entries() -> list[str]:
    return [
        line.strip()
        for line in _MANIFEST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_manifest_entries_exist() -> None:
    entries = _manifest_entries()
    assert entries, "an empty manifest means the fast lane silently became the full lane"
    repo_root = _TESTS_DIR.parent
    stale = [e for e in entries if not (repo_root / e).is_file()]
    assert not stale, (
        f"stale fast-lane excludes (file moved or deleted): {stale}. "
        "Remove or update them — each is a test file silently dropped from "
        "the PR lane."
    )


def test_manifest_is_sorted_and_unique() -> None:
    entries = _manifest_entries()
    assert entries == sorted(set(entries)), "keep the manifest sorted and duplicate-free"


def test_manifest_paths_are_test_files() -> None:
    bad = [e for e in _manifest_entries() if not Path(e).name.startswith("test_")]
    assert not bad, (
        f"non-test entries are dead weight (pytest never collects them): {bad}"
    )
