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

// ---- streaming (llm.stream): SSE parsing, chunks, and a fake compatible server ----
{
  const { sseData, compatChunk, cliStreamLine, compatRequest } = require('../src/llm');
  const a = sseData('data: {"a":1}\n\ndata: {"b"');
  assert.deepStrictEqual(a.data, ['{"a":1}']);
  assert.strictEqual(a.rest, 'data: {"b"');
  assert.deepStrictEqual(sseData('data: x\r\n\r\n: comment\n\ndata: [DONE]\n\n').data, ['x', '[DONE]']);
  assert.deepStrictEqual(compatChunk('local/m', { choices: [{ delta: { content: 'Hi' } }] }), { text: 'Hi', usage: null });
  assert.match(compatChunk('local/m', { choices: [{ delta: {}, finish_reason: 'content_filter' }] }).error, /content_filter/);
  assert.strictEqual(compatChunk('local/m', { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }).usage.outputTokens, 2);
  assert.deepStrictEqual(cliStreamLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'yo' } } })), { text: 'yo' });
  assert.ok(cliStreamLine(JSON.stringify({ type: 'result', subtype: 'success' })).final);
  assert.strictEqual(cliStreamLine('not json'), null);
  const req = compatRequest({ provider: 'azure', model: 'pa', prompt: 'p', maxTokens: 10, key: 'k', stream: true, reasoningEffort: 'low', providers: { azure: { endpoint: 'https://x.openai.azure.com', apiVersion: 'v1' } } });
  assert.strictEqual(req.body.stream, true);
  assert.deepStrictEqual(req.body.stream_options, { include_usage: true });
  assert.strictEqual(req.body.reasoning_effort, 'low', 'said outright, whatever the deployment is called');
  assert.ok(!('stream' in compatRequest({ provider: 'local', model: 'm', prompt: 'p', maxTokens: 1, providers: { local: { baseUrl: 'http://l' } } }).body));
}

(async () => {
  const http = require('http');
  const llm = require('../src/llm');
  const budget = require('../src/budget');
  const recorded = [];
  budget.record = async (row) => recorded.push(row); // never the real store
  let seen = null;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = ['Hel', 'lo', ' there.'].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`, 'data: [DONE]\n\n');
      // Split mid-event, as a network would.
      const all = chunks.join('');
      res.write(all.slice(0, 17));
      setTimeout(() => res.end(all.slice(17)), 20);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  config.providers.local.baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  const pieces = [];
  for await (const p of llm.stream({ prompt: 'hi', model: 'local/tiny', purpose: 'fast-lane' })) pieces.push(p);
  assert.deepStrictEqual(pieces, ['Hel', 'lo', ' there.']);
  assert.strictEqual(seen.stream, true);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].purpose, 'fast-lane');
  assert.strictEqual(recorded[0].ok, true);
  assert.strictEqual(recorded[0].outputTokens, 3);
  // Abandoned by the caller: still recorded once.
  for await (const p of llm.stream({ prompt: 'hi', model: 'local/tiny', purpose: 'fast-lane' })) {
    assert.strictEqual(p, 'Hel');
    break;
  }
  assert.strictEqual(recorded.length, 2);
  srv.close();
  console.log('llm ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
