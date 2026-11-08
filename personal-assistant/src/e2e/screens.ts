'use strict';

// Screenshots of each view for `pa e2e <workflow>` (plan 8.2), without a
// browser-automation dependency: a headless Chromium driven over the DevTools
// protocol (its own --remote-debugging-port and the runtime's WebSocket). The
// browser is the first one found among: PA_E2E_BROWSER, the Chromium headless
// shell Playwright installed (ms-playwright), Edge, Chrome. None found:
// screenshots are skipped and the run says so; nothing fails.
//
// A page is shot once its data is in (8.4.11: a shot at load shows an empty
// board): the page's own "loaded" signal (READY, by view) is true and the
// network has been quiet for a moment, or the wait budget is spent (the shot
// is then marked ready: false). The page's text is kept next to the PNG.
// Where the DevTools protocol cannot be reached, the shell's plain
// --screenshot is the fallback (at load, ready: false).
//
// Every shot settles (8.4.40): each DevTools call has its own deadline and a
// call on a closed socket fails at once (a WebSocket drops it silently, and
// the promise would never settle), and the browser is killed, with its
// children, at the shot's deadline or settles the shot when it exits.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Shot = { ok: true; file: string; text: string | null; ready: boolean; waitedMs: number; how: string } | { ok: false; error: string; timedOut?: boolean };
type ShotOptions = { width?: number; height?: number; budgetMs?: number; settleMs?: number; quietMs?: number; timeoutMs?: number };
type Page = { name: string; url: string; ready?: string | null; settleMs?: number };
type Captured = { view: string; url: string; file: string | null; text?: string | null; ready?: boolean; waitedMs?: number; how?: string; error?: string };
/** The few DevTools calls this module makes; tests hand over a fake. */
type Cdp = { send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>; on(fn: (method: string, params: Record<string, unknown>) => void): void; close(): void };
type Clock = { now(): number; sleep(ms: number): Promise<void> };

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Each view's "my data is in" signal, from the page's own markup.
// Plan and Build: #updated says "loading…" until the first answer (then the time or an error).
// Ask: #chat-log holds "loading…" until the conversation is read. Run (termhub): the
// empty state is hidden once a session is open, and the session list is filled.
const LOADED = "(() => { const u = document.getElementById('updated'); return !!u && !/loading/i.test(u.textContent || ''); })()";
const READY: Record<string, string> = {
  plan: LOADED,
  build: LOADED,
  ask: "(() => { const l = document.getElementById('chat-log'); return !!l && !/^\\s*loading/i.test(l.textContent || ''); })()",
  run: "(() => { const e = document.getElementById('empty-state'); const s = document.getElementById('session-list'); return !!e && e.classList.contains('hidden') && !!s && s.children.length > 0; })()",
};
// A terminal replays its scrollback over a WebSocket after the page is ready.
const SETTLE: Record<string, number> = { run: 1500 };

/** Pure. The view kind a page name stands for: plan, build, ask, run (run-<session>), or null. */
function kindOf(name: string): string | null {
  const k = String(name || '').split('-')[0] as string;
  return k in READY ? k : null;
}

/** Pure. The ready expression for a page: its view's signal, and that its text shows `text` when given. */
function readyFor(name: string, text: string | null = null): string | null {
  const base = READY[kindOf(name) || ''] || null;
  const has = text ? `(document.body && document.body.innerText.includes(${JSON.stringify(text)}))` : null;
  return [base, has].filter(Boolean).join(' && ') || null;
}

/** Pure. DevToolsActivePort's contents → {port, path}, or null. */
function activePort(text: unknown): { port: number; path: string } | null {
  const [port, p] = String(text || '').split(/\r?\n/);
  return Number(port) > 0 && p ? { port: Number(port), path: p } : null;
}

function candidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const out: string[] = [];
  if (env.PA_E2E_BROWSER) out.push(env.PA_E2E_BROWSER);
  const pw = platform === 'win32'
    ? path.join(env.LOCALAPPDATA || '', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(pw).filter((d: string) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort().reverse(); } catch { /* none installed */ }
  for (const d of dirs) {
    if (platform === 'win32') {
      out.push(path.join(pw, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      out.push(path.join(pw, d, 'chrome-win', 'chrome.exe'));
      out.push(path.join(pw, d, 'chrome-win64', 'chrome.exe'));
    } else {
      out.push(path.join(pw, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      out.push(path.join(pw, d, 'chrome-linux', 'chrome'));
    }
  }
  if (platform === 'win32') {
    out.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    out.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  } else {
    out.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  }
  return out;
}

function browser(): string | null {
  return candidates().find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Loads `url` in the page behind `cdp`, waits until `ready` (a JS expression)
 * holds, the document is complete and the network has been quiet `quietMs`
 * (EventSource and WebSocket traffic, which never ends, not counted), or
 * until `budgetMs`; then waits `settleMs` and shoots. Never rejects on a
 * page that does not get ready: that shot says ready: false.
 */
async function drive(cdp: Cdp, url: string, { ready = null, width = 1440, height = 1000, budgetMs = 20_000, settleMs = 800, quietMs = 500 }: ShotOptions & { ready?: string | null } = {}, clock: Clock = realClock): Promise<{ png: Buffer; text: string | null; ready: boolean; waitedMs: number }> {
  let lastNet = clock.now();
  const live = new Set<string>();
  const inflight = new Set<string>();
  cdp.on((method, p) => {
    const id = String(p.requestId || '');
    if (method === 'Network.requestWillBeSent') {
      if (['EventSource', 'WebSocket'].includes(String(p.type || ''))) { live.add(id); return; }
      inflight.add(id);
      lastNet = clock.now();
    } else if (['Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method) && !live.has(id)) {
      if (method !== 'Network.responseReceived') inflight.delete(id);
      lastNet = clock.now();
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const t0 = clock.now();
  await cdp.send('Page.navigate', { url });
  const check = `(() => { try { return document.readyState === 'complete' && Boolean(${ready || 'true'}); } catch (e) { return false; } })()`;
  let ok = false;
  // A streamed response (a live fetch) stays in flight: after the budget's
  // first half, a quiet network is enough without it.
  while (clock.now() - t0 < budgetMs) {
    const r = await cdp.send('Runtime.evaluate', { expression: check, returnByValue: true }, Math.max(1000, Math.min(5000, budgetMs - (clock.now() - t0)))).catch(() => null);
    const quiet = clock.now() - lastNet >= quietMs && (inflight.size === 0 || clock.now() - t0 > budgetMs / 2);
    if ((r?.result as { value?: unknown } | undefined)?.value === true && quiet) { ok = true; break; }
    await clock.sleep(200);
  }
  const waitedMs = clock.now() - t0;
  await clock.sleep(settleMs);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const t = await cdp.send('Runtime.evaluate', { expression: "document.body ? document.body.innerText : ''", returnByValue: true }).catch(() => null);
  const text = (t?.result as { value?: unknown } | undefined)?.value;
  return { png: Buffer.from(String(shot.data || ''), 'base64'), text: typeof text === 'string' ? text : null, ready: ok, waitedMs };
}

/** A DevTools client on one target's WebSocket. Each call rejects after `callMs` (or its own `timeoutMs`), and at once when the socket is not open. */
function connect(wsUrl: string, timeoutMs = 10_000, { callMs = 15_000 }: { callMs?: number } = {}): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let n = 0;
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
    const timer = setTimeout(() => reject(new Error('DevTools WebSocket did not open')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}, ms = callMs) {
          if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`DevTools WebSocket closed before ${method}`));
          const id = ++n;
          return new Promise((res, rej) => {
            const t = setTimeout(() => { pending.delete(id); rej(new Error(`DevTools ${method}: no answer in ${ms} ms`)); }, ms);
            pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(fn) { listeners.push(fn); },
        close() { try { ws.close(); } catch { /* already closed */ } },
      });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id) as { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'DevTools error'));
        else p.resolve(m.result || {});
      } else if (m.method) {
        for (const fn of listeners) fn(m.method, m.params || {});
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools WebSocket error')); });
    ws.addEventListener('close', () => { for (const p of pending.values()) p.reject(new Error('DevTools WebSocket closed')); pending.clear(); });
  });
}

/** Kills a browser; on Windows its renderers too (`taskkill /T`); elsewhere they exit with it. */
function killTree(child: { pid?: number; kill(signal?: string): boolean }, platform: string = process.platform): void {
  if (platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { /* gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

/**
 * Settles with `work`, or with {ok:false} at `timeoutMs` or when `exited` does
 * (the browser died under it), whichever is first. The deadline's timer keeps
 * the process alive, so this settles even when `work` never does.
 */
function within(work: Promise<Shot>, timeoutMs: number, exited: Promise<string>): Promise<Shot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Shot>((r) => { timer = setTimeout(() => r({ ok: false, timedOut: true, error: `no screenshot within ${Math.round(timeoutMs / 1000)} s; the browser was killed` }), timeoutMs); });
  const died = exited.then((why): Shot => ({ ok: false, error: `the browser exited mid-shot (${why})` }));
  return Promise.race([work, deadline, died]).finally(() => clearTimeout(timer));
}

/** One page over the DevTools protocol. Resolves {ok, file, text, ready} or {ok:false, error} by `timeoutMs`; never rejects. */
async function shootCdp(exe: string, url: string, file: string, { ready = null, width = 1440, height = 1000, budgetMs = 20_000, settleMs = 800, timeoutMs = 60_000 }: ShotOptions & { ready?: string | null } = {}): Promise<Shot> {
  if (typeof WebSocket !== 'function') return { ok: false, error: 'no WebSocket in this runtime' };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-shot-'));
  const child = spawn(exe, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--remote-debugging-port=0', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise<string>((r) => {
    child.once('exit', (code: number | null, signal: string | null) => r(signal ? `signal ${signal}` : `code ${code}`));
    child.once('error', (err: Error) => r(err.message));
  });
  let cdp: Cdp | null = null;
  let browserWs: string | null = null;
  let over = false;
  const work = (async (): Promise<Shot> => {
    let port: { port: number; path: string } | null = null;
    for (let i = 0; i < 75 && !port && !over; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { port = activePort(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8')); } catch { /* not yet */ }
      if (child.exitCode != null) break;
    }
    if (!port) return { ok: false, error: 'the browser opened no DevTools port' };
    browserWs = `ws://127.0.0.1:${port.port}${port.path}`;
    const list = await (await fetch(`http://127.0.0.1:${port.port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) return { ok: false, error: 'the browser has no page to drive' };
    cdp = await connect(page.webSocketDebuggerUrl as string);
    const r = await drive(cdp, url, { ready, width, height, budgetMs, settleMs });
    if (!r.png.length) return { ok: false, error: 'the screenshot came back empty' };
    if (over) return { ok: false, error: 'past the deadline' };
    fs.writeFileSync(file, r.png);
    return { ok: true, file, text: r.text, ready: r.ready, waitedMs: r.waitedMs, how: 'devtools' };
  })().catch((err): Shot => ({ ok: false, error: ((err as Error)?.message || String(err)).slice(0, 200) }));
  let out: Shot | null = null;
  try {
    out = await within(work, timeoutMs, exited);
    return out;
  } finally {
    over = true;
    if (cdp) (cdp as Cdp).close();
    if (out && !out.ok && out.timedOut) killTree(child);
    else if (browserWs && child.exitCode == null) {
      const b = await connect(browserWs, 3000, { callMs: 2000 }).catch(() => null);
      if (b) {
        await b.send('Browser.close').catch(() => null);
        b.close();
      }
    }
    if (child.exitCode == null && child.signalCode == null) {
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode == null && child.signalCode == null) killTree(child);
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile is left in tmp */ }
  }
}

/** One page to a PNG by the shell's own --screenshot (at load). Resolves {ok, file} or {ok:false, error}; never rejects. */
// `--timeout` (not --virtual-time-budget): pages that hold a live feed or a
// voice model open never let virtual time settle, and the shell then hangs.
function shoot(exe: string, url: string, file: string, { width = 1440, height = 1000, budgetMs = 8000, timeoutMs = 60_000 }: ShotOptions = {}): Promise<Shot> {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-shot-'));
    const args = [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--timeout=${budgetMs}`,
      `--screenshot=${file}`, url,
    ];
    execFile(exe, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true }, (err: Error | null) => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile is left in tmp */ }
      const ok = fs.existsSync(file) && fs.statSync(file).size > 0;
      resolve(ok ? { ok: true, file, text: null, ready: false, waitedMs: 0, how: 'screenshot flag (at load)' } : { ok: false, error: err ? err.message.slice(0, 200) : 'no file written' });
    });
  });
}

/**
 * Each {name, url, ready?} to `<dir>/<name>.png` (and its text to `<name>.txt`). `ready` defaults to the view's own signal.
 * A page that times out over DevTools is not shot again at load: the same page would hold the fallback too.
 */
async function capture(dir: string, pages: Page[], { exe = browser(), timeoutMs = 60_000 }: { exe?: string | null; timeoutMs?: number } = {}): Promise<{ shots: Captured[]; note: string | null }> {
  if (!exe) return { shots: [], note: 'screenshots skipped: no headless Chromium found (set PA_E2E_BROWSER or `npx playwright install chromium`)' };
  fs.mkdirSync(dir, { recursive: true });
  const shots: Captured[] = [];
  for (const p of pages) {
    const file = path.join(dir, `${p.name}.png`);
    const settleMs = p.settleMs ?? SETTLE[kindOf(p.name) || ''] ?? 800;
    let r = await shootCdp(exe, p.url, file, { ready: p.ready !== undefined ? p.ready : readyFor(p.name), settleMs, timeoutMs });
    const devtools = r.ok ? null : r.error;
    if (!r.ok && !r.timedOut) r = await shoot(exe, p.url, file, { timeoutMs });
    if (r.ok) {
      let text: string | null = null;
      if (r.text != null) {
        const tf = path.join(dir, `${p.name}.txt`);
        fs.writeFileSync(tf, r.text.slice(0, 200_000));
        text = tf;
      }
      shots.push({ view: p.name, url: p.url, file: r.file, text, ready: r.ready, waitedMs: r.waitedMs, how: devtools ? `${r.how}; DevTools failed: ${devtools}` : r.how });
    } else shots.push({ view: p.name, url: p.url, file: null, error: devtools && devtools !== r.error ? `${r.error}; DevTools: ${devtools}` : r.error });
  }
  return { shots, note: null };
}

module.exports = { READY, kindOf, readyFor, activePort, drive, connect, within, candidates, browser, shoot, shootCdp, capture };
