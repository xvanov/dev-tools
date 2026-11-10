"""``factory app add|set|list`` — register any GitHub repo as an app.

Contract: ``docs/JOBS-API.md`` (``factory app add/list``). Every ``--json``
invocation prints exactly ONE JSON object on stdout; exit 0 is a success
shape, non-zero is ``{"error": "<code>", "message": "..."}``.

``app add`` writes ``apps/<app>/config.yaml`` with gate commands from
:mod:`factory.app_detect` (deterministic, no model calls), creates
``apps/<app>/directions/``, and sets the app's DEFAULT delivery level to
``factory.delivery.NEW_APP_DEFAULT`` (``draft_pr``) unless told otherwise.
There is no per-app ceiling: a job that requests a level gets it; the default
only applies to a job that requests none (``factory/delivery.py``).

``app set`` changes an existing app's ``delivery.default`` and/or
``pipeline_default`` in place, editing only those lines so hand-written
comments and every other key survive.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any, NoReturn

import typer
import yaml

from factory.app_config import (
    PIPELINE_NAMES,
    AppConfig,
    load_app_config,
    resolve_app_repo_path,
)
from factory.app_detect import GATE_KEYS, Detection, detect
from factory.context.canonical_paths import DEFAULT_CONTEXT_DIR
from factory.delivery import NEW_APP_DEFAULT, DeliveryConfig, DeliveryLevel, parse_level
from factory.gate_model import NONE, normalize_requires, readiness
from factory.gate_model import field_name as gate_field_name
from factory.gate_model import short_name as gate_short_name

_FACTORY_ROOT = Path(__file__).resolve().parent.parent

apps_app = typer.Typer(help="Register, configure and list factory apps (any GitHub repo).")

_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")

#: Runs a command; returns (exit_code, combined output). Injectable for tests.
Runner = Callable[[list[str], Path | None], tuple[int, str]]

_GATE_WHY_EMPTY = {
    "lint_command": "no linter detected",
    "format_check_command": "no format checker detected",
    "type_check_command": "no type checker detected",
    "test_command": "no test runner detected — the chain's test gate cannot go green without one",
}


class AppAddError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _run(cmd: list[str], cwd: Path | None = None) -> tuple[int, str]:
    try:
        proc = subprocess.run(  # noqa: S603 — argv list, no shell
            cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=600
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


# --------------------------------------------------------------------------- #
# pure helpers
# --------------------------------------------------------------------------- #


def default_app_name(repo: str) -> str:
    """``Owner/My.Repo`` -> ``my-repo``."""
    name = repo.split("/", 1)[1].lower()
    name = re.sub(r"[^a-z0-9_-]+", "-", name).strip("-_")
    return name or "app"


def _remote_matches(url: str, repo: str) -> bool:
    """True when a git remote URL points at ``owner/name`` on GitHub."""
    u = url.strip().lower().removesuffix(".git").rstrip("/")
    if "github.com" not in u:
        return False
    return u.endswith("/" + repo.lower()) or u.endswith(":" + repo.lower())


def _default_branch(path: Path, runner: Runner) -> str:
    code, out = runner(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path)
    if code == 0 and out.strip().startswith("origin/"):
        return out.strip().removeprefix("origin/")
    code, out = runner(["git", "symbolic-ref", "--short", "HEAD"], path)
    if code == 0 and out.strip():
        return out.strip()
    return "main"


def _registered_repos(root: Path) -> dict[str, str]:
    """``{owner/name (lowercased): app}`` for every readable app config."""
    out: dict[str, str] = {}
    for cfg_path in sorted((root / "apps").glob("*/config.yaml")):
        try:
            raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(raw, dict) and raw.get("repo"):
            out[str(raw["repo"]).strip().lower()] = cfg_path.parent.name
    return out


def _q(value: str) -> str:
    """A YAML double-quoted scalar (JSON strings are valid YAML)."""
    return json.dumps(value)


def render_config(
    *,
    name: str,
    repo: str,
    app_repo_path: str,
    default_branch: str,
    delivery: DeliveryConfig,
    detection: Detection,
    pipeline_default: str = "chain",
    requires: dict[str, list[str]] | None = None,
    serve_tick: bool = False,
    tracker: str | None = None,
) -> str:
    """The commented ``config.yaml`` text. Round-trips through ``AppConfig``."""
    from factory.tracker import default_tracker

    tracker = tracker or default_tracker(repo)
    lines = [
        "# Generated by `factory app add`. Change defaults with `factory app set`.",
        f"# Detected toolchains: {', '.join(detection.toolchains) or 'none'}",
        "",
        f"name: {_q(name)}",
        f"repo: {_q(repo)}",
        f"default_branch: {_q(default_branch)}",
        f"app_repo_path: {_q(app_repo_path)}",
        "# Read by the context loader at <app_repo_path>/<context_dir>/.",
        f"context_dir: {DEFAULT_CONTEXT_DIR}",
        "",
        "# The delivery level a job gets when it requests none (a job's own",
        "# request always wins; there is no per-app ceiling). New apps start at",
        "# draft_pr: push + open a DRAFT PR, never merge.",
        "delivery:",
        f"  default: {delivery.default.value}",
        "",
        "# The pipeline a job runs when it names none (or `auto`): chain | solo | auto.",
        f"pipeline_default: {pipeline_default}",
        "",
        "# factory serve (Windows) ticks this app on its interval even when it has no",
        "# active job. Off: serve still ticks it while a job is active. Change with",
        "# `factory app set <app> --serve-tick on|off`.",
        f"serve_tick: {'true' if serve_tick else 'false'}",
        "# Where directions, stories, escalations and live status are tracked:",
        "# github_issues | local (state/factory.db; nothing touches GitHub Issues).",
        "# Only the operator's personal repos may use github_issues (factory/tracker.py).",
        f"tracker: {tracker}",
        "",
        "# Gate commands: a shell command, `none` (the repo has no such check:",
        "# skipped, reported 'not configured: skipped'), or EMPTY = NOT CONFIGURED",
        "# yet — never 'passing'. A code job on an app whose test gate is EMPTY",
        "# (and whose repo has no tests/) is refused at submit. Set them with",
        '# `factory app set <app> --gate test="<cmd>"` / `--gate test=none`.',
        "# Only test_command is executed by the chain (dev sandbox + tests-green);",
        "# lint/format/typecheck are recorded for the pre-PR ruff check and for",
        "# humans, and are enforced only by the repo's own required CI checks.",
        "gates:",
    ]
    for gate in GATE_KEYS:
        cmd = detection.gates.get(gate, "")
        if cmd:
            lines.append(f"  # from: {detection.sources.get(gate, 'detected')}")
            lines.append(f"  {gate}: {_q(cmd)}")
        else:
            lines.append(f"  # NOT DETECTED ({_GATE_WHY_EMPTY[gate]}) — fill in by hand.")
            sug = detection.suggested.get(gate)
            if sug:
                lines.append(f"  # suggested ({sug['source']}): {sug['command']}")
                if sug.get("requires"):
                    lines.append(f"  #   needs on PATH: {', '.join(sug['requires'])}")
            lines.append(f'  {gate}: ""')
    if requires:
        lines.append("  # Executables each gate needs on PATH, checked before a job runs.")
        lines.append(f"  requires: {json.dumps(requires)}")
    lines.append('  coverage_command: ""')
    if detection.smoke_command:
        lines += [
            "  # Detected but NOT required: set smoke_harness_ready: true only once",
            "  # this boots the app and passes on main, or every story will block.",
            f"  smoke_command: {_q(detection.smoke_command)}",
        ]
    lines += [
        "  smoke_harness_ready: false",
        "  flake_quarantine: false",
        "  mutation_testing: false",
        "",
        "deploy:",
        "  enabled: false",
        "",
        "# Empty = the factory's default per-persona routing (factory/routes.yaml).",
        "models: {}",
        "",
    ]
    return "\n".join(lines)


def _rel_or_abs(path: Path, root: Path) -> str:
    """``../<dir>`` for a sibling of the factory root (the documented
    convention, see ``load_app_config``); absolute otherwise."""
    path = path.resolve()
    if path.parent == root.resolve().parent:
        return f"../{path.name}"
    return str(path)


def tick_unit(app: str) -> str:
    return f"factory-tick@{app}.timer"


def enable_tick_command(app: str) -> list[str]:
    """The exact command ``--enable-tick`` runs. Uses the installed template
    units ``factory-tick@.service`` / ``factory-tick@.timer``."""
    return ["systemctl", "--user", "enable", "--now", tick_unit(app)]


def _parse_tracker(repo: str | None, value: str | None) -> str | None:
    """Validate ``--tracker`` for ``repo`` (factory/tracker.py)."""
    from factory.tracker import check_tracker_allowed, parse_tracker

    try:
        name = parse_tracker(value)
        check_tracker_allowed(repo, name)
    except ValueError as exc:
        raise AppAddError("invalid_tracker", str(exc)) from exc
    return name


def default_tracker(repo: str) -> str:
    """The tracker ``factory app add`` writes when none is passed."""
    from factory import tracker

    return tracker.default_tracker(repo)


def tracker_view(cfg: AppConfig) -> dict[str, Any]:
    """``{"tracker", "tracker_source"}`` for app add/set/show/list output."""
    from factory import tracker

    return {"tracker": tracker.configured_tracker(cfg), "tracker_source": tracker.tracker_source(cfg)}


def _parse_pipeline(value: str | None) -> str | None:
    """``None`` for absent; :class:`AppAddError` for anything not a pipeline."""
    if value is None or value == "":
        return None
    v = str(value).strip().lower()
    if v not in PIPELINE_NAMES:
        raise AppAddError(
            "invalid_pipeline",
            f"unknown pipeline {value!r}; one of: {', '.join(PIPELINE_NAMES)}",
        )
    return v


def _parse_on_off(value: str | bool | None, flag: str) -> bool | None:
    """``on``/``off`` (and true/false, yes/no, 1/0) -> bool; ``None`` for absent."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    v = str(value).strip().lower()
    if v in ("on", "true", "yes", "1"):
        return True
    if v in ("off", "false", "no", "0"):
        return False
    raise AppAddError("invalid_serve_tick", f"{flag} is on or off, got {value!r}")


# --- in-place config edits (comment-preserving) ----------------------------- #

_TOP_SCALAR = r"^{key}:[ \t]*(?P<val>[^#\n]*?)(?P<tail>[ \t]+#[^\n]*)?[ \t]*$"


def _set_top_scalar(text: str, key: str, value: str) -> str:
    """Set a top-level ``key: value`` line, keeping its trailing comment.

    Appends the key when absent. Leaves the text unchanged when the key holds a
    block or flow collection — the caller's parse-back check then falls back.
    """
    pat = re.compile(_TOP_SCALAR.format(key=re.escape(key)), re.MULTILINE)
    m = pat.search(text)
    if m is None:
        sep = "" if not text or text.endswith("\n") else "\n"
        return f"{text}{sep}{key}: {value}\n"
    if not m.group("val") or m.group("val")[0] in "{[|>&*!":
        return text
    return text[: m.start("val")] + value + text[m.end("val") :]


def _set_block_child(text: str, block: str, key: str, value: str) -> str:
    """Set ``block.key`` inside a top-level block mapping (``block:`` on its own
    line, children indented). Adds the block or the child when absent."""
    lines = text.splitlines(keepends=True)
    head = re.compile(rf"^{re.escape(block)}:[ \t]*(#[^\n]*)?\n?$")
    start = next((i for i, ln in enumerate(lines) if head.match(ln)), None)
    if start is None:
        if any(re.match(rf"^{re.escape(block)}:", ln) for ln in lines):
            return text  # flow / inline form: let the caller fall back
        sep = "" if not text or text.endswith("\n") else "\n"
        return f"{text}{sep}{block}:\n  {key}: {value}\n"
    indent: str | None = None
    end = start + 1
    while end < len(lines):
        ln = lines[end]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            end += 1
            continue
        if not ln[0].isspace():
            break
        end += 1
    child = re.compile(
        rf"^(?P<ind>[ \t]+){re.escape(key)}:[ \t]*(?P<val>[^#\n]*?)"
        r"(?P<tail>[ \t]+#[^\n]*)?[ \t]*(?P<nl>\n?)$"
    )
    for i in range(start + 1, end):
        ln = lines[i]
        if ln.strip() and not ln.lstrip().startswith("#") and ln[0].isspace():
            # The block's own children share the FIRST child's indent; a deeper
            # line belongs to a nested mapping and is never the key we want.
            here = ln[: len(ln) - len(ln.lstrip())]
            if indent is None:
                indent = here
            if here != indent:
                continue
            m = child.match(ln)
            if m:
                lines[i] = f"{indent}{key}: {value}{m.group('tail') or ''}{m.group('nl')}"
                return "".join(lines)
    lines.insert(start + 1, f"{indent or '  '}{key}: {value}\n")
    return "".join(lines)


def set_app(
    *,
    root: Path,
    app: str,
    delivery_default: str | None = None,
    pipeline_default: str | None = None,
    gates: dict[str, str] | None = None,
    requires: dict[str, list[str]] | None = None,
    review_default: str | None = None,
    review_min_diff_lines: int | None = None,
    caps: dict[str, Any] | None = None,
    serve_tick: str | bool | None = None,
    tracker: str | None = None,
) -> dict[str, Any]:
    """Change an app's default delivery level, default pipeline and/or gates.

    ``serve_tick`` (on|off): whether ``factory serve`` ticks the app while it
    has no active job (it always ticks an app with one).

    ``tracker`` (``github_issues`` | ``local``, factory/tracker.py):
    ``github_issues`` is refused for a non-personal repo.

    v1.9: ``review_default`` (off|on|auto), ``review_min_diff_lines`` (0 = no
    size rule) and ``caps`` (``{budget_usd|wall_clock_h|max_rounds: value}``).

    ``gates``: ``{gate: command}`` keyed by short (``test``) or field name
    (``test_command``); the command ``none`` means the repo has no such check,
    ``""`` un-sets the gate. ``requires``: ``{gate: [tool, ...]}`` replaces that
    gate's list (an empty list removes it).

    Edits only the affected lines of ``apps/<app>/config.yaml`` (comments and
    every other key survive). If the file's layout defeats the line edit, the
    whole file is re-dumped from the parsed YAML instead (comments lost,
    ``comments_preserved: false``). The result is validated through
    :class:`AppConfig` before anything is written; a refusal writes nothing.
    """
    if not _NAME_RE.match(app):
        raise AppAddError("invalid_name", f"app name {app!r} must match {_NAME_RE.pattern}")
    cfg_path = root / "apps" / app / "config.yaml"
    if not cfg_path.is_file():
        raise AppAddError("unknown_app", f"no app {app!r} ({cfg_path} does not exist)")
    try:
        level = parse_level(delivery_default)
    except ValueError as exc:
        raise AppAddError("invalid_delivery", str(exc)) from exc
    pipeline = _parse_pipeline(pipeline_default)
    gate_values = _parse_gates(gates)
    req_updates = _parse_requires(requires)
    from factory.job_policy import parse_caps, parse_review

    try:
        review_mode = parse_review(review_default)
    except ValueError as exc:
        raise AppAddError("invalid_review", str(exc)) from exc
    if review_min_diff_lines is not None and int(review_min_diff_lines) < 0:
        raise AppAddError("invalid_review", "--review-min-diff-lines must be >= 0")
    try:
        cap_values = parse_caps(caps or {})
    except ValueError as exc:
        raise AppAddError("invalid_cap", str(exc)) from exc
    tick_value = _parse_on_off(serve_tick, "--serve-tick")
    if (
        level is None
        and pipeline is None
        and not gate_values
        and not requires
        and review_mode is None
        and review_min_diff_lines is None
        and not cap_values
        and tick_value is None
        and not (tracker or "").strip()
    ):
        raise AppAddError(
            "nothing_to_set",
            "pass --delivery-default, --pipeline-default, --gate, --requires, "
            "--review-default, --review-min-diff-lines, --cap, --serve-tick and/or --tracker",
        )

    text = cfg_path.read_text(encoding="utf-8")
    try:
        raw = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise AppAddError("invalid_config", f"{cfg_path} is not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise AppAddError("invalid_config", f"{cfg_path} is not a mapping")
    tracker_name = _parse_tracker(str(raw.get("repo") or ""), tracker)

    expected = dict(raw)
    new_text = text
    if tracker_name is not None:
        expected["tracker"] = tracker_name
        new_text = _set_top_scalar(new_text, "tracker", tracker_name)
    if level is not None:
        block = expected.get("delivery")
        if block is not None and not isinstance(block, dict):
            raise AppAddError("invalid_config", f"{cfg_path}: delivery must be a mapping")
        expected["delivery"] = {**(block or {}), "default": level.value}
        new_text = _set_block_child(new_text, "delivery", "default", level.value)
    if pipeline is not None:
        expected["pipeline_default"] = pipeline
        new_text = _set_top_scalar(new_text, "pipeline_default", pipeline)
    if gate_values or req_updates:
        gblock = expected.get("gates")
        if gblock is not None and not isinstance(gblock, dict):
            raise AppAddError("invalid_config", f"{cfg_path}: gates must be a mapping")
        gblock = dict(gblock or {})
        for fld, cmd in gate_values.items():
            gblock[fld] = cmd
            new_text = _set_block_child(new_text, "gates", fld, _q(cmd))
        if req_updates:
            try:
                merged = normalize_requires(gblock.get("requires"))
            except ValueError as exc:
                raise AppAddError("invalid_config", f"{cfg_path}: {exc}") from exc
            merged.update(req_updates)
            merged = {k: v for k, v in merged.items() if v}
            gblock["requires"] = merged
            new_text = _set_block_child(new_text, "gates", "requires", json.dumps(merged))
        expected["gates"] = gblock
    if review_mode is not None or review_min_diff_lines is not None:
        rblock = expected.get("review")
        if rblock is not None and not isinstance(rblock, dict):
            raise AppAddError("invalid_config", f"{cfg_path}: review must be a mapping")
        rblock = dict(rblock or {})
        if review_mode is not None:
            rblock["default"] = review_mode
            # Quoted: a bare ``on``/``off`` is a YAML boolean.
            new_text = _set_block_child(new_text, "review", "default", _q(review_mode))
        if review_min_diff_lines is not None:
            rblock["auto_min_diff_lines"] = int(review_min_diff_lines)
            new_text = _set_block_child(
                new_text, "review", "auto_min_diff_lines", str(int(review_min_diff_lines))
            )
        expected["review"] = rblock
    if cap_values:
        cblock = expected.get("caps")
        if cblock is not None and not isinstance(cblock, dict):
            raise AppAddError("invalid_config", f"{cfg_path}: caps must be a mapping")
        cblock = dict(cblock or {})
        for key, val in cap_values.items():
            v: Any = int(val) if key == "max_rounds" else float(val)
            cblock[key] = v
            new_text = _set_block_child(new_text, "caps", key, str(v))
        expected["caps"] = cblock
    if tick_value is not None:
        expected["serve_tick"] = tick_value
        new_text = _set_top_scalar(new_text, "serve_tick", "true" if tick_value else "false")

    try:
        AppConfig.model_validate(expected)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError and friends
        raise AppAddError("invalid_config", f"{cfg_path} would not load: {exc}") from exc

    try:
        preserved = yaml.safe_load(new_text) == expected
    except yaml.YAMLError:
        preserved = False
    if not preserved:
        new_text = yaml.safe_dump(expected, sort_keys=False, allow_unicode=True)

    changed = [
        f
        for f, before, after in (
            ("delivery.default", _delivery_default(raw), _delivery_default(expected)),
            ("pipeline_default", raw.get("pipeline_default"), expected.get("pipeline_default")),
            ("tracker", raw.get("tracker"), expected.get("tracker")),
            *(
                (f"gates.{fld}", _gate_raw(raw, fld), _gate_raw(expected, fld))
                for fld in (*GATE_KEYS, "requires")
            ),
            ("review", raw.get("review"), expected.get("review")),
            ("caps", raw.get("caps"), expected.get("caps")),
            ("serve_tick", bool(raw.get("serve_tick")), bool(expected.get("serve_tick"))),
        )
        if before != after
    ]
    if new_text != text:
        tmp = cfg_path.with_suffix(".yaml.tmp")
        tmp.write_text(new_text, encoding="utf-8")
        tmp.replace(cfg_path)

    cfg = load_app_config(app, root)
    ready = readiness(cfg, resolve_app_repo_path(cfg, root))
    return {
        "app": app,
        "config_path": str(cfg_path.resolve()),
        "delivery": {"default": cfg.delivery.default.value},
        "pipeline_default": cfg.pipeline_default,
        **tracker_view(cfg),
        **policy_defaults(cfg),
        "serve_tick": cfg.serve_tick,
        "gates": ready["gates"],
        "readiness": _readiness_view(ready),
        "changed": changed,
        "comments_preserved": preserved,
    }


def policy_defaults(cfg: AppConfig) -> dict[str, Any]:
    """``review`` and ``caps`` as ``app list/show/set`` report them (v1.9)."""
    return {
        "review": {
            "default": cfg.review.default,
            "auto_min_diff_lines": cfg.review.auto_min_diff_lines,
        },
        "caps": {
            "budget_usd": cfg.caps.budget_usd,
            "wall_clock_h": cfg.caps.wall_clock_h,
            "max_rounds": cfg.caps.max_rounds,
        },
    }


def _delivery_default(raw: dict[str, Any]) -> Any:
    block = raw.get("delivery")
    return block.get("default") if isinstance(block, dict) else None


def _gate_raw(raw: dict[str, Any], fld: str) -> Any:
    block = raw.get("gates")
    if not isinstance(block, dict):
        return None
    if fld == "requires":
        try:
            return normalize_requires(block.get("requires")) or None
        except ValueError:
            return block.get("requires")
    return block.get(fld) or None


def _parse_gates(gates: dict[str, str] | None) -> dict[str, str]:
    """``{gate: cmd}`` -> ``{field: cmd}``; :class:`AppAddError` on a bad one."""
    out: dict[str, str] = {}
    for name, cmd in (gates or {}).items():
        try:
            fld = gate_field_name(name)
        except ValueError as exc:
            raise AppAddError("invalid_gate", str(exc)) from exc
        value = str(cmd if cmd is not None else "").strip()
        if "\n" in value or "\r" in value:
            raise AppAddError("invalid_gate", f"gate {name}: one line only (join with &&)")
        out[fld] = NONE if value.lower() == NONE else value
    return out


def _parse_requires(requires: dict[str, Any] | None) -> dict[str, list[str]]:
    """``{gate: tools}`` -> ``{short gate: [tool, ...]}`` (``[]`` = remove)."""
    out: dict[str, list[str]] = {}
    for name, tools in (requires or {}).items():
        try:
            short = gate_short_name(name)
            out[short] = normalize_requires({short: tools}).get(short, [])
        except ValueError as exc:
            raise AppAddError("invalid_requires", str(exc)) from exc
    return out


def _readiness_view(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": r["status"],
        "unset": r["unset"],
        "missing_tools": r["missing_tools"],
        "blocking": r["blocking"],
        "warnings": r["warnings"],
    }


def _assignments(values: list[str] | None, flag: str) -> dict[str, str]:
    """``["test=npm test", ...]`` -> ``{"test": "npm test"}``."""
    out: dict[str, str] = {}
    for v in values or []:
        if "=" not in v:
            raise AppAddError(
                "invalid_gate" if flag == "--gate" else "invalid_requires",
                f"{flag} wants NAME=VALUE, got {v!r}",
            )
        k, _, val = v.partition("=")
        out[k.strip()] = val
    return out


# --------------------------------------------------------------------------- #
# the operation
# --------------------------------------------------------------------------- #


def add_app(
    *,
    root: Path,
    repo: str,
    path: Path | None = None,
    name: str | None = None,
    delivery_default: str | None = None,
    pipeline_default: str | None = None,
    force: bool = False,
    enable_tick: bool = False,
    gates: dict[str, str] | None = None,
    requires: dict[str, Any] | None = None,
    serve_tick: bool = False,
    runner: Runner = _run,
    tracker: str | None = None,
) -> dict[str, Any]:
    """Register ``repo`` as an app under ``root``; returns the success shape.

    ``serve_tick``: ``factory serve`` ticks the app on its interval even while
    it has no active job (it ticks an app with an active job regardless).
    ``tracker`` (``github_issues`` | ``local``): absent = derived from the
    repo's owner (factory/tracker.py); ``github_issues`` is refused for a
    non-personal repo (``invalid_tracker``).

    ``gates`` / ``requires`` (as in :func:`set_app`) override detection: the
    confirmed values a human chose. Raises :class:`AppAddError` on every
    refusal, before anything is written (except ``enable_tick_failed``, which
    by construction comes after).
    """
    repo = repo.strip().removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if not _REPO_RE.match(repo):
        raise AppAddError("invalid_repo", f"--repo must be owner/name, got {repo!r}")
    app = name or default_app_name(repo)
    if not _NAME_RE.match(app):
        raise AppAddError(
            "invalid_name", f"app name {app!r} must match {_NAME_RE.pattern} (use --name)"
        )

    try:
        delivery = DeliveryConfig(default=parse_level(delivery_default) or NEW_APP_DEFAULT)
    except ValueError as exc:
        raise AppAddError("invalid_delivery", str(exc)) from exc
    pipeline = _parse_pipeline(pipeline_default) or "chain"
    gate_values = _parse_gates(gates)
    req_values = {k: v for k, v in _parse_requires(requires).items() if v}
    tracker_name = _parse_tracker(repo, tracker) or default_tracker(repo)

    app_dir = root / "apps" / app
    cfg_path = app_dir / "config.yaml"
    if cfg_path.exists() and not force:
        raise AppAddError("app_exists", f"{cfg_path} already exists; pass --force to overwrite it")
    owner = _registered_repos(root).get(repo.lower())
    if owner and owner != app and not force:
        raise AppAddError(
            "repo_already_registered",
            f"{repo} is already registered as app {owner!r}; pass --force to add a second app",
        )

    clone_path = (path or (root.resolve().parent / app)).expanduser()
    cloned = False
    if clone_path.exists():
        if not (clone_path / ".git").exists():
            raise AppAddError("not_a_git_repo", f"{clone_path} exists but is not a git checkout")
        code, url = runner(["git", "remote", "get-url", "origin"], clone_path)
        if code != 0 or not _remote_matches(url, repo):
            if not force:
                got = url.strip() if code == 0 else "no origin remote"
                raise AppAddError(
                    "repo_mismatch",
                    f"{clone_path} origin is {got!r}, not {repo}; pass --force to use it anyway",
                )
    else:
        # Absent (default location, or a --path that does not exist yet): clone.
        clone_path.parent.mkdir(parents=True, exist_ok=True)
        if shutil.which("gh"):
            cmd = ["gh", "repo", "clone", repo, str(clone_path)]
        else:
            cmd = ["git", "clone", f"https://github.com/{repo}.git", str(clone_path)]
        code, out = runner(cmd, None)
        if code != 0 or not (clone_path / ".git").exists():
            raise AppAddError("clone_failed", f"{' '.join(cmd)} failed: {out.strip()[-500:]}")
        cloned = True

    detection = detect(clone_path)
    for fld, gate_cmd in gate_values.items():
        if gate_cmd:
            detection.gates[fld] = gate_cmd
            detection.sources[fld] = "confirmed with --gate"
        else:
            detection.gates.pop(fld, None)
    text = render_config(
        name=app,
        repo=repo,
        app_repo_path=_rel_or_abs(clone_path, root),
        default_branch=_default_branch(clone_path, runner),
        delivery=delivery,
        detection=detection,
        pipeline_default=pipeline,
        requires=req_values,
        serve_tick=serve_tick,
        tracker=tracker_name,
    )
    # Never write a config the loader would reject.
    cfg = AppConfig.model_validate(yaml.safe_load(text))

    app_dir.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(text, encoding="utf-8")
    (app_dir / "directions").mkdir(exist_ok=True)
    # The context loader reads <repo>/<context_dir>/; an empty dir is invisible to git.
    (clone_path / DEFAULT_CONTEXT_DIR).mkdir(exist_ok=True)

    ready = readiness(cfg, clone_path)
    result: dict[str, Any] = {
        "app": app,
        "repo": repo,
        "path": str(clone_path.resolve()),
        "config_path": str(cfg_path.resolve()),
        "gates": {k: detection.gates.get(k, "") for k in GATE_KEYS},
        "requires": req_values,
        "delivery": {"default": delivery.default.value},
        "pipeline_default": pipeline,
        "serve_tick": cfg.serve_tick,
        "tracker": tracker_name,
        "missing_gates": detection.missing,
        "suggested_gates": detection.suggested,
        "docs_only": detection.docs_only,
        "ci": detection.ci,
        "readiness": _readiness_view(ready),
        "toolchains": detection.toolchains,
        "smoke_command": detection.smoke_command,
        "notes": detection.notes,
        "cloned": cloned,
        "tick": {"unit": tick_unit(app), "enabled": False},
    }

    if enable_tick:
        cmd = enable_tick_command(app)
        code, out = runner(cmd, None)
        if code != 0:
            raise AppAddError(
                "enable_tick_failed",
                f"config written to {cfg_path}, but `{' '.join(cmd)}` failed: {out.strip()[-500:]}",
            )
        result["tick"]["enabled"] = True
    return result


def list_registered_apps(root: Path, *, coverage: Any = None) -> list[dict[str, Any]]:
    """One row per app. Cheap: a config parse, a PATH lookup per required tool
    and a stat of the checkout (no detection), so ``app list`` stays fast."""
    if coverage is None:
        from factory.scheduler.coverage import read_coverage

        coverage = read_coverage(root)
    rows: list[dict[str, Any]] = []
    for cfg_path in sorted((root / "apps").glob("*/config.yaml")):
        app = cfg_path.parent.name
        try:
            cfg = load_app_config(app, root)
        except Exception as exc:  # noqa: BLE001 — one broken config must not hide the rest
            rows.append({"app": app, "error": f"{type(exc).__name__}: {exc}"})
            continue
        path = resolve_app_repo_path(cfg, root)
        ready = readiness(cfg, path)
        rows.append(
            {
                "app": app,
                "repo": cfg.repo,
                "path": str(path),
                "delivery": {"default": cfg.delivery.default.value},
                "pipeline_default": cfg.pipeline_default,
                **tracker_view(cfg),
                **policy_defaults(cfg),  # v1.9
                "serve_tick": cfg.serve_tick,
                "ticked": coverage.ticked(app),  # v1.6
                "gates": ready["gates"],
                "readiness": _readiness_view(ready),
            }
        )
    return rows


def show_app(root: Path, app: str) -> dict[str, Any]:
    """One app with its gates, readiness and detection's suggestions.

    Runs detection on the checkout (read-only file reads), so the suggestions
    reflect the repo as it is now, including its CI workflows.
    """
    if not _NAME_RE.match(app):
        raise AppAddError("invalid_name", f"app name {app!r} must match {_NAME_RE.pattern}")
    cfg_path = root / "apps" / app / "config.yaml"
    if not cfg_path.is_file():
        raise AppAddError("unknown_app", f"no app {app!r} ({cfg_path} does not exist)")
    try:
        cfg = load_app_config(app, root)
    except Exception as exc:  # noqa: BLE001
        raise AppAddError("invalid_config", f"{cfg_path} does not load: {exc}") from exc
    path = resolve_app_repo_path(cfg, root)
    ready = readiness(cfg, path)
    det = detect(path) if path.is_dir() else None
    return {
        "app": app,
        "repo": cfg.repo,
        "path": str(path),
        "path_exists": path.is_dir(),
        "config_path": str(cfg_path.resolve()),
        "delivery": {"default": cfg.delivery.default.value},
        "pipeline_default": cfg.pipeline_default,
        **tracker_view(cfg),
        **policy_defaults(cfg),
        "serve_tick": cfg.serve_tick,
        "gates": ready["gates"],
        "readiness": _readiness_view(ready),
        "detected": {k: det.gates.get(k, "") for k in GATE_KEYS} if det else {},
        "suggested_gates": det.suggested if det else {},
        "docs_only": det.docs_only if det else False,
        "ci": det.ci if det else [],
        "toolchains": det.toolchains if det else [],
        "notes": det.notes if det else ["the checkout is missing: nothing to detect"],
    }


# --------------------------------------------------------------------------- #
# typer surface
# --------------------------------------------------------------------------- #


def _fail(json_out: bool, code: str, message: str) -> NoReturn:
    if json_out:
        typer.echo(json.dumps({"error": code, "message": message}))
    else:
        typer.echo(f"error ({code}): {message}", err=True)
    raise typer.Exit(code=1)


_LEVELS = ", ".join(lvl.value for lvl in DeliveryLevel)
_PIPELINES = ", ".join(PIPELINE_NAMES)
_GATE_HELP = (
    "NAME=COMMAND, repeatable. NAME is lint | format_check | type_check | test. "
    "COMMAND `none` = the repo has no such check (skipped); empty = not configured."
)
_TRACKER_HELP = (
    "github_issues | local. Where directions/stories/escalations are tracked. "
    "Default: github_issues for a personal owner's repo, local otherwise; "
    "github_issues is refused for a non-personal repo."
)
_REQUIRES_HELP = (
    "NAME=tool1,tool2, repeatable: executables the gate needs on PATH (docker, lychee); "
    "checked before a job runs. Empty removes the list."
)


def _echo_gates(res: dict[str, Any]) -> None:
    for short, info in (res.get("gates") or {}).items():
        st = info.get("state")
        shown = (
            info.get("command")
            if st == "command"
            else ("none (skipped)" if st == "none" else "(EMPTY — not configured)")
        )
        req = f"  requires: {', '.join(info['requires'])}" if info.get("requires") else ""
        miss = f"  MISSING: {', '.join(info['missing'])}" if info.get("missing") else ""
        typer.echo(f"  {short}: {shown}{req}{miss}")
    r = res.get("readiness") or {}
    if r:
        typer.echo(f"  readiness: {r.get('status')}")
        if r.get("blocking"):
            typer.echo(f"  BLOCKS code jobs: {r['blocking']}")
        for w in r.get("warnings") or []:
            typer.echo(f"  warning: {w}")


@apps_app.command("add")
def add_cmd(
    repo: str = typer.Option(..., "--repo", help="GitHub owner/name."),
    path: Path | None = typer.Option(
        None, "--path", help="Existing local clone. Default: clone to ../<name>."
    ),
    name: str | None = typer.Option(None, "--name", help="App name. Default: the repo name."),
    delivery_default: str | None = typer.Option(
        None,
        "--delivery-default",
        help=f"Delivery level for jobs that request none (default draft_pr). One of: {_LEVELS}.",
    ),
    pipeline_default: str | None = typer.Option(
        None,
        "--pipeline-default",
        help=f"Pipeline for jobs that name none (default chain). One of: {_PIPELINES}.",
    ),
    gate: list[str] | None = typer.Option(None, "--gate", help=_GATE_HELP),
    requires: list[str] | None = typer.Option(None, "--requires", help=_REQUIRES_HELP),
    force: bool = typer.Option(
        False, "--force", help="Overwrite an existing config / accept a mismatched clone."
    ),
    enable_tick: bool = typer.Option(
        False,
        "--enable-tick",
        help="Also `systemctl --user enable --now factory-tick@<app>.timer`.",
    ),
    serve_tick: bool = typer.Option(
        False,
        "--serve-tick",
        help="factory serve (Windows) ticks the app on its interval even with no active job "
        "(writes serve_tick: true). Without it serve ticks the app only while a job is active.",
    ),
    tracker: str | None = typer.Option(None, "--tracker", help=_TRACKER_HELP),
    json_out: bool = typer.Option(False, "--json", help="Print one JSON object (JOBS-API)."),
) -> None:
    """Register any GitHub repo as a factory app (writes apps/<app>/config.yaml)."""
    try:
        res = add_app(
            root=_FACTORY_ROOT,
            repo=repo,
            path=path,
            name=name,
            delivery_default=delivery_default,
            pipeline_default=pipeline_default,
            force=force,
            enable_tick=enable_tick,
            gates=_assignments(gate, "--gate"),
            requires=_assignments(requires, "--requires"),
            serve_tick=serve_tick,
            runner=_run,  # module global, looked up per call (patchable)
            tracker=tracker,
        )
    except AppAddError as exc:
        _fail(json_out, exc.code, exc.message)
    if json_out:
        typer.echo(json.dumps(res))
        return
    typer.echo(f"Registered app {res['app']} ({res['repo']}) -> {res['config_path']}")
    typer.echo(f"  source: {res['path']}{' (cloned)' if res['cloned'] else ''}")
    typer.echo(f"  toolchains: {', '.join(res['toolchains']) or 'none detected'}")
    for gate_key, cmd in res["gates"].items():
        typer.echo(f"  {gate_key}: {cmd or '(EMPTY — not configured)'}")
    typer.echo(f"  delivery default: {res['delivery']['default']}")
    typer.echo(f"  pipeline default: {res['pipeline_default']}")
    typer.echo(
        "  serve_tick: "
        + ("on (factory serve ticks it on its interval)" if res["serve_tick"]
           else "off (factory serve ticks it while a job is active)")
    )
    typer.echo(f"  tracker: {res['tracker']}")
    if res["missing_gates"]:
        typer.echo("  MISSING gates (fill in by hand): " + ", ".join(res["missing_gates"]))
    for gate_key, sug in res["suggested_gates"].items():
        typer.echo(f"  suggested {gate_key}: {sug['command']}  ({sug['source']})")
    for note in res["notes"]:
        typer.echo(f"  note: {note}")
    if res["readiness"].get("blocking"):
        typer.echo(f"  BLOCKS code jobs: {res['readiness']['blocking']}")
    if res["tick"]["enabled"]:
        typer.echo(f"  enabled {res['tick']['unit']}")
    else:
        typer.echo(
            f"  tick not enabled; `factory on` (or `systemctl --user enable --now "
            f"{res['tick']['unit']}`) starts it"
        )


@apps_app.command("set")
def set_cmd(
    app: str = typer.Argument(..., help="Registered app name (apps/<app>/)."),
    delivery_default: str | None = typer.Option(
        None,
        "--delivery-default",
        help=f"Delivery level for jobs that request none. One of: {_LEVELS}.",
    ),
    pipeline_default: str | None = typer.Option(
        None,
        "--pipeline-default",
        help=f"Pipeline for jobs that name none. One of: {_PIPELINES}.",
    ),
    gate: list[str] | None = typer.Option(None, "--gate", help=_GATE_HELP),
    requires: list[str] | None = typer.Option(None, "--requires", help=_REQUIRES_HELP),
    review_default: str | None = typer.Option(
        None, "--review-default", help="v1.9: off | on | auto (solo review for jobs that name none)"
    ),
    review_min_diff_lines: int | None = typer.Option(
        None,
        "--review-min-diff-lines",
        help="v1.9: under auto, review a diff at least this big (0 = no size rule)",
    ),
    cap: list[str] | None = typer.Option(
        None, "--cap", help="v1.9: NAME=VALUE (repeat): budget_usd, wall_clock_h, max_rounds"
    ),
    serve_tick: str | None = typer.Option(
        None, "--serve-tick",
        help="on | off: factory serve ticks the app on its interval even with no active job",
    ),
    tracker: str | None = typer.Option(None, "--tracker", help=_TRACKER_HELP),
    json_out: bool = typer.Option(False, "--json", help="Print one JSON object (JOBS-API)."),
) -> None:
    """Change an app's defaults and gates (edits config.yaml in place)."""
    try:
        res = set_app(
            root=_FACTORY_ROOT,
            app=app,
            delivery_default=delivery_default,
            pipeline_default=pipeline_default,
            gates=_assignments(gate, "--gate"),
            requires=_assignments(requires, "--requires"),  # type: ignore[arg-type]
            review_default=review_default,
            review_min_diff_lines=review_min_diff_lines,
            caps=_assignments(cap, "--cap"),
            serve_tick=serve_tick,
            tracker=tracker,
        )
    except AppAddError as exc:
        _fail(json_out, exc.code, exc.message)
    if json_out:
        typer.echo(json.dumps(res))
        return
    typer.echo(f"{res['app']}: {res['config_path']}")
    typer.echo(f"  tracker: {res['tracker']} ({res['tracker_source']})")
    typer.echo(f"  review: {res['review']}")
    typer.echo(f"  caps: {res['caps']}")
    typer.echo(f"  serve_tick: {'on' if res['serve_tick'] else 'off'}")
    typer.echo(f"  delivery default: {res['delivery']['default']}")
    typer.echo(f"  pipeline default: {res['pipeline_default']}")
    _echo_gates(res)
    typer.echo(f"  changed: {', '.join(res['changed']) or 'nothing (already set)'}")
    if not res["comments_preserved"]:
        typer.echo("  note: the file was re-written from parsed YAML; its comments were lost")


@apps_app.command("show")
def show_cmd(
    app: str = typer.Argument(..., help="Registered app name (apps/<app>/)."),
    json_out: bool = typer.Option(False, "--json", help="Print one JSON object (JOBS-API)."),
) -> None:
    """One app: gates, readiness, and the gates detection suggests (incl. its CI)."""
    try:
        res = show_app(_FACTORY_ROOT, app)
    except AppAddError as exc:
        _fail(json_out, exc.code, exc.message)
    if json_out:
        typer.echo(json.dumps(res))
        return
    typer.echo(f"{res['app']}: {res['repo']}  path={res['path']}")
    typer.echo(f"  delivery={res['delivery']['default']}  pipeline={res['pipeline_default']}")
    _echo_gates(res)
    for gate_key, sug in res["suggested_gates"].items():
        typer.echo(f"  suggested {gate_key}: {sug['command']}  ({sug['source']})")
    for note in res["notes"]:
        typer.echo(f"  note: {note}")


@apps_app.command("list")
def list_cmd(
    json_out: bool = typer.Option(False, "--json", help="Print one JSON object (JOBS-API)."),
) -> None:
    """List registered apps with repo, path, defaults and gate readiness."""
    rows = list_registered_apps(_FACTORY_ROOT)
    if json_out:
        typer.echo(json.dumps({"apps": rows}))
        return
    if not rows:
        typer.echo("No apps registered (no apps/*/config.yaml).")
        return
    for r in rows:
        if "error" in r:
            typer.echo(f"{r['app']}: BROKEN CONFIG — {r['error']}")
            continue
        typer.echo(
            f"{r['app']}: {r['repo']}  path={r['path']}  "
            f"delivery={r['delivery']['default']}  pipeline={r['pipeline_default']}  "
            f"gates={r['readiness']['status']}"
        )
