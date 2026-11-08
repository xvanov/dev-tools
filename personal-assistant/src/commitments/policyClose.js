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
// source is unfolded, so a person's ask is never left hidden behind a closed
// session note. Both changes are written to an undo SQL file.

const fs = require('fs');
const path = require('path');
const { config } = require('../config.ts');
const repo = require('../repo');
const ledger = require('../ledger');
const policy = require('./sourcePolicy');
const identity = require('../distill/identity');

const ACTOR = 'reconciler';

/** Pure. Why a card counts as acted on by you, or null. */
function actedBy(c) {
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
function split(list, ctx) {
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
function bySource(list) {
  const out = {};
  for (const c of list) out[c.source] = (out[c.source] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function sqlStr(v) {
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
 * @returns {{close, keep, unfold, applied?: {closed, transitions, undoFile}}}
 */
async function run({ apply = false, now = new Date() } = {}) {
  const ctx = await context();
  const plan = split(await repo.commitments.policyCandidates(), ctx);
  const closeIds = plan.close.map((c) => Number(c.id));
  // Allowed-source copies folded under a card about to close: they come back.
  const unfold = closeIds.length
    ? (await repo.commitments.foldedUnder(closeIds)).filter((c) => policy.judge(c, ctx).ok)
    : [];
  const out = { ...plan, unfold, before: null, after: null };
  if (!apply) return out;

  const undo = [
    `-- pa policy close, ${now.toISOString()}: ${plan.close.length} dropped, ${unfold.length} unfolded.`,
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
    const unfolded = await repo.commitments.unfold(u.id, u.superseded_by);
    if (unfolded) undo.push(`update commitment set superseded_by = ${Number(u.superseded_by)} where id = ${Number(u.id)} and superseded_by is null;`);
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
        unfolded: unfold.map((u) => ({ id: Number(u.id), was: Number(u.superseded_by), source: u.source, summary: u.summary })),
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
function report(r, { apply = false } = {}) {
  const lines = [];
  const line = (c, extra = '') => `  #${c.id} ${c.direction === 'owed_to_me' ? '←' : '→'} ${String(c.summary).slice(0, 110)}${extra}`;
  lines.push(`${apply ? 'Closed' : 'Would close'} ${r.close.length} open card(s) the source policy would not have created:`);
  const groups = {};
  for (const c of r.close) (groups[c.source] = groups[c.source] || []).push(c);
  for (const [source, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    lines.push('', `${source} (${list.length})`);
    for (const c of list) lines.push(line(c, `  [${c.why}]`));
  }
  lines.push('', `Kept because you acted on them (${r.keep.length}):`);
  for (const c of r.keep) lines.push(line(c, `  [${c.source}; ${c.acted}]`));
  if (r.unfold.length) {
    lines.push('', `Unfolded — a person's ask that was folded under a closed card (${r.unfold.length}):`);
    for (const u of r.unfold) lines.push(`  #${u.id} (was under #${u.superseded_by}) ${String(u.summary).slice(0, 110)}`);
  }
  if (apply && r.applied) lines.push('', `${r.applied.closed} dropped through the ledger (actor ${ACTOR}); Reopen or \`pa ledger undo\` takes one back.`, `undo SQL: ${r.applied.undoFile}`);
  else lines.push('', 'Dry run — nothing changed. `pa policy close --apply` closes them.');
  return lines.join('\n');
}

module.exports = { run, split, actedBy, bySource, report, ACTOR };
