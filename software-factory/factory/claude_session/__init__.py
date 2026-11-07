"""The ``claude_session`` runtime (docs/JOBS-API.md v1.2): Claude Code does the agent work.

A run is ``claude -p --output-format stream-json`` started inside a termhub
session on the factory machine, so a human can open it live, on the operator's
claude.ai subscription (API-key variables are unset for every run).

Modules:

* :mod:`~factory.claude_session.cli` — find ``claude``; submit-time login check.
* :mod:`~factory.claude_session.stream` — parse stream-json (cost, tokens, session).
* :mod:`~factory.claude_session.pretty` — live terminal rendering.
* :mod:`~factory.claude_session.termhub` — termhub HTTP client.
* :mod:`~factory.claude_session.launcher` — round scripts; termhub/local launchers.
* :mod:`~factory.claude_session.conversation` — rounds, gate feedback, wall clock, cancel.
* :mod:`~factory.claude_session.ledger` — ``runs`` rows (billing ``subscription``).
* :mod:`~factory.claude_session.run` — end-to-end run; the dev-step adapter.
"""
