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
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const ledger = require('./index');
const R = require('./reconcileCore');

const log = logger('reconcile');

const MAX_FAILURES = 3;
const failures = new Map();

// The dirty set's SQL lives in src/repo/ledger.js (plan 1.2); kept on this module's exports.
const { DIRTY } = require('../repo/ledger.ts');

async function myForms() {
  const ids = await repo.people.myIdentities();
  return ['me', ...R.authorForms(ids)];
}

async function itemsById(ids, me) {
  const list = await repo.sources.itemsByIds(ids);
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
  return repo.ledger.reopenedByYou(ids);
}

// Evidence and, for an applied close, the transition — in one transaction.
async function write(v, decision) {
  return repo.withTx(async (r) => {
    const evId = await r.ledger.upsertEvidence({
      commitmentId: v.commitment.id, sourceItemId: v.item.id, effect: v.effect, quote: v.quote, confidence: v.confidence, extractedBy: R.VERSION,
    });
    if (decision !== 'apply') return { evidenceId: evId, applied: false };
    const t = await ledger.transition(
      {
        commitmentId: v.commitment.id,
        to: v.effect === 'moot' ? 'dropped' : 'done',
        actor: 'reconciler',
        reason: R.reasonFor(v),
        evidenceId: evId,
        from: ['open'],
      },
      r
    );
    if (t.changed) await r.ledger.markEvidenceApplied(evId);
    return { evidenceId: evId, applied: t.changed };
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
  const dirty = (await repo.ledger.dirty({ myForms: me, limit, perCommitment: 10, ids })).filter((d) => (failures.get(String(d.id)) || 0) < MAX_FAILURES);
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
      // The mark is taken from the items in SQL, never from `c.through`: that
      // comes back as a JS Date, which keeps milliseconds while fetched_at
      // keeps microseconds, so the truncated mark stayed older than the item
      // it was meant to cover. The commitment stayed dirty, sorted first as
      // "longest waiting", and the same batch was re-judged every minute.
      for (const c of batch.commitments) {
        failures.delete(String(c.id));
        await repo.ledger.markChecked(c.id, c.item_ids);
      }
    }
  }
  log.info('pass', { dirty: out.dirty, judged: out.judged, closed: out.closed, proposed: out.proposed, errors: out.errors, dryRun });
  return out;
}

/** Closes the judge was not sure enough to apply, newest per commitment, still open. */
async function proposals({ limit = 40 } = {}) {
  return repo.ledger.proposals({ limit, minConfidence: R.PROPOSE_CONFIDENCE });
}

/** Your answer to a "Looks done?" card. Accepting closes it as your own decision. */
async function decide(evidenceId, accept) {
  const e = await repo.ledger.evidenceById(evidenceId);
  if (!e) throw new Error(`no evidence #${evidenceId}`);
  if (e.decision) return { ok: false, result: `already ${e.decision}` };
  const out = await repo.withTx(async (r) => {
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
        r
      );
      changed = t.changed;
    }
    await r.ledger.decideEvidence(e.id, accept ? 'accepted' : 'rejected', changed);
    return { ok: true, result: accept ? (changed ? 'closed' : 'already closed') : 'kept open', commitmentId: Number(e.commitment_id) };
  });
  // The evidence may sit on a copy folded into a survivor (proposals() shows
  // it on the survivor): confirming closes the whole duplicate group.
  if (accept) {
    const to = e.effect === 'moot' ? 'dropped' : 'done';
    const also = await require('../commitments').closeGroup(Number(e.commitment_id), to, 'you confirmed it looks done');
    if (also.length) out.alsoClosed = also;
  }
  return out;
}

async function stats() {
  return repo.ledger.reconcileStats();
}

module.exports = { pass, proposals, decide, stats, DIRTY };
