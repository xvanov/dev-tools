'use strict';
// The 🎤 button end to end on an emulated phone: record -> /api/transcribe ->
// typed into the session. Not part of `npm test` (it needs Playwright and a
// Chromium download); run it by hand:
//
//   TERMHUB_PLAYWRIGHT=/path/to/node_modules/playwright-core node test/mobile/voice.e2e.js
//
// What is real: the termhub front + sessiond (a throwaway one on ports
// 7280/7290 with its own data dir — never the live :7000), the page's capture
// code (getUserMedia -> AudioWorklet -> resample -> VAD -> WAV), the upload,
// the CSRF guard, the PTY. What is fake: the microphone (Chromium's fake
// device playing a generated WAV: a tone burst between silences, which an
// energy VAD can't tell from speech) and the whisper server (a TCP server
// speaking transcribe_server.py's protocol that answers a fixed sentence for
// any WAV that really is one). iPhone device emulation is Chromium with a
// phone's viewport, touch and UA — not WebKit, not iOS audio.
//
// Checks: push-to-talk (hold, release -> sent), hands-free (tap -> VAD ->
// draft -> sent after the silence window), the hidden page releasing the mic
// and asking for a tap, another tab taking the mic (BroadcastChannel), the
// fall back to Web Speech on a 503, and the insecure-origin toast with the
// HTTPS link.

process.env.TERMHUB_MOBILE_PORT = process.env.TERMHUB_MOBILE_PORT || '7280';
process.env.TERMHUB_MOBILE_SESSIOND_PORT = process.env.TERMHUB_MOBILE_SESSIOND_PORT || '7290';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const H = require('./harness');
const VC = require('../../web/voiceCapture');

const SENTENCE = 'run the unit tests';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// A WAV Chromium loops as the microphone: 1 s quiet, 1.2 s of a voiced-ish
// tone, 7 s quiet (longer than the 4 s send window, or hands-free would keep
// holding the draft for the next "sentence"). 48 kHz, like a phone.
function fakeMicWav(file) {
  const rate = 48000;
  const seg = (s) => Math.round(s * rate);
  const n = seg(1) + seg(1.2) + seg(7);
  const x = new Float32Array(n);
  for (let i = seg(1); i < seg(2.2); i++) {
    const t = i / rate;
    x[i] = 0.25 * Math.sin(2 * Math.PI * 180 * t) + 0.12 * Math.sin(2 * Math.PI * 360 * t) + 0.06 * Math.sin(2 * Math.PI * 720 * t);
  }
  fs.writeFileSync(file, Buffer.from(VC.encodeWav(x, rate)));
}

function fakeWhisper() {
  const calls = [];
  const server = net.createServer((sock) => {
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => {
      const file = data.trim();
      if (!file) return sock.end();
      let ok = false;
      let seconds = 0;
      try {
        const b = fs.readFileSync(file);
        ok = b.toString('ascii', 0, 4) === 'RIFF' && b.readUInt32LE(24) === 16000 && b.readUInt16LE(22) === 1;
        seconds = (b.length - 44) / 32000;
      } catch {}
      calls.push({ ok, seconds });
      sock.end(ok ? ` ${SENTENCE[0].toUpperCase()}${SENTENCE.slice(1)}. ` : 'ERROR: not a 16 kHz mono WAV');
    });
    sock.on('error', () => {});
  });
  return { server, calls };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-voice-e2e-'));
  const micFile = path.join(tmp, 'mic.wav');
  fakeMicWav(micFile);
  const whisper = fakeWhisper();
  const whisperPort = await listen(whisper.server);

  const srv = await H.startServer(!!process.env.VERBOSE, {
    TERMHUB_TRANSCRIBE_PORT: String(whisperPort),
    TERMHUB_TRANSCRIBE_PEER: 'off',
    // A second name for the same loopback server, reachable over plain HTTP
    // as a NON-secure origin (see the insecure check below).
    TERMHUB_ALLOWED_HOSTS: 'termhub-insecure.test',
    TERMHUB_PA_URL: '',
  });
  let br = null;
  try {
    br = await H.startBrowser({
      device: 'iPhone 13',
      permissions: ['microphone'],
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${micFile}`,
        '--autoplay-policy=no-user-gesture-required',
        '--host-resolver-rules=MAP termhub-insecure.test 127.0.0.1',
      ],
    });
    const { page } = br;
    const uploads = [];
    page.on('response', (r) => { if (r.url().endsWith('/api/transcribe') && r.request().method() === 'POST') uploads.push(r.status()); });

    // A session that prints what it receives, so "typed AND submitted" is visible.
    const echoJs = path.join(tmp, 'echo.js');
    fs.writeFileSync(echoJs, 'process.stdin.on("data", (d) => process.stdout.write("GOT:" + String(d).trim() + "\\n"));\n');
    const session = await H.createSession(srv.base, { command: `node '${echoJs}'`, title: 'echo' });
    await page.goto(srv.base + '/');
    await H.openInPage(page, session);
    const st = await page.evaluate(() => fetch('/api/transcribe').then((r) => r.json()));
    check('GET /api/transcribe says local whisper', st.available && st.backend === 'local', JSON.stringify(st));
    await page.waitForFunction(() => window.__termhub.stt.server === true, null, { timeout: 5000 });

    const gotCount = () => page.evaluate(() => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      const buf = t.term.buffer.active;
      let n = 0;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes('GOT:')) n += 1;
      }
      return n;
    });
    const lastGot = () => page.evaluate(() => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      const buf = t.term.buffer.active;
      let last = '';
      for (let i = 0; i < buf.length; i++) {
        const s = buf.getLine(i) && buf.getLine(i).translateToString(true);
        if (s && s.includes('GOT:')) last = s.trim();
      }
      return last;
    });
    const mic = await page.locator('#mic-key').boundingBox();
    const cx = mic.x + mic.width / 2;
    const cy = mic.y + mic.height / 2;

    // ---- push-to-talk: hold across the tone burst, release ----------------------
    const before = await gotCount();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await H.sleep(600);
    const holding = await page.evaluate(() => ({
      ptt: window.__termhub.stt.ptt, cap: !!window.__termhub.stt.cap, status: document.querySelector('#voice-status').textContent,
    }));
    check('hold 🎤 opens the mic in push-to-talk', holding.ptt && holding.cap, JSON.stringify(holding));
    await H.sleep(3000);   // past the burst (1 s quiet, 1.2 s tone) and into the quiet
    await page.mouse.up();
    await page.waitForFunction((n) => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      const buf = t.term.buffer.active;
      let c = 0;
      for (let i = 0; i < buf.length; i++) { const l = buf.getLine(i); if (l && l.translateToString(true).includes('GOT:')) c += 1; }
      return c > n;
    }, before, { timeout: 15000 }).catch(() => {});
    const got1 = await lastGot();
    check('release sends: transcript typed + Enter in the session', got1.includes(`GOT:${SENTENCE[0].toUpperCase()}${SENTENCE.slice(1)}.`), got1);
    const afterPtt = await page.evaluate(() => ({ cap: !!window.__termhub.stt.cap, want: window.__termhub.rec.want }));
    check('mic released after push-to-talk', !afterPtt.cap && !afterPtt.want, JSON.stringify(afterPtt));
    const via = whisper.calls[whisper.calls.length - 1];
    check('whisper got a 16 kHz mono WAV of the hold', via && via.ok && via.seconds > 2.5, via && `${via.seconds.toFixed(2)} s`);
    check('upload passed the CSRF guard (200)', uploads[0] === 200, `statuses ${uploads.join(',')}`);

    // ---- hands-free: tap, the VAD ends the burst, the draft goes after 4 s ---------------
    const callsBefore = whisper.calls.length;
    const before2 = await gotCount();
    await page.mouse.click(cx, cy);
    await H.sleep(300);
    const hf = await page.evaluate(() => ({ mode: window.__termhub.stt.mode, cap: !!window.__termhub.stt.cap, want: window.__termhub.rec.want }));
    check('tap 🎤 starts hands-free', hf.mode === 'handsfree' && hf.cap && hf.want, JSON.stringify(hf));
    const wake = await page.evaluate(() => !!navigator.wakeLock);
    await page.waitForFunction((n) => {
      const g = window.__termhub;
      const t = g.state.open.get(g.state.activeId);
      const buf = t.term.buffer.active;
      let c = 0;
      for (let i = 0; i < buf.length; i++) { const l = buf.getLine(i); if (l && l.translateToString(true).includes('GOT:')) c += 1; }
      return c > n;
    }, before2, { timeout: 20000 }).catch(() => {});
    const got2 = await gotCount();
    const hfCalls = whisper.calls.slice(callsBefore);
    check('hands-free: VAD cut an utterance and it was sent', got2 > before2 && hfCalls.length >= 1,
      `utterances ${hfCalls.map((c) => c.seconds.toFixed(2) + 's').join(',')}`);
    check('hands-free utterance is the burst, not the whole loop', hfCalls.length && hfCalls[0].seconds > 1.0 && hfCalls[0].seconds < 3.2,
      hfCalls.length ? `${hfCalls[0].seconds.toFixed(2)} s` : 'none');
    check('Screen Wake Lock API present (requested while listening)', wake, wake ? '' : 'navigator.wakeLock missing in this browser');

    // ---- the page goes to the background: mic released, "tap to resume" -------------------
    // Make sure the mic is closed, then open it hands-free.
    if (await page.evaluate(() => window.__termhub.rec.want)) { await page.mouse.click(cx, cy); await H.sleep(800); }
    await page.mouse.click(cx, cy);
    await H.sleep(800);
    const reopened = await page.evaluate(() => !!window.__termhub.stt.cap);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await page.evaluate(() => ({ cap: !!window.__termhub.stt.cap, want: window.__termhub.rec.want }));
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const toastText = await page.evaluate(() => document.querySelector('#toasts').textContent);
    check('hidden page releases the mic', reopened && !hidden.cap && !hidden.want, JSON.stringify({ reopened, ...hidden }));
    check('back in front: "tap 🎤 to resume"', /tap 🎤 to resume/.test(toastText), toastText.slice(0, 120));

    // ---- another tab takes the mic -----------------------------------------------------------
    await page.mouse.click(cx, cy);
    await H.sleep(800);
    const other = await br.context.newPage();
    await other.goto(srv.base + '/dashboard');
    await other.evaluate(() => new BroadcastChannel('voice-mic').postMessage({ type: 'claim', owner: 'pa-talk-test', app: 'the PA talk page' }));
    await H.sleep(400);
    const taken = await page.evaluate(() => ({
      cap: !!window.__termhub.stt.cap, want: window.__termhub.rec.want, toasts: document.querySelector('#toasts').textContent,
    }));
    check('another tab claiming the mic releases it here', !taken.cap && !taken.want && /PA talk page/.test(taken.toasts), taken.toasts.slice(-90));
    await other.close();

    // ---- no whisper anymore: 503 -> Web Speech fallback ----------------------------------------
    await new Promise((r) => whisper.server.close(r));
    await H.sleep(10500);                    // the server's local-probe cache
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await H.sleep(3000);   // across the burst
    await page.mouse.up();
    await page.waitForFunction(() => window.__termhub.stt.server === false, null, { timeout: 8000 }).catch(() => {});
    const fb = await page.evaluate(() => ({ server: window.__termhub.stt.server, toasts: document.querySelector('#toasts').textContent }));
    check('503 from /api/transcribe falls back to the browser recogniser', fb.server === false && /browser's speech recognition/.test(fb.toasts), fb.toasts.slice(-160));
    check('a 503 was what the page got', uploads.includes(503), `statuses ${uploads.join(',')}`);

    // ---- an insecure origin: toast with the HTTPS link ---------------------------------------
    const ins = await br.context.newPage();
    await ins.route('**/api/secure-url', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ secureUrl: 'https://mobile-probe.example.ts.net:7443/' }) }));
    await ins.goto(`http://termhub-insecure.test:${H.PORT}/`);
    await H.openInPage(ins, session);
    const secure = await ins.evaluate(() => window.isSecureContext);
    await ins.click('#mic-key');
    await H.sleep(300);
    const link = await ins.evaluate(() => { const a = document.querySelector('#toasts a.toast-link'); return a ? a.href : null; });
    check('insecure origin: toast links the HTTPS address', secure === false && link === 'https://mobile-probe.example.ts.net:7443/', `secure=${secure} link=${link}`);

    const errs = br.consoleLog.filter((l) => /pageerror/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    if (br) await br.stop();
    await srv.stop();
    try { whisper.server.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
