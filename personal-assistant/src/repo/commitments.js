'use strict';

// Aggregate: commitments. Tables: commitment, commitment_block, commitment_review, commitment_vector, reply_close, distillation.
// Owner while plan 1.2 is converting: chunk C (commitments). Not converted yet.

function create(db) {
  return {
    // --- for brief/index.js

    /**
     * Open and dispatched commitments for the brief, with project, counterparty
     * and the source item they came from: what people ask of me
     * (`selfNote` false) or notes from my own work (true; src/commitments/selfNotes.js).
     * @param {boolean} selfNote
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async openForBrief(selfNote, limit) {
      const { SELF_NOTE } = require('../commitments/selfNotes');
      return db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.due_at, c.status, c.confidence,
              c.project_confidence, c.repo_path,
              p.name as project, per.display_name as who, per.is_me as who_is_me, si.source, si.subject,
              si.occurred_at, si.thread_external_id
         from commitment c
         left join project p on p.id = c.project_id
         left join person per on per.id = c.counterparty_person_id
         join source_item si on si.id = c.source_item_id
        where c.status in ('open','dispatched') and c.superseded_by is null
          and ${selfNote ? '' : 'not '}${SELF_NOTE}
        order by c.due_at nulls last, c.extracted_at desc
        limit ${limit}`
      );
    },

    // --- for agent/planner.js

    /**
     * Open asks of mine that have no plan yet, are under a week old, are not
     * my own notes, and have no pending "looks done" evidence or run.
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async toPlan(limit) {
      const { SELF_NOTE } = require('../commitments/selfNotes');
      return db.rows(
        `select c.id, c.summary, c.detail, c.repo_path, c.project_id, pr.name as project,
            per.display_name as who, si.source, left(si.body_text, 800) as ask_text
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
       left join project pr on pr.id = c.project_id and pr.active
      where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
        and c.planned_at is null
        -- Probably done already (a "Looks done?" card waits) or already has a run.
        and not exists (select 1 from ledger_evidence e where e.commitment_id = c.id
                         and e.effect in ('closes','moot') and e.decision is null)
        and not exists (select 1 from run r where r.commitment_id = c.id)
        and si.occurred_at > now() - interval '7 days'
        and not ${SELF_NOTE}
      order by si.occurred_at desc
      limit $1`,
        [limit]
      );
    },

    /** How many commitments got a research run planned today. */
    async researchStartedToday() {
      const r = await db.one(
        `select count(*)::int as n from commitment
        where plan->>'researchRunId' is not null and planned_at >= date_trunc('day', now())`
      );
      return r.n;
    },

    /** Records the planner's decision on a commitment. */
    async setPlan(id, kind, plan) {
      await db.query('update commitment set kind = $2, plan = $3, planned_at = now() where id = $1', [id, kind, plan]);
    },

    /** Marks a commitment planned with kind 'other' (no plan made). */
    async markPlannedOther(id) {
      await db.query(`update commitment set kind = 'other', planned_at = now() where id = $1`, [id]);
    },

    /**
     * Pull requests (github_pr items) in each commitment's project since the ask was made.
     * @param {Array<number|string>} ids
     * @returns {Promise<{commitment_id: number|string, subject: string}[]>}
     */
    async shippedSinceAsk(ids) {
      return db.rows(
        `select c.id as commitment_id, si.subject
         from commitment c
         join source_item ask on ask.id = c.source_item_id
         join project pr on pr.id = c.project_id
         join source_item si on si.source = 'github_pr'
          and lower(si.raw->>'project') = lower(pr.gitlab_path)
          and si.occurred_at > ask.occurred_at - interval '1 day'
        where c.id = any($1::bigint[])
        order by si.occurred_at desc`,
        [ids]
      );
    },

    // --- for meetings/index.js

    /**
     * Things I did and closed in a window (6, newest first): marked done or
     * reviewed by me, not someone else's PR landing.
     */
    async closedByMeBetween(from, to) {
      return db.rows(
        `select id, summary, closed_reason, closed_at from commitment
      where direction = 'owed_by_me' and status = 'done' and closed_at between $1 and $2
        -- Only what I closed or did. "PR merged" is someone else's PR landing
        -- (githubReconcile closing a review ask), not my work to report.
        and (closed_reason is null or closed_reason in ('you marked it done', 'you reviewed it'))
      order by closed_at desc limit 6`,
        [from, to]
      );
    },

    /** My open asks due within two days of `now` (or up to 14 days overdue), soonest first (6). */
    async dueSoonOwedByMe(now) {
      return db.rows(
        `select id, summary, due_at from commitment
      where direction = 'owed_by_me' and status in ('open','dispatched') and superseded_by is null
        and due_at is not null and due_at < $1::timestamptz + interval '2 days'
        and due_at > $1::timestamptz - interval '14 days'
      order by due_at limit 6`,
        [now]
      );
    },

    /** My undated asks extracted in the last day with confidence >= 0.6 (4, newest first). */
    async freshAsksOwedByMe(now) {
      return db.rows(
        `select id, summary from commitment
      where direction = 'owed_by_me' and status = 'open' and superseded_by is null and due_at is null
        and extracted_at > $1::timestamptz - interval '1 day' and coalesce(confidence, 0) >= 0.6
      order by extracted_at desc limit 4`,
        [now]
      );
    },

    /** Open and dispatched commitments with a person, soonest due first (12). */
    async openWithPerson(personId) {
      return db.rows(
        `select id, direction, summary, due_at from commitment
      where counterparty_person_id = $1 and status in ('open','dispatched') and superseded_by is null
      order by due_at nulls last, extracted_at desc limit 12`,
        [personId]
      );
    },

    // --- for meetings/debrief.js

    /**
     * Open and dispatched commitments for the debrief to match against (80),
     * those with a person in `attendeeEmails` first.
     * @param {string[]} attendeeEmails  lowercased
     */
    async openForDebrief(attendeeEmails) {
      return db.rows(
        `select c.id, c.direction, c.summary, c.detail, c.due_at, c.status, c.closed_at, c.closed_reason,
            p.display_name as counterparty, lower(p.primary_email) as counterparty_email
       from commitment c left join person p on p.id = c.counterparty_person_id
      where c.status in ('open','dispatched') and c.superseded_by is null
      order by (lower(p.primary_email) = any($1::text[])) desc nulls last, c.due_at nulls last, c.extracted_at desc
      limit 80`,
        [attendeeEmails]
      );
    },

    /**
     * Creates a commitment a debrief heard.
     * @param {{sourceItemId: number|string, direction: string, summary: string, detail: string,
     *   counterpartyPersonId: number|string|null, dueAt: string|null, confidence: number|null,
     *   extractedBy: string}} c
     * @returns {Promise<number|string>} its id
     */
    async insertFromDebrief({ sourceItemId, direction, summary, detail, counterpartyPersonId, dueAt, confidence, extractedBy }) {
      const r = await db.one(
        `insert into commitment (source_item_id, direction, summary, detail, counterparty_person_id, due_at, confidence, extracted_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [sourceItemId, direction, summary, detail, counterpartyPersonId, dueAt, confidence, extractedBy]
      );
      return r.id;
    },

    /**
     * Sets columns a debrief may change (status, closed_at, closed_reason,
     * due_at, detail); other keys are ignored.
     * @param {number|string} id
     * @param {object} set  column -> value
     */
    async setDebriefColumns(id, set) {
      const cols = Object.keys(set).filter((k) => SETTABLE.has(k));
      if (!cols.length) return;
      await db.query(
        `update commitment set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
        [id, ...cols.map((c) => set[c])]
      );
    },

    /** Deletes a commitment a debrief created (only while still extracted by `extractedBy`). */
    async deleteExtractedBy(id, extractedBy) {
      await db.query(`delete from commitment where id = $1 and extracted_by = $2`, [id, extractedBy]);
    },

    /** One commitment row, or null (the debrief's undo reads it before restoring columns). */
    async rowForUndo(id) {
      return db.one('select * from commitment where id = $1', [id]);
    },
  };
}

const SETTABLE = new Set(['status', 'closed_at', 'closed_reason', 'due_at', 'detail']);

module.exports = { create };
