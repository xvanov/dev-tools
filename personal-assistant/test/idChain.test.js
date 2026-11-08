'use strict';

// Plan E1: one id chain, card -> run -> job -> step -> session -> PR, stored as
// links (sql/033 run_pr / run_step, termhub session `links`) and returned by
// the board, Build, the card detail and the chat's MCP tools, never read off a
// title.
//
// What earns a test: a job's status becomes run_pr / run_step rows with the PR
// number (v1.4 `pr_number`, else from the URL) and each step's session, and
// nothing outside the contract's shapes gets through (a non-http URL, a session
// id that is not an id, a date that is not a date); the run's own PR (mr_url)
// shows even with nothing stored; the session links sent to termhub hold ids
// only; the worker's pass records the chain; a follow session names its job,
// run and card; and the MCP views carry steps, sessions and PR numbers.
// Names are invented.

const assert = require('assert');
const http = require('http');
const path = require('path');

process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_FACTORY_UV = '/home/tester/.local/bin/uv';

const F = require('../src/dispatch/factoryCore');
const T = require('../src/dispatch/termhub');
const C = require('../src/mcp/chatTools.ts');

// --- PR numbers -----------------------------------------------------------------------
assert.strictEqual(F.prNumber(12, 'https://github.com/o/r/pull/99'), 12, 'the factory\'s pr_number wins');
assert.strictEqual(F.prNumber(null, 'https://github.com/o/r/pull/99'), 99);
assert.strictEqual(F.prNumber(undefined, 'https://github.com/o/r/pull/99/files'), 99);
assert.strictEqual(F.prNumber(0, 'https://github.com/o/r'), null);

// --- a job's status -> run_pr / run_step rows -------------------------------------------
const job = {
  job_id: 'widget:031',
  stories: [
    { id: 5, pr_url: 'https://github.com/acme/widget/pull/7', pr_number: 7, pr_state: 'open', ci: { state: 'failing', failing: ['test (ubuntu)'] } },
    { id: 6, pr_url: 'https://github.com/acme/widget/pull/8', pr_state: 'merged', ci: null },
    { id: 7, pr_url: 'javascript:alert(1)' },
    { id: 8, pr_url: null },
  ],
  pr_urls: ['https://github.com/acme/widget/pull/7', 'https://github.com/acme/widget/pull/9'],
  runs: [
    { id: 9001, job_id: 'widget:031', story_id: 5, persona: 'dev', runtime: 'claude_session', model: 'claude_session/opus', state: 'running',
      started_at: '2026-11-07T10:00:00+00:00', ended_at: null,
      session: { machine: 'forge', termhub_session_id: 'sab12', url: 'https://forge.example/#session=sab12', links: { job: 'widget:031', step: '9001' } } },
    { id: 9000, story_id: 5, persona: 'dev', runtime: 'api', state: 'failed', started_at: 'not a date', ended_at: '2026-11-07T09:00:00Z', session: null },
    { id: 8999, persona: 'dev', state: 'ok', session: { termhub_session_id: 'a b', url: 'file:///etc/passwd' } },
    { id: '<script>', persona: 'x' },
  ],
};
const chain = F.chainOf(job);
assert.deepStrictEqual(chain.prs.map((p) => [p.number, p.state, p.ci_state, p.story_id]), [[7, 'open', 'failing', 5], [8, 'merged', null, 6], [9, null, null, null]],
  'every http(s) PR once, with its number, state and CI; a pr_urls-only PR too');
assert.deepStrictEqual(chain.prs[0].ci_failing, ['test (ubuntu)']);
assert.deepStrictEqual(chain.steps.map((s) => s.step_id), ['9001', '9000', '8999'], 'a step id that is not an id is dropped');
assert.deepStrictEqual(
  [chain.steps[0].job_id, chain.steps[0].story_id, chain.steps[0].termhub_session_id, chain.steps[0].url, chain.steps[0].machine],
  ['widget:031', 5, 'sab12', 'https://forge.example/#session=sab12', 'forge']
);
assert.strictEqual(chain.steps[1].job_id, 'widget:031', 'a step without job_id (pre-v1.4) takes the job\'s');
assert.strictEqual(chain.steps[1].started_at, null, 'not a date: null');
assert.strictEqual(chain.steps[1].ended_at, '2026-11-07T09:00:00.000Z');
assert.strictEqual(chain.steps[1].termhub_session_id, null, 'an API step has no session yet (E2 adds one)');
assert.strictEqual(chain.steps[2].termhub_session_id, null, 'a session id that is not an id is dropped');
assert.strictEqual(chain.steps[2].url, null, 'only http(s) session links');
assert.deepStrictEqual(F.chainOf(null), { prs: [], steps: [] });

// --- one run's chain, as pages and tools show it ----------------------------------------
{
  const stored = {
    prs: [{ url: 'https://github.com/acme/widget/pull/7', number: 7, state: 'open', ci_state: 'failing', ci_failing: ['lint'], story_id: '5' }],
    steps: [{ step_id: '9001', story_id: '5', persona: 'dev', runtime: 'claude_session', state: 'running', machine: 'forge', termhub_session_id: 'sab12', url: 'https://forge.example/#session=sab12' }],
  };
  const r = F.runChain({ id: '45', commitment_id: '412', status: 'running', route: 'factory', factory_job_id: 'widget:031', factory_state: 'in_progress', termhub_session_id: 'f1', mr_url: 'https://github.com/acme/widget/pull/7' },
    stored, { sessionUrl: 'http://127.0.0.1:7000/#session=f1' });
  assert.deepStrictEqual([r.card, r.run, r.job, r.jobState], ['412', 45, 'widget:031', 'in_progress']);
  assert.deepStrictEqual(r.session, { id: 'f1', url: 'http://127.0.0.1:7000/#session=f1' });
  assert.deepStrictEqual(r.steps[0], { step: '9001', story: 5, persona: 'dev', runtime: 'claude_session', model: null, state: 'running',
    session: { id: 'sab12', machine: 'forge', url: 'https://forge.example/#session=sab12' } });
  assert.strictEqual(r.prs.length, 1, 'mr_url is the same PR: not shown twice');
  assert.deepStrictEqual(r.prs[0], { number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'open', ci: 'failing', ciFailing: ['lint'], story: 5 });

  const claude = F.runChain({ id: 3, commitment_id: 9, status: 'landed', route: 'claude', mr_url: 'https://github.com/o/r/pull/12', factory_job_id: null }, null);
  assert.deepStrictEqual(claude.prs.map((p) => p.number), [12], 'a Claude run\'s PR shows with nothing stored');
  assert.strictEqual(claude.job, null);
  assert.strictEqual(claude.session, null);

  // The chat's view of it.
  assert.deepStrictEqual(C.chainFields(r), {
    steps: [{ step: '9001', story: 5, persona: 'dev', runtime: 'claude_session', state: 'running', session: 'https://forge.example/#session=sab12', session_id: 'sab12' }],
    prs: [{ url: 'https://github.com/acme/widget/pull/7', number: 7, state: 'open', ci: 'failing: lint' }],
  });
  assert.deepStrictEqual(C.chainFields(null), {});
}

// --- termhub session links: ids only ----------------------------------------------------
assert.deepStrictEqual(T.sessionLinks({ card: 412, run: 45, job: 'widget:031', step: null, pr: undefined }), { card: '412', run: '45', job: 'widget:031' });
assert.strictEqual(T.sessionLinks({ card: null, run: undefined }), null);
assert.deepStrictEqual(T.sessionLinks({ job: 'a b', card: '<b>', story: '5' }), { story: '5' });
assert.strictEqual(T.sessionLinks('card=1'), null);

// The chat's sessions view says what termhub says a session belongs to.
assert.deepStrictEqual(C.sessionRow({ id: 's1', title: 't', alive: true, links: { job: 'widget:031', step: '9001', junk: 'x' } }).links, { job: 'widget:031', step: '9001' });
assert.strictEqual(C.sessionRow({ id: 's1', title: 't', alive: true }).links, undefined);

// The detail of a job names each step's story and session, the PR numbers and the card.
{
  const v = F.jobView(job, { id: 45, url: null, card: '412' });
  assert.deepStrictEqual(v.stories.map((s) => s.prNumber), [7, 8, null, null]);
  const d = C.jobDetail(v, { raw: job });
  assert.strictEqual(d.card, '412');
  assert.deepStrictEqual(d.stories.slice(0, 2).map((s) => s.pr_number), [7, 8]);
  assert.deepStrictEqual([d.runs[0].id, d.runs[0].story, d.runs[0].session_id], [9001, 5, 'sab12']);
}

// --- the store side, against a stubbed db and termhub -----------------------------------
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const queries = [];
let stepRows = [];
let prRows = [];
stub('db', {
  async one() { return null; },
  async rows(sql, params) {
    queries.push({ sql, params });
    if (/from run_pr/.test(sql)) return prRows;
    if (/from run_step/.test(sql)) return stepRows;
    return [];
  },
  async query(sql, params) { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; },
});
stub('ledger', { async transition() { return { changed: true }; } });
stub('notify', { async notify() { return { id: 1 }; } });
const created = [];
stub('dispatch/termhub', {
  isLocal: () => true,
  sessionLinks: T.sessionLinks,
  forMachine: () => ({
    async createSession(s) { created.push(s); return { id: `sess-${created.length}` }; },
    async sessionUrl(id) { return `https://hub.example/#session=${id}`; },
  }),
});
const factory = require('../src/dispatch/factory');

(async () => {
  // recordChain: one upsert per PR and per step, with the contract's values.
  queries.length = 0;
  assert.deepStrictEqual(await factory.recordChain(45, job), { prs: 3, steps: 3 });
  const prIns = queries.filter((q) => /insert into run_pr/.test(q.sql));
  const stepIns = queries.filter((q) => /insert into run_step/.test(q.sql));
  assert.strictEqual(prIns.length, 3);
  assert.deepStrictEqual(prIns[0].params.slice(0, 6), [45, 'https://github.com/acme/widget/pull/7', 7, 5, 'open', 'failing']);
  assert.strictEqual(prIns[0].params[6], JSON.stringify(['test (ubuntu)']));
  assert.strictEqual(stepIns.length, 3);
  assert.deepStrictEqual([stepIns[0].params[0], stepIns[0].params[1], stepIns[0].params[2], stepIns[0].params[11], stepIns[0].params[12]],
    [45, '9001', 'widget:031', 'sab12', 'https://forge.example/#session=sab12']);
  assert.ok(stepIns.every((q) => /on conflict \(run_id, step_id\) do update/.test(q.sql)), 'upserts, never duplicates');

  // The worker's pass records it on every poll, changed or not.
  queries.length = 0;
  await factory.apply({ id: 45, status: 'running', factory_state: 'in_progress', commitment_id: 412, task: 't', cost_usd: 0 },
    { ...job, state: 'in_progress', cost_usd: 0 });
  assert.ok(queries.some((q) => /insert into run_step/.test(q.sql)), 'apply records the chain');

  // chains(): grouped by run, empty for a run with nothing stored.
  prRows = [{ run_id: '45', url: 'https://github.com/acme/widget/pull/7', number: 7 }];
  stepRows = [{ run_id: '45', step_id: '9001' }, { run_id: '45', step_id: '9000' }];
  const got = await factory.chains([45, 46, 'x']);
  assert.deepStrictEqual([...got.keys()], ['45', '46']);
  assert.strictEqual(got.get('45').steps.length, 2);
  assert.strictEqual(got.get('46').prs.length, 0);

  // A follow session names its job, and the run and card that started it.
  await factory.openFollow('widget:031', 'pa#45 factory', { card: 412, run: 45 });
  assert.deepStrictEqual(created.at(-1).links, { card: 412, run: 45, job: 'widget:031' });
  await factory.openFollow('widget:031');
  assert.deepStrictEqual(created.at(-1).links, { job: 'widget:031' });

  // The real client puts the links in the POST body, and leaves them out when there are none.
  delete require.cache[require.resolve('../src/dispatch/termhub')];
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { bodies.push(JSON.parse(raw || '{}')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"s1"}'); });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const real = require('../src/dispatch/termhub').client(`http://127.0.0.1:${server.address().port}`);
  await real.createSession({ cwd: '/tmp', command: '', title: 't', links: { card: 412, run: 45, job: 'widget:031' } });
  await real.createSession({ cwd: '/tmp', command: '', title: 't' });
  server.close();
  assert.deepStrictEqual(bodies[0].links, { card: '412', run: '45', job: 'widget:031' });
  assert.strictEqual(bodies[1].links, undefined, 'an older termhub never sees the field unless there are links');

  console.log('id chain ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
