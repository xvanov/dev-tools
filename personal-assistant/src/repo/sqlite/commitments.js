'use strict';

// SQLite twin of src/repo/commitments.js (commitment, commitment_block,
// commitment_review, commitment_vector, reply_close, distillation).
//
// Callers hand some methods SQL predicates (sourcePolicy.sourceSql,
// selfNotes.SELF_NOTE, distill's DEBRIEF_OWNED): they use only `in (...)`,
// `like`, `coalesce`, `exists` and `raw->>'key'`, which SQLite (>= 3.38) reads
// as Postgres does, so they are spliced in unchanged.

const { NOW, DAY, sinceMs } = require('./_sql');

const LIVE = `c.status in ('open','dispatched') and c.superseded_by is null`;

/** Text instants an expression column returned (no declared type to decode by) as Dates. */
function dates(row, ...cols) {
  if (row) for (const c of cols) if (typeof row[c] === 'string') row[c] = new Date(row[c]);
  return row;
}

/** 0/1 from an expression column as true/false, as pg's boolean. */
function bools(row, ...cols) {
  if (row) for (const c of cols) if (typeof row[c] === 'number') row[c] = Boolean(row[c]);
  return row;
}

/** A float32 as pgvector prints it: the shortest decimal that reads back as the same float32. */
function f32text(x) {
  for (let p = 1; p < 10; p++) {
    const s = Number(x.toPrecision(p));
    if (Math.fround(s) === x) return String(s);
  }
  return String(x);
}

/** A vector (Float32Array from the BLOB) as pgvector's text form '[1,0,...]'. */
function vectorText(v) {
  if (v == null || typeof v === 'string') return v;
  return `[${Array.from(v, f32text).join(',')}]`;
}

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

const POLICY_CANDIDATES = `
  select c.id, c.summary, c.direction, c.status, c.touched_at, c.closed_at, c.closed_reason,
         si.id as item_id, si.source, si.author_identity, si.raw,
         c.touched_at is not null as touched,
         exists (select 1 from run r where r.commitment_id = c.id) as has_run,
         exists (select 1 from draft d where d.commitment_id = c.id) as has_draft,
         exists (select 1 from ledger_transition t where t.commitment_id = c.id and t.actor = 'you') as you_moved
    from commitment c join source_item si on si.id = c.source_item_id
   where c.status = 'open' and c.superseded_by is null
   order by c.id`;

// Who wrote an item, as a name (see src/repo/commitments.js AUTHOR).
const AUTHOR = (t) => `coalesce(${t}.raw->>'fromName',
  (select p.display_name from person_identity pi join person p on p.id = pi.person_id
    where lower(pi.value) = lower(case when substr(coalesce(${t}.author_identity, ''), 1, 7) = 'github:'
                                       then substr(${t}.author_identity, 8) else coalesce(${t}.author_identity, '') end) limit 1),
  ${t}.author_identity)`;

const ACTED = (a) => `(${a}.status = 'dispatched' or ${a}.touched_at is not null
   or exists (select 1 from draft d where d.commitment_id = ${a}.id)
   or exists (select 1 from run r where r.commitment_id = ${a}.id)
   or exists (select 1 from ledger_transition t where t.commitment_id = ${a}.id)
   or exists (select 1 from reply_close rc where rc.commitment_id = ${a}.id and rc.applied is not null and rc.undone_at is null))`;

const EXISTING = `
  select c.id, c.status, c.summary, c.touched_at is not null as touched,
         (exists (select 1 from draft d where d.commitment_id = c.id)
          or exists (select 1 from run r where r.commitment_id = c.id)
          or exists (select 1 from ledger_transition t where t.commitment_id = c.id)
          or exists (select 1 from ledger_evidence e where e.commitment_id = c.id)
          or exists (select 1 from reply_close rc where rc.commitment_id = c.id)) as refs
    from commitment c
   where c.source_item_id = $1 and c.superseded_by is null`;

const ids = (list) => (list || []).map(Number);

/** The start of today on this machine's clock (pg: date_trunc('day', now()) in the server's zone). */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function create(db) {
  return {
    // --- for brief/index.js

    /** Open and dispatched commitments for the brief (see src/repo/commitments.js). */
    async openForBrief(selfNote, limit) {
      const { SELF_NOTE } = require('../../commitments/selfNotes');
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
        limit ${Number(limit)}`
      );
    },

    // --- for agent/planner.js

    /** Open asks of mine with no plan, under a week old, not notes, no pending evidence or run. */
    async toPlan(limit) {
      const { SELF_NOTE } = require('../../commitments/selfNotes');
      return db.rows(
        `select c.id, c.summary, c.detail, c.repo_path, c.project_id, pr.name as project,
            per.display_name as who, si.source, substr(si.body_text, 1, 800) as ask_text
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
       left join project pr on pr.id = c.project_id and pr.active
      where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
        and c.planned_at is null
        and not exists (select 1 from ledger_evidence e where e.commitment_id = c.id
                         and e.effect in ('closes','moot') and e.decision is null)
        and not exists (select 1 from run r where r.commitment_id = c.id)
        and si.occurred_at > $2
        and not ${SELF_NOTE}
      order by si.occurred_at desc
      limit $1`,
        [limit, sinceMs(7 * DAY)]
      );
    },

    /** How many commitments got a research run planned today. */
    async researchStartedToday() {
      const r = await db.one(
        `select count(*) as n from commitment
        where plan->>'researchRunId' is not null and planned_at >= $1`,
        [startOfToday()]
      );
      return r.n;
    },

    /** Records the planner's decision on a commitment. */
    async setPlan(id, kind, plan) {
      await db.query(`update commitment set kind = $2, plan = $3, planned_at = ${NOW} where id = $1`, [id, kind, plan]);
    },

    /** Marks a commitment planned with kind 'other' (no plan made). */
    async markPlannedOther(id) {
      await db.query(`update commitment set kind = 'other', planned_at = ${NOW} where id = $1`, [id]);
    },

    /** Pull requests (github_pr items) in each commitment's project since the ask was made. */
    async shippedSinceAsk(commitmentIds) {
      return db.rows(
        `select c.id as commitment_id, si.subject
         from commitment c
         join source_item ask on ask.id = c.source_item_id
         join project pr on pr.id = c.project_id
         join source_item si on si.source = 'github_pr'
          and lower(si.raw->>'project') = lower(pr.gitlab_path)
          and si.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', ask.occurred_at, '-1 day')
        where c.id in (select value from json_each($1))
        order by si.occurred_at desc`,
        [ids(commitmentIds)]
      );
    },

    // --- for meetings/index.js

    /** Things I did and closed in a window (6, newest first). */
    async closedByMeBetween(from, to) {
      return db.rows(
        `select id, summary, closed_reason, closed_at from commitment
      where direction = 'owed_by_me' and status = 'done' and closed_at between $1 and $2
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
        and due_at is not null and due_at < $1 and due_at > $2
      order by due_at limit 6`,
        [sinceMs(-2 * DAY, now), sinceMs(14 * DAY, now)]
      );
    },

    /** My undated asks extracted in the last day with confidence >= 0.6 (4, newest first). */
    async freshAsksOwedByMe(now) {
      return db.rows(
        `select id, summary from commitment
      where direction = 'owed_by_me' and status = 'open' and superseded_by is null and due_at is null
        and extracted_at > $1 and coalesce(confidence, 0) >= 0.6
      order by extracted_at desc limit 4`,
        [sinceMs(DAY, now)]
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

    /** Open and dispatched commitments for the debrief (80), those with a person in `attendeeEmails` first. */
    async openForDebrief(attendeeEmails) {
      return db.rows(
        `select c.id, c.direction, c.summary, c.detail, c.due_at, c.status, c.closed_at, c.closed_reason,
            p.display_name as counterparty, lower(p.primary_email) as counterparty_email
       from commitment c left join person p on p.id = c.counterparty_person_id
      where c.status in ('open','dispatched') and c.superseded_by is null
      order by (lower(p.primary_email) in (select value from json_each($1))) desc nulls last, c.due_at nulls last, c.extracted_at desc
      limit 80`,
        [attendeeEmails || []]
      );
    },

    /** Creates a commitment a debrief heard. Resolves its id. */
    async insertFromDebrief({ sourceItemId, direction, summary, detail, counterpartyPersonId, dueAt, confidence, extractedBy }) {
      const r = await db.one(
        `insert into commitment (source_item_id, direction, summary, detail, counterparty_person_id, due_at, confidence, extracted_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [sourceItemId, direction, summary, detail, counterpartyPersonId, dueAt, confidence, extractedBy]
      );
      return r.id;
    },

    /** Sets columns a debrief may change; other keys are ignored. */
    async setDebriefColumns(id, set) {
      const cols = Object.keys(set).filter((k) => SETTABLE.has(k));
      if (!cols.length) return;
      await db.query(`update commitment set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [id, ...cols.map((c) => set[c])]);
    },

    /** Deletes a commitment a debrief created (only while still extracted by `extractedBy`). */
    async deleteExtractedBy(id, extractedBy) {
      await db.query('delete from commitment where id = $1 and extracted_by = $2', [id, extractedBy]);
    },

    /** One commitment row, or null. */
    async rowForUndo(id) {
      return db.one('select * from commitment where id = $1', [id]);
    },

    // --- src/commitments.js

    /** A commitment's id, status and summary; null when there is none. */
    async summaryRow(id) {
      return db.one('select id, status, summary from commitment where id = $1', [id]);
    },

    /** The open rest of `id`'s duplicate group, `id` itself excluded. */
    async openDuplicatesOf(id) {
      return db.rows(DUPLICATE_SET_SQL, [Number(id)]);
    },

    /** Closed in the last `days` days, newest first, with the source and who closed it last. */
    async recentlyClosed(days, limit) {
      return db.rows(
        `select c.id, c.summary, c.status, c.closed_reason, c.closed_at, si.source,
            coalesce(si.raw->>'webUrl', si.thread_external_id) as url,
            (select t.actor from ledger_transition t where t.commitment_id = c.id and t.undone_at is null
              order by t.at desc, t.id desc limit 1) as actor
       from commitment c join source_item si on si.id = c.source_item_id
      where c.closed_at > $1
      order by c.closed_at desc limit $2`,
        [sinceMs(Number(days) * DAY), limit]
      );
    },

    // --- src/commitments/blocks.js

    /** Your own open tasks (owed_by_me) from sources the policy allows. */
    async blockTasks(srcSql) {
      return db.rows(
        `select c.id, c.summary, c.detail, c.extracted_at from commitment c join source_item si on si.id = c.source_item_id
      where ${LIVE} and c.direction = 'owed_by_me' and ${srcSql} order by c.id`
      );
    },

    /** Open owed_to_me commitments with their block verdict, if any. */
    async blockCandidates(srcSql) {
      const rows = await db.rows(
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
      for (const r of rows) bools(r, 'task_gone');
      return rows;
    },

    /** Cosine similarity of each (blocker, task) pair that has vectors on both. */
    async blockLinkCosines(blockerIds, taskIds) {
      return db.rows(
        `select cast(xb.value as text) as b, 1 - vec_distance_cosine(vb.embedding, vt.embedding) as cos
       from json_each($1) xb join json_each($2) xt on xt.key = xb.key
       join commitment_vector vb on vb.commitment_id = xb.value
       join commitment_vector vt on vt.commitment_id = xt.value`,
        [ids(blockerIds), ids(taskIds)]
      );
    },

    /** Writes the model's verdict on a blocker; a row you set by hand (manual) is never changed. */
    async upsertBlockJudged(blockerId, taskId, verdict, why, who) {
      await db.query(
        `insert into commitment_block (blocker_id, task_id, verdict, why, who, judged_at) values ($1, $2, $3, $4, $5, ${NOW})
         on conflict (blocker_id) do update set task_id = excluded.task_id, verdict = excluded.verdict, why = excluded.why,
           who = excluded.who, judged_at = ${NOW}
          where not commitment_block.manual`,
        [blockerId, taskId, verdict, why, who]
      );
    },

    /** Your call on a card: writes the verdict and marks it manual. */
    async upsertBlockManual(blockerId, taskId, verdict, why) {
      await db.query(
        `insert into commitment_block (blocker_id, task_id, verdict, why, manual, judged_at) values ($1, $2, $3, $4, 1, ${NOW})
     on conflict (blocker_id) do update set task_id = coalesce(excluded.task_id, case when excluded.verdict = 'blocks' then commitment_block.task_id end),
       verdict = excluded.verdict, why = coalesce(excluded.why, commitment_block.why), manual = 1, judged_at = ${NOW}`,
        [blockerId, taskId, verdict, why]
      );
    },

    /** Every judged blocker that is open, or closed in the last `days` days while blocking an open task. */
    async blocksForBoard(days) {
      return db.rows(
        `select cast(b.blocker_id as text) as blocker_id, cast(b.task_id as text) as task_id, b.verdict, b.why, b.manual,
            c.status, c.closed_at, c.closed_reason, c.summary, coalesce(p.display_name, b.who, '') as who
       from commitment_block b
       join commitment c on c.id = b.blocker_id
       left join person p on p.id = c.counterparty_person_id
      where c.superseded_by is null
        and (c.status in ('open','dispatched')
             or (b.verdict = 'blocks' and b.task_id is not null and c.status = 'done'
                 and c.closed_at > $1))`,
        [sinceMs(Number(days) * DAY)]
      );
    },

    // --- src/commitments/policyClose.js

    /** Open, unfolded commitments with their source item and what acted on them. */
    async policyCandidates() {
      const rows = await db.rows(POLICY_CANDIDATES);
      for (const r of rows) bools(r, 'touched', 'has_run', 'has_draft', 'you_moved');
      return rows;
    },

    /** Open or dispatched commitments folded under any of `ids`. */
    async foldedUnder(survivorIds) {
      return db.rows(
        `select c.id, c.superseded_by, c.summary, si.source, si.author_identity, si.raw
           from commitment c join source_item si on si.id = c.source_item_id
          where c.status in ('open','dispatched') and c.superseded_by in (select value from json_each($1))`,
        [ids(survivorIds)]
      );
    },

    /** Unfolds a commitment still folded under `supersededBy`. Resolves whether a row changed. */
    async unfold(id, supersededBy) {
      const r = await db.query('update commitment set superseded_by = null where id = $1 and superseded_by = $2', [id, supersededBy]);
      return Boolean(r.rowCount);
    },

    // --- src/commitments/selfNotes.js

    /** Ids of open self-notes nobody touched for `days` days. */
    async expiredSelfNotes(days, selfNoteSql) {
      return db.rows(
        `select c.id from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.status = 'open' and c.superseded_by is null
        and coalesce(c.touched_at, si.occurred_at) < $1
        and ${selfNoteSql}`,
        [sinceMs(Number(days) * DAY)]
      );
    },

    // --- src/commitments/context.js

    /** Commitments on a card whose context is missing or stale, most visible first. */
    async dueForContext(limit, version, refreshMinutes, selfNoteSql) {
      return db.rows(
        `with card as (
       select p.commitment_id as id, 0 as prio from proposal p
        where p.status = 'pending' and p.commitment_id is not null and (p.expires_at is null or p.expires_at > ${NOW})
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
             or (c.context_at < $3
                 and (c.context is null or c.context_by is not $2
                      or exists (select 1 from source_item t
                                  where t.fetched_at > c.context_at
                                    and (t.id = si.id or (si.source <> 'claude_session' and si.thread_external_id is not null
                                         and t.source = si.source and t.thread_external_id = si.thread_external_id))))))
      group by c.id
      order by min(card.prio), c.id desc
      limit $1`,
        [limit, version, sinceMs(Number(refreshMinutes) * 60_000)]
      );
    },

    /** What the context prompt needs for one commitment; null when it is gone. */
    async contextCard(id) {
      const row = await db.one(
        `select c.id, c.summary, c.detail, c.direction, c.status, c.due_at, c.kind,
            coalesce(p.gitlab_path, p.name) as project, per.display_name as who,
            si.id as item_id, si.source, si.subject, si.occurred_at, si.thread_external_id,
            json_remove(si.raw, '$.members', '$.memberEmails', '$.audioPaths') as raw,
            substr(si.body_text, 1, 20000) as body, ${AUTHOR('si')} as author
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
        [id]
      );
      if (row && typeof row.raw === 'string') row.raw = JSON.parse(row.raw);
      return row;
    },

    /** The messages around a source item in its thread: up to four before it, up to nine from it on (unsorted). */
    async contextThread(source, threadExternalId, occurredAt, itemId) {
      const cols = `t.id, t.occurred_at, substr(t.body_text, 1, 900) as body, ${AUTHOR('t')} as author`;
      const rows = await db.rows(
        `select * from (select ${cols} from source_item t
         where t.source = $1 and t.thread_external_id = $2 and t.occurred_at < $3 and t.id <> $4
         order by t.occurred_at desc limit 4)
       union all
       select * from (select ${cols} from source_item t
         where t.source = $1 and t.thread_external_id = $2 and (t.occurred_at >= $3 or t.id = $4)
         order by t.occurred_at asc limit 9)`,
        [source, threadExternalId, occurredAt, itemId]
      );
      for (const r of rows) dates(r, 'occurred_at');
      return rows;
    },

    /** Stores a card's context paragraph (kept when `text` is null) and stamps when and by what. */
    async setContext(id, text, by) {
      await db.query(`update commitment set context = coalesce($2, context), context_at = ${NOW}, context_by = $3 where id = $1`, [id, text, by]);
    },

    /** Stamps context_at, so a failed card is retried after the refresh interval. */
    async stampContextAt(id) {
      await db.query(`update commitment set context_at = ${NOW} where id = $1`, [id]);
    },

    // --- src/commitments/dedupe.js

    /** Open commitments with no vector yet, newest first. */
    async unvectored(limit, windowDays, policySql) {
      return db.rows(
        `select c.id, c.summary, c.detail, si.thread_external_id
       from commitment c join source_item si on si.id = c.source_item_id
       left join commitment_vector v on v.commitment_id = c.id
      where v.commitment_id is null and ${LIVE} and ${policySql}
        and c.extracted_at > $2
      order by c.extracted_at desc limit $1`,
        [limit, sinceMs(Number(windowDays) * DAY)]
      );
    },

    /** Stores a commitment's embedding (`vector` as '[..]' text) and anchors; a second is a no-op. */
    async insertVector(commitmentId, vector, anchors) {
      await db.query(
        `insert into commitment_vector (commitment_id, embedding, anchors) values ($1, pa_vector($2), $3)
         on conflict (commitment_id) do nothing`,
        [commitmentId, typeof vector === 'string' ? vector : JSON.stringify(Array.from(vector)), anchors || []]
      );
    },

    /** The open, unfolded, recent commitments with a vector: the comparison pool. `embedding` is the vector as text. */
    async dedupePool(windowDays, policySql) {
      const rows = await db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.status, c.due_at, c.extracted_at, c.source_item_id,
            (c.counterparty_person_id is not null and not coalesce(p.is_me, 0)) as has_party,
            coalesce(p.display_name, '') as who, si.source, si.thread_external_id,
            coalesce(si.raw->>'webUrl', si.raw->>'webLink') as web_url,
            coalesce(si.raw->>'chatTopic', si.subject, '') as place,
            v.embedding, v.anchors, v.checked_at,
            ${ACTED('c')} as acted
       from commitment c
       join commitment_vector v on v.commitment_id = c.id
       join source_item si on si.id = c.source_item_id
       left join person p on p.id = c.counterparty_person_id
      where ${LIVE} and ${policySql} and c.extracted_at > $1
      order by c.id`,
        [sinceMs(Number(windowDays) * DAY)]
      );
      for (const r of rows) {
        bools(r, 'has_party', 'acted');
        r.embedding = vectorText(r.embedding);
      }
      return rows;
    },

    /** Follows superseded_by to the live survivor of `id`; zero or one row. */
    async survivorOf(id) {
      return db.rows(
        `with recursive up as (select id, superseded_by, 0 as n from commitment where id = $1
        union all select c.id, c.superseded_by, up.n + 1 from commitment c join up on c.id = up.superseded_by where up.n < 20)
     select id from up where superseded_by is null limit 1`,
        [Number(id)]
      );
    },

    /** Folds `drop` under `keep`, only while `drop` is a live row nothing else folded meanwhile. */
    async fold(drop, keep) {
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
        `update commitment_vector set checked_at = ${NOW}
       where checked_at is null
         and exists (select 1 from commitment c where c.id = commitment_vector.commitment_id
                      and not (c.status in ('open','dispatched') and c.superseded_by is null))`
      );
    },

    /** Marks one vector checked, with the fold note (or null) as its verdict. */
    async markVectorChecked(commitmentId, verdict) {
      await db.query(`update commitment_vector set checked_at = ${NOW}, verdict = $2 where commitment_id = $1`, [commitmentId, verdict]);
    },

    /** Marks every unchecked vector checked (the one-off backfill). */
    async checkAllVectors() {
      await db.query(`update commitment_vector set checked_at = coalesce(checked_at, ${NOW})`);
    },

    // --- src/commitments/replyClose.js

    /** Open owed_by_me asks from `sources` with a reply of mine in the window that no judgement at this version has seen. */
    async replyCloseCandidates(me, version, limit, { windowDays, sources, maxAttempts }) {
      const rows = await db.rows(
        `
  with x as (
    select c.id, c.summary, c.detail, c.due_at, c.status, c.closed_at, c.closed_reason,
           si.id as item_id, si.source, si.thread_external_id, si.occurred_at, si.author_identity,
           si.subject, si.body_text, p.display_name as counterparty,
           (select mine.id from source_item mine
             where mine.source = si.source and mine.thread_external_id = si.thread_external_id
               and mine.id <> si.id
               and mine.occurred_at > si.occurred_at
               and mine.occurred_at <= strftime('%Y-%m-%dT%H:%M:%fZ', si.occurred_at, '+${Number(windowDays)} days')
               and lower(coalesce(mine.author_identity, '')) in (select value from json_each($1))
             order by mine.occurred_at desc, mine.id desc limit 1) as last_message_id
      from commitment c
      join source_item si on si.id = c.source_item_id
      left join person p on p.id = c.counterparty_person_id
     where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
       and si.source in (select value from json_each($4)) and si.thread_external_id is not null)
  select x.*, last.occurred_at as last_at
    from x join source_item last on last.id = x.last_message_id
   where not exists (
       select 1 from reply_close r
        where r.commitment_id = x.id and r.extracted_by = $2 and r.last_message_id = x.last_message_id
          and (r.error is null or r.attempts >= ${Number(maxAttempts)}))
   order by last.occurred_at desc
   limit $3`,
        [me || [], version, limit, sources || []]
      );
      for (const r of rows) dates(r, 'due_at', 'closed_at', 'occurred_at', 'last_at');
      return rows;
    },

    /** My later messages in the thread of a source item, within the window. */
    async replyCloseReplies(me, source, threadExternalId, itemId, occurredAt, { windowDays, limit }) {
      return db.rows(
        `select mine.id, mine.occurred_at, mine.body_text from source_item mine
      where mine.source = $2 and mine.thread_external_id = $3 and mine.id <> $4
        and mine.occurred_at > $5 and mine.occurred_at <= $6
        and lower(coalesce(mine.author_identity, '')) in (select value from json_each($1))
      order by mine.occurred_at, mine.id limit ${Number(limit)}`,
        [me || [], source, threadExternalId, itemId, occurredAt, sinceMs(-Number(windowDays) * DAY, occurredAt)]
      );
    },

    /** Records a judgement; the same (commitment, version, last message) is updated and its attempts counted. */
    async recordReplyClose(c, version, j, applied = null) {
      await db.query(
        `insert into reply_close (commitment_id, extracted_by, last_message_id, verdict, quote, message_id, confidence, applied, attempts, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, null)
     on conflict (commitment_id, extracted_by, last_message_id) do update
        set verdict = excluded.verdict, quote = excluded.quote, message_id = excluded.message_id,
            confidence = excluded.confidence, applied = excluded.applied, error = null,
            attempts = reply_close.attempts + 1, judged_at = ${NOW}`,
        [c.id, version, c.last_message_id, j.verdict, j.quote, j.message?.id ?? null, j.confidence ?? null, applied]
      );
    },

    /** Records a failed judgement (`message` is clipped by the caller). */
    async recordReplyCloseError(c, version, message) {
      await db.query(
        `insert into reply_close (commitment_id, extracted_by, last_message_id, error, attempts)
     values ($1, $2, $3, $4, 1)
     on conflict (commitment_id, extracted_by, last_message_id) do update
        set error = excluded.error, attempts = reply_close.attempts + 1, judged_at = ${NOW}`,
        [c.id, version, c.last_message_id, message]
      );
    },

    /** The commitment's status columns (inside withTx the transaction holds the write lock). */
    async lockStatus(id) {
      return db.one('select id, status, closed_at, closed_reason from commitment where id = $1', [id]);
    },

    /** The newest applied, not yet undone reply-close judgement on a commitment. */
    async latestAppliedReplyClose(commitmentId) {
      return db.one(
        `select * from reply_close where commitment_id = $1 and applied is not null and undone_at is null
      order by judged_at desc, id desc limit 1`,
        [commitmentId]
      );
    },

    /** Marks a reply_close row undone, with what the undo said. */
    async markReplyCloseUndone(id, result) {
      await db.query(`update reply_close set undone_at = ${NOW}, undo = $2 where id = $1`, [id, result]);
    },

    /** Puts back the columns a close overwrote. */
    async restoreClosedState(id, status, closedAt, closedReason) {
      await db.query('update commitment set status = $2, closed_at = $3, closed_reason = $4 where id = $1', [id, status, closedAt, closedReason]);
    },

    /** Counts for `pa doctor`: closed, judged, failed and the last judgement time. */
    async replyCloseStats(maxAttempts) {
      return dates(
        await db.one(
          `select count(*) filter (where r.applied is not null and r.undone_at is null
                              and c.closed_reason = r.applied->'set'->>'closed_reason') as closed,
            count(*) filter (where r.error is null) as judged,
            count(*) filter (where r.error is not null and r.attempts >= ${Number(maxAttempts)}) as failed,
            max(r.judged_at) as last
       from reply_close r left join commitment c on c.id = r.commitment_id`
        ),
        'last'
      );
    },

    // --- src/commitments/request.js

    /** Inserts a task you asked for (confidence 1) and returns its id. */
    async insertRequested(v) {
      return db.one(
        `insert into commitment
           (source_item_id, direction, summary, detail, counterparty_person_id, due_at, project_id, repo_path,
            project_confidence, project_rationale, confidence, extracted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11) returning id`,
        [v.itemId, v.direction, v.summary, v.detail, v.personId, v.dueAt, v.projectId, v.repoPath, v.projectConfidence, v.projectRationale, v.extractedBy]
      );
    },

    // --- src/distill/index.js

    /** Source items with no distillation at this prompt version, newest first. */
    async pendingDistill(version, minChars, limit, skipSql, allowedSql) {
      return db.rows(
        `select si.* from source_item si
       left join distillation d
         on d.source_item_id = si.id and d.extracted_by = $1
      where d.source_item_id is null and not ${skipSql} and ${allowedSql}
        and length(si.body_text) >= $2
      order by si.occurred_at desc
      limit $3`,
        [version, minChars, limit]
      );
    },

    /** How many items pendingDistill would return (without a limit). */
    async pendingDistillCount(version, minChars, skipSql, allowedSql) {
      return db.one(
        `select count(*) as n from source_item si
       left join distillation d
         on d.source_item_id = si.id and d.extracted_by = $1
      where d.source_item_id is null and not ${skipSql} and ${allowedSql} and length(si.body_text) >= $2`,
        [version, minChars]
      );
    },

    /** An item's live commitments with whether anything has acted on them. */
    async liveForItem(itemId) {
      const rows = await db.rows(EXISTING, [itemId]);
      for (const r of rows) bools(r, 'touched', 'refs');
      return rows;
    },

    /** Deletes commitments by id. */
    async deleteByIds(list) {
      await db.query('delete from commitment where id in (select value from json_each($1))', [ids(list)]);
    },

    /** Inserts one distilled commitment. */
    async insertDistilled(v) {
      await db.query(
        `insert into commitment
           (source_item_id, direction, summary, detail, counterparty_person_id, due_at,
            project_id, repo_path, project_confidence, project_rationale, confidence, extracted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [v.itemId, v.direction, v.summary, v.detail, v.personId, v.dueAt, v.projectId, v.repoPath, v.projectConfidence, v.projectRationale, v.confidence, v.extractedBy]
      );
    },

    /** Marks an item distilled with its counts; clears any earlier error. */
    async upsertDistillation(itemId, version, commitments, facts) {
      await db.query(
        `insert into distillation (source_item_id, extracted_by, commitments, facts, error)
       values ($1,$2,$3,$4,null)
       on conflict (source_item_id) do update set
         extracted_by = excluded.extracted_by,
         extracted_at = ${NOW},
         commitments  = excluded.commitments,
         facts        = excluded.facts,
         error        = null`,
        [itemId, version, commitments, facts]
      );
    },

    /** Marks an item failed, with the (clipped) error, so the pass moves on. */
    async markDistillFailed(itemId, version, error) {
      await db.query(
        `insert into distillation (source_item_id, extracted_by, error)
       values ($1,$2,$3)
       on conflict (source_item_id) do update set
         extracted_by = excluded.extracted_by, extracted_at = ${NOW}, error = excluded.error`,
        [itemId, version, error]
      );
    },

    /** Marks an item the source policy keeps off the board as distilled with nothing found. */
    async markDistillSkipped(itemId, version) {
      await db.query(
        `insert into distillation (source_item_id, extracted_by, commitments, facts) values ($1, $2, 0, 0)
     on conflict (source_item_id) do update set extracted_by = excluded.extracted_by, extracted_at = ${NOW}, error = null`,
        [itemId, version]
      );
    },

    /** Marks an item the debrief owns as distilled (a no-op when it already is). */
    async markDistillOwnedByDebrief(itemId, version) {
      await db.query('insert into distillation (source_item_id, extracted_by) values ($1, $2) on conflict (source_item_id) do nothing', [itemId, version]);
    },

    // --- src/distill/identity.js, src/projects/index.js

    /** Re-points every commitment's counterparty from one person to another (a person merge). */
    async reassignCounterparty(intoId, fromId) {
      await db.query('update commitment set counterparty_person_id = $1 where counterparty_person_id = $2', [intoId, fromId]);
    },

    /** One commitment row by id (null when gone). */
    async byId(id) {
      return db.one('select * from commitment where id = $1', [id]);
    },

    /** Distinct projects of commitments extracted in the last 14 days (at most 20). */
    async recentProjectIds() {
      return db.rows(
        `select distinct project_id from commitment
      where project_id is not null and extracted_at > $1
      order by project_id limit 20`,
        [sinceMs(14 * DAY)]
      );
    },

    /** The (at most 5) projects a person's commitments most often sit in. */
    async projectsOfPerson(personId) {
      return db.rows(
        `select project_id, count(*) as n from commitment
          where counterparty_person_id = $1 and project_id is not null
          group by project_id order by n desc limit 5`,
        [personId]
      );
    },

    /** The project of the newest commitment from a thread, or null. */
    async projectOfThread(threadExternalId) {
      return db.one(
        `select c.project_id from commitment c
           join source_item si on si.id = c.source_item_id
          where si.thread_external_id = $1 and c.project_id is not null
          order by c.extracted_at desc limit 1`,
        [threadExternalId]
      );
    },

    /** Points a commitment at a project (or clears it); a by-hand correction also stamps touched_at. */
    async setProject(id, projectId, repoPath, confidence, rationale) {
      await db.query(
        `update commitment set project_id = $2, repo_path = $3, project_confidence = $4,
                           project_rationale = $5,
                           touched_at = case when $5 = 'corrected by hand' then ${NOW} else touched_at end
      where id = $1`,
        [id, projectId, repoPath, confidence, rationale]
      );
    },

    /** Open, unfolded commitments that have a project, with the item's text. */
    async projectLinks(project, only) {
      return db.rows(
        `select c.id, c.project_id, c.repo_path, c.project_confidence, c.project_rationale, c.summary, c.detail,
            si.source, si.subject, si.body_text, si.raw, p.name as project
       from commitment c
       join source_item si on si.id = c.source_item_id
       join project p on p.id = c.project_id
      where c.status in ('open','dispatched') and c.superseded_by is null
        and ($1 is null or lower(p.name) = lower($1))
        and ($2 is null or c.id in (select value from json_each($2)))
      order by c.id`,
        [project, only ? ids(only) : null]
      );
    },

    /** Clears a commitment's project, guarded on the old project. Resolves whether a row changed. */
    async clearProject(id, rationale, oldProjectId) {
      const res = await db.query(
        `update commitment set project_id = null, repo_path = null, project_confidence = null, project_rationale = $2
        where id = $1 and project_id = $3 and superseded_by is null`,
        [id, rationale, oldProjectId]
      );
      return Boolean(res.rowCount);
    },

    // --- for proposals/index.js

    /** Clears a commitment's plan time, so the planner plans it again. */
    async replan(id) {
      await db.query('update commitment set planned_at = null where id = $1', [id]);
    },

    // --- for pa doctor, the dashboard and the CLI (chunk G)

    /** For `pa doctor`: open commitments (not notes to myself) and how many have a context paragraph. */
    async cardContextCounts() {
      const { SELF_NOTE } = require('../../commitments/selfNotes');
      return db.one(
        `select count(*) as n, count(c.context) as with_context
           from commitment c join source_item si on si.id = c.source_item_id
           left join person per on per.id = c.counterparty_person_id
          where c.status in ('open','dispatched') and c.superseded_by is null and not ${SELF_NOTE}`
      );
    },

    /** What a card's links are built from (see src/repo/commitments.js). */
    async cardDetails(list, context) {
      const rows = await db.rows(
        `select ${DETAIL_COLS}${context ? ', c.context, c.context_at' : ''} from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id in (select value from json_each($1))`,
        [ids(list)]
      );
      for (const r of rows) {
        if (typeof r.raw === 'string') r.raw = JSON.parse(r.raw);
        r.who_is_me = Boolean(r.who_is_me);
      }
      return rows;
    },

    /** One commitment with its person, project and source item, for the dashboard's detail view. Null when gone. */
    async contextForDashboard(id) {
      return db.one(
        `select c.id, c.direction, c.status, c.summary, c.detail, c.due_at, c.repo_path, c.project_rationale,
            p.name as project, per.display_name as who,
            si.source, si.subject, si.occurred_at, si.thread_external_id, si.author_identity,
            substr(si.body_text, 1, 4000) as body, si.raw->>'webUrl' as web_url, si.raw->>'webLink' as web_link
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
        [id]
      );
    },

    /** One commitment with its project, person and source item, for `pa show`. Null when gone. */
    async detailForCli(id) {
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

    /** Every open commitment folded into one of `ids` (superseded_by chains, up to ten deep), with its source item. */
    async foldedSourceItems(list) {
      const rows = await db.rows(
        `with recursive down as (
       select c.id, c.superseded_by as root, 1 as depth from commitment c where c.superseded_by in (select value from json_each($1))
       union all
       select c.id, down.root, down.depth + 1 from commitment c join down on c.superseded_by = down.id where down.depth < 10)
     select d.id, d.root, si.id as item_id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
            json_remove(si.raw, '$.members', '$.memberEmails', '$.audioPaths') as raw
       from down d join commitment c on c.id = d.id join source_item si on si.id = c.source_item_id
      order by si.occurred_at desc`,
        [ids(list)]
      );
      for (const r of rows) if (typeof r.raw === 'string') r.raw = JSON.parse(r.raw);
      return rows;
    },

    /** Open commitments for `pa inbox`, newest extracted first. */
    async inboxList(source, limit) {
      return db.rows(
        `select c.id, c.summary, c.direction, c.due_at, c.confidence, c.project_confidence,
              p.name as project, per.display_name as who, si.source, si.occurred_at
         from commitment c
         left join project p on p.id = c.project_id
         left join person per on per.id = c.counterparty_person_id
         join source_item si on si.id = c.source_item_id
        where c.status in ('open','dispatched') and c.superseded_by is null
          and ($1 is null or si.source = $1)
        order by c.extracted_at desc, c.id desc limit $2`,
        [source, limit]
      );
    },
  };
}

const SETTABLE = new Set(['status', 'closed_at', 'closed_reason', 'due_at', 'detail']);

// What a dashboard card's links are built from (cardDetails; src/repo/commitments.js DETAIL_COLS).
const DETAIL_COLS = `c.id, c.summary, c.detail, p.gitlab_path, p.name as project_name,
       per.display_name as who, coalesce(per.is_me, 0) as who_is_me,
       coalesce((select pi.value from person_identity pi where pi.person_id = per.id and pi.kind = 'smtp' order by pi.id limit 1),
                per.primary_email) as who_email,
       (select pi.value from person_identity pi where pi.person_id = per.id and pi.kind in ('github_username','github') order by pi.id limit 1) as who_github,
       si.id as item_id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
       json_remove(si.raw, '$.members', '$.memberEmails', '$.audioPaths') as raw,
       case when si.source = 'claude_session' then '' else substr(si.body_text, 1, 20000) end as body,
       case when si.source = 'claude_session' or si.thread_external_id is null then '' else
         (select group_concat(substr(t.body_text, 1, 4000), char(10) order by t.occurred_at)
            from (select t.body_text, t.occurred_at from source_item t
                   where t.source = si.source and t.thread_external_id = si.thread_external_id
                     and t.occurred_at > si.occurred_at
                   order by t.occurred_at limit 8) t) end as later`;

module.exports = { create };
