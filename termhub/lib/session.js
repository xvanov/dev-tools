'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { defaultShell } = require('./shell');

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

let counter = 0;
function genId() {
  counter += 1;
  return `s${Date.now().toString(36)}${counter.toString(36)}`;
}

class Session {
  constructor({ cwd, command, title, cols, rows, maxBytes } = {}) {
    this.id = genId();
    this.shell = defaultShell();
    const resolved = resolveCwd(cwd);
    this.cwd = resolved.cwd;
    this._cwdNotice = resolved.notice;
    this.cwdFallback = !!resolved.notice;
    this.command = command && String(command).trim() ? String(command).trim() : null;
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.title = title || this.command || baseName(this.shell);
    this.created = Date.now();
    this.lastActivity = Date.now();
    this.alive = false;
    this.exitCode = null;

    this.maxBytes = maxBytes || DEFAULT_SCROLLBACK_BYTES;
    this._chunks = [];
    this._bytes = 0;
    this._clients = new Set(); // each is a function(msgObject)

    this._spawn();
  }

  _spawn() {
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
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
    if (this.alive) this.pty.write(data);
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
    };
  }
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}

module.exports = { Session };
