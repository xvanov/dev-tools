'use strict';

// Build, one Claude Code agent per task (src/build, D30): the pure helpers,
// and a run's life on a throwaway SQLite store with a stubbed termhub
// (done, a vanished session, stop, the one-live-run rule's row).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build.sqlite');
process.env.PA_SQLITE_KEY = 'build-test-key';
process.env.PA_WORKTREES_ROOT = dir;

const B = require('../src/build/index.ts');
const termhub = require('../src/dispatch/termhub.ts');
const { available } = require('../src/db/sqlite.ts');

// ---- pure ---------------------------------------------------------------------

assert.strictEqual(B.checkModel('Haiku'), 'haiku');
assert.throws(() => B.checkModel('gpt-5'), /model must be haiku, sonnet, opus/);
assert.strictEqual(B.renderPrompt('a {{x}} b {{y}} {{z}}', { x: '1', y: '2' }), 'a 1 b 2 ');
assert.strictEqual(B.projectDirName('C:\\repos\\dev-tools'), 'C--repos-dev-tools');
assert.ok(B.transcriptPathFor('C:\\w\\build-1', 'abc').endsWith(path.join('C--w-build-1', 'abc.jsonl')));
const tpl = fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'agent-prompt.md'), 'utf8');
for (const k of ['run_id', 'task', 'context', 'where', 'pa', 'reports_dir']) assert.ok(tpl.includes(`{{${k}}}`), `the prompt has {{${k}}}`);
assert.match(tpl, /run done --result/);
assert.match(tpl, /Never merge/);

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build lifecycle: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const killed = [];
  let live = ['s-live'];
  termhub.listSessions = async () => live.map((id) => ({ id }));
  termhub.killSession = async (id) => { killed.push(id); return true; };
  termhub.sessionUrl = async (id) => `http://hub/#session=${id}`;
  try {
    await require('../src/db/migrate.ts').migrate();
    const mk = async (task, session) => {
      const r = await repo.buildRuns.insert({ task, model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
      await repo.buildRuns.update(r.id, { state: 'running', session_id: session });
      return r;
    };

    const a = await mk('finishes', 's-live');
    const done = await B.done(a.id, '  https://example.test/pr/1 ');
    assert.deepStrictEqual([done.state, done.result], ['done', 'https://example.test/pr/1']);
    assert.ok(done.ended_at);
    assert.deepStrictEqual((await repo.buildRuns.msgs(a.id)).map((m) => [m.dir, m.kind, m.body]), [['agent', 'done', 'https://example.test/pr/1']]);
    await assert.rejects(() => B.done(a.id, 'again'), /already done/);

    const b = await mk('vanishes', 's-gone');
    const c = await mk('stays', 's-live');
    assert.deepStrictEqual(await B.reconcile(), { failed: 1 });
    assert.strictEqual((await repo.buildRuns.byId(b.id)).state, 'failed');
    assert.match((await repo.buildRuns.byId(b.id)).error, /without `pa run done`/);
    assert.strictEqual((await repo.buildRuns.byId(c.id)).state, 'running');

    const stopped = await B.stop(c.id, 'over the cost cap');
    assert.deepStrictEqual([stopped.state, stopped.error, stopped.url, killed], ['stopped', 'over the cost cap', 'http://hub/#session=s-live', ['s-live']]);
    await assert.rejects(() => B.stop(999999), /no run #999999/);
    assert.strictEqual((await B.get(a.id)).url, 'http://hub/#session=s-live');
    assert.ok((await B.list({ live: false })).length >= 3);
    assert.strictEqual((await B.list({ live: true })).length, 0);
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('build ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
