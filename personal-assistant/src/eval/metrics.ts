'use strict';

// Retrieval metrics. Pure functions over id lists, no database, no model —
// every number the harness reports comes out of here, so it is the part that
// is unit-tested hardest.
//
// Relevance is binary: an item is gold or it is not. Graded relevance would
// need graded labels, and a label nobody can defend is worse than none.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const QTYPES = ['single_session', 'multi_session', 'temporal', 'knowledge_update', 'abstention'];

// Answerable questions are scored on ranking. Abstention is scored on whether
// the retriever stayed quiet, which is a different question with a different
// number, and averaging the two together would hide both.
function isAbstention(c: any) {
  return c.qtype === 'abstention' || (!(c.gold_item_ids || []).length && c.gold_answer == null);
}

function goldSet(gold: any) {
  return new Set((gold || []).map(String));
}

// Fraction of the gold set found in the top k.
function recallAtK(ranked: any, gold: any, k: number) {
  const g = goldSet(gold);
  if (!g.size) return null;
  const top = ranked.slice(0, k).map(String);
  let hit = 0;
  for (const id of new Set(top)) if (g.has(id)) hit++;
  return hit / g.size;
}

// Reciprocal rank of the first gold item anywhere in the list; 0 if none.
function mrr(ranked: any, gold: any) {
  const g = goldSet(gold);
  if (!g.size) return null;
  for (let i = 0; i < ranked.length; i++) if (g.has(String(ranked[i]))) return 1 / (i + 1);
  return 0;
}

// Binary nDCG: DCG over the top k against the best possible ordering of a gold
// set that size. Duplicates in `ranked` count once, at their first position.
function ndcgAtK(ranked: any, gold: any, k: number) {
  const g = goldSet(gold);
  if (!g.size) return null;
  const seen = new Set();
  let dcg = 0;
  ranked.slice(0, k).forEach((id: any, i: any) => {
    const key = String(id);
    if (g.has(key) && !seen.has(key)) {
      seen.add(key);
      dcg += 1 / Math.log2(i + 2);
    }
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(g.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return dcg / idcg;
}

/**
 * Scores one case against what a retriever returned.
 * @param {{id, qtype, gold_item_ids, gold_answer}} c
 * @param {Array<{id, score}>} results  best first
 * @param {{k:number, threshold:number}} opts
 */
function scoreCase(c: any, results: any, { k = 10, threshold = 0 }: { k?: number; threshold?: number } = {}) {
  const ranked = results.map((r: any) => r.id);
  const topScore = results.length ? Number(results[0].score) : null;
  const base = { id: c.id, qtype: c.qtype, top_score: topScore, returned: ranked.slice(0, k).map(Number) };
  if (isAbstention(c)) {
    // "Confident" means the best hit clears the threshold. An empty list is
    // the cleanest possible abstention.
    const confident = topScore != null && topScore >= threshold;
    return { ...base, abstention: true, abstained: !confident };
  }
  const firstHit = ranked.findIndex((id: any) => goldSet(c.gold_item_ids).has(String(id)));
  return {
    ...base,
    abstention: false,
    gold: (c.gold_item_ids || []).map(Number),
    first_hit: firstHit < 0 ? null : firstHit + 1,
    r5: recallAtK(ranked, c.gold_item_ids, 5),
    r10: recallAtK(ranked, c.gold_item_ids, 10),
    mrr: mrr(ranked, c.gold_item_ids),
    ndcg: ndcgAtK(ranked, c.gold_item_ids, k),
  };
}

function mean(xs: any) {
  const v = xs.filter((x: any) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a: any, b: any) => a + b, 0) / v.length : null;
}

// Rolls per-case scores up by qtype, plus an `all` row for the answerable
// cases. Abstention rows carry the mean top score alongside accuracy, and the
// answerable rows carry theirs too: the gap between those two numbers is what
// a threshold gets calibrated against.
function aggregate(perCase: any) {
  const groups = {};
  for (const s of perCase) ((groups as any)[s.qtype] = (groups as any)[s.qtype] || []).push(s);
  const out: any = {};
  const order = [...QTYPES, ...Object.keys(groups).filter((q) => !QTYPES.includes(q)).sort()];
  for (const qtype of order) {
    const list = (groups as any)[qtype];
    if (!list) continue;
    (out as any)[qtype] = rollup(list);
  }
  const answerable = perCase.filter((s: any) => !s.abstention);
  if (answerable.length) out.all = rollup(answerable);
  return out;
}

function rollup(list: any[]) {
  const abst = list.filter((s) => s.abstention);
  const ans = list.filter((s) => !s.abstention);
  const row: any = { n: list.length, mean_top_score: mean(list.map((s) => s.top_score)) };
  if (ans.length) {
    Object.assign(row, {
      r5: mean(ans.map((s) => s.r5)),
      r10: mean(ans.map((s) => s.r10)),
      mrr: mean(ans.map((s) => s.mrr)),
      ndcg: mean(ans.map((s) => s.ndcg)),
    });
  }
  if (abst.length) row.abstain_acc = abst.filter((s) => s.abstained).length / abst.length;
  const judged = list.filter((s) => typeof s.judge_correct === 'boolean');
  if (judged.length) row.judge_acc = judged.filter((s) => s.judge_correct).length / judged.length;
  return row;
}

// Per-qtype, per-metric difference against an earlier rollup. Only metrics
// present on both sides are compared; a qtype that appeared or vanished is
// reported as such rather than as a delta from zero.
const METRICS = ['r5', 'r10', 'mrr', 'ndcg', 'abstain_acc', 'judge_acc'];

function delta(prev: any, cur: any) {
  const out = {};
  for (const qtype of Object.keys(cur || {})) {
    const a = prev?.[qtype];
    const b = cur[qtype];
    if (!a) {
      (out as any)[qtype] = { new: true };
      continue;
    }
    const d: any = {};
    for (const m of METRICS) if (a[m] != null && b[m] != null) (d as any)[m] = b[m] - a[m];
    if (a.n !== b.n) d.n_was = a.n;
    (out as any)[qtype] = d;
  }
  return out;
}

function fmt(x: any) {
  return x == null ? '   -' : x.toFixed(2).padStart(4);
}

function fmtDelta(x: any) {
  if (x == null) return '';
  if (Math.abs(x) < 0.005) return '';
  return `${x > 0 ? '+' : ''}${x.toFixed(2)}`;
}

// The compact table `pa eval run` prints. With a delta, each cell carries its
// change from the previous run of the same retriever.
function formatTable(metrics: any, d: any = null) {
  const cols = [
    ['R@5', 'r5'],
    ['R@10', 'r10'],
    ['MRR', 'mrr'],
    ['nDCG', 'ndcg'],
    ['abst', 'abstain_acc'],
    ['judge', 'judge_acc'],
  ].filter(([, key]: any) => (Object.values(metrics) as any[]).some((row: any) => row[key] != null));
  const dw = d ? 6 : 0;
  const lines = [
    `${'qtype'.padEnd(18)}${'n'.padStart(4)}  ${cols.map(([h]: any) => h!.padStart(6) + ''.padEnd(dw)).join('')}  top`,
  ];
  for (const [qtype, row] of Object.entries(metrics) as [string, any][]) {
    const cells = cols.map(([, key]: any) => fmt(row[key]).padStart(6) + (d ? ` ${fmtDelta(d[qtype]?.[key])}`.padEnd(dw) : ''));
    const note = d && d[qtype]?.new ? '  (new)' : d && d[qtype]?.n_was != null ? `  (n was ${d[qtype].n_was})` : '';
    lines.push(
      `${qtype.padEnd(18)}${String(row.n).padStart(4)}  ${cells.join('')}  ${row.mean_top_score == null ? '-' : row.mean_top_score.toFixed(4)}${note}`
    );
  }
  return lines.join('\n');
}

module.exports = {
  QTYPES,
  METRICS,
  isAbstention,
  recallAtK,
  mrr,
  ndcgAtK,
  scoreCase,
  aggregate,
  delta,
  formatTable,
};
