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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type ResolveOptions = { explicit?: string | null; mode?: string | null; operatorText?: string | null; slug?: string | null };

const { config } = require('../config.ts');
const repo = require('../repo');
const D = require('./deliveryCore.ts');
const { normSlug } = require('./routeCore.ts');

function key(slug: unknown): string {
  const s: string | null = normSlug(slug);
  if (!s) throw new Error(`not a repo: "${slug}" — want owner/name`);
  return s;
}

async function defaultFor(slug: unknown): Promise<string | null> {
  const s: string | null = normSlug(slug);
  if (!s) return null;
  const r: Row | null = await repo.repos.deliveryOf(s).catch(() => null);
  return r && D.isDelivery(r.delivery) ? String(r.delivery) : null;
}

async function setDefault(slug: unknown, level: unknown): Promise<{ repo: string; delivery: string }> {
  const d: string = D.delivery(level);
  const s = key(slug);
  await repo.repos.setDelivery(s, d);
  return { repo: s, delivery: d };
}

async function clearDefault(slug: unknown): Promise<unknown> {
  return repo.repos.clearDelivery(key(slug));
}

async function list(): Promise<Row[]> {
  return repo.repos.deliveries();
}

function fallback(): string {
  const f = String(config.dispatch.deliveryDefault || '').trim();
  return D.isDelivery(f) ? f : D.FALLBACK;
}

// deliveryCore.choose's answer; delivery null is a `plan` mode (delivers nothing).
async function resolve({ explicit = null, mode = null, operatorText = null, slug = null }: ResolveOptions = {}): Promise<{ delivery: string | null; source: string; phrase: string | null }> {
  const repoDefault = explicit || mode ? null : await defaultFor(slug);
  return D.choose({ explicit, mode, operatorText, repoDefault, fallback: fallback() });
}

module.exports = { defaultFor, setDefault, clearDefault, list, resolve, fallback };
