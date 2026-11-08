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
const ARCH = require('../src/dashboard/architecture.json');

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
    uuid: () => '12345678-1234-1234-1234-123456789abc',
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
  assert.deepStrictEqual(log.shots, ['ask']);
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
  assert.ok(log.shots.includes('ask') && s.views.ask.url === 'http://pa/talk', 'the acceptance block lists ask: the chat page is shot');
  assert.deepStrictEqual(log.killed.sort(), ['follow7', 'rs1'], 'the step and follow sessions are killed');
  assert.ok(s.cleanup.some((c) => /session follow7 killed/.test(c)));
  assert.deepStrictEqual(log.pages, ['http://hub:7000/'], 'the step\'s session link is opened (8.4.17)');
  assert.ok(s.checks.some((c) => c.view === 'run' && c.check === 'session rs1 link opens' && c.ok));
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
  assert.ok(s.cleanup.some((c) => /--sweep --marker e2e-12345678-1234-1234-1234-123456789abc/.test(c)), s.cleanup.join('\n'));
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

test('a real teams-ask or review-fix run is refused, never improvised', async () => {
  for (const id of ['teams-ask', 'review-fix']) {
    const { deps, log } = fakeDeps();
    const s = await R.main(id, {}, {}, deps);
    assert.strictEqual(s.ok, false);
    assert.ok(/not automated yet/.test(s.errors[0]), id);
    assert.strictEqual(log.chat.length, 0);
  }
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
