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
const { readLastTurn, isWaitingForInput, hasSpeakableContent } = require('./claudeTranscript');

const POLL_MS = 1000;

// A PTY that produced output within this window is still mid-turn: Claude
// streams continuously while it works, and the transcript's last line during
// streaming can be a partial assistant entry that looks finished. Matches the
// `busy` window in lib/session.js info() on purpose.
const QUIET_MS = 1500;

// How long a claude PTY must be silent before we conclude it is parked on an
// interactive prompt rather than working (see _maybeAnnounceBlocked). Well
// clear of QUIET_MS: the cost of being wrong is a spurious announcement, and
// the spinner means a working session is never silent for anywhere near this
// long. Deliberately not tunable — it's a heuristic, not a preference.
const BLOCKED_MS = 12000;

// What we can honestly say about a session parked on an interactive prompt: the
// question itself is only on screen, never in the transcript.
const BLOCKED_SUMMARY = 'This session is asking you something in the terminal.';

// Ceiling on "read the last message in full". Comfortably above a normal
// assistant turn and comfortably below /api/tts's 4000-char request cap, so a
// long turn comes back readable rather than 400ing on the way to synthesis.
const FULL_TEXT_MAX = 3200;

// The spoken wake word, if this host overrides it. Returning null (rather than
// the default) is deliberate: web/voiceCommands.js owns the default and its
// variant list, and two copies of a default are one too many. The server only
// ever speaks up when it has been told something different.
function wakeWord() {
  const w = String(process.env.TERMHUB_WAKE_WORD || '').trim();
  return w || null;
}

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

  // Announcements come from a Claude Code transcript, so only a `claude`
  // session can ever produce one. Arming anything else used to succeed and then
  // silently do nothing — a toggle the UI would light up that could never fire.
  static canArm(session) {
    return !!session && session.kind === 'claude';
  }

  // Returns the new armed state, or null when there's no such session. Callers
  // must check canArm() first; this asserts nothing.
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
    // tts.status() carries the engine and its voice list as well as
    // availability, so the browser can say what is speaking without a second
    // round-trip to /api/voice/status.
    return {
      type: 'hello',
      tts: tts.status(),
      wakeWord: wakeWord(),
      sessions: this.sessionList(),
    };
  }

  // ---- watching --------------------------------------------------------------

  _stateFor(id) {
    let st = this._state.get(id);
    if (!st) {
      // announcedUuid persists for the life of the session: it is the entire
      // dedupe mechanism, and must outlive browser reconnects.
      st = {
        mtimeMs: -1, announcedUuid: null, waiting: false, inFlight: false,
        summary: '', summaryUuid: null,
        pendingUuid: null, pending: null, // in-flight summarize, shared by watcher and /voice/summary
        lastTurn: null, blockedUuid: null, // see _maybeAnnounceBlocked
      };
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
    const idleMs = Date.now() - session.lastActivity;
    if (idleMs < QUIET_MS) {
      this._markBusy(session, st);
      return; // and don't read a transcript that's mid-write
    }

    this._readTranscript(session, st);
    // Runs on every tick, not just when the file changes — a session parked on
    // an interactive prompt writes nothing at all (see _maybeAnnounceBlocked).
    this._maybeAnnounceBlocked(session, st, idleMs);
  }

  _readTranscript(session, st) {
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
    st.lastTurn = turn; // cached so the blocked check needn't re-read

    // Mid-tool-call, or a session working silently (a long tool producing no
    // terminal output), which the PTY check above can't see.
    if (!isWaitingForInput(turn)) {
      this._markBusy(session, st);
      return;
    }

    // Waiting, but nothing to say yet: Claude writes a thinking-only entry with
    // `stop_reason: null` before the text lands, and announcing that would say
    // nothing AND burn the turn's uuid. Deliberately not marked busy — the
    // session isn't working again, it's mid-sentence. The next append to the
    // transcript (moments away) brings the text and we announce then.
    if (!hasSpeakableContent(turn)) return;

    // Fail closed on a uuid-less entry. Dedupe is the whole design here, and an
    // entry we can't key would re-announce on every mtime bump. No real entry
    // lacks one (0 of 73,701 on this machine), so silence is the safe answer.
    if (!turn.uuid || turn.uuid === st.announcedUuid) return;

    st.inFlight = true;
    this._announce(session, st, turn).catch(() => {}).then(() => { st.inFlight = false; });
  }

  // The one case the transcript genuinely cannot tell us about.
  //
  // When Claude stops on an AskUserQuestion or ExitPlanMode — or a permission
  // prompt — it writes NOTHING to the transcript until the user answers.
  // Measured on this machine: all 98 asking-tool entries are flushed together
  // with their answer, a median 194 s after the question was created, and a
  // live session sitting on the picker showed zero new transcript lines. So the
  // moment the user most needs to be told is the moment there is nothing to
  // read. Announcing from the transcript would always be too late.
  //
  // The PTY does know. Claude's TUI animates a spinner continuously while it
  // works, so a terminal that has been silent this long is not working; if the
  // conversation's last recorded turn also isn't a finished assistant turn,
  // Claude is parked on something interactive. We can't say what it's asking —
  // that text exists only on screen — so we say that it's asking.
  _maybeAnnounceBlocked(session, st, idleMs) {
    if (idleMs < BLOCKED_MS) return;
    const turn = st.lastTurn;
    if (!turn || !turn.uuid) return;          // no conversation yet, or unkeyable
    if (isWaitingForInput(turn)) return;      // a finished turn: the normal path owns it
    if (st.blockedUuid === turn.uuid) return; // said once already

    st.blockedUuid = turn.uuid;
    st.waiting = true; // so replying to it produces the usual `busy`
    const msg = {
      type: 'waiting',
      sessionId: session.id,
      title: session.title,
      // Distinct from a real turn announcement of the same entry, so a browser
      // deduping on turnUuid can't confuse the two.
      turnUuid: `${turn.uuid}:blocked`,
      summary: BLOCKED_SUMMARY,
    };
    this.broadcast(msg);
    this.emit('waiting', msg);
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

  // The one place a turn is turned into spoken text, shared by the watcher and
  // by GET /voice/summary. Coalesces: a result already computed for this uuid is
  // returned as-is, and concurrent callers for the same uuid await ONE
  // summarize rather than each forking a `claude -p`. Without this, a frontend
  // retry loop on /voice/summary spawns a child per request — measured at 6
  // concurrent haiku processes from 6 GETs — inside the process holding the
  // user's terminals.
  _summaryForTurn(session, turn) {
    const st = this._stateFor(session.id);
    if (st.summaryUuid && st.summaryUuid === turn.uuid) return Promise.resolve(st.summary);
    if (st.pending && st.pendingUuid === turn.uuid) return st.pending;

    // A question from AskUserQuestion/ExitPlanMode is the point of the
    // announcement, so it's appended verbatim rather than run through the
    // summarizer, which would paraphrase away the actual options.
    const pending = summarize(turn.text)
      .then((summary) => {
        const spoken = [summary, turn.prompt].filter(Boolean).join(' ').trim();
        st.summary = spoken;
        st.summaryUuid = turn.uuid;
        return spoken;
      })
      .finally(() => {
        if (st.pendingUuid === turn.uuid) { st.pending = null; st.pendingUuid = null; }
      });
    st.pending = pending;
    st.pendingUuid = turn.uuid;
    return pending;
  }

  async _announce(session, st, turn) {
    const summary = await this._summaryForTurn(session, turn);
    // Claim the uuid regardless of what happens next: if we bail below, the
    // moment has passed and re-announcing it later would be worse than silence.
    st.announcedUuid = turn.uuid;

    // Belt to summarize()'s braces. A `waiting` with an empty summary gives the
    // browser nothing to play and would 400 if it posted it to /api/tts, so it
    // is strictly worse than staying quiet.
    if (!summary) return;

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
  // reusing (or joining) the summary already being computed for it. Does NOT
  // mark the turn announced — asking to hear it again shouldn't change whether
  // the watcher would have announced it.
  //
  // Restricted to `kind === 'claude'` so this agrees with what can be armed and
  // with what the watcher will actually announce. The cwd fallback in
  // transcriptFile() would happily hand back the transcript of a claude the
  // user started by hand inside a shell session, and answering for a session
  // that can never produce a `waiting` event is just a lie.
  async summaryFor(session) {
    const empty = { summary: '', turnUuid: null, waiting: false };
    if (session.kind !== 'claude') return empty;
    const file = session.transcriptFile();
    const turn = file ? readLastTurn(file) : null;
    if (!turn) return empty;

    // "Read that again" means read back what CLAUDE said. A `user` turn last
    // means either Claude is mid-work or it's parked on an interactive prompt —
    // reciting the user's own message back at them is never the answer.
    if (turn.role !== 'assistant') {
      const st = this._stateFor(session.id);
      if (st.blockedUuid && st.blockedUuid === turn.uuid) {
        return { summary: BLOCKED_SUMMARY, turnUuid: `${turn.uuid}:blocked`, waiting: true };
      }
      return empty;
    }
    if (!hasSpeakableContent(turn)) return empty;
    const waiting = isWaitingForInput(turn);
    const summary = await this._summaryForTurn(session, turn);
    return { summary, turnUuid: turn.uuid, waiting };
  }

  // "Read the last message in full" — the assistant's actual words, not the
  // two-sentence summary the announcement used. Same turn selection as
  // summaryFor() so the two can never disagree about which message "the last
  // one" is; it just skips the summariser entirely, which also makes it the
  // fast path (no `claude -p`, no 3.8 s).
  //
  // Capped, because a turn can run to tens of kilobytes and the caller is going
  // to read it out loud. Truncation is announced in the text itself rather than
  // silently cutting mid-sentence — being told there's more is the useful part.
  fullTurnFor(session, maxChars) {
    const empty = { text: '', turnUuid: null, truncated: false };
    if (session.kind !== 'claude') return empty;
    const file = session.transcriptFile();
    const turn = file ? readLastTurn(file) : null;
    if (!turn || turn.role !== 'assistant' || !hasSpeakableContent(turn)) return empty;
    const whole = [turn.text, turn.prompt].filter(Boolean).join(' ').trim();
    const cap = Math.max(200, Number(maxChars) || FULL_TEXT_MAX);
    if (whole.length <= cap) return { text: whole, turnUuid: turn.uuid, truncated: false };
    // Back up to a sentence end so the clip doesn't stop mid-word.
    const cut = whole.slice(0, cap);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    const body = stop > cap * 0.5 ? cut.slice(0, stop + 1) : cut;
    return { text: `${body} That's as far as I can read; the rest is on screen.`, turnUuid: turn.uuid, truncated: true };
  }
}

module.exports = { VoiceHub, POLL_MS, QUIET_MS, FULL_TEXT_MAX, wakeWord };
