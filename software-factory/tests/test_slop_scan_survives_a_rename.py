"""A renamed test file must not escape the slop veto.

The slop detector is a HARD veto: it can override an LLM `approve`. Its file list
is the intersection of two git reads, and they disagree about renames:

* `find_test_files_in_diff` uses `git diff --name-only`, which yields the NEW path.
* `_story_authored_paths` used `git diff --numstat`, which for a DETECTED rename
  emits one compressed row:
      `3  1  backend/tests/{test_auth.py => test_auth_email.py}`

Those two strings never intersect, so a renamed-and-edited test file was silently
dropped from the scan — fail-OPEN on a documented fail-safe. If the story's only
touched test file was renamed, the veto was fully disabled for that story.

`--no-renames` makes git emit the old and new paths as separate rows, with the
added lines on the new path.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from factory.chain.branch import find_test_files_in_diff
from factory.chain.handlers import _story_authored_paths
from factory.chain.slop_detector import scan_file


def _git(wt: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(wt), *args], capture_output=True, text=True, check=False
    ).stdout


def _repo_with_a_renamed_test(tmp_path: Path) -> Path:
    wt = tmp_path / "app"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    tests = wt / "backend" / "tests"
    tests.mkdir(parents=True)
    # Long enough that git scores it as a rename rather than add+delete.
    body = "\n".join(f"def test_case_{i}():\n    assert {i} == {i}\n" for i in range(40))
    (tests / "test_auth.py").write_text(body, encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    _git(wt, "branch", "swebench-base")
    _git(wt, "checkout", "-q", "-b", "story")
    # Rename it AND add slop.
    _git(wt, "mv", "backend/tests/test_auth.py", "backend/tests/test_auth_email.py")
    (tests / "test_auth_email.py").write_text(
        body + "\n\ndef test_placeholder():\n    assert True\n", encoding="utf-8"
    )
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "split the auth tests")
    return wt


def test_git_really_does_compress_the_rename(tmp_path: Path) -> None:
    """Establish the premise from git itself, not from belief."""
    wt = _repo_with_a_renamed_test(tmp_path)
    numstat = _git(wt, "diff", "--numstat", "swebench-base")
    assert "=>" in numstat, f"expected a compressed rename row, got: {numstat!r}"


def test_the_renamed_test_file_is_still_scanned(tmp_path: Path) -> None:
    """THE REGRESSION. The intersection was empty, so the file was never scanned —
    even though scanning it finds real slop."""
    wt = _repo_with_a_renamed_test(tmp_path)

    in_diff = find_test_files_in_diff(wt, base_ref="swebench-base")
    authored = _story_authored_paths(wt, "swebench-base")
    assert authored is not None
    scanned = [rel for rel in in_diff if rel in authored]

    assert "backend/tests/test_auth_email.py" in in_diff
    assert "backend/tests/test_auth_email.py" in authored, (
        f"the new path is missing from the authored set: {sorted(authored)}"
    )
    assert scanned, "the intersection is empty — the slop veto is disabled here"

    # And the file genuinely contains slop, so the miss had teeth.
    findings = scan_file(wt / "backend" / "tests" / "test_auth_email.py")
    assert findings, "fixture no longer contains slop; the test would be vacuous"
    assert any("assert True" in (f.kind or "") for f in findings)


def test_a_mode_only_change_is_still_excluded(tmp_path: Path) -> None:
    """`--no-renames` must not undo the reason `--numstat` was chosen: a pure mode
    flip has no line counts and must stay out of the authored set."""
    wt = tmp_path / "app2"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@e.com")
    _git(wt, "config", "user.name", "t")
    (wt / "t.py").write_text("x = 1\n", encoding="utf-8")
    (wt / "t.py").chmod(0o755)
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    _git(wt, "branch", "swebench-base")
    (wt / "t.py").chmod(0o644)
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "mode only")
    assert _story_authored_paths(wt, "swebench-base") == set()


def test_the_flag_is_present_and_explained() -> None:
    import inspect

    from factory.chain import handlers as H

    src = inspect.getsource(H._story_authored_paths)
    assert '"--no-renames"' in src
    assert "compressed" in src.lower()
