'use strict';

// Answering the PA chat's permission prompt from the Talk page: Approve or
// Deny, for the chat's own action tools only.
//
// A prompt was answerable only in termhub, because typing at it from a page
// could press an option (src/chat/feed.js). This answers it deliberately, and
// only when every check holds — otherwise it refuses and the user answers in
// termhub as before:
//
//   1. the request names the tool call the chat is parked on (its tool_use
//      id, from the transcript) — a stale button answers nothing;
//   2. that call is one of the chat's structured actions (mcp__pa-chat__<one
//      of CHAT_ACTION_TOOLS>), whose description the page shows is written
//      from structured input — never a shell command or a file edit, whose
//      one-line description would not show what is being approved;
//   3. termhub says the session is Claude Code, parked on a prompt (idleState
//      waiting, idleReason blocked);
//   4. its screen, read now, really is Claude Code's permission prompt for
//      that tool: "Do you want to proceed?" with no input box after it, the
//      server and tool named above it ("pa-chat - factory_start (MCP)", as
//      Claude Code's userFacingName writes an MCP tool), and — for Approve —
//      the cursor on "1. Yes";
// then one keystroke: Enter on "1. Yes" (once — never option 2, "don't ask
// again", which would turn every later call of the tool into an unasked one),
// or Esc ("No, and tell Claude what to do differently (esc)").
//
// The endpoint (POST /api/chat/permission, src/dashboard/server.js) needs X-PA
// and the page token, like every dashboard action that starts work.

const { CHAT_ACTION_TOOL_NAMES } = require('../mcp/chatTools');

const SERVER = 'pa-chat';
const ANSWERS = ['yes', 'no'];
const ENTER = '';
const ESC = '\x1b';

const squash = (text) => String(text || '').replace(/\s+/g, '');
const QUESTION = 'Doyouwanttoproceed?';
// Claude Code's input box (src/dispatch/termhub.js READY): seen after the
// question, the prompt was already answered.
const READY = /\?forshortcuts|shift\+tabtocycle|bypasspermissions/gi;

/** Pure. The chat action a tool_use name is, or null: `mcp__pa-chat__factory_start` → factory_start. */
function chatAction(name) {
  const m = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_]+)$/.exec(String(name || ''));
  if (!m || m[1] !== SERVER) return null;
  return CHAT_ACTION_TOOL_NAMES.includes(m[2]) ? m[2] : null;
}

function lastIndex(re, text) {
  let at = -1;
  for (const m of text.matchAll(re)) at = m.index;
  return at;
}

/**
 * Pure. Whether a termhub screen (its replay tail, ANSI stripped) is Claude
 * Code's permission prompt for `tool` on the chat's MCP server.
 * @returns {{ok: boolean, reason?: string, cursorOnYes?: boolean, escOffered?: boolean}}
 */
function readPrompt(text, tool) {
  const s = squash(text);
  const q = s.lastIndexOf(QUESTION);
  if (q < 0) return { ok: false, reason: 'the screen shows no permission prompt' };
  const after = s.slice(q + QUESTION.length);
  if (lastIndex(READY, after) >= 0) return { ok: false, reason: 'the prompt on screen was already answered' };
  if (!/Yes/.test(after) || !/No/.test(after)) return { ok: false, reason: 'the prompt on screen does not offer Yes and No' };
  // What it asks about: the tool line above the question, "pa-chat - factory_start(…) (MCP)".
  const before = s.slice(Math.max(0, q - 1500), q);
  const head = before.lastIndexOf(`${SERVER}-${tool}(`);
  if (head < 0) return { ok: false, reason: `the prompt on screen is not for ${SERVER} ${tool}` };
  // The last tool line above the question is this one: no other call of the server after it.
  if (before.indexOf(`${SERVER}-`, head + SERVER.length + 1) >= 0) return { ok: false, reason: 'the prompt on screen is for another tool call' };
  const cursor = after.lastIndexOf('❯');
  return {
    ok: true,
    // "❯ 1. Yes" (or "❯ Yes" when the options are shown without numbers) —
    // never "Yes, and don't ask again".
    cursorOnYes: cursor >= 0 && /^❯(1\.)?Yes(?!,)/.test(after.slice(cursor)),
    escOffered: /\(esc\)/i.test(after),
  };
}

/**
 * Pure. Every check before a keystroke, given what the feed and termhub know.
 * @param {object} o
 * @param {'yes'|'no'} o.answer
 * @param {string} o.toolUseId   what the page's button was for
 * @param {{toolUseId: string, name: string}|null} o.pending  the call the chat is parked on
 * @param {object|null} o.session  termhub's row for the chat session
 * @param {string} o.screen        its screen, read just now
 * @returns {{ok: true, keys: string[], tool: string} | {ok: false, reason: string}}
 */
function decide({ answer, toolUseId, pending, session, screen }) {
  if (!ANSWERS.includes(answer)) return { ok: false, reason: 'answer must be yes or no' };
  if (!pending || !pending.toolUseId) return { ok: false, reason: 'the PA chat is not waiting on a permission prompt' };
  if (!toolUseId || String(toolUseId) !== String(pending.toolUseId)) return { ok: false, reason: 'that prompt is no longer the one waiting — reload' };
  const tool = chatAction(pending.name);
  if (!tool) return { ok: false, reason: 'only the chat\'s own actions are answered from here — answer this one in termhub' };
  if (!session || session.alive === false) return { ok: false, reason: 'the PA chat session is not running' };
  if (session.kind !== 'claude') return { ok: false, reason: `not a Claude Code session (${session.kind || 'agent unknown'})` };
  if (session.idleState !== 'waiting' || session.idleReason !== 'blocked') return { ok: false, reason: 'termhub does not see the session on a permission prompt' };
  const p = readPrompt(screen, tool);
  if (!p.ok) return { ok: false, reason: p.reason };
  if (answer === 'yes') {
    if (!p.cursorOnYes) return { ok: false, reason: 'the prompt\'s cursor is not on "1. Yes" — answer it in termhub' };
    return { ok: true, keys: [ENTER], tool };
  }
  if (!p.escOffered) return { ok: false, reason: 'the prompt does not offer Esc for No — answer it in termhub' };
  return { ok: true, keys: [ESC], tool };
}

module.exports = { chatAction, readPrompt, decide, SERVER, ANSWERS, ENTER, ESC };
