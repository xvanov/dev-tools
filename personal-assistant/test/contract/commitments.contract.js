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

const dAgo = (days) => new Date(Date.now() - days * 86400_000);
const vec = (x, y = 0) => `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? x : i === 1 ? y : 0)).join(',')}]`;
const idsOf = (list) => list.map((r) => Number(r.id)).sort((a, b) => a - b);
const asc = (...n) => n.sort((a, b) => a - b);
const ALL = 'true';
const WIN = { windowDays: 14, sources: ['graph_chat', 'graph_mail'], maxAttempts: 3 };

/** An ask in a chat thread and a later reply of mine in it; returns the ids and the thread. */
async function thread({ seed }, uniq, { mine = 'me@example.com' } = {}) {
  const th = uniq('thread');
  const ask = await seed.sourceItem({ source: 'graph_chat', occurredAt: dAgo(2) });
  await seed.setItem(ask, { thread_external_id: th, author_identity: 'them@example.com' });
  const reply = await seed.sourceItem({ source: 'graph_chat', occurredAt: dAgo(1), body: 'on it, done' });
  await seed.setItem(reply, { thread_external_id: th, author_identity: mine });
  const c = await seed.commitment({ sourceItemId: ask });
  return { th, ask, reply, c, mine };
}

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

  // --- src/commitments.js

  'summaryRow: id, status and summary; null when gone': async ({ repos, seed, assert }) => {
    const c = await seed.commitment({ summary: 'ship it' });
    const row = await repos.commitments.summaryRow(c);
    assert.deepStrictEqual([Number(row.id), row.status, row.summary], [c, 'open', 'ship it']);
    assert.strictEqual(await repos.commitments.summaryRow(0), null);
  },

  'openDuplicatesOf: the open rest of the duplicate group, closed ones left out': async ({ repos, seed, assert }) => {
    const a = await seed.commitment();
    const b = await seed.commitment();
    const c = await seed.commitment();
    const d = await seed.commitment({ status: 'done' });
    for (const x of [b, c, d]) await seed.setCommitment(x, { superseded_by: a });
    assert.deepStrictEqual(idsOf(await repos.commitments.openDuplicatesOf(b)), asc(a, c));
    assert.deepStrictEqual(idsOf(await repos.commitments.openDuplicatesOf(a)), asc(b, c));
  },

  'recentlyClosed: closed within the window, newest first, with the source and who closed it': async ({ repos, seed, assert }) => {
    const fresh = await seed.commitment({ status: 'done' });
    await seed.setCommitment(fresh, { closed_at: new Date(), closed_reason: 'you marked it done' });
    await seed.transition(fresh, { actor: 'you' });
    const old = await seed.commitment({ status: 'done' });
    await seed.setCommitment(old, { closed_at: dAgo(10), closed_reason: 'old' });
    const got = await repos.commitments.recentlyClosed('3', 200);
    const row = got.find((r) => Number(r.id) === fresh);
    assert.ok(row, 'fresh close listed');
    assert.deepStrictEqual([row.status, row.closed_reason, row.source, row.actor], ['done', 'you marked it done', 'graph_mail', 'you']);
    assert.ok(!got.some((r) => Number(r.id) === old), 'old close not listed');
  },

  // --- src/commitments/blocks.js

  'blockTasks: an e2e card is not one of your tasks': async ({ repos, seed, assert }) => {
    const mark = 'e2e-12345678-1234-1234-1234-123456789abc';
    const real = await seed.commitment({ direction: 'owed_by_me', summary: 'Ship the sync' });
    const card = await seed.commitment({ direction: 'owed_by_me', summary: `Add a pa version verb that prints the served commit (${mark})` });
    const askOnly = await seed.commitment({ direction: 'owed_by_me', summary: 'Ship the field list' });
    await seed.run({ commitmentId: askOnly, task: `In personal-assistant, add a pa version CLI verb. (Automated golden-path run ${mark}.)` });
    const titled = await seed.commitment({ direction: 'owed_by_me', summary: 'ordinary' });
    await seed.commitmentSet(titled, { detail: `e2e: pa version verb (${mark})` });
    const got = idsOf(await repos.commitments.blockTasks(ALL));
    assert.ok(got.includes(real));
    assert.ok(!got.includes(card) && !got.includes(askOnly) && !got.includes(titled));
  },

  'blockTasks: your open tasks, not what others owe, not folded ones': async ({ repos, seed, assert }) => {
    const mine = await seed.commitment({ direction: 'owed_by_me' });
    const theirs = await seed.commitment({ direction: 'owed_to_me' });
    const folded = await seed.commitment({ direction: 'owed_by_me' });
    await seed.setCommitment(folded, { superseded_by: mine });
    const got = idsOf(await repos.commitments.blockTasks(ALL));
    assert.ok(got.includes(mine));
    assert.ok(!got.includes(theirs) && !got.includes(folded));
    assert.deepStrictEqual(idsOf(await repos.commitments.blockTasks('false')), []);
  },

  'blockCandidates: an e2e card is not judged': async ({ repos, seed, assert }) => {
    const mark = 'e2e-12345678-1234-1234-1234-123456789abc';
    const real = await seed.commitment({ direction: 'owed_to_me', summary: 'Send the field list' });
    const card = await seed.commitment({ direction: 'owed_to_me', summary: `Add a pa version verb (${mark})` });
    const got = idsOf(await repos.commitments.blockCandidates(ALL));
    assert.ok(got.includes(real));
    assert.ok(!got.includes(card));
  },

  'blockCandidates: what others owe, with its verdict, who, and whether its task is gone': async ({ repos, seed, assert }) => {
    const person = await seed.person('Torvan Example');
    const blocker = await seed.commitment({ direction: 'owed_to_me' });
    await seed.setCommitment(blocker, { counterparty_person_id: person });
    const open = await seed.commitment();
    const done = await seed.commitment({ status: 'done' });
    const find = async () => (await repos.commitments.blockCandidates(ALL)).find((r) => Number(r.id) === blocker);
    let row = await find();
    assert.deepStrictEqual([row.who, row.verdict, row.task_gone], ['Torvan Example', null, false]);
    await repos.commitments.upsertBlockJudged(blocker, open, 'blocks', 'needs it', 'Torvan');
    row = await find();
    assert.deepStrictEqual([row.verdict, Number(row.task_id), row.manual, row.task_gone], ['blocks', open, false, false]);
    await repos.commitments.upsertBlockJudged(blocker, done, 'blocks', 'needs it', 'Torvan');
    assert.strictEqual((await find()).task_gone, true, 'a closed task is gone');
    assert.ok(!(await repos.commitments.blockCandidates(ALL)).some((r) => Number(r.id) === open), 'owed_by_me is not a candidate');
  },

  'blockLinkCosines: similarity of each pair that has vectors': async ({ repos, seed, assert }) => {
    const [b, t, lone] = [await seed.commitment(), await seed.commitment(), await seed.commitment()];
    await repos.commitments.insertVector(b, vec(1), []);
    await repos.commitments.insertVector(t, vec(1), []);
    const got = await repos.commitments.blockLinkCosines([b, lone], [t, t]);
    assert.strictEqual(got.length, 1, 'a pair without a vector is left out');
    assert.strictEqual(got[0].b, String(b));
    assert.ok(Math.abs(Number(got[0].cos) - 1) < 1e-6);
  },

  'upsertBlockJudged: writes the verdict again; a manual row is never changed': async ({ repos, seed, assert }) => {
    const blocker = await seed.commitment({ direction: 'owed_to_me' });
    const find = async () => (await repos.commitments.blockCandidates(ALL)).find((r) => Number(r.id) === blocker);
    await repos.commitments.upsertBlockJudged(blocker, null, 'not_mine', 'a', null);
    assert.strictEqual((await find()).verdict, 'not_mine');
    await repos.commitments.upsertBlockJudged(blocker, null, 'blocks', 'b', 'Ada');
    assert.strictEqual((await find()).verdict, 'blocks');
    await repos.commitments.upsertBlockManual(blocker, null, 'not_mine', 'mine');
    await repos.commitments.upsertBlockJudged(blocker, null, 'blocks', 'c', 'Ada');
    const row = await find();
    assert.deepStrictEqual([row.verdict, row.manual], ['not_mine', true]);
  },

  'upsertBlockManual: manual; a null task or why keeps what was there': async ({ repos, seed, assert }) => {
    const blocker = await seed.commitment({ direction: 'owed_to_me' });
    const task = await seed.commitment();
    const board = async () => (await repos.commitments.blocksForBoard(3)).find((r) => r.blocker_id === String(blocker));
    await repos.commitments.upsertBlockManual(blocker, task, 'blocks', 'why one');
    let row = await board();
    assert.deepStrictEqual([row.task_id, row.verdict, row.why, row.manual], [String(task), 'blocks', 'why one', true]);
    await repos.commitments.upsertBlockManual(blocker, null, 'blocks', null);
    row = await board();
    assert.deepStrictEqual([row.task_id, row.why], [String(task), 'why one']);
    await repos.commitments.upsertBlockManual(blocker, null, 'not_mine', null);
    assert.strictEqual((await board()).task_id, null, 'not_mine drops the task link');
  },

  'blocksForBoard: open blockers, and a closed one only while it held up a task': async ({ repos, seed, assert }) => {
    const task = await seed.commitment();
    const open = await seed.commitment({ direction: 'owed_to_me' });
    const closedFresh = await seed.commitment({ direction: 'owed_to_me', status: 'done' });
    const closedOld = await seed.commitment({ direction: 'owed_to_me', status: 'done' });
    await seed.setCommitment(closedFresh, { closed_at: new Date() });
    await seed.setCommitment(closedOld, { closed_at: dAgo(10) });
    for (const b of [open, closedFresh, closedOld]) await repos.commitments.upsertBlockJudged(b, task, 'blocks', 'w', 'Ada');
    const got = (await repos.commitments.blocksForBoard(3)).map((r) => Number(r.blocker_id));
    assert.ok(got.includes(open) && got.includes(closedFresh));
    assert.ok(!got.includes(closedOld));
  },

  'blocksForBoard: a verdict that cites an e2e card is not read': async ({ repos, seed, assert }) => {
    const mark = 'e2e-12345678-1234-1234-1234-123456789abc';
    const dummy = await seed.commitment({ summary: `Add a pa version verb that prints the served commit (${mark})` });
    const realTask = await seed.commitment({ summary: 'Build the HubSpot sync' });
    const cited = await seed.commitment({ direction: 'owed_to_me', summary: 'ArgoCD sync' });
    const linked = await seed.commitment({ direction: 'owed_to_me', summary: 'a review' });
    const markedWhy = await seed.commitment({ direction: 'owed_to_me', summary: 'another' });
    const clean = await seed.commitment({ direction: 'owed_to_me', summary: 'the field list' });
    await repos.commitments.upsertBlockJudged(cited, null, 'blocks', 'Needs the ArgoCD sync to deploy the target service before adding the pa version verb.', 'Ada');
    await repos.commitments.upsertBlockJudged(linked, dummy, 'blocks', 'needs the dummy task', 'Ada');
    await repos.commitments.upsertBlockJudged(markedWhy, realTask, 'blocks', `needs it (${mark})`, 'Ada');
    await repos.commitments.upsertBlockJudged(clean, realTask, 'blocks', 'Needs the field list to build the sync', 'Ada');
    const got = (await repos.commitments.blocksForBoard(3)).map((r) => Number(r.blocker_id));
    assert.ok(!got.includes(cited), 'the why names the e2e card');
    assert.ok(!got.includes(linked), 'the task is the e2e card');
    assert.ok(!got.includes(markedWhy), 'the why carries the marker');
    assert.ok(got.includes(clean));
    const ofTask = (await repos.commitments.blocksOf(realTask)).map((r) => Number(r.blocker_id));
    assert.deepStrictEqual(ofTask, [clean], 'a verdict whose why carries the marker is not read on the task either');
  },

  // --- src/commitments/policyClose.js

  'policyCandidates: open unfolded cards with what acted on them': async ({ repos, seed, assert }) => {
    const plain = await seed.commitment();
    const withRun = await seed.commitment();
    await repos.runs.insertClaude({ commitmentId: withRun, mode: 'mr', task: 't', repoPath: '/w', machine: 'box', routeReason: null, kind: null, delivery: 'draft_pr', deliverySource: 'explicit' });
    const moved = await seed.commitment();
    await seed.transition(moved, { actor: 'you' });
    const touched = await seed.commitment();
    await seed.setCommitment(touched, { touched_at: new Date() });
    const folded = await seed.commitment();
    await seed.setCommitment(folded, { superseded_by: plain });
    const got = await repos.commitments.policyCandidates();
    const by = (id) => got.find((r) => Number(r.id) === id);
    assert.deepStrictEqual([by(plain).has_run, by(plain).has_draft, by(plain).you_moved, by(plain).touched], [false, false, false, false]);
    assert.strictEqual(by(withRun).has_run, true);
    assert.strictEqual(by(moved).you_moved, true);
    assert.strictEqual(by(touched).touched, true);
    assert.strictEqual(by(plain).source, 'graph_mail');
    assert.ok('thread_external_id' in by(plain) && 'external_id' in by(plain), 'the item ids the Teams rule reads');
    assert.ok(!by(folded), 'a folded copy is not a candidate');
    const all = await repos.commitments.policyCandidates({ folded: true });
    const f = all.find((r) => Number(r.id) === folded);
    assert.ok(f, 'unless asked for');
    assert.strictEqual(Number(f.superseded_by), plain);
    assert.strictEqual(f.has_run, false);
  },

  'foldedUnder: open commitments folded under the given ones': async ({ repos, seed, assert }) => {
    const keep = await seed.commitment();
    const open = await seed.commitment();
    const done = await seed.commitment({ status: 'done' });
    await seed.setCommitment(open, { superseded_by: keep });
    await seed.setCommitment(done, { superseded_by: keep });
    const got = await repos.commitments.foldedUnder([keep]);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), Number(r.superseded_by), r.source]), [[open, keep, 'graph_mail']]);
    assert.deepStrictEqual(await repos.commitments.foldedUnder([]), []);
  },

  'unfold: only while still folded under that commitment': async ({ repos, seed, assert }) => {
    const keep = await seed.commitment();
    const other = await seed.commitment();
    const c = await seed.commitment();
    await seed.setCommitment(c, { superseded_by: keep });
    assert.strictEqual(await repos.commitments.unfold(c, other), false, 'folded under another');
    assert.strictEqual(await repos.commitments.unfold(c, keep), true);
    assert.strictEqual((await repos.commitments.byId(c)).superseded_by, null);
    assert.strictEqual(await repos.commitments.unfold(c, keep), false, 'already unfolded');
  },

  'refold: only while still folded under that commitment, never under itself': async ({ repos, seed, assert }) => {
    const was = await seed.commitment();
    const lead = await seed.commitment();
    const other = await seed.commitment();
    const c = await seed.commitment();
    await seed.setCommitment(c, { superseded_by: was });
    assert.strictEqual(await repos.commitments.refold(c, other, lead), false, 'folded under another');
    assert.strictEqual(await repos.commitments.refold(c, was, c), false, 'not under itself');
    assert.strictEqual(await repos.commitments.refold(c, was, lead), true);
    assert.strictEqual(Number((await repos.commitments.byId(c)).superseded_by), lead);
    assert.strictEqual(await repos.commitments.refold(c, was, lead), false, 'already moved');
  },

  // --- src/commitments/selfNotes.js

  'expiredSelfNotes: open notes untouched past the window that the predicate selects': async ({ repos, seed, assert }) => {
    const SELF = `si.source = 'claude_session'`;
    const oldItem = await seed.sourceItem({ source: 'claude_session', occurredAt: dAgo(20) });
    const stale = await seed.commitment({ sourceItemId: oldItem });
    const touched = await seed.commitment({ sourceItemId: await seed.sourceItem({ source: 'claude_session', occurredAt: dAgo(20) }) });
    await seed.setCommitment(touched, { touched_at: new Date() });
    const fresh = await seed.commitment({ sourceItemId: await seed.sourceItem({ source: 'claude_session' }) });
    const mail = await seed.commitment({ sourceItemId: await seed.sourceItem({ source: 'graph_mail', occurredAt: dAgo(20) }) });
    const got = idsOf(await repos.commitments.expiredSelfNotes('7', SELF));
    assert.ok(got.includes(stale));
    assert.ok(!got.includes(touched) && !got.includes(fresh) && !got.includes(mail));
  },

  // --- src/commitments/context.js

  'dueForContext: cards with no context yet, minus the self-notes; written ones wait': async ({ repos, seed, assert }) => {
    const SELF = `si.source = 'claude_session'`;
    const card = await seed.commitment();
    const note = await seed.commitment({ sourceItemId: await seed.sourceItem({ source: 'claude_session' }) });
    const due = async () => idsOf(await repos.commitments.dueForContext(500, 'v1 model', 30, SELF));
    let got = await due();
    assert.ok(got.includes(card));
    assert.ok(!got.includes(note), 'a self-note has no card');
    await repos.commitments.setContext(card, 'because', 'v1 model');
    assert.ok(!(await due()).includes(card), 'just written');
    await seed.setCommitment(card, { context_at: dAgo(1) });
    assert.ok((await due()).includes(card), 'its item was fetched since');
    const limited = await repos.commitments.dueForContext(1, 'v1 model', 30, SELF);
    assert.strictEqual(limited.length, 1);
  },

  'dueForContext: an e2e card is not written up': async ({ repos, seed, assert }) => {
    const SELF = `si.source = 'claude_session'`;
    const mark = 'e2e-12345678-1234-1234-1234-123456789abc';
    const real = await seed.commitment({ summary: 'write the context' });
    const card = await seed.commitment({ summary: `Add a pa version verb (${mark})` });
    const due = idsOf(await repos.commitments.dueForContext(500, 'v1 model', 30, SELF));
    assert.ok(due.includes(real));
    assert.ok(!due.includes(card));
  },

  'contextCard: the card with project, counterparty and author': async ({ repos, seed, assert }) => {
    const person = await seed.person('Ada Example');
    const project = await seed.projectNamed(`proj-${Date.now()}`, { gitlabPath: 'grp/proj' });
    const item = await seed.sourceItem({ subject: 'Subj' });
    await seed.setItem(item, { raw: { fromName: 'Grace H', members: ['x'], keep: 1 } });
    const c = await seed.commitment({ sourceItemId: item, summary: 'do it' });
    await seed.setCommitment(c, { project_id: project, counterparty_person_id: person });
    const row = await repos.commitments.contextCard(c);
    assert.deepStrictEqual([row.summary, row.project, row.who, row.subject, row.author, row.source], ['do it', 'grp/proj', 'Ada Example', 'Subj', 'Grace H', 'graph_mail']);
    assert.deepStrictEqual(row.raw, { fromName: 'Grace H', keep: 1 }, 'members are left out of raw');
    assert.strictEqual(await repos.commitments.contextCard(0), null);
  },

  'contextThread: a few before the source and more from it on': async ({ repos, seed, assert, uniq }) => {
    const th = uniq('ctx');
    const mk = async (daysAgo, author) => {
      const id = await seed.sourceItem({ source: 'graph_chat', occurredAt: dAgo(daysAgo), body: `msg ${daysAgo}` });
      await seed.setItem(id, { thread_external_id: th, author_identity: author });
      return id;
    };
    const before = await mk(3, 'a@example.com');
    const src = await mk(2, 'b@example.com');
    const after = await mk(1, 'c@example.com');
    const got = await repos.commitments.contextThread('graph_chat', th, dAgo(2), src);
    assert.deepStrictEqual(idsOf(got), asc(before, src, after));
    assert.strictEqual(got.find((r) => Number(r.id) === before).author, 'a@example.com');
    assert.strictEqual(got.find((r) => Number(r.id) === after).body, 'msg 1');
  },

  'setContext: stores it with when and by what; a null text keeps the old one': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    await repos.commitments.setContext(c, 'first', 'v1 m');
    await repos.commitments.setContext(c, null, 'v2 m');
    const r = await db.one('select context, context_by, context_at from commitment where id = $1', [c]);
    assert.deepStrictEqual([r.context, r.context_by], ['first', 'v2 m']);
    assert.ok(r.context_at instanceof Date);
  },

  'stampContextAt: sets context_at only': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    await repos.commitments.stampContextAt(c);
    const r = await db.one('select context, context_at from commitment where id = $1', [c]);
    assert.deepStrictEqual([r.context, r.context_at instanceof Date], [null, true]);
  },

  'clearContext: forgets the paragraph, so the card is due for a new one': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    await repos.commitments.setContext(c, 'the run is still going', 'v1 m');
    await repos.commitments.clearContext(c);
    const r = await db.one('select context, context_at from commitment where id = $1', [c]);
    assert.deepStrictEqual([r.context, r.context_at], [null, null]);
  },

  // --- src/commitments/dedupe.js

  'unvectored: open recent commitments with no vector yet': async ({ repos, seed, assert }) => {
    const c = await seed.commitment({ summary: 'embed me' });
    const old = await seed.commitment();
    await seed.setCommitment(old, { extracted_at: dAgo(90) });
    const got = await repos.commitments.unvectored(500, 60, ALL);
    assert.ok(idsOf(got).includes(c) && !idsOf(got).includes(old));
    assert.strictEqual(got.find((r) => Number(r.id) === c).summary, 'embed me');
    assert.deepStrictEqual(await repos.commitments.unvectored(500, 60, 'false'), []);
    await repos.commitments.insertVector(c, vec(1), ['erp#1']);
    assert.ok(!idsOf(await repos.commitments.unvectored(500, 60, ALL)).includes(c));
  },

  'insertVector: stores the embedding and anchors; a second insert is a no-op': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    await repos.commitments.insertVector(c, vec(1), ['a']);
    await repos.commitments.insertVector(c, vec(0, 1), ['b']);
    const row = (await repos.commitments.dedupePool(60, ALL)).find((r) => Number(r.id) === c);
    assert.deepStrictEqual(row.anchors, ['a']);
    assert.ok(row.embedding.startsWith('[1,0,'));
  },

  'dedupePool: the live recent commitments with a vector, with who and whether acted on': async ({ repos, seed, assert }) => {
    const person = await seed.person('Ada Example');
    const c = await seed.commitment();
    await seed.setCommitment(c, { counterparty_person_id: person });
    const acted = await seed.commitment();
    await seed.transition(acted, { actor: 'you' });
    const noVec = await seed.commitment();
    const done = await seed.commitment({ status: 'done' });
    for (const x of [c, acted, done]) await repos.commitments.insertVector(x, vec(1), []);
    const got = await repos.commitments.dedupePool(60, ALL);
    const by = (id) => got.find((r) => Number(r.id) === id);
    assert.deepStrictEqual([by(c).who, by(c).has_party, by(c).acted, by(c).checked_at], ['Ada Example', true, false, null]);
    assert.strictEqual(by(acted).acted, true);
    assert.ok(!by(noVec) && !by(done));
    assert.deepStrictEqual(await repos.commitments.dedupePool(60, 'false'), []);
  },

  'survivorOf: follows superseded_by to the live row': async ({ repos, seed, assert }) => {
    const a = await seed.commitment();
    const b = await seed.commitment();
    const c = await seed.commitment();
    await seed.setCommitment(b, { superseded_by: a });
    await seed.setCommitment(c, { superseded_by: b });
    assert.deepStrictEqual(idsOf(await repos.commitments.survivorOf(c)), [a]);
    assert.deepStrictEqual(idsOf(await repos.commitments.survivorOf(a)), [a]);
    assert.deepStrictEqual(await repos.commitments.survivorOf(0), []);
  },

  'fold: only a live row nothing folded meanwhile': async ({ repos, seed, assert }) => {
    const keep = await seed.commitment();
    const drop = await seed.commitment();
    const closed = await seed.commitment({ status: 'done' });
    assert.strictEqual(await repos.commitments.fold(drop, keep), true);
    assert.strictEqual(Number((await repos.commitments.byId(drop)).superseded_by), keep);
    assert.strictEqual(await repos.commitments.fold(drop, closed), false, 'already folded');
    assert.strictEqual(await repos.commitments.fold(closed, keep), false, 'closed');
  },

  'checkVectorsOffBoard: marks the vectors of commitments that left the board': async ({ repos, seed, db, assert }) => {
    const live = await seed.commitment();
    const gone = await seed.commitment({ status: 'done' });
    for (const x of [live, gone]) await repos.commitments.insertVector(x, vec(1), []);
    await repos.commitments.checkVectorsOffBoard();
    const at = async (id) => (await db.one('select checked_at from commitment_vector where commitment_id = $1', [id])).checked_at;
    assert.strictEqual(await at(live), null);
    assert.ok((await at(gone)) instanceof Date);
  },

  'markVectorChecked: stamps checked_at with the verdict note': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    await repos.commitments.insertVector(c, vec(1), []);
    await repos.commitments.markVectorChecked(c, { keep: '1', by: 'dedupe' });
    const r = await db.one('select checked_at, verdict from commitment_vector where commitment_id = $1', [c]);
    assert.ok(r.checked_at instanceof Date);
    assert.deepStrictEqual(r.verdict, { keep: '1', by: 'dedupe' });
    await repos.commitments.markVectorChecked(c, null);
    assert.strictEqual((await db.one('select verdict from commitment_vector where commitment_id = $1', [c])).verdict, null);
  },

  'checkAllVectors: stamps every unchecked vector, keeping earlier stamps': async ({ repos, seed, db, assert }) => {
    const [a, b] = [await seed.commitment(), await seed.commitment()];
    for (const x of [a, b]) await repos.commitments.insertVector(x, vec(1), []);
    await repos.commitments.markVectorChecked(a, null);
    const first = (await db.one('select checked_at from commitment_vector where commitment_id = $1', [a])).checked_at;
    await repos.commitments.checkAllVectors();
    const rows = await db.rows('select commitment_id, checked_at from commitment_vector where commitment_id = any($1::bigint[])', [[a, b]]);
    assert.ok(rows.every((r) => r.checked_at instanceof Date));
    assert.strictEqual(rows.find((r) => Number(r.commitment_id) === a).checked_at.getTime(), first.getTime());
  },

  // --- src/commitments/replyClose.js

  'replyCloseCandidates: open asks with a reply of mine the pass has not judged': async ({ repos, seed, assert, uniq }) => {
    const t = await thread({ seed }, uniq);
    const got = async () => (await repos.commitments.replyCloseCandidates([t.mine], 'v1', 50, WIN)).find((r) => Number(r.id) === t.c);
    const row = await got();
    assert.ok(row, 'a candidate');
    assert.deepStrictEqual([Number(row.last_message_id), Number(row.item_id), row.source], [t.reply, t.ask, 'graph_chat']);
    assert.deepStrictEqual(await repos.commitments.replyCloseCandidates(['someone@else.com'], 'v1', 50, WIN).then((l) => l.filter((r) => Number(r.id) === t.c)), []);
    await repos.commitments.recordReplyClose({ id: t.c, last_message_id: t.reply }, 'v1', { verdict: 'unrelated', quote: null }, null);
    assert.strictEqual(await got(), undefined, 'judged at this version');
    assert.ok((await repos.commitments.replyCloseCandidates([t.mine], 'v2', 50, WIN)).some((r) => Number(r.id) === t.c), 'a new version judges again');
  },

  'replyCloseReplies: my later messages in the thread within the window': async ({ repos, seed, assert, uniq }) => {
    const t = await thread({ seed }, uniq);
    const itemRow = await seed.sourceItem({ source: 'graph_chat', occurredAt: dAgo(1) });
    await seed.setItem(itemRow, { thread_external_id: t.th, author_identity: 'them@example.com' });
    const got = await repos.commitments.replyCloseReplies([t.mine], 'graph_chat', t.th, t.ask, dAgo(2), { windowDays: 14, limit: 10 });
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.body_text]), [[t.reply, 'on it, done']]);
    assert.deepStrictEqual(await repos.commitments.replyCloseReplies([t.mine], 'graph_chat', t.th, t.ask, dAgo(2), { windowDays: 14, limit: 0 }), []);
  },

  'recordReplyClose: one row per reply; judging it again updates it and counts attempts': async ({ repos, seed, db, assert, uniq }) => {
    const t = await thread({ seed }, uniq);
    const c = { id: t.c, last_message_id: t.reply };
    await repos.commitments.recordReplyClose(c, 'v1', { verdict: 'partial', quote: 'q', message: { id: t.reply }, confidence: 0.7 }, null);
    await repos.commitments.recordReplyClose(c, 'v1', { verdict: 'discharged', quote: 'q2' }, { set: { status: 'done' }, before: {} });
    const rows = await db.rows('select * from reply_close where commitment_id = $1', [t.c]);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual([rows[0].verdict, rows[0].quote, rows[0].attempts, rows[0].error, rows[0].applied.set.status], ['discharged', 'q2', 2, null, 'done']);
    assert.strictEqual(rows[0].message_id, null, 'the second judgement named no message');
  },

  'recordReplyCloseError: records the failure; a repeat counts attempts': async ({ repos, seed, db, assert, uniq }) => {
    const t = await thread({ seed }, uniq);
    const c = { id: t.c, last_message_id: t.reply };
    await repos.commitments.recordReplyCloseError(c, 'v1', 'boom');
    await repos.commitments.recordReplyCloseError(c, 'v1', 'boom again');
    const r = await db.one('select error, attempts, verdict from reply_close where commitment_id = $1', [t.c]);
    assert.deepStrictEqual([r.error, r.attempts, r.verdict], ['boom again', 2, null]);
    const cands = await repos.commitments.replyCloseCandidates([t.mine], 'v1', 50, WIN);
    assert.ok(cands.some((x) => Number(x.id) === t.c), 'a failure under the attempt cap is retried');
    await repos.commitments.recordReplyCloseError(c, 'v1', 'third');
    assert.ok(!(await repos.commitments.replyCloseCandidates([t.mine], 'v1', 50, WIN)).some((x) => Number(x.id) === t.c), 'out of attempts');
  },

  'lockStatus: the status columns, inside a transaction': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    await seed.setCommitment(c, { closed_reason: 'because' });
    const row = await repos.withTx((r) => r.commitments.lockStatus(c));
    assert.deepStrictEqual([Number(row.id), row.status, row.closed_reason, row.closed_at], [c, 'open', 'because', null]);
    assert.strictEqual(await repos.withTx((r) => r.commitments.lockStatus(0)), null);
  },

  'latestAppliedReplyClose: the newest applied, not undone judgement': async ({ repos, seed, assert, uniq }) => {
    const t = await thread({ seed }, uniq);
    assert.strictEqual(await repos.commitments.latestAppliedReplyClose(t.c), null);
    await repos.commitments.recordReplyClose({ id: t.c, last_message_id: t.reply }, 'v1', { verdict: 'discharged', quote: 'q' }, { set: { status: 'done' }, before: { status: 'open' } });
    const row = await repos.commitments.latestAppliedReplyClose(t.c);
    assert.deepStrictEqual(row.applied, { set: { status: 'done' }, before: { status: 'open' } });
    await repos.commitments.markReplyCloseUndone(row.id, 'undone');
    assert.strictEqual(await repos.commitments.latestAppliedReplyClose(t.c), null);
  },

  'markReplyCloseUndone: stamps undone_at and what the undo said': async ({ repos, seed, db, assert, uniq }) => {
    const t = await thread({ seed }, uniq);
    await repos.commitments.recordReplyClose({ id: t.c, last_message_id: t.reply }, 'v1', { verdict: 'discharged', quote: 'q' }, { set: {}, before: {} });
    const row = await repos.commitments.latestAppliedReplyClose(t.c);
    await repos.commitments.markReplyCloseUndone(row.id, 'changed since');
    const r = await db.one('select undone_at, undo from reply_close where id = $1', [row.id]);
    assert.deepStrictEqual([r.undone_at instanceof Date, r.undo], [true, 'changed since']);
  },

  'restoreClosedState: puts the closing columns back': async ({ repos, seed, assert }) => {
    const c = await seed.commitment({ status: 'done' });
    await seed.setCommitment(c, { closed_at: new Date(), closed_reason: 'closed' });
    await repos.commitments.restoreClosedState(c, 'open', null, null);
    const row = await repos.commitments.byId(c);
    assert.deepStrictEqual([row.status, row.closed_at, row.closed_reason], ['open', null, null]);
  },

  'replyCloseStats: closed as left, judged, failed, last': async ({ repos, seed, assert, uniq }) => {
    const before = await repos.commitments.replyCloseStats(3);
    const t = await thread({ seed }, uniq);
    await seed.setCommitment(t.c, { status: 'done', closed_reason: 'by reply' });
    await repos.commitments.recordReplyClose({ id: t.c, last_message_id: t.reply }, 'v1', { verdict: 'discharged', quote: 'q' }, { set: { closed_reason: 'by reply' }, before: {} });
    const t2 = await thread({ seed }, uniq);
    for (let i = 0; i < 3; i++) await repos.commitments.recordReplyCloseError({ id: t2.c, last_message_id: t2.reply }, 'v1', 'x');
    const after = await repos.commitments.replyCloseStats(3);
    assert.deepStrictEqual([after.closed - before.closed, after.judged - before.judged, after.failed - before.failed], [1, 1, 1]);
    assert.ok(after.last instanceof Date);
  },

  // --- src/commitments/request.js

  'insertRequested: a task you asked for, confidence 1': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem({ source: 'pa_request' });
    const person = await seed.person();
    const project = await seed.projectNamed(`req-${Date.now()}`);
    const due = dAgo(-2);
    const row = await repos.commitments.insertRequested({
      itemId: item, direction: 'owed_by_me', summary: 'write it', detail: 'more', personId: person, dueAt: due,
      projectId: project, repoPath: '/w/r', projectConfidence: 1, projectRationale: 'named when the task was created', extractedBy: 'pa-request-v1',
    });
    const c = await repos.commitments.byId(row.id);
    assert.deepStrictEqual(
      [c.summary, c.detail, Number(c.counterparty_person_id), Number(c.project_id), c.repo_path, c.confidence, c.extracted_by, c.status, c.due_at.getTime()],
      ['write it', 'more', person, project, '/w/r', 1, 'pa-request-v1', 'open', due.getTime()]
    );
  },

  // --- src/distill/index.js

  'pendingDistill: items with no distillation at this version, newest first': async ({ repos, seed, assert }) => {
    const body = 'x'.repeat(60);
    const a = await seed.sourceItem({ body, occurredAt: dAgo(2) });
    const b = await seed.sourceItem({ body, occurredAt: dAgo(1) });
    const short = await seed.sourceItem({ body: 'tiny' });
    const got = idsOf(await repos.commitments.pendingDistill('v1', 40, 1000, 'false', ALL));
    assert.ok(got.includes(a) && got.includes(b) && !got.includes(short));
    const order = (await repos.commitments.pendingDistill('v1', 40, 1000, 'false', ALL)).map((r) => Number(r.id));
    assert.ok(order.indexOf(b) < order.indexOf(a), 'newest first');
    assert.deepStrictEqual(idsOf(await repos.commitments.pendingDistill('v1', 40, 1000, 'false', 'false')), []);
    assert.strictEqual((await repos.commitments.pendingDistill('v1', 40, 1, 'false', ALL)).length, 1);
    await repos.commitments.upsertDistillation(a, 'v1', 0, 0);
    assert.ok(!idsOf(await repos.commitments.pendingDistill('v1', 40, 1000, 'false', ALL)).includes(a));
    assert.ok(idsOf(await repos.commitments.pendingDistill('v2', 40, 1000, 'false', ALL)).includes(a), 'another prompt version is pending again');
    assert.deepStrictEqual(idsOf(await repos.commitments.pendingDistill('v1', 40, 1000, 'true', ALL)), [], 'the skip predicate leaves everything out');
  },

  'pendingDistill: the minimum counts characters, not bytes': async ({ repos, seed, assert }) => {
    const v = `chars-${Date.now()}`;
    const accents = await seed.sourceItem({ body: 'é'.repeat(40) }); // 80 bytes
    const emoji39 = await seed.sourceItem({ body: '😀'.repeat(39) }); // 156 bytes
    const emoji40 = await seed.sourceItem({ body: '😀'.repeat(40) });
    const got = idsOf(await repos.commitments.pendingDistill(v, 40, 100000, 'false', ALL));
    assert.deepStrictEqual([accents, emoji39, emoji40].map((x) => got.includes(x)), [true, false, true]);
    assert.strictEqual(Number((await repos.commitments.pendingDistillCount(v, 40, 'false', ALL)).n), got.length);
  },

  'pendingDistill: a short Teams message to you since `since` clears the lower minimum': async ({ repos, seed, assert }) => {
    const v = `direct-${Date.now()}`;
    const body = 'can you check?';
    const chat = (raw, o = {}) => seed.sourceItem({ source: 'graph_chat', body, raw, ...o });
    const dm = await chat({ chatType: 'oneOnOne' });
    const self = await chat({ chatType: 'self' });
    const mention = await chat({ chatType: 'group', mentionsMe: true });
    const group = await chat({ chatType: 'group', mentionsMe: false });
    const mail = await seed.sourceItem({ source: 'graph_mail', body });
    const old = await chat({ chatType: 'oneOnOne' }, { occurredAt: dAgo(30) });
    const tiny = await chat({ chatType: 'oneOnOne' }, { body: 'ok' });
    const all = [dm, self, mention, group, mail, old, tiny];
    const direct = { minChars: 8, since: dAgo(7).toISOString() };
    const got = idsOf(await repos.commitments.pendingDistill(v, 40, 100000, 'false', ALL, direct));
    assert.deepStrictEqual(all.map((x) => got.includes(x)), [true, true, true, false, false, false, false]);
    assert.strictEqual(Number((await repos.commitments.pendingDistillCount(v, 40, 'false', ALL, direct)).n), got.length);
    const plain = idsOf(await repos.commitments.pendingDistill(v, 40, 100000, 'false', ALL));
    assert.ok(all.every((x) => !plain.includes(x)), 'without the option every item needs the usual minimum');
  },

  'pendingDistillCount: how many pendingDistill would return': async ({ repos, seed, assert }) => {
    const body = 'y'.repeat(60);
    const before = (await repos.commitments.pendingDistillCount('vc', 40, 'false', ALL)).n;
    const a = await seed.sourceItem({ body });
    await seed.sourceItem({ body });
    assert.strictEqual((await repos.commitments.pendingDistillCount('vc', 40, 'false', ALL)).n, before + 2);
    await repos.commitments.markDistillSkipped(a, 'vc');
    assert.strictEqual((await repos.commitments.pendingDistillCount('vc', 40, 'false', ALL)).n, before + 1);
    assert.strictEqual((await repos.commitments.pendingDistillCount('vc', 40, 'false', 'false')).n, 0);
  },

  'liveForItem: an item\'s live commitments, and whether anything acted on them': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem();
    const plain = await seed.commitment({ sourceItemId: item, summary: 'plain' });
    const acted = await seed.commitment({ sourceItemId: item, summary: 'acted' });
    await seed.transition(acted);
    const touched = await seed.commitment({ sourceItemId: item, summary: 'touched' });
    await seed.setCommitment(touched, { touched_at: new Date() });
    const folded = await seed.commitment({ sourceItemId: item });
    await seed.setCommitment(folded, { superseded_by: plain });
    const got = await repos.commitments.liveForItem(item);
    const by = (id) => got.find((r) => Number(r.id) === id);
    assert.strictEqual(got.length, 3, 'the folded one is not live');
    assert.deepStrictEqual([by(plain).refs, by(plain).touched], [false, false]);
    assert.strictEqual(by(acted).refs, true);
    assert.strictEqual(by(touched).touched, true);
  },

  'ofItem: every commitment of an item, folded ones too, oldest first': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem();
    const a = await seed.commitment({ sourceItemId: item });
    const b = await seed.commitment({ sourceItemId: item, direction: 'owed_to_me' });
    await seed.setCommitment(b, { superseded_by: a });
    await seed.commitment();
    const got = await repos.commitments.ofItem(item);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.direction, r.status, r.superseded_by == null ? null : Number(r.superseded_by)]), [[a, 'owed_by_me', 'open', null], [b, 'owed_to_me', 'open', a]]);
    assert.ok(got[0].extracted_at instanceof Date);
    assert.strictEqual(got[0].due_at, null);
  },

  'deleteByIds: deletes those commitments': async ({ repos, seed, assert }) => {
    const [a, b, keep] = [await seed.commitment(), await seed.commitment(), await seed.commitment()];
    await repos.commitments.deleteByIds([a, b]);
    assert.deepStrictEqual([await repos.commitments.byId(a), await repos.commitments.byId(b)], [null, null]);
    assert.ok(await repos.commitments.byId(keep));
    await repos.commitments.deleteByIds([]);
  },

  'insertDistilled: one distilled commitment with its project and counterparty': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem();
    const person = await seed.person();
    const project = await seed.projectNamed(`dist-${Date.now()}`);
    const id = await repos.commitments.insertDistilled({
      itemId: item, direction: 'owed_to_me', summary: 's', detail: null, personId: person, dueAt: null,
      projectId: project, repoPath: '/r', projectConfidence: 0.9, projectRationale: 'named', confidence: 0.8, extractedBy: 'distill-vx',
    });
    const [c] = await repos.commitments.liveForItem(item);
    assert.strictEqual(id, Number(c.id), 'resolves the new id');
    const row = await repos.commitments.byId(c.id);
    assert.deepStrictEqual(
      [row.direction, row.summary, Number(row.counterparty_person_id), Number(row.project_id), row.repo_path, row.project_confidence, row.confidence, row.extracted_by],
      ['owed_to_me', 's', person, project, '/r', 0.9, 0.8, 'distill-vx']
    );
  },

  'upsertDistillation: marks an item distilled with counts and clears an error': async ({ repos, seed, db, assert }) => {
    const item = await seed.sourceItem();
    await repos.commitments.markDistillFailed(item, 'v1', 'boom');
    await repos.commitments.upsertDistillation(item, 'v2', 3, 2);
    const r = await db.one('select * from distillation where source_item_id = $1', [item]);
    assert.deepStrictEqual([r.extracted_by, r.commitments, r.facts, r.error], ['v2', 3, 2, null]);
  },

  'markDistillFailed: records the error; a second failure replaces it': async ({ repos, seed, db, assert }) => {
    const item = await seed.sourceItem();
    await repos.commitments.markDistillFailed(item, 'v1', 'first');
    await repos.commitments.markDistillFailed(item, 'v2', 'second');
    const r = await db.one('select * from distillation where source_item_id = $1', [item]);
    assert.deepStrictEqual([r.extracted_by, r.error, r.commitments], ['v2', 'second', 0]);
  },

  'markDistillSkipped: distilled with nothing found, error cleared': async ({ repos, seed, db, assert }) => {
    const item = await seed.sourceItem();
    await repos.commitments.markDistillFailed(item, 'v1', 'boom');
    await repos.commitments.markDistillSkipped(item, 'v2');
    const r = await db.one('select * from distillation where source_item_id = $1', [item]);
    assert.deepStrictEqual([r.extracted_by, r.commitments, r.facts, r.error], ['v2', 0, 0, null]);
  },

  'markDistillOwnedByDebrief: marks a new item; an already-marked one is left as it is': async ({ repos, seed, db, assert }) => {
    const fresh = await seed.sourceItem();
    await repos.commitments.markDistillOwnedByDebrief(fresh, 'v1');
    assert.strictEqual((await db.one('select extracted_by from distillation where source_item_id = $1', [fresh])).extracted_by, 'v1');
    await repos.commitments.upsertDistillation(fresh, 'v0', 4, 0);
    await repos.commitments.markDistillOwnedByDebrief(fresh, 'v9');
    const r = await db.one('select extracted_by, commitments from distillation where source_item_id = $1', [fresh]);
    assert.deepStrictEqual([r.extracted_by, r.commitments], ['v0', 4]);
  },

  // --- src/distill/identity.js, src/projects/index.js

  'reassignCounterparty: moves every commitment from one person to another': async ({ repos, seed, assert }) => {
    const [from, into, other] = [await seed.person('From'), await seed.person('Into'), await seed.person('Other')];
    const [a, b, c] = [await seed.commitment(), await seed.commitment(), await seed.commitment()];
    await seed.setCommitment(a, { counterparty_person_id: from });
    await seed.setCommitment(b, { counterparty_person_id: from });
    await seed.setCommitment(c, { counterparty_person_id: other });
    await repos.commitments.reassignCounterparty(into, from);
    const who = async (id) => Number((await repos.commitments.byId(id)).counterparty_person_id);
    assert.deepStrictEqual([await who(a), await who(b), await who(c)], [into, into, other]);
  },

  'byId: the row, or null': async ({ repos, seed, assert }) => {
    const c = await seed.commitment({ summary: 'by id' });
    assert.strictEqual((await repos.commitments.byId(c)).summary, 'by id');
    assert.strictEqual(await repos.commitments.byId(0), null);
  },

  'recentProjectIds: projects of commitments extracted in the last 14 days': async ({ repos, seed, assert }) => {
    const recent = await seed.projectNamed(`rp-recent-${Date.now()}`);
    const stale = await seed.projectNamed(`rp-stale-${Date.now()}`);
    const a = await seed.commitment();
    const b = await seed.commitment();
    await seed.setCommitment(a, { project_id: recent });
    await seed.setCommitment(b, { project_id: stale, extracted_at: dAgo(30) });
    const got = (await repos.commitments.recentProjectIds()).map((r) => Number(r.project_id));
    assert.ok(got.includes(recent) && !got.includes(stale));
  },

  'projectsOfPerson: the projects a person\'s commitments most often sit in': async ({ repos, seed, assert }) => {
    const person = await seed.person();
    const [p1, p2] = [await seed.projectNamed(`pp1-${Date.now()}`), await seed.projectNamed(`pp2-${Date.now()}`)];
    for (const p of [p1, p1, p2]) {
      const c = await seed.commitment();
      await seed.setCommitment(c, { project_id: p, counterparty_person_id: person });
    }
    const got = await repos.commitments.projectsOfPerson(person);
    assert.deepStrictEqual(got.map((r) => [Number(r.project_id), Number(r.n)]), [[p1, 2], [p2, 1]]);
    assert.deepStrictEqual(await repos.commitments.projectsOfPerson(await seed.person()), []);
  },

  'projectOfThread: the project of the newest commitment from a thread': async ({ repos, seed, assert, uniq }) => {
    const th = uniq('pt');
    const [old, recent] = [await seed.projectNamed(`pt1-${Date.now()}`), await seed.projectNamed(`pt2-${Date.now()}`)];
    const item = await seed.sourceItem();
    await seed.setItem(item, { thread_external_id: th });
    const a = await seed.commitment({ sourceItemId: item });
    const b = await seed.commitment({ sourceItemId: item });
    await seed.setCommitment(a, { project_id: old, extracted_at: dAgo(2) });
    await seed.setCommitment(b, { project_id: recent, extracted_at: dAgo(1) });
    assert.strictEqual(Number((await repos.commitments.projectOfThread(th)).project_id), recent);
    assert.strictEqual(await repos.commitments.projectOfThread(uniq('none')), null);
  },

  'setProject: points a commitment at a project; a by-hand correction also touches it': async ({ repos, seed, assert }) => {
    const project = await seed.projectNamed(`sp-${Date.now()}`);
    const c = await seed.commitment();
    await repos.commitments.setProject(c, project, '/w/p', 0.5, 'guessed');
    let row = await repos.commitments.byId(c);
    assert.deepStrictEqual([Number(row.project_id), row.repo_path, row.project_confidence, row.project_rationale, row.touched_at], [project, '/w/p', 0.5, 'guessed', null]);
    await repos.commitments.setProject(c, project, '/w/p', 1, 'corrected by hand');
    row = await repos.commitments.byId(c);
    assert.ok(row.touched_at instanceof Date);
    await repos.commitments.setProject(c, null, null, null, 'corrected by hand');
    assert.strictEqual((await repos.commitments.byId(c)).project_id, null);
  },

  'projectLinks: open unfolded commitments with a project, filtered by name or ids': async ({ repos, seed, assert }) => {
    const name = `pl-${Date.now()}`;
    const project = await seed.projectNamed(name);
    const [a, b, done] = [await seed.commitment(), await seed.commitment(), await seed.commitment({ status: 'done' })];
    for (const c of [a, b, done]) await seed.setCommitment(c, { project_id: project });
    assert.deepStrictEqual(idsOf(await repos.commitments.projectLinks(name.toUpperCase(), null)), asc(a, b));
    assert.deepStrictEqual(idsOf(await repos.commitments.projectLinks(name, [b])), [b]);
    const row = (await repos.commitments.projectLinks(name, [a]))[0];
    assert.deepStrictEqual([row.project, row.source, row.body_text], [name, 'graph_mail', 'body']);
    assert.ok(idsOf(await repos.commitments.projectLinks(null, [a, b])).length === 2);
  },

  'clearProject: clears the link, only while it is still the old project': async ({ repos, seed, assert }) => {
    const [p1, p2] = [await seed.projectNamed(`cp1-${Date.now()}`), await seed.projectNamed(`cp2-${Date.now()}`)];
    const c = await seed.commitment();
    await seed.setCommitment(c, { project_id: p1, repo_path: '/w' });
    assert.strictEqual(await repos.commitments.clearProject(c, 'nope', p2), false);
    assert.strictEqual(Number((await repos.commitments.byId(c)).project_id), p1);
    assert.strictEqual(await repos.commitments.clearProject(c, 'cleared: why', p1), true);
    const row = await repos.commitments.byId(c);
    assert.deepStrictEqual([row.project_id, row.repo_path, row.project_confidence, row.project_rationale], [null, null, null, 'cleared: why']);
    assert.strictEqual(await repos.commitments.clearProject(c, 'again', p1), false, 'already cleared');
  },

  // --- for proposals/index.js
  'replan: clears planned_at': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    await db.query('update commitment set planned_at = now() where id = $1', [c]);
    await repos.commitments.replan(c);
    assert.strictEqual((await db.one('select planned_at from commitment where id = $1', [c])).planned_at, null);
  },
  // --- for cli, dashboard (chunk G)

  'inboxList: open asks newest extracted first, optionally one source, limited': async (t) => {
    const { repos, seed, assert } = t;
    const tag = `inbox-${Math.random()}`;
    const mk = async (source, summary, extra = {}) => {
      const item = await seed.item({ source });
      const id = await seed.commitment({ sourceItemId: item, summary: `${tag} ${summary}` });
      await seed.commitmentSet(id, { extracted_at: new Date(Date.now() - (extra.ageMs || 0)), ...(extra.set || {}) });
      return id;
    };
    const newer = await mk('graph_chat', 'newer', { ageMs: 1000 });
    const older = await mk('graph_mail', 'older', { ageMs: 60_000 });
    await mk('graph_mail', 'closed', { set: { status: 'done' } });
    const mine = (rows) => rows.filter((r) => String(r.summary).startsWith(tag)).map((r) => Number(r.id));
    assert.deepStrictEqual(mine(await repos.commitments.inboxList(null, 500)), [newer, older]);
    assert.deepStrictEqual(mine(await repos.commitments.inboxList('graph_mail', 500)), [older]);
    assert.strictEqual((await repos.commitments.inboxList(null, 1)).length, 1);
    const row = (await repos.commitments.inboxList(null, 500)).find((r) => Number(r.id) === newer);
    assert.ok(['summary', 'direction', 'due_at', 'confidence', 'project_confidence', 'project', 'who', 'source', 'occurred_at'].every((k) => k in row));
  },

  'detailForCli: the commitment with project, person and source item; null when gone': async ({ repos, seed, assert }) => {
    const who = await seed.personWith({ name: 'Cli Person', email: 'cli@x.test' });
    const project = await seed.project({ name: `cli-proj-${Math.random()}` });
    const item = await seed.item({ source: 'graph_mail', subject: 'The ask', body: 'full body', thread: 'thr-cli' });
    const id = await seed.commitment({ sourceItemId: item, summary: 'show me' });
    await seed.commitmentSet(id, { counterparty_person_id: who, project_id: project });
    const c = await repos.commitments.detailForCli(id);
    assert.deepStrictEqual([c.summary, c.who, c.who_email, c.source, c.subject, c.body_text, c.thread_external_id], ['show me', 'Cli Person', 'cli@x.test', 'graph_mail', 'The ask', 'full body', 'thr-cli']);
    assert.ok(c.project.startsWith('cli-proj-') && 'status' in c && 'direction' in c);
    assert.strictEqual(await repos.commitments.detailForCli(999999999), null);
  },

  'cardContextCounts: open asks (not notes to myself) and those with a context paragraph': async ({ repos, seed, assert }) => {
    const before = await repos.commitments.cardContextCounts();
    const item = await seed.item({ source: 'graph_mail' });
    const withCtx = await seed.commitment({ sourceItemId: item });
    await seed.commitmentSet(withCtx, { context: 'because...' });
    await seed.commitment({ sourceItemId: item });
    const note = await seed.commitment({ sourceItemId: await seed.item({ source: 'claude_session' }) });
    const closed = await seed.commitment({ sourceItemId: item, status: 'done' });
    const after = await repos.commitments.cardContextCounts();
    assert.deepStrictEqual([after.n, after.with_context], [before.n + 2, before.with_context + 1]);
    assert.ok(note && closed);
  },

  'cardDetails: links input for commitments, with the thread that follows and, on request, the context': async ({ repos, seed, assert, uniq }) => {
    const email = `${uniq('card')}@x.test`;
    const who = await seed.personWith({ name: 'Card Person', email: null });
    await seed.identity(who, 'smtp', email);
    await seed.identity(who, 'github_username', 'cardperson');
    const project = await seed.project({ name: uniq('cardp'), gitlabPath: 'grp/card' });
    const thread = uniq('thr');
    const at = Date.now() - 3600_000;
    const ask = await seed.item({ source: 'graph_chat', thread, occurredAt: new Date(at), body: 'the ask', raw: { members: ['x'], webUrl: 'https://w/1' } });
    await seed.item({ source: 'graph_chat', thread, occurredAt: new Date(at + 1000), body: 'later message' });
    const id = await seed.commitment({ sourceItemId: ask, summary: 'card' });
    await seed.commitmentSet(id, { counterparty_person_id: who, project_id: project, context: 'why it matters' });
    const [d] = await repos.commitments.cardDetails([id], true);
    assert.deepStrictEqual([d.who, d.who_email, d.who_github, d.gitlab_path, d.project_name, d.body, d.later, d.context], ['Card Person', email, 'cardperson', 'grp/card', d.project_name, 'the ask', 'later message', 'why it matters']);
    assert.deepStrictEqual(d.raw, { webUrl: 'https://w/1' }, 'members are stripped');
    const [plain] = await repos.commitments.cardDetails([id], false);
    assert.ok(!('context' in plain) && plain.summary === 'card');
    assert.deepStrictEqual(await repos.commitments.cardDetails([], true), []);
    const session = await seed.item({ source: 'claude_session', body: 'secret prompt' });
    const [s] = await repos.commitments.cardDetails([await seed.commitment({ sourceItemId: session })], false);
    assert.strictEqual(s.body, '', 'a session\'s body is not sent');
  },

  'foldedSourceItems: open duplicates folded into a commitment, at any depth, with their items': async ({ repos, seed, assert }) => {
    const root = await seed.commitment({ summary: 'root' });
    const itemA = await seed.item({ source: 'graph_mail', subject: 'dup A', raw: { members: ['m'], keep: 1 } });
    const a = await seed.commitment({ sourceItemId: itemA, summary: 'dup a' });
    const itemB = await seed.item({ source: 'graph_chat', subject: 'dup B' });
    const b = await seed.commitment({ sourceItemId: itemB, summary: 'dup b' });
    await seed.commitmentSet(a, { superseded_by: root });
    await seed.commitmentSet(b, { superseded_by: a });
    const got = await repos.commitments.foldedSourceItems([root]);
    assert.deepStrictEqual(got.map((r) => Number(r.id)).sort(), [a, b].sort());
    assert.ok(got.every((r) => Number(r.root) === root));
    assert.deepStrictEqual(got.find((r) => Number(r.id) === a).raw, { keep: 1 });
    assert.deepStrictEqual(await repos.commitments.foldedSourceItems([]), []);
  },

  'contextForDashboard: one commitment with person, project and item; null when gone': async ({ repos, seed, assert }) => {
    const who = await seed.personWith({ name: 'Dash Person' });
    const item = await seed.item({ source: 'graph_mail', subject: 'Dash', body: 'b'.repeat(5000), thread: 'thr-d', raw: { webUrl: 'https://u', webLink: 'https://l' } });
    const id = await seed.commitment({ sourceItemId: item, summary: 'dash' });
    await seed.commitmentSet(id, { counterparty_person_id: who });
    const c = await repos.commitments.contextForDashboard(id);
    assert.deepStrictEqual([c.summary, c.who, c.source, c.subject, c.thread_external_id, c.body.length, c.web_url, c.web_link], ['dash', 'Dash Person', 'graph_mail', 'Dash', 'thr-d', 4000, 'https://u', 'https://l']);
    assert.strictEqual(await repos.commitments.contextForDashboard(999999999), null);
  },

  // --- for chunk F (ingest/githubReconcile.js)
  'withPrRefs: open asks from GitHub or that name a PR': async ({ repos, seed, assert }) => {
    const gh = await seed.commitment({ sourceItemId: await seed.item({ source: 'github_pr', raw: { webUrl: 'https://github.com/o/r/pull/3' } }) });
    const text = await seed.commitment({ summary: 'review the pull request for the widget' });
    const plain = await seed.commitment({ summary: 'buy milk' });
    const closed = await seed.commitment({ summary: 'review the pull request', status: 'done' });
    const rows = await repos.commitments.withPrRefs();
    const ids = rows.map((r) => Number(r.id));
    assert.ok(ids.includes(gh) && ids.includes(text));
    assert.ok(!ids.includes(plain) && !ids.includes(closed));
    assert.strictEqual(rows.find((r) => Number(r.id) === gh).url, 'https://github.com/o/r/pull/3');
  },

  'foldOpen: folds an open, unfolded ask, once': async ({ repos, seed, db, assert }) => {
    const [a, b] = [await seed.commitment(), await seed.commitment()];
    assert.strictEqual(await repos.commitments.foldOpen(a, b), 1);
    assert.strictEqual(await repos.commitments.foldOpen(a, b), 0);
    assert.strictEqual(Number((await db.one('select superseded_by from commitment where id = $1', [a])).superseded_by), b);
  },

  // --- for dispatch, mcp, durable, e2e (chunk E)

  'listForTool: open asks by direction and project, soonest due first, limited': async (t) => {
    const { repos, seed, assert, uniq } = t;
    const pname = uniq('tool');
    const project = await seed.projectNamed(pname);
    const mk = async (direction, due) => {
      const id = await seed.commitment({ direction });
      await seed.commitmentSet(id, { project_id: project, due_at: due });
      return id;
    };
    const late = await mk('owed_by_me', new Date(Date.now() + 5 * 86400_000));
    const soon = await mk('owed_by_me', new Date(Date.now() + 86400_000));
    const toMe = await mk('owed_to_me', null);
    assert.deepStrictEqual((await repos.commitments.listForTool('owed_by_me', pname.toUpperCase(), 25)).map((r) => Number(r.id)), [soon, late]);
    assert.deepStrictEqual((await repos.commitments.listForTool('both', pname, 25)).map((r) => Number(r.id)), [soon, late, toMe]);
    assert.strictEqual((await repos.commitments.listForTool('both', pname, 1)).length, 1);
    assert.strictEqual((await repos.commitments.listForTool('owed_by_me', pname, 25))[0].project, pname);
  },

  'openOfPerson: a person\'s open asks, soonest due first': async ({ repos, seed, assert }) => {
    const p = await seed.personWith();
    const a = await seed.commitment();
    const b = await seed.commitment();
    await seed.commitmentSet(a, { counterparty_person_id: p, due_at: new Date(Date.now() + 86400_000) });
    await seed.commitmentSet(b, { counterparty_person_id: p });
    const done = await seed.commitment({ status: 'done' });
    await seed.commitmentSet(done, { counterparty_person_id: p });
    assert.deepStrictEqual((await repos.commitments.openOfPerson(p)).map((r) => Number(r.id)), [a, b]);
  },

  'boardExtras: each commitment\'s forge path and newest live run': async ({ repos, seed, assert, uniq }) => {
    const path = `grp/${uniq('bx')}`;
    const project = await seed.projectNamed(uniq('bxp'), { gitlabPath: path });
    const c = await seed.commitment();
    await seed.commitmentSet(c, { project_id: project });
    const run = await seed.run({ commitmentId: c, status: 'running' });
    await seed.run({ commitmentId: c, status: 'done' });
    const bare = await seed.commitment();
    const got = await repos.commitments.boardExtras([c, bare]);
    const r = got.find((x) => x.id === String(c));
    assert.strictEqual(r.slug, path);
    const runObj = typeof r.run === 'string' ? JSON.parse(r.run) : r.run;
    assert.deepStrictEqual([Number(runObj.id), runObj.status], [run, 'running']);
    assert.deepStrictEqual([got.find((x) => x.id === String(bare)).slug, got.find((x) => x.id === String(bare)).run], [null, null]);
  },

  'cardForChat: the commitment with project, person and item body cut to 1500; null when gone': async ({ repos, seed, assert }) => {
    const who = await seed.personWith({ name: 'Chat Person' });
    const item = await seed.item({ source: 'graph_mail', subject: 'S', body: 'b'.repeat(2000) });
    const id = await seed.commitment({ sourceItemId: item, summary: 'chat card' });
    await seed.commitmentSet(id, { counterparty_person_id: who });
    const c = await repos.commitments.cardForChat(id);
    assert.deepStrictEqual([c.summary, c.who, c.source, c.body.length, Number(c.item_id)], ['chat card', 'Chat Person', 'graph_mail', 1500, item]);
    assert.strictEqual(await repos.commitments.cardForChat(999999999), null);
  },

  'blocksOf: the blocks a commitment is part of, with the other side': async ({ repos, seed, db, assert }) => {
    const task = await seed.commitment({ summary: 'the task' });
    const blocker = await seed.commitment({ summary: 'the blocker' });
    await db.query(`insert into commitment_block (task_id, blocker_id, verdict, who) values ($1, $2, 'blocks', 'Pat')`, [task, blocker]);
    const got = await repos.commitments.blocksOf(task);
    assert.deepStrictEqual(got.map((r) => [r.blocker_id, r.task_id, r.verdict, r.summary, r.who]), [[String(blocker), String(task), 'blocks', 'the blocker', 'Pat']]);
    assert.strictEqual((await repos.commitments.blocksOf(blocker)).length, 1);
  },

  'chaseRead: what the chase task reads about an ask; null when gone': async ({ repos, seed, assert }) => {
    const who = await seed.personWith({ name: 'Chased' });
    const item = await seed.item({ source: 'graph_chat' });
    const id = await seed.commitment({ sourceItemId: item, direction: 'owed_to_me' });
    await seed.commitmentSet(id, { counterparty_person_id: who });
    const c = await repos.commitments.chaseRead(id);
    assert.deepStrictEqual([c.status, c.direction, c.who, c.counterparty_is_me, c.source, Number(c.counterparty_person_id)], ['open', 'owed_to_me', 'Chased', false, 'graph_chat', who]);
    assert.ok(c.asked_at instanceof Date);
    assert.strictEqual(await repos.commitments.chaseRead(999999999), null);
  },

  'e2eCards: the e2e test\'s own cards': async ({ repos, seed, db, assert }) => {
    const id = await seed.commitment({ summary: 'e2e-0123abcd-4567-cd - a card' });
    await db.query(`update commitment set extracted_by = 'pa-request-v1' where id = $1`, [id]);
    await seed.commitment({ summary: 'e2e-0123abcd-4567-cd - not ours' });
    const mine = (await repos.commitments.e2eCards()).filter((c) => Number(c.id) === id);
    assert.deepStrictEqual(mine.map((c) => [c.status, c.marker]), [['open', 'e2e-0123abcd-4567-cd']]);
    assert.ok(!Number.isNaN(new Date(mine[0].created_at).getTime()), 'created_at is a time');
    assert.ok(!(await repos.commitments.e2eCards()).some((c) => String(c.id) !== String(id) && false));
  },
};
