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

const { config } = require('../config.ts');
const D = require('./deliveryCore');
const F = require('./factoryCore');
const C = require('./composeCore');
const { logger } = require('../log.ts');

const log = logger('offer');

const PLAIN = (route) => Object.fromEntries(D.DELIVERIES.map((d) => [d, D.describe(d, { route })]));

/**
 * @param {object} o
 * @param {number} [o.commitmentId]
 * @param {string} [o.task]          the operator's own words (never a third party's)
 * @param {string} [o.via]           claude | factory | auto
 * @param {string} [o.mode]          an explicit legacy mode (plan = read-only research)
 * @param {string} [o.delivery]      an explicit end state
 * @param {string} [o.pipeline]      chain | solo | auto
 * @param {Array<string>} [o.models] persona=model
 * @param {Array<string>} [o.done]
 * @param {string} [o.app]
 * @param {string} [o.repoPath]
 * @param {string} [o.kind]          the planner's kind for the commitment
 * @param {boolean} [o.register]     register an unknown repo with the factory at accept
 * @param {boolean} [o.useModel]     compose with a model (false: the deterministic brief)
 * @param {string} [o.why]           a line for the card (the planner's brief)
 */
async function prepare({
  commitmentId = null, task = null, via = 'auto', mode = null, delivery = null, pipeline = null, models = null, done = null,
  app = null, repoPath = null, kind = undefined, register = false, useModel = true, why = null, suggestedBy = null,
  jobKind = null, runtime = null, title = null,
}) {
  const dispatch = require('./index');
  const route = require('./route');
  // A research or report job is a factory job (JOBS-API v1.2).
  const jk = F.jobKind(jobKind);
  const rt = runtime ? F.runtime(runtime) : null;
  if (jk !== 'code' && via && String(via).toLowerCase() === 'claude') throw new Error(`a ${jk} job is a factory job — drop --via claude`);
  if (jk !== 'code' || rt) via = 'factory';
  if (repoPath && !(jk !== 'code' && require('./routeCore').normSlug(repoPath))) await dispatch.knownRepo(repoPath);
  const target = await dispatch.resolveTarget({ commitmentId, repoPath });
  const label = title || task || target.commitment?.summary;
  if (!label) throw new Error('nothing to offer — give a commitment id or a --task');
  const v = require('./routeCore').via(via || require('./routeCore').defaultVia({ configured: config.factory.via, mode }));
  const plan = jk === 'code' && mode && String(mode).toLowerCase() === 'plan';
  // The factory as the default route: a repo it does not know yet is
  // registered on accept (the card says so) rather than refused — nothing
  // outward happens before the yes.
  if (!via && v === 'factory') register = true;

  if (jk !== 'code') return prepareResearch({ target, task, title: label, jobKind: jk, runtime: rt, done, app, why, suggestedBy });

  let choice;
  if (plan || v === 'claude') {
    choice = { route: 'claude', reason: plan ? 'plan mode is read-only; the factory only builds' : 'you chose a Claude session', app: null, done: done || [], slug: await route.slugFor(target).catch(() => null) };
  } else if (v === 'factory') {
    // Registration happens at accept, not here: nothing outward before the yes.
    try {
      choice = await route.forced({ target, mode: mode || undefined, done, app });
    } catch (err) {
      const slug = await route.slugFor(target).catch(() => null);
      if (!(register && slug && /not registered/.test(err.message))) throw err;
      choice = { route: 'factory', reason: `you chose the factory; ${slug} is registered with it on accept`, app: null, done: done || require('./routeCore').doneCriteria(target.commitment), slug, register: true };
    }
  } else {
    choice = await route.decide({ target, mode: mode || undefined, done, kind });
  }
  const viaFactory = choice.route === 'factory';

  const chosen = plan
    ? { delivery: null, source: null, phrase: null }
    : await require('./delivery').resolve({ explicit: delivery, mode: mode || null, operatorText: task, slug: choice.slug });

  const payload = {
    frozen: true,
    why: why ? C.clip(why, 500) : null,
    suggestedBy: suggestedBy ? C.clip(suggestedBy, 40) : null,
    via: choice.route,
    routeReason: choice.reason,
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
    deliveryPlain: PLAIN(choice.route),
    mode: plan ? 'plan' : viaFactory ? null : mode || D.modeFor(chosen.delivery),
  };

  if (viaFactory) {
    const pipe = F.pipeline(pipeline || config.factory.pipeline);
    const overrides = require('./factory').modelsFor(models);
    payload.jobKind = 'code';
    payload.runtime = rt || F.runtime(config.factory.runtime);
    const c = await require('./compose').compose({
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
  }

  const cardTitle = (viaFactory
    ? `Send to the factory: ${label}`
    : `Start a ${plan ? 'research' : 'coding'} session on: ${label}`).slice(0, 280);
  const body = cardBody({ payload, label, why, target });
  return { title: cardTitle, body, payload, target };
}

/**
 * A research or report job's card: the operator's words as the ask
 * (factoryCore.researchAsk — no composing model), end state none, the repo if
 * the factory knows it. Frozen like any offer: accept sends exactly this.
 */
async function prepareResearch({ target, task, title, jobKind, runtime, done, app, why, suggestedBy }) {
  const route = require('./route');
  const choice = await route.forced({ target, done, app, jobKind });
  const rt = runtime || F.runtime(config.factory.runtime);
  const criteria = choice.done || [];
  const brief = F.researchAsk({ kind: jobKind, title, ask: task || target.commitment?.detail || target.commitment?.summary, done: criteria, repo: choice.slug });
  const payload = {
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
  const verb = jobKind === 'report' ? 'Write a report' : 'Research';
  return { title: `${verb} in the factory: ${title}`.slice(0, 280), body: cardBody({ payload, label: title, why, target }), payload, target };
}

/** The card's text: the end state first, in plain words. */
function cardBody({ payload: p, label, why, target }) {
  const L = [];
  if (p.suggestedBy) L.push(`Suggested by ${p.suggestedBy} — check the end state before you accept.`, '');
  // The planner's note is model text: one line, labelled, so it can never pose
  // as the card's own "End state:" line.
  if (why) L.push(`Planner's note: ${C.clip(why, 500)}`, '');
  if (p.jobKind && p.jobKind !== 'code') {
    L.push(`End state: a ${p.jobKind === 'report' ? 'written report' : 'research report'} the factory keeps — no code changes, no branch, no PR.`);
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
function briefAt(payload, delivery) {
  if (!payload?.composed) return payload?.brief || null;
  if (delivery === payload.delivery && payload.brief) return payload.brief;
  return C.render(payload.composed, { ...payload.briefMeta, delivery, deliveryPlain: D.describe(delivery) });
}

async function propose(o) {
  const { title, body, payload, target } = await prepare(o);
  const row = await require('../proposals').create({
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
