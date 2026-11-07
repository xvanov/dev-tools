"""How far the factory may take a piece of work on its own — per app, per job.

One ordered vocabulary shared with the personal assistant (see
``docs/JOBS-API.md``)::

    none < branch < draft_pr < pr < auto_merge < push_to_main

An app's ``config.yaml`` sets a default (``delivery.default``). A job
(direction) may request ANY level in its ``direction.md`` frontmatter
(``delivery: <level>``) and that request wins outright — there is no per-app
ceiling (operator decision 2026-11-02: whoever submits the job, normally the
personal assistant acting on the operator's instruction, decides the end
state). An unknown or malformed request resolves to the most restrictive
level, ``none`` (fail safe: a typo must never make the factory do more than
intended).

Apps with no ``delivery`` block keep today's behaviour, ``auto_merge``, so this
module changes nothing until an app opts in.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, model_validator


class DeliveryLevel(StrEnum):
    NONE = "none"
    BRANCH = "branch"
    DRAFT_PR = "draft_pr"
    PR = "pr"
    AUTO_MERGE = "auto_merge"
    PUSH_TO_MAIN = "push_to_main"

    @property
    def rank(self) -> int:
        return _ORDER.index(self)

    # Convenience predicates for the delivery path.
    @property
    def pushes(self) -> bool:
        return self.rank >= DeliveryLevel.BRANCH.rank

    @property
    def opens_pr(self) -> bool:
        return self in (DeliveryLevel.DRAFT_PR, DeliveryLevel.PR, DeliveryLevel.AUTO_MERGE)

    @property
    def merges(self) -> bool:
        return self in (DeliveryLevel.AUTO_MERGE, DeliveryLevel.PUSH_TO_MAIN)


_ORDER: list[DeliveryLevel] = [
    DeliveryLevel.NONE,
    DeliveryLevel.BRANCH,
    DeliveryLevel.DRAFT_PR,
    DeliveryLevel.PR,
    DeliveryLevel.AUTO_MERGE,
    DeliveryLevel.PUSH_TO_MAIN,
]

# What an app with no ``delivery`` block gets: exactly today's behaviour.
LEGACY_DEFAULT = DeliveryLevel.AUTO_MERGE
# What ``factory app add`` writes for a newly registered repo.
NEW_APP_DEFAULT = DeliveryLevel.DRAFT_PR


def parse_level(value: Any) -> DeliveryLevel | None:
    """Parse a level; ``None`` for absent, ``ValueError`` for garbage."""
    if value is None or value == "":
        return None
    if isinstance(value, DeliveryLevel):
        return value
    try:
        return DeliveryLevel(str(value).strip().lower())
    except ValueError as exc:
        allowed = ", ".join(lvl.value for lvl in _ORDER)
        raise ValueError(f"unknown delivery level {value!r}; one of: {allowed}") from exc


class DeliveryConfig(BaseModel):
    """``delivery:`` block of ``apps/<app>/config.yaml``."""

    default: DeliveryLevel = LEGACY_DEFAULT

    @model_validator(mode="before")
    @classmethod
    def _reject_ceiling(cls, data: Any) -> Any:
        # A ``max`` key is a leftover from the ceiling design. Refuse it loudly
        # rather than silently ignore a limit the operator thinks is enforced.
        if isinstance(data, dict) and "max" in data:
            raise ValueError(
                "delivery.max is not supported: there is no per-app ceiling; "
                "set delivery.default and let each job choose its level"
            )
        return data


def effective_level(config: DeliveryConfig | None, requested: Any = None) -> DeliveryLevel:
    """The level a job actually runs at.

    ``requested`` is the raw frontmatter value (or ``None``). Garbage resolves
    to ``NONE`` rather than raising, so a typo in one direction can never make
    the factory do *more* than intended — and never crashes a tick either.
    """
    cfg = config or DeliveryConfig()
    try:
        req = parse_level(requested)
    except ValueError:
        return DeliveryLevel.NONE
    return req if req is not None else cfg.default
