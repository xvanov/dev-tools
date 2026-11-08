'use strict';

// Plan 4.3: the policy engine (src/policy). Pure evaluation against the tracked
// default and merged overrides, the voice restrictions, parity with the chat's
// allow/ask split, the enforce/authorize wiring to the audit log, and the
// hash chain's tamper detection on an in-memory log. (The same chain on a real
// database: test/contract/audit.contract.js.)

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const P = require('../src/policy');
const { hashEntry, GENESIS } = require('../src/repo/audit');

const base = JSON.parse(fs.readFileSync(P.DEFAULT_FILE, 'utf8'));
const policy = P.merge(base, null);
const ev = (req, pol = policy) => P.evaluate({ action: 'call', channel: 'chat', ...req }, pol);

// ---- the default policy is the chat's existing allow/ask split ----
{
  const server = require('../src/mcp/server');
  const chat = require('../src/chat');
  const listed = server.listedTools({ PA_MCP_CHAT_TOOLS: '1' }).map((t) => t.name);
  const allow = chat.settingsJson().permissions.allow.filter((r) => r.startsWith('mcp__pa-chat__')).map((r) => r.slice('mcp__pa-chat__'.length));
  for (const t of listed) {
    const want = chat.CHAT_ACTION_TOOLS.includes(t) ? 'ask' : 'allow';
    assert.strictEqual(ev({ tool: t }).decision, want, `${t} must be ${want} by default`);
  }
  for (const t of chat.CHAT_READ_TOOLS) assert.ok(allow.includes(t) && ev({ tool: t }).decision === 'allow', `${t}: read tool allowed by both`);
  for (const t of chat.CHAT_ACTION_TOOLS) {
    assert.ok(!allow.includes(t));
    assert.strictEqual(ev({ tool: t }).decision, 'ask');
    // answering the prompt for it is accepted from the user's own channels
    for (const channel of ['dashboard', 'termhub', 'cli']) assert.strictEqual(ev({ tool: t, action: 'approve', channel }).decision, 'allow', `${t} approve via ${channel}`);
  }
}

// built-in tools: only the reads, only from the chat; edits and shell commands ask
for (const t of ['Read', 'Grep', 'Glob']) assert.strictEqual(ev({ tool: t }).decision, 'allow');
assert.strictEqual(ev({ tool: 'Read', channel: 'mcp' }).decision, 'ask');
for (const t of ['Bash', 'Edit', 'Write']) assert.strictEqual(ev({ tool: t }).decision, 'ask');

// ---- unknown things ask; first match wins; globs ----
assert.strictEqual(ev({ tool: 'brand_new_tool' }).decision, 'ask');
assert.strictEqual(ev({ tool: 'brand_new_tool' }).rule, 'default');
{
  const p = P.merge(base, { rules: [{ id: 'x', tools: ['brand_*'], decision: 'allow' }] });
  assert.strictEqual(ev({ tool: 'brand_new_tool' }, p).decision, 'allow');
  assert.strictEqual(ev({ tool: 'other' }, p).decision, 'ask');
}

// ---- an override can tighten and loosen defaults, replace the fallback, but not the locks ----
{
  const tighter = P.merge(base, { rules: [{ id: 'no-recall-from-mcp', tools: ['recall'], channels: ['mcp'], decision: 'deny', reason: 'this stack keeps recall to the chat' }] });
  assert.strictEqual(ev({ tool: 'recall', channel: 'mcp' }, tighter).decision, 'deny');
  assert.strictEqual(ev({ tool: 'recall', channel: 'chat' }, tighter).decision, 'allow', 'other channels keep the default');
  const looser = P.merge(base, { rules: [{ id: 'trust-start', tools: ['factory_start'], decision: 'allow' }], default: 'deny' });
  assert.strictEqual(ev({ tool: 'factory_start' }, looser).decision, 'allow');
  assert.strictEqual(ev({ tool: 'unlisted' }, looser).decision, 'deny');
  const tryUnlock = P.merge(base, { locked: [], rules: [{ id: 'let-voice-merge', tools: ['*'], channels: ['voice'], decision: 'allow' }] });
  const r = ev({ tool: 'factory_start', channel: 'voice', args: { delivery: 'auto_merge' } }, tryUnlock);
  assert.strictEqual(r.decision, 'deny', 'an override cannot loosen a locked rule');
  assert.strictEqual(r.rule, 'voice-never-approves-sensitive');
}

// ---- bad policy files fail loudly ----
assert.throws(() => P.merge(base, { rules: [{ id: 'bad', decision: 'maybe' }] }), /decision "maybe"/);
assert.throws(() => P.merge(base, { rules: [{ decision: 'allow' }] }), /no id/);
assert.throws(() => P.merge(base, { rules: [{ id: 'b', tools: 'recall', decision: 'allow' }] }), /list of strings/);
assert.throws(() => P.merge(base, { default: 'yes' }), /default/);
assert.throws(() => P.merge({ ...base, locked: [{ id: 'l', decision: 'allow' }] }, null), /must deny/);

// ---- classification ----
assert.deepStrictEqual(P.classify('factory_start', { delivery: 'auto_merge' }), ['merge']);
assert.deepStrictEqual(P.classify('factory_start', { delivery: 'push_to_main' }), ['push_main']);
assert.deepStrictEqual(P.classify('factory_start', { delivery: 'pr' }), []);
assert.deepStrictEqual(P.classify('merge_pr'), ['merge']);
assert.deepStrictEqual(P.classify('secret_reveal'), ['secret_reveal']);
assert.deepStrictEqual(P.classify('pa', { command: 'secret', args: ['reveal', 'GH_TOKEN'] }), ['secret_reveal']);
assert.deepStrictEqual(P.classify('pa', { command: 'secret', args: ['list'] }), []);
assert.deepStrictEqual(P.classify('pa', { command: 'answer', args: ['12', 'yes', '--delivery', 'push_to_main'] }), ['push_main']);
assert.deepStrictEqual(P.classify('secret_status'), [], 'secret_status shows no value');
assert.deepStrictEqual(P.classify('request_secret'), []);

// ---- voice restrictions: merges, pushes to main, secret reveals, whatever the action ----
for (const action of ['call', 'approve']) {
  for (const [tool, args] of [
    ['factory_start', { delivery: 'auto_merge' }],
    ['factory_start', { delivery: 'push_to_main' }],
    ['merge_pr', {}],
    ['pa', { command: 'secret', args: ['reveal', 'X'] }],
    ['secret_reveal', {}],
  ]) {
    const r = ev({ tool, args, action, channel: 'voice' });
    assert.strictEqual(r.decision, 'deny', `voice ${action} ${tool} ${JSON.stringify(args)}`);
    assert.strictEqual(r.rule, 'voice-never-approves-sensitive');
    assert.ok(r.reason);
  }
}
// ...but not everything: voice still approves an ordinary chat action, and the same sensitive call
// from the dashboard is not denied by the voice lock.
assert.strictEqual(ev({ tool: 'factory_start', action: 'approve', channel: 'voice' }).decision, 'allow');
assert.notStrictEqual(ev({ tool: 'factory_start', args: { delivery: 'auto_merge' }, action: 'approve', channel: 'dashboard' }).decision, 'deny');

// ---- authorize and enforce write every decision, and enforce refuses a deny ----
function memoryRepo() {
  const rows = [];
  return {
    rows,
    audit: {
      async append(e) {
        const prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
        const row = { seq: rows.length + 1, at: new Date().toISOString(), channel: e.channel, actor: e.actor, action: e.action, tool: e.tool, decision: e.decision, rule: e.rule, reason: e.reason, subject: e.subject, args_hash: e.argsHash, prev_hash: prev };
        row.hash = hashEntry(row, prev);
        rows.push(row);
        return row;
      },
    },
  };
}

(async () => {
  const repo = memoryRepo();
  // authorize/enforce read the loaded policy: the tracked default (no override file in the test env)
  process.env.PA_POLICY_FILE = require('path').join(require('os').tmpdir(), `pa-no-policy-${process.pid}.json`);
  P.load({ reload: true });

  const a = await P.authorize({ tool: 'recall', channel: 'mcp', args: { question: 'secret plans' } }, { repo });
  assert.strictEqual(a.decision, 'allow');
  const b = await P.authorize({ tool: 'factory_start', channel: 'chat', args: { card: '412', delivery: 'pr' } }, { repo });
  assert.strictEqual(b.decision, 'ask');
  await assert.rejects(
    () => P.enforce({ tool: 'factory_start', action: 'approve', channel: 'voice', args: { delivery: 'auto_merge' }, subject: 'tu_1' }, { repo }),
    (err) => err.code === 'POLICY_DENIED' && /voice-never-approves-sensitive/.test(err.message)
  );
  assert.deepStrictEqual(repo.rows.map((r) => r.decision), ['allow', 'ask', 'deny'], 'every decision is written, denials included');
  assert.strictEqual(repo.rows[1].subject, '412');
  assert.strictEqual(repo.rows[0].args_hash, crypto.createHash('sha256').update(JSON.stringify({ question: 'secret plans' })).digest('hex'));
  assert.ok(!JSON.stringify(repo.rows).includes('secret plans'), 'arguments are hashed, never stored');

  // an audit store that fails does not turn an allowed call into an error
  const broken = { audit: { append: async () => { throw new Error('db down'); } } };
  assert.strictEqual((await P.authorize({ tool: 'recall', channel: 'mcp' }, { repo: broken })).decision, 'allow');
  assert.strictEqual((await P.enforce({ tool: 'recall', channel: 'mcp' }, { repo: broken })).decision, 'allow');
  await assert.rejects(() => P.enforce({ tool: 'merge_pr', channel: 'voice' }, { repo: broken }), /denied by policy/);

  // ---- chain verification and tamper detection (the same walk as repo.audit.verify) ----
  const verify = (rows) => {
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev) return { ok: false, seq: r.seq, why: 'link' };
      if (hashEntry(r, prev) !== r.hash) return { ok: false, seq: r.seq, why: 'hash' };
      prev = r.hash;
    }
    return { ok: true };
  };
  for (let i = 0; i < 4; i++) await P.authorize({ tool: 'board', channel: 'chat' }, { repo });
  assert.strictEqual(repo.rows.length, 7);
  assert.deepStrictEqual(verify(repo.rows), { ok: true });
  assert.strictEqual(repo.rows[0].prev_hash, GENESIS);
  for (let i = 1; i < repo.rows.length; i++) assert.strictEqual(repo.rows[i].prev_hash, repo.rows[i - 1].hash);

  const copy = () => repo.rows.map((r) => ({ ...r }));
  let t = copy();
  t[2].decision = 'allow'; // the denial rewritten
  assert.deepStrictEqual(verify(t), { ok: false, seq: 3, why: 'hash' });
  t = copy();
  t.splice(3, 1); // a row dropped
  assert.deepStrictEqual(verify(t), { ok: false, seq: 5, why: 'link' });
  t = copy();
  [t[3], t[4]] = [t[4], t[3]]; // reordered
  assert.strictEqual(verify(t).ok, false);
  t = copy();
  t[2].decision = 'allow';
  t[2].hash = hashEntry(t[2], t[2].prev_hash); // edited and re-hashed: the next row no longer links
  assert.deepStrictEqual(verify(t), { ok: false, seq: 4, why: 'link' });
  t = copy();
  t[1].at = new Date(Date.now() - 86400000).toISOString(); // a timestamp moved
  assert.strictEqual(verify(t).ok, false);

  // ---- voice approving a factory job is judged by the job's delivery; lookup failure fails closed ----
  const jobs = { 'app:0001': { delivery: 'auto_merge' }, 'app:0002': { delivery: 'push_to_main' }, 'app:0003': { delivery: 'pr' }, 'app:0004': {} };
  const lookup = async (id) => jobs[id] || null;
  const voice = (tool, job, extra = {}) => ({ tool, action: 'approve', channel: 'voice', subject: 'tu_9', args: job === undefined ? {} : { job }, ...extra });
  for (const tool of P.JOB_TOOLS) {
    await assert.rejects(async () => P.enforce(await P.withJobDelivery(voice(tool, 'app:0001'), lookup), { repo }), /voice-never-approves-sensitive/, `${tool} on an auto_merge job`);
    await assert.rejects(async () => P.enforce(await P.withJobDelivery(voice(tool, 'app:0002'), lookup), { repo }), /voice-never-approves-sensitive/, `${tool} on a push_to_main job`);
    for (const ok of ['app:0003', 'app:0004']) {
      assert.strictEqual((await P.enforce(await P.withJobDelivery(voice(tool, ok), lookup), { repo })).decision, 'allow', `${tool} on ${ok}`);
    }
    // fail closed: job unknown, no job named, lookup throws
    for (const [label, req, lk] of [['unknown job', voice(tool, 'app:9999'), lookup], ['no job', voice(tool), lookup], ['lookup error', voice(tool, 'app:0003'), async () => { throw new Error('factory down'); }]]) {
      const r = await P.withJobDelivery(req, lk);
      assert.strictEqual(P.evaluate(r).decision, 'deny', `${tool} ${label} is denied for voice`);
      assert.strictEqual(P.evaluate(r).rule, 'voice-never-approves-sensitive');
    }
  }
  // other channels and tools are not looked up and not blocked by it
  let looked = 0;
  const counting = async () => { looked++; return null; };
  const dash = await P.withJobDelivery({ tool: 'factory_approve', action: 'approve', channel: 'dashboard', args: { job: 'app:0001' } }, counting);
  assert.strictEqual(P.evaluate(dash).decision, 'allow', 'the dashboard may approve even when the job is not found');
  assert.strictEqual(looked, 1, 'the dashboard approval is looked up so it is tagged');
  const dashMerge = await P.withJobDelivery({ tool: 'factory_approve', action: 'approve', channel: 'dashboard', args: { job: 'app:0001' } }, lookup);
  assert.deepStrictEqual(P.evaluate(dashMerge).tags, ['merge']);
  assert.strictEqual(P.evaluate(dashMerge).decision, 'allow');
  await P.withJobDelivery({ tool: 'factory_start', action: 'approve', channel: 'voice', args: {} }, counting);
  await P.withJobDelivery({ tool: 'factory_approve', action: 'approve', channel: 'cli', args: { job: 'x' } }, counting);
  assert.strictEqual(looked, 1, 'other tools and channels are not looked up');
  assert.strictEqual(P.evaluate({ tool: 'factory_approve', action: 'approve', channel: 'dashboard', args: { job: 'x', delivery_unknown: true } }).decision, 'allow', 'unverified only bars voice');
  // a spoofed args.delivery from the request is replaced by the looked-up one
  const spoof = await P.withJobDelivery(voice('factory_approve', 'app:0001', { args: { job: 'app:0001', delivery: 'pr' } }), lookup);
  assert.strictEqual(spoof.args.delivery, 'auto_merge');

  // ---- passkey step-up (7.1): ask until a grant for this approval id exists; voice stays denied first ----
  {
    const grants = new Set();
    const consumed = [];
    const mk = (on) => ({
      requiresStepUp: (k) => on && ['merge', 'push_main', 'secret_reveal'].includes(k),
      hasStepUp: async (id, o = {}) => {
        if (o.consume) { consumed.push(id); return { ok: grants.delete(id) }; }
        return { ok: grants.has(id) };
      },
    });
    const on = mk(true);
    const merge = { tool: 'factory_approve', action: 'approve', channel: 'dashboard', subject: 'app:0001', args: { job: 'app:0001', delivery: 'auto_merge' } };
    const rows0 = repo.rows.length;
    const r1 = await P.authorize(merge, { repo, stepup: on });
    assert.deepStrictEqual([r1.decision, r1.rule], ['ask', 'stepup-required'], 'no grant: ask');
    assert.strictEqual(repo.rows[rows0].decision, 'ask');
    assert.match(repo.rows[rows0].reason, /passkey/);
    await assert.rejects(() => P.enforce(merge, { repo, stepup: on }), (e) => e.code === 'STEPUP_REQUIRED' && e.status === 403 && e.approvalId === 'app:0001', 'enforce refuses until tapped');
    grants.add('app:0001');
    assert.strictEqual((await P.authorize(merge, { repo, stepup: on })).decision, 'allow', 'a grant for this id: allowed');
    assert.strictEqual(consumed.length, 0, 'looking does not spend the grant');
    const res = await P.enforce(merge, { repo, stepup: on });
    assert.strictEqual(await P.consumeStepUp(merge, res, { stepup: on }), true);
    assert.deepStrictEqual(consumed, ['app:0001']);
    await assert.rejects(() => P.enforce(merge, { repo, stepup: on }), /passkey/, 'one use');
    grants.add('other');
    await assert.rejects(() => P.enforce({ ...merge, subject: 'app:0002' }, { repo, stepup: on }), /passkey/, 'bound to the exact id');
    // not for other tags, other actions, other tools
    assert.strictEqual((await P.authorize({ ...merge, args: { delivery: 'pr' } }, { repo, stepup: on })).decision, 'allow');
    assert.strictEqual((await P.authorize({ ...merge, action: 'deny' }, { repo, stepup: on })).rule !== 'stepup-required', true);
    assert.strictEqual(await P.consumeStepUp({ ...merge, args: { delivery: 'pr' } }, { tags: [] }, { stepup: on }), false);
    // off: nothing changes
    assert.strictEqual((await P.authorize(merge, { repo, stepup: mk(false) })).decision, 'allow');
    // opted out for the chat path (its prompt was the gate)
    assert.strictEqual((await P.authorize(merge, { repo, stepup: on, stepUp: false })).decision, 'allow');
    // voice stays denied first, grant or no grant
    grants.add('app:0001');
    const v = await P.authorize({ ...merge, channel: 'voice' }, { repo, stepup: on });
    assert.deepStrictEqual([v.decision, v.rule], ['deny', 'voice-never-approves-sensitive']);
    // an unreadable grant store is a refusal, not a pass
    const bad = { requiresStepUp: () => true, hasStepUp: async () => { throw new Error('db down'); } };
    assert.strictEqual((await P.authorize(merge, { repo, stepup: bad })).rule, 'stepup-required');
  }

  console.log('policy: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
