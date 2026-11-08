'use strict';

// Contract: src/repo/commitments.js (see test/repoContract.test.js). Cases
// share one database, so each tags its rows (summary, counterparty) and finds
// them by that.

const ago = (ms) => new Date(Date.now() - ms);
const DAY = 86400_000;

/** A commitment on a fresh source item (o.source, o.itemAt), then columns set (o.set). Returns its id. */
async function ask({ seed }, o = {}) {
  const item = await seed.item({ source: o.source || 'graph_mail', occurredAt: o.itemAt || ago(3600_000), body: o.body || 'please do the thing', raw: o.raw || {} });
  const id = await seed.commitment({ sourceItemId: item, direction: o.direction || 'owed_by_me', summary: o.summary, status: o.status });
  if (o.set) await seed.commitmentSet(id, o.set);
  return id;
}
const ids = (rows) => rows.map((r) => Number(r.id));

module.exports = {
  'openForBrief: open asks of mine apart from notes to myself; closed and superseded left out': async (t) => {
    const { repos, seed, assert } = t;
    const tag = `brief-${Math.random()}`;
    const who = await seed.personWith({ name: `Pat ${tag}` });
    const later = await ask(t, { summary: `${tag} later`, set: { due_at: new Date(Date.now() + 5 * DAY), counterparty_person_id: who } });
    const sooner = await ask(t, { summary: `${tag} sooner`, set: { due_at: new Date(Date.now() + 1 * DAY) } });
    const undated = await ask(t, { summary: `${tag} undated` });
    const note = await ask(t, { summary: `${tag} note`, source: 'claude_session' });
    await ask(t, { summary: `${tag} done`, status: 'done' });
    const replaced = await ask(t, { summary: `${tag} replaced` });
    await seed.commitmentSet(replaced, { superseded_by: later });
    const mine = (rows) => rows.filter((r) => String(r.summary).startsWith(tag));

    const asks = mine(await repos.commitments.openForBrief(false, 100));
    assert.deepStrictEqual(ids(asks), [sooner, later, undated], 'soonest due first, undated last');
    assert.strictEqual(asks[1].who, `Pat ${tag}`);
    assert.deepStrictEqual([asks[0].source, asks[0].project, asks[0].direction], ['graph_mail', null, 'owed_by_me']);
    assert.ok('thread_external_id' in asks[0] && 'occurred_at' in asks[0] && 'project_confidence' in asks[0]);
    assert.deepStrictEqual(ids(mine(await repos.commitments.openForBrief(true, 100))), [note]);
    assert.strictEqual((await repos.commitments.openForBrief(false, 1)).length, 1, 'limited');
  },

  'toPlan: open asks of mine with no plan, under a week old, no pending evidence or run': async (t) => {
    const { repos, seed, assert } = t;
    const tag = `plan-${Math.random()}`;
    const keep = await ask(t, { summary: `${tag} keep`, itemAt: ago(2 * DAY) });
    const newest = await ask(t, { summary: `${tag} newest`, itemAt: ago(3600_000) });
    const stale = await ask(t, { summary: `${tag} stale`, itemAt: ago(8 * DAY) });
    const planned = await ask(t, { summary: `${tag} planned`, set: { planned_at: new Date() } });
    const toMe = await ask(t, { summary: `${tag} owed to me`, direction: 'owed_to_me' });
    const looksDone = await ask(t, { summary: `${tag} looks done` });
    await seed.evidenceWith(looksDone, { effect: 'closes' });
    const decided = await ask(t, { summary: `${tag} decided` });
    await seed.evidenceWith(decided, { effect: 'closes', decision: 'rejected' });
    const hasRun = await ask(t, { summary: `${tag} has run` });
    await seed.run({ commitmentId: hasRun });
    const note = await ask(t, { summary: `${tag} note`, source: 'claude_session' });
    const got = (await repos.commitments.toPlan(500)).filter((r) => String(r.summary).startsWith(tag));
    assert.deepStrictEqual(ids(got).sort(), [keep, newest, decided].sort());
    assert.ok(ids(got).indexOf(newest) < ids(got).indexOf(keep));
    assert.ok('ask_text' in got[0] && 'project' in got[0] && 'who' in got[0] && 'repo_path' in got[0]);
    assert.strictEqual((await repos.commitments.toPlan(1)).length, 1);
    assert.ok(stale && planned && toMe && note);
  },

  'researchStartedToday: counts plans with a research run planned today': async (t) => {
    const { repos, seed, assert } = t;
    const before = await repos.commitments.researchStartedToday();
    const c = await ask(t, { summary: 'research' });
    await seed.commitmentSet(c, { plan: JSON.stringify({ researchRunId: 7 }), planned_at: new Date() });
    const other = await ask(t, { summary: 'no research' });
    await seed.commitmentSet(other, { plan: JSON.stringify({ kind: 'coding' }), planned_at: new Date() });
    const yesterday = await ask(t, { summary: 'research yesterday' });
    await seed.commitmentSet(yesterday, { plan: JSON.stringify({ researchRunId: 8 }), planned_at: ago(2 * DAY) });
    assert.strictEqual(await repos.commitments.researchStartedToday(), before + 1);
  },

  'setPlan: records kind and plan and stamps planned_at': async (t) => {
    const { repos, db, assert } = t;
    const c = await ask(t, { summary: 'to plan' });
    await repos.commitments.setPlan(c, 'coding', { kind: 'coding', action: 'offer' });
    const r = await db.one('select kind, plan, planned_at from commitment where id = $1', [c]);
    assert.deepStrictEqual([r.kind, r.plan], ['coding', { kind: 'coding', action: 'offer' }]);
    assert.ok(r.planned_at instanceof Date);
  },

  'markPlannedOther: kind other, planned now, plan untouched': async (t) => {
    const { repos, db, assert } = t;
    const c = await ask(t, { summary: 'unplanned' });
    await repos.commitments.markPlannedOther(c);
    const r = await db.one('select kind, plan, planned_at from commitment where id = $1', [c]);
    assert.deepStrictEqual([r.kind, r.plan], ['other', null]);
    assert.ok(r.planned_at instanceof Date);
  },

  'shippedSinceAsk: PRs in the commitment\'s project since the ask, newest first': async (t) => {
    const { repos, seed, assert } = t;
    const path = `grp/${Math.random().toString(36).slice(2)}`;
    const project = await seed.project({ gitlabPath: path });
    const askAt = ago(5 * DAY);
    const c = await ask(t, { summary: 'ship it', itemAt: askAt, set: { project_id: project } });
    const early = await seed.item({ source: 'github_pr', occurredAt: ago(4 * DAY), subject: 'PR one', raw: { project: path.toUpperCase() } });
    const late = await seed.item({ source: 'github_pr', occurredAt: ago(1 * DAY), subject: 'PR two', raw: { project: path } });
    await seed.item({ source: 'github_pr', occurredAt: ago(9 * DAY), subject: 'before the ask', raw: { project: path } });
    await seed.item({ source: 'github_pr', occurredAt: ago(1 * DAY), subject: 'another project', raw: { project: 'other/x' } });
    const noProject = await ask(t, { summary: 'no project' });
    const got = await repos.commitments.shippedSinceAsk([c, noProject]);
    assert.deepStrictEqual(got.map((r) => [Number(r.commitment_id), r.subject]), [[c, 'PR two'], [c, 'PR one']]);
    assert.ok(early && late);
    assert.deepStrictEqual(await repos.commitments.shippedSinceAsk([]), []);
  },

  'closedByMeBetween: done asks I closed in the window, not someone else\'s PR landing': async (t) => {
    const { repos, seed, assert } = t;
    const tag = `closed-${Math.random()}`;
    const mk = (summary, reason, at) => ask(t, { summary: `${tag} ${summary}`, status: 'done', set: { closed_reason: reason, closed_at: at } });
    const manual = await mk('manual', 'you marked it done', ago(2 * 3600_000));
    const reviewed = await mk('reviewed', 'you reviewed it', ago(1 * 3600_000));
    const noReason = await mk('no reason', null, ago(3 * 3600_000));
    await mk('merged', 'PR merged', ago(1 * 3600_000));
    await mk('outside', 'you marked it done', ago(40 * 3600_000));
    const open = await ask(t, { summary: `${tag} open`, set: { closed_at: ago(3600_000) } });
    const got = (await repos.commitments.closedByMeBetween(ago(10 * 3600_000), new Date())).filter((r) => String(r.summary).startsWith(tag));
    assert.deepStrictEqual(ids(got), [reviewed, manual, noReason], 'newest close first');
    assert.deepStrictEqual([got[0].closed_reason, got[0].closed_at instanceof Date], ['you reviewed it', true]);
    assert.ok(open && seed);
  },

  'dueSoonOwedByMe: my open asks due within two days (or up to 14 overdue), soonest first': async (t) => {
    const { repos, assert } = t;
    const tag = `due-${Math.random()}`;
    const now = new Date();
    const mk = (s, days, extra = {}) => ask(t, { summary: `${tag} ${s}`, set: { due_at: new Date(now.getTime() + days * DAY), ...extra } });
    const overdue = await mk('overdue', -3);
    const tomorrow = await mk('tomorrow', 1);
    await mk('next week', 7);
    await mk('ancient', -20);
    const noDate = await ask(t, { summary: `${tag} no date` });
    const dropped = await ask(t, { summary: `${tag} dropped`, status: 'dropped', set: { due_at: new Date(now.getTime() + DAY) } });
    const toMe = await ask(t, { summary: `${tag} to me`, direction: 'owed_to_me', set: { due_at: new Date(now.getTime() + DAY) } });
    const got = (await repos.commitments.dueSoonOwedByMe(now)).filter((r) => String(r.summary).startsWith(tag));
    assert.deepStrictEqual(ids(got), [overdue, tomorrow]);
    assert.ok(got[0].due_at instanceof Date);
    assert.ok(noDate && dropped && toMe);
  },

  'freshAsksOwedByMe: undated asks of the last day with confidence of 0.6 or more, newest first': async (t) => {
    const { repos, assert } = t;
    const tag = `fresh-${Math.random()}`;
    const now = new Date();
    const mk = (s, conf, ago_, extra = {}) => ask(t, { summary: `${tag} ${s}`, set: { confidence: conf, extracted_at: new Date(now.getTime() - ago_), ...extra } });
    const newer = await mk('newer', 0.9, 1 * 3600_000);
    const older = await mk('older', 0.6, 5 * 3600_000);
    await mk('unsure', 0.5, 3600_000);
    await mk('stale', 0.9, 30 * 3600_000);
    await mk('dated', 0.9, 3600_000, { due_at: new Date(now.getTime() + DAY) });
    const got = (await repos.commitments.freshAsksOwedByMe(now)).filter((r) => String(r.summary).startsWith(tag));
    assert.deepStrictEqual(ids(got), [newer, older]);
  },

  'openWithPerson: open asks with a person, soonest due first': async (t) => {
    const { repos, seed, assert } = t;
    const p = await seed.personWith();
    const soon = await ask(t, { summary: 'soon', set: { counterparty_person_id: p, due_at: new Date(Date.now() + DAY) } });
    const undated = await ask(t, { summary: 'undated', direction: 'owed_to_me', set: { counterparty_person_id: p } });
    await ask(t, { summary: 'done', status: 'done', set: { counterparty_person_id: p } });
    await ask(t, { summary: 'someone else' });
    const got = await repos.commitments.openWithPerson(p);
    assert.deepStrictEqual(ids(got), [soon, undated]);
    assert.deepStrictEqual([got[1].direction, got[1].summary, got[0].due_at instanceof Date], ['owed_to_me', 'undated', true]);
  },

  'openForDebrief: open asks, those with an attendee first, at most 80': async (t) => {
    const { repos, seed, assert, uniq } = t;
    const email = `${uniq('att')}@x.test`;
    const p = await seed.personWith({ name: 'Attendee', email });
    const tag = `deb-${Math.random()}`;
    const plain = await ask(t, { summary: `${tag} plain`, set: { due_at: new Date(Date.now() + DAY) } });
    const theirs = await ask(t, { summary: `${tag} theirs`, set: { counterparty_person_id: p } });
    await ask(t, { summary: `${tag} closed`, status: 'done' });
    const got = (await repos.commitments.openForDebrief([email])).filter((r) => String(r.summary).startsWith(tag));
    assert.deepStrictEqual(ids(got), [theirs, plain], 'the attendee\'s ask first');
    assert.deepStrictEqual([got[0].counterparty, got[0].counterparty_email], ['Attendee', email]);
    assert.ok((await repos.commitments.openForDebrief([])).length <= 80);
  },

  'insertFromDebrief: creates the commitment and returns its id': async (t) => {
    const { repos, seed, db, assert } = t;
    const item = await seed.item({ source: 'audio' });
    const p = await seed.personWith();
    const id = await repos.commitments.insertFromDebrief({
      sourceItemId: item, direction: 'owed_to_me', summary: 'Send the deck', detail: 'From Sync (2099-01-01): "I will"',
      counterpartyPersonId: p, dueAt: '2099-01-05T00:00:00Z', confidence: 0.8, extractedBy: 'debrief-test',
    });
    const r = await db.one('select * from commitment where id = $1', [id]);
    assert.deepStrictEqual(
      [Number(r.source_item_id), r.direction, r.summary, r.detail, Number(r.counterparty_person_id), r.due_at.toISOString(), r.confidence, r.extracted_by, r.status],
      [item, 'owed_to_me', 'Send the deck', 'From Sync (2099-01-01): "I will"', p, '2099-01-05T00:00:00.000Z', 0.8, 'debrief-test', 'open']
    );
    const bare = await repos.commitments.insertFromDebrief({ sourceItemId: item, direction: 'owed_by_me', summary: 's', detail: 'd', counterpartyPersonId: null, dueAt: null, confidence: null, extractedBy: 'debrief-test' });
    assert.ok(bare && bare !== id);
  },

  'setDebriefColumns: sets the allowed columns and ignores the rest': async (t) => {
    const { repos, db, assert } = t;
    const c = await ask(t, { summary: 'keep me' });
    await repos.commitments.setDebriefColumns(c, { status: 'done', closed_reason: 'said in a meeting', closed_at: '2099-01-01T00:00:00Z', due_at: '2099-02-01T00:00:00Z', detail: 'new detail', summary: 'HIJACKED', direction: 'owed_to_me' });
    const r = await db.one('select * from commitment where id = $1', [c]);
    assert.deepStrictEqual([r.status, r.closed_reason, r.detail, r.summary, r.direction], ['done', 'said in a meeting', 'new detail', 'keep me', 'owed_by_me']);
    assert.strictEqual(r.due_at.toISOString(), '2099-02-01T00:00:00.000Z');
    await repos.commitments.setDebriefColumns(c, { summary: 'ignored too' });
    await repos.commitments.setDebriefColumns(c, {});
    assert.strictEqual((await db.one('select summary from commitment where id = $1', [c])).summary, 'keep me');
  },

  'deleteExtractedBy: deletes only when extracted by that version': async (t) => {
    const { repos, seed, db, assert } = t;
    const item = await seed.item({ source: 'audio' });
    const mine = await repos.commitments.insertFromDebrief({ sourceItemId: item, direction: 'owed_by_me', summary: 'mine', detail: 'd', counterpartyPersonId: null, dueAt: null, confidence: null, extractedBy: 'debrief-v9' });
    const kept = await ask(t, { summary: 'extracted elsewhere' });
    await repos.commitments.deleteExtractedBy(kept, 'debrief-v9');
    await repos.commitments.deleteExtractedBy(mine, 'debrief-v9');
    assert.strictEqual(await db.one('select 1 from commitment where id = $1', [mine]), null);
    assert.ok(await db.one('select 1 from commitment where id = $1', [kept]));
  },

  'rowForUndo: the commitment row, or null': async (t) => {
    const { repos, assert } = t;
    const c = await ask(t, { summary: 'read me' });
    const row = await repos.commitments.rowForUndo(c);
    assert.deepStrictEqual([Number(row.id), row.summary, row.status], [c, 'read me', 'open']);
    assert.strictEqual(await repos.commitments.rowForUndo(999999999), null);
  },
};
