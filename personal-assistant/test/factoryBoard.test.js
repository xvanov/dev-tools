'use strict';

// The factory as the dispatcher of all work (JOBS-API v1.2): job kinds and
// runtimes on submit, the clean fallback to a v1 factory, the /factory page's
// data (grouping, spend, approve), the notices a poll raises, and the default
// route. The factory's CLI and the store are stubbed; names are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-factory-board-'));
process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_FACTORY_UV = '/home/tester/.local/bin/uv';
process.env.PA_WORKTREES_ROOT = tmp;
delete process.env.PA_DISPATCH_VIA;
delete process.env.PA_FACTORY_PIPELINE;

const F = require('../src/dispatch/factoryCore.ts');
const R = require('../src/dispatch/routeCore.ts');
const { config } = require('../src/config.ts');

// --- config: the factory is the default route once configured; solo pipeline ----

assert.strictEqual(config.factory.via, 'factory', 'PA_FACTORY_PATH set, PA_DISPATCH_VIA unset: the factory');
assert.strictEqual(config.factory.pipeline, 'solo');
assert.strictEqual(config.factory.runtime, 'api');
assert.strictEqual(R.defaultVia({ configured: 'factory' }), 'factory');
assert.strictEqual(R.defaultVia({ configured: 'factory', mode: 'plan' }), 'claude', 'plan mode is read-only: a Claude session');
assert.strictEqual(R.defaultVia({ configured: 'factory', machine: 'lab' }), 'claude', '--machine picks a Claude session');
assert.strictEqual(R.defaultVia({ configured: 'claude' }), 'claude');
assert.strictEqual(R.defaultVia({ configured: 'auto', mode: 'mr' }), 'auto');
assert.strictEqual(R.defaultVia({}), 'claude');

// --- kinds and runtimes ---------------------------------------------------------

assert.deepStrictEqual(F.KINDS, ['code', 'research', 'report']);
assert.strictEqual(F.jobKind(), 'code');
assert.strictEqual(F.jobKind('Research'), 'research');
assert.throws(() => F.jobKind('poem'), /unknown kind/);
assert.strictEqual(F.runtime(), 'api');
assert.strictEqual(F.runtime('claude-session'), 'claude_session');
assert.strictEqual(F.runtime('subscription'), 'claude_session');
assert.throws(() => F.runtime('gpu'), /unknown runtime/);
assert.deepStrictEqual(F.factoryArgv(['job', 'list', '--json'], '/home/tester/.local/bin/uv').slice(0, 3), ['/home/tester/.local/bin/uv', 'run', 'factory']);
assert.throws(() => F.factoryArgv(['x'], 'uv; rm -rf ~'), /PA_FACTORY_UV/, 'typed into a shell by the walk-in: no shell syntax');
assert.strictEqual(F.followCommand('widget:017', '/opt/uv'), '/opt/uv run factory job follow widget:017');
// A native Windows factory: a drive-letter path to uv.exe is a path, not syntax.
assert.strictEqual(F.uvBinary('C:\\Users\\tester\\.local\\bin\\uv.exe'), 'C:\\Users\\tester\\.local\\bin\\uv.exe');
assert.throws(() => F.uvBinary('C:\\Program Files\\uv.exe'), /PA_FACTORY_UV/, 'no spaces: the walk-in types it into a shell');
assert.throws(() => F.uvBinary('uv & calc'), /PA_FACTORY_UV/);

// --- the v1.2 submit command line ---------------------------------------------------

{
  const code = F.submitArgv({ app: 'widget', title: 't', askFile: '/a', delivery: 'draft_pr', externalId: 1, kind: 'code', runtime: 'claude_session' });
  assert.deepStrictEqual(code.slice(code.indexOf('--kind'), code.indexOf('--kind') + 4), ['--kind', 'code', '--runtime', 'claude_session']);
  const plain = F.submitArgv({ app: 'widget', title: 't', askFile: '/a', delivery: 'draft_pr', externalId: 1 });
  assert.ok(!plain.includes('--kind') && !plain.includes('--runtime'), 'v1 callers send nothing new');
  const research = F.submitArgv({ title: 'Why is the export slow?', askFile: '/a', delivery: 'none', externalId: 2, kind: 'research', runtime: 'api' });
  assert.ok(!research.includes('--app'), 'a research job needs no app');
  assert.ok(research.includes('--kind') && research[research.indexOf('--kind') + 1] === 'research');
  assert.throws(() => F.submitArgv({ title: 't', askFile: '/a', delivery: 'draft_pr', externalId: 2, kind: 'research' }), /delivery is none/);
  assert.throws(() => F.submitArgv({ title: 't', askFile: '/a', delivery: 'none', externalId: 2, kind: 'code' }), /factory app/);
  global.__argvPair = { code, plain };
}

// --- the research ask: the operator's words and the questions ----------------------

{
  const ask = F.researchAsk({ kind: 'research', title: 'Export latency', ask: 'Why did the nightly export get slow last week?', done: ['what changed', 'how to fix'], repo: 'acme/widget' });
  assert.match(ask, /^# Research: Export latency\n/);
  assert.match(ask, /No code changes, no branch, no PR\./);
  assert.match(ask, /## The ask\n\nWhy did the nightly export get slow last week\?/);
  assert.match(ask, /Repository: acme\/widget \(read it; change nothing\)\./);
  assert.match(ask, /## Questions it must answer\n\n- what changed\n- how to fix\n$/);
  assert.match(F.researchAsk({ kind: 'report', title: 'Q3 summary' }), /^# Write: Q3 summary\n[\s\S]*The ask\n\nQ3 summary\n$/);
  assert.throws(() => F.researchAsk({ kind: 'code', title: 'x' }), /research and report/);
  assert.doesNotMatch(F.researchAsk({ kind: 'research', title: 't', ask: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here' }), /ghp_abcdefghijklmnop/, 'secrets redacted');
}

// --- a v1 factory's refusals, as typer prints them ------------------------------------

{
  const box = (msg) => `Usage: factory job submit [OPTIONS]\nTry 'factory job submit --help' for help.\n╭─ Error ─╮\n│ ${msg} │\n╰─────────╯\n`;
  let e = null;
  try { F.parseResult({ code: 2, stdout: '', stderr: box("No such option '--kind'.") }); } catch (err) { e = err; }
  assert.ok(e instanceof F.FactoryError && e.code === 'unsupported_option' && /--kind/.test(e.message));
  assert.ok(F.isRefusal(e), 'the parser stops before anything is written: a refusal');
  e = null;
  try { F.parseResult({ code: 2, stdout: '', stderr: box("No such command 'report'.") }); } catch (err) { e = err; }
  assert.ok(e instanceof F.FactoryError && e.code === 'unsupported_command');
  for (const c of ['invalid_kind', 'invalid_runtime', 'runtime_unavailable']) assert.ok(F.REFUSAL_CODES.has(c), c);
  e = null;
  try { F.parseResult({ code: 2, stdout: '', stderr: 'something else broke' }); } catch (err) { e = err; }
  assert.strictEqual(e.code, 'bad_output', 'an exit 2 that is not the parser is still not a refusal');
}

// --- approve only what the factory named, for this job -------------------------------------

{
  const job = { job_id: 'widget:015', state: 'needs_human', warnings: ['waiting for approval: run `factory approve-direction 015 --app widget`'] };
  assert.deepStrictEqual(F.approveArgv(job).slice(0, 4), ['approve-direction', '015', '--app', 'widget']);
  assert.ok(F.approveArgv({ ...job, warnings: [], why: 'factory approve-direction 015-add-retries --app widget' }), 'the id-slug form');
  assert.strictEqual(F.approveArgv({ ...job, warnings: ['factory approve-direction 099 --app widget'] }), null, 'another direction: no');
  assert.strictEqual(F.approveArgv({ ...job, warnings: ['factory approve-direction 015 --app gadget'] }), null, 'another app: no');
  assert.strictEqual(F.approveArgv({ ...job, state: 'in_progress' }), null);
  assert.strictEqual(F.approveArgv({ ...job, warnings: ['no approval named'] }), null);
}

// --- one job as the page shows it ----------------------------------------------------------

const V1_JOB = {
  job_id: 'widget:005', app: 'widget', title: 'Report the build version', source: 'human', state: 'failed', terminal: true,
  pipeline: 'solo', delivery: 'draft_pr', stories: [{ id: 189, state: 'closed_by_operator', pr_url: 'https://github.com/acme/widget/pull/11', pr_state: null, ci: null }],
  pr_urls: ['https://github.com/acme/widget/pull/11'], merged: false, cost_usd: 2.8882, updated_at: '2026-11-02T19:26:30+00:00', why: 'PR #11 was closed',
};
{
  const v = F.jobView(V1_JOB);
  assert.deepStrictEqual([v.kind, v.runtime, v.group, v.report, v.runs, v.subscriptionEquivUsd, v.canCancel], ['code', 'api', 'ended', null, [], 0, false], 'a v1 job: code on api, nothing new');
  assert.strictEqual(v.stories[0].prUrl, 'https://github.com/acme/widget/pull/11');
  const v12 = F.jobView({
    job_id: 'scratch:003', title: 'Why is the export slow?', state: 'in_progress', kind: 'research', runtime: 'claude_session',
    cost_usd: 0, subscription_equiv_usd: 1.25, report: null,
    runs: [{ id: 'r1', persona: 'researcher', runtime: 'claude_session', model: 'claude-sonnet-5-5', state: 'running', cost_usd: 0, billing: 'subscription',
      started_at: '2026-11-06T10:00:00Z', ended_at: null, session: { machine: 'forge', termhub_session_id: 's9', url: 'https://forge.example:7443/#session=s9' } },
    { id: 'r0', state: 'ok', session: { url: 'javascript:alert(1)' } }],
  }, { id: 42, url: 'https://hub.example/#session=x' });
  assert.deepStrictEqual([v12.kind, v12.runtime, v12.group, v12.canCancel], ['research', 'claude_session', 'running', true]);
  assert.strictEqual(v12.runs[0].session.url, 'https://forge.example:7443/#session=s9', 'a live run links to its termhub session');
  assert.strictEqual(v12.runs[1].session, null, 'only http(s) links reach the page');
  assert.deepStrictEqual(v12.paRun, { id: 42, url: 'https://hub.example/#session=x', card: null });
  // Plan E1: the step's session id, and the PA run's card, so Build links back to Plan.
  assert.strictEqual(v12.runs[0].session.id, 's9');
  assert.deepStrictEqual(F.jobView({ job_id: 'a:1' }, { id: 7, url: null, card: 412 }).paRun, { id: 7, url: null, card: '412' });
  assert.strictEqual(F.jobView({ job_id: 'a:1' }, { id: 7, url: null, card: 'x<y' }).paRun.card, null, 'a card id is a number');
  const red = F.jobView({ job_id: 'widget:007', state: 'in_progress', stories: [{ id: 1, pr_url: 'https://github.com/acme/widget/pull/3', ci: { state: 'failing', failing: ['test (ubuntu)'] } }] });
  assert.strictEqual(red.group, 'needs_you', 'red CI on a live job needs you');
  assert.deepStrictEqual(red.stories[0].ci, { state: 'failing', failing: ['test (ubuntu)'] });
  assert.strictEqual(F.groupOf({ state: 'needs_human' }), 'needs_you');
  assert.strictEqual(F.groupOf({ state: 'blocked' }), 'needs_you');
  assert.strictEqual(F.groupOf({ state: 'done' }), 'delivered');
  assert.strictEqual(F.groupOf({ state: 'cancelled' }), 'ended');
  assert.strictEqual(F.groupOf({ state: 'queued' }), 'running');
}

// --- the page: grouped, newest first, and the spend line -------------------------------------

{
  const jobs = [
    V1_JOB,
    { job_id: 'widget:009', title: 'b', state: 'done', cost_usd: 1.5, subscription_equiv_usd: 0.5, updated_at: '2026-11-06T09:00:00Z' },
    { job_id: 'widget:010', title: 'c', state: 'in_progress', cost_usd: 0.25, subscription_equiv_usd: 2, updated_at: '2026-11-06T11:00:00Z' },
    { job_id: 'widget:011', title: 'd', state: 'queued', updated_at: '2026-11-06T12:00:00Z' },
    { job_id: 'not a job id', state: 'done' },
  ];
  const b = F.board(jobs, { paSpendToday: 0.4567, now: new Date('2026-11-06T18:00:00Z') });
  assert.deepStrictEqual(b.counts, { needs_you: 0, running: 2, delivered: 1, ended: 1 });
  assert.deepStrictEqual(b.groups.running.map((j) => j.jobId), ['widget:011', 'widget:010'], 'newest first');
  assert.deepStrictEqual(b.spend.factoryToday, { metered: 1.75, subscriptionEquiv: 2.5, jobs: 3 });
  assert.deepStrictEqual(b.spend.factoryListed, { metered: 4.64, subscriptionEquiv: 2.5, jobs: 4 });
  assert.strictEqual(b.spend.paToday, 0.46);
  assert.strictEqual(F.board([], {}).spend.paToday, null);
}

// --- what a poll tells the user ---------------------------------------------------------------

{
  const jobs = [
    { job_id: 'widget:020', title: 'Add retries', state: 'done', pr_urls: ['https://github.com/acme/widget/pull/5'] },
    { job_id: 'scratch:004', title: 'Summarise Q3', kind: 'report', state: 'done', report: { excerpt: 'Q3 in one page.' } },
    { job_id: 'widget:021', title: 'Fix login', state: 'needs_human', why: 'needs a flow.md' },
    { job_id: 'widget:022', title: 'Cache it', state: 'failed', why: 'gates red' },
    { job_id: 'widget:023', title: 'Theme', state: 'in_progress', stories: [{ id: 7, pr_url: 'https://github.com/acme/widget/pull/9', ci: { state: 'failing', failing: ['lint'] } }] },
  ];
  assert.deepStrictEqual(F.notices(null, jobs), [], 'the first snapshot replays nothing');
  const prev = new Map([
    ['widget:020', { state: 'in_progress', ciFailing: false }],
    ['scratch:004', { state: 'in_progress', ciFailing: false }],
    ['widget:021', { state: 'triaging', ciFailing: false }],
    ['widget:022', { state: 'in_progress', ciFailing: false }],
    ['widget:023', { state: 'in_progress', ciFailing: false }],
  ]);
  const said = F.notices(prev, jobs);
  assert.deepStrictEqual(said.map((n) => n.key), [
    'factory-job:widget:020:done', 'factory-job:scratch:004:done', 'factory-job:widget:021:needs_human', 'factory-job:widget:022:failed', 'factory-ci:widget:023:7',
  ]);
  assert.strictEqual(said[0].url, 'https://github.com/acme/widget/pull/5');
  assert.match(said[1].title, /Factory report job scratch:004 done/);
  assert.match(said[1].body, /Q3 in one page/);
  assert.match(said[2].title, /needs you/);
  assert.match(said[4].body, /- lint/);
  assert.deepStrictEqual(F.notices(F.noticeState(jobs), jobs), [], 'nothing new: nothing said');
  const covered = F.notices(prev, jobs, { covered: new Set(['widget:020', 'widget:023']) }).map((n) => n.key);
  assert.ok(!covered.includes('factory-job:widget:020:done'), 'a PA run announces its own job');
  assert.ok(covered.includes('factory-ci:widget:023:7'), 'but its red CI is said here');
}

// --- factory.js against a stubbed store, termhub and factory CLI ------------------------------

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const store = { queries: [], board: null, nextId: 50 };
const INSTALL = '0f1e2d3c-4b5a-6978-8a9b-acbdcedf0099';
stub('db', {
  async one(sql, params) {
    store.queries.push({ sql, params });
    if (/insert into run/.test(sql)) return { id: store.nextId, status: 'starting', external_id: `${INSTALL}-${store.nextId}` };
    if (/from pa_install/.test(sql)) return { id: INSTALL };
    if (/from factory_board/.test(sql)) return store.board;
    if (/from repo_delivery/.test(sql)) return null;
    return null;
  },
  async rows(sql, params) {
    store.queries.push({ sql, params });
    if (/distinct factory_job_id/.test(sql)) return store.ours || [];
    return [];
  },
  async query(sql, params) {
    store.queries.push({ sql, params });
    if (/insert into factory_board \(id, jobs/.test(sql)) store.board = { jobs: JSON.parse(params[0]), polled_at: new Date() };
    return { rowCount: 1, rows: [] };
  },
  async withTx(fn) {
    return fn({ async query(sql, params) {
      if (/pg_advisory_xact_lock|select id from run where commitment_id/.test(sql)) return { rows: [] };
      return { rows: [await require('../src/db').one(sql, params)] };
    } });
  },
});
stub('ledger', { async transition() { return { changed: true }; } });
const notes = [];
stub('notify', { async notify(n) { notes.push(n); return { id: notes.length }; } });
const sessions = [];
stub('dispatch/termhub.ts', {
  isLocal: () => true,
  forMachine: () => ({
    async createSession(s) { sessions.push(s); return { id: `sess-${sessions.length}` }; },
    async sessionUrl(id) { return `https://hub.example/#session=${id}`; },
  }),
});

const factory = require('../src/dispatch/factory.ts');
assert.deepStrictEqual(factory.withoutV12(global.__argvPair.code), global.__argvPair.plain, 'the v1 resend is the same argv minus kind/runtime');
let calls = [];
let answer = null;
factory._setRunner(async (machine, argv, opts) => {
  calls.push({ machine, argv, opts });
  return answer(argv, opts);
});
const json = (o, code = 0) => ({ code, stdout: JSON.stringify(o), stderr: '' });
const V1_REFUSAL = { code: 2, stdout: '', stderr: "Usage: factory job submit [OPTIONS]\n│ No such option '--kind'. │\n" };
const isV1 = (argv) => argv.includes('--kind') || argv.includes('--runtime');

(async () => {
  const target = { commitment: null, repoPath: null };

  // A code job against a v1 factory: refused for the flags, resent without them.
  {
    calls = [];
    answer = (argv) => (isV1(argv) ? V1_REFUSAL : json({ job_id: 'widget:030', app: 'widget', pipeline: 'solo', delivery: 'draft_pr', created: true, warnings: [] }));
    require('../src/dispatch/compose.ts')._setModel(async () => JSON.stringify({ goal: 'g', done: [], constraints: [], decisions: [], facts: [], reuse: [], questions: [] }));
    const r = await factory.start({ target, app: 'widget', task: 'Add retries to the export', delivery: 'draft_pr' });
    const submits = calls.filter((c) => c.argv.includes('submit'));
    assert.strictEqual(submits.length, 2, 'once with the v1.2 flags, once without');
    assert.ok(isV1(submits[0].argv) && !isV1(submits[1].argv));
    assert.strictEqual(submits[0].argv[0], '/home/tester/.local/bin/uv', 'PA_FACTORY_UV');
    assert.deepStrictEqual([r.jobId, r.jobKind, r.runtime], ['widget:030', 'code', 'api']);
    assert.strictEqual(sessions[0].command, '/home/tester/.local/bin/uv run factory job follow widget:030');
  }

  // A research job against a v1 factory: it needs v1.2 — the run fails, said plainly.
  {
    calls = [];
    store.queries = [];
    answer = (argv) => (isV1(argv) ? V1_REFUSAL : json({ job_id: 'x:1', created: true }));
    await assert.rejects(factory.start({ target, task: 'Why is the export slow?', jobKind: 'research' }), /research job on the api runtime needs it/);
    assert.strictEqual(calls.filter((c) => c.argv.includes('submit')).length, 1, 'not resent without the kind');
    assert.ok(store.queries.some((q) => /update run set status = 'failed'/.test(q.sql)), 'the run is failed, not left starting');
  }

  // A research job against a v1.2 factory: no app, no flow, delivery none, the operator's ask.
  {
    calls = [];
    store.queries = [];
    let askText = null;
    answer = (argv) => {
      const f = argv.find((a, i) => argv[i - 1] === '--ask-file');
      if (f) askText = fs.readFileSync(f, 'utf8');
      return json({ job_id: 'scratch:005', created: true, kind: 'research', runtime: 'claude_session', delivery: 'none', warnings: [] });
    };
    const r = await factory.start({ target, title: 'Export latency', task: 'Why did the nightly export get slow?', done: ['what changed'], jobKind: 'research', runtime: 'claude_session' });
    const argv = calls.find((c) => c.argv.includes('submit')).argv;
    assert.ok(!argv.includes('--app') && !argv.includes('--flow-file'), 'no app, no flow');
    assert.deepStrictEqual(argv.slice(argv.indexOf('--kind'), argv.indexOf('--kind') + 4), ['--kind', 'research', '--runtime', 'claude_session']);
    assert.strictEqual(argv[argv.indexOf('--delivery') + 1], 'none');
    assert.match(askText, /^# Research: Export latency\n[\s\S]*Why did the nightly export get slow\?[\s\S]*- what changed/);
    const insert = store.queries.find((q) => /insert into run/.test(q.sql));
    assert.deepStrictEqual(insert.params.slice(-2), ['research', 'claude_session'], 'kind and runtime on the run row');
    assert.strictEqual(insert.params[1], 'plan', 'a research job changes nothing: read-only mode on the row');
    assert.deepStrictEqual([r.jobId, r.jobKind, r.runtime, r.delivery], ['scratch:005', 'research', 'claude_session', 'none']);
    await assert.rejects(factory.start({ target, task: 'x', jobKind: 'report', delivery: 'pr' }), /delivers a report/);
  }

  // The board pass: stored, then notices against the previous snapshot.
  {
    store.board = null;
    notes.length = 0;
    calls = [];
    answer = () => json({ jobs: [{ job_id: 'widget:040', title: 'a', state: 'in_progress' }, { job_id: 'bad id', state: 'done' }] });
    assert.deepStrictEqual(await factory.refreshBoard(), { jobs: 1, notices: 0 }, 'first snapshot: nothing said');
    assert.deepStrictEqual(calls[0].argv.slice(3), ['job', 'list', '--json']);
    assert.ok(calls[0].opts.maxOutputBytes >= 4 * 1024 * 1024, 'room for a long list');
    answer = () => json({ jobs: [{ job_id: 'widget:040', title: 'a', state: 'done' }] });
    assert.deepStrictEqual(await factory.refreshBoard(), { jobs: 1, notices: 1 });
    assert.strictEqual(notes[0].dedupeKey, 'factory-job:widget:040:done');
    assert.deepStrictEqual((await factory.snapshot()).jobs.map((j) => j.state), ['done']);
    // A failed list keeps the last snapshot and records why.
    answer = () => ({ code: 124, stdout: '', stderr: '', timedOut: true });
    await assert.rejects(factory.refreshBoard(), /did not answer/);
    assert.ok(store.queries.some((q) => /insert into factory_board \(id, error/.test(q.sql)));
  }

  // Approve: only the approval the snapshot's job names; the factory's text answer is fine.
  {
    store.board = { jobs: [{ job_id: 'widget:015', state: 'needs_human', warnings: ['run factory approve-direction 015 --app widget'] }], polled_at: new Date() };
    calls = [];
    answer = (argv) => (argv.includes('approve-direction') ? { code: 0, stdout: 'approved 015', stderr: '' } : json({ jobs: store.board.jobs }));
    const r = await factory.approve('widget:015');
    assert.ok(r.approved);
    assert.deepStrictEqual(calls[0].argv.slice(3, 7), ['approve-direction', '015', '--app', 'widget']);
    await assert.rejects(factory.approve('widget:099'), /not waiting on an approval/);
    await assert.rejects(factory.approve('../etc'), /not a factory job id/);
  }

  // A report: v1.2 answers it; a v1 factory says it has none, plainly.
  {
    answer = () => json({ job_id: 'scratch:005', title: 'Export latency', markdown: '# Findings\n', path: '/srv/r.md' });
    assert.deepStrictEqual(await factory.report('scratch:005'), { jobId: 'scratch:005', title: 'Export latency', markdown: '# Findings\n', path: '/srv/r.md' });
    answer = () => json({ error: 'no_report' }, 1);
    assert.ok((await factory.report('scratch:005')).none);
    answer = () => ({ code: 2, stdout: '', stderr: "│ No such command 'report'. │" });
    await assert.rejects(factory.report('scratch:005'), /predates JOBS-API v1.2/);
  }

  // Open in termhub: a follow session for any job.
  {
    const s = await factory.openFollow('widget:015');
    assert.match(s.url, /^https:\/\/hub\.example\//);
    assert.throws(() => F.followCommand('widget:015; rm -rf /'), /not a factory job id/);
  }

  // The chat (Jarvis as coordinator): reads on the `pa` tool, acts behind a prompt.
  {
    const chat = require('../src/chat/index.ts');
    const mcp = require('../src/mcp/server.ts');
    for (const v of ['factory jobs', 'factory status', 'factory report']) {
      assert.ok(chat.ALLOW_COMMANDS.includes(v) && mcp.READ_VERBS[v], `${v} reads`);
    }
    for (const v of ['factory submit', 'factory cancel', 'factory approve']) {
      assert.ok(chat.ASK_COMMANDS.includes(v) && !mcp.READ_VERBS[v], `${v} asks first`);
    }
    assert.throws(() => mcp.paToolArgv('factory jobs', ['--force']), /writes/);
    assert.deepStrictEqual(mcp.paToolArgv('factory status', ['widget:015']), ['factory', 'status', 'widget:015']);
    const md = chat.claudeMd();
    // Jobs start through the factory_start tool, which asks on every call; the
    // shell form (`pa factory submit`) still puts a code job on a card.
    assert.match(md, /puts a\s+code job on a card instead/);
    assert.match(md, /only when the user explicitly asked for that research or write-up/);
    const s = chat.settingsJson();
    assert.ok(!s.permissions.allow.some((r) => /^Bash\(.*factory/.test(r)), 'no factory verb is allowed without asking');
    for (const t of chat.CHAT_ACTION_TOOLS) assert.ok(!s.permissions.allow.some((r) => r.endsWith(`__${t}`)), `${t} asks`);
  }

  // The Factory page (dashboard/factory.js): its pure checks, then its routes.
  {
    const P = require('../src/dashboard/factory.ts');
    assert.deepStrictEqual(P.jobAction('/api/factory/jobs/widget%3A015/cancel'), { jobId: 'widget:015', verb: 'cancel' });
    assert.deepStrictEqual(P.jobAction('/api/factory/jobs/widget:015/open'), { jobId: 'widget:015', verb: 'open' });
    assert.strictEqual(P.jobAction('/api/factory/jobs/widget%3A015%3Bls/cancel'), null, 'a job id is checked before anything');
    assert.strictEqual(P.jobAction('/api/factory/jobs/%E0%A4%A/cancel'), null);
    assert.strictEqual(P.jobAction('/api/factory/jobs/widget:015/delete'), null);
    const r = P.newJob({ title: ' Export latency ', ask: 'Why slow?', kind: 'research', runtime: 'claude_session', done: 'what changed\n\nhow to fix' });
    assert.deepStrictEqual([r.title, r.task, r.jobKind, r.runtime, r.repoPath, r.delivery, r.done, r.register, r.via],
      ['Export latency', 'Why slow?', 'research', 'claude_session', null, null, ['what changed', 'how to fix'], false, 'factory']);
    const c = P.newJob({ title: 'Add retries', kind: 'code', repo: 'acme/widget', delivery: 'pr' });
    assert.deepStrictEqual([c.task, c.delivery, c.register, c.runtime], ['Add retries', 'pr', true, 'api']);
    assert.throws(() => P.newJob({ title: 'x', kind: 'code' }), (e) => e.status === 400 && /needs a repo/.test(e.message));
    assert.throws(() => P.newJob({ title: 'x', kind: 'research', delivery: 'pr' }), /end state is none/);
    assert.throws(() => P.newJob({ title: 'x', kind: 'research', repo: '/home/me/../etc' }), /owner\/name/);
    assert.throws(() => P.newJob({ title: '', kind: 'research' }), /title/);
    assert.throws(() => P.newJob({ title: 'x', kind: 'poem' }), (e) => e.status === 400);
    assert.throws(() => P.newJob({ title: 'x', kind: 'code', repo: 'a/b', delivery: 'yolo' }), /unknown delivery/);
    assert.deepStrictEqual(P.pickers().kinds.map((k) => k.value), ['code', 'research', 'report']);

    stub('budget.ts', { async status() { return { today: 0.42, cap: 5 }; } });
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
      // As server.start does: a thrown error's status, else 500.
      server.handle(req, res).catch((err) => {
        if (res.headersSent) return reject(err);
        res.writeHead(err.status || 500, {});
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    const page = await call('GET', '/factory');
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<script src="nav\.js" data-layer="factory"><\/script>/, 'the switcher, as the Factory layer');
    assert.match(page.body, /<link rel="stylesheet" href="theme\.css">/, 'the shared theme');
    assert.match(page.body, /<meta name="pa-page" content="[^"]+">/, 'a page token for unattended levels');
    assert.match(page.body, /src="factory\.js"/, 'relative: works under termhub\'s /pa/');
    const client = await call('GET', '/factory.js');
    assert.doesNotMatch(client.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no HTML sink: agents wrote this text');
    store.board = { jobs: [{ job_id: 'widget:015', title: 'a', state: 'needs_human', warnings: ['factory approve-direction 015 --app widget'] }], polled_at: new Date() };
    const b = JSON.parse((await call('GET', '/api/factory')).body);
    assert.deepStrictEqual([b.enabled, b.counts.needs_you, b.groups.needs_you[0].canApprove, b.spend.paToday], [true, 1, true, 0.42]);
    assert.strictEqual((await call('POST', '/api/factory/jobs/widget:015/cancel')).status, 403, 'X-PA on every POST');
    assert.strictEqual((await call('GET', '/api/factory/report?job=..%2Fx')).status, 400);
    assert.strictEqual((await call('POST', '/api/factory/jobs', { headers: { 'x-pa': '1' }, body: { title: 'x', kind: 'code' } })).status, 400);
    calls = [];
    answer = (argv) => (argv.includes('approve-direction') ? { code: 0, stdout: 'ok', stderr: '' } : json({ jobs: store.board.jobs }));
    const ok = await call('POST', '/api/factory/jobs/widget%3A015/approve', { headers: { 'x-pa': '1' } });
    assert.strictEqual(ok.status, 200);
    assert.ok(calls.some((c) => c.argv.includes('approve-direction')));
    const m = JSON.parse((await call('GET', '/api/machines')).body);
    assert.deepStrictEqual(m.runtimes.map((x) => x.value), ['api', 'claude_session'], 'the card\'s Do gets the runtime picker');
    assert.strictEqual(m.defaultRoute, 'factory');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('factory board ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
