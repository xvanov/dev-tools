'use strict';

// A test process must never reach the operator's real database (a test once wrote its stub's
// error into the live factory_board row on every run). src/db refuses to connect anything started
// as a test to a database not named pa_test_*; the runner also points PA_DATABASE_URL at a blocked
// name. This pins both, and that the guard stays off for a real process.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { assertSafeForTests } = require('../src/db');

// This file is itself a test process (argv[1] ends in .test.js), so the guard is on here.
const live = ['postgres://pa:pa@127.0.0.1:5433/pa', 'postgres://u:p@db.internal/pa_prod', 'postgres://u:p@h/pa', 'postgres://u:p@h/', 'not a url'];
for (const url of live) assert.throws(() => assertSafeForTests(url), /refusing to connect a test process/, url);
assert.throws(() => assertSafeForTests('postgres://pa:pa@127.0.0.1:1/blocked_in_tests'), /refusing/, 'the runner\'s blocked name is refused too');
for (const url of ['postgres://pa:pa@127.0.0.1:5433/pa_test_scratch', 'postgres://u:p@h/PA_TEST_x?sslmode=disable']) {
  assert.doesNotThrow(() => assertSafeForTests(url), url);
}

// End to end in a child: the real module, the live default DSN, a real query attempt.
const src = path.join(__dirname, '..', 'src', 'db');
const probe = (env, script) => spawnSync(process.execPath, ['-e', script], {
  env: { ...process.env, PA_TESTING: '', PA_DATABASE_URL: 'postgres://pa:pa@127.0.0.1:5433/pa', ...env },
  encoding: 'utf8',
  windowsHide: true,
});
const q = `require(${JSON.stringify(src)}).query('select 1').then(() => console.log('CONNECTED'), (e) => console.log('ERR:' + e.message))`;
const guarded = probe({ PA_TESTING: '1' }, q);
assert.match(guarded.stdout, /ERR:refusing to connect a test process to database "pa"/, guarded.stdout + guarded.stderr);
// Not a test process: the guard stays out of the way (the connection then simply fails or succeeds on its own).
const unguarded = probe({ PA_DATABASE_URL: 'postgres://pa:pa@127.0.0.1:1/pa' }, `${q}.then(() => process.exit(0))`);
assert.doesNotMatch(unguarded.stdout, /refusing/, 'a real process is not guarded');

// The shared runner config keeps tests off any real database.
const cfg = require('./runner.config.js');
assert.strictEqual(cfg.env.PA_TESTING, '1');
assert.ok(!/\/pa$/.test(cfg.env.PA_DATABASE_URL) && !/^pa_test_/.test(new URL(cfg.env.PA_DATABASE_URL).pathname.slice(1)), 'blocked name, not a real or allowed one');

console.log('dbGuard ok');
