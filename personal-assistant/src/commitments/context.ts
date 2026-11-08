'use strict';

// Card context: the "cause and effect" paragraph on a dashboard card
// (sql/023, contextCore.js for the prompt).
//
// Lazy and small. Only commitments that are on a card — Needs you, Looks
// done?, On you, Waiting on others — get one, a few per worker tick, one model
// call each, and only while the daily budget allows discretionary work
// (purpose `card-context`, src/budget.js). Never on the HTTP request path: the
// dashboard shows what is stored and says "not written yet" otherwise.
//
// Written again when the thread it came from has items fetched after it was
// written (a reply, an edit, the session going on) — at most every
// REFRESH_MINUTES, so a live Claude session does not rewrite it every pass —
// or when the prompt version changes. Message content is data, never
// instructions (the system prompt says so); the only thing this pass writes is
// the paragraph.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const llm = require('../llm.ts');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const K = require('./contextCore.ts');

const log = logger('card-context');

const PURPOSE = 'card-context';
const BATCH = 3;
const REFRESH_MINUTES = 30;

/** Commitments on a card whose context is missing or stale, most visible first. */
async function due(limit: number = BATCH) {
  const { SELF_NOTE } = require('./selfNotes.ts');
  return repo.commitments.dueForContext(limit, `${K.VERSION} ${config.reconcile.model}`, REFRESH_MINUTES, SELF_NOTE);
}

/** Everything the prompt needs for one commitment. */
async function material(id: any) {
  const c = await repo.commitments.contextCard(id);
  if (!c) return null;
  // The messages around the source in its thread: a few before, more after —
  // what led to it, and what has happened since. A session's "thread" is its
  // folder, i.e. other sessions: not context for this one.
  let thread = [];
  if (c.thread_external_id && c.source !== 'claude_session') {
    thread = await repo.commitments.contextThread(c.source, c.thread_external_id, c.occurred_at, c.item_id);
    thread.sort((a: any, b: any) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
    thread = thread.map((t: any) => ({ ...t, is_source: String(t.id) === String(c.item_id) }));
  }
  const runs = await repo.runs.recentForCommitment(id);
  const evidence = await repo.ledger.pendingEvidenceFor(id);
  return { c, thread, runs, evidence };
}

let meName: string | null = null;
async function me() {
  if (meName) return meName;
  const r = await repo.people.meName().catch(() => null);
  meName = r?.display_name || 'the user';
  return meName;
}

/** Writes the context for one commitment. Returns the paragraph, or null. */
async function write(id: any) {
  const m = await material(id);
  if (!m) return null;
  const { c } = m;
  const prompt = K.buildPrompt({
    c,
    me: await me(),
    item: { source: c.source, subject: c.subject, occurred_at: c.occurred_at, author: c.author, body: c.body, raw: c.raw },
    thread: m.thread,
    runs: m.runs,
    evidence: m.evidence,
  });
  const reply = await llm.complete({
    system: K.SYSTEM,
    prompt,
    model: config.cardContext.model,
    effort: 'low',
    maxTokens: 600,
    purpose: PURPOSE,
  });
  const text = K.parseContext(reply);
  // Stamped even when the reply was unusable, so one bad item is not retried
  // every tick; a new thread item or prompt version tries it again.
  await repo.commitments.setContext(id, text, `${K.VERSION} ${config.reconcile.model}`);
  return text;
}

/** One worker tick: a few cards, while the budget allows. */
async function pass({ limit = BATCH }: { limit?: number } = {}) {
  if (!config.cardContext.enabled) return { written: 0 };
  const budget = require('../budget.ts');
  const todo = await due(limit);
  let written = 0;
  for (const t of todo) {
    if (!(await budget.allow(PURPOSE))) break;
    try {
      if (await write(Number(t.id))) written += 1;
    } catch (err: any) {
      log.warn('context failed', { commitment: Number(t.id), message: err.message });
      // Tried again after REFRESH_MINUTES, not on every tick.
      await repo.commitments.stampContextAt(t.id).catch(() => {});
    }
  }
  if (written) log.info('written', { written, due: todo.length });
  return { written, due: todo.length };
}

module.exports = { pass, write, due, material, PURPOSE };
