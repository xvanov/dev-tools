"""Phase 6 — cron scheduler.

The scheduler is the hourly/daily/weekly clock that fires the Ralph,
Bug-Hunter, Security, and UX-Auditor personas. ``factory tick`` calls
``due_schedules`` and dispatches each due entry via
``factory.chain.scheduled_tasks.run_scheduled_persona``.

Schedules are declared in ``factory_settings.yaml`` and rate-limited by
the same settings enforcer that gates the main story chain.
"""
