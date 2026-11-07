"""The acceptance oracle's GREEN must mean something (2026-08-05, closed 2026-08-07).

PR #236 made the oracle executable; a 2026-08-05 review found that its green
ran in-process (``pytest`` importing the diff's own production code) and
pinned the closing hole as ``test_KNOWN_OPEN_production_code_can_patch_pytest_
in_process`` — a marker that pinned the hole as open. 019 AC2+AC3 close it: the verdict is
now computed by a SEPARATE process driving a BOOTED instance of the app over
HTTP (``factory.chain.boot`` + ``factory.chain.oracle_run``), plus a
gutted-implementation stub that excludes any criterion a no-op could satisfy.

**THE DELIVERABLE**: the test below now HARD PASSES with the marker removed.
Every other test in this file is written against real git repositories and a
real bootable stdlib HTTP fixture (``tests/oracle_boot_fixture.py``) — the fix
is "grade a booted instance in a tree the diff does not control", which is not
expressible against a bare directory or an unbootable stub.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory.app_config import AppConfig, AppGatesConfig
from factory.chain import red_green
from factory.chain.acceptance import (
    _AUTHOR_ATTEMPTS,
    _MAX_AUTHOR_PASSES,
    ORACLE_COPY_PREFIX,
    acceptance_dir,
    author_passes,
    oracle_sha256,
    pending_acceptance_attention,
    reauthor_missing_oracles,
    sweep_leaked_oracles,
    write_waiver,
)
from factory.chain.gates import acceptance_verified
from factory.chain.gates.evaluator import PRContext
from factory.chain.state_machine import StoryRecord, StoryState
from tests.oracle_boot_fixture import (
    BAD_IMPL,
    GOOD_IMPL,
    HTTP_ORACLE,
    HTTP_ORACLE_STRICT,
    HTTP_TAUTOLOGY,
    boot_cfg,
    write_bootable_app,
)
from tests.oracle_repo import commit_all, git, init_repo

# --------------------------------------------------------------------------- #
# fixtures: a real git repo with a merge base, carrying a BOOTABLE app
# --------------------------------------------------------------------------- #

_ORACLE = HTTP_ORACLE
_TAUTOLOGY = HTTP_TAUTOLOGY


def _write_app(repo: Path, impl: str) -> None:
    write_bootable_app(repo, impl=impl)
    keep = repo / "backend" / "tests" / ".gitkeep"
    keep.parent.mkdir(parents=True, exist_ok=True)
    if not keep.exists():
        keep.write_text("", encoding="utf-8")


def _repo(
    tmp_path: Path,
    *,
    base_impl: str = BAD_IMPL,
    head_impl: str | None = GOOD_IMPL,
    base_files: dict[str, str] | None = None,
    head_files: dict[str, str] | None = None,
) -> tuple[Path, str, str]:
    """``main`` at the base commit, a story branch checked out at base+head.

    Mirrors production: the story's worktree on a feature branch whose merge
    base against ``main`` is the code the story started from. The HEAD
    commit always carries a bootable app (``backend/app_server.py`` +
    ``backend/app/mod.py``) so ``acceptance-verified`` can boot it.
    """
    repo = tmp_path / "repo"
    init_repo(repo)
    _write_app(repo, base_impl)
    for rel, body in (base_files or {}).items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(body, encoding="utf-8")
    base_sha = commit_all(repo, "base")

    git(repo, "checkout", "-q", "-b", "feat/story")
    if head_impl is not None:
        _write_app(repo, head_impl)
    (repo / "backend" / "app" / "story_marker.py").write_text("MARKER = 1\n", encoding="utf-8")
    for rel, body in (head_files or {}).items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(body, encoding="utf-8")
    head_sha = commit_all(repo, "story work")
    return repo, base_sha, head_sha


def _story(
    *, story_id: int | None = 7, ref: str | None = None, expected: bool = True,
    state: str = StoryState.PR_OPEN.value, direction_id: str = "002",
    slug: str = "lowercase-email",
) -> StoryRecord:
    return StoryRecord(
        id=story_id, direction_id=direction_id, app="sacrifice",
        title="lowercase the email", slug=slug, scope="backend",
        state=state, acceptance_test_ref=ref, acceptance_expected=expected,
    )


def _cfg(*, on: bool = True, boot=None) -> AppConfig:
    return AppConfig(
        name="sacrifice", repo="o/r",
        gates=AppGatesConfig(acceptance_oracle=on, acceptance_boot=boot or boot_cfg()),
    )


def _pr(root: Path, repo: Path | None, story: StoryRecord | None, sha: str) -> PRContext:
    return PRContext(
        pr_number=1, head_sha=sha, base_branch="main", story=story,
        repo_root=repo, software_factory_root=root, dry_run=False,
    )


def _store(root: Path, *, story_id: int = 7, content: str = _ORACLE) -> str:
    out = acceptance_dir(root, "sacrifice", story_id)
    out.mkdir(parents=True, exist_ok=True)
    (out / "test_acceptance.py").write_text(content, encoding="utf-8")
    return str((out / "test_acceptance.py").relative_to(root))


# =========================================================================== #
# THE DELIVERABLE — the forgery test now HARD PASSES
# =========================================================================== #


def test_H5_production_code_patching_pytest_cannot_forge_a_verdict(tmp_path: Path) -> None:
    """Formerly ``test_KNOWN_OPEN_production_code_can_patch_pytest_in_process``,
    a strict marker that pinned the hole as open. The attack: production code at HEAD reassigns
    ``_pytest.python.Function.runtest`` to a no-op — but the oracle's verdict
    is now computed in a SEPARATE process that never imports this module at
    all, so the patch has nothing to reach. The app still violates the
    criterion (``normalize_email`` still strips instead of lowercasing), and
    the gate must block it, authoritatively."""
    attack_impl = (
        "import sys\n"
        "if 'pytest' in sys.modules:\n"
        "    import _pytest.python\n"
        "    _pytest.python.Function.runtest = lambda self: None\n"
        "\n"
        "\n"
        "def normalize_email(e):\n"
        "    return e.strip()\n"  # still violates the criterion
    )
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=attack_impl)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, (
        "production code disabled pytest's runtest and the gate credited the green: "
        f"{r.reason}"
    )
    assert r.details["authoritative"] is True
    assert r.details["head_status"] == "fail"


def test_H5b_the_attack_module_never_loads_in_the_oracle_process(tmp_path: Path) -> None:
    """Direct proof the attack has nowhere to reach: the oracle process's own
    ``sys.modules`` never contains anything from the diff, because the diff's
    code runs in the BOOTED APP's process, a completely separate interpreter."""
    attack_impl = (
        "import sys\n"
        "if 'pytest' in sys.modules:\n"
        "    raise RuntimeError('the attack module was imported into the oracle process')\n"
        "\n"
        "def normalize_email(e):\n"
        "    return e.lower()\n"
    )
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=attack_impl)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    # The attack module DOES import fine — it just never sees 'pytest' in its
    # OWN sys.modules (a fresh app process), so the guard never fires and the
    # correct implementation is credited normally.
    assert r.passed, r.reason
    assert r.details["verified"] is True
    assert not r.details.get("infra_error")


def _watcher_module(payload: str) -> str:
    """A production module that polls for the oracle's own throwaway run dir
    and does something to it — the RELOCATED forgery an adversarial review
    reproduced twice against the first cut of this gate (found 2026-08-07).

    The deadline is DELIBERATELY SHORT (a few seconds, not the reviewer's
    original 60s): this watcher globs a REPO-WIDE ``/tmp`` pattern with no
    way to scope to "my own test's run" (the whole point of the boot.py
    prefix randomization fix is that a run dir's name carries no
    role/identity signal) — a long-lived instance of it plants a conftest
    into ANY concurrently-running pytest session's oracle run dir on the
    same machine, which is real cross-test contamination this repo's own
    test suite hit during review (a DIFFERENT test file failed with
    ``oracle_run_tampered`` while this one happened to be running in the
    background). A single oracle run completes in low single-digit seconds;
    this window only needs to outlast THIS test's own run.
    """
    return (
        '"""production module imported at boot"""\n'
        "import glob, os, threading, time\n"
        "\n"
        "def _watch():\n"
        "    deadline = time.time() + 8\n"
        "    done = set()\n"
        "    while time.time() < deadline:\n"
        "        for d in glob.glob('/tmp/factory-oracle-run-*') + glob.glob('/tmp/factory-run-*'):\n"
        "            if d in done:\n"
        "                continue\n"
        f"            {payload}\n"
        "            done.add(d)\n"
        "        time.sleep(0.002)\n"
        "\n"
        "threading.Thread(target=_watch, daemon=True).start()\n"
    )


_CONFTEST_PLANT_PAYLOAD = (
    "try:\n"
    "                with open(os.path.join(d, 'conftest.py'), 'w') as fh:\n"
    "                    fh.write(\"import _pytest.python\\n_pytest.python.Function.runtest = "
    "lambda self: None\\n\")\n"
    "            except OSError:\n"
    "                pass"
)


def test_H5c_a_planted_conftest_in_the_oracles_own_rundir_is_TAMPER_DETECTED(
    tmp_path: Path,
) -> None:
    """THE RELOCATED FORGERY (found 2026-08-07 by an adversarial review,
    reproduced twice). HEAD's production code is BOOTED — imported — before
    the oracle ever runs, so a background thread it starts at import time can
    poll ``/tmp`` for the oracle's OWN throwaway run directory and plant a
    ``conftest.py`` there that no-ops every test. ``--noconftest`` closes this
    specific payload; the tamper check closes the CLASS (this test would
    still catch a payload that survived ``--noconftest`` some other way,
    because it checks the run dir's file SET, not just whether collection
    happened to change)."""
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    (repo / "backend" / "app" / "watcher.py").write_text(
        _watcher_module(_CONFTEST_PLANT_PAYLOAD), encoding="utf-8",
    )
    srv = repo / "backend" / "app_server.py"
    srv.write_text(
        "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n"
        "import app.watcher  # noqa\n" + srv.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    head = commit_all(repo, "plant a watcher")

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, r.reason
    assert r.details["unverifiable_kind"] == "oracle_run_tampered"
    assert r.details["authoritative"] is True
    assert r.details["verified"] is False

    # NEVER waivable — an operator waiver must not be able to clear tampering.
    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256(Path(root / ref).read_text()), reason="try to skip it")
    still_blocked = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not still_blocked.passed
    assert still_blocked.details.get("waived") is not True


_OVERWRITE_PAYLOAD = (
    "import re\n"
    "            for p in glob.glob(os.path.join(d, '*.py')):\n"
    "                try:\n"
    "                    src = open(p).read()\n"
    "                except OSError:\n"
    "                    continue\n"
    "                names = re.findall(r'^def (test_\\w+)', src, re.M)\n"
    "                if not names:\n"
    "                    continue\n"
    "                body = ''.join('def %s():\\n    pass\\n' % n for n in names)\n"
    "                if body == src:\n"
    "                    continue\n"
    "                try:\n"
    "                    open(p, 'w').write(body)\n"
    "                except OSError:\n"
    "                    pass"
)


def test_H5d_overwriting_the_oracle_file_in_place_is_TAMPER_DETECTED(tmp_path: Path) -> None:
    """Variant 2: no conftest at all — HEAD's watcher OVERWRITES the oracle
    source file directly, keeping the same ``test_*`` names so the junit node
    ids (and the credited set ``K``) would otherwise survive untouched.
    ``--noconftest`` does nothing against this; the SHA re-hash does."""
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    (repo / "backend" / "app" / "watcher.py").write_text(
        _watcher_module(_OVERWRITE_PAYLOAD), encoding="utf-8",
    )
    srv = repo / "backend" / "app_server.py"
    srv.write_text(
        "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n"
        "import app.watcher  # noqa\n" + srv.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    head = commit_all(repo, "plant an overwriting watcher")

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, r.reason
    assert r.details["unverifiable_kind"] == "oracle_run_tampered"
    assert r.details["authoritative"] is True


# =========================================================================== #
# D1 — the oracle must be able to FAIL (unchanged property, HTTP mechanics)
# =========================================================================== #


def test_D1_tautological_oracle_is_rejected_not_credited(tmp_path: Path) -> None:
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=_TAUTOLOGY)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, r.reason
    assert r.details["verified"] is False
    assert r.details["unverifiable_kind"] == "vacuous_oracle"
    assert r.details["authoritative"] is False


def test_D1_real_oracle_red_at_base_green_at_head_passes(tmp_path: Path) -> None:
    repo, base, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.details.get("output_tail")
    assert r.details["verified"] is True
    assert r.details["authoritative"] is True
    assert r.details["tests_passed"] == 1
    assert r.details["base_run"]["status"] == "fail"
    assert r.details["base_sha"] == base[:12]
    assert r.details["failability_route"] == "merge_base_red"


def test_D1_ablation_never_overturns_a_DEFINITIVE_green_base_verdict(tmp_path: Path) -> None:
    """The base already satisfies the (real) oracle, so its green at HEAD says
    nothing about THIS diff — must not fall through to ablation."""
    repo, _base, head = _repo(tmp_path, base_impl=GOOD_IMPL, head_impl=GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, r.reason
    assert r.details["unverifiable_kind"] == "oracle_not_discriminating"
    assert "failability_ablation" not in r.details


def _new_module_repo(tmp_path: Path, impl: str) -> tuple[Path, str]:
    """A story that ADDS the whole bootable app; base has nothing to boot."""
    repo = tmp_path / "repo"
    init_repo(repo)
    (repo / "README.md").write_text("app\n", encoding="utf-8")
    commit_all(repo, "empty base")
    git(repo, "checkout", "-q", "-b", "feat/story")
    _write_app(repo, impl)
    head = commit_all(repo, "add the module")
    return repo, head


def test_D1_new_module_story_falls_through_to_ablation_and_merges(tmp_path: Path) -> None:
    """The base cannot even be BOOTED (nothing exists there) — ``unknown``, not
    red — so this must go through ablation and still merge for a correct impl."""
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    assert r.details["base_run"].get("boot_failed") is True
    assert r.details["failability_route"] == "ablation"
    assert r.details["verified"] is True


def test_D1_new_module_tautology_is_NOT_credited_via_ablation(tmp_path: Path) -> None:
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=_TAUTOLOGY)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, f"credited a tautology via an unbootable base: {r.reason}"
    # a tautology is caught at the STUB stage — it never even reaches ablation.
    assert r.details["unverifiable_kind"] == "vacuous_oracle"


def test_D1_base_verdict_is_cached_per_base_sha_oracle_and_boot_recipe(tmp_path: Path) -> None:
    repo, base, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    first = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert first.passed
    assert first.details["base_run"].get("cached") is not True
    cache = acceptance_dir(root, "sacrifice", 7) / "base_runs.json"
    assert cache.exists()
    second = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert second.passed
    assert second.details["base_run"]["cached"] is True
    assert base[:12] == second.details["base_run"]["base_sha"]


def test_D1_an_unknown_base_verdict_is_never_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An UNBOOTABLE base (``_new_module_repo``: nothing exists there at all)
    is ``unknown`` by construction, and must re-attempt the boot on every
    evaluation rather than freezing a transient infra state — unlike a
    definitive ``red``/``green`` verdict, which the OTHER cache test confirms
    IS reused."""
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)

    calls = {"n": 0}
    real = acceptance_verified.boot_mod.boot_app

    def _spy(tree, cfg, run_id, label="boot"):  # type: ignore[no-untyped-def]
        if run_id.startswith("base-"):
            calls["n"] += 1
        return real(tree, cfg, run_id, label=label)

    monkeypatch.setattr(acceptance_verified.boot_mod, "boot_app", _spy)
    r1 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    r2 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r1.passed and r2.passed
    assert r1.details["base_run"].get("boot_failed") is True
    assert calls["n"] == 2, "an unknown base verdict was cached, skipping the re-boot attempt"


# =========================================================================== #
# KNOWN OPEN #1 (closed 2026-08-07/08) — a healthy-but-broken BASE must not
# forge a credited red. ``boot_cfg(broken_at_base=True)`` puts the fixture app
# into "health lies" mode: ``/health`` always 200s, ``/normalize`` (the one
# real route) 500s at any boot whose run_id starts with ``"base-"`` — exactly
# the shape a real app's DB-pool-not-ready race produces. ``HTTP_ORACLE_STRICT``
# asserts ``status_code == 200`` BEFORE reading the body, so the 500 becomes a
# FAIL (not an ERROR, which ``verdict_over`` never counted as red anyway) —
# the one shape that could actually have forged a credited ``red`` before
# this was fixed.
# =========================================================================== #


def test_KNOWN_OPEN_1_healthy_but_broken_base_does_not_forge_a_credited_red(
    tmp_path: Path,
) -> None:
    """The regression pin for the whole bug. Before the fix, every credited
    criterion failing at base (all with a 5xx-shaped ``AssertionError`` on
    ``status_code == 200``) read as a genuine ``red`` and CREDITED the story
    — even though the base app never served a single real request. The fix
    must land this on ``unknown``/ablation instead, never on a credited
    ``merge_base_red``."""
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=HTTP_ORACLE_STRICT)
    cfg = _cfg(boot=boot_cfg(broken_at_base=True))

    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), cfg)

    base_run = r.details["base_run"]
    assert base_run.get("downgraded_from") == "red", base_run
    assert base_run["base_probe"]["served_a_real_route"] is False, base_run["base_probe"]
    assert base_run["base_probe"]["requests"], "the probe must have been given at least one request to try"
    assert r.details.get("failability_route") != "merge_base_red", (
        "a healthy-but-broken base forged a credited red at the merge base"
    )


def test_KNOWN_OPEN_1_a_downgraded_base_verdict_is_never_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mirrors ``test_D1_an_unknown_base_verdict_is_never_cached`` for the NEW
    ``unknown`` shape: a downgraded (healthy-but-broken) base must re-attempt
    the boot on every evaluation, exactly like any other ``unknown`` base."""
    repo, _base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=HTTP_ORACLE_STRICT)
    cfg = _cfg(boot=boot_cfg(broken_at_base=True))

    calls = {"n": 0}
    real = acceptance_verified.boot_mod.boot_app

    def _spy(tree, cfg_, run_id, label="boot"):  # type: ignore[no-untyped-def]
        if run_id.startswith("base-"):
            calls["n"] += 1
        return real(tree, cfg_, run_id, label=label)

    monkeypatch.setattr(acceptance_verified.boot_mod, "boot_app", _spy)
    r1 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), cfg)
    r2 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), cfg)

    assert r1.details["base_run"].get("downgraded_from") == "red"
    assert r2.details["base_run"].get("downgraded_from") == "red"
    assert calls["n"] == 2, "the downgraded base verdict was cached, skipping the re-boot attempt"
    cache = acceptance_dir(root, "sacrifice", 7) / "base_runs.json"
    assert not cache.exists()


def test_KNOWN_OPEN_1_a_genuine_red_with_a_healthy_base_is_unaffected(tmp_path: Path) -> None:
    """The working path (base genuinely serves and genuinely disagrees) must
    keep crediting via ``merge_base_red`` — the corroboration requirement
    must not turn a real red into a false ``unknown``."""
    repo, base, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=HTTP_ORACLE_STRICT)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.details.get("output_tail")
    assert r.details["failability_route"] == "merge_base_red"
    assert r.details["base_run"]["base_probe"]["served_a_real_route"] is True
    assert "downgraded_from" not in r.details["base_run"]
    assert r.details["base_sha"] == base[:12]


def test_KNOWN_OPEN_1_poll_health_requires_consecutive_successes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An app that answers healthy ONCE and then 503s must NOT be declared
    booted — ``_poll_health`` now requires ``consecutive_required`` (>=2)
    back-to-back healthy polls."""
    from factory.app_config import AcceptanceBootConfig
    from factory.chain import boot as boot_mod

    class _FakeResp:
        def __init__(self, code: int) -> None:
            self.status_code = code

    codes = iter([200, 503, 200, 200])
    calls = {"n": 0}

    def _fake_get(url: str, timeout: float = 2.0):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        return _FakeResp(next(codes, 200))

    import httpx

    monkeypatch.setattr(httpx, "get", _fake_get)
    monkeypatch.setattr(boot_mod.time, "sleep", lambda *_a, **_k: None)

    class _FakeProc:
        returncode = None

        def poll(self):  # type: ignore[no-untyped-def]
            return None

    cfg = AcceptanceBootConfig(command="x --port {port}", boot_timeout_seconds=5)
    healthy, why = boot_mod._poll_health(_FakeProc(), "http://x", cfg)  # type: ignore[arg-type]
    assert healthy, why
    # 200 (consecutive=1), 503 (reset to 0), 200 (consecutive=1), 200 (consecutive=2 -> healthy)
    assert calls["n"] == 4, "expected the 503 blip to reset the consecutive-success streak"


def test_KNOWN_OPEN_1_poll_health_never_reads_a_5xx_as_healthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from factory.app_config import AcceptanceBootConfig
    from factory.chain import boot as boot_mod

    class _FakeResp:
        status_code = 500

    def _fake_get(url: str, timeout: float = 2.0):  # type: ignore[no-untyped-def]
        return _FakeResp()

    import httpx

    monkeypatch.setattr(httpx, "get", _fake_get)
    monkeypatch.setattr(boot_mod.time, "sleep", lambda *_a, **_k: None)

    class _FakeProc:
        returncode = None

        def poll(self):  # type: ignore[no-untyped-def]
            return None

    cfg = AcceptanceBootConfig(command="x --port {port}", boot_timeout_seconds=1)
    healthy, why = boot_mod._poll_health(_FakeProc(), "http://x", cfg)  # type: ignore[arg-type]
    assert not healthy
    assert "consecutive" in why


# =========================================================================== #
# H1 — the dev-controlled-collection-config attack family. H1/H1b/H1c/H1d/H1e/
# H1f/H1h from the in-process era are GENUINELY MEANINGLESS under 019 AC3: the
# oracle never runs pytest against the app's OWN test tree at all (it drives a
# booted server over HTTP from a factory-owned tmpdir), so a hostile
# conftest.py / autouse fixture / pyproject addopts / tests/__init__.py in
# ``backend/tests/`` has nothing left to attach to — deleted rather than
# ported. H1g is NOT one of those: it is a direct unit test of
# ``_roll_back_environment``'s complement invariant, which the module
# docstring says stays as belt-and-braces for the ablation clone. Restored.
# =========================================================================== #


def test_H1g_the_rollback_set_is_the_whole_test_surface_not_just_config(tmp_path: Path) -> None:
    """PRODUCTION CODE FROM HEAD, THE WHOLE TEST SURFACE FROM BASE, still
    computed as the exact complement of ``is_production_path`` — even though
    the primary HTTP path no longer depends on it, the ablation clone's
    ``_prepare`` hook still calls ``_roll_back_environment`` with this same
    set, so a future widening of either classifier still has to compose
    correctly here."""
    repo, _base, _head = _repo(
        tmp_path,
        head_files={
            "backend/tests/__init__.py": "",
            "backend/tests/helpers.py": "X = 1\n",
            "backend/tests/test_dev_own.py": "def test_d():\n    assert True\n",
            "backend/tests/conftest.py": "",
            "backend/pyproject.toml": "[tool.pytest.ini_options]\n",
            "backend/app/extra.py": "Y = 2\n",
        },
    )
    head = git(repo, "rev-parse", "HEAD")

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    rolled = set(r.details["rolled_back_to_base"])
    assert rolled == {
        "backend/pyproject.toml",
        "backend/tests/__init__.py",
        "backend/tests/conftest.py",
        "backend/tests/helpers.py",
        "backend/tests/test_dev_own.py",
    }
    assert not any(p.startswith("backend/app/") for p in rolled)
    assert r.passed, r.reason


# =========================================================================== #
# H2 — independence: the oracle never touches the dev's checkout at all
# =========================================================================== #


def test_H2_the_oracle_never_enters_the_dev_worktree(tmp_path: Path) -> None:
    """Structural, not incidental, under 019 AC3: the oracle runs in its own
    throwaway temp dir, never copied anywhere near ``repo``."""
    repo, _b, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    assert not list(repo.rglob(f"{ORACLE_COPY_PREFIX}*"))
    assert not list(repo.rglob("nodeids"))
    assert not list(repo.rglob("lastfailed"))
    assert not list(repo.rglob("junit.xml"))


def test_H2b_no_stray_judge_worktrees_or_boot_processes_are_left_registered(
    tmp_path: Path,
) -> None:
    from factory.chain import boot as boot_mod

    repo, _b, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    listed = git(repo, "worktree", "list")
    assert "factory-oracle" not in listed, listed
    assert boot_mod._LIVE_PGIDS == {}


# =========================================================================== #
# H3 — a forged pass count: junit vs stdout cross-check
# =========================================================================== #


def test_H3_junit_stdout_mismatch_is_conflicting(tmp_path: Path) -> None:
    """The runner's own cross-check (:func:`oracle_run.run_oracle`) flips to
    ``conflicting`` whenever the junit-derived counts disagree with the stdout
    summary — simulated here by feeding a hand-built OracleRun through the
    gate's classification branch."""
    from factory.chain import stub_server
    from factory.chain.oracle_run import run_oracle

    with stub_server.stub_app() as stub:
        run = run_oracle(_ORACLE, base_url=stub.base_url, run_id="x", dest_name="t.py", timeout_s=15)
    assert run.status == "fail"  # the real oracle genuinely fails the stub
    assert run.junit_ok is True


def test_H3b_conflicting_summary_at_head_blocks_and_is_never_waivable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _b, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)

    from factory.chain.oracle_run import OracleRun

    real = acceptance_verified.oracle_run.run_oracle

    def _forge(oracle_src, *, base_url, run_id, dest_name, timeout_s):  # type: ignore[no-untyped-def]
        if run_id.startswith("head-"):
            return OracleRun(
                status="conflicting", summary=red_green.PytestSummary(passed=7, conflicting=True),
                criteria={}, exit_code=0, output="forged", junit_ok=True, command="pytest",
            )
        return real(oracle_src, base_url=base_url, run_id=run_id, dest_name=dest_name, timeout_s=timeout_s)

    monkeypatch.setattr(acceptance_verified.oracle_run, "run_oracle", _forge)
    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256(_ORACLE), reason="operator says ship it")
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed
    assert r.details["unverifiable_kind"] == "conflicting_summaries"
    assert r.details.get("waived") is not True


# =========================================================================== #
# D2 — the gate must be testing the merge candidate (unchanged provenance logic)
# =========================================================================== #


def test_D2_a_checkout_that_does_not_contain_the_pr_head_is_not_graded(tmp_path: Path) -> None:
    repo, _b, _head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), "0" * 40), _cfg())
    assert not r.passed
    assert r.details["authoritative"] is False
    assert r.details["unverifiable_kind"] == "provenance_unverified"


def test_D2b_a_head_sha_that_is_a_real_non_ancestor_is_refused(tmp_path: Path) -> None:
    repo, base, head = _repo(tmp_path)
    git(repo, "checkout", "-q", "-b", "other", base)
    (repo / "unrelated.txt").write_text("x\n", encoding="utf-8")
    other = commit_all(repo, "other work")
    git(repo, "checkout", "-q", "feat/story")
    assert head != other

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), other), _cfg())
    assert not r.passed
    assert r.details["unverifiable_kind"] == "wrong_commit"
    assert r.details["authoritative"] is False


def test_D2c_a_real_merge_of_the_base_branch_does_not_false_block(tmp_path: Path) -> None:
    repo, _base, head = _repo(tmp_path)
    git(repo, "checkout", "-q", "main")
    (repo / "sibling.md").write_text("a sibling story merged\n", encoding="utf-8")
    commit_all(repo, "sibling work on main")
    git(repo, "checkout", "-q", "feat/story")
    git(repo, "merge", "--no-edit", "-q", "main")
    merged_head = git(repo, "rev-parse", "HEAD")
    assert merged_head != head
    assert len(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split()) == 3

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    assert r.details["verified"] is True


def test_D2e_a_checkout_AHEAD_of_the_pr_head_is_refused(tmp_path: Path) -> None:
    repo, _base, head = _repo(tmp_path)
    (repo / "backend" / "app" / "mod.py").write_text(GOOD_IMPL + "# never pushed\n", encoding="utf-8")
    commit_all(repo, "unpushed local work")
    assert git(repo, "merge-base", "--is-ancestor", head, "HEAD") == ""

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed, r.reason
    assert r.details["unverifiable_kind"] == "checkout_ahead_of_pr_head"
    assert r.details["authoritative"] is False
    assert "waived" not in r.details


def _linked_worktree(repo: Path, at: Path, branch: str = "feat/story") -> Path:
    git(repo, "checkout", "-q", "main")
    at.parent.mkdir(parents=True, exist_ok=True)
    git(repo, "worktree", "add", "-q", str(at), branch)
    return at


def test_D2f_the_gate_works_against_a_LINKED_worktree_the_production_shape(tmp_path: Path) -> None:
    repo, base, head = _repo(tmp_path)
    wt = _linked_worktree(repo, tmp_path / "worktrees" / "7-story")
    assert (wt / ".git").is_file()
    before = git(repo, "rev-parse", "HEAD")

    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, wt, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    assert r.details["verified"] is True
    assert r.details["base_sha"] == base[:12]
    assert "factory-oracle" not in git(repo, "worktree", "list")
    assert git(repo, "rev-parse", "HEAD") == before
    assert red_green.head_sha(wt) == head


def test_D2g_the_ablation_fallback_works_against_a_LINKED_worktree(tmp_path: Path) -> None:
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    wt = _linked_worktree(repo, tmp_path / "worktrees" / "7-story")
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, wt, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    assert r.details["failability_route"] == "ablation"


# =========================================================================== #
# B5 — the ablation proof is cached (K-aware since 2026-08-07: the cache key
# is the ``--credit``-bearing command string, so a re-authored oracle with a
# different K invalidates the old proof for free)
# =========================================================================== #


def test_B5_a_proven_ablation_is_cached_per_head_sha_oracle_and_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)

    from factory.chain import mutation as mutation_mod

    calls = {"n": 0}
    real = mutation_mod.check_can_fail

    def _counted(**kwargs: object) -> tuple[bool, str]:
        calls["n"] += 1
        return real(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(mutation_mod, "check_can_fail", _counted)
    first = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    calls_after_first = calls["n"]
    second = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())

    assert first.passed, first.reason
    assert second.passed, second.reason
    assert first.details["failability_ablation"].get("cached") is not True
    assert second.details["failability_ablation"]["cached"] is True
    # The FIRST call may try several candidate symbols before one proves
    # failable (``_new_module_repo`` adds a whole app, so more than one
    # ablatable function exists) — the property under test is that the
    # SECOND call adds NO further ``check_can_fail`` invocations at all.
    assert calls_after_first >= 1
    assert calls["n"] == calls_after_first, "the ablation re-ran instead of reading its cached proof"
    assert second.details["failability_route"] == "ablation"


def test_B5b_an_UNPROVEN_ablation_is_never_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=_TAUTOLOGY)

    from factory.chain import mutation as mutation_mod

    calls = {"n": 0}
    real = mutation_mod.check_can_fail

    def _counted(**kwargs: object) -> tuple[bool, str]:
        calls["n"] += 1
        return real(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(mutation_mod, "check_can_fail", _counted)
    # A tautology is caught at the STUB stage now, before ablation is ever
    # reached — so this pins the fail-safe direction (never blocks calling
    # the ablation route in a way that would falsely cache anything), and
    # the "never cached" property holds trivially (no ablation happened).
    r1 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    r2 = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r1.passed and not r2.passed
    assert r1.details["unverifiable_kind"] == "vacuous_oracle"
    assert calls["n"] == 0


def test_B5c_the_ablation_cache_is_keyed_on_the_ORACLE_not_just_the_commit(tmp_path: Path) -> None:
    """Re-authoring the oracle invalidates the proof — the credited set ``K``
    (baked into the cache key via the ``--credit``-bearing command string)
    changes with the oracle, so the old proof cannot be replayed for a
    different criterion set."""
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    good = _store(root)
    first = acceptance_verified.evaluate(_pr(root, repo, _story(ref=good), head), _cfg())
    assert first.passed

    tautology = _store(root, content=_TAUTOLOGY)
    second = acceptance_verified.evaluate(_pr(root, repo, _story(ref=tautology), head), _cfg())
    assert not second.passed, "a re-authored oracle inherited the old proof"


def test_D1_ablation_refuses_a_scratch_tree_that_is_not_the_graded_commit(tmp_path: Path) -> None:
    """``mutation._materialize_tree`` falls back to COPYING THE WORKING TREE
    when it cannot clone — and a copy carries no ``.git``, so the collection-
    channel rollback (belt-and-braces for the ablation clone) would silently
    have nothing to roll back. The ``_prepare`` hook checks the tree really is
    a checkout at the graded sha, so that fallback can never produce a proof."""
    repo, head = _new_module_repo(tmp_path, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)

    import factory.chain.mutation as mutation_mod

    real = mutation_mod._materialize_tree

    def _copy_only(repo_root: Path, head_ref: str, dest: Path) -> str | None:
        import shutil as _sh

        try:
            _sh.copytree(repo_root, dest, ignore=mutation_mod._COPY_IGNORE, symlinks=True)
        except OSError:
            return None
        return "worktree-copy (forced)"

    mutation_mod._materialize_tree = _copy_only  # type: ignore[assignment]
    try:
        r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    finally:
        mutation_mod._materialize_tree = real  # type: ignore[assignment]

    assert not r.passed, r.reason
    assert r.details["unverifiable_kind"] == "failability_unverified"
    attempts = r.details["failability_ablation"]["attempts"]
    assert attempts and all(a["proven"] is False for a in attempts)
    assert "not the graded commit" in attempts[0]["detail"]


def test_H42_the_oracle_runner_argv_is_factory_owned(tmp_path: Path) -> None:
    """Pin the exact isolation flags (found 2026-08-07: nothing asserted this
    before, and ``--noconftest`` is load-bearing for F1's closure)."""
    repo, _base, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    cmd = r.details["command"]
    for flag in ("-B", "-p", "no:cacheprovider", "--noconftest", "-c", "--junitxml="):
        assert flag in cmd, f"{flag!r} missing from the factory-owned argv: {cmd}"


def test_D2d_a_non_git_checkout_can_no_longer_produce_a_pass(tmp_path: Path) -> None:
    repo = tmp_path / "plain"
    _write_app(repo, GOOD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), "a" * 40), _cfg())
    assert not r.passed
    assert r.details["unverifiable_kind"] == "provenance_unverified"


# =========================================================================== #
# the operator waiver — the ONLY path from skipped-with-reason to a merge
# =========================================================================== #


def test_waiver_clears_a_non_discriminating_oracle_but_never_claims_verification(
    tmp_path: Path,
) -> None:
    repo, _b, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=_TAUTOLOGY)
    blocked = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not blocked.passed

    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256(_TAUTOLOGY), reason="AC already satisfied by sibling story 6")
    waived = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert waived.passed
    assert waived.details["waived"] is True
    assert waived.details["verified"] is False
    assert waived.details["authoritative"] is False
    assert "WAIVER" in waived.reason


def test_waiver_is_scoped_to_the_oracle_content(tmp_path: Path) -> None:
    repo, _b, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    root = tmp_path / "factory"
    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256("something else"), reason="stale decision")
    ref = _store(root, content=_TAUTOLOGY)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed
    assert r.details.get("waived") is not True


def test_waiver_cannot_clear_a_failing_oracle(tmp_path: Path) -> None:
    repo, _b, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root)
    write_waiver(root, "sacrifice", 7, oracle_sha=oracle_sha256(_ORACLE), reason="ship it")
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert not r.passed
    assert r.details["authoritative"] is True
    assert r.details.get("waived") is not True


def test_waiver_without_a_reason_is_not_a_waiver(tmp_path: Path) -> None:
    root = tmp_path / "factory"
    with pytest.raises(ValueError, match="reason"):
        write_waiver(root, "sacrifice", 7, oracle_sha="abc", reason="   ")


# =========================================================================== #
# H4.1 — the sweep must not be destructive when git cannot answer
# =========================================================================== #


def test_H41_sweep_refuses_to_delete_when_git_cannot_say_what_is_tracked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    (repo / "backend" / "tests").mkdir(parents=True)
    victim = repo / "backend" / "tests" / f"{ORACLE_COPY_PREFIX}contract.py"
    victim.write_text("def test_real_dev_test():\n    assert True\n", encoding="utf-8")
    init_repo(repo)
    commit_all(repo, "init")
    assert sweep_leaked_oracles(repo) == []
    assert victim.exists()

    import factory.chain.acceptance as acc

    monkeypatch.setattr(acc.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no git")))
    assert sweep_leaked_oracles(repo) == []
    assert victim.exists()


def test_H41b_an_UNTRACKED_copy_the_sweep_could_not_remove_blocks_the_gate(tmp_path: Path) -> None:
    repo, _b, head = _repo(tmp_path)
    leak_dir = repo / "backend" / "tests"
    (leak_dir / f"{ORACLE_COPY_PREFIX}999.py").write_text("def test_leaked():\n    assert True\n", encoding="utf-8")
    root = tmp_path / "factory"
    ref = _store(root)
    leak_dir.chmod(0o555)
    try:
        r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    finally:
        leak_dir.chmod(0o755)
    assert not r.passed
    assert r.details["authoritative"] is True
    assert "dev-blindness" in r.reason
    assert r.details["leaked_copies"] == [f"backend/tests/{ORACLE_COPY_PREFIX}999.py"]


def test_H41c_a_git_TRACKED_file_matching_the_prefix_is_not_a_leak(tmp_path: Path) -> None:
    repo, _b, _h = _repo(
        tmp_path, base_files={f"backend/tests/{ORACLE_COPY_PREFIX}smoke.py": "def test_s():\n    assert True\n"},
    )
    head = git(repo, "rev-parse", "HEAD")
    root = tmp_path / "factory"
    ref = _store(root)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    assert r.passed, r.reason
    assert r.details["verified"] is True
    assert r.details.get("leaked_copies") is None


def test_H41d_an_unanswerable_tracked_set_treats_every_match_as_a_leak(tmp_path: Path) -> None:
    from factory.chain import acceptance as acc

    tree = tmp_path / "notarepo"
    (tree / "backend" / "tests").mkdir(parents=True)
    (tree / "backend" / "tests" / f"{ORACLE_COPY_PREFIX}5.py").write_text("", encoding="utf-8")
    assert acc.sweep_leaked_oracles(tree) == []
    assert acc.unremovable_oracle_leaks(tree) == [f"backend/tests/{ORACLE_COPY_PREFIX}5.py"]


# =========================================================================== #
# D3 / H6 — the wedge that never exhausted, and the silent sink
# =========================================================================== #


def _app_with_config(root: Path, *, direction: bool) -> Path:
    (root / "apps" / "sacrifice").mkdir(parents=True, exist_ok=True)
    (root / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\ngates:\n  acceptance_oracle: true\n  acceptance_boot:\n"
        "    command: 'x --port {port}'\n",
        encoding="utf-8",
    )
    if direction:
        d = root / "apps" / "sacrifice" / "directions" / "002-emails"
        d.mkdir(parents=True, exist_ok=True)
        (d / "direction.md").write_text(
            "---\ntitle: emails\n---\n\n# emails\n\n## Why\n\nx.\n\n"
            "## Acceptance Criteria\n\n- the email is lowercased\n",
            encoding="utf-8",
        )
    db = root / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    return db


def test_D3_missing_direction_records_a_failed_pass_and_exhausts(tmp_path: Path) -> None:
    from sqlmodel import Session

    from factory.chain.handlers import _engine

    root = tmp_path / "factory"
    db = _app_with_config(root, direction=False)
    story = _story(story_id=41, ref=None, expected=True, direction_id="999")
    with Session(_engine(db)) as s:
        s.add(story)
        s.commit()

    calls = {"n": 0}

    def _author(_spec: str, _s: StoryRecord) -> str:
        calls["n"] += 1
        return _TAUTOLOGY

    for _ in range(10):
        reauthor_missing_oracles("sacrifice", root, dry_run=False, db_path=db, author_fn=_author)
    assert calls["n"] == 0
    assert author_passes(root, "sacrifice", 41) == _MAX_AUTHOR_PASSES

    fresh = _story(story_id=41, ref=None, expected=True, direction_id="999")
    r = acceptance_verified.evaluate(_pr(root, None, fresh, "a" * 40), _cfg())
    assert not r.passed
    assert r.details["author_exhausted"] is True
    assert "EXHAUSTED" in r.reason
    assert "self-heals next tick" not in r.reason


def test_H6_exhaustion_is_surfaced_for_a_human(tmp_path: Path) -> None:
    root = tmp_path / "factory"
    db = _app_with_config(root, direction=False)
    story = _story(story_id=41, ref=None, expected=True, direction_id="999")
    from sqlmodel import Session

    from factory.chain.handlers import _engine

    with Session(_engine(db)) as s:
        s.add(story)
        s.commit()
    assert pending_acceptance_attention(root, "sacrifice") == []
    for _ in range(_MAX_AUTHOR_PASSES):
        reauthor_missing_oracles("sacrifice", root, dry_run=False, db_path=db)
    items = pending_acceptance_attention(root, "sacrifice")
    assert [i["kind"] for i in items] == ["author_exhausted"]
    assert items[0]["story_id"] == 41


def test_H6b_a_non_authoritative_gate_block_is_surfaced_for_a_human(tmp_path: Path) -> None:
    repo, _b, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    root = tmp_path / "factory"
    ref = _store(root, content=_TAUTOLOGY)
    acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
    items = pending_acceptance_attention(root, "sacrifice")
    assert [i["kind"] for i in items] == ["vacuous_oracle"]


def test_H6c_a_recorded_block_is_cleared_once_the_gate_passes(tmp_path: Path) -> None:
    repo, _b, head = _repo(tmp_path)
    root = tmp_path / "factory"
    bad_ref = _store(root, content=_TAUTOLOGY)
    acceptance_verified.evaluate(_pr(root, repo, _story(ref=bad_ref), head), _cfg())
    assert pending_acceptance_attention(root, "sacrifice")
    good_ref = _store(root, content=_ORACLE)
    r = acceptance_verified.evaluate(_pr(root, repo, _story(ref=good_ref), head), _cfg())
    assert r.passed
    assert pending_acceptance_attention(root, "sacrifice") == []


def test_H6d_the_inner_author_guard_is_strictly_below_the_outer_cap() -> None:
    assert _AUTHOR_ATTEMPTS < _MAX_AUTHOR_PASSES == 3


def test_reauthor_bounds_ATTEMPTS_not_just_successes(tmp_path: Path) -> None:
    from factory.chain.handlers import persist_story

    root = tmp_path / "factory"
    db = _app_with_config(root, direction=True)
    for i in range(1, 26):
        persist_story(_story(story_id=None, slug=f"story-{i}", expected=True), db)

    calls = {"n": 0}

    def _always_fails(_spec: str, _st: StoryRecord) -> str:
        calls["n"] += 1
        raise RuntimeError("provider 500")

    healed = reauthor_missing_oracles(
        "sacrifice", root, dry_run=False, db_path=db, author_fn=_always_fails, max_per_pass=10,
    )
    assert healed == 0
    assert calls["n"] == 10 * _AUTHOR_ATTEMPTS


def test_H6e_the_cli_lists_and_records_the_operator_decision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from factory.chain.handlers import persist_story
    from factory.cli import app as cli_app

    repo, _b, head = _repo(tmp_path, base_impl=BAD_IMPL, head_impl=BAD_IMPL)
    root = tmp_path / "factory"
    db = _app_with_config(root, direction=True)
    row = persist_story(_story(story_id=None, expected=True), db)
    ref = _store(root, story_id=row.id or 0, content=_TAUTOLOGY)
    blocked = acceptance_verified.evaluate(_pr(root, repo, _story(story_id=row.id, ref=ref), head), _cfg())
    assert not blocked.passed

    monkeypatch.setattr("factory.cli._FACTORY_ROOT", root)
    runner = CliRunner()
    listed = runner.invoke(cli_app, ["acceptance-waive"])
    assert listed.exit_code == 0
    assert "vacuous_oracle" in listed.stdout

    no_reason = runner.invoke(cli_app, ["acceptance-waive", str(row.id), "--app", "sacrifice"])
    assert no_reason.exit_code == 2

    ok = runner.invoke(
        cli_app, ["acceptance-waive", str(row.id), "--app", "sacrifice", "--reason", "AC delivered by sibling story 6"],
    )
    assert ok.exit_code == 0, ok.stdout
    after = acceptance_verified.evaluate(_pr(root, repo, _story(story_id=row.id, ref=ref), head), _cfg())
    assert after.passed
    assert after.details["verified"] is False

    cleared = runner.invoke(cli_app, ["acceptance-waive", str(row.id), "--app", "sacrifice", "--clear"])
    assert cleared.exit_code == 0
    again = acceptance_verified.evaluate(_pr(root, repo, _story(story_id=row.id, ref=ref), head), _cfg())
    assert not again.passed


# =========================================================================== #
# B2 — pyproject.toml has TWO roles; the splice itself is untouched code,
# kept as belt-and-braces for the ablation clone (module docstring). Pure
# unit tests over red_green.rollback_pytest_config_only — no oracle involved.
# =========================================================================== #

_BASE_MANIFEST = (
    "[build-system]\nrequires = [\"setuptools>=75.0\"]\n\n[project]\nname = \"sacrifice-backend\"\n"
    "version = \"0.1.0\"\ndependencies = [\n    \"fastapi>=0.115.0\",\n]\n\n"
    "[project.optional-dependencies]\ndev = [\"pytest>=8.0.0\"]\n\n"
    "[tool.pytest.ini_options]\nasyncio_mode = \"auto\"\nmarkers = [\"smoke: fast smoke tests\"]\n"
)
_HEAD_MANIFEST_NEW_DEP = _BASE_MANIFEST.replace(
    "    \"fastapi>=0.115.0\",\n", "    \"fastapi>=0.115.0\",\n    \"leftpad>=1.0.0\",\n",
)


def test_B2b_the_judge_tree_manifest_has_HEAD_deps_and_BASE_pytest_config(tmp_path: Path) -> None:
    repo, base, _head = _repo(
        tmp_path,
        base_files={"backend/pyproject.toml": _BASE_MANIFEST},
        head_files={"backend/pyproject.toml": _HEAD_MANIFEST_NEW_DEP.replace(
            "asyncio_mode = \"auto\"", "addopts = \"-p _fixup\"",
        )},
    )
    ok, why = red_green.rollback_pytest_config_only(repo, base, "backend/pyproject.toml")
    assert ok, why
    import tomllib

    doc = tomllib.loads((repo / "backend" / "pyproject.toml").read_text(encoding="utf-8"))
    assert "leftpad>=1.0.0" in doc["project"]["dependencies"]
    assert doc["project"]["optional-dependencies"]["dev"] == ["pytest>=8.0.0"]
    assert doc["build-system"]["requires"] == ["setuptools>=75.0"]
    assert doc["tool"]["pytest"]["ini_options"] == {"asyncio_mode": "auto", "markers": ["smoke: fast smoke tests"]}


def test_B2e_the_manifest_splice_is_verified_and_fails_SAFE(tmp_path: Path) -> None:
    repo, base, _head = _repo(
        tmp_path,
        base_files={"backend/pyproject.toml": _BASE_MANIFEST},
        head_files={"backend/pyproject.toml": "[project\nthis is not toml\n"},
    )
    ok, why = red_green.rollback_pytest_config_only(repo, base, "backend/pyproject.toml")
    assert not ok
    assert "toml" in why.lower()


def test_B2k_a_manifest_that_is_a_SYMLINK_is_refused_not_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside.toml"
    original = "[project]\nname='victim'\nversion='0'\n"
    outside.write_text(original, encoding="utf-8")
    repo, base, _head = _repo(tmp_path, base_files={"backend/pyproject.toml": _BASE_MANIFEST})
    link = repo / "backend" / "pyproject.toml"
    link.unlink()
    link.symlink_to(outside)
    commit_all(repo, "manifest as a symlink")

    ok, why = red_green.rollback_pytest_config_only(repo, base, "backend/pyproject.toml")
    assert not ok
    assert "SYMLINK" in why
    assert outside.read_text(encoding="utf-8") == original


# =========================================================================== #
# ordering: the acceptance gate must stay LAST
# =========================================================================== #


def test_H8_acceptance_gate_is_last_in_the_evaluator_tuple() -> None:
    src = Path("factory/chain/gates/evaluator.py").read_text(encoding="utf-8")
    body = src.split("for mod in (", 1)[1].split("):", 1)[0]
    mods = [m.strip().rstrip(",") for m in body.strip().splitlines() if m.strip() and not m.strip().startswith("#")]
    assert mods[-1] == "acceptance_verified", mods


# =========================================================================== #
# red_green unit coverage (unchanged: base_verdict/classify_pytest_run stay)
# =========================================================================== #


@pytest.mark.parametrize(
    ("exit_code", "output", "expected"),
    [
        (0, "1 passed in 0.01s", "pass"),
        (1, "1 failed in 0.01s", "fail"),
        (2, "1 error in 0.01s", "fail"),
        (0, "1 skipped in 0.01s", "vacuous"),
        (5, "no tests ran in 0.01s", "vacuous"),
        (127, "bash: uv: command not found", "unreadable"),
        (124, "command timed out after 600s\n1 passed in 0.01s", "unreadable"),
        (0, "", "unreadable"),
    ],
)
def test_classify_pytest_run(exit_code: int, output: str, expected: str) -> None:
    assert red_green.classify_pytest_run(exit_code, output)[0] == expected


@pytest.mark.parametrize(
    ("exit_code", "output", "expected"),
    [
        (1, "1 failed, 2 passed in 0.1s", "red"),
        (2, "1 error in 0.1s", "unknown"),
        (2, "3 errors in 0.1s", "unknown"),
        (1, "1 failed, 1 error in 0.1s", "red"),
        (1, "3 passed in 0.1s", "unknown"),
        (0, "3 passed in 0.1s", "green"),
        (0, "2 skipped in 0.1s", "unknown"),
        (124, "timed out", "unknown"),
        (127, "not found", "unknown"),
        (0, "5 passed in 0.1s\n1 skipped in 0.2s", "unknown"),  # conflicting
    ],
)
def test_base_verdict(exit_code: int, output: str, expected: str) -> None:
    """``base_verdict`` has no production caller any more (``verdict_over``
    generalises it — see ``red_green.py``'s 2026-08-07 correction), but the
    whole-file question it answers is still correct and still worth pinning;
    this IS its only caller right now."""
    assert red_green.base_verdict(exit_code, output)[0] == expected


def test_stub_run_is_cached_per_oracle_sha_variant_and_versions(tmp_path: Path) -> None:
    """The stub run — now TWO variants — is cached on
    ``(oracle_sha, variant, STUB_VERSION, RUNNER_VERSION)``."""
    from factory.chain import oracle_run as oracle_run_mod

    repo, _base, head = _repo(tmp_path)
    root = tmp_path / "factory"
    ref = _store(root)

    calls = {"n": 0}
    real = oracle_run_mod.run_oracle

    def _counted(*a: object, **k: object):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        return real(*a, **k)  # type: ignore[arg-type]

    import factory.chain.gates.acceptance_verified as gate_mod

    gate_mod.oracle_run.run_oracle = _counted  # type: ignore[assignment]
    try:
        acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
        after_first = calls["n"]
        acceptance_verified.evaluate(_pr(root, repo, _story(ref=ref), head), _cfg())
        after_second = calls["n"]
    finally:
        gate_mod.oracle_run.run_oracle = real  # type: ignore[assignment]

    # Second evaluation must not re-run EITHER stub variant (2 calls saved),
    # only HEAD (+ BASE, which is cached separately and asserted elsewhere).
    stub_cache = acceptance_dir(root, "sacrifice", 7) / "stub_runs.json"
    assert stub_cache.exists()
    raw = json.loads(stub_cache.read_text(encoding="utf-8"))
    assert len(raw) == 2, "expected one cache entry per stub variant"
    assert (after_second - after_first) < (after_first), (
        "the second evaluation re-ran as many oracle invocations as the first — "
        "the stub cache was not used"
    )


def test_judge_worktree_cleans_up_even_when_the_body_raises(tmp_path: Path) -> None:
    repo, _b, _h = _repo(tmp_path)
    seen: list[Path] = []
    with pytest.raises(RuntimeError):
        with red_green.judge_worktree(repo, "HEAD") as (tree, err):
            assert tree is not None and err == ""
            seen.append(tree)
            raise RuntimeError("boom")
    assert not seen[0].exists()
    assert "factory-judge" not in git(repo, "worktree", "list")


def test_judge_worktree_reports_failure_instead_of_raising(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    with red_green.judge_worktree(plain, "HEAD") as (tree, err):
        assert tree is None
        assert err


def test_base_run_cache_only_keeps_the_newest_entries(tmp_path: Path) -> None:
    p = tmp_path / "base_runs.json"
    for i in range(15):
        red_green.cache_put(p, f"k{i}", {"verdict": "red", "n": i}, keep=5)
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert len(raw) == 5
