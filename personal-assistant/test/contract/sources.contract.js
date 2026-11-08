'use strict';

// Contract: src/repo/sources.js (see test/repoContract.test.js).

//
// The "--- for meetings" cases share one database with the rest of the
// contract, so each finds its own rows by id and by unique author or subject.

const ago = (ms) => new Date(Date.now() - ms);
const AGENT = 'generated with \\[?claude code|co-authored-by:\\s*claude';
const ids = (rows) => rows.map((r) => Number(r.id));

module.exports = {
  // --- for src/backup.js
  'rewindCursors: date cursors of the named sources (all when none), delta tokens dropped': async ({ repos, seed, db, assert, uniq }) => {
    const [a, b, c] = [uniq('src'), uniq('src'), uniq('src')];
    await seed.cursor(a, { since: '2026-01-01T00:00:00Z', x: 1 });
    await seed.cursor(b, { since: '2026-01-01T00:00:00Z' });
    await seed.cursor(c, { page: 3 });
    await db.query(`update sync_cursor set delta_token = 'tok' where source = any($1::text[])`, [[a, b, c]]);
    const since = '2026-10-01T00:00:00.000Z';
    assert.deepStrictEqual(await repos.sources.rewindCursors(since, [a, c]), [a], 'no since, no rewind');
    const ra = await db.one('select state, delta_token from sync_cursor where source = $1', [a]);
    assert.deepStrictEqual([ra.state, ra.delta_token], [{ since, x: 1 }, null]);
    assert.strictEqual((await db.one('select delta_token from sync_cursor where source = $1', [b])).delta_token, 'tok');
    assert.ok((await repos.sources.rewindCursors(since, [])).includes(b), 'all sources when none named');
  },

  'deleteOldMessages: mail and chat older than the window; nothing else': async ({ repos, seed, db, assert }) => {
    const old = new Date(Date.now() - 40 * 86400_000);
    const mail = await seed.sourceItem({ source: 'graph_mail', occurredAt: old });
    const chat = await seed.sourceItem({ source: 'graph_chat', occurredAt: old });
    const meeting = await seed.sourceItem({ source: 'graph_event', occurredAt: old });
    const fresh = await seed.sourceItem({ source: 'graph_mail' });
    const n = await repos.sources.deleteOldMessages(30);
    assert.ok(n >= 2);
    const left = (await db.rows('select id from source_item where id = any($1::bigint[])', [[mail, chat, meeting, fresh]])).map((r) => Number(r.id)).sort();
    assert.deepStrictEqual(left, [meeting, fresh].sort());
    assert.strictEqual(await repos.sources.deleteOldMessages(30), 0, 'nothing left to delete');
  },


  'calendarAroundNow: events from 12h before to 1h after now': async ({ repos, seed, assert }) => {
    const subj = `gate-${Math.random()}`;
    const before = await seed.item({ subject: subj, occurredAt: ago(6 * 3600_000) });
    const soon = await seed.item({ subject: subj, occurredAt: new Date(Date.now() + 1800_000) });
    const tooOld = await seed.item({ subject: subj, occurredAt: ago(20 * 3600_000) });
    const tooFar = await seed.item({ subject: subj, occurredAt: new Date(Date.now() + 3 * 3600_000) });
    const notEvent = await seed.item({ source: 'graph_mail', subject: subj, occurredAt: ago(3600_000) });
    const got = (await repos.sources.calendarAroundNow(Date.now())).filter((r) => r.subject === subj);
    assert.strictEqual(got.length, 2, 'two in the window');
    assert.ok(got.every((r) => r.occurred_at instanceof Date && r.raw));
    assert.ok(before && soon && tooOld && tooFar && notEvent);
  },

  'calendarWindow: events within two hours of the range, oldest first': async ({ repos, seed, assert }) => {
    const from = new Date('2096-03-01T10:00:00Z');
    const to = new Date('2096-03-01T11:00:00Z');
    const mk = (extra, at) => seed.item({ externalId: `win-${extra}-${Math.random()}`, occurredAt: at });
    await mk('late', new Date('2096-03-01T12:30:00Z'));
    await mk('early', new Date('2096-03-01T08:30:00Z'));
    await mk('out', new Date('2096-03-01T14:00:00Z'));
    await mk('inner', new Date('2096-03-01T10:30:00Z'));
    const got = await repos.sources.calendarWindow(from.toISOString(), to.toISOString());
    assert.strictEqual(got.length, 3, 'early, the inner one and late; not the 14:00');
    assert.deepStrictEqual(got.map((r) => r.occurred_at.getTime()), got.map((r) => r.occurred_at.getTime()).sort((a, b) => a - b));
    assert.ok(got[0].external_id && got[0].subject && got[0].raw);
  },

  'idByExternal: an item by source and external id; null otherwise': async ({ repos, seed, assert, uniq }) => {
    const ext = uniq('ext');
    const id = await seed.item({ source: 'audio', externalId: ext });
    assert.strictEqual(Number((await repos.sources.idByExternal('audio', ext)).id), id);
    assert.strictEqual(await repos.sources.idByExternal('graph_mail', ext), null);
  },

  'recentReviews: PRs, notifications, project items and Jira issues of three weeks, newest first, 20': async ({ repos, seed, assert }) => {
    const mk = (source, days, subject) => seed.item({ source, occurredAt: ago(days * 86400_000), subject });
    const tag = `rev-${Math.random()}`;
    await mk('github_pr', 2, `${tag} newer`);
    await mk('jira_issue', 5, `${tag} older`);
    await mk('github_pr', 40, `${tag} stale`);
    await mk('graph_mail', 1, `${tag} mail`);
    const got = (await repos.sources.recentReviews()).filter((r) => String(r.subject).startsWith(tag));
    assert.deepStrictEqual(got.map((r) => r.subject), [`${tag} newer`, `${tag} older`]);
    assert.ok(got[0].source && got[0].raw && got[0].occurred_at);
    assert.ok((await repos.sources.recentReviews()).length <= 20);
  },

  'calendarToday: events from 2h ago to a day ahead, oldest first': async ({ repos, seed, assert }) => {
    const tag = `cal-${Math.random()}`;
    await seed.item({ subject: `${tag} b`, occurredAt: new Date(Date.now() + 5 * 3600_000) });
    await seed.item({ subject: `${tag} a`, occurredAt: ago(3600_000) });
    await seed.item({ subject: `${tag} gone`, occurredAt: ago(5 * 3600_000) });
    await seed.item({ subject: `${tag} later`, occurredAt: new Date(Date.now() + 3 * 86400_000) });
    const got = (await repos.sources.calendarToday()).filter((r) => String(r.subject).startsWith(tag));
    assert.deepStrictEqual(got.map((r) => r.subject), [`${tag} a`, `${tag} b`]);
  },

  'eventsBetween: calendar events in [from, to], oldest first, with the event columns': async ({ repos, seed, assert }) => {
    const from = new Date('2097-03-01T10:00:00Z');
    const a = await seed.item({ occurredAt: new Date('2097-03-01T10:30:00Z'), subject: 'A', body: 'body A', author: 'org@x.test', raw: { k: 1 } });
    const b = await seed.item({ occurredAt: new Date('2097-03-01T10:10:00Z'), subject: 'B' });
    await seed.item({ occurredAt: new Date('2097-03-01T12:30:00Z') });
    await seed.item({ source: 'graph_mail', occurredAt: new Date('2097-03-01T10:20:00Z') });
    const got = await repos.sources.eventsBetween(from, new Date('2097-03-01T11:00:00Z'));
    assert.deepStrictEqual(ids(got), [b, a]);
    assert.deepStrictEqual([got[1].subject, got[1].body_text, got[1].author_identity, got[1].raw, !!got[1].external_id], ['A', 'body A', 'org@x.test', { k: 1 }, true]);
  },

  'eventsBySubject: ilike on the subject, calendar events only, oldest first': async ({ repos, seed, assert }) => {
    const tag = `zq${Math.random().toString(36).slice(2, 8)}`;
    const a = await seed.item({ subject: `Weekly ${tag} Sync`, occurredAt: new Date('2098-01-02T10:00:00Z') });
    const b = await seed.item({ subject: `weekly ${tag} sync`, occurredAt: new Date('2098-01-01T10:00:00Z') });
    await seed.item({ source: 'graph_mail', subject: `Weekly ${tag} Sync` });
    await seed.item({ subject: 'Unrelated' });
    assert.deepStrictEqual(ids(await repos.sources.eventsBySubject(`%${tag}%`)), [b, a]);
  },

  'eventById: a calendar event by item id, not another source': async ({ repos, seed, assert }) => {
    const ev = await seed.item({ subject: 'Find me' });
    const mail = await seed.item({ source: 'graph_mail' });
    assert.strictEqual((await repos.sources.eventById(ev)).subject, 'Find me');
    assert.strictEqual(await repos.sources.eventById(mail), null);
  },

  'eventByExternalId: a calendar event by external id, not another source': async ({ repos, seed, assert, uniq }) => {
    const ext = uniq('ext');
    await seed.item({ externalId: ext, subject: 'By ext' });
    assert.strictEqual((await repos.sources.eventByExternalId(ext)).subject, 'By ext');
    assert.strictEqual(await repos.sources.eventByExternalId(uniq('none')), null);
  },

  'cursorState: a connector cursor state, or null': async ({ repos, seed, assert, uniq }) => {
    const source = uniq('conn');
    assert.strictEqual(await repos.sources.cursorState(source), null);
    await seed.cursor(source, { me: { mail: 'me@x.test' } });
    assert.deepStrictEqual((await repos.sources.cursorState(source)).state, { me: { mail: 'me@x.test' } });
  },

  'prsByAuthorBetween: an author\'s PRs in a window, newest first, flagged when agent-written': async ({ repos, seed, assert, uniq }) => {
    const author = `github:${uniq('login')}`;
    const mk = (at, body) => seed.item({ source: 'github_pr', author, occurredAt: at, body });
    const mine = await mk(ago(2 * 3600_000), 'a human description');
    const agent = await mk(ago(1 * 3600_000), 'x\n\nGenerated with [Claude Code](https://claude.com/claude-code)');
    await mk(ago(30 * 3600_000), 'too old');
    await seed.item({ source: 'github_pr', author: 'github:someone-else', occurredAt: ago(3600_000) });
    const got = await repos.sources.prsByAuthorBetween(author, ago(10 * 3600_000), new Date(), AGENT);
    assert.deepStrictEqual(ids(got), [agent, mine]);
    assert.deepStrictEqual(got.map((r) => r.agent), [true, false]);
    assert.ok(got[0].body.length <= 600 && 'raw' in got[0]);
  },

  'jiraAssignedBetween: issues assigned to any of the names in a window, newest first': async ({ repos, seed, assert, uniq }) => {
    const me = uniq('me').toLowerCase();
    const a = await seed.item({ source: 'jira_issue', occurredAt: ago(3600_000), raw: { assignee: me.toUpperCase() } });
    const b = await seed.item({ source: 'jira_issue', occurredAt: ago(2 * 3600_000), raw: { assignee: `${me}@x.test` } });
    await seed.item({ source: 'jira_issue', occurredAt: ago(3600_000), raw: { assignee: 'someone else' } });
    await seed.item({ source: 'jira_issue', occurredAt: ago(50 * 3600_000), raw: { assignee: me } });
    const got = await repos.sources.jiraAssignedBetween(ago(10 * 3600_000), new Date(), [me, `${me}@x.test`]);
    assert.deepStrictEqual(ids(got), [a, b]);
  },

  'claudeSessionsBetween: sessions in a window, most turns first, opening prompt cut to 600': async ({ repos, seed, assert }) => {
    const from = new Date('2099-06-01T00:00:00Z');
    const to = new Date('2099-06-02T00:00:00Z');
    const few = await seed.item({ source: 'claude_session', occurredAt: new Date('2099-06-01T10:00:00Z'), raw: { turns: 3 }, body: 'p'.repeat(900) });
    const many = await seed.item({ source: 'claude_session', occurredAt: new Date('2099-06-01T11:00:00Z'), raw: { turns: 30 } });
    await seed.item({ source: 'claude_session', occurredAt: new Date('2099-06-05T11:00:00Z'), raw: { turns: 99 } });
    const got = await repos.sources.claudeSessionsBetween(from, to);
    assert.deepStrictEqual(ids(got), [many, few]);
    assert.strictEqual(got[1].body.length, 600);
  },

  'openJiraAssigned: open issues assigned to the names, newest first, limited': async ({ repos, seed, assert, uniq }) => {
    const me = uniq('assignee').toLowerCase();
    const a = await seed.item({ source: 'jira_issue', occurredAt: ago(3600_000), raw: { state: 'opened', assignee: me } });
    const b = await seed.item({ source: 'jira_issue', occurredAt: ago(2 * 3600_000), raw: { state: 'opened', assignee: me } });
    await seed.item({ source: 'jira_issue', raw: { state: 'closed', assignee: me } });
    assert.deepStrictEqual(ids(await repos.sources.openJiraAssigned([me], 5)), [a, b]);
    assert.deepStrictEqual(ids(await repos.sources.openJiraAssigned([me], 1)), [a]);
  },

  'openPrsRecent: an author\'s open PRs of the last 14 days, flagged when agent-written': async ({ repos, seed, assert, uniq }) => {
    const author = `github:${uniq('login')}`;
    const now = new Date();
    const mk = (days, state, body) => seed.item({ source: 'github_pr', author, occurredAt: ago(days * 86400_000), raw: { state }, body });
    const open = await mk(1, 'opened', 'human');
    const agent = await mk(2, 'opened', 'Co-Authored-By: Claude <x>');
    await mk(3, 'merged', 'merged');
    await mk(30, 'opened', 'old');
    const got = await repos.sources.openPrsRecent(author, now, AGENT);
    assert.deepStrictEqual(ids(got), [open, agent]);
    assert.deepStrictEqual(got.map((r) => r.agent), [false, true]);
  },

  'blockedPrs: an author\'s open PRs with a label like block': async ({ repos, seed, assert, uniq }) => {
    const author = `github:${uniq('login')}`;
    const blocked = await seed.item({ source: 'github_pr', author, raw: { state: 'opened', labels: ['Blocked-by-infra'] } });
    await seed.item({ source: 'github_pr', author, raw: { state: 'opened', labels: ['bug'] } });
    await seed.item({ source: 'github_pr', author, raw: { state: 'opened' } });
    await seed.item({ source: 'github_pr', author, raw: { state: 'closed', labels: ['blocked'] } });
    assert.deepStrictEqual(ids(await repos.sources.blockedPrs(author)), [blocked]);
  },

  'threadsFromAddress: chat and mail from one address in the last 21 days, newest first': async ({ repos, seed, assert, uniq }) => {
    const email = `${uniq('who')}@x.test`;
    const a = await seed.item({ source: 'graph_chat', author: email.toUpperCase(), occurredAt: ago(3600_000), body: 'c'.repeat(300) });
    const b = await seed.item({ source: 'graph_mail', author: email, occurredAt: ago(2 * 86400_000) });
    await seed.item({ source: 'graph_mail', author: email, occurredAt: ago(30 * 86400_000) });
    await seed.item({ source: 'graph_event', author: email, occurredAt: ago(3600_000) });
    const got = await repos.sources.threadsFromAddress(email, new Date());
    assert.deepStrictEqual(ids(got), [a, b]);
    assert.strictEqual(got[0].snippet.length, 220);
  },

  'threadsFromIdentities: chat and mail from any of the identities in the last 21 days': async ({ repos, seed, assert, uniq }) => {
    const x = uniq('id');
    const y = uniq('id');
    const a = await seed.item({ source: 'graph_chat', author: x, occurredAt: ago(3600_000) });
    const b = await seed.item({ source: 'graph_mail', author: y, occurredAt: ago(2 * 3600_000) });
    await seed.item({ source: 'graph_mail', author: uniq('id'), occurredAt: ago(3600_000) });
    assert.deepStrictEqual(ids(await repos.sources.threadsFromIdentities([x, y], new Date())), [a, b]);
    assert.deepStrictEqual(await repos.sources.threadsFromIdentities([], new Date()), []);
  },

  'chatsAround: chats (not channels) from 5 min before to 2 min after the range, oldest first': async ({ repos, seed, assert }) => {
    const s = new Date('2099-07-01T10:00:00Z');
    const e = new Date('2099-07-01T11:00:00Z');
    const at = (iso, raw) => seed.item({ source: 'graph_chat', occurredAt: new Date(iso), raw, body: 'm'.repeat(300) });
    const early = await at('2099-07-01T09:56:00Z', { chatType: 'oneOnOne' });
    const mid = await at('2099-07-01T10:30:00Z', {});
    await at('2099-07-01T10:31:00Z', { chatType: 'channel' });
    await at('2099-07-01T09:50:00Z', {});
    await at('2099-07-01T11:05:00Z', {});
    const got = await repos.sources.chatsAround(s.toISOString(), e.toISOString());
    assert.deepStrictEqual(got.map((r) => r.occurred_at.toISOString()), ['2099-07-01T09:56:00.000Z', '2099-07-01T10:30:00.000Z']);
    assert.strictEqual(got[0].body.length, 240);
    assert.ok(early && mid);
  },

  'openPrsByAuthor: an author\'s open PRs of the last 60 days, newest first': async ({ repos, seed, assert, uniq }) => {
    const author = `github:${uniq('login')}`;
    const a = await seed.item({ source: 'github_pr', author, occurredAt: ago(2 * 86400_000), raw: { state: 'opened', draft: true } });
    const b = await seed.item({ source: 'github_pr', author, occurredAt: ago(40 * 86400_000), raw: { state: 'opened' } });
    await seed.item({ source: 'github_pr', author, occurredAt: ago(70 * 86400_000), raw: { state: 'opened' } });
    await seed.item({ source: 'github_pr', author, occurredAt: ago(86400_000), raw: { state: 'merged' } });
    assert.deepStrictEqual(ids(await repos.sources.openPrsByAuthor(author)), [a, b]);
  },

  'calendarBefore: events from 12h before now up to now': async ({ repos, seed, assert }) => {
    const tag = `cb-${Math.random()}`;
    await seed.item({ subject: tag, occurredAt: ago(3600_000) });
    await seed.item({ subject: tag, occurredAt: ago(20 * 3600_000) });
    await seed.item({ subject: tag, occurredAt: new Date(Date.now() + 3600_000) });
    const got = (await repos.sources.calendarBefore(new Date())).filter((r) => r.subject === tag);
    assert.strictEqual(got.length, 1);
    assert.ok(got[0].external_id && got[0].raw);
  },

  'itemsByIds: the asked-for items with their raw payload': async ({ repos, seed, assert }) => {
    const a = await seed.sourceItem({ subject: 'A', author: 'ada@example.com', raw: { webUrl: 'https://x.example/a' } });
    const b = await seed.sourceItem({ subject: 'B' });
    const list = await repos.sources.itemsByIds([a, b, -1]);
    assert.deepStrictEqual(list.map((r) => Number(r.id)).sort(), [a, b].sort());
    const ra = list.find((r) => Number(r.id) === a);
    assert.deepStrictEqual([ra.subject, ra.author_identity, ra.raw.webUrl], ['A', 'ada@example.com', 'https://x.example/a']);
    assert.ok(ra.occurred_at instanceof Date && 'body_text' in ra && 'source' in ra);
  },

    // --- for src/commitments/request.js, src/projects/index.js


  'subjectAndBody: the item\'s subject and body, or null': async ({ repos, seed, assert }) => {
    const id = await seed.sourceItem({ subject: 'Hello', body: 'World' });
    assert.deepStrictEqual({ ...(await repos.sources.subjectAndBody(id)) }, { subject: 'Hello', body_text: 'World' });
    assert.strictEqual(await repos.sources.subjectAndBody(0), null);
  },
  // --- for cli, dashboard (chunk G)

  'cursorRow: last run, last error and state of a connector; null for none': async ({ repos, seed, db, assert, uniq }) => {
    const source = uniq('conn');
    assert.strictEqual(await repos.sources.cursorRow(source), null);
    await seed.cursor(source, { site: 's' });
    await db.query(`update sync_cursor set last_error = 'boom', last_run_at = '2026-01-01T00:00:00Z' where source = $1`, [source]);
    const r = await repos.sources.cursorRow(source);
    assert.deepStrictEqual([r.last_error, r.last_run_at.toISOString(), r.state], ['boom', '2026-01-01T00:00:00.000Z', { site: 's' }]);
  },

  'claudeSessionItem: a Claude session item by id, not another source': async ({ repos, seed, assert }) => {
    const s = await seed.item({ source: 'claude_session', subject: 'a session', raw: { id: 'abc' } });
    const mail = await seed.item({ source: 'graph_mail' });
    const r = await repos.sources.claudeSessionItem(s);
    assert.deepStrictEqual([r.subject, r.raw, r.source], ['a session', { id: 'abc' }, 'claude_session']);
    assert.strictEqual(await repos.sources.claudeSessionItem(mail), null);
  },

  'threadItems: the newest twelve items of a thread, newest first, body cut to 600': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('thr');
    const ids = [];
    for (let i = 0; i < 14; i++) ids.push(await seed.item({ source: 'graph_chat', thread: thr, occurredAt: new Date(Date.now() - (20 - i) * 60_000), body: 'x'.repeat(700), author: 'a@x.test' }));
    await seed.item({ source: 'graph_chat', thread: uniq('other') });
    const got = await repos.sources.threadItems(thr);
    assert.deepStrictEqual(got.map((r) => Number(r.id)), ids.slice(2).reverse());
    assert.deepStrictEqual([got[0].body.length, got[0].author_identity], [600, 'a@x.test']);
  },

  // --- for chunk F (ingest, repos, routines)
  'upsertItem: new, then unchanged (null), then changed': async ({ repos, assert, uniq }) => {
    const it = { source: 'graph_mail', externalId: uniq('ext'), threadExternalId: null, occurredAt: new Date(), authorIdentity: 'a@x.test', subject: 's', bodyText: 'one', raw: {}, hash: 'h1' };
    const a = await repos.sources.upsertItem(it);
    assert.ok(a && a.id && a.content_hash === 'h1');
    assert.strictEqual(await repos.sources.upsertItem(it), null, 'same hash: unchanged');
    const b = await repos.sources.upsertItem({ ...it, bodyText: 'two', hash: 'h2' });
    assert.deepStrictEqual([String(b.id), b.content_hash], [String(a.id), 'h2']);
  },

  'upsertChunk: writes and rewrites a chunk, clearing its embedding': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'graph_mail' });
    await repos.sources.upsertChunk(item, 0, 'first', 'ctx', 1);
    await repos.sources.upsertChunk(item, 0, 'second', 'ctx2', 2);
    const rows = await db.rows('select content, context, context_v, embedding from chunk where source_item_id = $1', [item]);
    assert.deepStrictEqual(rows.map((r) => [r.content, r.context, r.context_v, r.embedding]), [['second', 'ctx2', 2, null]]);
  },

  'deleteChunks: an item\'s chunks only': async ({ repos, seed, db, assert }) => {
    const [a, b] = [await seed.item({ source: 'graph_mail' }), await seed.item({ source: 'graph_mail' })];
    await repos.sources.upsertChunk(a, 0, 'x', '', 1);
    await repos.sources.upsertChunk(b, 0, 'y', '', 1);
    await repos.sources.deleteChunks(a);
    const left = await db.rows('select source_item_id from chunk where source_item_id = any($1::bigint[])', [[a, b]]);
    assert.deepStrictEqual(left.map((r) => Number(r.source_item_id)), [b]);
  },

  'deleteDistillation: an item distills again': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'graph_mail' });
    await repos.commitments.markDistillSkipped(item, 'v-test');
    await repos.sources.deleteDistillation(item);
    assert.deepStrictEqual(await db.rows('select 1 from distillation where source_item_id = $1', [item]), []);
  },

  'saveCursor: token and state saved, error cleared': async ({ repos, assert, uniq }) => {
    const source = uniq('conn');
    await repos.sources.recordCursorError(source, 'boom');
    await repos.sources.saveCursor({ source, deltaToken: 'tok', state: { since: 'x' } });
    const c = await repos.sources.getCursor(source);
    assert.deepStrictEqual([c.delta_token, c.state, c.last_error], ['tok', { since: 'x' }, null]);
    assert.ok(c.last_run_at instanceof Date);
  },

  'getCursor: null for an unknown source': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.sources.getCursor(uniq('none')), null);
  },

  'recordCursorError: the error and the run time, the state kept': async ({ repos, assert, uniq }) => {
    const source = uniq('conn');
    await repos.sources.saveCursor({ source, deltaToken: 't', state: { a: 1 } });
    await repos.sources.recordCursorError(source, 'it failed');
    const c = await repos.sources.getCursor(source);
    assert.deepStrictEqual([c.last_error, c.delta_token, c.state], ['it failed', 't', { a: 1 }]);
  },

  'cursorList: every cursor with whether it has a token, by source': async ({ repos, assert, uniq }) => {
    const source = uniq('conn');
    await repos.sources.saveCursor({ source, deltaToken: 't', state: {} });
    const list = await repos.sources.cursorList();
    assert.strictEqual(list.find((c) => c.source === source).has_token, true);
    assert.deepStrictEqual(list.map((c) => c.source), [...list.map((c) => c.source)].sort());
  },

  'cursorHealth: each cursor with the newest item it brought': async ({ repos, seed, assert, uniq }) => {
    const source = uniq('src');
    await repos.sources.saveCursor({ source, deltaToken: null, state: {} });
    await seed.item({ source });
    const row = (await repos.sources.cursorHealth()).find((c) => c.source === source);
    assert.ok(row.last_item_at instanceof Date && row.last_run_at instanceof Date);
  },

  'm365Mail: the address the m365 cursor remembers': async ({ repos, seed, assert }) => {
    await seed.cursor('m365', { me: { mail: 'me@m365.test' } });
    assert.strictEqual((await repos.sources.m365Mail()).mail, 'me@m365.test');
  },

  'emptyChatMessages: recent empty Teams messages worth another try': async ({ repos, seed, db, assert, uniq }) => {
    const thr = `19:${uniq('chat')}`;
    const mk = (n, o = {}) => seed.item({ source: 'graph_chat', thread: thr, externalId: `${thr}/${n}`, body: '', ...o });
    const empty = await mk(1001);
    const full = await mk(1002, { body: 'has text' });
    const tried = await mk(1003, { raw: { repairTries: 3 } });
    const old = await mk(1004, { occurredAt: new Date(Date.now() - 20 * 86400_000) });
    const ids = (await repos.sources.emptyChatMessages(1000, 3)).map((r) => Number(r.id));
    assert.ok(ids.includes(empty));
    for (const x of [full, tried, old]) assert.ok(!ids.includes(x));
    assert.ok(db);
  },

  'repairBody: the text, a new hash, marked repaired': async ({ repos, seed, db, assert }) => {
    const id = await seed.item({ source: 'graph_chat', body: '', raw: { a: 1 } });
    await repos.sources.repairBody(id, 'found it', 'h9');
    const r = await db.one('select body_text, content_hash, raw from source_item where id = $1', [id]);
    assert.deepStrictEqual([r.body_text, r.content_hash, r.raw], ['found it', 'h9', { a: 1, repaired: true }]);
  },

  'countRepairTry: one more try each time': async ({ repos, seed, db, assert }) => {
    const id = await seed.item({ source: 'graph_chat', body: '' });
    await repos.sources.countRepairTry(id);
    await repos.sources.countRepairTry(id);
    assert.strictEqual((await db.one('select raw from source_item where id = $1', [id])).raw.repairTries, 2);
  },

  'cachedChatMessages: only those that came from the Teams cache': async ({ repos, seed, assert, uniq }) => {
    const [a, b] = [uniq('m'), uniq('m')];
    await seed.item({ source: 'graph_chat', externalId: a, raw: { via: 'teams-cache' } });
    await seed.item({ source: 'graph_chat', externalId: b });
    assert.deepStrictEqual((await repos.sources.cachedChatMessages([a, b])).map((r) => r.external_id), [a]);
  },

  'chatSenderEmails: per chat and name, the newest address': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('chat');
    await seed.item({ source: 'graph_chat', thread: thr, author: 'Old@X.test', raw: { fromName: 'Ada' }, occurredAt: new Date(Date.now() - 60_000) });
    await seed.item({ source: 'graph_chat', thread: thr, author: 'New@X.test', raw: { fromName: 'Ada' } });
    await seed.item({ source: 'graph_chat', thread: thr, author: 'aad:123', raw: { fromName: 'Bo' } });
    assert.deepStrictEqual((await repos.sources.chatSenderEmails([thr])).map((r) => [r.chat, r.name, r.email]), [[thr, 'Ada', 'new@x.test']]);
  },

  'chatHeads: per chat, the newest connector message first': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('chat');
    await seed.item({ source: 'graph_chat', thread: thr, subject: 'from cache', raw: { via: 'teams-cache' } });
    await seed.item({ source: 'graph_chat', thread: thr, subject: 'from graph', occurredAt: new Date(Date.now() - 60_000) });
    assert.deepStrictEqual((await repos.sources.chatHeads([thr])).map((r) => r.subject), ['from graph']);
  },

  'chatMessagesByExternalId: chat messages by id, with fetched_at': async ({ repos, seed, assert, uniq }) => {
    const ext = uniq('m');
    await seed.item({ source: 'graph_chat', externalId: ext });
    const [r] = await repos.sources.chatMessagesByExternalId([ext]);
    assert.ok(r.external_id === ext && r.fetched_at instanceof Date);
  },

  'claudeSessionFolders: sessions with a folder': async ({ repos, seed, assert, uniq }) => {
    const cwd = uniq('/w/s');
    await seed.item({ source: 'claude_session', raw: { cwd, machine: 'box', gitBranch: 'b' } });
    await seed.item({ source: 'claude_session', raw: {} });
    const row = (await repos.sources.claudeSessionFolders()).find((r) => r.cwd === cwd);
    assert.deepStrictEqual([row.machine, row.branch], ['box', 'b']);
  },

  'recentClaudeSessions: sessions of the last days, newest first': async ({ repos, seed, assert }) => {
    const a = await seed.item({ source: 'claude_session', body: 'older', occurredAt: new Date(Date.now() - 2 * 86400_000) });
    const b = await seed.item({ source: 'claude_session', body: 'newer', occurredAt: new Date(Date.now() - 3600_000) });
    const c = await seed.item({ source: 'claude_session', body: 'old', occurredAt: new Date(Date.now() - 30 * 86400_000) });
    const ids = (await repos.sources.recentClaudeSessions(7)).map((r) => Number(r.id));
    assert.ok(ids.indexOf(b) >= 0 && ids.indexOf(b) < ids.indexOf(a) && !ids.includes(c));
  },

  // --- for dispatch, mcp (chunk E)

  'rowById: the whole item row; null when gone': async ({ repos, seed, assert }) => {
    const id = await seed.item({ subject: 'whole', body: 'text' });
    const r = await repos.sources.rowById(id);
    assert.deepStrictEqual([r.subject, r.body_text, 'content_hash' in r], ['whole', 'text', true]);
    assert.strictEqual(await repos.sources.rowById(999999999), null);
  },

  'relatedInThread: the other items of a thread, newest first, six at most': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('thr');
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await seed.item({ thread: thr, occurredAt: new Date(Date.now() - (30 - i) * 60_000) }));
    const got = await repos.sources.relatedInThread(thr, ids[7]);
    assert.deepStrictEqual(got.map((r) => Number(r.id)), [ids[6], ids[5], ids[4], ids[3], ids[2], ids[1]]);
  },

  'relatedInThread: a thread in any source, never another thread': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('thr');
    const mail = await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(Date.now() - 3000) });
    const chat = await seed.item({ source: 'graph_chat', thread: thr, occurredAt: new Date(Date.now() - 2000) });
    const self = await seed.item({ source: 'github_pr', thread: thr, occurredAt: new Date(Date.now() - 1000) });
    await seed.item({ source: 'graph_mail', thread: uniq('other') });
    const got = await repos.sources.relatedInThread(thr, self);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.source]), [[chat, 'graph_chat'], [mail, 'graph_mail']]);
  },

  'threadRows: every item of a thread in one source, oldest first': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('thr');
    const a = await seed.item({ source: 'graph_chat', thread: thr, occurredAt: new Date(Date.now() - 2000) });
    const b = await seed.item({ source: 'graph_chat', thread: thr, occurredAt: new Date(Date.now() - 1000) });
    await seed.item({ source: 'graph_mail', thread: thr });
    assert.deepStrictEqual((await repos.sources.threadRows('graph_chat', thr)).map((r) => Number(r.id)), [a, b]);
  },

  'codeItemsOf: code items of a forge project, newest first': async ({ repos, seed, assert, uniq }) => {
    const path = `grp/${uniq('code')}`;
    const a = await seed.item({ source: 'github_pr', occurredAt: new Date(Date.now() - 2000), raw: { project: path } });
    const b = await seed.item({ source: 'github_issue', occurredAt: new Date(Date.now() - 1000), raw: { project: path } });
    await seed.item({ source: 'graph_mail', raw: { project: path } });
    const got = await repos.sources.codeItemsOf(path);
    assert.deepStrictEqual(got.map((r) => r.source), ['github_issue', 'github_pr']);
    assert.ok(a && b);
  },

  'recentByPerson: items written by a person (identity or address), newest first': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.personWith();
    const ident = uniq('gh');
    await seed.identity(p, 'github_username', ident);
    const a = await seed.item({ author: ident, occurredAt: new Date(Date.now() - 2000) });
    const b = await seed.item({ author: 'me@x.test', occurredAt: new Date(Date.now() - 1000) });
    await seed.item({ author: 'other' });
    assert.deepStrictEqual((await repos.sources.recentByPerson(p, 'me@x.test')).map((r) => Number(r.id)), [b, a]);
  },
};