'use strict';

// The compiled jarvisd on the SQLite store (PA_DB=sqlite, both stacks' store):
// a bare generation on a throwaway encrypted file, from a working directory
// outside the checkout (the supervisor starts generations in jarvisd/dist).
// What only the compiled binary got wrong, each found by hand first:
//   - sqlite-vec found its extension by package name, which the binary
//     resolves from the working directory: vector search fell back to JS;
//   - the dashboard's module routes (/api/routines, /api/debriefs, ...) were
//     computed requires the binary cannot resolve: 500;
//   - the backup's snapshot thread loads db/sqlite.ts from disk, where the
//     driver does not resolve by name: no snapshot, no bundle.
// Plus the live feed: an outbox row another process writes reaches /api/events.
//
// Needs a built binary: PA_JARVISD_EXE=<jarvisd/dist/jarvisd[.exe]> (CI's
// jarvisd job sets it). Without it the test says so and passes.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EXE = process.env.PA_JARVISD_EXE;
if (!EXE) {
  console.log('jarvisdSqlite: PA_JARVISD_EXE not set (build jarvisd and point it there) - skipped');
  process.exit(0);
}

const { createSqliteBackend } = require('../src/db/sqlite.ts');

const KEY = 'jarvisd-sqlite-test-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const get = (port, p) =>
  new Promise((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject)
  );

async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-jdsql-'));
  const file = path.join(dir, 'pa_test_jarvisd.sqlite');
  const seed = createSqliteBackend(file, { key: KEY });
  await seed.migrate();
  await seed.close();

  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PA_')));
  Object.assign(env, {
    PA_NO_SUPERVISOR: '1', PA_DB: 'sqlite', PA_SQLITE_PATH: file, PA_SQLITE_KEY: KEY,
    PA_DATABASE_URL: 'postgres://pa:pa@127.0.0.1:1/blocked_in_tests',
    PA_DATA_DIR: path.join(dir, 'data'), PA_BACKUP_DIR: path.join(dir, 'backups'),
    PA_BACKUP_KEY: crypto.randomBytes(32).toString('base64'),
    PA_DISPATCH_PORT: String(port), PA_TOASTS: '0', PA_NTFY: 'off', PA_CHAT_NUDGE: '0', PA_FACTORY_MACHINE: 'none',
    PA_M365: '0', PA_TEAMS_CACHE: '0', PA_SESSIONS: '0', PA_GITHUB: '0', PA_JIRA: '0', PA_AUDIO_ENABLED: '0',
    PA_AUDIO_MEETING_GATE: '0', PA_BRIEFS: '0', PA_REPOS: '0', PA_PLANNER: '0', PA_CARD_CONTEXT: '0', PA_FAST_LANE: '0',
    PA_REPLY_CLOSE: '0', PA_DEDUPE: '0', PA_BLOCKS: '0', PA_RECONCILE: '0',
    PA_ONLY_PASSES: 'backup',
  });
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const child = spawn(EXE, ['generation'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  try {
    const ready = await until('store ready', async () => /store ready \{[^}]*\}/.exec(log)?.[0]);
    assert.match(ready, /has_vector: true/, `sqlite-vec not loaded in the binary: ${ready}`);
    await until('/healthz ready', async () => JSON.parse((await get(port, '/healthz')).body).ready);

    for (const p of ['/api/routines', '/api/debriefs']) {
      const r = await get(port, p);
      assert.strictEqual(r.status, 200, `${p}: ${r.status} ${r.body.slice(0, 200)}`);
    }

    await until('the rolling snapshot', async () => fs.existsSync(path.join(dir, 'backups', 'pa-latest.sqlite')));
    await until('the encrypted bundle', async () => fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.pabak')));
    assert.doesNotMatch(log, /snapshot failed|pass failed/, log.slice(-2000));

    // An outbox row from this process (as the event triggers write one) reaches the binary's SSE feed.
    const got = await new Promise((resolve, reject) => {
      let text = '';
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream' } }, (res) => {
        res.on('data', (c) => {
          text += c;
          if (text.includes('jarvisd-sqlite-424242')) {
            req.destroy();
            resolve(true);
          }
        });
      });
      req.on('error', () => {});
      setTimeout(async () => {
        const w = createSqliteBackend(file, { key: KEY });
        await w.exec(`update pa_event_seq set last_value = last_value + 1 where id = 1;
          insert into event_outbox (seq, topic, payload) values ((select last_value from pa_event_seq where id = 1), 'commitment', '{"op":"insert","mark":"jarvisd-sqlite-424242"}');`).catch(reject);
        await w.close();
      }, 1000);
      setTimeout(() => {
        req.destroy();
        resolve(false);
      }, 10_000);
    });
    assert.ok(got, 'an outbox row written by another process did not reach /api/events');
    console.log('jarvisdSqlite: ok (sqlite-vec, module routes, snapshot and bundle, cross-process feed)');
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
