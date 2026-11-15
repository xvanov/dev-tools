'use strict';

// Contract: src/repo/turns.ts (see test/repoContract.test.js).

module.exports = {
  'insert: an open turn with the given columns': async ({ repos, assert }) => {
    const t = await repos.turns.insert({ channel: 'voice', text: 'what is next', set: { router: 'decision', route: 'answer', p: '{"answer_here":0.9}', decision_ms: 210 } });
    assert.deepStrictEqual([t.channel, t.text, t.router, t.route, t.status, Number(t.decision_ms), Number(t.handed_off)], ['voice', 'what is next', 'decision', 'answer', 'open', 210, 0]);
    assert.strictEqual(typeof t.at, 'string');
    await assert.rejects(() => repos.turns.insert({ channel: 'fax', text: 'x' }), /channel must be/);
    await assert.rejects(() => repos.turns.insert({ channel: 'typed', text: 'x', set: { id: 1 } }), /no settable column/);
  },

  'update: named columns only': async ({ repos, assert }) => {
    const t = await repos.turns.insert({ channel: 'typed', text: 'hi' });
    assert.strictEqual(await repos.turns.update(t.id, { reply: 'hello', tools: '["a"]', status: 'done', chat_cost_usd: 0.012 }), 1);
    const u = await repos.turns.byId(t.id);
    assert.deepStrictEqual([u.reply, u.tools, u.status], ['hello', '["a"]', 'done']);
    assert.ok(Math.abs(Number(u.chat_cost_usd) - 0.012) < 1e-9);
    await assert.rejects(() => repos.turns.update(t.id, { text: 'no' }), /no settable column/);
    await assert.rejects(() => repos.turns.update(t.id, {}), /no settable column/);
    assert.strictEqual(await repos.turns.update(999999, { status: 'done' }), 0);
  },

  'byId: the row, or null': async ({ repos, assert }) => {
    const t = await repos.turns.insert({ channel: 'doorbell', text: 'the bell rang' });
    assert.strictEqual((await repos.turns.byId(t.id)).text, 'the bell rang');
    assert.strictEqual(await repos.turns.byId(999999), null);
  },

  'list: newest first, filters, paging': async ({ repos, assert, uniq }) => {
    const w = uniq('word');
    const a = await repos.turns.insert({ channel: 'voice', text: `first ${w}`, set: { route: 'answer' } });
    const b = await repos.turns.insert({ channel: 'typed', text: 'second' });
    await repos.turns.update(b.id, { reply: `the ${w.toUpperCase()} answer` });
    const c = await repos.turns.insert({ channel: 'voice', text: 'third', set: { route: 'handoff' } });
    assert.deepStrictEqual((await repos.turns.list({ limit: 3 })).map((r) => Number(r.id)), [c.id, b.id, a.id].map(Number));
    assert.deepStrictEqual((await repos.turns.list({ q: w })).map((r) => Number(r.id)), [b.id, a.id].map(Number), 'q matches words and the answer, any case');
    assert.ok((await repos.turns.list({ channel: 'voice', limit: 50 })).every((r) => r.channel === 'voice'));
    assert.ok((await repos.turns.list({ route: 'handoff', limit: 50 })).every((r) => r.route === 'handoff'));
    assert.deepStrictEqual((await repos.turns.list({ before: c.id, limit: 1 })).map((r) => Number(r.id)), [Number(b.id)]);
    assert.strictEqual((await repos.turns.list({ since: '2999-01-01T00:00:00.000Z' })).length, 0);
  },

  'openBefore: open turns older than a time': async ({ repos, assert }) => {
    const old = await repos.turns.insert({ channel: 'typed', text: 'old', at: '2001-01-01T00:00:00.000Z' });
    const shut = await repos.turns.insert({ channel: 'typed', text: 'old done', at: '2001-01-01T00:00:01.000Z' });
    await repos.turns.update(shut.id, { status: 'done' });
    const ids = (await repos.turns.openBefore('2001-01-02T00:00:00.000Z')).map((r) => Number(r.id));
    assert.ok(ids.includes(Number(old.id)));
    assert.ok(!ids.includes(Number(shut.id)));
  },

  'prune: deletes turns older than a time': async ({ repos, assert }) => {
    const old = await repos.turns.insert({ channel: 'typed', text: 'ancient', at: '2000-01-01T00:00:00.000Z' });
    const now = await repos.turns.insert({ channel: 'typed', text: 'recent' });
    assert.ok((await repos.turns.prune('2000-06-01T00:00:00.000Z')) >= 1);
    assert.strictEqual(await repos.turns.byId(old.id), null);
    assert.ok(await repos.turns.byId(now.id));
  },
};
