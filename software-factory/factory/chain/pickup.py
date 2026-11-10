"""Branch / PR pickup (JOBS-API v1.3): a job that continues on EXISTING work.

``factory job submit --branch <name>`` or ``--pr <n>`` records the branch (and
the PR, and the branch that PR merges into) in the direction frontmatter as::

    base:
      branch: feature/login       # the existing remote branch the job works on
      pr: 42                      # its open PR, or null
      into: main                  # the branch that PR merges into (else the default)

At spawn the chain stamps those three facts on the story
(``StoryRecord.pickup_branch`` / ``pickup_pr`` / ``pickup_into``), exactly like
``delivery_level`` and ``pipeline``, so a later edit of the direction never
moves an in-flight story onto another branch. Every place that names, creates,
pushes or rebuilds a story branch asks this module first:

* :func:`story_branch` — the story's branch: the picked-up branch, else the
  factory's own ``factory/story-<issue>-<slug>``.
* :func:`story_into` — what the branch is refreshed from / merges into: the
  PR's base, else the app's default branch.
* :func:`is_pickup` — the branch belongs to a human. The chain then never
  force-pushes it, never deletes it (after a merge or for a conflict
  rebuild), never closes its PR and never opens a second PR for it.

A picked-up job is always ONE story (no dual-draft, no slices): two stories
cannot share one branch.
"""

from __future__ import annotations

from typing import Any

#: Frontmatter key ``factory job submit`` writes for a pickup job.
FRONTMATTER_KEY = "base"


def pickup_of_meta(meta: Any) -> dict[str, Any] | None:
    """``{"branch", "pr", "into"}`` from a direction's frontmatter, or ``None``.

    Never raises: a malformed value is treated as "no pickup" (the job then
    runs on a fresh factory branch, which never touches a human's branch).
    """
    if not isinstance(meta, dict):
        return None
    raw = meta.get(FRONTMATTER_KEY)
    if not isinstance(raw, dict):
        return None
    branch = str(raw.get("branch") or "").strip()
    if not branch:
        return None
    pr_raw = raw.get("pr")
    try:
        pr = int(str(pr_raw)) if pr_raw not in (None, "") else None
    except (TypeError, ValueError):
        pr = None
    into = str(raw.get("into") or "").strip() or None
    return {"branch": branch, "pr": pr if pr and pr > 0 else None, "into": into}


def pickup_of_direction(direction: Any) -> dict[str, Any] | None:
    return pickup_of_meta(getattr(direction, "raw_frontmatter", None))


def stamp_story(story: Any, direction: Any) -> dict[str, Any] | None:
    """Copy the direction's pickup onto a NEW story (spawn). Returns it, or None."""
    pickup = pickup_of_direction(direction)
    if pickup is None:
        return None
    story.pickup_branch = pickup["branch"]
    story.pickup_pr = pickup["pr"]
    story.pickup_into = pickup["into"]
    story.github_branch = pickup["branch"]
    return pickup


def is_pickup(story: Any) -> bool:
    return bool(str(getattr(story, "pickup_branch", None) or "").strip())


def story_branch(story: Any) -> str:
    """The branch this story's work lives on."""
    if is_pickup(story):
        return str(story.pickup_branch).strip()
    from factory.chain.branch import feature_branch_name
    from factory.chain.state_machine import story_number

    return feature_branch_name(story_number(story), story.slug)


def story_into(story: Any, app_config: Any) -> str:
    """The branch the story branch is refreshed from and merges into."""
    into = str(getattr(story, "pickup_into", None) or "").strip()
    if into:
        return into
    return str(getattr(app_config, "default_branch", None) or "main")


__all__ = [
    "FRONTMATTER_KEY",
    "is_pickup",
    "pickup_of_direction",
    "pickup_of_meta",
    "stamp_story",
    "story_branch",
    "story_into",
]
