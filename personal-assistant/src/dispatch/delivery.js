'use strict';

// Per-repo delivery defaults (sql/025), and resolving a piece of work's
// delivery level with them. The rules are deliveryCore.choose; this file only
// reads the store.
//
//   defaultFor(slug)          the repo's default, or null
//   setDefault(slug, level)   `pa delivery set owner/name <level>`
//   clearDefault(slug)
//   list()
//   resolve({explicit, mode, operatorText, slug})  → {delivery, source, phrase}

const { config } = require('../config.ts');
const repo = require('../repo');
const D = require('./deliveryCore.ts');
const { normSlug } = require('./routeCore.ts');

function key(slug) {
  const s = normSlug(slug);
  if (!s) throw new Error(`not a repo: "${slug}" — want owner/name`);
  return s;
}

async function defaultFor(slug) {
  const s = normSlug(slug);
  if (!s) return null;
  const r = await repo.repos.deliveryOf(s).catch(() => null);
  return r && D.isDelivery(r.delivery) ? r.delivery : null;
}

async function setDefault(slug, level) {
  const d = D.delivery(level);
  const s = key(slug);
  await repo.repos.setDelivery(s, d);
  return { repo: s, delivery: d };
}

async function clearDefault(slug) {
  return repo.repos.clearDelivery(key(slug));
}

async function list() {
  return repo.repos.deliveries();
}

function fallback() {
  const f = String(config.dispatch.deliveryDefault || '').trim();
  return D.isDelivery(f) ? f : D.FALLBACK;
}

async function resolve({ explicit = null, mode = null, operatorText = null, slug = null } = {}) {
  const repoDefault = explicit || mode ? null : await defaultFor(slug);
  return D.choose({ explicit, mode, operatorText, repoDefault, fallback: fallback() });
}

module.exports = { defaultFor, setDefault, clearDefault, list, resolve, fallback };
