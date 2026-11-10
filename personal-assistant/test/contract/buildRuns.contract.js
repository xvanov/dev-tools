'use strict';

// Contract: src/repo/buildRuns.ts (see test/repoContract.test.js).

const mk = (task) => ({ task, model: 'sonnet', repoPath: null, machine: 'm', costCapUsd: 5, wallCapMin: 120 });

module.exports = {
  'insert: a starting run with its caps': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert({ ...mk('write a doc'), commitmentId: 7 });
    assert.strictEqual(r.state, 'starting');
    assert.deepStrictEqual([r.task, r.model, Number(r.cost_cap_usd), Number(r.wall_cap_min), Number(r.cost_usd)], ['write a doc', 'sonnet', 5, 120, 0]);
  },

  'byId: the row, or null': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('by id'));
    assert.strictEqual((await repos.buildRuns.byId(r.id)).id, r.id);
    assert.strictEqual(await repos.buildRuns.byId(999999), null);
  },

  'update: sets named columns, refuses an unknown one': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert({ ...mk('live one'), commitmentId: 4242 });
    await repos.buildRuns.update(r.id, { state: 'running', cost_usd: 0.25, tokens_in: 10, session_id: 's1' });
    const u = await repos.buildRuns.byId(r.id);
    assert.deepStrictEqual([u.state, Number(u.cost_usd), Number(u.tokens_in), u.session_id], ['running', 0.25, 10, 's1']);
    await assert.rejects(() => repos.buildRuns.update(r.id, { bogus: 1 }), /no settable column/);
  },

  'liveForCommitment: follows state': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert({ ...mk('live one'), commitmentId: 4243 });
    assert.strictEqual((await repos.buildRuns.liveForCommitment(4243)).id, r.id);
    await repos.buildRuns.update(r.id, { state: 'done', result: 'ok' });
    assert.strictEqual(await repos.buildRuns.liveForCommitment(4243), null);
  },

  'list: newest first, live filter': async ({ repos, assert }) => {
    const a = await repos.buildRuns.insert(mk('a'));
    const b = await repos.buildRuns.insert(mk('b'));
    await repos.buildRuns.update(a.id, { state: 'done' });
    const all = await repos.buildRuns.list({ limit: 10 });
    assert.deepStrictEqual(all.slice(0, 2).map((x) => x.id), [b.id, a.id]);
    const live = await repos.buildRuns.list({ live: true });
    assert.ok(live.every((x) => ['starting', 'running', 'waiting'].includes(x.state)));
  },

  'count: all runs, or the live ones': async ({ repos, assert }) => {
    const a = await repos.buildRuns.insert(mk('c'));
    assert.ok(await repos.buildRuns.count() >= 1);
    assert.ok(await repos.buildRuns.count({ live: true }) >= 1);
    await repos.buildRuns.update(a.id, { state: 'failed' });
  },

  'addMsg: appends a note; an ask opens': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('msgs'));
    await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'note', body: 'hello' });
    const ask = await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'ask', body: 'which?' });
    assert.ok((await repos.buildRuns.openAsks()).some((m) => m.id === ask.id));
  },

  'answer: stores the answer once': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('ans'));
    const ask = await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'ask', body: 'which?' });
    assert.strictEqual(await repos.buildRuns.answer(ask.id, 'the first'), 1);
    assert.strictEqual(await repos.buildRuns.answer(ask.id, 'again'), 0);
    const back = await repos.buildRuns.msgById(ask.id);
    assert.deepStrictEqual([back.answer, typeof back.answered_at], ['the first', 'string']);
    assert.ok(!(await repos.buildRuns.openAsks()).some((m) => m.id === ask.id));
  },

  'msgById: the message, or null': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('m1'));
    const m = await repos.buildRuns.addMsg({ runId: r.id, dir: 'jarvis', kind: 'send', body: 'hi' });
    assert.strictEqual((await repos.buildRuns.msgById(m.id)).body, 'hi');
    assert.strictEqual(await repos.buildRuns.msgById(999999), null);
  },

  'msgs: one run, oldest first': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('m2'));
    await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'note', body: 'a' });
    await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'ask', body: 'b' });
    assert.deepStrictEqual((await repos.buildRuns.msgs(r.id)).map((m) => m.kind), ['note', 'ask']);
  },

  'msgsFor: several runs at once; none gives none': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('m3'));
    await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'note', body: 'a' });
    assert.strictEqual((await repos.buildRuns.msgsFor([r.id])).length, 1);
    assert.deepStrictEqual(await repos.buildRuns.msgsFor([]), []);
  },

  'openAsks: unanswered asks only': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert(mk('m4'));
    const ask = await repos.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'ask', body: 'q' });
    assert.ok((await repos.buildRuns.openAsks()).some((m) => m.id === ask.id));
  },
};
