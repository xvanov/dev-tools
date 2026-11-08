'use strict';

// One way to ask a model for text, with three kinds of backend behind it,
// chosen per call by the model string (src/models.js: `provider/model`, or a
// bare Claude name that keeps the original meaning — api with a key, else cli).
//
//  - **api** — the Anthropic SDK (`anthropic/…`, or bare with `ANTHROPIC_API_KEY`).
//  - **OpenAI-compatible** chat completions — `azure/…`, `openai/…`,
//    `openrouter/…`, `deepseek/…`, `local/…`. Text and JSON only.
//  - **cli** — a headless `claude -p` (`cli/…`, or bare without a key). It runs on the operator's own
//    Claude Code login, so the tool needs no key of its own, and it is the same
//    process that can reach the claude.ai connectors (Atlassian, Microsoft 365)
//    without an app registration in anyone's tenant.
//
// The CLI is isolated on purpose. It runs from an empty directory of its own
// (CLI_CWD) so no repo `CLAUDE.md` is discovered — and not from the temp root,
// which Claude Code lists in full at startup (`rg --files`): with tens of
// thousands of files there, every call cost seconds of CPU and disk,
// several times a minute, and made the whole machine lag. It also runs with `--setting-sources project` so the user's own
// hooks and plugins (an output-style hook, a status line) cannot rewrite an
// extraction prompt, and with `--no-session-persistence` so a thousand
// distillation calls do not land in the session history. Tools are off unless
// the caller names the ones it needs.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Config = import('./types.ts').Config;
/** A provider's reply, a model route (models.route) or a stream event, read key by key. */
type Json = import('./types.ts').Json;
/** What one call cost: llm_spend's numbers (src/budget.ts). */
type Usage = { costUsd: number | null; inputTokens: number | null; outputTokens: number | null };
type Acc = { usage: Usage | null };
type CliResult = { code: number | null; out: string; err: string };
type StreamArgs = {
  route: Json; system?: string | null; prompt?: unknown; effort?: string; reasoningEffort?: string | null; maxTokens?: number;
  timeoutMs: number; model?: string; signal?: AbortSignal | null; acc: Acc; format?: unknown; keepAlive?: unknown;
};
type Chunks = AsyncIterable<Uint8Array>;

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config.ts');
const models = require('./models.ts');

const CLI_CWD = path.join(config.dataDir, 'llm-cwd');

function cliCwd() {
  fs.mkdirSync(CLI_CWD, { recursive: true });
  return CLI_CWD;
}

function backend() {
  return config.anthropic.apiKey ? 'api' : 'cli';
}

let sdkClient: Json | null = null;
function sdk(): Json {
  if (!sdkClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    sdkClient = new Ctor({ apiKey: models.providerKey('anthropic') });
  }
  return sdkClient as Json;
}

async function viaApi({ system, prompt, effort, maxTokens, model }: { system?: unknown; prompt?: unknown; effort?: unknown; maxTokens?: unknown; model?: string | null }) {
  if (!models.providerKey('anthropic')) throw new Error(`anthropic/${model}: no key — set ANTHROPIC_API_KEY`);
  const response = await sdk().messages.create({
    model: model || config.anthropic.model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const usage = apiUsage(model || config.anthropic.model, response.usage);
  if (response.stop_reason === 'refusal') {
    throw withUsage(new Error(`model declined: ${response.stop_details?.category || 'unknown'}`), usage);
  }
  const text = response.content
    .filter((b: Json) => b.type === 'text')
    .map((b: Json) => b.text)
    .join('\n');
  return { text, usage };
}

// `cli/claude-opus-5` → `claude-opus-5`: claude takes the bare id.
function bareModel(value: string) {
  try {
    return models.parseModel(value).model;
  } catch {
    return value;
  }
}

// `model` overrides the default for one call: cheap judgements (is this a
// duplicate?) do not need the model that extracts commitments.
function cliArgs({ system, effort, tools, model = null }: { system?: string | null | undefined; effort?: string | undefined; tools?: string[] | null | undefined; model?: string | null | undefined }) {
  const args: string[] = [
    '-p',
    '--output-format', 'json',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--effort', effort as string,
    '--model', bareModel(model || config.anthropic.model),
  ];
  if (system) args.push('--system-prompt', system);
  if (tools && tools.length) args.push('--allowedTools', tools.join(','));
  // No tools, no MCP servers either: a user-scope server (this tool's own
  // recall server among them) would otherwise be spawned, and connected to
  // Postgres, for every one of the worker's thousands of model calls.
  else args.push('--tools', '', '--strict-mcp-config');
  return args;
}

// pa's own login (PA_CLAUDE_CONFIG_DIR), set for the child alone: the worker
// itself keeps the default, so what it reads from ~/.claude (your session
// transcripts) does not move with it.
function childEnv(extra: Record<string, string> | null = null, base: Record<string, string | undefined> = process.env) {
  const dir = config.claudeConfigDir;
  if (!dir && !extra) return base;
  return { ...base, ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}), ...(extra || {}) };
}

// Who pa's `claude -p` is signed in as, from the config folder it uses:
// { dir, email, org } — or { dir, email: null } when that folder has no login.
function cliAccount(dir: string | null = config.claudeConfigDir) {
  const os = require('os');
  const file = dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  let a: Json | null = null;
  try {
    a = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount || null;
  } catch {}
  return { dir: dir || path.join(os.homedir(), '.claude'), custom: Boolean(dir), email: a?.emailAddress || null, org: a?.organizationName || null };
}

// The prompt goes in on stdin: Windows caps a command line at 32k characters
// and a distillation prompt is routinely longer.
function runCli(args: string[], prompt: unknown, timeoutMs: number, env: Record<string, string> | null = null) {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: cliCwd(),
      windowsHide: true,
      env: childEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${config.claudeBin}: ${e.message}`));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(prompt);
  });
}

function parseCliOutput({ code, out, err }: CliResult) {
  let parsed: Json;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 300)}`);
  }
  if (parsed.is_error || parsed.subtype !== 'success') {
    throw new Error(`claude -p failed: ${String(parsed.result || parsed.subtype || 'unknown').slice(0, 300)}`);
  }
  return String(parsed.result || '');
}

// What `claude -p` reported spending, summed over this process. Backfills
// read it to say what a pass cost; the durable record, and the daily cap, are
// `llm_spend` (src/budget.js).
const spend = { calls: 0, usd: 0 };

function noteCost(usage: Usage | null | undefined) {
  spend.calls++;
  if (Number.isFinite(usage?.costUsd)) spend.usd += usage?.costUsd as number;
}

// Cost and tokens from `claude -p` output: the one JSON object of
// `--output-format json`, or the final `result` event of `stream-json`.
// Input tokens include cache reads and writes — they are what the call read.
// Best effort: anything unparseable is nulls, and fails elsewhere.
function cliUsage(out: unknown): Usage {
  const none: Usage = { costUsd: null, inputTokens: null, outputTokens: null };
  let final: Json | null = null;
  try {
    final = JSON.parse(out as string);
  } catch {
    const lines = String(out || '').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && !final; i--) {
      const line = lines[i] ?? '';
      if (!line.includes('"result"')) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.type === 'result') final = e;
      } catch {
        /* not this line */
      }
    }
  }
  if (!final || typeof final !== 'object') return none;
  const cost = Number(final.total_cost_usd);
  const u = final.usage || {};
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    costUsd: final.total_cost_usd != null && Number.isFinite(cost) ? cost : null,
    inputTokens: u.input_tokens != null ? n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) : null,
    outputTokens: u.output_tokens != null ? n(u.output_tokens) : null,
  };
}

// Dollars per million tokens, input / output, for the API backend, which
// reports tokens but not cost. Exact ids first, then the family at
// current-generation prices; an unknown model records a null cost rather than
// a guess. Cache writes are billed at 1.25x input, cache reads at 0.1x.
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};
const FAMILY: [RegExp, [number, number]][] = [
  [/fable|mythos/, [10, 50]],
  [/opus/, [4, 20]],
  [/sonnet/, [2, 10]],
  [/haiku/, [0.1, 0.5]],
];

// Takes a model string. A price set in PA_MODEL_PRICES wins; otherwise only a
// Claude model reached through Anthropic (bare, `anthropic/`, `cli/`) is
// priced from the table — `openrouter/anthropic/claude-…` is OpenRouter's
// price, not Anthropic's, and an unknown price is null, never a guess.
function priceOf(model: string, prices: Record<string, [number, number]> = models.parsePrices(config.modelPrices)): [number, number] | null {
  const raw = String(model || '').trim().toLowerCase();
  if (prices[raw]) return prices[raw];
  let m: Json;
  try {
    m = models.parseModel(raw);
  } catch {
    return null;
  }
  if (prices[m.model] && m.provider === 'auto') return prices[m.model] ?? null;
  if (!['auto', 'anthropic', 'cli'].includes(m.provider)) return null;
  const id = m.model;
  if (PRICES[id]) return PRICES[id] ?? null;
  const fam = FAMILY.find(([re]) => re.test(id));
  return fam ? fam[1] : null;
}

function apiUsage(model: string, u: Json | null | undefined): Usage {
  if (!u) return { costUsd: null, inputTokens: null, outputTokens: null };
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const plain = n(u.input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const read = n(u.cache_read_input_tokens);
  const output = n(u.output_tokens);
  const price = priceOf(model);
  const costUsd = price ? (plain * price[0] + write * price[0] * 1.25 + read * price[0] * 0.1 + output * price[1]) / 1e6 : null;
  return { costUsd, inputTokens: plain + write + read, outputTokens: output };
}

function withUsage(err: unknown, usage: unknown) {
  (err as Json).usage = usage;
  return err as Error;
}

// ------------------------------------------- OpenAI-compatible backend ----

// Pure: the request for one chat completion on an OpenAI-compatible provider.
// Returns { url, headers, body }. The key goes in a header, never the URL.
function compatRequest({ provider, model, system, prompt, effort, maxTokens, key, providers = config.providers, stream = false, reasoningEffort = null }: { provider?: string | undefined; model?: string | null | undefined; system?: unknown | undefined; prompt?: unknown | undefined; effort?: string | undefined; maxTokens?: unknown | undefined; key?: string | null | undefined; providers?: Config | undefined; stream?: boolean | undefined; reasoningEffort?: string | null | undefined }) {
  const messages: { role: string; content: unknown }[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body: Json = { model, messages };
  const reasoning = /^(gpt-5|o\d)/i.test(String(model));
  // OpenAI's reasoning models take max_completion_tokens; the rest of the
  // compatible world still reads max_tokens.
  if (provider === 'openai' || provider === 'azure') body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if ((provider === 'openai' || provider === 'azure') && reasoning && effort) {
    body.reasoning_effort = ['low', 'medium', 'high'].includes(effort as string) ? effort : 'high';
  }
  // Said outright by the caller (the voice fast lane): sent whatever the
  // deployment is called — an Azure deployment name does not say "gpt-5".
  if ((provider === 'openai' || provider === 'azure') && reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  // OpenRouter reports what the call cost when asked; nothing else does.
  if (provider === 'openrouter') body.usage = { include: true };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url: string;
  if (provider === 'azure') {
    const az = providers.azure;
    if (!az.endpoint) throw new Error('azure: no endpoint — set AZURE_OPENAI_ENDPOINT or PA_AZURE_CHAT_ENDPOINT');
    const base = String(az.endpoint).replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '');
    if (!az.apiVersion || az.apiVersion === 'v1') {
      url = `${base}/openai/v1/chat/completions`;
    } else {
      url = `${base}/openai/deployments/${encodeURIComponent(String(model))}/chat/completions?api-version=${encodeURIComponent(az.apiVersion)}`;
      delete body.model;
    }
    if (key) headers['api-key'] = key;
  } else {
    const base = String(providers[provider as string].baseUrl).replace(/\/+$/, '');
    url = `${base}/chat/completions`;
    if (key) headers.authorization = `Bearer ${key}`;
  }
  return { url, headers, body };
}

// Pure: text and usage from a chat-completions reply. `raw` is the full
// model string, for pricing.
function compatResult(raw: string, json: Json | null) {
  const usage = compatUsage(raw, json?.usage);
  const choice = json?.choices?.[0];
  if (!choice) throw withUsage(new Error(`no choices in reply: ${JSON.stringify(json?.error || json).slice(0, 200)}`), usage);
  if (choice.finish_reason === 'content_filter') throw withUsage(new Error('model declined: content_filter'), usage);
  const content = choice.message?.content;
  const text = Array.isArray(content) ? content.map((p: Json) => p?.text || '').join('') : String(content ?? '');
  return { text, usage };
}

function compatUsage(raw: string, u: Json | null | undefined): Usage {
  if (!u) return { costUsd: null, inputTokens: null, outputTokens: null };
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const input = n(u.prompt_tokens);
  const output = n(u.completion_tokens);
  let costUsd: number | null = null;
  if (u.cost != null && Number.isFinite(Number(u.cost))) costUsd = Number(u.cost); // OpenRouter, reported
  else {
    const price = priceOf(raw);
    if (price) costUsd = (input * price[0] + output * price[1]) / 1e6;
  }
  return { costUsd, inputTokens: u.prompt_tokens != null ? input : null, outputTokens: u.completion_tokens != null ? output : null };
}

async function viaCompat({ route: r, system, prompt, effort, maxTokens, timeoutMs }: { route: Json; system?: unknown; prompt?: unknown; effort?: string; maxTokens?: unknown; timeoutMs: number }) {
  const key = models.providerKey(r.provider);
  if (!key && r.provider !== 'local') {
    throw new Error(`${r.raw}: no key — set ${(models.KEY_NAMES[r.provider] || []).join(' or ')}`);
  }
  const req = compatRequest({ provider: r.provider, model: r.model, system, prompt, effort, maxTokens, key });
  let res: Response;
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`${r.provider}: ${(err as Error).name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err as Error).message}`);
  }
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const why = json?.error?.message || text;
    throw withUsage(new Error(`${r.provider} ${res.status}: ${String(why).slice(0, 300)}`), compatUsage(r.raw, json?.usage));
  }
  return compatResult(r.raw, json);
}

async function viaCli({ system, prompt, effort, tools, timeoutMs, model }: { system?: string | null; prompt?: unknown; effort?: string; tools?: string[] | null; timeoutMs: number; model?: string | null }) {
  const result = await runCli(cliArgs({ system, effort, tools, model }), prompt, timeoutMs);
  const usage = cliUsage(result.out);
  noteCost(usage);
  try {
    return { text: parseCliOutput(result), usage };
  } catch (err) {
    throw withUsage(err, usage);
  }
}

// One `llm_spend` row per call (src/budget.js), awaited so a short-lived `pa`
// process does not exit before it lands, but never for more than a moment and
// never with an error: spend is bookkeeping, and the caller's result matters
// more. Only the purpose, model, numbers and outcome are passed — no text.
async function recordCall(meta: Json, started: number, usage: Usage | null | undefined, ok: boolean) {
  const row = { ...meta, ...(usage || {}), durationMs: Date.now() - started, ok };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      require('./budget.ts').record(row),
      new Promise((r) => {
        timer = setTimeout(r, 2000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  } catch {
    // record() swallows its own errors; this is for a failed require.
  }
}

// `tools` forces the CLI backend: only Claude Code can reach the connectors.
// `purpose` names the pass for `llm_spend` and the daily cap (src/budget.js);
// a call with tools is a connector relay unless it says otherwise.
async function complete({
  system = null,
  prompt,
  effort = config.anthropic.effort,
  maxTokens = 8000,
  tools = null,
  timeoutMs = 300_000,
  model = null,
  purpose = null,
}: { system?: string | null; prompt?: unknown; effort?: string; maxTokens?: number; tools?: string[] | null; timeoutMs?: number; model?: string | null; purpose?: string | null }) {
  // A connector relay without a model of its own: the relay model.
  const raw = model || (tools ? config.m365.connectorModel : config.anthropic.model);
  // Refuses here, before any call, when the backend cannot do what is asked.
  const r = models.route(raw, { needs: tools ? 'toolCalls' : 'text', envName: tools ? 'PA_CONNECTOR_MODEL' : null });
  const meta = {
    purpose: purpose || (tools ? 'connector' : 'unknown'),
    model: raw,
    backend: r.backend,
  };
  const started = Date.now();
  try {
    const { text, usage } =
      r.backend === 'cli'
        ? await viaCli({ system, prompt, effort, tools, timeoutMs, model: r.model })
        : r.backend === 'api'
          ? await viaApi({ system, prompt, effort, maxTokens, model: r.model })
          : await viaCompat({ route: r, system, prompt, effort, maxTokens, timeoutMs });
    await recordCall(meta, started, usage, true);
    return text;
  } catch (err) {
    await recordCall(meta, started, (err as Json).usage, false);
    throw err;
  }
}

// ------------------------------------------------------------ streaming ----
//
// `stream()` is `complete()` token by token: an async generator of text
// pieces, for the voice fast lane, which speaks the first sentence while the
// rest is still being written. Text only, no tools. Spend is recorded once,
// when the generator ends (finished, failed, or abandoned by the caller —
// `for await … break` runs its `finally`). `signal` aborts the call.

// Pure: Server-Sent Events text -> the `data:` payloads that are complete,
// and the unfinished remainder to prepend to the next chunk.
function sseData(text: string) {
  const out: string[] = [];
  const s = String(text || '').replace(/\r\n?/g, '\n');
  let start = 0;
  let i: number;
  while ((i = s.indexOf('\n\n', start)) >= 0) {
    const block = s.slice(start, i);
    start = i + 2;
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) out.push(data);
  }
  return { data: out, rest: s.slice(start) };
}

// Pure: one chat-completions stream chunk -> { text, usage, error }.
function compatChunk(raw: string, json: Json | null | undefined) {
  if (json?.error) return { error: String(json.error.message || JSON.stringify(json.error)).slice(0, 300) };
  const choice = json?.choices?.[0];
  if (choice?.finish_reason === 'content_filter') return { error: 'model declined: content_filter' };
  const c = choice?.delta?.content;
  const text = Array.isArray(c) ? c.map((p: Json) => p?.text || '').join('') : c ? String(c) : '';
  return { text, usage: json?.usage ? compatUsage(raw, json.usage) : null };
}

function anySignal(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function* streamCompat({ route: r, system, prompt, effort, reasoningEffort, maxTokens, timeoutMs, signal, acc }: StreamArgs) {
  const key = models.providerKey(r.provider);
  if (!key && r.provider !== 'local') {
    throw new Error(`${r.raw}: no key — set ${(models.KEY_NAMES[r.provider] || []).join(' or ')}`);
  }
  const req = compatRequest({ provider: r.provider, model: r.model, system, prompt, effort, maxTokens, key, stream: true, reasoningEffort });
  let res: Response;
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: anySignal(signal, timeoutMs) });
  } catch (err) {
    throw new Error(`${r.provider}: ${(err as Error).name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let json: Json | null = null;
    try {
      json = JSON.parse(text);
    } catch {}
    throw new Error(`${r.provider} ${res.status}: ${String(json?.error?.message || text).slice(0, 300)}`);
  }
  const dec = new TextDecoder();
  let carry = '';
  for await (const chunk of res.body as unknown as Chunks) {
    carry += dec.decode(chunk, { stream: true });
    const { data, rest } = sseData(carry);
    carry = rest;
    for (const d of data) {
      if (d.trim() === '[DONE]') continue;
      let json: Json;
      try {
        json = JSON.parse(d);
      } catch {
        continue;
      }
      const c = compatChunk(r.raw, json);
      if (c.usage) acc.usage = c.usage;
      if (c.error) throw new Error(`${r.provider}: ${c.error}`);
      if (c.text) yield c.text;
    }
  }
}

// ------------------------------------------------ Ollama's own API ----
//
// A `local/` model is normally reached through the OpenAI-compatible
// endpoint (PA_LOCAL_LLM_URL, Ollama's /v1 by default). Two things that
// endpoint cannot carry go to Ollama's native /api/chat instead, when a
// caller asks for them: `format` (a JSON schema the model is forced to fill —
// the voice fast lane's decision) and `keepAlive` (how long the model stays
// loaded: through /v1 every call resets it to Ollama's default five minutes,
// and a cold 3B model takes seconds to load).

// Pure: the native base URL from PA_LOCAL_LLM_URL (".../v1" or bare).
function ollamaBase(baseUrl: unknown) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

// Pure: one native chat request. Temperature 0: a router should not be creative.
function ollamaRequest({ model, system, prompt, maxTokens, format = null, keepAlive = null, temperature = 0, key = null, providers = config.providers }: { model?: string | null; system?: unknown; prompt?: unknown; maxTokens?: unknown; format?: unknown; keepAlive?: unknown; temperature?: number; key?: string | null; providers?: Config }) {
  const messages: { role: string; content: unknown }[] = [];
  if (system) messages.push({ role: 'system', content: system });
  if (prompt != null) messages.push({ role: 'user', content: prompt });
  const body: Json = { model, messages, stream: true, options: { temperature } };
  if (maxTokens) body.options.num_predict = maxTokens;
  if (format) body.format = format;
  if (keepAlive != null) body.keep_alive = keepAlive;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return { url: `${ollamaBase(providers.local.baseUrl)}/api/chat`, headers, body };
}

// Pure: one NDJSON line of a native chat stream -> { text, done, usage, error }.
function ollamaLine(json: Json | null | undefined) {
  if (json?.error) return { error: String(json.error).slice(0, 300) };
  const text = json?.message?.content ? String(json.message.content) : '';
  const usage = json?.done ? { costUsd: 0, inputTokens: json.prompt_eval_count ?? null, outputTokens: json.eval_count ?? null } : null;
  return { text, done: !!json?.done, usage };
}

async function* streamOllama({ route: r, system, prompt, maxTokens, timeoutMs, signal, acc, format, keepAlive }: StreamArgs) {
  const req = ollamaRequest({ model: r.model, system, prompt, maxTokens, format, keepAlive, key: models.providerKey('local') });
  let res: Response;
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: anySignal(signal, timeoutMs) });
  } catch (err) {
    throw new Error(`local: ${(err as Error).name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err as Json).cause?.code || (err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let json: Json | null = null;
    try {
      json = JSON.parse(text);
    } catch {}
    throw new Error(`local ${res.status}: ${String(json?.error || text).slice(0, 300)}`);
  }
  const dec = new TextDecoder();
  let carry = '';
  for await (const chunk of res.body as unknown as Chunks) {
    carry += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, i).trim();
      carry = carry.slice(i + 1);
      if (!line) continue;
      let json: Json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const c = ollamaLine(json);
      if (c.error) throw new Error(`local: ${c.error}`);
      if (c.usage) acc.usage = c.usage;
      if (c.text) yield c.text;
    }
  }
}

/**
 * Loads a local model and keeps it loaded for `keepAlive` (Ollama: a chat
 * with no messages loads the model and answers at once). Resolves with the
 * time it took; rejects when Ollama is not there.
 */
async function warmLocal({ model, keepAlive = '30m', system = null, prompt = '', timeoutMs = 60_000 }: { model?: string | null; keepAlive?: string; system?: unknown; prompt?: string; timeoutMs?: number } = {}) {
  const r = models.route(model, { needs: 'text' });
  if (r.provider !== 'local') throw new Error(`${model} is not a local/ model`);
  // With a `system` prompt it also primes the KV cache: Ollama reuses the
  // longest token prefix shared with the previous request, so one request that
  // carries the fixed system prompt (and `prompt`, the next turn's user message
  // up to its words) and generates a single token lets the next real turn skip
  // evaluating that prefix (first turn 1.1 s, warm 0.25 s; docs/native/DESIGN.md).
  // Without one it is a bare load.
  const req = system
    ? ollamaRequest({ model: r.model, system, prompt, maxTokens: 1, keepAlive, key: models.providerKey('local') })
    : ollamaRequest({ model: r.model, prompt: null, keepAlive, key: models.providerKey('local') });
  req.body.stream = false;
  const t = Date.now();
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`local ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  await res.text();
  return Date.now() - t;
}

async function* streamApi({ system, prompt, maxTokens, model, signal, acc }: Omit<StreamArgs, 'route' | 'timeoutMs'> & { model: string }) {
  if (!models.providerKey('anthropic')) throw new Error(`anthropic/${model}: no key — set ANTHROPIC_API_KEY`);
  // No extended thinking: this path exists to be quick.
  const s = await sdk().messages.create(
    { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }], stream: true },
    signal ? { signal } : undefined
  );
  let u: Json = {};
  for await (const ev of s) {
    if (ev.type === 'message_start') u = { ...(ev.message?.usage || {}) };
    else if (ev.type === 'message_delta' && ev.usage) u = { ...u, ...ev.usage };
    acc.usage = apiUsage(model, u);
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) yield ev.delta.text;
  }
}

// Pure: one `claude -p --output-format stream-json --include-partial-messages`
// line -> { text } for a text delta, { final } for the closing result event,
// { whole } for a complete assistant message (a CLI without partials).
function cliStreamLine(line: string): { text?: string; final?: Json; line?: string; whole?: string } | null {
  let e: Json;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') return { text: e.event.delta.text || '' };
  if (e.type === 'result') return { final: e, line };
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    return { whole: e.message.content.filter((b: Json) => b.type === 'text').map((b: Json) => b.text).join('') };
  }
  return null;
}

async function* streamCli({ system, prompt, effort, timeoutMs, model, signal, acc }: Omit<StreamArgs, 'route'>) {
  const args = cliArgs({ system, effort, tools: null, model });
  args[args.indexOf('json')] = 'stream-json';
  args.push('--verbose', '--include-partial-messages');
  const child = spawn(config.claudeBin, args, { cwd: cliCwd(), windowsHide: true, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let failure: Error | null = null;
  const push = (x: string) => {
    queue.push(x);
    if (wake) wake();
  };
  let carry = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => {
    carry += d;
    let i: number;
    while ((i = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, i).trim();
      carry = carry.slice(i + 1);
      if (line) push(line);
    }
  });
  child.stderr.on('data', (d: Buffer) => (err += d));
  child.on('error', (e: Error) => {
    failure = new Error(`could not start ${config.claudeBin}: ${e.message}`);
    ended = true;
    if (wake) wake();
  });
  child.on('close', (code: number | null) => {
    if (carry.trim()) queue.push(carry.trim());
    if (code && !failure) failure = new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`);
    ended = true;
    if (wake) wake();
  });
  const stop = () => child.kill();
  const timer = setTimeout(() => {
    failure = new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`);
    stop();
  }, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  child.stdin.end(prompt);
  let streamed = false;
  let result: Json | null = null;
  try {
    for (;;) {
      if (!queue.length) {
        if (ended) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
        continue;
      }
      const p = cliStreamLine(queue.shift() ?? '');
      if (!p) continue;
      if (p.text) {
        streamed = true;
        yield p.text;
      } else if (p.whole && !streamed) {
        streamed = true;
        yield p.whole;
      } else if (p.final) {
        result = p.final;
        acc.usage = cliUsage(p.line);
        noteCost(acc.usage);
        // The answer is complete; claude takes seconds more to exit.
        break;
      }
    }
    if (result && (result.is_error || result.subtype !== 'success')) {
      throw new Error(`claude -p failed: ${String(result.result || result.subtype || 'unknown').slice(0, 300)}`);
    }
    if (!result && failure) throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (!ended) stop();
  }
}

async function* stream({
  system = null,
  prompt,
  effort = 'low',
  reasoningEffort = null,
  maxTokens = 800,
  timeoutMs = 30_000,
  model = null,
  purpose = null,
  signal = null,
  format = null,
  keepAlive = null,
}: { system?: string | null; prompt?: unknown; effort?: string; reasoningEffort?: string | null; maxTokens?: number; timeoutMs?: number; model?: string | null; purpose?: string | null; signal?: AbortSignal | null; format?: unknown; keepAlive?: unknown }) {
  const raw = model || config.anthropic.model;
  const r = models.route(raw, { needs: 'text' });
  const meta = { purpose: purpose || 'unknown', model: raw, backend: r.backend };
  const started = Date.now();
  const acc: Acc = { usage: null };
  let ok = false;
  try {
    const gen =
      r.backend === 'cli'
        ? streamCli({ system, prompt, effort, timeoutMs, model: r.model, signal, acc })
        : r.backend === 'api'
          ? streamApi({ system, prompt, maxTokens, model: r.model, signal, acc })
          : r.provider === 'local' && (format || keepAlive != null)
            ? streamOllama({ route: r, system, prompt, maxTokens, timeoutMs, signal, acc, format, keepAlive })
            : streamCompat({ route: r, system, prompt, effort, reasoningEffort, maxTokens, timeoutMs, signal, acc });
    yield* gen;
    ok = true;
  } finally {
    await recordCall(meta, started, acc.usage, ok);
  }
}

// Runs a headless session whose only job is to call connector tools, and
// returns what the tools returned — not what the model says they returned.
//
// The reply is read as `stream-json`, so every tool_use and its tool_result
// come back verbatim: the model chooses the calls, it never copies the data.
// That is the difference from the Jira relay, and the reason bodies arrive
// intact. Each result block is JSON-parsed when it can be; Microsoft 365
// results are one JSON object per block.
//
// A result larger than MAX_MCP_OUTPUT_TOKENS is not shown to the model at all:
// Claude Code writes it to a file and hands the model the path. For a relay
// that is the better channel — the data arrives verbatim from disk and the
// session's context stays small — so `visibleTokens` sets that threshold per
// call: high where the model must read a result to act on it (a search's
// `nextOffset`), low where it only has to make the call (read_resource).
//
// Returns [{ name, input, results: [...], error: string|null }] in call order.
const RELAY_SYSTEM =
  'You relay calls to connector tools for a program that reads the tool results directly. ' +
  'Call exactly the tools the user message asks for, with the arguments it gives, and page as it says. ' +
  'If a tool is not loaded yet, load it with ToolSearch first. Do not summarise or restate results. ' +
  'When the calls are done, reply with the single word: done';

async function toolCalls({ prompt, tools, effort = 'low', timeoutMs = 300_000, visibleTokens = null, purpose = 'connector' }: { prompt?: unknown; tools?: string[] | null; effort?: string; timeoutMs?: number; visibleTokens?: number | null; purpose?: string }) {
  const model = config.m365.connectorModel;
  // Only Claude Code holds the connector logins: refuse anything else loudly.
  const r = models.route(model, { needs: 'toolCalls', envName: 'PA_CONNECTOR_MODEL' });
  // A short system prompt instead of Claude Code's default: the relay only has
  // to call the tools it is named, and the default prompt (coding guidance,
  // every built-in tool's schema) was most of each call's ~100k input tokens.
  // (Narrowing built-ins with `--tools ToolSearch` was tried: the session hung.)
  const args = cliArgs({ system: RELAY_SYSTEM, effort, tools, model: r.model });
  const fmt = args.indexOf('json');
  args[fmt] = 'stream-json';
  args.push('--verbose');
  const env = visibleTokens ? { MAX_MCP_OUTPUT_TOKENS: String(visibleTokens) } : null;
  const meta = { purpose: purpose || 'connector', model, backend: 'cli' };
  const started = Date.now();
  let usage: Usage | null = null;
  try {
    const { code, out, err } = await runCli(args, prompt, timeoutMs, env);
    usage = cliUsage(out);
    noteCost(usage);
    const calls = parseToolStream(out, { code, err });
    await recordCall(meta, started, usage, true);
    return calls;
  } catch (err) {
    await recordCall(meta, started, usage, false);
    throw err;
  }
}

// "...exceeds maximum allowed tokens. Output has been saved to C:\...\x.txt"
// → the blocks that file holds: a JSON array of {type, text}.
function spilledBlocks(text: string) {
  // Two spellings across Claude Code versions: "Output has been saved to X"
  // and "<persisted-output> … Full output saved to: X". Missing the newer one
  // silently dropped every large page (a 25-event calendar page is ~70KB).
  const m = String(text).match(/(?:Output has been saved to|Full output saved to:)\s*(.+?\.(?:txt|json))/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(require('fs').readFileSync(m[1]!.trim(), 'utf8'));
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    return blocks.map((b: unknown) => (b && typeof b === 'object' && 'text' in b ? b.text : JSON.stringify(b)));
  } catch {
    return null;
  }
}

function parseToolStream(out: unknown, { code = 0, err = '' }: { code?: number | null; err?: string } = {}) {
  const calls = new Map<unknown, { name: string; input: Json; results: unknown[]; error: string | null }>();
  let final: Json | null = null;
  for (const line of String(out).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Json;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event.message?.content;
    if (event.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && /^mcp__/.test(block.name)) {
          calls.set(block.id, { name: block.name, input: block.input || {}, results: [], error: null });
        }
      }
    } else if (event.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        const call = block.type === 'tool_result' && calls.get(block.tool_use_id);
        if (!call) continue;
        let parts: string[] = Array.isArray(block.content)
          ? block.content.filter((p: Json) => p.type === 'text').map((p: Json) => p.text)
          : [String(block.content ?? '')];
        const spilled = parts.length === 1 ? spilledBlocks(parts[0] ?? '') : null;
        if (spilled) parts = spilled as string[];
        if (block.is_error) {
          call.error = parts.join('\n').slice(0, 500);
          continue;
        }
        for (const text of parts) {
          try {
            call.results.push(JSON.parse(text));
          } catch {
            call.results.push(text);
          }
        }
      }
    } else if (event.type === 'result') {
      final = event;
    }
  }
  if (!final && !calls.size) {
    throw new Error(`claude -p exited ${code}: ${(err || String(out)).trim().slice(0, 300)}`);
  }
  return [...calls.values()];
}

// Pulls the first JSON object or array out of a model reply, tolerating a
// code fence or a sentence of preamble — the CLI does not enforce a schema.
function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] ?? '' : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in model reply');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error('unterminated JSON in model reply');
  return JSON.parse(body.slice(start, end + 1));
}

module.exports = {
  spend: () => ({ ...spend }),
  complete,
  stream,
  warmLocal,
  ollamaBase,
  ollamaRequest,
  ollamaLine,
  sseData,
  compatChunk,
  cliStreamLine,
  toolCalls,
  parseToolStream,
  spilledBlocks,
  backend,
  childEnv,
  cliAccount,
  extractJson,
  cliArgs,
  parseCliOutput,
  cliUsage,
  apiUsage,
  priceOf,
  compatRequest,
  compatResult,
  compatUsage,
};
