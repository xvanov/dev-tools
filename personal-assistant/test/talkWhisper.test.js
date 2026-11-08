'use strict';

// askWhisper (src/dashboard/talk.js) against fakes of the transcriber's
// protocol. Runs under Node and under Bun (jarvisd/scripts/parity.js): under Bun
// `socket.end()` closes the connection instead of half-closing, which made the
// client see "closed, no data" and return empty text (plan 8.2.1).

const assert = require('assert');
const net = require('net');
const { askWhisper } = require('../src/dashboard/talk');

// A transcriber like voice-dictation/transcribe_server.py: it reads ONE
// request (the path) without waiting for EOF, answers after `delayMs`, closes.
function fake(onRequest, delayMs = 60) {
  const seen = [];
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    c.on('error', () => {});
    c.once('data', (d) => {
      const path = String(d).trim();
      seen.push(path);
      const reply = onRequest(path, seen.length);
      setTimeout(() => (reply === null ? c.destroy() : c.end(reply)), reply === null ? 0 : delayMs);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port })));
}

(async () => {
  const opts = (f) => ({ host: '127.0.0.1', port: f.port, timeoutMs: 5000 });

  // The reply is waited for, however the runtime handles end().
  let f = await fake(() => 'what is on today ');
  assert.strictEqual(await askWhisper('C:\\x.wav', opts(f)), 'what is on today');
  assert.deepStrictEqual(f.seen, ['C:\\x.wav'], 'the path arrives, once, without a stray byte');
  f.srv.close();

  // Silence: whisper answers with nothing after doing its work. That is text, not an error.
  f = await fake(() => '');
  assert.strictEqual(await askWhisper('a.wav', opts(f)), '');
  f.srv.close();

  // A socket closed without a reply is an error, never empty text; one retry first.
  f = await fake(() => null);
  await assert.rejects(askWhisper('a.wav', opts(f)), (e) => e.status === 502 && /without a reply/.test(e.message));
  assert.strictEqual(f.seen.length, 2, 'retried once');
  f.srv.close();

  // ...and a flaky first attempt is recovered by the retry.
  f = await fake((p, n) => (n === 1 ? null : 'hello there'));
  assert.strictEqual(await askWhisper('a.wav', opts(f)), 'hello there');
  assert.strictEqual(f.seen.length, 2);
  f.srv.close();

  // The transcriber's own ERROR is an error, not retried.
  f = await fake(() => 'ERROR: No such file');
  await assert.rejects(askWhisper('a.wav', opts(f)), (e) => e.status === 502 && /No such file/.test(e.message));
  assert.strictEqual(f.seen.length, 1);
  f.srv.close();

  // Nothing listening: 503.
  const dead = await fake(() => '');
  const port = dead.port;
  dead.srv.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(askWhisper('a.wav', { host: '127.0.0.1', port, timeoutMs: 2000 }), (e) => e.status === 503);

  console.log('talkWhisper ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});