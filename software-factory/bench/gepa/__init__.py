"""GEPA pilot — Genetic-Pareto pipeline-evolution harness.

A PILOT. It proves the evolutionary *search machinery* (Pareto ranking,
selection, mutation, racing, budgets) works on a controlled, zero-cost
landscape before anything here is allowed near a paid model call. See
``README.md`` in this directory for what the pilot proves and does not.

Zero network code lives under this package on purpose — see
``tests/test_gepa_pilot.py``'s ``test_no_network_imports_anywhere`` for the
enforcement.
"""

from __future__ import annotations
