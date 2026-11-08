# schemas

The contract objects the parts of the system exchange (native plan item 1.1, decision D15),
one JSON Schema (draft 2020-12) each:

| Schema | What it is | Produced by |
|---|---|---|
| `job.schema.json` | A factory job, as `factory job status --json` prints it (JOBS-API v1.4) | software-factory `factory/jobs/status.py` |
| `run.schema.json` | A PA run's id chain: card, run, job, steps with sessions, PRs (plan E1); `$defs/chain` is what the PA stores from a job | PA `src/dispatch/factoryCore.js` (`runChain`, `chainOf`) |
| `card.schema.json` | A board card in detail (the chat's `card` tool); `$defs/compact` is one card on the board | PA `src/mcp/chatTools.js` |
| `event.schema.json` | One `GET /api/events` frame | PA `src/events/bus.js`, `src/dashboard/events.js` |
| `approval.schema.json` | The permission prompt the PA chat waits on; `$defs/decision` is the answer | PA `src/chat/feed.js`, `POST /api/chat/permission` |

- **TypeScript types** are generated: `node schemas/gen-types.js` writes `types.d.ts`. Never edit it by
  hand; `personal-assistant/test/schemas.test.js` fails when it is stale.
- **JS** validates with `schemas/index.js` (`validate(name, value)`, `assertValid`), dependency-free.
  It supports only the keywords the schemas use and throws on any other, so it can never mean less
  than Python's full validator. Add a keyword there (and in `gen-types.js`) before using it.
- **Python** validates with `software-factory/factory/contract_schemas.py` (`jsonschema`).
- Factory objects allow unknown keys (JOBS-API is additive); PA-owned objects do not.
- `examples/` holds sample objects both test suites validate.
