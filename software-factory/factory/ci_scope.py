"""Which of a PR's CI checks the factory's CI watch counts.

A repo can run checks that never decide anything: a ``continue-on-error``
matrix leg kept for information, or a slow optional job. Counting them makes
the watch wait on a job nobody gates on (dev-tools' informational Windows leg
runs up to 60 min) and send its red back to dev as a defect.

The scope comes from, in order:

1. GitHub's required status checks for the base branch: classic branch
   protection (``GET repos/{repo}/branches/{base}``, readable with plain read
   access) plus repository rulesets (``GET repos/{repo}/rules/branches/{base}``).
   When any are set, ONLY those checks count.
2. ``ci_required_checks`` in the app config: the same, for a repo without
   protection.
3. Otherwise every check counts EXCEPT the informational ones: names matching
   ``ci_informational_checks`` (app config, ``fnmatch`` patterns) and jobs the
   repo's workflows mark ``continue-on-error`` (a literal ``true``, or a simple
   ``${{ matrix.<k> == / != '<v>' }}`` evaluated per matrix leg).

A required check that has not reported yet reads as pending while any other
check is still running (CI is in flight), and is then ignored: a path filter
may skip it for good. Every read is best-effort: a ``gh`` failure falls
through to the next source, never blocks the watch. ``use_cache`` keeps a
resolved scope per (repo, base) for ``CACHE_TTL_S`` (the chain's CI watch,
which asks once per watched PR per tick).
"""

from __future__ import annotations

import fnmatch
import json
import re
import subprocess
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CACHE_TTL_S = 600.0

#: The software-factory directory (``factory/`` lives in it): the root
#: ``app_repo_path`` is relative to.
_FACTORY_ROOT = Path(__file__).resolve().parents[1]

SOURCE_PROTECTION = "branch_protection"
SOURCE_CONFIG = "app_config"
SOURCE_INFORMATIONAL = "informational"


@dataclass(frozen=True)
class CiScope:
    """``required`` set → only those count; else everything but ``informational``."""

    required: frozenset[str] | None = None
    informational: tuple[str, ...] = ()
    source: str = SOURCE_INFORMATIONAL
    notes: tuple[str, ...] = field(default=(), compare=False)

    def counts(self, name: str) -> bool:
        if self.required is not None:
            return name in self.required
        low = name.lower()
        return not any(fnmatch.fnmatchcase(low, p.lower()) for p in self.informational)

    def apply(self, rows: Iterable[Any]) -> tuple[list[Any], list[str]]:
        """``(rows that count, names ignored)`` for ``statusCheckRollup`` rows."""
        kept: list[Any] = []
        ignored: set[str] = set()
        reported: set[str] = set()
        running = False
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = _row_name(row)
            if _row_pending(row):
                running = True
            if self.counts(name):
                kept.append(row)
                reported.add(name)
            else:
                ignored.add(name)
        if self.required is not None and running:
            # CI still in flight: a required check that has not reported yet
            # is waited for, not silently dropped.
            for name in sorted(self.required - reported):
                kept.append({"__typename": "CheckRun", "name": name, "status": "QUEUED"})
        return kept, sorted(ignored)


def _row_name(row: dict[str, Any]) -> str:
    return str(row.get("name") or row.get("context") or "?")


def _row_pending(row: dict[str, Any]) -> bool:
    if row.get("__typename") == "StatusContext" or ("state" in row and "status" not in row):
        return str(row.get("state") or "").upper() in ("PENDING", "EXPECTED", "")
    return str(row.get("status") or "").upper() != "COMPLETED"


# --------------------------------------------------------------------------- #
# Source 1: GitHub required status checks
# --------------------------------------------------------------------------- #

GhJson = Callable[[str], Any]


def _default_gh_json(path: str) -> Any:
    """``gh api <path>`` parsed, or ``None`` on any failure."""
    try:
        proc = subprocess.run(
            ["gh", "api", path], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout or "null")
    except ValueError:
        return None


def github_required_checks(repo: str, base: str, gh_json: GhJson | None = None) -> set[str]:
    """Required check names on ``base`` (protection + rulesets); empty if none/unknown."""
    get = gh_json or _default_gh_json
    names: set[str] = set()
    branch = get(f"repos/{repo}/branches/{base}")
    if isinstance(branch, dict) and branch.get("protected"):
        rsc = (branch.get("protection") or {}).get("required_status_checks") or {}
        if isinstance(rsc, dict):
            names.update(str(c) for c in (rsc.get("contexts") or []) if c)
            names.update(
                str(c.get("context"))
                for c in (rsc.get("checks") or [])
                if isinstance(c, dict) and c.get("context")
            )
    rules = get(f"repos/{repo}/rules/branches/{base}")
    if isinstance(rules, list):
        for rule in rules:
            if not isinstance(rule, dict) or rule.get("type") != "required_status_checks":
                continue
            params = rule.get("parameters") or {}
            for c in params.get("required_status_checks") or []:
                if isinstance(c, dict) and c.get("context"):
                    names.add(str(c["context"]))
    return {n.strip() for n in names if n.strip()}


# --------------------------------------------------------------------------- #
# Source 3: continue-on-error jobs in the repo's workflows
# --------------------------------------------------------------------------- #

_EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")
_MATRIX_REF = re.compile(r"^matrix\.([A-Za-z0-9_-]+)$")
_MATRIX_CMP = re.compile(r"^matrix\.([A-Za-z0-9_-]+)\s*(==|!=)\s*'([^']*)'$")


def _legs(job: dict[str, Any]) -> list[dict[str, Any]]:
    """The matrix legs of a job (``[{}]`` when it has no simple matrix)."""
    strategy = job.get("strategy")
    matrix = strategy.get("matrix") if isinstance(strategy, dict) else None
    if not isinstance(matrix, dict):
        return [{}]
    legs: list[dict[str, Any]] = [{}]
    for key, values in matrix.items():
        if key in ("include", "exclude") or not isinstance(values, list):
            continue
        legs = [{**leg, key: v} for leg in legs for v in values]
    return legs


def _render_name(job_id: str, job: dict[str, Any], leg: dict[str, Any]) -> str:
    """The check name GitHub shows for one leg; unresolved parts become ``*``."""
    raw = job.get("name")
    if not raw:
        if not leg:
            return job_id
        return f"{job_id} ({', '.join(str(v) for v in leg.values())})"

    def _sub(m: re.Match[str]) -> str:
        ref = _MATRIX_REF.match(m.group(1))
        if ref and ref.group(1) in leg:
            return str(leg[ref.group(1)])
        return "*"

    return _EXPR.sub(_sub, str(raw))


def _continues_on_error(value: Any, leg: dict[str, Any]) -> bool:
    if value is True:
        return True
    if not isinstance(value, str):
        return False
    text = value.strip()
    if text.lower() == "true":
        return True
    m = _EXPR.fullmatch(text)
    if not m:
        return False
    cmp = _MATRIX_CMP.match(m.group(1))
    if not cmp or cmp.group(1) not in leg:
        return False  # an expression we cannot evaluate: not informational
    equal = str(leg[cmp.group(1)]) == cmp.group(3)
    return equal if cmp.group(2) == "==" else not equal


def informational_jobs(repo_root: Path) -> list[str]:
    """Check-name patterns of ``continue-on-error`` jobs under ``.github/workflows``."""
    wf_dir = Path(repo_root) / ".github" / "workflows"
    out: list[str] = []
    try:
        files = sorted([*wf_dir.glob("*.yml"), *wf_dir.glob("*.yaml")])
    except OSError:
        return out
    for path in files:
        try:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError, UnicodeDecodeError):
            continue
        jobs = doc.get("jobs") if isinstance(doc, dict) else None
        if not isinstance(jobs, dict):
            continue
        for job_id, job in jobs.items():
            if not isinstance(job, dict) or "continue-on-error" not in job:
                continue
            for leg in _legs(job):
                if _continues_on_error(job["continue-on-error"], leg):
                    name = _render_name(str(job_id), job, leg)
                    if name not in out:
                        out.append(name)
    return out


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #

_cache: dict[tuple[str, str], tuple[float, CiScope]] = {}


def resolve_ci_scope(
    app_config: Any,
    *,
    base: str | None = None,
    repo_root: Path | None = None,
    gh_json: GhJson | None = None,
    use_cache: bool = False,
    now: Callable[[], float] = time.monotonic,
) -> CiScope:
    """The :class:`CiScope` for ``app_config``'s repo. Never raises."""
    repo = str(getattr(app_config, "repo", "") or "")
    branch = base or str(getattr(app_config, "default_branch", "") or "main")
    key = (repo, branch)
    if use_cache and key in _cache and now() - _cache[key][0] < CACHE_TTL_S:
        return _cache[key][1]
    scope = _resolve(app_config, repo, branch, repo_root, gh_json)
    if use_cache:
        _cache[key] = (now(), scope)
    return scope


def _resolve(
    app_config: Any, repo: str, branch: str, repo_root: Path | None, gh_json: GhJson | None
) -> CiScope:
    notes: list[str] = []
    if repo:
        try:
            required = github_required_checks(repo, branch, gh_json)
        except Exception as exc:  # noqa: BLE001 - best effort: fall through
            required = set()
            notes.append(f"required checks unreadable: {exc!r}"[:200])
        if required:
            return CiScope(frozenset(required), (), SOURCE_PROTECTION, tuple(notes))
    configured = [str(n).strip() for n in getattr(app_config, "ci_required_checks", []) or []]
    configured = [n for n in configured if n]
    if configured:
        return CiScope(frozenset(configured), (), SOURCE_CONFIG, tuple(notes))
    patterns = [str(p) for p in getattr(app_config, "ci_informational_checks", []) or [] if p]
    root = repo_root
    if root is None:
        try:
            from factory.app_config import resolve_app_repo_path

            root = resolve_app_repo_path(app_config, _FACTORY_ROOT)
        except Exception:  # noqa: BLE001
            root = None
    if root is not None:
        try:
            for name in informational_jobs(root):
                if name not in patterns:
                    patterns.append(name)
        except Exception as exc:  # noqa: BLE001
            notes.append(f"workflows unreadable: {exc!r}"[:200])
    return CiScope(None, tuple(patterns), SOURCE_INFORMATIONAL, tuple(notes))


def clear_cache() -> None:
    _cache.clear()
