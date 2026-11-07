"""Direction 018 — machine-written projections are written to disk, never tracked.

These tests are deliberately written to be *falsifiable by reverting the change*.
The rules under test live in THIS repository's ``.gitignore``, so every test here
either reads that file or queries this repository's own git index. None of them
build a synthetic ``.gitignore`` string — a test that writes its own ignore rules
and then asserts git honours them tests git, not this repo (that was the defect in
the first attempt at this direction, PR #178: reverting ``.gitignore`` left all 15
of its tests green).

What is asserted:

* ``test_no_machine_written_projection_is_tracked`` — this repo's index holds zero
  paths matching the machine-written patterns (catches a re-added file, which
  ``.gitignore`` alone cannot: ignore rules never apply to tracked files).
* ``test_real_repo_status_is_free_of_machine_written_paths`` — this repo's own
  ``git status --porcelain`` for ``apps/`` and ``stories/`` names none of them.
* ``test_ignore_rules_*`` — this repo's ignore rules match the machine-written
  paths and do NOT match the human-authored siblings.
* ``test_transition_leaves_apps_clean`` — AC7. A real
  ``factory.directions.watcher.mark_direction_status`` transition, run against a
  scratch repository whose ``.gitignore`` is a *copy of this repository's real
  file*, leaves ``git status --porcelain -- apps/`` empty while still writing the
  projection to disk.
* ``test_transition_dirties_apps_without_the_ignore_rules`` — the mutation control
  for the above: strip the machine-written rules out of the copied real
  ``.gitignore`` and the same transition dirties the tree. This is what proves the
  clean assertion has teeth.

Why AC7 runs against a scratch root rather than this working tree: a real
transition writes an authoritative row to ``<root>/state/factory.db``, derived
from the direction's own directory path (``watcher._root_from_direction``), which
no fixture can redirect — pointing it at this repo would inject synthetic rows
into production telemetry, the exact test-pollution class this repo has already
been burned by. And asserting THIS tree is wholly clean would make the suite fail
whenever an operator has an uncommitted edit in ``apps/``. The index and status
assertions above cover this repository directly; this one covers the write path.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
import yaml

from factory.directions.parser import parse_direction_dir
from factory.directions.watcher import mark_direction_status

_REPO_ROOT = Path(__file__).resolve().parents[1]
_REAL_GITIGNORE = _REPO_ROOT / ".gitignore"

# The machine-written projections direction 018 untracks. Kept as an explicit
# regex (not a re-read of .gitignore) so a rule deleted from .gitignore does not
# also delete the assertion that depends on it.
_MACHINE_WRITTEN = re.compile(
    r"^(?:"
    r"apps/[^/]+/directions/[^/]+/state\.yaml"
    r"|apps/[^/]+/stories/[^/]+\.md"
    r"|stories/[^/]+\.md"
    r")$"
)

# The .gitignore lines that implement direction 018. The mutation control strips
# exactly these to build a "pre-change" ignore file.
_D018_RULES = (
    "apps/*/directions/*/state.yaml",
    "apps/*/stories/*.md",
    "stories/*.md",
)

requires_git_checkout = pytest.mark.skipif(
    not (_REPO_ROOT / ".git").exists(),
    reason="not running from a git checkout of this repository",
)


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=30,
    )
    result.check_returncode()
    return result.stdout


def _porcelain(repo: Path, *pathspecs: str) -> list[str]:
    """Return ``git status --porcelain`` lines, optionally scoped to pathspecs.

    ``--untracked-files=all`` matters: the default collapses a wholly-untracked
    directory to ``dir/``, which would hide *which* file dirtied the tree and let
    the mutation control below pass for the wrong reason.
    """
    args = ["status", "--porcelain", "--untracked-files=all"]
    if pathspecs:
        args += ["--", *pathspecs]
    return [line for line in _git(repo, *args).splitlines() if line.strip()]


def _porcelain_paths(lines: list[str]) -> list[str]:
    """Extract the path from each porcelain line (``XY <path>``, handling renames)."""
    out = []
    for line in lines:
        path = line[3:].strip().strip('"')
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        out.append(path)
    return out


# ---------------------------------------------------------------------------
# This repository's index and status
# ---------------------------------------------------------------------------


@requires_git_checkout
def test_no_machine_written_projection_is_tracked() -> None:
    """No machine-written projection is in THIS repository's git index.

    Gitignore rules do not apply to already-tracked files, so the ignore rules
    alone are not enough — the previously-committed copies had to be untracked
    (``git rm --cached``). This is the assertion that stays true only while they
    are, and it also fails if a future change re-adds one.
    """
    tracked = [p for p in _git(_REPO_ROOT, "ls-files", "-z").split("\0") if p]
    offenders = sorted(p for p in tracked if _MACHINE_WRITTEN.match(p))
    assert offenders == [], (
        "machine-written projections are still tracked; gitignore does not apply "
        "to tracked files, so these must be `git rm --cached`d:\n  " + "\n  ".join(offenders)
    )


@requires_git_checkout
def test_real_repo_status_is_free_of_machine_written_paths() -> None:
    """THIS repository's ``git status`` never names a machine-written projection.

    Scoped to the paths direction 018 is about rather than asserting the whole
    tree is clean, so an operator's unrelated in-progress edit cannot make the
    suite red — but any reappearance of the churn this direction removes does.
    """
    paths = _porcelain_paths(_porcelain(_REPO_ROOT, "apps/", "stories/"))
    offenders = sorted(p for p in paths if _MACHINE_WRITTEN.match(p))
    assert offenders == [], (
        "machine-written projections are dirtying git status in this repo:\n  "
        + "\n  ".join(offenders)
    )


@requires_git_checkout
@pytest.mark.parametrize(
    "path",
    [
        "apps/factory/directions/999-example-direction/state.yaml",
        "apps/sacrifice/directions/999-example-direction/state.yaml",
        "apps/factory/stories/999-example-story.md",
        "apps/sacrifice/stories/999-example-story.md",
        "stories/999-example-story.md",
    ],
)
def test_ignore_rules_cover_machine_written_paths(path: str) -> None:
    """THIS repository's ignore rules match every machine-written path shape."""
    result = subprocess.run(
        ["git", "check-ignore", "--no-index", "-q", "--", path],
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, (
        f"{path} is NOT ignored by this repository's .gitignore "
        f"(git check-ignore exit {result.returncode})"
    )


@requires_git_checkout
@pytest.mark.parametrize(
    "path",
    [
        "apps/factory/directions/999-example-direction/direction.md",
        "apps/factory/directions/999-example-direction/flow.md",
        "apps/factory/directions/999-example-direction/api_spec.md",
        "apps/factory/context/modules/example.md",
        "apps/factory/config.yaml",
        # Non-markdown in a stories dir is not a machine-written projection.
        "stories/README.txt",
    ],
)
def test_ignore_rules_spare_human_authored_sources(path: str) -> None:
    """Human-authored direction sources are NOT caught by the new rules."""
    result = subprocess.run(
        ["git", "check-ignore", "--no-index", "-q", "--", path],
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 1, (
        f"{path} is human-authored source and must stay trackable, but this "
        f"repository's .gitignore ignores it"
    )


@requires_git_checkout
def test_human_authored_direction_sources_are_still_tracked() -> None:
    """Every ``direction.md``/``flow.md``/``api_spec.md`` on disk is tracked.

    Guards the untracking pass against over-reach: it must have removed only
    machine-written projections.
    """
    tracked = {p for p in _git(_REPO_ROOT, "ls-files", "-z").split("\0") if p}
    missing = []
    for app_dir in sorted((_REPO_ROOT / "apps").iterdir()):
        directions = app_dir / "directions"
        if not directions.is_dir():
            continue
        for direction_dir in sorted(directions.iterdir()):
            for name in ("direction.md", "flow.md", "api_spec.md"):
                candidate = direction_dir / name
                if not candidate.is_file():
                    continue
                rel = candidate.relative_to(_REPO_ROOT).as_posix()
                if rel not in tracked:
                    missing.append(rel)
    assert missing == [], (
        "human-authored direction sources present on disk but NOT tracked:\n  "
        + "\n  ".join(missing)
    )


# ---------------------------------------------------------------------------
# AC7 — a real transition leaves ``git status --porcelain -- apps/`` empty
# ---------------------------------------------------------------------------


def _scratch_repo(tmp_path: Path, *, gitignore_text: str) -> Path:
    """A real git repo laid out like this one, carrying *gitignore_text*."""
    repo = tmp_path / "scratch"
    repo.mkdir()
    _git(repo, "init", "--initial-branch=main")
    _git(repo, "config", "user.email", "test@factory.local")
    _git(repo, "config", "user.name", "Test Factory")
    (repo / ".gitignore").write_text(gitignore_text, encoding="utf-8")

    direction_dir = repo / "apps" / "factory" / "directions" / "042-scratch-direction"
    direction_dir.mkdir(parents=True)
    (direction_dir / "direction.md").write_text(
        "---\ntitle: Scratch direction\ntype: refactor\n---\n\n# Scratch direction\n",
        encoding="utf-8",
    )
    (repo / "apps" / "factory" / "stories").mkdir(parents=True)
    (repo / "stories").mkdir()

    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "human-authored sources only")
    assert _porcelain(repo) == [], "scratch repo should start clean"
    return repo


def _real_gitignore_text() -> str:
    return _REAL_GITIGNORE.read_text(encoding="utf-8")


def _gitignore_without_d018_rules() -> str:
    """This repository's real ``.gitignore`` with direction 018's rules removed."""
    kept = [line for line in _real_gitignore_text().splitlines() if line.strip() not in _D018_RULES]
    text = "\n".join(kept) + "\n"
    for rule in _D018_RULES:
        assert rule not in text.splitlines(), f"failed to strip {rule!r}"
    return text


def _simulate_tick(repo: Path) -> Path:
    """Run a real status transition plus a story-markdown write.

    Returns the ``state.yaml`` path the transition projected.
    """
    direction_dir = repo / "apps" / "factory" / "directions" / "042-scratch-direction"
    direction = parse_direction_dir("factory", direction_dir, software_factory_root=repo)

    # The real chain write path: authoritative DB row + state.yaml projection.
    mark_direction_status(direction, "pm-validated", by="tests.d018", details={"ac": 7})

    # A tick also renders story markdown, at both roots the chain writes to.
    (repo / "apps" / "factory" / "stories" / "77-scratch-story.md").write_text(
        "# Story 77\n", encoding="utf-8"
    )
    (repo / "stories" / "77-scratch-story.md").write_text("# Story 77\n", encoding="utf-8")

    return direction_dir / "state.yaml"


def test_transition_leaves_apps_clean(tmp_path: Path) -> None:
    """AC7: after a real status transition, ``git status -- apps/`` is empty."""
    repo = _scratch_repo(tmp_path, gitignore_text=_real_gitignore_text())

    _simulate_tick(repo)

    apps_status = _porcelain(repo, "apps/")
    assert apps_status == [], (
        "a status transition must leave `git status --porcelain -- apps/` empty, "
        "but it shows:\n  " + "\n  ".join(apps_status)
    )
    # And nothing anywhere else either — including the repo-root stories/ copy.
    whole_tree = _porcelain(repo)
    assert whole_tree == [], (
        "a status transition must leave the whole tree clean, but it shows:\n  "
        + "\n  ".join(whole_tree)
    )


def test_transition_still_writes_the_projection_to_disk(tmp_path: Path) -> None:
    """Untracked, not unwritten: the operator can still read the status on disk."""
    repo = _scratch_repo(tmp_path, gitignore_text=_real_gitignore_text())

    state_path = _simulate_tick(repo)

    assert state_path.is_file(), "state.yaml must still be written to disk"
    loaded = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert loaded["status"] == "pm-validated"
    assert loaded["audit"][-1]["by"] == "tests.d018"
    assert (repo / "apps" / "factory" / "stories" / "77-scratch-story.md").is_file()
    assert (repo / "stories" / "77-scratch-story.md").is_file()


def test_transition_dirties_apps_without_the_ignore_rules(tmp_path: Path) -> None:
    """Mutation control: strip direction 018's rules and the tree goes dirty.

    This is what makes ``test_transition_leaves_apps_clean`` non-vacuous — the
    scratch repo is otherwise identical, and the only difference is the three
    ignore lines this change added.
    """
    repo = _scratch_repo(tmp_path, gitignore_text=_gitignore_without_d018_rules())

    _simulate_tick(repo)

    paths = _porcelain_paths(_porcelain(repo, "apps/", "stories/"))
    assert any(p.endswith("042-scratch-direction/state.yaml") for p in paths), (
        f"without the ignore rule state.yaml must dirty the tree; saw {paths}"
    )
    assert "apps/factory/stories/77-scratch-story.md" in paths, (
        f"without the ignore rule apps/<app>/stories/*.md must dirty the tree; saw {paths}"
    )
    assert "stories/77-scratch-story.md" in paths, (
        f"without the ignore rule the repo-root stories/*.md copy must dirty the tree; saw {paths}"
    )


def test_real_gitignore_is_the_file_under_test(tmp_path: Path) -> None:
    """Sanity: the scratch repos really do carry this repository's ignore file.

    Cheap guard against the tautology this module exists to avoid — if the copy
    ever stops being a copy, this fails.
    """
    repo = _scratch_repo(tmp_path, gitignore_text=_real_gitignore_text())
    assert (repo / ".gitignore").read_text(encoding="utf-8") == _real_gitignore_text()
    for rule in _D018_RULES:
        assert rule in _real_gitignore_text().splitlines(), (
            f"{rule!r} is missing from this repository's .gitignore"
        )
