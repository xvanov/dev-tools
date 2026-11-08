'use strict';

// The live feed on SQLite (src/db/sqlite.js): a session that LISTENs hears an
// event committed by another connection to the same file (as the `pa` CLI or
// the MCP server would write it, from another process) through the outbox
// poll, and one committed locally at once. Skips without the optional driver.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { available, createSqliteBackend } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP sqliteNotify: no SQLite driver');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-notify-'));
  const file = path.join(dir, 'pa_test_notify.sqlite');
  const a = createSqliteBackend(file);
  await a.migrate();
  const b = createSqliteBackend(file); // another writer on the same file
  try {
    const s = await a.pool.connect();
    await s.query('listen pa_events');
    const got = [];
    s.on('notification', (n) => got.push(JSON.parse(n.payload)));
    const wait = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (!got.some(pred)) {
        if (Date.now() > end) throw new Error(`no event within ${ms} ms: ${JSON.stringify(got)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const other = await b.one(`insert into notification (kind, title) values ('info', 'from elsewhere') returning id`);
    await wait((e) => e.table === 'notification' && e.id === other.id);
    const local = await a.one(`insert into notification (kind, title) values ('info', 'from here') returning id`);
    await wait((e) => e.table === 'notification' && e.id === local.id, 200);
    assert.strictEqual(got.filter((e) => e.id === other.id).length, 1, 'each event once');
    s.release();
    console.log('sqliteNotify: ok');
  } finally {
    await b.close();
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
