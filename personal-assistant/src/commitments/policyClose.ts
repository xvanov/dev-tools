'use strict';

// Closing the cards the source policy would not have created
// (src/commitments/sourcePolicy.js) — the board as it would be had the rule
// always held. `pa policy close` (dry run) / `pa policy close --apply`.
//
// Every open, unfolded commitment whose item fails sourcePolicy.judge is
// dropped through the ledger (actor `reconciler`, reason "not from a person —
// source policy: …"), so it shows under Closed recently with Reopen and
// `pa ledger undo` takes it back. A card you acted on — a run, a draft, your
// own edit (touched_at) or a status change you made — is kept and listed
// instead: that is your decision, not the policy's to undo.
//
// A folded copy (superseded_by) of a closed card that comes from an allowed
// source is moved, so a person's ask is never left hidden behind a closed
// session note: up to the closed card's survivor, or the oldest copy unfolds
// and the others fold under it (regroup). Both changes are written to an
// undo SQL file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const path = require('path');
const { config } = require('../config.ts');
const repo = require('../repo');
const ledger = require('../ledger');
const policy = require('./sourcePolicy.ts');
const identity = require('../distill/identity.ts');
const teamsThreads = require('../ingest/teamsThreads.ts');

const ACTOR = 'reconciler';

/** Pure. Why a card counts as acted on by you, or null. */
function actedBy(c: any) {
  const why = [];
  if (c.has_run) why.push('run');
  if (c.has_draft) why.push('draft');
  if (c.touched) why.push('your edit');
  if (c.you_moved) why.push('your status change');
  return why.length ? why.join(', ') : null;
}

/**
 * Pure. Splits open cards into {close, keep} by the policy.
 * @param list  rows of repo.commitments.policyCandidates()
 * @param ctx   sourcePolicy.judge's options (sources, login, me)
 */
function split(list: any[], ctx: any) {
  const close = [];
  const keep = [];
  for (const c of list) {
    const v = policy.judge(c, ctx);
    if (v.ok) continue;
    const acted = actedBy(c);
    if (acted) keep.push({ ...c, why: v.why, acted });
    else close.push({ ...c, why: v.why });
  }
  return { close, keep };
}

/** Pure. {source: count} for a list. */
function bySource(list: any[]) {
  const out: Record<string, any> = {};
  for (const c of list) out[c.source] = (out[c.source] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function sqlStr(v: any) {
  return v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
}

async function context() {
  const me = await identity.me();
  return {
    sources: policy.allowedSources(),
    login: await identity.myHandle('github_username'),
    me: { name: me?.display_name, email: me?.primary_email },
  };
}

/**
 * Pure. Where each allowed copy folded under a closing card goes: `to` a card
 * id, or null to unfold. The dedupe pass folded them as one piece of work, so
 * they stay together: under the closing card's own survivor when it is
 * folded and that survivor stays open; otherwise the oldest of them unfolds
 * and the rest fold under it.
 * @param children rows of foldedUnder (id, superseded_by, …), none of them closing
 * @param closing  the cards about to close (id, superseded_by)
 */
function regroup(children: any[], closing: any[]) {
  const parentOf = new Map(closing.map((c) => [Number(c.id), c.superseded_by == null ? null : Number(c.superseded_by)]));
  // The first open ancestor above a closing card, or the closing root itself.
  const anchor = (id: number) => {
    const seen = new Set<number>();
    let cur = id;
    while (parentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const up = parentOf.get(cur);
      if (up == null) return { root: cur };
      cur = up;
    }
    return { open: cur };
  };
  const groups = new Map<string, any[]>();
  for (const c of children) {
    const a = anchor(Number(c.superseded_by));
    const key = a.open != null ? `open:${a.open}` : `root:${a.root}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const out: any[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id));
    if (key.startsWith('open:')) {
      const to = Number(key.slice(5));
      for (const c of sorted) out.push({ ...c, to });
    } else {
      const lead = Number(sorted[0].id);
      sorted.forEach((c, i) => out.push({ ...c, to: i === 0 ? null : lead }));
    }
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Pure. Only the cards the Teams rule closes (`--teams`): the cache's system threads and local copies. */
function teamsOnly(plan: { close: any[]; keep: any[] }) {
  const teams = (c: any) => Boolean(teamsThreads.junkOf(c)) && c.source === 'graph_chat';
  return { close: plan.close.filter(teams), keep: plan.keep.filter(teams) };
}

/** Pure. {why: count} for a list, most first: the counts a cleanup reports. */
function byWhy(list: any[]) {
  const out: Record<string, number> = {};
  for (const c of list) out[c.why] = (out[c.why] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/**
 * Idempotent: it reads open cards only, so a second run finds nothing to do.
 * `teams`: only the cards the Teams rule closes (8.4.34, 8.4.35), folded
 * copies included: a local copy is usually folded under the real message's
 * card, and is still an open row.
 * @returns {{close, keep, unfold, applied?: {closed, transitions, undoFile}}}
 */
async function run({ apply = false, teams = false, now = new Date() }: { apply?: boolean; teams?: boolean; now?: any } = {}) {
  const ctx = await context();
  const all = split(await repo.commitments.policyCandidates({ folded: teams }), ctx);
  const plan = teams ? teamsOnly(all) : all;
  const closeIds = plan.close.map((c) => Number(c.id));
  // Allowed-source copies folded under a card about to close come back,
  // still grouped (regroup).
  const children = closeIds.length
    ? (await repo.commitments.foldedUnder(closeIds)).filter((c: any) => policy.judge(c, ctx).ok && !closeIds.includes(Number(c.id)))
    : [];
  const unfold = regroup(children, plan.close);
  const out: any = { ...plan, unfold, before: null, after: null };
  if (!apply) return out;

  const undo = [
    `-- pa policy close, ${now.toISOString()}: ${plan.close.length} dropped, ${unfold.length} regrouped.`,
    '-- Run in one transaction. Each statement only changes a row still as this pass left it.',
    'begin;',
  ];
  let closed = 0;
  for (const c of plan.close) {
    const reason = `not from a person — source policy: ${c.why}`;
    const r = await ledger.transition({ commitmentId: c.id, to: 'dropped', actor: ACTOR, reason, from: ['open'], now });
    if (!r.changed) continue;
    closed++;
    undo.push(
      `update commitment set status = 'open', closed_at = null, closed_reason = null where id = ${Number(c.id)} and status = 'dropped' and closed_reason = ${sqlStr(reason)};`,
      `update ledger_transition set undone_at = now(), undo = 'undone (policy close undo file)' where id = ${r.transitionId} and undone_at is null;`
    );
  }
  for (const u of unfold) {
    const moved = u.to == null ? await repo.commitments.unfold(u.id, u.superseded_by) : await repo.commitments.refold(u.id, u.superseded_by, u.to);
    if (moved) undo.push(`update commitment set superseded_by = ${Number(u.superseded_by)} where id = ${Number(u.id)} and superseded_by ${u.to == null ? 'is null' : `= ${Number(u.to)}`};`);
  }
  undo.push('commit;', '');
  const dir = path.join(config.dataDir, 'fixes');
  fs.mkdirSync(dir, { recursive: true });
  const undoFile = path.join(dir, `commitment-source-policy-${now.toISOString().replace(/[:.]/g, '-')}.undo.sql`);
  fs.writeFileSync(undoFile, undo.join('\n'), 'utf8');
  fs.writeFileSync(
    undoFile.replace(/\.undo\.sql$/, '.json'),
    JSON.stringify(
      {
        at: now.toISOString(),
        closed: plan.close.map((c) => ({ id: Number(c.id), source: c.source, summary: c.summary, why: c.why })),
        kept: plan.keep.map((c) => ({ id: Number(c.id), source: c.source, summary: c.summary, why: c.why, acted: c.acted })),
        unfolded: unfold.map((u: any) => ({ id: Number(u.id), was: Number(u.superseded_by), now: u.to == null ? null : Number(u.to), source: u.source, summary: u.summary })),
      },
      null,
      2
    ),
    'utf8'
  );
  out.applied = { closed, undoFile };
  return out;
}

/** Pure. The report `pa policy close` prints. */
function report(r: any, { apply = false, teams = false }: { apply?: boolean; teams?: boolean } = {}) {
  const lines = [];
  const line = (c: any, extra: string = '') => `  #${c.id} ${c.direction === 'owed_to_me' ? '←' : '→'} ${String(c.summary).slice(0, 110)}${extra}`;
  lines.push(`${apply ? 'Closed' : 'Would close'} ${r.close.length} open card(s) the source policy would not have created${teams ? ' (Teams cache only)' : ''}:`);
  for (const [why, n] of Object.entries(byWhy(r.close))) lines.push(`  ${n}  ${why}`);
  const hidden = r.close.filter((c: any) => c.superseded_by != null).length;
  if (hidden) lines.push(`  (${hidden} of them folded under another card, so not on the board)`);
  const groups: Record<string, any[]> = {};
  for (const c of r.close) (groups[c.source] = groups[c.source] || []).push(c);
  for (const [source, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    lines.push('', `${source} (${list.length})`);
    for (const c of list) lines.push(line(c, `  [${c.why}]`));
  }
  lines.push('', `Kept because you acted on them (${r.keep.length}):`);
  for (const c of r.keep) lines.push(line(c, `  [${c.source}; ${c.acted}]`));
  if (r.unfold.length) {
    const up = r.unfold.filter((u: any) => u.to == null).length;
    lines.push('', `Regrouped — a person's ask that was folded under a closed card (${r.unfold.length}: ${up} back on the board, ${r.unfold.length - up} folded under another):`);
    for (const u of r.unfold) lines.push(`  #${u.id} (was under #${u.superseded_by}) ${u.to == null ? 'unfolded' : `under #${u.to}`} ${String(u.summary).slice(0, 110)}`);
  }
  if (apply && r.applied) lines.push('', `${r.applied.closed} dropped through the ledger (actor ${ACTOR}); Reopen or \`pa ledger undo\` takes one back.`, `undo SQL: ${r.applied.undoFile}`);
  else lines.push('', `Dry run — nothing changed. \`pa policy close${teams ? ' --teams' : ''} --apply\` closes them.`);
  return lines.join('\n');
}

module.exports = { run, split, actedBy, bySource, byWhy, teamsOnly, regroup, report, ACTOR };
