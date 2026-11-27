'use strict';

// The Keys view's API (Run tab > Keys). It sits on lib/secrets.ts and never sends a
// value back to the browser: GET returns names, descriptions and status only.
//
//   GET  /api/secrets               -> [{ name, description, destination, requesters, status }]
//   POST /api/secrets/add           -> body { name, value }   the Keys form: creates the entry if needed and saves
//   POST /api/secrets/set           -> body { name, value }   saves to the store
//   POST /api/secrets/clear         -> body { name }          removes the stored value
//   POST /api/secrets/spec          -> body { name, description, destination, requesters[] }
//   POST /api/secrets/spec-remove   -> body { name }          removes the spec entry only
//
// Who may call it: this machine always. Any other machine only when passkey sign-in
// is on AND the request passed it (lib/passkeyGate.ts). With passkeys off, a request
// from another machine is refused, because that would be an unauthenticated write.
//
// Every change is appended to ~/.config/termhub/secrets-audit.log as "time action name"
// (never the value), so you can see what changed and when.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const secrets = require('./secrets.ts');
const { isRemote } = require('./passkeyGate.ts');

const MAX_BODY = 16 * 1024;

function auditFile(): string {
  return process.env.TERMHUB_SECRETS_AUDIT || path.join(os.homedir(), '.config', 'termhub', 'secrets-audit.log');
}

/** Append one audit line. Records the action and the name only. */
function audit(action: string, name: string): void {
  try {
    fs.mkdirSync(path.dirname(auditFile()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditFile(), `${new Date().toISOString()} ${action} ${name}\n`, { mode: 0o600 });
  } catch (_) {
    // The audit line is best effort; a full disk must not block a save that worked.
  }
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('body must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Pure: the list the page shows. No values. */
function listView(): any[] {
  return secrets.readSpec().map((s: any) => ({
    name: s.name,
    description: s.description,
    destination: s.destination,
    requesters: s.requesters,
    status: secrets.status(s.name),
  }));
}

/** Ask the Jarvis dashboard how many passkeys exist and whether this browser is signed in. */
async function passkeyStatus(req: any): Promise<{ registered: number; signedIn: boolean }> {
  const base = process.env.PA_DISPATCH_URL || `http://127.0.0.1:${process.env.PA_DISPATCH_PORT || 7300}`;
  const r = await fetch(`${base}/api/auth/status`, { headers: { cookie: String(req.headers.cookie || '') } });
  const j: any = await r.json().catch(() => ({}));
  return { registered: Number(j.registered) || 0, signedIn: Boolean(j.signedIn) };
}

/**
 * Answer a /api/secrets request. Returns true if it handled the request.
 * `gate` is the passkey gate from front.ts (its `enabled` flag and `verdict`).
 */
function handle(req: any, res: any, url: URL, { sendJson, gate }: { sendJson: (res: any, code: number, body: any) => void; gate: any }): boolean {
  if (!url.pathname.startsWith('/api/secrets')) return false;

  const run = async () => {
    if (isRemote(req)) {
      if (!gate.enabled) return sendJson(res, 403, { error: 'Keys can only be changed from this machine until passkey sign-in is on (PA_PASSKEYS=on).' });
      // Stricter than the gate: the gate lets everything through while no passkey is
      // registered, so Keys also needs a registered passkey and a signed-in session.
      const s = await (gate.status ? gate.status(req) : passkeyStatus(req));
      if (!s.registered) return sendJson(res, 403, { error: 'Register a passkey on the Jarvis dashboard first (open it from this phone or laptop and sign in).' });
      if (!s.signedIn) return sendJson(res, 401, { error: 'Sign in with your passkey first, then reload this page.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/secrets') {
      return sendJson(res, 200, { secrets: listView(), store: secrets.storeDir() });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

    const body = await readBody(req);
    const name = String(body.name || '');
    if (!secrets.validName(name) && url.pathname !== '/api/secrets/spec-remove') {
      return sendJson(res, 400, { error: 'name must be UPPER_SNAKE_CASE' });
    }

    // Name and value only: creates the list entry if it is not there yet.
    if (url.pathname === '/api/secrets/add') {
      const value = typeof body.value === 'string' ? body.value : '';
      if (!value) return sendJson(res, 400, { error: 'value is empty' });
      if (!secrets.findSpec(name)) {
        secrets.upsertSpec({ name, description: '', destination: '', requesters: ['cli', 'rental-media'] });
      }
      secrets.setSecret(name, value);
      audit('add', name);
      return sendJson(res, 200, { ok: true, name, status: secrets.status(name) });
    }

    if (url.pathname === '/api/secrets/set') {
      const value = typeof body.value === 'string' ? body.value : '';
      if (!value) return sendJson(res, 400, { error: 'value is empty' });
      secrets.setSecret(name, value);
      audit('set', name);
      return sendJson(res, 200, { ok: true, name, status: secrets.status(name) });
    }

    if (url.pathname === '/api/secrets/clear') {
      secrets.clearSecret(name);
      audit('clear', name);
      return sendJson(res, 200, { ok: true, name, status: secrets.status(name) });
    }

    if (url.pathname === '/api/secrets/spec') {
      secrets.upsertSpec({
        name,
        description: String(body.description || ''),
        destination: String(body.destination || ''),
        requesters: Array.isArray(body.requesters) ? body.requesters.map(String) : [],
      });
      audit('spec', name);
      return sendJson(res, 200, { ok: true, name });
    }

    if (url.pathname === '/api/secrets/spec-remove') {
      secrets.removeSpec(name);
      audit('spec-remove', name);
      return sendJson(res, 200, { ok: true, name });
    }

    return sendJson(res, 404, { error: 'not found' });
  };

  run().catch((e: any) => {
    // Errors name the step, never a value.
    const status = e && e.status ? e.status : 500;
    sendJson(res, status, { error: e && e.message ? e.message : 'failed' });
  });
  return true;
}

module.exports = { handle, listView, audit, auditFile };
