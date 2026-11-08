'use strict';

// Screenshots of each view for `pa e2e <workflow>` (plan 8.2), without a
// browser-automation dependency: a headless Chromium's own `--screenshot`.
// The browser is the first one found among: PA_E2E_BROWSER, the Chromium
// headless shell Playwright installed (ms-playwright), Edge, Chrome. None
// found: screenshots are skipped and the run says so; nothing fails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function candidates(env = process.env, platform = process.platform) {
  const out = [];
  if (env.PA_E2E_BROWSER) out.push(env.PA_E2E_BROWSER);
  const pw = platform === 'win32'
    ? path.join(env.LOCALAPPDATA || '', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(pw).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort().reverse(); } catch { /* none installed */ }
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

function browser() {
  return candidates().find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}

/** One page to a PNG. Resolves {ok, file} or {ok:false, error}; never rejects. */
function shoot(exe, url, file, { width = 1440, height = 1000, budgetMs = 8000, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-shot-'));
    const args = [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--virtual-time-budget=${budgetMs}`,
      `--screenshot=${file}`, url,
    ];
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile is left in tmp */ }
      const ok = fs.existsSync(file) && fs.statSync(file).size > 0;
      resolve(ok ? { ok: true, file } : { ok: false, error: err ? err.message.slice(0, 200) : 'no file written' });
    });
  });
}

/**
 * Each {name, url} to `<dir>/<name>.png`.
 * @returns {Promise<{shots: object[], note: string|null}>}
 */
async function capture(dir, pages) {
  const exe = browser();
  if (!exe) return { shots: [], note: 'screenshots skipped: no headless Chromium found (set PA_E2E_BROWSER or `npx playwright install chromium`)' };
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  for (const p of pages) {
    const file = path.join(dir, `${p.name}.png`);
    const r = await shoot(exe, p.url, file);
    shots.push({ view: p.name, url: p.url, file: r.ok ? file : null, ...(r.ok ? {} : { error: r.error }) });
  }
  return { shots, note: null };
}

module.exports = { candidates, browser, shoot, capture };
