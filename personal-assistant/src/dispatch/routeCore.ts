'use strict';

// Pure helpers for where a piece of work goes. There is no route to choose
// any more (decision D28, docs/native/PLAN.md): every dispatch is a software-
// factory job (src/dispatch/factory.ts), so the old claude/factory/auto rule
// (chooseRoute, guard, PA_DISPATCH_VIA, PA_ROUTE_CHOOSER) is gone. What is
// left: a repo's owner/name, the registered factory app for it, the
// done-criteria a commitment states, and the measured outcomes per route ×
// kind (`pa runs stats`; older runs carry route `claude`).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** A `factory app list` row: JSON from the factory CLI. */
type FactoryApp = { app: string; repo?: string | null; [k: string]: unknown };
type StatsRow = { route?: string | null; kind?: string | null; outcome?: string | null; status?: string | null; cost_usd?: unknown };
type RouteStats = { route: string; kind: string; runs: number; delivered: number; merged: number; failed: number; dropped: number; open: number; successRate: number | null; costUsd: number | null; costPerSuccess: number | null };

const ROUTES = ['claude', 'factory'];
const OUTCOMES = ['delivered', 'merged', 'failed', 'dropped'];

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normSlug(s: string | null | undefined): string | null {
  const t = String(s || '').trim().replace(/\.git$/i, '').toLowerCase();
  return SLUG.test(t) ? t : null;
}

/** The registered factory app for a repo slug, or null. */
function appFor(slug: string | null | undefined, apps: FactoryApp[] | null | undefined): FactoryApp | null {
  const s = normSlug(slug);
  if (!s) return null;
  return (apps || []).find((a) => normSlug(a.repo) === s) || null;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+/;

/**
 * Done-criteria from a commitment: its `detail` ("what done looks like" in the
 * brief), one criterion per line or bullet. A one-paragraph detail is one
 * criterion. Nothing stated is an empty list, not an invented one.
 */
function doneCriteria(commitment: { detail?: string | null } | null | undefined): string[] {
  const detail = String(commitment?.detail || '').trim();
  if (!detail) return [];
  return detail
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3)
    .map((l) => (l.length > 500 ? `${l.slice(0, 499)}…` : l))
    .slice(0, 8);
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

module.exports = { ROUTES, OUTCOMES, normSlug, appFor, doneCriteria, summarize };
