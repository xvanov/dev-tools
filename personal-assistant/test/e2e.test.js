'use strict';

// `pa e2e` (plan 8.2): the harness's pure parts (src/e2e/goldenPathCore.ts: flags, usage, the argv a
// remote run uses) and the policy dry check (src/e2e/goldenPath.ts). The factory's golden path that
// lived here (card -> job -> PR, sweeps, id chains) went with the factory (D32); each workflow's
// own rules are tested in e2eWorkflows.test.js and e2eBuild.test.js. No network, no database.

const assert = require('assert');
const C = require('../src/e2e/goldenPathCore.ts');
const G = require('../src/e2e/goldenPath.ts');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('options: defaults, own timeouts and refusals', () => {
  const o = C.parseOptions({}, {});
  assert.strictEqual(o.repo, 'xvanov/dev-tools');
  assert.strictEqual(o.keep, false);
  assert.strictEqual(o.dryRun, false);
  assert.deepStrictEqual(o.timeouts, {});
  const p = C.parseOptions({ model: 'haiku', 'dry-run': true, stack: 'work', on: 'box' }, { timeout: ['ci=60', 'research=5'] });
  assert.deepStrictEqual([p.model, p.dryRun, p.stack, p.on, p.timeouts], ['haiku', true, 'work', 'box', { ci: 60, research: 5 }]);
  assert.throws(() => C.parseOptions({}, { timeout: ['nope=1'] }), /=seconds/);
  assert.throws(() => C.parseOptions({}, { timeout: ['card=1'] }), /=seconds/, 'the factory\'s hops are gone');
  assert.throws(() => C.parseOptions({ keep: 'later' }), /takes no value/);
  assert.throws(() => C.parseOptions({ repo: 'not a repo' }), /owner\/name/);
  assert.throws(() => C.parseOptions({ stack: 'nowhere' }), /work or personal/);
});

test('usage names the workflows, not the removed golden path', () => {
  assert.match(C.USAGE, /pa e2e <workflow>/);
  assert.ok(!/golden|--sweep|--resume|--runtime/.test(C.USAGE));
});

test('remoteArgv passes plain flags, never --on/--report, and refuses shell-looking values', () => {
  assert.deepStrictEqual(C.remoteArgv({ on: 'box', 'dry-run': true, model: 'haiku' }, { timeout: ['ci=5'] }, { workflow: 'build-pr' }),
    ['e2e', 'build-pr', '--json', '--dry-run', '--model', 'haiku', '--timeout', 'ci=5']);
  assert.throws(() => C.remoteArgv({ repo: 'x; rm -rf /' }), /cannot be passed/);
  assert.throws(() => C.remoteArgv({}, {}, { workflow: 'Bad Name' }), /cannot be passed/);
});

test('policyDry: a routine chat action runs unasked (D33); one that asks takes the e2e channel\'s approval', () => {
  const ok = G.policyDry('build_start');
  assert.deepStrictEqual([ok.view, ok.ok], ['policy', true], JSON.stringify(ok));
  assert.match(ok.detail, /call allow \(chat-actions-allow\)/);
  const del = G.policyDry('profile_delete');
  assert.strictEqual(del.ok, true, JSON.stringify(del));
  assert.match(del.detail, /call ask .*e2e answer allow/);
  assert.strictEqual(G.policyDry('board').ok, false, 'a read is not an action');
});

test('owner and safely', async () => {
  assert.strictEqual(G.owner('acme/widget'), 'acme');
  assert.deepStrictEqual(await G.safely(() => 3), { ok: true, value: 3 });
  const bad = await G.safely(() => { throw new Error('boom'); });
  assert.deepStrictEqual([bad.ok, bad.error], [false, 'boom']);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`not ok - ${t.name}\n  ${err.stack}`);
    }
  }
  if (failed) {
    console.log(`${failed} of ${tests.length} failed`);
    process.exit(1);
  }
  console.log(`${tests.length} passed`);
})();
