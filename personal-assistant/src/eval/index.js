'use strict';

// The eval harness: cases in, numbers out, every run kept.
//
// Retrieval scoring is deterministic and cheap — a handful of searches and
// arithmetic — so it runs nightly from the worker and on every `pa eval run`.
// The answer judge (`--judge`) puts a model on both ends and is the slow,
// occasional check that good retrieval actually yields right answers.

const db = require('../db');
const llm = require('../llm');
const { logger } = require('../log');
const retrievers = require('./retrievers');
const M = require('./metrics');
const P = require('./prompts');

const log = logger('eval');

async function activeCases() {
  return db.rows(
    `select id, question, qtype, gold_item_ids, gold_answer, as_of from eval_case where active order by id`
  );
}

async function listCases({ all = false, qtype = null } = {}) {
  return db.rows(
    `select id, question, qtype, gold_item_ids, gold_answer, origin, active, notes, created_at
       from eval_case
      where ($1 or active) and ($2::text is null or qtype = $2)
      order by id`,
    [all, qtype]
  );
}

async function addCase({ question, gold = [], answer = null, qtype = null, origin = 'miss', notes = null }) {
  const type = qtype || (gold.length > 1 ? 'multi_session' : gold.length ? 'single_session' : 'abstention');
  if (!M.QTYPES.includes(type)) throw new Error(`unknown qtype "${type}" — one of ${M.QTYPES.join(', ')}`);
  if (gold.length) {
    const found = await db.rows('select id from source_item where id = any($1::bigint[])', [gold]);
    const missing = gold.filter((g) => !found.some((f) => Number(f.id) === g));
    if (missing.length) throw new Error(`no source_item ${missing.join(', ')}`);
  }
  return db.one(
    `insert into eval_case (question, qtype, gold_item_ids, gold_answer, as_of, origin, notes)
     values ($1, $2, $3::bigint[], $4, now(), $5, $6) returning id, qtype`,
    [question, type, gold, answer, origin, notes]
  );
}

async function setActive(id, active) {
  const r = await db.query('update eval_case set active = $2 where id = $1', [id, active]);
  return r.rowCount > 0;
}

async function itemsFor(ids) {
  if (!ids.length) return [];
  const list = await db.rows(
    `select id, source, subject, occurred_at, body_text from source_item where id = any($1::bigint[])`,
    [ids]
  );
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
      return (await llm.complete({ system: P.ANSWER_SYSTEM, prompt: P.answerPrompt(question, items), effort: 'low', maxTokens: 600 })).trim();
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
      const reply = await llm.complete({ system: P.GRADE_SYSTEM, prompt: P.gradePrompt(batch), effort: 'low', maxTokens: 2000 });
      for (const g of llm.extractJson(reply).grades || []) {
        if (perCase[g.i]) perCase[g.i].judge_correct = Boolean(g.correct);
      }
    } catch (err) {
      log.warn('judge grading failed', { message: err.message });
    }
  }
}

async function previousRun(retriever) {
  return db.one(
    `select id, ran_at, metrics, config from eval_run where retriever = $1 order by ran_at desc limit 1`,
    [retriever]
  );
}

async function run({ retriever = 'search', k = 10, judge: withJudge = false, threshold = null } = {}) {
  const r = retrievers.get(retriever);
  const cases = await activeCases();
  if (!cases.length) return null;
  const limit = Math.max(k, 10);
  const th = threshold ?? r.threshold;

  const started = Date.now();
  const perCase = [];
  for (const c of cases) {
    const results = await r.fn(c.question, { limit, asOf: c.as_of });
    perCase.push(M.scoreCase(c, results, { k, threshold: th }));
  }
  if (withJudge) await judge(cases, perCase, k);

  const metrics = M.aggregate(perCase);
  const prev = await previousRun(retriever);
  const config = { k, limit, threshold: th, judge: withJudge, cases: cases.length, ms: Date.now() - started };
  const saved = await db.one(
    `insert into eval_run (retriever, config, metrics, per_case) values ($1, $2, $3, $4) returning id, ran_at`,
    [retriever, config, metrics, JSON.stringify(perCase)]
  );
  log.info('eval run', { id: saved.id, retriever, cases: cases.length, ms: config.ms });
  return { id: saved.id, retriever, config, metrics, perCase, prev, delta: prev ? M.delta(prev.metrics, metrics) : null };
}

// The worker's pass. A no-op with no cases, and at most one run a day however
// often the worker restarts — every() fires once at startup.
async function nightly() {
  const n = await db.one('select count(*)::int as n from eval_case where active');
  if (!n.n) return null;
  const last = await previousRun('search');
  if (last && Date.now() - new Date(last.ran_at).getTime() < 20 * 3600_000) return null;
  return run({ retriever: 'search' });
}

module.exports = { run, nightly, listCases, addCase, setActive, activeCases, retrievers, metrics: M };
