"""``factory tui`` — Textual app driving the live dashboard.

Polls ``state/factory.db`` every ~1s, refreshes the rendered widgets in
place. No long-lived DB connections; each tick is a fresh read.

Sections (top to bottom):

1. **Header** — mode badge, ACTIVE/IDLE pulse, 24h + 7d spend gauges,
   hourly sparkline.
2. **Directions in flight** — one panel per direction with a progress bar
   showing handler-completion ratio, plus EBS P50/P75/P95 ETAs and the
   persona currently mid-flight on each story.
3. **Stories in flight** — flat table of non-terminal stories.
4. **Velocity** — per-(persona, model_tier) median + interquartile
   sparkline; gates "insufficient data" until N>=5 samples.
5. **Recent runs** — last 10 LLM calls.

Keys: ``q``/``Q``/``Ctrl+C`` quit. ``r`` recomputes baselines on demand
(useful after a fresh batch of stories lands).
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from rich.console import Group
from rich.panel import Panel
from rich.progress_bar import ProgressBar
from rich.table import Table
from rich.text import Text
from textual.app import App, ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Footer, Header, Static

from factory.observability.queries import (
    DirectionProgress,
    FactorySnapshot,
    collect_snapshot,
)

# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #


def _fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    if seconds < 60:
        return f"{seconds:.1f}s"
    if seconds < 3600:
        m, s = divmod(int(seconds), 60)
        return f"{m}m{s:02d}s"
    h, rem = divmod(int(seconds), 3600)
    m = rem // 60
    return f"{h}h{m:02d}m"


def _fmt_money(usd: float) -> str:
    return f"${usd:,.2f}"


def _sparkline(values: list[float]) -> str:
    """ASCII sparkline using block-eighth characters."""
    if not values:
        return ""
    blocks = " ▁▂▃▄▅▆▇█"
    vmax = max(values) or 1.0
    out = []
    for v in values:
        idx = 0 if vmax == 0 else min(len(blocks) - 1, int(v / vmax * (len(blocks) - 1)))
        out.append(blocks[idx])
    return "".join(out)


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


# --------------------------------------------------------------------------- #
# Renderers — each returns a Rich renderable for a section
# --------------------------------------------------------------------------- #


def render_header(snap: FactorySnapshot) -> Panel:
    spend_24h_cap_str = ""
    if snap.spend_24h_cap_usd is not None:
        spend_24h_cap_str = f" / {_fmt_money(snap.spend_24h_cap_usd)}"
    active_label = (
        Text(" ● ACTIVE ", style="bold black on green")
        if snap.active
        else Text(" ○ IDLE   ", style="bold black on grey50")
    )
    mode_style = "bold yellow" if snap.mode != "normal" else "bold green"

    # Two-line header
    line1 = Text.assemble(
        ("Software Factory", "bold cyan"),
        "   ",
        ("mode=", "dim"),
        (snap.mode, mode_style),
        "   ",
        active_label,
        "   ",
        (
            snap.now.astimezone().strftime("%Y-%m-%d %H:%M:%S"),
            "dim",
        ),
    )
    line2 = Text.assemble(
        ("Spend  ", "dim"),
        ("24h: ", "dim"),
        (_fmt_money(snap.spend_24h_usd), "bold"),
        (spend_24h_cap_str, "dim"),
        ("    7d: ", "dim"),
        (_fmt_money(snap.spend_7d_usd), "bold"),
        ("    sparkline (hourly): ", "dim"),
        (_sparkline(snap.spend_sparkline_hourly), "cyan"),
    )
    return Panel(
        Group(line1, line2),
        border_style="cyan" if snap.active else "grey50",
        title="factory",
        title_align="left",
    )


def render_apps(snap: FactorySnapshot) -> Panel:
    if not snap.apps:
        return Panel(Text("(no apps configured)", style="dim"), title="apps")
    table = Table(box=None, expand=True, show_edge=False, padding=(0, 1))
    table.add_column("app", style="bold")
    table.add_column("in-flight", justify="right")
    table.add_column("last run", justify="right")
    table.add_column("24h spend", justify="right")
    table.add_column("7d spend", justify="right")
    table.add_column("state", justify="left")
    for a in snap.apps:
        last = (
            "—"
            if a.last_run_ts is None
            else _fmt_duration(
                (datetime.now(UTC) - a.last_run_ts).total_seconds()
            )
            + " ago"
        )
        state_text = (
            Text("● working", style="bold green")
            if a.active
            else Text("◐ idle", style="dim yellow")
        )
        table.add_row(
            a.name,
            str(a.in_flight_stories),
            last,
            _fmt_money(a.spend_24h_usd),
            _fmt_money(a.spend_7d_usd),
            state_text,
        )
    return Panel(table, title="apps", title_align="left")


def _direction_panel(d: DirectionProgress) -> Panel:
    # Progress bar — completed handlers / total handlers.
    completed_h = d.completed_handlers
    total_h = max(1, d.total_handlers)
    pct_h = completed_h / total_h
    pb = ProgressBar(total=total_h, completed=completed_h, width=40)

    eta_line: Text
    if d.eta is None:
        eta_line = Text("ETA  (estimator unavailable)", style="dim")
    elif d.eta.insufficient_data:
        eta_line = Text(
            f"ETA  insufficient data — {d.eta.reason}",
            style="dim yellow",
        )
    else:
        eta_line = Text.assemble(
            ("ETA  ", "dim"),
            ("P50 ", "dim"),
            (_fmt_duration(d.eta.p50_seconds), "bold green"),
            ("   P75 ", "dim"),
            (_fmt_duration(d.eta.p75_seconds), "bold yellow"),
            ("   P95 ", "dim"),
            (_fmt_duration(d.eta.p95_seconds), "bold red"),
            ("   (", "dim"),
            (f"N={d.eta.sample_count}", "dim"),
            (", ", "dim"),
            (f"{d.eta.iterations} iters", "dim"),
            (")", "dim"),
        )

    stories_line = Text.assemble(
        ("stories: ", "dim"),
        (f"{d.completed_stories}/{d.total_stories}", "bold"),
        ("   points: ", "dim"),
        (f"{d.completed_points}/{d.total_points}", "bold"),
        ("   handlers: ", "dim"),
        (f"{completed_h}/{total_h}", "bold"),
        ("   ", ""),
        (f"({pct_h * 100:.0f}%)", "dim"),
    )

    # Current activity per story
    current_lines: list[Text] = []
    for s in d.stories:
        # Find a live handler for this story, if any
        marker = "●" if s.state not in {"pr_open", "ci_pending", "ci_green",
                                        "ready_for_merge", "deploy_pending",
                                        "deployed"} else "✓"
        state_style = (
            "green" if s.state.startswith("deployed") else
            "dim" if marker == "✓" else "yellow"
        )
        line = Text.assemble(
            (f"  {marker} ", state_style),
            (f"#{s.id} ", "dim"),
            (_truncate(s.slug, 42), "bold"),
            ("  ", ""),
            (s.state, "dim"),
            ("  pts=", "dim"),
            (str(s.points or "?"), "dim"),
        )
        current_lines.append(line)

    title = f"{d.app} / {d.direction_id}"
    if d.title and d.title != d.direction_id:
        title += f" — {_truncate(d.title, 48)}"
    border = "green" if d.current_personas else "cyan"
    return Panel(
        Group(stories_line, pb, eta_line, *current_lines),
        title=title,
        title_align="left",
        border_style=border,
    )


def render_directions(snap: FactorySnapshot) -> Panel:
    if not snap.directions:
        return Panel(
            Text(
                "No directions in flight. Spawn one with `factory new-direction --app <app>`.",
                style="dim",
            ),
            title="directions in flight",
        )
    inner = Group(*[_direction_panel(d) for d in snap.directions])
    return Panel(inner, title="directions in flight", title_align="left")


def render_live(snap: FactorySnapshot) -> Panel:
    if not snap.live_handlers:
        return Panel(
            Text("(no handlers currently executing)", style="dim"),
            title="live handlers",
            title_align="left",
        )
    table = Table(box=None, expand=True, show_edge=False, padding=(0, 1))
    table.add_column("persona", style="bold")
    table.add_column("model")
    table.add_column("story", justify="right")
    table.add_column("app")
    table.add_column("elapsed", justify="right")
    for h in snap.live_handlers:
        table.add_row(
            h.persona,
            _truncate(h.model, 30),
            f"#{h.story_id}" if h.story_id else "—",
            h.app or "—",
            _fmt_duration(h.elapsed_seconds),
        )
    return Panel(table, title="live handlers", title_align="left", border_style="green")


def render_velocity(snap: FactorySnapshot) -> Panel:
    if not snap.velocity:
        return Panel(
            Text(
                "No velocity data yet — accumulating samples from completed runs.",
                style="dim",
            ),
            title="velocity (last 30d)",
            title_align="left",
        )
    table = Table(box=None, expand=True, show_edge=False, padding=(0, 1))
    table.add_column("persona", style="bold")
    table.add_column("tier")
    table.add_column("n", justify="right")
    table.add_column("median v", justify="right")
    table.add_column("p25 v", justify="right")
    table.add_column("p75 v", justify="right")
    table.add_column("est/actual interpretation")
    for v in snap.velocity:
        interp = (
            "faster than baseline"
            if v.median_velocity > 1.05
            else "slower than baseline"
            if v.median_velocity < 0.95
            else "tracks baseline"
        )
        table.add_row(
            v.persona,
            v.model_tier,
            str(v.sample_count),
            f"{v.median_velocity:.2f}",
            f"{v.p25_velocity:.2f}",
            f"{v.p75_velocity:.2f}",
            interp,
        )
    return Panel(table, title="velocity (last 30d)", title_align="left")


def render_runs(snap: FactorySnapshot) -> Panel:
    if not snap.recent_runs:
        return Panel(Text("(no runs recorded yet)", style="dim"), title="recent runs")
    table = Table(box=None, expand=True, show_edge=False, padding=(0, 1))
    table.add_column("ts", style="dim")
    table.add_column("persona", style="bold")
    table.add_column("model")
    table.add_column("in", justify="right")
    table.add_column("out", justify="right")
    table.add_column("cost", justify="right")
    table.add_column("dur", justify="right")
    table.add_column("ok", justify="center")
    for r in snap.recent_runs:
        ok = Text("✓", style="green") if r.success else Text("✗", style="red")
        table.add_row(
            r.ts.astimezone().strftime("%H:%M:%S"),
            r.persona,
            _truncate(r.model, 28),
            f"{r.tokens_in:,}",
            f"{r.tokens_out:,}",
            _fmt_money(r.cost_usd),
            _fmt_duration(r.duration_s),
            ok,
        )
    return Panel(table, title="recent runs", title_align="left")


# --------------------------------------------------------------------------- #
# Textual app
# --------------------------------------------------------------------------- #


class FactoryTUI(App[None]):
    """Top-level Textual app."""

    CSS = """
    Screen { background: $surface; }
    #body { padding: 0 1; }
    .section { margin: 0 0 1 0; }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("Q", "quit", "Quit"),
        ("ctrl+c", "quit", "Quit"),
        ("r", "recompute_baselines", "Recompute baselines"),
    ]

    def __init__(
        self,
        software_factory_root: Path,
        db_path: Path,
        *,
        spend_cap_usd: float | None = None,
        app_filter: str | None = None,
        refresh_seconds: float = 1.0,
    ) -> None:
        super().__init__()
        self.software_factory_root = software_factory_root
        self.db_path = db_path
        self.spend_cap_usd = spend_cap_usd
        self.app_filter = app_filter
        self.refresh_seconds = refresh_seconds

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with VerticalScroll(id="body"):
            yield Static(id="header_panel", classes="section")
            yield Static(id="apps_panel", classes="section")
            yield Static(id="directions_panel", classes="section")
            yield Static(id="live_panel", classes="section")
            yield Static(id="velocity_panel", classes="section")
            yield Static(id="runs_panel", classes="section")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "factory tui"
        self.sub_title = f"{self.app_filter or 'all apps'} — polling every {self.refresh_seconds:.0f}s"
        # Self-heal: recompute baselines once on launch so the ETA panel works
        # without the operator having to press ``r`` first. The Monte Carlo ETA
        # reads its per-(persona, points) estimate from ``handler_baselines``;
        # if that table is empty (fresh process / never recomputed) every
        # velocity sample is dropped and the ETA falsely reports insufficient
        # data. Cheap median pass; failures are non-fatal to the dashboard.
        try:
            from factory.observability.estimator import recompute_baselines

            recompute_baselines(self.db_path)
        except Exception:
            pass
        self.refresh_data()
        self.set_interval(self.refresh_seconds, self.refresh_data)

    def action_recompute_baselines(self) -> None:
        from factory.observability.estimator import recompute_baselines

        try:
            n = recompute_baselines(self.db_path)
            self.notify(f"recomputed {n} (persona, points) baselines")
        except Exception as exc:
            self.notify(f"recompute failed: {exc!r}", severity="error")

    def refresh_data(self) -> None:
        try:
            snap = collect_snapshot(
                self.db_path,
                self.software_factory_root,
                spend_cap_usd=self.spend_cap_usd,
                app_filter=self.app_filter,
            )
        except Exception as exc:
            # Keep the UI responsive even if a query blows up — show the
            # error in the header so the operator sees it.
            self.query_one("#header_panel", Static).update(
                Panel(
                    Text(f"query error: {exc!r}", style="bold red"),
                    title="factory",
                    border_style="red",
                )
            )
            return

        self.query_one("#header_panel", Static).update(render_header(snap))
        self.query_one("#apps_panel", Static).update(render_apps(snap))
        self.query_one("#directions_panel", Static).update(render_directions(snap))
        self.query_one("#live_panel", Static).update(render_live(snap))
        self.query_one("#velocity_panel", Static).update(render_velocity(snap))
        self.query_one("#runs_panel", Static).update(render_runs(snap))


def run_tui(
    software_factory_root: Path,
    db_path: Path,
    *,
    spend_cap_usd: float | None = None,
    app_filter: str | None = None,
    refresh_seconds: float = 1.0,
) -> None:
    """Blocking entry point. Used by ``factory tui``."""
    app = FactoryTUI(
        software_factory_root=software_factory_root,
        db_path=db_path,
        spend_cap_usd=spend_cap_usd,
        app_filter=app_filter,
        refresh_seconds=refresh_seconds,
    )
    app.run()
