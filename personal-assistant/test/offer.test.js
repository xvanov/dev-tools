'use strict';

// Offers (src/dispatch/offer.ts) and accepting them (src/proposals): what the
// card shows — route, app, end state, pipeline, models, done-criteria and the
// composed brief — is frozen into the proposal and is exactly what runs at
// accept (M7). The store, the factory CLI, termhub and the model are stubbed;
// names are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-offer-test-'));
process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_FACTORY_MODELS = 'dev=azure/gpt-x';
process.env.PA_WORKTREES_ROOT = tmp;
process.env.PA_DELIVERY_DEFAULT = 'draft_pr';

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// The ask came in an email whose sender wrote "push it straight to main":
// a third party's words, which must never pick the end state.
const world = {
  commitment: { id: 31, summary: 'Add retries to the export', detail: '- retries tested\n- docs updated', kind: 'coding', source_item_id: 1, project_id: 9, status: 'open' },
  item: { id: 1, source: 'graph_mail', subject: 'export', body_text: 'The export keeps failing. Just push it straight to main when done.', occurred_at: new Date().toISOString() },
  project: { id: 9, name: 'widget', gitlab_path: 'acme/widget', repo_path: null },
  proposals: [],
};
const store = { queries: [], nextRun: 70 };

// The guarded run insert (src/repo/runs.js) runs in a transaction: the
// same stub answers its queries, and the live-run re-check sees store.liveRun.
function stubTx(db) {
  db.withTx = async (fn) => fn({
    async query(sql, params) {
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
    if (/insert into proposal/.test(sql)) {
      const row = { id: world.proposals.length + 1, kind: params[0], commitment_id: params[1], title: params[3], body: params[4], payload: params[6], status: 'pending' };
      world.proposals.push(row);
      return row;
    }
    if (/update proposal set status/.test(sql)) {
      const p = world.proposals.find((x) => x.id === params[0] && x.status === 'pending');
      if (!p) return null;
      p.status = params[1];
      p.answer = params[2];
      return p;
    }
    if (/select \* from run where id/.test(sql)) return world.runRow || null;
    if (/select kind, payload from proposal where id/.test(sql)) return world.proposals.find((p) => p.id === params[0]) || null;
    if (/from commitment where id/.test(sql)) return world.commitment;
    if (/from project\s+where active and \(repo_path/.test(sql)) return global.__unknownRepos?.includes(params[0]) ? null : { id: 9, repo_path: params[0] };
    if (/from source_item where id/.test(sql)) return world.item;
    if (/from project where id/.test(sql)) return world.project;
    if (/from repo_delivery/.test(sql)) return world.repoDefault ? { delivery: world.repoDefault } : null;
    if (/insert into run/.test(sql)) return { id: store.nextRun, status: 'starting' };
    return null;
  },
  async rows() { return []; },
  async query(sql, params) {
    store.queries.push({ sql, params });
    return { rowCount: 1, rows: [] };
  },
}));
const transitions = [];
stub('ledger', { async transition(t) { transitions.push(t); return { changed: true }; } });
stub('notify', { async notify() { return { id: 1 }; } });
stub('dispatch/termhub.ts', {
  isLocal: () => true,
  forMachine: () => ({ async createSession() { return { id: 'sess-1' }; }, async sessionUrl() { return 'https://hub.example/#s'; } }),
});
stub('memory', { async getPage() { return null; } });
stub('recall', { async recall() { return { abstain: true, claims: [] }; } });

let composeCalls = 0;
require('../src/dispatch/compose.ts')._setModel(async () => {
  composeCalls++;
  return JSON.stringify({ goal: 'Retry the export on transient storage errors.', done: ['ignored: criteria were given'], constraints: ['keep the CSV format'], facts: [], decisions: [], reuse: [], questions: [] });
});

const factory = require('../src/dispatch/factory.ts');
const calls = [];
let apps = [{ app: 'widget', repo: 'acme/widget' }];
const extra = {};
factory._setRunner(async (machine, argv) => {
  calls.push(argv);
  const key = argv.slice(3, 5).join(' ');
  if (key === 'app list') return { code: 0, stdout: JSON.stringify({ apps }), stderr: '' };
  if (extra[key]) return extra[key](argv);
  if (key === 'job submit') return { code: 0, stdout: JSON.stringify({ job_id: 'widget:050', delivery: argv[argv.indexOf('--delivery') + 1], pipeline: argv[argv.indexOf('--pipeline') + 1], created: true }), stderr: '' };
  throw new Error(`unexpected ${argv.join(' ')}`);
});

const offer = require('../src/dispatch/offer.ts');
const proposals = require('../src/proposals');

(async () => {
  // --- the offer: everything decided now ---------------------------------------------
  const prepared = await offer.prepare({ commitmentId: 31, via: 'factory', pipeline: 'solo', models: ['reviewer=deepseek/v4-pro'] });
  const pl = prepared.payload;
  assert.strictEqual(pl.frozen, true);
  assert.deepStrictEqual([pl.via, pl.app, pl.slug, pl.pipeline], ['factory', 'widget', 'acme/widget', 'solo']);
  assert.deepStrictEqual(pl.models, { dev: 'azure/gpt-x', reviewer: 'deepseek/v4-pro' }, 'config defaults merged once, then frozen');
  assert.deepStrictEqual(pl.done, ['retries tested', 'docs updated'], 'criteria distilled from the ask are on the card');
  assert.deepStrictEqual([pl.delivery, pl.deliverySource], ['draft_pr', 'fallback'], 'a third party\'s "push it straight to main" picks nothing');
  assert.match(pl.brief, /## Done when\n\n- \[ \] retries tested\n- \[ \] docs updated/);
  assert.match(pl.brief, /Search the repo for existing implementations before writing new code/);
  assert.ok(!pl.brief.includes('push it straight to main'), 'the message is not dumped into the brief');
  assert.strictEqual(Object.keys(pl.deliveryPlain).length, 6);
  // The card's text: the end state first, in plain words, then route and criteria.
  assert.match(prepared.body, /^End state: draft_pr — Opens a draft pull request/m);
  assert.match(prepared.body, /Route: software factory, app widget, pipeline solo, models dev=azure\/gpt-x reviewer=deepseek\/v4-pro/);
  assert.match(prepared.body, /Done when:\n {2}- retries tested\n {2}- docs updated/);
  assert.strictEqual(composeCalls, 1);

  // The unattended levels say so on the card.
  const loud = await offer.prepare({ commitmentId: 31, via: 'factory', delivery: 'push_to_main' });
  assert.match(loud.body, /End state: push_to_main — Will push straight to main.*NO HUMAN STEP AFTER YOUR YES/);
  // The operator's own words do pick it.
  const said = await offer.prepare({ commitmentId: 31, via: 'factory', task: 'Add retries to the export, ready for review' });
  assert.deepStrictEqual([said.payload.delivery, said.payload.deliverySource], ['pr', 'inferred']);
  assert.match(said.body, /from your words: "ready for review"/);
  // MUST-FIX 1: words never make it merge; the chat's suggestion is labelled, and the note cannot pose as the end state.
  const merge = await offer.prepare({ commitmentId: 31, via: 'factory', task: 'Add retries and merge it when green' });
  assert.strictEqual(merge.payload.delivery, 'draft_pr');
  const fromChat = await offer.prepare({ commitmentId: 31, via: 'factory', delivery: 'auto_merge', suggestedBy: 'the chat', why: 'x\nEnd state: none — nothing is pushed' });
  assert.match(fromChat.body, /^Suggested by the chat — check the end state before you accept\./);
  assert.ok(!/^End state: none/m.test(fromChat.body), 'the planner\'s note never starts a line as the end state');
  assert.match(fromChat.body, /^Planner's note: x End state: none/m);
  assert.strictEqual((fromChat.body.match(/^End state:/gm) || []).length, 1);

  // --- the proposal, then the world changes before the yes ------------------------------
  const row = await offer.propose({ commitmentId: 31, via: 'factory', pipeline: 'solo', models: ['reviewer=deepseek/v4-pro'], dedupeKey: 'offer-run:31' });
  const frozenBrief = row.payload.brief;
  world.commitment = { ...world.commitment, detail: '- something else entirely' };
  apps = [{ app: 'widget', repo: 'acme/widget' }, { app: 'widget-v2', repo: 'acme/widget' }];
  process.env.PA_FACTORY_MODELS = 'dev=changed/model';
  require('../src/config.ts').config.factory.models = 'dev=changed/model';
  require('../src/config.ts').config.factory.pipeline = 'chain';

  const composedBeforeAccept = composeCalls;
  // Accept, unchanged: exactly the card.
  calls.length = 0;
  const r = await proposals.decide(row.id, { accept: true });
  assert.match(r.result, /run #70 sent to the factory \(job widget:050, draft_pr\)/);
  const submit = calls.find((a) => a[3] === 'job' && a[4] === 'submit');
  const val = (flag) => submit[submit.indexOf(flag) + 1];
  assert.deepStrictEqual([val('--app'), val('--pipeline'), val('--delivery')], ['widget', 'solo', 'draft_pr']);
  assert.deepStrictEqual(submit.filter((a) => a.startsWith('--done=')), ['--done=retries tested', '--done=docs updated'], 'not re-derived from the changed commitment');
  assert.deepStrictEqual(submit.filter((_, i) => submit[i - 1] === '--model'), ['dev=azure/gpt-x', 'reviewer=deepseek/v4-pro'], 'frozen models, not today\'s config');
  assert.strictEqual(fs.readFileSync(val('--ask-file'), 'utf8'), frozenBrief, 'the brief sent is byte-for-byte the card\'s');
  assert.strictEqual(composeCalls, composedBeforeAccept, 'not recomposed at accept');
  assert.strictEqual(val('--source'), 'pa');
  assert.match(val('--external-id'), /^[0-9a-f-]{36}-70$/, 'install-scoped key');

  // Accept with the end state changed on the card: that level, the same composed content re-rendered.
  world.commitment = { ...world.commitment, detail: '- retries tested\n- docs updated' };
  const row2 = await offer.propose({ commitmentId: 31, via: 'factory', dedupeKey: 'offer-run:31b' });
  calls.length = 0;
  store.nextRun = 71;
  const r2 = await proposals.decide(row2.id, { accept: true, delivery: 'push-to-main' });
  assert.match(r2.result, /push_to_main/);
  const sub2 = calls.find((a) => a[3] === 'job' && a[4] === 'submit');
  assert.strictEqual(sub2[sub2.indexOf('--delivery') + 1], 'push_to_main');
  const sent2 = fs.readFileSync(sub2[sub2.indexOf('--ask-file') + 1], 'utf8');
  assert.match(sent2, /Delivery: `push_to_main`/);
  assert.match(sent2, /## Goal\n\nRetry the export on transient storage errors\./, 'same composed content');
  assert.strictEqual(sent2, offer.briefAt(row2.payload, 'push_to_main'));
  const runInsert = store.queries.filter((q) => /insert into run/.test(q.sql)).pop();
  assert.deepStrictEqual([runInsert.params[8], runInsert.params[10]], ['push_to_main', 'explicit'], 'recorded as your pick');
  assert.strictEqual(world.proposals.find((p) => p.id === row2.id).answer, 'delivery=push_to_main');
  await assert.rejects(proposals.decide(99, { accept: true, delivery: 'yolo' }), /unknown delivery/);

  // No Claude-session offer any more (D28): --via claude is refused, and plan
  // mode is a read-only factory plan job on claude_session.
  await assert.rejects(offer.prepare({ commitmentId: 31, via: 'claude', delivery: 'pr' }), /no route to pick/);
  const research = await offer.prepare({ commitmentId: 31, mode: 'plan' });
  assert.deepStrictEqual([research.payload.via, research.payload.jobKind, research.payload.runtime, research.payload.delivery], ['factory', 'plan', 'claude_session', 'none']);
  assert.match(research.title, /^Plan in the factory: /);
  assert.match(research.body, /End state: a plan \(read-only\) the factory keeps/);
  // The factory app's delivery.default is the end state when nothing else is said.
  const appsBefore = apps;
  apps = [{ app: 'widget', repo: 'acme/widget', delivery: { default: 'branch' } }];
  await require('../src/dispatch/factory.ts').forgetApps();
  const byApp = await offer.prepare({ commitmentId: 31, useModel: false });
  assert.deepStrictEqual([byApp.payload.delivery, byApp.payload.deliverySource, byApp.payload.mode], ['branch', 'app_default', 'full']);
  apps = appsBefore;
  await require('../src/dispatch/factory.ts').forgetApps();

  // #1 + page token: the dashboard confirms only the level the page showed, with its token.
  {
    const { Readable } = require('stream');
    const server = require('../src/dashboard/server.ts');
    const call = async (method, url, body = null, headers = {}) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      Object.assign(req, { method, url, headers: { host: '127.0.0.1:7300', 'content-type': 'application/json', ...headers } });
      let status = 0;
      let out = '';
      const res = { writeHead(s) { status = s; }, end(b) { out = String(b || ''); }, headersSent: false };
      await server.handle(req, res);
      return { status, body: out.startsWith('{') ? JSON.parse(out) : out };
    };
    // The page carries a fresh token in a meta tag.
    const page = await call('GET', '/');
    const token = /name="pa-page" content="([^"]+)"/.exec(page.body)[1];
    assert.ok(token.length >= 20);
    assert.ok(server.pageTokenOk({ headers: { 'x-pa-page': token } }));
    assert.ok(!server.pageTokenOk({ headers: { 'x-pa-page': 'forged' } }));
    // A repo default of push_to_main, the picker left empty: the page must name it.
    world.commitment = { ...world.commitment, status: 'open' };
    world.repoDefault = 'push_to_main';
    const pre = await call('GET', '/api/commitments/31/delivery');
    assert.deepStrictEqual([pre.body.delivery, pre.body.unattended], ['push_to_main', true], 'the page is told the resolved level');
    calls.length = 0;
    const blind = await call('POST', '/api/commitments/31/dispatch', { via: 'factory' }, { 'x-pa': '1', 'x-pa-page': token });
    assert.deepStrictEqual([blind.status, blind.body.delivery], [409, 'push_to_main'], 'no confirmedLevel: 409 with the level');
    const wrong = await call('POST', '/api/commitments/31/dispatch', { via: 'factory', confirmedLevel: 'auto_merge' }, { 'x-pa': '1', 'x-pa-page': token });
    assert.strictEqual(wrong.status, 409, 'a different level than the resolved one');
    const noToken = await call('POST', '/api/commitments/31/dispatch', { via: 'factory', confirmedLevel: 'push_to_main' }, { 'x-pa': '1' });
    assert.strictEqual(noToken.status, 409, 'X-PA alone (what an agent can send) is not enough');
    assert.ok(!calls.some((a) => a[3] === 'job' && a[4] === 'submit'), 'nothing started');
    store.nextRun = 90;
    const okRun = await call('POST', '/api/commitments/31/dispatch', { via: 'factory', confirmedLevel: 'push_to_main' }, { 'x-pa': '1', 'x-pa-page': token });
    assert.deepStrictEqual([okRun.status, okRun.body.delivery], [200, 'push_to_main']);
    world.repoDefault = null;
    // A repo the factory does not know: a setup step on you, answered with its
    // fix (409 + fix), and sent once the page says register.
    {
      const keep = apps;
      apps = [];
      await factory.forgetApps();
      extra['app add'] = (argv) => {
        apps = [{ app: 'widget', repo: argv[argv.indexOf('--repo') + 1] }];
        return { code: 0, stdout: JSON.stringify({ app: 'widget', repo: argv[argv.indexOf('--repo') + 1] }), stderr: '' };
      };
      calls.length = 0;
      const unreg = await call('POST', '/api/commitments/31/dispatch', { via: 'factory' }, { 'x-pa': '1', 'x-pa-page': token });
      assert.strictEqual(unreg.status, 409);
      assert.match(unreg.body.error, /not registered with the factory/);
      assert.deepStrictEqual(unreg.body.fix, { action: 'register', slug: 'acme/widget', command: 'pa factory add acme/widget' });
      assert.ok(!calls.some((a) => a[3] === 'app' && a[4] === 'add'), 'nothing registered without asking');
      store.nextRun = 91;
      const sent = await call('POST', '/api/commitments/31/dispatch', { via: 'factory', register: true }, { 'x-pa': '1', 'x-pa-page': token });
      assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
      assert.ok(calls.some((a) => a[3] === 'app' && a[4] === 'add'), 'registered, then sent');
      delete extra['app add'];
      apps = keep;
      await factory.forgetApps();
    }
    // Accepting an unattended card needs the token too.
    const card = await proposals.create({ kind: 'dispatch', commitmentId: 31, title: 'card', payload: { frozen: true, via: 'claude', delivery: 'auto_merge', mode: 'mr' }, dedupeKey: 'tok-card' });
    const refused = await call('POST', `/api/proposals/${card.id}/accept`, {}, { 'x-pa': '1' });
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.error, /page's token/);
    assert.strictEqual(card.status, 'pending');
  }

  // PA_DISPATCHED_RUN: inside a run, `pa do` refuses an unattended level outright (no card either).
  {
    const { commands } = require('../src/cli/index.ts');
    process.env.PA_DISPATCHED_RUN = '55';
    const errs = [];
    const ew = process.stderr.write.bind(process.stderr);
    const ow = process.stdout.write.bind(process.stdout);
    process.stderr.write = (t) => { errs.push(String(t)); return true; };
    process.stdout.write = () => true;
    const before = world.proposals.length;
    try {
      await commands.do(['31'], { via: 'factory', delivery: 'auto_merge' }, {});
    } finally {
      process.stderr.write = ew;
      process.stdout.write = ow;
      process.exitCode = 0;
      delete process.env.PA_DISPATCHED_RUN;
    }
    assert.match(errs.join(''), /refused: run #55's agent may not start work that merges/);
    assert.strictEqual(world.proposals.length, before, 'no card made from inside a run');
  }

  // An older card whose repo is no longer a known project: a clear error with the way out;
  // a card made now carries repoVerifiedAt and is not re-judged at accept.
  {
    const old = await proposals.create({ kind: 'dispatch', commitmentId: 31, title: 'old card', payload: { via: 'claude', mode: 'local', repoPath: '/gone/repo' } });
    global.__unknownRepos = ['/gone/repo'];
    await assert.rejects(proposals.decide(old.id, { accept: true }), /not a known project — decline it and offer it again.*pa projects sync/);
    global.__unknownRepos = [];
    const fresh = await offer.prepare({ commitmentId: 31, delivery: 'pr', useModel: false });
    assert.ok(fresh.payload.repoVerifiedAt === null || typeof fresh.payload.repoVerifiedAt === 'string');
    global.__unknownRepos = ['/x'];
    await assert.rejects(offer.prepare({ commitmentId: 31, repoPath: '/x', useModel: false }), /not a known project's repo/);
    global.__unknownRepos = [];
  }

  // #8: `review` through the read-only tool (PA_READ_ONLY=1) asks the factory and writes nothing.
  {
    const dispatch = require('../src/dispatch');
    world.runRow = { id: 81, route: 'factory', status: 'waiting', factory_state: 'submit_unknown', factory_job_id: null, external_id: 'k-81', started_at: new Date(0).toISOString(), machine: os.hostname() };
    process.env.PA_READ_ONLY = '1';
    calls.length = 0;
    const writes = store.queries.length;
    await dispatch.review(81);
    assert.strictEqual(calls.length, 0, 'no settle');
    assert.ok(!store.queries.slice(writes).some((q) => /^\s*update /.test(q.sql)), 'no writes');
    world.runRow = { id: 82, route: 'factory', status: 'running', factory_job_id: 'widget:082', machine: os.hostname() };
    extra['job status'] = () => ({ code: 0, stdout: JSON.stringify({ job_id: 'widget:082', source: 'pa', state: 'done', terminal: true, delivery: 'pr' }), stderr: '' });
    const r = await dispatch.review(82);
    assert.strictEqual(r.factory.state, 'done');
    assert.ok(!store.queries.slice(writes).some((q) => /^\s*update /.test(q.sql)), 'status read, not applied');
    delete extra['job status'];
    delete process.env.PA_READ_ONLY;
  }

  // MUST-FIX 14: `pa drop` on a submit whose answer was lost settles it first.
  {
    const dispatch = require('../src/dispatch');
    const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-80';
    const unsettled = () => ({ id: 80, route: 'factory', status: 'waiting', factory_state: 'submit_unknown', factory_job_id: null, external_id: KEY, started_at: new Date().toISOString(), commitment_id: 31, machine: os.hostname() });
    const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
    // The factory has the job: adopted, then cancelled — never orphaned.
    world.runRow = unsettled();
    calls.length = 0;
    extra['job list'] = () => ok({ jobs: [{ job_id: 'widget:080', source: 'pa', external_id: KEY, state: 'queued' }] });
    extra['job cancel'] = () => ok({ job_id: 'widget:080', state: 'cancelled', stories_parked: [] });
    const d = await dispatch.drop(80);
    assert.deepStrictEqual([d.cancelled, d.jobId], [true, 'widget:080']);
    assert.ok(calls.some((a) => a.slice(3).join(' ') === 'job cancel widget:080 --json'));
    // The factory cannot be asked: the drop is refused.
    world.runRow = unsettled();
    extra['job list'] = () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(dispatch.drop(80), /cannot be asked now/);
    // #14a: asked, no job yet, but too soon to believe it: still refused.
    world.runRow = unsettled();
    extra['job list'] = () => ok({ jobs: [] });
    await assert.rejects(dispatch.drop(80), /still unconfirmed.*try again in a few minutes/);
    // Asked, and past the grace with no job: dropped with nothing to cancel.
    world.runRow = { ...unsettled(), started_at: new Date(Date.now() - 3600_000).toISOString() };
    calls.length = 0;
    extra['job list'] = () => ok({ jobs: [] });
    const none = await dispatch.drop(80);
    assert.strictEqual(none.cancelled, false);
    assert.ok(!calls.some((a) => a[4] === 'cancel'));
    delete extra['job list'];
    delete extra['job cancel'];
  }

  // MUST-FIX 1: from the chat (no terminal), an unattended end state is a card, never a start.
  {
    const { commands } = require('../src/cli/index.ts');
    const outs = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (t) => { outs.push(String(t)); return true; };
    process.env.PA_CHAT_SESSION = '1';
    calls.length = 0;
    world.commitment = { ...world.commitment, status: 'open' };
    const before = world.proposals.length;
    try {
      await commands.do(['31'], { via: 'factory', delivery: 'push_to_main' }, {});
    } finally {
      process.stdout.write = write;
    }
    const text = outs.join('');
    assert.match(text, /^end state: push_to_main — Will push straight to main/m, 'shown before anything happens');
    assert.match(text, /NOT started: put on a card/);
    assert.ok(!calls.some((a) => a[3] === 'job' && a[4] === 'submit'), 'nothing submitted');
    const card = world.proposals[world.proposals.length - 1];
    assert.strictEqual(world.proposals.length, before + 1);
    assert.deepStrictEqual([card.payload.delivery, card.payload.suggestedBy], ['push_to_main', 'the chat']);
    assert.match(card.body, /^Suggested by the chat/);
    // …and the chat cannot accept it either.
    const errs = [];
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (t) => { errs.push(String(t)); return true; };
    try {
      await commands.answer([String(card.id), 'yes'], {});
    } finally {
      process.stderr.write = ew;
      process.exitCode = 0;
    }
    assert.match(errs.join(''), /accept it in the dashboard or from a terminal/);
    assert.strictEqual(card.status, 'pending');
    delete process.env.PA_CHAT_SESSION;
  }

  // `pa propose` / `--preview` compose before anyone said yes: under the daily budget.
  assert.ok(require('../src/config.ts').config.budget.discretionary.includes('propose'));
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'index.ts'), 'utf8');
  const prop = cli.slice(cli.indexOf('async propose('), cli.indexOf('async delivery('));
  assert.ok(prop.indexOf("allow('propose')") > 0 && prop.indexOf("allow('propose')") < prop.indexOf('.propose(o)'), 'budget asked before the card is composed');
  const noModel = await offer.prepare({ commitmentId: 31, via: 'factory', useModel: false });
  assert.strictEqual(noModel.payload.briefBy, 'compose:fallback');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('offer ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
