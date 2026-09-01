'use strict';

// Teams chat ingest — 1:1 and group chats, which is what delegated `Chat.Read`
// covers. Channel messages need `ChannelMessage.Read.All`, which is admin
// consent by definition and therefore out of v1 (see PLAN.md §2).
//
// There is no single delta feed for "all my chats" on delegated permissions —
// `/chats/getAllMessages` is application-permission territory. So this walks
// the chat list and keeps a delta token per chat, all of them in the cursor's
// `state` blob. That blob is the only place a per-chat token exists; losing it
// costs a re-read of recent history, which the content hash makes a no-op.
//
// Chats are ordered by last activity and capped per pass. A tenant with four
// hundred chats should not make every poll a four-hundred-request storm — the
// quiet ones will be picked up on later passes, and their messages are old.

const { getAll, getDelta } = require('../graph/client');
const { saveItems, getCursor } = require('./store');
const { htmlToText } = require('../util/text');

const MAX_CHATS_PER_PASS = 40;

function memberNames(chat) {
  return (chat.members || [])
    .map((m) => m.displayName || m.email)
    .filter(Boolean)
    .join(', ');
}

function toItem(msg, chat) {
  const html = msg.body?.contentType === 'html' ? msg.body?.content : null;
  const text = html ? htmlToText(html) : msg.body?.content || '';
  const from = msg.from?.user;

  return {
    externalId: `${chat.id}/${msg.id}`,
    threadExternalId: chat.id,
    occurredAt: msg.createdDateTime || new Date().toISOString(),
    // Teams gives an AAD object id here, not an address. person_identity is
    // what turns it back into a human; see distill/identity.js.
    authorIdentity: from?.id ? `aad:${from.id}` : from?.displayName || null,
    subject: chat.topic || memberNames(chat) || 'Teams chat',
    bodyText: text,
    raw: {
      chatType: chat.chatType,
      chatTopic: chat.topic || null,
      members: memberNames(chat),
      fromName: from?.displayName || null,
      webUrl: chat.webUrl || null,
      importance: msg.importance || null,
      mentionsMe: Array.isArray(msg.mentions) && msg.mentions.length > 0,
    },
  };
}

async function run() {
  const cursorKey = 'graph_chat';
  const cursor = await getCursor(cursorKey);
  const state = { ...(cursor?.state || {}) };
  const tokens = { ...(state.tokens || {}) };

  const chats = await getAll(
    '/me/chats?$expand=members&$orderby=lastMessagePreview/createdDateTime desc&$top=50'
  );

  let changed = 0;
  const considered = chats.slice(0, MAX_CHATS_PER_PASS);

  for (const chat of considered) {
    const start = `/me/chats/${chat.id}/messages/delta`;
    let result;
    try {
      result = await getDelta(start, tokens[chat.id], {
        headers: { Prefer: 'odata.maxpagesize=50' },
      });
    } catch (err) {
      // One inaccessible chat (a meeting chat you were removed from, a
      // federated chat the tenant blocks) must not stop the other thirty-nine.
      if (err.status === 403 || err.status === 404) {
        tokens[chat.id] = tokens[chat.id] || null;
        continue;
      }
      throw err;
    }

    const usable = result.items
      .filter((m) => m.id && !m['@removed'] && (m.body?.content || '').trim())
      // System messages (joins, renames, call-ended) carry no ask.
      .filter((m) => m.messageType === 'message')
      .map((m) => toItem(m, chat));

    if (usable.length) changed += await saveItems('graph_chat', usable, null);
    if (result.deltaLink) tokens[chat.id] = result.deltaLink;
  }

  await saveItems('graph_chat', [], {
    source: cursorKey,
    deltaToken: null,
    state: { ...state, tokens, chatsSeen: chats.length },
  });

  return changed;
}

module.exports = { run, id: 'graph_chat', toItem };
