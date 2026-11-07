"""factory.manager.forbidden_paths — the single forbidden-path classifier.

Shared by the chain's self-edit guard (``factory.chain.auto_merge``) and any
future manager apply path. Moved out of the L4 apply tier
(``factory/manager/apply.py``), which was deleted 2026-08-07 along with the
other three FMS LLM tiers (watcher/summarizer/diagnostician) — see
``STATUS.md`` and the Exteroception v1 direction, P0.

``_any_path_is_forbidden_in_patch`` is the entry point callers must use.

Behavior change from the move (2026-08-07, review round): the old
"new-detector carve-out" — allowing a patch to CREATE a new
``factory/manager/detectors/<x>.py`` file — is REMOVED here. That carve-out
existed only to hand new-detector proposals off to ``_validate_detector_tool``
in the now-deleted ``apply.py``; with that validator gone the carve-out was an
unbacked hole (a chain self-edit creating a new detector file reached staging
with ``allow=True`` while every other ``factory/manager/**`` path was
blocked). CLAUDE.md is explicit: ``factory/manager/**`` is operator-PR-only,
no exceptions — so ``factory/manager/<subdir>/*.py`` is now forbidden
unconditionally, new file or not.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Forbidden file patterns: any match → classified forbidden.
#
# Recursion safety (Phase 8):
# The first pattern was extended from ``^factory/manager/[^/]+\.py$`` (flat
# match only) to ``^factory/manager/.+\.py$`` (any depth).  This covers
# sub-directory files such as ``factory/manager/detectors/cost_spike.py``.
#
# No carve-out for new detector files (removed 2026-08-07, review round): a
# NEW file under ``factory/manager/detectors/`` used to be exempted here so
# the L3 Diagnostician's detector-authorship loop could hand it off to
# ``_validate_detector_tool`` in ``apply.py``. Both L3 and that validator are
# deleted now, so the exemption had no backing validator left — it just let a
# self-edit create a file under ``factory/manager/**`` unblocked. Every path
# under ``factory/manager/**`` is forbidden unconditionally, new or modified.
_FORBIDDEN_PATH_PATTERNS = (
    re.compile(r"^factory/manager/.+\.py$"),  # manager/**/*.py (any depth)
    re.compile(r"^factory/chain/factory_improver_apply\.py$"),  # the old apply module
    re.compile(
        r"^factory/manager/apply\.py$"
    ),  # this module itself (redundant with above, explicit)
    # WS3.1: the held-out benchmark harness that JUDGES the factory must stay
    # forbidden — the self-improvement loop must never edit the bench that
    # scores it (a loop that can rewrite its own grader is unfalsifiable). This
    # is forbidden regardless of the staging gate: staging validates "does the
    # factory run", not "is the bench still honest".
    re.compile(r"^bench/.+$"),  # bench/** (the grader)
    # The tracer and the verifiers. Weng's rule (cited in
    # SOTA-RESEARCH-2026-07.md): a self-improving agent must not be able
    # to edit the runs directory, the tracer, the verifier, or the LLM config
    # that judge it. A loop that can weaken its own integrity check is
    # unfalsifiable in exactly the way an editable grader is.
    #
    # Note these are NOT covered by the manager patterns above: they live under
    # factory/observability/, and the model_router route table is YAML, which
    # the ``\.py$`` patterns would miss entirely.
    re.compile(r"^factory/observability/audit_chain\.py$"),  # the integrity chain
    re.compile(r"^factory/observability/conformance\.py$"),  # the trace checker
    re.compile(r"^factory/observability/conformance_model\.yaml$"),  # its abstract model
    re.compile(r"^factory/observability/state_trace\.py$"),  # the trace emitter
)

# Sub-pattern that matches *only* manager sub-directory .py files (e.g.
# ``factory/manager/detectors/cost_spike.py``). No longer distinguished from
# the flat pattern by behavior (both are unconditionally forbidden) — kept
# as its own named pattern for the explicit subdirectory branch below rather
# than collapsing the two ``_path_is_forbidden_in_patch`` branches into one.
_MANAGER_SUBDIR_PATTERN = re.compile(r"^factory/manager/[^/]+/[^/]+\.py$")

# The flat manager/*.py pattern (always forbidden, no carve-out).
_MANAGER_FLAT_PATTERN = re.compile(r"^factory/manager/[^/]+\.py$")


# ---------------------------------------------------------------------------
# Path-level forbidden check
# ---------------------------------------------------------------------------


def _path_is_forbidden(path: str) -> bool:
    """Return True if the given relative path matches any forbidden pattern.

    Treats all ``factory/manager/**/*.py`` as forbidden — no carve-out.
    ``_path_is_forbidden_in_patch`` below is the patch-aware sibling; since
    2026-08-07 (review round) the two agree on every manager path, but the
    patch-aware form is still the one callers outside this module should use
    (``_any_path_is_forbidden_in_patch`` is the documented entry point).
    """
    for pat in _FORBIDDEN_PATH_PATTERNS:
        if pat.match(path):
            return True
    return False


def _path_is_forbidden_in_patch(path: str, patch: str) -> bool:
    """Return True if *path* is forbidden given the context of *patch*.

    - flat ``factory/manager/*.py`` → forbidden.
    - any ``factory/manager/<subdir>/*.py`` (e.g. ``detectors/*.py``) →
      forbidden UNCONDITIONALLY, including a patch that CREATES a new file.
      (Before 2026-08-07 a new file here was carved out for
      ``_validate_detector_tool`` in the now-deleted ``apply.py``; that
      validator no longer exists, so the carve-out is gone too — see the
      module docstring.)
    - Everything else falls through to the standard forbidden-pattern check.

    ``patch`` stays part of the signature for API stability (callers already
    pass it, and other forbidden patterns may in the future need diff
    context) even though the current logic no longer inspects it.
    """
    # Flat manager/*.py is always forbidden.
    if _MANAGER_FLAT_PATTERN.match(path):
        return True

    # Any manager sub-directory file (new or modified) is forbidden.
    if _MANAGER_SUBDIR_PATTERN.match(path):
        return True

    # Check remaining forbidden patterns (e.g. factory_improver_apply.py).
    for pat in _FORBIDDEN_PATH_PATTERNS:
        if pat.match(path):
            return True
    return False


def _any_path_is_forbidden_in_patch(paths: list[str], patch: str) -> bool:
    """The entry point: True if any of ``paths`` is forbidden.

    ``_any_path_is_forbidden`` (the no-patch-context sibling) was removed
    2026-08-07 (review round) — it had zero callers once the carve-out it
    existed to bypass was gone. Use this function.
    """
    return any(_path_is_forbidden_in_patch(p, patch) for p in paths)
