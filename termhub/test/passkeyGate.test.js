'use strict';

// termhub's passkey gate (plan 7.1): off by default, a remote request needs the
// PA to vouch for its cookie, the local console is never refused, and a PA that
// does not answer refuses remote requests instead of opening them.
//
//   node test/passkeyGate.test.js

const assert = require('assert');
const { createPasskeyGate, isRemote, guarded } = require('../lib/passkeyGate');

const local = (headers = {}) => ({ headers, socket: { remoteAddress: '127.0.0.1' } });
const serve = (headers = {}) => ({ headers: { 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': 'k@example.com', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
const tailnet = (headers = {}) => ({ headers, socket: { remoteAddress: '100.64.0.2' } });

(async () => {
  // which paths
  assert.strictEqual(guarded('/api/sessions'), true);
  assert.strictEqual(guarded('/ws/term/abc'), true);
  assert.strictEqual(guarded('/api/health'), false);
  assert.strictEqual(guarded('/api/version'), false);
  assert.strictEqual(guarded('/pa/api/state'), false, 'the dashboard gates itself');
  assert.strictEqual(guarded('/'), false, 'static pages hold nothing; their API calls are gated');

  // local vs remote
  assert.strictEqual(isRemote(local()), false);
  assert.strictEqual(isRemote(serve()), true, 'Tailscale Serve connects from loopback but says so');
  assert.strictEqual(isRemote(tailnet()), true);
  assert.strictEqual(isRemote({ headers: {}, socket: { remoteAddress: '::1' } }), false);

  // off: nothing changes, and the PA is never asked
  let asked = 0;
  const off = createPasskeyGate({ env: {}, check: async () => { asked++; return 'no'; } });
  assert.strictEqual(off.enabled, false);
  assert.deepStrictEqual(await off.verdict(tailnet(), '/api/sessions'), { ok: true });
  assert.strictEqual(asked, 0);

  // on
  let answer = 'no';
  let t = 1_000_000;
  const seen = [];
  const gate = createPasskeyGate({ env: { PA_PASSKEYS: 'on' }, now: () => t, check: async (cookie) => { seen.push(cookie); return answer; } });
  assert.strictEqual(gate.enabled, true);
  assert.deepStrictEqual(await gate.verdict(local(), '/api/sessions'), { ok: true }, 'the local console is never locked out');
  assert.strictEqual(seen.length, 0);
  assert.deepStrictEqual(await gate.verdict(serve(), '/api/health'), { ok: true });

  let v = await gate.verdict(serve({ cookie: 'pa_session=abc' }), '/api/sessions');
  assert.deepStrictEqual([v.ok, v.status], [false, 401]);
  assert.match(v.error, /\/pa\/login/);
  assert.deepStrictEqual(seen, ['pa_session=abc'], 'the browser cookie is what the PA is asked about');

  answer = 'ok';
  assert.deepStrictEqual(await gate.verdict(serve({ cookie: 'pa_session=abc' }), '/ws/term/1'), { ok: true });
  answer = 'no';
  assert.deepStrictEqual(await gate.verdict(serve({ cookie: 'pa_session=abc' }), '/api/sessions'), { ok: true }, 'a positive answer is cached briefly');
  t += 10_001;
  assert.strictEqual((await gate.verdict(serve({ cookie: 'pa_session=abc' }), '/api/sessions')).ok, false, 'then asked again, and signed out is signed out');

  answer = 'ok';
  assert.strictEqual((await gate.verdict(serve({ cookie: 'pa_session=other' }), '/api/sessions')).ok, true);
  answer = 'no';
  assert.strictEqual((await gate.verdict(serve({ cookie: 'pa_session=different' }), '/api/sessions')).ok, false, 'the cache is per cookie');

  // PA down: remote refused (503), local still fine
  answer = 'down';
  v = await gate.verdict(tailnet({ cookie: 'x=1' }), '/api/sessions');
  assert.deepStrictEqual([v.ok, v.status], [false, 503]);
  assert.deepStrictEqual(await gate.verdict(local(), '/api/sessions'), { ok: true });

  // no PA configured at all behaves as down
  const noPa = createPasskeyGate({ env: { PA_PASSKEYS: 'on' }, paUrl: null });
  assert.strictEqual((await noPa.verdict(serve(), '/api/sessions')).status, 503);

  console.log('passkeyGate: ok');
})().catch((err) => { console.error(err); process.exit(1); });
