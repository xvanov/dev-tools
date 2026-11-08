'use strict';

// A new ask of you reaches you (src/notify/newAsk.ts, plan 8.4.31): which
// distilled commitments notify, how, and that the notification goes through
// the interrupt budget and quiet hours. Invented names; no toast, no chat.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-newask-'));
process.env.PA_TOASTS = '0';
process.env.PA_NTFY = 'off';
process.env.PA_QUIET_HOURS = 'off';
process.env.PA_PUSH_BUDGET = '4';

const assert = require('assert');
const N = require('../src/notify/newAsk.ts');

const now = new Date('2026-11-09T15:00:00Z');
const me = { display_name: 'Brannoc Vale', primary_email: 'brannoc@example.com' };
const DM = '19:aaaa_bbbb@unq.gbl.spaces';
const item = ({ raw = {}, ...over } = {}) => ({
  id: 41,
  source: 'graph_chat',
  author_identity: 'quill@example.com',
  thread_external_id: DM,
  occurred_at: '2026-11-09T14:59:30Z',
  ...over,
  raw: { chatType: 'oneOnOne', fromName: 'Quill Ashdown', webUrl: 'https://teams.microsoft.com/l/message/x/1', ...raw },
});
const ask = (over = {}) => ({ id: 900, direction: 'owed_by_me', summary: 'Send the numbers', dueAt: '2026-11-13T17:00:00.000Z', confidence: 0.9, ...over });

// ------------------------------------------------------------------ plan --
{
  const p = N.plan(item(), [ask()], me, { now, tz: 'UTC' });
  assert.strictEqual(p.kind, 'new_ask');
  assert.strictEqual(p.title, 'Quill Ashdown asks: Send the numbers — due Fri 13 Nov');
  assert.strictEqual(p.priority, 'normal', 'a DM pushes');
  assert.strictEqual(p.dedupeKey, 'new-ask:41', 'one notification per item');
  assert.deepStrictEqual(p.actions, [{ label: 'Open message', url: 'https://teams.microsoft.com/l/message/x/1' }]);
  assert.match(p.body, /On your board: #900/);
  assert.deepStrictEqual(p.commitments, [900]);
}
{
  assert.strictEqual(N.plan(item({ raw: { chatType: 'group' } }), [ask()], me, { now }).priority, 'digest', 'a group chat waits for the digest');
  assert.strictEqual(N.plan(item({ raw: { chatType: 'group', mentionsMe: true } }), [ask()], me, { now }).priority, 'normal', 'unless it names you');
  assert.strictEqual(N.plan(item({ source: 'graph_mail', raw: {} }), [ask()], me, { now }).priority, 'digest');
  assert.match(N.plan(item({ source: 'github_pr', author_identity: 'github:quill-dev', raw: { fromName: null } }), [ask()], me, { now }).title, /^quill-dev asks/);
}
{
  assert.strictEqual(N.plan(item({ author_identity: 'Brannoc@Example.com' }), [ask()], me, { now }), null, 'your own message is not news');
  const note = N.plan(item({ author_identity: 'brannoc@example.com', thread_external_id: '48:notes', raw: { chatType: 'self', fromName: 'Brannoc Vale' } }), [ask()], me, { now });
  assert.ok(note, 'a note in the self chat is how you hand yourself a task');
  assert.strictEqual(note.priority, 'normal');
  assert.match(note.title, /^You \(self chat\) asks:/);
}
{
  assert.strictEqual(N.plan(item({ occurred_at: '2026-11-09T10:00:00Z' }), [ask()], me, { now }), null, 'hours old: a backfill, not news');
  assert.strictEqual(N.plan(item(), [ask({ direction: 'owed_to_me' })], me, { now }), null, 'owed to you is not an ask of you');
  assert.strictEqual(N.plan(item(), [ask({ confidence: 0.3 })], me, { now }), null, 'an inferred ask does not interrupt');
  assert.strictEqual(N.plan(item(), [], me, { now }), null);
  assert.strictEqual(N.plan(item({ raw: { webUrl: 'javascript:alert(1)' } }), [ask()], me, { now }).actions.length, 0, 'only http(s) links');
  const two = N.plan(item(), [ask(), ask({ id: 901, summary: 'Book the room', dueAt: null })], me, { now });
  assert.match(two.body, /Also: Book the room/);
  assert.match(two.body, /#900, #901/);
}

// ------------------------------------------- through notify and the budget --
(async () => {
  const repo = require('../src/repo');
  const chat = require('../src/notify/chat.ts');
  const { config } = require('../src/config.ts');
  chat.deliver = async () => ({});
  let pushed = 0;
  const rows = [];
  Object.assign(repo.notifications, {
    exists: async (key) => rows.some((r) => r.dedupeKey === key),
    weight: async () => 1,
    pushedSince: async () => pushed,
    insert: async (r) => {
      const row = { id: rows.length + 1, ...r };
      rows.push(row);
      return row;
    },
    markSent: async () => {},
  });
  const fresh = () => item({ id: 100 + rows.length, occurred_at: new Date(Date.now() - 5000).toISOString() });

  const first = fresh();
  let row = await N.tell(first, [ask()], me);
  assert.strictEqual(row.kind, 'new_ask');
  assert.strictEqual(row.delivery, 'push', 'a DM within the budget pushes');
  assert.strictEqual(await N.tell(first, [ask({ id: 902 })], me), null, 'the same item again (an edit re-distilled) is not a second notification');

  pushed = 4;
  row = await N.tell(fresh(), [ask()], me);
  assert.strictEqual(row.delivery, 'digest', 'the budget spent: the digest');

  pushed = 0;
  const h = new Date().getHours();
  config.notify.quietHours = `${h}-${(h + 1) % 24}`;
  row = await N.tell(fresh(), [ask()], me);
  assert.strictEqual(row.delivery, 'digest', 'quiet hours: the digest');
  config.notify.quietHours = 'off';

  assert.strictEqual(await N.tell(fresh(), [ask({ direction: 'owed_to_me' })], me), null);
  repo.notifications.insert = async () => {
    throw new Error('db down');
  };
  assert.strictEqual(await N.tell(fresh(), [ask()], me), null, 'a failure never breaks the distill pass');

  fs.rmSync(process.env.PA_DATA_DIR, { recursive: true, force: true });
  console.log('newAsk.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
