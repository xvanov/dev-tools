"""SQLModel rows persisted by the deploy orchestrator.

One row per ``deploy_tick`` candidate. Carries the status (deployed |
rolled_back | skipped | errored), the timing buckets, and per-phase
booleans so ``factory deploys`` can reconstruct the run without
re-shelling. Per-command stdout/stderr is captured in
``per_phase_results_json`` for audit.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel


class DeployActionRecord(SQLModel, table=True):
    """One row per deploy decision (deployed, rolled_back, skipped, errored)."""

    __tablename__ = "deploy_actions"

    id: int | None = Field(default=None, primary_key=True)
    ts: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    app: str = Field(index=True)
    sha: str = Field(index=True)
    status: str  # "deployed" | "rolled_back" | "skipped" | "errored"
    pre_deploy_duration_s: float = 0.0
    deploy_duration_s: float = 0.0
    health_check_passed: bool = False
    smoke_passed: bool = False
    rollback_triggered: bool = False
    rollback_passed: bool = False
    error: str | None = None
    # JSON-encoded list of {phase, command, exit_code, duration_seconds,
    # stdout_excerpt, stderr_excerpt} for audit / CLI display.
    per_phase_results_json: str = "[]"
    skipped_reason: str | None = None


class DeployQueueEntry(SQLModel, table=True):
    """Queue row populated post-merge; drained by ``drain_deploy_queue``."""

    __tablename__ = "deploy_queue"

    id: int | None = Field(default=None, primary_key=True)
    app: str = Field(index=True)
    sha: str
    merged_pr_number: int | None = None
    queued_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    processed_at: str | None = None
    result_status: str | None = None  # mirrors DeployActionRecord.status
