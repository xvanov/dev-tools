'use strict';

// "Is somebody already on this port, and who?" — the authoritative duplicate
// check for the two-tier layout.
//
// A pid file can go stale or name a reused pid, so it can only ever be a hint.
// A port either answers or it doesn't, and if it answers `/api/ping` it tells
// you which entrypoint it is (`sessiond` vs the dev-only `server.js` monolith),
// its pid, and the commit it is RUNNING. That's what the updater and the
// entrypoint pre-flight checks key off.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const http = require('http');

// GET a JSON body over loopback. Rejects on a non-200, unparseable body,
// timeout, or connection error.
function probeJson({ port, path: reqPath, host = '127.0.0.1', timeoutMs = 2000 }: { port?: any; path?: any; host?: any; timeoutMs?: number | undefined }) {
  return new Promise<any>((resolve, reject) => {
    const req = http.get({ host, port, path: reqPath, timeout: timeoutMs }, (r: any) => {
      let raw = '';
      r.on('data', (c: any) => { raw += c; });
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`${reqPath} -> ${r.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch (e: any) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${reqPath} timed out`)));
    req.on('error', reject);
  });
}

// Who is on this sessiond port? Resolves to the `/api/ping` body, or null when
// nothing answers. Never rejects: "nobody home" is the expected answer at
// startup, not an error.
async function probeSessiond(port: any, timeoutMs: number = 1500) {
  try {
    const info = await probeJson({ port, path: '/api/ping', timeoutMs });
    return info && info.ok ? info : null;
  } catch {
    return null;
  }
}

// Same question for a front port (`/api/health` reports the front's own
// identity plus the sessiond it proxies to). Answers on a 503 too — an
// unhealthy front is still a process holding the port.
async function probeFront(port: any, timeoutMs: number = 1500) {
  try {
    return await probeJson({ port, path: '/api/health', timeoutMs });
  } catch (e: any) {
    return /-> 503$/.test(String(e.message)) ? { ok: false, front: true } : null;
  }
}

module.exports = { probeJson, probeSessiond, probeFront };
