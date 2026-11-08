'use strict';

// What each repo is, in a few fields, written by the cheap pass model from
// the repo's own material (README, manifests, top-level files) and raven's
// description when raven has one. Several repos per call; a repo is profiled
// again only when its material hash changes, so the hourly sync makes no
// model call at all on a quiet day.
//
// raven's text, when present, is the description shown — it is reviewed
// and authoritative. The model then only fills kind, stack, owner and related
// repos around it.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const { config } = require('../config.ts');
const llm = require('../llm.ts');
const { logger } = require('../log.ts');

const log = logger('repos');

const SYSTEM =
  'You catalogue software repositories for one engineer. For each repo you are given its name, forge path, ' +
  'an authoritative description when one exists, the head of its README, its manifests and top-level files. ' +
  'Answer with a JSON array, one object per repo, in the order given: ' +
  '{"key": <the key given>, "description": <one or two plain sentences: what it is and what it is for; ' +
  'null if the material says nothing>, "kind": one of "product","service","library","infra","tool","docs","experiment","fork","personal", ' +
  '"stack": [up to 6 main languages/frameworks], "owner": <team or org that owns it if the material says so, else null>, ' +
  '"related": [names of other repos it names as depending on or feeding, up to 5]}. ' +
  'Use only what the material says; never guess an owner. No prose outside the JSON.';

function block(r: any) {
  const m = r.material || {};
  return [
    `key: ${r.key}`,
    `name: ${r.name}${r.fullName ? ` (${r.fullName})` : ''}`,
    r.raven ? `authoritative description: ${r.raven}` : null,
    r.forgeDescription ? `forge description: ${r.forgeDescription}` : null,
    m.manifests?.length ? `manifests:\n${m.manifests.join('\n')}` : null,
    m.top?.length ? `top-level: ${m.top.join(', ')}` : null,
    m.readme ? `README (head):\n${m.readme.slice(0, 2500)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {Array} batch [{key, name, fullName, raven, forgeDescription, material}]
 * @returns {Promise<Map<string, object>>} key → {description, kind, stack, owner, related}
 */
async function profileBatch(batch: any) {
  const prompt = batch.map((r: any, i: any) => `--- repo ${i + 1} ---\n${block(r)}`).join('\n\n');
  const text = await llm.complete({
    system: SYSTEM,
    prompt,
    model: config.repos.profileModel,
    purpose: 'repo-profile',
    effort: 'low',
    maxTokens: 300 * batch.length + 200,
    timeoutMs: 120_000,
  });
  const out = new Map<any, any>();
  let parsed;
  try {
    parsed = llm.extractJson(text);
  } catch (err: any) {
    log.warn('repo profile reply unreadable', { message: err.message });
    return out;
  }
  for (const p of Array.isArray(parsed) ? parsed : []) {
    if (!p || p.key == null) continue;
    out.set(String(p.key), {
      description: typeof p.description === 'string' && p.description.trim() ? p.description.trim().slice(0, 600) : null,
      kind: typeof p.kind === 'string' ? p.kind : null,
      stack: Array.isArray(p.stack) ? p.stack.map(String).slice(0, 6) : [],
      owner: typeof p.owner === 'string' && p.owner.trim() ? p.owner.trim() : null,
      related: Array.isArray(p.related) ? p.related.map(String).slice(0, 5) : [],
    });
  }
  return out;
}

/** Runs the batches; a failed batch is logged and skipped, not fatal. */
async function profileAll(list: any, { batchSize = 6 }: { batchSize?: number } = {}) {
  const out = new Map<any, any>();
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    try {
      for (const [k, v] of await profileBatch(batch)) out.set(k, v);
    } catch (err: any) {
      log.warn('repo profile batch failed', { message: String(err.message).slice(0, 200), repos: batch.map((b: any) => b.name) });
    }
  }
  return out;
}

module.exports = { profileAll, profileBatch, block };
