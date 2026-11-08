'use strict';

// PA_ONLY_PASSES (src/util/scheduler.ts `only`): a rehearsal on a copy of the
// store schedules only the passes and services it names (a trailing * is a
// prefix); the others are declared, logged, and never started.

const assert = require('assert');
const { createScheduler } = require('../src/util/scheduler.ts');

async function main() {
  const ran = [];
  const skipped = [];
  const passes = { run: async (name, fn) => (await fn(), true), soon: async (name, fn) => (await fn(), true), isRunning: () => false };
  const log = { warn: (msg, d) => skipped.push(d.name), debug() {} };
  const s = createScheduler({ passes, log, firstTickMs: () => 0, only: ['memory-*', 'backup', 'durable-worker'] });
  for (const name of ['memory-extract', 'memory-pages', 'backup', 'github', 'm365']) s.every(3600, name, () => ran.push(name));
  s.service('durable-worker', () => (ran.push('durable-worker'), () => {}));
  s.service('teams-cache', () => (ran.push('teams-cache'), () => {}));
  s.start();
  await new Promise((r) => setTimeout(r, 50));
  s.stop();
  assert.deepStrictEqual(ran.sort(), ['backup', 'durable-worker', 'memory-extract', 'memory-pages']);
  assert.deepStrictEqual(skipped.sort(), ['github', 'm365', 'teams-cache']);

  const all = [];
  const t = createScheduler({ passes, log, firstTickMs: () => 0 });
  t.every(3600, 'github', () => all.push('github'));
  t.start();
  await new Promise((r) => setTimeout(r, 50));
  t.stop();
  assert.deepStrictEqual(all, ['github'], 'no list: everything runs');
  console.log('schedulerOnly: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
