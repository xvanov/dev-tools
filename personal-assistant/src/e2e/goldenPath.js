'use strict';

// `pa e2e`: the golden path, headless, against the live stack (plan E4).
//
// A dummy card goes Plan → Build → Run → a draft PR on this repo through the
// same code a person's card takes (commitments/request.js, then the chat's
// factory_start tool), every hop is timed off the factory's own status, and
// then each view's HTTP API (Plan's /api/state and card detail, Build's
// /api/factory, Run's termhub /api/sessions), the chat's MCP tools and GitHub
// must all link the same card, run, job, steps, sessions and PR (E1). An
// API-runtime step must have been watchable (E2). Cleanup always runs unless
// --keep: PR closed with its branch, job cancelled if live, card dropped,
// step sessions killed. `--sweep` cleans what an interrupted run left, by the
// `e2e-<uuid>` marker on its card.
//
// The rules (hops, assertions, the report) are pure, in goldenPathCore.js.
// Every outside call goes through `deps`, so tests can swap them.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const C = require('./goldenPathCore');

function defaultDeps() {
  const { config } = require('../config.ts');
  const termhub = require('../dispatch/termhub.ts');
  const factory = require('../dispatch/factory.ts');
  const repo = require('../repo');
  const paBase = `http://${config.dispatch.host === '0.0.0.0' ? '127.0.0.1' : config.dispatch.host}:${config.dispatch.port}`;
  return {
    config,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stderr.write(`e2e ${new Date().toISOString().slice(11, 19)} ${line}\n`),
    uuid: () => crypto.randomUUID(),
    paBase,
    async getJson(url, { timeoutMs = 30_000 } = {}) {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${res.status} on ${url.replace(/\?.*/, '')}: ${text.slice(0, 160)}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    },
    addCard: (text) => require('../commitments/request.ts').add({ text, via: 'cli' }),
    closeCard: (id) => require('../commitments.ts').setStatus(Number(id), 'dropped'),
    chat: (name, args) => require('../mcp/chatTools.ts').handle(name, args),
    factoryEnabled: () => factory.enabled(),
    factoryMachine: () => factory.machine(),
    factoryApps: () => factory.apps({ fresh: true }),
    jobStatus: (id) => factory.call(['job', 'status', id, '--json']),
    // The factory's own cancel: the chat's factory_cancel also drops the PA run
    // that holds the job, which a resumed job still needs for its links.
    stopJob: (id) => factory.call(require('../dispatch/factoryCore.ts').cancelArgv(id)),
    hub: (machine) => termhub.forMachine(machine || null),
    dbProbe: () => repo.system.ping(),
    e2eCards: () => repo.commitments.e2eCards(),
    jobsOfCommitments: (ids) => repo.runs.jobsOfCommitments(ids),
    prLinksOf: (runIds) => repo.runs.prLinksOf(runIds),
    stepSessionsOf: (runIds) => repo.runs.stepSessionsOf(runIds),
    gh: (args, owner) => gh(config.github.bin, args, owner),
    runCommand: (machine, argv, opts) => require('../dispatch/exec.ts').runCommand(machine, argv, opts),
    subscribe,
  };
}

// The dashboard's live feed (plan 0.4, GET /api/events): each event's JSON to
// `onEvent` until the returned function is called. Errors end it quietly; the
// run falls back to its poll interval.
function subscribe(url, onEvent) {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          buf = buf.slice(i + 2);
          if (data) {
            try { onEvent(JSON.parse(data)); } catch { /* not ours to parse */ }
          }
        }
      }
    } catch {
      /* aborted or dropped: polling carries on */
    }
  })();
  return () => ac.abort();
}

// ---------------------------------------------------------------- GitHub ----

function run(bin, args, { env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

// `gh` as the repo owner's account (PLAN.md P1): GH_TOKEN from
// `gh auth token --user <owner>` for this one child, never `gh auth switch`,
// and the token is never printed or returned.
async function gh(bin, args, owner) {
  const t = await run(bin, ['auth', 'token', '--user', owner], { timeoutMs: 20_000 });
  const token = t.code === 0 ? t.stdout.trim() : '';
  if (!token) return { code: 4, stdout: '', stderr: `gh has no login for ${owner} (gh auth login, then gh auth switch back to your default)` };
  return run(bin, args, { env: { ...process.env, GH_TOKEN: token } });
}

// --------------------------------------------------------------- helpers ----

function owner(repo) {
  return String(repo).split('/')[0];
}

async function safely(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function scrollbacks(deps, steps) {
  const out = {};
  for (const s of steps) {
    if (!s.session) continue;
    const r = await safely(() => deps.hub(s.session.machine).screen(s.session.id, { tailChars: 4000 }));
    out[s.session.id] = r.ok ? r.value : '';
  }
  return out;
}

async function sessionLists(deps, steps) {
  const out = {};
  for (const m of new Set(['', ...steps.filter((s) => s.session).map((s) => s.session.machine || '')])) {
    const r = await safely(() => deps.hub(m || null).listSessions());
    out[m] = r.ok ? r.value : [];
  }
  return out;
}

// --------------------------------------------------------------- dry run ----

/** Config and reachability of everything a run touches; creates nothing. */
async function dryRun(o, deps) {
  const checks = [];
  const add = (view, check, ok, detail) => checks.push({ view, check, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });

  const dbr = await safely(() => deps.dbProbe());
  add('config', 'database answers', dbr.ok, dbr.error);

  const enabled = deps.factoryEnabled();
  add('config', 'factory configured (PA_FACTORY_PATH)', enabled, enabled ? null : 'PA_FACTORY_PATH is empty');
  const fm = await safely(() => deps.factoryMachine());
  // D13: each stack runs its own factory; the golden path must not cross stacks.
  add('config', 'factory runs on this machine (D13)', fm.ok && fm.value == null, fm.ok ? (fm.value ? `PA_FACTORY_MACHINE is ${fm.value}, another machine` : null) : fm.error);
  if (enabled) {
    const apps = await safely(() => deps.factoryApps());
    const app = apps.ok ? apps.value.find((a) => String(a.repo || '').toLowerCase() === o.repo.toLowerCase()) : null;
    add('build', `factory answers (app list)`, apps.ok, apps.error);
    if (apps.ok) add('build', `factory app for ${o.repo}`, app, app ? `app ${app.app}` : `no app for ${o.repo}: factory app add --repo ${o.repo}`);
  }

  const health = await safely(() => deps.getJson(`${deps.paBase}/healthz`, { timeoutMs: 5000 }));
  add('plan', 'dashboard /healthz', health.ok && health.value?.ready, health.ok ? `commit ${health.value?.commit || '?'}` : health.error);
  const state = await safely(() => deps.getJson(`${deps.paBase}/api/state`));
  add('plan', 'GET /api/state', state.ok && Array.isArray(state.value?.commitments), state.error || (Array.isArray(state.value?.commitments) ? null : 'no commitments list'));
  const fac = await safely(() => deps.getJson(`${deps.paBase}/api/factory`));
  add('build', 'GET /api/factory', fac.ok && fac.value?.enabled !== false && fac.value?.groups, fac.error || (fac.value?.enabled === false ? 'the factory is not configured' : null));
  if (fac.ok && fac.value?.errorAt && fac.value?.error) add('build', 'factory poll healthy', false, `last poll error: ${fac.value.error}`);
  if (deps.subscribe) {
    // 0.4's live feed: a hello frame arrives on connect.
    const live = await new Promise((resolve) => {
      let close = null;
      const timer = setTimeout(() => { if (close) close(); resolve(false); }, 5000);
      close = deps.subscribe(`${deps.paBase}/api/events`, () => { clearTimeout(timer); close(); resolve(true); });
    });
    add('plan', 'GET /api/events (live feed)', live, live ? null : 'no frame in 5 s; the run will poll only');
  }

  const hubs = new Set(['']);
  if (fm.ok && fm.value) hubs.add(fm.value);
  for (const m of hubs) {
    const r = await safely(() => deps.hub(m || null).listSessions());
    add('run', `termhub /api/sessions${m ? ` on ${m}` : ''}`, r.ok && Array.isArray(r.value), r.error || (Array.isArray(r.value) ? `${r.value.length} sessions` : 'not a list'));
  }

  for (const t of ['factory_start', 'factory_resume', 'factory_cancel', 'card', 'factory_job', 'sessions']) {
    const tools = require('../mcp/chatTools.ts');
    add('mcp', `chat tool ${t}`, [...tools.CHAT_READ_TOOL_NAMES, ...tools.CHAT_ACTION_TOOL_NAMES].includes(t));
  }
  const sessions = await safely(() => deps.chat('sessions', {}));
  add('mcp', 'sessions tool answers', sessions.ok, sessions.error);

  const repo = await deps.gh(['repo', 'view', o.repo, '--json', 'viewerPermission'], owner(o.repo));
  let perm = null;
  try { perm = JSON.parse(repo.stdout).viewerPermission; } catch { /* reported below */ }
  add('github', `gh as ${owner(o.repo)} can write ${o.repo}`, repo.code === 0 && ['WRITE', 'MAINTAIN', 'ADMIN'].includes(perm), repo.code === 0 ? `permission ${perm}` : repo.stderr.trim().slice(0, 200));

  if (o.runtime === 'api' && !o.model) add('config', '--runtime api names a model', true, 'no --model: the factory picks its default route');
  return checks;
}

// --------------------------------------------------------------- the run ----

async function golden(o, deps) {
  const t0 = deps.now();
  const marker = `e2e-${deps.uuid()}`;
  const hops = C.hopsFor(o);
  const card = C.dummyCard(marker);
  let timeline = {};
  const checks = [];
  const errors = [];
  const cleanup = [];
  let ids = null;
  let cardId = null;
  let start = null;
  let startCall = null;
  let lastJob = null;
  const cancelledSessions = new Set();
  // The live feed (0.4) wakes the poll early when a run or the factory board
  // changes; the factory's own status stays the clock for every hop.
  let wake = null;
  let feedEvents = 0;
  const unsubscribe = deps.subscribe
    ? deps.subscribe(`${deps.paBase}/api/events`, (e) => {
      if (e && ['run', 'factory'].includes(e.topic || e.payload?.topic)) {
        feedEvents++;
        if (wake) wake();
      }
    })
    : null;
  const nap = (ms) => Promise.race([deps.sleep(ms), new Promise((r) => { wake = r; })]).finally(() => { wake = null; });

  try {
    // 1. Plan: a card, by the same path as one typed on the board.
    const c = await deps.addCard(card.text);
    cardId = String(c.id);
    timeline = { ...timeline, card: deps.now() };
    deps.log(`card #${cardId} (${marker})`);

    // 2. Build: the chat's own tool, as Jarvis calls it.
    const args = { card: cardId, ask: card.ask, title: card.title, runtime: o.runtime, delivery: o.delivery || 'draft_pr', repo: o.repo };
    if (o.model) args.model = o.model;
    if (o.branch) args.branch = o.branch;
    const called = deps.now();
    start = await deps.chat(o.branch ? 'factory_continue' : 'factory_start', args);
    startCall = { at: called, ms: deps.now() - called };
    if (start?.started !== true || !start.job) throw new Error(`factory_start did not start a job: ${JSON.stringify(start).slice(0, 300)}`);
    deps.log(`run ${start.run} job ${start.job}`);

    // 3. Watch: poll the factory's status, read step scrollback for first output.
    for (;;) {
      const st = await safely(() => deps.jobStatus(start.job));
      if (st.ok) lastJob = st.value;
      const now = deps.now();
      ids = C.chainIds(lastJob, { card: cardId, run: start.run, job: start.job });
      let output = false;
      if (timeline.first_output == null) {
        const sb = await scrollbacks(deps, ids.steps);
        output = Object.values(sb).some(C.nonEmpty);
      }
      const seen = C.observe(timeline, lastJob, { at: now, output });
      timeline = seen.timeline;
      for (const h of seen.reached) deps.log(`hop ${h} (+${Math.round((now - t0) / 1000)} s)`);

      // Stop the run mid-step with the factory's cancel, which `job resume`
      // accepts. Killing the session is not a stop: the factory replaces a lost
      // claude_session within ~30 s by itself, and an API step's session is
      // only a viewer (E2). So wait for a claude_session step to be running.
      const workers = ids.steps.filter((x) => x.session && x.state === 'running' && x.runtime === 'claude_session');
      if (o.resume && timeline.first_output != null && timeline.killed == null && workers.length) {
        const r = await safely(() => deps.stopJob(start.job));
        if (r.ok) {
          for (const s of workers) cancelledSessions.add(s.session.id);
          timeline = { ...timeline, killed: deps.now() };
          deps.log(`cancelled the job mid-step (${workers.map((s) => `${s.persona || 'step'} ${s.step}`).join(', ')}); waiting for it to stop`);
        } else deps.log(`cancel refused, retrying: ${r.error}`);
      }
      if (o.resume && timeline.killed != null && timeline.resumed == null) {
        const stopped = lastJob && (C.TERMINAL.has(lastJob.state) || lastJob.state === 'needs_human' || lastJob.stalled || C.chainIds(lastJob).steps.every((s) => s.state !== 'running'));
        if (stopped) {
          const r = await safely(() => deps.chat('factory_resume', { job: start.job }));
          if (r.ok) {
            timeline = { ...timeline, resumed: deps.now() };
            deps.log(`resumed (${r.value.was} → ${r.value.state})`);
          } else deps.log(`resume refused, retrying: ${r.error}`);
        }
      }

      if (!C.nextHop(hops, timeline)) break;
      const late = C.overdue(hops, timeline, o.timeouts, deps.now(), t0);
      if (late) {
        errors.push(`timed out waiting for ${late.hop} after ${late.waitedS} s (limit ${late.limitS} s)${lastJob ? `; job ${lastJob.state}` : ''}`);
        break;
      }
      // A job that ended with no PR is done for, unless it is the kill the
      // resume variant made, or the status has not caught up with the resume yet.
      const resuming = o.resume && (timeline.resumed == null || deps.now() - timeline.resumed < 60_000);
      if (lastJob && C.deadEnd(lastJob) && !resuming) {
        errors.push(`job ${start.job} ended ${lastJob.state} without a PR${lastJob.why ? `: ${String(lastJob.why).slice(0, 200)}` : ''}`);
        break;
      }
      await nap(o.poll * 1000);
    }

    // 4. Every view's API links the same chain. The worker records it on its
    // factory poll, so give the views until `timeouts.views` to catch up.
    if (ids && ids.job) {
      const until = deps.now() + o.timeouts.views * 1000;
      let viewChecks = [];
      for (;;) {
        viewChecks = await viewChecksFor(o, deps, ids, cancelledSessions);
        if (viewChecks.every((c) => c.ok) || deps.now() > until) break;
        await nap(o.poll * 1000);
      }
      checks.push(...viewChecks);
    }
  } catch (err) {
    errors.push(err.message || String(err));
  } finally {
    if (unsubscribe) unsubscribe();
    // `pa e2e <workflow>` (8.2) collects its evidence here, while the PR,
    // sessions and job still exist.
    if (o.collect) {
      const got = await safely(() => o.collect({ ids, lastJob, start, startCall, cardId, timeline, t0 }));
      if (!got.ok) errors.push(`collecting evidence: ${got.error}`);
    }
    if (o.keep) {
      cleanup.push(`kept (--keep): card #${cardId ?? '-'}, job ${start?.job ?? '-'}, PR ${ids?.prs?.map((p) => `#${p.number}`).join(' ') || '-'}; \`pa e2e --sweep\` removes them`);
    } else {
      cleanup.push(...(await clean(o, deps, { cardId, job: start?.job, ids, lastJob })));
    }
  }
  const report = C.summarize({ marker, stack: o.stack, options: o, hops, timeline, t0, checks, errors, cleanup, ids });
  report.feed = unsubscribe ? `sse (${feedEvents} run/factory events) + ${o.poll} s poll` : `${o.poll} s poll`;
  return report;
}

async function viewChecksFor(o, deps, ids, cancelledSessions = new Set()) {
  const out = [];
  const state = await safely(() => deps.getJson(`${deps.paBase}/api/state`));
  out.push(...(state.ok ? C.checkPlanBoard(state.value, ids) : [{ view: 'plan', check: 'GET /api/state', ok: false, detail: state.error }]));
  const detail = await safely(() => deps.getJson(`${deps.paBase}/api/commitments/${ids.card}`));
  out.push(...(detail.ok ? C.checkCardDetail(detail.value, ids) : [{ view: 'plan-card', check: 'GET /api/commitments/:id', ok: false, detail: detail.error }]));
  const fac = await safely(() => deps.getJson(`${deps.paBase}/api/factory`));
  out.push(...(fac.ok ? C.checkBuild(fac.value, ids) : [{ view: 'build', check: 'GET /api/factory', ok: false, detail: fac.error }]));
  const sb = await scrollbacks(deps, ids.steps);
  out.push(...C.checkRun(await sessionLists(deps, ids.steps), ids, { scrollback: sb, stopped: cancelledSessions }));
  const mcard = await safely(() => deps.chat('card', { id: ids.card }));
  out.push(...(mcard.ok ? C.checkMcpCard(mcard.value, ids) : [{ view: 'mcp', check: 'card tool', ok: false, detail: mcard.error }]));
  const mjob = await safely(() => deps.chat('factory_job', { job: ids.job, fresh: true }));
  out.push(...C.checkMcpJob(mjob.ok ? mjob.value : { error: mjob.error }, ids));
  for (const p of ids.prs) {
    const r = await deps.gh(['pr', 'view', String(p.number), '--repo', o.repo, '--json', 'number,headRefName,isDraft,state'], owner(o.repo));
    let pr = null;
    try { pr = r.code === 0 ? JSON.parse(r.stdout) : { error: r.stderr.trim().slice(0, 200) }; } catch { pr = { error: 'gh answered with something that is not JSON' }; }
    out.push(...C.checkGithub(pr, p, { draft: (o.delivery || 'draft_pr') === 'draft_pr' }));
  }
  if (!ids.prs.length) out.push({ view: 'github', check: 'a PR to check', ok: false, detail: 'the job opened no PR' });
  out.push(...C.checkWatchable(ids, { runtime: o.runtime, scrollback: sb }));
  return out;
}

// --------------------------------------------------------------- cleanup ----

async function clean(o, deps, { cardId, job, ids, lastJob }) {
  const done = [];
  for (const p of ids?.prs || []) {
    const r = await deps.gh(['pr', 'close', String(p.number), '--repo', o.repo, '--delete-branch'], owner(o.repo));
    done.push(r.code === 0 ? `PR #${p.number} closed, branch deleted` : `PR #${p.number} NOT closed: ${r.stderr.trim().slice(0, 160)}`);
  }
  if (job && !(lastJob && C.TERMINAL.has(lastJob.state))) {
    const r = await safely(() => deps.chat('factory_cancel', { job }));
    done.push(r.ok ? `job ${job} cancelled` : `job ${job} NOT cancelled: ${r.error}`);
  }
  for (const s of (ids?.steps || []).filter((x) => x.session)) {
    const r = await safely(() => deps.hub(s.session.machine).killSession(s.session.id));
    if (!r.ok) done.push(`session ${s.session.id} NOT killed: ${r.error}`);
    else if (r.value) done.push(`session ${s.session.id} killed`);
  }
  if (cardId) {
    const r = await safely(() => deps.closeCard(cardId));
    done.push(r.ok ? `card #${cardId} dropped` : `card #${cardId} NOT dropped: ${r.error}`);
  }
  return done;
}

/**
 * `--sweep`: what interrupted runs left, found by the marker on their cards
 * and the ids stored against them (E1: run, run_step, run_pr), never by
 * titles alone.
 */
async function sweep(o, deps) {
  const cleanup = [];
  const errors = [];
  const cards = await deps.e2eCards();
  const ids = cards.map((c) => Number(c.id));
  const runs = ids.length ? await deps.jobsOfCommitments(ids) : [];
  const runIds = runs.map((r) => Number(r.id));
  const prs = runIds.length ? await deps.prLinksOf(runIds).catch(() => []) : [];
  const sessions = runIds.length ? await deps.stepSessionsOf(runIds).catch(() => []) : [];
  for (const p of prs) {
    const n = C.prNumberOf(p.pr_number, p.pr_url);
    if (!n) continue;
    const view = await deps.gh(['pr', 'view', String(n), '--repo', o.repo, '--json', 'state'], owner(o.repo));
    let state = null;
    try { state = JSON.parse(view.stdout).state; } catch { /* closed below or reported */ }
    if (state && state !== 'OPEN') continue;
    const r = await deps.gh(['pr', 'close', String(n), '--repo', o.repo, '--delete-branch'], owner(o.repo));
    cleanup.push(r.code === 0 ? `PR #${n} closed, branch deleted` : `PR #${n} NOT closed: ${r.stderr.trim().slice(0, 160)}`);
  }
  for (const r of runs.filter((x) => x.factory_job_id && !C.TERMINAL.has(x.factory_state))) {
    const c = await safely(() => deps.chat('factory_cancel', { job: r.factory_job_id }));
    cleanup.push(c.ok ? `job ${r.factory_job_id} cancelled` : `job ${r.factory_job_id}: ${c.error}`);
  }
  for (const s of sessions) {
    const k = await safely(() => deps.hub(s.machine).killSession(s.termhub_session_id));
    if (k.ok && k.value) cleanup.push(`session ${s.termhub_session_id} killed`);
  }
  for (const c of cards.filter((x) => ['open', 'dispatched'].includes(x.status))) {
    const r = await safely(() => deps.closeCard(c.id));
    if (r.ok) cleanup.push(`card #${c.id} dropped`);
    else errors.push(`card #${c.id}: ${r.error}`);
  }
  if (!cleanup.length) cleanup.push(`nothing left over (${cards.length} e2e card(s) seen, all closed)`);
  return { ok: !errors.length, kind: 'sweep', marker: null, stack: o.stack, variant: null, hops: [], ids: null, checks: [], failed: [], errors, cleanup };
}

// ---------------------------------------------------------------- remote ----

/**
 * `--on <machine>`: the same command on another stack's machine. A dry run
 * fits termhub's exec (≤ 30 min) and its JSON comes back on stdout; a real run
 * outlives that, so it runs in a termhub session there (watchable) writing
 * `--report <file>`, read back through exec when it appears.
 */
async function remote(o, flags, lists, deps) {
  const m = deps.config.termhub.machines[o.on];
  if (!m) throw new Error(`--on ${o.on}: not in PA_MACHINES`);
  const sep = m.os === 'windows' || /^[A-Za-z]:\\/.test(m.reposRoot) ? '\\' : '/';
  const cwd = o.remotePath || [m.reposRoot.replace(/[\\/]+$/, ''), 'dev-tools', 'personal-assistant'].join(sep);
  const argv = C.remoteArgv(flags, lists);
  if (o.dryRun || o.sweep) {
    const r = await deps.runCommand(o.on, ['node', 'bin/pa.js', ...argv], { cwd, timeoutMs: 10 * 60_000 });
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`pa e2e on ${o.on} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  }
  const file = `e2e-report-${deps.uuid()}.json`;
  const command = ['node', 'bin/pa.js', ...argv, '--report', file].join(' ');
  const s = await deps.hub(o.on).createSession({ cwd, command, title: `pa e2e (${o.stack || o.on})` });
  deps.log(`running on ${o.on} in termhub session ${s.id}`);
  const total = Object.values(o.timeouts).reduce((a, b) => a + b, 0) * 1000 + 15 * 60_000;
  const until = deps.now() + total;
  while (deps.now() < until) {
    await deps.sleep(30_000);
    const r = await deps.runCommand(o.on, ['node', '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], { cwd, timeoutMs: 30_000 }).catch(() => null);
    if (r && r.code === 0 && r.stdout.trim()) {
      await deps.runCommand(o.on, ['node', '-e', `require('fs').unlinkSync(${JSON.stringify(file)})`], { cwd, timeoutMs: 30_000 }).catch(() => null);
      return JSON.parse(r.stdout);
    }
  }
  throw new Error(`no report from ${o.on} after ${Math.round(total / 60000)} min (termhub session ${s.id} is still there to look at)`);
}

// ------------------------------------------------------------------ main ----

/** `pa e2e`. Returns the report; the CLI prints it and sets the exit code. */
async function main(flags = {}, lists = {}, deps = defaultDeps()) {
  const o = C.parseOptions(flags, lists);
  if (o.on) return remote(o, flags, lists, deps);
  if (o.sweep) return sweep(o, deps);
  if (o.dryRun) {
    const t0 = deps.now();
    const checks = await dryRun(o, deps);
    return C.summarize({ stack: o.stack, options: o, hops: [], timeline: {}, t0, checks, dryRun: true });
  }
  return golden(o, deps);
}

/** Writes the report where `--report` says (the remote runner reads it back). */
function writeReport(file, report) {
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + os.EOL);
}

module.exports = { main, dryRun, golden, sweep, remote, clean, viewChecksFor, writeReport, defaultDeps, safely, scrollbacks, sessionLists, owner };
