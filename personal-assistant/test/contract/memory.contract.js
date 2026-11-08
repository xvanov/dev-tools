'use strict';

// Contract: src/repo/memory.js (see test/repoContract.test.js).

const ago = (ms) => new Date(Date.now() - ms);

module.exports = {
  'activeBlockers: active blocker claims about me of the last 21 days, newest first': async ({ repos, seed, db, assert }) => {
    const mk = (o) => seed.claim({ subjectKind: 'me', kind: 'blocker', ...o });
    const newer = await mk({ text: 'newer blocker', validAt: ago(1 * 86400_000) });
    const older = await mk({ text: 'older blocker', validAt: ago(10 * 86400_000) });
    await mk({ text: 'too old', validAt: ago(40 * 86400_000) });
    await mk({ text: 'retracted', status: 'retracted', validAt: ago(86400_000) });
    await mk({ text: 'not a blocker', kind: 'status', validAt: ago(86400_000) });
    await seed.claim({ subjectKind: 'topic', kind: 'blocker', text: 'about a topic', validAt: ago(86400_000) });
    const closed = await mk({ text: 'closed', validAt: ago(86400_000) });
    await db.query('update claim set invalid_at = now() where id = $1', [closed]);
    const all = await repos.memory.activeBlockers(new Date());
    assert.ok(all.length <= 3);
    const got = all.map((r) => Number(r.id));
    assert.ok(got.indexOf(newer) < got.indexOf(older) || !got.includes(older), 'newest first');
    assert.ok(all.every((r) => !['too old', 'retracted', 'not a blocker', 'about a topic', 'closed'].includes(r.text)));
    assert.ok('quote' in all[0]);
  },

  'activeForPerson: a person\'s active claims, newest first': async ({ repos, seed, assert }) => {
    const p = await seed.personWith();
    const a = await seed.claim({ subjectKind: 'person', subjectId: p, kind: 'role', text: 'lead', validAt: ago(2 * 86400_000) });
    const b = await seed.claim({ subjectKind: 'person', subjectId: p, kind: 'role', text: 'owner', validAt: ago(86400_000) });
    await seed.claim({ subjectKind: 'person', subjectId: p, kind: 'role', text: 'old', status: 'superseded' });
    await seed.claim({ subjectKind: 'person', subjectId: await seed.personWith(), kind: 'role', text: 'someone else' });
    const got = await repos.memory.activeForPerson(p);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.text]), [[b, 'owner'], [a, 'lead']]);
  },

  'insertTopicClaim: an audio claim about a topic, active, from a distill': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'audio' });
    const row = await repos.memory.insertTopicClaim({ label: 'weekly sync', kind: 'workflow', text: 'I get asked about X', quote: 'what about X', sourceItemId: item, validAt: '2099-01-01T10:00:00Z', extractedBy: 'meeting-learn-v1' });
    const r = await db.one('select * from claim where id = $1', [row.id]);
    assert.deepStrictEqual(
      [r.subject_kind, r.subject_id, r.subject_label, r.kind, r.text, r.quote, Number(r.source_item_id), r.source_kind, r.confidence, r.status, r.origin, r.extracted_by],
      ['topic', null, 'weekly sync', 'workflow', 'I get asked about X', 'what about X', item, 'audio', 0.8, 'active', 'distill', 'meeting-learn-v1']
    );
    assert.strictEqual(r.valid_at.toISOString(), '2099-01-01T10:00:00.000Z');
    const noItem = await repos.memory.insertTopicClaim({ label: 'l', kind: 'status', text: 't', quote: 'q', sourceItemId: null, validAt: '2099-01-01T10:00:00Z', extractedBy: 'v' });
    assert.ok(noItem.id);
  },

  'insertDebriefClaim: a claim about me or a topic from an audio item; returns its id': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'audio' });
    const p = await seed.personWith({ isMe: false });
    const id = await repos.memory.insertDebriefClaim({ subjectKind: 'me', subjectId: p, label: 'me', kind: 'status', text: 'I shipped it', quote: 'shipped', itemId: item, validAt: '2099-01-02T10:00:00Z', extractedBy: 'debrief-v1' });
    const r = await db.one('select * from claim where id = $1', [id]);
    assert.deepStrictEqual(
      [r.subject_kind, Number(r.subject_id), r.subject_label, r.kind, r.text, r.quote, Number(r.source_item_id), r.source_kind, r.status, r.origin, r.extracted_by],
      ['me', p, 'me', 'status', 'I shipped it', 'shipped', item, 'audio', 'active', 'distill', 'debrief-v1']
    );
    const topic = await repos.memory.insertDebriefClaim({ subjectKind: 'topic', label: 'a topic', kind: 'decision', text: 'we decided', quote: 'decided', itemId: item, validAt: '2099-01-02T10:00:00Z', extractedBy: 'debrief-v1' });
    assert.strictEqual((await db.one('select subject_id from claim where id = $1', [topic])).subject_id, null, 'subjectId defaults to null');
  },

  'retract: retracts a claim; a second call changes nothing': async ({ repos, seed, db, assert }) => {
    const id = await seed.claim({ text: 'to retract' });
    const other = await seed.claim({ text: 'stays' });
    await repos.memory.retract(id);
    const status = async (x) => (await db.one('select status from claim where id = $1', [x])).status;
    assert.deepStrictEqual([await status(id), await status(other)], ['retracted', 'active']);
    await repos.memory.retract(id);
    assert.strictEqual(await status(id), 'retracted');
  },
};
