'use strict';

// A card's dispatch settings: what `Do` on a commitment sends to the software
// factory. Every dispatch is a factory job (decision D28), so there is no route
// to pick; what is left is runtime, mode, end state (delivery), job kind and
// app/repo, each either the card's own choice (an override, stored per card) or
// a default:
//
//   runtime   claude_session (PA_FACTORY_RUNTIME); a plan job is claude_session
//   mode      full (PA_DISPATCH_MODE); plan makes it a read-only plan job
//   delivery  the factory app's delivery.default (`factory app list`), else the
//             repo's PA default (`pa delivery`), else PA_DELIVERY_DEFAULT;
//             `none` for research/report/plan
//   jobKind   from the ask's text (factoryCore.inferKind; deterministic)
//   app/repo  the commitment's repo and the factory app registered for it
//
//   resolve(input)               pure: the effective settings and where each came from
//   forCard(id, {given})         the card's resolved settings + the options (GET)
//   setForCard(id, patch)        store overrides (null clears one) → forCard (POST)
//   effective({commitmentId, task, given})  what dispatch.start sends
//
// Overrides live in the store's settings as `dispatch.card.<id>` (no table:
// a handful of fields per card, read whole).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type FactoryApp = { app: string; repo?: string | null; path?: string | null; delivery?: { default?: string | null } | null; [k: string]: unknown };
type Fields = { runtime: string | null; mode: string | null; delivery: string | null; jobKind: string | null; app: string | null; repo: string | null };
type Overrides = Partial<Fields>;
type Resolved = {
  settings: Fields;
  source: Record<keyof Fields, string>;
  why: { jobKind: string; delivery: string };
  /** the operator's words that picked the delivery (source `inferred`) */
  phrase: string | null;
};

const F = require('./factoryCore.ts');
const D = require('./deliveryCore.ts');
const R = require('./routeCore.ts');
const { MODES } = require('./modes.ts');

const FIELDS: (keyof Fields)[] = ['runtime', 'mode', 'delivery', 'jobKind', 'app', 'repo'];
const KEY = (id: number | string) => `dispatch.card.${Number(id)}`;

/** Pure. One field's value checked and normalised; null clears it. Throws on a bad value. */
function check(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim();
  switch (field) {
    case 'runtime': return F.runtime(v);
    case 'jobKind': return F.jobKind(v);
    case 'delivery': return D.delivery(v);
    case 'mode': {
      const m = v.toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(MODES, m)) throw new Error(`unknown mode "${v}" — one of: ${Object.keys(MODES).join(', ')}`);
      return m;
    }
    case 'app':
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(v)) throw new Error(`"${v}" is not a factory app name`);
      return v;
    case 'repo':
      if (v.length > 300) throw new Error('repo is too long');
      return v;
    default: throw new Error(`unknown dispatch setting "${field}" — one of: ${FIELDS.join(', ')}`);
  }
}

/** Pure. A patch (from the page or a caller) checked: only known fields; null clears. */
function checkPatch(patch: Json): Overrides {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('send an object of settings');
  const out: Overrides = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!FIELDS.includes(k as keyof Fields)) throw new Error(`unknown dispatch setting "${k}" — one of: ${FIELDS.join(', ')}`);
    out[k as keyof Fields] = check(k, v);
  }
  return out;
}

/**
 * Pure. The effective settings: `given` (this call's explicit choices) over
 * `stored` (the card's overrides) over the defaults.
 */
function resolve({
  given = {}, stored = {}, text = null, operatorText = null, commitmentKind = null, slug = null, apps = [],
  repoDefault = null, fallbackDelivery = D.FALLBACK, configuredRuntime = 'claude_session', configuredMode = 'full',
}: {
  given?: Overrides; stored?: Overrides; text?: string | null; operatorText?: string | null; commitmentKind?: string | null; slug?: string | null; apps?: FactoryApp[];
  repoDefault?: string | null; fallbackDelivery?: string; configuredRuntime?: string | null; configuredMode?: string | null;
}): Resolved {
  const pick = (f: keyof Fields): [string | null, string] =>
    given[f] != null ? [given[f] as string, 'given'] : stored[f] != null ? [stored[f] as string, 'card'] : [null, 'default'];
  const source = {} as Record<keyof Fields, string>;

  let [mode, ms] = pick('mode');
  if (!mode) mode = check('mode', configuredMode) || 'full';
  source.mode = ms;

  let [jobKind, ks] = pick('jobKind');
  let kindWhy = ks === 'given' ? 'chosen for this start' : 'chosen on the card';
  if (mode === 'plan' && (!jobKind || jobKind === 'code')) {
    jobKind = 'plan';
    ks = source.mode;
    kindWhy = 'plan mode is read-only';
  } else if (!jobKind) {
    const inferred = F.inferKind({ text, commitmentKind, mode });
    jobKind = inferred.kind;
    ks = 'inferred';
    kindWhy = inferred.reason;
  }
  source.jobKind = ks;

  let [runtime, rs] = pick('runtime');
  if (!runtime) runtime = F.defaultRuntime(jobKind, configuredRuntime);
  source.runtime = rs;

  const [repo, repoSrc] = pick('repo');
  source.repo = repo ? repoSrc : slug ? 'commitment' : 'none';
  const repoSlug = R.normSlug(repo) || (repo ? null : slug);
  const [appName, appSrc] = pick('app');
  const app = appName ? (apps.find((a) => a.app === appName) || null) : R.appFor(repoSlug, apps);
  source.app = appName ? appSrc : app ? 'repo' : 'none';

  let [delivery, ds] = pick('delivery');
  let phrase: string | null = null;
  let deliveryWhy = ds === 'given' ? 'chosen for this start' : 'chosen on the card';
  if (jobKind !== 'code') {
    delivery = 'none';
    ds = 'kind';
    deliveryWhy = `a ${jobKind} job delivers a report, never code`;
  } else if (!delivery) {
    // The operator's own words for this start (never a third party's, never
    // the commitment's text) may name a level, up to `pr` (deliveryCore.infer).
    const said = D.infer(operatorText);
    const appDefault = app?.delivery?.default && D.isDelivery(app.delivery.default) ? app.delivery.default : null;
    if (said) [delivery, ds, deliveryWhy, phrase] = [said.delivery, 'inferred', `your words: "${said.phrase}"`, said.phrase];
    else if (appDefault) [delivery, ds, deliveryWhy] = [appDefault, 'app_default', `factory app ${app?.app}'s delivery.default`];
    else if (repoDefault && D.isDelivery(repoDefault)) [delivery, ds, deliveryWhy] = [repoDefault, 'repo_default', `the repo's default (pa delivery)`];
    // A fallback never reaches an unattended level.
    else [delivery, ds, deliveryWhy] = [D.isDelivery(fallbackDelivery) && !D.unattended(fallbackDelivery) ? fallbackDelivery : D.FALLBACK, 'fallback', 'PA_DELIVERY_DEFAULT'];
  }
  source.delivery = ds;

  return {
    settings: { runtime, mode, delivery, jobKind, app: app ? app.app : appName, repo: repo || slug || null },
    source,
    why: { jobKind: kindWhy, delivery: deliveryWhy },
    phrase,
  };
}

/** Pure. What the page can pick from. */
function options(apps: FactoryApp[]) {
  return {
    runtimes: F.RUNTIMES,
    modes: Object.keys(MODES),
    deliveries: (D.DELIVERIES as string[]).map((d) => ({ value: d, plain: D.describe(d, { route: 'factory' }) })),
    jobKinds: F.KINDS,
    apps: apps.map((a) => ({ app: a.app, repo: a.repo || null, deliveryDefault: a.delivery?.default || null })),
  };
}

async function stored(commitmentId: number | string | null | undefined): Promise<Overrides> {
  if (!commitmentId) return {};
  const row = await require('../repo').system.setting(KEY(commitmentId)).catch(() => null);
  const v = row?.value;
  if (!v || typeof v !== 'object') return {};
  // Read back through the same check: a value that no longer validates is dropped, not trusted.
  const out: Overrides = {};
  for (const f of FIELDS) {
    try {
      const c = check(f, v[f]);
      if (c != null) out[f] = c;
    } catch {
      /* dropped */
    }
  }
  return out;
}

/**
 * The resolved settings for a commitment (or a bare task): `given` over the
 * card's overrides over the defaults, plus the facts behind them.
 */
async function effective({ commitmentId = null, task = null, given = {}, commitmentKind = undefined }: { commitmentId?: number | string | null; task?: string | null; given?: Overrides; commitmentKind?: string | null | undefined }) {
  const dispatch = require('./index.ts');
  const factory = require('./factory.ts');
  const { config } = require('../config.ts');
  const card = await stored(commitmentId);
  const repoGiven = given.repo ?? card.repo ?? null;
  const target = await dispatch.resolveTarget({ commitmentId, repoPath: repoGiven && !R.normSlug(repoGiven) ? repoGiven : null });
  const enabled: boolean = factory.enabled();
  const [apps, slug]: [FactoryApp[], string | null] = await Promise.all([
    enabled ? factory.apps({ stale: true }).catch(() => []) : [],
    require('./route.ts').slugFor(target).catch(() => null),
  ]);
  const repoSlug = R.normSlug(repoGiven) || slug;
  const repoDefault = repoSlug ? await require('./delivery.ts').defaultFor(repoSlug).catch(() => null) : null;
  const c = target.commitment;
  const r = resolve({
    given, stored: card, slug,
    text: task || [c?.summary, c?.detail].filter(Boolean).join('\n') || null,
    operatorText: task,
    // The planner's kind for the commitment (its own pass may not have stored it yet).
    commitmentKind: commitmentKind !== undefined ? commitmentKind : c?.kind || null, apps, repoDefault,
    fallbackDelivery: require('./delivery.ts').fallback(), configuredRuntime: config.factory.runtime, configuredMode: config.factory.mode,
  });
  return { ...r, overrides: card, factory: enabled, apps, target };
}

/** GET: a card's dispatch settings, where each came from, and the options. */
async function forCard(commitmentId: number | string) {
  const e = await effective({ commitmentId });
  if (!e.target.commitment) throw Object.assign(new Error(`no commitment #${commitmentId}`), { status: 404 });
  return { card: Number(commitmentId), factory: e.factory, settings: e.settings, source: e.source, why: e.why, overrides: e.overrides, options: options(e.apps) };
}

/** POST: store a card's overrides (null or '' clears one), then answer as GET. */
async function setForCard(commitmentId: number | string, patch: Json) {
  const p = checkPatch(patch);
  // An unknown card throws (404) before anything is stored.
  await require('./index.ts').resolveTarget({ commitmentId });
  const merged: Overrides = { ...(await stored(commitmentId)), ...p };
  for (const f of FIELDS) if (merged[f] == null) delete merged[f];
  await require('../repo').system.setSetting(KEY(commitmentId), merged);
  return forCard(commitmentId);
}

module.exports = { FIELDS, check, checkPatch, resolve, options, stored, effective, forCard, setForCard };
