'use strict';

// Rows a contract case needs that belong to another aggregate (a commitment
// for a run, a source item for a commitment). Per backend, since a seed may
// use SQL the repositories do not expose. Keep seeds minimal: only NOT NULL
// columns and what the case asserts on. Prefer a repository method when one
// exists, so the seed does not need porting for the next backend.

function postgres(db) {
  let n = 0;
  const seed = {
    /** A source item; returns its id. */
    async sourceItem(o = {}) {
      n++;
      const r = await db.one(
        `insert into source_item (source, external_id, occurred_at, raw, body_text, subject, content_hash)
         values ($1, $2, coalesce($3, now()), '{}'::jsonb, $4, $5, md5($2)) returning id`,
        [o.source || 'graph_mail', o.externalId || `seed-${process.pid}-${Date.now()}-${n}`, o.occurredAt || null, o.body || 'body', o.subject || 'subject']
      );
      return Number(r.id);
    },
    /** A commitment (owed by me, open) on a fresh source item; returns its id. */
    async commitment(o = {}) {
      const item = o.sourceItemId || (await seed.sourceItem());
      const r = await db.one(
        `insert into commitment (source_item_id, direction, summary, status, extracted_by)
         values ($1, $2, $3, $4, 'contract-seed') returning id`,
        [item, o.direction || 'owed_by_me', o.summary || 'a seeded ask', o.status || 'open']
      );
      return Number(r.id);
    },
  };
  return seed;
}

module.exports = { postgres };
