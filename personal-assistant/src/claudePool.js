'use strict';

// The Claude subscription credit pool (plan 7.5; Risks: billing changed 15 Jun 2026).
//
// Headless Claude Code (`claude -p` calls and factory claude_session runs) draws
// from a credit pool of its own, apart from the interactive allowance. Both
// report what a run would have cost at API prices (`total_cost_usd` on the
// stream-json result record), and both leave an llm_spend row: backend `cli`
// for the PA's own calls, `claude_session` for factory runs (posted to
// POST /api/telemetry by the factory). The pool's usage is the sum of those
// rows since the pool last reset.
//
// PA_CLAUDE_POOL_USD is the pool in API-equivalent dollars; unset = not tracked,
// and nothing here ever refuses or reroutes. With PA_CLAUDE_POOL_FALLBACK_API=1
// (default off), a claude_session job is dispatched on the `api` runtime once the
// pool is spent; otherwise it keeps running and the Meter page says it is over.
//
// The arithmetic is pure and tested (test/claudePool.test.js). The rest is one
// query, cached briefly: dispatch may ask for every job.

const { config } = require('./config');
const { logger } = require('./log');

const log = logger('claude-pool');

function repoSpend() {
  return require('./repo').spend;
}

/** Start of the pool period containing `now`: local midnight of `resetDay`, this month or last. */
function periodStart(now = new Date(), resetDay = config.claudePool.resetDay) {
  const day = Math.min(28, Math.max(1, Number(resetDay) || 1));
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
  return now >= thisMonth ? thisMonth : new Date(now.getFullYear(), now.getMonth() - 1, day);
}

/** When the pool next refills: the period after the one containing `now`. */
function periodEnd(now = new Date(), resetDay = config.claudePool.resetDay) {
  const start = periodStart(now, resetDay);
  return new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
}

/** The pool's state from its size and what has been drawn. Pure. */
function compute({ monthlyUsd, usedUsd, calls = 0, since, resetsAt, fallbackApi = false }) {
  const tracked = Number.isFinite(monthlyUsd) && monthlyUsd > 0;
  const used = Number(usedUsd) || 0;
  const remainingUsd = tracked ? Math.max(0, monthlyUsd - used) : null;
  return {
    tracked,
    monthlyUsd: tracked ? monthlyUsd : null,
    usedUsd: used,
    remainingUsd,
    calls: Number(calls) || 0,
    exhausted: tracked && used >= monthlyUsd,
    fallbackApi: Boolean(fallbackApi),
    since: since ? new Date(since).toISOString() : null,
    resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null,
  };
}

/** Which runtime a job asking for `requested` should get, given the pool. Pure. */
function decideRuntime(requested, pool) {
  if (requested !== 'claude_session' || !pool?.tracked || !pool.exhausted || !pool.fallbackApi) {
    return { runtime: requested, fellBack: false, reason: null };
  }
  return {
    runtime: 'api',
    fellBack: true,
    reason: `the Claude credit pool is spent ($${pool.usedUsd.toFixed(2)} of $${pool.monthlyUsd.toFixed(2)} since ${pool.since.slice(0, 10)}); using the api runtime (PA_CLAUDE_POOL_FALLBACK_API)`,
  };
}

let cache = null;

/** Pool usage now. Throws when the store cannot answer. */
async function status({ now = new Date(), fresh = false } = {}) {
  const cfg = config.claudePool;
  const since = periodStart(now, cfg.resetDay);
  if (!fresh && cache && cache.since === since.getTime() && Date.now() - cache.at < 15_000) return cache.value;
  const resetsAt = periodEnd(now, cfg.resetDay);
  let used = { usd: 0, calls: 0 };
  if (cfg.monthlyUsd) used = await repoSpend().claudePoolSince(since);
  const value = compute({ monthlyUsd: cfg.monthlyUsd, usedUsd: used.usd, calls: used.calls, since, resetsAt, fallbackApi: cfg.fallbackApi });
  cache = { since: since.getTime(), at: Date.now(), value };
  return value;
}

/** Forgets the cached answer (a usage row was just recorded). */
function invalidate() {
  cache = null;
}

/**
 * The runtime a job should use. Fails open: when the pool cannot be read, the
 * requested runtime stands (a broken ledger must not silently move work onto
 * metered billing).
 */
async function route(requested) {
  if (requested !== 'claude_session' || !config.claudePool.fallbackApi || !config.claudePool.monthlyUsd) {
    return { runtime: requested, fellBack: false, reason: null };
  }
  try {
    const out = decideRuntime(requested, await status());
    if (out.fellBack) log.warn('claude_session job rerouted to the api runtime', { reason: out.reason });
    return out;
  } catch (err) {
    log.warn('claude pool unknown, keeping the requested runtime', { message: err.message });
    return { runtime: requested, fellBack: false, reason: null };
  }
}

module.exports = { periodStart, periodEnd, compute, decideRuntime, status, invalidate, route };
