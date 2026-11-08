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
        `insert into source_item (source, external_id, occurred_at, raw, body_text, subject, content_hash, thread_external_id, author_identity)
         values ($1, $2, coalesce($3, now()), coalesce($6, '{}')::jsonb, $4, $5, md5($2), $7, $8) returning id`,
        [o.source || 'graph_mail', o.externalId || `seed-${process.pid}-${Date.now()}-${n}`, o.occurredAt || null, o.body || 'body', o.subject || 'subject',
          o.raw ? JSON.stringify(o.raw) : null, o.thread || null, o.author || null]
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
    /**
     * A source item with the columns a query may filter on: o.source, o.externalId, o.occurredAt (Date or
     * ISO), o.raw (object), o.author, o.subject, o.body, o.thread. Returns its id.
     */
    async item(o = {}) {
      n++;
      const externalId = o.externalId || `seed-item-${process.pid}-${Date.now()}-${n}`;
      const r = await db.one(
        `insert into source_item (source, external_id, thread_external_id, occurred_at, author_identity, subject, body_text, raw, content_hash)
         values ($1, $2, $3, coalesce($4, now()), $5, $6, $7, $8::jsonb, md5($2)) returning id`,
        [o.source || 'graph_event', externalId, o.thread || null, o.occurredAt || null, o.author || null, o.subject || 'subject', o.body || '', JSON.stringify(o.raw || {})]
      );
      return Number(r.id);
    },
    /** A person (o.name, o.email, o.isMe); returns its id. */
    async personWith(o = {}) {
      n++;
      const r = await db.one(`insert into person (display_name, primary_email, is_me) values ($1, $2, $3) returning id`, [
        o.name || `Person ${n}`,
        o.email === undefined ? `person-${process.pid}-${Date.now()}-${n}@example.test` : o.email,
        Boolean(o.isMe),
      ]);
      return Number(r.id);
    },
    /** An identity (kind, value) of a person; returns its id. */
    async identity(personId, kind, value) {
      const r = await db.one(`insert into person_identity (person_id, kind, value) values ($1, $2, $3) returning id`, [personId, kind, value]);
      return Number(r.id);
    },
    /** A project (o.name, o.gitlabPath); returns its id. */
    async project(o = {}) {
      n++;
      const r = await db.one(`insert into project (name, gitlab_path) values ($1, $2) returning id`, [o.name || `proj-${process.pid}-${Date.now()}-${n}`, o.gitlabPath || null]);
      return Number(r.id);
    },
    /** Sets columns of a commitment by name (status, due_at, plan, planned_at, project_id, ...). */
    async commitmentSet(id, cols) {
      const keys = Object.keys(cols);
      await db.query(`update commitment set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => cols[k])]);
    },
    /** A ledger_evidence row for a commitment (o.effect default 'progresses', o.quote, o.decision); returns its id. */
    async evidenceWith(commitmentId, o = {}) {
      n++;
      const r = await db.one(
        `insert into ledger_evidence (commitment_id, effect, quote, method, extracted_by, decision)
         values ($1, $2, $3, 'rule', $4, $5) returning id`,
        [commitmentId, o.effect || 'progresses', o.quote === undefined ? 'a quote' : o.quote, `seed-${n}`, o.decision || null]
      );
      return Number(r.id);
    },
    /** A run row (o.status, o.commitmentId, o.task); returns its id. */
    async run(o = {}) {
      const r = await db.one(
        `insert into run (commitment_id, mode, task, status, route, ended_at)
         values ($1, 'plan', $2, $3, 'claude', $4) returning id`,
        [o.commitmentId || null, o.task || 'a seeded run', o.status || 'running', o.endedAt || null]
      );
      return Number(r.id);
    },
    /** An audio_episode (o.startedAt, o.endedAt, o.stream, o.kind, o.state, o.eventId, o.itemId, o.speech); returns its id. */
    async episode(o = {}) {
      n++;
      const started = o.startedAt || new Date(Date.now() - 3600_000 - n * 1000);
      const r = await db.one(
        `insert into audio_episode (started_at, ended_at, stream, speech_seconds, kind, calendar_event_id, state, source_item_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [started, o.endedAt || new Date(new Date(started).getTime() + 1800_000), o.stream || 'mic+loopback', o.speech ?? 600, o.kind || 'meeting', o.eventId || null, o.state || 'transcribed', o.itemId || null]
      );
      return Number(r.id);
    },
    /** A claim (o.status, o.kind, o.subjectKind, o.subjectId, o.validAt); returns its id. */
    async claim(o = {}) {
      const r = await db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, status, origin, valid_at)
         values ($1, $2, $3, $4, $5, $6, 'explicit', coalesce($7, now())) returning id`,
        [o.subjectKind || 'me', o.subjectId || null, o.label || 'me', o.kind || 'blocker', o.text || 'a seeded claim', o.status || 'active', o.validAt || null]
      );
      return Number(r.id);
    },
    /** Sets a sync_cursor's state (upserts the row). */
    async cursor(source, state) {
      await db.query(
        `insert into sync_cursor (source, state) values ($1, $2::jsonb) on conflict (source) do update set state = excluded.state`,
        [source, JSON.stringify(state)]
      );
    },
    // --- for memory.contract.js
    /** A person; `isMe` returns the existing me when there is one. Returns the id. */
    async memPerson(o = {}) {
      if (o.isMe) {
        const me = await db.one('select id from person where is_me limit 1');
        if (me) return Number(me.id);
      }
      n++;
      const r = await db.one(
        `insert into person (display_name, primary_email, is_me) values ($1, $2, $3) returning id`,
        [o.name || `Seed Person ${process.pid}-${Date.now()}-${n}`, o.email || null, Boolean(o.isMe)]
      );
      return Number(r.id);
    },
    /** An identity (kind, value) for a person. */
    async memIdentity(personId, kind, value) {
      await db.query(`insert into person_identity (person_id, kind, value) values ($1, $2, $3)`, [personId, kind, value]);
    },
    /** A project (optionally with an alias); returns its id. */
    async memProject(o = {}) {
      n++;
      const r = await db.one(`insert into project (name, last_touched_at) values ($1, $2) returning id`, [o.name || `seed-project-${process.pid}-${Date.now()}-${n}`, o.touchedAt || null]);
      if (o.alias) await db.query(`insert into project_alias (project_id, alias) values ($1, $2)`, [r.id, o.alias]);
      return Number(r.id);
    },
    /** A commitment on a fresh source item, with optional counterparty, project, direction, status, extractedAt. */
    async memCommitment(o = {}) {
      const item = o.sourceItemId || (await seed.sourceItem());
      const r = await db.one(
        `insert into commitment (source_item_id, direction, summary, status, counterparty_person_id, project_id, extracted_by, extracted_at)
         values ($1, $2, $3, $4, $5, $6, 'contract-seed', coalesce($7, now())) returning id`,
        [item, o.direction || 'owed_by_me', o.summary || 'a seeded ask', o.status || 'open', o.personId || null, o.projectId || null, o.extractedAt || null]
      );
      return Number(r.id);
    },
    /** A chunk of a source item (ord 0 by default) with an optional embedding literal; returns its id. */
    async memChunk(itemId, o = {}) {
      const r = await db.one(
        `insert into chunk (source_item_id, ord, content, context, context_v, embedding)
         values ($1, $2, $3, $4, $5, $6::vector) returning id`,
        [itemId, o.ord ?? 0, o.content || 'chunk words', o.context ?? '', o.contextV ?? 0, o.embedding || null]
      );
      return Number(r.id);
    },
  };
  return seed;
}

module.exports = { postgres };
