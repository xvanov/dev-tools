'use strict';

// One runtime-failover policy (JOBS-API v1.9), for both places a runtime can be
// out for a while:
//
//   - inside the factory: a provider limit (Claude's 5-hour / weekly window, an
//     API 429) trips that runtime's breaker and pauses the job until the reset
//     (software-factory factory/provider_limits.py). The PA passes `--failover
//     on` with every job when this policy is on.
//   - here, before submit: the Claude credit pool is spent (src/claudePool.ts)
//     until it refills.
//
// Either way the same rule: off by default (PA_RUNTIME_FAILOVER, or its older
// name PA_CLAUDE_POOL_FALLBACK_API); on, a job moves to the other runtime only
// when the wait is longer than PA_RUNTIME_FAILOVER_MIN_WAIT_MIN (default 30),
// and the operator is always notified when it does.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Decision = { runtime: string; fellBack: boolean; reason: string | null; waitMin: number | null };

function other(runtime: string): string {
  return runtime === 'claude_session' ? 'api' : 'claude_session';
}

/**
 * Pure. Whether a job asking for `requested` should run on the other runtime
 * because `requested` is limited until `limitedUntil` (null = not limited;
 * an unknown reset counts as a long wait). `why` names the limit.
 */
function decide({ requested, limitedUntil, now = new Date(), enabled, minWaitMin = 30, why = 'limited' }: {
  requested: string; limitedUntil: Date | string | number | null | undefined | 'unknown'; now?: Date; enabled: boolean; minWaitMin?: number; why?: string;
}): Decision {
  if (limitedUntil == null) return { runtime: requested, fellBack: false, reason: null, waitMin: null };
  const until = limitedUntil === 'unknown' ? null : new Date(limitedUntil);
  const waitMin = until && !Number.isNaN(until.getTime()) ? Math.max(0, (until.getTime() - now.getTime()) / 60_000) : Infinity;
  if (waitMin <= 0) return { runtime: requested, fellBack: false, reason: null, waitMin: 0 };
  if (!enabled) return { runtime: requested, fellBack: false, reason: `${why}; failover is off`, waitMin };
  if (waitMin <= minWaitMin) return { runtime: requested, fellBack: false, reason: `${why}; the wait (${Math.round(waitMin)} min) is under the failover threshold (${minWaitMin} min)`, waitMin };
  const target = other(requested);
  const when = until ? ` until ${until.toISOString().slice(0, 16).replace('T', ' ')}Z` : '';
  return { runtime: target, fellBack: true, reason: `${why}${when}: failed over from ${requested} to ${target}`, waitMin };
}

/** The policy as configured (config.factory.failover / failoverMinWaitMin). */
function policy(): { enabled: boolean; minWaitMin: number } {
  const { config } = require('../config.ts');
  return { enabled: Boolean(config.factory.failover), minWaitMin: Number(config.factory.failoverMinWaitMin) || 30 };
}

module.exports = { decide, policy, other };
