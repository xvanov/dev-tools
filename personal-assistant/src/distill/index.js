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

const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { rows, one, query, withTx } = require('../db');
const { PROMPT_VERSION, SYSTEM, buildUserMessage, parseResponse } = require('./prompt');
const identity = require('./identity');
const projects = require('../projects');
const { logger } = require('../log');

const log = logger('distill');

const MIN_BODY_CHARS = 40;
const MAX_BODY_CHARS = 24_000;

let client = null;
function anthropic() {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — distillation cannot run');
  }
  if (!client) {
    const Ctor = Anthropic.default || Anthropic;
    client = new Ctor({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

async function pending(limit = 25) {
  return rows(
    `select si.* from source_item si
       left join distillation d
         on d.source_item_id = si.id and d.extracted_by = $1
      where d.source_item_id is null
        and length(si.body_text) >= $2
      order by si.occurred_at desc
      limit $3`,
    [PROMPT_VERSION, MIN_BODY_CHARS, limit]
  );
}

async function pendingCount() {
  const r = await one(
    `select count(*)::int as n from source_item si
       left join distillation d
         on d.source_item_id = si.id and d.extracted_by = $1
      where d.source_item_id is null and length(si.body_text) >= $2`,
    [PROMPT_VERSION, MIN_BODY_CHARS]
  );
  return r?.n ?? 0;
}

async function callModel(item, context) {
  const body = (item.body_text || '').slice(0, MAX_BODY_CHARS);
  const message = buildUserMessage({ ...item, body_text: body }, context);

  const response = await anthropic().messages.create({
    model: config.anthropic.model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.anthropic.effort },
    system: SYSTEM,
    messages: [{ role: 'user', content: message }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`model declined: ${response.stop_details?.category || 'unknown'}`);
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return parseResponse(text, { referenceIso: new Date(item.occurred_at).toISOString() });
}

// Writes one item's results. The distillation marker goes in the same
// transaction as the rows it explains, so a crash mid-write cannot leave an
// item marked done with half its commitments missing.
async function persist(item, result, resolved) {
  return withTx(async (client_) => {
    await client_.query('delete from commitment where source_item_id = $1 and extracted_by = $2', [
      item.id,
      PROMPT_VERSION,
    ]);
    await client_.query('delete from fact where source_item_id = $1 and extracted_by = $2', [
      item.id,
      PROMPT_VERSION,
    ]);

    for (const c of result.commitments) {
      const match = resolved.byCommitment.get(c);
      await client_.query(
        `insert into commitment
           (source_item_id, direction, summary, detail, counterparty_person_id, due_at,
            project_id, repo_path, project_confidence, project_rationale, confidence, extracted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          item.id,
          c.direction,
          c.summary,
          c.detail,
          match?.personId ?? null,
          c.dueAt,
          match?.projectId ?? null,
          match?.repoPath ?? null,
          match?.projectConfidence ?? null,
          match?.projectRationale ?? null,
          c.confidence,
          PROMPT_VERSION,
        ]
      );
    }

    for (const f of result.facts) {
      await client_.query(
        `insert into fact (source_item_id, kind, summary, payload, occurred_at, extracted_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [item.id, f.kind, f.summary, { detail: f.detail }, item.occurred_at, PROMPT_VERSION]
      );
    }

    await client_.query(
      `insert into distillation (source_item_id, extracted_by, commitments, facts, error)
       values ($1,$2,$3,$4,null)
       on conflict (source_item_id) do update set
         extracted_by = excluded.extracted_by,
         extracted_at = now(),
         commitments  = excluded.commitments,
         facts        = excluded.facts,
         error        = null`,
      [item.id, PROMPT_VERSION, result.commitments.length, result.facts.length]
    );
  });
}

// Turns the model's free-text `counterparty` and `project` into ids, using the
// deterministic scorer as the fallback when the model declined to choose.
async function resolveReferences(item, result, candidates) {
  const byCommitment = new Map();

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

    if (c.project) {
      const named = candidates.find(
        (p) => p.name.toLowerCase() === c.project.toLowerCase()
      );
      if (named) {
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

async function distillOne(item, cached) {
  const candidates = cached?.candidates || (await projects.candidates());
  const meRow = cached?.me || (await identity.me());
  const meLabel = meRow ? `${meRow.display_name} <${meRow.primary_email || 'unknown'}>` : null;

  const ranked = candidates.length
    ? require('../projects/resolve').scoreCandidates(
        `${item.subject || ''}\n${(item.body_text || '').slice(0, 4000)}`,
        candidates,
        await projects.scoringContext({ threadExternalId: item.thread_external_id })
      )
    : [];

  try {
    const result = await callModel(item, { meLabel, candidates, ranked });
    const resolved = await resolveReferences(item, result, candidates);
    await persist(item, result, resolved);
    return { id: item.id, commitments: result.commitments.length, facts: result.facts.length };
  } catch (err) {
    // A failed item is marked with its error so the pass moves on, and so the
    // failure is visible in `pa doctor` rather than being retried forever.
    await query(
      `insert into distillation (source_item_id, extracted_by, error)
       values ($1,$2,$3)
       on conflict (source_item_id) do update set
         extracted_by = excluded.extracted_by, extracted_at = now(), error = excluded.error`,
      [item.id, PROMPT_VERSION, String(err.message).slice(0, 500)]
    );
    log.warn('item failed', { id: item.id, source: item.source, message: err.message });
    return { id: item.id, error: err.message };
  }
}

async function run({ limit = 25 } = {}) {
  const items = await pending(limit);
  if (!items.length) return { processed: 0, commitments: 0, facts: 0, errors: 0 };

  const cached = { candidates: await projects.candidates(), me: await identity.me() };
  let commitments = 0;
  let facts = 0;
  let errors = 0;

  for (const item of items) {
    const r = await distillOne(item, cached);
    if (r.error) errors++;
    else {
      commitments += r.commitments;
      facts += r.facts;
    }
  }

  log.info('distilled', { processed: items.length, commitments, facts, errors });
  return { processed: items.length, commitments, facts, errors };
}

module.exports = { run, distillOne, pending, pendingCount, PROMPT_VERSION };
