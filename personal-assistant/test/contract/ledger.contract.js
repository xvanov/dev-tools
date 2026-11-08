'use strict';

// Contract: src/repo/ledger.js (see test/repoContract.test.js).

const T = (o) => ({ from: 'open', to: 'done', actor: 'reconcile', reason: 'merged', evidenceId: null, before: { status: 'open', closed_at: null, closed_reason: null }, at: new Date().toISOString(), ...o });

module.exports = {
  'lockCommitment: its status columns inside a transaction; null when missing': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const row = await repos.withTx((r) => r.ledger.lockCommitment(c));
    assert.deepStrictEqual([Number(row.id), row.status, row.closed_at, row.closed_reason], [c, 'open', null, null]);
    assert.ok('touched_at' in row);
    assert.strictEqual(await repos.withTx((r) => r.ledger.lockCommitment(-1)), null);
  },

  'setCommitment: writes the status columns, refuses any other': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const at = new Date('2026-11-01T10:00:00Z');
    await repos.ledger.setCommitment(c, { status: 'done', closed_at: at, closed_reason: 'shipped', touched_at: at });
    const row = await repos.withTx((r) => r.ledger.lockCommitment(c));
    assert.deepStrictEqual([row.status, row.closed_at.toISOString(), row.closed_reason], ['done', at.toISOString(), 'shipped']);
    await assert.rejects(repos.ledger.setCommitment(c, { summary: 'x' }), /does not write commitment.summary/);
  },

  'insertTransition: returns the id; before kept as json': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await repos.ledger.insertTransition(T({ commitmentId: c }));
    assert.ok(Number.isInteger(id) && id > 0);
    const row = await repos.withTx((r) => r.ledger.lockTransition(id));
    assert.deepStrictEqual([Number(row.commitment_id), row.from_status, row.to_status, row.actor, row.reason, row.undone_at], [c, 'open', 'done', 'reconcile', 'merged', null]);
    assert.deepStrictEqual(row.before, { status: 'open', closed_at: null, closed_reason: null });
  },

  'lockTransition: null when missing': async ({ repos, assert }) => {
    assert.strictEqual(await repos.withTx((r) => r.ledger.lockTransition(-1)), null);
  },

  'markUndone: stamps undone_at and the result': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await repos.ledger.insertTransition(T({ commitmentId: c }));
    await repos.ledger.markUndone(id, 'changed since; left as it is');
    const row = await repos.withTx((r) => r.ledger.lockTransition(id));
    assert.ok(row.undone_at instanceof Date);
    assert.strictEqual(row.undo, 'changed since; left as it is');
  },

  'latest: the newest change not undone; null when none': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    assert.strictEqual(await repos.ledger.latest(c), null);
    const a = await repos.ledger.insertTransition(T({ commitmentId: c, at: '2026-11-01T10:00:00Z' }));
    const b = await repos.ledger.insertTransition(T({ commitmentId: c, from: 'done', to: 'open', at: '2026-11-02T10:00:00Z' }));
    assert.strictEqual(Number((await repos.ledger.latest(c)).id), b);
    await repos.ledger.markUndone(b, 'undone');
    assert.strictEqual(Number((await repos.ledger.latest(c)).id), a);
  },

  'dirty: an open ask with a new item in its thread, until it is marked checked': async ({ repos, seed, db, assert }) => {
    const ask = await seed.sourceItem({ thread: 'thr-dirty', body: 'can you send the deck?', occurredAt: new Date(Date.now() - 3600_000) });
    const c = await seed.commitment({ sourceItemId: ask });
    const reply = await seed.sourceItem({ thread: 'thr-dirty', body: 'sent it this morning', occurredAt: new Date(Date.now() - 60_000) });
    const elsewhere = await seed.sourceItem({ thread: 'thr-other', body: 'unrelated message text' });
    const list = await repos.ledger.dirty({ myForms: ['me'], limit: 50, perCommitment: 10, ids: [c] });
    assert.strictEqual(list.length, 1);
    const d = list[0];
    assert.deepStrictEqual([Number(d.id), d.summary, d.ask_text], [c, 'a seeded ask', 'can you send the deck?']);
    assert.ok(d.item_ids.map(Number).includes(reply) && !d.item_ids.map(Number).includes(elsewhere));
    assert.ok(d.through instanceof Date);
    // Only these ids; and a closed ask is never dirty.
    const other = await seed.commitment();
    assert.ok(!(await repos.ledger.dirty({ myForms: ['me'], limit: 50, perCommitment: 10, ids: [other] })).some((x) => Number(x.id) === c));
    await repos.ledger.markChecked(c, d.item_ids);
    assert.deepStrictEqual(await repos.ledger.dirty({ myForms: ['me'], limit: 50, perCommitment: 10, ids: [c] }), [], 'judged through its newest item');
    await db.query(`update commitment set status = 'done' where id = $1`, [c]);
    await seed.sourceItem({ thread: 'thr-dirty', body: 'one more reply here' });
    assert.deepStrictEqual(await repos.ledger.dirty({ myForms: ['me'], limit: 50, perCommitment: 10, ids: [c] }), []);
  },

  'dirty: items fetched together are cut by id; the ask counts once its text was repaired': async ({ repos, seed, db, assert }) => {
    const thread = `thr-tie-${Date.now()}`;
    const ask = await seed.sourceItem({ thread, body: 'can you review the plan?', occurredAt: new Date(Date.now() - 3600_000) });
    const c = await seed.commitment({ sourceItemId: ask });
    const b = await seed.sourceItem({ thread, body: 'second reply of the batch', occurredAt: new Date(Date.now() - 60_000) });
    const a = await seed.sourceItem({ thread, body: 'first reply of the batch', occurredAt: new Date(Date.now() - 120_000) });
    await db.query('update source_item set fetched_at = $1 where id in ($2, $3, $4)', [new Date(Date.now() - 30_000), ask, a, b]);
    const items = async (perCommitment) => (await repos.ledger.dirty({ myForms: ['me'], limit: 50, perCommitment, ids: [c] }))[0].item_ids.map(Number);
    assert.deepStrictEqual(await items(10), [b, a], 'not the ask itself; same fetched_at, lower id first');
    assert.deepStrictEqual(await items(1), [b]);
    await db.query(`update source_item set raw = '{"repaired": true}' where id = $1`, [ask]);
    assert.deepStrictEqual(await items(10), [ask, b, a]);
  },

  'markChecked: never moves back, and ignores items it cannot find': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    const late = await seed.sourceItem();
    await repos.ledger.markChecked(c, [late]);
    const at = (await db.one('select ledger_checked_at from commitment where id = $1', [c])).ledger_checked_at;
    assert.ok(at instanceof Date);
    await db.query(`update source_item set fetched_at = now() - interval '1 day' where id = $1`, [late]);
    const early = await seed.sourceItem();
    await db.query(`update source_item set fetched_at = now() - interval '2 days' where id = $1`, [early]);
    await repos.ledger.markChecked(c, [early]);
    await repos.ledger.markChecked(c, [-1]);
    assert.strictEqual((await db.one('select ledger_checked_at from commitment where id = $1', [c])).ledger_checked_at.getTime(), at.getTime());
  },

  'reopenedByYou: commitments you reopened, not undone': async ({ repos, seed, assert }) => {
    const [a, b, c] = [await seed.commitment(), await seed.commitment(), await seed.commitment()];
    await seed.transition(a, { actor: 'you', from: 'done', to: 'open' });
    await seed.transition(b, { actor: 'you', from: 'done', to: 'open', undoneAt: new Date() });
    await seed.transition(c, { actor: 'reconciler', from: 'done', to: 'open' });
    const s = await repos.ledger.reopenedByYou([a, b, c]);
    assert.deepStrictEqual([...s], [String(a)]);
  },

  'upsertEvidence: one row per (commitment, item, judge version), updated in place': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const item = await seed.sourceItem();
    const e = { commitmentId: c, sourceItemId: item, effect: 'progresses', quote: 'working on it', confidence: 0.5, extractedBy: 'judge-v1' };
    const id = await repos.ledger.upsertEvidence(e);
    const again = await repos.ledger.upsertEvidence({ ...e, effect: 'closes', quote: 'done now', confidence: 0.95 });
    assert.strictEqual(again, id);
    const row = await repos.ledger.evidenceById(id);
    assert.deepStrictEqual([row.effect, row.quote, Number(row.confidence), row.method, row.applied], ['closes', 'done now', 0.95, 'llm', false]);
    assert.notStrictEqual(await repos.ledger.upsertEvidence({ ...e, extractedBy: 'judge-v2' }), id, 'a new judge version is a new row');
  },

  'markEvidenceApplied: applied': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await seed.evidence(c, { quote: 'q' });
    await repos.ledger.markEvidenceApplied(id);
    assert.strictEqual((await repos.ledger.evidenceById(id)).applied, true);
  },

  'proposals: confident closes not applied or decided, newest per open commitment, on the survivor': async ({ repos, seed, db, assert }) => {
    const survivor = await seed.commitment({ summary: 'survivor' });
    const copy = await seed.commitment({ summary: 'copy' });
    await db.query('update commitment set superseded_by = $2 where id = $1', [copy, survivor]);
    const item = await seed.sourceItem();
    await seed.evidence(survivor, { effect: 'closes', quote: 'older', confidence: 0.9, sourceItemId: item });
    await new Promise((r) => setTimeout(r, 5));
    const onCopy = await seed.evidence(copy, { effect: 'moot', quote: 'newer on the copy', confidence: 0.9 });
    const weak = await seed.commitment();
    await seed.evidence(weak, { effect: 'closes', quote: 'maybe', confidence: 0.1 });
    const decided = await seed.commitment();
    const d = await seed.evidence(decided, { effect: 'closes', quote: 'no', confidence: 0.9 });
    await repos.ledger.decideEvidence(d, 'rejected', false);
    const list = await repos.ledger.proposals({ limit: 1000, minConfidence: 0.6 });
    const mine = list.filter((p) => [survivor, copy, weak, decided].includes(Number(p.commitment_id)));
    assert.deepStrictEqual(mine.map((p) => [Number(p.commitment_id), Number(p.id), p.summary]), [[survivor, onCopy, 'survivor']]);
  },

  'evidenceById: the row, or null': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await seed.evidence(c, { quote: 'x' });
    assert.strictEqual(Number((await repos.ledger.evidenceById(id)).commitment_id), c);
    assert.strictEqual(await repos.ledger.evidenceById(-1), null);
  },

  'decideEvidence: decision, time and applied': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await seed.evidence(c, { quote: 'x' });
    await repos.ledger.decideEvidence(id, 'accepted', true);
    const row = await repos.ledger.evidenceById(id);
    assert.deepStrictEqual([row.decision, row.applied], ['accepted', true]);
    assert.ok(row.decided_at instanceof Date);
  },

  'reconcileStats: closes, closes you reopened, open proposals, newest evidence': async ({ repos, seed, assert }) => {
    const before = await repos.ledger.reconcileStats();
    const c = await seed.commitment();
    await seed.transition(c, { actor: 'reconciler', to: 'done', at: new Date(Date.now() - 60_000) });
    await seed.transition(c, { actor: 'you', from: 'done', to: 'open' });
    await seed.pendingEvidence(c, { effect: 'closes', quote: 'p', confidence: 0.9 });
    const after = await repos.ledger.reconcileStats();
    assert.deepStrictEqual([after.closed - before.closed, after.reopened - before.reopened, after.proposed - before.proposed], [1, 1, 1]);
    assert.ok(after.last instanceof Date);
  },

  'history: every change newest first, with its evidence': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const item = await seed.sourceItem();
    const ev = await seed.evidence(c, { sourceItemId: item, quote: 'done, merged', confidence: 0.9 });
    const a = await repos.ledger.insertTransition(T({ commitmentId: c, at: '2026-11-01T10:00:00Z', evidenceId: ev }));
    const b = await repos.ledger.insertTransition(T({ commitmentId: c, from: 'done', to: 'open', actor: 'you', at: '2026-11-02T10:00:00Z' }));
    const h = await repos.ledger.history(c);
    assert.deepStrictEqual(h.map((t) => Number(t.id)), [b, a]);
    assert.deepStrictEqual([h[1].quote, Number(h[1].source_item_id), Number(h[1].confidence)], ['done, merged', item, 0.9]);
    assert.strictEqual(h[0].quote, null);
  },

  'progressQuotes: the "progresses" quotes of the commitments, newest first': async ({ repos, seed, assert }) => {
    const a = await seed.commitment();
    const b = await seed.commitment();
    const none = await seed.commitment();
    await seed.evidenceWith(a, { effect: 'progresses', quote: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    await seed.evidenceWith(a, { effect: 'progresses', quote: 'second' });
    await seed.evidenceWith(a, { effect: 'closes', quote: 'closing, not progress' });
    await seed.evidenceWith(a, { effect: 'progresses', quote: null });
    await seed.evidenceWith(b, { effect: 'progresses', quote: 'on b' });
    const got = await repos.ledger.progressQuotes([a, b, none]);
    assert.deepStrictEqual(got.filter((r) => Number(r.commitment_id) === a).map((r) => r.quote), ['second', 'first']);
    assert.deepStrictEqual(got.filter((r) => Number(r.commitment_id) === b).map((r) => r.quote), ['on b']);
    assert.deepStrictEqual(await repos.ledger.progressQuotes([]), []);
  },

    // --- for src/commitments/context.js, src/commitments/replyClose.js

  'pendingEvidenceFor: undecided, unapplied evidence that it is done or moot, newest first, at most two': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    await seed.pendingEvidence(c, { effect: 'closes', quote: 'one' });
    await seed.pendingEvidence(c, { effect: 'moot', quote: 'two' });
    await seed.pendingEvidence(c, { effect: 'closes', quote: 'three' });
    await seed.pendingEvidence(c, { effect: 'progresses', quote: 'not a close' });
    await seed.pendingEvidence(c, { effect: 'closes', quote: 'applied', applied: true });
    await seed.pendingEvidence(c, { effect: 'closes', quote: 'decided', decision: 'rejected' });
    const got = await repos.ledger.pendingEvidenceFor(c);
    assert.deepStrictEqual(got.map((r) => r.quote), ['three', 'two']);
    assert.deepStrictEqual(Object.keys(got[0]).sort(), ['confidence', 'effect', 'quote']);
    assert.deepStrictEqual(await repos.ledger.pendingEvidenceFor(await seed.commitment()), []);
  },

  'latestReplyCloseTransition: the newest live transition the reply-close pass made': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    assert.strictEqual(await repos.ledger.latestReplyCloseTransition(c), null);
    await seed.transition(c, { actor: 'you' });
    const older = await seed.transition(c, { actor: 'reply-close', at: new Date(Date.now() - 3600_000) });
    const newer = await seed.transition(c, { actor: 'reply-close' });
    await seed.transition(c, { actor: 'reply-close', undoneAt: new Date() });
    assert.strictEqual(Number((await repos.ledger.latestReplyCloseTransition(c)).id), newer);
    assert.notStrictEqual(newer, older);
  },
  // --- for dashboard (chunk G)

  'evidenceItems: the source items evidence rows point at, members stripped': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const item = await seed.item({ source: 'graph_chat', subject: 'it is done', raw: { members: ['m'], keep: 1 } });
    const ev = await seed.evidence(c, { sourceItemId: item });
    const bare = await seed.evidence(c, { sourceItemId: null });
    const got = await repos.ledger.evidenceItems([ev, bare]);
    assert.strictEqual(got.length, 1, 'an evidence row with no item has nothing to show');
    assert.deepStrictEqual([Number(got[0].evidence_id), Number(got[0].id), got[0].subject, got[0].raw], [ev, item, 'it is done', { keep: 1 }]);
    assert.deepStrictEqual(await repos.ledger.evidenceItems([]), []);
  },
};