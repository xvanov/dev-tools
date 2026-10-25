'use strict';

// Closing what I owe once I have answered it myself. A Teams or mail ask
// ("can you tell me whether…") becomes an owed_by_me commitment; when I reply
// in the same thread and the reply settles it, the commitment should not sit
// open until I tick it by hand. GitHub (ingest/githubReconcile.js) and meeting
// debriefs (meetings/debrief.js) already close things; this is the chat and
// mail half.
//
//   pass({now, limit, dryRun})   the worker's pass: judge what has a new reply
//   undo(commitmentId)           take back the last close this pass made
//   stats()                      counts for `pa doctor`
//
// One model call per commitment (replyCloseCore.SYSTEM) sees the ask and my
// later messages in that thread and returns a verdict with a verbatim quote,
// which is checked against the message it names before anything is written.
// A promise or a partial answer closes nothing. Every judgement is a
// `reply_close` row keyed by the newest reply it saw, so the same reply is
// never judged twice at one prompt version — which is also why a commitment
// reopened with `pa done --reopen` stays open until I write again.

const llm = require('../llm');
const { config } = require('../config');
const { rows, one, query, withTx } = require('../db');
const { logger } = require('../log');
const { myAuthorForms } = require('../draft');
const R = require('./replyCloseCore');
const ledger = require('../ledger');

const log = logger('reply-close');

const SOURCES = ['graph_chat', 'graph_mail'];
// A reply weeks after the ask is a new conversation, not an answer to it.
const WINDOW_DAYS = 14;
const MAX_ATTEMPTS = 3;

// Open owed_by_me asks from chat or mail with a reply of mine in the window
// that no judgement at this version has seen yet. $1 = my author forms,
// $2 = version, $3 = limit.
const CANDIDATES = `
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
         and mine.occurred_at <= si.occurred_at + interval '${WINDOW_DAYS} days'
         and lower(coalesce(mine.author_identity, '')) = any($1::text[])
       order by mine.occurred_at desc, mine.id desc limit 1) last
   where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
     and si.source = any('{${SOURCES.join(',')}}'::text[]) and si.thread_external_id is not null
     and not exists (
       select 1 from reply_close r
        where r.commitment_id = c.id and r.extracted_by = $2 and r.last_message_id = last.id
          and (r.error is null or r.attempts >= ${MAX_ATTEMPTS}))
   order by last.occurred_at desc
   limit $3`;

async function repliesFor(c, me) {
  const list = await rows(
    `select mine.id, mine.occurred_at, mine.body_text from source_item mine
      where mine.source = $2 and mine.thread_external_id = $3 and mine.id <> $4
        and mine.occurred_at > $5 and mine.occurred_at <= $5::timestamptz + interval '${WINDOW_DAYS} days'
        and lower(coalesce(mine.author_identity, '')) = any($1::text[])
      order by mine.occurred_at, mine.id limit ${R.MAX_REPLIES * 2}`,
    [me, c.source, c.thread_external_id, c.item_id, c.occurred_at]
  );
  return R.selectReplies(c, list);
}

async function judge(c, me) {
  const replies = await repliesFor(c, me);
  if (!replies.length) return { verdict: 'unrelated', close: false, reason: 'no replies with text' };
  const { prompt, refs } = R.buildPrompt(c, replies);
  const reply = await llm.complete({
    system: R.SYSTEM,
    prompt,
    model: config.replyClose.model,
    effort: config.replyClose.effort,
    maxTokens: 800,
    timeoutMs: 180_000,
    purpose: 'reply-close',
  });
  return R.parseVerdict(llm.extractJson(reply), refs);
}

async function record(client, c, j, applied = null) {
  await client.query(
    `insert into reply_close (commitment_id, extracted_by, last_message_id, verdict, quote, message_id, confidence, applied, attempts, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, null)
     on conflict (commitment_id, extracted_by, last_message_id) do update
        set verdict = excluded.verdict, quote = excluded.quote, message_id = excluded.message_id,
            confidence = excluded.confidence, applied = excluded.applied, error = null,
            attempts = reply_close.attempts + 1, judged_at = now()`,
    [c.id, R.VERSION, c.last_message_id, j.verdict, j.quote, j.message?.id ?? null, j.confidence ?? null, applied]
  );
}

async function recordError(c, err) {
  await query(
    `insert into reply_close (commitment_id, extracted_by, last_message_id, error, attempts)
     values ($1, $2, $3, $4, 1)
     on conflict (commitment_id, extracted_by, last_message_id) do update
        set error = excluded.error, attempts = reply_close.attempts + 1, judged_at = now()`,
    // The message is ours (a parse or spawn failure), never a body; clipped anyway.
    [c.id, R.VERSION, c.last_message_id, String(err.message || err).slice(0, 300)]
  );
}

// Closes it if it is still open as it was read; the commitment row is locked
// so a hand edit in between wins.
async function apply(c, j, now) {
  return withTx(async (client) => {
    const cur = (await client.query('select id, status, closed_at, closed_reason from commitment where id = $1 for update', [c.id])).rows[0];
    const plan = R.planClose(cur, j, { source: c.source, now });
    if (plan.set) {
      await ledger.transition(
        { commitmentId: c.id, to: plan.set.status, actor: 'reply-close', reason: plan.set.closed_reason, from: ['open'], now },
        client
      );
    }
    await record(client, c, j, plan.set ? { set: plan.set, before: plan.before } : null);
    return plan;
  });
}

/**
 * @param {object} [o]
 * @param {Date}    [o.now]
 * @param {number}  [o.limit]   commitments judged per pass
 * @param {boolean} [o.dryRun]  judge and report, write nothing (no markers either)
 */
async function pass({ now = new Date(), limit = 8, dryRun = false } = {}) {
  const me = await myAuthorForms();
  const candidates = await rows(CANDIDATES, [me, R.VERSION, limit]);
  const out = { judged: 0, closed: 0, errors: 0, results: [] };
  for (const c of candidates) {
    try {
      const j = await judge(c, me);
      out.judged++;
      const result = { commitmentId: Number(c.id), verdict: j.verdict, close: j.close, quote: j.quote, messageId: j.message ? Number(j.message.id) : null, reason: j.reason };
      if (dryRun) {
        result.wouldClose = !!R.planClose(c, j, { source: c.source, now }).set;
      } else {
        const plan = await apply(c, j, now);
        result.closed = !!plan.set;
        if (plan.set) {
          out.closed++;
          log.info('closed by reply', { commitment: Number(c.id), message: result.messageId });
        }
      }
      out.results.push(result);
    } catch (err) {
      out.errors++;
      log.warn('judgement failed', { commitment: Number(c.id), message: String(err.message).slice(0, 120) });
      if (!dryRun) await recordError(c, err).catch(() => {});
    }
  }
  if (candidates.length) log.info('pass', { candidates: candidates.length, judged: out.judged, closed: out.closed, errors: out.errors, dryRun });
  return out;
}

/**
 * Takes back the newest close this pass made on a commitment: puts back the
 * columns it overwrote, unless someone has changed them since (then it is
 * left alone, and says so). The judgement row stays, so the same reply does
 * not close it again.
 */
async function undo(commitmentId) {
  const row = await one(
    `select * from reply_close where commitment_id = $1 and applied is not null and undone_at is null
      order by judged_at desc limit 1`,
    [commitmentId]
  );
  if (!row) return { ok: false, result: `no reply-close to undo on #${commitmentId}` };
  // Closes made since the ledger existed are undone through it; older ones
  // only have the columns this table kept.
  const t = await one(
    `select id from ledger_transition where commitment_id = $1 and actor = 'reply-close' and undone_at is null
      order by at desc, id desc limit 1`,
    [commitmentId]
  );
  if (t) {
    const u = await ledger.undo(Number(t.id));
    await query('update reply_close set undone_at = now(), undo = $2 where id = $1', [row.id, u.result]);
    return { ok: true, result: u.result };
  }
  let result = 'undone';
  await withTx(async (client) => {
    const cur = (await client.query('select id, status, closed_at, closed_reason from commitment where id = $1 for update', [commitmentId])).rows[0];
    const { set, before } = row.applied;
    if (!cur) result = 'the commitment is gone';
    else if (R.changedSince(cur, set)) result = 'changed since it was closed; left as it is';
    else {
      await client.query('update commitment set status = $2, closed_at = $3, closed_reason = $4 where id = $1', [
        commitmentId,
        before.status,
        before.closed_at,
        before.closed_reason,
      ]);
    }
    await client.query('update reply_close set undone_at = now(), undo = $2 where id = $1', [row.id, result]);
  });
  log.info('reply-close undone', { commitment: Number(commitmentId), result });
  return { ok: true, result };
}

async function stats() {
  // "Closed" means still closed as this pass left it: one reopened by hand
  // since does not count.
  return one(
    `select count(*) filter (where r.applied is not null and r.undone_at is null
                              and c.closed_reason = r.applied->'set'->>'closed_reason')::int as closed,
            count(*) filter (where r.error is null)::int as judged,
            count(*) filter (where r.error is not null and r.attempts >= ${MAX_ATTEMPTS})::int as failed,
            max(r.judged_at) as last
       from reply_close r left join commitment c on c.id = r.commitment_id`
  );
}

module.exports = { pass, undo, stats, CANDIDATES };
