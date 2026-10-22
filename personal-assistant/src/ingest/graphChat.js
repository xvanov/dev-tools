'use strict';

// Teams ingest — 1:1, group and meeting chats, and channel posts — through the
// Microsoft 365 connector (see m365.js).
//
// One search covers all of it: chat_message_search with `*` since the cursor
// returns messages from every chat and channel you belong to. The connector's
// grant includes ChannelMessage.Read.All, which the Entra route never had.
//
// Channels are the noisy half. A company's channels are mostly announcements,
// bots and other teams' threads, and every kept message costs a distillation
// call. So by default a channel post is kept only when it names you; set
// PA_TEAMS_CHANNELS=all to keep every post, or off to keep none. Chats are
// always kept — a chat you are in is addressed to you by construction.
//
// The search returns a ~250-character summary. Messages cut short ("…") are
// read in full through the chat URI form, which works for channel posts too;
// the channel URI form returns NOT_FOUND for the same message.

const { config } = require('../config');
const m365 = require('./m365');
const { saveItems, getCursor } = require('./store');
const { htmlToText } = require('../util/text');
const { logger } = require('../log');

const log = logger('teams');

const FIRST_RUN_DAYS = 3;

// teams:///teams/{teamId}/channels/{channelId}/messages → ids, decoded.
function channelIds(channelUri) {
  const m = String(channelUri || '').match(/^teams:\/\/\/teams\/([^/]+)\/channels\/([^/]+)\/messages/);
  return m ? { teamId: decodeURIComponent(m[1]), channelId: decodeURIComponent(m[2]) } : null;
}

function isTruncated(summary) {
  return /(\.\.\.|…)\s*$/.test(String(summary || ''));
}

function namesMe(text, me) {
  if (!me) return false;
  const t = String(text || '').toLowerCase();
  const first = String(me.displayName || '').split(/\s+/)[0].toLowerCase();
  return (first.length > 2 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(t)) ||
    t.includes(String(me.mail || '').split('@')[0]);
}

function readUri(hit) {
  return hit.chatUri ? `${hit.chatUri}/${hit.id}` : hit.uri;
}

function bodyOf(hit, full) {
  const body = full?.body;
  if (body?.content) return body.contentType === 'html' ? htmlToText(body.content) : body.content;
  return hit.summary || '';
}

function toItem(hit, full, chats, me) {
  const channel = channelIds(hit.channelUri);
  const chat = chats.get(hit.chatId) || null;
  const fromEmail = hit.from?.email ? String(hit.from.email).toLowerCase() : null;
  const text = bodyOf(hit, full);
  const mentions = Array.isArray(full?.mentions) ? full.mentions : [];
  return {
    externalId: `${hit.chatId}/${hit.id}`,
    threadExternalId: hit.chatId,
    occurredAt: hit.createdDateTime || new Date().toISOString(),
    authorIdentity: fromEmail || (full?.from?.id ? `aad:${full.from.id}` : hit.from?.displayName || null),
    subject: channel ? 'Teams channel' : chat?.topic || chat?.members || 'Teams chat',
    bodyText: text,
    raw: {
      chatType: channel ? 'channel' : chat?.chatType || null,
      chatTopic: chat?.topic || null,
      members: chat?.members || null,
      memberEmails: chat?.memberEmails || [],
      fromName: hit.from?.displayName || null,
      webUrl: hit.webUrl || full?.webUrl || null,
      importance: hit.importance || null,
      mentionsMe: mentions.some((m) => m.mentioned?.user?.id === me?.id) || namesMe(text, me),
      teamId: channel?.teamId || null,
      channelId: channel?.channelId || null,
      messageId: hit.id,
      replyToId: full?.replyToId || null,
      partial: isTruncated(hit.summary) && !full,
    },
  };
}

// chatId → { chatType, topic, members, memberEmails } for the 25 most recent
// chats. Used for subjects and for addressing a reply; a chat outside the 25
// just goes without a topic.
async function recentChats() {
  const calls = await require('../llm').toolCalls({
    prompt: 'Call teams_list_chats once with {"limit": 25}. Then reply with the single word: done',
    tools: [m365.tool('teams_list_chats')],
    timeoutMs: 120_000,
  });
  const map = new Map();
  for (const call of calls) {
    for (const c of call.results) {
      if (!c || !c.id) continue;
      const members = Array.isArray(c.members) ? c.members : [];
      map.set(c.id, {
        chatType: c.chatType || c.type || null,
        topic: c.topic || null,
        members: members.map((m) => m.displayName || m.email).filter(Boolean).join(', ') || null,
        memberEmails: members.map((m) => String(m.email || '').toLowerCase()).filter((e) => e.includes('@')),
      });
    }
  }
  return map;
}

function keep(hit, me) {
  const from = String(hit.from?.email || '').toLowerCase();
  if (m365.isAutomated(from)) return false;
  if (!hit.channelUri) return true;
  const policy = config.m365.teamsChannels;
  if (policy === 'all') return true;
  if (policy === 'off') return false;
  return from === me.mail || namesMe(hit.summary, me);
}

async function run() {
  const me = await m365.whoAmI();
  const cursor = await getCursor('graph_chat');
  const since = m365.sinceFrom(cursor, { firstRunDays: FIRST_RUN_DAYS });
  const passStarted = new Date().toISOString();

  const hits = await m365.search(
    'chat_message_search',
    { query: '*', afterDateTime: since, limit: 25 },
    { dateKey: 'createdDateTime' }
  );
  const wanted = hits.filter((h) => keep(h, me));

  const chats = wanted.some((h) => !h.channelUri) ? await recentChats().catch(() => new Map()) : new Map();
  const toRead = wanted.filter((h) => isTruncated(h.summary)).slice(0, m365.MAX_READS).map(readUri);
  const full = await m365.readAll(toRead);

  const items = wanted.map((h) => toItem(h, full.get(readUri(h)), chats, me));
  const changed = await saveItems('graph_chat', items, {
    source: 'graph_chat',
    deltaToken: null,
    state: { since: m365.nextSince(passStarted) },
  });
  log.info('relayed', { found: hits.length, kept: wanted.length, read: full.size, changed });
  return changed;
}

module.exports = { run, id: 'graph_chat', toItem, keep, channelIds, isTruncated, namesMe };
