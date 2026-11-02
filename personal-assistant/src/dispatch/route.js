'use strict';

// Choosing a route for one piece of work (routeCore.js has the rule and the
// guard). This half gathers the facts the rule reads: the PA mode, the
// commitment's kind, its repo as owner/name, the factory's registered apps,
// and the done-criteria.
//
//   decide({target, mode, done, kind})   `--via auto`: the chooser's pick, guarded
//   forced({target, mode, done, app})    `--via factory`: the factory or a clear refusal
//   decideFor({commitmentId, kind, mode}) the planner's: same, from an id
//
// CHOOSERS is the seam for a smarter chooser (an LLM, or one that reads the
// outcomes `pa runs stats` measures): a function ctx → {route, reason}, picked
// by PA_ROUTE_CHOOSER. Whatever it answers goes through routeCore.guard.

const fs = require('fs');
const path = require('path');

const { config } = require('../config');
const { mode: resolveMode } = require('./modes');
const R = require('./routeCore');
const factory = require('./factory');
const { logger } = require('../log');

const log = logger('route');

const CHOOSERS = {
  rule: (ctx) => R.chooseRoute(ctx),
};

async function slugFor(target) {
  const own = R.normSlug(target.project?.gitlab_path);
  if (own) return own;
  // `--repo owner/name` for a --task: a slug, not a path.
  const given = R.normSlug(target.repoPath);
  if (given && !fs.existsSync(target.repoPath)) return given;
  if (target.repoPath && fs.existsSync(path.join(target.repoPath, '.git'))) {
    return R.normSlug(await require('./merge').slugOf(target.repoPath).catch(() => null));
  }
  return null;
}

async function context({ target, mode, done = null, kind = undefined }) {
  const factoryEnabled = factory.enabled();
  let apps = [];
  let unavailable = null;
  if (factoryEnabled) {
    apps = await factory.apps().catch((err) => {
      unavailable = err.message;
      return [];
    });
  }
  return {
    factoryEnabled,
    mode: resolveMode(mode).name,
    kind: kind !== undefined ? kind : target.commitment?.kind || null,
    slug: await slugFor(target),
    apps,
    done: done && done.length ? done : R.doneCriteria(target.commitment),
    unavailable,
  };
}

async function decide(o) {
  const ctx = await context(o);
  const chooser = CHOOSERS[config.factory.chooser] || CHOOSERS.rule;
  let choice;
  try {
    choice = await chooser(ctx);
  } catch (err) {
    log.warn('route chooser failed; using the rule', { chooser: config.factory.chooser, message: err.message });
    choice = R.chooseRoute(ctx);
  }
  const g = R.guard(choice, ctx);
  if (g.route === 'claude' && ctx.unavailable) g.reason = `${g.reason} (factory unreachable: ${ctx.unavailable.slice(0, 120)})`;
  return { ...g, done: ctx.done, slug: ctx.slug };
}

/**
 * `--via factory`: the human chose it; only the hard limits can refuse.
 * `register`: a repo the factory does not know yet is registered with it
 * first (`factory app add`, JOBS-API.md) instead of refused. `exactDone`
 * (an accepted proposal): the done-criteria are the card's, even when empty
 * — never re-derived from the commitment at accept time.
 */
async function forced({ target, mode, done = null, app = null, register = false, exactDone = false }) {
  const ctx = await context({ target, mode, done });
  if (exactDone) ctx.done = Array.isArray(done) ? done : [];
  if (!ctx.factoryEnabled) throw new Error('the factory is not configured — set PA_FACTORY_PATH (see `pa doctor`)');
  if (ctx.unavailable) throw new Error(`the factory did not answer: ${ctx.unavailable}`);
  if (ctx.mode === 'plan') throw new Error('plan mode is read-only and is not a factory job — use --via claude, or another mode');
  let hit = app ? ctx.apps.find((a) => a.app === app) : R.appFor(ctx.slug, ctx.apps);
  if (!hit && !app && register && ctx.slug) {
    const added = await factory.addApp({ repo: ctx.slug });
    log.info('registered a repo with the factory', { repo: ctx.slug, app: added.app });
    hit = { app: added.app, repo: added.repo || ctx.slug };
  }
  if (!hit) {
    throw new Error(
      app
        ? `no factory app "${app}" — registered: ${ctx.apps.map((a) => a.app).join(', ') || 'none'}`
        : ctx.slug
          ? `${ctx.slug} is not registered with the factory — add --register (or \`pa factory add ${ctx.slug}\`) to register it`
          : 'no repository known for this — set one with `pa show <id> --project <name>`, or pass --repo owner/name or --app'
    );
  }
  return { route: 'factory', reason: 'you chose the factory', app: hit.app, done: ctx.done, slug: ctx.slug, appPath: hit.path || null };
}

async function decideFor({ commitmentId, kind, mode }) {
  const target = await require('./index').resolveTarget({ commitmentId });
  return decide({ target, mode, kind });
}

module.exports = { CHOOSERS, decide, forced, decideFor, context, slugFor };
