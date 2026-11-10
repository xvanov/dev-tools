'use strict';

// `pa e2e build-pr | build-continue-pr | research` (D30): the Build flows, for real.
// Each starts one Claude Code agent through POST /api/build/runs (what the chat's
// build_start calls after its approval), waits for the run to end, then checks
// the rubric by itself where it can: draft PR open, CI green, scope, the reply
// on the PR, report file exists, cost under the cap, hop timings. What needs a
// reader (every claim of a research report sourced) stays on the rubric for the
// reviewer. Dummy work only: a one-line docs comment on this repo; the PRs are
// closed and their branches deleted at the end (--keep leaves them).
//
//   build-pr           task: one comment line in keep-awake/README.md, draft PR, run done with its URL
//   build-continue-pr  the runner opens a draft PR with a review comment on it (GitHub API only), the
//                      agent is told to continue that PR: same PR, fast-forward, replied, CI green
//   research           no repo; report file under the run's reports dir, cited
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Deps = Json;
type Options = Json;
type Check = { view: string; check: string; ok: boolean; detail?: string };

const fs = require('fs');
const path = require('path');
const W = require('./workflowsCore.ts');
const G = require('./goldenPath.ts');

const LIVE = new Set(['starting', 'running', 'idle']);
const CI_DONE = new Set(['SUCCESS', 'FAILURE', 'ERROR']);

const check = (view: string, name: string, ok: unknown, detail?: unknown): Check =>
  ({ view, check: name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });

/** Pure. ms from `t0` to the first tool call in a Claude Code transcript (JSON lines), or null. */
function firstActionMs(jsonl: string, t0: number): number | null {
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.includes('tool_use')) continue;
    try {
      const e = JSON.parse(line);
      const t = Date.parse(e.timestamp);
      if (e.type === 'assistant' && Number.isFinite(t)) return Math.max(0, t - t0);
    } catch { /* a torn line */ }
  }
  return null;
}

/** Pure. A PR number from a URL (`.../pull/90`), or null. */
function prNumber(text: unknown): number | null {
  const m = /\/pull\/(\d+)/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

async function gh(deps: Deps, repo: string, args: string[]): Promise<string> {
  const r = await deps.gh(args, G.owner(repo));
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return String(r.stdout);
}

/** The PR as the e2e reads it: PR_QUERY flattened (draft, merged, CI, head); null when not found. */
async function prRead(deps: Deps, repo: string, n: number): Promise<Json | null> {
  const [owner, name] = repo.split('/');
  const r = await deps.gh(['api', 'graphql', '-f', `query=${W.PR_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${n}`], G.owner(repo));
  if (r.code !== 0) return null;
  return W.prFacts(JSON.parse(r.stdout));
}

/** CI to a verdict on the PR's current head: polls until SUCCESS/FAILURE/ERROR or the deadline. */
async function ciOf(deps: Deps, repo: string, n: number, seconds: number): Promise<{ ci: string; head: string | null }> {
  const until = deps.now() + seconds * 1000;
  let last: Json | null = null;
  for (;;) {
    last = await prRead(deps, repo, n);
    if (last?.ci && CI_DONE.has(last.ci)) break;
    if (deps.now() > until) break;
    await deps.sleep(15_000);
  }
  return { ci: last?.ci || 'unknown', head: last?.head || null };
}

/** The PR's files and the lines it changed, for the scope check. */
async function prFiles(deps: Deps, repo: string, n: number): Promise<{ files: string[]; changes: number }> {
  const out = JSON.parse(await gh(deps, repo, ['api', `repos/${repo}/pulls/${n}/files`, '--jq', '[.[] | {f: .filename, c: .changes}]']));
  return { files: out.map((x: Json) => x.f), changes: out.reduce((t: number, x: Json) => t + Number(x.c || 0), 0) };
}

/** What the continue flow starts from: a draft PR with one review comment on its one line (GitHub API only). */
async function seedPr(deps: Deps, repo: string, marker: string): Promise<{ number: number; branch: string; head: string; file: string }> {
  const branch = `e2e-${marker}`;
  const file = `docs/native/acceptance/e2e-probe-${marker}.txt`;
  const base = (await gh(deps, repo, ['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha'])).trim();
  await gh(deps, repo, ['api', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${base}`]);
  const put = JSON.parse(await gh(deps, repo, ['api', '-X', 'PUT', `repos/${repo}/contents/${file}`, '-f', `message=docs: e2e probe ${marker}`,
    '-f', `content=${Buffer.from(`e2e probe ${marker}\n`).toString('base64')}`, '-f', `branch=${branch}`]));
  const head: string = put.commit.sha;
  const pr = JSON.parse(await gh(deps, repo, ['api', `repos/${repo}/pulls`, '-f', `title=e2e ${marker}`, '-f', `head=${branch}`, '-f', 'base=main', '-F', 'draft=true',
    '-f', 'body=Automated e2e probe (pa e2e build-continue-pr). Closed by the run.']));
  await gh(deps, repo, ['api', `repos/${repo}/pulls/${pr.number}/comments`, '-f', 'body=Please add the word "reviewed" to the end of this line.',
    '-f', `commit_id=${head}`, '-f', `path=${file}`, '-F', 'line=1', '-f', 'side=RIGHT']);
  return { number: pr.number, branch, head, file };
}

async function closePr(deps: Deps, repo: string, n: number): Promise<string> {
  try {
    const view = JSON.parse(await gh(deps, repo, ['pr', 'view', String(n), '--repo', repo, '--json', 'state,mergedAt']));
    if (view.mergedAt) return `PR #${n} is MERGED: left alone`;
    if (view.state === 'OPEN') await gh(deps, repo, ['pr', 'close', String(n), '--repo', repo, '--delete-branch']);
    return `PR #${n} closed, branch deleted`;
  } catch (e) {
    return `PR #${n} NOT closed: ${(e as Error).message}`;
  }
}

/** Waits for the run to end; the Build board's own answer is timed on the way (the dashboard hop). */
async function waitRun(deps: Deps, id: number, seconds: number): Promise<{ row: Json; dashboardMs: number | null }> {
  const B = deps.build || require('../build/index.ts');
  const until = deps.now() + seconds * 1000;
  let dashboardMs: number | null = null;
  for (;;) {
    const row: Json = await B.get(id);
    if (row && !LIVE.has(row.state)) return { row, dashboardMs };
    if (deps.now() > until) { await B.stop(id, 'e2e: timed out').catch(() => {}); throw new Error(`run #${id} not done after ${seconds} s (state ${row?.state})`); }
    const t = deps.now();
    const g = await G.safely(() => deps.getJson(`${deps.paBase}/api/build?limit=10`));
    if (g.ok) dashboardMs = deps.now() - t;
    await deps.sleep(5000);
  }
}

function make(id: 'build-pr' | 'build-continue-pr' | 'research') {
  return async function run(acc: Json, o: Options, deps: Deps, folder: string): Promise<Json> {
    const measured: Json = {};
    const checks: Check[] = [];
    const notes: string[] = [];
    const cleanup: string[] = [];
    const transcripts: string[] = [];
    const marker = `e2e-${String(deps.uuid()).slice(0, 8)}`;
    const model = String(o.model || (id === 'research' ? 'sonnet' : 'haiku'));
    const repoPath = id === 'research' ? null : (typeof o.repoPath === 'string' ? o.repoPath : path.resolve(require('../config.ts').config.toolDir, '..'));
    const capUsd = Number(acc.cost?.max_usd || 1);
    let pr: { number: number; branch: string; head: string } | null = null;
    let seeded = false;
    let runId: number | null = null;
    let task: string;
    if (id === 'build-pr') {
      task = `Docs-only, e2e ${marker}: append the one line "<!-- ${marker} -->" at the very end of keep-awake/README.md. Commit it, push your branch, open a DRAFT PR to main titled "e2e ${marker}", then \`pa run done\` with the PR URL. Do not merge.`;
    } else if (id === 'build-continue-pr') {
      pr = await seedPr(deps, o.repo, marker);
      seeded = true;
      task = `e2e ${marker}: continue the draft PR #${pr.number} of ${o.repo} (branch ${pr.branch}). Read its review comment and do what it asks. Check out that branch, push fast-forward to it (never force), open no new PR, reply on the PR, then \`pa run done\` with the PR URL. Do not merge.`;
    } else {
      task = o.question || `Research how termhub's Windows update script (termhub/windows/update.ps1 in the dev-tools repo) handles a dirty working tree, and write it up in under 300 words with file and line citations (e2e ${marker}).`;
    }
    try {
      const t0 = deps.now();
      const body: Json = { task, model, costCapUsd: capUsd, ...(repoPath ? { repo: repoPath } : {}) };
      const start = JSON.parse(await deps.post(`${deps.paBase}/api/build/runs`, body));
      measured.dispatcher = { ms: deps.now() - t0, note: `POST /api/build/runs ${JSON.stringify(start.timings || {})}` };
      runId = Number(start.id);
      checks.push(check('build', 'run started', start.id && start.state === 'running', `run #${start.id} ${start.state}`));
      const { row, dashboardMs } = await waitRun(deps, runId, o.timeouts.research || 1200);
      if (dashboardMs != null) measured.dashboard = { ms: dashboardMs, note: 'GET /api/build while the run was live' };
      measured['build-agent'] = { ms: Date.parse(String(row.ended_at || new Date(deps.now()).toISOString())) - Date.parse(String(row.started_at)), note: `run ${row.state}` };
      checks.push(check('build', 'run ended done', row.state === 'done', `${row.state}${row.error ? `: ${row.error}` : ''}`));
      const cost = Number(row.cost_usd || 0);
      let jsonl = '';
      try { jsonl = fs.readFileSync(row.transcript_path, 'utf8'); } catch { /* no transcript */ }
      const first = firstActionMs(jsonl, t0);
      checks.push(check('build', 'first agent action within 30 s of build_start', first != null && first <= 30_000, first == null ? 'no tool call in the transcript' : `${(first / 1000).toFixed(1)} s`));
      notes.push(`first agent action ${first == null ? 'unknown' : `${(first / 1000).toFixed(1)} s`} after build_start; start timings ${JSON.stringify(start.timings || {})}`);
      if (jsonl) transcripts.push(deps.writeEvidence(folder, `transcripts/run-${runId}.jsonl`, jsonl));
      const result = String(row.result || '');

      if (id === 'research') {
        const file = result.replace(/^.*?([A-Za-z]:[\\/][^\s"'`]+|\/[^\s"'`]+)$/, '$1').trim();
        const exists = Boolean(file) && fs.existsSync(file);
        const md = exists ? fs.readFileSync(file, 'utf8') : '';
        checks.push(check('build', 'report file exists', md.trim().length > 200, exists ? `${file} (${md.length} chars)` : `no file at "${result.slice(0, 120)}"`));
        checks.push(check('build', 'report cites files', /update\.ps1/.test(md) && /:\d+|line \d+|L\d+/i.test(md)));
        if (md) transcripts.push(deps.writeEvidence(folder, 'report.md', md));
        checks.push(check('github', 'no PR opened', !prNumber(result)));
      } else if (id === 'build-pr') {
        const n = prNumber(result);
        checks.push(check('github', 'result is a PR URL', n, result.slice(0, 160)));
        if (n) {
          pr = { number: n, branch: String(row.branch || ''), head: '' };
          const facts = await prRead(deps, o.repo, n);
          checks.push(check('github', 'PR is a draft, open, not merged', facts && facts.draft && facts.state === 'OPEN' && !facts.merged, facts ? `draft ${facts.draft}, ${facts.state}, merged ${facts.merged}` : 'not found'));
          const f = await G.safely(() => prFiles(deps, o.repo, n));
          checks.push(check('github', 'scope: keep-awake/README.md only, a line or two', f.ok && f.value.files.length === 1 && /keep-awake\/README\.md$/.test(f.value.files[0]) && f.value.changes <= 3, f.ok ? `${f.value.files.join(', ')} (${f.value.changes} changes)` : f.error));
          const c = await ciOf(deps, o.repo, n, o.timeouts.ci || 900);
          checks.push(check('github', 'CI green on the PR head', c.ci === 'SUCCESS', `CI ${c.ci}`));
        }
      } else if (pr) {
        const n = pr.number;
        const after = await prRead(deps, o.repo, n);
        const moved = Boolean(after?.head && after.head !== pr.head);
        let status = 'unknown';
        if (moved) {
          const cmp = await G.safely(() => gh(deps, o.repo, ['api', `repos/${o.repo}/compare/${pr?.head}...${after?.head}`, '--jq', '.status']));
          status = cmp.ok ? String(cmp.value).trim() : cmp.error;
        }
        checks.push(check('github', 'same PR updated by fast-forward', moved && status === 'ahead', moved ? `compare ${status}` : 'head did not move'));
        const other = (after?.recent || []).filter((p: Json) => p.number > n && p.branch !== pr?.branch && String(p.branch).includes('jarvis/'));
        checks.push(check('github', 'no new PR opened', other.length === 0, other.map((p: Json) => `#${p.number}`).join(', ')));
        checks.push(check('github', 'nothing merged', after && !after.merged && after.state === 'OPEN', after ? `${after.state}, merged ${after.merged}` : 'not found'));
        const replies = await G.safely(async () => {
          const rc = JSON.parse(await gh(deps, o.repo, ['api', `repos/${o.repo}/pulls/${n}/comments`, '--jq', 'length']));
          const ic = JSON.parse(await gh(deps, o.repo, ['api', `repos/${o.repo}/issues/${n}/comments`, '--jq', 'length']));
          return { rc, ic };
        });
        checks.push(check('github', 'a reply is on the PR', replies.ok && (replies.value.rc > 1 || replies.value.ic > 0), replies.ok ? `review comments ${replies.value.rc}, PR comments ${replies.value.ic}` : replies.error));
        const f = await G.safely(() => prFiles(deps, o.repo, n));
        checks.push(check('github', 'scope: the probe file only', f.ok && f.value.files.length === 1 && f.value.changes <= 4, f.ok ? `${f.value.files.join(', ')} (${f.value.changes} changes)` : f.error));
        const c = await ciOf(deps, o.repo, n, o.timeouts.ci || 900);
        checks.push(check('github', 'CI green on the new head', moved && c.ci === 'SUCCESS', `CI ${c.ci}`));
      }
      checks.push(check('build', `cost under the cap ($${capUsd})`, cost <= capUsd, `$${cost.toFixed(3)} notional`));
      return {
        measured, checks, transcripts, notes, cleanup, usd: cost, pages: [{ name: 'build', url: `${deps.paBase}/factory` }],
        links: { run: runId, url: start.url || null, pr: pr ? `https://github.com/${o.repo}/pull/${pr.number}` : null },
      };
    } finally {
      if (pr && !o.keep) {
        cleanup.push(await closePr(deps, o.repo, pr.number));
        if (seeded) cleanup.push(`seed branch ${pr.branch} removed with the PR`);
      } else if (pr) cleanup.push(`kept (--keep): PR #${pr.number}`);
    }
  };
}

module.exports = { make, firstActionMs, prNumber, RUNNERS: { 'build-pr': make('build-pr'), 'build-continue-pr': make('build-continue-pr'), research: make('research') } };
