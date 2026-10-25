'use strict';

// The reconciler: keeps open commitments true as new evidence arrives
// (DURABLE.md §2.2).
//
//   pass({limit, dryRun})        judge every open commitment that has newer related items
//   proposals()                  "Looks done?" cards waiting for you
//   decide(evidenceId, accept)   accept or reject one
//   stats()                      counts for `pa doctor`
//
// Level-triggered, not edge-triggered. The closers before it each waited for
// one narrow event (my reply in the same thread, a PR linked by URL) and an
// item that missed its event stayed open for good — a colleague's "Just added
// your role" four minutes after the promise closed nothing, because nothing
// closed an owed-to-me item at all. Here "work to do" is a query: open
// commitments with related items fetched since they were last judged.
// Related means, after the ask and within 30 days:
//   - the same thread (chat, mail, PR — for a Claude session, the same repo);
//   - for something owed to me, anything the other person wrote, anywhere;
//   - for anything in a known project, my own PRs, notifications and coding
//     sessions in that repo — on this machine or another (src/ingest/remoteSessions.js).
// Commitments that share newer items are judged together in one call
// (reconcileCore.batches). Nothing related arrived: no model call at all, so
// the pass can run every minute.
//
// The judge writes evidence, never status: a close is applied through the
// ledger (src/ledger) when the judge is sure and you have not taken back a
// close on that commitment before; otherwise it is a proposal. Either way the
// quote is checked verbatim against the item it names first.

const llm = require('../llm');
const { config } = require('../config');
const { rows, one, query, withTx } = require('../db');
const { logger } = require('../log');
const ledger = require('./index');
const R = require('./reconcileCore');

const log = logger('reconcile');

const WINDOW_DAYS = 30;
const SESSION_SETTLE_MINUTES = 10;
const MAX_FAILURES = 3;
const failures = new Map();

// Author forms of a person's identities, in SQL, for `person_id = <expr>`.
const FORMS_OF = (personExpr) => `(select case pi.kind when 'smtp' then lower(pi.value)
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

async function myForms() {
  const ids = await rows(`select pi.kind, pi.value from person_identity pi join person p on p.id = pi.person_id where p.is_me`);
  return ['me', ...R.authorForms(ids)];
}

async function itemsById(ids, me) {
  const list = await rows(
    `select id, source, author_identity, occurred_at, subject, body_text, raw from source_item where id = any($1::bigint[])`,
    [ids]
  );
  const mine = new Set(me);
  return new Map(
    list.map((r) => [
      String(r.id),
      { ...r, author: r.author_identity, mine: mine.has(String(r.author_identity || '').toLowerCase()) },
    ])
  );
}

async function judge(batch) {
  const { prompt, cRefs, eRefs } = R.buildPrompt(batch.commitments, batch.items);
  const reply = await llm.complete({
    system: R.SYSTEM,
    prompt,
    model: config.reconcile.model,
    effort: config.reconcile.effort,
    maxTokens: 1500,
    timeoutMs: 240_000,
    purpose: 'reconcile',
  });
  return R.parseVerdicts(llm.extractJson(reply), cRefs, eRefs);
}

async function reopenedByYou(ids) {
  const list = await rows(
    `select distinct commitment_id from ledger_transition
      where commitment_id = any($1::bigint[]) and actor = 'you' and to_status = 'open' and undone_at is null`,
    [ids]
  );
  return new Set(list.map((r) => String(r.commitment_id)));
}

// Evidence and, for an applied close, the transition — in one transaction.
async function write(v, decision) {
  return withTx(async (client) => {
    const ev = (
      await client.query(
        `insert into ledger_evidence (commitment_id, source_item_id, effect, quote, confidence, method, extracted_by, applied)
         values ($1,$2,$3,$4,$5,'llm',$6,false)
         on conflict (commitment_id, source_item_id, extracted_by) do update
            set effect = excluded.effect, quote = excluded.quote, confidence = excluded.confidence, created_at = now()
         returning id`,
        [v.commitment.id, v.item.id, v.effect, v.quote, v.confidence, R.VERSION]
      )
    ).rows[0];
    if (decision !== 'apply') return { evidenceId: Number(ev.id), applied: false };
    const t = await ledger.transition(
      {
        commitmentId: v.commitment.id,
        to: v.effect === 'moot' ? 'dropped' : 'done',
        actor: 'reconciler',
        reason: R.reasonFor(v),
        evidenceId: ev.id,
        from: ['open'],
      },
      client
    );
    if (t.changed) await client.query('update ledger_evidence set applied = true where id = $1', [ev.id]);
    return { evidenceId: Number(ev.id), applied: t.changed };
  });
}

/**
 * @param {object} [o]
 * @param {number}  [o.limit]   commitments judged per pass
 * @param {boolean} [o.dryRun]  judge and report; write nothing, not even the checked mark
 * @param {number[]} [o.ids]   only these commitments
 */
async function pass({ limit = 24, dryRun = false, ids = null } = {}) {
  const me = await myForms();
  const dirty = (await rows(DIRTY, [me, limit, 10, ids && ids.length ? ids : null])).filter((d) => (failures.get(String(d.id)) || 0) < MAX_FAILURES);
  const out = { dirty: dirty.length, judged: 0, closed: 0, proposed: 0, progressed: 0, errors: 0, results: [] };
  if (!dirty.length) return out;

  const items = await itemsById([...new Set(dirty.flatMap((d) => d.item_ids.map(String)))], me);
  const withItems = dirty.map((d) => ({ ...d, items: d.item_ids.map((id) => items.get(String(id))).filter(Boolean) }));
  const reopened = await reopenedByYou(dirty.map((d) => d.id));

  for (const batch of R.batches(withItems)) {
    let verdicts;
    try {
      verdicts = await judge(batch);
    } catch (err) {
      out.errors++;
      for (const c of batch.commitments) failures.set(String(c.id), (failures.get(String(c.id)) || 0) + 1);
      log.warn('judgement failed', { commitments: batch.commitments.map((c) => Number(c.id)), message: String(err.message).slice(0, 160) });
      continue;
    }
    out.judged += batch.commitments.length;
    for (const v of verdicts) {
      let decision = R.decide(v, { reopenedByYou: reopened.has(String(v.commitment.id)) });
      if (decision === 'apply' && !config.reconcile.auto) decision = 'propose';
      const result = {
        commitmentId: Number(v.commitment.id),
        summary: v.commitment.summary,
        effect: v.effect,
        decision,
        confidence: v.confidence,
        quote: v.quote,
        itemId: v.item ? Number(v.item.id) : null,
        reason: v.reason,
      };
      if (decision !== 'skip' && !dryRun) {
        const w = await write(v, decision);
        result.applied = w.applied;
        if (w.applied) {
          out.closed++;
          log.info('closed on evidence', { commitment: result.commitmentId, item: result.itemId, effect: v.effect });
        }
      }
      if (decision === 'propose') out.proposed++;
      if (decision === 'record' && v.effect === 'progresses') out.progressed++;
      out.results.push(result);
    }
    if (!dryRun) {
      // Judged through the newest item it saw: anything fetched later is new.
      for (const c of batch.commitments) {
        failures.delete(String(c.id));
        await query('update commitment set ledger_checked_at = greatest(coalesce(ledger_checked_at, $2), $2) where id = $1', [c.id, c.through]);
      }
    }
  }
  log.info('pass', { dirty: out.dirty, judged: out.judged, closed: out.closed, proposed: out.proposed, errors: out.errors, dryRun });
  return out;
}

/** Closes the judge was not sure enough to apply, newest per commitment, still open. */
async function proposals({ limit = 40 } = {}) {
  return rows(
    `select distinct on (e.commitment_id) e.id, e.commitment_id, e.effect, e.quote, e.confidence, e.created_at,
            c.summary, c.direction, si.source, si.author_identity, coalesce(si.raw->>'webUrl', si.raw->>'url') as url
       from ledger_evidence e
       join commitment c on c.id = e.commitment_id and c.status = 'open'
       left join source_item si on si.id = e.source_item_id
      where e.effect in ('closes','moot') and not e.applied and e.decision is null and e.confidence >= $2
      order by e.commitment_id, e.created_at desc
      limit $1`,
    [limit, R.PROPOSE_CONFIDENCE]
  );
}

/** Your answer to a "Looks done?" card. Accepting closes it as your own decision. */
async function decide(evidenceId, accept) {
  const e = await one('select * from ledger_evidence where id = $1', [evidenceId]);
  if (!e) throw new Error(`no evidence #${evidenceId}`);
  if (e.decision) return { ok: false, result: `already ${e.decision}` };
  return withTx(async (client) => {
    let changed = false;
    if (accept) {
      const t = await ledger.transition(
        {
          commitmentId: e.commitment_id,
          to: e.effect === 'moot' ? 'dropped' : 'done',
          actor: 'you',
          reason: `you confirmed: "${R.clip(e.quote, 160)}"`,
          evidenceId: e.id,
        },
        client
      );
      changed = t.changed;
    }
    await client.query('update ledger_evidence set decision = $2, decided_at = now(), applied = $3 where id = $1', [
      e.id,
      accept ? 'accepted' : 'rejected',
      changed,
    ]);
    return { ok: true, result: accept ? (changed ? 'closed' : 'already closed') : 'kept open', commitmentId: Number(e.commitment_id) };
  });
}

async function stats() {
  return one(
    `select (select count(*) from ledger_transition where actor = 'reconciler' and undone_at is null)::int as closed,
            (select count(*) from ledger_transition t where actor = 'reconciler'
               and exists (select 1 from ledger_transition u where u.commitment_id = t.commitment_id
                            and u.actor = 'you' and u.to_status = 'open' and u.at > t.at))::int as reopened,
            (select count(*) from ledger_evidence where effect in ('closes','moot') and not applied and decision is null)::int as proposed,
            (select max(created_at) from ledger_evidence) as last`
  );
}

module.exports = { pass, proposals, decide, stats, DIRTY };
