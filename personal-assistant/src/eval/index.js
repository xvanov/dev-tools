'use strict';

// The eval harness: cases in, numbers out, every run kept.
//
// Retrieval scoring is deterministic and cheap — a handful of searches and
// arithmetic — so it runs nightly from the worker and on every `pa eval run`.
// The answer judge (`--judge`) puts a model on both ends and is the slow,
// occasional check that good retrieval actually yields right answers.

const repo = require('../repo');
const { config } = require('../config.ts');
const llm = require('../llm.ts');
const { logger } = require('../log.ts');
const retrievers = require('./retrievers');
const M = require('./metrics');
const P = require('./prompts');

const log = logger('eval');

async function activeCases() {
  return repo.evals.activeCases();
}

async function listCases({ all = false, qtype = null } = {}) {
  return repo.evals.listCases({ all, qtype });
}

async function addCase({ question, gold = [], answer = null, qtype = null, origin = 'miss', notes = null }) {
  const type = qtype || (gold.length > 1 ? 'multi_session' : gold.length ? 'single_session' : 'abstention');
  if (!M.QTYPES.includes(type)) throw new Error(`unknown qtype "${type}" — one of ${M.QTYPES.join(', ')}`);
  if (gold.length) {
    const found = await repo.evals.existingItems(gold);
    const missing = gold.filter((g) => !found.some((f) => Number(f.id) === g));
    if (missing.length) throw new Error(`no source_item ${missing.join(', ')}`);
  }
  return repo.evals.insertCase({ question, qtype: type, gold, answer, origin, notes });
}

async function setActive(id, active) {
  return repo.evals.setActive(id, active);
}

async function itemsFor(ids) {
  if (!ids.length) return [];
  const list = await repo.evals.itemsForJudge(ids);
  const byId = new Map(list.map((r) => [String(r.id), r]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// Answers each question from its own top-k, then grades all answers in a few
// batched calls. The answering call never sees the reference.
async function judge(cases, perCase, k) {
  const answers = await pool(perCase, 4, async (s) => {
    const items = await itemsFor(s.returned.slice(0, k));
    const question = cases.find((c) => c.id === s.id).question;
    try {
      return (await llm.complete({ system: P.ANSWER_SYSTEM, prompt: P.answerPrompt(question, items), effort: 'low', maxTokens: 600, model: config.eval.model, purpose: 'eval' })).trim();
    } catch (err) {
      log.warn('judge answer failed', { case: s.id, message: err.message });
      return null;
    }
  });
  const rows = perCase
    .map((s, i) => ({ i, question: cases.find((c) => c.id === s.id).question, reference: cases.find((c) => c.id === s.id).gold_answer, answer: answers[i] }))
    .filter((r) => r.answer != null);
  for (let b = 0; b < rows.length; b += 20) {
    const batch = rows.slice(b, b + 20);
    try {
      const reply = await llm.complete({ system: P.GRADE_SYSTEM, prompt: P.gradePrompt(batch), effort: 'low', maxTokens: 2000, model: config.eval.model, purpose: 'eval' });
      for (const g of llm.extractJson(reply).grades || []) {
        if (perCase[g.i]) perCase[g.i].judge_correct = Boolean(g.correct);
      }
    } catch (err) {
      log.warn('judge grading failed', { message: err.message });
    }
  }
}

async function previousRun(retriever) {
  return repo.evals.previousRun(retriever);
}

async function run({ retriever = 'search', k = 10, judge: withJudge = false, threshold = null } = {}) {
  const r = retrievers.get(retriever);
  const cases = await activeCases();
  if (!cases.length) return null;
  const limit = Math.max(k, 10);
  const th = threshold ?? r.threshold;

  const started = Date.now();
  const perCase = [];
  let degraded = 0;
  for (const c of cases) {
    const got = await r.fn(c.question, { limit, asOf: c.as_of });
    const results = Array.isArray(got) ? got : got.results;
    if (!Array.isArray(got) && got.degraded) degraded++;
    perCase.push(M.scoreCase(c, results, { k, threshold: th }));
  }
  if (withJudge) await judge(cases, perCase, k);

  const metrics = M.aggregate(perCase);
  const prev = await previousRun(retriever);
  const config = { k, limit, threshold: th, judge: withJudge, cases: cases.length, degraded, ms: Date.now() - started };
  const saved = await repo.evals.insertRun({ retriever, config, metrics, perCase });
  log.info('eval run', { id: saved.id, retriever, cases: cases.length, ms: config.ms });
  return { id: saved.id, retriever, config, metrics, perCase, prev, delta: prev ? M.delta(prev.metrics, metrics) : null };
}

// The worker's pass. A no-op with no cases, and at most one run a day however
// often the worker restarts — every() fires once at startup.
async function nightly() {
  const n = await repo.evals.activeCount();
  if (!n.n) return null;
  const last = await previousRun('search');
  if (last && Date.now() - new Date(last.ran_at).getTime() < 20 * 3600_000) return null;
  return run({ retriever: 'search' });
}

module.exports = { run, nightly, listCases, addCase, setActive, activeCases, retrievers, metrics: M };
