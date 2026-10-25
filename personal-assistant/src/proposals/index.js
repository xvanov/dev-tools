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
  // Start a run on an ask, in the mode the planner chose (a `local` run never
  // pushes: src/dispatch/modes.js).
  async dispatch(p) {
    const run = await require('../dispatch').start({
      commitmentId: p.commitment_id,
      mode: p.payload?.mode || undefined,
      repoPath: p.payload?.repoPath || null,
    });
    return `run #${run.id} started (${run.mode})`;
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

/**
 * @param {number} id
 * @param {{accept: boolean, answer?: string}} o
 */
async function decide(id, { accept, answer = null }) {
  const p = await one(`update proposal set status = $2, answer = $3, decided_at = now()
                        where id = $1 and status = 'pending' returning *`, [id, accept ? 'accepted' : 'rejected', answer]);
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
      result = await HANDLERS[p.kind](p, answer);
    } catch (err) {
      await query(`update proposal set status = 'pending', decided_at = null where id = $1`, [p.id]);
      throw err;
    }
  }
  log.info('decided', { id: Number(p.id), kind: p.kind, accept: !!accept });
  return { ok: true, result, id: Number(p.id) };
}

async function expire() {
  const r = await query(`update proposal set status = 'expired' where status = 'pending' and expires_at <= now() returning id, payload`);
  for (const p of r.rows || []) {
    if (p.payload?.task) await require('../durable').emit(`proposal:${p.id}`, { accepted: false, expired: true }).catch(() => {});
  }
  return r.rowCount || 0;
}

module.exports = { create, pending, decide, expire, KINDS, HANDLERS };
