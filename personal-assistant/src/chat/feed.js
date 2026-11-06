'use strict';

// The PA chat as a stream: what the dashboard's chat panel and the voice page
// talk to (`/api/chat*`, src/dashboard/server.js). Not a second conversation —
// the same live Claude Code session `pa chat` opens in termhub, so typing
// here, speaking, and typing in termhub are one conversation.
//
//   in    text is typed into the session through termhub
//         (POST /api/sessions/:id/input, src/dispatch/termhub.js `say`). A
//         session that was not running is started by ensureSession() and
//         briefed once Claude is at its prompt (briefClaude: it answers the
//         folder-trust question on the way).
//   out   the session's Claude Code transcript, tailed by byte offset:
//         ~/.claude/projects/<encoded pa-home>/<uuid>.jsonl. Only the PA chat
//         runs in pa-home, so the newest file there is its conversation
//         (a /clear moves it to a new file; the newest still wins).
//   state termhub's idleState for the session (working / waiting / why),
//         which also sees what the transcript cannot: a permission prompt or
//         a question writes nothing until it is answered.
//
// Our own typed message is shown at once (with its source) and its echo from
// the transcript is dropped, so a client sees it once, with our id.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const T = require('./transcript');
const { logger } = require('../log');

const log = logger('chat-feed');

const MAX_EVENTS = 500;
// The first read of a long-lived chat's transcript starts this far from the
// end: history wants the last few hundred messages, not a week of tool output.
const SEED_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 8000;
const PENDING_MS = 10 * 60_000;
const HOLD_MS = 2 * 60_000;
const SOURCES = ['typed', 'voice'];

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function sameDir(a, b) {
  return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
}

function newestTranscript(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  // Top level only: subagent conversations live in <uuid>/subagents/.
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, n), mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      /* vanished mid-scan */
    }
  }
  return best;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Everything external is injectable, for tests: `home()` the chat's cwd,
 * `root()` Claude Code's projects directory, `hub()` the termhub client,
 * `ensureSession()` src/chat's.
 */
function createFeed({
  home = () => require('./index').homeDir(),
  root = projectsRoot,
  hub = () => require('../dispatch/termhub'),
  ensureSession = () => require('./index').ensureSession(),
  pollMs = 1000,
  fastPollMs = 200,
  statusMs = 2000,
} = {}) {
  const events = [];
  const seen = new Set();
  const subs = new Set();
  let pending = [];
  let file = null;
  let offset = 0;
  let rest = Buffer.alloc(0);
  let status = null;
  let waitingOn = null;
  let sessionId = null;
  let timers = [];
  // The turn our last send started: until termhub has been seen working or
  // the transcript has shown the answer, its "idle" is the previous turn's.
  let turn = null;
  let lastRead = 0;

  function publish(e, broadcast = true) {
    if (e.type !== 'status') {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      events.push(e);
      while (events.length > MAX_EVENTS) seen.delete(events.shift().id);
    }
    if (!broadcast) return;
    for (const fn of subs) {
      try {
        fn(e);
      } catch (err) {
        log.debug('subscriber failed', { message: err.message });
      }
    }
  }

  function setStatus(next) {
    if (next === status) return;
    status = next;
    publish({ id: `status-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, type: 'status', text: next, at: new Date().toISOString() });
  }

  // Reads what the transcript gained since last time. The first read of a
  // file seeds history without broadcasting it; a new file (a /clear, a new
  // session) is news and is broadcast from its start.
  function readTranscript() {
    lastRead = Date.now();
    const found = newestTranscript(path.join(root(), T.projectDirFor(home())));
    if (!found) return;
    const quiet = file === null;
    let dropFirst = false;
    if (found.file !== file) {
      file = found.file;
      offset = quiet && found.size > SEED_BYTES ? found.size - SEED_BYTES : 0;
      dropFirst = offset > 0;
      rest = Buffer.alloc(0);
    }
    if (found.size < offset) offset = 0; // rewritten
    if (found.size === offset) return;
    let chunk;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        chunk = Buffer.alloc(found.size - offset);
        fs.readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      log.debug('transcript read failed', { message: err.message });
      return;
    }
    offset = found.size;
    let buf = Buffer.concat([rest, chunk]);
    if (dropFirst) {
      const nl = buf.indexOf(0x0a);
      buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
    }
    // Split on the last newline *byte*: a line still being written (or a
    // multi-byte character cut by the read) waits for the next read.
    const last = buf.lastIndexOf(0x0a);
    rest = Buffer.from(buf.subarray(last + 1));
    const { entries } = T.parseLines('', buf.subarray(0, last + 1).toString('utf8'));
    const now = Date.now();
    pending = pending.filter((p) => now - p.sentAt < PENDING_MS);
    for (const entry of entries) {
      for (const e of T.entryEvents(entry)) {
        if (e.type === 'user') {
          const k = pending.findIndex((p) => p.text === norm(e.text));
          if (k >= 0) {
            pending.splice(k, 1);
            continue; // already shown, with its source
          }
        }
        if (turn && e.type === 'assistant' && e.final !== false) turn.answered = true;
        publish(e, !quiet);
      }
    }
  }

  async function findSession() {
    const sessions = await hub().listSessions();
    return sessions.find((s) => s.alive !== false && sameDir(s.cwd, home())) || null;
  }

  async function pollStatus() {
    let session = null;
    try {
      session = await findSession();
    } catch (err) {
      log.debug('termhub unreachable', { message: err.message });
    }
    sessionId = session ? session.id : null;
    let st = T.sessionStatus(session);
    // A message we typed that the transcript has not shown yet is still
    // being taken: a new session sits "idle" at its prompt for seconds before
    // the first one lands. Idle then would end the turn before it began. The
    // same holds after the echo: termhub's state lags the PTY, and a
    // UserPromptSubmit hook runs before Claude looks busy, so "idle" counts
    // only once termhub has said working since the send, or the answer is in.
    readTranscript();
    const now = Date.now();
    if (turn && st.status === 'thinking') turn.working = true;
    const held = pending.some((p) => now - p.sentAt < HOLD_MS) || (turn && !turn.working && !turn.answered && now - turn.sentAt < HOLD_MS);
    if (st.status === 'idle' && held) st = { status: 'thinking', waitingOn: null };
    if (st.status !== 'thinking' && !held) turn = null;
    setStatus(st.status);
    if (st.waitingOn && !waitingOn) {
      publish({ id: `wait-${Date.now()}`, type: 'activity', text: 'waiting for your answer in termhub (a permission prompt or a question)…', at: new Date().toISOString() });
    }
    waitingOn = st.waitingOn;
  }

  // The transcript is read every fastPollMs while a turn is running (an
  // answer reaches the voice page that much sooner: a 1 s poll costs 0.5 s
  // on average) and every pollMs otherwise.
  function tickTranscript() {
    const busy = status === 'thinking' || pending.length > 0 || turn;
    if (busy || Date.now() - lastRead >= pollMs) readTranscript();
  }

  function start() {
    if (timers.length) return;
    timers = [
      setInterval(tickTranscript, Math.min(pollMs, fastPollMs)),
      setInterval(() => pollStatus().catch(() => {}), statusMs),
    ];
    for (const t of timers) t.unref?.();
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  /** Calls fn(event) for every new event; returns the unsubscribe. */
  function subscribe(fn) {
    subs.add(fn);
    readTranscript();
    start();
    pollStatus()
      .catch(() => {})
      .then(() => {
        if (subs.has(fn)) fn({ id: `status-now-${Date.now()}`, type: 'status', text: status || 'offline', at: new Date().toISOString() });
      });
    return () => {
      subs.delete(fn);
      if (!subs.size) stop();
    };
  }

  function history(limit = 50) {
    readTranscript();
    const n = Math.min(Math.max(1, Number(limit) || 50), MAX_EVENTS);
    return events.filter((e) => e.type === 'user' || e.type === 'assistant').slice(-n);
  }

  async function send({ text, source = 'typed' } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'text must be a non-empty string');
    if (text.length > MAX_TEXT) throw httpError(400, `text is over ${MAX_TEXT} characters`);
    if (!SOURCES.includes(source)) throw httpError(400, `source must be ${SOURCES.join(' or ')}`);
    // \r is Enter to a terminal: a pasted CRLF would send half a message.
    const clean = text.replace(/\r\n?/g, '\n').trim();
    await pollStatus();
    // Parked on a permission prompt or a question, the TUI would take our
    // keystrokes as the answer — Enter picks the highlighted option.
    if (waitingOn) throw httpError(409, 'the PA is waiting for an answer in termhub — answer it there first');
    readTranscript(); // so the echo of this message is matched, not an older one
    const { sessionId: id, created } = await ensureSession();
    sessionId = id;
    const event = { id: `u-${crypto.randomUUID()}`, type: 'user', text: clean, at: new Date().toISOString(), source };
    pending.push({ text: norm(clean), sentAt: Date.now() });
    turn = { sentAt: Date.now(), working: false, answered: false };
    publish(event);
    setStatus('thinking');
    const h = hub();
    if (created) {
      // A new Claude needs seconds to reach its prompt; answer now and
      // deliver when it is ready.
      h.briefClaude(h, id, clean).catch((err) => {
        log.warn('first chat message not delivered', { message: err.message });
        publish({ id: `err-${Date.now()}`, type: 'activity', text: `could not type into the PA session: ${err.message}`, at: new Date().toISOString() });
      });
    } else {
      await h.say(id, clean);
    }
    return { id: event.id };
  }

  async function session() {
    await pollStatus();
    let url = null;
    if (sessionId) url = await hub().sessionUrl(sessionId).catch(() => null);
    return { sessionId, status, waitingOn, url };
  }

  return { send, history, subscribe, session, readTranscript, pollStatus, stop };
}

let shared = null;
function feed() {
  if (!shared) shared = createFeed();
  return shared;
}

module.exports = { createFeed, feed, newestTranscript, SOURCES };
