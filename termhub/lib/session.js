'use strict';

const os = require('os');
const pty = require('node-pty');
const { defaultShell } = require('./shell');

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
    this.cwd = cwd && String(cwd).trim() ? String(cwd).trim() : os.homedir();
    this.command = command && String(command).trim() ? String(command).trim() : null;
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.title = title || this.command || baseName(this.shell);
    this.created = Date.now();
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

    this.pty.onData((data) => {
      this._buffer(data);
      this._broadcast({ type: 'output', data });
    });

    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      this._broadcast({ type: 'exit', code: exitCode });
    });

    // If an initial command was requested (e.g. `claude`), run it in the shell
    // once it has settled. Running it *inside* the shell (rather than as the PTY
    // process) means the user still has a shell after the command exits.
    if (this.command) {
      setTimeout(() => {
        if (this.alive) this.pty.write(this.command + '\r');
      }, 350);
    }
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
    send({ type: 'replay', data: this.replay() });
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
    };
  }
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}

module.exports = { Session };
