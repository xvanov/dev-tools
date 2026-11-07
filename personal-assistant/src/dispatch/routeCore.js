'use strict';

// Which route a piece of work takes: a Claude Code session (the dispatcher's
// own worktree + termhub session) or the software factory (a job: PM → SM →
// dev → reviewer → gates, src/dispatch/factory.js). Pure, like plannerCore:
// the impure half (src/dispatch/route.js) gathers the facts and calls this.
//
// The rule, v1 — deterministic on purpose, so it can be tested and so the
// measured outcomes (sql/024, `pa runs stats`) are of a rule you can name:
//
//   factory  when ALL hold: the factory is configured; the mode changes code
//            (not `plan`); the ask is a concrete code change (`kind` coding,
//            from the planner); its repo is registered with the factory
//            (`factory app list`); and it has done-criteria the factory can
//            be held to.
//   claude   otherwise — investigate, ambiguous, plan mode, unknown or
//            unregistered repo, or nothing to check the result against.
//
// The seam for something smarter (an LLM, or a chooser that reads the
// outcomes table): any chooser returns {route, reason}, and `guard` holds its
// answer to the hard limits below whatever it says. Register it in
// src/dispatch/route.js; the guard stays here.

const ROUTES = ['claude', 'factory'];
const VIAS = ['claude', 'factory', 'auto'];
const OUTCOMES = ['delivered', 'merged', 'failed', 'dropped'];

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function via(name) {
  const v = String(name || 'claude').toLowerCase();
  if (!VIAS.includes(v)) throw new Error(`unknown route "${name}" — --via one of: ${VIAS.join(', ')}`);
  return v;
}

/**
 * Pure. The route when the caller named none: PA_DISPATCH_VIA (which itself
 * defaults to the factory once one is configured). A default is not a choice,
 * so it yields where the factory cannot do what was asked: plan mode (read-only
 * — a Claude session), or a run pinned to a machine (`--machine` picks where a
 * Claude session runs; the factory runs on its own).
 */
function defaultVia({ configured = 'claude', mode = null, machine = null } = {}) {
  const v = via(configured || 'claude');
  if (v !== 'claude' && (String(mode || '').toLowerCase() === 'plan' || machine)) return 'claude';
  return v;
}

function normSlug(s) {
  const t = String(s || '').trim().replace(/\.git$/i, '').toLowerCase();
  return SLUG.test(t) ? t : null;
}

/** The registered factory app for a repo slug, or null. */
function appFor(slug, apps) {
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
function doneCriteria(commitment) {
  const detail = String(commitment?.detail || '').trim();
  if (!detail) return [];
  return detail
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3)
    .map((l) => (l.length > 500 ? `${l.slice(0, 499)}…` : l))
    .slice(0, 8);
}

const claude = (reason) => ({ route: 'claude', reason, app: null });

/**
 * @param {object} ctx
 * @param {boolean} ctx.factoryEnabled
 * @param {string}  ctx.mode    resolved PA mode name
 * @param {string|null} ctx.kind  commitment.kind (the planner's), null if not planned
 * @param {string|null} ctx.slug  owner/repo of the work's repository
 * @param {Array}   ctx.apps    `factory app list` rows
 * @param {Array<string>} ctx.done  done-criteria
 * @returns {{route, reason, app}}
 */
function chooseRoute(ctx) {
  if (!ctx.factoryEnabled) return claude('the factory is not configured (PA_FACTORY_PATH)');
  if (ctx.mode === 'plan') return claude('plan mode is read-only; the factory only builds');
  if (ctx.kind !== 'coding') {
    return claude(ctx.kind ? `planned as "${ctx.kind}", not a concrete code change` : 'not known to be a code change (not planned yet)');
  }
  if (!ctx.slug) return claude('no repository known for it');
  const app = appFor(ctx.slug, ctx.apps);
  if (!app) return claude(`${ctx.slug} is not registered with the factory`);
  if (!(ctx.done || []).length) return claude('no stated done-criteria to hold the factory to');
  return {
    route: 'factory',
    reason: `a code change in ${normSlug(ctx.slug)} (factory app ${app.app}) with ${ctx.done.length} done-criteria`,
    app: app.app,
  };
}

/**
 * Holds any chooser's answer to what may never be crossed: no factory job
 * without a configured factory, in plan mode, or for a repo it has not
 * registered. Anything else a chooser decides stands.
 */
function guard(choice, ctx) {
  const reason = choice?.reason ? String(choice.reason).slice(0, 300) : null;
  if (choice?.route !== 'factory') return claude(reason || 'a Claude session');
  if (!ctx.factoryEnabled) return claude('the factory is not configured (PA_FACTORY_PATH)');
  if (ctx.mode === 'plan') return claude('plan mode is read-only; the factory only builds');
  const app = appFor(ctx.slug, ctx.apps);
  if (!app) return claude(ctx.slug ? `${ctx.slug} is not registered with the factory` : 'no repository known for it');
  return { route: 'factory', reason: reason || 'factory', app: app.app };
}

/**
 * Which route works for which task: runs grouped by route × kind.
 * @param {Array} rows [{route, kind, outcome, status, cost_usd}]
 * @returns {Array<{route, kind, runs, delivered, merged, failed, dropped, open, successRate, costUsd, costPerSuccess}>}
 */
function summarize(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const route = ROUTES.includes(r.route) ? r.route : 'claude';
    const kind = r.kind || 'unplanned';
    const key = `${route}\u0000${kind}`;
    if (!groups.has(key)) {
      groups.set(key, { route, kind, runs: 0, delivered: 0, merged: 0, failed: 0, dropped: 0, open: 0, costUsd: 0, costKnown: 0 });
    }
    const g = groups.get(key);
    g.runs++;
    if (OUTCOMES.includes(r.outcome)) g[r.outcome]++;
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

module.exports = { ROUTES, VIAS, OUTCOMES, via, defaultVia, normSlug, appFor, doneCriteria, chooseRoute, guard, summarize };
