'use strict';

// Contract: src/repo/sources.js (see test/repoContract.test.js).

//
// The "--- for meetings" cases share one database with the rest of the
// contract, so each finds its own rows by id and by unique author or subject.

const ago = (ms) => new Date(Date.now() - ms);
const AGENT = 'generated with \\[?claude code|co-authored-by:\\s*claude';
const ids = (rows) => rows.map((r) => Number(r.id));

module.exports = {
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
};
