'use strict';

// A dispatch offer: everything a "start this?" card shows, decided once and
// frozen into the proposal, so that accepting it runs exactly what was shown.
//
//   prepare(o)  → {title, body, payload}   check the repo, name the task
//   propose(o)  → the proposal row          prepare + proposals.create
//
// Used by the planner (an offer from an ask it read) and by `pa propose` (the
// PA chat putting work on a card instead of starting it). Accepting a card
// starts one Build agent (src/dispatch start → src/build; D30), so an offer
// carries only what Build uses: the task, the repo (checked now, not re-judged
// at accept) and the model. The end state, pipeline, models and done-criteria
// of the removed software factory (D32) are gone; older cards that still carry
// them are accepted and the extra fields are ignored.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/** A dispatch target (dispatch.resolveTarget): store rows, read column by column. */
type Target = Json;
/** The frozen offer: stored as the proposal's JSON payload, read back at accept. */
type Payload = Json;
type Offer = { title: string; body: string; payload: Payload; target: Target };
type PrepareOptions = {
  commitmentId?: number | string | null;
  /** the operator's own words (never a third party's) */
  task?: string | null;
  repoPath?: string | null;
  /** the Build model (haiku | sonnet | opus | fable); unset: the card's build settings */
  model?: string | null;
  /** a line for the card (the planner's brief) */
  why?: string | null;
  suggestedBy?: string | null;
  title?: string | null;
};

const { logger } = require('../log.ts');

const log = logger('offer');

/** One line, clipped. */
function clip(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  let cut = n - 1;
  const c = t.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${t.slice(0, cut)}…`;
}

async function prepare({ commitmentId = null, task = null, repoPath = null, model = null, why = null, suggestedBy = null, title = null }: PrepareOptions): Promise<Offer> {
  const dispatch = require('./index.ts');
  if (repoPath) await dispatch.knownRepo(repoPath);
  const target: Target = await dispatch.resolveTarget({ commitmentId, repoPath });
  const label: string | null | undefined = title || task || target.commitment?.summary;
  if (!label) throw new Error('nothing to offer — give a commitment id or a --task');

  const payload: Payload = {
    frozen: true,
    why: why ? clip(why, 500) : null,
    suggestedBy: suggestedBy ? clip(suggestedBy, 40) : null,
    via: 'build',
    routeReason: 'one Claude Code agent (D30)',
    title: title || null,
    task: task || null,
    repoPath: target.repoPath || null,
    // Checked now: a `--repo` against the known projects (above), or the
    // commitment's own project. Accept trusts this instead of re-judging.
    repoVerifiedAt: target.repoPath ? new Date().toISOString() : null,
    model: model || null,
  };
  return { title: `Start an agent: ${label}`.slice(0, 280), body: cardBody({ payload, why, target }), payload, target };
}

/** The card's text. */
function cardBody({ payload: p, why, target }: { payload: Payload; why?: string | null; target?: Target | null }): string {
  const L: string[] = [];
  if (p.suggestedBy) L.push(`Suggested by ${p.suggestedBy} — check what it asks before you accept.`, '');
  // The planner's note is model text: one line, labelled, so it can never pose
  // as the card's own lines.
  if (why) L.push(`Planner's note: ${clip(why, 500)}`, '');
  L.push(`Starts one Claude Code agent${p.model ? ` (${p.model})` : ''}${target?.project?.name ? ` in ${target.project.name}` : p.repoPath ? ` in ${p.repoPath}` : ''}, on its own branch in a fresh worktree when the card names a repo.`);
  L.push('It ends with a draft pull request or a report, and never merges.');
  return L.join('\n');
}

async function propose(o: PrepareOptions & { dedupeKey?: string | null; expiresAt?: Date | null }): Promise<Json | null> {
  const { title, body, payload, target } = await prepare(o);
  const row: Json | null = await require('../proposals').create({
    kind: 'dispatch',
    commitmentId: target.commitment ? Number(target.commitment.id) : null,
    title,
    body,
    payload,
    dedupeKey: o.dedupeKey || null,
    expiresAt: o.expiresAt || new Date(Date.now() + 5 * 86400_000),
  });
  if (row) log.info('offered', { proposal: Number(row.id), via: payload.via });
  return row ? { ...row, payload } : null;
}

module.exports = { prepare, propose, cardBody };
