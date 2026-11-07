"""Typer-based `factory` CLI.

Phase-0 subcommands:
  * ``factory --version``
  * ``factory hello``
  * ``factory test-persona dev --story <path> --repo <path> [...]``

Phase-1 additions:
  * ``factory new-direction --app <app>``
  * ``factory tell --app <app> "<text>"``
  * ``factory edit-direction --app <app> <id-or-slug>``
  * ``factory directions-backfill --app <app> [--dry-run]``
  * ``factory directions-regenerate-state --app <app> [--dry-run]``
  * ``factory directions-backfill-tracker-issue --app <app> [--dry-run]``
  * ``factory pm-sync --app <app> [--dry-run]``
  * ``factory ingest-issue --app <app> <issue-number>``
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Any

import typer
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from factory import __phase__, __version__
from factory.cli_apps import apps_app
from factory.model_router import route
from factory.runner import LLMConfig, sandbox_run

app = typer.Typer(help="Factory CLI — orchestrate the software factory.")
test_persona_app = typer.Typer(help="Run a single persona end-to-end for testing.")
app.add_typer(test_persona_app, name="test-persona")
app.add_typer(apps_app, name="app")
from factory.cli_jobs import job_app  # noqa: E402 - sub-app registration (docs/JOBS-API.md)

app.add_typer(job_app, name="job")

console = Console()

_FACTORY_ROOT = Path(__file__).resolve().parent.parent


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"{__version__} ({__phase__})")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False, "--version", callback=_version_callback, is_eager=True, help="Show version"
    ),
) -> None:
    """Factory orchestrator."""


@app.command()
def hello() -> None:
    """Sanity check — confirms the CLI is wired up."""
    console.print(
        Panel.fit(
            f"[bold green]factory[/bold green] v{__version__} ({__phase__}) is alive.\n"
            f"Phase-1 commands: [bold]new-direction[/bold], [bold]tell[/bold], "
            f"[bold]edit-direction[/bold], [bold]directions-backfill[/bold], "
            f"[bold]pm-sync[/bold], [bold]ingest-issue[/bold].",
            title="hello",
        )
    )


@test_persona_app.command("dev")
def test_persona_dev(
    story: Path = typer.Option(..., "--story", exists=True, help="Path to story markdown file"),
    repo: Path = typer.Option(
        ..., "--repo", exists=True, file_okay=False, help="Path to target app repo"
    ),
    difficulty: str = typer.Option(
        "standard", "--difficulty", help="dev difficulty: standard | hard"
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Do not call any LLM; assemble prompt and write a stub DB row."
    ),
    task_scope: str | None = typer.Option(
        None, "--task-scope", help="Optional task-scope hint for navigation.md lookup"
    ),
) -> None:
    """Run the Dev persona once against a story + repo."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    model = route("dev", difficulty=difficulty)
    cfg = LLMConfig(model=model)
    mode_label = "[yellow]DRY-RUN[/yellow]" if dry_run else "[green]REAL RUN[/green]"
    console.print(
        Panel.fit(
            f"persona=[bold]dev[/bold]  difficulty=[bold]{difficulty}[/bold]\n"
            f"model=[bold]{model}[/bold]\n"
            f"story=[bold]{story}[/bold]\n"
            f"repo=[bold]{repo}[/bold]\n"
            f"mode={mode_label}",
            title="factory test-persona dev",
        )
    )
    if not dry_run and not any(
        os.environ.get(k) for k in ("DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    ):
        console.print(
            "[yellow]warning:[/yellow] no provider API keys set; the SDK call will fail. "
            "Pass [bold]--dry-run[/bold] to test wiring."
        )

    result = asyncio.run(
        sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=cfg,
            difficulty=difficulty,
            dry_run=dry_run,
            task_scope=task_scope,
        )
    )

    color = "green" if result.success else ("yellow" if dry_run else "red")
    console.print(
        Panel(
            f"success={result.success}\n"
            f"test_run_passed={result.test_run_passed}\n"
            f"files_changed={result.files_changed}\n"
            f"tokens_in={result.tokens_in} tokens_out={result.tokens_out} "
            f"cost_usd=${result.cost_usd:.4f}\n"
            f"error={result.error}",
            title="run result",
            style=color,
        )
    )
    if result.summary:
        console.print(Panel(result.summary, title="summary"))

    raise typer.Exit(code=0 if (result.success or dry_run) else 1)


# --------------------------------------------------------------------------- #
# Phase-1 commands
# --------------------------------------------------------------------------- #


def _ensure_github_client() -> Any:
    """Construct a ``pygithub.Github`` client. Fails with a clear message if no token.

    Token precedence: ``GITHUB_TOKEN`` env > ``GH_TOKEN`` env > ``gh auth token``.
    The ``gh`` CLI fallback means an operator who has run ``gh auth login`` once
    does not need to also paste the token into ``.env``.

    Delegates the actual construction to ``factory.providers.github.build_github_client``
    (the shared, non-CLI helper) so other callers — e.g. the deploy chain's
    issue-closing bookkeeping — get the same client without importing this
    CLI module.
    """
    from factory.providers.github import build_github_client

    client = build_github_client()
    if client is None:
        console.print(
            "[red]error:[/red] no GitHub token available. Either set "
            "[bold]GITHUB_TOKEN[/bold] (or [bold]GH_TOKEN[/bold]) in the "
            "environment / .env, or run [bold]gh auth login[/bold] so "
            "[bold]gh auth token[/bold] returns one."
        )
        raise typer.Exit(code=2)
    return client


def _has_any_llm_provider_key() -> tuple[bool, str]:
    """Return ``(has_key, hint)`` describing whether SOME LLM provider is usable.

    The pre-check that used to look for ``DEEPSEEK_API_KEY`` / ``ANTHROPIC_API_KEY``
    predates Azure being the default provider. With ``default_provider: azure``
    the relevant env vars are ``AZURE_API_KEY`` (Azure-OpenAI) or
    ``AZURE_AI_API_KEY`` / ``AZURE_FOUNDRY_API_KEY`` (Foundry). Accept any of
    them — the runner picks the right key per model via ``_provider_env_key``.

    The hint string is shown to the operator on failure.
    """
    candidates = (
        "DEEPSEEK_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "AZURE_API_KEY",
        "AZURE_AI_API_KEY",
        "AZURE_FOUNDRY_API_KEY",
    )
    for name in candidates:
        if os.environ.get(name):
            return True, ""
    hint = (
        "set one of "
        + ", ".join(f"[bold]{n}[/bold]" for n in candidates)
        + " in .env. Pass [bold]--dry-run[/bold] for offline mode."
    )
    return False, hint


@app.command("new-direction")
def new_direction(
    app_name: str = typer.Option(..., "--app", help="App name (under apps/<name>/)"),
) -> None:
    """Interactive direction creation. Walks the user through the prompts."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.directions.creator import run_interactive

    created = run_interactive(app=app_name, software_factory_root=_FACTORY_ROOT)
    console.print(f"\n[bold green]Direction created:[/bold green] {created.dir_path}")


@app.command("tell")
def tell(
    app_name: str = typer.Option(..., "--app", help="App name (under apps/<name>/)"),
    text: str = typer.Argument(..., help='Direction text (e.g. "fix the broken submit button").'),
) -> None:
    """Append a prose-only direction (no flow/api_spec). PM will likely flag needs-direction."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.directions.creator import create_direction

    title = text.strip().split("\n", 1)[0][:80]
    created = create_direction(
        app=app_name,
        title=title,
        type_tag=None,
        why=text.strip(),
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=False,
        attach_files=None,
        software_factory_root=_FACTORY_ROOT,
        source="cli-tell",
    )
    console.print(
        Panel.fit(
            f"Captured at [bold]{created.dir_path}[/bold].\n"
            "Backpressure is intentionally thin — PM will likely flag this as "
            "[bold]needs-direction[/bold] on the next pm-sync.",
            title="tell",
            style="yellow",
        )
    )


@app.command("edit-direction")
def edit_direction(
    app_name: str = typer.Option(..., "--app", help="App name"),
    id_or_slug: str = typer.Argument(..., help="Direction id (e.g. 003) or slug or 'id-slug'"),
) -> None:
    """Open the direction's ``direction.md`` in ``$EDITOR``."""
    directions_dir = _FACTORY_ROOT / "apps" / app_name / "directions"
    if not directions_dir.exists():
        console.print(f"[red]error:[/red] no directions/ for app {app_name!r}")
        raise typer.Exit(code=2)

    target: Path | None = None
    candidates = [p for p in directions_dir.iterdir() if p.is_dir()]
    for c in candidates:
        if (
            c.name == id_or_slug
            or c.name.startswith(f"{id_or_slug}-")
            or c.name.endswith(f"-{id_or_slug}")
        ):
            target = c
            break
    if target is None:
        console.print(f"[red]error:[/red] no direction matched {id_or_slug!r}")
        raise typer.Exit(code=2)

    direction_md = target / "direction.md"
    if not direction_md.exists():
        console.print(f"[red]error:[/red] {direction_md} missing")
        raise typer.Exit(code=2)

    editor = os.environ.get("EDITOR", "vi")
    try:
        subprocess.run([editor, str(direction_md)], check=False)
    except FileNotFoundError:
        console.print(f"[red]error:[/red] editor {editor!r} not found")
        raise typer.Exit(code=2) from None

    console.print("\n[bold]Directory contents:[/bold]")
    for p in sorted(target.iterdir()):
        console.print(f"  - {p.name}")


def _resolve_direction_dir(app_name: str, id_or_slug: str) -> Path | None:
    """Find one direction directory for ``app_name`` by id, slug or id-slug."""
    directions_dir = _FACTORY_ROOT / "apps" / app_name / "directions"
    if not directions_dir.exists():
        return None
    for c in sorted(p for p in directions_dir.iterdir() if p.is_dir()):
        if (
            c.name == id_or_slug
            or c.name.startswith(f"{id_or_slug}-")
            or c.name.endswith(f"-{id_or_slug}")
        ):
            return c
    return None


def _awaiting_approval_rows(apps: list[str]) -> list[tuple[str, str, str, str, str]]:
    """``(app, dir_name, title, reason, shipped_routes)`` for every direction parked
    at the operator-approval gate. Shared by ``inbox`` and ``approve-direction``.

    ``shipped_routes`` answers the question that decides whether approving costs
    money for nothing: does this direction ask for a route the app already has?
    It is derived from ``apps/<app>/derived/api_surface.json``, never from prose.
    """
    from factory.directions.approval import approval_blocked_reason, awaiting_operator_approval
    from factory.directions.parser import list_direction_dirs, parse_direction_dir
    from factory.directions.route_premise import check_direction_route_premises
    from factory.directions.watcher import _engine, hydrate_direction_source

    state_db = _FACTORY_ROOT / "state" / "factory.db"
    # One engine for the whole listing: ``_engine`` runs ``migrate`` every call,
    # so building one per direction would be O(directions) redundant migrations.
    engine = _engine(state_db) if state_db.exists() else None
    rows: list[tuple[str, str, str, str, str]] = []
    for a in apps:
        for ddir in list_direction_dirs(a, _FACTORY_ROOT):
            try:
                d = parse_direction_dir(a, ddir)
            except Exception:  # noqa: BLE001 - a malformed sibling must not hide the rest
                continue
            # Resolve ``source`` DB-first, exactly as the pm-sync gate does —
            # otherwise this listing and the gate could disagree about which
            # directions are parked.
            hydrate_direction_source(d, state_db, engine=engine)
            if not awaiting_operator_approval(d):
                continue
            claims = check_direction_route_premises(d, _FACTORY_ROOT)
            if claims is None:
                shipped = "(no route table)"
            elif claims:
                shipped = f"[red]{len(claims)} ALREADY EXIST[/red]"
            else:
                shipped = "-"
            rows.append((a, ddir.name, d.title[:60], approval_blocked_reason(d), shipped))
    return rows


@app.command("approve-direction")
def approve_direction_cmd(
    id_or_slug: str | None = typer.Argument(
        None, help="Direction id (e.g. 015), slug, or 'id-slug'. Omit to LIST what is pending."
    ),
    app_name: str | None = typer.Option(None, "--app", help="App name; required to approve"),
    note: str | None = typer.Option(None, "--note", help="Why you approved (stored in state.yaml)"),
    reject: bool = typer.Option(
        False, "--reject", help="Close the direction instead of approving it"
    ),
    by: str | None = typer.Option(
        None, "--by", help="Who approved (default: $USER / 'operator')"
    ),
    acknowledge_shipped_routes: bool = typer.Option(
        False,
        "--acknowledge-shipped-routes",
        help="Approve even though the app's derived route table already has the "
        "routes this direction asks for (recorded in state.yaml).",
    ),
) -> None:
    """Approve (or --reject) a MACHINE-FILED direction so the chain may build it.

    Directions the factory filed for itself — every ``scheduled-<persona>``
    source (security, ux_auditor), any other machine filer,
    and any direction whose source cannot be determined — are NOT auto-triaged
    into stories. They park until an operator approves them here. Run with no
    arguments to list everything waiting (also shown by ``factory inbox``).

    Operator-filed directions never need this: they auto-triage as always.
    """
    from factory.directions.approval import (
        approval_blocked_reason,
        approve_direction,
        awaiting_operator_approval,
        requires_operator_approval,
    )
    from factory.directions.parser import parse_direction_dir

    apps = [app_name] if app_name else _list_apps()

    if id_or_slug is None:
        rows = _awaiting_approval_rows(apps)
        if not rows:
            console.print("[dim]No directions awaiting operator approval.[/dim]")
            return
        table = Table(title="directions awaiting operator approval")
        table.add_column("app")
        table.add_column("direction")
        table.add_column("title")
        table.add_column("why parked")
        table.add_column("routes it asks for")
        for row in rows:
            table.add_row(*row)
        console.print(table)
        console.print(
            "[dim]Approve with:[/dim] factory approve-direction <id> --app <app>   "
            "[dim]Reject with:[/dim] --reject"
        )
        return

    if app_name is None:
        console.print("[red]error:[/red] --app is required when naming a direction")
        raise typer.Exit(code=2)

    target = _resolve_direction_dir(app_name, id_or_slug)
    if target is None:
        console.print(f"[red]error:[/red] no direction matched {id_or_slug!r} in app {app_name!r}")
        raise typer.Exit(code=2)

    try:
        direction = parse_direction_dir(app_name, target, software_factory_root=_FACTORY_ROOT)
    except Exception as exc:  # noqa: BLE001 - surface the parse failure, don't traceback
        console.print(f"[red]error:[/red] cannot parse {target}: {exc!r}")
        raise typer.Exit(code=2) from None

    # Same DB-first ``source`` resolution the pm-sync gate uses, so this command
    # never disagrees with the gate about whether approval is even needed.
    from factory.directions.watcher import hydrate_direction_source

    hydrate_direction_source(direction, _FACTORY_ROOT / "state" / "factory.db")

    if reject:
        from factory.directions.watcher import mark_direction_status

        mark_direction_status(
            direction,
            "closed",
            by=(by or os.environ.get("USER") or "operator"),
            details={"reason": "operator-rejected-at-approval-gate"},
        )
        console.print(
            Panel.fit(
                f"[bold]{target.name}[/bold] closed (operator rejected).\n"
                "It will never be triaged into stories.",
                title="rejected",
                style="yellow",
            )
        )
        return

    if not requires_operator_approval(direction):
        console.print(
            f"[yellow]note:[/yellow] {target.name} is operator/human-filed "
            "(source is on the auto-build allowlist) — it does not need approval."
        )
        return

    if not awaiting_operator_approval(direction):
        console.print(
            f"[yellow]note:[/yellow] {target.name} is already approved or past the "
            f"gate (status={direction.status})."
        )
        return

    # Premise check against the app's REAL route table, before any spend. A
    # scheduled persona reads prose context docs and cannot verify a single claim
    # in them; one stale "no password reset flow" bullet re-filed shipped work
    # five times, and five more directions landed on 2026-08-10. Approving a
    # re-file spends a whole chain run rebuilding what is already deployed.
    from factory.directions.route_premise import (
        check_direction_route_premises,
        surface_provenance,
    )

    claims = check_direction_route_premises(direction, _FACTORY_ROOT)
    acknowledged: list[str] = []
    if claims is None:
        console.print(
            f"[yellow]note:[/yellow] app {app_name!r} ships no "
            f"apps/{app_name}/derived/api_surface.json — the already-shipped-route "
            "check did NOT run. Verify the direction's premises by hand."
        )
    elif claims:
        acknowledged = [c.route for c in claims]
        if not acknowledge_shipped_routes:
            claim_table = Table(title=f"{target.name} asks for routes that ALREADY EXIST")
            claim_table.add_column("existing route")
            claim_table.add_column("matched in the direction")
            claim_table.add_column("how")
            for claim in claims:
                claim_table.add_row(claim.route, ", ".join(claim.matched), claim.kind)
            console.print(claim_table)
            console.print(
                f"[dim]source:[/dim] apps/{app_name}/derived/api_surface.json "
                f"({surface_provenance(app_name, _FACTORY_ROOT)})"
            )
            console.print(
                "[red]refusing to approve.[/red] An existing route can still hide a "
                "real gap (a handler that returns 202 and does nothing is one), so "
                "read the handler, not the context doc.\n"
                "[dim]If the finding is real, re-run with[/dim] "
                "--acknowledge-shipped-routes --note '<what is actually missing "
                "behind the route>'   [dim]If it is a re-file, use[/dim] "
                "--reject --note '<evidence>'\n"
                "[dim]And fix the context doc that produced the premise, or it "
                "re-files next cycle.[/dim]"
            )
            raise typer.Exit(code=3)

    reason = approval_blocked_reason(direction)
    record = approve_direction(
        direction,
        by=(by or os.environ.get("USER") or "operator"),
        note=note,
        acknowledged_shipped_routes=acknowledged if acknowledge_shipped_routes else None,
    )
    console.print(
        Panel.fit(
            f"[bold]{target.name}[/bold] approved by "
            f"[bold]{record['approved_by']}[/bold]\n"
            f"was parked because: {reason}\n"
            "The next pm-sync / tick will triage it into stories.",
            title="approved",
            style="green",
        )
    )


@app.command("acceptance-waive")
def acceptance_waive_cmd(
    story_id: int | None = typer.Argument(
        None, help="Story id. Omit to LIST every acceptance oracle awaiting a human."
    ),
    app_name: str | None = typer.Option(None, "--app", help="App name; required to waive"),
    reason: str | None = typer.Option(
        None, "--reason", help="Why this story may merge without an oracle verification"
    ),
    clear: bool = typer.Option(False, "--clear", help="Remove an existing waiver"),
    by: str | None = typer.Option(None, "--by", help="Who decided (default: $USER)"),
) -> None:
    """Record an OPERATOR DECISION that an un-gradeable acceptance oracle may pass.

    The ``acceptance-verified`` gate credits a green at HEAD only when the same
    oracle was RED at the merge base. Two states are nobody's fault and cannot be
    graded — the oracle already passes at the base (a tautological oracle and a
    criterion a sibling story already satisfied look identical from outside), and a
    base run that cannot be trusted. Both BLOCK, which is correct and also a
    permanent wedge; this is the path back.

    A waiver is NOT a verification: the gate passes the story with
    ``verified=False``, ``authoritative=False`` and the waiver's reason in the
    result. It is scoped to the oracle's CONTENT, so re-authoring invalidates it,
    and it can never clear a real failure, tampered output, or a checkout that is
    not the merge candidate.
    """
    from factory.chain.acceptance import (
        acceptance_dir,
        clear_waiver,
        oracle_sha256,
        pending_acceptance_attention,
        write_waiver,
    )
    from factory.chain.handlers import get_story

    apps = [app_name] if app_name else _list_apps()

    if story_id is None:
        rows: list[dict[str, object]] = []
        for a in apps:
            rows.extend(pending_acceptance_attention(_FACTORY_ROOT, a))
        if not rows:
            console.print("[dim]No acceptance oracles awaiting a human.[/dim]")
            return
        table = Table(title="acceptance oracle (needs a human)")
        for col in ("app", "story", "kind", "why"):
            table.add_column(col)
        for row in rows:
            table.add_row(
                str(row.get("app")), str(row.get("story_id")),
                str(row.get("kind")), str(row.get("reason"))[:80],
            )
        console.print(table)
        console.print(
            "[dim]waive with:[/dim] factory acceptance-waive <story-id> --app <app> "
            "--reason '...'"
        )
        return

    if app_name is None:
        console.print("[red]error:[/red] --app is required when naming a story")
        raise typer.Exit(code=2)

    if clear:
        removed = clear_waiver(_FACTORY_ROOT, app_name, story_id)
        console.print(
            f"waiver for story {story_id} ({app_name}): "
            + ("[green]cleared[/green]" if removed else "[dim]none found[/dim]")
        )
        return

    if not reason or not reason.strip():
        console.print("[red]error:[/red] --reason is required (a waiver is a recorded decision)")
        raise typer.Exit(code=2)

    story = get_story(story_id, _FACTORY_ROOT / "state" / "factory.db")
    if story is None or story.app != app_name:
        console.print(f"[red]error:[/red] no story {story_id} in app {app_name!r}")
        raise typer.Exit(code=2)
    stored = acceptance_dir(_FACTORY_ROOT, app_name, story_id) / "test_acceptance.py"
    if not stored.is_file():
        console.print(
            f"[red]error:[/red] story {story_id} has no stored oracle at {stored} — "
            "there is nothing to waive (the gate is blocking for a different reason)"
        )
        raise typer.Exit(code=2)

    path = write_waiver(
        _FACTORY_ROOT, app_name, story_id,
        oracle_sha=oracle_sha256(stored.read_text(encoding="utf-8", errors="replace")),
        reason=reason,
        operator=(by or os.environ.get("USER") or "operator"),
    )
    console.print(
        Panel.fit(
            f"story [bold]{story_id}[/bold] ({app_name}) may merge WITHOUT an oracle "
            f"verification.\nreason: {reason.strip()}\nrecorded at: {path}\n"
            "This is not a verification — the gate will say so in its result, and the "
            "waiver dies if the oracle is re-authored.",
            title="acceptance waiver",
            style="yellow",
        )
    )


@app.command("directions-backfill")
def directions_backfill_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(True, "--dry-run/--real-run", help="Dry-run (default)"),
) -> None:
    """Import on-disk directions into the ``directions`` table.

    Dry-run is the default — reports what would be imported without writing.
    Use ``--real-run`` to perform the actual import.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.directions.backfill import directions_backfill

    state_db = _FACTORY_ROOT / "state" / "factory.db"
    result = directions_backfill(
        app_name,
        _FACTORY_ROOT,
        state_db,
        dry_run=dry_run,
    )

    mode_label = "[yellow]DRY-RUN[/yellow]" if dry_run else "[green]REAL RUN[/green]"
    body = (
        f"imported={result.imported} skipped={result.skipped} "
        f"source-healed={result.source_healed}\nmode={mode_label}"
    )
    if result.source_healed:
        body += (
            f"\n[green]{result.source_healed} existing row(s) gained a `source` from disk — "
            "those directions keep their auto-build/park verdict across a "
            "`directions-regenerate-state` round trip.[/green]"
        )
    console.print(Panel.fit(body, title=f"directions-backfill — app={app_name}"))


@app.command("write-contract")
def write_contract_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    direction_id: str = typer.Option(..., "--direction", help="Direction id, e.g. 117"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Print the contract without writing api_spec.md"
    ),
    force: bool = typer.Option(
        False, "--force", help="Overwrite an existing api_spec.md"
    ),
) -> None:
    """Author a direction's ``api_spec.md`` — the contract dev and the oracle share.

    The acceptance oracle is dev-blind (019 AC3): its only spec inputs are the
    direction's acceptance criteria and its ``flow.md`` / ``api_spec.md``. When a
    direction names no routes, the grader must either guess (an oracle that 404s
    at HEAD however correct the code is) or decline to test (a vacuous oracle).
    Both block. This writes the missing contract from the criteria plus the app's
    REAL route table, parsed from source rather than recalled by a model.

    Also reports a GRADEABILITY verdict: a criterion the author cannot make
    observable over HTTP proves the direction is unbuildable as written, for a
    few cents, before any story spawns.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.app_config import load_app_config, resolve_app_repo_path
    from factory.chain.contract import author_contract, write_contract
    from factory.directions.parser import list_direction_dirs, parse_direction_dir
    from factory.model_router import max_output_tokens_for, route
    from factory.runner import text_run

    direction = None
    for d in list_direction_dirs(app_name, _FACTORY_ROOT):
        parsed = parse_direction_dir(app_name, d, software_factory_root=_FACTORY_ROOT)
        if (parsed.id or "") == direction_id:
            direction = parsed
            break
    if direction is None:
        console.print(f"[red]no direction {direction_id!r} under app {app_name!r}[/red]")
        raise typer.Exit(code=1)

    target = direction.dir_path / "api_spec.md"
    if target.exists() and target.stat().st_size > 0 and not (force or dry_run):
        console.print(
            f"[yellow]{target} already exists.[/yellow] Re-run with --force to overwrite, "
            "or --dry-run to preview."
        )
        raise typer.Exit(code=1)

    app_config = load_app_config(app_name, _FACTORY_ROOT)
    repo = resolve_app_repo_path(app_config, _FACTORY_ROOT)
    hint = getattr(app_config.gates, "acceptance_harness_hint", "") or ""
    model_id = route("contract")

    result = author_contract(
        direction=direction,
        app_repo_path=Path(repo),
        harness_hint=hint,
        text_run=text_run,
        model_id=model_id,
        app=app_name,
        max_tokens=max_output_tokens_for(model_id),
        db_path=_FACTORY_ROOT / "state" / "factory.db",
    )

    if dry_run:
        console.print(result.markdown)
    else:
        written = write_contract(direction.dir_path, result.markdown)
        console.print(f"[green]wrote[/green] {written}")

    if result.gradeable:
        console.print(
            Panel.fit(
                f"[green]GRADEABLE[/green] — {len(result.oracle_criteria)} criterion(s) graded "
                f"by the acceptance oracle over HTTP; {len(result.other_gate_criteria)} "
                "verified by the implementation's own test suite.",
                title=f"contract — {app_name}/{direction_id} — model={model_id}",
            )
        )
    else:
        console.print(
            Panel.fit(
                "[red]NOT GRADEABLE[/red] — this direction cannot be verified as written:\n\n"
                + "\n".join(f"  - {c}" for c in result.ungradeable_criteria)
                + "\n\n[yellow]Fix the direction (or accept an observability "
                "affordance) before building it.[/yellow]",
                title=f"contract — {app_name}/{direction_id} — model={model_id}",
            )
        )


@app.command("directions-regenerate-state")
def directions_regenerate_state_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Report what would be written without touching disk"
    ),
) -> None:
    """Rebuild missing ``state.yaml`` projections from the ``directions`` table.

    ``state.yaml`` is gitignored machine-written state (direction 018), so a
    fresh clone has ``direction.md`` but no projection. This writes one per
    direction that is missing it, from its authoritative database row.

    Existing files are never overwritten, so this is a no-op — and produces no
    git diff — on a tree that already has its projections. The inverse command
    is ``factory directions-backfill`` (on-disk direction → database row).
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.directions.backfill import regenerate_state_files

    state_db = _FACTORY_ROOT / "state" / "factory.db"
    result = regenerate_state_files(
        app_name,
        _FACTORY_ROOT,
        state_db,
        dry_run=dry_run,
    )

    mode_label = "[yellow]DRY-RUN[/yellow]" if dry_run else "[green]WROTE[/green]"
    body = (
        f"written={result.written} already-present={result.present} "
        f"no-db-row={result.no_row}\nmode={mode_label}"
    )
    if result.no_row:
        body += (
            f"\n[yellow]{result.no_row} direction(s) have no database row — run "
            f"`factory directions-backfill --app {app_name} --real-run` first.[/yellow]"
        )
    if result.no_source:
        # The outage this command caused, made loud. A regenerated direction with
        # no recorded source PARKS at the operator-approval gate, so the operator
        # must hear about it here rather than discover a silently idle factory.
        body += (
            f"\n[red]{result.no_source} regenerated direction(s) have NO recorded "
            "`source` and will PARK at the operator-approval gate (fail-safe: an "
            "unprovable source is treated as machine-filed).[/red]\n"
            f"[yellow]Fix:[/yellow] run `factory directions-backfill --app {app_name} "
            "--real-run` BEFORE deleting state.yaml to heal `source` from disk, or "
            "approve them with `factory approve-direction <id> --app "
            f"{app_name}`."
        )
    console.print(Panel.fit(body, title=f"directions-regenerate-state — app={app_name}"))


@app.command("directions-backfill-tracker-issue")
def directions_backfill_tracker_issue_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(True, "--dry-run/--real-run", help="Dry-run (default)"),
) -> None:
    """Find + persist a direction's tracker-issue number from GitHub when missing.

    ``resolve_tracker_issue`` only has two sources for a direction's tracker
    number (the ``directions`` row, then ``state.yaml``) — both are populated
    by ``open_or_update_tracker_issue`` the first time it creates the issue.
    A direction whose tracker/stories were created OUTSIDE that path (e.g. a
    hand-managed infra direction) has no source to resolve from, ever, even
    though a real tracker issue exists on GitHub — so `reconcile-issues` can
    never find it to close. This searches every issue in the app's repo for
    the exact ``**Direction:** `id-slug` `` marker every tracker body embeds,
    and persists an unambiguous match to the `directions` row.

    Dry-run is the default — reports what would be persisted without writing.
    Use ``--real-run`` to perform the actual write.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.app_config import load_app_config
    from factory.directions.tracker_backfill import backfill_tracker_issues

    app_config = load_app_config(app_name, _FACTORY_ROOT)
    github_client = _ensure_github_client()

    result = backfill_tracker_issues(
        app_config,
        github_client,
        software_factory_root=_FACTORY_ROOT,
        dry_run=dry_run,
    )

    mode_label = "[yellow]DRY-RUN[/yellow]" if dry_run else "[green]REAL RUN[/green]"
    body = (
        f"found={len(result.found)} already-set={result.already_set} "
        f"not-found={len(result.not_found)} ambiguous={len(result.ambiguous)}\n"
        f"mode={mode_label}"
    )
    console.print(Panel.fit(body, title=f"directions-backfill-tracker-issue — app={app_name}"))

    if result.found:
        verb = "would persist" if dry_run else "persisted"
        for direction_id, number in result.found:
            console.print(f"  [green]{verb}[/green] {direction_id} -> #{number}")
    if result.ambiguous:
        console.print("[yellow]ambiguous (skipped, resolve by hand):[/yellow]")
        for direction_id, numbers in result.ambiguous:
            console.print(f"  - {direction_id}: {numbers}")
    if result.errors:
        console.print("[red]errors:[/red]")
        for key, msg in result.errors:
            console.print(f"  - {key}: {msg}")
        raise typer.Exit(code=1)


@app.command("pm-sync")
def pm_sync_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Skip LLM + GitHub calls"),
) -> None:
    """Run the PM-sync pipeline for ``--app``. Validates pending directions."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.chain.pm_sync import pm_sync

    github_client: Any = None
    if not dry_run:
        # Verify SOME provider key is set; the runner picks the right one per
        # model. With ``default_provider: azure``, AZURE_API_KEY is the usual
        # answer; legacy direct-provider runs still accept DEEPSEEK / ANTHROPIC.
        ok, hint = _has_any_llm_provider_key()
        if not ok:
            console.print("[red]error:[/red] real pm-sync requires an LLM provider key. " + hint)
            raise typer.Exit(code=2)
        github_client = _ensure_github_client()

    summary = pm_sync(
        app=app_name,
        software_factory_root=_FACTORY_ROOT,
        dry_run=dry_run,
        github_client=github_client,
    )

    table = Table(title=f"pm-sync — app={app_name} dry_run={dry_run}")
    table.add_column("metric")
    table.add_column("value", justify="right")
    table.add_row("processed", str(summary.processed))
    table.add_row("validated", str(summary.validated))
    table.add_row("needs_direction", str(summary.needs_direction))
    table.add_row("awaiting_approval", str(len(summary.awaiting_approval)))
    table.add_row("errors", str(len(summary.errors)))
    console.print(table)
    if summary.awaiting_approval:
        console.print(
            "[yellow]parked — machine-filed, needs operator approval:[/yellow]"
        )
        for did, reason in summary.awaiting_approval:
            console.print(f"  - {did}: {reason}")
        console.print(
            "[dim]approve with:[/dim] factory approve-direction <id> "
            f"--app {app_name}   [dim](or --reject)[/dim]"
        )
    if summary.errors:
        console.print("[red]errors:[/red]")
        for did, msg in summary.errors:
            console.print(f"  - {did}: {msg}")
        raise typer.Exit(code=1)


@app.command("reconcile-issues")
def reconcile_issues_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Report what would close; make no GitHub changes"
    ),
) -> None:
    """Close GitHub issues left open for completed OR closed work (idempotent).

    A detect-and-remediate safety net for two leaks:

      * the event-driven close on deploy can no-op (e.g. an async ``--auto``
        merge with no token in scope), leaving *completed* work with open
        trackers / story issues;
      * a direction closed with no GitHub client in scope (an operator closing
        it by hand) leaves its tracker AND every child story issue open — those
        children are usually parked in a non-resolved state, so the
        completed-work predicate can never reach them.

    This sweeps and closes both. Safe to re-run; an already-closed issue is
    never touched.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.app_config import load_app_config
    from factory.directions.tracker_issue import reconcile_completed_issues

    app_config = load_app_config(app_name, _FACTORY_ROOT)
    github_client = _ensure_github_client()

    report = reconcile_completed_issues(
        app_config,
        github_client,
        software_factory_root=_FACTORY_ROOT,
        dry_run=dry_run,
    )

    table = Table(title=f"reconcile-issues — app={app_name} dry_run={dry_run}")
    table.add_column("action")
    table.add_column("count", justify="right")
    if dry_run:
        table.add_row("would_close", str(len(report["would_close"])))
    else:
        table.add_row("trackers_closed", str(len(report["trackers_closed"])))
        table.add_row("stories_closed", str(len(report["stories_closed"])))
    table.add_row("errors", str(len(report["errors"])))
    console.print(table)

    if dry_run:
        for kind, number, key in report["would_close"]:
            console.print(f"  [yellow]would close[/yellow] {kind} #{number} ({key})")
    else:
        for did, number in report["trackers_closed"]:
            console.print(f"  [green]closed tracker[/green] #{number} (D{did})")
        for sid, number in report["stories_closed"]:
            console.print(f"  [green]closed story[/green] #{number} (story {sid})")
    if report["errors"]:
        console.print("[red]errors:[/red]")
        for kind, number, msg in report["errors"]:
            console.print(f"  - {kind} #{number}: {msg}")
        raise typer.Exit(code=1)


@app.command("ingest-issue")
def ingest_issue(
    app_name: str = typer.Option(..., "--app", help="App name"),
    issue_number: int = typer.Argument(..., help="GitHub issue number to ingest"),
) -> None:
    """Manually ingest a GitHub direction issue into a local direction dir."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.directions.ingester import ingest_github_direction_issue

    github_client = _ensure_github_client()
    direction = ingest_github_direction_issue(
        issue_number=issue_number,
        app=app_name,
        software_factory_root=_FACTORY_ROOT,
        github_client=github_client,
    )
    console.print(
        Panel.fit(
            f"Ingested issue [bold]#{issue_number}[/bold] → [bold]{direction.dir_path}[/bold]",
            title="ingest-issue",
            style="green",
        )
    )


# --------------------------------------------------------------------------- #
# Phase-2 commands: tick (drive the chain forward), story (inspect),
# webhook-serve (boot the FastAPI receiver).
# --------------------------------------------------------------------------- #


@app.command("tick")
def tick_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No LLM/GitHub/repo writes"),
) -> None:
    """Drive every in-flight story for ``--app`` one tick forward."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.chain.orchestrator import tick

    if not dry_run:
        ok, hint = _has_any_llm_provider_key()
        if not ok:
            console.print("[red]error:[/red] real tick requires an LLM provider key. " + hint)
            raise typer.Exit(code=2)

    # Phase 8 (Phase 7 reviewer note): check halt state BEFORE the
    # scheduled personas block so a halted factory exits cleanly without
    # burning LLM calls.
    try:
        from factory.manager.halt import get_halt_state as _get_halt_state
        from factory.manager.halt import is_halted as _is_halted

        if _is_halted(root=_FACTORY_ROOT):
            halt_state = _get_halt_state(root=_FACTORY_ROOT) or {}
            console.print(
                Panel.fit(
                    f"[bold red]FACTORY HALTED[/bold red] — tick skipped.\n\n"
                    f"set_at:        {halt_state.get('set_at', '?')}\n"
                    f"concern_title: {halt_state.get('concern_title', '?')}\n"
                    f"reason:        {halt_state.get('reason', '?')}\n\n"
                    "Run [bold]factory resume[/bold] to clear the halt.",
                    title="tick (halted)",
                )
            )
            raise typer.Exit(code=0)
    except typer.Exit:
        raise
    except Exception as _halt_check_exc:  # noqa: BLE001
        # The halt module import or read failed — log visibly and continue.
        # Fail-open: a broken halt module must not silently disable all ticks,
        # but an operator MUST notice, so we print to stderr.
        import sys as _sys

        print(
            f"[tick] WARNING: halt-check raised an exception: {_halt_check_exc!r}; "
            "continuing with tick (fail-open). This may indicate a broken halt module.",
            file=_sys.stderr,
        )

    # Phase 6: drive the scheduler BEFORE the story chain so findings
    # filed by Ralph/etc become directions that this same tick can pick
    # up (PM-sync runs separately, but the next tick will spawn stories
    # from them).
    from factory.chain.scheduled_tasks import run_scheduled_persona
    from factory.scheduler.cron import due_schedules

    scheduled_results = []

    for due in due_schedules(_FACTORY_ROOT, audit_app=app_name):
        if due.rate_limit_hit:
            scheduled_results.append((due.schedule.name, "rate_limited", 0, 0))
            continue
        # ``factory_improver`` was retired 2026-08-07 (operator decision: 0
        # applied fixes in 196 proposals). Skip any stale entry an operator
        # may still have in their YAML.
        if due.schedule.persona == "factory_improver":
            continue
        out = run_scheduled_persona(
            due.schedule.persona,
            app_name,
            _FACTORY_ROOT,
            dry_run=dry_run,
        )
        scheduled_results.append(
            (due.schedule.name, out.status, out.findings_count, len(out.directions_filed))
        )

    # Idle -> generate work was deleted 2026-08-07 (019 AC5): the detector
    # fired ~957 times and generated zero human-visible outcomes, and
    # ``maybe_generate_idle_work`` rotated through scanner personas
    # (bug_hunter/ralph) that are themselves deleted in this same change.
    # Interim gap: ``factory/manager/detectors/stalled_stories.py`` reads
    # ``state/events/idle.ndjson`` for its ``app_idle`` / healthy_drain
    # suppression; with no writer left, stall findings lose that suppression
    # until 019 AC6 ships an idle->ping that re-emits ``app_idle``. That fails
    # toward MORE alarms (noise), never toward silently missing a real stall,
    # so it is the safe direction to fail in while AC6 is pending.

    # Auto intake: convert NEW user-filed GitHub issues (label ``user-report``)
    # into directions, so a user reporting a bug/feature flows all the way to a
    # PR with no operator step. Runs BEFORE auto_pm_sync so a freshly-ingested
    # direction is triaged into stories on this very tick.
    if not dry_run:
        from factory.chain.issue_intake import maybe_auto_intake

        try:
            intake_summary, intake_reason = maybe_auto_intake(
                app_name,
                _FACTORY_ROOT,
                dry_run=dry_run,
                github_client_factory=_ensure_github_client,
            )
            if intake_summary is not None:
                scheduled_results.append(
                    (
                        "auto_intake",
                        "ok"
                        if not intake_summary.errors
                        else f"errors:{len(intake_summary.errors)}",
                        len(intake_summary.accepted),
                        len(intake_summary.accepted),
                    )
                )
            elif intake_reason not in {"disabled", "dry_run", "no_client", "no_new_issues"}:
                scheduled_results.append(("auto_intake", intake_reason, 0, 0))
        except Exception as exc:  # noqa: BLE001 - never fail the tick on intake
            scheduled_results.append(("auto_intake", f"errored:{exc!r}"[:60], 0, 0))

    # Auto PM-sync: triage directions still in ``status: created`` /
    # ``needs-direction`` (filed by the scheduled personas above, or by
    # ``factory tell``) into stories, so the queue refills without an
    # operator remembering ``factory pm-sync``. Runs AFTER the scheduler so
    # directions filed this very tick are picked up immediately.
    from factory.chain.pm_sync import maybe_auto_pm_sync

    try:
        sync_summary, sync_reason = maybe_auto_pm_sync(
            app_name,
            _FACTORY_ROOT,
            dry_run=dry_run,
            github_client_factory=None if dry_run else _ensure_github_client,
        )
        if sync_summary is not None:
            scheduled_results.append(
                (
                    "auto_pm_sync",
                    "ok" if not sync_summary.errors else f"errors:{len(sync_summary.errors)}",
                    sync_summary.processed,
                    sync_summary.validated,
                )
            )
            if sync_summary.awaiting_approval:
                # Machine-filed directions parked at the operator-approval gate.
                # Never silent: the tick names them so the operator can approve
                # or reject with ``factory approve-direction``.
                scheduled_results.append(
                    (
                        "directions_awaiting_approval",
                        ", ".join(did for did, _ in sync_summary.awaiting_approval)[:60],
                        len(sync_summary.awaiting_approval),
                        0,
                    )
                )
        elif sync_reason not in {"disabled", "no_pending"}:
            scheduled_results.append(("auto_pm_sync", sync_reason, 0, 0))
    except Exception as exc:  # noqa: BLE001 - never fail the tick on triage
        scheduled_results.append(("auto_pm_sync", f"errored:{exc!r}"[:60], 0, 0))

    # WS1.2 acceptance-oracle self-heal. A story that is EXPECTED to have an
    # independent acceptance oracle but whose authoring flaked (transient LLM
    # error at spawn) blocks on the ``acceptance-verified`` gate. Re-author such
    # stories from the SPEC (still dev-blind) here, BEFORE the chain advances and
    # before merge evaluation, so the block is temporary — never a permanent
    # dead-end and never a silent pass. Never fails the tick.
    if not dry_run:
        try:
            from factory.chain.acceptance import reauthor_missing_oracles

            healed = reauthor_missing_oracles(app_name, _FACTORY_ROOT, dry_run=dry_run)
            if healed:
                scheduled_results.append(("acceptance_reauthor", "healed", healed, 0))
        except Exception as exc:  # noqa: BLE001 - never fail the tick on self-heal
            scheduled_results.append(("acceptance_reauthor", f"errored:{exc!r}"[:60], 0, 0))

    if scheduled_results:
        sched_table = Table(title="scheduled personas fired this tick")
        sched_table.add_column("schedule")
        sched_table.add_column("status")
        sched_table.add_column("findings")
        sched_table.add_column("directions")
        for name, status, fcount, dcount in scheduled_results:
            sched_table.add_row(name, status, str(fcount), str(dcount))
        console.print(sched_table)

    summary = tick(_FACTORY_ROOT, app_name, dry_run=dry_run)

    # After the story chain advances, drain any pending deploy queue
    # entries for this app. The deploy worker honors deploy-frozen mode
    # via the settings enforcer.
    from factory.deploy.orchestrator import drain_deploy_queue

    deploy_actions = drain_deploy_queue(
        app=app_name,
        software_factory_root=_FACTORY_ROOT,
        dry_run=dry_run,
    )
    if deploy_actions:
        dep_table = Table(title="deploy queue drained")
        dep_table.add_column("sha")
        dep_table.add_column("status")
        for a in deploy_actions:
            derived = (
                "deployed"
                if a.success
                else (
                    "rolled_back"
                    if a.rolled_back
                    else (
                        "skipped"
                        if a.error
                        and (
                            a.error in {"mode_blocks_deploy", "deploy_disabled_in_config"}
                            or a.error.startswith("mode_")
                        )
                        else "errored"
                    )
                )
            )
            dep_table.add_row(a.merged_sha[:12], derived)
        console.print(dep_table)

    if (
        not summary.handler_runs
        and not summary.errors
        and not summary.skipped
        and not summary.rejected
        # A tick that DEFERRED stories is not an empty queue — saying "No
        # in-flight stories" there is what hid the D018 deferral deadlock for
        # hours (2026-07-28). Fall through to the tables below instead.
        and not summary.deferred
        and not summary.merges
        and (summary.ci_health is None or summary.ci_health.state in ("unknown", "green"))
        and (
            summary.detector_watch is None
            or not (
                summary.detector_watch.filed
                or summary.detector_watch.errors
                or summary.detector_watch.firings_total
            )
        )
    ):
        console.print(
            Panel.fit(
                f"No in-flight stories for app=[bold]{app_name}[/bold]. "
                "Run [bold]factory pm-sync --app <app>[/bold] first to spawn stories.",
                title="tick",
            )
        )
        return

    table = Table(title=f"tick — app={app_name} dry_run={dry_run}")
    table.add_column("story")
    table.add_column("from")
    table.add_column("to")
    for slug, frm, to in summary.handler_runs:
        table.add_row(slug, frm, to)
    if summary.handler_runs:
        console.print(table)
    if summary.rejected:
        rej_table = Table(title="rejected by caps/mode")
        rej_table.add_column("story")
        rej_table.add_column("reason")
        for slug, reason in summary.rejected:
            rej_table.add_row(slug, reason)
        console.print(rej_table)
    if summary.deferred:
        def_table = Table(title="deferred by dependency ordering")
        def_table.add_column("story")
        def_table.add_column("waiting on")
        for slug, reason in summary.deferred:
            def_table.add_row(slug, reason)
        console.print(def_table)
    if summary.merges:
        merge_table = Table(title="auto-merge decisions this tick")
        merge_table.add_column("pr")
        merge_table.add_column("merged")
        merge_table.add_column("reason")
        merge_table.add_column("gates", justify="right")
        for m in summary.merges:
            merge_table.add_row(
                f"#{m.pr_number}",
                "[green]yes[/green]" if m.merged else "[red]no[/red]",
                m.reason[:80],
                str(len(m.gates_passed)),
            )
        console.print(merge_table)
    if summary.ci_health is not None and summary.ci_health.state not in ("unknown", "green"):
        console.print(
            f"ci-health: state={summary.ci_health.state} "
            f"filed={summary.ci_health.filed} "
            f"reason={summary.ci_health.reason!r}"
        )
    if summary.detector_watch is not None and (
        summary.detector_watch.filed or summary.detector_watch.errors or summary.detector_watch.firings_total
    ):
        dw = summary.detector_watch
        console.print(
            f"detector-watch: ran={len(dw.ran)} firings={dw.firings_total} "
            f"filed={len(dw.filed)} deduped={len(dw.deduped)} capped={len(dw.capped)} "
            f"errors={len(dw.errors)}"
        )
    if summary.issue_hygiene and (
        summary.issue_hygiene.get("trackers_closed") or summary.issue_hygiene.get("stories_closed")
    ):
        console.print(
            f"issue-hygiene: closed {summary.issue_hygiene['trackers_closed']} tracker(s) + "
            f"{summary.issue_hygiene['stories_closed']} story issue(s) (reconcile)"
        )
    if summary.recovery:
        _rec = summary.recovery
        console.print(
            f"recovery: recovered={len(_rec.get('recovered', []))} "
            f"escalated={len(_rec.get('escalated', []))} "
            f"skipped_cooldown={len(_rec.get('skipped_cooldown', []))} "
            f"skipped_cap={len(_rec.get('skipped_cap', []))} "
            f"errors={len(_rec.get('errors', []))}"
        )
    if summary.poison_escalation:
        _pe = summary.poison_escalation
        console.print(
            f"poison-escalation: status={_pe.get('status')} "
            f"poisoned={len(_pe.get('poisoned', []))} "
            f"issue={_pe.get('issue_number')}"
        )
    console.print(
        f"advanced={summary.stories_advanced} "
        f"blocked_by_caps={summary.blocked_by_caps} "
        f"blocked={summary.stories_blocked} "
        f"deferred={len(summary.deferred)} "
        f"merges={sum(1 for m in summary.merges if m.merged)}/{len(summary.merges)} "
        f"skipped={len(summary.skipped)} "
        f"errors={len(summary.errors)}"
    )
    # Quarantined rows are NON-FATAL: surface them (yellow) but never fail the
    # tick exit code on them. Only real errors below drive exit(1). This is the
    # crash-loop fix — a poisoned/invalid-state row must not abort the tick.
    if summary.skipped:
        for slug, msg in summary.skipped:
            console.print(f"[yellow]  ~ {slug}: {msg}[/yellow]")
    if summary.errors:
        for slug, msg in summary.errors:
            console.print(f"[red]  - {slug}: {msg}[/red]")
        raise typer.Exit(code=1)


@app.command("story")
def story_cmd(
    story_id: int = typer.Argument(..., help="Story id (StoryRecord.id)"),
) -> None:
    """Show a story's current state + handler outputs."""
    from sqlmodel import Session, create_engine

    from factory.chain.state_machine import StoryRecord

    db = _FACTORY_ROOT / "state" / "factory.db"
    if not db.exists():
        console.print("[red]error:[/red] no state db; run pm-sync first")
        raise typer.Exit(code=2)
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        story = session.get(StoryRecord, story_id)
    if story is None:
        console.print(f"[red]error:[/red] no story with id={story_id}")
        raise typer.Exit(code=2)

    console.print(
        Panel.fit(
            f"id=[bold]{story.id}[/bold]  app=[bold]{story.app}[/bold]  "
            f"slug=[bold]{story.slug}[/bold]\n"
            f"state=[bold]{story.state}[/bold]  scope=[bold]{story.scope}[/bold]  "
            f"retries=[bold]{story.dev_retries}[/bold]  tier=[bold]{story.current_model_tier}[/bold]\n"
            f"branch={story.github_branch}  pr=#{story.github_pr_number}  "
            f"issue=#{story.github_issue_number}\n"
            f"story_file_path={story.story_file_path}\n"
            f"error={story.error}",
            title=f"story #{story.id}",
        )
    )


# --------------------------------------------------------------------------- #
# Phase-3 commands: inbox, queue, pause, resume, mode, budget, why,
# settings, spend.
# --------------------------------------------------------------------------- #


def _list_apps() -> list[str]:
    apps_dir = _FACTORY_ROOT / "apps"
    if not apps_dir.exists():
        return []
    return sorted(p.name for p in apps_dir.iterdir() if (p / "config.yaml").exists())


@app.command("inbox")
def inbox_cmd(
    app_name: str | None = typer.Option(
        None, "--app", help="Filter inbox to a single app; default: all apps"
    ),
    show_parked: bool = typer.Option(
        False,
        "--parked",
        help=(
            "Also list PARKED stories that `factory resume-story` can recover with "
            "their work intact. Off by default: these are recoverable work, not "
            "pending decisions, and most are historical."
        ),
    ),
) -> None:
    """Aggregate items needing human attention across apps.

    Phase 7: shows multi-app rollup of every signal an operator cares
    about — stories awaiting human action (``reviewer_requested_changes``,
    ``blocked_tests_need_clarification``, and any ``last_rejection_reason``),
    directions in ``needs-direction``, budget warnings, failed deploys
    in the last 24h, active Direction Trackers, recent scheduled persona
    runs, idle apps (the same predicate the ``factory-idle`` issue uses),
    and pinned ``factory-status`` issue numbers per app.
    """
    from sqlmodel import Session, create_engine, select

    from factory.chain.handlers import _engine
    from factory.chain.state_machine import StoryRecord, StoryState
    from factory.directions.parser import list_direction_dirs, parse_direction_dir
    from factory.settings.loader import load_settings
    from factory.settings.modes import get_mode
    from factory.settings.spend import today_spend_usd

    settings = load_settings(_FACTORY_ROOT)
    db = _FACTORY_ROOT / "state" / "factory.db"
    _engine(db)
    # Ensure deploy_actions table exists for the failed-deploys section
    # below; on a fresh checkout no deploys have run yet so SQLModel
    # never auto-created the table from the chain handlers' metadata.
    from factory.deploy.orchestrator import _engine as _deploy_engine

    _deploy_engine(db)
    # Phase 6/7 tables must exist for the scheduled-runs + idle +
    # factory-status sections below; their _engine() helpers run
    # create_all on first call.
    from factory.chain.factory_status import _engine as _status_engine
    from factory.chain.scheduled_tasks import _engine as _sched_engine

    _sched_engine(db)
    _status_engine(db)
    apps = [app_name] if app_name else _list_apps()
    eng = create_engine(f"sqlite:///{db}", echo=False)

    # E1 (stall visibility, BENCHMARK-READINESS-PLAN.md): story 172 once sat
    # 255 minutes in a *_in_progress state because the only stale-detector
    # (``orchestrator._prune_stale_in_progress``) runs INSIDE the tick, and no
    # tick was running. Both checks below are PURE READS — no mutation, no
    # dependency on a tick — so they work with the factory off, which is
    # exactly the situation that hid story 172.
    from datetime import UTC, datetime

    from factory.chain.orchestrator import _STALE_RECOVERY_MAP, _STALE_THRESHOLD_SECONDS
    from factory.chain.state_machine import is_terminal

    now_ts = datetime.now(UTC).timestamp()
    stale_table = Table(
        title=f"stale *_in_progress stories (no update for >{_STALE_THRESHOLD_SECONDS // 60} min)"
    )
    stale_table.add_column("app")
    stale_table.add_column("id")
    stale_table.add_column("slug")
    stale_table.add_column("state")
    stale_table.add_column("minutes stale")
    have_stale = False
    any_in_flight = False
    with Session(eng) as session:
        for a in apps:
            rows = session.exec(select(StoryRecord).where(StoryRecord.app == a)).all()
            for r in rows:
                try:
                    if not is_terminal(StoryState(r.state)):
                        any_in_flight = True
                except ValueError:
                    pass
                # ``_STALE_RECOVERY_MAP`` keys are exactly the six
                # ``*_in_progress`` states the prune pass would touch — reusing
                # its keys (rather than a second hardcoded state list) means
                # this table and the pass it previews can never drift apart.
                if r.state not in _STALE_RECOVERY_MAP:
                    continue
                try:
                    updated_iso = r.updated_at or r.created_at
                    updated_ts = datetime.fromisoformat(updated_iso).timestamp()
                except (TypeError, ValueError):
                    updated_ts = 0.0  # unparseable -> treat as ancient, same as the prune pass
                age_s = now_ts - updated_ts
                if age_s < _STALE_THRESHOLD_SECONDS:
                    continue
                stale_table.add_row(a, str(r.id), r.slug, r.state, f"{age_s / 60:.1f}")
                have_stale = True
    if have_stale:
        console.print(stale_table)
    else:
        console.print("[dim]No stale *_in_progress stories.[/dim]")

    # Loud top-of-inbox warning: stories in flight but nothing is running to
    # progress them. A non-terminal story making no progress while the
    # factory is off is easy to miss otherwise — direction trackers stayed
    # open the same way while the factory was OFF (see the section below).
    if any_in_flight:
        power_is_off, power_skip_note = _factory_power_is_off()
        if power_is_off:
            console.print(
                Panel.fit(
                    "[bold red]Stories are in flight but the factory is OFF[/bold red] — "
                    "nothing will progress them until 'factory on' runs.",
                    title="WARNING",
                )
            )
        elif power_skip_note:
            console.print(f"[dim]power check skipped: {power_skip_note}[/dim]")

    # Stories with last_rejection_reason or in BLOCKED state -> needs human.
    from factory.directions.tracker_issue import _story_is_resolved

    needs_human_table = Table(title="Needs human action (stories)")
    needs_human_table.add_column("app")
    needs_human_table.add_column("id")
    needs_human_table.add_column("slug")
    needs_human_table.add_column("state")
    needs_human_table.add_column("reason / blocker")
    have_needs = False
    with Session(eng) as session:
        for a in apps:
            rows = session.exec(select(StoryRecord).where(StoryRecord.app == a)).all()
            for r in rows:
                reason: str | None = None
                # A story in a RESOLVED terminal state never needs human action,
                # however much history it carries. This used to key off
                # ``last_rejection_reason`` alone, so every ``deployed`` /
                # ``superseded_by_sibling`` row that had ever been rejected stayed
                # in the operator's inbox forever (observed 2026-07-24: deployed
                # stories 63 and 75 listed under "Needs human action" alongside
                # genuinely-parked ones). Reuse the same resolved-states ALLOWLIST
                # the tracker-issue closer uses, so "the tracker closed" and "the
                # inbox is quiet" can never disagree.
                # The dependency-deferral CAP park is the one carve-out: it lands in
                # ``blocked_dependency_unmet`` but is awaiting a human DECISION, not
                # abandoned-for-good. ``_story_is_resolved`` (the tracker closer's
                # own predicate) encodes that carve-out, so this table and the
                # issue/tracker sweeps still cannot disagree — the reason the
                # allowlist is shared in the first place.
                #
                # SECOND carve-out (found 2026-08-07): ``blocked_ci_unresolved`` is
                # unconditionally on the resolved-states allowlist — correct for the
                # real-CI-failure park (``auto_merge._park``), which CLOSES the PR
                # first, so there is genuinely nothing left pending. The required-
                # gate-block park (``auto_merge._park_gate_block_exhausted``) reaches
                # the SAME state but leaves the PR OPEN and sets
                # ``last_rejection_reason`` specifically so a human can still act on
                # it — without this carve-out that story was parked and then
                # invisible, silently disagreeing with the point of parking it.
                gate_block_parked = (
                    r.state == StoryState.BLOCKED_CI_UNRESOLVED.value
                    and bool(r.last_rejection_reason)
                )
                if _story_is_resolved(r) and not gate_block_parked:
                    continue
                if r.last_rejection_reason:
                    reason = r.last_rejection_reason
                elif r.state in {
                    StoryState.DELIVERED_LOCAL.value,
                    StoryState.DELIVERED_BRANCH.value,
                    StoryState.DELIVERED_PR.value,
                }:
                    # Delivery level stopped short of merging: finished work a
                    # human must merge, push, or discard.
                    reason = f"delivered at level {r.delivery_level or '?'}; " + (
                        f"PR #{r.github_pr_number} awaits a human merge"
                        if r.github_pr_number
                        else f"branch {r.github_branch} awaits a human"
                    )
                elif r.state in {
                    "blocked_tests_need_clarification",
                    # Dev declared the story unsatisfiable as written. The whole
                    # point of the escape hatch is that a HUMAN reads the claim,
                    # so it has to surface here (the declared reason is on
                    # ``StoryRecord.error``, shown by ``factory why <id>``).
                    "blocked_underspecified",
                    "reviewer_requested_changes",
                }:
                    reason = r.state
                if reason:
                    needs_human_table.add_row(a, str(r.id), r.slug, r.state, reason)
                    have_needs = True
    if have_needs:
        console.print(needs_human_table)
    else:
        console.print("[dim]No stories awaiting human action.[/dim]")

    # needs-direction status from direction state.yaml.
    nd_table = Table(title="needs-direction (directions)")
    nd_table.add_column("app")
    nd_table.add_column("direction")
    nd_table.add_column("title")
    nd_table.add_column("missing")
    have_nd = False
    for a in apps:
        for ddir in list_direction_dirs(a, _FACTORY_ROOT):
            try:
                d = parse_direction_dir(a, ddir)
            except Exception:
                continue
            if d.status == "needs-direction":
                nd_table.add_row(
                    a, ddir.name, d.title[:60], ", ".join(d.state.get("missing") or [])
                )
                have_nd = True
    if have_nd:
        console.print(nd_table)
    else:
        console.print("[dim]No directions in needs-direction.[/dim]")

    # Machine-filed directions parked at the operator-approval gate. These are
    # NOT auto-triaged into stories (see factory.directions.approval): a
    # scheduled persona filing its own work orders is the treadmill that cost
    # ~$145 and 4 hand-closed PRs before the gate existed. They must be visible
    # here — a silently parked direction is a detect-without-remediate bug.
    approval_rows = _awaiting_approval_rows(apps)
    if approval_rows:
        appr_table = Table(title="awaiting operator approval (auto-filed directions)")
        appr_table.add_column("app")
        appr_table.add_column("direction")
        appr_table.add_column("title")
        appr_table.add_column("why parked")
        appr_table.add_column("routes it asks for")
        for appr_row in approval_rows:
            appr_table.add_row(*appr_row)
        console.print(appr_table)
        console.print(
            "[dim]approve/reject with:[/dim] factory approve-direction <id> --app <app> "
            "[dim](--reject to close)[/dim]"
        )

    # Acceptance oracles that only a human can move. A story blocked here sits at
    # ``pr_open`` with no ``last_rejection_reason`` and no blocked state, so before
    # this section it appeared in NO operator surface at all — the factory went
    # completely silent about a permanently-stuck story (authoring exhausted, or an
    # oracle that cannot discriminate the story's diff).
    from factory.chain.acceptance import pending_acceptance_attention

    acc_rows: list[dict[str, object]] = []
    for a in apps:
        try:
            acc_rows.extend(pending_acceptance_attention(_FACTORY_ROOT, a))
        except Exception:  # noqa: BLE001 - the inbox must never fail on one section
            continue
    if acc_rows:
        acc_table = Table(title="acceptance oracle (needs a human)")
        acc_table.add_column("app")
        acc_table.add_column("story")
        acc_table.add_column("kind")
        acc_table.add_column("why")
        for acc_row in acc_rows:
            acc_table.add_row(
                str(acc_row.get("app")), str(acc_row.get("story_id")),
                str(acc_row.get("kind")), str(acc_row.get("reason"))[:80],
            )
        console.print(acc_table)
        console.print(
            "[dim]fix the spec/harness, or record a decision with:[/dim] "
            "factory acceptance-waive <story-id> --app <app> --reason '...'"
        )

    # Budget warning.
    spend = today_spend_usd(_FACTORY_ROOT, db_path=db)
    cap = settings.caps.daily_spend_usd
    if cap > 0 and spend >= cap * 0.75:
        console.print(
            Panel.fit(
                f"[yellow]Budget warning:[/yellow] today's spend ${spend:.4f} >= 75% of "
                f"daily cap ${cap:.2f}",
                title="budget",
            )
        )

    # Failed deploys in the last 24h (status='errored' OR rolled_back).
    from datetime import UTC, datetime, timedelta

    from factory.deploy.models import DeployActionRecord

    cutoff = (datetime.now(UTC) - timedelta(hours=24)).isoformat()
    failed_dep_table = Table(title="failed deploys (last 24h)")
    failed_dep_table.add_column("app")
    failed_dep_table.add_column("sha")
    failed_dep_table.add_column("status")
    failed_dep_table.add_column("error")
    have_failed_dep = False
    with Session(eng) as session:
        for a in apps:
            dep_rows = session.exec(
                select(DeployActionRecord).where(
                    DeployActionRecord.app == a,
                    DeployActionRecord.status.in_(["errored", "rolled_back"]),  # type: ignore[attr-defined]
                    DeployActionRecord.ts >= cutoff,
                )
            ).all()
            for dr in dep_rows:
                failed_dep_table.add_row(a, dr.sha[:12], dr.status, (dr.error or "")[:60])
                have_failed_dep = True
    if have_failed_dep:
        console.print(failed_dep_table)
    else:
        console.print("[dim]No failed deploys in the last 24h.[/dim]")

    # Direction trackers awaiting action (status == 'pm-validated' but no
    # downstream story yet) — rough heuristic; full Phase 7 will be richer.
    trk_table = Table(title="active direction trackers")
    trk_table.add_column("app")
    trk_table.add_column("direction")
    trk_table.add_column("status")
    have_trk = False
    for a in apps:
        for ddir in list_direction_dirs(a, _FACTORY_ROOT):
            try:
                d = parse_direction_dir(a, ddir)
            except Exception:
                continue
            if d.status not in {"created", "needs-direction"}:
                trk_table.add_row(a, ddir.name, d.status)
                have_trk = True
    if have_trk:
        console.print(trk_table)

    # E1 (stall visibility): a direction's LOCAL status can reach a terminal
    # one (``closed`` — see ``factory.directions.schema.RESOLVED_DIRECTION_STATUSES``;
    # the vocabulary has no "rejected" status, only ``created`` / ``pm-validated``
    # / ``needs-direction`` / ``closed``) while its GitHub tracker issue stays
    # OPEN — the same "factory was off" gap that let stale ``*_in_progress``
    # story rows go unnoticed. The GitHub call is best-effort: on ANY error
    # (no token, network, a repo/issue lookup failure) this prints exactly one
    # skip note and moves on — it must never crash `inbox`, and must never
    # silently omit the section either.
    tracker_open_rows: list[tuple[str, str, str, str]] = []
    tracker_check_skip_note: str | None = None
    try:
        from factory.app_config import load_app_config
        from factory.directions.schema import RESOLVED_DIRECTION_STATUSES, DirectionRecord
        from factory.directions.watcher import _engine as _directions_engine
        from factory.providers.github import build_github_client

        _directions_engine(db)
        with Session(eng) as session:
            all_dir_rows = session.exec(select(DirectionRecord)).all()
        # Rate/scope: only directions that actually have a tracker_issue
        # recorded, capped at ~20 issue lookups per inbox run.
        direction_candidates = [
            drow
            for drow in all_dir_rows
            if drow.app in apps
            and drow.tracker_issue
            and drow.status in RESOLVED_DIRECTION_STATUSES
        ][:20]
        if direction_candidates:
            gh_client = build_github_client()
            if gh_client is None:
                tracker_check_skip_note = "no GitHub token available"
            else:
                app_cfg_cache: dict[str, Any] = {}
                for drow in direction_candidates:
                    tracker_issue_num = drow.tracker_issue
                    if tracker_issue_num is None:
                        continue  # filtered above; mypy can't see through the comprehension
                    if drow.app not in app_cfg_cache:
                        app_cfg_cache[drow.app] = load_app_config(drow.app, _FACTORY_ROOT)
                    cfg = app_cfg_cache[drow.app]
                    repo = gh_client.get_repo(cfg.repo)
                    issue = repo.get_issue(int(tracker_issue_num))
                    if str(getattr(issue, "state", "")).lower() == "open":
                        tracker_open_rows.append(
                            (drow.app, drow.direction_id, drow.status, f"#{tracker_issue_num}")
                        )
    except Exception as exc:  # noqa: BLE001 - the GH tracker check must never crash inbox
        tracker_check_skip_note = tracker_check_skip_note or str(exc)[:160]

    if tracker_check_skip_note:
        console.print(
            f"[yellow]tracker check skipped ({tracker_check_skip_note}) — cannot verify "
            "whether closed/terminal directions' tracker issues are still open on "
            "GitHub.[/yellow]"
        )
    elif tracker_open_rows:
        tracker_open_table = Table(title="terminal directions with a still-OPEN tracker issue")
        tracker_open_table.add_column("app")
        tracker_open_table.add_column("direction")
        tracker_open_table.add_column("local status")
        tracker_open_table.add_column("tracker issue")
        for trow in tracker_open_rows:
            tracker_open_table.add_row(*trow)
        console.print(tracker_open_table)
    else:
        console.print(
            "[dim]No terminal directions with a still-open tracker issue.[/dim]"
        )

    # Phase 6: recent scheduled runs (last 24h).
    from datetime import UTC as _UTC
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    from factory.chain.scheduled_tasks import ScheduledRunRecord

    cutoff_sched = (_dt.now(_UTC) - _td(hours=24)).isoformat()
    sched_table = Table(title="scheduled runs (last 24h)")
    sched_table.add_column("ts")
    sched_table.add_column("persona")
    sched_table.add_column("app")
    sched_table.add_column("findings")
    sched_table.add_column("directions_filed")
    sched_table.add_column("status")
    have_sched = False
    with Session(eng) as session:
        sched_rows = session.exec(
            select(ScheduledRunRecord)
            .where(ScheduledRunRecord.ts >= cutoff_sched)
            .order_by(ScheduledRunRecord.id.desc())  # type: ignore[union-attr]
        ).all()
        for sr in sched_rows:
            sched_table.add_row(
                sr.ts[:19],
                sr.persona,
                sr.app,
                str(sr.findings_count),
                sr.directions_filed_json,
                sr.status,
            )
            have_sched = True
    if have_sched:
        console.print(sched_table)
    else:
        console.print("[dim]No scheduled persona runs in the last 24h.[/dim]")

    # 019 AC6: operator pings — one per idle episode (app has zero
    # dispatchable stories and zero live human-filed directions), replacing
    # the "idle apps" table (Phase 7) that AC5 removed with
    # ``factory/chain/idle.py``. Deduplicated: this reads the SAME per-app
    # marker ``factory.chain.orchestrator.tick`` writes, so the table only
    # ever shows an app once per still-open episode, not once per tick.
    from factory.chain.idle_ping import active_pings

    try:
        pings = active_pings(_FACTORY_ROOT, apps)
    except Exception:  # noqa: BLE001 - one section must never take down the inbox
        pings = []
    if pings:
        ping_table = Table(title="operator_ping (idle apps)")
        ping_table.add_column("app")
        ping_table.add_column("idle since")
        ping_table.add_column("last delivered unit")
        for p in pings:
            ping_table.add_row(
                str(p.get("app") or ""),
                str(p.get("idle_since") or "")[:19],
                str(p.get("last_delivered_unit") or "(none yet)"),
            )
        console.print(ping_table)
    else:
        console.print("[dim]No idle-app pings.[/dim]")

    # PARKED-BUT-RESUMABLE stories — OPT-IN via ``--parked``.
    #
    # Several parked sinks (``blocked_dependency_unmet`` after a deadlock,
    # ``superseded_by_sibling``, the real-CI-failure ``blocked_ci_unresolved``
    # park) are on the tracker-closer's resolved-states allowlist and carry no
    # ``last_rejection_reason``, so they appear in NO operator surface — sacrifice
    # story 182 was deadlock-parked twice and showed up in no inbox category at
    # all. Now that ``factory resume-story`` can actually recover them, they are
    # worth being able to see.
    #
    # But this stays OFF by default, for two reasons that are the same reason:
    #
    # * ``inbox``'s default output answers "what needs a human DECISION", and two
    #   tests pin specific rows as invisible there precisely so the inbox and the
    #   tracker-closer can never disagree about that. A parked row is recoverable
    #   work, not a pending decision — a different claim, which must not be
    #   smuggled into the default view by widening a deliberate invariant.
    # * On the live DB this is ~20 rows of mostly-historical abandoned work.
    #   Volunteering it unasked buries the one or two rows that do need action —
    #   the detector-storm failure mode, one surface over.
    #
    # Discovery without the flood: ``factory why <id>`` names the remedy on the
    # specific story an operator is already looking at, and
    # ``factory resume-story --list`` is the full list on demand.
    from factory.chain.resume import infer_point, resumable_stories

    parked = (
        sorted((s for a in apps for s in resumable_stories(db, a)), key=lambda s: s.id or 0)
        if show_parked
        else []
    )
    if parked:
        parked_table = Table(
            title="parked stories — resumable with their work intact",
            caption="resume with: factory resume-story <id> --at <point> --dry-run",
        )
        for col in ("app", "id", "slug", "state", "pr", "spent", "suggested"):
            parked_table.add_column(col)
        for s in parked:
            parked_table.add_row(
                s.app,
                str(s.id),
                s.slug[:38],
                s.state,
                f"#{s.github_pr_number}" if s.github_pr_number else "—",
                f"${s.total_spend_usd:.2f}",
                f"--at {infer_point(s)}",
            )
        console.print(parked_table)

    # Phase 7: pinned ``factory-status`` issue numbers (one per app).
    # These are the operators' single GH-side entry point for live state.
    from factory.chain.factory_status import FactoryStatusRecord

    status_table = Table(title="pinned factory-status issues")
    status_table.add_column("app")
    status_table.add_column("issue")
    status_table.add_column("last updated")
    have_status = False
    with Session(eng) as session:
        for a in apps:
            row = session.exec(
                select(FactoryStatusRecord).where(FactoryStatusRecord.app == a)
            ).first()
            if row is None:
                continue
            status_table.add_row(a, f"#{row.gh_issue_number}", row.last_updated[:19])
            have_status = True
    if have_status:
        console.print(status_table)

    console.print(
        f"[dim]Current factory mode: [bold]{get_mode(_FACTORY_ROOT, db_path=db)}[/bold][/dim]"
    )


@app.command("queue")
def queue_cmd(
    app_name: str | None = typer.Option(None, "--app", help="Filter to one app"),
) -> None:
    """List in-flight StoryRecords with their state + last rejection reason."""
    from sqlmodel import Session, create_engine, select

    from factory.chain.handlers import _engine
    from factory.chain.state_machine import StoryRecord, StoryState

    db = _FACTORY_ROOT / "state" / "factory.db"
    _engine(db)
    terminal = {
        StoryState.PR_OPEN.value,
        StoryState.CI_PENDING.value,
        StoryState.CI_GREEN.value,
        StoryState.READY_FOR_MERGE.value,
        StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
        StoryState.BLOCKED_UNDERSPECIFIED.value,
        StoryState.SUPERSEDED_BY_SIBLING.value,
        StoryState.CLOSED_BY_OPERATOR.value,
        StoryState.DELIVERED_LOCAL.value,
        StoryState.DELIVERED_BRANCH.value,
        StoryState.DELIVERED_PR.value,
    }
    eng = create_engine(f"sqlite:///{db}", echo=False)
    table = Table(title="queue (in-flight stories)")
    table.add_column("id")
    table.add_column("app")
    table.add_column("slug")
    table.add_column("state")
    table.add_column("retries")
    table.add_column("rejection")
    with Session(eng) as session:
        stmt = select(StoryRecord)
        if app_name:
            stmt = stmt.where(StoryRecord.app == app_name)
        rows = session.exec(stmt).all()
    for r in rows:
        if r.state in terminal:
            continue
        table.add_row(
            str(r.id),
            r.app,
            r.slug,
            r.state,
            str(r.dev_retries),
            r.last_rejection_reason or "",
        )
    console.print(table)


@app.command("pause")
def pause_cmd() -> None:
    """Halt new dispatches: sets factory mode to ``paused``."""
    from factory.settings.modes import set_mode

    new = set_mode("paused", _FACTORY_ROOT)
    console.print(Panel.fit(f"factory mode -> [bold yellow]{new}[/bold yellow]", title="pause"))


@app.command("halt")
def halt_cmd(
    reason: str = typer.Argument(..., help="Why the factory is being halted"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
) -> None:
    """Immediately halt the factory: writes ``state/factory_mode.json``.

    ``factory.manager.halt.request_halt`` had ZERO production callers after
    PR #247 deleted the L3 Diagnostician (its only caller) — the write side
    of the halt mechanism was orphaned while the read side (``is_halted``,
    checked every tick) kept working, meaning nothing could actually set a
    halt any more. This command is the writer: mirrors ``factory resume``'s
    shape in reverse, and — like ``resume`` — is OPERATOR-ONLY. Never invoke
    from any LLM pathway. ``factory mode`` (and ``factory tick``) show the
    resulting halt state; only ``factory resume`` clears it.

    Note: the underlying ``request_halt`` hardcodes ``set_by:
    "manager_diagnostician"`` in the persisted state (it was written
    exclusively for the deleted L3 pathway) and honours a 30-minute
    operator-resume grace window during which ANY halt request — including
    this one — is suppressed. Both are ``factory/manager/halt.py`` internals
    this command cannot change without an operator-PR edit to that
    forbidden-to-self-edit module; if you hit the grace window, this command
    says so loudly instead of pretending to have halted.
    """
    from factory.manager.halt import is_halted, request_halt

    if is_halted(root=_FACTORY_ROOT):
        console.print("[yellow]Factory is already halted.[/yellow] Run 'factory mode' for details.")
        raise typer.Exit(code=0)
    if not yes:
        confirmed = typer.confirm(f"Halt the factory now? reason={reason!r}", default=False)
        if not confirmed:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit(code=0)
    halt_path = request_halt(
        root=_FACTORY_ROOT,
        concern_title="operator_halt",
        proposal_path=None,
        reason=reason,
    )
    if halt_path is None:
        console.print(
            Panel.fit(
                "[bold yellow]Halt suppressed[/bold yellow]\n\n"
                "An operator cleared a halt less than 30 minutes ago (the "
                "resume-grace window in factory/manager/halt.py). The "
                "factory is NOT halted. Wait out the window, or edit "
                "state/factory_mode.json directly if this is genuinely "
                "urgent.",
                title="halt",
            )
        )
        raise typer.Exit(code=1)
    console.print(
        Panel.fit(
            f"[bold red]FACTORY HALTED[/bold red]\nreason: {reason}",
            title="halt",
        )
    )


@app.command("resume")
def resume_cmd(
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
    reason: str | None = typer.Option(None, "--reason", help="Optional reason for clearing halt"),
) -> None:
    """Clear a factory halt and restore normal operation.

    If the factory is in a halted state (set by the L3 Diagnostician), this
    command clears it after operator confirmation.  If not halted, it falls
    back to setting mode to ``normal`` (same as before Phase 7).

    OPERATOR-ONLY — this command must never be invoked by any LLM pathway.
    """
    # Phase 7: check for halt state first.
    from factory.manager.halt import clear_halt, get_halt_state, is_halted

    if is_halted(root=_FACTORY_ROOT):
        halt_state = get_halt_state(root=_FACTORY_ROOT) or {}
        console.print(
            Panel.fit(
                f"[bold red]FACTORY HALTED[/bold red]\n\n"
                f"set_at:        {halt_state.get('set_at', '?')}\n"
                f"set_by:        {halt_state.get('set_by', '?')}\n"
                f"concern_title: {halt_state.get('concern_title', '?')}\n"
                f"reason:        {halt_state.get('reason', '?')}\n"
                f"proposal_path: {halt_state.get('proposal_path', '?')}",
                title="halt state",
            )
        )
        if not yes:
            confirmed = typer.confirm("Clear the halt and resume normal operation?", default=False)
            if not confirmed:
                console.print("[yellow]Aborted.[/yellow]")
                raise typer.Exit(code=0)
        archived = clear_halt(
            root=_FACTORY_ROOT,
            cleared_by="operator",
            reason=reason,
        )
        console.print(
            Panel.fit(
                f"[bold green]Halt cleared.[/bold green]\n"
                f"Archived to state/.halt_history.json\n"
                f"cleared_at: {archived.get('cleared_at', '?')}",
                title="resume",
            )
        )
    else:
        # No halt active — fall back to setting mode to normal.
        from factory.settings.modes import set_mode

        new = set_mode("normal", _FACTORY_ROOT)
        console.print(Panel.fit(f"factory mode -> [bold green]{new}[/bold green]", title="resume"))


def _factory_power_is_off() -> tuple[bool | None, str | None]:
    """Read-only factory power check for ``inbox``'s in-flight-while-off
    warning (E1). Built on the same ``factory.power.power_status`` read
    ``power_cmd`` below uses, so "OFF" here and "OFF" in ``factory power``
    can never disagree about the underlying systemd state.

    Returns ``(True, None)`` when every discovered unit is stopped, ``(False,
    None)`` when at least one unit is running (on or half-up), or ``(None,
    <note>)`` when the check itself could not run — no factory systemd units
    installed on this machine, or ``systemctl`` errored/timed out/is missing.
    Callers must treat ``None`` as "skip, do not warn" and surface the note
    instead of guessing.
    """
    from factory.power import power_status

    try:
        units = power_status(root=_FACTORY_ROOT)
    except Exception as exc:  # noqa: BLE001 - a broken systemctl must never crash inbox
        return None, f"systemctl check failed ({exc})"
    installed = [u for u in units if u.installed]
    if not installed:
        return None, "no factory systemd units installed on this machine"
    running = [u for u in installed if u.running]
    return (len(running) == 0), None


def _render_power_units(units: list[Any], title: str) -> None:
    table = Table(title=title)
    table.add_column("unit")
    table.add_column("active")
    table.add_column("enabled")
    for s in units:
        if not s.installed:
            continue
        colour = "green" if s.running else "dim"
        table.add_row(s.name, f"[{colour}]{s.active}[/{colour}]", s.enabled)
    console.print(table)


@app.command("off")
def off_cmd(
    now: bool = typer.Option(
        False,
        "--now",
        help="Do not wait for an in-flight tick to finish; stop immediately.",
    ),
    drain_timeout: int = typer.Option(
        None,
        "--drain-timeout",
        help="Seconds to wait for an in-flight tick to drain (default 300).",
    ),
) -> None:
    """Stop the ENTIRE factory: every tick timer, the FMS manager daemon, self-deploy.

    Idempotent and safe from any starting state — active, inactive, disabled,
    failed, or half-up. Nothing runs and nothing is billed afterwards.

    Shuts down CLEANLY by default: timers are stopped first so no new work can
    start, then any in-flight tick is allowed to finish (a tick killed
    mid-handler leaves a story stranded in an ``*_in_progress`` state for the
    next run to recover). Pass ``--now`` to skip the wait.

    Distinct from ``factory pause``, which only sets the in-DB mode — the
    processes keep running and the L1 watcher keeps spending. This stops the
    processes. The mode is left untouched, so ``factory on`` restores exactly
    the state you had.
    """
    from factory.power import DEFAULT_DRAIN_TIMEOUT_S, power_off

    report = power_off(
        root=_FACTORY_ROOT,
        wait=not now,
        drain_timeout_s=drain_timeout if drain_timeout is not None else DEFAULT_DRAIN_TIMEOUT_S,
    )

    if report["already_off"]:
        console.print("[dim]Factory was already off; re-asserted stop on all units.[/dim]")
    if report["drained"]:
        console.print(f"[dim]Waited for in-flight tick(s): {', '.join(report['drained'])}[/dim]")
    if report["drain_timed_out"]:
        console.print(
            "[yellow]Drain timeout expired with a tick still running — stopped it anyway. "
            "That story may need recovery on the next start.[/yellow]"
        )

    units = report["units"]
    still_running = [s.name for s in units if s.running]
    _render_power_units(units, "factory OFF")
    if still_running:
        console.print(f"[red]Still running: {', '.join(still_running)}[/red]")
        raise typer.Exit(code=1)
    console.print(
        Panel.fit("[bold red]FACTORY OFF[/bold red] — nothing running, $0/hour", title="off")
    )


@app.command("on")
def on_cmd() -> None:
    """Start the ENTIRE factory: FMS manager daemon, then every tick timer.

    Idempotent and safe from any starting state. Sticky ``failed`` state is
    cleared first, so a unit left failed by an earlier crash cannot block the
    restart — that "it won't come back up" case is exactly what this exists to
    make impossible.

    Does not touch the factory mode: if you were ``paused`` before, you still
    are. Use ``factory mode normal`` / ``factory resume`` for that.
    """
    from factory.power import power_on

    report = power_on(root=_FACTORY_ROOT)

    if report["already_on"]:
        console.print("[dim]Factory was already on; re-asserted start on all units.[/dim]")
    units = report["units"]
    _render_power_units(units, "factory ON")

    if report["failed"]:
        for name, err in report["failed"]:
            console.print(f"[red]{name} failed to start:[/red] {err}")
        raise typer.Exit(code=1)

    from factory.settings.modes import get_mode

    mode = get_mode(_FACTORY_ROOT)
    note = "" if mode == "normal" else f"\n[yellow]NOTE: factory mode is '{mode}'[/yellow]"
    console.print(
        Panel.fit(
            f"[bold green]FACTORY ON[/bold green] — {len(report['started'])} unit(s){note}",
            title="on",
        )
    )


@app.command("power")
def power_cmd() -> None:
    """Show whether the factory is on, off, or half-up (read-only)."""
    from factory.power import power_status

    units = power_status(root=_FACTORY_ROOT)
    installed = [s for s in units if s.installed]
    _render_power_units(units, "factory power")

    if not installed:
        console.print("[yellow]No factory systemd units installed on this machine.[/yellow]")
        return
    running = [s for s in installed if s.running]
    if not running:
        console.print(Panel.fit("[bold red]OFF[/bold red]", title="power"))
    elif len(running) == len(installed):
        console.print(Panel.fit("[bold green]ON[/bold green]", title="power"))
    else:
        console.print(
            Panel.fit(
                f"[bold yellow]HALF-UP[/bold yellow] — {len(running)}/{len(installed)} running.\n"
                f"Run 'factory on' or 'factory off' to make it consistent.",
                title="power",
            )
        )


@app.command("mode")
def mode_cmd(
    name: str | None = typer.Argument(None, help="Mode name; omit to print the current mode"),
) -> None:
    """Show or set the factory mode.

    When the factory is halted (set by L3 Diagnostician), prints halt details
    alongside the mode.  Use ``factory resume`` to clear a halt.
    """
    from factory.manager.halt import get_halt_state, is_halted
    from factory.settings.loader import is_valid_mode, load_settings
    from factory.settings.modes import get_mode, set_mode

    settings = load_settings(_FACTORY_ROOT)
    if name is None:
        current = get_mode(_FACTORY_ROOT)
        halted = is_halted(root=_FACTORY_ROOT)
        if halted:
            halt_state = get_halt_state(root=_FACTORY_ROOT) or {}
            console.print(
                f"current mode: [bold red]halted[/bold red]\n"
                f"  set_at:        {halt_state.get('set_at', '?')}\n"
                f"  concern_title: {halt_state.get('concern_title', '?')}\n"
                f"  reason:        {halt_state.get('reason', '?')}\n"
                f"  (db mode: {current})\n"
                f"available: {', '.join(settings.modes.available)}\n"
                f"[yellow]Run 'factory resume' to clear the halt.[/yellow]"
            )
        else:
            console.print(
                f"current mode: [bold]{current}[/bold]\n"
                f"available: {', '.join(settings.modes.available)}"
            )
        return
    if not is_valid_mode(name, settings):
        console.print(
            f"[red]error:[/red] mode {name!r} not in allowed set: "
            f"{', '.join(settings.modes.available)}"
        )
        raise typer.Exit(code=2)
    new = set_mode(name, _FACTORY_ROOT, settings=settings)
    console.print(Panel.fit(f"factory mode -> [bold]{new}[/bold]", title="mode"))


@app.command("budget")
def budget_cmd() -> None:
    """Show today's spend, hourly spend, projected end-of-day, last 5 runs."""
    from factory.settings.loader import load_settings
    from factory.settings.spend import (
        hour_spend_usd,
        projected_end_of_day,
        recent_runs,
        today_spend_usd,
        unpriced_model_runs_today,
    )

    settings = load_settings(_FACTORY_ROOT)
    db = _FACTORY_ROOT / "state" / "factory.db"
    today = today_spend_usd(_FACTORY_ROOT, db_path=db)
    hour = hour_spend_usd(_FACTORY_ROOT, db_path=db)
    proj = projected_end_of_day(_FACTORY_ROOT, db_path=db)
    daily_cap = settings.caps.daily_spend_usd
    hourly_cap = settings.caps.hourly_spend_usd
    table = Table(title="budget")
    table.add_column("metric")
    table.add_column("value", justify="right")
    table.add_row("today_spend_usd", f"${today:.4f}")
    table.add_row("daily_cap_usd", f"${daily_cap:.4f}")
    table.add_row("hour_spend_usd", f"${hour:.4f}")
    table.add_row("hourly_cap_usd", f"${hourly_cap:.4f}")
    table.add_row("projected_end_of_day_usd", f"${proj:.4f}")
    console.print(table)
    runs = recent_runs(_FACTORY_ROOT, db_path=db, limit=5)
    if runs:
        rtable = Table(title="last 5 runs")
        rtable.add_column("ts")
        rtable.add_column("persona")
        rtable.add_column("model")
        rtable.add_column("cost_usd", justify="right")
        for r in runs:
            rtable.add_row(r.ts, r.persona, r.model, f"${(r.cost_usd or 0):.4f}")
        console.print(rtable)

    # Silent-$0 blindness: runs today that burned tokens but recorded
    # cost_usd=0.0 because the model has no LiteLLM price registration (see
    # factory.providers.azure_foundry). today_spend_usd above is BLIND to
    # these — they contribute $0.00 to every number in the table above no
    # matter how much they actually cost the provider.
    unpriced = unpriced_model_runs_today(_FACTORY_ROOT, db_path=db)
    if unpriced:
        by_model: dict[str, int] = {}
        for r in unpriced:
            by_model[r.model] = by_model.get(r.model, 0) + 1
        models_str = ", ".join(f"{m} x{n}" for m, n in sorted(by_model.items()))
        console.print(
            Panel.fit(
                f"[red]{len(unpriced)} run(s) today burned tokens but recorded "
                f"cost_usd=$0.00 because the model has no usable LiteLLM "
                f"price: {models_str}. today_spend_usd above does NOT "
                f"include their real cost — register a price in "
                f"factory/providers/azure_foundry.py.[/red]",
                title="budget — unpriced-model blindness",
            )
        )


@app.command("resume-story")
def resume_story_cmd(
    # Optional so ``--list`` (which takes no story) can run at all. A required
    # positional made the documented listing flag unusable: `factory resume-story
    # --list` exited 2 with "Missing argument 'STORY_ID'".
    story_id: int | None = typer.Argument(
        None, help="StoryRecord.id to resume (omit with --list)"
    ),
    at: str = typer.Option(
        "auto",
        "--at",
        help=(
            "Re-entry point: auto (infer from banked artifacts) | gates (re-grade the "
            "existing PR — no persona runs) | tech_writer | review | dev | sm (full rebuild)"
        ),
    ),
    reason: str = typer.Option(
        "", "--reason", help="Why this story is being resumed (recorded in the event log)"
    ),
    reauthor_oracle: bool = typer.Option(
        False,
        "--reauthor-oracle",
        help=(
            "Delete the stored acceptance oracle so the next tick re-authors it from the "
            "CURRENT spec. Use when the contract/criteria were wrong, not the code."
        ),
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Show what would happen and change NOTHING (pure preview)"
    ),
    force: bool = typer.Option(
        False, "--force", help="Proceed despite an exhausted per-story spend cap"
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt"),
    list_only: bool = typer.Option(
        False, "--list", help="List resumable (parked) stories and exit"
    ),
    app_name: str | None = typer.Option(None, "--app", help="Filter --list to one app"),
) -> None:
    """Put a PARKED story back into the chain, keeping the work it already did.

    OPERATOR-ONLY. Six terminal sinks document their recovery as "an operator
    moves the row back to a live dispatch state"; this is that command. The
    default (``--at auto``) picks the cheapest re-entry that still re-runs
    whatever was broken — for a story that died at the merge gates with a good
    diff, that is ``gates``: the existing PR is re-graded and NO persona runs, so
    a bad oracle or a red host can be fixed and retested without paying to
    rebuild the story.

    Refuses (rather than silently re-parking one tick later) when the budget
    breaker, the dependency gate, or a closed/merged PR would immediately undo it.
    """
    from factory.app_config import load_app_config, resolve_app_repo_path
    from factory.chain.handlers import _engine
    from factory.chain.resume import (
        apply_resume,
        load_story,
        plan_resume,
        resumable_stories,
    )

    db = _FACTORY_ROOT / "state" / "factory.db"
    _engine(db)

    if list_only:
        rows = resumable_stories(db, app_name)
        if not rows:
            console.print("[green]No parked stories — nothing to resume.[/green]")
            return
        table = Table(title="resumable (parked) stories")
        for col in ("id", "app", "slug", "state", "pr", "spend"):
            table.add_column(col)
        for r in sorted(rows, key=lambda s: s.id or 0):
            table.add_row(
                str(r.id),
                r.app,
                r.slug[:44],
                r.state,
                f"#{r.github_pr_number}" if r.github_pr_number else "—",
                f"${r.total_spend_usd:.2f}",
            )
        console.print(table)
        return

    if story_id is None:
        console.print("[red]Missing STORY_ID. Pass a story id, or --list to see what is parked.[/red]")
        raise typer.Exit(code=2)

    story = load_story(db, story_id)
    if story is None:
        console.print(f"[red]No story with id={story_id}.[/red]")
        raise typer.Exit(code=1)

    try:
        app_repo: Path | None = resolve_app_repo_path(
            load_app_config(story.app, _FACTORY_ROOT), _FACTORY_ROOT
        )
    except Exception:  # noqa: BLE001 - plan_resume treats None as "unknown", which blocks
        app_repo = None

    plan = plan_resume(
        story=story,
        db=db,
        root=_FACTORY_ROOT,
        point=at,
        reason=reason,
        reauthor_oracle=reauthor_oracle,
        app_repo=app_repo,
        force=force,
    )

    body = [
        f"story  {plan.story_id}  [bold]{plan.slug}[/bold]  (app={plan.app})",
        f"state  {plan.from_state} -> [bold]{plan.to_state}[/bold]   (point={plan.point})",
        "",
        "[bold]preserved[/bold] (not re-done, not re-paid for):",
    ]
    body += [f"  · {k} = {v}" for k, v in plan.preserved.items()]
    body += ["", "[bold]reset[/bold] (so it cannot re-park on the first tick):"]
    body += [f"  · {item}" for item in plan.resets]
    if plan.pr_needs_reopen:
        body += ["", f"[yellow]PR #{story.github_pr_number} is CLOSED and will be reopened.[/]"]
    for warning in plan.warnings:
        body += [f"[yellow]warning: {warning}[/yellow]"]
    for refusal in plan.refusals:
        body += [f"[red]REFUSED: {refusal}[/red]"]
    console.print(
        Panel.fit("\n".join(body), title="resume-story" + (" — DRY RUN" if dry_run else ""))
    )

    if not plan.ok:
        raise typer.Exit(code=1)
    if dry_run:
        console.print("[dim]Dry run — nothing was changed.[/dim]")
        return
    if not yes and not typer.confirm("Resume this story?", default=False):
        console.print("[yellow]Aborted.[/yellow]")
        raise typer.Exit(code=0)

    try:
        apply_resume(plan=plan, story=story, db=db, root=_FACTORY_ROOT, app_repo=app_repo)
    except RuntimeError as exc:
        console.print(f"[red]Resume failed: {exc}[/red]")
        raise typer.Exit(code=1) from exc
    console.print(
        Panel.fit(
            f"[bold green]Story {plan.story_id} resumed[/bold green] at `{plan.to_state}`.\n"
            f"Next `factory tick --app {plan.app}` picks it up.\n"
            f"Audited as a `story_resumed` event (`factory trace {plan.story_id}`).",
            title="resume-story",
        )
    )


@app.command("why")
def why_cmd(
    target: str = typer.Argument(..., help="Story id (StoryRecord.id) or slug"),
) -> None:
    """Explain why a story is stuck/blocked.

    Projects the next-tick decision by looking up the orchestrator's
    ``_DISPATCH[story.state]`` handler kind and running ``can_dispatch``
    against the same ``current_state`` dict the orchestrator builds. This
    answers the operator's actual question ("would the next tick advance
    this story, or block it, and why?") rather than just echoing the last
    historical rejection.
    """
    from sqlmodel import Session, create_engine, select

    from factory.chain.handlers import _engine
    from factory.chain.handlers import stories_in_flight as _in_flight
    from factory.chain.orchestrator import _build_current_state, _dispatch_for_story
    from factory.chain.state_machine import StoryRecord, StoryState, list_transitions_from
    from factory.settings.enforcer import can_dispatch
    from factory.settings.loader import load_settings

    db = _FACTORY_ROOT / "state" / "factory.db"
    _engine(db)
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        story: StoryRecord | None = None
        try:
            story = session.get(StoryRecord, int(target))
        except ValueError:
            rows = session.exec(select(StoryRecord).where(StoryRecord.slug == target)).all()
            if rows:
                story = rows[0]
        if story is None:
            console.print(f"[red]error:[/red] no story matched {target!r}")
            raise typer.Exit(code=2)

    next_edges = list_transitions_from(StoryState(story.state))
    next_edges_str = (
        ", ".join(f"{ev} -> {ns.value}" for ev, ns in next_edges) if next_edges else "(terminal)"
    )

    # Project the next tick: which handler kind would fire, and would the
    # enforcer allow it?
    projection_line = "next-tick projection: (terminal — no handler dispatches from here)"
    handler_name = _dispatch_for_story(story)
    if handler_name is not None:
        # Resolve the actual job_kind the orchestrator would pass to the
        # enforcer; ``_resolve_job_kind`` handles bug-suffix routing for
        # bug-typed directions/stories.
        from factory.chain.handlers import find_direction_for_story
        from factory.chain.orchestrator import _resolve_job_kind

        direction = find_direction_for_story(story, _FACTORY_ROOT)
        job_kind = _resolve_job_kind(story, direction, handler_name)

        in_flight_app = max(0, len(_in_flight(story.app, db)) - 1)
        settings = load_settings(_FACTORY_ROOT)
        state_dict = _build_current_state(
            root=_FACTORY_ROOT,
            db=db,
            app=story.app,
            in_flight_app=in_flight_app,
            exclude_story_id=story.id,
        )
        decision = can_dispatch(job_kind, story.app, state_dict, settings)
        # The dependency-ordering gate runs BEFORE the enforcer in the tick, so a
        # story waiting on a lower-id sibling is deferred no matter what
        # ``can_dispatch`` says. Reporting "would dispatch" for such a story is a
        # proxy≠real answer to the operator's actual question.
        from factory.chain.orchestrator import (
            _MAX_DEPENDENCY_DEFERRALS,
            _deps_all_stalled,
            _deps_permanently_dead,
            _deps_stalled_long_enough,
            _direction_deps_pending,
        )

        deps_pending = _direction_deps_pending(db, story)
        if deps_pending:
            _waiting_on = (
                f"dependency ordering: waiting on story_ids={deps_pending[:10]} in "
                f"direction {story.direction_id}"
            )
            if _deps_permanently_dead(db, deps_pending):
                # The pre-existing deadlock guard fires FIRST and parks immediately;
                # quoting a deferral countdown here would be fiction.
                projection_line = (
                    f"next-tick projection: [bold red]would PARK[/bold red] "
                    f"(dependency deadlock — every blocker is a definitive dead end) "
                    f"— {_waiting_on}"
                )
            elif not _deps_all_stalled(db, deps_pending):
                # A blocker can still move on its own: this defers indefinitely and
                # the cap counter does not advance. Do not imply a deadline.
                projection_line = (
                    f"next-tick projection: [bold yellow]would DEFER[/bold yellow] — "
                    f"{_waiting_on} (blockers still in progress; the deferral cap does "
                    f"not count while any blocker is live)"
                )
            else:
                _aged = _deps_stalled_long_enough(db, deps_pending)
                _left = max(0, _MAX_DEPENDENCY_DEFERRALS - story.dependency_defer_count)
                _park_when = (
                    "parks on this tick"
                    if _aged and _left == 0
                    else (
                        f"parks after {_left} more stalled tick(s)"
                        if _aged
                        else "holding until the blockers' stall window elapses"
                    )
                )
                projection_line = (
                    f"next-tick projection: [bold yellow]would DEFER[/bold yellow] — "
                    f"{_waiting_on} (blockers human-blocked; stalled deferrals "
                    f"{story.dependency_defer_count}/{_MAX_DEPENDENCY_DEFERRALS}; "
                    f"{_park_when} → blocked_dependency_unmet, surfaced in "
                    f"`factory inbox`)"
                )
        elif decision.allowed:
            projection_line = (
                f"next-tick projection: [bold green]would dispatch[/bold green] "
                f"job_kind=[bold]{job_kind}[/bold]"
            )
        else:
            projection_line = (
                f"next-tick projection: [bold red]would be blocked[/bold red]: "
                f"[bold]{decision.rejected_reason}[/bold] (job_kind={job_kind})"
            )

    # Tail the per-story event log so ``factory why`` shows the recent
    # chain decisions inline. Operators usually want the last few events
    # (retry counts, dispatch rejections, exceptions) without separately
    # opening the log file. ``factory trace`` shows the full history.
    from factory.chain.event_log import read_story_events

    # ONE read of the whole log, sliced two ways below: the tail the operator
    # skims, and the dev-loop stop reason promoted out of it. Two reads would
    # also have added a second ``story.id`` type error to a file that already
    # carries one.
    _all_events = read_story_events(
        int(story.id or 0), software_factory_root=_FACTORY_ROOT, slug_hint=story.slug
    )
    recent = _all_events[-8:]

    # The dev convergence loop's stop reason, promoted out of the tail.
    #
    # ``dev_inner_loop_stopped`` says the dev was CUT SHORT by a guard —
    # a spend cap, the wall clock, the attempts cap — rather than having run out
    # of ideas. It went only to the story log, and the tail above shows the last
    # 8 events, so on any story that then went to review it had already scrolled
    # off: the operator saw "dev didn't finish" and not "a $2/h ceiling stopped
    # it after one attempt". Measured on bench sweep 2, that hid four truncated
    # rows, one of which is a published capability datapoint. Scan the WHOLE log
    # and print the most recent one as its own field.
    _stops = [e for e in _all_events if e.get("event") == "dev_inner_loop_stopped"]
    if _stops:
        _last = _stops[-1]
        dev_loop_line = (
            f"dev inner loop CUT SHORT: reason=[bold yellow]{_last.get('reason')}[/bold yellow]"
            f"  inner_attempts={_last.get('inner_attempts')}"
            f"  dev_retries={_last.get('dev_retries')}"
            f"  (x{len(_stops)} this story)"
        )
    else:
        dev_loop_line = "dev inner loop: (never stopped early)"
    event_lines: list[str] = []
    for ev in recent:
        ts = ev.get("ts", "?")[11:19] if ev.get("ts") else "?"
        kind = ev.get("event", "?")
        extras = {k: v for k, v in ev.items() if k not in {"ts", "story_id", "event"}}
        extras_str = " ".join(f"{k}={v!r}" for k, v in extras.items())[:200]
        event_lines.append(f"  {ts}  {kind}  {extras_str}")
    events_block = (
        "recent events (tail 8 — see ``factory trace`` for full log):\n" + "\n".join(event_lines)
        if event_lines
        else "recent events: (none recorded yet)"
    )

    # A parked story's docstring says "an operator moves the row back to a live
    # dispatch state", and for a long time no command did that — so `why` told the
    # operator the story was terminal and stopped. Naming the remedy here is what
    # turns this from a diagnosis into a next action (the detect-without-remediate
    # gap, at the operator surface).
    from factory.chain.resume import infer_point, resumable_stories

    remedy = ""
    if any(r.id == story.id for r in resumable_stories(db, story.app)):
        remedy = (
            f"\nremedy: this story is PARKED and can be resumed with its work intact —\n"
            f"  [bold]factory resume-story {story.id} --at {infer_point(story)} "
            f'--reason "..." --dry-run[/bold]\n'
            f"  (`--at gates` re-grades the existing PR without re-running any persona; "
            f"add `--reauthor-oracle` when the SPEC was wrong, not the code)"
        )

    lines = [
        f"id=[bold]{story.id}[/bold]  slug=[bold]{story.slug}[/bold]",
        f"app=[bold]{story.app}[/bold]  state=[bold]{story.state}[/bold]",
        f"retries=[bold]{story.dev_retries}[/bold]  tier=[bold]{story.current_model_tier}[/bold]",
        f"last_rejection_reason=[bold]{story.last_rejection_reason or '(none)'}[/bold]",
        f"error=[bold]{story.error or '(none)'}[/bold]",
        f"branch={story.github_branch}  pr=#{story.github_pr_number}",
        f"next legal transitions: {next_edges_str}",
        dev_loop_line,
        projection_line + remedy,
        "",
        events_block,
    ]
    console.print(Panel("\n".join(lines), title=f"why story {story.id}"))


@app.command("trace")
def trace_cmd(
    target: str = typer.Argument(..., help="Story id"),
    limit: int = typer.Option(
        50,
        "--limit",
        "-n",
        help="Most-recent N events to show; 0 for full history",
    ),
) -> None:
    """Dump the per-story event log — every handler run, retry, and decision.

    The chain writes one JSONL record per significant event to
    ``state/logs/<story-id>-<slug>.log``. Use this when ``factory why``'s
    tail isn't enough — e.g. tracking down why dev exhausted retries,
    inspecting JSON-mode truncation auto-retries, or auditing what the
    enforcer rejected before dispatch.
    """
    from sqlmodel import Session, create_engine

    from factory.chain.event_log import read_story_events
    from factory.chain.state_machine import StoryRecord

    db = _FACTORY_ROOT / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        try:
            sid = int(target)
        except ValueError:
            console.print(f"[red]error:[/red] expected story id (int); got {target!r}")
            raise typer.Exit(code=2) from None
        story = session.get(StoryRecord, sid)

    slug = story.slug if story is not None else ""
    events = read_story_events(
        sid,
        software_factory_root=_FACTORY_ROOT,
        slug_hint=slug,
        limit=limit if limit > 0 else None,
    )
    if not events:
        console.print(f"(no events logged for story {sid})")
        return

    table = Table(title=f"trace story {sid} ({slug or '?'}) — {len(events)} events")
    table.add_column("ts")
    table.add_column("event", style="bold")
    table.add_column("detail")
    for ev in events:
        ts = ev.get("ts", "?")[11:23] if ev.get("ts") else "?"
        kind = ev.get("event", "?")
        extras = {k: v for k, v in ev.items() if k not in {"ts", "story_id", "event"}}
        # Compact one-line detail; long values clipped.
        parts = []
        for k, v in extras.items():
            s = repr(v) if not isinstance(v, str) else v
            parts.append(f"{k}={s[:160]}")
        table.add_row(ts, kind, " ".join(parts))
    console.print(table)


@app.command("settings")
def settings_cmd() -> None:
    """Pretty-print the loaded factory_settings.yaml."""
    from factory.settings.loader import load_settings

    settings = load_settings(_FACTORY_ROOT)
    import json as _json

    console.print(Panel(_json.dumps(settings.model_dump(), indent=2), title="factory settings"))


@app.command("tui")
def tui_cmd(
    app_name: str | None = typer.Option(
        None, "--app", help="Filter the dashboard to a single app; default: all apps"
    ),
    refresh: float = typer.Option(1.0, "--refresh", help="Refresh interval in seconds (>= 0.25)"),
    recompute_baselines: bool = typer.Option(
        False,
        "--recompute-baselines",
        help="Recompute (persona, points) baselines from history before launching",
    ),
) -> None:
    """Launch the live terminal dashboard (factory's ``nvidia-smi``).

    Reads ``state/factory.db`` and refreshes every ``--refresh`` seconds.
    Shows mode, 24h/7d spend, per-app stats, in-flight directions with
    EBS Monte Carlo ETAs (P50/P75/P95), mid-flight personas, velocity
    per (persona, model_tier), and a tail of recent runs.

    Keys: ``q`` quit, ``r`` recompute baselines on demand.
    """
    from factory.settings.loader import load_settings
    from factory.tui import run_tui

    db = _FACTORY_ROOT / "state" / "factory.db"
    if recompute_baselines:
        from factory.observability.estimator import recompute_baselines as _rb

        n = _rb(db)
        console.print(f"[dim]recomputed {n} (persona, points) baselines[/dim]")

    spend_cap: float | None = None
    try:
        settings = load_settings(_FACTORY_ROOT)
        spend_cap = float(settings.caps.daily_spend_usd) or None
    except Exception:
        spend_cap = None

    run_tui(
        software_factory_root=_FACTORY_ROOT,
        db_path=db,
        spend_cap_usd=spend_cap,
        app_filter=app_name,
        refresh_seconds=max(0.25, refresh),
    )


def _story_progress_rows(app_name: str | None) -> list[dict[str, Any]]:
    """Assemble a per-in-flight-story progress snapshot.

    Joins three independent signals into one row so "where is each story right
    now" is answerable at a glance:
      * the chain STATE (which step) + cycle counters, from ``stories``;
      * the AGENT RUNNING RIGHT NOW, from the ``live_handlers`` heartbeat table
        (a row exists only while a persona's sandbox/text run is in flight);
      * COMMIT-VERIFIABLE progress, from the tip commit on the story's branch;
      * the last per-story event + its age (so a stalled story is obvious).
    """
    import sqlite3
    from datetime import UTC, datetime

    from factory.chain.branch import feature_branch_name
    from factory.chain.event_log import read_story_events
    from factory.observability.queries import live_handlers

    db = _FACTORY_ROOT / "state" / "factory.db"
    live = {lh.story_id: lh for lh in live_handlers(db) if lh.story_id is not None}

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    sql = (
        "SELECT id, app, slug, state, chain_kind, dev_retries, reviewer_cycles, "
        "github_issue_number, updated_at FROM stories WHERE state NOT IN "
        "('deployed','blocked_tests_need_clarification','blocked_deploy_failed',"
        "'blocked_review_nonconvergent','blocked_underspecified',"
        "'superseded_by_sibling','story_created','closed_by_operator')"
    )
    params: list[Any] = []
    if app_name:
        sql += " AND app = ?"
        params.append(app_name)
    sql += " ORDER BY id ASC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    for r in rows:
        sid = int(r["id"])
        # Tip commit on the story's feature branch — commit-verifiable progress.
        branch = feature_branch_name(r["github_issue_number"], r["slug"])
        commit = "—"
        try:
            res = subprocess.run(
                ["git", "-C", "/home/k/sacrifice", "log", "-1", "--format=%h %s", branch, "--"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if res.returncode == 0 and res.stdout.strip():
                commit = res.stdout.strip()[:60]
        except Exception:
            pass
        # Last per-story event + age.
        last_evt, evt_age = "—", ""
        try:
            evts = read_story_events(sid, software_factory_root=_FACTORY_ROOT, slug_hint=r["slug"])
            if evts:
                e = evts[-1]
                last_evt = str(e.get("event", "—"))
                ets = e.get("ts")
                if ets:
                    try:
                        dt = datetime.fromisoformat(ets)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=UTC)
                        evt_age = f"{int((now - dt).total_seconds())}s ago"
                    except ValueError:
                        pass
        except Exception:
            pass
        lh = live.get(sid)
        out.append(
            {
                "id": sid,
                "slug": (r["slug"] or "")[:34],
                "state": r["state"],
                "agent": (f"{lh.persona} ({int(lh.elapsed_seconds)}s)" if lh else "—"),
                "working": lh is not None,
                "cycles": f"dev:{r['dev_retries']} rev:{r['reviewer_cycles']}",
                "commit": commit,
                "event": f"{last_evt} {evt_age}".strip(),
            }
        )
    return out


def _render_status(app_name: str | None) -> Table:
    from factory.observability.queries import get_factory_mode, spend_window

    db = _FACTORY_ROOT / "state" / "factory.db"
    rows = _story_progress_rows(app_name)
    working = [r for r in rows if r["working"]]
    try:
        mode = get_factory_mode(db)
        spend = spend_window(db, hours=24)
    except Exception:
        mode, spend = "?", 0.0
    title = (
        f"factory status — mode={mode}  24h spend=${spend:.2f}  "
        f"in-flight={len(rows)}  working-now={len(working)}"
    )
    table = Table(title=title, expand=True)
    table.add_column("#", justify="right")
    table.add_column("story")
    table.add_column("state (step)")
    table.add_column("▶ agent now", style="bold")
    table.add_column("cycles")
    table.add_column("tip commit")
    table.add_column("last event")
    for r in rows:
        agent_style = "green" if r["working"] else "dim"
        table.add_row(
            str(r["id"]),
            r["slug"],
            r["state"],
            f"[{agent_style}]{r['agent']}[/{agent_style}]",
            r["cycles"],
            r["commit"],
            r["event"],
        )
    if not rows:
        table.add_row("—", "(no in-flight stories)", "", "", "", "", "")
    return table


@app.command("status")
def status_cmd(
    app_name: str | None = typer.Option(None, "--app", help="Filter to one app"),
    watch: float = typer.Option(
        0.0, "--watch", help="Refresh every N seconds (0 = print once and exit)"
    ),
) -> None:
    """Show exactly where every in-flight story is RIGHT NOW.

    One row per in-flight story: its chain state (which step), the agent
    actively running on it this instant (``▶ agent now`` — green = a live
    sandbox/review is executing, dim ``—`` = idle/queued), the dev/review cycle
    counters, the tip commit on its branch (commit-verifiable progress), and the
    last recorded event with its age. ``--watch N`` re-renders every N seconds
    so you can watch a dev↔review loop advance live.
    """
    if watch and watch > 0:
        import time

        from rich.live import Live

        with Live(_render_status(app_name), console=console, refresh_per_second=4) as live:
            while True:
                time.sleep(max(0.5, watch))
                live.update(_render_status(app_name))
    else:
        console.print(_render_status(app_name))


@app.command("baselines")
def baselines_cmd() -> None:
    """Recompute EBS handler baselines from the runs ⨝ stories history.

    Refreshes ``handler_baselines`` (per-(persona, points) median seconds).
    Safe to call any time; the TUI also exposes this on the ``r`` key.
    """
    from factory.observability.estimator import recompute_baselines

    db = _FACTORY_ROOT / "state" / "factory.db"
    n = recompute_baselines(db)
    console.print(f"recomputed [bold]{n}[/bold] (persona, points) baselines")


@app.command("spend")
def spend_cmd(
    days: int = typer.Option(7, "--days", help="Days of history to show"),
) -> None:
    """Historical spend breakdown (last N days)."""
    from factory.settings.spend import spend_by_day

    rows = spend_by_day(_FACTORY_ROOT, days=days)
    table = Table(title=f"spend (last {days} days)")
    table.add_column("date")
    table.add_column("usd", justify="right")
    total = 0.0
    for d, usd in rows:
        table.add_row(d, f"${usd:.4f}")
        total += usd
    table.add_row("total", f"${total:.4f}")
    console.print(table)


@app.command("audit")
def audit_cmd(
    days: int = typer.Option(7, "--days", help="Days of history to roll up"),
    top: int = typer.Option(20, "--top", help="Max rows per rollup table"),
    reconcile: bool = typer.Option(
        False, "--reconcile", help="Print the provider-bill reconciliation note"
    ),
) -> None:
    """Per-unit cost/token/time audit: rollups by story, direction, and app.

    D003 — complements ``factory spend`` (which only sums cost per calendar
    day) with the attribution operators need to answer "what did THIS story
    cost", not just "what did today cost". Also reports total chain-persona
    spend that has NO ``story_id`` (the "unattributed" bucket) so operators
    can see how complete the attribution is, not just what it totals to.
    """
    from factory.settings.audit import build_audit_report

    report = build_audit_report(_FACTORY_ROOT, days=days)

    header = (
        f"window={report.window_days}d  runs={report.total_run_count}  "
        f"total_cost_usd=${report.total_cost_usd:.4f}"
    )
    if report.estimated_cost_usd > 0:
        header += (
            f"  [yellow]~estimated={report.estimated_cost_pct:.1f}% "
            f"(${report.estimated_cost_usd:.4f})[/yellow]"
        )
    if report.unreliable_usage_run_count > 0:
        header += (
            f"  [red]?unreliable={report.unreliable_usage_pct:.1f}% "
            f"({report.unreliable_usage_run_count} runs)[/red]"
        )
    console.print(Panel.fit(header, title="audit"))

    def _rows_table(title: str, key_col: str, rows: list[Any]) -> Table:
        t = Table(title=title)
        t.add_column(key_col)
        t.add_column("runs", justify="right")
        t.add_column("tokens_in", justify="right")
        t.add_column("tokens_out", justify="right")
        t.add_column("cost_usd", justify="right")
        t.add_column("duration_s", justify="right")
        for row in rows[:top]:
            # ``~`` marks rows whose cost_usd includes spend priced at an
            # ESTIMATED rate (see the footnote below) — operators must not
            # read these as exact until reconciled against the real bill.
            # ``?`` marks rows containing a run that called a model but whose
            # usage we never read at all: that row's cost is a FLOOR, not a
            # measurement. A row can carry both markers.
            key_display = row.key
            if row.has_estimated_cost:
                key_display = f"~{key_display}"
            if getattr(row, "has_unreliable_usage", False):
                key_display = f"?{key_display}"
            t.add_row(
                key_display,
                str(row.run_count),
                str(row.tokens_in),
                str(row.tokens_out),
                f"${row.cost_usd:.4f}",
                f"{row.duration_s:.1f}",
            )
        return t

    console.print(_rows_table("audit — by story", "story_id", report.by_story))
    console.print(_rows_table("audit — by direction", "direction_id", report.by_direction))
    console.print(_rows_table("audit — by app", "app", report.by_app))

    if report.estimated_cost_usd > 0:
        models = ", ".join(report.estimated_models)
        console.print(
            Panel.fit(
                f"[yellow]~ marks rows priced with an ESTIMATED rate, not an exact "
                f"one: {report.estimated_cost_pct:.1f}% of window spend "
                f"(${report.estimated_cost_usd:.4f}) used a model whose LiteLLM "
                f"price registration is flagged estimated ({models}) — the "
                f"cache-read rate has no published provider meter and is pending "
                f"reconciliation against the real bill. See --reconcile.[/yellow]",
                title="audit — cost-accuracy caveat",
            )
        )

    if report.unreliable_usage_run_count > 0 or report.unknown_usage_run_count > 0:
        lines = []
        if report.unreliable_usage_run_count > 0:
            lines.append(
                f"[red]? marks rows containing a run that CALLED a model but "
                f"reported no readable usage/cost: "
                f"{report.unreliable_usage_run_count} run(s), "
                f"{report.unreliable_usage_pct:.1f}% of the window. Their cost "
                f"is a floor — total_cost_usd understates by an unknown "
                f"amount.[/red]"
            )
        if report.unknown_usage_run_count > 0:
            lines.append(
                f"[dim]{report.unknown_usage_run_count} run(s) predate the "
                f"usage_reliable column and are neither confirmed reliable nor "
                f"flagged; they are excluded from the percentage above.[/dim]"
            )
        console.print(Panel.fit("\n".join(lines), title="audit — usage-completeness caveat"))

    u = report.unattributed
    by_persona = ", ".join(f"{k}={v}" for k, v in sorted(u.by_persona.items())) or "(none)"
    unattributed_style = "red" if u.run_count > 0 else "green"
    console.print(
        Panel.fit(
            f"[{unattributed_style}]runs={u.run_count}  cost_usd=${u.cost_usd:.4f}  "
            f"tokens_in={u.tokens_in}  tokens_out={u.tokens_out}[/{unattributed_style}]\n"
            f"by persona: {by_persona}",
            title="audit — unattributed chain-persona spend (NULL story_id)",
        )
    )

    if reconcile:
        console.print(
            Panel.fit(
                "To reconcile summed cost_usd against the real provider bill for "
                "this window:\n"
                "  1. Pull the provider's billed total for the same UTC window "
                "(Azure Cost Management for azure/* model ids; the DeepSeek "
                "dashboard for deepseek/* direct-provider ids).\n"
                "  2. Compare against this command's total_cost_usd above.\n"
                "  3. A variance beyond a few percent usually means either (a) a "
                "model/provider is missing a price registration in "
                "factory/providers/azure_foundry.py (cost_usd under-counts, "
                "often silently — a new/renamed Azure deployment ships with no "
                "LiteLLM price entry until someone registers one), or (b) the "
                "provider changed a rate LiteLLM/our registration hasn't caught "
                "up with yet.\n"
                "  3b. Case (a) is no longer silent: a call that returned no "
                "readable cost now records usage_reliable=False and surfaces in "
                "the usage-completeness panel above. A non-zero ? count is the "
                "first thing to check when the bill exceeds our total.\n"
                "  4. The 'unattributed' panel above does NOT explain a variance "
                "against the bill — those runs still recorded a cost_usd, they "
                "just aren't tied to a story/direction/app.",
                title="audit — reconciliation note",
            )
        )


@app.command("auto-merge")
def auto_merge_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(True, "--dry-run/--real-run", help="Dry-run (default)"),
) -> None:
    """Run one auto-merge tick against ``--app``.

    In dry-run mode the worker reads the local DB only and does not call
    GitHub. Use ``--real-run`` to invoke the GH client (requires GITHUB_TOKEN).
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.chain.auto_merge import auto_merge_tick

    gh: Any = None
    if not dry_run:
        gh = _ensure_github_client()

    actions = auto_merge_tick(_FACTORY_ROOT, app_name, dry_run=dry_run, github_client=gh)

    if not actions:
        console.print(
            Panel.fit(
                f"No PR fixtures or open PRs to evaluate for [bold]{app_name}[/bold].",
                title="auto-merge",
            )
        )
        return

    table = Table(title=f"auto-merge — app={app_name} dry_run={dry_run}")
    table.add_column("pr")
    table.add_column("merged")
    table.add_column("reason")
    table.add_column("gates_passed", justify="right")
    for a in actions:
        table.add_row(
            f"#{a.pr_number}",
            "[green]yes[/green]" if a.merged else "[red]no[/red]",
            a.reason[:80],
            str(len(a.gates_passed)),
        )
    console.print(table)


@app.command("mutation-score")
def mutation_score_cmd(
    app_name: str = typer.Option(..., "--app", help="App name (supplies test_command)"),
    repo_root: Path = typer.Option(
        ..., "--repo-root", help="Checkout to measure (never written to)"
    ),
    base: str = typer.Option("main", "--base", help="Base branch the diff is against"),
    head: str = typer.Option("", "--head", help="Head SHA (default: the checkout's HEAD)"),
    test_command: str = typer.Option(
        "",
        "--test-command",
        help=(
            "Override the app's test_command. Needed when the app's command is "
            "not self-sufficient in a fresh checkout — the factory's own "
            "`uv run pytest -q` is not, because pytest is a dev extra."
        ),
    ),
    max_symbols: int = typer.Option(5, "--max-symbols", help="Cap on ablations per run"),
    budget_seconds: int = typer.Option(1800, "--budget-seconds", help="Wall-clock budget"),
    no_cache: bool = typer.Option(False, "--no-cache", help="Ignore cached per-symbol results"),
    as_json: bool = typer.Option(False, "--json", help="Emit the raw report as JSON"),
) -> None:
    """Measure the diff-scoped MUTATION SCORE of a checkout: for each symbol the
    diff touched, replace its body with a raise and see whether the suite
    notices.

    This is a measurement, not a gate. It runs the app's ``test_command`` once
    per symbol plus a baseline, in a THROWAWAY clone at the graded SHA — the
    checkout you point it at is never written to. If the suite is not green in
    that clone before any mutation, the run reports ``skipped`` rather than a
    score: a coverage claim derived from an already-red suite is not a
    measurement. Results are cached per ``(head_sha, symbol)`` under
    ``state/mutation/<app>/``, so re-running the same SHA is free and a run cut
    short by the budget resumes where it stopped.
    """
    import json as _json

    from factory.app_config import load_app_config
    from factory.chain.mutation import measure

    app_config = load_app_config(app_name, _FACTORY_ROOT)
    report = measure(
        repo_root=repo_root,
        head_sha=head,
        base_branch=base,
        test_command=test_command or app_config.gates.test_command,
        app=app_name,
        software_factory_root=_FACTORY_ROOT,
        max_symbols=max_symbols,
        budget_s=budget_seconds,
        use_cache=not no_cache,
    )

    if as_json:
        console.print_json(_json.dumps(report.as_dict()))
        return

    score = "n/a" if report.score is None else f"{report.score:.2f}"
    table = Table(title=f"mutation-score — app={app_name} status={report.status}")
    table.add_column("field")
    table.add_column("value")
    table.add_row("score", score)
    table.add_row("killed", ", ".join(report.killed) or "-")
    table.add_row("survived", ", ".join(report.survived) or "-")
    table.add_row("skipped", ", ".join(f"{s['symbol']} ({s['why']})" for s in report.skipped) or "-")
    table.add_row("candidates", f"{report.candidates} (truncated={report.truncated})")
    table.add_row("baseline", report.baseline)
    table.add_row("tree", report.tree_source)
    table.add_row("cache hits", str(report.cache_hits))
    table.add_row("elapsed", f"{report.elapsed_s:.1f}s")
    console.print(table)
    console.print(Panel.fit(report.reason, title="mutation-score"))
    if report.notes:
        console.print(Panel.fit("\n".join(report.notes), title="notes"))
    if report.status.startswith("skipped") and report.baseline_output:
        console.print(Panel.fit(report.baseline_output[-1500:], title="baseline output (tail)"))


@app.command("deploy")
def deploy_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    sha: str | None = typer.Option(None, "--sha", help="Specific SHA to deploy (overrides queue)"),
    pr: int | None = typer.Option(
        None, "--pr", help="Deploy a specific PR (uses placeholder SHA in dry-run)"
    ),
    dry_run: bool = typer.Option(True, "--dry-run/--real-run", help="Dry-run (default)"),
) -> None:
    """Run one deploy tick against ``--app``.

    In dry-run mode no subprocesses are launched — every step is
    deterministically successful. Use ``--real-run`` to actually invoke
    the configured deploy commands.

    Pass ``--pr <number>`` to target a specific PR; in dry-run this uses
    a placeholder SHA so the operator can exercise the flow without a
    matching ``merge_actions`` row. ``--sha`` is preferred for real-run.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.deploy.orchestrator import (
        deploy_action_as_dict,
        deploy_post_merge,
        deploy_tick,
    )

    gh: Any = None
    if not dry_run:
        gh = _ensure_github_client()

    actions: list[Any]
    if pr is not None:
        action = deploy_post_merge(
            app_name,
            pr,
            sha or f"pr-{pr}-placeholder-sha",
            _FACTORY_ROOT,
            dry_run=dry_run,
            github_client=gh,
        )
        actions = [action]
    else:
        actions = deploy_tick(
            _FACTORY_ROOT,
            app_name,
            dry_run=dry_run,
            sha=sha,
            github_client=gh,
        )

    if not actions:
        console.print(
            Panel.fit(
                f"No candidate SHA to deploy for [bold]{app_name}[/bold]. "
                f"Merge a PR first or pass --sha <sha>.",
                title="deploy",
            )
        )
        return

    table = Table(title=f"deploy — app={app_name} dry_run={dry_run}")
    table.add_column("sha")
    table.add_column("status")
    table.add_column("smoke")
    table.add_column("rolled_back")
    table.add_column("error")
    for a in actions:
        d = deploy_action_as_dict(a)
        status_color = {
            True: "green",
        }.get(a.success, "yellow" if a.rolled_back else "red")
        derived_status = (
            "deployed" if a.success else ("rolled_back" if a.rolled_back else "errored")
        )
        # ``mode_blocks_deploy`` / ``deploy_disabled_in_config`` collapse
        # to "skipped" in DB; surface here too.
        if a.error in {"mode_blocks_deploy", "deploy_disabled_in_config"} or (
            a.error and a.error.startswith("mode_")
        ):
            derived_status = "skipped"
            status_color = "yellow"
        table.add_row(
            d["merged_sha"][:12],
            f"[{status_color}]{derived_status}[/{status_color}]",
            "yes" if a.smoke_passed else "no",
            "yes" if a.rolled_back else "no",
            (a.error or "")[:60],
        )
    console.print(table)


@app.command("deploys")
def deploys_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    limit: int = typer.Option(20, "--limit", help="Max rows to show (newest first)"),
) -> None:
    """List recent ``DeployAction`` rows for ``--app``."""
    from sqlmodel import Session, select

    from factory.deploy.models import DeployActionRecord
    from factory.deploy.orchestrator import _engine as _deploy_engine

    db = _FACTORY_ROOT / "state" / "factory.db"
    # ``_deploy_engine`` runs ``SQLModel.metadata.create_all`` so the
    # ``deploy_actions`` table exists even on a fresh checkout that has
    # never run a deploy yet.
    eng = _deploy_engine(db)
    with Session(eng) as session:
        rows = list(
            session.exec(
                select(DeployActionRecord)
                .where(DeployActionRecord.app == app_name)
                .order_by(DeployActionRecord.id.desc())  # type: ignore[union-attr]
            ).all()
        )
    rows = rows[:limit]

    if not rows:
        console.print(
            Panel.fit(
                f"No DeployAction rows for [bold]{app_name}[/bold].",
                title="deploys",
            )
        )
        return

    table = Table(title=f"deploys — app={app_name} (latest {len(rows)})")
    table.add_column("id", justify="right")
    table.add_column("ts")
    table.add_column("sha")
    table.add_column("status")
    table.add_column("smoke")
    table.add_column("rb")
    table.add_column("err")
    for r in rows:
        status_color = {
            "deployed": "green",
            "rolled_back": "yellow",
            "errored": "red",
            "skipped": "blue",
        }.get(r.status, "white")
        table.add_row(
            str(r.id),
            r.ts[:19],
            r.sha[:12],
            f"[{status_color}]{r.status}[/{status_color}]",
            "yes" if r.smoke_passed else "no",
            "yes" if r.rollback_triggered else "no",
            (r.error or "")[:40],
        )
    console.print(table)


@app.command("deploy-status")
def deploy_status_cmd(
    deploy_id: int = typer.Argument(..., help="DeployActionRecord id (see `factory deploys`)"),
) -> None:
    """Show the full per-step record for a single deploy action."""
    import json as _json

    from sqlmodel import Session, select

    from factory.deploy.models import DeployActionRecord
    from factory.deploy.orchestrator import _engine as _deploy_engine

    db = _FACTORY_ROOT / "state" / "factory.db"
    eng = _deploy_engine(db)
    with Session(eng) as session:
        row = session.exec(
            select(DeployActionRecord).where(DeployActionRecord.id == deploy_id)
        ).first()
    if row is None:
        console.print(f"[red]error:[/red] no deploy action with id={deploy_id}")
        raise typer.Exit(code=2)

    console.print(
        Panel.fit(
            f"[bold]app[/bold]={row.app}  [bold]sha[/bold]={row.sha}  "
            f"[bold]status[/bold]={row.status}\n"
            f"[bold]ts[/bold]={row.ts}\n"
            f"pre_deploy_duration_s={row.pre_deploy_duration_s}  "
            f"deploy_duration_s={row.deploy_duration_s}\n"
            f"health_check_passed={row.health_check_passed}  "
            f"smoke_passed={row.smoke_passed}\n"
            f"rollback_triggered={row.rollback_triggered}  "
            f"rollback_passed={row.rollback_passed}\n"
            f"error={row.error}\n"
            f"skipped_reason={row.skipped_reason}",
            title=f"deploy #{deploy_id}",
        )
    )

    steps_table = Table(title="per-phase step results")
    steps_table.add_column("#", justify="right")
    steps_table.add_column("phase")
    steps_table.add_column("exit")
    steps_table.add_column("attempts")
    steps_table.add_column("dur_s", justify="right")
    steps_table.add_column("command")
    try:
        steps = _json.loads(row.per_phase_results_json or "[]")
    except _json.JSONDecodeError:
        steps = []
    for i, s in enumerate(steps, start=1):
        exit_code = s.get("exit_code")
        color = "green" if exit_code == 0 else "red"
        steps_table.add_row(
            str(i),
            str(s.get("phase", "")),
            f"[{color}]{exit_code}[/{color}]",
            str(s.get("attempts", 1)),
            f"{float(s.get('duration_seconds') or 0.0):.2f}",
            str(s.get("command", ""))[:80],
        )
    console.print(steps_table)


@app.command("test-slop")
def test_slop_cmd(
    path: Path = typer.Option(..., "--file", exists=True, help="Path to file or directory to scan"),
) -> None:
    """Scan a file (or directory) for slop anti-patterns.

    Surfaces every finding produced by the same ``slop_detector`` the
    auto-merge ``tests-meaningful`` gate uses. Exits non-zero if any
    findings are reported — useful as a pre-commit guard.
    """
    from factory.chain.slop_detector import scan_diff, scan_file

    findings: list[Any] = []
    if path.is_file():
        findings = scan_file(path)
    elif path.is_dir():
        # Collect every plausible test file recursively.
        candidates = [
            p
            for p in path.rglob("*")
            if p.is_file() and p.suffix in {".py", ".ts", ".tsx", ".js", ".jsx"}
        ]
        findings = scan_diff([str(c) for c in candidates])

    if not findings:
        console.print(Panel.fit(f"[green]No slop found in {path}[/green]", title="test-slop"))
        return

    table = Table(title=f"slop findings in {path}")
    table.add_column("path")
    table.add_column("line")
    table.add_column("kind")
    table.add_column("why")
    for f in findings:
        table.add_row(f.path, str(f.line), f.kind, f.why_slop[:80])
    console.print(table)
    console.print(f"[red]{len(findings)} finding(s)[/red]")
    raise typer.Exit(code=1)


def _scheduled_persona_now(
    *,
    persona: str,
    app_name: str,
    dry_run: bool,
    label: str,
) -> None:
    """Shared body for the four ``factory <persona>-now`` commands.

    Loads env, validates that real-run runs have an API key available,
    then dispatches via ``run_scheduled_persona`` and prints a summary.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)
    if not dry_run:
        ok, hint = _has_any_llm_provider_key()
        if not ok:
            console.print(f"[red]error:[/red] real {label} requires an LLM provider key. " + hint)
            raise typer.Exit(code=2)
    from factory.chain.scheduled_tasks import run_scheduled_persona

    out = run_scheduled_persona(
        persona,
        app_name,
        _FACTORY_ROOT,
        dry_run=dry_run,
    )
    table = Table(title=f"{label} — app={app_name} dry_run={dry_run}")
    table.add_column("field")
    table.add_column("value")
    table.add_row("status", out.status)
    table.add_row("findings", str(out.findings_count))
    table.add_row("directions_filed", ", ".join(out.directions_filed) or "(none)")
    table.add_row("duration_s", f"{out.duration_s:.3f}")
    if out.error:
        table.add_row("error", out.error)
    console.print(table)
    if out.status == "errored":
        raise typer.Exit(code=1)


@app.command("ux-audit-now")
def ux_audit_now_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No LLM/GitHub/repo writes"),
) -> None:
    """Force-fire the UX-Auditor persona once."""
    _scheduled_persona_now(
        persona="ux_auditor", app_name=app_name, dry_run=dry_run, label="ux-audit"
    )


@app.command("security-now")
def security_now_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No LLM/GitHub/repo writes"),
) -> None:
    """Force-fire the Security persona once."""
    _scheduled_persona_now(persona="security", app_name=app_name, dry_run=dry_run, label="security")


@app.command("security-scan")
def security_scan_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No LLM/GitHub/repo writes"),
) -> None:
    """Alias for ``security-now`` (matches the Phase 6 spec naming)."""
    _scheduled_persona_now(
        persona="security", app_name=app_name, dry_run=dry_run, label="security-scan"
    )


@app.command("schedules")
def schedules_cmd() -> None:
    """List cron schedules with last-run and next-fire times.

    Reads from ``factory_settings.yaml`` (or built-in defaults) and the
    ``cron_schedules`` table for last-run timestamps. Pure read; no
    dispatch happens.
    """
    from factory.scheduler.cron import (
        get_schedule_row,
        load_schedules,
        next_fire,
    )

    schedules = load_schedules(_FACTORY_ROOT)
    db = _FACTORY_ROOT / "state" / "factory.db"
    table = Table(title="schedules")
    table.add_column("name")
    table.add_column("persona")
    table.add_column("cron")
    table.add_column("last_run")
    table.add_column("last_status")
    table.add_column("next_fire (UTC)")
    for s in schedules:
        row = get_schedule_row(s.name, db)
        last_run = (row.last_run if row else None) or "(never)"
        last_status = (row.last_status if row else None) or "-"
        try:
            nxt = next_fire(s).isoformat()
        except Exception as exc:  # noqa: BLE001
            nxt = f"[invalid: {exc}]"
        table.add_row(s.name, s.persona, s.cron_expr, last_run, last_status, nxt)
    console.print(table)


# --------------------------------------------------------------------------- #
# Phase-7 commands: status-sync. (``idle-check`` was deleted 2026-08-07,
# 019 AC5, along with ``factory/chain/idle.py``.)
# --------------------------------------------------------------------------- #


@app.command("status-sync")
def status_sync_cmd(
    app_name: str = typer.Option(..., "--app", help="App name"),
    dry_run: bool = typer.Option(False, "--dry-run", help="No GitHub calls; print body only"),
) -> None:
    """Update the pinned ``factory-status`` GitHub issue for ``--app``.

    Recommended cron: every 5 minutes. In dry-run, no GH API call is
    made; the composed body is printed for inspection.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.chain.factory_status import compose_status_body, update_status_issue

    body = compose_status_body(app_name, _FACTORY_ROOT)
    if dry_run:
        console.print(Panel(body, title=f"factory-status (dry-run) — app={app_name}"))
        return

    gh = _ensure_github_client()
    number = update_status_issue(
        app=app_name,
        software_factory_root=_FACTORY_ROOT,
        github_client=gh,
    )
    console.print(
        Panel.fit(
            f"Updated [bold]factory-status[/bold] issue #{number} for app=[bold]{app_name}[/bold]",
            title="status-sync",
            style="green",
        )
    )


@app.command("webhook-serve")
def webhook_serve(
    port: int = typer.Option(9000, "--port", help="Bind port for the webhook listener"),
    host: str = typer.Option("0.0.0.0", "--host", help="Bind host"),
) -> None:
    """Boot the GitHub webhook receiver via uvicorn."""
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)
    try:
        import uvicorn
    except ImportError as exc:
        console.print(f"[red]error:[/red] uvicorn not installed: {exc}")
        raise typer.Exit(code=2) from exc

    if not os.environ.get("GITHUB_WEBHOOK_SECRET"):
        console.print(
            "[yellow]warning:[/yellow] GITHUB_WEBHOOK_SECRET is unset. "
            "Webhooks will be rejected with 503 until you set it."
        )

    console.print(
        Panel.fit(
            f"Booting webhook listener on [bold]{host}:{port}[/bold]\n"
            "For local dev with smee:\n"
            f"  smee --port {port} --url <smee URL>\n"
            "POST endpoint: /webhook/github  •  Health: /health",
            title="webhook-serve",
        )
    )
    uvicorn.run("factory.webhook.github:app", host=host, port=port, log_level="info")


# --------------------------------------------------------------------------- #
# Phase FMS-1 commands: manager (signal inspection)
# --------------------------------------------------------------------------- #


manager_app = typer.Typer(help="FMS manager sub-commands.")
app.add_typer(manager_app, name="manager")

signals_app = typer.Typer(help="Inspect structured event streams.")
manager_app.add_typer(signals_app, name="signals")


def _parse_duration(s: str) -> float:
    """Parse a simple duration string into seconds.

    Accepted formats: ``30s``, ``15m``, ``2h``, ``1d``.
    Falls back to treating the raw value as seconds if no suffix.
    """
    s = s.strip().lower()
    if s.endswith("d"):
        return float(s[:-1]) * 86400
    if s.endswith("h"):
        return float(s[:-1]) * 3600
    if s.endswith("m"):
        return float(s[:-1]) * 60
    if s.endswith("s"):
        return float(s[:-1])
    return float(s)


@signals_app.command("dump")
def signals_dump_cmd(
    since: str = typer.Option("1h", "--since", help="Duration to look back (e.g. 1h, 30m, 2d)"),
    stream: str | None = typer.Option(
        None, "--stream", help="Only show events from this stream (e.g. ticks, runs)"
    ),
    fmt: str = typer.Option("human", "--format", help="Output format: human | json"),
) -> None:
    """Print all events from the signal streams since ``--since``, interleaved by ts."""
    import json as _json
    from datetime import UTC as _UTC
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    from factory.manager.signals import _events_dir

    events_dir = _events_dir(_FACTORY_ROOT)
    if not events_dir.exists():
        console.print(
            Panel.fit(
                f"No events directory at [bold]{events_dir}[/bold]. "
                "Run [bold]factory tick --app <app> --dry-run[/bold] first.",
                title="signals dump",
            )
        )
        return

    try:
        window_s = _parse_duration(since)
    except ValueError:
        console.print(f"[red]error:[/red] could not parse --since={since!r}")
        raise typer.Exit(code=2) from None

    cutoff = _dt.now(_UTC) - _td(seconds=window_s)

    # Collect all .ndjson files in the events directory.
    stream_files = sorted(events_dir.glob("*.ndjson"))
    if stream:
        stream_files = [f for f in stream_files if f.stem == stream]
    if not stream_files:
        console.print(f"[dim]No event streams found (stream={stream!r}).[/dim]")
        return

    all_events: list[tuple[str, str, dict[str, Any]]] = []  # (ts_str, stream_name, record)
    for sf in stream_files:
        try:
            lines = sf.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                rec = _json.loads(line)
            except _json.JSONDecodeError:
                continue
            ts_str = rec.get("ts") or ""
            try:
                ts_dt = _dt.fromisoformat(ts_str)
                if ts_dt.tzinfo is None:
                    ts_dt = ts_dt.replace(tzinfo=_UTC)
            except (TypeError, ValueError):
                continue
            if ts_dt < cutoff:
                continue
            all_events.append((ts_str, sf.stem, rec))

    if not all_events:
        console.print(f"[dim]No events in the last {since}.[/dim]")
        return

    # Sort by ts ascending.
    all_events.sort(key=lambda x: x[0])

    for ts_str, stream_name, rec in all_events:
        if fmt == "json":
            # Use plain print so Rich doesn't wrap or markup the JSON.
            print(_json.dumps(rec))
        else:
            event = rec.get("event", "?")
            ts_short = ts_str[:19].replace("T", " ") if ts_str else "?"
            # Build a concise summary from the most useful fields.
            highlights: list[str] = []
            for key in (
                "story_id",
                "persona",
                "success",
                "duration_s",
                "app",
                "kind",
                "result",
                "tick_id",
                "pr_number",
            ):
                if rec.get(key) is not None:
                    highlights.append(f"{key}={rec[key]!r}")
            summary = " ".join(highlights) if highlights else ""
            console.print(f"[{ts_short}] {stream_name}/{event} {summary}")


# --------------------------------------------------------------------------- #
# Phase 8 commands: manager circuit-breaker (circuit-breaker management)
# --------------------------------------------------------------------------- #

circuit_breaker_app = typer.Typer(help="Circuit-breaker management.")
manager_app.add_typer(circuit_breaker_app, name="circuit-breaker")


@circuit_breaker_app.command("status")
def cb_status_cmd() -> None:
    """Print current circuit-breaker state (tripped or not, halt_until, last trip)."""
    from factory.manager.circuit_breaker import get_state, is_tripped

    state = get_state(root=_FACTORY_ROOT)
    tripped = is_tripped(root=_FACTORY_ROOT)
    if state is None:
        console.print("[green]Circuit breaker: not tripped[/green]")
        return

    halt_until_str = state.get("halt_until", "?")
    regression_sha = state.get("regression_commit", "?")[:12]
    regression_msg = state.get("regression_commit_message", "?")[:80]
    revert_branch = state.get("revert_branch", "?")
    pr_number = state.get("revert_pr_number")
    tripped_at = state.get("tripped_at", "?")

    status_color = "red" if tripped else "yellow"
    status_label = (
        "TRIPPED (halting apply pipeline)" if tripped else "TRIPPED (halt window expired)"
    )

    console.print(
        Panel.fit(
            f"[{status_color}]{status_label}[/{status_color}]\n\n"
            f"tripped_at:   {tripped_at}\n"
            f"halt_until:   {halt_until_str}\n"
            f"regression:   {regression_sha}  {regression_msg}\n"
            f"revert_branch: {revert_branch}\n"
            f"revert_pr:    {f'#{pr_number}' if pr_number else '(none)'}",
            title="circuit-breaker status",
        )
    )


@circuit_breaker_app.command("check")
def cb_check_cmd(
    test_command: str = typer.Option(
        "uv run pytest -q",
        "--test-command",
        help="Command to run the test suite.",
    ),
) -> None:
    """Run check_and_trip once.  If tests fail and HEAD is a tracked manager commit, trip."""
    from factory.manager.circuit_breaker import check_and_trip

    result = check_and_trip(root=_FACTORY_ROOT, test_command=test_command)
    if result is None:
        console.print(
            "[green]Circuit breaker check: tests passed (or no tracked manager commit at HEAD).[/green]"
        )
    else:
        console.print(
            Panel.fit(
                f"[bold red]Circuit breaker TRIPPED[/bold red]\n\n"
                f"regression_commit: {result.get('regression_commit', '?')[:12]}\n"
                f"revert_branch:     {result.get('revert_branch', '?')}\n"
                f"revert_pr_number:  {result.get('revert_pr_number')}\n"
                f"halt_until:        {result.get('halt_until', '?')}",
                title="circuit-breaker check",
            )
        )
        # Narrow automatic emergency-stop trigger (019 safety-mechanism
        # rewire): a self-edit commit that regresses main is exactly the
        # "clearly warrants stopping everything" condition — a chain-authored
        # change already broke the test suite on ``main``, so no further
        # self-edit should be allowed to land until an operator has reviewed
        # the auto-revert PR. This does NOT invent a new detection surface;
        # it only reacts to a trip this command already computed. Best-effort
        # and never masks the trip itself: a halt-request failure is printed
        # but the command still reports TRIPPED via the exit code below.
        try:
            from factory.manager.halt import is_halted, request_halt

            if not is_halted(root=_FACTORY_ROOT):
                request_halt(
                    root=_FACTORY_ROOT,
                    concern_title="circuit_breaker_tripped",
                    proposal_path=None,
                    reason=(
                        f"circuit breaker tripped: regression_commit="
                        f"{result.get('regression_commit', '?')[:12]}; "
                        f"revert_branch={result.get('revert_branch', '?')}. "
                        "Review the auto-revert PR, then `factory manager "
                        "circuit-breaker reset` and `factory resume`."
                    ),
                )
                console.print(
                    "[bold red]Factory HALTED[/bold red] — a self-edit regression must not "
                    "be followed by another self-edit before operator review."
                )
        except Exception as exc:  # noqa: BLE001 - never mask the trip itself
            console.print(f"[yellow]warning:[/yellow] could not halt after trip: {exc!r}")
        raise typer.Exit(code=1)


@circuit_breaker_app.command("reset")
def cb_reset_cmd(
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt"),
    reason: str | None = typer.Option(None, "--reason", help="Optional reason for reset"),
) -> None:
    """Operator-only: clear the circuit breaker after reviewing the revert PR.

    Archives the current state to state/.circuit_breaker_history.json and
    removes state/circuit_breaker.json.
    """
    from factory.manager.circuit_breaker import get_state, reset

    state = get_state(root=_FACTORY_ROOT)
    if state is None:
        console.print("[green]Circuit breaker: not tripped — nothing to reset.[/green]")
        return

    regression_sha = state.get("regression_commit", "?")[:12]
    console.print(
        Panel.fit(
            f"Circuit breaker is tripped for regression_commit=[bold]{regression_sha}[/bold].\n"
            f"halt_until: {state.get('halt_until', '?')}\n\n"
            "Ensure you have reviewed and merged (or closed) the revert PR before resetting.",
            title="circuit-breaker reset",
            style="yellow",
        )
    )
    if not yes:
        confirmed = typer.confirm(
            "Clear the circuit breaker and resume the apply pipeline?", default=False
        )
        if not confirmed:
            console.print("[yellow]Aborted.[/yellow]")
            raise typer.Exit(code=0)

    archived = reset(root=_FACTORY_ROOT, cleared_by="operator", reason=reason)
    console.print(
        Panel.fit(
            f"[bold green]Circuit breaker cleared.[/bold green]\n"
            f"Archived to state/.circuit_breaker_history.json\n"
            f"cleared_at: {archived.get('cleared_at', '?')}",
            title="circuit-breaker reset",
        )
    )


# --------------------------------------------------------------------------- #
# Phase 9 commands: manager refresh-context (factory self-context refresh)
# --------------------------------------------------------------------------- #


@manager_app.command("refresh-context")
def refresh_context_cmd(
    module: str | None = typer.Option(
        None,
        "--module",
        help=(
            "Refresh only this module. Valid values: "
            "orchestrator, personas, state-machine, observability, dispatch, manager. "
            "Default: refresh all six."
        ),
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Assemble LLM prompt but do NOT call the LLM or write any files.",
    ),
) -> None:
    """Refresh factory self-context modules under apps/factory/context/modules/.

    Generates (or refreshes) six Markdown modules that describe the factory's
    own architecture. The L3 Diagnostician reads these when producing proposals
    so its architectural understanding stays current.

    Modules: orchestrator, personas, state-machine, observability, dispatch, manager.
    """
    load_dotenv()
    load_dotenv(_FACTORY_ROOT / ".env", override=False)

    from factory.manager.self_context import ALL_MODULES, refresh_factory_context

    if module is not None and module not in ALL_MODULES:
        console.print(
            f"[red]error:[/red] unknown module {module!r}. Valid: {', '.join(ALL_MODULES)}"
        )
        raise typer.Exit(code=2)

    if not dry_run:
        ok, hint = _has_any_llm_provider_key()
        if not ok:
            console.print("[red]error:[/red] real refresh requires an LLM provider key. " + hint)
            raise typer.Exit(code=2)

    mode_label = "[yellow]DRY-RUN[/yellow]" if dry_run else "[green]REAL RUN[/green]"
    target_label = module or "all 6 modules"
    console.print(
        Panel.fit(
            f"Refreshing factory context modules: [bold]{target_label}[/bold]\n"
            f"mode={mode_label}\n"
            f"output: apps/factory/context/modules/",
            title="manager refresh-context",
        )
    )

    result = refresh_factory_context(
        root=_FACTORY_ROOT,
        module=module,
        dry_run=dry_run,
    )

    table = Table(title=f"refresh-context results (dry_run={dry_run})")
    table.add_column("module")
    table.add_column("status")
    table.add_column("detail")
    for r in result["results"]:
        mod_name = r.get("module", "?")
        if r.get("success"):
            skipped = r.get("skipped_reason")
            if skipped:
                status = f"[yellow]skipped ({skipped})[/yellow]"
                detail = ""
            else:
                status = "[green]ok[/green]"
                detail = r.get("path", "")
        else:
            status = "[red]failed[/red]"
            detail = (r.get("error") or "")[:80]
        table.add_row(mod_name, status, detail)
    console.print(table)

    refreshed = result.get("refreshed", 0)
    failed = result.get("failed", 0)
    console.print(f"refreshed={refreshed} failed={failed}")
    if failed:
        raise typer.Exit(code=1)


# --------------------------------------------------------------------------- #
# Phase 10 commands: factory apps (configured-app discovery)
# --------------------------------------------------------------------------- #


@app.command("apps")
def apps_cmd(
    json_output: bool = typer.Option(
        False, "--json", help="Emit a JSON array to stdout instead of the table."
    ),
) -> None:
    """List every configured app (apps/*/config.yaml) with key operator fields.

    Read-only: never mutates config, filesystem, or runtime state.
    """
    import json

    from factory.app_config import list_apps

    rows = list_apps(_FACTORY_ROOT)

    if json_output:
        typer.echo(json.dumps(rows, default=str))
        raise typer.Exit(code=0)

    if not rows:
        console.print("[dim]No configured apps found (no apps/*/config.yaml).[/dim]")
        raise typer.Exit(code=0)

    table = Table(title="Configured Apps")
    table.add_column("name")
    table.add_column("repo")
    table.add_column("self_tick_enabled")
    table.add_column("deploy.enabled")

    for r in rows:
        table.add_row(
            str(r["name"]),
            str(r["repo"]),
            str(r["self_tick_enabled"]),
            str(r["deploy_enabled"]),
        )

    console.print(table)


# --------------------------------------------------------------------------- #
# Phase 10 commands: factory version (git-state reporting)
# --------------------------------------------------------------------------- #


@app.command("version")
def version_cmd() -> None:
    """Print the factory repo's git SHA (short), branch name, and dirty flag.

    Read-only: no writes, no network — only local git metadata reads.
    """
    from factory.git_state import get_git_state

    state = get_git_state(_FACTORY_ROOT)
    if state.dirty:
        parts = []
        if state.staged:
            parts.append(f"{state.staged} staged")
        if state.unstaged:
            parts.append(f"{state.unstaged} unstaged")
        if state.untracked:
            parts.append(f"{state.untracked} untracked")
        dirty_flag = " (dirty: " + ", ".join(parts) + ")"
    else:
        dirty_flag = ""
    typer.echo(f"{state.sha} {state.branch}{dirty_flag}")
    raise typer.Exit(code=0)


personas_app = typer.Typer(help="Persona prompt management.")
app.add_typer(personas_app, name="personas")


@personas_app.command("validate")
def personas_validate_cmd(
    persona: str | None = typer.Option(None, "--persona", help="Validate only this persona"),
    strict: bool = typer.Option(False, "--strict", help="Treat warnings as failures too"),
) -> None:
    """Check persona prompt files for structural and contract problems.

    Persona prompts are inputs to every paid model call and the chain's entire
    behaviour depends on them, yet nothing validated them — the only constraint
    was that the file existed.

    The check that matters most is ``contract_collision``: a prompt that
    demonstrates a value outside a field's real enum (e.g. ``"scope":
    "orphan"`` when the contract allows backend/frontend/test). Dev cannot tell
    an invented example token from a live contract value, implements the
    example, and the reviewer correctly rejects it every round — structural
    non-convergence with no bug in either model. That is what happened to story
    14.

    Exit 0 when clean, 1 on errors (or on warnings with --strict).
    """
    from factory.personas.validator import ERROR, validate_all, validate_persona

    if persona:
        findings = validate_persona(persona)
        checked = 1
    else:
        report = validate_all()
        findings = report.findings
        checked = report.checked

    errors = [f for f in findings if f.severity == ERROR]
    warnings = [f for f in findings if f.severity != ERROR]

    style = "red" if errors else ("yellow" if warnings else "green")
    console.print(
        Panel.fit(
            f"[{style}]checked={checked}  errors={len(errors)}  warnings={len(warnings)}[/{style}]",
            title="personas — validate",
        )
    )

    if findings:
        table = Table(title="findings")
        table.add_column("severity")
        table.add_column("persona")
        table.add_column("code")
        table.add_column("detail")
        for finding in [*errors, *warnings]:
            colour = "red" if finding.severity == ERROR else "yellow"
            table.add_row(
                f"[{colour}]{finding.severity}[/{colour}]",
                finding.persona,
                finding.code,
                finding.message,
            )
        console.print(table)
    else:
        console.print("[green]All persona files are structurally valid.[/green]")

    if errors or (strict and warnings):
        raise typer.Exit(code=1)


@app.command("audit-chain")
def audit_chain_cmd(
    stream: str | None = typer.Option(
        None, "--stream", help="Verify only this stream (default: every stream present)"
    ),
    limit: int = typer.Option(10, "--limit", "-n", help="Max problems to print per stream"),
) -> None:
    """Verify the tamper-evident hash chain over ``state/events/*.ndjson``.

    The event streams are the factory's memory of itself — the FMS reads them to
    decide what is wrong, and an operator reads them to decide whether the FMS
    was right. Each record now carries ``chain_id``/``seq``/``prev_hash``/
    ``entry_hash``, so an edited, deleted, reordered, or foreign row is
    detectable instead of indistinguishable from real history.

    Benign conditions are reported SEPARATELY from tampering, because conflating
    them would make this cry wolf on every deployment:

    * ``unchained_legacy_rows`` — written before chaining existed. Expected.
    * ``truncated_by_rotation`` — size-based rotation dropped an old segment.
    * ``seq_gap`` — a jump mid-stream, usually a rotation boundary.
    * ``broken_link`` / ``foreign_chain_id`` / ``corrupt_entry`` — history was
      altered, or a row came from a different origin (e.g. a test run's chain).

    Exit code 0 unless a genuine tamper verdict is found, then 1.
    """
    from factory.observability.audit_chain import (
        TAMPER_VERDICTS,
        chain_id_for,
        known_streams,
        verify_stream,
    )

    events_dir = _FACTORY_ROOT / "state" / "events"
    if not events_dir.exists():
        console.print(f"[yellow]no event streams at {events_dir}[/yellow]")
        raise typer.Exit(code=0)

    streams = [stream] if stream else known_streams(events_dir)
    if not streams:
        console.print("[yellow]no streams found to verify[/yellow]")
        raise typer.Exit(code=0)

    expected = chain_id_for(events_dir)
    console.print(Panel.fit(f"chain_id={expected}\nstreams={len(streams)}", title="audit-chain"))

    table = Table(title="chain verification")
    table.add_column("stream")
    table.add_column("records", justify="right")
    table.add_column("chained", justify="right")
    table.add_column("legacy", justify="right")
    table.add_column("verdict")

    tampered: list[Any] = []
    for name in streams:
        report = verify_stream(name, events_dir=events_dir, expected_chain_id=expected)
        if report.total_records == 0:
            continue
        if report.tampered:
            tampered.append(report)
            colour = "red"
        elif report.verdicts:
            colour = "yellow"
        else:
            colour = "green"
        table.add_row(
            report.stream,
            str(report.total_records),
            str(report.chained_records),
            str(report.unchained_records),
            f"[{colour}]{', '.join(report.verdicts) or 'ok'}[/{colour}]",
        )
    console.print(table)

    if not tampered:
        console.print(
            "[green]No tampering detected. Any verdicts above are benign "
            "(legacy rows / rotation).[/green]"
        )
        raise typer.Exit(code=0)

    for report in tampered:
        problems = [p for p in report.problems if p.get("verdict") in TAMPER_VERDICTS]
        console.print(
            Panel.fit(
                "\n".join(
                    f"[{p.get('ts') or '?'}] {p['verdict']}: {p['detail']}"
                    for p in problems[:limit]
                )
                or "(no detail)",
                title=f"[red]TAMPER — {report.stream}[/red]",
            )
        )
        if len(problems) > limit:
            console.print(f"[dim]... {len(problems) - limit} more (raise --limit)[/dim]")


@app.command("conformance")
def conformance_cmd(
    app_name: str | None = typer.Option(None, "--app", help="Only check this app's stories"),
    story: int | None = typer.Option(None, "--story", help="Only check this story id"),
    since: str | None = typer.Option(
        None, "--since", help="Only report findings at/after this ISO-8601 timestamp"
    ),
    limit: int = typer.Option(40, "--limit", "-n", help="Max findings to print"),
) -> None:
    """Replay the control-plane trace and check it against the abstract model.

    Answers "did the running code emit a trace the model accepts?" — not "does
    the state machine look right". Reads ``state/events/state_writes.ndjson``
    (every story state change, emitted by an ORM listener so no writer can
    escape it) and judges each hop against
    ``factory/observability/conformance_model.yaml``.

    Two finding kinds, both reported, neither blocking a merge:

    * ``illegal_transition`` — a sanctioned writer produced a state it may not,
      or a story skipped a whole phase.
    * ``coverage_breach`` — an undeclared writer changed control-plane state, or
      the write could not be attributed. This is the load-bearing check: without
      it, conformance only validates the paths someone remembered to declare and
      silently blesses everything else.

    Exit code 0 when conformant, 1 when there are findings, 2 on a bad model.
    """
    from factory.observability.conformance import (
        COVERAGE_BREACH,
        ILLEGAL_TRANSITION,
        check_live_trace,
    )

    try:
        report = check_live_trace(software_factory_root=_FACTORY_ROOT, app=app_name, story_id=story)
    except (ValueError, OSError) as exc:
        console.print(f"[red]error:[/red] conformance model unusable: {exc}")
        raise typer.Exit(code=2) from exc

    findings = report.findings
    if since:
        findings = [f for f in findings if (f.ts or "") >= since]

    counts = "  ".join(f"{k}={v}" for k, v in report.counts.items()) or "(no writes recorded)"
    style = "green" if not findings else "red"
    console.print(
        Panel.fit(
            f"[{style}]checked={report.checked}  findings={len(findings)}[/{style}]\n{counts}",
            title="conformance — control-plane trace",
        )
    )

    if report.checked == 0:
        # Distinguish "nothing recorded" from "the filter matched nothing" — the
        # two look identical in the counts and mean very different things.
        if app_name or story is not None:
            scope = f"--app {app_name}" if app_name else f"--story {story}"
            console.print(
                f"[yellow]No state writes matched {scope}. The stream may hold "
                "writes for other stories — re-run without the filter to see "
                "them.[/yellow]"
            )
        else:
            console.print(
                "[yellow]No state writes recorded yet. The trace is emitted when a "
                "story's state actually changes — run a tick that advances one, or "
                "check that state/events/state_writes.ndjson exists.[/yellow]"
            )
        raise typer.Exit(code=0)

    if not findings:
        console.print("[green]Trace is conformant: every state change is accounted for.[/green]")
        raise typer.Exit(code=0)

    table = Table(title="conformance findings")
    table.add_column("verdict")
    table.add_column("story", justify="right")
    table.add_column("app")
    table.add_column("from -> to")
    table.add_column("writer")
    for finding in findings[:limit]:
        colour = "red" if finding.verdict == ILLEGAL_TRANSITION else "yellow"
        table.add_row(
            f"[{colour}]{finding.verdict}[/{colour}]",
            str(finding.story_id),
            str(finding.app or ""),
            f"{finding.from_state} -> {finding.to_state}",
            finding.writer,
        )
    console.print(table)

    if len(findings) > limit:
        console.print(f"[dim]... {len(findings) - limit} more (raise --limit)[/dim]")

    if report.unknown_writers:
        console.print(
            Panel.fit(
                "[yellow]Undeclared writers seen in the trace:\n  "
                + "\n  ".join(report.unknown_writers)
                + "\n\nEach is a control-plane path the model does not know about. "
                "Either it is legitimate — add it to allowed_direct_writes in "
                "factory/observability/conformance_model.yaml with a rationale — "
                "or it is a bug.[/yellow]",
                title=f"conformance — {COVERAGE_BREACH}",
            )
        )

    # One line per distinct finding shape; the table above is the summary.
    seen: set[str] = set()
    for finding in findings:
        if finding.reason and finding.reason not in seen:
            seen.add(finding.reason)
            console.print(f"[dim]- {finding.reason}[/dim]")

    raise typer.Exit(code=1)
