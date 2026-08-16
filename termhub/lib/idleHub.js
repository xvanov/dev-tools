'use strict';

// The idle tracker — the layer that measures the one number this whole tool is
// pointed at: **how long an agent sat waiting for you.**
//
// It lives in `sessiond` for the same reason the voice hub does, only more so:
// only this process sees the PTYs, and it sees ALL of them — armed or not,
// attached or not, browser open or not. A tracker in the front would stop
// counting the moment you closed the tab, which is precisely when the counting
// matters.
//
// One tick a second over the agent sessions:
//
//   classify (lib/idleState.js)  ->  episode bookkeeping (lib/idleStore.js)
//                                ->  escalating push to your phone (lib/notify.js)
//
// Three decisions worth knowing before changing anything here:
//
//  - **`limited` does not count.** A session that hit a usage or spend limit is
//    stopped and needs you, but you cannot un-idle it, so it gets its own state
//    and its own one-shot notification instead of inflating the number you are
//    trying to drive down.
//  - **Looking at a session doesn't stop the clock, only the buzzing.** Idle is
//    idle whether or not you are staring at it — but a phone that vibrates
//    about the terminal already on your screen trains you to ignore it, so an
//    active browser tab suppresses the push (noteFocus) and nothing else.
//  - **Episodes are checkpointed every 5 minutes.** An open episode lives in
//    memory, so an unexpected sessiond death would otherwise lose the whole
//    stretch. Checkpointing bounds that loss; continuations carry `cont: true`
//    so the split can't be miscounted as a second handoff.

const { EventEmitter } = require('events');

const store = require('./idleStore');
const notify = require('./notify');
const { readLastTurn } = require('./claudeTranscript');
const { classifyClaude, classifyOpencode, isTracked, WAITING, LIMITED, WORKING } = require('./idleState');
const { readState } = require('./state');
const { secureUrlForPort } = require('./serveUrl');

const POLL_MS = 1000;

// How long a session must be waiting before the first push. Two minutes is the
// line between "reading what it wrote" and "you have walked away" — short
// enough that a forgotten terminal is caught while the context is still in your
// head, long enough that finishing a paragraph doesn't buzz your pocket.
const FIRST_NOTIFY_MS = 2 * 60 * 1000;

// Gaps between the reminders that follow, then every 30 min. Widening rather
// than fixed: the reminder you need at 2 minutes and the one you need at an
// hour are different messages, and a fixed interval turns the second one into
// noise you learn to swipe away.
const REPEAT_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];

// Past this, the push goes out at ntfy priority `high` — it earns the extra
// attention because a session idle this long is usually one you have forgotten
// exists, not one you are thinking about.
const URGENT_AFTER_MS = 15 * 60 * 1000;

// A browser tab showing this session, seen this recently, suppresses the push.
// Comfortably longer than the client's 15 s heartbeat so one dropped beat
// doesn't buzz you at the screen you are looking at.
const FOCUS_TTL_MS = 45 * 1000;

// Bound on how much of an open episode an unexpected death can lose. One
// minute, not five, and that number was measured rather than chosen: killing a
// dev sessiond mid-session with a 5-minute checkpoint silently dropped every
// waiting stretch it was holding, and the day rolled up as zero idle with zero
// handoffs — a tracker that under-reports exactly when something went wrong.
// The cost of the tighter bound is one log line per minute per waiting session.
const CHECKPOINT_MS = 60 * 1000;

// The deep link's host. Resolved from Serve's own config (never guessed — see
// lib/serveUrl.js) and cached: this is a subprocess spawn, and the tick runs
// once a second.
const URL_TTL_MS = 5 * 60 * 1000;

// What to call the session on a phone screen. An untitled agent session's title
// IS its whole command line, and termhub splices `--session-id <uuid>` into
// that — so the honest default reads "claude --session-id 8b3f… is waiting",
// forty characters of hex in a notification with room for about sixty. Falls
// back to the kind plus the directory, which is what you actually recognise it
// by. The browser solves the same problem in speakableTitle().
function label(session) {
  const title = session.title || '';
  const auto = !title || title === session.command;
  if (!auto) return title;
  const dir = String(session.cwd || '').split(/[\\/]/).filter(Boolean).pop();
  // ASCII separator on purpose: notify.js has to strip a title down to latin-1
  // for the HTTP header, and a "·" would come out as a stray space.
  return dir ? `${session.kind} in ${dir}` : (title || session.id);
}

const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

class IdleHub extends EventEmitter {
  // `sessions` is sessiond's live Map<id, Session>; the hub only ever reads it.
  constructor(sessions) {
    super();
    this.sessions = sessions;
    this._state = new Map();   // sessionId -> episode + notification bookkeeping
    this._focus = { id: null, at: 0 };
    this._timer = null;
    this._url = { value: null, at: 0, pending: null };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { try { this._tick(); } catch { /* never take sessiond down */ } }, POLL_MS);
    if (this._timer.unref) this._timer.unref();
    this._deepLink('');   // warm the Serve lookup so the first push carries a link
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._closeAll(Date.now());   // flush open episodes on a clean shutdown
  }

  // ---- browser hints ---------------------------------------------------------

  // "This tab is visible and showing this session." Suppresses the push for it,
  // not the accounting. See the note at the top.
  noteFocus(sessionId) {
    this._focus = { id: sessionId || null, at: Date.now() };
  }

  _focused(id) {
    return this._focus.id === id && (Date.now() - this._focus.at) < FOCUS_TTL_MS;
  }

  // ---- the tick --------------------------------------------------------------

  _tick() {
    const now = Date.now();

    // A session that has gone away (killed, or exited) closes its episode: it
    // is not idle, it is over.
    for (const id of [...this._state.keys()]) {
      const session = this.sessions.get(id);
      if (!session || !session.alive) this._close(id, now);
    }

    for (const session of this.sessions.values()) {
      if (!session.alive || !isTracked(session)) continue;
      let verdict;
      try {
        verdict = this._classify(session, now);
      } catch {
        continue; // an unreadable transcript, a session dying mid-read
      }
      this._advance(session, verdict, now);
    }
  }

  _classify(session, now) {
    const ptyIdleMs = now - (session.lastActivity || now);
    if (session.kind === 'opencode') {
      return classifyOpencode({ idleAt: session._opencodeIdleAt, ask: session._opencodeAsk });
    }
    // Reading the transcript tail is a 64 KB read behind an mtime check in
    // lib/claudeModel.js's scanTail; the voice hub does the same thing on the
    // same cadence. Cheap enough to do unconditionally, and unconditionally is
    // what a session parked on a question requires — it writes nothing at all.
    const file = session.transcriptFile();
    const turn = file ? readLastTurn(file) : null;
    return classifyClaude({ turn, ptyIdleMs });
  }

  _stateFor(session) {
    let st = this._state.get(session.id);
    if (!st) {
      st = {
        state: null, reason: null, since: 0,
        writtenTo: 0,           // how far the current episode has been checkpointed
        notifiedAt: 0, notifyCount: 0,
        title: label(session), cwd: session.cwd, kind: session.kind,
        // Enough to bring the conversation back weeks later. The session
        // archive (sessions.json) forgets an entry the moment it's killed or
        // restored on top of, so it cannot answer "reopen what I was doing on
        // the 3rd" — the episode log is the only thing that still remembers,
        // and a date you can't act on is a museum piece.
        command: session.command, agentSessionId: session.agentSessionId || null,
      };
      this._state.set(session.id, st);
    }
    // A rename should reach the next episode, the dashboard and the push. The
    // episode log stores the READABLE name, not the raw command line: it is
    // what the dashboard renders months later, and "claude --session-id
    // 8b3f…" identifies nothing to a human reading back a Tuesday.
    st.title = label(session);
    // The agent's own conversation id is discovered asynchronously for opencode
    // (and can move for claude), so it is refreshed rather than captured once.
    st.agentSessionId = session.agentSessionId || st.agentSessionId || null;
    return st;
  }

  _advance(session, verdict, now) {
    const st = this._stateFor(session);

    if (st.state !== verdict.state) {
      this._flush(session.id, st, now);
      st.state = verdict.state;
      st.reason = verdict.reason;
      st.since = now;
      st.writtenTo = now;
      st.notifiedAt = 0;
      st.notifyCount = 0;
      this.emit('state', { sessionId: session.id, state: st.state, reason: st.reason, at: now });
      // Hitting a limit is a one-shot event, not a clock: tell the user once,
      // right away, because the fix (top up, or switch model) happens somewhere
      // that isn't this terminal.
      if (st.state === LIMITED) this._pushLimit(session, st);
      return;
    }

    // Same state, still running: checkpoint so a crash can't lose the stretch.
    if (now - st.writtenTo >= CHECKPOINT_MS) {
      this._write(session.id, st, st.writtenTo, now, { cont: st.writtenTo !== st.since });
      st.writtenTo = now;
    }

    if (st.state === WAITING) this._maybePush(session, st, now);
  }

  // ---- episodes --------------------------------------------------------------

  _write(id, st, start, end, { cont = false } = {}) {
    if (!st.state || end <= start) return;
    store.append({
      id, start, end, ms: end - start,
      state: st.state, reason: st.reason,
      title: st.title, cwd: st.cwd, kind: st.kind,
      command: st.command, agentSessionId: st.agentSessionId,
      ...(cont ? { cont: true } : {}),
    });
  }

  // Close the part of the current episode that hasn't been checkpointed yet.
  _flush(id, st, now) {
    if (!st.state) return;
    this._write(id, st, st.writtenTo, now, { cont: st.writtenTo !== st.since });
    st.writtenTo = now;
  }

  _close(id, now) {
    const st = this._state.get(id);
    if (!st) return;
    this._flush(id, st, now);
    this._state.delete(id);
  }

  _closeAll(now) {
    for (const id of [...this._state.keys()]) this._close(id, now);
  }

  // ---- notifications ---------------------------------------------------------

  // The deep link a tapped notification opens: this machine's HTTPS address
  // with the session in the hash, so the phone lands on the terminal that is
  // waiting rather than on the session list. `null` when Tailscale Serve
  // publishes no address for this front — the push still goes, without a Click
  // header, because a buzz you have to act on manually beats no buzz.
  _deepLink(sessionId) {
    const now = Date.now();
    // Refreshed in the background, never awaited: this is a `tailscale`
    // subprocess and the caller is on a 1 s tick. `warm()` at startup is what
    // stops the FIRST push of a session's life — the one that matters most —
    // from being the one that goes out without a Click header.
    if (now - this._url.at > URL_TTL_MS && !this._url.pending) {
      const port = readState().publishPort || readState().activeFrontPort;
      this._url.pending = secureUrlForPort(port)
        .then((u) => { this._url.value = u || null; })
        .catch(() => { this._url.value = null; })
        .finally(() => { this._url.at = Date.now(); this._url.pending = null; });
    }
    if (!this._url.value) return null;
    return `${this._url.value.replace(/\/+$/, '')}/#session=${encodeURIComponent(sessionId)}`;
  }

  _nextDelay(count) {
    return REPEAT_MS[Math.min(count - 1, REPEAT_MS.length - 1)];
  }

  _maybePush(session, st, now) {
    if (!notify.enabled()) return;
    const idleMs = now - st.since;
    const due = st.notifyCount === 0
      ? idleMs >= FIRST_NOTIFY_MS
      : now - st.notifiedAt >= this._nextDelay(st.notifyCount);
    if (!due) return;

    // Claim the slot before the async send: a failed post must not retry every
    // tick, and a slow one must not fire twice.
    st.notifiedAt = now;
    st.notifyCount++;

    if (this._focused(session.id)) return;   // you're already looking at it

    const urgent = idleMs >= URGENT_AFTER_MS;
    notify.send({
      title: `${label(session)} is waiting (${fmt(idleMs)})`,
      message: st.reason === 'question' || st.reason === 'blocked'
        ? `It is asking you something in ${session.cwd || 'its terminal'}.`
        : `Idle for ${fmt(idleMs)} in ${session.cwd || 'its terminal'}.`,
      priority: urgent ? 4 : 3,
      tags: urgent ? 'hourglass_flowing_sand,warning' : 'hourglass_flowing_sand',
      click: this._deepLink(session.id),
    }).catch(() => { /* best-effort by contract */ });
    this.emit('notified', { sessionId: session.id, idleMs, count: st.notifyCount });
  }

  _pushLimit(session, st) {
    if (!notify.enabled()) return;
    st.notifiedAt = Date.now();
    st.notifyCount++;
    notify.send({
      title: `${label(session)} hit a usage limit`,
      message: 'This session is out of tokens — the idle clock is paused for it.',
      priority: 4,
      tags: 'battery,warning',
      click: this._deepLink(session.id),
    }).catch(() => { /* best-effort by contract */ });
    this.emit('limited', { sessionId: session.id });
  }

  // ---- reporting -------------------------------------------------------------

  // Per-session fields folded into GET /api/sessions, so the sidebar gets the
  // idle badge out of the poll it already makes rather than a second one.
  decorate(id) {
    const st = this._state.get(id);
    if (!st || !st.state) return { idleState: null, idleSince: null, idleMs: 0 };
    return {
      idleState: st.state,
      idleReason: st.reason,
      idleSince: st.since,
      idleMs: st.state === WORKING ? 0 : Date.now() - st.since,
    };
  }

  // Open (in-memory) episodes as clipped episode records, so today's totals
  // include the stretch currently in progress. Without this the header would
  // freeze whenever nothing changed state — which, on a genuinely idle day, is
  // the entire day.
  openEpisodes(at) {
    const now = at || Date.now();
    const out = [];
    for (const [id, st] of this._state) {
      if (!st.state || now <= st.writtenTo) continue;
      out.push({
        id, start: st.writtenTo, end: now, ms: now - st.writtenTo,
        state: st.state, reason: st.reason, title: st.title, cwd: st.cwd, kind: st.kind,
        cont: st.writtenTo !== st.since,
      });
    }
    return out;
  }

  // GET /api/idle — live state plus today's totals.
  snapshot() {
    const now = Date.now();
    const live = [];
    for (const session of this.sessions.values()) {
      if (!isTracked(session) || !session.alive) continue;
      const st = this._state.get(session.id);
      live.push({
        id: session.id,
        title: label(session),
        kind: session.kind,
        state: st ? st.state : null,
        reason: st ? st.reason : null,
        since: st ? st.since : null,
        ms: st && st.state !== WORKING ? now - st.since : 0,
      });
    }
    return {
      now,
      today: store.rollup(store.dayKey(now), this.openEpisodes(now)),
      sessions: live,
      running: live.filter((s) => s.state === WORKING).length,
      waiting: live.filter((s) => s.state === WAITING).length,
      thresholdMs: FIRST_NOTIFY_MS,
      notify: notify.status(),
    };
  }
}

module.exports = { IdleHub, FIRST_NOTIFY_MS, REPEAT_MS, URGENT_AFTER_MS, fmt };
