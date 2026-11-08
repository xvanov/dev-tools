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

  console.log('policy: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
