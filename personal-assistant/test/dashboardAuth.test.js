'use strict';

// Passkey sign-in through the dashboard's real request handler (plan 7.1):
// the flag off changes nothing, the gate is open until the first passkey is
// registered, then requires the cookie, and the step-up endpoints grant one
// approval id. A software authenticator (test/_webauthn.js) plays the browser.
//
//   node test/dashboardAuth.test.js

const assert = require('assert');
const { Readable } = require('stream');
const wa = require('./_webauthn');

process.env.PA_PASSKEY_ORIGINS = wa.ORIGIN;
process.env.PA_PASSKEY_RP_ID = wa.RP_ID;

const server = require('../src/dashboard/server');
const auth = require('../src/dashboard/auth');
const { fakeRepos } = require('./_fakePasskeyRepos');

let repos;
function fresh() {
  repos = fakeRepos();
  auth.reset({ repos });
}

/** One request through server.handle; resolves {status, headers, json, text}. */
function call(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = Object.assign(Readable.from(payload ? [payload] : []), {
      method, url: path, headers: { host: 'localhost:7300', ...headers },
    });
    const out = { status: 0, headers: {}, chunks: [] };
    const res = {
      setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
      writeHead(status, h = {}) { out.status = status; for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v; },
      end(data) {
        if (data) out.chunks.push(String(data));
        const text = out.chunks.join('');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: out.status, headers: out.headers, json, text });
      },
      write: (d) => out.chunks.push(String(d)),
    };
    server.handle(req, res).catch(reject);
  });
}

const PA = { 'x-pa': '1', 'content-type': 'application/json' };
const cookieOf = (r) => String(r.headers['set-cookie'] || '').split(';')[0];

const cases = {
  async 'flag off: no gate, no auth routes, no passkey table touched'() {
    delete process.env.PA_PASSKEYS;
    fresh();
    repos.passkeys.credentialCount = async () => { throw new Error('touched the store'); };
    assert.strictEqual((await call('GET', '/api/auth/status')).status, 404);
    assert.strictEqual((await call('GET', '/healthz')).status !== 401, true);
    const r = await call('GET', '/api/version');
    assert.notStrictEqual(r.status, 401);
    assert.strictEqual(await auth.gate({ method: 'GET', headers: {} }, {}, new URL('http://x/api/state'), { send() {} }), false);
  },

  async 'on, no passkey yet: the gate is open so the first one can be registered'() {
    process.env.PA_PASSKEYS = 'on';
    fresh();
    assert.strictEqual(await auth.gate({ method: 'GET', headers: {} }, {}, new URL('http://x/api/state'), { send() { throw new Error('refused'); } }), false);
    const s = await call('GET', '/api/auth/status');
    assert.deepStrictEqual([s.json.enabled, s.json.registered, s.json.signedIn], [true, 0, false]);
    assert.strictEqual((await call('GET', '/api/auth/check')).status, 200, 'termhub is told ok while nothing is registered');
  },

  async 'register the first passkey: signs you in with a Strict, HttpOnly cookie; the gate then closes'() {
    process.env.PA_PASSKEYS = 'on';
    fresh();
    const o = await call('POST', '/api/auth/register/options', { headers: PA, body: {} });
    assert.strictEqual(o.status, 200);
    const v = await call('POST', '/api/auth/register/verify', {
      headers: PA, body: { ceremonyId: o.json.ceremonyId, label: 'laptop', response: wa.register({ challenge: o.json.options.challenge }) },
    });
    assert.strictEqual(v.status, 200, v.text);
    assert.match(v.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
    const cookie = cookieOf(v);

    // closed to a stranger, open to the cookie
    const api = await call('GET', '/api/state');
    assert.strictEqual(api.status, 401);
    assert.strictEqual(api.json.login, true);
    const page = await call('GET', '/', { headers: { accept: 'text/html' } });
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.location, 'login');
    assert.strictEqual((await call('GET', '/api/auth/check')).status, 401);
    assert.strictEqual((await call('GET', '/api/auth/check', { headers: { cookie } })).status, 200);
    assert.strictEqual((await call('GET', '/login')).status, 200, 'the sign-in page is reachable');
    assert.strictEqual((await call('GET', '/healthz')).status !== 401, true, 'the supervisor probe is not gated');
    // with the cookie the gate lets the request through to the handler (not run here: it needs the database)
    assert.strictEqual(await auth.gate({ method: 'GET', headers: { cookie } }, { setHeader() {} }, new URL('http://x/api/state'), { send() { throw new Error('refused'); } }), false);
    // a second passkey needs a session
    assert.strictEqual((await call('POST', '/api/auth/register/options', { headers: PA, body: {} })).status, 401);
    assert.strictEqual((await call('POST', '/api/auth/register/options', { headers: { ...PA, cookie }, body: {} })).status, 200);
  },

  async 'sign in with the passkey; logout ends the session; X-PA is required on POST'() {
    process.env.PA_PASSKEYS = 'on';
    fresh();
    await repos.passkeys.addCredential({ id: wa.b64(wa.CRED_ID), publicKey: wa.b64(Buffer.from(require('./_webauthn').coseKeyBytes())), counter: 0 });
    assert.strictEqual((await call('POST', '/api/auth/login/options', { headers: { 'content-type': 'application/json' }, body: {} })).status, 403, 'no X-PA');
    const o = await call('POST', '/api/auth/login/options', { headers: PA, body: {} });
    const bad = await call('POST', '/api/auth/login/verify', { headers: PA, body: { ceremonyId: o.json.ceremonyId, response: wa.assert({ challenge: wa.b64(Buffer.alloc(32, 1)), counter: 1 }) } });
    assert.strictEqual(bad.status, 401, 'a wrong challenge signs nobody in');
    assert.ok(!bad.headers['set-cookie']);
    const o2 = await call('POST', '/api/auth/login/options', { headers: PA, body: {} });
    const ok = await call('POST', '/api/auth/login/verify', { headers: PA, body: { ceremonyId: o2.json.ceremonyId, response: wa.assert({ challenge: o2.json.options.challenge, counter: 1 }) } });
    assert.strictEqual(ok.status, 200, ok.text);
    const cookie = cookieOf(ok);
    assert.strictEqual((await call('GET', '/api/auth/status', { headers: { cookie } })).json.signedIn, true);
    const out = await call('POST', '/api/auth/logout', { headers: { ...PA, cookie }, body: {} });
    assert.match(out.headers['set-cookie'], /Max-Age=0/);
    assert.strictEqual((await call('GET', '/api/auth/status', { headers: { cookie } })).json.signedIn, false);
  },

  async 'step-up over HTTP: needs a session, binds to the approval id, grants only that one'() {
    process.env.PA_PASSKEYS = 'on';
    fresh();
    await repos.passkeys.addCredential({ id: wa.b64(wa.CRED_ID), publicKey: wa.b64(Buffer.from(require('./_webauthn').coseKeyBytes())), counter: 0 });
    const lo = await call('POST', '/api/auth/login/options', { headers: PA, body: {} });
    const li = await call('POST', '/api/auth/login/verify', { headers: PA, body: { ceremonyId: lo.json.ceremonyId, response: wa.assert({ challenge: lo.json.options.challenge, counter: 1 }) } });
    const cookie = cookieOf(li);
    const H = { ...PA, cookie };

    assert.strictEqual((await call('POST', '/api/auth/stepup/options', { headers: PA, body: { approvalId: 'appr-9' } })).status, 401, 'no session, no step-up');
    assert.strictEqual((await call('POST', '/api/auth/stepup/options', { headers: H, body: { approvalId: '../x y' } })).status, 400, 'approval id is checked');
    assert.strictEqual((await call('POST', '/api/auth/stepup/options', { headers: H, body: {} })).status, 400);

    const so = await call('POST', '/api/auth/stepup/options', { headers: H, body: { approvalId: 'appr-9' } });
    assert.strictEqual(so.status, 200);
    // the assertion for appr-9 offered for appr-10 is refused and grants nothing
    const wrong = await call('POST', '/api/auth/stepup/verify', { headers: H, body: { ceremonyId: so.json.ceremonyId, approvalId: 'appr-10', response: wa.assert({ challenge: so.json.options.challenge, counter: 2 }) } });
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual(await repos.passkeys.hasStepUp('appr-10', new Date()), false);
    // a fresh ceremony for appr-9, signed properly
    const so2 = await call('POST', '/api/auth/stepup/options', { headers: H, body: { approvalId: 'appr-9' } });
    const good = await call('POST', '/api/auth/stepup/verify', { headers: H, body: { ceremonyId: so2.json.ceremonyId, approvalId: 'appr-9', response: wa.assert({ challenge: so2.json.options.challenge, counter: 3 }) } });
    assert.strictEqual(good.status, 200, good.text);
    assert.strictEqual(await repos.passkeys.hasStepUp('appr-9', new Date()), true);
    assert.strictEqual(await repos.passkeys.hasStepUp('appr-10', new Date()), false);
  },

  async 'repeated failed assertions are rate limited'() {
    process.env.PA_PASSKEYS = 'on';
    fresh();
    await repos.passkeys.addCredential({ id: wa.b64(wa.CRED_ID), publicKey: wa.b64(Buffer.from(require('./_webauthn').coseKeyBytes())), counter: 0 });
    let last;
    for (let i = 0; i < 12; i++) {
      const o = await call('POST', '/api/auth/login/options', { headers: PA, body: {} });
      last = await call('POST', '/api/auth/login/verify', { headers: PA, body: { ceremonyId: o.json.ceremonyId, response: wa.assert({ challenge: wa.b64(Buffer.alloc(32, 2)), counter: 1 }) } });
    }
    assert.strictEqual(last.status, 429);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${String(err.stack || err).split('\n').slice(0, 7).join('\n     ')}`);
    }
  }
  console.log(`dashboardAuth: ${Object.keys(cases).length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
