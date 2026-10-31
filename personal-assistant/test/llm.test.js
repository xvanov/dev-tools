'use strict';

// The CLI backend's contract: isolated from the user's settings, tools off
// unless named, and failures surfaced as errors rather than as reply text.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../src/config');
const { cliArgs, parseCliOutput, extractJson, childEnv, cliAccount } = require('../src/llm');

{
  const args = cliArgs({ system: 'S', effort: 'low', tools: null });
  assert.ok(args.includes('-p'));
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.ok(args.includes('--no-session-persistence'));
  assert.strictEqual(args[args.indexOf('--tools') + 1], '');
  assert.strictEqual(args[args.indexOf('--system-prompt') + 1], 'S');
  assert.ok(!args.includes('--allowedTools'));
  // A model-only call starts no MCP servers.
  assert.ok(args.includes('--strict-mcp-config'));
}

{
  const args = cliArgs({ system: null, effort: 'low', tools: ['mcp__a__b', 'mcp__a__c'] });
  assert.strictEqual(args[args.indexOf('--allowedTools') + 1], 'mcp__a__b,mcp__a__c');
  assert.ok(!args.includes('--tools'));
  // A connector call needs its connectors.
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--system-prompt'));
}

{
  // A per-call model goes to --model; without one, the configured default does.
  const { config } = require('../src/config');
  const def = cliArgs({ system: null, effort: 'low', tools: null });
  assert.strictEqual(def[def.indexOf('--model') + 1], config.anthropic.model);
  const cheap = cliArgs({ system: null, effort: 'low', tools: null, model: 'claude-haiku-5-5' });
  assert.strictEqual(cheap[cheap.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.strictEqual(cheap.filter((a) => a === '--model').length, 1);
}

{
  const ok = JSON.stringify({ subtype: 'success', is_error: false, result: 'hello' });
  assert.strictEqual(parseCliOutput({ code: 0, out: ok, err: '' }), 'hello');
  const bad = JSON.stringify({ subtype: 'error_max_turns', is_error: true, result: 'nope' });
  assert.throws(() => parseCliOutput({ code: 1, out: bad, err: '' }), /claude -p failed/);
  assert.throws(() => parseCliOutput({ code: 1, out: 'not json', err: 'boom' }), /exited 1: boom/);
}

{
  assert.deepStrictEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('[1,2]'), [1, 2]);
  assert.deepStrictEqual(extractJson('sure {"x":{"y":2}} done'), { x: { y: 2 } });
  assert.throws(() => extractJson('nothing'), /no JSON/);
}

// pa's own login: CLAUDE_CONFIG_DIR goes to the child only, and per-call env
// still layers on top.
{
  const saved = config.claudeConfigDir;
  const base = { PATH: 'p', CLAUDE_CONFIG_DIR: 'from-shell' };
  try {
    config.claudeConfigDir = '';
    assert.strictEqual(childEnv(null, base), base);
    assert.strictEqual(childEnv({ X: '1' }, base).CLAUDE_CONFIG_DIR, 'from-shell');
    config.claudeConfigDir = 'C:\pa-login';
    const e = childEnv({ MAX_MCP_OUTPUT_TOKENS: '9' }, base);
    assert.strictEqual(e.CLAUDE_CONFIG_DIR, 'C:\pa-login');
    assert.strictEqual(e.MAX_MCP_OUTPUT_TOKENS, '9');
    assert.strictEqual(e.PATH, 'p');
    assert.strictEqual(base.CLAUDE_CONFIG_DIR, 'from-shell');
  } finally {
    config.claudeConfigDir = saved;
  }
}

// Who that login is, read from the folder's own .claude.json.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-login-'));
  assert.strictEqual(cliAccount(dir).email, null);
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } }));
  const a = cliAccount(dir);
  assert.deepStrictEqual([a.email, a.org, a.custom, a.dir], ['a@b.c', 'Org', true, dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('llm ok');
