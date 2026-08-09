'use strict';
// Boots a throwaway termhub (its own ports, its own data dir) and drives the
// real web UI in a phone-emulated browser. This exists because every mobile bug
// termhub has ever had was reported as prose and fixed by guessing: "scrolling
// is weird", "the input bar disappears". A guess costs a round-trip to a real
// phone to disprove, so the numbers have to come from somewhere closer.
//
// What it CAN see: layout geometry (what is off-screen and by how much), the
// xterm viewport's scroll state, which renderer is live, whether a drag scrolls
// anything, what a selection returns, and every escape sequence the running
// agent actually emitted. Those cover the structural half of the bug reports.
//
// What it CANNOT see, and where a real device is still the only authority: the
// iOS soft keyboard (Chromium has no equivalent, so `visualViewport` never
// shrinks on its own — `simulateKeyboard()` below fakes the geometry, not the
// browser behaviour), Safari's clipboard permission prompt, `env(safe-area-*)`
// insets, and `-webkit-overflow-scrolling: touch` momentum. Treat a pass here as
// "the structural bug is gone", never as "verified on iOS".
//
// Usage:
//   node test/mobile/probe.js              # measure + report, changes nothing
//   node test/mobile/probe.js --keep       # leave the browser open
//   node test/mobile/probe.js --browser=webkit
//
// WebKit (much closer to iOS Safari than Chromium) needs one system package:
//   sudo apt-get install libavif16 && npx playwright install webkit

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');

// Ports deliberately far from the 7000/7010 a real deployment uses: server.js
// refuses to start when it would shadow one (see AGENT.md, "One process per
// port"), and shadowing it would take the user's live terminals down.
const PORT = Number(process.env.TERMHUB_MOBILE_PORT || 7180);
const SESSIOND_PORT = Number(process.env.TERMHUB_MOBILE_SESSIOND_PORT || 7190);

// Playwright is not a termhub dependency — the tool ships to phones and Windows
// boxes and has no business carrying a browser download. The harness resolves it
// from wherever it is installed and says so plainly when it isn't.
function requirePlaywright() {
  const tried = [];
  for (const spec of ['playwright', 'playwright-core', process.env.TERMHUB_PLAYWRIGHT || '']) {
    if (!spec) continue;
    try { return require(spec); } catch (e) { tried.push(spec); }
  }
  throw new Error(
    'playwright not found (tried: ' + tried.join(', ') + ').\n' +
    'Install it anywhere and point at it, e.g.\n' +
    '  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm install playwright\n' +
    '  TERMHUB_PLAYWRIGHT=/tmp/pw/node_modules/playwright node test/mobile/probe.js'
  );
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the server under test -------------------------------------------------

async function startServer(log) {
  // Its own data dir, so a probe run can never touch the real sessions.json /
  // attachments of the deployment on this machine.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-mobile-'));
  const env = {
    ...process.env,
    TERMHUB_PORT: String(PORT),
    TERMHUB_SESSIOND_PORT: String(SESSIOND_PORT),
    TERMHUB_BIND: '127.0.0.1',
    TERMHUB_DATA_DIR: dataDir,
    TERMHUB_NO_WATCHDOG_SETUP: '1',   // a probe must not install a supervisor
    TERMHUB_MACHINE: 'mobile-probe',
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  proc.stdout.on('data', (d) => { out.push(String(d)); if (log) process.stderr.write('  [termhub] ' + d); });
  proc.stderr.on('data', (d) => { out.push(String(d)); if (log) process.stderr.write('  [termhub] ' + d); });

  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (proc.exitCode != null) {
      throw new Error(`termhub exited with code ${proc.exitCode}:\n${out.join('')}`);
    }
    try { await getJson(`${base}/api/health`); break; } catch {}
    if (Date.now() > deadline) throw new Error(`termhub never became healthy:\n${out.join('')}`);
    await sleep(200);
  }
  return {
    base, proc, dataDir,
    async stop() {
      try { proc.kill('SIGTERM'); } catch {}
      await sleep(300);
      try { proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ---- the phone -------------------------------------------------------------

// Chromium is the fallback because it is the one that is already downloaded on
// most machines; WebKit is what iOS actually runs and is worth the extra
// system package when a rendering question is in play.
async function startBrowser(opts = {}) {
  const pw = requirePlaywright();
  const want = opts.browser || process.env.TERMHUB_MOBILE_BROWSER || 'chromium';
  const type = pw[want];
  if (!type) throw new Error(`unknown browser "${want}" (chromium | webkit | firefox)`);

  const device = pw.devices[opts.device || 'iPhone 15'];
  let browser;
  try {
    browser = await type.launch({ headless: opts.headless !== false });
  } catch (e) {
    if (want === 'webkit') {
      throw new Error(
        'WebKit could not launch — it needs a system package Playwright checks for:\n' +
        '  sudo apt-get install libavif16\n' +
        'Then re-run. Chromium (the default) needs nothing.\n\n' + e.message
      );
    }
    throw e;
  }

  // Drop defaultBrowserType: it names WebKit on every iPhone descriptor, which
  // Playwright rejects when the launched browser is Chromium.
  const { defaultBrowserType, ...ctxOpts } = device;
  const context = await browser.newContext({
    ...ctxOpts,
    // The real thing is reached over Tailscale Serve's HTTPS; a probe on plain
    // loopback would silently exercise the insecure-context fallbacks instead.
    permissions: opts.permissions || [],
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const console_ = [];
  page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => console_.push(`pageerror: ${e.message}`));
  return {
    browser, context, page, device, consoleLog: console_,
    async stop() { try { await browser.close(); } catch {} },
  };
}

// ---- driving the UI --------------------------------------------------------

// Create a session through the API rather than the dialog: the dialog is not
// what any of these bugs are about, and driving it adds a page of selectors
// that break for reasons unrelated to the thing being measured.
async function createSession(base, { cwd, command, title }) {
  const body = JSON.stringify({ cwd: cwd || os.homedir(), command: command || '', title: title || '', cols: 80, rows: 24 });
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(out);
          if (res.statusCode >= 400) reject(new Error(json.error || out));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Open a session in the page and wait until xterm has actually painted rows for
// it. Everything goes through `window.__termhub` (set at the end of app.js):
// app.js is a classic script, so its `function` declarations land on `window`
// but its `const state` does not — reaching for `window.state` yields undefined
// and the wait below then times out saying nothing useful.
async function openInPage(page, session) {
  await page.evaluate(({ id, title, kind }) => window.__termhub.openTerminal(id, title, kind),
    { id: session.id, title: session.title || '', kind: session.kind || 'shell' });
  // Wait for the socket to be OPEN, not merely for rows to exist. openTerminal()
  // defers connect() into a requestAnimationFrame, and headless WebKit does not
  // run rAF on the same schedule Chromium does — so `t.ws` was still null here
  // and every send in the probe threw. Waiting on the thing we actually need
  // makes the harness say the same thing on both engines.
  await page.waitForFunction(() => {
    const g = window.__termhub;
    const t = g && g.state.open.get(g.state.activeId);
    return !!(t && t.term && t.term.rows > 0 && t.pane.classList.contains('active')
      && t.ws && t.ws.readyState === 1);
  }, null, { timeout: 15000 });
}

// A one-finger vertical drag on the terminal, in the shape a phone produces:
// a touchstart, several touchmoves, a touchend. CDP's touchscreen.tap can't do
// a drag, so this drives the raw touch events.
async function dragVertical(page, { fromX, fromY, dy, steps = 12, holdMs = 0 }) {
  await page.touchscreen.tap(fromX, fromY).catch(() => {});
  return page.evaluate(async ({ fromX, fromY, dy, steps, holdMs }) => {
    const el = document.elementFromPoint(fromX, fromY);
    if (!el) return { error: 'no element at point' };

    // Two engines, two ways to mint a Touch, and neither has the other's.
    // WebKit has no `Touch` constructor at all (`new Touch()` throws "Illegal
    // constructor") and still wants the deprecated document.createTouch /
    // createTouchList pair; Chromium has the constructors and dropped
    // createTouch. Since the whole point of running WebKit is that it is the
    // engine iOS ships, the harness has to speak both.
    // Detect by *doing*, not by `typeof`: WebKit exposes a `Touch` global that
    // is a function and throws "Illegal constructor" when you call it, so a
    // feature test on the name alone reports support that isn't there.
    let useLegacy = false;
    try { new Touch({ identifier: 0, target: el, clientX: 0, clientY: 0 }); }
    catch { useLegacy = typeof document.createTouch === 'function'; }
    const mkTouch = (x, y) => (useLegacy
      ? document.createTouch(window, el, 1, x, y, x, y)
      : new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y }));
    const mkList = (arr) => (useLegacy ? document.createTouchList(...arr) : arr);

    const mk = (type, x, y) => {
      const touch = mkTouch(x, y);
      const ended = type === 'touchend';
      if (typeof TouchEvent === 'function') {
        try {
          return new TouchEvent(type, {
            touches: mkList(ended ? [] : [touch]),
            targetTouches: mkList(ended ? [] : [touch]),
            changedTouches: mkList([touch]),
            bubbles: true, cancelable: true, composed: true,
          });
        } catch { /* older WebKit: fall through to initTouchEvent below */ }
      }
      const ev = document.createEvent('TouchEvent');
      ev.initTouchEvent(type, true, true, window, 0, x, y, x, y, false, false, false, false,
        mkList(ended ? [] : [touch]), mkList(ended ? [] : [touch]), mkList([touch]), 1, 0);
      return ev;
    };
    el.dispatchEvent(mk('touchstart', fromX, fromY));
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    for (let i = 1; i <= steps; i++) {
      const y = fromY + (dy * i) / steps;
      el.dispatchEvent(mk('touchmove', fromX, y));
      await new Promise((r) => requestAnimationFrame(r));
    }
    el.dispatchEvent(mk('touchend', fromX, fromY + dy));
    return { ok: true, target: el.className || el.tagName };
  }, { fromX, fromY, dy, steps, holdMs });
}

// Fake the iOS soft keyboard. Chromium never shrinks visualViewport on focus
// (it has no on-screen keyboard), so the geometry half of that bug is invisible
// unless it is staged: shrink the reported visual viewport and fire the events
// iOS fires. This reproduces what the LAYOUT does, not what Safari does.
async function simulateKeyboard(page, keyboardHeight = 336) {
  return page.evaluate((kh) => {
    const vv = window.visualViewport;
    if (!vv) return { error: 'no visualViewport' };
    if (!window.__realVVHeight) window.__realVVHeight = vv.height;
    const shrunk = window.__realVVHeight - kh;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => shrunk });
    vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
    return { was: window.__realVVHeight, now: shrunk };
  }, keyboardHeight);
}

async function hideKeyboard(page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    if (!vv || !window.__realVVHeight) return { error: 'not simulated' };
    const real = window.__realVVHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => real });
    vv.dispatchEvent(new Event('resize'));
    return { now: real };
  });
}

module.exports = {
  ROOT, PORT, SESSIOND_PORT,
  startServer, startBrowser, createSession, openInPage,
  dragVertical, simulateKeyboard, hideKeyboard, getJson, sleep,
};
