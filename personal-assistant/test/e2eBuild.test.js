'use strict';

// `pa e2e build-pr | build-continue-pr | research` (D30; src/e2e/buildRunners.ts) with fakes for
// the dashboard POST, the Build run and GitHub. No network, no database, no agent.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/e2e/workflows.ts');
const B = require('../src/e2e/buildRunners.ts');
const ARCH = require('../src/dashboard/architecture.json');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PR_URL = 'https://github.com/xvanov/dev-tools/pull/90';

/** A Build run that ends done; GitHub as a fake: one PR (draft, one file, CI green) that a continue fast-forwards. */
function buildDeps(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-build-'));
  let clock = 1_000_000;
  const log = { posts: [], result: PR_URL, gh: [] };
  const state = { head: 'h1' };
  const report = path.join(dir, 'report.md');
  fs.writeFileSync(report, `# Dirty tree\n\n${'termhub/windows/update.ps1:42 refuses a dirty tree. '.repeat(10)}`);
  log.report = report;
  const pr = (over2 = {}) => ({ data: { repository: {
    pullRequest: { number: 90, state: 'OPEN', merged: false, isDraft: true, headRefName: 'jarvis/12-x', headRefOid: state.head, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { oid: state.head, statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over2 },
    pullRequests: { nodes: [{ number: 90, headRefName: 'jarvis/12-x' }] },
  } } });
  const deps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    uuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    paBase: 'http://pa',
    arch: () => ARCH,
    root: () => dir,
    write: (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); },
    browser: () => null,
    capture: async (d, pages) => ({ shots: pages.map((p) => ({ view: p.name, url: p.url, file: path.join(d, `${p.name}.png`) })), note: null }),
    getJson: async (url) => {
      if (url.endsWith('/api/workflow-limits')) return { limits: {} };
      if (url.includes('/api/build')) return { runs: [], total: 0 };
      throw new Error(`unexpected ${url}`);
    },
    post: async (url, body) => { log.posts.push([url, body]); clock += 4200; return JSON.stringify({ id: 12, state: 'running', model: body.model, url: 'http://hub/#s', timings: { total_ms: 4200 } }); },
    build: {
      get: async () => (state.head = 'h1', { id: 12, state: 'done', started_at: new Date(1_000_000).toISOString(), ended_at: new Date(1_150_000).toISOString(), cost_usd: 0.11, result: log.result, branch: 'jarvis/12-x', transcript_path: null }),
      stop: async () => {},
    },
    gh: async (args) => {
      const j = args.join(' ');
      log.gh.push(j);
      const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
      if (j.includes('graphql')) return ok(JSON.stringify(pr(log.prOver)));
      if (j.includes('/files')) return ok(JSON.stringify(log.files || [{ f: 'keep-awake/README.md', c: 1 }]));
      if (j.includes('git/ref/heads/main')) return ok('base1\n');
      if (j.includes('/contents/')) { state.head = 'h0'; return ok(JSON.stringify({ commit: { sha: 'h0' } })); }
      if (j.includes('/compare/')) { state.head = 'h1'; return ok('ahead\n'); }
      if (/repos\/xvanov\/dev-tools\/pulls -f title=/.test(j)) return ok(JSON.stringify({ number: 90 }));
      if (j.includes('/pulls/90/comments') && j.includes('--jq')) return ok('2\n');
      if (j.includes('/issues/90/comments')) return ok('0\n');
      if (j.startsWith('pr view')) return ok(JSON.stringify({ state: 'OPEN', mergedAt: null }));
      return ok('{}');
    },
    ...over,
  };
  // The seeded PR's head starts at h0 (the contents call); after the "agent", it is h1.
  return { deps, log, state };
}

const byName = (s) => Object.fromEntries(s.checks.map((c) => [c.check, c]));

test('helpers: first tool call time from a transcript; PR number from a URL', () => {
  const jsonl = ['{"type":"user","timestamp":"2026-11-10T19:00:05.000Z"}', '{"type":"assistant","timestamp":"2026-11-10T19:00:20.000Z","message":{"content":[{"type":"tool_use"}]}}'].join('\n');
  assert.strictEqual(B.firstActionMs(jsonl, Date.parse('2026-11-10T19:00:00.000Z')), 20_000);
  assert.strictEqual(B.firstActionMs('', 0), null);
  assert.strictEqual(B.prNumber(PR_URL), 90);
  assert.strictEqual(B.prNumber('a report path'), null);
});

test('the Map has the three Build flows with runners; the old factory ids are gone', () => {
  for (const id of ['build-pr', 'build-continue-pr', 'research']) assert.ok(R.RUNNERS[id], id);
  for (const id of ['deepseek-pr', 'review-fix']) assert.ok(!R.RUNNERS[id], id);
});

test('build-pr: one haiku run through POST /api/build/runs; draft, scope, CI, cost checked; the PR is closed', async () => {
  const { deps, log } = buildDeps();
  const s = await R.main('build-pr', {}, {}, deps);
  const [url, body] = log.posts[0];
  assert.match(url, /\/api\/build\/runs$/);
  assert.strictEqual(body.model, 'haiku');
  assert.ok(body.repo && /keep-awake\/README\.md/.test(body.task));
  const c = byName(s);
  assert.ok(c['run ended done'].ok && c['PR is a draft, open, not merged'].ok && c['CI green on the PR head'].ok && c['cost under the cap ($0.5)'].ok, JSON.stringify(s.checks.filter((x) => !x.ok)));
  assert.ok(log.gh.some((g) => g.startsWith('pr close 90') && g.includes('--delete-branch')));
  assert.ok(s.cleanup.some((x) => /closed/.test(x)));
});

test('build-pr: a non-draft PR, red CI or a PR over scope fails the run', async () => {
  const { deps, log } = buildDeps();
  log.prOver = { isDraft: false, commits: { nodes: [{ commit: { oid: 'h1', statusCheckRollup: { state: 'FAILURE' } } }] } };
  log.files = [{ f: 'a', c: 1 }, { f: 'b', c: 1 }];
  const s = await R.main('build-pr', {}, { timeout: ['ci=1'] }, deps);
  assert.strictEqual(s.ok, false);
  const failed = s.checks.filter((x) => !x.ok).map((x) => x.check);
  assert.ok(failed.includes('PR is a draft, open, not merged') && failed.includes('CI green on the PR head') && failed.some((x) => /^scope/.test(x)), failed.join(' | '));
});

test('build-continue-pr: seeds a draft PR with a review comment; the agent fast-forwards it; the PR is closed', async () => {
  const { deps, log } = buildDeps();
  const s = await R.main('build-continue-pr', {}, {}, deps);
  assert.match(log.posts[0][1].task, /continue the draft PR #90/);
  assert.ok(log.gh.some((g) => /pulls\/90\/comments -f body=/.test(g)), 'a review comment was left');
  const c = byName(s);
  assert.ok(c['same PR updated by fast-forward'].ok, JSON.stringify(c['same PR updated by fast-forward']));
  assert.ok(c['no new PR opened'].ok && c['nothing merged'].ok && c['a reply is on the PR'].ok && c['CI green on the new head'].ok, JSON.stringify(s.checks.filter((x) => !x.ok)));
  assert.ok(log.gh.some((g) => g.startsWith('pr close 90')));
});

test('research: done with a report file that exists and cites files; no repo, no PR', async () => {
  const { deps, log } = buildDeps();
  log.result = log.report;
  const s = await R.main('research', {}, {}, deps);
  assert.strictEqual(log.posts[0][1].repo, undefined);
  const c = byName(s);
  assert.ok(c['report file exists'].ok && c['report cites files'].ok && c['no PR opened'].ok, JSON.stringify(s.checks.filter((x) => !x.ok)));
});

test('a run left on a promise nothing settles writes its summary and report at exit, non-zero', async () => {
  const report = path.join(os.tmpdir(), `pa-e2e-report-${process.pid}.json`);
  const { deps } = buildDeps();
  let held = false;
  deps.post = () => { held = true; return new Promise(() => {}); };
  const before = process.listenerCount('beforeExit');
  R.main('build-pr', { report }, {}, deps);
  for (let i = 0; i < 200 && !held; i++) await new Promise((r) => setImmediate(r));
  assert.ok(held, 'the run reached the call that never settles');
  assert.strictEqual(process.listenerCount('beforeExit'), before + 1, 'the guard is armed while the run is out');
  process.emit('beforeExit', 0);
  try {
    assert.strictEqual(process.exitCode, 1);
    const s = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.strictEqual(s.ok, false);
    assert.match(s.errors[0], /stopped in the build-pr runner with nothing left to run/);
    assert.ok(fs.existsSync(path.join(s.folder, 'summary.json')));
  } finally {
    process.exitCode = 0;
    fs.rmSync(report, { force: true });
  }
  await R.main('build-pr', {}, {}, buildDeps().deps);
  assert.strictEqual(process.listenerCount('beforeExit'), before, 'a run that ends disarms it');
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
  if (failed) process.exit(1);
})();
