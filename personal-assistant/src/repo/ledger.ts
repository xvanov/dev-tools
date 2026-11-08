'use strict';

// Aggregate: ledger. Tables: ledger_transition (every status change of a
// commitment, with the columns it replaced) and ledger_evidence (what a
// close was judged on); it also owns the commitment's status columns, since
// the ledger is the one way they change (DURABLE.md 2.1). Callers:
// src/ledger (index.js, reconcile.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

// The commitment columns a transition (and its undo) may write: the keys of
// ledger/core.js plan()'s `set` and `before`.
const STATUS_COLUMNS = ['status', 'closed_at', 'closed_reason', 'touched_at'];

// ---- the reconciler's dirty set (src/ledger/reconcile.js) ----------------------

const WINDOW_DAYS = 30;
const SESSION_SETTLE_MINUTES = 10;

// Author forms of a person's identities, in SQL, for `person_id = <expr>`.
const FORMS_OF = (personExpr: unknown) => `(select case pi.kind when 'smtp' then lower(pi.value)
                       when 'aad_oid' then 'aad:' || lower(pi.value)
                       when 'github_username' then 'github:' || lower(pi.value) end
         from person_identity pi where pi.person_id = ${personExpr})`;

// $1 = my author forms, $2 = max commitments, $3 = max items per commitment,
// $4 = only these commitment ids (null: all).
const DIRTY = `
  select o.id, o.direction, o.summary, o.detail, o.counterparty, o.asked_at, o.ask_text, o.source,
         array_agg(r.id order by r.fetched_at) as item_ids, max(r.fetched_at) as through
    from (
      select c.id, c.direction, c.summary, c.detail, c.counterparty_person_id, c.ledger_checked_at,
             si.id as item_id, si.source, si.thread_external_id, si.occurred_at as asked_at,
             si.body_text as ask_text, per.display_name as counterparty,
             pr.gitlab_path, pr.repo_path
        from commitment c
        join source_item si on si.id = c.source_item_id
        left join person per on per.id = c.counterparty_person_id
        left join project pr on pr.id = c.project_id and pr.active
       where c.status = 'open' and c.superseded_by is null
         and ($4::bigint[] is null or c.id = any($4::bigint[]))
    ) o
    cross join lateral (
      select r.id, r.fetched_at,
             (o.thread_external_id is not null and r.source = o.source and r.thread_external_id = o.thread_external_id) as same_thread
        from source_item r
       -- Not the message the ask came from — unless its text arrived only
       -- later (graphChat.repairEmpty): then it may hold the answer itself, as
       -- a reply quoting the question did once.
       where (r.id <> o.item_id or r.raw->>'repaired' is not null)
         and (r.occurred_at > o.asked_at or r.id = o.item_id)
         and r.occurred_at < o.asked_at + interval '${WINDOW_DAYS} days'
         and r.fetched_at > coalesce(o.ledger_checked_at, '-infinity'::timestamptz)
         and r.source <> 'graph_event'
         -- A live Claude session is re-saved every few minutes while it runs;
         -- judging it each time re-judged every ask in its repo every minute.
         -- It counts once it has been quiet for a while.
         and (r.source <> 'claude_session' or r.fetched_at < now() - interval '${SESSION_SETTLE_MINUTES} minutes')
         and length(r.body_text) >= 8
         and (
           r.id = o.item_id
           or (o.thread_external_id is not null and r.source = o.source and r.thread_external_id = o.thread_external_id)
           -- What they wrote elsewhere: in chat or mail, or on GitHub in this
           -- ask's repo. Their PRs in other repos are not an answer, and ten of
           -- them once filled every slot ahead of the reply in the same thread.
           or (o.direction = 'owed_to_me' and o.counterparty_person_id is not null
               and lower(coalesce(r.author_identity, '')) in ${FORMS_OF('o.counterparty_person_id')}
               and (r.source in ('graph_chat', 'graph_mail')
                    or (o.gitlab_path is not null and r.source like 'github%' and lower(r.raw->>'project') = lower(o.gitlab_path))))
           or (lower(coalesce(r.author_identity, '')) = any($1::text[]) and (
                 (o.gitlab_path is not null and r.source like 'github%' and lower(r.raw->>'project') = lower(o.gitlab_path))
                 or (o.repo_path is not null and r.source = 'claude_session'
                     and (lower(r.raw->>'cwd') like lower(o.repo_path) || '%'
                          -- A session on another machine (raw.machine) has that machine's
                          -- path: the repo's folder name anywhere in it is the match.
                          or (r.raw->>'machine' is not null
                              and string_to_array(translate(lower(r.raw->>'cwd'), chr(92), '/'), '/')
                                  @> array[regexp_replace(translate(lower(o.repo_path), chr(92), '/'), '^.*/', '')])))))
         )
       -- The same thread first: that is where an answer usually is.
       order by same_thread desc, r.fetched_at
       limit $3
    ) r
   group by o.id, o.direction, o.summary, o.detail, o.counterparty, o.asked_at, o.ask_text, o.source, o.ledger_checked_at
   -- Fresh evidence first (an answer that just arrived closes its ask within
   -- the minute); then the asks waiting longest. Newest-first alone starved
   -- the backlog: live sessions kept winning, and an answer from two days ago
   -- was never judged at all.
   order by (max(r.fetched_at) > now() - interval '15 minutes') desc,
            coalesce(o.ledger_checked_at, '-infinity'::timestamptz),
            max(r.fetched_at) desc
   limit $2`;

function setClause(cols: string[]) {
  for (const k of cols) if (!STATUS_COLUMNS.includes(k)) throw new Error(`a transition does not write commitment.${k}`);
  return cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
}

function create(db: Db) {
  return {
    /** A commitment's status columns, locked for update (inside withTx), or null. */
    async lockCommitment(commitmentId: number | string) {
      return db.one('select id, status, closed_at, closed_reason, touched_at from commitment where id = $1 for update', [commitmentId]);
    },

    /** Writes a commitment's status columns (`set`: STATUS_COLUMNS only). */
    async setCommitment(commitmentId: number | string, set: Row) {
      const cols = Object.keys(set);
      await db.query(`update commitment set ${setClause(cols)} where id = $1`, [commitmentId, ...cols.map((k) => set[k])]);
    },

    /**
     * Records one change. `before` is what it overwrote (plan()'s before).
     * @returns {Promise<number>} the transition id
     */
    async insertTransition({ commitmentId, from, to, actor, reason, evidenceId, before, at }: { commitmentId?: number | string | null; from?: Date | string | number | null; to?: string | null; actor?: string | null; reason?: string | null; evidenceId?: number | string | null; before?: Row | null; at?: Date | string | number | null }) {
      const t = await db.one(
        `insert into ledger_transition (commitment_id, from_status, to_status, actor, reason, evidence_id, before, at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [commitmentId, from, to, actor, reason, evidenceId, before, at]
      );
      return Number(t?.id);
    },

    /** One transition, locked for update (inside withTx), or null. */
    async lockTransition(transitionId: number | string) {
      return db.one('select * from ledger_transition where id = $1 for update', [transitionId]);
    },

    /** Marks a transition undone, with what the undo did (`result`). */
    async markUndone(transitionId: number | string, result: string) {
      await db.query('update ledger_transition set undone_at = now(), undo = $2 where id = $1', [transitionId, result]);
    },

    /** The newest change of a commitment that is not undone, or null. */
    async latest(commitmentId: number | string) {
      const list = await db.rows(
        `select * from ledger_transition where commitment_id = $1 and undone_at is null order by at desc, id desc limit 1`,
        [commitmentId]
      );
      return list[0] || null;
    },

    /** Every change of a commitment, newest first, with its evidence's quote, item and confidence. */
    async history(commitmentId: number | string) {
      return db.rows(
        `select t.*, e.quote, e.source_item_id, e.confidence
       from ledger_transition t left join ledger_evidence e on e.id = t.evidence_id
      where t.commitment_id = $1 order by t.at desc, t.id desc`,
        [commitmentId]
      );
    },

    // --- for agent/planner.ts

    /**
     * The reconciler's "progresses" quotes for commitments, newest first.
     * @param {Array<number|string>} commitmentIds
     * @returns {Promise<{commitment_id: number|string, quote: string}[]>}
     */
    async progressQuotes(commitmentIds: unknown[]) {
      return db.rows(
        `select commitment_id, quote from ledger_evidence
        where commitment_id = any($1::bigint[]) and effect = 'progresses' and quote is not null
        order by created_at desc`,
        [commitmentIds]
      );
    },

    // ---- the reconciler (src/ledger/reconcile.js) --------------------------------

    /**
     * Open asks with items the judge has not seen: each {id, direction, summary,
     * detail, counterparty, asked_at, ask_text, source, item_ids, through}. An
     * item counts when it is in the ask's thread, from its counterparty, or mine
     * in its repo, within WINDOW_DAYS; fresh evidence first, then the longest
     * waiting.
     * @param {{myForms: string[], limit: number, perCommitment: number, ids?: number[]|null}} o
     */
    async dirty({ myForms, limit, perCommitment, ids = null }: { myForms?: unknown[] | null; limit?: number | null; perCommitment?: number | null; ids?: unknown[] | null }) {
      return db.rows(DIRTY, [myForms, limit, perCommitment, ids && ids.length ? ids : null]);
    },

    /** Which of these commitments you reopened yourself (and did not undo): their ids, as strings. */
    async reopenedByYou(ids: unknown[]) {
      const list = await db.rows(
        `select distinct commitment_id from ledger_transition
      where commitment_id = any($1::bigint[]) and actor = 'you' and to_status = 'open' and undone_at is null`,
        [ids]
      );
      return new Set(list.map((r) => String(r.commitment_id)));
    },

    /**
     * The judge's evidence for one (commitment, item, judge version): inserted,
     * or updated in place when judged again. Not applied. Resolves its id.
     */
    async upsertEvidence({ commitmentId, sourceItemId, effect, quote, confidence, extractedBy }: { commitmentId?: number | string | null; sourceItemId?: number | string | null; effect?: string | null; quote?: string | null; confidence?: number | null; extractedBy?: string | null }) {
      const ev = (
        await db.query(
          `insert into ledger_evidence (commitment_id, source_item_id, effect, quote, confidence, method, extracted_by, applied)
         values ($1,$2,$3,$4,$5,'llm',$6,false)
         on conflict (commitment_id, source_item_id, extracted_by) do update
            set effect = excluded.effect, quote = excluded.quote, confidence = excluded.confidence, created_at = now()
         returning id`,
          [commitmentId, sourceItemId, effect, quote, confidence, extractedBy]
        )
      ).rows[0];
      return Number(ev?.id);
    },

    /** Marks evidence as applied (its close went through). */
    async markEvidenceApplied(evidenceId: number | string) {
      await db.query('update ledger_evidence set applied = true where id = $1', [evidenceId]);
    },

    /**
     * The judge saw these items for this commitment: its ledger_checked_at
     * moves to the newest of their fetched_at (computed in SQL, keeping
     * microseconds), never backwards.
     */
    async markChecked(commitmentId: number | string, itemIds: unknown[]) {
      await db.query(
        `update commitment set ledger_checked_at = greatest(coalesce(ledger_checked_at, t.through), t.through)
             from (select max(fetched_at) as through from source_item where id = any($2::bigint[])) t
            where commitment.id = $1 and t.through is not null`,
        [commitmentId, itemIds]
      );
    },

    /**
     * Closes the judge proposed (closes or moot, not applied, not decided, at
     * least `minConfidence`), newest per open commitment, shown on the survivor
     * of a duplicate group.
     */
    async proposals({ limit, minConfidence }: { limit?: number | null; minConfidence?: number | null }) {
      return db.rows(
        // Evidence found for a copy that was later folded into a survivor
        // (superseded_by) is shown on the survivor: the copy is not on the board,
        // and showing it put a twin of a live card under "Looks done".
        `select distinct on (c.id) e.id, c.id as commitment_id, e.effect, e.quote, e.confidence, e.created_at,
            c.summary, c.direction, si.source, si.author_identity, coalesce(si.raw->>'webUrl', si.raw->>'url') as url
       from ledger_evidence e
       join commitment o on o.id = e.commitment_id
       join commitment c on c.id = coalesce(o.superseded_by, o.id) and c.status = 'open' and c.superseded_by is null
       left join source_item si on si.id = e.source_item_id
      where e.effect in ('closes','moot') and not e.applied and e.decision is null and e.confidence >= $2
      order by c.id, e.created_at desc
      limit $1`,
        [limit, minConfidence]
      );
    },

    /** One evidence row, or null. */
    async evidenceById(evidenceId: number | string) {
      return db.one('select * from ledger_evidence where id = $1', [evidenceId]);
    },

    /** Your answer to a proposal: `decision` accepted | rejected, and whether its close applied. */
    async decideEvidence(evidenceId: number | string, decision: string, applied: boolean) {
      await db.query('update ledger_evidence set decision = $2, decided_at = now(), applied = $3 where id = $1', [evidenceId, decision, applied]);
    },

    /** The reconciler's record: {closed, reopened (by you after it closed), proposed, last (newest evidence)}. */
    async reconcileStats() {
      return db.one(
        `select (select count(*) from ledger_transition where actor = 'reconciler' and undone_at is null)::int as closed,
            (select count(*) from ledger_transition t where actor = 'reconciler'
               and exists (select 1 from ledger_transition u where u.commitment_id = t.commitment_id
                            and u.actor = 'you' and u.to_status = 'open' and u.at > t.at))::int as reopened,
            (select count(*) from ledger_evidence where effect in ('closes','moot') and not applied and decision is null)::int as proposed,
            (select max(created_at) from ledger_evidence) as last`
      );
    },

    // --- for src/commitments/context.js, src/commitments/replyClose.js

    /**
     * The pending (unapplied, undecided) evidence that a commitment is done or moot, newest first, at most two.
     * @returns {Promise<Array<{effect, quote, confidence}>>}
     */
    async pendingEvidenceFor(commitmentId: number | string) {
      return db.rows(
        `select effect, quote, confidence from ledger_evidence
      where commitment_id = $1 and effect in ('closes','moot') and not applied and decision is null
      order by created_at desc limit 2`,
        [commitmentId]
      );
    },

    /**
     * The id of the newest not yet undone transition the reply-close pass made on a commitment.
     * @returns {Promise<{id}|null>}
     */
    async latestReplyCloseTransition(commitmentId: number | string) {
      return db.one(
        `select id from ledger_transition where commitment_id = $1 and actor = 'reply-close' and undone_at is null
      order by at desc, id desc limit 1`,
        [commitmentId]
      );
    },

    // --- for dashboard/cards.js

    /**
     * The source items evidence rows point at, for a "looks done" card.
     * @param {Array<number|string>} evidenceIds
     */
    async evidenceItems(evidenceIds: unknown[]) {
      return db.rows(
        `select e.id as evidence_id, si.id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
                  si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw
             from ledger_evidence e join source_item si on si.id = e.source_item_id
            where e.id = any($1::bigint[])`,
        [evidenceIds]
      );
    },
  };
}

module.exports = { create, STATUS_COLUMNS, DIRTY, WINDOW_DAYS };