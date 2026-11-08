'use strict';

// A server-side copy of what a session's terminal currently shows, so a browser
// that attaches gets the screen *as it is now, at the size it is now* — not a
// replay of every byte the PTY ever produced.
//
// Why raw replay can't be fixed in the browser: the bytes in a long session were
// produced at whatever size the PTY had at the time. Claude Code, vim and
// opencode draw with absolute cursor positioning, so output written for a
// 162-column desktop and then replayed into a 54-column phone (or the other way
// round) puts characters in the wrong places, and nothing on the receiving end
// can know which bytes belonged to which width. A headless xterm fed the same
// stream lives through every resize as it happens — reflowing the normal
// buffer exactly as a browser xterm would — so serializing it yields one clean
// screen at the current size. It is also far smaller: a few hundred KB of state
// instead of up to 2 MB of redraws a phone would otherwise have to re-parse.
//
// Fallback: if @xterm/headless or @xterm/addon-serialize is missing (a machine
// whose `npm install` didn't run, or failed), this degrades to the old raw byte
// ring buffer rather than taking sessiond down. `kind` says which one is live.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

let Headless: any = null;
let Serialize: any = null;
try {
  Headless = require('@xterm/headless').Terminal;
  Serialize = require('@xterm/addon-serialize').SerializeAddon;
} catch {
  Headless = null;
  Serialize = null;
}

// Lines of scrollback kept in the mirror. xterm allocates rows lazily, so a
// short session costs little; a long one at desktop width costs ~cols*12 bytes
// per row. 5000 rows at 160 cols is under 10 MB.
const DEFAULT_SCROLLBACK_LINES = Number(process.env.TERMHUB_SCROLLBACK_LINES) || 5000;
// Raw-fallback budget, as before the mirror existed.
const DEFAULT_SCROLLBACK_BYTES = Number(process.env.TERMHUB_SCROLLBACK_BYTES) || 2 * 1024 * 1024;

class ScreenMirror {
  declare _disposed: any;
  declare cols: any;
  declare rows: any;
  declare _term: any;
  declare _ser: any;
  declare kind: any;
  declare _maxBytes: any;
  declare _chunks: any;
  declare _bytes: any;
  constructor({ cols = 80, rows = 24, scrollback, maxBytes, forceRaw = false }: { cols?: number | undefined; rows?: number | undefined; scrollback?: any; maxBytes?: any; forceRaw?: boolean | undefined } = {}) {
    this.cols = cols;
    this.rows = rows;
    this._disposed = false;
    if (Headless && Serialize && !forceRaw) {
      try {
        this._term = new Headless({
          cols, rows,
          scrollback: scrollback || DEFAULT_SCROLLBACK_LINES,
          allowProposedApi: true,
        });
        this._ser = new Serialize();
        this._term.loadAddon(this._ser);
        this.kind = 'mirror';
        return;
      } catch {
        this._term = null;
      }
    }
    this.kind = 'raw';
    this._maxBytes = maxBytes || DEFAULT_SCROLLBACK_BYTES;
    this._chunks = [];
    this._bytes = 0;
  }

  write(data: any) {
    if (this._disposed || !data) return;
    if (this._term) { this._term.write(data); return; }
    const bytes = Buffer.byteLength(data, 'utf8');
    this._chunks.push({ data, bytes });
    this._bytes += bytes;
    while (this._bytes > this._maxBytes && this._chunks.length > 1) {
      this._bytes -= this._chunks.shift().bytes;
    }
  }

  // Ordered with the byte stream: output the PTY produced *before* the resize is
  // parsed at the old size, everything after at the new one. xterm's write
  // queue runs a callback between chunks, so resizing from inside one lands at
  // exactly this point in the stream.
  resize(cols: any, rows: any) {
    this.cols = cols;
    this.rows = rows;
    if (this._disposed || !this._term) return;
    this._term.write('', () => {
      if (this._disposed) return;
      try { this._term.resize(cols, rows); } catch { /* bad dims: keep the old size */ }
    });
  }

  // Calls back with the current screen as a byte string that, written into a
  // fresh terminal of size cols x rows, reproduces it. Asynchronous for the
  // mirror: xterm parses writes in batches, so the snapshot waits until
  // everything written before this call has been parsed. Anything written
  // *after* the call is not in the snapshot — the caller forwards that as live
  // output (see Session.attach).
  snapshot(cb: any) {
    if (!this._term) {
      cb({ data: this._chunks.map((c: any) => c.data).join(''), cols: this.cols, rows: this.rows });
      return;
    }
    this._term.write('', () => {
      let data = '';
      try { data = this._ser.serialize(); } catch { data = ''; }
      cb({ data, cols: this._term.cols, rows: this._term.rows });
    });
  }

  dispose() {
    this._disposed = true;
    if (this._term) { try { this._term.dispose(); } catch {} this._term = null; }
    this._chunks = [];
  }
}

module.exports = { ScreenMirror, mirrorAvailable: !!(Headless && Serialize) };
