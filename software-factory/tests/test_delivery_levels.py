import pytest

from factory.delivery import DeliveryConfig, effective_level
from factory.delivery import DeliveryLevel as L


def test_absent_block_keeps_legacy_auto_merge():
    assert effective_level(None) is L.AUTO_MERGE
    assert effective_level(DeliveryConfig()) is L.AUTO_MERGE


def test_request_wins_in_both_directions():
    cfg = DeliveryConfig(default=L.DRAFT_PR)
    assert effective_level(cfg) is L.DRAFT_PR
    assert effective_level(cfg, "branch") is L.BRANCH
    assert effective_level(cfg, "push_to_main") is L.PUSH_TO_MAIN
    assert effective_level(cfg, "AUTO_MERGE") is L.AUTO_MERGE


def test_garbage_request_fails_safe_to_none():
    assert effective_level(DeliveryConfig(), "merge-please") is L.NONE


def test_ceiling_key_is_refused():
    with pytest.raises(ValueError):
        DeliveryConfig.model_validate({"max": "pr", "default": "draft_pr"})


def test_predicates():
    assert not L.NONE.pushes and L.BRANCH.pushes
    assert L.DRAFT_PR.opens_pr and not L.BRANCH.opens_pr and not L.PUSH_TO_MAIN.opens_pr
    assert L.AUTO_MERGE.merges and L.PUSH_TO_MAIN.merges and not L.PR.merges
