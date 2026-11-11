'use strict';

// The Build board (src/dashboard/build.board.client.js, buildBoard.ts, D30):
// its pure half (durations, the timeline lanes, result links, paging, order),
// the browser file's hygiene, and the API through the dashboard's handler on a
// throwaway SQLite store: one page of runs with messages and tracks, needs-you,
// and Stop / reply / send behind X-PA.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const dash = path.join(__dirname, '..', 'src', 'dashboard');
const B = require('../src/dashboard/build.board.client.js');

// ---- pure ---------------------------------------------------------------------

assert.deepStrictEqual([B.dur(45_000), B.dur(12 * 60_000), B.dur(65 * 60_000), B.dur(-5)], ['45s', '12m', '1h 05m', '0s']);
assert.strictEqual(B.money(0.1234), '$0.12');
assert.strictEqual(B.resultLink('https://github.com/a/b/pull/3'), 'https://github.com/a/b/pull/3');
assert.strictEqual(B.resultLink('C:\\reports\\x.md'), null);
assert.strictEqual(B.resultLink('opened https://x.test/1 for review'), null);
assert.deepStrictEqual([B.pageCount(0), B.pageCount(10), B.pageCount(11), B.pageCount(35)], [1, 1, 2, 4]);

const t0 = Date.parse('2026-11-10T12:00:00Z');
assert.deepStrictEqual(['2026-11-10T14:10:00Z', '2026-11-10T12:20:00Z', '2026-11-14T12:00:00Z', '2026-11-10T11:00:00Z', 'x', null].map((r) => B.resetsIn(r, t0)), ['resets in 2h 10m', 'resets in 20m', 'resets in 4d', '', '', '']);
{
  const hot = B.meterView({ label: 'Weekly Fable', percent: 41.5, severity: 'normal', model: 'Fable' }, 'fable');
  assert.deepStrictEqual([hot.highlight, hot.text, hot.width, hot.severity], [true, '42%', 41.5, 'normal']);
  assert.strictEqual(B.meterView({ percent: 41, model: 'Fable' }, 'sonnet').highlight, false);
  assert.strictEqual(B.meterView({ percent: 41 }, 'fable').highlight, false);
  assert.strictEqual(B.meterView({ percent: 41, model: 'Claude Fable 5.1' }, 'claude-fable-5-1').highlight, true, 'a longer display name still lights');
  assert.strictEqual(B.meterView({ percent: 41, model: 'Claude Fable 5.1' }, 'claude-sonnet-5-5').highlight, false, '"claude" alone does not');
  assert.strictEqual(B.meterView({ percent: 95 }, '').severity, 'critical');
  assert.strictEqual(B.meterView({ percent: 250 }, '').width, 100);
  assert.strictEqual(B.meterView(null, '').text, '0%');
}

{
  const run = {
    id: 1, state: 'running', started_at: '2026-11-10T10:00:00Z', ended_at: null,
    agents: [
      { id: 'main', kind: 'main', state: 'running', started_at: '2026-11-10T10:00:00Z', ended_at: null, errors: 0, calls: [{ at: '2026-11-10T10:01:00Z', name: 'Bash', ok: true, args: 'ls' }] },
      { id: 'a1', kind: 'subagent', type: 'general-purpose', description: 'survey', state: 'done', started_at: '2026-11-10T10:01:00Z', ended_at: '2026-11-10T10:02:00Z', errors: 1, calls: [{ at: '2026-11-10T10:01:30Z', name: 'Grep', ok: false, args: 'x' }] },
    ],
  };
  const L = B.lanes(run, '2026-11-10T10:04:00Z');
  assert.deepStrictEqual(L.lanes.map((l) => [l.id, l.live, l.failed]), [['main', true, false], ['a1', false, true]]);
  assert.strictEqual(L.lanes[1].label, 'general-purpose: survey');
  const sub = L.lanes[1];
  assert.ok(Math.abs(sub.left - 25) < 0.01 && Math.abs(sub.width - 25) < 0.01, `a1 spans 1-2 of 4 minutes: ${sub.left} ${sub.width}`);
  assert.ok(Math.abs(L.lanes[0].width - 100) < 0.01, 'a working agent runs to now');
  assert.ok(Math.abs(sub.ticks[0].pct - 37.5) < 0.01 && sub.ticks[0].ok === false);
  // An ended run: nothing pulses.
  const ended = B.lanes({ ...run, state: 'done', ended_at: '2026-11-10T10:03:00Z', agents: run.agents.map((a) => ({ ...a, state: 'done', ended_at: a.ended_at || '2026-11-10T10:03:00Z' })) }, '2026-11-10T11:00:00Z');
  assert.ok(ended.lanes.every((l) => !l.live), 'static bars for ended runs');
  assert.strictEqual(B.lanes({ ...run, agents: [] }, '2026-11-10T10:04:00Z').lanes.length, 0);

  const ask = { id: 3, state: 'waiting', messages: [{ kind: 'ask', answered: false }] };
  const live = { id: 5, state: 'running', messages: [] };
  const old = { id: 9, state: 'done', messages: [{ kind: 'ask', answered: true }] };
  assert.deepStrictEqual(B.order([old, live, ask]).map((r) => r.id), [3, 5, 9]);
  assert.strictEqual(B.elapsed({ started_at: '2026-11-10T10:00:00Z', ended_at: '2026-11-10T10:02:00Z' }, 'x'), 120_000);
}

// The browser file: parses, no HTML sink (an agent wrote every text it shows), relative URLs.
{
  const src = fs.readFileSync(path.join(dash, 'build.board.client.js'), 'utf8');
  new vm.Script(src, { filename: 'build.board.client.js' });
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.ok(!/fetch\('\//.test(src), 'relative URLs only (termhub /pa/ proxy)');
}

// ---- the API ----------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-board-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_board.sqlite');
process.env.PA_SQLITE_KEY = 'build-board-test-key';
process.env.PA_WORKTREES_ROOT = dir;
const { available } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build board API: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const termhub = require('../src/dispatch/termhub.ts');
  const notify = require('../src/notify/notify.ts');
  notify.notify = async () => null;
  const typed = [];
  const killed = [];
  termhub.say = async (id, text) => { typed.push([id, text]); };
  termhub.killSession = async (id) => { killed.push(id); return true; };
  termhub.sessionUrl = async (id) => `http://hub/#session=${id}`;
  const server = require('../src/dashboard/server.ts');
  const call = (method, url, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const { Readable } = require('stream');
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:7300', ...headers } });
    const res = {
      status: 0, headers: {}, body: '', headersSent: false,
      writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; },
      end(b) { this.body = String(b || ''); resolve(this); },
    };
    server.handle(req, res).catch(reject);
  });
  const json = (r) => JSON.parse(r.body);
  const X = { 'x-pa': '1' };
  try {
    await require('../src/db/migrate.ts').migrate();
    const mk = async (task, patch = {}) => {
      const r = await repo.buildRuns.insert({ task, model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
      await repo.buildRuns.update(r.id, { state: 'running', session_id: `s-${r.id}`, ...patch });
      return r;
    };
    const a = await mk('first', { cost_usd: 0.5, track: JSON.stringify({ totals: { calls: 1 }, agents: [{ id: 'main', kind: 'main', state: 'running', calls: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, name: 'Bash', args: 'ls', at: '2026-11-10T10:00:00Z', ok: true })) }] }) });
    const b = await mk('second');
    for (let i = 0; i < 11; i++) await repo.buildRuns.update((await mk(`filler ${i}`)).id, { state: 'done' });
    await repo.buildRuns.addMsg({ runId: b.id, dir: 'agent', kind: 'note', body: 'hello' });
    const q = await repo.buildRuns.addMsg({ runId: b.id, dir: 'agent', kind: 'ask', body: 'which?' });

    const p1 = json(await call('GET', '/api/build'));
    assert.deepStrictEqual([p1.runs.length, p1.total, p1.page, p1.limit, p1.live], [10, 13, 1, 10, 2]);
    assert.strictEqual(json(await call('GET', '/api/build?page=2')).runs.length, 3);
    assert.ok(p1.runs[0].id > p1.runs[9].id, 'newest first');
    assert.deepStrictEqual(p1.needs_you.map((n) => [n.run, n.question]), [[b.id, 'which?']]);
    assert.ok(p1.today_usd >= 0.5);
    const p2 = json(await call('GET', '/api/build?limit=50'));
    const first = p2.runs.find((r) => r.id === a.id);
    assert.strictEqual(first.agents[0].calls.length, 40, 'the card carries the last calls only');
    assert.strictEqual(first.url, `http://hub/#session=${encodeURIComponent(`s-${a.id}`)}`);
    const second = p2.runs.find((r) => r.id === b.id);
    assert.deepStrictEqual(second.messages.map((m) => [m.from, m.kind, m.answered]), [['agent', 'note', false], ['agent', 'ask', false]]);

    // actions: X-PA guarded
    assert.strictEqual((await call('POST', `/api/build/${b.id}/reply`, { body: { text: 'x' } })).status, 403);
    assert.strictEqual((await call('POST', `/api/build/${b.id}/reply`, { headers: X, body: { text: '   ' } })).status, 400);
    assert.deepStrictEqual(json(await call('POST', `/api/build/${b.id}/reply`, { headers: X, body: { text: 'sqlite' } })), { id: b.id, answered: true });
    assert.strictEqual((await repo.buildRuns.msgById(q.id)).answer, 'sqlite');
    assert.strictEqual((await call('POST', `/api/build/${b.id}/reply`, { headers: X, body: { text: 'again' } })).status, 400, 'no open ask now');
    assert.deepStrictEqual(json(await call('POST', `/api/build/${b.id}/send`, { headers: X, body: { text: 'go on' } })), { id: b.id, sent: true });
    assert.deepStrictEqual(typed, [[`s-${b.id}`, 'go on']]);
    assert.deepStrictEqual(json(await call('POST', `/api/build/${b.id}/stop`, { headers: X })), { id: b.id, state: 'stopped' });
    assert.deepStrictEqual(killed, [`s-${b.id}`]);
    assert.strictEqual((await call('POST', '/api/build/99999/stop', { headers: X })).status, 404);
    assert.strictEqual((await call('POST', '/api/build/runs', { headers: X, body: { task: '  ' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/build/runs', { headers: X, body: { task: 'x', model: 'gpt' } })).status, 400);

    const js = await call('GET', '/build-board.js');
    assert.strictEqual(js.status, 200);
    const page = await call('GET', '/factory');
    assert.match(page.body, /src="build-board\.js"/);
    assert.match(page.body, /name="pa-page"/);
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('build board ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
