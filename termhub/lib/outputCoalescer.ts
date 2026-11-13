'use strict';

//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

// Per-client output coalescing for sessiond's terminal sockets.
//
// ptyd hands sessiond output in ~100-byte reads, and under a busy Claude Code
// session that is 1000+ messages a second per terminal. Every one used to become
// its own JSON frame, its own WebSocket message through the front, and its own
// term.write() in the browser, which is where the lag came from (measured: the
// browser's main thread, not the network). Here the bytes of a burst are joined
// into one `{type:'output'}` message per ~12 ms window instead.
//
// Rules, each of which is a bug if broken:
//  - Latency for a lone keystroke echo is unchanged: when nothing has been sent
//    for a full window the first chunk goes out immediately (leading edge). Only
//    chunks that follow within the window are held, to the end of the window.
//  - Order is preserved against every other message type. Anything that is not
//    output (`size`, `exit`, a `replay`) goes through sendOther(), which flushes
//    pending output first, so a resize never overtakes bytes that were written
//    at the old size.
//  - A burst never grows without bound: past maxBytes the buffer is flushed now.
//  - A timer pending at detach is cancelled (dispose) and its bytes dropped:
//    the socket is gone, and a reattach is served from the screen snapshot.

const DEFAULT_INTERVAL_MS = 12;
const DEFAULT_MAX_BYTES = 64 * 1024;

class OutputCoalescer {
  declare _send: any;
  declare _interval: number;
  declare _maxBytes: number;
  declare _now: () => number;
  declare _setTimer: any;
  declare _clearTimer: any;
  declare _parts: string[];
  declare _bytes: number;
  declare _timer: any;
  declare _lastSent: number;
  declare _disposed: boolean;

  constructor(send: (msg: any) => void, opts: { intervalMs?: number; maxBytes?: number; now?: () => number; setTimer?: any; clearTimer?: any } = {}) {
    this._send = send;
    this._interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this._maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this._now = opts.now || Date.now;
    this._setTimer = opts.setTimer || setTimeout;
    this._clearTimer = opts.clearTimer || clearTimeout;
    this._parts = [];
    this._bytes = 0;
    this._timer = null;
    this._lastSent = -Infinity;
    this._disposed = false;
  }

  // Queue terminal output for this client.
  push(data: string) {
    if (this._disposed || !data) return;
    const idle = this._parts.length === 0 && this._now() - this._lastSent >= this._interval;
    this._parts.push(data);
    this._bytes += data.length;
    if (idle || this._bytes >= this._maxBytes) { this.flush(); return; }
    if (this._timer === null) {
      const wait = Math.max(0, this._interval - (this._now() - this._lastSent));
      this._timer = this._setTimer(() => { this._timer = null; this.flush(); }, wait);
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }
  }

  // Send what is pending as one output message.
  flush() {
    if (this._timer !== null) { this._clearTimer(this._timer); this._timer = null; }
    if (this._disposed || this._parts.length === 0) return;
    const data = this._parts.length === 1 ? this._parts[0] : this._parts.join('');
    this._parts = [];
    this._bytes = 0;
    this._lastSent = this._now();
    this._send({ type: 'output', data });
  }

  // Send any non-output message, after the output that preceded it.
  sendOther(msg: any) {
    this.flush();
    if (!this._disposed) this._send(msg);
  }

  dispose() {
    this._disposed = true;
    if (this._timer !== null) { this._clearTimer(this._timer); this._timer = null; }
    this._parts = [];
    this._bytes = 0;
  }
}

module.exports = { OutputCoalescer, DEFAULT_INTERVAL_MS, DEFAULT_MAX_BYTES };
