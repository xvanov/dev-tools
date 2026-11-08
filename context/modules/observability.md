# Module: observability

**Path:** `software-factory/factory/observability/`

## Purpose

Observability subsystem — audit chain integrity verification, control-plane conformance checking, database schema management, heartbeats, cost estimation, and queries.

## Key files

| File | Role |
|------|------|
| `audit_chain.py` | Chain-of-custody verification for event streams. Detects tampering, truncation, broken links. |
| `conformance.py` | Replays the control-plane trace and checks it against the abstract conformance model. |
| `conformance_model.yaml` | YAML model defining allowed state transitions and writers. |
| `schema.py` | SQLite database schema management (migrate, create_all). |
| `state_trace.py` | State trace recording for control-plane writes. |
| `heartbeat.py` | Heartbeat monitoring for factory health. |
| `estimator.py` | Cost and resource estimation. |
| `queries.py` | Common database queries. |

## Dependencies

- SQLite via SQLModel
- `factory/chain/state_machine.py` — state definitions
- `state/events/` — NDJSON event streams