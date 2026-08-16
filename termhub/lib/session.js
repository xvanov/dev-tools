'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { defaultShell } = require('./shell');
const { resolveTranscript, readLastModel, formatModelName } = require('./claudeModel');
const opencodeModel = require('./opencodeModel');
const opencodeApi = require('./opencodeApi');
const { injectAfterClaudeExe, injectAfterOpencodeExe } = require('./restore');

// How often to actually shell out to `opencode export` to refresh a session's
// model (lib/opencodeModel.js's getModel is a ~1.4s subprocess spawn — far too
// slow to call on every 2s sidebar poll). currentModel() serves the cached
// value between refreshes.
const OPENCODE_MODEL_REFRESH_MS = 10000;

// Resolve a requested working directory: expand a leading ~, and fall back to
// the home directory (with an explanatory notice) when it's missing or not a
// directory — so a typo opens a usable shell instead of failing the session.
function resolveCwd(input) {
  const home = os.homedir();
  let dir = input && String(input).trim();
  if (!dir) return { cwd: home, notice: null };
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(home, dir.slice(2));
  try {
    if (fs.statSync(dir).isDirectory()) return { cwd: dir, notice: null };
    return { cwd: home, notice: `'${dir}' is not a directory — starting in ${home}` };
  } catch {
    return { cwd: home, notice: `directory '${dir}' not found — starting in ${home}` };
  }
}

// Default scrollback kept in memory per session, for replay on reconnect.
const DEFAULT_SCROLLBACK_BYTES = Number(process.env.TERMHUB_SCROLLBACK_BYTES) || 2 * 1024 * 1024;

// Environment variables that identify the agent session termhub itself was
// launched from. Stripped from every PTY we spawn — see _spawn().
const PARENT_AGENT_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

// The command's first token — the program actually being run — unquoted so a
// path can be matched against without the wrapping ' or ".
function firstToken(command) {
  const s = String(command).trim();
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }
  const m = /^\S+/.exec(s);
  return m ? m[0] : '';
}

// Classify a session by its initial command so the archive knows how to restore
// it: a `claude` invocation resumes via `--resume`, an `opencode` one via
// `--session`/`--continue`; anything else is a plain shell we rebuild by
// replaying recorded history. Matched against the first token only — a `claude`
// mentioned later in a compound command (e.g. `git pull && { claude update; }
// && systemctl restart …`, termhub's own updater) is not a claude session, it's
// a shell script that happens to say the word; matching it anywhere in the
// string spliced --resume/--session-id into an unrelated updater command (see
// test/restore.test.js history). Matches the bare command, `<exe>.exe`/`.cmd`,
// or a path ending in it — but not `claude-foo` or `myclaude`.
function classifyCommand(command) {
  if (!command) return 'shell';
  const tok = firstToken(command);
  if (/(^|[\\/])claude(\.exe|\.cmd)?$/i.test(tok)) return 'claude';
  if (/(^|[\\/])opencode(\.exe|\.cmd)?$/i.test(tok)) return 'opencode';
  return 'shell';
}

// True if the command already pins down its own Claude session identity —
// termhub shouldn't guess a --session-id on top of a --resume/--continue/-c/-r,
// since the resulting conversation id isn't ours to predict.
function hasOwnSessionIdentity(command) {
  return /(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/.test(command);
}

// Insert `--session-id <uuid>` right after the claude executable token — see
// injectAfterClaudeExe in lib/restore.js, which restore shares for --resume.
function injectSessionId(command, uuid) {
  return injectAfterClaudeExe(command, `--session-id ${uuid}`);
}

// Strip leftover control bytes from an assembled input line.
function stripControl(s) {
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

// Given `data` with an ESC at index i, return the index of the last byte of the
// escape sequence (so the caller's i++ resumes just after it). Handles CSI
// (ESC [ … final) and SS3 (ESC O x); treats a lone trailing ESC gracefully.
function skipEscape(data, i) {
  if (i + 1 >= data.length) return i;
  const next = data[i + 1];
  if (next === '[' || next === 'O') {
    let j = i + 2;
    while (j < data.length) {
      const c = data.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j; // final byte of a CSI/SS3 sequence
      j++;
    }
    return data.length - 1;
  }
  return i + 1; // ESC + a single char
}

let counter = 0;
function genId() {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

class Session {
  constructor({ cwd, command, title, cols, rows, maxBytes, onExit, onInputLine, agentSessionId } = {}) {
    this.id = genId();
    this.shell = defaultShell();
    const resolved = resolveCwd(cwd);
    this.cwd = resolved.cwd;
    this._cwdNotice = resolved.notice;
    this.cwdFallback = !!resolved.notice;
    this.command = command && String(command).trim() ? String(command).trim() : null;
    this.kind = classifyCommand(this.command);

    // Track the launched agent's own conversation/session id so we can later
    // read which model it's using (see currentModel()). `agentSessionId` passed
    // in means a restore already knows it; otherwise:
    //  - claude: generate a UUID and splice `--session-id <uuid>` into the
    //    command so Claude writes its transcript to a file we know up front.
    //  - opencode: there's no such flag (its `-s/--session` only continues an
    //    EXISTING session), so instead kick off a best-effort background
    //    discovery that asks opencode's own CLI which session it just created
    //    in this directory (see lib/opencodeModel.js).
    this.agentSessionId = agentSessionId || null;
    this._discoveryAborted = false;
    this._opencodeModelCache = { checkedAt: 0, model: null, modelLabel: null };
    if (this.kind === 'claude' && !this.agentSessionId && !hasOwnSessionIdentity(this.command)) {
      const uuid = crypto.randomUUID();
      this.command = injectSessionId(this.command, uuid);
      this.agentSessionId = uuid;
    } else if (this.kind === 'opencode' && !this.agentSessionId) {
      // A command that names its own session (`--session <id>`, which is what
      // restore builds and what a user resuming by hand types) already answers
      // the question the discovery loop below exists to guess at. Reading it is
      // free and exact; not reading it left a restored opencode session with no
      // model badge until the user happened to type something.
      const own = /(^|\s)(?:--session|-s)(?:=|\s+)(\S+)/.exec(this.command || '');
      if (own) {
        this.agentSessionId = own[2];
      } else {
        const spawnedAtMs = Date.now(); // this.created isn't assigned yet at this point in the constructor
        opencodeModel.discoverSessionId(this.cwd, spawnedAtMs, () => this._discoveryAborted)
          .then((id) => { if (id && !this._discoveryAborted) this.agentSessionId = id; })
          .catch(() => {});
      }
    }

    // opencode's TUI serves its own HTTP API when given `--port`, and that one
    // flag is what buys parity with Claude Code: which conversation this is,
    // which model, when a turn ends, and — uniquely — what it is asking you.
    // See lib/opencodeApi.js for the comparison table.
    //
    // The subprocess path above (`opencode export` behind a 10s cache, plus a
    // polling loop to discover the session id) stays as the fallback: sessions
    // launched by an older build have no port, and a user who supplied their own
    // `--port` is honoured rather than overridden.
    this.opencodePort = null;
    this._opencodeApi = null;
    this._opencodeAsk = null;         // the question/permission it is blocked on
    this._opencodeIdleAt = 0;         // when its last turn finished
    this._opencodePortPromise = null;
    if (this.kind === 'opencode') {
      const own = /(^|\s)--port(?:=|\s+)(\d{2,5})\b/.exec(this.command || '');
      if (own) {
        this.opencodePort = Number(own[2]);
        this._startOpencodeApi();
      } else {
        this._opencodePortPromise = opencodeApi.freePort().catch(() => null);
      }
    }
    this._modelCache = { file: null, mtimeMs: -1, model: null, modelLabel: null };

    this.cols = cols || 80;
    this.rows = rows || 24;
    this.title = title || this.command || baseName(this.shell);
    this.created = Date.now();
    this.lastActivity = Date.now();
    this.lastInputAt = 0;   // when the human last typed; 0 = never (see write())
    this.alive = false;
    this.exitCode = null;

    // Spoken announcements are opt-in per session (the sidebar's 🔊 toggle).
    // The flag lives here rather than in lib/voiceHub.js so info() can report it
    // without a lookup, and so it dies with the session — no armed-id set to
    // keep in sync with the session map.
    this.voiceArmed = false;

    // Lifecycle hooks (sessiond wires these to the on-disk archive). Public so
    // they can also be assigned after construction.
    this.onExit = onExit || null;
    this.onInputLine = onInputLine || null;
    this._inputLine = ''; // partial command line being assembled from keystrokes

    this.maxBytes = maxBytes || DEFAULT_SCROLLBACK_BYTES;
    this._chunks = [];
    this._bytes = 0;
    this._clients = new Set(); // each is a function(msgObject)

    this._spawn();
  }

  _spawn() {
    // TERMHUB_SESSION_ID marks the terminal as termhub-owned, so a script can
    // tell it is running inside a PTY that a given action would destroy —
    // windows/restart-sessiond.ps1 refuses to kill the supervisor from one of
    // its own terminals on the strength of it. Always assigned, never inherited:
    // a nested termhub must not hand its parent's session id to its children.
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERMHUB_SESSION_ID: this.id,
    };
    // A termhub terminal is a *fresh* terminal, never a continuation of whatever
    // launched termhub. If termhub was started from inside a Claude Code session
    // (easy to do — run `node server.js` from a termhub terminal), these inherited
    // vars tell every nested `claude` it is a child of that session: it prints
    // "⚠ Transcript saving is off" and writes no transcript at all, which silently
    // breaks the model badge and spoken announcements, both of which read it.
    // Only the parent-identity vars go; user preferences (CLAUDE_CONFIG_DIR,
    // CLAUDE_CODE_ENABLE_TELEMETRY, …) are deliberately left alone.
    for (const key of PARENT_AGENT_ENV) delete env[key];
    this.pty = pty.spawn(this.shell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    this.alive = true;

    // Surface a bad working directory in the terminal itself (buffered so it also
    // shows up in replay on reconnect) rather than failing session creation.
    if (this._cwdNotice) {
      const notice = `\x1b[33m[termhub] ${this._cwdNotice}\x1b[0m\r\n`;
      this._buffer(notice);
      this._broadcast({ type: 'output', data: notice });
    }

    this.pty.onData((data) => {
      // Run the initial command once the shell has actually produced its prompt,
      // rather than after a fixed delay — a guessed timeout races the shell's
      // startup (rc files, etc.) and the keystrokes get dropped.
      this._maybeRunCommand();
      this.lastActivity = Date.now();
      this._buffer(data);
      this._broadcast({ type: 'output', data });
    });

    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      // The opencode server dies with its TUI, so the SSE reconnect loop would
      // otherwise retry a dead port every few seconds for the life of sessiond.
      this._stopOpencodeApi();
      this._broadcast({ type: 'exit', code: exitCode });
      if (this.onExit) { try { this.onExit(exitCode); } catch { /* hook must not break exit */ } }
    });

    // If an initial command was requested (e.g. `claude …`), run it *inside* the
    // shell (not as the PTY process) so the user still has a shell after it exits.
    if (this.command) {
      this._pendingCommand = this.command;
      // Fallback in case the shell emits no startup output before going quiet.
      this._cmdFallback = setTimeout(() => this._maybeRunCommand(), 1500);
    }
  }

  _maybeRunCommand() {
    if (!this._pendingCommand || !this.alive) return;
    const cmd = this._pendingCommand;
    this._pendingCommand = null;
    if (this._cmdFallback) { clearTimeout(this._cmdFallback); this._cmdFallback = null; }
    // An opencode session gets `--port` spliced in so termhub can talk to that
    // exact TUI over its own API (see lib/opencodeApi.js). The port is picked by
    // binding one and letting go, which is async — but the command isn't typed
    // until the shell has drawn a prompt, so the allocation (~1ms) has always
    // finished long before. Await it anyway rather than racing it, and fall
    // through to the un-ported command if it failed: an opencode with no API is
    // the old behaviour, which still works.
    const run = (final) => {
      // A short settle lets the prompt finish drawing before we type into it.
      setTimeout(() => { if (this.alive) this.pty.write(final + '\r'); }, 120);
    };
    if (!this._opencodePortPromise) return run(cmd);
    this._opencodePortPromise
      .then((port) => {
        if (!port) return run(cmd);
        this.opencodePort = port;
        const final = injectAfterOpencodeExe(cmd, `--port ${port} --hostname 127.0.0.1`);
        this.command = final;              // so the archive restores it the same way
        run(final);
        this._startOpencodeApi();
      })
      .catch(() => run(cmd));
  }

  _buffer(data) {
    const bytes = Buffer.byteLength(data, 'utf8');
    this._chunks.push({ data, bytes });
    this._bytes += bytes;
    while (this._bytes > this.maxBytes && this._chunks.length > 1) {
      const dropped = this._chunks.shift();
      this._bytes -= dropped.bytes;
    }
  }

  _broadcast(msg) {
    for (const send of this._clients) {
      try {
        send(msg);
      } catch {
        // a dead client; it will be removed on its own close handler
      }
    }
  }

  replay() {
    return this._chunks.map((c) => c.data).join('');
  }

  attach(send) {
    this._clients.add(send);
    // Send accumulated scrollback first, then the client receives live output.
    // Include the PTY's current dimensions: the buffered bytes were produced at
    // this width, so the client must render them at the same width or wrapping
    // and absolute cursor positioning will be mangled (esp. full-screen apps).
    send({ type: 'replay', data: this.replay(), cols: this.cols, rows: this.rows });
    if (!this.alive) send({ type: 'exit', code: this.exitCode });
    return () => this._clients.delete(send);
  }

  write(data) {
    if (!this.alive) return;
    // When the HUMAN last typed, as distinct from lastActivity (when the PTY
    // last produced output). The idle layer needs both: output tells it whether
    // the agent is working, but only input can tell a session you closed
    // yourself from one that died on you — typing `/exit` makes the terminal
    // chatter exactly like a crash does. See lib/idleState.js shouldAnnounceExit.
    this.lastInputAt = Date.now();
    // Record typed command lines for shell sessions so a post-reboot restore can
    // show what was run. Skipped for `claude` (and other TUI) sessions — those
    // restore via --resume, and their raw keystrokes would just be noise.
    if (this.onInputLine && this.kind === 'shell') this._recordInput(data);
    this.pty.write(data);
  }

  // Reassemble command lines from the raw keystroke stream: printable bytes
  // accumulate, Backspace/Del erase, Ctrl-C abandons the line, and escape
  // sequences (arrows etc.) are skipped. Flushes a line on Enter. This is
  // best-effort: lines recalled with the Up-arrow come back as terminal *output*
  // (not input), so a re-run history entry won't be re-captured — good enough to
  // jog the user's memory when rebuilding state by hand.
  _recordInput(data) {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = data.charCodeAt(i);
      if (ch === '\r' || ch === '\n') {
        const line = stripControl(this._inputLine).trim();
        this._inputLine = '';
        if (line) { try { this.onInputLine(line); } catch { /* hook is best-effort */ } }
      } else if (code === 0x7f || code === 0x08) { // Del / Backspace
        this._inputLine = this._inputLine.slice(0, -1);
      } else if (ch === '\x1b') {
        i = skipEscape(data, i);
      } else if (code === 0x03) { // Ctrl-C abandons the current line
        this._inputLine = '';
      } else if (code >= 0x20) {
        this._inputLine += ch;
      }
    }
  }

  // Print an informational line into the terminal (buffered so it also appears in
  // replay) without sending it to the shell as input.
  notice(text) {
    const msg = text.endsWith('\r\n') ? text : text + '\r\n';
    this._buffer(msg);
    this._broadcast({ type: 'output', data: msg });
  }

  // The snapshot persisted to the archive at creation time (history accumulates
  // there afterwards, keyed by id).
  archiveEntry() {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      command: this.command,
      shell: this.shell,
      kind: this.kind,
      agentSessionId: this.agentSessionId,
      created: this.created,
      endedAt: null,
      history: [],
    };
  }

  // Which model this session is currently using — dispatches per agent kind,
  // since each exposes that very differently (see currentModel()'s two
  // implementations below).
  currentModel() {
    if (this.kind === 'opencode') return this._opencodeModel();
    // claude sessions, and shell sessions that may be running `claude` by hand
    // (the transcript fallback below only fires when one actually is).
    return this._claudeModel();
  }

  // The Claude Code conversation transcript backing this session, or null. The
  // model badge reads it for the model; lib/voiceHub.js tails the same file for
  // turn boundaries — they must agree on which conversation this session is,
  // hence one shared resolver (see lib/claudeModel.js resolveTranscript).
  transcriptFile() {
    return resolveTranscript(this.cwd, this.agentSessionId, this.created);
  }

  // Read straight from Claude's own transcript file — the CLI doesn't expose
  // this any other way. Cached on the transcript's mtime so an idle session
  // (polled every couple seconds by the sidebar) doesn't re-read/re-parse the
  // file on every call.
  _claudeModel() {
    const file = this.transcriptFile();
    if (!file) return { model: null, modelLabel: null };

    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return { model: null, modelLabel: null };
    }
    if (file !== this._modelCache.file || mtimeMs !== this._modelCache.mtimeMs) {
      const raw = readLastModel(file);
      this._modelCache = { file, mtimeMs, model: raw, modelLabel: formatModelName(raw) };
    }
    return { model: this._modelCache.model, modelLabel: this._modelCache.modelLabel };
  }

  // Attach to this session's own opencode TUI over HTTP. Everything here is
  // best-effort and silent on failure: an opencode that never opened its port
  // (an older build, a port race, a TUI that died) must degrade to the
  // subprocess path, not break the session.
  _startOpencodeApi() {
    if (this._opencodeApi || !this.opencodePort) return;
    const port = this.opencodePort;
    const api = { port, events: null, ready: false, closed: false };
    this._opencodeApi = api;

    // Adopt a session id we were *told* (every session-scoped event carries one)
    // rather than one we inferred. This is the part the old discovery loop could
    // never do: it guessed by directory and timestamp and had no way to know it
    // had guessed wrong.
    const adopt = (id) => {
      if (!id || id === this.agentSessionId) return false;
      this.agentSessionId = id;
      this._discoveryAborted = true;     // the guess is superseded; stop guessing
      if (this.onIdentity) { try { this.onIdentity(); } catch {} }
      return true;
    };

    const refreshSession = async (knownId) => {
      if (api.closed) return;
      let s = null;
      if (knownId) s = await opencodeApi.session(port, knownId);
      // Seed only while we still have no id at all: once an event has named the
      // session, guessing from a directory listing can only make it worse.
      if (!s && !this.agentSessionId) {
        s = await opencodeApi.activeSession(port, { cwd: this.cwd, since: this.created });
      } else if (!s && this.agentSessionId) {
        s = await opencodeApi.session(port, this.agentSessionId);
      }
      if (!s || !s.id) return;           // no conversation yet — opencode creates one lazily
      adopt(s.id);
      const id = s.model && s.model.id;
      if (id) {
        this._opencodeModelCache = {
          checkedAt: Date.now(), model: id, modelLabel: opencodeApi.formatModelLabel(id),
        };
      }
    };

    opencodeApi.waitReady(port, 30000, () => api.closed || !this.alive).then((h) => {
      if (!h || api.closed) return;
      api.ready = true;
      refreshSession().then(() => {
        // Seed the idle flag from what is already true, rather than waiting for
        // the next `session.idle` event. A session we attach to mid-life — a
        // restore, or a front reconnecting to a long-running TUI — is very often
        // sitting on a finished turn, and without this, arming 🔊 on it would
        // stay silent until the user prompted again. The Claude path gets this
        // for free (its mtime cache starts at -1, so the first poll after arming
        // always reads); here it has to be asked for.
        if (api.closed || this._opencodeIdleAt) return;
        return opencodeApi.lastAssistantTurn(port, this.agentSessionId)
          .then((turn) => { if (turn && turn.finished && !api.closed) this._opencodeIdleAt = Date.now(); })
          .catch(() => {});
      }).catch(() => {});
      // The event stream is the whole point: it turns "poll a subprocess every
      // 10s and hope" into "know the moment it happens".
      api.events = opencodeApi.subscribe(port, (ev) => {
        const type = ev && ev.type;
        const props = (ev && ev.properties) || {};
        // Any session-scoped event names the conversation this TUI is on, which
        // is worth more than anything we could infer. Seen before the first
        // refresh, this is how a session that existed before we attached (a
        // `--session <id>` restore) gets identified at all.
        if (props.sessionID) adopt(props.sessionID);
        if (type === 'session.created' || type === 'session.updated' || type === 'session.next.model.switched') {
          refreshSession(props.sessionID);
        } else if (type === 'session.idle') {
          // The turn is over and opencode is waiting on you. Claude Code has no
          // equivalent — termhub has to infer it from the transcript's
          // stop_reason, and can't see a question at all.
          this._opencodeIdleAt = Date.now();
          this._opencodeAsk = null;
          if (this.onAgentIdle) { try { this.onAgentIdle(); } catch {} }
        } else if (type === 'session.status' || type === 'session.next.step.started') {
          this._opencodeIdleAt = 0;
          this._opencodeAsk = null;
        } else if (type === 'question.asked' || type === 'question.v2.asked'
                || type === 'permission.asked' || type === 'permission.v2.asked') {
          // What Claude cannot tell us. Read it back off the API rather than
          // trusting the event body, so the question shape lives in one place.
          opencodeApi.pendingAsk(port, this.agentSessionId).then((ask) => {
            if (api.closed || !ask) return;
            this._opencodeAsk = ask;
            this._opencodeIdleAt = Date.now();
            if (this.onAgentIdle) { try { this.onAgentIdle(); } catch {} }
          }).catch(() => {});
        } else if (/^(question|permission)\.(v2\.)?(replied|rejected)$/.test(type || '')) {
          this._opencodeAsk = null;
        }
      });
    }).catch(() => {});
  }

  _stopOpencodeApi() {
    const api = this._opencodeApi;
    if (!api) return;
    api.closed = true;
    if (api.events) { try { api.events.close(); } catch {} }
    this._opencodeApi = null;
  }

  // The last finished assistant turn, for the voice layer. Uses the API when
  // this session has one and says so, so the caller can fall back.
  async opencodeTurn() {
    if (!this.opencodePort || !this._opencodeApi || !this._opencodeApi.ready) return null;
    if (!this.agentSessionId) return null;
    const ask = this._opencodeAsk;
    if (ask) {
      // Being asked something outranks the last thing it said: that is the one
      // moment the user actually needs to be told, and unlike Claude we can say
      // what it is.
      const opts = ask.options && ask.options.length ? ` Options: ${ask.options.join(', ')}.` : '';
      return { id: `${this.agentSessionId}:${ask.id}`, waiting: true, text: `${ask.text}.${opts}`, ask: true };
    }
    const turn = await opencodeApi.lastAssistantTurn(this.opencodePort, this.agentSessionId);
    if (!turn || !turn.finished) return null;
    return { id: turn.id, waiting: true, text: turn.text, ask: false };
  }

  // opencode has no local file to tail. With a port we read the model off the
  // live API (instant, and correct the moment the user switches models); without
  // one this falls back to shelling out to `opencode export` (~1.4s, measured),
  // so it always returns whatever's cached and only kicks off a background
  // refresh when the cache goes stale. Never awaits the subprocess inline:
  // info() (which calls this) is called synchronously from sessiond's handlers.
  _opencodeModel() {
    // The API path keeps _opencodeModelCache up to date from the event stream,
    // so there is nothing to poll and nothing to wait for.
    if (this._opencodeApi && this._opencodeApi.ready) {
      const c = this._opencodeModelCache;
      return { model: c.model, modelLabel: c.modelLabel };
    }
    if (!this.agentSessionId) return { model: null, modelLabel: null };
    const cache = this._opencodeModelCache;
    if (!this._opencodeRefreshing && Date.now() - cache.checkedAt > OPENCODE_MODEL_REFRESH_MS) {
      this._opencodeRefreshing = true;
      opencodeModel.getModel(this.cwd, this.agentSessionId)
        .then((info) => {
          this._opencodeModelCache = {
            checkedAt: Date.now(),
            model: info ? info.id : null,
            modelLabel: info ? opencodeModel.formatModelLabel(info.id) : null,
          };
        })
        .catch(() => { this._opencodeModelCache = { ...this._opencodeModelCache, checkedAt: Date.now() }; })
        .finally(() => { this._opencodeRefreshing = false; });
    }
    return { model: cache.model, modelLabel: cache.modelLabel };
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.alive) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // resize can throw if the pty just exited; ignore
      }
    }
  }

  rename(title) {
    const t = title && String(title).trim();
    if (t) this.title = t;
    return this.title;
  }

  kill() {
    this._discoveryAborted = true; // stop an in-flight opencode session-id discovery loop
    this._stopOpencodeApi();       // and its event-stream reconnect loop, which would retry forever
    if (this.alive) {
      try {
        this.pty.kill();
      } catch {
        // already gone
      }
    }
  }

  info() {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      command: this.command,
      kind: this.kind,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      created: this.created,
      alive: this.alive,
      exitCode: this.exitCode,
      // "busy" = the PTY produced output very recently. A working Claude session
      // (or any active process) streams output continuously; an idle prompt is
      // silent. Good enough to show a "working" dot vs nothing when idle.
      busy: this.alive && (Date.now() - this.lastActivity) < 1500,
      voiceArmed: this.voiceArmed,
      // Can this session ever produce a spoken announcement? The rule is no
      // longer "is it claude" — an opencode termhub launched with a --port can
      // too, and one from an older build cannot — so it is answered here rather
      // than re-derived in the browser from `kind`, where it would drift.
      canSpeak: this.canSpeak(),
      ...this.currentModel(), // { model, modelLabel } — null/null for a plain shell
    };
  }

  // Kept beside info() and mirrored by VoiceHub.canArm, which is the authority
  // the arming endpoint enforces; this is the same question asked cheaply.
  canSpeak() {
    if (this.kind === 'claude') return true;
    if (this.kind === 'opencode') return !!(this.opencodePort || this._opencodePortPromise);
    return false;
  }
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}

module.exports = { Session };
