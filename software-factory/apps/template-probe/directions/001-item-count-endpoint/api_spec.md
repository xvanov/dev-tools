# API contract — items.count

One new tRPC procedure. No schema change, no new table, no migration.

## `items.count`

Transport — tRPC over HTTP, which is what the browser actually issues:

```
GET /api/trpc/items.count
```

A tRPC *query* is served by the `GET` handler in
`apps/web/src/app/api/trpc/[trpc]/route.ts`; batched calls arrive as
`GET /api/trpc/items.count,items.list?batch=1&input=...`. There is no new route
file and no new HTTP endpoint to register — the existing catch-all serves it.

Responses are the standard tRPC envelope: `200` with
`{"result":{"data":{"json":{…}}}}` on success, `200` with an `error` member and a
JSON-RPC code on failure (tRPC does not map procedure errors onto HTTP status
codes by default).

- Router: `packages/api/src/routers/items.ts`
- Kind: **query** (hence `GET`, not `POST`)
- Procedure builder: `orgProcedure` (NOT `protectedProcedure`) — it must receive
  `ctx.organizationId` and filter on it.
- Input: none.

Output:

```ts
{
  total: number;  // every item in the caller's workspace
  open:  number;  // done === false
  done:  number;  // done === true
}
```

`total` always equals `open + done`.

## Implementation note

Use a single grouped query or two `count` calls scoped by `organizationId`; do not
fetch rows and count in JavaScript, which reads the whole table to produce three
integers.

## Errors

| Condition | Result |
|---|---|
| No session | `UNAUTHORIZED`, as every other procedure in this router |
| Session with no resolvable organization | `FORBIDDEN` |

## Explicitly unchanged

- No change to `items.list`, `items.create`, `items.setDone`, `items.remove`.
- No new environment variable, dependency or database column.
