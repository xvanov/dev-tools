'use strict';

// The Microsoft 365 relay reads tool results from the event stream, not from
// the model's reply: these pin the stream parsing (including results Claude
// Code spilled to disk), the paging trailer, and the item shapes downstream
// code keys on.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseToolStream } = require('../src/llm');
const { searchResults, isAutomated, PREFIX } = require('../src/ingest/m365');
const mail = require('../src/ingest/graphMail');
const chat = require('../src/ingest/graphChat');
const calendar = require('../src/ingest/graphCalendar');

const line = (o) => JSON.stringify(o);
const use = (id, name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, isError = false) =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

// stream parsing: verbatim results, spilled files, errors, non-MCP tools ignored
{
  const spill = path.join(os.tmpdir(), `pa-spill-${process.pid}.txt`);
  fs.writeFileSync(spill, JSON.stringify([{ type: 'text', text: '{"id":"b","body":{"content":"long"}}' }]));
  const out = [
    use('t0', 'ToolSearch', {}),
    result('t0', [{ type: 'text', text: 'ignored' }]),
    use('t1', `${PREFIX}read_resource`, { uri: 'u1' }),
    result('t1', [{ type: 'text', text: '{"id":"a"}' }]),
    use('t2', `${PREFIX}read_resource`, { uri: 'u2' }),
    result('t2', [{ type: 'text', text: `Error: result (58,825 characters) exceeds maximum allowed tokens. Output has been saved to ${spill}\nFormat: ...` }]),
    use('t3', `${PREFIX}read_resource`, { uri: 'u3' }),
    result('t3', [{ type: 'text', text: '{"code":"NOT_FOUND"}' }], true),
    line({ type: 'result', subtype: 'success' }),
  ].join('\n');
  const calls = parseToolStream(out);
  fs.unlinkSync(spill);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[0].results, [{ id: 'a' }]);
  assert.strictEqual(calls[1].results[0].body.content, 'long');
  assert.ok(calls[2].error.includes('NOT_FOUND'));
  assert.throws(() => parseToolStream('not json'), /claude -p exited/);

  // The newer spelling of the same spill.
  const { spilledBlocks } = require('../src/llm');
  const spill2 = path.join(os.tmpdir(), `pa-spill2-${process.pid}.json`);
  fs.writeFileSync(spill2, JSON.stringify([{ type: 'text', text: '{"id":"c"}' }]));
  const blocks = spilledBlocks(`<persisted-output>\nOutput too large (73.6KB). Full output saved to: ${spill2}\n\nPreview (first 2KB): ...`);
  fs.unlinkSync(spill2);
  assert.deepStrictEqual(blocks, ['{"id":"c"}']);
}

// paging: trailer means more; one failed page is tolerated, all failed is not
{
  const name = `${PREFIX}outlook_email_search`;
  const page = (ids, next) => ({
    name,
    error: null,
    results: [...ids.map((id) => ({ id })), next ? { moreResults: true, nextOffset: next } : { totalResultCount: 3 }],
  });
  assert.deepStrictEqual(searchResults([page(['a', 'b'], 2)], 'outlook_email_search').more, true);
  const r = searchResults([page(['a', 'b'], 2), page(['b', 'c'])], 'outlook_email_search');
  assert.deepStrictEqual(r.items.map((i) => i.id), ['a', 'b', 'c']);
  assert.strictEqual(r.more, false);
  const partial = searchResults([page(['a'], 1), { name, error: 'Error POSTing', results: [] }], 'outlook_email_search');
  assert.strictEqual(partial.items.length, 1);
  assert.strictEqual(partial.more, true);
  assert.throws(() => searchResults([{ name, error: 'boom', results: [] }], 'outlook_email_search'), /boom/);

  // Two occurrences of one recurring meeting: same id, different start — both kept.
  const cal = `${PREFIX}outlook_calendar_search`;
  const occ = (day) => ({ id: 'series1', start: { dateTime: `2026-10-${day}T09:00:00`, timeZone: 'UTC' } });
  const c = searchResults([{ name: cal, error: null, results: [occ(22), occ(23), occ(23)] }], 'outlook_calendar_search');
  assert.strictEqual(c.items.length, 2);
}

// automated senders
{
  assert.ok(isAutomated('notifications@github.com'));
  assert.ok(isAutomated('Workflows@teams.microsoft.com'));
  assert.ok(isAutomated('jira@innergy.atlassian.net'));
  assert.ok(isAutomated(null));
  assert.ok(!isAutomated('sam.taylor@example.com'));
}

// mail item
{
  const me = { mail: 'me@example.com' };
  const hit = { id: 'm1', uri: 'mail:///messages/m1', subject: 'Q', sender: 'sam@example.com', receivedDateTime: '2026-10-21T10:00:00Z', summary: 'short', webLink: 'https://x' };
  const full = { conversationId: 'c1', body: { contentType: 'html', content: '<p>Can you look?</p>' }, toRecipients: [{ emailAddress: { address: 'Me@Example.com' } }] };
  const it = mail.toItem(hit, full, me);
  assert.strictEqual(it.threadExternalId, 'c1');
  assert.strictEqual(it.authorIdentity, 'sam@example.com');
  assert.ok(it.bodyText.includes('Can you look?'));
  assert.deepStrictEqual(it.raw.to, ['me@example.com']);
  assert.strictEqual(it.raw.folder, 'inbox');
  assert.strictEqual(it.raw.partial, false);
  const sent = mail.toItem({ ...hit, sender: 'me@example.com' }, null, me);
  assert.strictEqual(sent.raw.folder, 'sent');
  assert.strictEqual(sent.bodyText, 'short');
  assert.strictEqual(sent.raw.partial, true);
}

// teams items and the channel policy
{
  const me = { id: 'oid-me', mail: 'sam.taylor@example.com', displayName: 'Sam Taylor' };
  const channelUri = 'teams:///teams/team-1/channels/19%3Achan%40thread.tacv2/messages';
  assert.deepStrictEqual(chat.channelIds(channelUri), { teamId: 'team-1', channelId: '19:chan@thread.tacv2' });
  assert.ok(chat.isTruncated('this goes on...'));
  assert.ok(!chat.isTruncated('done.'));
  assert.ok(chat.namesMe('hey Sam, can you check', me));
  assert.ok(!chat.namesMe('samples are in', me));

  const post = { id: '9', chatId: '19:chan@thread.tacv2', channelUri, summary: 'release notes', from: { email: 'brannoc@example.com' } };
  assert.strictEqual(chat.keep(post, me), false);
  assert.strictEqual(chat.keep({ ...post, summary: 'Sam can you review' }, me), true);
  assert.strictEqual(chat.keep({ id: '1', chatId: 'c', summary: 'hi', from: { email: 'brannoc@example.com' } }, me), true);
  assert.strictEqual(chat.keep({ id: '2', chatId: 'c', summary: 'card', from: { email: 'Workflows@teams.microsoft.com' } }, me), false);

  const chats = new Map([['19:dm', { chatType: 'oneOnOne', topic: null, members: 'Brannoc, Sam Taylor', memberEmails: ['brannoc@example.com'] }]]);
  const dm = chat.toItem(
    { id: '5', chatId: '19:dm', chatUri: 'teams:///chats/19%3Adm/messages', summary: 'quick q', createdDateTime: '2026-10-21T10:00:00Z', from: { email: 'Brannoc@Example.com', displayName: 'Brannoc' } },
    { body: { contentType: 'html', content: '<p>quick question</p>' }, mentions: [{ mentioned: { user: { id: 'oid-me' } } }] },
    chats,
    me
  );
  assert.strictEqual(dm.externalId, '19:dm/5');
  assert.strictEqual(dm.authorIdentity, 'brannoc@example.com');
  assert.strictEqual(dm.raw.chatType, 'oneOnOne');
  assert.strictEqual(dm.raw.mentionsMe, true);
  assert.strictEqual(dm.bodyText, 'quick question');
  const ch = chat.toItem(post, null, new Map(), me);
  assert.strictEqual(ch.raw.chatType, 'channel');
  assert.strictEqual(ch.raw.teamId, 'team-1');
}

// calendar
{
  assert.strictEqual(calendar.isoOf({ dateTime: '2026-10-22T10:00:00.0000000', timeZone: 'UTC' }), '2026-10-22T10:00:00Z');
  const ev = calendar.toItem({ id: 'e1', subject: 'Sync', organizer: 'Brannoc@Example.com', attendees: ['A@x.com'], start: { dateTime: '2026-10-22T10:00:00.0000000', timeZone: 'UTC' }, location: 'Microsoft Teams Meeting' });
  assert.strictEqual(ev.occurredAt, '2026-10-22T10:00:00Z');
  assert.strictEqual(ev.authorIdentity, 'brannoc@example.com');
  assert.deepStrictEqual(ev.raw.attendees, ['a@x.com']);
  assert.strictEqual(ev.raw.isOnlineMeeting, true);
  // Occurrences of one series share the event id; the start keeps them apart.
  assert.strictEqual(ev.externalId, 'e1@2026-10-22T10:00:00Z');
  const next = calendar.toItem({ id: 'e1', recurrence: 'weekly', start: { dateTime: '2026-10-29T10:00:00.0000000', timeZone: 'UTC' } });
  assert.notStrictEqual(next.externalId, ev.externalId);
  assert.strictEqual(next.threadExternalId, 'e1');
}

// calendar windows: the near window always; the far slices only when an hour
// has passed since they were last read, and together they cover the range.
{
  const now = new Date('2026-10-22T12:00:00Z');
  const first = calendar.windows(now);
  assert.strictEqual(first.far, true);
  assert.deepStrictEqual(first.windows[0], ['2026-10-20T12:00:00.000Z', '2026-10-30T12:00:00.000Z']);
  assert.strictEqual(first.windows.length, 1 + 1 + 4); // near, back, four forward slices to +30d
  assert.strictEqual(first.windows[first.windows.length - 1][1], '2026-11-21T12:00:00.000Z');

  const soon = calendar.windows(now, { lastFarAt: '2026-10-22T11:30:00Z' });
  assert.strictEqual(soon.far, false);
  assert.strictEqual(soon.windows.length, 1);
}

{
  // A quoted reply keeps what it answers, and a link keeps its target: "no, I
  // have a plan, review the pr <branch>" is otherwise an answer to nothing.
  const full = {
    body: { contentType: 'html', content: '<p>no, review the pr <a href="https://github.com/o/r/tree/b">b</a> or <a href="https://x.y">https://x.y</a></p>' },
    attachments: [
      { contentType: 'messageReference', content: JSON.stringify({ messagePreview: 'Is that intended?', messageSender: { user: { displayName: 'Pat' } } }) },
      { contentType: 'messageReference', content: 'not json' },
    ],
  };
  assert.strictEqual(chat.bodyOf({}, full), '[replying to Pat: "Is that intended?"]\nno, review the pr b (https://github.com/o/r/tree/b) or https://x.y');
  assert.strictEqual(chat.bodyOf({ summary: 'short' }, null), 'short');
}

console.log('m365 ok');
