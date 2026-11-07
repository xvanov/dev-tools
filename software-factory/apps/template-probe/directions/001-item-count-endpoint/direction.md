---
title: Expose an item count on the dashboard
type: feature
priority: p2
explore: false
created_at: '2026-07-29T02:46:57.299714+00:00'
---

<!-- Sibling: api_spec.md satisfies the PM backpressure gate. -->

# Expose an item count on the dashboard

## Why

The dashboard lists items but never says how many there are. Once a workspace has
more than a screenful, "how much is left" requires counting by eye. A count is
also the smallest useful signal that the tenant-scoped API is returning what the
user expects.

## What

Add a `count` procedure to the items router that returns the number of items in
the caller's workspace, split by state, and show it on the dashboard.

### API

`items.count` — an org-scoped query taking no input, returning:

```ts
{ total: number; open: number; done: number }
```

It MUST be an `orgProcedure` and MUST filter on `ctx.organizationId`, like every
other procedure in that router. A count that leaks across tenants is worse than
no count.

### UI

In the "Items" card on the web dashboard, show the counts next to the heading —
for example `3 open · 1 done`. When the workspace has no items, show nothing
extra rather than "0 open · 0 done"; the empty state already says enough.

## Acceptance

- `items.count` returns `{total, open, done}` for the caller's workspace only.
- A second workspace's items never affect the first workspace's numbers.
- The counts appear on the dashboard and update after adding, completing or
  deleting an item.
- The existing end-to-end journey still passes.

## Out of scope

- Counting anything other than items.
- The mobile app — web only for this direction.
- Pagination or filtering.
