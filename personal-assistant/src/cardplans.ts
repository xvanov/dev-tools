'use strict';

// A card plan: several card changes (edit, close, create) proposed as ONE set
// and approved once, so "read Drew's plan, then update our cards" is one yes
// the user can trim, not a prompt per card.
//
//   propose({title, rationale, sources, items})   validate and store; changes no card
//   show(id) / list()                             the plan with each item as one readable line
//   apply(id, {skip, actor})                      run the enabled items in order; per-item results
//   discard(id)                                   drop it; nothing changes
//
// The chat's `card_plan_propose` (a read tool: it only stores), `card_plan_apply`
// (an action tool: asks once for the whole set), `pa cardplan` and the
// dashboard's "Proposed card changes" card all call these.
//
// Item numbers (`n`, `skip`) are 1-based as shown to the user; storage idx is 0-based.
// An item runs as the user's own change (actor 'you': the approval is theirs),
// through the same functions as the single-card paths: editCard, the ledger's
// close (as `pa done --dismiss` does, duplicates of the card included) and
// request.add (`pa task add`). A failing item is recorded and the rest go on;
// an applied item is never run again.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('./repo/types.ts').Row;

const repo = require('./repo');

const MAX_ITEMS = 60;
const OPS = ['edit', 'close', 'create'] as const;
const clip = (v: unknown, n: number) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
const parseJson = (s: unknown): Row => { try { return s ? JSON.parse(String(s)) : {}; } catch { return {}; } };

/** `412`, `#412` or `c412` as a number; null when it is not a card id. */
function cardId(v: unknown): number | null {
  const m = /^[#c]?(\d{1,12})$/i.exec(String(v ?? '').trim());
  return m ? Number(m[1]) : null;
}

const dueLabel = (at: Date) => at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** Reads `due` the way editCard and `pa task add` do; null for "no date" (clear), throws on nonsense. */
function readDue(due: unknown, now: Date): { text: string | null; label: string } | null {
  if (due === null || due === '') return { text: null, label: 'no date' };
  const { parseWhen } = require('./util/when.ts');
  const w = parseWhen(String(due).trim().replace(/^by\s+/i, ''), now);
  if (!w) throw new Error(`cannot read the due date "${clip(due, 60)}" — try friday, tomorrow 3pm, 2d or 2026-11-20 (a date in the past is not accepted)`);
  return { text: String(due).trim(), label: dueLabel(w.at) };
}

type NewItem = {
  op?: string; card?: string | number; title?: string; details?: string | null; due?: string | null; project?: string | null;
  note?: string; reason?: string; as?: string;
};

/** One item, checked against the board; the stored shape ({op, commitmentId, fields, reason}). Throws a plain message. */
async function checkItem(it: NewItem, now: Date) {
  const op = String(it.op ?? '').toLowerCase();
  if (!(OPS as readonly string[]).includes(op)) throw new Error(`op must be one of ${OPS.join(', ')}`);
  const reason = it.reason ? clip(it.reason, 300) : null;
  const fields: Row = {};

  const withProject = async () => {
    if (it.project === undefined) return;
    if (it.project === null || String(it.project).trim() === '') { fields.project = null; return; }
    const name = String(it.project).trim();
    if (!(await require('./projects').byName(name))) throw new Error(`no project "${clip(name, 60)}" — try \`pa projects\``);
    fields.project = name;
  };
  const withDue = () => {
    if (it.due === undefined) return;
    const d = readDue(it.due, now);
    fields.due = d!.text;
    fields.due_label = d!.label;
  };

  if (op === 'create') {
    const title = String(it.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('a new card needs a title');
    if (title.length > 500) throw new Error('a card title is one line (500 characters at most)');
    fields.title = title;
    if (it.details) fields.details = String(it.details).trim().slice(0, 8000);
    withDue();
    await withProject();
    return { op, commitmentId: null as number | null, fields, reason };
  }

  const id = cardId(it.card);
  if (!id) throw new Error(`${op} needs a card id (from the board), e.g. 412`);
  const cur = await repo.commitments.byId(id);
  if (!cur) throw new Error(`no card #${id}`);
  if (cur.status !== 'open') throw new Error(`card #${id} is ${cur.status}, not open`);

  if (op === 'close') {
    const as = String(it.as ?? 'dismiss').toLowerCase();
    if (!['dismiss', 'done'].includes(as)) throw new Error('close `as` is dismiss (not needed) or done');
    fields.as = as;
    return { op, commitmentId: id, fields, reason };
  }

  // edit
  if (it.title !== undefined) {
    const t = String(it.title ?? '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('a card needs a title');
    fields.title = t.slice(0, 200);
  }
  if (it.details !== undefined) fields.details = it.details == null ? null : String(it.details).trim().slice(0, 8000);
  if (it.note !== undefined) {
    const n = String(it.note ?? '').replace(/\s+/g, ' ').trim();
    if (!n) throw new Error('the note is empty');
    fields.note = n.slice(0, 2000);
  }
  withDue();
  await withProject();
  if (!Object.keys(fields).length) throw new Error('an edit needs at least one of title, details, due, project, note');
  return { op, commitmentId: id, fields, reason };
}

/**
 * Validates every item (all problems reported together, one line each, so they
 * can be fixed in one go) and stores the plan pending. Changes no card.
 * @returns {Promise<{id, title, items: number, link: string}>}
 */
async function propose(
  { title, rationale = null, sources = [], items, via = 'chat' }: { title?: string; rationale?: string | null; sources?: unknown; items?: NewItem[]; via?: string } = {},
  { now = new Date() }: { now?: Date } = {}
) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) throw fail('give the plan a title (what it is from, e.g. "Drew\'s VM migration plan")');
  if (!Array.isArray(items) || !items.length) throw fail('a plan needs at least one item');
  if (items.length > MAX_ITEMS) throw fail(`a plan has at most ${MAX_ITEMS} items; split it`);

  const checked: Awaited<ReturnType<typeof checkItem>>[] = [];
  const problems: string[] = [];
  const closing = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    try {
      const c = await checkItem(items[i] || {}, now);
      if (c.commitmentId && closing.has(c.commitmentId)) throw new Error(`card #${c.commitmentId} is already closed by an earlier item`);
      if (c.op === 'close' && c.commitmentId) closing.add(c.commitmentId);
      checked.push(c);
    } catch (e) {
      problems.push(`item ${i + 1}: ${(e as Error).message}`);
    }
  }
  if (problems.length) throw fail(`not stored — fix and send again:\n${problems.join('\n')}`);

  const src = (Array.isArray(sources) ? sources : sources ? [sources] : []).map((s) => clip(s, 500)).filter(Boolean).slice(0, 20);
  const plan = await repo.withTx(async (r: any) => {
    const p = await r.cardPlans.insertPlan({ title: clip(t, 200), rationale: rationale ? String(rationale).trim().slice(0, 4000) : null, sources: src.length ? JSON.stringify(src) : null, via });
    for (let i = 0; i < checked.length; i++) {
      const c = checked[i]!;
      await r.cardPlans.insertItem({ planId: p.id, idx: i, op: c.op, commitmentId: c.commitmentId, fields: JSON.stringify(c.fields), reason: c.reason });
    }
    return p;
  });
  await announce(Number(plan.id), plan.title, checked.length);
  return { id: Number(plan.id), title: String(plan.title), items: checked.length, link: link(Number(plan.id)) };
}

/** A pending plan joins the feed: it is waiting on the user, like a Build agent's question. */
async function announce(id: number, title: string, n: number) {
  try {
    const notify = require('./notify/notify.ts');
    await notify.notify({
      kind: 'info', priority: 'normal',
      title: `Card changes waiting for your yes: ${clip(title, 80)}`,
      body: `${n} proposed change${n === 1 ? '' : 's'} to your cards. Untick what you do not want, then Apply: ${link(id)}\nOr: pa cardplan show ${id}`,
      url: notify.dashboardUrl('') + `#cardplan-${id}`,
      dedupeKey: `card-plan:${id}`,
    });
  } catch { /* a missed notice never fails the proposal */ }
}

function link(id: number): string {
  try { return `${require('./notify/notify.ts').dashboardUrl('')}#cardplan-${id}`; } catch { return `#cardplan-${id}`; }
}

/** One readable line for an item: "Close #12 'Set up VM backups' — superseded by Drew's plan". */
function line(it: Row, card: Row | null): string {
  const f = parseJson(it.fields);
  const why = it.reason ? ` — ${clip(it.reason, 160)}` : '';
  if (it.op === 'create') {
    const bits = [f.due !== undefined ? `due ${f.due_label ?? f.due ?? 'none'}` : '', f.project ? `project ${f.project}` : ''].filter(Boolean);
    return `New: '${clip(f.title, 120)}'${bits.length ? ` (${bits.join(', ')})` : ''}${why}`;
  }
  const name = `#${it.commitment_id}${card?.summary ? ` '${clip(card.summary, 70)}'` : ''}`;
  if (it.op === 'close') return `Close ${name}${f.as === 'done' ? ' as done' : ''}${why}`;
  const bits: string[] = [];
  if (f.title !== undefined) bits.push(`title → '${clip(f.title, 80)}'`);
  if (f.due !== undefined) bits.push(`due → ${f.due_label ?? f.due ?? 'none'}`);
  if (f.project !== undefined) bits.push(`project → ${f.project ?? 'none'}`);
  if (f.details !== undefined) bits.push('details');
  if (f.note !== undefined) bits.push(`note '${clip(f.note, 60)}'`);
  return `Edit ${name}: ${bits.join(', ')}${why}`;
}

/** A plan with its items, each shown as a line. */
async function show(id: number | string) {
  const plan: Row | null = await repo.cardPlans.planById(id);
  if (!plan) throw Object.assign(new Error(`no card plan #${id}`), { status: 404 });
  const rows: Row[] = await repo.cardPlans.items(id);
  const items = [];
  for (const it of rows) {
    const card = it.commitment_id ? await repo.commitments.summaryRow(it.commitment_id) : null;
    items.push({
      n: Number(it.idx) + 1, op: String(it.op), card: it.commitment_id ? Number(it.commitment_id) : null, line: line(it, card), reason: it.reason ?? null,
      enabled: Number(it.enabled) !== 0, status: String(it.status), error: it.error ?? null, result: parseJson(it.result),
    });
  }
  return {
    id: Number(plan.id), title: String(plan.title), rationale: plan.rationale ?? null, sources: (() => { try { return JSON.parse(String(plan.sources || '[]')); } catch { return []; } })(),
    status: String(plan.status), created_at: plan.created_at, applied_at: plan.applied_at ?? null, items,
  };
}

/** Plans newest first (default: the ones waiting: pending or partly), each as show() gives it. */
async function list({ status = null, limit = 20 }: { status?: string | null; limit?: number } = {}) {
  const rows: Row[] = status ? await repo.cardPlans.listPlans({ status, limit }) : [...(await repo.cardPlans.listPlans({ status: 'pending', limit })), ...(await repo.cardPlans.listPlans({ status: 'partly', limit }))];
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  return Promise.all(rows.slice(0, limit).map((r) => show(r.id as number)));
}

/** 1-based item numbers from [1,3], "1,3" or "1 3"; throws on anything else. */
function numbers(v: unknown): number[] {
  const parts = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  const out: number[] = [];
  for (const p of parts) {
    if (p === '' || p == null) continue;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) throw fail(`item numbers are 1, 2, 3, … (got "${clip(p, 20)}")`);
    out.push(n);
  }
  return out;
}

async function runItem(it: Row, planId: number): Promise<Row> {
  const f = parseJson(it.fields);
  const reason = `card plan #${planId}${it.reason ? `: ${clip(it.reason, 180)}` : ''}`;
  if (it.op === 'edit') {
    const { editCard } = require('./commitments.ts');
    const edit: Row = { reason };
    for (const k of ['title', 'details', 'due', 'project', 'note']) if (f[k] !== undefined) edit[k] = f[k];
    const r = await editCard(Number(it.commitment_id), edit, { actor: 'you' });
    return { changed: r.changed };
  }
  if (it.op === 'close') {
    const id = Number(it.commitment_id);
    const cur = await repo.commitments.byId(id);
    if (!cur) throw new Error(`no card #${id}`);
    if (cur.status !== 'open') return { skipped: `already ${cur.status}` };
    const to = f.as === 'done' ? 'done' : 'dropped';
    const ledger = require('./ledger');
    const r = await ledger.transition({ commitmentId: id, to, actor: 'you', reason });
    if (!r.changed) throw new Error(r.skip || 'not changed');
    const group = await require('./commitments.ts').closeGroup(id, to, reason);
    return { closed: to, with: group };
  }
  const request = require('./commitments/request.ts');
  const r = await request.add({ text: f.title, due: f.due ?? null, project: f.project ?? null, via: 'chat' });
  if (f.details) await require('./commitments.ts').editCard(r.id, { details: f.details, reason }, { actor: 'you' });
  return { created: r.id };
}

/**
 * Runs the plan's enabled, still pending (or earlier failed) items in order.
 * `skip` (1-based numbers) unticks items first (they are marked skipped, kept
 * as such). Continues past a failing item; an applied item is never run again,
 * so applying twice is a no-op. Returns show() plus {applied, failed, skipped, ran}.
 */
async function apply(id: number | string, { skip = [], actor = 'you' }: { skip?: unknown; actor?: string } = {}) {
  const plan: Row | null = await repo.cardPlans.planById(id);
  if (!plan) throw Object.assign(new Error(`no card plan #${id}`), { status: 404 });
  if (plan.status === 'discarded') throw fail(`card plan #${id} was discarded`);
  const planId = Number(plan.id);
  const drop = new Set(numbers(skip));
  const rows: Row[] = await repo.cardPlans.items(planId);
  for (const n of drop) if (n > rows.length) throw fail(`card plan #${planId} has ${rows.length} items, not ${n}`);

  let ran = 0;
  for (const it of rows) {
    const n = Number(it.idx) + 1;
    if (drop.has(n) && (it.status === 'pending' || it.status === 'failed')) {
      await repo.cardPlans.updateItem(it.id, { enabled: 0, status: 'skipped', error: null });
      it.status = 'skipped';
      continue;
    }
    if (Number(it.enabled) === 0) {
      if (it.status === 'pending') await repo.cardPlans.updateItem(it.id, { status: 'skipped' });
      continue;
    }
    if (it.status === 'failed') await repo.cardPlans.updateItem(it.id, { status: 'pending', error: null });
    else if (it.status !== 'pending') continue;
    if (!(await repo.cardPlans.claimItem(it.id))) continue; // another apply has it
    ran++;
    try {
      const result = await runItem(it, planId);
      await repo.cardPlans.updateItem(it.id, result.skipped ? { status: 'skipped', error: String(result.skipped), result: JSON.stringify(result), applied_at: new Date().toISOString() } : { status: 'applied', error: null, result: JSON.stringify(result), applied_at: new Date().toISOString() });
    } catch (e) {
      await repo.cardPlans.updateItem(it.id, { status: 'failed', error: clip((e as Error).message, 500) });
    }
  }

  const after: Row[] = await repo.cardPlans.items(planId);
  const count = (s: string) => after.filter((x) => x.status === s).length;
  const failed = count('failed');
  const applied = count('applied');
  const status = failed ? 'partly' : applied ? 'applied' : 'discarded';
  if (ran || plan.status === 'pending') await repo.cardPlans.setPlanStatus(planId, status, applied ? new Date().toISOString() : null);
  const shown = await show(planId);
  return { ...shown, applied, failed, skipped: count('skipped'), ran, actor };
}

/**
 * What the one approval for `card_plan_apply {plan, skip}` shows: the spoken
 * question (counts only) and the card's detail (every change, as a line). The
 * yes is to exactly these, so unticked items (`skip`) and ones already done are
 * left out.
 */
async function approvalText({ plan, skip = [] }: { plan?: unknown; skip?: unknown } = {}) {
  const p = await show(Number(plan));
  const drop = new Set(numbers(skip));
  const todo = p.items.filter((i) => i.enabled && !drop.has(i.n) && (i.status === 'pending' || i.status === 'failed'));
  const by = (op: string) => todo.filter((i) => i.op === op).length;
  const parts = [['close', 'close'], ['edit', 'edit'], ['create', 'create']].map(([op, w]) => (by(op!) ? `${w} ${by(op!)}` : '')).filter(Boolean);
  return {
    ask: `Apply card plan ${p.id}, ${clip(p.title, 60)}: ${todo.length} change${todo.length === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}. Shall I?`,
    detail: todo.map((i) => `${i.n}. ${i.line}`).join('\n') || '(nothing left to apply)',
  };
}

/** Drops a pending (or partly applied) plan; nothing already applied is undone. */
async function discard(id: number | string) {
  const plan: Row | null = await repo.cardPlans.planById(id);
  if (!plan) throw Object.assign(new Error(`no card plan #${id}`), { status: 404 });
  if (plan.status === 'applied') throw fail(`card plan #${id} is already applied`);
  if (plan.status !== 'discarded') {
    for (const it of await repo.cardPlans.items(id)) if (it.status === 'pending' || it.status === 'failed') await repo.cardPlans.updateItem(it.id, { status: 'skipped', enabled: 0 });
    await repo.cardPlans.setPlanStatus(Number(plan.id), 'discarded');
  }
  return show(id);
}

module.exports = { propose, show, list, apply, discard, approvalText, line, numbers, cardId, MAX_ITEMS };
