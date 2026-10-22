'use strict';

// The Teams cache reader's mapping: a cache record becomes exactly the item
// the connector would have made (same external id, same subject), and the
// two sources merge into one row instead of overwriting each other. All
// names and ids are invented.

const assert = require('assert');
const local = require('../src/ingest/teamsLocal');
const chat = require('../src/ingest/graphChat');
const { contentHash } = require('../src/util/text');

const ME_OID = '11111111-2222-4333-8444-555555555555';
const QUILL_OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const me = { id: ME_OID, mail: 'brannoc@example.com', displayName: 'Brannoc Vale' };
const DM = `19:${ME_OID}_${QUILL_OID}@unq.gbl.spaces`;
const CHANNEL = '19:abcdefabcdefabcdef@thread.tacv2';
const GROUP = '19:fedcbafedcbafedcba@thread.v2';

function msg(over = {}) {
  return {
    t: 'msg',
    conversationId: DM,
    id: '1761140000000',
    version: '1761140000000',
    parentMessageId: '1761140000000',
    creator: `8:orgid:${QUILL_OID}`,
    fromName: 'Quill Ashdown',
    messageType: 'RichText/Html',
    contentType: 'text',
    content: '<p>Could you send the <b>rollout plan</b> by Friday?</p>',
    arrival: Date.parse('2026-10-22T14:00:00.000Z'),
    mine: false,
    mentions: [],
    subject: null,
    importance: null,
    deleted: false,
    ...over,
  };
}

// a DM: same id scheme as the connector, text from HTML, deep link, kept
{
  const it = local.toItem(msg(), { me, authorEmail: 'quill@example.com' });
  assert.strictEqual(it.externalId, `${DM}/1761140000000`);
  assert.strictEqual(it.threadExternalId, DM);
  assert.strictEqual(it.occurredAt, '2026-10-22T14:00:00.000Z');
  assert.strictEqual(it.authorIdentity, 'quill@example.com');
  assert.strictEqual(it.bodyText, 'Could you send the rollout plan by Friday?');
  assert.strictEqual(it.subject, 'Teams chat');
  assert.strictEqual(it.raw.chatType, 'oneOnOne');
  assert.strictEqual(it.raw.via, 'teams-cache');
  assert.strictEqual(it.raw.fromId, QUILL_OID);
  assert.strictEqual(it.raw.replyToId, null);
  assert.ok(it.raw.webUrl.startsWith('https://teams.microsoft.com/l/message/19%3A'));
  assert.ok(local.isFresh({ ...it, mine: false }));
}

// an unknown sender is the AAD id graph_chat falls back to; mine is my address
{
  assert.strictEqual(local.toItem(msg(), { me }).authorIdentity, `aad:${QUILL_OID}`);
  const mine = local.toItem(msg({ mine: true, creator: `8:orgid:${ME_OID}` }), { me });
  assert.strictEqual(mine.authorIdentity, 'brannoc@example.com');
  assert.ok(!local.isFresh({ ...mine, mine: true }), 'my own message is kept but not rushed to distill');
}

// the chat's subject and members come from the connector's earlier row
{
  const thread = { subject: 'Rollout', raw: { chatType: 'group', chatTopic: 'Rollout', members: 'Quill Ashdown, Brannoc Vale', memberEmails: ['quill@example.com'] } };
  const it = local.toItem(msg({ conversationId: GROUP }), { me, thread });
  assert.strictEqual(it.subject, 'Rollout');
  assert.strictEqual(it.raw.chatType, 'group');
  assert.deepStrictEqual(it.raw.memberEmails, ['quill@example.com']);
  const conv = { topic: 'Cache topic' };
  assert.strictEqual(local.toItem(msg({ conversationId: GROUP }), { me, conv }).subject, 'Cache topic');
  assert.strictEqual(local.chatTypeOf('19:meeting_abc@thread.v2', null, null), 'meeting');
}

// bots, system events, cards and deletions are not people talking
{
  assert.strictEqual(local.toItem(msg({ creator: '28:bot-id' }), { me }), null);
  assert.strictEqual(local.toItem(msg({ messageType: 'RichText/Media_Card' }), { me }), null);
  assert.strictEqual(local.toItem(msg({ messageType: 'ThreadActivity/AddMember', creator: '19:x' }), { me }), null);
  assert.strictEqual(local.toItem(msg({ messageType: 'Event/Call' }), { me }), null);
  assert.strictEqual(local.toItem(msg({ deleted: true }), { me }), null);
  assert.strictEqual(local.toItem(msg({ messageType: 'Text', content: 'plain & simple' }), { me }).bodyText, 'plain & simple');
}

// channel posts follow PA_TEAMS_CHANNELS exactly as the connector does
{
  const post = msg({ conversationId: CHANNEL, id: '1761140000500', parentMessageId: '1761140000100' });
  assert.strictEqual(local.toItem(post, { me, policy: 'mentions' }), null);
  const atMe = { ...post, mentions: [`8:orgid:${ME_OID}`] };
  const it = local.toItem(atMe, { me, policy: 'mentions', conv: { groupId: 'team-guid' } });
  assert.strictEqual(it.subject, 'Teams channel');
  assert.strictEqual(it.raw.chatType, 'channel');
  assert.strictEqual(it.raw.channelId, CHANNEL);
  assert.strictEqual(it.raw.teamId, 'team-guid');
  assert.strictEqual(it.raw.replyToId, '1761140000100');
  assert.ok(it.raw.mentionsMe);
  assert.ok(it.raw.webUrl.includes('groupId=team-guid'));
  assert.ok(local.isFresh({ ...it, mine: false }));
  assert.ok(local.toItem({ ...post, content: 'Brannoc, a look?' }, { me, policy: 'mentions' }), 'named by first name');
  assert.ok(local.toItem(post, { me, policy: 'all' }));
  assert.strictEqual(local.toItem(atMe, { me, policy: 'off' }), null);
  assert.ok(local.toItem({ ...post, mine: true }, { me, policy: 'mentions' }), 'my own post is kept');
}

// planWrite: a connector row wins unless the message was edited after it
{
  const it = local.toItem(msg(), { me });
  assert.strictEqual(local.planWrite(it, null), it);
  const connectorRow = {
    occurred_at: new Date('2026-10-22T14:00:01Z'),
    author_identity: 'quill@example.com',
    subject: 'Teams chat',
    raw: { chatType: 'oneOnOne', webUrl: 'https://teams.example/x' },
    fetched_at: new Date('2026-10-22T14:05:00Z'),
  };
  assert.strictEqual(local.planWrite(it, connectorRow), null);
  const edit = local.toItem(msg({ version: String(Date.parse('2026-10-22T14:10:00Z')), content: '<p>Make it Monday.</p>' }), { me });
  const w = local.planWrite(edit, connectorRow);
  assert.strictEqual(w.bodyText, 'Make it Monday.');
  assert.strictEqual(w.authorIdentity, 'quill@example.com', 'the edit keeps the connector author');
  assert.strictEqual(w.raw.via, undefined, 'still the connector row');
  // a cached row the connector upgraded is never downgraded by a re-read
  const upgraded = { ...connectorRow, raw: { via: 'teams-cache' } };
  assert.strictEqual(local.planWrite(it, upgraded).authorIdentity, 'quill@example.com');
}

// mergeCached: the connector upgrades a cached row without changing its body
{
  const cachedItem = local.toItem(msg(), { me });
  const cached = {
    occurred_at: new Date(cachedItem.occurredAt),
    author_identity: cachedItem.authorIdentity,
    subject: cachedItem.subject,
    body_text: cachedItem.bodyText,
    raw: cachedItem.raw,
  };
  const hit = {
    id: '1761140000000',
    chatId: DM,
    createdDateTime: '2026-10-22T14:00:00Z',
    from: { email: 'Quill@Example.com', displayName: 'Quill Ashdown' },
    summary: 'Could you send the rollout plan by…',
    webUrl: 'https://teams.example/msg',
  };
  const chats = new Map([[DM, { chatType: 'oneOnOne', topic: null, members: 'Quill Ashdown', memberEmails: ['quill@example.com'] }]]);
  const conn = chat.toItem(hit, null, chats, me);
  assert.strictEqual(conn.externalId, cachedItem.externalId, 'both sources key the same row');
  const merged = chat.mergeCached(conn, cached);
  assert.strictEqual(merged.bodyText, cachedItem.bodyText, 'full body, not the summary');
  assert.strictEqual(merged.authorIdentity, 'quill@example.com', 'address upgraded');
  assert.strictEqual(merged.subject, 'Quill Ashdown', 'topic upgraded from the fallback');
  assert.strictEqual(merged.raw.partial, false);
  assert.strictEqual(merged.raw.via, 'teams-cache');
  assert.deepStrictEqual(merged.raw.memberEmails, ['quill@example.com']);
  assert.strictEqual(merged.raw.webUrl, 'https://teams.example/msg');
  // nothing to upgrade → identical hash → the upsert writes nothing
  const settled = { ...cached, author_identity: merged.authorIdentity, subject: merged.subject };
  const again = chat.mergeCached(conn, settled);
  assert.strictEqual(
    contentHash(again.subject, again.bodyText, again.authorIdentity),
    contentHash(settled.subject, settled.body_text, settled.author_identity)
  );
  assert.strictEqual(chat.mergeCached(conn, null), conn);
}

// reader output: JSON lines, torn lines ignored, conversations keyed by id
{
  const out = [
    JSON.stringify(msg()),
    '{"t":"msg", torn',
    JSON.stringify({ t: 'conv', id: GROUP, topic: 'Rollout' }),
    JSON.stringify({ t: 'status', ms: 12, log: { name: '000001.log', offset: 4096 } }),
    '',
  ].join('\n');
  const p = local.parseOutput(out);
  assert.strictEqual(p.messages.length, 1);
  assert.strictEqual(p.convs.get(GROUP).topic, 'Rollout');
  assert.strictEqual(p.status.log.offset, 4096);
  assert.strictEqual(local.oidOf(`8:orgid:${QUILL_OID.toUpperCase()}`), QUILL_OID);
  assert.strictEqual(local.oidOf('28:bot'), null);
}

console.log('teamsLocal ok');
