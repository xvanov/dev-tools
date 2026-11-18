'use strict';

// The Claude subscription credit pool (plan 7.5; Risks: billing changed 15 Jun 2026).
//
// Headless Claude Code (`claude -p` calls) draws from a credit pool of its own,
// apart from the interactive allowance. Each call reports what it would have cost
// at API prices (`total_cost_usd` on the stream-json result record) and leaves an
// llm_spend row (backend `cli`, or `claude_session` from the removed factory, D32,
// which old rows still carry). The pool's usage is the sum of those rows since the
// pool last reset.
//
// PA_CLAUDE_POOL_USD is the pool in API-equivalent dollars; unset = not tracked,
// and nothing here ever refuses or reroutes: a spent pool shows on the Meter page.
//
// The arithmetic is pure and tested (test/claudePool.test.js). The rest is one
// query, cached briefly.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Pool = { tracked: boolean; monthlyUsd: number | null; usedUsd: number; remainingUsd: number | null; calls: number; exhausted: boolean; since: string | null; resetsAt: string | null };

const { config } = require('./config.ts');
const { logger } = require('./log.ts');

const log = logger('claude-pool');

function repoSpend() {
  return require('./repo').spend;
}

/** Start of the pool period containing `now`: local midnight of `resetDay`, this month or last. */
function periodStart(now: Date = new Date(), resetDay: number = config.claudePool.resetDay) {
  const day = Math.min(28, Math.max(1, Number(resetDay) || 1));
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
  return now >= thisMonth ? thisMonth : new Date(now.getFullYear(), now.getMonth() - 1, day);
}

/** When the pool next refills: the period after the one containing `now`. */
function periodEnd(now: Date = new Date(), resetDay: number = config.claudePool.resetDay) {
  const start = periodStart(now, resetDay);
  return new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
}

/** The pool's state from its size and what has been drawn. Pure. */
function compute({ monthlyUsd, usedUsd, calls = 0, since, resetsAt }: { monthlyUsd?: number | null; usedUsd?: unknown; calls?: number; since?: Date | string | number | null; resetsAt?: Date | string | number | null }): Pool {
  const tracked = typeof monthlyUsd === 'number' && Number.isFinite(monthlyUsd) && monthlyUsd > 0;
  const used = Number(usedUsd) || 0;
  const remainingUsd = tracked ? Math.max(0, (monthlyUsd as number) - used) : null;
  return {
    tracked,
    monthlyUsd: tracked ? monthlyUsd : null,
    usedUsd: used,
    remainingUsd,
    calls: Number(calls) || 0,
    exhausted: tracked && used >= (monthlyUsd as number),
    since: since ? new Date(since).toISOString() : null,
    resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null,
  };
}

let cache: { since: number; at: number; value: Pool } | null = null;

/** Pool usage now. Throws when the store cannot answer. */
async function status({ now = new Date(), fresh = false }: { now?: Date; fresh?: boolean } = {}) {
  const cfg = config.claudePool;
  const since = periodStart(now, cfg.resetDay);
  if (!fresh && cache && cache.since === since.getTime() && Date.now() - cache.at < 15_000) return cache.value;
  const resetsAt = periodEnd(now, cfg.resetDay);
  let used = { usd: 0, calls: 0 };
  if (cfg.monthlyUsd) used = await repoSpend().claudePoolSince(since);
  const value = compute({ monthlyUsd: cfg.monthlyUsd, usedUsd: used.usd, calls: used.calls, since, resetsAt });
  cache = { since: since.getTime(), at: Date.now(), value };
  return value;
}

/** Forgets the cached answer (a usage row was just recorded). */
function invalidate() {
  cache = null;
}

module.exports = { periodStart, periodEnd, compute, status, invalidate };
