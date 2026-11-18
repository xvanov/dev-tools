# schemas

The contract objects the parts of the system exchange (native plan item 1.1, decision D15),
one JSON Schema (draft 2020-12) each:

| Schema | What it is | Produced by |
|---|---|---|
| `card.schema.json` | A board card in detail (the chat's `card` tool); `$defs/compact` is one card on the board | PA `src/mcp/chatTools.ts` |
| `event.schema.json` | One `GET /api/events` frame | PA `src/events/bus.ts`, `src/dashboard/events.ts` |
| `approval.schema.json` | The permission prompt the PA chat waits on; `$defs/decision` is the answer | PA `src/chat/feed.ts`, `POST /api/chat/permission` |

`job.schema.json` and `run.schema.json` (a software-factory job and a PA run's id chain) went with the
factory (D32); they are in git at `4eee22f`.

- **TypeScript types** are generated: `node schemas/gen-types.js` writes `types.d.ts`. Never edit it by
  hand; `personal-assistant/test/schemas.test.js` fails when it is stale.
- **JS** validates with `schemas/index.js` (`validate(name, value)`, `assertValid`), dependency-free.
  It supports only the keywords the schemas use and throws on any other. Add a keyword there (and in
  `gen-types.js`) before using it.
- PA-owned objects do not allow unknown keys.
