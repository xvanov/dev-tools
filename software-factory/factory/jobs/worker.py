"""``python -m factory.jobs.worker <factory_root> <job_id>`` — run one research/report job.

Started detached (own session) by :func:`factory.jobs.tasks.dispatch_tasks`, so a
5400 s agent run never blocks a factory tick. All output goes to the job's
``worker.log``; the outcome is written to its ``job.yaml``.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m factory.jobs.worker <factory_root> <job_id>", file=sys.stderr)
        return 2
    root, job_id = Path(argv[0]), argv[1]
    try:
        from dotenv import load_dotenv

        load_dotenv(root / ".env", override=False)
    except Exception:  # noqa: BLE001 - env loading is best-effort
        pass
    from factory.jobs.tasks import run_task

    final = run_task(root, job_id)
    print(f"{job_id}: {final.get('state')} — {final.get('why') or ''}", flush=True)
    return 0 if final.get("state") == "done" else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
