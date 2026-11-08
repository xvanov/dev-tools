'use strict';

// SQLite twin of src/repo/drafts.js (draft, and the read model a draft is
// composed from).

const { NOW, DAY, sinceMs } = require('./_sql');

// "I already answered": a message from me in the same thread, after the ask.
// SQL fragment over `si`; $1 = my author forms (a JSON array).
const ANSWERED = `exists (
  select 1 from source_item mine
   where mine.source = si.source and mine.thread_external_id = si.thread_external_id
     and si.thread_external_id is not null
     and mine.occurred_at > si.occurred_at
     and lower(coalesce(mine.author_identity, '')) in (select value from json_each($1)))`;

const OPEN = "('pending','edited')";

function create(db) {
  return {
    // ---- context --------------------------------------------------------------

    /** My primary email ({primary_email}), or null. */
    async myEmail() {
      return db.one('select primary_email from person where is_me limit 1');
    },

    /** Earlier messages in an item's thread (same source), newest first, at most `limit`. */
    async threadBefore(item, limit) {
      return db.rows(
        `select occurred_at, author_identity, subject, body_text, json_extract(raw, '$.fromName') as from_name
       from source_item
      where source = $1 and thread_external_id = $2 and id <> $3
        and occurred_at <= $4
      order by occurred_at desc limit $5`,
        [item.source, item.thread_external_id, item.id, item.occurred_at, limit]
      );
    },

    /** A commitment with its counterparty's name and email (who, who_email), or null. */
    async askWithCounterparty(commitmentId) {
      return db.one(
        `select c.*, per.display_name as who, per.primary_email as who_email
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.id = $1`,
        [commitmentId]
      );
    },

    /** One source item, or null. */
    async sourceItem(id) {
      return db.one('select * from source_item where id = $1', [id]);
    },

    /** One commitment, or null. */
    async commitment(id) {
      return db.one('select * from commitment where id = $1', [id]);
    },

    /** One person, or null. */
    async person(id) {
      return db.one('select * from person where id = $1', [id]);
    },

    /** The other open asks on me read from the same message: {summary, detail}. */
    async siblingAsks(sourceItemId, commitmentId) {
      return db.rows(
        `select summary, detail from commitment
      where source_item_id = $1 and id <> $2 and direction = 'owed_by_me' and status in ('open','dispatched')`,
        [sourceItemId, commitmentId]
      );
    },

    // ---- drafts ---------------------------------------------------------------

    /** Inserts a pending draft; `target` is stored as JSON. Resolves the row. */
    async insert({ commitmentId, runId, sourceItemId, target, subject, body, origin }) {
      return db.one(
        `insert into draft (commitment_id, run_id, source_item_id, channel, to_identity, subject, body, target, origin, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') returning *`,
        [commitmentId, runId, sourceItemId, target.channel, target.label || null, subject, body, target, origin]
      );
    },

    /** One draft, or null. */
    async byId(id) {
      return db.one('select * from draft where id = $1', [id]);
    },

    /** A run's drafts, newest first. */
    async forRun(runId) {
      return db.rows('select * from draft where run_id = $1 order by created_at desc, id desc', [runId]);
    },

    /** Open drafts (pending or edited), newest first, at most 30. */
    async open() {
      return db.rows(`select * from draft where status in ${OPEN} order by created_at desc, id desc limit 30`);
    },

    /** Replaces an open draft's body (it becomes edited). Null when not open. */
    async edit(id, body) {
      return db.one(`update draft set body = $2, status = 'edited' where id = $1 and status in ${OPEN} returning *`, [id, body]);
    },

    /** Discards an open draft ({id}); null when not open. */
    async discard(id) {
      return db.one(`update draft set status = 'discarded' where id = $1 and status in ${OPEN} returning id`, [id]);
    },

    /** Marks an open draft sent (you pressed Send). Null when not open. */
    async markSent(id) {
      return db.one(`update draft set status = 'sent', sent_at = ${NOW} where id = $1 and status in ${OPEN} returning *`, [id]);
    },

    // ---- the auto pass ----------------------------------------------------------

    /** Open drafts (not nudges) whose ask I have answered in its thread since: {id, answered_at}. */
    async answeredOpen(myForms) {
      const rows = await db.rows(
        `select d.id, (select min(mine.occurred_at) from source_item mine
                    where mine.source = si.source and mine.thread_external_id = si.thread_external_id
                      and mine.occurred_at > si.occurred_at
                      and lower(coalesce(mine.author_identity, '')) in (select value from json_each($1))) as answered_at
       from draft d join source_item si on si.id = d.source_item_id
      where d.status in ${OPEN} and d.origin <> 'nudge' and ${ANSWERED}`,
        [myForms || []]
      );
      return rows.map((r) => ({ ...r, answered_at: r.answered_at == null ? null : new Date(r.answered_at) }));
    },

    /** Discards an open draft with the reason why. */
    async discardWithReason(id, reason) {
      await db.query(
        `update draft set status = 'discarded', closed_at = ${NOW},
              closed_reason = $2 where id = $1 and status in ${OPEN}`,
        [id, reason]
      );
    },

    /** Discards open auto drafts whose ask was my own message. Resolves how many. */
    async discardOwnAsks(myForms) {
      const r = await db.query(
        `update draft set status = 'discarded', closed_at = ${NOW}, closed_reason = 'the ask was your own message'
      where status in ${OPEN} and origin = 'auto'
        and source_item_id in (select si.id from source_item si
                                where lower(coalesce(si.author_identity, '')) in (select value from json_each($1)))`,
        [myForms || []]
      );
      return r.rowCount || 0;
    },

    /** Discards open nudges whose chased commitment is no longer open. Resolves how many. */
    async discardSettledNudges() {
      const r = await db.query(
        `update draft set status = 'discarded', closed_at = ${NOW}, closed_reason = 'what you were chasing is settled'
      where origin = 'nudge' and status in ${OPEN}
        and commitment_id in (select c.id from commitment c where c.status <> 'open')`
      );
      return r.rowCount || 0;
    },

    /** Fresh asks on me from mail or Teams worth an unasked reply (see src/repo/drafts.js): [{id}]. */
    async autoCandidates(myForms, minConfidence, limit) {
      return db.rows(
        `select c.id
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
        and si.source in ('graph_chat', 'graph_mail')
        and coalesce(c.confidence, 1) >= $2
        and si.occurred_at > $4
        and coalesce(per.is_me, 0) = 0
        and lower(coalesce(si.author_identity, '')) not in (select value from json_each($1))
        and not exists (select 1 from draft d where d.commitment_id = c.id)
        and not exists (
          select 1 from draft d join commitment sib on sib.id = d.commitment_id
           where sib.source_item_id = c.source_item_id and sib.id <> c.id)
        and not ${ANSWERED}
      order by si.occurred_at desc
      limit $3`,
        [myForms || [], minConfidence, limit, sinceMs(2 * DAY)]
      );
    },

    /** Drafts waiting for you (pending or edited), newest first (30), with the ask they answer. */
    async pendingForBoard() {
      return db.rows(
        `select d.id, d.run_id, d.commitment_id, d.channel, d.to_identity, d.subject, d.body, d.status,
            d.origin, d.created_at, r.task, c.summary as ask, si.raw->>'webUrl' as ask_url,
            si.raw->>'webLink' as ask_link, si.body_text as ask_text
       from draft d
       left join run r on r.id = d.run_id
       left join commitment c on c.id = d.commitment_id
       left join source_item si on si.id = d.source_item_id
      where d.status in ('pending','edited')
      order by d.created_at desc, d.id desc limit 30`
      );
    },
  };
}

module.exports = { create };
