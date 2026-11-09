"""Provider limits are transient: pause, trip a per-runtime breaker, resume at reset.

JOBS-API v1.9. Two runtimes, two kinds of wall:

* ``claude_session``: the subscription's 5-hour / weekly window. Claude Code
  ends the run at once with a message such as ``You've hit your limit · resets
  3pm (Europe/Sofia)``, ``5-hour limit reached ∙ resets 3pm``, ``Claude usage
  limit reached. Your limit will reset at 3pm (America/New_York).`` or the
  older ``Claude AI usage limit reached|1760000400`` (an epoch).
* ``api``: an HTTP 429 (``RateLimitError``), with ``Retry-After`` /
  ``x-ratelimit-reset-*`` / ``anthropic-ratelimit-*-reset`` headers when the
  provider sends them, or a "try again in 20s" in the message.

Either way it is not the job's fault and not a dev attempt. So:

1. :func:`parse_limit` reads the reset time when the text (or headers) has
   one; otherwise exponential backoff with a cap (:func:`backoff_s`).
2. :func:`trip` opens the runtime's breaker until then
   (``<state>/runtime_limits.json``). While it is open no step starts on that
   runtime: the orchestrator defers the story (no state change, no retry
   spent, its worktree kept) and ``dispatch_tasks`` leaves a research/report/
   plan job queued. Status reads ``blocked`` with
   ``paused: Claude limit, resumes 15:00``.
3. Nothing resumes a paused job: once the breaker's time passes the next tick
   dispatches the step again (auto-resume at reset).

**Failover** to the other runtime is OFF by default. ``FACTORY_RUNTIME_FAILOVER=on``
turns it on globally; a job's ``failover: on|off`` (``job submit --failover``)
wins. It only happens when the wait is longer than
``FACTORY_FAILOVER_MIN_WAIT_MIN`` (default 30) and the other runtime is not
itself limited, and it is always recorded (``runtime_failover`` event, status
``failover``) so the personal assistant notifies. The PA's own credit-pool
fallback (``PA_CLAUDE_POOL_FALLBACK_API``) is the same policy applied before
submit, with the pool's reset as the wait (personal-assistant
``src/dispatch/failover.ts``).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, tzinfo
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

RUNTIMES: tuple[str, ...] = ("api", "claude_session")
LABEL = {"claude_session": "Claude", "api": "API"}

#: Backoff when no reset time is known: base * 2**(trips-1), capped.
BACKOFF = {
    "claude_session": (15 * 60, 5 * 3600),
    "api": (60, 30 * 60),
}
#: A trip within this long of the previous one's end continues its backoff.
BACKOFF_MEMORY_S = 3600

DEFAULT_FAILOVER_MIN_WAIT_MIN = 30.0


@dataclass
class LimitHit:
    runtime: str
    until: datetime | None  # aware; None = unknown (backoff decides)
    reason: str
    text: str

    def describe(self, now: datetime | None = None) -> str:
        return describe(self.runtime, self.until, now=now)


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #

# Matched only against a provider's own error (never a test log or a gate
# reason: a red suite about rate limiting must not pause a job), and still kept
# to the words providers use.
_CLAUDE_LIMIT = re.compile(
    r"(usage limit|hit your [\w-]*\s*limit|limit reached|limit will reset|"
    r"rate limit|\b429\b|overloaded_error|\boverloaded\b|too many requests)",
    re.I,
)
_API_LIMIT = re.compile(
    r"(RateLimitError|rate limit|\b429\b|too many requests|quota exceeded|"
    r"exceeded (?:your |the )?(?:rate|quota|token))",
    re.I,
)
#: An api run's error is the provider's when it names the provider exception.
_API_PROVIDER_ERROR = re.compile(r"(RateLimitError|\b429\b|Too Many Requests)", re.I)
_EPOCH = re.compile(r"limit reached\|(\d{9,11})")
_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    )
}
_RESET = re.compile(
    r"resets?(?:\s+at)?\s+"
    r"(?:(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?"
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>[ap]\.?m\.?)?"
    r"(?:\s*\((?P<tz>[A-Za-z_]+(?:/[A-Za-z_+-]+)*|UTC|GMT)\))?",
    re.I,
)
_RETRY_TEXT = re.compile(
    r"(?:retry|try again)(?:[- ]after)?\s*(?:in\s*)?:?\s*"
    r"(?P<n>\d+(?:\.\d+)?)\s*(?P<u>ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)?\b",
    re.I,
)
_GO_DURATION = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")


def _zone(name: str | None, fallback: tzinfo) -> tzinfo:
    if not name:
        return fallback
    if name.upper() in ("UTC", "GMT"):
        return UTC
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - no tzdata (Windows) or unknown zone: local time
        return fallback


def _local_tz(now: datetime) -> tzinfo:
    return now.astimezone().tzinfo or UTC


def parse_reset(text: str, now: datetime) -> datetime | None:
    """The reset moment a Claude limit message names, or None."""
    m = _EPOCH.search(text or "")
    if m:
        try:
            return datetime.fromtimestamp(int(m.group(1)), tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    m = _RESET.search(text or "")
    if not m:
        return None
    hour = int(m.group("h"))
    minute = int(m.group("m") or 0)
    ap = (m.group("ap") or "").replace(".", "").lower()
    if ap == "pm" and hour < 12:
        hour += 12
    elif ap == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    tz = _zone(m.group("tz"), _local_tz(now))
    here = now.astimezone(tz)
    mon = (m.group("mon") or "").lower()[:3]
    if mon:
        month = _MONTHS.get(mon)
        if month is None:
            return None
        try:
            at = here.replace(month=month, day=int(m.group("day")), hour=hour, minute=minute,
                              second=0, microsecond=0)
        except ValueError:
            return None
        if at < here - timedelta(days=1):
            at = at.replace(year=at.year + 1)
        return at
    at = here.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if at <= here:
        at += timedelta(days=1)
    return at


def _seconds(n: str, unit: str | None) -> float:
    v = float(n)
    u = (unit or "s").lower()
    if u.startswith("ms") or u.startswith("milli"):
        return v / 1000.0
    if u.startswith("h"):
        return v * 3600
    if u.startswith("m"):
        return v * 60
    return v


def _go_duration(text: str) -> float | None:
    """``1m30s`` / ``6ms`` / ``2.5s`` (OpenAI's x-ratelimit-reset-*)."""
    parts = _GO_DURATION.findall(text.strip())
    if not parts or "".join(a + b for a, b in parts) != text.strip():
        return None
    return sum(_seconds(a, b) for a, b in parts)


def retry_after_s(headers: dict[str, Any] | None, now: datetime) -> float | None:
    """Seconds to wait from rate-limit response headers, or None."""
    if not headers:
        return None
    h = {str(k).lower(): str(v).strip() for k, v in headers.items() if v is not None}
    waits: list[float] = []
    if "retry-after-ms" in h:
        try:
            waits.append(float(h["retry-after-ms"]) / 1000.0)
        except ValueError:
            pass
    if "retry-after" in h:
        v = h["retry-after"]
        try:
            waits.append(float(v))
        except ValueError:
            try:
                waits.append((parsedate_to_datetime(v) - now).total_seconds())
            except (TypeError, ValueError):
                pass
    for k, v in h.items():
        if k.startswith("x-ratelimit-reset"):
            d = _go_duration(v)
            if d is None:
                try:
                    d = float(v)
                except ValueError:
                    d = None
            if d is not None:
                waits.append(d)
        elif k.startswith("anthropic-ratelimit-") and k.endswith("-reset"):
            try:
                at = datetime.fromisoformat(v.replace("Z", "+00:00"))
                waits.append((at - now).total_seconds())
            except ValueError:
                pass
    waits = [w for w in waits if w >= 0]
    return max(waits) if waits else None


def parse_limit(
    runtime: str,
    text: str | None,
    *,
    headers: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> LimitHit | None:
    """A provider limit in a run's error text / response headers, or None."""
    now = now or datetime.now(UTC)
    blob = str(text or "")
    if runtime == "claude_session":
        if not _CLAUDE_LIMIT.search(blob):
            return None
        until = parse_reset(blob, now)
        if until is None:
            wait = retry_after_s(headers, now)
            until = now + timedelta(seconds=wait) if wait is not None else None
        reason = "Claude usage limit" if re.search(r"limit", blob, re.I) else "Claude overloaded"
        return LimitHit(runtime, until, reason, blob[:500])
    if not _API_LIMIT.search(blob) and retry_after_s(headers, now) is None:
        return None
    wait = retry_after_s(headers, now)
    if wait is None:
        m = _RETRY_TEXT.search(blob)
        wait = _seconds(m.group("n"), m.group("u")) if m else None
    until = now + timedelta(seconds=wait) if wait is not None else None
    return LimitHit(runtime, until, "API rate limit (429)", blob[:500])


# --------------------------------------------------------------------------- #
# The per-runtime breaker
# --------------------------------------------------------------------------- #


def _path(root: Path) -> Path:
    from factory.state_dir import state_dir

    return state_dir(Path(root)) / "runtime_limits.json"


def load(root: Path) -> dict[str, Any]:
    try:
        data = json.loads(_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(root: Path, data: dict[str, Any]) -> None:
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, p)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def _parse_iso(v: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(v))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def backoff_s(runtime: str, trips: int) -> float:
    base, cap = BACKOFF.get(runtime, BACKOFF["api"])
    return float(min(cap, base * (2 ** max(0, trips - 1))))


def trip(
    root: Path, hit: LimitHit, *, source: str | None = None, now: datetime | None = None
) -> dict[str, Any]:
    """Open ``hit.runtime``'s breaker until its reset (or a backoff). Returns the entry.

    A later reset already recorded is kept (two runs hitting the same wall
    must not shorten it)."""
    now = now or datetime.now(UTC)
    data = load(root)
    prev = data.get(hit.runtime) if isinstance(data.get(hit.runtime), dict) else {}
    prev_until = _parse_iso(prev.get("until")) if prev else None
    trips = 1
    if prev_until is not None and (now - prev_until).total_seconds() < BACKOFF_MEMORY_S:
        trips = int(prev.get("trips") or 0) + 1
    until = hit.until or now + timedelta(seconds=backoff_s(hit.runtime, trips))
    if prev_until is not None and prev_until > until:
        until = prev_until
    entry = {
        "until": _iso(until),
        "reason": hit.reason,
        "text": hit.text[:300],
        "reset_known": hit.until is not None,
        "tripped_at": _iso(now),
        "trips": trips,
        "source": source,
    }
    data[hit.runtime] = entry
    _write(root, data)
    return entry


_ANY_CACHE: dict[str, tuple[float, bool]] = {}


def any_open(root: Path, now: datetime | None = None) -> bool:
    """Whether any breaker is open (one file read, cached on its mtime)."""
    p = _path(root)
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return False
    key = str(p)
    hit = _ANY_CACHE.get(key)
    if hit is not None and hit[0] == mtime and not hit[1]:
        return False
    result = any(open_entry(root, rt, now) is not None for rt in RUNTIMES)
    _ANY_CACHE[key] = (mtime, result)
    return result


def open_entry(root: Path, runtime: str, now: datetime | None = None) -> dict[str, Any] | None:
    """The runtime's breaker entry while it is open, else None (closed or expired)."""
    now = now or datetime.now(UTC)
    entry = load(root).get(runtime)
    if not isinstance(entry, dict):
        return None
    until = _parse_iso(entry.get("until"))
    if until is None or until <= now:
        return None
    return {**entry, "runtime": runtime}


def describe(runtime: str, until: datetime | None, now: datetime | None = None) -> str:
    """``paused: Claude limit, resumes 15:00`` (local time; weekday when not today)."""
    label = LABEL.get(runtime, runtime)
    if until is None:
        return f"paused: {label} limit"
    now = now or datetime.now(UTC)
    local = until.astimezone()
    when = local.strftime("%H:%M")
    if local.date() != now.astimezone().date():
        when = local.strftime("%a %H:%M")
    return f"paused: {label} limit, resumes {when}"


def describe_entry(entry: dict[str, Any], now: datetime | None = None) -> str:
    return describe(str(entry.get("runtime")), _parse_iso(entry.get("until")), now=now)


def pause_view(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    """The status object's ``paused`` (JOBS-API v1.9)."""
    if not entry:
        return None
    return {
        "runtime": entry.get("runtime"),
        "until": entry.get("until"),
        "reason": entry.get("reason"),
        "reset_known": bool(entry.get("reset_known")),
        "why": describe_entry(entry),
    }


def provider_error_text(runtime: str, run_res: Any) -> str | None:
    """The provider's own error of a finished agent run, or None.

    ``claude_session``: Claude Code's error result (``provider_error``), which
    survives the grade that may replace ``error``. ``api``: the run's error
    only when it names the provider's rate-limit exception."""
    if runtime == "claude_session":
        return getattr(run_res, "provider_error", None) or None
    err = str(getattr(run_res, "error", None) or "")
    return err if err and _API_PROVIDER_ERROR.search(err) else None


def note_run_error(
    root: Path,
    runtime: str,
    text: str | None,
    *,
    headers: dict[str, Any] | None = None,
    story: Any = None,
    source: str | None = None,
) -> LimitHit | None:
    """Parse a run's error; on a provider limit trip the breaker (and log it on
    the story). Never raises: a broken breaker must not break the step."""
    try:
        hit = parse_limit(runtime, text, headers=headers)
    except Exception:  # noqa: BLE001
        return None
    if hit is None:
        return None
    sid = getattr(story, "id", None)
    try:
        entry = trip(root, hit, source=source or (f"story {sid}" if sid is not None else None))
        hit.until = _parse_iso(entry.get("until"))
    except Exception:  # noqa: BLE001
        pass
    if sid is not None:
        try:
            from factory.chain.event_log import log_story_event

            log_story_event(
                sid,
                "provider_limit",
                {
                    "runtime": runtime,
                    "until": _iso(hit.until) if hit.until else None,
                    "reason": hit.reason,
                    "text": hit.text[:300],
                },
                software_factory_root=root,
                slug_hint=getattr(story, "slug", None),
            )
        except Exception:  # noqa: BLE001
            pass
    return hit


# --------------------------------------------------------------------------- #
# Failover policy
# --------------------------------------------------------------------------- #


def other_runtime(runtime: str) -> str:
    return "api" if runtime == "claude_session" else "claude_session"


def failover_enabled(job_value: str | None) -> bool:
    """A job's ``failover`` wins; else ``FACTORY_RUNTIME_FAILOVER`` (default off)."""
    if job_value in ("on", "off"):
        return job_value == "on"
    return os.environ.get("FACTORY_RUNTIME_FAILOVER", "off").strip().lower() in (
        "1", "on", "true", "yes",
    )


def min_wait_s() -> float:
    try:
        return 60.0 * float(
            os.environ.get("FACTORY_FAILOVER_MIN_WAIT_MIN") or DEFAULT_FAILOVER_MIN_WAIT_MIN
        )
    except ValueError:
        return 60.0 * DEFAULT_FAILOVER_MIN_WAIT_MIN


def _runtime_available(runtime: str) -> bool:
    if runtime == "claude_session":
        try:
            from factory.claude_session.cli import claude_binary

            return claude_binary() is not None
        except Exception:  # noqa: BLE001
            return False
    return True


def decide_failover(
    root: Path,
    runtime: str,
    entry: dict[str, Any],
    job_value: str | None,
    *,
    now: datetime | None = None,
    available: Any = None,
) -> tuple[bool, str, str]:
    """``(fail_over, target_runtime, why)`` for a step blocked by ``entry``.

    Pure but for the other runtime's breaker and availability. The order of
    the checks is the order of the ``why``s a caller can show."""
    now = now or datetime.now(UTC)
    target = other_runtime(runtime)
    if not failover_enabled(job_value):
        return False, target, "failover is off"
    until = _parse_iso(entry.get("until"))
    wait = (until - now).total_seconds() if until else float("inf")
    if wait <= min_wait_s():
        return False, target, f"the wait ({int(wait // 60)} min) is under the failover threshold"
    if open_entry(root, target, now) is not None:
        return False, target, f"{target} is limited too"
    if not (available or _runtime_available)(target):
        return False, target, f"{target} is not available here"
    return (
        True,
        target,
        f"failed over from {runtime} to {target}: {describe_entry({**entry, 'runtime': runtime}, now)}",
    )


__all__ = [
    "LimitHit",
    "any_open",
    "backoff_s",
    "decide_failover",
    "describe",
    "describe_entry",
    "failover_enabled",
    "load",
    "min_wait_s",
    "note_run_error",
    "open_entry",
    "other_runtime",
    "parse_limit",
    "parse_reset",
    "provider_error_text",
    "pause_view",
    "retry_after_s",
    "trip",
]
