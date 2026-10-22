'use strict';

// The eval harness's pure parts: metrics, rollups, deltas, the retriever
// registry, and the prompt helpers. No database — the numbers every later
// phase is judged by must be right before any of them run.

const assert = require('assert');
const M = require('../src/eval/metrics');
const P = require('../src/eval/prompts');
const retrievers = require('../src/eval/retrievers');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ---------------------------------------------------------------- metrics --

close(M.recallAtK([1, 2, 3], [3], 5), 1);
close(M.recallAtK([1, 2, 3], [3], 2), 0);
close(M.recallAtK([1, 2, 3, 4], [2, 4, 9], 10), 2 / 3);
close(M.recallAtK(['7', 8], [7, 8], 2), 1); // ids compare as strings: pg bigint arrives as text
close(M.recallAtK([5, 5, 5], [5, 6], 3), 0.5); // duplicates count once
assert.strictEqual(M.recallAtK([1], [], 5), null);

close(M.mrr([4, 5, 6], [6]), 1 / 3);
close(M.mrr([4, 5, 6], [5, 6]), 1 / 2);
close(M.mrr([4, 5, 6], [9]), 0);
assert.strictEqual(M.mrr([1], []), null);

close(M.ndcgAtK([1, 2], [1], 10), 1);
close(M.ndcgAtK([2, 1], [1], 10), 1 / Math.log2(3));
close(M.ndcgAtK([9, 9, 9], [1], 3), 0);
// two gold, found at ranks 1 and 3: (1 + 1/log2(4)) / (1 + 1/log2(3))
close(M.ndcgAtK([1, 8, 2], [1, 2], 10), (1 + 0.5) / (1 + 1 / Math.log2(3)));
close(M.ndcgAtK([1, 1, 2], [1, 2], 10), (1 + 0.5) / (1 + 1 / Math.log2(3)));

// ------------------------------------------------------------- scoreCase ---

const res = (...ids) => ids.map((id, i) => ({ id, score: 0.04 - i * 0.001 }));

const single = M.scoreCase({ id: 1, qtype: 'single_session', gold_item_ids: ['30'], gold_answer: 'x' }, res(10, 20, 30), { k: 10 });
assert.strictEqual(single.abstention, false);
assert.strictEqual(single.first_hit, 3);
close(single.r5, 1);
close(single.mrr, 1 / 3);
assert.deepStrictEqual(single.gold, [30]);

const absQuiet = M.scoreCase({ id: 2, qtype: 'abstention', gold_item_ids: [], gold_answer: null }, [{ id: 1, score: 0.016 }], { threshold: 0.03 });
assert.strictEqual(absQuiet.abstention, true);
assert.strictEqual(absQuiet.abstained, true);
close(absQuiet.top_score, 0.016);

const absLoud = M.scoreCase({ id: 3, qtype: 'abstention', gold_item_ids: [], gold_answer: null }, [{ id: 1, score: 0.035 }], { threshold: 0.03 });
assert.strictEqual(absLoud.abstained, false);

const absEmpty = M.scoreCase({ id: 4, qtype: 'abstention', gold_item_ids: [] }, [], { threshold: 0.03 });
assert.strictEqual(absEmpty.abstained, true);
assert.strictEqual(absEmpty.top_score, null);

// No gold and no answer is an abstention whatever the qtype says.
assert.ok(M.isAbstention({ qtype: 'single_session', gold_item_ids: [], gold_answer: null }));
assert.ok(!M.isAbstention({ qtype: 'single_session', gold_item_ids: [], gold_answer: 'yes' }));

// ------------------------------------------------------------- aggregate ---

const perCase = [
  M.scoreCase({ id: 1, qtype: 'single_session', gold_item_ids: [1] }, res(1, 2)),
  M.scoreCase({ id: 2, qtype: 'single_session', gold_item_ids: [9] }, res(1, 2)),
  M.scoreCase({ id: 3, qtype: 'temporal', gold_item_ids: [2] }, res(1, 2)),
  absQuiet,
  absLoud,
];
perCase[0].judge_correct = true;
perCase[1].judge_correct = false;
const agg = M.aggregate(perCase);
assert.deepStrictEqual(Object.keys(agg), ['single_session', 'temporal', 'abstention', 'all']);
assert.strictEqual(agg.single_session.n, 2);
close(agg.single_session.r5, 0.5);
close(agg.single_session.mrr, 0.5);
close(agg.single_session.judge_acc, 0.5);
close(agg.temporal.mrr, 0.5);
close(agg.abstention.abstain_acc, 0.5);
assert.strictEqual(agg.abstention.r5, undefined);
assert.strictEqual(agg.all.n, 3); // answerable only
close(agg.all.mrr, (1 + 0 + 0.5) / 3);
close(agg.abstention.mean_top_score, (0.016 + 0.035) / 2);

// ----------------------------------------------------------------- delta ---

const d = M.delta(
  { single_session: { n: 2, r5: 0.25, mrr: 0.5 }, temporal: { n: 1, mrr: 1 } },
  { single_session: { n: 3, r5: 0.5, mrr: 0.5 }, temporal: { n: 1, mrr: 0.5 }, abstention: { n: 2, abstain_acc: 1 } }
);
close(d.single_session.r5, 0.25);
close(d.single_session.mrr, 0);
assert.strictEqual(d.single_session.n_was, 2);
close(d.temporal.mrr, -0.5);
assert.deepStrictEqual(d.abstention, { new: true });

const table = M.formatTable(agg, M.delta(agg, agg));
assert.ok(/^qtype/.test(table));
assert.ok(table.includes('single_session'));
assert.ok(table.includes('abst'));
assert.ok(!table.includes('NaN'));
assert.ok(M.formatTable(agg).split('\n').length === 5);

// -------------------------------------------------------------- registry ---

assert.ok(retrievers.names().includes('search'));
assert.ok(retrievers.get('search').threshold > 0);
retrievers.register('fake', async () => [{ id: 1, score: 1 }], { threshold: 0.5 });
assert.strictEqual(retrievers.get('fake').threshold, 0.5);
assert.throws(() => retrievers.get('nope'), /no retriever "nope"/);

// --------------------------------------------------------------- prompts ---

const alloc = P.allocate(60);
assert.strictEqual(Object.values(alloc).reduce((a, b) => a + b, 0), 60);
assert.ok(alloc.single_session >= alloc.temporal);
for (const n of [1, 5, 13, 100]) {
  assert.strictEqual(Object.values(P.allocate(n)).reduce((a, b) => a + b, 0), n);
}

const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
const pool = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: i, source: 'graph_mail', occurred_at: day(i % 2) })),
  { id: 100, source: 'github_pr', occurred_at: day(0) },
  { id: 101, source: 'github_pr', occurred_at: day(30) },
  { id: 200, source: 'graph_chat', occurred_at: day(0) },
];
const picked = P.spread(pool, 6);
assert.strictEqual(picked.length, 6);
assert.deepStrictEqual(new Set(picked.slice(0, 3).map((p) => p.source)), new Set(['graph_mail', 'github_pr', 'graph_chat']));
assert.strictEqual(P.spread(pool, 50).length, pool.length);

assert.strictEqual(P.parseCaseReply({ skip: true }, { qtype: 'single_session', itemIds: [1] }), null);
assert.strictEqual(P.parseCaseReply({ question: 'short', answer: 'x' }, { itemIds: [1] }), null);
const ok = P.parseCaseReply(
  { question: 'What did Brannoc want changed in the retry policy?', answer: 'Exponential backoff.' },
  { qtype: 'single_session', itemIds: [42] }
);
assert.deepStrictEqual(ok.gold, [42]);
const multi = P.parseCaseReply(
  { question: 'What has Quill asked me for across the export work?', answer: 'a and b', uses: [7, 8, 99] },
  { qtype: 'multi_session', itemIds: [7, 8, 9] }
);
assert.deepStrictEqual(multi.gold, [7, 8]); // ids outside the shown items are dropped
assert.strictEqual(
  P.parseCaseReply({ question: 'What has Quill asked me for lately overall?', answer: 'a', uses: [7] }, { qtype: 'multi_session', itemIds: [7, 8] }),
  null
);

assert.ok(P.subjectOverlap('Quarterly invoice export retry failing', 'Invoice export retry failing') > 0.6);
assert.ok(P.subjectOverlap('Why did the nightly job stop sending summaries?', 'Invoice export retry failing') < 0.2);

const prompt = P.casePrompt('temporal', [
  { id: 5, source: 'graph_event', subject: 'Planning with Brannoc', occurred_at: day(3), body_text: 'agenda', commitments: ['send notes'], facts: [] },
]);
assert.ok(prompt.includes('item #5'));
assert.ok(prompt.includes('commitment: send notes'));
assert.throws(() => P.casePrompt('nonsense', []), /no prompt/);
assert.ok(P.gradePrompt([{ i: 0, question: 'q', reference: null, answer: 'UNKNOWN' }]).includes('NONE'));

console.log('eval ok');
