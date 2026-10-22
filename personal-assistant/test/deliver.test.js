'use strict';

// Delivery never sends; it builds the link that opens a reply, written, where
// a human sends it. These pin who the reply is addressed to and when the text
// can ride in the link versus the clipboard.

const assert = require('assert');
const { targetFor, links, MAX_PREFILL } = require('../src/draft/deliver');

const me = 'me@example.com';

// a 1:1 chat prefills, to the author
{
  const item = {
    source: 'graph_chat',
    author_identity: 'brannoc@example.com',
    thread_external_id: '19:dm',
    raw: { chatType: 'oneOnOne', memberEmails: ['brannoc@example.com', me] },
  };
  const t = targetFor(item, { me });
  assert.deepStrictEqual(t.users, ['brannoc@example.com']);
  assert.strictEqual(t.kind, 'dm');
  const l = links({ target: t, body: 'Hi Brannoc, done & merged.' });
  assert.ok(l.open.startsWith('msteams:/l/chat/0/0?users=brannoc%40example.com&message='));
  assert.ok(l.open.includes('done%20%26%20merged'));
  assert.ok(l.web.startsWith('https://teams.microsoft.com/l/chat/0/0?'));
  assert.strictEqual(l.prefilled, true);
  assert.strictEqual(links({ target: t, body: 'x'.repeat(MAX_PREFILL + 1) }).prefilled, false);
}

// a group chat opens the existing chat and pastes, never a new group
{
  const item = {
    source: 'graph_chat',
    author_identity: 'brannoc@example.com',
    thread_external_id: '19:group@thread.v2',
    raw: { chatType: 'group', chatTopic: 'Release', memberEmails: ['brannoc@example.com', 'quill@example.com', me] },
  };
  const t = targetFor(item, { me });
  assert.strictEqual(t.kind, 'group');
  assert.deepStrictEqual(t.users, ['brannoc@example.com', 'quill@example.com']);
  const l = links({ target: t, body: 'ok' });
  assert.strictEqual(l.open, 'msteams:/l/chat/19%3Agroup%40thread.v2/0');
  assert.strictEqual(l.prefilled, false);
}

// chat type unknown: the id shape decides, and "me" is never the addressee
{
  const mine = { source: 'graph_chat', author_identity: me, thread_external_id: '19:x@thread.v2', raw: {} };
  const t = targetFor(mine, { me });
  assert.strictEqual(t.kind, 'group');
  assert.ok(!links({ target: t, body: 'x' }).open.includes('users='));
  const dm = { source: 'graph_chat', author_identity: me, thread_external_id: '19:a_b@unq.gbl.spaces', raw: {} };
  assert.deepStrictEqual(targetFor(dm, { me, counterpartyEmail: 'quill@example.com' }).users, ['quill@example.com']);
  assert.strictEqual(targetFor(dm, { me }).kind, 'group', 'a 1:1 with nobody known opens the chat');
}

// a channel post opens the thread
{
  const item = {
    source: 'graph_chat',
    author_identity: 'brannoc@example.com',
    raw: { chatType: 'channel', teamId: 't', channelId: 'c', messageId: '9', webUrl: 'https://teams.microsoft.com/l/message/19%3Ac/9' },
  };
  const l = links({ target: targetFor(item, { me }), body: 'ok' });
  assert.strictEqual(l.open, 'msteams:/l/message/19%3Ac/9');
  assert.strictEqual(l.prefilled, false);
}

// mail: reply to the sender, cc everyone else but me, Re: once
{
  const item = {
    source: 'graph_mail',
    author_identity: 'brannoc@example.com',
    subject: 'RE: Estimate',
    raw: { to: [me, 'quill@example.com'], cc: ['BRANNOC@example.com'], webLink: 'https://outlook/x' },
  };
  const t = targetFor(item, { me });
  assert.deepStrictEqual(t.to, ['brannoc@example.com']);
  assert.deepStrictEqual(t.cc, ['quill@example.com']);
  assert.strictEqual(t.subject, 'Re: Estimate');
  const l = links({ target: t, body: 'Hi, yes.', subject: null });
  const u = new URL(l.open);
  assert.strictEqual(u.origin + u.pathname, 'https://outlook.office.com/mail/deeplink/compose');
  assert.strictEqual(u.searchParams.get('to'), 'brannoc@example.com');
  assert.strictEqual(u.searchParams.get('subject'), 'Re: Estimate');
  assert.strictEqual(u.searchParams.get('body'), 'Hi, yes.');
  assert.ok(!l.open.includes('+'), 'spaces are %20, not +');
  assert.strictEqual(l.original, 'https://outlook/x');
}

// no source item: email to the counterparty if known
{
  const t = targetFor(null, { me, counterpartyEmail: 'Quill@Example.com' });
  assert.deepStrictEqual(t.to, ['quill@example.com']);
}

console.log('deliver ok');
