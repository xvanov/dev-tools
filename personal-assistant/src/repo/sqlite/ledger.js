'use strict';

// SQLite twin of src/repo/ledger.js (ledger_transition, ledger_evidence, and
// the commitment's status columns). The reconciler's dirty set uses a window
// function where Postgres uses a lateral join; the repo-folder match on
// another machine's cwd compares path segments with LIKE instead of arrays.

const { STATUS_COLUMNS, WINDOW_DAYS } = require('../ledger');
const { NOW, sinceMs } = require('./_sql');

const SESSION_SETTLE_MINUTES = 10;

/** Text instants an expression column returned (no declared type to decode by) as Dates. */
function dates(row, ...cols) {
  if (row) for (const c of cols) if (typeof row[c] === 'string') row[c] = new Date(row[c]);
  return row;
}

// Author forms of a person's identities, for `person_id = <expr>` (as Postgres).
const FORMS_OF = (personExpr) => `(select case pi.kind when 'smtp' then lower(pi.value)
                       when 'aad_oid' then 'aad:' || lower(pi.value)
                       when 'github_username' then 'github:' || lower(pi.value) end
         from person_identity pi where pi.person_id = ${personExpr})`;

// A path with backslashes as slashes, lower-cased; and its last segment.
const SLASHED = (x) => `lower(replace(${x}, char(92), '/'))`;
const BASENAME = (x) => `substr(${SLASHED(x)}, length(rtrim(${SLASHED(x)}, replace(${SLASHED(x)}, '/', ''))) + 1)`;

// $1 = my author forms, $2 = max commitments, $3 = max items per commitment,
// $4 = only these commitment ids (null: all), $5 = sessions settled before,
// $6 = "fresh" evidence after. See src/repo/ledger.js DIRTY for the why of each rule.
const DIRTY = `
  with o as (
    select c.id, c.direction, c.summary, c.detail, c.counterparty_person_id, c.ledger_checked_at,
           si.id as item_id, si.source, si.thread_external_id, si.occurred_at as asked_at,
           si.body_text as ask_text, per.display_name as counterparty,
           pr.gitlab_path, pr.repo_path, ${BASENAME('pr.repo_path')} as repo_base
      from commitment c
      join source_item si on si.id = c.source_item_id
      left join person per on per.id = c.counterparty_person_id
      left join project pr on pr.id = c.project_id and pr.active
     where c.status = 'open' and c.superseded_by is null
       and ($4 is null or c.id in (select value from json_each($4)))
  ),
  cand as (
    select o.id as cid, r.id, r.fetched_at,
           row_number() over (
             partition by o.id
             order by (o.thread_external_id is not null and r.source = o.source and r.thread_external_id = o.thread_external_id) desc, r.fetched_at
           ) as n
      from o join source_item r
        on (r.id <> o.item_id or r.raw->>'repaired' is not null)
       and (r.occurred_at > o.asked_at or r.id = o.item_id)
       and r.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', o.asked_at, '+${WINDOW_DAYS} days')
       and r.fetched_at > coalesce(o.ledger_checked_at, '')
       and r.source <> 'graph_event'
       and (r.source <> 'claude_session' or r.fetched_at < $5)
       and length(r.body_text) >= 8
       and (
         r.id = o.item_id
         or (o.thread_external_id is not null and r.source = o.source and r.thread_external_id = o.thread_external_id)
         or (o.direction = 'owed_to_me' and o.counterparty_person_id is not null
             and lower(coalesce(r.author_identity, '')) in ${FORMS_OF('o.counterparty_person_id')}
             and (r.source in ('graph_chat', 'graph_mail')
                  or (o.gitlab_path is not null and r.source like 'github%' and lower(r.raw->>'project') = lower(o.gitlab_path))))
         or (lower(coalesce(r.author_identity, '')) in (select value from json_each($1)) and (
               (o.gitlab_path is not null and r.source like 'github%' and lower(r.raw->>'project') = lower(o.gitlab_path))
               or (o.repo_path is not null and r.source = 'claude_session'
                   and (lower(r.raw->>'cwd') like lower(o.repo_path) || '%'
                        or (r.raw->>'machine' is not null and o.repo_base <> ''
                            and '/' || ${SLASHED("r.raw->>'cwd'")} || '/' like '%/' || o.repo_base || '/%')))))
       )
  )
  select o.id, o.direction, o.summary, o.detail, o.counterparty, o.asked_at, o.ask_text, o.source,
         json_group_array(cand.id order by cand.fetched_at) as item_ids, max(cand.fetched_at) as through
    from o join cand on cand.cid = o.id and cand.n <= $3
   group by o.id
   order by (max(cand.fetched_at) > $6) desc,
            coalesce(o.ledger_checked_at, ''),
            max(cand.fetched_at) desc
   limit $2`;

function setClause(cols) {
  for (const k of cols) if (!STATUS_COLUMNS.includes(k)) throw new Error(`a transition does not write commitment.${k}`);
  return cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
}

function create(db) {
  return {
    /** A commitment's status columns (inside withTx the transaction holds the write lock), or null. */
    async lockCommitment(commitmentId) {
      return db.one('select id, status, closed_at, closed_reason, touched_at from commitment where id = $1', [commitmentId]);
    },

    /** Writes a commitment's status columns (`set`: STATUS_COLUMNS only). */
    async setCommitment(commitmentId, set) {
      const cols = Object.keys(set);
      await db.query(`update commitment set ${setClause(cols)} where id = $1`, [commitmentId, ...cols.map((k) => set[k])]);
    },

    /** Records one change. Resolves the transition id. */
    async insertTransition({ commitmentId, from, to, actor, reason, evidenceId, before, at }) {
      const t = await db.one(
        `insert into ledger_transition (commitment_id, from_status, to_status, actor, reason, evidence_id, before, at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [commitmentId, from, to, actor, reason, evidenceId, before, at]
      );
      return Number(t.id);
    },

    /** One transition (inside withTx), or null. */
    async lockTransition(transitionId) {
      return db.one('select * from ledger_transition where id = $1', [transitionId]);
    },

    /** Marks a transition undone, with what the undo did (`result`). */
    async markUndone(transitionId, result) {
      await db.query(`update ledger_transition set undone_at = ${NOW}, undo = $2 where id = $1`, [transitionId, result]);
    },

    /** The newest change of a commitment that is not undone, or null. */
    async latest(commitmentId) {
      const list = await db.rows(
        'select * from ledger_transition where commitment_id = $1 and undone_at is null order by at desc, id desc limit 1',
        [commitmentId]
      );
      return list[0] || null;
    },

    /** Every change of a commitment, newest first, with its evidence's quote, item and confidence. */
    async history(commitmentId) {
      return db.rows(
        `select t.*, e.quote, e.source_item_id, e.confidence
       from ledger_transition t left join ledger_evidence e on e.id = t.evidence_id
      where t.commitment_id = $1 order by t.at desc, t.id desc`,
        [commitmentId]
      );
    },

    /** The reconciler's "progresses" quotes for commitments, newest first. */
    async progressQuotes(commitmentIds) {
      return db.rows(
        `select commitment_id, quote from ledger_evidence
        where commitment_id in (select value from json_each($1)) and effect = 'progresses' and quote is not null
        order by created_at desc, id desc`,
        [(commitmentIds || []).map(Number)]
      );
    },

    /** Open asks with items the judge has not seen (see src/repo/ledger.js). */
    async dirty({ myForms, limit, perCommitment, ids = null }) {
      const rows = await db.rows(DIRTY, [
        myForms || [],
        limit,
        perCommitment,
        ids && ids.length ? ids.map(Number) : null,
        sinceMs(SESSION_SETTLE_MINUTES * 60_000),
        sinceMs(15 * 60_000),
      ]);
      for (const r of rows) {
        r.item_ids = JSON.parse(r.item_ids);
        dates(r, 'through', 'asked_at');
      }
      return rows;
    },

    /** Which of these commitments you reopened yourself (and did not undo): their ids, as strings. */
    async reopenedByYou(ids) {
      const list = await db.rows(
        `select distinct commitment_id from ledger_transition
      where commitment_id in (select value from json_each($1)) and actor = 'you' and to_status = 'open' and undone_at is null`,
        [(ids || []).map(Number)]
      );
      return new Set(list.map((r) => String(r.commitment_id)));
    },

    /** The judge's evidence for one (commitment, item, judge version): inserted or updated in place. Resolves its id. */
    async upsertEvidence({ commitmentId, sourceItemId, effect, quote, confidence, extractedBy }) {
      const ev = await db.one(
        `insert into ledger_evidence (commitment_id, source_item_id, effect, quote, confidence, method, extracted_by, applied)
         values ($1,$2,$3,$4,$5,'llm',$6,0)
         on conflict (commitment_id, source_item_id, extracted_by) do update
            set effect = excluded.effect, quote = excluded.quote, confidence = excluded.confidence, created_at = ${NOW}
         returning id`,
        [commitmentId, sourceItemId, effect, quote, confidence, extractedBy]
      );
      return Number(ev.id);
    },

    /** Marks evidence as applied (its close went through). */
    async markEvidenceApplied(evidenceId) {
      await db.query('update ledger_evidence set applied = 1 where id = $1', [evidenceId]);
    },

    /** The judge saw these items: ledger_checked_at moves to the newest of their fetched_at, never backwards. */
    async markChecked(commitmentId, itemIds) {
      await db.query(
        `update commitment set ledger_checked_at = max(coalesce(ledger_checked_at, t.through), t.through)
             from (select max(fetched_at) as through from source_item where id in (select value from json_each($2))) t
            where commitment.id = $1 and t.through is not null`,
        [commitmentId, (itemIds || []).map(Number)]
      );
    },

    /** Closes the judge proposed, newest per open commitment, shown on the survivor of a duplicate group. */
    async proposals({ limit, minConfidence }) {
      return db.rows(
        `select id, commitment_id, effect, quote, confidence, created_at, summary, direction, source, author_identity, url
       from (
         select e.id, c.id as commitment_id, e.effect, e.quote, e.confidence, e.created_at,
                c.summary, c.direction, si.source, si.author_identity, coalesce(si.raw->>'webUrl', si.raw->>'url') as url,
                row_number() over (partition by c.id order by e.created_at desc, e.id desc) as n
           from ledger_evidence e
           join commitment o on o.id = e.commitment_id
           join commitment c on c.id = coalesce(o.superseded_by, o.id) and c.status = 'open' and c.superseded_by is null
           left join source_item si on si.id = e.source_item_id
          where e.effect in ('closes','moot') and not e.applied and e.decision is null and e.confidence >= $2)
      where n = 1
      order by commitment_id
      limit $1`,
        [limit, minConfidence]
      );
    },

    /** One evidence row, or null. */
    async evidenceById(evidenceId) {
      return db.one('select * from ledger_evidence where id = $1', [evidenceId]);
    },

    /** Your answer to a proposal: `decision` accepted | rejected, and whether its close applied. */
    async decideEvidence(evidenceId, decision, applied) {
      await db.query(`update ledger_evidence set decision = $2, decided_at = ${NOW}, applied = $3 where id = $1`, [evidenceId, decision, Boolean(applied)]);
    },

    /** The reconciler's record: {closed, reopened (by you after it closed), proposed, last (newest evidence)}. */
    async reconcileStats() {
      return dates(
        await db.one(
          `select (select count(*) from ledger_transition where actor = 'reconciler' and undone_at is null) as closed,
            (select count(*) from ledger_transition t where actor = 'reconciler'
               and exists (select 1 from ledger_transition u where u.commitment_id = t.commitment_id
                            and u.actor = 'you' and u.to_status = 'open' and u.at > t.at)) as reopened,
            (select count(*) from ledger_evidence where effect in ('closes','moot') and not applied and decision is null) as proposed,
            (select max(created_at) from ledger_evidence) as last`
        ),
        'last'
      );
    },

    /** Pending (unapplied, undecided) evidence that a commitment is done or moot, newest first, at most two. */
    async pendingEvidenceFor(commitmentId) {
      return db.rows(
        `select effect, quote, confidence from ledger_evidence
      where commitment_id = $1 and effect in ('closes','moot') and not applied and decision is null
      order by created_at desc, id desc limit 2`,
        [commitmentId]
      );
    },

    /** The id of the newest not yet undone transition the reply-close pass made on a commitment. */
    async latestReplyCloseTransition(commitmentId) {
      return db.one(
        `select id from ledger_transition where commitment_id = $1 and actor = 'reply-close' and undone_at is null
      order by at desc, id desc limit 1`,
        [commitmentId]
      );
    },
  };
}

module.exports = { create, STATUS_COLUMNS, DIRTY, WINDOW_DAYS };
