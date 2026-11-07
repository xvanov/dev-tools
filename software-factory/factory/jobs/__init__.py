"""Factory jobs — the interface a personal assistant (PA) uses to hand the
factory work and track it. The CLI surface is ``factory job …``
(``factory/cli_jobs.py``); the contract is ``docs/JOBS-API.md``.

A job IS a direction. ``submit`` writes an ordinary
``apps/<app>/directions/<id>-<slug>/`` directory whose ``direction.md``
frontmatter also carries the job keys (``source``, ``external_id``,
``pipeline``, ``delivery``, ``models``). Everything downstream — pm-sync,
the chain, the merge gates — sees a normal direction; other modules decide
how to HONOUR ``pipeline`` / ``delivery`` / ``models``. This package only
records, validates and reports them.

Modules:

* :mod:`factory.jobs.common` — ids, errors, discovery of job directions.
* :mod:`factory.jobs.submit` — create (idempotent on ``(source, external_id)``).
* :mod:`factory.jobs.github` — cheap, cached, fail-soft PR/branch lookups.
* :mod:`factory.jobs.status` — status / list / cancel.
* :mod:`factory.jobs.follow` — human-readable live event stream.
"""
