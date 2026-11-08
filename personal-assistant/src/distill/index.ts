'use strict';

// The distillation pass: source items in, typed rows out.
//
// "What needs distilling" is a query, not a queue — items with no row in
// `distillation` at the current prompt version. That cannot get stuck, cannot
// leak, needs no cleanup after a crash, and re-running the whole corpus after a
// prompt change is one `delete from distillation`.
//
// Cost control is effort, not a smaller model: extraction quality is the thing
// this tool is entirely made of, and a cheap wrong commitment costs more
// attention than it saves in tokens. What *is* skipped is work that cannot pay
// off — items under a length threshold, and bodies that are pure machine noise.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const llm = require('../llm.ts');
const repo = require('../repo');
const { PROMPT_VERSION, SYSTEM, buildUserMessage, parseResponse } = require('./prompt.ts');
const identity = require('./identity.ts');
const projects = require('../projects');
const resolve = require('../projects/resolve.ts');
const { logger } = require('../log.ts');
const keep = require('./keep.ts');
const githubGate = require('./githubGate.ts');
const lists = require('./lists.ts');
const policy = require('../commitments/sourcePolicy');

const log = logger('distill');

const MIN_BODY_CHARS = 40;
const MAX_BODY_CHARS = 24_000;

// A recorded meeting or call is the debrief's (src/meetings/debrief.js): one
// model call over the whole conversation with your open work beside it, not
// this item-at-a-time pass, which found one commitment in an hour-long
// meeting. Extracting it twice would put every to-do on the list twice.
const DEBRIEF_OWNED = `(si.source = 'audio' and coalesce(si.raw->>'kind', '') in ('meeting','call'))`;

// Only sources that may create tasks are read at all (src/commitments/
// sourcePolicy.js): a Claude session or any other excluded item never reaches
// the model. Memory extraction and search read them on their own passes.
function sourceAllowed() {
  return policy.sourceSql('si.source', policy.distillSources());
}

async function pending(limit: number = 25) {
  return repo.commitments.pendingDistill(PROMPT_VERSION, MIN_BODY_CHARS, limit, DEBRIEF_OWNED, sourceAllowed());
}

async function pendingCount() {
  const r = await repo.commitments.pendingDistillCount(PROMPT_VERSION, MIN_BODY_CHARS, DEBRIEF_OWNED, sourceAllowed());
  return r?.n ?? 0;
}

async function callModel(item: any, context: any) {
  const body = (item.body_text || '').slice(0, MAX_BODY_CHARS);
  const message = buildUserMessage({ ...item, body_text: body }, context);

  const text = await llm.complete({ system: SYSTEM, prompt: message, maxTokens: 8000, purpose: 'distill' });
  return parseResponse(text, { referenceIso: new Date(item.occurred_at).toISOString() });
}

// Writes one item's results. The distillation marker goes in the same
// transaction as the rows it explains, so a crash mid-write cannot leave an
// item marked done with half its commitments missing. A commitment anything
// has acted on survives a re-distillation untouched (keep.js).
async function persist(item: any, result: any, resolved: any) {
  return repo.withTx(async (r: any) => {
    // The item's live commitments, with whether anything has acted on them
    // (src/distill/keep.js decides what a re-distillation may replace).
    const existing = await r.commitments.liveForItem(item.id);
    const p = keep.plan(existing, result.commitments);
    if (p.remove.length) await r.commitments.deleteByIds(p.remove);
    await r.memory.deleteFactsOf(item.id, PROMPT_VERSION);

    for (const c of p.insert) {
      const match = resolved.byCommitment.get(c);
      await r.commitments.insertDistilled({
        itemId: item.id,
        direction: c.direction,
        summary: c.summary,
        detail: c.detail,
        personId: match?.personId ?? null,
        dueAt: c.dueAt,
        projectId: match?.projectId ?? null,
        repoPath: match?.repoPath ?? null,
        projectConfidence: match?.projectConfidence ?? null,
        projectRationale: match?.projectRationale ?? null,
        confidence: c.confidence,
        extractedBy: PROMPT_VERSION,
      });
    }

    for (const f of result.facts) {
      await r.memory.insertFact(item.id, f.kind, f.summary, { detail: f.detail }, item.occurred_at, PROMPT_VERSION);
    }

    await r.commitments.upsertDistillation(item.id, PROMPT_VERSION, result.commitments.length, result.facts.length);
  });
}

// What a project pick has to be backed by: the item as the model read it, plus
// the commitment it wrote.
function evidenceText(item: any, c: any) {
  const raw = item.raw || {};
  return [item.subject, raw.chatTopic, raw.project, (item.body_text || '').slice(0, MAX_BODY_CHARS), c.summary, c.detail]
    .filter(Boolean)
    .join('\n');
}

// Turns the model's free-text `counterparty` and `project` into ids, using the
// deterministic scorer as the fallback when the model declined to choose.
async function resolveReferences(item: any, result: any, candidates: any) {
  const byCommitment = new Map<any, any>();
  // A GitHub item names its repo outright; that beats the model's pick and the
  // scorer's. A repo with no project here resolves to none rather than to the
  // nearest-looking one.
  const direct = resolve.directMatch(item, candidates);
  const workdirProjectId = resolve.workdirProject(item.raw?.cwd, candidates);

  for (const c of result.commitments) {
    let personId = null;
    if (c.counterparty) {
      personId = await identity.resolve(c.counterparty, c.counterparty);
    } else if (item.author_identity && c.direction === 'owed_by_me') {
      personId = await identity.resolve(item.author_identity, item.raw?.fromName);
    }

    let projectId = null;
    let repoPath = null;
    let projectConfidence = null;
    let projectRationale = null;

    if (direct) {
      byCommitment.set(c, {
        personId,
        projectId: direct.projectId,
        repoPath: direct.repoPath,
        projectConfidence: direct.confidence,
        projectRationale: direct.rationale,
      });
      continue;
    }

    if (c.project) {
      const named = candidates.find(
        (p: any) => p.name.toLowerCase() === c.project.toLowerCase()
      );
      // The model's pick stands only when the text backs it (resolve.js
      // corroborates): it used to follow the ranked guess, or read meaning
      // into repo names, and put unrelated asks on whatever repo was nearest.
      if (named && !(named.id === workdirProjectId || resolve.corroborates(evidenceText(item, c), named))) {
        log.info('project pick not backed by the text', { id: item.id, project: named.name });
      } else if (named) {
        projectId = named.id;
        repoPath = named.repoPath;
        projectConfidence = 0.9;
        projectRationale = c.projectReason || 'named by the distiller';
      }
    }

    if (!projectId) {
      const guess = await projects.guess(`${item.subject || ''}\n${c.summary}\n${c.detail || ''}`, {
        authorPersonId: personId,
        threadExternalId: item.thread_external_id,
        workdirProjectId,
      });
      if (guess) {
        projectId = guess.projectId;
        repoPath = guess.repoPath;
        projectConfidence = guess.confidence;
        projectRationale = guess.rationale;
      }
    }

    byCommitment.set(c, { personId, projectId, repoPath, projectConfidence, projectRationale });
  }

  return { byCommitment };
}

async function distillOne(item: any, cached: any) {
  // Within an allowed source, only a person asking creates tasks: a bot's
  // comment, an automated mail or your own GitHub activity is marked done
  // without a model call (sourcePolicy.judge).
  const meRow = cached?.me || (await identity.me());
  const login = cached && 'githubLogin' in cached ? cached.githubLogin : await identity.myHandle('github_username');
  const verdict = policy.judge(item, {
    sources: policy.distillSources(),
    login,
    me: { name: meRow?.display_name, email: meRow?.primary_email },
  });
  if (!verdict.ok) {
    await markSkipped(item.id);
    log.debug('not from a person — skipped', { id: item.id, source: item.source, why: verdict.why });
    return { id: item.id, commitments: 0, facts: 0, skipped: verdict.why };
  }
  const candidates = cached?.candidates || (await projects.candidates());
  const meLabel = meRow ? `${meRow.display_name} <${meRow.primary_email || 'unknown'}>` : null;

  const ranked = candidates.length
    ? resolve.scoreCandidates(
        `${item.subject || ''}\n${(item.body_text || '').slice(0, 4000)}`,
        candidates,
        {
          ...(await projects.scoringContext({ threadExternalId: item.thread_external_id })),
          workdirProjectId: resolve.workdirProject(item.raw?.cwd, candidates),
        }
      )
    : [];

  try {
    const result = await callModel(item, { meLabel, candidates, ranked });
    // On GitHub, what you owe is decided by GitHub's own records of who you
    // are on the item (author, assignee, named reviewer, @mention), not left
    // to the model: a team's review queue or a PR's planned follow-up is not
    // yours (githubGate.js).
    const g = githubGate.gate(item, result.commitments, { login });
    if (g.dropped.length || g.moved.length) {
      log.info('github gate', { id: item.id, dropped: g.dropped.length, moved: g.moved.length });
    }
    result.commitments = g.commitments;
    // One message that commits to a list is one commitment, not one per item
    // plus an umbrella (distill/lists.js) — the net under the prompt's rule.
    const l = lists.collapse(result.commitments, item.body_text);
    if (l.collapsed) log.info('list collapsed', { id: item.id, folded: l.collapsed });
    result.commitments = l.commitments;
    const resolved = await resolveReferences(item, result, candidates);
    await persist(item, result, resolved);
    return { id: item.id, commitments: result.commitments.length, facts: result.facts.length };
  } catch (err: any) {
    // A failed item is marked with its error so the pass moves on, and so the
    // failure is visible in `pa doctor` rather than being retried forever.
    await repo.commitments.markDistillFailed(item.id, PROMPT_VERSION, String(err.message).slice(0, 500));
    log.warn('item failed', { id: item.id, source: item.source, message: err.message });
    return { id: item.id, error: err.message };
  }
}

async function run({ limit = 25 }: { limit?: number } = {}) {
  const items = await pending(limit);
  if (!items.length) return { processed: 0, commitments: 0, facts: 0, errors: 0 };

  const cached = {
    candidates: await projects.candidates(),
    me: await identity.me(),
    githubLogin: await identity.myHandle('github_username'),
  };
  let commitments = 0;
  let facts = 0;
  let errors = 0;
  let skipped = 0;

  for (const item of items) {
    const r = await distillOne(item, cached);
    if (r.error) errors++;
    else if (r.skipped) skipped++;
    else {
      commitments += r.commitments;
      facts += r.facts;
    }
  }

  log.info('distilled', { processed: items.length, commitments, facts, errors, skipped });
  return { processed: items.length, commitments, facts, errors, skipped };
}

// An item the source policy keeps off the board: marked distilled with
// nothing found, so it is not fetched again. Its earlier commitments, if any,
// are left alone (`pa policy close` handles those, reversibly).
async function markSkipped(itemId: any) {
  await repo.commitments.markDistillSkipped(itemId, PROMPT_VERSION);
}

// Marks an item the debrief owns as distilled, so a worker still running code
// from before DEBRIEF_OWNED existed does not extract it as well.
async function markOwnedByDebrief(itemId: any) {
  await repo.commitments.markDistillOwnedByDebrief(itemId, PROMPT_VERSION);
}

module.exports = { run, distillOne, pending, pendingCount, markOwnedByDebrief, resolveReferences, evidenceText, PROMPT_VERSION };
