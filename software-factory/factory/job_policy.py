"""Per-job policy: review mode and job caps (JOBS-API v1.9).

Two settings a job carries besides its pipeline, runtime and delivery level.
Each resolves job (direction frontmatter / ``job.yaml``) > app
(``apps/<app>/config.yaml``) > the defaults below, and is stamped on every
story at spawn (``StoryRecord.policy_json``), like the delivery level, so an
in-flight story never changes policy because a config was edited.

**Review** (``review: off | on | auto``, default ``auto``) decides whether a
``solo`` story gets the independent review before delivery, on either runtime
(``factory/chain/solo.py``; the ``chain`` pipeline always reviews, that is what
the chain is). ``auto`` reviews only when nothing human stands between the
change and the default branch: delivery ``auto_merge`` or ``push_to_main``.
An app may also set ``review.auto_min_diff_lines``: under ``auto``, a diff at
least that big (added + deleted lines vs the base) is reviewed whatever the
delivery level. The diff part is decided once, when the dev first goes green
(:func:`decide_review`), and recorded on the story.

**Caps** (``budget_usd``, ``wall_clock_h``, ``max_rounds``; defaults $30, 4 h,
20) bound one job on either runtime. Spend counts metered API cost plus what a
``claude_session`` run would have cost at API prices (its ``total_cost_usd``),
so one dollar figure means the same on both. Rounds are agent runs: dev
conversations, review runs and research/report runs. Wall clock runs from the
job's first agent run. A job that reaches a cap is parked for a human with its
work saved (:mod:`factory.job_caps`), never failed; ``factory job resume``
opens a fresh window (state.yaml ``caps_window_started_at``), so Continue means
"spend up to the cap again". ``0`` turns a cap off.

Failover (``failover: on | off``) is stamped here too; the policy that reads
it is ``factory/provider_limits.py``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

ReviewMode = Literal["off", "on", "auto"]
REVIEW_MODES: tuple[str, ...] = ("off", "on", "auto")
DEFAULT_REVIEW_MODE = "auto"

CAP_KEYS: tuple[str, ...] = ("budget_usd", "wall_clock_h", "max_rounds")
DEFAULT_CAPS: dict[str, float] = {"budget_usd": 30.0, "wall_clock_h": 4.0, "max_rounds": 20}

FAILOVER_VALUES: tuple[str, ...] = ("on", "off")

#: Delivery levels with no human between the change and the default branch.
UNATTENDED_LEVELS: frozenset[str] = frozenset({"auto_merge", "push_to_main"})

#: The ``runs.persona`` values that count as a round.
ROUND_PERSONAS: frozenset[str] = frozenset({"dev", "reviewer", "researcher"})


class ReviewConfig(BaseModel):
    """``review:`` in an app's config.yaml."""

    default: ReviewMode = "auto"
    #: Under ``auto``: review a diff of at least this many changed lines even
    #: below auto_merge. 0 = no size rule.
    auto_min_diff_lines: int = Field(default=0, ge=0)


class JobCapsConfig(BaseModel):
    """``caps:`` in an app's config.yaml. 0 = no cap."""

    budget_usd: float = Field(default=DEFAULT_CAPS["budget_usd"], ge=0)
    wall_clock_h: float = Field(default=DEFAULT_CAPS["wall_clock_h"], ge=0)
    max_rounds: int = Field(default=int(DEFAULT_CAPS["max_rounds"]), ge=0)

    @field_validator("budget_usd", "wall_clock_h", mode="before")
    @classmethod
    def _num(cls, v: Any) -> Any:
        return parse_cap_value("wall_clock_h", v) if isinstance(v, str) else v


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


def parse_review(value: Any) -> str | None:
    """``off|on|auto`` (case-insensitive); None for absent; ValueError otherwise."""
    if value is None or value == "":
        return None
    if value is True:
        return "on"
    if value is False:
        return "off"
    v = str(value).strip().lower()
    if v not in REVIEW_MODES:
        raise ValueError(f"review must be one of {', '.join(REVIEW_MODES)}, got {value!r}")
    return v


def parse_failover(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if value is True:
        return "on"
    if value is False:
        return "off"
    v = str(value).strip().lower()
    if v in ("1", "true", "yes"):
        return "on"
    if v in ("0", "false", "no"):
        return "off"
    if v not in FAILOVER_VALUES:
        raise ValueError(f"failover must be on or off, got {value!r}")
    return v


_DURATION = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?\s*$", re.I)


def parse_cap_value(key: str, raw: Any) -> float:
    """One cap value. ``wall_clock_h`` takes ``4``, ``4h`` or ``90m``; money takes
    ``30`` or ``$30``; rounds an integer. Negative or garbage → ValueError."""
    if key not in CAP_KEYS:
        raise ValueError(f"unknown cap {key!r}; one of: {', '.join(CAP_KEYS)}")
    text = str(raw).strip()
    if key == "wall_clock_h":
        m = _DURATION.match(text)
        if not m:
            raise ValueError(f"cap wall_clock_h must be hours (4, 4h) or minutes (90m), got {raw!r}")
        num = float(m.group(1))
        unit = (m.group(2) or "h").lower()
        val = num / 60.0 if unit.startswith("m") else num
    elif key == "budget_usd":
        try:
            val = float(text.lstrip("$"))
        except ValueError:
            raise ValueError(f"cap budget_usd must be dollars, got {raw!r}") from None
    else:
        try:
            val = float(int(text))
        except ValueError:
            raise ValueError(f"cap max_rounds must be a whole number, got {raw!r}") from None
    if val < 0:
        raise ValueError(f"cap {key} must be >= 0 (0 = no cap), got {raw!r}")
    return val


def parse_caps(assignments: list[str] | dict[str, Any] | None) -> dict[str, float]:
    """``["budget_usd=50", "wall_clock_h=6h"]`` (or a mapping) → ``{key: value}``.

    Short names are accepted: ``budget``, ``wall_clock``/``wall``, ``rounds``.
    """
    if not assignments:
        return {}
    pairs: list[tuple[str, Any]]
    if isinstance(assignments, dict):
        pairs = list(assignments.items())
    else:
        pairs = []
        for item in assignments:
            if "=" not in str(item):
                raise ValueError(f"--cap takes NAME=VALUE, got {item!r}")
            k, v = str(item).split("=", 1)
            pairs.append((k, v))
    out: dict[str, float] = {}
    for k, v in pairs:
        key = _CAP_ALIASES.get(str(k).strip().lower(), str(k).strip().lower())
        if key in out:
            raise ValueError(f"cap {key} given twice")
        out[key] = parse_cap_value(key, v)
    return out


_CAP_ALIASES = {
    "budget": "budget_usd",
    "usd": "budget_usd",
    "wall_clock": "wall_clock_h",
    "wall": "wall_clock_h",
    "hours": "wall_clock_h",
    "rounds": "max_rounds",
}


# --------------------------------------------------------------------------- #
# Resolution (job > app > default) and the spawn stamp
# --------------------------------------------------------------------------- #


def resolve_policy(app_cfg: Any | None, meta: dict[str, Any] | None) -> dict[str, Any]:
    """The policy a job runs under. Never raises: a malformed job value falls
    back to the app's (the submit refused it already; a hand-edited direction
    must not crash spawn)."""
    meta = meta if isinstance(meta, dict) else {}
    review_cfg = getattr(app_cfg, "review", None) or ReviewConfig()
    caps_cfg = getattr(app_cfg, "caps", None) or JobCapsConfig()

    try:
        job_mode = parse_review(meta.get("review"))
    except ValueError:
        job_mode = None
    if job_mode is not None:
        mode, src = job_mode, "job"
    elif app_cfg is not None and "review" in getattr(app_cfg, "model_fields_set", set()):
        mode, src = review_cfg.default, "app"
    else:
        mode, src = DEFAULT_REVIEW_MODE, "default"

    try:
        job_caps = parse_caps(meta.get("caps") if isinstance(meta.get("caps"), dict) else None)
    except ValueError:
        job_caps = {}
    app_set = (
        getattr(caps_cfg, "model_fields_set", set())
        if app_cfg is not None and "caps" in getattr(app_cfg, "model_fields_set", set())
        else set()
    )
    caps: dict[str, Any] = {}
    sources: dict[str, str] = {}
    for key in CAP_KEYS:
        if key in job_caps:
            caps[key], sources[key] = job_caps[key], "job"
        elif key in app_set:
            caps[key], sources[key] = float(getattr(caps_cfg, key)), "app"
        else:
            caps[key], sources[key] = float(DEFAULT_CAPS[key]), "default"
    caps["max_rounds"] = int(caps["max_rounds"])
    try:
        failover = parse_failover(meta.get("failover"))
    except ValueError:
        failover = None
    return {
        "review": {
            "mode": mode,
            "source": src,
            "min_diff_lines": int(getattr(review_cfg, "auto_min_diff_lines", 0) or 0),
        },
        "caps": {**caps, "source": sources},
        "failover": failover,
    }


def stamp_policy(story: Any, direction: Any, app_cfg: Any) -> dict[str, Any]:
    """Resolve the job's policy and stamp it on a NEW story (spawn)."""
    meta = getattr(direction, "raw_frontmatter", None)
    pol = resolve_policy(app_cfg, meta if isinstance(meta, dict) else None)
    story.policy_json = json.dumps(pol)
    return pol


def story_policy(story: Any) -> dict[str, Any] | None:
    """The stamped policy, or None for a story spawned before v1.9."""
    raw = getattr(story, "policy_json", None)
    if not raw:
        return None
    try:
        pol = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return pol if isinstance(pol, dict) else None


def _save(story: Any, pol: dict[str, Any]) -> None:
    story.policy_json = json.dumps(pol)


# --------------------------------------------------------------------------- #
# Review decision
# --------------------------------------------------------------------------- #


def static_review(story: Any) -> tuple[bool, str]:
    """Whether a solo story is reviewed, from its stamps alone (no diff).

    A story spawned before v1.9 keeps the old rule: the api runtime is
    reviewed, ``claude_session`` is not.
    """
    pol = story_policy(story)
    if pol is None:
        runtime = getattr(story, "runtime", None) or "api"
        if runtime == "claude_session":
            return False, "spawned before v1.9: claude_session solo had no review"
        return True, "spawned before v1.9: api solo is reviewed"
    mode = str((pol.get("review") or {}).get("mode") or DEFAULT_REVIEW_MODE)
    if mode == "on":
        return True, "review: on"
    if mode == "off":
        return False, "review: off"
    level = str(getattr(story, "delivery_level", None) or "")
    if level in UNATTENDED_LEVELS:
        return True, f"review: auto, and delivery {level} has no human gate"
    return False, f"review: auto, and delivery {level or 'unknown'} leaves a human gate"


def recorded_decision(story: Any) -> dict[str, Any] | None:
    pol = story_policy(story)
    dec = ((pol or {}).get("review") or {}).get("decision")
    return dec if isinstance(dec, dict) and "review" in dec else None


def review_wanted(story: Any) -> bool:
    """The recorded decision when there is one, else :func:`static_review`."""
    dec = recorded_decision(story)
    if dec is not None:
        return bool(dec["review"])
    return static_review(story)[0]


def decide_review(story: Any, diff_lines: int | None) -> dict[str, Any]:
    """Decide once (first green) and record it on the story; returns it.

    Only ``auto`` with an app ``auto_min_diff_lines`` looks at the diff. An
    unknown diff size (None) keeps the static answer. A legacy story (no
    stamp) records nothing.
    """
    existing = recorded_decision(story)
    if existing is not None:
        return existing
    want, why = static_review(story)
    pol = story_policy(story)
    if pol is None:
        return {"review": want, "reason": why}
    review = dict(pol.get("review") or {})
    threshold = int(review.get("min_diff_lines") or 0)
    if (
        not want
        and review.get("mode", DEFAULT_REVIEW_MODE) == "auto"
        and threshold > 0
        and diff_lines is not None
        and diff_lines >= threshold
    ):
        want = True
        why = f"review: auto, and the diff ({diff_lines} lines) is at least {threshold}"
    dec = {"review": want, "reason": why, "diff_lines": diff_lines}
    review["decision"] = dec
    pol["review"] = review
    _save(story, pol)
    return dec


def story_caps(story: Any) -> dict[str, Any] | None:
    pol = story_policy(story)
    caps = (pol or {}).get("caps")
    return caps if isinstance(caps, dict) else None


def story_failover(story: Any) -> str | None:
    pol = story_policy(story)
    v = (pol or {}).get("failover")
    return v if v in FAILOVER_VALUES else None


def policy_view(pol: dict[str, Any] | None) -> dict[str, Any] | None:
    """The status object's ``policy`` (JOBS-API v1.9)."""
    if not pol:
        return None
    review = pol.get("review") or {}
    caps = dict(pol.get("caps") or {})
    return {
        "review": {
            "mode": review.get("mode"),
            "source": review.get("source"),
            "decision": review.get("decision"),
        },
        "caps": {k: caps.get(k) for k in CAP_KEYS} | {"source": caps.get("source") or {}},
        "failover": pol.get("failover"),
    }


__all__ = [
    "CAP_KEYS",
    "DEFAULT_CAPS",
    "DEFAULT_REVIEW_MODE",
    "JobCapsConfig",
    "REVIEW_MODES",
    "ROUND_PERSONAS",
    "ReviewConfig",
    "decide_review",
    "parse_cap_value",
    "parse_caps",
    "parse_failover",
    "parse_review",
    "policy_view",
    "recorded_decision",
    "resolve_policy",
    "review_wanted",
    "stamp_policy",
    "static_review",
    "story_caps",
    "story_failover",
    "story_policy",
]
