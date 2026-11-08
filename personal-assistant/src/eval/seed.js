'use strict';

// `pa eval seed`: samples real items and asks the model for the question a
// person would ask about them later. The item's id is the gold, so the case
// grades retrieval with no human labelling — and `pa eval list` / `drop` is how
// a human prunes the ones the model got wrong.
//
// Sampling is weighted towards items that distillation found something in
// (commitments, facts): those are what anyone will actually come looking for.
// Items with no chunks are excluded, because no retriever can find them and a
// case that nothing could pass measures the chunker, not retrieval.

const repo = require('../repo');
const { config } = require('../config.ts');
const llm = require('../llm.ts');
const { logger } = require('../log.ts');
const P = require('./prompts');

const log = logger('eval');

// A question that is mostly its item's subject line is dropped at seed time.
const MAX_SUBJECT_OVERLAP = 0.6;

async function usedGold() {
  return repo.evals.usedGold();
}

// Weighted random sample (Efraimidis–Spirakis): order by -ln(u)/w.
// boost: a repo.evals BOOSTS key ('temporal'), never SQL.
async function candidates({ exclude, limit, boost = 'none' }) {
  return repo.evals.sample({ exclude, limit, boost });
}

async function loadItems(ids) {
  const items = await repo.evals.itemsWithFacts(ids);
  const byId = new Map(items.map((i) => [String(i.id), i]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean).sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
}

async function threadPairs({ exclude, limit }) {
  return repo.evals.threadPairs({ exclude, limit });
}

// Groups of items from different threads that share a counterparty or a project.
async function sharedGroups({ exclude, limit }) {
  const groups = await repo.evals.sharedGroups({ exclude, limit });
  const threads = new Map(
    (await repo.evals.threadKeys(groups.flatMap((g) => g.ids))).map((r) => [String(r.id), r.t])
  );
  // 2–3 items, one per thread, chosen at random within the group.
  return groups.map((g) => {
    const seen = new Set();
    const ids = [];
    for (const id of g.ids.map(Number).sort(() => Math.random() - 0.5)) {
      const t = threads.get(String(id));
      if (seen.has(t)) continue;
      seen.add(t);
      ids.push(id);
      if (ids.length >= 3) break;
    }
    return { key: g.key, ids };
  });
}

async function generate(qtype, ids) {
  const items = await loadItems(ids);
  if (items.length !== ids.length) return null;
  const reply = await llm.complete({ system: P.SYSTEM, prompt: P.casePrompt(qtype, items), effort: 'medium', maxTokens: 2000, model: config.eval.model, purpose: 'eval' });
  let parsed;
  try {
    parsed = llm.extractJson(reply);
  } catch {
    return null;
  }
  // Knowledge updates are graded on the later item: retrieving only the
  // superseded one is exactly the failure the qtype exists to catch.
  const goldIds = qtype === 'knowledge_update' ? [items[items.length - 1].id] : items.map((i) => i.id);
  const c = P.parseCaseReply(parsed, { qtype, itemIds: goldIds.map(Number) });
  if (!c) return null;
  if (items.length === 1 && P.subjectOverlap(c.question, items[0].subject) > MAX_SUBJECT_OVERLAP) {
    log.info('dropped keyword-matchable question', { item: items[0].id });
    return null;
  }
  const notes = [
    `from #${items.map((i) => i.id).join(', #')}`,
    qtype === 'knowledge_update' ? `earlier #${items[0].id}` : null,
    c.why,
  ].filter(Boolean).join(' · ');
  return { qtype, question: c.question, gold_answer: c.answer, gold_item_ids: c.gold, notes };
}

// Lexical absence: a term with any full-text hit means the question might be
// answerable after all, so it is not an abstention case.
async function lexicallyAbsent(term) {
  const t = String(term || '').trim();
  if (t.length < 3) return false;
  // Whole words, via the same English tsquery as the chunks: a substring test
  // on subjects rejected "Mac" because "machine" exists.
  const r = await repo.evals.fullTextHit(t);
  return !r.hit;
}

// Most proposed terms turn out to be present — this corpus covers a lot — so
// ask in rounds until enough survive the absence check.
async function abstentions(count, { rounds = 4 } = {}) {
  const out = [];
  const asked = new Set();
  for (let round = 0; round < rounds && out.length < count; round++) {
    const subjects = (await repo.evals.sampleSubjects()).map((r) => r.subject).sort(() => Math.random() - 0.5).slice(0, 40);
    let qs = [];
    try {
      const reply = await llm.complete({
        system: P.SYSTEM,
        prompt: P.abstentionPrompt(subjects, Math.max(6, (count - out.length) * 3)),
        effort: 'medium',
        maxTokens: 3000,
        model: config.eval.model,
        purpose: 'eval',
      });
      qs = (llm.extractJson(reply).questions || []).filter((q) => q && q.question && q.term);
    } catch (err) {
      log.warn('abstention generation failed', { message: err.message });
    }
    for (const q of qs) {
      if (out.length >= count) break;
      const key = String(q.term).toLowerCase();
      if (asked.has(key)) continue;
      asked.add(key);
      if (!(await lexicallyAbsent(q.term))) continue;
      out.push({
        qtype: 'abstention',
        question: String(q.question).trim(),
        gold_answer: null,
        gold_item_ids: [],
        notes: `absent term: ${q.term}`,
      });
    }
  }
  return out;
}

async function pool(items, size, fn) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          log.warn('generation failed', { message: err.message });
          results[i] = null;
        }
      }
    })
  );
  return results;
}

// Tries candidate jobs until `want` cases come back, `concurrency` at a time.
async function fill(want, jobs, { concurrency, onCase }) {
  const got = [];
  let i = 0;
  while (got.length < want && i < jobs.length) {
    const batch = jobs.slice(i, i + Math.max(concurrency, want - got.length));
    i += batch.length;
    const results = await pool(batch, concurrency, (job) => generate(job.qtype, job.ids));
    for (const r of results) {
      if (!r || got.length >= want) continue;
      got.push(r);
      await onCase(r);
    }
  }
  return got;
}

async function insertCase(c) {
  return repo.evals.insertGenerated(c);
}

async function seed({ n = 60, concurrency = 4, only = null, progress = () => {} } = {}) {
  if (only && !(only in P.allocate(0))) throw new Error(`unknown qtype "${only}"`);
  const plan = only ? { [only]: n } : P.allocate(n);
  const exclude = await usedGold();
  const made = {};
  const onCase = async (c) => {
    c.id = await insertCase(c);
    made[c.qtype] = (made[c.qtype] || 0) + 1;
    progress(c);
  };

  if (plan.single_session) {
    const picks = P.spread(await candidates({ exclude, limit: 600 }), plan.single_session * 2);
    await fill(plan.single_session, picks.map((p) => ({ qtype: 'single_session', ids: [p.id] })), { concurrency, onCase });
  }
  if (plan.temporal) {
    const ex = [...exclude, ...(await usedGold())];
    const picks = P.spread(await candidates({ exclude: ex, limit: 600, boost: 'temporal' }), plan.temporal * 2);
    await fill(plan.temporal, picks.map((p) => ({ qtype: 'temporal', ids: [p.id] })), { concurrency, onCase });
  }
  if (plan.knowledge_update) {
    const seenLater = new Set();
    const all = (await threadPairs({ exclude: await usedGold(), limit: 400 })).filter((p) => {
      if (seenLater.has(String(p.later))) return false;
      seenLater.add(String(p.later));
      return true;
    });
    const pairs = P.spread(all, plan.knowledge_update * 3);
    await fill(plan.knowledge_update, pairs.map((p) => ({ qtype: 'knowledge_update', ids: [Number(p.earlier), Number(p.later)] })), { concurrency, onCase });
  }
  if (plan.multi_session) {
    const groups = (await sharedGroups({ exclude: await usedGold(), limit: plan.multi_session * 3 })).filter((g) => g.ids.length >= 2);
    await fill(plan.multi_session, groups.map((g) => ({ qtype: 'multi_session', ids: g.ids })), { concurrency, onCase });
  }
  if (plan.abstention) {
    for (const c of await abstentions(plan.abstention)) await onCase(c);
  }
  return { planned: plan, made };
}

module.exports = { seed, lexicallyAbsent };
