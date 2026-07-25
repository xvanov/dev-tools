'use strict';

// The voice hub — watches armed Claude sessions for "the assistant stopped and
// is waiting on you", and tells connected browsers so they can speak it.
//
// Why polling and not a watcher: the signal lives in Claude Code's transcript
// JSONL, which is appended to continuously during a turn. fs.watch would fire
// dozens of times per turn and still need the same "is this actually the end?"
// read, so a 1 s tick over the (usually empty) armed set is simpler and bounded.
//
// The three things this file exists to get right:
//   1. Announce a turn exactly once — keyed on the transcript entry's uuid, held
//      in sessiond, so browser reconnects can't re-trigger it.
//   2. Never announce work-in-progress: a `tool_use` stop is mid-call, a
//      chattering PTY means output is still streaming, and subagent turns are
//      filtered out in lib/claudeTranscript.js.
//   3. Never break anything by failing. Every step here — stat, parse,
//      summarize, broadcast — is wrapped, because none of it is load-bearing for
//      the terminals themselves.

const fs = require('fs');
const { EventEmitter } = require('events');

const tts = require('./tts');
const { summarize } = require('./summarize');
const { readLastTurn, isWaitingForInput } = require('./claudeTranscript');

const POLL_MS = 1000;

// A PTY that produced output within this window is still mid-turn: Claude
// streams continuously while it works, and the transcript's last line during
// streaming can be a partial assistant entry that looks finished. Matches the
// `busy` window in lib/session.js info() on purpose.
const QUIET_MS = 1500;

class VoiceHub extends EventEmitter {
  // `sessions` is sessiond's live Map<id, Session>; the hub only reads it. The
  // armed flag lives on the sessions themselves (session.voiceArmed) so it can
  // never drift out of sync with the map — a killed session is simply gone.
  constructor(sessions) {
    super();
    this.sessions = sessions;
    this.clients = new Set(); // each is a function(msgObject)
    this._state = new Map();  // sessionId -> per-session watch state
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), POLL_MS);
    // Don't hold the process open on the hub's account — sessiond's HTTP server
    // is what keeps the event loop alive.
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---- clients ---------------------------------------------------------------

  addClient(send) {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  broadcast(msg) {
    for (const send of this.clients) {
      try {
        send(msg);
      } catch {
        // a client that vanished mid-broadcast; its own close handler removes it
      }
    }
  }

  // ---- arming ----------------------------------------------------------------

  // Returns the new armed state, or null when there's no such session.
  setArmed(id, armed) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.voiceArmed = !!armed;
    // Disarming forgets the watch state, so re-arming later re-reads from
    // scratch — the user asked to stop listening, not to skip the next turn.
    if (!session.voiceArmed) this._state.delete(id);
    this.broadcast({ type: 'armed', sessionId: id, armed: session.voiceArmed });
    return session.voiceArmed;
  }

  // The payload the WS sends on connect and /api/voice/status reports: every
  // live session with its armed flag, so the UI can render toggles in one pass.
  sessionList() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, title: s.title, armed: !!s.voiceArmed }));
  }

  hello() {
    return {
      type: 'hello',
      tts: { available: tts.available(), voice: tts.defaultVoice() },
      sessions: this.sessionList(),
    };
  }

  // ---- watching --------------------------------------------------------------

  _stateFor(id) {
    let st = this._state.get(id);
    if (!st) {
      // announcedUuid persists for the life of the session: it is the entire
      // dedupe mechanism, and must outlive browser reconnects.
      st = { mtimeMs: -1, announcedUuid: null, waiting: false, busy: false, inFlight: false, summary: '', summaryUuid: null };
      this._state.set(id, st);
    }
    return st;
  }

  _tick() {
    // Drop state for sessions that have gone away, so a long-lived sessiond
    // doesn't accumulate one entry per terminal ever opened.
    for (const id of this._state.keys()) {
      if (!this.sessions.has(id)) this._state.delete(id);
    }
    for (const session of this.sessions.values()) {
      if (!session.voiceArmed) continue;
      try {
        this._pollSession(session);
      } catch {
        // a session that died mid-poll, an unreadable transcript — try again in
        // a second; the voice layer is never allowed to take sessiond down
      }
    }
  }

  _pollSession(session) {
    const st = this._stateFor(session.id);
    if (!session.alive || session.kind !== 'claude') return;

    // "Started producing output again" is a PTY fact, not a transcript one. The
    // browser uses `busy` to drop an announcement it hasn't spoken yet, so it
    // has to fire the instant the user replies — seconds before the transcript
    // records a new turn. Same window as info()'s `busy` dot.
    if (Date.now() - session.lastActivity < QUIET_MS) {
      this._markBusy(session, st);
      return; // and don't read a transcript that's mid-write
    }
    if (st.inFlight) return; // one summarize per session at a time

    const file = session.transcriptFile();
    if (!file) return;                       // claude hasn't written a transcript yet
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return; }
    // Unchanged file means nothing was said since the last look — this is what
    // keeps an idle armed session down to one stat() per second. The initial -1
    // guarantees the first poll after arming always reads.
    if (mtimeMs === st.mtimeMs) return;
    st.mtimeMs = mtimeMs;

    const turn = readLastTurn(file);
    if (!turn) return;

    // Mid-tool-call, or a thinking-only fragment with nothing to read out. Also
    // covers a session working silently (a long tool with no terminal output),
    // which the PTY check above can't see.
    if (!isWaitingForInput(turn) || !turn.text) {
      this._markBusy(session, st);
      return;
    }

    if (turn.uuid && turn.uuid === st.announcedUuid) return; // already spoken
    st.inFlight = true;
    this._announce(session, st, turn).catch(() => {}).then(() => { st.inFlight = false; });
  }

  // Tell the browser an announced session is working again — once per
  // transition, never for a session we hadn't announced, or every poll of a
  // busy terminal would emit.
  _markBusy(session, st) {
    if (!st.waiting) return;
    st.waiting = false;
    this.broadcast({ type: 'busy', sessionId: session.id });
    this.emit('busy', { sessionId: session.id });
  }

  async _announce(session, st, turn) {
    const summary = await summarize(turn.text);
    st.summary = summary;
    st.summaryUuid = turn.uuid;
    // Claim the uuid regardless of what happens next: if we bail below, the
    // moment has passed and re-announcing it later would be worse than silence.
    st.announcedUuid = turn.uuid;

    // Summarizing takes seconds. If the user replied in the meantime, or the
    // session is gone or disarmed, the announcement is stale — drop it.
    if (!session.alive || !session.voiceArmed || !this.sessions.has(session.id)) return;
    const now = readLastTurn(session.transcriptFile());
    if (!now || now.uuid !== turn.uuid) return;

    st.waiting = true;
    const msg = {
      type: 'waiting',
      sessionId: session.id,
      title: session.title,
      turnUuid: turn.uuid,
      summary,
    };
    this.broadcast(msg);
    this.emit('waiting', msg);
  }

  // ---- on-demand summary ("read that again") ----------------------------------

  // Returns { summary, turnUuid, waiting } for the session's current turn,
  // reusing the summary already computed for that turn when there is one. Does
  // NOT mark the turn announced — asking to hear it again shouldn't change
  // whether the watcher would have announced it.
  async summaryFor(session) {
    const file = session.transcriptFile();
    const turn = file ? readLastTurn(file) : null;
    if (!turn) return { summary: '', turnUuid: null, waiting: false };
    const waiting = isWaitingForInput(turn) && !!turn.text;
    const st = this._stateFor(session.id);
    if (st.summaryUuid && st.summaryUuid === turn.uuid) {
      return { summary: st.summary, turnUuid: turn.uuid, waiting };
    }
    const summary = await summarize(turn.text);
    st.summary = summary;
    st.summaryUuid = turn.uuid;
    return { summary, turnUuid: turn.uuid, waiting };
  }
}

module.exports = { VoiceHub, POLL_MS, QUIET_MS };
