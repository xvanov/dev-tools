'use strict';

// The software factory as a dispatch target (src/dispatch/factory*.js,
// route*.js): PA mode → delivery, the submit command line, the routing rule
// and its guard, job status → run row → ledger, and the local runner.
// The factory's CLI and the store are stubbed; names are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// python3 on POSIX, python on Windows (test/_portable.js)
const PYTHON = require('./_portable').pythonCommand();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-factory-test-'));
process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_FACTORY_MODELS = 'dev=model-a';
process.env.PA_WORKTREES_ROOT = tmp;

const F = require('../src/dispatch/factoryCore.ts');
const R = require('../src/dispatch/routeCore.ts');

// --- delivery is the operator's call, sent on every job (deliveryCore) ---------

{
  const D = require('../src/dispatch/deliveryCore.ts');
  assert.deepStrictEqual(F.DELIVERIES, D.DELIVERIES, 'one vocabulary');
  assert.strictEqual(F.deliveryFor, undefined, 'a PA mode no longer decides a job\'s delivery');
  // Every level, including the two with no human step, can be sent.
  for (const d of D.DELIVERIES) {
    const argv = F.submitArgv({ app: 'w', title: 't', ask: 'x', delivery: d, externalId: 1 });
    assert.deepStrictEqual(argv.slice(argv.indexOf('--delivery'), argv.indexOf('--delivery') + 2), ['--delivery', d]);
  }
  assert.throws(() => F.submitArgv({ app: 'w', title: 't', ask: 'x', externalId: 1 }), /delivery/, 'never sent without one');
}

// --- model overrides and pipelines ------------------------------------------

assert.deepStrictEqual(F.parseModels(['dev=gpt-x', 'reviewer=kimi-k2, pm=deepseek/v4']), { dev: 'gpt-x', reviewer: 'kimi-k2', pm: 'deepseek/v4' });
assert.deepStrictEqual(F.parseModels(['dev=a', 'dev=b']), { dev: 'b' }, 'later wins');
assert.deepStrictEqual(F.parseModels(''), {});
assert.throws(() => F.parseModels(['dev']), /persona=model/);
assert.throws(() => F.parseModels(['dev=a b']), /persona=model/);
assert.strictEqual(F.pipeline(), 'auto');
assert.strictEqual(F.pipeline('SOLO'), 'solo');
assert.throws(() => F.pipeline('swarm'), /unknown pipeline/);

// --- the submit command line ---------------------------------------------------

{
  const argv = F.submitArgv({
    app: 'widget', title: '-starts with a dash', askFile: '/tmp/run-7-BRIEF.md', done: ['- tests pass', 'export has retries'],
    pipeline: 'chain', delivery: 'draft_pr', models: { dev: 'm1' }, externalId: 7,
  });
  assert.deepStrictEqual(argv, [
    'job', 'submit', '--json', '--app', 'widget', '--title=-starts with a dash',
    '--ask-file', '/tmp/run-7-BRIEF.md',
    '--done=- tests pass', '--done=export has retries',
    '--pipeline', 'chain', '--delivery', 'draft_pr', '--model', 'dev=m1',
    '--source', 'pa', '--external-id', '7',
  ]);
  const inline = F.submitArgv({ app: 'w', title: 't', ask: '# Brief\nbody', delivery: 'none', externalId: 1 });
  assert.ok(inline.includes('--ask=# Brief\nbody') && !inline.includes('--ask-file'));
  assert.throws(() => F.submitArgv({ app: 'w', title: 't', ask: 'x', delivery: 'none' }), /external id/);
  assert.throws(() => F.submitArgv({ app: 'w', title: 't', ask: 'x', delivery: 'merge_everything', externalId: 1 }), /delivery/);
  assert.deepStrictEqual(F.factoryArgv(['app', 'list', '--json']), ['uv', 'run', 'factory', 'app', 'list', '--json']);
  const withFlow = F.submitArgv({ app: 'w', title: 't', askFile: '/a', flowFile: '/f/flow.md', delivery: 'none', externalId: 1 });
  assert.deepStrictEqual(withFlow.slice(withFlow.indexOf('--flow-file'), withFlow.indexOf('--flow-file') + 2), ['--flow-file', '/f/flow.md']);
}

// --- the flow.md the factory's validator requires (JOBS-API v1.1) -----------------

{
  const flow = F.flowMarkdown({ title: 'Add retries', summary: 'Add retries to the export', app: 'widget', done: ['retries tested', 'docs updated'], delivery: 'draft_pr' });
  assert.strictEqual(flow, F.flowMarkdown({ title: 'Add retries', summary: 'Add retries to the export', app: 'widget', done: ['retries tested', 'docs updated'], delivery: 'draft_pr' }), 'deterministic');
  assert.match(flow, /^# Flow: Add retries\n/);
  assert.match(flow, /\n1\. Start from how `widget` behaves today/);
  assert.match(flow, /\n2\. Make the change: Add retries to the export\./);
  assert.match(flow, /\n3\. Check: retries tested\n4\. Check: docs updated\n5\. The existing tests still pass/);
  assert.match(flow, /\n6\. Deliver `draft_pr`\./);
  assert.match(F.flowMarkdown({ title: 'x' }), /\n2\. Make the change: x\.\n3\. The existing tests/, 'no criteria: still a valid flow');
}

// --- a --json answer --------------------------------------------------------------

assert.deepStrictEqual(F.parseResult({ code: 0, stdout: '{"apps": []}\n', stderr: 'log line' }), { apps: [] });
assert.throws(
  () => F.parseResult({ code: 2, stdout: '{"error": "unknown_repo", "message": "no app for o/r"}' }),
  (err) => err instanceof F.FactoryError && err.code === 'unknown_repo' && /no app for o\/r/.test(err.message)
);
assert.throws(() => F.parseResult({ code: 0, stdout: 'Traceback…', stderr: 'boom' }), (e) => e.code === 'bad_output' && /boom/.test(e.message));
assert.throws(() => F.parseResult({ code: 0, stdout: '[1]' }), (e) => e.code === 'bad_output');
assert.throws(() => F.parseResult({ code: 1, stdout: '{"job_id":"a:1"}' }), (e) => e.code === 'exit_1', 'non-zero exit is never a success');

// --- the walk-in command: nothing a shell reads gets through ----------------------

assert.strictEqual(F.followCommand('widget:042-retry'), 'uv run factory job follow widget:042-retry');
for (const bad of ['widget:1; rm -rf ~', 'widget', '$(id):1', 'a:b c', '', null]) {
  assert.throws(() => F.followCommand(bad), /not a factory job id/, String(bad));
}

// --- job status → run row ----------------------------------------------------------

const job = (o) => ({ job_id: 'widget:9', source: 'pa', external_id: '7', terminal: false, pr_urls: [], cost_usd: 0, why: null, ...o });
{
  assert.deepStrictEqual(
    ['queued', 'triaging', 'in_progress'].map((state) => F.runUpdate(job({ state })).status),
    ['running', 'running', 'running']
  );
  assert.strictEqual(F.runUpdate(job({ state: 'blocked', why: 'red gate' })).status, 'waiting');
  assert.strictEqual(F.runUpdate(job({ state: 'needs_human' })).status, 'waiting');
  const delivered = F.runUpdate(job({ state: 'done', terminal: true, delivery: 'draft_pr', pr_urls: ['https://github.com/o/w/pull/3', 'javascript:alert(1)'], cost_usd: 1.25 }));
  assert.deepStrictEqual(
    [delivered.status, delivered.outcome, delivered.mr_url, delivered.cost_usd, delivered.terminal],
    ['landed', 'delivered', 'https://github.com/o/w/pull/3', 1.25, true]
  );
  assert.strictEqual(F.runUpdate(job({ state: 'done', terminal: true, delivery: 'none' })).status, 'done', 'none pushed nothing');
  assert.strictEqual(F.runUpdate(job({ state: 'done', terminal: true, delivery: 'draft_pr', merged: true })).outcome, 'merged');
  assert.deepStrictEqual([F.runUpdate(job({ state: 'failed', terminal: true })).status, F.runUpdate(job({ state: 'failed' })).outcome], ['failed', 'failed']);
  assert.deepStrictEqual([F.runUpdate(job({ state: 'cancelled' })).status, F.runUpdate(job({ state: 'cancelled' })).outcome], ['dropped', 'dropped']);
  assert.strictEqual(F.runUpdate(job({ state: 'in_progress', cost_usd: 'n/a' })).cost_usd, null);
}

// --- job status → commitment (only ever through the ledger, only from dispatched) --

{
  const done = F.commitmentMove(job({ state: 'done', delivery: 'draft_pr', pr_urls: ['https://github.com/o/w/pull/3'] }));
  assert.deepStrictEqual([done.to, done.from], ['done', ['dispatched']]);
  assert.match(done.reason, /widget:9 delivered \(draft_pr\): https:\/\/github.com\/o\/w\/pull\/3/);
  assert.match(F.commitmentMove(job({ state: 'done', delivery: 'draft_pr', merged: true })).reason, /merged/);
  assert.strictEqual(F.commitmentMove(job({ state: 'done', delivery: 'none' })), null, 'nothing pushed: the ask stays dispatched');
  const failed = F.commitmentMove(job({ state: 'failed', why: 'oracle red' }));
  assert.deepStrictEqual([failed.to, failed.from], ['open', ['dispatched']]);
  assert.match(failed.reason, /oracle red/);
  assert.strictEqual(F.commitmentMove(job({ state: 'cancelled' })).to, 'open');
  for (const state of ['queued', 'in_progress', 'blocked', 'needs_human']) assert.strictEqual(F.commitmentMove(job({ state })), null);
}

// --- the routing rule ----------------------------------------------------------------

const apps = [{ app: 'widget', repo: 'Acme/Widget', path: '/srv/repos/widget' }, { app: 'docs', repo: 'acme/docs' }];
const ctx = (o) => ({ factoryEnabled: true, mode: 'mr', kind: 'coding', slug: 'acme/widget', apps, done: ['retries are tested'], ...o });
{
  const go = R.chooseRoute(ctx());
  assert.deepStrictEqual([go.route, go.app], ['factory', 'widget']);
  assert.match(go.reason, /acme\/widget .*factory app widget.*1 done-criteria/);
  const why = (o) => R.chooseRoute(ctx(o));
  assert.match(why({ factoryEnabled: false }).reason, /not configured/);
  assert.match(why({ mode: 'plan' }).reason, /plan mode/);
  assert.match(why({ kind: 'investigate' }).reason, /planned as "investigate"/);
  assert.match(why({ kind: null }).reason, /not planned/);
  assert.match(why({ slug: null }).reason, /no repository/);
  assert.match(why({ slug: 'acme/other' }).reason, /not registered/);
  assert.match(why({ done: [] }).reason, /done-criteria/);
  for (const o of [{ factoryEnabled: false }, { mode: 'plan' }, { kind: 'investigate' }, { slug: 'acme/other' }, { done: [] }]) {
    assert.strictEqual(why(o).route, 'claude', JSON.stringify(o));
  }
  // The slug matches however it was spelled.
  assert.strictEqual(R.appFor('ACME/widget.git', apps).app, 'widget');
  assert.strictEqual(R.appFor('not a slug', apps), null);
}

// The guard holds any chooser to the hard limits, whatever it says.
{
  const rogue = { route: 'factory', reason: 'the model liked it' };
  assert.strictEqual(R.guard(rogue, ctx({ mode: 'plan' })).route, 'claude');
  assert.strictEqual(R.guard(rogue, ctx({ slug: 'acme/other' })).route, 'claude');
  assert.strictEqual(R.guard(rogue, ctx({ factoryEnabled: false })).route, 'claude');
  // Softer judgements (kind, done-criteria) are the chooser's to make.
  const ok = R.guard(rogue, ctx({ kind: 'investigate', done: [] }));
  assert.deepStrictEqual([ok.route, ok.app, ok.reason], ['factory', 'widget', 'the model liked it']);
  assert.strictEqual(R.guard({ route: 'teleport' }, ctx()).route, 'claude');
  assert.strictEqual(R.guard(null, ctx()).route, 'claude');
}

assert.deepStrictEqual(R.doneCriteria({ detail: '- retries with backoff\n* a test for the timeout\n1. docs updated\n\n[ ] ok' }), [
  'retries with backoff', 'a test for the timeout', 'docs updated',
]);
assert.deepStrictEqual(R.doneCriteria({ detail: 'One paragraph saying what done means.' }), ['One paragraph saying what done means.']);
assert.deepStrictEqual(R.doneCriteria({ detail: null }), []);
assert.deepStrictEqual(R.doneCriteria(null), []);
assert.strictEqual(R.via(), 'claude');
assert.strictEqual(R.via('AUTO'), 'auto');
assert.throws(() => R.via('carrier-pigeon'), /unknown route/);

// --- which route works for which task ----------------------------------------------

{
  const s = R.summarize([
    { route: 'factory', kind: 'coding', outcome: 'delivered', cost_usd: '2.50' },
    { route: 'factory', kind: 'coding', outcome: 'merged', cost_usd: 1.5 },
    { route: 'factory', kind: 'coding', outcome: 'failed', cost_usd: 4 },
    { route: 'factory', kind: 'coding', outcome: null, cost_usd: null },
    { route: 'claude', kind: 'coding', outcome: 'delivered', cost_usd: null },
    { route: 'claude', kind: null, outcome: 'dropped' },
    { route: null, kind: 'coding', outcome: 'failed' },
  ]);
  const f = s.find((g) => g.route === 'factory' && g.kind === 'coding');
  assert.deepStrictEqual(
    [f.runs, f.delivered, f.merged, f.failed, f.open, f.costUsd, f.costPerSuccess],
    [4, 1, 1, 1, 1, 8, 4]
  );
  assert.strictEqual(f.successRate, 2 / 3, 'open runs say nothing yet');
  const c = s.find((g) => g.route === 'claude' && g.kind === 'coding');
  assert.deepStrictEqual([c.runs, c.successRate, c.costUsd], [2, 0.5, null], 'a missing route is a claude run; no cost is not $0');
  assert.ok(s.find((g) => g.kind === 'unplanned'));
}

// --- parseArgs: a flag given twice ---------------------------------------------------

{
  const { parseArgs } = require('../src/cli/parseArgs.ts');
  const r = parseArgs(['do', '12', '--via', 'factory', '--done', 'a', '--done=b, with a comma', '--model', 'dev=x']);
  assert.deepStrictEqual(r.lists.done, ['a', 'b, with a comma']);
  assert.strictEqual(r.flags.done, 'b, with a comma', 'flags keep the last value, as before');
  assert.deepStrictEqual(r.lists.model, ['dev=x']);
  assert.strictEqual(r.flags.via, 'factory');
}

// --- the brief, as a factory job's ask ------------------------------------------------

{
  const { buildBrief } = require('../src/dispatch/brief');
  const base = { commitment: { summary: 'Add retries to the export', detail: 'retries tested' }, modeName: 'mr', run: { id: 7, worktree_path: '/w', branch: 'pa/7' } };
  const claude = buildBrief(base);
  const factory = buildBrief({ ...base, factory: { app: 'widget', delivery: 'draft_pr' } });
  assert.match(claude, /`pa` MCP server/);
  assert.match(factory, /software-factory job \(run #7, app `widget`\), mode `mr` → delivery `draft_pr`/);
  assert.match(factory, /DRAFT pull request\. Never mark it ready and never merge it/);
  assert.match(factory, /enforced by the factory/);
  assert.match(factory, /retries tested/);
  for (const absent of [/`pa` MCP server/, /\*\*Worktree:\*\*/, /When you are done/, /blocked at the git level/]) assert.doesNotMatch(factory, absent);
}

// --- the planner never starts a factory job on its own -------------------------------

{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'planner.ts'), 'utf8');
  const research = src.slice(src.indexOf("mode: 'plan'") - 200, src.indexOf("mode: 'plan'") + 200);
  assert.match(research, /via: 'claude'/, "the planner's own runs are plan-mode Claude sessions");
  assert.strictEqual((src.match(/dispatch'\)\.start\(/g) || []).length, 1, 'one start call, the research one');
}

// --- the runner: exec.js, and how its results read as factory answers ------------

async function execLocal() {
  const { runCommand } = require('../src/dispatch/exec.ts');
  const ok = await runCommand(null, [process.execPath, '-e', 'process.stdout.write(JSON.stringify({a: process.argv[1]}))', 'x="1"; echo $HOME'], { cwd: tmp });
  assert.deepStrictEqual([ok.code, JSON.parse(ok.stdout)], [0, { a: 'x="1"; echo $HOME' }], 'argv verbatim, no shell');
  const bad = await runCommand(null, [process.execPath, '-e', 'process.stdout.write("{}"); process.exit(3)']);
  assert.deepStrictEqual([bad.code, bad.stdout], [3, '{}'], 'a non-zero exit is an answer, not a throw');
  const F = require('../src/dispatch/factoryCore.ts');
  // A timeout / missing program is a transport failure (plain Error, retried once), not a FactoryError.
  for (const res of [{ code: 124, stdout: '', stderr: '', timedOut: true }, { code: 127, stdout: '', stderr: '' }]) {
    let caught = null;
    try { F.parseResult(res); } catch (err) { caught = err; }
    assert.ok(caught && !(caught instanceof F.FactoryError), `exit ${res.code} is a transport failure`);
  }
  assert.throws(() => F.parseResult({ code: 1, stdout: '{"error":"unknown_repo","message":"x"}' }), (e) => e instanceof F.FactoryError && e.code === 'unknown_repo');
}

// --- factory.js against a stubbed store, ledger, termhub and factory CLI ----------

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const store = { queries: [], watched: [], nextId: 7 };
const INSTALL = '0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011';
const KEY = `${INSTALL}-7`;

// The guarded run insert (src/repo/runs.js) runs in a transaction: the
// same stub answers its queries, and the live-run re-check sees store.liveRun.
function stubTx(db) {
  db.withTx = async (fn) => fn({
    async query(sql, params) {
      (global.__txQueries = global.__txQueries || []).push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) { (global.__txLocks = global.__txLocks || []).push(params); return { rows: [] }; }
      if (/^\s*select id from run where commitment_id/.test(sql)) return { rows: global.__liveRun ? [global.__liveRun] : [] };
      return { rows: [await db.one(sql, params)] };
    },
  });
  return db;
}

stub('db', stubTx({
  async one(sql, params) {
    store.queries.push({ sql, params });
    if (/insert into run/.test(sql)) return { id: store.nextId, status: 'starting' };
    if (/from pa_install/.test(sql)) return { id: INSTALL };
    if (/from repo_delivery/.test(sql)) return store.repoDefault ? { delivery: store.repoDefault } : null;
    return null;
  },
  async rows(sql, params) {
    store.queries.push({ sql, params });
    if (/factory_job_id is null/.test(sql)) return store.unsettled || [];
    if (/from repo_delivery/.test(sql)) return [];
    return /from run/.test(sql) ? store.watched : [];
  },
  async query(sql, params) {
    store.queries.push({ sql, params });
    if (store.failOn && store.failOn.test(sql)) {
      store.failOn = null;
      throw new Error('connection to the store lost');
    }
    if (store.runEnded && /status in \('starting', 'waiting', 'running'\)/.test(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  },
}));
const transitions = [];
stub('ledger', { async transition(t) { transitions.push(t); return { changed: true }; } });
const notes = [];
stub('notify', { async notify(n) { notes.push(n); return { id: notes.length }; } });
const sessions = [];
stub('dispatch/termhub', {
  isLocal: () => true,
  forMachine: () => ({
    async createSession(s) { sessions.push(s); return { id: 'sess-1' }; },
    async sessionUrl(id) { return `https://hub.example/#session=${id}`; },
    async killSession() { return true; },
  }),
});
stub('dispatch/index', {
  async briefFor(target, o) { return `# ${target.commitment.summary}\nrun ${o.run.id} → ${o.factory.delivery}`; },
});

// The brief-composition model: never a real call from a test.
const composeCalls = [];
require('../src/dispatch/compose')._setModel(async ({ prompt }) => {
  composeCalls.push(prompt);
  return JSON.stringify({ goal: 'Retry the export on transient errors.', done: ['model criterion'], constraints: ['keep the CSV format'], decisions: [], facts: [], reuse: [], questions: [] });
});

const factory = require('../src/dispatch/factory');
const calls = [];
let answers = {};
factory._setRunner(async (machine, argv, opts) => {
  calls.push({ machine, argv, opts });
  const key = argv[2] === 'python' ? 'python -c' : argv.slice(3, 5).join(' ');
  const a = typeof answers[key] === 'function' ? answers[key](argv, opts) : answers[key];
  if (!a) throw new Error(`unexpected factory call ${argv.join(' ')}`);
  return a;
});
const json = (o, code = 0) => ({ code, stdout: JSON.stringify(o), stderr: '' });

async function factoryStart() {
  const target = { commitment: { id: 31, summary: 'Add retries to the export', kind: 'coding' }, repoPath: '/repos/widget' };
  answers = { 'job submit': json({ job_id: 'widget:017', app: 'widget', direction_id: '017', pipeline: 'chain', delivery: 'draft_pr', created: true, warnings: [] }) };
  const r = await factory.start({ target, app: 'widget', mode: 'mr', models: ['reviewer=model-b'], done: ['retries tested'], routeReason: 'you chose the factory' });

  assert.deepStrictEqual([r.route, r.jobId, r.delivery, r.pipeline, r.url], ['factory', 'widget:017', 'draft_pr', 'chain', 'https://hub.example/#session=sess-1']);
  const submit = calls[0];
  assert.strictEqual(submit.machine, null, 'this machine');
  assert.strictEqual(submit.opts.cwd, '/srv/factory-checkout');
  assert.deepStrictEqual(submit.argv.slice(0, 5), ['uv', 'run', 'factory', 'job', 'submit']);
  for (const want of ['--external-id', KEY, '--source', 'pa', '--delivery', 'draft_pr', '--done=retries tested', '--model', 'dev=model-a', 'reviewer=model-b', '--ask-file']) {
    assert.ok(submit.argv.includes(want), `submit carries ${want}`);
  }
  const askFile = submit.argv[submit.argv.indexOf('--ask-file') + 1];
  const askText = fs.readFileSync(askFile, 'utf8');
  assert.match(askText, /^# Add retries to the export\n/, 'the ask is the composed brief');
  assert.match(askText, /## Goal\n\nRetry the export on transient errors\./);
  assert.match(askText, /- \[ \] retries tested\n/, 'the given criteria, not the model\'s');
  assert.doesNotMatch(askText, /model criterion/);
  assert.match(askText, /Search the repo for existing implementations before writing new code; extend rather than duplicate; follow existing conventions; add\/extend tests\./);
  assert.match(askText, /Delivery: `draft_pr`/);
  assert.ok(composeCalls.length >= 1, 'composed through the (stubbed) model');
  const flowFile = submit.argv[submit.argv.indexOf('--flow-file') + 1];
  assert.ok(submit.argv.includes('--flow-file'), 'every job carries a flow, or the factory parks it');
  assert.match(fs.readFileSync(flowFile, 'utf8'), /# Flow: Add retries to the export[\s\S]*Check: retries tested/);
  assert.deepStrictEqual(r.warnings, []);
  // Recorded on the run, then the commitment moves only through the ledger.
  const insert = store.queries.find((q) => /insert into run/.test(q.sql));
  assert.match(insert.sql, /'factory'/);
  // Pipeline solo by default (PA_FACTORY_PIPELINE); kind and runtime on the row (sql/031).
  assert.deepStrictEqual(insert.params.slice(5), ['you chose the factory', 'coding', 'solo', 'draft_pr', { dev: 'model-a', reviewer: 'model-b' }, 'mode', 'code', 'api']);
  assert.ok(submit.argv.includes('--kind') && submit.argv.includes('--runtime'), 'v1.2 flags sent');
  assert.ok(store.queries.some((q) => /factory_job_id = \$2/.test(q.sql) && q.params[1] === 'widget:017'));
  assert.deepStrictEqual(transitions, [{ commitmentId: 31, to: 'dispatched', actor: 'dispatch', reason: 'run #7: factory job widget:017', from: ['open'] }]);
  // Walk-in: a session following the job, in the factory checkout, stored on the run.
  // It names its card, run and job (plan E1), so Run links back to them.
  assert.deepStrictEqual(sessions[0], { cwd: '/srv/factory-checkout', command: 'uv run factory job follow widget:017', title: 'pa#7 factory · Add retries to the export',
    links: { card: 31, run: 7, job: 'widget:017' } });
  assert.ok(store.queries.some((q) => /termhub_session_id = \$2/.test(q.sql) && q.params[1] === 'sess-1'));

  // A follow session that is slow to open does not hold the answer: the job is
  // reported at once (no url), and the session is recorded on the run when it opens.
  {
    const { config } = require('../src/config.ts');
    const hub = require('../src/dispatch/termhub');
    const realFor = hub.forMachine;
    hub.forMachine = () => ({
      async createSession() { await new Promise((r) => setTimeout(r, 400)); return { id: 'sess-slow' }; },
      async sessionUrl(id) { return `https://hub.example/#session=${id}`; },
      async killSession() { return true; },
    });
    const wasWait = config.factory.followWaitMs;
    config.factory.followWaitMs = 50;
    try {
      answers = { 'job submit': json({ job_id: 'widget:018', app: 'widget', direction_id: '018', pipeline: 'chain', delivery: 'draft_pr', created: true, warnings: [] }) };
      const t = Date.now();
      const slow = await factory.start({ target: { commitment: { id: 32, summary: 'Add retries to the export', kind: 'coding' }, repoPath: '/repos/widget' }, app: 'widget', mode: 'mr', routeReason: 'you chose the factory' });
      assert.ok(Date.now() - t < 350, 'answered without waiting for the session');
      assert.deepStrictEqual([slow.jobId, slow.url, slow.sessionId], ['widget:018', null, null]);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(store.queries.some((q) => /termhub_session_id = \$2/.test(q.sql) && q.params[1] === 'sess-slow'), 'the late session is still recorded');
    } finally {
      config.factory.followWaitMs = wasWait;
      hub.forMachine = realFor;
    }
  }

  // Plan mode never reaches the factory or the store.
  calls.length = 0;
  const before = store.queries.length;
  await assert.rejects(factory.start({ target, app: 'widget', mode: 'plan' }), /not a factory job/);
  assert.deepStrictEqual([calls.length, store.queries.length], [0, before]);

  // A contract error fails the run, is not retried, and moves no commitment.
  transitions.length = 0;
  calls.length = 0;
  answers = { 'job submit': json({ error: 'unknown_repo', message: 'no app widget' }, 2) };
  await assert.rejects(factory.start({ target, app: 'widget', mode: 'local' }), (e) => e.code === 'unknown_repo');
  assert.strictEqual(calls.length, 1, 'a contract error is not retried');
  assert.ok(store.queries.some((q) => /status = 'failed', outcome = 'failed'/.test(q.sql)));
  assert.deepStrictEqual(transitions, []);

  // Warnings from submit land on the run row and in the result.
  answers = { 'job submit': json({ job_id: 'widget:021', delivery: 'draft_pr', created: true, warnings: ['no api_spec.md; flow only'] }) };
  store.queries.length = 0;
  const warned = await factory.start({ target, app: 'widget', mode: 'mr' });
  assert.deepStrictEqual(warned.warnings, ['no api_spec.md; flow only']);
  const rec = store.queries.find((q) => /factory_warnings = \$6/.test(q.sql));
  assert.deepStrictEqual([JSON.parse(rec.params[5]), rec.params[6]], [['no api_spec.md; flow only'], 'factory warned: no api_spec.md; flow only']);

  // A factory on another machine: ask and flow are written THERE, through
  // runCommand and a fixed python writer (run for real here) that reads them
  // on STDIN into a fresh private directory, then submitted by path, then the
  // directory is removed.
  {
    const { config } = require('../src/config.ts');
    const { execFileSync } = require('child_process');
    const otherTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-factory-remote-'));
    config.termhub.machines.forge = { name: 'forge', url: 'http://forge:7000', reposRoot: '/home/k' };
    config.factory.machine = 'forge';
    calls.length = 0;
    const py = (argv, opts) => ({
      code: 0,
      stdout: execFileSync(PYTHON, argv.slice(3), { input: opts.stdin || '', env: { ...process.env, TMPDIR: otherTmp, TEMP: otherTmp, TMP: otherTmp } }).toString(),
      stderr: '',
    });
    let seen = null;
    answers = {
      'python -c': py,
      'job submit': (argv) => {
        const ask = argv[argv.indexOf('--ask-file') + 1];
        const flowPath = argv[argv.indexOf('--flow-file') + 1];
        seen = { ask, flowPath, askText: fs.readFileSync(ask, 'utf8'), flowText: fs.readFileSync(flowPath, 'utf8'), mode: fs.statSync(path.dirname(ask)).mode & 0o777 };
        return json({ job_id: 'widget:022', delivery: 'draft_pr', created: true });
      },
    };
    const remote = await factory.start({ target, app: 'widget', mode: 'mr', done: ['retries tested'] });
    config.factory.machine = '';
    // Empty, `local` (any case) or this host's name: this machine, run locally
    // (no termhub /api/exec). An unknown name is refused, never run "here".
    const ms = { forge: { name: 'forge' } };
    for (const local of ['', '  ', 'local', 'LOCAL', 'myhost', 'MyHost']) {
      assert.strictEqual(factory.factoryMachine(local, ms, 'myhost'), null, `"${local}" is this machine`);
    }
    assert.strictEqual(factory.factoryMachine('forge', ms, 'myhost'), 'forge');
    assert.throws(() => factory.factoryMachine('elsewhere', ms, 'myhost'), /not in PA_MACHINES/);
    assert.deepStrictEqual(calls.map((c) => c.machine), ['forge', 'forge', 'forge'], 'stage, submit, clean up');
    assert.ok(!calls[0].argv.some((a) => /Add retries to the export/.test(a)), 'contents never on a command line');
    assert.ok(!calls[0].argv.some((a) => a.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(a)), 'not base64 on argv either');
    assert.match(calls[0].opts.stdin, /Add retries to the export/, 'contents travel on stdin');
    assert.ok(seen.ask.startsWith(otherTmp) && seen.flowPath.startsWith(otherTmp), 'paths on the factory machine');
    assert.match(path.basename(path.dirname(seen.ask)), /^pa-factory-ask-7-.+/, 'a fresh, unpredictable directory per run');
    if (process.platform !== 'win32') assert.strictEqual(seen.mode, 0o700, 'private to the user'); // POSIX permission bits do not exist on Windows
    assert.match(seen.askText, /Delivery: `draft_pr`/);
    assert.match(seen.flowText, /Check: retries tested/);
    assert.ok(!fs.existsSync(path.dirname(seen.ask)), 'removed once the factory has the job');
    assert.strictEqual(remote.machine, 'forge');

    // A brief far past the ~96 KB a command line carries is staged whole.
    const big = 'x'.repeat(300 * 1024);
    const bigOut = JSON.parse(py(['uv', 'run', 'python', '-c', calls[0].argv[4]], { stdin: JSON.stringify({ run: 9, files: { 'BRIEF.md': big } }) }).stdout);
    assert.strictEqual(fs.readFileSync(bigOut.paths['BRIEF.md'], 'utf8').length, big.length);
    // O_EXCL|O_NOFOLLOW: a planted symlink is never written through. (POSIX
    // only: Windows has no O_NOFOLLOW and needs Developer Mode to symlink.)
    const victim = path.join(otherTmp, 'victim');
    fs.writeFileSync(victim, 'keep');
    const link = path.join(bigOut.dir, 'flow.md');
    try { fs.symlinkSync(victim, link); } catch (e) { if (e.code !== 'EPERM') throw e; fs.writeFileSync(link, 'planted'); } // no symlink right on Windows: O_EXCL still refuses an existing name
    const writer = calls[0].argv[4];
    const planted = writer.replace("d = tempfile.mkdtemp(prefix='pa-factory-ask-' + str(int(req['run'])) + '-')", `d = ${JSON.stringify(bigOut.dir)}`);
    assert.notStrictEqual(planted, writer);
    assert.throws(() => execFileSync(PYTHON, ['-c', planted], { input: JSON.stringify({ run: 9, files: { 'flow.md': 'evil' } }), stdio: ['pipe', 'pipe', 'pipe'] }));
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
    // The cleaner refuses anything that is not a staged directory.
    const cleanerArgv = calls[2].argv;
    assert.strictEqual(JSON.parse(py([...cleanerArgv.slice(0, 5), victim], {}).stdout).removed, false);
    assert.ok(fs.existsSync(victim));
    fs.rmSync(otherTmp, { recursive: true, force: true });
  }

  // A lost answer is retried once with the same external id (the factory dedupes on it).
  calls.length = 0;
  let first = true;
  answers = {
    'job submit': () => {
      if (first) { first = false; throw new Error('connection reset'); }
      return json({ job_id: 'widget:018', delivery: 'none', created: false });
    },
  };
  const again = await factory.start({ target, app: 'widget', mode: 'local' });
  assert.deepStrictEqual([calls.length, again.jobId, again.created], [2, 'widget:018', false]);
  const ids = calls.map((c) => c.argv[c.argv.indexOf('--external-id') + 1]);
  assert.deepStrictEqual(ids, [KEY, KEY], 'install-scoped key, the same on the retry');
}

async function factoryPoll() {
  // Nothing live: no factory command at all.
  calls.length = 0;
  store.watched = [];
  assert.deepStrictEqual(await factory.poll(), { checked: 0 });
  assert.strictEqual(calls.length, 0);

  transitions.length = 0;
  notes.length = 0;
  store.queries.length = 0;
  store.watched = [
    { id: 7, commitment_id: 31, task: 'Add retries', status: 'running', factory_job_id: 'widget:017', factory_state: 'in_progress', outcome: null },
    { id: 8, commitment_id: 32, task: 'Fix the docs build', status: 'running', factory_job_id: 'widget:019', factory_state: 'queued', outcome: null },
    { id: 9, commitment_id: 33, task: 'Not ours', status: 'running', factory_job_id: 'widget:020', factory_state: 'queued', outcome: null },
  ];
  answers = {
    'job list': json({ jobs: [{ job_id: 'widget:019', source: 'pa', external_id: '8', state: 'blocked', terminal: false, why: 'gate red', pr_urls: [], cost_usd: 0.4 }] }),
    'job status': (argv) =>
      argv[5] === 'widget:017'
        ? json({ job_id: 'widget:017', source: 'pa', external_id: '7', state: 'done', terminal: true, delivery: 'draft_pr', merged: false, pr_urls: ['https://github.com/acme/widget/pull/12'], cost_usd: 2.1 })
        : json({ job_id: 'widget:020', source: 'someone-else', external_id: '99', state: 'done', terminal: true, delivery: 'draft_pr' }),
  };
  const r = await factory.poll();
  assert.deepStrictEqual(r, { checked: 3, changed: 2, ended: 1 });
  assert.deepStrictEqual(calls.map((c) => c.argv.slice(3).join(' ')), [
    'job list --json --source pa --active',
    'job status widget:017 --json',
    'job status widget:020 --json',
  ]);
  const upd = store.queries.filter((q) => /^\s*update run set status/.test(q.sql));
  assert.deepStrictEqual(upd.map((q) => [q.params[0], q.params[1], q.params[2]]), [[7, 'landed', 'delivered'], [8, 'waiting', null]]);
  assert.strictEqual(upd[0].params[5], 'https://github.com/acme/widget/pull/12');
  // Only the finished job moves its commitment, through the ledger, from dispatched.
  assert.deepStrictEqual(transitions.map((t) => [t.commitmentId, t.to, t.actor, t.from]), [[31, 'done', 'factory', ['dispatched']]]);
  assert.deepStrictEqual(notes.map((n) => n.dedupeKey.split(':')[0]), ['factory-end', 'factory-wait']);
  assert.ok(!store.queries.some((q) => q.params && q.params[0] === 9), 'a job that is not this run\'s is left alone');

  // Seen again unchanged: no write, no second close, no second notification.
  transitions.length = 0;
  store.queries.length = 0;
  store.watched = [{ id: 7, commitment_id: 31, task: 'Add retries', status: 'landed', factory_job_id: 'widget:017', factory_state: 'done', outcome: 'delivered', cost_usd: '2.1', mr_url: 'https://github.com/acme/widget/pull/12' }];
  answers['job list'] = json({ jobs: [] });
  answers['job status'] = json({ job_id: 'widget:017', source: 'pa', external_id: '7', state: 'done', terminal: true, delivery: 'draft_pr', merged: false, pr_urls: ['https://github.com/acme/widget/pull/12'], cost_usd: 2.1 });
  assert.deepStrictEqual(await factory.poll(), { checked: 1, changed: 0, ended: 0 });
  assert.deepStrictEqual(transitions, []);
  // …and once it merges, only the measured outcome moves; the run keeps its status.
  answers['job status'] = json({ job_id: 'widget:017', source: 'pa', external_id: '7', state: 'done', terminal: true, delivery: 'draft_pr', merged: true, pr_urls: ['https://github.com/acme/widget/pull/12'], cost_usd: 2.1 });
  await factory.poll();
  const merged = store.queries.find((q) => /^\s*update run set status/.test(q.sql));
  assert.deepStrictEqual([merged.params[1], merged.params[2]], ['landed', 'merged']);
  assert.deepStrictEqual(transitions, []);
}

async function routeDecide() {
  const route = require('../src/dispatch/route');
  const { config } = require('../src/config.ts');
  answers = { 'app list': json({ apps: [{ app: 'widget', repo: 'acme/widget', path: '/srv/repos/widget' }] }) };
  const target = { commitment: { id: 40, kind: 'coding', detail: '- retries tested' }, project: { gitlab_path: 'acme/widget' }, repoPath: null };
  const auto = await route.decide({ target, mode: 'branch' });
  assert.deepStrictEqual([auto.route, auto.app, auto.done], ['factory', 'widget', ['retries tested']]);
  assert.strictEqual((await route.decide({ target, mode: 'plan' })).route, 'claude');
  // A registered chooser is held to the guard.
  route.CHOOSERS.rogue = () => ({ route: 'factory', reason: 'trust me' });
  config.factory.chooser = 'rogue';
  assert.strictEqual((await route.decide({ target: { ...target, project: { gitlab_path: 'acme/elsewhere' } }, mode: 'mr' })).route, 'claude');
  assert.strictEqual((await route.decide({ target: { ...target, commitment: { id: 41, kind: 'investigate' } }, mode: 'mr' })).reason, 'trust me');
  route.CHOOSERS.broken = () => { throw new Error('model down'); };
  config.factory.chooser = 'broken';
  assert.strictEqual((await route.decide({ target, mode: 'mr' })).route, 'factory', 'a failing chooser falls back to the rule');
  config.factory.chooser = 'rule';
  // --via factory refuses plainly what it cannot do.
  await assert.rejects(route.forced({ target, mode: 'plan' }), /plan mode/);
  await assert.rejects(route.forced({ target: { ...target, project: { gitlab_path: 'acme/elsewhere' } }, mode: 'mr' }), /not registered.*--register.*pa factory add acme\/elsewhere/);
  assert.strictEqual((await route.forced({ target: { ...target, commitment: { id: 42, kind: null } }, mode: 'mr' })).app, 'widget', 'the human may send any registered repo');
}


// --- M8: a submit whose answer is lost is reconciled, never left `starting` ------------

async function factoryReconcile() {
  const target = { commitment: { id: 31, summary: 'Add retries to the export', kind: 'coding' }, repoPath: '/repos/widget' };
  const lastRunUpdate = () => store.queries.filter((q) => /^\s*update run set/.test(q.sql)).pop();

  // Pure: what an unsettled submit becomes.
  assert.strictEqual(F.submitVerdict({ job: { job_id: 'w:1' }, asked: true, ageMs: 0 }), 'adopt');
  assert.strictEqual(F.submitVerdict({ job: null, asked: false, ageMs: F.SUBMIT_GRACE_MS * 2 }), 'unknown', 'the factory could not be asked: not failed (yet)');
  assert.strictEqual(F.submitVerdict({ job: null, asked: true, ageMs: 0 }), 'unknown', 'too early to believe "no job"');
  assert.strictEqual(F.submitVerdict({ job: null, asked: true, ageMs: F.SUBMIT_GRACE_MS }), 'fail');
  assert.deepStrictEqual(F.jobForRun([{ job_id: 'w:1', source: 'pa', external_id: '6' }, { job_id: 'w:2', source: 'pa', external_id: '7' }], 7).job_id, 'w:2');
  assert.strictEqual(F.jobForRun([{ job_id: 'w:2', source: 'pa', external_id: '7' }], KEY), null, 'a bare id is not this install\'s key');
  assert.strictEqual(F.externalKey(INSTALL, 7), KEY);
  assert.throws(() => F.externalKey('', 7), /install id/);
  assert.strictEqual(F.jobForRun([{ job_id: 'w:2', source: 'someone', external_id: '7' }], 7), null, 'another source\'s job is not ours');
  assert.strictEqual(F.jobForRun([{ job_id: 'bad id; rm', source: 'pa', external_id: '7' }], 7), null);

  // 1. Both submit attempts lose their answer; the factory has the job → adopted.
  calls.length = 0;
  store.queries.length = 0;
  transitions.length = 0;
  answers = {
    'job submit': () => { throw new Error('socket hang up'); },
    'job list': json({ jobs: [{ job_id: 'widget:029', source: 'pa', external_id: '7', state: 'queued' }, { job_id: 'widget:030', source: 'pa', external_id: KEY, state: 'queued', delivery: 'pr' }] }),
  };
  const adopted = await factory.start({ target, app: 'widget', delivery: 'pr', done: ['retries tested'] });
  assert.deepStrictEqual([adopted.jobId, adopted.delivery, adopted.submitUnknown], ['widget:030', 'pr', undefined]);
  assert.deepStrictEqual(calls.map((c) => c.argv.slice(3, 5).join(' ')), ['job submit', 'job submit', 'job list']);
  assert.deepStrictEqual(calls[2].argv.slice(3), ['job', 'list', '--json', '--source', 'pa'], 'looked up by source, matched by external id');
  assert.deepStrictEqual(calls.slice(0, 2).map((c) => c.argv[c.argv.indexOf('--external-id') + 1]), [KEY, KEY], 'one idempotency key');
  // (widget:029 holds the bare id 7 — another install's run 7 — and is never adopted.)
  assert.ok(store.queries.some((q) => /factory_job_id = \$2/.test(q.sql) && q.params[1] === 'widget:030'), 'recorded');
  assert.ok(!store.queries.some((q) => /status = 'failed'/.test(q.sql)), 'not failed');
  assert.strictEqual(transitions.length, 1, 'the commitment moves once it is recorded');

  // 2. Submit answered, but recording it failed → asked by job id, adopted on the retry.
  calls.length = 0;
  store.queries.length = 0;
  store.failOn = /factory_job_id = \$2/;
  answers = {
    'job submit': json({ job_id: 'widget:031', delivery: 'auto_merge', created: true }),
    'job status': json({ job_id: 'widget:031', source: 'pa', external_id: KEY, state: 'queued', delivery: 'auto_merge' }),
  };
  const recovered = await factory.start({ target, app: 'widget', delivery: 'auto_merge', confirmedUnattended: true });
  assert.strictEqual(recovered.jobId, 'widget:031');
  assert.deepStrictEqual(calls.map((c) => c.argv.slice(3, 6).join(' ')), ['job submit --json', 'job status widget:031']);
  assert.strictEqual(store.queries.filter((q) => /factory_job_id = \$2/.test(q.sql)).length, 2, 'tried, failed, recorded on the reconcile');

  // 3. Submit lost and the factory cannot be asked → `waiting` as submit_unknown, never `starting`, never failed.
  calls.length = 0;
  store.queries.length = 0;
  transitions.length = 0;
  answers = { 'job submit': () => { throw new Error('ETIMEDOUT'); }, 'job list': () => { throw new Error('ETIMEDOUT'); } };
  const unknown = await factory.start({ target, app: 'widget', delivery: 'push_to_main', confirmedUnattended: true });
  assert.strictEqual(unknown.submitUnknown, true);
  assert.match(unknown.note, /answer was lost.*pa review 7/);
  const parked = lastRunUpdate();
  assert.match(parked.sql, /status = 'waiting', factory_state = 'submit_unknown'/);
  assert.match(parked.sql, /factory_job_id is null/, 'never overwrites a job recorded meanwhile');
  assert.ok(!store.queries.some((q) => /status = 'failed'/.test(q.sql)));
  assert.deepStrictEqual(transitions, [], 'no commitment move without a job');

  // 4. The worker settles such rows: no job after the grace → failed; a job → adopted (and the commitment moves).
  calls.length = 0;
  store.queries.length = 0;
  transitions.length = 0;
  store.watched = [];
  store.unsettled = [
    { id: 12, commitment_id: null, status: 'waiting', factory_state: 'submit_unknown', age_ms: String(F.SUBMIT_GRACE_MS + 1) },
    { id: 13, commitment_id: 44, status: 'starting', factory_state: null, age_ms: '200000' },
    { id: 14, commitment_id: null, status: 'waiting', factory_state: 'submit_unknown', age_ms: '1000' },
  ];
  answers = { 'job list': json({ jobs: [{ job_id: 'widget:040', source: 'pa', external_id: '13', state: 'in_progress' }] }) };
  const swept = await factory.poll();
  assert.deepStrictEqual(swept, { checked: 0, unsettled: 3 });
  const byRun = (id) => store.queries.filter((q) => /^\s*update run set/.test(q.sql) && q.params[0] === id).map((q) => q.sql);
  assert.match(byRun(12)[0], /status = 'failed'.*factory_state = 'not_submitted'/s);
  assert.match(byRun(13)[0], /factory_job_id = \$2/);
  assert.match(byRun(14)[0], /submit_unknown/, 'still inside the grace: asked again later');
  assert.deepStrictEqual(transitions.map((t) => [t.commitmentId, t.to, t.from]), [[44, 'dispatched', ['open']]]);
  store.unsettled = [];

  // MUST-FIX 1: an unattended end state never reaches the factory unconfirmed.
  calls.length = 0;
  await assert.rejects(factory.start({ target, app: 'widget', delivery: 'push_to_main' }), (e) => e.code === 'needs_confirmation');
  assert.strictEqual(calls.length, 0);

  // MUST-FIX 11: an error that is not a known pre-creation refusal is settled, not failed.
  calls.length = 0;
  store.queries.length = 0;
  answers = {
    'job submit': json({ error: 'internal', message: 'KeyError: x' }, 2),
    'job list': json({ jobs: [{ job_id: 'widget:041', source: 'pa', external_id: KEY, state: 'queued' }] }),
  };
  const internal = await factory.start({ target, app: 'widget', delivery: 'pr' });
  assert.strictEqual(internal.jobId, 'widget:041', 'the direction was written before the error: adopted');
  assert.ok(!store.queries.some((q) => /status = 'failed', outcome = 'failed'/.test(q.sql)));
  for (const code of ['unknown_repo', 'invalid_delivery', 'review_independence', 'duplicate_key']) assert.ok(F.isRefusal(new F.FactoryError(code)), code);
  for (const code of ['internal', 'conflict', 'bad_output', 'exit_2']) assert.ok(!F.isRefusal(new F.FactoryError(code)), code);

  // MUST-FIX 12: exit 127 (no uv, bad cwd) never ran: failed at once, not left waiting.
  calls.length = 0;
  store.queries.length = 0;
  answers = { 'job submit': { code: 127, stdout: '', stderr: 'spawn uv ENOENT' } };
  await assert.rejects(factory.start({ target, app: 'widget', delivery: 'pr' }), (e) => e.code === 'not_sent');
  assert.ok(store.queries.some((q) => /status = 'failed', outcome = 'failed'/.test(q.sql)));
  assert.ok(!store.queries.some((q) => /submit_unknown/.test(q.sql)));
  assert.strictEqual(calls.length, 1, 'not retried, not reconciled');
  // …but after a first attempt whose answer was lost, a 127 says nothing: settled.
  let n = 0;
  answers = {
    'job submit': () => (n++ === 0 ? (() => { throw new Error('ETIMEDOUT'); })() : { code: 127, stdout: '', stderr: '' }),
    'job list': json({ jobs: [{ job_id: 'widget:042', source: 'pa', external_id: KEY, state: 'queued' }] }),
  };
  assert.strictEqual((await factory.start({ target, app: 'widget', delivery: 'pr' })).jobId, 'widget:042');
  // An unknown submit is never waiting forever: after a day, failed and notified, even unasked.
  assert.strictEqual(F.submitVerdict({ job: null, asked: false, ageMs: F.UNKNOWN_CAP_MS }), 'fail');
  notes.length = 0;
  store.queries.length = 0;
  store.unsettled = [{ id: 15, commitment_id: null, task: 'old', status: 'waiting', factory_state: 'submit_unknown', age_ms: String(3 * 86400e3) }];
  answers = { 'job list': { code: 127, stdout: '', stderr: '' } };
  await factory.sweepUnsettled();
  assert.ok(store.queries.some((q) => /status = 'failed'.*not_submitted/s.test(q.sql) && q.params[0] === 15));
  assert.match(notes.find((x) => /factory-unsettled:15/.test(x.dedupeKey)).body, /could not be asked for a day/);
  store.unsettled = [];

  // MUST-FIX 13: created:false on the FIRST submit is someone else's job — never adopted.
  calls.length = 0;
  store.queries.length = 0;
  answers = { 'job submit': json({ job_id: 'widget:043', created: false, delivery: 'pr' }) };
  await assert.rejects(factory.start({ target, app: 'widget', delivery: 'pr' }), (e) => e.code === 'duplicate_key');
  assert.ok(!store.queries.some((q) => /factory_job_id = \$2/.test(q.sql)), 'not recorded');
  assert.ok(global.__txQueries.some((q) => /update run set external_id = \$2/.test(q.sql) && q.params[1] === KEY), 'the key is written inside the insert\'s transaction');

  // #14b: a job that turns up for a run dropped meanwhile is cancelled; the row stays dropped.
  calls.length = 0;
  store.queries.length = 0;
  transitions.length = 0;
  store.runEnded = true;
  store.unsettled = [{ id: 16, commitment_id: 46, status: 'waiting', factory_state: 'submit_unknown', external_id: 'k-16', age_ms: '1000' }];
  answers = {
    'job list': json({ jobs: [{ job_id: 'widget:016', source: 'pa', external_id: 'k-16', state: 'queued' }] }),
    'job cancel': json({ job_id: 'widget:016', state: 'cancelled' }),
  };
  await factory.sweepUnsettled();
  assert.ok(calls.some((c) => c.argv.slice(3).join(' ') === 'job cancel widget:016 --json'), 'the late job is cancelled');
  assert.ok(!store.queries.some((q) => /status = 'running'/.test(q.sql) && !/status in/.test(q.sql)), 'never set running unconditionally');
  assert.ok(store.queries.some((q) => /factory_state = 'cancelled'/.test(q.sql)));
  assert.deepStrictEqual(transitions, [], 'no commitment move');
  // …and at start: a run dropped while its submit was in flight.
  calls.length = 0;
  answers = { 'job submit': json({ job_id: 'widget:017b', created: true }), 'job cancel': json({ job_id: 'widget:017b', state: 'cancelled' }) };
  await assert.rejects(factory.start({ target, app: 'widget', delivery: 'pr' }), /dropped while its job was being submitted; job widget:017b was cancelled/);
  store.runEnded = false;
  store.unsettled = [];

  // 5. A contract error is a refusal: failed at once, no reconcile.
  calls.length = 0;
  answers = { 'job submit': json({ error: 'unknown_repo', message: 'x' }, 2) };
  await assert.rejects(factory.start({ target, app: 'widget', delivery: 'pr' }), (e) => e.code === 'unknown_repo');
  assert.deepStrictEqual(calls.length, 1);
}

// --- item 6: registering a repo with the factory ---------------------------------------

async function factoryRegister() {
  assert.deepStrictEqual(F.appAddArgv({ repo: 'acme/widget' }), ['app', 'add', '--json', '--repo', 'acme/widget', '--delivery-default', 'draft_pr']);
  assert.deepStrictEqual(F.appAddArgv({ repo: 'acme/w', deliveryDefault: 'auto_merge', path: '/srv/w' }).slice(-3), ['--delivery-default', 'auto_merge', '--path=/srv/w']);
  assert.throws(() => F.appAddArgv({ repo: 'acme/w; rm -rf /' }), /not a repo/);
  assert.throws(() => F.appAddArgv({ repo: 'acme/w', deliveryDefault: 'yolo' }), /unknown delivery/);
  assert.ok(!F.appAddArgv({ repo: 'a/b' }).includes('--delivery-max'), 'the contract has no ceiling');

  const route = require('../src/dispatch/route');
  calls.length = 0;
  store.repoDefault = 'pr';
  let registered = false;
  answers = {
    'app list': () => json({ apps: registered ? [{ app: 'gadget', repo: 'acme/gadget' }] : [{ app: 'widget', repo: 'acme/widget' }] }),
    'app add': (argv) => { registered = true; return json({ app: 'gadget', repo: argv[argv.indexOf('--repo') + 1], delivery: { default: argv[argv.indexOf('--delivery-default') + 1] } }); },
  };
  const target = { commitment: { id: 50, kind: 'coding' }, project: { gitlab_path: 'acme/gadget' }, repoPath: null };
  await assert.rejects(route.forced({ target, mode: 'mr' }), /not registered/);
  const r = await route.forced({ target, register: true });
  assert.strictEqual(r.app, 'gadget');
  const add = calls.find((c) => c.argv[3] === 'app' && c.argv[4] === 'add');
  assert.deepStrictEqual(add.argv.slice(3), ['app', 'add', '--json', '--repo', 'acme/gadget', '--delivery-default', 'pr'], 'the repo\'s PA default');
  store.repoDefault = null;
}

// --- MUST-FIX 15: one live run per commitment, under a lock --------------------------

async function liveRunGuard() {
  const { LOCK_SPACE } = require('../src/repo/runs.ts');
  const { runs } = require('../src/repo');
  const v = { commitmentId: 31, mode: 'mr', task: 't', repoPath: null, machine: 'm', routeReason: null, kind: null, delivery: 'pr', deliverySource: 'default' };
  global.__txLocks = [];
  global.__liveRun = { id: 99 };
  await assert.rejects(runs.insertClaude(v, { commitmentId: 31 }), (e) => e.code === 'live_run' && /#31 already has run #99/.test(e.message));
  assert.deepStrictEqual(global.__txLocks, [[LOCK_SPACE, 31]], 'the re-check runs under the commitment\'s lock');
  const again = await runs.insertClaude(v, { commitmentId: 31, again: true });
  assert.strictEqual(again.id, store.nextId, '--again starts a second one on purpose');
  global.__liveRun = null;
  assert.strictEqual((await runs.insertClaude(v, { commitmentId: 31 })).id, store.nextId);
  store.queries.length = 0;
  // Every run insert goes through the guarded repository methods.
  for (const f of ['index.js', 'factory.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dispatch', f), 'utf8');
    assert.ok(!/insert into run\b/.test(src), `${f}: no run insert outside src/repo/runs.js`);
    assert.ok(/runs\.insert(Claude|Factory)\(/.test(src), `${f}: inserts through the runs repository`);
  }
}

(async () => {
  await execLocal();
  await liveRunGuard();
  await factoryStart();
  await factoryPoll();
  await routeDecide();
  await factoryReconcile();
  await factoryRegister();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('factoryDispatch ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
