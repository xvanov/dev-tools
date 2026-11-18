'use strict';

// Pure helpers over runs: a repo's owner/name, and the measured outcomes per route × kind
// (`pa runs stats`; older runs carry route `claude` or `factory` — the factory was removed in D32).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type StatsRow = { route?: string | null; kind?: string | null; outcome?: string | null; status?: string | null; cost_usd?: unknown };
type RouteStats = { route: string; kind: string; runs: number; delivered: number; merged: number; failed: number; dropped: number; open: number; successRate: number | null; costUsd: number | null; costPerSuccess: number | null };

const ROUTES = ['claude', 'factory'];
const OUTCOMES = ['delivered', 'merged', 'failed', 'dropped'];

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normSlug(s: string | null | undefined): string | null {
  const t = String(s || '').trim().replace(/\.git$/i, '').toLowerCase();
  return SLUG.test(t) ? t : null;
}

/**
 * Which route works for which task: runs grouped by route × kind.
 * @param {Array} rows [{route, kind, outcome, status, cost_usd}]
 * @returns {Array<{route, kind, runs, delivered, merged, failed, dropped, open, successRate, costUsd, costPerSuccess}>}
 */
function summarize(rows: StatsRow[] | null | undefined): RouteStats[] {
  type Group = { route: string; kind: string; runs: number; delivered: number; merged: number; failed: number; dropped: number; open: number; costUsd: number; costKnown: number };
  const groups = new Map<string, Group>();
  for (const r of rows || []) {
    const route = ROUTES.includes(r.route as string) ? (r.route as string) : 'claude';
    const kind = r.kind || 'unplanned';
    const key = `${route}\u0000${kind}`;
    if (!groups.has(key)) {
      groups.set(key, { route, kind, runs: 0, delivered: 0, merged: 0, failed: 0, dropped: 0, open: 0, costUsd: 0, costKnown: 0 });
    }
    const g = groups.get(key) as Group;
    g.runs++;
    if (OUTCOMES.includes(r.outcome as string)) g[r.outcome as 'delivered' | 'merged' | 'failed' | 'dropped']++;
    else g.open++;
    const cost = Number(r.cost_usd);
    if (r.cost_usd !== null && r.cost_usd !== undefined && Number.isFinite(cost)) {
      g.costUsd += cost;
      g.costKnown++;
    }
  }
  return [...groups.values()]
    .map((g) => {
      const success = g.delivered + g.merged;
      const settled = success + g.failed + g.dropped;
      return {
        route: g.route,
        kind: g.kind,
        runs: g.runs,
        delivered: g.delivered,
        merged: g.merged,
        failed: g.failed,
        dropped: g.dropped,
        open: g.open,
        // Of the runs that finished one way or the other; still-open ones say nothing yet.
        successRate: settled ? success / settled : null,
        costUsd: g.costKnown ? Math.round(g.costUsd * 100) / 100 : null,
        costPerSuccess: g.costKnown && success ? Math.round((g.costUsd / success) * 100) / 100 : null,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route) || b.runs - a.runs || a.kind.localeCompare(b.kind));
}

module.exports = { ROUTES, OUTCOMES, normSlug, summarize };
