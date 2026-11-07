"""A3 (BENCHMARK-READINESS-PLAN.md) — separate ARRANGE from ASSERT.

Setup ("create a goal so the count can increment") is not a behavioural
judgment: story 179's false block arrived as a 422 on an arrange call, and the
gate reported it as a verdict on the story. The split: the authoring prompt
tells setup helpers to ``pytest.fail("SETUP: ...")``; the runner classifies
those failures out of junit messages (outcomes unchanged); the gate records
them in details and — when EVERY failing criterion is setup — says so in the
block reason instead of "assertion failed at HEAD". The block itself stands:
an unarranged scenario proves nothing either way, which is the fail-safe
direction.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from factory.app_config import AcceptanceBootConfig, AppConfig, AppGatesConfig
from factory.chain import oracle_run, stub_server
from factory.chain.acceptance import build_spec_prompt
from factory.chain.gates import acceptance_verified
from factory.chain.gates.evaluator import PRContext
from factory.chain.state_machine import StoryRecord, StoryState
from tests.oracle_boot_fixture import BAD_IMPL, GOOD_IMPL, boot_cfg, write_bootable_app
from tests.oracle_repo import commit_all, git, init_repo

# --------------------------------------------------------------------------- #
# runner: junit message classification
# --------------------------------------------------------------------------- #

_SETUP_FAIL_ORACLE = """\
import os
import httpx
import pytest


def _arrange(client):
    r = client.get("/prerequisite")
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or "prerequisite_id" not in body:
        pytest.fail(f"SETUP: prerequisite fetch got {r.status_code} body={body!r}")
    return body["prerequisite_id"]


def test_ac1_observable():
    base = os.environ["ACCEPTANCE_BASE_URL"]
    with httpx.Client(base_url=base) as c:
        _arrange(c)
        r = c.get("/")
        assert r.json()["value"] == "expected"
"""

_PLAIN_FAIL_ORACLE = """\
import os
import httpx


def test_ac1_observable():
    base = os.environ["ACCEPTANCE_BASE_URL"]
    with httpx.Client(base_url=base) as c:
        r = c.get("/")
        # The compared literal contains "SETUP:" so the junit first line —
        # the REPR of this comparison (production-controlled text) — contains
        # the marker mid-line. A substring classifier would let the app under
        # test disguise a genuine feature failure as an arrange failure.
        assert r.json() == {"note": "SETUP: expected note"}
"""


def test_setup_prefixed_failure_is_classified() -> None:
    with stub_server.stub_app() as stub:
        run = oracle_run.run_oracle(
            _SETUP_FAIL_ORACLE, base_url=stub.base_url, run_id="a3-setup",
            dest_name="test_oracle_a3a.py", timeout_s=30,
        )
    nodeid = next(iter(run.criteria))
    assert run.criteria[nodeid] == "FAIL", run.output
    assert run.setup_failures == [nodeid], (
        f"a pytest.fail('SETUP: ...') must classify as a setup failure; got "
        f"{run.setup_failures!r}\n{run.output[-500:]}"
    )


def test_plain_assertion_failure_is_not_classified_as_setup() -> None:
    """The classifier must match author-side prefixes by STARTSWITH, never by
    substring: a bare assert's junit first line is the repr of the APP'S
    RESPONSE — production-controlled text — so an app whose body contains
    'SETUP:' must not be able to disguise a genuine feature failure as an
    arrange failure (adversarial review finding #1)."""
    with stub_server.stub_app() as stub:
        run = oracle_run.run_oracle(
            _PLAIN_FAIL_ORACLE, base_url=stub.base_url, run_id="a3-plain",
            dest_name="test_oracle_a3b.py", timeout_s=30,
        )
    nodeid = next(iter(run.criteria))
    assert run.criteria[nodeid] == "FAIL", run.output
    assert run.setup_failures == [], run.setup_failures


# --------------------------------------------------------------------------- #
# authoring prompt carries the convention
# --------------------------------------------------------------------------- #


def test_authoring_prompt_instructs_the_arrange_assert_split() -> None:
    story = StoryRecord(
        id=7, direction_id="900", app="sacrifice", title="t", slug="s",
        scope="backend", state=StoryState.STORY_CREATED.value,
    )

    class _D:
        acceptance = ["Observable outcome."]
        has_flow = False
        has_api_spec = False
        dir_path = Path(".")

    prompt = build_spec_prompt(
        story, _D(), harness_hint="- `GET /x` -> 200",
        boot=AcceptanceBootConfig(command="x --port {port}"),
    )
    assert "SEPARATE ARRANGE FROM ASSERT" in prompt
    assert 'pytest.fail(f"SETUP:' in prompt


# --------------------------------------------------------------------------- #
# gate: an all-setup red names the true cause; the block stands
# --------------------------------------------------------------------------- #

_GATE_SETUP_ORACLE = """\
import os
import httpx
import pytest


def _arrange(client):
    # A real HTTP call (so the stub-vacuity control sees traffic), whose
    # response can never carry the prerequisite this arrange step needs —
    # the setup fails identically against stubs, base, and head.
    r = client.post("/normalize", json={"email": "User@Example.COM"})
    body = {}
    try:
        body = r.json()
    except Exception:
        pass
    if "prerequisite_token" not in body:
        pytest.fail(f"SETUP: prerequisite entity could not be created "
                    f"(got {r.status_code}, body keys {sorted(body)})")
    return body["prerequisite_token"]


def test_ac1_email_is_lowercased():
    base = os.environ["ACCEPTANCE_BASE_URL"]
    with httpx.Client(base_url=base) as c:
        token = _arrange(c)
        r = c.post("/normalize", json={"email": "User@Example.COM", "token": token})
        assert r.json()["email"] == "user@example.com"
"""


def _store(root: Path, content: str) -> str:
    from factory.chain.acceptance import acceptance_dir

    out = acceptance_dir(root, "sacrifice", 7)
    out.mkdir(parents=True, exist_ok=True)
    (out / "test_acceptance.py").write_text(content, encoding="utf-8")
    return str((out / "test_acceptance.py").relative_to(root))


def test_all_setup_red_blocks_with_the_setup_reason(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    write_bootable_app(repo, impl=BAD_IMPL)
    commit_all(repo, "base")
    git(repo, "checkout", "-q", "-b", "feat/story")
    write_bootable_app(repo, impl=GOOD_IMPL)
    (repo / "backend" / "app" / "story_marker.py").write_text("MARKER = 1\n", encoding="utf-8")
    head = commit_all(repo, "story work")

    root = tmp_path / "factory"
    ref = _store(root, _GATE_SETUP_ORACLE)
    story = StoryRecord(
        id=7, direction_id="002", app="sacrifice", title="t", slug="s",
        scope="backend", state=StoryState.PR_OPEN.value,
        acceptance_test_ref=ref, acceptance_expected=True,
    )
    pr = PRContext(
        pr_number=1, head_sha=head, base_branch="main", story=story,
        repo_root=repo, software_factory_root=root, dry_run=False,
    )
    cfg = AppConfig(
        name="sacrifice", repo="o/r",
        gates=AppGatesConfig(acceptance_oracle=True, acceptance_boot=boot_cfg()),
    )

    r = acceptance_verified.evaluate(pr, cfg)

    assert not r.passed, "an unarranged scenario proves nothing — the block must stand"
    assert r.details["authoritative"] is True
    assert "SETUP failed at HEAD" in r.reason, r.reason
    assert "NOT a verdict on the feature" in r.reason
    assert r.details["head_setup_failures"], r.details.get("head_setup_failures")

    # The recorded block must carry the oracle's own SETUP text as feedback —
    # that is what the bounded auto-re-author hands the next author (185
    # class). Without it the re-author is blind and re-invents the same
    # un-arrangeable setup.
    from factory.chain.acceptance import read_gate_block

    gb = read_gate_block(root, "sacrifice", 7)
    assert gb is not None and gb["kind"] == "oracle_setup_failed", gb
    assert "SETUP:" in str(gb.get("feedback") or ""), gb


#: The SAME arrange failure, but raised from a FIXTURE — pytest renders it as
#: junit ERROR, not FAIL. Story 185's re-authored oracle (2026-08-10) had this
#: exact shape (a fixture-borne 422 on a reserved email TLD).
_GATE_FIXTURE_SETUP_ORACLE = """\
import os

import httpx
import pytest


@pytest.fixture
def token():
    base = os.environ["ACCEPTANCE_BASE_URL"]
    with httpx.Client(base_url=base) as c:
        r = c.post("/normalize", json={"email": "User@Example.COM"})
        body = {}
        try:
            body = r.json()
        except Exception:
            pass
        if "prerequisite_token" not in body:
            pytest.fail(f"SETUP: prerequisite entity could not be created "
                        f"(got {r.status_code}, body keys {sorted(body)})")
        return body["prerequisite_token"]


def test_ac1_email_is_lowercased(token):
    base = os.environ["ACCEPTANCE_BASE_URL"]
    with httpx.Client(base_url=base) as c:
        r = c.post("/normalize", json={"email": "User@Example.COM", "token": token})
        assert r.json()["email"] == "user@example.com"
"""


def test_fixture_borne_setup_failure_is_still_classified(tmp_path: Path) -> None:
    """`pytest.fail("SETUP: ...")` inside a FIXTURE is a junit ERROR, so the
    run is errors-only — which used to take the plain errors-only branch:
    right block, wrong diagnosis, no `oracle_setup_failed` record, and the
    bounded auto-re-author could never fire on exactly the class it was
    built for (story 185's re-authored oracle, 2026-08-10)."""
    repo = tmp_path / "repo"
    init_repo(repo)
    write_bootable_app(repo, impl=BAD_IMPL)
    commit_all(repo, "base")
    git(repo, "checkout", "-q", "-b", "feat/story")
    write_bootable_app(repo, impl=GOOD_IMPL)
    (repo / "backend" / "app" / "story_marker.py").write_text("MARKER = 1\n", encoding="utf-8")
    head = commit_all(repo, "story work")

    root = tmp_path / "factory"
    ref = _store(root, _GATE_FIXTURE_SETUP_ORACLE)
    story = StoryRecord(
        id=7, direction_id="002", app="sacrifice", title="t", slug="s",
        scope="backend", state=StoryState.PR_OPEN.value,
        acceptance_test_ref=ref, acceptance_expected=True,
    )
    pr = PRContext(
        pr_number=1, head_sha=head, base_branch="main", story=story,
        repo_root=repo, software_factory_root=root, dry_run=False,
    )
    cfg = AppConfig(
        name="sacrifice", repo="o/r",
        gates=AppGatesConfig(acceptance_oracle=True, acceptance_boot=boot_cfg()),
    )

    r = acceptance_verified.evaluate(pr, cfg)

    assert not r.passed
    assert r.details["authoritative"] is True
    assert "SETUP failed at HEAD" in r.reason, r.reason
    assert r.details["head_setup_failures"], r.details.get("head_setup_failures")

    from factory.chain.acceptance import read_gate_block

    gb = read_gate_block(root, "sacrifice", 7)
    assert gb is not None and gb["kind"] == "oracle_setup_failed", gb
    assert "SETUP:" in str(gb.get("feedback") or ""), gb
    assert gb.get("oracle_sha"), "sha stamp is what lets the auto-re-author act"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
