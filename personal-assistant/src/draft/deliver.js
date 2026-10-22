'use strict';

// Where an approved draft goes, and how it gets there with a human's hand on it.
//
// The connector's grant is read-only (no Mail.Send, no ChatMessage.Send), so
// this tool cannot send — and it is better for it. "Send" in the dashboard
// opens the reply already written in Teams or Outlook; the human presses Send
// there. Nothing leaves without that keypress, which is a stronger guarantee
// than any confirmation dialog this tool could draw.
//
// Teams only prefills a message for a chat addressed by its members
// (`/l/chat/0/0?users=…&message=…`). That is exact for a 1:1. A group chat
// addressed by members can open a *new* group with the same people, and a
// channel thread cannot be prefilled at all — for those the link opens the
// existing conversation and the text goes on the clipboard to paste.
//
// Pure functions: target from a source item, links from a draft. Tested
// without a database.

// Desktop Teams takes `msteams:`; the https form is the fallback that also
// works in a browser.
const TEAMS_WEB = 'https://teams.microsoft.com';
const OUTLOOK_COMPOSE = 'https://outlook.office.com/mail/deeplink/compose';

// Prefill links carry the body in the URL. Past this length Teams and OWA
// truncate silently, so a long draft goes by clipboard instead.
const MAX_PREFILL = 1800;

function lower(list) {
  return [...new Set((list || []).map((a) => String(a || '').toLowerCase()).filter((a) => a.includes('@')))];
}

// What a reply to this item needs to know. `me` is the operator's address.
function targetFor(item, { me = null, counterpartyEmail = null } = {}) {
  const raw = item?.raw || {};
  const author = String(item?.author_identity || '').toLowerCase();
  const authorEmail = author.includes('@') ? author : counterpartyEmail;

  if (item?.source === 'graph_chat') {
    if (raw.chatType === 'channel') {
      return {
        channel: 'teams',
        kind: 'channel',
        teamId: raw.teamId || null,
        channelId: raw.channelId || null,
        messageId: raw.replyToId || raw.messageId || null,
        webUrl: raw.webUrl || null,
        label: 'Teams channel thread',
      };
    }
    // Prefill only a chat that is provably 1:1 — by type, or by its id shape
    // when the chat list did not include it (1:1 ids end @unq.gbl.spaces,
    // group and meeting chats @thread.v2). Anything else opens the existing
    // chat: addressing a group by its members can start a new one.
    const members = lower(raw.memberEmails).filter((e) => e !== me);
    const oneOnOne = raw.chatType
      ? raw.chatType === 'oneOnOne'
      : /@unq\.gbl\.spaces$/.test(String(item.thread_external_id || ''));
    const other = lower([authorEmail, counterpartyEmail, members[0]]).find((e) => e !== me) || null;
    const users = oneOnOne ? (other ? [other] : []) : members;
    return {
      channel: 'teams',
      kind: oneOnOne && users.length === 1 ? 'dm' : 'group',
      chatId: item.thread_external_id || null,
      users,
      topic: raw.chatTopic || null,
      webUrl: raw.webUrl || null,
      label: oneOnOne && users.length === 1 ? users[0] : raw.chatTopic || raw.members || 'Teams chat',
    };
  }

  const subject = item?.subject ? `Re: ${String(item.subject).replace(/^(re|fw|fwd):\s*/i, '')}` : null;
  // Your own sent mail replies to whoever you sent it to.
  const to = (authorEmail === me ? lower(raw.to || [counterpartyEmail]) : lower([authorEmail])).filter((e) => e !== me);
  const cc = item?.source === 'graph_mail'
    ? lower([...(raw.to || []), ...(raw.cc || [])]).filter((e) => e !== me && !to.includes(e))
    : [];
  return {
    channel: 'email',
    kind: 'email',
    to,
    cc,
    subject,
    webLink: raw.webLink || null,
    label: to.join(', ') || '(no recipient)',
  };
}

// The links the dashboard and `pa send` open. `prefilled` says whether the
// text rides in the link, or has to be pasted from the clipboard.
function links(draft) {
  const t = draft.target || {};
  const body = String(draft.body || '');
  const fits = body.length <= MAX_PREFILL;

  if (t.channel === 'teams' && t.kind === 'dm' && t.users?.length === 1) {
    const q = `users=${encodeURIComponent(t.users[0])}` + (fits ? `&message=${encodeURIComponent(body)}` : '');
    return {
      open: `msteams:/l/chat/0/0?${q}`,
      web: `${TEAMS_WEB}/l/chat/0/0?${q}`,
      prefilled: fits,
      how: fits ? 'Teams opens the chat with the reply typed in — press Enter to send.' : 'Teams opens the chat — paste (Ctrl+V) and send.',
    };
  }
  if (t.channel === 'teams') {
    const path = t.kind === 'channel'
      ? (t.webUrl || '').replace(/^https:\/\/teams\.microsoft\.com/, '')
      : t.chatId ? `/l/chat/${encodeURIComponent(t.chatId)}/0` : '';
    return {
      open: path ? `msteams:${path}` : null,
      web: path ? `${TEAMS_WEB}${path}` : t.webUrl || null,
      prefilled: false,
      how: `Teams opens the ${t.kind === 'channel' ? 'thread' : 'chat'} — paste (Ctrl+V) and send.`,
    };
  }

  const params = new URLSearchParams();
  if (t.to?.length) params.set('to', t.to.join(';'));
  if (t.cc?.length) params.set('cc', t.cc.join(';'));
  if (draft.subject || t.subject) params.set('subject', draft.subject || t.subject);
  if (fits) params.set('body', body);
  const url = `${OUTLOOK_COMPOSE}?${params.toString().replace(/\+/g, '%20')}`;
  return {
    open: url,
    web: url,
    original: t.webLink || null,
    prefilled: fits,
    how: fits
      ? 'Outlook opens a new message with the reply filled in — check it and press Send.'
      : 'Outlook opens a new message — paste the reply (Ctrl+V) and send.',
  };
}

module.exports = { targetFor, links, MAX_PREFILL };
