"""Generic post-merge deploy orchestrator.

Phase 5: the factory invokes the app's configured deploy commands in a
fixed sequence — pre_deploy → deploy → health_check → smoke_test — and
runs ``rollback_command`` on any failure. NOTHING in this package knows
about Docker / Compose / Fly / Vercel / Kubernetes / Heroku; every
command is an opaque shell string from ``apps/<app>/config.yaml``.
"""

from factory.deploy.models import DeployActionRecord, DeployQueueEntry
from factory.deploy.orchestrator import (
    DeployAction,
    StepResult,
    deploy_action_as_dict,
    deploy_post_merge,
    deploy_tick,
    drain_deploy_queue,
    enqueue_deploy,
)
from factory.deploy.runner import (
    CommandResult,
    is_destructive,
    run_command,
    run_command_sequence,
)

__all__ = [
    "CommandResult",
    "DeployAction",
    "DeployActionRecord",
    "DeployQueueEntry",
    "StepResult",
    "deploy_action_as_dict",
    "deploy_post_merge",
    "deploy_tick",
    "drain_deploy_queue",
    "enqueue_deploy",
    "is_destructive",
    "run_command",
    "run_command_sequence",
]
