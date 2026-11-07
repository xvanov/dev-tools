"""Shared pieces of ``factory job``: errors, job ids, job-direction discovery."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import frontmatter
import yaml

from factory.directions.parser import _ID_PREFIX_RE, list_direction_dirs

#: Separator between app and direction id in a job id (``sacrifice:021``).
JOB_ID_SEP = ":"


class JobError(Exception):
    """A user-facing failure with a stable machine-readable ``code``.

    The CLI renders it as ``{"error": code, "message": message}`` and exits
    non-zero (docs/JOBS-API.md).
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def as_json(self) -> dict[str, str]:
        return {"error": self.code, "message": self.message}


def state_db_path(root: Path) -> Path:
    return Path(root) / "state" / "factory.db"


def format_job_id(app: str, direction_id: str) -> str:
    return f"{app}{JOB_ID_SEP}{direction_id}"


def parse_job_id(job_id: str) -> tuple[str, str]:
    """``"sacrifice:021"`` → ``("sacrifice", "021")``. Raises ``JobError``."""
    app, sep, direction_id = (job_id or "").strip().partition(JOB_ID_SEP)
    if not sep or not app or not direction_id:
        raise JobError(
            "invalid_job_id", f"job id must look like '<app>:<direction_id>', got {job_id!r}"
        )
    return app, direction_id


def registered_apps(root: Path) -> list[str]:
    apps_dir = Path(root) / "apps"
    if not apps_dir.is_dir():
        return []
    return sorted(p.name for p in apps_dir.iterdir() if (p / "config.yaml").is_file())


def read_frontmatter(dir_path: Path) -> dict[str, Any]:
    """The ``direction.md`` frontmatter, or ``{}`` if unreadable."""
    try:
        post = frontmatter.load(str(Path(dir_path) / "direction.md"))
    except Exception:  # noqa: BLE001 - a corrupt sibling must not break listing
        return {}
    return dict(post.metadata or {})


def read_state_yaml(dir_path: Path) -> dict[str, Any]:
    path = Path(dir_path) / "state.yaml"
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


@dataclass
class JobRef:
    """Where a job lives on disk, plus its frontmatter."""

    app: str
    direction_id: str
    dir_path: Path
    meta: dict[str, Any]

    @property
    def job_id(self) -> str:
        return format_job_id(self.app, self.direction_id)


def is_job_meta(meta: dict[str, Any]) -> bool:
    """A direction is a JOB when ``factory job submit`` wrote it.

    The marker is a ``source`` key in the ``direction.md`` frontmatter: the
    classic creators record ``source`` only in ``state.yaml``.
    """
    return bool(str(meta.get("source") or "").strip())


def iter_jobs(root: Path, *, app: str | None = None) -> list[JobRef]:
    """Every job direction under ``apps/*/directions``, oldest id first per app."""
    out: list[JobRef] = []
    for app_name in [app] if app else registered_apps(root):
        for dir_path in list_direction_dirs(app_name, Path(root)):
            meta = read_frontmatter(dir_path)
            if not is_job_meta(meta):
                continue
            m = _ID_PREFIX_RE.match(dir_path.name)
            if not m:
                continue
            out.append(JobRef(app_name, m.group(1), dir_path, meta))
    return out


def find_job(root: Path, job_id: str) -> JobRef:
    """Resolve a job id to its directory. Raises ``JobError('not_found')``."""
    app, direction_id = parse_job_id(job_id)
    if app not in registered_apps(root):
        raise JobError("not_found", f"no registered app {app!r} (job {job_id!r})")
    for dir_path in list_direction_dirs(app, Path(root)):
        m = _ID_PREFIX_RE.match(dir_path.name)
        if m and m.group(1) == direction_id:
            meta = read_frontmatter(dir_path)
            if not is_job_meta(meta):
                raise JobError(
                    "not_found",
                    f"direction {dir_path.name} exists but was not created by "
                    "'factory job submit' (no frontmatter source)",
                )
            return JobRef(app, direction_id, dir_path, meta)
    raise JobError("not_found", f"no job {job_id!r}")
