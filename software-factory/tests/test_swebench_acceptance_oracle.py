"""A.1b — the chain's INDEPENDENT acceptance oracle, inside the measured arm.

The published ``factory`` 37% (and its 40% chain-verdict precision) were measured
with the chain's ONLY independent oracle ABSENT: ``run_factory`` seeds a story at
``SM_DONE`` and dispatches only ``dev``/``review``, i.e. it starts downstream of
``handle_stories_spawned``, where ``factory/chain/acceptance.py`` authors the
spec-only test. The arm labelled "the product" was not the whole product.

Every test here holds one of the properties that make authoring it in the
harness a measurement rather than a new leak:

1. the hidden GRADING oracle (``oracle.json.z``) can never reach the acceptance
   author, the dev or the reviewer — enforced by the author's signature;
2. the authored test is never visible to the dev — enforced against the real
   paths, not a comment;
3. the authored test can never reach the graded prediction diff;
4. every failure REFUSES the row rather than proceeding as if the oracle ran;

plus cost accounting (the authoring call must land in THIS run's ledger) and arm
parity (only the factory arm changes).
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import inspect
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_ADAPTER = Path(__file__).parent.parent / "bench" / "swebench_adapter.py"


def _load() -> Any:
    spec = importlib.util.spec_from_file_location("_swe_acceptance_under_test", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_swe_acceptance_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def A() -> Any:  # noqa: N802
    return _load()


@pytest.fixture(autouse=True)
def _isolate_bench_store_paths(
    request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No test may touch the REPO's pinned bench artifacts.

    Same guard as the other bench test modules, for the same reason: a test once
    wrote its fixture record over the committed ``oracle.json.z`` and invalidated
    a live sweep AFTER the model spend.
    """
    if "A" not in request.fixturenames:
        return
    a = request.getfixturevalue("A")
    monkeypatch.setattr(a, "MANIFEST_PATH", tmp_path / "isolated-manifest.json")
    monkeypatch.setattr(a, "ORACLE_PATH", tmp_path / "isolated-oracle.json.z")
    monkeypatch.setattr(a, "RUNS_DIR", tmp_path / "isolated-runs")
    monkeypatch.setenv("SWEBENCH_WORK_ROOT", str(tmp_path / "isolated-work"))


def _story() -> Any:
    from factory.chain.state_machine import StoryRecord, StoryState

    return StoryRecord(
        id=7,
        direction_id="swebench",
        app="swebench",
        title="an instance",
        slug="swe-abc",
        scope="backend",
        state=StoryState.SM_DONE.value,
        story_file_path="stories/1.md",
    )


def _opted_in_config() -> Any:
    from factory.app_config import AppConfig

    return AppConfig(
        name="swebench",
        repo="swebench/x",
        app_repo_path="/nonexistent",
        gates={"acceptance_oracle": True},
    )


# --------------------------------------------------------------------------- #
# property 1 — the hidden grading oracle cannot reach the author
# --------------------------------------------------------------------------- #


def test_the_acceptance_author_can_only_be_handed_the_problem_statement(
    A: Any,  # noqa: N803
) -> None:
    """Structural, not reviewed-by-eye: ``_bench_acceptance_direction`` takes the
    problem statement STRING, so there is no parameter through which the gold
    patch, the gold test patch or the fail_to_pass ids could arrive. The
    direction's artifact flags are False, so ``build_spec_prompt`` reads nothing
    off disk either."""
    from factory.chain.acceptance import build_spec_prompt

    sig = inspect.signature(A._bench_acceptance_direction)
    assert list(sig.parameters) == ["problem_statement", "dir_path"], (
        "the author's spec input must be the statement STRING; passing the "
        "instance record would put oracle-adjacent fields one lookup away"
    )

    d = A._bench_acceptance_direction("STATEMENT-XYZ", Path("/nonexistent-dir"))
    assert d.acceptance == ["STATEMENT-XYZ"]
    assert d.has_flow is False and d.has_api_spec is False
    assert d.artifacts_paths == []
    assert d.raw_body == ""
    assert d.raw_frontmatter == {}

    prompt = build_spec_prompt(_story(), d)
    assert "STATEMENT-XYZ" in prompt
    for marker in ("gold", "fail_to_pass", "pass_to_pass", "test_patch", ".diff"):
        assert marker not in prompt.lower(), marker


def test_the_authors_input_is_persisted_in_the_run_dir_not_the_store(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Property 1 has to be checkable from the ARTIFACT — ``build_spec_prompt`` is
    a pure function of (story, direction), so the persisted copy is exactly what
    was sent.

    It goes in the RUN DIR, not beside the test. It used to be written into the
    store as ``spec_prompt.md``, and on a real run that is precisely what the
    dev's ``find <root>/state -name "*.md"`` matched — the provenance file was
    the thing that advertised the store."""
    root = tmp_path / "root"
    root.mkdir()
    prov = A._author_bench_acceptance_oracle(
        arm="factory",
        instance_id="inst-x",
        problem_statement="the widget must lowercase the email",
        story=_story(),
        app_config=_opted_in_config(),
        root=root,
        db=root / "state" / "factory.db",
        dev_trees=(),
        author_fn=lambda p, s: "def test_ac1():\n    assert True\n",
    )
    spec = Path(prov["spec_prompt_path"])
    assert spec.is_file()
    assert spec.parent == A.RUNS_DIR / "inst-x" / "factory"
    body = spec.read_text(encoding="utf-8")
    assert "the widget must lowercase the email" in body
    assert prov["spec_source"] == "problem_statement"
    assert prov["spec_prompt_sha256"] == hashlib.sha256(spec.read_bytes()).hexdigest()
    # And NOT beside the oracle, where a `find` for markdown would meet it.
    store = Path(prov["stored_path"]).parent
    assert not (store / A._ACCEPTANCE_SPEC_NAME).exists()
    assert [p.name for p in store.iterdir()] == [A._ACCEPTANCE_STORED_NAME]


# --------------------------------------------------------------------------- #
# property 2 — the authored oracle is never visible to the dev
# --------------------------------------------------------------------------- #


def test_the_authored_oracle_is_relocated_out_of_the_factory_root(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """MEASURED failing case, not a hypothetical: on the first real run of this
    code the dev looked for its story file, ran ``find <root>/state -name "*.md"``
    from one level above its worktree, and the listing named the acceptance store.
    Production's ``root/state/acceptance/`` is a sibling of
    ``root/state/worktrees/``, so any walk of the factory root's state enumerates
    it.

    So the chain authors it in place, and the harness then relocates it to an
    unguessable ``mkdtemp`` dir under the scratch root — the same standard the GOLD
    patch's prepared trees are held to — and the in-root store must be GONE."""
    root = tmp_path / "root"
    repo = tmp_path / "repo"
    wt = root / "state" / "worktrees"
    for p in (root, repo, wt):
        p.mkdir(parents=True, exist_ok=True)
    story = _story()

    prov = A._author_bench_acceptance_oracle(
        arm="factory",
        instance_id="inst-x",
        problem_statement="fix the widget",
        story=story,
        app_config=_opted_in_config(),
        root=root,
        db=root / "state" / "factory.db",
        dev_trees=(repo, wt),
        author_fn=lambda prompt, st: "def test_ac1_widget():\n    assert True\n",
    )

    stored = Path(prov["stored_path"])
    assert stored.is_file()
    assert stored.name == A._ACCEPTANCE_STORED_NAME
    # Out of the factory root entirely, under the harness's unguessable-name dir.
    assert not (root / "state" / "acceptance").exists()
    assert root.resolve() not in stored.resolve().parents
    assert repo.resolve() not in stored.resolve().parents
    assert wt.resolve() not in stored.resolve().parents
    # RELOCATED 2026-08-14: oracle-bearing trees moved from
    # ``<work_root>/_prepared`` to ``_oracle_tree_root()``, a SIBLING of the scratch
    # root rather than a child of it. The old location shared a parent with every
    # agent's working tree, so an unguessable mkdtemp suffix was the only barrier —
    # and `ls ../..` defeats an unguessable name. A grading tree for a live campaign
    # instance was found stranded there with the hidden tests applied in plaintext.
    #
    # This assertion is the point of the test and still is; only the directory it
    # names changed. Both halves are checked, so a regression that puts the tree
    # back under the agents' root fails here.
    assert A._oracle_tree_root().resolve() in stored.resolve().parents
    assert A._work_root().resolve() not in stored.resolve().parents
    assert stored.parent.name.startswith("acceptance-inst-x-")
    # A walk of the factory root's state now finds nothing of the oracle.
    assert not any(
        "acceptance" in p.name for p in (root / "state").rglob("*")
    ), sorted(str(p) for p in (root / "state").rglob("*"))

    assert prov["outside_dev_tree"] is True
    assert prov["authored_before_dev_dispatch"] is True
    assert prov["expected"] is True
    assert story.acceptance_expected is True
    # The ref the CHAIN wrote is recorded, and the story now points at the
    # relocated ABSOLUTE path — which ``ref_is_readable`` and the gate accept.
    assert prov["authored_ref"] == str(
        Path("state") / "acceptance" / "swebench" / "7" / A._ACCEPTANCE_STORED_NAME
    )
    assert story.acceptance_test_ref == str(stored)
    from factory.chain.acceptance import ref_is_readable

    assert ref_is_readable(story, root)

    assert prov["sha256"] == hashlib.sha256(stored.read_bytes()).hexdigest()
    assert prov["bytes"] == len(stored.read_bytes())
    assert prov["gate_enforced"] is False, (
        "the acceptance-verified MERGE gate is NOT run by this driver; the row "
        "must say so rather than let a reader assume it was enforced"
    )
    assert prov["gate_not_enforced_reason"]


def test_the_chains_own_acceptance_event_stream_is_moved_out_too(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``acceptance._emit`` writes ``state/events/acceptance.ndjson`` carrying the
    ref. That is in the directory the dev enumerates, so it moves to the run dir:
    the evidence is kept, the advertisement is not. And the invariant is asserted
    rather than assumed — ANY acceptance-named leftover inside the factory root
    refuses the row."""
    root = tmp_path / "root"
    root.mkdir()
    prov = A._author_bench_acceptance_oracle(
        arm="factory",
        instance_id="inst-y",
        problem_statement="fix the widget",
        story=_story(),
        app_config=_opted_in_config(),
        root=root,
        db=root / "state" / "factory.db",
        dev_trees=(),
        author_fn=lambda prompt, st: "def test_ac1():\n    assert True\n",
    )
    assert prov["events_path"] is not None
    moved = Path(prov["events_path"])
    assert moved.parent == A.RUNS_DIR / "inst-y" / "factory"
    assert "authored" in moved.read_text(encoding="utf-8")
    assert not (root / "state" / "events" / "acceptance.ndjson").exists()
    assert not [p for p in (root / "state").rglob("*") if "acceptance" in p.name]


def test_an_acceptance_named_leftover_in_the_factory_root_refuses(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The leftover check must FIRE. Simulate a future chain change that writes a
    second acceptance-named artifact into the run's state root."""
    root = tmp_path / "root"
    root.mkdir()
    real_move = A.shutil.move

    def _move_but_litter(src: str, dst: str) -> Any:
        out = real_move(src, dst)
        (root / "state" / "events").mkdir(parents=True, exist_ok=True)
        (root / "state" / "events" / "acceptance-v2.ndjson").write_text("{}\n")
        return out

    monkeypatch.setattr(A.shutil, "move", _move_but_litter)
    with pytest.raises(A.AcceptanceOracleUnavailable, match="leftover|remain"):
        A._author_bench_acceptance_oracle(
        arm="factory",
            instance_id="inst-z",
            problem_statement="fix it",
            story=_story(),
            app_config=_opted_in_config(),
            root=root,
            db=root / "state" / "factory.db",
            dev_trees=(),
            author_fn=lambda p, s: "def test_x():\n    pass\n",
        )


def test_an_oracle_inside_the_dev_tree_is_refused(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """The property-2 check must FIRE, not merely exist."""
    inside = tmp_path / "repo" / "state" / "acceptance" / "test_acceptance.py"
    inside.parent.mkdir(parents=True)
    inside.write_text("x", encoding="utf-8")
    with pytest.raises(A.AcceptanceOracleUnavailable, match="INSIDE the dev's tree"):
        A._assert_oracle_outside_dev_tree(inside, (tmp_path / "repo",))
    # A sibling is fine — that is production's own layout.
    A._assert_oracle_outside_dev_tree(inside, (tmp_path / "elsewhere",))


def test_a_dev_trail_that_touched_the_stored_oracle_is_detected(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Storage location alone does not PROVE invisibility — the dev has a shell,
    and ``state/acceptance/`` is one ``..`` from its worktree, exactly as in
    production. Nothing in the harness detected a violation; this does, from the
    arm's own trails."""
    root = tmp_path / "root"
    traj = root / "state" / "events" / "trajectories"
    traj.mkdir(parents=True)
    store = root / "state" / "acceptance"
    (traj / "dev-1.ndjson").write_text(
        json.dumps({"kind": "ActionEvent", "action": {"command": "ls /tmp"}}) + "\n",
        encoding="utf-8",
    )
    clean = A._acceptance_trail_scan(root, store)
    assert clean["hits"] == 0
    assert clean["files_scanned"] == 1
    assert clean["scan_truncated"] is False

    (traj / "dev-2.ndjson").write_text(
        json.dumps(
            {"kind": "ActionEvent", "action": {"command": f"cat {store}/swebench/7/x.py"}}
        )
        + "\n",
        encoding="utf-8",
    )
    dirty = A._acceptance_trail_scan(root, store)
    assert dirty["hits"] >= 1
    assert dirty["needles"] == [str(store), "state/acceptance"]
    assert dirty["hits_per_needle"][str(store)] >= 1


def test_the_trail_scan_also_catches_the_RELATIVE_ref(  # noqa: N802
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``StoryRecord.acceptance_test_ref`` holds a RELATIVE path, so an
    absolute-only needle would miss a chain change that put the ref into a
    persona prompt. Both shapes are scanned."""
    root = tmp_path / "root"
    ev = root / "state" / "events"
    ev.mkdir(parents=True)
    (ev / "prompt_bodies.ndjson").write_text(
        json.dumps(
            {
                "persona": "dev",
                "prompt": "your oracle is at state/acceptance/swebench/7/x.py",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    got = A._acceptance_trail_scan(root, Path("/somewhere/else/state/acceptance"))
    assert got["hits"] == 1
    assert got["hits_per_needle"]["/somewhere/else/state/acceptance"] == 0


def test_the_trail_scan_does_not_fire_on_a_devs_own_test_acceptance_file(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The needle is the ABSOLUTE store path, not the basename, on purpose: a dev
    writing its own ``test_acceptance.py`` in the repo is legitimate work, and a
    countermeasure that blocks legitimate work is not fail-safe — it is broken."""
    root = tmp_path / "root"
    traj = root / "state" / "events" / "trajectories"
    traj.mkdir(parents=True)
    (traj / "dev-1.ndjson").write_text(
        json.dumps(
            {
                "kind": "ActionEvent",
                "action": {"path": "tests/test_acceptance.py", "file_text": "assert 1"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    assert A._acceptance_trail_scan(root, root / "state" / "acceptance")["hits"] == 0


def test_the_trail_scan_reports_when_it_scanned_nothing(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """"We did not look" and "we looked and found none" are different claims."""
    got = A._acceptance_trail_scan(tmp_path / "empty", tmp_path / "store")
    assert got["files_scanned"] == 0
    assert got["hits"] == 0


def test_a_trail_hit_or_an_unmeasured_scan_refuses_the_row(A: Any) -> None:  # noqa: N803
    """And the detector is WIRED, in all three of its failure shapes: a hit, a
    truncated scan (0 hits is then an undercount) and nothing scanned at all.
    Each takes the same refusal route as an ordering violation, so no
    prediction.diff is written and the row can never be counted as a resolve."""
    src = inspect.getsource(A.run_factory)
    assert 'acceptance["trail_scan"] = _acceptance_trail_scan(' in src
    for branch in (
        'elif acceptance["trail_scan"]["hits"]:',
        'elif acceptance["trail_scan"]["scan_truncated"]:',
        'elif acceptance["trail_scan"]["files_scanned"] == 0:',
    ):
        assert branch in src, branch
    assert src.index('acceptance["trail_scan"]') < src.index(
        '(run_dir / "prediction.diff").write_text'
    )


def test_unparseable_or_naive_ledger_timestamps_refuse(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``isoformat()`` drops ``.%f`` at microsecond 0, so ``…:39+00:00`` and
    ``…:39.99+00:00`` differ in width and a lexicographic compare answers a
    question about ASCII, not about time. Parsed instead — and an unparseable or
    timezone-naive stamp refuses rather than crashing the driver."""
    ev = _runs_ndjson(
        tmp_path,
        [
            {
                "persona": "acceptance_author",
                "started_at": "2026-08-05T10:00:00+00:00",
                "ended_at": "not-a-timestamp",
            },
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:00:30+00:00",
                "ended_at": "2026-08-05T10:09:00+00:00",
            },
        ],
    )
    got = A._acceptance_ordering(ev)
    assert got["ok"] is False
    assert "unparseable" in got["reason"]


def test_the_microsecond_width_edge_case_is_ordered_correctly(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The concrete case a string compare gets wrong: the author ends on an exact
    second (no ``.%f``) and the dev starts microseconds later in the SAME second."""
    ev = _runs_ndjson(
        tmp_path,
        [
            {
                "persona": "acceptance_author",
                "started_at": "2026-08-05T10:00:00+00:00",
                "ended_at": "2026-08-05T10:00:39+00:00",
            },
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:00:39.000001+00:00",
                "ended_at": "2026-08-05T10:09:00+00:00",
            },
        ],
    )
    assert A._acceptance_ordering(ev)["ok"] is True
    # And the reverse really is a violation, in the same second.
    ev2 = _runs_ndjson(
        tmp_path / "b",
        [
            {
                "persona": "acceptance_author",
                "started_at": "2026-08-05T10:00:00+00:00",
                "ended_at": "2026-08-05T10:00:39.000001+00:00",
            },
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:00:39+00:00",
                "ended_at": "2026-08-05T10:09:00+00:00",
            },
        ],
    )
    assert A._acceptance_ordering(ev2)["ok"] is False


def test_the_first_dev_call_is_chosen_by_time_not_by_file_order(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Two dev calls, written out of order: the EARLIEST start is the one the
    ordering has to beat."""
    ev = _runs_ndjson(
        tmp_path,
        [
            {
                "persona": "dev",
                "started_at": "2026-08-05T11:00:00+00:00",
                "ended_at": "2026-08-05T11:05:00+00:00",
            },
            {
                "persona": "acceptance_author",
                "started_at": "2026-08-05T10:30:00+00:00",
                "ended_at": "2026-08-05T10:30:10+00:00",
            },
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:00:00+00:00",
                "ended_at": "2026-08-05T10:20:00+00:00",
            },
        ],
    )
    got = A._acceptance_ordering(ev)
    assert got["dev_first_started_at"] == "2026-08-05T10:00:00+00:00"
    assert got["ok"] is False


def test_the_chains_own_store_and_worktree_dirs_never_contain_each_other(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """Read the invariant off the chain's OWN path functions rather than trusting
    this harness's arithmetic: `acceptance_dir` and the per-story worktree root
    must be siblings, neither containing the other. If the chain ever moved the
    store under `state/worktrees/`, the relocation below would be moving a file
    the dev had already been handed."""
    from factory.chain.acceptance import acceptance_dir

    store = acceptance_dir(tmp_path, "swebench", 7).resolve()
    worktrees = (tmp_path / "state" / "worktrees").resolve()
    assert worktrees not in store.parents and store != worktrees
    assert store not in worktrees.parents


# --------------------------------------------------------------------------- #
# property 3 — the authored test can never reach the graded diff
# --------------------------------------------------------------------------- #


def test_the_authored_oracles_filename_is_stripped_from_any_graded_diff(
    A: Any,  # noqa: N803
) -> None:
    """If the dev ever copied the oracle into the repo, the graded prediction
    must not contain it — the same strip and the same re-assertion every other
    test path goes through, checked against the pinned basename."""
    assert A.is_test_path(A._ACCEPTANCE_STORED_NAME)
    diff = (
        "diff --git a/src/app.py b/src/app.py\n"
        "@@ -1 +1 @@\n-a\n+b\n"
        f"diff --git a/{A._ACCEPTANCE_STORED_NAME} b/{A._ACCEPTANCE_STORED_NAME}\n"
        "@@ -0,0 +1 @@\n+assert True\n"
    )
    code, kept, stripped = A.split_diff(diff)
    assert kept == ["src/app.py"]
    assert stripped == [A._ACCEPTANCE_STORED_NAME]
    assert A._ACCEPTANCE_STORED_NAME not in code
    A.assert_no_test_edits(code)


def test_a_stored_name_that_would_not_be_stripped_refuses_before_spend(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Property 3 is asserted against ``_ACCEPTANCE_STORED_NAME`` BEFORE the
    author is called. If the chain ever renamed the stored file to something the
    classifier does not read as a test, the run must refuse rather than risk the
    oracle being graded as the arm's own patch."""
    monkeypatch.setattr(A, "_ACCEPTANCE_STORED_NAME", "oracle_notes.md")
    called: list[str] = []
    with pytest.raises(A.AcceptanceOracleUnavailable, match="does not classify"):
        A._author_bench_acceptance_oracle(
        arm="factory",
            instance_id="inst-x",
            problem_statement="x",
            story=_story(),
            app_config=_opted_in_config(),
            root=tmp_path / "root",
            db=tmp_path / "root" / "state" / "factory.db",
            dev_trees=(),
            author_fn=lambda p, s: called.append("spent") or "x",
        )
    assert called == [], "the author must not be called at all"


def test_a_mismatched_stored_name_refuses_the_row(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """And if the chain stores the test under a DIFFERENT name than the one
    property 3 was asserted against, that is also a refusal: the assertion would
    otherwise be about a file that does not exist."""
    monkeypatch.setattr(A, "_ACCEPTANCE_STORED_NAME", "test_other.py")
    with pytest.raises(A.AcceptanceOracleUnavailable, match="not 'test_other.py'"):
        A._author_bench_acceptance_oracle(
        arm="factory",
            instance_id="inst-x",
            problem_statement="x",
            story=_story(),
            app_config=_opted_in_config(),
            root=tmp_path / "root",
            db=tmp_path / "root" / "state" / "factory.db",
            dev_trees=(),
            author_fn=lambda p, s: "def test_x():\n    pass\n",
        )


# --------------------------------------------------------------------------- #
# property 4 — fail CLOSED
# --------------------------------------------------------------------------- #


def test_authoring_failure_refuses_the_row(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """A row that lost the independence layer is not the product this arm claims
    to measure, so authoring failure is fatal BEFORE any dev spend. Production
    takes the same posture (``acceptance_expected`` stays True and the merge gate
    blocks); what is forbidden is proceeding as if the oracle had run."""
    root = tmp_path / "root"
    root.mkdir()

    def _boom(prompt: str, st: Any) -> str:
        raise RuntimeError("provider 429")

    with pytest.raises(A.AcceptanceOracleUnavailable, match="produced no test"):
        A._author_bench_acceptance_oracle(
        arm="factory",
            instance_id="inst-x",
            problem_statement="fix it",
            story=_story(),
            app_config=_opted_in_config(),
            root=root,
            db=root / "state" / "factory.db",
            dev_trees=(),
            author_fn=_boom,
        )
    story = _story()
    # No oracle was stored, and the story stays EXPECTED — nothing downstream may
    # read the absence as "this story never needed one". (The chain's failed-pass
    # sidecar `attempts.json` legitimately lands in the store dir; the oracle
    # itself must not.)
    assert not list((root / "state" / "acceptance").rglob("test_acceptance.py"))
    assert story.acceptance_test_ref is None


def test_a_non_opted_in_app_refuses_rather_than_silently_skipping(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """If ``gates.acceptance_oracle`` regressed to False in ``_build_bench_root``,
    the chain would author nothing and the arm would quietly go back to measuring
    a product with no independence layer. Loud refusal, not a skip."""
    from factory.app_config import AppConfig

    with pytest.raises(A.AcceptanceOracleUnavailable, match="not opted in"):
        A._author_bench_acceptance_oracle(
        arm="factory",
            instance_id="inst-x",
            problem_statement="fix it",
            story=_story(),
            app_config=AppConfig(name="swebench", repo="a/b", app_repo_path="/x"),
            root=tmp_path / "root",
            db=tmp_path / "root" / "state" / "factory.db",
            dev_trees=(),
            author_fn=lambda p, s: "def test_x():\n    pass\n",
        )


def test_the_bench_root_opts_the_bench_app_in(A: Any) -> None:  # noqa: N803
    """The opt-in lives in the ONE config the factory arm loads, and
    ``_build_bench_root`` has exactly one caller — so no other arm changes."""
    src = inspect.getsource(A._build_bench_root)
    assert '"acceptance_oracle": True' in src
    callers = [
        fn
        for fn in ("run_factory", "run_bare", "run_openhands", "run_claude")
        if "_build_bench_root(" in inspect.getsource(getattr(A, fn))
    ]
    assert callers == ["run_factory"], callers


# --------------------------------------------------------------------------- #
# the ORDERING, measured from the run's own ledger
# --------------------------------------------------------------------------- #


def _runs_ndjson(tmp_path: Path, rows: list[dict[str, Any]]) -> Path:
    d = tmp_path / "events"
    d.mkdir(parents=True, exist_ok=True)
    (d / "runs.ndjson").write_text(
        "".join(json.dumps({"event": "run", **r}) + "\n" for r in rows),
        encoding="utf-8",
    )
    return d


def test_ordering_is_measured_from_the_ledger_not_asserted(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """"Authored before the dev's first call" must be re-derivable by a reader
    from the artifact. It is read out of ``runs.ndjson`` — the stream ``audit``
    certifies — comparing the author call's END to the dev's FIRST call's START."""
    ev = _runs_ndjson(
        tmp_path,
        [
            {
                "persona": "acceptance_author",
                "started_at": "2026-08-05T10:00:00+00:00",
                "ended_at": "2026-08-05T10:00:20+00:00",
            },
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:00:30+00:00",
                "ended_at": "2026-08-05T10:09:00+00:00",
            },
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:20:00+00:00",
                "ended_at": "2026-08-05T10:29:00+00:00",
            },
            {
                "persona": "reviewer",
                "started_at": "2026-08-05T10:30:00+00:00",
                "ended_at": "2026-08-05T10:31:00+00:00",
            },
        ],
    )
    got = A._acceptance_ordering(ev)
    assert got["ok"] is True
    assert got["acceptance_author_calls"] == 1
    assert got["dev_calls"] == 2
    assert got["acceptance_author_ended_at"] == "2026-08-05T10:00:20+00:00"
    assert got["dev_first_started_at"] == "2026-08-05T10:00:30+00:00"


def test_a_violated_ordering_is_reported_as_violated(A: Any, tmp_path: Path) -> None:  # noqa: N803
    ev = _runs_ndjson(
        tmp_path,
        [
            {
                "persona": "dev",
                "started_at": "2026-08-05T10:00:00+00:00",
                "ended_at": "2026-08-05T10:05:00+00:00",
            },
            {
                "persona": "acceptance_author",
                "started_at": "2026-08-05T10:06:00+00:00",
                "ended_at": "2026-08-05T10:06:20+00:00",
            },
        ],
    )
    got = A._acceptance_ordering(ev)
    assert got["ok"] is False
    assert "ORDERING VIOLATED" in got["reason"]


def test_an_absent_author_call_is_never_ok(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """FAIL CLOSED: "we could not measure it" must never read like "it held"."""
    ev = _runs_ndjson(
        tmp_path, [{"persona": "dev", "started_at": "t", "ended_at": "t"}]
    )
    got = A._acceptance_ordering(ev)
    assert got["ok"] is False
    assert "NO acceptance_author call" in got["reason"]


def test_a_missing_ledger_stream_is_never_ok(A: Any, tmp_path: Path) -> None:  # noqa: N803
    got = A._acceptance_ordering(tmp_path / "nothing-here")
    assert got["ok"] is False
    assert "unmeasurable" in got["reason"]
    assert got["acceptance_author_calls"] == 0


def test_an_author_call_with_no_dev_call_is_ok_and_says_why(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    ev = _runs_ndjson(
        tmp_path,
        [{"persona": "acceptance_author", "started_at": "a", "ended_at": "b"}],
    )
    got = A._acceptance_ordering(ev)
    assert got["ok"] is True
    assert "no dev call" in got["reason"]


# --------------------------------------------------------------------------- #
# cost accounting — the authoring call is billed to THIS run
# --------------------------------------------------------------------------- #


def test_the_authoring_calls_cost_must_be_in_this_runs_ledger(A: Any) -> None:  # noqa: N803
    """Zero author rows in the run's isolated ledger is a REFUSAL, not a footnote:
    it means the authoring spend went somewhere else, so `_ledger_totals` is
    under-pricing the product this arm is costing."""

    class _R:
        def __init__(self, persona: str) -> None:
            self.persona = persona

    assert A._acceptance_author_ledger_rows([_R("dev"), _R("reviewer")]) == 0
    assert A._acceptance_author_ledger_rows([_R("dev"), _R("acceptance_author")]) == 1


def test_the_bench_uses_the_PRODUCTION_authoring_call(  # noqa: N802
    A: Any,  # noqa: N803
) -> None:
    """No bench-local copy of the author. `acceptance._default_author` binds the
    real `_llm_author` to the root and db it is handed, so `author_fn=None` runs
    the PRODUCTION call and its Run row lands in this run's isolated ledger.

    This is pinned because the harness previously carried a duplicate of
    `_llm_author` purely to thread those two kwargs — and a duplicate means the
    measured arm running harness code where the product runs chain code."""
    from factory.chain import acceptance as acc

    assert not hasattr(A, "_bench_acceptance_author")
    src = inspect.getsource(A._author_bench_acceptance_oracle)
    assert "author_fn=author_fn," in src
    assert "_llm_author" not in src

    # The chain's default author really does bind the ledger it is given.
    default_src = inspect.getsource(acc._default_author)
    assert "software_factory_root=software_factory_root" in default_src
    assert "db_path=db_path" in default_src

    # And the independent author's weights are NOT the dev's.
    from factory.model_router import route

    assert route("acceptance_author") != route("dev", "standard")


def test_the_persisted_spec_prompt_is_the_one_that_was_sent(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """`build_spec_prompt` takes a `harness_hint` the chain passes. Re-calling it
    WITHOUT the hint would persist a prompt that is not the one the author saw —
    provenance that quietly disagrees with the artifact it documents."""
    from factory.chain import acceptance as acc

    seen: list[str] = []
    real = acc.build_spec_prompt

    def _spy(story: Any, direction: Any, **kw: Any) -> str:
        out = real(story, direction, **kw)
        seen.append(out)
        return out

    monkeypatch.setattr(acc, "build_spec_prompt", _spy)
    root = tmp_path / "root"
    root.mkdir()
    cfg = _opted_in_config()
    cfg.gates.acceptance_harness_hint = "the app lives at /srv/app; import `app`"
    prov = A._author_bench_acceptance_oracle(
        arm="factory",
        instance_id="inst-h",
        problem_statement="fix the widget",
        story=_story(),
        app_config=cfg,
        root=root,
        db=root / "state" / "factory.db",
        dev_trees=(),
        author_fn=lambda p, s: "def test_ac1():\n    assert True\n",
    )
    sent, persisted = seen[0], Path(prov["spec_prompt_path"]).read_text(encoding="utf-8")
    assert sent == persisted
    assert "the app lives at /srv/app" in persisted


# --------------------------------------------------------------------------- #
# the driver — ordering enforced, not just measured
# --------------------------------------------------------------------------- #


def _fn(name: str) -> Any:
    tree = ast.parse(_ADAPTER.read_text(encoding="utf-8"))
    return next(
        n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name
    )


def _stmt_index_calling(fn: Any, callee: str) -> int:
    for i, stmt in enumerate(fn.body):
        for n in ast.walk(stmt):
            if not isinstance(n, ast.Call):
                continue
            named = getattr(n.func, "id", None) or getattr(n.func, "attr", None)
            if named == callee:
                return i
    raise AssertionError(f"{fn.name} never calls {callee}")


def test_run_factory_authors_the_oracle_before_the_dev_is_dispatched(
    A: Any,  # noqa: N803
) -> None:
    """THE ordering guarantee, enforced at CI time on the source: the authoring
    call is a straight-line statement of ``run_factory`` that precedes the
    dispatch loop, so no branch can reach a dev model call first."""
    fn = _fn("run_factory")
    author_at = _stmt_index_calling(fn, "_author_bench_acceptance_oracle")
    assert author_at < _stmt_index_calling(fn, "_invoke_handler")
    assert author_at < _stmt_index_calling(fn, "_dispatch_for_story")


def test_run_factory_refuses_the_row_when_the_oracle_is_unavailable(
    A: Any,  # noqa: N803
) -> None:
    """Fail-closed wiring, checked structurally: the handler for
    ``AcceptanceOracleUnavailable`` records an ``error`` (so ``classify_run``
    buckets the row ``run_failed``) and exits — it never falls through. And the
    post-run verification refuses through the same route ``DiffRefused`` takes:
    no ``prediction.diff`` is written."""
    src = inspect.getsource(A.run_factory)
    fn = ast.parse(src.lstrip()).body[0]
    handlers = [
        h
        for h in ast.walk(fn)
        if isinstance(h, ast.ExceptHandler)
        and "AcceptanceOracleUnavailable" in ast.dump(h)
    ]
    assert handlers, "run_factory does not handle AcceptanceOracleUnavailable"
    body = ast.dump(handlers[0])
    assert "_write_result" in body
    assert "SystemExit" in body

    assert "acceptance_failure is not None" in src
    assert src.index("acceptance_failure is not None") < src.index(
        '(run_dir / "prediction.diff").write_text'
    )


def test_the_result_row_carries_the_whole_provenance_block(A: Any) -> None:  # noqa: N803
    """The done-condition is a ROW, not a log line: ``result.json`` has to carry
    enough that a reader can verify the ordering without the run present."""
    src = inspect.getsource(A.run_factory)
    assert '"acceptance": acceptance,' in src
    assert 'acceptance["ordering"] = _acceptance_ordering(' in src
    assert 'acceptance["authored_before_dev_first_call"]' in src
    assert 'acceptance["ledger_author_rows"]' in src


# --------------------------------------------------------------------------- #
# arm parity — only the factory arm changed
# --------------------------------------------------------------------------- #


def test_no_other_arm_learned_about_the_acceptance_oracle(A: Any) -> None:  # noqa: N803
    """Prompt asymmetry between arms invalidated a published headline once
    already. The acceptance oracle is part of the CHAIN, so it must appear in the
    factory arm and nowhere else — and no arm's task text may mention it, or the
    comparison varies two things at once."""
    for fn in ("run_bare", "run_openhands", "run_claude", "_claude_task_prompt"):
        assert "acceptance" not in inspect.getsource(getattr(A, fn)).lower(), fn
    for prompt in (A._STORY_TEMPLATE, A._BARE_SYSTEM, A._BARE_TASK, A._TEST_POLICY):
        assert "acceptance" not in prompt.lower()


def test_the_shared_task_text_is_pinned_byte_for_byte(A: Any) -> None:  # noqa: N803
    """Every arm but ``bare`` renders the SAME task text, and ``bare`` shares the
    two policy blocks. Pin the rendered bytes: arm parity was the subject of a
    retraction, and a prompt edit is exactly the change that would slip through
    a test suite about behaviour."""
    rendered = A._STORY_TEMPLATE.format(
        instance_id="i", statement="s", test_command="c"
    )
    assert len(rendered) == 1542
    assert (
        hashlib.sha256(rendered.encode("utf-8")).hexdigest()
        == "4bfda3c4e0858a31440aecec415bc1a8f412f6ad7c6127f5b8fd3c38b6531ecd"
    ), "the shared story template moved — no arm's prompt may change here"
    # The two byte-identical blocks the bare arm shares (the asymmetry that
    # invalidated the retracted headline): the test policy reaches bare through
    # its system prompt, the base-tests note through its task text.
    assert A._TEST_POLICY in rendered and A._TEST_POLICY in A._BARE_SYSTEM
    assert A._BASE_TESTS_NOTE in rendered and A._BASE_TESTS_NOTE in A._BARE_TASK


# --------------------------------------------------------------------------- #
# the reviewer corpus — archived without widening the fail-closed refusal set
# --------------------------------------------------------------------------- #


def test_the_reviewer_corpus_is_archived_as_an_optional_extra(A: Any) -> None:  # noqa: N803
    """The reviewer prompt/response corpus lives in gitignored scratch that
    ``_reset_run_artifacts`` deletes at the top of every run, so one re-run
    destroys it permanently. It is archived as an OPTIONAL extra: adding it to
    ``_ROW_ARTIFACTS`` would refuse every existing row and every non-factory arm,
    retroactively invalidating the committed archives and ``report --check``."""
    assert A._ROW_ARTIFACTS == ("result.json", "audit.json", "prediction.diff")
    assert A._ARCHIVED_ROW_EXTRAS == (
        "root/state/events/prompt_bodies.ndjson",
        "root/state/events/response_bodies.ndjson",
        "spec_prompt.md",
        "acceptance-events.ndjson",
        # The sssf arms' CONFIG evidence, added 2026-08-13. ``benchmark_store``
        # already digested all three (its ``_CONFIG`` tuple), so before this the
        # store recorded hashes of files no archive held and the next sweep
        # deleted — a trail that verifies bytes which will vanish. The roster is
        # the load-bearing one: it IS the record of which models an arm ran, so a
        # row without it cannot be re-attributed to a model set.
        "sssf-roster.yaml",
        "sssf-prompt.md",
        "attempt.json",
    )
    # And each is genuinely optional, never part of the fail-closed refusal set:
    # no existing archive holds them, so requiring them would invalidate all nine.
    for name in ("sssf-roster.yaml", "sssf-prompt.md", "attempt.json"):
        assert name not in A._ROW_ARTIFACTS
    src = inspect.getsource(A._archive_report_artifacts)
    assert "_ARCHIVED_ROW_EXTRAS" in src
    assert "if src.is_file()" in src, "an absent extra must never fail the archive"


def test_a_stale_spec_prompt_cannot_outlive_its_run(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """A run that dies before authoring would otherwise leave the PREVIOUS run's
    spec prompt beside the new ``result.json``, and a reader would take one run's
    oracle input for another's."""
    for name in (A._ACCEPTANCE_SPEC_NAME, A._ACCEPTANCE_EVENTS_NAME):
        (tmp_path / name).write_text("stale", encoding="utf-8")
    A._reset_run_artifacts(tmp_path)
    for name in (A._ACCEPTANCE_SPEC_NAME, A._ACCEPTANCE_EVENTS_NAME):
        assert not (tmp_path / name).exists(), name


def test_the_archive_really_copies_the_corpus_and_keeps_its_layout(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """Behaviour, not source inspection: a factory row's corpus lands in the
    archive at the SAME relative path, and a row without one archives fine."""
    monkeypatch.setattr(A, "RESULTS_ARCHIVE_DIR", tmp_path / "results-archive")
    monkeypatch.setattr(A, "SWE_DIR", tmp_path / "swe")
    (tmp_path / "swe").mkdir()

    rows = []
    for arm, with_corpus in (("factory", True), ("bare", False)):
        d = tmp_path / "runs" / "inst" / arm
        d.mkdir(parents=True)
        for name in A._ROW_ARTIFACTS:
            (d / name).write_text("{}", encoding="utf-8")
        if with_corpus:
            ev = d / "root" / "state" / "events"
            ev.mkdir(parents=True)
            (ev / "prompt_bodies.ndjson").write_text(
                '{"persona":"reviewer","prompt_hash":"h"}\n', encoding="utf-8"
            )
            (ev / "response_bodies.ndjson").write_text(
                '{"persona":"reviewer","prompt_hash":"h","verdict":"approve"}\n',
                encoding="utf-8",
            )
        rows.append({"_arm": arm, "_run_dir": str(d)})

    out = A._archive_report_artifacts(
        rows,
        generated_at="2026-08-05T00:00:00+00:00",
        table_text="t",
        refused=[],
        foreign=[],
        superseded=[],
        created={},
    )
    corpus = out / "inst" / "factory" / "root" / "state" / "events"
    assert (corpus / "prompt_bodies.ndjson").is_file()
    assert "verdict" in (corpus / "response_bodies.ndjson").read_text(encoding="utf-8")
    # The bare row archived cleanly with no corpus at all.
    assert (out / "inst" / "bare" / "result.json").is_file()
    assert not (out / "inst" / "bare" / "root").exists()
    # And the extras never become rows: ``_report_rows`` globs ``*/*/result.json``.
    assert sorted(p.relative_to(out).parts[:2] for p in out.glob("*/*/result.json")) == [
        ("inst", "bare"),
        ("inst", "factory"),
    ]


def test_a_row_without_the_extras_is_still_a_valid_row(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """The completeness refusal reads ``_ROW_ARTIFACTS`` only. Every published
    row, and every non-factory arm, lacks the extras — none of them may start
    being refused."""
    runs = tmp_path / "runs"
    d = runs / "inst" / "bare"
    d.mkdir(parents=True)
    (d / "prediction.diff").write_text("diff --git a/x.py b/x.py\n", encoding="utf-8")
    (d / "result.json").write_text(
        json.dumps({"arm": "bare", "instance_id": "inst", "manifest_sha256": "s"}),
        encoding="utf-8",
    )
    (d / "audit.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
    rows, refused, foreign, superseded = A._report_rows(runs, expected_sha="s")
    assert refused == [], refused
    assert len(rows) == 1
