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

const { config } = require('../config');
const { one, rows, query } = require('../db');
const D = require('./deliveryCore');
const { normSlug } = require('./routeCore');

function key(slug) {
  const s = normSlug(slug);
  if (!s) throw new Error(`not a repo: "${slug}" — want owner/name`);
  return s;
}

async function defaultFor(slug) {
  const s = normSlug(slug);
  if (!s) return null;
  const r = await one('select delivery from repo_delivery where repo = $1', [s]).catch(() => null);
  return r && D.isDelivery(r.delivery) ? r.delivery : null;
}

async function setDefault(slug, level) {
  const d = D.delivery(level);
  const s = key(slug);
  await query(
    `insert into repo_delivery (repo, delivery) values ($1, $2)
     on conflict (repo) do update set delivery = excluded.delivery, updated_at = now()`,
    [s, d]
  );
  return { repo: s, delivery: d };
}

async function clearDefault(slug) {
  const r = await query('delete from repo_delivery where repo = $1', [key(slug)]);
  return (r.rowCount || 0) > 0;
}

async function list() {
  return rows('select repo, delivery, updated_at from repo_delivery order by repo');
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
