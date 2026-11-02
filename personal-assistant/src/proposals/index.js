'use strict';

// The assistant's questions and prepared actions, waiting for me (sql/020).
//
//   create({kind, title, ...})        idempotent by dedupeKey
//   pending()                         what the dashboard shows under "Needs you"
//   decide(id, {accept, answer})      my answer; runs or wakes what waits on it
//   expire()                          proposals past their expiry
//
// Two ways a proposal is acted on. A durable task that is waiting on it (a
// finished run waiting to be landed, src/durable/tasks) gets the absurd event
// `proposal:<id>` and does the work itself, as a checkpointed step. Anything
// else runs the typed handler for its kind below. There is no handler that
// takes a command or free text to run: a new kind of action is a new entry in
// HANDLERS, reviewed like any other code (AGENT.md, routines).

const { one, rows, query } = require('../db');
const { logger } = require('../log');

const log = logger('proposals');

const KINDS = ['land', 'dispatch', 'question'];

async function create({ kind, title, body = '', commitmentId = null, runId = null, options = null, payload = {}, dedupeKey = null, expiresAt = null }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown proposal kind "${kind}"`);
  const row = await one(
    `insert into proposal (kind, commitment_id, run_id, title, body, options, payload, dedupe_key, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (dedupe_key) do nothing
     returning *`,
    [kind, commitmentId, runId, String(title).slice(0, 300), String(body).slice(0, 8000), options ? JSON.stringify(options) : null, payload, dedupeKey, expiresAt]
  );
  if (row) log.info('proposed', { id: Number(row.id), kind, commitment: commitmentId, run: runId });
  return row;
}

async function pending({ limit = 40 } = {}) {
  return rows(
    `select p.*, c.summary as commitment_summary
       from proposal p left join commitment c on c.id = p.commitment_id
      where p.status = 'pending' and (p.expires_at is null or p.expires_at > now())
      order by p.created_at desc limit $1`,
    [limit]
  );
}

// Typed actions for proposals no task is waiting on. Each gets the proposal
// and my answer and returns a short result line.
const HANDLERS = {
  // Start a run on an ask. A frozen offer (src/dispatch/offer.js) runs
  // exactly what its card showed — route, app, done-criteria, brief,
  // pipeline, models — at the delivery level shown, or the one I picked on the
  // card when accepting. An older proposal without frozen values is a run in
  // the mode and on the route it named (a Claude session if none).
  async dispatch(p, answer, { delivery: picked = null } = {}) {
    const pl = p.payload || {};
    if (pl.frozen) {
      const D = require('../dispatch/deliveryCore');
      const delivery = picked ? D.delivery(picked) : pl.delivery || null;
      const changed = Boolean(picked) && delivery !== pl.delivery;
      if (pl.via === 'factory' && !delivery) throw new Error('a factory offer without a delivery level — decline it and offer it again');
      const run = await require('../dispatch').start({
        commitmentId: p.commitment_id,
        task: pl.task || null,
        repoPath: pl.repoPath || null,
        via: pl.via === 'factory' ? 'factory' : 'claude',
        mode: pl.via === 'factory' ? undefined : (changed ? undefined : pl.mode) || undefined,
        delivery: delivery || undefined,
        deliverySource: changed ? 'explicit' : pl.deliverySource || null,
        deliveryPhrase: changed ? null : pl.deliveryPhrase || null,
        app: pl.app || null,
        register: Boolean(pl.register),
        done: Array.isArray(pl.done) ? pl.done : [],
        pipeline: pl.pipeline || null,
        models: pl.models || null,
        brief: pl.via === 'factory' ? require('../dispatch/offer').briefAt(pl, delivery) : null,
        briefBy: pl.briefBy || null,
        frozen: true,
        routeReason: pl.routeReason ? `proposal: ${pl.routeReason}` : null,
      });
      return describeStart(run);
    }
    const via = pl.via === 'factory' ? 'factory' : 'claude';
    const run = await require('../dispatch').start({
      commitmentId: p.commitment_id,
      mode: pl.mode || undefined,
      repoPath: pl.repoPath || null,
      via,
      routeReason: pl.routeReason ? `proposal: ${pl.routeReason}` : null,
    });
    return describeStart(run);
  },
  // A question: what the answer means is named by `payload.on`.
  async question(p, answer) {
    if (p.payload?.on === 'project' && p.commitment_id) {
      if (answer === 'none') return 'left without a repo';
      await require('../projects').correct(p.commitment_id, answer, { rationale: 'you picked it when the assistant asked' });
      // Planned again with the repo it now has.
      await query('update commitment set planned_at = null where id = $1', [p.commitment_id]);
      return `#${p.commitment_id} is in ${answer}`;
    }
    return 'noted';
  },
};

function describeStart(run) {
  if (run.route === 'factory') {
    if (run.submitUnknown) return `run #${run.id} sent to the factory; its answer was lost — the worker matches it to its job (pa review ${run.id})`;
    return `run #${run.id} sent to the factory (job ${run.jobId}, ${run.delivery})`;
  }
  return `run #${run.id} started (${run.mode}${run.delivery ? ` → ${run.delivery}` : ''})`;
}

/**
 * @param {number} id
 * @param {{accept: boolean, answer?: string, delivery?: string}} o
 *   `delivery`: on a dispatch card, the end state picked when accepting —
 *   the card's own level when absent.
 */
async function decide(id, { accept, answer = null, delivery = null }) {
  if (delivery) delivery = require('../dispatch/deliveryCore').delivery(delivery);
  const recorded = answer || (accept && delivery ? `delivery=${delivery}` : null);
  const p = await one(`update proposal set status = $2, answer = $3, decided_at = now()
                        where id = $1 and status = 'pending' returning *`, [id, accept ? 'accepted' : 'rejected', recorded]);
  if (!p) {
    const cur = await one('select status from proposal where id = $1', [id]);
    return { ok: false, result: cur ? `already ${cur.status}` : `no proposal #${id}` };
  }
  let result = accept ? 'accepted' : 'declined';
  if (p.payload?.task) {
    // A durable task is waiting: it does the work (src/durable).
    await require('../durable').emit(`proposal:${p.id}`, { accepted: !!accept, answer });
  } else if (accept && HANDLERS[p.kind]) {
    try {
      result = await HANDLERS[p.kind](p, answer, { delivery });
    } catch (err) {
      await query(`update proposal set status = 'pending', decided_at = null where id = $1`, [p.id]);
      throw err;
    }
  }
  log.info('decided', { id: Number(p.id), kind: p.kind, accept: !!accept });
  return { ok: true, result, id: Number(p.id) };
}

// Past its expiry, or a question or offer about an ask that has since closed
// (a "when should I chase?" card for an answer that already came).
async function expire() {
  const r = await query(
    `update proposal p set status = 'expired'
      where p.status = 'pending'
        and (p.expires_at <= now()
             or (p.kind in ('question', 'dispatch')
                 and exists (select 1 from commitment c where c.id = p.commitment_id and c.status in ('done', 'dropped'))))
      returning p.id, p.payload`
  );
  for (const p of r.rows || []) {
    if (p.payload?.task) await require('../durable').emit(`proposal:${p.id}`, { accepted: false, expired: true }).catch(() => {});
  }
  return r.rowCount || 0;
}

module.exports = { create, pending, decide, expire, describeStart, KINDS, HANDLERS };
