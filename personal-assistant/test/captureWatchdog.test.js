'use strict';

// Which recorders the watchdog restarts: one that has not grown its spool for
// two minutes — unless capture is paused, or it was restarted moments ago.

const assert = require('assert');
const { staleStreams, STALE_MS } = require('../src/audio/watchdog');

const now = 10_000_000;
const fresh = now - 10_000;
const old = now - STALE_MS - 1;

assert.deepStrictEqual(staleStreams({ now, writes: { mic: fresh, loopback: fresh }, isPaused: false, lastRestarts: {} }), []);
assert.deepStrictEqual(staleStreams({ now, writes: { mic: fresh, loopback: old }, isPaused: false, lastRestarts: {} }), ['loopback']);
// Never written at all counts as silent.
assert.deepStrictEqual(staleStreams({ now, writes: { mic: 0, loopback: fresh }, isPaused: false, lastRestarts: {} }), ['mic']);
// Paused: silence is the point.
assert.deepStrictEqual(staleStreams({ now, writes: { mic: old, loopback: old }, isPaused: true, lastRestarts: {} }), []);
// Restarted a minute ago: give it time rather than restart in a loop.
assert.deepStrictEqual(staleStreams({ now, writes: { mic: old, loopback: fresh }, isPaused: false, lastRestarts: { mic: now - 60_000 } }), []);

console.log('captureWatchdog.test.js ok');
