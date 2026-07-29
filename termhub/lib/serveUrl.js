'use strict';

const { execFile } = require('child_process');

// The HTTPS address of this machine, as Tailscale Serve actually publishes it.
//
// Why this can't be derived in the browser: on a plain-HTTP origin the page is
// reached at `http://<tailnet-ip>:<front-port>`, so `location.hostname` is a raw
// 100.x address. Serve's certificate is issued for the MagicDNS name and covers
// nothing else, so an HTTPS URL built from `location.hostname` fails to connect
// — which is exactly what the voice strip used to tell people to open. The
// publish PORT can't be guessed either: it is whatever `tailscale serve
// --https=<port>` was given, and it is routinely not the front's own port (this
// checkout's Linux box publishes :7443 in front of a front on :7000).
//
// Serve knows both halves and states them together. `tailscale serve status
// --json` reports a `Web` map keyed by exactly the "<magicdns-host>:<port>" we
// need, so the answer is read off the key rather than reassembled:
//
//   { "Web": { "k-911-x17.porgy-boga.ts.net:7443":
//       { "Handlers": { "/": { "Proxy": "http://100.64.38.18:7000" } } } } }
//
// Returns null — never a guess — when Serve isn't publishing this front, or
// can't be consulted at all. A wrong URL is worse than none here: it sends
// someone to an address that cannot work and reads like termhub's fault.

const CACHE_MS = 60000;      // Serve config changes at deploy time, not per request
const TIMEOUT_MS = 3000;

// Cache the STATUS, not the resolved URL. Caching the answer would key it on
// time alone, so a second front port asking within the window would be handed
// the first one's address — wrong, and invisible in production only because a
// front asks about nothing but itself.
let cache = null;            // { at, status }

function tailscaleServeStatus() {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.status);
  return new Promise((resolve) => {
    execFile('tailscale', ['serve', 'status', '--json'], { timeout: TIMEOUT_MS }, (err, stdout) => {
      let status = null;
      if (!err && stdout && stdout.trim()) {
        try { status = JSON.parse(stdout); } catch { status = null; }
      }
      cache = { at: Date.now(), status };
      resolve(status);
    });
  });
}

// Does this handler's proxy target point at the front asking the question?
// The port has to match exactly. The host is deliberately loose: Serve proxies
// to `127.0.0.1:<port>` in the Windows single-port layout and to the tailnet IP
// on a box where the front binds it directly, and both are this same front.
// Requiring an exact host match would answer "no HTTPS address" on one of the
// two supported layouts.
function proxyTargetsPort(proxy, port) {
  try {
    const u = new URL(proxy);
    return Number(u.port) === Number(port);
  } catch {
    return false;
  }
}

function findServeUrl(status, port) {
  const web = status && status.Web;
  if (!web || typeof web !== 'object') return null;
  for (const [hostPort, entry] of Object.entries(web)) {
    const handlers = (entry && entry.Handlers) || {};
    for (const handler of Object.values(handlers)) {
      if (handler && handler.Proxy && proxyTargetsPort(handler.Proxy, port)) {
        return `https://${hostPort}/`;
      }
    }
  }
  return null;
}

// Resolve the published HTTPS URL for a front listening on `port`.
// The `tailscale` spawn behind this is cached: the client asks only from an
// insecure origin, but it asks on every load.
async function secureUrlForPort(port) {
  return findServeUrl(await tailscaleServeStatus(), port);
}

module.exports = { secureUrlForPort, findServeUrl, proxyTargetsPort };
