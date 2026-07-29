'use strict';

// Serve-URL resolution tests. Plain node, no framework, no deps:
//   node test/serveUrl.test.js
//
// These pin down the bug this module exists to kill. The voice strip used to
// build the "switch to HTTPS" address in the browser as
// `https://${location.hostname}:7443` — and on the only origin where that
// message is ever shown (plain HTTP, reached at the raw tailnet IP) BOTH halves
// were wrong: Serve's certificate covers the MagicDNS name and not the IP, so
// the URL could not connect, and the publish port is configuration, not 7443.
//
// The fixtures below are real `tailscale serve status --json` output from the
// machine that hit the bug: a front on :7000, published on :7443 under the
// MagicDNS name, alongside three unrelated Serve entries it must not match.
//
// The invariant: return the address Serve actually publishes, or null. Never a
// constructed guess — a URL that cannot connect is worse than admitting there
// isn't one, because it reads as termhub being broken rather than unconfigured.

const { findServeUrl, proxyTargetsPort } = require('../lib/serveUrl');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// Real output: termhub's front binds the tailnet IP directly and Serve fronts
// it on 7443. The other three entries are this box's unrelated services.
const LINUX_BOX = {
  TCP: { 443: { HTTPS: true }, 7443: { HTTPS: true }, 8443: { HTTPS: true }, 8444: { HTTPS: true } },
  Web: {
    'k-911-x17.porgy-boga.ts.net:443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:8082' },
        '/api': { Proxy: 'http://127.0.0.1:8000/api' },
      },
    },
    'k-911-x17.porgy-boga.ts.net:7443': { Handlers: { '/': { Proxy: 'http://100.64.38.18:7000' } } },
    'k-911-x17.porgy-boga.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3200' } } },
    'k-911-x17.porgy-boga.ts.net:8444': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8035' } } },
  },
};

// The Windows single-port layout: Serve publishes the SAME number it proxies to,
// and the target is loopback rather than the tailnet IP.
const WINDOWS_SINGLE_PORT = {
  TCP: { 7000: { HTTPS: true } },
  Web: { 'win-box.porgy-boga.ts.net:7000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7000' } } } },
};

// Blue/green: the front hides on 7001 and Serve fronts it on the publish port.
const WINDOWS_BLUE_GREEN = {
  TCP: { 7000: { HTTPS: true } },
  Web: { 'win-box.porgy-boga.ts.net:7000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7001' } } } },
};

// ---- 1. the address comes off Serve's key, not from a template --------------

eq('publish port differs from the front port',
  findServeUrl(LINUX_BOX, 7000), 'https://k-911-x17.porgy-boga.ts.net:7443/');
eq('the MagicDNS host is used, never the proxy target IP',
  findServeUrl(LINUX_BOX, 7000).includes('100.64.38.18'), false);
eq('single-port layout resolves to the same number',
  findServeUrl(WINDOWS_SINGLE_PORT, 7000), 'https://win-box.porgy-boga.ts.net:7000/');
eq('blue/green resolves the publish port, not the front port',
  findServeUrl(WINDOWS_BLUE_GREEN, 7001), 'https://win-box.porgy-boga.ts.net:7000/');

// ---- 2. null beats a guess --------------------------------------------------

eq('a front Serve does not publish has no HTTPS address',
  findServeUrl(LINUX_BOX, 7100), null);
eq('blue/green does not match the front that is NOT live',
  findServeUrl(WINDOWS_BLUE_GREEN, 7002), null);
eq('no Web map at all', findServeUrl({ TCP: { 443: { HTTPS: true } } }, 7000), null);
eq('empty Web map', findServeUrl({ Web: {} }, 7000), null);
eq('Serve could not be consulted', findServeUrl(null, 7000), null);
eq('garbage where the status should be', findServeUrl('not json', 7000), null);
eq('Web present but malformed', findServeUrl({ Web: { 'h:1': null } }, 7000), null);
eq('handler with no proxy', findServeUrl({ Web: { 'h:1': { Handlers: { '/': {} } } } }, 7000), null);

// ---- 3. matching is by port, and tolerant about the host --------------------
// Serve targets loopback in the Windows layout and the tailnet IP on a box where
// the front binds it directly. Both are the same front, so the host is not part
// of the test; requiring an exact match would answer "no HTTPS address" on one
// of the two supported layouts.

eq('loopback target matches', proxyTargetsPort('http://127.0.0.1:7000', 7000), true);
eq('tailnet-IP target matches', proxyTargetsPort('http://100.64.38.18:7000', 7000), true);
eq('port is compared numerically', proxyTargetsPort('http://127.0.0.1:7000', '7000'), true);
eq('a different port does not match', proxyTargetsPort('http://127.0.0.1:7001', 7000), false);
eq('7000 does not match 70001', proxyTargetsPort('http://127.0.0.1:70001', 7000), false);
eq('an unparseable proxy is not a match', proxyTargetsPort('', 7000), false);
eq('a portless proxy is not a match', proxyTargetsPort('http://127.0.0.1/', 7000), false);

// A path-prefixed handler still identifies the front — the sub-path entries in
// LINUX_BOX:443 are why the search walks every handler, not just '/'.
eq('a non-root handler still matches its port',
  findServeUrl({ Web: { 'h.ts.net:443': { Handlers: { '/api': { Proxy: 'http://127.0.0.1:8000/api' } } } } }, 8000),
  'https://h.ts.net:443/');

// ---- report -----------------------------------------------------------------

console.log(`\nserveUrl: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
