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

// "Present in the DOM" is not the same as "the user can hit it". A key parked
// past the right edge of a horizontally-scrolling group is in the DOM, has a
// non-zero size, and may as well not exist — which is exactly what was wrong
// with ⌨. So clip against every scrollable ancestor, not just the window.
const REACHABLE = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const b = el.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return false;
  let box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (!/auto|scroll|hidden/.test(cs.overflowX + cs.overflowY)) continue;
    const pb = p.getBoundingClientRect();
    box = {
      left: Math.max(box.left, pb.left), top: Math.max(box.top, pb.top),
      right: Math.min(box.right, pb.right), bottom: Math.min(box.bottom, pb.bottom),
    };
  }
  // Require most of the control to be inside every clip, not just a sliver.
  const vw = Math.min(b.right, box.right) - Math.max(b.left, box.left);
  const vh = Math.min(b.bottom, box.bottom) - Math.max(b.top, box.top);
  return vw >= b.width * 0.9 && vh >= b.height * 0.9;
};

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
    say('scroll regime', await page.evaluate(() => {
      const g = window.__termhub;
      return g.scrollMode(g.state.open.get(g.state.activeId));
    }), 'wheel = forward to the app | arrows = alt-screen | lines = xterm scrollback');
    say('drag from', `${mid.x},${mid.y}  dy=+220 (toward older output)`);
    say('viewportY before → after', `${before.viewportY} → ${after.viewportY}`,
      before.viewportY === after.viewportY ? 'DID NOT SCROLL' : 'scrolled');
    say('viewport.scrollTop before → after',
      `${before.viewport ? before.viewport.scrollTop : '-'} → ${after.viewport ? after.viewport.scrollTop : '-'}`);
    say('#scroll-bottom offered', await page.evaluate(() => {
      const el = document.querySelector('#scroll-bottom');
      return !!el && !el.classList.contains('hidden');
    }), before.viewportY !== after.viewportY ? 'should be true once scrolled up' : '');
    await page.screenshot({ path: path.join(OUT, `${AGENT}-2-after-drag.png`) });

    // Scrolling up is only half the complaint; "I can't get to the very bottom"
    // is the other half, and it is the one with no gesture that reliably works.
    if (after.viewportY !== after.baseY) {
      await page.evaluate(() => window.__termhub.jumpToBottom());
      await H.sleep(300);
      const back = await page.evaluate(GEOMETRY);
      say('jump to bottom', `viewportY ${after.viewportY} → ${back.viewportY} (baseY ${back.baseY})`,
        back.viewportY === back.baseY ? 'at the bottom' : 'STILL NOT AT THE BOTTOM');
    }

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
    say('in-place long-press drag', JSON.stringify(sel2.xtermSelection),
      sel2.hasSelection ? 'selected' : 'nothing — expected, there is no DOM text');

    head('copy sheet — the affordance that replaces in-place selection');
    say('#copy-key reachable', await page.evaluate(REACHABLE, '#copy-key'), 'present AND inside the viewport');
    await page.evaluate(() => window.__termhub.openCopySheet());
    await H.sleep(300);
    const copy = await page.evaluate(() => {
      const pre = document.querySelector('#copy-text');
      const cs = getComputedStyle(pre);
      return {
        open: !document.querySelector('#copy-backdrop').classList.contains('hidden'),
        chars: pre.textContent.length,
        lines: pre.textContent ? pre.textContent.split('\n').length : 0,
        userSelect: cs.userSelect + '/' + cs.webkitUserSelect,
        firstLine: pre.textContent.split('\n')[0].slice(0, 46),
        lastLine: pre.textContent.trimEnd().split('\n').pop().slice(0, 46),
        scrolledToEnd: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 2,
      };
    });
    say('sheet open', copy.open);
    say('selectable text in the DOM', `${copy.chars} chars / ${copy.lines} lines`,
      copy.chars > 0 ? 'real text a long-press can grab' : 'EMPTY');
    say('user-select', copy.userSelect, copy.userSelect.startsWith('text') ? 'selection allowed' : 'STILL BLOCKED');
    say('first / last line', `${JSON.stringify(copy.firstLine)} … ${JSON.stringify(copy.lastLine)}`);
    say('opens at the newest output', copy.scrolledToEnd);
    // Full scrollback is the other half of the sheet's job.
    await page.evaluate(() => { document.querySelector('#copy-scope-all').click(); });
    await H.sleep(200);
    const copyAllScope = await page.evaluate(() => document.querySelector('#copy-text').textContent);
    say('scope=all vs scope=screen', `${copyAllScope.split('\n').length} lines vs ${copy.lines}`,
      copyAllScope.split('\n').length >= copy.lines ? 'scrollback included' : 'NO EXTRA SCROLLBACK');
    await page.screenshot({ path: path.join(OUT, `${AGENT}-4-copy-sheet.png`) });
    await page.evaluate(() => window.__termhub.closeCopySheet());

    head('paste — is there a way in, and does multi-line survive it?');
    say('isSecureContext', await page.evaluate(() => window.isSecureContext));
    say('navigator.clipboard', await page.evaluate(() => !!(navigator.clipboard && navigator.clipboard.readText)));
    say('#paste-key reachable', await page.evaluate(REACHABLE, '#paste-key'), 'off-screen = might as well not exist');
    // What actually goes down the wire for a three-line paste. Raw newlines are
    // read by a TUI as three separate Enters, which is the bug.
    const wire = await page.evaluate(() => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      const sent = [];
      const real = t.ws.send.bind(t.ws);
      t.ws.send = (d) => { sent.push(JSON.parse(d)); };
      // `modes` is a getter that rebuilds its object each read, so assigning to
      // t.term.modes.bracketedPasteMode does nothing at all — stage the getter.
      const probe = (bracketed) => {
        Object.defineProperty(t.term, 'modes', {
          configurable: true, get: () => ({ bracketedPasteMode: bracketed }),
        });
        g.pasteInto(t, 'line one\nline two\nline three');
      };
      probe(false); const plain = sent.pop().data;
      probe(true); const brack = sent.pop().data;
      t.ws.send = real;
      return { plain, brack };
    });
    say('no bracketed-paste support', JSON.stringify(wire.plain),
      wire.plain.includes('\n') ? 'RAW \\n — would submit per line' : 'newlines are CR');
    say('bracketed paste (Claude/opencode)', JSON.stringify(wire.brack).slice(0, 70),
      wire.brack.startsWith('\x1b[200~') && wire.brack.endsWith('\x1b[201~')
        ? 'wrapped — lands as ONE paste' : 'NOT WRAPPED');

    head('keyboard key — the one that was off-screen');
    say('#kbd-key reachable', await page.evaluate(REACHABLE, '#kbd-key'), 'was inside the scrolling group, i.e. off the right edge');
    say('tap on terminal focuses xterm', await page.evaluate(async ({ x, y }) => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      document.activeElement.blur();
      g.focusTerminal(t);
      await new Promise((r) => setTimeout(r, 120));
      const ta = t.pane.querySelector('.xterm-helper-textarea');
      return document.activeElement === ta;
    }, mid), 'the hidden textarea is what summons the iOS keyboard');

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
