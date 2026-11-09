'use strict';

// Where a piece of work goes in the factory. There is no route to choose
// (decision D28): every dispatch is a factory job, so this only gathers the
// facts a job needs: the commitment's repo as owner/name, the factory's
// registered apps (and the one for that repo), and the done-criteria.
//
//   forced({target, mode, done, app, register, jobKind})  the factory app, or a clear refusal
//   slugFor(target)                                        a target's owner/name
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/** A dispatch target (dispatch.resolveTarget): store rows, read column by column. */
type Target = Json;
/** A registered factory app, as factory.apps() lists it. */
type FactoryApp = { app: string; repo?: string | null; path?: string | null };
type RouteCtx = {
  factoryEnabled: boolean;
  mode: string;
  kind: string | null;
  slug: string | null;
  apps: FactoryApp[];
  done: string[];
  unavailable: string | null;
};
type Choice = { route: string; reason: string; app?: string | null };
type Decision = Choice & { done: string[]; slug: string | null; appPath?: string | null };

const fs = require('fs');
const path = require('path');

const { mode: resolveMode } = require('./modes.ts');
const R = require('./routeCore.ts');
const factory = require('./factory.ts');
const { logger } = require('../log.ts');

const log = logger('route');

async function slugFor(target: Target): Promise<string | null> {
  const own = R.normSlug(target.project?.gitlab_path);
  if (own) return own;
  // `--repo owner/name` for a --task: a slug, not a path.
  const given = R.normSlug(target.repoPath);
  if (given && !fs.existsSync(target.repoPath)) return given;
  if (target.repoPath && fs.existsSync(path.join(target.repoPath, '.git'))) return checkoutSlug(target.repoPath);
  return null;
}

// A checkout's owner/name is `gh repo view` (a spawn and a GitHub round trip,
// 1.1-1.4 s on Windows), asked at most once a day per checkout: the answer is
// kept here and in the store (setting SLUGS_SETTING), so a new process and the
// second lookup of one dispatch (previewDelivery, then the route) reuse it.
const SLUGS_SETTING = 'dispatch.repo_slugs';
const SLUG_TTL_MS = 24 * 3600_000;
const slugMemo = new Map<string, { at: number; slug: string }>();

async function checkoutSlug(dir: string): Promise<string | null> {
  const key = path.resolve(dir);
  const fresh = (e: { at: number; slug: string } | null | undefined) => (e && Date.now() - e.at < SLUG_TTL_MS ? e : null);
  const known = fresh(slugMemo.get(key));
  if (known) return known.slug;
  const system = require('../repo').system;
  const stored: Record<string, { at: string; slug: string }> = (await system.setting(SLUGS_SETTING).catch(() => null))?.value || {};
  const hit = fresh(stored[key] ? { at: Date.parse(stored[key].at), slug: stored[key].slug } : null);
  if (hit && R.normSlug(hit.slug)) {
    slugMemo.set(key, hit);
    return hit.slug;
  }
  const slug: string | null = R.normSlug(await require('./merge.ts').slugOf(dir).catch(() => null));
  if (!slug) return null;
  const at = Date.now();
  slugMemo.set(key, { at, slug });
  await system.setSetting(SLUGS_SETTING, { ...stored, [key]: { at: new Date(at).toISOString(), slug } }).catch(() => {});
  return slug;
}

async function context({ target, mode, done = null, kind = undefined, staleApps = false }: { target: Target; mode?: string | undefined; done?: string[] | null; kind?: string | null | undefined; staleApps?: boolean }): Promise<RouteCtx> {
  const factoryEnabled: boolean = factory.enabled();
  let unavailable: string | null = null;
  const [apps, slug]: [FactoryApp[], string | null] = await Promise.all([
    factoryEnabled
      ? factory.apps({ stale: staleApps }).catch((err: Error) => {
        unavailable = err.message;
        return [];
      })
      : [],
    slugFor(target),
  ]);
  return {
    factoryEnabled,
    mode: resolveMode(mode).name,
    kind: kind !== undefined ? kind : target.commitment?.kind || null,
    slug,
    apps,
    done: done && done.length ? done : R.doneCriteria(target.commitment),
    unavailable,
  };
}

/**
 * The factory app for a job; only the hard limits can refuse.
 * `register`: a repo the factory does not know yet is registered with it
 * first (`factory app add`, JOBS-API.md) instead of refused. `exactDone`
 * (an accepted proposal): the done-criteria are the card's, even when empty
 * — never re-derived from the commitment at accept time.
 */
async function forced({
  target,
  mode,
  done = null,
  app = null,
  register = false,
  exactDone = false,
  jobKind = 'code',
}: {
  target: Target;
  mode?: string | undefined;
  done?: string[] | null;
  app?: string | null;
  register?: boolean;
  exactDone?: boolean;
  jobKind?: string | null;
}): Promise<Decision & { app: string | null; appPath: string | null }> {
  const ctx = await context({ target, mode, done, staleApps: true });
  // Plan mode is a read-only factory plan job (JOBS-API v1.8), never a code job.
  if (ctx.mode === 'plan' && (!jobKind || jobKind === 'code')) jobKind = 'plan';
  if (exactDone) ctx.done = Array.isArray(done) ? done : [];
  if (!ctx.factoryEnabled) throw new Error('the factory is not configured — set PA_FACTORY_PATH (see `pa doctor`)');
  const pick = (): FactoryApp | null | undefined => (app ? ctx.apps.find((a) => a.app === app) : R.appFor(ctx.slug, ctx.apps));
  // The list may be old: an app it does not hold is asked for again.
  if (!pick() && (app || ctx.slug) && !ctx.unavailable) {
    ctx.apps = await factory.apps({ fresh: true }).catch((err: Error) => {
      ctx.unavailable = err.message;
      return ctx.apps;
    });
  }
  // A research or report job needs no repo (JOBS-API v1.2): with one the
  // factory registered, it reads that checkout; with any other, the repo is
  // named in the ask and the job runs in the factory's scratch workspace.
  if (jobKind && jobKind !== 'code') {
    const hit = pick();
    if (app && !hit) throw new Error(`no factory app "${app}" — registered: ${ctx.apps.map((a) => a.app).join(', ') || 'none'}`);
    return { route: 'factory', reason: `a ${jobKind} job`, app: hit ? hit.app : null, done: ctx.done, slug: ctx.slug, appPath: hit?.path || null };
  }
  if (ctx.unavailable) throw new Error(`the factory did not answer: ${ctx.unavailable}`);
  let hit: FactoryApp | null | undefined = pick();
  if (!hit && !app && register && ctx.slug) {
    const added = await factory.addApp({ repo: ctx.slug });
    log.info('registered a repo with the factory', { repo: ctx.slug, app: added.app });
    hit = { app: added.app, repo: added.repo || ctx.slug };
  }
  if (!hit) {
    // A setup step on you, not anyone's debt: `fix` says what fixes it, so a
    // caller can offer it (the dashboard's Do asks "register it and send?").
    if (!app && ctx.slug) {
      throw Object.assign(
        new Error(`${ctx.slug} is not registered with the factory — add --register (or \`pa factory add ${ctx.slug}\`) to register it`),
        { code: 'factory_unregistered', fix: { action: 'register', slug: ctx.slug, command: `pa factory add ${ctx.slug}` } }
      );
    }
    throw new Error(
      app
        ? `no factory app "${app}" — registered: ${ctx.apps.map((a) => a.app).join(', ') || 'none'}`
        : 'no repository known for this — set one with `pa show <id> --project <name>`, or pass --repo owner/name or --app'
    );
  }
  return { route: 'factory', reason: `a code job in ${hit.app}`, app: hit.app, done: ctx.done, slug: ctx.slug, appPath: hit.path || null };
}

module.exports = { forced, context, slugFor };
