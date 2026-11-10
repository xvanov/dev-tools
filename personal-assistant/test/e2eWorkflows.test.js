'use strict';

// `pa e2e <workflow>` (plan 8.2): the pure scoring (src/e2e/workflowsCore.ts)
// and the runners (src/e2e/workflows.ts) with fakes for the dashboard, the
// voice path, the factory and termhub. No network, no database, no browser.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../src/e2e/workflowsCore.ts');
const R = require('../src/e2e/workflows.ts');
// D30: the live Map's examples are Build's; the pa e2e runners here still drive the frozen
// factory, so these tests run against the factory-era acceptance blocks kept as a fixture.
const LIVE = require('../src/dashboard/architecture.json');
const ARCH = { ...LIVE, examples: [...LIVE.examples.filter((e) => ['whats-on', 'teams-ask', 'phone'].includes(e.id)), ...require('./fixtures/factoryExamples.json')] };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the Map lists the five in-scope workflows; phone is out of scope', () => {
  assert.deepStrictEqual(W.workflows(ARCH).sort(), ['deepseek-pr', 'research', 'review-fix', 'teams-ask', 'whats-on']);
  assert.throws(() => W.acceptance(ARCH, 'phone'), /out of scope/);
  assert.throws(() => W.acceptance(ARCH, 'nope'), /no workflow/);
  const a = W.acceptance(ARCH, 'whats-on');
  assert.ok(a.hops.length && a.rubric.length && a.cost);
});

test('scoreHops: bounded hops pass or fail on max_ms; unbounded never fail; unmeasured say why', () => {
  const hops = [{ c: 'a', what: 'x', max_ms: 100 }, { c: 'b', what: 'y', unbounded: 'model' }, { c: 'c', what: 'z', max_ms: 50 }, { c: 'a', what: 'again', max_ms: 10 }];
  const s = W.scoreHops(hops, { a: 90, b: { ms: 5000, note: 'n' }, 'a:2': 11 });
  assert.deepStrictEqual(s.map((h) => [h.c, h.ms, h.ok]), [['a', 90, true], ['b', 5000, true], ['c', null, null], ['a', 11, false]]);
  assert.strictEqual(s[2].note, 'not measured');
});

test('workerHop: factory transition to the run, and a terminal state to the Plan card (8.4.10)', () => {
  const job = 'dev-tools:r1';
  const base = '2026-11-08T23:35:00.000Z';
  const at = (ms) => new Date(Date.parse(base) + ms).toISOString();
  const run = (state, ms) => ({ topic: 'run', at: at(ms), payload: { table: 'run', id: 7, factory_job_id: job, factory_state: state } });
  const card = (ms) => ({ topic: 'board', at: at(ms), payload: { table: 'commitment', op: 'update', id: 90, status: 'done' } });
  const push = (state, ms) => ({ topic: 'factory', at: at(ms + 5000), payload: { table: 'push', op: 'push', jobs: [{ job_id: job, state, updated_at: at(ms) }] } });

  const mid = W.workerHop({ job, card: 90, run: 7, frames: [push('in_progress', 0), run('in_progress', 180)], statuses: [{ state: 'in_progress', updated_at: at(9000) }] });
  assert.strictEqual(mid.ms, 180);
  assert.match(mid.note, /in_progress non-terminal 180 ms via run \(push\)/);

  const done = W.workerHop({
    job, card: 90, run: 7,
    statuses: [{ state: 'in_progress', updated_at: at(0) }, { state: 'done', updated_at: at(1000) }],
    frames: [
      { topic: 'factory', at: at(1000), payload: { table: 'push', op: 'push', jobs: [job, 'other:1'], updated_at: at(1000) } },
      run('in_progress', 120), run('done', 1017), card(1400),
    ],
  });
  assert.strictEqual(done.ms, 400, 'the terminal hop is the Plan card, and a shared push stamp is not the clock');
  assert.match(done.note, /in_progress non-terminal 120 ms via run \(job status\)/);
  assert.match(done.note, /done terminal 400 ms via plan card \(job status\)/);

  const missing = W.workerHop({ job, card: 90, run: 7, statuses: [{ state: 'done', updated_at: at(0) }], frames: [run('done', 17)] });
  assert.strictEqual(missing.ms, null, 'a fast run row does not pass while the Plan card was not seen');
  assert.match(missing.note, /done terminal plan card not seen, run row 17 ms \(job status\)/);

  const other = W.workerHop({ job, card: 90, run: 7, frames: [push('done', 0)], statuses: [] });
  assert.strictEqual(other.ms, null);
  assert.match(other.note, /plan card not seen/);
  assert.deepStrictEqual(W.workerHop({ job, frames: [], statuses: [] }), { ms: null, note: 'no factory transition seen' });
});

test('askView: Ask is the tool and an excerpt of its answer (8.4.47)', () => {
  assert.deepStrictEqual(W.askView('chat', 'You have standup at ten. '), { method: 'tool', tool: 'chat', excerpt: 'You have standup at ten.' });
  const job = W.askView('factory_job', { card: '90', report: { title: 'r' } });
  assert.strictEqual(job.tool, 'factory_job');
  assert.match(job.excerpt, /"card":"90"/);
  assert.strictEqual(W.askView('factory_continue', 'x'.repeat(500)).excerpt.length, 240);
  assert.deepStrictEqual(W.askView('chat', null), { method: 'tool', tool: 'chat', excerpt: '' });
});

test('toolCallMs: the jarvis hop excludes the composing model (8.4.22)', () => {
  const t = W.toolCallMs({ at: 0, ms: 6701 }, { started: true, timings_ms: { route: 40, compose_model: 2954, submit: 1000 } });
  assert.strictEqual(t.ms, 3747);
  assert.match(t.note, /less the composing model's 2954 ms/);
  const old = W.toolCallMs({ at: 0, ms: 6701 }, { started: true });
  assert.deepStrictEqual([old.ms, /including the brief composing model/.test(old.note)], [6701, true], 'a PA without timings_ms is timed whole and says so');
  assert.strictEqual(W.toolCallMs(null, null).ms, null);
});

test('deepseek-pr: the Map names the model the e2e runs (8.4.22)', () => {
  const ex = ARCH.examples.find((e) => e.id === 'deepseek-pr');
  const text = JSON.stringify(ex);
  assert.ok(!/deepseek\/deepseek-coder/.test(text), 'no direct-route model in the example');
  assert.match(text, /azure\/deepseek-v4-pro/);
  assert.match(ex.acceptance.cost.basis, /azure\/deepseek-v4-pro/);
});

test('scoreCost uses the effective ceiling', () => {
  const limits = { limits: { 'deepseek-pr': { default: 2, override: 0.5, effective: 0.5, custom: true } } };
  assert.deepStrictEqual(W.scoreCost(0.7, limits, 'deepseek-pr', 'b'), { usd: 0.7, max_usd: 0.5, custom: true, basis: 'b', ok: false });
  assert.strictEqual(W.scoreCost(0, { limits: { 'whats-on': { effective: 0 } } }, 'whats-on').ok, true);
  assert.strictEqual(W.scoreCost(null, null, 'x').ok, null);
});

test('summary fails on a failed check, an over-time hop or cost, and keeps the rubric for the reviewer', () => {
  const s = W.summary({ workflow: 'w', kind: 'run', hops: [{ c: 'a', what: 'x', ms: 200, max_ms: 100, ok: false }], cost: { usd: 1, max_usd: 2, ok: true }, rubric: [{ id: 'r', check: 'c' }] });
  assert.strictEqual(s.ok, false);
  assert.ok(/hop a/.test(s.failed[0]));
  assert.deepStrictEqual(s.rubric, [{ id: 'r', check: 'c', result: null }]);
  assert.ok(/FAILED/.test(W.table(s)));
  assert.strictEqual(W.folderName('research', '2026-11-08T09:01:02.345Z', true), '20261108T090102Z-research-dry');
});

test('wav wraps PCM with a valid header; ndjson skips bad lines', () => {
  const w = W.wav(Buffer.alloc(480), 24000);
  assert.strictEqual(w.length, 524);
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.readUInt32LE(24), 24000);
  assert.deepStrictEqual(W.ndjson('{"a":1}\nnot json\n\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
});

function fakeDeps(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-wf-'));
  let clock = 1_000_000;
  const log = { chat: [], closed: [], posts: [], shots: [], killed: [], audit: [], pages: [] };
  const deps = {
    config: { termhub: { machines: {} } },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {},
    uuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    paBase: 'http://pa',
    arch: () => ARCH,
    root: () => dir,
    write: (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); },
    browser: () => null,
    capture: async (d, pages) => { log.shots.push(...pages.map((p) => p.name)); return { shots: pages.map((p) => ({ view: p.name, url: p.url, file: path.join(d, `${p.name}.png`) })), note: null }; },
    hubBase: () => 'http://hub',
    pageStatus: async (url) => { log.pages.push(url); return 200; },
    async getJson(url) {
      if (url.endsWith('/api/workflow-limits')) return { limits: Object.fromEntries(W.workflows(ARCH).map((id) => [id, { effective: id === 'deepseek-pr' ? 2 : 0, custom: false }])) };
      if (url.endsWith('/api/talk/voice')) return { tts: { ok: true, device: 'cuda' } };
      if (url.endsWith('/api/factory')) return { enabled: true, groups: {} };
      if (url.endsWith('/api/commitments/90')) return { id: 90, chain: [{ run: 7, job: 'dev-tools:r001' }] };
      if (url.endsWith('/api/state')) return { commitments: [], sources: [{ source: 'teams_cache', error: null }] };
      if (url.endsWith('/healthz')) return { ready: true };
      throw new Error(`unexpected ${url}`);
    },
    async post(url, body, { onChunk } = {}) {
      log.posts.push(url);
      clock += 40;
      if (url.endsWith('/api/talk/tts')) { if (onChunk) onChunk(Buffer.alloc(10)); return Buffer.alloc(4800); }
      if (url.endsWith('/api/talk/transcribe')) return JSON.stringify({ text: "What's on today?", ms: 120 });
      if (url.endsWith('/api/talk/warm')) return '{"ok":true}';
      if (url.endsWith('/api/talk/endpoint')) return JSON.stringify({ complete: true, probability: 0.93, ms: 60 });
      if (url.endsWith('/api/talk/turn')) {
        const t = '{"type":"decision","route":"answer"}\n{"type":"delta","text":"You have standup at ten. "}\n{"type":"done","route":"answer"}\n';
        if (onChunk) onChunk(Buffer.from(t));
        return t;
      }
      throw new Error(`unexpected post ${url}`);
    },
    spendToday: async () => 1.25,
    fastLaneOn: () => true,
    addCard: async () => ({ id: 90 }),
    closeCard: async (id) => { log.closed.push(String(id)); },
    async chat(name, args) {
      log.chat.push([name, args]);
      if (name === 'factory_start') return { started: true, run: 7, job: 'dev-tools:r001' };
      if (name === 'factory_job') return { card: '90', report: { title: 'r' } };
      if (name === 'factory_cancel') return {};
      throw new Error(name);
    },
    jobStatus: async () => ({ job_id: 'dev-tools:r001', state: clock > 1_030_000 ? 'done' : 'in_progress', cost_usd: 0, stories: [], runs: [{ id: 3, runtime: 'claude_session', state: 'ok', session: { termhub_session_id: 'rs1', url: 'http://hub:7000/#session=rs1', links: { job: 'dev-tools:r001', step: '3' } } }] }),
    jobReport: async () => ({ markdown: `# Dirty tree\n\n${'termhub/windows/update.ps1:42 refuses a dirty tree. '.repeat(10)}` }),
    hub: () => ({ screen: async () => 'reading update.ps1', listSessions: async () => [{ id: 'rs1', alive: false, links: { job: 'dev-tools:r001', step: '3' } }], killSession: async (id) => { log.killed.push(id); return true; } }),
    jobsOfCommitments: async () => [{ id: 7, commitment_id: 90, factory_job_id: 'dev-tools:r001', factory_state: 'done', termhub_session_id: 'follow7', machine: null }],
    stepSessionsOf: async () => [{ run_id: 7, termhub_session_id: 'rs1', machine: null }],
    factoryEnabled: () => true,
    factoryMachine: () => null,
    factoryApps: async () => [{ app: 'dev-tools', repo: 'xvanov/dev-tools' }],
    claudeAuth: async () => ({ code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' }),
    dbProbe: async () => ({ ok: 1 }),
    gh: async () => ({ code: 0, stdout: JSON.stringify({ viewerPermission: 'ADMIN' }), stderr: '' }),
    // the policy's audit log as answerPrompt and chatCall write it (newest first)
    answerPrompt: async (tool, args, subject) => {
      log.audit.unshift({ seq: log.audit.length + 1, tool, action: 'approve', channel: 'e2e', actor: 'pa-e2e', subject, decision: 'allow', rule: 'approve-chat-actions' });
      return { prompted: true, rule: 'chat-actions-ask', answer: 'allow' };
    },
    chatCall: async (tool, args) => {
      log.audit.unshift({ seq: log.audit.length + 1, tool, action: 'call', channel: 'chat', actor: 'pa-e2e', subject: String(args.job ?? args.card), decision: 'ask', rule: 'chat-actions-ask' });
      return deps.chat(tool, args);
    },
    auditRows: async (tool) => log.audit.filter((r) => r.tool === tool),
    ...over,
  };
  return { deps, log, dir };
}

test('whats-on: replays the talk page: warm, smart-turn with the transcription, TTS at the first piece; evidence written', async () => {
  const { deps, log } = fakeDeps();
  const s = await R.main('whats-on', {}, {}, deps);
  assert.strictEqual(s.ok, true, JSON.stringify(s.failed.concat(s.errors)));
  const by = Object.fromEntries(s.hops.map((h) => [h.c, h]));
  assert.strictEqual(by['talk-page'].ms, 96, 'the VAD shortcut, then the transcription goes with the check');
  assert.match(by['talk-page'].note, /smart-turn \d+ ms \(model 60 ms\), p 0\.93, alongside the transcription/);
  assert.strictEqual(by.whisper.ms, 80, 'the request as the page sees it');
  assert.ok(by['fast-lane'].ms != null && by.voice.ms != null);
  assert.match(by['fast-lane'].note, /first piece "You have standup at ten\." \(5 words\)/);
  assert.strictEqual(s.cost.usd, 0);
  assert.ok(fs.existsSync(path.join(s.folder, 'summary.json')));
  assert.ok(fs.readFileSync(path.join(s.folder, 'transcripts', 'turn.txt'), 'utf8').includes('standup'));
  assert.deepStrictEqual(log.shots, [], 'Ask is the chat tool answer, not a /talk shot');
  assert.deepStrictEqual(s.views.ask, { method: 'tool', tool: 'chat', excerpt: 'You have standup at ten.' });
  const talk = log.posts.filter((u) => u.includes('/api/talk/')).map((u) => u.replace(/^.*\/api\/talk\//, ''));
  assert.deepStrictEqual(talk, ['tts', 'warm', 'endpoint', 'transcribe', 'turn', 'tts']);
});

test('whats-on: TTS starts at the first clause while the turn still streams (8.4.7)', async () => {
  let ttsInTurn = null;
  const { deps, log } = fakeDeps();
  const post = deps.post;
  deps.post = async (url, body, opts = {}) => {
    if (!url.endsWith('/api/talk/turn')) return post(url, body, opts);
    log.posts.push(url);
    const lines = ['{"type":"decision","route":"answer"}\n', '{"type":"delta","text":"Nothing is left on your calendar, and "}\n', '{"type":"delta","text":"tomorrow starts at 10:00. "}\n', '{"type":"done","route":"answer"}\n'];
    for (const l of lines.slice(0, 2)) opts.onChunk(Buffer.from(l));
    ttsInTurn = log.posts.filter((u) => u.endsWith('/tts')).length;
    for (const l of lines.slice(2)) opts.onChunk(Buffer.from(l));
    return lines.join('');
  };
  const s = await R.main('whats-on', {}, {}, deps);
  assert.strictEqual(ttsInTurn, 2, 'the first clause went to TTS before the turn ended');
  const fl = s.hops.find((h) => h.c === 'fast-lane');
  assert.match(fl.note, /first piece "Nothing is left on your calendar,"/);
});

test('whats-on: smart-turn says not done: the turn ends at endMs of silence and is transcribed again', async () => {
  const { deps, log } = fakeDeps();
  const post = deps.post;
  deps.post = async (url, body, opts) => (url.endsWith('/api/talk/endpoint') ? (log.posts.push(url), JSON.stringify({ complete: false, probability: 0.2, ms: 60 })) : post(url, body, opts));
  const s = await R.main('whats-on', {}, {}, deps);
  const tp = s.hops.find((h) => h.c === 'talk-page');
  assert.strictEqual(tp.ms, 650);
  assert.strictEqual(tp.ok, false);
  assert.match(tp.note, /not done, so the turn ended at endMs \(650 ms\)/);
  assert.strictEqual(log.posts.filter((u) => u.endsWith('/transcribe')).length, 2);
  assert.ok(s.failed.some((f) => /smart-turn said the question was done/.test(f)));
});

test('research: a research job to report.md, no PR, linked in Plan, Run and the job tool; card dropped', async () => {
  const { deps, log } = fakeDeps();
  const s = await R.main('research', {}, {}, deps);
  assert.strictEqual(s.ok, true, JSON.stringify(s.failed.concat(s.errors)));
  const start = log.chat.find(([n]) => n === 'factory_start')[1];
  assert.deepStrictEqual([start.kind, start.runtime, start.card], ['research', 'claude_session', '90']);
  assert.deepStrictEqual(log.audit.map((a) => [a.action, a.channel]).reverse(), [['approve', 'e2e'], ['call', 'chat']], 'the start went through the approval');
  assert.ok(s.checks.filter((c) => c.view === 'policy').length === 2 && s.checks.filter((c) => c.view === 'policy').every((c) => c.ok));
  assert.ok(fs.existsSync(path.join(s.folder, 'report.md')));
  assert.ok(s.transcripts.includes('transcripts/session-rs1.txt'));
  assert.deepStrictEqual(log.closed, ['90']);
  assert.ok(!log.chat.some(([n]) => n === 'factory_cancel'), 'a done job is not cancelled');
  assert.ok(log.shots.includes('plan') && log.shots.includes('run-rs1'));
  assert.ok(!log.shots.includes('ask'), 'Ask is not a /talk shot');
  assert.strictEqual(s.views.ask.method, 'tool');
  assert.strictEqual(s.views.ask.tool, 'factory_job');
  assert.match(s.views.ask.excerpt, /"card":"90"/);
  assert.strictEqual(s.hops.find((h) => h.c === 'worker').ms, null);
  assert.match(s.hops.find((h) => h.c === 'worker').note, /no \/api\/events subscription/);
  assert.deepStrictEqual(log.killed.sort(), ['follow7', 'rs1'], 'the step and follow sessions are killed');
  assert.ok(s.cleanup.some((c) => /session follow7 killed/.test(c)));
  assert.deepStrictEqual(log.pages, ['http://hub:7000/'], 'the step\'s session link is opened (8.4.17)');
  assert.ok(s.checks.some((c) => c.view === 'run' && c.check === 'session rs1 link opens' && c.ok));
});

test('research: the worker hop times done to the Plan card (8.4.10)', async () => {
  const { deps, log } = fakeDeps();
  const urls = [];
  deps.subscribe = (url, onEvent) => {
    urls.push(url);
    deps.emit = onEvent;
    return () => { deps.emit = null; log.shots.push('unsubscribed'); };
  };
  const jobStatus = deps.jobStatus;
  deps.jobStatus = async () => {
    const st = await jobStatus();
    if (st.state === 'done' && deps.emit) {
      const t = '2026-11-08T23:35:59.000Z';
      deps.emit({ topic: 'factory', at: t, payload: { table: 'push', op: 'push', jobs: ['dev-tools:r001'] } });
      deps.emit({ topic: 'run', at: '2026-11-08T23:35:59.050Z', payload: { table: 'run', id: 7, factory_job_id: 'dev-tools:r001', factory_state: 'done' } });
      deps.emit({ topic: 'board', at: '2026-11-08T23:35:59.150Z', payload: { table: 'commitment', op: 'update', id: 90, status: 'done' } });
    }
    return st.state === 'done' ? { ...st, updated_at: '2026-11-08T23:35:59.000Z' } : st;
  };
  const s = await R.main('research', {}, {}, deps);
  const w = s.hops.find((h) => h.c === 'worker');
  assert.strictEqual(s.ok, true, JSON.stringify(s.failed.concat(s.errors)));
  assert.match(urls[0], /topics=factory,run,board/);
  assert.strictEqual(w.ms, 150);
  assert.match(w.note, /done terminal 150 ms via plan card \(job status\)/);
  assert.ok(log.shots.includes('unsubscribed'));
});

test('research: a step session link that 404s fails the Run view (8.4.17)', async () => {
  const { deps } = fakeDeps({ pageStatus: async () => 404 });
  const s = await R.main('research', {}, {}, deps);
  assert.strictEqual(s.ok, false);
  const c = s.checks.find((x) => x.check === 'session rs1 link opens');
  assert.ok(c && c.view === 'run' && !c.ok, JSON.stringify(c));
  assert.match(c.detail, /→ 404/);
});

test('research: approval to started is timed from the job\'s own started_at, polled fast until it starts (8.4.9)', async () => {
  const { deps } = fakeDeps();
  const slept = [];
  const sleep = deps.sleep;
  deps.sleep = async (ms) => { slept.push(ms); return sleep(ms); };
  let polls = 0;
  let returnedAt = null;
  const chat = deps.chat;
  deps.chat = async (name, args) => {
    const r = await chat(name, args);
    if (name === 'factory_start') returnedAt = deps.now();
    return r;
  };
  deps.jobStatus = async () => {
    polls++;
    if (polls < 3) return { job_id: 'dev-tools:r001', state: 'queued', runs: [], stories: [] };
    const started_at = new Date(returnedAt + 2100).toISOString();
    const done = polls >= 4;
    return { job_id: 'dev-tools:r001', state: done ? 'done' : 'in_progress', started_at, updated_at: new Date(returnedAt + 11_500).toISOString(), cost_usd: 0, stories: [], runs: [{ id: 3, runtime: 'claude_session', state: 'ok', started_at: new Date(returnedAt + 12_300).toISOString(), session: { termhub_session_id: 'rs1', links: { job: 'dev-tools:r001', step: '3' } } }] };
  };
  const s = await R.main('research', {}, {}, deps);
  const by = Object.fromEntries(s.hops.map((h) => [h.c, h]));
  assert.strictEqual(by.dispatcher.ms, 2100, JSON.stringify(by.dispatcher));
  assert.ok(/factory started_at/.test(by.dispatcher.note));
  assert.strictEqual(by['runtime-claude'].ms, 11_500 - 2100, 'started_at to the done job\'s updated_at');
  assert.deepStrictEqual(slept.slice(0, 2), [1000, 1000]);
});

test('research: screenshots are taken before cleanup; --keep leaves the sessions and names its sweep', async () => {
  const { deps, log } = fakeDeps();
  const capture = deps.capture;
  deps.capture = async (d, pages) => {
    assert.deepStrictEqual(log.killed, [], 'no session killed before the shots');
    assert.deepStrictEqual(log.closed, [], 'card still up for the shots');
    return capture(d, pages);
  };
  const s = await R.main('research', { keep: true }, {}, deps);
  assert.strictEqual(s.ok, true, JSON.stringify(s.failed.concat(s.errors)));
  assert.deepStrictEqual(log.killed, []);
  assert.deepStrictEqual(log.closed, []);
  assert.ok(s.cleanup.some((c) => /--sweep --marker e2e-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/.test(c)), s.cleanup.join('\n'));
});

test('dry runs create nothing and cover every workflow', async () => {
  for (const id of W.workflows(ARCH)) {
    const { deps, log } = fakeDeps({ getJson: fakeDeps().deps.getJson });
    const s = await R.main(id, { 'dry-run': true }, {}, deps);
    assert.strictEqual(s.kind, 'dry-run', id);
    assert.ok(s.checks.length >= 2, id);
    assert.ok(!log.chat.some(([n]) => n.startsWith('factory_')), `${id}: nothing started`);
    assert.deepStrictEqual(log.closed, [], id);
  }
});

test('dry run: an app nothing ticks fails the run before it submits (8.4.24)', async () => {
  const { deps } = fakeDeps({ factoryApps: async () => [{ app: 'dev-tools', repo: 'xvanov/dev-tools', ticked: false }] });
  const s = await R.main('research', { 'dry-run': true }, {}, deps);
  const c = s.checks.find((x) => x.check === 'factory ticks app dev-tools');
  assert.ok(c && !c.ok, JSON.stringify(s.checks));
  assert.match(c.detail, /serve_tick: true.*factory tick --app dev-tools/);
  assert.strictEqual(s.ok, false);
  const unknown = await R.main('research', { 'dry-run': true }, {}, fakeDeps().deps);
  const u = unknown.checks.find((x) => x.check === 'factory ticks app dev-tools');
  assert.ok(u.ok && /unknown/.test(u.detail), 'an older factory says nothing: passes with a note');
});

test('teams-ask without --test-chat and review-fix without --pr start nothing', async () => {
  const { deps, log } = fakeDeps();
  const s = await R.main('teams-ask', {}, {}, deps);
  assert.strictEqual(s.ok, false);
  assert.match(s.errors[0], /needs --test-chat <id>/);
  const rf = await R.main('review-fix', {}, {}, deps);
  assert.ok(!rf.ok && /needs --pr <n>/.test(rf.errors[0]), JSON.stringify(rf.errors));
  assert.strictEqual(log.chat.length, 0);
  assert.throws(() => R.parse('review-fix', { pr: 'abc' }, {}), /--pr is a PR number/);
  assert.strictEqual(R.parse('review-fix', { pr: '#12' }, {}).pr, 12);
});

// --- teams-ask (8.4.30) ----------------------------------------------------------------------

const ME = { display_name: 'Alex Doe', primary_email: 'alex@example.test' };

test('teams-ask phrase: a marker of 40+ chars and the next Friday as an absolute date', () => {
  const m = W.teamsMarker('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.ok(m.length >= W.TEAMS_MARKER_MIN && m.startsWith('e2e-teams-'));
  assert.throws(() => W.teamsMarker('short'), /too short/);
  const sun = W.teamsPhrase(m, new Date(2026, 10, 8, 21, 0));
  assert.strictEqual(sun.due, '2026-11-13');
  assert.match(sun.text, /by Friday 13 November 2026\. e2e-teams-/);
  assert.ok(sun.text.endsWith(m));
  assert.strictEqual(W.teamsPhrase(m, new Date(2026, 10, 13, 9, 0)).due, '2026-11-20', 'on a Friday: a week out');
});

test('teams-ask test chat: stored, a chat, only you wrote in it and only you are in it', () => {
  const mine = W.ownerIds(ME, [{ kind: 'aad_oid', value: 'ABC' }, { kind: 'github_username', value: 'alex' }]);
  assert.deepStrictEqual([...mine].sort(), ['aad:abc', 'alex@example.test']);
  const ok = (cs) => cs.map((c) => c.ok);
  assert.deepStrictEqual(ok(W.testChatChecks('48:notes', { authors: [{ author: 'alex@example.test', n: 2 }, { author: 'aad:abc', n: 1 }], mine, self: true })), [true, true, true, true]);
  const shared = W.testChatChecks('19:x@thread.v2', { authors: [{ author: 'alex@example.test', n: 2 }, { author: 'bo@example.test', n: 1 }], head: { raw: { memberEmails: ['alex@example.test', 'bo@example.test'] } }, mine });
  assert.deepStrictEqual(ok(shared), [true, true, false, false]);
  assert.strictEqual(shared[2].detail, '1 of 3 message(s) by 1 other author(s)');
  assert.ok(!JSON.stringify(shared).includes('bo@'), 'never names the others');
  assert.deepStrictEqual(ok(W.testChatChecks('48:drafts', { authors: [{ author: 'alex@example.test', n: 1 }], mine, system: true })), [true, false, true, false]);
  assert.deepStrictEqual(ok(W.testChatChecks('19:none', { authors: [], mine })), [false, true, false, false]);
  assert.deepStrictEqual(ok(W.testChatChecks('19:solo', { authors: [{ author: 'alex@example.test', n: 1 }], head: { raw: { memberEmails: ['Alex@Example.test'] } }, mine })), [true, true, true, true]);
});

test('teams-ask card checks: direction, you as the person, the due day, the link to this message', () => {
  const item = { external_id: '48:notes/1700000000000', raw: { messageId: '1700000000000' } };
  const good = { direction: 'owed_by_me', who: 'alex doe', due_at: '2026-11-13T17:00:00.000Z', web_url: 'https://teams.microsoft.com/l/message/48%3Anotes/1700000000000?context=%7B%7D' };
  assert.deepStrictEqual(W.teamsCardChecks(good, { item, due: '2026-11-13', meName: ME.display_name }).map((c) => c.ok), [true, true, true, true]);
  const bad = W.teamsCardChecks({ direction: 'owed_to_me', who: 'Bo', due_at: null, web_url: 'https://teams.microsoft.com/l/message/48%3Anotes/-1' }, { item: { raw: { messageId: '-1' } }, due: '2026-11-13', meName: ME.display_name });
  assert.deepStrictEqual(bad.map((c) => c.ok), [false, false, false, false]);
  assert.deepStrictEqual(bad.map((c) => c.detail), ['owed_to_me', 'someone else', 'no due date', 'message -1']);
});

/** A test chat the store follows: the message lands after `arriveAfter` ms, distilled at once. */
function teamsDeps({ arriveAfter = 3000, authors = [{ author: ME.primary_email, n: 2 }], toast = true, delivery = 'push' } = {}) {
  const f = fakeDeps();
  const { deps, log } = f;
  log.said = [];
  let onEvent = null;
  const t0 = deps.now();
  let item = null;
  const at = (ms) => new Date(ms).toISOString();
  Object.assign(deps, {
    say: (t) => log.said.push(t),
    subscribe: (url, cb) => { log.subscribed = url; onEvent = cb; return () => { log.unsubscribed = true; }; },
    chatAuthors: async () => authors,
    chatHead: async () => ({ raw: { chatType: 'self' } }),
    owner: async () => ({ me: ME, identities: [] }),
    async chatItemWith(chat, marker) {
      if (deps.now() - t0 < arriveAfter) return null;
      if (!item) {
        const now = deps.now();
        item = { id: 77, external_id: `${chat}/1700000000000`, occurred_at: at(now - 1500), fetched_at: at(now - 300), raw: { messageId: '1700000000000', storedAt: at(now - 400) }, marker, distilled_at: null };
        return item;
      }
      if (!item.distilled_at) {
        item.distilled_at = at(deps.now());
        item.extractedAt = deps.now() - 60;
        onEvent?.({ topic: 'board', payload: { table: 'commitment', op: 'insert', id: 501 } });
      }
      return item;
    },
    itemCommitments: async () => [{ id: 501, direction: 'owed_by_me', status: 'open', superseded_by: null, extracted_at: at(item.extractedAt) }],
    notificationByKey: async (key) => (key === 'new-ask:77' ? { kind: 'new_ask', delivery, priority: 'normal', created_at: at(item.extractedAt + 20), toasted_at: toast ? at(item.extractedAt + 900) : null } : null),
    async getJson(url) {
      if (url.endsWith('/api/workflow-limits')) return { limits: { 'teams-ask': { effective: 0.05, custom: false } } };
      if (url.endsWith('/api/state')) return { commitments: [], sources: [{ source: 'teams_cache' }], board: { onMe: item?.distilled_at ? [{ id: 501 }] : [], waiting: [] } };
      if (url.endsWith('/api/commitments/501')) return { id: 501, direction: 'owed_by_me', who: ME.display_name, due_at: `${W.teamsPhrase('m', t0).due}T12:00:00.000Z`, web_url: 'https://teams.microsoft.com/l/message/48%3Anotes/1700000000000?context=x' };
      throw new Error(`unexpected ${url}`);
    },
  });
  return f;
}

test('teams-ask real run: prints the phrase, follows the one message, times each hop, drops the card, sends nothing', async () => {
  const { deps, log } = teamsDeps();
  const s = await R.main('teams-ask', { 'test-chat': '48:notes' }, {}, deps);
  const said = log.said.join('\n');
  assert.match(said, /type this into the test chat \(48:notes\)/);
  assert.match(said, /Note to self: .* e2e-teams-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
  assert.strictEqual(log.subscribed, 'http://pa/api/events?topics=board');
  assert.ok(log.unsubscribed);
  const hop = (c) => s.hops.find((h) => h.c === c);
  assert.strictEqual(hop('ingest').ms, 1100, 'arrival stamp to storedAt');
  assert.strictEqual(hop('dashboard').ms, 60, 'extracted_at to /api/state holding the card after its event');
  assert.strictEqual(hop('notify').ms, 900);
  assert.ok(hop('commitments').ms != null);
  assert.deepStrictEqual(s.checks.filter((c) => !c.ok), [], JSON.stringify(s.checks));
  assert.ok(['owed_by_me', 'person: names who asked (you, in your own test chat)', 'link: opens this message'].every((n) => s.checks.some((c) => c.check === n)));
  assert.ok(s.checks.some((c) => c.check === `due: ${W.teamsPhrase('m', 1_000_000).due}`), 'the phrase is dated from the run clock');
  assert.deepStrictEqual(log.closed, ['501']);
  assert.ok(s.cleanup.some((l) => /card #501 dropped/.test(l)));
  assert.deepStrictEqual([log.posts, log.chat], [[], []], 'nothing posted, no chat tool called');
  assert.deepStrictEqual(s.links.card, '501');
  assert.deepStrictEqual(s.errors, []);
  assert.ok(Object.keys(s.views).includes('run'));
});

test('teams-ask real run: a held toast is a missed hop with the reason; the card is still dropped', async () => {
  const { deps, log } = teamsDeps({ toast: false, delivery: 'digest' });
  const s = await R.main('teams-ask', { 'test-chat': '48:notes' }, {}, deps);
  const n = s.hops.find((h) => h.c === 'notify');
  assert.strictEqual(n.ms, null);
  assert.match(n.note, /held, delivery digest: quiet hours or the interrupt budget/);
  assert.strictEqual(s.ok, false);
  assert.deepStrictEqual(s.failed.filter((f) => /^notify/.test(f)).map((f) => f.split(' (')[0]), ['notify: toasted']);
  assert.deepStrictEqual(log.closed, ['501']);
});

test('teams-ask real run: no message in time is a clear error and creates nothing; a shared chat is refused first', async () => {
  const { deps, log } = teamsDeps({ arriveAfter: Infinity });
  const s = await R.main('teams-ask', { 'test-chat': '48:notes' }, { timeout: ['teams=5'] }, deps);
  assert.match(s.errors[0], /no message with the marker reached the store in 5 s\. Type the phrase into the test chat \(48:notes\)/);
  assert.deepStrictEqual(s.cleanup, ['nothing was created']);
  assert.deepStrictEqual(log.closed, []);
  const shared = teamsDeps({ authors: [{ author: ME.primary_email, n: 1 }, { author: 'bo@example.test', n: 4 }] });
  const r = await R.main('teams-ask', { 'test-chat': '19:x@thread.v2' }, {}, shared.deps);
  assert.match(r.errors[0], /is not a test chat with only you in it: only you wrote in it/);
  assert.ok(r.checks.some((c) => c.check === 'only you wrote in it' && !c.ok));
  assert.deepStrictEqual(shared.log.said, [], 'no phrase for a chat with others in it');
});

test('teams-ask dry run: --test-chat is checked against the store', async () => {
  const solo = await R.main('teams-ask', { 'dry-run': true, 'test-chat': '48:notes' }, {}, teamsDeps().deps);
  assert.ok(solo.checks.some((c) => c.check === 'only you are in it' && c.ok && c.detail === 'your self chat'), JSON.stringify(solo.checks));
  assert.ok(solo.checks.some((c) => c.check === 'test chat 48:notes is in the store' && c.ok));
  const shared = await R.main('teams-ask', { 'dry-run': true, 'test-chat': '48:notes' }, {}, teamsDeps({ authors: [{ author: 'bo@example.test', n: 1 }] }).deps);
  assert.strictEqual(shared.ok, false);
  const none = await R.main('teams-ask', { 'dry-run': true }, {}, teamsDeps().deps);
  assert.ok(none.notes.some((n) => /Add --test-chat to the dry run/.test(n)));
});

// --- review-fix (8.4.25) ---------------------------------------------------------------------

const P = require('../src/policy');

function prJson({ head = 'a'.repeat(40), state = 'OPEN', merged = false, unresolved = 2, ci = 'SUCCESS', newest = 12, fork = false, opened = [] } = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 12, state, merged, isDraft: false, isCrossRepository: fork, url: 'https://github.com/xvanov/dev-tools/pull/12',
          headRefName: 'fix/retry', headRefOid: head, baseRefName: 'main',
          reviewThreads: { nodes: [...Array(unresolved).fill({ isResolved: false }), { isResolved: true }] },
          commits: { nodes: [{ commit: { oid: head, statusCheckRollup: ci ? { state: ci } : null } }] },
        },
        // `opened`: PRs newer than #12, newest first, as [number, branch]
        pullRequests: { nodes: [...opened.map(([number, headRefName]) => ({ number, headRefName })), { number: newest, headRefName: 'fix/retry' }] },
      },
    },
  };
}

function reviewFixDeps({ after = {}, compare = 'ahead', start = {}, job = {} } = {}) {
  let phase = 'before';
  const gh = [];
  const { deps, log } = fakeDeps({
    async gh(args, owner) {
      gh.push([args, owner]);
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { code: 0, stdout: JSON.stringify(phase === 'before' ? prJson() : prJson({ head: 'b'.repeat(40), ...after })), stderr: '' };
      }
      if (args[0] === 'api' && /\/compare\//.test(args[1])) return { code: 0, stdout: JSON.stringify({ status: compare, ahead_by: compare === 'ahead' ? 2 : 1, behind_by: compare === 'ahead' ? 0 : 3 }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ viewerPermission: 'ADMIN' }), stderr: '' };
    },
    async chat(name, args) {
      log.chat.push([name, args]);
      if (name === 'factory_continue') return { started: true, run: 8, job: 'dev-tools:042', kind: 'code', runtime: 'claude_session', delivery: args.delivery, continues: { branch: 'fix/retry', pr: 12, into: 'main' }, follow: 'http://hub/#session=follow8', timings_ms: { compose_model: 900 }, ...start };
      if (name === 'factory_cancel') return {};
      throw new Error(name);
    },
    // the chat's MCP server audits the call with policy's subject ('' for a card-less call) and the args' hash
    chatCall: async (tool, args) => {
      log.audit.unshift({ seq: log.audit.length + 1, tool, action: 'call', channel: 'chat', actor: 'pa-e2e', subject: '', args_hash: P.argsHash(args), decision: 'ask', rule: 'chat-actions-ask' });
      return deps.chat(tool, args);
    },
    jobStatus: async () => {
      phase = 'after';
      return { job_id: 'dev-tools:042', state: 'done', terminal: true, cost_usd: 0, base: { branch: 'fix/retry', pr: 12, into: 'main' }, stories: [], runs: [{ id: 5, runtime: 'claude_session', state: 'ok', session: { termhub_session_id: 'rf5', url: 'http://hub:7000/#session=rf5' } }], ...job };
    },
  });
  return { deps, log, gh };
}

test('review-fix: factory_continue on the PR through the approval; fast-forward, same PR, nothing merged, CI green', async () => {
  const { deps, log, gh } = reviewFixDeps();
  const s = await R.main('review-fix', { pr: '12' }, {}, deps);
  assert.strictEqual(s.ok, true, JSON.stringify(s.failed.concat(s.errors)));
  const call = log.chat.find(([n]) => n === 'factory_continue')[1];
  assert.deepStrictEqual([call.repo, call.pr, call.delivery, call.runtime], ['xvanov/dev-tools', 12, 'pr', undefined], 'delivery pr (never merges); the default runtime is under test');
  assert.deepStrictEqual(log.audit.map((a) => [a.action, a.channel]).reverse(), [['approve', 'e2e'], ['call', 'chat']]);
  assert.ok(s.checks.filter((c) => c.view === 'policy').every((c) => c.ok) && s.checks.some((c) => c.check === 'factory_continue call audited after the approval'), 'found by its args hash');
  for (const name of ['PR #12 got new commits', 'pushed fast-forward (no force push)', 'same branch, no new PR opened', 'nothing merged; the PR is still open', 'CI green on the new head', 'job base is PR #12', 'continues PR #12']) {
    assert.ok(s.checks.some((c) => c.check === name && c.ok), name);
  }
  assert.ok(gh.every(([, owner]) => owner === 'xvanov'), 'gh as the repo owner');
  assert.ok(gh.some(([a]) => a[1] === `repos/xvanov/dev-tools/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`));
  const by = Object.fromEntries(s.hops.map((h) => [h.c, h]));
  assert.match(by.jarvis.note, /less the composing model's 900 ms/);
  assert.strictEqual(s.cost.usd, 0);
  assert.deepStrictEqual(s.links.head, { before: 'a'.repeat(40), after: 'b'.repeat(40) });
  assert.ok(log.shots.includes('build') && log.shots.includes('github-pr') && log.shots.includes('run-rf5'));
  assert.ok(!log.shots.includes('ask'));
  assert.strictEqual(s.views.ask.tool, 'factory_continue');
  assert.match(s.views.ask.excerpt, /dev-tools:042/);
  assert.deepStrictEqual(log.killed.sort(), ['follow8', 'rf5']);
  assert.ok(!log.chat.some(([n]) => n === 'factory_cancel'), 'a done job is not cancelled');
  assert.ok(s.cleanup.some((c) => /PR #12 left open/.test(c)));
});

test('review-fix: a force push, a new PR, a merge or red CI fails the run', async () => {
  const cases = [
    [{ compare: 'diverged' }, 'pushed fast-forward (no force push)'],
    [{ after: { opened: [[13, 'fix/retry']] } }, 'same branch, no new PR opened'],
    [{ after: { opened: [[13, 'factory/story-7']] }, job: { stories: [{ id: 7, branch: 'factory/story-7' }] } }, 'same branch, no new PR opened'],
    [{ job: { pr_urls: ['https://github.com/xvanov/dev-tools/pull/12', 'https://github.com/xvanov/dev-tools/pull/14'] } }, 'same branch, no new PR opened'],
    [{ after: { state: 'MERGED', merged: true } }, 'nothing merged; the PR is still open'],
    [{ after: { ci: 'FAILURE' } }, 'CI green on the new head'],
    [{ after: { head: 'a'.repeat(40) } }, 'PR #12 got new commits'],
  ];
  for (const [over, name] of cases) {
    const { deps } = reviewFixDeps(over);
    const s = await R.main('review-fix', { pr: '12' }, {}, deps);
    assert.strictEqual(s.ok, false, name);
    assert.ok(s.checks.some((c) => c.check === name && !c.ok), `${name}: ${JSON.stringify(s.checks.filter((c) => !c.ok))}`);
  }
});

test('review-fix: a PR someone else opens in the repo meanwhile is not the job\'s new PR (8.4.42)', async () => {
  const { deps } = reviewFixDeps({ after: { opened: [[69, 'factory/65-other-story']] }, job: { pr_urls: ['https://github.com/xvanov/dev-tools/pull/12'], stories: [{ id: 201, branch: 'fix/retry', pr_url: 'https://github.com/xvanov/dev-tools/pull/12', pr_number: 12 }] } });
  const s = await R.main('review-fix', { pr: '12' }, {}, deps);
  const c = s.checks.find((x) => x.check === 'same branch, no new PR opened');
  assert.ok(c && c.ok, JSON.stringify(c));
  assert.strictEqual(c.detail, "the job's only PR is #12; #69 opened meanwhile from other branches, not counted");
  assert.strictEqual(s.ok, true, JSON.stringify(s.failed.concat(s.errors)));
  assert.deepStrictEqual(W.jobPrs({ pr_urls: ['https://github.com/o/r/pull/12'], stories: [{ pr_number: 14, branch: 'b1' }, { pr_url: 'https://github.com/o/r/pull/15' }], base: { branch: 'fix/retry' } }), { prs: [12, 14, 15], branches: ['b1', 'fix/retry'] });
});

test('review-fix: a job for an app nothing ticks, or a PR with nothing to fix, starts no wait', async () => {
  const idle = reviewFixDeps({ start: { waiting: 'app dev-tools is not ticked: ...' } });
  const s = await R.main('review-fix', { pr: '12' }, {}, idle.deps);
  assert.ok(!s.ok && /would sit queued/.test(s.errors[0]), JSON.stringify(s.errors));
  assert.ok(idle.log.chat.some(([n]) => n === 'factory_cancel'), 'the queued job is cancelled');
  const { deps, log } = reviewFixDeps();
  deps.gh = async () => ({ code: 0, stdout: JSON.stringify(prJson({ unresolved: 0 })), stderr: '' });
  const none = await R.main('review-fix', { pr: '12' }, {}, deps);
  assert.ok(!none.ok && /has unresolved review threads \(0 of 1 unresolved\)/.test(none.errors[0]), JSON.stringify(none.errors));
  assert.ok(!log.chat.some(([n]) => n === 'factory_continue'), 'nothing started');
});

test('review-fix dry run: the PR exists, is open, ours, and has unresolved threads', async () => {
  const { deps } = reviewFixDeps();
  const s = await R.main('review-fix', { 'dry-run': true, pr: '12' }, {}, deps);
  for (const name of ['PR #12 exists in xvanov/dev-tools', 'PR #12 is open', 'PR #12 is from a branch of xvanov/dev-tools', 'PR #12 has unresolved review threads']) {
    assert.ok(s.checks.some((c) => c.check === name && c.ok), name);
  }
  deps.gh = async () => ({ code: 0, stdout: JSON.stringify(prJson({ state: 'CLOSED', unresolved: 0 })), stderr: '' });
  const closed = await R.main('review-fix', { 'dry-run': true, pr: '12' }, {}, deps);
  assert.deepStrictEqual(closed.checks.filter((c) => c.view === 'github' && !c.ok).map((c) => c.check), ['PR #12 is open', 'PR #12 has unresolved review threads']);
  deps.gh = async () => ({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 12.' });
  const gone = await R.main('review-fix', { 'dry-run': true, pr: '12' }, {}, deps);
  assert.ok(gone.checks.some((c) => c.check === 'PR #12 exists in xvanov/dev-tools' && !c.ok));
  const bare = await R.main('review-fix', { 'dry-run': true }, {}, reviewFixDeps().deps);
  assert.ok(!bare.checks.some((c) => c.view === 'github') && bare.notes.some((n) => /--pr <n>/.test(n)));
});

test('--on runs the workflow on that machine (8.4.25): the dry run by exec, a real run in a termhub session', async () => {
  const ran = [];
  const sessions = [];
  const summary = { ok: true, workflow: 'review-fix', kind: 'dry-run', checks: [] };
  let reads = 0;
  const { deps } = fakeDeps({
    config: { termhub: { machines: { lab: { reposRoot: '/home/tester/src', os: 'linux' } } } },
    runCommand: async (machine, argv, opts) => {
      ran.push({ machine, argv, cwd: opts.cwd });
      if (argv[1] === '-e') return ++reads < 2 ? { code: 1, stdout: '', stderr: 'ENOENT' } : { code: 0, stdout: JSON.stringify({ ...summary, kind: 'run' }), stderr: '' };
      return { code: 1, stdout: JSON.stringify(summary), stderr: '' };
    },
    hub: () => ({ createSession: async (s) => { sessions.push(s); return { id: 'remote1' }; } }),
  });
  const s = await R.main('review-fix', { on: 'lab', 'dry-run': true, pr: '12' }, { timeout: ['review=600'] }, deps);
  assert.deepStrictEqual(s, summary, 'the remote summary, even on a failing exit');
  assert.deepStrictEqual(ran[0].argv, ['node', 'bin/pa.js', 'e2e', 'review-fix', '--json', '--dry-run', '--pr', '12', '--timeout', 'review=600']);
  assert.strictEqual(ran[0].cwd, '/home/tester/src/dev-tools/personal-assistant');
  assert.strictEqual(ran[0].machine, 'lab');

  const real = await R.main('review-fix', { on: 'lab', pr: '12' }, {}, deps);
  assert.strictEqual(real.kind, 'run');
  assert.match(sessions[0].command, /^node bin\/pa\.js e2e review-fix --json --pr 12 --report e2e-report-[\w-]+\.json$/);
  assert.match(sessions[0].title, /^pa e2e review-fix/);
});

// --- 8.4.40: a screenshot step never skips the summary or the cleanup ------------------------

test('review-fix: a capture that throws or never settles is a failed check; the summary and cleanup still happen', async () => {
  for (const capture of [async () => { throw new Error('browser gone'); }, () => new Promise(() => {})]) {
    const { deps, log } = reviewFixDeps();
    deps.capture = capture;
    deps.shotMs = 50;
    const s = await R.main('review-fix', { pr: '12' }, {}, deps);
    assert.strictEqual(s.ok, false);
    assert.ok(fs.existsSync(path.join(s.folder, 'summary.json')));
    const shot = s.checks.find((c) => c.check === 'screenshot of build');
    assert.ok(shot && shot.view === 'evidence' && !shot.ok, JSON.stringify(s.checks.filter((c) => !c.ok)));
    assert.match(shot.detail, /browser gone|no screenshots after/);
    assert.deepStrictEqual(log.killed.sort(), ['follow8', 'rf5'], 'the sessions are still killed');
    assert.ok(s.checks.some((c) => c.check === 'CI green on the new head' && c.ok), 'the outcome checks are kept');
  }
});

test('a run left on a promise nothing settles writes its summary and report at exit, non-zero', async () => {
  const report = path.join(os.tmpdir(), `pa-e2e-report-${process.pid}.json`);
  const { deps } = reviewFixDeps();
  let held = false;
  deps.answerPrompt = () => { held = true; return new Promise(() => {}); };
  const before = process.listenerCount('beforeExit');
  R.main('review-fix', { pr: '12', report }, {}, deps);
  for (let i = 0; i < 200 && !held; i++) await new Promise((r) => setImmediate(r));
  assert.ok(held, 'the run reached the call that never settles');
  assert.strictEqual(process.listenerCount('beforeExit'), before + 1, 'the guard is armed while the run is out');
  process.emit('beforeExit', 0);
  try {
    assert.strictEqual(process.exitCode, 1);
    const s = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.strictEqual(s.ok, false);
    assert.match(s.errors[0], /stopped in the review-fix runner with nothing left to run/);
    assert.ok(fs.existsSync(path.join(s.folder, 'summary.json')));
  } finally {
    process.exitCode = 0;
    fs.rmSync(report, { force: true });
  }
  const done = reviewFixDeps();
  await R.main('review-fix', { pr: '12' }, {}, done.deps);
  assert.strictEqual(process.listenerCount('beforeExit'), before, 'a run that ends disarms it');
});

test('shotChecks: a view with no file fails; a shot fails nothing', () => {
  assert.deepStrictEqual(W.shotChecks([{ view: 'build', file: 'b.png' }, { view: 'run-x', file: null, error: 'no screenshot within 60 s' }]), [{ view: 'evidence', check: 'screenshot of run-x', ok: false, detail: 'no screenshot within 60 s' }]);
  assert.deepStrictEqual(W.shotChecks(null), []);
});

test('deepseek-pr defaults to the Azure DeepSeek deployment on the API runtime', () => {
  const o = R.parse('deepseek-pr', {}, {});
  assert.strictEqual(o.runtime, 'api');
  assert.strictEqual(o.model, 'azure/deepseek-v4-pro');
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
