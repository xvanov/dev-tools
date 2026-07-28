'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { defaultShell } = require('./shell');
const { resolveTranscript, readLastModel, formatModelName } = require('./claudeModel');
const opencodeModel = require('./opencodeModel');
const { injectAfterClaudeExe } = require('./restore');

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

// Classify a session by its initial command so the archive knows how to restore
// it: a `claude` invocation resumes via `--resume`, an `opencode` one via
// `--session`/`--continue`; anything else is a plain shell we rebuild by
// replaying recorded history. Matches the bare command, `<exe>.exe`/`.cmd`, a
// path ending in it, or a quoted form — but not `claude-foo` or `myclaude`.
function classifyCommand(command) {
  if (!command) return 'shell';
  if (/(^|[\\/\s"'])claude(\.exe|\.cmd)?(?=$|[\s"'])/i.test(command)) return 'claude';
  if (/(^|[\\/\s"'])opencode(\.exe|\.cmd)?(?=$|[\s"'])/i.test(command)) return 'opencode';
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
      const spawnedAtMs = Date.now(); // this.created isn't assigned yet at this point in the constructor
      opencodeModel.discoverSessionId(this.cwd, spawnedAtMs, () => this._discoveryAborted)
        .then((id) => { if (id && !this._discoveryAborted) this.agentSessionId = id; })
        .catch(() => {});
    }
    this._modelCache = { file: null, mtimeMs: -1, model: null, modelLabel: null };

    this.cols = cols || 80;
    this.rows = rows || 24;
    this.title = title || this.command || baseName(this.shell);
    this.created = Date.now();
    this.lastActivity = Date.now();
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
    // A short settle lets the prompt finish drawing before we type into it.
    setTimeout(() => { if (this.alive) this.pty.write(cmd + '\r'); }, 120);
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

  // opencode has no local file to tail — reading its model means shelling out
  // to `opencode export` (~1.4s, measured), so this always returns whatever's
  // cached and only kicks off a background refresh when the cache goes stale.
  // Never awaits the subprocess inline: info() (which calls this) is called
  // synchronously from sessiond's request handlers.
  _opencodeModel() {
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
      ...this.currentModel(), // { model, modelLabel } — null/null for non-claude sessions
    };
  }
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}

module.exports = { Session };
