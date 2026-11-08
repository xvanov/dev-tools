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
    /** A person; returns the id. */
    async person(name = 'Ada Example') {
      return Number((await db.one(`insert into person (display_name) values ($1) returning id`, [name])).id);
    },
    /** Sets columns on a commitment (seed only: due_at, extracted_at, counterparty_person_id, status). */
    async updateCommitment(id, cols) {
      const allowed = ['due_at', 'extracted_at', 'counterparty_person_id', 'status'];
      const keys = Object.keys(cols).filter((k) => allowed.includes(k));
      await db.query(`update commitment set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => cols[k])]);
    },
    /** A ledger transition on a commitment; returns its id. */
    async transition(commitmentId, o = {}) {
      const r = await db.one(
        `insert into ledger_transition (commitment_id, from_status, to_status, actor, reason, before, at, undone_at)
         values ($1, $2, $3, $4, $5, '{}'::jsonb, coalesce($6, now()), $7) returning id`,
        [commitmentId, o.from || 'open', o.to || 'done', o.actor || 'reconcile', o.reason || null, o.at || null, o.undoneAt || null]
      );
      return Number(r.id);
    },
    /** Ledger evidence for a commitment (a reply that says it is done); returns its id. */
    async evidence(commitmentId, o = {}) {
      const r = await db.one(
        `insert into ledger_evidence (commitment_id, source_item_id, effect, method, extracted_by, quote, confidence)
         values ($1, $2, $3, $4, 'contract-seed', $5, $6) returning id`,
        [commitmentId, o.sourceItemId || null, o.effect || 'done', o.method || 'reply', o.quote || null, o.confidence ?? null]
      );
      return Number(r.id);
    },
    /** Moves a row's timestamp column (seed only; tables and columns are fixed here). */
    async backdate(table, column, id, when) {
      const ok = { notification: ['created_at'], llm_spend: ['at'], source_item: ['occurred_at'] };
      if (!(ok[table] || []).includes(column)) throw new Error(`backdate ${table}.${column} is not a seed`);
      await db.query(`update ${table} set ${column} = $2 where id = $1`, [id, when]);
    },
  };
  return seed;
}

module.exports = { postgres };
