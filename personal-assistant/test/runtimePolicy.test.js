'use strict';

// JOBS-API v1.9 on the PA side: the job submit flags for review / caps /
// failover, the "moved runtime" notice, the Repos editor's review and caps,
// and the credit pool going through the one failover policy (threshold).
// Pure: no store, no factory, no paid call. Names are invented.

const assert = require('assert');

const F = require('../src/dispatch/factoryCore.ts');
const A = require('../src/dashboard/factoryApps.ts');
const pool = require('../src/claudePool.ts');

const base = { app: 'widget', title: 'Fix the export', ask: 'the ask', delivery: 'draft_pr', externalId: 'i-1' };

// submitArgv: the new flags, only when given; checked before anything is sent.
{
  const plain = F.submitArgv(base);
  assert.ok(!plain.includes('--review') && !plain.includes('--cap') && !plain.includes('--failover'), 'nothing new unless given');
  const argv = F.submitArgv({ ...base, review: 'on', caps: { budget_usd: 50, max_rounds: 0, wall_clock_h: null }, failover: 'on' });
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  assert.strictEqual(at('--review'), 'on');
  assert.deepStrictEqual(argv.filter((x, i) => argv[i - 1] === '--cap'), ['budget_usd=50', 'max_rounds=0']);
  assert.strictEqual(at('--failover'), 'on');
  assert.ok(argv.indexOf('--source') > argv.indexOf('--failover'), 'the source and key stay last');
  assert.throws(() => F.submitArgv({ ...base, review: 'maybe' }), /unknown review/);
  assert.throws(() => F.submitArgv({ ...base, kind: 'research', delivery: 'none', review: 'on' }), /no review step/);
  assert.throws(() => F.submitArgv({ ...base, caps: { budget_usd: -1 } }), /0 or more/);
  assert.throws(() => F.submitArgv({ ...base, caps: { tokens: 5 } }), /unknown cap/);
  assert.throws(() => F.submitArgv({ ...base, failover: 'maybe' }), /on or off/);
}

// A factory refusal of the new flags means "no job was made".
{
  for (const code of ['invalid_review', 'invalid_cap', 'invalid_failover']) {
    assert.ok(F.REFUSAL_CODES.has(code), code);
  }
}

// notices: a job that moved runtime is said once, whatever its state.
{
  const job = (failover) => ({ job_id: 'widget:007', title: 'Fix the export', state: 'in_progress', pr_urls: [], failover });
  const fo = { from: 'claude_session', to: 'api', at: '2026-11-09T10:00:00Z', why: 'failed over from claude_session to api: paused: Claude limit, resumes 15:00' };
  const before = F.noticeState([job(null)]);
  const said = F.notices(before, [job(fo)]);
  assert.strictEqual(said.length, 1);
  assert.match(said[0].title, /moved from claude_session to api/);
  assert.match(said[0].body, /Claude limit/);
  assert.deepStrictEqual(F.notices(F.noticeState([job(fo)]), [job(fo)]), [], 'once');
}

// The Repos editor: review default, the auto size rule, caps -> `factory app set`.
{
  const argv = A.setArgv('widget', { review: 'auto', reviewMinDiffLines: 300, caps: { budget_usd: 45, wall_clock_h: 1.5, max_rounds: 10 } });
  assert.deepStrictEqual(argv, [
    'app', 'set', 'widget', '--json', '--review-default=auto', '--review-min-diff-lines=300',
    '--cap=budget_usd=45', '--cap=wall_clock_h=1.5', '--cap=max_rounds=10',
  ]);
  assert.throws(() => A.setArgv('widget', { review: 'maybe' }), /review is one of/);
  assert.throws(() => A.setArgv('widget', { reviewMinDiffLines: -3 }), /whole number/);
  assert.throws(() => A.setArgv('widget', { caps: { max_rounds: 2.5 } }), /whole number/);
  assert.throws(() => A.setArgv('widget', { caps: { tokens: 1 } }), /unknown cap/);
  const row = A.row({ app: 'widget', repo: 'acme/widget', review: { default: 'on', auto_min_diff_lines: 0 }, caps: { budget_usd: 30, wall_clock_h: 4, max_rounds: 20 } });
  assert.deepStrictEqual(row.review, { default: 'on', autoMinDiffLines: 0 });
  assert.deepStrictEqual(row.caps, { budget_usd: 30, wall_clock_h: 4, max_rounds: 20 });
  assert.strictEqual(A.row({ app: 'old', repo: 'acme/old' }).review, null, 'an older factory sends none');
}

// The credit pool is one more runtime limit: the shared policy, with its threshold.
{
  const now = new Date('2026-11-30T23:50:00Z');
  const spent = pool.compute({ monthlyUsd: 50, usedUsd: 60, since: '2026-11-01', resetsAt: '2026-12-01T00:00:00Z', fallbackApi: true });
  assert.strictEqual(pool.decideRuntime('claude_session', spent, { now, minWaitMin: 30 }).runtime, 'claude_session', 'refills in 10 min: wait');
  const far = pool.decideRuntime('claude_session', spent, { now: new Date('2026-11-20T00:00:00Z'), minWaitMin: 30 });
  assert.deepStrictEqual([far.runtime, far.fellBack], ['api', true]);
  assert.match(far.reason, /credit pool is spent/);
  assert.strictEqual(pool.decideRuntime('claude_session', { ...spent, fallbackApi: false }).runtime, 'claude_session', 'policy off');
}

console.log('runtime policy (PA): ok');
