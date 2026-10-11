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

// A `user` entry Claude Code writes for a local slash command (/model, /clear,
// /cost…) and its output. It is the newest turn after such a command, but no
// model request follows it — counting it as a turn in flight would clock up to
// BLOCKED_MS of agent time for typing /model.
const LOCAL_COMMAND_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

// Classify a claude session.
//
//   turn       — readLastTurn() output, or null when no transcript exists yet
//   ptyIdleMs  — now - session.lastActivity
//
// WORKING needs positive evidence from the transcript that a turn is in flight:
// your prompt or a tool_result is the newest entry (the model is answering), or
// the newest assistant entry stops on a non-asking tool_use (a tool is running).
// PTY output alone never counts — a freshly opened claude prints its banner, and
// an idle one repaints its status line, prompt box and spinner-free footer, none
// of which is the agent doing anything. That used to be the rule ("any output
// in the last QUIET_MS is streaming") and it billed every repaint as work.
//
// Current Claude Code writes an explicit stop_reason on every assistant entry
// (`end_turn` or `tool_use`; measured across this machine's transcripts), so
// "finished" is a recorded fact. The one ambiguous shape is `stop_reason: null`
// — a mid-stream fragment in older builds — and only there does fresh PTY
// output still mean "still streaming".
//
// Order matters: the limit check is first because a limit notice passes
// isWaitingForInput().
function classifyClaude({ turn, ptyIdleMs }) {
  if (isLimitNotice(turn)) return { state: LIMITED, reason: 'limit' };
  // No transcript yet: nothing has been asked of this agent. A new session sits
  // here until the first prompt lands, whatever its PTY is printing.
  if (!turn) return { state: WAITING, reason: 'prompt' };
  if (isWaitingForInput(turn)) {
    if (turn.stopReason === null && ptyIdleMs < QUIET_MS) return { state: WORKING, reason: 'streaming' };
    return { state: WAITING, reason: 'turn-end' };
  }
  if (turn.role === 'user' && LOCAL_COMMAND_RE.test(turn.text || '')) return { state: WAITING, reason: 'prompt' };
  // A turn is in flight. Silent for BLOCKED_MS anyway: parked on a permission
  // prompt, which writes nothing to the transcript until you answer — Claude's
  // TUI animates a spinner the whole time it is genuinely working.
  if (ptyIdleMs >= BLOCKED_MS) return { state: WAITING, reason: 'blocked' };
  return { state: WORKING, reason: ptyIdleMs < QUIET_MS ? 'streaming' : 'mid-turn' };
}

// Classify an opencode session. No heuristic in here at all: the TUI's own API
// publishes `session.status` (busy) / `session.idle` around every turn and
// `question.asked` the moment it asks, and lib/session.js keeps them on the
// session (_opencodeBusy / _opencodeIdleAt / _opencodeAsk).
//
// WORKING needs `busy` — a positive "a turn is running" from opencode itself.
// The old rule was "working unless we've seen it go idle", which made a freshly
// opened opencode (no turn yet, so no session.idle ever) count as working for
// as long as it sat there, and an opencode whose API never connected count as
// working forever.
function classifyOpencode({ idleAt, ask, busy }) {
  if (ask) return { state: WAITING, reason: 'question' };
  if (busy) return { state: WORKING, reason: 'mid-turn' };
  return { state: WAITING, reason: idleAt ? 'turn-end' : 'prompt' };
}

// Is this session's death worth a push?
//
// The blind spot this closes: an agent that crashed forty minutes into a task
// looks EXACTLY like one still working from a phone — it is not waiting on you,
// so the idle clock (correctly) never starts and no idle push ever fires. You
// find out when you next look at the screen.
//
// Two ways a session ends, and only one of them is news:
//   - you closed it (the ✕, or `/exit`, or the shell returning cleanly) —
//     silent. You were there; being told what you just did is noise, and noise
//     is what teaches you to swipe the channel away.
//   - it died on its own — a non-zero exit, or ANY exit while it was mid-work.
//     That second case is the one worth the interrupt: a clean exit code from a
//     session that was working means the process ended without handing anything
//     back, which is a crash by any definition that matters to you.
//
// Two inputs the caller has and this cannot see:
//   `killed`        — the session was removed from sessiond's map, i.e. the
//                     user pressed ✕. Never news.
//   `sinceInputMs`  — how long since the HUMAN last typed into it, which is the
//                     only honest way to tell "I closed this" from "this died".
//                     Typing `/exit` makes the terminal chatter exactly like a
//                     crash, so PTY output cannot answer it; and the exit code
//                     can't either, because a clean `/exit` and a TUI that gave
//                     up after finishing its cleanup both return 0.
const RECENT_INPUT_MS = 10000;

function shouldAnnounceExit({ exitCode, lastState, killed, sinceInputMs }) {
  if (killed) return false;
  // You were at the keyboard when it ended. Whatever happened, you saw it.
  if (Number.isFinite(sinceInputMs) && sinceInputMs < RECENT_INPUT_MS) return false;
  if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) return true;
  return lastState === WORKING;
}

// Which sessions are accounted at all. Shells are deliberately out: a shell
// sitting at its prompt is a tool waiting for you BY DESIGN, and counting it
// would make every day look terrible while telling you nothing you can act on.
// A `paused` session (the sidebar's ⏸ toggle) is out too, and for the user's
// own opposite reason: it's a session THEY chose to stop monitoring, not one
// that was never worth monitoring.
function isTracked(session) {
  return !!session && (session.kind === 'claude' || session.kind === 'opencode') && !session.paused;
}

module.exports = {
  WORKING, WAITING, LIMITED,
  QUIET_MS, BLOCKED_MS, RECENT_INPUT_MS,
  classifyClaude, classifyOpencode, isTracked, shouldAnnounceExit,
};
