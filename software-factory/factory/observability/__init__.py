"""Observability: live heartbeats, durations, story points, and EBS estimator.

This subpackage owns everything the TUI (`factory tui`) reads:

* ``schema.py``  — SQLModel rows for ``live_handlers`` + ``handler_baselines``
  plus the migration helper that adds columns onto pre-existing tables.
* ``heartbeat.py`` — context manager + helpers writing/clearing
  ``live_handlers`` rows around each runner call.
* ``estimator.py`` — Evidence-Based Scheduling: baselines from history,
  velocity samples per (persona, model_tier), Monte Carlo ETA per direction.
* ``queries.py`` — read-side queries the TUI uses (apps, in-flight stories,
  direction progress, recent runs, spend windows).
"""
