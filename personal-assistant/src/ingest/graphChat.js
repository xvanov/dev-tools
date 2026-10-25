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
const { rows, query } = require('../db');
const identity = require('../distill/identity');
const { htmlToText, contentHash } = require('../util/text');
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

// A reply that quotes an earlier message carries the quote as a
// `messageReference` attachment, not in its body. Without it "no, I have a full
// plan" answers nothing anyone can see.
function quotedOf(full) {
  const out = [];
  for (const a of Array.isArray(full?.attachments) ? full.attachments : []) {
    if (a?.contentType !== 'messageReference' || !a.content) continue;
    try {
      const ref = JSON.parse(a.content);
      const who = ref.messageSender?.user?.displayName || 'someone';
      if (ref.messagePreview) out.push(`[replying to ${who}: "${String(ref.messagePreview).trim()}"]`);
    } catch {
      // not JSON: nothing to show
    }
  }
  return out.join('\n');
}

// A link's target, kept beside its text: "the pr <branch name>" is no use
// without the URL it pointed at.
function withHrefs(html) {
  return String(html).replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    const text = label.replace(/<[^>]+>/g, '').trim();
    return text && text !== href ? `${label} (${href})` : href;
  });
}

function bodyOf(hit, full) {
  const body = full?.body;
  const quoted = quotedOf(full);
  const text = body?.content ? (body.contentType === 'html' ? htmlToText(withHrefs(body.content)) : body.content) : hit.summary || '';
  return [quoted, text].filter(Boolean).join('\n');
}

// Messages saved with no text — the Teams cache sometimes has none for an
// edited reply, and the search can miss it — are read again by id, a few
// times at most. Their text is what lets the reconciler see an answer.
const REPAIR_TRIES = 3;
// Only a person's message in a real chat (not the `48:` system threads, not an
// id the cache could not read): the relay balks at a batch of junk URIs.
async function repairEmpty({ limit = 5 } = {}) {
  const empty = await rows(
    `select id, external_id, thread_external_id, subject, author_identity, raw from source_item
      where source = 'graph_chat' and body_text = '' and occurred_at > now() - interval '14 days'
        and coalesce((raw->>'repairTries')::int, 0) < ${REPAIR_TRIES}
        and thread_external_id like '19:%' and split_part(external_id, '/', 2) ~ '^[0-9]+$'
      order by occurred_at desc limit $1`,
    [limit]
  );
  if (!empty.length) return 0;
  const uriOf = (r) => {
    const id = r.raw?.messageId || String(r.external_id).split('/').pop();
    return r.raw?.teamId && r.raw?.channelId
      ? `teams:///teams/${r.raw.teamId}/channels/${r.raw.channelId}/messages/${id}`
      : `teams:///chats/${r.thread_external_id}/messages/${id}`;
  };
  const full = await m365.readAll(empty.map(uriOf));
  let fixed = 0;
  for (const r of empty) {
    const text = bodyOf({}, full.get(uriOf(r))).trim();
    if (text) {
      await query(
        `update source_item set body_text = $2, content_hash = $3, fetched_at = now(),
                raw = raw || '{"repaired": true}'::jsonb where id = $1`,
        [r.id, text, contentHash(r.subject, text, r.author_identity)]
      );
      fixed++;
    } else {
      await query(`update source_item set raw = jsonb_set(raw, '{repairTries}', to_jsonb(coalesce((raw->>'repairTries')::int, 0) + 1)) where id = $1`, [r.id]);
    }
  }
  log.info('repaired empty messages', { tried: empty.length, fixed });
  return fixed;
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
    purpose: 'connector',
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

// A message the local Teams cache (teamsLocal.js) wrote first, under the same
// `{chatId}/{messageId}`. Its body is the full text, not a search summary, so
// it is kept; the connector only *upgrades* what the cache could not know — a
// sender address where only an AAD id was known, a chat's real topic where
// the cache had none — and otherwise leaves the content hash alone, so the
// item is not distilled twice.
function mergeCached(item, cached) {
  if (!cached) return item;
  const author = String(cached.author_identity || '');
  const upgradeAuthor = !author.includes('@') && String(item.authorIdentity || '').includes('@');
  const upgradeSubject = (!cached.subject || cached.subject === 'Teams chat') && item.subject && item.subject !== 'Teams chat';
  const fill = Object.fromEntries(
    Object.entries(item.raw).filter(([, v]) => v !== null && v !== false && !(Array.isArray(v) && !v.length))
  );
  return {
    ...item,
    occurredAt: cached.occurred_at || item.occurredAt,
    authorIdentity: upgradeAuthor ? item.authorIdentity : cached.author_identity,
    subject: upgradeSubject ? item.subject : cached.subject,
    bodyText: cached.body_text || item.bodyText,
    raw: {
      ...(cached.raw || {}),
      ...fill,
      mentionsMe: Boolean(cached.raw?.mentionsMe || item.raw.mentionsMe),
      partial: false,
      via: 'teams-cache',
    },
  };
}

async function cachedRows(externalIds) {
  if (!externalIds.length) return new Map();
  const found = await rows(
    `select external_id, occurred_at, author_identity, subject, body_text, raw
       from source_item
      where source = 'graph_chat' and external_id = any($1) and raw->>'via' = 'teams-cache'`,
    [externalIds]
  );
  return new Map(found.map((r) => [r.external_id, r]));
}

// The cache knows a sender only by AAD id; once the connector names the
// address, remember the pair so the next cached message has it at once.
async function learnSenders(pairs) {
  for (const { oid, email } of pairs) {
    try {
      const personId = await identity.resolve(email);
      if (personId) await identity.addIdentity(personId, 'aad_oid', oid);
    } catch (err) {
      log.debug('sender not learned', { message: err.message });
    }
  }
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
  const cached = await cachedRows(wanted.map((h) => `${h.chatId}/${h.id}`));
  const toRead = wanted
    .filter((h) => isTruncated(h.summary) && !cached.get(`${h.chatId}/${h.id}`)?.body_text)
    .slice(0, m365.MAX_READS)
    .map(readUri);
  const full = await m365.readAll(toRead);

  const learned = [];
  const items = wanted.map((h) => {
    const prior = cached.get(`${h.chatId}/${h.id}`) || null;
    const item = mergeCached(toItem(h, full.get(readUri(h)), chats, me), prior);
    if (prior?.raw?.fromId && !String(prior.author_identity || '').includes('@') && item.authorIdentity?.includes('@')) {
      learned.push({ oid: prior.raw.fromId, email: item.authorIdentity });
    }
    return item;
  });
  const changed = await saveItems('graph_chat', items, {
    source: 'graph_chat',
    deltaToken: null,
    state: { since: m365.nextSince(passStarted) },
  });
  await learnSenders(learned);
  log.info('relayed', { found: hits.length, kept: wanted.length, read: full.size, fromCache: cached.size, changed });
  await repairEmpty().catch((err) => log.warn('repair failed', { message: String(err.message).slice(0, 160) }));
  return changed;
}

module.exports = { run, id: 'graph_chat', toItem, keep, channelIds, isTruncated, namesMe, mergeCached, quotedOf, bodyOf, repairEmpty };
