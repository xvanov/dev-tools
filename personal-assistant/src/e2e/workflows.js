'use strict';

// `pa e2e <workflow>` (plan 8.2): each workflow in the Map (architecture.json
// `examples`) run against the live stack, with evidence for the reviewer
// sessions (8.3): per-hop timings against the workflow's 8.1 acceptance
// block, every link, transcripts, a screenshot of each view, and cost against
// the effective ceiling (GET /api/workflow-limits). Everything lands in a run
// folder (<PA data dir>/e2e/<stamp>-<workflow>[-dry]/) with summary.json.
//
// Dummy inputs only where a real one would reach other people: teams-ask needs
// a test chat with only you in it, review-fix one of your own PRs. Nothing
// here ever messages anyone.
//
//   whats-on     TTS'd question -> /api/talk/transcribe -> /api/talk/turn -> /api/talk/tts
//   research     a research card -> factory_start {kind: research} -> report.md
//   deepseek-pr  the E4 golden path on the API runtime (Azure DeepSeek by default), delivery pr
//   review-fix   dry run; a real run needs --pr <n> (one of yours with review comments)
//   teams-ask    dry run; a real run needs --test-chat <id> (a chat with only you in it)

const fs = require('fs');
const path = require('path');
const W = require('./workflowsCore');
const C = require('./goldenPathCore');
const G = require('./goldenPath');

const DEFAULT_API_MODEL = 'azure/deepseek-v4-pro';

function deps0() {
  const d = G.defaultDeps();
  const factory = require('../dispatch/factory.ts');
  return {
    ...d,
    arch: () => require('../dashboard/architecture.json'),
    async post(url, body, { raw = false, timeoutMs = 60_000, onChunk = null } = {}) {
      const isBuf = Buffer.isBuffer(body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-PA': '1', 'Content-Type': isBuf ? 'audio/wav' : 'application/json' },
        body: isBuf ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${res.status} on ${url}: ${(await res.text()).slice(0, 160)}`);
      if (onChunk && res.body) {
        const reader = res.body.getReader();
        const parts = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parts.push(Buffer.from(value));
          onChunk(Buffer.from(value));
        }
        return raw ? Buffer.concat(parts) : Buffer.concat(parts).toString('utf8');
      }
      return raw ? Buffer.from(await res.arrayBuffer()) : res.text();
    },
    spendToday: () => require('../budget.ts').status().then((s) => s.today),
    jobReport: (id) => factory.report(id),
    claudeAuth: () => d.runCommand(factory.machine(), ['claude', 'auth', 'status'], { timeoutMs: 30_000 }),
    fastLaneOn: () => Boolean(d.config.fastLane?.enabled),
    hubBase: (machine) => require('../dispatch/termhub.ts').forMachine(machine || null).base,
    capture: (dir, pages) => require('./screens').capture(dir, pages),
    browser: () => require('./screens').browser(),
    write(file, text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    root: () => path.join(d.config.dataDir, 'e2e'),
  };
}

function check(view, name, ok, detail) {
  return { view, check: name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
}

// ---------------------------------------------------------- dry checks ----

async function commonDry(id, acc, deps) {
  const out = [];
  out.push(check('map', `acceptance block for ${id}`, acc && Array.isArray(acc.hops), `${acc.hops.length} hops, ${acc.rubric?.length || 0} rubric items`));
  const lim = await G.safely(() => deps.getJson(`${deps.paBase}/api/workflow-limits`));
  out.push(check('map', 'GET /api/workflow-limits', lim.ok && lim.value?.limits?.[id], lim.ok ? `effective $${lim.value?.limits?.[id]?.effective}` : lim.error));
  return { checks: out, limits: lim.ok ? lim.value : null };
}

async function factoryDry(deps, repo) {
  const out = [];
  out.push(check('config', 'factory configured', deps.factoryEnabled()));
  const fm = await G.safely(() => deps.factoryMachine());
  out.push(check('config', 'factory on this machine (D13)', fm.ok && fm.value == null, fm.ok ? (fm.value ? `on ${fm.value}` : null) : fm.error));
  const apps = await G.safely(() => deps.factoryApps());
  const app = apps.ok ? apps.value.find((a) => String(a.repo || '').toLowerCase() === repo.toLowerCase()) : null;
  out.push(check('build', `factory app for ${repo}`, app, apps.ok ? (app ? `app ${app.app}` : 'not registered') : apps.error));
  const fac = await G.safely(() => deps.getJson(`${deps.paBase}/api/factory`));
  out.push(check('build', 'GET /api/factory', fac.ok && fac.value?.groups, fac.error));
  return out;
}

async function claudeDry(deps) {
  const r = await G.safely(() => deps.claudeAuth());
  const ok = r.ok && r.value.code === 0 && /claude\.ai|subscription|"loggedIn":\s*true/i.test(r.value.stdout + r.value.stderr);
  return check('run', 'claude logged in on the factory machine (subscription)', ok, r.ok ? (r.value.stdout || r.value.stderr).trim().split('\n')[0] : r.error);
}

async function dry(id, acc, o, deps) {
  const { checks, limits } = await commonDry(id, acc, deps);
  const notes = [];
  if (id === 'whats-on') {
    const v = await G.safely(() => deps.getJson(`${deps.paBase}/api/talk/voice`));
    checks.push(check('ask', 'voice service (GET /api/talk/voice)', v.ok && v.value?.tts?.ok, v.ok ? (v.value?.tts?.ok ? `TTS on ${v.value.tts.device}` : v.value?.tts?.error || 'down') : v.error));
    checks.push(check('ask', 'fast lane on (PA_FAST_LANE)', deps.fastLaneOn()));
  } else if (id === 'research' || id === 'review-fix') {
    checks.push(...(await factoryDry(deps, o.repo)));
    checks.push(await claudeDry(deps));
    const tools = require('../mcp/chatTools.ts');
    const tool = id === 'research' ? 'factory_start' : 'factory_continue';
    checks.push(check('ask', `chat tool ${tool}`, tools.CHAT_ACTION_TOOL_NAMES.includes(tool)));
    if (id === 'review-fix') notes.push('a real run needs --pr <n>: one of your own PRs with review comments (left open; only the fix is pushed)');
  } else if (id === 'deepseek-pr') {
    const base = await G.dryRun({ ...o, runtime: 'api', model: o.model }, deps);
    checks.push(...base);
    const m = await G.safely(() => require('../mcp/chatTools.ts').modelOverrides({ runtime: 'api', kind: 'code', model: o.model }));
    checks.push(check('build', `model ${o.model} accepted for the dev step`, m.ok, m.ok ? m.value.join(' ') : m.error));
  } else if (id === 'teams-ask') {
    const st = await G.safely(() => deps.getJson(`${deps.paBase}/api/state`));
    const sources = st.ok ? (st.value?.sources || []) : [];
    const teams = sources.filter((s) => /teams|graph_chat/i.test(JSON.stringify([s.source, s.name, s.id])));
    checks.push(check('run', 'a Teams source is ingesting', teams.length && teams.some((s) => !s.error && !s.failing), st.ok ? `${teams.length} Teams source(s)` : st.error));
    checks.push(check('run', 'board answers (GET /api/state)', st.ok && Array.isArray(st.value?.commitments), st.error));
    notes.push('a real run needs --test-chat <id>: a Teams chat with only you in it. Never a colleague; nothing is sent to anyone.');
  }
  const b = deps.browser();
  notes.push(b ? `screenshots by ${path.basename(b)}` : 'screenshots will be skipped: no headless Chromium found');
  return { checks, limits, notes };
}

// --------------------------------------------------------------- runs ----

async function whatsOn(acc, o, deps, folder) {
  const measured = {};
  const transcripts = [];
  const checks = [];
  const notes = ['talk-page hop (VAD + smart-turn in the browser) is not measurable headless: the run starts at the transcription request'];
  const spentBefore = await G.safely(() => deps.spendToday());
  const question = o.question || "What's on today?";
  const pcm = await deps.post(`${deps.paBase}/api/talk/tts`, { text: question }, { raw: true, timeoutMs: 30_000 });
  const audio = W.wav(pcm, 24000);

  // End of speech = now: transcription, the fast lane's first words, first audio.
  const t0 = deps.now();
  const tr = JSON.parse(await deps.post(`${deps.paBase}/api/talk/transcribe`, audio, { timeoutMs: 30_000 }));
  const tTranscribed = deps.now();
  const heard = String(tr.text || '').trim();
  measured.whisper = heard
    ? { ms: tr.ms ?? tTranscribed - t0, note: `request ${tTranscribed - t0} ms, whisper ${tr.ms} ms` }
    : { ms: null, note: `transcription came back empty in ${tTranscribed - t0} ms` };
  if (!heard) notes.push('transcription was empty: the rest of the turn was timed with the question text itself, so the hops after it are a lower bound');
  let firstDelta = null;
  let buf = '';
  const turnText = await deps.post(`${deps.paBase}/api/talk/turn`, { text: heard || question }, {
    timeoutMs: 60_000,
    onChunk: (c) => {
      buf += c.toString('utf8');
      if (firstDelta == null && /"type":"delta"/.test(buf)) firstDelta = deps.now();
    },
  });
  const events = W.ndjson(turnText);
  const decision = events.find((e) => e.type === 'decision') || {};
  const done = events.find((e) => e.type === 'done') || {};
  const said = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const first = (said.match(/^[^.!?]+[.!?]?/) || [said])[0].trim();
  if (firstDelta != null) measured['fast-lane'] = { ms: firstDelta - tTranscribed, note: `route ${decision.route || done.route || '?'}` };
  else measured['fast-lane'] = { ms: null, note: `no spoken answer (route ${decision.route || '?'})` };
  let tFirstAudio = null;
  if (first) {
    const tSpeak = deps.now();
    await deps.post(`${deps.paBase}/api/talk/tts`, { text: first }, { raw: true, timeoutMs: 30_000, onChunk: () => { if (tFirstAudio == null) tFirstAudio = deps.now(); } });
    if (tFirstAudio != null) measured.voice = { ms: tFirstAudio - t0, note: `whole path; TTS first byte ${tFirstAudio - tSpeak} ms` };
  }
  checks.push(check('ask', 'transcribed the question', /what/i.test(heard), heard || 'empty transcription'));
  checks.push(check('ask', 'answered locally (route answer)', (decision.route || done.route) === 'answer', `route ${decision.route || done.route || 'none'}`));
  checks.push(check('ask', 'spoke an answer', said.trim().length > 0));
  transcripts.push(deps.writeEvidence(folder, 'transcripts/turn.txt', [`question (TTS): ${question}`, `transcribed: ${tr.text}`, `route: ${decision.route || done.route}`, `answer: ${said}`].join('\n')));
  transcripts.push(deps.writeEvidence(folder, 'transcripts/turn.ndjson', turnText));
  const spentAfter = await G.safely(() => deps.spendToday());
  const usd = spentBefore.ok && spentAfter.ok ? Math.max(0, spentAfter.value - spentBefore.value) : null;
  notes.push('cost is the PA spend delta over the turn; another pass spending at the same moment would show here too');
  return { measured, transcripts, checks, notes, usd, links: { ask: `${deps.paBase}/talk` }, pages: [{ name: 'ask', url: `${deps.paBase}/talk` }] };
}

async function research(acc, o, deps, folder) {
  const measured = {};
  const checks = [];
  const transcripts = [];
  const notes = [];
  const cleanup = [];
  const marker = `e2e-${deps.uuid()}`;
  const ask = o.question || `Research how termhub's Windows update script (termhub/windows/update.ps1 in ${o.repo}) handles a dirty working tree, and write it up in under 300 words with file and line citations. (automated e2e run ${marker}; no PR)`;
  const card = await deps.addCard(`Research: how termhub's update handles a dirty tree (${marker})`);
  const cardId = String(card.id);
  let job = null;
  let lastJob = null;
  let runId = null;
  try {
    const t0 = deps.now();
    const start = await deps.chat('factory_start', { card: cardId, kind: 'research', ask, runtime: 'claude_session', repo: o.repo });
    const tStarted = deps.now();
    measured.jarvis = { ms: tStarted - t0, note: 'factory_start round trip (tool call, no composing model for research)' };
    if (start?.started !== true || !start.job) throw new Error(`factory_start did not start a job: ${JSON.stringify(start).slice(0, 300)}`);
    job = start.job;
    runId = start.run;
    let tRunning = null;
    const until = deps.now() + (o.timeouts.research || 5400) * 1000;
    for (;;) {
      const st = await G.safely(() => deps.jobStatus(job));
      if (st.ok) lastJob = st.value;
      if (tRunning == null && lastJob && lastJob.state !== 'queued') tRunning = deps.now();
      if (lastJob && C.TERMINAL.has(lastJob.state)) break;
      if (deps.now() > until) throw new Error(`research job ${job} not done after ${o.timeouts.research || 5400} s (state ${lastJob?.state})`);
      await deps.sleep(o.poll * 1000);
    }
    const tDone = deps.now();
    measured.dispatcher = tRunning != null ? { ms: tRunning - tStarted, note: 'factory_start return to the job leaving queued' } : { ms: null, note: 'never left queued' };
    measured['runtime-claude'] = { ms: tDone - (tRunning || tStarted), note: `job ${lastJob.state}` };
    checks.push(check('build', 'research job done', lastJob.state === 'done', `${job} ${lastJob.state}${lastJob.why ? `: ${lastJob.why}` : ''}`));
    checks.push(check('build', 'no PR opened', !(lastJob.stories || []).some((s) => s.pr_url)));
    const rep = await G.safely(() => deps.jobReport(job));
    const md = rep.ok ? rep.value?.markdown || '' : '';
    checks.push(check('build', 'report.md delivered', md.trim().length > 200, rep.ok ? `${md.length} chars` : rep.error));
    if (md) transcripts.push(deps.writeEvidence(folder, 'report.md', md));
    checks.push(check('build', 'report cites files', /update\.ps1/.test(md) && /:\d+|line \d+|L\d+/i.test(md)));
    const ids = C.chainIds(lastJob, { card: cardId, run: runId, job });
    const sb = await G.scrollbacks(deps, ids.steps);
    for (const [sid, text] of Object.entries(sb)) transcripts.push(deps.writeEvidence(folder, `transcripts/session-${sid}.txt`, C.stripAnsi(text)));
    const st = await G.safely(() => deps.getJson(`${deps.paBase}/api/commitments/${cardId}`));
    const chain = st.ok ? (st.value?.chain || []).find((c) => Number(c.run) === Number(runId)) : null;
    checks.push(check('plan', 'card → run → job', chain && chain.job === job, chain ? `job ${chain.job}` : st.error || 'no chain entry'));
    checks.push(...C.checkRun(await G.sessionLists(deps, ids.steps), ids, { scrollback: sb }).map((c) => ({ ...c, view: 'run' })));
    const mj = await G.safely(() => deps.chat('factory_job', { job, fresh: true }));
    checks.push(check('ask', 'factory_job tool → card and report', mj.ok && String(mj.value.card) === cardId && mj.value.report, mj.ok ? null : mj.error));
    const cost = Number(lastJob.cost_usd || 0);
    const steps = ids.steps.filter((s) => s.session);
    return {
      measured, checks, transcripts, notes, cleanup, usd: cost,
      links: { card: cardId, run: runId, job, sessions: steps.map((s) => s.session.id), report: `${deps.paBase}/api/factory/report?job=${encodeURIComponent(job)}` },
      pages: [
        { name: 'plan', url: `${deps.paBase}/` },
        { name: 'build', url: `${deps.paBase}/factory` },
        ...steps.slice(0, 2).map((s) => ({ name: `run-${s.session.id}`, url: `${deps.hubBase(s.session.machine)}/#session=${encodeURIComponent(s.session.id)}` })),
      ],
    };
  } finally {
    if (job && !(lastJob && C.TERMINAL.has(lastJob.state))) {
      const r = await G.safely(() => deps.chat('factory_cancel', { job }));
      cleanup.push(r.ok ? `job ${job} cancelled` : `job ${job} NOT cancelled: ${r.error}`);
    }
    if (!o.keep) {
      const r = await G.safely(() => deps.closeCard(cardId));
      cleanup.push(r.ok ? `card #${cardId} dropped` : `card #${cardId} NOT dropped: ${r.error}`);
    } else cleanup.push(`kept (--keep): card #${cardId}`);
  }
}

async function deepseekPr(acc, o, deps, folder) {
  let collected = { transcripts: [], links: {}, pages: [], usd: null, measured: {} };
  const go = {
    ...o,
    runtime: 'api',
    delivery: 'pr',
    collect: async ({ ids, lastJob, startCall, timeline }) => {
      const transcripts = [];
      const sb = await G.scrollbacks(deps, ids?.steps || []);
      for (const [sid, text] of Object.entries(sb)) transcripts.push(deps.writeEvidence(folder, `transcripts/session-${sid}.txt`, C.stripAnsi(text)));
      const measured = {};
      if (startCall) measured.jarvis = { ms: startCall.ms, note: 'factory_start round trip, including the brief composing model' };
      if (startCall && timeline.job_started != null) measured.dispatcher = { ms: timeline.job_started - (startCall.at + startCall.ms), note: 'factory_start return to job started' };
      if (timeline.pr_opened != null && timeline.job_started != null) measured['factory-chain'] = { ms: timeline.pr_opened - timeline.job_started };
      if (timeline.ci_done != null && timeline.pr_opened != null) measured.github = { ms: timeline.ci_done - timeline.pr_opened, note: `CI ${(ids.prs[0] || {}).ci || '?'}` };
      measured.worker = { ms: null, note: 'state change to board redraw: measured by E3/0.4, not by this run' };
      const steps = (ids?.steps || []).filter((s) => s.session);
      collected = {
        transcripts,
        measured,
        usd: lastJob?.cost_usd != null ? Number(lastJob.cost_usd) : null,
        links: { card: ids?.card, run: ids?.run, job: ids?.job, steps: (ids?.steps || []).map((s) => ({ step: s.step, runtime: s.runtime, session: s.session?.id || null })), prs: (ids?.prs || []).map((p) => p.url) },
        pages: [
          { name: 'plan', url: `${deps.paBase}/` },
          { name: 'build', url: `${deps.paBase}/factory` },
          ...steps.slice(0, 2).map((s) => ({ name: `run-${s.session.id}`, url: `${deps.hubBase(s.session.machine)}/#session=${encodeURIComponent(s.session.id)}` })),
          ...(ids?.prs || []).slice(0, 1).map((p) => ({ name: 'github-pr', url: p.url })),
        ],
      };
      // Screenshots now, while the PR and sessions still exist.
      collected.shots = await deps.capture(path.join(folder, 'screenshots'), collected.pages);
    },
  };
  const report = await G.golden(go, deps);
  return {
    measured: collected.measured,
    checks: report.checks,
    transcripts: collected.transcripts,
    links: collected.links,
    usd: collected.usd,
    shots: collected.shots,
    pages: [],
    errors: report.errors,
    cleanup: report.cleanup,
    notes: [`golden-path hops: ${report.hops.map((h) => `${h.hop} ${h.reached ? `+${h.sinceStartS}s` : 'NOT REACHED'}`).join(', ')}`, `dev model ${o.model}`],
    golden: report,
  };
}

const RUNNERS = { 'whats-on': whatsOn, research, 'deepseek-pr': deepseekPr };

// ---------------------------------------------------------------- main ----

function parse(id, flags, lists) {
  const o = C.parseOptions({ ...flags, ...(id === 'deepseek-pr' ? { runtime: 'api', model: flags.model || DEFAULT_API_MODEL } : {}) }, lists);
  if (id === 'deepseek-pr' && !o.model) o.model = DEFAULT_API_MODEL;
  o.question = typeof flags.question === 'string' ? flags.question : null;
  o.pr = flags.pr != null && flags.pr !== true ? Number(flags.pr) : null;
  o.testChat = typeof flags['test-chat'] === 'string' ? flags['test-chat'] : null;
  return o;
}

/** `pa e2e <workflow>`: dry run or real run, evidence in a run folder. Returns the summary. */
async function main(id, flags = {}, lists = {}, deps = deps0()) {
  // research=<s> is this module's own timeout; the golden path's parser does not know it.
  const golden = { ...lists, timeout: (lists.timeout || []).filter((t) => !/^research=/.test(t)) };
  const acc = W.acceptance(deps.arch(), id);
  const o = parse(id, flags, golden);
  o.timeouts.research = Number(String((lists.timeout || []).find((t) => /^research=/.test(t)) || '').split('=')[1]) || 5400;
  const startedAt = new Date(deps.now()).toISOString();
  const folder = path.join(deps.root(), W.folderName(id, deps.now(), o.dryRun));
  deps.writeEvidence = (dir, rel, text) => {
    const file = path.join(dir, rel);
    deps.write(file, text);
    return path.relative(dir, file).replace(/\\/g, '/');
  };

  if (o.dryRun) {
    const d = await dry(id, acc, o, deps);
    const s = W.summary({ workflow: id, kind: 'dry-run', folder, startedAt, hops: W.scoreHops(acc.hops, {}), cost: W.scoreCost(null, d.limits, id, acc.cost?.basis), checks: d.checks, rubric: acc.rubric, notes: d.notes });
    s.hops = [];
    deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
    return s;
  }

  const runner = RUNNERS[id];
  if (!runner) {
    const need = W.REAL_RUN[id]?.needs || 'a dummy input';
    const s = W.summary({ workflow: id, kind: 'run', folder, startedAt, errors: [`a real ${id} run is not automated yet: it needs ${need}. Run --dry-run; 8.3's reviewer drives it by hand with that dummy input.`] });
    deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
    return s;
  }

  const limits = await G.safely(() => deps.getJson(`${deps.paBase}/api/workflow-limits`));
  let r = { measured: {}, checks: [], transcripts: [], links: {}, notes: [], cleanup: [], errors: [], usd: null, pages: [] };
  try {
    r = { ...r, ...(await runner(acc, o, deps, folder)) };
  } catch (err) {
    r.errors = [...(r.errors || []), err.message || String(err)];
  }
  let shots = r.shots || { shots: [], note: null };
  if (r.pages.length) shots = await deps.capture(path.join(folder, 'screenshots'), r.pages);
  const notes = [...(r.notes || []), ...(shots.note ? [shots.note] : [])];
  const s = W.summary({
    workflow: id, kind: 'run', folder, startedAt,
    hops: W.scoreHops(acc.hops, r.measured),
    cost: W.scoreCost(r.usd, limits.ok ? limits.value : null, id, acc.cost?.basis),
    links: r.links, views: Object.fromEntries((shots.shots || []).map((x) => [x.view, { url: x.url, screenshot: x.file ? path.relative(folder, x.file).replace(/\\/g, '/') : null, ...(x.error ? { error: x.error } : {}) }])),
    transcripts: r.transcripts, screenshots: (shots.shots || []).filter((x) => x.file).map((x) => path.relative(folder, x.file).replace(/\\/g, '/')),
    checks: r.checks, rubric: acc.rubric, errors: r.errors || [], cleanup: r.cleanup || [], notes,
  });
  if (r.golden) s.golden = { hops: r.golden.hops, ids: r.golden.ids, feed: r.golden.feed };
  deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
  return s;
}

module.exports = { main, dry, parse, RUNNERS, DEFAULT_API_MODEL, deps0 };
