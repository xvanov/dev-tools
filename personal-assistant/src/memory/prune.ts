'use strict';

// `pa memory prune`: retracts the claims read from items ME was never part
// of — what the claims pass read before it applied relevance.ts (a
// teammate's PR that arrived through a team review request, a channel thread
// that never named ME).
//
// A dry run by default: `audit` only reads. `apply` retracts, as `forget`
// does — status 'retracted', nothing deleted (memory supersedes, it does not
// delete) — every claim of those items, superseded ones included, and then
// hands belief back to any claim from an item ME *is* in that one of them had
// superseded. Pages left with nothing active are removed; the rest are
// rewritten by the hourly pages pass, whose hash the retraction moved.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;

const repo = require('../repo');
const relevance = require('./relevance.ts');
const extract = require('./extract.ts');

const CHUNK = 500;

/** What `apply` would retract: {items, skipped: [{item, why}], claims}. Reads only. */
async function audit() {
  const who = relevance.meFrom(await repo.people.myIdentities());
  if (!who.login && who.authors.size <= 1) throw new Error('no identities for you yet (sign in to a source first): nothing can be judged');
  const items = await repo.memory.itemsBehindClaims();
  const { skip } = await extract.involvedOnly(items, who);
  const claims: Row[] = [];
  for (let i = 0; i < skip.length; i += CHUNK) {
    claims.push(...(await repo.memory.claimsOfItems(skip.slice(i, i + CHUNK).map((s: Row) => s.item.id))));
  }
  return { login: who.login, items: items.length, skipped: skip, claims };
}

/** Retracts `claims` (from audit) and settles what they fed. */
async function apply(claims: Row[]) {
  const ids = claims.map((c) => Number(c.id));
  // Retract all first: a restore must not hand belief back to a claim that is
  // itself on the list.
  for (let i = 0; i < ids.length; i += CHUNK) await repo.memory.retractClaims(ids.slice(i, i + CHUNK));
  let restored = 0;
  for (let i = 0; i < ids.length; i += CHUNK) restored += Number(await repo.memory.restoreSuperseded(ids.slice(i, i + CHUNK))) || 0;

  const subjects = new Map<string, Row>();
  for (const c of claims) {
    if (!['person', 'project'].includes(c.subject_kind) || c.subject_id == null) continue;
    subjects.set(`${c.subject_kind}:${c.subject_id}`, { kind: c.subject_kind, id: c.subject_id, label: c.subject_label });
  }
  let pagesRemoved = 0;
  for (const s of subjects.values()) {
    const left = await repo.memory.claimsFor(s, { limit: 1 });
    if (left.length) continue;
    await repo.memory.deletePage(s.kind, s.id);
    pagesRemoved++;
  }
  await require('./pages.ts').indexPage().catch(() => {});
  return { retracted: ids.length, restored, pagesRemoved };
}

module.exports = { audit, apply };
