'use strict';

// The CLI backend's contract: isolated from the user's settings, tools off
// unless named, and failures surfaced as errors rather than as reply text.

const assert = require('assert');
const { cliArgs, parseCliOutput, extractJson } = require('../src/llm');

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

console.log('llm ok');
