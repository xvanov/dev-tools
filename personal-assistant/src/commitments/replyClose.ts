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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const llm = require('../llm.ts');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const { myAuthorForms } = require('../draft');
const R = require('./replyCloseCore.ts');
const ledger = require('../ledger');

const log = logger('reply-close');

const SOURCES = ['graph_chat', 'graph_mail'];
// A reply weeks after the ask is a new conversation, not an answer to it.
const WINDOW_DAYS = 14;
const MAX_ATTEMPTS = 3;

// Candidates (repo.commitments.replyCloseCandidates): open owed_by_me asks
// from chat or mail with a reply of mine in the window that no judgement at
// this version has seen yet.

async function repliesFor(c: any, me: any) {
  const list = await repo.commitments.replyCloseReplies(me, c.source, c.thread_external_id, c.item_id, c.occurred_at, {
    windowDays: WINDOW_DAYS,
    limit: R.MAX_REPLIES * 2,
  });
  return R.selectReplies(c, list);
}

async function judge(c: any, me: any) {
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

async function recordError(c: any, err: any) {
  // The message is ours (a parse or spawn failure), never a body; clipped anyway.
  await repo.commitments.recordReplyCloseError(c, R.VERSION, String(err.message || err).slice(0, 300));
}

// Closes it if it is still open as it was read; the commitment row is locked
// so a hand edit in between wins.
async function apply(c: any, j: any, now: any) {
  return repo.withTx(async (r: any) => {
    const cur = await r.commitments.lockStatus(c.id);
    const plan = R.planClose(cur, j, { source: c.source, now });
    if (plan.set) {
      await ledger.transition(
        { commitmentId: c.id, to: plan.set.status, actor: 'reply-close', reason: plan.set.closed_reason, from: ['open'], now },
        r
      );
    }
    await r.commitments.recordReplyClose(c, R.VERSION, j, plan.set ? { set: plan.set, before: plan.before } : null);
    return plan;
  });
}

/**
 * @param {object} [o]
 * @param {Date}    [o.now]
 * @param {number}  [o.limit]   commitments judged per pass
 * @param {boolean} [o.dryRun]  judge and report, write nothing (no markers either)
 */
async function pass({ now = new Date(), limit = 8, dryRun = false }: { now?: any; limit?: number; dryRun?: boolean } = {}) {
  const me = await myAuthorForms();
  const candidates = await repo.commitments.replyCloseCandidates(me, R.VERSION, limit, {
    windowDays: WINDOW_DAYS,
    sources: SOURCES,
    maxAttempts: MAX_ATTEMPTS,
  });
  const out = { judged: 0, closed: 0, errors: 0, results: [] as any[] };
  for (const c of candidates) {
    try {
      const j = await judge(c, me);
      out.judged++;
      const result: any = { commitmentId: Number(c.id), verdict: j.verdict, close: j.close, quote: j.quote, messageId: j.message ? Number(j.message.id) : null, reason: j.reason };
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
    } catch (err: any) {
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
async function undo(commitmentId: any) {
  const row = await repo.commitments.latestAppliedReplyClose(commitmentId);
  if (!row) return { ok: false, result: `no reply-close to undo on #${commitmentId}` };
  // Closes made since the ledger existed are undone through it; older ones
  // only have the columns this table kept.
  const t = await repo.ledger.latestReplyCloseTransition(commitmentId);
  if (t) {
    const u = await ledger.undo(Number(t.id));
    await repo.commitments.markReplyCloseUndone(row.id, u.result);
    return { ok: true, result: u.result };
  }
  let result = 'undone';
  await repo.withTx(async (r: any) => {
    const cur = await r.commitments.lockStatus(commitmentId);
    const { set, before } = row.applied;
    if (!cur) result = 'the commitment is gone';
    else if (R.changedSince(cur, set)) result = 'changed since it was closed; left as it is';
    else await r.commitments.restoreClosedState(commitmentId, before.status, before.closed_at, before.closed_reason);
    await r.commitments.markReplyCloseUndone(row.id, result);
  });
  log.info('reply-close undone', { commitment: Number(commitmentId), result });
  return { ok: true, result };
}

async function stats() {
  // "Closed" means still closed as this pass left it: one reopened by hand
  // since does not count.
  return repo.commitments.replyCloseStats(MAX_ATTEMPTS);
}

module.exports = { pass, undo, stats };
