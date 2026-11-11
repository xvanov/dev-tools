'use strict';

// Closing the loop on a commitment by hand. One implementation, shared by the
// CLI (`pa done`) and the dashboard's buttons, per AGENT.md.
//
// `dispatched` is not settable here: only the dispatcher knows a run exists.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('./repo/types.ts').Row;
type Db = import('./repo/types.ts').Db;

const repo = require('./repo');
const ledger = require('./ledger');

const SETTABLE = new Set(['open', 'done', 'dropped']);

// Closing records who closed it and when, so "Closed recently" can show it
// and offer it back; reopening clears both. It goes through the ledger like
// every other change, so your own decisions are in the same history as the
// assistant's.
const REASON: Record<string, string | null> = { open: null, done: 'you marked it done', dropped: 'you dismissed it' };

async function setStatus(id: number | string, status: string) {
  if (!SETTABLE.has(status)) throw new Error(`status must be one of ${[...SETTABLE].join(', ')}`);
  const r = await ledger.transition({ commitmentId: id, to: status, actor: 'you', reason: REASON[status] ?? null });
  if (!r.changed && r.skip === 'commitment not found') throw new Error(`no commitment #${id}`);
  // A close covers the whole duplicate group: closing one copy of a restated
  // ask left its twin open on the board, so "Done" looked like it did nothing.
  if (status !== 'open') await closeGroup(id, status, REASON[status] ?? null);
  return repo.commitments.summaryRow(id);
}

/** Closes the open rest of `id`'s duplicate group the same way. Returns their ids. */
async function closeGroup(id: number | string, status: string, reason: string | null) {
  const ids: number[] = (await repo.commitments.openDuplicatesOf(id)).map((r: { id: unknown }) => Number(r.id));
  for (const other of ids) {
    await ledger.transition({ commitmentId: other, to: status, actor: 'you', reason: `${reason} (duplicate of #${id})` });
  }
  return ids;
}

// Closed in the last few days, newest first — by you or by the assistant.
async function recentlyClosed({ days = 3, limit = 40 }: { days?: number; limit?: number } = {}) {
  return repo.commitments.recentlyClosed(String(days), limit);
}

// ---- editing a card ---------------------------------------------------------
//
// The card's fields, changed in place instead of dismiss + recreate, so the
// card keeps its id, its source link, its runs, drafts and ledger history.
// `pa card edit`, the chat's `card_edit` tool and the dashboard's Edit box all
// call editCard.
//
// What keeps a later pass from undoing it:
//   - the edit stamps touched_at (a person's change, like a close) and leaves a
//     ledger_transition row, so distillation treats the card as acted on: it is
//     kept as it is, never replaced by a fresh extraction (src/distill/keep.ts);
//     and a re-extraction that restates the card's ORIGINAL wording is matched
//     to it through that row's `before`, not added again as a second card;
//   - a project change goes through projects.correct, whose "corrected by hand"
//     rationale the rescoring pass keeps (src/projects/rescore.ts);
//   - the reconciler and the other closers write only status columns.

const MAX_TITLE = 200;
const MAX_DETAILS = 8000;
const MAX_NOTE = 2000;
const EDIT_FIELDS = ['title', 'details', 'due', 'project', 'note'] as const;

const clip = (v: unknown, n: number) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const iso = (v: any) => { if (v == null) return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

type CardEdit = {
  /** The card's one-line summary (what the board shows as its title). */
  title?: string;
  /** The longer description; '' or null clears it. */
  details?: string | null;
  /** A due date: what src/util/when.ts reads ("friday", "tomorrow 3pm", "2d", "2026-11-20"), a Date, or null to clear it. */
  due?: string | Date | null;
  /** A project name or alias (`pa projects`); null clears it. */
  project?: string | null;
  /** Appended to the details as a dated line, never replacing them. */
  note?: string;
  /** Why, for the ledger. */
  reason?: string;
};

/**
 * Edits a card's fields in place and records it in the ledger (a same-status
 * row: actor, reason, and `before`: {edit: {field: old value}}).
 *
 * Throws `no commitment #id` for an unknown id, and a plain message for bad
 * input (empty title, unreadable or past due date, unknown project, nothing to
 * change). A call that changes nothing returns changed: [] and writes nothing.
 *
 * @returns {{id, changed: string[], before: object, after: object, transitionId: number|null, card: {id, status, summary}}}
 */
async function editCard(id: number | string, edit: CardEdit = {}, { actor = 'you', now = new Date() }: { actor?: string; now?: Date } = {}) {
  const cur = await repo.commitments.byId(id);
  if (!cur) throw new Error(`no commitment #${id}`);
  const given = EDIT_FIELDS.filter((k) => (edit as any)[k] !== undefined);
  if (!given.length) throw new Error('nothing to edit: give a title, details, due date, project or note');

  const set: Record<string, any> = {};
  const before: Record<string, any> = {};
  const after: Record<string, any> = {};

  if (edit.title !== undefined) {
    const t = String(edit.title ?? '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('a card needs a title');
    const title = clip(t, MAX_TITLE);
    if (title !== cur.summary) { set.summary = title; before.summary = cur.summary; after.summary = title; }
  }

  let detail = cur.detail ?? null;
  if (edit.details !== undefined) {
    const d = edit.details == null ? '' : String(edit.details).trim();
    const next = d ? clip(d, MAX_DETAILS) : null;
    if (next !== detail) { before.detail = cur.detail ?? null; detail = next; }
  }
  if (edit.note !== undefined) {
    const n = String(edit.note ?? '').replace(/\s+/g, ' ').trim();
    if (!n) throw new Error('the note is empty');
    if (!('detail' in before)) before.detail = cur.detail ?? null;
    const line = `Note (${now.toISOString().slice(0, 10)}): ${clip(n, MAX_NOTE)}`;
    detail = detail ? `${detail}\n\n${line}` : line;
  }
  if ('detail' in before) { set.detail = detail; after.detail = detail; }

  if (edit.due !== undefined) {
    let at: Date | null = null;
    if (edit.due !== null && edit.due !== '') {
      if (edit.due instanceof Date) at = Number.isNaN(edit.due.getTime()) ? null : edit.due;
      else {
        const { parseWhen } = require('./util/when.ts');
        const w = parseWhen(String(edit.due).trim().replace(/^by\s+/i, ''), now);
        at = w ? w.at : null;
      }
      if (!at) throw new Error(`cannot read the due date "${clip(edit.due instanceof Date ? 'invalid date' : edit.due, 60)}" — try friday, tomorrow 3pm, 2d or 2026-11-20 (a date in the past is not accepted)`);
    }
    if (iso(at) !== iso(cur.due_at)) { set.due_at = at; before.due_at = iso(cur.due_at); after.due_at = iso(at); }
  }

  if (edit.project !== undefined) {
    const projects = require('./projects');
    const name = edit.project === null || String(edit.project).trim() === '' ? null : String(edit.project).trim();
    const target = name ? await projects.byName(name) : null;
    if (name && !target) throw new Error(`no project "${name}" — try \`pa projects\``);
    if ((target?.id ?? null) !== (cur.project_id ?? null)) {
      const old = cur.project_id ? await repo.projects.rowById(cur.project_id) : null;
      await projects.correct(id, name);
      before.project = old?.name ?? null;
      after.project = target?.name ?? null;
    }
  }

  const changed = Object.keys(after).map((k) => (k === 'summary' ? 'title' : k === 'detail' ? 'details' : k === 'due_at' ? 'due' : k));
  if (!changed.length) return { id: Number(cur.id), changed: [] as string[], before, after, transitionId: null as number | null, card: await repo.commitments.summaryRow(id) };

  const why = `edited ${changed.join(', ')}${edit.reason ? ` — ${clip(edit.reason, 200)}` : ''}`;
  const transitionId = await repo.withTx(async (r: any) => {
    if (Object.keys(set).length || actor === 'you') await r.commitments.setCard(id, set, actor === 'you');
    // before holds the replaced values under `edit` (the keys the ledger's
    // status undo never reads: ledger.undo refuses such a row); the new values
    // are on the card. The first edit's summary is the wording a
    // re-distillation still extracts: keep.ts reads it back from here.
    return r.ledger.insertTransition({ commitmentId: id, from: cur.status, to: cur.status, actor, reason: why, evidenceId: null, before: { edit: before }, at: iso(now) });
  });
  return { id: Number(cur.id), changed, before, after, transitionId, card: await repo.commitments.summaryRow(id) };
}

module.exports = { setStatus, closeGroup, recentlyClosed, editCard, SETTABLE };
