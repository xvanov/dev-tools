'use strict';

// A dispatch offer: everything a "start this?" card shows, decided once and
// frozen into the proposal, so that accepting it runs exactly what was shown.
//
//   prepare(o)  → {title, body, payload}   decide route, app, delivery,
//                                           pipeline, models, done-criteria,
//                                           and compose the brief
//   propose(o)  → the proposal row          prepare + proposals.create
//
// Used by the planner (an offer from an ask it read) and by `pa propose` (the
// PA chat putting work on a card instead of starting it). What the card shows
// is what is sent: at accept, src/proposals runs dispatch.start with
// `frozen: true` and these values — nothing is re-chosen, re-derived or
// recomposed then (the done-criteria a model distilled from someone's message
// are on the card, not invented after the yes). The one thing the operator
// may change at accept is the delivery, and the brief is re-rendered
// (deterministically, from the same composed content) for the level picked.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/** A dispatch target (dispatch.resolveTarget): store rows, read column by column. */
type Target = Json;
/** The frozen offer: stored as the proposal's JSON payload, read back at accept. */
type Payload = Json;
type Offer = { title: string; body: string; payload: Payload; target: Target };
type PrepareOptions = {
  commitmentId?: number | string | null;
  /** the operator's own words (never a third party's) */
  task?: string | null;
  /** gone (D28): only `factory` (or `auto`) is accepted */
  via?: string | null;
  /** an explicit mode (plan = a read-only plan job) */
  mode?: string | null;
  /** an explicit end state */
  delivery?: string | null;
  /** chain | solo | auto */
  pipeline?: string | null;
  /** persona=model */
  models?: string[] | null;
  done?: string[] | null;
  app?: string | null;
  repoPath?: string | null;
  /** the planner's kind for the commitment */
  kind?: string | null | undefined;
  /** unused since D28: an unknown repo is always registered at accept */
  register?: boolean;
  /** compose with a model (false: the deterministic brief) */
  useModel?: boolean;
  /** a line for the card (the planner's brief) */
  why?: string | null;
  suggestedBy?: string | null;
  jobKind?: string | null;
  runtime?: string | null;
  title?: string | null;
};

const { config } = require('../config.ts');
const D = require('./deliveryCore.ts');
const F = require('./factoryCore.ts');
const C = require('./composeCore.ts');
const { logger } = require('../log.ts');

const log = logger('offer');

const PLAIN = (route: string): Record<string, string> => Object.fromEntries((D.DELIVERIES as string[]).map((d) => [d, D.describe(d, { route })]));

async function prepare({
  commitmentId = null, task = null, via = 'auto', mode = null, delivery = null, pipeline = null, models = null, done = null,
  app = null, repoPath = null, kind = undefined, register = false, useModel = true, why = null, suggestedBy = null,
  jobKind = null, runtime = null, title = null,
}: PrepareOptions): Promise<Offer> {
  const dispatch = require('./index.ts');
  const route = require('./route.ts');
  // Every offer is a factory job (decision D28): no route to pick.
  if (via && !['factory', 'auto'].includes(String(via).toLowerCase())) {
    throw new Error(`there is no route to pick: every dispatch is a software-factory job — drop --via ${via}`);
  }
  const given = {
    jobKind: jobKind ? F.jobKind(jobKind) : null,
    runtime: runtime ? F.runtime(runtime) : null,
    mode: mode ? require('./modes.ts').mode(mode).name : null,
    delivery: delivery ? D.delivery(delivery) : null,
    app: app || null,
    repo: repoPath || null,
  };
  // The card's kind, runtime and end state: what was asked, else the card's
  // dispatch settings, else the defaults (src/dispatch/settings.ts).
  const eff = await require('./settings.ts').effective({ commitmentId, task, given, commitmentKind: kind });
  const jk: string = eff.settings.jobKind;
  const rt: string = eff.settings.runtime;
  if (repoPath && !(jk !== 'code' && require('./routeCore.ts').normSlug(repoPath))) await dispatch.knownRepo(repoPath);
  const target: Target = await dispatch.resolveTarget({ commitmentId, repoPath });
  const label: string | null | undefined = title || task || target.commitment?.summary;
  if (!label) throw new Error('nothing to offer — give a commitment id or a --task');

  if (jk !== 'code') return prepareResearch({ target, task, title: label, jobKind: jk, runtime: rt, done, app, why, suggestedBy });

  // The factory app, or — a repo the factory does not know yet — registered on
  // accept (the card says so): nothing outward happens before the yes.
  let choice: Json;
  try {
    choice = await route.forced({ target, mode: eff.settings.mode, done, app: eff.settings.app });
  } catch (err) {
    const slug = await route.slugFor(target).catch(() => null);
    if (!(slug && /not registered/.test((err as Error).message))) throw err;
    choice = { route: 'factory', reason: `${slug} is registered with the factory on accept`, app: null, done: done || require('./routeCore.ts').doneCriteria(target.commitment), slug, register: true };
  }

  const chosen = {
    delivery: eff.settings.delivery,
    source: eff.source.delivery === 'given' ? 'explicit' : eff.source.delivery,
    phrase: eff.phrase,
  };

  const payload: Payload = {
    frozen: true,
    why: why ? C.clip(why, 500) : null,
    suggestedBy: suggestedBy ? C.clip(suggestedBy, 40) : null,
    via: 'factory',
    routeReason: `${choice.reason} (code: ${eff.why.jobKind})`,
    task: task || null,
    repoPath: target.repoPath || null,
    // `--repo` passed the known-project check now; accept trusts this (sql/026 note in AGENT.md).
    // Checked now: a `--repo` against the known projects (above), or the
    // commitment's own project. Accept trusts this instead of re-judging.
    repoVerifiedAt: target.repoPath ? new Date().toISOString() : null,
    slug: choice.slug || null,
    delivery: chosen.delivery,
    deliverySource: chosen.source,
    deliveryPhrase: chosen.phrase,
    deliveryPlain: PLAIN('factory'),
    mode: eff.settings.mode,
  };

  const pipe = F.pipeline(pipeline || config.factory.pipeline);
  const overrides = require('./factory.ts').modelsFor(models);
  payload.jobKind = 'code';
  payload.runtime = rt;
  const c = await require('./compose.ts').compose({
    target, task, done: choice.done || [], app: choice.app, slug: choice.slug, appPath: choice.appPath || null,
    delivery: chosen.delivery, pipeline: pipe, useModel,
  });
  Object.assign(payload, {
    app: choice.app,
    register: Boolean(choice.register),
    pipeline: pipe,
    models: overrides,
    done: c.done,
    composed: c.composed,
    briefMeta: { title: label, app: choice.app, slug: choice.slug, pipeline: pipe, by: c.by },
    brief: c.brief,
    briefBy: c.by,
  });

  const cardTitle = `Send to the factory: ${label}`.slice(0, 280);
  const body = cardBody({ payload, label: label as string, why, target });
  return { title: cardTitle, body, payload, target };
}

/**
 * A research or report job's card: the operator's words as the ask
 * (factoryCore.researchAsk — no composing model), end state none, the repo if
 * the factory knows it. Frozen like any offer: accept sends exactly this.
 */
async function prepareResearch({
  target,
  task,
  title,
  jobKind,
  runtime,
  done,
  app,
  why,
  suggestedBy,
}: {
  target: Target;
  task: string | null;
  title: string;
  jobKind: string;
  runtime: string | null;
  done: string[] | null;
  app: string | null;
  why: string | null;
  suggestedBy: string | null;
}): Promise<Offer> {
  const route = require('./route.ts');
  const choice = await route.forced({ target, done, app, jobKind });
  const rt = runtime || F.defaultRuntime(jobKind, config.factory.runtime);
  const criteria: string[] = choice.done || [];
  const brief = F.researchAsk({ kind: jobKind, title, ask: task || target.commitment?.detail || target.commitment?.summary, done: criteria, repo: choice.slug });
  const payload: Payload = {
    frozen: true,
    why: why ? C.clip(why, 500) : null,
    suggestedBy: suggestedBy ? C.clip(suggestedBy, 40) : null,
    via: 'factory',
    routeReason: choice.reason,
    jobKind,
    runtime: rt,
    title,
    task: task || null,
    repoPath: target.repoPath || null,
    repoVerifiedAt: target.repoPath ? new Date().toISOString() : null,
    slug: choice.slug || null,
    delivery: 'none',
    deliverySource: 'kind',
    deliveryPhrase: null,
    deliveryPlain: PLAIN('factory'),
    mode: null,
    app: choice.app || null,
    register: false,
    pipeline: F.pipeline(config.factory.pipeline),
    models: {},
    done: criteria,
    brief,
    briefBy: 'research:operator',
  };
  const verb = jobKind === 'report' ? 'Write a report' : jobKind === 'plan' ? 'Plan' : 'Research';
  return { title: `${verb} in the factory: ${title}`.slice(0, 280), body: cardBody({ payload, label: title, why, target }), payload, target };
}

/** The card's text: the end state first, in plain words. */
function cardBody({ payload: p, label, why, target }: { payload: Payload; label: string; why?: string | null; target?: Target | null }): string {
  const L: string[] = [];
  if (p.suggestedBy) L.push(`Suggested by ${p.suggestedBy} — check the end state before you accept.`, '');
  // The planner's note is model text: one line, labelled, so it can never pose
  // as the card's own "End state:" line.
  if (why) L.push(`Planner's note: ${C.clip(why, 500)}`, '');
  if (p.jobKind && p.jobKind !== 'code') {
    L.push(`End state: a ${p.jobKind === 'report' ? 'written report' : p.jobKind === 'plan' ? 'plan (read-only)' : 'research report'} the factory keeps — no code changes, no branch, no PR.`);
    L.push(`Route: software factory, ${p.jobKind} job on ${p.runtime === 'claude_session' ? 'a Claude session (subscription)' : 'API models (metered)'}${p.app ? `, reading ${p.slug || p.app}` : p.slug ? ` (${p.slug} is not registered: named in the ask only)` : ', no repo'}`);
    if (p.done.length) {
      L.push(`${p.jobKind === 'report' ? 'It must cover' : 'Questions'}:`);
      for (const d of p.done) L.push(`  - ${d}`);
    }
    L.push(`Why this route: ${p.routeReason}`);
    return L.join('\n');
  }
  if (p.delivery) {
    L.push(`End state: ${p.delivery} — ${p.deliveryPlain[p.delivery]}${D.unattended(p.delivery) ? ' (NO HUMAN STEP AFTER YOUR YES)' : ''}`);
    L.push(`  (${D.sourceLine(p.deliverySource, p.deliveryPhrase, p.slug)})`);
  } else {
    L.push('End state: none — read-only research; it writes up findings and changes nothing.');
  }
  if (p.via === 'factory') {
    L.push(`Route: software factory, app ${p.app || `(${p.slug}, registered on accept)`}, pipeline ${p.pipeline}${Object.keys(p.models || {}).length ? `, models ${Object.entries(p.models).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}${p.runtime ? `, runtime ${p.runtime === 'claude_session' ? 'Claude session (subscription)' : 'API models'}` : ''}`);
    L.push(`Done when:${p.done.length ? '' : ' (no criteria — the factory is held to the goal only)'}`);
    for (const d of p.done) L.push(`  - ${d}`);
  } else {
    L.push(`Route: Claude session (mode ${p.mode})${target?.project?.name ? ` in ${target.project.name}` : ''}`);
  }
  L.push(`Why this route: ${p.routeReason}`);
  return L.join('\n');
}

/**
 * The brief for a frozen offer at a (possibly changed) delivery level. Pure:
 * the same composed content, re-rendered — never recomposed after the card.
 */
function briefAt(payload: Payload | null | undefined, delivery: string | null): string | null {
  if (!payload?.composed) return payload?.brief || null;
  if (delivery === payload.delivery && payload.brief) return payload.brief;
  return C.render(payload.composed, { ...payload.briefMeta, delivery, deliveryPlain: D.describe(delivery) });
}

async function propose(o: PrepareOptions & { dedupeKey?: string | null; expiresAt?: Date | null }): Promise<Json | null> {
  const { title, body, payload, target } = await prepare(o);
  const row: Json | null = await require('../proposals').create({
    kind: 'dispatch',
    commitmentId: target.commitment ? Number(target.commitment.id) : null,
    title,
    body,
    payload,
    dedupeKey: o.dedupeKey || null,
    expiresAt: o.expiresAt || new Date(Date.now() + 5 * 86400_000),
  });
  if (row) log.info('offered', { proposal: Number(row.id), via: payload.via, delivery: payload.delivery, app: payload.app || null });
  return row ? { ...row, payload } : null;
}

module.exports = { prepare, propose, briefAt, cardBody };
