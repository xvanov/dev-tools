'use strict';

// Aggregate: commitments. Tables: commitment, commitment_block, commitment_review, commitment_vector, reply_close, distillation.
// Owner while plan 1.2 is converting: chunk C (commitments). Not converted yet.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

const LIVE = `c.status in ('open','dispatched') and c.superseded_by is null`;

// Every commitment folded into the same survivor as `id` (superseded_by
// chains), `id` itself excluded. `union`, not `union all`: a cycle ends.
const DUPLICATE_SET_SQL = `
  with recursive up as (
         select id, superseded_by from commitment where id = $1
         union select c.id, c.superseded_by from commitment c join up on c.id = up.superseded_by),
       root as (select id from up where superseded_by is null limit 1),
       down as (
         select id from root
         union select c.id from commitment c join down on c.superseded_by = down.id)
  select d.id from down d join commitment c on c.id = d.id
   where d.id <> $1 and c.status in ('open', 'dispatched')`;

// Open unfolded cards with what acted on them (src/commitments/policyClose.js).
const POLICY_CANDIDATES = (folded: boolean) => `
  select c.id, c.summary, c.direction, c.status, c.touched_at, c.closed_at, c.closed_reason,
         c.superseded_by, si.id as item_id, si.source, si.author_identity, si.raw, si.thread_external_id, si.external_id,
         c.touched_at is not null as touched,
         exists (select 1 from run r where r.commitment_id = c.id) as has_run,
         exists (select 1 from draft d where d.commitment_id = c.id) as has_draft,
         exists (select 1 from ledger_transition t where t.commitment_id = c.id and t.actor = 'you') as you_moved
    from commitment c join source_item si on si.id = c.source_item_id
   where c.status = 'open'${folded ? '' : ' and c.superseded_by is null'}
   order by c.id`;

// Who wrote an item, as a name: the connector's display name, the person the
// identity resolves to, or the raw identity.
const AUTHOR = (t: string) => `coalesce(${t}.raw->>'fromName',
  (select p.display_name from person_identity pi join person p on p.id = pi.person_id
    where lower(pi.value) = lower(regexp_replace(coalesce(${t}.author_identity, ''), '^github:', '')) limit 1),
  ${t}.author_identity)`;

// Whether anything has acted on a commitment: a run, a draft, a status change
// in the ledger, a reply that closed it, your hand. Narrower than the review
// pass's test (memory/consolidate.js), which also counts a judgement that
// changed nothing — a reply judged "not discharged", a piece of evidence the
// reconciler weighed. Those are on nearly every chat ask, and counting them
// protected exactly the per-item copies the dedupe pass exists to fold. (A
// pending "looks done?" proposal on a folded copy is shown on its survivor:
// ledger/reconcile.js.)
const ACTED = (a: unknown) => `(${a}.status = 'dispatched' or ${a}.touched_at is not null
   or exists (select 1 from draft d where d.commitment_id = ${a}.id)
   or exists (select 1 from run r where r.commitment_id = ${a}.id)
   or exists (select 1 from ledger_transition t where t.commitment_id = ${a}.id)
   or exists (select 1 from reply_close rc where rc.commitment_id = ${a}.id and rc.applied is not null and rc.undone_at is null))`;

// The item's live commitments, with whether anything has acted on them
// (src/distill/keep.js decides what a re-distillation may replace).
const EXISTING = `
  select c.id, c.status, c.summary, c.touched_at is not null as touched,
         (exists (select 1 from draft d where d.commitment_id = c.id)
          or exists (select 1 from run r where r.commitment_id = c.id)
          or exists (select 1 from ledger_transition t where t.commitment_id = c.id)
          or exists (select 1 from ledger_evidence e where e.commitment_id = c.id)
          or exists (select 1 from reply_close rc where rc.commitment_id = c.id)) as refs
    from commitment c
   where c.source_item_id = $1 and c.superseded_by is null`;

// A message addressed to you on Teams: a 1:1 chat, your self chat, or one that
// mentions you. pendingDistill reads these below the usual minimum length.
type DirectMin = { minChars: number; since: string };
const DIRECT_TO_ME = `(si.source = 'graph_chat'
   and (si.raw->>'chatType' in ('oneOnOne','self') or si.raw->>'mentionsMe' = 'true'))`;

/** The length test of pendingDistill; `at` is the first of direct's two placeholders. */
function longEnough(direct: DirectMin | undefined, at: number) {
  if (!direct) return 'length(si.body_text) >= $2';
  return `(length(si.body_text) >= $2
        or (${DIRECT_TO_ME} and length(si.body_text) >= $${at} and si.occurred_at >= $${at + 1}))`;
}

function directParams(direct: DirectMin | undefined) {
  return direct ? [direct.minChars, direct.since] : [];
}

function create(db: Db) {
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
    async openForBrief(selfNote: unknown, limit: number) {
      const { SELF_NOTE } = require('../commitments/selfNotes.ts');
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

    // --- for agent/planner.ts

    /**
     * Open asks of mine that have no plan yet, are under a week old, are not
     * my own notes, and have no pending "looks done" evidence or run.
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async toPlan(limit: number) {
      const { SELF_NOTE } = require('../commitments/selfNotes.ts');
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
      return r?.n;
    },

    /** Records the planner's decision on a commitment. */
    async setPlan(id: number | string, kind: string, plan: unknown) {
      await db.query('update commitment set kind = $2, plan = $3, planned_at = now() where id = $1', [id, kind, plan]);
    },

    /** Marks a commitment planned with kind 'other' (no plan made). */
    async markPlannedOther(id: number | string) {
      await db.query(`update commitment set kind = 'other', planned_at = now() where id = $1`, [id]);
    },

    /**
     * Pull requests (github_pr items) in each commitment's project since the ask was made.
     * @param {Array<number|string>} ids
     * @returns {Promise<{commitment_id: number|string, subject: string}[]>}
     */
    async shippedSinceAsk(ids: unknown[]) {
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
    async closedByMeBetween(from: Date | string | number, to: string) {
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
    async dueSoonOwedByMe(now: Date | string | number) {
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
    async freshAsksOwedByMe(now: Date | string | number) {
      return db.rows(
        `select id, summary from commitment
      where direction = 'owed_by_me' and status = 'open' and superseded_by is null and due_at is null
        and extracted_at > $1::timestamptz - interval '1 day' and coalesce(confidence, 0) >= 0.6
      order by extracted_at desc limit 4`,
        [now]
      );
    },

    /** Open and dispatched commitments with a person, soonest due first (12). */
    async openWithPerson(personId: number | string) {
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
    async openForDebrief(attendeeEmails: unknown) {
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
    async insertFromDebrief({ sourceItemId, direction, summary, detail, counterpartyPersonId, dueAt, confidence, extractedBy }: { sourceItemId?: number | string | null; direction?: unknown; summary?: string | null; detail?: string | null; counterpartyPersonId?: number | string | null; dueAt?: Date | string | number | null; confidence?: number; extractedBy?: string | null }) {
      const r = await db.one(
        `insert into commitment (source_item_id, direction, summary, detail, counterparty_person_id, due_at, confidence, extracted_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [sourceItemId, direction, summary, detail, counterpartyPersonId, dueAt, confidence, extractedBy]
      );
      return r?.id;
    },

    /**
     * Sets columns a debrief may change (status, closed_at, closed_reason,
     * due_at, detail); other keys are ignored.
     * @param {number|string} id
     * @param {object} set  column -> value
     */
    async setDebriefColumns(id: number | string, set: Row) {
      const cols = Object.keys(set).filter((k) => SETTABLE.has(k));
      if (!cols.length) return;
      await db.query(
        `update commitment set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
        [id, ...cols.map((c) => set[c])]
      );
    },

    /** Deletes a commitment a debrief created (only while still extracted by `extractedBy`). */
    async deleteExtractedBy(id: number | string, extractedBy: string) {
      await db.query(`delete from commitment where id = $1 and extracted_by = $2`, [id, extractedBy]);
    },

    /** One commitment row, or null (the debrief's undo reads it before restoring columns). */
    async rowForUndo(id: number | string) {
      return db.one('select * from commitment where id = $1', [id]);
    },

    // --- src/commitments.js

    /**
     * A commitment's id, status and summary; null when there is none.
     * @param {number|string} id
     * @returns {Promise<{id, status: string, summary: string}|null>}
     */
    async summaryRow(id: number | string) {
      return db.one('select id, status, summary from commitment where id = $1', [id]);
    },

    /**
     * The open rest of `id`'s duplicate group (superseded_by chains), `id`
     * itself excluded.
     * @param {number|string} id
     * @returns {Promise<Array<{id}>>}
     */
    async openDuplicatesOf(id: number | string) {
      return db.rows(DUPLICATE_SET_SQL, [id]);
    },

    /**
     * Closed in the last `days` days, newest first, with the source and who
     * closed it last.
     * @param {number|string} days  as text for the interval
     * @param {number} limit
     * @returns {Promise<object[]>} id, summary, status, closed_reason, closed_at, source, url, actor
     */
    async recentlyClosed(days: number, limit: number) {
      return db.rows(
        `select c.id, c.summary, c.status, c.closed_reason, c.closed_at, si.source,
            coalesce(si.raw->>'webUrl', si.thread_external_id) as url,
            (select t.actor from ledger_transition t where t.commitment_id = c.id and t.undone_at is null
              order by t.at desc, t.id desc limit 1) as actor
       from commitment c join source_item si on si.id = c.source_item_id
      where c.closed_at > now() - ($1 || ' days')::interval
      order by c.closed_at desc limit $2`,
        [days, limit]
      );
    },

    // --- src/commitments/blocks.js

    /**
     * Your own open tasks (owed_by_me) from sources the policy allows.
     * @param {string} srcSql  sourcePolicy.sourceSql('si.source')
     * @returns {Promise<Array<{id, summary, detail, extracted_at}>>}
     */
    async blockTasks(srcSql: unknown) {
      return db.rows(
        `select c.id, c.summary, c.detail, c.extracted_at from commitment c join source_item si on si.id = c.source_item_id
      where ${LIVE} and c.direction = 'owed_by_me' and ${srcSql} order by c.id`
      );
    },

    /**
     * Open owed_to_me commitments with their block verdict, if any.
     * @param {string} srcSql  sourcePolicy.sourceSql('si.source')
     * @returns {Promise<object[]>}
     */
    async blockCandidates(srcSql: unknown) {
      return db.rows(
        `select c.id, c.summary, c.detail, coalesce(p.display_name, '') as who,
            coalesce(si.raw->>'chatTopic', si.subject, '') as place, si.body_text as body,
            b.verdict, b.task_id, b.manual, b.judged_at,
            (b.task_id is not null and not exists (select 1 from commitment t where t.id = b.task_id
               and t.status in ('open','dispatched') and t.superseded_by is null)) as task_gone
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join person p on p.id = c.counterparty_person_id
       left join commitment_block b on b.blocker_id = c.id
      where ${LIVE} and c.direction = 'owed_to_me' and ${srcSql} order by c.id`
      );
    },

    /**
     * Cosine similarity of each (blocker, task) pair that has vectors on both.
     * @param {Array<number|string>} blockerIds
     * @param {Array<number|string>} taskIds  parallel to blockerIds
     * @returns {Promise<Array<{b: string, cos: number|string}>>}
     */
    async blockLinkCosines(blockerIds: unknown[], taskIds: unknown[]) {
      return db.rows(
        `select x.b::text as b, 1 - (vb.embedding <=> vt.embedding) as cos
       from unnest($1::bigint[], $2::bigint[]) as x(b, t)
       join commitment_vector vb on vb.commitment_id = x.b
       join commitment_vector vt on vt.commitment_id = x.t`,
        [blockerIds, taskIds]
      );
    },

    /** Writes the model's verdict on a blocker; a row you set by hand (manual) is never changed. */
    async upsertBlockJudged(blockerId: number | string, taskId: number | string, verdict: unknown, why: unknown, who: unknown) {
      await db.query(
        `insert into commitment_block (blocker_id, task_id, verdict, why, who, judged_at) values ($1, $2, $3, $4, $5, now())
         on conflict (blocker_id) do update set task_id = excluded.task_id, verdict = excluded.verdict, why = excluded.why,
           who = excluded.who, judged_at = now()
          where not commitment_block.manual`,
        [blockerId, taskId, verdict, why, who]
      );
    },

    /** Your call on a card: writes the verdict and marks it manual. */
    async upsertBlockManual(blockerId: number | string, taskId: number | string, verdict: unknown, why: unknown) {
      await db.query(
        `insert into commitment_block (blocker_id, task_id, verdict, why, manual, judged_at) values ($1, $2, $3, $4, true, now())
     on conflict (blocker_id) do update set task_id = coalesce(excluded.task_id, case when excluded.verdict = 'blocks' then commitment_block.task_id end),
       verdict = excluded.verdict, why = coalesce(excluded.why, commitment_block.why), manual = true, judged_at = now()`,
        [blockerId, taskId, verdict, why]
      );
    },

    /**
     * Every judged blocker that is open, or closed in the last `days` days
     * while blocking an open task.
     * @param {number} days
     * @returns {Promise<object[]>}
     */
    async blocksForBoard(days: number) {
      return db.rows(
        `select b.blocker_id::text, b.task_id::text, b.verdict, b.why, b.manual,
            c.status, c.closed_at, c.closed_reason, c.summary, coalesce(p.display_name, b.who, '') as who
       from commitment_block b
       join commitment c on c.id = b.blocker_id
       left join person p on p.id = c.counterparty_person_id
      where c.superseded_by is null
        and (c.status in ('open','dispatched')
             or (b.verdict = 'blocks' and b.task_id is not null and c.status = 'done'
                 and c.closed_at > now() - make_interval(days => $1)))`,
        [days]
      );
    },

    // --- src/commitments/policyClose.js

    /**
     * Open, unfolded commitments with their source item and what acted on
     * them (a run, a draft, a move of yours). `folded`: folded copies too.
     * @returns {Promise<object[]>}
     */
    async policyCandidates({ folded = false }: { folded?: boolean } = {}) {
      return db.rows(POLICY_CANDIDATES(folded));
    },

    /**
     * Open or dispatched commitments folded under any of `ids`.
     * @param {Array<number>} ids
     * @returns {Promise<Array<{id, superseded_by, summary, source, author_identity, raw}>>}
     */
    async foldedUnder(ids: unknown[]) {
      return db.rows(
        `select c.id, c.superseded_by, c.summary, si.source, si.author_identity, si.raw
           from commitment c join source_item si on si.id = c.source_item_id
          where c.status in ('open','dispatched') and c.superseded_by = any($1::bigint[])`,
        [ids]
      );
    },

    /**
     * Unfolds a commitment still folded under `supersededBy`.
     * @returns {Promise<boolean>} whether a row changed
     */
    async unfold(id: number | string, supersededBy: unknown) {
      const r = await db.query('update commitment set superseded_by = null where id = $1 and superseded_by = $2', [id, supersededBy]);
      return Boolean(r.rowCount);
    },

    /**
     * Moves a commitment still folded under `from` to fold under `to`.
     * @returns {Promise<boolean>} whether a row changed
     */
    async refold(id: number | string, from: unknown, to: unknown) {
      const r = await db.query('update commitment set superseded_by = $3 where id = $1 and superseded_by = $2 and id <> $3', [id, from, to]);
      return Boolean(r.rowCount);
    },

    // --- src/commitments/selfNotes.js

    /**
     * Ids of open self-notes nobody touched for `days` days.
     * @param {string} days  as text for the interval
     * @param {string} selfNoteSql  selfNotes.SELF_NOTE (needs `si` and `per` in scope)
     * @returns {Promise<Array<{id}>>}
     */
    async expiredSelfNotes(days: number, selfNoteSql: unknown) {
      return db.rows(
        `select c.id from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.status = 'open' and c.superseded_by is null
        and coalesce(c.touched_at, si.occurred_at) < now() - ($1 || ' days')::interval
        and ${selfNoteSql}`,
        [days]
      );
    },

    // --- src/commitments/context.js

    /**
     * Commitments on a card whose context is missing or stale, most visible first.
     * @param {number} limit
     * @param {string} version  `<prompt version> <model>` the context is written by
     * @param {number} refreshMinutes
     * @param {string} selfNoteSql  selfNotes.SELF_NOTE
     * @returns {Promise<Array<{id, prio}>>}
     */
    async dueForContext(limit: number, version: string, refreshMinutes: unknown, selfNoteSql: unknown) {
      return db.rows(
        `with card as (
       select p.commitment_id as id, 0 as prio from proposal p
        where p.status = 'pending' and p.commitment_id is not null and (p.expires_at is null or p.expires_at > now())
       union all
       select e.commitment_id, 1 from ledger_evidence e
        where e.effect in ('closes','moot') and not e.applied and e.decision is null
       union all
       select c.id, 2 from commitment c
         join source_item si on si.id = c.source_item_id
         left join person per on per.id = c.counterparty_person_id
        where c.status in ('open','dispatched') and c.superseded_by is null and not ${selfNoteSql}
     )
     select c.id, min(card.prio) as prio
       from card join commitment c on c.id = card.id
       join source_item si on si.id = c.source_item_id
      where c.status in ('open','dispatched') and c.superseded_by is null
        and (c.context_at is null
             or (c.context_at < now() - make_interval(mins => $3)
                 and (c.context is null or c.context_by is distinct from $2
                      or exists (select 1 from source_item t
                                  where t.fetched_at > c.context_at
                                    and (t.id = si.id or (si.source <> 'claude_session' and si.thread_external_id is not null
                                         and t.source = si.source and t.thread_external_id = si.thread_external_id))))))
      group by c.id
      order by min(card.prio), c.id desc
      limit $1`,
        [limit, version, refreshMinutes]
      );
    },

    /**
     * What the context prompt needs for one commitment: the card, its project,
     * counterparty and source item. Null when it is gone.
     * @param {number|string} id
     * @returns {Promise<object|null>}
     */
    async contextCard(id: number | string) {
      return db.one(
        `select c.id, c.summary, c.detail, c.direction, c.status, c.due_at, c.kind,
            coalesce(p.gitlab_path, p.name) as project, per.display_name as who,
            si.id as item_id, si.source, si.subject, si.occurred_at, si.thread_external_id,
            si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw,
            left(si.body_text, 20000) as body, ${AUTHOR('si')} as author
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
        [id]
      );
    },

    /**
     * The messages around a source item in its thread: up to four before it,
     * up to nine from it on (unsorted).
     * @param {string} source
     * @param {string} threadExternalId
     * @param {Date} occurredAt  of the source item
     * @param {number|string} itemId  of the source item
     * @returns {Promise<Array<{id, occurred_at, body: string, author}>>}
     */
    async contextThread(source: string, threadExternalId: number | string, occurredAt: Date | string | number, itemId: number | string) {
      const cols = `t.id, t.occurred_at, left(t.body_text, 900) as body, ${AUTHOR('t')} as author`;
      return db.rows(
        `(select ${cols} from source_item t
         where t.source = $1 and t.thread_external_id = $2 and t.occurred_at < $3 and t.id <> $4
         order by t.occurred_at desc limit 4)
       union all
       (select ${cols} from source_item t
         where t.source = $1 and t.thread_external_id = $2 and (t.occurred_at >= $3 or t.id = $4)
         order by t.occurred_at asc limit 9)`,
        [source, threadExternalId, occurredAt, itemId]
      );
    },

    /**
     * Stores a card's context paragraph (kept when `text` is null) and stamps
     * when and by what it was written.
     */
    async setContext(id: number | string, text: string, by: unknown) {
      await db.query(`update commitment set context = coalesce($2, context), context_at = now(), context_by = $3 where id = $1`, [id, text, by]);
    },

    /** Stamps context_at, so a failed card is retried after the refresh interval. */
    async stampContextAt(id: number | string) {
      await db.query('update commitment set context_at = now() where id = $1', [id]);
    },

    /** Forgets the context: a run on the card ended, so it is written again (or not shown once the card is closed). */
    async clearContext(id: number | string) {
      await db.query('update commitment set context = null, context_at = null where id = $1', [id]);
    },

    // --- src/commitments/dedupe.js

    /**
     * Open commitments with no vector yet, newest first.
     * @param {number} limit
     * @param {number} windowDays
     * @param {string} policySql  sourcePolicy.sourceSql('si.source')
     * @returns {Promise<Array<{id, summary, detail, thread_external_id}>>}
     */
    async unvectored(limit: number, windowDays: unknown, policySql: unknown) {
      return db.rows(
        `select c.id, c.summary, c.detail, si.thread_external_id
       from commitment c join source_item si on si.id = c.source_item_id
       left join commitment_vector v on v.commitment_id = c.id
      where v.commitment_id is null and ${LIVE} and ${policySql}
        and c.extracted_at > now() - make_interval(days => $2)
      order by c.extracted_at desc limit $1`,
        [limit, windowDays]
      );
    },

    /** Stores a commitment's embedding (`vector` as '[..]' text) and anchors; a second is a no-op. */
    async insertVector(commitmentId: number | string, vector: unknown, anchors: unknown) {
      await db.query(
        `insert into commitment_vector (commitment_id, embedding, anchors) values ($1, $2::vector, $3)
         on conflict (commitment_id) do nothing`,
        [commitmentId, vector, anchors]
      );
    },

    /**
     * The open, unfolded, recent commitments with a vector: the comparison
     * pool. `embedding` is the vector as text.
     * @param {number} windowDays
     * @param {string} policySql  sourcePolicy.sourceSql('si.source')
     * @returns {Promise<object[]>}
     */
    async dedupePool(windowDays: unknown, policySql: unknown) {
      return db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.status, c.due_at, c.extracted_at, c.source_item_id,
            (c.counterparty_person_id is not null and not coalesce(p.is_me, false)) as has_party,
            coalesce(p.display_name, '') as who, si.source, si.thread_external_id,
            coalesce(si.raw->>'webUrl', si.raw->>'webLink') as web_url,
            coalesce(si.raw->>'chatTopic', si.subject, '') as place,
            v.embedding::text as embedding, v.anchors, v.checked_at,
            ${ACTED('c')} as acted
       from commitment c
       join commitment_vector v on v.commitment_id = c.id
       join source_item si on si.id = c.source_item_id
       left join person p on p.id = c.counterparty_person_id
      where ${LIVE} and ${policySql} and c.extracted_at > now() - make_interval(days => $1)
      order by c.id`,
        [windowDays]
      );
    },

    /**
     * Follows superseded_by to the live survivor of `id`; null when the chain
     * has none.
     * @returns {Promise<Array<{id}>>} zero or one row
     */
    async survivorOf(id: number | string) {
      return db.rows(
        `with recursive up as (select id, superseded_by, 0 as n from commitment where id = $1
        union all select c.id, c.superseded_by, up.n + 1 from commitment c join up on c.id = up.superseded_by where up.n < 20)
     select id from up where superseded_by is null limit 1`,
        [id]
      );
    },

    /**
     * Folds `drop` under `keep`, only while `drop` is a live row nothing else
     * folded meanwhile.
     * @returns {Promise<boolean>} whether the fold was made
     */
    async fold(drop: unknown, keep: unknown) {
      const r = await db.query(
        `update commitment set superseded_by = $2
      where id = $1 and superseded_by is null and status in ('open','dispatched')`,
        [drop, keep]
      );
      return Boolean(r.rowCount);
    },

    /** Marks as checked the vectors whose commitment has left the board. */
    async checkVectorsOffBoard() {
      await db.query(
        `update commitment_vector v set checked_at = now()
       from commitment c where c.id = v.commitment_id and v.checked_at is null
        and not (c.status in ('open','dispatched') and c.superseded_by is null)`
      );
    },

    /** Marks one vector checked, with the fold note (or null) as its verdict. */
    async markVectorChecked(commitmentId: number | string, verdict: unknown) {
      await db.query(`update commitment_vector set checked_at = now(), verdict = $2 where commitment_id = $1`, [commitmentId, verdict]);
    },

    /** Marks every unchecked vector checked (the one-off backfill). */
    async checkAllVectors() {
      await db.query(`update commitment_vector set checked_at = coalesce(checked_at, now())`);
    },

    // --- src/commitments/replyClose.js

    /**
     * Open owed_by_me asks from `sources` with a reply of mine in the window
     * that no judgement at this version has seen yet.
     * @param {string[]} me  my author forms (lower case)
     * @param {string} version  reply-close prompt version
     * @param {number} limit
     * @param {{windowDays: number, sources: string[], maxAttempts: number}} o
     * @returns {Promise<object[]>}
     */
    async replyCloseCandidates(me: unknown, version: string, limit: number, { windowDays, sources, maxAttempts }: { windowDays?: unknown; sources?: unknown[] | null; maxAttempts?: unknown }) {
      return db.rows(
        `
  select c.id, c.summary, c.detail, c.due_at, c.status, c.closed_at, c.closed_reason,
         si.id as item_id, si.source, si.thread_external_id, si.occurred_at, si.author_identity,
         si.subject, si.body_text, p.display_name as counterparty,
         last.id as last_message_id, last.occurred_at as last_at
    from commitment c
    join source_item si on si.id = c.source_item_id
    left join person p on p.id = c.counterparty_person_id
    cross join lateral (
      select mine.id, mine.occurred_at from source_item mine
       where mine.source = si.source and mine.thread_external_id = si.thread_external_id
         and mine.id <> si.id
         and mine.occurred_at > si.occurred_at
         and mine.occurred_at <= si.occurred_at + interval '${windowDays} days'
         and lower(coalesce(mine.author_identity, '')) = any($1::text[])
       order by mine.occurred_at desc, mine.id desc limit 1) last
   where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
     and si.source = any('{${(sources ?? []).join(',')}}'::text[]) and si.thread_external_id is not null
     and not exists (
       select 1 from reply_close r
        where r.commitment_id = c.id and r.extracted_by = $2 and r.last_message_id = last.id
          and (r.error is null or r.attempts >= ${maxAttempts}))
   order by last.occurred_at desc
   limit $3`,
        [me, version, limit]
      );
    },

    /**
     * My later messages in the thread of a source item, within the window.
     * @param {string[]} me  my author forms
     * @param {string} source
     * @param {string} threadExternalId
     * @param {number|string} itemId  the ask's source item
     * @param {Date} occurredAt  of the ask
     * @param {{windowDays: number, limit: number}} o
     * @returns {Promise<Array<{id, occurred_at, body_text}>>}
     */
    async replyCloseReplies(me: unknown, source: string, threadExternalId: number | string, itemId: number | string, occurredAt: Date | string | number, { windowDays, limit }: { windowDays?: unknown; limit?: number }) {
      return db.rows(
        `select mine.id, mine.occurred_at, mine.body_text from source_item mine
      where mine.source = $2 and mine.thread_external_id = $3 and mine.id <> $4
        and mine.occurred_at > $5 and mine.occurred_at <= $5::timestamptz + interval '${windowDays} days'
        and lower(coalesce(mine.author_identity, '')) = any($1::text[])
      order by mine.occurred_at, mine.id limit ${limit}`,
        [me, source, threadExternalId, itemId, occurredAt]
      );
    },

    /**
     * Records a judgement; the same (commitment, version, last message) is
     * updated and its attempts counted.
     * @param {{id, last_message_id}} c
     * @param {string} version
     * @param {{verdict, quote, message?: {id}, confidence?: number}} j
     * @param {object|null} applied  what was changed, for undo
     */
    async recordReplyClose(c: Row, version: string, j: { verdict?: unknown; quote?: unknown; message?: { id?: unknown } | null; confidence?: unknown }, applied: boolean | null = null) {
      await db.query(
        `insert into reply_close (commitment_id, extracted_by, last_message_id, verdict, quote, message_id, confidence, applied, attempts, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, null)
     on conflict (commitment_id, extracted_by, last_message_id) do update
        set verdict = excluded.verdict, quote = excluded.quote, message_id = excluded.message_id,
            confidence = excluded.confidence, applied = excluded.applied, error = null,
            attempts = reply_close.attempts + 1, judged_at = now()`,
        [c.id, version, c.last_message_id, j.verdict, j.quote, j.message?.id ?? null, j.confidence ?? null, applied]
      );
    },

    /** Records a failed judgement (`message` is clipped by the caller). */
    async recordReplyCloseError(c: Row, version: string, message: string) {
      await db.query(
        `insert into reply_close (commitment_id, extracted_by, last_message_id, error, attempts)
     values ($1, $2, $3, $4, 1)
     on conflict (commitment_id, extracted_by, last_message_id) do update
        set error = excluded.error, attempts = reply_close.attempts + 1, judged_at = now()`,
        // The message is ours (a parse or spawn failure), never a body; clipped anyway.
        [c.id, version, c.last_message_id, message]
      );
    },

    /**
     * The commitment's status columns, row-locked (use inside withTx).
     * @returns {Promise<{id, status, closed_at, closed_reason}|null>}
     */
    async lockStatus(id: number | string) {
      return db.one('select id, status, closed_at, closed_reason from commitment where id = $1 for update', [id]);
    },

    /**
     * The newest applied, not yet undone reply-close judgement on a commitment.
     * @returns {Promise<object|null>} the reply_close row
     */
    async latestAppliedReplyClose(commitmentId: number | string) {
      return db.one(
        `select * from reply_close where commitment_id = $1 and applied is not null and undone_at is null
      order by judged_at desc limit 1`,
        [commitmentId]
      );
    },

    /** Marks a reply_close row undone, with what the undo said. */
    async markReplyCloseUndone(id: number | string, result: string) {
      await db.query('update reply_close set undone_at = now(), undo = $2 where id = $1', [id, result]);
    },

    /** Puts back the columns a close overwrote. */
    async restoreClosedState(id: number | string, status: string, closedAt: unknown, closedReason: unknown) {
      await db.query('update commitment set status = $2, closed_at = $3, closed_reason = $4 where id = $1', [id, status, closedAt, closedReason]);
    },

    /**
     * Counts for `pa doctor`: closed (still closed as the pass left it),
     * judged, failed (out of attempts) and the last judgement time.
     * @param {number} maxAttempts
     * @returns {Promise<{closed: number, judged: number, failed: number, last: Date|null}>}
     */
    async replyCloseStats(maxAttempts: unknown) {
      return db.one(
        `select count(*) filter (where r.applied is not null and r.undone_at is null
                              and c.closed_reason = r.applied->'set'->>'closed_reason')::int as closed,
            count(*) filter (where r.error is null)::int as judged,
            count(*) filter (where r.error is not null and r.attempts >= ${maxAttempts})::int as failed,
            max(r.judged_at) as last
       from reply_close r left join commitment c on c.id = r.commitment_id`
      );
    },

    // --- src/commitments/request.js

    /**
     * Inserts a task you asked for (confidence 1) and returns its id.
     * @param {{itemId, direction, summary, detail, personId, dueAt, projectId, repoPath, projectConfidence, projectRationale, extractedBy}} v
     * @returns {Promise<{id}>}
     */
    async insertRequested(v: Row) {
      return db.one(
        `insert into commitment
           (source_item_id, direction, summary, detail, counterparty_person_id, due_at, project_id, repo_path,
            project_confidence, project_rationale, confidence, extracted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11) returning id`,
        [v.itemId, v.direction, v.summary, v.detail, v.personId, v.dueAt, v.projectId, v.repoPath, v.projectConfidence, v.projectRationale, v.extractedBy]
      );
    },

    // --- src/distill/index.js

    /**
     * Source items with no distillation at this prompt version, newest first.
     * @param {string} version  prompt version
     * @param {number} minChars
     * @param {number} limit
     * @param {string} skipSql  the items to leave out (`not ...`), a SQL predicate on `si`
     * @param {string} allowedSql  sources that may create tasks, a SQL predicate on `si`
     * @param {{minChars: number, since: string}} [direct]  a lower minimum for a Teams DM, the
     *   self chat or a message that mentions you, at or after `since`
     * @returns {Promise<object[]>} source_item rows
     */
    async pendingDistill(version: string, minChars: unknown, limit: number, skipSql: unknown, allowedSql: unknown, direct?: DirectMin) {
      return db.rows(
        `select si.* from source_item si
       left join distillation d
         on d.source_item_id = si.id and d.extracted_by = $1
      where d.source_item_id is null and not ${skipSql} and ${allowedSql}
        and ${longEnough(direct, 4)}
      order by si.occurred_at desc
      limit $3`,
        [version, minChars, limit, ...directParams(direct)]
      );
    },

    /**
     * How many items {@link pendingDistill} would return (without a limit).
     * @returns {Promise<{n: number}|null>}
     */
    async pendingDistillCount(version: string, minChars: unknown, skipSql: unknown, allowedSql: unknown, direct?: DirectMin) {
      return db.one(
        `select count(*)::int as n from source_item si
       left join distillation d
         on d.source_item_id = si.id and d.extracted_by = $1
      where d.source_item_id is null and not ${skipSql} and ${allowedSql} and ${longEnough(direct, 3)}`,
        [version, minChars, ...directParams(direct)]
      );
    },

    /**
     * An item's live commitments with whether anything has acted on them.
     * @returns {Promise<Array<{id, status, summary, touched: boolean, refs: boolean}>>}
     */
    async liveForItem(itemId: number | string) {
      return db.rows(EXISTING, [itemId]);
    },

    /** Every commitment distilled from one item, folded ones too, oldest first. */
    async ofItem(itemId: number | string) {
      return db.rows('select id, direction, status, due_at, extracted_at, superseded_by from commitment where source_item_id = $1 order by id', [itemId]);
    },

    /** Deletes commitments by id (re-distillation replacing what nothing acted on). */
    async deleteByIds(ids: unknown[]) {
      await db.query('delete from commitment where id = any($1::bigint[])', [ids]);
    },

    /**
     * Inserts one distilled commitment.
     * @param {{itemId, direction, summary, detail, personId, dueAt, projectId, repoPath, projectConfidence, projectRationale, confidence, extractedBy}} v
     * @returns {Promise<number|null>} its id
     */
    async insertDistilled(v: Row) {
      const r = await db.one(
        `insert into commitment
           (source_item_id, direction, summary, detail, counterparty_person_id, due_at,
            project_id, repo_path, project_confidence, project_rationale, confidence, extracted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [v.itemId, v.direction, v.summary, v.detail, v.personId, v.dueAt, v.projectId, v.repoPath, v.projectConfidence, v.projectRationale, v.confidence, v.extractedBy]
      );
      return r ? Number(r.id) : null;
    },

    /** Marks an item distilled with its counts; clears any earlier error. */
    async upsertDistillation(itemId: number | string, version: string, commitments: unknown, facts: unknown) {
      await db.query(
        `insert into distillation (source_item_id, extracted_by, commitments, facts, error)
       values ($1,$2,$3,$4,null)
       on conflict (source_item_id) do update set
         extracted_by = excluded.extracted_by,
         extracted_at = now(),
         commitments  = excluded.commitments,
         facts        = excluded.facts,
         error        = null`,
        [itemId, version, commitments, facts]
      );
    },

    /** Marks an item failed, with the (clipped) error, so the pass moves on. */
    async markDistillFailed(itemId: number | string, version: string, error: string) {
      await db.query(
        `insert into distillation (source_item_id, extracted_by, error)
       values ($1,$2,$3)
       on conflict (source_item_id) do update set
         extracted_by = excluded.extracted_by, extracted_at = now(), error = excluded.error`,
        [itemId, version, error]
      );
    },

    /** Marks an item the source policy keeps off the board as distilled with nothing found. */
    async markDistillSkipped(itemId: number | string, version: string) {
      await db.query(
        `insert into distillation (source_item_id, extracted_by, commitments, facts) values ($1, $2, 0, 0)
     on conflict (source_item_id) do update set extracted_by = excluded.extracted_by, extracted_at = now(), error = null`,
        [itemId, version]
      );
    },

    /** Marks an item the debrief owns as distilled (a no-op when it already is). */
    async markDistillOwnedByDebrief(itemId: number | string, version: string) {
      await db.query(`insert into distillation (source_item_id, extracted_by) values ($1, $2) on conflict (source_item_id) do nothing`, [itemId, version]);
    },

    // --- src/distill/identity.js, src/projects/index.js

    /** Re-points every commitment's counterparty from one person to another (a person merge). */
    async reassignCounterparty(intoId: number | string, fromId: number | string) {
      await db.query('update commitment set counterparty_person_id = $1 where counterparty_person_id = $2', [intoId, fromId]);
    },

    /** One commitment row by id (null when gone). */
    async byId(id: number | string) {
      return db.one('select * from commitment where id = $1', [id]);
    },

    /** Distinct projects of commitments extracted in the last 14 days (at most 20). */
    async recentProjectIds() {
      return db.rows(
        `select distinct project_id from commitment
      where project_id is not null and extracted_at > now() - interval '14 days'
      order by project_id limit 20`
      );
    },

    /** The (at most 5) projects a person's commitments most often sit in. @returns {Promise<Array<{project_id, n}>>} */
    async projectsOfPerson(personId: number | string) {
      return db.rows(
        `select project_id, count(*) as n from commitment
          where counterparty_person_id = $1 and project_id is not null
          group by project_id order by n desc limit 5`,
        [personId]
      );
    },

    /** The project of the newest commitment from a thread, or null. @returns {Promise<{project_id}|null>} */
    async projectOfThread(threadExternalId: number | string) {
      return db.one(
        `select c.project_id from commitment c
           join source_item si on si.id = c.source_item_id
          where si.thread_external_id = $1 and c.project_id is not null
          order by c.extracted_at desc limit 1`,
        [threadExternalId]
      );
    },

    /**
     * Points a commitment at a project (or clears it); a by-hand correction
     * also stamps touched_at.
     */
    async setProject(id: number | string, projectId: number | string, repoPath: string, confidence: number, rationale: unknown) {
      await db.query(
        `update commitment set project_id = $2, repo_path = $3, project_confidence = $4,
                           project_rationale = $5,
                           touched_at = case when $5 = 'corrected by hand' then now() else touched_at end
      where id = $1`,
        [id, projectId, repoPath, confidence, rationale]
      );
    },

    /**
     * Open, unfolded commitments that have a project, with the item's text.
     * @param {string|null} project  only this project (by name)
     * @param {number[]|null} ids  only these commitments
     * @returns {Promise<object[]>}
     */
    async projectLinks(project: unknown, ids: unknown[]) {
      return db.rows(
        `select c.id, c.project_id, c.repo_path, c.project_confidence, c.project_rationale, c.summary, c.detail,
            si.source, si.subject, si.body_text, si.raw, p.name as project
       from commitment c
       join source_item si on si.id = c.source_item_id
       join project p on p.id = c.project_id
      where c.status in ('open','dispatched') and c.superseded_by is null
        and ($1::text is null or lower(p.name) = lower($1::text))
        and ($2::bigint[] is null or c.id = any($2::bigint[]))
      order by c.id`,
        [project, ids]
      );
    },

    /**
     * Clears a commitment's project, guarded on the old project so a row
     * changed meanwhile is left alone.
     * @returns {Promise<boolean>} whether a row changed
     */
    async clearProject(id: number | string, rationale: unknown, oldProjectId: number | string) {
      const res = await db.query(
        `update commitment set project_id = null, repo_path = null, project_confidence = null, project_rationale = $2
        where id = $1 and project_id = $3 and superseded_by is null`,
        [id, rationale, oldProjectId]
      );
      return Boolean(res.rowCount);
    },

    // --- for proposals/index.js

    /** Clears a commitment's plan time, so the planner plans it again. */
    async replan(id: number | string) {
      await db.query('update commitment set planned_at = null where id = $1', [id]);
    },

    // --- for cli/index.js

    /**
     * Open commitments for `pa inbox`, newest extracted first.
     * @param {string|null} source  only items from this source
     * @param {number} limit
     */
    async inboxList(source: string, limit: number) {
      return db.rows(
        `select c.id, c.summary, c.direction, c.due_at, c.confidence, c.project_confidence,
              p.name as project, per.display_name as who, si.source, si.occurred_at
         from commitment c
         left join project p on p.id = c.project_id
         left join person per on per.id = c.counterparty_person_id
         join source_item si on si.id = c.source_item_id
        where c.status in ('open','dispatched') and c.superseded_by is null
          and ($1::text is null or si.source = $1)
        order by c.extracted_at desc limit $2`,
        [source, limit]
      );
    },

    /** One commitment with its project, person and source item, for `pa show`. Null when gone. */
    async detailForCli(id: number | string) {
      return db.one(
        `select c.*, p.name as project, per.display_name as who, per.primary_email as who_email,
              si.source, si.subject, si.body_text, si.occurred_at, si.thread_external_id
         from commitment c
         left join project p on p.id = c.project_id
         left join person per on per.id = c.counterparty_person_id
         join source_item si on si.id = c.source_item_id
        where c.id = $1`,
        [id]
      );
    },

    /**
     * For `pa doctor`: open commitments (not notes to myself) and how many have a context paragraph.
     * @returns {Promise<{n: number, with_context: number}>}
     */
    async cardContextCounts() {
      const { SELF_NOTE } = require('../commitments/selfNotes.ts');
      return db.one(
        `select count(*)::int as n, count(c.context)::int as with_context
           from commitment c join source_item si on si.id = c.source_item_id
           left join person per on per.id = c.counterparty_person_id
          where c.status in ('open','dispatched') and c.superseded_by is null and not ${SELF_NOTE}`
      );
    },

    // --- for dashboard/cards.js

    /**
     * What a card's links are built from: the commitment, its person (with
     * address and github name), project and source item (body, and the next
     * messages of its thread). With `context`, also the stored context
     * paragraph (needs sql/023).
     * @param {Array<number|string>} ids
     * @param {boolean} context
     */
    async cardDetails(ids: unknown[], context: unknown) {
      return db.rows(
        `select ${DETAIL_COLS}${context ? ', c.context, c.context_at' : ''} from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = any($1::bigint[])`,
        [ids]
      );
    },

    /**
     * Every open commitment folded into one of `ids` (superseded_by chains,
     * up to ten deep), with its source item.
     * @returns {Promise<Array<{id, root, item_id, source, external_id, thread_external_id, subject, occurred_at, raw}>>}
     */
    async foldedSourceItems(ids: unknown[]) {
      return db.rows(
        `with recursive down as (
       select c.id, c.superseded_by as root, 1 as depth from commitment c where c.superseded_by = any($1::bigint[])
       union all
       select c.id, down.root, down.depth + 1 from commitment c join down on c.superseded_by = down.id where down.depth < 10)
     select d.id, d.root, si.id as item_id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
            si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw
       from down d join commitment c on c.id = d.id join source_item si on si.id = c.source_item_id
      order by si.occurred_at desc`,
        [ids]
      );
    },

    // --- for dashboard/server.js

    /** One commitment with its person, project and source item, for the dashboard's detail view. Null when gone. */
    async contextForDashboard(id: number | string) {
      return db.one(
        `select c.id, c.direction, c.status, c.summary, c.detail, c.due_at, c.repo_path, c.project_rationale,
            p.name as project, per.display_name as who,
            si.source, si.subject, si.occurred_at, si.thread_external_id, si.author_identity,
            left(si.body_text, 4000) as body, si.raw->>'webUrl' as web_url, si.raw->>'webLink' as web_link
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
        [id]
      );
    },

    // --- for src/ingest/githubReconcile.js (chunk F)

    /**
     * Open or dispatched asks that may name a PR: from GitHub, or whose text
     * mentions github.com, a PR or pull request, or "<project> #N". With the
     * ask's action, time, URL and project.
     */
    async withPrRefs() {
      return db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.status, c.superseded_by, si.raw->>'action' as action,
            si.occurred_at as asked_at,
            case when si.source like 'github%' then coalesce(si.raw->>'webUrl', si.thread_external_id, '') else '' end as url,
            p.gitlab_path as project_path, p.name as project_name
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join project p on p.id = c.project_id and p.active
      where c.status in ('open','dispatched')
        and (si.source like 'github%' or c.summary ~* '(github\\.com/|\\mPRs?\\M|pull request)' or c.detail ~* 'github\\.com/[^/]+/[^/]+/pull/'
             or (p.name is not null and c.summary ~* ('\\m' || p.name || '\\M\\s+#?\\d')))`
      );
    },

    /** Folds an open, unfolded ask into `survivorId`. Resolves whether it did. */
    async foldOpen(id: number | string, survivorId: number | string) {
      const r = await db.query(
        `update commitment set superseded_by = $2
        where id = $1 and superseded_by is null and status = 'open'`,
        [id, survivorId]
      );
      return r.rowCount || 0;
    },

    // --- for src/mcp, src/durable/tasks/chase.ts

    /** Open asks for the chat's task list, soonest due first. @param {string} direction owed_by_me | owed_to_me | both */
    async listForTool(direction: unknown, project: unknown, limit: number) {
      return db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.due_at, c.confidence,
                p.name as project, c.repo_path, per.display_name as who
           from commitment c
           left join project p on p.id = c.project_id
           left join person per on per.id = c.counterparty_person_id
          where c.status in ('open','dispatched') and c.superseded_by is null
            and ($1 = 'both' or c.direction = $1)
            and ($2::text is null or lower(p.name) = lower($2))
          order by c.due_at nulls last, c.extracted_at desc
          limit $3`,
        [direction, project, limit]
      );
    },

    /** A person's open asks (twenty, soonest due first). */
    async openOfPerson(personId: number | string) {
      return db.rows(
        `select id, direction, summary, due_at from commitment
          where counterparty_person_id = $1 and status in ('open','dispatched')
          order by due_at nulls last limit 20`,
        [personId]
      );
    },

    /** For each commitment, its project's forge path and its newest live run. */
    async boardExtras(ids: unknown[]) {
      return db.rows(
        `select c.id::text as id, p.gitlab_path as slug,
              (select json_build_object('id', r.id, 'status', r.status, 'route', r.route, 'job', r.factory_job_id, 'state', r.factory_state)
                 from run r where r.commitment_id = c.id and r.status in ('starting','running','waiting')
                order by r.started_at desc limit 1) as run
         from commitment c left join project p on p.id = c.project_id
        where c.id = any($1::bigint[])`,
        [ids]
      );
    },

    /** One commitment with project, person and its item (body cut to 1500), for the chat's card view. */
    async cardForChat(id: number | string) {
      return db.one(
        `select c.id, c.direction, c.status, c.summary, c.detail, c.due_at, c.repo_path, p.name as project, p.gitlab_path as slug,
            per.display_name as who, si.id as item_id, si.source, si.subject, si.occurred_at, left(si.body_text, 1500) as body
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
        [id]
      );
    },

    /** The blocks a commitment is part of (as task or blocker), with the other side. */
    async blocksOf(id: number | string) {
      return db.rows(
        `select b.blocker_id::text, b.task_id::text, b.verdict, c.summary, c.status, coalesce(p.display_name, b.who, '') as who
         from commitment_block b join commitment c on c.id = b.blocker_id left join person p on p.id = c.counterparty_person_id
        where (b.task_id = $1 or b.blocker_id = $1) and c.superseded_by is null`,
        [id]
      );
    },

    /** What the chase task reads about an ask. */
    async chaseRead(id: number | string) {
      return db.one(
        `select c.id, c.status, c.direction, c.summary, c.due_at, c.counterparty_person_id,
            coalesce(per.is_me, false) as counterparty_is_me, per.display_name as who,
            si.source, si.occurred_at as asked_at
       from commitment c join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.id = $1`,
        [id]
      );
    },

    // --- for src/e2e/goldenPath.ts

    /** The e2e test's own cards (summary `e2e-<uuid>`, made by the request path): {id, status, marker, created_at}. */
    async e2eCards() {
      return db.rows(
        `select id, status, substring(summary from 'e2e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]*') as marker, extracted_at as created_at
           from commitment where summary ~ 'e2e-[0-9a-f]{8}-[0-9a-f]{4}-' and extracted_by = 'pa-request-v1'`
      );
    },
  };
}

const SETTABLE = new Set(['status', 'closed_at', 'closed_reason', 'due_at', 'detail']);

// What a dashboard card's links are built from (cardDetails).
const DETAIL_COLS = `c.id, c.summary, c.detail, p.gitlab_path, p.name as project_name,
       per.display_name as who, coalesce(per.is_me, false) as who_is_me,
       coalesce((select pi.value from person_identity pi where pi.person_id = per.id and pi.kind = 'smtp' order by pi.id limit 1),
                per.primary_email) as who_email,
       (select pi.value from person_identity pi where pi.person_id = per.id and pi.kind in ('github_username','github') order by pi.id limit 1) as who_github,
       si.id as item_id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
       si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw,
       case when si.source = 'claude_session' then '' else left(si.body_text, 20000) end as body,
       -- The next few messages in the thread: the PR someone posted after the
       -- ask is the link the card most needs. A session's thread is its
       -- folder (other sessions), so not for those.
       case when si.source = 'claude_session' or si.thread_external_id is null then '' else
         (select string_agg(left(t.body_text, 4000), E'\\n' order by t.occurred_at)
            from (select t.body_text, t.occurred_at from source_item t
                   where t.source = si.source and t.thread_external_id = si.thread_external_id
                     and t.occurred_at > si.occurred_at
                   order by t.occurred_at limit 8) t) end as later`;

module.exports = { create };