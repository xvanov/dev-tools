#!/usr/bin/env python3
"""CLI: boot the app, drive the oracle over HTTP, report GREEN/RED/INFRA.

The ablation fallback (``factory.chain.mutation.check_can_fail``, composed
from ``gates.acceptance_verified``) needs a ``check_command`` it can run twice
in a scratch clone — once as a green baseline, once with a production symbol
gutted — and read tri-state (green/red/infra) off the exit code
(``mutation._run_suite``: 0 green, 1 red, anything else infra). Under the
out-of-process runner that "check" is "boot the app and run the oracle against
it", which needs its own process (the whole point is that the interpreter
computing the verdict never imports the diff's code) — hence this script,
invoked by mutation as a plain shell command, by ABSOLUTE path.

Absolute path matters because ``mutation._mutant_env`` deliberately strips the
calling process's venv from ``PATH`` (so a leaked editable install can't make
every mutant invisible) — a bare ``oracle_probe.py`` would not resolve. This
script re-inserts the factory root onto ``sys.path`` itself for the same
reason: it cannot rely on being run with the factory's env intact.

Exit codes (matching ``mutation._run_suite``'s contract exactly):
  0  GREEN — the oracle passed against the booted instance.
  1  RED   — a CREDITED criterion (one of ``--credit``) FAILED.
  2+ INFRA — could not boot, could not run, a credited criterion never even
             appeared, or a non-credited criterion failed. Mapped to
             "skipped", never a kill and never a survival.

``--credit`` (repeatable) is the gate's own crediting set ``K`` — every node
id whose HEAD outcome was PASS and whose outcome against BOTH
gutted-implementation stub variants was FAIL/ERROR (AC2). Found 2026-08-07:
without this, RED meant "ANY criterion failed", so on the ``unknown`` ⇒
ablation route (the design's OWN most common shape, reached whenever the
merge-base boot fails) a mutation that only kills a STUB-EXCLUDED, vacuous
criterion licensed an approval — AC2's exclusion guarantee held everywhere
BUT here. A red on a criterion outside ``K`` is now INFRA (2), the same as
"could not measure": it is real evidence about SOMETHING, just not about
anything this run is licensed to credit.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _bootstrap_factory_root(factory_root: str) -> None:
    p = str(Path(factory_root).resolve())
    if p not in sys.path:
        sys.path.insert(0, p)


def _parse_env_pairs(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in pairs:
        if "=" in item:
            key, _, value = item.partition("=")
            out[key] = value
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--factory-root", required=True)
    parser.add_argument("--tree", required=True, help="tree to boot from (usually '.')")
    parser.add_argument("--oracle", required=True, help="path to the oracle source, relative to --tree")
    parser.add_argument("--boot-command", required=True)
    parser.add_argument("--boot-cwd", default="")
    parser.add_argument("--health-path", default="/")
    parser.add_argument("--boot-timeout", type=int, default=180)
    parser.add_argument("--run-timeout", type=int, default=300)
    parser.add_argument("--shutdown-grace", type=float, default=5.0)
    parser.add_argument(
        "--env-passthrough", default="PATH,HOME,LANG,LC_ALL,UV_CACHE_DIR,XDG_CACHE_HOME"
    )
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--credit", action="append", default=[],
        help="a credited (K) node id; repeatable. RED requires a FAIL on one of these.",
    )
    args = parser.parse_args(argv)
    credited = set(args.credit)

    _bootstrap_factory_root(args.factory_root)

    from factory.app_config import AcceptanceBootConfig
    from factory.chain import boot as boot_mod
    from factory.chain import oracle_run

    tree = Path(args.tree).resolve()
    oracle_path = tree / args.oracle
    try:
        oracle_src = oracle_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"oracle_probe: could not read oracle source {oracle_path}: {exc}")
        return 2

    cfg = AcceptanceBootConfig(
        command=args.boot_command,
        cwd=args.boot_cwd or None,
        health_path=args.health_path,
        boot_timeout_seconds=args.boot_timeout,
        run_timeout_seconds=args.run_timeout,
        shutdown_grace_seconds=args.shutdown_grace,
        env=_parse_env_pairs(args.env),
        env_passthrough=[v for v in args.env_passthrough.split(",") if v],
    )

    tail = ""
    run: oracle_run.OracleRun | None = None
    try:
        with boot_mod.boot_app(tree, cfg, args.run_id, label="ablation") as (app, why):
            if app is None:
                print(f"oracle_probe: BOOT FAILED: {why}")
                return 2
            run = oracle_run.run_oracle(
                oracle_src,
                base_url=app.base_url,
                run_id=args.run_id,
                dest_name=oracle_path.name,
                timeout_s=cfg.run_timeout_seconds,
            )
            tail = boot_mod.tail_log(app.log_path, 4000)
    except Exception as exc:  # noqa: BLE001 - "could not measure" must never read as RED (exit 1)
        print(f"oracle_probe: BOOT ERROR: {type(exc).__name__}: {exc}")
        return 2

    if tail:
        print("--- server log tail ---")
        print(tail)

    assert run is not None
    if run.status == "fail" and run.summary is not None:
        failed_credited = [c for c, outcome in run.criteria.items() if outcome == "FAIL" and c in credited]
        if credited and failed_credited:
            print(f"oracle_probe: RED (credited failure(s): {failed_credited})")
            return 1
        print(
            f"oracle_probe: INFRA (a criterion failed but none of it was in the "
            f"credited set: failed={sorted(c for c, o in run.criteria.items() if o == 'FAIL')}, "
            f"credited={sorted(credited)})"
        )
        return 2
    if run.status in ("pass", "vacuous"):
        print(f"oracle_probe: GREEN (status={run.status})")
        return 0
    print(f"oracle_probe: INFRA (status={run.status}, exit_code={run.exit_code}): {run.output[-500:]}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
