'use strict';

// Passkey sign-in (plan 7.1). window.paAuth = {status, register, login, logout,
// stepUp}. login.html uses it for the sign-in page; any other page that needs a
// passkey tap for a high-risk approval loads this script and calls
// `await paAuth.stepUp(approvalId)` before it posts the approval. Relative URLs
// only, so it works under termhub's /pa/ proxy. No HTML sink: text only.
(function () {
  const b64uToBuf = (s) => {
    const p = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(p);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const bufToB64u = (buf) => {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-PA': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  const creationOptions = (o) => ({
    ...o,
    challenge: b64uToBuf(o.challenge),
    user: { ...o.user, id: b64uToBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  });
  const requestOptions = (o) => ({
    ...o,
    challenge: b64uToBuf(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  });

  async function get(o) {
    const cred = await navigator.credentials.get({ publicKey: requestOptions(o) });
    if (!cred) throw new Error('no passkey was used');
    const r = cred.response;
    return {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(r.clientDataJSON),
        authenticatorData: bufToB64u(r.authenticatorData),
        signature: bufToB64u(r.signature),
        userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    };
  }

  window.paAuth = {
    status: () => api('api/auth/status'),

    async register(label) {
      const { ceremonyId, options } = await api('api/auth/register/options', {});
      const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
      if (!cred) throw new Error('no passkey was created');
      const r = cred.response;
      return api('api/auth/register/verify', {
        ceremonyId,
        label,
        response: {
          id: cred.id,
          rawId: bufToB64u(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: bufToB64u(r.clientDataJSON),
            attestationObject: bufToB64u(r.attestationObject),
            transports: r.getTransports ? r.getTransports() : [],
          },
          clientExtensionResults: cred.getClientExtensionResults(),
          authenticatorAttachment: cred.authenticatorAttachment || undefined,
        },
      });
    },

    async login() {
      const { ceremonyId, options } = await api('api/auth/login/options', {});
      return api('api/auth/login/verify', { ceremonyId, response: await get(options) });
    },

    logout: () => api('api/auth/logout', {}),

    /** A passkey tap bound to this one approval id; resolves when the server has recorded it. */
    async stepUp(approvalId) {
      const { ceremonyId, options } = await api('api/auth/stepup/options', { approvalId });
      return api('api/auth/stepup/verify', { ceremonyId, approvalId, response: await get(options) });
    },
  };

  // The sign-in page: elements are optional, so other pages can load this script bare.
  const $ = (id) => document.getElementById(id);
  if ($('pa-login')) {
    const msg = (t, bad) => { $('msg').textContent = t; $('msg').className = bad ? 'bad' : ''; };
    const done = () => { location.href = './'; };
    const run = (fn) => async () => { try { msg('Waiting for your passkey...'); await fn(); } catch (e) { msg(String(e.message || e), true); } };

    paAuth.status().then((s) => {
      if (!s.registered) {
        $('first').hidden = false;
        msg('No passkey is registered yet. Register one to protect this dashboard.');
      } else if (s.signedIn) {
        done();
      } else {
        $('signin').hidden = false;
      }
    }).catch((e) => msg(String(e.message || e), true));

    $('signin').onclick = run(async () => { await paAuth.login(); done(); });
    $('first').onclick = run(async () => { await paAuth.register($('label').value || 'this device'); done(); });
  }
})();
