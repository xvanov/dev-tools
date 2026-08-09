'use strict';
// Measure termhub's mobile UI against a phone-shaped browser and print what it
// finds. Changes nothing, asserts nothing — the counterpart to
// `watchdog/watchdog.sh --probe`: a diagnosis you can read, not a pass/fail.
//
//   node test/mobile/probe.js
//   node test/mobile/probe.js --agent=claude      # measure a live Claude session
//   node test/mobile/probe.js --agent=opencode
//   node test/mobile/probe.js --browser=webkit --headed --keep
//
// See harness.js for what this can and cannot see. Screenshots land in
// test/mobile/out/.

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const AGENT = arg('agent', 'shell');
const OUT = path.join(__dirname, 'out');

const R = { checks: [] };
function say(label, value, note) {
  R.checks.push({ label, value, note });
  const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
  console.log(`  ${label.padEnd(34)} ${v}${note ? '   ← ' + note : ''}`);
}
function head(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

// Everything the page can tell us about how the app is currently laid out.
// Collected in one evaluate so the numbers are all from the same frame.
const GEOMETRY = () => {
  const g = window.__termhub;
  const t = g.state.open.get(g.state.activeId);
  const vv = window.visualViewport;
  const r = (el) => { const b = el && el.getBoundingClientRect(); return b ? { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), h: +b.height.toFixed(1) } : null; };
  const pane = t && t.pane;
  const viewport = pane && pane.querySelector('.xterm-viewport');
  const screen = pane && pane.querySelector('.xterm-screen');
  const css = getComputedStyle(document.documentElement);
  return {
    innerHeight: window.innerHeight,
    visualViewportHeight: vv ? +vv.height.toFixed(1) : null,
    vvhVar: css.getPropertyValue('--vvh').trim(),
    chromeHVar: css.getPropertyValue('--chrome-h').trim(),
    appRect: r(document.querySelector('#app')),
    terminalsRect: r(document.querySelector('#terminals')),
    paneRect: r(pane),
    keybarRect: r(document.querySelector('#keybar')),
    screenRect: r(screen),
    rows: t ? t.term.rows : null,
    cols: t ? t.term.cols : null,
    renderer: pane ? (pane.querySelector('canvas') ? 'canvas/webgl' : 'dom') : null,
    viewport: viewport ? {
      scrollTop: Math.round(viewport.scrollTop),
      scrollHeight: Math.round(viewport.scrollHeight),
      clientHeight: Math.round(viewport.clientHeight),
      scrollable: viewport.scrollHeight - viewport.clientHeight,
    } : null,
    bufferType: t ? t.term.buffer.active.type : null,
    bufferLength: t ? t.term.buffer.active.length : null,
    baseY: t ? t.term.buffer.active.baseY : null,
    viewportY: t ? t.term.buffer.active.viewportY : null,
    mouseTracking: t && t.term.modes ? t.term.modes.mouseTrackingMode : null,
    appWantsMouse: t ? g.appWantsMouse(t) : null,
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`termhub mobile probe — agent=${AGENT} browser=${arg('browser', 'chromium')}`);

  const server = await H.startServer(flag('verbose'));
  let phone;
  try {
    phone = await H.startBrowser({
      browser: arg('browser', 'chromium'),
      headless: !flag('headed'),
    });
    const { page } = phone;

    head('device');
    say('viewport', `${phone.device.viewport.width}x${phone.device.viewport.height}`);
    say('dpr / touch', `${phone.device.deviceScaleFactor} / ${phone.device.hasTouch}`);

    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => !!window.__termhub, null, { timeout: 10000 });
    } catch (e) {
      console.error('\nthe page never finished booting app.js.');
      console.error('console:', phone.consoleLog.slice(0, 10));
      console.error('scripts:', await page.evaluate(() =>
        [...document.scripts].map((s) => s.src || '(inline)')).catch(() => '?'));
      throw e;
    }

    // A session with real scrollback in it, so "can I scroll?" has an answer.
    // `seq` is in coreutils everywhere this runs.
    const command = AGENT === 'shell' ? '' : AGENT;
    const session = await H.createSession(server.base, { command, title: `probe-${AGENT}` });
    await H.openInPage(page, session);

    if (AGENT === 'shell') {
      await page.evaluate((id) => {
        const t = window.__termhub.state.open.get(id);
        t.ws.send(JSON.stringify({ type: 'input', data: 'seq 1 300\r' }));
      }, session.id);
      await H.sleep(1500);
    } else {
      // Agents paint a banner and a prompt box; give the TUI time to settle.
      await H.sleep(9000);
    }

    head(`layout — ${AGENT} session, keyboard closed`);
    const g0 = await page.evaluate(GEOMETRY);
    say('xterm rows x cols', `${g0.rows} x ${g0.cols}`);
    say('renderer', g0.renderer);
    say('buffer type', g0.bufferType, g0.bufferType === 'alternate' ? 'no scrollback of its own' : 'has scrollback');
    say('mouse tracking', g0.mouseTracking, g0.appWantsMouse ? 'termhub forwards drags as wheel' : 'xterm native touch scroll');
    say('window.innerHeight', g0.innerHeight);
    say('visualViewport.height', g0.visualViewportHeight);
    say('--vvh', g0.vvhVar);
    say('#app rect', g0.appRect);
    say('#keybar rect', g0.keybarRect);
    say('.xterm-screen rect', g0.screenRect);
    const overflow = g0.screenRect && g0.keybarRect ? +(g0.screenRect.bottom - g0.keybarRect.top).toFixed(1) : null;
    say('screen bottom vs keybar top', overflow,
      overflow > 1 ? `${overflow}px of terminal is UNDER the key bar` : 'clear');
    say('xterm viewport scroll', g0.viewport);
    say('buffer len / baseY / viewportY', `${g0.bufferLength} / ${g0.baseY} / ${g0.viewportY}`);

    await page.screenshot({ path: path.join(OUT, `${AGENT}-1-idle.png`) });

    head('scroll — one upward drag in the middle of the terminal');
    const mid = { x: Math.round(phone.device.viewport.width / 2), y: Math.round((g0.paneRect.top + g0.paneRect.bottom) / 2) };
    const before = await page.evaluate(GEOMETRY);
    await H.dragVertical(page, { fromX: mid.x, fromY: mid.y, dy: 220 });  // finger down = scroll back
    await H.sleep(600);
    const after = await page.evaluate(GEOMETRY);
    say('drag from', `${mid.x},${mid.y}  dy=+220 (toward older output)`);
    say('viewportY before → after', `${before.viewportY} → ${after.viewportY}`,
      before.viewportY === after.viewportY ? 'DID NOT SCROLL' : 'scrolled');
    say('viewport.scrollTop before → after',
      `${before.viewport ? before.viewport.scrollTop : '-'} → ${after.viewport ? after.viewport.scrollTop : '-'}`);
    await page.screenshot({ path: path.join(OUT, `${AGENT}-2-after-drag.png`) });

    head('selection — can a long-press drag select terminal text?');
    const sel = await page.evaluate(async ({ x, y }) => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      const before = { dom: String(window.getSelection()), xterm: t.term.getSelection() };
      return { before, hasSelectionApi: typeof t.term.getSelection === 'function' };
    }, mid);
    // A real long-press-drag: hold, then move. This is the gesture iOS uses to
    // start a selection, and it is the one termhub has never handled.
    await H.dragVertical(page, { fromX: mid.x, fromY: mid.y, dy: 40, holdMs: 700, steps: 8 });
    await H.sleep(400);
    const sel2 = await page.evaluate(() => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      return {
        domSelection: String(window.getSelection()).slice(0, 60),
        xtermSelection: t.term.getSelection().slice(0, 60),
        hasSelection: t.term.hasSelection(),
      };
    });
    say('term.getSelection() exists', sel.hasSelectionApi);
    say('after long-press drag: xterm sel', JSON.stringify(sel2.xtermSelection),
      sel2.hasSelection ? 'selected' : 'NOTHING SELECTED');
    say('after long-press drag: DOM sel', JSON.stringify(sel2.domSelection));
    say('copy affordance in DOM', await page.evaluate(() =>
      !!document.querySelector('#copy-key, [data-key="copy"], #select-key')), 'is there a way to copy at all?');

    head('paste — is there a way in, and does it need a secure context?');
    say('isSecureContext', await page.evaluate(() => window.isSecureContext));
    say('navigator.clipboard', await page.evaluate(() => !!(navigator.clipboard && navigator.clipboard.readText)));
    say('#paste-key present', await page.evaluate(() => !!document.querySelector('#paste-key')));
    say('#paste-key visible', await page.evaluate(() => {
      const el = document.querySelector('#paste-key');
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.right <= window.innerWidth + 1 && b.left >= -1;
    }), 'off-screen = might as well not exist');

    head('soft keyboard — staged, not real (see harness.js)');
    const kb = await H.simulateKeyboard(page, 336);
    say('visualViewport shrunk', `${kb.was} → ${kb.now}`);
    await H.sleep(500);
    const g1 = await page.evaluate(GEOMETRY);
    say('--vvh now', g1.vvhVar);
    say('xterm rows now', `${g0.rows} → ${g1.rows}`, g1.rows === g0.rows ? 'DID NOT REFIT' : 'refit');
    say('#keybar rect', g1.keybarRect);
    say('keybar bottom vs viewport', `${g1.keybarRect.bottom} vs ${kb.now}`,
      g1.keybarRect.bottom > kb.now + 1 ? 'KEY BAR IS UNDER THE KEYBOARD' : 'visible');
    const over1 = +(g1.screenRect.bottom - g1.keybarRect.top).toFixed(1);
    say('screen bottom vs keybar top', over1, over1 > 1 ? `${over1}px hidden` : 'clear');
    await page.screenshot({ path: path.join(OUT, `${AGENT}-3-keyboard.png`) });
    await H.hideKeyboard(page);
    await H.sleep(400);

    head('console');
    const errs = phone.consoleLog.filter((l) => /^(error|pageerror)/.test(l));
    say('page errors', errs.length, errs.length ? errs.slice(0, 3).join(' | ') : 'none');

    console.log(`\nscreenshots → ${OUT}`);
    if (flag('keep')) {
      console.log('--keep: leaving the browser and server up. Ctrl-C to stop.');
      await new Promise(() => {});
    }
  } finally {
    if (!flag('keep')) {
      if (phone) await phone.stop();
      await server.stop();
    }
  }
})().catch((e) => { console.error('\nprobe failed:', e.message); process.exit(1); });
