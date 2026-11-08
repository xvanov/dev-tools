'use strict';

// Contract: src/repo/evals.js (see test/repoContract.test.js). The corpus
// samples are random; the cases check membership and the rules, not order.

const body = (w) => `${w} `.repeat(30);
const fact = (db, itemId, summary = 'a fact') => db.query(
  `insert into fact (source_item_id, kind, summary, occurred_at, extracted_by) values ($1, 'decision', $2, now(), 'contract-seed')`, [itemId, summary]);

async function chunked(seed, o = {}) {
  const id = await seed.item({ source: 'graph_mail', body: body(o.word || 'text'), ...o });
  await seed.memChunk(id, { content: o.content || body(o.word || 'text') });
  return id;
}

module.exports = {
  'insertCase: as of now, returns id and qtype; gold kept as bigint[]': async ({ repos, seed, assert }) => {
    const item = await seed.item({ source: 'graph_mail' });
    const row = await repos.evals.insertCase({ question: 'Q?', qtype: 'single_session', gold: [item], answer: 'A', origin: 'miss', notes: 'n' });
    assert.deepStrictEqual(row.qtype, 'single_session');
    const c = (await repos.evals.listCases({ all: true })).find((x) => String(x.id) === String(row.id));
    assert.deepStrictEqual([c.question, c.gold_item_ids.map(Number), c.gold_answer, c.origin, c.active, c.notes], ['Q?', [item], 'A', 'miss', true, 'n']);
  },

  'insertGenerated: origin generated; resolves the id': async ({ repos, assert }) => {
    const id = await repos.evals.insertGenerated({ question: 'G?', qtype: 'abstention', gold_item_ids: [], gold_answer: null, notes: 'absent term: x' });
    const c = (await repos.evals.listCases({ all: true })).find((x) => String(x.id) === String(id));
    assert.deepStrictEqual([c.origin, c.qtype, c.gold_item_ids], ['generated', 'abstention', []]);
  },

  'activeCases: active ones by id, with as_of': async ({ repos, assert }) => {
    const a = await repos.evals.insertCase({ question: 'on', qtype: 'abstention', gold: [], answer: null, origin: 'miss', notes: null });
    const b = await repos.evals.insertCase({ question: 'off', qtype: 'abstention', gold: [], answer: null, origin: 'miss', notes: null });
    await repos.evals.setActive(b.id, false);
    const list = await repos.evals.activeCases();
    assert.ok(list.some((c) => String(c.id) === String(a.id)) && !list.some((c) => String(c.id) === String(b.id)));
    assert.ok(list.find((c) => String(c.id) === String(a.id)).as_of instanceof Date);
    assert.deepStrictEqual(list.map((c) => Number(c.id)), list.map((c) => Number(c.id)).sort((x, y) => x - y));
  },

  'listCases: all or active, by qtype': async ({ repos, assert }) => {
    const t = await repos.evals.insertCase({ question: 'when?', qtype: 'temporal', gold: [], answer: null, origin: 'miss', notes: null });
    await repos.evals.setActive(t.id, false);
    assert.ok(!(await repos.evals.listCases()).some((c) => String(c.id) === String(t.id)));
    const all = await repos.evals.listCases({ all: true, qtype: 'temporal' });
    assert.ok(all.some((c) => String(c.id) === String(t.id)) && all.every((c) => c.qtype === 'temporal'));
  },

  'activeCount: how many are active': async ({ repos, assert }) => {
    const before = (await repos.evals.activeCount()).n;
    await repos.evals.insertCase({ question: 'n', qtype: 'abstention', gold: [], answer: null, origin: 'miss', notes: null });
    assert.strictEqual((await repos.evals.activeCount()).n, before + 1);
  },

  'setActive: true when the case exists': async ({ repos, assert }) => {
    const c = await repos.evals.insertCase({ question: 's', qtype: 'abstention', gold: [], answer: null, origin: 'miss', notes: null });
    assert.strictEqual(await repos.evals.setActive(c.id, false), true);
    assert.strictEqual(await repos.evals.setActive(-1, false), false);
  },

  'usedGold: gold items of active cases only': async ({ repos, seed, assert }) => {
    const [a, b] = [await seed.item({ source: 'graph_mail' }), await seed.item({ source: 'graph_mail' })];
    await repos.evals.insertCase({ question: 'u', qtype: 'single_session', gold: [a], answer: null, origin: 'miss', notes: null });
    const off = await repos.evals.insertCase({ question: 'v', qtype: 'single_session', gold: [b], answer: null, origin: 'miss', notes: null });
    await repos.evals.setActive(off.id, false);
    const used = await repos.evals.usedGold();
    assert.ok(used.includes(a) && !used.includes(b));
  },

  'previousRun: the newest run of a retriever, or null': async ({ repos, assert, uniq }) => {
    const r = uniq('retr');
    assert.strictEqual(await repos.evals.previousRun(r), null);
    await repos.evals.insertRun({ retriever: r, config: { k: 5 }, metrics: { recall: 0.5 }, perCase: [] });
    await new Promise((x) => setTimeout(x, 5));
    const b = await repos.evals.insertRun({ retriever: r, config: { k: 10 }, metrics: { recall: 0.7 }, perCase: [{ id: 1 }] });
    const prev = await repos.evals.previousRun(r);
    assert.deepStrictEqual([String(prev.id), prev.metrics, prev.config], [String(b.id), { recall: 0.7 }, { k: 10 }]);
  },

  'insertRun: id and ran_at': async ({ repos, assert, uniq }) => {
    const row = await repos.evals.insertRun({ retriever: uniq('r'), config: {}, metrics: {}, perCase: [{ id: 2, hit: true }] });
    assert.ok(row.id && row.ran_at instanceof Date);
  },

  'existingItems: the ids that are items': async ({ repos, seed, assert }) => {
    const a = await seed.item({ source: 'graph_mail' });
    assert.deepStrictEqual((await repos.evals.existingItems([a, -1])).map((r) => Number(r.id)), [a]);
  },

  'itemsForJudge: the asked-for items': async ({ repos, seed, assert }) => {
    const a = await seed.item({ source: 'graph_mail', subject: 'J', body: 'judge me' });
    const [row] = await repos.evals.itemsForJudge([a]);
    assert.deepStrictEqual([Number(row.id), row.subject, row.body_text], [a, 'J', 'judge me']);
  },

  'sample: chunked items with a body, not excluded; boosts are named, never SQL': async ({ repos, seed, assert }) => {
    const ok = await chunked(seed);
    const excluded = await chunked(seed);
    const short = await seed.item({ source: 'graph_mail', body: 'tiny' });
    await seed.memChunk(short, { content: 'tiny' });
    const unchunked = await seed.item({ source: 'graph_mail', body: body('none') });
    const ids = (await repos.evals.sample({ exclude: [excluded], limit: 100000 })).map((r) => Number(r.id));
    assert.ok(ids.includes(ok) && !ids.includes(excluded) && !ids.includes(short) && !ids.includes(unchunked));
    assert.ok((await repos.evals.sample({ exclude: [], limit: 100000, boost: 'temporal' })).some((r) => Number(r.id) === ok));
    await assert.rejects(repos.evals.sample({ exclude: [], limit: 1, boost: 'true) or (1=1' }), /unknown sample boost/);
  },

  'itemsWithFacts: items with their commitments and facts as text': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'graph_mail' });
    const c = await seed.commitment({ sourceItemId: item, summary: 'send it' });
    await seed.updateCommitment(c, { due_at: new Date('2026-12-01T12:00:00Z') });
    await fact(db, item, 'we chose B');
    const [row] = await repos.evals.itemsWithFacts([item]);
    assert.deepStrictEqual([row.commitments, row.facts], [['send it (due 2026-12-01)'], ['decision: we chose B']]);
    const [bare] = await repos.evals.itemsWithFacts([await seed.item({ source: 'graph_mail' })]);
    assert.deepStrictEqual([bare.commitments, bare.facts], [[], []]);
  },

  'threadPairs: earlier and later in one thread, both chunked, with a fact or commitment': async ({ repos, seed, db, assert, uniq }) => {
    const thr = uniq('thr');
    const a = await chunked(seed, { thread: thr, occurredAt: new Date(Date.now() - 7200_000) });
    const b = await chunked(seed, { thread: thr, occurredAt: new Date(Date.now() - 3600_000) });
    await fact(db, b);
    const pairs = await repos.evals.threadPairs({ exclude: [], limit: 100000 });
    assert.ok(pairs.some((p) => Number(p.earlier) === a && Number(p.later) === b));
    assert.ok(!(await repos.evals.threadPairs({ exclude: [b], limit: 100000 })).some((p) => Number(p.later) === b));
  },

  'sharedGroups: items of one counterparty across threads': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.personWith({ name: 'Group Person' });
    const ids = [];
    for (const t of [uniq('t'), uniq('t')]) {
      const item = await chunked(seed, { thread: t });
      const c = await seed.commitment({ sourceItemId: item });
      await seed.updateCommitment(c, { counterparty_person_id: p });
      ids.push(item);
    }
    const g = (await repos.evals.sharedGroups({ exclude: [], limit: 100000 })).find((x) => x.key === `person:${p}`);
    assert.deepStrictEqual(g.ids.map(Number).sort(), ids.sort());
  },

  'threadKeys: thread id, else the item id': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('thr');
    const a = await seed.item({ source: 'graph_mail', thread: thr });
    const b = await seed.item({ source: 'graph_mail' });
    const keys = new Map((await repos.evals.threadKeys([a, b])).map((r) => [Number(r.id), r.t]));
    assert.deepStrictEqual([keys.get(a), keys.get(b)], [thr, String(b)]);
  },

  'fullTextHit: a whole English word in a chunk or subject': async ({ repos, seed, assert, uniq }) => {
    const word = uniq('zebrafish').replace(/-/g, '');
    assert.strictEqual((await repos.evals.fullTextHit(word)).hit, false);
    await seed.item({ source: 'graph_mail', subject: `About ${word} today` });
    assert.strictEqual((await repos.evals.fullTextHit(word)).hit, true);
  },

  'sampleSubjects: distinct subjects of 8 to 140 characters, at most 400': async ({ repos, seed, assert, uniq }) => {
    const s = uniq('A subject line');
    await seed.item({ source: 'graph_mail', subject: s });
    await seed.item({ source: 'graph_mail', subject: s });
    await seed.item({ source: 'graph_mail', subject: 'short' });
    const list = (await repos.evals.sampleSubjects()).map((r) => r.subject);
    assert.ok(list.length <= 400);
    assert.ok(!list.includes('short'));
    assert.strictEqual(new Set(list).size, list.length);
  },
};
