'use strict';

// Model strings, backend routing, capability refusal and cost accounting
// (src/models.js, src/llm.js). No model is called: fetch is stubbed.

const assert = require('assert');

// llm_spend rows land in a stub, not Postgres.
const recorded = [];
require.cache[require.resolve('../src/budget.ts')] = {
  id: require.resolve('../src/budget.ts'),
  filename: require.resolve('../src/budget.ts'),
  loaded: true,
  exports: { record: async (row) => recorded.push(row) },
};

const { config } = require('../src/config.ts');
const models = require('../src/models.ts');
const llm = require('../src/llm');

// ------------------------------------------------------------ parsing ----

{
  assert.deepStrictEqual(models.parseModel('claude-sonnet-5-5'), { raw: 'claude-sonnet-5-5', provider: 'auto', model: 'claude-sonnet-5-5' });
  assert.deepStrictEqual(models.parseModel(' azure/gpt-5.4 '), { raw: 'azure/gpt-5.4', provider: 'azure', model: 'gpt-5.4' });
  assert.deepStrictEqual(models.parseModel('cli/claude-opus-5').model, 'claude-opus-5');
  // Only the first segment is the provider.
  const or = models.parseModel('openrouter/deepseek/deepseek-v4-pro');
  assert.strictEqual(or.provider, 'openrouter');
  assert.strictEqual(or.model, 'deepseek/deepseek-v4-pro');
  assert.strictEqual(models.parseModel('Anthropic/claude-opus-5').provider, 'anthropic');
  assert.strictEqual(models.parseModel('local/qwen3:32b').model, 'qwen3:32b');
  // A typo is an error, never a bare name passed to claude -p.
  assert.throws(() => models.parseModel('azur/gpt-5.4'), /unknown provider "azur"/);
  assert.throws(() => models.parseModel('azure/'), /no model/);
  assert.throws(() => models.parseModel(''), /empty/);
}

// ------------------------------------------------------------ routing ----

{
  // Bare keeps today's meaning: api with a key, cli without, cli for tools.
  assert.strictEqual(models.route('claude-opus-5', { hasAnthropicKey: true }).backend, 'api');
  assert.strictEqual(models.route('claude-opus-5', { hasAnthropicKey: false }).backend, 'cli');
  assert.strictEqual(models.route('claude-opus-5', { hasAnthropicKey: true, needs: 'toolCalls' }).backend, 'cli');
  assert.strictEqual(models.route('anthropic/claude-opus-5', { hasAnthropicKey: false }).backend, 'api');
  assert.strictEqual(models.route('cli/claude-opus-5', { hasAnthropicKey: true }).backend, 'cli');
  for (const p of ['azure', 'openai', 'openrouter', 'deepseek', 'local']) {
    assert.strictEqual(models.route(`${p}/m`).backend, p);
  }
}

// ------------------------------------------------- capability refusal ----

{
  for (const bad of ['azure/gpt-5.4', 'anthropic/claude-opus-5', 'openrouter/anthropic/claude-opus-5', 'local/llama']) {
    assert.throws(
      () => models.route(bad, { needs: 'toolCalls', envName: 'PA_CONNECTOR_MODEL' }),
      /PA_CONNECTOR_MODEL=.* cannot make connector tool calls/,
      `${bad} must be refused for connector calls`
    );
  }
  assert.deepStrictEqual(models.capabilities('cli'), ['text', 'json', 'toolCalls']);
  assert.deepStrictEqual(models.capabilities('azure'), ['text', 'json']);
  assert.ok(models.PURPOSES.find((p) => p.key === 'connector').needs === 'toolCalls');
  // Only the connector relay needs Claude Code.
  assert.deepStrictEqual(models.PURPOSES.filter((p) => p.needs === 'toolCalls').map((p) => p.key), ['connector']);
}

// -------------------------------------------------------- doctor rows ----

{
  const c = JSON.parse(JSON.stringify(config));
  c.anthropic.apiKey = null;
  c.embeddings.apiKey = null;
  c.providers.azure.endpoint = 'https://x.openai.azure.com';
  c.m365.connectorModel = 'azure/gpt-5.4';
  c.reconcile.model = 'azure/gpt-5.4';
  c.planner.model = 'openrouter/qwen/qwen3';
  c.memory.pageModel = 'nope/x';
  const read = (name) => (name === 'AZURE_OPENAI_API_KEY' ? 'k' : null);
  const rows = Object.fromEntries(models.report({ c, read, claudeAvailable: true }).map((r) => [r.purpose, r]));
  assert.strictEqual(rows.connector.capable, false);
  assert.strictEqual(rows.connector.ok, false);
  assert.match(rows.connector.problem, /connector tool calls/);
  assert.strictEqual(rows.reconcile.ok, true);
  assert.strictEqual(rows.reconcile.backend, 'azure');
  assert.strictEqual(rows.reconcile.keyConfigured, true);
  assert.strictEqual(rows.planner.ok, false);
  assert.match(rows.planner.problem, /OPENROUTER_API_KEY/);
  assert.strictEqual(rows['memory-page'].ok, false);
  assert.match(rows['memory-page'].problem, /unknown provider/);
  assert.strictEqual(rows.distill.backend, 'cli');
  const noClaude = Object.fromEntries(models.report({ c, read, claudeAvailable: false }).map((r) => [r.purpose, r]));
  assert.match(noClaude.distill.problem, /not found/);
}

// ------------------------------------------------------------- prices ----

{
  const none = {};
  assert.deepStrictEqual(llm.priceOf('claude-opus-5', none), [5, 25]);
  assert.deepStrictEqual(llm.priceOf('anthropic/claude-opus-5', none), [5, 25]);
  assert.deepStrictEqual(llm.priceOf('cli/claude-sonnet-5-5', none), [2, 10]);
  // Another provider's model is unknown, never priced from the Claude table.
  assert.strictEqual(llm.priceOf('azure/gpt-5.4', none), null);
  assert.strictEqual(llm.priceOf('openrouter/anthropic/claude-sonnet-4.5', none), null);
  assert.strictEqual(llm.priceOf('deepseek/deepseek-chat', none), null);
  assert.strictEqual(llm.priceOf('azur/typo', none), null);
  // An operator-set price is used as given.
  const set = models.parsePrices('azure/gpt-5.4=1.25:10, bad entry, deepseek/deepseek-chat=0.28:0.42');
  assert.deepStrictEqual(llm.priceOf('azure/gpt-5.4', set), [1.25, 10]);
  assert.deepStrictEqual(Object.keys(set).sort(), ['azure/gpt-5.4', 'deepseek/deepseek-chat']);

  // Usage: unknown price → null cost, tokens still counted.
  const u = llm.compatUsage('azure/gpt-5.4', { prompt_tokens: 100, completion_tokens: 20 });
  assert.deepStrictEqual(u, { costUsd: null, inputTokens: 100, outputTokens: 20 });
  // OpenRouter's reported cost is taken as reported.
  assert.strictEqual(llm.compatUsage('openrouter/x/y', { prompt_tokens: 1, completion_tokens: 1, cost: 0.0042 }).costUsd, 0.0042);
  assert.deepStrictEqual(llm.compatUsage('azure/x', null), { costUsd: null, inputTokens: null, outputTokens: null });
}

// ------------------------------------------------- request building ----

{
  const providers = {
    azure: { endpoint: 'https://r.openai.azure.com/', apiVersion: 'v1' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1/' },
    deepseek: { baseUrl: 'https://api.deepseek.com' },
    openai: { baseUrl: 'https://api.openai.com/v1' },
    local: { baseUrl: 'http://127.0.0.1:11434/v1' },
  };
  const az = llm.compatRequest({ provider: 'azure', model: 'gpt-5.4', system: 'S', prompt: 'P', effort: 'low', maxTokens: 50, key: 'K', providers });
  assert.strictEqual(az.url, 'https://r.openai.azure.com/openai/v1/chat/completions');
  assert.strictEqual(az.headers['api-key'], 'K');
  assert.ok(!az.url.includes('K'));
  assert.strictEqual(az.body.model, 'gpt-5.4');
  assert.strictEqual(az.body.max_completion_tokens, 50);
  assert.strictEqual(az.body.reasoning_effort, 'low');
  assert.deepStrictEqual(az.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }]);

  const dated = llm.compatRequest({ provider: 'azure', model: 'my dep', prompt: 'P', maxTokens: 5, key: 'K', providers: { azure: { endpoint: 'https://r.openai.azure.com', apiVersion: '2024-10-21' } } });
  assert.strictEqual(dated.url, 'https://r.openai.azure.com/openai/deployments/my%20dep/chat/completions?api-version=2024-10-21');
  assert.ok(!('model' in dated.body));

  const or = llm.compatRequest({ provider: 'openrouter', model: 'deepseek/deepseek-v4', prompt: 'P', effort: 'low', maxTokens: 5, key: 'K', providers });
  assert.strictEqual(or.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.strictEqual(or.headers.authorization, 'Bearer K');
  assert.strictEqual(or.body.max_tokens, 5);
  assert.ok(!('reasoning_effort' in or.body));
  assert.deepStrictEqual(or.body.usage, { include: true });

  const ds = llm.compatRequest({ provider: 'deepseek', model: 'deepseek-chat', prompt: 'P', maxTokens: 5, key: 'K', providers });
  assert.strictEqual(ds.url, 'https://api.deepseek.com/chat/completions');
  const lo = llm.compatRequest({ provider: 'local', model: 'qwen3', prompt: 'P', maxTokens: 5, key: null, providers });
  assert.ok(!('authorization' in lo.headers));
  assert.throws(() => llm.compatRequest({ provider: 'azure', model: 'm', prompt: 'P', maxTokens: 5, providers: { azure: { endpoint: null } } }), /no endpoint/);

  assert.strictEqual(llm.compatResult('azure/m', { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }).text, 'hi');
  assert.throws(() => llm.compatResult('azure/m', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }), /declined/);
  assert.throws(() => llm.compatResult('azure/m', { error: { message: 'x' } }), /no choices/);
}

// ---------------------------------- complete() end to end, fetch stubbed ----

(async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    };
  };
  config.providers.azure.endpoint = 'https://r.openai.azure.com';
  config.providers.azure.apiVersion = 'v1';
  config.embeddings.apiKey = 'test-key';

  const text = await llm.complete({ system: 'S', prompt: 'P', model: 'azure/gpt-5.4', purpose: 'reconcile' });
  assert.strictEqual(text, '{"ok":true}');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(JSON.parse(calls[0].init.body).model, 'gpt-5.4');
  const row = recorded.pop();
  assert.strictEqual(row.purpose, 'reconcile');
  assert.strictEqual(row.model, 'azure/gpt-5.4');
  assert.strictEqual(row.backend, 'azure');
  assert.strictEqual(row.costUsd, null, 'unknown price stays null');
  assert.strictEqual(row.inputTokens, 12);
  assert.strictEqual(row.ok, true);

  // A connector call on a non-Claude-Code model is refused before any call.
  const before = calls.length;
  await assert.rejects(llm.complete({ prompt: 'P', tools: ['mcp__x__y'], model: 'azure/gpt-5.4' }), /cannot make connector tool calls/);
  const saved = config.m365.connectorModel;
  config.m365.connectorModel = 'openrouter/anthropic/claude-opus-5';
  await assert.rejects(llm.toolCalls({ prompt: 'P', tools: ['mcp__x__y'] }), /PA_CONNECTOR_MODEL=openrouter\/anthropic\/claude-opus-5 cannot make connector tool calls/);
  config.m365.connectorModel = saved;
  assert.strictEqual(calls.length, before);

  // A provider error is an error, its message kept, the key not in it.
  global.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'rate limited' } }) });
  await assert.rejects(llm.complete({ prompt: 'P', model: 'azure/gpt-5.4', purpose: 'reconcile' }), (err) => /azure 429: rate limited/.test(err.message) && !err.message.includes('test-key'));
  assert.strictEqual(recorded.pop().ok, false);

  // No key: a clear refusal naming the variable.
  // (Skipped on a machine that has one configured.)
  if (!require('../src/config.ts').secret('DEEPSEEK_API_KEY')) {
    await assert.rejects(llm.complete({ prompt: 'P', model: 'deepseek/deepseek-chat' }), /DEEPSEEK_API_KEY/);
  }

  // cli args take the bare id from a prefixed string.
  const args = llm.cliArgs({ system: null, effort: 'low', tools: null, model: 'cli/claude-opus-5' });
  assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-opus-5');

  console.log('models: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

