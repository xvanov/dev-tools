'use strict';

// Build's Board view (plan 8.8.2): the client's pure half
// (src/dashboard/factory.board.client.js), the two proxy routes
// (src/dashboard/factoryBoard.ts: GET /api/factory/board and
// /api/factory/steps/<id>/events, JOBS-API v1.11) with the factory call
// stubbed, and the job view's new fields. Names are invented.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.PA_FACTORY_PATH = process.env.PA_FACTORY_PATH || '/srv/factory-checkout';

const B = require('../src/dashboard/factory.board.client.js');
const P = require('../src/dashboard/factoryBoard.ts');
const F = require('../src/dispatch/factoryCore.ts');

(async () => {
  // ---- the client's pure half ---------------------------------------------------
  assert.deepStrictEqual([B.dur(5), B.dur(125), B.dur(3700), B.dur(90000)], ['5s', '2m', '1h 02m', '1d 1h']);

  const dir = { job_id: 'widget:015', progress: 0.25, eta: { p50_s: 600, p75_s: 1200, p95_s: 3600, insufficient: false } };
  const snap = { directions: [dir], live: [{ job_id: 'widget:015', persona: 'dev', story_id: 7, elapsed_s: 90 }] };
  assert.strictEqual(B.directionOf(snap, 'widget:015'), dir);
  assert.strictEqual(B.progressOf({ state: 'in_progress' }, dir), 0.25, 'the TUI ratio when the direction is in flight');
  assert.strictEqual(B.progressOf({ state: 'done' }, null), 1);
  assert.strictEqual(B.progressOf({ state: 'in_progress', stories: [{ state: 'delivered_pr' }, { state: 'dev_in_progress' }] }, null), 0.5);
  assert.strictEqual(B.progressOf({ state: 'in_progress', stories: [] }, null), null, 'a running task job: unknown');
  assert.strictEqual(B.etaText(dir.eta), 'P50 10m · P75 20m · P95 1h 00m');
  assert.match(B.etaText({ insufficient: true, reason: 'need 3 samples' }), /need 3 samples/);
  assert.strictEqual(B.liveOf(snap, { jobId: 'widget:015', stories: [] }).persona, 'dev');
  assert.strictEqual(B.liveOf({ live: [] }, { jobId: 'x:1', stories: [], runs: [{ state: 'running', persona: 'reviewer', storyId: 3 }] }).persona, 'reviewer');

  // Cost vs cap counts metered plus Claude's notional cost, as the factory's job cap does.
  const cap = B.capLine({ costUsd: 1.25, subscriptionEquivUsd: 2.5, caps: { budgetUsd: 30, maxRounds: 20, used: { spendUsd: 3.75, rounds: 4 } } });
  assert.deepStrictEqual([cap.spent, cap.metered, cap.notional, cap.budget, cap.ratio, cap.rounds], [3.75, 1.25, 2.5, 30, 0.125, 4]);
  assert.strictEqual(B.capLine({ costUsd: 1, subscriptionEquivUsd: 1 }).ratio, null, 'no cap: no ratio');

  assert.strictEqual(B.coderabbit({ stories: [{ ci: { state: 'pending', failing: [], pending: ['CodeRabbit'] } }] }), 'pending');
  assert.strictEqual(B.coderabbit({ stories: [{ ci: { state: 'failing', failing: ['coderabbit review'], pending: [] } }, { ci: { pending: ['CodeRabbit'] } }] }), 'failing');
  assert.strictEqual(B.coderabbit({ stories: [{ ci: { state: 'passing', failing: [], pending: [] } }] }), null);

  // The trace: a lane per persona, blocks placed on one axis, a running step to now.
  const t = Date.parse('2026-11-09T10:00:00Z');
  const iso = (s) => new Date(t + s * 1000).toISOString();
  const L = B.lanes([
    { id: 3, persona: 'reviewer', state: 'running', startedAt: iso(60) },
    { id: 1, persona: 'dev', state: 'ok', startedAt: iso(0), endedAt: iso(50) },
    { id: 2, persona: 'dev', state: 'failed', startedAt: iso(50), endedAt: iso(60) },
    { id: 4, persona: 'dev', state: 'ok', startedAt: null },
  ], t + 100_000);
  assert.deepStrictEqual(L.lanes.map((l) => [l.name, l.blocks.map((b) => b.id)]), [['dev', [1, 2]], ['reviewer', [3]]]);
  assert.deepStrictEqual([L.lanes[0].blocks[0].left, L.lanes[0].blocks[0].width, L.lanes[1].blocks[0].left, L.lanes[1].blocks[0].width], [0, 50, 60, 40]);
  assert.deepStrictEqual(B.lanes([], 0).lanes, []);

  // A tool call and its result pair up, also when the result comes in a later page.
  const byCall = {};
  const first = B.pairTurns([{ kind: 'text', text: 'hi' }, { kind: 'tool_call', id: 'tu1', name: 'Read', input: '{"file_path": "a.py"}' }], byCall);
  assert.deepStrictEqual(first.map((x) => x.kind), ['text', 'tool']);
  const second = B.pairTurns([{ kind: 'tool_result', tool_use_id: 'tu1', text: 'x = 1' }, { kind: 'tool_result', tool_use_id: 'zz', text: 'orphan' }], byCall);
  assert.deepStrictEqual(second.map((x) => x.kind), ['attach', 'tool_result']);
  assert.strictEqual(first[1].result.text, 'x = 1');
  assert.strictEqual(B.argSummary('{"command": "npm  test\\n -- x"}'), 'npm test -- x');
  assert.strictEqual(B.argSummary('{"a": [1]}'), 'a: [1]');
  assert.strictEqual(B.argSummary('not json'), 'not json');

  // The browser file: parses, no HTML sink (agents wrote every text it shows), relative URLs.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'factory.board.client.js'), 'utf8');
  new vm.Script(src, { filename: 'factory.board.client.js' });
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.ok(!/fetch\('\//.test(src) && !/getJson\('\//.test(src), 'relative URLs only (termhub /pa/ proxy)');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'factory.html'), 'utf8');
  assert.ok(html.indexOf('src="factory-board.js"') > 0 && html.indexOf('src="factory-board.js"') < html.indexOf('src="factory.js"'), 'loaded before the page script');

  // ---- the proxy routes -----------------------------------------------------------
  assert.strictEqual(P.stepPath('/api/factory/steps/42/events'), '42');
  for (const bad of ['/api/factory/steps/4x/events', '/api/factory/steps/../events', '/api/factory/steps/1/events/x']) assert.strictEqual(P.stepPath(bad), null, bad);
  const q = (s) => new URLSearchParams(s);
  assert.deepStrictEqual(P.stepArgv('42', q('cursor=1:2048&limit=300&wait=99')),
    { argv: ['job', 'step', '42', '--json', '--cursor', '1:2048', '--limit', '300', '--wait', '20'], waitS: 20 }, 'wait clamped to 20 s');
  assert.deepStrictEqual(P.stepArgv('42', q('at=0:10&wait=5')).argv, ['job', 'step', '42', '--json', '--at', '0:10'], 'at reads one record, never waits');
  for (const bad of ['cursor=1;rm', 'cursor=--json', 'limit=0', 'limit=5000', 'wait=-1', 'at=x']) {
    assert.throws(() => P.stepArgv('42', q(bad)), (e) => e.status === 400, bad);
  }

  const calls = [];
  let answer = () => ({ as_of: 'now', spend: { today: { metered_usd: 1, notional_usd: 2 } } });
  P._setCall(async (argv, opts) => { calls.push({ argv, opts }); return answer(argv); });
  const [a, b2] = await Promise.all([P.board(), P.board()]);
  assert.strictEqual(calls.length, 1, 'one factory read shared by a burst');
  assert.strictEqual(a, b2);
  assert.deepStrictEqual([a.enabled, a.spend.today.notional_usd, calls[0].argv], [true, 2, ['job', 'board', '--json']]);
  await P.board();
  assert.strictEqual(calls.length, 1, 'cached for 2 s');

  const sent = [];
  const send = (res, status, body) => sent.push({ status, body });
  answer = (argv) => ({ step: { id: Number(argv[2]) }, events: [{ kind: 'text', text: 'hi', at: '0:0' }], cursor: '0:30', more: false, done: false });
  assert.ok(await P.route({ method: 'GET' }, {}, new URL('http://x/api/factory/steps/7/events?cursor=0:0&wait=15'), { send }));
  assert.deepStrictEqual(sent.pop(), { status: 200, body: answer(['job', 'step', '7']) });
  const last = calls[calls.length - 1];
  assert.deepStrictEqual(last.argv, ['job', 'step', '7', '--json', '--cursor', '0:0', '--wait', '15']);
  assert.ok(last.opts.timeoutMs >= 30_000, 'the long poll outlives its wait');
  assert.ok(await P.route({ method: 'GET' }, {}, new URL('http://x/api/factory/steps/7x/events'), { send }));
  assert.strictEqual(sent.pop().status, 400);
  answer = () => { throw Object.assign(new Error('factory not_found: no step 9'), { code: 'not_found' }); };
  await P.route({ method: 'GET' }, {}, new URL('http://x/api/factory/steps/9/events'), { send });
  assert.strictEqual(sent.pop().status, 404);
  assert.strictEqual(await P.route({ method: 'POST' }, {}, new URL('http://x/api/factory/board'), { send }), false, 'reads only');

  // A factory without `job board` says so instead of a blank board.
  P._setCall(async () => { throw Object.assign(new Error('factory unsupported_command: no `board`'), { code: 'unsupported_command' }); });
  assert.match((await P.board()).error, /JOBS-API v1\.11/);
  P._setCall(null);

  // ---- the job view's board fields --------------------------------------------------
  const v = F.jobView({
    job_id: 'widget:015', title: 't', state: 'blocked', kind: 'code', runtime: 'claude_session',
    paused: { runtime: 'claude_session', until: '2026-11-09T15:00:00Z', why: 'paused: Claude limit, resumes 15:00' },
    policy: { caps: { budget_usd: 30, wall_clock_h: 4, max_rounds: 20, used: { spend_usd: 3.5, rounds: 2, wall_s: 600 } } },
    runs: [{ id: 5, state: 'running', runtime: 'claude_session', viewable: true }, { id: 4, state: 'ok', runtime: 'api' }],
  });
  assert.deepStrictEqual(v.paused, { runtime: 'claude_session', until: '2026-11-09T15:00:00.000Z', why: 'paused: Claude limit, resumes 15:00' });
  assert.deepStrictEqual(v.caps, { budgetUsd: 30, wallClockH: 4, maxRounds: 20, used: { spendUsd: 3.5, rounds: 2, wallS: 600 } });
  assert.deepStrictEqual(v.runs.map((r) => r.viewable), [true, false]);
  assert.strictEqual(F.jobView({ job_id: 'a:1', state: 'done' }).caps, null);

  console.log('factoryBoardView ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
