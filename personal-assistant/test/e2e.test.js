'use strict';

// `pa e2e` (plan E4): the golden path's pure rules (src/e2e/goldenPathCore.ts)
// and the runner (src/e2e/goldenPath.ts) driven end to end with fakes for the
// card store, the chat's tools, the factory, termhub, the dashboard and gh.
// No network, no database.

const assert = require('assert');
const C = require('../src/e2e/goldenPathCore.ts');
const G = require('../src/e2e/goldenPath.ts');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------- options ----

test('options: defaults are the claude_session golden path on this repo', () => {
  const o = C.parseOptions({}, {});
  assert.strictEqual(o.runtime, 'claude_session');
  assert.strictEqual(o.repo, 'xvanov/dev-tools');
  assert.strictEqual(o.keep, false);
  assert.strictEqual(o.dryRun, false);
  assert.strictEqual(o.poll, 10);
  assert.deepStrictEqual(o.timeouts, C.DEFAULT_TIMEOUTS);
  assert.strictEqual(C.variant(o), 'claude_session');
});

test('options: variants, timeouts and refusals', () => {
  const o = C.parseOptions({ runtime: 'api', model: 'deepseek/deepseek-chat', resume: true, branch: 'feat/x', 'dry-run': true }, { timeout: ['pr_opened=60', 'views=5'] });
  assert.strictEqual(C.variant(o), 'api:deepseek/deepseek-chat+resume+branch:feat/x');
  assert.strictEqual(o.timeouts.pr_opened, 60);
  assert.strictEqual(o.timeouts.views, 5);
  assert.strictEqual(o.timeouts.card, C.DEFAULT_TIMEOUTS.card);
  assert.throws(() => C.parseOptions({ runtime: 'opencode' }), /--runtime/);
  assert.throws(() => C.parseOptions({ model: 'deepseek/deepseek-chat' }), /needs --runtime api/);
  assert.throws(() => C.parseOptions({}, { timeout: ['nope=1'] }), /hop=seconds/);
  assert.throws(() => C.parseOptions({ keep: 'later' }), /takes no value/);
  assert.throws(() => C.parseOptions({ 'dry-run': true, sweep: true }), /separate/);
  assert.throws(() => C.parseOptions({ repo: 'not a repo' }), /owner\/name/);
  assert.throws(() => C.parseOptions({ stack: 'mars' }), /work or personal/);
  assert.throws(() => C.parseOptions({ branch: 'a b' }), /branch/);
});

test('hops: resume adds killed and resumed after first output', () => {
  assert.deepStrictEqual(C.hopsFor({}).map((h) => h.id), ['card', 'job_started', 'first_output', 'pr_opened', 'ci_done']);
  assert.deepStrictEqual(C.hopsFor({ resume: true }).map((h) => h.id), ['card', 'job_started', 'first_output', 'killed', 'resumed', 'pr_opened', 'ci_done']);
});

test('dummy card carries the marker in its text, ask and title', () => {
  const m = 'e2e-12345678-1234-1234-1234-123456789abc';
  const d = C.dummyCard(m);
  for (const k of ['text', 'ask', 'title']) assert.ok(d[k].includes(m), k);
  assert.ok(C.MARKER_RE.test(d.text));
  assert.ok(d.text.length <= 200, 'one line on the board');
});

// ------------------------------------------------------------- observe ----

const JOB_RUNNING = {
  job_id: 'dev-tools:0007', state: 'in_progress',
  runs: [{ id: 41, story_id: 1, runtime: 'claude_session', persona: 'dev', state: 'running', session: { machine: '', termhub_session_id: 'abc123', url: 'http://h/#session=abc123', links: { job: 'dev-tools:0007', step: '41' } } }],
  stories: [{ id: 1, state: 'in_progress', pr_url: null, branch: 'factory/0007-1' }],
};
const JOB_PR = {
  ...JOB_RUNNING, state: 'done',
  runs: [{ ...JOB_RUNNING.runs[0], state: 'ok' }],
  stories: [{ id: 1, state: 'done', pr_url: 'https://github.com/xvanov/dev-tools/pull/9', pr_number: 9, pr_state: 'open', branch: 'factory/0007-1', ci: { state: 'pending' } }],
};
const JOB_CI = { ...JOB_PR, stories: [{ ...JOB_PR.stories[0], ci: { state: 'passing', failing: [] } }] };

test('observe: each hop is stamped once, at the poll that first shows it', () => {
  let t = { card: 0 };
  let r = C.observe(t, { job_id: 'a:1', state: 'queued', runs: [], stories: [] }, { at: 5 });
  assert.deepStrictEqual(r.reached, []);
  r = C.observe(r.timeline, JOB_RUNNING, { at: 10 });
  assert.deepStrictEqual(r.reached, ['job_started']);
  r = C.observe(r.timeline, JOB_RUNNING, { at: 20, output: true });
  assert.deepStrictEqual(r.reached, ['first_output']);
  r = C.observe(r.timeline, JOB_PR, { at: 30, output: true });
  assert.deepStrictEqual(r.reached, ['pr_opened']);
  r = C.observe(r.timeline, JOB_CI, { at: 40 });
  assert.deepStrictEqual(r.reached, ['ci_done']);
  t = r.timeline;
  assert.deepStrictEqual(t, { card: 0, job_started: 10, first_output: 20, pr_opened: 30, ci_done: 40 });
  assert.strictEqual(C.observe(t, JOB_CI, { at: 50, output: true }).reached.length, 0, 'never moved');
  assert.strictEqual(C.nextHop(C.hopsFor({}), t), null);
});

test('observe: CI none or pending is not done', () => {
  const none = { ...JOB_PR, stories: [{ ...JOB_PR.stories[0], ci: { state: 'none' } }] };
  assert.ok(!C.observe({}, none, { at: 1 }).reached.includes('ci_done'));
  assert.ok(C.observe({}, { ...JOB_PR, stories: [{ ...JOB_PR.stories[0], ci: { state: 'failing' } }] }, { at: 1 }).reached.includes('ci_done'));
});

test('overdue: counted from the last hop reached; deadEnd when a job ends without a PR', () => {
  const hops = C.hopsFor({});
  const tl = { card: 1000, job_started: 2000 };
  assert.strictEqual(C.overdue(hops, tl, { ...C.DEFAULT_TIMEOUTS, first_output: 10 }, 11_000, 0), null);
  assert.deepStrictEqual(C.overdue(hops, tl, { ...C.DEFAULT_TIMEOUTS, first_output: 10 }, 13_000, 0), { hop: 'first_output', waitedS: 11, limitS: 10 });
  assert.ok(C.deadEnd({ state: 'failed', stories: [] }));
  assert.ok(!C.deadEnd({ state: 'failed', stories: [{ pr_url: 'https://github.com/a/b/pull/1' }] }));
  assert.ok(!C.deadEnd({ state: 'in_progress', stories: [] }));
});

test('chainIds: steps, sessions and PRs from the factory status', () => {
  const ids = C.chainIds(JOB_PR, { card: 77, run: 5, job: 'dev-tools:0007' });
  assert.strictEqual(ids.card, '77');
  assert.strictEqual(ids.run, 5);
  assert.strictEqual(ids.job, 'dev-tools:0007');
  assert.deepStrictEqual(ids.steps.map((s) => [s.step, s.session.id]), [['41', 'abc123']]);
  assert.deepStrictEqual(ids.prs.map((p) => [p.number, p.branch]), [[9, 'factory/0007-1']]);
  assert.strictEqual(C.prNumberOf(null, 'https://github.com/a/b/pull/12'), 12);
});

// --------------------------------------------------------------- views ----

const IDS = C.chainIds(JOB_PR, { card: 77, run: 5, job: 'dev-tools:0007' });
const CHAIN = [{ card: '77', run: 5, job: 'dev-tools:0007', steps: [{ step: '41', session: { id: 'abc123' } }], prs: [{ number: 9, url: 'https://github.com/xvanov/dev-tools/pull/9', ci: 'passing' }] }];

function allOk(list) {
  const bad = list.filter((c) => !c.ok);
  assert.deepStrictEqual(bad, [], JSON.stringify(bad));
}

test('plan: the card is found anywhere in /api/state and its chain checked', () => {
  allOk(C.checkPlanBoard({ commitments: [{ id: 3, chain: [] }, { id: 77, chain: CHAIN }], board: {} }, IDS));
  const wrongJob = C.checkPlanBoard({ commitments: [{ id: 77, chain: [{ ...CHAIN[0], job: 'dev-tools:0001' }] }] }, IDS);
  assert.ok(wrongJob.some((c) => !c.ok && c.check === 'run → job'));
  assert.ok(!C.checkPlanBoard({ commitments: [] }, IDS)[0].ok);
  // Delivered: the card closed and left the board; it is in `closed`.
  const closed = C.checkPlanBoard({ commitments: [], closed: [{ id: '77', status: 'done' }] }, IDS);
  assert.ok(closed.length === 1 && closed[0].ok && /closed as done/.test(closed[0].detail));
  allOk(C.checkCardDetail({ id: 77, chain: CHAIN }, IDS));
  assert.ok(!C.checkCardDetail({ error: 'no commitment #77' }, IDS)[0].ok);
});

test('build: job → run, card, PR and step sessions', () => {
  const fac = { enabled: true, groups: { delivered: [{ jobId: 'dev-tools:0007', group: 'delivered', paRun: { id: 5, card: '77' }, stories: [{ prNumber: 9 }], runs: [{ id: 41, session: { id: 'abc123' } }] }] } };
  allOk(C.checkBuild(fac, IDS));
  const noCard = JSON.parse(JSON.stringify(fac));
  noCard.groups.delivered[0].paRun.card = null;
  assert.ok(C.checkBuild(noCard, IDS).some((c) => !c.ok && c.check === 'job → card'));
  assert.ok(!C.checkBuild({ enabled: false }, IDS)[0].ok);
});

test('run: each step session listed with matching links, alive or with scrollback', () => {
  const sessions = { '': [{ id: 'abc123', alive: false, links: { job: 'dev-tools:0007', step: '41', card: '77' } }] };
  allOk(C.checkRun(sessions, IDS, { scrollback: { abc123: '\x1b[1m● Reading files\x1b[0m' } }));
  const empty = C.checkRun(sessions, IDS, { scrollback: { abc123: '\x1b[0m  \n' } });
  assert.ok(empty.some((c) => !c.ok && /watchable/.test(c.check)));
  const wrong = C.checkRun({ '': [{ id: 'abc123', alive: true, links: { job: 'x:1', step: '41' } }] }, IDS);
  assert.ok(wrong.some((c) => !c.ok && /→ job/.test(c.check)));
  assert.ok(!C.checkRun({ '': [] }, IDS)[0].ok);
});

test('mcp and github', () => {
  allOk(C.checkMcpCard({ runs: [{ run: 5, job: 'dev-tools:0007', steps: [{ step: '41' }], prs: [{ number: 9 }] }] }, IDS));
  assert.ok(!C.checkMcpCard({ runs: [] }, IDS)[0].ok);
  allOk(C.checkMcpJob({ card: '77', stories: [{ pr_number: 9 }], runs: [{ id: 41, session_id: 'abc123' }] }, IDS));
  assert.ok(C.checkMcpJob({ card: '1', stories: [], runs: [] }, IDS).some((c) => !c.ok));
  allOk(C.checkGithub({ number: 9, headRefName: 'factory/0007-1', isDraft: true, state: 'OPEN' }, IDS.prs[0]));
  assert.ok(C.checkGithub({ number: 9, headRefName: 'other', isDraft: false }, IDS.prs[0]).filter((c) => !c.ok).length === 2);
});

test('e2: skipped without an API step; an API step needs a session with output', () => {
  const skip = C.checkWatchable(IDS, { runtime: 'claude_session' });
  assert.ok(skip[0].ok && skip[0].skipped);
  const apiJob = { ...JOB_PR, runs: [{ id: 50, runtime: 'api', state: 'ok', session: null }] };
  const noSession = C.checkWatchable(C.chainIds(apiJob, { card: 77, run: 5 }), { runtime: 'api' });
  assert.ok(noSession.some((c) => !c.ok && /has a session/.test(c.check)));
  const withSession = { ...apiJob, runs: [{ id: 50, runtime: 'api', state: 'ok', session: { termhub_session_id: 's9' } }] };
  allOk(C.checkWatchable(C.chainIds(withSession, { card: 77, run: 5 }), { runtime: 'api', scrollback: { s9: 'assistant: I will add the verb' } }));
  assert.ok(!C.checkWatchable(C.chainIds({ ...JOB_PR, runs: [] }, {}), { runtime: 'api' })[0].ok);
});

test('report and table', () => {
  const hops = C.hopsFor({});
  const r = C.summarize({ marker: 'e2e-x', stack: 'work', options: C.parseOptions({}), hops, timeline: { card: 1000, job_started: 4000 }, t0: 0, checks: [{ view: 'plan', check: 'c', ok: true }] });
  assert.strictEqual(r.ok, false, 'hops not reached fail the run');
  assert.deepStrictEqual(r.hops.map((h) => [h.hop, h.reached, h.hopS, h.sinceStartS]).slice(0, 3), [['card', true, 1, 1], ['job_started', true, 3, 4], ['first_output', false, null, null]]);
  const text = C.table(r);
  assert.ok(/NOT REACHED/.test(text) && /FAILED/.test(text) && /plan 1\/1/.test(text));
  const dry = C.summarize({ options: C.parseOptions({ 'dry-run': true }), hops: [], timeline: {}, t0: 0, checks: [{ view: 'config', check: 'x', ok: true }], dryRun: true });
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.kind, 'dry-run');
});

test('remoteArgv passes plain flags, never --on/--report, and refuses shell-looking values', () => {
  assert.deepStrictEqual(C.remoteArgv({ on: 'box', 'dry-run': true, runtime: 'api', model: 'deepseek/deepseek-chat' }, { timeout: ['views=5'] }),
    ['e2e', '--json', '--dry-run', '--runtime', 'api', '--model', 'deepseek/deepseek-chat', '--timeout', 'views=5']);
  assert.throws(() => C.remoteArgv({ branch: 'x; rm -rf /' }), /cannot be passed/);
});

// -------------------------------------------------- the runner, with fakes ----

function fakes({ jobs, failStart = false, prBranch = 'factory/0007-1', alive = true } = {}) {
  const log = { chat: [], gh: [], killed: [], closed: [], stopped: [], sleeps: 0 };
  let clock = 0;
  let poll = 0;
  const deps = {
    config: { termhub: { machines: {} } },
    now: () => clock,
    sleep: async (ms) => { clock += ms; log.sleeps++; },
    log: () => {},
    uuid: () => '12345678-1234-1234-1234-123456789abc',
    paBase: 'http://pa',
    async getJson(url) {
      const last = jobs[Math.min(poll - 1, jobs.length - 1)];
      if (url.endsWith('/api/state')) return { commitments: [{ id: 77, chain: [{ card: '77', run: 5, job: 'dev-tools:0007', steps: (last.runs || []).map((r) => ({ step: String(r.id), session: r.session ? { id: r.session.termhub_session_id } : null })), prs: (last.stories || []).filter((s) => s.pr_url).map((s) => ({ number: s.pr_number, url: s.pr_url })) }] }] };
      if (url.endsWith('/api/commitments/77')) return { id: 77, chain: (await deps.getJson('http://pa/api/state')).commitments[0].chain };
      if (url.endsWith('/api/factory')) return { enabled: true, groups: { delivered: [{ jobId: 'dev-tools:0007', group: 'delivered', paRun: { id: 5, card: '77' }, stories: (last.stories || []).map((s) => ({ prNumber: s.pr_number })), runs: (last.runs || []).map((r) => ({ id: r.id, session: r.session ? { id: r.session.termhub_session_id } : null })) }] } };
      if (url.endsWith('/healthz')) return { ready: true, commit: 'abc1234' };
      throw new Error(`unexpected ${url}`);
    },
    addCard: async (text) => { log.card = text; return { id: 77 }; },
    closeCard: async (id) => { log.closed.push(String(id)); },
    async chat(name, args) {
      log.chat.push([name, args]);
      if (name === 'factory_start' || name === 'factory_continue') return failStart ? { started: false, note: 'no' } : { started: true, run: 5, job: 'dev-tools:0007' };
      if (name === 'factory_resume') return { job: args.job, resumed: true, was: 'failed', state: 'in_progress' };
      if (name === 'factory_cancel') return { job: args.job, state: 'cancelled' };
      if (name === 'card') {
        const last = jobs[jobs.length - 1];
        return { runs: [{ run: 5, job: 'dev-tools:0007', steps: last.runs.map((r) => ({ step: String(r.id) })), prs: last.stories.filter((s) => s.pr_url).map((s) => ({ number: s.pr_number })) }] };
      }
      if (name === 'factory_job') {
        const last = jobs[jobs.length - 1];
        return { card: '77', stories: last.stories.map((s) => ({ pr_number: s.pr_number })), runs: last.runs.map((r) => ({ id: r.id, session_id: r.session?.termhub_session_id })) };
      }
      if (name === 'sessions') return { sessions: [] };
      throw new Error(`unexpected tool ${name}`);
    },
    factoryEnabled: () => true,
    factoryMachine: () => null,
    factoryApps: async () => [{ app: 'dev-tools', repo: 'xvanov/dev-tools' }],
    jobStatus: async () => jobs[Math.min(poll++, jobs.length - 1)],
    stopJob: async (id) => { log.stopped.push(id); return { job_id: id, state: 'cancelled' }; },
    hub: () => ({
      screen: async () => '● Reading personal-assistant/src/cli/index.js',
      listSessions: async () => [{ id: 'abc123', alive, links: { job: 'dev-tools:0007', step: '41' } }],
      killSession: async (id) => { log.killed.push(id); return true; },
    }),
    dbProbe: async () => ({ ok: 1 }),
    e2eCards: async () => [],
    jobsOfCommitments: async () => [],
    prLinksOf: async () => [],
    stepSessionsOf: async () => [],
    async gh(args, owner) {
      log.gh.push([args.join(' '), owner]);
      if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ number: 9, headRefName: prBranch, isDraft: true, state: 'OPEN' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'close') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ viewerPermission: 'ADMIN' }), stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
  return { deps, log };
}

test('runner: a green golden path times every hop, checks every view, and cleans up', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING, JOB_PR, JOB_CI] });
  const r = await G.main({}, {}, deps);
  assert.strictEqual(r.ok, true, JSON.stringify(r.failed.concat(r.errors)));
  assert.deepStrictEqual(r.hops.map((h) => h.reached), [true, true, true, true, true]);
  assert.ok(C.MARKER_RE.test(log.card));
  const start = log.chat.find(([n]) => n === 'factory_start')[1];
  assert.deepStrictEqual([start.card, start.runtime, start.delivery, start.repo], ['77', 'claude_session', 'draft_pr', 'xvanov/dev-tools']);
  for (const v of ['plan', 'plan-card', 'build', 'run', 'mcp', 'github', 'e2']) assert.ok(r.checks.some((c) => c.view === v), v);
  assert.ok(log.gh.some(([a, o]) => a === 'pr close 9 --repo xvanov/dev-tools --delete-branch' && o === 'xvanov'));
  assert.ok(!log.chat.some(([n]) => n === 'factory_cancel'), 'a done job is not cancelled');
  assert.deepStrictEqual(log.closed, ['77']);
  assert.deepStrictEqual(log.killed, ['abc123']);
});

test('runner: the live feed wakes the poll and is closed at the end', async () => {
  const { deps } = fakes({ jobs: [JOB_RUNNING, JOB_PR, JOB_CI] });
  const feed = { url: null, closed: false, push: null };
  deps.subscribe = (url, onEvent) => {
    feed.url = url;
    feed.push = onEvent;
    return () => { feed.closed = true; };
  };
  const sleep = deps.sleep;
  deps.sleep = async (ms) => { feed.push({ topic: 'board' }); feed.push({ topic: 'run', id: 5 }); return sleep(ms); };
  const r = await G.main({}, {}, deps);
  assert.strictEqual(r.ok, true, JSON.stringify(r.failed.concat(r.errors)));
  assert.strictEqual(feed.url, 'http://pa/api/events');
  assert.ok(feed.closed);
  assert.ok(/^sse \(\d+ run\/factory events\)/.test(r.feed), r.feed);
  assert.ok(!/^sse \(0 /.test(r.feed), 'run events counted, board events not');
});

test('runner: --keep leaves the PR and card; a wrong PR branch fails the run', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING, JOB_CI], prBranch: 'someone-else' });
  const r = await G.main({ keep: true }, {}, deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failed.some((f) => /head = story branch/.test(f)));
  assert.ok(!log.gh.some(([a]) => a.startsWith('pr close')));
  assert.deepStrictEqual(log.closed, []);
  assert.ok(/--keep/.test(r.cleanup[0]));
});

test('runner: a hop past its timeout ends the run, and cleanup still cancels the live job', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING] });
  const r = await G.main({}, { timeout: ['pr_opened=30', 'views=0'] }, deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /timed out waiting for pr_opened/.test(e)), r.errors.join('; '));
  assert.ok(log.chat.some(([n]) => n === 'factory_cancel'));
  assert.deepStrictEqual(log.closed, ['77']);
});

test('runner: a start that does not start is an error, and the card is still dropped', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING], failStart: true });
  const r = await G.main({}, {}, deps);
  assert.strictEqual(r.ok, false);
  assert.ok(/did not start a job/.test(r.errors[0]));
  assert.deepStrictEqual(log.closed, ['77']);
});

test('runner: --resume cancels the job mid-step through the factory, then resumes it', async () => {
  const cancelled = { ...JOB_RUNNING, state: 'cancelled', runs: [{ ...JOB_RUNNING.runs[0], state: 'cancelled' }] };
  const { deps, log } = fakes({ jobs: [JOB_RUNNING, cancelled, JOB_RUNNING, JOB_PR, JOB_CI] });
  const r = await G.main({ resume: true }, {}, deps);
  assert.strictEqual(r.ok, true, JSON.stringify(r.failed.concat(r.errors)));
  assert.deepStrictEqual(r.hops.map((h) => h.hop), ['card', 'job_started', 'first_output', 'killed', 'resumed', 'pr_opened', 'ci_done']);
  assert.deepStrictEqual(log.stopped, ['dev-tools:0007']);
  assert.ok(!log.chat.some(([n]) => n === 'factory_cancel'), "the chat's cancel would drop the PA run");
  assert.ok(log.chat.some(([n]) => n === 'factory_resume'));
});

test('runner: --resume waits for a claude_session step; an API step\'s session is only a viewer', async () => {
  const planning = { ...JOB_RUNNING, runs: [{ id: 40, story_id: 1, runtime: 'api', persona: 'pm', state: 'running', session: { machine: '', termhub_session_id: 'view40', links: { job: 'dev-tools:0007', step: '40' } } }] };
  const cancelled = { ...JOB_RUNNING, state: 'cancelled', runs: [{ ...JOB_RUNNING.runs[0], state: 'cancelled' }] };
  const { deps, log } = fakes({ jobs: [planning, planning, JOB_RUNNING, cancelled, JOB_RUNNING, JOB_PR, JOB_CI] });
  const r = await G.main({ resume: true }, {}, deps);
  assert.strictEqual(r.ok, true, JSON.stringify(r.failed.concat(r.errors)));
  assert.deepStrictEqual(log.stopped, ['dev-tools:0007'], 'one cancel, made once the claude_session step ran');
  assert.ok(r.hops.find((h) => h.hop === 'killed').sinceStartS > r.hops.find((h) => h.hop === 'first_output').sinceStartS);
});

test('run view: the cancelled attempt\'s session may be gone; any other must be listed', () => {
  const ids = C.chainIds(JOB_RUNNING, { card: 77, run: 5 });
  allOk(C.checkRun({ '': [] }, ids, { stopped: new Set(['abc123']) }));
  assert.ok(C.checkRun({ '': [] }, ids).some((c) => !c.ok && /listed/.test(c.check)));
});

test('runner: --branch continues the branch through factory_continue', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING, JOB_CI] });
  await G.main({ branch: 'feat/x' }, {}, deps);
  const call = log.chat.find(([n]) => n === 'factory_continue');
  assert.ok(call && call[1].branch === 'feat/x');
});

test('dry run creates nothing and reports each check', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING] });
  deps.getJson = async (url) => {
    if (url.endsWith('/healthz')) return { ready: true, commit: 'abc1234' };
    if (url.endsWith('/api/state')) return { commitments: [] };
    if (url.endsWith('/api/factory')) return { enabled: true, groups: {} };
    throw new Error('unexpected');
  };
  const r = await G.main({ 'dry-run': true }, {}, deps);
  assert.strictEqual(r.ok, true, JSON.stringify(r.failed));
  assert.strictEqual(r.kind, 'dry-run');
  assert.strictEqual(log.card, undefined);
  assert.ok(!log.chat.some(([n]) => n.startsWith('factory_')));
  deps.factoryMachine = () => 'other-box';
  const crossed = await G.main({ 'dry-run': true }, {}, deps);
  assert.ok(crossed.failed.some((f) => /D13/.test(f)));
});

test('sweep closes leftovers found through stored links', async () => {
  const { deps, log } = fakes({ jobs: [JOB_RUNNING] });
  deps.e2eCards = async () => [{ id: 70, status: 'open' }, { id: 71, status: 'dropped' }];
  deps.jobsOfCommitments = async () => [{ id: 5, factory_job_id: 'dev-tools:0007', factory_state: 'in_progress' }];
  deps.prLinksOf = async () => [{ pr_number: 9, pr_url: 'https://github.com/xvanov/dev-tools/pull/9' }];
  deps.stepSessionsOf = async () => [{ termhub_session_id: 'abc123', machine: null }];
  const r = await G.main({ sweep: true }, {}, deps);
  assert.strictEqual(r.ok, true);
  assert.ok(log.gh.some(([a]) => a.startsWith('pr close 9')));
  assert.ok(log.chat.some(([n, a]) => n === 'factory_cancel' && a.job === 'dev-tools:0007'));
  assert.deepStrictEqual(log.closed, ['70']);
  assert.deepStrictEqual(log.killed, ['abc123']);
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
