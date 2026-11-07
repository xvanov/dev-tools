"""factory.runtime_state — machine-writable per-app runtime overrides.

Separates OPERATOR-authored config from MACHINE-mutated runtime state so a
single fact never lives in two files that can drift apart.

Problem this closes
-------------------
``apps/<app>/config.yaml`` is operator-authored and version-controlled, but a
few facts in it — most importantly ``deploy.enabled`` — were ALSO machine-
mutated: recovery playbook 3 (``revert-premature-deploy-enable``) rewrote
``deploy.enabled: true -> false`` directly in ``config.yaml``. So a machine
flip and an operator edit fought over the same bytes: a settings deploy of
``config.yaml`` (or a hand edit) could silently revert a machine flip, and a
machine flip mutated a file the operator owns (config drift).

Design: single source of truth per fact.
  * ``config.yaml`` holds the operator-authored DEFAULT (never machine-mutated).
  * ``state/runtime/<app>.json`` (gitignored) holds an optional machine
    OVERRIDE.
  * The EFFECTIVE value is ``override if present else config-default``.

This mirrors ``factory.settings.modes`` (the factory MODE is mutable runtime
state kept out of the YAML so an operator can flip it without a config
commit) — the same posture, applied per-app.

Backward compatibility: an app with no runtime-state file behaves EXACTLY as
before — every resolver falls back to the ``config.yaml`` value. Reads never
raise: a missing/unparseable/wrong-typed file is treated as "no override".
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig

# Per-app runtime-state files live here, gitignored (see root .gitignore).
RUNTIME_SUBDIR = ("state", "runtime")

# JSON key holding the machine override for ``deploy.enabled``. Absent means
# "no override" — the config-default is used.
KEY_DEPLOY_ENABLED = "deploy_enabled"


def runtime_state_path(software_factory_root: Path, app: str) -> Path:
    """Absolute path to ``state/runtime/<app>.json`` under the factory root."""
    return Path(software_factory_root, *RUNTIME_SUBDIR, f"{app}.json")


def read_runtime_state(software_factory_root: Path, app: str) -> dict[str, Any]:
    """Return the app's runtime-state mapping, or ``{}`` if there is none.

    Never raises: a missing file, unreadable file, invalid JSON, or a
    non-mapping payload all resolve to ``{}`` (no override) so callers get
    exactly the legacy behavior for an app that has no runtime state.
    """
    path = runtime_state_path(software_factory_root, app)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_runtime_state(
    software_factory_root: Path, app: str, data: dict[str, Any]
) -> None:
    """Persist ``data`` to the app's runtime-state file (atomic replace).

    Creates ``state/runtime/`` on demand. Writes to a temp file and
    ``os.replace``s it into place so a concurrent reader never observes a
    half-written file.
    """
    path = runtime_state_path(software_factory_root, app)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# deploy_enabled override
# --------------------------------------------------------------------------- #


def get_deploy_enabled_override(
    software_factory_root: Path, app: str
) -> bool | None:
    """Return the machine override for ``deploy.enabled``, or ``None`` if
    there is no (valid boolean) override — in which case the config default
    applies. A non-boolean value in the file is ignored (treated as absent)."""
    value = read_runtime_state(software_factory_root, app).get(KEY_DEPLOY_ENABLED)
    return value if isinstance(value, bool) else None


def set_deploy_enabled_override(
    software_factory_root: Path, app: str, value: bool
) -> None:
    """Set the machine override for ``deploy.enabled`` WITHOUT touching
    ``config.yaml``. The operator's authored default is left intact; the
    effective value becomes ``value`` until the override is cleared."""
    data = read_runtime_state(software_factory_root, app)
    data[KEY_DEPLOY_ENABLED] = bool(value)
    _write_runtime_state(software_factory_root, app, data)


def clear_deploy_enabled_override(software_factory_root: Path, app: str) -> bool:
    """Remove the ``deploy.enabled`` override so the config default applies
    again. Returns True if an override was present and removed, False if
    there was nothing to clear. Removes the runtime-state file entirely when
    it becomes empty, so a cleared app is byte-for-byte back to legacy."""
    data = read_runtime_state(software_factory_root, app)
    if KEY_DEPLOY_ENABLED not in data:
        return False
    del data[KEY_DEPLOY_ENABLED]
    if data:
        _write_runtime_state(software_factory_root, app, data)
    else:
        runtime_state_path(software_factory_root, app).unlink(missing_ok=True)
    return True


# --------------------------------------------------------------------------- #
# Resolver + observability
# --------------------------------------------------------------------------- #


def effective_deploy_enabled(cfg: AppConfig, software_factory_root: Path) -> bool:
    """Effective ``deploy.enabled`` for ``cfg``: the machine runtime override
    if one is set, else the operator-authored ``config.yaml`` value.

    This is the single resolver every read site should call instead of
    reading ``cfg.deploy.enabled`` directly, so config default and machine
    override merge in exactly one place.
    """
    override = get_deploy_enabled_override(software_factory_root, cfg.name)
    return override if override is not None else cfg.deploy.enabled


def describe_deploy_enabled(
    cfg: AppConfig, software_factory_root: Path
) -> dict[str, Any]:
    """Observability: return config-default vs runtime-override vs effective
    for ``deploy.enabled``, plus which one is winning (``source``). Lets an
    operator (or a log line) see WHY the effective value is what it is."""
    override = get_deploy_enabled_override(software_factory_root, cfg.name)
    config_default = cfg.deploy.enabled
    return {
        "app": cfg.name,
        "config_default": config_default,
        "override": override,
        "effective": override if override is not None else config_default,
        "source": "runtime_override" if override is not None else "config_default",
    }


__all__ = [
    "RUNTIME_SUBDIR",
    "KEY_DEPLOY_ENABLED",
    "runtime_state_path",
    "read_runtime_state",
    "get_deploy_enabled_override",
    "set_deploy_enabled_override",
    "clear_deploy_enabled_override",
    "effective_deploy_enabled",
    "describe_deploy_enabled",
]
