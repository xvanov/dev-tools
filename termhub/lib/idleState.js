'use strict';

// The idle state machine — "is this agent session working, waiting on me, or
// out of tokens?" — as a pure function, so it can be tested without a PTY, a
// transcript or a clock (test/idleState.test.js).
//
// It answers for ONE session at a time from facts the caller has already
// gathered: the session's last transcript turn, how long its PTY has been
// silent, and (for opencode) what its event stream last said. Every input is a
// recorded fact except one — see BLOCKED below.
//
// Three states, and the reason the third exists:
//
//   working  — the agent is doing the work. Not your problem.
//   waiting  — the agent has stopped and needs you. THIS is the clock that runs,
//              and the number the whole layer exists to make you minimise.
//   limited  — a usage/spend limit was hit. The session is stopped and needs
//              you, but the clock does NOT run: you cannot un-idle a session
//              that has nothing left to spend, and counting it would punish the
//              user for the one pause they can't fix.

const { isWaitingForInput, isLimitNotice } = require('./claudeTranscript');

const WORKING = 'working';
const WAITING = 'waiting';
const LIMITED = 'limited';

// A PTY that produced output this recently is still mid-turn — the transcript's
// tail can be a partial entry that already looks finished. Same window (and the
// same reason) as lib/voiceHub.js's QUIET_MS and session.info()'s `busy` dot.
const QUIET_MS = 1500;

// How long a claude PTY must be silent before we conclude it is parked on
// something interactive rather than working. Claude's TUI animates a spinner
// continuously while it works, so a genuinely working session is never silent
// for anywhere near this long. Same constant as the voice layer's BLOCKED_MS,
// and the same judgement: this is the one input here that is a heuristic rather
// than a recorded fact, because a session sitting on a permission prompt or an
// AskUserQuestion writes NOTHING to its transcript until you answer.
const BLOCKED_MS = 12000;

// Classify a claude session.
//
//   turn       — readLastTurn() output, or null when no transcript exists yet
//   ptyIdleMs  — now - session.lastActivity
//
// Order matters: the limit check is first because a limit notice passes
// isWaitingForInput(), and the quiet check is second because output still
// streaming makes every other reading unreliable.
function classifyClaude({ turn, ptyIdleMs }) {
  if (isLimitNotice(turn)) return { state: LIMITED, reason: 'limit' };
  if (ptyIdleMs < QUIET_MS) return { state: WORKING, reason: 'streaming' };
  if (isWaitingForInput(turn)) return { state: WAITING, reason: 'turn-end' };
  // Silent for BLOCKED_MS with no finished turn on record: parked on a question,
  // a permission prompt, or an empty prompt box waiting for its first
  // instruction. All three are you-shaped, all three count.
  if (ptyIdleMs >= BLOCKED_MS) return { state: WAITING, reason: turn ? 'blocked' : 'prompt' };
  return { state: WORKING, reason: 'mid-turn' };
}

// Classify an opencode session. No heuristic in here at all: the TUI's own API
// publishes `session.idle` when a turn finishes and `question.asked` the moment
// it asks, and lib/session.js keeps both on the session (see
// _opencodeIdleAt / _opencodeAsk). This is the parity the Claude path has to
// guess its way to.
function classifyOpencode({ idleAt, ask }) {
  if (ask) return { state: WAITING, reason: 'question' };
  if (idleAt) return { state: WAITING, reason: 'turn-end' };
  return { state: WORKING, reason: 'mid-turn' };
}

// Which sessions are accounted at all. Shells are deliberately out: a shell
// sitting at its prompt is a tool waiting for you BY DESIGN, and counting it
// would make every day look terrible while telling you nothing you can act on.
function isTracked(session) {
  return !!session && (session.kind === 'claude' || session.kind === 'opencode');
}

module.exports = {
  WORKING, WAITING, LIMITED,
  QUIET_MS, BLOCKED_MS,
  classifyClaude, classifyOpencode, isTracked,
};
