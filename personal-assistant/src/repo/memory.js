'use strict';

// Aggregate: memory. Tables: memory_page, claim, claim_extraction, consolidation, fact.
// Owner while plan 1.2 is converting: chunk B (memory, search). Not converted yet.

function create(db) {
  return {
    // --- for meetings/index.js, meetings/debrief.js

    /**
     * Active blocker claims about me from the 21 days before `now` (3, newest first).
     * @param {Date} now
     * @returns {Promise<{id: number|string, text: string, quote: string|null}[]>}
     */
    async activeBlockers(now) {
      return db.rows(
        `select id, text, quote from claim
      where status = 'active' and kind = 'blocker' and subject_kind = 'me'
        and valid_at > $1::timestamptz - interval '21 days' and invalid_at is null
      order by valid_at desc limit 3`,
        [now]
      );
    },

    /**
     * A person's active claims, newest first (5).
     * @param {number|string} personId
     * @returns {Promise<{id: number|string, text: string}[]>}
     */
    async activeForPerson(personId) {
      return db.rows(
        `select id, text from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
      order by valid_at desc limit 5`,
        [personId]
      );
    },

    /**
     * A claim learned from a meeting transcript, about a topic (series).
     * @param {{label: string, kind: string, text: string, quote: string, sourceItemId: number|string|null,
     *   validAt: string, extractedBy: string}} c
     * @returns {Promise<{id: number|string}>}
     */
    async insertTopicClaim({ label, kind, text, quote, sourceItemId, validAt, extractedBy }) {
      return db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                          confidence, valid_at, status, origin, extracted_by)
       values ('topic', null, $1, $2, $3, $4, $5, 'audio', 0.8, $6, 'active', 'distill', $7) returning id`,
        [label, kind, text, quote, sourceItemId, validAt, extractedBy]
      );
    },

    /**
     * A claim a debrief wrote (about me, or a topic), from an audio item.
     * @param {{subjectKind: string, subjectId: number|string|null, label: string, kind: string, text: string,
     *   quote: string, itemId: number|string, validAt: string, extractedBy: string}} c
     * @returns {Promise<number|string>} the claim id
     */
    async insertDebriefClaim({ subjectKind, subjectId = null, label, kind, text, quote, itemId, validAt, extractedBy }) {
      const r = await db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                        confidence, valid_at, status, origin, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,'audio',0.8,$8,'active','distill',$9) returning id`,
        [subjectKind, subjectId, label, kind, text, quote, itemId, validAt, extractedBy]
      );
      return r.id;
    },

    /** Retracts a claim (once). */
    async retract(id) {
      await db.query(`update claim set status = 'retracted' where id = $1 and status <> 'retracted'`, [id]);
    },
  };
}

module.exports = { create };
