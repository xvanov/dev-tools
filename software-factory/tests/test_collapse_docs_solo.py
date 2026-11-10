"""A solo job with acceptance criteria never lands on the docs chain.

The docs chain has no dev step and skips gates; its onboarder writes context
docs, so a README edit ends 'onboarder produced no files' and blocks."""

from __future__ import annotations

from types import SimpleNamespace

from factory.chain.handlers import _collapse_child_stories

_DOCS = [{"title": "t", "scope": "docs", "chain_kind": "docs"}]


def test_pure_docs_job_with_acceptance_runs_the_tdd_chain() -> None:
    d = SimpleNamespace(title="docs: x", acceptance=["README has the sentence"])
    assert _collapse_child_stories(d, list(_DOCS), {})["chain_kind"] == "tdd"


def test_pure_docs_job_without_acceptance_stays_docs() -> None:
    d = SimpleNamespace(title="docs: x", acceptance=[])
    assert _collapse_child_stories(d, list(_DOCS), {})["chain_kind"] == "docs"
