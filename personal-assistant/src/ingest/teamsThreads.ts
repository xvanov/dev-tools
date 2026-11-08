'use strict';

// Which Teams cache records are not a person's message in a conversation.
// Pure; shared by the cache reader (teamsLocal.ts, which no longer stores
// them) and the source policy (sourcePolicy.ts, which keeps the rows stored
// before that off the board, and lets `pa policy close` drop their cards).
//
//  - Thread ids under `48:` are the client's own views: drafts, mentions,
//    notifications, threads, call logs. A draft is the owner's unsent text,
//    filed under the draft's chat; a mention or notification repeats a
//    message from the real chat. Only `48:notes`, the self chat, is a
//    conversation (yours, with yourself).
//  - A message id that starts with `-` is the client's local copy: `-1` for a
//    message being sent, `-4.<chat>` for a draft. The server's copy follows
//    under its own numeric id, so the local one is a duplicate whose link
//    opens nothing.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const SELF_CHAT = '48:notes';

function isSelfChat(threadId: unknown) {
  return String(threadId || '').toLowerCase() === SELF_CHAT;
}

function isSystemThread(threadId: unknown) {
  const id = String(threadId || '');
  return /^48:/i.test(id) && !isSelfChat(id);
}

function isLocalCopy(messageId: unknown) {
  return String(messageId ?? '').startsWith('-');
}

/** Why a (thread, message id) pair is not a message to keep, or null. */
function junk(threadId: unknown, messageId: unknown): string | null {
  if (isSystemThread(threadId)) return `Teams system thread (${String(threadId).toLowerCase()})`;
  if (isLocalCopy(messageId)) return 'Teams local copy of a message (id -…)';
  return null;
}

/**
 * The same for a stored graph_chat row (`thread_external_id`, `external_id`
 * `{chat}/{message}`, `raw.messageId`): whichever of them it carries.
 */
function junkOf(item: { thread_external_id?: unknown; external_id?: unknown; raw?: { messageId?: unknown } | null } | null) {
  if (!item) return null;
  const ext = String(item.external_id || '');
  const cut = ext.indexOf('/');
  const thread = item.thread_external_id || (cut > 0 ? ext.slice(0, cut) : null);
  const message = item.raw?.messageId ?? (cut > 0 ? ext.slice(cut + 1) : null);
  return junk(thread, message);
}

module.exports = { SELF_CHAT, isSelfChat, isSystemThread, isLocalCopy, junk, junkOf };
