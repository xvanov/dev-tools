'use strict';

// The assistant's questions and prepared actions, waiting for me (sql/020).
//
//   create({kind, title, ...})        idempotent by dedupeKey
//   pending()                         what the dashboard draws on its asks (On me; board.js)
//   decide(id, {accept, answer})      my answer; runs or wakes what waits on it
//   expire()                          proposals past their expiry
//
// Two ways a proposal is acted on. A durable task that is waiting on it (a
// finished run waiting to be landed, src/durable/tasks) gets the absurd event
// `proposal:<id>` and does the work itself, as a checkpointed step. Anything
// else runs the typed handler for its kind below. There is no handler that
// takes a command or free text to run: a new kind of action is a new entry in
// HANDLERS, reviewed like any other code (AGENT.md, routines).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const repo = require('../repo');
const { logger } = require('../log.ts');

const log = logger('proposals');

const KINDS = ['land', 'dispatch', 'question'];

async function create({ kind, title, body = '', commitmentId = null, runId = null, options = null, payload = {}, dedupeKey = null, expiresAt = null }: { kind?: string | null; title?: string | null; body?: string; commitmentId?: any | null; runId?: any | null; options?: any; payload?: any; dedupeKey?: any; expiresAt?: any }) {
  if (!(KINDS as any[]).includes(kind)) throw new Error(`unknown proposal kind "${kind}"`);
  const row = await repo.proposals.insert({
    kind, commitmentId, runId, title: String(title).slice(0, 300), body: String(body).slice(0, 8000), options, payload, dedupeKey, expiresAt,
  });
  if (row) log.info('proposed', { id: Number(row.id), kind, commitment: commitmentId, run: runId });
  return row;
}

async function pending({ limit = 40 }: { limit?: number } = {}) {
  return repo.proposals.pending({ limit });
}

// Typed actions for proposals no task is waiting on. Each gets the proposal
// and my answer and returns a short result line.
const HANDLERS = {
  // Start a run on an ask. A frozen offer (src/dispatch/offer.ts) runs
  // exactly what its card showed — route, app, done-criteria, brief,
  // pipeline, models — at the delivery level shown, or the one I picked on the
  // card when accepting. An older proposal without frozen values is a run in
  // the mode and on the route it named (a Claude session if none).
  async dispatch(p: any, answer: string, { delivery: picked = null }: { delivery?: string | null } = {}) {
    const pl = p.payload || {};
    if (pl.repoPath && !pl.repoVerifiedAt) {
      // A card made before `--repo` had to be a known project: checked now, with the way out.
      await require('../dispatch').knownRepo(pl.repoPath).catch(() => {
        throw new Error(`this card's repo ${pl.repoPath} is not a known project — decline it and offer it again (pa propose …), or add the checkout with \`pa projects sync\``);
      });
    }
    if (pl.frozen) {
      const D = require('../dispatch/deliveryCore.ts');
      const delivery = picked ? D.delivery(picked) : pl.delivery || null;
      const changed = Boolean(picked) && delivery !== pl.delivery;
      if (pl.via === 'factory' && !delivery) throw new Error('a factory offer without a delivery level — decline it and offer it again');
      const run = await require('../dispatch').start({
        commitmentId: p.commitment_id,
        task: pl.task || null,
        repoPath: pl.repoPath || null,
        // Every start is a factory job (D28). A card made for a Claude session
        // (before D28) runs as a code job in its mode; plan stays a plan job.
        mode: (changed ? undefined : pl.mode) || undefined,
        delivery: delivery || undefined,
        deliverySource: changed ? 'explicit' : pl.deliverySource || null,
        deliveryPhrase: changed ? null : pl.deliveryPhrase || null,
        app: pl.app || null,
        register: pl.via === 'factory' ? Boolean(pl.register) : true,
        done: Array.isArray(pl.done) ? pl.done : [],
        pipeline: pl.pipeline || null,
        models: pl.models || null,
        brief: pl.via === 'factory' ? require('../dispatch/offer.ts').briefAt(pl, delivery) : null,
        briefBy: pl.briefBy || null,
        frozen: true,
        // Accepting the card IS the operator's confirmation of its end state
        // (the CLI refuses to accept an unattended one without a terminal).
        confirmedUnattended: true,
        repoVerified: true, // checked when the card was made, or just above
        routeReason: pl.routeReason ? `proposal: ${pl.routeReason}` : null,
        // JOBS-API v1.2: what kind of work, and who does it (older cards: code, the default runtime).
        jobKind: pl.via === 'factory' ? pl.jobKind || null : null,
        runtime: pl.via === 'factory' ? pl.runtime || null : null,
        title: pl.title || null,
      });
      return describeStart(run);
    }
    const run = await require('../dispatch').start({
      commitmentId: p.commitment_id,
      mode: pl.mode || undefined,
      repoPath: pl.repoPath || null,
      repoVerified: true,
      routeReason: pl.routeReason ? `proposal: ${pl.routeReason}` : null,
    });
    return describeStart(run);
  },
  // A question: what the answer means is named by `payload.on`.
  async question(p: any, answer: string) {
    if (p.payload?.on === 'project' && p.commitment_id) {
      if (answer === 'none') return 'left without a repo';
      await require('../projects').correct(p.commitment_id, answer, { rationale: 'you picked it when the assistant asked' });
      // Planned again with the repo it now has.
      await repo.commitments.replan(p.commitment_id);
      return `#${p.commitment_id} is in ${answer}`;
    }
    return 'noted';
  },
};

function describeStart(run: any) {
  if (run.route === 'factory') {
    if (run.submitUnknown) return `run #${run.id} sent to the factory; its answer was lost — the worker matches it to its job (pa review ${run.id})`;
    return `run #${run.id} sent to the factory (job ${run.jobId}, ${run.jobKind && run.jobKind !== 'code' ? `${run.jobKind}` : run.delivery})`;
  }
  return `run #${run.id} started (${run.mode}${run.delivery ? ` → ${run.delivery}` : ''})`;
}

/**
 * @param {number} id
 * @param {{accept: boolean, answer?: string, delivery?: string}} o
 *   `delivery`: on a dispatch card, the end state picked when accepting —
 *   the card's own level when absent.
 */
async function decide(id: any, { accept, answer = null, delivery = null }: { accept?: boolean; answer?: string | null; delivery?: string | null }) {
  if (delivery) delivery = require('../dispatch/deliveryCore.ts').delivery(delivery);
  // "When should I follow up?" takes a fixed answer or a typed time ("2h",
  // "fri 3pm", a date — src/util/when.ts), stored canonical so the chase does
  // exactly what was previewed. One it cannot read is refused, not guessed.
  if (accept && answer) {
    const q = await repo.proposals.payloadOf(id);
    if (q?.payload?.on === 'cadence') {
      const canonical = require('../durable/tasks/chaseCore.ts').cadenceAnswer(answer);
      if (!canonical) {
        throw Object.assign(new Error(`"${String(answer).slice(0, 40)}" is not a time I can read — try 5m, 2h, 2d, tomorrow 3pm, mon, or 2026-11-10 14:00`), { status: 400 });
      }
      answer = canonical;
    }
  }
  const recorded = answer || (accept && delivery ? `delivery=${delivery}` : null);
  const p = await repo.proposals.decide(id, accept ? 'accepted' : 'rejected', recorded);
  if (!p) {
    const cur = await repo.proposals.statusOf(id);
    return { ok: false, result: cur ? `already ${cur.status}` : `no proposal #${id}` };
  }
  let result = accept ? 'accepted' : 'declined';
  if (p.payload?.task) {
    // A durable task is waiting: it does the work (src/durable).
    await require('../durable').emit(`proposal:${p.id}`, { accepted: !!accept, answer });
  } else if (accept && (HANDLERS as any)[p.kind]) {
    try {
      result = await (HANDLERS as any)[p.kind](p, answer, { delivery });
    } catch (err: any) {
      await repo.proposals.reopen(p.id);
      throw err;
    }
  }
  log.info('decided', { id: Number(p.id), kind: p.kind, accept: !!accept });
  return { ok: true, result, id: Number(p.id) };
}

// Past its expiry, or a question or offer about an ask that has since closed
// (a "when should I chase?" card for an answer that already came).
async function expire() {
  const expired = await repo.proposals.expireDue();
  for (const p of expired) {
    if (p.payload?.task) await require('../durable').emit(`proposal:${p.id}`, { accepted: false, expired: true }).catch(() => {});
  }
  return expired.length;
}

module.exports = { create, pending, decide, expire, describeStart, KINDS, HANDLERS };
