'use strict';

// Per-session environment (lib/sessionEnv.js): `POST /api/sessions {env,
// unsetEnv}`. The personal assistant starts a run that may not push without
// push credentials, so what earns a test: removals really reach the PTY
// (case-insensitively on Windows), bad names are refused, the change is
// reported back (`envApplied`) so a caller can refuse a termhub that ignored
// it, it survives into the archive entry a restore reads, and the request
// still goes through the CSRF guard like every other POST. Runs a REAL
// sessiond behind a REAL front, with its data dir in a temp directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-env-'));
process.env.TERMHUB_DATA_DIR = tmp;
delete process.env.TERMHUB_NTFY_TOPIC;

const { parseEnvSpec, applyEnvSpec } = require('../lib/sessionEnv.ts');
const { shellArgs, parseNoRc, findOnPath } = require('../lib/shell.ts');

// ---- the rules (pure) -------------------------------------------------------

assert.deepStrictEqual(parseEnvSpec({}), { spec: null });
assert.deepStrictEqual(parseEnvSpec({ env: { A: '1' }, unsetEnv: ['GH_TOKEN'] }), { spec: { env: { A: '1' }, unset: ['GH_TOKEN'] } });
for (const bad of [
  { env: 'A=1' }, { env: ['A'] }, { env: { 'A B': '1' } }, { env: { '1A': '1' } }, { env: { A: 1 } }, { env: { A: 'x\0y' } },
  { unsetEnv: 'GH_TOKEN' }, { unsetEnv: ['GH TOKEN'] }, { unsetEnv: [3] }, { unsetEnv: Array.from({ length: 65 }, (_, i) => `V${i}`) },
]) assert.ok(parseEnvSpec(bad).error, JSON.stringify(bad));

const base = { PATH: '/bin', GH_TOKEN: 't', gh_token: 'u', KEEP: 'k', GIT_CONFIG_COUNT: '9' };
const spec = { env: { GIT_CONFIG_COUNT: '1', NEW: 'n' }, unset: ['GH_TOKEN'] };
assert.deepStrictEqual(applyEnvSpec(base, spec, 'linux'), { PATH: '/bin', gh_token: 'u', KEEP: 'k', GIT_CONFIG_COUNT: '1', NEW: 'n' });
assert.deepStrictEqual(applyEnvSpec(base, spec, 'win32'), { PATH: '/bin', KEEP: 'k', GIT_CONFIG_COUNT: '1', NEW: 'n' }, 'Windows names fold case');
assert.deepStrictEqual(applyEnvSpec(base, null), base);
assert.notStrictEqual(applyEnvSpec(base, null), base, 'never mutates the base');

// ---- noRc: start the shell without rc files (pure) ----------------------------

const off = { args: [], unsetEnv: [], rcSkipped: false };
for (const sh of ['/bin/bash', '/bin/zsh', 'pwsh', '/bin/sh', '/usr/bin/fish']) {
  assert.deepStrictEqual(shellArgs(sh), off, `${sh}: nothing changes without noRc`);
  assert.deepStrictEqual(shellArgs(sh, { noRc: false }), off);
}
const rc = (sh) => shellArgs(sh, { noRc: true });
assert.deepStrictEqual(rc('/bin/bash'), { args: ['--norc', '--noprofile'], unsetEnv: ['BASH_ENV', 'ENV'], rcSkipped: true });
assert.deepStrictEqual(rc('/usr/local/bin/bash'), rc('/bin/bash'));
assert.deepStrictEqual(rc('C:\\Program Files\\Git\\bin\\bash.exe'), rc('/bin/bash'), 'Git Bash on Windows');
assert.deepStrictEqual(rc('/bin/zsh'), { args: ['-f'], unsetEnv: [], rcSkipped: true });
assert.deepStrictEqual(rc('/usr/bin/fish'), { args: ['--no-config'], unsetEnv: [], rcSkipped: true });
assert.deepStrictEqual(rc('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), { args: ['-NoProfile'], unsetEnv: [], rcSkipped: true });
assert.deepStrictEqual(rc('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE'), { args: ['-NoProfile'], unsetEnv: [], rcSkipped: true });
assert.deepStrictEqual(rc('/bin/sh'), { args: [], unsetEnv: ['ENV'], rcSkipped: true }, 'sh -i reads $ENV');
assert.deepStrictEqual(rc('/usr/bin/dash'), rc('/bin/sh'));
assert.deepStrictEqual(rc('C:\\Windows\\system32\\cmd.exe'), { args: ['/D'], unsetEnv: [], rcSkipped: true });
for (const unknown of ['/usr/bin/tcsh', '/usr/bin/nu', '/opt/myshell', '', null]) {
  assert.deepStrictEqual(rc(unknown), off, `unknown shell ${unknown}: started normally, not pretended`);
}
assert.deepStrictEqual(parseNoRc({}), { noRc: false, given: false });
assert.deepStrictEqual(parseNoRc({ noRc: true }), { noRc: true, given: true });
assert.deepStrictEqual(parseNoRc({ noRc: false }), { noRc: false, given: true });
for (const bad of ['true', 1, 0, {}, []]) assert.ok(parseNoRc({ noRc: bad }).error, `noRc ${JSON.stringify(bad)} refused`);

// ---- through a real front and a real sessiond --------------------------------

function request(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.platform === 'win32') {
    console.log('sessionEnv.test.js: PTY leg skipped on Windows (POSIX shell command)');
    console.log('sessionEnv.test.js ok');
    return;
  }
  const { startSparePtyd, findPtyd, ptydMissing } = require('./spareTermhub');
  if (!findPtyd()) {
    const why = ptydMissing();
    console.log(`sessionEnv.test.js: PTY leg skipped (${why})`);
    console.log('sessionEnv.test.js ok');
    return;
  }
  const ptyd = await startSparePtyd(tmp);
  process.env.TERMHUB_PTYD = '1';
  process.env.TERMHUB_PTYD_PORT = String(ptyd.port);
  process.env.TERMHUB_PTYD_BIN = ptyd.bin;
  delete process.env.TERMHUB_PTYD_RESOLVED;
  process.env.GH_TOKEN = 'inherited-secret';
  process.env.PA_TEST_KEEP = 'kept';
  const { createSessiond } = require('../sessiond.ts');
  const { createFront } = require('../front.ts');
  const sessiond = createSessiond({ entry: 'test', port: 0 });
  const sPort = await listen(sessiond);
  const front = createFront({ sessiondPort: sPort, port: 0, paUrl: '' });
  const fPort = await listen(front);
  const ui = { 'Content-Type': 'application/json', 'X-Termhub': '1' };
  const made = [];
  try {
    const info = await request(fPort, { path: '/api/info' });
    assert.ok(info.json.features.includes('session-env'), '/api/info says it can');

    // Refused: a bad name, and a cross-site request (the CSRF guard still applies).
    const bad = await request(fPort, { method: 'POST', path: '/api/sessions', headers: ui, body: JSON.stringify({ cwd: tmp, command: '', unsetEnv: ['A B'] }) });
    assert.strictEqual(bad.status, 400);
    const evil = await request(fPort, {
      method: 'POST', path: '/api/sessions', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: JSON.stringify({ cwd: tmp, command: 'touch pwned', env: { A: '1' } }),
    });
    assert.strictEqual(evil.status, 403);

    // Applied, reported, and really in the PTY.
    const out = path.join(tmp, 'env.txt');
    const command = `printf '%s|%s|%s\\n' "\${GH_TOKEN-unset}" "\${PA_X-unset}" "\${PA_TEST_KEEP-unset}" > '${out}'`;
    const r = await request(fPort, {
      method: 'POST', path: '/api/sessions', headers: ui,
      body: JSON.stringify({ cwd: tmp, command, title: 'env', cols: 80, rows: 24, env: { PA_X: 'set' }, unsetEnv: ['GH_TOKEN'] }),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    made.push(r.json.id);
    assert.strictEqual(r.json.envApplied, true);
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(100);
    for (let i = 0; i < 20 && !fs.readFileSync(out, 'utf8').includes('\n'); i++) await sleep(50);
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'unset|set|kept', 'removed, added, the rest inherited');

    // A plain session is unchanged and says nothing about env.
    const plain = await request(fPort, { method: 'POST', path: '/api/sessions', headers: ui, body: JSON.stringify({ cwd: tmp, command: '', title: 'plain' }) });
    made.push(plain.json.id);
    assert.ok(!('envApplied' in plain.json));

    // The archive entry carries the spec, so a restore keeps it.
    const archived = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8'));
    const list = Array.isArray(archived) ? archived : Object.values(archived.sessions || archived);
    const entry = list.find((e) => e && e.id === r.json.id);
    assert.ok(entry, 'archived');
    assert.deepStrictEqual(entry.envSpec, { env: { PA_X: 'set' }, unset: ['GH_TOKEN'] });

    // ---- noRc, end to end: an rc file that re-exports the removed token ----
    const bash = findOnPath(['bash']);
    if (!bash) {
      console.log('sessionEnv.test.js: noRc PTY leg skipped (no bash)');
    } else {
      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.bashrc'), 'export GH_TOKEN=from-bashrc\n');
      fs.writeFileSync(path.join(home, '.bash_profile'), 'export GH_TOKEN=from-profile\n');
      // An unknown shell name: the same bash under another name, so it really
      // would read the rc file — and must say so rather than pretend.
      const oddShell = path.join(tmp, 'myshell');
      fs.symlinkSync(bash, oddShell);
      const prevShell = process.env.TERMHUB_SHELL;
      const runWith = async (shell, extra, file) => {
        process.env.TERMHUB_SHELL = shell;
        const o = path.join(tmp, file);
        const res = await request(fPort, {
          method: 'POST', path: '/api/sessions', headers: ui,
          body: JSON.stringify({ cwd: tmp, command: `printf '%s\\n' "\${GH_TOKEN-unset}" > '${o}'`, title: file,
            cols: 80, rows: 24, env: { HOME: home }, unsetEnv: ['GH_TOKEN'], ...extra }),
        });
        if (res.status === 201) {
          made.push(res.json.id);
          for (let i = 0; i < 100 && !(fs.existsSync(o) && fs.readFileSync(o, 'utf8').includes('\n')); i++) await sleep(100);
        }
        return { res, out: fs.existsSync(o) ? fs.readFileSync(o, 'utf8').trim() : null };
      };
      try {
        const badRc = await request(fPort, { method: 'POST', path: '/api/sessions', headers: ui,
          body: JSON.stringify({ cwd: tmp, command: '', noRc: 'yes' }) });
        assert.strictEqual(badRc.status, 400, 'noRc must be a boolean');
        assert.match(badRc.json.error, /noRc/);

        const control = await runWith(bash, {}, 'rc-control.txt');
        assert.strictEqual(control.out, 'from-bashrc', 'control: the rc file DOES re-export the token');
        assert.ok(!('rcSkipped' in control.res.json), 'not asked, not reported');

        const skipped = await runWith(bash, { noRc: true }, 'rc-skipped.txt');
        assert.strictEqual(skipped.res.status, 201, JSON.stringify(skipped.res.json));
        assert.strictEqual(skipped.res.json.rcSkipped, true);
        assert.strictEqual(skipped.res.json.envApplied, true);
        assert.strictEqual(skipped.out, 'unset', 'noRc: the rc file never ran');

        const odd = await runWith(oddShell, { noRc: true }, 'rc-odd.txt');
        assert.strictEqual(odd.res.status, 201);
        assert.strictEqual(odd.res.json.rcSkipped, false, 'an unknown shell reports the truth');

        const asked = await runWith(bash, { noRc: false }, 'rc-false.txt');
        assert.strictEqual(asked.res.json.rcSkipped, false, 'noRc: false is answered too');

        // Persisted with the archived spec, so a restore after a reboot skips them too.
        const arch = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8'));
        assert.strictEqual(arch.find((e) => e.id === skipped.res.json.id).noRc, true);
        assert.strictEqual(arch.find((e) => e.id === control.res.json.id).noRc, false);

        // And a restore reads it: an archived no-push entry from "before the
        // reboot" comes back with GH_TOKEN gone AND the rc file unread.
        process.env.TERMHUB_SHELL = bash;
        require('../lib/archive.ts').upsert({ id: 'pre-reboot', kind: 'shell', cwd: tmp, title: 'old', command: null,
          envSpec: { env: { HOME: home }, unset: ['GH_TOKEN'] }, noRc: true, history: [] });
        const restored = await request(fPort, { method: 'POST', path: '/api/sessions/pre-reboot/restore', headers: ui,
          body: JSON.stringify({ cols: 80, rows: 24 }) });
        assert.strictEqual(restored.status, 201, JSON.stringify(restored.json));
        made.push(restored.json.id);
        await sleep(300);
        const ro = path.join(tmp, 'rc-restored.txt');
        await request(fPort, { method: 'POST', path: `/api/sessions/${encodeURIComponent(restored.json.id)}/input`, headers: ui,
          body: JSON.stringify({ data: `printf '%s\\n' "\${GH_TOKEN-unset}" > '${ro}'` }) });
        for (let i = 0; i < 100 && !(fs.existsSync(ro) && fs.readFileSync(ro, 'utf8').includes('\n')); i++) await sleep(100);
        assert.strictEqual(fs.readFileSync(ro, 'utf8').trim(), 'unset', 'restored session skipped the rc file too');
        const arch2 = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8'));
        assert.strictEqual(arch2.find((e) => e.id === restored.json.id).noRc, true, 'and stays noRc for the next restore');
      } finally {
        if (prevShell === undefined) delete process.env.TERMHUB_SHELL; else process.env.TERMHUB_SHELL = prevShell;
      }
    }

    console.log('sessionEnv.test.js ok');
  } finally {
    for (const id of made) await request(fPort, { method: 'DELETE', path: `/api/sessions/${encodeURIComponent(id)}`, headers: { 'X-Termhub': '1' } }).catch(() => {});
    front.close();
    sessiond.close();
    await ptyd.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0); // sessiond's idle/voice hubs keep timers alive
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
